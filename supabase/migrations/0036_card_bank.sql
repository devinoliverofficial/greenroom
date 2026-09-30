-- Owed on cards, now with the card company's name (doc.debts.<id>.owedNow
-- = { amount, at, bank }), so each credit card shows as its own line on the
-- Expenses tab. Saved when the amount or the name changes. Server only.
create or replace function public.set_card_owed(t_id text, d_id text, owed jsonb)
returns void
language sql security definer set search_path = public as $$
  update tours
     set doc = jsonb_set(doc, array['debts', d_id, 'owedNow'], owed), updated_at = now()
   where id = t_id and (doc -> 'debts') ? d_id
     and ((doc -> 'debts' -> d_id -> 'owedNow' -> 'amount') is distinct from (owed -> 'amount')
       or (doc -> 'debts' -> d_id -> 'owedNow' -> 'bank') is distinct from (owed -> 'bank'))
$$;
revoke all on function public.set_card_owed(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.set_card_owed(text, text, jsonb) to service_role;
