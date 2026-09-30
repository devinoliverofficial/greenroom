-- A card charge shows the day it was made (the bank's authorized date), not
-- the day it posted. The posted day is kept too, as "posted": it decides
-- whether a charge was already inside a card's balance on the day logging
-- started (the bank's balance only counts posted charges).
alter table public.feed_items add column if not exists posted date;

-- Bring charges already on a tour into line: only their dates change.
-- fixes = { "<charge id>": { "date": "YYYY-MM-DD", "posted": "YYYY-MM-DD" } }. Server only.
create or replace function public.set_charge_dates(t_id text, fixes jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare k text; v jsonb; d jsonb;
begin
  select doc into d from tours where id = t_id for update;
  if d is null then return; end if;
  for k, v in select * from jsonb_each(fixes) loop
    if (d -> 'charges') ? k then
      d := jsonb_set(d, array['charges', k, 'date'], v -> 'date');
      d := jsonb_set(d, array['charges', k, 'posted'], v -> 'posted');
    end if;
  end loop;
  update tours set doc = d, updated_at = now() where id = t_id;
end $$;
revoke all on function public.set_charge_dates(text, jsonb) from public, anon, authenticated;
grant execute on function public.set_charge_dates(text, jsonb) to service_role;
