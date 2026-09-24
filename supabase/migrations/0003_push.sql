-- One row per device that said yes to notifications, owned by its user.
-- prefs: {"guest":true,"green":true,"merch":5000,"soldout":true} — merch is
-- the dollar threshold, false/absent means opted out of that kind.

create table public.push_subs (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  prefs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.push_subs enable row level security;

create policy push_own_select on public.push_subs for select using (user_id = auth.uid());
create policy push_own_insert on public.push_subs for insert with check (user_id = auth.uid());
create policy push_own_update on public.push_subs for update using (user_id = auth.uid());
create policy push_own_delete on public.push_subs for delete using (user_id = auth.uid());
