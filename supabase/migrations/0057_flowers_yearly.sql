-- Flowers are a year's worth, not a tour's. Devin: "each person is given 10
-- flowers to hand out once a year." So the 10 are counted across every tour
-- you're on, from January 1st (UTC); a flower taken back goes back into this
-- year's 10. You still give them on a tour, to someone on it.

-- How many of this year's 10 a person has left.
-- The year starts at midnight UTC on January 1st, whatever time zone a
-- request asks for.
create or replace function public.flowers_left(u uuid)
returns int
language sql stable security definer set search_path = public as $$
  select greatest(0, 10 - coalesce((select sum(f.n) from flowers f
                         where f.from_id = u and f.created_at >= date_trunc('year', now(), 'UTC')), 0))::int
$$;
create index if not exists flowers_from_at on public.flowers (from_id, created_at) include (n);

-- Taking flowers back puts them back into this year's 10, so only this
-- year's can be taken back. Flowers given to you can always be removed.
drop policy if exists flowers_delete on public.flowers;
create policy flowers_delete on public.flowers for delete
  using ((from_id = auth.uid() and created_at >= date_trunc('year', now(), 'UTC')) or to_id = auth.uid());
revoke all on function public.flowers_left(uuid) from public, anon, authenticated;

create or replace function public.give_flowers(t_id text, to_user uuid, how_many int, why text, rid uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); have int; k int := coalesce(how_many, 1);
begin
  if me is null or public.my_role(t_id) is null or not public.on_tour(t_id, me) then
    raise exception 'permission' using errcode = '42501';
  end if;
  if to_user is null or to_user = me or not public.on_tour(t_id, to_user) then
    raise exception 'not on this tour' using errcode = '22023';
  end if;
  if k < 1 or k > 10 then raise exception 'how many' using errcode = '22023'; end if;
  -- One giver at a time (the 10 span every tour), so two quick taps can't give 11.
  perform pg_advisory_xact_lock(hashtext('flowers:' || me::text));
  have := public.flowers_left(me);
  -- Already given (the same tap, arriving again): nothing more to do.
  if rid is not null and exists (select 1 from flowers f where f.id = rid) then
    return jsonb_build_object('left', have);
  end if;
  if k > have then raise exception 'no flowers left' using errcode = '22023'; end if;
  insert into flowers (id, tour_id, from_id, to_id, n, note)
  values (coalesce(rid, gen_random_uuid()), t_id, me, to_user, k, left(trim(coalesce(why, '')), 140));
  return jsonb_build_object('left', have - k);
end $$;
revoke all on function public.give_flowers(text, uuid, int, text, uuid) from public, anon;
grant execute on function public.give_flowers(text, uuid, int, text, uuid) to authenticated;

-- A tour's Crew Stats and your own: 'left' is this year's.
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
          'id', f.id, 'from', f.from_id, 'to', f.to_id, 'n', f.n, 'note', f.note,
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

notify pgrst, 'reload schema';
