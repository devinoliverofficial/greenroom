-- Festival names, recognised properly (2026-10-09, after the grounds table landed):
-- "Skatefest 2010", "River City Rockfest" and "Rockapalooza" never read as festivals,
-- because only the whole word "fest" counted, so the cross-check asked the owner four
-- questions about the nights around a one-day festival. A name is a festival when it
-- ends in -fest, says festival, names one of the known festival tours, or is one of
-- the festivals in the grounds table; a festival's neighbours are never asked about.

create or replace function public.tour_is_festival(nm text)
returns boolean
language sql stable as $$
  select coalesce(nm, '') ~* '(\mfest\M|fest\M|festival|\mwarped\M|\mjam\M|rock am ring|rock im park|\msxsw\M|bamboozle|soundwave|slam dunk|louder than life|rockville|aftershock|inkcarceration|sonic temple|so what|\mdownload\M|hellfest|graspop|groezrock|riot fest|self help|skate and surf|summer slaughter|palooza|\mfestival\M)'
      or exists (select 1 from festival_grounds g
                  where length(g.name) >= 5 and lower(coalesce(nm, '')) like '%' || lower(g.name) || '%')
$$;
revoke all on function public.tour_is_festival(text) from public, anon, authenticated;

create or replace function public.tour_name_clean(nm text)
returns text
language sql stable as $$
  select case when public.tour_is_festival(nm)
              then btrim(regexp_replace(coalesce(nm, ''), '\s+[–—-]\s+[A-Z][A-Za-z.\s]+(,\s*[A-Za-z.]{2,})?\s*$', ''))
              else coalesce(nm, '') end
$$;
revoke all on function public.tour_name_clean(text) from public, anon, authenticated;

create or replace function public.tour_fact_check(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare filed int := 0; asked int := 0; r record;
begin
  create temp table if not exists tg (tour text, gk text, hidden boolean, shown text) on commit drop;
  truncate tg;
  insert into tg select * from public.artist_tour_groups(a_id);
  create temp table if not exists tfn (date date, key text, name text) on commit drop;
  truncate tfn;
  insert into tfn select h.date, g.gk, mode() within group (order by h.tour)
    from artist_history_shows h join tg g on g.tour = h.tour
   where h.artist_id = a_id and not g.hidden group by h.date, g.gk;
  -- setlist.fm's album-era labels (one name over many months) are not tours: for the rules below their nights read as blank.
  create temp table if not exists tera (gk text) on commit drop;
  truncate tera;
  insert into tera select key from (select key, max(date) - min(date) as span, count(*) as n from tfn group by key) x where span > 150 and n >= 3;
  delete from tfn where key in (select gk from tera);
  -- A festival of a night or three is not a run: it files no neighbours and asks no questions.
  create temp table if not exists tfest (gk text) on commit drop;
  truncate tfest;
  insert into tfest select key from (select key, max(name) as name, count(*) as n from tfn group by key) x where n <= 3 and public.tour_is_festival(x.name);
  delete from tfn where key in (select gk from tfest);
  -- An era label with three nights or fewer left is three one-off shows, not a tour.
  update artist_history_shows h set tour = '', named_by = null
   where h.artist_id = a_id and h.tour <> ''
     and exists (select 1 from tg g join tera e on e.gk = g.gk where g.tour = h.tour)
     and (select count(*) from artist_history_shows o join tg g2 on g2.tour = o.tour join tera e2 on e2.gk = g2.gk
           where o.artist_id = a_id and g2.gk = (select g3.gk from tg g3 where g3.tour = h.tour)) <= 3;
  -- Questions an earlier check asked about an era label or a small festival are withdrawn.
  delete from artist_tour_conflicts cf where cf.artist_id = a_id and cf.key_b = ''
     and (cf.key_a in (select gk from tera) or cf.key_a in (select gk from tfest)
          or cf.key_a in (select distinct f.key from tfn f where public.tour_is_festival(f.name)))
     and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = cf.date);
  for r in
    select u.date, n.name
      from artist_history_shows u
      join lateral (select distinct b.key, b.name from tfn b where b.date between u.date - 6 and u.date - 1) n on true
     where u.artist_id = a_id and (u.tour = '' or exists (select 1 from tg g join tera e on e.gk = g.gk where g.tour = u.tour))
       and exists (select 1 from tfn a where a.key = n.key and a.date between u.date + 1 and u.date + 6)
       and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = u.date)
       and (select count(distinct b.key) from tfn b where b.date between u.date - 6 and u.date + 6) = 1
  loop
    update artist_history_shows set tour = r.name where artist_id = a_id and date = r.date;
    filed := filed + 1;
  end loop;
  for r in
    select u.date, n.key, n.name
      from artist_history_shows u
      join lateral (select distinct b.key, b.name from tfn b where b.date between u.date - 3 and u.date + 3) n on true
     where u.artist_id = a_id and (u.tour = '' or exists (select 1 from tg g join tera e on e.gk = g.gk where g.tour = u.tour))
       and not public.tour_is_festival(n.name)  -- a festival's neighbours are their own nights
       and (select count(distinct b.key) from tfn b where b.date between u.date - 3 and u.date + 3) = 1
       and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = u.date)
       and not exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and cf.date = u.date)
  loop
    insert into artist_tour_conflicts (artist_id, date, key_a, key_b, name_a, name_b) values (a_id, r.date, r.key, '', r.name, '') on conflict do nothing;
    asked := asked + 1;
  end loop;
  for r in
    select n.date, n.key, n.name
      from tfn n
     where (select count(*) from tfn o where o.key = n.key) > 1
       and (select min(abs(o.date - n.date)) from tfn o where o.key = n.key and o.date <> n.date) > 30
       and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = n.date)
       and not exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and cf.date = n.date)
  loop
    insert into artist_tour_conflicts (artist_id, date, key_a, key_b, name_a, name_b) values (a_id, r.date, r.key, '', r.name, '') on conflict do nothing;
    asked := asked + 1;
  end loop;
  if filed > 0 or asked > 0 then perform public.setlist_summarize(a_id); end if;
  return jsonb_build_object('filed', filed, 'asked', asked);
end $$;
revoke all on function public.tour_fact_check(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
