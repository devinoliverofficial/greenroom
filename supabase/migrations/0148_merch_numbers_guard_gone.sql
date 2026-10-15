-- The stopgap for MERCH NUMBERS comes out (2026-10-15).
--
-- 0133 kept a phone's MERCH NUMBERS switch on only for someone who managed
-- every tour they were on, because Ari then sent merch numbers to every phone
-- on a tour with the switch on, crew included. The notify and ari functions
-- pasted on Oct 15 ask the tour's own list of Managers (tour_managers) for each
-- tour and send merch numbers to them only. So the switch can stay as the
-- person set it: someone who manages one tour and crews another gets the merch
-- numbers of the tour they manage, and nobody else's. 0133 said to drop these
-- once the functions were pasted.
--
-- Nothing a phone has stored changes here. (A switch the stopgap turned off
-- stays off until its owner turns it on again in Notifications.)

drop trigger if exists push_subs_guard on public.push_subs;
drop trigger if exists members_push_recheck on public.members;
drop function if exists public.push_subs_guard();
drop function if exists public.members_push_recheck();
drop function if exists public.push_merch_ok(uuid);

-- Rollback: run the push_merch_ok, push_subs_guard and members_push_recheck
-- blocks of 0133_managers_and_crew.sql again (the functions, their revokes and
-- the two triggers), exactly as written there.
