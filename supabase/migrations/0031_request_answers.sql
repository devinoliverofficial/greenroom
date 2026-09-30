-- Special requests get an answer: the tour manager (or ALL ACCESS) accepts
-- or denies each one. A request waiting for an answer is what makes the
-- calendar's Special requests button glow.
alter table public.day_requests add column if not exists status text not null default 'pending'
  check (status in ('pending', 'accepted', 'denied'));
drop policy if exists day_requests_insert on public.day_requests;
alter table public.day_requests drop column if exists done;
create policy day_requests_insert on public.day_requests for insert
  with check (added_by = auth.uid() and status = 'pending' and public.my_role(tour_id) is not null);
