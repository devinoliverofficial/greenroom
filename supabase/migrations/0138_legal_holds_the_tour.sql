-- The documents hold back the tour, not only the seat (2026-10-11).
--
-- 0137 made a seat on a tour wait for the documents: an invite is not attached
-- to an account that still has them to agree to. Three reviews found the same
-- gap behind it. my_role is the one function every tour rule asks "who is
-- this person on this tour?", and it has always answered for an invited
-- address whether or not the invite is attached yet: a members row whose
-- invited_email is the email in the caller's sign-in counts. So someone
-- invited to a tour, signed in with that address and NOT yet agreed, could
-- still read the tour by calling the API directly, and change it if invited
-- as a Manager. Through the app's own screens the pages stop them. The
-- database did not.
--
-- What changes: in my_role, the match on the invited email now also needs the
-- caller to have no documents waiting. That match appears twice (the tour
-- itself, and the Off Tour book reached through one of the artist's tours)
-- and both are changed the same way. Nothing else in the function is touched:
-- it is copied from 0132, where it was last written.
--
-- Who is not affected:
--   * the tour's creator (the first branch, unchanged);
--   * anyone already attached to the tour (members.user_id is their account).
--     That test is unchanged and comes first. Someone attached before the
--     documents were loaded, or before a version changed, keeps their tour
--     while the app asks them to agree: this function does not lock them out;
--   * everybody, while the three documents are not loaded: legal_needs is
--     false for all, so the email match answers exactly as it did.
--
-- What it costs: the new test is a sub-select that does not depend on the
-- row, so the database works it out at most once in a call of my_role, and
-- only when it reaches a members row that carries the caller's email without
-- being attached to their account. For the creator and for everyone attached
-- it is never worked out at all. When it is, it is two small reads
-- (legal_needs, 0137).
--
-- What this does NOT cover (they do not go through my_role; left as they are,
-- for a decision): the rule on the crew list still shows an invited address
-- its own row (members_select, 0007), and my_person (0033) still knows an
-- invited address, so the old check-in call still answers for it.
--
-- Needs 0137 (it calls legal_needs): apply 0137 first. Safe to run twice.

-- (stop here, with nothing changed, if 0137 is not in place: every tour rule
-- calls my_role, so it must never be left calling something that is not there)
do $$ begin
  if to_regprocedure('public.legal_needs(uuid)') is null then
    raise exception '0137 first: public.legal_needs is not here' using errcode = 'P0001';
  end if;
end $$;

-- my_role exactly as it stands in 0132, with the two email matches gated.
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
               or (lower(m.invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
                   and not (select public.legal_needs(auth.uid()))))
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
                    or (lower(m.invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
                        and not (select public.legal_needs(auth.uid())))))
        limit 1)
    )
  end
$function$;
-- (as 0075 left them: signed-in accounts only. "create or replace" keeps the
-- rights a function has; these two lines only say them again)
revoke all on function public.my_role(text) from public, anon;
grant execute on function public.my_role(text) to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
-- The quick way needs none of this: "update public.legal_docs set is_current
-- = false;" (0137's switch-off) and the new test is false for everybody, so
-- my_role answers as it did before.
--
-- To take the change out, run the old words (0132, word for word). This must
-- be done BEFORE 0137 is rolled back: the function above calls legal_needs,
-- and every tour rule calls this function.
--
--   create or replace function public.my_role(t_id text)
--    RETURNS text
--    LANGUAGE sql
--    STABLE SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--     select case
--       when exists (select 1 from tours where id = t_id and owner_id = auth.uid())
--         then 'owner'
--       else coalesce(
--         (select m.role from members m
--           where m.tour_id = t_id
--             and (m.user_id = auth.uid()
--                  or lower(m.invited_email) = lower(coalesce(auth.jwt() ->> 'email', '')))
--           limit 1),
--         (select 'editor' from tours o
--           where o.id = t_id and o.doc ->> 'kind' = 'offtour'
--             and exists (
--               select 1 from tours t join members m on m.tour_id = t.id
--                where t.owner_id = o.owner_id and t.id <> o.id
--                  and (t.doc ->> 'deletedAt') is null
--                  and lower(trim(coalesce(t.doc ->> 'artist', ''))) = lower(trim(coalesce(o.doc ->> 'artist', '')))
--                  and m.role = 'editor'
--                  and (m.user_id = auth.uid()
--                       or lower(m.invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))))
--           limit 1)
--       )
--     end
--   $function$;
--
--   notify pgrst, 'reload schema';
