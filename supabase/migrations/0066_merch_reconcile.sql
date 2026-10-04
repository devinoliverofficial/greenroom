-- Merch deposits reconcile themselves. Why the bank never matched the
-- settlement: customers tip on the card reader, atVenu leaves tips out of
-- the settlement's "Total CC Receipts" but charges its fee on sales + tips,
-- and the money lands about 3 business days after the show (their "2
-- business days" is when it leaves). So the deposit is always a little
-- bigger than the settlement implies, and nothing lined up.
--
-- The settlement still tells us the answer: the printed fee percentage is
-- the fee over (sales + tips), so expected deposit = fee x (1 - p) / p,
-- from the two numbers on the fee line alone. On the band's own shows this
-- lands within a few dollars of the real deposit.
--
-- Every hour this reconciler:
--   1. refreshes each logged show's expected card payout with that formula
--      (only over values the mailbox wrote; never over a human's number),
--   2. marks shows whose card money hasn't landed as "merch not received",
--      so they show up as owed and are candidates for matching,
--   3. ties unmatched atVenu bank deposits to those shows and marks the
--      show paid with the real amount, the way the card feed's matcher does.

-- The fee percentage printed on the settlement, kept in the report's notes
-- as "Card fees: $105.20 (2.85%)". Only a believable processing rate counts:
-- a venue's own 5% house card fee is not atVenu's rate, so it is left alone.
create or replace function public.merch_fee_pct(notes jsonb)
returns numeric
language sql immutable as $$
  select p from (
    select nullif(substring(n ->> 'value' from '\(([0-9]+\.?[0-9]*)%\)'), '')::numeric as p
      from jsonb_array_elements(coalesce(notes, '[]'::jsonb)) n
     where lower(coalesce(n ->> 'label', '')) like 'card fee%'
  ) x where p is not null and p >= 2.0 and p <= 3.9
  limit 1
$$;
revoke all on function public.merch_fee_pct(jsonb) from public, anon, authenticated;

-- The fee dollars from the same note, for reports where only the notes
-- carried the fee line ("Card fees: $150.83 (2.82%)").
create or replace function public.merch_fee_amt(notes jsonb)
returns numeric
language sql immutable as $$
  select nullif(replace(substring(n ->> 'value' from '\$([0-9,]+\.?[0-9]*)'), ',', ''), '')::numeric
    from jsonb_array_elements(coalesce(notes, '[]'::jsonb)) n
   where lower(coalesce(n ->> 'label', '')) like 'card fee%'
   limit 1
$$;
revoke all on function public.merch_fee_amt(jsonb) from public, anon, authenticated;

create or replace function public.reconcile_merch()
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  t record; s record; rep record; d record; c record;
  n_estimated int := 0; n_flagged int := 0; n_matched int := 0;
  expected numeric; old_pred numeric; due numeric; pct numeric;
begin
  -- 1 + 2. Walk every live tour's recent logged shows.
  for t in select id, owner_id, doc from tours
            where (doc ->> 'deletedAt') is null and coalesce(doc ->> 'kind', '') <> 'offtour'
  loop
    for s in select k as sid, v as show from jsonb_each(t.doc -> 'shows') e(k, v)
              where (v ->> 'loggedAt') is not null
                and coalesce((v -> 'income' ->> 'merch')::numeric, 0) > 0
                and (v ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
                and (v ->> 'date')::date >= current_date - 45
    loop
      -- The night's settlement report, if the mailbox has one.
      select card_receipts, coalesce(card_fee, public.merch_fee_amt(notes)) as card_fee,
             public.merch_fee_pct(notes) as pct into rep
        from merch_reports
       where owner_id = t.owner_id and date = (s.show ->> 'date')::date
         and coalesce(card_fee, public.merch_fee_amt(notes)) is not null
       order by (report_type = 'settlement') desc, received_at desc
       limit 1;

      if found and rep.card_fee > 0 and rep.pct is not null then
        pct := rep.pct / 100.0;
        expected := round(rep.card_fee * (1 - pct) / pct, 2);
        old_pred := case when rep.card_receipts is not null
                         then round(rep.card_receipts - rep.card_fee, 2) end;
        -- Write it only onto an empty slot, or over the mailbox's own older
        -- guess (card sales less fee); a number a person typed stays theirs.
        if (s.show ->> 'merchCardDeposit') is null
           or (old_pred is not null and abs((s.show ->> 'merchCardDeposit')::numeric - old_pred) <= 0.02) then
          if (s.show ->> 'merchCardDeposit') is null
             or abs((s.show ->> 'merchCardDeposit')::numeric - expected) > 0.02 then
            perform public.merge_show(t.id, s.sid, jsonb_build_object('merchCardDeposit', expected));
            n_estimated := n_estimated + 1;
          end if;
        end if;
      end if;

      -- What should land: the expected card payout, else merch less cash.
      due := coalesce(
        (select (v ->> 'merchCardDeposit')::numeric from jsonb_each(
           (select doc -> 'shows' from tours where id = t.id)) e2(k, v) where k = s.sid),
        coalesce((s.show -> 'income' ->> 'merch')::numeric, 0)
          - coalesce((s.show ->> 'merchCash')::numeric, 0));
      -- Nothing due on an all-cash night. A show never marked either way
      -- becomes "not received yet", so it can match and shows as owed.
      if due > 0 and (s.show -> 'merchReceived') is null then
        perform public.merge_show(t.id, s.sid, jsonb_build_object('merchReceived', false));
        n_flagged := n_flagged + 1;
      end if;
    end loop;
  end loop;

  -- 3. Tie loose atVenu deposits to the shows still waiting, oldest first.
  for d in select * from merch_deposits
            where matched = false and atvenu = true and watch in ('merch', 'both')
              and date >= current_date - 60
            order by date, id
  loop
    select t2.id as tour_id, e.k as sid, d2.due,
           (e.v ->> 'date') as show_date
      into c
      from tours t2,
           lateral jsonb_each(t2.doc -> 'shows') e(k, v),
           lateral (select coalesce((e.v ->> 'merchCardDeposit')::numeric,
                     coalesce((e.v -> 'income' ->> 'merch')::numeric, 0)
                       - coalesce((e.v ->> 'merchCash')::numeric, 0)) as due) d2
     where t2.owner_id = d.owner_id
       and (t2.doc ->> 'deletedAt') is null and coalesce(t2.doc ->> 'kind', '') <> 'offtour'
       and (e.v ->> 'merchReceived') = 'false'
       and (e.v ->> 'loggedAt') is not null
       and (e.v ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
       and d.date - (e.v ->> 'date')::date between 1 and 8
       and d2.due > 0
       and d.amount >= d2.due * 0.85 - 5
       and d.amount <= d2.due * 1.35 + 5
     order by abs(d.amount - d2.due) / d2.due
     limit 1;

    if found then
      perform public.merge_show(c.tour_id, c.sid, jsonb_build_object(
        'merchReceived', true, 'merchReceivedAt', to_char(d.date, 'YYYY-MM-DD'),
        'merchDeposit', d.amount));
      update merch_deposits set matched = true, tour_id = c.tour_id,
             show_ids = array[c.sid]
       where owner_id = d.owner_id and id = d.id;
      n_matched := n_matched + 1;
    end if;
  end loop;

  return jsonb_build_object('estimated', n_estimated, 'flagged', n_flagged, 'matched', n_matched);
end $$;
revoke all on function public.reconcile_merch() from public, anon, authenticated;

-- Once an hour, offset from the card feed's own runs.
do $do$
begin
  perform cron.unschedule('greenroom-merch-reconcile')
    where exists (select 1 from cron.job where jobname = 'greenroom-merch-reconcile');
  perform cron.schedule('greenroom-merch-reconcile', '23 * * * *', 'select public.reconcile_merch()');
end $do$;

notify pgrst, 'reload schema';
