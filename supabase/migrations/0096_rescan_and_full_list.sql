-- Two things from the first day of the finder filling pages in (Devin,
-- 2026-10-08: "some tours that were showing up before are no longer there";
-- "There should be a rescan option at the bottom of the tour list").
--  1. The summary listed at most sixty tours; a page with sixty-four lost its
--     oldest four. No cap on the list now.
--  2. Rescan: the owner can start a search again any time, not once a day.
--     The archives are kept, so a rescan only asks for what's new and reads
--     what's unread.

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
          group by public.setlist_tour_key(h4.tour)) t), '[]'::jsonb),
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

-- Rescan: force skips the once-a-day rule (never while a search is running).
drop function if exists public.tour_find_start(uuid);
create or replace function public.tour_find_start(a_id uuid, force boolean default false)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare f record;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  select * into f from tour_finds where artist_id = a_id;
  if found and f.status in ('reading', 'thinking', 'extracting') and f.started_at > now() - interval '3 hours' then return public.tour_find_state(a_id); end if;
  if found and f.day = current_date and f.status <> 'error' and not coalesce(force, false) then return public.tour_find_state(a_id); end if;
  perform public.tour_find_begin(a_id, auth.uid(), false);
  return public.tour_find_state(a_id);
end $$;
revoke all on function public.tour_find_start(uuid, boolean) from public, anon;
grant execute on function public.tour_find_start(uuid, boolean) to authenticated;

-- Every page gets its full list back.
select public.setlist_summarize(ah.artist_id) from public.artist_history ah where jsonb_array_length(coalesce(ah.summary -> 'toursList', '[]'::jsonb)) >= 60;

notify pgrst, 'reload schema';
