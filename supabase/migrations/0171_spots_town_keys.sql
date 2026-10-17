-- Spots key their town, not their spelling (Devin, 2026-10-16 night: "I am
-- not seeing my spots from today on the day sheet"). His real rows told
-- the story: the place picker saves a city as "Houston, Texas" while the
-- show says "Houston, TX", and 0153's key was made from the WHOLE string,
-- so "houston, texas" and "houston, tx" could never meet and tonight's
-- sheet stood empty over his own coffee spot. The venue fold learned this
-- lesson in 0160 and follow_spots in 0170; now the spots key itself does:
-- the trigger keys the town before the comma, and every stored row is
-- rekeyed the same way, so every reader - the day sheet's tour spots, the
-- follows road, the tab's groups - meets on the town.
create or replace function public.local_spot_key()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.city_key := public.road_city_key(split_part(coalesce(new.city, ''), ',', 1));
  return new;
end $$;
revoke all on function public.local_spot_key() from public, anon, authenticated;

-- Every stored row meets the new rule once.
update public.local_spots
   set city_key = public.road_city_key(split_part(city, ',', 1))
 where city_key is distinct from public.road_city_key(split_part(city, ',', 1));

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   Put back 0153's local_spot_key (its text is in that file) and run the
--   update above with road_city_key(city) instead. Nothing else leans on
--   the key's spelling: every reader compares keys to keys.
