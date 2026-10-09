-- One bad page never stops the clock (2026-10-09). An old MySpace capture came
-- back in Windows-1252 (a curly apostrophe as the single byte 0x92); the text
-- went into the page store as it was, and the moment the brain tried to send
-- it to the reader the request could not be built ("invalid byte sequence for
-- encoding UTF8"). The error left the clock function, so every artist's search
-- stopped, every fifteen seconds, for twelve minutes, until it was seen.
--  * tf_utf8() makes any fetched text readable: left alone when it is sound,
--    decoded from Windows-1252 (then Latin-1) when it is not.
--  * the Wayback step runs every capture through it, and the brain does the
--    same to the whole ask; an ask that still cannot be sent fails that one
--    batch and nothing else.
--  * the clock runs each page's step on its own: a failure is written on that
--    page's search and the others carry on.

create or replace function public.tf_utf8(t text)
returns text
language plpgsql immutable as $$
begin
  if t is null then return null; end if;
  perform convert_to(t, 'UTF8');
  return t;
exception when others then
  begin
    return convert_from(replace(t, E'\\', E'\\\\')::bytea, 'WIN1252');
  exception when others then
    begin
      return convert_from(replace(t, E'\\', E'\\\\')::bytea, 'LATIN1');
    exception when others then
      return regexp_replace(t, '[^\x09\x0A\x0D\x20-\x7E]', ' ', 'g');
    end;
  end;
end $$;
revoke all on function public.tf_utf8(text) from public, anon, authenticated;

create or replace function public.tour_find_wb_step(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare f record; nm text; mb text; sl text; rid bigint; r record; body jsonb; about text; cut text; orig text; n int := 0; infl int;
        ua constant text := 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/; devinoliverofficial@gmail.com)';
begin
  select t.wb, t.slug into f from tour_finds t where t.artist_id = a_id;
  if not found or coalesce(f.wb, 'off') in ('off', 'done', 'retry') then return 0; end if;
  select ar.name, coalesce(ar.mbid, '') into nm, mb from artists ar where ar.id = a_id;
  sl := replace(coalesce(f.slug, ''), '-', '');

  -- A fresh pass: a fresh list of questions; captures already read stay read, failed ones are tried again.
  if f.wb = 'new' then
    delete from tour_find_wbq where artist_id = a_id;
    update tour_find_wb set state = 'todo', tries = 0, failed = false, next_at = now() where artist_id = a_id and failed;
    if mb <> '' then
      insert into tour_find_wbq (artist_id, kind, target) values (a_id, 'urls', mb);
      update tour_finds set wb = 'urls' where artist_id = a_id;
    else
      insert into tour_find_wbq (artist_id, kind, target, guess, social)
      select a_id, 'cdx', g.target, true, true
        from (values ('myspace.com/' || sl), ('myspace.com/' || sl || 'music'), ('myspace.com/' || sl || 'band'), ('purevolume.com/' || sl)) g(target)
       where sl <> '';
      update tour_finds set wb = 'cdx' where artist_id = a_id;
    end if;
    return 0;
  end if;

  -- 1. Answers: where the band lived online (MusicBrainz), and which captures the Wayback Machine holds.
  for r in select q.kind, q.target, q.guess, q.tries, resp.status_code, resp.content
             from tour_find_wbq q join net._http_response resp on resp.id = q.request_id
            where q.artist_id = a_id and q.state = 'asked'
  loop
    begin
      if r.status_code = 200 and coalesce(r.content, '') <> '' then
        body := r.content::jsonb;
        if r.kind = 'urls' then
          -- MusicBrainz's links (homepage, MySpace, PureVolume, Bandcamp, blog), plus the handles a band of
          -- that name usually had; a guessed page is only read if it names the act.
          insert into tour_find_wbq (artist_id, kind, target, guess, social)
          with rel as (
            select x -> 'url' ->> 'resource' as u, x ->> 'type' as t
              from jsonb_array_elements(coalesce(body -> 'relations', '[]'::jsonb)) x
             where (x -> 'url' ->> 'resource') like 'http%'),
          own as (
            select lower(regexp_replace(regexp_replace(u, '^https?://(www\.)?', ''), '/+$', '')) as target,
                   (u ~* 'myspace|purevolume|bandcamp') as social
              from rel
             where t in ('official homepage', 'myspace', 'purevolume', 'bandcamp', 'blog') or (t = 'social network' and u ~* 'myspace\.com')
             limit 5),
          handles as (
            select distinct q.h from (
              select substring(o.target from 'myspace\.com/([^/?#]+)') as h from own o where o.target like '%myspace.com/%'
              union select sl) q where coalesce(q.h, '') <> ''),
          guesses as (
            select distinct g.target from handles hh
              cross join lateral (values ('myspace.com/' || hh.h), ('myspace.com/' || hh.h || 'music'), ('myspace.com/' || hh.h || 'band'), ('purevolume.com/' || hh.h)) g(target)
             where not exists (select 1 from own o where o.target = g.target))
          select a_id, 'cdx', o.target, false, o.social from own o
          union all
          select a_id, 'cdxp', o.target || p.suffix, false, false from own o cross join (values ('/tour'), ('/shows')) p(suffix) where not o.social
          union all
          select a_id, 'cdx', g.target, true, true from guesses g
          on conflict do nothing;
          update tour_finds set wb = 'cdx' where artist_id = a_id;
        else
          -- The captures of that page.
          insert into tour_find_wb (artist_id, url, snap, guess)
          select a_id, 'https://web.archive.org/web/' || (x ->> 0) || 'id_/' || (x ->> 1), to_date(left(x ->> 0, 8), 'YYYYMMDD'), coalesce(r.guess, false)
            from jsonb_array_elements(case when jsonb_typeof(body) = 'array' then body else '[]'::jsonb end) with ordinality as o(x, ord)
           where o.ord > 1 and jsonb_typeof(x) = 'array' and (x ->> 0) ~ '^\d{14}$' and (x ->> 1) like 'http%'
          on conflict do nothing;
        end if;
        update tour_find_wbq set state = 'done', note = '' where artist_id = a_id and kind = r.kind and target = r.target;
      elsif r.kind <> 'urls' and r.status_code in (403, 404, 451) then
        -- The Wayback Machine holds nothing it may show for that address: answered, nothing there.
        update tour_find_wbq set state = 'done', note = 'http ' || r.status_code where artist_id = a_id and kind = r.kind and target = r.target;
      else
        -- Down, busy or cut off: asked again, a little later each time; five tries, then it waits for the next pass.
        update tour_find_wbq set state = case when tries >= 4 then 'failed' else 'todo' end, tries = tries + 1,
               next_at = now() + make_interval(secs => 60 * (tries + 1)), note = left('http ' || coalesce(r.status_code::text, 'none'), 60)
         where artist_id = a_id and kind = r.kind and target = r.target;
      end if;
    exception when others then
      update tour_find_wbq set state = 'failed', note = left(sqlerrm, 120) where artist_id = a_id and kind = r.kind and target = r.target;
    end;
  end loop;
  update tour_find_wbq set state = case when tries >= 4 then 'failed' else 'todo' end, tries = tries + 1, next_at = now(), note = 'no answer'
   where artist_id = a_id and state = 'asked' and asked_at < now() - interval '90 seconds';
  -- MusicBrainz would not answer: the usual handles are tried anyway.
  if exists (select 1 from tour_find_wbq q where q.artist_id = a_id and q.kind = 'urls' and q.state = 'failed')
     and not exists (select 1 from tour_find_wbq q where q.artist_id = a_id and q.kind <> 'urls') and sl <> '' then
    insert into tour_find_wbq (artist_id, kind, target, guess, social)
    select a_id, 'cdx', g.target, true, true
      from (values ('myspace.com/' || sl), ('myspace.com/' || sl || 'music'), ('myspace.com/' || sl || 'band'), ('purevolume.com/' || sl)) g(target)
    on conflict do nothing;
    update tour_finds set wb = 'cdx' where artist_id = a_id;
  end if;

  -- 2. The next questions, two at a time.
  select count(*) into infl from tour_find_wbq q where q.artist_id = a_id and q.state = 'asked';
  for r in select q.kind, q.target, q.social from tour_find_wbq q
            where q.artist_id = a_id and q.state = 'todo' and q.next_at <= now()
            order by q.tries, q.kind desc, q.target limit greatest(0, 2 - infl)
  loop
    if r.kind = 'urls' then
      if not public.setlist_pace_ok('mb', interval '1100 milliseconds') then continue; end if;
      rid := net.http_get(url := 'https://musicbrainz.org/ws/2/artist/' || r.target,
        params := jsonb_build_object('inc', 'url-rels', 'fmt', 'json'),
        headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 15000);
    else
      rid := net.http_get(url := 'https://web.archive.org/cdx/search/cdx',
        params := jsonb_build_object('url', r.target, 'output', 'json', 'fl', 'timestamp,original', 'filter', 'statuscode:200',
                    -- a MySpace or PureVolume show list changed week to week: every day it was captured;
                    -- an official site's front page and tour pages: once a month
                    'collapse', case when r.social and r.kind = 'cdx' then 'timestamp:8' else 'timestamp:6' end,
                    'from', '2004', 'to', case when r.social and r.target not like '%bandcamp%' then '2013' else '2021' end,
                    'limit', case when r.kind = 'cdxp' then '80' when r.social then '150' else '60' end)
                  || case when r.kind = 'cdxp' then jsonb_build_object('matchType', 'prefix') else '{}'::jsonb end,
        headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 30000);
    end if;
    update tour_find_wbq set state = 'asked', request_id = rid, asked_at = now() where artist_id = a_id and kind = r.kind and target = r.target;
    n := n + 1;
  end loop;

  -- 3. Captures that came back: the part of the page that lists shows, if it lists any.
  for r in select x.url, x.snap, x.guess, resp.status_code, resp.content
             from tour_find_wb x join net._http_response resp on resp.id = x.request_id
            where x.artist_id = a_id and x.state = 'fired'
  loop
    begin
      if r.status_code = 200 and coalesce(r.content, '') <> '' then
        orig := regexp_replace(r.url, '^https://web\.archive\.org/web/\d+id_/', '');
        about := public.tf_text(public.tf_utf8(r.content));
        cut := left(public.tf_wbcut(about), 9000);
        if cut <> ''
           and (not r.guess or position(lower(nm) in lower(about)) > 0)
           and (select count(*) from regexp_matches(cut, '\m(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2}', 'gi')) >= 3
           and not exists (select 1 from tour_find_pages g where g.artist_id = a_id and g.source = 'wayback' and md5(g.body) = md5(cut)) then
          insert into tour_find_pages (artist_id, url, source, title, published, body, fetched)
          values (a_id, left(r.url, 300), 'wayback', left('The band''s own page as captured on ' || r.snap || ': ' || orig, 200), r.snap, cut, true)
          on conflict (artist_id, url) do update set body = excluded.body, read_at = null;
          insert into tour_find_batches (artist_id, urls) values (a_id, jsonb_build_array(left(r.url, 300)));
        end if;
        update tour_find_wb set state = 'done', failed = false where artist_id = a_id and url = r.url;
      elsif r.status_code in (403, 404, 410, 451) then
        update tour_find_wb set state = 'done', failed = false where artist_id = a_id and url = r.url;
      else
        update tour_find_wb set state = case when tries >= 2 then 'done' else 'todo' end, failed = (tries >= 2), tries = tries + 1,
               next_at = now() + make_interval(secs => 90 * (tries + 1))
         where artist_id = a_id and url = r.url;
      end if;
    exception when others then
      update tour_find_wb set state = 'done', failed = true where artist_id = a_id and url = r.url;
    end;
  end loop;
  update tour_find_wb set state = case when tries >= 2 then 'done' else 'todo' end, failed = (tries >= 2), tries = tries + 1, next_at = now()
   where artist_id = a_id and state = 'fired' and fired_at < now() - interval '2 minutes';

  -- 4. The next captures, four in flight at most.
  select count(*) into infl from tour_find_wb x where x.artist_id = a_id and x.state = 'fired';
  for r in select x.url from tour_find_wb x
            where x.artist_id = a_id and x.state = 'todo' and x.next_at <= now()
            order by x.snap, x.url limit greatest(0, 4 - infl)
  loop
    rid := net.http_get(url := r.url, headers := jsonb_build_object('User-Agent', ua, 'Accept', 'text/html'), timeout_milliseconds := 30000);
    update tour_find_wb set state = 'fired', request_id = rid, fired_at = now() where artist_id = a_id and url = r.url;
    n := n + 1;
  end loop;

  -- 5. Done when nothing is waiting; "retry" when the Wayback Machine left something unanswered.
  if not exists (select 1 from tour_find_wbq q where q.artist_id = a_id and q.state in ('todo', 'asked'))
     and not exists (select 1 from tour_find_wb x where x.artist_id = a_id and x.state in ('todo', 'fired')) then
    update tour_finds set wb = case when exists (select 1 from tour_find_wbq q where q.artist_id = a_id and q.state = 'failed' and q.kind <> 'urls')
                                     or exists (select 1 from tour_find_wb x where x.artist_id = a_id and x.failed)
                                    then 'retry' else 'done' end
     where artist_id = a_id;
  elsif exists (select 1 from tour_find_wb x where x.artist_id = a_id and x.state in ('todo', 'fired')) then
    update tour_finds set wb = 'pages' where artist_id = a_id and wb <> 'pages';
  end if;
  return n;
end $$;
revoke all on function public.tour_find_wb_step(uuid) from public, anon, authenticated;

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

  -- The band's own pages, out of the Wayback Machine (its own step: it asks, waits, and tries again).
  n := n + public.tour_find_wb_step(a_id);
  select t.wb into f.wb from tour_finds t where t.artist_id = a_id;

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
        -- What one capture of the band's own page listed is kept: its last list before a show decides later.
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
    begin
      rid := net.http_post(url := 'https://api.anthropic.com/v1/messages',
        body := jsonb_build_object('model', public.tour_find_model(), 'max_tokens', 7000,
                  'messages', jsonb_build_array(jsonb_build_object('role', 'user', 'content', public.tf_utf8(public.tour_find_prompt(a_id, nm, b.urls))))),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-api-key', key, 'anthropic-version', '2023-06-01'),
        timeout_milliseconds := 170000);
      update tour_find_batches set status = 'asked', asked_at = now(), request_id = rid where id = b.id;
      n := n + 1;
    exception when others then
      -- A page that cannot even be sent (text in an encoding nothing reads) is left unread; it never stops the rest.
      update tour_find_batches set status = 'failed', error = left('could not be sent: ' || sqlerrm, 200) where id = b.id;
    end;
  end loop;

  if f.wiki = 'done' and coalesce(f.wb, 'off') in ('done', 'off', 'retry') and not exists (select 1 from tour_find_batches q where q.artist_id = a_id and q.status in ('todo', 'asked')) then
    perform public.tour_find_finish(a_id);
  end if;
  update tour_finds set extracting_at = now() where artist_id = a_id and status = 'thinking';
  return n;
end $$;
revoke all on function public.tour_find_brain(uuid) from public, anon, authenticated;

create or replace function public.tour_find_tick()
returns int
language plpgsql volatile security definer set search_path = public as $$
declare f record; n int := 0; nxt uuid; who uuid;
begin
  for f in select artist_id from tour_finds where status = 'reading' and started_at > now() - interval '2 hours'
  loop
    begin
      perform public.tour_find_absorb(f.artist_id);
      n := n + public.tour_find_fire(f.artist_id);
    exception when others then
      update tour_finds set detail = left('Reading step failed: ' || sqlerrm, 200) where artist_id = f.artist_id;
    end;
  end loop;
  for f in select artist_id from tour_finds where status in ('ready', 'thinking') and started_at > now() - interval '3 hours'
  loop
    -- One page's trouble never stops the others: the error is kept on that page's search and the clock moves on.
    begin
      n := n + public.tour_find_brain(f.artist_id);
    exception when others then
      update tour_finds set detail = left('Search step failed: ' || sqlerrm, 200) where artist_id = f.artist_id;
    end;
  end loop;
  update tour_finds set status = 'error', detail = 'Reading took too long. Try again.'
   where status = 'reading' and started_at <= now() - interval '2 hours';
  for f in select artist_id from tour_finds where status = 'thinking' and started_at <= now() - interval '3 hours'
  loop
    perform public.tour_find_finish(f.artist_id, 'Stopped after three hours;');
  end loop;
  -- The Wayback Machine was down for part of a search: the band's own pages are tried again a few
  -- hours on (six times at most), one page at a time, while nothing else is reading.
  if public.tour_find_key() is not null
     and not exists (select 1 from tour_finds t where t.status in ('reading', 'ready', 'thinking', 'extracting') and t.started_at > now() - interval '3 hours') then
    select t.artist_id into nxt from tour_finds t
     where t.status = 'done' and t.wb = 'retry' and t.wb_tries < 6 and t.finished_at < now() - interval '2 hours'
     order by t.finished_at limit 1;
    if nxt is not null then
      update tour_finds set status = 'thinking', wiki = 'done', wb = 'new', wb_tries = wb_tries + 1,
             extracting_at = now(), started_at = now(), finished_at = null
       where artist_id = nxt;
      n := n + 1;
      nxt := null;
    end if;
  end if;
  if public.tour_find_key() is not null
     and (select count(*) from tour_finds t where t.auto and t.started_at > now() - interval '24 hours') < 10
     and not exists (select 1 from tour_finds t where t.status in ('reading', 'ready', 'thinking', 'extracting') and t.started_at > now() - interval '3 hours') then
    nxt := public.tour_find_next_auto();
    if nxt is not null then
      -- The page's owner, else whoever made it, else the house.
      select coalesce(a.owner_id, a.created_by, (select p.user_id from platform_admins p limit 1)) into who from artists a where a.id = nxt;
      if who is not null then
        perform public.tour_find_begin(nxt, who, true);
        n := n + 1;
      end if;
    end if;
  end if;
  if to_char(now(), 'HH24:MI') = '06:10' and extract(second from now()) < 15 then
    for f in select distinct artist_id from tour_candidates where status = 'added' loop
      perform public.tour_find_apply(f.artist_id);
      perform public.setlist_summarize(f.artist_id);
    end loop;
  end if;
  return n;
end $$;
revoke all on function public.tour_find_tick() from public, anon, authenticated;

-- The captures already stored.
update public.tour_find_pages set body = public.tf_utf8(body), title = public.tf_utf8(title) where source = 'wayback';

notify pgrst, 'reload schema';
