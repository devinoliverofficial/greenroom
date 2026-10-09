-- The profile opens again (2026-10-09). After 0104 a person's page took the band's
-- tour groups to count tours the way the artist page does, and asked for them
-- once per show: 1,347 times for Devin. His profile call took 25 seconds, the
-- app's limit is 8, so "View profile" failed and his tours, shows, cities and
-- countries never arrived. The groups are worked out once per artist now.

-- A band member already has every night of the band: their own claim is not read again on top.
create or replace function public.credited_shows(u uuid)
returns table (artist_id uuid, show_id text, d date, city text, state text, country_code text, tkey text, tour text, venue text)
language sql stable security definer set search_path = public as $$
  select h.artist_id, h.id, h.date, h.city, h.state, h.country_code, h.tkey, h.tour, h.venue
    from artist_members m
    join artist_history_shows h on h.artist_id = m.artist_id
   where m.user_id = u and m.kind = 'band'
  union all
  select h.artist_id, h.id, h.date, h.city, h.state, h.country_code, h.tkey, h.tour, h.venue
    from tour_credits c
    join artist_history_shows h on h.artist_id = c.artist_id
   where c.user_id = u and c.approved is not null
     and not exists (select 1 from artist_members b where b.artist_id = c.artist_id and b.user_id = u and b.kind = 'band')
     and exists (select 1 from artist_endorsements e
                  where e.artist_id = c.artist_id and e.user_id = c.user_id and e.removed_at is null)
     and public.credit_covers(
           case when exists (select 1 from artist_members m where m.artist_id = c.artist_id and m.user_id = c.user_id)
                then c.approved - 'until' else c.approved end,
           h.id, h.date)
$$;
revoke all on function public.credited_shows(uuid) from public, anon, authenticated;

-- What one artist has confirmed for someone, counted the way that artist's page counts: folded
-- tours, one show per date and room, played nights only (it read 69 tours beside the page's 57).
create or replace function public.credit_counts(a_id uuid, claim jsonb)
returns jsonb
language sql stable security definer set search_path = public as $$
  with g as materialized (select * from public.artist_tour_groups(a_id)),
       n as (select h.date, h.venue, h.tour from artist_history_shows h
              where h.artist_id = a_id and claim is not null and h.date <= current_date
                and public.credit_covers(claim, h.id, h.date))
  select jsonb_build_object(
    'tours', (select count(distinct g.gk) from n join g on g.tour = n.tour where n.tour <> '' and not g.hidden),
    'shows', (select count(distinct (n.date, lower(n.venue))) from n))
$$;
revoke all on function public.credit_counts(uuid, jsonb) from public, anon, authenticated;

create or replace function public.road_stats(u uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  with gr as (
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
    select s.artist_id, s.tour, to_char(s.d, 'YYYY-MM-DD') as d,
           lower(btrim(coalesce(s.venue, ''))) as venue,
           public.road_city_key(s.city) as city, upper(s.country_code) as ctry,
           case when upper(s.country_code) in ('US', 'CA') then public.road_region(s.state) else '' end as region,
           exists (select 1 from gr g where g.d = to_char(s.d, 'YYYY-MM-DD')) as dup
      from public.credited_shows(u) s
     where s.d is not null and s.d <= current_date
  ), grp as materialized (
    -- each artist's tour groups, worked out once (not once per show)
    select a.artist_id, g.tour, g.gk, g.hidden
      from (select distinct c.artist_id from cr c) a
      cross join lateral public.artist_tour_groups(a.artist_id) g
  ), nights as (
    select d, venue, city, ctry, region from gr
    union all
    select d, venue, city, ctry, region from cr where not dup
  )
  select jsonb_build_object(
    -- the artist's tours, counted exactly as the artist page counts them, plus the person's own
    -- Greenroom tours that are not already in a band's book (half or more of a tour's dates there)
    'tours', (select count(*) from (
                select 1 from cr c join grp g on g.artist_id = c.artist_id and g.tour = c.tour
                 where c.tour <> '' and not g.hidden
                 group by c.artist_id, g.gk) x)
           + (select count(*) from public.tours_of(u) t
               where (select count(*) from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
                       where (e.value ->> 'date') in (select c.d from cr c)) * 2
                     < greatest(1, (select count(*) from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end)))),
    'shows', (select count(distinct (d, venue)) from nights),
    'cities', (select count(distinct (ctry, region, city)) from nights where city <> ''),
    'countries', (select count(distinct ctry) from nights where ctry ~ '^[A-Z]{2}$'),
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
      select jsonb_agg(jsonb_build_object('artistId', c.artist_id) || public.credit_counts(c.artist_id,
               -- someone still listed with the artist: the claim's "until" day does not stop the count
               case when exists (select 1 from artist_members m where m.artist_id = c.artist_id and m.user_id = c.user_id)
                    then c.approved - 'until' else c.approved end))
        from tour_credits c where c.user_id = u and c.approved is not null), '[]'::jsonb),
    -- ...and those tours by name, for their Tours tab.
    'creditTours', coalesce((
      with grp as materialized (
        -- each artist's tour groups, worked out once
        select ar.artist_id, gg.tour, gg.gk, gg.hidden, gg.shown
          from (select c.artist_id from tour_credits c where c.user_id = u and c.approved is not null
                union
                select m.artist_id from artist_members m where m.user_id = u) ar
          cross join lateral public.artist_tour_groups(ar.artist_id) gg),
      cs as materialized (select * from public.credited_shows(u))
      select jsonb_agg(jsonb_build_object('artistId', x.artist_id, 'artist', x.artist, 'key', x.tkey, 'name', x.nm,
               'n', x.n, 'first', x.d0, 'last', x.d1) order by x.d1 desc nulls last, x.tkey)
        from (
          select s.artist_id, a.name as artist, g.gk as tkey, coalesce(max(g.shown), mode() within group (order by s.tour)) as nm,
                 count(distinct (s.d, lower(s.venue))) as n, min(s.d) as d0, max(s.d) as d1
            from cs s join artists a on a.id = s.artist_id
            join grp g on g.artist_id = s.artist_id and g.tour = s.tour
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

notify pgrst, 'reload schema';
