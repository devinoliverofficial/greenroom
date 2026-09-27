-- The card feed's timer. Every three hours the database taps the ynab
-- function with the key Devin keeps in Vault (greenroom_cron_key). The
-- function asks the database whether the key matches; nobody reads it out.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function public.cron_key_ok(k text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(k, '') <> '' and exists (
    select 1 from vault.decrypted_secrets
     where name = 'greenroom_cron_key' and decrypted_secret = k)
$$;
revoke all on function public.cron_key_ok(text) from public, anon, authenticated;
grant execute on function public.cron_key_ok(text) to service_role;

-- The schedule itself (applied with the project's public anon key in place
-- of <anon key>; the gateway wants a signed token before the function runs):
-- select cron.schedule('greenroom-card-feed', '7 */3 * * *', $job$
--   select net.http_post(
--     url := 'https://fcroypkwntqnnxrbzwbx.supabase.co/functions/v1/ynab',
--     headers := jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer <anon key>', 'apikey', '<anon key>',
--       'x-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'greenroom_cron_key')),
--     body := '{"action":"sync"}'::jsonb, timeout_milliseconds := 60000)
-- $job$);
