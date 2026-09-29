-- GA crew see the tour, never its money, and the database enforces it.
--
-- Until now every member's phone received the whole tour row (budget, show
-- income, expenses, card charges) and the app only hid the money from GA.
-- Now the full tour row is readable by the tour manager and ALL ACCESS only.
-- GA crew read tour_public: a copy the database keeps itself, holding only
-- what GA use (the run, the shows' dates, cities, venues and day sheets, off
-- days and day notes). It's built from an allowlist, so anything added to a
-- tour later stays out of GA's copy unless it's named here.

create or replace function public.tour_for_ga(d jsonb)
returns jsonb
language sql immutable set search_path = public as $$
  with doc as (select case when jsonb_typeof(d) = 'object' then d else '{}'::jsonb end as d),
  shows as (
    select case when jsonb_typeof(doc.d -> 'shows') = 'object' then doc.d -> 'shows' else '{}'::jsonb end as s from doc
  )
  select coalesce((
    select jsonb_object_agg(k, v) from doc, jsonb_each(doc.d) e(k, v)
    where k = any (array['artist', 'bands', 'createdAt', 'deletedAt', 'name', 'ourBand', 'rehearsalStart',
      'rehearsalEnd', 'setupDone', 'setupStep', 'spanStart', 'spanEnd', 'offDays', 'dayNotes', 'updateSentOn'])
  ), '{}'::jsonb)
  || jsonb_build_object('shows', coalesce((
    select jsonb_object_agg(sid, (
      select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
      from jsonb_each(case when jsonb_typeof(sv) = 'object' then sv else '{}'::jsonb end) f(k, v)
      where k = any (array['id', 'date', 'city', 'venue', 'createdAt', 'daySheet', 'soldOut'])
    ))
    from shows, jsonb_each(shows.s) g(sid, sv)
  ), '{}'::jsonb))
$$;

create table if not exists public.tour_public (
  id text primary key references public.tours (id) on delete cascade,
  owner_id uuid not null,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.tour_public enable row level security;
drop policy if exists tour_public_select on public.tour_public;
create policy tour_public_select on public.tour_public for select using (public.my_role(id) = 'viewer');

-- Kept in step with every change to a tour. A change to money alone leaves
-- GA's copy (and their phones) untouched.
create or replace function public.tour_public_sync()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into tour_public (id, owner_id, doc, updated_at)
  values (new.id, new.owner_id, tour_for_ga(new.doc), now())
  on conflict (id) do update set owner_id = excluded.owner_id, doc = excluded.doc, updated_at = excluded.updated_at
  where tour_public.doc is distinct from excluded.doc or tour_public.owner_id is distinct from excluded.owner_id;
  return new;
end $$;
drop trigger if exists tour_public_sync on public.tours;
create trigger tour_public_sync after insert or update of doc, owner_id on public.tours
  for each row execute function public.tour_public_sync();

insert into public.tour_public (id, owner_id, doc)
select id, owner_id, public.tour_for_ga(doc) from public.tours
on conflict (id) do update set owner_id = excluded.owner_id, doc = excluded.doc, updated_at = now();

-- The full tour: the tour manager and ALL ACCESS only.
drop policy if exists tours_select on public.tours;
create policy tours_select on public.tours for select
  using (owner_id = auth.uid() or public.my_role(id) in ('owner', 'editor'));

do $$ begin
  alter publication supabase_realtime add table public.tour_public;
exception when duplicate_object then null; end $$;
