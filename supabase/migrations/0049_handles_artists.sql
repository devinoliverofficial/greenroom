-- MODEL6 SOCIAL: a username of your own, and the artists you've toured with.
--
-- @username: 3 to 24 of a-z, 0-9, dot and underscore, kept lowercase, one
-- owner each. handle_free answers "can I have this one?" while you type; the
-- unique index is what actually holds the line.
-- Artists: the ones you say you've toured with, alongside the ones your
-- Greenroom tours already show. Self-declared for now; an artist vouching
-- for a crew member (the green check by their roles) comes later.
alter table public.profiles add column if not exists handle text;
alter table public.profiles add column if not exists artists text[] not null default '{}';
alter table public.profiles drop constraint if exists profiles_handle_shape;
alter table public.profiles add constraint profiles_handle_shape check (
  handle is null or (handle ~ '^[a-z0-9._]{3,24}$'
    and handle not in ('greenroom', 'admin', 'support', 'help', 'official', 'staff', 'ari', 'everyone', 'here')));
create unique index if not exists profiles_handle_key on public.profiles (handle) where handle is not null;
alter table public.profiles drop constraint if exists profiles_artists_len;
alter table public.profiles add constraint profiles_artists_len
  check (coalesce(array_length(artists, 1), 0) <= 40 and char_length(array_to_string(artists, ',')) <= 2400);

create or replace function public.handle_free(h text)
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and lower(trim(coalesce(h, ''))) ~ '^[a-z0-9._]{3,24}$'
     and lower(trim(h)) not in ('greenroom', 'admin', 'support', 'help', 'official', 'staff', 'ari', 'everyone', 'here')
     and not exists (select 1 from profiles p where p.handle = lower(trim(h)) and p.user_id <> auth.uid())
$$;
revoke all on function public.handle_free(text) from public, anon;
grant execute on function public.handle_free(text) to authenticated;

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
    'bio', coalesce(p.bio, ''),
    'roles', to_jsonb(coalesce(p.roles, '{}'::text[])),
    'tourRole', coalesce(p.tour_role, ''),
    'avatar', coalesce(p.avatar, ''),
    'artists', to_jsonb(coalesce(p.artists, '{}'::text[])),
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

create or replace function public.follow_list(u uuid, which text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_see_profile(u) then return null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'userId', x.other,
        'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
        'handle', coalesce(p.handle, ''),
        'avatar', coalesce(p.avatar, ''),
        'roles', to_jsonb(coalesce(p.roles, '{}'::text[])),
        'tourRole', coalesce(p.tour_role, ''),
        'canOpen', public.can_see_profile(x.other),
        'iFollow', exists (select 1 from follows g where g.follower_id = auth.uid() and g.followee_id = x.other))
      order by x.created_at desc)
    from (
      select case when which = 'following' then f.followee_id else f.follower_id end as other, f.created_at
        from follows f
       where case when which = 'following' then f.follower_id = u else f.followee_id = u end
       order by f.created_at desc limit 300
    ) x left join profiles p on p.user_id = x.other), '[]'::jsonb);
end $$;
revoke all on function public.follow_list(uuid, text) from public, anon;
grant execute on function public.follow_list(uuid, text) to authenticated;
