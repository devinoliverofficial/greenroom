-- Tour flyers (Devin, 2026-10-15): "when you click a tour and the dropdown
-- menu appears with all the tour dates, above the dates it can say 'view
-- flyer' where greenroom can automatically download and upload the flyer so
-- people can actually see the flyer." The automatic finding is a later
-- sourcing job; this gives it, and the page's owner today, somewhere to put
-- a flyer and a way for every phone to see it.
--
-- What the database holds:
--   1. A storage bucket, 'flyers'. The first bucket in the house: no other
--      migration touches storage. A flyer is promotional art, printed to be
--      stuck on walls, so the files are public to read; only whoever runs an
--      artist's page may put files under that artist's folder. The bucket
--      itself holds the lids (8 MB, images only), so no client can talk its
--      way past them.
--   2. artist_tour_flyers: one row per artist page and tour, saying where
--      that tour's flyer lives (its public address) and, when a sourcing job
--      found it, where it was found. The row's key is the tour group key the
--      pages already use for dropdowns, a name or a 'year:2009'.

-- 1. The bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('flyers', 'flyers', true, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

-- Who may write under flyers/<artist id>/...: whoever runs that artist's
-- page (runs_artist, 0052). The path's first folder is the artist's id; a
-- path that does not start with a well-formed uuid is nobody's, and the
-- shape is checked before the cast so a stray name never raises.
create or replace function public.writes_flyer_path(obj_name text)
returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when (storage.foldername(obj_name))[1]
         ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then public.runs_artist(((storage.foldername(obj_name))[1])::uuid)
    else false end
$$;
revoke all on function public.writes_flyer_path(text) from public, anon;
grant execute on function public.writes_flyer_path(text) to authenticated;

-- Anyone may read the bucket (it is public art; the public address works
-- without these rules, this lets the signed-in client read it too). Writes,
-- replacements and deletes only under a page the caller runs.
drop policy if exists flyers_read on storage.objects;
create policy flyers_read on storage.objects for select
  using (bucket_id = 'flyers');
drop policy if exists flyers_write on storage.objects;
create policy flyers_write on storage.objects for insert to authenticated
  with check (bucket_id = 'flyers' and public.writes_flyer_path(name));
drop policy if exists flyers_change on storage.objects;
create policy flyers_change on storage.objects for update to authenticated
  using (bucket_id = 'flyers' and public.writes_flyer_path(name))
  with check (bucket_id = 'flyers' and public.writes_flyer_path(name));
drop policy if exists flyers_drop on storage.objects;
create policy flyers_drop on storage.objects for delete to authenticated
  using (bucket_id = 'flyers' and public.writes_flyer_path(name));

-- 2. The table. A row holds ids, a tour's key and two web addresses,
-- nothing personal: no email, no token, no name of a person.
create table if not exists public.artist_tour_flyers (
  artist_id uuid not null references public.artists (id) on delete cascade,
  gk text not null check (char_length(gk) between 1 and 200),
  url text not null check (char_length(url) between 1 and 500),
  source_url text check (char_length(source_url) <= 500),
  added_by uuid,
  created_at timestamptz not null default now(),
  primary key (artist_id, gk)
);

alter table public.artist_tour_flyers enable row level security;

-- Who reads: anyone signed in, the same eyes the artist pages themselves
-- are open to (artists_select, 0052).
drop policy if exists artist_tour_flyers_read on public.artist_tour_flyers;
create policy artist_tour_flyers_read on public.artist_tour_flyers
  for select to authenticated using (auth.uid() is not null);

-- Who writes: whoever runs the page, and the row says who put it up.
drop policy if exists artist_tour_flyers_add on public.artist_tour_flyers;
create policy artist_tour_flyers_add on public.artist_tour_flyers
  for insert to authenticated
  with check (public.runs_artist(artist_id) and added_by = auth.uid());
drop policy if exists artist_tour_flyers_change on public.artist_tour_flyers;
create policy artist_tour_flyers_change on public.artist_tour_flyers
  for update to authenticated
  using (public.runs_artist(artist_id))
  with check (public.runs_artist(artist_id) and added_by = auth.uid());
drop policy if exists artist_tour_flyers_drop on public.artist_tour_flyers;
create policy artist_tour_flyers_drop on public.artist_tour_flyers
  for delete to authenticated using (public.runs_artist(artist_id));

-- Phones supply the key, the addresses and who; the time is the database's
-- own (no grant on created_at, so the default fills it).
revoke all on public.artist_tour_flyers from public, anon, authenticated;
grant select on public.artist_tour_flyers to authenticated;
grant insert (artist_id, gk, url, source_url, added_by) on public.artist_tour_flyers to authenticated;
grant update (url, source_url, added_by) on public.artist_tour_flyers to authenticated;
grant delete on public.artist_tour_flyers to authenticated;

-- One flyer per tour is the shape; 200 rows per page is the lid, so nobody
-- fills the table by inventing keys.
create or replace function public.artist_tour_flyers_cap()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from artist_tour_flyers f where f.artist_id = new.artist_id) >= 200 then
    raise exception 'This page already holds 200 flyers. Take one down first.';
  end if;
  return new;
end $$;
revoke all on function public.artist_tour_flyers_cap() from public, anon, authenticated;
drop trigger if exists artist_tour_flyers_cap on public.artist_tour_flyers;
create trigger artist_tour_flyers_cap before insert on public.artist_tour_flyers
  for each row execute function public.artist_tour_flyers_cap();

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop trigger if exists artist_tour_flyers_cap on public.artist_tour_flyers;
--   drop function if exists public.artist_tour_flyers_cap();
--   drop table if exists public.artist_tour_flyers;
--   drop policy if exists flyers_read on storage.objects;
--   drop policy if exists flyers_write on storage.objects;
--   drop policy if exists flyers_change on storage.objects;
--   drop policy if exists flyers_drop on storage.objects;
--   drop function if exists public.writes_flyer_path(text);
--   delete from storage.objects where bucket_id = 'flyers';
--   delete from storage.buckets where id = 'flyers';
--   notify pgrst, 'reload schema';
-- A phone on a build that shows flyers simply finds no table and draws
-- nothing; the files under flyers/ go with the bucket.
