-- Cross-checking the shows against the tours (Devin, 2026-10-08: "see if any
-- of the shows listed in the shows column are suppose to be logged in the
-- tours listed … fact check all the tours with all the shows"). After every
-- scan and every setlist.fm sync:
--  1. A night with no tour that sits inside a tour's run (a night of that tour
--     within six days before AND after) is filed under it.
--  2. A night with no tour at the edge of a run (a night of one tour within
--     three days on one side only) is a question: part of that tour, or not?
--     It gets the tour's tag and the picker, with "not part of a tour" as the
--     other answer.
--  3. A named night far from the rest of its tour (more than thirty days
--     from its nearest other night) is a question the same way.
-- A night the owner has settled once is never asked about again.

create table if not exists public.artist_tour_checked (
  artist_id uuid not null references public.artists (id) on delete cascade,
  date date not null,
  primary key (artist_id, date)
);
alter table public.artist_tour_checked enable row level security;
revoke all on public.artist_tour_checked from public, anon, authenticated;

create or replace function public.tour_fact_check(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare filed int := 0; asked int := 0; r record;
begin
  -- 1. Inside a run: filed.
  for r in
    with named as (select h.date, public.setlist_tour_key(h.tour) as key, mode() within group (order by h.tour) as name
                     from artist_history_shows h where h.artist_id = a_id and h.tour <> ''
                      and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.setlist_tour_key(h.tour))
                    group by h.date, public.setlist_tour_key(h.tour))
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
  -- 2. At the edge of a run: asked.
  for r in
    with named as (select h.date, public.setlist_tour_key(h.tour) as key, mode() within group (order by h.tour) as name
                     from artist_history_shows h where h.artist_id = a_id and h.tour <> ''
                      and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.setlist_tour_key(h.tour))
                    group by h.date, public.setlist_tour_key(h.tour))
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
  -- 3. Far from the rest of its tour: asked.
  for r in
    with named as (select h.date, h.tour, public.setlist_tour_key(h.tour) as key
                     from artist_history_shows h where h.artist_id = a_id and h.tour <> ''
                      and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.setlist_tour_key(h.tour)))
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

-- Settling a night remembers it, so the check never asks about it again.
create or replace function public.artist_tour_pick(a_id uuid, night date, tour_name text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare nm text; k text;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  nm := left(btrim(regexp_replace(coalesce(tour_name, ''), '\s+', ' ', 'g')), 120);
  if nm = '' then
    delete from artist_history_shows h where h.artist_id = a_id and h.date = night and h.pinned;
    update artist_history_shows set tour = '', named_by = null where artist_id = a_id and date = night;
  else
    k := public.artist_tour_key_of(a_id, nm);
    select coalesce((select h.tour from artist_history_shows h where h.artist_id = a_id and public.setlist_tour_key(h.tour) = k and h.tour <> '' limit 1), nm) into nm;
    update artist_history_shows set tour = nm where artist_id = a_id and date = night;
  end if;
  delete from artist_tour_conflicts where artist_id = a_id and date = night;
  insert into artist_tour_checked (artist_id, date) values (a_id, night) on conflict do nothing;
  perform public.setlist_summarize(a_id);
  return jsonb_build_object('ok', true, 'left', (select count(*) from artist_tour_conflicts cf where cf.artist_id = a_id));
end $$;
revoke all on function public.artist_tour_pick(uuid, date, text) from public, anon;
grant execute on function public.artist_tour_pick(uuid, date, text) to authenticated;

-- The picker's list: a question with no second tour reads b = ''.
-- (artist_tour_conflicts already returns name_b as is.)

-- After every scan: autofill ends with the check.
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
    if not (adds or names or c.fill) then
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
  if k > 0 then
    perform public.tour_find_apply(a_id);
    perform public.setlist_summarize(a_id);
  end if;
  perform public.tour_fact_check(a_id);
  return k;
end $$;
revoke all on function public.tour_find_autofill(uuid, boolean) from public, anon, authenticated;

-- After every setlist.fm sync: the check, once the new nights are in.
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
