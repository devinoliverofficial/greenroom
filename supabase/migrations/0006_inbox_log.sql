-- Every email the app's mailbox receives, and what became of it. No RLS
-- policies: the service role (the inbox function) writes, nobody else reads.
create table if not exists public.inbox_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  sender text not null default '',
  subject text not null default '',
  status text not null default '',
  detail text not null default ''
);
alter table public.inbox_log enable row level security;
