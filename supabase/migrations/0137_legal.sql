-- The documents at sign-up (Devin, 2026-10-10): "after they type the invite
-- code into the app i want them to be prompt with the documents in the terms
-- and conditions folder". Each document on its own page, one box to tick, the
-- button "I Agree", no skip. Save "the user's id, the versions, the timestamp
-- and the IP address". People invited to a tour must accept too, and everyone
-- is asked again when a version changes. And on Oct 11: "lets get this figured
-- out so they sign while signing up".
--
-- What this migration adds:
--   1. legal_docs: the three documents (the tester agreement 'nda', the terms
--      of use 'terms', the privacy policy 'privacy'). Every version is kept
--      and one of each is marked current. Their words are NOT in this
--      repository (it is public): they are loaded into this table by hand.
--      Nobody reads the table directly.
--   2. legal_acceptances: one row each time a person agrees. Who, their email
--      at the time, when, the address the request came from, which versions,
--      a fingerprint of each document's words, the sentence they ticked, and
--      which door they came through. A person reads only their own rows,
--      nobody writes the table directly, and a row outlives its account. A
--      row, once written, is never edited or removed, whoever asks.
--   3. legal_docs_for(code): hands the documents to someone signed in, or to
--      someone holding a live Greenroom code. legal_accept(...): records the
--      agreement. legal_status(): what the person signed in has agreed to.
--   4. my_first_run() says whether the documents are waiting (needs_legal).
--   5. A seat on a tour waits for the documents: an invite is not attached to
--      an account that still has them to agree to, and the first questions
--      cannot be finished before them.
--
-- Safe to apply while the current app is live, and BEFORE any document is
-- loaded. While legal_docs does not hold a current version of all three,
-- nothing is asked of anyone: legal_needs() is false for everybody, so
-- my_first_run() answers what it answers today plus "needs_legal": false, and
-- link_invite, claim_invites and finish_first_run do exactly what they did.
--
-- The order to go live: this migration, then the app that shows the pages,
-- then the documents (section 3). The moment the third document is marked
-- current, everyone is asked on their next open.
--
-- The switch-off, if it is ever needed, erases nothing:
--   update public.legal_docs set is_current = false;

-- ============================== 1. The documents ==============================
create table if not exists public.legal_docs (
  doc text not null check (doc in ('nda', 'terms', 'privacy')),
  -- (no space or line break at either end. The app compares a version letter
  -- for letter after trimming it, so '1.0 ' stored here could never be agreed
  -- to and everyone would be held at the documents)
  version text not null
    constraint legal_docs_version_trim
    check (version = btrim(version) and version <> '' and version !~ '^[[:space:]]|[[:space:]]$'),
  title text not null,
  body text not null,                          -- the words, in markdown, exactly as written
  sha text not null,                           -- sha-256 of body (UTF-8), in hex: filled in by the database
  published_at timestamptz not null default now(),
  is_current boolean not null default false,
  primary key (doc, version)
);
-- At most one current version of each document.
create unique index if not exists legal_docs_one_current on public.legal_docs (doc) where is_current;
alter table public.legal_docs enable row level security;
revoke all on public.legal_docs from public, anon, authenticated;

-- ============================== 2. Who agreed, and to what ==============================
create table if not exists public.legal_acceptances (
  id bigint generated always as identity primary key,
  -- (kept when the person's account goes: the row stays, with the email as the record)
  user_id uuid references auth.users (id) on delete set null,
  email_lc text not null,
  accepted_at timestamptz not null default now(),
  ip text not null default '',
  agent text not null default '',
  nda_version text not null,
  terms_version text not null,
  privacy_version text not null,
  nda_sha text not null,
  terms_sha text not null,
  privacy_sha text not null,
  said text not null,                          -- the sentence the phone sent with the tick, kept as sent (section 6: not compared with anything)
  via text not null check (via in ('code', 'invite', 'inside'))
);
create index if not exists legal_acceptances_user on public.legal_acceptances (user_id, accepted_at desc);
alter table public.legal_acceptances enable row level security;
revoke all on public.legal_acceptances from public, anon, authenticated;
grant select on public.legal_acceptances to authenticated;
drop policy if exists legal_acceptances_self on public.legal_acceptances;
create policy legal_acceptances_self on public.legal_acceptances for select to authenticated
  using (user_id = auth.uid());
-- (the counter behind "id" is nobody's to move either)
do $$
declare s text := pg_get_serial_sequence('public.legal_acceptances', 'id');
begin
  if s is not null then execute format('revoke all on sequence %s from public, anon, authenticated', s); end if;
end $$;

-- A row here is the record of an agreement, so once it is written it stays as
-- it was written, whoever asks: the server's own key and the SQL editor
-- included (row security and the grants above only bind people signed in to
-- the app). One thing can happen to a row. When its account is deleted, the
-- database itself empties user_id (the "on delete set null" above, which
-- arrives here as an update of that one column): that is let through, and
-- only when nothing else in the row changes. Every other update, every
-- delete, and emptying the table are refused.
create or replace function public.legal_acceptances_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if tg_op = 'UPDATE' then
    if old.user_id is not null and new.user_id is null
       and (to_jsonb(new) - 'user_id'::text) = (to_jsonb(old) - 'user_id'::text) then
      return new;
    end if;
  end if;
  raise exception 'a record of an agreement is not changed' using errcode = 'P0001',
    hint = 'A row is added when someone agrees and loses its account when the account is deleted. Nothing else happens to it.';
end $function$;
revoke all on function public.legal_acceptances_guard() from public, anon, authenticated;
drop trigger if exists legal_acceptances_guard on public.legal_acceptances;
create trigger legal_acceptances_guard before update or delete on public.legal_acceptances
  for each row execute function public.legal_acceptances_guard();
drop trigger if exists legal_acceptances_keep on public.legal_acceptances;
create trigger legal_acceptances_keep before truncate on public.legal_acceptances
  for each statement execute function public.legal_acceptances_guard();

-- delete_my_account (0134) is not changed and does not name this table: when
-- it removes the account, the row above stays and its user_id becomes empty
-- (the one change the guard lets through). The same happens when an account
-- is deleted from the Supabase dashboard.

-- ============================== 3. Loading a document ==============================
-- A fingerprint is only worth keeping if it is the fingerprint of the words
-- that were shown. So the database works it out itself, every time, from the
-- body as stored; whatever is typed into "sha" is replaced.
--
-- And once somebody has agreed to a version, that version's words are fixed:
-- it cannot be edited or deleted. New words are a new version (which is also
-- what makes everyone get asked again).
--
-- The same goes for a version while it is the current one, agreed to or not:
-- its words, its version and which document it is cannot be edited. Somebody
-- may be reading it at that moment, and what they agree to is recorded with
-- the fingerprint of the words stored then. So a correction is always a new
-- version. A version that is not current and that nobody has agreed to can
-- still be corrected, and a version nobody has agreed to can be deleted.
create or replace function public.legal_docs_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from legal_acceptances a
                where (old.doc = 'nda' and a.nda_version = old.version)
                   or (old.doc = 'terms' and a.terms_version = old.version)
                   or (old.doc = 'privacy' and a.privacy_version = old.version)) then
      raise exception 'somebody agreed to this version' using errcode = 'P0001',
        hint = 'A version people agreed to is kept. To stop using it, mark another version current.';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if (new.doc is distinct from old.doc or new.version is distinct from old.version or new.body is distinct from old.body)
       and exists (select 1 from legal_acceptances a
                    where (old.doc = 'nda' and a.nda_version = old.version)
                       or (old.doc = 'terms' and a.terms_version = old.version)
                       or (old.doc = 'privacy' and a.privacy_version = old.version)) then
      raise exception 'somebody agreed to this version' using errcode = 'P0001',
        hint = 'Its words are fixed. Load the new words as a new version.';
    end if;
    if (new.doc is distinct from old.doc or new.version is distinct from old.version or new.body is distinct from old.body)
       and (old.is_current or new.is_current) then
      raise exception 'this version is the current one' using errcode = 'P0001',
        hint = 'Its words are fixed while it is the one being shown. Load the new words as a new version.';
    end if;
  end if;
  new.sha := encode(sha256(convert_to(new.body, 'UTF8')), 'hex');
  return new;
end $function$;
revoke all on function public.legal_docs_guard() from public, anon, authenticated;
drop trigger if exists legal_docs_guard on public.legal_docs;
create trigger legal_docs_guard before insert or update or delete on public.legal_docs
  for each row execute function public.legal_docs_guard();

-- Loading one document and making it the current one, in one move. Run by
-- hand in the SQL editor (nobody signed in to the app can call it), once for
-- each document, all three in the same run:
--
--   select public.legal_publish('nda',     '1.0', '<its title>', $doc$<its words, exactly>$doc$);
--   select public.legal_publish('terms',   '1.0', '<its title>', $doc$<its words, exactly>$doc$);
--   select public.legal_publish('privacy', '1.0', '<its title>', $doc$<its words, exactly>$doc$);
--
-- It answers with the fingerprint, to hold against "shasum -a 256" of the
-- file the words came from (the same bytes give the same answer; a paste that
-- changed a character does not). Running it again with the same words changes
-- nothing. The same version with other words is refused. A space or a line
-- break typed around the version or the title is taken off before anything
-- else ('1.0 ' is '1.0'); the words themselves are kept exactly as given.
create or replace function public.legal_publish(d text, v text, t text, b text)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  h text := encode(sha256(convert_to(coalesce(b, ''), 'UTF8')), 'hex');
  r public.legal_docs%rowtype;
begin
  v := regexp_replace(coalesce(v, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  t := regexp_replace(coalesce(t, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  if d is null or d not in ('nda', 'terms', 'privacy') then
    raise exception 'the document is nda, terms or privacy' using errcode = '22023';
  end if;
  if btrim(coalesce(v, '')) = '' or btrim(coalesce(t, '')) = '' or btrim(coalesce(b, '')) = '' then
    raise exception 'a version, a title and the words are all needed' using errcode = '22023';
  end if;
  select x.* into r from legal_docs x where x.doc = d and x.version = v;
  if found and r.sha <> h then
    raise exception 'that version is already here with other words' using errcode = 'P0001',
      hint = 'Give the new words a new version.';
  end if;
  update legal_docs x set is_current = false where x.doc = d and x.is_current and x.version <> v;
  insert into legal_docs (doc, version, title, body, sha, is_current) values (d, v, t, b, h, true)
  on conflict (doc, version) do update set is_current = true, title = excluded.title;
  return jsonb_build_object('doc', d, 'version', v, 'sha', h, 'letters', char_length(b));
end $function$;
revoke all on function public.legal_publish(text, text, text, text) from public, anon, authenticated;

-- ============================== 4. Where a person stands ==============================
-- One place works it out, for everything below. "ready": all three documents
-- have a current version. "needs": ready, and the person has never agreed or
-- a current version is not the one they last agreed to. "changed": which ones,
-- for someone who agreed before (empty for someone who never has).
create or replace function public.legal_state(u uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with cur as (
    select count(*) = 3 as ready,
           max(d.version) filter (where d.doc = 'nda') as nda,
           max(d.version) filter (where d.doc = 'terms') as terms,
           max(d.version) filter (where d.doc = 'privacy') as privacy
      from legal_docs d
     where d.is_current
  ), acc as (
    select a.accepted_at, a.nda_version, a.terms_version, a.privacy_version
      from legal_acceptances a
     where a.user_id = u
     order by a.accepted_at desc, a.id desc
     limit 1
  )
  select jsonb_build_object(
    'ready', c.ready,
    'needs', c.ready and (l.accepted_at is null
                          or l.nda_version is distinct from c.nda
                          or l.terms_version is distinct from c.terms
                          or l.privacy_version is distinct from c.privacy),
    'accepted_at', l.accepted_at,
    'versions', case when l.accepted_at is null then null
                     else jsonb_build_object('nda', l.nda_version, 'terms', l.terms_version, 'privacy', l.privacy_version) end,
    'current', case when c.ready then jsonb_build_object('nda', c.nda, 'terms', c.terms, 'privacy', c.privacy) end,
    'changed', case when c.ready and l.accepted_at is not null
                    then to_jsonb(array_remove(array[
                           case when l.nda_version is distinct from c.nda then 'nda'::text end,
                           case when l.terms_version is distinct from c.terms then 'terms'::text end,
                           case when l.privacy_version is distinct from c.privacy then 'privacy'::text end], null::text))
                    else '[]'::jsonb end)
    from cur c left join acc l on true
$function$;
revoke all on function public.legal_state(uuid) from public, anon, authenticated;

-- Does this account still have the documents to agree to? Never anything but
-- yes or no, and no while the documents are not loaded.
create or replace function public.legal_needs(u uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(u is not null and (public.legal_state(u) ->> 'needs')::boolean, false)
$function$;
revoke all on function public.legal_needs(uuid) from public, anon, authenticated;

-- For the app: the person signed in, and nobody else.
create or replace function public.legal_status()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when auth.uid() is null then null else public.legal_state(auth.uid()) end
$function$;
revoke all on function public.legal_status() from public, anon;
grant execute on function public.legal_status() to authenticated;

-- ============================== 5. Handing the documents out ==============================
-- To someone signed in, or to someone holding a live Greenroom code and
-- nobody else. The code is tested by signup_code_check itself (0134), not by
-- a copy of it: the same count of wrong tries for each address, the same
-- "wait" after ten, and whatever is tightened there later holds here too. It
-- only looks at the code. It does not spend a use.
-- A wrong code, no code, or a caller told to wait gets {"ok": false} and no
-- documents. "ready" is false, with no documents, until all three are loaded.
create or replace function public.legal_docs_for(c text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare chk jsonb;
begin
  if auth.uid() is null then
    chk := public.signup_code_check(c);
    if coalesce(chk ->> 'ok', '') <> 'true' then return jsonb_build_object('ok', false); end if;
  end if;
  if (select count(*) from legal_docs d where d.is_current) <> 3 then
    return jsonb_build_object('ok', true, 'ready', false, 'docs', '[]'::jsonb);
  end if;
  return jsonb_build_object('ok', true, 'ready', true, 'docs', (
    select jsonb_agg(jsonb_build_object('doc', d.doc, 'title', d.title, 'version', d.version,
                                        'body', d.body, 'sha', d.sha, 'published_at', d.published_at)
                     order by array_position(array['nda', 'terms', 'privacy'], d.doc))
      from legal_docs d
     where d.is_current));
end $function$;
revoke all on function public.legal_docs_for(text) from public;
grant execute on function public.legal_docs_for(text) to anon, authenticated;

-- ============================== 6. "I Agree" ==============================
-- Signed in only. The versions the phone showed must be the current ones (a
-- phone holding last month's pages is told "stale" and shows the new ones),
-- and the account's email must be confirmed. One row is stored. Asked again
-- while the same versions are current, it stores nothing and answers with the
-- row that is there.
--
-- The address is read the way signup_code_redeem reads it (signup_caller,
-- 0134): the network's own word for where the request came from, which a
-- caller cannot write. The user agent is the phone's own description of
-- itself: it is kept as it was said, and nothing is ever decided by it.
--
-- "said" is whatever the phone sent as the sentence beside the box. It is
-- trimmed, cut to 600 letters and refused when empty, and that is all: it is
-- NOT compared with anything. The database does not hold the sentence and
-- does not check the wording, so that a change of wording in the app can never
-- lock people out. Read the column as "what the phone said was on the screen",
-- never as proof that the database checked it. What a row does prove, because
-- the database worked each of these out itself: which account, its email,
-- when, from which address, which versions, and the fingerprints of the words
-- stored under those versions at that moment.
create or replace function public.legal_accept(nda_v text, terms_v text, privacy_v text, said text, via text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  me uuid := auth.uid();
  v_said text := left(btrim(coalesce(said, '')), 600);
  v_via text := lower(btrim(coalesce(via, '')));
  c_nda public.legal_docs%rowtype;
  c_terms public.legal_docs%rowtype;
  c_privacy public.legal_docs%rowtype;
  prev public.legal_acceptances%rowtype;
  v_email text;
  v_confirmed timestamptz;
  hdr json;
  v_ip text := '';
  v_agent text := '';
  made timestamptz;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  select d.* into c_nda from legal_docs d where d.doc = 'nda' and d.is_current;
  select d.* into c_terms from legal_docs d where d.doc = 'terms' and d.is_current;
  select d.* into c_privacy from legal_docs d where d.doc = 'privacy' and d.is_current;
  if c_nda.version is null or c_terms.version is null or c_privacy.version is null then
    return jsonb_build_object('ok', false, 'why', 'not ready');
  end if;
  if nda_v is distinct from c_nda.version or terms_v is distinct from c_terms.version
     or privacy_v is distinct from c_privacy.version then
    return jsonb_build_object('ok', false, 'why', 'stale');
  end if;
  select lower(btrim(coalesce(u.email, ''))), u.email_confirmed_at into v_email, v_confirmed
    from auth.users u where u.id = me;
  if coalesce(v_email, '') = '' or v_confirmed is null then
    return jsonb_build_object('ok', false, 'why', 'email');
  end if;
  -- (a record with no sentence, or from a door that does not exist, is not a record)
  if v_via not in ('code', 'invite', 'inside') then return jsonb_build_object('ok', false, 'why', 'via'); end if;
  if v_said = '' then return jsonb_build_object('ok', false, 'why', 'said'); end if;

  -- (two taps at the same moment are one agreement)
  perform pg_advisory_xact_lock(hashtext('legal:' || me::text));
  select a.* into prev from legal_acceptances a
   where a.user_id = me order by a.accepted_at desc, a.id desc limit 1;
  if found and prev.nda_version = c_nda.version and prev.terms_version = c_terms.version
     and prev.privacy_version = c_privacy.version then
    return jsonb_build_object('ok', true, 'at', prev.accepted_at, 'versions',
      jsonb_build_object('nda', prev.nda_version, 'terms', prev.terms_version, 'privacy', prev.privacy_version));
  end if;

  -- (a header that cannot be read never stops an agreement being recorded)
  begin
    v_ip := coalesce(nullif(public.signup_caller(), '?'), '');
  exception when others then v_ip := '';
  end;
  begin
    hdr := nullif(current_setting('request.headers', true), '')::json;
    v_agent := left(coalesce(hdr ->> 'user-agent', ''), 300);
  exception when others then v_agent := '';
  end;

  insert into legal_acceptances (user_id, email_lc, ip, agent, nda_version, terms_version, privacy_version,
                                 nda_sha, terms_sha, privacy_sha, said, via)
  values (me, v_email, v_ip, v_agent, c_nda.version, c_terms.version, c_privacy.version,
          c_nda.sha, c_terms.sha, c_privacy.sha, v_said, v_via)
  returning accepted_at into made;
  return jsonb_build_object('ok', true, 'at', made, 'versions',
    jsonb_build_object('nda', c_nda.version, 'terms', c_terms.version, 'privacy', c_privacy.version));
end $function$;
revoke all on function public.legal_accept(text, text, text, text, text) from public, anon;
grant execute on function public.legal_accept(text, text, text, text, text) to authenticated;
-- (the same warning where the column is looked at: in the table itself)
comment on function public.legal_accept(text, text, text, text, text) is
  'Records that the person signed in agreed to the three current documents. The versions must be the current ones and the email confirmed. "said" is stored as the phone sent it and is not compared with anything.';
comment on column public.legal_acceptances.said is
  'The sentence the phone sent with the tick, kept as sent. The database does not compare it with anything, so it is not proof that the wording was checked.';

-- ============================== 7. The first-run facts ==============================
-- my_first_run exactly as it stands in 0134, with one key more: needs_legal,
-- the same yes or no as legal_status().needs.
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
    'hasBirth', exists (select 1 from profile_private x where x.user_id = auth.uid() and x.birth_date is not null),
    'needs_legal', public.legal_needs(auth.uid())) end
$function$;
revoke all on function public.my_first_run() from public, anon;
grant execute on function public.my_first_run() to authenticated;

-- finish_first_run exactly as it stands in 0134, with one line more: it does
-- not finish while the documents are waiting, and says that it did not.
create or replace function public.finish_first_run(k text[])
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  if public.legal_needs(me) then return jsonb_build_object('ok', false, 'why', 'legal'); end if;
  update profiles set kinds = public.clean_kinds(k), onboarded_at = coalesce(onboarded_at, now()) where user_id = me;
  if not found then
    insert into profiles (user_id, kinds, onboarded_at) values (me, public.clean_kinds(k), now())
    on conflict (user_id) do update set kinds = excluded.kinds, onboarded_at = coalesce(profiles.onboarded_at, now());
  end if;
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.finish_first_run(text[]) from public, anon;
grant execute on function public.finish_first_run(text[]) to authenticated;

-- ============================== 8. A seat on a tour waits for the documents ==============================
-- Two functions attach a tour invite to an account, and nothing else does:
-- link_invite, when a Manager invites an address that already has an account
-- (the server calls it), and claim_invites, each time a person opens the app.
-- Each gets one line more: an account that still has the documents to agree
-- to is not attached. Nothing is refused and nothing is undone: the invite
-- waits, the app asks again once the person has agreed, and it goes through
-- then. Someone already on a tour stays on it.

-- link_invite exactly as it stands in 0134, with the last line added.
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
     and (coalesce(u.encrypted_password, '') <> '' or u.last_sign_in_at is not null)
     and not public.legal_needs(u.id);
$function$;
-- (as 0019 set them: the server only)
revoke all on function public.link_invite(text, text) from public, anon, authenticated;
grant execute on function public.link_invite(text, text) to service_role;

-- claim_invites exactly as it stands in 0001, with the last line added.
create or replace function public.claim_invites()
returns void language sql security definer set search_path = public as $$
  update members
    set user_id = auth.uid()
    where user_id is null
      and lower(invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and not public.legal_needs(auth.uid())
$$;
-- (as 0075 left them: signed-in accounts only)
revoke all on function public.claim_invites() from public, anon;
grant execute on function public.claim_invites() to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
-- The quick way needs none of this: "update public.legal_docs set is_current
-- = false;" and nobody is asked for anything (the switch-off at the top).
--
-- To take the change out altogether, in this order.
--
-- BEFORE ANYTHING ELSE, if 0138 has been applied: put my_role back the way
-- 0138's own rollback block says. my_role calls legal_needs and every tour
-- rule calls my_role, so dropping legal_needs while 0138 is in place would
-- make every read of every tour fail. (The database does not stop that drop.)
--
-- Then the four functions go back to their old words, because the new ones
-- call legal_needs too:
--
--   create or replace function public.my_first_run()
--    returns jsonb
--    language sql
--    stable security definer
--    set search_path to 'public'
--   as $function$
--     select case when auth.uid() is null then null else jsonb_build_object(
--       'onboarded', coalesce((select p.onboarded_at is not null from profiles p where p.user_id = auth.uid()), false),
--       'kinds', coalesce((select to_jsonb(p.kinds) from profiles p where p.user_id = auth.uid()), '[]'::jsonb),
--       'handle', coalesce((select p.handle from profiles p where p.user_id = auth.uid()), ''),
--       'hasBirth', exists (select 1 from profile_private x where x.user_id = auth.uid() and x.birth_date is not null)) end
--   $function$;
--
--   create or replace function public.finish_first_run(k text[])
--    returns jsonb
--    language plpgsql
--    security definer
--    set search_path to 'public'
--   as $function$
--   declare me uuid := auth.uid();
--   begin
--     if me is null then raise exception 'permission' using errcode = '42501'; end if;
--     update profiles set kinds = public.clean_kinds(k), onboarded_at = coalesce(onboarded_at, now()) where user_id = me;
--     if not found then
--       insert into profiles (user_id, kinds, onboarded_at) values (me, public.clean_kinds(k), now())
--       on conflict (user_id) do update set kinds = excluded.kinds, onboarded_at = coalesce(profiles.onboarded_at, now());
--     end if;
--     return jsonb_build_object('ok', true);
--   end $function$;
--
--   create or replace function public.link_invite(t_id text, addr text)
--    returns void
--    language sql
--    security definer
--    set search_path to 'public', 'auth'
--   as $function$
--     update public.members m
--        set user_id = u.id
--       from auth.users u
--      where m.tour_id = t_id
--        and m.user_id is null
--        and lower(m.invited_email) = lower(addr)
--        and lower(u.email) = lower(addr)
--        and u.email_confirmed_at is not null
--        and (coalesce(u.encrypted_password, '') <> '' or u.last_sign_in_at is not null);
--   $function$;
--
--   create or replace function public.claim_invites()
--   returns void language sql security definer set search_path = public as $$
--     update members
--       set user_id = auth.uid()
--       where user_id is null
--         and lower(invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
--   $$;
--
--   drop function if exists public.legal_accept(text, text, text, text, text);
--   drop function if exists public.legal_docs_for(text);
--   drop function if exists public.legal_status();
--   drop function if exists public.legal_needs(uuid);
--   drop function if exists public.legal_state(uuid);
--   drop function if exists public.legal_publish(text, text, text, text);
--   drop trigger if exists legal_docs_guard on public.legal_docs;
--   drop function if exists public.legal_docs_guard();
--   drop table if exists public.legal_docs;
--
--   -- legal_acceptances is the record of who agreed to what, and when. Keep
--   -- it, and keep its guard (legal_acceptances_guard needs nothing from the
--   -- functions above). Nothing reads the table once those are gone. Drop it
--   -- only after a copy has been saved somewhere; the guard goes with it:
--   --   drop table if exists public.legal_acceptances;
--   --   drop function if exists public.legal_acceptances_guard();
--
--   notify pgrst, 'reload schema';
