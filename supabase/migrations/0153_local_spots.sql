-- FAVORITE LOCAL SPOTS (Devin's chosen name, 2026-10-15).
--
-- People save the places they love in each city: a restaurant, a coffee
-- shop, a bar, a club, a thing to do. Typed in by hand - no outside map
-- service in this first cut, so a spot is nothing but words the saver chose.
--
-- Who sees a saved place: the saver, always and everywhere; and when the
-- saver pins it to a tour, everyone with a seat on that tour (its owner or a
-- members row - my_role answers exactly that, and it is how every tour read
-- in the app is gated). Nobody else reads anything.
--
-- The day sheet's "PLACES RECOMMENDED BY TOUR" is an app-side read of this
-- table: the rows of tonight's tour whose city_key is tonight's city's key,
-- each with its saver's name as "who recommends". No new function is needed
-- for it; the (tour_id, city_key) index below is that read's path.
--
-- city_key is the city's name as the counting rules spell it
-- (public.road_city_key, 0115 as 0128 left it: accents off, W./St./Mt.
-- opened up, NYC is New York), so "Montréal" and "montreal" land on the same
-- day sheet. The app sends it, but the trigger below recomputes it from the
-- city on every write, so a phone cannot lie a spot onto the wrong city.
--
-- Nothing here reaches the live line, and a row is ids, dates and plain
-- words only: no email, no token, no address beyond what the saver typed.

create table if not exists public.local_spots (
  id bigint generated always as identity primary key,
  -- your spots go with your account
  user_id uuid not null references auth.users (id) on delete cascade,
  -- the tour it is shared with; none means the saver alone sees it. When the
  -- tour is deleted the spot stays the saver's own, unpinned.
  tour_id text references public.tours (id) on delete set null,
  city text not null check (char_length(city) <= 60),
  -- always road_city_key(city); the trigger below sees to it
  city_key text not null check (char_length(city_key) <= 80),
  name text not null check (char_length(name) <= 80),
  kind text not null check (kind in ('food', 'coffee', 'bar', 'club', 'to do', 'other')),
  note text check (note is null or char_length(note) <= 240),
  created_at timestamptz not null default now()
);
create index if not exists local_spots_user on public.local_spots (user_id);
-- the day sheet's read: this tour, this city
create index if not exists local_spots_tour_city on public.local_spots (tour_id, city_key) where tour_id is not null;

-- The key is worked out here, whatever the phone sent (or did not send: this
-- runs before the not-null check). security definer because road_city_key is
-- not the phones' to call directly, and this must still answer for them.
create or replace function public.local_spot_key()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.city_key := public.road_city_key(new.city);
  return new;
end $$;
revoke all on function public.local_spot_key() from public, anon, authenticated;

drop trigger if exists local_spots_key on public.local_spots;
create trigger local_spots_key before insert or update on public.local_spots
  for each row execute function public.local_spot_key();

alter table public.local_spots enable row level security;

-- The saver reads their own rows; a row pinned to a tour is read by everyone
-- on that tour. (my_role per row is one indexed lookup, and a day sheet's
-- read brings back a handful of rows, so this stays well inside the budget.)
drop policy if exists local_spots_select on public.local_spots;
create policy local_spots_select on public.local_spots for select
  using (user_id = auth.uid()
         or (tour_id is not null and public.my_role(tour_id) is not null));
-- Writing is the saver's alone, and a spot is only ever pinned to a tour the
-- saver is on: without that check, anyone could plant "recommendations" on a
-- stranger's day sheets.
drop policy if exists local_spots_insert on public.local_spots;
create policy local_spots_insert on public.local_spots for insert
  with check (user_id = auth.uid()
              and (tour_id is null or public.my_role(tour_id) is not null));
drop policy if exists local_spots_update on public.local_spots;
create policy local_spots_update on public.local_spots for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid()
              and (tour_id is null or public.my_role(tour_id) is not null));
drop policy if exists local_spots_delete on public.local_spots;
create policy local_spots_delete on public.local_spots for delete
  using (user_id = auth.uid());

revoke all on public.local_spots from public, anon, authenticated;
grant select, insert, update, delete on public.local_spots to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop trigger if exists local_spots_key on public.local_spots;
--   drop function if exists public.local_spot_key();
--   drop table if exists public.local_spots;
--   notify pgrst, 'reload schema';
-- Saved spots are gone with the table: nothing else leans on it, and the day
-- sheet simply shows no recommendations again.
