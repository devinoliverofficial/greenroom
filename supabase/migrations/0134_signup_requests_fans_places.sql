-- The new way in (Devin, 2026-10-10): "First you are asked for your code. No one
-- should be on the sign up page without a code first and foremost." Then name,
-- username, date of birth, email; then "purpose of using greenroom": MEMBER
-- (owner / artist), CREW (work for artist), FAN (follow artists), PROMOTER
-- (book / promote concerts), and "someone should be able to click multiple
-- purposes". Each purpose has its own questions: a member or crew person asks
-- an artist to list them (or claims a page nobody runs), a fan marks the shows
-- they were at, a promoter names the venues and festivals they worked for.
--
-- What this migration adds:
--   1. Greenroom invite codes, typed before anything else is known.
--   2. What an account says it is (kinds), whether it has finished the first
--      questions, and its date of birth, kept where only its owner can read it.
--   3. Requests: a person asks an artist page to list them; the page answers.
--      Claims carry the claimant's role, proof links and a code to post.
--   4. Shows a fan says they were at.
--   5. Venue and festival pages, made from the show archive, and "I worked here".
--
-- Until now the only way in was a tour invite: the account was made the moment
-- a tour manager tapped Invite. That still works exactly as before.

-- ============================== 1. Invite codes ==============================
-- A code is typed first, before the person has said who they are, so the
-- three functions that read it can be called by someone who is not signed in.
-- They are the ONLY things such a caller can reach. A code is 8 characters from
-- 31 (no 0/O, 1/I/L), about 850 billion combinations; wrong guesses are counted
-- per address, and a guesser is told to wait.
--
-- A code lets one person in. It does not prove an email address is theirs, so
-- the account it makes has to confirm its address with the code Supabase emails
-- (signup_proof, below, refuses it otherwise), and it cannot bring other people
-- in until Greenroom has confirmed an artist page for it (invites_trusted).
create table if not exists public.invite_codes (
  code text primary key,                       -- as handed out: GR-7KQ2-M4XD
  key text not null unique,                    -- letters and digits only, for matching what was typed
  kinds text[] not null default '{}' check (kinds <@ array['member', 'crew', 'fan', 'promoter']),
  uses_left int not null default 1 check (uses_left >= 0),
  uses_made int not null default 0,
  expires_at timestamptz,
  created_by uuid not null,
  note text not null default '' check (char_length(note) <= 80),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
-- One row for each account a code made, and it is never rewritten: this is how
-- the database knows an account came in on a code (invites_trusted). A code is
-- switched off, never deleted, so these rows stay.
create table if not exists public.invite_code_uses (
  id bigint generated always as identity primary key,
  code text not null references public.invite_codes (code) on delete cascade,
  email_lc text not null,
  at timestamptz not null default now(),
  user_id uuid
);
create index if not exists invite_code_uses_user on public.invite_code_uses (user_id) where user_id is not null;
create index if not exists invite_code_uses_code on public.invite_code_uses (code);
create table if not exists public.invite_code_tries (
  ip text not null default '',
  at timestamptz not null default now(),
  ok boolean not null default false
);
create index if not exists invite_code_tries_at on public.invite_code_tries (at);
alter table public.invite_codes enable row level security;
alter table public.invite_code_uses enable row level security;
alter table public.invite_code_tries enable row level security;
revoke all on public.invite_codes, public.invite_code_uses, public.invite_code_tries from public, anon, authenticated;

-- An allowance made by a code says so, and does not count against the 30 a
-- day a person may invite by hand.
alter table public.signup_allowances add column if not exists via_code text;

create or replace function public.invite_code_key(c text)
 returns text
 language sql
 immutable
as $function$
  select upper(regexp_replace(coalesce(c, ''), '[^A-Za-z0-9]', '', 'g'))
$function$;
revoke all on function public.invite_code_key(text) from public, anon, authenticated;

-- May this caller try a code? 10 wrong in 10 minutes from one address and the
-- answer is "wait". (The ceiling across everyone is high on purpose: a low one
-- would let one person with a script hold the door shut for everybody, and at
-- 20,000 an hour against a few hundred live codes a guess still lands about
-- once in a decade.)
create or replace function public.signup_try_ok()
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare who text;
begin
  who := public.signup_caller();
  delete from invite_code_tries where at < now() - interval '1 day';
  if (select count(*) from invite_code_tries t where not t.ok and t.ip = who and t.at > now() - interval '10 minutes') >= 10 then return false; end if;
  if (select count(*) from invite_code_tries t where not t.ok and t.at > now() - interval '1 hour') >= 20000 then return false; end if;
  return true;
end $function$;
revoke all on function public.signup_try_ok() from public, anon, authenticated;

-- The address a request came from ('?' when the API does not say). The
-- network's own word for it first (a caller cannot write that one); the
-- forwarded list is only the fallback, because its first entry is the caller's to make up.
create or replace function public.signup_caller()
 returns text
 language plpgsql
 stable
as $function$
declare hdr json; got text;
begin
  begin
    hdr := nullif(current_setting('request.headers', true), '')::json;
  exception when others then hdr := null;
  end;
  got := coalesce(nullif(btrim(coalesce(hdr ->> 'cf-connecting-ip', '')), ''),
                  nullif(btrim(coalesce(hdr ->> 'x-real-ip', '')), ''),
                  nullif(btrim(split_part(coalesce(hdr ->> 'x-forwarded-for', ''), ',', 1)), ''), '?');
  return left(got, 60);
end $function$;
revoke all on function public.signup_caller() from public, anon, authenticated;

-- The code row for what was typed, if it can still be used.
create or replace function public.invite_code_live(c text)
 returns public.invite_codes
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select i.* from invite_codes i
   where i.key = public.invite_code_key(c) and char_length(i.key) >= 6
     and i.revoked_at is null and (i.expires_at is null or i.expires_at > now())
$function$;
revoke all on function public.invite_code_live(text) from public, anon, authenticated;

-- Screen one: is this a code? Never raises for a bad one (the count of wrong
-- tries has to be kept).
create or replace function public.signup_code_check(c text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare i public.invite_codes%rowtype;
begin
  if not public.signup_try_ok() then return jsonb_build_object('ok', false, 'why', 'slow'); end if;
  i := public.invite_code_live(c);
  if i.code is null or i.uses_left <= 0 then
    insert into invite_code_tries (ip, ok) values (public.signup_caller(), false);
    return jsonb_build_object('ok', false, 'why', 'bad');
  end if;
  return jsonb_build_object('ok', true, 'kinds', to_jsonb(i.kinds));
end $function$;
revoke all on function public.signup_code_check(text) from public;
grant execute on function public.signup_code_check(text) to anon, authenticated;

-- Is this @name free? Asked before the account exists, so it needs the code.
create or replace function public.signup_handle_free(c text, h text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare i public.invite_codes%rowtype; x text := lower(btrim(coalesce(h, '')));
begin
  if not public.signup_try_ok() then return jsonb_build_object('ok', false, 'why', 'slow'); end if;
  i := public.invite_code_live(c);
  if i.code is null then
    insert into invite_code_tries (ip, ok) values (public.signup_caller(), false);
    return jsonb_build_object('ok', false, 'why', 'bad');
  end if;
  return jsonb_build_object('ok', true, 'free',
    x ~ '^[a-z0-9._]{3,24}$'
    and x not in ('greenroom', 'admin', 'support', 'help', 'official', 'staff', 'ari', 'everyone', 'here')
    and x not like 'mb.%'
    and not exists (select 1 from profiles p where p.handle = x)
    and not exists (select 1 from artists a where a.handle = x));
end $function$;
revoke all on function public.signup_handle_free(text, text) from public;
grant execute on function public.signup_handle_free(text, text) to anon, authenticated;

-- The last screen before the account is made: this code, for this address.
-- It writes the allowance the door (signup_gate) looks for. The code's use is
-- NOT spent here: it is spent by the door, at the moment the account is really
-- made, so a sign-up that fails for any other reason leaves the code good.
--
-- "instead_of": the person saw "check your email", realised the address was
-- wrong, went back and typed the right one. The account that was made for the
-- wrong address a moment ago (never confirmed, never signed in, made by this
-- same code) goes, and the code gets its use back.
--
-- An address that already has an account is refused (told apart: one that has
-- a tour invite waiting comes in with the code from that email). An account a
-- code made that was never confirmed within the hour is nobody's: it is cleared
-- and the address is free again.
drop function if exists public.signup_code_redeem(text, text);
create or replace function public.signup_code_redeem(c text, addr text, instead_of text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  i public.invite_codes%rowtype;
  e text := lower(btrim(coalesce(addr, '')));
  was text := lower(btrim(coalesce(instead_of, '')));
  gone uuid; waiting int;
begin
  if not public.signup_try_ok() then return jsonb_build_object('ok', false, 'why', 'slow'); end if;
  i := public.invite_code_live(c);
  if i.code is null then
    insert into invite_code_tries (ip, ok) values (public.signup_caller(), false);
    return jsonb_build_object('ok', false, 'why', 'bad');
  end if;
  -- (A code is not a way to ask "does this address have an account" all day: 10 goes an hour from one
  -- caller, so one holder of a shared code cannot use up everyone's, and a looser total for the code.)
  if (select count(*) from invite_code_tries t where t.ip = 'code:' || i.code || '@' || public.signup_caller() and t.at > now() - interval '1 hour') >= 10
     or (select count(*) from invite_code_tries t where t.ip like 'code:' || i.code || '@%' and t.at > now() - interval '1 hour') >= 60 + 4 * i.uses_left then
    return jsonb_build_object('ok', false, 'why', 'slow');
  end if;
  insert into invite_code_tries (ip, ok) values ('code:' || i.code || '@' || public.signup_caller(), true);
  if e !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or char_length(e) > 120 then
    return jsonb_build_object('ok', false, 'why', 'email');
  end if;
  if was <> '' and was <> e then
    select u.id into gone from auth.users u join invite_code_uses s on s.user_id = u.id
     where s.code = i.code and lower(u.email) = was and u.email_confirmed_at is null and u.last_sign_in_at is null
       and u.invited_at is null and coalesce(u.created_at, now()) > now() - interval '1 day';
    if gone is not null then
      -- (the use comes back once, whoever else asks at the same moment: only the call that removes the row gives it)
      delete from invite_code_uses where code = i.code and user_id = gone;
      if found then
        delete from auth.users where id = gone and email_confirmed_at is null and last_sign_in_at is null;
        if found then
          update invite_codes set uses_left = uses_left + 1, uses_made = greatest(uses_made - 1, 0) where code = i.code returning * into i;
        end if;
      end if;
    end if;
  end if;
  if i.uses_left <= 0 then
    insert into invite_code_tries (ip, ok) values (public.signup_caller(), false);
    return jsonb_build_object('ok', false, 'why', 'bad');
  end if;
  select u.id into gone from auth.users u
   where lower(u.email) = e and u.email_confirmed_at is null and u.last_sign_in_at is null and u.invited_at is null
     and coalesce(u.confirmation_sent_at, u.created_at) < now() - interval '1 hour'
     and exists (select 1 from invite_code_uses s where s.user_id = u.id);
  if gone is not null then
    delete from auth.users where id = gone and email_confirmed_at is null and last_sign_in_at is null;
  end if;
  if exists (select 1 from auth.users u where lower(u.email) = e) then
    if exists (select 1 from members m where lower(m.invited_email) = e and m.user_id is null) then
      return jsonb_build_object('ok', false, 'why', 'invited');
    end if;
    return jsonb_build_object('ok', false, 'why', 'exists');
  end if;
  -- One code never holds the door for more addresses at once than it has uses left: the oldest one
  -- waiting makes way (nobody can park a shared code's places), and a place is held for half an hour.
  if not exists (select 1 from signup_allowances x where x.email_lc = e and x.via_code = i.code and x.used_at is null and x.expires_at > now()) then
    select count(*) into waiting from signup_allowances x where x.via_code = i.code and x.used_at is null and x.expires_at > now();
    if waiting >= i.uses_left then
      delete from signup_allowances d where d.ctid in (
        select x.ctid from signup_allowances x
         where x.via_code = i.code and x.used_at is null and x.expires_at > now()
         order by x.created_at limit (waiting - i.uses_left + 1));
    end if;
    insert into signup_allowances (email_lc, created_by, note, via_code, expires_at)
    values (e, i.created_by, 'code', i.code, now() + interval '30 minutes');
  end if;
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.signup_code_redeem(text, text, text) from public;
grant execute on function public.signup_code_redeem(text, text, text) to anon, authenticated;

-- The door itself (0075), taught about codes: an allowance that came from a
-- code is good only while that code still has a use left, and making the
-- account is what spends it. Everything else is as it was: no allowance for
-- the address, no account.
create or replace function public.signup_gate()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare e text := lower(btrim(coalesce(new.email, ''))); a record;
begin
  for a in select x.ctid, x.via_code from signup_allowances x
            where x.email_lc = e and x.used_at is null and x.expires_at > now()
            order by (x.via_code is not null), x.created_at
  loop
    if a.via_code is not null then
      update invite_codes set uses_left = uses_left - 1, uses_made = uses_made + 1
       where code = a.via_code and uses_left > 0 and revoked_at is null and (expires_at is null or expires_at > now());
      if not found then continue; end if;   -- that code is spent or switched off: try the next allowance
      insert into invite_code_uses (code, email_lc, user_id) values (a.via_code, e, new.id);
    end if;
    update signup_allowances set used_at = now() where ctid = a.ctid;
    return new;
  end loop;
  raise exception 'invite only' using errcode = 'P0001',
    hint = 'Greenroom is invite-only. You need a code, or an invite from a tour.';
end $function$;
revoke all on function public.signup_gate() from public, anon, authenticated;
grant execute on function public.signup_gate() to supabase_auth_admin;

-- No address counts as someone's until they have opened a message sent to it.
-- Supabase can be set to skip that ("Confirm email" off); then an account could
-- be made for any address a person cared to type, and a tour that later invited
-- that address would be handing its money to a stranger. Two things the
-- database can hold on its own:
--   * an account's address is never marked confirmed unless a confirmation or
--     an invitation was sent to it (so with the setting off, a new sign-up
--     simply fails);
--   * an account's address never changes except to the one a change-of-address
--     message was sent to, and not on the say-so of the OLD address alone
--     (which is what the setting being off allows).
-- What it cannot hold: with "Confirm email" off AND sign-ups on, Supabase will
-- confirm an account that is already waiting (a pending tour invite) for anyone
-- who posts a sign-up for its address, and that update looks the same as a real
-- one. So the order is: Confirm email ON first, and it stays on; only then are
-- sign-ups switched on. The app's Invite codes sheet shouts if it finds them the
-- other way round.
-- This also refuses a user made confirmed by hand in the dashboard, an admin's
-- edit of an address, and a sign-in with Apple or Google (none are used; lift
-- the rule before adding one). To roll back: drop function public.signup_proof() cascade;
create or replace function public.signup_proof()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null
     and new.confirmation_sent_at is null and new.invited_at is null then
    raise exception 'confirm email first' using errcode = 'P0001',
      hint = 'This address has to be confirmed by the code emailed to it. Turn on Confirm email in the Supabase dashboard.';
  end if;
  if lower(coalesce(new.email, '')) is distinct from lower(coalesce(old.email, ''))
     and (lower(coalesce(old.email_change, '')) is distinct from lower(coalesce(new.email, ''))
          or (coalesce(old.email_change_token_current, '') <> '' and coalesce(old.email_change_confirm_status, 0) = 0)) then
    raise exception 'email change not confirmed' using errcode = 'P0001',
      hint = 'An address changes only after the new one has been confirmed.';
  end if;
  return new;
end $function$;
revoke all on function public.signup_proof() from public, anon, authenticated;
grant execute on function public.signup_proof() to supabase_auth_admin;
drop trigger if exists signup_proof on auth.users;
create trigger signup_proof before update on auth.users
  for each row
  when ((old.email_confirmed_at is null and new.email_confirmed_at is not null) or old.email is distinct from new.email)
  execute function public.signup_proof();

-- May this account bring other people in (add them to a tour, let a new
-- address sign up)? Everyone who was invited by hand may, as before. An
-- account that came in on a code may once Greenroom has confirmed an artist
-- page it runs, or it is a Member of one: "Once you are accepted to claim a
-- page you ... can assign other members and managers" (Devin). Until then one
-- code is one person, not a way to let in a crowd or to pull a stranger's
-- account onto a made-up tour (which would show that person's phone number).
create or replace function public.invites_trusted(u uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select u is not null and (
         exists (select 1 from platform_admins p where p.user_id = u)
      or not exists (select 1 from invite_code_uses s where s.user_id = u)
      or exists (select 1 from artists a where a.owner_id = u and a.verified)
      or exists (select 1 from artist_members m join artists a on a.id = m.artist_id
                  where m.user_id = u and m.kind = 'band' and m.ended_at is null and a.verified and a.owner_id is not null))
$function$;
revoke all on function public.invites_trusted(uuid) from public, anon, authenticated;

-- (An invite made by hand is still capped at 30 a day a person; a code's allowances are not theirs.)
create or replace function public.allow_signup(addr text, note text default '')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me uuid := auth.uid(); e text := lower(btrim(coalesce(addr, ''))); n int; gone uuid;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  if e !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'bad email' using errcode = '22023'; end if;
  if not (public.is_admin()
          or exists (select 1 from tours t where t.owner_id = me and (t.doc ->> 'deletedAt') is null)
          or exists (select 1 from members m where m.user_id = me and m.role = 'editor')) then
    raise exception 'permission' using errcode = '42501';
  end if;
  -- Trusted in their own right, or a Manager on a tour made by someone who is.
  if not (public.invites_trusted(me)
          or exists (select 1 from members m join tours t on t.id = m.tour_id
                      where m.user_id = me and m.role = 'editor' and t.owner_id <> me
                        and (t.doc ->> 'deletedAt') is null and public.invites_trusted(t.owner_id))) then
    raise exception 'page first' using errcode = 'P0001',
      hint = 'You can add people once Greenroom has confirmed your artist page.';
  end if;
  select count(*) into n from signup_allowances a
   where a.created_by = me and a.via_code is null and a.created_at > now() - interval '24 hours';
  if n >= 30 then raise exception 'too many today' using errcode = '22023'; end if;
  -- (An account a code made for this address that was never confirmed is in the way of the invite: it goes.)
  select u.id into gone from auth.users u
   where lower(u.email) = e and u.email_confirmed_at is null and u.last_sign_in_at is null and u.invited_at is null
     and exists (select 1 from invite_code_uses s where s.user_id = u.id);
  if gone is not null then
    delete from auth.users where id = gone and email_confirmed_at is null and last_sign_in_at is null;
  end if;
  delete from signup_allowances where expires_at < now() - interval '7 days';
  insert into signup_allowances (email_lc, created_by, note) values (e, me, left(coalesce(note, ''), 80));
  return jsonb_build_object('ok', true);
end $function$;

-- The same rule where it is enforced whatever the app does: nobody is put on a
-- tour whose creator may not bring people in yet. (Only what a signed-in person
-- sends is asked; the server's own writes are not.)
create or replace function public.members_trusted()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(auth.role(), '') = 'authenticated' and not public.is_admin()
     and not public.invites_trusted((select t.owner_id from tours t where t.id = new.tour_id)) then
    raise exception 'page first' using errcode = 'P0001',
      hint = 'People can be added to this tour once Greenroom has confirmed its artist page.';
  end if;
  return new;
end $function$;
revoke all on function public.members_trusted() from public, anon, authenticated;
drop trigger if exists members_trusted on public.members;
create trigger members_trusted before insert on public.members
  for each row execute function public.members_trusted();

-- A tour invite for an address that already has an account is attached to that
-- account at once (0019). Only to one whose address is proven: an account
-- somebody made for the address with a code, and never confirmed, is not them.
create or replace function public.link_invite(t_id text, addr text)
 returns void
 language sql
 security definer
 set search_path to 'public', 'auth'
as $function$
  update public.members m
     set user_id = u.id
    from auth.users u
   where m.tour_id = t_id
     and m.user_id is null
     and lower(m.invited_email) = lower(addr)
     and lower(u.email) = lower(addr)
     and u.email_confirmed_at is not null
     and (coalesce(u.encrypted_password, '') <> '' or u.last_sign_in_at is not null);
$function$;

-- And on an artist page: its runner lists someone directly only when Greenroom
-- has confirmed the page, or the person is already on a tour with them.
-- Anyone else asks to be listed (request_artist) and the runner says yes: a
-- listing shows the two their profiles, so it cannot be one-sided.
drop policy if exists artist_members_insert on public.artist_members;
create policy artist_members_insert on public.artist_members for insert
  with check (public.runs_artist(artist_id)
    and (user_id = auth.uid() or public.is_admin() or public.on_my_tours(user_id)
         or exists (select 1 from artists a where a.id = artist_id and a.verified)));

-- Greenroom's own people make and switch off codes.
create or replace function public.invite_codes()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not public.is_admin() then return null; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('code', i.code, 'kinds', to_jsonb(i.kinds), 'usesLeft', i.uses_left,
            'used', i.uses_made, 'expiresAt', i.expires_at, 'note', i.note, 'revoked', i.revoked_at is not null, 'at', i.created_at)
          order by i.created_at desc) from invite_codes i), '[]'::jsonb);
end $function$;
revoke all on function public.invite_codes() from public, anon;
grant execute on function public.invite_codes() to authenticated;

create or replace function public.invite_code_make(k text[] default '{}', uses int default 1, days int default 30, note text default '')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  abc constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  raw bytea; body text; made text; tries int := 0; n int;
  kk text[] := coalesce((select array_agg(distinct x) from unnest(coalesce(k, '{}'::text[])) x where x in ('member', 'crew', 'fan', 'promoter')), '{}'::text[]);
begin
  if not public.is_admin() then raise exception 'permission' using errcode = '42501'; end if;
  loop
    raw := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    body := '';
    foreach n in array array[0, 1, 2, 3, 4, 5, 10, 11] loop body := body || substr(abc, (get_byte(raw, n) % 31) + 1, 1); end loop;
    made := 'GR-' || left(body, 4) || '-' || right(body, 4);
    begin
      insert into invite_codes (code, key, kinds, uses_left, expires_at, created_by, note)
      values (made, public.invite_code_key(made), kk, least(500, greatest(1, coalesce(uses, 1))),
              now() + make_interval(days => least(365, greatest(1, coalesce(days, 30)))), auth.uid(), left(btrim(coalesce(note, '')), 80));
      exit;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 5 then raise; end if;
    end;
  end loop;
  return jsonb_build_object('code', made);
end $function$;
revoke all on function public.invite_code_make(text[], int, int, text) from public, anon;
grant execute on function public.invite_code_make(text[], int, int, text) to authenticated;

create or replace function public.invite_code_revoke(c text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not public.is_admin() then raise exception 'permission' using errcode = '42501'; end if;
  update invite_codes set revoked_at = now() where key = public.invite_code_key(c) and revoked_at is null;
  return jsonb_build_object('ok', found);
end $function$;
revoke all on function public.invite_code_revoke(text) from public, anon;
grant execute on function public.invite_code_revoke(text) to authenticated;

-- ============================== 2. The first questions ==============================
-- What an account says it is. It is the person's own word, so it decides what
-- the app offers them, never what the database lets them see.
alter table public.profiles
  add column if not exists kinds text[] not null default '{}',
  add column if not exists onboarded_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_kinds_known') then
    alter table public.profiles add constraint profiles_kinds_known check (kinds <@ array['member', 'crew', 'fan', 'promoter']);
  end if;
end $$;
-- Everyone already here has been through the old door: they are not asked again.
-- They are members or crew by what they are listed as, and crew if they are on someone's tour.
update public.profiles p set onboarded_at = now() where p.onboarded_at is null and not exists (select 1 from public.invite_codes);
update public.profiles p set kinds = (
  select coalesce(array_agg(distinct k), '{}'::text[]) from (
    select 'member' as k where exists (select 1 from artist_members m where m.user_id = p.user_id and m.kind = 'band' and m.ended_at is null)
                            or exists (select 1 from artists a where a.owner_id = p.user_id)
    union all
    select 'crew' where exists (select 1 from artist_members m where m.user_id = p.user_id and m.kind = 'crew' and m.ended_at is null)
                     or exists (select 1 from members m where m.user_id = p.user_id)) x)
 where p.kinds = '{}';

-- A date of birth is nobody else's to read: not tour-mates (who can read a
-- profiles row), not the artist. Its own table, its owner only.
create table if not exists public.profile_private (
  user_id uuid primary key references auth.users (id) on delete cascade,
  birth_date date,
  updated_at timestamptz not null default now()
);
alter table public.profile_private enable row level security;
revoke all on public.profile_private from public, anon, authenticated;
grant select on public.profile_private to authenticated;
drop policy if exists profile_private_self on public.profile_private;
create policy profile_private_self on public.profile_private for select to authenticated using (user_id = auth.uid());

create or replace function public.save_birth_date(d date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  if d is null or d > current_date or d < current_date - interval '120 years' then raise exception 'shape' using errcode = '22023'; end if;
  -- (18 and older: the terms of use and the tester agreement both say so)
  if d > current_date - interval '18 years' then raise exception 'young' using errcode = '22023'; end if;
  insert into profile_private (user_id, birth_date) values (me, d)
  on conflict (user_id) do update set birth_date = excluded.birth_date, updated_at = now();
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.save_birth_date(date) from public, anon;
grant execute on function public.save_birth_date(date) to authenticated;

create or replace function public.clean_kinds(k text[])
 returns text[]
 language sql
 immutable
as $function$
  select coalesce((select array_agg(x order by array_position(array['member', 'crew', 'fan', 'promoter'], x))
                     from (select distinct x from unnest(coalesce(k, '{}'::text[])) x where x in ('member', 'crew', 'fan', 'promoter')) y), '{}'::text[])
$function$;
revoke all on function public.clean_kinds(text[]) from public, anon, authenticated;

create or replace function public.my_first_run()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when auth.uid() is null then null else jsonb_build_object(
    'onboarded', coalesce((select p.onboarded_at is not null from profiles p where p.user_id = auth.uid()), false),
    'kinds', coalesce((select to_jsonb(p.kinds) from profiles p where p.user_id = auth.uid()), '[]'::jsonb),
    'handle', coalesce((select p.handle from profiles p where p.user_id = auth.uid()), ''),
    'hasBirth', exists (select 1 from profile_private x where x.user_id = auth.uid() and x.birth_date is not null)) end
$function$;
revoke all on function public.my_first_run() from public, anon;
grant execute on function public.my_first_run() to authenticated;

create or replace function public.finish_first_run(k text[])
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  update profiles set kinds = public.clean_kinds(k), onboarded_at = coalesce(onboarded_at, now()) where user_id = me;
  if not found then
    insert into profiles (user_id, kinds, onboarded_at) values (me, public.clean_kinds(k), now())
    on conflict (user_id) do update set kinds = excluded.kinds, onboarded_at = coalesce(profiles.onboarded_at, now());
  end if;
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.finish_first_run(text[]) from public, anon;
grant execute on function public.finish_first_run(text[]) to authenticated;

create or replace function public.save_kinds(k text[])
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is null then raise exception 'permission' using errcode = '42501'; end if;
  update profiles set kinds = public.clean_kinds(k) where user_id = auth.uid();
  return jsonb_build_object('ok', found);
end $function$;
revoke all on function public.save_kinds(text[]) from public, anon;
grant execute on function public.save_kinds(text[]) to authenticated;

-- ============================== 3. Asking an artist to list you ==============================
-- Until now only the account that runs a page could put someone on it. Now a
-- person can ask ("the artist page is alerted of an endorsement request. Until
-- it's accepted it just says pending"). One row per person per artist; asking
-- again re-opens it. A request is NOT a listing: nothing that counts shows,
-- votes, or opens profiles reads this table.
create table if not exists public.artist_requests (
  artist_id uuid not null references public.artists (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('band', 'crew')),
  role text not null default '' check (char_length(role) <= 40),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'withdrawn')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid,
  primary key (artist_id, user_id)
);
create index if not exists artist_requests_user on public.artist_requests (user_id);
alter table public.artist_requests enable row level security;
revoke all on public.artist_requests from public, anon, authenticated;

-- "a band has 30 days to answer": a request nobody answered in 30 days reads
-- as expired (the clock starts when the page has someone to answer it). No
-- timer runs; it is worked out when read.
create or replace function public.artist_request_state(status text, asked timestamptz, owner uuid, claimed timestamptz)
 returns text
 language sql
 stable
as $function$
  select case when status = 'pending' and owner is not null
                   and greatest(asked, coalesce(claimed, asked)) < now() - interval '30 days' then 'expired'
              else status end
$function$;
revoke all on function public.artist_request_state(text, timestamptz, uuid, timestamptz) from public, anon, authenticated;

-- List someone and give them the artist's word, in one go. Used when a request
-- is accepted, when the page's own runner asks, and when a claim is approved.
create or replace function public.artist_list_endorsed(a_id uuid, u_id uuid, k text, r text, by_whom uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  insert into artist_members (artist_id, user_id, kind, role, added_by) values (a_id, u_id, k, left(btrim(coalesce(r, '')), 40), by_whom)
  on conflict (artist_id, user_id) do update set kind = excluded.kind, role = excluded.role;
  -- (They asked to be listed, so an endorsement they once took off comes back.)
  insert into artist_endorsements (artist_id, user_id, endorsed_by) values (a_id, u_id, by_whom)
  on conflict (artist_id, user_id) do update
    set removed_at = null, endorsed_by = excluded.endorsed_by, kind = excluded.kind, role = excluded.role, created_at = now()
    where artist_endorsements.removed_at is not null;
end $function$;
revoke all on function public.artist_list_endorsed(uuid, uuid, text, text, uuid) from public, anon, authenticated;

create or replace function public.request_artist(a_id uuid, k text, r text default '')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me uuid := auth.uid(); m public.artist_members%rowtype; q public.artist_requests%rowtype; rr text := left(btrim(coalesce(r, '')), 40);
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
grant execute on function public.request_artist(uuid, text, text) to authenticated;

create or replace function public.my_artist_requests()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'artistId', a.id, 'artist', a.name, 'handle', a.handle, 'avatar', coalesce(a.avatar, ''), 'unclaimed', a.owner_id is null,
      'kind', r.kind, 'role', r.role, 'at', r.created_at,
      'state', public.artist_request_state(r.status, r.created_at, a.owner_id, a.claimed_at)) order by r.created_at desc), '[]'::jsonb)
    from artist_requests r join artists a on a.id = r.artist_id
   where auth.uid() is not null and r.user_id = auth.uid()
     and (r.status = 'pending' or (r.status = 'declined' and r.decided_at > now() - interval '30 days'))
     -- (listed since, by whatever road: there is nothing left to ask)
     and not exists (select 1 from artist_members m where m.artist_id = r.artist_id and m.user_id = r.user_id and m.ended_at is null)
$function$;
revoke all on function public.my_artist_requests() from public, anon;
grant execute on function public.my_artist_requests() to authenticated;

create or replace function public.withdraw_artist_request(a_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is null then raise exception 'permission' using errcode = '42501'; end if;
  update artist_requests set status = 'withdrawn', decided_at = now(), decided_by = auth.uid()
   where artist_id = a_id and user_id = auth.uid() and status = 'pending';
  return jsonb_build_object('ok', found);
end $function$;
revoke all on function public.withdraw_artist_request(uuid) from public, anon;
grant execute on function public.withdraw_artist_request(uuid) to authenticated;

-- Who is waiting on me: for the pages I run (one page, or all of them). It
-- carries each person's name and face itself, because the page's runner cannot
-- open a stranger's profile.
create or replace function public.artist_request_queue(a_id uuid default null)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
      'artistId', a.id, 'artist', a.name, 'userId', r.user_id, 'name', public.person_name(r.user_id),
      'handle', coalesce(p.handle, ''), 'avatar', coalesce(p.avatar, ''), 'roles', to_jsonb(coalesce(p.roles, '{}'::text[])),
      'kind', r.kind, 'role', r.role, 'at', r.created_at) order by r.created_at), '[]'::jsonb)
    from artist_requests r
    join artists a on a.id = r.artist_id
    left join profiles p on p.user_id = r.user_id
   where auth.uid() is not null and a.owner_id = auth.uid() and (a_id is null or a.id = a_id)
     and public.artist_request_state(r.status, r.created_at, a.owner_id, a.claimed_at) = 'pending'
     and not exists (select 1 from artist_members m where m.artist_id = r.artist_id and m.user_id = r.user_id and m.ended_at is null)
$function$;
revoke all on function public.artist_request_queue(uuid) from public, anon;
grant execute on function public.artist_request_queue(uuid) to authenticated;

create or replace function public.decide_artist_request(a_id uuid, u_id uuid, accept boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me uuid := auth.uid(); yes boolean := coalesce(accept, false);
  r public.artist_requests%rowtype; m public.artist_members%rowtype; a public.artists%rowtype;
begin
  if me is null or not public.runs_artist(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  select * into a from artists where id = a_id;
  select * into r from artist_requests where artist_id = a_id and user_id = u_id for update;
  if not found or r.status <> 'pending' then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  if public.artist_request_state(r.status, r.created_at, a.owner_id, a.claimed_at) = 'expired' then
    return jsonb_build_object('ok', false, 'why', 'expired');
  end if;
  if yes then
    select * into m from artist_members where artist_id = a_id and user_id = u_id;
    if found and m.ended_at is not null and m.kind = 'band' and r.kind = 'crew' then
      return jsonb_build_object('ok', false, 'why', 'former_member');
    end if;
    perform public.artist_list_endorsed(a_id, u_id, r.kind, r.role, me);
  end if;
  update artist_requests set status = case when yes then 'accepted' else 'declined' end, decided_at = now(), decided_by = me
   where artist_id = a_id and user_id = u_id;
  return jsonb_build_object('ok', true, 'accepted', yes);
end $function$;
revoke all on function public.decide_artist_request(uuid, uuid, boolean) from public, anon;
grant execute on function public.decide_artist_request(uuid, uuid, boolean) to authenticated;

-- ---- Claiming a page nobody runs: the claimant's role, and proof ----
-- "they are given a portal to submit documents like Spotify and get the
-- approval process in motion but can still be listed as a member until the
-- claim is approved or denied." The proof is links (the artist's Spotify,
-- Instagram, website) and a short code Greenroom gives them to put in the
-- artist's bio or on its site, where only someone who controls it could put it.
alter table public.artist_claims
  add column if not exists role text not null default '',
  add column if not exists links jsonb not null default '{}'::jsonb,
  add column if not exists code text not null default '';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'artist_claims_role_len') then
    alter table public.artist_claims add constraint artist_claims_role_len check (char_length(role) <= 40);
  end if;
end $$;

-- Only links that are links, three of them at most, each short.
create or replace function public.claim_links(l jsonb)
 returns jsonb
 language sql
 immutable
as $function$
  select coalesce((select jsonb_object_agg(k, left(v, 200)) from jsonb_each_text(case when jsonb_typeof(l) = 'object' then l else '{}'::jsonb end) e(k, v)
                    where k in ('spotify', 'instagram', 'website') and v ~* '^https://[^[:space:]]{4,}$'), '{}'::jsonb)
$function$;
revoke all on function public.claim_links(jsonb) from public, anon, authenticated;

drop function if exists public.claim_artist(uuid, text, text);
create or replace function public.claim_artist(a_id uuid, note text default '', link text default '', role text default '', links jsonb default '{}'::jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  me uuid := auth.uid(); n int; said text; url text; ll jsonb; made text; raw bytea; body text := ''; i int;
  abc constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  if not exists (select 1 from artists a where a.id = a_id and a.owner_id is null and a.checked) then
    return jsonb_build_object('ok', false, 'why', 'taken');
  end if;
  said := left(btrim(coalesce(note, '')), 500);
  url := left(btrim(coalesce(link, '')), 200);
  ll := public.claim_links(links);
  -- Something to check it by: a link, or at least a sentence.
  if char_length(said) < 3 and ll = '{}'::jsonb and url = '' then raise exception 'say who you are' using errcode = '22023'; end if;
  select count(*) into n from artist_claims c where c.user_id = me and c.status = 'pending' and c.artist_id <> a_id;
  if n >= 10 then raise exception 'too many waiting' using errcode = '22023'; end if;
  -- The code to post is the same every time for one person and one page: withdrawing and claiming again
  -- does not draw a new one, so nobody can keep drawing until theirs matches a code already in a bio.
  raw := decode(md5('claim:' || a_id::text || ':' || me::text), 'hex');
  for i in 0..5 loop body := body || substr(abc, (get_byte(raw, i) % 31) + 1, 1); end loop;
  insert into artist_claims (artist_id, user_id, note, link, role, links, code)
  values (a_id, me, said, url, left(btrim(coalesce(role, '')), 40), ll, 'GR-' || body)
  on conflict (artist_id, user_id) do update
    set note = excluded.note, link = excluded.link, role = excluded.role, links = excluded.links,
        code = excluded.code,
        status = 'pending', created_at = now(), decided_at = null, decided_by = null
  returning code into made;
  return jsonb_build_object('ok', true, 'code', made);
end $function$;
revoke all on function public.claim_artist(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.claim_artist(uuid, text, text, text, jsonb) to authenticated;

create or replace function public.my_claims()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('artistId', a.id, 'artist', a.name, 'status', c.status,
           'at', c.created_at, 'decidedAt', c.decided_at, 'mine', coalesce(a.owner_id = auth.uid(), false),
           'role', c.role, 'links', c.links, 'code', c.code) order by c.created_at desc), '[]'::jsonb)
    from artist_claims c join artists a on a.id = c.artist_id
   where auth.uid() is not null and c.user_id = auth.uid()
$function$;

create or replace function public.claim_queue()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not public.is_admin() then return null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', c.id, 'artistId', a.id, 'artist', a.name, 'about', a.about, 'country', a.country,
        'userId', c.user_id, 'name', public.person_name(c.user_id),
        'handle', coalesce(p.handle, ''), 'avatar', coalesce(p.avatar, ''),
        'roles', to_jsonb(coalesce(p.roles, '{}'::text[])), 'tourRole', coalesce(p.tour_role, ''),
        'email', coalesce((select u.email from auth.users u where u.id = c.user_id), ''),
        'note', c.note, 'link', c.link, 'at', c.created_at,
        'role', c.role, 'links', c.links, 'code', c.code,
        'others', (select count(*) from artist_claims o where o.artist_id = c.artist_id and o.status = 'pending' and o.id <> c.id))
      order by c.created_at)
      from artist_claims c
      join artists a on a.id = c.artist_id
      left join profiles p on p.user_id = c.user_id
     where c.status = 'pending'), '[]'::jsonb);
end $function$;

-- Approved: the claimant runs the page AND is on it, as a Member with the role
-- they gave, endorsed. Everyone else who had claimed it is not thrown away:
-- their claim becomes a request to be listed, for the new runner to answer.
create or replace function public.decide_claim(c_id uuid, approve boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare c public.artist_claims%rowtype; slug text;
begin
  if not public.is_admin() then raise exception 'permission' using errcode = '42501'; end if;
  select * into c from artist_claims where id = c_id for update;
  if not found or c.status <> 'pending' then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  if not coalesce(approve, false) then
    update artist_claims set status = 'declined', decided_at = now(), decided_by = auth.uid() where id = c_id;
    return jsonb_build_object('ok', true);
  end if;
  select public.artist_free_slug(a.name) into slug from artists a where a.id = c.artist_id;
  update artists set owner_id = c.user_id, verified = true, claimed_at = now(),
         handle = coalesce(slug, handle)
   where id = c.artist_id and owner_id is null;
  if not found then
    update artist_claims set status = 'declined', decided_at = now(), decided_by = auth.uid() where id = c_id;
    return jsonb_build_object('ok', false, 'why', 'taken');
  end if;
  update artist_claims set status = 'approved', decided_at = now(), decided_by = auth.uid() where id = c_id;
  perform public.artist_list_endorsed(c.artist_id, c.user_id, 'band', c.role, c.user_id);
  update artist_requests set status = 'accepted', decided_at = now(), decided_by = auth.uid()
   where artist_id = c.artist_id and user_id = c.user_id and status = 'pending';
  insert into artist_requests (artist_id, user_id, kind, role)
  select o.artist_id, o.user_id, 'band', o.role from artist_claims o
   where o.artist_id = c.artist_id and o.id <> c_id and o.status = 'pending'
  on conflict (artist_id, user_id) do update
    set status = 'pending', created_at = now(), decided_at = null, decided_by = null
    where artist_requests.status <> 'pending';
  update artist_claims set status = 'declined', decided_at = now(), decided_by = auth.uid()
   where artist_id = c.artist_id and id <> c_id and status = 'pending';
  return jsonb_build_object('ok', true);
end $function$;

-- ============================== 4. Shows a fan was at ==============================
-- "find shows you've attended ... press 'attended' on these shows and start
-- building their analytics." A night in the archive can be re-read, renamed or
-- re-keyed, so a mark is kept by artist and date with the room written down
-- beside it, not by the archive's own id.
create table if not exists public.show_attendance (
  user_id uuid not null references auth.users (id) on delete cascade,
  artist_id uuid not null references public.artists (id) on delete cascade,
  show_date date not null,
  venue text not null default '',
  city text not null default '',
  country_code text not null default '',
  marked_at timestamptz not null default now(),
  primary key (user_id, artist_id, show_date)
);
alter table public.show_attendance enable row level security;
revoke all on public.show_attendance from public, anon, authenticated;

-- The nights of one tour (the same list the artist page shows), each with
-- whether I marked it.
create or replace function public.artist_fan_nights(a_id uuid, tour_name text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when auth.uid() is null then null else coalesce((
    select jsonb_agg(jsonb_build_object('date', x ->> 'date', 'city', x ->> 'city', 'state', x ->> 'state', 'country', x ->> 'country',
             'venue', x ->> 'venue', 'festival', x ->> 'festival',
             'attended', exists (select 1 from show_attendance s
                                  where s.user_id = auth.uid() and s.artist_id = a_id and s.show_date = (x ->> 'date')::date))
           order by x ->> 'date')
      from jsonb_array_elements(coalesce(public.artist_tour_nights(a_id, tour_name), '[]'::jsonb)) x
     where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'), '[]'::jsonb) end
$function$;
revoke all on function public.artist_fan_nights(uuid, text) from public, anon;
grant execute on function public.artist_fan_nights(uuid, text) to authenticated;

-- Mark or unmark one night. Only a night that is on record and has been
-- played; 200 marks a day at most (nobody was at 5,000 shows this afternoon).
create or replace function public.mark_attended(a_id uuid, night date, going boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me uuid := auth.uid(); h record;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  if coalesce(going, false) then
    if night is null or night > current_date then return jsonb_build_object('ok', false, 'why', 'future'); end if;
    select s.venue, s.city, s.country_code into h from artist_history_shows s
     where s.artist_id = a_id and s.date = night order by s.venue limit 1;
    if not found then return jsonb_build_object('ok', false, 'why', 'none'); end if;
    if (select count(*) from show_attendance x where x.user_id = me and x.marked_at > now() - interval '24 hours') >= 200 then
      return jsonb_build_object('ok', false, 'why', 'many');
    end if;
    insert into show_attendance (user_id, artist_id, show_date, venue, city, country_code)
    values (me, a_id, night, coalesce(h.venue, ''), coalesce(h.city, ''), coalesce(h.country_code, ''))
    on conflict (user_id, artist_id, show_date) do nothing;
  else
    delete from show_attendance where user_id = me and artist_id = a_id and show_date = night;
  end if;
  return jsonb_build_object('ok', true, 'count', (select count(*) from show_attendance x where x.user_id = me));
end $function$;
revoke all on function public.mark_attended(uuid, date, boolean) from public, anon;
grant execute on function public.mark_attended(uuid, date, boolean) to authenticated;

create or replace function public.my_attended()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when auth.uid() is null then null else jsonb_build_object(
    'count', (select count(*) from show_attendance x where x.user_id = auth.uid()),
    'artists', coalesce((select jsonb_agg(jsonb_build_object('artistId', a.id, 'artist', a.name, 'handle', a.handle,
                   'avatar', coalesce(a.avatar, ''), 'n', t.n) order by t.n desc, a.name)
                 from (select x.artist_id, count(*) as n from show_attendance x where x.user_id = auth.uid() group by 1) t
                 join artists a on a.id = t.artist_id), '[]'::jsonb)) end
$function$;
revoke all on function public.my_attended() from public, anon;
grant execute on function public.my_attended() to authenticated;

-- The artist page says where my own claim and request stand, and shows a claimant waiting.
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
    'myClaimCode', (select c.code from artist_claims c where c.artist_id = a.id and c.user_id = auth.uid() and c.status = 'pending' and c.code <> ''),
    -- My own request to be listed here, while it waits or just after a no.
    'myRequest', (select jsonb_build_object('kind', r.kind, 'role', r.role, 'at', r.created_at,
                    'state', public.artist_request_state(r.status, r.created_at, a.owner_id, a.claimed_at))
                    from artist_requests r
                   where r.artist_id = a.id and r.user_id = auth.uid()
                     and (r.status = 'pending' or (r.status = 'declined' and r.decided_at > now() - interval '30 days'))),
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
      from artist_members m left join profiles p on p.user_id = m.user_id where m.artist_id = a.id and m.ended_at is null), '[]'::jsonb)
      -- Someone who has claimed a page nobody runs is "listed as a member until the claim is approved or
      -- denied": shown as pending, to themselves and to Greenroom. (Not to everyone: anyone could put their
      -- name on any act's page that way. And never as a real listing: a listed Member gets every night.)
      || coalesce((
      select jsonb_agg(jsonb_build_object(
          'userId', c.user_id, 'kind', 'band', 'role', c.role, 'hasCredits', false,
          'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
          'handle', coalesce(p.handle, ''), 'avatar', coalesce(p.avatar, ''),
          'roles', to_jsonb(coalesce(p.roles, '{}'::text[])), 'tourRole', coalesce(p.tour_role, ''),
          'verified', false, 'canOpen', public.can_see_profile(c.user_id),
          'endorsed', false, 'settled', false, 'declined', false, 'pending', true)
        order by c.created_at)
      from artist_claims c left join profiles p on p.user_id = c.user_id
     where c.artist_id = a.id and c.status = 'pending' and a.owner_id is null
       and (c.user_id = auth.uid() or public.is_admin())), '[]'::jsonb),
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

-- ============================== 5. Venue and festival pages ==============================
-- "The page should generate venue pages just like artists and festival pages
-- just like artists." An artist's page is made from the outside record of who
-- the act is; a venue's or a festival's is made from the show archive: every
-- room and festival that an artist on Greenroom has a night on record at. So a
-- page can only be made for a place that has shows behind it (nobody can type
-- a venue into being), and it opens already knowing who played there.
create table if not exists public.venues (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  vkey text not null,                          -- lower(trim(name)): how the archive's nights are matched
  ckey text not null default '',               -- road_city_key(city)
  cc text not null default '',                 -- country code, upper
  city text not null default '',
  region text not null default '',
  country text not null default '',
  address text not null default '',
  phone text not null default '',
  owner_id uuid references auth.users (id) on delete set null,
  verified boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (vkey, ckey, cc)
);
create table if not exists public.festivals (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  fkey text not null unique,                   -- lower(name without its year)
  owner_id uuid references auth.users (id) on delete set null,
  verified boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now()
);
-- "I worked here": a promoter's word, pending until whoever comes to run the
-- page (or Greenroom, while nobody does) agrees.
create table if not exists public.place_workers (
  user_id uuid not null references auth.users (id) on delete cascade,
  venue_id uuid references public.venues (id) on delete cascade,
  festival_id uuid references public.festivals (id) on delete cascade,
  role text not null default '' check (char_length(role) <= 40),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  decided_by uuid,
  created_at timestamptz not null default now(),
  check ((venue_id is null) <> (festival_id is null))
);
create unique index if not exists place_workers_one on public.place_workers (user_id, coalesce(venue_id, festival_id));
alter table public.venues enable row level security;
alter table public.festivals enable row level security;
alter table public.place_workers enable row level security;
revoke all on public.venues, public.festivals, public.place_workers from public, anon, authenticated;
create index if not exists artist_history_shows_venue on public.artist_history_shows (lower(btrim(venue)), upper(country_code));
create index if not exists artist_history_shows_fest on public.artist_history_shows (festival) where festival <> '';

-- A festival's name without the year on the end ("Warped Tour 2013" and "Warped Tour 2014" are one festival).
create or replace function public.festival_key(n text)
 returns text
 language sql
 immutable
as $function$
  select lower(btrim(regexp_replace(coalesce(n, ''), '\s*(19|20)\d{2}\s*$', '')))
$function$;
revoke all on function public.festival_key(text) from public, anon, authenticated;

-- Search: places with shows on record. Nothing is made by searching.
create or replace function public.find_places(q text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare t text := lower(btrim(coalesce(q, ''))); pat text;
begin
  if auth.uid() is null then return null; end if;
  if char_length(t) < 2 then return jsonb_build_object('venues', '[]'::jsonb, 'festivals', '[]'::jsonb); end if;
  pat := '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return jsonb_build_object(
    'venues', coalesce((select jsonb_agg(jsonb_build_object('name', v.name, 'city', v.city, 'region', v.region, 'cc', v.cc,
                  'nights', v.nights, 'artists', v.artists) order by v.nights desc, v.name)
        from (select mode() within group (order by h.venue) as name, mode() within group (order by h.city) as city,
                     mode() within group (order by h.state) as region, upper(h.country_code) as cc,
                     count(distinct (h.artist_id, h.date)) as nights, count(distinct h.artist_id) as artists
                from artist_history_shows h
               where h.venue <> '' and h.festival = '' and h.date <= current_date
                 and (lower(h.venue) like pat or lower(h.city) like pat)
               group by lower(btrim(h.venue)), public.road_city_key(h.city), upper(h.country_code)
               order by count(distinct (h.artist_id, h.date)) desc limit 12) v), '[]'::jsonb),
    'festivals', coalesce((select jsonb_agg(jsonb_build_object('name', f.name, 'editions', f.editions, 'artists', f.artists)
                  order by f.editions desc, f.name)
        from (select mode() within group (order by btrim(regexp_replace(h.festival, '\s*(19|20)\d{2}\s*$', ''))) as name,
                     count(distinct extract(year from h.date)) as editions, count(distinct h.artist_id) as artists
                from artist_history_shows h
               where h.festival <> '' and h.date <= current_date and lower(h.festival) like pat
               group by public.festival_key(h.festival)
               order by count(distinct extract(year from h.date)) desc limit 8) f), '[]'::jsonb));
end $function$;
revoke all on function public.find_places(text) from public, anon;
grant execute on function public.find_places(text) to authenticated;

-- Find or make the page for a venue the archive knows. 30 new pages a day a person.
create or replace function public.venue_open(v_name text, v_city text, v_cc text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me uuid := auth.uid(); vk text := lower(btrim(coalesce(v_name, ''))); ck text := public.road_city_key(coalesce(v_city, ''));
  c2 text := upper(btrim(coalesce(v_cc, ''))); got uuid; h record;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  select v.id into got from venues v where v.vkey = vk and v.ckey = ck and v.cc = c2;
  if found then return jsonb_build_object('id', got, 'made', false); end if;
  select mode() within group (order by s.venue) as name, mode() within group (order by s.city) as city,
         mode() within group (order by s.state) as region, mode() within group (order by s.country) as country, count(*) as n
    into h from artist_history_shows s
   where lower(btrim(s.venue)) = vk and upper(s.country_code) = c2 and public.road_city_key(s.city) = ck and s.festival = '';
  if h.n is null or h.n = 0 then raise exception 'no shows on record there' using errcode = '22023'; end if;
  if (select count(*) from venues v where v.created_by = me and v.created_at > now() - interval '24 hours')
     + (select count(*) from festivals f where f.created_by = me and f.created_at > now() - interval '24 hours') >= 30 then
    raise exception 'too many today' using errcode = '22023';
  end if;
  insert into venues (name, vkey, ckey, cc, city, region, country, created_by)
  values (left(h.name, 120), vk, ck, c2, coalesce(h.city, ''), coalesce(h.region, ''), coalesce(h.country, ''), me)
  on conflict (vkey, ckey, cc) do update set name = venues.name
  returning id into got;
  return jsonb_build_object('id', got, 'made', true);
end $function$;
revoke all on function public.venue_open(text, text, text) from public, anon;
grant execute on function public.venue_open(text, text, text) to authenticated;

create or replace function public.festival_open(f_name text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me uuid := auth.uid(); fk text := public.festival_key(f_name); got uuid; nm text;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  select f.id into got from festivals f where f.fkey = fk;
  if found then return jsonb_build_object('id', got, 'made', false); end if;
  select mode() within group (order by btrim(regexp_replace(s.festival, '\s*(19|20)\d{2}\s*$', ''))) into nm
    from artist_history_shows s where s.festival <> '' and public.festival_key(s.festival) = fk;
  if nm is null or fk = '' then raise exception 'no shows on record there' using errcode = '22023'; end if;
  if (select count(*) from venues v where v.created_by = me and v.created_at > now() - interval '24 hours')
     + (select count(*) from festivals f where f.created_by = me and f.created_at > now() - interval '24 hours') >= 30 then
    raise exception 'too many today' using errcode = '22023';
  end if;
  insert into festivals (name, fkey, created_by) values (left(nm, 120), fk, me)
  on conflict (fkey) do update set name = festivals.name
  returning id into got;
  return jsonb_build_object('id', got, 'made', true);
end $function$;
revoke all on function public.festival_open(text) from public, anon;
grant execute on function public.festival_open(text) to authenticated;

-- A venue's page: what it is, and every night on record there.
create or replace function public.venue_card(v_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v public.venues%rowtype;
begin
  if auth.uid() is null then return null; end if;
  select * into v from venues where id = v_id;
  if not found then return null; end if;
  return (
    with n as materialized (
      select s.artist_id, s.date from artist_history_shows s
       where lower(btrim(s.venue)) = v.vkey and upper(s.country_code) = v.cc and public.road_city_key(s.city) = v.ckey
         and s.festival = '' and s.date <= current_date)
    select jsonb_build_object(
      'id', v.id, 'name', v.name, 'city', v.city, 'region', v.region, 'country', v.country, 'address', v.address, 'phone', v.phone,
      'unclaimed', v.owner_id is null, 'verified', v.verified, 'mine', coalesce(v.owner_id = auth.uid(), false),
      'shows', (select count(distinct (n.artist_id, n.date)) from n),
      'firstYear', (select extract(year from min(n.date))::int from n),
      'lastYear', (select extract(year from max(n.date))::int from n),
      'artists', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'avatar', coalesce(a.avatar, ''),
                     'n', t.k, 'first', t.y0, 'last', t.y1) order by t.k desc, a.name)
                   from (select n.artist_id, count(distinct n.date) as k, extract(year from min(n.date))::int as y0,
                                extract(year from max(n.date))::int as y1
                           from n group by n.artist_id order by count(distinct n.date) desc limit 80) t
                   join artists a on a.id = t.artist_id), '[]'::jsonb),
      'workers', (select count(*) from place_workers w where w.venue_id = v.id and w.status = 'approved'),
      'myWork', (select jsonb_build_object('role', w.role, 'state', w.status) from place_workers w
                  where w.venue_id = v.id and w.user_id = auth.uid())));
end $function$;
revoke all on function public.venue_card(uuid) from public, anon;
grant execute on function public.venue_card(uuid) to authenticated;

create or replace function public.festival_card(f_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare f public.festivals%rowtype;
begin
  if auth.uid() is null then return null; end if;
  select * into f from festivals where id = f_id;
  if not found then return null; end if;
  return (
    with n as materialized (
      select s.artist_id, s.date from artist_history_shows s
       where s.festival <> '' and public.festival_key(s.festival) = f.fkey and s.date <= current_date)
    select jsonb_build_object(
      'id', f.id, 'name', f.name, 'unclaimed', f.owner_id is null, 'verified', f.verified, 'mine', coalesce(f.owner_id = auth.uid(), false),
      'shows', (select count(distinct (n.artist_id, n.date)) from n),
      'editions', coalesce((select jsonb_agg(jsonb_build_object('year', e.y, 'n', e.k) order by e.y desc)
                    from (select extract(year from n.date)::int as y, count(distinct n.artist_id) as k from n group by 1) e), '[]'::jsonb),
      'artists', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'avatar', coalesce(a.avatar, ''), 'n', t.k)
                     order by t.k desc, a.name)
                   from (select n.artist_id, count(distinct n.date) as k from n group by n.artist_id order by count(distinct n.date) desc limit 80) t
                   join artists a on a.id = t.artist_id), '[]'::jsonb),
      'workers', (select count(*) from place_workers w where w.festival_id = f.id and w.status = 'approved'),
      'myWork', (select jsonb_build_object('role', w.role, 'state', w.status) from place_workers w
                  where w.festival_id = f.id and w.user_id = auth.uid())));
end $function$;
revoke all on function public.festival_card(uuid) from public, anon;
grant execute on function public.festival_card(uuid) to authenticated;

create or replace function public.place_work_ask(v_id uuid, f_id uuid, r text default '')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  if (v_id is null) = (f_id is null) then raise exception 'one place' using errcode = '22023'; end if;
  if v_id is not null and not exists (select 1 from venues where id = v_id) then raise exception 'no place' using errcode = '22023'; end if;
  if f_id is not null and not exists (select 1 from festivals where id = f_id) then raise exception 'no place' using errcode = '22023'; end if;
  if (select count(*) from place_workers w where w.user_id = me and w.status = 'pending'
        and coalesce(w.venue_id, w.festival_id) <> coalesce(v_id, f_id)) >= 30 then
    raise exception 'too many waiting' using errcode = '22023';
  end if;
  update place_workers set role = case when status = 'approved' then role else left(btrim(coalesce(r, '')), 40) end,
         status = case when status = 'declined' then 'pending' else status end
   where user_id = me and coalesce(venue_id, festival_id) = coalesce(v_id, f_id);
  if not found then
    insert into place_workers (user_id, venue_id, festival_id, role) values (me, v_id, f_id, left(btrim(coalesce(r, '')), 40));
  end if;
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.place_work_ask(uuid, uuid, text) from public, anon;
grant execute on function public.place_work_ask(uuid, uuid, text) to authenticated;

create or replace function public.place_work_withdraw(v_id uuid, f_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is null then raise exception 'permission' using errcode = '42501'; end if;
  delete from place_workers where user_id = auth.uid() and coalesce(venue_id, festival_id) = coalesce(v_id, f_id);
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.place_work_withdraw(uuid, uuid) from public, anon;
grant execute on function public.place_work_withdraw(uuid, uuid) to authenticated;

create or replace function public.my_places()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when auth.uid() is null then null else coalesce((
    select jsonb_agg(x.j order by x.at desc) from (
      select jsonb_build_object('kind', 'venue', 'id', v.id, 'name', v.name, 'city', v.city, 'role', w.role, 'state', w.status) as j, w.created_at as at
        from place_workers w join venues v on v.id = w.venue_id where w.user_id = auth.uid()
      union all
      select jsonb_build_object('kind', 'festival', 'id', f.id, 'name', f.name, 'city', '', 'role', w.role, 'state', w.status), w.created_at
        from place_workers w join festivals f on f.id = w.festival_id where w.user_id = auth.uid()) x), '[]'::jsonb) end
$function$;
revoke all on function public.my_places() from public, anon;
grant execute on function public.my_places() to authenticated;

-- ============================== 6. Deleting an account ==============================
-- What is the person's own goes with them: their requests, the shows they marked, their "I worked here",
-- their date of birth. Venue and festival pages stay (they are the archive's); codes they made are switched off.
create or replace function public.delete_my_account()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare me uuid := auth.uid(); n int;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  select count(*) into n from tours where owner_id = me and (doc ->> 'deletedAt') is null;
  if n > 0 then return jsonb_build_object('ok', false, 'why', 'tours', 'n', n); end if;
  select count(*) into n from artists where owner_id = me;
  if n > 0 then return jsonb_build_object('ok', false, 'why', 'artists', 'n', n); end if;
  delete from my_pay_items where user_id = me;
  delete from my_pay_feed where user_id = me;
  delete from my_pay_accounts where user_id = me;
  delete from my_pay_books where user_id = me;
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
  delete from artist_requests where user_id = me;
  delete from show_attendance where user_id = me;
  delete from place_workers where user_id = me;
  update venues set created_by = null where created_by = me;
  update festivals set created_by = null where created_by = me;
  update invite_codes set revoked_at = coalesce(revoked_at, now()) where created_by = me;
  delete from invite_code_uses where user_id = me
     or (user_id is null and email_lc = (select lower(u.email) from auth.users u where u.id = me));
  delete from signup_allowances where email_lc = (select lower(u.email) from auth.users u where u.id = me);
  delete from profile_private where user_id = me;
  delete from profiles where user_id = me;
  delete from auth.users where id = me;
  return jsonb_build_object('ok', true);
end $function$;

-- ============================== 7. A tour stays with whoever made it ==============================
create or replace function public.tours_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- Nobody signed in hands a tour to another account, its creator included: a tour made up and pushed onto
  -- someone would put its maker on that person's own books. (The app has never offered it.)
  if auth.uid() is not null and new.owner_id is distinct from old.owner_id then
    raise exception 'a tour cannot be handed over' using errcode = '42501';
  end if;
  -- The server (no signed-in user) and the tour's creator change anything else.
  if auth.uid() is null or auth.uid() = old.owner_id then return new; end if;
  if new.owner_id is distinct from old.owner_id then
    raise exception 'only the creator can hand a tour over' using errcode = '42501';
  end if;
  if (new.doc -> 'deletedAt') is distinct from (old.doc -> 'deletedAt') then
    raise exception 'only the creator can delete or restore a tour' using errcode = '42501';
  end if;
  if (new.doc ->> 'kind') is distinct from (old.doc ->> 'kind') or (new.doc ->> 'artist') is distinct from (old.doc ->> 'artist') then
    raise exception 'only the creator can move a tour to another band' using errcode = '42501';
  end if;
  if (new.doc -> 'cardLog') is distinct from (old.doc -> 'cardLog') then
    raise exception 'only the creator sets the card logging dates' using errcode = '42501';
  end if;
  return new;
end $function$;

notify pgrst, 'reload schema';
