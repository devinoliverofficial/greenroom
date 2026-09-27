-- The card feed (YNAB). One row per tour manager who has it, and a private
-- pile of charges waiting on them. Neither is visible to anyone else on the
-- tour: a charge only reaches the tour when the manager files it, or when its
-- account is set to log on its own and the merchant is one Greenroom knows.
-- Only spending is ever stored here. Money coming in never is.
create table public.feed (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  plan_name text not null default '',
  plan_id text not null default '',
  -- { <YNAB account id>: { name, type, mode: log | ask | off } }
  accounts jsonb not null default '{}'::jsonb,
  switched_on boolean not null default false,
  since date,
  knowledge bigint,
  last_run timestamptz,
  last_status text not null default ''
);

create table public.feed_items (
  id text primary key,                 -- YNAB's own transaction id
  owner_id uuid not null references auth.users (id) on delete cascade,
  tour_id text,
  date date not null,
  merchant text not null default '',
  amount numeric not null,             -- spent is positive; a refund is negative
  category text,
  account text not null default '',
  why text not null default '',
  status text not null default 'waiting' check (status in ('waiting', 'filed', 'skipped')),
  created_at timestamptz not null default now()
);
create index feed_items_waiting on public.feed_items (owner_id) where status = 'waiting';

alter table public.feed enable row level security;
alter table public.feed_items enable row level security;

-- The manager reads their own feed; only the server changes it.
create policy feed_select on public.feed for select using (owner_id = auth.uid());
-- The pile: theirs to read and to file or skip, nobody else's to see.
create policy feed_items_select on public.feed_items for select using (owner_id = auth.uid());
create policy feed_items_update on public.feed_items for update
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter publication supabase_realtime add table public.feed_items;

-- Filing is one merge done inside the database, so charges the feed adds
-- land on top of whatever the tour holds at that instant.
create or replace function public.file_charges(t_id text, add jsonb, imp jsonb)
returns void
language sql security definer set search_path = public as $$
  update tours
     set doc = jsonb_set(
                 jsonb_set(doc, '{charges}', coalesce(doc -> 'charges', '{}'::jsonb) || add),
                 '{imports}', coalesce(doc -> 'imports', '{}'::jsonb) || imp),
         updated_at = now()
   where id = t_id
$$;
revoke all on function public.file_charges(text, jsonb, jsonb) from public, anon, authenticated;
