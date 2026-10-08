-- Locking the doors before the App Store. Devin: "NO ONE can actually access
-- the app unless they have an emailed code. That code expires after it is
-- used or 24 hours whichever comes first." Plus the rest of the security
-- pass: the public role can't touch tables at all, the app can't read
-- bank-feed tokens, an account can delete itself (Apple requires it), and
-- the road badges can be read for a whole tour's crew at once.

-- 1. Invite-only. An account can only be MADE (any way: a sign-up form, a
-- magic link, an invite) when someone who runs a tour has said that this
-- email address may join — an allowance, good for 24 hours and spent the
-- moment the account exists. The invite email Supabase sends carries the
-- code; the code itself is single-use and lives as long as the project's
-- email-code setting says (set to 24 hours by hand in the dashboard).
create table if not exists public.signup_allowances (
  email_lc text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  used_at timestamptz,
  note text not null default ''
);
create index if not exists signup_allowances_email on public.signup_allowances (email_lc, expires_at);
alter table public.signup_allowances enable row level security;
revoke all on public.signup_allowances from public, anon, authenticated;

-- Who may let someone in: a Greenroom admin, or anyone who runs a tour (its
-- creator, or ALL ACCESS on it) — the people who invite crew today.
create or replace function public.allow_signup(addr text, note text default '')
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); e text := lower(btrim(coalesce(addr, ''))); n int;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  if e !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'bad email' using errcode = '22023'; end if;
  if not (public.is_admin()
          or exists (select 1 from tours t where t.owner_id = me and (t.doc ->> 'deletedAt') is null)
          or exists (select 1 from members m where m.user_id = me and m.role = 'editor')) then
    raise exception 'permission' using errcode = '42501';
  end if;
  select count(*) into n from signup_allowances a where a.created_by = me and a.created_at > now() - interval '24 hours';
  if n >= 30 then raise exception 'too many today' using errcode = '22023'; end if;
  delete from signup_allowances where expires_at < now() - interval '7 days';
  insert into signup_allowances (email_lc, created_by, note) values (e, me, left(coalesce(note, ''), 80));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.allow_signup(text, text) from public, anon;
grant execute on function public.allow_signup(text, text) to authenticated;

-- The door itself: a row can't be added to auth.users without an allowance
-- for its address. Supabase's auth service runs this when it makes an
-- account; a refusal reaches the phone as "Database error saving new user".
create or replace function public.signup_gate()
returns trigger
language plpgsql security definer set search_path = public as $$
declare e text := lower(btrim(coalesce(new.email, '')));
begin
  update signup_allowances set used_at = now()
   where ctid = (select a.ctid from signup_allowances a
                  where a.email_lc = e and a.used_at is null and a.expires_at > now()
                  order by a.created_at limit 1);
  if not found then
    raise exception 'invite only' using errcode = 'P0001',
      hint = 'Greenroom is invite-only. Ask your tour manager for an invite.';
  end if;
  return new;
end $$;
revoke all on function public.signup_gate() from public, anon, authenticated;
grant execute on function public.signup_gate() to supabase_auth_admin;
drop trigger if exists signup_gate on auth.users;
create trigger signup_gate before insert on auth.users
  for each row execute function public.signup_gate();

-- 2. The public (not signed in) role never touches a table or a function.
-- Row security already said no to every row; now there is nothing to ask.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke execute on functions from anon;
-- A function made without a grant of its own can be called by everyone, the
-- public role included. Every function here is for signed-in accounts only
-- (the database's own trigger functions never needed the public grant).
do $do$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $do$;
alter default privileges for role postgres in schema public revoke execute on functions from public;

-- 3. Bank-feed secrets stay on the server. The phone never needs them.
revoke all on public.plaid_items from anon, authenticated;
revoke all on public.plaid_pending from anon, authenticated;
revoke select on public.feed from anon, authenticated;
grant select (owner_id, plan_name, plan_id, accounts, switched_on, since, knowledge, last_run, last_status, merch_account, source, ordered_at)
  on public.feed to authenticated;

-- 4. Deleting your own account, and everything that is yours alone. Tours
-- and artist pages you RUN are the band's: hand them off (or delete them)
-- first, and the function says so instead of taking them with you.
create or replace function public.delete_my_account()
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); n int;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  select count(*) into n from tours where owner_id = me and (doc ->> 'deletedAt') is null;
  if n > 0 then return jsonb_build_object('ok', false, 'why', 'tours', 'n', n); end if;
  select count(*) into n from artists where owner_id = me;
  if n > 0 then return jsonb_build_object('ok', false, 'why', 'artists', 'n', n); end if;
  delete from tours where owner_id = me;
  delete from tour_public where owner_id = me;
  delete from members where user_id = me;
  delete from flowers where from_id = me or to_id = me;
  delete from dms where sender = me or recipient = me;
  delete from follows where follower_id = me or followee_id = me;
  delete from artist_follows where user_id = me;
  delete from artist_members where user_id = me;
  delete from artist_endorsements where user_id = me;
  delete from artist_claims where user_id = me;
  delete from tour_credits where user_id = me;
  delete from day_votes where user_id = me;
  delete from game_ball_votes where voter = me;
  delete from push_subs where user_id = me;
  delete from app_errors where user_id = me;
  delete from labels where owner_id = me;
  delete from past_crew where owner_id = me;
  delete from feed_items where owner_id = me;
  delete from feed where owner_id = me;
  delete from plaid_items where owner_id = me;
  delete from plaid_pending where owner_id = me;
  delete from merch_deposits where owner_id = me;
  delete from merch_reports where owner_id = me;
  delete from square_payout_entries where owner_id = me;
  delete from square_payouts where owner_id = me;
  delete from square_payments where owner_id = me;
  delete from square_requests where owner_id = me;
  delete from square_connect where owner_id = me;
  delete from setlist_requests where owner_id = me;
  delete from setlist_connect where owner_id = me;
  delete from setlist_user_day where user_id = me;
  delete from signup_allowances where created_by = me;
  delete from platform_admins where user_id = me;
  delete from verified_users where user_id = me;
  delete from profiles where user_id = me;
  delete from auth.users where id = me;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- 5. The road badge for a whole tour's crew in one read (Crew Stats). The
-- same count profile_card makes for one person: nights played on their
-- Greenroom tours plus the nights an artist confirmed for them.
create or replace function public.road_stats(u uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  with gr as (
    select (e.v ->> 'date') as d,
           lower(btrim(split_part(coalesce(e.v ->> 'city', ''), ',', 1))) as city,
           public.road_country(e.v ->> 'city') as ctry,
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
    'firstYear', (select left(min(d), 4)::int from nights))
$$;
revoke all on function public.road_stats(uuid) from public, anon, authenticated;

create or replace function public.road_tiers(t_id text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null or public.my_role(t_id) is null then null else coalesce((
    select jsonb_agg(jsonb_build_object('userId', p.u) || public.road_stats(p.u))
      from (select t.owner_id as u from tours t where t.id = t_id
            union
            select m.user_id from members m where m.tour_id = t_id and m.user_id is not null) p), '[]'::jsonb) end
$$;
revoke all on function public.road_tiers(text) from public, anon;
grant execute on function public.road_tiers(text) to authenticated;

notify pgrst, 'reload schema';
