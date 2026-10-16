-- THE GENRE PIPELINE (Devin: tour history for the genres the rock press
-- misses). The finder reads rock and punk archives; an electronic act, a
-- rapper or a country band gets next to nothing from them. Two additions,
-- nothing else:
--  1. Five genre-press sites join the WordPress list: Dancing Astronaut
--     (electronic), HipHopDX (hip hop), Saving Country Music, Country Now
--     and Whiskey Riff (country). Checked 2026-10-16: each answers the same
--     WordPress tag API the current sites do. Checked the same day and left
--     out the way Kerrang! and Metal Injection were: Mixmag, DJ Mag, Complex,
--     XXL and Taste of Country refuse or lack the API.
--  2. MixesDB (www.mixesdb.com), the one open archive of DJ sets — a
--     MediaWiki, not WordPress, licensed CC BY-SA 3.0 (storing and showing
--     with attribution is allowed). Its page titles ARE the data: each one
--     reads 'YYYY-MM-DD - Artist @ Event, Venue, City', so the finder asks
--     its search for the act's titles and stores each answer page as one
--     finder page the reading brain reads like any press page. The brain's
--     brief learns how DJ shows are counted, Devin's rule first: one show
--     per club per night.
-- When no new source answers for an act, the read ends exactly as it does
-- today: the same pages, the same candidates, the same page.

-- 1. The WordPress list grows by the five genre sites. The fourteen already
-- there (0080, grown in 0091 and 0105) stay exactly as they are.
create or replace function public.tour_find_hosts()
returns text[]
language sql immutable as $$
  select array['www.altpress.com', 'www.brooklynvegan.com', 'newnoisemagazine.com', 'idobi.com', 'www.rocksound.tv',
               'distortedsoundmag.com', 'www.ghostcultmag.com', 'bringthenoiseuk.com',
               'alreadyheard.com', 'www.theaquarian.com', 'www.highlightmagazine.net', 'www.revolvermag.com',
               'musicfeeds.com.au', 'substreammagazine.com',
               'dancingastronaut.com', 'hiphopdx.com', 'www.savingcountrymusic.com', 'countrynow.com', 'www.whiskeyriff.com']
$$;
revoke all on function public.tour_find_hosts() from public, anon, authenticated;

-- Reads already running get the new sources now; everyone else gets them on
-- their next search (the same way 0105 handed its sites out).
insert into public.tour_find_sources (artist_id, host)
select f.artist_id, h
  from public.tour_finds f,
       unnest(array['dancingastronaut.com', 'hiphopdx.com', 'www.savingcountrymusic.com', 'countrynow.com', 'www.whiskeyriff.com', 'www.mixesdb.com']) h
 where f.status = 'reading'
on conflict do nothing;

-- 2. MixesDB's state: a tour_find_sources row with host 'www.mixesdb.com',
-- not new columns on tour_finds. The sources table already carries exactly
-- what this source needs — paging (next/pages), the answer's HTTP status,
-- the let-go on a site that won't answer, and the finished gate in
-- tour_find_fire that waits while any row still has next >= 0 — where
-- Lambgoat-style columns would mean four new ones and a second gate. It is
-- not a WordPress host, so it is seeded here, never in tour_find_hosts(),
-- and tour_find_fire gives it its own branch below. There is no tag step:
-- a new read always searches from the top (next = 0), and pages already
-- stored are re-read, not re-made (they keep their key).
create or replace function public.tour_find_begin(a_id uuid, who uuid, by_itself boolean default false)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare nm text; sl text; hst text;
begin
  select a.name into nm from artists a where a.id = a_id;
  sl := btrim(regexp_replace(lower(coalesce(nm, '')), '[^a-z0-9]+', '-', 'g'), '-');
  delete from tour_find_requests where artist_id = a_id;
  delete from tour_find_batches where artist_id = a_id;
  delete from tour_find_wiki where artist_id = a_id;
  insert into tour_finds (artist_id, owner_id, status, detail, slug, prp_tag, prp_pages, prp_next, lg_state, tries, fired_at, started_at, finished_at, day, auto)
  values (a_id, who, 'reading', '', sl, null, 0, 0, 'new', 0, null, now(), null, current_date, by_itself)
  on conflict (artist_id) do update
    set owner_id = excluded.owner_id, status = 'reading', detail = '', slug = excluded.slug,
        prp_next = case when tour_finds.prp_tag is not null then 1 else 0 end, prp_pages = greatest(tour_finds.prp_pages, 1),
        lg_state = 'new', tries = 0, fired_at = null, started_at = now(), finished_at = null, day = current_date, extracting_at = null,
        wiki = 'new', brain = '', unread = 0, auto = excluded.auto;
  foreach hst in array public.tour_find_hosts() loop
    insert into tour_find_sources (artist_id, host) values (a_id, hst)
    on conflict (artist_id, host) do update set next = case when tour_find_sources.tag is not null then 1 else 0 end, pages = greatest(tour_find_sources.pages, 1);
  end loop;
  -- MixesDB: the same row shape, its own branch in tour_find_fire.
  insert into tour_find_sources (artist_id, host) values (a_id, 'www.mixesdb.com')
  on conflict (artist_id, host) do update set next = 0, pages = greatest(tour_find_sources.pages, 1);
end $$;
revoke all on function public.tour_find_begin(uuid, uuid, boolean) from public, anon, authenticated;

-- 3. Firing (the 0084 rounds, two changes): the WordPress loop skips the
-- MixesDB row, and MixesDB gets one search request per round — the shared
-- pace gate (one round of requests per ten seconds, and no new round while
-- any request is in flight) means it never has more than one request in
-- flight per artist, like every other source. The ask is the MediaWiki
-- search API: titles containing '<name> @', fifty a page, paged with
-- sroffset while hits remain, capped the way ThePRP pages are capped.
create or replace function public.tour_find_fire(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare f record; src record; mx record; rid bigint; n int := 0; p record; aft text; prm jsonb; anm text;
        ua constant text := 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/; devinoliverofficial@gmail.com)';
begin
  select * into f from tour_finds where artist_id = a_id and status = 'reading';
  if not found then return 0; end if;
  if exists (select 1 from tour_find_requests r where r.artist_id = a_id) then return 0; end if;
  if f.slug = '' then
    update tour_finds set status = 'ready', detail = 'No tour announcements to read for this name.', finished_at = now() where artist_id = a_id;
    return 0;
  end if;
  if f.lg_state = 'listed' and not exists (select 1 from tour_find_pages g where g.artist_id = a_id and g.source = 'lambgoat' and not g.fetched) then
    update tour_finds set lg_state = 'done' where artist_id = a_id;
    f.lg_state := 'done';
  end if;
  if f.prp_next < 0 and f.lg_state in ('done', 'none')
     and not exists (select 1 from tour_find_sources s where s.artist_id = a_id and s.next >= 0) then
    update tour_finds set status = 'ready', finished_at = now(),
           detail = case when (select count(*) from tour_find_pages g where g.artist_id = a_id and g.fetched and g.body <> '') = 0
                         then 'No tour announcements found for this name.' else '' end
     where artist_id = a_id;
    return 0;
  end if;
  if f.fired_at is not null and f.fired_at > clock_timestamp() - interval '10 seconds' then return 0; end if;

  -- ThePRP: one request this round.
  if f.prp_next = 0 then
    rid := net.http_get(url := 'https://www.theprp.com/wp-json/wp/v2/tags',
      params := jsonb_build_object('slug', f.slug, '_fields', 'id,count'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 15000);
    insert into tour_find_requests (id, artist_id, kind) values (rid, a_id, 'prp_tag');
    n := n + 1;
  elsif f.prp_next > 0 then
    aft := public.tour_find_after(a_id, 'theprp');
    prm := jsonb_build_object('tags', f.prp_tag::text, 'per_page', '25', 'page', f.prp_next::text, '_fields', 'date,link,title,content');
    if aft is not null then prm := prm || jsonb_build_object('after', aft); end if;
    rid := net.http_get(url := 'https://www.theprp.com/wp-json/wp/v2/posts', params := prm,
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 20000);
    insert into tour_find_requests (id, artist_id, kind, meta) values (rid, a_id, 'prp_posts', jsonb_build_object('page', f.prp_next));
    n := n + 1;
  end if;

  -- Up to three other sites this round, one request each. (MixesDB is in the
  -- same table but is not WordPress: its own branch below asks it.)
  for src in select * from tour_find_sources s where s.artist_id = a_id and s.next >= 0 and s.host <> 'www.mixesdb.com' order by s.host limit 3
  loop
    if src.next = 0 then
      rid := net.http_get(url := 'https://' || src.host || '/wp-json/wp/v2/tags',
        params := jsonb_build_object('search', replace(f.slug, '-', ' '), 'per_page', '20', '_fields', 'id,slug,count'),
        headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 15000);
      insert into tour_find_requests (id, artist_id, kind, meta) values (rid, a_id, 'wp_tag', jsonb_build_object('host', src.host));
    else
      aft := public.tour_find_after(a_id, src.host);
      prm := jsonb_build_object('tags', src.tag::text, 'per_page', '25', 'page', src.next::text, '_fields', 'date,link,title,content');
      if aft is not null then prm := prm || jsonb_build_object('after', aft); end if;
      rid := net.http_get(url := 'https://' || src.host || '/wp-json/wp/v2/posts', params := prm,
        headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 20000);
      insert into tour_find_requests (id, artist_id, kind, meta) values (rid, a_id, 'wp_posts', jsonb_build_object('host', src.host, 'page', src.next));
    end if;
    n := n + 1;
  end loop;

  -- Lambgoat: its listing, or up to four of its articles, this round. (No headers: it refuses ours.)
  if f.lg_state in ('new', 'retry') then
    rid := net.http_get(url := 'https://lambgoat.com/music/' || f.slug || '/', timeout_milliseconds := 15000);
    insert into tour_find_requests (id, artist_id, kind) values (rid, a_id, 'lg_list');
    n := n + 1;
  elsif f.lg_state = 'listed' then
    for p in select url from tour_find_pages where artist_id = a_id and source = 'lambgoat' and not fetched order by url limit 4
    loop
      rid := net.http_get(url := p.url, timeout_milliseconds := 15000);
      insert into tour_find_requests (id, artist_id, kind, url) values (rid, a_id, 'lg_article', p.url);
      n := n + 1;
    end loop;
  end if;

  -- MixesDB: one search page this round. The phrase is the act's NAME (the
  -- titles write it as the act does), with quotes and backslashes stripped so
  -- a name can't break the phrase; a name that strips to nothing is let go.
  select * into mx from tour_find_sources s where s.artist_id = a_id and s.host = 'www.mixesdb.com' and s.next >= 0;
  if found then
    select btrim(replace(replace(coalesce(a.name, ''), '"', ''), '\', '')) into anm from artists a where a.id = a_id;
    if coalesce(anm, '') = '' then
      update tour_find_sources set next = -1 where artist_id = a_id and host = 'www.mixesdb.com';
    else
      rid := net.http_get(url := 'https://www.mixesdb.com/w/api.php',
        params := jsonb_build_object('action', 'query', 'list', 'search', 'format', 'json',
                                     'srsearch', 'intitle:"' || anm || ' @"',
                                     'srlimit', '50', 'sroffset', ((greatest(mx.next, 1) - 1) * 50)::text),
        headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 20000);
      insert into tour_find_requests (id, artist_id, kind, meta) values (rid, a_id, 'mx_search', jsonb_build_object('host', 'www.mixesdb.com', 'page', greatest(mx.next, 1)));
      n := n + 1;
    end if;
  end if;
  if n > 0 then update tour_finds set fired_at = clock_timestamp() where artist_id = a_id; end if;
  return n;
end $$;
revoke all on function public.tour_find_fire(uuid) from public, anon, authenticated;

-- 4. Absorbing (the 0080 reader, one new kind): an mx_search answer's titles
-- — real set pages only, ns 0 — are stored as ONE finder page whose text is
-- the titles joined as lines, so the 0085 reading brain reads them exactly
-- as it reads a press page. The page's url is the site's own search page
-- for that answer (a real link a person can open), and the brain's brief
-- hands that url on as each candidate's "source": tour_find_propose keeps
-- it on the candidate and tour_find_apply writes it onto every night the
-- owner's yes adds, where the Tours tab already shows a source link per
-- night. That link is what satisfies MixesDB's CC BY-SA attribution —
-- nothing new to draw. (The candidate card itself shows no link before the
-- yes, and the page-level credit line keeps its own list; both are noted
-- for the lead rather than invented here.)
create or replace function public.tour_find_absorb(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare r record; body jsonb; took int := 0; nm text; txt text; ttl text; pub date; cnt int; was text; hst text; sl text; tagid int;
        pgno int; tot int; cap int; ttls text;
begin
  select lower(a.name) into nm from artists a where a.id = a_id;
  select slug into sl from tour_finds where artist_id = a_id;
  for r in select q.id, q.kind, q.url, q.meta, resp.status_code, resp.content, resp.timed_out, resp.error_msg
             from tour_find_requests q join net._http_response resp on resp.id = q.id
            where q.artist_id = a_id
  loop
    hst := r.meta ->> 'host';
    begin
      if r.kind = 'lg_list' then update tour_finds set lg_http = r.status_code where artist_id = a_id; end if;
      if r.kind in ('wp_tag', 'wp_posts', 'mx_search') then update tour_find_sources set http = r.status_code where artist_id = a_id and host = hst; end if;
      if r.status_code is null or r.status_code = 429 or r.status_code >= 500 then
        update tour_finds set tries = tries + 1,
               status = case when tries + 1 > 12 then 'error' else status end,
               detail = case when tries + 1 > 12 then 'The news archives aren’t answering right now. Try again later.' else detail end
         where artist_id = a_id;
        if r.kind = 'lg_article' then
          update tour_find_pages set fetched = true, body = '' where artist_id = a_id and url = r.url;
        elsif r.kind = 'lg_list' then
          select lg_state into was from tour_finds where artist_id = a_id;
          update tour_finds set lg_state = case when was = 'new' then 'retry' else 'none' end where artist_id = a_id;
        elsif r.kind in ('wp_tag', 'wp_posts', 'mx_search') then
          -- A site that won't answer is let go, not retried forever.
          update tour_find_sources set next = -1 where artist_id = a_id and host = hst;
        end if;
      elsif r.kind = 'prp_tag' then
        body := case when r.status_code = 200 and coalesce(r.content, '') <> '' then r.content::jsonb else '[]'::jsonb end;
        if jsonb_typeof(body) = 'array' and jsonb_array_length(body) > 0 and (body -> 0 ->> 'id') is not null then
          cnt := coalesce((body -> 0 ->> 'count')::int, 0);
          update tour_finds set prp_tag = (body -> 0 ->> 'id')::int,
                 prp_pages = least(12, ceil(greatest(cnt, 1)::numeric / 25)::int),
                 prp_next = case when cnt > 0 then 1 else -1 end
           where artist_id = a_id;
        else
          update tour_finds set prp_next = -1 where artist_id = a_id;
        end if;
      elsif r.kind = 'wp_tag' then
        body := case when r.status_code = 200 and coalesce(r.content, '') <> '' then r.content::jsonb else '[]'::jsonb end;
        tagid := null; cnt := 0;
        if jsonb_typeof(body) = 'array' then
          select (t ->> 'id')::int, coalesce((t ->> 'count')::int, 0) into tagid, cnt
            from jsonb_array_elements(body) t where t ->> 'slug' = sl limit 1;
        end if;
        update tour_find_sources
           set tag = tagid, pages = least(12, ceil(greatest(cnt, 1)::numeric / 25)::int),
               next = case when tagid is not null and cnt > 0 then 1 else -1 end
         where artist_id = a_id and host = hst;
      elsif r.kind in ('prp_posts', 'wp_posts') then
        body := case when r.status_code = 200 and coalesce(r.content, '') <> '' then r.content::jsonb else '[]'::jsonb end;
        if jsonb_typeof(body) = 'array' then
          insert into tour_find_pages (artist_id, url, source, title, published, body, fetched)
          select a_id, left(p ->> 'link', 300), case when r.kind = 'prp_posts' then 'theprp' else hst end,
                 left(public.tf_text(coalesce(p -> 'title' ->> 'rendered', '')), 200),
                 case when (p ->> 'date') ~ '^\d{4}-\d{2}-\d{2}' then left(p ->> 'date', 10)::date end,
                 left(public.tf_text(coalesce(p -> 'content' ->> 'rendered', '')), 9000),
                 true
            from jsonb_array_elements(body) p
           where coalesce(p ->> 'link', '') <> ''
          on conflict (artist_id, url) do nothing;
        end if;
        if r.kind = 'prp_posts' then
          update tour_finds set prp_next = case when r.status_code <> 200 or jsonb_typeof(body) <> 'array' or jsonb_array_length(body) < 25
                                                or (r.meta ->> 'page')::int >= prp_pages then -1 else (r.meta ->> 'page')::int + 1 end
           where artist_id = a_id;
        else
          update tour_find_sources set next = case when r.status_code <> 200 or jsonb_typeof(body) <> 'array' or jsonb_array_length(body) < 25
                                                   or (r.meta ->> 'page')::int >= pages then -1 else (r.meta ->> 'page')::int + 1 end
           where artist_id = a_id and host = hst;
        end if;
      elsif r.kind = 'mx_search' then
        -- One MediaWiki search answer: the titles become one finder page.
        body := case when r.status_code = 200 and coalesce(r.content, '') <> '' then r.content::jsonb else '{}'::jsonb end;
        pgno := greatest(coalesce((r.meta ->> 'page')::int, 1), 1);
        select string_agg(x ->> 'title', E'\n' order by x ->> 'title'), count(*) into ttls, cnt
          from jsonb_array_elements(coalesce(body -> 'query' -> 'search', '[]'::jsonb)) x
         where coalesce((x ->> 'ns')::int, -1) = 0 and coalesce(x ->> 'title', '') <> '';
        if coalesce(cnt, 0) > 0 then
          -- The url is the site's own search page for exactly this answer
          -- (unique per page of titles), so a candidate born from it carries
          -- a real link; a rescan re-reads it rather than making another.
          insert into tour_find_pages (artist_id, url, source, title, published, body, fetched)
          values (a_id, left('https://www.mixesdb.com/db/index.php?search=' || replace(sl, '-', '+') || '&offset=' || ((pgno - 1) * 50), 300),
                  'www.mixesdb.com', 'MixesDB set titles, page ' || pgno, null, left(ttls, 9000), true)
          on conflict (artist_id, url) do update set body = excluded.body, read_at = null;
        end if;
        -- Politely capped like ThePRP: at most six pages of fifty titles.
        tot := coalesce((body -> 'query' -> 'searchinfo' ->> 'totalhits')::int, 0);
        cap := least(6, ceil(greatest(tot, 1)::numeric / 50)::int);
        update tour_find_sources
           set pages = cap,
               next = case when (body -> 'continue' ->> 'sroffset') is not null and coalesce(cnt, 0) > 0 and pgno < cap
                           then pgno + 1 else -1 end
         where artist_id = a_id and host = hst;
      elsif r.kind = 'lg_list' then
        if r.status_code <> 200 then
          select lg_state into was from tour_finds where artist_id = a_id;
          update tour_finds set lg_state = case when was = 'new' and r.status_code in (403, 406, 451) then 'retry' else 'none' end where artist_id = a_id;
        else
          insert into tour_find_pages (artist_id, url, source)
          select distinct a_id, 'https://lambgoat.com' || m[1], 'lambgoat'
            from regexp_matches(coalesce(r.content, ''), 'href="(/news/\d+/[a-z0-9-]*/?)"', 'g') m
          on conflict (artist_id, url) do nothing;
          update tour_finds set lg_state = case when exists (select 1 from tour_find_pages g where g.artist_id = a_id and g.source = 'lambgoat') then 'listed' else 'done' end
           where artist_id = a_id;
        end if;
      elsif r.kind = 'lg_article' then
        if r.status_code <> 200 then
          update tour_find_pages set fetched = true, body = '' where artist_id = a_id and url = r.url;
        else
          ttl := public.tf_text((regexp_match(r.content, '<meta property="og:title" content="([^"]*)"'))[1]);
          pub := case when (regexp_match(r.content, '<meta property="article:published_time" content="(\d{4}-\d{2}-\d{2})'))[1] is not null
                      then (regexp_match(r.content, '<meta property="article:published_time" content="(\d{4}-\d{2}-\d{2})'))[1]::date end;
          txt := public.tf_text(r.content);
          if ttl <> '' and position(ttl in txt) > 0 then txt := substr(txt, position(ttl in txt)); end if;
          txt := left(txt, 7000);
          if position(regexp_replace(nm, '[^a-z0-9]+', '', 'g') in regexp_replace(lower(txt), '[^a-z0-9]+', '', 'g')) = 0 then
            delete from tour_find_pages where artist_id = a_id and url = r.url;
          else
            update tour_find_pages set fetched = true, title = left(coalesce(ttl, ''), 200), published = pub, body = txt
             where artist_id = a_id and url = r.url;
          end if;
        end if;
      end if;
    exception when others then
      update tour_finds set tries = tries + 1, detail = left('Reading hiccup: ' || sqlerrm, 160) where artist_id = a_id;
      if r.kind = 'lg_article' then update tour_find_pages set fetched = true, body = '' where artist_id = a_id and url = r.url; end if;
      if r.kind = 'prp_tag' then update tour_finds set prp_next = -1 where artist_id = a_id; end if;
      if r.kind = 'prp_posts' then update tour_finds set prp_next = -1 where artist_id = a_id; end if;
      if r.kind in ('wp_tag', 'wp_posts', 'mx_search') then update tour_find_sources set next = -1 where artist_id = a_id and host = hst; end if;
      if r.kind = 'lg_list' then update tour_finds set lg_state = 'none' where artist_id = a_id; end if;
    end;
    delete from tour_find_requests where id = r.id;
    took := took + 1;
  end loop;
  delete from tour_find_requests where artist_id = a_id and fired_at < now() - interval '1 hour';
  return took;
end $$;
revoke all on function public.tour_find_absorb(uuid) from public, anon, authenticated;

-- 5. The brief learns how DJ shows are counted (the 0117 words, one added
-- sentence where the rules are listed, Devin's saved rule first; nothing
-- else about the brief changes).
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
      || 'DJ shows: one show per club per night — two sets in the same room on one date are ONE show; different venues on one day are different shows; a residency (a named run at one venue) is a tour-shaped entry; radio shows, podcasts and studio streams are never shows (no room, no audience); a www.mixesdb.com title is a dated set at a named place, one per line as "YYYY-MM-DD - Artist @ Event, Venue, City", and a line without a real venue or event after the @ is skipped. '
      || 'An item headed "The band''s own page as captured on <date>" is ' || nm || '''s own list of its shows on that day: return one item per tour name the list itself prints, and ALL its other shows together as ONE item with "name": "" (never make up a name for them); put EVERY show of the list under "dates" with its city and its venue (the venue only: acts after "w/" go in "lineup"); leave out any show the list marks cancelled, postponed or "no longer playing"; take the year from the listing, or from the capture date when it prints none (a list captured in December that says Jan 24 means the next January).' || E'\n\n'
      || coalesce((select string_agg('--- ARTICLE ' || x.n || ' | ' || coalesce(to_char(g.published, 'YYYY-MM-DD'), 'date unknown') || ' | ' || g.url || E'\n'
                                     || case when g.title <> '' then g.title || E'\n' else '' end || g.body || E'\n', E'\n' order by x.n)
                     from jsonb_array_elements_text(urls) with ordinality as x(url, n)
                     join tour_find_pages g on g.artist_id = a_id and g.url = x.url), '')
$$;
revoke all on function public.tour_find_prompt(uuid, text, jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';

-- Rollback: create or replace tour_find_hosts as 0105 wrote it (its fourteen
--           hosts; 0080's original eight were grown by 0091 and 0105, so
--           0080's list alone would lose those too), tour_find_begin as 0090,
--           tour_find_fire as 0084, tour_find_absorb as 0080 and
--           tour_find_prompt as 0117;
--           delete from public.tour_find_requests where kind = 'mx_search';
--           delete from public.tour_find_sources where host in
--             ('www.mixesdb.com', 'dancingastronaut.com', 'hiphopdx.com',
--              'www.savingcountrymusic.com', 'countrynow.com', 'www.whiskeyriff.com');
--           delete from public.tour_find_pages where source in
--             ('www.mixesdb.com', 'dancingastronaut.com', 'hiphopdx.com',
--              'www.savingcountrymusic.com', 'countrynow.com', 'www.whiskeyriff.com');
--           (candidates and nights the owner already said yes to are his
--            decisions and stay; a wrong one comes off the usual way, slid
--            left on the Tours list)
