-- Spot cards (Devin, 2026-10-17, with a photo of a map app's place card:
-- "after you log a spot if you click on it, it should show information on
-- the spot ... Ratings, how far it is from where we are, website, number,
-- etc"). Tapping a spot opens its card: the name, what kind of place and
-- which part of town, Walk / Website / Call, whether it is open, how far it
-- is, the address, and who recommended it. Ratings and photos come later
-- from Apple's own place card once the Maps key exists; this is the free
-- part, from OpenStreetMap.
--
-- What changes:
--   1. A spot remembers WHERE it is: lat, lon, the street address and the
--      map's own id for the place (osm_ref, 'N123' = node 123). All blank-
--      able; every spot saved before tonight has none of them.
--   2. Place search hands those over with each found place (so a spot
--      picked from the list is saved knowing where it is), and its week-long
--      cache is emptied so no answer goes out in the old shape.
--   3. follow_spots also says each spot's id and where it is, so the Today
--      rows open the same card.
--   4. The details road, spot_details_ask / spot_details_take, in the
--      0157/0166 ask-then-take style through pg_net, for anyone who may read
--      the spot (its saver, anyone on its tour, or a follower of the saver
--      for a tour spot, the reach follow_spots already has):
--        a. a spot that does not know where it is yet is looked up once by
--           its name and town through place search (same politeness, same
--           city centres, same week-long cache), and the best match by name
--           in that town is written onto the spot, filling blanks only;
--        b. then the place's website, phone, opening hours, cuisine and
--           neighbourhood are read from OpenStreetMap's Nominatim lookup
--           (one ask a second for the whole house, as their rules ask, with
--           a User-Agent naming Greenroom) and kept a month in
--           place_details_cache by the map's id.
-- Phones never call the map services themselves (the page's security
-- policy forbids it); the server does. Nothing personal goes out: a place's
-- name, its town, and the map's id.

-- ---------------------------------------------------------------------------
-- 1. Where a spot is
-- ---------------------------------------------------------------------------
alter table public.local_spots add column if not exists lat double precision;
alter table public.local_spots add column if not exists lon double precision;
-- street and postcode, the way the card writes it
alter table public.local_spots add column if not exists address text;
-- OpenStreetMap's id for the place: N, W or R and the number
alter table public.local_spots add column if not exists osm_ref text;
alter table public.local_spots drop constraint if exists local_spots_where_ok;
alter table public.local_spots add constraint local_spots_where_ok check (
  (lat is null) = (lon is null)
  and (lat is null or lat between -90 and 90)
  and (lon is null or lon between -180 and 180)
  and (address is null or char_length(address) <= 160)
  and (osm_ref is null or osm_ref ~ '^[NWR][0-9]{1,20}$'));

-- ---------------------------------------------------------------------------
-- 2. Place search keeps where each place is
-- ---------------------------------------------------------------------------
-- Rows cached in the old shape would go out without coordinates for a week.
delete from public.place_search_cache;

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
  -- Was this the city hop? (0166, unchanged.)
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
      -- What the picker shows (0166), and now where the place is: its
      -- coordinates, its postcode, and the map's own id for it.
      select coalesce(jsonb_agg(jsonb_build_object(
          'name', left(btrim(q2.p ->> 'name'), 120),
          'kind', left(btrim(coalesce(q2.p ->> 'osm_value', '')), 60),
          'street', left(btrim(concat_ws(' ', nullif(btrim(coalesce(q2.p ->> 'housenumber', '')), ''),
                                              nullif(btrim(coalesce(q2.p ->> 'street', '')), ''))), 120),
          'city', left(btrim(coalesce(q2.p ->> 'city', '')), 80),
          'state', left(btrim(coalesce(q2.p ->> 'state', '')), 80),
          'country', left(btrim(coalesce(q2.p ->> 'country', '')), 80),
          'postcode', left(btrim(coalesce(q2.p ->> 'postcode', '')), 20),
          'lat', case when q2.lon is not null and q2.lat between -90 and 90 then q2.lat end,
          'lon', case when q2.lat is not null and q2.lon between -180 and 180 then q2.lon end,
          'osmRef', case when coalesce(q2.p ->> 'osm_type', '') in ('N', 'W', 'R')
                          and coalesce(q2.p ->> 'osm_id', '') ~ '^[0-9]{1,20}$'
                         then (q2.p ->> 'osm_type') || (q2.p ->> 'osm_id') else '' end)), '[]'::jsonb)
        into rows_
        from (select x -> 'properties' as p,
                     case when jsonb_typeof(x -> 'geometry' -> 'coordinates' -> 1) = 'number'
                          then (x -> 'geometry' -> 'coordinates' ->> 1)::double precision end as lat,
                     case when jsonb_typeof(x -> 'geometry' -> 'coordinates' -> 0) = 'number'
                          then (x -> 'geometry' -> 'coordinates' ->> 0)::double precision end as lon
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

-- ---------------------------------------------------------------------------
-- 3. follow_spots says each spot's id and where it is (0170's rule, reach
--    and order exactly; only the answer grows)
-- ---------------------------------------------------------------------------
create or replace function public.follow_spots(near text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'userId', s.user_id,
           'who', coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.username), ''), 'Someone'),
           'city', s.city, 'name', s.name, 'kind', s.kind,
           'note', coalesce(s.note, ''),
           'address', coalesce(s.address, ''),
           'lat', s.lat, 'lon', s.lon,
           'osmRef', coalesce(s.osm_ref, '')) order by s.created_at desc), '[]'::jsonb)
    from (select * from local_spots sp
           where public.road_city_key(split_part(sp.city, ',', 1)) =
                 public.road_city_key(split_part(coalesce(near, ''), ',', 1))
             and sp.tour_id is not null
             and sp.user_id in (select f.followee_id from follows f where f.follower_id = auth.uid())
           order by sp.created_at desc
           limit 40) s
    left join profiles p on p.user_id = s.user_id
   where auth.uid() is not null
$$;
revoke all on function public.follow_spots(text) from public, anon;
grant execute on function public.follow_spots(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. What the map knows about a place, kept a month by its id
-- ---------------------------------------------------------------------------
create table if not exists public.place_details_cache (
  osm_ref text primary key check (osm_ref ~ '^[NWR][0-9]{1,20}$'),
  -- only { website, phone, hours, cuisine, area, street, postcode }
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  fetched_at timestamptz not null default now()
);
alter table public.place_details_cache enable row level security;
revoke all on public.place_details_cache from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The pieces the two doors share (none of them a phone's to call)
-- ---------------------------------------------------------------------------
-- A name squeezed for comparing: "Gyu-Kaku" and "gyu kaku" are one.
create or replace function public.spot_name_key(t text)
returns text
language sql immutable as $$
  select regexp_replace(coalesce(public.road_city_key(t), ''), '[^a-z0-9]+', '', 'g')
$$;
revoke all on function public.spot_name_key(text) from public, anon, authenticated;

-- Who may read a spot: the table's own rule (the saver; anyone on its tour)
-- plus follow_spots' reach (a follower of the saver, for a tour spot).
create or replace function public.spot_readable(s_user uuid, s_tour text)
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    s_user = auth.uid()
    or (s_tour is not null and public.my_role(s_tour) is not null)
    or (s_tour is not null and exists (select 1 from follows f
                                        where f.follower_id = auth.uid() and f.followee_id = s_user)))
$$;
revoke all on function public.spot_readable(uuid, text) from public, anon, authenticated;

-- The words a spot is looked up by: its name and its town ("tenfold
-- coffee, houston"), or the name alone when the two run past 80.
create or replace function public.spot_geo_words(nm text, city text)
returns text
language sql immutable as $$
  select case when char_length(w) between 2 and 80 then w
              else left(btrim(regexp_replace(lower(coalesce(nm, '')), '\s+', ' ', 'g')), 80) end
    from (select btrim(regexp_replace(lower(coalesce(nm, '') ||
                   case when btrim(split_part(coalesce(city, ''), ',', 1)) <> ''
                        then ', ' || btrim(split_part(coalesce(city, ''), ',', 1)) else '' end),
                   '\s+', ' ', 'g')) as w) q
$$;
revoke all on function public.spot_geo_words(text, text) from public, anon, authenticated;

-- The found place that IS the spot, or nothing: the same name (or one name
-- inside the other, four letters or more), in the spot's town or within
-- 40 km of its centre. An exact name wins, then the town, then the nearer.
-- Nothing that only looks alike is ever written onto a spot.
create or replace function public.spot_place_pick(places jsonb, nm text, town_key text,
                                                  clat double precision, clon double precision)
returns jsonb
language sql immutable as $$
  select q.r from (
    select r, public.spot_name_key(r ->> 'name') as rk, public.spot_name_key(nm) as nk,
           (coalesce(town_key, '') <> '' and coalesce(public.road_city_key(r ->> 'city'), '') = town_key) as same_town,
           case when clat is null or clon is null then null
                else sqrt(power(((r ->> 'lon')::double precision - clon) * cos(radians(clat)) * 111320, 2)
                        + power(((r ->> 'lat')::double precision - clat) * 110540, 2)) end as from_centre
      from jsonb_array_elements(case when jsonb_typeof(places) = 'array' then places else '[]'::jsonb end) r
     where jsonb_typeof(r -> 'lat') = 'number' and jsonb_typeof(r -> 'lon') = 'number'
     offset 0) q
   where q.nk <> '' and q.rk <> ''
     and (q.rk = q.nk
          or (least(char_length(q.rk), char_length(q.nk)) >= 4
              and (position(q.nk in q.rk) > 0 or position(q.rk in q.nk) > 0)))
     and (q.same_town or coalesce(q.from_centre < 40000, false))
   order by (q.rk = q.nk) desc, q.same_town desc, q.from_centre nulls last
   limit 1
$$;
revoke all on function public.spot_place_pick(jsonb, text, text, double precision, double precision) from public, anon, authenticated;

-- Write the found place onto the spot, filling blanks only: a spot that
-- already knows where it is (picked from the list, or found before) is
-- never moved.
create or replace function public.spot_geo_land(s_id bigint, places jsonb)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare s record; tk text; clat double precision; clon double precision; m jsonb; addr text;
begin
  select ls.id, ls.name, ls.city, ls.lat, ls.osm_ref into s from local_spots ls where ls.id = s_id;
  if not found or s.lat is not null or s.osm_ref is not null then return; end if;
  tk := coalesce(public.road_city_key(split_part(coalesce(s.city, ''), ',', 1)), '');
  select p.lat, p.lon into clat, clon from place_city_cache p where p.city_key = tk;
  m := public.spot_place_pick(places, s.name, tk, clat, clon);
  if m is null then return; end if;
  addr := nullif(left(concat_ws(', ', nullif(btrim(coalesce(m ->> 'street', '')), ''),
                                      nullif(btrim(coalesce(m ->> 'postcode', '')), '')), 160), '');
  update local_spots
     set lat = (m ->> 'lat')::double precision, lon = (m ->> 'lon')::double precision,
         address = coalesce(address, addr),
         osm_ref = coalesce(osm_ref, case when coalesce(m ->> 'osmRef', '') ~ '^[NWR][0-9]{1,20}$' then m ->> 'osmRef' end)
   where id = s_id and lat is null and lon is null and osm_ref is null;
end $$;
revoke all on function public.spot_geo_land(bigint, jsonb) from public, anon, authenticated;

-- What a Nominatim answer says about one place, trimmed to what the card
-- shows. A website without its https:// gets one; anything else that is
-- not a web address is dropped. The first of several phone numbers.
create or replace function public.spot_details_shape(el jsonb)
returns jsonb
language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'website', case when q.w ~* '^https?://[^[:space:]<>"]+$' then left(q.w, 300)
                    when q.w ~* '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(/[^[:space:]<>"]*)?$' then left('https://' || q.w, 300) end,
    'phone', nullif(left(btrim(split_part(coalesce(q.et ->> 'phone', q.et ->> 'contact:phone', ''), ';', 1)), 40), ''),
    'hours', nullif(left(btrim(coalesce(q.et ->> 'opening_hours', '')), 255), ''),
    'cuisine', nullif(left(btrim(coalesce(q.et ->> 'cuisine', '')), 80), ''),
    'area', nullif(left(btrim(coalesce(q.ad ->> 'neighbourhood', q.ad ->> 'suburb', q.ad ->> 'quarter',
                                       q.ad ->> 'city_district', '')), 80), ''),
    'street', nullif(left(btrim(concat_ws(' ', nullif(btrim(coalesce(q.ad ->> 'house_number', '')), ''),
                                              nullif(btrim(coalesce(q.ad ->> 'road', '')), ''))), 120), ''),
    'postcode', nullif(left(btrim(coalesce(q.ad ->> 'postcode', '')), 20), '')))
    from (select case when jsonb_typeof(el -> 'extratags') = 'object' then el -> 'extratags' else '{}'::jsonb end as et,
                 case when jsonb_typeof(el -> 'address') = 'object' then el -> 'address' else '{}'::jsonb end as ad,
                 btrim(split_part(coalesce(el -> 'extratags' ->> 'website', el -> 'extratags' ->> 'contact:website',
                                           el -> 'extratags' ->> 'url', ''), ';', 1)) as w) q
$$;
revoke all on function public.spot_details_shape(jsonb) from public, anon, authenticated;

-- Where the spot stands now, the part of every answer the card starts from.
create or replace function public.spot_details_base(s_id bigint)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('spot', jsonb_build_object(
           'id', s.id, 'lat', s.lat, 'lon', s.lon,
           'address', coalesce(s.address, ''), 'osmRef', coalesce(s.osm_ref, '')))
      from local_spots s where s.id = s_id), '{}'::jsonb)
$$;
revoke all on function public.spot_details_base(bigint) from public, anon, authenticated;

-- The details step for a spot as it stands: the month's cache, else the
-- one Nominatim ask (paced to one a second for the whole house), else
-- {busy}. A spot the map has no id for has no details step.
create or replace function public.spot_details_next(s_id bigint)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare ref text; pay jsonb; rid bigint;
        ua constant text := 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/)';
begin
  select ls.osm_ref into ref from local_spots ls where ls.id = s_id;
  if ref is null then return '{}'::jsonb; end if;
  delete from place_details_cache where fetched_at < now() - interval '30 days';
  select c.payload into pay from place_details_cache c where c.osm_ref = ref;
  if found then return jsonb_build_object('details', pay); end if;
  if not public.setlist_pace_ok('nominatim', interval '1100 milliseconds') then
    return jsonb_build_object('busy', true);
  end if;
  rid := net.http_get(url := 'https://nominatim.openstreetmap.org/lookup',
    params := jsonb_build_object('osm_ids', ref, 'format', 'jsonv2', 'extratags', '1',
      'addressdetails', '1', 'accept-language', 'en'),
    headers := jsonb_build_object('Accept', 'application/json', 'User-Agent', ua),
    timeout_milliseconds := 10000);
  return jsonb_build_object('wait', rid, 'step', 'osm');
end $$;
revoke all on function public.spot_details_next(bigint) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. The two doors
-- ---------------------------------------------------------------------------
-- The ask: who recommended it (with their photo when the phone asks for
-- it: a tour's own phones already hold their crew's photos), where the spot
-- is, and the next step: the look-up by name and town for a spot that does
-- not know where it is yet, else the details. Answers { spot, userId, who,
-- [avatar], [details], [wait, step] | [busy] }, or { none } for a spot this
-- account may not read (or that is not there).
create or replace function public.spot_details_ask(spot_id bigint, face boolean default false)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s record; a jsonb; who jsonb;
begin
  if auth.uid() is null then
    raise exception 'permission' using errcode = '42501';
  end if;
  select ls.id, ls.user_id, ls.tour_id, ls.name, ls.city, ls.lat, ls.osm_ref
    into s from local_spots ls where ls.id = spot_id;
  if not found or not public.spot_readable(s.user_id, s.tour_id) then
    return jsonb_build_object('none', true);
  end if;
  select jsonb_build_object('userId', s.user_id,
           'who', coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.username), ''), 'Someone'))
         || case when face then jsonb_build_object('avatar', coalesce(p.avatar, '')) else '{}'::jsonb end
    into who from profiles p where p.user_id = s.user_id;
  who := coalesce(who, jsonb_build_object('userId', s.user_id, 'who', 'Someone'));
  if s.lat is null and s.osm_ref is null then
    a := public.place_search_ask(public.spot_geo_words(s.name, s.city), s.city);
    if a ? 'places' then
      perform public.spot_geo_land(s.id, a -> 'places');
    elsif a ? 'wait' then
      return public.spot_details_base(s.id) || who || jsonb_build_object('wait', a -> 'wait', 'step', 'geo');
    elsif a ? 'busy' then
      return public.spot_details_base(s.id) || who || jsonb_build_object('busy', true);
    end if;
  end if;
  return public.spot_details_base(s.id) || who || public.spot_details_next(s.id);
end $$;
revoke all on function public.spot_details_ask(bigint, boolean) from public, anon;
grant execute on function public.spot_details_ask(bigint, boolean) to authenticated;

-- The take: the phone hands back the ticket and which step it was. A
-- look-up answer is matched and written onto the spot, then the details
-- step runs; a details answer is kept only when it is really about this
-- place (the map's id in the answer is the spot's), so a stray ticket can
-- never put another answer under a place's name. A turned-away ask is not
-- kept: the next open asks again.
create or replace function public.spot_details_take(req_id bigint, spot_id bigint, step text default '')
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s record; a jsonb; base jsonb; resp record; body jsonb; el jsonb; pay jsonb;
begin
  if auth.uid() is null then
    raise exception 'permission' using errcode = '42501';
  end if;
  select ls.id, ls.user_id, ls.tour_id, ls.name, ls.city, ls.lat, ls.osm_ref
    into s from local_spots ls where ls.id = spot_id;
  if not found or not public.spot_readable(s.user_id, s.tour_id) then
    return jsonb_build_object('none', true);
  end if;
  if coalesce(step, '') = 'geo' then
    if s.lat is null and s.osm_ref is null then
      a := public.place_search_take(req_id, public.spot_geo_words(s.name, s.city), s.city);
      if a ? 'wait' then
        return public.spot_details_base(s.id) || jsonb_build_object('wait', a -> 'wait', 'step', 'geo');
      end if;
      if a ? 'places' then
        perform public.spot_geo_land(s.id, a -> 'places');
      end if;
    end if;
    return public.spot_details_base(s.id) || public.spot_details_next(s.id);
  end if;
  base := public.spot_details_base(s.id);
  if s.osm_ref is null then return base; end if;
  -- Another phone's take may have landed it already.
  select c.payload into pay from place_details_cache c
   where c.osm_ref = s.osm_ref and c.fetched_at >= now() - interval '30 days';
  if found then return base || jsonb_build_object('details', pay); end if;
  select r.status_code, r.content into resp from net._http_response r where r.id = req_id;
  if not found then
    return base || jsonb_build_object('wait', req_id, 'step', 'osm');
  end if;
  pay := null;
  if resp.status_code = 200 then
    begin
      body := resp.content::jsonb;
      if jsonb_typeof(body) = 'array' then
        select x into el from jsonb_array_elements(body) x
         where upper(left(coalesce(x ->> 'osm_type', ''), 1)) || coalesce(x ->> 'osm_id', '') = s.osm_ref
         limit 1;
        if el is not null then
          pay := public.spot_details_shape(el);
        elsif jsonb_array_length(body) = 0 then
          pay := '{}'::jsonb;   -- the map has nothing more on it: remembered as nothing, a month
        end if;
      end if;
    exception when others then
      pay := null;
    end;
  end if;
  if pay is null then
    return base || jsonb_build_object('details', '{}'::jsonb);
  end if;
  insert into place_details_cache (osm_ref, payload, fetched_at)
  values (s.osm_ref, pay, now())
  on conflict (osm_ref) do update set payload = excluded.payload, fetched_at = excluded.fetched_at;
  return base || jsonb_build_object('details', pay);
end $$;
revoke all on function public.spot_details_take(bigint, bigint, text) from public, anon;
grant execute on function public.spot_details_take(bigint, bigint, text) to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop function if exists public.spot_details_take(bigint, bigint, text);
--   drop function if exists public.spot_details_ask(bigint, boolean);
--   drop function if exists public.spot_details_next(bigint);
--   drop function if exists public.spot_details_base(bigint);
--   drop function if exists public.spot_details_shape(jsonb);
--   drop function if exists public.spot_geo_land(bigint, jsonb);
--   drop function if exists public.spot_place_pick(jsonb, text, text, double precision, double precision);
--   drop function if exists public.spot_geo_words(text, text);
--   drop function if exists public.spot_readable(uuid, text);
--   drop function if exists public.spot_name_key(text);
--   drop table if exists public.place_details_cache;
--   put back 0170's follow_spots and 0166's place_search_take (their text is
--   in those files), delete from public.place_search_cache;
--   alter table public.local_spots drop constraint if exists local_spots_where_ok;
--   alter table public.local_spots drop column if exists osm_ref,
--     drop column if exists address, drop column if exists lon, drop column if exists lat;
--   notify pgrst, 'reload schema';
-- The app probes the columns and the two doors and simply goes back to
-- today's rows: spot cards open from what a row carries, with no details.
