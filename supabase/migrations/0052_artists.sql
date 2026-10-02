-- MODEL6 SOCIAL: artist profiles.
--
-- An artist (a band, an act) gets a profile of its own, made and run by one
-- account. It has a username from the same pool as people's (one owner per
-- name, across both), a name, a photo and a bio, and two lists: its band
-- members and its crew, each a Greenroom account the owner picked by search.
-- Artist profiles are open to everyone signed in; the people on them are
-- shown by name, username and photo only. Being listed by an artist is the
-- artist's word that you're theirs, which is what a "verified" crew member
-- will mean.
create table if not exists public.artists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  handle text not null,
  name text not null,
  bio text not null default '',
  avatar text not null default '',
  created_at timestamptz not null default now(),
  constraint artists_handle_shape check (handle ~ '^[a-z0-9._]{3,24}$'
    and handle not in ('greenroom', 'admin', 'support', 'help', 'official', 'staff', 'ari', 'everyone', 'here')),
  constraint artists_name_len check (char_length(btrim(name)) between 1 and 60),
  constraint artists_bio_len check (char_length(bio) <= 300),
  constraint artists_avatar_len check (char_length(avatar) <= 120000 and (avatar = '' or avatar like 'data:image/%'))
);
create unique index if not exists artists_handle_key on public.artists (handle);
create index if not exists artists_owner on public.artists (owner_id);
alter table public.artists enable row level security;
drop policy if exists artists_select on public.artists;
create policy artists_select on public.artists for select using (auth.uid() is not null);
drop policy if exists artists_insert on public.artists;
create policy artists_insert on public.artists for insert with check (owner_id = auth.uid());
drop policy if exists artists_update on public.artists;
create policy artists_update on public.artists for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists artists_delete on public.artists;
create policy artists_delete on public.artists for delete using (owner_id = auth.uid());

create table if not exists public.artist_members (
  artist_id uuid not null references public.artists (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('band', 'crew')),
  added_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (artist_id, user_id)
);
create index if not exists artist_members_user on public.artist_members (user_id);
alter table public.artist_members enable row level security;

-- Does this account run this artist? On its own authority, so the rules
-- below don't have to read the artists table through each other.
create or replace function public.runs_artist(a_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from artists a where a.id = a_id and a.owner_id = auth.uid())
$$;
revoke all on function public.runs_artist(uuid) from public, anon;
grant execute on function public.runs_artist(uuid) to authenticated;

drop policy if exists artist_members_select on public.artist_members;
create policy artist_members_select on public.artist_members for select
  using (user_id = auth.uid() or public.runs_artist(artist_id));
drop policy if exists artist_members_insert on public.artist_members;
create policy artist_members_insert on public.artist_members for insert with check (public.runs_artist(artist_id));
drop policy if exists artist_members_update on public.artist_members;
create policy artist_members_update on public.artist_members for update
  using (public.runs_artist(artist_id)) with check (public.runs_artist(artist_id));
-- The artist takes you off, or you take yourself off.
drop policy if exists artist_members_delete on public.artist_members;
create policy artist_members_delete on public.artist_members for delete
  using (public.runs_artist(artist_id) or user_id = auth.uid());

-- One pool of usernames for people and artists: a name held in one table
-- can't be taken in the other.
create or replace function public.handle_one_pool()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'profiles' then
    if new.handle is not null and exists (select 1 from artists a where a.handle = new.handle) then
      raise exception 'username taken' using errcode = '23505';
    end if;
  elsif exists (select 1 from profiles p where p.handle = new.handle) then
    raise exception 'username taken' using errcode = '23505';
  end if;
  return new;
end $$;
drop trigger if exists handle_one_pool on public.profiles;
create trigger handle_one_pool before insert or update of handle on public.profiles
  for each row execute function public.handle_one_pool();
drop trigger if exists handle_one_pool on public.artists;
create trigger handle_one_pool before insert or update of handle on public.artists
  for each row execute function public.handle_one_pool();

-- "Can I have this one?" for a person, and for an artist (for_artist is the
-- artist being renamed, so its own current name still reads as free).
create or replace function public.handle_free(h text)
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and lower(trim(coalesce(h, ''))) ~ '^[a-z0-9._]{3,24}$'
     and lower(trim(h)) not in ('greenroom', 'admin', 'support', 'help', 'official', 'staff', 'ari', 'everyone', 'here')
     and not exists (select 1 from profiles p where p.handle = lower(trim(h)) and p.user_id <> auth.uid())
     and not exists (select 1 from artists a where a.handle = lower(trim(h)))
$$;
create or replace function public.artist_handle_free(h text, for_artist uuid default null)
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and lower(trim(coalesce(h, ''))) ~ '^[a-z0-9._]{3,24}$'
     and lower(trim(h)) not in ('greenroom', 'admin', 'support', 'help', 'official', 'staff', 'ari', 'everyone', 'here')
     and not exists (select 1 from profiles p where p.handle = lower(trim(h)))
     and not exists (select 1 from artists a where a.handle = lower(trim(h)) and (for_artist is null or a.id <> for_artist))
$$;
revoke all on function public.artist_handle_free(text, uuid) from public, anon;
grant execute on function public.artist_handle_free(text, uuid) to authenticated;

-- People who are on the same artist profile (as its owner, band or crew)
-- can open each other's profiles, the way tour-mates can.
create or replace function public.shares_artist(u uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  with mine as (
    select a.id from artists a where a.owner_id = auth.uid()
    union select m.artist_id from artist_members m where m.user_id = auth.uid()
  )
  select exists (select 1 from artists a where a.owner_id = u and a.id in (select id from mine))
      or exists (select 1 from artist_members m where m.user_id = u and m.artist_id in (select id from mine))
$$;
revoke all on function public.shares_artist(uuid) from public, anon;
grant execute on function public.shares_artist(uuid) to authenticated;

create or replace function public.can_see_profile(u uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select u is not null and auth.uid() is not null
     and (u = auth.uid() or public.on_my_tours(u) or public.shares_artist(u))
$$;

-- Finding an account to add: anyone by the start of their @username; the
-- people you can already see, by name too. Name, username and photo only.
create or replace function public.find_people(q text)
returns jsonb
language sql stable security definer set search_path = public as $$
  with term as (select lower(trim(both '@ ' from coalesce(q, ''))) as t)
  select coalesce(jsonb_agg(jsonb_build_object(
      'userId', x.user_id, 'name', x.name, 'handle', coalesce(x.handle, ''), 'avatar', coalesce(x.avatar, ''),
      'tourRole', coalesce(x.tour_role, ''),
      'verified', exists (select 1 from verified_users v where v.user_id = x.user_id))
    order by x.rank, x.name), '[]'::jsonb)
  from (
    select p.user_id, p.handle, p.avatar, p.tour_role,
           coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), '') as name,
           case when p.handle = term.t then 0 when p.handle like term.t || '%' then 1 else 2 end as rank
      from profiles p, term
     where auth.uid() is not null and char_length(term.t) >= 2
       and (p.handle like replace(replace(term.t, '%', ''), '_', '\_') || '%'
            or (public.can_see_profile(p.user_id)
                and (lower(p.full_name) like '%' || replace(replace(term.t, '%', ''), '_', '\_') || '%')))
     order by rank, name limit 12
  ) x
$$;
revoke all on function public.find_people(text) from public, anon;
grant execute on function public.find_people(text) to authenticated;

-- The artist profiles you run or are listed on, for the account switcher.
create or replace function public.my_artists()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'handle', a.handle, 'name', a.name, 'avatar', a.avatar,
           'mine', a.owner_id = auth.uid(),
           'kind', (select m.kind from artist_members m where m.artist_id = a.id and m.user_id = auth.uid()))
         order by (a.owner_id = auth.uid()) desc, a.created_at), '[]'::jsonb)
    from artists a
   where a.owner_id = auth.uid()
      or exists (select 1 from artist_members m where m.artist_id = a.id and m.user_id = auth.uid())
$$;
revoke all on function public.my_artists() from public, anon;
grant execute on function public.my_artists() to authenticated;

-- The tours an artist profile shows: its owner's tours filed under its name.
create or replace function public.artist_tours(a_id uuid)
returns setof public.tours
language sql stable security definer set search_path = public as $$
  select t.* from tours t join artists a on a.id = a_id
   where t.owner_id = a.owner_id
     and lower(trim(coalesce(t.doc ->> 'artist', ''))) = lower(trim(a.name))
     and coalesce(t.doc ->> 'kind', '') <> 'offtour'
     and (t.doc ->> 'deletedAt') is null
$$;
revoke all on function public.artist_tours(uuid) from public, anon, authenticated;

-- An artist profile, as anyone signed in sees it.
create or replace function public.artist_card(a_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a public.artists%rowtype;
begin
  if auth.uid() is null then return null; end if;
  select * into a from artists where id = a_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', a.id, 'handle', a.handle, 'name', a.name, 'bio', a.bio, 'avatar', a.avatar,
    'mine', a.owner_id = auth.uid(),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
          'userId', m.user_id, 'kind', m.kind,
          'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
          'handle', coalesce(p.handle, ''), 'avatar', coalesce(p.avatar, ''),
          'roles', to_jsonb(coalesce(p.roles, '{}'::text[])), 'tourRole', coalesce(p.tour_role, ''),
          'verified', exists (select 1 from verified_users v where v.user_id = m.user_id),
          'canOpen', public.can_see_profile(m.user_id))
        order by m.created_at)
      from artist_members m left join profiles p on p.user_id = m.user_id where m.artist_id = a.id), '[]'::jsonb),
    'tours', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', t.id, 'artist', a.name, 'name', trim(coalesce(t.doc ->> 'name', '')),
          'first', (select min(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x),
          'last', (select max(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x),
          'shows', jsonb_array_length(public.tour_dates(t.doc)),
          'mine', public.my_role(t.id) is not null)
        order by (select max(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x) desc nulls last, t.id)
      from public.artist_tours(a.id) t), '[]'::jsonb));
end $$;
revoke all on function public.artist_card(uuid) from public, anon;
grant execute on function public.artist_card(uuid) to authenticated;

-- A tour, seen from an artist's profile: its name, its dates, its flyer.
create or replace function public.artist_tour_card(a_id uuid, t_id text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t public.tours%rowtype; nm text;
begin
  if auth.uid() is null then return null; end if;
  select x.* into t from public.artist_tours(a_id) x where x.id = t_id;
  if not found then return null; end if;
  select name into nm from artists where id = a_id;
  return jsonb_build_object('id', t.id, 'artist', nm, 'name', trim(coalesce(t.doc ->> 'name', '')),
    'dates', public.tour_dates(t.doc),
    'flyer', coalesce((select f.image from tour_flyers f where f.tour_id = t.id), ''));
end $$;
revoke all on function public.artist_tour_card(uuid, text) from public, anon;
grant execute on function public.artist_tour_card(uuid, text) to authenticated;

-- Profiles now also say which artist profiles list the person.
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
    -- The artist profiles that list them as band or crew: the artist's own word for it.
    'acts', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'handle', a.handle, 'avatar', a.avatar, 'kind', m.kind)
               order by m.created_at)
        from artist_members m join artists a on a.id = m.artist_id where m.user_id = u), '[]'::jsonb),
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

