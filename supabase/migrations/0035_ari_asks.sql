-- Ari asks before she fixes. When a settlement says the band kept a
-- different number than the one logged for that night, Ari says so in the
-- chat and asks "Would you like me to correct this?" The tour manager
-- answers (a Yes under her message, or "yes" typed right back) and only
-- then does the number change. She fixes exactly what she asked about: if
-- that night's number moved in the meantime, she leaves it and says so.
-- Asks are written by the server (the mailbox); the tour manager and ALL
-- ACCESS see them, and only the tour manager answers.

create table if not exists public.ari_asks (
  id text primary key default gen_random_uuid()::text,
  tour_id text not null references public.tours (id) on delete cascade,
  note_id text,                          -- Ari's chat message that asks
  show_id text not null,
  place text not null default '',        -- "Worcester", for her answer
  was numeric not null,                  -- merch logged when she asked
  fix numeric not null,                  -- what the settlement says the band keeps
  patch jsonb not null default '{}'::jsonb, -- the rest of that night: merchCash, merchCardDeposit, received, settlementNotes
  status text not null default 'open' check (status in ('open', 'fixed', 'left', 'moved')),
  answered_by uuid,
  answered_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.ari_asks enable row level security;
drop policy if exists ari_asks_select on public.ari_asks;
create policy ari_asks_select on public.ari_asks for select
  using (public.my_role(tour_id) in ('owner', 'editor'));

create or replace function public.ari_money(v numeric)
returns text
language sql immutable as $$
  select '$' || case when v = trunc(v) then to_char(v, 'FM999,999,990') else to_char(v, 'FM999,999,990.00') end
$$;

-- The tour manager's answer. Yes applies the fix to that one night in one
-- locked step; no leaves it. Either way Ari says what happened in the chat.
create or replace function public.ari_answer(a_id text, yes boolean)
returns text
language plpgsql security definer set search_path = public as $$
declare
  a ari_asks;
  t tours;
  s jsonb;
  now_merch numeric;
  said text;
  outcome text;
begin
  select * into a from ari_asks where id = a_id for update;
  if not found then return 'gone'; end if;
  if public.my_role(a.tour_id) is distinct from 'owner' then
    raise exception 'only the tour manager answers Ari' using errcode = '42501';
  end if;
  if a.status <> 'open' then return a.status; end if;

  select * into t from tours where id = a.tour_id for update;
  s := t.doc -> 'shows' -> a.show_id;

  if not yes then
    outcome := 'left';
    said := 'Okay, leaving ' || a.place || ' at ' || ari_money(a.was) || '.';
  elsif s is null then
    outcome := 'moved';
    said := 'That ' || a.place || ' show isn''t on the tour anymore, so there was nothing to fix.';
  else
    now_merch := case when jsonb_typeof(s -> 'income' -> 'merch') = 'number'
      then round((s -> 'income' ->> 'merch')::numeric, 2) else 0 end;
    if now_merch <> round(a.was, 2) then
      outcome := 'moved';
      said := a.place || ' merch is ' || ari_money(now_merch) || ' now, not the ' || ari_money(a.was) ||
        ' I asked about, so I left it alone.';
    else
      outcome := 'fixed';
      s := jsonb_set(s, '{income}', coalesce(s -> 'income', '{}'::jsonb) || jsonb_build_object('merch', a.fix));
      if a.patch ? 'merchCash' then s := jsonb_set(s, '{merchCash}', a.patch -> 'merchCash'); end if;
      if a.patch ? 'merchCardDeposit' then s := jsonb_set(s, '{merchCardDeposit}', a.patch -> 'merchCardDeposit'); end if;
      if a.patch ? 'settlementNotes' then s := jsonb_set(s, '{settlementNotes}', a.patch -> 'settlementNotes'); end if;
      -- Money already marked as landed stays landed.
      if a.patch ? 'received' and coalesce(s ->> 'merchReceived', '') <> 'true' then
        s := jsonb_set(s, '{merchReceived}', a.patch -> 'received');
      end if;
      if not (s ? 'loggedAt') then
        s := jsonb_set(s, '{loggedAt}', to_jsonb((extract(epoch from now()) * 1000)::bigint));
      end if;
      update tours set doc = jsonb_set(doc, array['shows', a.show_id], s), updated_at = now() where id = a.tour_id;
      said := 'Done. ' || a.place || ' merch is now ' || ari_money(a.fix) || ' (it was ' || ari_money(a.was) || ').';
    end if;
  end if;

  update ari_asks set status = outcome, answered_by = auth.uid(), answered_at = now() where id = a.id;
  insert into notes (id, tour_id, day, body, author, added_by)
    values ('n' || replace(gen_random_uuid()::text, '-', ''), a.tour_id, 'chat', said, 'Ari', t.owner_id);
  return outcome;
end $$;
revoke all on function public.ari_answer(text, boolean) from public, anon;
grant execute on function public.ari_answer(text, boolean) to authenticated;

do $$ begin alter publication supabase_realtime add table public.ari_asks;
exception when duplicate_object then null; end $$;
