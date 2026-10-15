-- A page nobody runs takes its crew; festivals are their own thing (Devin, 2026-10-15).
--
-- Two things he said:
--   1. "By default if no one has "claimed" an artist page the request by crew
--      should be accepted until someone claims a page. When the page is
--      claimed by that artist they should be prompted with all the people who
--      have requests to be crew as well as tours."
--   2. "I think Festivals should be listed as their own separate thing when
--      on the analytics not as apart of a tour."
--
-- What changes here:
--   1. Asking to be listed as crew on a page nobody runs lists you at once, as
--      if the page had said yes (listed and endorsed, the way an accepted
--      request is: artist_list_endorsed). A Member's ask on such a page still
--      waits: a Member is one of the owners of the artist, and that is what
--      claiming the page is for. Tours claimed on a page nobody runs are
--      confirmed at once the same way. Each of these is written down in a
--      table of its own (unclaimed_joins) that no phone can write or read.
--   2. The crew asks already waiting on pages nobody runs are accepted now,
--      by that same rule, and written down the same way.
--   3. Whoever the page goes to (by an approved claim, or by any other road
--      that gives a page its owner) finds those people waiting on their phone,
--      each with their roles and the tours they confirmed: "Keep" (the
--      listing and the tours stand) or "Take off" (the tours are taken back
--      as the page's own "revoke" does, the endorsement is taken off, and the
--      listing ends the way the page taking someone off does). A Greenroom
--      admin approving a claim answers for nobody: it is the new owner's to do.
--   4. A festival night is never put under a tour by the app any more
--      (tour_own_nights). The festival nights it did put under a tour go back
--      to no tour, their festival kept, written as settled nights, and the
--      page is counted again. What an artist had confirmed (or what was
--      waiting) that reached those nights keeps them: each moves out of the
--      tour's pick into a pick of its own, so nobody's shows go down.
--   5. A crew person's profile names the festivals an artist confirmed for
--      them, each on its own with its role, as a Member's list already does.
--
-- Nothing here changes how a night is counted. credit_covers, credit_counts,
-- credited_shows and road_stats are not touched.


-- ====================== 1. Who joined while nobody ran the page ======================

-- One row for each person a page took in while nobody ran it, kept until the
-- account that then runs the page has answered for them. listed: their listing
-- came in that way (false: only tours were confirmed that way, for someone the
-- page had listed before). Written only by the functions below.
create table if not exists public.unclaimed_joins (
  artist_id uuid not null references public.artists (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  listed boolean not null default false,
  at timestamptz not null default now(),
  primary key (artist_id, user_id)
);
create index if not exists unclaimed_joins_user on public.unclaimed_joins (user_id);
alter table public.unclaimed_joins enable row level security;
revoke all on public.unclaimed_joins from public, anon, authenticated;

-- Asking an artist to list you: the text 0146 left, with one branch more. Crew
-- asking a page nobody runs are listed at once, endorsed by nobody in
-- particular (by_whom null), the ask marked accepted with nobody's name on the
-- yes, and the person written down for whoever claims the page.
CREATE OR REPLACE FUNCTION public.request_artist(a_id uuid, k text, r text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare me uuid := auth.uid(); m public.artist_members%rowtype; q public.artist_requests%rowtype; rr text := left(btrim(coalesce(r, '')), 160);
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  if k is null or k not in ('band', 'crew') then raise exception 'kind' using errcode = '22023'; end if;
  if not exists (select 1 from artists a where a.id = a_id) then raise exception 'no artist' using errcode = '22023'; end if;
  select * into m from artist_members where artist_id = a_id and user_id = me;
  if found and m.ended_at is null then return jsonb_build_object('ok', false, 'why', 'listed'); end if;
  if found and m.kind = 'band' and k = 'crew' then return jsonb_build_object('ok', false, 'why', 'former_member'); end if;
  select * into q from artist_requests where artist_id = a_id and user_id = me;
  if found and q.status = 'declined' and q.decided_at > now() - interval '7 days' then
    return jsonb_build_object('ok', false, 'why', 'wait');
  end if;
  if (select count(*) from artist_requests x where x.user_id = me and x.status = 'pending' and x.artist_id <> a_id) >= 10 then
    return jsonb_build_object('ok', false, 'why', 'many');
  end if;
  -- The account that runs the page asking for itself: there is nobody else to ask.
  if public.runs_artist(a_id) then
    perform public.artist_list_endorsed(a_id, me, k, rr, me);
    insert into artist_requests (artist_id, user_id, kind, role, status, decided_at, decided_by)
    values (a_id, me, k, rr, 'accepted', now(), me)
    on conflict (artist_id, user_id) do update
      set kind = excluded.kind, role = excluded.role, status = 'accepted', decided_at = now(), decided_by = excluded.decided_by;
    return jsonb_build_object('ok', true, 'listed', true);
  end if;
  -- Crew asking a page nobody runs: there is nobody to ask yet, so they are
  -- listed now, and whoever claims the page keeps them or takes them off.
  if k = 'crew' and exists (select 1 from artists a where a.id = a_id and a.owner_id is null) then
    perform public.artist_list_endorsed(a_id, me, k, rr, null);
    insert into artist_requests (artist_id, user_id, kind, role, status, decided_at, decided_by)
    values (a_id, me, k, rr, 'accepted', now(), null)
    on conflict (artist_id, user_id) do update
      set kind = excluded.kind, role = excluded.role, status = 'accepted', decided_at = now(), decided_by = null;
    insert into unclaimed_joins (artist_id, user_id, listed) values (a_id, me, true)
    on conflict (artist_id, user_id) do update set listed = true, at = now();
    return jsonb_build_object('ok', true, 'listed', true, 'unclaimed', true);
  end if;
  insert into artist_requests (artist_id, user_id, kind, role) values (a_id, me, k, rr)
  on conflict (artist_id, user_id) do update
    set kind = excluded.kind, role = excluded.role, status = 'pending', created_at = now(), decided_at = null, decided_by = null;
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.request_artist(uuid, text, text) from public, anon;
grant execute on function public.request_artist(uuid, text, text) to authenticated, service_role;

-- Sending a claim of tours: the live text (as read after 0145; 0146 did not
-- touch it), with one change. On a page nobody runs, a claim from someone the
-- page does not list as a Member is confirmed at once, as it is for the page's
-- own runner, and written down for whoever claims the page. ("auto" says it was
-- confirmed; "unclaimed" says why.) add_tour_credit ("I was on this tour") ends
-- here too, so it is covered by the same change.
CREATE OR REPLACE FUNCTION public.submit_tour_credits(a_id uuid, claim jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare me uuid := auth.uid(); norm jsonb; own boolean; v_free boolean;
begin
  if me is null or not exists (select 1 from artist_endorsements e
       where e.artist_id = a_id and e.user_id = me and e.removed_at is null) then
    raise exception 'permission' using errcode = '42501';
  end if;
  if not exists (select 1 from artist_history_shows h where h.artist_id = a_id) then
    raise exception 'no history' using errcode = '22023';
  end if;
  norm := public.credit_normalize(a_id, claim);
  own := public.runs_artist(a_id);
  -- nobody runs the page, and the person is not one of its Members
  v_free := not own
          and exists (select 1 from artists a where a.id = a_id and a.owner_id is null)
          and not exists (select 1 from artist_members b where b.artist_id = a_id and b.user_id = me and b.kind = 'band')
          -- (Tours one by one go on at once. ALL TOURS, an act's whole history in one tap, waits for whoever
          -- claims the page, as a Member's ask does: otherwise anyone could give themselves an act's whole record.)
          and coalesce(norm ->> 'all', '') <> 'true';
  insert into tour_credits (artist_id, user_id, approved, pending, declined, submitted_at, decided_at, declined_at)
  values (a_id, me, case when own or v_free then norm end, case when own or v_free then null else norm end, null, now(),
          case when own or v_free then now() end, null)
  on conflict (artist_id, user_id) do update
    set approved = case when own or v_free then norm else tour_credits.approved end,
        pending = case when own or v_free then null else norm end,
        declined = null,
        submitted_at = now(),
        decided_at = case when own or v_free then now() else tour_credits.decided_at end,
        declined_at = null;
  if v_free then
    insert into unclaimed_joins (artist_id, user_id, listed) values (a_id, me, false)
    on conflict (artist_id, user_id) do nothing;
  end if;
  return jsonb_build_object('ok', true, 'auto', own or v_free, 'unclaimed', v_free);
end $function$;
revoke all on function public.submit_tour_credits(uuid, jsonb) from public, anon;
grant execute on function public.submit_tour_credits(uuid, jsonb) to authenticated, service_role;

-- The people a page took in while nobody ran it, for the account that runs it
-- now: one page (a_id), or every page it runs (null). Each with the roles on
-- their listing and the tours they have confirmed there, tour by tour, as the
-- page's own review lists them (credit_expand), and the count. The account
-- itself is never asked about. Someone who has nothing from the page any more
-- (they left and took their endorsement and tours off) is not shown.
create or replace function public.unclaimed_join_queue(a_id uuid default null)
returns jsonb
language sql stable security definer set search_path = public as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'artistId', a.id, 'artist', a.name, 'userId', j.user_id, 'name', public.person_name(j.user_id),
      'handle', coalesce(p.handle, ''), 'avatar', coalesce(p.avatar, ''),
      'kind', coalesce(m.kind, 'crew'), 'role', coalesce(m.role, ''),
      'listed', j.listed, 'onPage', m.user_id is not null, 'at', j.at,
      'list', case when c.approved is not null
                   then public.credit_expand(a.id, public.credit_claim_live(a.id, j.user_id, c.approved)) else '[]'::jsonb end)
      || case when c.approved is not null then public.credit_counts(a.id, public.credit_claim_live(a.id, j.user_id, c.approved))
              else jsonb_build_object('tours', 0, 'shows', 0) end
      order by j.at), '[]'::jsonb)
    from unclaimed_joins j
    join artists a on a.id = j.artist_id
    left join artist_members m on m.artist_id = j.artist_id and m.user_id = j.user_id and m.ended_at is null
    left join tour_credits c on c.artist_id = j.artist_id and c.user_id = j.user_id
    left join profiles p on p.user_id = j.user_id
   where auth.uid() is not null and a.owner_id = auth.uid() and (a_id is null or a.id = a_id)
     and j.user_id <> a.owner_id
     -- (made a Member since: the page has answered for them)
     and coalesce(m.kind, 'crew') <> 'band'
     and (m.user_id is not null or c.approved is not null
          or exists (select 1 from artist_endorsements e
                      where e.artist_id = j.artist_id and e.user_id = j.user_id and e.removed_at is null))
$function$;
revoke all on function public.unclaimed_join_queue(uuid) from public, anon;
grant execute on function public.unclaimed_join_queue(uuid) to authenticated;

-- The page's answer for one of them. Only the account that runs the page.
--   keep: the listing and the tours stand; the note goes. It is the artist's
--         yes, so the seat it earns on the page's tours follows (0143), and
--         the person's phone is told.
--   take off: the tours they confirmed there are taken back (decide_tour_credits'
--         'revoke'); and when their listing came in while nobody ran the page,
--         a claim still waiting is sent back (its 'decline'), the endorsement
--         is taken off, the listing ends (end_artist_member: crew with no
--         endorsement leave nothing behind) and their ask reads declined. The
--         triggers on those tables tell the person's phone.
-- Answers { ok, kept }, or { ok: false, why: 'gone' } when there is nothing to answer.
create or replace function public.answer_unclaimed_join(a_id uuid, u_id uuid, keep boolean)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare v_me uuid := auth.uid(); j public.unclaimed_joins%rowtype;
begin
  if v_me is null or not public.runs_artist(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  select * into j from unclaimed_joins where artist_id = a_id and user_id = u_id for update;
  if not found then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  -- made a Member since (by the page): that was the page's answer
  if coalesce(keep, false) or exists (select 1 from artist_members m
       where m.artist_id = a_id and m.user_id = u_id and m.kind = 'band' and m.ended_at is null) then
    delete from unclaimed_joins where artist_id = a_id and user_id = u_id;
    begin
      perform public.seat_from_artist(a_id, u_id);
    exception when others then
      raise log 'answer_unclaimed_join: seat % / % (%)', a_id, u_id, sqlerrm;
    end;
    perform public.poke(u_id, 'listing');
    return jsonb_build_object('ok', true, 'kept', true);
  end if;
  update tour_credits set approved = null, decided_at = now()
   where artist_id = a_id and user_id = u_id and approved is not null;
  if j.listed then
    update tour_credits set declined = pending, pending = null, decided_at = now(), declined_at = now()
     where artist_id = a_id and user_id = u_id and pending is not null;
    -- (The endorsement came with the listing and nobody gave it: it goes. removed_at would say the person
    -- took it off themselves, and the page would then never offer to endorse them again.)
    delete from artist_endorsements where artist_id = a_id and user_id = u_id and endorsed_by is null;
    update artist_endorsements set removed_at = now()
     where artist_id = a_id and user_id = u_id and removed_at is null;
    perform public.end_artist_member(a_id, u_id, null);
    update artist_requests set status = 'declined', decided_at = now(), decided_by = v_me
     where artist_id = a_id and user_id = u_id and status = 'accepted';
  end if;
  delete from unclaimed_joins where artist_id = a_id and user_id = u_id;
  return jsonb_build_object('ok', true, 'kept', false);
end $function$;
revoke all on function public.answer_unclaimed_join(uuid, uuid, boolean) from public, anon;
grant execute on function public.answer_unclaimed_join(uuid, uuid, boolean) to authenticated;

-- The moment a page gets an owner, by whatever road (decide_claim, or any
-- other that writes artists.owner_id): the owner is never asked about
-- themself, and their phone is told there are people to answer for. Never the
-- reason a page cannot be handed over.
create or replace function public.joined_on_claim()
returns trigger
language plpgsql security definer set search_path = public as $function$
begin
  begin
    if new.owner_id is not null and new.owner_id is distinct from old.owner_id then
      delete from unclaimed_joins where artist_id = new.id and user_id = new.owner_id;
      if exists (select 1 from unclaimed_joins j where j.artist_id = new.id) then
        perform public.poke(new.owner_id, 'joined');
      end if;
    end if;
  exception when others then
    raise log 'joined_on_claim: % (%)', new.id, sqlerrm;
  end;
  return null;
end $function$;
revoke all on function public.joined_on_claim() from public, anon, authenticated;

drop trigger if exists artists_joined_on_claim on public.artists;
create trigger artists_joined_on_claim after update of owner_id on public.artists
  for each row execute function public.joined_on_claim();

-- The crew asks already waiting on pages nobody runs: accepted now, by the
-- rule above. (Someone who left such a page as a Member cannot come back as
-- crew yet: their ask is left as it is, as request_artist would refuse it.)
do $$
declare x record;
begin
  for x in select r.artist_id, r.user_id, r.role
             from artist_requests r join artists a on a.id = r.artist_id
            where r.status = 'pending' and r.kind = 'crew' and a.owner_id is null
              and not exists (select 1 from artist_members m
                               where m.artist_id = r.artist_id and m.user_id = r.user_id and m.kind = 'band')
  loop
    perform public.artist_list_endorsed(x.artist_id, x.user_id, 'crew', x.role, null);
    update artist_requests set status = 'accepted', decided_at = now(), decided_by = null
     where artist_id = x.artist_id and user_id = x.user_id;
    insert into unclaimed_joins (artist_id, user_id, listed) values (x.artist_id, x.user_id, true)
    on conflict (artist_id, user_id) do update set listed = true;
  end loop;
end $$;


-- ====================== 2. Festivals on their own ======================

-- tour_own_nights, as 0145 made it (no live text was read for it), with one
-- change: a night that carries a festival's name is left alone. The band's own
-- tour still says which plain nights are the run; a festival day in the middle
-- of it stays the festival's. A touring festival names every stop after itself
-- ("<Tour> 2026" on a night of <Tour>): that name is the tour's own, not another
-- festival's, so those nights are still the run (festival_key: the name without
-- its year).
create or replace function public.tour_own_nights(a_id uuid)
returns integer
language plpgsql volatile security definer set search_path = public as $function$
declare t record; nm text; n_top int; n_all int; k int; made int := 0;
begin
  for t in select x.id, x.doc from public.artist_tours(a_id) x loop
    select count(*) into n_all
      from artist_history_shows h
     where h.artist_id = a_id
       and to_char(h.date, 'YYYY-MM-DD') in (
             select e.value ->> 'date'
               from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
              where jsonb_typeof(e.value) = 'object' and (e.value ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$');
    continue when n_all = 0;
    select h.tour, count(*) into nm, n_top
      from artist_history_shows h
     where h.artist_id = a_id and h.tour <> ''
       and to_char(h.date, 'YYYY-MM-DD') in (
             select e.value ->> 'date'
               from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
              where jsonb_typeof(e.value) = 'object' and (e.value ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$')
     group by h.tour order by count(*) desc, h.tour limit 1;
    -- (the archive has to know the run by one name already, on at least half of these dates)
    continue when nm is null or n_top * 2 < n_all;
    -- settled, so a fresh read does not blank them again (the rest of the row stays)
    -- (never a festival's night: a festival is its own thing, not a night of the tour)
    insert into artist_night_overrides (artist_id, date, tour, gone)
    select a_id, h.date, nm, false
      from artist_history_shows h
     where h.artist_id = a_id and h.tour = ''
       and not exists (select 1 from artist_history_shows f where f.artist_id = a_id and f.date = h.date and f.festival <> ''
                         and public.festival_key(f.festival) <> public.festival_key(nm))
       and to_char(h.date, 'YYYY-MM-DD') in (
             select e.value ->> 'date'
               from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
              where jsonb_typeof(e.value) = 'object' and (e.value ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$')
     group by h.date
    on conflict (artist_id, date) do update set tour = excluded.tour, set_at = now();
    update artist_history_shows h set tour = nm, named_by = null
     where h.artist_id = a_id and h.tour = ''
       and not exists (select 1 from artist_history_shows f where f.artist_id = a_id and f.date = h.date and f.festival <> ''
                         and public.festival_key(f.festival) <> public.festival_key(nm))
       and to_char(h.date, 'YYYY-MM-DD') in (
             select e.value ->> 'date'
               from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
              where jsonb_typeof(e.value) = 'object' and (e.value ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$');
    get diagnostics k = row_count;
    made := made + k;
  end loop;
  return made;
end $function$;
revoke all on function public.tour_own_nights(uuid) from public, anon, authenticated;

-- The festival nights the app put under a tour go back to no tour. By rule,
-- what tour_own_nights did: a night that carries a festival's name (not the
-- tour's own name, year aside), sits on a date of one of the band's own tours
-- in the app, and is under a tour only because a settled night says so (its
-- override names that same tour). Its
-- festival is kept, and it is settled under no tour, so a fresh read does not
-- put it back. Nights with no festival's name are not touched.
--
-- A claim that reached one of these nights (confirmed, or waiting) keeps it:
-- the night moves out of the tour's pick, by id, into the pick of the key it
-- has now (the year's shows outside a tour), with the role the tour's pick
-- had. So the people who had it confirmed still have it, and the tour's pick
-- no longer holds a festival. (The seat trigger of 0143 is held off while this
-- is written: a claim tidied here is not the artist confirming anything, and
-- must not put back a seat a Manager took away.)
do $$
declare
  c record; f record; w text; v_claim jsonb; v_live jsonb; v_picks jsonb; v_had jsonb; v_role text; v_moved boolean;
  a record;
begin
  create temp table fest_back on commit drop as
  select h.artist_id, h.id, h.date, h.festival, h.tkey as old_key, public.credit_show_key('', h.date) as new_key
    from artist_history_shows h
    join artist_night_overrides o on o.artist_id = h.artist_id and o.date = h.date
   where h.festival <> '' and h.tour <> '' and not o.gone and o.tour = h.tour
     and public.festival_key(h.festival) <> public.festival_key(h.tour)
     and exists (select 1 from public.artist_tours(h.artist_id) t
                  cross join lateral jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
                  where jsonb_typeof(e.value) = 'object' and (e.value ->> 'date') = to_char(h.date, 'YYYY-MM-DD'));

  if not exists (select 1 from fest_back) then return; end if;

  alter table public.tour_credits disable trigger tour_credits_seat;
  for c in select t.artist_id, t.user_id, t.approved, t.pending from tour_credits t
            where t.artist_id in (select distinct b.artist_id from fest_back b)
              and (t.approved is not null or t.pending is not null)
  loop
    foreach w in array array['approved', 'pending'] loop
      v_claim := case w when 'approved' then c.approved else c.pending end;
      -- (ALL TOURS covers every night wherever it sits: nothing to move)
      continue when v_claim is null or coalesce(v_claim ->> 'all', '') = 'true'
                 or jsonb_typeof(v_claim -> 'picks') is distinct from 'array';
      v_live := public.credit_claim_live(c.artist_id, c.user_id, v_claim);
      v_picks := v_claim -> 'picks';
      v_moved := false;
      for f in select b.* from fest_back b
                where b.artist_id = c.artist_id and public.credit_covers(v_live, b.id, b.date, b.old_key)
                order by b.date, b.id
      loop
        v_moved := true;
        v_role := public.credit_role(v_claim, f.old_key);
        -- out of every other pick that lists it (a pick of single shows left empty goes)
        select coalesce(jsonb_agg(q.p order by q.o), '[]'::jsonb) into v_picks
          from (select x.o,
                       case when x.p ->> 'key' is distinct from f.new_key and jsonb_typeof(x.p -> 'shows') = 'array'
                            then jsonb_set(x.p, '{shows}', coalesce((select jsonb_agg(s.v order by s.i)
                                                                       from jsonb_array_elements(x.p -> 'shows') with ordinality s(v, i)
                                                                      where s.v <> to_jsonb(f.id)), '[]'::jsonb))
                            else x.p end as p
                  from jsonb_array_elements(v_picks) with ordinality x(p, o)) q
         where not (coalesce(q.p ->> 'mode', '') = 'shows' and coalesce(jsonb_typeof(q.p -> 'shows'), '') = 'array'
                    and jsonb_array_length(case when jsonb_typeof(q.p -> 'shows') = 'array' then q.p -> 'shows' else '[1]'::jsonb end) = 0
                    and q.p ->> 'key' is distinct from f.new_key);
        -- into the pick of its own key, with the role
        v_had := null;
        select x.p into v_had from jsonb_array_elements(v_picks) x(p) where x.p ->> 'key' = f.new_key limit 1;
        if v_had is null then
          v_picks := v_picks || jsonb_build_array(jsonb_build_object('key', f.new_key, 'mode', 'shows', 'shows', jsonb_build_array(f.id))
                       || case when v_role <> '' then jsonb_build_object('role', v_role) else '{}'::jsonb end);
        else
          select coalesce(jsonb_agg(x.p order by x.o), '[]'::jsonb) into v_picks
            from jsonb_array_elements(v_picks) with ordinality x(p, o)
           where x.p ->> 'key' is distinct from f.new_key;
          v_picks := v_picks || jsonb_build_array((v_had - 'shows' - 'role')
                       || jsonb_build_object('shows', (select jsonb_agg(distinct u.id)
                                                         from (select jsonb_array_elements_text(
                                                                        case when jsonb_typeof(v_had -> 'shows') = 'array' then v_had -> 'shows' else '[]'::jsonb end) as id
                                                               union all select f.id) u))
                       || case when public.credit_role_join(v_had ->> 'role', v_role) <> ''
                               then jsonb_build_object('role', public.credit_role_join(v_had ->> 'role', v_role)) else '{}'::jsonb end);
        end if;
      end loop;
      continue when not v_moved;
      if w = 'approved' then
        update tour_credits set approved = jsonb_set(v_claim, '{picks}', v_picks) where artist_id = c.artist_id and user_id = c.user_id;
      else
        update tour_credits set pending = jsonb_set(v_claim, '{picks}', v_picks) where artist_id = c.artist_id and user_id = c.user_id;
      end if;
    end loop;
  end loop;
  alter table public.tour_credits enable trigger tour_credits_seat;

  insert into artist_night_overrides (artist_id, date, tour, festival, gone)
  select distinct on (b.artist_id, b.date) b.artist_id, b.date, '', b.festival, false
    from fest_back b order by b.artist_id, b.date, b.id
  on conflict (artist_id, date) do update
    set tour = '', festival = coalesce(nullif(artist_night_overrides.festival, ''), excluded.festival), set_at = now();
  update artist_history_shows h set tour = '', named_by = null
    from fest_back b where h.artist_id = b.artist_id and h.id = b.id;
  -- (PIPELINE.md section 8: a change to nights ends with a count)
  for a in select distinct b.artist_id from fest_back b loop
    perform public.setlist_summarize(a.artist_id);
  end loop;
end $$;

-- A person's profile card: the text 0146 left, with one arm more in its list
-- of tours (creditTours). Crew get the festivals an artist confirmed for them
-- by name, each on its own ('kind' 'festival', as a Member's list has them),
-- with the role said for it: the nights they have that sit under no tour and
-- carry a festival's name. The tours arm is as it was (nights under a tour
-- name), so a festival is never one of their tours, here or in the Tours count
-- (road_stats counts tours from nights under a tour name, and is not touched).
CREATE OR REPLACE FUNCTION public.profile_card(u uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p public.profiles%rowtype;
begin
  if not public.can_see_profile(u) then return null; end if;
  select * into p from profiles where user_id = u;
  return jsonb_build_object(
    'userId', u,
    'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
    'handle', coalesce(p.handle, ''),
    'verified', exists (select 1 from verified_users v where v.user_id = u),
    'bio', coalesce(p.bio, ''),
    'roles', to_jsonb(coalesce(p.roles, '{}'::text[])),
    'tourRole', coalesce(p.tour_role, ''),
    'avatar', coalesce(p.avatar, ''),
    'artists', to_jsonb(coalesce(p.artists, '{}'::text[])),
    -- The artist profiles that list them as a member or crew: the artist's own
    -- word for it. Then any artist that endorsed them and no longer lists
    -- them (they left or were let go, or the page is gone): the endorsement
    -- still stands, and so does everything up to the day they left.
    'acts', coalesce((
      select jsonb_agg(x.j order by x.at) from (
        select jsonb_build_object('id', a.id, 'name', a.name, 'handle', a.handle, 'avatar', a.avatar, 'kind', m.kind, 'role', coalesce(m.role, ''),
                 'endorsed', e.id is not null,
                 -- Yours to remove, so your own page gets which one it is.
                 'eid', case when u = auth.uid() then e.id end,
                 -- For the account that runs this artist: it's theirs to endorse from,
                 -- unless this person took its endorsement off before.
                 'mine', a.owner_id = auth.uid(),
                 'declined', a.owner_id = auth.uid() and exists (select 1 from artist_endorsements d
                    where d.artist_id = a.id and d.user_id = u and d.removed_at is not null)) as j,
               m.created_at as at
          from artist_members m join artists a on a.id = m.artist_id
          left join artist_endorsements e on e.artist_id = a.id and e.user_id = u and e.removed_at is null
                and not exists (select 1 from unclaimed_joins uj where uj.artist_id = a.id and uj.user_id = u and uj.listed)
         where m.user_id = u and m.ended_at is null
        union all
        select jsonb_build_object('id', a.id, 'name', coalesce(a.name, nullif(e.artist_name, ''), 'An artist'),
                 'handle', coalesce(a.handle, e.artist_handle), 'avatar', coalesce(a.avatar, ''),
                 -- (what they were when they left, if the page ended the listing; else what they were when endorsed)
                 'kind', coalesce((select m.kind from artist_members m where m.artist_id = e.artist_id and m.user_id = u), e.kind),
                 'role', coalesce(e.role, ''),
                 'endorsed', true, 'past', true, 'eid', case when u = auth.uid() then e.id end,
                 -- the day they stopped being listed, when the page ended it (null: never listed, or the listing is gone)
                 'until', (select to_char(m.ended_at, 'YYYY-MM-DD') from artist_members m where m.artist_id = e.artist_id and m.user_id = u)),
               e.created_at
          from artist_endorsements e left join artists a on a.id = e.artist_id
         where e.user_id = u and e.removed_at is null
           and not exists (select 1 from artist_members m where m.artist_id = e.artist_id and m.user_id = u and m.ended_at is null)
        union all
        -- An artist they left that had not endorsed them: it still shows, as past.
        select jsonb_build_object('id', a.id, 'name', a.name, 'handle', a.handle, 'avatar', a.avatar, 'kind', m.kind, 'role', coalesce(m.role, ''),
                 'endorsed', false, 'past', true, 'until', to_char(m.ended_at, 'YYYY-MM-DD')),
               m.created_at
          from artist_members m join artists a on a.id = m.artist_id
         where m.user_id = u and m.ended_at is not null
           and not exists (select 1 from artist_endorsements e
                            where e.artist_id = m.artist_id and e.user_id = u and e.removed_at is null)) x), '[]'::jsonb),
    -- Their flowers and the artists who endorsed them, for anyone who can see their page.
    'flowers', (public.flower_counts(u) ->> 'flowers')::int,
    'endorsements', (public.flower_counts(u) ->> 'endorsements')::int,
    -- The flowers they've been given, newest first, for their Stats tab: who
    -- (while you can see that person's profile), what for, when, the note.
    'gotFlowers', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', f.id, 'n', f.n, 'note', f.note, 'at', f.created_at, 'category', coalesce(f.category, ''),
          'from', case when public.can_see_profile(f.from_id) then f.from_id end,
          'name', case when public.can_see_profile(f.from_id) then public.person_name(f.from_id) else '' end,
          'avatar', case when public.can_see_profile(f.from_id) then coalesce(fp.avatar, '') else '' end)
        order by f.created_at desc)
      from (select x.* from flowers x join tours y on y.id = x.tour_id
             where x.to_id = u and coalesce(y.doc ->> 'kind', '') <> 'offtour' and (y.doc ->> 'deletedAt') is null
             order by x.created_at desc limit 100) f
      left join profiles fp on fp.user_id = f.from_id), '[]'::jsonb),
    'followers', (select count(*) from follows f where f.followee_id = u),
    'following', (select count(*) from follows f where f.follower_id = u),
    'iFollow', exists (select 1 from follows f where f.follower_id = auth.uid() and f.followee_id = u),
    'followsMe', exists (select 1 from follows f where f.follower_id = u and f.followee_id = auth.uid()),
    'tours', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', t.id,
          'artist', trim(coalesce(t.doc ->> 'artist', '')),
          'name', trim(coalesce(t.doc ->> 'name', '')),
          'first', (select min(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x),
          'last', (select max(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x),
          'shows', jsonb_array_length(public.tour_dates(t.doc)),
          'mine', public.my_role(t.id) is not null)
        order by (select max(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x) desc nulls last, t.id)
      from public.tours_of(u) t), '[]'::jsonb),
    -- The person's road story: the nights already played on the Greenroom
    -- tours they're on, plus the nights an artist confirmed for them (tour
    -- credits). One night counts once however many ways it's known, and a
    -- confirmed tour that is one of their Greenroom tours isn't a second tour.
    'roadStats', public.road_stats(u),
    -- What each artist has confirmed for them, artist by artist. A member has
    -- every night of the artist, so theirs is the artist page's own count,
    -- read from the same place that page reads it; a member who left keeps
    -- every night up to the day they left; a claim is only for crew.
    'credits', coalesce((
      select jsonb_agg(x.j) from (
        select jsonb_build_object('artistId', m.artist_id,
                 'tours', coalesce((h.summary ->> 'tours')::int, 0), 'shows', coalesce((h.summary ->> 'shows')::int, 0)) as j
          from artist_members m join artist_history h on h.artist_id = m.artist_id
         where m.user_id = u and m.kind = 'band' and m.ended_at is null
        union all
        select jsonb_build_object('artistId', m.artist_id) || public.credit_counts(m.artist_id,
                 jsonb_build_object('all', true, 'until', to_char(m.ended_at, 'YYYY-MM-DD')))
          from artist_members m
         where m.user_id = u and m.kind = 'band' and m.ended_at is not null
        union all
        select jsonb_build_object('artistId', c.artist_id) || public.credit_counts(c.artist_id,
                 -- still listed: the claim runs on; left: it stops the day they left
                 public.credit_claim_live(c.artist_id, c.user_id, c.approved))
          from tour_credits c where c.user_id = u and c.approved is not null
           and not exists (select 1 from artist_members b where b.artist_id = c.artist_id and b.user_id = u and b.kind = 'band')) x), '[]'::jsonb),
    -- ...and those tours by name, for their Tours tab. A band member's list is
    -- the artist page's list, entry for entry (Devin: "any shows or tours or
    -- festivals ... added to the list on the artist page ... should update on
    -- the people listed under band"): its tours, its festivals, each year's
    -- shows outside a tour. Crew get the tours an artist confirmed for them,
    -- and its festivals, each on its own.
    'creditTours', coalesce((
      with band as materialized (
        -- (a member who left: the artist page's list as it stood the day they left)
        select m.artist_id, a.name as artist,
               case when m.ended_at is null then h.summary -> 'toursList'
                    else public.artist_list_until(m.artist_id, m.ended_at) end as list
          from artist_members m join artists a on a.id = m.artist_id
          left join artist_history h on h.artist_id = m.artist_id
         where m.user_id = u and m.kind = 'band'),
      grp as materialized (
        -- each crediting artist's tour groups, worked out once
        select ar.artist_id, gg.tour, gg.gk, gg.hidden, gg.shown
          from (select distinct c.artist_id from tour_credits c where c.user_id = u and c.approved is not null
                   and not exists (select 1 from band b where b.artist_id = c.artist_id)) ar
          cross join lateral public.artist_tour_groups(ar.artist_id) gg),
      cs as materialized (
        select s.* from public.credited_shows(u) s where not exists (select 1 from band b where b.artist_id = s.artist_id)),
      ent as (
        select b.artist_id, b.artist, coalesce(e ->> 'key', '') as tkey, coalesce(e ->> 'name', '') as nm,
               case when (e ->> 'n') ~ '^[0-9]+$' then (e ->> 'n')::int else 0 end as n,
               e ->> 'first' as d0, e ->> 'last' as d1, coalesce(e ->> 'kind', 'tour') as kind, ''::text as role
          from band b
          cross join lateral jsonb_array_elements(case when jsonb_typeof(b.list) = 'array' then b.list else '[]'::jsonb end) e
        union all
        select s.artist_id, a.name, g.gk, coalesce(max(g.shown), mode() within group (order by s.tour)),
               count(distinct (s.d, lower(s.venue)))::int, min(s.d)::text, max(s.d)::text, 'tour',
               coalesce(string_agg(distinct nullif(public.credit_role(tc.approved, s.tkey), ''), ', '), '')
          from cs s join artists a on a.id = s.artist_id
          join grp g on g.artist_id = s.artist_id and g.tour = s.tour
          left join tour_credits tc on tc.artist_id = s.artist_id and tc.user_id = u
         where s.tour <> '' and not g.hidden and (s.d is null or s.d <= public.road_today())
         group by s.artist_id, a.name, g.gk
        union all
        -- crew: each festival by its name (nights under no tour that carry one), with the role said for it
        select s.artist_id, a.name, '', hs.festival,
               count(distinct (s.d, lower(s.venue)))::int, min(s.d)::text, max(s.d)::text, 'festival',
               coalesce(string_agg(distinct nullif(public.credit_role(tc.approved, s.tkey), ''), ', '), '')
          from cs s join artists a on a.id = s.artist_id
          join artist_history_shows hs on hs.artist_id = s.artist_id and hs.id = s.show_id
          left join tour_credits tc on tc.artist_id = s.artist_id and tc.user_id = u
         where s.tour = '' and hs.festival <> '' and (s.d is null or s.d <= public.road_today())
         group by s.artist_id, a.name, hs.festival)
      select jsonb_agg(jsonb_build_object('artistId', x.artist_id, 'artist', x.artist, 'key', x.tkey, 'name', x.nm,
               'n', x.n, 'first', x.d0, 'last', x.d1, 'kind', x.kind, 'role', x.role) order by x.d1 desc nulls last, x.nm)
        from (select * from ent order by d1 desc nulls last, nm limit 400) x), '[]'::jsonb),
    'logos', coalesce((
      select jsonb_object_agg(a.artist, a.logo) from (
        select distinct on (lower(trim(coalesce(t.doc ->> 'artist', ''))))
               lower(trim(coalesce(t.doc ->> 'artist', ''))) as artist, l.doc ->> 'dataUrl' as logo
          from public.tours_of(u) t
          join labels l on l.owner_id = t.owner_id
           and l.id = 'alogo:' || left(trim(both '-' from
                 regexp_replace(lower(trim(coalesce(t.doc ->> 'artist', ''))), '[^a-z0-9]+', '-', 'g')), 40)
         where coalesce(l.doc ->> 'dataUrl', '') <> ''
      ) a), '{}'::jsonb)
  );
end $function$;
revoke all on function public.profile_card(uuid) from public, anon;
grant execute on function public.profile_card(uuid) to authenticated, service_role;

-- Two fixes from the review, each from its live text with one change.
-- shares_artist: being listed on a page counts as sharing an artist (it opens
-- the other listed people's profiles). A listing taken in while nobody ran the
-- page does not count until the page's owner keeps it.
CREATE OR REPLACE FUNCTION public.shares_artist(u uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with mine as (
    select a.id from artists a where a.owner_id = auth.uid()
    union select m.artist_id from artist_members m where m.user_id = auth.uid() and m.ended_at is null
       -- (not a listing taken in while nobody ran the page and not yet kept by its owner: listing yourself
       -- must not open the profiles of everyone else on that page)
       and not exists (select 1 from unclaimed_joins j where j.artist_id = m.artist_id and j.user_id = m.user_id and j.listed)
  )
  select exists (select 1 from artists a where a.owner_id = u and a.id in (select id from mine))
      or exists (select 1 from artist_members m where m.user_id = u and m.ended_at is null and m.artist_id in (select id from mine))
$function$;
revoke all on function public.shares_artist(uuid) from public, anon;
grant execute on function public.shares_artist(uuid) to authenticated, service_role;

-- flower_counts: an endorsement is an artist's word. One that came with a
-- listing nobody has said yes to yet is not counted until the owner keeps it.
CREATE OR REPLACE FUNCTION public.flower_counts(u uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    -- Only real tours count: not one in the trash, not a band's Off Tour book.
    'flowers', (select coalesce(sum(f.n), 0) from flowers f join tours t on t.id = f.tour_id
                 where f.to_id = u and coalesce(t.doc ->> 'kind', '') <> 'offtour' and (t.doc ->> 'deletedAt') is null),
    -- The artists who endorsed them: their word that this person really worked for them.
    -- (Not a listing taken in while nobody ran the page: nobody has given that word yet.)
    'endorsements', (select count(*) from artist_endorsements e where e.user_id = u and e.removed_at is null
                      and not exists (select 1 from unclaimed_joins j where j.artist_id = e.artist_id and j.user_id = e.user_id and j.listed)),
    'tours', (select count(*) from public.tours_of(u)))
$function$;
revoke all on function public.flower_counts(uuid) from public, anon, authenticated;
grant execute on function public.flower_counts(uuid) to service_role;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
-- request_artist and profile_card back to 0146's text, tour_own_nights back to
-- 0145's, submit_tour_credits back to its text before this file (the same
-- statement without v_free), then:
--   drop trigger if exists artists_joined_on_claim on public.artists;
--   drop function if exists public.joined_on_claim();
--   drop function if exists public.answer_unclaimed_join(uuid, uuid, boolean);
--   drop function if exists public.unclaimed_join_queue(uuid);
--   drop table if exists public.unclaimed_joins;
--   notify pgrst, 'reload schema';
-- What was done meanwhile stays: people listed on a page nobody ran stay
-- listed (the page's owner takes them off the ordinary way), tours confirmed
-- stay confirmed (the owner can take them back from the person's role sheet).
-- The festival nights put back under no tour stay settled that way: to put one
-- under a tour again, the page's owner picks the tour for that night. A
-- festival night moved into its own pick of a claim stays covered by its id.
