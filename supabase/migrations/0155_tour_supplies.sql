-- Tour supplies list (Devin, 2026-10-15): one shared list per tour, "clean and
-- easy". Anyone on the tour can add a line and tick it off; a line's words can
-- only be changed by whoever wrote it or a Manager, so the list stays honest.
-- No money and no amounts live here: it is a shopping list, nothing else.

create table if not exists public.tour_supplies (
  id bigint generated always as identity primary key,
  tour_id text not null references public.tours(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 120),
  added_by uuid not null,
  done_at timestamptz,
  done_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists tour_supplies_tour on public.tour_supplies (tour_id, done_at nulls first, created_at);

alter table public.tour_supplies enable row level security;

-- Who is on a tour: a one-arg door over the on_tour(t_id, u) test that
-- already lives in the database. The two-arg one takes ANY user id, so
-- granting it to phones would let anyone ask about anyone; this wrapper
-- answers only for the caller, and it alone is granted. Who is a Manager:
-- the creator, or a seat with role 'editor' and manager true (0133's test).
create or replace function public.on_tour_me(t_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.on_tour(t_id, auth.uid())
$$;
revoke all on function public.on_tour_me(text) from public, anon;
grant execute on function public.on_tour_me(text) to authenticated;
create or replace function public.manages_tour(t_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tours t where t.id = t_id and t.owner_id = auth.uid())
      or exists (select 1 from members m where m.tour_id = t_id and m.user_id = auth.uid()
                    and m.role = 'editor' and m.manager)
$$;
revoke all on function public.manages_tour(text) from public, anon;
grant execute on function public.manages_tour(text) to authenticated;

drop policy if exists tour_supplies_read on public.tour_supplies;
create policy tour_supplies_read on public.tour_supplies
  for select to authenticated using (public.on_tour_me(tour_id));

drop policy if exists tour_supplies_add on public.tour_supplies;
create policy tour_supplies_add on public.tour_supplies
  for insert to authenticated with check (public.on_tour_me(tour_id) and added_by = auth.uid());

drop policy if exists tour_supplies_change on public.tour_supplies;
create policy tour_supplies_change on public.tour_supplies
  for update to authenticated using (public.on_tour_me(tour_id)) with check (public.on_tour_me(tour_id));

drop policy if exists tour_supplies_drop on public.tour_supplies;
create policy tour_supplies_drop on public.tour_supplies
  for delete to authenticated using (added_by = auth.uid() or public.manages_tour(tour_id));

-- The update policy lets anyone on the tour tick a line; this keeps them from
-- quietly rewriting someone else's words or claiming someone else ticked it.
create or replace function public.tour_supplies_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.tour_id is distinct from old.tour_id or new.added_by is distinct from old.added_by
     or new.created_at is distinct from old.created_at then
    raise exception 'That part of a supply line cannot change.';
  end if;
  if new.body is distinct from old.body
     and not (old.added_by = auth.uid() or public.manages_tour(old.tour_id)) then
    raise exception 'Only whoever added a line, or a Manager, can change its words.';
  end if;
  if new.done_at is distinct from old.done_at then
    new.done_by := case when new.done_at is null then null else auth.uid() end;
  elsif new.done_by is distinct from old.done_by then
    -- the tick says who ticked; nobody re-pins it on someone else
    new.done_by := old.done_by;
  end if;
  return new;
end $$;
revoke all on function public.tour_supplies_guard() from public, anon, authenticated;
drop trigger if exists tour_supplies_guard on public.tour_supplies;
create trigger tour_supplies_guard before update on public.tour_supplies
  for each row execute function public.tour_supplies_guard();

-- A list, not a landfill: at most 200 open lines per tour.
create or replace function public.tour_supplies_cap()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from tour_supplies s where s.tour_id = new.tour_id and s.done_at is null) >= 200 then
    raise exception 'This tour''s supplies list is full. Tick things off or delete old lines first.';
  end if;
  return new;
end $$;
revoke all on function public.tour_supplies_cap() from public, anon, authenticated;
drop trigger if exists tour_supplies_cap on public.tour_supplies;
create trigger tour_supplies_cap before insert on public.tour_supplies
  for each row execute function public.tour_supplies_cap();

grant select, insert, update, delete on public.tour_supplies to authenticated;

notify pgrst, 'reload schema';

-- Rollback: drop trigger tour_supplies_guard on public.tour_supplies;
--           drop trigger tour_supplies_cap on public.tour_supplies;
--           drop function public.tour_supplies_guard(), public.tour_supplies_cap();
--           drop table public.tour_supplies;
--           (keep manages_tour only if nothing else has started using it;
--            on_tour(t_id, u) was here before this migration and stays)
