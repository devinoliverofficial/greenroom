-- Saves that couldn't go, from people's phones: where it was and why (the
-- error, not the money or anything typed), so a "couldn't save that" can be
-- traced instead of guessed at. Each person can add their own; nobody reads
-- them through the app.
create table if not exists public.app_errors (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid(),
  place text not null default '',
  code text not null default '',
  detail text not null default '',
  offline boolean not null default false,
  ua text not null default '',
  at timestamptz not null default now(),
  received_at timestamptz not null default now()
);
alter table public.app_errors enable row level security;
drop policy if exists app_errors_insert on public.app_errors;
create policy app_errors_insert on public.app_errors for insert to authenticated
  with check (user_id = auth.uid() and length(place) <= 60 and length(code) <= 60 and length(detail) <= 200 and length(ua) <= 160);
