-- Money someone fronted for the tour (Devin, 2026-10-10): "in the 'MY PAY'
-- section there can be a log where if someone on the tour spots any money for
-- the band/tour they can log it as something that needs to be reimbursed and it
-- is sent to the tasks button as well as the bands expense tab under
-- 'REIMBURSEMENTS.' In this category we can click it and see all the payments
-- that need to be reimbursed and mark them paid or not. If they are not paid
-- they will stay in the tasks tab".
--
-- Anyone on a tour can ask, Crew included, and Crew cannot read or write the
-- tour's own document (they get a copy with no money in it). So the asks live
-- in a table of their own:
--   * a person reads only their own asks; a tour's Managers read every ask on
--     that tour. Nobody else reads anything, and Crew never see the tour's
--     totals or each other's asks;
--   * nobody writes the table directly. An ask is made, taken back, marked
--     paid or not paid, or taken off by the functions below, which check who
--     is asking;
--   * the tour's books count an ask as a cost from the day it is logged, paid
--     back or not (the app adds the line called Reimbursements). Marking it
--     paid changes who is still owed, never the tour's total, and writes no
--     charge: paying someone back is the Manager's own act, and the app only
--     records that it happened.

create table if not exists public.reimbursements (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{6,40}$'),
  tour_id text not null references public.tours (id) on delete cascade,
  -- (kept when the person's account goes: the tour's books do not lose a line)
  user_id uuid references auth.users (id) on delete set null,
  requester_name text not null default '',
  amount numeric(12, 2) not null check (amount > 0 and amount <= 10000),
  what text not null check (char_length(what) between 1 and 140),
  spent_on date not null,
  status text not null default 'open' check (status in ('open', 'paid', 'withdrawn')),
  paid_at timestamptz,
  paid_by uuid references auth.users (id) on delete set null,
  paid_by_name text not null default '',
  paid_how text not null default '' check (paid_how in ('', 'cash', 'card', 'other')),
  -- the card charge that was the payback, when a Manager said so (so it is not counted twice)
  feed_id text not null default '' check (char_length(feed_id) <= 80),
  -- who took it off, when it is withdrawn: the person themself, or a Manager ("not a tour cost")
  closed_by_name text not null default '',
  closed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists reimbursements_tour on public.reimbursements (tour_id);
create index if not exists reimbursements_user on public.reimbursements (user_id);

alter table public.reimbursements enable row level security;
revoke all on public.reimbursements from public, anon, authenticated;
grant select on public.reimbursements to authenticated;
drop policy if exists reimbursements_select on public.reimbursements;
create policy reimbursements_select on public.reimbursements for select to authenticated
  using (user_id = auth.uid() or public.money_lead(tour_id));

-- The name the tour knows the person by: the one typed on the crew list when
-- they were invited, else their own profile name.
create or replace function public.reimburse_name(t_id text, u uuid)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select left(coalesce(
    nullif(btrim((select m.display_name from members m where m.tour_id = t_id and m.user_id = u limit 1)), ''),
    nullif(btrim(public.person_name(u)), ''),
    'Someone on the tour'), 60)
$function$;
revoke all on function public.reimburse_name(text, uuid) from public, anon, authenticated;

-- "I paid for this, for the tour." Anyone with a seat on the tour may ask.
-- The id is made on the phone, so a save that is sent twice makes one ask.
create or replace function public.reimburse_ask(r_id text, t_id text, amt numeric, r_what text, r_day date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  me uuid := auth.uid();
  d jsonb;
  a numeric := round(coalesce(amt, 0), 2);
  w text := left(btrim(regexp_replace(coalesce(r_what, ''), '\s+', ' ', 'g')), 140);
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  if r_id is null or r_id !~ '^[A-Za-z0-9_-]{6,40}$' then raise exception 'bad id' using errcode = '22023'; end if;
  if public.my_role(t_id) is null then return jsonb_build_object('ok', false, 'why', 'role'); end if;
  select t.doc into d from tours t where t.id = t_id;
  if d is null or (d ->> 'deletedAt') is not null or coalesce(d ->> 'kind', '') = 'offtour' then
    return jsonb_build_object('ok', false, 'why', 'tour');
  end if;
  if a <= 0 or a > 10000 then return jsonb_build_object('ok', false, 'why', 'amount'); end if;
  if w = '' then return jsonb_build_object('ok', false, 'why', 'what'); end if;
  if r_day is null or r_day > current_date + 1 or r_day < current_date - 400 then
    return jsonb_build_object('ok', false, 'why', 'date');
  end if;
  -- (the same save, sent again)
  if exists (select 1 from reimbursements r where r.id = r_id and r.user_id = me and r.tour_id = t_id) then
    return jsonb_build_object('ok', true);
  end if;
  if (select count(*) from reimbursements r where r.tour_id = t_id and r.user_id = me and r.status = 'open') >= 60
     or (select count(*) from reimbursements r where r.user_id = me and r.created_at > now() - interval '1 day') >= 60 then
    return jsonb_build_object('ok', false, 'why', 'many');
  end if;
  insert into reimbursements (id, tour_id, user_id, requester_name, amount, what, spent_on)
  values (r_id, t_id, me, public.reimburse_name(t_id, me), a, w, r_day)
  on conflict (id) do nothing;
  if not found and not exists (select 1 from reimbursements r where r.id = r_id and r.user_id = me and r.tour_id = t_id) then
    return jsonb_build_object('ok', false, 'why', 'id');
  end if;
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.reimburse_ask(text, text, numeric, text, date) from public, anon;
grant execute on function public.reimburse_ask(text, text, numeric, text, date) to authenticated;

-- Taking an ask off: the person who made it, or a Manager of the tour ("that
-- was not a tour cost"). Only while it has not been paid: a paid one is first
-- marked not paid by a Manager. Nothing is erased; the row says who took it off.
create or replace function public.reimburse_withdraw(r_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me uuid := auth.uid(); r public.reimbursements%rowtype;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  select * into r from reimbursements where id = r_id for update;
  if not found or not (coalesce(r.user_id = me, false) or public.money_lead(r.tour_id)) then
    return jsonb_build_object('ok', false, 'why', 'gone');
  end if;
  if r.status = 'withdrawn' then return jsonb_build_object('ok', true); end if;
  if r.status = 'paid' then return jsonb_build_object('ok', false, 'why', 'paid'); end if;
  update reimbursements
     set status = 'withdrawn', closed_at = now(), closed_by_name = public.reimburse_name(r.tour_id, me)
   where id = r_id;
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.reimburse_withdraw(text) from public, anon;
grant execute on function public.reimburse_withdraw(text) to authenticated;

-- Paid, or not paid: a Manager of the tour says so. It records the fact and
-- nothing else (no charge is written; the tour's total does not move).
create or replace function public.reimburse_mark(r_id text, is_paid boolean, how text default '', feed text default '')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me uuid := auth.uid(); r public.reimbursements%rowtype; h text := lower(btrim(coalesce(how, '')));
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  select * into r from reimbursements where id = r_id for update;
  if is_paid is null then raise exception 'paid or not' using errcode = '22023'; end if;
  if not found then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  -- (to anyone who is neither a Manager of that tour nor the asker, the ask does not exist)
  if not public.money_lead(r.tour_id) then
    return jsonb_build_object('ok', false, 'why', case when coalesce(r.user_id = me, false) then 'role' else 'gone' end);
  end if;
  if r.status = 'withdrawn' then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  if is_paid then
    -- (Already paid: who paid and when stand. Only how, or the card charge it turned out to be, is filled in.)
    update reimbursements
       set status = 'paid',
           paid_at = case when r.status = 'paid' then r.paid_at else now() end,
           paid_by = case when r.status = 'paid' then r.paid_by else me end,
           paid_by_name = case when r.status = 'paid' then r.paid_by_name else public.reimburse_name(r.tour_id, me) end,
           paid_how = case when h in ('cash', 'card', 'other') then h when r.status = 'paid' then r.paid_how else '' end,
           feed_id = coalesce(nullif(left(btrim(coalesce(feed, '')), 80), ''), case when r.status = 'paid' then r.feed_id else '' end)
     where id = r_id;
  else
    update reimbursements
       set status = 'open', paid_at = null, paid_by = null, paid_by_name = '', paid_how = '', feed_id = ''
     where id = r_id;
  end if;
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.reimburse_mark(text, boolean, text, text) from public, anon;
grant execute on function public.reimburse_mark(text, boolean, text, text) to authenticated;

-- Put back: a Manager took an ask off by mistake. It waits to be paid back again.
create or replace function public.reimburse_restore(r_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me uuid := auth.uid(); r public.reimbursements%rowtype;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  select * into r from reimbursements where id = r_id for update;
  if not found then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  if not public.money_lead(r.tour_id) then
    return jsonb_build_object('ok', false, 'why', case when coalesce(r.user_id = me, false) then 'role' else 'gone' end);
  end if;
  if r.status <> 'withdrawn' then return jsonb_build_object('ok', true); end if;
  update reimbursements set status = 'open', closed_at = null, closed_by_name = '' where id = r_id;
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.reimburse_restore(text) from public, anon;
grant execute on function public.reimburse_restore(text) to authenticated;

-- Phones hear about a new ask, or one being paid, as it happens (each phone
-- only ever receives the rows it may read).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reimbursements') then
    alter publication supabase_realtime add table public.reimbursements;
  end if;
end $$;

notify pgrst, 'reload schema';
