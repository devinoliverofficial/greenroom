-- Spots ride the following (Devin, 2026-10-16: "if someone follows another
-- person outside the tour it will show up at the bottom of their 'today'
-- tab but only theirs. The whole tour wont see other people they dont
-- follow").
--
-- One door: follow_spots(near) answers the spots people YOU follow have
-- recommended in that town - each with whose it is - so your Today can end
-- with the places your people rate there, seen by you alone because only
-- your phone asks with your follows.
--
-- What a follower may see, and the standing promise kept: a spot saved
-- with no tour ("Off, it stays yours alone") stays the saver's alone -
-- followers never see it. What travels is what was already recommended to
-- a tour: those are recommendations by their nature, and the saver's own
-- profile is public to their followers. Column by column, what leaves: the
-- place's name, kind, note, town, and the saver's id and shown name (what
-- any signed-in account reads on their profile). No email, no phone
-- number, nothing of any tour's money.
create or replace function public.follow_spots(near text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'userId', s.user_id,
           'who', coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.username), ''), 'Someone'),
           'city', s.city, 'name', s.name, 'kind', s.kind,
           'note', coalesce(s.note, '')) order by s.created_at desc), '[]'::jsonb)
    from (select * from local_spots sp
           where sp.city_key = public.road_city_key(split_part(coalesce(near, ''), ',', 1))
             and sp.tour_id is not null
             and sp.user_id in (select f.followee_id from follows f where f.follower_id = auth.uid())
           order by sp.created_at desc
           limit 40) s
    left join profiles p on p.user_id = s.user_id
   where auth.uid() is not null
$$;
revoke all on function public.follow_spots(text) from public, anon;
grant execute on function public.follow_spots(text) to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop function if exists public.follow_spots(text);
--   notify pgrst, 'reload schema';
-- The app's probe finds no function and Today simply ends where it did.
