-- Trust by default, correct by a swipe (Devin, 2026-10-08: "When an artist
-- page is started it automatically grabs both the setlist.fm and the
-- greenroom scanning and puts all the tours underneath tours … by default
-- our app should just trust the information it gets … slide a tour to the
-- left and it will say 'edit'").
--  1. Every page with a road story is searched by itself (claimed or not),
--     paced as before (one start a tick, ten a day, under the month's meter).
--  2. Everything found goes on the page. A tie is settled, never asked: the
--     fuller find wins. Nothing is left for the owner to add or take off.
--  3. The owner corrects a tour from the Tours tab: rename it, or remove it.
--     Corrections live in their own table and are applied when the summary
--     is built, so the nightly setlist.fm re-sync can't undo them.

-- 3. Corrections.
create table if not exists public.artist_tour_edits (
  artist_id uuid not null references public.artists (id) on delete cascade,
  key text not null,
  new_name text not null default '',
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (artist_id, key)
);
alter table public.artist_tour_edits enable row level security;
revoke all on public.artist_tour_edits from public, anon, authenticated;

-- The key a tour name stands for: a corrected name points back at the key it was given to.
create or replace function public.artist_tour_key_of(a_id uuid, tour_name text)
returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select e.key from artist_tour_edits e where e.artist_id = a_id and e.new_name <> '' and lower(e.new_name) = lower(btrim(tour_name)) limit 1),
                  public.setlist_tour_key(tour_name))
$$;
revoke all on function public.artist_tour_key_of(uuid, text) from public, anon, authenticated;

create or replace function public.artist_tour_edit(a_id uuid, tour_name text, new_name text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare k text; nm text;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  nm := left(btrim(regexp_replace(coalesce(new_name, ''), '\s+', ' ', 'g')), 120);
  if char_length(nm) < 2 then raise exception 'bad input' using errcode = '22023'; end if;
  k := public.artist_tour_key_of(a_id, tour_name);
  insert into artist_tour_edits (artist_id, key, new_name) values (a_id, k, nm)
  on conflict (artist_id, key) do update set new_name = excluded.new_name, hidden = false;
  return public.setlist_summarize(a_id);
end $$;
revoke all on function public.artist_tour_edit(uuid, text, text) from public, anon;
grant execute on function public.artist_tour_edit(uuid, text, text) to authenticated;

create or replace function public.artist_tour_remove(a_id uuid, tour_name text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare k text;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  k := public.artist_tour_key_of(a_id, tour_name);
  insert into artist_tour_edits (artist_id, key, hidden) values (a_id, k, true)
  on conflict (artist_id, key) do update set hidden = true;
  -- Nights the finder made up for this tour go; nights setlist.fm knows stay as shows, unnamed in the summary.
  delete from artist_history_shows h where h.artist_id = a_id and h.pinned and public.setlist_tour_key(h.tour) = k;
  update tour_candidates set status = 'no', decided_at = now() where artist_id = a_id and status in ('new', 'added') and public.setlist_tour_key(name) = k;
  return public.setlist_summarize(a_id);
end $$;
revoke all on function public.artist_tour_remove(uuid, text) from public, anon;
grant execute on function public.artist_tour_remove(uuid, text) to authenticated;

-- The summary honours the corrections: a renamed tour wears its new name, a removed one is left out of the tours.
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
          and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.setlist_tour_key(h2.tour))
        group by public.setlist_tour_key(h2.tour)) x),
    'years', coalesce((select jsonb_object_agg(y, n) from (
       select extract(year from h3.date)::int as y, count(*) as n
         from artist_history_shows h3
        where h3.artist_id = a_id and h3.date is not null
        group by 1) yy), '{}'::jsonb),
    'toursList', coalesce((select jsonb_agg(jsonb_build_object(
         'name', coalesce(nullif((select e.new_name from artist_tour_edits e where e.artist_id = a_id and e.key = t.key and not e.hidden), ''), t.name),
         'n', t.n, 'first', t.first, 'last', t.last)
         order by t.last desc nulls last)
       from (
         select public.setlist_tour_key(h4.tour) as key, mode() within group (order by h4.tour) as name, count(*) as n,
                min(h4.date) as first, max(h4.date) as last
           from artist_history_shows h4
          where h4.artist_id = a_id and h4.tour <> ''
            and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.setlist_tour_key(h4.tour))
          group by public.setlist_tour_key(h4.tour)
          order by max(h4.date) desc nulls last
          limit 60) t), '[]'::jsonb),
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

-- A tour's nights, by the name the page shows (a corrected name finds its nights too).
create or replace function public.artist_tour_nights(a_id uuid, tour_name text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then null else coalesce((
    select jsonb_agg(jsonb_build_object('date', h.date, 'city', h.city, 'state', h.state, 'country', h.country_code,
                                        'venue', h.venue, 'url', h.url, 'announced', h.pinned)
                     order by h.date)
      from artist_history_shows h
     where h.artist_id = a_id and h.tour <> '' and public.setlist_tour_key(h.tour) = public.artist_tour_key_of(a_id, tour_name)
       and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.setlist_tour_key(h.tour))), '[]'::jsonb) end
$$;
revoke all on function public.artist_tour_nights(uuid, text) from public, anon;
grant execute on function public.artist_tour_nights(uuid, text) to authenticated;

-- A removed tour is never put back by the finder.
create or replace function public.tour_find_apply(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; d jsonb; n int := 0; cc text; ct text; src text;
begin
  delete from artist_history_shows p
   where p.artist_id = a_id and p.pinned
     and exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = p.date and not h.pinned);
  for c in select * from tour_candidates where artist_id = a_id and status = 'added' and first_day is not null and last_day is not null
            and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.setlist_tour_key(tour_candidates.name))
            order by last_day - first_day asc
  loop
    if c.name <> '' then
      update artist_history_shows h set tour = c.name, named_by = c.id
       where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date);
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

-- 2. Trust: everything that adds something goes on; a tie is settled by the fuller find; the rest is let go.
create or replace function public.tour_find_autofill(a_id uuid, trusted boolean default false)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; k int := 0; adds boolean; names boolean; rival uuid;
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
    if not (adds or names or c.fill) then
      update tour_candidates set status = 'no', decided_at = now() where id = c.id;
      continue;
    end if;
    -- A real tie that the weighing left: this one (the fuller) stays, the others go.
    if c.name <> '' then
      for rival in select o.id from tour_candidates o
                    where o.artist_id = a_id and o.status = 'new' and o.id <> c.id and o.name <> ''
                      and o.first_day is not null and o.last_day is not null
                      and o.first_day <= c.last_day + 1 and c.first_day <= o.last_day + 1
                      and (exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.tour = ''
                                     and public.tour_cand_night(c, h.date) and public.tour_cand_night(o, h.date))
                           or exists (select 1 from jsonb_array_elements(c.dates) x join jsonb_array_elements(o.dates) y on x ->> 'date' = y ->> 'date'))
      loop
        update tour_candidates set status = 'no', decided_at = now() where id = rival;
      end loop;
    end if;
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

-- 1. Every page with a road story is searched by itself.
create or replace function public.tour_find_next_auto()
returns uuid
language sql stable security definer set search_path = public as $$
  select a.id from artists a
    join artist_history h on h.artist_id = a.id and h.status = 'ok'
    left join tour_finds f on f.artist_id = a.id
   where (f.artist_id is null or (f.status in ('done', 'error') and coalesce(f.finished_at, f.started_at) < now() - interval '30 days'))
     and not exists (select 1 from tour_finds g where g.artist_id = a.id and g.day = current_date)
   order by (a.owner_id is not null) desc, f.finished_at nulls first, a.created_at
   limit 1
$$;
revoke all on function public.tour_find_next_auto() from public, anon, authenticated;

create or replace function public.tour_find_tick()
returns int
language plpgsql volatile security definer set search_path = public as $$
declare f record; n int := 0; nxt uuid; who uuid;
begin
  for f in select artist_id from tour_finds where status = 'reading' and started_at > now() - interval '2 hours'
  loop
    perform public.tour_find_absorb(f.artist_id);
    n := n + public.tour_find_fire(f.artist_id);
  end loop;
  for f in select artist_id from tour_finds where status in ('ready', 'thinking') and started_at > now() - interval '3 hours'
  loop
    n := n + public.tour_find_brain(f.artist_id);
  end loop;
  update tour_finds set status = 'error', detail = 'Reading took too long. Try again.'
   where status = 'reading' and started_at <= now() - interval '2 hours';
  for f in select artist_id from tour_finds where status = 'thinking' and started_at <= now() - interval '3 hours'
  loop
    perform public.tour_find_finish(f.artist_id, 'Stopped after three hours;');
  end loop;
  if public.tour_find_key() is not null
     and (select count(*) from tour_finds t where t.auto and t.started_at > now() - interval '24 hours') < 10
     and not exists (select 1 from tour_finds t where t.status in ('reading', 'ready', 'thinking', 'extracting') and t.started_at > now() - interval '3 hours') then
    nxt := public.tour_find_next_auto();
    if nxt is not null then
      -- The page's owner, else whoever made it, else the house.
      select coalesce(a.owner_id, a.created_by, (select p.user_id from platform_admins p limit 1)) into who from artists a where a.id = nxt;
      if who is not null then
        perform public.tour_find_begin(nxt, who, true);
        n := n + 1;
      end if;
    end if;
  end if;
  if to_char(now(), 'HH24:MI') = '06:10' and extract(second from now()) < 15 then
    for f in select distinct artist_id from tour_candidates where status = 'added' loop
      perform public.tour_find_apply(f.artist_id);
      perform public.setlist_summarize(f.artist_id);
    end loop;
  end if;
  return n;
end $$;
revoke all on function public.tour_find_tick() from public, anon, authenticated;

notify pgrst, 'reload schema';
