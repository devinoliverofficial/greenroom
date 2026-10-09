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

## 3. MERCHROOM
- [ ] Square: real-money connection (OAuth, read-only scopes; never a production personal access token)
- [ ] Merch nights from Square sales → income, matched to settlements and deposits
- [ ] Devin's open notes on the Merchroom tab (pinned, not abandoned)

## 4. Tasks → "Today" first (Devin, 2026-10-09; to work out separately, not built yet)
His words, clause by clause:
- [ ] The Tasks button should "first and foremost" open on **today's to-do list**.
- [ ] Today's list is a window you can swipe "the same way all the tasks" swipe.
- [ ] Swipe **right** on today's tasks → a pull-up page. On it, these, in his order:
      "Import Day Sheet" · "Log in buyouts" · "Who received?" · "Log in Guarantees" · "Log In Merch".
- [ ] "When logging this stuff in it immediately logs it in everywhere [it] needs to be logged in the app."
- [ ] "This ideally should be all on one tab that gets pulled up."
- [ ] Follow-up (same night): the questions are asked **one at a time**; you can still swipe right or
      left on a question "if you don't have that info" (skip it).
- [ ] When you log one, you get the **splash effect with the "sign of the horns" emoji** (🤘).
- [ ] His first message ended mid-sentence ("… that gets pulled up. I") — ask him what came next.
Open questions to settle with him before building: is "Who received?" the person who was handed
the buyout cash; does "today" mean the show whose date is today on the current tour; what a skipped
question does (stays on today's list, or carries to tomorrow).

## Smaller
- [ ] Artist photo for search-made pages (MusicBrainz → Wikidata → Wikimedia Commons; Concert Archives photos are not available to us)
- [ ] App Store next step: password minimum 8 + leaked-password check
- [ ] Square Merchroom step 4 walkthrough
