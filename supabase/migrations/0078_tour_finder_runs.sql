-- The tour finder, second pass (Devin, 2026-10-07: "This process so far isn't
-- as accurate as it needs to be"). Three things:
--  1. A tour's nights can be read by anyone signed in: tap a tour on an
--     artist page and its dates drop down.
--  2. The runs already on the page with no tour name are shown as such — the
--     most reliable list of missing tours is the one setlist.fm already has
--     — and the owner names a run in one go.
--  3. A found tour that is ALREADY named on the page but has more dates in
--     the announcement than the page knows becomes a "fill in" candidate
--     (setlist.fm's counts are fans' logged setlists, not every night).
--     Plus: the Lambgoat read records what the site answered, and retries
--     once with a plainer identity when it was turned away.

-- 1. The nights of one tour, by the sound of its name (how the summary groups them).
create or replace function public.artist_tour_nights(a_id uuid, tour_name text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then null else coalesce((
    select jsonb_agg(jsonb_build_object('date', h.date, 'city', h.city, 'state', h.state, 'country', h.country_code,
                                        'venue', h.venue, 'url', h.url, 'announced', h.pinned)
                     order by h.date)
      from artist_history_shows h
     where h.artist_id = a_id and h.tour <> '' and public.setlist_tour_key(h.tour) = public.setlist_tour_key(tour_name)), '[]'::jsonb) end
$$;
revoke all on function public.artist_tour_nights(uuid, text) from public, anon;
grant execute on function public.artist_tour_nights(uuid, text) to authenticated;

-- 2. Runs with no tour name yet: nights no more than five days apart, three or
-- more of them. The owner sees where each one went and names it.
create or replace function public.tour_find_runs(a_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not public.tour_find_may(a_id) then null else coalesce((
    with n as (select h.date, h.city, h.state, h.country_code, h.venue
                 from artist_history_shows h where h.artist_id = a_id and h.tour = '' and h.date is not null),
    g as (select n.*, case when n.date - lag(n.date) over (order by n.date) > 5 then 1 else 0 end as brk from n),
    r as (select g.*, sum(g.brk) over (order by g.date) as grp from g)
    select jsonb_agg(jsonb_build_object('first', x.first, 'last', x.last, 'n', x.n, 'countries', x.cc, 'nights', x.nights) order by x.first desc)
      from (select min(r.date) as first, max(r.date) as last, count(*) as n,
                   string_agg(distinct r.country_code, ', ') filter (where r.country_code <> '') as cc,
                   jsonb_agg(jsonb_build_object('date', r.date, 'city', r.city, 'state', r.state, 'country', r.country_code, 'venue', r.venue) order by r.date) as nights
              from r group by r.grp having count(*) >= 3) x), '[]'::jsonb) end
$$;
revoke all on function public.tour_find_runs(uuid) from public, anon;
grant execute on function public.tour_find_runs(uuid) to authenticated;

-- Naming a run: it becomes an added candidate of its own (so Take off works
-- the same way), and its nights take the name.
create or replace function public.tour_run_name(a_id uuid, first_day date, last_day date, new_name text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare nm text; cid uuid; ds jsonb;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  nm := left(btrim(regexp_replace(coalesce(new_name, ''), '\s+', ' ', 'g')), 120);
  if char_length(nm) < 2 or first_day is null or last_day is null or last_day < first_day or last_day - first_day > 400 then
    raise exception 'bad input' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('date', h.date, 'city', h.city, 'venue', h.venue) order by h.date), '[]'::jsonb) into ds
    from artist_history_shows h where h.artist_id = a_id and h.tour = '' and h.date between first_day and last_day;
  if jsonb_array_length(ds) = 0 then raise exception 'nothing to name' using errcode = '22023'; end if;
  insert into tour_candidates (artist_id, name, role, first_day, last_day, dates, sources, status, decided_at)
  values (a_id, nm, '', first_day, last_day, ds, '[]'::jsonb, 'added', now()) returning id into cid;
  perform public.tour_find_apply(a_id);
  perform public.setlist_summarize(a_id);
  return public.tour_find_state(a_id) || jsonb_build_object('named', (select count(*) from artist_history_shows h where h.artist_id = a_id and h.named_by = cid));
end $$;
revoke all on function public.tour_run_name(uuid, date, date, text) from public, anon;
grant execute on function public.tour_run_name(uuid, date, date, text) to authenticated;

-- 3. "Fill in" candidates: the tour is on the page already, the announcement
-- knows more of its dates. (tour_find_propose used to skip these.)
alter table public.tour_candidates add column if not exists fill boolean not null default false;
alter table public.tour_finds add column if not exists lg_http int;

create or replace function public.tour_find_propose(a_id uuid, cands jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare c jsonb; nm text; key text; fd date; ld date; n int := 0; ds jsonb; have_name text; missing int;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  if jsonb_typeof(cands) <> 'array' then raise exception 'bad input' using errcode = '22023'; end if;
  for c in select * from jsonb_array_elements(cands) limit 160
  loop
   begin
    nm := left(btrim(regexp_replace(coalesce(c ->> 'name', ''), '\s+', ' ', 'g')), 120);
    if char_length(nm) < 2 then continue; end if;
    fd := case when (c ->> 'start') ~ '^\d{4}-\d{2}-\d{2}$' then (c ->> 'start')::date
               when (c ->> 'start') ~ '^\d{4}-\d{2}$' then ((c ->> 'start') || '-01')::date end;
    ld := case when (c ->> 'end') ~ '^\d{4}-\d{2}-\d{2}$' then (c ->> 'end')::date
               when (c ->> 'end') ~ '^\d{4}-\d{2}$' then (((c ->> 'end') || '-01')::date + interval '1 month' - interval '1 day')::date end;
    if fd is null or ld is null or ld < fd or ld - fd > 400 or fd < date '1980-01-01' or fd > current_date + 400 then continue; end if;
    key := public.setlist_tour_key(nm);
    if exists (select 1 from tour_candidates t where t.artist_id = a_id and public.setlist_tour_key(t.name) = key) then continue; end if;
    select coalesce(jsonb_agg(jsonb_build_object('date', d ->> 'date', 'city', left(coalesce(d ->> 'city', ''), 80), 'venue', left(coalesce(d ->> 'venue', ''), 120))
                    order by d ->> 'date'), '[]'::jsonb) into ds
      from jsonb_array_elements(case when jsonb_typeof(c -> 'dates') = 'array' then c -> 'dates' else '[]'::jsonb end) d
     where (d ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (d ->> 'date')::date between fd - 1 and ld + 1;
    -- Already on the page under this name (give or take spelling)?
    select mode() within group (order by h.tour) into have_name
      from artist_history_shows h where h.artist_id = a_id and h.tour <> '' and public.setlist_tour_key(h.tour) = key;
    if have_name is not null then
      -- Only worth showing when the announcement adds something: a played
      -- night the page lacks, or a night on the page with no tour name that
      -- falls on one of its dates.
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
    -- One bad item is skipped; what tripped it is kept where the owner can't see it but I can.
    update tour_finds set detail = left('Skipped an item: ' || sqlerrm, 160) where artist_id = a_id;
   end;
  end loop;
  update tour_finds set status = 'done', extracting_at = null, finished_at = coalesce(finished_at, now()) where artist_id = a_id and status <> 'error';
  return public.tour_find_state(a_id) || jsonb_build_object('added', n);
end $$;
revoke all on function public.tour_find_propose(uuid, jsonb) from public, anon;
grant execute on function public.tour_find_propose(uuid, jsonb) to authenticated;

-- The state now carries each candidate's fill flag and the unnamed runs.
create or replace function public.tour_find_state(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare f record;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  perform public.tour_find_absorb(a_id);
  perform public.tour_find_fire(a_id);
  select * into f from tour_finds where artist_id = a_id;
  if f.status = 'extracting' and f.extracting_at < now() - interval '5 minutes' then
    update tour_finds set status = 'ready', extracting_at = null where artist_id = a_id;
    f.status := 'ready';
  end if;
  return jsonb_build_object(
    'status', coalesce(f.status, 'idle'),
    'detail', coalesce(f.detail, ''),
    'day', f.day,
    'today', current_date,
    'startedAt', f.started_at,
    'pages', (select count(*) from tour_find_pages g where g.artist_id = a_id and g.fetched and g.body <> ''),
    'waiting', (select count(*) from tour_find_pages g where g.artist_id = a_id and not g.fetched),
    'sources', jsonb_build_object('theprp', case when f.prp_next is null then 'new' when f.prp_next = 0 then 'new' when f.prp_next > 0 then 'reading' else 'done' end,
                                  'lambgoat', coalesce(f.lg_state, 'new'), 'lambgoatHttp', f.lg_http),
    'runs', coalesce(public.tour_find_runs(a_id), '[]'::jsonb),
    'candidates', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'role', c.role, 'first', c.first_day, 'last', c.last_day, 'region', c.region,
        'lineup', c.lineup, 'n', jsonb_array_length(c.dates), 'sources', c.sources, 'status', c.status, 'fill', c.fill,
        'matched', (select count(*) from artist_history_shows h where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date)),
        'have', (select count(*) from artist_history_shows h where h.artist_id = a_id and public.tour_cand_night(c, h.date)),
        'toAdd', (select count(*) from jsonb_array_elements(c.dates) x
                   where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'date')::date <= current_date
                     and not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (x ->> 'date')::date)))
        order by c.status = 'new' desc, c.first_day desc nulls last)
      from tour_candidates c where c.artist_id = a_id), '[]'::jsonb));
end $$;
revoke all on function public.tour_find_state(uuid) from public, anon;
grant execute on function public.tour_find_state(uuid) to authenticated;

-- Lambgoat: remember what it answered; when turned away (403/429/5xx), one
-- more try with a plainer identity before giving up on it.
create or replace function public.tour_find_fire(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare f record; rid bigint; n int := 0; p record;
        ua constant text := 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/; devinoliverofficial@gmail.com)';
        ua2 constant text := 'Mozilla/5.0 (compatible; Greenroom/1.0; +https://devinoliverofficial.github.io/greenroom/)';
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
  if f.prp_next < 0 and f.lg_state in ('done', 'none') then
    update tour_finds set status = 'ready', finished_at = now(),
           detail = case when (select count(*) from tour_find_pages g where g.artist_id = a_id and g.fetched and g.body <> '') = 0
                         then 'No tour announcements found for this name.' else '' end
     where artist_id = a_id;
    return 0;
  end if;
  if f.fired_at is not null and f.fired_at > clock_timestamp() - interval '10 seconds' then return 0; end if;
  if f.prp_next = 0 then
    rid := net.http_get(url := 'https://www.theprp.com/wp-json/wp/v2/tags',
      params := jsonb_build_object('slug', f.slug, '_fields', 'id,count'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 15000);
    insert into tour_find_requests (id, artist_id, kind) values (rid, a_id, 'prp_tag');
    n := 1;
  elsif f.prp_next > 0 then
    rid := net.http_get(url := 'https://www.theprp.com/wp-json/wp/v2/posts',
      params := jsonb_build_object('tags', f.prp_tag::text, 'per_page', '25', 'page', f.prp_next::text, '_fields', 'date,link,title,content'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 20000);
    insert into tour_find_requests (id, artist_id, kind, meta) values (rid, a_id, 'prp_posts', jsonb_build_object('page', f.prp_next));
    n := 1;
  elsif f.lg_state in ('new', 'retry') then
    rid := net.http_get(url := 'https://lambgoat.com/music/' || f.slug || '/',
      headers := jsonb_build_object('User-Agent', case when f.lg_state = 'retry' then ua2 else ua end, 'Accept', 'text/html'), timeout_milliseconds := 15000);
    insert into tour_find_requests (id, artist_id, kind) values (rid, a_id, 'lg_list');
    n := 1;
  elsif f.lg_state = 'listed' then
    for p in select url from tour_find_pages where artist_id = a_id and source = 'lambgoat' and not fetched order by url limit 4
    loop
      rid := net.http_get(url := p.url, headers := jsonb_build_object('User-Agent', case when coalesce(f.lg_http, 200) = 200 then ua else ua2 end, 'Accept', 'text/html'), timeout_milliseconds := 15000);
      insert into tour_find_requests (id, artist_id, kind, url) values (rid, a_id, 'lg_article', p.url);
      n := n + 1;
    end loop;
  end if;
  if n > 0 then update tour_finds set fired_at = clock_timestamp() where artist_id = a_id; end if;
  return n;
end $$;
revoke all on function public.tour_find_fire(uuid) from public, anon, authenticated;

create or replace function public.tour_find_absorb(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare r record; body jsonb; took int := 0; nm text; txt text; ttl text; pub date; cnt int; was text;
begin
  select lower(a.name) into nm from artists a where a.id = a_id;
  for r in select q.id, q.kind, q.url, q.meta, resp.status_code, resp.content, resp.timed_out, resp.error_msg
             from tour_find_requests q join net._http_response resp on resp.id = q.id
            where q.artist_id = a_id
  loop
    begin
      if r.kind = 'lg_list' then update tour_finds set lg_http = r.status_code where artist_id = a_id; end if;
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
      elsif r.kind = 'prp_posts' then
        body := case when r.status_code = 200 and coalesce(r.content, '') <> '' then r.content::jsonb else '[]'::jsonb end;
        if jsonb_typeof(body) = 'array' then
          insert into tour_find_pages (artist_id, url, source, title, published, body, fetched)
          select a_id, left(p ->> 'link', 300), 'theprp',
                 left(public.tf_text(coalesce(p -> 'title' ->> 'rendered', '')), 200),
                 case when (p ->> 'date') ~ '^\d{4}-\d{2}-\d{2}' then left(p ->> 'date', 10)::date end,
                 left(public.tf_text(coalesce(p -> 'content' ->> 'rendered', '')), 9000),
                 true
            from jsonb_array_elements(body) p
           where coalesce(p ->> 'link', '') <> ''
          on conflict (artist_id, url) do nothing;
        end if;
        update tour_finds set prp_next = case when r.status_code <> 200 or jsonb_typeof(body) <> 'array' or jsonb_array_length(body) < 25
                                              or (r.meta ->> 'page')::int >= prp_pages then -1 else (r.meta ->> 'page')::int + 1 end
         where artist_id = a_id;
      elsif r.kind = 'lg_list' then
        if r.status_code <> 200 then
          -- Turned away: once more with a plainer identity, then let it go.
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
      if r.kind = 'lg_list' then update tour_finds set lg_state = 'none' where artist_id = a_id; end if;
    end;
    delete from tour_find_requests where id = r.id;
    took := took + 1;
  end loop;
  delete from tour_find_requests where artist_id = a_id and fired_at < now() - interval '1 hour';
  return took;
end $$;
revoke all on function public.tour_find_absorb(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
