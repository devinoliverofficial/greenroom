-- MODEL6 SOCIAL: direct messages, one person to another.
--
-- A message is readable by the two people in it and nobody else. You can
-- write to anyone whose profile you're allowed to see (can_see_profile), and
-- only as yourself. Nothing is edited or deleted through the app yet; the
-- one change allowed is the reader marking what they've read (dm_read).
create table if not exists public.dms (
  id uuid primary key default gen_random_uuid(),
  sender uuid not null default auth.uid() references auth.users (id) on delete cascade,
  recipient uuid not null references auth.users (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint dms_not_self check (sender <> recipient),
  constraint dms_body_len check (char_length(btrim(body)) between 1 and 2000)
);
create index if not exists dms_recipient on public.dms (recipient, read_at);
create index if not exists dms_pair on public.dms (least(sender, recipient), greatest(sender, recipient), created_at);
alter table public.dms enable row level security;
drop policy if exists dms_select on public.dms;
create policy dms_select on public.dms for select using (sender = auth.uid() or recipient = auth.uid());
drop policy if exists dms_insert on public.dms;
create policy dms_insert on public.dms for insert
  with check (sender = auth.uid() and read_at is null and public.can_see_profile(recipient));

-- The reader has read everything this person sent them.
create or replace function public.dm_read(other uuid)
returns void
language sql security definer set search_path = public as $$
  update dms set read_at = now() where recipient = auth.uid() and sender = other and read_at is null
$$;
revoke all on function public.dm_read(uuid) from public, anon;
grant execute on function public.dm_read(uuid) to authenticated;

-- Your conversations: who, the latest line, when, and how many are unread.
create or replace function public.dm_threads()
returns jsonb
language sql stable security definer set search_path = public as $$
  with mine as (
    select case when d.sender = auth.uid() then d.recipient else d.sender end as other,
           d.body, d.created_at, d.sender, d.read_at
      from dms d where d.sender = auth.uid() or d.recipient = auth.uid()
  ), latest as (
    select distinct on (other) other, body, created_at, sender from mine order by other, created_at desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'userId', l.other,
      'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
      'handle', coalesce(p.handle, ''),
      'avatar', coalesce(p.avatar, ''),
      'verified', exists (select 1 from verified_users v where v.user_id = l.other),
      'last', left(l.body, 160),
      'at', l.created_at,
      'fromMe', l.sender = auth.uid(),
      'unread', (select count(*) from mine m where m.other = l.other and m.sender = l.other and m.read_at is null))
    order by l.created_at desc), '[]'::jsonb)
  from latest l left join profiles p on p.user_id = l.other
$$;
revoke all on function public.dm_threads() from public, anon;
grant execute on function public.dm_threads() to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.dms;
exception when duplicate_object then null; end $$;
