-- Sustainable reading (Devin, 2026-10-08: "What if a hundred thousand people
-- start using this app"). Two guards on the server's own reading:
--  1. The finder reads with the small, fast model: pulling dates out of a
--     news article doesn't need the biggest brain, and it costs about a
--     fifth as much.
--  2. A meter: the asks the server makes each month are counted, and past a
--     ceiling (tour_find_cap(), 6000 ≈ sixty dollars of the small model) a
--     search folds what it has and parks — "picks up next month" — with its
--     articles left unread for then. No run can spend past the ceiling.

create or replace function public.tour_find_model()
returns text
language sql immutable as $$ select 'claude-haiku-5-5'::text $$;
revoke all on function public.tour_find_model() from public, anon, authenticated;

create or replace function public.tour_find_cap()
returns int
language sql immutable as $$ select 6000 $$;
revoke all on function public.tour_find_cap() from public, anon, authenticated;

create table if not exists public.tour_find_meter (
  month date primary key,
  asks int not null default 0,
  articles int not null default 0
);
alter table public.tour_find_meter enable row level security;
revoke all on public.tour_find_meter from public, anon, authenticated;

-- One more ask this month; false when the ceiling is reached.
create or replace function public.tour_find_meter_ask(n_articles int)
returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare used int;
begin
  insert into tour_find_meter (month) values (date_trunc('month', now())::date) on conflict (month) do nothing;
  select asks into used from tour_find_meter where month = date_trunc('month', now())::date for update;
  if used >= public.tour_find_cap() then return false; end if;
  update tour_find_meter set asks = asks + 1, articles = articles + coalesce(n_articles, 0) where month = date_trunc('month', now())::date;
  return true;
end $$;
revoke all on function public.tour_find_meter_ask(int) from public, anon, authenticated;

-- What the meter says, for the owner's page (admin and page owners).
create or replace function public.tour_find_meter_read()
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'month', to_char(date_trunc('month', now()), 'YYYY-MM'),
    'asks', coalesce((select m.asks from tour_find_meter m where m.month = date_trunc('month', now())::date), 0),
    'articles', coalesce((select m.articles from tour_find_meter m where m.month = date_trunc('month', now())::date), 0),
    'cap', public.tour_find_cap()) end
$$;
revoke all on function public.tour_find_meter_read() from public, anon;
grant execute on function public.tour_find_meter_read() to authenticated;

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

notify pgrst, 'reload schema';
