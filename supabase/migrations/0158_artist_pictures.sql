-- Artist pictures for bare pages. A page nobody runs yet opens with a grey
-- letter where a face should be. The research settled the open road to a real
-- picture: the page's MusicBrainz id names its Wikidata entry, Wikidata's
-- P18 names a picture on Wikimedia Commons, and Commons says the picture's
-- author and licence - which are kept and SHOWN, because those licences ask
-- to be named.
--
-- Only unclaimed bare pages are touched: a page with an owner, or with any
-- picture already on it, is never written to, and an owner's own upload
-- always wins - the worker skips any artist whose avatar is no longer empty,
-- and a hand-picked picture clears the credit (the trigger below).
--
-- The worker is a queue the 0106 wayback shape: one step per row per run,
-- request ids kept on the row, answers read from net._http_response, tries
-- capped, scheduled by cron the way 0066's reconciler scheduled itself.
-- Phones never touch the queue; what they see rides artist_card.

-- ---------------------------------------------------------------------------
-- 1. The artists table learns to carry a credited picture
-- ---------------------------------------------------------------------------
-- The credit under the picture, "Photo: <author> - <licence>". Empty for
-- every picture an owner picked themselves.
alter table public.artists add column if not exists avatar_credit text not null default ''
  check (char_length(avatar_credit) <= 200);

-- An avatar has always been a data: address an owner uploaded. A credited
-- picture is a Wikimedia address instead, so the check learns those two
-- hosts and nothing else; owners' uploads stay data: addresses as before.
alter table public.artists drop constraint if exists artists_avatar_len;
alter table public.artists add constraint artists_avatar_len
  check (char_length(avatar) <= 120000 and (avatar = '' or avatar like 'data:image/%'
    or avatar like 'https://upload.wikimedia.org/%' or avatar like 'https://commons.wikimedia.org/%'));

-- A phone never writes the credit itself (the app has no field for it, and a
-- typed credit would be a lie under the picture): whatever a phone's write
-- says, the credit holds - and when the picture itself is changed by hand,
-- the old picture's credit goes with it. The worker runs with no signed-in
-- account and writes picture and credit together, so its writes pass whole.
create or replace function public.artist_avatar_credit_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    new.avatar_credit := old.avatar_credit;
    if new.avatar is distinct from old.avatar then
      new.avatar_credit := '';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.artist_avatar_credit_guard() from public, anon, authenticated;

drop trigger if exists artists_avatar_credit on public.artists;
create trigger artists_avatar_credit before update on public.artists
  for each row execute function public.artist_avatar_credit_guard();

-- ---------------------------------------------------------------------------
-- 2. The queue: one row per bare page, walked three asks to a picture
-- ---------------------------------------------------------------------------
-- state: queued (nothing asked yet) -> mb (MusicBrainz asked) -> wd (Wikidata
-- asked) -> commons (Commons asked) -> done (picture on the page) or none
-- (no picture to be had, or five tries spent). req is the in-flight request.
create table if not exists public.artist_image_queue (
  artist_id uuid primary key references public.artists (id) on delete cascade,
  state text not null default 'queued' check (state in ('queued', 'mb', 'wd', 'commons', 'done', 'none')),
  req bigint,
  wd text not null default '' check (char_length(wd) <= 40),
  image text not null default '' check (char_length(image) <= 400),
  licence text not null default '' check (char_length(licence) <= 120),
  author text not null default '' check (char_length(author) <= 160),
  source_url text not null default '' check (char_length(source_url) <= 500),
  tries int not null default 0 check (tries between 0 and 10),
  updated_at timestamptz not null default now()
);
create index if not exists artist_image_queue_state on public.artist_image_queue (state, updated_at);
alter table public.artist_image_queue enable row level security;
-- Nothing in a row is a secret, but no phone has business here either: what
-- a page shows (the credit, the source link) rides artist_card below.
revoke all on public.artist_image_queue from public, anon, authenticated;

-- Seed it: every page nobody runs, with no picture and a MusicBrainz id.
insert into public.artist_image_queue (artist_id)
select a.id from public.artists a
 where a.owner_id is null and coalesce(a.avatar, '') = '' and coalesce(a.mbid, '') <> ''
on conflict (artist_id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. The worker: 25 rows a run, one step each, polite to every service
-- ---------------------------------------------------------------------------
create or replace function public.artist_images_step()
returns int
language plpgsql volatile security definer set search_path = public as $$
declare r record; rid bigint; n int := 0; resp record; body jsonb; wd_id text; fn text;
        ii jsonb; thumb text; page text; lic text; aut text;
        ua constant text := 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/)';
begin
  -- Pages born bare since the last run join the queue by themselves.
  insert into artist_image_queue (artist_id)
  select a.id from artists a
   where a.owner_id is null and coalesce(a.avatar, '') = '' and coalesce(a.mbid, '') <> ''
     and not exists (select 1 from artist_image_queue q where q.artist_id = a.id)
   limit 50
  on conflict (artist_id) do nothing;

  for r in select q.*, a.mbid as a_mbid, a.avatar as a_avatar, a.owner_id as a_owner
             from artist_image_queue q join artists a on a.id = q.artist_id
            where q.state in ('queued', 'mb', 'wd', 'commons')
            order by q.updated_at
            limit 25
            for update of q skip locked
  loop
   begin
    -- Only unclaimed bare pages: claimed since, or given any picture (an
    -- owner's upload always wins), and this row's work is over for good.
    if r.a_owner is not null or coalesce(r.a_avatar, '') <> '' then
      update artist_image_queue set state = 'none', updated_at = now() where artist_id = r.artist_id;
      continue;
    end if;

    -- Step one's ask: MusicBrainz, who the page is, where it lives online.
    -- MusicBrainz wants one ask a second across the whole house, so the same
    -- pace gate every other MusicBrainz reader uses decides; a row that must
    -- wait simply stays queued for the next run.
    if r.state = 'queued' then
      if coalesce(r.a_mbid, '') = '' then
        update artist_image_queue set state = 'none', updated_at = now() where artist_id = r.artist_id;
      elsif n < 10 and public.setlist_pace_ok('mb', interval '1100 milliseconds') then
        rid := net.http_get(url := 'https://musicbrainz.org/ws/2/artist/' || r.a_mbid,
          params := jsonb_build_object('inc', 'url-rels', 'fmt', 'json'),
          headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'),
          timeout_milliseconds := 15000);
        update artist_image_queue set state = 'mb', req = rid, updated_at = now() where artist_id = r.artist_id;
        n := n + 1;
      end if;
      continue;
    end if;

    -- A step waiting on its answer.
    select x.status_code, x.content into resp from net._http_response x where x.id = r.req;
    if not found then
      -- No answer yet. One lost for ten minutes is given up on and the step
      -- is walked again from the start; five such tries and the row rests.
      if r.updated_at < now() - interval '10 minutes' then
        if r.tries + 1 >= 5 then
          update artist_image_queue set state = 'none', updated_at = now() where artist_id = r.artist_id;
        else
          update artist_image_queue set state = 'queued', req = null, tries = tries + 1, updated_at = now() where artist_id = r.artist_id;
        end if;
      end if;
      continue;
    end if;
    if resp.status_code is distinct from 200 then
      -- Turned away or down: the step is asked again from the start, a try
      -- spent; five tries and the row rests as 'none'.
      if r.tries + 1 >= 5 then
        update artist_image_queue set state = 'none', updated_at = now() where artist_id = r.artist_id;
      else
        update artist_image_queue set state = 'queued', req = null, tries = tries + 1, updated_at = now() where artist_id = r.artist_id;
      end if;
      continue;
    end if;
    body := resp.content::jsonb;

    if r.state = 'mb' then
      -- MusicBrainz answered: the page's Wikidata entry, if it has one.
      select substring((x -> 'url' ->> 'resource') from 'wikidata\.org/wiki/(Q\d+)') into wd_id
        from jsonb_array_elements(coalesce(body -> 'relations', '[]'::jsonb)) x
       where x ->> 'type' = 'wikidata'
         and (x -> 'url' ->> 'resource') ~ 'wikidata\.org/wiki/Q\d+'
       limit 1;
      if wd_id is null then
        update artist_image_queue set state = 'none', req = null, updated_at = now() where artist_id = r.artist_id;
      elsif n < 10 then
        rid := net.http_get(url := 'https://www.wikidata.org/w/api.php',
          params := jsonb_build_object('action', 'wbgetclaims', 'entity', wd_id, 'property', 'P18', 'format', 'json'),
          headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'),
          timeout_milliseconds := 15000);
        update artist_image_queue set state = 'wd', wd = wd_id, req = rid, updated_at = now() where artist_id = r.artist_id;
        n := n + 1;
      end if;

    elsif r.state = 'wd' then
      -- Wikidata answered: P18, the picture's file name on Commons, if any.
      fn := body -> 'claims' -> 'P18' -> 0 -> 'mainsnak' -> 'datavalue' ->> 'value';
      if coalesce(fn, '') = '' or char_length(fn) > 390 then
        update artist_image_queue set state = 'none', req = null, updated_at = now() where artist_id = r.artist_id;
      elsif n < 10 then
        rid := net.http_get(url := 'https://commons.wikimedia.org/w/api.php',
          params := jsonb_build_object('action', 'query', 'titles', 'File:' || fn,
            'prop', 'imageinfo', 'iiprop', 'url|extmetadata', 'iiurlwidth', '600', 'format', 'json'),
          headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'),
          timeout_milliseconds := 20000);
        update artist_image_queue set state = 'commons', image = left(fn, 400), req = rid, updated_at = now() where artist_id = r.artist_id;
        n := n + 1;
      end if;

    elsif r.state = 'commons' then
      -- Commons answered: the picture at width 600, its page, its author and
      -- licence. The author field can arrive as markup; only its words stay.
      select p.value -> 'imageinfo' -> 0 into ii
        from jsonb_each(coalesce(body -> 'query' -> 'pages', '{}'::jsonb)) p limit 1;
      thumb := ii ->> 'thumburl';
      page := ii ->> 'descriptionurl';
      lic := btrim(regexp_replace(coalesce(ii -> 'extmetadata' -> 'LicenseShortName' ->> 'value', ''), '<[^>]*>', '', 'g'));
      aut := btrim(regexp_replace(regexp_replace(coalesce(ii -> 'extmetadata' -> 'Artist' ->> 'value', ''), '<[^>]*>', '', 'g'), '\s+', ' ', 'g'));
      if coalesce(thumb, '') not like 'https://upload.wikimedia.org/%' then
        update artist_image_queue set state = 'none', req = null, updated_at = now() where artist_id = r.artist_id;
      else
        -- The last look before writing: still nobody's page, still bare.
        update artists set
          avatar = left(thumb, 500),
          avatar_credit = left('Photo: ' || coalesce(nullif(aut, ''), 'Wikimedia Commons')
            || case when lic <> '' then ' - ' || lic else '' end, 200)
         where id = r.artist_id and owner_id is null and coalesce(avatar, '') = '';
        if found then
          update artist_image_queue set state = 'done', req = null,
                 licence = left(lic, 120), author = left(aut, 160),
                 source_url = case when coalesce(page, '') like 'https://%' then left(page, 500) else '' end,
                 updated_at = now()
           where artist_id = r.artist_id;
        else
          update artist_image_queue set state = 'none', req = null, updated_at = now() where artist_id = r.artist_id;
        end if;
      end if;
    end if;
   exception when others then
    -- One bad row never wedges the queue: a try spent, walked again later.
    if r.tries + 1 >= 5 then
      update artist_image_queue set state = 'none', updated_at = now() where artist_id = r.artist_id;
    else
      update artist_image_queue set state = 'queued', req = null, tries = tries + 1, updated_at = now() where artist_id = r.artist_id;
    end if;
   end;
  end loop;
  return n;
end $$;
revoke all on function public.artist_images_step() from public, anon, authenticated;

-- Every two minutes, the way 0066's reconciler keeps its own clock.
do $$
begin
  perform cron.unschedule('greenroom-artist-images')
    where exists (select 1 from cron.job where jobname = 'greenroom-artist-images');
  perform cron.schedule('greenroom-artist-images', '*/2 * * * *', 'select public.artist_images_step()');
end $$;

-- ---------------------------------------------------------------------------
-- 4. The page says whose photo it is: artist_card carries the credit
-- ---------------------------------------------------------------------------
-- The 0134 card, word for word, plus two keys at the top: avatarCredit (the
-- line under the header) and avatarSource (where the picture lives, for the
-- line to link). Both empty on every page whose picture an owner picked.
create or replace function public.artist_card(a_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a public.artists%rowtype;
begin
  if auth.uid() is null then return null; end if;
  select * into a from artists where id = a_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', a.id, 'handle', a.handle, 'name', a.name, 'bio', a.bio, 'avatar', a.avatar,
    'avatarCredit', coalesce(a.avatar_credit, ''),
    'avatarSource', coalesce((select q.source_url from artist_image_queue q
                               where q.artist_id = a.id and q.state = 'done'), ''),
    'mine', coalesce(a.owner_id = auth.uid(), false),
    -- Nobody runs it yet: what the encyclopedia says about the act, and
    -- where the caller's own claim on it stands.
    'unclaimed', a.owner_id is null, 'verified', a.verified, 'about', a.about, 'country', a.country,
    'checkmark', (coalesce(a.mbid, '') <> '' and a.checked) or a.verified,
    'claimed', a.owner_id is not null and a.verified,
    'myClaim', (select c.status from artist_claims c where c.artist_id = a.id and c.user_id = auth.uid()),
    'myClaimCode', (select c.code from artist_claims c where c.artist_id = a.id and c.user_id = auth.uid() and c.status = 'pending' and c.code <> ''),
    -- My own request to be listed here, while it waits or just after a no.
    'myRequest', (select jsonb_build_object('kind', r.kind, 'role', r.role, 'at', r.created_at,
                    'state', public.artist_request_state(r.status, r.created_at, a.owner_id, a.claimed_at))
                    from artist_requests r
                   where r.artist_id = a.id and r.user_id = auth.uid()
                     and (r.status = 'pending' or (r.status = 'declined' and r.decided_at > now() - interval '30 days'))),
    'followers', (select count(*) from artist_follows f where f.artist_id = a.id),
    'iFollow', exists (select 1 from artist_follows f where f.artist_id = a.id and f.user_id = auth.uid()),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
          'userId', m.user_id, 'kind', m.kind, 'role', coalesce(m.role, ''),
          'hasCredits', coalesce(a.owner_id = auth.uid(), false) and exists (select 1 from tour_credits tc
             where tc.artist_id = a.id and tc.user_id = m.user_id and tc.approved is not null),
          'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
          'handle', coalesce(p.handle, ''), 'avatar', coalesce(p.avatar, ''),
          'roles', to_jsonb(coalesce(p.roles, '{}'::text[])), 'tourRole', coalesce(p.tour_role, ''),
          'verified', exists (select 1 from verified_users v where v.user_id = m.user_id),
          'canOpen', public.can_see_profile(m.user_id),
          'endorsed', exists (select 1 from artist_endorsements e where e.artist_id = a.id and e.user_id = m.user_id and e.removed_at is null),
          -- (a member the page can no longer simply take back: endorsed, or listed for more than a week)
          'settled', public.member_settled(a.id, m.user_id),
          -- Asked to leave, waiting on the other members: for the account that runs the page and for its members.
          'leaving', (select jsonb_build_object('at', r.asked_at, 'waiting', public.member_removal_waiting(r.artist_id, r.user_id))
                        from member_removals r
                       where r.artist_id = a.id and r.user_id = m.user_id
                         and (a.owner_id = auth.uid() or exists (select 1 from artist_members me
                               where me.artist_id = a.id and me.user_id = auth.uid() and me.kind = 'band' and me.ended_at is null))),
          -- They took this page's endorsement off theirs: its owner gets no Endorse button for them again.
          'declined', coalesce(a.owner_id = auth.uid(), false)
            and exists (select 1 from artist_endorsements e where e.artist_id = a.id and e.user_id = m.user_id and e.removed_at is not null))
        order by m.created_at)
      from artist_members m left join profiles p on p.user_id = m.user_id where m.artist_id = a.id and m.ended_at is null), '[]'::jsonb)
      -- Someone who has claimed a page nobody runs is "listed as a member until the claim is approved or
      -- denied": shown as pending, to themselves and to Greenroom. (Not to everyone: anyone could put their
      -- name on any act's page that way. And never as a real listing: a listed Member gets every night.)
      || coalesce((
      select jsonb_agg(jsonb_build_object(
          'userId', c.user_id, 'kind', 'band', 'role', c.role, 'hasCredits', false,
          'name', coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), ''),
          'handle', coalesce(p.handle, ''), 'avatar', coalesce(p.avatar, ''),
          'roles', to_jsonb(coalesce(p.roles, '{}'::text[])), 'tourRole', coalesce(p.tour_role, ''),
          'verified', false, 'canOpen', public.can_see_profile(c.user_id),
          'endorsed', false, 'settled', false, 'declined', false, 'pending', true)
        order by c.created_at)
      from artist_claims c left join profiles p on p.user_id = c.user_id
     where c.artist_id = a.id and c.status = 'pending' and a.owner_id is null
       and (c.user_id = auth.uid() or public.is_admin())), '[]'::jsonb),
    'tours', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', t.id, 'artist', a.name, 'name', trim(coalesce(t.doc ->> 'name', '')),
          'first', (select min(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x),
          'last', (select max(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x),
          'shows', jsonb_array_length(public.tour_dates(t.doc)),
          'mine', public.my_role(t.id) is not null)
        order by (select max(x ->> 'date') from jsonb_array_elements(public.tour_dates(t.doc)) x) desc nulls last, t.id)
      from public.artist_tours(a.id) t), '[]'::jsonb));
end $$;
revoke all on function public.artist_card(uuid) from public, anon;
grant execute on function public.artist_card(uuid) to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   select cron.unschedule('greenroom-artist-images');
--   drop function if exists public.artist_images_step();
--   drop table if exists public.artist_image_queue;
--   drop trigger if exists artists_avatar_credit on public.artists;
--   drop function if exists public.artist_avatar_credit_guard();
--   update public.artists set avatar = '', avatar_credit = ''
--    where avatar like 'https://upload.wikimedia.org/%' or avatar like 'https://commons.wikimedia.org/%';
--   alter table public.artists drop constraint if exists artists_avatar_len;
--   alter table public.artists add constraint artists_avatar_len
--     check (char_length(avatar) <= 120000 and (avatar = '' or avatar like 'data:image/%'));
--   alter table public.artists drop column if exists avatar_credit;
--   re-run artist_card from 0134 (the card then simply stops carrying the
--   two keys, and the app shows no credit line);
--   notify pgrst, 'reload schema';
-- Owners' own uploads are data: addresses and are never touched by any of it.
