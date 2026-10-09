-- Festivals (Devin, 2026-10-09: "you are missing some shows / festivals on
-- setlist.fm ... figure out why you missed it and don't let it happen again").
-- Why: setlist.fm shows "I See Stars at Aftershock 2026 (Venue: Faultline Stage)"
-- on the site, but its API has no festival field at all — a setlist is artist,
-- venue, tour, sets, info, url, ids, dates — so the sync never saw a festival
-- name and sixty nights sat on stages and fairgrounds as plain shows.
-- Now: every night carries a `festival`; it is filled from (1) a tour label
-- that is a festival name, (2) an announcement the reader found for that date,
-- (3) a table of festival grounds (venue or stage name + city + month), which
-- recurs year after year for every artist; the sync's upsert never touches it.
-- Festivals are their own entries in the tour list ("<Festival> <year>"), a
-- tour label that is a festival is marked as one, and tapping either lists the
-- nights. Shows are counted one per date and venue (setlist.fm holds a few
-- doubled entries). And a setlist.fm pass that read fewer setlists than the
-- site reports prunes nothing and says so.

alter table public.artist_history_shows add column if not exists festival text not null default '';

create table if not exists public.festival_grounds (
  id serial primary key,
  name text not null,
  aliases text not null default '',
  grounds text not null default '',
  city text not null default '',
  region text not null default '',
  country_code text not null default '',
  months int[] not null default '{}',
  first_year int,
  last_year int,
  genre text not null default '',
  source_url text not null default ''
);
alter table public.festival_grounds enable row level security;
revoke all on public.festival_grounds from public, anon, authenticated;
create index if not exists festival_grounds_cc on public.festival_grounds (country_code);

-- "Faultline Stage", Sacramento, October → Aftershock <year>.
create or replace function public.festival_grounds_match(v text, c text, cc text, d date)
returns text
language sql stable as $$
  select g.name || ' ' || extract(year from d)::int
    from festival_grounds g
   where d is not null
     and (g.country_code = '' or g.country_code = coalesce(cc, ''))
     and (cardinality(g.months) = 0 or extract(month from d)::int = any (g.months))
     and (g.first_year is null or extract(year from d)::int >= g.first_year)
     and (g.last_year is null or extract(year from d)::int <= g.last_year)
     and exists (select 1 from unnest(string_to_array(g.grounds, ',')) t
                  where length(btrim(t)) >= 4 and lower(coalesce(v, '')) like '%' || lower(btrim(t)) || '%')
     and (g.city = '' or lower(coalesce(c, '')) = lower(g.city) or lower(coalesce(v, '')) like '%' || lower(g.city) || '%')
   order by length(g.city) desc, length(g.grounds) desc
   limit 1
$$;
revoke all on function public.festival_grounds_match(text, text, text, date) from public, anon, authenticated;

create or replace function public.festival_tag(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int := 0; k int;
begin
  -- 1. A tour label that is itself a festival name.
  update artist_history_shows h set festival = h.tour
   where h.artist_id = a_id and h.festival = '' and h.tour <> ''
     and public.tour_is_festival(h.tour) and not public.tour_find_madeup(h.tour);
  get diagnostics k = row_count; n := n + k;
  -- 2. An announcement the reader found that names a festival for that date.
  update artist_history_shows h set festival = c.name
    from tour_candidates c
   where h.artist_id = a_id and h.festival = '' and c.artist_id = a_id and c.status = 'added' and c.name <> ''
     and public.tour_is_festival(c.name) and not public.tour_find_madeup(c.name)
     and exists (select 1 from jsonb_array_elements(c.dates) x
                  where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'date')::date = h.date);
  get diagnostics k = row_count; n := n + k;
  -- 3. The grounds: where the festival always is, in the month it always runs.
  update artist_history_shows h set festival = public.festival_grounds_match(h.venue, h.city, h.country_code, h.date)
   where h.artist_id = a_id and h.festival = ''
     and public.festival_grounds_match(h.venue, h.city, h.country_code, h.date) is not null;
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;
revoke all on function public.festival_tag(uuid) from public, anon, authenticated;

create or replace function public.tour_find_apply(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; d jsonb; n int := 0; cc text; ct text; src text; kc text; fest boolean;
begin
  delete from artist_history_shows p
   where p.artist_id = a_id and p.pinned
     and exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = p.date and not h.pinned);
  for c in select * from tour_candidates where artist_id = a_id and status = 'added' and first_day is not null and last_day is not null
            and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.setlist_tour_key(tour_candidates.name))
            order by last_day - first_day asc
  loop
    kc := public.artist_tour_gkey(a_id, c.name);
    if c.name <> '' then
      update artist_history_shows h set tour = c.name, named_by = c.id
       where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date);
      -- A night the announcement lists goes under this tour, whatever label setlist.fm had on it;
      -- a night another find pinned, or one in a settled or open conflict, is left alone.
      update artist_history_shows h set tour = c.name, named_by = c.id
       where h.artist_id = a_id and h.tour <> '' and public.artist_tour_gkey(a_id, h.tour) <> kc
         and (not h.pinned or h.named_by = c.id)
         and exists (select 1 from jsonb_array_elements(c.dates) x where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'date')::date = h.date)
         and not exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and cf.date = h.date)
         and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = h.date);
    end if;
    src := coalesce((select s from jsonb_array_elements_text(case when jsonb_typeof(c.sources) = 'array' then c.sources else '[]'::jsonb end) s where s like 'https://%' limit 1), '');
    -- A festival (Devin: "most of the time an artist is only playing one day") that lists many
    -- cities: when fewer than half its dates have a night the page already knows, only those
    -- corroborated dates land — the rest are the festival's other stops, not the act's.
    fest := public.tour_is_festival(c.name) and jsonb_array_length(c.dates) > 3
      and (select count(*) from jsonb_array_elements(c.dates) x
            where case when (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
                       then exists (select 1 from artist_history_shows h where h.artist_id = a_id and not h.pinned and abs(h.date - (x ->> 'date')::date) <= 1)
                       else false end)
          < jsonb_array_length(c.dates) / 2.0;
    if fest then
      delete from artist_history_shows h where h.artist_id = a_id and h.pinned and h.named_by = c.id;
    end if;
    for d in select * from jsonb_array_elements(c.dates)
    loop
      if (d ->> 'date') !~ '^\d{4}-\d{2}-\d{2}$' then continue; end if;
      if (d ->> 'date')::date > current_date then continue; end if;
      if exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (d ->> 'date')::date) then continue; end if;
      if fest then continue; end if;  -- a festival's other days stay off the page
      ct := left(btrim(split_part(coalesce(d ->> 'city', ''), ',', 1)), 80);
      cc := coalesce(public.road_country(d ->> 'city'), '');
      insert into artist_history_shows (artist_id, id, date, venue, city, state, country_code, country, tour, url, pinned, named_by, seen)
      values (a_id, 'tf:' || c.id || ':' || (d ->> 'date'), (d ->> 'date')::date, left(coalesce(d ->> 'venue', ''), 120), ct,
              case when cc in ('US', 'CA') then left(btrim(split_part(coalesce(d ->> 'city', ''), ',', 2)), 80) else '' end,
              cc, case cc when 'US' then 'United States' when 'CA' then 'Canada' when 'GB' then 'United Kingdom' when 'AU' then 'Australia'
                          when '' then ''
                          else left(btrim(coalesce(substring(d ->> 'city' from ',([^,]*)$'), '')), 80) end,
              c.name, left(src, 300), true, c.id, now())
      on conflict (artist_id, id) do nothing;
      n := n + 1;
    end loop;
  end loop;
  update artist_history ah set credits = coalesce((
      select jsonb_agg(distinct x.host) from (
        select substring(h.url from '^https://(?:www\.)?([^/]+)') as host
          from artist_history_shows h where h.artist_id = a_id and h.pinned and h.url like 'https://%') x
       where x.host is not null and x.host in ('concertarchives.org', 'songkick.com', 'bandsintown.com')), '[]'::jsonb)
   where ah.artist_id = a_id;
  perform public.festival_tag(a_id);
  return n;
end $$;
revoke all on function public.tour_find_apply(uuid) from public, anon, authenticated;

create or replace function public.setlist_summarize(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s jsonb;
begin
  create temp table if not exists tg (tour text, gk text, hidden boolean, shown text) on commit drop;
  truncate tg;
  insert into tg select * from public.artist_tour_groups(a_id);
  select jsonb_build_object(
    'shows', count(distinct (h.date, lower(h.venue))),
    'festivals', (select count(distinct h6.festival) from artist_history_shows h6 where h6.artist_id = a_id and h6.festival <> ''),
    'countries', count(distinct country_code) filter (where country_code <> ''),
    'cities', count(distinct (country_code, lower(state), lower(city))) filter (where city <> ''),
    'firstYear', min(extract(year from date))::int,
    'lastYear', max(extract(year from date))::int,
    'tours', (select count(distinct g.gk) from artist_history_shows h2 join tg g on g.tour = h2.tour
               where h2.artist_id = a_id and not g.hidden),
    'years', coalesce((select jsonb_object_agg(y, n) from (
       select extract(year from h3.date)::int as y, count(distinct (h3.date, lower(h3.venue))) as n
         from artist_history_shows h3
        where h3.artist_id = a_id and h3.date is not null
        group by 1) yy), '{}'::jsonb),
    'toursList', coalesce((select jsonb_agg(jsonb_build_object(
         'name', coalesce(t.shown, t.name),
         'n', t.n + (select count(*) from artist_tour_conflicts cf
                      join artist_history_shows hh on hh.artist_id = a_id and hh.date = cf.date
                      left join tg g2 on g2.tour = hh.tour
                     where cf.artist_id = a_id and t.gk in (cf.key_a, cf.key_b) and coalesce(g2.gk, '') <> t.gk),
         'first', t.first, 'last', t.last,
         'lineup', coalesce((select c.lineup from tour_candidates c where c.artist_id = a_id and c.status = 'added' and c.lineup <> ''
                               and public.artist_tour_gkey(a_id, c.name) = t.gk order by jsonb_array_length(c.dates) desc limit 1), ''),
         'conflict', exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and t.gk in (cf.key_a, cf.key_b)),
         'kind', case when t.gk in (select public.artist_tour_gkey(a_id, f.festival) from artist_history_shows f where f.artist_id = a_id and f.festival <> '') then 'festival' else 'tour' end)
         order by t.last desc nulls last)
       from (
         select g.gk, max(g.shown) as shown, mode() within group (order by h4.tour) as name, count(distinct (h4.date, lower(h4.venue))) as n,
                min(h4.date) as first, max(h4.date) as last
           from artist_history_shows h4 join tg g on g.tour = h4.tour
          where h4.artist_id = a_id and not g.hidden
          group by g.gk) t), '[]'::jsonb)
      -- Festivals that are not also a tour label on the page: their own entries (Devin: festivals listed by name).
      || coalesce((select jsonb_agg(jsonb_build_object('name', f.festival, 'n', f.n, 'first', f.first, 'last', f.last, 'lineup', '', 'conflict', false, 'kind', 'festival')
                                    order by f.last desc)
         from (select h7.festival, count(distinct (h7.date, lower(h7.venue))) as n, min(h7.date) as first, max(h7.date) as last
                 from artist_history_shows h7 where h7.artist_id = a_id and h7.festival <> ''
                  and public.artist_tour_gkey(a_id, h7.festival) not in (select g.gk from tg g)
                group by h7.festival) f), '[]'::jsonb),
    'countriesList', coalesce((select jsonb_agg(jsonb_build_object('name', c.country, 'n', c.n) order by c.n desc)
       from (
         select h5.country, count(*) as n
           from artist_history_shows h5
          where h5.artist_id = a_id and h5.country <> ''
          group by h5.country
          order by count(*) desc
          limit 60) c), '[]'::jsonb))
    into s
    from artist_history_shows h
   where h.artist_id = a_id;
  update artist_history set summary = coalesce(s, '{}'::jsonb) where artist_id = a_id;
  return s;
end $$;
revoke all on function public.setlist_summarize(uuid) from public, anon, authenticated;

create or replace function public.setlist_finish(one uuid default null)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare a record; n int := 0; got int; short boolean;
begin
  for a in select ah.artist_id, ah.pass_at, ah.total from artist_history ah
            where (one is null or ah.artist_id = one)
              and ah.status = 'syncing' and ah.pages > 0 and ah.next_page > ah.pages
              and not exists (select 1 from setlist_requests q where q.artist_id = ah.artist_id)
  loop
    -- A pass that read fewer setlists than setlist.fm says it has is a short pass (rate limit, a
    -- page that failed): nothing is pruned on its account, and the head row says so.
    select count(*) into got from artist_history_shows h
     where h.artist_id = a.artist_id and not h.pinned and h.seen >= coalesce(a.pass_at, now()) - interval '3 days';
    short := coalesce(a.total, 0) > 0 and got < a.total - greatest(2, a.total / 50);
    if not short then
      delete from artist_history_shows
       where artist_id = a.artist_id and not pinned and seen < coalesce(a.pass_at, now()) - interval '3 days';
    end if;
    perform public.tour_find_fold(a.artist_id);
    perform public.tour_find_apply(a.artist_id);
    perform public.tour_fact_check(a.artist_id);
    perform setlist_summarize(a.artist_id);
    update artist_history set status = 'ok', next_page = 0, synced_at = now(),
           detail = case when short then 'Sync read ' || got || ' of ' || a.total || ' setlists; nothing was dropped' else '' end
     where artist_id = a.artist_id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.setlist_finish(uuid) from public, anon, authenticated;

create or replace function public.artist_tour_nights(a_id uuid, tour_name text)
returns jsonb
language sql stable security definer set search_path = public as $$
  with want as (select public.artist_tour_key_of(a_id, tour_name) as gk),
       tg as (select * from public.artist_tour_groups(a_id))
  select case when auth.uid() is null then null
              when exists (select 1 from artist_tour_edits e, want where e.artist_id = a_id and e.hidden and e.key = want.gk) then '[]'::jsonb
         else coalesce((
    select jsonb_agg(x order by x ->> 'date') from (
      select jsonb_build_object('date', h.date, 'city', h.city, 'state', h.state, 'country', h.country_code,
                                'venue', h.venue, 'url', h.url, 'announced', h.pinned, 'festival', h.festival,
                                'contested', exists (select 1 from artist_tour_conflicts cf, want where cf.artist_id = a_id and cf.date = h.date
                                                      and want.gk in (cf.key_a, cf.key_b))) as x
        from artist_history_shows h left join tg g on g.tour = h.tour, want
       where h.artist_id = a_id
         and (g.gk = want.gk
              or (h.festival <> '' and public.artist_tour_gkey(a_id, h.festival) = want.gk)
              or exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and cf.date = h.date
                          and want.gk in (cf.key_a, cf.key_b) and g.gk in (cf.key_a, cf.key_b)))) q), '[]'::jsonb) end
$$;
revoke all on function public.artist_tour_nights(uuid, text) from public, anon;
grant execute on function public.artist_tour_nights(uuid, text) to authenticated;

-- A one- or two-night festival inside a tour's run is not folded into the tour.
create or replace function public.tour_find_fold(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c record; p record; g record; folds int := 0; kc text; win_name text; nights_win int; nights_lose int;
begin
  -- 1. A find and a page tour that are the same tour under two spellings.
  for c in select t.id, t.name, t.dates from tour_candidates t where t.artist_id = a_id and t.status = 'added' and t.name <> '' and jsonb_array_length(t.dates) > 0
  loop
    kc := public.artist_tour_gkey(a_id, c.name);
    for p in select public.artist_tour_gkey(a_id, h.tour) as key, mode() within group (order by h.tour) as name
               from jsonb_array_elements(c.dates) d join artist_history_shows h on h.artist_id = a_id and h.date = (d ->> 'date')::date and h.tour <> ''
              where public.artist_tour_gkey(a_id, h.tour) <> kc
              group by 1
    loop
      if not public.tour_names_alike(kc, p.key) then continue; end if;
      select count(*) into nights_lose from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = kc;
      select count(*) into nights_win from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = p.key;
      if nights_win >= nights_lose then
        perform public.tour_fold_one(a_id, p.key, p.name, kc, c.name);
        update tour_candidates set name = p.name where id = c.id;
        kc := p.key;
      else
        select mode() within group (order by h.tour) into win_name from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = kc;
        perform public.tour_fold_one(a_id, kc, win_name, p.key, p.name);
      end if;
      folds := folds + 1;
    end loop;
  end loop;
  -- 1b. A find named by its bill ("Falling In Reverse, Enter Shikari, Letlive tour") whose run overlaps a
  -- real, short tour the page already names ("Monster Energy Outbreak Tour 2012"): one tour, under that name
  -- (an act is not on two tours the same night; an album-era label months long is not a tour, nor a festival).
  for c in select t.id, t.name, t.first_day, t.last_day, t.dates from tour_candidates t
            where t.artist_id = a_id and t.status = 'added' and t.name <> '' and public.tour_find_madeup(t.name) and jsonb_array_length(t.dates) > 0
  loop
    kc := public.artist_tour_gkey(a_id, c.name);
    for p in select pg.gk as key, pg.name, pg.n, pg.first, pg.last from (
               select gr.gk, mode() within group (order by h.tour) as name, count(*) as n, min(h.date) as first, max(h.date) as last
                 from artist_history_shows h join public.artist_tour_groups(a_id) gr on gr.tour = h.tour
                where h.artist_id = a_id and not gr.hidden
                  -- a night still under question is no evidence of where the tour ran
                  and not exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and cf.date = h.date)
                group by gr.gk) pg
              where pg.gk <> kc and not public.tour_find_madeup(pg.name) and not public.tour_is_festival(pg.name)
                and pg.n >= 3 and pg.last - pg.first <= 120
                and least(pg.last, c.last_day) - greatest(pg.first, c.first_day) >= 1
    loop
      perform public.tour_fold_one(a_id, p.key, p.name, kc, c.name);
      -- the real name is the one shown, however many nights carried the bill's
      update artist_history_shows h set tour = p.name
       where h.artist_id = a_id and h.tour <> p.name and public.artist_tour_gkey(a_id, h.tour) = p.key;
      update tour_candidates set name = p.name where id = c.id;
      folds := folds + 1;
      kc := p.key;
    end loop;
  end loop;
  -- 1c. Two tours on the page alike in name whose runs overlap or touch ("Warped Tour 2010" / "Vans Warped Tour 2010"): one tour.
  for g in
    with grp as (select gr.gk as key, mode() within group (order by h.tour) as name, count(*) as n, min(h.date) as first, max(h.date) as last
                   from artist_history_shows h join public.artist_tour_groups(a_id) gr on gr.tour = h.tour
                  where h.artist_id = a_id and not gr.hidden group by gr.gk)
    select s.key as small_key, s.name as small_name, b.key as big_key, b.name as big_name
      from grp s join grp b on b.key <> s.key and b.n >= s.n and (b.n > s.n or b.key > s.key)
     where public.tour_names_alike(s.key, b.key)
       and s.first <= b.last + 14 and b.first <= s.last + 14
  loop
    perform public.tour_fold_one(a_id, g.big_key, g.big_name, g.small_key, g.small_name);
    folds := folds + 1;
  end loop;
  -- 2. A tiny tour whose every night sits inside another tour's run.
  for g in
    with grp as (select public.artist_tour_gkey(a_id, h.tour) as key, mode() within group (order by h.tour) as name, count(*) as n,
                        array_agg(h.date order by h.date) as dates
                   from artist_history_shows h where h.artist_id = a_id and h.tour <> ''
                    and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.artist_tour_gkey(a_id, h.tour))
                  group by 1)
    select s.key as small_key, s.name as small_name, b.key as big_key, b.name as big_name
      from grp s
      join lateral (
        select o.key, o.name from grp o
         where o.key <> s.key and o.n >= 5
           and not exists (select 1 from unnest(s.dates) sd
                            where not exists (select 1 from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = o.key and h.date between sd - 6 and sd - 1)
                               or not exists (select 1 from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = o.key and h.date between sd + 1 and sd + 6))
         order by o.n desc limit 1) b on true
     where s.n <= 3 and not public.tour_is_festival(s.name)  -- a festival inside a run is still a festival
  loop
    perform public.tour_fold_one(a_id, g.big_key, g.big_name, g.small_key, g.small_name);
    folds := folds + 1;
  end loop;
  return folds;
end $$;
revoke all on function public.tour_find_fold(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
