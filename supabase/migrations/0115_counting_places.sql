-- Counting places properly (2026-10-09). Checking the I See Stars numbers against
-- the page's own rows turned up three counting faults, all from mixing sources:
--  * cities: setlist.fm writes "Michigan", the finder writes "MI", and the count
--    took them for two places, so any city with both kinds of night counted
--    twice (513 where there are about 400). States now reduce to one code
--    either way, and "Mt. Clemens" / "Mount Clemens", "Ft. Collins" / "Fort
--    Collins", "Kettering (Dayton)" / "Kettering" are one city.
--  * countries: a place name the parser did not know ("Toronto, ONT",
--    "Louisville, Kentucky", "Pretoria, South Africa") became its own country
--    code. Full state and province names resolve now, more countries are known,
--    and only real two-letter codes are counted.
--  * tours: a one-day festival carried as a tour label counted as a tour. A
--    festival of a night or three is listed as a festival and not counted
--    among the tours.

create or replace function public.road_region(state text)
returns text
language sql immutable as $$
  select case when btrim(coalesce(state, '')) ~ '^[A-Za-z]{2}$' then upper(btrim(state))
              else coalesce(public.region_code(state), '') end
$$;
revoke all on function public.road_region(text) from public, anon, authenticated;

create or replace function public.road_city_key(city text)
returns text
language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           lower(regexp_replace(coalesce(city, ''), '\s*\(.*\)\s*', ' ', 'g')),
           '\.', '', 'g'), '^saint ', 'st '), '^mount ', 'mt '), '^fort ', 'ft '), '^new york city$', 'new york'), '\s+', ' ', 'g'))
$$;
revoke all on function public.road_city_key(text) from public, anon, authenticated;

create or replace function public.road_country(city text)
returns text
language sql immutable as $$
  select case
    when coalesce(city, '') not like '%,%' then ''
    else (
      select case
        when x.t = any (array[
          'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
          'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
          'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
          'USA','US','UNITED STATES','UNITED STATES OF AMERICA']) then 'US'
        when x.t = any (array['ON','QC','BC','AB','MB','SK','NS','NB','PE','YT','NT','NU','NL','CANADA',
          'ONT','QUE','ALTA','SASK','MAN','NFLD','PEI']) then 'CA'
        -- a state or province written out in full ("Louisville, Kentucky", "Toronto, Ontario")
        when x.r = any (array['ON','QC','BC','AB','MB','SK','NS','NB','PE','YT','NT','NU','NL']) then 'CA'
        when x.r <> '' then 'US'
        else coalesce((
          select m.code from (values
            ('UK','GB'),('UNITED KINGDOM','GB'),('ENGLAND','GB'),('SCOTLAND','GB'),('WALES','GB'),('NORTHERN IRELAND','GB'),('GREAT BRITAIN','GB'),
            ('GERMANY','DE'),('FRANCE','FR'),('SPAIN','ES'),('ITALY','IT'),('NETHERLANDS','NL'),('THE NETHERLANDS','NL'),('HOLLAND','NL'),('BELGIUM','BE'),
            ('AUSTRIA','AT'),('SWITZERLAND','CH'),('SWEDEN','SE'),('NORWAY','NO'),('DENMARK','DK'),('FINLAND','FI'),('ICELAND','IS'),
            ('POLAND','PL'),('CZECHIA','CZ'),('CZECH REPUBLIC','CZ'),('IRELAND','IE'),('PORTUGAL','PT'),('HUNGARY','HU'),
            ('ROMANIA','RO'),('LUXEMBOURG','LU'),('ESTONIA','EE'),('LATVIA','LV'),('LITHUANIA','LT'),('RUSSIA','RU'),
            ('UKRAINE','UA'),('BELARUS','BY'),('SLOVAKIA','SK'),('SLOVENIA','SI'),('CROATIA','HR'),('SERBIA','RS'),('BULGARIA','BG'),
            ('GREECE','GR'),('TURKEY','TR'),('ISRAEL','IL'),('UNITED ARAB EMIRATES','AE'),('UAE','AE'),
            ('AUSTRALIA','AU'),('NEW ZEALAND','NZ'),('JAPAN','JP'),('CHINA','CN'),('SOUTH KOREA','KR'),('KOREA','KR'),
            ('TAIWAN','TW'),('HONG KONG','HK'),('INDIA','IN'),
            ('SINGAPORE','SG'),('MALAYSIA','MY'),('THAILAND','TH'),('VIETNAM','VN'),('PHILIPPINES','PH'),
            ('INDONESIA','ID'),('MEXICO','MX'),('BRAZIL','BR'),('BRASIL','BR'),('ARGENTINA','AR'),('CHILE','CL'),('COLOMBIA','CO'),
            ('PERU','PE'),('URUGUAY','UY'),('PARAGUAY','PY'),('ECUADOR','EC'),('VENEZUELA','VE'),('COSTA RICA','CR'),
            ('PANAMA','PA'),('GUATEMALA','GT'),('PUERTO RICO','PR'),('SOUTH AFRICA','ZA')
          ) m(name, code) where m.name = x.t),
          -- a leftover two-letter code is taken as the country's; anything else unknown is no country at all
          case when x.t ~ '^[A-Z]{2}$' then x.t else '' end)
      end
      from (select upper(btrim(substring(city from ',([^,]*)$'))) as t,
                   upper(coalesce(public.region_code(btrim(substring(city from ',([^,]*)$'))), '')) as r) x)
  end
$$;

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
    'countries', count(distinct country_code) filter (where country_code ~ '^[A-Z]{2}$' and h.date <= current_date),
    'cities', count(distinct (country_code, case when country_code in ('US', 'CA') then public.road_region(state) else '' end, public.road_city_key(city))) filter (where city <> '' and h.date <= current_date),
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

create or replace function public.road_stats(u uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  with gr as (
    select (e.v ->> 'date') as d,
           lower(btrim(coalesce(e.v ->> 'venue', ''))) as venue,
           public.road_city_key(split_part(coalesce(e.v ->> 'city', ''), ',', 1)) as city,
           public.road_country(e.v ->> 'city') as ctry,
           case when public.road_country(e.v ->> 'city') in ('US', 'CA')
                 and upper(btrim(substring(e.v ->> 'city' from ',([^,]*)$'))) ~ '^[A-Z]{2}$'
                then upper(btrim(substring(e.v ->> 'city' from ',([^,]*)$'))) else '' end as region
      from public.tours_of(u) t,
           lateral jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e(k, v)
     where jsonb_typeof(e.v) = 'object'
       and (e.v ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
       and (e.v ->> 'date') <= to_char(current_date, 'YYYY-MM-DD')
  ), cr as (
    select s.artist_id, s.tour, to_char(s.d, 'YYYY-MM-DD') as d,
           lower(btrim(coalesce(s.venue, ''))) as venue,
           public.road_city_key(s.city) as city, upper(s.country_code) as ctry,
           case when upper(s.country_code) in ('US', 'CA') then public.road_region(s.state) else '' end as region,
           exists (select 1 from gr g where g.d = to_char(s.d, 'YYYY-MM-DD')) as dup
      from public.credited_shows(u) s
     where s.d is not null and s.d <= current_date
  ), nights as (
    select d, venue, city, ctry, region from gr
    union all
    select d, venue, city, ctry, region from cr where not dup
  )
  select jsonb_build_object(
    -- the artist's tours, counted exactly as the artist page counts them, plus the person's own
    -- Greenroom tours that are not already in a band's book (half or more of a tour's dates there)
    'tours', (select count(*) from (
                select 1 from cr c join lateral public.artist_tour_groups(c.artist_id) g on g.tour = c.tour
                 where c.tour <> '' and not g.hidden
                 group by c.artist_id, g.gk) x)
           + (select count(*) from public.tours_of(u) t
               where (select count(*) from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end) e
                       where (e.value ->> 'date') in (select c.d from cr c)) * 2
                     < greatest(1, (select count(*) from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object' then t.doc -> 'shows' else '{}'::jsonb end)))),
    'shows', (select count(distinct (d, venue)) from nights),
    'cities', (select count(distinct (ctry, region, city)) from nights where city <> ''),
    'countries', (select count(distinct ctry) from nights where ctry ~ '^[A-Z]{2}$'),
    'firstYear', (select left(min(d), 4)::int from nights))
$$;
revoke all on function public.road_stats(uuid) from public, anon, authenticated;

create or replace function public.festival_tag(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int := 0; k int;
begin
  update artist_history_shows h set festival = h.tour
   where h.artist_id = a_id and h.festival = '' and h.tour <> ''
     and public.tour_is_festival(h.tour) and not public.tour_find_madeup(h.tour);
  get diagnostics k = row_count; n := n + k;
  update artist_history_shows h set festival = c.name
    from tour_candidates c
   where h.artist_id = a_id and h.festival = '' and c.artist_id = a_id and c.status = 'added' and c.name <> ''
     and public.tour_is_festival(c.name) and not public.tour_find_madeup(c.name)
     and exists (select 1 from jsonb_array_elements(c.dates) x
                  where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'date')::date = h.date);
  get diagnostics k = row_count; n := n + k;
  update artist_history_shows h set festival = m.f
    from (select h2.id, public.festival_grounds_match(h2.venue, h2.city, h2.country_code, h2.date) as f
            from artist_history_shows h2
           where h2.artist_id = a_id and h2.festival = ''
             and (h2.tour = '' or public.tour_is_festival(h2.tour) or h2.venue ~* '\mstage\M')) m
   where h.artist_id = a_id and h.id = m.id and m.f is not null;
  get diagnostics k = row_count; n := n + k;
  -- A festival of a night or three is not a tour: its name lives in the festival column only, so
  -- it is listed as a festival and not counted among the tours (a touring festival, Warped, stays).
  with g as (select * from public.artist_tour_groups(a_id)),
       small as (select g.gk from artist_history_shows o join g on g.tour = o.tour
                  where o.artist_id = a_id group by g.gk having count(distinct (o.date, lower(o.venue))) <= 3)
  update artist_history_shows h set tour = '', named_by = null
    from g
   where h.artist_id = a_id and g.tour = h.tour and h.festival <> '' and h.tour <> ''
     and g.gk in (select s.gk from small s)
     and public.setlist_tour_key(h.tour) = public.setlist_tour_key(h.festival);
  return n;
end $$;
revoke all on function public.festival_tag(uuid) from public, anon, authenticated;

-- Nights already carrying a place name where a country code belongs: re-read through the parser.
update public.artist_history_shows h
   set country_code = public.road_country('x, ' || h.country_code)
 where h.country_code <> '' and h.country_code !~ '^[A-Z]{2}$';
update public.artist_history_shows h
   set state = case when h.state = '' and h.country in ('ONT', 'QUE') then left(h.country, 2) else h.state end,
       country = case h.country_code when 'CA' then 'Canada' when 'US' then 'United States' else h.country end
 where h.pinned and h.country_code in ('US', 'CA') and h.country not in ('United States', 'Canada');
update public.artist_history_shows h
   set country = coalesce((select o.country from public.artist_history_shows o
                            where o.country_code = h.country_code and not o.pinned and char_length(o.country) > 3 limit 1), h.country)
 where h.pinned and h.country_code ~ '^[A-Z]{2}$' and char_length(h.country) <= 3;

notify pgrst, 'reload schema';
