-- The documents are for the people Greenroom lets in, not for Greenroom itself
-- (Devin, 2026-10-11: "stop asking me to sign my own NDA i am not doing this").
-- The tester NDA, the Terms and the Privacy Policy are between his company and
-- each person who uses the app. He is the other side of them.
--
-- So: an account that runs Greenroom (a row in platform_admins; today that is
-- one person) is never asked. Everything that asks "does this account still
-- have the documents to agree to?" goes through legal_state, so this one line
-- is the whole change: the pages do not come up for that account, its seat on
-- a tour and its first run are not held, and it is not on any list of people
-- who have yet to agree. Everyone else is asked exactly as before.
--
-- legal_state is copied word for word from 0137 with one condition added to
-- "needs" (the line that names platform_admins).
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
    'needs', c.ready
             and not exists (select 1 from platform_admins p where p.user_id = u)
             and (l.accepted_at is null
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

notify pgrst, 'reload schema';

-- To roll back: run the legal_state function from 0137_legal.sql again (the
-- same text without the platform_admins line).
