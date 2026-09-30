-- The Overview's crew: the tour manager and ALL ACCESS can edit someone
-- (their role on the tour, their contact info, their access) or kick them
-- off the tour. Both go through these two functions, which check who's
-- asking and touch only those things; the members table's own rules stay
-- tour-manager-only for everything else (inviting, the login email).
--
-- overrides: what an edit set, shown over the person's own card
-- ({tourRole, phone, email}); their login email never changes here.
alter table public.members add column if not exists overrides jsonb not null default '{}'::jsonb;

create or replace function public.edit_member(t_id text, addr text, new_access text, ov jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  clean jsonb := '{}'::jsonb;
  k text;
begin
  if coalesce(my_role(t_id), '') not in ('owner', 'editor') then raise exception 'not_allowed'; end if;
  if new_access is not null and new_access not in ('editor', 'viewer') then raise exception 'bad_access'; end if;
  foreach k in array array['tourRole', 'phone', 'email'] loop
    if jsonb_typeof(ov -> k) = 'string' and length(trim(ov ->> k)) > 0 then
      clean := clean || jsonb_build_object(k, left(trim(ov ->> k), case when k = 'email' then 120 else 40 end));
    end if;
  end loop;
  update members
     set role = coalesce(new_access, role), overrides = clean
   where tour_id = t_id and lower(invited_email) = lower(addr);
  if not found then raise exception 'not_found'; end if;
end $$;
revoke all on function public.edit_member(text, text, text, jsonb) from public, anon;
grant execute on function public.edit_member(text, text, text, jsonb) to authenticated;

create or replace function public.kick_member(t_id text, addr text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(my_role(t_id), '') not in ('owner', 'editor') then raise exception 'not_allowed'; end if;
  delete from members where tour_id = t_id and lower(invited_email) = lower(addr);
  if not found then raise exception 'not_found'; end if;
end $$;
revoke all on function public.kick_member(text, text) from public, anon;
grant execute on function public.kick_member(text, text) to authenticated;
