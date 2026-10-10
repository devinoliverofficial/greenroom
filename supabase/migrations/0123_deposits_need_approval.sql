-- Nothing is logged from a bank deposit by itself (Devin, 2026-10-09: "when
-- you are looking, if there are any numbers that match a guarantee deposit
-- amount that was logged or a merch number it should say this number matches
-- whatever city it is. For now we should have to still see and approve and
-- log").
--
-- Until now four things marked a show received from a deposit without him:
--   * the bank feed's merch matcher and its guarantee matcher (edge function,
--     run on every Refresh Card),
--   * the hourly reconciler's atVenu pass,
--   * the to-the-dollar pass added in 0122 (hourly, and when the Cards tab
--     read the bank).
-- All four stop here. The app's New income sheet names the city a number
-- matches; a deposit is logged only by catalog_income / catalog_income_split,
-- which he calls by pressing Approve & log (or Log).
--
-- The edge function cannot be redeployed from here, so its two matchers are
-- stopped in the database: a show's bank fields can only be written, and a
-- deposit only marked matched, inside a transaction that carries the owner's
-- approval. Everything else those functions do is untouched.

-- The approval: set for the length of one transaction by the two functions
-- the owner calls, and by nothing else.
create or replace function public.deposit_approved()
returns boolean
language sql stable as $$
  select coalesce(current_setting('greenroom.deposit_approved', true), '') = '1'
$$;
revoke all on function public.deposit_approved() from public, anon, authenticated;
-- (The bank feed writes as service_role, and the gate below reads this on its rows.)
grant execute on function public.deposit_approved() to service_role;

-- merge_show, as 0100 left it, plus: the fields that say "the bank showed this
-- money" (the date it landed, the amount that landed, the running total seen)
-- are refused without the approval. Refused loudly, so a matcher that tries
-- gets an error back and does not count a match it did not make. Everything
-- else merges as before: settlement notes, card estimates, the Received tick
-- an atVenu report carries, Square's figures.
create or replace function public.merge_show(t_id text, s_id text, patch jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.deposit_approved() and exists (
       select 1 from jsonb_each(patch) e
        where e.key in ('merchReceivedAt', 'merchDeposit', 'guaranteeReceivedAt', 'guaranteeDeposit', 'guaranteeSeen')
          and jsonb_typeof(e.value) <> 'null') then
    raise exception 'a deposit is logged only when the owner approves it' using errcode = '42501';
  end if;
  update tours
     set doc = jsonb_set(doc, array['shows', s_id], coalesce(doc -> 'shows' -> s_id, '{}'::jsonb) || patch),
         updated_at = now()
   where id = t_id and (doc -> 'shows') ? s_id
     and not (coalesce(doc ->> 'atvenuSync', '') = 'false'
              and (patch ? 'settlementNotes' or (patch ? 'merchCardDeposit' and not (patch ? 'merchReceivedAt'))));
end $$;
revoke all on function public.merge_show(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.merge_show(text, text, jsonb) to service_role;

-- A deposit is marked matched only with the approval too. Without it the row
-- keeps waiting in New income, whoever tried (quietly: the bank feed's own
-- bookkeeping carries on). The feed's matchers set matched, tour_id and
-- show_ids in one statement with no "still unmatched" condition, so all three
-- are held: a sync that races the owner's own approval cannot re-point a
-- deposit he has just logged. Updates only: a new row is stored as the feed
-- sends it, and the MY PAY rule that files a personal deposit at insert
-- (merch_deposits_personal, 0081) is not touched.
create or replace function public.merch_deposits_gate()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.deposit_approved()
     and (new.matched is distinct from old.matched
          or new.tour_id is distinct from old.tour_id
          or new.show_ids is distinct from old.show_ids) then
    new.matched := old.matched; new.tour_id := old.tour_id; new.show_ids := old.show_ids;
  end if;
  return new;
end $$;
revoke all on function public.merch_deposits_gate() from public, anon, authenticated;
drop trigger if exists merch_deposits_gate on public.merch_deposits;
create trigger merch_deposits_gate before update on public.merch_deposits
  for each row execute function public.merch_deposits_gate();

-- The two doors the owner uses, as 0121 left them, each now carrying the approval.
-- Each also checks that its own claim on the deposit took: the gate refuses
-- quietly, so a door that ever lost its approval would otherwise say "logged"
-- with the deposit still waiting.
create or replace function public.catalog_income(dep_id text, t_id text, s_id text, kind text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  d record; tour record; entry jsonb; took boolean;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  -- The owner is saying what this deposit was: that is the approval.
  perform set_config('greenroom.deposit_approved', '1', true);
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
     where owner_id = me and id = dep_id returning matched into took;
    if took is not true then raise exception 'the deposit was not marked' using errcode = '55000'; end if;
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
      perform public.catalog_guarantee_night(t_id, s_id, d.amount, d.date);
    end if;
    update merch_deposits set matched = true, tour_id = t_id, show_ids = array[s_id]
     where owner_id = me and id = dep_id returning matched into took;
    if took is not true then raise exception 'the deposit was not marked' using errcode = '55000'; end if;
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
   where owner_id = me and id = dep_id returning matched into took;
  if took is not true then raise exception 'the deposit was not marked' using errcode = '55000'; end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.catalog_income(text, text, text, text) from public, anon;
grant execute on function public.catalog_income(text, text, text, text) to authenticated;

create or replace function public.catalog_income_split(dep_id text, t_id text, parts jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  d record; tour record; p jsonb; sid text; amt numeric; agent numeric; total numeric := 0;
  ids text[] := '{}'; cur jsonb; g numeric; dep numeric; has_why boolean; took boolean;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  -- The owner ticked these nights and pressed Log: that is the approval.
  perform set_config('greenroom.deposit_approved', '1', true);
  if jsonb_typeof(parts) is distinct from 'array' or jsonb_array_length(parts) < 1 or jsonb_array_length(parts) > 60 then
    raise exception 'which nights' using errcode = '22023';
  end if;
  select * into d from merch_deposits where owner_id = me and id = dep_id for update;
  if not found then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  if d.matched then return jsonb_build_object('ok', false, 'why', 'done'); end if;
  select id, doc into tour from tours
   where id = t_id and owner_id = me and (doc ->> 'deletedAt') is null
   for update;
  if not found then raise exception 'permission' using errcode = '42501'; end if;

  -- Everything checked before anything is written: each night a real show with a
  -- guarantee logged, no night twice, every share above nothing, and the shares
  -- the size of the deposit.
  for p in select * from jsonb_array_elements(parts)
  loop
    sid := p ->> 'show';
    if sid is null or sid = any (ids) or jsonb_typeof(tour.doc -> 'shows' -> sid) is distinct from 'object' then
      raise exception 'no such show' using errcode = '22023';
    end if;
    if coalesce(tour.doc -> 'shows' -> sid -> 'income' ->> 'guarantee', '') !~ '^[0-9]+(\.[0-9]+)?$'
       or (tour.doc -> 'shows' -> sid -> 'income' ->> 'guarantee')::numeric <= 0 then
      raise exception 'no guarantee on that night' using errcode = '22023';
    end if;
    if coalesce(p ->> 'amount', '') !~ '^[0-9]+(\.[0-9]+)?$' or (p ->> 'amount')::numeric <= 0 then
      raise exception 'bad share' using errcode = '22023';
    end if;
    total := total + (p ->> 'amount')::numeric;
    ids := ids || sid;
  end loop;
  if abs(total - d.amount) > 0.02 then raise exception 'does not add up' using errcode = '22023'; end if;

  for p in select * from jsonb_array_elements(parts)
  loop
    sid := p ->> 'show';
    amt := (p ->> 'amount')::numeric;
    perform public.catalog_guarantee_night(t_id, sid, amt, d.date);
    -- The booking agent's cut, when the sheet showed it is the whole difference: written as the
    -- reason on a night that has none yet (never over one typed by hand, never on a night paid
    -- to the agency, and never more than the gap left on the night).
    agent := case when coalesce(p ->> 'agent', '') ~ '^[0-9]+(\.[0-9]+)?$' then (p ->> 'agent')::numeric else 0 end;
    if agent > 0 then
      select t.doc -> 'shows' -> sid into cur from tours t where t.id = t_id;
      g := (cur -> 'income' ->> 'guarantee')::numeric;
      dep := case when (cur ->> 'guaranteeDeposit') ~ '^[0-9]+(\.[0-9]+)?$' then (cur ->> 'guaranteeDeposit')::numeric else 0 end;
      has_why := jsonb_typeof(cur -> 'guaranteeWhy') = 'object'
        and exists (select 1 from jsonb_each_text(cur -> 'guaranteeWhy') e where e.value ~ '^[0-9]+(\.[0-9]+)?$' and e.value::numeric > 0);
      agent := least(agent, greatest(0, g - dep));
      if agent > 0 and not has_why and coalesce(cur ->> 'guaranteePaidBy', '') <> 'agency' then
        perform public.merge_show(t_id, sid, jsonb_build_object(
          'guaranteeWhy', jsonb_build_object('agent', round(agent, 2)),
          'guaranteeWhyAsked', true));
      end if;
    end if;
  end loop;

  update merch_deposits set matched = true, tour_id = t_id, show_ids = ids
   where owner_id = me and id = dep_id returning matched into took;
  if took is not true then raise exception 'the deposit was not marked' using errcode = '55000'; end if;
  return jsonb_build_object('ok', true, 'nights', coalesce(array_length(ids, 1), 0));
end $$;
revoke all on function public.catalog_income_split(text, text, jsonb) from public, anon;
grant execute on function public.catalog_income_split(text, text, jsonb) to authenticated;

-- The automatic to-the-dollar pass of 0122 is gone.
drop function if exists public.match_my_merch();
drop function if exists public.match_merch_exact(uuid);

-- The hourly reconciler keeps what is not a deposit (the expected card deposit
-- worked out from a settlement, and marking a logged night as waiting) and
-- ties no deposit to any show.
create or replace function public.reconcile_merch()
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  t record; s record; rep record;
  n_estimated int := 0; n_flagged int := 0;
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

  -- (No deposit is tied to a show here any more: see the note at the top of
  --  this migration. The owner approves each one in the New income sheet.)
  return jsonb_build_object('estimated', n_estimated, 'flagged', n_flagged, 'matched', 0);
end $$;
revoke all on function public.reconcile_merch() from public, anon, authenticated;

notify pgrst, 'reload schema';
