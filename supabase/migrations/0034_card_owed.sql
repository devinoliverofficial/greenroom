-- Owed on cards: at each card-feed refresh, the bank's current balance on
-- each credit card is saved on the tour's entry for that card
-- (doc.debts.<id>.owedNow = { amount, at }). It is what the card company is
-- still owed; it never changes what the tour spent. Server only.
create or replace function public.set_card_owed(t_id text, d_id text, owed jsonb)
returns void
language sql security definer set search_path = public as $$
  update tours
     set doc = jsonb_set(doc, array['debts', d_id, 'owedNow'], owed), updated_at = now()
   where id = t_id and (doc -> 'debts') ? d_id
     and (doc -> 'debts' -> d_id -> 'owedNow' -> 'amount') is distinct from (owed -> 'amount')
$$;
revoke all on function public.set_card_owed(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.set_card_owed(text, text, jsonb) to service_role;
