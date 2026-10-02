-- MODEL6 SOCIAL: the green check by a username.
--
-- Who has one is a list only the database's owner can change: there are no
-- rules letting anyone read or write it through the app, so nobody can hand
-- themselves a check. Profiles report it (profile_card, follow_list).
-- First on the list: Devin, as Greenroom's creator. Artists vouching for
-- crew members (the checks by their roles) will be its own thing, later.
create table if not exists public.verified_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  kind text not null default 'creator',
  created_at timestamptz not null default now()
);
alter table public.verified_users enable row level security;
revoke all on table public.verified_users from anon, authenticated;

insert into public.verified_users (user_id, kind)
select id, 'creator' from auth.users where lower(email) = 'devinoliverofficial@gmail.com'
on conflict (user_id) do nothing;

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
        'verified', exists (select 1 from verified_users v where v.user_id = x.other),
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
