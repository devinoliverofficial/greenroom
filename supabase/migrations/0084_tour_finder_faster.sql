-- Faster reads (Devin, 2026-10-08: "the reading of the tour announcements /
-- articles takes a long time"). Three things:
--  1. Each round asks several sites at once (one request per site), not one
--     request in total; the ten-second pacing is per round, so the archives
--     still see at most one request from us every ten seconds each.
--  2. Articles already read are kept across runs. A later run asks each site
--     only for posts newer than the newest it already has, and hands the app
--     only the articles it hasn't read yet. A second run is seconds, not minutes.
--  3. The app marks what it read, so nothing is read twice.

alter table public.tour_find_pages add column if not exists read_at timestamptz;

-- Starting (or starting over) keeps the articles and each site's tag id.
create or replace function public.tour_find_start(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare f record; nm text; sl text; hst text;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  select * into f from tour_finds where artist_id = a_id;
  if found and f.day = current_date and f.status <> 'error' then return public.tour_find_state(a_id); end if;
  select a.name into nm from artists a where a.id = a_id;
  sl := btrim(regexp_replace(lower(coalesce(nm, '')), '[^a-z0-9]+', '-', 'g'), '-');
  delete from tour_find_requests where artist_id = a_id;
  delete from tour_candidates where artist_id = a_id and status = 'new';
  -- Lambgoat's listing is asked again (new articles appear on it); its articles already read stay.
  insert into tour_finds (artist_id, owner_id, status, detail, slug, prp_tag, prp_pages, prp_next, lg_state, tries, fired_at, started_at, finished_at, day)
  values (a_id, auth.uid(), 'reading', '', sl, null, 0, 0, 'new', 0, null, now(), null, current_date)
  on conflict (artist_id) do update
    set owner_id = excluded.owner_id, status = 'reading', detail = '', slug = excluded.slug,
        prp_next = case when tour_finds.prp_tag is not null then 1 else 0 end, prp_pages = greatest(tour_finds.prp_pages, 1),
        lg_state = 'new', tries = 0, fired_at = null, started_at = now(), finished_at = null, day = current_date, extracting_at = null;
  foreach hst in array public.tour_find_hosts() loop
    insert into tour_find_sources (artist_id, host) values (a_id, hst)
    on conflict (artist_id, host) do update set next = case when tour_find_sources.tag is not null then 1 else 0 end, pages = greatest(tour_find_sources.pages, 1);
  end loop;
  return public.tour_find_state(a_id);
end $$;
revoke all on function public.tour_find_start(uuid) from public, anon;
grant execute on function public.tour_find_start(uuid) to authenticated;

-- The newest article a source already gave us, for the "only newer than this" ask.
create or replace function public.tour_find_after(a_id uuid, src text)
returns text
language sql stable security definer set search_path = public as $$
  select case when max(g.published) is null then null else to_char(max(g.published) + 1, 'YYYY-MM-DD') || 'T00:00:00' end
    from tour_find_pages g where g.artist_id = a_id and g.source = src
$$;
revoke all on function public.tour_find_after(uuid, text) from public, anon, authenticated;

create or replace function public.tour_find_fire(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare f record; src record; rid bigint; n int := 0; p record; aft text; prm jsonb;
        ua constant text := 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/; devinoliverofficial@gmail.com)';
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
  if f.prp_next < 0 and f.lg_state in ('done', 'none')
     and not exists (select 1 from tour_find_sources s where s.artist_id = a_id and s.next >= 0) then
    update tour_finds set status = 'ready', finished_at = now(),
           detail = case when (select count(*) from tour_find_pages g where g.artist_id = a_id and g.fetched and g.body <> '') = 0
                         then 'No tour announcements found for this name.' else '' end
     where artist_id = a_id;
    return 0;
  end if;
  if f.fired_at is not null and f.fired_at > clock_timestamp() - interval '10 seconds' then return 0; end if;

  -- ThePRP: one request this round.
  if f.prp_next = 0 then
    rid := net.http_get(url := 'https://www.theprp.com/wp-json/wp/v2/tags',
      params := jsonb_build_object('slug', f.slug, '_fields', 'id,count'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 15000);
    insert into tour_find_requests (id, artist_id, kind) values (rid, a_id, 'prp_tag');
    n := n + 1;
  elsif f.prp_next > 0 then
    aft := public.tour_find_after(a_id, 'theprp');
    prm := jsonb_build_object('tags', f.prp_tag::text, 'per_page', '25', 'page', f.prp_next::text, '_fields', 'date,link,title,content');
    if aft is not null then prm := prm || jsonb_build_object('after', aft); end if;
    rid := net.http_get(url := 'https://www.theprp.com/wp-json/wp/v2/posts', params := prm,
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 20000);
    insert into tour_find_requests (id, artist_id, kind, meta) values (rid, a_id, 'prp_posts', jsonb_build_object('page', f.prp_next));
    n := n + 1;
  end if;

  -- Up to three other sites this round, one request each.
  for src in select * from tour_find_sources s where s.artist_id = a_id and s.next >= 0 order by s.host limit 3
  loop
    if src.next = 0 then
      rid := net.http_get(url := 'https://' || src.host || '/wp-json/wp/v2/tags',
        params := jsonb_build_object('search', replace(f.slug, '-', ' '), 'per_page', '20', '_fields', 'id,slug,count'),
        headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 15000);
      insert into tour_find_requests (id, artist_id, kind, meta) values (rid, a_id, 'wp_tag', jsonb_build_object('host', src.host));
    else
      aft := public.tour_find_after(a_id, src.host);
      prm := jsonb_build_object('tags', src.tag::text, 'per_page', '25', 'page', src.next::text, '_fields', 'date,link,title,content');
      if aft is not null then prm := prm || jsonb_build_object('after', aft); end if;
      rid := net.http_get(url := 'https://' || src.host || '/wp-json/wp/v2/posts', params := prm,
        headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 20000);
      insert into tour_find_requests (id, artist_id, kind, meta) values (rid, a_id, 'wp_posts', jsonb_build_object('host', src.host, 'page', src.next));
    end if;
    n := n + 1;
  end loop;

  -- Lambgoat: its listing, or up to four of its articles, this round. (No headers: it refuses ours.)
  if f.lg_state in ('new', 'retry') then
    rid := net.http_get(url := 'https://lambgoat.com/music/' || f.slug || '/', timeout_milliseconds := 15000);
    insert into tour_find_requests (id, artist_id, kind) values (rid, a_id, 'lg_list');
    n := n + 1;
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

-- The app gets only the articles it hasn't read; proposing marks them read.
create or replace function public.tour_find_pages_get(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare f record;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  select * into f from tour_finds where artist_id = a_id;
  if not found then return null; end if;
  if f.status = 'extracting' and f.extracting_at > now() - interval '5 minutes' then return null; end if;
  if f.status not in ('ready', 'extracting', 'done') then return null; end if;
  update tour_finds set status = 'extracting', extracting_at = now() where artist_id = a_id;
  return coalesce((
    select jsonb_agg(jsonb_build_object('url', g.url, 'source', g.source, 'title', g.title, 'published', g.published, 'body', g.body)
                     order by g.published nulls last, g.url)
      from tour_find_pages g where g.artist_id = a_id and g.fetched and g.body <> '' and g.read_at is null), '[]'::jsonb);
end $$;
revoke all on function public.tour_find_pages_get(uuid) from public, anon;
grant execute on function public.tour_find_pages_get(uuid) to authenticated;

create or replace function public.tour_find_propose(a_id uuid, cands jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare c jsonb; nm text; key text; fd date; ld date; n int := 0; ds jsonb; have_name text; missing int;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  if jsonb_typeof(cands) <> 'array' then raise exception 'bad input' using errcode = '22023'; end if;
  for c in select * from jsonb_array_elements(cands) limit 160
  loop
   begin
    nm := left(btrim(regexp_replace(coalesce(c ->> 'name', ''), '\s+', ' ', 'g')), 120);
    if char_length(nm) < 2 then continue; end if;
    fd := case when (c ->> 'start') ~ '^\d{4}-\d{2}-\d{2}$' then (c ->> 'start')::date
               when (c ->> 'start') ~ '^\d{4}-\d{2}$' then ((c ->> 'start') || '-01')::date end;
    ld := case when (c ->> 'end') ~ '^\d{4}-\d{2}-\d{2}$' then (c ->> 'end')::date
               when (c ->> 'end') ~ '^\d{4}-\d{2}$' then (((c ->> 'end') || '-01')::date + interval '1 month' - interval '1 day')::date end;
    if fd is null or ld is null or ld < fd or ld - fd > 400 or fd < date '1980-01-01' or fd > current_date + 400 then continue; end if;
    key := public.setlist_tour_key(nm);
    if exists (select 1 from tour_candidates t where t.artist_id = a_id and public.setlist_tour_key(t.name) = key) then continue; end if;
    select coalesce(jsonb_agg(jsonb_build_object('date', d ->> 'date', 'city', left(coalesce(d ->> 'city', ''), 80), 'venue', left(coalesce(d ->> 'venue', ''), 120))
                    order by d ->> 'date'), '[]'::jsonb) into ds
      from jsonb_array_elements(case when jsonb_typeof(c -> 'dates') = 'array' then c -> 'dates' else '[]'::jsonb end) d
     where (d ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (d ->> 'date')::date between fd - 1 and ld + 1;
    select mode() within group (order by h.tour) into have_name
      from artist_history_shows h where h.artist_id = a_id and h.tour <> '' and public.setlist_tour_key(h.tour) = key;
    if have_name is not null then
      select count(*) into missing from jsonb_array_elements(ds) d
       where (d ->> 'date')::date <= current_date
         and not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (d ->> 'date')::date);
      if coalesce(missing, 0) = 0 then
        select count(*) into missing from artist_history_shows h
         where h.artist_id = a_id and h.tour = ''
           and exists (select 1 from jsonb_array_elements(ds) d where abs(h.date - (d ->> 'date')::date) <= 1);
      end if;
      if coalesce(missing, 0) = 0 then continue; end if;
      nm := have_name;
    end if;
    insert into tour_candidates (artist_id, name, role, first_day, last_day, region, lineup, dates, sources, fill)
    values (a_id, nm,
      case when c ->> 'role' in ('headline', 'co-headline', 'support', 'festival') then c ->> 'role' else '' end,
      fd, ld, left(coalesce(c ->> 'region', ''), 60), left(coalesce(c ->> 'lineup', ''), 300), ds,
      (select coalesce(jsonb_agg(left(s, 300)), '[]'::jsonb) from (
         select distinct s from jsonb_array_elements_text(case when jsonb_typeof(c -> 'sources') = 'array' then c -> 'sources' else '[]'::jsonb end) s
          where s like 'https://%' limit 6) x),
      have_name is not null);
    n := n + 1;
   exception when others then
    update tour_finds set detail = left('Skipped an item: ' || sqlerrm, 160) where artist_id = a_id;
   end;
  end loop;
  -- Everything handed out has been read now.
  update tour_find_pages set read_at = now() where artist_id = a_id and fetched and body <> '' and read_at is null;
  update tour_finds set status = 'done', extracting_at = null, finished_at = coalesce(finished_at, now()) where artist_id = a_id and status <> 'error';
  return public.tour_find_state(a_id) || jsonb_build_object('added', n);
end $$;
revoke all on function public.tour_find_propose(uuid, jsonb) from public, anon;
grant execute on function public.tour_find_propose(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
