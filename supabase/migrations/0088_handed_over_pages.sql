-- A page the owner hands over (Devin, 2026-10-08: Concert Archives "shows all
-- the info on each show including the tour name, the bands that were on the
-- tour, the venue, and the city. We need to integrate this"). That site turns
-- automated readers away, so the owner copies or saves the page and hands it
-- to Greenroom. What they hand over is theirs to vouch for:
--  1. Trusted: every tour on it goes on the page by itself, even one with a
--     single date (the archives' two-date rule is for articles, not for a
--     list the owner handed over). Ties are still asked about.
--  2. One-off shows — nights with no tour name on the list — land as nights
--     with no tour name, never as pretend tours. They come in one item per
--     year with an empty name, and only the nights the page lacks are added.

create or replace function public.tour_find_propose_in(a_id uuid, cands jsonb)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c jsonb; nm text; key text; fd date; ld date; n int := 0; ds jsonb; have_name text; missing int;
begin
  if jsonb_typeof(cands) <> 'array' then return 0; end if;
  for c in select * from jsonb_array_elements(cands) limit 160
  loop
   begin
    nm := left(btrim(regexp_replace(coalesce(c ->> 'name', ''), '\s+', ' ', 'g')), 120);
    fd := case when (c ->> 'start') ~ '^\d{4}-\d{2}-\d{2}$' then (c ->> 'start')::date
               when (c ->> 'start') ~ '^\d{4}-\d{2}$' then ((c ->> 'start') || '-01')::date end;
    ld := case when (c ->> 'end') ~ '^\d{4}-\d{2}-\d{2}$' then (c ->> 'end')::date
               when (c ->> 'end') ~ '^\d{4}-\d{2}$' then (((c ->> 'end') || '-01')::date + interval '1 month' - interval '1 day')::date end;
    if fd is null or ld is null or ld < fd or ld - fd > 400 or fd < date '1980-01-01' or fd > current_date + 400 then continue; end if;
    -- Dates come as objects or as the compact line "YYYY-MM-DD | City, ST | Venue": both read.
    select coalesce(jsonb_agg(d order by d ->> 'date'), '[]'::jsonb) into ds
      from (select public.tour_find_date(x) as d
              from jsonb_array_elements(case when jsonb_typeof(c -> 'dates') = 'array' then c -> 'dates' else '[]'::jsonb end) x) q
     where d is not null and (d ->> 'date')::date between fd - 1 and ld + 1;
    if nm = '' then
      -- One-off shows: only the nights the page doesn't have yet, under no name.
      select coalesce(jsonb_agg(d order by d ->> 'date'), '[]'::jsonb) into ds
        from jsonb_array_elements(ds) d
       where not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (d ->> 'date')::date);
      if jsonb_array_length(ds) = 0 then continue; end if;
      insert into tour_candidates (artist_id, name, role, first_day, last_day, region, lineup, dates, sources, fill)
      values (a_id, '', '', fd, ld, left(coalesce(c ->> 'region', ''), 60), '', ds,
        (select coalesce(jsonb_agg(left(s, 300)), '[]'::jsonb) from (
           select distinct s from jsonb_array_elements_text(case when jsonb_typeof(c -> 'sources') = 'array' then c -> 'sources' else '[]'::jsonb end) s
            where s like 'https://%' limit 6) x), false);
      n := n + 1;
      continue;
    end if;
    if char_length(nm) < 2 then continue; end if;
    key := public.setlist_tour_key(nm);
    if exists (select 1 from tour_candidates t where t.artist_id = a_id and t.name <> '' and public.setlist_tour_key(t.name) = key) then continue; end if;
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
  return n;
end $$;
revoke all on function public.tour_find_propose_in(uuid, jsonb) from public, anon, authenticated;

-- Autofill: proof for the archives' finds; the owner's word for a handed-over page.
drop function if exists public.tour_find_autofill(uuid);
create or replace function public.tour_find_autofill(a_id uuid, trusted boolean default false)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; k int := 0; useful boolean; tie boolean; adds boolean;
begin
  for c in select * from tour_candidates where artist_id = a_id and status = 'new' and not auto and first_day is not null and last_day is not null order by first_day, id
  loop
    adds := exists (select 1 from jsonb_array_elements(c.dates) x
                     where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'date')::date <= current_date
                       and not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (x ->> 'date')::date));
    if c.name = '' then
      -- One-off shows name nothing; they only add nights.
      if not adds then continue; end if;
      update tour_candidates set status = 'added', decided_at = now(), auto = true where id = c.id;
      k := k + 1;
      continue;
    end if;
    useful := c.fill
      or exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date))
      or ((trusted or jsonb_array_length(c.dates) >= 2) and adds);
    if not useful then continue; end if;
    tie := exists (select 1 from tour_candidates o
                    where o.artist_id = a_id and o.status = 'new' and o.id <> c.id and o.name <> ''
                      and o.first_day is not null and o.last_day is not null
                      and o.first_day <= c.last_day + 1 and c.first_day <= o.last_day + 1
                      and (exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.tour = ''
                                     and public.tour_cand_night(c, h.date) and public.tour_cand_night(o, h.date))
                           or exists (select 1 from jsonb_array_elements(c.dates) x join jsonb_array_elements(o.dates) y on x ->> 'date' = y ->> 'date')));
    if tie then continue; end if;
    update tour_candidates set status = 'added', decided_at = now(), auto = true where id = c.id;
    k := k + 1;
  end loop;
  if k > 0 then
    perform public.tour_find_apply(a_id);
    perform public.setlist_summarize(a_id);
  end if;
  return k;
end $$;
revoke all on function public.tour_find_autofill(uuid, boolean) from public, anon, authenticated;

-- The phone's proposing, with the owner's word when it's a handed-over page or poster.
drop function if exists public.tour_find_propose(uuid, jsonb, jsonb);
create or replace function public.tour_find_propose(a_id uuid, cands jsonb, read_urls jsonb default null, trusted boolean default false)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare n int; k int;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  if jsonb_typeof(cands) <> 'array' then raise exception 'bad input' using errcode = '22023'; end if;
  n := public.tour_find_propose_in(a_id, cands);
  if jsonb_typeof(read_urls) = 'array' then
    update tour_find_pages g set read_at = now()
     where g.artist_id = a_id and g.read_at is null and read_urls ? g.url;
  end if;
  k := public.tour_find_autofill(a_id, coalesce(trusted, false));
  update tour_finds set status = 'done', extracting_at = null, finished_at = coalesce(finished_at, now())
   where artist_id = a_id and status in ('ready', 'extracting', 'done');
  return public.tour_find_state(a_id) || jsonb_build_object('added', n, 'filled', k);
end $$;
revoke all on function public.tour_find_propose(uuid, jsonb, jsonb, boolean) from public, anon;
grant execute on function public.tour_find_propose(uuid, jsonb, jsonb, boolean) to authenticated;

-- One-off nights never take a tour name (apply writes c.name = '' onto nights
-- that already have none: harmless, but they shouldn't carry named_by either,
-- so a Take off of the one-off batch removes only the nights it added).
create or replace function public.tour_find_apply(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; d jsonb; n int := 0; cc text; ct text;
begin
  delete from artist_history_shows p
   where p.artist_id = a_id and p.pinned
     and exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = p.date and not h.pinned);
  for c in select * from tour_candidates where artist_id = a_id and status = 'added' and first_day is not null and last_day is not null
            order by last_day - first_day asc
  loop
    if c.name <> '' then
      update artist_history_shows h set tour = c.name, named_by = c.id
       where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date);
    end if;
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
              c.name, '', true, c.id, now())
      on conflict (artist_id, id) do nothing;
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;
revoke all on function public.tour_find_apply(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
