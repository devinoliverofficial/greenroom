-- MY PAY (Devin, 2026-10-07): "when you click the budgets tab ... the 'Tour
-- Name' tab ... and then to the right of that evenly ... 'MY PAY' which when
-- you click it you get the same exact layout as the tour expense tab but it
-- is more for people trying to manage their pay and expenses as a crew
-- member." Everyone on a tour can open it; what stays hidden from GA is the
-- tour's own information, never the tab.

-- 1. Your slice of the tour's money: the crew row that is you (matched by the
-- email the tour manager typed on it, else by your name), what's been logged
-- as paid to you, and the dates the pay plan runs over. Nothing else from the
-- budget leaves the row: a GA member sees only their own line.
create or replace function public.my_pay(t_id text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); my_email text := ''; inv_email text := ''; nm text := ''; d jsonb; cid text; c jsonb; e record; n int;
begin
  if me is null or public.my_role(t_id) is null then raise exception 'permission' using errcode = '42501'; end if;
  select coalesce(lower(u.email), '') into my_email from auth.users u where u.id = me;
  -- The name the TOUR MANAGER typed on the invite — never one the member typed
  -- for themselves, or a GA member could rename their profile after a
  -- colleague and read their pay.
  select coalesce(m.display_name, ''), coalesce(lower(m.invited_email), '') into nm, inv_email
    from members m where m.tour_id = t_id and m.user_id = me;
  select t.doc into d from tours t where t.id = t_id;
  if d is null then raise exception 'not found' using errcode = 'P0002'; end if;
  -- The email wins (the one you sign in with, or the one you were invited at).
  for e in select k, v from jsonb_each(case when jsonb_typeof(d -> 'crew') = 'object' then d -> 'crew' else '{}'::jsonb end) x(k, v)
            where jsonb_typeof(x.v) = 'object'
  loop
    if lower(btrim(coalesce(e.v ->> 'email', ''))) <> ''
       and lower(btrim(coalesce(e.v ->> 'email', ''))) in (my_email, inv_email) then cid := e.k; c := e.v; exit; end if;
  end loop;
  -- Else the manager's name for you, when exactly one crew row carries it and that row has no email of its own.
  if cid is null and btrim(nm) <> '' then
    select count(*) into n from jsonb_each(case when jsonb_typeof(d -> 'crew') = 'object' then d -> 'crew' else '{}'::jsonb end) x(k, v)
     where jsonb_typeof(x.v) = 'object' and lower(btrim(coalesce(x.v ->> 'name', ''))) = lower(btrim(nm))
       and btrim(coalesce(x.v ->> 'email', '')) = '';
    if n = 1 then
      select x.k, x.v into cid, c from jsonb_each(d -> 'crew') x(k, v)
       where jsonb_typeof(x.v) = 'object' and lower(btrim(coalesce(x.v ->> 'name', ''))) = lower(btrim(nm))
         and btrim(coalesce(x.v ->> 'email', '')) = '' limit 1;
    end if;
  end if;
  return jsonb_build_object(
    'crew', case when cid is null then null else jsonb_build_object('id', cid, 'name', c ->> 'name', 'title', c ->> 'title',
              'pay', c -> 'pay', 'rate', c -> 'rate', 'per', c ->> 'per', 'payTyped', c -> 'payTyped') end,
    'payments', case when cid is null then '[]'::jsonb else coalesce((
      select jsonb_agg(p order by p ->> 'date' desc) from (
        select jsonb_build_object('id', x.k, 'date', coalesce(x.v ->> 'date', ''), 'amount', x.v -> 'amount',
                 'how', case when (x.v ->> 'cash')::boolean then 'Cash' when (x.v ->> 'paid')::boolean then 'Debit' else 'Credit' end,
                 'label', coalesce(x.v ->> 'merchant', 'Pay')) as p
          from jsonb_each(case when jsonb_typeof(d -> 'charges') = 'object' then d -> 'charges' else '{}'::jsonb end) x(k, v)
         where jsonb_typeof(x.v) = 'object' and x.v ->> 'crewId' = cid and coalesce((x.v ->> 'accounted')::boolean, false) = false
        union all
        select jsonb_build_object('id', x.k, 'date', coalesce(x.v ->> 'date', ''), 'amount', x.v -> 'amount',
                 'how', 'Cash · merch cash', 'label', coalesce(x.v ->> 'label', 'Pay'))
          from jsonb_each(case when jsonb_typeof(d -> 'cashLog') = 'object' then d -> 'cashLog' else '{}'::jsonb end) x(k, v)
         where jsonb_typeof(x.v) = 'object' and x.v ->> 'crewId' = cid) q), '[]'::jsonb) end,
    'tour', jsonb_build_object('spanStart', d ->> 'spanStart', 'spanEnd', d ->> 'spanEnd', 'rehearsalStart', d ->> 'rehearsalStart',
      'first', (select min(s.v ->> 'date') from jsonb_each(case when jsonb_typeof(d -> 'shows') = 'object' then d -> 'shows' else '{}'::jsonb end) s(k, v)
                 where jsonb_typeof(s.v) = 'object' and (s.v ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'),
      'last', (select max(s.v ->> 'date') from jsonb_each(case when jsonb_typeof(d -> 'shows') = 'object' then d -> 'shows' else '{}'::jsonb end) s(k, v)
                 where jsonb_typeof(s.v) = 'object' and (s.v ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$')));
end $$;
revoke all on function public.my_pay(text) from public, anon;
grant execute on function public.my_pay(text) to authenticated;

-- 2. Your own book for a tour: what you spent, by category, and what you
-- meant to. Yours alone — not even the tour manager reads it.
create table if not exists public.my_pay_books (
  tour_id text not null references public.tours (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tour_id, user_id),
  -- A book, not a dump: an object, and a small one.
  constraint my_pay_books_doc_small check (jsonb_typeof(doc) = 'object' and pg_column_size(doc) <= 65536)
);
alter table public.my_pay_books enable row level security;
revoke all on public.my_pay_books from public, anon, authenticated;
grant select, insert, update, delete on public.my_pay_books to authenticated;
drop policy if exists my_pay_books_own on public.my_pay_books;
create policy my_pay_books_own on public.my_pay_books
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.my_role(tour_id) is not null);

-- Deleting your account takes the book with it (the table is new, so the
-- account function learns about it here).
create or replace function public.delete_my_account()
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me uuid := auth.uid(); n int;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  select count(*) into n from tours where owner_id = me and (doc ->> 'deletedAt') is null;
  if n > 0 then return jsonb_build_object('ok', false, 'why', 'tours', 'n', n); end if;
  select count(*) into n from artists where owner_id = me;
  if n > 0 then return jsonb_build_object('ok', false, 'why', 'artists', 'n', n); end if;
  delete from my_pay_books where user_id = me;
  delete from tours where owner_id = me;
  delete from tour_public where owner_id = me;
  delete from members where user_id = me;
  delete from flowers where from_id = me or to_id = me;
  delete from dms where sender = me or recipient = me;
  delete from follows where follower_id = me or followee_id = me;
  delete from artist_follows where user_id = me;
  delete from artist_members where user_id = me;
  delete from artist_endorsements where user_id = me;
  delete from artist_claims where user_id = me;
  delete from tour_credits where user_id = me;
  delete from day_votes where user_id = me;
  delete from game_ball_votes where voter = me;
  delete from push_subs where user_id = me;
  delete from app_errors where user_id = me;
  delete from labels where owner_id = me;
  delete from past_crew where owner_id = me;
  delete from feed_items where owner_id = me;
  delete from feed where owner_id = me;
  delete from plaid_items where owner_id = me;
  delete from plaid_pending where owner_id = me;
  delete from merch_deposits where owner_id = me;
  delete from merch_reports where owner_id = me;
  delete from square_payout_entries where owner_id = me;
  delete from square_payouts where owner_id = me;
  delete from square_payments where owner_id = me;
  delete from square_requests where owner_id = me;
  delete from square_connect where owner_id = me;
  delete from setlist_requests where owner_id = me;
  delete from setlist_connect where owner_id = me;
  delete from setlist_user_day where user_id = me;
  delete from signup_allowances where created_by = me;
  delete from platform_admins where user_id = me;
  delete from verified_users where user_id = me;
  delete from profiles where user_id = me;
  delete from auth.users where id = me;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

notify pgrst, 'reload schema';
