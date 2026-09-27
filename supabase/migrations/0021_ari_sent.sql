-- What Ari has already announced, so a message goes out once: LOAD IN,
-- SHOW TIME and DAY SHEET AVAILABLE once per show; MERCH NUMBERS again
-- only when the night's number changes (value is the number last told).
-- Only the server reads or writes it.
create table if not exists public.ari_sent (
  tour_id text not null,
  show_id text not null,
  kind text not null,
  value numeric,
  sent_at timestamptz not null default now(),
  primary key (tour_id, show_id, kind)
);
alter table public.ari_sent enable row level security;

-- Merch already in the app counts as told, so the first run doesn't
-- announce every night of every tour at once.
insert into public.ari_sent (tour_id, show_id, kind, value)
select t.id, s.key, 'merch', (s.value -> 'income' ->> 'merch')::numeric
  from public.tours t, jsonb_each(coalesce(t.doc -> 'shows', '{}'::jsonb)) s
 where jsonb_typeof(s.value) = 'object'
   and (s.value -> 'income' ->> 'merch') ~ '^[0-9.]+$'
   and (s.value -> 'income' ->> 'merch')::numeric > 0
on conflict do nothing;

-- Ari's clock (applied with the project's public anon key in place of
-- <anon key>): every minute, the ari function checks every tour's day.
-- select cron.schedule('greenroom-ari', '* * * * *', $job$
--   select net.http_post(
--     url := 'https://fcroypkwntqnnxrbzwbx.supabase.co/functions/v1/ari',
--     headers := jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer <anon key>', 'apikey', '<anon key>',
--       'x-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'greenroom_cron_key')),
--     body := '{}'::jsonb, timeout_milliseconds := 30000)
-- $job$);
