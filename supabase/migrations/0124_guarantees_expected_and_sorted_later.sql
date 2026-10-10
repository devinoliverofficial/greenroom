-- Guarantees as Devin runs them (2026-10-09):
--   "At the beginning of a tour we set all the Projected guarantees which is
--    the exact amount that the promoter owes ... Then when we are on tour and
--    if we get a check or a settlement where we know the exact amount that's
--    coming to us we will log it in the deposit section. But this DOESN'T mean
--    we received it. It is only marked received if ... Greenroom flags a
--    deposit that matches the logged deposit amount. Otherwise we will mark a
--    number as Guarantee but won't be able to figure out where it belongs
--    (which show) until we get proper paperwork ... So this money should be
--    logged as guarantee income and we can organize later."
--
-- Three things here.
--  1. A Deposit Amount typed on a night that is not received is what is
--     EXPECTED. The app no longer treats typing it as receiving it, and
--     compares bank deposits with it to say "this number matches <city>".
--     When he puts a deposit on that night it is received on what the bank
--     shows (catalog_guarantee_night, below: 0121's rule, restated).
--  2. catalog_income takes one more answer for a guarantee, 'guarantee_later':
--     logged to the tour as guarantee income with no night, flagged unsorted.
--  3. sort_guarantee moves that money onto the night(s) it paid for, later;
--     unpark_guarantee puts the deposit back in New income.
-- The owner's approval (0123) is carried by every one of these.

-- One night's guarantee, met by bank money. The rule is 0121's, restated here
-- because the Deposit Amount now means something new on a night that is not
-- received: it is what he EXPECTS (typed from a check or a settlement). When
-- he puts a bank deposit on such a night, the bank is the truth: the night is
-- received on what the bank shows, and that becomes its Deposit Amount (a
-- short one then shows as a gap to explain, the way a short guarantee always
-- has). Only a night ALREADY received with a Deposit Amount is compared with
-- it: the bank's copy of a typed deposit confirms it instead of doubling it,
-- and a real second payment adds and comes off what the promoter still owed.
create or replace function public.catalog_guarantee_night(t_id text, s_id text, amount numeric, on_date date)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare cur jsonb; had numeric; owed numeric; seen numeric;
begin
  select t.doc -> 'shows' -> s_id into cur from tours t where t.id = t_id;
  if jsonb_typeof(cur) is distinct from 'object' then raise exception 'no such show' using errcode = '22023'; end if;
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
    seen := least(seen, had) + amount;
    if seen > had + 1 then
      -- More than was on the show: the extra is new money. It adds to
      -- what's landed, and comes off what the promoter still owed.
      owed := case when (cur -> 'guaranteeWhy' ->> 'owed') ~ '^[0-9]+(\.[0-9]+)?$'
                   then (cur -> 'guaranteeWhy' ->> 'owed')::numeric else 0 end;
      owed := greatest(0, owed - (seen - had));
      perform public.merge_show(t_id, s_id, jsonb_build_object(
        'guaranteeReceived', true,
        'guaranteeReceivedAt', to_char(on_date, 'YYYY-MM-DD'),
        'guaranteeDeposit', seen,
        'guaranteeSeen', seen,
        'guaranteeWhy', (case when jsonb_typeof(cur -> 'guaranteeWhy') = 'object' then cur -> 'guaranteeWhy' else '{}'::jsonb end) - 'owed'
                        || case when owed > 0 then jsonb_build_object('owed', owed) else '{}'::jsonb end));
    elsif seen >= had - 1 then
      -- The bank now shows what was typed: confirmed, to the cent.
      perform public.merge_show(t_id, s_id, jsonb_build_object(
        'guaranteeReceivedAt', to_char(on_date, 'YYYY-MM-DD'),
        'guaranteeDeposit', seen,
        'guaranteeSeen', seen));
    else
      -- Part of what was typed has shown up; the rest hasn't yet. (The night
      -- is already counted as received, by hand: nothing is lost.)
      perform public.merge_show(t_id, s_id, jsonb_build_object('guaranteeSeen', seen));
    end if;
  else
    -- Not received yet (whatever Deposit Amount was expected), or nothing
    -- typed: received now, on what the bank shows. A part payment the bank
    -- showed earlier (seen so far, on a night whose Received tick was then
    -- taken off by hand) is part of that; a sighting that already covered
    -- the whole Deposit Amount is not counted again.
    seen := case when had > 0 and (cur ->> 'guaranteeSeen') ~ '^[0-9]+(\.[0-9]+)?$' then (cur ->> 'guaranteeSeen')::numeric else 0 end;
    if seen >= had - 1 then seen := 0; end if;
    perform public.merge_show(t_id, s_id, jsonb_build_object(
      'guaranteeReceived', true,
      'guaranteeReceivedAt', to_char(on_date, 'YYYY-MM-DD'),
      'guaranteeDeposit', seen + amount,
      'guaranteeSeen', seen + amount));
  end if;
end $$;
revoke all on function public.catalog_guarantee_night(text, text, numeric, date) from public, anon, authenticated;

-- Bank money shared over nights: every part is a night and its share. Checked
-- whole before anything is written (each night a real show with a guarantee
-- logged, no night twice, every share above nothing, the shares the size of
-- the money), then filed night by night. Where the sheet showed the whole
-- difference is the booking agent's cut, that is written as the reason on a
-- night that has none (never over one typed by hand, never on a night paid to
-- the agency, never more than the gap left on the night). The caller holds the
-- tour's lock and the owner's approval. Returns the nights.
create or replace function public.catalog_guarantee_parts(t_id text, parts jsonb, total numeric, on_date date)
returns text[]
language plpgsql volatile security definer set search_path = public as $$
declare
  shows jsonb; p jsonb; sid text; amt numeric; agent numeric; sum numeric := 0;
  ids text[] := '{}'; cur jsonb; g numeric; dep numeric; has_why boolean;
begin
  if jsonb_typeof(parts) is distinct from 'array' or jsonb_array_length(parts) < 1 or jsonb_array_length(parts) > 60 then
    raise exception 'which nights' using errcode = '22023';
  end if;
  select t.doc -> 'shows' into shows from tours t where t.id = t_id;
  for p in select * from jsonb_array_elements(parts)
  loop
    sid := p ->> 'show';
    if sid is null or sid = any (ids) or jsonb_typeof(shows -> sid) is distinct from 'object' then
      raise exception 'no such show' using errcode = '22023';
    end if;
    if coalesce(shows -> sid -> 'income' ->> 'guarantee', '') !~ '^[0-9]+(\.[0-9]+)?$'
       or (shows -> sid -> 'income' ->> 'guarantee')::numeric <= 0 then
      raise exception 'no guarantee on that night' using errcode = '22023';
    end if;
    if coalesce(p ->> 'amount', '') !~ '^[0-9]+(\.[0-9]+)?$' or (p ->> 'amount')::numeric <= 0 then
      raise exception 'bad share' using errcode = '22023';
    end if;
    sum := sum + (p ->> 'amount')::numeric;
    ids := ids || sid;
  end loop;
  if abs(sum - total) > 0.02 then raise exception 'does not add up' using errcode = '22023'; end if;

  for p in select * from jsonb_array_elements(parts)
  loop
    sid := p ->> 'show';
    amt := (p ->> 'amount')::numeric;
    perform public.catalog_guarantee_night(t_id, sid, amt, on_date);
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
  return ids;
end $$;
revoke all on function public.catalog_guarantee_parts(text, jsonb, numeric, date) from public, anon, authenticated;

-- One deposit over several nights (0121/0123), now filed through the shared rule above.
create or replace function public.catalog_income_split(dep_id text, t_id text, parts jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  d record; tour record; ids text[]; took boolean;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  -- The owner ticked these nights and pressed Log: that is the approval.
  perform set_config('greenroom.deposit_approved', '1', true);
  select * into d from merch_deposits where owner_id = me and id = dep_id for update;
  if not found then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  if d.matched then return jsonb_build_object('ok', false, 'why', 'done'); end if;
  select id, doc into tour from tours
   where id = t_id and owner_id = me and (doc ->> 'deletedAt') is null
   for update;
  if not found then raise exception 'permission' using errcode = '42501'; end if;
  ids := public.catalog_guarantee_parts(t_id, parts, d.amount, d.date);
  update merch_deposits set matched = true, tour_id = t_id, show_ids = ids
   where owner_id = me and id = dep_id returning matched into took;
  if took is not true then raise exception 'the deposit was not marked' using errcode = '55000'; end if;
  return jsonb_build_object('ok', true, 'nights', coalesce(array_length(ids, 1), 0));
end $$;
revoke all on function public.catalog_income_split(text, text, jsonb) from public, anon;
grant execute on function public.catalog_income_split(text, text, jsonb) to authenticated;

-- catalog_income, as 0123 left it, with the one new answer.
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
  if kind not in ('merch', 'guarantee', 'guarantee_later', 'royalties', 'advance', 'skip') then
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
  -- 'guarantee_later': a guarantee he cannot place on a show yet ("Sort later").
  -- It is guarantee income on the tour from today, flagged so the Income tab
  -- can list it and sort_guarantee can move it onto its night(s) later. Only on
  -- a real tour: the Off Tour book has no nights to sort it onto.
  if kind = 'guarantee_later' and coalesce(tour.doc ->> 'kind', '') = 'offtour' then
    raise exception 'no nights on this book' using errcode = '22023';
  end if;
  entry := jsonb_build_object(
    'date', to_char(d.date, 'YYYY-MM-DD'),
    'amount', d.amount,
    'kind', case when kind = 'guarantee_later' then 'guarantee' else kind end,
    'at', (extract(epoch from now()) * 1000)::bigint)
    || case when kind = 'guarantee_later' then jsonb_build_object('unsorted', true) else '{}'::jsonb end;
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

-- "Sort later" money finds its night(s). The entry on the tour (keyed by the
-- deposit, flagged unsorted) is taken off the book and the same dollars are
-- filed on the nights by the rule every guarantee deposit follows, dated the
-- day the bank showed the deposit. The shares must add up to the entry. Asked
-- twice, the second answer is 'done' and nothing is written.
-- whole: it turns out to belong to no one night: the flag comes off and it
-- stays as whole-tour guarantee income.
create or replace function public.sort_guarantee(dep_id text, t_id text, parts jsonb, whole boolean default false)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  tour record; entry jsonb; amt numeric; on_date date; ids text[];
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  select id, doc into tour from tours
   where id = t_id and owner_id = me and (doc ->> 'deletedAt') is null
   for update;
  if not found then raise exception 'permission' using errcode = '42501'; end if;
  entry := tour.doc -> 'otherIncome' -> dep_id;
  if jsonb_typeof(entry) is distinct from 'object' or (entry ->> 'unsorted') is distinct from 'true' then
    return jsonb_build_object('ok', false, 'why', 'done');
  end if;
  if coalesce(entry ->> 'amount', '') !~ '^[0-9]+(\.[0-9]+)?$' or (entry ->> 'amount')::numeric <= 0 then
    raise exception 'bad entry' using errcode = '22023';
  end if;
  amt := (entry ->> 'amount')::numeric;
  on_date := case when (entry ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' then (entry ->> 'date')::date else current_date end;
  -- He is saying where this deposit goes: that is the approval.
  perform set_config('greenroom.deposit_approved', '1', true);

  if whole then
    update tours set doc = jsonb_set(doc, array['otherIncome', dep_id], entry - 'unsorted'), updated_at = now()
     where id = t_id and owner_id = me;
    return jsonb_build_object('ok', true, 'nights', 0);
  end if;

  -- Off the book first (a tombstone, the way a removed entry is always kept),
  -- then onto the nights: the same dollars are never in both places. A bad
  -- list of nights raises below and the whole thing rolls back.
  update tours set doc = jsonb_set(doc, array['otherIncome', dep_id], 'null'::jsonb), updated_at = now()
   where id = t_id and owner_id = me;
  ids := public.catalog_guarantee_parts(t_id, parts, amt, on_date);
  -- The deposit's own record now points at its nights (it may be gone; the money is on the nights either way).
  update merch_deposits set tour_id = t_id, show_ids = ids where owner_id = me and id = dep_id;
  return jsonb_build_object('ok', true, 'nights', coalesce(array_length(ids, 1), 0));
end $$;
revoke all on function public.sort_guarantee(text, text, jsonb, boolean) from public, anon;
grant execute on function public.sort_guarantee(text, text, jsonb, boolean) to authenticated;

-- Logged "Sort later" by mistake: the entry comes off the tour and the deposit
-- goes back to New income, as if it had never been answered. Refused when the
-- deposit's own record is gone (the money would vanish from the books).
create or replace function public.unpark_guarantee(dep_id text, t_id text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  tour record; entry jsonb; back boolean;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  select id, doc into tour from tours
   where id = t_id and owner_id = me and (doc ->> 'deletedAt') is null
   for update;
  if not found then raise exception 'permission' using errcode = '42501'; end if;
  entry := tour.doc -> 'otherIncome' -> dep_id;
  if jsonb_typeof(entry) is distinct from 'object' or (entry ->> 'unsorted') is distinct from 'true' then
    return jsonb_build_object('ok', false, 'why', 'done');
  end if;
  perform set_config('greenroom.deposit_approved', '1', true);
  update merch_deposits set matched = false, tour_id = null, show_ids = null
   where owner_id = me and id = dep_id and matched returning true into back;
  if back is not true then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  update tours set doc = jsonb_set(doc, array['otherIncome', dep_id], 'null'::jsonb), updated_at = now()
   where id = t_id and owner_id = me;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.unpark_guarantee(text, text) from public, anon;
grant execute on function public.unpark_guarantee(text, text) to authenticated;

notify pgrst, 'reload schema';
