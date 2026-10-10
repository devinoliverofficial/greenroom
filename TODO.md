# Greenroom — to do

Devin's list. Big rocks first. Each one gets built one step at a time, with mercy.

## 1. Reading costs — make it sustainable before the App Store
Today every flyer, statement, venue lookup and tour search spends from one prepaid Anthropic
meter. Capped now ($50/month on the Anthropic side, ~$60/month of searching on the app side,
small model for the finder), but a cap is a brake, not a plan.
- [ ] Per-person allowance for flyer/statement reads (needs the `read` server function redeployed from the Supabase dashboard — Devin pastes, one step at a time)
- [ ] Smaller model for flyers/statements where it's good enough (same redeploy)
- [ ] Decide the business shape: free tier with a monthly allowance of reads, paid tier above it
- [ ] Concert Archives license (below) — if it lands, most of the tour searching goes away
- [ ] Show the month's meter somewhere Devin can see it in the app

## Done today (2026-10-08)
- [x] Tour search runs by itself for every page with a road story; trusts what it finds; ties settled, never asked
- [x] Slide a tour left → Edit (rename / remove); corrections survive re-syncs
- [x] Tour conflicts: both tours stay, tagged; settle the nights one by one (this tour / that tour / wasn't there)
- [x] Rescan button under the Tours list; the list no longer stops at 60 tours
- [x] Fact check after every scan/sync: nights inside a run filed; edge and far-away nights asked about with the same picker
- [x] Every night under its tour: same-tour spellings fold (alias, survives re-sync); a scan's listed dates take over setlist.fm's album labels
- [x] A tiny tour inside another's run folds into it; a real name beats a list of bands
- [x] Calendar: slide a date left → Edit / Delete show (the tour itself changes, so every tab follows)
- [x] Merch tips under Merch (cash/deposited, paid/unpaid) → Merch tips line in Expenses
- [x] Cards → Cards/Links with the atVenu switch (off = nothing of atVenu's lands; no bubble, no $ per head)
- [x] Edit day sheet → Upload Day Sheet (photo → reader → fields filled, you check and post)
- [x] Cards/Links: one "All New Card Activity" button under Refresh Card (charges, then deposits)
- [x] Reading meter: small model, monthly ceiling; Anthropic: $20 credit, auto-reload, $50/month limit

## 2. The archive — every artist, without Concert Archives
Concert Archives answered 2026-10-08 (Alexander Fred): an API is planned, no date, Verified Bands
first. So Greenroom builds its own. The plan is in ARCHIVE.md, the search as it runs today and
what is left to automate in PIPELINE.md, every platform checked in SOURCES.md.
- [ ] Devin: submit the Concert Archives Verification Request for I See Stars; when verified, export the concert list and drop it in the dev folder (the yardstick)
- [ ] Devin: claim I See Stars on Bandsintown for Artists; Events → Export; drop the file in the dev folder
- [ ] Devin: the setlist.fm letter (ARCHIVE.md step 3; Claude drafts, Devin sends) — before the App Store
- [ ] Devin: yes or no on a public, read-only artist page
- [ ] Devin: two nights only you can settle: Aug 4 2017 (Hard Rock Las Vegas or Lake Tahoe?) and Jul 30 2017 Lubbock (did I See Stars play?)
- [ ] Build next (PIPELINE.md §4): verify-before-adding, a door for checked lists of nights, the yardstick, the other bands' pages, more press, the server-side hunt
- [ ] Ask Andy Baio about the Upcoming.org archive (435 I See Stars results, 2003–2013); ask The Concert Database (Michigan)

## Done 2026-10-09
- [x] I See Stars: 221 verified nights added from the band's own MySpace lists (Wayback Machine), old event pages and press; 15 stale or cancelled dates taken off; 7 re-venued
- [x] Festivals: every night can carry a festival name (setlist.fm's API has none); 298 festival grounds; 35 I See Stars festival nights named with sources; festivals are their own entries
- [x] The finder reads the band's own pages out of the Wayback Machine for every artist, retries through its outages, and settles drops and moves by the band's last list before the show
- [x] Settled nights are written down and survive every sync; each year's shows outside a tour open like a tour; each night links to its source
- [x] A band member's numbers are the band's, live; a person's page and the artist's count the same way
- [x] The app opens from the phone's cache; the artist page's server calls are 10× faster
- [x] Counting made right: cities were double-counted wherever one source wrote "Michigan" and another "MI" (513 → 400 real); an unknown place name had become a country (35 → 34); one-day festivals no longer count as tours
- [x] Listed is not played: old lists still showing, the 2020–21 shutdown months, and shows the band marked cancelled are kept off
- [x] I See Stars accounted for in ISS-ROAD-STORY.md: 1,347 shows · 57 tours · 49 festivals · 400 cities · 34 countries
- [x] One deposit, several guarantees (a lump sum from the agency): under Guarantee the New income sheet is a tick list of nights; every ticked night is marked received; the sheet shows what's logged for the ticked nights against what the card says, and says when they don't add up (migration 0121)
- [x] Crew on card charges: picking Crew for a card charge asks "Which crew member?" (band first, then crew); each person has "Logged transactions"; the crew sheet lists Band and Crew apart with their own subtotals (a person is band by the title Artist or Band, or by the Crew / Band switch under Name & role); a Crew entry can be given a person, or another person, afterwards ("Who") (migration 0126)
- [x] Guarantees to sort: part of a deposit can be placed now ("What's logged", less the agent's cut, all of it, or an amount typed) and the rest stays to sort; the tour's creator or any Manager can sort (migration 0125). "Not sure which show yet" is now first in the list of shows and in the "What was it?" menu
- [x] Profile no longer scrolls with nothing to scroll to (the tab area was forced a screen tall; the page was a notch taller than the screen; the Today spacer was 2px too big)
- [x] Guarantees as Devin runs them. The Guarantee Total is what the promoter owes; the Deposit Amount is what's coming (typed from a check or settlement) and no longer ticks Received by itself. Received is ticked by an approved bank deposit, or by hand when he chose "manually". The two questions ("log received guarantees / merch deposits manually or through card") are asked at account set-up and once in New income; "through card" locks the Received box. A guarantee deposit with no show yet is logged "Sort later": it counts as guarantee income and waits under Tonight in "Guarantees to sort" until he says which show(s) it paid for (migration 0124)
- [x] Deposits say what they match and wait for approval (Devin: "it should say this number matches whatever city it is. For now we should have to still see and approve and log"). In New income a number that matches a merch number or a guarantee deposit amount names the city; Approve fills it in, Log puts it on the books; two nights with the same number are both named; matches are listed first with a count. Nothing is logged from a deposit by itself any more: the bank feed's two matchers, the hourly matcher and the to-the-dollar pass are all stopped in the database (migration 0123). The six merch deposits the app had logged by itself earlier the same day went back to the list for him to approve

## 3. MERCHROOM
- [ ] Square: real-money connection (OAuth, read-only scopes; never a production personal access token)
- [ ] Merch nights from Square sales → income, matched to settlements and deposits
- [ ] Devin's open notes on the Merchroom tab (pinned, not abandoned)

## 4. Tasks: "Today" first (Devin, 2026-10-09) — BUILT the same day
His words, clause by clause, and what was built for each:
- [x] The Tasks button should "first and foremost" open on **today's to-do list**: on a show day a Today card leads the Tasks deck and stays first until everything on it is logged.
- [x] A window you can swipe "the same way all the tasks" swipe: it is a card in the same deck, right to start, left for later.
- [x] Swipe **right** → a pull-up with, in his order, "Import Day Sheet" · "Log in buyouts" · "Who received?" · "Log in Guarantees" · "Log In Merch".
- [x] "When logging this stuff in it immediately logs it in everywhere": each answer is saved to the show in the same fields Log income, the buyout tracker and the day sheet use (a merch total logged there shows up at once as "Merch deposit not received yet" in Tasks, in Income, in the Budget).
- [x] "All on one tab that gets pulled up": one sheet. (The day sheet form and the who-got-their-buyout list open over it and come back to it.)
- [x] The questions are asked **one at a time**; swipe a question right or left, or tap Skip, "if you don't have that info".
- [x] Logging one gives the **splash with the 🤘**.
- [ ] His first message ended mid-sentence ("… that gets pulled up. I"): ask what came next.
Choices made while building, for him to confirm or change:
- "Today" is the show dated today on the tour your profile follows; no show today, no Today card.
- "Who received?" is who has been handed their buyout (the tick list that already existed); it is passed over until a buyouts total is logged.
- A skipped question stays on today's list (the card says how many are left); tomorrow the card is tomorrow's show.
- A guarantee or merch total already logged is shown with a tick and a way into Log income, not overwritten from here (its deposit, taxes and reasons live there).

## Band and crew: left open after 2026-10-09
- [ ] Band and Crew are two groups inside one Crew line. A separate "Band" line on the Expenses tab itself is not built: each Expenses line counts the larger of projected and paid, so two lines can move the tour's net. Devin to say whether band pay is its own budget line or part of crew
- [ ] One card charge that paid several people (one Venmo run, a payroll batch) can only be given to one person. Splitting a charge across people is not built
- [ ] A learned merchant filed under Crew by itself has no person: it shows as "not anyone's yet" under Crew, Logged Card Transactions
- [ ] The merch cash log's own Crew entry does not ask who (the Payments sheet's cash payment does)

## Deposits: left open after 2026-10-09
- [ ] Devin to confirm the names: "Not sure which show yet" (the answer), "Guarantees to sort" and "Merch to sort" (the sections on the Income tab)
- [ ] A phone still on the old build (until the app is reopened) can wipe a Deposit Amount typed on a show that is not received, or hand-tick Received on a "through card" tour, if it saves Log income on that show. Small window; a "new version, reload" gate before saving would close it
- [ ] No undo for a logged deposit: a wrong city has to be fixed by hand in Log income and the deposit never returns to the list. Build an "Undo" (the deposit remembers what the night looked like before)
- [x] One merch deposit over several nights (2026-10-10, migration 0127): Merch has the same show list as Guarantees, with "Not sure which show yet" (it waits in "Merch to sort" and does not count as income: merch counts on its night). "Whole tour" is gone from the list
- [ ] Merch money that belongs to no show at all (an online store payout) has no home on a tour now that "Whole tour" is gone: today it goes on the Off Tour book, or waits in Merch to sort. Ask Devin if he gets any
- [ ] A parked guarantee can still be dropped by "Take it off the book" on a phone running a build from before 2026-10-09 (its entry sits in Other income there). The merch list is guarded in the database (tours_merch_to_sort_gate); the guarantee one is not
- [ ] The rest of a part-placed deposit that turns out to belong to no show has no exit (put-back is refused once part is placed): it waits in the list. Rare; add "this part is not for a show" if it ever happens
- [ ] When the bank feed function is next redeployed from the Supabase dashboard, take settleMerch and settleGuarantees out of it: today they still try on every Refresh and are refused by the database (harmless, but noisy in the logs)
- [ ] Deposits matched automatically before 2026-10-09 (by the bank feed) were never approved by hand: list them for Devin if he wants to confirm them

## Cities and countries: left open after 2026-10-10
- [ ] Devin to say whether a district counts as its own city: Hollywood (3 nights) beside Los Angeles, Brooklyn (3) and Queens (1) beside New York, Ancol (1) beside Jakarta. Today each counts. Folding them would be 4 fewer cities for I See Stars
- [ ] 2012-03-21 (Asking Alexandria / Trivium tour) is on the I See Stars page as "South Carolina, TBA": it no longer counts as a city, but the real city and room are unknown. Ask Devin
- [ ] Crew (not band) still see only the tours an artist confirmed for them, counted from their claim; festivals and loose shows are a band-member thing for now
- [ ] `countriesList` on the artist page (not shown anywhere yet) still groups by the raw country name

## Smaller
- [ ] Artist photo for search-made pages (MusicBrainz → Wikidata → Wikimedia Commons; Concert Archives photos are not available to us)
- [ ] App Store next step: password minimum 8 + leaked-password check
- [ ] Square Merchroom step 4 walkthrough
