-- Profile numbers that hold still (Devin, 2026-10-12): "another thing i
-- noticed is the analytics on the user profile (Shows, Tours, Cities, &
-- Countries) are constantly changing. This has been an ongoing issue i want
-- to get to the bottom of it"
--
-- The four numbers are worked out fresh each time a profile is opened. Asked
-- four times in a row they come out the same, so nothing in them is random.
-- What moved them, read off the live database:
--
--   1. The server's day is UTC. A night counts once its date is "today or
--      before", and the database's today turns over at 5 pm on the US west
--      coast, 7 pm Central, 8 pm Eastern (an hour earlier each in winter).
--      Tomorrow's show is already in the archive (fans list dates ahead), so
--      it was counted the evening BEFORE it was played: on a person's page at
--      once, on the artist's page seven minutes later.
--   2. A Greenroom tour counted as a tour the moment it was made, before any
--      of its nights had come. Making a tour moved Tours up by one, taking it
--      down moved it back.
--   3. The archive itself was rebuilt and re-ruled from Oct 7 to Oct 11 (read
--      in again, the bands' own pages added, nights settled by hand, new
--      counting rules, tour names folded). Each of those moved the numbers,
--      and nothing was written down to say which one, or when.
--
-- What changes:
--   1. road_today(): the one day a night counts from. It is the day on the US
--      west coast, so a night counts from the start of its own day there.
--   2. road_stats, profile_card, setlist_summarize and setlist_recount_today
--      read that day wherever they read the server's. Nothing else in them
--      changes, but for (3), (5) and (6).
--   3. road_stats counts a Greenroom tour only once at least one of its dated
--      shows has come, and goes on counting it until a band's book has it as
--      a tour (under a tour name the page shows), not merely as nights.
--   4. The recount that follows the day turning moves with the day: from seven
--      past midnight UTC to 07:07 and 08:07 UTC. Midnight on the west coast is
--      07:00 UTC in summer and 08:00 UTC in winter, so one of the two runs is
--      always seven minutes after it; the other one finds nothing new.
--   5. From now on a change leaves a record. Every night carries the time it
--      was first seen, and each time an artist page's four numbers come out
--      different, one line is written: the numbers, what they were, and
--      whether a show's day came, the archive changed, or both.
--   6. The same for a person's own page, which can move when no artist page
--      does (they are listed on another page, a listing ends, an endorsement
--      is taken off, a tour of their own is changed): each night, with the
--      recount, every person's four numbers are looked at, and a line is
--      written when they or what they rest on have moved. Everyone's numbers
--      as they stand before this change are written down first, so what this
--      change itself does to a page is on record too.
--
-- (The phone had a part in it too: until the profile card arrived, every time
-- the app was opened, the header drew one stand-in number. That is mended in
-- the app, at profileHead in src/app.js, not here.)
--
-- Not changed here: every other function that reads the server's day (the
-- screens where crew claim their tours and the "confirmed" count under an
-- artist that comes from them, the list of nights behind a row on an artist
-- page, the scorecard, venue and festival pages, the tour finder, "I was
-- there"). Those stay on UTC, so for the last few hours of a west coast day
-- one of them can show tomorrow's night before the four numbers count it.
--
-- Running it.
--   When: while the UTC date and the west coast date are the same, which is
--   08:10 to 24:00 UTC (1:10 am to 5 pm Pacific in summer, 12:10 am to 4 pm
--   in winter). In the other hours the new day is one behind the old one, so
--   on a show day Shows would dip by one until midnight Pacific: the very
--   wobble this ends. And before the app build that keeps the numbers on the
--   phone, or together with it: a phone that had kept the old numbers would
--   draw them for a moment and then the new ones.
--   What it holds while it runs: everything slow in here (every page counted
--   again, every person's numbers noted twice) only reads the nights, as any
--   profile does. The two things that need a table to themselves (the new
--   column on the nights, the links from the two records to an artist and to
--   an account) come last, take a moment each, and wait at most three seconds
--   for whoever is using those tables. It is one piece of work: if it stops,
--   whatever the reason ("lock timeout" and "deadlock detected" are the likely
--   ones; a page deleted while it ran is another), nothing at all was applied.
--   Run it again, a few seconds after the top of a minute.

-- The day a night counts from. A night counts from the start of its own day
-- on the US west coast. No show in the Americas, Europe, Asia or Australia is
-- then counted before its own day has begun where it is played (only Hawaii
-- and Alaska see theirs a few hours early), where UTC counted every show in
-- the United States the evening before. One place says what "today" is, so a
-- person's page and an artist's page cannot disagree about it.
create or replace function public.road_today()
returns date
language sql stable set search_path = public as $$
  select (now() at time zone 'America/Los_Angeles')::date
$$;
-- Only the counting functions call it, and they run as their owner.
revoke all on function public.road_today() from public, anon, authenticated;
grant execute on function public.road_today() to service_role;

-- The change record: one line each time an artist page's four numbers change.
--   day     the day the numbers were counted up to (road_today() at that moment)
--   was     the four numbers on the line before (null on a page's first line)
--   why     first   the page's first line
--           night   only "played" moved: a show's day came
--           archive only "added" moved, or neither did: the book itself changed
--                   (an older night was found; a night was corrected or taken
--                   off; a tour was named or folded; a counting rule changed)
--           both    both
--   detail  counts only: {"played": n, "added": n, "nights": n, "named": n}
--           played  nights dated after the line before's day, up to this day
--           added   nights first seen after the line before was written, and
--                   dated on or before its day (older nights, new to the archive)
--           nights  every night in the page's book at that moment
--           named   those of them that carry a tour name
--           (the last two are on every line, the first line too: "nights" lower
--           than on the line before says a night was taken off; "named" moved
--           while "nights" held says tours were named, renamed or un-named)
-- The lines of a page are in order by id (the order they were written in);
-- "at" is when the piece of work that wrote the line began.
-- It is written by setlist_summarize, below. Nobody reads it from a phone yet.
-- (Its link to the artist is added at the very end of this file.)
create table if not exists public.road_counts_log (
  id bigint generated always as identity primary key,
  artist_id uuid not null,
  at timestamptz not null default now(),
  day date not null,
  shows int not null,
  tours int not null,
  cities int not null,
  countries int not null,
  was jsonb,
  why text not null,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists road_counts_log_artist_at on public.road_counts_log (artist_id, at desc);
alter table public.road_counts_log enable row level security;
revoke all on public.road_counts_log from public, anon, authenticated;

-- The same record for a person's own page. A person's four numbers rest on
-- more than the artist pages: which pages list them as a member, what an
-- artist confirmed for them, the endorsements that stand, and the Greenroom
-- tours they are on. Any of those can move their numbers while no artist
-- page's numbers move, and then the record above has no line for it.
--   day     the day the numbers were counted up to
--   was     the four numbers on the line before (null on a person's first line)
--   why     first   the person's first line
--           own     something of their own moved since the line before: a
--                   listing, a confirmed claim, an endorsement, a Greenroom
--                   tour, or a dated show of theirs on or before that line's day
--           other   none of those did: a show's day came, an artist page they
--                   are counted on changed (that page's own lines say how), or
--                   a counting rule changed
--   detail  counts only, what the numbers rested on when the line was written:
--           {"listed": pages that list them as a member now,
--            "claims": tour claims an artist approved,
--            "endorsed": endorsements that stand,
--            "tours": Greenroom tours they are on,
--            "nights": dated shows on those tours up to this day}
-- A line is written when the four numbers or any of those five have moved;
-- someone with nothing to their name yet has no line. The lines of a person
-- are in order by id. Nobody reads it from a phone. It goes with the account
-- when an account is deleted (the link is added at the very end of this file).
create table if not exists public.road_person_log (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  at timestamptz not null default now(),
  day date not null,
  shows int not null,
  tours int not null,
  cities int not null,
  countries int not null,
  was jsonb,
  why text not null,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists road_person_log_user on public.road_person_log (user_id, id desc);
alter table public.road_person_log enable row level security;
revoke all on public.road_person_log from public, anon, authenticated;

-- Looks at every person's four numbers and writes a line in road_person_log
-- for each one that has moved. It only reads the counts (road_stats, as a
-- profile does) and writes to its own table. One person's trouble never stops
-- the next person's line: it is noted in the server log and passed over; with
-- "must" set (this file sets it, the nightly run does not) it is then raised
-- at the end, so a change like this one cannot go in with the record broken.
-- Returns how many lines it wrote.
create or replace function public.road_person_note(must boolean default false)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  r record; prev record; j jsonb; d_now date; d_prev date;
  has_prev boolean; own boolean; inputs jsonb;
  n_lines int := 0; n_failed int := 0; first_err text := '';
  n_shows int; n_tours int; n_cities int; n_countries int;
  n_listed int; n_claims int; n_endorsed int; n_own int; n_nights int; n_then int;
begin
  d_now := public.road_today();
  -- (every account, whether or not it has filled in a profile yet: someone can be
  -- listed on a page or put on a tour before they have)
  for r in select u.id as user_id from auth.users u order by u.id loop
    begin
      j := public.road_stats(r.user_id);
      n_shows := coalesce((j ->> 'shows')::int, 0);
      n_tours := coalesce((j ->> 'tours')::int, 0);
      n_cities := coalesce((j ->> 'cities')::int, 0);
      n_countries := coalesce((j ->> 'countries')::int, 0);
      -- their newest line (its day, and what it rested on, under plain names)
      select l.day as upto, l.shows, l.tours, l.cities, l.countries, l.detail as had into prev
        from road_person_log l
       where l.user_id = r.user_id
       order by l.id desc
       limit 1;
      has_prev := found;
      d_prev := null;
      if has_prev then d_prev := prev.upto; end if;
      -- what their numbers rest on, apart from the artist pages themselves
      select count(*) into n_listed from artist_members m
       where m.user_id = r.user_id and m.kind = 'band' and m.ended_at is null;
      select count(*) into n_claims from tour_credits c
       where c.user_id = r.user_id and c.approved is not null;
      select count(*) into n_endorsed from artist_endorsements e
       where e.user_id = r.user_id and e.removed_at is null;
      select count(*) into n_own from public.tours_of(r.user_id) t;
      -- their Greenroom shows with a date, as road_stats reads them: up to today,
      -- and up to the day of the line before (a count that only moves when a show
      -- on or before that day was added, taken off or re-dated)
      select count(*) filter (where (e.v ->> 'date') <= to_char(d_now, 'YYYY-MM-DD')),
             count(*) filter (where (e.v ->> 'date') <= to_char(d_prev, 'YYYY-MM-DD'))
        into n_nights, n_then
        from public.tours_of(r.user_id) t,
             lateral jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e(k, v)
       where jsonb_typeof(e.v) = 'object'
         and (e.v ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$';
      inputs := jsonb_build_object('listed', n_listed, 'claims', n_claims, 'endorsed', n_endorsed, 'tours', n_own, 'nights', n_nights);
      if not has_prev then
        -- nothing to their name yet: no line until there is something
        if n_shows + n_tours + n_cities + n_countries + n_listed + n_claims + n_endorsed + n_own > 0 then
          insert into road_person_log (user_id, day, shows, tours, cities, countries, was, why, detail)
          values (r.user_id, d_now, n_shows, n_tours, n_cities, n_countries, null, 'first', inputs);
          n_lines := n_lines + 1;
        end if;
      else
        own := (prev.had ->> 'listed')::int is distinct from n_listed
            or (prev.had ->> 'claims')::int is distinct from n_claims
            or (prev.had ->> 'endorsed')::int is distinct from n_endorsed
            or (prev.had ->> 'tours')::int is distinct from n_own
            or (prev.had ->> 'nights')::int is distinct from n_then;
        if own or prev.shows <> n_shows or prev.tours <> n_tours or prev.cities <> n_cities or prev.countries <> n_countries then
          insert into road_person_log (user_id, day, shows, tours, cities, countries, was, why, detail)
          values (r.user_id, d_now, n_shows, n_tours, n_cities, n_countries,
                  jsonb_build_object('shows', prev.shows, 'tours', prev.tours, 'cities', prev.cities, 'countries', prev.countries),
                  case when own then 'own' else 'other' end, inputs);
          n_lines := n_lines + 1;
        end if;
      end if;
    exception when others then
      n_failed := n_failed + 1;
      if first_err = '' then first_err := sqlerrm; end if;
      raise log 'road_person_log: no line written for person % (%)', r.user_id, sqlerrm;
    end;
  end loop;
  if must and n_failed > 0 then
    raise exception 'road_person_log: % could not be noted (the first: %)', n_failed, first_err;
  end if;
  return n_lines;
end $$;
revoke all on function public.road_person_note(boolean) from public, anon, authenticated;

-- Everyone's four numbers as they stand BEFORE this change, written down
-- first: road_stats is still the old one at this point in the file. (Their
-- "day" is the west coast day all the same; run in the hours named at the top
-- it is the UTC day too, the one the old count went by.) If the change below
-- moves anyone's numbers, their second line, written further down once the
-- new functions are in, says from what to what.
do $$
begin
  perform public.road_person_note(true);
end $$;

-- road_stats, as it stands in the database (0128's text), with these changes
-- only: the three places that read the server's day read road_today(), and a
-- Greenroom tour counts from its first played night until a band's book has it
-- as a tour.
create or replace function public.road_stats(u uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with cr0 as materialized (
    select s.artist_id, s.tour, to_char(s.d, 'YYYY-MM-DD') as d,
           lower(btrim(coalesce(s.venue, ''))) as venue,
           public.road_city_key(s.city) as city, upper(coalesce(s.country_code, '')) as ctry,
           case when upper(coalesce(s.country_code, '')) in ('US', 'CA') then public.road_region(s.state) else '' end as region
      from public.credited_shows(u) s
     where s.d is not null and s.d <= public.road_today()
  ), gr as (
    select (e.v ->> 'date') as d,
           lower(btrim(coalesce(e.v ->> 'venue', ''))) as venue,
           public.road_city_key(split_part(coalesce(e.v ->> 'city', ''), ',', 1)) as city,
           public.road_country(e.v ->> 'city') as ctry,
           case when public.road_country(e.v ->> 'city') in ('US', 'CA')
                 and upper(btrim(substring(e.v ->> 'city' from ',([^,]*)$'))) ~ '^[A-Z]{2}$'
                then upper(btrim(substring(e.v ->> 'city' from ',([^,]*)$'))) else '' end as region
      from public.tours_of(u) t,
           lateral jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e(k, v)
     where jsonb_typeof(e.v) = 'object'
       and (e.v ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
       and (e.v ->> 'date') <= to_char(public.road_today(), 'YYYY-MM-DD')
  ), cr as (
    select * from cr0
  ), grp as materialized (
    -- each artist's tour groups, worked out once (not once per show)
    select a.artist_id, g.tour, g.gk, g.hidden
      from (select distinct c.artist_id from cr c) a
      cross join lateral public.artist_tour_groups(a.artist_id) g
  ), nights as (
    -- A night an artist's own page has is counted as that page has it (the room,
    -- the city, the country): the person's page and the artist's page then say
    -- the same thing. A Greenroom show only adds a night the artist's page does
    -- not have yet (tonight's, before it is in the band's book).
    select d, venue, city, ctry, region from cr
    union all
    select g.d, g.venue, g.city, g.ctry, g.region from gr g where not exists (select 1 from cr c where c.d = g.d)
  ), pc as (
    select public.road_place_counts(array_agg(ctry), array_agg(region), array_agg(city)) as j from nights
  )
  select jsonb_build_object(
    -- the artist's tours, counted exactly as the artist page counts them, plus the person's own
    -- Greenroom tours that are not already in a band's book (half or more of a tour's dates there)
    'tours', (select count(*) from (
                select 1 from cr c join grp g on g.artist_id = c.artist_id and g.tour = c.tour
                 where c.tour <> '' and not g.hidden
                 group by c.artist_id, g.gk) x)
           -- (Played dates against played dates: a tour half-way through, whose played
           -- nights are all in the band's book, is that band's tour and not one more.)
           -- A tour counts from its first played night, never before. One that was only
           -- just made, or whose first show is still ahead, is not a tour on the page
           -- yet: it used to count the moment it was made, so making a tour and taking
           -- it down moved this number up and back.
           -- And it goes on counting until a band's book has it AS A TOUR: half or more
           -- of its played dates are in the book, and at least one of them under a tour
           -- name the page shows. It used to stop as soon as half its dates were in the
           -- book, named or not: someone listing opening night with no tour name took
           -- the tour off the page, and it came back days later when the nights were
           -- named. (Named, the band's tour is counted in the line above, and this one
           -- steps aside at that same moment.)
           -- For each tour, worked out once: p, its dated shows up to today; a, those
           -- of them a band's book already has; an, those of them the book has under a
           -- shown tour name. ("offset 0" keeps the counts from being copied into the
           -- test below and run twice.)
           + (select count(*) from (
                select (select count(*) from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
                         where (e.value ->> 'date') in (select c.d from cr c)) as a,
                       (select count(*) from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
                         where (e.value ->> 'date') in (select c.d from cr c join grp g on g.artist_id = c.artist_id and g.tour = c.tour
                                                         where c.tour <> '' and not g.hidden)) as an,
                       (select count(*) from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
                         where jsonb_typeof(e.value) = 'object' and (e.value ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
                           and (e.value ->> 'date') <= to_char(public.road_today(), 'YYYY-MM-DD')) as p
                  from public.tours_of(u) t
                offset 0) n
               where n.p > 0 and (n.a * 2 < n.p or n.an = 0)),
    'shows', (select count(distinct (d, venue)) from nights),
    'cities', coalesce((select (j ->> 'cities')::int from pc), 0),
    'countries', coalesce((select (j ->> 'countries')::int from pc), 0),
    'firstYear', (select left(min(d), 4)::int from nights))
$function$;
revoke all on function public.road_stats(uuid) from public, anon, authenticated;

-- profile_card, as it stands in the database (0132's text), with one change:
-- the crew tours list reads road_today() where it read the server's day.
create or replace function public.profile_card(u uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p public.profiles%rowtype;
begin
  if not public.can_see_profile(u) then return null; end if;
  select * into p from profiles where user_id = u;
  return jsonb_build_object(
    'userId', u,
    'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
    'handle', coalesce(p.handle, ''),
    'verified', exists (select 1 from verified_users v where v.user_id = u),
    'bio', coalesce(p.bio, ''),
    'roles', to_jsonb(coalesce(p.roles, '{}'::text[])),
    'tourRole', coalesce(p.tour_role, ''),
    'avatar', coalesce(p.avatar, ''),
    'artists', to_jsonb(coalesce(p.artists, '{}'::text[])),
    -- The artist profiles that list them as a member or crew: the artist's own
    -- word for it. Then any artist that endorsed them and no longer lists
    -- them (they left or were let go, or the page is gone): the endorsement
    -- still stands, and so does everything up to the day they left.
    'acts', coalesce((
      select jsonb_agg(x.j order by x.at) from (
        select jsonb_build_object('id', a.id, 'name', a.name, 'handle', a.handle, 'avatar', a.avatar, 'kind', m.kind, 'role', coalesce(m.role, ''),
                 'endorsed', e.id is not null,
                 -- Yours to remove, so your own page gets which one it is.
                 'eid', case when u = auth.uid() then e.id end,
                 -- For the account that runs this artist: it's theirs to endorse from,
                 -- unless this person took its endorsement off before.
                 'mine', a.owner_id = auth.uid(),
                 'declined', a.owner_id = auth.uid() and exists (select 1 from artist_endorsements d
                    where d.artist_id = a.id and d.user_id = u and d.removed_at is not null)) as j,
               m.created_at as at
          from artist_members m join artists a on a.id = m.artist_id
          left join artist_endorsements e on e.artist_id = a.id and e.user_id = u and e.removed_at is null
         where m.user_id = u and m.ended_at is null
        union all
        select jsonb_build_object('id', a.id, 'name', coalesce(a.name, nullif(e.artist_name, ''), 'An artist'),
                 'handle', coalesce(a.handle, e.artist_handle), 'avatar', coalesce(a.avatar, ''),
                 -- (what they were when they left, if the page ended the listing; else what they were when endorsed)
                 'kind', coalesce((select m.kind from artist_members m where m.artist_id = e.artist_id and m.user_id = u), e.kind),
                 'role', coalesce(e.role, ''),
                 'endorsed', true, 'past', true, 'eid', case when u = auth.uid() then e.id end,
                 -- the day they stopped being listed, when the page ended it (null: never listed, or the listing is gone)
                 'until', (select to_char(m.ended_at, 'YYYY-MM-DD') from artist_members m where m.artist_id = e.artist_id and m.user_id = u)),
               e.created_at
          from artist_endorsements e left join artists a on a.id = e.artist_id
         where e.user_id = u and e.removed_at is null
           and not exists (select 1 from artist_members m where m.artist_id = e.artist_id and m.user_id = u and m.ended_at is null)
        union all
        -- An artist they left that had not endorsed them: it still shows, as past.
        select jsonb_build_object('id', a.id, 'name', a.name, 'handle', a.handle, 'avatar', a.avatar, 'kind', m.kind, 'role', coalesce(m.role, ''),
                 'endorsed', false, 'past', true, 'until', to_char(m.ended_at, 'YYYY-MM-DD')),
               m.created_at
          from artist_members m join artists a on a.id = m.artist_id
         where m.user_id = u and m.ended_at is not null
           and not exists (select 1 from artist_endorsements e
                            where e.artist_id = m.artist_id and e.user_id = u and e.removed_at is null)) x), '[]'::jsonb),
    -- Their flowers and the artists who endorsed them, for anyone who can see their page.
    'flowers', (public.flower_counts(u) ->> 'flowers')::int,
    'endorsements', (public.flower_counts(u) ->> 'endorsements')::int,
    -- The flowers they've been given, newest first, for their Stats tab: who
    -- (while you can see that person's profile), what for, when, the note.
    'gotFlowers', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', f.id, 'n', f.n, 'note', f.note, 'at', f.created_at, 'category', coalesce(f.category, ''),
          'from', case when public.can_see_profile(f.from_id) then f.from_id end,
          'name', case when public.can_see_profile(f.from_id) then public.person_name(f.from_id) else '' end,
          'avatar', case when public.can_see_profile(f.from_id) then coalesce(fp.avatar, '') else '' end)
        order by f.created_at desc)
      from (select x.* from flowers x join tours y on y.id = x.tour_id
             where x.to_id = u and coalesce(y.doc ->> 'kind', '') <> 'offtour' and (y.doc ->> 'deletedAt') is null
             order by x.created_at desc limit 100) f
      left join profiles fp on fp.user_id = f.from_id), '[]'::jsonb),
    'followers', (select count(*) from follows f where f.followee_id = u),
    'following', (select count(*) from follows f where f.follower_id = u),
    'iFollow', exists (select 1 from follows f where f.follower_id = auth.uid() and f.followee_id = u),
    'followsMe', exists (select 1 from follows f where f.follower_id = u and f.followee_id = auth.uid()),
    'tours', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', t.id,
          'artist', trim(coalesce(t.doc ->> 'artist', '')),
          'name', trim(coalesce(t.doc ->> 'name', '')),
          'first', (select min(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x),
          'last', (select max(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x),
          'shows', jsonb_array_length(public.tour_dates(t.doc)),
          'mine', public.my_role(t.id) is not null)
        order by (select max(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x) desc nulls last, t.id)
      from public.tours_of(u) t), '[]'::jsonb),
    -- The person's road story: the nights already played on the Greenroom
    -- tours they're on, plus the nights an artist confirmed for them (tour
    -- credits). One night counts once however many ways it's known, and a
    -- confirmed tour that is one of their Greenroom tours isn't a second tour.
    'roadStats', public.road_stats(u),
    -- What each artist has confirmed for them, artist by artist. A member has
    -- every night of the artist, so theirs is the artist page's own count,
    -- read from the same place that page reads it; a member who left keeps
    -- every night up to the day they left; a claim is only for crew.
    'credits', coalesce((
      select jsonb_agg(x.j) from (
        select jsonb_build_object('artistId', m.artist_id,
                 'tours', coalesce((h.summary ->> 'tours')::int, 0), 'shows', coalesce((h.summary ->> 'shows')::int, 0)) as j
          from artist_members m join artist_history h on h.artist_id = m.artist_id
         where m.user_id = u and m.kind = 'band' and m.ended_at is null
        union all
        select jsonb_build_object('artistId', m.artist_id) || public.credit_counts(m.artist_id,
                 jsonb_build_object('all', true, 'until', to_char(m.ended_at, 'YYYY-MM-DD')))
          from artist_members m
         where m.user_id = u and m.kind = 'band' and m.ended_at is not null
        union all
        select jsonb_build_object('artistId', c.artist_id) || public.credit_counts(c.artist_id,
                 -- still listed: the claim runs on; left: it stops the day they left
                 public.credit_claim_live(c.artist_id, c.user_id, c.approved))
          from tour_credits c where c.user_id = u and c.approved is not null
           and not exists (select 1 from artist_members b where b.artist_id = c.artist_id and b.user_id = u and b.kind = 'band')) x), '[]'::jsonb),
    -- ...and those tours by name, for their Tours tab. A band member's list is
    -- the artist page's list, entry for entry (Devin: "any shows or tours or
    -- festivals ... added to the list on the artist page ... should update on
    -- the people listed under band"): its tours, its festivals, each year's
    -- shows outside a tour. Crew get the tours an artist confirmed for them.
    'creditTours', coalesce((
      with band as materialized (
        -- (a member who left: the artist page's list as it stood the day they left)
        select m.artist_id, a.name as artist,
               case when m.ended_at is null then h.summary -> 'toursList'
                    else public.artist_list_until(m.artist_id, m.ended_at) end as list
          from artist_members m join artists a on a.id = m.artist_id
          left join artist_history h on h.artist_id = m.artist_id
         where m.user_id = u and m.kind = 'band'),
      grp as materialized (
        -- each crediting artist's tour groups, worked out once
        select ar.artist_id, gg.tour, gg.gk, gg.hidden, gg.shown
          from (select distinct c.artist_id from tour_credits c where c.user_id = u and c.approved is not null
                   and not exists (select 1 from band b where b.artist_id = c.artist_id)) ar
          cross join lateral public.artist_tour_groups(ar.artist_id) gg),
      cs as materialized (
        select s.* from public.credited_shows(u) s where not exists (select 1 from band b where b.artist_id = s.artist_id)),
      ent as (
        select b.artist_id, b.artist, coalesce(e ->> 'key', '') as tkey, coalesce(e ->> 'name', '') as nm,
               case when (e ->> 'n') ~ '^[0-9]+$' then (e ->> 'n')::int else 0 end as n,
               e ->> 'first' as d0, e ->> 'last' as d1, coalesce(e ->> 'kind', 'tour') as kind
          from band b
          cross join lateral jsonb_array_elements(case when jsonb_typeof(b.list) = 'array' then b.list else '[]'::jsonb end) e
        union all
        select s.artist_id, a.name, g.gk, coalesce(max(g.shown), mode() within group (order by s.tour)),
               count(distinct (s.d, lower(s.venue)))::int, min(s.d)::text, max(s.d)::text, 'tour'
          from cs s join artists a on a.id = s.artist_id
          join grp g on g.artist_id = s.artist_id and g.tour = s.tour
         where s.tour <> '' and not g.hidden and (s.d is null or s.d <= public.road_today())
         group by s.artist_id, a.name, g.gk)
      select jsonb_agg(jsonb_build_object('artistId', x.artist_id, 'artist', x.artist, 'key', x.tkey, 'name', x.nm,
               'n', x.n, 'first', x.d0, 'last', x.d1, 'kind', x.kind) order by x.d1 desc nulls last, x.nm)
        from (select * from ent order by d1 desc nulls last, nm limit 400) x), '[]'::jsonb),
    'logos', coalesce((
      select jsonb_object_agg(a.artist, a.logo) from (
        select distinct on (lower(trim(coalesce(t.doc ->> 'artist', ''))))
               lower(trim(coalesce(t.doc ->> 'artist', ''))) as artist, l.doc ->> 'dataUrl' as logo
          from public.tours_of(u) t
          join labels l on l.owner_id = t.owner_id
           and l.id = 'alogo:' || left(trim(both '-' from
                 regexp_replace(lower(trim(coalesce(t.doc ->> 'artist', ''))), '[^a-z0-9]+', '-', 'g')), 40)
         where coalesce(l.doc ->> 'dataUrl', '') <> ''
      ) a), '{}'::jsonb)
  );
end $function$;
revoke all on function public.profile_card(uuid) from public, anon;
grant execute on function public.profile_card(uuid) to authenticated;

-- setlist_summarize, as it stands in the database (0128's text), with these
-- changes only: the six places that read the server's day read road_today(),
-- and the change record is written at the end.
create or replace function public.setlist_summarize(a_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s jsonb; pc jsonb;
begin
  -- cities and countries, by the one rule a person's page counts by too (road_place_counts)
  select public.road_place_counts(
           array_agg(upper(coalesce(h.country_code, ''))),
           array_agg(case when upper(coalesce(h.country_code, '')) in ('US', 'CA') then public.road_region(h.state) else '' end),
           array_agg(public.road_city_key(h.city)))
    into pc
    from artist_history_shows h
   where h.artist_id = a_id and h.date <= public.road_today();
  create temp table if not exists tg (tour text, gk text, hidden boolean, shown text) on commit drop;
  truncate tg;
  insert into tg select * from public.artist_tour_groups(a_id);
  select jsonb_build_object(
    'shows', count(distinct (h.date, lower(h.venue))) filter (where h.date <= public.road_today()),
    'festivals', (select count(distinct h6.festival) from artist_history_shows h6
                   where h6.artist_id = a_id and h6.festival <> '' and h6.date <= public.road_today()
                     and public.artist_tour_gkey(a_id, h6.festival) not in (select g.gk from tg g where not g.hidden)),
    'countries', coalesce((pc ->> 'countries')::int, 0),
    'cities', coalesce((pc ->> 'cities')::int, 0),
    'firstYear', min(extract(year from date))::int,
    'lastYear', max(extract(year from date))::int,
    -- (played nights only, as shows, cities and countries are: a person's page counts the same way)
    'tours', (select count(distinct g.gk) from artist_history_shows h2 join tg g on g.tour = h2.tour
               where h2.artist_id = a_id and not g.hidden and h2.date <= public.road_today()),
    'years', coalesce((select jsonb_object_agg(y, n) from (
       select extract(year from h3.date)::int as y, count(distinct (h3.date, lower(h3.venue))) as n
         from artist_history_shows h3
        where h3.artist_id = a_id and h3.date is not null and h3.date <= public.road_today()
        group by 1) yy), '{}'::jsonb),
    'toursList', coalesce((select jsonb_agg(jsonb_build_object(
         'name', coalesce(t.shown, t.name),
         'n', t.n + (select count(*) from artist_tour_conflicts cf
                      join artist_history_shows hh on hh.artist_id = a_id and hh.date = cf.date
                      left join tg g2 on g2.tour = hh.tour
                     where cf.artist_id = a_id and t.gk in (cf.key_a, cf.key_b) and coalesce(g2.gk, '') <> t.gk),
         'first', t.first, 'last', t.last,
         'lineup', coalesce((select c.lineup from tour_candidates c where c.artist_id = a_id and c.status = 'added' and c.lineup <> ''
                               and public.artist_tour_gkey(a_id, c.name) = t.gk order by jsonb_array_length(c.dates) desc limit 1), ''),
         'conflict', exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and t.gk in (cf.key_a, cf.key_b)),
         -- a touring festival (Warped, Taste of Chaos) is a tour; only a festival of a night or three is tagged one
         'kind', case when t.n <= 3 and t.gk in (select public.artist_tour_gkey(a_id, f.festival) from artist_history_shows f where f.artist_id = a_id and f.festival <> '') then 'festival' else 'tour' end)
         order by t.last desc nulls last)
       from (
         select g.gk, max(g.shown) as shown, mode() within group (order by h4.tour) as name, count(distinct (h4.date, lower(h4.venue))) as n,
                min(h4.date) as first, max(h4.date) as last
           from artist_history_shows h4 join tg g on g.tour = h4.tour
          where h4.artist_id = a_id and not g.hidden
          group by g.gk) t), '[]'::jsonb)
      -- Festivals that are not also a tour label on the page: their own entries (Devin: festivals listed by name).
      || coalesce((select jsonb_agg(jsonb_build_object('name', f.festival, 'n', f.n, 'first', f.first, 'last', f.last, 'lineup', '', 'conflict', false, 'kind', 'festival')
                                    order by f.last desc)
         from (select h7.festival, count(distinct (h7.date, lower(h7.venue))) as n, min(h7.date) as first, max(h7.date) as last
                 from artist_history_shows h7 where h7.artist_id = a_id and h7.festival <> ''
                  and public.artist_tour_gkey(a_id, h7.festival) not in (select g.gk from tg g)
                group by h7.festival) f), '[]'::jsonb)
      -- Shows outside any tour or festival, year by year, so every night on the page can be opened.
      || coalesce((select jsonb_agg(jsonb_build_object('name', 'Shows outside a tour · ' || y.yr, 'key', 'year:' || y.yr, 'n', y.n,
                                    'first', y.first, 'last', y.last, 'lineup', '', 'conflict', false, 'kind', 'shows') order by y.last desc)
         from (select extract(year from h8.date)::int as yr, count(distinct (h8.date, lower(h8.venue))) as n, min(h8.date) as first, max(h8.date) as last
                 from artist_history_shows h8
                where h8.artist_id = a_id and h8.tour = '' and h8.festival = '' and h8.date <= public.road_today()
                group by 1) y), '[]'::jsonb),
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
  -- The change record (road_counts_log): one line each time this page's four
  -- numbers come out different from the last line written for it, with what
  -- they were and why they moved. It is a note beside the count and never part
  -- of it: it runs here, after the summary is stored, in a block of its own,
  -- and anything that goes wrong inside it (the table gone, a lock, a value it
  -- did not expect) is swallowed, because a page that cannot be counted is far
  -- worse than a line missing from a log. It changes nothing this function
  -- stores or returns. (Nothing is worked out in the "declare": a failure there
  -- would not be caught.)
  declare
    kept boolean; prev record; d_now date;
    n_shows int; n_tours int; n_cities int; n_countries int;
    n_played int := 0; n_added int := 0; n_nights int := 0; n_named int := 0;
  begin
    -- Is there a page to keep a record for? Asked here and not read off the
    -- update above, so a statement put between the two one day cannot quietly
    -- switch the record off, or on.
    kept := exists (select 1 from artist_history ah where ah.artist_id = a_id);
    if kept then
      d_now := public.road_today();
      n_shows := coalesce((s ->> 'shows')::int, 0);
      n_tours := coalesce((s ->> 'tours')::int, 0);
      n_cities := coalesce((s ->> 'cities')::int, 0);
      n_countries := coalesce((s ->> 'countries')::int, 0);
      -- The page's newest line (its time and its day under plain names): the one
      -- written last, which is the one with the highest id. Not the latest "at":
      -- that is when the piece of work that wrote a line began, and of two pieces
      -- of work that overlap, the one that began first can write last. (For one
      -- page they write one after the other: each holds the page's row from the
      -- update above until it is done.)
      select l.at as written, l.day as upto, l.shows, l.tours, l.cities, l.countries into prev
        from road_counts_log l
       where l.artist_id = a_id
       order by l.id desc
       limit 1;
      if not found then
        -- nights: every night in the page's book. named: those under a tour name.
        select count(*), count(*) filter (where h.tour <> '')
          into n_nights, n_named
          from artist_history_shows h
         where h.artist_id = a_id;
        insert into road_counts_log (artist_id, day, shows, tours, cities, countries, was, why, detail)
        values (a_id, d_now, n_shows, n_tours, n_cities, n_countries, null, 'first',
                jsonb_build_object('nights', n_nights, 'named', n_named));
      elsif prev.shows <> n_shows or prev.tours <> n_tours or prev.cities <> n_cities or prev.countries <> n_countries then
        -- played: nights whose day has come since the last line (dated after its
        --         day, up to today).
        -- added:  older nights that are new to the archive (first seen after the
        --         last line was written, dated on or before its day).
        -- nights: every night in the page's book. named: those under a tour name.
        --         (Against the line before: fewer nights, one was taken off; the
        --         same nights and a different "named", tours were named or renamed.)
        select count(distinct (h.date, lower(h.venue))) filter (where h.date > prev.upto and h.date <= d_now),
               count(distinct (h.date, lower(h.venue))) filter (where h.first_seen > prev.written and h.date <= prev.upto),
               count(*), count(*) filter (where h.tour <> '')
          into n_played, n_added, n_nights, n_named
          from artist_history_shows h
         where h.artist_id = a_id;
        insert into road_counts_log (artist_id, day, shows, tours, cities, countries, was, why, detail)
        values (a_id, d_now, n_shows, n_tours, n_cities, n_countries,
                jsonb_build_object('shows', prev.shows, 'tours', prev.tours, 'cities', prev.cities, 'countries', prev.countries),
                -- 'night': a show's day came. 'archive': the book itself changed (an older
                -- night was found, or neither count moved: a night was corrected or taken
                -- off, a tour was named or folded, a counting rule changed). 'both': both.
                case when n_played > 0 and n_added > 0 then 'both' when n_played > 0 then 'night' else 'archive' end,
                jsonb_build_object('played', n_played, 'added', n_added, 'nights', n_nights, 'named', n_named));
      end if;
    end if;
  exception when others then
    raise log 'road_counts_log: no line written for artist % (%)', a_id, sqlerrm;
  end;
  return s;
end $function$;
revoke all on function public.setlist_summarize(uuid) from public, anon, authenticated;

-- setlist_recount_today, as it stands in the database (0128's text), with two
-- changes: "today" is road_today(), and before the pages are counted each
-- person's own numbers are noted (road_person_note, above).
create or replace function public.setlist_recount_today()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; n int := 0;
begin
  -- First each person's own four numbers, noted where they have moved
  -- (road_person_log). It only reads the nights, so it runs before the pages
  -- below are held for their recount. A note beside the count and never part
  -- of it: whatever goes wrong in it is swallowed here, and the pages are
  -- counted all the same.
  begin
    perform public.road_person_note();
  exception when others then
    raise log 'road_person_log: the nightly note did not run (%)', sqlerrm;
  end;
  for r in select ah.artist_id from artist_history ah
            where exists (select 1 from artist_history_shows s where s.artist_id = ah.artist_id and s.date = public.road_today())
  loop
    perform public.setlist_summarize(r.artist_id);
    n := n + 1;
  end loop;
  return n;
end $function$;
revoke all on function public.setlist_recount_today() from public, anon, authenticated;

-- The recount runs a few minutes after the day turns, and the day now turns at
-- midnight on the US west coast: 07:00 UTC in summer, 08:00 UTC in winter. So
-- it moves from 00:07 UTC to 07:07 and 08:07 UTC: seven minutes after that
-- midnight in both halves of the year. The run that is not the one after
-- midnight (08:07 in summer, 07:07 in winter, an hour before the day turns)
-- finds every page as it left it and writes no line.
-- Only the job's schedule is changed; what it runs is left exactly as it is.
-- (Where there is no scheduler, or no such job, there is nothing to move.)
do $do$
begin
  if to_regclass('cron.job') is null then
    raise notice 'no scheduler here: greenroom-recount was not moved';
  elsif not exists (select 1 from cron.job where jobname = 'greenroom-recount') then
    raise notice 'no greenroom-recount job here: nothing was moved';
  else
    perform cron.alter_job(job_id := (select jobid from cron.job where jobname = 'greenroom-recount'), schedule := '7 7,8 * * *');
  end if;
end $do$;

-- Everyone's four numbers again, now by the new day and the new rule for a
-- Greenroom tour: whoever this change moved gets a second line, with what the
-- numbers were. (A person's numbers are counted from the nights themselves,
-- not from a page's stored count, so this does not wait for the recount below.)
do $$
begin
  perform public.road_person_note(true);
end $$;

-- Every artist page is counted again, by the new day, so no page waits for its
-- next sync to agree with its people's pages; and so that each page's first
-- line in the record is written now, in the same piece of work that stamps its
-- nights "known before this date" (just below).
do $$
declare r record;
begin
  for r in select artist_id from artist_history where exists (select 1 from artist_history_shows s where s.artist_id = artist_history.artist_id)
  loop
    perform public.setlist_summarize(r.artist_id);
  end loop;
end $$;

-- Last, the two things that need a table to themselves for a moment. They are
-- last on purpose: every profile reads the nights, and a lock taken at the top
-- of this file would have been held through all the counting above (several
-- seconds, with every profile waiting behind it; a phone's call is dropped at
-- eight). Here it is held for an instant. And it never waits long for its
-- turn: after three seconds this stops, and nothing in this file is applied.
set local lock_timeout = '3s';

-- When a night was first seen in the archive. Every night already here takes
-- the time this migration ran: for those it means "known before this date",
-- no more. A night that arrives later carries its own time, so a night that
-- was added afterwards can be told from one that was always there. (A re-read
-- that finds a night again does not touch it. A night taken off and filed
-- again starts over.)
alter table public.artist_history_shows
  add column if not exists first_seen timestamptz not null default now();

-- The links from the two records: an artist page's lines go with the page, a
-- person's lines go with the account.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'road_counts_log_artist_id_fkey' and conrelid = 'public.road_counts_log'::regclass) then
    alter table public.road_counts_log
      add constraint road_counts_log_artist_id_fkey foreign key (artist_id) references public.artists (id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'road_person_log_user_id_fkey' and conrelid = 'public.road_person_log'::regclass) then
    alter table public.road_person_log
      add constraint road_person_log_user_id_fkey foreign key (user_id) references auth.users (id) on delete cascade;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
-- The four functions first (they call road_today(), and one of them calls
-- road_person_note(), so they go back before those are dropped). Their text
-- before this change is in the repository word for word, checked against the
-- database on 2026-10-12. Run again, each with the revoke (and grant) lines
-- under it:
--   road_stats             the statement in 0128_one_place_count.sql
--   setlist_summarize      the statement in 0128_one_place_count.sql
--   setlist_recount_today  the statement in 0128_one_place_count.sql
--   profile_card           the statement in 0132_leaving_keeps_history.sql
--                          (it has no grant lines there; the grants it has now stay)
-- (Those pointers hold only while no migration after this one has re-stated
-- any of the four. If one has, the text to go back to is that later one's,
-- with this file's changes taken out of it.)
-- Then, in this order:
--
--   -- the recount back to seven past midnight UTC (the schedule only)
--   select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'greenroom-recount'), schedule := '7 0 * * *');
--
--   drop function if exists public.road_person_note(boolean);
--   drop function if exists public.road_today();
--   drop table if exists public.road_person_log;
--   drop table if exists public.road_counts_log;
--   alter table public.artist_history_shows drop column if exists first_seen;
--
--   -- every page counted again, by the server's day as before
--   do $$
--   declare r record;
--   begin
--     for r in select artist_id from artist_history where exists (select 1 from artist_history_shows s where s.artist_id = artist_history.artist_id)
--     loop
--       perform public.setlist_summarize(r.artist_id);
--     end loop;
--   end $$;
--
--   notify pgrst, 'reload schema';
--
-- Nothing is lost by it but the two records themselves (the lines written so
-- far, and when each night was first seen). The numbers go back to turning
-- over at midnight UTC, a tour with no night played counts again, and a tour
-- whose nights are in a band's book with no tour name stops counting again.
