-- MODEL5: Plaid's connect window runs as a Plaid-hosted page (Hosted Link), so
-- it works from the home-screen app. While a manager is in that window, the
-- server remembers which one-time pass it gave them, so afterwards it can ask
-- Plaid how it went and save the bank. One row per manager, replaced each time
-- they tap Connect. Server only: row-level security on, no policies.
create table if not exists public.plaid_pending (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  link_token text not null,
  item_id text,
  created_at timestamptz not null default now()
);
alter table public.plaid_pending enable row level security;
