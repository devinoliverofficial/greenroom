-- ADD MISSING TOURS (Devin, 2026-10-07): "There has to be a bigger more
-- accurate library of tours." There isn't — no database keeps tour names.
-- The names live in tour-announcement news. So Greenroom reads the two
-- archives that carry a page per band (ThePRP, Lambgoat), the app boils the
-- articles down to tours with Greenroom's reading brain, and the artist
-- says yes or no to each one. A yes names the shows setlist.fm left blank
-- and adds the announced dates it never had.

-- 0. Rows the finder adds survive the setlist.fm sync (which prunes what it
-- didn't see) and its names survive the daily re-read (which rewrites tour
-- names from setlist.fm, blank included).
alter table public.artist_history_shows add column if not exists pinned boolean not null default false;
-- Which found tour put a name on a night (so taking that tour off blanks only its own nights).
alter table public.artist_history_shows add column if not exists named_by uuid;

create or replace function public.setlist_take_page(a_id uuid, body jsonb)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int := 0; tot int; ipp int;
begin
  with rows as (
    insert into artist_history_shows (artist_id, id, date, venue, city, state, country_code, country, tour, url, updated)
    select a_id, s ->> 'id',
           case when s ->> 'eventDate' ~ '^\d{2}-\d{2}-\d{4}$' then to_date(s ->> 'eventDate', 'DD-MM-YYYY') end,
           left(coalesce(s -> 'venue' ->> 'name', ''), 120),
           left(coalesce(s -> 'venue' -> 'city' ->> 'name', ''), 80),
           left(coalesce(s -> 'venue' -> 'city' ->> 'state', ''), 80),
           left(coalesce(s -> 'venue' -> 'city' -> 'country' ->> 'code', ''), 8),
           left(coalesce(s -> 'venue' -> 'city' -> 'country' ->> 'name', ''), 80),
           left(coalesce(s -> 'tour' ->> 'name', ''), 120),
           case when coalesce(s ->> 'url', '') like 'https://www.setlist.fm/%' then left(s ->> 'url', 200) else '' end,
           nullif(s ->> 'lastUpdated', '')::timestamptz
      from jsonb_array_elements(coalesce(body -> 'setlist', '[]'::jsonb)) s
     where s ->> 'id' is not null
    on conflict (artist_id, id) do update
      set date = excluded.date, venue = excluded.venue, city = excluded.city,
          state = excluded.state, country_code = excluded.country_code,
          country = excluded.country,
          -- A name the finder put on a night stays unless setlist.fm has one of its own.
          tour = case when excluded.tour <> '' then excluded.tour else artist_history_shows.tour end,
          named_by = case when excluded.tour <> '' then null else artist_history_shows.named_by end,
          url = excluded.url, updated = excluded.updated, seen = now()
    returning 1)
  select coalesce(count(*), 0)::int into n from rows;
  tot := coalesce(nullif(body ->> 'total', '')::int, 0);
  ipp := greatest(coalesce(nullif(body ->> 'itemsPerPage', '')::int, 20), 1);
  update artist_history
     set total = tot,
         pages = ceil(tot::numeric / ipp)::int,
         mb_url = case when mb_url = ''
                        and coalesce(body -> 'setlist' -> 0 -> 'artist' ->> 'url', '') like 'https://www.setlist.fm/%'
                       then left(body -> 'setlist' -> 0 -> 'artist' ->> 'url', 200) else mb_url end
   where artist_id = a_id;
  return n;
end $$;
revoke all on function public.setlist_take_page(uuid, jsonb) from public, anon, authenticated;

-- 1. The finder's own tables. All server-side: the app only ever talks to
-- the functions below.
create table if not exists public.tour_finds (
  artist_id uuid primary key references public.artists (id) on delete cascade,
  owner_id uuid not null,
  status text not null default 'reading',      -- reading | ready | done | error
  detail text not null default '',
  slug text not null default '',
  prp_tag int,                                 -- ThePRP's tag id for the band
  prp_pages int not null default 0,
  prp_next int not null default 0,             -- 0 = tag not looked up; 1.. = next page; -1 = done
  lg_state text not null default 'new',        -- new | listed | done | none
  tries int not null default 0,
  fired_at timestamptz,
  extracting_at timestamptz,                   -- the app is reading the articles (a short lease)
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  day date not null default current_date
);
alter table public.tour_finds enable row level security;
revoke all on public.tour_finds from public, anon, authenticated;

create table if not exists public.tour_find_pages (
  artist_id uuid not null references public.artists (id) on delete cascade,
  url text not null,
  source text not null,                        -- theprp | lambgoat
  title text not null default '',
  published date,
  body text not null default '',
  fetched boolean not null default false,
  primary key (artist_id, url)
);
alter table public.tour_find_pages enable row level security;
revoke all on public.tour_find_pages from public, anon, authenticated;

create table if not exists public.tour_find_requests (
  id bigint primary key,
  artist_id uuid not null,
  kind text not null,                          -- prp_tag | prp_posts | lg_list | lg_article
  url text not null default '',
  meta jsonb not null default '{}'::jsonb,
  fired_at timestamptz not null default now()
);
alter table public.tour_find_requests enable row level security;
revoke all on public.tour_find_requests from public, anon, authenticated;

create table if not exists public.tour_candidates (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists (id) on delete cascade,
  name text not null,
  role text not null default '',
  first_day date,
  last_day date,
  region text not null default '',
  lineup text not null default '',
  dates jsonb not null default '[]'::jsonb,    -- [{date, city, venue}]
  sources jsonb not null default '[]'::jsonb,  -- article urls
  status text not null default 'new',          -- new | added | no
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists tour_candidates_artist on public.tour_candidates (artist_id, status);
alter table public.tour_candidates enable row level security;
revoke all on public.tour_candidates from public, anon, authenticated;

-- Who may run it: the page's owner (a claimed, verified page) or a Greenroom admin.
create or replace function public.tour_find_may(a_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and exists (select 1 from artists a where a.id = a_id
                  and (public.is_admin() or (a.owner_id = auth.uid() and a.verified)))
     and exists (select 1 from artist_history h where h.artist_id = a_id)
$$;
revoke all on function public.tour_find_may(uuid) from public, anon, authenticated;

-- 2. Reading a page of HTML down to its words. Scripts, styles and tags go;
-- the handful of entities news sites use come back as characters.
create or replace function public.tf_text(html text)
returns text
language plpgsql immutable as $$
declare t text := coalesce(html, '');
begin
  -- Each script/style block ends at ITS OWN closing tag (a lookahead keeps
  -- the match from running to the last one on the page, which Postgres's
  -- regex engine would otherwise do whatever the quantifiers say).
  t := regexp_replace(t, '<script[^>]*>(?:(?!</script>).)*</script\s*>', ' ', 'gi');
  t := regexp_replace(t, '<style[^>]*>(?:(?!</style>).)*</style\s*>', ' ', 'gi');
  t := regexp_replace(t, '<noscript[^>]*>(?:(?!</noscript>).)*</noscript\s*>', ' ', 'gi');
  t := regexp_replace(t, '<svg[^>]*>(?:(?!</svg>).)*</svg\s*>', ' ', 'gi');
  t := regexp_replace(t, '<iframe[^>]*>(?:(?!</iframe>).)*</iframe\s*>', ' ', 'gi');
  t := regexp_replace(t, '<br\s*/?>|</p>|</li>|</h[1-6]>|</div>|</tr>', E'\n', 'gi');
  t := regexp_replace(t, '<[^>]+>', ' ', 'g');
  t := regexp_replace(t, '&amp;|&#0?38;', '&', 'g');
  t := regexp_replace(t, '&#8217;|&rsquo;', '’', 'g');
  t := regexp_replace(t, '&#0?39;|&#x27;|&apos;', '''', 'g');
  t := regexp_replace(t, '&#8216;|&lsquo;', '‘', 'g');
  t := regexp_replace(t, '&#822[01];|&ldquo;|&rdquo;|&quot;', '"', 'g');
  t := regexp_replace(t, '&#8211;|&ndash;', '–', 'g');
  t := regexp_replace(t, '&#8212;|&mdash;', '—', 'g');
  t := regexp_replace(t, '&#8230;|&hellip;', '…', 'g');
  t := regexp_replace(t, '&nbsp;|&#160;', ' ', 'g');
  t := regexp_replace(t, '&lt;', '<', 'g');
  t := regexp_replace(t, '&gt;', '>', 'g');
  t := regexp_replace(t, '[ \t\r]+', ' ', 'g');
  t := regexp_replace(t, '\n\s*\n+', E'\n', 'g');
  t := regexp_replace(t, E'\n ', E'\n', 'g');
  t := regexp_replace(t, E' \n', E'\n', 'g');
  return left(btrim(t), 12000);
end $$;
revoke all on function public.tf_text(text) from public, anon, authenticated;

-- 3. Fire the next requests one artist needs: ThePRP first (its WordPress
-- feed hands whole articles back as data, a page at a time), then Lambgoat
-- (its band page lists the articles; each is read on its own). A few at a
-- time, never two rounds within ten seconds: these are small sites.
create or replace function public.tour_find_fire(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare f record; rid bigint; n int := 0; p record;
        ua constant text := 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/; devinoliverofficial@gmail.com)';
begin
  select * into f from tour_finds where artist_id = a_id and status = 'reading';
  if not found then return 0; end if;
  if exists (select 1 from tour_find_requests r where r.artist_id = a_id) then return 0; end if;
  if f.slug = '' then
    update tour_finds set status = 'ready', detail = 'No tour announcements to read for this name.', finished_at = now() where artist_id = a_id;
    return 0;
  end if;
  -- Nothing left to ask for: the read is in, whatever the pacing says.
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
  elsif f.lg_state = 'new' then
    rid := net.http_get(url := 'https://lambgoat.com/music/' || f.slug || '/',
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'text/html'), timeout_milliseconds := 15000);
    insert into tour_find_requests (id, artist_id, kind) values (rid, a_id, 'lg_list');
    n := 1;
  elsif f.lg_state = 'listed' then
    for p in select url from tour_find_pages where artist_id = a_id and source = 'lambgoat' and not fetched order by url limit 4
    loop
      rid := net.http_get(url := p.url, headers := jsonb_build_object('User-Agent', ua, 'Accept', 'text/html'), timeout_milliseconds := 15000);
      insert into tour_find_requests (id, artist_id, kind, url) values (rid, a_id, 'lg_article', p.url);
      n := n + 1;
    end loop;
  end if;
  if n > 0 then update tour_finds set fired_at = clock_timestamp() where artist_id = a_id; end if;
  return n;
end $$;
revoke all on function public.tour_find_fire(uuid) from public, anon, authenticated;

-- 4. Read the replies that have landed.
create or replace function public.tour_find_absorb(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare r record; body jsonb; took int := 0; nm text; txt text; ttl text; pub date; href text; cnt int;
begin
  select lower(a.name) into nm from artists a where a.id = a_id;
  for r in select q.id, q.kind, q.url, q.meta, resp.status_code, resp.content, resp.timed_out, resp.error_msg
             from tour_find_requests q join net._http_response resp on resp.id = q.id
            where q.artist_id = a_id
  loop
    begin
      if r.status_code is null or r.status_code = 429 or r.status_code >= 500 then
        -- Timed out or the site is busy: the same thing is asked again next round, a few times.
        update tour_finds set tries = tries + 1,
               status = case when tries + 1 > 12 then 'error' else status end,
               detail = case when tries + 1 > 12 then 'The news archives aren’t answering right now. Try again later.' else detail end
         where artist_id = a_id;
        if r.kind = 'lg_article' then
          -- One article that won't load is skipped rather than holding everything up.
          update tour_find_pages set fetched = true, body = '' where artist_id = a_id and url = r.url;
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
          update tour_finds set lg_state = 'none' where artist_id = a_id;
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
          -- The article itself starts at its title; everything before is the site's chrome.
          if ttl <> '' and position(ttl in txt) > 0 then txt := substr(txt, position(ttl in txt)); end if;
          txt := left(txt, 7000);
          if position(regexp_replace(nm, '[^a-z0-9]+', '', 'g') in regexp_replace(lower(txt), '[^a-z0-9]+', '', 'g')) = 0 then
            -- A sidebar link to someone else's story: not about this act.
            delete from tour_find_pages where artist_id = a_id and url = r.url;
          else
            update tour_find_pages set fetched = true, title = left(coalesce(ttl, ''), 200), published = pub, body = txt
             where artist_id = a_id and url = r.url;
          end if;
        end if;
      end if;
    exception when others then
      update tour_finds set tries = tries + 1 where artist_id = a_id;
      if r.kind = 'lg_article' then update tour_find_pages set fetched = true, body = '' where artist_id = a_id and url = r.url; end if;
      if r.kind = 'prp_tag' then update tour_finds set prp_next = -1 where artist_id = a_id; end if;
      if r.kind = 'prp_posts' then update tour_finds set prp_next = -1 where artist_id = a_id; end if;
      if r.kind = 'lg_list' then update tour_finds set lg_state = 'none' where artist_id = a_id; end if;
    end;
    delete from tour_find_requests where id = r.id;
    took := took + 1;
  end loop;
  -- A request pg_net never answered (an hour on) is let go so the read can move on.
  delete from tour_find_requests where artist_id = a_id and fired_at < now() - interval '1 hour';
  return took;
end $$;
revoke all on function public.tour_find_absorb(uuid) from public, anon, authenticated;

-- Which nights a found tour speaks for: the ones within a day of a date it
-- lists; only a tour with no dates listed at all falls back to its whole
-- span (a day either side). A month-wide guess never paints a summer of
-- one-offs.
create or replace function public.tour_cand_night(c public.tour_candidates, d date)
returns boolean
language sql immutable as $$
  select d is not null and c.first_day is not null and c.last_day is not null
     and d between c.first_day - 1 and c.last_day + 1
     and (jsonb_array_length(c.dates) = 0
          or exists (select 1 from jsonb_array_elements(c.dates) x
                      where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and abs(d - (x ->> 'date')::date) <= 1))
$$;
revoke all on function public.tour_cand_night(public.tour_candidates, date) from public, anon, authenticated;

-- 5. What the app sees: the read's progress and every candidate so far.
create or replace function public.tour_find_state(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare f record;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  perform public.tour_find_absorb(a_id);
  perform public.tour_find_fire(a_id);
  select * into f from tour_finds where artist_id = a_id;
  -- A read of the articles that went quiet for five minutes is open again.
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
                                  'lambgoat', coalesce(f.lg_state, 'new')),
    'candidates', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'role', c.role, 'first', c.first_day, 'last', c.last_day, 'region', c.region,
        'lineup', c.lineup, 'n', jsonb_array_length(c.dates), 'sources', c.sources, 'status', c.status,
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

-- 6. Start (or start over). Once a day per page: the archives don't change
-- by the hour, and every run costs reading.
create or replace function public.tour_find_start(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare f record; nm text; sl text;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  select * into f from tour_finds where artist_id = a_id;
  if found and f.day = current_date and f.status <> 'error' then return public.tour_find_state(a_id); end if;
  select a.name into nm from artists a where a.id = a_id;
  sl := btrim(regexp_replace(lower(coalesce(nm, '')), '[^a-z0-9]+', '-', 'g'), '-');
  delete from tour_find_requests where artist_id = a_id;
  delete from tour_find_pages where artist_id = a_id;
  delete from tour_candidates where artist_id = a_id and status = 'new';
  insert into tour_finds (artist_id, owner_id, status, detail, slug, prp_tag, prp_pages, prp_next, lg_state, tries, fired_at, started_at, finished_at, day)
  values (a_id, auth.uid(), 'reading', '', sl, null, 0, 0, 'new', 0, null, now(), null, current_date)
  on conflict (artist_id) do update
    set owner_id = excluded.owner_id, status = 'reading', detail = '', slug = excluded.slug, prp_tag = null, prp_pages = 0,
        prp_next = 0, lg_state = 'new', tries = 0, fired_at = null, started_at = now(), finished_at = null, day = current_date;
  return public.tour_find_state(a_id);
end $$;
revoke all on function public.tour_find_start(uuid) from public, anon;
grant execute on function public.tour_find_start(uuid) to authenticated;

-- 7. The articles, for the app to read through once the archives are in.
create or replace function public.tour_find_pages_get(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare f record;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  select * into f from tour_finds where artist_id = a_id;
  if not found then return null; end if;
  -- One phone reads at a time: a second asker within five minutes is told to wait.
  if f.status = 'extracting' and f.extracting_at > now() - interval '5 minutes' then return null; end if;
  if f.status not in ('ready', 'extracting', 'done') then return null; end if;
  update tour_finds set status = 'extracting', extracting_at = now() where artist_id = a_id;
  return coalesce((
    select jsonb_agg(jsonb_build_object('url', g.url, 'source', g.source, 'title', g.title, 'published', g.published, 'body', g.body)
                     order by g.published nulls last, g.url)
      from tour_find_pages g where g.artist_id = a_id and g.fetched and g.body <> ''), '[]'::jsonb);
end $$;
revoke all on function public.tour_find_pages_get(uuid) from public, anon;
grant execute on function public.tour_find_pages_get(uuid) to authenticated;

-- 8. The app hands back what it read: tours, with their dates. A tour
-- already in the history (by the sound of its name) or already proposed
-- is left out; the rest wait for the artist's yes or no.
create or replace function public.tour_find_propose(a_id uuid, cands jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare c jsonb; nm text; key text; fd date; ld date; n int := 0; ds jsonb;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  if jsonb_typeof(cands) <> 'array' then raise exception 'bad input' using errcode = '22023'; end if;
  for c in select * from jsonb_array_elements(cands) limit 120
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
    if exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.tour <> '' and public.setlist_tour_key(h.tour) = key) then continue; end if;
    -- Only well-formed dates inside the run are kept.
    select coalesce(jsonb_agg(jsonb_build_object('date', d ->> 'date', 'city', left(coalesce(d ->> 'city', ''), 80), 'venue', left(coalesce(d ->> 'venue', ''), 120))
                    order by d ->> 'date'), '[]'::jsonb) into ds
      from jsonb_array_elements(case when jsonb_typeof(c -> 'dates') = 'array' then c -> 'dates' else '[]'::jsonb end) d
     where (d ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (d ->> 'date')::date between fd - 1 and ld + 1;
    insert into tour_candidates (artist_id, name, role, first_day, last_day, region, lineup, dates, sources)
    values (a_id, nm,
      case when c ->> 'role' in ('headline', 'co-headline', 'support', 'festival') then c ->> 'role' else '' end,
      fd, ld, left(coalesce(c ->> 'region', ''), 60), left(coalesce(c ->> 'lineup', ''), 300), ds,
      (select coalesce(jsonb_agg(left(s, 300)), '[]'::jsonb) from (
         select distinct s from jsonb_array_elements_text(case when jsonb_typeof(c -> 'sources') = 'array' then c -> 'sources' else '[]'::jsonb end) s
          where s like 'https://%' limit 6) x));
    n := n + 1;
   exception when others then
    -- A date like 2019-13-45 or any other junk in one item: that item is skipped.
    null;
   end;
  end loop;
  -- The app has read the articles: the read is over, whatever the pacing was saying.
  update tour_finds set status = 'done', extracting_at = null, finished_at = coalesce(finished_at, now()) where artist_id = a_id and status <> 'error';
  return public.tour_find_state(a_id) || jsonb_build_object('added', n);
end $$;
revoke all on function public.tour_find_propose(uuid, jsonb) from public, anon;
grant execute on function public.tour_find_propose(uuid, jsonb) to authenticated;

-- 9. Putting an accepted tour onto the history: the blank nights inside its
-- dates take its name; announced dates with no night yet are added, pinned,
-- so a later sync neither prunes nor renames them. Run again after every
-- sync, so it can't be undone by the daily re-read.
create or replace function public.tour_find_apply(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; d jsonb; n int := 0; cc text; ct text;
begin
  -- An announced date setlist.fm has since filled in for real: the placeholder goes.
  delete from artist_history_shows p
   where p.artist_id = a_id and p.pinned
     and exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = p.date and not h.pinned);
  for c in select * from tour_candidates where artist_id = a_id and status = 'added' and first_day is not null and last_day is not null
            order by last_day - first_day asc
  loop
    update artist_history_shows h set tour = c.name, named_by = c.id
     where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date);
    for d in select * from jsonb_array_elements(c.dates)
    loop
      if (d ->> 'date') !~ '^\d{4}-\d{2}-\d{2}$' then continue; end if;
      -- A night not yet played is not a show: it lands once its date has passed (apply runs after every sync).
      if (d ->> 'date')::date > current_date then continue; end if;
      if exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (d ->> 'date')::date) then continue; end if;
      ct := left(btrim(split_part(coalesce(d ->> 'city', ''), ',', 1)), 80);
      cc := coalesce(public.road_country(d ->> 'city'), '');
      insert into artist_history_shows (artist_id, id, date, venue, city, state, country_code, country, tour, url, pinned, named_by, seen)
      values (a_id, 'tf:' || c.id || ':' || (d ->> 'date'), (d ->> 'date')::date, left(coalesce(d ->> 'venue', ''), 120), ct,
              case when cc in ('US', 'CA') then left(btrim(split_part(coalesce(d ->> 'city', ''), ',', 2)), 80) else '' end,
              cc, case cc when 'US' then 'United States' when 'CA' then 'Canada' when 'GB' then 'United Kingdom' when 'AU' then 'Australia'
                          when '' then ''
                          -- Elsewhere the text after the last comma is the country as the article wrote it.
                          else left(btrim(coalesce(substring(d ->> 'city' from ',([^,]*)$'), '')), 80) end,
              c.name, '', true, c.id, now())
      on conflict (artist_id, id) do nothing;
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;
revoke all on function public.tour_find_apply(uuid) from public, anon, authenticated;

create or replace function public.tour_candidate_decide(c_id uuid, add boolean, new_name text default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare c record; nm text;
begin
  select * into c from tour_candidates where id = c_id;
  if not found or not public.tour_find_may(c.artist_id) then raise exception 'permission' using errcode = '42501'; end if;
  if add then
    nm := left(btrim(regexp_replace(coalesce(new_name, ''), '\s+', ' ', 'g')), 120);
    update tour_candidates set status = 'added', decided_at = now(), name = case when char_length(nm) >= 2 then nm else name end where id = c_id;
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

-- Taking an added tour back off: its nights go blank again, its pinned dates go.
create or replace function public.tour_candidate_undo(c_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare c record;
begin
  select * into c from tour_candidates where id = c_id;
  if not found or not public.tour_find_may(c.artist_id) then raise exception 'permission' using errcode = '42501'; end if;
  update tour_candidates set status = 'new', decided_at = null where id = c_id;
  update artist_history_shows set tour = '', named_by = null where artist_id = c.artist_id and named_by = c_id and not pinned;
  delete from artist_history_shows where artist_id = c.artist_id and pinned and named_by = c_id;
  perform public.tour_find_apply(c.artist_id);
  perform public.setlist_summarize(c.artist_id);
  return public.tour_find_state(c.artist_id);
end $$;
revoke all on function public.tour_candidate_undo(uuid) from public, anon;
grant execute on function public.tour_candidate_undo(uuid) to authenticated;

-- 10. The setlist.fm sync keeps the finder's work: pinned nights are never
-- pruned, and the names go back on after every pass.
create or replace function public.setlist_finish(one uuid default null)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare a record; n int := 0;
begin
  for a in select ah.artist_id, ah.pass_at from artist_history ah
            where (one is null or ah.artist_id = one)
              and ah.status = 'syncing' and ah.pages > 0 and ah.next_page > ah.pages
              and not exists (select 1 from setlist_requests q where q.artist_id = ah.artist_id)
  loop
    delete from artist_history_shows
     where artist_id = a.artist_id and not pinned and seen < coalesce(a.pass_at, now()) - interval '3 days';
    perform public.tour_find_apply(a.artist_id);
    perform setlist_summarize(a.artist_id);
    update artist_history set status = 'ok', next_page = 0, synced_at = now(), detail = ''
     where artist_id = a.artist_id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.setlist_finish(uuid) from public, anon, authenticated;

-- 11. The minute tick: every read in progress moves along, whether or not
-- anyone has the page open.
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
  -- A read that never finished in two hours stops asking.
  update tour_finds set status = 'error', detail = 'Reading took too long. Try again.'
   where status = 'reading' and started_at <= now() - interval '2 hours';
  -- Once a day, announced dates that have just passed land on their pages.
  if to_char(now(), 'HH24:MI') = '06:10' then
    for f in select distinct artist_id from tour_candidates where status = 'added' loop
      perform public.tour_find_apply(f.artist_id);
      perform public.setlist_summarize(f.artist_id);
    end loop;
  end if;
  return n;
end $$;
revoke all on function public.tour_find_tick() from public, anon, authenticated;
do $$
begin
  perform cron.unschedule('greenroom-tourfind')
    where exists (select 1 from cron.job where jobname = 'greenroom-tourfind');
  perform cron.schedule('greenroom-tourfind', '* * * * *', 'select public.tour_find_tick()');
end $$;

notify pgrst, 'reload schema';
