-- Lambgoat, read plainly: its server rejects the database's request whenever a
-- header is set (HTTP 400 'invalid header name'), and answers with none. Only the
-- Lambgoat lines of tour_find_fire change.

-- Firing: ThePRP first, then each other site in turn, then Lambgoat.
create or replace function public.tour_find_fire(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare f record; src record; rid bigint; n int := 0; p record;
        ua constant text := 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/; devinoliverofficial@gmail.com)';
        ua2 constant text := 'Mozilla/5.0 (compatible; Greenroom/1.0; +https://devinoliverofficial.github.io/greenroom/)';
begin
  select * into f from tour_finds where artist_id = a_id and status = 'reading';
  if not found then return 0; end if;
  if exists (select 1 from tour_find_requests r where r.artist_id = a_id) then return 0; end if;
  if f.slug = '' then
    update tour_finds set status = 'ready', detail = 'No tour announcements to read for this name.', finished_at = now() where artist_id = a_id;
    return 0;
  end if;
  if f.lg_state = 'listed' and not exists (select 1 from tour_find_pages g where g.artist_id = a_id and g.source = 'lambgoat' and not g.fetched) then
    update tour_finds set lg_state = 'done' where artist_id = a_id;
    f.lg_state := 'done';
  end if;
  select * into src from tour_find_sources s where s.artist_id = a_id and s.next >= 0 order by s.host limit 1;
  if f.prp_next < 0 and f.lg_state in ('done', 'none') and src.host is null then
    update tour_finds set status = 'ready', finished_at = now(),
           detail = case when (select count(*) from tour_find_pages g where g.artist_id = a_id and g.fetched and g.body <> '') = 0
                         then 'No tour announcements found for this name.' else '' end
     where artist_id = a_id;
    return 0;
  end if;
  if f.fired_at is not null and f.fired_at > clock_timestamp() - interval '10 seconds' then return 0; end if;
  if f.prp_next = 0 then
    rid := net.http_get(url := 'https://www.theprp.com/wp-json/wp/v2/tags',
      params := jsonb_build_object('slug', f.slug, '_fields', 'id,count'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 15000);
    insert into tour_find_requests (id, artist_id, kind) values (rid, a_id, 'prp_tag');
    n := 1;
  elsif f.prp_next > 0 then
    rid := net.http_get(url := 'https://www.theprp.com/wp-json/wp/v2/posts',
      params := jsonb_build_object('tags', f.prp_tag::text, 'per_page', '25', 'page', f.prp_next::text, '_fields', 'date,link,title,content'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 20000);
    insert into tour_find_requests (id, artist_id, kind, meta) values (rid, a_id, 'prp_posts', jsonb_build_object('page', f.prp_next));
    n := 1;
  elsif src.host is not null and src.next = 0 then
    -- Another site: does it have a tag for this band? (Searched by name; the slug has to match exactly.)
    rid := net.http_get(url := 'https://' || src.host || '/wp-json/wp/v2/tags',
      params := jsonb_build_object('search', replace(f.slug, '-', ' '), 'per_page', '20', '_fields', 'id,slug,count'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 15000);
    insert into tour_find_requests (id, artist_id, kind, meta) values (rid, a_id, 'wp_tag', jsonb_build_object('host', src.host));
    n := 1;
  elsif src.host is not null and src.next > 0 then
    rid := net.http_get(url := 'https://' || src.host || '/wp-json/wp/v2/posts',
      params := jsonb_build_object('tags', src.tag::text, 'per_page', '25', 'page', src.next::text, '_fields', 'date,link,title,content'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 20000);
    insert into tour_find_requests (id, artist_id, kind, meta) values (rid, a_id, 'wp_posts', jsonb_build_object('host', src.host, 'page', src.next));
    n := 1;
  elsif f.lg_state in ('new', 'retry') then
    -- Lambgoat answers 400 "invalid header name" to any request the database sends with its own
    -- headers (checked 2026-10-08), and 200 to one without: so, none.
    rid := net.http_get(url := 'https://lambgoat.com/music/' || f.slug || '/', timeout_milliseconds := 15000);
    insert into tour_find_requests (id, artist_id, kind) values (rid, a_id, 'lg_list');
    n := 1;
  elsif f.lg_state = 'listed' then
    for p in select url from tour_find_pages where artist_id = a_id and source = 'lambgoat' and not fetched order by url limit 4
    loop
      rid := net.http_get(url := p.url, timeout_milliseconds := 15000);
      insert into tour_find_requests (id, artist_id, kind, url) values (rid, a_id, 'lg_article', p.url);
      n := n + 1;
    end loop;
  end if;
  if n > 0 then update tour_finds set fired_at = clock_timestamp() where artist_id = a_id; end if;
  return n;
end $$;
revoke all on function public.tour_find_fire(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
