-- Tour credits, and the role an artist gives each of its people.
--
-- Devin: when an artist endorses someone it asks "what was their role" —
-- the title the public sees on the artist's page (Brent is "Guitar" there,
-- whatever he is behind the scenes). And the person it endorsed is asked to
-- "confirm the shows and tours you've done with" that artist: ALL TOURS, or
-- tour by tour, each one the entire tour or just the shows they were on.
-- Nothing shows on their page until the artist says yes. Once it does, those
-- nights count in their road story — tours, shows, countries, cities — the
-- same four numbers (and the same badges) an artist's page carries.
--
-- The nights themselves stay where they are (the artist's synced history);
-- a credit only points at them, so it holds none of the borrowed data and
-- simply reads empty if the artist switches its history off.

-- 1. Every night knows its group: the tour it belongs to, keyed by sound the
-- way the summary groups them, or — a third of a band's nights sit outside
-- any named tour — the year it was played ("year:2024").
create or replace function public.credit_show_key(tour text, d date)
returns text
language sql immutable as $$
  select case
    when nullif(btrim(coalesce(public.setlist_tour_key(tour), '')), '') is not null
         and btrim(coalesce(tour, '')) <> ''
      then btrim(public.setlist_tour_key(tour))
    else 'year:' || coalesce(extract(year from d)::int, 0)::text
  end
$$;
revoke all on function public.credit_show_key(text, date) from public, anon, authenticated;

alter table public.artist_history_shows add column if not exists tkey text not null default '';
create or replace function public.history_show_key()
returns trigger
language plpgsql set search_path = public as $$
begin
  new.tkey := public.credit_show_key(new.tour, new.date);
  return new;
end $$;
revoke all on function public.history_show_key() from public, anon, authenticated;
drop trigger if exists history_show_key on public.artist_history_shows;
create trigger history_show_key before insert or update on public.artist_history_shows
  for each row execute function public.history_show_key();
update public.artist_history_shows set tkey = public.credit_show_key(tour, date);
create index if not exists artist_history_shows_key on public.artist_history_shows (artist_id, tkey);

-- 2. The role an artist gives a member: its word, shown on its page. Kept
-- with the endorsement too, so it outlives the listing like the trophy does.
alter table public.artist_members add column if not exists role text not null default '';
alter table public.artist_members drop constraint if exists artist_members_role_len;
alter table public.artist_members add constraint artist_members_role_len check (char_length(role) <= 40);
alter table public.artist_endorsements add column if not exists role text not null default '';

create or replace function public.endorsement_fill()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select a.name, a.handle into new.artist_name, new.artist_handle from artists a where a.id = new.artist_id;
  select m.kind, m.role into new.kind, new.role from artist_members m where m.artist_id = new.artist_id and m.user_id = new.user_id;
  new.artist_name := coalesce(new.artist_name, '');
  new.artist_handle := coalesce(new.artist_handle, '');
  new.kind := coalesce(new.kind, 'crew');
  new.role := coalesce(new.role, '');
  new.created_at := now();
  new.removed_at := null;
  return new;
end $$;
revoke all on function public.endorsement_fill() from public, anon, authenticated;

-- A role changed on the listing follows onto the endorsement.
create or replace function public.member_role_sync()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.role := left(btrim(coalesce(new.role, '')), 40);
  if tg_op = 'UPDATE' and new.role is distinct from old.role then
    update artist_endorsements set role = new.role
     where artist_id = new.artist_id and user_id = new.user_id;
  end if;
  return new;
end $$;
revoke all on function public.member_role_sync() from public, anon, authenticated;
drop trigger if exists member_role_sync on public.artist_members;
create trigger member_role_sync before insert or update on public.artist_members
  for each row execute function public.member_role_sync();

-- 3. The credits. One row per person per artist: what the artist said yes
-- to, and what is waiting on it. Each is {"all": true, "until": day} or
-- {"picks": [{"key", "mode": "all" | "shows", "shows": [night ids]}],
-- "until": day}. "until" is the day it was sent: a credit covers nights up
-- to then and no further, so "all tours" never grows on its own.
create table if not exists public.tour_credits (
  artist_id uuid not null references public.artists (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  approved jsonb,
  pending jsonb,
  declined jsonb,                       -- the last claim the artist sent back, kept to fix and resend
  submitted_at timestamptz,
  decided_at timestamptz,
  declined_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (artist_id, user_id)
);
alter table public.tour_credits add column if not exists declined jsonb;
create index if not exists tour_credits_user on public.tour_credits (user_id);
alter table public.tour_credits enable row level security;
-- The person and the artist's page read the row; everyone else sees what
-- was approved through the person's page. All writing goes through the
-- functions below.
drop policy if exists tour_credits_select on public.tour_credits;
create policy tour_credits_select on public.tour_credits for select
  using (user_id = auth.uid() or public.runs_artist(artist_id));
revoke all on public.tour_credits from public, anon, authenticated;
grant select on public.tour_credits to authenticated;

-- Is this night inside this claim? A claim names nights, not tags: fans
-- re-tag setlists all the time (a loose 2026 night gets its tour's name a
-- month later), and a confirmed night must not fall out of someone's story
-- because of it. So "entire tour" is frozen into that tour's nights when it's
-- sent, and only ALL TOURS reads by date.
drop function if exists public.credit_covers(jsonb, text, text, date);
create or replace function public.credit_covers(claim jsonb, show_id text, d date)
returns boolean
language sql stable as $$
  select claim is not null
     and (d is null or d <= coalesce(nullif(claim ->> 'until', '')::date, current_date))
     and (coalesce(claim ->> 'all', '') = 'true'
          or exists (select 1 from jsonb_array_elements(
                       case when jsonb_typeof(claim -> 'picks') = 'array' then claim -> 'picks' else '[]'::jsonb end) p
                      where jsonb_typeof(p -> 'shows') = 'array' and (p -> 'shows') ? show_id))
$$;
revoke all on function public.credit_covers(jsonb, text, date) from public, anon, authenticated;

-- The nights an artist has confirmed for someone.
drop function if exists public.credited_shows(uuid);
create or replace function public.credited_shows(u uuid)
returns table (artist_id uuid, show_id text, d date, city text, state text, country_code text, tkey text, tour text)
language sql stable security definer set search_path = public as $$
  select h.artist_id, h.id, h.date, h.city, h.state, h.country_code, h.tkey, h.tour
    from tour_credits c
    join artist_history_shows h on h.artist_id = c.artist_id
   where c.user_id = u and c.approved is not null
     -- the artist's word still stands (the trophy wasn't taken off)
     and exists (select 1 from artist_endorsements e
                  where e.artist_id = c.artist_id and e.user_id = c.user_id and e.removed_at is null)
     and public.credit_covers(c.approved, h.id, h.date)
$$;
revoke all on function public.credited_shows(uuid) from public, anon, authenticated;

-- A claim laid out group by group: each tour (or year of loose nights) it
-- touches, how many of that group's nights it covers, and when.
create or replace function public.credit_expand(a_id uuid, claim jsonb)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', x.tkey, 'name', x.nm, 'year', x.tkey like 'year:%',
      'total', x.total, 'n', x.n, 'first', x.d0, 'last', x.d1)
      order by x.d1 desc nulls last, x.tkey), '[]'::jsonb)
    from (
      select h.tkey,
             case when h.tkey like 'year:%' then '' else mode() within group (order by h.tour) end as nm,
             count(*) filter (where h.date is null or h.date <= current_date) as total,
             count(*) filter (where public.credit_covers(claim, h.id, h.date)) as n,
             min(h.date) filter (where public.credit_covers(claim, h.id, h.date)) as d0,
             max(h.date) filter (where public.credit_covers(claim, h.id, h.date)) as d1
        from artist_history_shows h
       where h.artist_id = a_id and claim is not null
       group by h.tkey
      having count(*) filter (where public.credit_covers(claim, h.id, h.date)) > 0) x
$$;
revoke all on function public.credit_expand(uuid, jsonb) from public, anon, authenticated;

-- ...and boiled down to two numbers: tours and shows.
create or replace function public.credit_counts(a_id uuid, claim jsonb)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'tours', count(*) filter (where not (g ->> 'year')::boolean),
    'shows', coalesce(sum((g ->> 'n')::int), 0))
    from jsonb_array_elements(public.credit_expand(a_id, claim)) g
$$;
revoke all on function public.credit_counts(uuid, jsonb) from public, anon, authenticated;

-- Who may open an artist's list of tours to claim from: someone it has
-- endorsed (and hasn't had that taken off), or the account that runs it.
create or replace function public.can_claim_credits(a_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    public.runs_artist(a_id)
    or exists (select 1 from artist_endorsements e
                where e.artist_id = a_id and e.user_id = auth.uid() and e.removed_at is null))
$$;
revoke all on function public.can_claim_credits(uuid) from public, anon;
grant execute on function public.can_claim_credits(uuid) to authenticated;

-- The page a person confirms from: every tour the artist has played (nights
-- already played only), the loose nights by year, and their own claim so far.
create or replace function public.credit_tours(a_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a public.artists%rowtype;
begin
  if not public.can_claim_credits(a_id) then return null; end if;
  select * into a from artists where id = a_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'artistId', a.id, 'artist', a.name,
    'owner', a.owner_id = auth.uid(),
    'endorsed', exists (select 1 from artist_endorsements e
                         where e.artist_id = a.id and e.user_id = auth.uid() and e.removed_at is null),
    'url', coalesce((select h.mb_url from artist_history h where h.artist_id = a.id), ''),
    'tours', coalesce((
      select jsonb_agg(jsonb_build_object('key', g.tkey, 'name', g.nm, 'year', g.tkey like 'year:%',
               'n', g.n, 'first', g.d0, 'last', g.d1) order by g.d1 desc nulls last, g.tkey)
        from (
          select h.tkey,
                 case when h.tkey like 'year:%' then '' else mode() within group (order by h.tour) end as nm,
                 count(*) as n, min(h.date) as d0, max(h.date) as d1
            from artist_history_shows h
           where h.artist_id = a.id and (h.date is null or h.date <= current_date)
           group by h.tkey) g), '[]'::jsonb),
    'mine', (select jsonb_build_object('approved', c.approved, 'pending', c.pending, 'declined', c.declined,
                      'declinedAt', c.declined_at, 'submittedAt', c.submitted_at)
               from tour_credits c where c.artist_id = a.id and c.user_id = auth.uid()));
end $$;
revoke all on function public.credit_tours(uuid) from public, anon;
grant execute on function public.credit_tours(uuid) to authenticated;

-- One tour's nights (or one year's loose nights), for "specific shows".
create or replace function public.credit_shows(a_id uuid, t_key text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_claim_credits(a_id) then return null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', h.id, 'date', h.date, 'city', h.city, 'state', h.state,
             'country', h.country_code, 'venue', h.venue) order by h.date nulls last, h.id)
      from artist_history_shows h
     where h.artist_id = a_id and h.tkey = t_key and (h.date is null or h.date <= current_date)), '[]'::jsonb);
end $$;
revoke all on function public.credit_shows(uuid, text) from public, anon;
grant execute on function public.credit_shows(uuid, text) to authenticated;

-- What the app sent, made honest: only groups this artist really has, only
-- nights that are really in them, a whole tour said plainly when every
-- night of it was ticked, and stamped with today.
create or replace function public.credit_normalize(a_id uuid, claim jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare acc jsonb := '[]'::jsonb; p jsonb; k text; groups jsonb; ids jsonb; done text[] := '{}';
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
        'mode', case when jsonb_array_length(ids) >= (groups ->> k)::int then 'all' else 'shows' end, 'shows', ids));
    else
      -- The entire tour, as it stands today: its nights by name.
      select coalesce(jsonb_agg(h.id order by h.date nulls last, h.id), '[]'::jsonb) into ids
        from artist_history_shows h
       where h.artist_id = a_id and h.tkey = k and (h.date is null or h.date <= current_date);
      acc := acc || jsonb_build_array(jsonb_build_object('key', k, 'mode', 'all', 'shows', ids));
    end if;
  end loop;
  if jsonb_array_length(acc) = 0 then
    raise exception 'nothing picked' using errcode = '22023';
  end if;
  return jsonb_build_object('picks', acc, 'until', today);
end $$;
revoke all on function public.credit_normalize(uuid, jsonb) from public, anon, authenticated;

-- Sending it to the artist. Only someone the artist has endorsed. It waits
-- as pending (what was approved before stays up meanwhile) — unless the
-- person runs the artist's page themselves: then it's their own yes.
create or replace function public.submit_tour_credits(a_id uuid, claim jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); norm jsonb; own boolean;
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
  insert into tour_credits (artist_id, user_id, approved, pending, declined, submitted_at, decided_at, declined_at)
  values (a_id, me, case when own then norm end, case when own then null else norm end, null, now(),
          case when own then now() end, null)
  on conflict (artist_id, user_id) do update
    set approved = case when own then norm else tour_credits.approved end,
        pending = case when own then null else norm end,
        declined = null,
        submitted_at = now(),
        decided_at = case when own then now() else tour_credits.decided_at end,
        declined_at = null;
  return jsonb_build_object('ok', true, 'auto', own);
end $$;
revoke all on function public.submit_tour_credits(uuid, jsonb) from public, anon;
grant execute on function public.submit_tour_credits(uuid, jsonb) to authenticated;

-- The artist's answer. "seen" is the moment of the claim it looked at: if
-- the person sent a newer one since, nothing is approved unseen.
create or replace function public.decide_tour_credits(a_id uuid, u_id uuid, verdict text, seen timestamptz default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.runs_artist(a_id) then
    raise exception 'permission' using errcode = '42501';
  end if;
  if verdict = 'approve' then
    update tour_credits set approved = pending, pending = null, declined = null, decided_at = now(), declined_at = null
     where artist_id = a_id and user_id = u_id and pending is not null
       and (seen is null or submitted_at = seen);
    if not found then return jsonb_build_object('ok', false, 'why', 'changed'); end if;
  elsif verdict = 'decline' then
    update tour_credits set declined = pending, pending = null, decided_at = now(), declined_at = now()
     where artist_id = a_id and user_id = u_id and pending is not null
       and (seen is null or submitted_at = seen);
    if not found then return jsonb_build_object('ok', false, 'why', 'changed'); end if;
  elsif verdict = 'revoke' then
    update tour_credits set approved = null, decided_at = now()
     where artist_id = a_id and user_id = u_id and approved is not null;
    if not found then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  else
    raise exception 'verdict' using errcode = '22023';
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.decide_tour_credits(uuid, uuid, text, timestamptz) from public, anon;
grant execute on function public.decide_tour_credits(uuid, uuid, text, timestamptz) to authenticated;

-- Taking your own credits with an artist off your page, approved and waiting both.
create or replace function public.withdraw_tour_credits(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'permission' using errcode = '42501'; end if;
  delete from tour_credits where artist_id = a_id and user_id = auth.uid();
  return jsonb_build_object('ok', found);
end $$;
revoke all on function public.withdraw_tour_credits(uuid) from public, anon;
grant execute on function public.withdraw_tour_credits(uuid) to authenticated;

-- Someone's credits with one artist, laid out: what's approved, for anyone
-- who can see their page; what's waiting, for them and the artist only.
create or replace function public.credit_detail(a_id uuid, u_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
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
    'approved', public.credit_expand(a_id, c.approved),
    'pendingAll', inner_ and coalesce(c.pending ->> 'all', '') = 'true',
    'pending', case when inner_ and c.pending is not null then public.credit_expand(a_id, c.pending) end,
    'submittedAt', case when inner_ then c.submitted_at end,
    'declinedAt', case when inner_ then c.declined_at end);
end $$;
revoke all on function public.credit_detail(uuid, uuid) from public, anon;
grant execute on function public.credit_detail(uuid, uuid) to authenticated;

-- For the account that runs artist pages: every claim waiting on it.
create or replace function public.credit_queue()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'artistId', c.artist_id, 'artist', a.name, 'userId', c.user_id,
      'name', public.person_name(c.user_id), 'avatar', coalesce(p.avatar, ''),
      'submittedAt', c.submitted_at, 'all', coalesce(c.pending ->> 'all', '') = 'true',
      'hasApproved', c.approved is not null)
      || public.credit_counts(c.artist_id, c.pending) order by c.submitted_at), '[]'::jsonb)
    from tour_credits c
    join artists a on a.id = c.artist_id
    left join profiles p on p.user_id = c.user_id
   where auth.uid() is not null and a.owner_id = auth.uid() and c.pending is not null
     and exists (select 1 from artist_endorsements e
                  where e.artist_id = c.artist_id and e.user_id = c.user_id and e.removed_at is null)
$$;
revoke all on function public.credit_queue() from public, anon;
grant execute on function public.credit_queue() to authenticated;

-- For a person: every artist that has endorsed them and has a history to
-- confirm against, and where that stands — asked, waiting, confirmed, declined.
create or replace function public.my_credit_asks()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'artistId', a.id, 'artist', a.name, 'handle', a.handle, 'avatar', a.avatar,
      'owner', a.owner_id = auth.uid(),
      'at', e.created_at,
      'state', case when c.pending is not null then 'pending'
                    when c.approved is not null then 'approved'
                    when c.declined_at is not null then 'declined' else 'ask' end,
      'hasApproved', c.approved is not null,
      'submittedAt', c.submitted_at, 'declinedAt', c.declined_at)
      || case when c.approved is not null then public.credit_counts(a.id, c.approved)
              else jsonb_build_object('tours', 0, 'shows', 0) end
      order by e.created_at), '[]'::jsonb)
    from artist_endorsements e
    join artists a on a.id = e.artist_id
    left join tour_credits c on c.artist_id = a.id and c.user_id = e.user_id
   where auth.uid() is not null and e.user_id = auth.uid() and e.removed_at is null
     and exists (select 1 from artist_history_shows h where h.artist_id = a.id)
$$;
revoke all on function public.my_credit_asks() from public, anon;
grant execute on function public.my_credit_asks() to authenticated;

-- Taking an artist's endorsement off your page takes your tours with them
-- off too: the credits stand on the artist's word, and you've refused it.
create or replace function public.remove_endorsement(e_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare a_id uuid;
begin
  update artist_endorsements set removed_at = now()
   where id = e_id and user_id = auth.uid() and removed_at is null
  returning artist_id into a_id;
  if not found then return false; end if;
  if a_id is not null then
    delete from tour_credits where artist_id = a_id and user_id = auth.uid();
  end if;
  return true;
end $$;
revoke all on function public.remove_endorsement(uuid) from public, anon;
grant execute on function public.remove_endorsement(uuid) to authenticated;

-- 4. Which country a Greenroom show was in, read off the tail of its city
-- ("Austin, TX" is the US; "Toronto, ON" is Canada; "London, UK" is GB), in
-- the same two-letter codes the synced histories use, so one country is
-- never counted twice.
create or replace function public.road_country(city text)
returns text
language sql immutable as $$
  select case
    when coalesce(city, '') not like '%,%' then ''
    else (
      select case
        when x.t = any (array[
          'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
          'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
          'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
          'USA','US','UNITED STATES']) then 'US'
        when x.t = any (array['ON','QC','BC','AB','MB','SK','NS','NB','PE','YT','NT','NU','CANADA']) then 'CA'
        else coalesce((
          select m.code from (values
            ('UK','GB'),('UNITED KINGDOM','GB'),('ENGLAND','GB'),('SCOTLAND','GB'),('WALES','GB'),('NORTHERN IRELAND','GB'),
            ('GERMANY','DE'),('FRANCE','FR'),('SPAIN','ES'),('ITALY','IT'),('NETHERLANDS','NL'),('BELGIUM','BE'),
            ('AUSTRIA','AT'),('SWITZERLAND','CH'),('SWEDEN','SE'),('NORWAY','NO'),('DENMARK','DK'),('FINLAND','FI'),
            ('POLAND','PL'),('CZECHIA','CZ'),('CZECH REPUBLIC','CZ'),('IRELAND','IE'),('PORTUGAL','PT'),('HUNGARY','HU'),
            ('ROMANIA','RO'),('LUXEMBOURG','LU'),('ESTONIA','EE'),('LATVIA','LV'),('LITHUANIA','LT'),('RUSSIA','RU'),
            ('AUSTRALIA','AU'),('NEW ZEALAND','NZ'),('JAPAN','JP'),('CHINA','CN'),('SOUTH KOREA','KR'),('KOREA','KR'),
            ('SINGAPORE','SG'),('MALAYSIA','MY'),('THAILAND','TH'),('VIETNAM','VN'),('PHILIPPINES','PH'),
            ('INDONESIA','ID'),('MEXICO','MX'),('BRAZIL','BR'),('ARGENTINA','AR'),('CHILE','CL'),('COLOMBIA','CO')
          ) m(name, code) where m.name = x.t), x.t)
      end
      from (select upper(btrim(substring(city from ',([^,]*)$'))) as t) x)
  end
$$;
revoke all on function public.road_country(text) from public, anon, authenticated;

-- A US state's or Canadian province's two letters from its name (the synced
-- histories spell it out; Greenroom shows carry the letters), so "Portland,
-- OR" and Portland, Oregon are one city, and Portland, Maine is another.
create or replace function public.region_code(full_name text)
returns text
language sql immutable as $$
  select coalesce((
    select m.code from (values
      ('alabama','AL'),('alaska','AK'),('arizona','AZ'),('arkansas','AR'),('california','CA'),('colorado','CO'),
      ('connecticut','CT'),('delaware','DE'),('florida','FL'),('georgia','GA'),('hawaii','HI'),('idaho','ID'),
      ('illinois','IL'),('indiana','IN'),('iowa','IA'),('kansas','KS'),('kentucky','KY'),('louisiana','LA'),
      ('maine','ME'),('maryland','MD'),('massachusetts','MA'),('michigan','MI'),('minnesota','MN'),
      ('mississippi','MS'),('missouri','MO'),('montana','MT'),('nebraska','NE'),('nevada','NV'),
      ('new hampshire','NH'),('new jersey','NJ'),('new mexico','NM'),('new york','NY'),('north carolina','NC'),
      ('north dakota','ND'),('ohio','OH'),('oklahoma','OK'),('oregon','OR'),('pennsylvania','PA'),
      ('rhode island','RI'),('south carolina','SC'),('south dakota','SD'),('tennessee','TN'),('texas','TX'),
      ('utah','UT'),('vermont','VT'),('virginia','VA'),('washington','WA'),('west virginia','WV'),
      ('wisconsin','WI'),('wyoming','WY'),('district of columbia','DC'),('washington, d.c.','DC'),
      ('ontario','ON'),('quebec','QC'),('québec','QC'),('british columbia','BC'),('alberta','AB'),('manitoba','MB'),
      ('saskatchewan','SK'),('nova scotia','NS'),('new brunswick','NB'),('prince edward island','PE'),
      ('newfoundland and labrador','NL'),('yukon','YT'),('northwest territories','NT'),('nunavut','NU')
    ) m(name, code) where m.name = lower(btrim(coalesce(full_name, '')))), '')
$$;
revoke all on function public.region_code(text) from public, anon, authenticated;

-- 5. The artist's page hands out each member's role with the rest of the card.
create or replace function public.artist_card(a_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a public.artists%rowtype;
begin
  if auth.uid() is null then return null; end if;
  select * into a from artists where id = a_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', a.id, 'handle', a.handle, 'name', a.name, 'bio', a.bio, 'avatar', a.avatar,
    'mine', a.owner_id = auth.uid(),
    'followers', (select count(*) from artist_follows f where f.artist_id = a.id),
    'iFollow', exists (select 1 from artist_follows f where f.artist_id = a.id and f.user_id = auth.uid()),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
          'userId', m.user_id, 'kind', m.kind, 'role', coalesce(m.role, ''),
          'hasCredits', a.owner_id = auth.uid() and exists (select 1 from tour_credits tc
             where tc.artist_id = a.id and tc.user_id = m.user_id and tc.approved is not null),
          'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
          'handle', coalesce(p.handle, ''), 'avatar', coalesce(p.avatar, ''),
          'roles', to_jsonb(coalesce(p.roles, '{}'::text[])), 'tourRole', coalesce(p.tour_role, ''),
          'verified', exists (select 1 from verified_users v where v.user_id = m.user_id),
          'canOpen', public.can_see_profile(m.user_id),
          'endorsed', exists (select 1 from artist_endorsements e where e.artist_id = a.id and e.user_id = m.user_id and e.removed_at is null),
          -- They took this page's endorsement off theirs: its owner gets no Endorse button for them again.
          'declined', a.owner_id = auth.uid()
            and exists (select 1 from artist_endorsements e where e.artist_id = a.id and e.user_id = m.user_id and e.removed_at is not null))
        order by m.created_at)
      from artist_members m left join profiles p on p.user_id = m.user_id where m.artist_id = a.id), '[]'::jsonb),
    'tours', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', t.id, 'artist', a.name, 'name', trim(coalesce(t.doc ->> 'name', '')),
          'first', (select min(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x),
          'last', (select max(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x),
          'shows', jsonb_array_length(public.tour_dates(t.doc)),
          'mine', public.my_role(t.id) is not null)
        order by (select max(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x) desc nulls last, t.id)
      from public.artist_tours(a.id) t), '[]'::jsonb));
end $$;
revoke all on function public.artist_card(uuid) from public, anon;
grant execute on function public.artist_card(uuid) to authenticated;

-- 6. A person's page: the role each artist gave them, the road story with
-- their credits counted in, and the credits themselves.
create or replace function public.profile_card(u uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
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
    -- The artist profiles that list them as band or crew: the artist's own
    -- word for it. Then any artist that endorsed them and no longer lists
    -- them (they left, or the page is gone): the endorsement still stands.
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
         where m.user_id = u
        union all
        select jsonb_build_object('id', a.id, 'name', coalesce(a.name, nullif(e.artist_name, ''), 'An artist'),
                 'handle', coalesce(a.handle, e.artist_handle), 'avatar', coalesce(a.avatar, ''), 'kind', e.kind, 'role', coalesce(e.role, ''),
                 'endorsed', true, 'past', true, 'eid', case when u = auth.uid() then e.id end),
               e.created_at
          from artist_endorsements e left join artists a on a.id = e.artist_id
         where e.user_id = u and e.removed_at is null
           and not exists (select 1 from artist_members m where m.artist_id = e.artist_id and m.user_id = u)) x), '[]'::jsonb),
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
    'roadStats', (
      with gr as (
        select (e.v ->> 'date') as d,
               lower(btrim(split_part(coalesce(e.v ->> 'city', ''), ',', 1))) as city,
               public.road_country(e.v ->> 'city') as ctry,
               -- the state or province letters, where the country has them
               case when public.road_country(e.v ->> 'city') in ('US', 'CA')
                     and upper(btrim(substring(e.v ->> 'city' from ',([^,]*)$'))) ~ '^[A-Z]{2}$'
                    then upper(btrim(substring(e.v ->> 'city' from ',([^,]*)$'))) else '' end as region
          from public.tours_of(u) t,
               lateral jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e(k, v)
         where jsonb_typeof(e.v) = 'object'
           and (e.v ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
           and (e.v ->> 'date') <= to_char(current_date, 'YYYY-MM-DD')
      ), cr as (
        select s.artist_id, s.tkey, to_char(s.d, 'YYYY-MM-DD') as d,
               lower(btrim(s.city)) as city, upper(s.country_code) as ctry,
               case when upper(s.country_code) in ('US', 'CA') then public.region_code(s.state) else '' end as region,
               exists (select 1 from gr g where g.d = to_char(s.d, 'YYYY-MM-DD')) as dup
          from public.credited_shows(u) s
         where s.d is not null and s.d <= current_date
      ), nights as (
        select d, city, ctry, region from gr
        union all
        select d, city, ctry, region from cr where not dup
      )
      select jsonb_build_object(
        'tours', (select count(*) from public.tours_of(u))
               + (select count(*) from (select 1 from cr where tkey not like 'year:%'
                                         group by artist_id, tkey having not bool_or(dup)) x),
        'shows', (select count(distinct d) from nights),
        'cities', (select count(distinct (ctry, region, city)) from nights where city <> ''),
        'countries', (select count(distinct ctry) from nights where ctry <> ''),
        'firstYear', (select left(min(d), 4)::int from nights))),
    -- What each artist has confirmed for them, artist by artist...
    'credits', coalesce((
      select jsonb_agg(jsonb_build_object('artistId', c.artist_id) || public.credit_counts(c.artist_id, c.approved))
        from tour_credits c where c.user_id = u and c.approved is not null), '[]'::jsonb),
    -- ...and those tours by name, for their Tours tab.
    'creditTours', coalesce((
      select jsonb_agg(jsonb_build_object('artistId', x.artist_id, 'artist', x.artist, 'key', x.tkey, 'name', x.nm,
               'n', x.n, 'first', x.d0, 'last', x.d1) order by x.d1 desc nulls last, x.tkey)
        from (
          select s.artist_id, a.name as artist, s.tkey, mode() within group (order by s.tour) as nm,
                 count(*) as n, min(s.d) as d0, max(s.d) as d1
            from public.credited_shows(u) s join artists a on a.id = s.artist_id
           where s.tkey not like 'year:%' and (s.d is null or s.d <= current_date)
           group by s.artist_id, a.name, s.tkey
           order by max(s.d) desc nulls last
           limit 200) x), '[]'::jsonb),
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
end $$;
revoke all on function public.profile_card(uuid) from public, anon;
grant execute on function public.profile_card(uuid) to authenticated;

-- 7. An artist's own city count tells Portland, Oregon from Portland, Maine
-- too, the same way a person's does, so the two pages agree.
create or replace function public.setlist_summarize(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s jsonb;
begin
  select jsonb_build_object(
    'shows', count(*),
    'countries', count(distinct country_code) filter (where country_code <> ''),
    'cities', count(distinct (country_code, lower(state), lower(city))) filter (where city <> ''),
    'firstYear', min(extract(year from date))::int,
    'lastYear', max(extract(year from date))::int,
    'tours', (select count(*) from (
       select 1 from artist_history_shows h2
        where h2.artist_id = a_id and h2.tour <> ''
        group by public.setlist_tour_key(h2.tour)) x),
    'years', coalesce((select jsonb_object_agg(y, n) from (
       select extract(year from h3.date)::int as y, count(*) as n
         from artist_history_shows h3
        where h3.artist_id = a_id and h3.date is not null
        group by 1) yy), '{}'::jsonb),
    'toursList', coalesce((select jsonb_agg(jsonb_build_object(
         'name', t.name, 'n', t.n, 'first', t.first, 'last', t.last)
         order by t.last desc nulls last)
       from (
         select mode() within group (order by h4.tour) as name, count(*) as n,
                min(h4.date) as first, max(h4.date) as last
           from artist_history_shows h4
          where h4.artist_id = a_id and h4.tour <> ''
          group by public.setlist_tour_key(h4.tour)
          order by max(h4.date) desc nulls last
          limit 60) t), '[]'::jsonb),
    'countriesList', coalesce((select jsonb_agg(jsonb_build_object('name', c.country, 'n', c.n) order by c.n desc)
       from (
         select h5.country, count(*) as n
           from artist_history_shows h5
          where h5.artist_id = a_id and h5.country <> ''
          group by h5.country
          order by count(*) desc
          limit 60) c), '[]'::jsonb))
    into s
    from artist_history_shows h
   where h.artist_id = a_id;
  update artist_history set summary = coalesce(s, '{}'::jsonb) where artist_id = a_id;
  return s;
end $$;
revoke all on function public.setlist_summarize(uuid) from public, anon, authenticated;
select public.setlist_summarize(artist_id) from public.artist_history where summary <> '{}'::jsonb;


notify pgrst, 'reload schema';
