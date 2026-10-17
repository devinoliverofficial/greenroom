-- One rating per person per show, for good (Devin, 2026-10-17: "Once you
-- rate the show you can't rate again (obviously until next time you
-- play)"). Until now 0154 let the band change a rating any time: an update
-- policy with no rule beyond the person and the band, and a delete policy
-- that would let anyone take their row off and send a fresh one.
--
-- The primary key (tour_id, show_id, user_id) already makes it one row per
-- person per night, and "next time you play" is a new show, so a new
-- show_id and a new row. What changes here is only that a row, once sent,
-- stands:
--
--   1. The update and delete policies go, and so does the right itself:
--      authenticated keeps select and insert alone. Without UPDATE a client
--      upsert (INSERT ... ON CONFLICT DO UPDATE) is refused outright, so the
--      app sends a plain insert, and a second send for the same night is
--      refused by the primary key (23505), which the app reads as "already
--      rated".
--   2. Deleting an account still removes its rows: the user_id foreign key
--      cascades on its own authority, not this right. A tour deleted takes
--      its rows the same way.
--
-- No function writes this table; reads (venue_history, review_venue_score,
-- venue_card) are untouched.

drop policy if exists show_ratings_update on public.show_ratings;
drop policy if exists show_ratings_delete on public.show_ratings;
revoke update, delete on public.show_ratings from authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   grant update, delete on public.show_ratings to authenticated;
--   and recreate show_ratings_update and show_ratings_delete exactly as
--   0154_venues_and_ratings.sql writes them. The app's plain insert works
--   either way; with the rights back a second rating is still refused by
--   the primary key, so the app keeps rating once until it, too, goes back.
