-- Green checks on artist pages (Devin, 2026-10-08): "when an artist page is
-- made automatically by a search it should automatically receive a green
-- check mark. When it has actually been 'claimed' there should be a discrete
-- text next to the artist check mark that says 'claimed'."
--
-- checkmark: the page is a real act — born from the encyclopedia (MusicBrainz
--            confirmed it), or marked verified by hand.
-- claimed:   the act's own people run it (claimed and approved, or Devin's own).
-- The payloads that carry an artist to the app say both.

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
    'mine', coalesce(a.owner_id = auth.uid(), false),
    -- Nobody runs it yet: what the encyclopedia says about the act, and
    -- where the caller's own claim on it stands.
    'unclaimed', a.owner_id is null, 'verified', a.verified, 'about', a.about, 'country', a.country,
    'checkmark', (coalesce(a.mbid, '') <> '' and a.checked) or a.verified,
    'claimed', a.owner_id is not null and a.verified,
    'myClaim', (select c.status from artist_claims c where c.artist_id = a.id and c.user_id = auth.uid()),
    'followers', (select count(*) from artist_follows f where f.artist_id = a.id),
    'iFollow', exists (select 1 from artist_follows f where f.artist_id = a.id and f.user_id = auth.uid()),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
          'userId', m.user_id, 'kind', m.kind, 'role', coalesce(m.role, ''),
          'hasCredits', coalesce(a.owner_id = auth.uid(), false) and exists (select 1 from tour_credits tc
             where tc.artist_id = a.id and tc.user_id = m.user_id and tc.approved is not null),
          'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
          'handle', coalesce(p.handle, ''), 'avatar', coalesce(p.avatar, ''),
          'roles', to_jsonb(coalesce(p.roles, '{}'::text[])), 'tourRole', coalesce(p.tour_role, ''),
          'verified', exists (select 1 from verified_users v where v.user_id = m.user_id),
          'canOpen', public.can_see_profile(m.user_id),
          'endorsed', exists (select 1 from artist_endorsements e where e.artist_id = a.id and e.user_id = m.user_id and e.removed_at is null),
          -- They took this page's endorsement off theirs: its owner gets no Endorse button for them again.
          'declined', coalesce(a.owner_id = auth.uid(), false)
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

create or replace function public.find_artists(q text)
returns jsonb
language sql stable security definer set search_path = public as $$
  with term as (select replace(replace(lower(trim(both '@ ' from coalesce(q, ''))), '%', ''), '_', '\_') as t)
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'handle', x.handle, 'avatar', x.avatar,
           'mine', coalesce(x.owner_id = auth.uid(), false), 'unclaimed', x.owner_id is null,
           'checkmark', (coalesce(x.mbid, '') <> '' and x.checked) or x.verified, 'claimed', x.owner_id is not null and x.verified,
           'mbid', x.mbid, 'about', x.about) order by x.rank, x.name), '[]'::jsonb)
  from (
    select a.*, case when a.handle = term.t or lower(a.name) = term.t then 0
                     when a.handle like term.t || '%' or lower(a.name) like term.t || '%' then 1 else 2 end as rank
      from artists a, term
     where auth.uid() is not null and char_length(term.t) >= 2
       -- a page just made from a tap stays out until MusicBrainz confirms it
       and a.checked
       and (a.handle like term.t || '%' or lower(a.name) like '%' || term.t || '%')
     order by rank, a.name limit 12
  ) x
$$;
revoke all on function public.find_artists(text) from public, anon;
grant execute on function public.find_artists(text) to authenticated;

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
      select jsonb_agg(jsonb_build_object('id', a.id, 'handle', a.handle, 'name', a.name, 'avatar', coalesce(a.avatar, ''),
               'iFollow', a.ord = -1, 'unclaimed', a.owner_id is null, 'about', a.about,
               'checkmark', (coalesce(a.mbid, '') <> '' and a.checked) or a.verified, 'claimed', a.owner_id is not null and a.verified)
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

create or replace function public.my_artists()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'handle', a.handle, 'name', a.name, 'avatar', a.avatar,
           'mine', coalesce(a.owner_id = auth.uid(), false),
           'checkmark', (coalesce(a.mbid, '') <> '' and a.checked) or a.verified, 'claimed', a.owner_id is not null and a.verified,
           'kind', (select m.kind from artist_members m where m.artist_id = a.id and m.user_id = auth.uid()))
         order by coalesce(a.owner_id = auth.uid(), false) desc, a.created_at), '[]'::jsonb)
    from artists a
   where a.owner_id = auth.uid()
      or exists (select 1 from artist_members m where m.artist_id = a.id and m.user_id = auth.uid())
$$;
revoke all on function public.my_artists() from public, anon;
grant execute on function public.my_artists() to authenticated;

notify pgrst, 'reload schema';
