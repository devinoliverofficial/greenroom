-- Cataloguing income from the Cards tab. The bank feed already keeps every
-- deposit on a watched account (date and amount only); whatever the matchers
-- didn't claim waits as "new income". The tour manager says what each one
-- was — merch, guarantee, royalties or an advance — and which book it
-- belongs to, the same way charges are sorted. Merch and guarantees tied to
-- one night get the very fields the automatic matcher writes; everything
-- else lands on the tour itself (doc.otherIncome), where it counts in the
-- tour's income. A deposit that isn't tour income at all can be cleared,
-- and a cleared or catalogued deposit never comes back: the feed's writer
-- only ever inserts rows it hasn't seen (ignoreDuplicates), so matched rows
-- are never touched again.

create or replace function public.catalog_income(dep_id text, t_id text, s_id text, kind text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  d record; tour record; entry jsonb;
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
      perform public.merge_show(t_id, s_id, jsonb_build_object(
        'guaranteeReceived', true,
        'guaranteeReceivedAt', to_char(d.date, 'YYYY-MM-DD'),
        'guaranteeDeposit', d.amount));
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

-- The hourly reconciler, claim-first. Its old shape wrote the show first
-- and marked the deposit after, with no second look at matched — so a
-- deposit catalogued by hand in that same second could land twice. Now it
-- claims the deposit (matched = false is part of the claim) and only a won
-- claim writes the show. Everything else is 0066 unchanged.
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

  return jsonb_build_object('estimated', n_estimated, 'flagged', n_flagged, 'matched', n_matched);
end $$;
revoke all on function public.reconcile_merch() from public, anon, authenticated;

notify pgrst, 'reload schema';
