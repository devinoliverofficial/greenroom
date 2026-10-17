-- The BUYOUT ALERT, defined (Devin, 2026-10-17): "I think the moment the
-- buyout is logged in until it's tracked it show glow green in everyone's
-- buyout tab. It stops glowing when it has been given and tracked to that
-- person. But it glows for everyone else who didn't get tracked. The only
-- person who sees the track in the buyout alert button is the tour manager
-- (including me. I don't want to see the track I want to see my own buyout
-- status.). In the buyout alert button you can ping the TM to get you your
-- buyout."
--
-- And later the same day, the button moved to the Today tab and became
-- "Buyout": "Everyday this button is automatically glowing. This button is
-- glowing for everyone until they are marked as received ... if a
-- crew/member doesn't receive a buyout that button glows and when they
-- click it that can see the dates they haven't received a buyout and next
-- to the date can click (bump) which prompts a slash effect to the tour
-- manager only that says give X their buyout." So a buyout day no longer
-- waits on a buyout amount being logged: every show day from the fresh
-- start (2026-10-16) through today is one, for everyone on the tour, until
-- the Tour Manager marks them received.
--
-- The glow, the two views and the splash are the app's. This file holds
-- what the database must:
--
--   1. buyout_trackers: who keeps the track. The accounts that can write
--      ticks (the tour's creator, or a Manager: money_lead's own people)
--      whose job title says Tour manager, in any of the places a title is
--      kept (the crew list's edit, the seat's invite, their own card) and as
--      any one of up to six comma-separated roles. Nobody titled so: the
--      creator and the Managers, as tour_managers says, or nobody could.
--      Service only, like tour_managers: the notify function asks it.
--
--   2. buyout_asks: a bump, "give me my buyout". A row says one thing: this
--      person asked the Tour Manager for their buyout for this show, at this
--      time. No amount, no words. A person writes only their own, only on a
--      tour they are on, only for a show dated from the fresh start
--      (2026-10-16) through today (public.road_today(), never a day still to
--      come), and only while their own tick for it is not in. One an hour
--      per show: a second one inside the hour is quietly not kept. Each one
--      pokes the Tour Manager ('buyout'), so the list shows Bumped by that
--      name and the splash comes up at once; a tick settles the asks it
--      answers.
--
--   3. The ticks the shows already hold for the fresh start's shows (the
--      old tracker's show.buyoutTrack.paid, written by the Today card and
--      Log income's Track) become rows in buyout_tracks, so the glow does
--      not ask for buyouts that were handed out and marked (Houston's four
--      band Members, marked on the show but never in the table). Nothing is
--      guessed: a mark becomes a row only when it names exactly one account
--      on the tour.
--
-- (The crew copy of the tour is not touched: with no amount needed, a crew
-- phone knows a buyout day from the show's date alone.)
--
-- NO MONEY MOVES HERE AND NO AMOUNTS ARE STORED.

-- ---------------------------------------------------------------- 1 ------

create or replace function public.tour_manager_title(v text)
returns boolean
language sql immutable set search_path = public as $$
  select exists (select 1 from unnest(string_to_array(coalesce(v, ''), ',')) r
                  where lower(btrim(r)) = 'tour manager')
$$;

create or replace function public.buyout_trackers(t_id text)
returns setof uuid
language sql stable security definer set search_path = public as $$
  with leads as (
    select t.owner_id as user_id, array[p.tour_role] as titles
      from tours t left join profiles p on p.user_id = t.owner_id
     where t.id = t_id
    union all
    select m.user_id, array[m.tour_role,
                            case when jsonb_typeof(m.overrides) = 'object' then m.overrides ->> 'tourRole' end,
                            p.tour_role]
      from members m left join profiles p on p.user_id = m.user_id
     where m.tour_id = t_id and m.user_id is not null and m.role = 'editor' and m.manager
  ), titled as (
    select distinct l.user_id from leads l
     where l.user_id is not null
       and exists (select 1 from unnest(l.titles) x where public.tour_manager_title(x))
  )
  select user_id from titled
  union
  select l.user_id from leads l
   where l.user_id is not null and not exists (select 1 from titled)
$$;
revoke all on function public.buyout_trackers(text) from public, anon, authenticated;
grant execute on function public.buyout_trackers(text) to service_role;

-- ---------------------------------------------------------------- 2 ------

create table if not exists public.buyout_asks (
  id bigint generated always as identity primary key,
  tour_id text not null references public.tours (id) on delete cascade,
  -- the show's key in the tour document (the same cap as buyout_tracks)
  show_id text not null check (char_length(show_id) between 1 and 80),
  -- the asker. The database fills it in (default, no grant): a bump can
  -- never carry another account's name.
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  asked_at timestamptz not null default now()
);
create index if not exists buyout_asks_ask on public.buyout_asks (tour_id, show_id, user_id, asked_at desc);
create index if not exists buyout_asks_user on public.buyout_asks (user_id);

alter table public.buyout_asks enable row level security;

-- May this account ask, for this show? On the tour (a seat or its
-- creator), the show dated from the fresh start through today (the road's
-- day, public.road_today(): never one still to come), and this account's own
-- tick for it not in. No buyout amount is asked for: every show day is a
-- buyout day. Answers about the caller alone.
create or replace function public.buyout_ask_ok(t_id text, s_id text)
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and (exists (select 1 from members m where m.tour_id = t_id and m.user_id = auth.uid())
          or exists (select 1 from tours t where t.id = t_id and t.owner_id = auth.uid()))
     and exists (
       select 1 from tours t
        cross join lateral (select t.doc -> 'shows' -> s_id as sh) x
        where t.id = t_id
          and jsonb_typeof(x.sh) = 'object'
          and coalesce(x.sh ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
          and x.sh ->> 'date' >= '2026-10-16'
          -- (a day of slack past Los Angeles' date, for a leg in a time zone ahead of it)
          and x.sh ->> 'date' <= to_char(public.road_today() + 1, 'YYYY-MM-DD'))
     and not exists (select 1 from buyout_tracks b
                      where b.tour_id = t_id and b.show_id = s_id and b.user_id = auth.uid())
$$;
revoke all on function public.buyout_ask_ok(text, text) from public, anon;
grant execute on function public.buyout_ask_ok(text, text) to authenticated;

-- Who reads: the asker their own; the tour's Managers all of them (the
-- Tour Manager is one: a tracker is always a creator or a Manager).
drop policy if exists buyout_asks_select on public.buyout_asks;
create policy buyout_asks_select on public.buyout_asks for select
  using (user_id = auth.uid() or public.money_lead(tour_id));

drop policy if exists buyout_asks_insert on public.buyout_asks;
create policy buyout_asks_insert on public.buyout_asks for insert
  with check (user_id = auth.uid() and public.buyout_ask_ok(tour_id, show_id));
-- No update and no delete for anyone: a bump is said, never edited. The
-- tick that answers it settles it (below).

revoke all on public.buyout_asks from public, anon, authenticated;
grant select on public.buyout_asks to authenticated;
grant insert (tour_id, show_id) on public.buyout_asks to authenticated;

-- One an hour per person per show: a second inside the hour is quietly not
-- kept (the phone already says Bumped).
create or replace function public.buyout_asks_once()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from buyout_asks a
              where a.tour_id = new.tour_id and a.show_id = new.show_id and a.user_id = new.user_id
                and a.asked_at > now() - interval '1 hour') then
    return null;
  end if;
  return new;
end $$;
revoke all on function public.buyout_asks_once() from public, anon, authenticated;
drop trigger if exists buyout_asks_once on public.buyout_asks;
create trigger buyout_asks_once before insert on public.buyout_asks
  for each row execute function public.buyout_asks_once();

-- The Tour Manager's list and splash update live: a bump pokes whoever keeps the
-- track with 'buyout' (the 0144 row that says only "look again"). It never
-- raises: a poke must never be the reason a bump fails.
create or replace function public.poke_on_buyout_ask()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.poke(x, 'buyout') from public.buyout_trackers(new.tour_id) x where x <> new.user_id;
  exception when others then
    raise log 'poke_on_buyout_ask: %', sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.poke_on_buyout_ask() from public, anon, authenticated;
drop trigger if exists buyout_asks_poke on public.buyout_asks;
create trigger buyout_asks_poke after insert on public.buyout_asks
  for each row execute function public.poke_on_buyout_ask();

-- A tick answers the bumps it settles. It never raises: a tick must never
-- fail over a bump.
create or replace function public.buyout_asks_settle()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    delete from buyout_asks a
     where a.tour_id = new.tour_id and a.show_id = new.show_id and a.user_id = new.user_id;
  exception when others then
    raise log 'buyout_asks_settle: %', sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.buyout_asks_settle() from public, anon, authenticated;
drop trigger if exists buyout_tracks_settle on public.buyout_tracks;
create trigger buyout_tracks_settle after insert on public.buyout_tracks
  for each row execute function public.buyout_asks_settle();

-- (buyout_asks is deliberately NOT in the supabase_realtime publication:
-- the pokes table carries the live line, as 0144 set it up.)

-- ---------------------------------------------------------------- 3 ------

-- The marks the fresh start's shows already hold become ticks. A paid key
-- is a crew map key (that entry's email, else its name), 'e:' + an email,
-- or 'n:' + a lowercased name; each must name exactly one account on the
-- tour (a seat with an account, or the creator) or nothing is written.
-- A null is a tombstone (someone UNTICKED): skipped. Running it twice adds
-- nothing.
do $$
declare t record; sh record; pk record; v_ent jsonb; v_email text; v_name text; v_uid uuid; v_n int;
begin
  for t in select id, owner_id, doc from tours
            where jsonb_typeof(doc -> 'shows') = 'object'
  loop
    for sh in select e.key as show_id, e.value as show
                from jsonb_each(t.doc -> 'shows') e
               where jsonb_typeof(e.value) = 'object'
                 and coalesce(e.value ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
                 and e.value ->> 'date' >= '2026-10-16'
                 and jsonb_typeof(e.value -> 'buyoutTrack' -> 'paid') = 'object'
    loop
      for pk in select p.key as who from jsonb_each(sh.show -> 'buyoutTrack' -> 'paid') p
                 where jsonb_typeof(p.value) = 'object'
      loop
        v_email := ''; v_name := ''; v_uid := null;
        if pk.who like 'e:%' then
          v_email := lower(btrim(substr(pk.who, 3)));
        elsif pk.who like 'n:%' then
          v_name := lower(btrim(substr(pk.who, 3)));
        else
          v_ent := case when jsonb_typeof(t.doc -> 'crew') = 'object' then t.doc -> 'crew' -> pk.who end;
          if jsonb_typeof(v_ent) = 'object' then
            v_email := lower(btrim(coalesce(v_ent ->> 'email', '')));
            v_name := lower(btrim(coalesce(v_ent ->> 'name', '')));
          end if;
        end if;
        with people as (
          select m.user_id, lower(btrim(coalesce(m.invited_email, ''))) as e1, lower(btrim(coalesce(p.email, ''))) as e2,
                 lower(btrim(coalesce(p.full_name, m.display_name, ''))) as n1, lower(btrim(coalesce(m.display_name, ''))) as n2
            from members m left join profiles p on p.user_id = m.user_id
           where m.tour_id = t.id and m.user_id is not null
          union
          select t.owner_id, '', lower(btrim(coalesce(p.email, ''))), lower(btrim(coalesce(p.full_name, ''))), ''
            from profiles p where p.user_id = t.owner_id
        ), hit as (
          select distinct user_id from people
           where (v_email <> '' and v_email in (e1, e2))
        ), byname as (
          select distinct user_id from people
           where v_name <> '' and v_name in (n1, n2)
        )
        select case when (select count(*) from hit) = 1 then (select user_id from hit)
                    when (select count(*) from hit) = 0 and (select count(*) from byname) = 1 then (select user_id from byname)
               end
          into v_uid;
        continue when v_uid is null;
        insert into buyout_tracks (tour_id, show_id, user_id, tracked_by)
        values (t.id, sh.show_id, v_uid, t.owner_id)
        on conflict do nothing;
      end loop;
    end loop;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop trigger if exists buyout_tracks_settle on public.buyout_tracks;
--   drop function if exists public.buyout_asks_settle();
--   drop table if exists public.buyout_asks;
--   drop function if exists public.poke_on_buyout_ask();
--   drop function if exists public.buyout_asks_once();
--   drop function if exists public.buyout_ask_ok(text, text);
--   drop function if exists public.buyout_trackers(text);
--   drop function if exists public.tour_manager_title(text);
--   notify pgrst, 'reload schema';
-- The ticks written by part 3 stay (each is a mark a show already held);
-- to take exactly those back, delete the buyout_tracks rows of shows dated
-- 2026-10-16 or later that were tracked at the moment this file ran.
