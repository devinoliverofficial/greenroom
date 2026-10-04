-- MODEL7MERCH, phase 0: Greenroom reads a Square account the band owns.
-- Square is the card pipe at the merch table; Greenroom is the book. The
-- money goes fans -> Square -> the band's bank and never touches Greenroom.
-- This phase is the SANDBOX (Square's fake-money test world): prove that a
-- sale rung on Square, tip and all, shows up on the right night in Greenroom
-- with nobody logging anything.
--
-- No server redeploys needed: the database itself calls Square's API with
-- pg_net (fire a request now, read the reply on the next tick) on a cron,
-- the same way the other Greenroom jobs run.

-- 1. The connection. One row per account: which world (sandbox or real),
-- and the access token. The token is write-only from the app: the column
-- grants below let a signed-in user save or replace THEIR token, but no app
-- query can ever read a token back out.
create table if not exists public.square_connect (
  owner_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  env text not null default 'sandbox' check (env in ('sandbox', 'production')),
  token text not null,
  merchant text not null default '',
  location_id text not null default '',
  location_name text not null default '',
  status text not null default 'new',    -- new | ok | bad_token | error
  detail text not null default '',
  last_sync timestamptz,
  connected_at timestamptz not null default now()
);
alter table public.square_connect enable row level security;
drop policy if exists square_connect_all on public.square_connect;
create policy square_connect_all on public.square_connect
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.square_connect from public, anon, authenticated;
grant select (owner_id, env, merchant, location_id, location_name, status, detail, last_sync, connected_at)
  on public.square_connect to authenticated;
grant insert (owner_id, env, token, status), update (owner_id, env, token, status), delete
  on public.square_connect to authenticated;

-- 2. What Square tells us. Amounts and ids only, dollars not cents, the
-- same ethos as the bank feed: enough to keep the books, nothing more.
create table if not exists public.square_payments (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  env text not null default 'sandbox',
  created_at timestamptz not null,
  location_id text not null default '',
  status text not null default '',
  amount numeric not null default 0,     -- the sale, tip not included
  tip numeric not null default 0,
  total numeric not null default 0,      -- what the card was charged
  refunded numeric not null default 0,   -- given back later, if any
  primary key (owner_id, id)
);
create index if not exists square_payments_when on public.square_payments (owner_id, created_at);
alter table public.square_payments enable row level security;
drop policy if exists square_payments_select on public.square_payments;
create policy square_payments_select on public.square_payments for select using (owner_id = auth.uid());

create table if not exists public.square_payouts (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  env text not null default 'sandbox',
  status text not null default '',
  arrival_date date,
  amount numeric not null default 0,
  location_id text not null default '',
  entries_asked boolean not null default false,
  primary key (owner_id, id)
);
alter table public.square_payouts enable row level security;
drop policy if exists square_payouts_select on public.square_payouts;
create policy square_payouts_select on public.square_payouts for select using (owner_id = auth.uid());

create table if not exists public.square_payout_entries (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  payout_id text not null,
  type text not null default '',
  payment_id text,
  gross numeric not null default 0,
  fee numeric not null default 0,
  net numeric not null default 0,
  effective_at timestamptz,
  primary key (owner_id, id)
);
create index if not exists square_entries_payout on public.square_payout_entries (owner_id, payout_id);
alter table public.square_payout_entries enable row level security;
drop policy if exists square_entries_select on public.square_payout_entries;
create policy square_entries_select on public.square_payout_entries for select using (owner_id = auth.uid());

-- Requests in flight: pg_net answers on a later tick, so each fired request
-- is remembered until its reply is read. Server-side only.
create table if not exists public.square_requests (
  id bigint primary key,                 -- pg_net's request id
  owner_id uuid not null,
  kind text not null,                    -- locations | payments | payouts | entries | test_sale
  meta jsonb not null default '{}'::jsonb,
  fired_at timestamptz not null default now()
);
alter table public.square_requests enable row level security;
revoke all on public.square_requests from public, anon, authenticated;

create or replace function public.square_base(env text)
returns text language sql immutable as $$
  select case when env = 'production' then 'https://connect.squareup.com' else 'https://connect.squareupsandbox.com' end
$$;
revoke all on function public.square_base(text) from public, anon, authenticated;

-- 3. Parsers, one per reply shape, so they can be tested with plain JSON.
create or replace function public.square_take_locations(o uuid, body jsonb)
returns void language sql volatile security definer set search_path = public as $$
  update square_connect set
    merchant = coalesce(body -> 'locations' -> 0 ->> 'merchant_id', ''),
    location_id = coalesce((
      select l ->> 'id' from jsonb_array_elements(body -> 'locations') l
       where coalesce(l ->> 'status', 'ACTIVE') = 'ACTIVE' limit 1), ''),
    location_name = coalesce((
      select l ->> 'name' from jsonb_array_elements(body -> 'locations') l
       where coalesce(l ->> 'status', 'ACTIVE') = 'ACTIVE' limit 1), ''),
    status = case when jsonb_array_length(coalesce(body -> 'locations', '[]'::jsonb)) > 0 then 'ok' else 'error' end,
    detail = case when jsonb_array_length(coalesce(body -> 'locations', '[]'::jsonb)) > 0 then '' else 'no locations' end
  where owner_id = o
$$;
revoke all on function public.square_take_locations(uuid, jsonb) from public, anon, authenticated;

create or replace function public.square_take_payments(o uuid, env_ text, body jsonb)
returns int language sql volatile security definer set search_path = public as $$
  with rows as (
    insert into square_payments (owner_id, id, env, created_at, location_id, status, amount, tip, total, refunded)
    select o, p ->> 'id', env_, (p ->> 'created_at')::timestamptz,
           coalesce(p ->> 'location_id', ''), coalesce(p ->> 'status', ''),
           coalesce((p -> 'amount_money' ->> 'amount')::numeric, 0) / 100.0,
           coalesce((p -> 'tip_money' ->> 'amount')::numeric, 0) / 100.0,
           coalesce((p -> 'total_money' ->> 'amount')::numeric,
                    coalesce((p -> 'amount_money' ->> 'amount')::numeric, 0)
                    + coalesce((p -> 'tip_money' ->> 'amount')::numeric, 0)) / 100.0,
           coalesce((p -> 'refunded_money' ->> 'amount')::numeric, 0) / 100.0
      from jsonb_array_elements(coalesce(body -> 'payments', '[]'::jsonb)) p
     where p ->> 'id' is not null and p ->> 'created_at' is not null
    on conflict (owner_id, id) do update
      set status = excluded.status, amount = excluded.amount, tip = excluded.tip, total = excluded.total,
          refunded = excluded.refunded
    returning 1)
  select coalesce(count(*), 0)::int from rows
$$;
revoke all on function public.square_take_payments(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.square_take_payouts(o uuid, env_ text, body jsonb)
returns int language sql volatile security definer set search_path = public as $$
  with rows as (
    insert into square_payouts (owner_id, id, env, status, arrival_date, amount, location_id)
    select o, p ->> 'id', env_, coalesce(p ->> 'status', ''),
           nullif(p ->> 'arrival_date', '')::date,
           coalesce((p -> 'amount_money' ->> 'amount')::numeric, 0) / 100.0,
           coalesce(p ->> 'location_id', '')
      from jsonb_array_elements(coalesce(body -> 'payouts', '[]'::jsonb)) p
     where p ->> 'id' is not null
    on conflict (owner_id, id) do update
      set status = excluded.status, arrival_date = excluded.arrival_date, amount = excluded.amount
    returning 1)
  select coalesce(count(*), 0)::int from rows
$$;
revoke all on function public.square_take_payouts(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.square_take_entries(o uuid, pid text, body jsonb)
returns int language sql volatile security definer set search_path = public as $$
  with rows as (
    insert into square_payout_entries (owner_id, id, payout_id, type, payment_id, gross, fee, net, effective_at)
    select o, e ->> 'id', pid, coalesce(e ->> 'type', ''),
           coalesce(e -> 'type_charge_details' ->> 'payment_id', e -> 'type_refund_details' ->> 'payment_id'),
           coalesce((e -> 'gross_amount_money' ->> 'amount')::numeric, 0) / 100.0,
           coalesce((e -> 'fee_amount_money' ->> 'amount')::numeric, 0) / 100.0,
           coalesce((e -> 'net_amount_money' ->> 'amount')::numeric, 0) / 100.0,
           nullif(e ->> 'effective_at', '')::timestamptz
      from jsonb_array_elements(coalesce(body -> 'payout_entries', '[]'::jsonb)) e
     where e ->> 'id' is not null
    on conflict (owner_id, id) do update
      set type = excluded.type, gross = excluded.gross, fee = excluded.fee, net = excluded.net
    returning 1)
  select coalesce(count(*), 0)::int from rows
$$;
revoke all on function public.square_take_entries(uuid, text, jsonb) from public, anon, authenticated;

-- 4. Lay Square's night onto the show. A card tap at 11pm is already the
-- next day in UTC, and a 1am tap is still the same night: the clock is
-- pulled back ten hours before picking the date (the night turns over at
-- 6am New York / 3am Los Angeles), then the night lands on the one show
-- that owner has on that date.
create or replace function public.reconcile_square()
returns int language plpgsql volatile security definer set search_path = public as $$
declare b record; t record; obj jsonb; cur jsonb; placed int := 0; fees numeric; nets numeric; cnt int; hits int;
begin
  for b in
    select p.owner_id, p.env, ((p.created_at - interval '10 hours') at time zone 'UTC')::date as night,
           round(sum(p.amount), 2) as sales, round(sum(p.tip), 2) as tips,
           round(sum(p.refunded), 2) as refunds, count(*) as taps,
           array_agg(p.id) as pay_ids
      from square_payments p
      join square_connect sc on sc.owner_id = p.owner_id and sc.env = p.env
     where p.status = 'COMPLETED' and p.created_at >= now() - interval '60 days'
     group by p.owner_id, p.env, 3
  loop
    -- Exactly one show that night across the owner's tours; two = ambiguous, skip.
    select count(*) into hits
      from tours t2, lateral jsonb_each(t2.doc -> 'shows') e(k, v)
     where t2.owner_id = b.owner_id
       and (t2.doc ->> 'deletedAt') is null and coalesce(t2.doc ->> 'kind', '') <> 'offtour'
       and (e.v ->> 'date') = to_char(b.night, 'YYYY-MM-DD');
    if hits <> 1 then continue; end if;
    select t2.id as tour_id, e.k as sid, e.v as show into t
      from tours t2, lateral jsonb_each(t2.doc -> 'shows') e(k, v)
     where t2.owner_id = b.owner_id
       and (t2.doc ->> 'deletedAt') is null and coalesce(t2.doc ->> 'kind', '') <> 'offtour'
       and (e.v ->> 'date') = to_char(b.night, 'YYYY-MM-DD');
    -- Fees and net ride along once every payment's payout entry has arrived;
    -- refund entries subtract, and don't count against completeness.
    select round(sum(pe.fee), 2), round(sum(pe.net), 2),
           count(*) filter (where pe.type = 'CHARGE') into fees, nets, cnt
      from square_payout_entries pe
     where pe.owner_id = b.owner_id and pe.payment_id = any (b.pay_ids)
       and pe.type in ('CHARGE', 'REFUND');
    obj := jsonb_build_object('sales', b.sales, 'tips', b.tips, 'taps', b.taps, 'env', b.env)
           || case when b.refunds > 0 then jsonb_build_object('refunds', b.refunds) else '{}'::jsonb end
           || case when cnt = b.taps and cnt > 0 then jsonb_build_object('fees', fees, 'net', nets) else '{}'::jsonb end;
    cur := t.show -> 'merchSquare';
    if cur is null or cur - 'at' <> obj then
      perform public.merge_show(t.tour_id, t.sid, jsonb_build_object('merchSquare', obj || jsonb_build_object('at', now())));
      placed := placed + 1;
    end if;
  end loop;
  return placed;
end $$;
revoke all on function public.reconcile_square() from public, anon, authenticated;

-- 5. The tick: read replies that have arrived, then fire the next asks.
create or replace function public.square_tick()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare r record; c record; body jsonb; took int := 0; fired int := 0; rid bigint; base text; cursor_ text;
begin
  if not exists (select 1 from square_connect) then return jsonb_build_object('idle', true); end if;

  -- Absorb what has come back.
  for r in select q.id, q.owner_id, q.kind, q.meta, resp.status_code, resp.content, resp.timed_out, resp.error_msg
             from square_requests q join net._http_response resp on resp.id = q.id
  loop
    begin
      body := case when r.content is null or r.content = '' then '{}'::jsonb else r.content::jsonb end;
      if r.status_code is null then
        -- Timed out or never left: say so, and let a lost entries ask be asked again.
        update square_connect set status = 'error',
               detail = left(coalesce(r.error_msg, case when r.timed_out then 'timed out' else 'no answer' end), 160)
         where owner_id = r.owner_id and status <> 'bad_token';
        if r.kind = 'entries' then
          update square_payouts set entries_asked = false
           where owner_id = r.owner_id and id = r.meta ->> 'payout_id';
        end if;
      elsif r.status_code = 401 then
        update square_connect set status = 'bad_token', detail = 'Square refused the token'
         where owner_id = r.owner_id;
      elsif r.status_code >= 400 then
        update square_connect set status = 'error',
               detail = left(coalesce(body -> 'errors' -> 0 ->> 'detail', 'http ' || r.status_code), 160)
         where owner_id = r.owner_id and status <> 'bad_token';
        if r.kind = 'entries' then
          update square_payouts set entries_asked = false
           where owner_id = r.owner_id and id = r.meta ->> 'payout_id';
        end if;
      else
        if r.kind = 'locations' then
          perform square_take_locations(r.owner_id, body);
        elsif r.kind = 'payments' then
          perform square_take_payments(r.owner_id, coalesce(r.meta ->> 'env', 'sandbox'), body);
        elsif r.kind = 'payouts' then
          perform square_take_payouts(r.owner_id, coalesce(r.meta ->> 'env', 'sandbox'), body);
        elsif r.kind = 'entries' then
          perform square_take_entries(r.owner_id, r.meta ->> 'payout_id', body);
        end if;
        if r.kind <> 'locations' then
          update square_connect set status = 'ok', detail = '' where owner_id = r.owner_id and status <> 'ok';
        end if;
        -- Another page waiting: ask for it straight away.
        cursor_ := body ->> 'cursor';
        if cursor_ is not null and r.kind in ('payments', 'payouts', 'entries') then
          select sc.* into c from square_connect sc where sc.owner_id = r.owner_id;
          if found then
            base := square_base(c.env);
            rid := net.http_get(
              url := base || case r.kind
                       when 'payments' then '/v2/payments'
                       when 'payouts' then '/v2/payouts'
                       else '/v2/payouts/' || (r.meta ->> 'payout_id') || '/payout-entries' end,
              params := coalesce(r.meta -> 'params', '{}'::jsonb) || jsonb_build_object('cursor', cursor_),
              headers := jsonb_build_object('Authorization', 'Bearer ' || c.token));
            insert into square_requests (id, owner_id, kind, meta) values (rid, r.owner_id, r.kind, r.meta);
          end if;
        end if;
      end if;
      took := took + 1;
      delete from square_requests where id = r.id;
    exception when others then
      delete from square_requests where id = r.id;
    end;
  end loop;
  -- Replies that never came (pg_net keeps them ~6 hours) stop blocking after an hour.
  delete from square_requests where fired_at < now() - interval '1 hour';

  -- Fire the next round.
  for c in select * from square_connect where status <> 'bad_token'
  loop
    if exists (select 1 from square_requests q where q.owner_id = c.owner_id) then continue; end if;
    base := square_base(c.env);
    if c.location_id = '' then
      rid := net.http_get(url := base || '/v2/locations',
        headers := jsonb_build_object('Authorization', 'Bearer ' || c.token));
      insert into square_requests (id, owner_id, kind) values (rid, c.owner_id, 'locations');
    else
      rid := net.http_get(url := base || '/v2/payments',
        params := jsonb_build_object(
          'begin_time', to_char(greatest(coalesce(c.last_sync, now() - interval '30 days') - interval '2 days',
                                          now() - interval '30 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'sort_order', 'ASC', 'limit', '100'),
        headers := jsonb_build_object('Authorization', 'Bearer ' || c.token));
      insert into square_requests (id, owner_id, kind, meta)
        values (rid, c.owner_id, 'payments', jsonb_build_object('env', c.env, 'params', jsonb_build_object(
          'begin_time', to_char(greatest(coalesce(c.last_sync, now() - interval '30 days') - interval '2 days',
                                          now() - interval '30 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'sort_order', 'ASC', 'limit', '100')));
      rid := net.http_get(url := base || '/v2/payouts',
        params := jsonb_build_object('location_id', c.location_id, 'sort_order', 'DESC', 'limit', '100'),
        headers := jsonb_build_object('Authorization', 'Bearer ' || c.token));
      insert into square_requests (id, owner_id, kind, meta)
        values (rid, c.owner_id, 'payouts', jsonb_build_object('env', c.env, 'params',
          jsonb_build_object('location_id', c.location_id, 'sort_order', 'DESC', 'limit', '100')));
      update square_connect set last_sync = now() where owner_id = c.owner_id;
    end if;
    fired := fired + 1;
  end loop;

  -- A payout whose line items were never fetched: ask for them.
  for r in select p.owner_id, p.id, sc.token, sc.env from square_payouts p
             join square_connect sc on sc.owner_id = p.owner_id
            where p.entries_asked = false and sc.status <> 'bad_token' limit 10
  loop
    rid := net.http_get(url := square_base(r.env) || '/v2/payouts/' || r.id || '/payout-entries',
      params := jsonb_build_object('limit', '100'),
      headers := jsonb_build_object('Authorization', 'Bearer ' || r.token));
    insert into square_requests (id, owner_id, kind, meta)
      values (rid, r.owner_id, 'entries', jsonb_build_object('payout_id', r.id, 'params', jsonb_build_object('limit', '100')));
    update square_payouts set entries_asked = true where owner_id = r.owner_id and id = r.id;
  end loop;

  perform reconcile_square();
  return jsonb_build_object('took', took, 'fired', fired);
end $$;
revoke all on function public.square_tick() from public, anon, authenticated;

-- 6. A pretend sale at the sandbox table (Square's always-approves test
-- card), so the whole loop can be shown working without a real card. Only
-- ever fires at the sandbox.
create or replace function public.square_test_sale(amount_cents int, tip_cents int, owner uuid default null)
returns text language plpgsql volatile security definer set search_path = public as $$
declare c record; rid bigint; n int;
begin
  if owner is null then
    select count(*) into n from square_connect where env = 'sandbox' and location_id <> '';
    if n <> 1 then return n || ' sandbox connections; pass the owner'; end if;
  end if;
  select * into c from square_connect
   where env = 'sandbox' and location_id <> '' and (owner is null or owner_id = owner) limit 1;
  if not found then return 'no sandbox connection'; end if;
  rid := net.http_post(
    url := square_base('sandbox') || '/v2/payments',
    body := jsonb_build_object(
      'source_id', 'cnon:card-nonce-ok',
      'idempotency_key', gen_random_uuid()::text,
      'amount_money', jsonb_build_object('amount', amount_cents, 'currency', 'USD'),
      'tip_money', jsonb_build_object('amount', tip_cents, 'currency', 'USD'),
      'location_id', c.location_id,
      'autocomplete', true),
    headers := jsonb_build_object('Authorization', 'Bearer ' || c.token, 'Content-Type', 'application/json'));
  insert into square_requests (id, owner_id, kind) values (rid, c.owner_id, 'test_sale');
  return 'fired';
end $$;
revoke all on function public.square_test_sale(int, int, uuid) from public, anon, authenticated;

-- Every five minutes; square_tick does nothing when no one has connected.
do $do$
begin
  perform cron.unschedule('greenroom-square')
    where exists (select 1 from cron.job where jobname = 'greenroom-square');
  perform cron.schedule('greenroom-square', '*/5 * * * *', 'select public.square_tick()');
end $do$;

notify pgrst, 'reload schema';
