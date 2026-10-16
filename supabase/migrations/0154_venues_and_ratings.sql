-- Venue pages make themselves; ratings for rooms and nights (2026-10-15).
--
-- What was asked: venue pages should be created automatically whenever a tour
-- is made, since the app already autofills the venue's address; one page per
-- real venue even when tours spell it differently, matched by address; every
-- signed-in user can see venue pages; venue ratings 1-10 by anyone, reflected
-- on the venue page; show ratings 1-10 on crowd, venue and city by the
-- artist's Members only, seen by the band only. Claiming venue pages comes
-- later with promoters (venues.owner_id already waits for that; nothing here
-- touches it).
--
-- Where venue pages live: 0134 already made public.venues (pages grown from
-- the show archive, keyed by name + city + country, read through venue_card,
-- never selected from a phone directly). This file does NOT make a second
-- venues table: tours feed the same one. What a tour knows about a venue sits
-- inside tours.doc -> 'shows' (a map of show id -> show): each show carries
-- "venue" and "city" ("Detroit, MI"), and its day sheet carries
-- "venueAddress" once someone or the lookup fills it. So the matching key is
-- built from the address when there is one, from the name when there is not,
-- and either way from the city.
--
-- The merch auto-score that was described alongside this is computed in the
-- app from the tour's own logged merch. No money figure is stored in any
-- table this file makes: nothing here holds a dollar amount.


-- ====================== 1. The matching key ======================

-- One venue, one key, however a tour spells it. Plain words for text: lower
-- it, fold the common accents away (Montréal is Montreal), turn everything
-- that is not a letter or a digit into one space, write the usual street
-- words short (Avenue is Ave, Street is St, and so on), drop a leading "The"
-- (The Fillmore and Fillmore are one room), and trim.
create or replace function public.venue_text_key(x text)
returns text
language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           regexp_replace(regexp_replace(regexp_replace(regexp_replace(
             regexp_replace(
               translate(lower(coalesce(x, '')),
                         'áàâäãåāçćčďéèêëēęěíìîïīłñńňóòôöõōøřśšťúùûüūůýÿźżž',
                         'aaaaaaacccdeeeeeeeiiiiilnnnooooooorsstuuuuuuyyzzz'),
               '[^a-z0-9]+', ' ', 'g'),
             '^\s*the ', ''),
           '\mavenue\M', 'ave', 'g'), '\mstreet\M', 'st', 'g'), '\mboulevard\M', 'blvd', 'g'),
           '\mdrive\M', 'dr', 'g'), '\mroad\M', 'rd', 'g'), '\mhighway\M', 'hwy', 'g'),
           '\msuite\M', 'ste', 'g'), '\s+', ' ', 'g'))
$$;
revoke all on function public.venue_text_key(text) from public, anon, authenticated;

-- The key itself. The rule in plain words: take the street line of the
-- address (everything before its first comma; it counts only when it has a
-- number in it, the way street lines do, so a lone city name pasted into the
-- address box never becomes a key). When there is a street line, the key is
-- that line joined with the city; when there is not, it is the venue's name
-- joined with the city. The city part is the words before the first comma of
-- the show's city ("Detroit, MI" and "Detroit" both say detroit), read
-- through road_city_key so the same foldings apply everywhere places are
-- counted. The two shapes are marked a: and n: so an address key can never
-- collide with a name key by accident.
create or replace function public.venue_addr_key(address text, name text, city text)
returns text
language sql immutable as $$
  select case when s.street ~ '[0-9]'
              then 'a:' || s.street || '|' || s.ck
              else 'n:' || public.venue_text_key(name) || '|' || s.ck end
    from (select public.venue_text_key(split_part(coalesce(address, ''), ',', 1)) as street,
                 public.road_city_key(split_part(coalesce(city, ''), ',', 1)) as ck) s
$$;
revoke all on function public.venue_addr_key(text, text, text) from public, anon, authenticated;

-- The key lives on the page. Unique where it is set: pages the archive made
-- before this file keep working without one until the backfill below, or a
-- tour, gives them theirs.
alter table public.venues add column if not exists addr_key text
  check (addr_key is null or char_length(addr_key) <= 400);
create unique index if not exists venues_addr_key on public.venues (addr_key)
  where addr_key is not null;

-- Every page the archive already made gets its key now, so a tour playing a
-- room the archive knows lands on the archive's page instead of making a
-- twin. Where two existing pages would share a key (the same name and city in
-- two countries, say), the older keeps it and the younger stays keyless: it
-- is still reachable the way it always was.
update public.venues v
   set addr_key = k.key
  from (select id, public.venue_addr_key(address, name, city) as key,
               row_number() over (partition by public.venue_addr_key(address, name, city)
                                  order by created_at, id) as rn
          from public.venues
         where addr_key is null) k
 where k.id = v.id and k.rn = 1
   and not exists (select 1 from public.venues v2 where v2.addr_key = k.key);


-- ====================== 2. A tour's show writes its venue's page ======================

-- One show's venue, noted on its page (made if there is none). The find goes
-- three steps, each cheaper to miss than a twin page:
--   1. by the key as this show spells it (address key when it has one);
--   2. with an address in hand, by the name key too: the page made before the
--      address arrived is the same page, and it learns its address now;
--   3. by name and city the way the archive files pages (vkey + ckey), so a
--      page the archive made, keyed or not, is adopted rather than doubled.
-- A non-empty stored address is never overwritten with an empty one, and a
-- stored name is never changed (the table's own check keeps names non-empty).
-- It never raises: a venue page must never be the reason a tour save fails,
-- so trouble is logged and the save goes on.
create or replace function public.venue_note(nm text, ct text, addr text)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  nm2 text := left(btrim(coalesce(nm, '')), 120);
  ct2 text := btrim(coalesce(ct, ''));
  addr2 text := left(btrim(coalesce(addr, '')), 200);
  akey text; nkey text; vk text; ck text; reg text; seg2 text; v_id uuid;
begin
  -- a show with no venue name, or no city, makes no page: the key needs both
  if nm2 = '' or ct2 = '' then return; end if;
  akey := public.venue_addr_key(addr2, nm2, ct2);
  nkey := public.venue_addr_key(null, nm2, ct2);
  vk := lower(btrim(nm2));
  ck := public.road_city_key(split_part(ct2, ',', 1));
  if ck = '' then return; end if;
  begin
    select id into v_id from venues where addr_key = akey;
    if v_id is null and akey <> nkey then
      select id into v_id from venues where addr_key = nkey;
    end if;
    if v_id is null then
      select id into v_id from venues where vkey = vk and ckey = ck
       order by created_at, id limit 1;
    end if;
    if v_id is not null then
      -- the write is skipped when it would change nothing, so an ordinary
      -- tour save over the same shows writes no venue rows at all
      update venues
         set address  = case when addr2 <> '' then addr2 else address end,
             addr_key = case when addr2 <> '' then akey else coalesce(addr_key, nkey) end
       where id = v_id
         and ((addr2 <> '' and (address is distinct from addr2 or addr_key is distinct from akey))
              or (addr2 = '' and addr_key is null));
    else
      -- a new page. Region and country are read from the city's own words
      -- ("Detroit, MI" says MI and US); what cannot be read stays ''.
      seg2 := btrim(split_part(ct2, ',', 2));
      reg := coalesce(nullif(public.region_code(seg2), ''),
                      case when seg2 ~ '^[A-Za-z]{2}$' then upper(seg2) else '' end);
      insert into venues (name, vkey, ckey, cc, city, region, address, addr_key)
      values (nm2, vk, ck, public.road_country(ct2), left(btrim(split_part(ct2, ',', 1)), 120),
              reg, addr2, akey)
      on conflict do nothing;  -- two saves racing: the next save settles it
    end if;
  exception when others then
    raise log 'venue_note: % / % (%)', nm2, ct2, sqlerrm;
  end;
end $$;
revoke all on function public.venue_note(text, text, text) from public, anon, authenticated;

-- Every save of a tour notes its venues. The doc's shows map is small (a
-- tour's nights), each show costs a few indexed lookups, and a save that did
-- not touch the shows is let through untouched at the first line. After the
-- row is written, changes nothing, stops nothing.
create or replace function public.venues_from_tour()
returns trigger
language plpgsql security definer set search_path = public as $$
declare e record;
begin
  begin
    -- not the Off Tour book, not a tour in the trash
    if coalesce(new.doc ->> 'kind', '') = 'offtour' or (new.doc ->> 'deletedAt') is not null then
      return null;
    end if;
    if tg_op = 'UPDATE' and (new.doc -> 'shows') is not distinct from (old.doc -> 'shows') then
      return null;
    end if;
    for e in select value as s from jsonb_each(case when jsonb_typeof(new.doc -> 'shows') = 'object'
                                                    then new.doc -> 'shows' else '{}'::jsonb end)
    loop
      continue when jsonb_typeof(e.s) <> 'object';
      perform public.venue_note(e.s ->> 'venue', e.s ->> 'city', e.s -> 'daySheet' ->> 'venueAddress');
    end loop;
  exception when others then
    raise log 'venues_from_tour: % (%)', new.id, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.venues_from_tour() from public, anon, authenticated;

drop trigger if exists tours_venues on public.tours;
create trigger tours_venues after insert or update of doc on public.tours
  for each row execute function public.venues_from_tour();

-- The tours already saved get the same pass now, oldest save first so the
-- freshest address wins last.
do $$
declare t record; e record;
begin
  for t in select x.id, x.doc from tours x
            where coalesce(x.doc ->> 'kind', '') <> 'offtour' and (x.doc ->> 'deletedAt') is null
            order by x.updated_at, x.id
  loop
    for e in select value as s from jsonb_each(case when jsonb_typeof(t.doc -> 'shows') = 'object'
                                                    then t.doc -> 'shows' else '{}'::jsonb end)
    loop
      continue when jsonb_typeof(e.s) <> 'object';
      perform public.venue_note(e.s ->> 'venue', e.s ->> 'city', e.s -> 'daySheet' ->> 'venueAddress');
    end loop;
  end loop;
end $$;


-- ====================== 3. Venue ratings: anyone, 1-10 ======================

-- One row per person per venue, stars 1-10. The page shows the average, so
-- every signed-in user may read; each person writes their own row and no
-- other. A row carries an account id, a number and a time: no name, no
-- address, nothing more ever reaches a phone from here. Not on the live line.
create table if not exists public.venue_ratings (
  venue_id uuid not null references public.venues (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  stars int not null check (stars between 1 and 10),
  at timestamptz not null default now(),
  primary key (venue_id, user_id)
);
alter table public.venue_ratings enable row level security;
drop policy if exists venue_ratings_select on public.venue_ratings;
create policy venue_ratings_select on public.venue_ratings for select
  using (auth.uid() is not null);
drop policy if exists venue_ratings_insert on public.venue_ratings;
create policy venue_ratings_insert on public.venue_ratings for insert
  with check (user_id = auth.uid());
drop policy if exists venue_ratings_update on public.venue_ratings;
create policy venue_ratings_update on public.venue_ratings for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists venue_ratings_delete on public.venue_ratings;
create policy venue_ratings_delete on public.venue_ratings for delete
  using (user_id = auth.uid());
revoke all on public.venue_ratings from public, anon, authenticated;
grant select, insert, update, delete on public.venue_ratings to authenticated;


-- ====================== 4. Show ratings: the band's own, 1-10 ======================

-- After a night, the band scores the crowd, the venue and the city, each 1-10
-- and each optional. Written and read by the band only: the tour's owner and
-- the current Members of the artist the tour belongs to. Crew never read
-- these, fans never read these, and the venue never learns who scored what:
-- a room should never find out it was somebody's worst night of the run.
create table if not exists public.show_ratings (
  tour_id text not null references public.tours (id) on delete cascade,
  show_id text not null check (char_length(show_id) <= 80),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  crowd int check (crowd between 1 and 10),
  venue int check (venue between 1 and 10),
  city int check (city between 1 and 10),
  at timestamptz not null default now(),
  primary key (tour_id, show_id, user_id)
);

-- Band on this tour? The tour's owner, or a current Member of the artist the
-- tour belongs to. A tour names its artist in doc ->> 'artistId'; an older
-- tour that only carries the artist's words is matched by name, exactly as
-- artist_tours (0143) matches it, and with the same guard: the tour must be
-- made by the account that runs the artist's page, so a tour somebody else
-- names after an artist never opens its ratings to that artist's people.
create or replace function public.rates_with_band(t_id text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from tours t
     where t.id = t_id
       and (t.owner_id = auth.uid()
            or exists (
                 select 1 from artist_members m join artists a on a.id = m.artist_id
                  where m.user_id = auth.uid() and m.kind = 'band' and m.ended_at is null
                    and a.owner_id = t.owner_id
                    and ((t.doc ->> 'artistId') = a.id::text
                         or (coalesce(t.doc ->> 'artistId', '') = ''
                             and btrim(coalesce(t.doc ->> 'artist', '')) <> ''
                             and lower(btrim(t.doc ->> 'artist')) = lower(btrim(a.name))))))
  )
$$;
revoke all on function public.rates_with_band(text) from public, anon;
grant execute on function public.rates_with_band(text) to authenticated;

-- Is this show a night of this tour? Checked on the database's own authority:
-- a Member of the artist can rate a night without holding a seat on the tour,
-- so the row rules on tours would not let them look.
create or replace function public.show_on_tour(t_id text, s_id text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from tours t
                  where t.id = t_id
                    and jsonb_typeof(t.doc -> 'shows') = 'object'
                    and t.doc -> 'shows' ? s_id)
$$;
revoke all on function public.show_on_tour(text, text) from public, anon;
grant execute on function public.show_on_tour(text, text) to authenticated;

alter table public.show_ratings enable row level security;
-- the band only, never crew, never fans
drop policy if exists show_ratings_select on public.show_ratings;
create policy show_ratings_select on public.show_ratings for select
  using (public.rates_with_band(tour_id));
-- your own row, on a night that is really on the tour
drop policy if exists show_ratings_insert on public.show_ratings;
create policy show_ratings_insert on public.show_ratings for insert
  with check (user_id = auth.uid() and public.rates_with_band(tour_id)
              and public.show_on_tour(tour_id, show_id));
drop policy if exists show_ratings_update on public.show_ratings;
create policy show_ratings_update on public.show_ratings for update
  using (user_id = auth.uid() and public.rates_with_band(tour_id))
  with check (user_id = auth.uid() and public.rates_with_band(tour_id)
              and public.show_on_tour(tour_id, show_id));
drop policy if exists show_ratings_delete on public.show_ratings;
create policy show_ratings_delete on public.show_ratings for delete
  using (user_id = auth.uid());
revoke all on public.show_ratings from public, anon, authenticated;
grant select, insert, update, delete on public.show_ratings to authenticated;


-- ====================== 5. The venue's page shows its rating ======================

-- venue_card, from its live text (0134), with two keys more: 'rating' (the
-- average of everyone's stars, one decimal, null until someone rates) and
-- 'ratings' (how many people). Nothing says who rated or what any one person
-- gave: a person reads their own row from venue_ratings directly.
create or replace function public.venue_card(v_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v public.venues%rowtype;
begin
  if auth.uid() is null then return null; end if;
  select * into v from venues where id = v_id;
  if not found then return null; end if;
  return (
    with n as materialized (
      select s.artist_id, s.date from artist_history_shows s
       where lower(btrim(s.venue)) = v.vkey and upper(s.country_code) = v.cc and public.road_city_key(s.city) = v.ckey
         and s.festival = '' and s.date <= current_date)
    select jsonb_build_object(
      'id', v.id, 'name', v.name, 'city', v.city, 'region', v.region, 'country', v.country, 'address', v.address, 'phone', v.phone,
      'unclaimed', v.owner_id is null, 'verified', v.verified, 'mine', coalesce(v.owner_id = auth.uid(), false),
      'rating', (select round(avg(r.stars)::numeric, 1) from venue_ratings r where r.venue_id = v.id),
      'ratings', (select count(*) from venue_ratings r where r.venue_id = v.id),
      'shows', (select count(distinct (n.artist_id, n.date)) from n),
      'firstYear', (select extract(year from min(n.date))::int from n),
      'lastYear', (select extract(year from max(n.date))::int from n),
      'artists', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'avatar', coalesce(a.avatar, ''),
                     'n', t.k, 'first', t.y0, 'last', t.y1) order by t.k desc, a.name)
                   from (select n.artist_id, count(distinct n.date) as k, extract(year from min(n.date))::int as y0,
                                extract(year from max(n.date))::int as y1
                           from n group by n.artist_id order by count(distinct n.date) desc limit 80) t
                   join artists a on a.id = t.artist_id), '[]'::jsonb),
      'workers', (select count(*) from place_workers w where w.venue_id = v.id and w.status = 'approved'),
      'myWork', (select jsonb_build_object('role', w.role, 'state', w.status) from place_workers w
                  where w.venue_id = v.id and w.user_id = auth.uid())));
end $function$;
revoke all on function public.venue_card(uuid) from public, anon;
grant execute on function public.venue_card(uuid) to authenticated;

notify pgrst, 'reload schema';

-- ============================== To roll back ==============================
--   drop trigger if exists tours_venues on public.tours;
--   drop function if exists public.venues_from_tour();
--   drop function if exists public.venue_note(text, text, text);
--   drop table if exists public.show_ratings;
--   drop table if exists public.venue_ratings;   -- everyone's stars go with it
--   drop function if exists public.rates_with_band(text);
--   drop function if exists public.show_on_tour(text, text);
--   drop function if exists public.venue_addr_key(text, text, text);
--   drop function if exists public.venue_text_key(text);
--   drop index if exists public.venues_addr_key;
--   alter table public.venues drop column if exists addr_key;
--   venue_card back to 0134's text (this file's copy minus the 'rating' and
--   'ratings' lines is exactly that text);
--   notify pgrst, 'reload schema';
-- The venue pages the tours made stay: they are ordinary pages of the same
-- table the archive grows, and nothing else tells them apart.
