-- MY PAY cards, no ties (Devin, 2026-10-08): "two completely different parts
-- of the app that do not communicate with each other." A bank login
-- connected from MY PAY belongs to MY PAY whole: every account on it is
-- personal from the moment it arrives, nothing of it shows on the tour's
-- Cards tab, and its deposits come to MY PAY too.
--
-- How a deposit is told apart: the bank reader notes which kind of income an
-- account is watched for. Tour accounts are watched for merch and
-- guarantees ('both', or 'merch' on older ones); a personal account is
-- watched for 'guarantees' alone, which no tour account is. That word is the
-- tag.

create table if not exists public.my_pay_items (
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, item_id)
);
alter table public.my_pay_items enable row level security;
revoke all on public.my_pay_items from public, anon, authenticated;

-- Is this account one of the person's own: on a MY PAY bank login, or claimed by id.
create or replace function public.my_pay_account_of(owner uuid, acct_name text)
returns public.my_pay_accounts
language plpgsql stable security definer set search_path = public as $$
declare mine int := 0; theirs int := 0; m public.my_pay_accounts; a record;
begin
  for a in select x.key as id, x.value as v from feed f, jsonb_each(coalesce(f.accounts, '{}'::jsonb)) x
            where f.owner_id = owner and x.value ->> 'name' = acct_name
  loop
    if exists (select 1 from my_pay_items i where i.user_id = owner and i.item_id = a.v ->> 'item')
       or exists (select 1 from my_pay_accounts p where p.user_id = owner and p.account_id = a.id) then
      mine := mine + 1;
      select * into m from my_pay_accounts p where p.user_id = owner and p.account_id = a.id;
      if m.user_id is null then
        -- On a MY PAY login but not yet listed (a new account the bank added): list it.
        insert into my_pay_accounts (user_id, account_id, name, card)
        values (owner, a.id, acct_name, case when a.v ->> 'type' = 'creditCard' then 'credit' else 'debit' end)
        on conflict (user_id, account_id) do nothing;
        select * into m from my_pay_accounts p where p.user_id = owner and p.account_id = a.id;
      end if;
    else
      theirs := theirs + 1;
    end if;
  end loop;
  -- A name shared by a personal and a tour account can't be told apart: it stays the tour's.
  if mine = 0 or theirs > 0 then return null; end if;
  return m;
end $$;
revoke all on function public.my_pay_account_of(uuid, text) from public, anon, authenticated;

-- Claiming a bank login (its item id) as MY PAY's: every account on it is yours.
create or replace function public.my_pay_claim_items(ids jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); it text; n int := 0; a record;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  if jsonb_typeof(ids) <> 'array' then raise exception 'bad input' using errcode = '22023'; end if;
  for it in select * from jsonb_array_elements_text(ids) limit 20
  loop
    if it = '' then continue; end if;
    insert into my_pay_items (user_id, item_id) values (me, it) on conflict do nothing;
    for a in select x.key as id, x.value as v from feed f, jsonb_each(coalesce(f.accounts, '{}'::jsonb)) x
              where f.owner_id = me and x.value ->> 'item' = it
    loop
      insert into my_pay_accounts (user_id, account_id, name, card)
      values (me, a.id, coalesce(a.v ->> 'name', ''), case when a.v ->> 'type' = 'creditCard' then 'credit' else 'debit' end)
      on conflict (user_id, account_id) do update set name = excluded.name, card = excluded.card;
      n := n + 1;
    end loop;
  end loop;
  -- Charges already waiting from those accounts move over.
  update feed_items set status = 'waiting' where owner_id = me and status = 'waiting'
     and public.my_pay_account_of(me, account) is not null;
  return jsonb_build_object('ok', true, 'accounts', n,
    'list', coalesce((select jsonb_agg(jsonb_build_object('id', p.account_id, 'name', p.name, 'card', p.card)) from my_pay_accounts p where p.user_id = me), '[]'::jsonb));
end $$;
revoke all on function public.my_pay_claim_items(jsonb) from public, anon;
grant execute on function public.my_pay_claim_items(jsonb) to authenticated;

-- The bank logins MY PAY holds, by id (so the app can tell a new one from the tour's).
create or replace function public.my_pay_item_ids()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_agg(i.item_id) from my_pay_items i where i.user_id = auth.uid()), '[]'::jsonb)
$$;
revoke all on function public.my_pay_item_ids() from public, anon;
grant execute on function public.my_pay_item_ids() to authenticated;

-- A deposit tagged 'guarantees' alone, for someone with personal accounts, is theirs
-- (unless some tour account of theirs is also watched that one way).
create or replace function public.merch_deposits_personal()
returns trigger
language plpgsql security definer set search_path = public as $$
declare personal boolean := false;
begin
  if coalesce(new.matched, false) then return new; end if;
  if not exists (select 1 from my_pay_accounts m where m.user_id = new.owner_id) then return new; end if;
  if not exists (select 1 from tours t where t.owner_id = new.owner_id and (t.doc ->> 'deletedAt') is null) then
    personal := true;   -- runs no tour: every deposit is their own
  elsif new.watch = 'guarantees' and not exists (
      select 1 from feed f, jsonb_each(coalesce(f.accounts, '{}'::jsonb)) x
       where f.owner_id = new.owner_id and x.value -> 'income' = '["guarantees"]'::jsonb
         and not exists (select 1 from my_pay_accounts p where p.user_id = new.owner_id and p.account_id = x.key)
         and not exists (select 1 from my_pay_items i where i.user_id = new.owner_id and i.item_id = x.value ->> 'item')) then
    personal := true;
  end if;
  if not personal then return new; end if;
  insert into my_pay_feed (user_id, id, kind, date, merchant, amount, account, card)
  values (new.owner_id, new.id, 'deposit', new.date, 'Deposit', coalesce(new.amount, 0), '', 'debit')
  on conflict (user_id, id) do nothing;
  new.matched := true;
  return new;
end $$;
revoke all on function public.merch_deposits_personal() from public, anon, authenticated;

-- The app tells the finder how its reading went (how many articles, how many
-- tours found, how many were already on the page), so a run that ends with
-- nothing can be understood afterwards.
create or replace function public.tour_find_note(a_id uuid, note text)
returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  update tour_finds set detail = left(coalesce(note, ''), 200) where artist_id = a_id;
end $$;
revoke all on function public.tour_find_note(uuid, text) from public, anon;
grant execute on function public.tour_find_note(uuid, text) to authenticated;

-- Deleting the account takes these too.
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
  delete from my_pay_items where user_id = me;
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
