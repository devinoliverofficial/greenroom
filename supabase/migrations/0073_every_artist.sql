-- Every artist on Greenroom. Devin: "in the most ideal scenario i would like
-- greenroom to host EVERY ARTIST THAT EXISTS... an artist has to 'claim' the
-- page."
--
-- How it works. Search already reaches every act there is: the phone asks
-- MusicBrainz (the open music encyclopedia) as you type. Tapping one that
-- has no page here makes its page on the spot — UNCLAIMED: nobody runs it,
-- nobody can edit it. The server then asks MusicBrainz, by id, what the act
-- is really called (so a page is never named by whoever tapped first, and
-- the encyclopedia's junk entries never become pages), and reads its road
-- history from setlist.fm with Greenroom's own key, fast while someone is
-- looking and gently otherwise. Anyone in the band can ask to claim the
-- page; a Greenroom admin says yes or no; a yes makes them its owner and
-- marks the page verified.
--
-- Verified is also what closes a hole: until now anyone could make a page
-- named after a famous band, switch its history on and hand themselves that
-- band's road story. From here a page only carries a synced history if it
-- was born from the encyclopedia or claimed through an admin.

-- 1. Pages nobody runs. owner_id may be empty; the page remembers which act
-- it is (mbid), what the encyclopedia says about it, and who first opened it.
alter table public.artists alter column owner_id drop not null;
alter table public.artists add column if not exists mbid text not null default '';
alter table public.artists add column if not exists about text not null default '';
alter table public.artists add column if not exists country text not null default '';
alter table public.artists add column if not exists verified boolean not null default false;
-- false only for a page just made from a tap, until MusicBrainz confirms it
alter table public.artists add column if not exists checked boolean not null default true;
alter table public.artists add column if not exists created_by uuid;
alter table public.artists add column if not exists claimed_at timestamptz;
alter table public.artists drop constraint if exists artists_about_len;
alter table public.artists add constraint artists_about_len check (char_length(about) <= 160);
-- One unclaimed page per act.
create unique index if not exists artists_one_unclaimed on public.artists (mbid) where owner_id is null and mbid <> '';
create index if not exists artists_mbid on public.artists (mbid) where mbid <> '';
create index if not exists artists_created_by on public.artists (created_by, created_at) where created_by is not null;

-- A page that already carries a synced history is the real thing: it keeps it.
update public.artists a set mbid = h.mbid, verified = true
  from public.artist_history h
 where h.artist_id = a.id and h.mbid <> '' and a.mbid = '';

-- What an account may write on a page straight from the app: its name,
-- username, bio and photo, and nothing else. Who owns it, whether it's
-- verified and which act it is are the server's to say.
revoke insert, update on public.artists from anon, authenticated;
grant insert (id, owner_id, handle, name, bio, avatar) on public.artists to authenticated;
grant update (handle, name, bio, avatar) on public.artists to authenticated;
-- ...and what it may read: everything a page shows, never who first opened it.
revoke select on public.artists from anon, authenticated;
grant select (id, owner_id, handle, name, bio, avatar, created_at,
              mbid, about, country, verified, checked, claimed_at)
  on public.artists to authenticated;

-- A page nobody runs carries a username Greenroom made up for it: "mb." and
-- twenty random characters. That shape is Greenroom's alone. No account can
-- pick an "mb." name for itself, or for a page that wasn't born from the
-- encyclopedia (a client can't write mbid), so nobody can dress a hand-made
-- page up as an unclaimed one or sit on a name a page will need.
alter table public.artists drop constraint if exists artists_handle_mb;
alter table public.artists add constraint artists_handle_mb
  check (handle not like 'mb.%' or mbid <> '') not valid;
alter table public.profiles drop constraint if exists profiles_handle_mb;
alter table public.profiles add constraint profiles_handle_mb
  check (handle is null or handle not like 'mb.%') not valid;
create or replace function public.handle_free(h text)
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and lower(trim(coalesce(h, ''))) ~ '^[a-z0-9._]{3,24}$'
     and lower(trim(h)) not in ('greenroom', 'admin', 'support', 'help', 'official', 'staff', 'ari', 'everyone', 'here')
     and lower(trim(h)) not like 'mb.%'
     and not exists (select 1 from profiles p where p.handle = lower(trim(h)) and p.user_id <> auth.uid())
     and not exists (select 1 from artists a where a.handle = lower(trim(h)))
$$;
create or replace function public.artist_handle_free(h text, for_artist uuid default null)
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and lower(trim(coalesce(h, ''))) ~ '^[a-z0-9._]{3,24}$'
     and lower(trim(h)) not in ('greenroom', 'admin', 'support', 'help', 'official', 'staff', 'ari', 'everyone', 'here')
     and lower(trim(h)) not like 'mb.%'
     and not exists (select 1 from profiles p where p.handle = lower(trim(h)))
     and not exists (select 1 from artists a where a.handle = lower(trim(h)) and (for_artist is null or a.id <> for_artist))
$$;

-- 2. Greenroom's admins: who answers claims. Server-only; rows are added by hand.
create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from public, anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (select 1 from platform_admins p where p.user_id = auth.uid())
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- 3. Greenroom's own setlist.fm key: one saved key is marked the house key
-- (by hand), and unclaimed pages read with it. The app can neither read nor
-- set the mark (it is outside the column grants).
alter table public.setlist_connect add column if not exists house boolean not null default false;
create unique index if not exists setlist_one_house on public.setlist_connect ((true)) where house;

-- A history Greenroom reads itself (auto), when it was last looked at, when
-- its current read began, and when it last asked for something.
alter table public.artist_history add column if not exists auto boolean not null default false;
alter table public.artist_history add column if not exists viewed_at timestamptz;
alter table public.artist_history add column if not exists pass_at timestamptz;
alter table public.artist_history add column if not exists fired_at timestamptz;
-- The account whose key reads a history, and when a page was last looked
-- at, stay server-side.
revoke select on public.artist_history from anon, authenticated;
grant select (artist_id, mbid, mb_url, status, detail, total, pages, next_page,
              tries, summary, synced_at, created_at, auto)
  on public.artist_history to authenticated;

-- Manners. setlist.fm allows a key so many requests a day and a couple a
-- second; MusicBrainz asks for one a second. The day's count and the time of
-- the last request to each are kept here. Server-only.
create table if not exists public.setlist_budget (
  day date primary key,
  used int not null default 0
);
alter table public.setlist_budget enable row level security;
revoke all on public.setlist_budget from public, anon, authenticated;
create table if not exists public.setlist_pace (
  k text primary key,                    -- 'mb' | 'house'
  at timestamptz not null default now()
);
alter table public.setlist_pace enable row level security;
revoke all on public.setlist_pace from public, anon, authenticated;
-- One account's share of a day: the pages it made from a tap (kept or not),
-- and the house-key requests its looking caused. Server-only.
create table if not exists public.setlist_user_day (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  opened int not null default 0,
  house int not null default 0,
  primary key (user_id, day)
);
alter table public.setlist_user_day enable row level security;
revoke all on public.setlist_user_day from public, anon, authenticated;

-- May a request go to this service right now? Says yes at most once per gap,
-- across every caller.
create or replace function public.setlist_pace_ok(key text, gap interval)
returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare last_at timestamptz;
begin
  insert into setlist_pace (k, at) values (key, clock_timestamp() - gap - interval '1 second')
  on conflict (k) do nothing;
  select at into last_at from setlist_pace where k = key for update;
  if last_at > clock_timestamp() - gap then return false; end if;
  update setlist_pace set at = clock_timestamp() where k = key;
  return true;
end $$;
revoke all on function public.setlist_pace_ok(text, interval) from public, anon, authenticated;

-- 4. The sync engine, in three parts so one page can be stepped on its own
-- while someone is looking at it.

-- 4a. Read the replies that have arrived (for every page, or just one).
create or replace function public.setlist_absorb(one uuid default null)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare r record; body jsonb; took int := 0; mb jsonb; score int; pg int; nm text; typ text;
begin
  for r in select q.id, q.owner_id, q.artist_id, q.kind, q.meta,
                  resp.status_code, resp.content, resp.timed_out, resp.error_msg
             from setlist_requests q join net._http_response resp on resp.id = q.id
            where one is null or q.artist_id = one
  loop
    begin
      body := case when r.content is null or r.content = '' then '{}'::jsonb else r.content::jsonb end;
      if r.status_code is null or r.status_code = 429
          or (r.status_code >= 400 and r.kind = 'mbid')
          or (r.status_code >= 400 and r.status_code not in (400, 404) and r.kind = 'mbget')
          or (r.status_code >= 400 and r.status_code not in (401, 403, 404) and r.kind = 'page') then
        -- Timed out, told to slow down, or a server hiccup: the SAME thing is
        -- asked again (nothing moved), so no night can be skipped. A long
        -- run of failures parks it.
        update artist_history set tries = tries + 1,
               detail = left(coalesce(case when r.status_code = 429 then 'setlist.fm asked us to slow down — retrying'
                                           when r.status_code is not null then 'http ' || r.status_code end,
                             r.error_msg, case when r.timed_out then 'timed out' else 'no answer' end), 160),
               status = case when tries + 1 > 20 then 'error' else status end
         where artist_id = r.artist_id and status not in ('bad_token');
      elsif r.kind = 'mbget' then
        -- MusicBrainz, asked by id: is this a real act, and what is it called?
        nm := btrim(coalesce(body ->> 'name', ''));
        typ := coalesce(body ->> 'type', '');
        if r.status_code in (400, 404) or nm = '' or char_length(nm) > 60
           or typ not in ('Group', 'Person', 'Orchestra', 'Choir') then
          -- Not one (or one of the encyclopedia's junk entries): the page goes.
          delete from artists where id = r.artist_id and owner_id is null and not checked;
        else
          update artists set name = nm, about = left(coalesce(body ->> 'disambiguation', ''), 160),
                 country = left(coalesce(body ->> 'country', ''), 8), checked = true
           where id = r.artist_id and owner_id is null;
          update artist_history set status = 'syncing', detail = '', next_page = 1, tries = 0, pass_at = now()
           where artist_id = r.artist_id and status = 'checking';
        end if;
      elsif r.kind = 'mbid' then
        -- MusicBrainz, searched by name (a page that wasn't born from it):
        -- take the match only when it's sure, alone, and shaped like an id.
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
          update artist_history set mbid = mb ->> 'id', status = 'syncing', detail = '', next_page = 1, tries = 0, pass_at = now()
           where artist_id = r.artist_id;
          update artists set mbid = mb ->> 'id' where id = r.artist_id and mbid = '';
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
        -- A page Greenroom reads itself counts up as it comes in, so
        -- whoever is watching sees the numbers climb.
        if exists (select 1 from artist_history where artist_id = r.artist_id and auto) then
          perform setlist_summarize(r.artist_id);
        end if;
      end if;
      took := took + 1;
      delete from setlist_requests where id = r.id;
    exception when others then
      delete from setlist_requests where id = r.id;
    end;
  end loop;
  return took;
end $$;
revoke all on function public.setlist_absorb(uuid) from public, anon, authenticated;

-- 4b. Every page of a history read: drop the nights this read no longer saw
-- (gone or merged on setlist.fm — their data stays a cache, not an archive),
-- boil the book down and call it synced.
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
     where artist_id = a.artist_id and seen < coalesce(a.pass_at, now()) - interval '3 days';
    perform setlist_summarize(a.artist_id);
    update artist_history set status = 'ok', next_page = 0, synced_at = now(), detail = ''
     where artist_id = a.artist_id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.setlist_finish(uuid) from public, anon, authenticated;

-- 4c. Ask for the next thing one history needs, if nothing of its is in
-- flight and the service it would go to is ready for another request.
create or replace function public.setlist_fire(a_id uuid, who uuid default null)
returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare a record; rid bigint; tok text; is_house boolean; spent int; own int; key_owner uuid;
        ua constant text := 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/)';
begin
  select ah.*, ar.name as artist_name into a
    from artist_history ah join artists ar on ar.id = ah.artist_id
   where ah.artist_id = a_id
     for update of ah;
  if not found or a.status not in ('new', 'finding', 'checking', 'syncing') then return false; end if;
  if exists (select 1 from setlist_requests q where q.artist_id = a_id) then return false; end if;
  if a.fired_at is not null and a.fired_at > clock_timestamp() - interval '500 milliseconds' then return false; end if;
  -- A run of failures waits longer before each retry (15s, 30s, 1m, 2m, 4m,
  -- then 8m), so trouble at the other end is never answered by hammering it.
  if a.tries > 0 and a.fired_at is not null
     and a.fired_at > clock_timestamp() - interval '15 seconds' * (2 ^ least(a.tries - 1, 5)) then
    return false;
  end if;

  if a.status = 'checking' then
    -- A page just born from a tap: MusicBrainz confirms it by id (no key needed).
    if a.mbid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
    if not public.setlist_pace_ok('mb', interval '1100 milliseconds') then return false; end if;
    rid := net.http_get(url := 'https://musicbrainz.org/ws/2/artist/' || a.mbid,
      params := jsonb_build_object('fmt', 'json'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'));
    insert into setlist_requests (id, owner_id, artist_id, kind) values (rid, a.owner_id, a_id, 'mbget');
    update artist_history set fired_at = clock_timestamp() where artist_id = a_id;
    return true;
  end if;

  if a.mbid = '' then
    -- Find the band on MusicBrainz by name (open data, no key needed).
    if not public.setlist_pace_ok('mb', interval '1100 milliseconds') then return false; end if;
    rid := net.http_get(url := 'https://musicbrainz.org/ws/2/artist/',
      params := jsonb_build_object('query', 'artist:"' || replace(a.artist_name, '"', '') || '"',
                                   'fmt', 'json', 'limit', '5'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'));
    insert into setlist_requests (id, owner_id, artist_id, kind) values (rid, a.owner_id, a_id, 'mbid');
    update artist_history set status = 'finding', fired_at = clock_timestamp() where artist_id = a_id;
    return true;
  end if;

  if a.next_page < 1 then return false; end if;
  -- A page of setlists needs a key. A history Greenroom reads itself always
  -- reads with the house key, whichever account holds it today (and waits
  -- while there is none); any other reads with its owner's own.
  if a.auto then
    select sc.owner_id, sc.token, true into key_owner, tok, is_house
      from setlist_connect sc where sc.house and sc.status <> 'bad_token';
    if tok is not null and key_owner is distinct from a.owner_id then
      update artist_history set owner_id = key_owner where artist_id = a_id;
    end if;
  else
    select sc.owner_id, sc.token, sc.house into key_owner, tok, is_house
      from setlist_connect sc where sc.owner_id = a.owner_id and sc.status <> 'bad_token';
  end if;
  if tok is null then return false; end if;
  if is_house then
    -- Greenroom's own key feeds every unclaimed page: it stays inside
    -- setlist.fm's daily allowance and never asks twice in a second.
    select used into spent from setlist_budget where day = current_date;
    if coalesce(spent, 0) >= 1300 then
      update artist_history set detail = 'Greenroom has read its fill from setlist.fm today — the rest comes in tomorrow'
       where artist_id = a_id and detail not like 'Greenroom has read its fill%';
      return false;
    end if;
    if a.auto then
      if who is null then
        -- Reading nobody is watching (the minute tick) stops at 800 a day:
        -- the rest is kept for pages someone has open.
        if coalesce(spent, 0) >= 800 then return false; end if;
      else
        -- ...and no one account's looking takes more than its share.
        select u.house into own from setlist_user_day u where u.user_id = who and u.day = current_date;
        if coalesce(own, 0) >= 150 then return false; end if;
      end if;
    end if;
    if not public.setlist_pace_ok('house', interval '600 milliseconds') then return false; end if;
    insert into setlist_budget (day, used) values (current_date, 1)
    on conflict (day) do update set used = setlist_budget.used + 1;
    if a.auto and who is not null then
      insert into setlist_user_day (user_id, day, house) values (who, current_date, 1)
      on conflict (user_id, day) do update set house = setlist_user_day.house + 1;
    end if;
  end if;
  rid := net.http_get(url := 'https://api.setlist.fm/rest/1.0/artist/' || a.mbid || '/setlists',
    params := jsonb_build_object('p', a.next_page::text),
    headers := jsonb_build_object('x-api-key', tok, 'Accept', 'application/json', 'User-Agent', ua));
  -- (The key actually used is on the request, so a refusal flags the right one.)
  insert into setlist_requests (id, owner_id, artist_id, kind, meta)
    values (rid, key_owner, a_id, 'page', jsonb_build_object('page', a.next_page));
  update artist_history set status = 'syncing', fired_at = clock_timestamp(),
         detail = case when detail like 'Greenroom has read its fill%' then '' else detail end
   where artist_id = a_id;
  return true;
end $$;
drop function if exists public.setlist_fire(uuid);
revoke all on function public.setlist_fire(uuid, uuid) from public, anon, authenticated;

-- The tick, every minute now: read what came back, close finished reads,
-- start the due ones, let stale caches go, and ask for the next round.
create or replace function public.setlist_tick()
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare a record; took int := 0; fired int := 0;
begin
  if not exists (select 1 from artist_history) then return jsonb_build_object('idle', true); end if;

  took := public.setlist_absorb(null);
  -- Replies that never came stop blocking after an hour.
  delete from setlist_requests where fired_at < now() - interval '1 hour';
  perform public.setlist_finish(null);

  -- A history its owner reads with their own key is read fresh every day
  -- (new nights land on setlist.fm's first page). One Greenroom reads
  -- itself is read again when someone looks and it's a week old.
  update artist_history set status = 'syncing', next_page = 1, tries = 0, pass_at = now()
   where status = 'ok' and not auto and synced_at < now() - interval '24 hours';

  -- A replaced key un-parks every page the refused one stranded.
  update artist_history ah
     set status = case when ah.mbid = '' then 'new' else 'syncing' end, detail = '', tries = 0
    from setlist_connect sc
   where ah.status = 'bad_token' and sc.status <> 'bad_token'
     and (sc.owner_id = ah.owner_id or (ah.auto and sc.house));

  -- Borrowed data is a cache: an unclaimed page nobody has opened in 45
  -- days lets its nights go. They read back in the next time it's opened.
  for a in select ah.artist_id from artist_history ah join artists ar on ar.id = ah.artist_id
            where ah.auto and ar.owner_id is null and ah.status = 'ok'
              and coalesce(ah.viewed_at, ah.created_at) < now() - interval '45 days'
  loop
    delete from artist_history_shows where artist_id = a.artist_id;
    update artist_history set status = 'idle', summary = '{}'::jsonb, total = 0, pages = 0, next_page = 1, synced_at = null
     where artist_id = a.artist_id;
  end loop;

  -- A page made from a tap that MusicBrainz never confirmed doesn't stay.
  delete from artists where owner_id is null and not checked and created_at < now() - interval '3 hours';
  delete from setlist_user_day where day < current_date - 7;

  -- Ask for the next round: the pages people looked at most recently first.
  for a in select ah.artist_id from artist_history ah
            where ah.status in ('new', 'finding', 'checking', 'syncing')
            order by ah.viewed_at desc nulls last, ah.created_at
  loop
    if public.setlist_fire(a.artist_id) then fired := fired + 1; end if;
  end loop;

  return jsonb_build_object('took', took, 'fired', fired);
end $$;
revoke all on function public.setlist_tick() from public, anon, authenticated;

do $do$
begin
  perform cron.unschedule('greenroom-setlist')
    where exists (select 1 from cron.job where jobname = 'greenroom-setlist');
  perform cron.schedule('greenroom-setlist', '* * * * *', 'select public.setlist_tick()');
end $do$;

-- Someone has a page open: step its history along now instead of waiting
-- for the minute. Reads what came back, and (for a history Greenroom reads
-- itself, or your own page) asks for the next page. A cache that went stale,
-- or was let go, starts reading again because it's wanted. "fresh" restarts
-- it: for the page's owner or an admin only.
create or replace function public.artist_history_nudge(a_id uuid, fresh boolean default false)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare a record; mine boolean;
begin
  if auth.uid() is null then return null; end if;
  select ah.*, ar.owner_id as page_owner into a
    from artist_history ah join artists ar on ar.id = ah.artist_id
   where ah.artist_id = a_id;
  if not found then return null; end if;
  mine := a.page_owner is not null and a.page_owner = auth.uid();
  update artist_history set viewed_at = now()
   where artist_id = a_id and (viewed_at is null or viewed_at < now() - interval '1 minute');
  if (coalesce(fresh, false) and (mine or public.is_admin()) and a.status in ('ok', 'idle', 'error'))
     or (a.auto and (a.status = 'idle' or (a.status = 'ok' and a.synced_at < now() - interval '7 days'))) then
    update artist_history set status = 'syncing', next_page = 1, tries = 0, detail = '', pass_at = now()
     where artist_id = a_id and mbid <> '';
  elsif a.auto and a.status = 'error' and coalesce(a.fired_at, a.created_at) < now() - interval '30 minutes' then
    -- Nobody owns this history to restart it: once it has cooled off and
    -- someone looks, it picks up where it stopped.
    update artist_history h
       set status = case when exists (select 1 from artists ar where ar.id = a_id and not ar.checked)
                         then 'checking' else 'syncing' end,
           tries = 0, detail = ''
     where h.artist_id = a_id;
  end if;
  perform public.setlist_absorb(a_id);
  perform public.setlist_finish(a_id);
  if a.auto or mine then perform public.setlist_fire(a_id, auth.uid()); end if;
  -- waiting: still to read, but not today (Greenroom's allowance, or this
  -- account's share of it, is used up) or not yet (no key to read with).
  return (select to_jsonb(x) from (
    select h.artist_id, h.status, h.detail, h.total, h.pages, h.next_page, h.summary, h.synced_at, h.mb_url, h.auto,
           (h.auto and h.status = 'syncing' and (
              coalesce((select b.used from setlist_budget b where b.day = current_date), 0) >= 1300
              or coalesce((select u.house from setlist_user_day u where u.user_id = auth.uid() and u.day = current_date), 0) >= 150
              or not exists (select 1 from setlist_connect sc where sc.house and sc.status <> 'bad_token'))) as waiting
      from artist_history h where h.artist_id = a_id) x);
end $$;
revoke all on function public.artist_history_nudge(uuid, boolean) from public, anon;
grant execute on function public.artist_history_nudge(uuid, boolean) to authenticated;

-- Switching a history on with your own key: only on a verified page now
-- (see the top of this file), and it keeps the act the page already is.
create or replace function public.artist_history_start(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare known text;
begin
  if auth.uid() is null or not public.runs_artist(a_id) then
    raise exception 'permission' using errcode = '42501';
  end if;
  if not exists (select 1 from artists where id = a_id and verified) then
    raise exception 'verify first' using errcode = '22023';
  end if;
  if not exists (select 1 from setlist_connect where owner_id = auth.uid()) then
    raise exception 'connect first' using errcode = '22023';
  end if;
  select mbid into known from artists where id = a_id;
  -- A fresh start reads a fresh book: whatever an earlier run fetched goes.
  delete from artist_history_shows where artist_id = a_id;
  insert into artist_history (artist_id, owner_id, mbid, status, auto, pass_at)
  values (a_id, auth.uid(), coalesce(known, ''), case when coalesce(known, '') <> '' then 'syncing' else 'new' end, false, now())
  on conflict (artist_id) do update
    set status = case when coalesce(known, '') <> '' then 'syncing' else 'new' end,
        detail = '', mbid = coalesce(known, ''), next_page = 1, pages = 0, total = 0, tries = 0,
        summary = '{}'::jsonb, synced_at = null, auto = false, pass_at = now(),
        owner_id = excluded.owner_id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.artist_history_start(uuid) from public, anon;
grant execute on function public.artist_history_start(uuid) to authenticated;

-- 5. Opening an act from Search. Hands back its page if it has one (a page
-- someone runs first, else the unclaimed one); if not, makes the unclaimed
-- page and starts the encyclopedia check. The name sent by the phone is only
-- a placeholder until MusicBrainz answers; such a page stays out of Search
-- until then, and an account can make only so many a day.
create or replace function public.artist_open_mb(mb_id text, name_hint text default '')
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); aid uuid; house_owner uuid; made int; nm text;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  mb_id := lower(btrim(coalesce(mb_id, '')));
  if mb_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'not an id' using errcode = '22023';
  end if;
  select a.id into aid from artists a where a.mbid = mb_id
   order by (a.owner_id is not null) desc, a.verified desc, a.created_at limit 1;
  if found then return jsonb_build_object('id', aid, 'made', false); end if;

  -- Thirty new pages a day per account, counted as they are made: one
  -- deleted later (not an act after all) doesn't give its slot back.
  insert into setlist_user_day (user_id, day, opened) values (me, current_date, 1)
  on conflict (user_id, day) do update set opened = setlist_user_day.opened + 1
  returning opened into made;
  if made > 30 then raise exception 'too many today' using errcode = '22023'; end if;

  nm := left(btrim(regexp_replace(coalesce(name_hint, ''), '[[:cntrl:]]', '', 'g')), 60);
  if nm = '' then nm := 'Artist'; end if;
  insert into artists (owner_id, handle, name, mbid, checked, created_by)
  values (null, 'mb.' || left(replace(gen_random_uuid()::text, '-', ''), 20), nm, mb_id, false, me)
  on conflict (mbid) where owner_id is null and mbid <> '' do nothing
  returning id into aid;
  if aid is null then
    -- Someone else's tap made it in this same moment.
    select a.id into aid from artists a where a.mbid = mb_id order by a.created_at limit 1;
    if aid is null then raise exception 'try again' using errcode = '22023'; end if;
    -- (That tap made nothing: it doesn't count against the day.)
    update setlist_user_day set opened = greatest(0, opened - 1) where user_id = me and day = current_date;
    return jsonb_build_object('id', aid, 'made', false);
  end if;

  -- Its history reads with Greenroom's own key (or waits for one).
  select sc.owner_id into house_owner from setlist_connect sc where sc.house limit 1;
  insert into artist_history (artist_id, owner_id, mbid, status, auto, viewed_at)
  values (aid, coalesce(house_owner, me), mb_id, 'checking', true, now())
  on conflict (artist_id) do nothing;
  perform public.setlist_fire(aid, me);
  return jsonb_build_object('id', aid, 'made', true);
end $$;
revoke all on function public.artist_open_mb(text, text) from public, anon;
grant execute on function public.artist_open_mb(text, text) to authenticated;

-- 6. Claims. One per person per page: who they are to the act, and where
-- that can be checked. Waiting until an admin answers.
create table if not exists public.artist_claims (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.artists (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  note text not null default '' check (char_length(note) <= 500),
  link text not null default '' check (char_length(link) <= 200),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid,
  unique (artist_id, user_id)
);
create index if not exists artist_claims_pending on public.artist_claims (status, created_at);
alter table public.artist_claims enable row level security;
drop policy if exists artist_claims_select on public.artist_claims;
create policy artist_claims_select on public.artist_claims for select
  using (user_id = auth.uid() or public.is_admin());
revoke all on public.artist_claims from public, anon, authenticated;
grant select on public.artist_claims to authenticated;

-- Asking for a page nobody runs. Sending again (after a no, or to say more)
-- puts it back in the queue.
create or replace function public.claim_artist(a_id uuid, note text, link text default '')
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); n int; said text; url text;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  if not exists (select 1 from artists a where a.id = a_id and a.owner_id is null and a.checked) then
    return jsonb_build_object('ok', false, 'why', 'taken');
  end if;
  said := left(btrim(coalesce(note, '')), 500);
  url := left(btrim(coalesce(link, '')), 200);
  if char_length(said) < 3 then raise exception 'say who you are' using errcode = '22023'; end if;
  select count(*) into n from artist_claims c where c.user_id = me and c.status = 'pending' and c.artist_id <> a_id;
  if n >= 10 then raise exception 'too many waiting' using errcode = '22023'; end if;
  insert into artist_claims (artist_id, user_id, note, link)
  values (a_id, me, said, url)
  on conflict (artist_id, user_id) do update
    set note = excluded.note, link = excluded.link, status = 'pending', created_at = now(),
        decided_at = null, decided_by = null;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.claim_artist(uuid, text, text) from public, anon;
grant execute on function public.claim_artist(uuid, text, text) to authenticated;

create or replace function public.withdraw_claim(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'permission' using errcode = '42501'; end if;
  delete from artist_claims where artist_id = a_id and user_id = auth.uid() and status = 'pending';
  return jsonb_build_object('ok', found);
end $$;
revoke all on function public.withdraw_claim(uuid) from public, anon;
grant execute on function public.withdraw_claim(uuid) to authenticated;

-- Your own claims and where they stand.
create or replace function public.my_claims()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('artistId', a.id, 'artist', a.name, 'status', c.status,
           'at', c.created_at, 'mine', coalesce(a.owner_id = auth.uid(), false)) order by c.created_at desc), '[]'::jsonb)
    from artist_claims c join artists a on a.id = c.artist_id
   where auth.uid() is not null and c.user_id = auth.uid()
$$;
revoke all on function public.my_claims() from public, anon;
grant execute on function public.my_claims() to authenticated;

-- For an admin: every claim waiting, with enough about the person to judge
-- it. Null for everyone else (so the app knows not to show the door).
create or replace function public.claim_queue()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then return null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', c.id, 'artistId', a.id, 'artist', a.name, 'about', a.about, 'country', a.country,
        'userId', c.user_id, 'name', public.person_name(c.user_id),
        'handle', coalesce(p.handle, ''), 'avatar', coalesce(p.avatar, ''),
        'roles', to_jsonb(coalesce(p.roles, '{}'::text[])), 'tourRole', coalesce(p.tour_role, ''),
        'email', coalesce((select u.email from auth.users u where u.id = c.user_id), ''),
        'note', c.note, 'link', c.link, 'at', c.created_at,
        'others', (select count(*) from artist_claims o where o.artist_id = c.artist_id and o.status = 'pending' and o.id <> c.id))
      order by c.created_at)
      from artist_claims c
      join artists a on a.id = c.artist_id
      left join profiles p on p.user_id = c.user_id
     where c.status = 'pending'), '[]'::jsonb);
end $$;
revoke all on function public.claim_queue() from public, anon;
grant execute on function public.claim_queue() to authenticated;

-- A username made from the act's name, if nobody has it (people or artists).
create or replace function public.artist_free_slug(nm text)
returns text
language plpgsql stable security definer set search_path = public as $$
declare s text := left(regexp_replace(lower(coalesce(nm, '')), '[^a-z0-9]+', '', 'g'), 24);
begin
  if char_length(s) < 3 or s in ('greenroom', 'admin', 'support', 'help', 'official', 'staff', 'ari', 'everyone', 'here') then
    return null;
  end if;
  if exists (select 1 from artists a where a.handle = s) or exists (select 1 from profiles p where p.handle = s) then
    return null;
  end if;
  return s;
end $$;
revoke all on function public.artist_free_slug(text) from public, anon, authenticated;

-- The admin's answer. Yes: the page is theirs, verified, with a proper
-- username when the act's name is free; anyone else waiting on it is told no.
create or replace function public.decide_claim(c_id uuid, approve boolean)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare c public.artist_claims%rowtype; slug text;
begin
  if not public.is_admin() then raise exception 'permission' using errcode = '42501'; end if;
  select * into c from artist_claims where id = c_id for update;
  if not found or c.status <> 'pending' then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  if not coalesce(approve, false) then
    update artist_claims set status = 'declined', decided_at = now(), decided_by = auth.uid() where id = c_id;
    return jsonb_build_object('ok', true);
  end if;
  select public.artist_free_slug(a.name) into slug from artists a where a.id = c.artist_id;
  update artists set owner_id = c.user_id, verified = true, claimed_at = now(),
         handle = coalesce(slug, handle)
   where id = c.artist_id and owner_id is null;
  if not found then
    update artist_claims set status = 'declined', decided_at = now(), decided_by = auth.uid() where id = c_id;
    return jsonb_build_object('ok', false, 'why', 'taken');
  end if;
  update artist_claims set status = 'approved', decided_at = now(), decided_by = auth.uid() where id = c_id;
  update artist_claims set status = 'declined', decided_at = now(), decided_by = auth.uid()
   where artist_id = c.artist_id and id <> c_id and status = 'pending';
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.decide_claim(uuid, boolean) from public, anon;
grant execute on function public.decide_claim(uuid, boolean) to authenticated;

-- 7. The cards and lists that say whether a page is run by anyone.
create or replace function public.artist_card(a_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a public.artists%rowtype;
begin
  if auth.uid() is null then return null; end if;
  select * into a from artists where id = a_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', a.id, 'handle', a.handle, 'name', a.name, 'bio', a.bio, 'avatar', a.avatar,
    'mine', coalesce(a.owner_id = auth.uid(), false),
    -- Nobody runs it yet: what the encyclopedia says about the act, and
    -- where the caller's own claim on it stands.
    'unclaimed', a.owner_id is null, 'verified', a.verified, 'about', a.about, 'country', a.country,
    'myClaim', (select c.status from artist_claims c where c.artist_id = a.id and c.user_id = auth.uid()),
    'followers', (select count(*) from artist_follows f where f.artist_id = a.id),
    'iFollow', exists (select 1 from artist_follows f where f.artist_id = a.id and f.user_id = auth.uid()),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
          'userId', m.user_id, 'kind', m.kind, 'role', coalesce(m.role, ''),
          'hasCredits', coalesce(a.owner_id = auth.uid(), false) and exists (select 1 from tour_credits tc
             where tc.artist_id = a.id and tc.user_id = m.user_id and tc.approved is not null),
          'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
          'handle', coalesce(p.handle, ''), 'avatar', coalesce(p.avatar, ''),
          'roles', to_jsonb(coalesce(p.roles, '{}'::text[])), 'tourRole', coalesce(p.tour_role, ''),
          'verified', exists (select 1 from verified_users v where v.user_id = m.user_id),
          'canOpen', public.can_see_profile(m.user_id),
          'endorsed', exists (select 1 from artist_endorsements e where e.artist_id = a.id and e.user_id = m.user_id and e.removed_at is null),
          -- They took this page's endorsement off theirs: its owner gets no Endorse button for them again.
          'declined', coalesce(a.owner_id = auth.uid(), false)
            and exists (select 1 from artist_endorsements e where e.artist_id = a.id and e.user_id = m.user_id and e.removed_at is not null))
        order by m.created_at)
      from artist_members m left join profiles p on p.user_id = m.user_id where m.artist_id = a.id), '[]'::jsonb),
    'tours', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', t.id, 'artist', a.name, 'name', trim(coalesce(t.doc ->> 'name', '')),
          'first', (select min(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x),
          'last', (select max(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x),
          'shows', jsonb_array_length(public.tour_dates(t.doc)),
          'mine', public.my_role(t.id) is not null)
        order by (select max(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x) desc nulls last, t.id)
      from public.artist_tours(a.id) t), '[]'::jsonb));
end $$;
revoke all on function public.artist_card(uuid) from public, anon;
grant execute on function public.artist_card(uuid) to authenticated;

-- Search finds unclaimed pages too, and says so.
create or replace function public.find_artists(q text)
returns jsonb
language sql stable security definer set search_path = public as $$
  with term as (select replace(replace(lower(trim(both '@ ' from coalesce(q, ''))), '%', ''), '_', '\_') as t)
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'handle', x.handle, 'avatar', x.avatar,
           'mine', coalesce(x.owner_id = auth.uid(), false), 'unclaimed', x.owner_id is null,
           'mbid', x.mbid, 'about', x.about) order by x.rank, x.name), '[]'::jsonb)
  from (
    select a.*, case when a.handle = term.t or lower(a.name) = term.t then 0
                     when a.handle like term.t || '%' or lower(a.name) like term.t || '%' then 1 else 2 end as rank
      from artists a, term
     where auth.uid() is not null and char_length(term.t) >= 2
       -- a page just made from a tap stays out until MusicBrainz confirms it
       and a.checked
       and (a.handle like term.t || '%' or lower(a.name) like '%' || term.t || '%')
     order by rank, a.name limit 12
  ) x
$$;
revoke all on function public.find_artists(text) from public, anon;
grant execute on function public.find_artists(text) to authenticated;

-- Search before you type (0059), now saying whether each page is run by anyone.
create or replace function public.search_suggestions()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return null; end if;
  return jsonb_build_object(
    -- The people you follow, newest first.
    'following', coalesce((
      select jsonb_agg(public.person_row(f.followee_id) order by f.created_at desc)
        from (select x.* from follows x
               where x.follower_id = me and exists (select 1 from profiles p where p.user_id = x.followee_id)
               order by x.created_at desc limit 20) f), '[]'::jsonb),
    -- The people on your tours you don't follow yet, latest tour first.
    'crew', coalesce((
      select jsonb_agg(public.person_row(c.u) order by c.at desc)
        from (select y.u, max(y.at) as at
                from (select t.owner_id as u, t.updated_at as at from public.tours_of(me) t
                      union all
                      select m.user_id, t.updated_at from public.tours_of(me) t
                        join members m on m.tour_id = t.id
                       where m.user_id is not null) y
               where y.u <> me
                 and not exists (select 1 from follows f where f.follower_id = me and f.followee_id = y.u)
                 and exists (select 1 from profiles p where p.user_id = y.u)
               group by y.u
               order by max(y.at) desc
               limit 20) c), '[]'::jsonb),
    -- Artist pages: yours, the ones you're on, the ones whose tours you're on.
    'artists', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'handle', a.handle, 'name', a.name, 'avatar', coalesce(a.avatar, ''),
               'iFollow', a.ord = -1, 'unclaimed', a.owner_id is null, 'about', a.about)
             order by a.ord, lower(a.name))
        from (select x.*, case when exists (select 1 from artist_follows f where f.artist_id = x.id and f.user_id = me) then -1
                               when x.owner_id = me then 0
                               when exists (select 1 from artist_members m where m.artist_id = x.id and m.user_id = me) then 1
                               else 2 end as ord
                from artists x
               where exists (select 1 from artist_follows f where f.artist_id = x.id and f.user_id = me)
                  or x.owner_id = me
                  or exists (select 1 from artist_members m where m.artist_id = x.id and m.user_id = me)
                  or exists (select 1 from public.tours_of(me) t
                              where t.owner_id = x.owner_id
                                and lower(trim(coalesce(t.doc ->> 'artist', ''))) = lower(trim(x.name)))
               order by ord, x.name limit 16) a), '[]'::jsonb));
end $$;
revoke all on function public.search_suggestions() from public, anon;
grant execute on function public.search_suggestions() to authenticated;

-- Your own pages first (a page nobody runs has no 'mine').
create or replace function public.my_artists()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'handle', a.handle, 'name', a.name, 'avatar', a.avatar,
           'mine', coalesce(a.owner_id = auth.uid(), false),
           'kind', (select m.kind from artist_members m where m.artist_id = a.id and m.user_id = auth.uid()))
         order by coalesce(a.owner_id = auth.uid(), false) desc, a.created_at), '[]'::jsonb)
    from artists a
   where a.owner_id = auth.uid()
      or exists (select 1 from artist_members m where m.artist_id = a.id and m.user_id = auth.uid())
$$;
revoke all on function public.my_artists() from public, anon;
grant execute on function public.my_artists() to authenticated;

notify pgrst, 'reload schema';
