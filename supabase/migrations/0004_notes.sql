-- Notes on a night. Like the guest list, these live outside the tour
-- document so everyone on the tour — GA included — can leave one, while
-- only the tour manager, an editor, or the author can take one back.

create table public.notes (
  id text primary key,
  tour_id text not null references public.tours (id) on delete cascade,
  day text not null,
  body text not null default '',
  author text not null default '',
  added_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index notes_tour_day on public.notes (tour_id, day);

alter table public.notes enable row level security;

create policy notes_select on public.notes for select
  using (public.my_role(tour_id) is not null);
create policy notes_insert on public.notes for insert
  with check (public.my_role(tour_id) is not null and added_by = auth.uid());
create policy notes_delete on public.notes for delete
  using (public.my_role(tour_id) in ('owner', 'editor') or added_by = auth.uid());

alter publication supabase_realtime add table public.notes;
