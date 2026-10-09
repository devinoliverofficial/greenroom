-- A page's scorecard (PIPELINE.md §5): the numbers that say whether an artist's
-- road story is done, in one call, so any page can be checked the way I See
-- Stars was. Server-side only for now (the manage page can show it later).
create or replace function public.artist_history_scorecard(a_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  with n as (
    select h.date, h.venue, h.city, h.tour, h.festival, h.pinned, extract(year from h.date)::int as yr,
           case when h.url ~ '^https://(www\.)?setlist\.fm/' then 'setlist.fm'
                when h.url like 'https://web.archive.org/%' then 'band pages'
                when h.url ~ '^https://(www\.)?last\.fm/' then 'event pages'
                when h.url ~ 'wikipedia\.org' then 'wikipedia'
                when h.url = '' then 'no link'
                else 'press' end as src
      from artist_history_shows h where h.artist_id = a_id and h.date <= current_date),
  g as (select * from public.artist_tour_groups(a_id)),
  t as (
    select g.gk, coalesce(max(g.shown), mode() within group (order by n.tour)) as nm,
           count(distinct (n.date, lower(n.venue))) as k, min(n.date) as lo, max(n.date) as hi
      from n join g on g.tour = n.tour where not g.hidden group by g.gk)
  select jsonb_build_object(
    'shows', (select count(distinct (date, lower(venue))) from n),
    'setlistTotal', (select ah.total from artist_history ah where ah.artist_id = a_id),
    'setlistRows', (select count(*) from n where src = 'setlist.fm'),
    'syncAgeHours', (select round(extract(epoch from now() - ah.synced_at) / 3600) from artist_history ah where ah.artist_id = a_id),
    'bySource', (select jsonb_object_agg(x.src, x.c) from (select src, count(*) as c from n group by src) x),
    'byYear', (select jsonb_object_agg(x.yr, x.c) from (select yr, count(distinct (date, lower(venue))) as c from n group by yr) x),
    'thinYears', (select coalesce(jsonb_agg(y order by y), '[]'::jsonb)
                    from generate_series((select min(yr) from n), (select max(yr) from n)) y
                   where (select count(distinct (m.date, lower(m.venue))) from n m where m.yr = y) < 6),
    'tours', (select count(*) from t),
    'smallTours', (select coalesce(jsonb_agg(nm order by lo), '[]'::jsonb) from t where k < 3 and not public.tour_is_festival(nm)),
    'describedTours', (select coalesce(jsonb_agg(nm order by lo), '[]'::jsonb) from t where public.tour_find_madeup(nm)),
    'eraLabels', (select coalesce(jsonb_agg(nm order by lo), '[]'::jsonb) from t where hi - lo > 150 and not public.tour_is_festival(nm)),
    'looseNights', (select count(*) from n where tour = '' and festival = ''),
    'festivalNights', (select count(*) from n where festival <> ''),
    'festivals', (select count(distinct festival) from n where festival <> ''),
    'groundsUnnamed', (select count(*) from n where festival = '' and venue ~* '\mstage\M|fairground|festival|speedway|raceway|amphitheat'),
    'questionsOpen', (select count(*) from artist_tour_conflicts cf where cf.artist_id = a_id),
    'settled', (select count(*) from artist_night_overrides o where o.artist_id = a_id),
    'doubleDates', (select count(*) from (select date from n group by date having count(distinct lower(venue)) > 1) x),
    'adjacentSameRoom', (select count(*) from n a join n b on b.date = a.date + 1 and a.city <> '' and lower(b.city) = lower(a.city)
                          and lower(a.venue) = lower(b.venue) and (a.pinned or b.pinned)),
    'wayback', (select jsonb_build_object('state', f.wb, 'tries', f.wb_tries,
                         'captures', (select count(*) from tour_find_wb x where x.artist_id = a_id),
                         'showLists', (select count(*) from tour_find_pages p where p.artist_id = a_id and p.source = 'wayback'),
                         'capturesFailed', (select count(*) from tour_find_wb x where x.artist_id = a_id and x.failed),
                         'lookupsUnanswered', (select count(*) from tour_find_wbq w where w.artist_id = a_id and w.state = 'failed'))
                  from tour_finds f where f.artist_id = a_id),
    'finder', (select jsonb_build_object('status', f.status, 'detail', f.detail, 'finished', f.finished_at, 'unread', f.unread)
                 from tour_finds f where f.artist_id = a_id))
$$;
revoke all on function public.artist_history_scorecard(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
