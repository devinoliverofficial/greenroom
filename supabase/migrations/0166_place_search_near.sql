-- Spots search like the map in his pocket (Devin, 2026-10-16, with a photo:
-- typing "Dunk" in a map app shows the Dunkin' branches NEAR HIM, each with
-- its street). 0164 searched the whole world by name, so "dunkin" answered
-- anywhere. Now the ask can carry where the search is from - the sheet's
-- city, or tonight's - and the answers lean to that town and bring their
-- street addresses. Checked against his photo before writing: Photon biased
-- to Houston answers the very branches his screenshot shows, street for
-- street.
--
-- How: one extra, cached hop. A city's centre is asked of Photon once
-- (osm_tag=place keeps a bar named Houston out of it) and remembered for a
-- month; the place search then rides that centre. The take hands the phone
-- a fresh wait ticket when the city hop lands first, and the phone simply
-- keeps polling. Everything else is 0164's: same politeness, same caps,
-- same sweep, nothing personal stored - typed words, town names and public
-- map facts.

-- ---------------------------------------------------------------------------
-- 1. City centres, remembered a month
-- ---------------------------------------------------------------------------
create table if not exists public.place_city_cache (
  city_key text primary key check (char_length(city_key) between 1 and 80),
  lat double precision,
  lon double precision,
  fetched_at timestamptz not null default now()
);
alter table public.place_city_cache enable row level security;
revoke all on public.place_city_cache from public, anon, authenticated;

-- The search cache learns to keep one row per search PER TOWN, and each
-- place its street. Cache rows are a week's convenience, so the table is
-- simply rebuilt in the new shape.
drop table if exists public.place_search_cache;
create table public.place_search_cache (
  q_key text not null check (char_length(q_key) between 2 and 80),
  near_key text not null default '' check (char_length(near_key) <= 80),
  payload jsonb not null default '[]'::jsonb
    check (jsonb_typeof(payload) = 'array' and jsonb_array_length(payload) <= 8),
  fetched_at timestamptz not null default now(),
  primary key (q_key, near_key)
);
alter table public.place_search_cache enable row level security;
revoke all on public.place_search_cache from public, anon, authenticated;

-- One name, one signature: the old one-argument shapes go, the new ones
-- answer an old phone's {q} call through the default.
drop function if exists public.place_search_ask(text);
drop function if exists public.place_search_take(bigint, text);

-- ---------------------------------------------------------------------------
-- 2. The ask: cache, else the city hop or the search itself
-- ---------------------------------------------------------------------------
create or replace function public.place_search_ask(q text, near text default '')
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare qk text; nk text; c record; cc record; rid bigint;
        ua constant text := 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/)';
begin
  if auth.uid() is null then
    raise exception 'permission' using errcode = '42501';
  end if;
  qk := btrim(regexp_replace(lower(coalesce(q, '')), '\s+', ' ', 'g'));
  if char_length(qk) < 2 or char_length(qk) > 80 then
    return jsonb_build_object('none', true);
  end if;
  nk := coalesce(public.road_city_key(split_part(coalesce(near, ''), ',', 1)), '');
  delete from place_search_cache where fetched_at < now() - interval '7 days';
  delete from place_city_cache where fetched_at < now() - interval '30 days';
  select * into c from place_search_cache where q_key = qk and near_key = nk;
  if found then
    return jsonb_build_object('places', c.payload);
  end if;
  if not public.setlist_pace_ok('photon', interval '300 milliseconds') then
    return jsonb_build_object('busy', true);
  end if;
  -- A town the house has not placed yet is asked for first, once a month.
  if nk <> '' and not exists (select 1 from place_city_cache p where p.city_key = nk) then
    rid := net.http_get(url := 'https://photon.komoot.io/api',
      params := jsonb_build_object('q', btrim(split_part(near, ',', 1)), 'limit', '1',
        'lang', 'en', 'osm_tag', 'place'),
      headers := jsonb_build_object('Accept', 'application/json', 'User-Agent', ua),
      timeout_milliseconds := 10000);
    return jsonb_build_object('wait', rid, 'hop', 'city');
  end if;
  select * into cc from place_city_cache where city_key = nk;
  if found and cc.lat is not null then
    rid := net.http_get(url := 'https://photon.komoot.io/api',
      params := jsonb_build_object('q', qk, 'limit', '8', 'lang', 'en',
        'lat', cc.lat::text, 'lon', cc.lon::text, 'zoom', '12'),
      headers := jsonb_build_object('Accept', 'application/json', 'User-Agent', ua),
      timeout_milliseconds := 10000);
  else
    rid := net.http_get(url := 'https://photon.komoot.io/api',
      params := jsonb_build_object('q', qk, 'limit', '8', 'lang', 'en'),
      headers := jsonb_build_object('Accept', 'application/json', 'User-Agent', ua),
      timeout_milliseconds := 10000);
  end if;
  return jsonb_build_object('wait', rid);
end $$;
revoke all on function public.place_search_ask(text, text) from public, anon;
grant execute on function public.place_search_ask(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The take: a city answer fires the real search; a search answer lands
-- ---------------------------------------------------------------------------
create or replace function public.place_search_take(req_id bigint, q text, near text default '')
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare qk text; nk text; resp record; body jsonb; rows_ jsonb; cc record; rid bigint;
        clat double precision; clon double precision; cval text;
        ua constant text := 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/)';
begin
  if auth.uid() is null then
    raise exception 'permission' using errcode = '42501';
  end if;
  qk := btrim(regexp_replace(lower(coalesce(q, '')), '\s+', ' ', 'g'));
  if char_length(qk) < 2 or char_length(qk) > 80 then
    return jsonb_build_object('none', true);
  end if;
  nk := coalesce(public.road_city_key(split_part(coalesce(near, ''), ',', 1)), '');
  select payload into rows_ from place_search_cache where q_key = qk and near_key = nk;
  if found then
    return jsonb_build_object('places', rows_);
  end if;
  select r.status_code, r.content into resp from net._http_response r where r.id = req_id;
  if not found then
    return jsonb_build_object('wait', req_id);
  end if;
  -- Was this the city hop? A fresh town is written down (even as "nowhere
  -- found", so one bad name never asks twice a month), and the real search
  -- fires at once with a fresh ticket for the same phone.
  if nk <> '' and not exists (select 1 from place_city_cache p where p.city_key = nk) then
    clat := null; clon := null;
    if resp.status_code = 200 then
      begin
        body := resp.content::jsonb;
        select (x -> 'geometry' -> 'coordinates' ->> 1)::double precision,
               (x -> 'geometry' -> 'coordinates' ->> 0)::double precision
          into clat, clon
          from jsonb_array_elements(coalesce(body -> 'features', '[]'::jsonb)) x
         limit 1;
      exception when others then
        clat := null; clon := null;
      end;
    end if;
    insert into place_city_cache (city_key, lat, lon, fetched_at)
    values (nk, clat, clon, now())
    on conflict (city_key) do update set lat = excluded.lat, lon = excluded.lon, fetched_at = excluded.fetched_at;
    if clat is not null then
      rid := net.http_get(url := 'https://photon.komoot.io/api',
        params := jsonb_build_object('q', qk, 'limit', '8', 'lang', 'en',
          'lat', clat::text, 'lon', clon::text, 'zoom', '12'),
        headers := jsonb_build_object('Accept', 'application/json', 'User-Agent', ua),
        timeout_milliseconds := 10000);
    else
      rid := net.http_get(url := 'https://photon.komoot.io/api',
        params := jsonb_build_object('q', qk, 'limit', '8', 'lang', 'en'),
        headers := jsonb_build_object('Accept', 'application/json', 'User-Agent', ua),
        timeout_milliseconds := 10000);
    end if;
    return jsonb_build_object('wait', rid);
  end if;
  rows_ := '[]'::jsonb;
  if resp.status_code = 200 then
    begin
      body := resp.content::jsonb;
      -- What the picker shows: the name, what OpenStreetMap calls it, the
      -- street (number and all, the way his photo reads), and the town.
      select coalesce(jsonb_agg(jsonb_build_object(
          'name', left(btrim(q2.p ->> 'name'), 120),
          'kind', left(btrim(coalesce(q2.p ->> 'osm_value', '')), 60),
          'street', left(btrim(concat_ws(' ', nullif(btrim(coalesce(q2.p ->> 'housenumber', '')), ''),
                                              nullif(btrim(coalesce(q2.p ->> 'street', '')), ''))), 120),
          'city', left(btrim(coalesce(q2.p ->> 'city', '')), 80),
          'state', left(btrim(coalesce(q2.p ->> 'state', '')), 80),
          'country', left(btrim(coalesce(q2.p ->> 'country', '')), 80))), '[]'::jsonb)
        into rows_
        from (select x -> 'properties' as p
                from jsonb_array_elements(coalesce(body -> 'features', '[]'::jsonb)) x
               where btrim(coalesce(x -> 'properties' ->> 'name', '')) <> ''
               limit 8) q2;
    exception when others then
      rows_ := '[]'::jsonb;
    end;
  end if;
  insert into place_search_cache (q_key, near_key, payload, fetched_at)
  values (qk, nk, rows_, now())
  on conflict (q_key, near_key) do update set payload = excluded.payload, fetched_at = excluded.fetched_at;
  return jsonb_build_object('places', rows_);
end $$;
revoke all on function public.place_search_take(bigint, text, text) from public, anon;
grant execute on function public.place_search_take(bigint, text, text) to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop function if exists public.place_search_take(bigint, text, text);
--   drop function if exists public.place_search_ask(text, text);
--   drop table if exists public.place_city_cache;
--   then put back 0164's cache table, ask and take (their text is in that
--   file) and notify pgrst, 'reload schema';
-- Cache rows are a week's convenience and city centres a month's; nothing
-- else leans on them.
