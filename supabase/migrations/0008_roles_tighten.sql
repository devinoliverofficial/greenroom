-- Devin's spec, 2026-09-26: only the tour manager edits — ALL ACCESS sees
-- everything but changes nothing, GA sees the road side only. And the money
-- talk (Ari's breakdowns, atVenu's filing notes) never reaches GA, enforced
-- here rather than politely hidden in the UI.
drop policy if exists tours_update on public.tours;
create policy tours_update on public.tours for update
  using (public.my_role(id) = 'owner')
  with check (public.my_role(id) = 'owner');

drop policy if exists notes_select on public.notes;
create policy notes_select on public.notes for select
  using (public.my_role(tour_id) is not null
         and (public.my_role(tour_id) in ('owner', 'editor')
              or author not in ('Ari', 'atVenu')));
