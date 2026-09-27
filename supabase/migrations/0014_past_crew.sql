-- Past crew: everyone a tour manager has invited, remembered across tours
-- (and past a tour being deleted), so the next tour's invites are one tap.
-- Each tour manager sees only their own list.
create table public.past_crew (
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  email text not null,
  name text not null default '',
  phone text not null default '',
  role text not null default 'viewer' check (role in ('viewer', 'editor')),
  updated_at timestamptz not null default now(),
  primary key (owner_id, email)
);
alter table public.past_crew enable row level security;
create policy past_crew_select on public.past_crew for select using (owner_id = auth.uid());
create policy past_crew_insert on public.past_crew for insert with check (owner_id = auth.uid());
create policy past_crew_update on public.past_crew for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy past_crew_delete on public.past_crew for delete using (owner_id = auth.uid());

-- Everyone already invited to any of a manager's tours, deleted ones included.
insert into public.past_crew (owner_id, email, name, phone, role, updated_at)
select distinct on (t.owner_id, lower(m.invited_email))
       t.owner_id, lower(m.invited_email),
       coalesce(nullif(p.full_name, ''), m.display_name, ''),
       coalesce(nullif(p.phone, ''), m.phone, ''),
       m.role, m.created_at
  from public.members m
  join public.tours t on t.id = m.tour_id
  left join public.profiles p on p.user_id = m.user_id
 order by t.owner_id, lower(m.invited_email), m.created_at desc
on conflict do nothing;
