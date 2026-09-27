-- Every atVenu report the mailbox reads is kept here as what it said (the
-- date, the venue, the net, the cash, the per head), whether or not a show
-- matched it. "Refresh" lays them back onto a tour, so starting a tour over
-- never loses a settlement. Each tour manager sees only their own.
create table public.merch_reports (
  id text primary key default gen_random_uuid()::text,
  owner_id uuid references auth.users (id) on delete cascade,
  tour_tag text,
  date date not null,
  venue text not null default '',
  city text not null default '',
  merch numeric not null,
  cash numeric,
  notes jsonb not null default '[]'::jsonb,
  received_at timestamptz not null default now(),
  unique (owner_id, date, merch)
);
alter table public.merch_reports enable row level security;
create policy merch_reports_select on public.merch_reports for select using (owner_id = auth.uid());

-- What the mailbox already filed lives on as the tours' import stamps
-- ("em-<date>-<cents>", source "atVenu email"), deleted tours included.
insert into public.merch_reports (owner_id, tour_tag, date, venue, city, merch, cash, notes, received_at)
select t.owner_id, t.id,
       (substring(i.key from 'em-(\d{4}-\d{2}-\d{2})-'))::date,
       coalesce(sh.value ->> 'venue', ''), coalesce(sh.value ->> 'city', ''),
       (i.value ->> 'total')::numeric,
       nullif(sh.value ->> 'merchCash', '')::numeric,
       coalesce((select jsonb_agg(n) from jsonb_array_elements(coalesce(sh.value -> 'settlementNotes', '[]'::jsonb)) n
                  where n ->> 'label' ~* '(merch|per head|attendance|fees)'), '[]'::jsonb),
       to_timestamp(coalesce((i.value ->> 'createdAt')::bigint, 0) / 1000.0)
  from public.tours t
  cross join jsonb_each(coalesce(t.doc -> 'imports', '{}'::jsonb)) i
  left join lateral (
    select s.value from jsonb_each(coalesce(t.doc -> 'shows', '{}'::jsonb)) s
     where s.value ->> 'date' = substring(i.key from 'em-(\d{4}-\d{2}-\d{2})-') limit 1
  ) sh on true
 where i.value ->> 'source' = 'atVenu email'
   and substring(i.key from 'em-(\d{4}-\d{2}-\d{2})-') is not null
on conflict (owner_id, date, merch) do nothing;
