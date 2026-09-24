-- Guest list rows live outside the tour document on purpose: everyone on a
-- tour — GA included — can put names on the list, but only the tour manager,
-- an editor, or whoever added a guest can change or remove that guest.

create table public.guests (
  id text primary key,
  tour_id text not null references public.tours (id) on delete cascade,
  show_id text not null,
  first_name text not null default '',
  last_name text not null default '',
  affiliation text not null default '',
  email text not null default '',
  phone text not null default '',
  qty int not null default 1 check (qty between 1 and 20),
  pass_type text not null default 'GA'
    check (pass_type in ('GA', 'VIP', 'All Access', 'Photo Pass')),
  added_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.guests enable row level security;

create policy guests_select on public.guests for select
  using (public.my_role(tour_id) is not null);
create policy guests_insert on public.guests for insert
  with check (public.my_role(tour_id) is not null and added_by = auth.uid());
create policy guests_update on public.guests for update
  using (public.my_role(tour_id) in ('owner', 'editor') or added_by = auth.uid())
  with check (public.my_role(tour_id) is not null);
create policy guests_delete on public.guests for delete
  using (public.my_role(tour_id) in ('owner', 'editor') or added_by = auth.uid());

alter publication supabase_realtime add table public.guests;
