-- A touring festival is a tour (2026-10-09). Warped Tour and Taste of Chaos were
-- tagged "festival" in the Tours list, the tag sitting on the tour Devin is on
-- right now. Only a festival of a night or three is tagged one; a touring
-- festival reads as the tour it is, and the page's festival count is the
-- one-off festivals only.

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
    'festivals', (select count(distinct h6.festival) from artist_history_shows h6
                   where h6.artist_id = a_id and h6.festival <> '' and h6.date <= current_date
                     and public.artist_tour_gkey(a_id, h6.festival) not in (select g.gk from tg g where not g.hidden)),
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
         -- a touring festival (Warped, Taste of Chaos) is a tour; only a festival of a night or three is tagged one
         'kind', case when t.n <= 3 and t.gk in (select public.artist_tour_gkey(a_id, f.festival) from artist_history_shows f where f.artist_id = a_id and f.festival <> '') then 'festival' else 'tour' end)
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

notify pgrst, 'reload schema';
