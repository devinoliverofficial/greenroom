-- Leaving keeps your history (Devin, 2026-10-10): "Removing a member wipes
-- that history off their page. I don't think that should be how it works.
-- Just because you were fired doesn't mean your history is erased. It just
-- means from the moment you were fired you are no longer listed on that
-- artist page and getting analytics added to your page for future tours.
-- This should be the same for crew as well." And who can do it: "when firing
-- a crew member anyone can do it. But when firing a member you need to get
-- the other members to endorse the decision."
--
-- Until now taking someone off an artist page deleted their listing. A member
-- lost every tour, show, city and country that came from the artist; a crew
-- person's confirmed tours snapped back to the day they had sent their claim.
--
-- Now a listing ends instead of being deleted:
--   * the person is off the artist page from that day (its people list, "my
--     artists", who can open whose profile, who can be endorsed);
--   * everything up to and including that day stays on their own page: a
--     member keeps every night of the artist up to it, and the artist's list
--     of tours, festivals and loose shows as it stood; a crew person keeps
--     the tours the artist confirmed for them, up to it;
--   * nothing after that day is added, and a claim sent later cannot reach
--     past it.
-- The one case where the listing is simply taken off, with nothing kept, is a
-- listing the artist has not endorsed that is either crew (who have nothing
-- from the artist until they are endorsed) or a member added less than a week
-- ago (the wrong account picked by mistake).
--
-- A crew person, or anyone leaving by their own choice, is off at once. A
-- member is off only when every other member of the artist has agreed; with
-- no other member there is nobody to ask. One "no" stops it.
--
-- Not in this one (the from / until build): each stretch with its own dates.
-- Listing the same person again picks up as if they had not left, and someone
-- who left as a member cannot be listed again as crew yet (one listing per
-- person holds one kind, and theirs holds their time as a member).

alter table public.artist_members
  add column if not exists ended_at date,
  add column if not exists ended_by uuid;

-- The claim as it counts today: still listed, it runs on (its own "until" day
-- is ignored); left, it stops the day they left; never listed, as written.
create or replace function public.credit_claim_live(a_id uuid, u_id uuid, claim jsonb)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when claim is null then null
    else coalesce((select case when m.ended_at is null then claim - 'until'
                               else claim || jsonb_build_object('until', to_char(m.ended_at, 'YYYY-MM-DD')) end
                     from artist_members m where m.artist_id = a_id and m.user_id = u_id), claim) end
$function$;
revoke all on function public.credit_claim_live(uuid, uuid, jsonb) from public, anon, authenticated;

-- The artist page's list of tours, festivals and loose shows as it stood on a
-- given day: what a member who left that day keeps on their own Tours tab.
-- Built the way setlist_summarize builds the page's own list, from the nights
-- up to that day. (A tour is tagged as the page tags it, from all its nights;
-- the count is the nights up to the day.)
create or replace function public.artist_list_until(a_id uuid, until date)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with tg as materialized (select * from public.artist_tour_groups(a_id)),
  fnames as materialized (
    select x.festival, public.artist_tour_gkey(a_id, x.festival) as gk
      from (select distinct f.festival from artist_history_shows f where f.artist_id = a_id and f.festival <> '') x),
  t as (
    select g.gk, max(g.shown) as shown, mode() within group (order by h.tour) as name,
           count(distinct (h.date, lower(h.venue))) filter (where h.date <= until) as n,
           count(distinct (h.date, lower(h.venue))) as n_all,
           min(h.date) filter (where h.date <= until) as first, max(h.date) filter (where h.date <= until) as last
      from artist_history_shows h join tg g on g.tour = h.tour
     where h.artist_id = a_id and not g.hidden
     group by g.gk
    having count(*) filter (where h.date <= until) > 0)
  select coalesce((select jsonb_agg(jsonb_build_object('name', coalesce(t.shown, t.name), 'n', t.n, 'first', t.first, 'last', t.last,
                     'kind', case when t.n_all <= 3 and t.gk in (select fe.gk from fnames fe) then 'festival' else 'tour' end)
                     order by t.last desc nulls last) from t), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object('name', f.festival, 'n', f.n, 'first', f.first, 'last', f.last, 'kind', 'festival')
                     order by f.last desc)
           from (select h7.festival, count(distinct (h7.date, lower(h7.venue))) as n, min(h7.date) as first, max(h7.date) as last
                   from artist_history_shows h7 join fnames fn on fn.festival = h7.festival
                  where h7.artist_id = a_id and h7.date <= until
                    and fn.gk not in (select g.gk from tg g)
                  group by h7.festival) f), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object('name', 'Shows outside a tour · ' || y.yr, 'key', 'year:' || y.yr, 'n', y.n,
                     'first', y.first, 'last', y.last, 'kind', 'shows') order by y.last desc)
           from (select extract(year from h8.date)::int as yr, count(distinct (h8.date, lower(h8.venue))) as n,
                        min(h8.date) as first, max(h8.date) as last
                   from artist_history_shows h8
                  where h8.artist_id = a_id and h8.tour = '' and h8.festival = '' and h8.date <= least(until, current_date)
                  group by 1) y), '[]'::jsonb)
$function$;
revoke all on function public.artist_list_until(uuid, date) from public, anon, authenticated;

-- A member asked to leave, waiting on the other members. Nobody reads or
-- writes this table directly: only the functions below.
create table if not exists public.member_removals (
  artist_id uuid not null references public.artists(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  asked_by uuid,
  asked_at timestamptz not null default now(),
  agreed uuid[] not null default '{}',
  primary key (artist_id, user_id)
);
alter table public.member_removals enable row level security;
revoke all on public.member_removals from public, anon, authenticated;

-- How many of the other members have not agreed yet.
create or replace function public.member_removal_waiting(a_id uuid, u_id uuid)
 returns int
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select count(*)::int from artist_members m
   where m.artist_id = a_id and m.kind = 'band' and m.ended_at is null and m.user_id <> u_id
     and not exists (select 1 from member_removals r
                      where r.artist_id = a_id and r.user_id = u_id and m.user_id = any(r.agreed))
$function$;
revoke all on function public.member_removal_waiting(uuid, uuid) from public, anon, authenticated;

-- A member the page can no longer simply take back: endorsed, or listed for
-- more than a week. (Inside the week, unendorsed, it is a slip of the finger.)
create or replace function public.member_settled(a_id uuid, u_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (select 1 from artist_members m
                  where m.artist_id = a_id and m.user_id = u_id and m.kind = 'band'
                    and (m.created_at <= now() - interval '7 days'
                         or exists (select 1 from artist_endorsements e
                                     where e.artist_id = a_id and e.user_id = u_id and e.removed_at is null)))
$function$;
revoke all on function public.member_settled(uuid, uuid) from public, anon, authenticated;

-- What an edit made straight on the table can and cannot do (the account that
-- runs a page may insert and update its rows). The day someone left is written
-- only by the functions below. A row cannot be handed to another person or
-- another artist. A settled member is not turned into crew by an edit: that is
-- letting a member go, which takes the other members.
create or replace function public.artist_members_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(current_setting('greenroom.member_end', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' then
    new.ended_at := null; new.ended_by := null;
    return new;
  end if;
  if new.artist_id is distinct from old.artist_id or new.user_id is distinct from old.user_id then
    raise exception 'a listing cannot be moved' using errcode = '42501';
  end if;
  new.ended_at := old.ended_at;
  new.ended_by := old.ended_by;
  if old.ended_at is null and old.kind = 'band' and new.kind = 'crew'
     and public.member_settled(old.artist_id, old.user_id) then
    new.kind := old.kind;
  end if;
  return new;
end $function$;
revoke all on function public.artist_members_guard() from public, anon, authenticated;
drop trigger if exists artist_members_guard on public.artist_members;
create trigger artist_members_guard before insert or update on public.artist_members
  for each row execute function public.artist_members_guard();

-- Adding someone who had left lists them again (the app adds with an upsert,
-- which names the kind; saving a role does not). Someone who left as a member
-- cannot come back as crew yet: their listing holds their time as a member.
create or replace function public.artist_members_relist()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(current_setting('greenroom.member_end', true), '') = '1' then return new; end if;
  if old.ended_at is null then return new; end if;
  if old.kind = 'band' and new.kind = 'crew' then
    raise exception 'former_member' using errcode = 'P0001';
  end if;
  delete from member_removals r where r.artist_id = old.artist_id and r.user_id = old.user_id;
  new.ended_at := null;
  new.ended_by := null;
  new.created_at := now();
  return new;
end $function$;
revoke all on function public.artist_members_relist() from public, anon, authenticated;
drop trigger if exists artist_members_relist on public.artist_members;
create trigger artist_members_relist before update of kind on public.artist_members
  for each row execute function public.artist_members_relist();

-- Nobody deletes a listing from the app any more (that erased the person's
-- history, and an older build still tries): it ends, through end_artist_member.
drop policy if exists artist_members_delete on public.artist_members;

-- Only someone listed now can be endorsed.
drop policy if exists artist_endorsements_insert on public.artist_endorsements;
create policy artist_endorsements_insert on public.artist_endorsements for insert to authenticated
  with check (artist_id is not null and public.runs_artist(artist_id) and endorsed_by = auth.uid()
    and exists (select 1 from public.artist_members m
                 where m.artist_id = artist_endorsements.artist_id and m.user_id = artist_endorsements.user_id
                   and m.ended_at is null));

create or replace function public.credited_shows(u uuid)
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
   where c.user_id = u and c.approved is not null
     and not exists (select 1 from artist_members b where b.artist_id = c.artist_id and b.user_id = u and b.kind = 'band')
     and exists (select 1 from artist_endorsements e
                  where e.artist_id = c.artist_id and e.user_id = c.user_id and e.removed_at is null)
     and public.credit_covers(k.claim, h.id, h.date)
$function$;

create or replace function public.profile_card(u uuid)
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
               e ->> 'first' as d0, e ->> 'last' as d1, coalesce(e ->> 'kind', 'tour') as kind
          from band b
          cross join lateral jsonb_array_elements(case when jsonb_typeof(b.list) = 'array' then b.list else '[]'::jsonb end) e
        union all
        select s.artist_id, a.name, g.gk, coalesce(max(g.shown), mode() within group (order by s.tour)),
               count(distinct (s.d, lower(s.venue)))::int, min(s.d)::text, max(s.d)::text, 'tour'
          from cs s join artists a on a.id = s.artist_id
          join grp g on g.artist_id = s.artist_id and g.tour = s.tour
         where s.tour <> '' and not g.hidden and (s.d is null or s.d <= current_date)
         group by s.artist_id, a.name, g.gk)
      select jsonb_agg(jsonb_build_object('artistId', x.artist_id, 'artist', x.artist, 'key', x.tkey, 'name', x.nm,
               'n', x.n, 'first', x.d0, 'last', x.d1, 'kind', x.kind) order by x.d1 desc nulls last, x.nm)
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

create or replace function public.artist_card(a_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.artists%rowtype;
begin
  if auth.uid() is null then return null; end if;
  select * into a from artists where id = a_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', a.id, 'handle', a.handle, 'name', a.name, 'bio', a.bio, 'avatar', a.avatar,
    'mine', coalesce(a.owner_id = auth.uid(), false),
    -- Nobody runs it yet: what the encyclopedia says about the act, and
    -- where the caller's own claim on it stands.
    'unclaimed', a.owner_id is null, 'verified', a.verified, 'about', a.about, 'country', a.country,
    'checkmark', (coalesce(a.mbid, '') <> '' and a.checked) or a.verified,
    'claimed', a.owner_id is not null and a.verified,
    'myClaim', (select c.status from artist_claims c where c.artist_id = a.id and c.user_id = auth.uid()),
    'followers', (select count(*) from artist_follows f where f.artist_id = a.id),
    'iFollow', exists (select 1 from artist_follows f where f.artist_id = a.id and f.user_id = auth.uid()),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
          'userId', m.user_id, 'kind', m.kind, 'role', coalesce(m.role, ''),
          'hasCredits', coalesce(a.owner_id = auth.uid(), false) and exists (select 1 from tour_credits tc
             where tc.artist_id = a.id and tc.user_id = m.user_id and tc.approved is not null),
          'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
          'handle', coalesce(p.handle, ''), 'avatar', coalesce(p.avatar, ''),
          'roles', to_jsonb(coalesce(p.roles, '{}'::text[])), 'tourRole', coalesce(p.tour_role, ''),
          'verified', exists (select 1 from verified_users v where v.user_id = m.user_id),
          'canOpen', public.can_see_profile(m.user_id),
          'endorsed', exists (select 1 from artist_endorsements e where e.artist_id = a.id and e.user_id = m.user_id and e.removed_at is null),
          -- (a member the page can no longer simply take back: endorsed, or listed for more than a week)
          'settled', public.member_settled(a.id, m.user_id),
          -- Asked to leave, waiting on the other members: for the account that runs the page and for its members.
          'leaving', (select jsonb_build_object('at', r.asked_at, 'waiting', public.member_removal_waiting(r.artist_id, r.user_id))
                        from member_removals r
                       where r.artist_id = a.id and r.user_id = m.user_id
                         and (a.owner_id = auth.uid() or exists (select 1 from artist_members me
                               where me.artist_id = a.id and me.user_id = auth.uid() and me.kind = 'band' and me.ended_at is null))),
          -- They took this page's endorsement off theirs: its owner gets no Endorse button for them again.
          'declined', coalesce(a.owner_id = auth.uid(), false)
            and exists (select 1 from artist_endorsements e where e.artist_id = a.id and e.user_id = m.user_id and e.removed_at is not null))
        order by m.created_at)
      from artist_members m left join profiles p on p.user_id = m.user_id where m.artist_id = a.id and m.ended_at is null), '[]'::jsonb),
    'tours', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', t.id, 'artist', a.name, 'name', trim(coalesce(t.doc ->> 'name', '')),
          'first', (select min(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x),
          'last', (select max(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x),
          'shows', jsonb_array_length(public.tour_dates(t.doc)),
          'mine', public.my_role(t.id) is not null)
        order by (select max(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x) desc nulls last, t.id)
      from public.artist_tours(a.id) t), '[]'::jsonb));
end $function$;

create or replace function public.my_artists()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'handle', a.handle, 'name', a.name, 'avatar', a.avatar,
           'mine', coalesce(a.owner_id = auth.uid(), false),
           'checkmark', (coalesce(a.mbid, '') <> '' and a.checked) or a.verified, 'claimed', a.owner_id is not null and a.verified,
           'kind', (select m.kind from artist_members m where m.artist_id = a.id and m.user_id = auth.uid() and m.ended_at is null))
         order by coalesce(a.owner_id = auth.uid(), false) desc, a.created_at), '[]'::jsonb)
    from artists a
   where a.owner_id = auth.uid()
      or exists (select 1 from artist_members m where m.artist_id = a.id and m.user_id = auth.uid() and m.ended_at is null)
$function$;

create or replace function public.shares_artist(u uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with mine as (
    select a.id from artists a where a.owner_id = auth.uid()
    union select m.artist_id from artist_members m where m.user_id = auth.uid() and m.ended_at is null
  )
  select exists (select 1 from artists a where a.owner_id = u and a.id in (select id from mine))
      or exists (select 1 from artist_members m where m.user_id = u and m.ended_at is null and m.artist_id in (select id from mine))
$function$;

create or replace function public.search_suggestions()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare me uuid := auth.uid();
begin
  if me is null then return null; end if;
  return jsonb_build_object(
    -- The people you follow, newest first.
    'following', coalesce((
      select jsonb_agg(public.person_row(f.followee_id) order by f.created_at desc)
        from (select x.* from follows x
               where x.follower_id = me and exists (select 1 from profiles p where p.user_id = x.followee_id)
               order by x.created_at desc limit 20) f), '[]'::jsonb),
    -- The people on your tours you don't follow yet, latest tour first.
    'crew', coalesce((
      select jsonb_agg(public.person_row(c.u) order by c.at desc)
        from (select y.u, max(y.at) as at
                from (select t.owner_id as u, t.updated_at as at from public.tours_of(me) t
                      union all
                      select m.user_id, t.updated_at from public.tours_of(me) t
                        join members m on m.tour_id = t.id
                       where m.user_id is not null) y
               where y.u <> me
                 and not exists (select 1 from follows f where f.follower_id = me and f.followee_id = y.u)
                 and exists (select 1 from profiles p where p.user_id = y.u)
               group by y.u
               order by max(y.at) desc
               limit 20) c), '[]'::jsonb),
    -- Artist pages: yours, the ones you're on, the ones whose tours you're on.
    'artists', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'handle', a.handle, 'name', a.name, 'avatar', coalesce(a.avatar, ''),
               'iFollow', a.ord = -1, 'unclaimed', a.owner_id is null, 'about', a.about,
               'checkmark', (coalesce(a.mbid, '') <> '' and a.checked) or a.verified, 'claimed', a.owner_id is not null and a.verified)
             order by a.ord, lower(a.name))
        from (select x.*, case when exists (select 1 from artist_follows f where f.artist_id = x.id and f.user_id = me) then -1
                               when x.owner_id = me then 0
                               when exists (select 1 from artist_members m where m.artist_id = x.id and m.user_id = me and m.ended_at is null) then 1
                               else 2 end as ord
                from artists x
               where exists (select 1 from artist_follows f where f.artist_id = x.id and f.user_id = me)
                  or x.owner_id = me
                  or exists (select 1 from artist_members m where m.artist_id = x.id and m.user_id = me and m.ended_at is null)
                  or exists (select 1 from public.tours_of(me) t
                              where t.owner_id = x.owner_id
                                and lower(trim(coalesce(t.doc ->> 'artist', ''))) = lower(trim(x.name)))
               order by ord, x.name limit 16) a), '[]'::jsonb));
end $function$;

-- A restored tour keeps the key "deletedAt" with nothing in it. The Off Tour rule asked
-- whether the key was there, so the people on a restored tour lost the Off Tour book.
create or replace function public.my_role(t_id text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when exists (select 1 from tours where id = t_id and owner_id = auth.uid())
      then 'owner'
    else coalesce(
      (select m.role from members m
        where m.tour_id = t_id
          and (m.user_id = auth.uid()
               or lower(m.invited_email) = lower(coalesce(auth.jwt() ->> 'email', '')))
        limit 1),
      (select 'editor' from tours o
        where o.id = t_id and o.doc ->> 'kind' = 'offtour'
          and exists (
            select 1 from tours t join members m on m.tour_id = t.id
             where t.owner_id = o.owner_id and t.id <> o.id
               and (t.doc ->> 'deletedAt') is null
               and lower(trim(coalesce(t.doc ->> 'artist', ''))) = lower(trim(coalesce(o.doc ->> 'artist', '')))
               and m.role = 'editor'
               and (m.user_id = auth.uid()
                    or lower(m.invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))))
        limit 1)
    )
  end
$function$;

create or replace function public.money_lead(t_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from tours where id = t_id and owner_id = auth.uid())
      or exists (
        select 1 from tours x
          join tours t on t.owner_id = x.owner_id
           and (t.id = x.id or (x.doc ->> 'kind' = 'offtour' and (t.doc ->> 'deletedAt') is null
             and lower(trim(coalesce(t.doc ->> 'artist', ''))) = lower(trim(coalesce(x.doc ->> 'artist', '')))))
          join members m on m.tour_id = t.id
         where x.id = t_id and m.user_id = auth.uid() and m.role = 'editor' and m.manager)
$function$;

-- The "confirm your tours" card counts a claim the way the profile does (it stops the day they left).
create or replace function public.my_credit_asks()
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
$function$;

-- End a listing (written only here), and whatever that settles: a request to
-- let another member go that was waiting on this person has one fewer to wait
-- for, and may be done.
create or replace function public.member_end_now(a_id uuid, u_id uuid, d date, by_whom uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r record;
begin
  delete from member_removals where artist_id = a_id and user_id = u_id;
  perform set_config('greenroom.member_end', '1', true);
  update artist_members set ended_at = d, ended_by = by_whom
   where artist_id = a_id and user_id = u_id and ended_at is null;
  perform set_config('greenroom.member_end', '', true);
  for r in select x.user_id, x.asked_by from member_removals x
            where x.artist_id = a_id and public.member_removal_waiting(x.artist_id, x.user_id) = 0
  loop
    perform public.member_end_now(a_id, r.user_id, d, r.asked_by);
  end loop;
end $function$;
revoke all on function public.member_end_now(uuid, uuid, date, uuid) from public, anon, authenticated;

-- Take someone off an artist page. Who may: the account that runs the page,
-- or the person themself (leaving). on_day is the day on the asker's phone
-- (the server's clock can be a day ahead of a show night in America); it is
-- held to within a day of the server's.
create or replace function public.end_artist_member(a_id uuid, u_id uuid, on_day date default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  me uuid := auth.uid();
  m public.artist_members%rowtype;
  d date := least(greatest(coalesce(on_day, current_date), current_date - 1), current_date + 1);
  endorsed boolean;
  waiting int;
begin
  if me is null or not (public.runs_artist(a_id) or me = u_id) then
    raise exception 'permission' using errcode = '42501';
  end if;
  select * into m from artist_members where artist_id = a_id and user_id = u_id for update;
  if not found or m.ended_at is not null then return jsonb_build_object('ok', true, 'gone', true); end if;
  endorsed := exists (select 1 from artist_endorsements e
                       where e.artist_id = a_id and e.user_id = u_id and e.removed_at is null);

  -- Nothing to keep: crew the artist has not endorsed have nothing from it, and a
  -- member added less than a week ago and not endorsed was a slip of the finger.
  if not endorsed and (m.kind = 'crew' or not public.member_settled(a_id, u_id)) then
    delete from member_removals where artist_id = a_id and user_id = u_id;
    perform set_config('greenroom.member_end', '1', true);
    delete from artist_members where artist_id = a_id and user_id = u_id;
    perform set_config('greenroom.member_end', '', true);
    return jsonb_build_object('ok', true, 'kept', false);
  end if;

  -- A member let go by someone else: every other member has to agree.
  if m.kind = 'band' and me <> u_id then
    insert into member_removals (artist_id, user_id, asked_by, agreed)
    values (a_id, u_id, me, array[me])
    on conflict (artist_id, user_id) do update
      set agreed = (select array(select distinct x from unnest(member_removals.agreed || excluded.agreed) x));
    waiting := public.member_removal_waiting(a_id, u_id);
    if waiting > 0 then return jsonb_build_object('ok', true, 'pending', true, 'waiting', waiting); end if;
  end if;

  perform public.member_end_now(a_id, u_id, d, me);
  return jsonb_build_object('ok', true, 'kept', true, 'until', to_char(d, 'YYYY-MM-DD'));
end $function$;
revoke all on function public.end_artist_member(uuid, uuid, date) from public, anon;
grant execute on function public.end_artist_member(uuid, uuid, date) to authenticated;

-- Another member's answer. Yes from every other member ends the listing; one no stops it.
create or replace function public.answer_member_removal(a_id uuid, u_id uuid, agree boolean, on_day date default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  me uuid := auth.uid();
  d date := least(greatest(coalesce(on_day, current_date), current_date - 1), current_date + 1);
  by_whom uuid;
  waiting int;
begin
  if me is null or me = u_id or not exists (select 1 from artist_members x
       where x.artist_id = a_id and x.user_id = me and x.kind = 'band' and x.ended_at is null) then
    raise exception 'permission' using errcode = '42501';
  end if;
  -- (the listing first, then the request: the same order end_artist_member takes them in)
  perform 1 from artist_members where artist_id = a_id and user_id = u_id for update;
  select r.asked_by into by_whom from member_removals r where r.artist_id = a_id and r.user_id = u_id for update;
  if not found then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  if not coalesce(agree, false) then
    delete from member_removals where artist_id = a_id and user_id = u_id;
    return jsonb_build_object('ok', true, 'ended', false, 'stopped', true);
  end if;
  update member_removals set agreed = (select array(select distinct x from unnest(agreed || array[me]) x))
   where artist_id = a_id and user_id = u_id;
  waiting := public.member_removal_waiting(a_id, u_id);
  if waiting > 0 then return jsonb_build_object('ok', true, 'ended', false, 'waiting', waiting); end if;
  perform public.member_end_now(a_id, u_id, d, by_whom);
  return jsonb_build_object('ok', true, 'ended', true);
end $function$;
revoke all on function public.answer_member_removal(uuid, uuid, boolean, date) from public, anon;
grant execute on function public.answer_member_removal(uuid, uuid, boolean, date) to authenticated;

-- Call it off: the account that runs the page, or whoever asked.
create or replace function public.cancel_member_removal(a_id uuid, u_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is null then raise exception 'permission' using errcode = '42501'; end if;
  delete from member_removals r where r.artist_id = a_id and r.user_id = u_id
     and (public.runs_artist(a_id) or r.asked_by = auth.uid());
  return jsonb_build_object('ok', found);
end $function$;
revoke all on function public.cancel_member_removal(uuid, uuid) from public, anon;
grant execute on function public.cancel_member_removal(uuid, uuid) to authenticated;

-- What is waiting on me: members of my artists that someone asked to let go.
create or replace function public.member_removal_asks()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'artistId', a.id, 'artist', a.name, 'handle', a.handle, 'avatar', coalesce(a.avatar, ''),
      'userId', r.user_id, 'name', public.person_name(r.user_id), 'role', coalesce(s.role, ''),
      'askedBy', public.person_name(r.asked_by), 'at', r.asked_at,
      'waiting', public.member_removal_waiting(r.artist_id, r.user_id))
      order by r.asked_at), '[]'::jsonb)
    from member_removals r
    join artists a on a.id = r.artist_id
    join artist_members s on s.artist_id = r.artist_id and s.user_id = r.user_id and s.ended_at is null
    join artist_members me on me.artist_id = r.artist_id and me.user_id = auth.uid() and me.kind = 'band' and me.ended_at is null
   where auth.uid() is not null and r.user_id <> auth.uid() and not (auth.uid() = any(r.agreed))
$function$;
revoke all on function public.member_removal_asks() from public, anon;
grant execute on function public.member_removal_asks() to authenticated;

notify pgrst, 'reload schema';
