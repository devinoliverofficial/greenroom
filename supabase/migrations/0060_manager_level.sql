-- Three levels of access on a tour. Devin: "GA... All Access... and then
-- Manager, which is basically the people that are in charge with task
-- managing. These people have access to the card refresh button, these
-- people create the polls, these people have the New tasks button."
-- A Manager is All Access (members.role 'editor', so every All Access rule
-- and the server's 'editor' checks still hold) plus members.manager. Only
-- the tour's creator makes someone a Manager or stops them being one, and
-- All Access can't edit or remove a Manager.

alter table public.members add column if not exists manager boolean not null default false;

-- Today's tour managers (All Access with the Tour Manager title) are Managers.
update public.members m set manager = true
  from public.members x left join public.profiles p on p.user_id = x.user_id
 where m.tour_id = x.tour_id and m.invited_email = x.invited_email
   and x.role = 'editor'
   and lower(trim(coalesce(nullif(x.overrides ->> 'tourRole', ''), nullif(p.tour_role, ''), x.tour_role, ''))) = 'tour manager';

-- One row per person per tour, whatever the capitals in the address.
update public.members set invited_email = lower(invited_email) where invited_email <> lower(invited_email);
create unique index if not exists members_tour_email_once on public.members (tour_id, lower(invited_email));

-- A phone's own writes to members: it can't link an account (0055), a row
-- can't be moved to another tour or another address, and only the creator
-- sets Manager. A Manager always has All Access, and a Manager's row is the
-- creator's alone to change.
create or replace function public.members_user_locked()
returns trigger
language plpgsql set search_path = public as $$
declare creator boolean;
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      new.user_id := null;
      new.invited_email := lower(new.invited_email);
      creator := exists (select 1 from tours t where t.id = new.tour_id and t.owner_id = auth.uid());
      if not creator then new.manager := false; end if;
    else
      new.user_id := old.user_id;
      new.tour_id := old.tour_id;
      new.invited_email := old.invited_email;
      creator := exists (select 1 from tours t where t.id = old.tour_id and t.owner_id = auth.uid());
      if not creator then
        if old.manager and (new.role, new.manager, new.display_name, new.phone, new.tour_role, new.overrides)
            is distinct from (old.role, old.manager, old.display_name, old.phone, old.tour_role, old.overrides) then
          raise exception 'not_allowed' using errcode = '42501';
        end if;
        new.manager := old.manager;
      end if;
    end if;
  end if;
  if new.role <> 'editor' then new.manager := false; end if;
  return new;
end $$;

-- All Access can't take a Manager off the tour; the creator can.
create or replace function public.members_manager_stays()
returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user = 'authenticated' and old.manager
     and not exists (select 1 from tours t where t.id = old.tour_id and t.owner_id = auth.uid()) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return old;
end $$;
drop trigger if exists members_manager_stays on public.members;
create trigger members_manager_stays before delete on public.members
  for each row execute function public.members_manager_stays();

-- Editing someone on the crew: access is GA ('viewer'), All Access
-- ('editor') or Manager ('manager'). Managers are the creator's to make,
-- change and unmake.
create or replace function public.edit_member(t_id text, addr text, new_access text, ov jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  clean jsonb := '{}'::jsonb;
  k text;
  creator boolean;
  was_manager boolean;
  n int;
begin
  if coalesce(my_role(t_id), '') not in ('owner', 'editor') then raise exception 'not_allowed'; end if;
  if new_access is not null and new_access not in ('editor', 'viewer', 'manager') then raise exception 'bad_access'; end if;
  creator := exists (select 1 from tours where id = t_id and owner_id = auth.uid());
  select coalesce(bool_or(m.manager), false), count(*) into was_manager, n
    from members m where m.tour_id = t_id and lower(m.invited_email) = lower(addr);
  if n = 0 then raise exception 'not_found'; end if;
  if not creator and (was_manager or new_access = 'manager') then raise exception 'not_allowed'; end if;
  foreach k in array array['tourRole', 'phone', 'email'] loop
    if jsonb_typeof(ov -> k) = 'string' and length(trim(ov ->> k)) > 0 then
      clean := clean || jsonb_build_object(k, left(trim(ov ->> k), case when k = 'email' then 120 else 40 end));
    end if;
  end loop;
  update members
     set role = case when new_access is null then role when new_access = 'manager' then 'editor' else new_access end,
         manager = case when new_access is null then manager else new_access = 'manager' end,
         overrides = clean
   where tour_id = t_id and lower(invited_email) = lower(addr);
end $$;
revoke all on function public.edit_member(text, text, text, jsonb) from public, anon;
grant execute on function public.edit_member(text, text, text, jsonb) to authenticated;

create or replace function public.kick_member(t_id text, addr text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(my_role(t_id), '') not in ('owner', 'editor') then raise exception 'not_allowed'; end if;
  if not exists (select 1 from tours where id = t_id and owner_id = auth.uid())
     and exists (select 1 from members m where m.tour_id = t_id and lower(m.invited_email) = lower(addr) and m.manager) then
    raise exception 'not_allowed';
  end if;
  delete from members where tour_id = t_id and lower(invited_email) = lower(addr);
  if not found then raise exception 'not_found'; end if;
end $$;
revoke all on function public.kick_member(text, text) from public, anon;
grant execute on function public.kick_member(text, text) to authenticated;

-- The manager's powers in the database (polls, answering Ari): the creator,
-- or a Manager (on this tour; for a band's Off Tour book, on any of that
-- band's tours). The Tour Manager title no longer counts by itself, so
-- nobody becomes a manager by changing their own card.
create or replace function public.money_lead(t_id text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from tours where id = t_id and owner_id = auth.uid())
      or exists (
        select 1 from tours x
          join tours t on t.owner_id = x.owner_id
           and (t.id = x.id or (x.doc ->> 'kind' = 'offtour' and not (t.doc ? 'deletedAt')
             and lower(trim(coalesce(t.doc ->> 'artist', ''))) = lower(trim(coalesce(x.doc ->> 'artist', '')))))
          join members m on m.tour_id = t.id
         where x.id = t_id and m.user_id = auth.uid() and m.role = 'editor' and m.manager)
$$;

notify pgrst, 'reload schema';
