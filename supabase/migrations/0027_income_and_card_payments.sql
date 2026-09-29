-- MODEL5: each account the tour manager marks for income says which: merch
-- (atVenu payouts), guarantees, or both. Deposits on those accounts are kept
-- (date and amount only) to match against the shows; watch says what each
-- deposit may be. Nothing else coming into any account is stored.
alter table public.merch_deposits add column if not exists watch text not null default 'merch'
  check (watch in ('merch', 'guarantees', 'both'));

-- A payment on a card whose balance the feed read: added to that card's
-- entry on the tour (doc.debts.<id>.payments.<transaction id>), inside the
-- database so nothing typed at the same moment is overwritten. Server only.
create or replace function public.add_card_payment(t_id text, d_id text, p_id text, payment jsonb)
returns void
language sql security definer set search_path = public as $$
  update tours
     set doc = jsonb_set(doc, array['debts', d_id, 'payments'],
                 coalesce(doc -> 'debts' -> d_id -> 'payments', '{}'::jsonb) || jsonb_build_object(p_id, payment)),
         updated_at = now()
   where id = t_id and (doc -> 'debts') ? d_id
$$;
revoke all on function public.add_card_payment(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.add_card_payment(text, text, text, jsonb) to service_role;
