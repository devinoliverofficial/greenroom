-- Flowers say what they're for. Devin: "when you give someone their flowers
-- i think it should ask why you are giving them their flowers and it is one
-- of these 10 categories. Talent, Reliability, Trust, Hustle, Versatility,
-- Adaptability, Communication, Professionalism, Morale, & Cleanliness. This
-- way when you are on someones profile there should be a stats tab that you
-- should be able to see who sent flowers, what category, the date, and maybe
-- a quick 100 character message (optional)."

-- 1. The category, one of the ten. Flowers given before this have none.
alter table public.flowers add column if not exists category text;
alter table public.flowers drop constraint if exists flowers_category;
alter table public.flowers add constraint flowers_category check (category is null or category in ('talent', 'reliability', 'trust', 'hustle', 'versatility', 'adaptability', 'communication', 'professionalism', 'morale', 'cleanliness'));

-- 2. Giving takes the category; the note is up to 100 characters now (140 still
-- for an app that hasn't updated and sends no category). The
-- old five-argument version goes, so there's one give_flowers to call (an
-- app that hasn't updated yet still reaches this one, with no category).
drop function if exists public.give_flowers(text, uuid, int, text, uuid);
create or replace function public.give_flowers(t_id text, to_user uuid, how_many int, why text, rid uuid, cat text default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); have int; k int := coalesce(how_many, 1); c text := nullif(lower(trim(coalesce(cat, ''))), '');
begin
  if me is null or public.my_role(t_id) is null or not public.on_tour(t_id, me) then
    raise exception 'permission' using errcode = '42501';
  end if;
  if to_user is null or to_user = me or not public.on_tour(t_id, to_user) then
    raise exception 'not on this tour' using errcode = '22023';
  end if;
  if k < 1 or k > 10 then raise exception 'how many' using errcode = '22023'; end if;
  if c is not null and c not in ('talent', 'reliability', 'trust', 'hustle', 'versatility', 'adaptability', 'communication', 'professionalism', 'morale', 'cleanliness') then
    raise exception 'category' using errcode = '22023';
  end if;
  -- One giver at a time (the 10 span every tour), so two quick taps can't give 11.
  perform pg_advisory_xact_lock(hashtext('flowers:' || me::text));
  have := public.flowers_left(me);
  -- Already given (the same tap, arriving again): nothing more to do.
  if rid is not null and exists (select 1 from flowers f where f.id = rid) then
    return jsonb_build_object('left', have);
  end if;
  if k > have then raise exception 'no flowers left' using errcode = '22023'; end if;
  insert into flowers (id, tour_id, from_id, to_id, n, note, category)
  -- 100 characters with a category; an app that hasn't updated (no category) keeps its 140.
  values (coalesce(rid, gen_random_uuid()), t_id, me, to_user, k, left(trim(coalesce(why, '')), case when c is null then 140 else 100 end), c);
  return jsonb_build_object('left', have - k);
end $$;
revoke all on function public.give_flowers(text, uuid, int, text, uuid, text) from public, anon;
grant execute on function public.give_flowers(text, uuid, int, text, uuid, text) to authenticated;

-- 3. Crew Stats and your own Stats tab carry the category.
create or replace function public.tour_flowers(t_id text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null or public.my_role(t_id) is null then return null; end if;
  return jsonb_build_object(
    'left', public.flowers_left(me),
    'canGive', public.on_tour(t_id, me),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
          'userId', x.u,
          'owner', x.owner,
          'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''),
                           nullif(trim(x.display_name), ''), ''),
          'handle', coalesce(p.handle, ''),
          'avatar', coalesce(p.avatar, ''),
          'tourRole', coalesce(nullif(trim(x.role_fix), ''), nullif(trim(p.tour_role), ''), nullif(trim(x.tour_role), ''), ''),
          'verified', exists (select 1 from verified_users v where v.user_id = x.u),
          'here', (select coalesce(sum(f.n), 0) from flowers f where f.tour_id = t_id and f.to_id = x.u),
          'counts', public.flower_counts(x.u))
        order by (select coalesce(sum(f.n), 0) from flowers f where f.tour_id = t_id and f.to_id = x.u) desc,
                 x.owner desc, lower(coalesce(p.full_name, x.display_name, '')))
      from (
        select t.owner_id as u, true as owner, '' as display_name, '' as tour_role, '' as role_fix
          from tours t where t.id = t_id
        union
        select m.user_id, false, coalesce(m.display_name, ''), coalesce(m.tour_role, ''),
               coalesce(m.overrides ->> 'tourRole', '')
          from members m join tours t on t.id = m.tour_id
         where m.tour_id = t_id and m.user_id is not null and m.user_id <> t.owner_id
      ) x left join profiles p on p.user_id = x.u), '[]'::jsonb),
    'given', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', f.id, 'from', f.from_id, 'to', f.to_id, 'n', f.n, 'note', f.note, 'category', coalesce(f.category, ''),
          'at', f.created_at, 'mine', f.from_id = me, 'thisYear', f.created_at >= date_trunc('year', now(), 'UTC'),
          'fromName', case when public.can_see_profile(f.from_id) then public.person_name(f.from_id) else '' end,
          'toName', case when public.can_see_profile(f.to_id) then public.person_name(f.to_id) else '' end)
        order by f.created_at desc)
      from (select * from flowers where tour_id = t_id order by created_at desc limit 100) f), '[]'::jsonb));
end $$;
revoke all on function public.tour_flowers(text) from public, anon;
grant execute on function public.tour_flowers(text) to authenticated;

create or replace function public.my_flowers()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return null; end if;
  return jsonb_build_object(
    'counts', public.flower_counts(me),
    'left', public.flowers_left(me),
    'got', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', f.id, 'n', f.n, 'note', f.note, 'at', f.created_at, 'category', coalesce(f.category, ''),
          'from', f.from_id,
          -- Who gave it, while you can still see their profile.
          'name', case when public.can_see_profile(f.from_id)
                       then coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), '') else '' end,
          'avatar', case when public.can_see_profile(f.from_id) then coalesce(p.avatar, '') else '' end,
          'tourId', f.tour_id,
          'tour', trim(coalesce(t.doc ->> 'name', '')))
        order by f.created_at desc)
      from (select x.* from flowers x join tours y on y.id = x.tour_id
             where x.to_id = me and coalesce(y.doc ->> 'kind', '') <> 'offtour' and (y.doc ->> 'deletedAt') is null
             order by x.created_at desc limit 60) f
      left join profiles p on p.user_id = f.from_id
      left join tours t on t.id = f.tour_id), '[]'::jsonb));
end $$;
revoke all on function public.my_flowers() from public, anon;
grant execute on function public.my_flowers() to authenticated;

-- 4. Someone's page carries the flowers they've been given, for their Stats tab.
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
