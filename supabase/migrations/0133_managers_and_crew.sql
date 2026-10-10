-- Two levels on a tour: Manager and Crew (Devin, 2026-10-10): "I think managers
-- can do anything to a tour page. Members can do anything to an artists page
-- and a touring page." and "Oh shoot I forgot about the ALL ACCESS and GA part
-- of the app. Is there a way ... that makes the controls more streamlined and
-- not as confusing with all these different ways of assigning. Just want this
-- to be simple."
--
-- Until now a person on a tour was GA, ALL ACCESS, or ALL ACCESS with the
-- Manager mark: three levels, where the middle one could already see and edit
-- nearly everything a Manager can. Now there are two:
--   * Manager: sees and does anything on that tour (what ALL ACCESS + Manager was);
--   * Crew: the day sheets, guest list, stats, chat and their own pay (what GA was).
-- Stored as before (role 'editor' with manager = true, or role 'viewer'), so
-- every rule that reads those columns keeps working; what goes is the editor
-- who is not a Manager. One person was at that level (invited as "Artist", not
-- signed up yet): they are a Manager now.
--
-- Unchanged, to be decided with him: only the tour's creator names, changes or
-- removes a Manager, and only the creator deletes the tour or touches the bank
-- cards. A Manager who is not the creator invites Crew.

-- (no invite slips in between the backfill and the new rule)
lock table public.members in share row exclusive mode;

update public.members set manager = true where role = 'editor' and not manager;

create or replace function public.members_user_locked()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
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
    -- No level between the two. The creator's "editor" is a Manager (an older
    -- build of the app still says ALL ACCESS); anyone else's is Crew, because
    -- only the creator names a Manager.
    if new.role = 'editor' and not new.manager then
      if creator then new.manager := true; else new.role := 'viewer'; end if;
    end if;
  elsif new.role = 'editor' then
    -- (written by one of the database's own functions, which have made their own checks)
    new.manager := true;
  end if;
  if new.role <> 'editor' then new.manager := false; end if;
  return new;
end $function$;

-- Changing someone's level from the crew sheet: 'editor' (an older build's ALL
-- ACCESS) means Manager now, so it is the creator's to give, like 'manager'.
create or replace function public.edit_member(t_id text, addr text, new_access text, ov jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
  if not creator and (was_manager or new_access in ('manager', 'editor')) then raise exception 'not_allowed'; end if;
  foreach k in array array['tourRole', 'phone', 'email'] loop
    if jsonb_typeof(ov -> k) = 'string' and length(trim(ov ->> k)) > 0 then
      clean := clean || jsonb_build_object(k, left(trim(ov ->> k), case when k = 'email' then 120 else 40 end));
    end if;
  end loop;
  update members
     set role = case when new_access is null then role when new_access in ('manager', 'editor') then 'editor' else 'viewer' end,
         manager = case when new_access is null then manager else new_access in ('manager', 'editor') end,
         overrides = clean
   where tour_id = t_id and lower(invited_email) = lower(addr);
end $function$;

-- Notifications about the tour's money are for its Managers (Devin: "In the
-- green notifications and any notifications that are pertaining to the
-- managers should only be available to managers of the tour").
--
-- Who they are, for the server functions that send notifications (they run as
-- the service, so they cannot ask money_lead, which is about the caller). The
-- rule lives here so that it can change later (the artist's Members) without
-- pasting the functions again.
create or replace function public.tour_managers(t_id text)
 returns setof uuid
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select t.owner_id from tours t where t.id = t_id
  union
  select m.user_id from members m
   where m.tour_id = t_id and m.user_id is not null and m.role = 'editor' and m.manager
$function$;
revoke all on function public.tour_managers(text) from public, anon, authenticated;
grant execute on function public.tour_managers(text) to service_role;

-- Until those functions are pasted again, the one lever the database has: Ari
-- sends MERCH NUMBERS to every phone on the tour that has the switch on, and
-- the switch is kept per phone. So a phone keeps it on only if its owner is a
-- Manager wherever they are touring: creator or Manager of at least one tour,
-- and Crew on no tour that is still going (one somebody else made, with no
-- dates yet or its last date in the past two weeks or later). Someone who
-- manages one tour and crews another gets no merch numbers until the functions
-- ask per tour; the app tells them so when they try. TO DO after the paste:
-- drop push_subs_guard and members_push_recheck, the functions make them moot.
create or replace function public.push_merch_ok(u uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select u is not null
     and (exists (select 1 from tours t
                   where t.owner_id = u and (t.doc ->> 'deletedAt') is null and coalesce(t.doc ->> 'kind', '') <> 'offtour')
          or exists (select 1 from members m join tours t on t.id = m.tour_id
                      where m.user_id = u and m.role = 'editor' and m.manager and (t.doc ->> 'deletedAt') is null))
     and not exists (select 1 from members m join tours t on t.id = m.tour_id
                      where m.user_id = u and m.role = 'viewer' and t.owner_id <> u
                        and (t.doc ->> 'deletedAt') is null and coalesce(t.doc ->> 'kind', '') <> 'offtour'
                        and coalesce((select max(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x),
                                     '9999-12-31') >= to_char(current_date - 14, 'YYYY-MM-DD'))
$function$;
revoke all on function public.push_merch_ok(uuid) from public, anon, authenticated;

create or replace function public.push_subs_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if jsonb_typeof(new.prefs) = 'object' and new.prefs -> 'merchnums' = 'true'::jsonb
     and not public.push_merch_ok(new.user_id) then
    new.prefs := new.prefs || jsonb_build_object('merchnums', false);
  end if;
  return new;
end $function$;
revoke all on function public.push_subs_guard() from public, anon, authenticated;
drop trigger if exists push_subs_guard on public.push_subs;
create trigger push_subs_guard before insert or update on public.push_subs
  for each row execute function public.push_subs_guard();

-- Someone's level on a tour changes: their phones' switch is looked at again.
create or replace function public.members_push_recheck()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare u uuid;
begin
  if tg_op <> 'INSERT' and old.user_id is not null then
    update push_subs set prefs = prefs where user_id = old.user_id and prefs -> 'merchnums' = 'true'::jsonb;
  end if;
  if tg_op <> 'DELETE' and new.user_id is not null then
    u := new.user_id;
    if tg_op = 'INSERT' or u is distinct from old.user_id or new.role is distinct from old.role or new.manager is distinct from old.manager then
      update push_subs set prefs = prefs where user_id = u and prefs -> 'merchnums' = 'true'::jsonb;
    end if;
  end if;
  return null;
end $function$;
revoke all on function public.members_push_recheck() from public, anon, authenticated;
drop trigger if exists members_push_recheck on public.members;
create trigger members_push_recheck after insert or update or delete on public.members
  for each row execute function public.members_push_recheck();

-- (and once now, for the phones already signed up)
update public.push_subs set prefs = prefs where prefs -> 'merchnums' = 'true'::jsonb;

notify pgrst, 'reload schema';
