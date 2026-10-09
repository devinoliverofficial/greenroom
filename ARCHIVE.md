# Greenroom's own archive

How Greenroom becomes its own record of every artist's shows and tours, without
Concert Archives or anyone else's permission. Written 2026-10-08 after Concert
Archives replied that their API is a someday project, and after a design run that
inventoried what Greenroom already holds, checked the terms of thirteen sources,
and compared three independent designs.

## The honest ground

- No database anywhere stores tour names reliably. setlist.fm's tour field is
  whatever a fan typed. Concert Archives' is the same. Only Wikidata (about 5,900
  tours) and Wikipedia's tour articles treat the tour as the record, and both skew
  to big acts. Tours with every show under them is a thing Greenroom assembles;
  nobody can hand it over.
- Only two sources let us keep a permanent copy and show it to everyone:
  MusicBrainz (events, venues, areas; CC0) and Wikidata (CC0). Wikipedia is fine
  with a link back. Every commercial concert API caps how long we may keep its
  data: setlist.fm "short periods" and non-commercial only, Songkick 24 hours,
  Bandsintown session only, Ticketmaster "reasonable periods". Those can be looked
  up live with a link; they cannot be the archive.
- Greenroom already keeps setlist.fm nights permanently. That goes past what its
  API terms allow without written permission. Step 3 fixes this.
- The band's own tours run through Greenroom are the one source nobody else can
  block, and the only source that knows the real tour name, who was on the crew,
  and whether the show was actually played.

## The plan, smallest step first

1. **Receipts.** Every night remembers where it came from (Greenroom tour, the
   band's own file, crew, setlist.fm, a news article, another band's bill) and keeps
   its id when a stronger source takes over. Tap a night, read its receipt. The
   Tours tab says how many nights Greenroom owns and how many are borrowed. Owned
   nights are never deleted by a re-sync, a Stop, or an unviewed page.
2. **Tours write themselves.** A tour run in Greenroom lands on the artist page by
   itself under its laminate name, the morning after each show: date, venue, city,
   tour, bands. Never money, never day-sheet contents. The show is marked played
   when a settlement, a merch deposit or a posted day sheet exists for that date,
   cancelled when it was struck. Everyone on the tour is a witness. A manager who
   doesn't run the page gets a card in the claim queue. On by default; off for
   private tours.
3. **The setlist.fm letter and the switch.** Devin writes to setlist.fm from his
   own account asking for permanent storage of date, venue and city per night with
   the link kept (no setlists stored), and states Greenroom's commercial status.
   Same week, setlist.fm gets a "link" mode: counts and a "See on setlist.fm" link
   stay, the rows stop being treated as owned, exports skip them. After this the
   archive is legally ours whatever they answer. Must land before the App Store or
   any paid tier.
4. **Hand-over receipts and the yardstick.** A handed-over file is a receipt you
   can take off again. Exact, AI-free reading for the Concert Archives verified
   export, Bandsintown for Artists (CSV), Master Tour CSV and calendar .ics files.
   Photo and PDF reads move to the cheap model and count on the meter. A score
   compares the page with a handed-over file: nights found over nights in the file,
   per year, plus a holes line per tour. First use: I See Stars' Concert Archives
   export, which gives the completeness number and tells the reader where to look.
5. **The free floor, read once.** MusicBrainz events, venues and areas, and
   Wikidata's tours by MusicBrainz id, pulled on first view and yearly: free, CC0,
   proper country codes and a venue id. One article read names tours for every
   band it mentions, so a support act's page fills from the headliner's article at
   no extra cost. The meter shows dollars.
6. **Bills and the crew's word.** A "with …" line in tour setup. Bands on a bill
   get a "reported by I See Stars" night on their own page, which they can strike
   in one tap. Crew with an approved credit can tap "I was there" and suggest a
   name for an unnamed run. An unclaimed support band's page is half full before
   anyone claims it.
7. **People and the outside.** Devin's call: a public read-only page per verified
   artist so the archive can be found and cited. A band-minted "Were you there?"
   link that lets a fan in. "I was there" on existing nights. "Download your
   archive." Then, optionally, write confirmed tours back to MusicBrainz as events
   and a Tour series under CC0, so the record outlives Greenroom.

## What Concert Archives has that this cannot replace

Its past, and the fans who typed it: about 1,159 I See Stars nights logged by people
who were in the room, many for shows nobody announced. The plan replaces Concert
Archives' future for any band that runs its tours through Greenroom, gives every act
a permanent CC0 floor, and can match Concert Archives' past only through the band's
own verified export, which they grant. It cannot regenerate fan memories.

## Decisions for Devin

- Public read-only artist pages: yes or no.
- Send the setlist.fm letter (drafted by Claude, sent from Devin's account).
- Claim I See Stars on Concert Archives (verification request) and on Bandsintown
  for Artists, and hand over both exports.
