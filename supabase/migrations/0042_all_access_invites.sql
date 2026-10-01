-- Anyone with ALL ACCESS invites crew, and edits or kicks people off the tour
-- (Devin, 2026-10-01). Editing and kicking already went through edit_member
-- and kick_member for the owner and ALL ACCESS; inviting (and taking back an
-- invite) now does too.
drop policy if exists members_insert on public.members;
create policy members_insert on public.members for insert
  with check (public.my_role(tour_id) in ('owner', 'editor'));
drop policy if exists members_update on public.members;
create policy members_update on public.members for update
  using (public.my_role(tour_id) in ('owner', 'editor'))
  with check (public.my_role(tour_id) in ('owner', 'editor'));
drop policy if exists members_delete on public.members;
create policy members_delete on public.members for delete
  using (public.my_role(tour_id) in ('owner', 'editor'));
