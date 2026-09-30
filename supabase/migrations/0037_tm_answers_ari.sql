-- The tour manager answers Ari too. "Money lead" = the tour's owner, or a
-- member with ALL ACCESS whose tour role is Tour Manager (the same people
-- who refresh and sort the card charges). Either one can say yes or no to
-- "Would you like me to correct this?".
create or replace function public.money_lead(t_id text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from tours where id = t_id and owner_id = auth.uid())
      or exists (
        select 1 from members m left join profiles p on p.user_id = m.user_id
         where m.tour_id = t_id and m.user_id = auth.uid() and m.role = 'editor'
           and lower(trim(coalesce(nullif(m.overrides ->> 'tourRole', ''), nullif(p.tour_role, ''), m.tour_role, ''))) = 'tour manager')
$$;
revoke all on function public.money_lead(text) from public, anon;
grant execute on function public.money_lead(text) to authenticated;

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
  if not public.money_lead(a.tour_id) then
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
