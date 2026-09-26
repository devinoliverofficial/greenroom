-- Contact cards. Everyone on a tour can read everyone else's (that is the
-- point: it is the tour's phone book), but only you can write your own —
-- which is also why roles live in members, out of reach of self-edits.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  username text not null default '',
  email text not null default '',
  phone text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists profiles_crew on public.profiles;
create policy profiles_crew on public.profiles for select
  using (
    exists (select 1 from public.members m
            where m.user_id = profiles.user_id and public.my_role(m.tour_id) is not null)
    or exists (select 1 from public.tours t
               where t.owner_id = profiles.user_id and public.my_role(t.id) is not null)
  );

-- The crew list is for the whole crew, not just the manager.
drop policy if exists members_select on public.members;
create policy members_select on public.members for select
  using (public.my_role(tour_id) is not null
         or user_id = auth.uid()
         or lower(invited_email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- A phone number the inviter already knows, for people not signed up yet.
alter table public.members add column if not exists phone text not null default '';
