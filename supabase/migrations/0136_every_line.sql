-- Every line accounted for (Devin, 2026-10-11): "I need you to also make sure
-- that this won't happen again with any other cards in the future. I need all
-- transactions to be accounted for".
--
-- Until now a bank line that failed any of the feed's rules (a card payment, a
-- move to savings, a day outside every tour's card dates, a word like
-- "autopay" in its name) was thrown away before anything was stored, and the
-- bank's place then moved past it. Nothing recorded that it had existed.
--
-- The rule from here on: store first, label second. Every posted line a bank
-- sends gets one row. The rules only decide WHERE it waits and what it is
-- called. A line that is not shown in the pile to sort is kept as "left out"
-- with its reason, where a person can see it and bring it in.
--
-- What this migration adds (the plaid function that uses it is pasted after):
--   1. feed_items: a fifth status, left_out, with a reason; who decided and
--      when; what the bank says now when it differs from what was filed; the
--      day the bank took a line back; the bank's own account id.
--   2. The phone can no longer write feed_items. It never needed to: every
--      change goes through the server, which checks who is asking.
--   3. plaid_items.last_ok: the last time a bank was read and saved.
--   4. feed_reads: one row for each read of each bank. Counts only, never a
--      name or an amount. What the bank sent must equal what was kept plus
--      what was counted and not kept; the difference (unexplained) must be 0.
--   5. feed_account(): the whole account for the person signed in, in one read.
--   6. feed_put_back(): bring a left-out or set-aside line back to the pile.
--
-- Safe to apply while the current function and the current app are live: the
-- old function never writes the new status or the new columns, the app reads
-- named columns only, and nothing a signed-in phone runs today writes
-- feed_items directly (the two my_pay_claim functions do, and both run as the
-- database, not as the phone).

-- 0. A fault found on the way. my_pay_account_of lists a new personal account
-- the first time it sees one, but it was declared "stable", and the database
-- refuses a write inside a stable function. One such row refused the whole
-- batch it arrived in, and every later read stopped at the same row.
alter function public.my_pay_account_of(uuid, text) volatile;

-- ============================== 1. feed_items ==============================
alter table public.feed_items add column if not exists reason text;
alter table public.feed_items add column if not exists decided_at timestamptz;
alter table public.feed_items add column if not exists decided_by uuid references auth.users (id) on delete set null;
-- the bank's latest figure, when it differs from a row a person already dealt with
alter table public.feed_items add column if not exists bank_amount numeric;
-- the day the bank withdrew this line
alter table public.feed_items add column if not exists gone_on date;
-- the bank's own id for the account (until now only the account's name was kept)
alter table public.feed_items add column if not exists account_id text;

alter table public.feed_items drop constraint if exists feed_items_status_check;
alter table public.feed_items add constraint feed_items_status_check
  check (status in ('waiting', 'filed', 'skipped', 'mypay', 'left_out'));

-- "Before the tour" was the server's own decision, stored as if a person had
-- set the line aside. It is a left-out line with a reason, like the others.
update public.feed_items set status = 'left_out', reason = 'before_tour'
 where status = 'skipped' and why = 'Before the tour';

-- The same for the server's other left-out lines, should this migration ever
-- be rolled back and applied again: the rollback turns every left-out row into
-- a set-aside one, and without this they would stay looking like a person's
-- (listed under "Set aside by you", and never looked at again when the card
-- dates change). They are known by the function's own words, exactly as it
-- writes them (LEFT_OUT_WORDS in supabase/functions/plaid/index.ts), and only
-- where nobody decided anything: a person's set-aside never carries those
-- words. On the first apply no row matches.
update public.feed_items
   set status = 'left_out',
       reason = case why
                  when 'Card payment' then 'card_payment'
                  when 'Moved to savings or investments' then 'own_move'
                  when 'Not during a tour' then 'outside_dates'
                  when 'Zero amount' then 'zero'
                  when 'Taken back by the bank' then 'bank_removed'
                end
 where status = 'skipped' and decided_at is null
   and why in ('Card payment', 'Moved to savings or investments', 'Not during a tour',
               'Zero amount', 'Taken back by the bank');

-- A left-out line always says why. The reasons a row may carry:
--   by the server (status left_out): card_payment, own_move, outside_dates,
--     before_tour, zero, bank_removed
--   by a person (status skipped): set_aside, same_as_typed, paid_back
alter table public.feed_items drop constraint if exists feed_items_left_out_reason;
alter table public.feed_items add constraint feed_items_left_out_reason
  check (status <> 'left_out' or reason is not null);
alter table public.feed_items drop constraint if exists feed_items_reason_check;
alter table public.feed_items add constraint feed_items_reason_check
  check (reason is null or reason in ('card_payment', 'own_move', 'outside_dates', 'before_tour', 'zero',
                                      'bank_removed', 'set_aside', 'same_as_typed', 'paid_back'));

-- for the lists of what is left out and what was set aside
create index if not exists feed_items_out on public.feed_items (owner_id, status)
  where status in ('left_out', 'skipped');

-- The phone reads its own rows (feed_items_select, unchanged) and writes none.
-- Until now it could change any column of its own rows, so a status or a
-- reason could be set by an old build with no charge behind it.
drop policy if exists feed_items_update on public.feed_items;
revoke insert, update, delete, truncate on public.feed_items from public, anon, authenticated;

-- ============================== 2. plaid_items ==============================
-- The last read of this bank that succeeded and was saved.
alter table public.plaid_items add column if not exists last_ok timestamptz;

-- ============================== 3. feed_reads ==============================
-- One row per bank connection per read, written by the server, also when the
-- read failed (status is then the bank's code, and the counts are 0).
--   status: ok | more (a read from the start that ran out of pages; the rest
--           comes on the next reads) | save_failed | lines_missing | a code
--           from the bank | asked (see the note below)
--   bank_sent = already_here + new_waiting + new_filed + new_left_out
--               + everything counted in not_kept + unexplained
--   not_kept: {"off": {"<account name>": n}, "money_in": n}
--   reasons:  {"card_payment": n, ...} for the new left-out rows
--   rules:    which version of the placing rules the read ran under
--   at:       when the read STARTED (every row of one run carries the same
--             time), so a note written while it was under way is newer than it
-- (A row with status 'asked' is not a read: it notes that the card dates were
-- saved, or that an account was switched back on or newly marked for income,
-- and that bank is owed a read from the start.)
create table if not exists public.feed_reads (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  item text not null,
  institution text not null default '',
  at timestamptz not null default now(),
  kind text not null check (kind in ('timer', 'app', 'refresh', 'catchup', 'rescan', 'check')),
  from_start boolean not null default false,
  status text not null default 'ok',
  bank_sent int not null default 0,
  pending int not null default 0,
  already_here int not null default 0,
  new_waiting int not null default 0,
  new_filed int not null default 0,
  new_left_out int not null default 0,
  reasons jsonb not null default '{}'::jsonb,
  not_kept jsonb not null default '{}'::jsonb,
  deposits int not null default 0,
  unexplained int not null default 0,
  first_day date,
  last_day date,
  rules int not null default 0
);
create index if not exists feed_reads_owner_at on public.feed_reads (owner_id, at desc);

alter table public.feed_reads enable row level security;
revoke all on public.feed_reads from public, anon, authenticated;
grant select on public.feed_reads to authenticated;
grant all on public.feed_reads to service_role;
drop policy if exists feed_reads_select on public.feed_reads;
create policy feed_reads_select on public.feed_reads for select to authenticated
  using (owner_id = auth.uid());

-- ============================== 4. feed_account ==============================
-- The whole account of the bank lines of the person signed in: how many there
-- are and where each one is, what is left out and why, what needs a look, how
-- each bank is doing, and what the last full check against the bank found.
--
-- Built to stay fast: one pass over the person's tours (each tour's document
-- is read once, for its name, whether it is taken down, and which bank lines
-- it holds), one pass over their feed rows, and the last few reads. No
-- function is called per row.
--
-- left_out[].sum adds up each line's amount without its sign: a card payment
-- seen from both sides (out of the bank account, onto the card) is two rows
-- with opposite signs, and a signed total would read as nothing.
--
-- "Filed but on no tour" (look.no_tour): a row that says filed while no tour
-- of this person holds its charge. A tour that is taken down still counts as
-- holding it. Charges from the bank are kept under "p" + the line's id; ones
-- from the first card feed (September 2026) under "y" + its id, and those
-- count too, so an old row is never called an orphan. A row filed in the last
-- two minutes is left out of the count: filing marks the row first and writes
-- the charge a moment later.
create or replace function public.feed_account()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  top_rules int;
  rows_part jsonb;
  banks_part jsonb;
  check_part jsonb;
  kept_part jsonb;
begin
  if me is null then return null; end if;

  with mine as materialized (
    select t.id,
           coalesce(nullif(btrim(r.name), ''), case when r.kind = 'offtour' then 'Off Tour' else '' end) as name,
           coalesce(r.kind, '') as kind,
           coalesce(r."deletedAt", '') not in ('', '0', 'false') as gone,
           (select coalesce(array_agg(substr(e.key, 2)), '{}'::text[])
              from jsonb_each(case when jsonb_typeof(r.charges) = 'object' then r.charges else '{}'::jsonb end) e
             where left(e.key, 1) in ('p', 'y') and jsonb_typeof(e.value) = 'object') as held
      from tours t
      -- (a document that is not an object reads as an empty one: it must not stop the whole account)
      cross join lateral jsonb_to_record(case when jsonb_typeof(t.doc) = 'object' then t.doc else '{}'::jsonb end)
                           as r(name text, kind text, "deletedAt" text, charges jsonb)
     where t.owner_id = me
  ), held as materialized (
    select distinct h.id from mine m cross join lateral unnest(m.held) as h(id)
  ), g as materialized (
    select f.status, f.reason, f.tour_id,
           count(*) as n,
           coalesce(sum(f.amount), 0) as s,
           coalesce(sum(abs(f.amount)), 0) as sa,
           min(f.date) as d0, max(f.date) as d1,
           count(*) filter (where f.gone_on is not null and f.status in ('filed', 'skipped', 'mypay')) as gone,
           count(*) filter (where f.bank_amount is not null and f.bank_amount <> f.amount) as changed,
           count(*) filter (where f.status = 'filed' and h.id is null
                              and (f.decided_at is null or f.decided_at < now() - interval '2 minutes')) as orphan
      from feed_items f
      left join held h on h.id = f.id
     where f.owner_id = me
     group by f.status, f.reason, f.tour_id
  )
  select jsonb_build_object(
    'total', coalesce((select sum(g.n) from g), 0),
    'by_status', jsonb_build_object(
      'waiting', coalesce((select sum(g.n) from g where g.status = 'waiting'), 0),
      'filed', coalesce((select sum(g.n) from g where g.status = 'filed'), 0),
      'left_out', coalesce((select sum(g.n) from g where g.status = 'left_out'), 0),
      'skipped', coalesce((select sum(g.n) from g where g.status = 'skipped'), 0),
      'mypay', coalesce((select sum(g.n) from g where g.status = 'mypay'), 0)),
    'waiting_by_tour', coalesce((
      select jsonb_agg(jsonb_build_object('tour_id', w.tour_id, 'name', w.name, 'kind', w.kind, 'n', w.n)
                       order by (w.kind = 'none'), (w.kind = 'gone'), w.n desc, w.name, w.tour_id)
        from (select q.tour_id, coalesce(m.name, '') as name,
                     case when q.tour_id is null then 'none'
                          when m.id is null or m.gone then 'gone'
                          when m.kind = 'offtour' then 'offtour'
                          else 'tour' end as kind,
                     q.n
                from (select g.tour_id, sum(g.n) as n from g where g.status = 'waiting' group by g.tour_id) q
                left join mine m on m.id = q.tour_id) w), '[]'::jsonb),
    'left_out', coalesce((
      select jsonb_agg(jsonb_build_object('reason', x.reason, 'n', x.n, 'sum', x.s, 'first_day', x.d0, 'last_day', x.d1)
                       order by x.n desc, x.reason)
        from (select g.reason, sum(g.n) as n, round(sum(g.sa), 2) as s, min(g.d0) as d0, max(g.d1) as d1
                from g where g.status = 'left_out' group by g.reason) x), '[]'::jsonb),
    'set_aside', (select jsonb_build_object('n', coalesce(sum(g.n), 0), 'sum', round(coalesce(sum(g.s), 0), 2))
                    from g where g.status = 'skipped'),
    'look', (select jsonb_build_object('no_tour', coalesce(sum(g.orphan), 0),
                                       'bank_gone', coalesce(sum(g.gone), 0),
                                       'bank_changed', coalesce(sum(g.changed), 0)) from g)
  ) into rows_part;

  -- Each bank: its name, how it is doing, when it was last read and saved, the
  -- day it was linked, its last full read under the newest rules, and "more":
  -- true when its latest read from the start ran out of pages before the bank
  -- ran out of lines (the rest comes in on the reads that follow). Never the
  -- key, the saved place or the bank's own id for the connection.
  select coalesce(max(r.rules), 0) into top_rules from feed_reads r where r.owner_id = me;
  select coalesce(jsonb_agg(jsonb_build_object(
           'institution', p.institution, 'status', p.status, 'last_ok', p.last_ok,
           'linked', (p.created_at at time zone 'UTC')::date,
           'full_read', (select max(r.at) from feed_reads r
                          where r.owner_id = me and r.item = p.item_id and r.from_start
                            and r.status = 'ok' and r.rules = top_rules),
           'more', coalesce((select r.status = 'more' from feed_reads r
                              where r.owner_id = me and r.item = p.item_id and r.from_start
                              order by r.at desc, r.id desc limit 1), false))
           order by p.created_at, p.institution), '[]'::jsonb)
    into banks_part
    from plaid_items p where p.owner_id = me and p.env = 'production';

  -- The last full check: each linked bank's latest read from the start that
  -- was carried through (a read that the bank refused, or that could not be
  -- saved, checked nothing and is not counted here; the bank's own row says
  -- how it is doing). Added up over the banks. "at" is the oldest of them, so
  -- the day named is one by which every bank had been checked. "found" counts
  -- every new row of that read, left-out ones included; the three numbers
  -- after it say how many of each.
  with latest as (
    select distinct on (r.item) r.*
      from feed_reads r
      join plaid_items p on p.owner_id = r.owner_id and p.item_id = r.item and p.env = 'production'
     where r.owner_id = me and r.from_start and r.status in ('ok', 'more', 'lines_missing')
     order by r.item, r.at desc, r.id desc
  )
  select case when count(*) = 0 then null else jsonb_build_object(
           'at', min(l.at),
           'bank_sent', coalesce(sum(l.bank_sent), 0),
           'found', coalesce(sum(l.new_waiting + l.new_filed + l.new_left_out), 0),
           'new_waiting', coalesce(sum(l.new_waiting), 0),
           'new_filed', coalesce(sum(l.new_filed), 0),
           'new_left_out', coalesce(sum(l.new_left_out), 0),
           'unexplained', coalesce(sum(l.unexplained), 0),
           'ok', coalesce(bool_and(l.status = 'ok'), false)) end,
         jsonb_build_object(
           'off', coalesce((
             select jsonb_agg(jsonb_build_object('account', o.account, 'n', o.n) order by o.n desc, o.account)
               from (select e.key as account,
                            sum(case when jsonb_typeof(e.value) = 'number' then (e.value #>> '{}')::numeric else 0 end) as n
                       from latest l2
                       cross join lateral jsonb_each(case when jsonb_typeof(l2.not_kept -> 'off') = 'object'
                                                          then l2.not_kept -> 'off' else '{}'::jsonb end) e
                      group by e.key) o
              where o.n > 0), '[]'::jsonb),
           'money_in', coalesce(sum(case when jsonb_typeof(l.not_kept -> 'money_in') = 'number'
                                         then (l.not_kept ->> 'money_in')::numeric else 0 end), 0))
    into check_part, kept_part
    from latest l;

  return rows_part || jsonb_build_object(
    'banks', banks_part,
    'check', check_part,
    'not_kept', coalesce(kept_part, jsonb_build_object('off', '[]'::jsonb, 'money_in', 0)));
end $$;
revoke all on function public.feed_account() from public, anon;
grant execute on function public.feed_account() to authenticated;

-- ============================== 5. feed_put_back ==============================
-- Bring lines back to the pile to sort. Only the person whose bank it is, and
-- only ever back to waiting: nothing is put on a tour here.
--   * a line the server left out (any reason but "the bank took it back"), or
--     one a person set aside: it waits again. The tour it was for stays as it
--     was, and so does the warning the line carried:
--       - left out by the server: "Put back: " and what it was left out for
--         ("Put back: Card payment", "Put back: Before the tour");
--       - set aside as "It's the one I typed": "Maybe already in" again, so
--         the pile treats it as a possible double and it is not added twice;
--       - set aside any other way: its words are left exactly as they were.
--   * a line that says filed while no tour holds its charge: it waits again
--     ("Put back: it was on no tour"). A line that IS on a tour is not touched,
--     and neither is one filed in the last two minutes (see feed_account).
--   * a line the bank has withdrawn (gone_on) is never put back: it stays
--     where it is listed.
--   * a line that comes back takes the bank's latest figure, where the bank
--     has changed the amount since.
-- Returns how many moved. (A line on a personal account goes to the MY PAY
-- inbox as it lands in waiting; that is the rule for every waiting row.)
create or replace function public.feed_put_back(ids text[])
returns int
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); n int := 0; m int := 0;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  if ids is null or cardinality(ids) = 0 then return 0; end if;
  if cardinality(ids) > 500 then raise exception 'too many at once' using errcode = '22023'; end if;

  update feed_items f
     set status = 'waiting',
         why = case when f.status = 'left_out' then
                      case when coalesce(f.why, '') = '' then 'Put back' else 'Put back: ' || f.why end
                    when f.reason = 'same_as_typed' then 'Maybe already in'
                    else f.why end,
         reason = null, decided_at = now(), decided_by = me,
         amount = coalesce(f.bank_amount, f.amount), bank_amount = null
   where f.owner_id = me and f.id = any (ids)
     and f.gone_on is null
     and ((f.status = 'left_out' and f.reason is distinct from 'bank_removed') or f.status = 'skipped');
  get diagnostics n = row_count;

  if exists (select 1 from feed_items f where f.owner_id = me and f.id = any (ids) and f.status = 'filed') then
    with held as materialized (
      select distinct substr(e.key, 2) as id
        from tours t
        cross join lateral jsonb_to_record(case when jsonb_typeof(t.doc) = 'object' then t.doc else '{}'::jsonb end)
                             as r(charges jsonb)
        cross join lateral jsonb_each(case when jsonb_typeof(r.charges) = 'object' then r.charges else '{}'::jsonb end) e
       where t.owner_id = me and left(e.key, 1) in ('p', 'y') and jsonb_typeof(e.value) = 'object'
    )
    update feed_items f
       set status = 'waiting', why = 'Put back: it was on no tour', reason = null, decided_at = now(), decided_by = me,
           amount = coalesce(f.bank_amount, f.amount), bank_amount = null
     where f.owner_id = me and f.id = any (ids) and f.status = 'filed'
       and f.gone_on is null
       and (f.decided_at is null or f.decided_at < now() - interval '2 minutes')
       and not exists (select 1 from held h where h.id = f.id);
    get diagnostics m = row_count;
  end if;
  return n + m;
end $$;
revoke all on function public.feed_put_back(text[]) from public, anon;
grant execute on function public.feed_put_back(text[]) to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
-- (Paste the plaid function from before this change FIRST: the new one writes
-- the status and the columns below. Then, in this order:)
--
--   drop function if exists public.feed_put_back(text[]);
--   drop function if exists public.feed_account();
--   drop table if exists public.feed_reads;
--   alter table public.plaid_items drop column if exists last_ok;
--
--   -- The old check has no place for left-out rows. Nothing is erased: they
--   -- become set-aside rows (what "Before the tour" rows were), and "why"
--   -- still says in plain words what each one was. (Applying this migration
--   -- again turns them back into left-out rows by those words: section 1.)
--   update public.feed_items set status = 'skipped' where status = 'left_out';
--
--   drop index if exists public.feed_items_out;
--   alter table public.feed_items drop constraint if exists feed_items_reason_check;
--   alter table public.feed_items drop constraint if exists feed_items_left_out_reason;
--   alter table public.feed_items drop constraint if exists feed_items_status_check;
--   alter table public.feed_items add constraint feed_items_status_check
--     check (status in ('waiting', 'filed', 'skipped', 'mypay'));
--   alter table public.feed_items drop column if exists account_id;
--   alter table public.feed_items drop column if exists gone_on;
--   alter table public.feed_items drop column if exists bank_amount;
--   alter table public.feed_items drop column if exists decided_by;
--   alter table public.feed_items drop column if exists decided_at;
--   alter table public.feed_items drop column if exists reason;
--
--   grant insert, update, delete on public.feed_items to authenticated;
--   create policy feed_items_update on public.feed_items for update
--     using (owner_id = auth.uid()) with check (owner_id = auth.uid());
--
--   alter function public.my_pay_account_of(uuid, text) stable;   -- (the fault comes back with it)
--   notify pgrst, 'reload schema';
