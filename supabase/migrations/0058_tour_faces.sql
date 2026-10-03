-- The Overview's crew list shows each person's profile photo beside their
-- name (Devin: "I love the idea of each name having the profile circular
-- photo next to it"). Everyone on a tour can already open each other's
-- profiles, so this hands them just the photos, keyed by account.
create or replace function public.tour_faces(t_id text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or public.my_role(t_id) is null then return null; end if;
  return coalesce((
    select jsonb_object_agg(p.user_id, p.avatar)
      from profiles p
     where coalesce(p.avatar, '') <> ''
       and (exists (select 1 from tours t where t.id = t_id and t.owner_id = p.user_id)
            or exists (select 1 from members m where m.tour_id = t_id and m.user_id = p.user_id))), '{}'::jsonb);
end $$;
revoke all on function public.tour_faces(text) from public, anon;
grant execute on function public.tour_faces(text) to authenticated;

notify pgrst, 'reload schema';
