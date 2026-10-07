-- A follow-up to 0072 (Guarantee Total vs Deposit Amount). The running total
-- of bank money catalogued onto a guarantee (guaranteeSeen) could sit ABOVE
-- the deposit on the show after the deposit was corrected down by hand. The
-- next deposit catalogued there then read the whole difference as new money:
-- the deposit jumped back up and "still owed" was wiped by far more than
-- had arrived, so an unpaid part counted as income. The running total is
-- now capped at what's on the show before the new deposit is added.
-- Everything else in the function is 0072 unchanged.

create or replace function public.catalog_income(dep_id text, t_id text, s_id text, kind text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  d record; tour record; entry jsonb; cur jsonb; had numeric; owed numeric; seen numeric;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  if kind not in ('merch', 'guarantee', 'royalties', 'advance', 'skip') then
    raise exception 'what kind' using errcode = '22023';
  end if;

  -- The deposit, locked so an automatic matcher running this second
  -- can't claim it at the same time.
  select * into d from merch_deposits
   where owner_id = me and id = dep_id
   for update;
  if not found then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  -- Already claimed (by a matcher, or this same tap arriving twice).
  if d.matched then return jsonb_build_object('ok', false, 'why', 'done'); end if;

  -- Not tour income: cleared for good, never offered again.
  if kind = 'skip' then
    update merch_deposits set matched = true, tour_id = null, show_ids = null
     where owner_id = me and id = dep_id;
    return jsonb_build_object('ok', true);
  end if;

  -- The book it lands on: one of the owner's own (the deposits are their
  -- bank), still alive. Locked, so a show deleted in this same instant
  -- can't slip between the check below and the write.
  select id, doc into tour from tours
   where id = t_id and owner_id = me and (doc ->> 'deletedAt') is null
   for update;
  if not found then raise exception 'permission' using errcode = '42501'; end if;

  if s_id is not null then
    -- One night's money: only merch and guarantees belong to a show.
    if kind not in ('merch', 'guarantee') then
      raise exception 'not show money' using errcode = '22023';
    end if;
    -- A real show, not the null tombstone a deleted one leaves behind
    -- (merging into a tombstone would turn the entry into an array and
    -- the money would land nowhere).
    if jsonb_typeof(tour.doc -> 'shows' -> s_id) is distinct from 'object' then
      raise exception 'no such show' using errcode = '22023';
    end if;
    if kind = 'merch' then
      perform public.merge_show(t_id, s_id, jsonb_build_object(
        'merchReceived', true,
        'merchReceivedAt', to_char(d.date, 'YYYY-MM-DD'),
        'merchDeposit', d.amount));
    else
      cur := tour.doc -> 'shows' -> s_id;
      had := case when (cur ->> 'guaranteeDeposit') ~ '^[0-9]+(\.[0-9]+)?$' then (cur ->> 'guaranteeDeposit')::numeric else 0 end;
      if (cur ->> 'guaranteeReceived') = 'true' and had > 0 then
        -- A deposit is already on the show. What the bank has shown so far:
        -- the running total, or (a deposit the bank feed matched before this
        -- was kept) the whole of it, or (typed by hand) nothing yet.
        seen := case when (cur ->> 'guaranteeSeen') ~ '^[0-9]+(\.[0-9]+)?$' then (cur ->> 'guaranteeSeen')::numeric
                     when nullif(cur ->> 'guaranteeReceivedAt', '') is not null then had
                     else 0 end;
        -- Never more than what's on the show: a deposit corrected DOWN by hand
        -- (one wire that covered two nights, say) must not come back as "new
        -- money" the next time a deposit lands here.
        seen := least(seen, had) + d.amount;
        if seen > had + 1 then
          -- More than was on the show: the extra is new money. It adds to
          -- what's landed, and comes off what the promoter still owed.
          owed := case when (cur -> 'guaranteeWhy' ->> 'owed') ~ '^[0-9]+(\.[0-9]+)?$'
                       then (cur -> 'guaranteeWhy' ->> 'owed')::numeric else 0 end;
          owed := greatest(0, owed - (seen - had));
          perform public.merge_show(t_id, s_id, jsonb_build_object(
            'guaranteeReceived', true,
            'guaranteeReceivedAt', to_char(d.date, 'YYYY-MM-DD'),
            'guaranteeDeposit', seen,
            'guaranteeSeen', seen,
            'guaranteeWhy', (case when jsonb_typeof(cur -> 'guaranteeWhy') = 'object' then cur -> 'guaranteeWhy' else '{}'::jsonb end) - 'owed'
                            || case when owed > 0 then jsonb_build_object('owed', owed) else '{}'::jsonb end));
        elsif seen >= had - 1 then
          -- The bank now shows what was typed: confirmed, to the cent.
          perform public.merge_show(t_id, s_id, jsonb_build_object(
            'guaranteeReceivedAt', to_char(d.date, 'YYYY-MM-DD'),
            'guaranteeDeposit', seen,
            'guaranteeSeen', seen));
        else
          -- Part of what was typed has shown up; the rest hasn't yet.
          perform public.merge_show(t_id, s_id, jsonb_build_object('guaranteeSeen', seen));
        end if;
      else
        perform public.merge_show(t_id, s_id, jsonb_build_object(
          'guaranteeReceived', true,
          'guaranteeReceivedAt', to_char(d.date, 'YYYY-MM-DD'),
          'guaranteeDeposit', d.amount,
          'guaranteeSeen', d.amount));
      end if;
    end if;
    update merch_deposits set matched = true, tour_id = t_id, show_ids = array[s_id]
     where owner_id = me and id = dep_id;
    return jsonb_build_object('ok', true);
  end if;

  -- The whole tour's money: royalties, an advance, or merch and guarantees
  -- that belong to no one night. Keyed by the deposit, so a retried tap
  -- can't write it twice.
  entry := jsonb_build_object(
    'date', to_char(d.date, 'YYYY-MM-DD'),
    'amount', d.amount,
    'kind', kind,
    'at', (extract(epoch from now()) * 1000)::bigint);
  update tours
     set doc = jsonb_set(doc, array['otherIncome'],
           coalesce(doc -> 'otherIncome', '{}'::jsonb) || jsonb_build_object(dep_id, entry)),
         updated_at = now()
   where id = t_id and owner_id = me;
  update merch_deposits set matched = true, tour_id = t_id, show_ids = null
   where owner_id = me and id = dep_id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.catalog_income(text, text, text, text) from public, anon;
grant execute on function public.catalog_income(text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
