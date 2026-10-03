-- Following artist pages. Devin: "there isn't an option to follow artists
-- pages which there should be." Anyone signed in can follow any artist page
-- (artist pages are open to everyone signed in). You see your own follows;
-- everyone sees an artist's follower count on its page.
create table if not exists public.artist_follows (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  artist_id uuid not null references public.artists (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, artist_id)
);
create index if not exists artist_follows_artist on public.artist_follows (artist_id);
alter table public.artist_follows enable row level security;
drop policy if exists artist_follows_select on public.artist_follows;
create policy artist_follows_select on public.artist_follows for select using (user_id = auth.uid());
drop policy if exists artist_follows_insert on public.artist_follows;
create policy artist_follows_insert on public.artist_follows for insert with check (user_id = auth.uid());
drop policy if exists artist_follows_delete on public.artist_follows;
create policy artist_follows_delete on public.artist_follows for delete using (user_id = auth.uid());

-- An artist's page carries its follower count, and whether you follow it.
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

-- Search before you type: the artists you follow come first under Artists.
create or replace function public.search_suggestions()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return null; end if;
  return jsonb_build_object(
    -- The people you follow, newest first.
    'following', coalesce((
      select jsonb_agg(public.person_row(f.followee_id) order by f.created_at desc)
        from (select x.* from follows x
               where x.follower_id = me and exists (select 1 from profiles p where p.user_id = x.followee_id)
               order by x.created_at desc limit 20) f), '[]'::jsonb),
    -- The people on your tours you don't follow yet, latest tour first.
    'crew', coalesce((
      select jsonb_agg(public.person_row(c.u) order by c.at desc)
        from (select y.u, max(y.at) as at
                from (select t.owner_id as u, t.updated_at as at from public.tours_of(me) t
                      union all
                      select m.user_id, t.updated_at from public.tours_of(me) t
                        join members m on m.tour_id = t.id
                       where m.user_id is not null) y
               where y.u <> me
                 and not exists (select 1 from follows f where f.follower_id = me and f.followee_id = y.u)
                 and exists (select 1 from profiles p where p.user_id = y.u)
               group by y.u
               order by max(y.at) desc
               limit 20) c), '[]'::jsonb),
    -- Artist pages: yours, the ones you're on, the ones whose tours you're on.
    'artists', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'handle', a.handle, 'name', a.name, 'avatar', coalesce(a.avatar, ''), 'iFollow', a.ord = -1)
             order by a.ord, lower(a.name))
        from (select x.*, case when exists (select 1 from artist_follows f where f.artist_id = x.id and f.user_id = me) then -1
                               when x.owner_id = me then 0
                               when exists (select 1 from artist_members m where m.artist_id = x.id and m.user_id = me) then 1
                               else 2 end as ord
                from artists x
               where exists (select 1 from artist_follows f where f.artist_id = x.id and f.user_id = me)
                  or x.owner_id = me
                  or exists (select 1 from artist_members m where m.artist_id = x.id and m.user_id = me)
                  or exists (select 1 from public.tours_of(me) t
                              where t.owner_id = x.owner_id
                                and lower(trim(coalesce(t.doc ->> 'artist', ''))) = lower(trim(x.name)))
               order by ord, x.name limit 16) a), '[]'::jsonb));
end $$;
revoke all on function public.search_suggestions() from public, anon;
grant execute on function public.search_suggestions() to authenticated;

notify pgrst, 'reload schema';
