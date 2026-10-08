-- All of a tour's nights under the tour (Devin, 2026-10-08: "These tours being
-- listed some only have single digit amount of shows … When you scan and
-- find tours/dates they should ALL be listed under each tour").
--  1. Folding: a found tour and a page tour that are the same tour under two
--     spellings ("2011 Scream It Like You Mean It Tour" / "Scream It Like You
--     Mean It 2011"; "AP Tour" / "AP Tour Spring 2011") become one, under the
--     spelling that holds more nights. The fold is an alias in
--     artist_tour_edits, honoured when the summary groups the nights, so the
--     nightly setlist.fm re-sync can't split them again.
--  2. Taking over: a night the announcement lists for a tour goes under that
--     tour even when setlist.fm had another label on it (its album names —
--     "Digital Renegade", "New Demons", "3-D" — sit on nights that were real
--     tours). A night another find pinned is never taken.

alter table public.artist_tour_edits add column if not exists alias_key text not null default '';

-- The key a tour name groups under, after aliases (one hop; folds always point at a terminal key).
create or replace function public.artist_tour_gkey(a_id uuid, tour text)
returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif((select e.alias_key from artist_tour_edits e where e.artist_id = a_id and e.key = public.setlist_tour_key(tour)), ''), public.setlist_tour_key(tour))
$$;
revoke all on function public.artist_tour_gkey(uuid, text) from public, anon, authenticated;

create or replace function public.artist_tour_key_of(a_id uuid, tour_name text)
returns text
language sql stable security definer set search_path = public as $$
  select public.artist_tour_gkey(a_id, coalesce(
    (select h.tour from artist_tour_edits e join artist_history_shows h on h.artist_id = a_id and public.setlist_tour_key(h.tour) = e.key
      where e.artist_id = a_id and e.new_name <> '' and lower(e.new_name) = lower(btrim(tour_name)) limit 1),
    tour_name))
$$;
revoke all on function public.artist_tour_key_of(uuid, text) from public, anon, authenticated;

-- Two names for the same tour? The words of their keys: one inside the other, or most of them shared.
create or replace function public.tour_names_alike(ka text, kb text)
returns boolean
language plpgsql immutable as $$
declare a text[] := string_to_array(coalesce(ka, ''), ' '); b text[] := string_to_array(coalesce(kb, ''), ' '); shared int;
begin
  if coalesce(ka, '') = '' or coalesce(kb, '') = '' then return false; end if;
  if a <@ b or b <@ a then return true; end if;
  select count(*) into shared from unnest(a) x where x = any (b);
  return shared::numeric >= 0.6 * least(cardinality(a), cardinality(b));
end $$;
revoke all on function public.tour_names_alike(text, text) from public, anon, authenticated;

-- 1. Folding.
create or replace function public.tour_find_fold(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c record; p record; folds int := 0; kc text; win_key text; win_name text; lose_key text;
begin
  for c in select t.id, t.name, t.dates from tour_candidates t where t.artist_id = a_id and t.status = 'added' and t.name <> '' and jsonb_array_length(t.dates) > 0
  loop
    kc := public.artist_tour_gkey(a_id, c.name);
    -- Page tours holding this find's listed nights under another key, alike in name.
    for p in select public.artist_tour_gkey(a_id, h.tour) as key, mode() within group (order by h.tour) as name, count(*) as held
               from jsonb_array_elements(c.dates) d join artist_history_shows h on h.artist_id = a_id and h.date = (d ->> 'date')::date and h.tour <> ''
              where public.artist_tour_gkey(a_id, h.tour) <> kc
              group by 1
    loop
      if not public.tour_names_alike(kc, p.key) then continue; end if;
      -- The spelling that holds more nights on the page stays.
      if (select count(*) from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = p.key)
         >= (select count(*) from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = kc) then
        win_key := p.key; win_name := p.name; lose_key := kc;
        update tour_candidates set name = p.name where id = c.id;
      else
        win_key := kc; lose_key := p.key;
        select mode() within group (order by h.tour) into win_name from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = kc;
      end if;
      insert into artist_tour_edits (artist_id, key, alias_key) values (a_id, lose_key, win_key)
      on conflict (artist_id, key) do update set alias_key = excluded.alias_key, hidden = false;
      -- Anything that pointed at the loser now points at the winner.
      update artist_tour_edits set alias_key = win_key where artist_id = a_id and alias_key = lose_key;
      folds := folds + 1;
      kc := win_key;
    end loop;
  end loop;
  return folds;
end $$;
revoke all on function public.tour_find_fold(uuid) from public, anon, authenticated;

-- 2. Taking over, inside apply.
create or replace function public.tour_find_apply(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; d jsonb; n int := 0; cc text; ct text; src text; kc text;
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
    for d in select * from jsonb_array_elements(c.dates)
    loop
      if (d ->> 'date') !~ '^\d{4}-\d{2}-\d{2}$' then continue; end if;
      if (d ->> 'date')::date > current_date then continue; end if;
      if exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (d ->> 'date')::date) then continue; end if;
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
  return n;
end $$;
revoke all on function public.tour_find_apply(uuid) from public, anon, authenticated;

-- The summary groups by the folded key; the name is the most-used spelling in the group (or the owner's).
create or replace function public.setlist_summarize(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s jsonb;
begin
  select jsonb_build_object(
    'shows', count(*),
    'countries', count(distinct country_code) filter (where country_code <> ''),
    'cities', count(distinct (country_code, lower(state), lower(city))) filter (where city <> ''),
    'firstYear', min(extract(year from date))::int,
    'lastYear', max(extract(year from date))::int,
    'tours', (select count(*) from (
       select 1 from artist_history_shows h2
        where h2.artist_id = a_id and h2.tour <> ''
          and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.artist_tour_gkey(a_id, h2.tour))
        group by public.artist_tour_gkey(a_id, h2.tour)) x),
    'years', coalesce((select jsonb_object_agg(y, n) from (
       select extract(year from h3.date)::int as y, count(*) as n
         from artist_history_shows h3
        where h3.artist_id = a_id and h3.date is not null
        group by 1) yy), '{}'::jsonb),
    'toursList', coalesce((select jsonb_agg(jsonb_build_object(
         'name', coalesce(nullif((select e.new_name from artist_tour_edits e where e.artist_id = a_id and e.key = t.key and not e.hidden), ''), t.name),
         'n', t.n + (select count(*) from artist_tour_conflicts cf
                      join artist_history_shows hh on hh.artist_id = a_id and hh.date = cf.date
                     where cf.artist_id = a_id and t.key in (cf.key_a, cf.key_b) and public.artist_tour_gkey(a_id, hh.tour) <> t.key),
         'first', t.first, 'last', t.last,
         'conflict', exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and t.key in (cf.key_a, cf.key_b)))
         order by t.last desc nulls last)
       from (
         select public.artist_tour_gkey(a_id, h4.tour) as key, mode() within group (order by h4.tour) as name, count(*) as n,
                min(h4.date) as first, max(h4.date) as last
           from artist_history_shows h4
          where h4.artist_id = a_id and h4.tour <> ''
            and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.artist_tour_gkey(a_id, h4.tour))
          group by public.artist_tour_gkey(a_id, h4.tour)) t), '[]'::jsonb),
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

create or replace function public.artist_tour_nights(a_id uuid, tour_name text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then null else coalesce((
    select jsonb_agg(x order by x ->> 'date') from (
      select jsonb_build_object('date', h.date, 'city', h.city, 'state', h.state, 'country', h.country_code,
                                'venue', h.venue, 'url', h.url, 'announced', h.pinned,
                                'contested', exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and cf.date = h.date
                                                      and public.artist_tour_key_of(a_id, tour_name) in (cf.key_a, cf.key_b))) as x
        from artist_history_shows h
       where h.artist_id = a_id and h.tour <> ''
         and (public.artist_tour_gkey(a_id, h.tour) = public.artist_tour_key_of(a_id, tour_name)
              or exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and cf.date = h.date
                          and public.artist_tour_key_of(a_id, tour_name) in (cf.key_a, cf.key_b)
                          and public.artist_tour_gkey(a_id, h.tour) in (cf.key_a, cf.key_b)))
         and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.artist_tour_key_of(a_id, tour_name))) q), '[]'::jsonb) end
$$;
revoke all on function public.artist_tour_nights(uuid, text) from public, anon;
grant execute on function public.artist_tour_nights(uuid, text) to authenticated;

-- The check groups by the folded key too (two spellings of one tour are not far from each other).
create or replace function public.tour_fact_check(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare filed int := 0; asked int := 0; r record;
begin
  for r in
    with named as (select h.date, public.artist_tour_gkey(a_id, h.tour) as key, mode() within group (order by h.tour) as name
                     from artist_history_shows h where h.artist_id = a_id and h.tour <> ''
                      and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.artist_tour_gkey(a_id, h.tour))
                    group by h.date, public.artist_tour_gkey(a_id, h.tour))
    select u.date, n.name
      from artist_history_shows u
      join lateral (select distinct b.key, b.name from named b where b.date between u.date - 6 and u.date - 1) n on true
     where u.artist_id = a_id and u.tour = ''
       and exists (select 1 from named a where a.key = n.key and a.date between u.date + 1 and u.date + 6)
       and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = u.date)
       and (select count(distinct b.key) from named b where b.date between u.date - 6 and u.date + 6) = 1
  loop
    update artist_history_shows set tour = r.name where artist_id = a_id and date = r.date and tour = '';
    filed := filed + 1;
  end loop;
  for r in
    with named as (select h.date, public.artist_tour_gkey(a_id, h.tour) as key, mode() within group (order by h.tour) as name
                     from artist_history_shows h where h.artist_id = a_id and h.tour <> ''
                      and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.artist_tour_gkey(a_id, h.tour))
                    group by h.date, public.artist_tour_gkey(a_id, h.tour))
    select u.date, n.key, n.name
      from artist_history_shows u
      join lateral (select distinct b.key, b.name from named b where b.date between u.date - 3 and u.date + 3) n on true
     where u.artist_id = a_id and u.tour = ''
       and (select count(distinct b.key) from named b where b.date between u.date - 3 and u.date + 3) = 1
       and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = u.date)
       and not exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and cf.date = u.date)
  loop
    insert into artist_tour_conflicts (artist_id, date, key_a, key_b, name_a, name_b) values (a_id, r.date, r.key, '', r.name, '') on conflict do nothing;
    asked := asked + 1;
  end loop;
  for r in
    with named as (select h.date, h.tour, public.artist_tour_gkey(a_id, h.tour) as key
                     from artist_history_shows h where h.artist_id = a_id and h.tour <> ''
                      and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.artist_tour_gkey(a_id, h.tour)))
    select n.date, n.key, n.tour
      from named n
     where (select count(*) from named o where o.key = n.key) > 1
       and (select min(abs(o.date - n.date)) from named o where o.key = n.key and o.date <> n.date) > 30
       and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = n.date)
       and not exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and cf.date = n.date)
  loop
    insert into artist_tour_conflicts (artist_id, date, key_a, key_b, name_a, name_b) values (a_id, r.date, r.key, '', r.tour, '') on conflict do nothing;
    asked := asked + 1;
  end loop;
  if filed > 0 or asked > 0 then perform public.setlist_summarize(a_id); end if;
  return jsonb_build_object('filed', filed, 'asked', asked);
end $$;
revoke all on function public.tour_fact_check(uuid) from public, anon, authenticated;

-- Autofill folds before it applies; the sync folds too.
create or replace function public.tour_find_autofill(a_id uuid, trusted boolean default false)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; k int := 0; adds boolean; names boolean; o public.tour_candidates; ka text; kb text;
begin
  perform public.tour_find_untie(a_id);
  for c in select * from tour_candidates where artist_id = a_id and status = 'new' and not auto and first_day is not null and last_day is not null
            order by jsonb_array_length(dates) desc, first_day, id
  loop
    if not exists (select 1 from tour_candidates t where t.id = c.id and t.status = 'new') then continue; end if;
    adds := exists (select 1 from jsonb_array_elements(c.dates) x
                     where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'date')::date <= current_date
                       and not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (x ->> 'date')::date));
    names := c.name <> '' and exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date));
    -- A found tour with listed nights is worth keeping even when the page already has those nights under another label.
    if not (adds or names or c.fill or (c.name <> '' and jsonb_array_length(c.dates) >= 2)) then
      update tour_candidates set status = 'no', decided_at = now() where id = c.id;
      continue;
    end if;
    if c.name <> '' then
      for o in select t.* from tour_candidates t
                where t.artist_id = a_id and t.status = 'new' and t.id <> c.id and t.name <> ''
                  and t.first_day is not null and t.last_day is not null
                  and t.first_day <= c.last_day + 1 and c.first_day <= t.last_day + 1
      loop
        ka := public.setlist_tour_key(c.name); kb := public.setlist_tour_key(o.name);
        if ka = kb then continue; end if;
        insert into artist_tour_conflicts (artist_id, date, key_a, key_b, name_a, name_b)
        select a_id, d, least(ka, kb), greatest(ka, kb), case when ka <= kb then c.name else o.name end, case when ka <= kb then o.name else c.name end
          from (
            select (x ->> 'date')::date as d from jsonb_array_elements(c.dates) x join jsonb_array_elements(o.dates) y on x ->> 'date' = y ->> 'date'
             where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
            union
            select h.date from artist_history_shows h where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date) and public.tour_cand_night(o, h.date)
          ) nights
          where d <= current_date
        on conflict do nothing;
        if found then
          update tour_candidates set status = 'added', decided_at = now(), auto = true where id = o.id;
          k := k + 1;
        end if;
      end loop;
    end if;
    update tour_candidates set status = 'added', decided_at = now(), auto = true where id = c.id;
    k := k + 1;
  end loop;
  perform public.tour_find_fold(a_id);
  perform public.tour_find_apply(a_id);
  perform public.setlist_summarize(a_id);
  perform public.tour_fact_check(a_id);
  return k;
end $$;
revoke all on function public.tour_find_autofill(uuid, boolean) from public, anon, authenticated;

create or replace function public.setlist_finish(one uuid default null)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare a record; n int := 0;
begin
  for a in select ah.artist_id, ah.pass_at from artist_history ah
            where (one is null or ah.artist_id = one)
              and ah.status = 'syncing' and ah.pages > 0 and ah.next_page > ah.pages
              and not exists (select 1 from setlist_requests q where q.artist_id = ah.artist_id)
  loop
    delete from artist_history_shows
     where artist_id = a.artist_id and not pinned and seen < coalesce(a.pass_at, now()) - interval '3 days';
    perform public.tour_find_fold(a.artist_id);
    perform public.tour_find_apply(a.artist_id);
    perform public.tour_fact_check(a.artist_id);
    perform setlist_summarize(a.artist_id);
    update artist_history set status = 'ok', next_page = 0, synced_at = now(), detail = ''
     where artist_id = a.artist_id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.setlist_finish(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
