-- Greenroom schema. One jsonb document per tour (the app already speaks
-- documents), a membership table for per-tour invites, and a shared pile of
-- learned merchant labels. Row-level security does the role enforcement:
-- the tour manager edits, editors edit, viewers watch.

create table public.tours (
  id text primary key,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.members (
  tour_id text not null references public.tours (id) on delete cascade,
  invited_email text not null,
  role text not null default 'viewer' check (role in ('viewer', 'editor')),
  user_id uuid references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (tour_id, invited_email)
);

create table public.labels (
  id text primary key,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.tours enable row level security;
alter table public.members enable row level security;
alter table public.labels enable row level security;

-- Membership checks live in one place. security definer lets the policy see
-- membership rows the caller couldn't select directly.
create or replace function public.my_role(t_id text)
returns text
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from tours where id = t_id and owner_id = auth.uid())
      then 'owner'
    else (
      select m.role from members m
      where m.tour_id = t_id
        and (m.user_id = auth.uid()
             or lower(m.invited_email) = lower(coalesce(auth.jwt() ->> 'email', '')))
      limit 1
    )
  end
$$;

-- Tours: the manager and anyone invited can see; the manager and editors write.
create policy tours_select on public.tours for select
  using (public.my_role(id) is not null);
create policy tours_insert on public.tours for insert
  with check (owner_id = auth.uid());
create policy tours_update on public.tours for update
  using (public.my_role(id) in ('owner', 'editor'))
  with check (public.my_role(id) in ('owner', 'editor'));
create policy tours_delete on public.tours for delete
  using (owner_id = auth.uid());

-- Members: the manager runs the guest list; people can see rows naming them.
create policy members_select on public.members for select
  using (public.my_role(tour_id) = 'owner'
         or user_id = auth.uid()
         or lower(invited_email) = lower(coalesce(auth.jwt() ->> 'email', '')));
create policy members_insert on public.members for insert
  with check (public.my_role(tour_id) = 'owner');
create policy members_update on public.members for update
  using (public.my_role(tour_id) = 'owner');
create policy members_delete on public.members for delete
  using (public.my_role(tour_id) = 'owner');

-- Labels: one shared memory for everyone in this Greenroom, as specced —
-- "labels from anyone with edit access count".
create policy labels_select on public.labels for select
  using (auth.uid() is not null);
create policy labels_write on public.labels for insert
  with check (auth.uid() is not null);
create policy labels_update on public.labels for update
  using (auth.uid() is not null);
create policy labels_delete on public.labels for delete
  using (auth.uid() is not null);

-- When an invited person signs in for the first time, stamp their user id
-- onto the invite so it survives an email change later.
create or replace function public.claim_invites()
returns void language sql security definer set search_path = public as $$
  update members
    set user_id = auth.uid()
    where user_id is null
      and lower(invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

-- Live sync.
alter publication supabase_realtime add table public.tours;
alter publication supabase_realtime add table public.labels;
