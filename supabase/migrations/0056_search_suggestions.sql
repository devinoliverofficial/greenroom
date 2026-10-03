-- Search, before you type anything: who you're most likely looking for.
-- Devin: "Get rid of all the random text... Instead underneath give a list
-- of most likely searches, crew members that you follow, artists that you
-- follow, etc." Recent stays on the phone; this hands back the people you
-- follow, the people you tour with, and the artists: your own pages, the
-- pages you're on, and the pages of the artists whose tours you're on.
-- Each is a search row: name, @username, photo, the check, and whether
-- their profile opens for you, the same shape find_people returns.

create or replace function public.person_row(u uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
      'userId', p.user_id,
      'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
      'handle', coalesce(p.handle, ''), 'avatar', coalesce(p.avatar, ''),
      'roles', to_jsonb(coalesce(p.roles, '{}'::text[])), 'tourRole', coalesce(p.tour_role, ''),
      'canOpen', public.can_see_profile(p.user_id),
      'iFollow', exists (select 1 from follows f where f.follower_id = auth.uid() and f.followee_id = p.user_id),
      'followers', (select count(*) from follows f where f.followee_id = p.user_id),
      'verified', exists (select 1 from verified_users v where v.user_id = p.user_id))
    from profiles p where p.user_id = u
$$;
revoke all on function public.person_row(uuid) from public, anon, authenticated;

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
      select jsonb_agg(jsonb_build_object('id', a.id, 'handle', a.handle, 'name', a.name, 'avatar', coalesce(a.avatar, ''))
             order by a.ord, lower(a.name))
        from (select x.*, case when x.owner_id = me then 0
                               when exists (select 1 from artist_members m where m.artist_id = x.id and m.user_id = me) then 1
                               else 2 end as ord
                from artists x
               where x.owner_id = me
                  or exists (select 1 from artist_members m where m.artist_id = x.id and m.user_id = me)
                  or exists (select 1 from public.tours_of(me) t
                              where t.owner_id = x.owner_id
                                and lower(trim(coalesce(t.doc ->> 'artist', ''))) = lower(trim(x.name)))
               order by ord, x.name limit 12) a), '[]'::jsonb));
end $$;
revoke all on function public.search_suggestions() from public, anon;
grant execute on function public.search_suggestions() to authenticated;

notify pgrst, 'reload schema';
