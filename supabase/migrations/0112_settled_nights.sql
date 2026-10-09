-- What has been settled stays settled, and every night can be opened
-- (2026-10-09). Two gaps the review of the whole pipeline found:
--  1. A correction to one night (this night belongs to that tour, this show
--     moved to another room, this date never happened) lived only on the row,
--     and setlist.fm's next sync, a Stop and Start, or the morning re-apply
--     could undo it; an owner's "not part of this tour" on an announced night
--     came back the next morning, and on a plain show from the band's own
--     page it deleted the show. Now a settled night is written to
--     artist_night_overrides (tour, festival, venue, city, state, or "gone")
--     and re-applied as the last word after every sync, scan and re-apply.
--  2. A show outside any tour or festival could not be seen anywhere on the
--     page. Each year's loose shows now have an entry in the Tours list
--     ("Shows outside a tour · 2009") that opens like a tour.

create table if not exists public.artist_night_overrides (
  artist_id uuid not null references public.artists (id) on delete cascade,
  date date not null,
  tour text,                              -- null = as found
  festival text,
  venue text,
  city text,
  state text,
  gone boolean not null default false,    -- this date did not happen: never shown, never re-added
  note text not null default '',
  source_url text not null default '',
  set_at timestamptz not null default now(),
  primary key (artist_id, date)
);
alter table public.artist_night_overrides enable row level security;
revoke all on public.artist_night_overrides from public, anon, authenticated;

create or replace function public.artist_night_overrides_apply(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int := 0; k int;
begin
  delete from artist_history_shows h using artist_night_overrides o
   where h.artist_id = a_id and o.artist_id = a_id and o.gone and h.date = o.date;
  get diagnostics k = row_count; n := n + k;
  update artist_history_shows h
     set tour = coalesce(o.tour, h.tour), festival = coalesce(o.festival, h.festival),
         venue = coalesce(o.venue, h.venue), city = coalesce(o.city, h.city), state = coalesce(o.state, h.state),
         named_by = case when o.tour is not null and o.tour <> h.tour then null else h.named_by end
    from artist_night_overrides o
   where h.artist_id = a_id and o.artist_id = a_id and not o.gone and h.date = o.date
     and (coalesce(o.tour, h.tour), coalesce(o.festival, h.festival), coalesce(o.venue, h.venue), coalesce(o.city, h.city), coalesce(o.state, h.state))
         is distinct from (h.tour, h.festival, h.venue, h.city, h.state);
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;
revoke all on function public.artist_night_overrides_apply(uuid) from public, anon, authenticated;

create or replace function public.artist_tour_pick(a_id uuid, night date, tour_name text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare nm text; k text; went int := 0;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  nm := left(btrim(regexp_replace(coalesce(tour_name, ''), '\s+', ' ', 'g')), 120);
  if nm = '' then
    -- A night that is on the page only because a tour's announcement listed it goes with the tour;
    -- a night the band's own page (or a handed-over file) listed as a plain show stays, under no tour.
    delete from artist_history_shows h where h.artist_id = a_id and h.date = night and h.pinned
       and exists (select 1 from tour_candidates c where c.id::text = substring(h.id from '^tf:([0-9a-f-]{36}):') and c.name <> '');
    get diagnostics went = row_count;
    update artist_history_shows set tour = '', named_by = null where artist_id = a_id and date = night;
    insert into artist_night_overrides (artist_id, date, tour, gone)
    values (a_id, night, '', went > 0 and not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = night))
    on conflict (artist_id, date) do update set tour = '', gone = excluded.gone, set_at = now();
  else
    k := public.artist_tour_key_of(a_id, nm);
    select coalesce((select h.tour from artist_history_shows h where h.artist_id = a_id and public.setlist_tour_key(h.tour) = k and h.tour <> '' limit 1), nm) into nm;
    update artist_history_shows set tour = nm where artist_id = a_id and date = night;
    insert into artist_night_overrides (artist_id, date, tour, gone) values (a_id, night, nm, false)
    on conflict (artist_id, date) do update set tour = excluded.tour, gone = false, set_at = now();
  end if;
  delete from artist_tour_conflicts where artist_id = a_id and date = night;
  insert into artist_tour_checked (artist_id, date) values (a_id, night) on conflict do nothing;
  perform public.setlist_summarize(a_id);
  return jsonb_build_object('ok', true, 'left', (select count(*) from artist_tour_conflicts cf where cf.artist_id = a_id));
end $$;
revoke all on function public.artist_tour_pick(uuid, date, text) from public, anon;
grant execute on function public.artist_tour_pick(uuid, date, text) to authenticated;

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
       where x.host is not null and x.host in ('concertarchives.org', 'songkick.com', 'bandsintown.com', 'web.archive.org')), '[]'::jsonb)
   where ah.artist_id = a_id;
  perform public.festival_tag(a_id);
  perform public.artist_night_overrides_apply(a_id);
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
    'shows', count(distinct (h.date, lower(h.venue))) filter (where h.date <= current_date),
    'festivals', (select count(distinct h6.festival) from artist_history_shows h6 where h6.artist_id = a_id and h6.festival <> ''),
    'countries', count(distinct country_code) filter (where country_code <> '' and h.date <= current_date),
    'cities', count(distinct (country_code, case when country_code in ('US', 'CA') then public.region_code(state) else '' end, lower(city))) filter (where city <> '' and h.date <= current_date),
    'firstYear', min(extract(year from date))::int,
    'lastYear', max(extract(year from date))::int,
    'tours', (select count(distinct g.gk) from artist_history_shows h2 join tg g on g.tour = h2.tour
               where h2.artist_id = a_id and not g.hidden),
    'years', coalesce((select jsonb_object_agg(y, n) from (
       select extract(year from h3.date)::int as y, count(distinct (h3.date, lower(h3.venue))) as n
         from artist_history_shows h3
        where h3.artist_id = a_id and h3.date is not null and h3.date <= current_date
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
                group by h7.festival) f), '[]'::jsonb)
      -- Shows outside any tour or festival, year by year, so every night on the page can be opened.
      || coalesce((select jsonb_agg(jsonb_build_object('name', 'Shows outside a tour · ' || y.yr, 'key', 'year:' || y.yr, 'n', y.n,
                                    'first', y.first, 'last', y.last, 'lineup', '', 'conflict', false, 'kind', 'shows') order by y.last desc)
         from (select extract(year from h8.date)::int as yr, count(distinct (h8.date, lower(h8.venue))) as n, min(h8.date) as first, max(h8.date) as last
                 from artist_history_shows h8
                where h8.artist_id = a_id and h8.tour = '' and h8.festival = '' and h8.date <= current_date
                group by 1) y), '[]'::jsonb),
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
  with want as (select public.artist_tour_key_of(a_id, tour_name) as gk, substring(tour_name from '^year:(\d{4})$') as yr),
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
         and case when want.yr is not null
                  then h.tour = '' and h.festival = '' and h.date <= current_date and extract(year from h.date)::int = want.yr::int
                  else (g.gk = want.gk
              or (h.festival <> '' and public.artist_tour_gkey(a_id, h.festival) = want.gk)
              or exists (select 1 from artist_tour_conflicts cf where cf.artist_id = a_id and cf.date = h.date
                          and want.gk in (cf.key_a, cf.key_b) and g.gk in (cf.key_a, cf.key_b))) end) q), '[]'::jsonb) end
$$;
revoke all on function public.artist_tour_nights(uuid, text) from public, anon;
grant execute on function public.artist_tour_nights(uuid, text) to authenticated;

notify pgrst, 'reload schema';
