-- Every article (Devin, 2026-10-08: "we should be finding every flyer, every
-- article, every tour"). ThePRP was one archive; most of the scene's news
-- sites run WordPress and answer the same two questions — "do you have a tag
-- for this band?" and "give me its posts" — so the finder now asks a whole
-- list of them, one page at a time, the same polite way. (Checked 2026-10-08:
-- Alternative Press, BrooklynVegan, New Noise, idobi, Rock Sound, Distorted
-- Sound, Ghost Cult and Bring the Noise all answer; Metal Injection and
-- Kerrang! refuse, and are left out.)

create table if not exists public.tour_find_sources (
  artist_id uuid not null references public.artists (id) on delete cascade,
  host text not null,
  tag int,
  pages int not null default 0,
  next int not null default 0,      -- 0 = tag not looked up; 1.. = next page; -1 = done
  http int,
  primary key (artist_id, host)
);
alter table public.tour_find_sources enable row level security;
revoke all on public.tour_find_sources from public, anon, authenticated;

-- The list. ThePRP stays on its own columns (it already works); these are the rest.
create or replace function public.tour_find_hosts()
returns text[]
language sql immutable as $$
  select array['www.altpress.com', 'www.brooklynvegan.com', 'newnoisemagazine.com', 'idobi.com',
               'www.rocksound.tv', 'distortedsoundmag.com', 'www.ghostcultmag.com', 'bringthenoiseuk.com']
$$;
revoke all on function public.tour_find_hosts() from public, anon, authenticated;

-- Starting a read seeds one row per host.
create or replace function public.tour_find_start(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare f record; nm text; sl text; hst text;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  select * into f from tour_finds where artist_id = a_id;
  if found and f.day = current_date and f.status <> 'error' then return public.tour_find_state(a_id); end if;
  select a.name into nm from artists a where a.id = a_id;
  sl := btrim(regexp_replace(lower(coalesce(nm, '')), '[^a-z0-9]+', '-', 'g'), '-');
  delete from tour_find_requests where artist_id = a_id;
  delete from tour_find_pages where artist_id = a_id;
  delete from tour_find_sources where artist_id = a_id;
  delete from tour_candidates where artist_id = a_id and status = 'new';
  insert into tour_finds (artist_id, owner_id, status, detail, slug, prp_tag, prp_pages, prp_next, lg_state, tries, fired_at, started_at, finished_at, day)
  values (a_id, auth.uid(), 'reading', '', sl, null, 0, 0, 'new', 0, null, now(), null, current_date)
  on conflict (artist_id) do update
    set owner_id = excluded.owner_id, status = 'reading', detail = '', slug = excluded.slug, prp_tag = null, prp_pages = 0,
        prp_next = 0, lg_state = 'new', tries = 0, fired_at = null, started_at = now(), finished_at = null, day = current_date, extracting_at = null;
  foreach hst in array public.tour_find_hosts() loop
    insert into tour_find_sources (artist_id, host) values (a_id, hst) on conflict do nothing;
  end loop;
  return public.tour_find_state(a_id);
end $$;
revoke all on function public.tour_find_start(uuid) from public, anon;
grant execute on function public.tour_find_start(uuid) to authenticated;

-- Firing: ThePRP first, then each other site in turn, then Lambgoat.
create or replace function public.tour_find_fire(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare f record; src record; rid bigint; n int := 0; p record;
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
  select * into src from tour_find_sources s where s.artist_id = a_id and s.next >= 0 order by s.host limit 1;
  if f.prp_next < 0 and f.lg_state in ('done', 'none') and src.host is null then
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
  elsif src.host is not null and src.next = 0 then
    -- Another site: does it have a tag for this band? (Searched by name; the slug has to match exactly.)
    rid := net.http_get(url := 'https://' || src.host || '/wp-json/wp/v2/tags',
      params := jsonb_build_object('search', replace(f.slug, '-', ' '), 'per_page', '20', '_fields', 'id,slug,count'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 15000);
    insert into tour_find_requests (id, artist_id, kind, meta) values (rid, a_id, 'wp_tag', jsonb_build_object('host', src.host));
    n := 1;
  elsif src.host is not null and src.next > 0 then
    rid := net.http_get(url := 'https://' || src.host || '/wp-json/wp/v2/posts',
      params := jsonb_build_object('tags', src.tag::text, 'per_page', '25', 'page', src.next::text, '_fields', 'date,link,title,content'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 20000);
    insert into tour_find_requests (id, artist_id, kind, meta) values (rid, a_id, 'wp_posts', jsonb_build_object('host', src.host, 'page', src.next));
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

-- Absorbing: the two new kinds, beside the old ones.
create or replace function public.tour_find_absorb(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare r record; body jsonb; took int := 0; nm text; txt text; ttl text; pub date; cnt int; was text; hst text; sl text; tagid int;
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
      if r.kind in ('wp_tag', 'wp_posts') then update tour_find_sources set http = r.status_code where artist_id = a_id and host = hst; end if;
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
        elsif r.kind in ('wp_tag', 'wp_posts') then
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
      if r.kind in ('wp_tag', 'wp_posts') then update tour_find_sources set next = -1 where artist_id = a_id and host = hst; end if;
      if r.kind = 'lg_list' then update tour_finds set lg_state = 'none' where artist_id = a_id; end if;
    end;
    delete from tour_find_requests where id = r.id;
    took := took + 1;
  end loop;
  delete from tour_find_requests where artist_id = a_id and fired_at < now() - interval '1 hour';
  return took;
end $$;
revoke all on function public.tour_find_absorb(uuid) from public, anon, authenticated;

-- The state says how many sites answered.
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
                                  'lambgoat', coalesce(f.lg_state, 'new'), 'lambgoatHttp', f.lg_http,
                                  'sites', (select count(*) from tour_find_sources s where s.artist_id = a_id),
                                  'sitesDone', (select count(*) from tour_find_sources s where s.artist_id = a_id and s.next < 0),
                                  'sitesWithNews', (select count(distinct g.source) from tour_find_pages g where g.artist_id = a_id and g.fetched and g.body <> '')),
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

-- Posters the owner hands over are proposals too; their source is the app itself.
-- (tour_find_propose already takes any https source; nothing to change.)

notify pgrst, 'reload schema';
