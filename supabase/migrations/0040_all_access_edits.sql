-- ALL ACCESS edits a tour like its creator does (Devin, 2026-09-30).
-- Still the creator's alone: deleting a tour, who owns it, which band it's
-- for, and the card logging dates (the bank side stays in the owner-only
-- feed tables). Inviting crew: the creator and the Tour Manager.
drop policy if exists tours_update on public.tours;
create policy tours_update on public.tours for update
  using (public.my_role(id) in ('owner', 'editor'))
  with check (public.my_role(id) in ('owner', 'editor'));

create or replace function public.tours_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- The server (no signed-in user) and the tour's creator change anything.
  if auth.uid() is null or auth.uid() = old.owner_id then return new; end if;
  if new.owner_id is distinct from old.owner_id then
    raise exception 'only the creator can hand a tour over' using errcode = '42501';
  end if;
  if (new.doc -> 'deletedAt') is distinct from (old.doc -> 'deletedAt') then
    raise exception 'only the creator can delete or restore a tour' using errcode = '42501';
  end if;
  if (new.doc ->> 'kind') is distinct from (old.doc ->> 'kind') or (new.doc ->> 'artist') is distinct from (old.doc ->> 'artist') then
    raise exception 'only the creator can move a tour to another band' using errcode = '42501';
  end if;
  if (new.doc -> 'cardLog') is distinct from (old.doc -> 'cardLog') then
    raise exception 'only the creator sets the card logging dates' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists tours_guard on public.tours;
create trigger tours_guard before update on public.tours for each row execute function public.tours_guard();

drop policy if exists members_insert on public.members;
create policy members_insert on public.members for insert with check (public.money_lead(tour_id));
drop policy if exists members_update on public.members;
create policy members_update on public.members for update
  using (public.money_lead(tour_id)) with check (public.money_lead(tour_id));
