-- HISTORY KNOWS THE TOWN (Devin, 2026-10-16 night): "In the history add how
-- many times you've played that city. Also say which tour was the last show
-- you played that city on. The tour history should also eventually show your
-- average merch number and guarantee in that city but that last one should
-- only be for members."
--
-- venue_history (0160, 0165) keeps its signature, its gate and every key it
-- already answers with, byte for byte. Three things ride along after them:
--
--   * 'cityCount': the artist's played nights in tonight's town before
--     tonight, one per date, the way the venue count is made: the artist
--     page's road history, plus this tour's own earlier nights in the town
--     on a date the history has no night yet (the first night of a stand
--     before setlist.fm has it). Always sent once the answer is not
--     { none: true }; 0 means the first time in that town.
--   * 'cityLast': { date, name, kind }, the newest of those nights, named as
--     the venue list names its nights (the tour as the artist page names it,
--     else its festival, else "Shows outside a tour"). When that night was
--     earlier on this same tour, it is named after this tour: it literally
--     is the last show there. Only sent when cityCount > 0.
--   * the money, out of Greenroom's own books (the road history holds no
--     money): nights in this town logged on the artist's tours (artist_tours,
--     0143) and on this tour, dated before tonight, each night's number only
--     when it is above 0.
--       'merchAvg' / 'merchN': income.merch, as merchNightlyAvg reads it, for
--       everyone this function already answers (everyone on the tour);
--       'guaranteeAvg' / 'guaranteeN': the Guarantee Total (income.guarantee
--       plus taxWithheld, as guaranteeTotal reads it), for Members ONLY: the
--       account that runs the artist page, the tour's owner, or a current
--       band Member of the page (artist_members kind 'band', not ended). A
--       Manager or Crew seat never receives these keys at all.
--     Each pair is only sent when its count is above 0.
--
-- The town is matched the way the artist page counts cities (road_place_counts,
-- 0130): the city key before the comma (road_city_key), the country agrees or
-- one side has none, the US or Canadian state agrees or one side has none, and
-- a district is read as its city on both sides (Brooklyn is New York). The
-- district lookup was written inline in road_place_counts; it is lifted here
-- into road_city_fold so this reader and that one say the same thing.
-- road_place_counts itself is not touched (it is on the profile's 8 second
-- road), so nothing any page counts moves.
--
-- Nothing is stored, nothing is written, no new grant. What leaves beyond
-- 0165: a count, one night's date and tour or festival name out of the
-- artist page's public road history (or this tour's own name), and two
-- averages out of tours the artist's account made, the guarantee one only to
-- the band.

-- A district is its city: the key a place counts under (Brooklyn -> new york).
-- The same lookup road_place_counts makes inline (0130): the country's two
-- letters, the US or Canadian state when there is one (a night with no state
-- matches on the country and the name alone), and the city's road_city_key.
create or replace function public.road_city_fold(ctry text, region text, k text)
returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select a.into_key from place_aliases a
                    where a.country_code = upper(coalesce(ctry, ''))
                      and a.city_key = coalesce(k, '')
                      and (a.region = upper(coalesce(region, '')) or coalesce(region, '') = '')
                    order by a.into_key limit 1), coalesce(k, ''))
$$;
revoke all on function public.road_city_fold(text, text, text) from public, anon, authenticated;

-- A Greenroom show's state or province, two letters, US and Canada only: the
-- words after the town's comma ("Houston, TX", "Houston, Texas", "Toronto,
-- ON, Canada"), else ''. A country written there ("Toronto, Canada") is no
-- state.
create or replace function public.road_town_region(city text)
returns text
language sql immutable set search_path = public as $$
  select case
    when public.road_country(city) not in ('US', 'CA') then ''
    when x.r ~ '^[A-Z]{2}$' and x.r <> 'US' and public.road_country('x, ' || x.r) in ('US', 'CA') then x.r
    else '' end
    from (select public.road_region(btrim(split_part(coalesce(city, ''), ',', 2))) as r) x
$$;
revoke all on function public.road_town_region(text) from public, anon, authenticated;

create or replace function public.venue_history(t_id text, s_id text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  t record;
  s jsonb;
  d date;
  vk text;
  ck text;
  cc text;
  nm text;
  a_id uuid;
  a_name text;
  a_owner uuid;     -- 0165: the account that runs the page, to match tours by name
  r_stars numeric;  -- 0165: what the rating was, when reviews match
  r_n int;
  res jsonb;
  rk text;          -- 0174: tonight's state or province (US and Canada), else ''
  fk text;          -- 0174: tonight's town as the place counts read it (a district is its city)
  ak text[];        -- 0174: the district keys that fold into that town
  tname text;       -- 0174: this tour's own name
  c_n int;          -- 0174: played nights in the town before tonight
  c_last jsonb;     -- 0174: the newest of them
  m_avg numeric;    -- 0174: merch, average over logged nights in the town
  m_n int;
  g_avg numeric;    -- 0174: Guarantee Total, the same, for the band only
  g_n int;
begin
  -- Signed in and on this tour, or nothing at all.
  if me is null or not public.on_tour(t_id, me) then
    raise exception 'permission' using errcode = '42501';
  end if;
  select tr.owner_id, tr.doc into t from tours tr where tr.id = t_id;
  -- The show, out of the tour's own document.
  s := case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' -> s_id end;
  if s is null or jsonb_typeof(s) <> 'object' or coalesce(s ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    return jsonb_build_object('none', true);
  end if;
  -- (A date the calendar does not have, the 30th of February, is no night to count from.)
  begin
    d := (s ->> 'date')::date;
  exception when others then
    return jsonb_build_object('none', true);
  end;
  -- The room, keyed the way the venue pages key it.
  vk := public.venue_room_key(s ->> 'venue', s ->> 'city');
  ck := public.road_city_key(split_part(coalesce(s ->> 'city', ''), ',', 1));
  cc := coalesce(public.road_country(s ->> 'city'), '');
  if vk = '' or ck = '' then
    return jsonb_build_object('none', true);
  end if;

  -- The tour's artist page: the one it names...
  if coalesce(t.doc ->> 'artistId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select a.id, a.name, a.owner_id into a_id, a_name, a_owner from artists a where a.id = (t.doc ->> 'artistId')::uuid;
  end if;
  -- ...else, by its name, a page the tour's own account runs...
  nm := lower(btrim(coalesce(t.doc ->> 'artist', '')));
  if a_id is null and nm <> '' then
    select a.id, a.name, a.owner_id into a_id, a_name, a_owner
      from artists a
     where a.owner_id = t.owner_id and lower(btrim(a.name)) = nm
     order by a.created_at
     limit 1;
  end if;
  -- ...else a page that lists the tour's account today.
  if a_id is null and nm <> '' then
    select a.id, a.name, a.owner_id into a_id, a_name, a_owner
      from artist_members m join artists a on a.id = m.artist_id
     where m.user_id = t.owner_id and m.ended_at is null and lower(btrim(a.name)) = nm
     order by a.created_at
     limit 1;
  end if;
  if a_id is null then
    return jsonb_build_object('none', true);
  end if;
  -- A page with no road history has nothing to say, not "your first time".
  if not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date <= public.road_today()) then
    return jsonb_build_object('none', true);
  end if;

  with tg as materialized (
    -- the page's tours, keyed once (the renames, folds and removals the owner made)
    select * from public.artist_tour_groups(a_id)
  ), here as materialized (
    -- the artist's played nights in this room before the show
    select h.date, h.tour, h.festival
      from artist_history_shows h
     where h.artist_id = a_id
       and h.date < d
       and h.date <= public.road_today()
       and public.venue_room_same(public.venue_room_key(h.venue, h.city), vk)
       and public.road_city_key(h.city) = ck
       -- (a night the book holds with no country is the same room in the same-named city, as the place counts read it)
       and (cc = '' or upper(h.country_code) in (cc, ''))
  ), named as (
    -- each tour those nights belong to, named exactly as the artist page names it
    select g.gk, coalesce(max(g.shown), mode() within group (order by h.tour)) as name
      from artist_history_shows h join tg g on g.tour = h.tour
     where h.artist_id = a_id
       and not g.hidden
       and g.gk in (select g2.gk from here x join tg g2 on g2.tour = x.tour)
     group by g.gk
  ), book as (
    -- one night per date; a row under a tour the page shows names it first, then a festival's
    select distinct on (x.date)
           to_char(x.date, 'YYYY-MM-DD') as day,
           case when n.name is not null then n.name
                when x.festival <> '' then x.festival
                else 'Shows outside a tour' end as name,
           case when n.name is not null then 'tour'
                when x.festival <> '' then 'festival'
                else 'shows' end as kind
      from here x
      left join tg g on g.tour = x.tour and not g.hidden
      left join named n on n.gk = g.gk
     order by x.date, (n.name is not null) desc, (x.festival <> '') desc
  ), own as (
    -- this tour's own earlier nights in this room, where the book has no night on that date yet
    select distinct (e.v ->> 'date') as day
      from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e(k, v)
     where e.k <> s_id
       and jsonb_typeof(e.v) = 'object'
       and coalesce(e.v ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
       and (e.v ->> 'date') < (s ->> 'date')
       and (e.v ->> 'date') <= to_char(public.road_today(), 'YYYY-MM-DD')
       and public.venue_room_same(public.venue_room_key(e.v ->> 'venue', e.v ->> 'city'), vk)
       and public.road_city_key(split_part(coalesce(e.v ->> 'city', ''), ',', 1)) = ck
       and not exists (select 1 from artist_history_shows h2
                        where h2.artist_id = a_id
                          and to_char(h2.date, 'YYYY-MM-DD') = (e.v ->> 'date'))
  ), nights as (
    select b.day, b.name, b.kind from book b
    union all
    select o.day, left(coalesce(nullif(btrim(t.doc ->> 'name'), ''), 'This tour'), 120), 'tour' from own o
  )
  select jsonb_build_object(
           'artistId', a_id,
           'artist', a_name,
           'count', (select count(*) from nights),
           -- the cap: the newest 100 nights travel, the count says how many there are in all
           'nights', coalesce((select jsonb_agg(jsonb_build_object('date', x.day, 'name', x.name, 'kind', x.kind) order by x.day desc)
                                 from (select * from nights order by day desc limit 100) x), '[]'::jsonb))
    into res;

  -- 0165: what the rating was. show_ratings is the band's own small table,
  -- so the read starts there and joins each row's tour by its key; the show
  -- is read out of the tour's document exactly as the own CTE above reads
  -- one. Nothing is stored and no policy is consulted twice: this function
  -- is already the band-or-crew-on-tour read it was in 0160.
  select round(avg(x.st), 1), count(x.st)
    into r_stars, r_n
    from (
      select case
               -- a structured review: the mean of the star questions it answered
               when exists (select 1 from jsonb_each(r.review) q
                             where q.key in ('crowd','venue','greenroom','staff','area','catering','sound','stage'))
                 then (select avg((q.value ->> 'stars')::numeric)
                         from jsonb_each(r.review) q
                        where q.key in ('crowd','venue','greenroom','staff','area','catering','sound','stage'))
               -- an old row, still '{}': its crowd/venue ints, halved onto the star scale
               when r.review = '{}'::jsonb and (r.crowd is not null or r.venue is not null)
                 then (coalesce(r.crowd, 0) + coalesce(r.venue, 0))::numeric
                      / (2 * ((r.crowd is not null)::int + (r.venue is not null)::int))
               -- a review with only yes/nos has no number to give
               else null
             end as st
        from show_ratings r
        join tours t2 on t2.id = r.tour_id
       cross join lateral (select t2.doc -> 'shows' -> r.show_id as sh) d2
       where coalesce(t2.doc ->> 'kind', '') <> 'offtour'
         and (t2.doc ->> 'deletedAt') is null
         -- this artist's tours, matched as rates_with_band matches them, plus this very tour
         and (t2.id = t_id
              or (t2.doc ->> 'artistId') = a_id::text
              or (coalesce(t2.doc ->> 'artistId', '') = ''
                  and t2.owner_id = a_owner
                  and btrim(coalesce(t2.doc ->> 'artist', '')) <> ''
                  and lower(btrim(t2.doc ->> 'artist')) = lower(btrim(a_name))))
         -- an earlier, played night of that tour, in this same room
         and jsonb_typeof(d2.sh) = 'object'
         and coalesce(d2.sh ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
         and (d2.sh ->> 'date') < (s ->> 'date')
         and (d2.sh ->> 'date') <= to_char(public.road_today(), 'YYYY-MM-DD')
         and public.venue_room_same(public.venue_room_key(d2.sh ->> 'venue', d2.sh ->> 'city'), vk)
         and public.road_city_key(split_part(coalesce(d2.sh ->> 'city', ''), ',', 1)) = ck
    ) x;
  -- The band's reviews stay the band's (0154's promise: "seen by the band
  -- only"): with one matching review, a shared average would hand a crew
  -- phone one Member's rating. So the keys ride only for the band; everyone
  -- else on the tour gets the history exactly as 0160 answered it.
  if r_n > 0 and public.rates_with_band(t_id) then
    res := res || jsonb_build_object('stars', r_stars, 'ratings', r_n);
  end if;

  -- 0174: the town. Tonight's town as the place counts read it, and the
  -- district keys that are that town (so most nights are passed over
  -- without the district lookup).
  rk := public.road_town_region(s ->> 'city');
  fk := public.road_city_fold(cc, rk, ck);
  ak := array(select a.city_key from place_aliases a where a.into_key = fk);
  tname := left(coalesce(nullif(btrim(t.doc ->> 'name'), ''), 'This tour'), 120);

  with tg as materialized (
    select * from public.artist_tour_groups(a_id)
  ), past as materialized (
    -- the artist's played nights before the show, each city keyed once
    select h.date, h.tour, h.festival, h.state, h.country_code, public.road_city_key(h.city) as k
      from artist_history_shows h
     where h.artist_id = a_id
       and h.date < d
       and h.date <= public.road_today()
  ), near as materialized (
    -- the ones filed under tonight's town or one of its districts, read as a place
    select p.date, p.tour, p.festival, p.k, x.r,
           -- a Canadian province is in Canada, whatever country the night was filed under
           case when x.r = any (array['ON','QC','BC','AB','MB','SK','NS','NB','PE','YT','NT','NU','NL']) then 'CA'
                else upper(coalesce(p.country_code, '')) end as c
      from past p
     cross join lateral (
       select case when upper(coalesce(p.country_code, '')) in ('US', 'CA') then public.road_region(p.state) else '' end as r) x
     where p.k = fk or p.k = any (ak)
  ), town as materialized (
    -- of those, the ones in tonight's town: the same city once districts fold, the
    -- country agreeing or missing on one side, the state agreeing or missing on one side
    select n.date, n.tour, n.festival
      from near n
     where public.road_city_fold(n.c, n.r, n.k) = fk
       and (cc = '' or n.c !~ '^[A-Z]{2}$' or n.c = cc)
       and (rk = '' or n.r = '' or n.r = rk)
  ), tnamed as (
    -- each tour those nights belong to, named exactly as the artist page names it
    select g.gk, coalesce(max(g.shown), mode() within group (order by h.tour)) as name
      from artist_history_shows h join tg g on g.tour = h.tour
     where h.artist_id = a_id
       and not g.hidden
       and g.gk in (select g2.gk from town x join tg g2 on g2.tour = x.tour)
     group by g.gk
  ), tbook as (
    -- one night per date, named as the venue list names its nights
    select distinct on (x.date)
           to_char(x.date, 'YYYY-MM-DD') as day,
           case when n.name is not null then n.name
                when x.festival <> '' then x.festival
                else 'Shows outside a tour' end as name,
           case when n.name is not null then 'tour'
                when x.festival <> '' then 'festival'
                else 'shows' end as kind
      from town x
      left join tg g on g.tour = x.tour and not g.hidden
      left join tnamed n on n.gk = g.gk
     order by x.date, (n.name is not null) desc, (x.festival <> '') desc
  ), mine as (
    -- this tour's own earlier, played nights in the town
    select distinct (e.v ->> 'date') as day
      from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e(k, v)
     where e.k <> s_id
       and jsonb_typeof(e.v) = 'object'
       and coalesce(e.v ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
       and (e.v ->> 'date') < (s ->> 'date')
       and (e.v ->> 'date') <= to_char(public.road_today(), 'YYYY-MM-DD')
       and (select y.k <> ''
                   and public.road_city_fold(y.c, y.r, y.k) = fk
                   and (cc = '' or y.c = '' or y.c = cc)
                   and (rk = '' or y.r = '' or y.r = rk)
              from (select public.road_city_key(split_part(coalesce(e.v ->> 'city', ''), ',', 1)) as k,
                           coalesce(public.road_country(e.v ->> 'city'), '') as c,
                           public.road_town_region(e.v ->> 'city') as r) y)
  ), tn as (
    -- the book's nights (a night that was this tour's is named after this tour),
    -- then this tour's nights the book has nothing on that date for yet
    select b.day,
           case when b.day in (select m.day from mine m) then tname else b.name end as name,
           case when b.day in (select m.day from mine m) then 'tour' else b.kind end as kind
      from tbook b
    union all
    select m.day, tname, 'tour'
      from mine m
     where not exists (select 1 from artist_history_shows h2
                        where h2.artist_id = a_id
                          and to_char(h2.date, 'YYYY-MM-DD') = m.day)
  )
  select (select count(*) from tn),
         (select jsonb_build_object('date', x.day, 'name', x.name, 'kind', x.kind)
            from tn x order by x.day desc limit 1)
    into c_n, c_last;
  res := res || jsonb_build_object('cityCount', c_n);
  if c_n > 0 and c_last is not null then
    res := res || jsonb_build_object('cityLast', c_last);
  end if;

  -- 0174: the money, out of Greenroom's own books: nights logged in the town on
  -- the artist's tours and on this tour, before tonight. A number is a night's
  -- only when it is above 0 (a night logged with no merch is not a $0 night).
  select round(avg(n.m) filter (where n.m > 0), 2), count(*) filter (where n.m > 0),
         round(avg(n.g) filter (where n.g > 0), 2), count(*) filter (where n.g > 0)
    into m_avg, m_n, g_avg, g_n
    from (select t3.id, t3.doc from public.artist_tours(a_id) t3 where t3.id <> t_id
          union all
          select t_id, t.doc) tt
   cross join lateral jsonb_each(case when jsonb_typeof(tt.doc -> 'shows') = 'object' then tt.doc -> 'shows' else '{}'::jsonb end) e(k, v)
   cross join lateral (
     select case when (e.v -> 'income' ->> 'merch') ~ '^-?[0-9]+(\.[0-9]+)?$' then (e.v -> 'income' ->> 'merch')::numeric else 0 end as m,
            -- the Guarantee Total: what was logged, plus the tax that came out of it
            case when (e.v -> 'income' ->> 'guarantee') ~ '^-?[0-9]+(\.[0-9]+)?$' then (e.v -> 'income' ->> 'guarantee')::numeric else 0 end
            + greatest(0, case when (e.v ->> 'taxWithheld') ~ '^-?[0-9]+(\.[0-9]+)?$' then (e.v ->> 'taxWithheld')::numeric else 0 end) as g) n
   where jsonb_typeof(e.v) = 'object'
     and coalesce(e.v ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
     and (e.v ->> 'date') < (s ->> 'date')
     and coalesce(e.v ->> 'loggedAt', '') not in ('', '0', 'false')
     and (select y.k <> ''
                 and public.road_city_fold(y.c, y.r, y.k) = fk
                 and (cc = '' or y.c = '' or y.c = cc)
                 and (rk = '' or y.r = '' or y.r = rk)
            from (select public.road_city_key(split_part(coalesce(e.v ->> 'city', ''), ',', 1)) as k,
                         coalesce(public.road_country(e.v ->> 'city'), '') as c,
                         public.road_town_region(e.v ->> 'city') as r) y);
  -- Merch, to everyone this answers (everyone on the tour).
  if m_n > 0 then
    res := res || jsonb_build_object('merchAvg', m_avg, 'merchN', m_n);
  end if;
  -- The guarantee, to Members only (Devin: "that last one should only be for
  -- members"): the account that runs the page, the tour's owner, or a current
  -- band Member of the page. A Manager or Crew seat never gets the keys.
  if g_n > 0 and (t.owner_id = me
                  or public.runs_artist(a_id)
                  or exists (select 1 from artist_members am
                              where am.artist_id = a_id and am.user_id = me
                                and am.kind = 'band' and am.ended_at is null)) then
    res := res || jsonb_build_object('guaranteeAvg', g_avg, 'guaranteeN', g_n);
  end if;

  return res;
end $$;
revoke all on function public.venue_history(text, text) from public, anon;
grant execute on function public.venue_history(text, text) to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   venue_history back to 0165's text: copy the create or replace function
--   public.venue_history block out of supabase/migrations/0165_show_reviews.sql
--   and run it (its grants are already in place and create or replace keeps
--   them); then
--   drop function if exists public.road_town_region(text);
--   drop function if exists public.road_city_fold(text, text, text);
--   notify pgrst, 'reload schema';
-- The app reads each new key only when it is there, so the History section
-- simply goes back to the venue line and the stars.
