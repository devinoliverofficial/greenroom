-- A save sends only what changed. Until now the app wrote a tour's whole
-- document from the copy on the phone, so a phone holding an older copy (one
-- that sat in the background, or the other person editing the same tour)
-- silently put back what someone else had just changed: a projection set a
-- moment ago could vanish. Now the phone sends its change and the server
-- merges it into the tour as it is right now, one save at a time.

-- The app's own merge rule: two objects merge key by key, all the way down;
-- anything else (a number, text, a list, null) replaces what was there.
create or replace function public.jsonb_deep_merge(a jsonb, b jsonb)
returns jsonb
language plpgsql immutable as $$
declare k text; v jsonb; merged jsonb := a;
begin
  if jsonb_typeof(a) is distinct from 'object' or jsonb_typeof(b) is distinct from 'object' then
    return b;
  end if;
  for k, v in select * from jsonb_each(b) loop
    if jsonb_typeof(v) = 'object' and jsonb_typeof(merged -> k) = 'object' then
      merged := jsonb_set(merged, array[k], public.jsonb_deep_merge(merged -> k, v), true);
    else
      merged := jsonb_set(merged, array[k], v, true);
    end if;
  end loop;
  return merged;
end $$;
revoke all on function public.jsonb_deep_merge(jsonb, jsonb) from public, anon;
grant execute on function public.jsonb_deep_merge(jsonb, jsonb) to authenticated, service_role;

-- Merge a change into a tour and hand back the tour as it now stands. Runs as
-- the person saving, so who may edit (tours_update) and what only the creator
-- may change (tours_guard) are judged exactly as before. The row is locked for
-- the moment of the save, so two saves at once both land.
create or replace function public.patch_tour(t_id text, patch jsonb)
returns jsonb
language plpgsql volatile security invoker set search_path = public as $$
declare d jsonb;
begin
  if jsonb_typeof(patch) is distinct from 'object' then
    raise exception 'a change must be an object' using errcode = '22023';
  end if;
  update tours set doc = public.jsonb_deep_merge(doc, patch), updated_at = now()
   where id = t_id returning doc into d;
  if not found then raise exception 'permission' using errcode = '42501'; end if;
  return d;
end $$;
revoke all on function public.patch_tour(text, jsonb) from public, anon;
-- The server's own functions (the settlement inbox) may use it too.
grant execute on function public.patch_tour(text, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
