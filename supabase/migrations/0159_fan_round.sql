-- THE FAN ROUND (Devin, 2026-10-15): "a fan can search artists, follow, mark
-- shows attended. They can create a top 10 favorite artists on their page
-- (kinda like myspace use to have). Based on how many shows they've attended
-- they are ranked on bands profile pages. We can make a Top Fans page that
-- shows the top 100 fans of that artist based on attendance."
--
-- Searching, following and Attended ticks exist already (0053, 0048, 0134).
-- What is new here:
--   1. fan_favorites: one row per spot on a person's Top 10 - whose list,
--      which artist page, which spot. A Top 10 is made to be looked at, so
--      any signed-in account reads any row; only the owner writes their own.
--      The keys cap the list by themselves: an artist holds one spot, a spot
--      holds one artist, and a spot is 1 to 10, so no list passes ten rows.
--      The spot's uniqueness is checked when the statement commits, not row
--      by row (deferrable initially deferred), so one statement can swap two
--      spots, or shuffle the whole list, without tripping over itself half
--      way through.
--   2. artist_top_fans: one artist page's ranked fans, counted from
--      show_attendance (0134, the Attended ticks) - up to 100, most shows
--      first, each as userId, name, avatar and shows. The name and the
--      picture come from profiles the way find_people (0053) says them;
--      no email, no phone number and no token leaves this function.
--
-- Nothing here reaches the live line, and a row is two ids, a small number
-- and a time: nothing in it to shield from the people it is shown to.

-- 1. The Top 10 itself.
create table if not exists public.fan_favorites (
  -- whose list
  user_id uuid not null references auth.users (id) on delete cascade,
  -- the artist page in the spot; the row goes when the page goes
  artist_id uuid not null references public.artists (id) on delete cascade,
  -- the spot on the list; 1 is the top (the check is the cap: ten spots, no more)
  rank int not null check (rank between 1 and 10),
  -- when the spot was written; the database's clock, nobody sends it
  at timestamptz not null default now(),
  primary key (user_id, artist_id),
  -- one artist per spot, checked at commit so a reorder's ranks may pass
  -- each other inside a single statement
  unique (user_id, rank) deferrable initially deferred
);
-- Deleting an artist page must not walk the table (the primary key leads
-- with user_id, so artist_id needs a path of its own).
create index if not exists fan_favorites_artist on public.fan_favorites (artist_id);

alter table public.fan_favorites enable row level security;

-- Who reads: anyone signed in. A Top 10 is for showing - it sits on the
-- profile exactly so that other people see it - and a row holds nothing but
-- ids, a spot and a time. Nobody signed out reads anything.
drop policy if exists fan_favorites_select on public.fan_favorites;
create policy fan_favorites_select on public.fan_favorites for select
  using (auth.uid() is not null);

-- Who writes: each person their own rows, nobody else's, in every direction.
drop policy if exists fan_favorites_insert on public.fan_favorites;
create policy fan_favorites_insert on public.fan_favorites for insert
  with check (user_id = auth.uid());
drop policy if exists fan_favorites_update on public.fan_favorites;
create policy fan_favorites_update on public.fan_favorites for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
drop policy if exists fan_favorites_delete on public.fan_favorites;
create policy fan_favorites_delete on public.fan_favorites for delete
  using (user_id = auth.uid());

-- Phones write the three columns that are theirs; 'at' is the database's own
-- default, with no grant, so nobody back-dates a spot. update covers all
-- three because a reorder arrives as one upsert (insert .. on conflict do
-- update), and that statement sets every column it sends; the policies keep
-- every row the writer's own whatever the statement says.
revoke all on public.fan_favorites from public, anon, authenticated;
grant select on public.fan_favorites to authenticated;
grant insert (user_id, artist_id, rank) on public.fan_favorites to authenticated;
grant update (user_id, artist_id, rank) on public.fan_favorites to authenticated;
grant delete on public.fan_favorites to authenticated;

-- 2. One artist page's Top Fans: everyone's Attended ticks for that page,
-- counted per person, most shows first, at most 100 (whatever cap a phone
-- asks for).
--
-- The count below reads show_attendance by artist, and that table's key
-- leads with user_id (0134 reads it per fan): the new read gets a path of
-- its own, so an artist page's Top Fans never walks every fan's ticks.
create index if not exists show_attendance_artist on public.show_attendance (artist_id);

-- security definer because show_attendance is each fan's own and
-- profiles are not the phones' to read whole; what leaves is the user id,
-- the public name, the public picture and a count - the same three words
-- about a person that find_people already says to anyone signed in.
create or replace function public.artist_top_fans(a_id uuid, cap int default 100)
returns jsonb
language sql
stable security definer
set search_path = public
as $function$
  select case when auth.uid() is null then null else coalesce((
    select jsonb_agg(jsonb_build_object(
        'userId', x.user_id,
        'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
        'avatar', coalesce(p.avatar, ''),
        'shows', x.n)
      order by x.n desc, x.user_id)
      from (select s.user_id, count(*) as n
              from show_attendance s
             where s.artist_id = a_id
             group by s.user_id
             order by n desc, s.user_id
             limit least(greatest(coalesce(cap, 100), 1), 100)) x
      left join profiles p on p.user_id = x.user_id), '[]'::jsonb) end
$function$;
revoke all on function public.artist_top_fans(uuid, int) from public, anon;
grant execute on function public.artist_top_fans(uuid, int) to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop function if exists public.artist_top_fans(uuid, int);
--   drop table if exists public.fan_favorites;
--   drop index if exists public.show_attendance_artist;
--   notify pgrst, 'reload schema';
-- The Top 10s are gone with the table: nothing else leans on it, the strip
-- and the Top Fans line simply stop rendering (the app's probe finds no
-- table), and the Attended ticks themselves stay exactly where 0134 keeps
-- them.
