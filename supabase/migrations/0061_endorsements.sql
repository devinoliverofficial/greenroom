-- Endorsements. Devin: "when you are signed onto an artist's page and you
-- are looking at your crew and band there should be that little trophy that
-- says endorse. Once a band does this they can not take it back. It means
-- this person in fact worked for your band." The trophy count on someone's
-- page (and in Crew Stats) is how many artists endorsed them. And "someone's
-- stats and endorsements should show up on their page for everyone to see."

-- 1. One endorsement per artist per person. The artist's page (its owner)
-- endorses someone it lists as band or crew, never itself; no edits and no
-- taking it back. It outlives the listing: taking someone off the band, them
-- leaving, even deleting the artist's page doesn't undo it (the page's name
-- is kept with it for that). The one person who can remove it is the one it
-- was given to, as with flowers, so a stranger's page can't pin one on them;
-- a removed one is kept, hidden (removed_at), so that page can't give it again.
create table if not exists public.artist_endorsements (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid references public.artists (id) on delete set null,
  user_id uuid not null references auth.users (id) on delete cascade,
  endorsed_by uuid default auth.uid() references auth.users (id) on delete set null,
  -- Filled in from the artist's page when it's given (see below), never by the app.
  artist_name text not null default '',
  artist_handle text not null default '',
  kind text not null default 'crew' check (kind in ('band', 'crew')),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (artist_id, user_id)
);
create index if not exists artist_endorsements_user on public.artist_endorsements (user_id);
alter table public.artist_endorsements enable row level security;
-- The person and the artist that gave it can read it; everyone else sees it
-- through their page (profile_card, artist_card below).
drop policy if exists artist_endorsements_select on public.artist_endorsements;
create policy artist_endorsements_select on public.artist_endorsements for select
  using (user_id = auth.uid() or public.runs_artist(artist_id));
drop policy if exists artist_endorsements_insert on public.artist_endorsements;
create policy artist_endorsements_insert on public.artist_endorsements for insert
  with check (artist_id is not null and public.runs_artist(artist_id) and endorsed_by = auth.uid() and user_id <> auth.uid()
    and exists (select 1 from artist_members m where m.artist_id = artist_endorsements.artist_id and m.user_id = artist_endorsements.user_id));
-- No update or delete for anyone: removing goes through remove_endorsement below.
drop policy if exists artist_endorsements_delete on public.artist_endorsements;

-- The person it was given to takes it off their page. It stays hidden for
-- good, so the same artist page can't put it back.
create or replace function public.remove_endorsement(e_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update artist_endorsements set removed_at = now()
   where id = e_id and user_id = auth.uid() and removed_at is null;
  return found;
end $$;
revoke all on function public.remove_endorsement(uuid) from public, anon;
grant execute on function public.remove_endorsement(uuid) to authenticated;

-- The page's name, username and whether they were band or crew, kept with
-- it at the moment it's given, whatever the app sent.
create or replace function public.endorsement_fill()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select a.name, a.handle into new.artist_name, new.artist_handle from artists a where a.id = new.artist_id;
  select m.kind into new.kind from artist_members m where m.artist_id = new.artist_id and m.user_id = new.user_id;
  new.artist_name := coalesce(new.artist_name, '');
  new.artist_handle := coalesce(new.artist_handle, '');
  new.kind := coalesce(new.kind, 'crew');
  new.created_at := now();
  new.removed_at := null;
  return new;
end $$;
revoke all on function public.endorsement_fill() from public, anon, authenticated;
drop trigger if exists endorsement_fill on public.artist_endorsements;
create trigger endorsement_fill before insert on public.artist_endorsements
  for each row execute function public.endorsement_fill();

-- 2. The trophy counts endorsements.
create or replace function public.flower_counts(u uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    -- Only real tours count: not one in the trash, not a band's Off Tour book.
    'flowers', (select coalesce(sum(f.n), 0) from flowers f join tours t on t.id = f.tour_id
                 where f.to_id = u and coalesce(t.doc ->> 'kind', '') <> 'offtour' and (t.doc ->> 'deletedAt') is null),
    -- The artists who endorsed them: their word that this person really worked for them.
    'endorsements', (select count(*) from artist_endorsements e where e.user_id = u and e.removed_at is null),
    'tours', (select count(*) from public.tours_of(u)))
$$;
revoke all on function public.flower_counts(uuid) from public, anon, authenticated;

-- 3. Someone's page shows their flowers and endorsements; an artist's page
-- shows who it has endorsed.
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
        select jsonb_build_object('id', a.id, 'name', a.name, 'handle', a.handle, 'avatar', a.avatar, 'kind', m.kind,
                 'endorsed', e.id is not null,
                 -- Yours to remove, so your own page gets which one it is.
                 'eid', case when u = auth.uid() then e.id end) as j,
               m.created_at as at
          from artist_members m join artists a on a.id = m.artist_id
          left join artist_endorsements e on e.artist_id = a.id and e.user_id = u and e.removed_at is null
         where m.user_id = u
        union all
        select jsonb_build_object('id', a.id, 'name', coalesce(a.name, nullif(e.artist_name, ''), 'An artist'),
                 'handle', coalesce(a.handle, e.artist_handle), 'avatar', coalesce(a.avatar, ''), 'kind', e.kind,
                 'endorsed', true, 'past', true, 'eid', case when u = auth.uid() then e.id end),
               e.created_at
          from artist_endorsements e left join artists a on a.id = e.artist_id
         where e.user_id = u and e.removed_at is null
           and not exists (select 1 from artist_members m where m.artist_id = e.artist_id and m.user_id = u)) x), '[]'::jsonb),
    -- Their flowers and the artists who endorsed them, for anyone who can see their page.
    'flowers', (public.flower_counts(u) ->> 'flowers')::int,
    'endorsements', (public.flower_counts(u) ->> 'endorsements')::int,
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
    'followers', (select count(*) from artist_follows f where f.artist_id = a.id),
    'iFollow', exists (select 1 from artist_follows f where f.artist_id = a.id and f.user_id = auth.uid()),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
          'userId', m.user_id, 'kind', m.kind,
          'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
          'handle', coalesce(p.handle, ''), 'avatar', coalesce(p.avatar, ''),
          'roles', to_jsonb(coalesce(p.roles, '{}'::text[])), 'tourRole', coalesce(p.tour_role, ''),
          'verified', exists (select 1 from verified_users v where v.user_id = m.user_id),
          'canOpen', public.can_see_profile(m.user_id),
          'endorsed', exists (select 1 from artist_endorsements e where e.artist_id = a.id and e.user_id = m.user_id and e.removed_at is null),
          -- They took this page's endorsement off theirs: its owner gets no Endorse button for them again.
          'declined', a.owner_id = auth.uid()
            and exists (select 1 from artist_endorsements e where e.artist_id = a.id and e.user_id = m.user_id and e.removed_at is not null))
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

notify pgrst, 'reload schema';
