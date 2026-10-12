-- "Other", when saying what a deposit was (asked for on 2026-10-11):
--   "there should be an 'other' tab in 'what was it for?' categories"
--
-- Until now a bank deposit could be logged as Merch, Guarantee, Royalties or
-- Advance. A fifth answer, 'other', is for a deposit that is none of the four
-- (a sync licence, a refund from a venue, the tip jar), with a short line
-- where he says what it was.
--
-- One function changes, catalog_income, and in these ways only:
--  1. It accepts kind 'other'. That is the book's own money, exactly as
--     'royalties' and 'advance' are: an entry in doc.otherIncome under the
--     deposit's id, the deposit marked matched, on a tour and on the Off Tour
--     book alike. The same approval (0123), the same two locks, and the same
--     "a retried tap cannot write it twice" as every other answer.
--  2. It takes a fifth argument, note (text, null when not sent): what he
--     typed. For 'other' it is kept on the entry as "label", cleaned (runs of
--     blanks to one space, trimmed, 60 characters at most). Nothing typed, no
--     label key. For every other kind the note is not read.
--  3. A show id sent with 'other' is not used: the money goes on the book,
--     and no show is touched. (For royalties, an advance and the two "sort
--     later" answers a show id is still refused, as before.)
-- Everything else in the function is 0127's text, word for word.
--
-- Phones on the older build keep working: they call with the four arguments
-- by name, and that call now reaches this function, because the fifth has a
-- default. For that to be so there must be only one catalog_income, so the
-- four-argument one is dropped here, in the same file. Send the whole file at
-- once, as every migration is sent: it is one transaction, and at no moment
-- is there no catalog_income.
--
-- Not changed, and checked: catalog_income_split (0124) and
-- catalog_merch_split (0127) put ONE deposit over several nights. Neither
-- takes a kind at all: the first files guarantees only, the second merch
-- only, each through its own rule that requires that money to be logged on
-- every night named. There is no way to send 'other' through either.
-- sort_guarantee and unpark_guarantee (0125) act only on an entry flagged
-- "unsorted", which an 'other' entry never is.
--
-- Nothing here logs anything by itself: an entry is written only when the
-- person whose bank it is says what the deposit was and taps Log.

drop function if exists public.catalog_income(text, text, text, text);

create or replace function public.catalog_income(dep_id text, t_id text, s_id text, kind text, note text default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  d record; tour record; entry jsonb; took boolean; said text;
begin
  if me is null then raise exception 'permission' using errcode = '42501'; end if;
  -- The owner is saying what this deposit was: that is the approval.
  perform set_config('greenroom.deposit_approved', '1', true);
  if kind is null or kind not in ('merch', 'merch_later', 'guarantee', 'guarantee_later', 'royalties', 'advance', 'other', 'skip') then
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

  -- ('other' is never one night's money. A show id sent with it is not used:
  --  the deposit is the book's own money, below, and no show is touched.)
  if s_id is not null and kind <> 'other' then
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
  -- 'other': a deposit that is none of the four. It is the book's own money
  -- exactly as royalties and an advance are; what he typed for it ("Sync
  -- licence") is kept beside it as its label: runs of blanks made one space,
  -- trimmed, 60 characters at most. Nothing typed, no label. The note is not
  -- read for any other kind.
  if kind = 'other' then
    said := nullif(btrim(left(btrim(regexp_replace(coalesce(note, ''), '[[:space:]]+', ' ', 'g')), 60)), '');
  end if;
  entry := jsonb_build_object(
    'date', to_char(d.date, 'YYYY-MM-DD'),
    'amount', d.amount,
    'kind', case when kind = 'guarantee_later' then 'guarantee' else kind end,
    'at', (extract(epoch from now()) * 1000)::bigint)
    || case when kind = 'guarantee_later' then jsonb_build_object('unsorted', true) else '{}'::jsonb end
    || case when said is not null then jsonb_build_object('label', said) else '{}'::jsonb end;
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
revoke all on function public.catalog_income(text, text, text, text, text) from public, anon;
grant execute on function public.catalog_income(text, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';

-- To roll back: drop the five-argument function, then run catalog_income
-- again exactly as 0127_merch_deposits_like_guarantees.sql has it (the
-- "create or replace function public.catalog_income(dep_id text, t_id text,
-- s_id text, kind text)" statement and the revoke and the grant under it),
-- and reload the schema. In one go:
--   drop function if exists public.catalog_income(text, text, text, text, text);
--   <the three statements from 0127>
--   notify pgrst, 'reload schema';
-- Entries already logged as 'other' stay on their books and still count as
-- income (an app from before this change calls each one "Income"). After a
-- roll back a phone on the new build is refused when it sends 'other' ("what
-- kind"), and the deposit keeps waiting in New income: nothing is lost.
