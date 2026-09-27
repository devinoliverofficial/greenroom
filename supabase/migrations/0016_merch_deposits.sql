-- Merch deposits: Greenroom watches the one account the tour manager marks
-- for merch payouts. A deposit there that matches what atVenu said should
-- land (the net, less the cash the table kept) marks that show's merch
-- received. Only the date and amount of those deposits are kept, for
-- matching; nothing else coming into any account is ever stored.
alter table public.feed add column merch_account text;  -- null: not chosen yet; '': none

create table public.merch_deposits (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id text not null,                     -- YNAB's transaction id
  date date not null,
  amount numeric not null,
  matched boolean not null default false,
  tour_id text,
  show_ids text[],
  created_at timestamptz not null default now(),
  primary key (owner_id, id)
);
alter table public.merch_deposits enable row level security;
create policy merch_deposits_select on public.merch_deposits for select using (owner_id = auth.uid());

-- Merge a few fields into one show, inside the database, so nothing the
-- manager is typing at the same moment gets overwritten.
create or replace function public.merge_show(t_id text, s_id text, patch jsonb)
returns void
language sql security definer set search_path = public as $$
  update tours
     set doc = jsonb_set(doc, array['shows', s_id], coalesce(doc -> 'shows' -> s_id, '{}'::jsonb) || patch),
         updated_at = now()
   where id = t_id and (doc -> 'shows') ? s_id
$$;
revoke all on function public.merge_show(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.merge_show(text, text, jsonb) to service_role;
