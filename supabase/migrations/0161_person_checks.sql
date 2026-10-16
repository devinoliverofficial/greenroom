-- THE GREEN CHECK EVERYWHERE (Devin, 2026-10-16): "people don't have the
-- check mark in the members section of the artist profile. If someone has a
-- checkmark it should apply everywhere."
--
-- The rule is his of 2026-10-15, and the app already draws it on a person's
-- own page and on Crew Stats: a person wears the green check when Greenroom
-- itself checked the account, OR when they have reached Bronze (50 played
-- shows on their road story) AND hold at least one artist endorsement that
-- stands. Those two places have the road numbers and the endorsement count in
-- hand. Every other list that names a person (an artist page's Members and
-- Crew, the tour's crew on the Overview, Search, followers and following,
-- Messages, the requests waiting on a page's yes, Top Fans) holds a name, a
-- photo and at most the verified flag, so until now those lists could only
-- draw the check for an account Greenroom checked.
--
-- Why a new function: nothing answers the rule for a list of people in one
-- ask. profile_card (0147) answers it for one person, with everything else
-- on their page, and only for a profile the caller may open; road_tiers
-- (0075) answers for the people on one tour, with their numbers. A list
-- would have to ask once per person.
--
-- person_checks(uids) answers, for up to 200 account ids, each id -> true or
-- false, by the same rule, worked out here:
--   * verified: a row in verified_users (0050), as profile_card reads it;
--   * an endorsement that stands: a row in artist_endorsements not taken
--     away (removed_at is null), and not one that came with a listing taken
--     in while nobody ran the page and not yet kept by its owner (0147's
--     exclusion, the one flower_counts makes, so the count the app reads on
--     a person's page and this answer never disagree);
--   * Bronze: road_stats (0142, the person's four numbers as their page
--     shows them) at 50 shows or more. The ladder's Legacy rung needs 1,500
--     shows, so 50 shows is the whole test.
-- The cheap tests go first. road_stats is the slow part (it is a person's
-- whole road story), so it is only worked out for someone who is not
-- verified and does hold an endorsement, which is few people in any list.
-- And a list never waits on it for long: once four seconds have gone by,
-- anyone still to be counted is left out of the answer (at least one is
-- always counted, so every ask moves forward). A person left out simply
-- shows no check yet, and the phone asks for them again the next time the
-- list is drawn.
--
-- Who may ask: any signed-in account. The check is what that person's own
-- page shows anyone who opens it, and what Search already showed for a
-- checked account; a list only ever holds ids it was handed.
--
-- Nothing is stored and nothing is written. Column by column, what leaves:
-- the account ids the phone sent (back to it), and one true or false for
-- each. No name, no email, no phone number, no road numbers, no count of
-- endorsements, no artist: only whether the check is worn.

create or replace function public.person_checks(uids uuid[])
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  started timestamptz := clock_timestamp();
  res jsonb := '{}'::jsonb;
  counted int := 0;
  r record;
begin
  if auth.uid() is null then return '{}'::jsonb; end if;
  if uids is null then return res; end if;
  -- the cap: one list's people at a time (the phone sends at most 200)
  if cardinality(uids) > 200 then
    raise exception 'Ask for at most 200 people at a time.' using errcode = '22023';
  end if;
  for r in
    select x.id,
           exists (select 1 from verified_users v where v.user_id = x.id) as checked,
           -- (an endorsement that stands, as flower_counts counts one)
           exists (select 1 from artist_endorsements e
                    where e.user_id = x.id and e.removed_at is null
                      and not exists (select 1 from unclaimed_joins j
                                       where j.artist_id = e.artist_id and j.user_id = e.user_id and j.listed)) as endorsed
      from (select distinct u as id from unnest(uids) u where u is not null) x
     -- the answers that need no counting first, so the time limit only ever leaves out the slow ones
     order by 2 desc, 3, 1
  loop
    if r.checked then
      res := res || jsonb_build_object(r.id::text, true);
    elsif not r.endorsed then
      res := res || jsonb_build_object(r.id::text, false);
    elsif counted > 0 and clock_timestamp() - started > interval '4 seconds' then
      -- out of time: left out of the answer, asked again on the next draw
      continue;
    else
      counted := counted + 1;
      res := res || jsonb_build_object(r.id::text,
        coalesce((public.road_stats(r.id) ->> 'shows')::int, 0) >= 50);
    end if;
  end loop;
  return res;
end $$;
revoke all on function public.person_checks(uuid[]) from public, anon;
grant execute on function public.person_checks(uuid[]) to authenticated, service_role;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop function if exists public.person_checks(uuid[]);
--   notify pgrst, 'reload schema';
-- Nothing else leans on it: the app's probe finds no function, and every
-- list goes back to drawing the check for an account Greenroom checked, as
-- before. A person's own page and Crew Stats never asked it, so they keep
-- the full rule either way. Nothing was stored, so nothing is lost.
