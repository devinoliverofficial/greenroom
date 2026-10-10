-- The daily re-read, one step further (2026-10-10, from the review of 0128).
-- 0128 settles each page of the re-read as it lands, so a person's page (which
-- counts the nights as they are) no longer moves about for half an hour a day.
-- But the artist page, and a band member's Tours list and the count under the
-- act, are read from the count kept at the last sync, which was only made
-- again when the whole re-read finished. So when a page of the re-read brought
-- a real change (a setlist added, a city corrected), a member's numbers moved
-- at once and the artist page and the member's own list followed up to half an
-- hour later. Now the count is made again with every settled page: the three
-- move together.
--
-- Measured on I See Stars (1,350 nights): settle 2.4 s, count 1.2 s. The step
-- runs once a minute from the schedule, and also when someone has the artist
-- page open during the re-read (that call has an 8 second limit, and falls
-- back to a plain read if it is ever passed: the page is then taken by the
-- schedule a minute later).
create or replace function public.setlist_settle_page(a_id uuid)
returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not exists (select 1 from artist_history where artist_id = a_id and synced_at is not null) then return; end if;
  begin
    perform public.tour_find_apply(a_id);
    perform public.tour_fact_check(a_id);
    perform public.setlist_summarize(a_id);
  exception when others then
    null;
  end;
end $$;
revoke all on function public.setlist_settle_page(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
