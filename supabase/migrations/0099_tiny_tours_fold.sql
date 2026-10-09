-- A tiny tour inside another tour's run (Devin, 2026-10-08: "The Pulling Your
-- Pud Tour only has 1 show. Why"). One fan's label on one setlist.fm night
-- in the middle of an eighteen-night run made a one-night tour.
--  1. A tour of three nights or fewer whose every night sits inside another
--     tour's run (a night of that tour within six days before and after)
--     folds into it.
--  2. When tours fold, a real name beats a description: a list of bands
--     ending in "tour" ("A Day To Remember, Parkway Drive, etc. tour") is the
--     reader saying it couldn't find the name, and gives way to one that
--     looks like a name — however many nights each held.

create or replace function public.tour_find_madeup(nm text)
returns boolean
language sql immutable as $$
  select coalesce(nm, '') ~* '^(spring|summer|fall|autumn|winter|early|late|mid|\d{4}|[a-z]+(\s*[–—-]\s*[a-z]+)?\s+\d{4})\y'
      or coalesce(nm, '') ~* 'etc\.?,?\s+tour\.?$'
      or coalesce(nm, '') ~* '^[^,]+,[^,]+,.*\ytour\.?$'
$$;
revoke all on function public.tour_find_madeup(text) from public, anon, authenticated;

-- One fold: the loser's key points at the winner's; a real name outranks a description.
create or replace function public.tour_fold_one(a_id uuid, wk text, wn text, lk text, ln text)
returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  insert into artist_tour_edits (artist_id, key, alias_key) values (a_id, lk, wk)
  on conflict (artist_id, key) do update set alias_key = excluded.alias_key, hidden = false;
  update artist_tour_edits set alias_key = wk where artist_id = a_id and alias_key = lk;
  if public.tour_find_madeup(wn) and not public.tour_find_madeup(ln) then
    insert into artist_tour_edits (artist_id, key, new_name) values (a_id, wk, ln)
    on conflict (artist_id, key) do update set new_name = case when artist_tour_edits.new_name = '' then excluded.new_name else artist_tour_edits.new_name end;
  end if;
end $$;
revoke all on function public.tour_fold_one(uuid, text, text, text, text) from public, anon, authenticated;

create or replace function public.tour_find_fold(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare c record; p record; g record; folds int := 0; kc text; win_name text; nights_win int; nights_lose int;
begin
  -- 1. A find and a page tour that are the same tour under two spellings.
  for c in select t.id, t.name, t.dates from tour_candidates t where t.artist_id = a_id and t.status = 'added' and t.name <> '' and jsonb_array_length(t.dates) > 0
  loop
    kc := public.artist_tour_gkey(a_id, c.name);
    for p in select public.artist_tour_gkey(a_id, h.tour) as key, mode() within group (order by h.tour) as name
               from jsonb_array_elements(c.dates) d join artist_history_shows h on h.artist_id = a_id and h.date = (d ->> 'date')::date and h.tour <> ''
              where public.artist_tour_gkey(a_id, h.tour) <> kc
              group by 1
    loop
      if not public.tour_names_alike(kc, p.key) then continue; end if;
      select count(*) into nights_lose from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = kc;
      select count(*) into nights_win from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = p.key;
      if nights_win >= nights_lose then
        perform public.tour_fold_one(a_id, p.key, p.name, kc, c.name);
        update tour_candidates set name = p.name where id = c.id;
        kc := p.key;
      else
        select mode() within group (order by h.tour) into win_name from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = kc;
        perform public.tour_fold_one(a_id, kc, win_name, p.key, p.name);
      end if;
      folds := folds + 1;
    end loop;
  end loop;
  -- 2. A tiny tour whose every night sits inside another tour's run.
  for g in
    with grp as (select public.artist_tour_gkey(a_id, h.tour) as key, mode() within group (order by h.tour) as name, count(*) as n,
                        array_agg(h.date order by h.date) as dates
                   from artist_history_shows h where h.artist_id = a_id and h.tour <> ''
                    and not exists (select 1 from artist_tour_edits e where e.artist_id = a_id and e.hidden and e.key = public.artist_tour_gkey(a_id, h.tour))
                  group by 1)
    select s.key as small_key, s.name as small_name, b.key as big_key, b.name as big_name
      from grp s
      join lateral (
        select o.key, o.name from grp o
         where o.key <> s.key and o.n >= 5
           and not exists (select 1 from unnest(s.dates) sd
                            where not exists (select 1 from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = o.key and h.date between sd - 6 and sd - 1)
                               or not exists (select 1 from artist_history_shows h where h.artist_id = a_id and public.artist_tour_gkey(a_id, h.tour) = o.key and h.date between sd + 1 and sd + 6))
         order by o.n desc limit 1) b on true
     where s.n <= 3
  loop
    perform public.tour_fold_one(a_id, g.big_key, g.big_name, g.small_key, g.small_name);
    folds := folds + 1;
  end loop;
  return folds;
end $$;
revoke all on function public.tour_find_fold(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
