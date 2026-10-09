-- The band's own pages, read by the finder for every artist (Devin, 2026-10-09:
-- replicate the I See Stars search for other artists when their page is made).
-- Reading I See Stars' MySpace "Upcoming Shows" lists out of the Wayback Machine
-- was the richest source of the day: 128 nights for 2007-2011 that no press or
-- setlist site had. It was done by hand. Now the brain does it for every page:
-- MusicBrainz says where the band lived online (homepage, MySpace, PureVolume,
-- Bandcamp, blog), the Wayback Machine's CDX index lists one capture a month of
-- each (and of an official site's tour pages), and each capture's show list is
-- read as "the band's own page as captured on <date>", so a later capture
-- updates an earlier one the way a later article does. Four captures are
-- fetched at a time, a few seconds apart; captures that list no dates are
-- skipped before any reading is spent. The search finishes only when these
-- pages are read too, and the page credits the Wayback Machine.

alter table public.tour_finds add column if not exists wb text not null default 'off';

create table if not exists public.tour_find_wb (
  artist_id uuid not null references public.artists (id) on delete cascade,
  url text not null,
  snap date,
  state text not null default 'todo',   -- todo | fired | done
  primary key (artist_id, url)
);
alter table public.tour_find_wb enable row level security;
revoke all on public.tour_find_wb from public, anon, authenticated;

-- The part of a page that lists shows: from its "Upcoming Shows" / "Tour Dates" heading on, if it has one.
create or replace function public.tf_wbcut(txt text)
returns text
language plpgsql immutable as $$
declare t text := coalesce(txt, ''); lab text; p int := 0;
begin
  if t = '' then return ''; end if;
  foreach lab in array array['upcoming shows', 'tour dates', 'shows', 'tourdates', 'dates', 'events', 'gigs', 'live dates', 'on tour']
  loop
    p := position(lab in lower(t));
    if p > 0 then exit; end if;
  end loop;
  if p = 0 then p := 1; end if;
  return substr(t, greatest(1, p - 120), 9000);
end $$;
revoke all on function public.tf_wbcut(text) from public, anon, authenticated;

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
          cut := public.tf_wbcut(public.tf_text(w.content));
          if cut <> '' and (lower(cut) like '%' || lower(nm) || '%' or lower(orig) like '%myspace.com%') then
            if (select count(*) from regexp_matches(cut, '\m(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2}', 'gi')) >= 3 then
              insert into tour_find_pages (artist_id, url, source, title, published, body, fetched)
              values (a_id, left(w.title, 300), 'wayback', left('The band''s own page as captured on ' || snap || ': ' || orig, 200), snap, left(cut, 9000), true)
              on conflict (artist_id, url) do update set body = excluded.body, read_at = null;
              insert into tour_find_batches (artist_id, urls) values (a_id, jsonb_build_array(left(w.title, 300)));
            end if;
          end if;
        end if;
        update tour_find_wb set state = 'done' where artist_id = a_id and url = w.title;
      elsif w.status_code = 200 and coalesce(w.content, '') <> '' then
        body := w.content::jsonb;
        if w.kind = 'wb_urls' then
          -- Where the band lived online, from MusicBrainz: homepage, MySpace, PureVolume, Bandcamp, blog.
          for ttl in
            select x -> 'url' ->> 'resource'
              from jsonb_array_elements(coalesce(body -> 'relations', '[]'::jsonb)) x
             where (x -> 'url' ->> 'resource') like 'http%'
               and (x ->> 'type' in ('official homepage', 'myspace', 'purevolume', 'bandcamp', 'blog')
                    or (x ->> 'type' = 'social network' and (x -> 'url' ->> 'resource') ~* 'myspace\.com'))
             limit 5
          loop
            cdx := regexp_replace(regexp_replace(ttl, '^https?://(www\.)?', ''), '/+$', '');
            rid := net.http_get(url := 'https://web.archive.org/cdx/search/cdx',
              params := jsonb_build_object('url', cdx, 'output', 'json', 'fl', 'timestamp,original', 'filter', 'statuscode:200',
                                           'collapse', 'timestamp:6', 'from', '2004', 'to', '2021', 'limit', '60'),
              headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 25000);
            insert into tour_find_wiki (artist_id, request_id, kind, title) values (a_id, rid, 'wb_cdx', left(cdx, 200));
            if ttl !~* 'myspace|purevolume|bandcamp' then
              -- an official site's tour pages, whatever they were called
              rid := net.http_get(url := 'https://web.archive.org/cdx/search/cdx',
                params := jsonb_build_object('url', cdx || '/tour', 'matchType', 'prefix', 'output', 'json', 'fl', 'timestamp,original',
                                             'filter', 'statuscode:200', 'collapse', 'timestamp:6', 'from', '2004', 'to', '2021', 'limit', '40'),
                headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 25000);
              insert into tour_find_wiki (artist_id, request_id, kind, title) values (a_id, rid, 'wb_cdx', left(cdx || '/tour', 200));
            end if;
          end loop;
          update tour_finds set wb = 'cdx' where artist_id = a_id;
        elsif w.kind = 'wb_cdx' then
          -- The Wayback Machine's captures of that page, one a month at most.
          insert into tour_find_wb (artist_id, url, snap)
          select a_id, 'https://web.archive.org/web/' || (x ->> 0) || 'id_/' || (x ->> 1), to_date(left(x ->> 0, 8), 'YYYYMMDD')
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
  elsif f.wb in ('urls', 'cdx') and not exists (select 1 from tour_find_wiki q where q.artist_id = a_id and q.kind in ('wb_urls', 'wb_cdx')) then
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
       where x.host is not null and x.host in ('concertarchives.org', 'songkick.com', 'bandsintown.com', 'web.archive.org')), '[]'::jsonb)
   where ah.artist_id = a_id;
  perform public.festival_tag(a_id);
  return n;
end $$;
revoke all on function public.tour_find_apply(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
