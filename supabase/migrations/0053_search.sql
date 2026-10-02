-- MODEL6 SOCIAL: search. One box that finds people, artist profiles and tours.
--
-- People: anyone by the start of their @username; the people you can already
-- see, by name too. Each says whether you may open their profile.
-- Artists: artist profiles, by name or the start of their username (they're
-- open to everyone signed in).
-- Tours: the tours on artist profiles, by tour name or artist name: name and
-- dates only, the same as the artist's own page shows.
create or replace function public.find_people(q text)
returns jsonb
language sql stable security definer set search_path = public as $$
  with term as (select replace(replace(lower(trim(both '@ ' from coalesce(q, ''))), '%', ''), '_', '\_') as t)
  select coalesce(jsonb_agg(jsonb_build_object(
      'userId', x.user_id, 'name', x.name, 'handle', coalesce(x.handle, ''), 'avatar', coalesce(x.avatar, ''),
      'roles', to_jsonb(coalesce(x.roles, '{}'::text[])), 'tourRole', coalesce(x.tour_role, ''),
      'canOpen', public.can_see_profile(x.user_id),
      'verified', exists (select 1 from verified_users v where v.user_id = x.user_id))
    order by x.rank, x.name), '[]'::jsonb)
  from (
    select p.user_id, p.handle, p.avatar, p.tour_role, p.roles,
           coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), '') as name,
           case when p.handle = term.t then 0 when p.handle like term.t || '%' then 1 else 2 end as rank
      from profiles p, term
     where auth.uid() is not null and char_length(term.t) >= 2
       and (p.handle like term.t || '%'
            or (public.can_see_profile(p.user_id) and lower(p.full_name) like '%' || term.t || '%'))
     order by rank, name limit 12
  ) x
$$;

create or replace function public.find_artists(q text)
returns jsonb
language sql stable security definer set search_path = public as $$
  with term as (select replace(replace(lower(trim(both '@ ' from coalesce(q, ''))), '%', ''), '_', '\_') as t)
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'handle', x.handle, 'avatar', x.avatar,
           'mine', x.owner_id = auth.uid()) order by x.rank, x.name), '[]'::jsonb)
  from (
    select a.*, case when a.handle = term.t or lower(a.name) = term.t then 0
                     when a.handle like term.t || '%' or lower(a.name) like term.t || '%' then 1 else 2 end as rank
      from artists a, term
     where auth.uid() is not null and char_length(term.t) >= 2
       and (a.handle like term.t || '%' or lower(a.name) like '%' || term.t || '%')
     order by rank, a.name limit 12
  ) x
$$;
revoke all on function public.find_artists(text) from public, anon;
grant execute on function public.find_artists(text) to authenticated;

create or replace function public.find_tours(q text)
returns jsonb
language sql stable security definer set search_path = public as $$
  with term as (select replace(replace(lower(trim(coalesce(q, ''))), '%', ''), '_', '\_') as t)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'artistId', x.artist_id, 'artist', x.artist, 'name', x.name,
      'first', (select min(d ->> 'date') from jsonb_array_elements(x.dates) d),
      'last', (select max(d ->> 'date') from jsonb_array_elements(x.dates) d),
      'shows', jsonb_array_length(x.dates),
      'mine', public.my_role(x.id) is not null)
    order by x.rank, x.name), '[]'::jsonb)
  from (
    select t.id, a.id as artist_id, a.name as artist, trim(coalesce(t.doc ->> 'name', '')) as name,
           public.tour_dates(t.doc) as dates,
           case when lower(trim(coalesce(t.doc ->> 'name', ''))) like term.t || '%' then 0 else 1 end as rank
      from artists a join tours t
        on t.owner_id = a.owner_id and lower(trim(coalesce(t.doc ->> 'artist', ''))) = lower(trim(a.name)), term
     where auth.uid() is not null and char_length(term.t) >= 2
       and coalesce(t.doc ->> 'kind', '') <> 'offtour' and (t.doc ->> 'deletedAt') is null
       and (lower(coalesce(t.doc ->> 'name', '')) like '%' || term.t || '%' or lower(a.name) like '%' || term.t || '%')
     order by rank, name limit 12
  ) x
$$;
revoke all on function public.find_tours(text) from public, anon;
grant execute on function public.find_tours(text) to authenticated;
