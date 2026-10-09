-- Two more guards on "listed" versus "played" (2026-10-09), both seen on the first
-- full run of the band's-own-pages pass:
--  * an official site captured in November 2020 was still showing the last four
--    dates of the 2019 tour, with no year printed; the reader took them for
--    December 2020. A date whose year the page does not print, and whose same day
--    in the same city is already on the artist's page a year or two earlier, is an
--    old list still showing: not taken.
--  * tours announced for mid-March 2020 to mid-June 2021 were, almost everywhere,
--    not played. An announced night in those months no longer lands (unless it is
--    from a file the band handed over, or the owner has settled it), and the ones
--    already on pages come off; setlist.fm's own nights are untouched.

create or replace function public.tour_find_finish(a_id uuid, stopped text default null)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare items jsonb; named jsonb; loose jsonb; merged jsonb; n int; k int; arts int; v_unread int; i int; st jsonb;
        own record; run_key text; run_name text; run_n int;
begin
  -- What the reader found, batch by batch. An item read off the band's own page keeps a tour name only
  -- when the page itself prints it, keeps the capture as its source, and loses any date the page could
  -- not have meant (more than a month before the capture with that year printed nowhere on it).
  select coalesce(jsonb_agg(
           case when coalesce(wb.own, false)
                then (x - 'source') || jsonb_build_object(
                       'sources', b.urls,
                       'name', case when btrim(coalesce(x ->> 'name', '')) <> '' and position(lower(btrim(x ->> 'name')) in wb.body) > 0
                                    then x ->> 'name' else '' end,
                       'dates', coalesce((
                          select jsonb_agg(z.d order by z.d ->> 'date')
                            from jsonb_array_elements(case when jsonb_typeof(x -> 'dates') = 'array' then x -> 'dates' else '[]'::jsonb end) raw
                            cross join lateral (select public.tour_find_date(raw) as d) z
                           where z.d is not null
                             and (wb.snap is null
                                  or ((z.d ->> 'date')::date <= wb.snap + 500
                                      and ((z.d ->> 'date')::date >= wb.snap - 31 or position(left(z.d ->> 'date', 4) in wb.body) > 0)))
                             -- An old list still showing: the page prints no year for it, and the same day in the
                             -- same city is already on the artist's page a year or two earlier.
                             and not (position(left(z.d ->> 'date', 4) in wb.body) = 0
                                      and exists (select 1 from artist_history_shows h
                                                   where h.artist_id = a_id
                                                     and h.date in (((z.d ->> 'date')::date - interval '1 year')::date, ((z.d ->> 'date')::date - interval '2 years')::date)
                                                     and lower(h.city) = lower(btrim(split_part(z.d ->> 'city', ',', 1)))))), '[]'::jsonb))
                else x end), '[]'::jsonb) into items
    from tour_find_batches b
    cross join lateral jsonb_array_elements(case when jsonb_typeof(b.found) = 'array' then b.found else '[]'::jsonb end) x
    cross join lateral (select bool_and(g.source = 'wayback') as own, lower(string_agg(g.body, ' ')) as body, max(g.published) as snap
                          from tour_find_pages g where g.artist_id = a_id and b.urls ? g.url) wb
   where b.artist_id = a_id and b.status = 'done' and jsonb_typeof(x) = 'object';
  select coalesce(sum(jsonb_array_length(b.urls)), 0) into arts from tour_find_batches b where b.artist_id = a_id and b.status = 'done';
  -- Articles the reader never answered for (busy, cut off, turned away): unread, and said so.
  select coalesce(sum(jsonb_array_length(b.urls)), 0) into v_unread from tour_find_batches b where b.artist_id = a_id and b.status in ('failed', 'todo', 'asked');
  select coalesce(jsonb_agg(x), '[]'::jsonb) into named from jsonb_array_elements(items) x where btrim(coalesce(x ->> 'name', '')) <> '';
  -- Shows the band listed under no tour name: plain nights, one item per capture and year.
  select coalesce(jsonb_agg(jsonb_build_object('name', '', 'start', y.lo, 'end', y.hi, 'region', '', 'dates', y.ds, 'sources', y.srcs)), '[]'::jsonb) into loose
    from (select x -> 'sources' as srcs, left(d ->> 'date', 4) as yr, min(d ->> 'date') as lo, max(d ->> 'date') as hi, jsonb_agg(d order by d ->> 'date') as ds
            from jsonb_array_elements(items) x
            cross join lateral jsonb_array_elements(case when jsonb_typeof(x -> 'dates') = 'array' then x -> 'dates' else '[]'::jsonb end) d
           where btrim(coalesce(x ->> 'name', '')) = '' and jsonb_typeof(d) = 'object' and (d ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
           group by 1, 2) y;
  merged := public.tour_find_merge(named);
  n := public.tour_find_propose_in(a_id, merged);
  for i in 0 .. greatest(0, (jsonb_array_length(loose) - 1) / 150) loop
    n := n + public.tour_find_propose_in(a_id, (select coalesce(jsonb_agg(o.e), '[]'::jsonb)
                                                  from jsonb_array_elements(loose) with ordinality as o(e, ord)
                                                 where o.ord > i * 150 and o.ord <= (i + 1) * 150));
  end loop;
  k := public.tour_find_autofill(a_id);
  -- A run the page knows only by its bill ("I See Stars, We Came as Romans, etc. tour") that the
  -- band's own page printed a name for ("Leave it to the Suits Tour"): the band's name is shown.
  -- Only when most of the named dates sit in that one run, the run's name is a description, and
  -- the owner has not named it; a name another tour on the page already answers to gets its year.
  for own in
    select btrim(x ->> 'name') as nm,
           array(select (d ->> 'date')::date from jsonb_array_elements(x -> 'dates') d where (d ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$') as ds
      from jsonb_array_elements(items) x
     where btrim(coalesce(x ->> 'name', '')) <> '' and (x -> 'sources' ->> 0) like 'https://web.archive.org/web/%'
       and jsonb_typeof(x -> 'dates') = 'array' and jsonb_array_length(x -> 'dates') >= 3
  loop
    select g.gk, coalesce(max(g.shown), mode() within group (order by h.tour)), count(distinct h.date)
      into run_key, run_name, run_n
      from artist_history_shows h join public.artist_tour_groups(a_id) g on g.tour = h.tour
     where h.artist_id = a_id and h.date = any (own.ds) and not g.hidden
     group by g.gk order by count(distinct h.date) desc limit 1;
    if run_key is null or run_n < 3 or run_n < 0.8 * cardinality(own.ds) then continue; end if;
    if not public.tour_find_madeup(run_name) or public.tour_find_madeup(own.nm) then continue; end if;
    if run_key = public.artist_tour_gkey(a_id, own.nm) then continue; end if;
    insert into artist_tour_edits (artist_id, key, new_name)
    values (a_id, run_key,
            left(own.nm || case when exists (select 1 from public.artist_tour_groups(a_id) g2 where g2.gk = public.artist_tour_gkey(a_id, own.nm))
                                then ' (' || to_char(own.ds[1], 'YYYY') || ')' else '' end, 120))
    on conflict (artist_id, key) do update
       set new_name = case when artist_tour_edits.new_name = '' then excluded.new_name else artist_tour_edits.new_name end;
  end loop;
  st := public.tour_find_wb_settle(a_id);
  perform public.setlist_summarize(a_id);
  update tour_finds set status = 'done', extracting_at = null, finished_at = now(), unread = v_unread,
         detail = coalesce(stopped || ' ', '') || 'Read ' || arts || ' articles: ' || (jsonb_array_length(merged) + jsonb_array_length(loose)) || ' tours and show lists found, ' || n || ' new, ' || k || ' added to the page'
                  || case when (st ->> 'dropped')::int + (st ->> 'moved')::int > 0
                          then ', ' || (st ->> 'dropped') || ' nights the band later took off its own list removed, ' || (st ->> 'moved') || ' moved' else '' end
                  || case when v_unread > 0 then ', ' || v_unread || ' articles still to read' else '' end
   where artist_id = a_id;
  delete from tour_find_batches where artist_id = a_id;
end $$;
revoke all on function public.tour_find_finish(uuid, text) from public, anon, authenticated;

create or replace function public.tour_find_apply(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; d jsonb; n int := 0; cc text; ct text; src text; kc text; fest boolean;
begin
  delete from artist_history_shows p
   where p.artist_id = a_id and p.pinned
     and exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = p.date and not h.pinned);
  delete from artist_history_shows p
   where p.artist_id = a_id and p.pinned and p.date between date '2020-03-13' and date '2021-06-15'
     and p.url !~ '^https://(www\.)?(concertarchives\.org|songkick\.com|bandsintown\.com)'
     and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = p.date)
     and not exists (select 1 from artist_night_overrides o where o.artist_id = a_id and o.date = p.date and not o.gone);
  for c in select * from tour_candidates where artist_id = a_id and status = 'added' and first_day is not null and last_day is not null
            and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.setlist_tour_key(tour_candidates.name))
            order by last_day - first_day asc
  loop
    kc := public.artist_tour_gkey(a_id, c.name);
    if c.name <> '' then
      update artist_history_shows h set tour = c.name, named_by = c.id
       where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date);
      -- A night the announcement lists goes under this tour, whatever label setlist.fm had on it;
      -- a night another find pinned, or one in a settled or open conflict, is left alone.
      update artist_history_shows h set tour = c.name, named_by = c.id
       where h.artist_id = a_id and h.tour <> '' and public.artist_tour_gkey(a_id, h.tour) <> kc
         and (not h.pinned or h.named_by = c.id)
         and exists (select 1 from jsonb_array_elements(c.dates) x where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'date')::date = h.date)
         and not exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and cf.date = h.date)
         and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = h.date);
    end if;
    src := coalesce((select s from jsonb_array_elements_text(case when jsonb_typeof(c.sources) = 'array' then c.sources else '[]'::jsonb end) s where s like 'https://%' limit 1), '');
    -- A festival (Devin: "most of the time an artist is only playing one day") that lists many
    -- cities: when fewer than half its dates have a night the page already knows, only those
    -- corroborated dates land — the rest are the festival's other stops, not the act's.
    fest := public.tour_is_festival(c.name) and jsonb_array_length(c.dates) > 3
      and (select count(*) from jsonb_array_elements(c.dates) x
            where case when (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
                       then exists (select 1 from artist_history_shows h where h.artist_id = a_id and not h.pinned and abs(h.date - (x ->> 'date')::date) <= 1)
                       else false end)
          < jsonb_array_length(c.dates) / 2.0;
    if fest then
      delete from artist_history_shows h where h.artist_id = a_id and h.pinned and h.named_by = c.id;
    end if;
    for d in select * from jsonb_array_elements(c.dates)
    loop
      if (d ->> 'date') !~ '^\d{4}-\d{2}-\d{2}$' then continue; end if;
      if (d ->> 'date')::date > current_date then continue; end if;
      -- Mid-March 2020 to mid-June 2021: what was announced was, almost everywhere, not played. An
      -- announced night in those months lands only from a file the band handed over; setlist.fm's
      -- own nights are untouched.
      if (d ->> 'date')::date between date '2020-03-13' and date '2021-06-15'
         and src !~ '^https://(www\.)?(concertarchives\.org|songkick\.com|bandsintown\.com)' then continue; end if;
      if exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (d ->> 'date')::date) then continue; end if;
      if fest then continue; end if;  -- a festival's other days stay off the page
      ct := left(btrim(split_part(coalesce(d ->> 'city', ''), ',', 1)), 80);
      cc := coalesce(public.road_country(d ->> 'city'), '');
      insert into artist_history_shows (artist_id, id, date, venue, city, state, country_code, country, tour, url, pinned, named_by, seen)
      values (a_id, 'tf:' || c.id || ':' || (d ->> 'date'), (d ->> 'date')::date, left(coalesce(d ->> 'venue', ''), 120), ct,
              case when cc in ('US', 'CA') then left(btrim(split_part(coalesce(d ->> 'city', ''), ',', 2)), 80) else '' end,
              cc, case cc when 'US' then 'United States' when 'CA' then 'Canada' when 'GB' then 'United Kingdom' when 'AU' then 'Australia'
                          when '' then ''
                          else left(btrim(coalesce(substring(d ->> 'city' from ',([^,]*)$'), '')), 80) end,
              c.name, left(src, 300), true, c.id, now())
      on conflict (artist_id, id) do nothing;
      n := n + 1;
    end loop;
  end loop;
  update artist_history ah set credits = coalesce((
      select jsonb_agg(distinct x.host) from (
        select substring(h.url from '^https://(?:www\.)?([^/]+)') as host
          from artist_history_shows h where h.artist_id = a_id and h.pinned and h.url like 'https://%') x
       where x.host is not null and x.host in ('concertarchives.org', 'songkick.com', 'bandsintown.com', 'web.archive.org')), '[]'::jsonb)
   where ah.artist_id = a_id;
  perform public.festival_tag(a_id);
  perform public.artist_night_overrides_apply(a_id);
  return n;
end $$;
revoke all on function public.tour_find_apply(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
