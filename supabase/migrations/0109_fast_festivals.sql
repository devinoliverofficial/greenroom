-- Fast festival naming (2026-10-09): the festival check ran a table scan per
-- call and the grounds matcher cleaned 298 rows with regexes for every night,
-- so a cross-check of a 1,300-night page took minutes. The festival names are
-- now a fixed list inside the function (regenerate when the grounds table is
-- re-seeded), and each grounds row keeps its cleaned place names in a column.

create or replace function public.tour_is_festival(nm text)
returns boolean
language sql immutable as $$
  select coalesce(nm, '') ~* '(\mfest\M|fest\M|festival|\mwarped\M|\mjam\M|rock am ring|rock im park|\msxsw\M|bamboozle|soundwave|slam dunk|louder than life|rockville|aftershock|inkcarceration|sonic temple|so what|\mdownload\M|hellfest|graspop|groezrock|riot fest|self help|skate and surf|summer slaughter|palooza)'
      or lower(coalesce(nm, '')) ~ '(decibel magazine metal \& beer fest|austin city limits music festival|voodoo music \+ arts experience|rockstar energy uproar festival|alternative press music awards|best friends forever festival|tuska open air metal festival|primavera sound buenos aires|download festival australia|big mountain music festival|shaky knees music festival|monsters of rock argentina|corona capital guadalajara|vans warped tour australia|hell \& heaven metal fest|primavera sound sao paulo|four chord music festival|download festival ireland|so what\?! music festival|gathering of the juggalos|rockstar disrupt festival|sasquatch! music festival|rising sun rock festival|festival d''été de québec|never say never festival|rockfest \(kansas city\)|blue ridge rock festival|primavera sound santiago|download festival france|alcatraz metal festival|skate and surf festival|monsters of rock brazil|download festival spain|yours and owls festival|bottlerock napa valley|rock in japan festival|planeta terra festival|summer breeze open air|firefly music festival|lollapalooza argentina|isle of wight festival|monsters of rock chile|splendour in the grass|graspop metal meeting|camden rocks festival|hit the deck festival|burn it down festival|auckland city limits|pepsi music festival|milwaukee metal fest|summer breeze brasil|teddy rocks festival|summer sonic bangkok|monterrey metal fest|santiago gets louder|glastonbury festival|sweden rock festival|welcome to rockville|hevy music festival|greenfield festival|sonisphere festival|vainstream rockfest|maho rasop festival|lollapalooza brasil|river city rockfest|sad summer festival|good vibes festival|maquinaria festival|bloodstock open air|montebello rockfest|arctangent festival|sonic boom festival|slam dunk festival|carolina rebellion|self help festival|impericon festival|lollapalooza chile|knotfest argentina|hurricane festival|maryland deathfest|nova rock festival|knotfest australia|2000trees festival|southside festival|when we were young|fuji rock festival|life is beautiful|rock on the range|earthday birthday|resurrection fest|download festival|takedown festival|upheaval festival|tecate coordenada|northern invasion|outbreak festival|bourbon \& beyond|punk rock bowling|tecate pa''l norte|rockaway festival|beyond the valley|adjacent festival|download scotland|knotfest colombia|java rockin''land|psycho las vegas|houston open air|summer slaughter|reading festival|pulp summer slam|chicago open air|satanic carnival|laneway festival|synchronize fest|rhythm and vines|maximus festival|louder than life|pinkpop festival|knotfest mexico|wacken open air|with full force|unify gathering|countdown japan|sziget festival|knotfest brasil|rock allegiance|mystic festival|rock for people|groovin the moo|mayhem festival|open air gampel|knotfest japan|falls festival|taste of chaos|festival nrmal|ohana festival|download japan|brutal assault|knotfest chile|rock al parque|inkcarceration|sick new world|heavy montréal|estereo picnic|rock in vienna|boston calling|leeds festival|governors ball|corona capital|vivo x el rock|moondance jam|personal fest|rock werchter|soundrenaline|exit festival|bazooka rocks|outside lands|the bamboozle|ozzfest japan|rock carnival|sonic temple|tons of rock|machaca fest|viva la rock|rock in solo|lollapalooza|cosquin rock|rock''n derby|rock am ring|rock im park|heavy t\.o\.|furnace fest|quilmes rock|summer sonic|no sleep til|rock in rio|hammersonic|bumbershoot|jakarta jam|vive latino|we the fest|good things|warped tour|big day out|sunburst kl|jera on air|wonderfruit|wanderland|rockavaria|butserfest|punkspring|force fest|aftershock|domination|98rockfest|sonic bang|full force|southbound|spilt milk|rocklahoma|japan jam|epicenter|coachella|loud park|groezrock|pestapora|fort rock|copenhell|rock fest|riot fest|bluesfest|metaldays|dirt fest|homegrown|ghostfest|soundwave|provinssi|fortarock|bled fest|the fest|exit 111|singfest|homebake|rock usa|knotfest|baybeats|westfest|edgefest|hellfest|bonnaroo|the town|ozzfest|air jam|metrock|osheaga|splore|trnsmt)'
$$;
revoke all on function public.tour_is_festival(text) from public, anon, authenticated;

create or replace function public.tour_name_clean(nm text)
returns text
language sql immutable as $$
  select case when public.tour_is_festival(nm)
              then btrim(regexp_replace(coalesce(nm, ''), '\s+[–—-]\s+[A-Z][A-Za-z.\s]+(,\s*[A-Za-z.]{2,})?\s*$', ''))
              else coalesce(nm, '') end
$$;
revoke all on function public.tour_name_clean(text) from public, anon, authenticated;

alter table public.festival_grounds add column if not exists places text[] not null default '{}';
update public.festival_grounds fg set places = coalesce((
  select array_agg(p) from (
    select lower(btrim(regexp_replace(regexp_replace(t, '\([^)]*\)|\b(19|20)\d{2}(\s*[-–]\s*((19|20)\d{2})?)?|\b(and|cancelled|canceled|for rain|since|from|to|only|various|touring)\b', ' ', 'gi'), '\s+', ' ', 'g'))) as p
      from unnest(regexp_split_to_array(fg.grounds, '\s*[,;]\s*|\s+and\s+')) t) x
   where length(p) >= 6
     and p not in ('park', 'stage', 'arena', 'grounds', 'festival grounds', 'fairgrounds', 'showgrounds', 'amphitheater', 'amphitheatre', 'main stage', 'second stage')), '{}');

create or replace function public.festival_grounds_match(v text, c text, cc text, d date)
returns text
language sql stable as $$
  select g.name || ' ' || extract(year from d)::int
    from festival_grounds g, unnest(g.places) place
   where d is not null
     and (g.country_code = '' or g.country_code = coalesce(cc, ''))
     and (cardinality(g.months) = 0 or extract(month from d)::int = any (g.months))
     and (g.first_year is null or extract(year from d)::int >= g.first_year)
     and (g.last_year is null or extract(year from d)::int <= g.last_year)
     and (lower(coalesce(v, '')) like '%' || place || '%'
          or (length(coalesce(v, '')) >= 8 and place like '%' || lower(v) || '%'))
     and (g.city = '' or lower(coalesce(c, '')) = lower(g.city) or lower(coalesce(v, '')) like '%' || lower(g.city) || '%'
          or place like '%' || lower(coalesce(c, '')) || '%')
   order by (lower(coalesce(c, '')) = lower(g.city)) desc, length(place) desc
   limit 1
$$;
revoke all on function public.festival_grounds_match(text, text, text, date) from public, anon, authenticated;

-- Only the nights that could be festivals are matched against the grounds, once each.
create or replace function public.festival_tag(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int := 0; k int;
begin
  update artist_history_shows h set festival = h.tour
   where h.artist_id = a_id and h.festival = '' and h.tour <> ''
     and public.tour_is_festival(h.tour) and not public.tour_find_madeup(h.tour);
  get diagnostics k = row_count; n := n + k;
  update artist_history_shows h set festival = c.name
    from tour_candidates c
   where h.artist_id = a_id and h.festival = '' and c.artist_id = a_id and c.status = 'added' and c.name <> ''
     and public.tour_is_festival(c.name) and not public.tour_find_madeup(c.name)
     and exists (select 1 from jsonb_array_elements(c.dates) x
                  where (x ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'date')::date = h.date);
  get diagnostics k = row_count; n := n + k;
  update artist_history_shows h set festival = m.f
    from (select h2.id, public.festival_grounds_match(h2.venue, h2.city, h2.country_code, h2.date) as f
            from artist_history_shows h2
           where h2.artist_id = a_id and h2.festival = ''
             and (h2.tour = '' or public.tour_is_festival(h2.tour) or h2.venue ~* '\mstage\M')) m
   where h.artist_id = a_id and h.id = m.id and m.f is not null;
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;
revoke all on function public.festival_tag(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
