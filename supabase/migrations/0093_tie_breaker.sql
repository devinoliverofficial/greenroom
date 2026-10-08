-- Ties the finder can settle itself (first full run, 2026-10-08: 26 "your
-- call" cards, most of them one tour found under two names). Before asking
-- the owner, two finds that want the same nights are weighed:
--  1. A real name beats a description the reader made up ("Fall 2019 run
--     with…" gives way to "Let Light Overcome The Darkness Tour").
--  2. One lists its nights and the other only a span: the listed one stays.
--  3. Two real names for the same nights (one carrying a sponsor, a "(full
--     run)", a "Tour" suffix): the one with more listed nights stays, and
--     the other — when its nights are inside the first's — goes. The one
--     that stays keeps the other's nights and lineup.
-- What's left after that is a real tie, and the owner's call.

create or replace function public.tour_find_madeup(nm text)
returns boolean
language sql immutable as $$
  select coalesce(nm, '') ~* '^(spring|summer|fall|autumn|winter|early|late|mid|\d{4}|[a-z]+(\s*[–—-]\s*[a-z]+)?\s+\d{4})\y'
$$;
revoke all on function public.tour_find_madeup(text) from public, anon, authenticated;

create or replace function public.tour_find_untie(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; o public.tour_candidates; gone int := 0; shared int; n_c int; n_o int; loser uuid;
begin
  for c in select * from tour_candidates where artist_id = a_id and status = 'new' and name <> '' and first_day is not null order by first_day, id
  loop
    if not exists (select 1 from tour_candidates t where t.id = c.id and t.status = 'new') then continue; end if;
    for o in select * from tour_candidates t
              where t.artist_id = a_id and t.status = 'new' and t.name <> '' and t.id <> c.id and t.first_day is not null
                and t.first_day <= c.last_day + 1 and c.first_day <= t.last_day + 1
              order by t.first_day, t.id
    loop
      -- Do they want the same nights at all?
      select count(*) into shared from jsonb_array_elements(c.dates) x join jsonb_array_elements(o.dates) y on x ->> 'date' = y ->> 'date';
      if shared = 0 and not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.tour = ''
                                       and public.tour_cand_night(c, h.date) and public.tour_cand_night(o, h.date)) then continue; end if;
      n_c := jsonb_array_length(c.dates); n_o := jsonb_array_length(o.dates);
      loser := null;
      if public.tour_find_madeup(c.name) and not public.tour_find_madeup(o.name) then loser := c.id;
      elsif public.tour_find_madeup(o.name) and not public.tour_find_madeup(c.name) then loser := o.id;
      -- One lists its nights, the other only a span: the listed one stays.
      elsif n_c = 0 and n_o > 0 then loser := c.id;
      elsif n_o = 0 and n_c > 0 then loser := o.id;
      -- Same nights, two names: the fuller list stays when the other's nights sit inside it (or they list the same nights).
      elsif shared > 0 and shared >= least(n_c, n_o) * 0.6 then
        loser := case when n_c >= n_o then o.id else c.id end;
      end if;
      if loser is null then continue; end if;
      -- The one that stays keeps the other's listed nights too (a description with the dates, a name without).
      update tour_candidates w set
        dates = w.dates || coalesce((select jsonb_agg(d) from jsonb_array_elements(l.dates) d
                                      where not exists (select 1 from jsonb_array_elements(w.dates) e where e ->> 'date' = d ->> 'date')), '[]'::jsonb),
        lineup = case when w.lineup = '' then l.lineup else w.lineup end,
        first_day = least(w.first_day, l.first_day), last_day = greatest(w.last_day, l.last_day)
       from tour_candidates l
       where w.id = case when loser = c.id then o.id else c.id end and l.id = loser;
      update tour_candidates set status = 'no', decided_at = now() where id = loser;
      gone := gone + 1;
      if loser = c.id then exit; end if;
    end loop;
  end loop;
  return gone;
end $$;
revoke all on function public.tour_find_untie(uuid) from public, anon, authenticated;

-- Autofill weighs the ties first.
create or replace function public.tour_find_autofill(a_id uuid, trusted boolean default false)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; k int := 0; useful boolean; tie boolean; adds boolean;
begin
  perform public.tour_find_untie(a_id);
  for c in select * from tour_candidates where artist_id = a_id and status = 'new' and not auto and first_day is not null and last_day is not null order by first_day, id
  loop
    adds := exists (select 1 from jsonb_array_elements(c.dates) x
                     where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'date')::date <= current_date
                       and not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (x ->> 'date')::date));
    if c.name = '' then
      if not adds then continue; end if;
      update tour_candidates set status = 'added', decided_at = now(), auto = true where id = c.id;
      k := k + 1;
      continue;
    end if;
    useful := c.fill
      or exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date))
      or ((trusted or jsonb_array_length(c.dates) >= 2) and adds);
    if not useful then continue; end if;
    tie := exists (select 1 from tour_candidates o
                    where o.artist_id = a_id and o.status = 'new' and o.id <> c.id and o.name <> ''
                      and o.first_day is not null and o.last_day is not null
                      and o.first_day <= c.last_day + 1 and c.first_day <= o.last_day + 1
                      and (exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.tour = ''
                                     and public.tour_cand_night(c, h.date) and public.tour_cand_night(o, h.date))
                           or exists (select 1 from jsonb_array_elements(c.dates) x join jsonb_array_elements(o.dates) y on x ->> 'date' = y ->> 'date')));
    if tie then continue; end if;
    update tour_candidates set status = 'added', decided_at = now(), auto = true where id = c.id;
    k := k + 1;
  end loop;
  if k > 0 then
    perform public.tour_find_apply(a_id);
    perform public.setlist_summarize(a_id);
  end if;
  return k;
end $$;
revoke all on function public.tour_find_autofill(uuid, boolean) from public, anon, authenticated;

notify pgrst, 'reload schema';
