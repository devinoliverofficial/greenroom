-- GA crew couldn't read the tour creator's profile, so the creator showed up
-- as "Crew" with no name or contact: the rule looked the creator up in the
-- tours table, and GA can't read that table (that's how the money is kept
-- from them; they get tour_public instead). The check now runs on its own
-- authority: is this person on, or the creator of, a tour I'm on?
create or replace function public.on_my_tours(u uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members m where m.user_id = u and public.my_role(m.tour_id) is not null)
      or exists (select 1 from tours t where t.owner_id = u and public.my_role(t.id) is not null)
$$;
revoke all on function public.on_my_tours(uuid) from public, anon;
grant execute on function public.on_my_tours(uuid) to authenticated;

drop policy if exists profiles_crew on public.profiles;
create policy profiles_crew on public.profiles for select using (public.on_my_tours(user_id));
