-- Undo a card charge logged by mistake: it comes off this tour's charges
-- (and its record in the import it came in with), and any "logged to another
-- tour" note for it goes too. The pile gets it back (the plaid function).
create or replace function public.unfile_charge(t_id text, k text)
returns void
language plpgsql security definer set search_path = public as $$
declare d jsonb; ch jsonb; imp text;
begin
  select doc into d from tours where id = t_id for update;
  if d is null then return; end if;
  ch := d -> 'charges' -> k;
  if ch is not null and jsonb_typeof(ch) = 'object' then
    imp := ch ->> 'importId';
    d := d #- array['charges', k];
    if imp is not null and jsonb_typeof(d -> 'imports' -> imp) = 'object' then
      d := jsonb_set(d, array['imports', imp, 'count'],
        to_jsonb(greatest(0, coalesce((d -> 'imports' -> imp ->> 'count')::int, 1) - 1)));
      d := jsonb_set(d, array['imports', imp, 'total'],
        to_jsonb(round((coalesce((d -> 'imports' -> imp ->> 'total')::numeric, 0) - coalesce((ch ->> 'amount')::numeric, 0)) * 100) / 100));
    end if;
  end if;
  d := d #- array['cardAway', k];
  update tours set doc = d, updated_at = now() where id = t_id;
end $$;
revoke all on function public.unfile_charge(text, text) from public, anon, authenticated;
grant execute on function public.unfile_charge(text, text) to service_role;
