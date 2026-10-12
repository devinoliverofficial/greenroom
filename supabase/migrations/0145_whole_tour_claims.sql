-- A claim of a whole tour covers the whole tour (Devin, 2026-10-12).
--
-- "the crew members added the taste of chaos tour and it didnt add all the
-- shows from that tour to their analytics. Fix this."
--
-- What happened, read off the live database. A crew person who claims "the
-- entire tour" had that written down as the list of the tour's nights as the
-- archive held them that minute (0071). Two things then fell outside it:
--   1. Nights of the run that the archive holds under no tour. Four nights of
--      this run (two festival days and two shows between tour dates) are in
--      the band's own tour in the app, but in the archive their tour name was
--      a festival's or was blanked, so they were not "the tour" and were not
--      on the list: 15 nights counted where the run had played 19.
--   2. Every night played after the claim. The list was fixed on the day of
--      the claim, so a tour still on the road stopped growing for them.
--
-- What changes:
--   1. A pick of a whole tour ("mode": "all") covers every night the archive
--      holds under that tour, whenever the night was added or named, up to
--      the day the claim runs to (today, while the person is still listed).
--      A pick of single shows is still exactly those shows; a pick of a
--      year's loose shows is still the list it was.
--   2. The band's own tour in the app says which nights are the run. A night
--      on one of its dates that the archive holds under NO tour takes the name
--      the archive already has for that run (when the archive has the run
--      under one name on at least half of those dates). A night the archive
--      holds under another tour is never touched. It is written as a settled
--      night (artist_night_overrides), so a fresh read from the fans' archive
--      does not blank it again; a festival's own name on that night stays.
--      Done each night with the recount, and once now for every artist page.
--
-- Nothing here changes a Member's numbers (a Member has every night anyway)
-- or an artist page's count of shows; a tour's own row gains the nights.

-- The night's tour key is handed in, so a whole-tour pick can be matched by
-- the tour itself and not only by the list written on the day of the claim.
create or replace function public.credit_covers(claim jsonb, show_id text, d date, tk text)
returns boolean
language sql stable as $function$
  select claim is not null
     and (d is null or d <= coalesce(nullif(claim ->> 'until', '')::date, current_date))
     and (coalesce(claim ->> 'all', '') = 'true'
          or exists (select 1 from jsonb_array_elements(
                       case when jsonb_typeof(claim -> 'picks') = 'array' then claim -> 'picks' else '[]'::jsonb end) p
                      where (jsonb_typeof(p -> 'shows') = 'array' and (p -> 'shows') ? show_id)
                         or (p ->> 'mode' = 'all' and coalesce(tk, '') <> '' and tk not like 'year:%' and p ->> 'key' = tk)))
$function$;
revoke all on function public.credit_covers(jsonb, text, date, text) from public, anon, authenticated;
grant execute on function public.credit_covers(jsonb, text, date, text) to service_role;

-- The three readers of a claim, as they stand in the database, with one
-- change each: they hand the night's tour key to credit_covers.
CREATE OR REPLACE FUNCTION public.credited_shows(u uuid)
 RETURNS TABLE(artist_id uuid, show_id text, d date, city text, state text, country_code text, tkey text, tour text, venue text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- a member: every night of the artist; one who left, every night up to that day
  select h.artist_id, h.id, h.date, h.city, h.state, h.country_code, h.tkey, h.tour, h.venue
    from artist_members m
    join artist_history_shows h on h.artist_id = m.artist_id
   where m.user_id = u and m.kind = 'band'
     and (m.ended_at is null or h.date <= m.ended_at)
  union all
  -- crew: what the artist confirmed. Still listed, the claim runs on; left, it stops that day.
  select h.artist_id, h.id, h.date, h.city, h.state, h.country_code, h.tkey, h.tour, h.venue
    from tour_credits c
    cross join lateral (select public.credit_claim_live(c.artist_id, c.user_id, c.approved) as claim offset 0) k
    join artist_history_shows h on h.artist_id = c.artist_id
   where c.user_id = u and c.approved is not null
     and not exists (select 1 from artist_members b where b.artist_id = c.artist_id and b.user_id = u and b.kind = 'band')
     and exists (select 1 from artist_endorsements e
                  where e.artist_id = c.artist_id and e.user_id = c.user_id and e.removed_at is null)
     and public.credit_covers(k.claim, h.id, h.date, h.tkey)
$function$;
revoke all on function public.credited_shows(uuid) from public, anon, authenticated;


CREATE OR REPLACE FUNCTION public.credit_counts(a_id uuid, claim jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with g as materialized (select * from public.artist_tour_groups(a_id)),
       n as (select h.date, h.venue, h.tour from artist_history_shows h
              where h.artist_id = a_id and claim is not null and h.date <= current_date
                and public.credit_covers(claim, h.id, h.date, h.tkey))
  select jsonb_build_object(
    'tours', (select count(distinct g.gk) from n join g on g.tour = n.tour where n.tour <> '' and not g.hidden),
    'shows', (select count(distinct (n.date, lower(n.venue))) from n))
$function$;
revoke all on function public.credit_counts(uuid, jsonb) from public, anon, authenticated;


CREATE OR REPLACE FUNCTION public.credit_expand(a_id uuid, claim jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', x.tkey, 'name', x.nm, 'year', x.tkey like 'year:%',
      'total', x.total, 'n', x.n, 'first', x.d0, 'last', x.d1)
      order by x.d1 desc nulls last, x.tkey), '[]'::jsonb)
    from (
      select h.tkey,
             case when h.tkey like 'year:%' then '' else mode() within group (order by h.tour) end as nm,
             count(*) filter (where h.date is null or h.date <= current_date) as total,
             count(*) filter (where public.credit_covers(claim, h.id, h.date, h.tkey)) as n,
             min(h.date) filter (where public.credit_covers(claim, h.id, h.date, h.tkey)) as d0,
             max(h.date) filter (where public.credit_covers(claim, h.id, h.date, h.tkey)) as d1
        from artist_history_shows h
       where h.artist_id = a_id and claim is not null
       group by h.tkey
      having count(*) filter (where public.credit_covers(claim, h.id, h.date, h.tkey)) > 0) x
$function$;
revoke all on function public.credit_expand(uuid, jsonb) from public, anon, authenticated;


-- The band's own tour says which nights are the run. For each tour of the
-- artist in the app (artist_tours, 0143: made by the account that runs the
-- page, not taken down): the archive's nights on that tour's dates; the name
-- most of them already carry; and the ones under no tour take that name.
-- Returns how many nights it named.
create or replace function public.tour_own_nights(a_id uuid)
returns integer
language plpgsql volatile security definer set search_path = public as $function$
declare t record; nm text; n_top int; n_all int; k int; made int := 0;
begin
  for t in select x.id, x.doc from public.artist_tours(a_id) x loop
    select count(*) into n_all
      from artist_history_shows h
     where h.artist_id = a_id
       and to_char(h.date, 'YYYY-MM-DD') in (
             select e.value ->> 'date'
               from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
              where jsonb_typeof(e.value) = 'object' and (e.value ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$');
    continue when n_all = 0;
    select h.tour, count(*) into nm, n_top
      from artist_history_shows h
     where h.artist_id = a_id and h.tour <> ''
       and to_char(h.date, 'YYYY-MM-DD') in (
             select e.value ->> 'date'
               from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
              where jsonb_typeof(e.value) = 'object' and (e.value ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$')
     group by h.tour order by count(*) desc, h.tour limit 1;
    -- (the archive has to know the run by one name already, on at least half of these dates)
    continue when nm is null or n_top * 2 < n_all;
    -- settled, so a fresh read does not blank them again (a festival's name and the rest of the row stay)
    insert into artist_night_overrides (artist_id, date, tour, gone)
    select a_id, h.date, nm, false
      from artist_history_shows h
     where h.artist_id = a_id and h.tour = ''
       and to_char(h.date, 'YYYY-MM-DD') in (
             select e.value ->> 'date'
               from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
              where jsonb_typeof(e.value) = 'object' and (e.value ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$')
     group by h.date
    on conflict (artist_id, date) do update set tour = excluded.tour, set_at = now();
    update artist_history_shows h set tour = nm, named_by = null
     where h.artist_id = a_id and h.tour = ''
       and to_char(h.date, 'YYYY-MM-DD') in (
             select e.value ->> 'date'
               from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
              where jsonb_typeof(e.value) = 'object' and (e.value ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$');
    get diagnostics k = row_count;
    made := made + k;
  end loop;
  return made;
end $function$;
revoke all on function public.tour_own_nights(uuid) from public, anon, authenticated;

-- setlist_recount_today, as it stands (0142), with one change: each page's own
-- tours name their nights before the page is counted.
CREATE OR REPLACE FUNCTION public.setlist_recount_today()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; n int := 0;
begin
  -- First each person's own four numbers, noted where they have moved
  -- (road_person_log). It only reads the nights, so it runs before the pages
  -- below are held for their recount. A note beside the count and never part
  -- of it: whatever goes wrong in it is swallowed here, and the pages are
  -- counted all the same.
  begin
    perform public.road_person_note();
  exception when others then
    raise log 'road_person_log: the nightly note did not run (%)', sqlerrm;
  end;
  for r in select ah.artist_id from artist_history ah
            where exists (select 1 from artist_history_shows s where s.artist_id = ah.artist_id and s.date = public.road_today())
  loop
    -- The band's own tour says which nights are the run (tour_own_nights): a
    -- night of it that the archive holds under no tour takes the run's name
    -- before the page is counted. Never the reason a page is not counted.
    begin
      perform public.tour_own_nights(r.artist_id);
    exception when others then
      raise log 'tour_own_nights: % (%)', r.artist_id, sqlerrm;
    end;
    perform public.setlist_summarize(r.artist_id);
    n := n + 1;
  end loop;
  return n;
end $function$;
revoke all on function public.setlist_recount_today() from public, anon, authenticated;


-- Once now, for every artist page: its own tours name their nights, and the
-- page is counted again (PIPELINE.md section 8: a change to nights ends with a count).
do $$
declare r record; n int;
begin
  for r in select ah.artist_id from artist_history ah
            where exists (select 1 from artist_history_shows s where s.artist_id = ah.artist_id) loop
    n := public.tour_own_nights(r.artist_id);
    if n > 0 then perform public.setlist_summarize(r.artist_id); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
-- credited_shows, credit_counts and credit_expand back to their text before
-- this file (0132, 0120 and 0071: the same statements with the three-argument
-- credit_covers), setlist_recount_today back to 0142's, then:
--   drop function if exists public.tour_own_nights(uuid);
--   drop function if exists public.credit_covers(jsonb, text, date, text);
--   notify pgrst, 'reload schema';
-- The nights this file named keep their name (they are settled nights now):
-- to un-name one, the page's owner picks "Not part of a tour" for it.
