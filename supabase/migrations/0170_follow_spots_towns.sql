-- follow_spots compares towns as towns (a catch from 0169's review, the
-- same day): a spot saves its city as "Austin, TX" and its stored key
-- carries the state, while the question arrives as the town alone, so the
-- two keys could never meet and the Today section would stand empty over
-- real spots. Both sides now fold to the town before the comma. Nothing
-- else changes: same door, same follows-only reach, same tour-recommended
-- rule, same shapes.
create or replace function public.follow_spots(near text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'userId', s.user_id,
           'who', coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.username), ''), 'Someone'),
           'city', s.city, 'name', s.name, 'kind', s.kind,
           'note', coalesce(s.note, '')) order by s.created_at desc), '[]'::jsonb)
    from (select * from local_spots sp
           where public.road_city_key(split_part(sp.city, ',', 1)) =
                 public.road_city_key(split_part(coalesce(near, ''), ',', 1))
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
--   Put back 0169's follow_spots (its text is in that file) and
--   notify pgrst, 'reload schema';
