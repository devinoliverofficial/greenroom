-- Ari (and the old atVenu mailbox) speak only through the server. Anyone on
-- a tour can still post in the chat, but not under those names, so nobody
-- can put money talk in Ari's mouth.
drop policy if exists notes_insert on public.notes;
create policy notes_insert on public.notes for insert
  with check (public.my_role(tour_id) is not null
              and added_by = auth.uid()
              and author not in ('Ari', 'atVenu'));
