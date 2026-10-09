# How an artist's road story is built

What happens between someone typing a name into Search and that artist's page showing its
tours, shows, festivals, cities and countries. Written 2026-10-09, after a review of every
step since the first setlist.fm import and of everything that was done by hand for I See
Stars, so the same search can run for any artist. Companion files: [ARCHIVE.md](ARCHIVE.md)
(the plan for Greenroom's own archive) and [SOURCES.md](SOURCES.md) (every platform checked,
and what its terms allow).

## 1. What runs by itself for every page today

In order. Nothing here waits on the artist.

1. **Who is this.** A tap on a Search result makes the page from MusicBrainz (open data):
   name, country, and the MusicBrainz id everything else hangs off.
2. **setlist.fm.** Every setlist is read through their API: date, venue, city, country and
   the tour label a fan typed. Re-read daily for a claimed page with its own key, weekly on
   view for the rest. A pass that reads fewer setlists than setlist.fm reports prunes
   nothing and says so.
3. **The press.** ThePRP, Lambgoat and fourteen more sites with open search (Alternative
   Press, BrooklynVegan, New Noise, idobi, Rock Sound, Distorted Sound, Ghost Cult, Bring
   the Noise, Already Heard, The Aquarian, Highlight, Revolver, Music Feeds, Substream) are
   searched for the band's tag; every article is kept and read once.
4. **Wikipedia.** The band's article, tour articles that name it (date tables read from the
   source text), and festival articles that name it.
5. **The band's own pages** *(new 2026-10-09)*. MusicBrainz says where the band lived
   online; the usual handles are tried too (MySpace `<name>`, `<name>music`, `<name>band`,
   PureVolume `<name>`, read only if the page names the act). The Wayback Machine lists the
   captures (a MySpace page by day, an official site and its tour pages by month) and each
   capture's show list is read as "the band's own page on that date". The Wayback Machine
   goes down often: every lookup is retried, and a search it could not finish is run again a
   few hours on.
6. **The reader.** A small model turns each article or capture into tours and shows: name,
   dates, city, venue, the bands on the bill. It is metered (a monthly ceiling) and reads
   each page once.
7. **Stitching, by rule:**
   - *Fold.* Two spellings of one tour become one. A run named only by its bill takes the
     real name setlist.fm has for those nights. Two alike tours whose runs overlap are one.
   - *Apply.* Announced dates that have passed land as nights; a festival that lists many
     cities keeps only the day the act played.
   - *The band's last word.* A show the band took off its own list before the day is
     removed; one that moved city is moved; one printed on two neighbouring days is one
     show. Each change is logged. A run the page knew only by its bill takes the name the
     band's own page printed for it.
   - *Listed is not played.* An old list still showing (no year printed, and the same day
     in the same city already on the page a year or two earlier) is not taken. Announced
     nights from mid-March 2020 to mid-June 2021 do not land at all unless the band hands
     them over: almost none of them were played.
   - *Festivals.* setlist.fm's API has no festival field, so a night is named a festival
     from its tour label, from an announcement, or from a table of 298 festival grounds
     (grounds and stage names, city, months, years).
   - *Fact check.* A blank night inside a run is filed under it; a night at the edge of a
     run becomes a question for the owner. Album-era labels months long are treated as
     blanks. A festival's neighbours are never asked about.
   - *Settled nights.* Anything the owner or an editor has settled about one night (this
     tour, this room, this date never happened) is written down and re-applied last, after
     every sync and scan.
8. **The page.** Shows are counted once per date and venue, played nights only; a city once however its
   state or name was spelled; a touring festival as a tour, a one-off festival as a festival. The Tours
   list holds tours, festivals (tagged), and each year's shows outside any tour; every entry
   opens to its nights, each night linking to where it came from; a tour shows the bands it
   was with. A band member listed on the page carries the band's numbers, live.

## 2. What was done by hand for I See Stars, and where each stands now

| Done by hand | What it found | Now |
|---|---|---|
| Reading the band's MySpace show lists out of the Wayback Machine | 128 nights, 2007–2011; whole tours nobody else had | **Automatic** for every page (step 5) |
| Naming festival nights setlist.fm shows as plain venues | 35 nights, 20+ festivals | **Automatic** from the grounds table; the table itself is research and needs topping up |
| Checking each found night against its source; dropping stale or cancelled dates | 15 dates taken off, 7 re-venued | **Partly**: the band's-last-word rule does it for the band's own lists; press dates still rest on the reader |
| Reading old last.fm event pages for bills and one-offs | 44 nights | **By hand only.** last.fm's terms don't allow harvesting; a person or a research agent reads a page and cites it |
| Loudwire, Digital Tour Bus, venue pages, Flickr photo dates | about 20 nights | **By hand only**: no open search on those sites |
| Pollstar box-office pages in a library's scans | 7 confirmations, no new nights | **By hand only**; corroboration, not a source |
| Year-by-year web hunt by research agents, each night re-checked by a second agent | 221 verified nights in all | **By hand** (an afternoon of agents per artist); see build item 6 |
| Loading the verified nights and the corrections | — | **By hand** with scripts; see build item 2 |

## 3. The order of trust

When two sources disagree about a night:

1. What the owner settled.
2. A tour run in Greenroom itself (planned; ARCHIVE.md step 2).
3. A file the band handed over.
4. The band's own page, latest capture before the show.
5. setlist.fm (a setlist was typed in by someone who was there).
6. A press announcement (it says what was planned, not what happened).

A night is never invented: every one carries a source link, and a date a page could not
have meant (a month or more before the capture, its year printed nowhere) is not taken.

## 4. Still to build, in order

1. **Verify before adding.** After the reader answers, a plain text check that each date
   and city it returned is really printed in the page it cites; what is not there is
   dropped and logged. Cuts the reader's wrong-year and wrong-day slips at the source.
2. **A door for a checked list of nights.** What the loading scripts did, as a function the
   manage page and the research agents can call: nights with their own source links, tour
   names the page knows mapped to its spelling, new names made into tours with their bills.
3. **A yardstick.** Compare the page with a handed-over file (the band's Concert Archives
   or Bandsintown export): nights found over nights in the file, per year, and the holes
   per tour. The first real completeness number.
4. **The other bands on the bill.** Their MySpace and site captures list the same shows
   with this band's name on them; read through the same Wayback step. For I See Stars this
   is the remaining door to 2006–2008.
5. **More press.** Sites with no open search but a plain band page (Loudwire, Blabbermouth,
   MetalSucks, Metal Injection): read the list page, then the articles, the way Lambgoat is
   read now.
6. **The year-by-year hunt on the server.** A search key, a ladder of queries per thin year
   (the band, the year, "tour dates", each tour name, each gap month), results read and
   verified by items 1 and 2. This is the hand hunt, automated; it is the expensive one and
   wants the reading-cost plan settled first.
7. **MusicBrainz events and Wikidata tours** as a free floor on page birth (ARCHIVE.md
   step 5), and MusicBrainz festival events as a fourth way to name a festival.
8. **Bills fan out.** A night with a bill also lands on the other bands' pages as "reported
   by <band>", strikable in one tap (ARCHIVE.md step 6).
9. **Tours write themselves** from Greenroom tours (ARCHIVE.md step 2).

## 5. The scorecard for a page

What to look at to know whether a page is done. One server call returns all of it for any page
(`artist_history_scorecard`); the worked example is [ISS-ROAD-STORY.md](ISS-ROAD-STORY.md).

- setlist.fm's own total against the rows read; the age of the last sync.
- Nights by source (setlist.fm, each press site, the band's pages, hand-read).
- Nights per year against the years the band was active: a thin year is a gap to hunt.
- Tours with fewer than three nights; names that are descriptions; tours with no bill.
- Shows outside any tour, per year.
- Questions open for the owner, and their age.
- Festival nights named; nights on stages, parks and fairgrounds still unnamed.
- Dates with two rows; rows a day apart in the same city.
- The Wayback step: lookups answered, captures read, anything left to retry.
- The month's reading meter.

## 6. What a page costs

setlist.fm, MusicBrainz, Wikipedia and the Wayback Machine are free and paced politely.
The reader is the only spend: on the small model a full search of one artist (press plus
the band's own pages) is roughly 150–250 asks, a few cents. The monthly ceiling is 6,000
asks. The hand hunt by research agents is another matter: an afternoon of agents per
artist, which is why build item 6 waits on the reading-cost plan in TODO.md.

## 7. Limits, plainly

- No source holds every show. Concert Archives' count rests on fans logging shows, with
  support slots and festival lineups counted in; its doors are the band's own verified
  export and nothing else (see SOURCES.md).
- 2006–2008 for a band that young lives on its MySpace captures and the other bands'
  pages; what the Wayback Machine never captured is gone unless the band has it.
- setlist.fm's terms cover showing its data with a link, not keeping a copy for good: the
  letter in ARCHIVE.md step 3 still has to be sent.
- The grounds table names a festival only where a festival has fixed grounds. A touring
  festival's stops and a one-off all-dayer still come from an announcement or from hand.
