-- Nothing is ever erased (Devin, 2026-10-10): "an artist page can never be
-- deleted. The greenroom app is an archive. A history book. There is no
-- deleting tours or deleting artist pages ever."
--
-- Until now a tour's creator could delete it for good (and the app did so by
-- itself 30 days after a tour was moved to Recently deleted, taking its chat,
-- guest list, crew stats and flowers with it), and the account that runs an
-- artist page could delete the page (taking its member and crew lists, its
-- fans, its road history and every crew member's confirmed tours with it).
--
-- The app no longer offers either. This closes the doors in the database too,
-- so a phone still on an older build cannot do it: nobody signed in to the app
-- can delete a row of tours or of artists any more. A tour can still be taken
-- down (it moves to Recently deleted and can be restored for good).
--
-- Left as they were, on purpose, each to be decided with him:
--   * delete_my_account (an account's own data, which the App Store requires
--     an app to offer) still clears that account's taken-down tours;
--   * removing a user from the Supabase dashboard still cascades to their
--     tours and to an artist page they run;
--   * the page's road history can still be switched off or re-read, and
--     search-made pages nobody opens are still cleared after a while.

drop policy if exists tours_delete on public.tours;
drop policy if exists artists_delete on public.artists;

notify pgrst, 'reload schema';
