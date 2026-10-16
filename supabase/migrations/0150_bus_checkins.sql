-- Bus Check in: the driver's headcount (Devin, 2026-10-15).
--
-- The Check In button becomes "Bus Check in", with two states: "On Bus" and
-- "Off Bus". It lights green at bus call and when someone goes off the bus at
-- a stop. "This is basically a way for the driver to keep count of everyone
-- on the bus": everyone on the bus list sees who is on and off, and everyone
-- is alerted when someone steps on or off, "this way everyone can be
-- accountable". When crew are added, the tour asks "Are they riding on the
-- bus?".
--
-- What the database holds:
--   1. members gains rides_bus: is this seat on the bus list at all. The app
--      asks when a person is added; everyone already seated today is set to
--      true, because today's crews ride the bus and nobody should fall off
--      the list by a column landing.
--   2. bus_checkins: one row per person per tour per day, saying 'on' or
--      'off' and when it last changed. The row is the person's own word:
--      they write it themselves and nobody else can write it for them.
--   3. A poke ('bus', the 0144 pattern) to every phone on the tour whenever
--      a row is written or flipped, so the driver's count and everyone
--      else's list refresh while the app is open. bus_checkins itself is NOT
--      put on the live line: a row names a person by account id, and the
--      live line sends deleted rows' keys to every listener whatever the row
--      rules say. The poke says nothing but "look again".
--
-- The old Check In (0033, a crew_stats 'checkin' row counted in Crew Stats)
-- is not touched here: what becomes of that button is the app's business.

-- 1. Is this seat riding the bus? The app asks when crew are added. Default
-- true: every seat that exists today goes on the bus list, so current crews
-- see the feature at once and a Manager unticks the few who travel apart.
alter table public.members add column if not exists rides_bus boolean not null default true;

-- 2. One row per person per tour per day. 'state' is the only word a phone
-- ever writes here, and it can only be 'on' or 'off' (that check is the text
-- cap). 'at' is when the state last changed, kept honest by the trigger
-- below, so "went off the bus at 14:02" is the database's clock, not the
-- phone's. Nothing in the row but ids, a date, a word and a time.
create table if not exists public.bus_checkins (
  tour_id text not null references public.tours (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  state text not null check (state in ('on', 'off')),
  at timestamptz not null default now(),
  primary key (tour_id, user_id, day)
);
-- The read that opens the sheet is "this tour, today": give it an index of
-- its own (the primary key leads with tour_id but not day). And one on
-- user_id so deleting an account does not walk the table.
create index if not exists bus_checkins_tour_day on public.bus_checkins (tour_id, day);
create index if not exists bus_checkins_user on public.bus_checkins (user_id);

alter table public.bus_checkins enable row level security;

-- Who reads: anyone on the tour (its owner, or any seat: my_role says so in
-- one place, 0138's text) reads all of that tour's rows, Crew included:
-- "everyone on the bus list sees who is on and off". There is no money and
-- no address in a row, only ids and 'on'/'off'.
drop policy if exists bus_checkins_select on public.bus_checkins;
create policy bus_checkins_select on public.bus_checkins for select
  using (public.my_role(tour_id) is not null);

-- Who writes: a person writes their own row and only while on the tour.
-- Nobody checks anybody else on or off: the row is each person's own word,
-- "this way everyone can be accountable".
drop policy if exists bus_checkins_insert on public.bus_checkins;
create policy bus_checkins_insert on public.bus_checkins for insert
  with check (user_id = auth.uid() and public.my_role(tour_id) is not null);
drop policy if exists bus_checkins_update on public.bus_checkins;
create policy bus_checkins_update on public.bus_checkins for update
  using (user_id = auth.uid() and public.my_role(tour_id) is not null)
  with check (user_id = auth.uid() and public.my_role(tour_id) is not null);
-- No delete policy: nobody deletes a check-in from a phone. A wrong tap is
-- put right by tapping the other state, and the day's record stands.

-- Phones supply the ids, the date and the word; the times are the
-- database's own (no grant on 'at', so the defaults and the trigger below
-- fill it). On an update only 'state' can move: the key columns cannot be
-- edited into some other tour, person or day.
revoke all on public.bus_checkins from public, anon, authenticated;
grant select on public.bus_checkins to authenticated;
grant insert (tour_id, user_id, day, state) on public.bus_checkins to authenticated;
grant update (state) on public.bus_checkins to authenticated;

-- 'at' is when the state last changed. A flip stamps the database's clock;
-- an update that changes nothing keeps the old time, so "on the bus since"
-- does not wobble when a phone saves the same state twice.
create or replace function public.bus_checkin_stamp()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- (the INSERT case stands alone: OLD does not exist on an insert)
  if tg_op = 'INSERT' then
    new.at := now();
  elsif new.state is distinct from old.state then
    new.at := now();
  else
    new.at := old.at;
  end if;
  return new;
end $$;
revoke all on function public.bus_checkin_stamp() from public, anon, authenticated;

drop trigger if exists bus_checkins_stamp on public.bus_checkins;
create trigger bus_checkins_stamp before insert or update on public.bus_checkins
  for each row execute function public.bus_checkin_stamp();

-- 3. Everyone is alerted: a check-in written or flipped pokes every phone on
-- the tour (the 0144 row that says nothing but "look again" and a word,
-- here 'bus'), so open phones read the bus list again as it happens. It
-- never raises: a poke must never be the reason a check-in fails. A save
-- that changed nothing pokes nobody.
create or replace function public.poke_on_bus()
returns trigger
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  begin
    if tg_op = 'UPDATE' and new.state is not distinct from old.state and new.at is not distinct from old.at then
      return null;
    end if;
    for u in
      select t.owner_id from tours t where t.id = new.tour_id
      union
      select m.user_id from members m where m.tour_id = new.tour_id and m.user_id is not null
    loop
      perform public.poke(u, 'bus');
    end loop;
  exception when others then
    raise log 'poke_on_bus: % (%)', tg_op, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.poke_on_bus() from public, anon, authenticated;

drop trigger if exists bus_checkins_poke on public.bus_checkins;
create trigger bus_checkins_poke after insert or update on public.bus_checkins
  for each row execute function public.poke_on_bus();

-- (bus_checkins is deliberately NOT added to the supabase_realtime
-- publication: the pokes table carries the live line, as 0144 set it up,
-- and the publication stays exactly as it is.)

-- Tidy-up: rows older than 60 days are only history the Tours pages never
-- read, and may go. There is no nightly cleanup job in the house today (the
-- scheduled jobs sync feeds and recount pages; none of them sweeps old rows),
-- so per the spec nothing is scheduled here. When a nightly sweep exists one
-- day, this is its line:
--   delete from public.bus_checkins where day < current_date - 60;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop trigger if exists bus_checkins_poke on public.bus_checkins;
--   drop trigger if exists bus_checkins_stamp on public.bus_checkins;
--   drop function if exists public.poke_on_bus();
--   drop function if exists public.bus_checkin_stamp();
--   drop table if exists public.bus_checkins;
--   alter table public.members drop column if exists rides_bus;
--   notify pgrst, 'reload schema';
-- A phone on a build that shows the bus button simply finds no rows and no
-- column; nothing else leans on either.
