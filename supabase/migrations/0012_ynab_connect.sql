-- "Connect YNAB": each tour manager signs in on YNAB's own site and YNAB
-- hands Greenroom a read-only key for them. Keys live here, where only the
-- server can read them: row-level security is on and no policy lets any
-- signed-in person see a row, their own included.
create table public.ynab_links (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.ynab_links enable row level security;

-- A trip to YNAB's sign-in page and back. Single use, fifteen minutes.
create table public.ynab_states (
  state text primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  verifier text not null,
  back text not null,
  created_at timestamptz not null default now()
);
alter table public.ynab_states enable row level security;

-- Devin's feed started on a personal token saved by hand. It keeps working
-- until he connects with the button, which switches this off.
alter table public.feed add column personal_token boolean not null default false;
update public.feed set personal_token = true;

-- Two managers may connect the same YNAB plan; each keeps their own pile.
alter table public.feed_items drop constraint feed_items_pkey;
alter table public.feed_items add primary key (owner_id, id);
