-- The tour finder reads on its own and fills the page in (Devin, 2026-10-08:
-- "this search engine should run when you start the search even if your app
-- isn't open"; "It should find the dates, the tour name, and then venues (if
-- it can't find the venues it's fine) and autofill").
--
-- What changes:
--  1. The reading brain moves to the server. When the reading key is in
--     Vault under the name 'anthropic_key', the database hands each batch of
--     articles to the reader itself — two at a time, with the phone in a
--     pocket — and keeps going until every article is read. Without the key
--     the phone reads as before.
--  2. Autofill. A found tour that adds something to the page (nights with no
--     name that fall in it, or announced dates the page lacks) and that no
--     other find is fighting over goes on the page by itself: its name, its
--     dates, its venues where the announcement had them. The owner sees what
--     was added and can take any of it off. Only a real tie is asked about.
--  3. Honesty about failures. A batch the reader didn't answer is asked
--     again, then split, and an article it still can't make out is counted
--     and said so — a run never again reads 327 articles and reports nothing
--     because every answer was lost to a rate limit.
--  4. Wikipedia is read by the server too (the paragraphs that mention the
--     act), and the finder's tick runs every fifteen seconds.

-- ---------------------------------------------------------------------------
-- 1. Tables and columns
-- ---------------------------------------------------------------------------
create table if not exists public.tour_find_batches (
  id bigserial primary key,
  artist_id uuid not null references public.artists (id) on delete cascade,
  urls jsonb not null default '[]'::jsonb,
  status text not null default 'todo',          -- todo | asked | done | split | failed
  tries int not null default 0,
  next_at timestamptz not null default now(),
  asked_at timestamptz,
  request_id bigint,
  found jsonb,
  error text not null default ''
);
create index if not exists tour_find_batches_artist on public.tour_find_batches (artist_id, status);
alter table public.tour_find_batches enable row level security;
revoke all on public.tour_find_batches from public, anon, authenticated;

create table if not exists public.tour_find_wiki (
  artist_id uuid not null references public.artists (id) on delete cascade,
  request_id bigint not null,
  kind text not null,                            -- search | page
  title text not null default '',
  fired_at timestamptz not null default now(),
  primary key (artist_id, request_id)
);
alter table public.tour_find_wiki enable row level security;
revoke all on public.tour_find_wiki from public, anon, authenticated;

alter table public.tour_finds add column if not exists wiki text not null default 'new';     -- new | searching | pages | done
alter table public.tour_finds add column if not exists brain text not null default '';       -- '' | bad_key
alter table public.tour_finds add column if not exists unread int not null default 0;        -- articles the reader couldn't make out
alter table public.tour_candidates add column if not exists auto boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. The key and the model
-- ---------------------------------------------------------------------------
-- The reading key lives in Vault (Devin types it into the dashboard; it never
-- passes through chat or code). Null when it isn't there: the phone reads.
create or replace function public.tour_find_key()
returns text
language sql stable security definer set search_path = public as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'anthropic_key' limit 1
$$;
revoke all on function public.tour_find_key() from public, anon, authenticated;

create or replace function public.tour_find_model()
returns text
language sql immutable as $$ select 'claude-sonnet-5-5'::text $$;
revoke all on function public.tour_find_model() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The brief, built on the server (the same words the phone uses)
-- ---------------------------------------------------------------------------
create or replace function public.tour_find_prompt(a_id uuid, nm text, urls jsonb)
returns text
language sql stable security definer set search_path = public as $$
  select 'TOUR FINDER. You are helping a touring app list the tours of the act "' || nm || '". Below are news articles and encyclopedia passages, each with its date and URL. '
      || 'Return ONLY a JSON array. Each item is one tour or run that ' || nm || ' was part of: a headline or co-headline tour, a support slot on another act’s tour, or a package/festival tour (Warped, Taste of Chaos). '
      || 'Fields: "name" (the announced tour name; if the run had no name, a short description such as "Fall 2018 run with Dance Gavin Dance"), '
      || '"role" (one of headline, co-headline, support, festival), "start" and "end" (YYYY-MM-DD; when a listing gives month/day only, take the year from the article date, and remember a run announced in the fall may start the next year), '
      || '"lineup" (the other acts, comma separated), "region" (US, UK/Europe, Australia, Japan, Canada…), '
      || '"dates" (every date listed for ' || nm || ', each as one short string "YYYY-MM-DD | City, ST | Venue"; an empty array if none are listed), "source" (the article URL). '
      || 'Rules: only runs ' || nm || ' is on; skip one-off festival appearances and anything that is not a tour (album news, videos, members leaving); when a later article updates an earlier one (dates added, moved or cancelled) fold them into one item; never invent dates; if nothing qualifies return [].' || E'\n\n'
      || coalesce((select string_agg('--- ARTICLE ' || x.n || ' | ' || coalesce(to_char(g.published, 'YYYY-MM-DD'), 'date unknown') || ' | ' || g.url || E'\n'
                                     || case when g.title <> '' then g.title || E'\n' else '' end || g.body || E'\n', E'\n' order by x.n)
                     from jsonb_array_elements_text(urls) with ordinality as x(url, n)
                     join tour_find_pages g on g.artist_id = a_id and g.url = x.url), '')
$$;
revoke all on function public.tour_find_prompt(uuid, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Batches: the unread articles, five at a time, ten thousand characters at most
-- ---------------------------------------------------------------------------
create or replace function public.tour_find_batch(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare p record; cur jsonb := '[]'::jsonb; size int := 0; n int := 0; len int;
begin
  for p in select g.url, length(g.body) as len from tour_find_pages g
            where g.artist_id = a_id and g.fetched and g.body <> '' and g.read_at is null
              and not exists (select 1 from tour_find_batches b where b.artist_id = a_id and b.status in ('todo', 'asked') and b.urls ? g.url)
            order by g.published nulls last, g.url
  loop
    len := p.len + 200;
    if jsonb_array_length(cur) > 0 and (size + len > 10000 or jsonb_array_length(cur) >= 5) then
      insert into tour_find_batches (artist_id, urls) values (a_id, cur);
      n := n + 1; cur := '[]'::jsonb; size := 0;
    end if;
    cur := cur || to_jsonb(p.url); size := size + len;
  end loop;
  if jsonb_array_length(cur) > 0 then
    insert into tour_find_batches (artist_id, urls) values (a_id, cur);
    n := n + 1;
  end if;
  return n;
end $$;
revoke all on function public.tour_find_batch(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Folding the finds into one list (what core.js's mergeTourCandidates does)
-- ---------------------------------------------------------------------------
-- A day, or a month standing in for one: "2019-11" is the month's first day as
-- a start and its last as an end, and a guess never beats a real date.
create or replace function public.tour_find_day(s text, as_end boolean, out d date, out exact boolean)
language plpgsql immutable as $$
begin
  s := btrim(coalesce(s, ''));
  d := null; exact := false;
  begin
    if s ~ '^\d{4}-\d{2}-\d{2}$' then d := s::date; exact := true;
    elsif s ~ '^\d{4}-\d{2}$' then
      d := case when as_end then ((s || '-01')::date + interval '1 month' - interval '1 day')::date else (s || '-01')::date end;
    end if;
  exception when others then d := null; exact := false;
  end;
end $$;
revoke all on function public.tour_find_day(text, boolean) from public, anon, authenticated;

-- One listed night, from an object or the compact line "YYYY-MM-DD | City, ST | Venue".
create or replace function public.tour_find_date(x jsonb)
returns jsonb
language sql immutable as $$
  select case
    when jsonb_typeof(x) = 'object' and (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
      then jsonb_build_object('date', x ->> 'date', 'city', left(btrim(coalesce(x ->> 'city', '')), 80), 'venue', left(btrim(coalesce(x ->> 'venue', '')), 120))
    when jsonb_typeof(x) = 'string' and btrim(split_part(x #>> '{}', '|', 1)) ~ '^\d{4}-\d{2}-\d{2}$'
      then jsonb_build_object('date', btrim(split_part(x #>> '{}', '|', 1)), 'city', left(btrim(split_part(x #>> '{}', '|', 2)), 80), 'venue', left(btrim(split_part(x #>> '{}', '|', 3)), 120))
    else null end
$$;
revoke all on function public.tour_find_date(jsonb) from public, anon, authenticated;

create or replace function public.tour_find_acts(lineup text)
returns text[]
language sql immutable as $$
  select coalesce(array_agg(btrim(w)) filter (where char_length(btrim(w)) > 1), '{}'::text[])
    from regexp_split_to_table(lower(coalesce(lineup, '')), ',|\yand\y|&|/') w
$$;
revoke all on function public.tour_find_acts(text) from public, anon, authenticated;

-- A description the reader made up ("Fall 2018 run with…") gives way to a real name.
create or replace function public.tour_find_madeup(nm text)
returns boolean
language sql immutable as $$
  select coalesce(nm, '') ~* '^(spring|summer|fall|autumn|winter|early|late|\d{4}|[a-z]+ \d{4})\y'
$$;
revoke all on function public.tour_find_madeup(text) from public, anon, authenticated;

create or replace function public.tour_find_merge(items jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare c jsonb; nm text; k text; s record; e record; v_role text; ds jsonb; srcs jsonb; v_lineup text; v_region text; hit record; out jsonb;
begin
  create temp table if not exists tf_merge (
    id serial, key text, name text, role text, start_d date, end_d date, sx boolean, ex boolean,
    region text, lineup text, dates jsonb, sources jsonb) on commit drop;
  truncate tf_merge;
  for c in select * from jsonb_array_elements(case when jsonb_typeof(items) = 'array' then items else '[]'::jsonb end)
  loop
    if jsonb_typeof(c) <> 'object' then continue; end if;
    nm := left(regexp_replace(btrim(coalesce(c ->> 'name', '')), '\s+', ' ', 'g'), 120);
    select * into s from public.tour_find_day(c ->> 'start', false);
    select * into e from public.tour_find_day(c ->> 'end', true);
    if char_length(nm) < 2 or s.d is null or e.d is null or e.d < s.d then continue; end if;
    k := public.setlist_tour_key(nm);
    if k = '' then continue; end if;
    v_role := case when c ->> 'role' in ('headline', 'co-headline', 'support', 'festival') then c ->> 'role' else '' end;
    select coalesce(jsonb_agg(d), '[]'::jsonb) into ds
      from (select public.tour_find_date(x) as d from jsonb_array_elements(case when jsonb_typeof(c -> 'dates') = 'array' then c -> 'dates' else '[]'::jsonb end) x) q
     where d is not null;
    select coalesce(jsonb_agg(distinct u), '[]'::jsonb) into srcs
      from (select jsonb_array_elements_text(case when jsonb_typeof(c -> 'sources') = 'array' then c -> 'sources'
                                                  when jsonb_typeof(c -> 'source') = 'string' then jsonb_build_array(c -> 'source') else '[]'::jsonb end) as u) q
     where u like 'https://%';
    v_lineup := left(regexp_replace(btrim(coalesce(c ->> 'lineup', '')), '\s+', ' ', 'g'), 300);
    v_region := left(btrim(coalesce(c ->> 'region', '')), 60);
    -- The same name is the same tour only when the two accounts are near
    -- each other in time (Warped Tour comes round every year); two accounts
    -- of one run share its dates, its role and an act.
    select * into hit from tf_merge m
     where (m.key = k and (m.start_d <= e.d and s.d <= m.end_d or abs(m.end_d - s.d) <= 120 or abs(e.d - m.start_d) <= 120))
        or (m.start_d <= e.d and s.d <= m.end_d and m.role = v_role
            and exists (select 1 from unnest(public.tour_find_acts(m.lineup)) x join unnest(public.tour_find_acts(v_lineup)) y on x = y))
     order by m.id limit 1;
    if not found then
      insert into tf_merge (key, name, role, start_d, end_d, sx, ex, region, lineup, dates, sources)
      values (k, nm, v_role, s.d, e.d, s.exact, e.exact, v_region, v_lineup, ds, srcs);
      continue;
    end if;
    -- A real date beats a month's guess; among real dates the wider wins.
    update tf_merge m set
      start_d = case when s.exact and not m.sx then s.d when s.exact = m.sx and s.d < m.start_d then s.d else m.start_d end,
      sx = m.sx or s.exact,
      end_d = case when e.exact and not m.ex then e.d when e.exact = m.ex and e.d > m.end_d then e.d else m.end_d end,
      ex = m.ex or e.exact,
      name = case when public.tour_find_madeup(m.name) and not public.tour_find_madeup(nm) then nm else m.name end,
      key = case when public.tour_find_madeup(m.name) and not public.tour_find_madeup(nm) then k else m.key end,
      lineup = case when char_length(v_lineup) > char_length(m.lineup) then v_lineup else m.lineup end,
      region = case when m.region = '' then v_region else m.region end,
      dates = m.dates || coalesce((select jsonb_agg(d) from jsonb_array_elements(ds) d
                                    where not exists (select 1 from jsonb_array_elements(m.dates) o where o ->> 'date' = d ->> 'date')), '[]'::jsonb),
      sources = m.sources || coalesce((select jsonb_agg(u) from jsonb_array_elements(srcs) u
                                        where not (m.sources @> jsonb_build_array(u)) and jsonb_array_length(m.sources) < 6), '[]'::jsonb)
     where m.id = hit.id;
  end loop;
  -- A name that comes round in more than one year (a package tour) gets its
  -- year, so each year stands on its own on the page.
  update tf_merge m set name = m.name || ' ' || to_char(m.start_d, 'YYYY')
   where (select count(*) from tf_merge o where o.key = m.key) > 1 and m.name !~ '\y(19|20)\d{2}\y';
  select coalesce(jsonb_agg(jsonb_build_object(
      'name', m.name, 'role', m.role, 'start', to_char(m.start_d, 'YYYY-MM-DD'), 'end', to_char(m.end_d, 'YYYY-MM-DD'),
      'region', m.region, 'lineup', m.lineup,
      'dates', (select coalesce(jsonb_agg(d order by d ->> 'date'), '[]'::jsonb) from jsonb_array_elements(m.dates) d),
      'sources', m.sources) order by m.id), '[]'::jsonb) into out from tf_merge m;
  return out;
end $$;
revoke all on function public.tour_find_merge(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Proposing, inside (no sign-in check: the server proposes its own finds)
-- ---------------------------------------------------------------------------
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
  return n;
end $$;
revoke all on function public.tour_find_propose_in(uuid, jsonb) from public, anon, authenticated;

-- The phone's proposing: it says which articles it actually read (a batch the
-- reader failed on stays unread and is asked again); posters pass none.
drop function if exists public.tour_find_propose(uuid, jsonb);
create or replace function public.tour_find_propose(a_id uuid, cands jsonb, read_urls jsonb default null)
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
  k := public.tour_find_autofill(a_id);
  update tour_finds set status = 'done', extracting_at = null, finished_at = coalesce(finished_at, now()) where artist_id = a_id and status <> 'error';
  return public.tour_find_state(a_id) || jsonb_build_object('added', n, 'filled', k);
end $$;
revoke all on function public.tour_find_propose(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.tour_find_propose(uuid, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Autofill: what is sure goes on the page by itself
-- ---------------------------------------------------------------------------
create or replace function public.tour_find_autofill(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c public.tour_candidates; k int := 0; useful boolean; tie boolean;
begin
  for c in select * from tour_candidates where artist_id = a_id and status = 'new' and first_day is not null and last_day is not null order by first_day, id
  loop
    -- Adds something: a night on the page with no name that falls in it, an
    -- announced night the page lacks, or more dates for a tour already named.
    useful := c.fill
      or exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date))
      or exists (select 1 from jsonb_array_elements(c.dates) x
                  where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'date')::date <= current_date
                    and not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (x ->> 'date')::date));
    if not useful then continue; end if;
    -- Another find wants one of the same nights: that is the owner's call.
    tie := exists (select 1 from tour_candidates o
                    where o.artist_id = a_id and o.status = 'new' and o.id <> c.id
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
revoke all on function public.tour_find_autofill(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Wikipedia: the paragraphs that mention the act
-- ---------------------------------------------------------------------------
create or replace function public.tour_find_about(txt text, nm text)
returns text
language plpgsql immutable as $$
declare paras text[]; keep boolean[]; i int; n int; lo text := lower(btrim(coalesce(nm, ''))); out text := '';
begin
  if lo = '' then return ''; end if;
  paras := regexp_split_to_array(coalesce(txt, ''), E'\n+');
  n := coalesce(array_length(paras, 1), 0);
  if n = 0 then return ''; end if;
  keep := array_fill(false, array[n]);
  for i in 1..n loop
    if position(lo in lower(paras[i])) > 0 then
      keep[i] := true;
      if i > 1 then keep[i - 1] := true; end if;
      if i < n then keep[i + 1] := true; end if;
    end if;
  end loop;
  for i in 1..n loop
    if keep[i] and btrim(paras[i]) <> '' then out := out || case when out = '' then '' else E'\n' end || btrim(paras[i]); end if;
  end loop;
  return left(out, 6000);
end $$;
revoke all on function public.tour_find_about(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. The brain: answers in, batches out, Wikipedia on the side
-- ---------------------------------------------------------------------------
create or replace function public.tour_find_brain(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare f record; key text; nm text; b record; w record; body jsonb; txt text; a int; z int; items jsonb; half int; n int := 0;
        inflight int; rid bigint; msg text; about text; ttl text; pg jsonb;
        ua constant text := 'Greenroom/1.0 (https://devinoliverofficial.github.io/greenroom/; devinoliverofficial@gmail.com)';
begin
  select * into f from tour_finds where artist_id = a_id;
  if not found or f.brain = 'bad_key' then return 0; end if;
  key := public.tour_find_key();
  if key is null then
    -- No key on the server: the phone reads. A read the server had begun hands back.
    if f.status = 'thinking' then update tour_finds set status = 'ready', extracting_at = null where artist_id = a_id; end if;
    return 0;
  end if;
  select ar.name into nm from artists ar where ar.id = a_id;

  -- The archives are in: the server takes the read.
  if f.status = 'ready' then
    perform public.tour_find_batch(a_id);
    update tour_finds set status = 'thinking', extracting_at = now(), wiki = 'new', unread = 0 where artist_id = a_id;
    f.status := 'thinking'; f.wiki := 'new';
  end if;
  if f.status <> 'thinking' then return 0; end if;

  -- Wikipedia: one search, then the articles it names, cut to the paragraphs that mention the act.
  if f.wiki = 'new' then
    rid := net.http_get(url := 'https://en.wikipedia.org/w/api.php',
      params := jsonb_build_object('action', 'query', 'list', 'search', 'format', 'json', 'srlimit', '6', 'srsearch', '"' || nm || '"'),
      headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 15000);
    insert into tour_find_wiki (artist_id, request_id, kind) values (a_id, rid, 'search');
    update tour_finds set wiki = 'searching' where artist_id = a_id;
    f.wiki := 'searching';
  end if;
  for w in select q.request_id, q.kind, q.title, resp.status_code, resp.content
             from tour_find_wiki q join net._http_response resp on resp.id = q.request_id
            where q.artist_id = a_id
  loop
    begin
      if w.status_code = 200 and coalesce(w.content, '') <> '' then
        body := w.content::jsonb;
        if w.kind = 'search' then
          for ttl in select x ->> 'title' from jsonb_array_elements(coalesce(body -> 'query' -> 'search', '[]'::jsonb)) x limit 6
          loop
            rid := net.http_get(url := 'https://en.wikipedia.org/w/api.php',
              params := jsonb_build_object('action', 'query', 'prop', 'extracts', 'explaintext', '1', 'format', 'json', 'titles', ttl),
              headers := jsonb_build_object('User-Agent', ua, 'Accept', 'application/json'), timeout_milliseconds := 20000);
            insert into tour_find_wiki (artist_id, request_id, kind, title) values (a_id, rid, 'page', left(ttl, 200));
          end loop;
          update tour_finds set wiki = 'pages' where artist_id = a_id;
        else
          select p.value into pg from jsonb_each(coalesce(body -> 'query' -> 'pages', '{}'::jsonb)) p limit 1;
          about := public.tour_find_about(pg ->> 'extract', nm);
          if about <> '' then
            insert into tour_find_pages (artist_id, url, source, title, published, body, fetched)
            values (a_id, left('https://en.wikipedia.org/wiki/' || replace(w.title, ' ', '_'), 300), 'wikipedia', w.title, null, about, true)
            on conflict (artist_id, url) do update set body = excluded.body, read_at = null;
            insert into tour_find_batches (artist_id, urls) values (a_id, jsonb_build_array(left('https://en.wikipedia.org/wiki/' || replace(w.title, ' ', '_'), 300)));
          end if;
        end if;
      end if;
    exception when others then
      null; -- Wikipedia is a bonus; the archives carry the day.
    end;
    delete from tour_find_wiki where artist_id = a_id and request_id = w.request_id;
  end loop;
  delete from tour_find_wiki where artist_id = a_id and fired_at < now() - interval '3 minutes';
  if f.wiki in ('searching', 'pages') and not exists (select 1 from tour_find_wiki q where q.artist_id = a_id) then
    update tour_finds set wiki = 'done' where artist_id = a_id;
    f.wiki := 'done';
  end if;

  -- Answers that came back.
  for b in select q.*, resp.status_code, resp.content, resp.timed_out
             from tour_find_batches q join net._http_response resp on resp.id = q.request_id
            where q.artist_id = a_id and q.status = 'asked'
  loop
    if b.status_code = 200 then
      begin
        body := b.content::jsonb;
        select coalesce(string_agg(x ->> 'text', '' order by o.ord), '') into txt
          from jsonb_array_elements(coalesce(body -> 'content', '[]'::jsonb)) with ordinality as o(x, ord) where x ->> 'type' = 'text';
        txt := regexp_replace(regexp_replace(btrim(txt), '^```(?:json)?\s*', ''), '```\s*$', '');
        a := position('[' in txt);
        z := case when position(']' in reverse(txt)) > 0 then length(txt) - position(']' in reverse(txt)) + 1 else 0 end;
        if a = 0 or z <= a then raise exception 'no array'; end if;
        items := substr(txt, a, z - a + 1)::jsonb;
        if jsonb_typeof(items) <> 'array' then raise exception 'no array'; end if;
        update tour_find_batches set status = 'done', found = items, error = '' where id = b.id;
        update tour_find_pages g set read_at = now() where g.artist_id = a_id and b.urls ? g.url;
      exception when others then
        -- The answer didn't parse (the reader ran out of room, or answered in
        -- prose): asked again in two halves, down to one article.
        if jsonb_array_length(b.urls) > 1 then
          half := ceil(jsonb_array_length(b.urls) / 2.0);
          insert into tour_find_batches (artist_id, urls) values
            (a_id, (select jsonb_agg(u) from jsonb_array_elements(b.urls) with ordinality as t(u, ord) where ord <= half)),
            (a_id, (select jsonb_agg(u) from jsonb_array_elements(b.urls) with ordinality as t(u, ord) where ord > half));
          update tour_find_batches set status = 'split' where id = b.id;
        elsif b.tries + 1 >= 2 then
          update tour_find_batches set status = 'failed', error = 'unreadable' where id = b.id;
          update tour_find_pages g set read_at = now() where g.artist_id = a_id and b.urls ? g.url;
          update tour_finds set unread = unread + 1 where artist_id = a_id;
        else
          update tour_find_batches set status = 'todo', tries = tries + 1, next_at = now() where id = b.id;
        end if;
      end;
    elsif b.status_code is null or b.status_code = 429 or b.status_code = 529 or b.status_code >= 500 then
      -- Busy, slow down, or no answer: the same batch is asked again, a little later each time.
      if b.tries + 1 > 4 then
        update tour_find_batches set status = 'failed', error = 'the reader was busy' where id = b.id;
        update tour_find_pages g set read_at = now() where g.artist_id = a_id and b.urls ? g.url;
        update tour_finds set unread = unread + jsonb_array_length(b.urls) where artist_id = a_id;
      else
        update tour_find_batches set status = 'todo', tries = tries + 1, next_at = now() + make_interval(secs => 20 * (b.tries + 1)) where id = b.id;
      end if;
    elsif b.status_code in (401, 403) then
      -- The key was turned away: the phone reads from here, and the owner is told.
      update tour_finds set brain = 'bad_key', status = 'ready', extracting_at = null,
             detail = 'The reading key in Vault was turned away; this read finishes on the phone.' where artist_id = a_id;
      update tour_find_batches set status = 'failed', error = 'bad key' where artist_id = a_id and status in ('todo', 'asked');
      return n;
    else
      begin msg := left(coalesce((b.content::jsonb) -> 'error' ->> 'message', ''), 200); exception when others then msg := ''; end;
      if msg ~* 'credit|billing|balance' then
        update tour_finds set status = 'error', extracting_at = null, detail = 'The reading key is out of credit. Top it up and try again.' where artist_id = a_id;
        update tour_find_batches set status = 'failed', error = 'no credit' where artist_id = a_id and status in ('todo', 'asked');
        return n;
      end if;
      -- Something about this batch the reader won't take: smaller, then let go.
      if jsonb_array_length(b.urls) > 1 then
        half := ceil(jsonb_array_length(b.urls) / 2.0);
        insert into tour_find_batches (artist_id, urls) values
          (a_id, (select jsonb_agg(u) from jsonb_array_elements(b.urls) with ordinality as t(u, ord) where ord <= half)),
          (a_id, (select jsonb_agg(u) from jsonb_array_elements(b.urls) with ordinality as t(u, ord) where ord > half));
        update tour_find_batches set status = 'split' where id = b.id;
      else
        update tour_find_batches set status = 'failed', error = left('http ' || b.status_code || ' ' || msg, 200) where id = b.id;
        update tour_find_pages g set read_at = now() where g.artist_id = a_id and b.urls ? g.url;
        update tour_finds set unread = unread + 1 where artist_id = a_id;
      end if;
    end if;
  end loop;
  -- An ask that never came back (the request itself was lost) is asked again.
  update tour_find_batches set status = 'todo', tries = tries + 1, next_at = now()
   where artist_id = a_id and status = 'asked' and asked_at < now() - interval '4 minutes';
  update tour_find_batches set status = 'failed', error = 'no answer' where artist_id = a_id and status = 'todo' and tries > 4;

  -- Two batches at a time (the reader's rate limit counts the room it is asked for).
  select count(*) into inflight from tour_find_batches where artist_id = a_id and status = 'asked';
  for b in select * from tour_find_batches where artist_id = a_id and status = 'todo' and next_at <= now() order by id limit greatest(0, 2 - inflight)
  loop
    rid := net.http_post(url := 'https://api.anthropic.com/v1/messages',
      body := jsonb_build_object('model', public.tour_find_model(), 'max_tokens', 4000,
                'messages', jsonb_build_array(jsonb_build_object('role', 'user', 'content', public.tour_find_prompt(a_id, nm, b.urls)))),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-api-key', key, 'anthropic-version', '2023-06-01'),
      timeout_milliseconds := 170000);
    update tour_find_batches set status = 'asked', asked_at = now(), request_id = rid where id = b.id;
    n := n + 1;
  end loop;

  -- Everything read: fold the finds, propose them, fill the page in.
  if f.wiki = 'done' and not exists (select 1 from tour_find_batches q where q.artist_id = a_id and q.status in ('todo', 'asked')) then
    perform public.tour_find_finish(a_id);
  end if;
  update tour_finds set extracting_at = now() where artist_id = a_id and status = 'thinking';
  return n;
end $$;
revoke all on function public.tour_find_brain(uuid) from public, anon, authenticated;

create or replace function public.tour_find_finish(a_id uuid)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare items jsonb; merged jsonb; n int; k int; arts int; v_unread int;
begin
  select coalesce(jsonb_agg(x), '[]'::jsonb) into items
    from tour_find_batches b, jsonb_array_elements(case when jsonb_typeof(b.found) = 'array' then b.found else '[]'::jsonb end) x
   where b.artist_id = a_id and b.status = 'done';
  select coalesce(sum(jsonb_array_length(b.urls)), 0) into arts from tour_find_batches b where b.artist_id = a_id and b.status in ('done', 'failed');
  merged := public.tour_find_merge(items);
  n := public.tour_find_propose_in(a_id, merged);
  k := public.tour_find_autofill(a_id);
  select f.unread into v_unread from tour_finds f where f.artist_id = a_id;
  update tour_finds set status = 'done', extracting_at = null, finished_at = now(),
         detail = 'Read ' || arts || ' articles: ' || jsonb_array_length(merged) || ' tours found, ' || n || ' new, ' || k || ' added to the page'
                  || case when coalesce(v_unread, 0) > 0 then ', ' || v_unread || ' articles the reader couldn’t make out' else '' end
   where artist_id = a_id;
  delete from tour_find_batches where artist_id = a_id;
end $$;
revoke all on function public.tour_find_finish(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. Start, state, pages, tick
-- ---------------------------------------------------------------------------
-- Starting a read keeps the finds still waiting on the owner (a Look again
-- used to delete them while their articles stayed read, so they were gone
-- for good) and clears the server's own work from last time.
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
  delete from tour_find_batches where artist_id = a_id;
  delete from tour_find_wiki where artist_id = a_id;
  insert into tour_finds (artist_id, owner_id, status, detail, slug, prp_tag, prp_pages, prp_next, lg_state, tries, fired_at, started_at, finished_at, day)
  values (a_id, auth.uid(), 'reading', '', sl, null, 0, 0, 'new', 0, null, now(), null, current_date)
  on conflict (artist_id) do update
    set owner_id = excluded.owner_id, status = 'reading', detail = '', slug = excluded.slug,
        prp_next = case when tour_finds.prp_tag is not null then 1 else 0 end, prp_pages = greatest(tour_finds.prp_pages, 1),
        lg_state = 'new', tries = 0, fired_at = null, started_at = now(), finished_at = null, day = current_date, extracting_at = null,
        wiki = 'new', brain = '', unread = 0;
  foreach hst in array public.tour_find_hosts() loop
    insert into tour_find_sources (artist_id, host) values (a_id, hst)
    on conflict (artist_id, host) do update set next = case when tour_find_sources.tag is not null then 1 else 0 end, pages = greatest(tour_find_sources.pages, 1);
  end loop;
  return public.tour_find_state(a_id);
end $$;
revoke all on function public.tour_find_start(uuid) from public, anon;
grant execute on function public.tour_find_start(uuid) to authenticated;

-- How long the rest should take, in seconds, for the "come back in…" line:
-- fifteen-second rounds for the archives, about twelve seconds an article
-- batch for the reader (two at a time).
create or replace function public.tour_find_eta(a_id uuid)
returns int
language plpgsql stable security definer set search_path = public as $$
declare f record; rounds int := 0; v_unread int; left_b int; sec int := 0;
begin
  select * into f from tour_finds where artist_id = a_id;
  if not found then return 0; end if;
  select count(*) into v_unread from tour_find_pages g where g.artist_id = a_id and g.fetched and g.body <> '' and g.read_at is null;
  if f.status = 'reading' then
    rounds := ceil((select count(*) from tour_find_pages g where g.artist_id = a_id and not g.fetched) / 4.0)
            + coalesce((select max(greatest(s.pages - s.next + 1, 1)) from tour_find_sources s where s.artist_id = a_id and s.next >= 0), 0)
            + case when f.prp_next > 0 then greatest(f.prp_pages - f.prp_next + 1, 1) when f.prp_next = 0 then 2 else 0 end
            + case when f.lg_state in ('new', 'retry') then 3 else 0 end;
    sec := rounds * 15 + ceil((v_unread + 20) / 5.0) * 12 + 30;
  elsif f.status = 'thinking' then
    select count(*) into left_b from tour_find_batches b where b.artist_id = a_id and b.status in ('todo', 'asked');
    sec := left_b * 12 + case when f.wiki <> 'done' then 20 else 0 end + 10;
  elsif f.status in ('ready', 'extracting') then
    sec := ceil(v_unread / 5.0) * 25 + 10;
  end if;
  return sec;
end $$;
revoke all on function public.tour_find_eta(uuid) from public, anon, authenticated;

create or replace function public.tour_find_state(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare f record;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  perform public.tour_find_absorb(a_id);
  perform public.tour_find_fire(a_id);
  perform public.tour_find_brain(a_id);
  select * into f from tour_finds where artist_id = a_id;
  if f.status = 'extracting' and f.extracting_at < now() - interval '5 minutes' then
    update tour_finds set status = 'ready', extracting_at = null where artist_id = a_id;
    f.status := 'ready';
  end if;
  return jsonb_build_object(
    'status', coalesce(f.status, 'idle'),
    'detail', coalesce(f.detail, ''),
    'day', f.day,
    'today', current_date,
    'startedAt', f.started_at,
    'finishedAt', f.finished_at,
    'brain', public.tour_find_key() is not null and coalesce(f.brain, '') <> 'bad_key',
    'eta', case when f.status in ('reading', 'thinking', 'ready', 'extracting') then public.tour_find_eta(a_id) else 0 end,
    'unread', coalesce(f.unread, 0),
    'pages', (select count(*) from tour_find_pages g where g.artist_id = a_id and g.fetched and g.body <> ''),
    'waiting', (select count(*) from tour_find_pages g where g.artist_id = a_id and not g.fetched),
    'batches', jsonb_build_object(
        'total', (select count(*) from tour_find_batches b where b.artist_id = a_id and b.status in ('todo', 'asked', 'done', 'failed')),
        'done', (select count(*) from tour_find_batches b where b.artist_id = a_id and b.status in ('done', 'failed'))),
    'sources', jsonb_build_object('theprp', case when f.prp_next is null then 'new' when f.prp_next = 0 then 'new' when f.prp_next > 0 then 'reading' else 'done' end,
                                  'lambgoat', coalesce(f.lg_state, 'new'), 'lambgoatHttp', f.lg_http,
                                  'sites', (select count(*) from tour_find_sources s where s.artist_id = a_id),
                                  'sitesDone', (select count(*) from tour_find_sources s where s.artist_id = a_id and s.next < 0),
                                  'sitesWithNews', (select count(distinct g.source) from tour_find_pages g where g.artist_id = a_id and g.fetched and g.body <> '')),
    'runs', coalesce(public.tour_find_runs(a_id), '[]'::jsonb),
    'candidates', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'role', c.role, 'first', c.first_day, 'last', c.last_day, 'region', c.region,
        'lineup', c.lineup, 'n', jsonb_array_length(c.dates), 'sources', c.sources, 'status', c.status, 'fill', c.fill,
        'auto', c.auto, 'decidedAt', c.decided_at,
        'matched', (select count(*) from artist_history_shows h where h.artist_id = a_id and h.tour = '' and public.tour_cand_night(c, h.date)),
        'have', (select count(*) from artist_history_shows h where h.artist_id = a_id and public.tour_cand_night(c, h.date)),
        'named', (select count(*) from artist_history_shows h where h.artist_id = a_id and h.named_by = c.id),
        'toAdd', (select count(*) from jsonb_array_elements(c.dates) x
                   where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'date')::date <= current_date
                     and not exists (select 1 from artist_history_shows h where h.artist_id = a_id and h.date = (x ->> 'date')::date)))
        order by c.status = 'new' desc, c.decided_at desc nulls last, c.first_day desc nulls last)
      from tour_candidates c where c.artist_id = a_id), '[]'::jsonb));
end $$;
revoke all on function public.tour_find_state(uuid) from public, anon;
grant execute on function public.tour_find_state(uuid) to authenticated;

-- The phone's share: only when the server isn't reading.
create or replace function public.tour_find_pages_get(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare f record;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  select * into f from tour_finds where artist_id = a_id;
  if not found then return null; end if;
  if f.status = 'thinking' then return null; end if;
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

-- Every fifteen seconds: reads in progress move along, the server's own
-- reading too, whether or not anyone has the page open.
create or replace function public.tour_find_tick()
returns int
language plpgsql volatile security definer set search_path = public as $$
declare f record; n int := 0;
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
  update tour_finds set status = 'error', extracting_at = null, detail = 'Reading took too long. Try again.'
   where status = 'thinking' and started_at <= now() - interval '3 hours';
  if to_char(now(), 'HH24:MI') = '06:10' and extract(second from now()) < 15 then
    for f in select distinct artist_id from tour_candidates where status = 'added' loop
      perform public.tour_find_apply(f.artist_id);
      perform public.setlist_summarize(f.artist_id);
    end loop;
  end if;
  return n;
end $$;
revoke all on function public.tour_find_tick() from public, anon, authenticated;
do $$
begin
  perform cron.unschedule('greenroom-tourfind')
    where exists (select 1 from cron.job where jobname = 'greenroom-tourfind');
  perform cron.schedule('greenroom-tourfind', '15 seconds', 'select public.tour_find_tick()');
end $$;

notify pgrst, 'reload schema';
