-- Who has agreed (Devin, 2026-10-11): "as the creator i should have a full
-- list in my settings but ONLY ME."
--
-- 0137 keeps one row each time a person agrees to the three documents, and
-- lets each person read only their own. This adds the one place where the
-- whole record can be read: a single function, legal_list(), for Greenroom's
-- own admin and nobody else.
--
-- "Only me" is the rule Greenroom already has for its own people: is_admin()
-- (0073), which is true for an account listed in platform_admins. That table
-- is filled by hand, nobody signed in to the app can read or write it, and it
-- holds one account today: Devin's. The Invite codes sheet (invite_codes(),
-- 0134) is kept behind the same rule in the same way.
--
-- What legal_list() answers:
--   * to an admin, three things:
--       "agreed":  every row of legal_acceptances, newest first. For each:
--                  the email as it was when they agreed, the person's name
--                  and username while the account still exists, when, by
--                  which door, the three versions and whether those are the
--                  current ones, the network address, the phone's own
--                  description of itself, the fingerprint of each document,
--                  the sentence the phone sent with the tick, and whether the
--                  account has since been deleted.
--       "waiting": every account that still has the current documents to
--                  agree to, oldest account first. For each: email, name,
--                  username, when the account was made, and whether it is a
--                  tour invite that has not been opened yet. Empty while the
--                  three documents are not all loaded, because nobody is
--                  being asked for anything then.
--       "current": the three current versions, or null when they are not all
--                  loaded.
--     Each list stops at 2000.
--   * to anyone else who is signed in: null. Not an error and nothing more.
--     The app shows its Settings row only when it is handed a list, so for
--     everyone else there is no row and nothing to learn.
--   * to someone who is not signed in: they may not run it at all.
--
-- It only reads. No table is added, and no existing function, rule or grant
-- is changed. legal_acceptances itself is as closed as 0137 left it: a person
-- still reads only their own rows there, an admin included. The whole list
-- exists only as this function's answer.
--
-- Needs 0137 (the two tables it reads) and 0073 (is_admin). Safe to apply
-- while the app is live, before or after the app that shows the row: an app
-- without the row never asks, and an app with the row and no function gets no
-- list and shows no row. Safe to run twice.

-- (stop here, with nothing changed, if what it reads is not in place)
do $$ begin
  if to_regclass('public.legal_acceptances') is null or to_regclass('public.legal_docs') is null then
    raise exception '0137 first: public.legal_acceptances is not here' using errcode = 'P0001';
  end if;
  if to_regprocedure('public.is_admin()') is null then
    raise exception '0073 first: public.is_admin is not here' using errcode = 'P0001';
  end if;
end $$;

-- ============================== The whole list, for an admin ==============================
-- "Who still has to agree" is worked out by the rule legal_state uses (0137),
-- written here for every account at once instead of one account at a time:
-- the documents are ready when all three have a current version; an account
-- still has them to agree to when it has never agreed, or when one of the
-- versions it LAST agreed to (latest accepted_at, then highest id) is not the
-- current one. If that rule is ever changed in legal_state, change it here.
-- It was, once already (0140): an account that runs Greenroom is never asked,
-- so it is never on the list of people who have yet to agree.
--
-- "confirmed" on a waiting row: the address was proved, or the person has
-- signed in. A sign-up that typed an address and never typed the code that
-- was emailed to it is not a person who is in Greenroom, and the app says so.
--
-- A name is the one the app shows (person_name, 0055): the full name, else
-- first and last, else nothing. A row whose account is gone has no profile
-- left, so its name and username are empty and the email is the record.
--
-- "invited": the account was made by a tour invite (invited_at) and nobody
-- has signed in to it yet (last_sign_in_at).
create or replace function public.legal_list()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_ready boolean;
  v_nda text;
  v_terms text;
  v_privacy text;
begin
  -- (anything but a plain yes is a no)
  if public.is_admin() is not true then return null; end if;

  select count(*) = 3,
         max(d.version) filter (where d.doc = 'nda'),
         max(d.version) filter (where d.doc = 'terms'),
         max(d.version) filter (where d.doc = 'privacy')
    into v_ready, v_nda, v_terms, v_privacy
    from legal_docs d
   where d.is_current;

  return jsonb_build_object(
    'agreed', coalesce((
      select jsonb_agg(x.j order by x.id desc)
        from (select a.id,
                     jsonb_build_object(
                       'email', a.email_lc,
                       'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
                       'handle', coalesce(p.handle, ''),
                       'at', a.accepted_at,
                       'via', a.via,
                       'versions', jsonb_build_object('nda', a.nda_version, 'terms', a.terms_version, 'privacy', a.privacy_version),
                       'current', coalesce(v_ready and a.nda_version = v_nda and a.terms_version = v_terms
                                           and a.privacy_version = v_privacy, false),
                       'ip', a.ip,
                       'agent', a.agent,
                       'shas', jsonb_build_object('nda', a.nda_sha, 'terms', a.terms_sha, 'privacy', a.privacy_sha),
                       'said', a.said,
                       'gone', a.user_id is null) as j
                from legal_acceptances a
                left join profiles p on p.user_id = a.user_id
               order by a.id desc
               limit 2000) x), '[]'::jsonb),
    'waiting', coalesce((
      select jsonb_agg(w.j order by w.created_at, w.id)
        from (select u.created_at, u.id,
                     jsonb_build_object(
                       'email', coalesce(u.email, ''),
                       'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
                       'handle', coalesce(p.handle, ''),
                       'since', u.created_at,
                       'invited', u.invited_at is not null and u.last_sign_in_at is null,
                       'confirmed', u.email_confirmed_at is not null or u.last_sign_in_at is not null) as j
                from auth.users u
                left join lateral (select a.accepted_at, a.nda_version, a.terms_version, a.privacy_version
                                     from legal_acceptances a
                                    where a.user_id = u.id
                                    order by a.accepted_at desc, a.id desc
                                    limit 1) l on true
                left join profiles p on p.user_id = u.id
               where v_ready
                 and not exists (select 1 from platform_admins pa where pa.user_id = u.id)
                 and (l.accepted_at is null
                      or l.nda_version is distinct from v_nda
                      or l.terms_version is distinct from v_terms
                      or l.privacy_version is distinct from v_privacy)
               order by u.created_at, u.id
               limit 2000) w), '[]'::jsonb),
    'current', case when v_ready then jsonb_build_object('nda', v_nda, 'terms', v_terms, 'privacy', v_privacy) end);
end $function$;
-- (signed-in accounts may run it, and it answers null to every one of them
-- that is not an admin; nobody else may run it)
revoke all on function public.legal_list() from public, anon;
grant execute on function public.legal_list() to authenticated;
comment on function public.legal_list() is
  'For a Greenroom admin (is_admin) only: everyone who agreed to the documents, with the full record of each agreement, and every account that still has the current ones to agree to. Null for anyone else. It only reads.';

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
-- Nothing else calls it and it holds nothing, so it can go at any time. The
-- app's row "Who has agreed" stops showing, and nothing else changes.
--
--   drop function if exists public.legal_list();
--   notify pgrst, 'reload schema';
