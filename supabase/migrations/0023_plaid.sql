-- MODEL5: the card feed reads the cards through Plaid instead of YNAB.
--
-- One row per bank connection ("Item"). The key Plaid gives for it is stored
-- scrambled (AES-GCM) with a password only the tour manager knows, kept in
-- the plaid function's secrets, so the database alone can't use it. Row-level
-- security is on and no policy exists: only the server reads or writes here,
-- and the key never leaves the server. env keeps test (sandbox) connections
-- apart from real (production) ones.
create table if not exists public.plaid_items (
  owner_id uuid not null references auth.users (id) on delete cascade,
  item_id text not null,
  env text not null check (env in ('sandbox', 'production')),
  institution text not null default '',
  token_enc text not null,
  cursor text,
  status text not null default 'ok',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, item_id)
);
alter table public.plaid_items enable row level security;

-- Which service a manager's feed reads from. Existing feeds were YNAB.
alter table public.feed add column if not exists source text not null default 'ynab'
  check (source in ('ynab', 'plaid'));
