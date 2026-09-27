-- Labels (artist folders, artist logos, the crew list, learned card
-- categories) now belong to the account that made them. They were one
-- shared memory for everyone signed in, so crew invited to one tour saw
-- every artist the tour manager had made, and anyone could read anyone's
-- card categories. The existing ones were all Devin's.
alter table public.labels add column if not exists owner_id uuid references auth.users (id) on delete cascade;
update public.labels
   set owner_id = (select id from auth.users where lower(email) = 'devinoliverofficial@gmail.com')
 where owner_id is null;
alter table public.labels alter column owner_id set default auth.uid();
alter table public.labels alter column owner_id set not null;
alter table public.labels drop constraint if exists labels_pkey;
alter table public.labels add primary key (owner_id, id);

drop policy if exists labels_select on public.labels;
drop policy if exists labels_write on public.labels;
drop policy if exists labels_update on public.labels;
drop policy if exists labels_delete on public.labels;
-- Your own labels; plus the logo of the artist on a tour you're on (key made
-- the way the app makes it), so that artist still wears its logo for you.
create policy labels_select on public.labels for select using (
  owner_id = auth.uid()
  or (id like 'alogo:%' and exists (
        select 1 from public.tours t join public.members m on m.tour_id = t.id
         where t.owner_id = labels.owner_id and m.user_id = auth.uid()
           and labels.id = 'alogo:' || left(trim(both '-' from
                 regexp_replace(lower(trim(coalesce(t.doc ->> 'artist', ''))), '[^a-z0-9]+', '-', 'g')), 40))));
create policy labels_insert on public.labels for insert with check (owner_id = auth.uid());
create policy labels_update on public.labels for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy labels_delete on public.labels for delete using (owner_id = auth.uid());
