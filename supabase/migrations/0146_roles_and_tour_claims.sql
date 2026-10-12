-- Several roles, "I was on this tour", and asked once (Devin, 2026-10-12).
--
-- Three things he said:
--   1. "When you get asked what your roll is with an artist you should be
--      able to choose multiple rolls."
--   2. "when a crew member goes to an artist they are endorsed by and they
--      hit the tours on that artists page there should be a "claim" ... a way
--      for a crew member to say "I was apart of this tour" and again they get
--      asked the role they played on the tour and then it's sent to the
--      artist to approve."
--   3. "i keep getting asked on my user profile to confirm the shows with I
--      See Stars. This should only have to be done once and confirmed by the
--      artist once and then it is done."
--
-- What changes here:
--   1. A role with an artist is still one line of text, but there is room in
--      it for several roles joined with ", " ("Tour manager, Driver"): 160
--      characters where there were 40. A seat on a tour made from a listing
--      (0143) takes the FIRST role only: who may sort a tour's card charges
--      is decided by the seat's title being exactly "Tour manager", so a
--      second role in that title would take those rights away.
--   2. add_tour_credit: "I was on this tour", with the role played. The tour
--      is added, whole, to what the person already has confirmed or waiting
--      (never in place of it), and goes to the artist the way every claim
--      does. A pick now keeps its role; the artist's review and the person's
--      profile read it back. my_tour_claims tells the artist page's Tours
--      tab where the person stands on each tour.
--   3. A Member is never asked to confirm tours: a Member has every night of
--      the artist by rule (credited_shows), so there is nothing to confirm.
--
-- Nothing here changes what anyone's page counts. credit_covers,
-- credit_counts, credited_shows and submit_tour_credits are not touched.


-- ====================== 1. Room for several roles ======================

-- A limit of 40 on a role column (0071 put one on artist_members, 0134 on
-- artist_requests) becomes 160, under the name it already has. Where there is
-- no such limit this does nothing.
do $$
declare c record;
begin
  for c in select con.conrelid::regclass::text as tbl, con.conname
             from pg_constraint con
            where con.contype = 'c'
              and con.conrelid in ('public.artist_members'::regclass, 'public.artist_requests'::regclass,
                                   'public.artist_endorsements'::regclass)
              and pg_get_constraintdef(con.oid) ~ 'char_length\(role\) <= 40'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
    execute format('alter table %s add constraint %I check (char_length(role) <= 160)', c.tbl, c.conname);
  end loop;
end $$;

-- Asking an artist to list you: the live text, with 160 where it said 40.
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
  insert into artist_requests (artist_id, user_id, kind, role) values (a_id, me, k, rr)
  on conflict (artist_id, user_id) do update
    set kind = excluded.kind, role = excluded.role, status = 'pending', created_at = now(), decided_at = null, decided_by = null;
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.request_artist(uuid, text, text) from public, anon;
grant execute on function public.request_artist(uuid, text, text) to authenticated, service_role;

-- Listing and endorsing in one go: the live text, with 160 where it said 40.
CREATE OR REPLACE FUNCTION public.artist_list_endorsed(a_id uuid, u_id uuid, k text, r text, by_whom uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into artist_members (artist_id, user_id, kind, role, added_by) values (a_id, u_id, k, left(btrim(coalesce(r, '')), 160), by_whom)
  on conflict (artist_id, user_id) do update set kind = excluded.kind, role = excluded.role;
  -- (They asked to be listed, so an endorsement they once took off comes back.)
  insert into artist_endorsements (artist_id, user_id, endorsed_by) values (a_id, u_id, by_whom)
  on conflict (artist_id, user_id) do update
    set removed_at = null, endorsed_by = excluded.endorsed_by, kind = excluded.kind, role = excluded.role, created_at = now()
    where artist_endorsements.removed_at is not null;
end $function$;
revoke all on function public.artist_list_endorsed(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.artist_list_endorsed(uuid, uuid, text, text, uuid) to service_role;

-- The trigger that trims a listing's role and copies it to the endorsement:
-- the live text, with 160 where it said 40.
CREATE OR REPLACE FUNCTION public.member_role_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.role := left(btrim(coalesce(new.role, '')), 160);
  if tg_op = 'UPDATE' and new.role is distinct from old.role then
    update artist_endorsements set role = new.role
     where artist_id = new.artist_id and user_id = new.user_id;
  end if;
  return new;
end $function$;
revoke all on function public.member_role_sync() from public, anon, authenticated;
grant execute on function public.member_role_sync() to service_role;

-- A seat made from a listing (0143): the live text, with one change. The
-- seat's title is the first role of the listing, not all of them. The bank
-- function (cardLead) and the database (0037, 0039, 0060) give the Tour
-- Manager's rights to a Manager whose title is exactly "tour manager"; a
-- title of "Tour manager, Driver" would not pass. The roles are joined in the
-- order of the list, where Tour manager is first.
CREATE OR REPLACE FUNCTION public.seat_from_artist(a_id uuid, u_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
              left(btrim(split_part(coalesce(l.role, ''), ',', 1)), 40), lvl = 'editor');
      n := n + 1;
    exception when others then
      raise log 'seat_from_artist: no seat on tour % for % (%)', t.id, u_id, sqlerrm;
    end;
  end loop;
  return n;
end $function$;
revoke all on function public.seat_from_artist(uuid, uuid) from public, anon, authenticated;
grant execute on function public.seat_from_artist(uuid, uuid) to service_role;


-- ====================== 2. The role played on a tour ======================

-- The role a claim holds for one tour key ('' when it holds none).
create or replace function public.credit_role(claim jsonb, tk text)
returns text
language sql immutable as $function$
  select coalesce((
    select left(btrim(p ->> 'role'), 160)
      from jsonb_array_elements(
             case when jsonb_typeof(claim -> 'picks') = 'array' then claim -> 'picks' else '[]'::jsonb end) p
     where p ->> 'key' = tk and jsonb_typeof(p -> 'role') = 'string' and btrim(p ->> 'role') <> ''
     limit 1), '')
$function$;
revoke all on function public.credit_role(jsonb, text) from public, anon, authenticated;
grant execute on function public.credit_role(jsonb, text) to service_role;

-- Two lines of roles as one, each role once, in the order they were said.
create or replace function public.credit_role_join(a text, b text)
returns text
language sql immutable as $function$
  select left(coalesce(string_agg(q.t, ', ' order by q.o), ''), 160)
    from (select distinct on (lower(u.t)) u.t, u.o
            from (select btrim(x.t) as t, x.o
                    from unnest(string_to_array(coalesce(a, '') || ',' || coalesce(b, ''), ',')) with ordinality x(t, o)) u
           where u.t <> ''
           order by lower(u.t), u.o) q
$function$;
revoke all on function public.credit_role_join(text, text) from public, anon, authenticated;
grant execute on function public.credit_role_join(text, text) to service_role;

-- A claim, made clean: the live text, with one change. A pick keeps the role
-- said with it (text, spaces tidied, 160 characters). Everything else about a
-- pick is still rebuilt from the archive.
CREATE OR REPLACE FUNCTION public.credit_normalize(a_id uuid, claim jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare acc jsonb := '[]'::jsonb; p jsonb; k text; groups jsonb; ids jsonb; done text[] := '{}'; rl text;
        today text := to_char(current_date, 'YYYY-MM-DD');
begin
  if jsonb_typeof(claim) is distinct from 'object' then
    raise exception 'a claim must be an object' using errcode = '22023';
  end if;
  if coalesce(claim ->> 'all', '') = 'true' then
    return jsonb_build_object('all', true, 'until', today);
  end if;
  if jsonb_typeof(claim -> 'picks') is distinct from 'array' or jsonb_array_length(claim -> 'picks') > 500 then
    raise exception 'picks' using errcode = '22023';
  end if;
  select coalesce(jsonb_object_agg(g.tkey, g.n), '{}'::jsonb) into groups
    from (select h.tkey, count(*) as n from artist_history_shows h
           where h.artist_id = a_id and (h.date is null or h.date <= current_date)
           group by h.tkey) g;
  for p in select * from jsonb_array_elements(claim -> 'picks')
  loop
    if jsonb_typeof(p) is distinct from 'object' then continue; end if;
    k := p ->> 'key';
    if k is null or not (groups ? k) or k = any (done) then continue; end if;
    done := done || k;
    rl := case when jsonb_typeof(p -> 'role') = 'string'
               then left(btrim(regexp_replace(p ->> 'role', '\s+', ' ', 'g')), 160) else '' end;
    if p ->> 'mode' = 'shows' then
      if jsonb_typeof(p -> 'shows') is distinct from 'array' or jsonb_array_length(p -> 'shows') > 2000 then
        raise exception 'shows' using errcode = '22023';
      end if;
      select coalesce(jsonb_agg(h.id order by h.date nulls last, h.id), '[]'::jsonb) into ids
        from artist_history_shows h
       where h.artist_id = a_id and h.tkey = k and (h.date is null or h.date <= current_date)
         and (p -> 'shows') ? h.id;
      if jsonb_array_length(ids) = 0 then continue; end if;
      acc := acc || jsonb_build_array(jsonb_build_object('key', k,
        'mode', case when jsonb_array_length(ids) >= (groups ->> k)::int then 'all' else 'shows' end, 'shows', ids)
        || case when rl <> '' then jsonb_build_object('role', rl) else '{}'::jsonb end);
    else
      -- The entire tour, as it stands today: its nights by name.
      select coalesce(jsonb_agg(h.id order by h.date nulls last, h.id), '[]'::jsonb) into ids
        from artist_history_shows h
       where h.artist_id = a_id and h.tkey = k and (h.date is null or h.date <= current_date);
      acc := acc || jsonb_build_array(jsonb_build_object('key', k, 'mode', 'all', 'shows', ids)
        || case when rl <> '' then jsonb_build_object('role', rl) else '{}'::jsonb end);
    end if;
  end loop;
  if jsonb_array_length(acc) = 0 then
    raise exception 'nothing picked' using errcode = '22023';
  end if;
  return jsonb_build_object('picks', acc, 'until', today);
end $function$;
revoke all on function public.credit_normalize(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.credit_normalize(uuid, jsonb) to service_role;

-- A claim, tour by tour (the artist's review, the person's own list): the
-- live text, with one key more on each row, the role said for that tour. What
-- it counts is not changed.
CREATE OR REPLACE FUNCTION public.credit_expand(a_id uuid, claim jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', x.tkey, 'name', x.nm, 'year', x.tkey like 'year:%',
      'total', x.total, 'n', x.n, 'first', x.d0, 'last', x.d1,
      'role', public.credit_role(claim, x.tkey))
      order by x.d1 desc nulls last, x.tkey), '[]'::jsonb)
    from (
      select h.tkey,
             case when h.tkey like 'year:%' then '' else mode() within group (order by h.tour) end as nm,
             count(*) filter (where h.date is null or h.date <= current_date) as total,
             count(*) filter (where public.credit_covers(claim, h.id, h.date, h.tkey)) as n,
             min(h.date) filter (where public.credit_covers(claim, h.id, h.date, h.tkey)) as d0,
             max(h.date) filter (where public.credit_covers(claim, h.id, h.date, h.tkey)) as d1
        from artist_history_shows h
       where h.artist_id = a_id and claim is not null
       group by h.tkey
      having count(*) filter (where public.credit_covers(claim, h.id, h.date, h.tkey)) > 0) x
$function$;
revoke all on function public.credit_expand(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.credit_expand(uuid, jsonb) to service_role;

-- A person's profile card: the live text, with one change. Its list of tours
-- (creditTours) is not built by credit_expand: it is built here, from the
-- nights that count. Each tour an artist confirmed for crew now carries the
-- role said for it ('' when none; '' on a Member's rows, which come from the
-- artist page's own list). The join added reads the person's one row of
-- tour_credits for that artist; no count is changed.
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
    -- shows outside a tour. Crew get the tours an artist confirmed for them.
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
         group by s.artist_id, a.name, g.gk)
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


-- ====================== 3. Asked once ======================

-- The artists that ask a person to confirm their tours: the live text, with
-- one line more. An artist that lists the person as a Member is left out: a
-- Member has every night of the artist by rule (one who left, every night up
-- to that day), and a claim from them counts for nothing (credited_shows), so
-- there is nothing to ask. Nothing they sent before is deleted.
CREATE OR REPLACE FUNCTION public.my_credit_asks()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'artistId', a.id, 'artist', a.name, 'handle', a.handle, 'avatar', a.avatar,
      'owner', a.owner_id = auth.uid(),
      'at', e.created_at,
      'state', case when c.pending is not null then 'pending'
                    when c.approved is not null then 'approved'
                    when c.declined_at is not null then 'declined' else 'ask' end,
      'hasApproved', c.approved is not null,
      'submittedAt', c.submitted_at, 'declinedAt', c.declined_at)
      || case when c.approved is not null then public.credit_counts(a.id, public.credit_claim_live(a.id, c.user_id, c.approved))
              else jsonb_build_object('tours', 0, 'shows', 0) end
      order by e.created_at), '[]'::jsonb)
    from artist_endorsements e
    join artists a on a.id = e.artist_id
    left join tour_credits c on c.artist_id = a.id and c.user_id = e.user_id
   where auth.uid() is not null and e.user_id = auth.uid() and e.removed_at is null
     and exists (select 1 from artist_history_shows h where h.artist_id = a.id)
     and not exists (select 1 from artist_members m
                      where m.artist_id = a.id and m.user_id = e.user_id and m.kind = 'band')
$function$;
revoke all on function public.my_credit_asks() from public, anon;
grant execute on function public.my_credit_asks() to authenticated, service_role;


-- ====================== 4. "I was on this tour" ======================

-- One tour, by the name the artist's page shows it under, added to what the
-- caller already has. The merge is done here so a phone cannot get it wrong:
--   what they have  = their waiting claim when there is one, else what the
--                     artist confirmed;
--   plus this tour  = one whole-tour pick for each key the archive holds
--                     under the tour's group (a tour can sit under two
--                     spellings), with the role, in place of any pick of the
--                     same key; and, for a festival whose nights sit under
--                     another tour or under no tour, those nights added to
--                     the pick of the key they sit under (a whole pick of
--                     that key already has them).
-- It is then handed to submit_tour_credits, so it is made clean and written
-- exactly as any claim is: waiting for the artist, or confirmed at once when
-- the caller runs the page. Answers { ok, auto } as that does;
-- { ok: true, covered: true } when there is nothing to add (they already hold
-- ALL TOURS, or this tour whole with the same role, or they are a Member);
-- { ok: false, why: 'no_tour' } when the archive has no played night under
-- that name.
create or replace function public.add_tour_credit(a_id uuid, tour_name text, r text default '')
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  v_me uuid := auth.uid();
  v_name text := btrim(coalesce(tour_name, ''));
  v_role text := left(btrim(regexp_replace(coalesce(r, ''), '\s+', ' ', 'g')), 160);
  v_gk text; v_keys text[]; v_base jsonb; v_old jsonb; v_picks jsonb := '[]'::jsonb;
  v_p jsonb; v_had jsonb; v_f record; v_changed boolean := false; v_new jsonb;
begin
  -- only someone this artist has endorsed (the rule every claim goes by)
  if v_me is null or not exists (select 1 from artist_endorsements e
       where e.artist_id = a_id and e.user_id = v_me and e.removed_at is null) then
    raise exception 'permission' using errcode = '42501';
  end if;
  if v_name = '' or v_name ~ '^year:' then
    raise exception 'tour' using errcode = '22023';
  end if;
  -- a Member has every night of the artist by rule
  if exists (select 1 from artist_members m where m.artist_id = a_id and m.user_id = v_me and m.kind = 'band') then
    return jsonb_build_object('ok', true, 'covered', true);
  end if;
  -- (for update: a second tour sent while this one is still being written waits, and builds on it)
  select coalesce(c.pending, c.approved) into v_base
    from tour_credits c where c.artist_id = a_id and c.user_id = v_me for update;
  if coalesce(v_base ->> 'all', '') = 'true' then
    return jsonb_build_object('ok', true, 'covered', true);
  end if;
  v_old := case when jsonb_typeof(v_base -> 'picks') = 'array' then v_base -> 'picks' else '[]'::jsonb end;

  v_gk := public.artist_tour_key_of(a_id, v_name);
  -- (a tour the page's owner took off the page is not shown there, and is not taken here)
  if exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = v_gk) then
    return jsonb_build_object('ok', false, 'why', 'no_tour');
  end if;
  -- every key the archive holds under this tour's group, played nights only
  select array_agg(distinct h.tkey) into v_keys
    from artist_history_shows h join public.artist_tour_groups(a_id) g on g.tour = h.tour
   where h.artist_id = a_id and g.gk = v_gk and h.tkey not like 'year:%'
     and (h.date is null or h.date <= current_date);

  -- what they have, as it is, less the keys this tour now brings whole
  for v_p in select x.p from jsonb_array_elements(v_old) with ordinality x(p, o) order by x.o
  loop
    if jsonb_typeof(v_p) = 'object' and not ((v_p ->> 'key') = any (coalesce(v_keys, '{}'::text[]))) then
      v_picks := v_picks || jsonb_build_array(v_p);
    end if;
  end loop;
  if v_keys is not null then
    v_changed := exists (
      select 1 from unnest(v_keys) k(k)
       where not exists (select 1 from jsonb_array_elements(v_old) o(p)
                          where o.p ->> 'key' = k.k and o.p ->> 'mode' = 'all'
                            and coalesce(btrim(o.p ->> 'role'), '') = v_role));
    select v_picks || jsonb_agg(jsonb_build_object('key', k.k, 'mode', 'all')
                                || case when v_role <> '' then jsonb_build_object('role', v_role) else '{}'::jsonb end
                                order by k.k)
      into v_picks from unnest(v_keys) k(k);
  end if;

  -- a festival's nights that sit under another tour's key, or under a year's
  for v_f in
    select h.tkey, jsonb_agg(h.id order by h.date nulls last, h.id) as ids
      from artist_history_shows h
     where h.artist_id = a_id and h.festival <> ''
       and public.artist_tour_gkey(a_id, h.festival) = v_gk
       and (h.date is null or h.date <= current_date)
       and not (h.tkey = any (coalesce(v_keys, '{}'::text[])))
     group by h.tkey
  loop
    v_had := null;
    select x.p into v_had from jsonb_array_elements(v_picks) x(p) where x.p ->> 'key' = v_f.tkey limit 1;
    if v_had is null then
      v_picks := v_picks || jsonb_build_array(jsonb_build_object('key', v_f.tkey, 'mode', 'shows', 'shows', v_f.ids)
                   || case when v_role <> '' then jsonb_build_object('role', v_role) else '{}'::jsonb end);
      v_changed := true;
    elsif v_had ->> 'mode' = 'shows' then
      if not (coalesce(v_had -> 'shows', '[]'::jsonb) @> v_f.ids)
         or public.credit_role_join(v_had ->> 'role', v_role) is distinct from coalesce(btrim(v_had ->> 'role'), '') then
        v_changed := true;
      end if;
      select coalesce(jsonb_agg(x.p order by x.o), '[]'::jsonb) into v_picks
        from jsonb_array_elements(v_picks) with ordinality x(p, o)
       where x.p ->> 'key' is distinct from v_f.tkey;
      v_picks := v_picks || jsonb_build_array(jsonb_build_object('key', v_f.tkey, 'mode', 'shows',
                   'shows', (select jsonb_agg(distinct u.id)
                               from (select jsonb_array_elements_text(
                                              case when jsonb_typeof(v_had -> 'shows') = 'array' then v_had -> 'shows' else '[]'::jsonb end) as id
                                     union all
                                     select jsonb_array_elements_text(v_f.ids)) u),
                   'role', public.credit_role_join(v_had ->> 'role', v_role)));
    end if;
    -- (a whole pick of that key already has the night)
  end loop;

  if v_keys is null and not v_changed and not exists (
       select 1 from artist_history_shows h
        where h.artist_id = a_id and h.festival <> '' and public.artist_tour_gkey(a_id, h.festival) = v_gk
          and (h.date is null or h.date <= current_date)) then
    return jsonb_build_object('ok', false, 'why', 'no_tour');
  end if;
  if not v_changed then
    return jsonb_build_object('ok', true, 'covered', true);
  end if;
  /* Nothing they have may be lost. A claim counts a night by its id wherever
     the night sits now, but making a claim clean (credit_normalize) keeps a
     listed night only while it is still under the tour it was listed for. A
     night that has since been put under another tour (the nightly naming, the
     tour finder, the page's owner) would fall out here and the person's shows
     would go down on "add". So every night the old claim reaches today that
     the new one would not is put back, as a listed night of the tour it sits
     under now. */
  if v_base is not null and jsonb_array_length(v_picks) > 0 then
    v_new := public.credit_normalize(a_id, jsonb_build_object('picks', v_picks)) - 'until';
    for v_f in
      select h.tkey, jsonb_agg(h.id order by h.date nulls last, h.id) as ids
        from artist_history_shows h
       where h.artist_id = a_id and (h.date is null or h.date <= current_date)
         and public.credit_covers(v_base - 'until', h.id, h.date, h.tkey)
         and not public.credit_covers(v_new, h.id, h.date, h.tkey)
       group by h.tkey
    loop
      v_had := null;
      select x.p into v_had from jsonb_array_elements(v_picks) x(p) where x.p ->> 'key' = v_f.tkey limit 1;
      if v_had is null then
        v_picks := v_picks || jsonb_build_array(jsonb_build_object('key', v_f.tkey, 'mode', 'shows', 'shows', v_f.ids));
      elsif v_had ->> 'mode' = 'shows' then
        select coalesce(jsonb_agg(x.p order by x.o), '[]'::jsonb) into v_picks
          from jsonb_array_elements(v_picks) with ordinality x(p, o)
         where x.p ->> 'key' is distinct from v_f.tkey;
        v_picks := v_picks || jsonb_build_array((v_had - 'shows') || jsonb_build_object('shows',
                     (select jsonb_agg(distinct u.id)
                        from (select jsonb_array_elements_text(
                                       case when jsonb_typeof(v_had -> 'shows') = 'array' then v_had -> 'shows' else '[]'::jsonb end) as id
                              union all
                              select jsonb_array_elements_text(v_f.ids)) u)));
      end if;
    end loop;
  end if;
  return public.submit_tour_credits(a_id, jsonb_build_object('picks', v_picks));
end $function$;
revoke all on function public.add_tour_credit(uuid, text, text) from public, anon;
grant execute on function public.add_tour_credit(uuid, text, text) to authenticated;

-- Where the caller stands on each tour of an artist's page, for the "I was on
-- this tour" button there. Only for someone the artist lists as crew now and
-- has endorsed ({ crew: false } for anyone else: a Member has every night, a
-- stranger has nothing to say). One row for each tour or festival of the page
-- (named as the page names it) that one of their claims reaches:
--   'approved'  a night of it is among what the artist confirmed ("On your profile");
--   'pending'   their waiting claim holds it;
--   'declined'  the artist sent back a claim that held it, and nothing was sent since.
-- With the role said for it. A tour that is not in the list has the button.
create or replace function public.my_tour_claims(a_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $function$
declare
  v_me uuid := auth.uid();
  v_kind text; v_role text;
  v_app jsonb; v_pen jsonb; v_dec jsonb; v_rows jsonb;
begin
  if v_me is null then return null; end if;
  select m.kind, coalesce(m.role, '') into v_kind, v_role
    from artist_members m where m.artist_id = a_id and m.user_id = v_me and m.ended_at is null;
  if v_kind is distinct from 'crew'
     or not exists (select 1 from artist_endorsements e
                     where e.artist_id = a_id and e.user_id = v_me and e.removed_at is null) then
    return jsonb_build_object('crew', false, 'role', '', 'tours', '[]'::jsonb);
  end if;
  select public.credit_claim_live(a_id, v_me, c.approved), c.pending, c.declined
    into v_app, v_pen, v_dec
    from tour_credits c where c.artist_id = a_id and c.user_id = v_me;
  with tg as materialized (select * from public.artist_tour_groups(a_id)),
       n as materialized (
         select h.tour, h.festival, h.tkey, (h.date is null or h.date <= current_date) as played,
                public.credit_covers(v_app, h.id, h.date, h.tkey) as a,
                public.credit_covers(v_pen, h.id, h.date, h.tkey) as p,
                public.credit_covers(v_dec, h.id, h.date, h.tkey) as d
           from artist_history_shows h
          where h.artist_id = a_id and (v_app is not null or v_pen is not null or v_dec is not null)),
       t as (
         -- the page's tours, grouped and named as its summary groups and names them
         select coalesce(max(g.shown), mode() within group (order by n.tour)) as nm,
                bool_or(n.a) as a, bool_or(n.p) as p, bool_or(n.d) as d,
                -- part: a played night of it is in neither what was confirmed nor what is waiting
                coalesce(bool_or(n.played and not n.a and not n.p), false) as part,
                string_agg(distinct nullif(public.credit_role(v_app, n.tkey), ''), ', ') filter (where n.a) as ra,
                string_agg(distinct nullif(public.credit_role(v_pen, n.tkey), ''), ', ') filter (where n.p) as rp,
                string_agg(distinct nullif(public.credit_role(v_dec, n.tkey), ''), ', ') filter (where n.d) as rd
           from n join tg g on g.tour = n.tour
          where not g.hidden
          group by g.gk
         having bool_or(n.a) or bool_or(n.p) or bool_or(n.d)
         union all
         -- its festivals that are not also a tour label
         select n.festival, bool_or(n.a), bool_or(n.p), bool_or(n.d),
                coalesce(bool_or(n.played and not n.a and not n.p), false),
                string_agg(distinct nullif(public.credit_role(v_app, n.tkey), ''), ', ') filter (where n.a),
                string_agg(distinct nullif(public.credit_role(v_pen, n.tkey), ''), ', ') filter (where n.p),
                string_agg(distinct nullif(public.credit_role(v_dec, n.tkey), ''), ', ') filter (where n.d)
           from n
          where n.festival <> ''
            and public.artist_tour_gkey(a_id, n.festival) not in (select g2.gk from tg g2)
          group by n.festival
         having bool_or(n.a) or bool_or(n.p) or bool_or(n.d))
  select coalesce(jsonb_agg(jsonb_build_object('name', t.nm,
           'state', case when t.a then 'approved' when t.p then 'pending' else 'declined' end,
           'role', coalesce(case when t.a then t.ra when t.p then t.rp else t.rd end, ''),
           'part', t.part and (t.a or t.p))), '[]'::jsonb)
    into v_rows from t;
  return jsonb_build_object('crew', true, 'role', v_role, 'tours', coalesce(v_rows, '[]'::jsonb));
end $function$;
revoke all on function public.my_tour_claims(uuid) from public, anon;
grant execute on function public.my_tour_claims(uuid) to authenticated;

-- credit_detail, as it stands in the database, with one change: the confirmed
-- and the waiting tours are counted up to today while the person is still
-- listed (credit_claim_live), as the row that opens this list counts them. It
-- used to stop at the day the claim was sent, so a tour still on the road
-- read "51 of 52 shows" a day later.
CREATE OR REPLACE FUNCTION public.credit_detail(a_id uuid, u_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.tour_credits%rowtype; inner_ boolean;
begin
  if auth.uid() is null then return null; end if;
  -- The person and the artist's page are the two parties to it: they get in
  -- even when the page no longer lists the person (former crew is who this
  -- is for). Anyone else needs to be able to see the person's page.
  inner_ := u_id = auth.uid() or public.runs_artist(a_id);
  if not (inner_ or public.can_see_profile(u_id)) then return null; end if;
  select * into c from tour_credits where artist_id = a_id and user_id = u_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'artistId', a_id, 'userId', u_id,
    'artist', coalesce((select a.name from artists a where a.id = a_id), ''),
    'name', public.person_name(u_id),
    'url', coalesce((select h.mb_url from artist_history h where h.artist_id = a_id), ''),
    'approvedAll', coalesce(c.approved ->> 'all', '') = 'true',
    'approved', public.credit_expand(a_id, public.credit_claim_live(a_id, u_id, c.approved)),
    'pendingAll', inner_ and coalesce(c.pending ->> 'all', '') = 'true',
    'pending', case when inner_ and c.pending is not null then public.credit_expand(a_id, public.credit_claim_live(a_id, u_id, c.pending)) end,
    'submittedAt', case when inner_ then c.submitted_at end,
    'declinedAt', case when inner_ then c.declined_at end);
end $function$;
revoke all on function public.credit_detail(uuid, uuid) from public, anon;
grant execute on function public.credit_detail(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
-- request_artist, artist_list_endorsed, member_role_sync, seat_from_artist,
-- credit_normalize, credit_expand, profile_card and my_credit_asks back to
-- their text before this file (the live text after 0145: the same statements
-- without the changes named above each one), then:
--   drop function if exists public.my_tour_claims(uuid);
--   drop function if exists public.add_tour_credit(uuid, text, text);
--   drop function if exists public.credit_role_join(text, text);
--   drop function if exists public.credit_role(jsonb, text);
--   notify pgrst, 'reload schema';
-- A role longer than 40 characters that was saved meanwhile stays as it is
-- (the columns hold it); a limit of 40 could only be put back on a column
-- after cutting those. A role kept on a pick is harmless to the older
-- functions: they read a pick's key, mode and shows and nothing else.
