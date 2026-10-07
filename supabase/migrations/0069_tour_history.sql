-- Tour history: an artist page learns its own road story. setlist.fm (the
-- fans' setlist archive) holds nearly every night a band ever played —
-- date, city, country, tour name — behind a free API key. The database
-- reads it the way it reads Square: pg_net on a cron, fire a request now,
-- absorb the reply next tick. The key is write-only from the app, same as
-- every other secret. What comes back is boiled down to one summary per
-- artist — shows, tours, countries, cities, years — shown on the artist
-- page with credit to setlist.fm (their terms ask for the link; fair).
--
-- The artist is found on MusicBrainz first (the open music encyclopedia,
-- no key needed): its id is how setlist.fm names artists.

-- 1. The connection. One row per account; the key is write-only: column
-- grants let a signed-in user save or replace THEIR key, never read it.
create table if not exists public.setlist_connect (
  owner_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  token text not null,
  status text not null default 'new',    -- new | ok | bad_token | error
  detail text not null default '',
  last_sync timestamptz,
  connected_at timestamptz not null default now()
);
alter table public.setlist_connect enable row level security;
drop policy if exists setlist_connect_all on public.setlist_connect;
create policy setlist_connect_all on public.setlist_connect
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.setlist_connect from public, anon, authenticated;
grant select (owner_id, status, detail, last_sync, connected_at)
  on public.setlist_connect to authenticated;
grant insert (owner_id, token, status), update (owner_id, token, status), delete
  on public.setlist_connect to authenticated;

-- 2. One history per artist page. The summary is the whole point: it is as
-- public as the artist page itself (any signed-in account), because it only
-- holds what setlist.fm already shows the world.
create table if not exists public.artist_history (
  artist_id uuid primary key references public.artists (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  mbid text not null default '',         -- MusicBrainz id, found automatically
  mb_url text not null default '',       -- the artist's setlist.fm page, for credit
  status text not null default 'new',    -- new | finding | syncing | ok | bad_token | error
  detail text not null default '',
  total int not null default 0,          -- setlists setlist.fm says it has
  pages int not null default 0,
  next_page int not null default 1,      -- 0 = all pages read
  tries int not null default 0,          -- failures in a row; a run of them stops the sync
  summary jsonb not null default '{}'::jsonb,
  synced_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.artist_history enable row level security;
drop policy if exists artist_history_select on public.artist_history;
create policy artist_history_select on public.artist_history for select
  using (auth.uid() is not null);
revoke all on public.artist_history from public, anon, authenticated;
grant select on public.artist_history to authenticated;

-- 3. Every night read from setlist.fm, one row per setlist: the raw book
-- the summary is boiled from, and later the list a crew member points at
-- ("I worked that tour"). Server-only for now.
create table if not exists public.artist_history_shows (
  artist_id uuid not null references public.artists (id) on delete cascade,
  id text not null,                      -- setlist.fm's setlist id
  date date,
  venue text not null default '',
  city text not null default '',
  state text not null default '',
  country_code text not null default '',
  country text not null default '',
  tour text not null default '',
  url text not null default '',
  updated timestamptz,
  seen timestamptz not null default now(),  -- last sync that saw it; unseen rows are pruned
  primary key (artist_id, id)
);
create index if not exists artist_history_shows_when on public.artist_history_shows (artist_id, date);
alter table public.artist_history_shows enable row level security;
revoke all on public.artist_history_shows from public, anon, authenticated;

-- Requests in flight: pg_net answers on a later tick, so each fired request
-- is remembered until its reply is read. Server-side only.
create table if not exists public.setlist_requests (
  id bigint primary key,                 -- pg_net's request id
  owner_id uuid not null,
  artist_id uuid not null,
  kind text not null,                    -- mbid | page
  meta jsonb not null default '{}'::jsonb,
  fired_at timestamptz not null default now()
);
alter table public.setlist_requests enable row level security;
revoke all on public.setlist_requests from public, anon, authenticated;

-- 4. Parsers, one per reply shape, testable with plain JSON.

-- A page of setlists: keep each night, remember how many pages there are.
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
           -- Only setlist.fm's own links are kept (they end up in hrefs).
           case when coalesce(s ->> 'url', '') like 'https://www.setlist.fm/%' then left(s ->> 'url', 200) else '' end,
           nullif(s ->> 'lastUpdated', '')::timestamptz
      from jsonb_array_elements(coalesce(body -> 'setlist', '[]'::jsonb)) s
     where s ->> 'id' is not null
    on conflict (artist_id, id) do update
      set date = excluded.date, venue = excluded.venue, city = excluded.city,
          state = excluded.state, country_code = excluded.country_code,
          country = excluded.country, tour = excluded.tour, url = excluded.url,
          updated = excluded.updated, seen = now()
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

-- Tour names arrive messy: "Pt. 1" vs "Part1", February with a typo. Group
-- them by the SOUND of their words (filler dropped, digits kept), so one
-- tour counts once however the fans spelled it.
create extension if not exists fuzzystrmatch with schema extensions;
create or replace function public.setlist_tour_key(t text)
returns text
language sql immutable as $$
  -- A name with no Latin letters at all (a Japanese tour, say) keeps its
  -- own spelling as the key, so different names never melt into one.
  select coalesce(nullif(array_to_string(array(
    select case when w ~ '^\d+$' then w else extensions.dmetaphone(w) end
      from regexp_split_to_table(
             btrim(regexp_replace(
               regexp_replace(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]+', ' ', 'g'),
                              '([a-z])(\d)', '\1 \2', 'g'),
               '(\d)([a-z])', '\1 \2', 'g')), ' '::text) w
     where w <> '' and w not in ('tour', 'tours', 'the', 'pt', 'part', 'parts')
  ), ' '), ''), btrim(lower(coalesce(t, ''))))
$$;
revoke all on function public.setlist_tour_key(text) from public, anon, authenticated;

-- Boil the nights down to the page's summary.
create or replace function public.setlist_summarize(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s jsonb;
begin
  select jsonb_build_object(
    'shows', count(*),
    'countries', count(distinct country_code) filter (where country_code <> ''),
    'cities', count(distinct (country_code, lower(city))) filter (where city <> ''),
    'firstYear', min(extract(year from date))::int,
    'lastYear', max(extract(year from date))::int,
    'tours', (select count(*) from (
       select 1 from artist_history_shows h2
        where h2.artist_id = a_id and h2.tour <> ''
        group by public.setlist_tour_key(h2.tour)) x),
    'years', coalesce((select jsonb_object_agg(y, n) from (
       select extract(year from h3.date)::int as y, count(*) as n
         from artist_history_shows h3
        where h3.artist_id = a_id and h3.date is not null
        group by 1) yy), '{}'::jsonb),
    'toursList', coalesce((select jsonb_agg(jsonb_build_object(
         'name', t.name, 'n', t.n, 'first', t.first, 'last', t.last)
         order by t.last desc nulls last)
       from (
         select mode() within group (order by h4.tour) as name, count(*) as n,
                min(h4.date) as first, max(h4.date) as last
           from artist_history_shows h4
          where h4.artist_id = a_id and h4.tour <> ''
          group by public.setlist_tour_key(h4.tour)
          order by max(h4.date) desc nulls last
          limit 60) t), '[]'::jsonb),
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

-- 5. The tick: read replies that have arrived, then fire the next asks.
-- Gentle on setlist.fm: two pages per artist per tick, five minutes apart —
-- a 700-night history is all in within a couple of hours.
create or replace function public.setlist_tick()
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare r record; a record; body jsonb; took int := 0; fired int := 0; rid bigint;
        mb jsonb; score int; pg int; did_mbid boolean := false;
begin
  if not exists (select 1 from artist_history) then return jsonb_build_object('idle', true); end if;

  -- Absorb what has come back.
  for r in select q.id, q.owner_id, q.artist_id, q.kind, q.meta,
                  resp.status_code, resp.content, resp.timed_out, resp.error_msg
             from setlist_requests q join net._http_response resp on resp.id = q.id
  loop
    begin
      body := case when r.content is null or r.content = '' then '{}'::jsonb else r.content::jsonb end;
      if r.status_code is null or r.status_code = 429
          or (r.status_code >= 400 and r.kind = 'mbid')
          or (r.status_code >= 400 and r.status_code not in (401, 403, 404) and r.kind = 'page') then
        -- Timed out, told to slow down, or a server hiccup: the SAME page is
        -- asked again next tick (next_page never moved), so no night can be
        -- skipped. A long run of failures parks it for the owner to restart.
        update artist_history set tries = tries + 1,
               detail = left(coalesce(case when r.status_code = 429 then 'setlist.fm asked us to slow down — retrying'
                                           when r.status_code is not null then 'http ' || r.status_code end,
                             r.error_msg, case when r.timed_out then 'timed out' else 'no answer' end), 160),
               status = case when tries + 1 > 20 then 'error' else status end
         where artist_id = r.artist_id and status not in ('bad_token');
      elsif r.kind = 'mbid' then
        -- MusicBrainz answered cleanly: take the match only when it's sure,
        -- alone (two exact-name bands = no guessing), and shaped like an id
        -- (it goes into a URL).
        mb := body -> 'artists' -> 0;
        score := coalesce(nullif(mb ->> 'score', '')::int, 0);
        if mb is null then
          update artist_history set status = 'error', detail = 'not found on MusicBrainz'
           where artist_id = r.artist_id;
        elsif score < 90 or coalesce(mb ->> 'id', '') !~ '^[0-9a-f-]{36}$' then
          update artist_history set status = 'error',
                 detail = left('no sure match on MusicBrainz (best: ' || coalesce(mb ->> 'name', '?') || ')', 160)
           where artist_id = r.artist_id;
        elsif coalesce(nullif(body -> 'artists' -> 1 ->> 'score', '')::int, 0) >= 95 then
          update artist_history set status = 'error',
                 detail = left('more than one band with this name on MusicBrainz — it can''t tell which is yours', 160)
           where artist_id = r.artist_id;
        else
          update artist_history set mbid = mb ->> 'id', status = 'syncing', detail = '', next_page = 1, tries = 0
           where artist_id = r.artist_id;
        end if;
      elsif r.status_code in (401, 403) then
        update setlist_connect set status = 'bad_token', detail = 'setlist.fm refused the key'
         where owner_id = r.owner_id;
        update artist_history set status = 'bad_token', detail = 'setlist.fm refused the key'
         where artist_id = r.artist_id;
      elsif r.status_code = 404 then
        -- No setlists at all (or past the end): the book is what it is.
        perform setlist_summarize(r.artist_id);
        update artist_history set status = 'ok', next_page = 0, synced_at = now(), tries = 0,
               detail = case when total = 0 then 'nothing on setlist.fm yet' else '' end
         where artist_id = r.artist_id;
      else
        perform setlist_take_page(r.artist_id, body);
        pg := coalesce(nullif(r.meta ->> 'page', '')::int, 1);
        update artist_history
           set next_page = greatest(next_page, pg + 1), status = 'syncing', detail = '', tries = 0
         where artist_id = r.artist_id and next_page > 0;
        update setlist_connect set status = 'ok', detail = '', last_sync = now()
         where owner_id = r.owner_id and status <> 'ok';
      end if;
      took := took + 1;
      delete from setlist_requests where id = r.id;
    exception when others then
      delete from setlist_requests where id = r.id;
    end;
  end loop;
  -- Replies that never came stop blocking after an hour.
  delete from setlist_requests where fired_at < now() - interval '1 hour';

  -- Every page read: drop nights the daily re-reads stopped seeing (gone or
  -- merged on setlist.fm — their data stays a cache, not an archive), then
  -- boil the book down and call it synced.
  for a in select ah.artist_id from artist_history ah
            where ah.status = 'syncing' and ah.pages > 0 and ah.next_page > ah.pages
              and not exists (select 1 from setlist_requests q where q.artist_id = ah.artist_id)
  loop
    delete from artist_history_shows
     where artist_id = a.artist_id and seen < now() - interval '3 days';
    perform setlist_summarize(a.artist_id);
    update artist_history set status = 'ok', next_page = 0, synced_at = now(), detail = ''
     where artist_id = a.artist_id;
  end loop;

  -- A day later, read it fresh (new nights land on setlist.fm's first page).
  update artist_history set status = 'syncing', next_page = 1, tries = 0
   where status = 'ok' and synced_at < now() - interval '24 hours';

  -- A replaced key un-parks every page the refused one stranded.
  update artist_history ah
     set status = case when ah.mbid = '' then 'new' else 'syncing' end, detail = '', tries = 0
    from setlist_connect sc
   where sc.owner_id = ah.owner_id and ah.status = 'bad_token' and sc.status <> 'bad_token';

  -- Fire the next round.
  for a in select ah.*, ar.name as artist_name, sc.token
             from artist_history ah
             join artists ar on ar.id = ah.artist_id
             join setlist_connect sc on sc.owner_id = ah.owner_id
            where sc.status <> 'bad_token' and ah.status in ('new', 'finding', 'syncing')
  loop
    if exists (select 1 from setlist_requests q where q.artist_id = a.artist_id) then continue; end if;
    if a.mbid = '' then
      -- Find the band on MusicBrainz (open data, no key needed). One lookup
      -- per tick in all: their house rule is one request a second.
      if did_mbid then continue; end if;
      did_mbid := true;
      rid := net.http_get(url := 'https://musicbrainz.org/ws/2/artist/',
        params := jsonb_build_object('query', 'artist:"' || replace(a.artist_name, '"', '') || '"',
                                     'fmt', 'json', 'limit', '5'),
        headers := jsonb_build_object('User-Agent', 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/)',
                                      'Accept', 'application/json'));
      insert into setlist_requests (id, owner_id, artist_id, kind) values (rid, a.owner_id, a.artist_id, 'mbid');
      update artist_history set status = 'finding' where artist_id = a.artist_id;
      fired := fired + 1;
    elsif a.next_page >= 1 then
      -- One page per tick, in order: a page that fails is simply asked
      -- again, and no night can be skipped past. A 700-night history is
      -- all in within a few hours, once ever.
      rid := net.http_get(url := 'https://api.setlist.fm/rest/1.0/artist/' || a.mbid || '/setlists',
        params := jsonb_build_object('p', a.next_page::text),
        headers := jsonb_build_object('x-api-key', a.token, 'Accept', 'application/json',
                                      'User-Agent', 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/)'));
      insert into setlist_requests (id, owner_id, artist_id, kind, meta)
        values (rid, a.owner_id, a.artist_id, 'page', jsonb_build_object('page', a.next_page));
      update artist_history set status = 'syncing' where artist_id = a.artist_id;
      fired := fired + 1;
    end if;
  end loop;

  return jsonb_build_object('took', took, 'fired', fired);
end $$;
revoke all on function public.setlist_tick() from public, anon, authenticated;

-- 6. Switching it on, from the artist page the owner runs.
create or replace function public.artist_history_start(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.runs_artist(a_id) then
    raise exception 'permission' using errcode = '42501';
  end if;
  if not exists (select 1 from setlist_connect where owner_id = auth.uid()) then
    raise exception 'connect first' using errcode = '22023';
  end if;
  -- A fresh start reads a fresh book: whatever an earlier run fetched
  -- (maybe for a wrong same-named band) goes, so two bands can never mix.
  delete from artist_history_shows where artist_id = a_id;
  insert into artist_history (artist_id, owner_id)
  values (a_id, auth.uid())
  on conflict (artist_id) do update
    set status = 'new', detail = '', mbid = '', next_page = 1, pages = 0, total = 0, tries = 0,
        summary = '{}'::jsonb, synced_at = null,
        owner_id = excluded.owner_id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.artist_history_start(uuid) from public, anon;
grant execute on function public.artist_history_start(uuid) to authenticated;

-- Turning it off takes the history off the page AND out of the database —
-- setlist.fm's data is borrowed, not kept. Switching back on reads it in
-- fresh within a couple of hours.
create or replace function public.artist_history_stop(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.runs_artist(a_id) then
    raise exception 'permission' using errcode = '42501';
  end if;
  delete from artist_history_shows where artist_id = a_id;
  delete from artist_history where artist_id = a_id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.artist_history_stop(uuid) from public, anon;
grant execute on function public.artist_history_stop(uuid) to authenticated;

-- Every five minutes; the tick does nothing while no history is switched on.
do $do$
begin
  perform cron.unschedule('greenroom-setlist')
    where exists (select 1 from cron.job where jobname = 'greenroom-setlist');
  perform cron.schedule('greenroom-setlist', '*/5 * * * *', 'select public.setlist_tick()');
end $do$;

notify pgrst, 'reload schema';
