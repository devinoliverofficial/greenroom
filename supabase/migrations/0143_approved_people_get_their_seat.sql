-- Approved by the artist: a seat on the artist's tour (Devin, 2026-10-12).
--
-- "i had a crew member log in and make an account ... on the user page in
-- the 'today' tab just like my page it should show everything that pertains
-- to that day if we are on tour. Also none of the tour information registered
-- in the overview that opens the tabs." And: "anytime an artist approves a
-- crew member or a tour that a crew member was apart of this should all show
-- up (minus the stuff we discussed wouldnt show for crew). This goes the same
-- for members"
--
-- What happened: the crew member signed up with a code, asked to be listed
-- under the artist, and the artist said yes. That put them on the artist's
-- page and nowhere else. A tour in the app only shows to the people who have
-- a seat on it (a row in members), and the only way to a seat was a Manager
-- typing the person's email on the tour. So the app had no tour to show them.
--
-- The rule now: when an artist accepts a person's request to be listed, and
-- when an artist confirms the tours a person claimed, that person is given
-- their seat on the artist's tours in the app. Only someone who asked: a seat
-- carries the person's sign-in address, name and phone, which everyone on the
-- tour can read, so a person the artist lists without their asking is seated
-- the ordinary way, by a Manager's invite, and not by this rule.
--   Crew:    a Crew seat (they see Overview, Day sheets, Guest lists, Crew
--            Stats, Chat and their own MY PAY; never the budget: the database
--            hands Crew its own copy of a tour with the money left out) on
--            each tour of the artist that is on now or still to come, and on
--            an older one only when a night of it is among the nights the
--            artist confirmed for them.
--   Members: a Manager seat on every tour of the artist that is not taken
--            down. (His rule of Oct 10: "Members are managers by default".)
-- A seat somebody already has is left exactly as it is: nobody is moved up or
-- down, and nothing is ever taken away here. Someone taken off a tour by a
-- Manager stays off until the artist next accepts or confirms them (sending a
-- claim again, or having the words of their role edited, does not do it).
--
-- An artist's tours: named for the artist, not taken down, not the Off Tour
-- book, and made by the account that runs the artist's page. (That last part
-- matters: a tour somebody else names after an artist must never be handed
-- that artist's people. A tour made by another Member's account is not
-- counted yet either: a page's runner can list an account as a Member without
-- that account asking, so "made by a Member" is not proof enough. People are
-- put on such a tour by its own Managers, as before.)

create or replace function public.artist_tours(a_id uuid)
returns setof public.tours
language sql stable security definer set search_path = public as $$
  select t.*
    from tours t join artists a on a.id = a_id
   where a.owner_id is not null
     and (t.doc ->> 'deletedAt') is null
     and coalesce(t.doc ->> 'kind', '') <> 'offtour'
     and (t.doc ->> 'artistId' = a_id::text
          or (coalesce(t.doc ->> 'artistId', '') = ''
              and btrim(coalesce(t.doc ->> 'artist', '')) <> ''
              and lower(btrim(t.doc ->> 'artist')) = lower(btrim(a.name))))
     and t.owner_id = a.owner_id
$$;
revoke all on function public.artist_tours(uuid) from public, anon, authenticated;

-- Gives one person the seats their listing under one artist earns them.
-- Returns how many seats it made. It only ever adds a seat that is not there.
create or replace function public.seat_from_artist(a_id uuid, u_id uuid)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  l public.artist_members%rowtype;
  em text; nm text; ph text; lvl text; agreed boolean;
  t record; n int := 0;
begin
  -- listed now (someone who left gets nothing new)
  select * into l from artist_members where artist_id = a_id and user_id = u_id and ended_at is null;
  if not found then return 0; end if;
  -- they asked: a request the artist accepted, or tours they claimed that the artist confirmed
  if not exists (select 1 from artist_requests r where r.artist_id = a_id and r.user_id = u_id and r.status = 'accepted')
     and not exists (select 1 from tour_credits c where c.artist_id = a_id and c.user_id = u_id and c.approved is not null) then
    return 0;
  end if;
  -- a real account with a confirmed address
  select lower(u.email) into em from auth.users u where u.id = u_id and u.email_confirmed_at is not null;
  if coalesce(em, '') = '' then return 0; end if;
  select coalesce(btrim(p.full_name), ''), coalesce(p.phone, '') into nm, ph from profiles p where p.user_id = u_id;
  lvl := case when l.kind = 'band' then 'editor' else 'viewer' end;
  -- Someone who has not agreed to the documents yet reads nothing of a tour
  -- (0138). Their seat is made waiting, by address, exactly as a Manager's
  -- invite is, and is linked when they agree (claim_invites).
  agreed := not public.legal_needs(u_id);
  for t in select x.id, x.owner_id, x.doc from public.artist_tours(a_id) x loop
    continue when t.owner_id = u_id;
    -- (the same gate a Manager's invite goes through: people are added to a tour
    -- once Greenroom has confirmed its maker's page; see members_trusted)
    continue when not public.invites_trusted(t.owner_id);
    -- a seat already there, by account or by address: left exactly as it is
    continue when exists (select 1 from members m
                           where m.tour_id = t.id and (m.user_id = u_id or lower(m.invited_email) = em));
    if l.kind <> 'band' then
      -- Crew: the tour that is on now or still to come (a show dated yesterday
      -- or later), or an older tour with a night the artist confirmed for them.
      continue when not exists (
          select 1 from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
           where jsonb_typeof(e.value) = 'object' and (e.value ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
             and (e.value ->> 'date') >= to_char(public.road_today() - 1, 'YYYY-MM-DD'))
        and not exists (
          select 1 from public.credited_shows(u_id) s
           where s.artist_id = a_id
             and to_char(s.d, 'YYYY-MM-DD') in (
                   select e.value ->> 'date'
                     from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
                    where jsonb_typeof(e.value) = 'object'));
    end if;
    -- (One tour's trouble never stops the next: a tour whose page Greenroom has
    -- not confirmed yet refuses new people, and that is not this person's fault.)
    begin
      insert into members (tour_id, invited_email, role, user_id, display_name, phone, tour_role, manager)
      values (t.id, em, lvl, case when agreed then u_id else null end, coalesce(nm, ''), coalesce(ph, ''),
              left(btrim(coalesce(l.role, '')), 40), lvl = 'editor');
      n := n + 1;
    exception when others then
      raise log 'seat_from_artist: no seat on tour % for % (%)', t.id, u_id, sqlerrm;
    end;
  end loop;
  return n;
end $$;
revoke all on function public.seat_from_artist(uuid, uuid) from public, anon, authenticated;

-- The moments an artist approves: a request is accepted, tours are confirmed
-- for a person, and someone already approved is listed afresh or moved
-- between Crew and Member. None of them can be stopped by a seat that would
-- not go in: the listing, the answer and the confirmation always stand.
create or replace function public.seat_on_listing()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- A new listing, a change between Crew and Member, or someone who had left
  -- being listed again. (Not an edit of their role's words: that is not an
  -- approval, and must not put back someone a Manager took off a tour.)
  if new.ended_at is null
     and (tg_op = 'INSERT' or old.kind is distinct from new.kind or old.ended_at is not null) then
    begin
      perform public.seat_from_artist(new.artist_id, new.user_id);
    exception when others then
      raise log 'seat_on_listing: % / % (%)', new.artist_id, new.user_id, sqlerrm;
    end;
  end if;
  return null;
end $$;
revoke all on function public.seat_on_listing() from public, anon, authenticated;

drop trigger if exists artist_members_seat on public.artist_members;
create trigger artist_members_seat after insert or update on public.artist_members
  for each row execute function public.seat_on_listing();

-- A request accepted. (The listing is written just before the request is
-- marked accepted, so this is the moment both are in place.)
create or replace function public.seat_on_request()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'accepted' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    begin
      perform public.seat_from_artist(new.artist_id, new.user_id);
    exception when others then
      raise log 'seat_on_request: % / % (%)', new.artist_id, new.user_id, sqlerrm;
    end;
  end if;
  return null;
end $$;
revoke all on function public.seat_on_request() from public, anon, authenticated;

drop trigger if exists artist_requests_seat on public.artist_requests;
create trigger artist_requests_seat after insert or update on public.artist_requests
  for each row execute function public.seat_on_request();

-- Tours confirmed. Only when what is confirmed has changed: a person sending
-- their claim again writes this row too, and that must not put back a seat a
-- Manager took away.
create or replace function public.seat_on_credit()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.approved is not null and (tg_op = 'INSERT' or new.approved is distinct from old.approved) then
    begin
      perform public.seat_from_artist(new.artist_id, new.user_id);
    exception when others then
      raise log 'seat_on_credit: % / % (%)', new.artist_id, new.user_id, sqlerrm;
    end;
  end if;
  return null;
end $$;
revoke all on function public.seat_on_credit() from public, anon, authenticated;

drop trigger if exists tour_credits_seat on public.tour_credits;
create trigger tour_credits_seat after insert or update on public.tour_credits
  for each row execute function public.seat_on_credit();

-- Everyone an artist has already accepted gets the seat they are owed now.
do $$
declare r record;
begin
  for r in select m.artist_id, m.user_id from artist_members m where m.ended_at is null loop
    perform public.seat_from_artist(r.artist_id, r.user_id);
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop trigger if exists artist_members_seat on public.artist_members;
--   drop trigger if exists tour_credits_seat on public.tour_credits;
--   drop trigger if exists artist_requests_seat on public.artist_requests;
--   drop function if exists public.seat_on_request();
--   drop function if exists public.seat_on_listing();
--   drop function if exists public.seat_on_credit();
--   drop function if exists public.seat_from_artist(uuid, uuid);
--   drop function if exists public.artist_tours(uuid);
--   notify pgrst, 'reload schema';
-- The seats it made stay (they are ordinary seats): a Manager takes someone
-- off a tour from its Crew list.
