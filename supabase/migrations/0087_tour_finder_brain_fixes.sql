-- Review of the server-side reader (0085), 2026-10-08. Nine things, all found
-- by reading the code before the reading key exists:
--  1. One brain per artist at a time: the phone's poll and the fifteen-second
--     tick could both run it and ask the same batch twice (double spend).
--  2. An article is marked read only when it was read (an answer parsed), or
--     when the reader twice couldn't make sense of it alone. Busy, no answer,
--     a cut-off answer, an unexplained 4xx: it stays unread for next time.
--  3. A cut-off answer (stop_reason max_tokens) splits the batch without
--     spending a try; a refusal leaves the article alone.
--  4. An unexplained 4xx three times in a run turns the server reader off for
--     that run (the phone finishes), with the reason kept.
--  5. One batch in flight, 7000 tokens of room, four articles a batch: inside
--     the smallest rate limit a key can have.
--  6. Autofill wants proof: a night already on the page inside the find, more
--     dates for a tour already named, or at least two listed dates. A find
--     with no dates, or one the owner took off, is never added by itself.
--  7. Take off sticks: an auto-added tour taken off is 'no', not 'new'.
--     Adding one side of a tie sends the other side away.
--  8. A poster or pasted page proposed while the server is reading no longer
--     ends the server's read.
--  9. A read stopped early (three hours, no credit, bad key) folds what it
--     had before it stops; nothing paid for is thrown away.

-- 5. Smaller batches.
create or replace function public.tour_find_batch(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare p record; cur jsonb := '[]'::jsonb; size int := 0; n int := 0; len int;
begin
  for p in select g.url, length(g.body) as len from tour_find_pages g
            where g.artist_id = a_id and g.fetched and g.body <> '' and g.read_at is null
              and not exists (select 1 from tour_find_batches b where b.artist_id = a_id and b.status in ('todo', 'asked') and b.urls ? g.url)
            order by g.published nulls last, g.url
  loop
    len := p.len + 200;
    if jsonb_array_length(cur) > 0 and (size + len > 8000 or jsonb_array_length(cur) >= 4) then
      insert into tour_find_batches (artist_id, urls) values (a_id, cur);
      n := n + 1; cur := '[]'::jsonb; size := 0;
    end if;
    cur := cur || to_jsonb(p.url); size := size + len;
  end loop;
  if jsonb_array_length(cur) > 0 then
    insert into tour_find_batches (artist_id, urls) values (a_id, cur);
    n := n + 1;
  end if;
  return n;
end $$;
revoke all on function public.tour_find_batch(uuid) from public, anon, authenticated;

-- 6. Autofill with proof.
create or replace function public.tour_find_autofill(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; k int := 0; useful boolean; tie boolean;
begin
  for c in select * from tour_candidates where artist_id = a_id and status = 'new' and not auto and first_day is not null and last_day is not null order by first_day, id
  loop
    useful := c.fill
      or exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date))
      or (jsonb_array_length(c.dates) >= 2
          and exists (select 1 from jsonb_array_elements(c.dates) x
                       where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'date')::date <= current_date
                         and not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (x ->> 'date')::date)));
    if not useful then continue; end if;
    tie := exists (select 1 from tour_candidates o
                    where o.artist_id = a_id and o.status = 'new' and o.id <> c.id
                      and o.first_day is not null and o.last_day is not null
                      and o.first_day <= c.last_day + 1 and c.first_day <= o.last_day + 1
                      and (exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.tour = ''
                                     and public.tour_cand_night(c, h.date) and public.tour_cand_night(o, h.date))
                           or exists (select 1 from jsonb_array_elements(c.dates) x join jsonb_array_elements(o.dates) y on x ->> 'date' = y ->> 'date')));
    if tie then continue; end if;
    update tour_candidates set status = 'added', decided_at = now(), auto = true where id = c.id;
    k := k + 1;
  end loop;
  if k > 0 then
    perform public.tour_find_apply(a_id);
    perform public.setlist_summarize(a_id);
  end if;
  return k;
end $$;
revoke all on function public.tour_find_autofill(uuid) from public, anon, authenticated;

-- 7. Take off sticks; adding one side of a tie sends the other away.
create or replace function public.tour_candidate_undo(c_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare c record;
begin
  select * into c from tour_candidates where id = c_id;
  if not found or not public.tour_find_may(c.artist_id) then raise exception 'permission' using errcode = '42501'; end if;
  -- Added by itself and taken off: the owner has said no. Added by hand: back to the list.
  update tour_candidates set status = case when auto then 'no' else 'new' end, decided_at = case when auto then now() else null end where id = c_id;
  update artist_history_shows set tour = '', named_by = null where artist_id = c.artist_id and named_by = c_id and not pinned;
  delete from artist_history_shows where artist_id = c.artist_id and pinned and named_by = c_id;
  perform public.tour_find_apply(c.artist_id);
  perform public.setlist_summarize(c.artist_id);
  return public.tour_find_state(c.artist_id);
end $$;
revoke all on function public.tour_candidate_undo(uuid) from public, anon;
grant execute on function public.tour_candidate_undo(uuid) to authenticated;

create or replace function public.tour_candidate_decide(c_id uuid, add boolean, new_name text default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; nm text; rivals uuid[];
begin
  select * into c from tour_candidates where id = c_id;
  if not found or not public.tour_find_may(c.artist_id) then raise exception 'permission' using errcode = '42501'; end if;
  if add then
    nm := left(btrim(regexp_replace(coalesce(new_name, ''), '\s+', ' ', 'g')), 120);
    -- The other finds that wanted these same nights, noted before the nights take a name.
    select coalesce(array_agg(o.id), '{}'::uuid[]) into rivals from tour_candidates o
     where o.artist_id = c.artist_id and o.status = 'new' and o.id <> c.id
       and o.first_day is not null and o.last_day is not null
       and o.first_day <= c.last_day + 1 and c.first_day <= o.last_day + 1
       and (exists (select 1 from artist_history_shows h where h.artist_id = c.artist_id and h.tour = ''
                      and public.tour_cand_night(c, h.date) and public.tour_cand_night(o, h.date))
            or exists (select 1 from jsonb_array_elements(c.dates) x join jsonb_array_elements(o.dates) y on x ->> 'date' = y ->> 'date'));
    update tour_candidates set status = 'added', decided_at = now(), auto = false, name = case when char_length(nm) >= 2 then nm else name end where id = c_id;
    update tour_candidates set status = 'no', decided_at = now() where id = any (rivals);
    perform public.tour_find_apply(c.artist_id);
    perform public.setlist_summarize(c.artist_id);
    return public.tour_find_state(c.artist_id) || jsonb_build_object(
      'renamed', (select count(*) from artist_history_shows h where h.artist_id = c.artist_id and h.named_by = c_id and not h.pinned),
      'inserted', (select count(*) from artist_history_shows h where h.artist_id = c.artist_id and h.named_by = c_id and h.pinned));
  end if;
  update tour_candidates set status = 'no', decided_at = now() where id = c_id;
  return public.tour_find_state(c.artist_id);
end $$;
revoke all on function public.tour_candidate_decide(uuid, boolean, text) from public, anon;
grant execute on function public.tour_candidate_decide(uuid, boolean, text) to authenticated;

-- 8. A poster or pasted page while the server reads: proposed, not ending the read.
create or replace function public.tour_find_propose(a_id uuid, cands jsonb, read_urls jsonb default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare n int; k int;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  if jsonb_typeof(cands) <> 'array' then raise exception 'bad input' using errcode = '22023'; end if;
  n := public.tour_find_propose_in(a_id, cands);
  if jsonb_typeof(read_urls) = 'array' then
    update tour_find_pages g set read_at = now()
     where g.artist_id = a_id and g.read_at is null and read_urls ? g.url;
  end if;
  k := public.tour_find_autofill(a_id);
  update tour_finds set status = 'done', extracting_at = null, finished_at = coalesce(finished_at, now())
   where artist_id = a_id and status in ('ready', 'extracting', 'done');
  return public.tour_find_state(a_id) || jsonb_build_object('added', n, 'filled', k);
end $$;
revoke all on function public.tour_find_propose(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.tour_find_propose(uuid, jsonb, jsonb) to authenticated;

-- 9. Finishing folds what was read, however the run ended.
drop function if exists public.tour_find_finish(uuid);
create or replace function public.tour_find_finish(a_id uuid, stopped text default null)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare items jsonb; merged jsonb; n int; k int; arts int; v_unread int;
begin
  select coalesce(jsonb_agg(x), '[]'::jsonb) into items
    from tour_find_batches b, jsonb_array_elements(case when jsonb_typeof(b.found) = 'array' then b.found else '[]'::jsonb end) x
   where b.artist_id = a_id and b.status = 'done';
  select coalesce(sum(jsonb_array_length(b.urls)), 0) into arts from tour_find_batches b where b.artist_id = a_id and b.status = 'done';
  -- Articles the reader never answered for (busy, cut off, turned away): unread, and said so.
  select coalesce(sum(jsonb_array_length(b.urls)), 0) into v_unread from tour_find_batches b where b.artist_id = a_id and b.status in ('failed', 'todo', 'asked');
  merged := public.tour_find_merge(items);
  n := public.tour_find_propose_in(a_id, merged);
  k := public.tour_find_autofill(a_id);
  update tour_finds set status = 'done', extracting_at = null, finished_at = now(), unread = v_unread,
         detail = coalesce(stopped || ' ', '') || 'Read ' || arts || ' articles: ' || jsonb_array_length(merged) || ' tours found, ' || n || ' new, ' || k || ' added to the page'
                  || case when v_unread > 0 then ', ' || v_unread || ' articles still to read' else '' end
   where artist_id = a_id;
  delete from tour_find_batches where artist_id = a_id;
end $$;
revoke all on function public.tour_find_finish(uuid, text) from public, anon, authenticated;

-- 1–5. The brain, with the lock, the honest read marks and one ask at a time.
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
    rid := net.http_get(url := 'https://en.wikipedia.org/w/api.php',
      params := jsonb_build_object('action', 'query', 'list', 'search', 'format', 'json', 'srlimit', '6', 'srsearch', '"' || nm || '"'),
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
          for ttl in select x ->> 'title' from jsonb_array_elements(coalesce(body -> 'query' -> 'search', '[]'::jsonb)) x limit 6
          loop
            rid := net.http_get(url := 'https://en.wikipedia.org/w/api.php',
              params := jsonb_build_object('action', 'query', 'prop', 'extracts', 'explaintext', '1', 'format', 'json', 'titles', ttl),
              headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 20000);
            insert into tour_find_wiki (artist_id, request_id, kind, title) values (a_id, rid, 'page', left(ttl, 200));
          end loop;
          update tour_finds set wiki = 'pages' where artist_id = a_id;
        else
          select p.value into pg from jsonb_each(coalesce(body -> 'query' -> 'pages', '{}'::jsonb)) p limit 1;
          about := public.tour_find_about(pg ->> 'extract', nm);
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

-- One ask at a time: the time left says so.
create or replace function public.tour_find_eta(a_id uuid)
returns int
language plpgsql stable security definer set search_path = public as $$
declare f record; rounds int := 0; v_unread int; left_b int; sec int := 0;
begin
  select * into f from tour_finds where artist_id = a_id;
  if not found then return 0; end if;
  select count(*) into v_unread from tour_find_pages g where g.artist_id = a_id and g.fetched and g.body <> '' and g.read_at is null;
  if f.status = 'reading' then
    rounds := ceil((select count(*) from tour_find_pages g where g.artist_id = a_id and not g.fetched) / 4.0)
            + coalesce((select max(greatest(s.pages - s.next + 1, 1)) from tour_find_sources s where s.artist_id = a_id and s.next >= 0), 0)
            + case when f.prp_next > 0 then greatest(f.prp_pages - f.prp_next + 1, 1) when f.prp_next = 0 then 2 else 0 end
            + case when f.lg_state in ('new', 'retry') then 3 else 0 end;
    sec := rounds * 15 + ceil((v_unread + 20) / 4.0) * 25 + 30;
  elsif f.status = 'thinking' then
    select count(*) into left_b from tour_find_batches b where b.artist_id = a_id and b.status in ('todo', 'asked');
    sec := left_b * 25 + case when f.wiki <> 'done' then 20 else 0 end + 10;
  elsif f.status in ('ready', 'extracting') then
    sec := ceil(v_unread / 5.0) * 25 + 10;
  end if;
  return sec;
end $$;
revoke all on function public.tour_find_eta(uuid) from public, anon, authenticated;

-- 9. A read stopped after three hours keeps what it had.
create or replace function public.tour_find_tick()
returns int
language plpgsql volatile security definer set search_path = public as $$
declare f record; n int := 0;
begin
  for f in select artist_id from tour_finds where status = 'reading' and started_at > now() - interval '2 hours'
  loop
    perform public.tour_find_absorb(f.artist_id);
    n := n + public.tour_find_fire(f.artist_id);
  end loop;
  for f in select artist_id from tour_finds where status in ('ready', 'thinking') and started_at > now() - interval '3 hours'
  loop
    n := n + public.tour_find_brain(f.artist_id);
  end loop;
  update tour_finds set status = 'error', detail = 'Reading took too long. Try again.'
   where status = 'reading' and started_at <= now() - interval '2 hours';
  for f in select artist_id from tour_finds where status = 'thinking' and started_at <= now() - interval '3 hours'
  loop
    perform public.tour_find_finish(f.artist_id, 'Stopped after three hours;');
  end loop;
  if to_char(now(), 'HH24:MI') = '06:10' and extract(second from now()) < 15 then
    for f in select distinct artist_id from tour_candidates where status = 'added' loop
      perform public.tour_find_apply(f.artist_id);
      perform public.setlist_summarize(f.artist_id);
    end loop;
  end if;
  return n;
end $$;
revoke all on function public.tour_find_tick() from public, anon, authenticated;

notify pgrst, 'reload schema';
