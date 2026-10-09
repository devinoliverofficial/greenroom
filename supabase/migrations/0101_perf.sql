-- Speed (Devin, 2026-10-08: "a HUGE lag when opening the app"). The server
-- calls behind an artist page had grown heavy as the finder grew:
--  1. tour_find_state scanned every night against every find (59 × 1,142) on
--     each open and each poll — the page no longer asks about finds one by
--     one, so those figures are only computed for a find still waiting.
--  2. The summary recomputed each night's tour key and alias one row at a
--     time (1.5 s); now once per distinct tour name (≈70), then joined.
--  3. A tour's nights and the fact check are read the same way.

-- The tours on a page, keyed once: the key of each distinct name, its alias
-- after folds, and whether the owner removed it.
create or replace function public.artist_tour_groups(a_id uuid)
returns table (tour text, gk text, hidden boolean, shown text)
language sql stable security definer set search_path = public as $$
  with names as (select distinct h.tour from artist_history_shows h where h.artist_id = a_id and h.tour <> ''),
       keyed as (select n.tour, public.setlist_tour_key(n.tour) as k from names n),
       aliased as (select k.tour, coalesce(nullif(e.alias_key, ''), k.k) as gk from keyed k
                     left join artist_tour_edits e on e.artist_id = a_id and e.key = k.k)
  select a.tour, a.gk,
         coalesce((select e2.hidden from artist_tour_edits e2 where e2.artist_id = a_id and e2.key = a.gk), false) as hidden,
         nullif((select e3.new_name from artist_tour_edits e3 where e3.artist_id = a_id and e3.key = a.gk and not e3.hidden), '') as shown
    from aliased a
$$;
revoke all on function public.artist_tour_groups(uuid) from public, anon, authenticated;

create or replace function public.setlist_summarize(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s jsonb;
begin
  create temp table if not exists tg (tour text, gk text, hidden boolean, shown text) on commit drop;
  truncate tg;
  insert into tg select * from public.artist_tour_groups(a_id);
  select jsonb_build_object(
    'shows', count(*),
    'countries', count(distinct country_code) filter (where country_code <> ''),
    'cities', count(distinct (country_code, lower(state), lower(city))) filter (where city <> ''),
    'firstYear', min(extract(year from date))::int,
    'lastYear', max(extract(year from date))::int,
    'tours', (select count(distinct g.gk) from artist_history_shows h2 join tg g on g.tour = h2.tour
               where h2.artist_id = a_id and not g.hidden),
    'years', coalesce((select jsonb_object_agg(y, n) from (
       select extract(year from h3.date)::int as y, count(*) as n
         from artist_history_shows h3
        where h3.artist_id = a_id and h3.date is not null
        group by 1) yy), '{}'::jsonb),
    'toursList', coalesce((select jsonb_agg(jsonb_build_object(
         'name', coalesce(t.shown, t.name),
         'n', t.n + (select count(*) from artist_tour_conflicts cf
                      join artist_history_shows hh on hh.artist_id = a_id and hh.date = cf.date
                      left join tg g2 on g2.tour = hh.tour
                     where cf.artist_id = a_id and t.gk in (cf.key_a, cf.key_b) and coalesce(g2.gk, '') <> t.gk),
         'first', t.first, 'last', t.last,
         'conflict', exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and t.gk in (cf.key_a, cf.key_b)))
         order by t.last desc nulls last)
       from (
         select g.gk, max(g.shown) as shown, mode() within group (order by h4.tour) as name, count(*) as n,
                min(h4.date) as first, max(h4.date) as last
           from artist_history_shows h4 join tg g on g.tour = h4.tour
          where h4.artist_id = a_id and not g.hidden
          group by g.gk) t), '[]'::jsonb),
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

create or replace function public.artist_tour_nights(a_id uuid, tour_name text)
returns jsonb
language sql stable security definer set search_path = public as $$
  with want as (select public.artist_tour_key_of(a_id, tour_name) as gk),
       tg as (select * from public.artist_tour_groups(a_id))
  select case when auth.uid() is null then null
              when exists (select 1 from artist_tour_edits e, want where e.artist_id = a_id and e.hidden and e.key = want.gk) then '[]'::jsonb
         else coalesce((
    select jsonb_agg(x order by x ->> 'date') from (
      select jsonb_build_object('date', h.date, 'city', h.city, 'state', h.state, 'country', h.country_code,
                                'venue', h.venue, 'url', h.url, 'announced', h.pinned,
                                'contested', exists (select 1 from artist_tour_conflicts cf, want where cf.artist_id = a_id and cf.date = h.date
                                                      and want.gk in (cf.key_a, cf.key_b))) as x
        from artist_history_shows h join tg g on g.tour = h.tour, want
       where h.artist_id = a_id
         and (g.gk = want.gk
              or exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and cf.date = h.date
                          and want.gk in (cf.key_a, cf.key_b) and g.gk in (cf.key_a, cf.key_b)))) q), '[]'::jsonb) end
$$;
revoke all on function public.artist_tour_nights(uuid, text) from public, anon;
grant execute on function public.artist_tour_nights(uuid, text) to authenticated;

-- The page's view of the search: light. The per-find night counts are only
-- worked out for a find still waiting on the owner (there are none in trust
-- mode; the runs' "could be" guesses need only the span).
create or replace function public.tour_find_state(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare f record;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  perform public.tour_find_absorb(a_id);
  perform public.tour_find_fire(a_id);
  perform public.tour_find_brain(a_id);
  select * into f from tour_finds where artist_id = a_id;
  if f.status = 'extracting' and f.extracting_at < now() - interval '5 minutes' then
    update tour_finds set status = 'ready', extracting_at = null where artist_id = a_id;
    f.status := 'ready';
  end if;
  return jsonb_build_object(
    'status', coalesce(f.status, 'idle'),
    'detail', coalesce(f.detail, ''),
    'day', f.day,
    'today', current_date,
    'startedAt', f.started_at,
    'finishedAt', f.finished_at,
    'auto', coalesce(f.auto, false),
    'brain', public.tour_find_key() is not null and coalesce(f.brain, '') <> 'bad_key',
    'eta', case when f.status in ('reading', 'thinking', 'ready', 'extracting') then public.tour_find_eta(a_id) else 0 end,
    'unread', coalesce(f.unread, 0),
    'pages', (select count(*) from tour_find_pages g where g.artist_id = a_id and g.fetched and g.body <> ''),
    'waiting', (select count(*) from tour_find_pages g where g.artist_id = a_id and not g.fetched),
    'batches', jsonb_build_object(
        'total', (select count(*) from tour_find_batches b where b.artist_id = a_id and b.status in ('todo', 'asked', 'done', 'failed')),
        'done', (select count(*) from tour_find_batches b where b.artist_id = a_id and b.status in ('done', 'failed'))),
    'sources', jsonb_build_object('theprp', case when f.prp_next is null then 'new' when f.prp_next = 0 then 'new' when f.prp_next > 0 then 'reading' else 'done' end,
                                  'lambgoat', coalesce(f.lg_state, 'new'), 'lambgoatHttp', f.lg_http,
                                  'sites', (select count(*) from tour_find_sources s where s.artist_id = a_id),
                                  'sitesDone', (select count(*) from tour_find_sources s where s.artist_id = a_id and s.next < 0),
                                  'sitesWithNews', (select count(distinct g.source) from tour_find_pages g where g.artist_id = a_id and g.fetched and g.body <> '')),
    'runs', coalesce(public.tour_find_runs(a_id), '[]'::jsonb),
    'candidates', coalesce((
      with named as (select h.named_by, count(*) as n from artist_history_shows h where h.artist_id = a_id and h.named_by is not null group by 1)
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'role', c.role, 'first', c.first_day, 'last', c.last_day, 'region', c.region,
        'lineup', c.lineup, 'n', jsonb_array_length(c.dates), 'status', c.status, 'fill', c.fill,
        'auto', c.auto, 'decidedAt', c.decided_at,
        'named', coalesce((select nm.n from named nm where nm.named_by = c.id), 0),
        'matched', case when c.status = 'new' then (select count(*) from artist_history_shows h where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date)) else 0 end,
        'have', case when c.status = 'new' then (select count(*) from artist_history_shows h where h.artist_id = a_id and public.tour_cand_night(c, h.date)) else 0 end,
        'toAdd', case when c.status = 'new' then (select count(*) from jsonb_array_elements(c.dates) x
                   where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'date')::date <= current_date
                     and not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (x ->> 'date')::date)) else 0 end)
        order by c.status = 'new' desc, c.decided_at desc nulls last, c.first_day desc nulls last)
      from tour_candidates c where c.artist_id = a_id and c.status <> 'no'), '[]'::jsonb));
end $$;
revoke all on function public.tour_find_state(uuid) from public, anon;
grant execute on function public.tour_find_state(uuid) to authenticated;

-- The fact check, grouped once.
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
  for r in
    select u.date, n.name
      from artist_history_shows u
      join lateral (select distinct b.key, b.name from tfn b where b.date between u.date - 6 and u.date - 1) n on true
     where u.artist_id = a_id and u.tour = ''
       and exists (select 1 from tfn a where a.key = n.key and a.date between u.date + 1 and u.date + 6)
       and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = u.date)
       and (select count(distinct b.key) from tfn b where b.date between u.date - 6 and u.date + 6) = 1
  loop
    update artist_history_shows set tour = r.name where artist_id = a_id and date = r.date and tour = '';
    filed := filed + 1;
  end loop;
  for r in
    select u.date, n.key, n.name
      from artist_history_shows u
      join lateral (select distinct b.key, b.name from tfn b where b.date between u.date - 3 and u.date + 3) n on true
     where u.artist_id = a_id and u.tour = ''
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
