-- Buyouts tracked person by person (Devin, 2026-10-15).
--
-- The buyout button on the Overview lights green the moment a buyout total is
-- logged on a date, and stays lit until every person is marked tracked.
-- Managers mark people tracked; everyone else sees on MY PAY which days they
-- received a buyout and which they did not, under a BUYOUTS tab beside Income
-- and Expenses.
--
-- NO MONEY MOVES HERE AND NO AMOUNTS ARE STORED. The buyout total and its
-- date live in the tour's own document, logged the way all tour money is. A
-- row in this table records one thing only: a Manager says this person
-- received the buyout the tour logged for this show. Taking the row away
-- says the Manager no longer says so. The app does the arithmetic of "every
-- person marked" against the tour document; the database holds the ticks.
--
-- A row holds ids and times and nothing else: no amount, no words, no
-- address. What reaches a phone is "this show, this person, ticked at this
-- time, by this account id".

create table if not exists public.buyout_tracks (
  tour_id text not null references public.tours (id) on delete cascade,
  -- the show's key in the tour document; a key is short, and the cap keeps a
  -- broken phone from writing a novel into it
  show_id text not null check (char_length(show_id) between 1 and 80),
  user_id uuid not null references auth.users (id) on delete cascade,
  tracked_at timestamptz not null default now(),
  -- which Manager said so. The database fills it in (default, no grant), so
  -- a tick can never carry another account's name. If that account is later
  -- deleted the tick still stands: the person did receive their buyout.
  tracked_by uuid default auth.uid() references auth.users (id) on delete set null,
  primary key (tour_id, show_id, user_id)
);
-- MY PAY opens with "my rows, newest first" and account deletion walks by
-- user; both get an index. tracked_by gets one so deleting a Manager's
-- account does not walk the table either.
create index if not exists buyout_tracks_user on public.buyout_tracks (user_id);
create index if not exists buyout_tracks_by on public.buyout_tracks (tracked_by);

alter table public.buyout_tracks enable row level security;

-- Who reads: a person reads their own rows (that is the BUYOUTS tab), and
-- the tour's Managers (its owner, or an editor seat with manager set:
-- money_lead says so in one place, 0132's text) read all rows of their tour
-- (that is the Overview's count toward the light going out).
drop policy if exists buyout_tracks_select on public.buyout_tracks;
create policy buyout_tracks_select on public.buyout_tracks for select
  using (user_id = auth.uid() or public.money_lead(tour_id));

-- Who writes: Managers make a tick and Managers take one away. The person
-- ticked must actually be on the tour (a linked seat, or its owner): a tick
-- is a word about a tour's own person, never a way to write rows - and pokes
-- - at some account that has nothing to do with the tour.
drop policy if exists buyout_tracks_insert on public.buyout_tracks;
create policy buyout_tracks_insert on public.buyout_tracks for insert
  with check (
    public.money_lead(tour_id)
    and (exists (select 1 from members m
                  where m.tour_id = buyout_tracks.tour_id and m.user_id = buyout_tracks.user_id)
         or exists (select 1 from tours t
                     where t.id = buyout_tracks.tour_id and t.owner_id = buyout_tracks.user_id)));
drop policy if exists buyout_tracks_delete on public.buyout_tracks;
create policy buyout_tracks_delete on public.buyout_tracks for delete
  using (public.money_lead(tour_id));
-- No update policy and no update grant: a track is made or removed, never
-- edited. A tick on the wrong show comes off and goes on the right one.

-- Phones supply the three ids; the time and the Manager's id are the
-- database's own defaults.
revoke all on public.buyout_tracks from public, anon, authenticated;
grant select on public.buyout_tracks to authenticated;
grant insert (tour_id, show_id, user_id) on public.buyout_tracks to authenticated;
grant delete on public.buyout_tracks to authenticated;

-- The tracked person's MY PAY updates live: a tick made or taken away pokes
-- them (the 0144 row that says nothing but "look again" and a word, here
-- 'buyout'). The spec asks for the poke on insert; the delete is poked too,
-- because a tick taken away moves a day from "received" back to "not yet"
-- on their BUYOUTS tab, and 0144's rule is that what a phone shows must not
-- wait for a hard close. It never raises: a poke must never be the reason a
-- tick fails.
create or replace function public.poke_on_buyout()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    if tg_op = 'DELETE' then
      perform public.poke(old.user_id, 'buyout');
    else
      perform public.poke(new.user_id, 'buyout');
    end if;
  exception when others then
    raise log 'poke_on_buyout: % (%)', tg_op, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.poke_on_buyout() from public, anon, authenticated;

drop trigger if exists buyout_tracks_poke on public.buyout_tracks;
create trigger buyout_tracks_poke after insert or delete on public.buyout_tracks
  for each row execute function public.poke_on_buyout();

-- (buyout_tracks is deliberately NOT added to the supabase_realtime
-- publication: the pokes table carries the live line, as 0144 set it up,
-- and the publication stays exactly as it is.)

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop trigger if exists buyout_tracks_poke on public.buyout_tracks;
--   drop function if exists public.poke_on_buyout();
--   drop table if exists public.buyout_tracks;
--   notify pgrst, 'reload schema';
-- The ticks are gone with the table; the buyout totals themselves live in
-- the tour documents and are untouched by this file either way.
