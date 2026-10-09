-- The band's own pages, read with care (2026-10-09). The first run of the Wayback
-- pass (Sleeping With Sirens) showed what to tighten before it runs for everyone:
--  * the reader named plain show lists itself ("Winter 2010 run with ...",
--    "Saskatoon show with Haste The Day"), and each became a tour on the page.
--    A name is now kept only when the band's page prints it; the rest of a list
--    lands as plain nights.
--  * MusicBrainz knows one MySpace address per band; I See Stars had two. The
--    usual handles are tried too ("<name>", "<name>music", "<name>band", and
--    PureVolume), and a guessed page is only read if it names the act.
--  * new-MySpace captures (after 2013) carry no show lists and wasted asks.
--  * what each capture listed is kept, so the band's last list before a show
--    decides: a show the band took off its own list is removed, one that moved
--    city is moved, and one show printed on two neighbouring days is one show.
--    Every removal and move is written to a log, and nothing the owner has
--    settled is touched.
--  * a date a list could not have meant (more than a month before the capture,
--    its year printed nowhere on the page) is not taken.

alter table public.tour_find_wb add column if not exists dates jsonb not null default '[]'::jsonb;
alter table public.tour_find_wb add column if not exists read boolean not null default false;
alter table public.tour_find_wb add column if not exists guess boolean not null default false;

create table if not exists public.tour_find_wb_log (
  id bigserial primary key,
  artist_id uuid not null references public.artists (id) on delete cascade,
  date date not null,
  what text not null,          -- dropped | moved
  was text not null default '',
  now_is text not null default '',
  because text not null default '',
  at timestamptz not null default now()
);
alter table public.tour_find_wb_log enable row level security;
revoke all on public.tour_find_wb_log from public, anon, authenticated;

create or replace function public.tour_find_prompt(a_id uuid, nm text, urls jsonb)
returns text
language sql stable security definer set search_path = public as $$
  select 'TOUR FINDER. You are helping a touring app list the tours of the act "' || nm || '". Below are news articles and encyclopedia passages, each with its date and URL. '
      || 'Return ONLY a JSON array. Each item is one tour or run that ' || nm || ' was part of: a headline or co-headline tour, a support slot on another act’s tour, or a package/festival tour (Warped, Taste of Chaos). '
      || 'Fields: "name" (the announced tour name; if the run had no name, a short description such as "Fall 2018 run with Dance Gavin Dance"), '
      || '"role" (one of headline, co-headline, support, festival), "start" and "end" (YYYY-MM-DD; when a listing gives month/day only, take the year from the article date, and remember a run announced in the fall may start the next year), '
      || '"lineup" (the other acts, comma separated), "region" (US, UK/Europe, Australia, Japan, Canada…), '
      || '"dates" (every date listed for ' || nm || ', each as one short string "YYYY-MM-DD | City, ST | Venue"; an empty array if none are listed), "source" (the article URL). '
      || 'Rules: only runs ' || nm || ' is on; a festival appearance is one item named "<Festival> <year>" with ONLY the date(s) and city ' || nm || ' plays — never the other cities or days of that festival; skip anything that is not a show (album news, videos, members leaving); when a later article updates an earlier one (dates added, moved or cancelled) fold them into one item; never invent dates; if nothing qualifies return []. '
      || 'An item headed "The band''s own page as captured on <date>" is ' || nm || '''s own list of its shows on that day: return one item per tour name the list itself prints, and ALL its other shows together as ONE item with "name": "" (never make up a name for them); put EVERY show of the list under "dates" with its city and its venue (the venue only: acts after "w/" go in "lineup"); take the year from the listing, or from the capture date when it prints none (a list captured in December that says Jan 24 means the next January).' || E'\n\n'
      || coalesce((select string_agg('--- ARTICLE ' || x.n || ' | ' || coalesce(to_char(g.published, 'YYYY-MM-DD'), 'date unknown') || ' | ' || g.url || E'\n'
                                     || case when g.title <> '' then g.title || E'\n' else '' end || g.body || E'\n', E'\n' order by x.n)
                     from jsonb_array_elements_text(urls) with ordinality as x(url, n)
                     join tour_find_pages g on g.artist_id = a_id and g.url = x.url), '')
$$;
revoke all on function public.tour_find_prompt(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.tour_find_wb_settle(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare r record; dropped int := 0; moved int := 0; cc text;
begin
  create temp table if not exists twb (orig text, snap date, d date, city text, venue text) on commit drop;
  truncate twb;
  -- What each capture of each of the band's pages listed (a list of coming shows: nothing before the capture counts).
  insert into twb
  select lower(regexp_replace(regexp_replace(x.url, '^https://web\.archive\.org/web/\d+(id_)?/', ''), '^https?://(www\.)?|:80|/+$', '', 'g')),
         x.snap, (e ->> 'date')::date, coalesce(e ->> 'city', ''), coalesce(e ->> 'venue', '')
    from tour_find_wb x, jsonb_array_elements(x.dates) e
   where x.artist_id = a_id and x.read and x.snap is not null and (e ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
     and (e ->> 'date')::date >= x.snap - 1 and (e ->> 'date')::date <= x.snap + 500;
  if not exists (select 1 from twb) then return jsonb_build_object('dropped', 0, 'moved', 0); end if;
  create temp table if not exists tcap (orig text, snap date, lo date, hi date) on commit drop;
  truncate tcap;
  insert into tcap select t.orig, t.snap, min(t.d), max(t.d) from twb t group by t.orig, t.snap;

  -- 1. A show the band listed, then took off: its last list before that day covers the day and no
  -- longer has it (and no other page of the band's still does). Only a night that came from the
  -- band's own pages; never one the owner has settled.
  for r in
    select h.id, h.date, h.city, h.venue
      from artist_history_shows h
     where h.artist_id = a_id and h.pinned and h.url like 'https://web.archive.org/web/%'
       and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = h.date)
       and exists (
         select 1 from tcap c
          where c.snap <= h.date and c.lo <= h.date and c.hi >= h.date
            and c.snap = (select max(c2.snap) from tcap c2 where c2.orig = c.orig and c2.snap <= h.date and c2.lo <= h.date and c2.hi >= h.date)
            and not exists (select 1 from twb t where t.orig = c.orig and t.snap = c.snap and t.d = h.date)
            and exists (select 1 from twb t where t.orig = c.orig and t.snap < c.snap and t.d = h.date))
       and not exists (
         select 1 from tcap c
          where c.snap <= h.date and c.lo <= h.date and c.hi >= h.date
            and c.snap = (select max(c2.snap) from tcap c2 where c2.orig = c.orig and c2.snap <= h.date and c2.lo <= h.date and c2.hi >= h.date)
            and exists (select 1 from twb t where t.orig = c.orig and t.snap = c.snap and t.d = h.date))
  loop
    insert into tour_find_wb_log (artist_id, date, what, was, now_is, because)
    values (a_id, r.date, 'dropped', r.city || ' / ' || r.venue, '', 'the band''s own later list covers that day and no longer has it');
    delete from artist_history_shows where artist_id = a_id and id = r.id;
    update tour_candidates set dates = coalesce((select jsonb_agg(x) from jsonb_array_elements(dates) x where x ->> 'date' <> to_char(r.date, 'YYYY-MM-DD')), '[]'::jsonb)
     where artist_id = a_id and jsonb_typeof(dates) = 'array' and dates @> jsonb_build_array(jsonb_build_object('date', to_char(r.date, 'YYYY-MM-DD')));
    dropped := dropped + 1;
  end loop;

  -- 2. A show that moved to another city: the band's last list before the day says where.
  for r in
    select h.id, h.date, h.city, h.venue, h.country_code, l.city as c2, l.venue as v2
      from artist_history_shows h
      join lateral (select t.city, t.venue from twb t where t.d = h.date and t.snap <= h.date and t.city <> '' order by t.snap desc limit 1) l on true
     where h.artist_id = a_id and h.pinned and h.url like 'https://web.archive.org/web/%'
       and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = h.date)
       and lower(btrim(split_part(l.city, ',', 1))) <> lower(btrim(h.city))
       and btrim(split_part(l.city, ',', 1)) <> ''
  loop
    cc := coalesce(public.road_country(r.c2), '');
    if cc <> '' and cc <> coalesce(r.country_code, '') then continue; end if;
    insert into tour_find_wb_log (artist_id, date, what, was, now_is, because)
    values (a_id, r.date, 'moved', r.city || ' / ' || r.venue, r.c2 || ' / ' || r.v2, 'the band''s last list before the day has it there');
    update artist_history_shows
       set city = left(btrim(split_part(r.c2, ',', 1)), 80),
           state = case when coalesce(r.country_code, '') in ('US', 'CA') then left(btrim(split_part(r.c2, ',', 2)), 80) else state end,
           venue = case when r.v2 <> '' then left(r.v2, 120) else venue end
     where artist_id = a_id and id = r.id;
    moved := moved + 1;
  end loop;

  -- 3. One show listed on two neighbouring days (an announcement said the 4th, the band's own page
  -- said the 3rd): the band's latest list covering both days has only one of them; the other goes,
  -- if it is older word than that list and is not setlist.fm's.
  for r in
    select b.id, b.date, b.city, b.venue
      from artist_history_shows a
      join artist_history_shows b on b.artist_id = a.artist_id and abs(b.date - a.date) = 1 and lower(b.city) = lower(a.city) and b.city <> ''
     where a.artist_id = a_id and b.pinned
       and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = b.date)
       and exists (
         select 1 from tcap c
          where c.snap <= least(a.date, b.date) and c.lo <= least(a.date, b.date) and c.hi >= greatest(a.date, b.date)
            and c.snap = (select max(c2.snap) from tcap c2 where c2.snap <= least(a.date, b.date) and c2.lo <= least(a.date, b.date) and c2.hi >= greatest(a.date, b.date))
            and exists (select 1 from twb t where t.orig = c.orig and t.snap = c.snap and t.d = a.date)
            and not exists (select 1 from twb t where t.orig = c.orig and t.snap = c.snap and t.d = b.date)
            and coalesce(to_date(substring(b.url from '^https://web\.archive\.org/web/(\d{8})'), 'YYYYMMDD'),
                         (select g.published from tour_find_pages g where g.artist_id = a_id and g.url = b.url limit 1),
                         date '1900-01-01') < c.snap)
  loop
    insert into tour_find_wb_log (artist_id, date, what, was, now_is, because)
    values (a_id, r.date, 'dropped', r.city || ' / ' || r.venue, '', 'the same show a day apart: the band''s own later list has the other day');
    delete from artist_history_shows where artist_id = a_id and id = r.id;
    update tour_candidates set dates = coalesce((select jsonb_agg(x) from jsonb_array_elements(dates) x where x ->> 'date' <> to_char(r.date, 'YYYY-MM-DD')), '[]'::jsonb)
     where artist_id = a_id and jsonb_typeof(dates) = 'array' and dates @> jsonb_build_array(jsonb_build_object('date', to_char(r.date, 'YYYY-MM-DD')));
    dropped := dropped + 1;
  end loop;

  if dropped + moved > 0 then perform public.setlist_summarize(a_id); end if;
  return jsonb_build_object('dropped', dropped, 'moved', moved);
end $$;
revoke all on function public.tour_find_wb_settle(uuid) from public, anon, authenticated;

create or replace function public.tour_find_finish(a_id uuid, stopped text default null)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare items jsonb; named jsonb; loose jsonb; merged jsonb; n int; k int; arts int; v_unread int; i int; st jsonb;
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
                                      and ((z.d ->> 'date')::date >= wb.snap - 31 or position(left(z.d ->> 'date', 4) in wb.body) > 0)))), '[]'::jsonb))
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
  st := public.tour_find_wb_settle(a_id);
  update tour_finds set status = 'done', extracting_at = null, finished_at = now(), unread = v_unread,
         detail = coalesce(stopped || ' ', '') || 'Read ' || arts || ' articles: ' || (jsonb_array_length(merged) + jsonb_array_length(loose)) || ' tours and show lists found, ' || n || ' new, ' || k || ' added to the page'
                  || case when (st ->> 'dropped')::int + (st ->> 'moved')::int > 0
                          then ', ' || (st ->> 'dropped') || ' nights the band later took off its own list removed, ' || (st ->> 'moved') || ' moved' else '' end
                  || case when v_unread > 0 then ', ' || v_unread || ' articles still to read' else '' end
   where artist_id = a_id;
  delete from tour_find_batches where artist_id = a_id;
end $$;
revoke all on function public.tour_find_finish(uuid, text) from public, anon, authenticated;

create or replace function public.tour_find_brain(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare f record; key text; nm text; b record; w record; body jsonb; txt text; a int; z int; items jsonb; half int; n int := 0;
        inflight int; rid bigint; msg text; about text; ttl text; pg jsonb; stop text; bad4 int;
        mb text; cdx text; orig text; snap date; cut text; p record;
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
    update tour_finds set status = 'thinking', extracting_at = now(), wiki = 'new', wb = 'new', unread = 0 where artist_id = a_id;
    f.status := 'thinking'; f.wiki := 'new'; f.wb := 'new';
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
      if w.kind = 'wb_page' then
        -- One capture of the band's own page: the part that lists shows, if it lists any.
        orig := regexp_replace(w.title, '^https://web\.archive\.org/web/\d+id_/', '');
        snap := to_date(substring(w.title from '/web/(\d{8})'), 'YYYYMMDD');
        if w.status_code = 200 and coalesce(w.content, '') <> '' then
          about := public.tf_text(w.content);
          cut := left(public.tf_wbcut(about), 9000);
          if cut <> ''
             and (not coalesce((select x.guess from tour_find_wb x where x.artist_id = a_id and x.url = w.title), false)
                  or position(lower(nm) in lower(about)) > 0)
             and (select count(*) from regexp_matches(cut, '\m(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2}', 'gi')) >= 3
             and not exists (select 1 from tour_find_pages g where g.artist_id = a_id and g.source = 'wayback' and md5(g.body) = md5(cut)) then
            insert into tour_find_pages (artist_id, url, source, title, published, body, fetched)
            values (a_id, left(w.title, 300), 'wayback', left('The band''s own page as captured on ' || snap || ': ' || orig, 200), snap, cut, true)
            on conflict (artist_id, url) do update set body = excluded.body, read_at = null;
            insert into tour_find_batches (artist_id, urls) values (a_id, jsonb_build_array(left(w.title, 300)));
          end if;
        end if;
        update tour_find_wb set state = 'done' where artist_id = a_id and url = w.title;
      elsif w.status_code = 200 and coalesce(w.content, '') <> '' then
        body := w.content::jsonb;
        if w.kind = 'wb_urls' then
          -- Where the band lived online: MusicBrainz's links (homepage, MySpace, PureVolume, Bandcamp,
          -- blog), plus the handles a band of that name usually had (MySpace "<name>", "<name>music",
          -- "<name>band", PureVolume "<name>"). A guessed page is only read if it names the act.
          for p in
            with rel as (
              select x -> 'url' ->> 'resource' as u, x ->> 'type' as t
                from jsonb_array_elements(coalesce(body -> 'relations', '[]'::jsonb)) x
               where (x -> 'url' ->> 'resource') like 'http%'),
            own as (
              select lower(regexp_replace(regexp_replace(u, '^https?://(www\.)?', ''), '/+$', '')) as target, false as guess,
                     (u ~* 'myspace|purevolume|bandcamp') as social
                from rel
               where t in ('official homepage', 'myspace', 'purevolume', 'bandcamp', 'blog') or (t = 'social network' and u ~* 'myspace\.com')
               limit 5),
            handles as (
              select distinct q.h from (
                select substring(o.target from 'myspace\.com/([^/?#]+)') as h from own o where o.target like '%myspace.com/%'
                union select replace(f.slug, '-', '')) q where coalesce(q.h, '') <> ''),
            guesses as (
              select distinct g.target from handles hh
                cross join lateral (values ('myspace.com/' || hh.h), ('myspace.com/' || hh.h || 'music'), ('myspace.com/' || hh.h || 'band'), ('purevolume.com/' || hh.h)) g(target)
               where not exists (select 1 from own o where o.target = g.target))
            select o.target, o.guess, o.social from own o
            union all
            select g.target, true, true from guesses g
            limit 14
          loop
            rid := net.http_get(url := 'https://web.archive.org/cdx/search/cdx',
              params := jsonb_build_object('url', p.target, 'output', 'json', 'fl', 'timestamp,original', 'filter', 'statuscode:200',
                                           'collapse', case when p.social then 'timestamp:6' else 'timestamp:5' end,
                                           'from', '2004', 'to', case when p.social and p.target not like '%bandcamp%' then '2013' else '2021' end,
                                           'limit', case when p.social then '90' else '40' end),
              headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 25000);
            insert into tour_find_wiki (artist_id, request_id, kind, title) values (a_id, rid, case when p.guess then 'wb_cdxg' else 'wb_cdx' end, left(p.target, 200));
            if not p.social then
              -- an official site's tour pages, whatever they were called
              rid := net.http_get(url := 'https://web.archive.org/cdx/search/cdx',
                params := jsonb_build_object('url', p.target || '/tour', 'matchType', 'prefix', 'output', 'json', 'fl', 'timestamp,original',
                                             'filter', 'statuscode:200', 'collapse', 'timestamp:6', 'from', '2004', 'to', '2021', 'limit', '60'),
                headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 25000);
              insert into tour_find_wiki (artist_id, request_id, kind, title) values (a_id, rid, 'wb_cdx', left(p.target || '/tour', 200));
              rid := net.http_get(url := 'https://web.archive.org/cdx/search/cdx',
                params := jsonb_build_object('url', p.target || '/shows', 'matchType', 'prefix', 'output', 'json', 'fl', 'timestamp,original',
                                             'filter', 'statuscode:200', 'collapse', 'timestamp:6', 'from', '2004', 'to', '2021', 'limit', '40'),
                headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 25000);
              insert into tour_find_wiki (artist_id, request_id, kind, title) values (a_id, rid, 'wb_cdx', left(p.target || '/shows', 200));
            end if;
          end loop;
          update tour_finds set wb = 'cdx' where artist_id = a_id;
        elsif w.kind in ('wb_cdx', 'wb_cdxg') then
          -- The Wayback Machine's captures of that page, one a month at most.
          insert into tour_find_wb (artist_id, url, snap, guess)
          select a_id, 'https://web.archive.org/web/' || (x ->> 0) || 'id_/' || (x ->> 1), to_date(left(x ->> 0, 8), 'YYYYMMDD'), w.kind = 'wb_cdxg'
            from jsonb_array_elements(case when jsonb_typeof(body) = 'array' then body else '[]'::jsonb end) with ordinality as o(x, ord)
           where ord > 1 and jsonb_typeof(x) = 'array' and (x ->> 0) ~ '^\d{14}$' and (x ->> 1) like 'http%'
          on conflict do nothing;
          update tour_finds set wb = 'pages' where artist_id = a_id;
        elsif w.kind = 'search' then
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
  update tour_find_wb set state = 'done' where artist_id = a_id and state = 'fired'
     and url in (select q.title from tour_find_wiki q where q.artist_id = a_id and q.kind = 'wb_page' and q.fired_at < now() - interval '3 minutes');
  delete from tour_find_wiki where artist_id = a_id and fired_at < now() - interval '3 minutes';
  if f.wiki in ('searching', 'pages') and not exists (select 1 from tour_find_wiki q where q.artist_id = a_id and q.kind not like 'wb\_%') then
    update tour_finds set wiki = 'done' where artist_id = a_id;
    f.wiki := 'done';
  end if;

  -- The band's own pages (the richest source there is for a band's early years): MusicBrainz says
  -- where the band lived online, the Wayback Machine lists its monthly captures, and the brain
  -- reads them a few at a time, each as "the band's own page as captured on <date>".
  if f.wb = 'new' then
    select ar.mbid into mb from artists ar where ar.id = a_id;
    if coalesce(mb, '') = '' then
      update tour_finds set wb = 'done' where artist_id = a_id;
    elsif public.setlist_pace_ok('mb', interval '1100 milliseconds') then
      rid := net.http_get(url := 'https://musicbrainz.org/ws/2/artist/' || mb,
        params := jsonb_build_object('inc', 'url-rels', 'fmt', 'json'),
        headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 15000);
      insert into tour_find_wiki (artist_id, request_id, kind) values (a_id, rid, 'wb_urls');
      update tour_finds set wb = 'urls' where artist_id = a_id;
    end if;
  elsif f.wb in ('urls', 'cdx') and not exists (select 1 from tour_find_wiki q where q.artist_id = a_id and q.kind in ('wb_urls', 'wb_cdx', 'wb_cdxg')) then
    update tour_finds set wb = case when exists (select 1 from tour_find_wb x where x.artist_id = a_id and x.state = 'todo') then 'pages' else 'done' end
     where artist_id = a_id;
  elsif f.wb = 'pages' and not exists (select 1 from tour_find_wiki q where q.artist_id = a_id and q.kind = 'wb_page') then
    for p in select x.url from tour_find_wb x where x.artist_id = a_id and x.state = 'todo' order by x.snap limit 4
    loop
      rid := net.http_get(url := p.url, headers := jsonb_build_object('User-Agent', ua, 'Accept', 'text/html'), timeout_milliseconds := 25000);
      insert into tour_find_wiki (artist_id, request_id, kind, title) values (a_id, rid, 'wb_page', p.url);
      update tour_find_wb set state = 'fired' where artist_id = a_id and url = p.url;
    end loop;
    if not exists (select 1 from tour_find_wb x where x.artist_id = a_id and x.state in ('todo', 'fired')) then
      update tour_finds set wb = 'done' where artist_id = a_id;
    end if;
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
        if jsonb_array_length(b.urls) = 1 and (b.urls ->> 0) like 'https://web.archive.org/web/%' then
          update tour_find_wb x set read = true, dates = coalesce((
              select jsonb_agg(q.d order by q.d ->> 'date') from (
                select distinct on (z.d ->> 'date') z.d
                  from jsonb_array_elements(items) it
                  cross join lateral jsonb_array_elements(case when jsonb_typeof(it -> 'dates') = 'array' then it -> 'dates' else '[]'::jsonb end) raw
                  cross join lateral (select public.tour_find_date(raw) as d) z
                 where z.d is not null
                 order by z.d ->> 'date') q), '[]'::jsonb)
           where x.artist_id = a_id and x.url = b.urls ->> 0;
        end if;
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

  if f.wiki = 'done' and f.wb in ('done', 'off') and not exists (select 1 from tour_find_batches q where q.artist_id = a_id and q.status in ('todo', 'asked')) then
    perform public.tour_find_finish(a_id);
  end if;
  update tour_finds set extracting_at = now() where artist_id = a_id and status = 'thinking';
  return n;
end $$;
revoke all on function public.tour_find_brain(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
