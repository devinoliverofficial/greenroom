-- Claims follow the fold: the picker shows the page's rows, and a whole-tour
-- claim covers every spelling of that tour (Devin, 2026-10-15).
--
-- The bug, seen on the live database: the artist page folds a tour's different
-- spellings into one row (an alias set by the page's owner, or the same key
-- spelled two ways), but the claims system worked night by night on each
-- night's raw key. So the "pick the shows you did" list showed one tour twice
-- (19 nights and 2 nights where the page shows one row of 21), a dozen older
-- tours were split the same way, and a whole-tour claim keyed to one spelling
-- missed the nights filed under the other. Devin: the picker's list "is
-- different than what is on the [artist] page. This has been an ongoing
-- issue", and "anytime there are shows listed under a tour and someone claims
-- and is approved for that tour all the shows under that tour should be added
-- immediately to their profile".
--
-- The one rule, in one place (credit_night_gk below): every night belongs to a
-- GROUP key - the key its tour string folds to on the page; for a night with
-- no tour but a festival's name, the festival's folded key; a night with
-- neither keeps its own key (its year). Every claim key is a group key, the
-- picker's rows are exactly the page's rows, and every counter, list and
-- cover test goes by the night's group key.
--
-- What changes here:
--   1. credit_tours (the picker) reads its rows straight off the page's own
--      stored list (artist_history.summary -> 'toursList'), one row for one
--      row, keyed the way the page resolves a row to nights. Rows gain "kind"
--      so the app can tag festivals.
--   2. credit_night_gk is new: night -> group key, set-based, the single
--      place the fold rule lives.
--   3. credit_normalize translates any incoming pick key - an old raw key or
--      a group key - to the group key that owns it, and rebuilds a pick's
--      shows against the group, not the raw key.
--   4. credited_shows, credit_expand, credit_counts and credit_shows pass the
--      night's GROUP key to credit_covers (whose two signatures do not change:
--      only the value passed changes).
--   5. add_tour_credit ("I was on this tour") claims the group once, whole,
--      instead of one pick per raw key.
--   6. Data fix, by rule and never by name: every stored pick key (approved
--      and pending) is rewritten to the group key that owns it, keeping mode,
--      shows, role and until. The seat trigger is off while this runs, as
--      0147's fix did: a key rewrite is not a new approval.
--
-- Invariants, for the rehearsal:
--   * Nobody's confirmed shows shrink. Every pick keeps its shows array (a
--      night is covered by its id wherever it sits), and a whole-tour pick's
--      key match only widens: nights with the pick's raw key all fold to the
--      same group key.
--   * The picker's rows for an artist equal the page's toursList rows one for
--      one (same names, same counts, same order).
--   * A whole-tour claim covers the tour's alternate spellings, including
--      nights added later under any spelling that folds to the group.
--   * profile_card timing unchanged (credited_shows gains one set-based
--      night->group join per confirmed artist, never a per-night call).


-- ============ 1. The one place the fold rule lives ============

-- Night -> group key, for one artist, set-based: tours map through the page's
-- own fold (artist_tour_groups), each distinct festival name is folded once
-- and joined back, and a night with neither keeps its own key (its year).
-- A fold that comes back empty (a tour name whose key is nothing) is no fold:
-- the night keeps its own key, as the cover test has always treated nothing
-- keys. Nothing here is per-night function work: two small distinct lists,
-- then joins.
create or replace function public.credit_night_gk(a_id uuid)
returns table (id text, d date, tkey text, gk text)
language sql stable security definer set search_path = public as $$
  with g as (select t.tour, t.gk from public.artist_tour_groups(a_id) t),
       f as (select fn.festival, public.artist_tour_gkey(a_id, fn.festival) as fgk
               from (select distinct h.festival from artist_history_shows h
                      where h.artist_id = a_id and h.tour = '' and h.festival <> '') fn)
  select h.id, h.date, h.tkey,
         coalesce(nullif(g.gk, ''), nullif(f.fgk, ''), h.tkey) as gk
    from artist_history_shows h
    left join g on h.tour <> '' and g.tour = h.tour
    left join f on h.tour = '' and h.festival <> '' and f.festival = h.festival
   where h.artist_id = a_id
$$;
revoke all on function public.credit_night_gk(uuid) from public, anon, authenticated;
grant execute on function public.credit_night_gk(uuid) to service_role;


-- ============ 2. The picker shows the page's rows ============

-- credit_tours: its live text, with the tours array rebuilt. It was grouped by
-- each night's raw key, which split a folded tour into as many rows as it has
-- spellings. Now it reads the page's own stored list (summary -> 'toursList':
-- name, kind, n, first, last, and 'key' on the year rows), in the page's own
-- order, and keys each tour or festival row the way the page resolves a name
-- to nights (artist_tour_key_of). Year rows keep the key the page stored for
-- them. Everything else (url, mine, owner, endorsed) is as it was. A page
-- with no summary yet (its history still being read in) falls back to the old
-- live grouping, folded the same way, so the picker never goes dark and a
-- person with a claim there can still open and withdraw it.
CREATE OR REPLACE FUNCTION public.credit_tours(a_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.artists%rowtype; v_tours jsonb; v_played text[];
begin
  if not public.can_claim_credits(a_id) then return null; end if;
  select * into a from artists where id = a_id;
  if not found then return null; end if;
  -- the groups with a played night: only those can be claimed, so a tour the
  -- page shows as announced-only stays off the picker (the old picker never
  -- listed it either - it read played nights only)
  select coalesce(array_agg(distinct m.gk), '{}'::text[]) into v_played
    from public.credit_night_gk(a_id) m where m.d is null or m.d <= current_date;
  -- the page's own rows, one for one
  select jsonb_agg(jsonb_build_object(
           'key', coalesce(r.row ->> 'key', public.artist_tour_key_of(a.id, r.row ->> 'name')),
           'name', coalesce(r.row ->> 'name', ''),
           'kind', coalesce(nullif(r.row ->> 'kind', ''), 'tour'),
           'year', coalesce(r.row ->> 'key', '') like 'year:%',
           'n', coalesce((r.row ->> 'n')::int, 0),
           'first', r.row -> 'first', 'last', r.row -> 'last')
         order by r.o)
    into v_tours
    from jsonb_array_elements(coalesce((select h.summary -> 'toursList' from artist_history h
                                         where h.artist_id = a.id
                                           and jsonb_typeof(h.summary -> 'toursList') = 'array'), '[]'::jsonb))
         with ordinality r(row, o)
   where jsonb_typeof(r.row) = 'object'
     and (coalesce(r.row ->> 'name', '') <> '' or r.row ? 'key')
     and coalesce(r.row ->> 'key', public.artist_tour_key_of(a.id, r.row ->> 'name')) = any (v_played);
  if v_tours is null or jsonb_array_length(v_tours) = 0 then
    -- no summary yet: the old live grouping, by the same fold
    select coalesce(jsonb_agg(jsonb_build_object('key', g.gk, 'name', g.nm,
             'kind', case when g.nm_t is null and g.nm_f is not null then 'festival' else 'tour' end,
             'year', g.gk like 'year:%', 'n', g.n, 'first', g.d0, 'last', g.d1)
           order by g.d1 desc nulls last, g.gk), '[]'::jsonb)
      into v_tours
      from (select m.gk,
                   mode() within group (order by nullif(h.tour, '')) as nm_t,
                   mode() within group (order by nullif(h.festival, '')) as nm_f,
                   case when m.gk like 'year:%' then ''
                        else coalesce(mode() within group (order by nullif(h.tour, '')),
                                      mode() within group (order by nullif(h.festival, '')), '') end as nm,
                   count(*) as n, min(h.date) as d0, max(h.date) as d1
              from artist_history_shows h
              join public.credit_night_gk(a.id) m on m.id = h.id
             where h.artist_id = a.id and (h.date is null or h.date <= current_date)
             group by m.gk) g;
  end if;
  return jsonb_build_object(
    'artistId', a.id, 'artist', a.name,
    'owner', a.owner_id = auth.uid(),
    'endorsed', exists (select 1 from artist_endorsements e
                         where e.artist_id = a.id and e.user_id = auth.uid() and e.removed_at is null),
    'url', coalesce((select h.mb_url from artist_history h where h.artist_id = a.id), ''),
    'tours', v_tours,
    'mine', (select jsonb_build_object('approved', c.approved, 'pending', c.pending, 'declined', c.declined,
                      'declinedAt', c.declined_at, 'submittedAt', c.submitted_at)
               from tour_credits c where c.artist_id = a.id and c.user_id = auth.uid()));
end $function$;
revoke all on function public.credit_tours(uuid) from public, anon;
grant execute on function public.credit_tours(uuid) to authenticated, service_role;


-- ============ 3. A clean claim is keyed by group ============

-- credit_normalize: its live text, reworked for the fold. The tally of what
-- the artist has is by group key; an incoming pick key is translated to the
-- group key that owns it (unknown keys kept, then dropped as before); a
-- pick's shows are rebuilt against the group's nights. Three rules the raw
-- keys never needed: the night map is worked out ONCE per call, not once per
-- pick; two picks that fold to the same group MERGE (a whole-tour pick wins,
-- ticked nights union, roles joined) instead of the second being dropped; and
-- every night a pick lists lands somewhere - one whose group is not the
-- pick's key (an old build's year pick holding a festival night, a pick of a
-- spelling the archive no longer explains) moves to its own group's pick
-- rather than being dropped. Caps and errors as before.
CREATE OR REPLACE FUNCTION public.credit_normalize(a_id uuid, claim jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare acc jsonb := '[]'::jsonb; p jsonb; k text; groups jsonb; trans jsonb; nmap jsonb; ids jsonb; done text[] := '{}'; rl text;
        i int; old jsonb; u jsonb; sid text; srole text; sgk text; stray jsonb := '{}'::jsonb;
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
  -- the artist's played nights and their group keys, worked out once
  with m as materialized (
    select k2.id, k2.gk from public.credit_night_gk(a_id) k2
     where k2.d is null or k2.d <= current_date)
  select (select coalesce(jsonb_object_agg(m1.id, m1.gk), '{}'::jsonb) from m m1),
         (select coalesce(jsonb_object_agg(g.gk, g.n), '{}'::jsonb)
            from (select m2.gk, count(*) as n from m m2 group by m2.gk) g)
    into nmap, groups;
  -- raw key -> the group key that owns it (by the played nights whose tour
  -- carries it; a year key is nobody's spelling and never translates)
  select coalesce(jsonb_object_agg(t.k, t.gk), '{}'::jsonb) into trans
    from (select h.tkey as k, min(nmap ->> h.id) as gk
            from artist_history_shows h
           where h.artist_id = a_id and h.tour <> '' and h.tkey not like 'year:%' and (nmap ? h.id)
           group by h.tkey) t;
  for p in select * from jsonb_array_elements(claim -> 'picks')
  loop
    if jsonb_typeof(p) is distinct from 'object' then continue; end if;
    rl := case when jsonb_typeof(p -> 'role') = 'string'
               then left(btrim(regexp_replace(p ->> 'role', '\s+', ' ', 'g')), 160) else '' end;
    k := p ->> 'key';
    -- translate first: the nights that CARRIED a raw key say where it lives
    -- now, even when an owner's renames left another group under that key
    if k is not null then k := coalesce(trans ->> k, k); end if;
    -- remember every night the pick lists, with its role: one that does not
    -- land in a kept pick is placed with its own group below, never dropped
    if jsonb_typeof(p -> 'shows') = 'array' and jsonb_array_length(p -> 'shows') <= 2000 then
      for sid in select jsonb_array_elements_text(p -> 'shows') loop
        if (nmap ? sid) and not (stray ? sid) then stray := stray || jsonb_build_object(sid, rl); end if;
      end loop;
    end if;
    if k is null or not (groups ? k) then continue; end if;
    if p ->> 'mode' = 'shows' then
      if jsonb_typeof(p -> 'shows') is distinct from 'array' or jsonb_array_length(p -> 'shows') > 2000 then
        raise exception 'shows' using errcode = '22023';
      end if;
      select coalesce(jsonb_agg(h.id order by h.date nulls last, h.id), '[]'::jsonb) into ids
        from artist_history_shows h
       where h.artist_id = a_id and nmap ->> h.id = k and (p -> 'shows') ? h.id;
      if jsonb_array_length(ids) = 0 and array_position(done, k) is null then continue; end if;
    else
      -- the entire tour, as it stands today: the group's nights, every spelling
      select coalesce(jsonb_agg(h.id order by h.date nulls last, h.id), '[]'::jsonb) into ids
        from artist_history_shows h
       where h.artist_id = a_id and nmap ->> h.id = k;
    end if;
    i := array_position(done, k);
    if i is null then
      done := done || k;
      acc := acc || jsonb_build_array(jsonb_build_object('key', k,
        'mode', case when p ->> 'mode' <> 'shows' or jsonb_array_length(ids) >= (groups ->> k)::int then 'all' else 'shows' end,
        'shows', ids)
        || case when rl <> '' then jsonb_build_object('role', rl) else '{}'::jsonb end);
    else
      -- the same group twice (two old spellings of one tour): merge
      old := acc -> (i - 1);
      select coalesce(jsonb_agg(h.id order by h.date nulls last, h.id), '[]'::jsonb) into u
        from artist_history_shows h
       where h.artist_id = a_id and nmap ->> h.id = k
         and ((old -> 'shows') ? h.id or (ids ? h.id));
      old := jsonb_set(old, '{shows}', u);
      old := jsonb_set(old, '{mode}', to_jsonb(case when old ->> 'mode' = 'all' or p ->> 'mode' <> 'shows'
                                                      or jsonb_array_length(u) >= (groups ->> k)::int
                                                    then 'all' else 'shows' end::text));
      if public.credit_role_join(old ->> 'role', rl) <> '' then
        old := old || jsonb_build_object('role', public.credit_role_join(old ->> 'role', rl));
      end if;
      acc := jsonb_set(acc, array[(i - 1)::text], old);
    end if;
  end loop;
  -- place the nights whose pick went away or pointed at another group
  for sid, srole in select e.key, e.value from jsonb_each_text(stray) e
  loop
    sgk := nmap ->> sid;
    continue when sgk is null or not (groups ? sgk);
    i := array_position(done, sgk);
    if i is not null then
      old := acc -> (i - 1);
      continue when (old -> 'shows') ? sid;
      old := jsonb_set(old, '{shows}', (old -> 'shows') || to_jsonb(sid));
      old := jsonb_set(old, '{mode}', to_jsonb(case when old ->> 'mode' = 'all'
                                                      or jsonb_array_length(old -> 'shows') >= (groups ->> sgk)::int
                                                    then 'all' else 'shows' end::text));
      if public.credit_role_join(old ->> 'role', srole) <> '' then
        old := old || jsonb_build_object('role', public.credit_role_join(old ->> 'role', srole));
      end if;
      acc := jsonb_set(acc, array[(i - 1)::text], old);
    else
      done := done || sgk;
      acc := acc || jsonb_build_array(jsonb_build_object('key', sgk,
        'mode', case when (groups ->> sgk)::int <= 1 then 'all' else 'shows' end,
        'shows', jsonb_build_array(sid))
        || case when srole <> '' then jsonb_build_object('role', srole) else '{}'::jsonb end);
    end if;
  end loop;
  if jsonb_array_length(acc) = 0 then
    raise exception 'nothing picked' using errcode = '22023';
  end if;
  if jsonb_array_length(acc) > 500 then
    raise exception 'picks' using errcode = '22023';
  end if;
  return jsonb_build_object('picks', acc, 'until', today);
end $function$;
revoke all on function public.credit_normalize(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.credit_normalize(uuid, jsonb) to service_role;


-- ============ 4. Counting and lists go by the group ============

-- credited_shows: its live text, with one change: the cover test gets the
-- night's GROUP key, set-based (one credit_night_gk join per confirmed
-- artist), so a whole-tour pick reaches the tour's other spellings and the
-- nights added later. credit_covers itself does not change.
CREATE OR REPLACE FUNCTION public.credited_shows(u uuid)
 RETURNS TABLE(artist_id uuid, show_id text, d date, city text, state text, country_code text, tkey text, tour text, venue text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- a member: every night of the artist; one who left, every night up to that day
  select h.artist_id, h.id, h.date, h.city, h.state, h.country_code, h.tkey, h.tour, h.venue
    from artist_members m
    join artist_history_shows h on h.artist_id = m.artist_id
   where m.user_id = u and m.kind = 'band'
     and (m.ended_at is null or h.date <= m.ended_at)
  union all
  -- crew: what the artist confirmed. Still listed, the claim runs on; left, it stops that day.
  select h.artist_id, h.id, h.date, h.city, h.state, h.country_code, h.tkey, h.tour, h.venue
    from tour_credits c
    cross join lateral (select public.credit_claim_live(c.artist_id, c.user_id, c.approved) as claim offset 0) k
    join artist_history_shows h on h.artist_id = c.artist_id
    join public.credit_night_gk(c.artist_id) g on g.id = h.id
   where c.user_id = u and c.approved is not null
     and not exists (select 1 from artist_members b where b.artist_id = c.artist_id and b.user_id = u and b.kind = 'band')
     and exists (select 1 from artist_endorsements e
                  where e.artist_id = c.artist_id and e.user_id = c.user_id and e.removed_at is null)
     and public.credit_covers(k.claim, h.id, h.date, g.gk)
$function$;
revoke all on function public.credited_shows(uuid) from public, anon, authenticated;
grant execute on function public.credited_shows(uuid) to service_role;

-- credit_expand: its live text, regrouped. It grouped by each night's raw key,
-- so one folded tour came back as several rows; now it groups by the night's
-- group key, named the way the page names the row (the owner's name for it if
-- one is set, else the commonest tour spelling, else the festival's name), and
-- the cover test and the role lookup get the group key.
CREATE OR REPLACE FUNCTION public.credit_expand(a_id uuid, claim jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with m as materialized (select * from public.credit_night_gk(a_id)),
       s as materialized (select g.gk, max(g.shown) as shown from public.artist_tour_groups(a_id) g group by g.gk)
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', x.gk, 'name', x.nm, 'year', x.gk like 'year:%',
      'total', x.total, 'n', x.n, 'first', x.d0, 'last', x.d1,
      'role', public.credit_role(claim, x.gk))
      order by x.d1 desc nulls last, x.gk), '[]'::jsonb)
    from (
      select m.gk,
             case when m.gk like 'year:%' then ''
                  else coalesce(max(s.shown),
                                mode() within group (order by nullif(h.tour, '')),
                                mode() within group (order by nullif(h.festival, '')), '') end as nm,
             count(*) filter (where h.date is null or h.date <= current_date) as total,
             count(*) filter (where public.credit_covers(claim, h.id, h.date, m.gk)) as n,
             min(h.date) filter (where public.credit_covers(claim, h.id, h.date, m.gk)) as d0,
             max(h.date) filter (where public.credit_covers(claim, h.id, h.date, m.gk)) as d1
        from artist_history_shows h
        join m on m.id = h.id
        left join s on s.gk = m.gk
       where h.artist_id = a_id and claim is not null
       group by m.gk
      having count(*) filter (where public.credit_covers(claim, h.id, h.date, m.gk)) > 0) x
$function$;
revoke all on function public.credit_expand(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.credit_expand(uuid, jsonb) to service_role;

-- credit_counts: its live text, with one change: the covered nights are found
-- by the night's group key (one set-based join), so the queue's and the asks'
-- numbers agree with the page and the profile. The tours and shows arithmetic
-- is untouched.
CREATE OR REPLACE FUNCTION public.credit_counts(a_id uuid, claim jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with g as materialized (select * from public.artist_tour_groups(a_id)),
       m as materialized (select * from public.credit_night_gk(a_id)),
       n as (select h.date, h.venue, h.tour from artist_history_shows h
              join m on m.id = h.id
              where h.artist_id = a_id and claim is not null and h.date <= current_date
                and public.credit_covers(claim, h.id, h.date, m.gk))
  select jsonb_build_object(
    'tours', (select count(distinct g.gk) from n join g on g.tour = n.tour where n.tour <> '' and not g.hidden),
    'shows', (select count(distinct (n.date, lower(n.venue))) from n))
$function$;
revoke all on function public.credit_counts(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.credit_counts(uuid, jsonb) to service_role;

-- credit_shows (the picker's detail: the nights under one row): its live text
-- listed nights by raw key, which could not show a folded row whole. Now a
-- row's key brings the group's nights, every spelling - exactly the nights
-- the page's row holds.
CREATE OR REPLACE FUNCTION public.credit_shows(a_id uuid, t_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.can_claim_credits(a_id) then return null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', h.id, 'date', h.date, 'city', h.city, 'state', h.state,
             'country', h.country_code, 'venue', h.venue) order by h.date nulls last, h.id)
      from artist_history_shows h
      join public.credit_night_gk(a_id) m on m.id = h.id
     where h.artist_id = a_id and m.gk = t_key and (h.date is null or h.date <= current_date)), '[]'::jsonb);
end $function$;
revoke all on function public.credit_shows(uuid, text) from public, anon;
grant execute on function public.credit_shows(uuid, text) to authenticated, service_role;


-- ============ 5. "I was on this tour" claims the group whole ============

-- add_tour_credit: its live text, reworked where it disagrees with the fold.
-- It already resolved the tour's name through artist_tour_key_of, but then
-- spelled the claim out as one pick per raw key, which the new normalize would
-- fold anyway and which left later spellings behind. Now it writes ONE whole
-- pick for the group; the festival spillover (a festival night filed under
-- another tour's group) and the nothing-is-lost repair are keyed by the
-- night's group key too.
CREATE OR REPLACE FUNCTION public.add_tour_credit(a_id uuid, tour_name text, r text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_me uuid := auth.uid();
  v_name text := btrim(coalesce(tour_name, ''));
  v_role text := left(btrim(regexp_replace(coalesce(r, ''), '\s+', ' ', 'g')), 160);
  v_gk text; v_has boolean; v_trans jsonb; v_base jsonb; v_old jsonb; v_picks jsonb := '[]'::jsonb;
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
  -- does the page's row hold any played night? (the group's nights, every spelling)
  select exists (select 1 from public.credit_night_gk(a_id) m
                  where m.gk = v_gk and (m.d is null or m.d <= current_date)) into v_has;
  -- raw key -> the group key that owns it, for reading what they already have
  -- (a year key is nobody's spelling and never translates)
  select coalesce(jsonb_object_agg(t.k, t.gk), '{}'::jsonb) into v_trans
    from (select h.tkey as k, min(m.gk) as gk
            from artist_history_shows h
            join public.credit_night_gk(a_id) m on m.id = h.id
           where h.artist_id = a_id and h.tour <> '' and h.tkey not like 'year:%'
           group by h.tkey) t;

  -- what they have, as it is, less the picks this tour now brings whole
  for v_p in select x.p from jsonb_array_elements(v_old) with ordinality x(p, o) order by x.o
  loop
    if jsonb_typeof(v_p) = 'object'
       and coalesce(v_trans ->> (v_p ->> 'key'), v_p ->> 'key') is distinct from v_gk then
      v_picks := v_picks || jsonb_build_array(v_p);
    end if;
  end loop;
  if v_has then
    v_changed := not exists (
      select 1 from jsonb_array_elements(v_old) o(p)
       where coalesce(v_trans ->> (o.p ->> 'key'), o.p ->> 'key') = v_gk and o.p ->> 'mode' = 'all'
         and coalesce(btrim(o.p ->> 'role'), '') = v_role);
    v_picks := v_picks || jsonb_build_array(jsonb_build_object('key', v_gk, 'mode', 'all')
                 || case when v_role <> '' then jsonb_build_object('role', v_role) else '{}'::jsonb end);
  end if;

  -- a festival's nights that sit under another tour's group
  for v_f in
    select m.gk as k, jsonb_agg(h.id order by h.date nulls last, h.id) as ids
      from artist_history_shows h
      join public.credit_night_gk(a_id) m on m.id = h.id
     where h.artist_id = a_id and h.festival <> ''
       and public.artist_tour_gkey(a_id, h.festival) = v_gk
       and (h.date is null or h.date <= current_date)
       and m.gk <> v_gk
     group by m.gk
  loop
    v_had := null;
    select x.p into v_had from jsonb_array_elements(v_picks) x(p) where x.p ->> 'key' = v_f.k limit 1;
    if v_had is null then
      v_picks := v_picks || jsonb_build_array(jsonb_build_object('key', v_f.k, 'mode', 'shows', 'shows', v_f.ids)
                   || case when v_role <> '' then jsonb_build_object('role', v_role) else '{}'::jsonb end);
      v_changed := true;
    elsif v_had ->> 'mode' = 'shows' then
      if not (coalesce(v_had -> 'shows', '[]'::jsonb) @> v_f.ids)
         or public.credit_role_join(v_had ->> 'role', v_role) is distinct from coalesce(btrim(v_had ->> 'role'), '') then
        v_changed := true;
      end if;
      select coalesce(jsonb_agg(x.p order by x.o), '[]'::jsonb) into v_picks
        from jsonb_array_elements(v_picks) with ordinality x(p, o)
       where x.p ->> 'key' is distinct from v_f.k;
      v_picks := v_picks || jsonb_build_array(jsonb_build_object('key', v_f.k, 'mode', 'shows',
                   'shows', (select jsonb_agg(distinct u.id)
                               from (select jsonb_array_elements_text(
                                              case when jsonb_typeof(v_had -> 'shows') = 'array' then v_had -> 'shows' else '[]'::jsonb end) as id
                                     union all
                                     select jsonb_array_elements_text(v_f.ids)) u),
                   'role', public.credit_role_join(v_had ->> 'role', v_role)));
    end if;
    -- (a whole pick of that key already has the night)
  end loop;

  if not v_has and not v_changed and not exists (
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
     listed night only while it is still under the group it was listed for. A
     night that has since been put under another tour (the nightly naming, the
     tour finder, the page's owner) would fall out here and the person's shows
     would go down on "add". So every night the old claim reaches today that
     the new one would not is put back, as a listed night of the group it sits
     under now. */
  if v_base is not null and jsonb_array_length(v_picks) > 0 then
    v_new := public.credit_normalize(a_id, jsonb_build_object('picks', v_picks)) - 'until';
    for v_f in
      select m.gk as k, jsonb_agg(h.id order by h.date nulls last, h.id) as ids
        from artist_history_shows h
        join public.credit_night_gk(a_id) m on m.id = h.id
       where h.artist_id = a_id and (h.date is null or h.date <= current_date)
         and public.credit_covers(v_base - 'until', h.id, h.date, m.gk)
         and not public.credit_covers(v_new, h.id, h.date, m.gk)
       group by m.gk
    loop
      v_had := null;
      select x.p into v_had from jsonb_array_elements(v_picks) x(p) where x.p ->> 'key' = v_f.k limit 1;
      if v_had is null then
        v_picks := v_picks || jsonb_build_array(jsonb_build_object('key', v_f.k, 'mode', 'shows', 'shows', v_f.ids));
      elsif v_had ->> 'mode' = 'shows' then
        select coalesce(jsonb_agg(x.p order by x.o), '[]'::jsonb) into v_picks
          from jsonb_array_elements(v_picks) with ordinality x(p, o)
         where x.p ->> 'key' is distinct from v_f.k;
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
grant execute on function public.add_tour_credit(uuid, text, text) to authenticated, service_role;


-- ============ 6. The claims already written move to group keys ============

-- By rule, never by name: every stored pick key (approved, pending AND
-- declined) that is not already a group key is rewritten to the group key
-- that owns it - the key the nights carrying that raw key fold to. Then two
-- picks left sharing one key MERGE (a whole-tour pick wins, ticked nights
-- union, roles joined): a claim must never hold the same key twice, or the
-- next edit on a phone would keep only one of the pair. And a listed night
-- whose group is not its pick's key (a festival night inside a year pick,
-- after 0147 gave festivals their own keys) MOVES to its own group's pick,
-- so the next normalize cannot drop it. Mode, shows, role and until are
-- otherwise kept exactly; a key the artist's nights no longer explain is left
-- as it is, its nights safe by id. Nobody's confirmed shows shrink. The seat
-- trigger is off while this runs, exactly as 0147's data fix had it; at the
-- end, the approved claims this fix changed are touched once with the trigger
-- back on, so anyone whose cover widened gets the seat they are now owed.
-- Declined claims cover nothing: translating them only makes the confirm
-- sheet prefill honestly. No recount follows: no night changes here, and a
-- person's numbers are worked out live from these rows, not cached.
do $$
declare
  a record; r record; w text; v_claim jsonb; v_groups text[]; v_trans jsonb; v_nmap jsonb;
  v_picks jsonb; v_out jsonb; v_changed boolean; v_k text; v_nk text; x record;
  v_done text[]; v_i int; v_old jsonb; v_sid text; v_gk text; v_move jsonb; v_roles jsonb; e record;
begin
  create temp table _fix_touch (artist_id uuid, user_id uuid, primary key (artist_id, user_id)) on commit drop;
  alter table public.tour_credits disable trigger tour_credits_seat;
  for a in select distinct c.artist_id from tour_credits c
            where c.approved is not null or c.pending is not null or c.declined is not null
  loop
    -- this artist's group keys, night map and raw key -> group key, worked out once
    select coalesce(array_agg(distinct m.gk), '{}'::text[]),
           coalesce(jsonb_object_agg(m.id, m.gk), '{}'::jsonb)
      into v_groups, v_nmap
      from public.credit_night_gk(a.artist_id) m;
    select coalesce(jsonb_object_agg(t.k, t.gk), '{}'::jsonb) into v_trans
      from (select h.tkey as k, min(v_nmap ->> h.id) as gk
              from artist_history_shows h
             where h.artist_id = a.artist_id and h.tour <> '' and h.tkey not like 'year:%'
               and (v_nmap ? h.id)
             group by h.tkey) t;
    for r in select c.user_id, c.approved, c.pending, c.declined from tour_credits c
              where c.artist_id = a.artist_id
                and (c.approved is not null or c.pending is not null or c.declined is not null)
    loop
      foreach w in array array['approved', 'pending', 'declined'] loop
        v_claim := case w when 'approved' then r.approved when 'pending' then r.pending else r.declined end;
        continue when v_claim is null or jsonb_typeof(v_claim -> 'picks') is distinct from 'array';
        -- 1. translate every raw key to the group key that owns it
        v_picks := '[]'::jsonb; v_changed := false;
        for x in select p.p, p.o from jsonb_array_elements(v_claim -> 'picks') with ordinality p(p, o) order by p.o
        loop
          if jsonb_typeof(x.p) is distinct from 'object' then
            v_picks := v_picks || jsonb_build_array(x.p);
            continue;
          end if;
          v_k := x.p ->> 'key';
          v_nk := case when v_k is null then v_k
                       else coalesce(v_trans ->> v_k, v_k) end;
          if v_nk is distinct from v_k then
            v_changed := true;
            v_picks := v_picks || jsonb_build_array(x.p || jsonb_build_object('key', v_nk));
          else
            v_picks := v_picks || jsonb_build_array(x.p);
          end if;
        end loop;
        -- 2. merge picks left sharing one key: a whole-tour pick wins, ticked
        -- nights union, roles joined
        v_out := '[]'::jsonb; v_done := '{}';
        for x in select p.p, p.o from jsonb_array_elements(v_picks) with ordinality p(p, o) order by p.o
        loop
          v_k := case when jsonb_typeof(x.p) = 'object' then x.p ->> 'key' else null end;
          v_i := case when v_k is null then null else array_position(v_done, v_k) end;
          if v_k is null or v_i is null then
            -- every kept element gets a v_done entry (a sentinel for the
            -- keyless), so positions in v_done always line up with v_out
            v_done := v_done || coalesce(v_k, e'\x01raw' || x.o::text);
            v_out := v_out || jsonb_build_array(x.p);
          else
            v_changed := true;
            v_old := v_out -> (v_i - 1);
            select coalesce(jsonb_agg(distinct q.id), '[]'::jsonb) into v_move
              from (select jsonb_array_elements(case when jsonb_typeof(v_old -> 'shows') = 'array' then v_old -> 'shows' else '[]'::jsonb end) as id
                    union all
                    select jsonb_array_elements(case when jsonb_typeof(x.p -> 'shows') = 'array' then x.p -> 'shows' else '[]'::jsonb end)) q;
            v_old := jsonb_set(v_old, '{shows}', v_move);
            v_old := jsonb_set(v_old, '{mode}', to_jsonb(case when v_old ->> 'mode' = 'all' or x.p ->> 'mode' = 'all'
                                                              then 'all' else 'shows' end::text));
            if public.credit_role_join(v_old ->> 'role', x.p ->> 'role') <> '' then
              v_old := v_old || jsonb_build_object('role', public.credit_role_join(v_old ->> 'role', x.p ->> 'role'));
            end if;
            v_out := jsonb_set(v_out, array[(v_i - 1)::text], v_old);
          end if;
        end loop;
        v_picks := v_out;
        -- 3. a listed night whose group is not its pick's key moves to its
        -- own group's pick (made if need be), with the role it was sent with
        v_move := '{}'::jsonb; v_roles := '{}'::jsonb;
        v_out := '[]'::jsonb; v_done := '{}';
        for x in select p.p, p.o from jsonb_array_elements(v_picks) with ordinality p(p, o) order by p.o
        loop
          if jsonb_typeof(x.p) is distinct from 'object' or jsonb_typeof(x.p -> 'shows') is distinct from 'array'
             or (x.p ->> 'key') is null then
            v_done := v_done || coalesce(case when jsonb_typeof(x.p) = 'object' then x.p ->> 'key' end,
                                         e'\x01raw' || x.o::text);
            v_out := v_out || jsonb_build_array(x.p);
            continue;
          end if;
          v_k := x.p ->> 'key';
          v_old := '[]'::jsonb;
          for v_sid in select jsonb_array_elements_text(x.p -> 'shows')
          loop
            v_gk := v_nmap ->> v_sid;
            if v_gk is not null and v_gk <> v_k and v_gk = any (v_groups) then
              v_changed := true;
              v_move := v_move || jsonb_build_object(v_sid, v_gk);
              if coalesce(x.p ->> 'role', '') <> '' then
                v_roles := v_roles || jsonb_build_object(v_gk, public.credit_role_join(v_roles ->> v_gk, x.p ->> 'role'));
              end if;
            else
              v_old := v_old || to_jsonb(v_sid);
            end if;
          end loop;
          if jsonb_array_length(v_old) = 0 and jsonb_array_length(x.p -> 'shows') > 0
             and coalesce(x.p ->> 'mode', '') = 'shows' then
            continue;  -- every night it held moved away: nothing left to keep
          end if;
          v_done := v_done || v_k;
          v_out := v_out || jsonb_build_array(jsonb_set(x.p, '{shows}', v_old));
        end loop;
        for e in select m.key as sid, m.value as gk from jsonb_each_text(v_move) m
        loop
          v_i := array_position(v_done, e.gk);
          if v_i is not null then
            v_old := v_out -> (v_i - 1);
            if coalesce(v_roles ->> e.gk, '') <> ''
               and public.credit_role_join(v_old ->> 'role', v_roles ->> e.gk) <> '' then
              v_old := v_old || jsonb_build_object('role', public.credit_role_join(v_old ->> 'role', v_roles ->> e.gk));
            end if;
            if not (jsonb_typeof(v_old -> 'shows') = 'array' and (v_old -> 'shows') ? e.sid) then
              v_old := jsonb_set(v_old, '{shows}',
                (case when jsonb_typeof(v_old -> 'shows') = 'array' then v_old -> 'shows' else '[]'::jsonb end) || to_jsonb(e.sid));
            end if;
            v_out := jsonb_set(v_out, array[(v_i - 1)::text], v_old);
          else
            v_done := v_done || e.gk;
            v_out := v_out || jsonb_build_array(jsonb_build_object('key', e.gk, 'mode', 'shows',
              'shows', jsonb_build_array(e.sid))
              || case when coalesce(v_roles ->> e.gk, '') <> '' then jsonb_build_object('role', v_roles ->> e.gk) else '{}'::jsonb end);
          end if;
        end loop;
        v_picks := v_out;
        continue when not v_changed;
        if w = 'approved' then
          update tour_credits set approved = jsonb_set(v_claim, '{picks}', v_picks)
           where artist_id = a.artist_id and user_id = r.user_id;
          insert into _fix_touch values (a.artist_id, r.user_id) on conflict do nothing;
        elsif w = 'pending' then
          update tour_credits set pending = jsonb_set(v_claim, '{picks}', v_picks)
           where artist_id = a.artist_id and user_id = r.user_id;
        else
          update tour_credits set declined = jsonb_set(v_claim, '{picks}', v_picks)
           where artist_id = a.artist_id and user_id = r.user_id;
        end if;
      end loop;
    end loop;
  end loop;
  alter table public.tour_credits enable trigger tour_credits_seat;
  -- anyone whose approved cover was rewritten may now be owed a seat on an
  -- older tour: seat them directly (an update that changes nothing would not
  -- reach the seat function - its trigger only acts when approved changes)
  for r in select f.artist_id, f.user_id from _fix_touch f loop
    begin
      perform public.seat_from_artist(r.artist_id, r.user_id);
    exception when others then
      raise log 'seat after key rewrite skipped: %', sqlerrm;
    end;
  end loop;
end $$;


-- The per-tour buttons on the artist page (my_tour_claims, 0146) make the
-- same cover and role checks night by night; they too now go by the night's
-- group key, so a row the page folds reads covered the moment the folded
-- claim covers it. From its live text with only those values changed.
CREATE OR REPLACE FUNCTION public.my_tour_claims(a_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
                public.credit_covers(v_app, h.id, h.date, k.gk) as a,
                public.credit_covers(v_pen, h.id, h.date, k.gk) as p,
                public.credit_covers(v_dec, h.id, h.date, k.gk) as d,
                k.gk
           from artist_history_shows h
           join public.credit_night_gk(a_id) k on k.id = h.id
          where h.artist_id = a_id and (v_app is not null or v_pen is not null or v_dec is not null)),
       t as (
         -- the page's tours, grouped and named as its summary groups and names them
         select coalesce(max(g.shown), mode() within group (order by n.tour)) as nm,
                bool_or(n.a) as a, bool_or(n.p) as p, bool_or(n.d) as d,
                -- part: a played night of it is in neither what was confirmed nor what is waiting
                coalesce(bool_or(n.played and not n.a and not n.p), false) as part,
                string_agg(distinct nullif(public.credit_role(v_app, n.gk), ''), ', ') filter (where n.a) as ra,
                string_agg(distinct nullif(public.credit_role(v_pen, n.gk), ''), ', ') filter (where n.p) as rp,
                string_agg(distinct nullif(public.credit_role(v_dec, n.gk), ''), ', ') filter (where n.d) as rd
           from n join tg g on g.tour = n.tour
          where not g.hidden
          group by g.gk
         having bool_or(n.a) or bool_or(n.p) or bool_or(n.d)
         union all
         -- its festivals that are not also a tour label
         select n.festival, bool_or(n.a), bool_or(n.p), bool_or(n.d),
                coalesce(bool_or(n.played and not n.a and not n.p), false),
                string_agg(distinct nullif(public.credit_role(v_app, n.gk), ''), ', ') filter (where n.a),
                string_agg(distinct nullif(public.credit_role(v_pen, n.gk), ''), ', ') filter (where n.p),
                string_agg(distinct nullif(public.credit_role(v_dec, n.gk), ''), ', ') filter (where n.d)
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

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
-- credit_tours and credit_shows back to 0071's text, credit_normalize and
-- my_tour_claims back to 0146's, add_tour_credit back to 0146's, credited_shows back to 0145's, credit_expand
-- back to 0146's, credit_counts back to 0145's, then:
--   drop function if exists public.credit_night_gk(uuid);
--   notify pgrst, 'reload schema';
-- The rewritten pick keys stay as they are: a group key is a real key of the
-- page (the old cover test matches it on the nights spelled that way, and
-- every pick still holds its shows by id), so nothing shrinks on the way back
-- either. The split rows simply return to the picker.
