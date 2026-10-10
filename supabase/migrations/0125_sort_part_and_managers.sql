-- Guarantees to sort, two changes Devin asked for (2026-10-09):
--   1. "rebuild it so you can account for partial payments if needed": part of
--      a "Sort later" deposit can be put on its show(s) now; the rest stays in
--      Guarantees to sort (same deposit, smaller amount) until its paperwork
--      comes. The entry remembers what it started as ('of'), so the list can
--      say "$6,000 left of $10,000".
--   2. "any manage of the account should be able to sort through": whoever
--      manages the tour (its creator, or a Manager: money_lead, 0060) can sort.
--      Logging a deposit in the first place, and putting one back in New
--      income, stay with the person whose bank it is.
--
-- expect: the amount the phone saw waiting. A tap that arrives twice, or from
-- a phone looking at an old amount, is refused ('changed') instead of placing
-- money a second time out of what is left.

drop function if exists public.sort_guarantee(text, text, jsonb, boolean);

create or replace function public.sort_guarantee(dep_id text, t_id text, parts jsonb, whole boolean default false, expect numeric default null)
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
  entry := tour.doc -> 'otherIncome' -> dep_id;
  if jsonb_typeof(entry) is distinct from 'object' or (entry ->> 'unsorted') is distinct from 'true' then
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

  if whole then
    -- What is left belongs to no one night after all: the flag comes off.
    update tours set doc = jsonb_set(doc, array['otherIncome', dep_id], entry - 'unsorted'), updated_at = now()
     where id = t_id;
    return jsonb_build_object('ok', true, 'nights', 0, 'left', 0);
  end if;

  -- How much of it is being placed now (each share is checked again below).
  if jsonb_typeof(parts) is distinct from 'array' then raise exception 'which nights' using errcode = '22023'; end if;
  select coalesce(sum(case when (p ->> 'amount') ~ '^[0-9]+(\.[0-9]+)?$' then (p ->> 'amount')::numeric else 0 end), 0)
    into going from jsonb_array_elements(parts) p;
  if going <= 0 then raise exception 'bad share' using errcode = '22023'; end if;
  if going > amt + 0.02 then raise exception 'more than is left' using errcode = '22023'; end if;
  rest := round(amt - going, 2);
  -- (Only when nothing is really left: a cent or two that stays is still his money to sort.)
  if rest < 0.01 then
    -- All of it: off the book (a tombstone, the way a removed entry is always kept).
    rest := 0;
    update tours set doc = jsonb_set(doc, array['otherIncome', dep_id], 'null'::jsonb), updated_at = now()
     where id = t_id;
  else
    -- Part of it: the rest stays to sort, and the entry remembers what it started as.
    was := case when (entry ->> 'of') ~ '^[0-9]+(\.[0-9]+)?$' then (entry ->> 'of')::numeric else amt end;
    update tours set doc = jsonb_set(doc, array['otherIncome', dep_id],
             entry || jsonb_build_object('amount', rest, 'of', was)), updated_at = now()
     where id = t_id;
  end if;
  -- Onto the nights, by the rule every guarantee deposit follows, dated the day
  -- the bank showed the deposit. A bad list of nights raises here and the whole
  -- thing rolls back: the same dollars are never in both places, or in neither.
  ids := public.catalog_guarantee_parts(t_id, parts, going, on_date);
  -- The deposit's own record points at every night it has paid for so far.
  update merch_deposits
     set tour_id = t_id,
         show_ids = (select array(select distinct x from unnest(coalesce(show_ids, '{}'::text[]) || ids) x))
   where owner_id = tour.owner_id and id = dep_id;
  return jsonb_build_object('ok', true, 'nights', coalesce(array_length(ids, 1), 0), 'left', rest);
end $$;
revoke all on function public.sort_guarantee(text, text, jsonb, boolean, numeric) from public, anon;
grant execute on function public.sort_guarantee(text, text, jsonb, boolean, numeric) to authenticated;

-- Putting a "Sort later" deposit back in New income: as 0124, and refused once
-- part of it has been placed on a show (the deposit would come back whole and
-- that part would be counted twice).
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
  if entry ? 'of' then return jsonb_build_object('ok', false, 'why', 'partly'); end if;
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
