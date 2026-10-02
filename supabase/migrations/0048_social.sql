-- MODEL6 SOCIAL, step two: looking at someone else's profile, and following.
--
-- The rule, in Devin's words: on your own profile your tours open as they
-- always have, at your level of access. Looking at someone ELSE's profile you
-- see the artists and the tours under them; tap a tour and you get its dates
-- and its flyer, and nothing else of it. So nothing here hands out a tour
-- row: every answer is built field by field, by functions that run on their
-- own authority, from an allowlist.
--
-- Who may look at a profile: you, and the people you tour with. One function
-- holds that rule (can_see_profile), so widening it later is one line.

-- 1. The profile card grows a bio, the roles you've held, and a small photo.
alter table public.profiles add column if not exists bio text not null default '';
alter table public.profiles add column if not exists roles text[] not null default '{}';
alter table public.profiles add column if not exists avatar text not null default '';
alter table public.profiles drop constraint if exists profiles_bio_len;
alter table public.profiles add constraint profiles_bio_len check (char_length(bio) <= 300);
alter table public.profiles drop constraint if exists profiles_roles_len;
alter table public.profiles add constraint profiles_roles_len
  check (coalesce(array_length(roles, 1), 0) <= 20 and char_length(array_to_string(roles, ',')) <= 400);
alter table public.profiles drop constraint if exists profiles_avatar_len;
alter table public.profiles add constraint profiles_avatar_len
  check (char_length(avatar) <= 120000 and (avatar = '' or avatar like 'data:image/%'));

create or replace function public.can_see_profile(u uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select u is not null and auth.uid() is not null and (u = auth.uid() or public.on_my_tours(u))
$$;
revoke all on function public.can_see_profile(uuid) from public, anon;
grant execute on function public.can_see_profile(uuid) to authenticated;

-- 2. Following. You can read the rows you're in (who you follow, who follows
-- you); other people's counts come from profile_card.
create table if not exists public.follows (
  follower_id uuid not null references auth.users (id) on delete cascade,
  followee_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  constraint follows_not_self check (follower_id <> followee_id)
);
create index if not exists follows_followee on public.follows (followee_id);
alter table public.follows enable row level security;
drop policy if exists follows_select on public.follows;
create policy follows_select on public.follows for select
  using (follower_id = auth.uid() or followee_id = auth.uid());
drop policy if exists follows_insert on public.follows;
create policy follows_insert on public.follows for insert
  with check (follower_id = auth.uid() and public.can_see_profile(followee_id));
-- Unfollow, or take a follower off your own list.
drop policy if exists follows_delete on public.follows;
create policy follows_delete on public.follows for delete
  using (follower_id = auth.uid() or followee_id = auth.uid());

-- 3. A tour's flyer, kept so it can be shown. Everyone on the tour can see
-- it; the tour manager and ALL ACCESS put it there.
create table if not exists public.tour_flyers (
  tour_id text primary key references public.tours (id) on delete cascade,
  image text not null,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint tour_flyers_image check (char_length(image) <= 700000 and image like 'data:image/%')
);
alter table public.tour_flyers enable row level security;
drop policy if exists tour_flyers_select on public.tour_flyers;
create policy tour_flyers_select on public.tour_flyers for select using (public.my_role(tour_id) is not null);
drop policy if exists tour_flyers_insert on public.tour_flyers;
create policy tour_flyers_insert on public.tour_flyers for insert with check (public.my_role(tour_id) in ('owner', 'editor'));
drop policy if exists tour_flyers_update on public.tour_flyers;
create policy tour_flyers_update on public.tour_flyers for update
  using (public.my_role(tour_id) in ('owner', 'editor')) with check (public.my_role(tour_id) in ('owner', 'editor'));
drop policy if exists tour_flyers_delete on public.tour_flyers;
create policy tour_flyers_delete on public.tour_flyers for delete using (public.my_role(tour_id) in ('owner', 'editor'));

-- 4. The tours a person has been on: ones they made or joined, not the Off
-- Tour book, not anything in the trash. Inside use only (it returns whole
-- rows), so nobody can call it.
create or replace function public.tours_of(u uuid)
returns setof public.tours
language sql stable security definer set search_path = public as $$
  select t.* from tours t
   where (t.owner_id = u or exists (select 1 from members m where m.tour_id = t.id and m.user_id = u))
     and coalesce(t.doc ->> 'kind', '') <> 'offtour'
     and (t.doc ->> 'deletedAt') is null
$$;
revoke all on function public.tours_of(uuid) from public, anon, authenticated;

-- The dates of a tour, as text: date, city, venue. Nothing else of a show.
create or replace function public.tour_dates(d jsonb)
returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('date', v ->> 'date', 'city', coalesce(v ->> 'city', ''),
           'venue', coalesce(v ->> 'venue', '')) order by v ->> 'date'), '[]'::jsonb)
    from jsonb_each(case when jsonb_typeof(d -> 'shows') = 'object' then d -> 'shows' else '{}'::jsonb end) s(k, v)
   where jsonb_typeof(v) = 'object' and (v ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
$$;
revoke all on function public.tour_dates(jsonb) from public, anon, authenticated;

-- 5. A profile, as anyone allowed to look at it sees it: name, photo, roles,
-- bio, the counts, and each tour as artist + name + first and last date.
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
    'bio', coalesce(p.bio, ''),
    'roles', to_jsonb(coalesce(p.roles, '{}'::text[])),
    'tourRole', coalesce(p.tour_role, ''),
    'avatar', coalesce(p.avatar, ''),
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
    -- Each artist's logo, from the account that runs their tours.
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

-- 6. A tour, seen from someone's profile: its name, its dates, its flyer.
create or replace function public.tour_card(t_id text, u uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t public.tours%rowtype;
begin
  if not public.can_see_profile(u) then return null; end if;
  select x.* into t from public.tours_of(u) x where x.id = t_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', t.id,
    'artist', trim(coalesce(t.doc ->> 'artist', '')),
    'name', trim(coalesce(t.doc ->> 'name', '')),
    'dates', public.tour_dates(t.doc),
    'flyer', coalesce((select f.image from tour_flyers f where f.tour_id = t.id), ''));
end $$;
revoke all on function public.tour_card(text, uuid) from public, anon;
grant execute on function public.tour_card(text, uuid) to authenticated;

-- 7. Who follows someone, or who they follow: name and photo, newest first,
-- and whether you may open each one's profile.
create or replace function public.follow_list(u uuid, which text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_see_profile(u) then return null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'userId', x.other,
        'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
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
