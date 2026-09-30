-- A card charge from inside a tour's card balance, logged to another tour
-- (an upcoming one): the tour it came from keeps a note of it under
-- doc.cardAway, so it leaves that card's balance without counting as that
-- tour's spending. Server only.
create or replace function public.set_card_away(t_id text, add jsonb)
returns void
language sql security definer set search_path = public as $$
  update tours
     set doc = jsonb_set(doc, '{cardAway}', coalesce(doc -> 'cardAway', '{}'::jsonb) || add), updated_at = now()
   where id = t_id
$$;
revoke all on function public.set_card_away(text, jsonb) from public, anon, authenticated;
grant execute on function public.set_card_away(text, jsonb) to service_role;
