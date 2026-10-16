-- A To Do List for every artist (Devin, 2026-10-15).
--
-- Each artist's page gets one list of tasks. Who sees it: the artist's
-- current Members (band, still listed), the account that runs the page, and
-- the people a Member invited onto the list - and only onto that artist's
-- list, nothing else of the artist. Everyone who sees the list can add a
-- task, tick one done, change its words or its category, set a day it is due,
-- and hand it to anyone ("everyone can give tasks to anyone"). The person a
-- task is handed to is told on their phone the way 0144 tells people things:
-- a poke, one word ('todo'), nothing of what the task says.
--
-- "Your To Do List" on a person's own profile is an app-side read of this
-- same table (tasks where assigned_to is you), organized by artist. The
-- categories are a fixed set the app auto-sorts new tasks into; the database
-- only refuses a word outside the set.
--
-- Nothing here reaches the live line, and nothing in these rows is more than
-- ids, dates and plain words: no email, no token, no phone number.

-- ============================== The tasks ==============================

create table if not exists public.todo_items (
  id bigint generated always as identity primary key,
  artist_id uuid not null references public.artists (id) on delete cascade,
  cat text not null check (cat in ('studio', 'business management', 'tour', 'merch', 'other')),
  body text not null check (char_length(body) between 1 and 300),
  -- The person the task is handed to. When their account goes, the task
  -- stays on the artist's list with nobody's name on it.
  assigned_to uuid references auth.users (id) on delete set null,
  due date,
  done_at timestamptz,
  -- No reference on purpose: a task outlives its writer's account (the list
  -- is the artist's, and delete_my_account must not take the band's tasks
  -- with it, nor be blocked by them). A uuid with no account behind it says
  -- nothing about anybody.
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists todo_items_artist on public.todo_items (artist_id);
create index if not exists todo_items_assigned on public.todo_items (assigned_to) where assigned_to is not null;
-- the cap below counts these; keep that count an index read
create index if not exists todo_items_open on public.todo_items (artist_id) where done_at is null;

-- ============================== The invites ==============================

create table if not exists public.todo_invites (
  artist_id uuid not null references public.artists (id) on delete cascade,
  -- an invite is for an account; when the account goes, the invite goes
  user_id uuid not null references auth.users (id) on delete cascade,
  -- No reference on purpose, as created_by above: the invite stands even if
  -- the Member who gave it later deletes their own account.
  invited_by uuid not null,
  at timestamptz not null default now(),
  primary key (artist_id, user_id)
);
create index if not exists todo_invites_user on public.todo_invites (user_id);

-- ============================== Who is who ==============================

-- Runs the list: the account that runs the artist's page, or one of its
-- current Members. (The current-Member test as 0132 left it: kind 'band' and
-- not ended. security definer: an invited person cannot read artist_members
-- rows that are not their own, and these checks must still answer for them.)
create or replace function public.todo_can_run(a_id uuid, u uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select u is not null and (
    exists (select 1 from artists a where a.id = a_id and a.owner_id = u)
    or exists (select 1 from artist_members m
                where m.artist_id = a_id and m.user_id = u and m.kind = 'band' and m.ended_at is null))
$$;
revoke all on function public.todo_can_run(uuid, uuid) from public, anon;
grant execute on function public.todo_can_run(uuid, uuid) to authenticated;

-- Sees the list: whoever runs it, and whoever is invited. Each arm is one
-- indexed lookup, so a policy calling this stays cheap row by row.
create or replace function public.todo_can_see(a_id uuid, u uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.todo_can_run(a_id, u)
      or exists (select 1 from todo_invites i where i.artist_id = a_id and i.user_id = u)
$$;
revoke all on function public.todo_can_see(uuid, uuid) from public, anon;
grant execute on function public.todo_can_see(uuid, uuid) to authenticated;

-- ============================== The rules ==============================

alter table public.todo_items enable row level security;
alter table public.todo_invites enable row level security;

-- Tasks: everyone on the list reads and writes every item. The one row-level
-- extra: the person a task is handed to reads that task and can work it
-- (tick it done) even when they are not on the artist's list - handing
-- somebody a task IS telling them about it, or "give tasks to anyone" means
-- nothing. They cannot delete it, and they see no other task of the artist.
drop policy if exists todo_items_select on public.todo_items;
create policy todo_items_select on public.todo_items for select
  using (public.todo_can_see(artist_id, auth.uid()) or assigned_to = auth.uid());
drop policy if exists todo_items_insert on public.todo_items;
create policy todo_items_insert on public.todo_items for insert
  with check (public.todo_can_see(artist_id, auth.uid()) and created_by = auth.uid());
drop policy if exists todo_items_update on public.todo_items;
create policy todo_items_update on public.todo_items for update
  using (public.todo_can_see(artist_id, auth.uid()) or assigned_to = auth.uid())
  with check (public.todo_can_see(artist_id, auth.uid()) or assigned_to = auth.uid());
-- Delete: the task's writer, the page's Members, and the page's runner.
drop policy if exists todo_items_delete on public.todo_items;
create policy todo_items_delete on public.todo_items for delete
  using (created_by = auth.uid() or public.todo_can_run(artist_id, auth.uid()));

-- Invites: given and taken back by Members and the page's runner only. An
-- invited person reads their own invite rows (that is how the app knows
-- which artists' lists to show them) and nobody else's.
drop policy if exists todo_invites_select on public.todo_invites;
create policy todo_invites_select on public.todo_invites for select
  using (user_id = auth.uid() or public.todo_can_run(artist_id, auth.uid()));
drop policy if exists todo_invites_insert on public.todo_invites;
create policy todo_invites_insert on public.todo_invites for insert
  with check (public.todo_can_run(artist_id, auth.uid()) and invited_by = auth.uid());
drop policy if exists todo_invites_delete on public.todo_invites;
create policy todo_invites_delete on public.todo_invites for delete
  using (public.todo_can_run(artist_id, auth.uid()));

revoke all on public.todo_items from public, anon, authenticated;
grant select, insert, update, delete on public.todo_items to authenticated;
revoke all on public.todo_invites from public, anon, authenticated;
-- (no update: an invite is given or taken back, never edited)
grant select, insert, delete on public.todo_invites to authenticated;

-- ============================== The guard rails ==============================

-- Before a task is written: a list holds at most 500 tasks not done, and the
-- row's parentage never changes (who wrote it, when, and whose list it is -
-- otherwise an edit could walk a task onto another artist's list, or put
-- another name on the writer's line and take their delete right with it).
-- The cap is a guard against a runaway list, not an accounting rule: two
-- phones adding task 500 in the same instant may land 501, and that is fine.
-- security definer so the count sees the whole list, not just the caller's rows.
create or replace function public.todo_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.artist_id := old.artist_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    return new;
  end if;
  if (select count(*) from todo_items t where t.artist_id = new.artist_id and t.done_at is null) >= 500 then
    raise exception 'This list already holds 500 tasks not done. Tick some off or delete some first.'
      using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.todo_guard() from public, anon, authenticated;

drop trigger if exists todo_items_guard on public.todo_items;
create trigger todo_items_guard before insert or update on public.todo_items
  for each row execute function public.todo_guard();

-- A task handed to somebody: their phone is told "look again" (0144's poke,
-- what = 'todo'). Only when the handing is news: on a new task with a name
-- on it, or when the name changes - never when they hand it to themselves,
-- and never for a tick, an edit or a due date alone. A poke never raises, and
-- this must never be the reason a task cannot be saved.
create or replace function public.poke_on_todo()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    if new.assigned_to is not null
       and new.assigned_to is distinct from auth.uid()
       and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to) then
      perform public.poke(new.assigned_to, 'todo');
    end if;
  exception when others then
    raise log 'poke_on_todo: % (%)', tg_op, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.poke_on_todo() from public, anon, authenticated;

drop trigger if exists todo_items_poke on public.todo_items;
create trigger todo_items_poke after insert or update on public.todo_items
  for each row execute function public.poke_on_todo();

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop trigger if exists todo_items_poke on public.todo_items;
--   drop trigger if exists todo_items_guard on public.todo_items;
--   drop function if exists public.poke_on_todo();
--   drop function if exists public.todo_guard();
--   drop function if exists public.todo_can_see(uuid, uuid);
--   drop function if exists public.todo_can_run(uuid, uuid);
--   drop table if exists public.todo_invites;
--   drop table if exists public.todo_items;
--   notify pgrst, 'reload schema';
-- The lists and everything on them are gone with the tables: this feature
-- holds nothing any other table leans on, so nothing else moves.
