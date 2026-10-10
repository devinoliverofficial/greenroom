-- Merch deposits are answered the way guarantee deposits are (Devin, 2026-10-10):
--   "When logging deposits and you click merch as what it was for you should
--    see the same dropdown menu as you do for Guarantees with all the dates
--    and the sort later button."
--
-- Four things here.
--  1. One merch deposit can pay for several nights (a weekend's card sales
--     landing as one payout): catalog_merch_split.
--  2. catalog_income takes one more answer, 'merch_later': the deposit is set
--     aside on the tour with no night yet ("Not sure which show yet").
--  3. sort_merch moves that money onto the night(s) it paid for, all of it or
--     part of it; unpark_merch puts the deposit back in New income.
--  4. A second deposit put on a night's merch adds to the first (below).
-- The owner's approval (0123) is carried by every one of these.
--
-- One difference from guarantees, on purpose. A guarantee is not counted as
-- income until it is received, so a guarantee logged "sort later" is kept in
-- otherIncome and counts from the day it landed (0124). Merch counts on the
-- night it is logged, received or not. A parked merch deposit kept in
-- otherIncome would count the same dollars a second time, and the tour's
-- income would fall again on the day it was sorted. So parked merch has its
-- own place on the tour, doc.merchToSort (keyed by the deposit), which no
-- total reads: it is a deposit waiting for its night, not new income.
--
-- (The "Whole tour" answer is gone from the app's list: "I don't know what the
-- option whole tour means. I don't really think this needs to be in here."
-- Nothing here removes it from the database: a phone on an older build can
-- still send it, and the Off Tour book, which has no nights, still takes
-- merch and guarantees that way.)

-- One night's merch, met by bank money. A night the bank has not shown yet is
-- received on what lands (the rule catalog_income has always followed for
-- merch). A night that already has a deposit from the bank gets this one ADDED
-- to it. Until now a second deposit replaced the first: the first one stayed
-- claimed in the bank feed and its dollars dropped off the night. Every
-- deposit is logged once only, so adding can never count one twice.
create or replace function public.catalog_merch_night(t_id text, s_id text, amount numeric, on_date date)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare cur jsonb; had numeric; was_on text; day text := to_char(on_date, 'YYYY-MM-DD');
begin
  select t.doc -> 'shows' -> s_id into cur from tours t where t.id = t_id;
  if jsonb_typeof(cur) is distinct from 'object' then raise exception 'no such show' using errcode = '22023'; end if;
  had := case when coalesce(cur ->> 'merchDeposit', '') ~ '^[0-9]+(\.[0-9]+)?$' then (cur ->> 'merchDeposit')::numeric else 0 end;
  was_on := case when coalesce(cur ->> 'merchReceivedAt', '') ~ '^\d{4}-\d{2}-\d{2}$' then cur ->> 'merchReceivedAt' else null end;
  if was_on is not null and had > 0 then
    -- More of it: added to what the bank has shown, dated the later of the two.
    perform public.merge_show(t_id, s_id, jsonb_build_object(
      'merchReceived', true,
      'merchReceivedAt', greatest(was_on, day),
      'merchDeposit', round(had + amount, 2)));
  else
    perform public.merge_show(t_id, s_id, jsonb_build_object(
      'merchReceived', true,
      'merchReceivedAt', day,
      'merchDeposit', round(amount, 2)));
  end if;
end $$;
revoke all on function public.catalog_merch_night(text, text, numeric, date) from public, anon, authenticated;

-- Bank money shared over nights' merch: every part is a night and its share.
-- Checked whole before anything is written (each night a real show with merch
-- logged, no night twice, every share above nothing, the shares the size of
-- the money), then filed night by night. The caller holds the tour's lock and
-- the owner's approval. Returns the nights.
create or replace function public.catalog_merch_parts(t_id text, parts jsonb, total numeric, on_date date)
returns text[]
language plpgsql volatile security definer set search_path = public as $$
declare
  shows jsonb; p jsonb; sid text; sum numeric := 0; ids text[] := '{}';
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
    if coalesce(shows -> sid -> 'income' ->> 'merch', '') !~ '^[0-9]+(\.[0-9]+)?$'
       or (shows -> sid -> 'income' ->> 'merch')::numeric <= 0 then
      raise exception 'no merch on that night' using errcode = '22023';
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
    perform public.catalog_merch_night(t_id, p ->> 'show', (p ->> 'amount')::numeric, on_date);
  end loop;
  return ids;
end $$;
revoke all on function public.catalog_merch_parts(text, jsonb, numeric, date) from public, anon, authenticated;

-- One merch deposit over several nights: the twin of catalog_income_split
-- (0121/0124), under its own name. A separate door on purpose: a phone whose
-- app is half updated can only ask for a guarantee split or a merch split by
-- name, so merch can never be filed as guarantees by a call that lost a word
-- on the way. (catalog_income_split is untouched.)
create or replace function public.catalog_merch_split(dep_id text, t_id text, parts jsonb)
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
  ids := public.catalog_merch_parts(t_id, parts, d.amount, d.date);
  update merch_deposits set matched = true, tour_id = t_id, show_ids = ids
   where owner_id = me and id = dep_id returning matched into took;
  if took is not true then raise exception 'the deposit was not marked' using errcode = '55000'; end if;
  return jsonb_build_object('ok', true, 'nights', coalesce(array_length(ids, 1), 0));
end $$;
revoke all on function public.catalog_merch_split(text, text, jsonb) from public, anon;
grant execute on function public.catalog_merch_split(text, text, jsonb) to authenticated;

-- catalog_income, as 0124 left it, with: 'merch_later', and one night's merch
-- filed through the rule above (a second deposit on a night adds).
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
  if kind is null or kind not in ('merch', 'merch_later', 'guarantee', 'guarantee_later', 'royalties', 'advance', 'skip') then
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
      perform public.catalog_merch_night(t_id, s_id, d.amount, d.date);
    else
      perform public.catalog_guarantee_night(t_id, s_id, d.amount, d.date);
    end if;
    update merch_deposits set matched = true, tour_id = t_id, show_ids = array[s_id]
     where owner_id = me and id = dep_id returning matched into took;
    if took is not true then raise exception 'the deposit was not marked' using errcode = '55000'; end if;
    return jsonb_build_object('ok', true);
  end if;

  -- 'merch_later': a merch deposit he cannot place on a show yet ("Not sure
  -- which show yet"). Set aside on the tour, keyed by the deposit, for
  -- sort_merch to move onto its night(s) later. It is not income by itself
  -- (the night's merch already is), so it is kept apart from otherIncome.
  -- Only on a real tour: the Off Tour book has no nights to sort it onto.
  if kind = 'merch_later' then
    if coalesce(tour.doc ->> 'kind', '') = 'offtour' then
      raise exception 'no nights on this book' using errcode = '22023';
    end if;
    update tours
       set doc = jsonb_set(doc, array['merchToSort'],
             (case when jsonb_typeof(doc -> 'merchToSort') = 'object' then doc -> 'merchToSort' else '{}'::jsonb end)
             || jsonb_build_object(dep_id, jsonb_build_object(
                  'date', to_char(d.date, 'YYYY-MM-DD'),
                  'amount', d.amount,
                  'at', (extract(epoch from now()) * 1000)::bigint))),
           updated_at = now()
     where id = t_id and owner_id = me;
    update merch_deposits set matched = true, tour_id = t_id, show_ids = null
     where owner_id = me and id = dep_id returning matched into took;
    if took is not true then raise exception 'the deposit was not marked' using errcode = '55000'; end if;
    return jsonb_build_object('ok', true);
  end if;

  -- The book's own money: royalties, an advance, or merch and guarantees
  -- with no night. Keyed by the deposit, so a retried tap can't write it twice.
  -- 'guarantee_later': a guarantee he cannot place on a show yet. It is
  -- guarantee income on the tour from today, flagged so the Income tab can
  -- list it and sort_guarantee can move it onto its night(s) later. Only on
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

-- A parked merch deposit finds its night(s): the twin of sort_guarantee (0125).
-- The tour's creator or a Manager. All of it, or part of it with the rest left
-- to sort (the entry remembers what it started as, 'of'). expect: the amount
-- the phone saw waiting; a tap that lands twice, or on an old amount, is
-- refused ('changed') instead of placing money a second time.
create or replace function public.sort_merch(dep_id text, t_id text, parts jsonb, expect numeric default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  tour record; entry jsonb; amt numeric; on_date date; ids text[]; going numeric; rest numeric; was numeric;
begin
  if auth.uid() is null then raise exception 'permission' using errcode = '42501'; end if;
  -- The tour's creator, or a Manager on it.
  if not public.money_lead(t_id) then raise exception 'permission' using errcode = '42501'; end if;
  select id, owner_id, doc into tour from tours
   where id = t_id and (doc ->> 'deletedAt') is null and coalesce(doc ->> 'kind', '') <> 'offtour'
   for update;
  if not found then raise exception 'permission' using errcode = '42501'; end if;
  entry := tour.doc -> 'merchToSort' -> dep_id;
  if jsonb_typeof(entry) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'why', 'done');
  end if;
  -- The deposit's own record, when it is still there, must say it is set aside
  -- on THIS tour: an entry that reached another tour's list some other way (a
  -- copied tour, a restored one) is not money to place a second time.
  if exists (select 1 from merch_deposits md
              where md.owner_id = tour.owner_id and md.id = dep_id
                and (md.matched is not true or md.tour_id is distinct from t_id)) then
    return jsonb_build_object('ok', false, 'why', 'done');
  end if;
  if coalesce(entry ->> 'amount', '') !~ '^[0-9]+(\.[0-9]+)?$' or (entry ->> 'amount')::numeric <= 0 then
    raise exception 'bad entry' using errcode = '22023';
  end if;
  amt := (entry ->> 'amount')::numeric;
  if expect is not null and abs(expect - amt) > 0.02 then
    return jsonb_build_object('ok', false, 'why', 'changed', 'left', amt);
  end if;
  on_date := case when (entry ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' then (entry ->> 'date')::date else current_date end;
  -- Saying where this deposit goes is the approval (0123).
  perform set_config('greenroom.deposit_approved', '1', true);

  -- How much of it is being placed now (each share is checked again below).
  if jsonb_typeof(parts) is distinct from 'array' then raise exception 'which nights' using errcode = '22023'; end if;
  select coalesce(sum(case when (p ->> 'amount') ~ '^[0-9]+(\.[0-9]+)?$' then (p ->> 'amount')::numeric else 0 end), 0)
    into going from jsonb_array_elements(parts) p;
  if going <= 0 then raise exception 'bad share' using errcode = '22023'; end if;
  if going > amt + 0.02 then raise exception 'more than is left' using errcode = '22023'; end if;
  rest := round(amt - going, 2);
  if rest < 0.01 then
    -- All of it: off the list (a tombstone, the way a removed entry is always kept).
    rest := 0;
    update tours set doc = jsonb_set(doc, array['merchToSort', dep_id], 'null'::jsonb), updated_at = now()
     where id = t_id;
  else
    -- Part of it: the rest stays to sort, and the entry remembers what it started as.
    was := case when (entry ->> 'of') ~ '^[0-9]+(\.[0-9]+)?$' then (entry ->> 'of')::numeric else amt end;
    update tours set doc = jsonb_set(doc, array['merchToSort', dep_id],
             entry || jsonb_build_object('amount', rest, 'of', was)), updated_at = now()
     where id = t_id;
  end if;
  -- Onto the nights, dated the day the bank showed the deposit. A bad list of
  -- nights raises here and the whole thing rolls back: the same dollars are
  -- never in both places, or in neither.
  ids := public.catalog_merch_parts(t_id, parts, going, on_date);
  -- The deposit's own record points at every night it has paid for so far.
  update merch_deposits
     set tour_id = t_id,
         show_ids = (select array(select distinct x from unnest(coalesce(show_ids, '{}'::text[]) || ids) x))
   where owner_id = tour.owner_id and id = dep_id;
  return jsonb_build_object('ok', true, 'nights', coalesce(array_length(ids, 1), 0), 'left', rest);
end $$;
revoke all on function public.sort_merch(text, text, jsonb, numeric) from public, anon;
grant execute on function public.sort_merch(text, text, jsonb, numeric) to authenticated;

-- Set aside by mistake: the entry comes off the tour and the deposit goes back
-- to New income, as if it had never been answered. For the person whose bank
-- it is. Refused once part of it has been placed on a show (the deposit would
-- come back whole and that part would be on the books twice), and when the
-- deposit's own record is gone.
create or replace function public.unpark_merch(dep_id text, t_id text)
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
  entry := tour.doc -> 'merchToSort' -> dep_id;
  if jsonb_typeof(entry) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'why', 'done');
  end if;
  if entry ? 'of' then return jsonb_build_object('ok', false, 'why', 'partly'); end if;
  perform set_config('greenroom.deposit_approved', '1', true);
  update merch_deposits set matched = false, tour_id = null, show_ids = null
   where owner_id = me and id = dep_id and matched returning (not matched) into back;
  if back is not true then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  update tours set doc = jsonb_set(doc, array['merchToSort', dep_id], 'null'::jsonb), updated_at = now()
   where id = t_id and owner_id = me;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.unpark_merch(text, text) from public, anon;
grant execute on function public.unpark_merch(text, text) to authenticated;

-- The list of merch deposits waiting for a show changes only through the doors
-- above, which carry the owner's approval (0123). Anything else that writes
-- the tour (an editor's save, a phone on an older build sending the tour as it
-- last saw it, the mail reader writing a whole tour back) leaves the list as
-- it was: quietly, so that save still goes through for everything else. A
-- deposit set aside here is claimed in the bank feed and shows nowhere else,
-- so an entry dropped by accident would be money nobody can find.
create or replace function public.tours_merch_to_sort_gate()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.deposit_approved() then return new; end if;
  if tg_op = 'INSERT' then
    -- A new tour starts with nothing set aside (a copy must not carry another tour's list).
    if new.doc ? 'merchToSort' then new.doc := new.doc - 'merchToSort'; end if;
  elsif (new.doc -> 'merchToSort') is distinct from (old.doc -> 'merchToSort') then
    if old.doc ? 'merchToSort' then
      new.doc := jsonb_set(new.doc, array['merchToSort'], old.doc -> 'merchToSort');
    else
      new.doc := new.doc - 'merchToSort';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.tours_merch_to_sort_gate() from public, anon, authenticated;
drop trigger if exists tours_merch_to_sort_gate on public.tours;
create trigger tours_merch_to_sort_gate before insert or update on public.tours
  for each row execute function public.tours_merch_to_sort_gate();

notify pgrst, 'reload schema';
