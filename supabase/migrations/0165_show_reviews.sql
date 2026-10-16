-- STRUCTURED SHOW REVIEWS (Devin, 2026-10-16): the rating flow becomes one
-- question at a time, 5 stars with half stars, subcategories by star band,
-- a short note per question.
--
-- Two pieces, both riding what 0154 and 0160 already built:
--
--   1. show_ratings (0154) gains one jsonb column, "review", holding the
--      whole structured answer: eight star questions (crowd, venue,
--      greenroom, staff, area, catering, sound, stage), each 0.5 to 5 stars
--      in half steps, each with optional subcategory words and an optional
--      short note; and three yes/no questions (shower, laundry,
--      accommodated), each with an optional short note. A check on the
--      table calls one validator, show_review_ok, that refuses anything
--      outside that exact shape: an unknown question, a word that is not on
--      Devin's list for that question, a word from the wrong side (3 stars
--      and under speak only in the Bad words, above 3 only in the Good
--      words), a note over 100 characters, or a review over 6000 characters
--      in all. The check rides every insert and update, so a bad review
--      never lands however it arrives.
--
--      Who writes stays exactly as 0154 left it: the band only, each person
--      their own row (rates_with_band and the row policies are untouched;
--      this file adds no policy and changes none). The old crowd/venue/city
--      1-10 columns stay untouched too: the app may mirror stars into them,
--      nothing here does.
--
--   2. venue_history (0160) learns to say what the rating was: when the
--      band reviewed earlier nights in this room, its answer gains 'stars'
--      (the band's own average, one decimal) and 'ratings' (how many
--      reviews that average stands on). When no reviews match, both keys
--      are simply absent and the answer is byte-for-byte what 0160 gave:
--      the app treats absence as nothing to show.
--
-- Nothing new leaves the database: reviews are read back only by the band
-- (0154's own policies), and venue_history already speaks only to someone
-- on the tour. No name, no email, no account id travels in anything here.


-- ====================== 1. The review and its one validator ======================

-- The shape, refused anywhere it bends. Immutable on purpose: it reads only
-- its argument, so the same review always gets the same answer and the
-- table's check can lean on it.
--
-- Devin's word lists, 2026-10-16, kept exactly as he wrote them, spelling,
-- capitals and all ("Knowledgable", "High production", "Bad Production").
-- "Buyout" sits in BOTH catering lists on purpose: a buyout can be the best
-- or the worst thing that happened to dinner. His lists; correct nothing.
create or replace function public.show_review_ok(review jsonb)
returns boolean
language plpgsql immutable set search_path = public as $$
declare
  q record;
  s record;
  v jsonb;
  n numeric;
  allowed text[];
begin
  -- a review is one object, and it never bloats a row
  if review is null or jsonb_typeof(review) <> 'object' then return false; end if;
  if length(review::text) > 6000 then return false; end if;

  for q in select key, value from jsonb_each(review) loop
    v := q.value;

    if q.key in ('crowd', 'venue', 'greenroom', 'staff', 'area', 'catering', 'sound', 'stage') then
      -- a star question: {"stars": n, "subs": [..], "note": ".."}, subs and note optional
      if jsonb_typeof(v) <> 'object' then return false; end if;
      if exists (select 1 from jsonb_object_keys(v) kk where kk not in ('stars', 'subs', 'note')) then
        return false;
      end if;

      -- stars: 0.5 to 5 in half steps, so twice the stars is a whole number 1..10
      if not (v ? 'stars') or jsonb_typeof(v -> 'stars') <> 'number' then return false; end if;
      n := (v ->> 'stars')::numeric;
      if n * 2 <> trunc(n * 2) or n * 2 < 1 or n * 2 > 10 then return false; end if;

      -- subs: words off this question's own list, and only the side the
      -- stars opened (3 and under speaks Bad, above 3 speaks Good)
      if v ? 'subs' then
        if jsonb_typeof(v -> 'subs') <> 'array' then return false; end if;
        if jsonb_array_length(v -> 'subs') > 14 then return false; end if;
        allowed := case q.key
          when 'crowd' then case when n <= 3
            then array['Dead','Lukewarm','Sleepy','Stiff','Awkward','Sparse','Hostile','Brutal']
            else array['Energetic','Loud','Rowdy','Friendly','Emotional','Relentless','Electric','Large'] end
          when 'venue' then case when n <= 3
            then array['Cramped','Muddy','Outdated','Disorganized','Grimy','Sketchy','Nightmare']
            else array['Clean','Iconic','Intimate','Spacious','Comfortable','Solid','New','Organized'] end
          when 'greenroom' then case when n <= 3
            then array['Shared','Cramped','Muddy','Outdated','Grimy','Sketchy','Nightmare','Noisy','Cold','Dirty','Nonexistent']
            else array['Clean','Spacious','Comfortable','Accommodating','Stocked','Private','Cozy','Convenient','Quiet'] end
          when 'staff' then case when n <= 3
            then array['Absent','Mean','Clueless','Slow','Disorganized','Rude','Unhelpful','Lazy','Territorial','Hostile','Shady']
            else array['Professional','Hospitable','Friendly','Responsive','Organized','Legendary','Helpful','Knowledgable','Dialed','Proactive'] end
          when 'area' then case when n <= 3
            then array['Boring','Isolated','Industrial','Strip Mall','Dead','Dangerous','Sketchy','Rundown','Forgettable','Sleepy','Overpriced','Hectic','Bleak','Grim']
            else array['Safe','Convenient','Quiet','Vibrant','Walkable','Charming','Scenic','Lively','Great Food','Beautiful','Cultured','Underrated','Fun','Chill'] end
          when 'catering' then case when n <= 3
            then array['Bland','Skimpy','Greasy','Cold','Stale','Processed','Nonexistent','Buyout']
            else array['Gourmet','Homemade','Fresh','Generous','Healthy','Thoughtful','Next Level','Legendary','Buyout'] end
          when 'sound' then case when n <= 3
            then array['Boomy','Echoey','Boxy','Harsh','Thin','Quiet','Underpowered','Uneven','Dated','Distorted','Unreliable','Broken']
            else array['Perfect','Treated','Controlled','Massive','Crystal','Punchy','Modern','Powerful','Balanced','Reliable','Updated'] end
          when 'stage' then case when n <= 3
            then array['Tight','Shallow','Bad Production','Removed','Slippery','Awkward','Unsafe','Tiny','Cluttered']
            else array['Massive','Spacious','Pro','Lit','High production','Video Wall','Tall','Intimate','Wide','Catwalk'] end
        end;
        for s in select value from jsonb_array_elements(v -> 'subs') loop
          if jsonb_typeof(s.value) <> 'string' then return false; end if;
          if not ((s.value #>> '{}') = any(allowed)) then return false; end if;
        end loop;
      end if;

      -- note: a short string, 100 characters at most
      if v ? 'note' then
        if jsonb_typeof(v -> 'note') <> 'string' then return false; end if;
        if char_length(v ->> 'note') > 100 then return false; end if;
      end if;

    elsif q.key in ('shower', 'laundry', 'accommodated') then
      -- a yes/no question: {"yn": true|false, "note": ".."}, note optional
      if jsonb_typeof(v) <> 'object' then return false; end if;
      if exists (select 1 from jsonb_object_keys(v) kk where kk not in ('yn', 'note')) then
        return false;
      end if;
      if not (v ? 'yn') or jsonb_typeof(v -> 'yn') <> 'boolean' then return false; end if;
      if v ? 'note' then
        if jsonb_typeof(v -> 'note') <> 'string' then return false; end if;
        if char_length(v ->> 'note') > 100 then return false; end if;
      end if;

    else
      -- a question nobody asked
      return false;
    end if;
  end loop;

  return true;
end $$;
-- The check below runs as the account writing the row, so the people 0154
-- already lets write (the band, through the table's own policies) must be
-- able to call this; nobody else needs it and anon never writes here.
revoke all on function public.show_review_ok(jsonb) from public, anon;
grant execute on function public.show_review_ok(jsonb) to authenticated;

-- The column: empty object until a review is written, never null, and only
-- ever the shape above. Rows written before this file carry '{}', which the
-- validator accepts, so adding the check re-reads the table and passes.
alter table public.show_ratings
  add column if not exists review jsonb not null default '{}'::jsonb;

alter table public.show_ratings drop constraint if exists show_ratings_review_ok;
alter table public.show_ratings add constraint show_ratings_review_ok
  check (public.show_review_ok(review));


-- ====================== 2. venue_history says what the rating was ======================

-- The same function as 0160, with one addition at the end: after the answer
-- is built exactly as before, the band's earlier reviews of this room are
-- averaged and, when there is at least one, 'stars' and 'ratings' ride along.
-- With no matching review the answer is untouched, byte for byte, and the
-- early exits ({'none': true} and the permission raise) are copied unchanged.
--
-- Which reviews match, in plain words:
--   * reviews on shows of this artist's tours: a tour that names the page
--     (doc ->> 'artistId'), or an older tour with no id whose name matches
--     and which the page's own account made (the same guard rates_with_band
--     uses, so a tour somebody else names after the band never feeds the
--     band's numbers), or this very tour (the function already settled whose
--     it is). The Off Tour book and tours in the trash stay out.
--   * the show is read out of the tour's own document the way the own CTE
--     below reads one (tour_id -> doc -> 'shows' -> show_id), and it counts
--     when it is dated before tonight, played (on or before road_today), and
--     folds to this same room by venue_room_key/venue_room_same and the city
--     key. A review whose show was since taken off its tour drops out with
--     the join, as it should.
--   * each review's own number is the mean of the star questions it answered.
--     A review still sitting at '{}' (written before this file) speaks
--     through its old ints instead: the mean of its crowd and venue scores,
--     halved onto the star scale ((crowd+venue)/2 then /2 when both are
--     there; the one that is there, halved, when only one is). A non-empty
--     review with no star questions (only yes/nos) has no number and is not
--     counted.
--   * 'stars' is the average of those numbers rounded to one decimal, and
--     'ratings' is how many reviews it stands on.
--
-- Same gate as 0160 (on_tour), no new grants: the revoke and grant below
-- restate 0160's own lines unchanged.
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

  return res;
end $$;
revoke all on function public.venue_history(text, text) from public, anon;
grant execute on function public.venue_history(text, text) to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   alter table public.show_ratings drop constraint if exists show_ratings_review_ok;
--   alter table public.show_ratings drop column if exists review;  -- written reviews go with it
--   drop function if exists public.show_review_ok(jsonb);
--   venue_history back to 0160's text: copy the create or replace function
--   public.venue_history block out of
--   supabase/migrations/0160_venue_history.sql and run it (its grants are
--   already in place and create or replace keeps them);
--   notify pgrst, 'reload schema';
-- The old crowd/venue/city columns were never touched, so the simple
-- ratings people already gave are exactly where 0154 put them.
