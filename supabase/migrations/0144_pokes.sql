-- Told as it happens: "something of yours changed, look again" (Devin, 2026-10-12).
--
-- "I also dont want someone to have to 'hard close the app" to see their
-- endorsements or tours. The information should just be added while they are
-- using the app"
--
-- What happened: when an artist accepts someone, endorses them or confirms
-- their tours, the rows that change are members (a seat on a tour),
-- artist_members (listed under an artist), artist_endorsements,
-- artist_requests (a request and its answer) and tour_credits (tours claimed
-- and confirmed). None of them is sent to phones as it changes, so a phone
-- only learned of it the next time it read everything: when the app was
-- closed and opened again.
--
-- Those five tables are NOT put on the live line. A row taken off a table
-- that is on it is sent to every phone listening, with its key columns,
-- whatever the row rules say, and the key of members holds an email address.
--
-- Instead: one small row per person, public.pokes, that says nothing but
-- "look again" and when. Each of the five tables touches the row of the
-- person concerned (and of the artist's page runner, for a new request or a
-- claim sent). Only that row is on the live line, each phone is sent its own
-- and nobody else's, and on hearing it the phone reads its tours and its
-- profile again. The row carries no name, no address and nothing of what
-- changed: only a word for the kind of thing ('seat', 'listing',
-- 'endorsement', 'request', 'credits').
--
-- (Its key is a plain number that means nothing. When an account is deleted
-- its row goes with it, and a row being taken away is sent down the live line
-- with its key alone, whatever the row rules say: so the key must not be the
-- account's id. The app listens for a row being written, never for one being
-- taken away.)

create table if not exists public.pokes (
  id bigint generated always as identity primary key,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  at timestamptz not null default now(),
  what text not null default ''
);
alter table public.pokes enable row level security;
-- Your own row and no other. Nobody writes it from a phone: only the
-- function below does, on the database's own authority.
drop policy if exists pokes_select on public.pokes;
create policy pokes_select on public.pokes for select using (user_id = auth.uid());
revoke all on public.pokes from public, anon, authenticated;
grant select on public.pokes to authenticated;

-- Phones hear their own row change as it happens. (Guarded: nothing here
-- fails where the live line is not set up, or already carries the table.)
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pokes') then
    alter publication supabase_realtime add table public.pokes;
  end if;
exception when others then
  raise warning 'pokes: not added to the live line (%)', sqlerrm;
end $$;

-- "Look again", for one person. Nothing for nobody; and it never raises: a
-- poke must never be the reason an approval, a seat or a listing fails.
-- (An account that is being deleted has no row to write: it is left alone.)
create or replace function public.poke(u uuid, w text)
returns void
language plpgsql volatile security definer set search_path = public set lock_timeout = '250ms' as $$
begin
  -- (lock_timeout above: two things touching the same person's row at once must
  -- not wait on each other. The one that waits gives up after a quarter of a
  -- second, which lands in the block below like any other trouble; the person
  -- is still told by the one that got there first.)
  if u is null then return; end if;
  begin
    insert into pokes (user_id, at, what)
    select u, clock_timestamp(), left(coalesce(w, ''), 40)
     where exists (select 1 from auth.users x where x.id = u)
    on conflict (user_id) do update set at = excluded.at, what = excluded.what;
  exception when others then
    raise log 'poke: % (%)', u, sqlerrm;
  end;
end $$;
revoke all on function public.poke(uuid, text) from public, anon, authenticated;

-- Whose seat is this? The account on the row; and for a seat still waiting
-- by address (nobody linked yet), the account whose confirmed address it is,
-- so an invite to someone who already has an account shows on their phone.
create or replace function public.seat_account(u uuid, addr text)
returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(u, (select x.id from auth.users x
                       where btrim(coalesce(addr, '')) <> ''
                         and lower(x.email) = lower(btrim(addr))
                         and x.email_confirmed_at is not null
                       limit 1))
$$;
revoke all on function public.seat_account(uuid, text) from public, anon, authenticated;

-- A seat made, changed or taken away: the person it belongs to. On a change,
-- only when it is one their phone shows (which tour, whose seat, Manager or
-- Crew, the role's words): their own name or phone number saved again is not
-- news to them. When the seat passes from one account to another, both.
create or replace function public.poke_on_seat()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  was uuid; who uuid;
begin
  begin
    if tg_op = 'UPDATE'
       and new.tour_id = old.tour_id
       and new.invited_email = old.invited_email
       and new.user_id is not distinct from old.user_id
       and new.role is not distinct from old.role
       and new.manager is not distinct from old.manager
       and new.tour_role is not distinct from old.tour_role then
      return null;
    end if;
    if tg_op <> 'INSERT' then was := public.seat_account(old.user_id, old.invited_email); end if;
    if tg_op <> 'DELETE' then who := public.seat_account(new.user_id, new.invited_email); end if;
    perform public.poke(was, 'seat');
    if who is distinct from was then perform public.poke(who, 'seat'); end if;
  exception when others then
    raise log 'poke_on_seat: % (%)', tg_op, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.poke_on_seat() from public, anon, authenticated;

-- (Beside members_trusted, members_user_locked, members_manager_stays and
-- members_push_recheck, which are left exactly as they are: this one runs
-- after the row is written, changes nothing and stops nothing.)
drop trigger if exists members_poke on public.members;
create trigger members_poke after insert or update or delete on public.members
  for each row execute function public.poke_on_seat();

-- Listed under an artist, the listing changed (Crew or Member, the role's
-- words, left, back again), or taken off: the person.
create or replace function public.poke_on_listing()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    if tg_op = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then return null; end if;
    if tg_op <> 'INSERT' then perform public.poke(old.user_id, 'listing'); end if;
    if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.user_id is distinct from old.user_id) then
      perform public.poke(new.user_id, 'listing');
    end if;
  exception when others then
    raise log 'poke_on_listing: % (%)', tg_op, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.poke_on_listing() from public, anon, authenticated;

drop trigger if exists artist_members_poke on public.artist_members;
create trigger artist_members_poke after insert or update or delete on public.artist_members
  for each row execute function public.poke_on_listing();

-- An endorsement given, changed or removed: the person.
create or replace function public.poke_on_endorsement()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    if tg_op = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then return null; end if;
    if tg_op <> 'INSERT' then perform public.poke(old.user_id, 'endorsement'); end if;
    if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.user_id is distinct from old.user_id) then
      perform public.poke(new.user_id, 'endorsement');
    end if;
  exception when others then
    raise log 'poke_on_endorsement: % (%)', tg_op, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.poke_on_endorsement() from public, anon, authenticated;

drop trigger if exists artist_endorsements_poke on public.artist_endorsements;
create trigger artist_endorsements_poke after insert or update or delete on public.artist_endorsements
  for each row execute function public.poke_on_endorsement();

-- A request to be listed: the person who asked, whatever happens to it (it
-- is answered, it is taken back, it is sent again). And the account that
-- runs the artist's page when something is waiting on it that it has not
-- seen as it stands (a request arrives, or is sent again) or something that
-- was waiting is gone (taken back by the person), so the card on the
-- artist's phone comes and goes as it happens. Its own yes or no is not
-- news to it. A page nobody runs has nobody to tell.
create or replace function public.poke_on_request()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  runner uuid;
  asked boolean := false;
begin
  begin
    if tg_op = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then return null; end if;
    if tg_op <> 'INSERT' then perform public.poke(old.user_id, 'request'); end if;
    if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.user_id is distinct from old.user_id) then
      perform public.poke(new.user_id, 'request');
    end if;
    if tg_op = 'INSERT' then
      asked := new.status = 'pending';
    elsif tg_op = 'UPDATE' then
      asked := new.status = 'pending' or (old.status = 'pending' and new.status = 'withdrawn');
    else
      asked := old.status = 'pending';
    end if;
    if asked then
      select a.owner_id into runner from artists a
       where a.id = case when tg_op = 'DELETE' then old.artist_id else new.artist_id end;
      if runner is not null
         and runner is distinct from (case when tg_op = 'DELETE' then old.user_id else new.user_id end) then
        perform public.poke(runner, 'request');
      end if;
    end if;
  exception when others then
    raise log 'poke_on_request: % (%)', tg_op, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.poke_on_request() from public, anon, authenticated;

drop trigger if exists artist_requests_poke on public.artist_requests;
create trigger artist_requests_poke after insert or update or delete on public.artist_requests
  for each row execute function public.poke_on_request();

-- Tours claimed, confirmed, sent back or taken away: the person. And the
-- account that runs the artist's page when a claim is waiting on it that was
-- not there a moment ago (sent, or sent again), or one that was waiting has
-- been taken back.
create or replace function public.poke_on_credit()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  runner uuid;
  asked boolean := false;
begin
  begin
    if tg_op = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then return null; end if;
    if tg_op <> 'INSERT' then perform public.poke(old.user_id, 'credits'); end if;
    if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.user_id is distinct from old.user_id) then
      perform public.poke(new.user_id, 'credits');
    end if;
    if tg_op = 'INSERT' then
      asked := new.pending is not null;
    elsif tg_op = 'UPDATE' then
      asked := new.pending is not null
           and (new.pending is distinct from old.pending or new.submitted_at is distinct from old.submitted_at);
    else
      asked := old.pending is not null;
    end if;
    if asked then
      select a.owner_id into runner from artists a
       where a.id = case when tg_op = 'DELETE' then old.artist_id else new.artist_id end;
      if runner is not null
         and runner is distinct from (case when tg_op = 'DELETE' then old.user_id else new.user_id end) then
        perform public.poke(runner, 'credits');
      end if;
    end if;
  exception when others then
    raise log 'poke_on_credit: % (%)', tg_op, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.poke_on_credit() from public, anon, authenticated;

drop trigger if exists tour_credits_poke on public.tour_credits;
create trigger tour_credits_poke after insert or update or delete on public.tour_credits
  for each row execute function public.poke_on_credit();

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop trigger if exists members_poke on public.members;
--   drop trigger if exists artist_members_poke on public.artist_members;
--   drop trigger if exists artist_endorsements_poke on public.artist_endorsements;
--   drop trigger if exists artist_requests_poke on public.artist_requests;
--   drop trigger if exists tour_credits_poke on public.tour_credits;
--   drop function if exists public.poke_on_seat();
--   drop function if exists public.poke_on_listing();
--   drop function if exists public.poke_on_endorsement();
--   drop function if exists public.poke_on_request();
--   drop function if exists public.poke_on_credit();
--   drop function if exists public.seat_account(uuid, text);
--   drop function if exists public.poke(uuid, text);
--   do $$ begin
--     if exists (select 1 from pg_publication_tables
--                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pokes') then
--       alter publication supabase_realtime drop table public.pokes;
--     end if;
--   end $$;
--   drop table if exists public.pokes;
--   notify pgrst, 'reload schema';
-- A phone on a build that listens for pokes simply hears none: its line for
-- them stays quiet and everything else on it carries on as before.
