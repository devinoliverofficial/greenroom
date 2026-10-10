-- One count for places, and a band member's page that follows the artist's
-- (Devin, 2026-10-10): "can you make sure the amount of cities is accurate ...
-- counting every city without counting any cities twice. same with countries.
-- Also I noticed the list of tours on the I See Stars page updated but it
-- didn't reflect on the artist. This across the app should always update. If
-- an artist page updates anything like shows, tours, cities, countries, and
-- any shows or tours or festivals are added to the list on the artist page it
-- should update on the people listed under band."
--
-- What was wrong, read off I See Stars' 1,350 nights (400 cities, 34 countries):
--   * Montreal was three cities: one filed with its province, one with
--     "Canada" where the province goes, one under the United States. Ottawa
--     and Windsor were two each.
--   * "W. Hollywood" and West Hollywood, "E. Rutherford" and East Rutherford,
--     were two cities each.
--   * A state written where the city goes ("South Carolina", venue to be
--     announced) counted as a city.
--   * The 34 countries are right: each is a real country the band played.
--   * A band member's Tours tab was built by its own query (tours only), so
--     the artist page's festivals and its "Shows outside a tour" years never
--     reached it; and the line under the act on their Artists tab came from an
--     old claim.
--
-- What changes:
--   1. road_place_counts: the ONE rule for counting cities and countries, used
--      by the artist page (setlist_summarize) and by a person's page
--      (road_stats). A Canadian province is in Canada whatever country the
--      row was filed under; a night with no state is the same city as the
--      night in that country that has one; a night with no country is the
--      same city as the one that has a country. (The night filed as "South
--      Carolina, venue to be announced" is settled by hand below: a rule that
--      guessed a state's name is never a city would lose New York.)
--   2. road_city_key reads "W." / "E." / "N." / "S." in front of a name as
--      West / East / North / South, drops a note left open in brackets, and
--      reads a name the same with or without its accents, hyphens and
--      apostrophes (Montréal / Montreal, Wilkes-Barre / Wilkes Barre).
--   3. On a person's page, a night the artist's page has is counted as that
--      page has it; a Greenroom show only adds a night the artist's page does
--      not have yet. (It was the other way round: the person's typed city
--      replaced the band's, which is how the two pages could disagree.)
--   4. A band member's Tours tab is the artist page's own list, entry for
--      entry, and the count under the act is the artist page's count.
--   5. The daily re-read settles each page as it lands, and the day changing
--      recounts the pages that have a night today (both at the end).

create or replace function public.road_city_key(city text)
returns text
language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           btrim(regexp_replace(regexp_replace(regexp_replace(
             -- accents off, so Montréal is Montreal and São Paulo is Sao Paulo
             translate(lower(regexp_replace(regexp_replace(coalesce(city, ''), '\s*\(.*\)\s*', ' ', 'g'), '\s*\(.*$', '')),
                       'áàâäãåāçćčďéèêëēęěíìîïīłñńňóòôöõōøřśšťúùûüūůýÿźżž',
                       'aaaaaaacccdeeeeeeeiiiiilnnnooooooorsstuuuuuuyyzzz'),
             '[.''’]', '', 'g'), '-', ' ', 'g'), '\s+', ' ', 'g')),
           '^saint ', 'st '), '^mount ', 'mt '), '^fort ', 'ft '),
           '^n ', 'north '), '^s ', 'south '), '^e ', 'east '), '^w ', 'west '),
           '^new york city$', 'new york'), '^nyc$', 'new york'), '^washington dc$', 'washington')
$$;
revoke all on function public.road_city_key(text) from public, anon, authenticated;

-- Cities and countries from a list of nights (three arrays, one entry a night:
-- the country's two letters, the state or province's two letters for the US
-- and Canada, the city's key). The one place this is decided.
create or replace function public.road_place_counts(ctrys text[], regions text[], cities text[])
returns jsonb
language sql immutable as $$
  with n as (
    select distinct
           -- a Canadian province is in Canada, whatever country the night was filed under
           case when upper(coalesce(t.r, '')) = any (array['ON','QC','BC','AB','MB','SK','NS','NB','PE','YT','NT','NU','NL']) then 'CA'
                else upper(coalesce(t.c, '')) end as ctry,
           upper(coalesce(t.r, '')) as region,
           coalesce(t.k, '') as city
      from unnest(ctrys, regions, cities) as t(c, r, k)
  )
  select jsonb_build_object(
    'cities', (select count(*) from n a
                where a.city <> ''
                  -- no state on it: the same city as the one in that country that has a state
                  and not (a.region = '' and a.ctry in ('US', 'CA')
                           and exists (select 1 from n b where b.ctry = a.ctry and b.city = a.city and b.region <> ''))
                  -- no country on it: the same city as the one that has a country
                  and not (a.ctry !~ '^[A-Z]{2}$'
                           and exists (select 1 from n b where b.city = a.city and b.ctry ~ '^[A-Z]{2}$'))),
    'countries', (select count(distinct a.ctry) from n a where a.ctry ~ '^[A-Z]{2}$'))
$$;
revoke all on function public.road_place_counts(text[], text[], text[]) from public, anon, authenticated;

create or replace function public.setlist_summarize(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s jsonb; pc jsonb;
begin
  -- cities and countries, by the one rule a person's page counts by too (road_place_counts)
  select public.road_place_counts(
           array_agg(upper(coalesce(h.country_code, ''))),
           array_agg(case when upper(coalesce(h.country_code, '')) in ('US', 'CA') then public.road_region(h.state) else '' end),
           array_agg(public.road_city_key(h.city)))
    into pc
    from artist_history_shows h
   where h.artist_id = a_id and h.date <= current_date;
  create temp table if not exists tg (tour text, gk text, hidden boolean, shown text) on commit drop;
  truncate tg;
  insert into tg select * from public.artist_tour_groups(a_id);
  select jsonb_build_object(
    'shows', count(distinct (h.date, lower(h.venue))) filter (where h.date <= current_date),
    'festivals', (select count(distinct h6.festival) from artist_history_shows h6
                   where h6.artist_id = a_id and h6.festival <> '' and h6.date <= current_date
                     and public.artist_tour_gkey(a_id, h6.festival) not in (select g.gk from tg g where not g.hidden)),
    'countries', coalesce((pc ->> 'countries')::int, 0),
    'cities', coalesce((pc ->> 'cities')::int, 0),
    'firstYear', min(extract(year from date))::int,
    'lastYear', max(extract(year from date))::int,
    -- (played nights only, as shows, cities and countries are: a person's page counts the same way)
    'tours', (select count(distinct g.gk) from artist_history_shows h2 join tg g on g.tour = h2.tour
               where h2.artist_id = a_id and not g.hidden and h2.date <= current_date),
    'years', coalesce((select jsonb_object_agg(y, n) from (
       select extract(year from h3.date)::int as y, count(distinct (h3.date, lower(h3.venue))) as n
         from artist_history_shows h3
        where h3.artist_id = a_id and h3.date is not null and h3.date <= current_date
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
                where h8.artist_id = a_id and h8.tour = '' and h8.festival = '' and h8.date <= current_date
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
  return s;
end $$;
revoke all on function public.setlist_summarize(uuid) from public, anon, authenticated;

create or replace function public.road_stats(u uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  with cr0 as materialized (
    select s.artist_id, s.tour, to_char(s.d, 'YYYY-MM-DD') as d,
           lower(btrim(coalesce(s.venue, ''))) as venue,
           public.road_city_key(s.city) as city, upper(coalesce(s.country_code, '')) as ctry,
           case when upper(coalesce(s.country_code, '')) in ('US', 'CA') then public.road_region(s.state) else '' end as region
      from public.credited_shows(u) s
     where s.d is not null and s.d <= current_date
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
       and (e.v ->> 'date') <= to_char(current_date, 'YYYY-MM-DD')
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
           + (select count(*) from public.tours_of(u) t
               where (select count(*) from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
                       where (e.value ->> 'date') in (select c.d from cr c)) * 2
                     < greatest(1, (select count(*) from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
                                     where jsonb_typeof(e.value) = 'object' and (e.value ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
                                       and (e.value ->> 'date') <= to_char(current_date, 'YYYY-MM-DD')))),
    'shows', (select count(distinct (d, venue)) from nights),
    'cities', coalesce((select (j ->> 'cities')::int from pc), 0),
    'countries', coalesce((select (j ->> 'countries')::int from pc), 0),
    'firstYear', (select left(min(d), 4)::int from nights))
$$;
revoke all on function public.road_stats(uuid) from public, anon, authenticated;

create or replace function public.profile_card(u uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
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
    -- The artist profiles that list them as band or crew: the artist's own
    -- word for it. Then any artist that endorsed them and no longer lists
    -- them (they left, or the page is gone): the endorsement still stands.
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
         where m.user_id = u
        union all
        select jsonb_build_object('id', a.id, 'name', coalesce(a.name, nullif(e.artist_name, ''), 'An artist'),
                 'handle', coalesce(a.handle, e.artist_handle), 'avatar', coalesce(a.avatar, ''), 'kind', e.kind, 'role', coalesce(e.role, ''),
                 'endorsed', true, 'past', true, 'eid', case when u = auth.uid() then e.id end),
               e.created_at
          from artist_endorsements e left join artists a on a.id = e.artist_id
         where e.user_id = u and e.removed_at is null
           and not exists (select 1 from artist_members m where m.artist_id = e.artist_id and m.user_id = u)) x), '[]'::jsonb),
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
    -- What each artist has confirmed for them, artist by artist. A band member
    -- has every night of the band, so theirs is the artist page's own count,
    -- read from the same place that page reads it; a claim is only for crew.
    'credits', coalesce((
      select jsonb_agg(x.j) from (
        select jsonb_build_object('artistId', m.artist_id,
                 'tours', coalesce((h.summary ->> 'tours')::int, 0), 'shows', coalesce((h.summary ->> 'shows')::int, 0)) as j
          from artist_members m join artist_history h on h.artist_id = m.artist_id
         where m.user_id = u and m.kind = 'band'
        union all
        select jsonb_build_object('artistId', c.artist_id) || public.credit_counts(c.artist_id,
                 -- someone still listed with the artist: the claim's "until" day does not stop the count
                 case when exists (select 1 from artist_members m where m.artist_id = c.artist_id and m.user_id = c.user_id)
                      then c.approved - 'until' else c.approved end)
          from tour_credits c where c.user_id = u and c.approved is not null
           and not exists (select 1 from artist_members b where b.artist_id = c.artist_id and b.user_id = u and b.kind = 'band')) x), '[]'::jsonb),
    -- ...and those tours by name, for their Tours tab. A band member's list is
    -- the artist page's list, entry for entry (Devin: "any shows or tours or
    -- festivals ... added to the list on the artist page ... should update on
    -- the people listed under band"): its tours, its festivals, each year's
    -- shows outside a tour. Crew get the tours an artist confirmed for them.
    'creditTours', coalesce((
      with band as materialized (
        select m.artist_id, a.name as artist, h.summary -> 'toursList' as list
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
         where s.tour <> '' and not g.hidden and (s.d is null or s.d <= current_date)
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
end $$;
revoke all on function public.profile_card(uuid) from public, anon;
grant execute on function public.profile_card(uuid) to authenticated;

-- The daily re-read from setlist.fm (a page a minute, about half an hour for
-- I See Stars) writes setlist.fm's own labels and places back onto every night
-- it reads, and the settled state (a found tour's name on its nights, a one-off
-- festival not being a tour, nights settled by hand) only came back when the
-- last page was in. For that half hour a person's page, which counts the rows
-- as they are, moved about: this is the number that "changed a couple times".
-- Now each page is settled as it lands, inside the same step, so nobody ever
-- reads a half-read book. Only on a re-read (a first read has nothing settled
-- to go back to); and a settle that fails never loses the page.
create or replace function public.setlist_settle_page(a_id uuid)
returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not exists (select 1 from artist_history where artist_id = a_id and synced_at is not null) then return; end if;
  begin
    perform public.tour_find_apply(a_id);
    perform public.tour_fact_check(a_id);
  exception when others then
    null;
  end;
end $$;
revoke all on function public.setlist_settle_page(uuid) from public, anon, authenticated;

-- setlist_take_page, as 0077 left it, plus the settle at the end.
create or replace function public.setlist_take_page(a_id uuid, body jsonb)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int := 0; tot int; ipp int;
begin
  with rows as (
    insert into artist_history_shows (artist_id, id, date, venue, city, state, country_code, country, tour, url, updated)
    select a_id, s ->> 'id',
           case when s ->> 'eventDate' ~ '^\d{2}-\d{2}-\d{4}$' then to_date(s ->> 'eventDate', 'DD-MM-YYYY') end,
           left(coalesce(s -> 'venue' ->> 'name', ''), 120),
           left(coalesce(s -> 'venue' -> 'city' ->> 'name', ''), 80),
           left(coalesce(s -> 'venue' -> 'city' ->> 'state', ''), 80),
           left(coalesce(s -> 'venue' -> 'city' -> 'country' ->> 'code', ''), 8),
           left(coalesce(s -> 'venue' -> 'city' -> 'country' ->> 'name', ''), 80),
           left(coalesce(s -> 'tour' ->> 'name', ''), 120),
           case when coalesce(s ->> 'url', '') like 'https://www.setlist.fm/%' then left(s ->> 'url', 200) else '' end,
           nullif(s ->> 'lastUpdated', '')::timestamptz
      from jsonb_array_elements(coalesce(body -> 'setlist', '[]'::jsonb)) s
     where s ->> 'id' is not null
    on conflict (artist_id, id) do update
      set date = excluded.date, venue = excluded.venue, city = excluded.city,
          state = excluded.state, country_code = excluded.country_code,
          country = excluded.country,
          -- A name the finder put on a night stays unless setlist.fm has one of its own.
          tour = case when excluded.tour <> '' then excluded.tour else artist_history_shows.tour end,
          named_by = case when excluded.tour <> '' then null else artist_history_shows.named_by end,
          url = excluded.url, updated = excluded.updated, seen = now()
    returning 1)
  select coalesce(count(*), 0)::int into n from rows;
  tot := coalesce(nullif(body ->> 'total', '')::int, 0);
  ipp := greatest(coalesce(nullif(body ->> 'itemsPerPage', '')::int, 20), 1);
  update artist_history
     set total = tot,
         pages = ceil(tot::numeric / ipp)::int,
         mb_url = case when mb_url = ''
                        and coalesce(body -> 'setlist' -> 0 -> 'artist' ->> 'url', '') like 'https://www.setlist.fm/%'
                       then left(body -> 'setlist' -> 0 -> 'artist' ->> 'url', 200) else mb_url end
   where artist_id = a_id;
  perform public.setlist_settle_page(a_id);
  return n;
end $$;
revoke all on function public.setlist_take_page(uuid, jsonb) from public, anon, authenticated;

-- An artist page's numbers are kept as a count made at its last sync, and they
-- count "nights up to today". When the day changes, a night that was listed
-- ahead becomes a played night: a person's page (counted when it is opened)
-- would then be one show ahead of the artist page until the next sync. So a
-- few minutes after the date changes, every page with a night dated today is
-- counted again.
create or replace function public.setlist_recount_today()
returns int
language plpgsql volatile security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select ah.artist_id from artist_history ah
            where exists (select 1 from artist_history_shows s where s.artist_id = ah.artist_id and s.date = current_date)
  loop
    perform public.setlist_summarize(r.artist_id);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.setlist_recount_today() from public, anon, authenticated;

do $do$
begin
  perform cron.unschedule('greenroom-recount')
    where exists (select 1 from cron.job where jobname = 'greenroom-recount');
  perform cron.schedule('greenroom-recount', '7 0 * * *', 'select public.setlist_recount_today()');
end $do$;

-- Every artist page is counted again by the new rule, so no page waits for
-- its next sync to show it.
do $$
declare r record;
begin
  for r in select artist_id from artist_history where exists (select 1 from artist_history_shows s where s.artist_id = artist_history.artist_id)
  loop
    perform public.setlist_summarize(r.artist_id);
  end loop;
end $$;

notify pgrst, 'reload schema';
