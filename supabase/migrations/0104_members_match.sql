-- A band's numbers are its members' numbers (Devin, 2026-10-09: "When the I See
-- Stars information changes it should also change any band member that is in
-- the band and any crew members that is with the band. Right now my Devin
-- Oliver tour / shows / countries / cities doesn't match I See Stars").
-- What was wrong: a person's nights came only from a claim the artist approved,
-- and the claim was frozen at the day it was sent ("until"), so every show
-- after that day never counted; a person's tours were counted by the raw
-- setlist.fm label (81) where the page counts folded tours (70); the page
-- counted a night that hasn't happened yet and keyed cities by the raw state
-- text ("Michigan" and "MI" twice) where a person's page keys them by code.
-- Now: someone listed on the artist page as a band member has every night of
-- the band, live, with no claim to send; someone listed as crew keeps the tours
-- the band confirmed for them, with the "until" day ignored while they are
-- still with the band; tours, shows and cities are counted the same way on
-- both pages, and only nights already played count on either.

-- The nights an artist stands behind for someone (the venue rides along now, so the return type changes).
drop function if exists public.credited_shows(uuid);
create function public.credited_shows(u uuid)
returns table (artist_id uuid, show_id text, d date, city text, state text, country_code text, tkey text, tour text, venue text)
language sql stable security definer set search_path = public as $$
  -- a band member: the whole book, no claim needed
  select h.artist_id, h.id, h.date, h.city, h.state, h.country_code, h.tkey, h.tour, h.venue
    from artist_members m
    join artist_history_shows h on h.artist_id = m.artist_id
   where m.user_id = u and m.kind = 'band'
  union
  -- anyone else: what the artist confirmed, while the artist's word still stands;
  -- the claim's "until" day is ignored while the person is listed as the band's crew
  select h.artist_id, h.id, h.date, h.city, h.state, h.country_code, h.tkey, h.tour, h.venue
    from tour_credits c
    join artist_history_shows h on h.artist_id = c.artist_id
   where c.user_id = u and c.approved is not null
     and exists (select 1 from artist_endorsements e
                  where e.artist_id = c.artist_id and e.user_id = c.user_id and e.removed_at is null)
     and public.credit_covers(
           case when exists (select 1 from artist_members m where m.artist_id = c.artist_id and m.user_id = c.user_id)
                then c.approved - 'until' else c.approved end,
           h.id, h.date)
$$;
revoke all on function public.credited_shows(uuid) from public, anon, authenticated;

-- One person's road story, counted the way the artist page counts.
create or replace function public.road_stats(u uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  with gr as (
    select (e.v ->> 'date') as d,
           lower(btrim(coalesce(e.v ->> 'venue', ''))) as venue,
           lower(btrim(split_part(coalesce(e.v ->> 'city', ''), ',', 1))) as city,
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
    select s.artist_id, s.tour, to_char(s.d, 'YYYY-MM-DD') as d,
           lower(btrim(coalesce(s.venue, ''))) as venue,
           lower(btrim(s.city)) as city, upper(s.country_code) as ctry,
           case when upper(s.country_code) in ('US', 'CA') then public.region_code(s.state) else '' end as region,
           exists (select 1 from gr g where g.d = to_char(s.d, 'YYYY-MM-DD')) as dup
      from public.credited_shows(u) s
     where s.d is not null and s.d <= current_date
  ), nights as (
    select d, venue, city, ctry, region from gr
    union all
    select d, venue, city, ctry, region from cr where not dup
  )
  select jsonb_build_object(
    -- the artist's tours, counted exactly as the artist page counts them, plus the person's own
    -- Greenroom tours that are not already in a band's book (half or more of a tour's dates there)
    'tours', (select count(*) from (
                select 1 from cr c join lateral public.artist_tour_groups(c.artist_id) g on g.tour = c.tour
                 where c.tour <> '' and not g.hidden
                 group by c.artist_id, g.gk) x)
           + (select count(*) from public.tours_of(u) t
               where (select count(*) from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
                       where (e.value ->> 'date') in (select c.d from cr c)) * 2
                     < greatest(1, (select count(*) from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end)))),
    'shows', (select count(distinct (d, venue)) from nights),
    'cities', (select count(distinct (ctry, region, city)) from nights where city <> ''),
    'countries', (select count(distinct ctry) from nights where ctry <> ''),
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
    -- What each artist has confirmed for them, artist by artist...
    'credits', coalesce((
      select jsonb_agg(jsonb_build_object('artistId', c.artist_id) || public.credit_counts(c.artist_id, c.approved))
        from tour_credits c where c.user_id = u and c.approved is not null), '[]'::jsonb),
    -- ...and those tours by name, for their Tours tab.
    'creditTours', coalesce((
      select jsonb_agg(jsonb_build_object('artistId', x.artist_id, 'artist', x.artist, 'key', x.tkey, 'name', x.nm,
               'n', x.n, 'first', x.d0, 'last', x.d1) order by x.d1 desc nulls last, x.tkey)
        from (
          select s.artist_id, a.name as artist, g.gk as tkey, coalesce(max(g.shown), mode() within group (order by s.tour)) as nm,
                 count(distinct (s.d, lower(s.venue))) as n, min(s.d) as d0, max(s.d) as d1
            from public.credited_shows(u) s join artists a on a.id = s.artist_id
            join lateral public.artist_tour_groups(s.artist_id) g on g.tour = s.tour
           where s.tour <> '' and not g.hidden and (s.d is null or s.d <= current_date)
           group by s.artist_id, a.name, g.gk
           order by max(s.d) desc nulls last
           limit 200) x), '[]'::jsonb),
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

create or replace function public.setlist_summarize(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s jsonb;
begin
  create temp table if not exists tg (tour text, gk text, hidden boolean, shown text) on commit drop;
  truncate tg;
  insert into tg select * from public.artist_tour_groups(a_id);
  select jsonb_build_object(
    'shows', count(distinct (h.date, lower(h.venue))) filter (where h.date <= current_date),
    'festivals', (select count(distinct h6.festival) from artist_history_shows h6 where h6.artist_id = a_id and h6.festival <> ''),
    'countries', count(distinct country_code) filter (where country_code <> '' and h.date <= current_date),
    'cities', count(distinct (country_code, case when country_code in ('US', 'CA') then public.region_code(state) else '' end, lower(city))) filter (where city <> '' and h.date <= current_date),
    'firstYear', min(extract(year from date))::int,
    'lastYear', max(extract(year from date))::int,
    'tours', (select count(distinct g.gk) from artist_history_shows h2 join tg g on g.tour = h2.tour
               where h2.artist_id = a_id and not g.hidden),
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
         'kind', case when t.gk in (select public.artist_tour_gkey(a_id, f.festival) from artist_history_shows f where f.artist_id = a_id and f.festival <> '') then 'festival' else 'tour' end)
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
                group by h7.festival) f), '[]'::jsonb),
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

notify pgrst, 'reload schema';
