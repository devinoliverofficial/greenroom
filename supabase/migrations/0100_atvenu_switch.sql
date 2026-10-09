-- The atVenu switch (Devin, 2026-10-08: in Cards/Links, "the Atvenu logo
-- with a check box. If it's checked it means to sync the atvenu and if it's
-- not it means not to. When it's unchecked it means atvenu no longer
-- automatically logs the merch"). The app keeps the switch on the tour
-- (atvenuSync: false when off). atVenu's reader and the card-payout
-- reconciler both land their numbers through merge_show, so merge_show is
-- where "not to" is enforced: a tour switched off takes no merch from them.
-- A deposit catalogued from the bank, or anything typed by hand, still lands.

create or replace function public.merge_show(t_id text, s_id text, patch jsonb)
returns void
language sql security definer set search_path = public as $$
  update tours
     set doc = jsonb_set(doc, array['shows', s_id], coalesce(doc -> 'shows' -> s_id, '{}'::jsonb) || patch),
         updated_at = now()
   where id = t_id and (doc -> 'shows') ? s_id
     and not (coalesce(doc ->> 'atvenuSync', '') = 'false'
              and (patch ? 'settlementNotes' or (patch ? 'merchCardDeposit' and not (patch ? 'merchReceivedAt'))))
$$;
revoke all on function public.merge_show(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.merge_show(text, text, jsonb) to service_role;

notify pgrst, 'reload schema';
