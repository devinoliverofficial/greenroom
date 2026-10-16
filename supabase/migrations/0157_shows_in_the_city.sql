-- Shows in the city (Devin, 2026-10-15): on a show day the day sheet also
-- lists the other concerts in that city that night, so the tour knows what
-- else is pulling people downtown.
--
-- Where the listings come from: Ticketmaster's Discovery API (the research
-- settled on it - free, and it filters by city, date and music in one ask).
-- Their terms are respected the way they ask to be: the app shows each
-- event's own Ticketmaster link and says the listings are theirs, and
-- NOTHING IS STORED LONG - one little cache row per city per day, so one ask
-- serves the whole tour all day, and every row is swept two days on. The
-- rows hold only what the sheet shows: a name, a venue, a time, a link.
--
-- The key: a secret named 'ticketmaster_key' typed into the dashboard's
-- Vault, the 0085 pattern. It rides the one ask and is never written to a
-- table, never logged, never part of an answer. No key in Vault: the ask
-- answers {off: true} and the app stays silent - the feature simply is not
-- there until the key is.
--
-- How a phone gets the list: city_events_ask answers the cache when the
-- city's day is already in it; otherwise it fires the one ask and answers
-- {wait: request_id}, and the phone polls city_events_take (the way the
-- tour finder's answer is polled) until the answer lands in the cache.
-- Both doors check the caller is on the tour (on_tour), and both read the
-- show's city and date from the tour's own document, so a phone cannot ask
-- about a city its tour is not in.

-- ---------------------------------------------------------------------------
-- 1. The cache: one row per city per day, nothing else, nothing for long
-- ---------------------------------------------------------------------------
create table if not exists public.city_event_cache (
  -- the city as the counting rules spell it (road_city_key), so two tours in
  -- "Montréal" and "montreal" share the one ask
  city_key text not null check (char_length(city_key) between 1 and 80),
  day date not null,
  -- at most six events, each only { name, venue, time, url }
  payload jsonb not null default '[]'::jsonb
    check (jsonb_typeof(payload) = 'array' and jsonb_array_length(payload) <= 6),
  fetched_at timestamptz not null default now(),
  primary key (city_key, day)
);
alter table public.city_event_cache enable row level security;
-- No phone reads or writes this table itself: the two definer functions
-- below are the only doors, and they answer only people on the show's tour.
revoke all on public.city_event_cache from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. What a day sheet is handed: the cached events, minus the tour's own room
-- ---------------------------------------------------------------------------
-- The night's own show is on Ticketmaster too; the sheet should not tell the
-- band their own concert is also in town. A show with no venue typed keeps
-- the whole list. At most five rows reach a phone.
create or replace function public.city_events_pick(payload jsonb, v text)
returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(q.e), '[]'::jsonb) from (
    select e from jsonb_array_elements(case when jsonb_typeof(payload) = 'array' then payload else '[]'::jsonb end) e
     where btrim(coalesce(v, '')) = ''
        or lower(btrim(coalesce(e ->> 'venue', ''))) <> lower(btrim(v))
     limit 5) q
$$;
revoke all on function public.city_events_pick(jsonb, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The ask: cache first, else the one request, else {off: true}
-- ---------------------------------------------------------------------------
create or replace function public.city_events_ask(t_id text, s_id text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s jsonb; city text; d date; ck text; key text; c record; rid bigint;
        ua constant text := 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/)';
begin
  if auth.uid() is null or not public.on_tour(t_id, auth.uid()) then
    raise exception 'permission' using errcode = '42501';
  end if;
  -- The show's city and date come from the tour's own document, never from
  -- the phone, so the answer is always about a night this tour really has.
  select t.doc -> 'shows' -> s_id into s from tours t where t.id = t_id;
  city := btrim(coalesce(s ->> 'city', ''));
  if city = '' or coalesce(s ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    return jsonb_build_object('none', true);
  end if;
  d := (s ->> 'date')::date;
  -- Nothing is stored long: every pass sweeps rows older than two days, so
  -- the cache never grows into a copy of anybody's listings.
  delete from city_event_cache where fetched_at < now() - interval '2 days';
  ck := public.road_city_key(city);
  select * into c from city_event_cache where city_key = ck and day = d;
  if found then
    return jsonb_build_object('events', public.city_events_pick(c.payload, s ->> 'venue'));
  end if;
  -- The key lives in Vault under 'ticketmaster_key' (typed into the
  -- dashboard, never through chat or code). It rides this one ask and is
  -- never logged and never part of what comes back.
  select vs.decrypted_secret into key from vault.decrypted_secrets vs where vs.name = 'ticketmaster_key' limit 1;
  if key is null then
    return jsonb_build_object('off', true);
  end if;
  -- One ask for the whole tour's day: this city, music, the show's own local
  -- date from midnight to midnight, six events at most.
  rid := net.http_get(url := 'https://app.ticketmaster.com/discovery/v2/events.json',
    params := jsonb_build_object('apikey', key,
      'city', btrim(split_part(city, ',', 1)),
      'localStartDateTime', to_char(d, 'YYYY-MM-DD') || 'T00:00:00,' || to_char(d, 'YYYY-MM-DD') || 'T23:59:59',
      'classificationName', 'music', 'size', '6', 'sort', 'date,asc'),
    headers := jsonb_build_object('Accept', 'application/json', 'User-Agent', ua),
    timeout_milliseconds := 15000);
  return jsonb_build_object('wait', rid);
end $$;
revoke all on function public.city_events_ask(text, text) from public, anon;
grant execute on function public.city_events_ask(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The take: read the answer by its request id, cache it, hand it over
-- ---------------------------------------------------------------------------
create or replace function public.city_events_take(req_id bigint, t_id text, s_id text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s jsonb; city text; d date; ck text; resp record; body jsonb; evs jsonb;
begin
  if auth.uid() is null or not public.on_tour(t_id, auth.uid()) then
    raise exception 'permission' using errcode = '42501';
  end if;
  select t.doc -> 'shows' -> s_id into s from tours t where t.id = t_id;
  city := btrim(coalesce(s ->> 'city', ''));
  if city = '' or coalesce(s ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    return jsonb_build_object('none', true);
  end if;
  d := (s ->> 'date')::date;
  ck := public.road_city_key(city);
  -- Another phone's take may have landed it already: the cache answers first.
  select payload into evs from city_event_cache where city_key = ck and day = d;
  if found then
    return jsonb_build_object('events', public.city_events_pick(evs, s ->> 'venue'));
  end if;
  select r.status_code, r.content into resp from net._http_response r where r.id = req_id;
  if not found then
    -- Still on its way: the phone asks again in a few seconds.
    return jsonb_build_object('wait', req_id);
  end if;
  evs := '[]'::jsonb;
  if resp.status_code = 200 then
    begin
      body := resp.content::jsonb;
      -- Only what the sheet shows is kept: a name, a venue, a local time said
      -- the way the day sheet says times, and the event's own Ticketmaster
      -- link (their terms want that link shown). Nothing else of theirs.
      select coalesce(jsonb_agg(jsonb_build_object(
          'name', left(btrim(coalesce(q.e ->> 'name', '')), 120),
          'venue', left(btrim(coalesce(q.e -> '_embedded' -> 'venues' -> 0 ->> 'name', '')), 120),
          'time', case when coalesce(q.e -> 'dates' -> 'start' ->> 'localTime', '') ~ '^\d{2}:\d{2}'
                       then to_char((q.e -> 'dates' -> 'start' ->> 'localTime')::time, 'FMHH12:MI PM') else '' end,
          'url', case when coalesce(q.e ->> 'url', '') like 'https://%' then left(q.e ->> 'url', 300) else '' end)), '[]'::jsonb)
        into evs
        from (select x as e from jsonb_array_elements(coalesce(body -> '_embedded' -> 'events', '[]'::jsonb)) x limit 6) q;
    exception when others then
      evs := '[]'::jsonb;  -- an answer that was not the shape promised reads as an empty night
    end;
  end if;
  -- A turned-away ask (bad key, rate limit) is kept as an empty night too, so
  -- phones do not hammer the service; the two-day sweep forgets it.
  insert into city_event_cache (city_key, day, payload, fetched_at)
  values (ck, d, evs, now())
  on conflict (city_key, day) do update set payload = excluded.payload, fetched_at = excluded.fetched_at;
  return jsonb_build_object('events', public.city_events_pick(evs, s ->> 'venue'));
end $$;
revoke all on function public.city_events_take(bigint, text, text) from public, anon;
grant execute on function public.city_events_take(bigint, text, text) to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop function if exists public.city_events_take(bigint, text, text);
--   drop function if exists public.city_events_ask(text, text);
--   drop function if exists public.city_events_pick(jsonb, text);
--   drop table if exists public.city_event_cache;
--   notify pgrst, 'reload schema';
-- The app probes for city_events_ask and simply stops drawing the block;
-- nothing else leans on any of this, and nothing of Ticketmaster's remains.
