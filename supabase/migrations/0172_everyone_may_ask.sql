-- Anyone may ASK for a tour or show endorsement; the artist's yes is the
-- gate (Devin, 2026-10-16 night, finding the Endorsements door missing two
-- rows: "i am not seeing shows or tour endorsements in the endorsement
-- section"). Until now claims were open only to the page's runner or to
-- someone already holding an endorsement, so the door's Tour and Show rows
-- stood hidden from exactly the people meant to knock. Two changes:
--
--   1. can_claim_credits: any signed-in account. What that opens is the
--      page's own PUBLIC story (its tour list and nights, already on the
--      page for everyone) and the right to file a PENDING claim the artist
--      still has to approve - the same trust shape as the crew and Member
--      requests, which have always been open to anyone signed in. Nothing
--      approved changes hands here.
--
--   2. The artist's approve now also ENDORSES: a claim's yes from the page
--      runner mints (or restores) a standing crew endorsement for the
--      claimer, because in Devin's words these rows ARE endorsements - "They
--      asked to be endorsed for an entire tour." An approval for somebody
--      already endorsed changes nothing (the insert stands down), and a
--      declined or revoked claim mints nothing.
--
-- Nobody's data widens: a pending claim is readable only where it always
-- was (the claimer and the page's runner), and the endorsement born of a
-- yes is the same public fact every endorsement is.

create or replace function public.can_claim_credits(a_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
$$;
revoke all on function public.can_claim_credits(uuid) from public, anon;
grant execute on function public.can_claim_credits(uuid) to authenticated;

-- decide_tour_credits: 0071's live text, with one addition in the approve
-- branch - the yes mints or restores the claimer's crew endorsement.
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
    -- The yes IS the endorsement (0172): somebody already endorsed is left
    -- exactly as they stand; somebody who took theirs off gets it back.
    insert into artist_endorsements (artist_id, user_id, endorsed_by, kind, role)
    values (a_id, u_id, auth.uid(), 'crew', '')
    on conflict (artist_id, user_id) do update
      set removed_at = null, endorsed_by = excluded.endorsed_by, created_at = now()
      where artist_endorsements.removed_at is not null;
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

-- submit_tour_credits carried its own endorsement check inline; it now asks
-- the one shared rule instead (its text otherwise byte-for-byte the live
-- one, kept whole below).
CREATE OR REPLACE FUNCTION public.submit_tour_credits(a_id uuid, claim jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare me uuid := auth.uid(); norm jsonb; own boolean; v_free boolean;
begin
  -- Anyone signed in may ASK (0172); the artist's yes stays the gate.
  if me is null or not public.can_claim_credits(a_id) then
    raise exception 'permission' using errcode = '42501';
  end if;
  if not exists (select 1 from artist_history_shows h where h.artist_id = a_id) then
    raise exception 'no history' using errcode = '22023';
  end if;
  norm := public.credit_normalize(a_id, claim);
  own := public.runs_artist(a_id);
  -- nobody runs the page, and the person is not one of its Members
  v_free := not own
          and exists (select 1 from artists a where a.id = a_id and a.owner_id is null)
          and not exists (select 1 from artist_members b where b.artist_id = a_id and b.user_id = me and b.kind = 'band')
          -- (Tours one by one go on at once. ALL TOURS, an act's whole history in one tap, waits for whoever
          -- claims the page, as a Member's ask does: otherwise anyone could give themselves an act's whole record.)
          and coalesce(norm ->> 'all', '') <> 'true';
  insert into tour_credits (artist_id, user_id, approved, pending, declined, submitted_at, decided_at, declined_at)
  values (a_id, me, case when own or v_free then norm end, case when own or v_free then null else norm end, null, now(),
          case when own or v_free then now() end, null)
  on conflict (artist_id, user_id) do update
    set approved = case when own or v_free then norm else tour_credits.approved end,
        pending = case when own or v_free then null else norm end,
        declined = null,
        submitted_at = now(),
        decided_at = case when own or v_free then now() else tour_credits.decided_at end,
        declined_at = null;
  if v_free then
    insert into unclaimed_joins (artist_id, user_id, listed) values (a_id, me, false)
    on conflict (artist_id, user_id) do nothing;
  end if;
  return jsonb_build_object('ok', true, 'auto', own or v_free, 'unclaimed', v_free);
end $function$
;
revoke all on function public.submit_tour_credits(uuid, jsonb) from public, anon;
grant execute on function public.submit_tour_credits(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   Put back 0071's can_claim_credits (runner or standing endorsement) and
--   0071's decide_tour_credits (no endorsement insert) - both texts are in
--   that file - and notify pgrst, 'reload schema'. Endorsements already
--   minted by a yes stand like any other until the artist takes them off.
