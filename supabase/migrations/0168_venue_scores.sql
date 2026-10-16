-- VENUE PAGES FOR EVERY ROOM, SCORED (Devin, 2026-10-16, his words: "all the
-- questions/ratings will be giving an overall score for venue score, (the
-- venue based questions) city score, crowd score. Like airbnb a venue page
-- will have this venue score that is the average based on every review it's
-- ever received. I think anytime a venue registers on the app whether it's
-- from tour history, or the search bar that venue page should be created and
-- automatically have a score based on what people rated it.")
--
-- Two pieces:
--
--   1. THE SCORE. A review (show_ratings.review, 0165's shape) gives three
--      scores, and this definition is fixed here so the app mirrors it:
--        * crowd score = the crowd question's stars;
--        * city score  = the area question's stars;
--        * venue score = the mean of whichever of venue, greenroom, staff,
--          catering, sound and stage were answered (the yes/no questions
--          never joined an average);
--        * a review from before 0165 (review still '{}') speaks through its
--          old 1-10 ints instead: crowd/2 to the crowd score, venue/2 to the
--          venue score, nothing to the city score;
--        * a review with none of a score's questions gives that score nothing.
--      Only the VENUE score is served by this file: venue_card gains 'score'
--      (the average venue score across every matching review, every band,
--      one decimal) and 'scoreCount' (how many reviews it stands on), absent
--      when no review matches the room. Crowd and city averages wait for
--      their own pages and will read by this same rule.
--
--   2. EVERY ROOM GETS ITS PAGE. Until now a venue page was born when
--      somebody opened one from search (0134's venue_open, 30 a day a
--      person) or when a tour save named the room (0154's tours_venues ->
--      venue_note). Now the archive's own rooms get pages too: a backfill
--      over artist_history_shows and over every live tour's dated shows, and
--      one statement-level trigger on artist_history_shows so a new room
--      gets its page the moment the archive learns it. The tour side rides
--      0154's existing road unchanged. And because the backfill folds
--      spellings into one page, the two older birth roads learn the same
--      fold, so no road can make a twin any more.
--
-- Privacy, said plainly: the average IS deliberately public to signed-in
-- accounts. His design call, quoted above: "the average based on every
-- review it's ever received." The reviews themselves stay the band's own
-- exactly as 0154 and 0165 left them (no policy here changes), and no single
-- review's words or stars are ever handed out by this file, only the average
-- and its count. With one review the average equals that review - that is
-- his call, not an accident, and the count says so right next to it.
-- No email, no real name, no account id travels in anything here.


-- ====================== 1. One review's venue score ======================

-- The venue score of one review, by the fixed rule in the header. Immutable:
-- it reads only its arguments, so the same review always scores the same.
-- The shape is already guaranteed by 0165's check (show_review_ok rides
-- every insert and update), so a star question always carries its stars.
create or replace function public.review_venue_score(review jsonb, legacy_venue int)
returns numeric
language sql immutable set search_path = public as $$
  select case
    -- a structured review: the mean of the venue-family questions it answered
    when review is not null and jsonb_typeof(review) = 'object'
         and review ?| array['venue','greenroom','staff','catering','sound','stage']
      then (select avg((q.value ->> 'stars')::numeric)
              from jsonb_each(review) q
             where q.key in ('venue','greenroom','staff','catering','sound','stage'))
    -- a review from before 0165, still '{}': its old venue int, halved onto
    -- the five-star scale
    when (review is null or review = '{}'::jsonb) and legacy_venue is not null
      then legacy_venue::numeric / 2
    -- a review with none of the venue questions gives the venue score nothing
    else null
  end
$$;
-- Only this file's own definer functions read it; no phone calls it.
revoke all on function public.review_venue_score(jsonb, int) from public, anon, authenticated;


-- ====================== 2. Finding a room's one page ======================

-- The fold lookups below read the city's few pages, not the whole table.
create index if not exists venues_ckey on public.venues (ckey);

-- One room, one page, whatever road asks. Three steps, each the way an
-- existing road already files pages, so nothing here invents a new key:
--   1. the table's own key (vkey + ckey + cc), the way venue_open and the
--      archive have always matched;
--   2. the name address-key (0154's venue_addr_key with no address), the way
--      the tour road files a page it made without a street line;
--   3. the 0160 fold (venue_room_key / venue_room_same): the same room with
--      or without its city in the name, with or without a leading "The",
--      in the same city, countries agreeing where both are known. Oldest
--      page wins, so repeated asks always land on the same one.
-- Returns the page's id, or null when no page holds the room yet.
create or replace function public.venue_find_fold(nm text, ct text, c2 text)
returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  vk text := lower(btrim(coalesce(nm, '')));
  ck text := public.road_city_key(split_part(coalesce(ct, ''), ',', 1));
  c2x text := upper(btrim(coalesce(c2, '')));
  rk text := public.venue_room_key(nm, ct);
  got uuid;
begin
  -- a room needs a name and a city; a name alone is shared by too many towns
  if vk = '' or ck = '' then return null; end if;
  -- 1. the table's own key
  select v.id into got from venues v where v.vkey = vk and v.ckey = ck and v.cc = c2x;
  if got is not null then return got; end if;
  -- 2. the name key the tour road files under
  select v.id into got from venues v where v.addr_key = public.venue_addr_key(null, nm, ct);
  if got is not null then return got; end if;
  -- 3. the 0160 fold, scanned over this city's pages only (venues_ckey);
  --    a page or a room with no country matches either, as the place counts
  --    read a night the book holds with no country
  select v.id into got
    from venues v
   where v.ckey = ck
     and (v.cc = '' or c2x = '' or v.cc = c2x)
     and public.venue_room_same(public.venue_room_key(v.name, v.city), rk)
   order by v.created_at, v.id
   limit 1;
  return got;
end $$;
revoke all on function public.venue_find_fold(text, text, text) from public, anon, authenticated;


-- ====================== 3. Rooms the archive knows birth their own pages ======================

-- One archive room, one page, made if no page folds to it. Exempt from
-- 0134's 30-a-day cap ON PURPOSE: that cap exists to stop one phone
-- hammering pages into being, and it counts rows by created_by; these births
-- are the server's own, made from rows the archive already vetted, so they
-- carry no created_by and the cap stays on venue_open untouched. Never
-- raises: a venue page must never be the reason an archive load fails.
create or replace function public.venue_birth(nm text, ct text, reg text, ctry text, c2 text)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  nm2 text := left(btrim(coalesce(nm, '')), 120);
  ct2 text := left(btrim(coalesce(ct, '')), 120);
  c2x text := upper(btrim(coalesce(c2, '')));
  ck text;
begin
  -- empty venue or city words make no page (the key needs both)
  if nm2 = '' or ct2 = '' then return; end if;
  ck := public.road_city_key(ct2);
  if ck = '' then return; end if;
  begin
    -- a page already holds this room, under this spelling or a folded one
    if public.venue_find_fold(nm2, ct2, c2x) is not null then return; end if;
    -- a new page, named as the archive most often spells it. The name key is
    -- written on it at birth so a later tour save adopts this page instead of
    -- doubling it (0154's venue_note looks that key up second).
    insert into venues (name, vkey, ckey, cc, city, region, country, addr_key)
    values (nm2, lower(nm2), ck, c2x, ct2,
            left(btrim(coalesce(reg, '')), 120), left(btrim(coalesce(ctry, '')), 120),
            public.venue_addr_key(null, nm2, ct2))
    on conflict do nothing;  -- two loads racing: the next one finds this page
  exception when others then
    raise log 'venue_birth: % / % (%)', nm2, ct2, sqlerrm;
  end;
end $$;
revoke all on function public.venue_birth(text, text, text, text, text) from public, anon, authenticated;

-- WHAT WAS CHOSEN for "a new room gets its page on arrival": ONE
-- statement-level trigger on artist_history_shows, plus riding the tour
-- road that already exists - 0154's tours_venues trigger notes every saved
-- tour's venues through venue_note, so the tour side needs nothing new.
--
-- Statement-level, not row-level, because the archive arrives in loads (the
-- setlist sync, the wayback pass, the loaders): the trigger fires once per
-- load statement, reads only the rows that statement really inserted (the
-- transition table), and asks about each distinct room once. A room already
-- paged costs one indexed lookup. Insert only: archive rows arrive by
-- insert-on-conflict, so a new room is always a new row; the rare in-place
-- venue-name correction waits for the search road, the next tour there, or
-- a re-run of this file's backfill.
create or replace function public.venues_from_history()
returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  begin
    for r in
      select mode() within group (order by n.venue) as name,
             mode() within group (order by n.city) as city,
             mode() within group (order by n.state) as region,
             mode() within group (order by n.country) as country,
             upper(n.country_code) as cc
        from new_rows n
       -- festival rows make festival pages (0134), not venue pages: the
       -- venue roads have always read non-festival nights only, and a page
       -- for festival grounds would stand on zero counted shows
       where btrim(n.venue) <> '' and btrim(n.city) <> '' and n.festival = ''
       group by lower(btrim(n.venue)), public.road_city_key(n.city), upper(n.country_code)
    loop
      perform public.venue_birth(r.name, r.city, r.region, r.country, r.cc);
    end loop;
  exception when others then
    raise log 'venues_from_history: %', sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.venues_from_history() from public, anon, authenticated;

drop trigger if exists history_venues on public.artist_history_shows;
create trigger history_venues
  after insert on public.artist_history_shows
  referencing new table as new_rows
  for each statement execute function public.venues_from_history();


-- ====================== 4. The two older birth roads learn the fold ======================

-- venue_open, 0134's text with ONE step added: after the exact key misses,
-- a page that holds this room under a folded spelling is handed back instead
-- of a twin being made. Everything else - the archive check, the 30-a-day
-- cap for pages a person opens into being, the grants - stays word for word.
create or replace function public.venue_open(v_name text, v_city text, v_cc text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare me uuid := auth.uid(); vk text := lower(btrim(coalesce(v_name, ''))); ck text := public.road_city_key(coalesce(v_city, ''));
  c2 text := upper(btrim(coalesce(v_cc, ''))); got uuid; h record;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  select v.id into got from venues v where v.vkey = vk and v.ckey = ck and v.cc = c2;
  if found then return jsonb_build_object('id', got, 'made', false); end if;
  -- 0168: the room may already have its page under another spelling (the
  -- backfill below names pages as the archive most often spells them); a
  -- room must never get two pages, so the fold is asked before anything is made
  got := public.venue_find_fold(v_name, v_city, v_cc);
  if got is not null then return jsonb_build_object('id', got, 'made', false); end if;
  select mode() within group (order by s.venue) as name, mode() within group (order by s.city) as city,
         mode() within group (order by s.state) as region, mode() within group (order by s.country) as country, count(*) as n
    into h from artist_history_shows s
   where lower(btrim(s.venue)) = vk and upper(s.country_code) = c2 and public.road_city_key(s.city) = ck and s.festival = '';
  if h.n is null or h.n = 0 then raise exception 'no shows on record there' using errcode = '22023'; end if;
  if (select count(*) from venues v where v.created_by = me and v.created_at > now() - interval '24 hours')
     + (select count(*) from festivals f where f.created_by = me and f.created_at > now() - interval '24 hours') >= 30 then
    raise exception 'too many today' using errcode = '22023';
  end if;
  insert into venues (name, vkey, ckey, cc, city, region, country, created_by)
  values (left(h.name, 120), vk, ck, c2, coalesce(h.city, ''), coalesce(h.region, ''), coalesce(h.country, ''), me)
  on conflict (vkey, ckey, cc) do update set name = venues.name
  returning id into got;
  return jsonb_build_object('id', got, 'made', true);
end $$;
revoke all on function public.venue_open(text, text, text) from public, anon;
grant execute on function public.venue_open(text, text, text) to authenticated;

-- venue_note, 0154's text with the same ONE step added as a fourth lookup:
-- a tour spelling the room with its city in the name ("House of Blues
-- Anaheim" where the page says "House of Blues") adopts the page instead of
-- doubling it, and the page then learns the tour's address exactly as it
-- would have on an adoption by name. Everything else stays word for word,
-- including the promise that trouble is logged and a tour save never fails here.
create or replace function public.venue_note(nm text, ct text, addr text)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  nm2 text := left(btrim(coalesce(nm, '')), 120);
  ct2 text := btrim(coalesce(ct, ''));
  addr2 text := left(btrim(coalesce(addr, '')), 200);
  akey text; nkey text; vk text; ck text; reg text; seg2 text; v_id uuid;
begin
  -- a show with no venue name, or no city, makes no page: the key needs both
  if nm2 = '' or ct2 = '' then return; end if;
  akey := public.venue_addr_key(addr2, nm2, ct2);
  nkey := public.venue_addr_key(null, nm2, ct2);
  vk := lower(btrim(nm2));
  ck := public.road_city_key(split_part(ct2, ',', 1));
  if ck = '' then return; end if;
  begin
    select id into v_id from venues where addr_key = akey;
    if v_id is null and akey <> nkey then
      select id into v_id from venues where addr_key = nkey;
    end if;
    if v_id is null then
      select id into v_id from venues where vkey = vk and ckey = ck
       order by created_at, id limit 1;
    end if;
    if v_id is null then
      -- 0168: the 0160 fold, so this road cannot make a twin either
      v_id := public.venue_find_fold(nm2, ct2, public.road_country(ct2));
    end if;
    if v_id is not null then
      -- the write is skipped when it would change nothing, so an ordinary
      -- tour save over the same shows writes no venue rows at all
      update venues
         set address  = case when addr2 <> '' then addr2 else address end,
             addr_key = case when addr2 <> '' then akey else coalesce(addr_key, nkey) end
       where id = v_id
         and ((addr2 <> '' and (address is distinct from addr2 or addr_key is distinct from akey))
              or (addr2 = '' and addr_key is null));
    else
      -- a new page. Region and country are read from the city's own words
      -- ("Detroit, MI" says MI and US); what cannot be read stays ''.
      seg2 := btrim(split_part(ct2, ',', 2));
      reg := coalesce(nullif(public.region_code(seg2), ''),
                      case when seg2 ~ '^[A-Za-z]{2}$' then upper(seg2) else '' end);
      insert into venues (name, vkey, ckey, cc, city, region, address, addr_key)
      values (nm2, vk, ck, public.road_country(ct2), left(btrim(split_part(ct2, ',', 1)), 120),
              reg, addr2, akey)
      on conflict do nothing;  -- two saves racing: the next save settles it
    end if;
  exception when others then
    raise log 'venue_note: % / % (%)', nm2, ct2, sqlerrm;
  end;
end $$;
revoke all on function public.venue_note(text, text, text) from public, anon, authenticated;


-- ====================== 5. The backfills: every room the app has already seen ======================

-- Every distinct room in the archive, best-attested spelling first, so the
-- spelling with the most nights claims the page and its folded twins then
-- find it and stand down. Loadable twice: a second run finds every page and
-- makes nothing.
do $$
declare r record;
begin
  for r in
    select mode() within group (order by h.venue) as name,
           mode() within group (order by h.city) as city,
           mode() within group (order by h.state) as region,
           mode() within group (order by h.country) as country,
           upper(h.country_code) as cc
      from artist_history_shows h
     where btrim(h.venue) <> '' and btrim(h.city) <> '' and h.festival = ''
     group by lower(btrim(h.venue)), public.road_city_key(h.city), upper(h.country_code)
     order by count(distinct (h.artist_id, h.date)) desc,
              lower(btrim(h.venue)), public.road_city_key(h.city), upper(h.country_code)
  loop
    perform public.venue_birth(r.name, r.city, r.region, r.country, r.cc);
  end loop;
end $$;

-- Every dated show with a venue in every live tour, oldest save first so the
-- freshest address wins last (0154's own pass, re-run now that venue_note
-- knows the fold; the live road also notes undated shows, unchanged).
do $$
declare t record; e record;
begin
  for t in select x.id, x.doc from tours x
            where coalesce(x.doc ->> 'kind', '') <> 'offtour' and (x.doc ->> 'deletedAt') is null
            order by x.updated_at, x.id
  loop
    for e in select value as s from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object'
                                                    then t.doc -> 'shows' else '{}'::jsonb end)
    loop
      continue when jsonb_typeof(e.s) <> 'object';
      continue when coalesce(e.s ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$';
      perform public.venue_note(e.s ->> 'venue', e.s ->> 'city', e.s -> 'daySheet' ->> 'venueAddress');
    end loop;
  end loop;
end $$;


-- ====================== 6. The venue score on the page ======================

-- venue_card, 0154's text with one CTE and two keys more: 'score' (the
-- average venue score across every review this room has ever received, every
-- band, one decimal) and 'scoreCount' (how many reviews it stands on), both
-- absent when no review matches, so a page without reviews answers byte for
-- byte what 0154 answered.
--
-- Which reviews match: the review's show is read out of its tour's own
-- document (tour -> shows -> show_id) and folds to this page's room the way
-- 0165's venue_history matches one - venue_room_key/venue_room_same on the
-- name, road_city_key on the city, countries agreeing where both are known.
-- The Off Tour book and tours in the trash stay out. No date rule on
-- purpose: "every review it's ever received."
--
-- 'rating'/'ratings' (the 1-10 anyone scale, 0154) are a different thing and
-- stay untouched beside the new keys.
create or replace function public.venue_card(v_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $$
declare v public.venues%rowtype; rk text;
begin
  if auth.uid() is null then return null; end if;
  select * into v from venues where id = v_id;
  if not found then return null; end if;
  rk := public.venue_room_key(v.name, v.city);
  return (
    with n as materialized (
      select s.artist_id, s.date from artist_history_shows s
       where lower(btrim(s.venue)) = v.vkey and upper(s.country_code) = v.cc and public.road_city_key(s.city) = v.ckey
         and s.festival = '' and s.date <= current_date),
    sc as materialized (
      -- the venue score. show_ratings is the bands' own small table; each
      -- row's show is read by its tour's key, so this stays a handful of
      -- indexed reads however many pages exist. This function runs as its
      -- owner, which is the point: the AVERAGE is deliberately public to
      -- signed-in accounts (Devin: "the average based on every review it's
      -- ever received") - and it shows only once THREE reviews stand behind
      -- it (Devin, same day: "a score should only be visible on a venues
      -- page after 3 reviews"), so no one band's rating ever reads alone.
      -- The reviews
      -- themselves stay readable by their band alone (0154/0165 policies,
      -- untouched): nothing of any single review leaves here.
      select round(avg(x.st)::numeric, 1) as score, count(x.st) as n
        from (select public.review_venue_score(r.review, r.venue) as st
                from show_ratings r
                join tours t2 on t2.id = r.tour_id
               cross join lateral (select t2.doc -> 'shows' -> r.show_id as sh) d2
               where v.ckey <> ''
                 and coalesce(t2.doc ->> 'kind', '') <> 'offtour'
                 and (t2.doc ->> 'deletedAt') is null
                 and jsonb_typeof(d2.sh) = 'object'
                 and public.venue_room_same(public.venue_room_key(d2.sh ->> 'venue', d2.sh ->> 'city'), rk)
                 and public.road_city_key(split_part(coalesce(d2.sh ->> 'city', ''), ',', 1)) = v.ckey
                 and (v.cc = '' or coalesce(public.road_country(d2.sh ->> 'city'), '') in (v.cc, ''))) x)
    select jsonb_build_object(
      'id', v.id, 'name', v.name, 'city', v.city, 'region', v.region, 'country', v.country, 'address', v.address, 'phone', v.phone,
      'unclaimed', v.owner_id is null, 'verified', v.verified, 'mine', coalesce(v.owner_id = auth.uid(), false),
      'rating', (select round(avg(r.stars)::numeric, 1) from venue_ratings r where r.venue_id = v.id),
      'ratings', (select count(*) from venue_ratings r where r.venue_id = v.id),
      'shows', (select count(distinct (n.artist_id, n.date)) from n),
      'firstYear', (select extract(year from min(n.date))::int from n),
      'lastYear', (select extract(year from max(n.date))::int from n),
      'artists', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'avatar', coalesce(a.avatar, ''),
                     'n', t.k, 'first', t.y0, 'last', t.y1) order by t.k desc, a.name)
                   from (select n.artist_id, count(distinct n.date) as k, extract(year from min(n.date))::int as y0,
                                extract(year from max(n.date))::int as y1
                           from n group by n.artist_id order by count(distinct n.date) desc limit 80) t
                   join artists a on a.id = t.artist_id), '[]'::jsonb),
      'workers', (select count(*) from place_workers w where w.venue_id = v.id and w.status = 'approved'),
      'myWork', (select jsonb_build_object('role', w.role, 'state', w.status) from place_workers w
                  where w.venue_id = v.id and w.user_id = auth.uid()))
    -- Three reviews or nothing (Devin's gate), so a lone band's rating
    -- never shows as "the" score.
    || case when (select s0.n from sc s0) >= 3
            then jsonb_build_object('score', (select s0.score from sc s0),
                                    'scoreCount', (select s0.n from sc s0))
            else '{}'::jsonb end);
end $$;
revoke all on function public.venue_card(uuid) from public, anon;
grant execute on function public.venue_card(uuid) to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop trigger if exists history_venues on public.artist_history_shows;
--   drop function if exists public.venues_from_history();
--   drop function if exists public.venue_birth(text, text, text, text, text);
--   venue_card back to 0154's text: copy its create or replace function
--   public.venue_card block out of supabase/migrations/0154_venues_and_ratings.sql
--   and run it (create or replace keeps the grants);
--   venue_note back to 0154's text the same way;
--   venue_open back to 0134's text the same way (from
--   supabase/migrations/0134_signup_requests_fans_places.sql);
--   drop function if exists public.venue_find_fold(text, text, text);
--   drop function if exists public.review_venue_score(jsonb, int);
--   drop index if exists public.venues_ckey;
--   notify pgrst, 'reload schema';
-- The pages the backfills made stay: they are ordinary rows of the same
-- table the search road and the tours grow, and nothing else tells them
-- apart (like 0154's tour-born pages, they carry no created_by). Nothing
-- here stored a review, a name or a score, so dropping the functions loses
-- no data.
