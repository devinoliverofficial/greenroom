-- MY PAY, your own cards (Devin, 2026-10-08): "a separate card connecting
-- situation than the tour ... so crew members can use Plaid to sync their
-- personal cards and monitor their income and their expenses." Two separate
-- connections, he said.
--
-- The bank feed (the plaid function) is per person already: a connection
-- belongs to whoever made it. What was missing is a way to say "this account
-- is MINE, not the tour's", and a place for its charges and deposits to go
-- that isn't a tour. So: a list of personal accounts per person, a personal
-- inbox the feed's rows are turned into the moment they land (a trigger, so
-- the tour's Cards tab never sees them), and the filing into the person's
-- own book.

-- 1. Which bank accounts are personal, per person. (Account ids are Plaid's;
-- the feed's rows carry the account's NAME, so the name is kept too.)
create table if not exists public.my_pay_accounts (
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id text not null,
  name text not null default '',
  card text not null default 'debit',       -- credit | debit: what a charge on it counts as
  created_at timestamptz not null default now(),
  primary key (user_id, account_id)
);
alter table public.my_pay_accounts enable row level security;
revoke all on public.my_pay_accounts from public, anon, authenticated;
grant select, insert, update, delete on public.my_pay_accounts to authenticated;
drop policy if exists my_pay_accounts_own on public.my_pay_accounts;
create policy my_pay_accounts_own on public.my_pay_accounts
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 2. The personal inbox: what the bank saw on your own accounts, waiting for
-- you to file it under a category (or skip it).
create table if not exists public.my_pay_feed (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,                           -- the bank transaction's id
  kind text not null check (kind in ('charge', 'deposit')),
  date date,
  merchant text not null default '',
  amount numeric not null default 0,
  account text not null default '',           -- the account's name
  card text not null default 'debit',
  status text not null default 'new' check (status in ('new', 'filed', 'skipped')),
  tour_id text,                               -- the book it was filed into
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  primary key (user_id, id)
);
create index if not exists my_pay_feed_new on public.my_pay_feed (user_id, status);
alter table public.my_pay_feed enable row level security;
revoke all on public.my_pay_feed from public, anon, authenticated;
grant select on public.my_pay_feed to authenticated;
drop policy if exists my_pay_feed_own on public.my_pay_feed;
create policy my_pay_feed_own on public.my_pay_feed for select using (user_id = auth.uid());

-- Is this feed row's account one of the person's own? By name, through the
-- feed's account list; a name shared with a tour account is left alone.
create or replace function public.my_pay_account_of(owner uuid, acct_name text)
returns public.my_pay_accounts
language sql stable security definer set search_path = public as $$
  select m.* from my_pay_accounts m
   where m.user_id = owner and m.name = acct_name
     and not exists (
       select 1 from feed f, jsonb_each(coalesce(f.accounts, '{}'::jsonb)) a
        where f.owner_id = owner and a.value ->> 'name' = acct_name
          and not exists (select 1 from my_pay_accounts m2 where m2.user_id = owner and m2.account_id = a.key))
   limit 1
$$;
revoke all on function public.my_pay_account_of(uuid, text) from public, anon, authenticated;

-- 3. A charge on a personal account goes to the personal inbox as it lands,
-- and never sits in the tour's "new charges" (its status says so: a new
-- status the feed's check now allows).
alter table public.feed_items drop constraint if exists feed_items_status_check;
alter table public.feed_items add constraint feed_items_status_check check (status in ('waiting', 'filed', 'skipped', 'mypay'));
create or replace function public.feed_items_personal()
returns trigger
language plpgsql security definer set search_path = public as $$
declare m public.my_pay_accounts;
begin
  if new.status is distinct from 'waiting' then return new; end if;
  m := public.my_pay_account_of(new.owner_id, coalesce(new.account, ''));
  if m.user_id is null then return new; end if;
  insert into my_pay_feed (user_id, id, kind, date, merchant, amount, account, card)
  values (new.owner_id, new.id, 'charge', coalesce(new.posted, new.date), left(coalesce(new.merchant, ''), 120), coalesce(new.amount, 0), coalesce(new.account, ''), m.card)
  on conflict (user_id, id) do nothing;
  new.status := 'mypay';
  new.tour_id := null;
  return new;
end $$;
revoke all on function public.feed_items_personal() from public, anon, authenticated;
drop trigger if exists feed_items_personal on public.feed_items;
create trigger feed_items_personal before insert or update of status on public.feed_items
  for each row execute function public.feed_items_personal();

-- A deposit on a personal account: the feed doesn't say which account a
-- deposit came from, so this is only for someone who runs no tour at all
-- (every deposit of theirs is their own). A tour manager's own deposits are
-- logged by hand under Log income.
create or replace function public.merch_deposits_personal()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.matched, false) then return new; end if;
  if exists (select 1 from tours t where t.owner_id = new.owner_id and (t.doc ->> 'deletedAt') is null) then return new; end if;
  if not exists (select 1 from my_pay_accounts m where m.user_id = new.owner_id) then return new; end if;
  insert into my_pay_feed (user_id, id, kind, date, merchant, amount, account, card)
  values (new.owner_id, new.id, 'deposit', new.date, 'Deposit', coalesce(new.amount, 0), '', 'debit')
  on conflict (user_id, id) do nothing;
  new.matched := true;
  return new;
end $$;
revoke all on function public.merch_deposits_personal() from public, anon, authenticated;
drop trigger if exists merch_deposits_personal on public.merch_deposits;
create trigger merch_deposits_personal before insert on public.merch_deposits
  for each row execute function public.merch_deposits_personal();

-- Marking accounts personal also sweeps what's already waiting from them.
create or replace function public.my_pay_claim_accounts(ids jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); x jsonb; n int := 0; nm text; cd text;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  if jsonb_typeof(ids) <> 'array' then raise exception 'bad input' using errcode = '22023'; end if;
  for x in select * from jsonb_array_elements(ids) limit 40
  loop
    select a.value ->> 'name', case when a.value ->> 'type' = 'creditCard' then 'credit' else 'debit' end into nm, cd
      from feed f, jsonb_each(coalesce(f.accounts, '{}'::jsonb)) a
     where f.owner_id = me and a.key = x ->> 'id';
    if nm is null then continue; end if;
    insert into my_pay_accounts (user_id, account_id, name, card)
    values (me, x ->> 'id', nm, case when x ->> 'card' in ('credit', 'debit') then x ->> 'card' else cd end)
    on conflict (user_id, account_id) do update set name = excluded.name, card = excluded.card;
    n := n + 1;
  end loop;
  -- Charges already waiting on those accounts move over.
  update feed_items set status = 'waiting' where owner_id = me and status = 'waiting'
     and public.my_pay_account_of(me, account) is not null;
  return jsonb_build_object('ok', true, 'n', n);
end $$;
revoke all on function public.my_pay_claim_accounts(jsonb) from public, anon;
grant execute on function public.my_pay_claim_accounts(jsonb) to authenticated;

create or replace function public.my_pay_release_account(acct text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  delete from my_pay_accounts where user_id = me and account_id = acct;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.my_pay_release_account(text) from public, anon;
grant execute on function public.my_pay_release_account(text) to authenticated;

-- 4. Filing from the inbox into the person's book for a tour, or skipping.
create or replace function public.my_pay_file(t_id text, item_id text, category text, how text default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); r public.my_pay_feed; d jsonb; k text; entry jsonb; cat text;
begin
  if me is null or public.my_role(t_id) is null then raise exception 'permission' using errcode = '42501'; end if;
  select * into r from my_pay_feed where user_id = me and id = item_id and status = 'new';
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  cat := left(coalesce(category, 'other'), 24);
  k := 'b' || replace(item_id, '-', '');
  if r.kind = 'charge' then
    entry := jsonb_build_object('date', r.date, 'amount', r.amount, 'how', case when how in ('credit', 'debit', 'cash') then how else r.card end,
      'category', case when cat in ('food', 'lodging', 'travel', 'gear', 'other') then cat else 'other' end,
      'note', left(r.merchant, 60), 'bank', item_id, 'createdAt', (extract(epoch from now()) * 1000)::bigint);
    insert into my_pay_books (tour_id, user_id, doc) values (t_id, me, jsonb_build_object('entries', jsonb_build_object(k, entry)))
    on conflict (tour_id, user_id) do update
      set doc = jsonb_set(my_pay_books.doc, '{entries}', coalesce(my_pay_books.doc -> 'entries', '{}'::jsonb) || jsonb_build_object(k, entry)),
          updated_at = now();
  else
    entry := jsonb_build_object('date', r.date, 'amount', r.amount,
      'category', case when cat in ('weekly', 'perdiem', 'buyout', 'bonus', 'other') then cat else 'other' end,
      'note', 'From the bank', 'bank', item_id, 'createdAt', (extract(epoch from now()) * 1000)::bigint);
    insert into my_pay_books (tour_id, user_id, doc) values (t_id, me, jsonb_build_object('income', jsonb_build_object(k, entry)))
    on conflict (tour_id, user_id) do update
      set doc = jsonb_set(my_pay_books.doc, '{income}', coalesce(my_pay_books.doc -> 'income', '{}'::jsonb) || jsonb_build_object(k, entry)),
          updated_at = now();
  end if;
  update my_pay_feed set status = 'filed', tour_id = t_id, decided_at = now() where user_id = me and id = item_id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.my_pay_file(text, text, text, text) from public, anon;
grant execute on function public.my_pay_file(text, text, text, text) to authenticated;

create or replace function public.my_pay_skip(item_id text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  update my_pay_feed set status = 'skipped', decided_at = now() where user_id = me and id = item_id and status = 'new';
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.my_pay_skip(text) from public, anon;
grant execute on function public.my_pay_skip(text) to authenticated;

-- Deleting the account takes these along.
create or replace function public.delete_my_account()
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); n int;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  select count(*) into n from tours where owner_id = me and (doc ->> 'deletedAt') is null;
  if n > 0 then return jsonb_build_object('ok', false, 'why', 'tours', 'n', n); end if;
  select count(*) into n from artists where owner_id = me;
  if n > 0 then return jsonb_build_object('ok', false, 'why', 'artists', 'n', n); end if;
  delete from my_pay_feed where user_id = me;
  delete from my_pay_accounts where user_id = me;
  delete from my_pay_books where user_id = me;
  delete from tours where owner_id = me;
  delete from tour_public where owner_id = me;
  delete from members where user_id = me;
  delete from flowers where from_id = me or to_id = me;
  delete from dms where sender = me or recipient = me;
  delete from follows where follower_id = me or followee_id = me;
  delete from artist_follows where user_id = me;
  delete from artist_members where user_id = me;
  delete from artist_endorsements where user_id = me;
  delete from artist_claims where user_id = me;
  delete from tour_credits where user_id = me;
  delete from day_votes where user_id = me;
  delete from game_ball_votes where voter = me;
  delete from push_subs where user_id = me;
  delete from app_errors where user_id = me;
  delete from labels where owner_id = me;
  delete from past_crew where owner_id = me;
  delete from feed_items where owner_id = me;
  delete from feed where owner_id = me;
  delete from plaid_items where owner_id = me;
  delete from plaid_pending where owner_id = me;
  delete from merch_deposits where owner_id = me;
  delete from merch_reports where owner_id = me;
  delete from square_payout_entries where owner_id = me;
  delete from square_payouts where owner_id = me;
  delete from square_payments where owner_id = me;
  delete from square_requests where owner_id = me;
  delete from square_connect where owner_id = me;
  delete from setlist_requests where owner_id = me;
  delete from setlist_connect where owner_id = me;
  delete from setlist_user_day where user_id = me;
  delete from signup_allowances where created_by = me;
  delete from platform_admins where user_id = me;
  delete from verified_users where user_id = me;
  delete from profiles where user_id = me;
  delete from auth.users where id = me;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

notify pgrst, 'reload schema';
