-- The Spotify road for pictures (Devin, 2026-10-16: "lets set up the spotify
-- key for photos"). Three pages still have no picture because no free road
-- exists for them: their MusicBrainz entries name no Wikidata page and no
-- Wikipedia article leads with a portrait. Spotify holds a picture for
-- nearly every working artist; reaching it needs the two keys Devin makes
-- at developer.spotify.com, typed into Vault as 'spotify_id' and
-- 'spotify_secret' (the dashboard, never chat or code).
--
-- The walking is done by the images edge function (supabase/functions/
-- images/index.ts, deployed by Devin's paste), because Spotify's token door
-- only accepts a form-encoded body and pg_net cannot send one. This
-- migration gives it what it needs: the avatar rule learns Spotify's image
-- host, the queue learns to remember a page was tried there (so nobody is
-- asked about twice), the function gets its one careful door to the two
-- keys, and the hour's cron taps the function the way plaid's does. Until
-- the function is pasted the cron's tap answers not-found and nothing
-- happens; until the keys are in Vault the function answers off.

-- The avatar rule learns Spotify's image host. Everything else is 0162's.
alter table public.artists drop constraint if exists artists_avatar_len;
alter table public.artists add constraint artists_avatar_len
  check (char_length(avatar) <= 120000 and (avatar = '' or avatar like 'data:image/%'
    or avatar like 'https://upload.wikimedia.org/%' or avatar like 'https://commons.wikimedia.org/%'
    or avatar like 'https://thumb.wikimedia.org/%' or avatar like 'https://i.scdn.co/%'));

-- Asked at Spotify once and only once, whatever the answer.
alter table public.artist_image_queue add column if not exists sp_tried boolean not null default false;

-- The two keys, for the service role alone: the edge function calls this
-- with its service key; no phone can, and the keys never ride an answer to
-- anything else.
create or replace function public.spotify_keys()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', coalesce((select vs.decrypted_secret from vault.decrypted_secrets vs where vs.name = 'spotify_id' limit 1), ''),
    'secret', coalesce((select vs.decrypted_secret from vault.decrypted_secrets vs where vs.name = 'spotify_secret' limit 1), ''))
$$;
revoke all on function public.spotify_keys() from public, anon, authenticated;
grant execute on function public.spotify_keys() to service_role;

-- Every hour, the plaid pattern: the database taps the function with the
-- cron key. A function not yet pasted answers not-found, which costs
-- nothing and waits patiently.
do $$
begin
  perform cron.unschedule('greenroom-images')
    where exists (select 1 from cron.job where jobname = 'greenroom-images');
  perform cron.schedule('greenroom-images', '41 * * * *', $cron$
  select net.http_post(
    url := 'https://fcroypkwntqnnxrbzwbx.supabase.co/functions/v1/images',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_TzlzaK-oIm2YfWOa2lXNxA_0oBFKyQT', 'apikey', 'sb_publishable_TzlzaK-oIm2YfWOa2lXNxA_0oBFKyQT',
      'x-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'greenroom_cron_key')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
  $cron$);
end $$;

-- ============================== To roll back ==============================
--   perform cron.unschedule('greenroom-images');
--   drop function if exists public.spotify_keys();
--   alter table public.artist_image_queue drop column if exists sp_tried;
--   and put back 0162's artists_avatar_len (its text is in that file).
-- Pages that took a Spotify picture keep it unless the rule is narrowed;
-- narrow it only after clearing those avatars by hand.
