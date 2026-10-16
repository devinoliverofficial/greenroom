-- Pictures for the pages the first road missed (Devin, 2026-10-16: "I really
-- want any pages that are created through searching to have a profile
-- picture whether we get that from wiki or whatever. Just something.")
--
-- What the first week showed:
--   1. Commons answers its thumbnail from thumb.wikimedia.org now, not
--      upload.wikimedia.org, so the worker's last check turned away pictures
--      it had already found, and the page's own avatar rule would have
--      refused them too. Four pages rested as 'none' holding a perfectly
--      good file name.
--   2. Some pages have a Wikidata entry but no portrait on it, while their
--      Wikipedia article leads with one. That road was never walked.
--
-- So: the avatar rule learns the thumbnail host, the worker takes the
-- address an answer hands it (its tracking query stripped) instead of
-- insisting on one host, the Wikidata ask also brings the page's English
-- Wikipedia article, and a page with no portrait on Wikidata walks on to
-- that article's lead picture - taken ONLY when its licence reads as a free
-- one, because Wikipedia also hosts covers and promo shots under fair use,
-- which are not ours to put on a page. Every rested row is sent down the
-- new road once; five tries and it rests again.
--
-- Nothing else changes: only unclaimed bare pages, an owner's upload always
-- wins, the credit still rides artist_card, phones still never touch the
-- queue, and the clock stays cron's every-two-minutes.

-- The avatar rule learns where Commons answers from. Everything else about
-- it is 0158's, word for word.
alter table public.artists drop constraint if exists artists_avatar_len;
alter table public.artists add constraint artists_avatar_len
  check (char_length(avatar) <= 120000 and (avatar = '' or avatar like 'data:image/%'
    or avatar like 'https://upload.wikimedia.org/%' or avatar like 'https://commons.wikimedia.org/%'
    or avatar like 'https://thumb.wikimedia.org/%'));

-- Two new stops on the walk: 'wp' (the article's lead picture asked for)
-- and 'wpfile' (that picture's address and licence asked for). 'wp_title'
-- carries the article's name between them.
alter table public.artist_image_queue drop constraint if exists artist_image_queue_state_check;
alter table public.artist_image_queue add constraint artist_image_queue_state_check
  check (state in ('queued', 'mb', 'wd', 'wp', 'wpfile', 'commons', 'done', 'none'));
alter table public.artist_image_queue add column if not exists wp_title text not null default ''
  check (char_length(wp_title) <= 300);

create or replace function public.artist_images_step()
returns int
language plpgsql volatile security definer set search_path = public as $$
declare r record; rid bigint; n int := 0; resp record; body jsonb; wd_id text; fn text;
        ent jsonb; ii jsonb; thumb text; page text; lic text; aut text; wp text;
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
            where q.state in ('queued', 'mb', 'wd', 'wp', 'wpfile', 'commons')
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
    -- One ask a second across the whole house, by the shared pace gate.
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
        -- One ask brings both the portrait claim and the English article.
        rid := net.http_get(url := 'https://www.wikidata.org/w/api.php',
          params := jsonb_build_object('action', 'wbgetentities', 'ids', wd_id,
            'props', 'claims|sitelinks', 'sitefilter', 'enwiki', 'format', 'json'),
          headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'),
          timeout_milliseconds := 15000);
        update artist_image_queue set state = 'wd', wd = wd_id, req = rid, updated_at = now() where artist_id = r.artist_id;
        n := n + 1;
      end if;

    elsif r.state = 'wd' then
      -- Wikidata answered: the portrait's file name on Commons if the entry
      -- has one, else the English article to try next. (The entity is read
      -- as the one entity in the answer, so a renamed id still parses.)
      select e.value into ent from jsonb_each(coalesce(body -> 'entities', '{}'::jsonb)) e limit 1;
      fn := ent -> 'claims' -> 'P18' -> 0 -> 'mainsnak' -> 'datavalue' ->> 'value';
      wp := ent -> 'sitelinks' -> 'enwiki' ->> 'title';
      if coalesce(fn, '') <> '' and char_length(fn) <= 390 then
        if n < 10 then
          rid := net.http_get(url := 'https://commons.wikimedia.org/w/api.php',
            params := jsonb_build_object('action', 'query', 'titles', 'File:' || fn,
              'prop', 'imageinfo', 'iiprop', 'url|extmetadata', 'iiurlwidth', '600', 'format', 'json'),
            headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'),
            timeout_milliseconds := 20000);
          update artist_image_queue set state = 'commons', image = left(fn, 400), req = rid, updated_at = now() where artist_id = r.artist_id;
          n := n + 1;
        end if;
      elsif coalesce(wp, '') <> '' and char_length(wp) <= 290 then
        if n < 10 then
          rid := net.http_get(url := 'https://en.wikipedia.org/w/api.php',
            params := jsonb_build_object('action', 'query', 'titles', wp, 'redirects', '1',
              'prop', 'pageimages', 'piprop', 'name', 'format', 'json'),
            headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'),
            timeout_milliseconds := 15000);
          update artist_image_queue set state = 'wp', wp_title = left(wp, 300), req = rid, updated_at = now() where artist_id = r.artist_id;
          n := n + 1;
        end if;
      else
        update artist_image_queue set state = 'none', req = null, updated_at = now() where artist_id = r.artist_id;
      end if;

    elsif r.state = 'wp' then
      -- Wikipedia answered: the article's lead picture, if it has one.
      select p.value -> 'pageimage' #>> '{}' into fn
        from jsonb_each(coalesce(body -> 'query' -> 'pages', '{}'::jsonb)) p
       where p.value ? 'pageimage' limit 1;
      if coalesce(fn, '') = '' or char_length(fn) > 390 then
        update artist_image_queue set state = 'none', req = null, updated_at = now() where artist_id = r.artist_id;
      elsif n < 10 then
        -- Asked of Wikipedia itself, which answers for its own files and
        -- for Commons files alike.
        rid := net.http_get(url := 'https://en.wikipedia.org/w/api.php',
          params := jsonb_build_object('action', 'query', 'titles', 'File:' || fn,
            'prop', 'imageinfo', 'iiprop', 'url|extmetadata', 'iiurlwidth', '600', 'format', 'json'),
          headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'),
          timeout_milliseconds := 20000);
        update artist_image_queue set state = 'wpfile', image = left(fn, 400), req = rid, updated_at = now() where artist_id = r.artist_id;
        n := n + 1;
      end if;

    elsif r.state in ('commons', 'wpfile') then
      -- The picture's address, author and licence. The address is taken as
      -- the answer hands it (Commons serves thumbnails from its own hosts;
      -- a tracking query on the end is dropped). A picture from the
      -- Wikipedia road is taken only under a licence that reads as free:
      -- Wikipedia also hosts covers and promo shots under fair use, and
      -- those are not ours to put on a page.
      select p.value -> 'imageinfo' -> 0 into ii
        from jsonb_each(coalesce(body -> 'query' -> 'pages', '{}'::jsonb)) p
       where p.value -> 'imageinfo' -> 0 is not null limit 1;
      thumb := split_part(coalesce(ii ->> 'thumburl', ii ->> 'url', ''), '?', 1);
      page := ii ->> 'descriptionurl';
      lic := btrim(regexp_replace(coalesce(ii -> 'extmetadata' -> 'LicenseShortName' ->> 'value', ''), '<[^>]*>', '', 'g'));
      aut := btrim(regexp_replace(regexp_replace(coalesce(ii -> 'extmetadata' -> 'Artist' ->> 'value', ''), '<[^>]*>', '', 'g'), '\s+', ' ', 'g'));
      if thumb not like 'https://upload.wikimedia.org/%'
         and thumb not like 'https://thumb.wikimedia.org/%'
         and thumb not like 'https://commons.wikimedia.org/%' then
        update artist_image_queue set state = 'none', req = null, updated_at = now() where artist_id = r.artist_id;
      elsif r.state = 'wpfile'
            and not (lic ~* '^(cc|pd|public domain|gfdl|attribution|free|no restrictions)'
                     and lic !~* 'non-?free|fair') then
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

-- Every page that rested without a picture walks once more, down the new
-- road, with fresh tries. By rule, never by name: rows already done, or
-- belonging to pages that gained an owner or a picture since, stay put
-- (the worker's first look retires those again at once).
update public.artist_image_queue q
   set state = 'queued', req = null, tries = 0, image = '', wp_title = '', updated_at = now()
 where q.state = 'none'
   and exists (select 1 from artists a where a.id = q.artist_id
                and a.owner_id is null and coalesce(a.avatar, '') = '' and coalesce(a.mbid, '') <> '');

-- ============================== To roll back ==============================
--   Put back 0158's artist_images_step (its text is in that file), then:
--   alter table public.artist_image_queue drop constraint artist_image_queue_state_check;
--   alter table public.artist_image_queue add constraint artist_image_queue_state_check
--     check (state in ('queued','mb','wd','commons','done','none'));
--   update artist_image_queue set state='none' where state in ('wp','wpfile');
--   alter table public.artist_image_queue drop column if exists wp_title;
--   (The widened avatar rule should stay: pages already carry thumb-host
--   pictures once this has run.)
