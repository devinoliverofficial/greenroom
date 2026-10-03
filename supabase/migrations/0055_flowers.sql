-- MODEL7: Crew Stats becomes Flowers.
--
-- Devin: "each person when they sign on gets 10 flowers that they can hand
-- out... giving someone their flowers, like credit where credit is due.
-- Keep this thing positive: instead of reviewing a crew member you're simply
-- giving someone their flowers." So: everyone on a tour has 10 flowers for
-- that tour, to give to anyone else on it, a few at a time, with a line on
-- what for if they like. Flowers add up across tours on a person's profile.
-- The trophy beside them counts the artists who list the person as their
-- crew on the artist's Greenroom page (artist_members, kind 'crew').
--
-- The old Crew Stats (beers, joints, check-ins, bus cleans, late to
-- soundcheck, laminates, the game ball) leave the app. Their rows stay
-- where they are; nothing is deleted. The game ball's rounds are opened by
-- the Ari timer, which pushes "vote in Crew Stats" to the whole crew; with
-- the vote gone from the app, new rounds are refused here (Ari skips a round
-- it couldn't open, and sends nothing).

-- 0. Only Greenroom links an invite to an account (claim_invites when the
-- person signs in, link_invite when they already have one). A phone's own
-- write to members can't pin someone onto a tour, which would let anyone
-- shower a stranger with flowers from tours they made up.
create or replace function public.members_user_locked()
returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then new.user_id := null;
    else new.user_id := old.user_id;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists members_user_locked on public.members;
create trigger members_user_locked before insert or update on public.members
  for each row execute function public.members_user_locked();

-- 1. Who is on a tour: the account that made it, and everyone who joined.
create or replace function public.on_tour(t_id text, u uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select u is not null and (
    exists (select 1 from tours t where t.id = t_id and t.owner_id = u)
    or exists (select 1 from members m where m.tour_id = t_id and m.user_id = u))
$$;
revoke all on function public.on_tour(text, uuid) from public, anon, authenticated;

-- 2. The flowers. One row per handful given: who, to whom, how many, what for.
create table if not exists public.flowers (
  id uuid primary key default gen_random_uuid(),
  tour_id text not null references public.tours (id) on delete cascade,
  from_id uuid not null references auth.users (id) on delete cascade,
  to_id uuid not null references auth.users (id) on delete cascade,
  n smallint not null default 1,
  note text not null default '',
  created_at timestamptz not null default now(),
  constraint flowers_not_self check (from_id <> to_id),
  constraint flowers_n check (n between 1 and 10),
  constraint flowers_note_len check (char_length(note) <= 140)
);
create index if not exists flowers_tour on public.flowers (tour_id);
create index if not exists flowers_to on public.flowers (to_id);
create index if not exists flowers_from on public.flowers (tour_id, from_id);
alter table public.flowers enable row level security;
-- Everyone on the tour sees who gave whom flowers there.
drop policy if exists flowers_select on public.flowers;
create policy flowers_select on public.flowers for select using (public.my_role(tour_id) is not null);
-- Nobody writes rows directly: give_flowers does, under the rules. You may
-- take back what you gave (a slip of the thumb), and give it again; and you
-- may remove flowers given to you that you'd rather not keep, note and all.
drop policy if exists flowers_delete on public.flowers;
create policy flowers_delete on public.flowers for delete using (from_id = auth.uid() or to_id = auth.uid());
do $$ begin alter publication supabase_realtime add table public.flowers;
exception when duplicate_object then null; end $$;

-- 3. Giving: to someone else on the tour, out of your 10 for it. The phone
-- names each gift (rid), so a tap that goes through twice on a weak signal
-- still gives once.
create or replace function public.give_flowers(t_id text, to_user uuid, how_many int, why text, rid uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); used int; k int := coalesce(how_many, 1);
begin
  if me is null or public.my_role(t_id) is null or not public.on_tour(t_id, me) then
    raise exception 'permission' using errcode = '42501';
  end if;
  if to_user is null or to_user = me or not public.on_tour(t_id, to_user) then
    raise exception 'not on this tour' using errcode = '22023';
  end if;
  if k < 1 or k > 10 then raise exception 'how many' using errcode = '22023'; end if;
  -- One giver at a time per tour, so two quick taps can't give 11.
  perform pg_advisory_xact_lock(hashtext('flowers:' || t_id || ':' || me::text));
  select coalesce(sum(f.n), 0) into used from flowers f where f.tour_id = t_id and f.from_id = me;
  -- Already given (the same tap, arriving again): nothing more to do.
  if rid is not null and exists (select 1 from flowers f where f.id = rid) then
    return jsonb_build_object('left', 10 - used);
  end if;
  if used + k > 10 then raise exception 'no flowers left' using errcode = '22023'; end if;
  insert into flowers (id, tour_id, from_id, to_id, n, note)
  values (coalesce(rid, gen_random_uuid()), t_id, me, to_user, k, left(trim(coalesce(why, '')), 140));
  return jsonb_build_object('left', 10 - used - k);
end $$;
revoke all on function public.give_flowers(text, uuid, int, text, uuid) from public, anon;
grant execute on function public.give_flowers(text, uuid, int, text, uuid) to authenticated;

-- A person's name as the app shows it.
create or replace function public.person_name(u uuid)
returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), '')
                     from profiles p where p.user_id = u), '')
$$;
revoke all on function public.person_name(uuid) from public, anon, authenticated;

-- 4. A person's numbers anywhere: flowers from every tour, the artists who
-- list them as crew (not counting a page they run or added themselves to),
-- and their tours.
create or replace function public.flower_counts(u uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    -- Only real tours count: not one in the trash, not a band's Off Tour book.
    'flowers', (select coalesce(sum(f.n), 0) from flowers f join tours t on t.id = f.tour_id
                 where f.to_id = u and coalesce(t.doc ->> 'kind', '') <> 'offtour' and (t.doc ->> 'deletedAt') is null),
    'endorsements', (select count(distinct am.artist_id) from artist_members am
                       join artists a on a.id = am.artist_id
                      where am.user_id = u and am.kind = 'crew'
                        and a.owner_id is distinct from u and am.added_by is distinct from u),
    'tours', (select count(*) from public.tours_of(u)))
$$;
revoke all on function public.flower_counts(uuid) from public, anon, authenticated;

-- 5. A tour's Crew Stats: everyone on it who has joined, with their photo,
-- their flowers on this tour, and their numbers anywhere; how many you have
-- left to give; and the flowers given on this tour, newest first.
create or replace function public.tour_flowers(t_id text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null or public.my_role(t_id) is null then return null; end if;
  return jsonb_build_object(
    'left', 10 - (select coalesce(sum(f.n), 0) from flowers f where f.tour_id = t_id and f.from_id = me),
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
          'id', f.id, 'from', f.from_id, 'to', f.to_id, 'n', f.n, 'note', f.note,
          'at', f.created_at, 'mine', f.from_id = me,
          'fromName', case when public.can_see_profile(f.from_id) then public.person_name(f.from_id) else '' end,
          'toName', case when public.can_see_profile(f.to_id) then public.person_name(f.to_id) else '' end)
        order by f.created_at desc)
      from (select * from flowers where tour_id = t_id order by created_at desc limit 100) f), '[]'::jsonb));
end $$;
revoke all on function public.tour_flowers(text) from public, anon;
grant execute on function public.tour_flowers(text) to authenticated;

-- 6. Your own: your numbers, and the flowers you've been given, newest
-- first, with who gave them, what for, and on which tour.
create or replace function public.my_flowers()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return null; end if;
  return jsonb_build_object(
    'counts', public.flower_counts(me),
    'got', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', f.id, 'n', f.n, 'note', f.note, 'at', f.created_at,
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

-- 7. The game ball is retired: no new rounds, and none closed (closing one
-- pushes the result to the crew). Ari's timer finds nothing to open.
create or replace function public.game_ball_retired()
returns trigger
language plpgsql set search_path = public as $$
begin
  return null;
end $$;
drop trigger if exists game_ball_retired on public.game_ball_rounds;
create trigger game_ball_retired before insert or update on public.game_ball_rounds
  for each row execute function public.game_ball_retired();

notify pgrst, 'reload schema';
