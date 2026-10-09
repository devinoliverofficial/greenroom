-- A move is a move (2026-10-09). The first full run of the band's-own-pages pass on
-- I See Stars "moved" six nights, and every one was a respelling: the band's
-- own typos ("Cincinatti", "Philidelphia"), a suburb written as its city (the
-- Boardwalk in Orangevale listed under Sacramento), a note in brackets. They
-- were put back by hand. A night is now moved only when the band's last list
-- has it in a different city AND a different room, with the room named; a
-- place that shares a word or sounds the same is the same place. The same run
-- also added a show the band's later list marked "NO LONGER PLAYING": the
-- reader is now told to leave those out.

create or replace function public.tf_same_place(a text, b text)
returns boolean
language sql immutable as $$
  with wa as (select w from regexp_split_to_table(lower(regexp_replace(coalesce(a, ''), '[^a-zA-Z0-9]+', ' ', 'g')), '\s+') w where length(w) >= 4),
       wb as (select w from regexp_split_to_table(lower(regexp_replace(coalesce(b, ''), '[^a-zA-Z0-9]+', ' ', 'g')), '\s+') w where length(w) >= 4)
  select exists (select 1 from wa join wb on wa.w = wb.w or extensions.dmetaphone(wa.w) = extensions.dmetaphone(wb.w))
$$;
revoke all on function public.tf_same_place(text, text) from public, anon, authenticated;

create or replace function public.tour_find_wb_settle(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare r record; dropped int := 0; moved int := 0; cc text;
begin
  create temp table if not exists twb (orig text, snap date, d date, city text, venue text) on commit drop;
  truncate twb;
  -- What each capture of each of the band's pages listed (a list of coming shows: nothing before the capture counts).
  insert into twb
  select lower(regexp_replace(regexp_replace(x.url, '^https://web\.archive\.org/web/\d+(id_)?/', ''), '^https?://(www\.)?|:80|/+$', '', 'g')),
         x.snap, (e ->> 'date')::date, coalesce(e ->> 'city', ''), coalesce(e ->> 'venue', '')
    from tour_find_wb x, jsonb_array_elements(x.dates) e
   where x.artist_id = a_id and x.read and x.snap is not null and (e ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
     and (e ->> 'date')::date >= x.snap - 1 and (e ->> 'date')::date <= x.snap + 500;
  if not exists (select 1 from twb) then return jsonb_build_object('dropped', 0, 'moved', 0); end if;
  create temp table if not exists tcap (orig text, snap date, lo date, hi date) on commit drop;
  truncate tcap;
  insert into tcap select t.orig, t.snap, min(t.d), max(t.d) from twb t group by t.orig, t.snap;

  -- 1. A show the band listed, then took off: its last list before that day covers the day and no
  -- longer has it (and no other page of the band's still does). Only a night that came from the
  -- band's own pages; never one the owner has settled.
  for r in
    select h.id, h.date, h.city, h.venue
      from artist_history_shows h
     where h.artist_id = a_id and h.pinned and h.url like 'https://web.archive.org/web/%'
       and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = h.date)
       and exists (
         select 1 from tcap c
          where c.snap <= h.date and c.lo <= h.date and c.hi >= h.date
            and c.snap = (select max(c2.snap) from tcap c2 where c2.orig = c.orig and c2.snap <= h.date and c2.lo <= h.date and c2.hi >= h.date)
            and not exists (select 1 from twb t where t.orig = c.orig and t.snap = c.snap and t.d = h.date)
            and exists (select 1 from twb t where t.orig = c.orig and t.snap < c.snap and t.d = h.date))
       and not exists (
         select 1 from tcap c
          where c.snap <= h.date and c.lo <= h.date and c.hi >= h.date
            and c.snap = (select max(c2.snap) from tcap c2 where c2.orig = c.orig and c2.snap <= h.date and c2.lo <= h.date and c2.hi >= h.date)
            and exists (select 1 from twb t where t.orig = c.orig and t.snap = c.snap and t.d = h.date))
  loop
    insert into tour_find_wb_log (artist_id, date, what, was, now_is, because)
    values (a_id, r.date, 'dropped', r.city || ' / ' || r.venue, '', 'the band''s own later list covers that day and no longer has it');
    delete from artist_history_shows where artist_id = a_id and id = r.id;
    update tour_candidates set dates = coalesce((select jsonb_agg(x) from jsonb_array_elements(dates) x where x ->> 'date' <> to_char(r.date, 'YYYY-MM-DD')), '[]'::jsonb)
     where artist_id = a_id and jsonb_typeof(dates) = 'array' and dates @> jsonb_build_array(jsonb_build_object('date', to_char(r.date, 'YYYY-MM-DD')));
    dropped := dropped + 1;
  end loop;

  -- 2. A show that moved to another city: the band's last list before the day says where. A
  -- respelling ("Cincinatti"), a suburb written for its city ("Sacramento" for Orangevale, the same
  -- room), or a list with no room named is not a move; nothing is changed for those.
  for r in
    select h.id, h.date, h.city, h.venue, h.country_code, l.city as c2, l.venue as v2
      from artist_history_shows h
      join lateral (select t.city, t.venue from twb t where t.d = h.date and t.snap <= h.date and t.city <> '' order by t.snap desc limit 1) l on true
     where h.artist_id = a_id and h.pinned and h.url like 'https://web.archive.org/web/%'
       and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = h.date)
       and not exists (select 1 from artist_night_overrides o where o.artist_id = a_id and o.date = h.date)
       and btrim(split_part(l.city, ',', 1)) <> ''
       and l.venue <> '' and l.venue !~* 'not listed|^\s*tb[ad]\s*$|to be announced'
       and not public.tf_same_place(h.city, split_part(l.city, ',', 1))
       and not public.tf_same_place(h.venue, l.venue)
  loop
    cc := coalesce(public.road_country(r.c2), '');
    if cc <> '' and cc <> coalesce(r.country_code, '') then continue; end if;
    insert into tour_find_wb_log (artist_id, date, what, was, now_is, because)
    values (a_id, r.date, 'moved', r.city || ' / ' || r.venue, r.c2 || ' / ' || r.v2, 'the band''s last list before the day has it in another city, in another room');
    update artist_history_shows
       set city = left(btrim(split_part(r.c2, ',', 1)), 80),
           state = case when coalesce(r.country_code, '') in ('US', 'CA') then left(btrim(split_part(r.c2, ',', 2)), 80) else state end,
           venue = left(r.v2, 120)
     where artist_id = a_id and id = r.id;
    moved := moved + 1;
  end loop;

  -- 3. One show listed on two neighbouring days (an announcement said the 4th, the band's own page
  -- said the 3rd): the band's latest list covering both days has only one of them; the other goes,
  -- if it is older word than that list and is not setlist.fm's.
  for r in
    select b.id, b.date, b.city, b.venue
      from artist_history_shows a
      join artist_history_shows b on b.artist_id = a.artist_id and abs(b.date - a.date) = 1 and lower(b.city) = lower(a.city) and b.city <> ''
     where a.artist_id = a_id and b.pinned
       and not exists (select 1 from artist_tour_checked k where k.artist_id = a_id and k.date = b.date)
       and exists (
         select 1 from tcap c
          where c.snap <= least(a.date, b.date) and c.lo <= least(a.date, b.date) and c.hi >= greatest(a.date, b.date)
            and c.snap = (select max(c2.snap) from tcap c2 where c2.snap <= least(a.date, b.date) and c2.lo <= least(a.date, b.date) and c2.hi >= greatest(a.date, b.date))
            and exists (select 1 from twb t where t.orig = c.orig and t.snap = c.snap and t.d = a.date)
            and not exists (select 1 from twb t where t.orig = c.orig and t.snap = c.snap and t.d = b.date)
            and coalesce(to_date(substring(b.url from '^https://web\.archive\.org/web/(\d{8})'), 'YYYYMMDD'),
                         (select g.published from tour_find_pages g where g.artist_id = a_id and g.url = b.url limit 1),
                         date '1900-01-01') < c.snap)
  loop
    insert into tour_find_wb_log (artist_id, date, what, was, now_is, because)
    values (a_id, r.date, 'dropped', r.city || ' / ' || r.venue, '', 'the same show a day apart: the band''s own later list has the other day');
    delete from artist_history_shows where artist_id = a_id and id = r.id;
    update tour_candidates set dates = coalesce((select jsonb_agg(x) from jsonb_array_elements(dates) x where x ->> 'date' <> to_char(r.date, 'YYYY-MM-DD')), '[]'::jsonb)
     where artist_id = a_id and jsonb_typeof(dates) = 'array' and dates @> jsonb_build_array(jsonb_build_object('date', to_char(r.date, 'YYYY-MM-DD')));
    dropped := dropped + 1;
  end loop;

  if dropped + moved > 0 then perform public.setlist_summarize(a_id); end if;
  return jsonb_build_object('dropped', dropped, 'moved', moved);
end $$;
revoke all on function public.tour_find_wb_settle(uuid) from public, anon, authenticated;

create or replace function public.tour_find_prompt(a_id uuid, nm text, urls jsonb)
returns text
language sql stable security definer set search_path = public as $$
  select 'TOUR FINDER. You are helping a touring app list the tours of the act "' || nm || '". Below are news articles and encyclopedia passages, each with its date and URL. '
      || 'Return ONLY a JSON array. Each item is one tour or run that ' || nm || ' was part of: a headline or co-headline tour, a support slot on another act’s tour, or a package/festival tour (Warped, Taste of Chaos). '
      || 'Fields: "name" (the announced tour name; if the run had no name, a short description such as "Fall 2018 run with Dance Gavin Dance"), '
      || '"role" (one of headline, co-headline, support, festival), "start" and "end" (YYYY-MM-DD; when a listing gives month/day only, take the year from the article date, and remember a run announced in the fall may start the next year), '
      || '"lineup" (the other acts, comma separated), "region" (US, UK/Europe, Australia, Japan, Canada…), '
      || '"dates" (every date listed for ' || nm || ', each as one short string "YYYY-MM-DD | City, ST | Venue"; an empty array if none are listed), "source" (the article URL). '
      || 'Rules: only runs ' || nm || ' is on; a festival appearance is one item named "<Festival> <year>" with ONLY the date(s) and city ' || nm || ' plays — never the other cities or days of that festival; skip anything that is not a show (album news, videos, members leaving); when a later article updates an earlier one (dates added, moved or cancelled) fold them into one item; never invent dates; if nothing qualifies return []. '
      || 'An item headed "The band''s own page as captured on <date>" is ' || nm || '''s own list of its shows on that day: return one item per tour name the list itself prints, and ALL its other shows together as ONE item with "name": "" (never make up a name for them); put EVERY show of the list under "dates" with its city and its venue (the venue only: acts after "w/" go in "lineup"); leave out any show the list marks cancelled, postponed or "no longer playing"; take the year from the listing, or from the capture date when it prints none (a list captured in December that says Jan 24 means the next January).' || E'\n\n'
      || coalesce((select string_agg('--- ARTICLE ' || x.n || ' | ' || coalesce(to_char(g.published, 'YYYY-MM-DD'), 'date unknown') || ' | ' || g.url || E'\n'
                                     || case when g.title <> '' then g.title || E'\n' else '' end || g.body || E'\n', E'\n' order by x.n)
                     from jsonb_array_elements_text(urls) with ordinality as x(url, n)
                     join tour_find_pages g on g.artist_id = a_id and g.url = x.url), '')
$$;
revoke all on function public.tour_find_prompt(uuid, text, jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';
