-- VENUE HISTORY (Devin's idea 23, 2026-10-16): "when you are at a venue it
-- can tell you how many times you've played that venue and which tours".
-- His word on the rundown: "get started".
--
-- On a show day, Today and the day sheet carry one quiet line under the
-- venue: "Your 4th time at <the venue>", or "Your first time at <the venue>",
-- and a tap lists the nights before tonight, each with its date and the tour
-- or festival it belonged to (or "Shows outside a tour").
--
-- Why a new function: nothing already answers "this artist's played nights
-- in this room" cheaply. venue_card (0134, 0154) is keyed by a venue page's
-- id, and a venue page only exists once somebody opens it (opening one makes
-- it, under a daily cap); it also hands back each artist's count, not the
-- dates or the tours. artist_tour_nights (0112) answers one tour at a time,
-- so a phone would have to ask once for every tour on the artist's page.
-- artist_history_shows itself is closed to phones (0069) and stays closed.
--
-- venue_history(t_id, s_id) answers for one show of one tour:
--   * only to someone on that tour (on_tour, the 0055 rule every tour read
--     leans on), and the show's venue, city and date are read from the
--     tour's own document, never from the phone, so the question is always
--     about a night this tour really has;
--   * the tour's artist page is the one the tour names (doc ->> 'artistId',
--     written when a tour is made on the artist's page). An older tour that
--     only carries the artist's name is matched by that name to a page run
--     by the tour's own account, or else to a page that lists the tour's
--     account (band or crew) today. A tour somebody names after a band they
--     have nothing to do with never borrows that band's road history by its
--     name alone;
--   * the room is matched the way the archive's venue pages match it (0134):
--     the venue's name lower-cased and trimmed, the city by road_city_key
--     (0115, as 0128 left it; the show's city is read up to its first comma,
--     as road_stats reads a Greenroom show), and the country when the show's
--     city names one (road_country; a night the book holds with no country
--     still counts, as road_place_counts reads one). No venue or no city
--     typed: no answer, because a room's name alone is shared by too many
--     towns;
--   * played nights only (dated before the show, and on or before
--     road_today), one show per date, the way every count on the pages is
--     made (a night under two rows in the book is still one night);
--   * a night of this same tour in that room, dated before the show and with
--     nothing in the artist's book on that date yet, is counted too (the
--     first night of a two-night stand, before setlist.fm has it), as the
--     house rule counts a Greenroom show the book has not caught up with
--     (0128: a night the book has is counted as the book has it);
--   * each night's name is the one the artist page shows for it: its tour as
--     the page names it (a rename or a fold the owner made is followed),
--     else its festival, else "Shows outside a tour". A tour the owner took
--     off the page leaves its nights as shows outside a tour, as the page
--     itself does.
-- It hands back { artistId, artist, count, nights: [{ date, name, kind }] },
-- the nights newest first and at most 100 of them (count is all of them;
-- kind is 'tour', 'festival' or 'shows'), or { none: true } when there is
-- nothing to say: no such show, no venue or city typed, no artist page, or
-- a page with no played nights at all.
--
-- Nothing is stored and nothing is written. Column by column, what leaves:
-- the artist page's id and name (what any signed-in account reads on that
-- page), dates and tour or festival names out of the page's public road
-- history (what artist_tour_nights already hands any signed-in account),
-- and this tour's own name, which the caller is on. No email, no phone
-- number, no token, and nobody's account id.
--
-- No new index: the read is one artist's nights, which the (artist_id, date)
-- index from 0069 already finds; a busy page holds a few thousand at most.

-- A room's name, folded so a venue still matches when one source adds its
-- city ("House of Blues Anaheim" in a tour, "House of Blues" in the archive):
-- lower-cased, punctuation out, a leading "the" dropped, and the city's own
-- name taken off either end. Two rooms in one city match when one folded
-- name is the other, or starts the other at a word boundary.
create or replace function public.venue_room_key(v text, city text)
returns text language sql immutable set search_path = public as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(
           regexp_replace(lower(coalesce(v, '')), '[^a-z0-9 ]+', ' ', 'g'),
           '^\s*the\s+', ''),
           '(^|\s)' || regexp_replace(lower(btrim(split_part(coalesce(city, ''), ',', 1))), '[^a-z0-9 ]+', ' ', 'g') || '(\s|$)', ' ', 'g'),
           '\s+', ' ', 'g'))
$$;
create or replace function public.venue_room_same(a text, b text)
returns boolean language sql immutable set search_path = public as $$
  select length(a) >= 3 and length(b) >= 3
     and (a = b or a like b || ' %' or b like a || ' %')
$$;

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
  res jsonb;
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
    select a.id, a.name into a_id, a_name from artists a where a.id = (t.doc ->> 'artistId')::uuid;
  end if;
  -- ...else, by its name, a page the tour's own account runs...
  nm := lower(btrim(coalesce(t.doc ->> 'artist', '')));
  if a_id is null and nm <> '' then
    select a.id, a.name into a_id, a_name
      from artists a
     where a.owner_id = t.owner_id and lower(btrim(a.name)) = nm
     order by a.created_at
     limit 1;
  end if;
  -- ...else a page that lists the tour's account today.
  if a_id is null and nm <> '' then
    select a.id, a.name into a_id, a_name
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
  return res;
end $$;
revoke all on function public.venue_history(text, text) from public, anon;
grant execute on function public.venue_history(text, text) to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop function if exists public.venue_history(text, text);
--   notify pgrst, 'reload schema';
-- Nothing else leans on it: the app's probe finds no function and the line
-- under the venue simply stops rendering. Nothing was stored, so nothing is
-- lost.
