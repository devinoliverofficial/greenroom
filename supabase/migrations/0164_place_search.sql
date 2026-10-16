-- Spots learn to find places (Devin, 2026-10-16: "Can we connect this to
-- something like yelp so that it finds places and all the info/ratings.
-- This way when you search places in greenroom places start to pop up as
-- you type").
--
-- Where the answers come from: Photon (photon.komoot.io), the OpenStreetMap
-- geocoder komoot runs for everyone. The research settled it: it is the one
-- free door that EXPRESSLY allows search-as-you-type (Nominatim's own policy
-- forbids autocomplete), it needs no key, and its data is OpenStreetMap's
-- (ODbL): storing and showing is allowed when OpenStreetMap is named, so
-- the picker in the app carries an OpenStreetMap line. Ratings are not in
-- this road - no free service hands out ratings - so the picker fills the
-- place's name, kind and city, and ratings wait on a keyed service if Devin
-- ever wants one.
--
-- The shape is 0157's ask/take, keyless: the phone asks with what was
-- typed, the ask answers the cache or fires ONE polite request and says
-- wait, the take reads the answer, trims it to what the picker shows, and
-- caches it so the next person typing the same thing costs nothing. Komoot
-- asks for fairness, not a number: the app debounces its asks, the house
-- pace gate keeps one request every 300 milliseconds across everyone, and
-- the cache holds a week, so a day of touring costs a handful of asks.

-- ---------------------------------------------------------------------------
-- 1. The cache: one row per typed search, at most eight places, a week
-- ---------------------------------------------------------------------------
create table if not exists public.place_search_cache (
  -- the typed words, lower-cased and squeezed, so "Blue  Bottle" and
  -- "blue bottle" share one row
  q_key text primary key check (char_length(q_key) between 2 and 80),
  -- at most eight places, each only { name, kind, city, state, country }
  payload jsonb not null default '[]'::jsonb
    check (jsonb_typeof(payload) = 'array' and jsonb_array_length(payload) <= 8),
  fetched_at timestamptz not null default now()
);
alter table public.place_search_cache enable row level security;
-- Phones never read the cache raw; the two doors below hand out its rows.
revoke all on public.place_search_cache from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The ask: cache first, else one polite request and a wait ticket
-- ---------------------------------------------------------------------------
create or replace function public.place_search_ask(q text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare qk text; c record; rid bigint;
        ua constant text := 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/)';
begin
  if auth.uid() is null then
    raise exception 'permission' using errcode = '42501';
  end if;
  qk := btrim(regexp_replace(lower(coalesce(q, '')), '\s+', ' ', 'g'));
  if char_length(qk) < 2 or char_length(qk) > 80 then
    return jsonb_build_object('none', true);
  end if;
  -- The sweep: a week on, a search is asked again, so the cache never grows
  -- into a copy of the map.
  delete from place_search_cache where fetched_at < now() - interval '7 days';
  select * into c from place_search_cache where q_key = qk;
  if found then
    return jsonb_build_object('places', c.payload);
  end if;
  -- One request every 300 milliseconds across the whole house: komoot asks
  -- for fairness, and a burst of typing becomes a handful of cache rows,
  -- not a stream of requests. Told to wait, the phone simply asks again.
  if not public.setlist_pace_ok('photon', interval '300 milliseconds') then
    return jsonb_build_object('busy', true);
  end if;
  rid := net.http_get(url := 'https://photon.komoot.io/api',
    params := jsonb_build_object('q', qk, 'limit', '8', 'lang', 'en'),
    headers := jsonb_build_object('Accept', 'application/json', 'User-Agent', ua),
    timeout_milliseconds := 10000);
  return jsonb_build_object('wait', rid);
end $$;
revoke all on function public.place_search_ask(text) from public, anon;
grant execute on function public.place_search_ask(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The take: read the answer, keep only what the picker shows, cache it
-- ---------------------------------------------------------------------------
create or replace function public.place_search_take(req_id bigint, q text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare qk text; resp record; body jsonb; rows_ jsonb;
begin
  if auth.uid() is null then
    raise exception 'permission' using errcode = '42501';
  end if;
  qk := btrim(regexp_replace(lower(coalesce(q, '')), '\s+', ' ', 'g'));
  if char_length(qk) < 2 or char_length(qk) > 80 then
    return jsonb_build_object('none', true);
  end if;
  -- Another phone's take may have landed it already: the cache answers first.
  select payload into rows_ from place_search_cache where q_key = qk;
  if found then
    return jsonb_build_object('places', rows_);
  end if;
  select r.status_code, r.content into resp from net._http_response r where r.id = req_id;
  if not found then
    return jsonb_build_object('wait', req_id);
  end if;
  rows_ := '[]'::jsonb;
  if resp.status_code = 200 then
    begin
      body := resp.content::jsonb;
      -- Only what the picker shows: the place's name, what OpenStreetMap
      -- calls it (the app turns that word into its own kinds), and where it
      -- is. Places without a name (bare addresses, streets) are left out.
      select coalesce(jsonb_agg(jsonb_build_object(
          'name', left(btrim(q2.p ->> 'name'), 120),
          'kind', left(btrim(coalesce(q2.p ->> 'osm_value', '')), 60),
          'city', left(btrim(coalesce(q2.p ->> 'city', '')), 80),
          'state', left(btrim(coalesce(q2.p ->> 'state', '')), 80),
          'country', left(btrim(coalesce(q2.p ->> 'country', '')), 80))), '[]'::jsonb)
        into rows_
        from (select x -> 'properties' as p
                from jsonb_array_elements(coalesce(body -> 'features', '[]'::jsonb)) x
               where btrim(coalesce(x -> 'properties' ->> 'name', '')) <> ''
               limit 8) q2;
    exception when others then
      rows_ := '[]'::jsonb;  -- an answer that was not the shape promised reads as nothing found
    end;
  end if;
  -- A turned-away ask is cached as nothing found too, so phones do not
  -- hammer the service; the week's sweep forgets it.
  insert into place_search_cache (q_key, payload, fetched_at)
  values (qk, rows_, now())
  on conflict (q_key) do update set payload = excluded.payload, fetched_at = excluded.fetched_at;
  return jsonb_build_object('places', rows_);
end $$;
revoke all on function public.place_search_take(bigint, text) from public, anon;
grant execute on function public.place_search_take(bigint, text) to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop function if exists public.place_search_take(bigint, text);
--   drop function if exists public.place_search_ask(text);
--   drop table if exists public.place_search_cache;
--   notify pgrst, 'reload schema';
-- The app's probe finds no function and the Spots picker simply types plain
-- again. Nothing personal was stored: cache rows hold typed words and
-- public map facts only, and sweep themselves within a week.
