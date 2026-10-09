-- The tours, tightened (Devin, 2026-10-08, after the first full day: "if a
-- tour is listed then EVERY show should also be listed under that tour";
-- "Warped Tour 2010 was logged twice"; "Vans Warped Tour 2025 we only did
-- Orlando"; festivals need their own care; "when you click it it shows the
-- dates and the bands it was with").
--  1. Two tours on the page alike in name whose runs overlap or touch fold
--     into one (Warped Tour 2010 / Vans Warped Tour 2010).
--  2. A find named by its bill, sitting on a real short tour the page already
--     names, takes that name (the Falling In Reverse / Enter Shikari / letlive
--     run was the Monster Energy Outbreak Tour 2012).
--  3. Festivals: a stop's name loses its "– City, ST"; a festival that lists
--     many cities keeps only the dates the act is actually on (a night the
--     page already knows within a day) when fewer than half are; the reader
--     is told a festival is one item, one date; and Wikipedia's festival
--     pages are searched too.
--  4. The summary carries each tour's lineup, for the tap.
--  5. The fact check treats setlist.fm's album-era labels as blanks.

-- A festival, by its name.
create or replace function public.tour_is_festival(nm text)
returns boolean
language sql immutable as $$
  select coalesce(nm, '') ~* '\m(fest|festival|warped|jam|rock am ring|rock im park|sxsw|bamboozle|soundwave|slam dunk|louder than life|rockville|aftershock|inkcarceration|sonic temple|so what|download|reading|leeds|hellfest|graspop|groezrock|riot fest|self help|skate and surf|bled fest|summer slaughter|mayhem)\M'
$$;
revoke all on function public.tour_is_festival(text) from public, anon, authenticated;

-- "Vans Warped Tour 2025 – Washington, D.C." is Vans Warped Tour 2025.
create or replace function public.tour_name_clean(nm text)
returns text
language sql immutable as $$
  select case when public.tour_is_festival(nm)
              then btrim(regexp_replace(coalesce(nm, ''), '\s+[–—-]\s+[A-Z][A-Za-z.\s]+(,\s*[A-Za-z.]{2,})?\s*$', ''))
              else coalesce(nm, '') end
$$;
revoke all on function public.tour_name_clean(text) from public, anon, authenticated;

create or replace function public.tour_find_propose_in(a_id uuid, cands jsonb)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c jsonb; nm text; key text; fd date; ld date; n int := 0; ds jsonb; have_name text; missing int;
begin
  if jsonb_typeof(cands) <> 'array' then return 0; end if;
  for c in select * from jsonb_array_elements(cands) limit 160
  loop
   begin
    nm := left(public.tour_name_clean(btrim(regexp_replace(coalesce(c ->> 'name', ''), '\s+', ' ', 'g'))), 120);
    fd := case when (c ->> 'start') ~ '^\d{4}-\d{2}-\d{2}$' then (c ->> 'start')::date
               when (c ->> 'start') ~ '^\d{4}-\d{2}$' then ((c ->> 'start') || '-01')::date end;
    ld := case when (c ->> 'end') ~ '^\d{4}-\d{2}-\d{2}$' then (c ->> 'end')::date
               when (c ->> 'end') ~ '^\d{4}-\d{2}$' then (((c ->> 'end') || '-01')::date + interval '1 month' - interval '1 day')::date end;
    if fd is null or ld is null or ld < fd or ld - fd > 400 or fd < date '1980-01-01' or fd > current_date + 400 then continue; end if;
    -- Dates come as objects or as the compact line "YYYY-MM-DD | City, ST | Venue": both read.
    select coalesce(jsonb_agg(d order by d ->> 'date'), '[]'::jsonb) into ds
      from (select public.tour_find_date(x) as d
              from jsonb_array_elements(case when jsonb_typeof(c -> 'dates') = 'array' then c -> 'dates' else '[]'::jsonb end) x) q
     where d is not null and (d ->> 'date')::date between fd - 1 and ld + 1;
    if nm = '' then
      -- One-off shows: only the nights the page doesn't have yet, under no name.
      select coalesce(jsonb_agg(d order by d ->> 'date'), '[]'::jsonb) into ds
        from jsonb_array_elements(ds) d
       where not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (d ->> 'date')::date);
      if jsonb_array_length(ds) = 0 then continue; end if;
      insert into tour_candidates (artist_id, name, role, first_day, last_day, region, lineup, dates, sources, fill)
      values (a_id, '', '', fd, ld, left(coalesce(c ->> 'region', ''), 60), '', ds,
        (select coalesce(jsonb_agg(left(s, 300)), '[]'::jsonb) from (
           select distinct s from jsonb_array_elements_text(case when jsonb_typeof(c -> 'sources') = 'array' then c -> 'sources' else '[]'::jsonb end) s
            where s like 'https://%' limit 6) x), false);
      n := n + 1;
      continue;
    end if;
    if char_length(nm) < 2 then continue; end if;
    key := public.setlist_tour_key(nm);
    if exists (select 1 from tour_candidates t where t.artist_id = a_id and t.name <> '' and public.setlist_tour_key(t.name) = key) then continue; end if;
    select mode() within group (order by h.tour) into have_name
      from artist_history_shows h where h.artist_id = a_id and h.tour <> '' and public.setlist_tour_key(h.tour) = key;
    if have_name is not null then
      select count(*) into missing from jsonb_array_elements(ds) d
       where (d ->> 'date')::date <= current_date
         and not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (d ->> 'date')::date);
      if coalesce(missing, 0) = 0 then
        select count(*) into missing from artist_history_shows h
         where h.artist_id = a_id and h.tour = ''
           and exists (select 1 from jsonb_array_elements(ds) d where abs(h.date - (d ->> 'date')::date) <= 1);
      end if;
      if coalesce(missing, 0) = 0 then continue; end if;
      nm := have_name;
    end if;
    insert into tour_candidates (artist_id, name, role, first_day, last_day, region, lineup, dates, sources, fill)
    values (a_id, nm,
      case when c ->> 'role' in ('headline', 'co-headline', 'support', 'festival') then c ->> 'role' else '' end,
      fd, ld, left(coalesce(c ->> 'region', ''), 60), left(coalesce(c ->> 'lineup', ''), 300), ds,
      (select coalesce(jsonb_agg(left(s, 300)), '[]'::jsonb) from (
         select distinct s from jsonb_array_elements_text(case when jsonb_typeof(c -> 'sources') = 'array' then c -> 'sources' else '[]'::jsonb end) s
          where s like 'https://%' limit 6) x),
      have_name is not null);
    n := n + 1;
   exception when others then
    update tour_finds set detail = left('Skipped an item: ' || sqlerrm, 160) where artist_id = a_id;
   end;
  end loop;
  return n;
end $$;
revoke all on function public.tour_find_propose_in(uuid, jsonb) from public, anon, authenticated;

create or replace function public.tour_find_prompt(a_id uuid, nm text, urls jsonb)
returns text
language sql stable security definer set search_path = public as $$
  select 'TOUR FINDER. You are helping a touring app list the tours of the act "' || nm || '". Below are news articles and encyclopedia passages, each with its date and URL. '
      || 'Return ONLY a JSON array. Each item is one tour or run that ' || nm || ' was part of: a headline or co-headline tour, a support slot on another act’s tour, or a package/festival tour (Warped, Taste of Chaos). '
      || 'Fields: "name" (the announced tour name; if the run had no name, a short description such as "Fall 2018 run with Dance Gavin Dance"), '
      || '"role" (one of headline, co-headline, support, festival), "start" and "end" (YYYY-MM-DD; when a listing gives month/day only, take the year from the article date, and remember a run announced in the fall may start the next year), '
      || '"lineup" (the other acts, comma separated), "region" (US, UK/Europe, Australia, Japan, Canada…), '
      || '"dates" (every date listed for ' || nm || ', each as one short string "YYYY-MM-DD | City, ST | Venue"; an empty array if none are listed), "source" (the article URL). '
      || 'Rules: only runs ' || nm || ' is on; a festival appearance is one item named "<Festival> <year>" with ONLY the date(s) and city ' || nm || ' plays — never the other cities or days of that festival; skip anything that is not a show (album news, videos, members leaving); when a later article updates an earlier one (dates added, moved or cancelled) fold them into one item; never invent dates; if nothing qualifies return [].' || E'\n\n'
      || coalesce((select string_agg('--- ARTICLE ' || x.n || ' | ' || coalesce(to_char(g.published, 'YYYY-MM-DD'), 'date unknown') || ' | ' || g.url || E'\n'
                                     || case when g.title <> '' then g.title || E'\n' else '' end || g.body || E'\n', E'\n' order by x.n)
                     from jsonb_array_elements_text(urls) with ordinality as x(url, n)
                     join tour_find_pages g on g.artist_id = a_id and g.url = x.url), '')
$$;
revoke all on function public.tour_find_prompt(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.tour_find_fold(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c record; p record; g record; folds int := 0; kc text; win_name text; nights_win int; nights_lose int;
begin
  -- 1. A find and a page tour that are the same tour under two spellings.
  for c in select t.id, t.name, t.dates from tour_candidates t where t.artist_id = a_id and t.status = 'added' and t.name <> '' and jsonb_array_length(t.dates) > 0
  loop
    kc := public.artist_tour_gkey(a_id, c.name);
    for p in select public.artist_tour_gkey(a_id, h.tour) as key, mode() within group (order by h.tour) as name
               from jsonb_array_elements(c.dates) d join artist_history_shows h on h.artist_id = a_id and h.date = (d ->> 'date')::date and h.tour <> ''
              where public.artist_tour_gkey(a_id, h.tour) <> kc
              group by 1
    loop
      if not public.tour_names_alike(kc, p.key) then continue; end if;
      select count(*) into nights_lose from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = kc;
      select count(*) into nights_win from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = p.key;
      if nights_win >= nights_lose then
        perform public.tour_fold_one(a_id, p.key, p.name, kc, c.name);
        update tour_candidates set name = p.name where id = c.id;
        kc := p.key;
      else
        select mode() within group (order by h.tour) into win_name from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = kc;
        perform public.tour_fold_one(a_id, kc, win_name, p.key, p.name);
      end if;
      folds := folds + 1;
    end loop;
  end loop;
  -- 1b. A find named by its bill ("Falling In Reverse, Enter Shikari, Letlive tour") whose run overlaps a
  -- real, short tour the page already names ("Monster Energy Outbreak Tour 2012"): one tour, under that name
  -- (an act is not on two tours the same night; an album-era label months long is not a tour, nor a festival).
  for c in select t.id, t.name, t.first_day, t.last_day, t.dates from tour_candidates t
            where t.artist_id = a_id and t.status = 'added' and t.name <> '' and public.tour_find_madeup(t.name) and jsonb_array_length(t.dates) > 0
  loop
    kc := public.artist_tour_gkey(a_id, c.name);
    for p in select pg.gk as key, pg.name, pg.n, pg.first, pg.last from (
               select gr.gk, mode() within group (order by h.tour) as name, count(*) as n, min(h.date) as first, max(h.date) as last
                 from artist_history_shows h join public.artist_tour_groups(a_id) gr on gr.tour = h.tour
                where h.artist_id = a_id and not gr.hidden
                  -- a night still under question is no evidence of where the tour ran
                  and not exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and cf.date = h.date)
                group by gr.gk) pg
              where pg.gk <> kc and not public.tour_find_madeup(pg.name) and not public.tour_is_festival(pg.name)
                and pg.n >= 3 and pg.last - pg.first <= 120
                and least(pg.last, c.last_day) - greatest(pg.first, c.first_day) >= 1
    loop
      perform public.tour_fold_one(a_id, p.key, p.name, kc, c.name);
      -- the real name is the one shown, however many nights carried the bill's
      update artist_history_shows h set tour = p.name
       where h.artist_id = a_id and h.tour <> p.name and public.artist_tour_gkey(a_id, h.tour) = p.key;
      update tour_candidates set name = p.name where id = c.id;
      folds := folds + 1;
      kc := p.key;
    end loop;
  end loop;
  -- 1c. Two tours on the page alike in name whose runs overlap or touch ("Warped Tour 2010" / "Vans Warped Tour 2010"): one tour.
  for g in
    with grp as (select gr.gk as key, mode() within group (order by h.tour) as name, count(*) as n, min(h.date) as first, max(h.date) as last
                   from artist_history_shows h join public.artist_tour_groups(a_id) gr on gr.tour = h.tour
                  where h.artist_id = a_id and not gr.hidden group by gr.gk)
    select s.key as small_key, s.name as small_name, b.key as big_key, b.name as big_name
      from grp s join grp b on b.key <> s.key and b.n >= s.n and (b.n > s.n or b.key > s.key)
     where public.tour_names_alike(s.key, b.key)
       and s.first <= b.last + 14 and b.first <= s.last + 14
  loop
    perform public.tour_fold_one(a_id, g.big_key, g.big_name, g.small_key, g.small_name);
    folds := folds + 1;
  end loop;
  -- 2. A tiny tour whose every night sits inside another tour's run.
  for g in
    with grp as (select public.artist_tour_gkey(a_id, h.tour) as key, mode() within group (order by h.tour) as name, count(*) as n,
                        array_agg(h.date order by h.date) as dates
                   from artist_history_shows h where h.artist_id = a_id and h.tour <> ''
                    and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.artist_tour_gkey(a_id, h.tour))
                  group by 1)
    select s.key as small_key, s.name as small_name, b.key as big_key, b.name as big_name
      from grp s
      join lateral (
        select o.key, o.name from grp o
         where o.key <> s.key and o.n >= 5
           and not exists (select 1 from unnest(s.dates) sd
                            where not exists (select 1 from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = o.key and h.date between sd - 6 and sd - 1)
                               or not exists (select 1 from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = o.key and h.date between sd + 1 and sd + 6))
         order by o.n desc limit 1) b on true
     where s.n <= 3
  loop
    perform public.tour_fold_one(a_id, g.big_key, g.big_name, g.small_key, g.small_name);
    folds := folds + 1;
  end loop;
  return folds;
end $$;
revoke all on function public.tour_find_fold(uuid) from public, anon, authenticated;

create or replace function public.tour_find_apply(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; d jsonb; n int := 0; cc text; ct text; src text; kc text; fest boolean;
begin
  delete from artist_history_shows p
   where p.artist_id = a_id and p.pinned
     and exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = p.date and not h.pinned);
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
       where x.host is not null and x.host in ('concertarchives.org', 'songkick.com', 'bandsintown.com')), '[]'::jsonb)
   where ah.artist_id = a_id;
  return n;
end $$;
revoke all on function public.tour_find_apply(uuid) from public, anon, authenticated;

create or replace function public.tour_find_brain(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare f record; key text; nm text; b record; w record; body jsonb; txt text; a int; z int; items jsonb; half int; n int := 0;
        inflight int; rid bigint; msg text; about text; ttl text; pg jsonb; stop text; bad4 int;
        ua constant text := 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/; devinoliverofficial@gmail.com)';
begin
  -- One brain per artist at a time: a second caller leaves it to the first.
  select * into f from tour_finds where artist_id = a_id for update skip locked;
  if not found or f.brain = 'bad_key' then return 0; end if;
  key := public.tour_find_key();
  if key is null then
    if f.status = 'thinking' then
      perform public.tour_find_finish(a_id, 'The reading key went away;');
      update tour_finds set status = 'ready', extracting_at = null where artist_id = a_id;
    end if;
    return 0;
  end if;
  select ar.name into nm from artists ar where ar.id = a_id;

  if f.status = 'ready' then
    perform public.tour_find_batch(a_id);
    update tour_finds set status = 'thinking', extracting_at = now(), wiki = 'new', unread = 0 where artist_id = a_id;
    f.status := 'thinking'; f.wiki := 'new';
  end if;
  if f.status <> 'thinking' then return 0; end if;

  -- Wikipedia: one search, then the articles it names, cut to the paragraphs that mention the act.
  if f.wiki = 'new' then
    -- Two searches: the act's own articles, and tour articles that name it (another act's tour it supported).
    rid := net.http_get(url := 'https://en.wikipedia.org/w/api.php',
      params := jsonb_build_object('action', 'query', 'list', 'search', 'format', 'json', 'srlimit', '6', 'srsearch', '"' || nm || '"'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 15000);
    insert into tour_find_wiki (artist_id, request_id, kind) values (a_id, rid, 'search');
    rid := net.http_get(url := 'https://en.wikipedia.org/w/api.php',
      params := jsonb_build_object('action', 'query', 'list', 'search', 'format', 'json', 'srlimit', '10', 'srsearch', '"' || nm || '" intitle:Tour'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 15000);
    insert into tour_find_wiki (artist_id, request_id, kind) values (a_id, rid, 'search');
    -- Festivals (Devin): the festival pages that name the act, read for the day it played.
    rid := net.http_get(url := 'https://en.wikipedia.org/w/api.php',
      params := jsonb_build_object('action', 'query', 'list', 'search', 'format', 'json', 'srlimit', '8', 'srsearch', '"' || nm || '" festival'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 15000);
    insert into tour_find_wiki (artist_id, request_id, kind) values (a_id, rid, 'search');
    update tour_finds set wiki = 'searching' where artist_id = a_id;
    f.wiki := 'searching';
  end if;
  for w in select q.request_id, q.kind, q.title, resp.status_code, resp.content
             from tour_find_wiki q join net._http_response resp on resp.id = q.request_id
            where q.artist_id = a_id
  loop
    begin
      if w.status_code = 200 and coalesce(w.content, '') <> '' then
        body := w.content::jsonb;
        if w.kind = 'search' then
          for ttl in select x ->> 'title' from jsonb_array_elements(coalesce(body -> 'query' -> 'search', '[]'::jsonb)) x limit 10
          loop
            if exists (select 1 from tour_find_wiki q where q.artist_id = a_id and q.title = left(ttl, 200))
               or exists (select 1 from tour_find_pages g where g.artist_id = a_id and g.source = 'wikipedia' and g.title = left(ttl, 200)) then continue; end if;
            if ttl ~* '\mtour' then
              -- A tour article: its date table lives in the wikitext (plain extracts drop tables).
              rid := net.http_get(url := 'https://en.wikipedia.org/w/api.php',
                params := jsonb_build_object('action', 'parse', 'page', ttl, 'prop', 'wikitext', 'format', 'json'),
                headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 20000);
              insert into tour_find_wiki (artist_id, request_id, kind, title) values (a_id, rid, 'page_wt', left(ttl, 200));
            else
              rid := net.http_get(url := 'https://en.wikipedia.org/w/api.php',
                params := jsonb_build_object('action', 'query', 'prop', 'extracts', 'explaintext', '1', 'format', 'json', 'titles', ttl),
                headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 20000);
              insert into tour_find_wiki (artist_id, request_id, kind, title) values (a_id, rid, 'page', left(ttl, 200));
            end if;
          end loop;
          update tour_finds set wiki = 'pages' where artist_id = a_id;
        else
          if w.kind = 'page_wt' then
            about := public.tour_find_wikicut(body -> 'parse' -> 'wikitext' ->> '*', nm);
          else
            select p.value into pg from jsonb_each(coalesce(body -> 'query' -> 'pages', '{}'::jsonb)) p limit 1;
            about := public.tour_find_about(pg ->> 'extract', nm);
          end if;
          if about <> '' then
            insert into tour_find_pages (artist_id, url, source, title, published, body, fetched)
            values (a_id, left('https://en.wikipedia.org/wiki/' || replace(w.title, ' ', '_'), 300), 'wikipedia', w.title, null, about, true)
            on conflict (artist_id, url) do update set body = excluded.body, read_at = null;
            insert into tour_find_batches (artist_id, urls) values (a_id, jsonb_build_array(left('https://en.wikipedia.org/wiki/' || replace(w.title, ' ', '_'), 300)));
          end if;
        end if;
      end if;
    exception when others then
      null; -- Wikipedia is a bonus; the archives carry the day.
    end;
    delete from tour_find_wiki where artist_id = a_id and request_id = w.request_id;
  end loop;
  delete from tour_find_wiki where artist_id = a_id and fired_at < now() - interval '3 minutes';
  if f.wiki in ('searching', 'pages') and not exists (select 1 from tour_find_wiki q where q.artist_id = a_id) then
    update tour_finds set wiki = 'done' where artist_id = a_id;
    f.wiki := 'done';
  end if;

  -- Answers that came back.
  bad4 := 0;
  for b in select q.*, resp.status_code, resp.content, resp.timed_out
             from tour_find_batches q join net._http_response resp on resp.id = q.request_id
            where q.artist_id = a_id and q.status = 'asked'
  loop
    if b.status_code = 200 then
      begin
        body := b.content::jsonb;
        stop := coalesce(body ->> 'stop_reason', '');
        if stop = 'refusal' then raise exception 'refused'; end if;
        select coalesce(string_agg(x ->> 'text', '' order by o.ord), '') into txt
          from jsonb_array_elements(coalesce(body -> 'content', '[]'::jsonb)) with ordinality as o(x, ord) where x ->> 'type' = 'text';
        txt := regexp_replace(regexp_replace(btrim(txt), '^```(?:json)?\s*', ''), '```\s*$', '');
        a := position('[' in txt);
        z := case when position(']' in reverse(txt)) > 0 then length(txt) - position(']' in reverse(txt)) + 1 else 0 end;
        if a = 0 or z <= a then raise exception 'no array'; end if;
        items := substr(txt, a, z - a + 1)::jsonb;
        if jsonb_typeof(items) <> 'array' then raise exception 'no array'; end if;
        update tour_find_batches set status = 'done', found = items, error = '' where id = b.id;
        update tour_find_pages g set read_at = now() where g.artist_id = a_id and b.urls ? g.url;
      exception when others then
        if stop = 'refusal' then
          -- The reader wouldn't: the article stays unread, nothing else is tried.
          update tour_find_batches set status = 'failed', error = 'refused' where id = b.id;
        elsif jsonb_array_length(b.urls) > 1 then
          -- Cut off, or answered in prose: asked again in two halves, down to one article (no try spent).
          half := ceil(jsonb_array_length(b.urls) / 2.0);
          insert into tour_find_batches (artist_id, urls) values
            (a_id, (select jsonb_agg(u) from jsonb_array_elements(b.urls) with ordinality as t(u, ord) where ord <= half)),
            (a_id, (select jsonb_agg(u) from jsonb_array_elements(b.urls) with ordinality as t(u, ord) where ord > half));
          update tour_find_batches set status = 'split' where id = b.id;
        elsif stop = 'max_tokens' then
          -- One article the reader can't answer for in the room it has: left for the phone or next time.
          update tour_find_batches set status = 'failed', error = 'too long' where id = b.id;
        elsif b.tries + 1 >= 2 then
          -- Twice the reader couldn't make sense of it alone: read, for what it was worth.
          update tour_find_batches set status = 'failed', error = 'unreadable' where id = b.id;
          update tour_find_pages g set read_at = now() where g.artist_id = a_id and b.urls ? g.url;
        else
          update tour_find_batches set status = 'todo', tries = tries + 1, next_at = now() where id = b.id;
        end if;
      end;
    elsif b.status_code is null or b.status_code = 429 or b.status_code = 529 or b.status_code >= 500 then
      -- Busy, slow down, or no answer: the same batch is asked again, a little later each time; then left unread.
      if b.tries + 1 > 4 then
        update tour_find_batches set status = 'failed', error = 'the reader was busy' where id = b.id;
      else
        update tour_find_batches set status = 'todo', tries = tries + 1, next_at = now() + make_interval(secs => 20 * (b.tries + 1)) where id = b.id;
      end if;
    elsif b.status_code in (401, 403) then
      -- The key was turned away: what was read is folded, and the phone reads from here.
      update tour_find_batches set status = 'failed', error = 'bad key' where artist_id = a_id and status in ('todo', 'asked');
      perform public.tour_find_finish(a_id, 'The reading key in Vault was turned away;');
      update tour_finds set brain = 'bad_key', status = 'ready', extracting_at = null where artist_id = a_id;
      return n;
    else
      begin msg := left(coalesce((b.content::jsonb) -> 'error' ->> 'message', ''), 200); exception when others then msg := ''; end;
      if msg ~* 'credit|billing|balance' then
        update tour_find_batches set status = 'failed', error = 'no credit' where artist_id = a_id and status in ('todo', 'asked');
        perform public.tour_find_finish(a_id, 'The reading key is out of credit;');
        update tour_finds set status = 'error', detail = 'The reading key is out of credit. Top it up and try again.' where artist_id = a_id;
        return n;
      end if;
      -- Something about the ask the reader won't take: smaller, then left unread (never marked read).
      bad4 := bad4 + 1;
      if jsonb_array_length(b.urls) > 1 then
        half := ceil(jsonb_array_length(b.urls) / 2.0);
        insert into tour_find_batches (artist_id, urls) values
          (a_id, (select jsonb_agg(u) from jsonb_array_elements(b.urls) with ordinality as t(u, ord) where ord <= half)),
          (a_id, (select jsonb_agg(u) from jsonb_array_elements(b.urls) with ordinality as t(u, ord) where ord > half));
        update tour_find_batches set status = 'split' where id = b.id;
      else
        update tour_find_batches set status = 'failed', error = left('http ' || b.status_code || ' ' || msg, 200) where id = b.id;
      end if;
    end if;
  end loop;
  -- The same refusal three times in a run is the ask itself (a model name, a parameter): the phone finishes, the reason is kept.
  if bad4 >= 1 and (select count(*) from tour_find_batches q where q.artist_id = a_id and q.status = 'failed' and q.error like 'http 4%') >= 3 then
    update tour_find_batches set status = 'failed', error = 'api' where artist_id = a_id and status in ('todo', 'asked');
    perform public.tour_find_finish(a_id, 'The reader turned the asks away (' || coalesce(msg, '') || ');');
    update tour_finds set brain = 'bad_key', status = 'ready', extracting_at = null where artist_id = a_id;
    return n;
  end if;
  -- An ask that never came back (the request itself was lost) is asked again.
  update tour_find_batches set status = 'todo', tries = tries + 1, next_at = now()
   where artist_id = a_id and status = 'asked' and asked_at < now() - interval '4 minutes';
  update tour_find_batches set status = 'failed', error = 'no answer' where artist_id = a_id and status = 'todo' and tries > 4;

  -- One batch at a time, with room for a long answer (the smallest rate limit a key can have counts the room asked for).
  select count(*) into inflight from tour_find_batches where artist_id = a_id and status = 'asked';
  for b in select * from tour_find_batches where artist_id = a_id and status = 'todo' and next_at <= now() order by id limit greatest(0, 1 - inflight)
  loop
    -- The month's ceiling: past it, fold what was read and park until next month (the rest stays unread for then).
    if not public.tour_find_meter_ask(jsonb_array_length(b.urls)) then
      update tour_find_batches set status = 'failed', error = 'budget' where artist_id = a_id and status in ('todo', 'asked');
      perform public.tour_find_finish(a_id, 'This month''s reading budget is used up; the search picks up next month.');
      return n;
    end if;
    rid := net.http_post(url := 'https://api.anthropic.com/v1/messages',
      body := jsonb_build_object('model', public.tour_find_model(), 'max_tokens', 7000,
                'messages', jsonb_build_array(jsonb_build_object('role', 'user', 'content', public.tour_find_prompt(a_id, nm, b.urls)))),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-api-key', key, 'anthropic-version', '2023-06-01'),
      timeout_milliseconds := 170000);
    update tour_find_batches set status = 'asked', asked_at = now(), request_id = rid where id = b.id;
    n := n + 1;
  end loop;

  if f.wiki = 'done' and not exists (select 1 from tour_find_batches q where q.artist_id = a_id and q.status in ('todo', 'asked')) then
    perform public.tour_find_finish(a_id);
  end if;
  update tour_finds set extracting_at = now() where artist_id = a_id and status = 'thinking';
  return n;
end $$;
revoke all on function public.tour_find_brain(uuid) from public, anon, authenticated;

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
         'lineup', coalesce((select c.lineup from tour_candidates c where c.artist_id = a_id and c.status = 'added' and c.lineup <> ''
                               and public.artist_tour_gkey(a_id, c.name) = t.gk order by jsonb_array_length(c.dates) desc limit 1), ''),
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
     and (cf.key_a in (select gk from tera) or cf.key_a in (select gk from tfest))
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

-- Already on the pages: a festival stop's name loses its "– City, ST".
update tour_candidates set name = public.tour_name_clean(name) where name <> public.tour_name_clean(name);
update artist_history_shows set tour = public.tour_name_clean(tour) where tour <> public.tour_name_clean(tour);
update artist_tour_conflicts set name_a = public.tour_name_clean(name_a), name_b = public.tour_name_clean(name_b)
 where name_a <> public.tour_name_clean(name_a) or name_b <> public.tour_name_clean(name_b);

notify pgrst, 'reload schema';
