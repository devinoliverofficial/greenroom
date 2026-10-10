-- Merch deposits the size of what was logged, caught (Devin, 2026-10-09:
-- "Milwaukee was deposited Oct 7th. It shows the dollar amount exactly as I
-- logged it but the app didn't catch it").
--
-- Why it was missed, three ways at once:
--   1. Both automatic matchers only look at nights still marked NOT received.
--      Milwaukee had been ticked Received by hand, so no deposit was ever
--      tried against it.
--   2. The hourly reconciler only takes deposits the bank feed flagged as
--      atVenu's by their statement name; these were not flagged.
--   3. Everything compared a deposit to the night's expected card deposit (an
--      estimate worked out from an old settlement) and never to the merch
--      number typed on the night.
--
-- match_merch_exact: a deposit on an account watched for merch that is, to the
-- dollar, what a night has logged for merch (the merch total, that less the
-- cash kept, or the expected card deposit), landing from the night itself to
-- 30 days after, on a night the bank has not shown a deposit for yet, whether
-- or not it was ticked Received by hand. Only when there is no doubt: one such
-- night for the deposit and one such deposit for the night. The night is
-- marked received on the deposit's date with the deposit's amount, exactly as
-- the other matchers write it.
--
-- It also clears a second copy of a deposit a night already has (same day,
-- same amount to the dollar, already matched there): the bank feed delivering what had been
-- entered by hand. Nothing is written to the night for those.
create or replace function public.match_merch_exact(who uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  p record; n_exact int := 0; n_twin int := 0;
begin
  for p in
    with dep as (
      select owner_id, id, date, amount from merch_deposits
       where matched = false and watch in ('merch', 'both') and date >= current_date - 60
         and (who is null or owner_id = who)
    ), night as (
      select t.owner_id, t.id as tour_id, e.k as sid, (e.v ->> 'date')::date as day,
             x.merch, x.cash, x.card
        from tours t,
             lateral jsonb_each(t.doc -> 'shows') e(k, v),
             lateral (select
               case when (e.v -> 'income' ->> 'merch') ~ '^[0-9]+(\.[0-9]+)?$' then (e.v -> 'income' ->> 'merch')::numeric else 0 end as merch,
               case when (e.v ->> 'merchCash') ~ '^[0-9]+(\.[0-9]+)?$' then (e.v ->> 'merchCash')::numeric else 0 end as cash,
               case when (e.v ->> 'merchCardDeposit') ~ '^[0-9]+(\.[0-9]+)?$' then (e.v ->> 'merchCardDeposit')::numeric end as card) x
       where (who is null or t.owner_id = who)
         and (t.doc ->> 'deletedAt') is null and coalesce(t.doc ->> 'kind', '') <> 'offtour'
         and jsonb_typeof(e.v) = 'object'
         and (e.v ->> 'loggedAt') is not null
         and (e.v ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
         and nullif(e.v ->> 'merchReceivedAt', '') is null
         and x.merch > 0
    ), pair as (
      select d.owner_id, d.id as dep_id, d.date, d.amount, n.tour_id, n.sid
        from dep d join night n on n.owner_id = d.owner_id
         and d.date - n.day between 0 and 30
         and (abs(d.amount - n.merch) <= 1
              or (n.cash > 0 and n.merch - n.cash > 0 and abs(d.amount - (n.merch - n.cash)) <= 1)
              or (n.card > 0 and abs(d.amount - n.card) <= 1))
    ), sure as (
      select pr.*, count(*) over (partition by owner_id, dep_id) as nights,
             count(*) over (partition by tour_id, sid) as deps
        from pair pr
    )
    select * from sure where nights = 1 and deps = 1 order by date, dep_id
  loop
    -- Claim first: only the run that flips matched writes the show.
    update merch_deposits set matched = true, tour_id = p.tour_id, show_ids = array[p.sid]
     where owner_id = p.owner_id and id = p.dep_id and matched = false;
    if found then
      perform public.merge_show(p.tour_id, p.sid, jsonb_build_object(
        'merchReceived', true, 'merchReceivedAt', to_char(p.date, 'YYYY-MM-DD'),
        'merchDeposit', p.amount));
      n_exact := n_exact + 1;
    end if;
  end loop;

  -- A second copy of a deposit the night already has.
  for p in
    select d.owner_id, d.id as dep_id, m.tour_id, m.show_ids
      from merch_deposits d
      join merch_deposits m on m.owner_id = d.owner_id and m.id <> d.id and m.matched
       and m.date = d.date and abs(m.amount - d.amount) <= 1
       and m.tour_id is not null and array_length(m.show_ids, 1) = 1
      join tours t on t.id = m.tour_id and t.owner_id = d.owner_id
     where d.matched = false and d.watch in ('merch', 'both') and d.date >= current_date - 60
       and (who is null or d.owner_id = who)
       and (t.doc -> 'shows' -> m.show_ids[1] ->> 'merchReceivedAt') = to_char(d.date, 'YYYY-MM-DD')
       and (t.doc -> 'shows' -> m.show_ids[1] ->> 'merchDeposit') ~ '^[0-9]+(\.[0-9]+)?$'
       and abs((t.doc -> 'shows' -> m.show_ids[1] ->> 'merchDeposit')::numeric - d.amount) <= 1
  loop
    update merch_deposits set matched = true, tour_id = p.tour_id, show_ids = p.show_ids
     where owner_id = p.owner_id and id = p.dep_id and matched = false;
    if found then n_twin := n_twin + 1; end if;
  end loop;

  return jsonb_build_object('exact', n_exact, 'twins', n_twin);
end $$;
revoke all on function public.match_merch_exact(uuid) from public, anon, authenticated;

-- The same pass for the person looking at their own deposits, so a deposit is
-- caught the moment the Cards tab reads the bank, not at the next hourly run.
create or replace function public.match_my_merch()
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'permission' using errcode = '42501'; end if;
  return public.match_merch_exact(auth.uid());
end $$;
revoke all on function public.match_my_merch() from public, anon;
grant execute on function public.match_my_merch() to authenticated;

-- The hourly reconciler: as it was (0068), with the to-the-dollar pass run before its looser one.
create or replace function public.reconcile_merch()
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  t record; s record; rep record; d record; c record;
  n_estimated int := 0; n_flagged int := 0; n_matched int := 0;
  expected numeric; old_pred numeric; due numeric; pct numeric; exact jsonb;
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
        if (s.show ->> 'merchCardDeposit') is null
           or (old_pred is not null and abs((s.show ->> 'merchCardDeposit')::numeric - old_pred) <= 0.02) then
          if (s.show ->> 'merchCardDeposit') is null
             or abs((s.show ->> 'merchCardDeposit')::numeric - expected) > 0.02 then
            perform public.merge_show(t.id, s.sid, jsonb_build_object('merchCardDeposit', expected));
            n_estimated := n_estimated + 1;
          end if;
        end if;
      end if;

      due := coalesce(
        (select (v ->> 'merchCardDeposit')::numeric from jsonb_each(
           (select doc -> 'shows' from tours where id = t.id)) e2(k, v) where k = s.sid),
        coalesce((s.show -> 'income' ->> 'merch')::numeric, 0)
          - coalesce((s.show ->> 'merchCash')::numeric, 0));
      if due > 0 and (s.show -> 'merchReceived') is null then
        perform public.merge_show(t.id, s.sid, jsonb_build_object('merchReceived', false));
        n_flagged := n_flagged + 1;
      end if;
    end loop;
  end loop;

  -- 3. To the dollar first: any deposit on a merch account that is exactly what
  --    a night has logged, hand-ticked nights included (match_merch_exact). It
  --    runs before the looser pass below, so an exact deposit is never handed
  --    to a neighbouring night by size alone.
  exact := public.match_merch_exact(null);

  -- 4. Tie loose atVenu deposits to the shows still waiting, oldest first.
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
      -- Claim first: only the run that flips matched writes the show.
      update merch_deposits set matched = true, tour_id = c.tour_id,
             show_ids = array[c.sid]
       where owner_id = d.owner_id and id = d.id and matched = false;
      if found then
        perform public.merge_show(c.tour_id, c.sid, jsonb_build_object(
          'merchReceived', true, 'merchReceivedAt', to_char(d.date, 'YYYY-MM-DD'),
          'merchDeposit', d.amount));
        n_matched := n_matched + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('estimated', n_estimated, 'flagged', n_flagged, 'matched', n_matched,
    'exact', exact -> 'exact', 'twins', exact -> 'twins');
end $$;
revoke all on function public.reconcile_merch() from public, anon, authenticated;

notify pgrst, 'reload schema';
