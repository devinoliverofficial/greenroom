-- Two more press sites the reader can search (checked 2026-10-09: their
-- WordPress search and tags answer; Loudwire, Blabbermouth, Metal Injection,
-- MetalSucks, Punknews, Kerrang, Digital Tour Bus, Wall of Sound and Hysteria
-- do not, so they stay hand-read sources, see SOURCES.md).
create or replace function public.tour_find_hosts()
returns text[]
language sql immutable as $$
  select array['www.altpress.com', 'www.brooklynvegan.com', 'newnoisemagazine.com', 'idobi.com', 'www.rocksound.tv',
               'distortedsoundmag.com', 'www.ghostcultmag.com', 'bringthenoiseuk.com',
               'alreadyheard.com', 'www.theaquarian.com', 'www.highlightmagazine.net', 'www.revolvermag.com',
               'musicfeeds.com.au', 'substreammagazine.com']
$$;
revoke all on function public.tour_find_hosts() from public, anon, authenticated;

-- Pages already scanned get the new sites on their next rescan; pages still
-- reading get them now.
insert into public.tour_find_sources (artist_id, host)
select f.artist_id, h
  from public.tour_finds f, unnest(array['musicfeeds.com.au', 'substreammagazine.com']) h
 where f.status = 'reading'
on conflict do nothing;

notify pgrst, 'reload schema';
