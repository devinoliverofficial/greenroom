-- Accounts are individuals (Devin, 2026-10-08). The bank reader names every
-- account "<name> ··<last four>", so two accounts share a name only when they
-- are the same account connected twice. Then there is nothing to tell apart:
-- the person said it's theirs, so it's theirs, and the tour's copy goes quiet.
-- No nickname talk.

create or replace function public.my_pay_account_of(owner uuid, acct_name text)
returns public.my_pay_accounts
language plpgsql stable security definer set search_path = public as $$
declare m public.my_pay_accounts; a record;
begin
  for a in select x.key as id, x.value as v from feed f, jsonb_each(coalesce(f.accounts, '{}'::jsonb)) x
            where f.owner_id = owner and x.value ->> 'name' = acct_name
  loop
    if exists (select 1 from my_pay_items i where i.user_id = owner and i.item_id = a.v ->> 'item')
       or exists (select 1 from my_pay_accounts p where p.user_id = owner and p.account_id = a.id) then
      select * into m from my_pay_accounts p where p.user_id = owner and p.account_id = a.id;
      if m.user_id is null then
        insert into my_pay_accounts (user_id, account_id, name, card)
        values (owner, a.id, acct_name, case when a.v ->> 'type' = 'creditCard' then 'credit' else 'debit' end)
        on conflict (user_id, account_id) do nothing;
        select * into m from my_pay_accounts p where p.user_id = owner and p.account_id = a.id;
      end if;
      return m;
    end if;
  end loop;
  return null;
end $$;
revoke all on function public.my_pay_account_of(uuid, text) from public, anon, authenticated;

-- The same account connected twice reports each charge twice, under two ids:
-- the second copy of a charge (same day, same amount, same merchant) is not a
-- second charge.
create or replace function public.feed_items_personal()
returns trigger
language plpgsql security definer set search_path = public as $$
declare m public.my_pay_accounts;
begin
  if new.status is distinct from 'waiting' then return new; end if;
  m := public.my_pay_account_of(new.owner_id, coalesce(new.account, ''));
  if m.user_id is null then return new; end if;
  if not exists (select 1 from my_pay_feed q where q.user_id = new.owner_id and q.kind = 'charge'
                   and q.date is not distinct from coalesce(new.posted, new.date) and q.amount = coalesce(new.amount, 0)
                   and q.merchant = left(coalesce(new.merchant, ''), 120) and q.id <> new.id) then
    insert into my_pay_feed (user_id, id, kind, date, merchant, amount, account, card)
    values (new.owner_id, new.id, 'charge', coalesce(new.posted, new.date), left(coalesce(new.merchant, ''), 120), coalesce(new.amount, 0), coalesce(new.account, ''), m.card)
    on conflict (user_id, id) do nothing;
  end if;
  new.status := 'mypay';
  new.tour_id := null;
  return new;
end $$;
revoke all on function public.feed_items_personal() from public, anon, authenticated;

-- Which tour-side accounts share a name with the person's own (the same
-- account connected twice): the app switches those copies off on the tour.
create or replace function public.my_pay_twins()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object('id', x.key, 'name', x.value ->> 'name'))
      from feed f, jsonb_each(coalesce(f.accounts, '{}'::jsonb)) x
     where f.owner_id = auth.uid()
       and not exists (select 1 from my_pay_accounts p where p.user_id = auth.uid() and p.account_id = x.key)
       and not exists (select 1 from my_pay_items i where i.user_id = auth.uid() and i.item_id = x.value ->> 'item')
       and exists (select 1 from my_pay_accounts p2 where p2.user_id = auth.uid() and p2.name = x.value ->> 'name')
       and coalesce(x.value ->> 'mode', '') <> 'off'), '[]'::jsonb)
$$;
revoke all on function public.my_pay_twins() from public, anon;
grant execute on function public.my_pay_twins() to authenticated;

notify pgrst, 'reload schema';
