-- Who may connect YNAB at all. Until Devin opens the card feed to other tour
-- managers, only the accounts listed here see the Connect button or can
-- start the trip to YNAB. A row is readable only by the person it names, so
-- the app can tell whether to show the button; only the server adds rows.
create table public.ynab_allowed (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.ynab_allowed enable row level security;
create policy ynab_allowed_select on public.ynab_allowed for select using (owner_id = auth.uid());

insert into public.ynab_allowed (owner_id)
  select id from auth.users where email = 'devinoliverofficial@gmail.com';
