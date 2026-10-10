-- One deposit, several nights (Devin, 2026-10-09: "when you hit guarantee you
-- should be able to select multiple shows because sometimes we get multiple
-- guarantees from our agency in one lump sum ... when we log it as specific
-- dates this should just mark those dates automatically as received").
-- catalog_income_split files one bank deposit across the nights picked, each
-- with its share: every night is marked received on the deposit's date, with
-- its Deposit Amount, by the very rule one night already follows (only bank
-- money beyond what is on the show is new). The shares must add up to the
-- deposit, to the cent, or nothing is written. Where the sheet has shown that
-- the whole difference is the booking agent's cut, that is written on each
-- night as the reason, so no night is left asking why it came in short.

-- One night's guarantee, met by bank money (lifted out of catalog_income so a
-- whole deposit and a share of one are filed by the same rule).
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
      -- Part of what was typed has shown up; the rest hasn't yet.
      perform public.merge_show(t_id, s_id, jsonb_build_object('guaranteeSeen', seen));
    end if;
  else
    perform public.merge_show(t_id, s_id, jsonb_build_object(
      'guaranteeReceived', true,
      'guaranteeReceivedAt', to_char(on_date, 'YYYY-MM-DD'),
      'guaranteeDeposit', amount,
      'guaranteeSeen', amount));
  end if;
end $$;
revoke all on function public.catalog_guarantee_night(text, text, numeric, date) from public, anon, authenticated;

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
      perform public.catalog_guarantee_night(t_id, s_id, d.amount, d.date);
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

create or replace function public.catalog_income_split(dep_id text, t_id text, parts jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  d record; tour record; p jsonb; sid text; amt numeric; agent numeric; total numeric := 0;
  ids text[] := '{}'; cur jsonb; g numeric; dep numeric; has_why boolean;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
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
   where owner_id = me and id = dep_id;
  return jsonb_build_object('ok', true, 'nights', coalesce(array_length(ids, 1), 0));
end $$;
revoke all on function public.catalog_income_split(text, text, jsonb) from public, anon;
grant execute on function public.catalog_income_split(text, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
