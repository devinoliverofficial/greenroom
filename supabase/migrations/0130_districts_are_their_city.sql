-- A neighbourhood is its city (Devin, 2026-10-10). Asked whether Hollywood
-- counts apart from Los Angeles, Brooklyn and Queens apart from New York,
-- Ancol apart from Jakarta: "this is really subjective. What do most people
-- consider? whatever that answer is should be the way it reflects on the page."
--
-- What most people, and the usual tour tallies, go by: a place counts as the
-- city it is part of. A borough or a neighbourhood is that city (Brooklyn is
-- New York, Hollywood is Los Angeles, Ancol is Jakarta, Borgerhout is
-- Antwerp). A town with its own city hall is its own city even when it sits
-- next door (West Hollywood, Pontiac, Royal Oak, Quezon City stay as they are).
--
-- The list is data, not code: a district that turns up later is one more row.
-- Only the COUNT folds. A night still says the place it was filed under.

create table if not exists public.place_aliases (
  country_code text not null,
  region text not null default '',          -- the state or province's two letters (US and Canada), else ''
  city_key text not null,                   -- as road_city_key writes it
  into_key text not null,                   -- the city it is part of, as road_city_key writes it
  primary key (country_code, region, city_key)
);
alter table public.place_aliases enable row level security;
revoke all on public.place_aliases from public, anon, authenticated;

insert into public.place_aliases (country_code, region, city_key, into_key) values
  ('US', 'NY', 'brooklyn', 'new york'), ('US', 'NY', 'queens', 'new york'), ('US', 'NY', 'bronx', 'new york'),
  ('US', 'NY', 'the bronx', 'new york'), ('US', 'NY', 'manhattan', 'new york'), ('US', 'NY', 'staten island', 'new york'),
  ('US', 'CA', 'hollywood', 'los angeles'), ('US', 'CA', 'north hollywood', 'los angeles'),
  ('US', 'CA', 'van nuys', 'los angeles'), ('US', 'CA', 'san pedro', 'los angeles'),
  ('CA', 'ON', 'north york', 'toronto'), ('CA', 'ON', 'scarborough', 'toronto'), ('CA', 'ON', 'etobicoke', 'toronto'),
  ('GB', '', 'camden', 'london'), ('GB', '', 'camden town', 'london'), ('GB', '', 'islington', 'london'),
  ('GB', '', 'brixton', 'london'), ('GB', '', 'kentish town', 'london'), ('GB', '', 'shepherds bush', 'london'),
  ('GB', '', 'hammersmith', 'london'), ('GB', '', 'wembley', 'london'),
  ('BE', '', 'borgerhout', 'antwerp'), ('BE', '', 'merksem', 'antwerp'), ('BE', '', 'deurne', 'antwerp'), ('BE', '', 'antwerpen', 'antwerp'),
  ('ID', '', 'ancol', 'jakarta'), ('ID', '', 'kota administrasi jakarta utara', 'jakarta'), ('ID', '', 'north jakarta', 'jakarta'),
  ('ID', '', 'south jakarta', 'jakarta'), ('ID', '', 'central jakarta', 'jakarta'), ('ID', '', 'west jakarta', 'jakarta'),
  ('ID', '', 'east jakarta', 'jakarta'),
  ('JP', '', 'shibuya', 'tokyo'), ('JP', '', 'shinjuku', 'tokyo'), ('JP', '', 'minato', 'tokyo'), ('JP', '', 'koto', 'tokyo')
on conflict (country_code, region, city_key) do update set into_key = excluded.into_key;

-- road_place_counts, as 0128 left it, with one step added: a district is read
-- as its city before anything is counted. (It reads the list above, so it is
-- "stable" now, not "immutable".)
create or replace function public.road_place_counts(ctrys text[], regions text[], cities text[])
returns jsonb
language sql stable security definer set search_path = public as $$
  with n0 as (
    select distinct
           -- a Canadian province is in Canada, whatever country the night was filed under
           case when upper(coalesce(t.r, '')) = any (array['ON','QC','BC','AB','MB','SK','NS','NB','PE','YT','NT','NU','NL']) then 'CA'
                else upper(coalesce(t.c, '')) end as ctry,
           upper(coalesce(t.r, '')) as region,
           coalesce(t.k, '') as city
      from unnest(ctrys, regions, cities) as t(c, r, k)
  ), n as (
    select distinct n0.ctry, n0.region,
           -- a borough or a neighbourhood is the city it is part of (a night filed with
           -- no state is matched on the country and the name alone)
           coalesce((select a.into_key from place_aliases a
                      where a.country_code = n0.ctry and a.city_key = n0.city
                        and (a.region = n0.region or n0.region = '')
                      order by a.into_key limit 1), n0.city) as city
      from n0
  )
  select jsonb_build_object(
    'cities', (select count(*) from n a
                where a.city <> ''
                  -- no state on it: the same city as the one in that country that has a state
                  and not (a.region = '' and a.ctry in ('US', 'CA')
                           and exists (select 1 from n b where b.ctry = a.ctry and b.city = a.city and b.region <> ''))
                  -- no country on it: the same city as the one that has a country
                  and not (a.ctry !~ '^[A-Z]{2}$'
                           and exists (select 1 from n b where b.city = a.city and b.ctry ~ '^[A-Z]{2}$'))),
    'countries', (select count(distinct a.ctry) from n a where a.ctry ~ '^[A-Z]{2}$'))
$$;
revoke all on function public.road_place_counts(text[], text[], text[]) from public, anon, authenticated;

-- Every artist page is counted again by the new rule.
do $$
declare r record;
begin
  for r in select artist_id from artist_history where exists (select 1 from artist_history_shows s where s.artist_id = artist_history.artist_id)
  loop
    perform public.setlist_summarize(r.artist_id);
  end loop;
end $$;

notify pgrst, 'reload schema';
