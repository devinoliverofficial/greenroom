-- Which crew member a charge was for (Devin, 2026-10-09: "When logging
-- expenses from the card if you hit crew a drop down menu should come up
-- where you can select which crew member").
--
-- A charge already carries the person as crewId when a payment is logged by
-- hand (the Payments sheet), and that is what a person's own pay page reads.
-- A card charge is filed by the bank feed, which keeps a fixed set of fields
-- and cannot be changed from here, so the person is said in a second step.
-- Done in the database rather than as a plain save from the phone, because a
-- plain save would create an empty charge under a key that is not there (the
-- charge was set aside, or sorted by someone else a moment earlier), and that
-- empty charge would show up as a payment to the person.
--
-- tags: { "<charge key>": "<crew id>" | null }. A tag lands only on a charge
-- that exists, is filed under Crew, and (when naming someone) for a person on
-- this tour's own list. null takes the person off. Runs as the caller: whoever
-- may edit the tour (its creator, or ALL ACCESS) may do this, nobody else.
-- keep: never over a different person already on the charge. The filing path
-- uses it: two phones can sort the same card charge, and the first one's pick
-- stands. Saying who afterwards ("Who") does not, since that is a correction.
create or replace function public.set_charge_crew(t_id text, tags jsonb, keep boolean default false)
returns jsonb
language plpgsql volatile security invoker set search_path = public as $$
declare k text; v jsonb; who text; n int := 0; hit int;
begin
  if auth.uid() is null then raise exception 'permission' using errcode = '42501'; end if;
  if jsonb_typeof(tags) is distinct from 'object' then raise exception 'which charges' using errcode = '22023'; end if;
  for k, v in select key, value from jsonb_each(tags)
  loop
    if jsonb_typeof(v) = 'string' then
      who := v #>> '{}';
      update tours
         set doc = jsonb_set(doc, array['charges', k, 'crewId'], to_jsonb(who)), updated_at = now()
       where id = t_id and (doc ->> 'deletedAt') is null
         and jsonb_typeof(doc -> 'charges' -> k) = 'object'
         and (doc -> 'charges' -> k ->> 'category') = 'crew'
         and jsonb_typeof(doc -> 'crew' -> who) = 'object'
         and (not keep or coalesce(doc -> 'charges' -> k ->> 'crewId', '') in ('', who));
    elsif jsonb_typeof(v) = 'null' then
      update tours
         set doc = jsonb_set(doc, array['charges', k], (doc -> 'charges' -> k) - 'crewId'), updated_at = now()
       where id = t_id and (doc ->> 'deletedAt') is null
         and jsonb_typeof(doc -> 'charges' -> k) = 'object';
    else
      continue;
    end if;
    get diagnostics hit = row_count;
    n := n + hit;
  end loop;
  return jsonb_build_object('ok', true, 'tagged', n, 'asked', (select count(*) from jsonb_object_keys(tags)));
end $$;
revoke all on function public.set_charge_crew(text, jsonb, boolean) from public, anon;
grant execute on function public.set_charge_crew(text, jsonb, boolean) to authenticated;

notify pgrst, 'reload schema';
