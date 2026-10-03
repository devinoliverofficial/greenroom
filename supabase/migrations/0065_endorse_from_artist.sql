-- An artist endorses everyone who works for it, the account that runs it
-- included. Devin: "when you're logged onto an artist page you should be able
-- to endorse people that work for you. For instance, if I am logged onto the
-- I See Stars greenroom account i should be able to endorse Devin Oliver under
-- the band tab on my account or the artist tab when viewing the devin oliver
-- account."

-- 1. The page's owner may be endorsed by the page too (still only someone it
-- lists as band or crew, and still only the owner does the endorsing).
drop policy if exists artist_endorsements_insert on public.artist_endorsements;
create policy artist_endorsements_insert on public.artist_endorsements for insert
  with check (artist_id is not null and public.runs_artist(artist_id) and endorsed_by = auth.uid()
    and exists (select 1 from artist_members m where m.artist_id = artist_endorsements.artist_id and m.user_id = artist_endorsements.user_id));

-- 2. Someone's page tells the account that runs an artist which of the
-- listed artists is theirs (to endorse from the Artists tab), and whether
-- this person removed that artist's endorsement before.
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
                 'handle', coalesce(a.handle, e.artist_handle), 'avatar', coalesce(a.avatar, ''), 'kind', e.kind,
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
