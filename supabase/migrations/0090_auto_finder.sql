-- The finder runs by itself (Devin, 2026-10-08: "I am basically trying to
-- make this as easy as possible for artists. I don't want them to have to do
-- these extra steps."). A page an act's own people run gets searched without
-- anyone tapping anything — once the reading key is in Vault, since without it
-- a search needs a phone to finish — and searched again a month later, as new
-- announcements land. Paced at one start per tick and ten a day, so a busy
-- day can't run up a bill. Pages nobody has claimed are not searched by
-- themselves (every one would cost a read); they get it when claimed.

alter table public.tour_finds add column if not exists auto boolean not null default false;

-- Starting a read, inside: what tour_find_start did, for anyone the server trusts.
create or replace function public.tour_find_begin(a_id uuid, who uuid, by_itself boolean default false)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare nm text; sl text; hst text;
begin
  select a.name into nm from artists a where a.id = a_id;
  sl := btrim(regexp_replace(lower(coalesce(nm, '')), '[^a-z0-9]+', '-', 'g'), '-');
  delete from tour_find_requests where artist_id = a_id;
  delete from tour_find_batches where artist_id = a_id;
  delete from tour_find_wiki where artist_id = a_id;
  insert into tour_finds (artist_id, owner_id, status, detail, slug, prp_tag, prp_pages, prp_next, lg_state, tries, fired_at, started_at, finished_at, day, auto)
  values (a_id, who, 'reading', '', sl, null, 0, 0, 'new', 0, null, now(), null, current_date, by_itself)
  on conflict (artist_id) do update
    set owner_id = excluded.owner_id, status = 'reading', detail = '', slug = excluded.slug,
        prp_next = case when tour_finds.prp_tag is not null then 1 else 0 end, prp_pages = greatest(tour_finds.prp_pages, 1),
        lg_state = 'new', tries = 0, fired_at = null, started_at = now(), finished_at = null, day = current_date, extracting_at = null,
        wiki = 'new', brain = '', unread = 0, auto = excluded.auto;
  foreach hst in array public.tour_find_hosts() loop
    insert into tour_find_sources (artist_id, host) values (a_id, hst)
    on conflict (artist_id, host) do update set next = case when tour_find_sources.tag is not null then 1 else 0 end, pages = greatest(tour_find_sources.pages, 1);
  end loop;
end $$;
revoke all on function public.tour_find_begin(uuid, uuid, boolean) from public, anon, authenticated;

create or replace function public.tour_find_start(a_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare f record;
begin
  if not public.tour_find_may(a_id) then raise exception 'permission' using errcode = '42501'; end if;
  select * into f from tour_finds where artist_id = a_id;
  if found and f.day = current_date and f.status <> 'error' then return public.tour_find_state(a_id); end if;
  perform public.tour_find_begin(a_id, auth.uid(), false);
  return public.tour_find_state(a_id);
end $$;
revoke all on function public.tour_find_start(uuid) from public, anon;
grant execute on function public.tour_find_start(uuid) to authenticated;

-- Which page is next for a search of its own: claimed and verified, with a
-- road story, never searched or not in the last thirty days, nothing running.
create or replace function public.tour_find_next_auto()
returns uuid
language sql stable security definer set search_path = public as $$
  select a.id from artists a
    join artist_history h on h.artist_id = a.id and h.status = 'ok'
    left join tour_finds f on f.artist_id = a.id
   where a.owner_id is not null and a.verified
     and (f.artist_id is null or (f.status in ('done', 'error') and coalesce(f.finished_at, f.started_at) < now() - interval '30 days'))
     and not exists (select 1 from tour_finds g where g.artist_id = a.id and g.day = current_date)
   order by f.finished_at nulls first, a.created_at
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
  -- A search of its own: one start a tick, ten a day, only with the key in Vault
  -- (without it a search needs a phone to finish) and only while nothing else is reading.
  if public.tour_find_key() is not null
     and (select count(*) from tour_finds t where t.auto and t.started_at > now() - interval '24 hours') < 10
     and not exists (select 1 from tour_finds t where t.status in ('reading', 'ready', 'thinking', 'extracting') and t.started_at > now() - interval '3 hours') then
    nxt := public.tour_find_next_auto();
    if nxt is not null then
      select a.owner_id into who from artists a where a.id = nxt;
      perform public.tour_find_begin(nxt, who, true);
      n := n + 1;
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

-- The state says when the page was searched by itself.
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
    'auto', coalesce(f.auto, false),
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

notify pgrst, 'reload schema';
