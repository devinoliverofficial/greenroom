-- Tour conflicts (Devin, 2026-10-08: "add both tours by default and put a
-- disclaimer next to the tours that conflict (Tour Conflict) and when you
-- click it you can get more granular and edit the dates you were and weren't
-- on"). Two finds that want the same nights both go on the page; the nights
-- they both claim are written down as conflicts; the Tours list tags both
-- tours; the owner settles each contested night — this tour, that tour, or
-- wasn't there — and the tag goes when none are left.

create table if not exists public.artist_tour_conflicts (
  artist_id uuid not null references public.artists (id) on delete cascade,
  date date not null,
  key_a text not null,
  key_b text not null,
  name_a text not null default '',
  name_b text not null default '',
  created_at timestamptz not null default now(),
  primary key (artist_id, date, key_a, key_b)
);
alter table public.artist_tour_conflicts enable row level security;
revoke all on public.artist_tour_conflicts from public, anon, authenticated;


-- Weighing ties, narrower: two names are the same tour only when one name
-- sits inside the other ("10 Years In The Black" inside "Sumerian Records
-- Presents: 10 Years In The Black Tour"). Two different names over the same
-- nights are a conflict now, not a contest — both stay, tagged.
create or replace function public.tour_find_untie(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; o public.tour_candidates; gone int := 0; shared int; n_c int; n_o int; loser uuid; kc text; ko text;
begin
  for c in select * from tour_candidates where artist_id = a_id and status = 'new' and name <> '' and first_day is not null order by first_day, id
  loop
    if not exists (select 1 from tour_candidates t where t.id = c.id and t.status = 'new') then continue; end if;
    for o in select t.* from tour_candidates t
              where t.artist_id = a_id and t.status = 'new' and t.name <> '' and t.id <> c.id and t.first_day is not null
                and t.first_day <= c.last_day + 1 and c.first_day <= t.last_day + 1
              order by t.first_day, t.id
    loop
      select count(*) into shared from jsonb_array_elements(c.dates) x join jsonb_array_elements(o.dates) y on x ->> 'date' = y ->> 'date';
      if shared = 0 and not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.tour = ''
                                       and public.tour_cand_night(c, h.date) and public.tour_cand_night(o, h.date)) then continue; end if;
      n_c := jsonb_array_length(c.dates); n_o := jsonb_array_length(o.dates);
      kc := public.setlist_tour_key(c.name); ko := public.setlist_tour_key(o.name);
      loser := null;
      if public.tour_find_madeup(c.name) and not public.tour_find_madeup(o.name) then loser := c.id;
      elsif public.tour_find_madeup(o.name) and not public.tour_find_madeup(c.name) then loser := o.id;
      elsif n_c = 0 and n_o > 0 then loser := c.id;
      elsif n_o = 0 and n_c > 0 then loser := o.id;
      -- One name inside the other: the same tour dressed differently; the fuller list stays.
      elsif kc <> '' and ko <> '' and (position(kc in ko) > 0 or position(ko in kc) > 0) then
        loser := case when n_c >= n_o then o.id else c.id end;
      end if;
      if loser is null then continue; end if;
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

-- Autofill: a real tie adds both and writes the contested nights down.
create or replace function public.tour_find_autofill(a_id uuid, trusted boolean default false)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; k int := 0; adds boolean; names boolean; o public.tour_candidates; ka text; kb text;
begin
  perform public.tour_find_untie(a_id);
  for c in select * from tour_candidates where artist_id = a_id and status = 'new' and not auto and first_day is not null and last_day is not null
            order by jsonb_array_length(dates) desc, first_day, id
  loop
    if not exists (select 1 from tour_candidates t where t.id = c.id and t.status = 'new') then continue; end if;
    adds := exists (select 1 from jsonb_array_elements(c.dates) x
                     where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'date')::date <= current_date
                       and not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (x ->> 'date')::date));
    names := c.name <> '' and exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date));
    if not (adds or names or c.fill) then
      update tour_candidates set status = 'no', decided_at = now() where id = c.id;
      continue;
    end if;
    -- Another find wants some of the same nights: both go on, and those nights are a conflict to settle.
    if c.name <> '' then
      for o in select t.* from tour_candidates t
                where t.artist_id = a_id and t.status = 'new' and t.id <> c.id and t.name <> ''
                  and t.first_day is not null and t.last_day is not null
                  and t.first_day <= c.last_day + 1 and c.first_day <= t.last_day + 1
      loop
        ka := public.setlist_tour_key(c.name); kb := public.setlist_tour_key(o.name);
        if ka = kb then continue; end if;
        insert into artist_tour_conflicts (artist_id, date, key_a, key_b, name_a, name_b)
        select a_id, d, least(ka, kb), greatest(ka, kb), case when ka <= kb then c.name else o.name end, case when ka <= kb then o.name else c.name end
          from (
            select (x ->> 'date')::date as d from jsonb_array_elements(c.dates) x join jsonb_array_elements(o.dates) y on x ->> 'date' = y ->> 'date'
             where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
            union
            select h.date from artist_history_shows h where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date) and public.tour_cand_night(o, h.date)
          ) nights
          where d <= current_date
        on conflict do nothing;
        if found then
          update tour_candidates set status = 'added', decided_at = now(), auto = true where id = o.id;
          k := k + 1;
        end if;
      end loop;
    end if;
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

-- The summary: a tour's count includes the contested nights the other tour holds, and both wear the tag.
create or replace function public.setlist_summarize(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s jsonb;
begin
  select jsonb_build_object(
    'shows', count(*),
    'countries', count(distinct country_code) filter (where country_code <> ''),
    'cities', count(distinct (country_code, lower(state), lower(city))) filter (where city <> ''),
    'firstYear', min(extract(year from date))::int,
    'lastYear', max(extract(year from date))::int,
    'tours', (select count(*) from (
       select 1 from artist_history_shows h2
        where h2.artist_id = a_id and h2.tour <> ''
          and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.setlist_tour_key(h2.tour))
        group by public.setlist_tour_key(h2.tour)) x),
    'years', coalesce((select jsonb_object_agg(y, n) from (
       select extract(year from h3.date)::int as y, count(*) as n
         from artist_history_shows h3
        where h3.artist_id = a_id and h3.date is not null
        group by 1) yy), '{}'::jsonb),
    'toursList', coalesce((select jsonb_agg(jsonb_build_object(
         'name', coalesce(nullif((select e.new_name from artist_tour_edits e where e.artist_id = a_id and e.key = t.key and not e.hidden), ''), t.name),
         'n', t.n + (select count(*) from artist_tour_conflicts cf
                      join artist_history_shows hh on hh.artist_id = a_id and hh.date = cf.date
                     where cf.artist_id = a_id and t.key in (cf.key_a, cf.key_b) and public.setlist_tour_key(hh.tour) <> t.key),
         'first', t.first, 'last', t.last,
         'conflict', exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and t.key in (cf.key_a, cf.key_b)))
         order by t.last desc nulls last)
       from (
         select public.setlist_tour_key(h4.tour) as key, mode() within group (order by h4.tour) as name, count(*) as n,
                min(h4.date) as first, max(h4.date) as last
           from artist_history_shows h4
          where h4.artist_id = a_id and h4.tour <> ''
            and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.setlist_tour_key(h4.tour))
          group by public.setlist_tour_key(h4.tour)
          order by max(h4.date) desc nulls last
          limit 60) t), '[]'::jsonb),
    'countriesList', coalesce((select jsonb_agg(jsonb_build_object('name', c.country, 'n', c.n) order by c.n desc)
       from (
         select h5.country, count(*) as n
           from artist_history_shows h5
          where h5.artist_id = a_id and h5.country <> ''
          group by h5.country
          order by count(*) desc
          limit 60) c), '[]'::jsonb))
    into s
    from artist_history_shows h
   where h.artist_id = a_id;
  update artist_history set summary = coalesce(s, '{}'::jsonb) where artist_id = a_id;
  return s;
end $$;
revoke all on function public.setlist_summarize(uuid) from public, anon, authenticated;

-- A tour's nights, with the contested ones (held by this tour or the other) marked.
create or replace function public.artist_tour_nights(a_id uuid, tour_name text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then null else coalesce((
    select jsonb_agg(x order by x ->> 'date') from (
      select jsonb_build_object('date', h.date, 'city', h.city, 'state', h.state, 'country', h.country_code,
                                'venue', h.venue, 'url', h.url, 'announced', h.pinned,
                                'contested', exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and cf.date = h.date
                                                      and public.artist_tour_key_of(a_id, tour_name) in (cf.key_a, cf.key_b))) as x
        from artist_history_shows h
       where h.artist_id = a_id and h.tour <> ''
         and (public.setlist_tour_key(h.tour) = public.artist_tour_key_of(a_id, tour_name)
              or exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and cf.date = h.date
                          and public.artist_tour_key_of(a_id, tour_name) in (cf.key_a, cf.key_b)
                          and public.setlist_tour_key(h.tour) in (cf.key_a, cf.key_b)))
         and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.artist_tour_key_of(a_id, tour_name))) q), '[]'::jsonb) end
$$;
revoke all on function public.artist_tour_nights(uuid, text) from public, anon;
grant execute on function public.artist_tour_nights(uuid, text) to authenticated;

-- The contested nights of a tour, for the owner to settle: each with both names and which one holds it now.
create or replace function public.artist_tour_conflicts(a_id uuid, tour_name text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not public.tour_find_may(a_id) then null else coalesce((
    select jsonb_agg(jsonb_build_object('date', cf.date, 'a', cf.name_a, 'b', cf.name_b,
             'holder', coalesce((select h.tour from artist_history_shows h where h.artist_id = a_id and h.date = cf.date and h.tour <> '' limit 1), ''),
             'city', coalesce((select h.city from artist_history_shows h where h.artist_id = a_id and h.date = cf.date limit 1), ''),
             'venue', coalesce((select h.venue from artist_history_shows h where h.artist_id = a_id and h.date = cf.date limit 1), ''))
           order by cf.date)
      from artist_tour_conflicts cf
     where cf.artist_id = a_id and public.artist_tour_key_of(a_id, tour_name) in (cf.key_a, cf.key_b)), '[]'::jsonb) end
$$;
revoke all on function public.artist_tour_conflicts(uuid, text) from public, anon;
grant execute on function public.artist_tour_conflicts(uuid, text) to authenticated;

-- Settling one night: this tour, that tour, or '' for "wasn't there" (a night the
-- search made up goes; a night setlist.fm knows stays as a show with no tour).
create or replace function public.artist_tour_pick(a_id uuid, night date, tour_name text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare nm text; k text;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  nm := left(btrim(regexp_replace(coalesce(tour_name, ''), '\s+', ' ', 'g')), 120);
  if nm = '' then
    delete from artist_history_shows h where h.artist_id = a_id and h.date = night and h.pinned;
    update artist_history_shows set tour = '', named_by = null where artist_id = a_id and date = night;
  else
    k := public.artist_tour_key_of(a_id, nm);
    -- The name as the page spells it for that key (the finder's or setlist.fm's), so the nights group together.
    select coalesce((select h.tour from artist_history_shows h where h.artist_id = a_id and public.setlist_tour_key(h.tour) = k and h.tour <> '' limit 1), nm) into nm;
    update artist_history_shows set tour = nm where artist_id = a_id and date = night;
  end if;
  delete from artist_tour_conflicts where artist_id = a_id and date = night;
  perform public.setlist_summarize(a_id);
  return jsonb_build_object('ok', true, 'left', (select count(*) from artist_tour_conflicts cf where cf.artist_id = a_id));
end $$;
revoke all on function public.artist_tour_pick(uuid, date, text) from public, anon;
grant execute on function public.artist_tour_pick(uuid, date, text) to authenticated;

-- Removing a tour settles its conflicts in the other tour's favour.
create or replace function public.artist_tour_remove(a_id uuid, tour_name text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare k text;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  k := public.artist_tour_key_of(a_id, tour_name);
  insert into artist_tour_edits (artist_id, key, hidden) values (a_id, k, true)
  on conflict (artist_id, key) do update set hidden = true;
  -- Contested nights it held go to the other tour.
  update artist_history_shows h set tour = case when cf.key_a = k then cf.name_b else cf.name_a end
    from artist_tour_conflicts cf
   where h.artist_id = a_id and cf.artist_id = a_id and cf.date = h.date and k in (cf.key_a, cf.key_b) and public.setlist_tour_key(h.tour) = k;
  delete from artist_tour_conflicts where artist_id = a_id and k in (key_a, key_b);
  delete from artist_history_shows h where h.artist_id = a_id and h.pinned and public.setlist_tour_key(h.tour) = k;
  update tour_candidates set status = 'no', decided_at = now() where artist_id = a_id and status in ('new', 'added') and public.setlist_tour_key(name) = k;
  return public.setlist_summarize(a_id);
end $$;
revoke all on function public.artist_tour_remove(uuid, text) from public, anon;
grant execute on function public.artist_tour_remove(uuid, text) to authenticated;

notify pgrst, 'reload schema';
