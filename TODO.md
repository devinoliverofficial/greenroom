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

## Roles, pages, sign-up, NDAs, fans (Devin's definitions, 2026-10-10): see ROLES.md
- [x] The words on tours: a Members line and a Crew line on the Expenses tab; a hired player (Band, Touring Musician) is crew; his 20 crew roles in his order; Member / Crew switch on each person
- [x] Nothing is erased: no 30-day clear-out, no "Delete forever", no "Delete artist profile"; the database refuses deleting a tour or an artist page (0131). A tour's private pages can be deleted and restored (Settings, Deleted tours)
- [x] The three lines: Create a tour and Merchroom for artists and members, Settings for everyone; "Card feed" is "Linked Cards"; crew see MY PAY alone under Budget; on an artist's account Overview opens only that artist's tours (2026-10-10)
- [x] Leaving keeps your history (0132, 2026-10-10): a listing ends instead of being deleted; crew at once, a member when every other member agrees
- [x] Two levels on a tour, Manager and Crew; ALL ACCESS and GA are gone (0133, 2026-10-10)
- [x] Create a tour signs you onto the artist's page and asks who is on the tour (past crew ticked, Crew / Manager each)
- [x] Budget History in the three lines: each year, its tours, and Off Tour
- [x] The two Budget graphs swapped (the two bars lead Income, the climbing line leads Expenses); Merch shows its average a show
- [x] Sign-up with a Greenroom code, one question a screen, then "What brings you to Greenroom?" (MEMBER / CREW / FAN / PROMOTER, any number) with each one's questions (0134, 2026-10-10). What is left is in the section below
- [ ] Build order and what is decided or still open are in ROLES.md sections 4, 6, 7, 8 and 9. The legal screen is built (section below). Next: a way for Devin to test every kind of login
- [ ] **Devin to paste two server functions** (supabase/functions/notify and ari, ready in the repo): then "in the green", merch numbers and special requests go to a tour's Managers only, exactly per tour, and "in the green" can be switched back on in the app
- [ ] Cancelled dates and tours that end early: three pieces in ROLES.md section 7 (a Cancelled mark on a show, "the tour ended early", a check card for Managers when the tour is due to end)
- [ ] Crew asking an artist for an endorsement, with 30 days for the artist to answer (today only the artist can start it)
- [x] The titles offered when inviting someone to a tour are his crew roles (2026-10-11)

## The documents at sign-up, crew roles, Manager / Crew (Devin, 2026-10-11): built and live, the documents are not switched on yet
Devin: "lets get this figured out so they sign while signing up", "I want whatever way this is going to be for the future. If this is door 2 then lets get it done", "LETS JUST STICK TO MANAGER or CREW and commit", "The job titles offered when you invite are the old list ... lets update this". His prompt of Oct 10, clause by clause: the documents come right after the code; one page each; one unticked box with his exact sentence; "I Agree" off until it is ticked; no skip; who, which versions, when and from which address are saved; Settings says "You accepted on [date]"; people invited to a tour agree too; everyone is asked again when a version changes
- [ ] **Switch it on: load the three documents** (the lead, from his private folder, with `legal_publish`; the text is never in this repository). Order that must hold: migrations 0137 and 0138 (live), the app (live), THEN the documents. The moment the third one is current, everyone must agree once: Devin and the two others already in on their next open or return to the app, every invited person as the first thing after their emailed code, every code sign-up right after the code. Type the version by hand ("1.0"); a correction is always a new version, never a delete and reload
- [ ] **Nobody has seen these pages in a browser.** The preview was refused in this session; the pages, the picker and the Settings row were driven on a stand-in page under jsc (670 checks) and the three real documents were run through the page reader (every heading, paragraph, list and bold comes out; nothing shows as raw symbols). Devin is the first to see them: if anything is wrong, `update public.legal_docs set is_current = false;` switches the question off for everyone at once
- [ ] **Devin to paste supabase/email/invite.html** into Supabase (Authentication, Emails, Invite user) BEFORE inviting anyone: until then the invite still says ALL ACCESS or GA and the old four steps. After: MANAGER or CREW, and "Read and agree, then fill out your info"
- [x] What the database holds (0137): the documents (`legal_docs`, readable only through a function, by someone holding a live code or signed in), the record (`legal_acceptances`: account, address, time, network address, phone description, the three versions and a fingerprint of each text, the sentence as the phone sent it, which door). The record cannot be changed or deleted by anyone, and survives an account deletion with the address kept. A seat on a tour is not linked, and the first run cannot be finished, until the person has agreed
- [x] What 0138 adds: a person invited by email who has not agreed reads nothing of the tour and cannot save to it, even calling the database directly (my_role's email match now waits for the agreement; people already attached to a tour are untouched and pay nothing: timed before and after)
- [x] The app: the pages in the sign-up's look; a Greenroom code shows them before the name is asked; an invited person sees them before anything of the tour is loaded; someone already in is asked at the start and when they come back to the app; "Sign out" under the button (not a skip); Settings, "Documents you agreed to", to read them again
- [x] Titles: his 20 crew roles, Band and Touring Musician, and Other with a line to type, wherever a title is picked (invite form, the invited person's own screen, contact card, profile, the crew list's Edit, Budget's crew editor). The invite form has two headed lists: a role under "Member of the artist" writes the person as a Member, so their pay lands on the Members line
- [x] The owner is never asked (0140): "stop asking me to sign my own NDA i am not doing this". An account that runs Greenroom is not put the documents and is on no list of people who have yet to agree. And: "I dont want to have to do any set up stuff seeing as my account is already made. But everyone else should (including those who already have an account)": the two people already in were put back through set-up (documents, then username, birthday, what brings you to Greenroom) on their next open
- [x] "As the creator i should have a full list in my settings but ONLY ME" (0139): Settings, "Who has agreed", for a Greenroom admin only (the database answers nothing to anyone else): who has not agreed yet, who has, when, which versions, which way in; a tap opens the whole record (network address, phone, a fingerprint of each text) with "Copy this record"
- [ ] The list, left open: the Agreed heading counts records, the first line counts people; Back from a record returns to the top of the list; no PDF, the copied record is plain text; the public privacy page does not say what is recorded when someone agrees or that Greenroom can read it. Gaps in the record's numbering come from rehearsals (a rolled-back run still uses up numbers), not from removed rows
- [ ] Decisions made for him, to confirm: (a) someone already in who has no signal is not locked out: they carry on and are asked the next time; if they tapped "I Agree" with no signal it is kept on the phone and sent when a call gets through; someone new or invited is never let in that way. (b) The documents are shown exactly as he wrote them (Version 1.0). (c) Whose buyout counts as income now follows the Member mark, and "Hair & makeup artist" no longer counts as the artist
- [ ] Known gaps: an invited person who has not agreed can still write one check-in row a day and read their own row of the crew list (my_person, 0033; not through my_role); a Member picked from Past crew for the NEXT tour is written without the Member mark, so their pay starts on the Crew line (carry the mark over); an invited person who taps Sign out before agreeing has no password yet and a used code: "Forgot password?" or a fresh invite; a phone still on the old build shows an invited person an empty app until it updates; the sentence stored is what the phone sent, the database does not compare it
- [ ] His to decide, not blocking: the privacy policy does not mention several things the app does (linked bank cards, Square, date of birth, username, phone, photo, notifications, chat, that others see your profile and tour history); the Terms say deletion is by email while Settings has Delete my account; the old site/privacy.html should be replaced by his policy, not kept beside it; the public repository shows the code and the plans the NDA calls confidential; a lawyer should read the three once

## Sign-up with a code: left open after 2026-10-10 (migration 0134)
**Before any code is handed out (Devin, in the Supabase dashboard, one step at a time):**
- [ ] 1. Check the mail sender is still on. Devin connected Brevo on Sep 27 (sender GREENROOM, greenroom.tourbook@gmail.com, limit raised to 100 an hour, test emails accepted); later lists wrongly said there was none. One look at Supabase, Authentication, Emails, SMTP Settings. Without a sender a tester's confirmation code never arrives (the built-in one sends a couple of emails an hour and only to the project's own team)
- [ ] 2. Authentication, Email: "Confirm email" ON and "Secure email change" ON; paste supabase/email/confirmation.html as the Confirm signup template; code length 6, expiry one hour
- [ ] 3. ONLY THEN "Allow new users to sign up" ON. Never the other way round: with sign-ups on and Confirm email off, anyone could take over a pending tour invite. The Invite codes sheet (Settings) warns when it finds them that way, and the sign-up screen stops at "sign-up isn't switched on yet"
- [ ] 4. Make a code in Settings, Invite codes, and try it on a second phone
- [ ] Paste the invite server function again once it checks who may invite (today it trusts whoever made the tour; the database now refuses the row, but the function would still email an invite for someone holding a code)
- [ ] Before codes go to people Devin does not know: read every older database function and policy again with strangers in mind. They were written when everyone was invited by hand. The two reviews fixed what they found on the way (a listing or a tour invite could show a stranger someone's phone number; a tour could be handed to another account), and said plainly they did not re-read the rest (guests, chat, feed, follows)

**Who can bring people in (new rule, his words: "Once you are accepted to claim a page you ... can assign other members and managers"):**
- [ ] An account that came in on a code cannot add anyone to a tour, or list a stranger on a page, until Greenroom has confirmed an artist page it runs or is a Member of. Hand-invited people are not affected. Devin to confirm this is what he wants for crew who sign up with a code and then make their own tour
- [ ] A page someone adds by hand (an artist that is not in the music database) is theirs but never "confirmed": there is no button for Devin to confirm it yet, so its maker can never add crew. Build "confirm this page" in Page claims, or send those pages through a claim too
- [ ] Anyone can still add an artist page under any name with the + (it shows as unconfirmed). Close it or send it through claims

**Claims (the submission process, built as a first version):**
- [ ] Proof today is links (Spotify, Instagram, website) or a sentence, plus a code to put in the artist's bio; Devin checks by eye and approves in Page claims. No file upload ("a portal to submit documents"), nothing checks the bio automatically, nobody is notified (the claimant sees "Claim declined" on their Artists tab; Devin has to open the sheet to see new claims)
- [ ] A claimant shows as a Member, pending, to themself and Greenroom only (his words were "listed as a member until the claim is approved or denied": shown to everyone it would let anyone put their name on any artist). Devin to choose
- [ ] One account runs a page. A second Member who is accepted gets no control yet ("Members can do anything to an artist's page" waits for the roles build)

**Requests to be listed:**
- [ ] The artist is "alerted" by a card on the runner's profile and on the page. No push notification, no email
- [ ] A request that was waiting when the person got listed another way comes back if they later leave; a listing that ended can be switched back on by its runner on an unconfirmed page (artist_members_relist)

**Fans (his note: "we will expand on"):**
- [ ] No search across tours ("search tours and press attended"): a fan picks an artist, opens a tour, taps Attended. Shows attended is a count and a list, no analytics yet (cities, years, first show, most seen)
- [ ] A fan cannot open a person's page or follow a person; a fan code makes the same account as any other (the code only pre-ticks FAN)
- [ ] Marking a night on a tour the artist has hidden is still possible by date

**Promoters, venues, festivals (his note: "we will expand on"):**
- [ ] Venue and festival pages are made only for places already in the show archive (2,087 venues, 67 festival names); a venue with no show on record cannot be found or made. No outside lookup yet
- [ ] "I worked here" saves as pending and nothing approves it; no role is asked; nobody can claim a venue or festival page; no ratings ("almost the same as like AIRBNB"); the page does not list its people; festivals are not found by city
- [ ] Promoter pages ("how many shows I've ran and the exact shows I've worked")

**Smaller:**
- [ ] The first questions inside the app ask the birthday with the phone's own date wheel; the sign-up screens use three pick-lists. Proof has four boxes on one screen. Make them one look
- [ ] Someone under 18 who was invited to a tour is stuck on the birthday screen (the terms say 18). Decide with the legal screen
- [ ] A mistyped email that is never corrected leaves a never-confirmed account behind; it is cleared the next time someone signs up or is invited with that address
- [ ] The database refuses a user made "confirmed" by hand in the Supabase dashboard, an admin's edit of someone's address, and Apple or Google sign-in (signup_proof). Lift it before adding any of those

## Missing Zelle, transfer and wire payments (Devin, 2026-10-10): fixed and caught up
- [x] Devin pasted the function late on Oct 10 and ran the catch-up on Oct 11: 35 payments came in (26 Zelle, 8 transfers, 1 wire, Jul 6 to Oct 9), all waiting, none filed by itself. Checked against the counts-only snapshot taken before: the 250 filed lines and the one set aside were identical, both tours' charges identical, deposits unchanged, no bank id stored twice, no new line with the same amount on the same account within three days of a filed one. He sorted all 35 the same day
- [ ] **The card names on those lines are smudged** ("Business Adv Relationship" followed by odd symbols before 5370, where two dots should be). My mistake: `pbcopy` with no locale set read the file as Mac Roman, so the two middle dots in the one place the function builds an account name were mangled on his clipboard, and my check (copy, paste back, compare) could not see it because it mangles and un-mangles the same way. Name only: no amount, date or count. 36 feed lines and 37 tour charges carry it. It ends with the next paste (the function is now pure ASCII, a test fails on any other byte, and the clipboard is loaded with `LANG=en_US.UTF-8 pbcopy`). Then run the label-only clean-up (rehearsed, rolled back: every amount, date, category, merchant and count identical before and after)
- [ ] For money sent, the bank's own description is kept as the name (long numbers removed); it can carry a person's name, phone or email. The privacy page says so; the new policy document should too

## Every bank line accounted for (Devin, 2026-10-11): database and app live, the function waits on his paste
Devin, after deploying the fix above: "I need you to also make sure that this won't happen again with any other cards in the future. I need all transactions to be accounted for". An audit of every route a line takes found the Zelle fault was one of eight places where the bank feed threw a line away BEFORE anything recorded it had existed, and then moved its place in the bank's list past it. The rule now: store first, label second. Every posted line a bank sends gets one record; the rules only decide where it waits and what it is called
- [ ] **Devin to paste supabase/functions/plaid/index.ts** (one file, about 150 KB). Order matters and is already right: migration 0136 is live, the app is live, the paste is last. The first read after the paste reads every bank again from the start by itself (nobody taps anything): lines the old rules threw away come in, the ones that are money sent or a bill wait in the pile, card payments, moves to savings and lines dated outside every tour go under Left out. Nothing in that read can file itself. Then the name clean-up above
- [ ] After the paste, check on his real banks (counts only): the first full read's ledger adds up (unexplained 0), how many came in waiting and how many left out, that nothing already stored changed, and that the account names read right
- [x] What the database has now (0136): a fifth state for a bank line, left out, always with a reason (card payment, moved to savings or investments, not during a tour, before the tour, zero amount, taken back by the bank); who decided and when; what the bank says now when it differs; the phone can no longer write bank lines at all; a counts-only record of every read (feed_reads) whose "unexplained" must be 0; feed_account() and feed_put_back()
- [x] What the function does once pasted: loan payments, cash withdrawals and money sent or advanced from a card WAIT in the pile (they were thrown away); words like autopay, pmt and "transfer to" no longer hide a line (a line carrying one never files itself); a line more than two weeks old never files itself; a new card nobody has answered the questions for asks first; a failed read of the tours or a failed save stops the run instead of moving on; after saving, the rows are read back and counted; once a week, and after any change to the rules or to an account's answers, each bank is read again from the start and compared line by line
- [x] What the app shows (Cards tab, the tour's creator): how many lines are on tours, waiting, left out and set aside, with "Left out and set aside" opening the list (Bring it in, Put back); what the last full check found; a bank that needs a new sign-in in red, and on Tasks until it is fixed; lines waiting on other tours; "Couldn't check" instead of a made-up zero. Set aside is no longer a dead end
- [ ] **Not looked at in a browser.** The preview pane was refused in this session, so the new block, the sheet and the Tasks card were exercised on a stand-in page under jsc (every path draws the right words) and never seen. First thing to do with the preview back: the Cards tab at phone width, his real empty state included
- [ ] Left for later on purpose, each one on the questions page: a new card at a bank that is already linked (the bank service's update screen; connecting the bank a second time doubles every charge); a guard against connecting the same bank twice; cards of a Manager who did not create the tour; MY PAY swallowing a second identical charge on a personal card (nobody has one linked); statement upload for a card that cannot be linked (its button was removed Sep 30); 2 years of history for newly linked banks (180 days today); money market, PayPal, prepaid and lines of credit cannot be linked; whether the first show day counts as before the tour; whether the last disconnect should also erase the Left out list
- [ ] Still open in the function: it files a learned charge onto the tour first and writes its row second (a run that dies in between leaves the charge on the tour and the row waiting as "Maybe already in"; nothing of his is set to file by itself today); undo still takes the charge off first and frees the row second ("Filed but on no tour" with Put back is the repair); disconnecting the last bank still deletes the lines waiting
- [ ] The harness (tools/make_dbstub.py) still carries real-looking names and card endings from before this change. Replace them with invented ones in one sitting, with the harness recipes checked after
- [ ] Money coming in on an account not marked for income is counted, not kept (the privacy page promises it). A refund to a debit card on such an account is therefore not shown. All his bank accounts are marked for income today

## Reimbursements: left open after 2026-10-10 (migration 0135)
Devin: "in the 'MY PAY' section there can be a log where if someone on the tour spots any money for the band/tour they can log it as something that needs to be reimbursed and it is sent to the tasks button as well as the bands expense tab under 'REIMBURSEMENTS.' In this category we can click it and see all the payments that need to be reimbursed and mark them paid or not. If they are not paid they will stay in the tasks tab". Built: "Paid for the tour?" on everyone's MY PAY; a Reimbursements line on the tour's Expenses tab (Managers) that opens the list with Mark paid (cash, or card or bank), Not paid, Not a tour cost and Put it back; a Tasks card that stays until nothing is waiting, for every tour the person manages.
- [ ] Decisions made for him, to confirm: a reimbursement counts as a tour cost from the day it is logged, with no approval step; paying it back never moves the tour's total; a Manager can mark their own paid; the limit is $10,000 each; a Manager can take one off ("Not a tour cost") and put it back
- [ ] Counted twice, still possible: a payback from a card whose charge is filed by hand under another category, or by a different amount (one Venmo for two reimbursements); a cash payback also typed into the merch cash log as Spent (the sheet says to log it as Handed off); a Manager also typing the expense by hand. The card pile offers a match only for the exact amount on this tour
- [ ] No push notification to Managers when someone asks (needs the notify function pasted again); no receipt photo; no reason shown when one is taken off; an ask cannot be edited, only taken back and asked again
- [ ] The Tasks button only shows when the tour your profile follows is one you manage; if it is not, the cards cannot be reached
- [ ] Once the sheet is closed with only taken-off reimbursements left, nothing leads back to it
- [ ] Phones on an older build do not know the line: their tour totals differ by the reimbursements until they update
- [ ] Found on the way, older: tapping the Merch tips line on Expenses throws (openCategorySheet looks the key up in the typed categories); in MY PAY's "Log income" and "Add expense" sheets the list stops redrawing after the first entry (the second is saved but not listed until reopened)

## More info on a charge or deposit: left open after 2026-10-10
Devin: "is it possible when sorting through deposits and charges to add kinda discretely a 'more info' next to each charge where claude could actually look into the charge and help you figure out what it was for?" Built: a quiet More info link on new card charges, bank deposits and the MY PAY inbox; the reader says what the line most likely was, why, and (for a charge) which category it would file under, with a "Use ..." button that only sets the picker; "Look it up online" searches the web. Nothing is ever filed, ticked or logged by it.
- [ ] The bank's own line is not kept (only the cleaned-up name; for deposits only date and amount), so it cannot decode a store number or city, or say who paid a deposit. Keeping it needs the bank feed function pasted again and a line in the privacy page. Devin to choose
- [ ] Not on lists of charges already filed (Logged Card Transactions): a tap there also opens the swipe tray. Could be one more tray button
- [ ] No allowance on the server: the app holds online look-ups to 25 a day a phone and remembers answers for the session only. A per-person allowance comes with the read function's next paste
- [ ] In the MY PAY inbox, filing or skipping one item resets the pickers on the other cards, so a category taken with "Use ..." on another card is lost
- [ ] The deposit row's More info was checked by a scripted run and two code reviews, not yet seen on a real deposit on a phone

## Who sees what: left open after 2026-10-10 (from the map of every tab by role)
- [ ] **The notification function sends the band's money to crew phones.** "MERCH NUMBERS! city: $X" and "You're in the green" went to every phone that had them on, whatever the role. The app no longer sends "in the green" and no longer offers MERCH NUMBERS to crew, but the server function (supabase/functions/notify, and ari for merch) still would if asked: it should send both only to people who can see the tour's money. Needs a function deploy; then turn "in the green" back on
- [ ] **A settlement email with no tour tag is matched across every account's tours** by date and venue (supabase/functions/inbox). Two artists in the same room on the same night could get each other's merch number. Harmless while one artist uses the app; fix before a second one does: match only inside one account's tours, or require the tag
- [ ] Only Managers edit: today anyone invited ALL ACCESS can edit the whole tour. Make editing ask for Manager, in the app and in the database (ROLES.md section 3)
- [ ] A Member's access to a tour should come from the artist page, not from how they were invited; tours should belong to the artist (the roles build)
- [ ] Invites still offer ALL ACCESS / GA and the titles Artist and Band; they should offer Member / Manager / Crew
- [ ] Anyone can ask "is this email invited to this tour" (tour_person_ok has no check of its own)
- [ ] The + on a profile lets any account add an artist, and from there a tour: it is the only way a new artist starts today. Close it once accounts have a kind
- [ ] Search lists every tour you are on, whichever artist's account you are switched to
- [ ] A deleted tour comes off the public tour lists until it is restored; the public record should stand on its own once a tour is announced (ROLES.md section 6)
- [ ] The Off Tour book has no delete, and counts as a tour "you still run" when deleting an account

## Leaving an artist: left open after 2026-10-10 (migration 0132)
- [ ] One stretch per person per artist: someone listed again later is treated as if they never left, and someone who left as a member cannot be listed again as crew yet (the app says so). Real from / until stretches come with the dates build (crew pick exact calendar days)
- [ ] Someone taken off the artist page but still on a tour's crew list keeps gaining that tour's nights until taken off the tour, and a tour they left half-way can count twice in their tours number once most of it has been played without them (road_stats, the second term). The sheets say "they stay on any tour they are on"
- [ ] Nobody is told: the person let go gets no notice (their page just stops growing); the one who asked is not told of a "no" (the pill turns back into the x); the other members only see the ask at the top of their profile. No reminder, no time limit: a member who never opens the app holds it up for good
- [ ] Only the account that runs the page can take someone off or start letting a member go. "When firing a crew member anyone can do it" (any member), a button to leave on your own, and the other members letting go of the one who runs the page all come with the roles build
- [ ] A crew person who left can still send a "confirm your tours" claim naming later tours: approved, never counted past the leave day. The claim sheet should stop at that day; the artist's approve card and detail sheet still count the claim as sent
- [ ] A member added less than a week ago and not endorsed is simply taken off (a slip of the finger). Devin to confirm the week
- [ ] "Remove endorsement" on your own page still takes a crew person's confirmed tours with it, for good once they have left (the sheet now says so)

## Tour setup, Budget History, notifications: left open after 2026-10-10
- [ ] Past crew is remembered per person who invited, not per artist: only people who were on this artist's earlier tours start ticked in the tour setup; everyone else is listed unticked. A real per-artist crew list comes with tours belonging to the artist
- [ ] A listed Member who does not run the artist's page is not switched to it by Create a tour (they cannot switch at all yet), and their tour does not show on the artist's page
- [ ] Budget History: this year's Off Tour opens the live book, which is the whole book, not only this year (from next January last year's money shows in both). A tour that crosses New Year is filed under the year it started. Old tours open live and editable. A year's summary leaves out the plan, card balances and loans carried in; a total typed in with no date counts in the book's first year
- [ ] A charge filed under a category the Off Tour book does not have (or "Day by day") is on no line and missing from the totals, on the live page too
- [ ] After Devin pastes the notify and ari functions: turn "in the green" back on in the app (openIncome), drop the database stopgap (push_subs_guard, members_push_recheck), let the siren go by Manager instead of the "Tour Manager" title (serverLead), and make one test call
- [ ] The big number's celebration when a tour crosses into the green now plays on the Expenses tab (the graph moved there), not on Income where the night is logged

## Fans, venues, promoters (Devin, 2026-10-10): later builds, see ROLES.md
- [ ] **Fans**: "does not have any access to the overview page at all. Just the user profile experience and searching for artist pages". Needs an invite code for now. Today there is no fan account: someone on no tour and no artist page gets no Overview, no Create a tour, no Linked Cards, by a stand-in rule, not a real account kind. A fan cannot open a person's page or follow a person yet
- [ ] **Venue pages**: "almost the same as artist pages", auto-created when searched (the app already finds a venue's address and details), claimed by the venue's promoters, rated by artists, members and crew "almost the same as like AIRBNB"
- [ ] **Promoter pages**: "This is how many shows i've ran and these are the exact shows I've worked"
- [x] Fan, venue and promoter as choices in the login process (0134): a fan ticks FAN, follows artists and marks shows attended; a promoter names venues and festivals. What is still thin is in "Sign-up with a code" above
- [ ] Devin wants a rundown of this whole list at some point

## Members and crew on a tour: left open after 2026-10-09
- [x] Band and Crew are two lines on the Expenses tab (2026-10-10; Devin: "band and crew should be a separate line in the expense tab", knowing each line counts the bigger of planned and paid). Nothing stored changes: pay is still filed under the one category (named "Band & Crew" in the pickers on a tour with a band) with who it paid; the split is made when the tour is added up (G.crewSplit, G.chargeLine)
- [ ] Money under Crew with no person on it counts on the Crew line until someone taps Who (Devin's current tour had 2 such card charges on 2026-10-10)
- [ ] Changing someone between Band and Crew, or retitling them to or from Artist / Band, moves their pay and payments to the other line and can change the tour's total. Said nowhere in the app yet
- [ ] One card charge that paid several people (one Venmo run, a payroll batch) can only be given to one person. Splitting a charge across people is not built
- [ ] A learned merchant filed under Crew by itself has no person: it shows as "not anyone's yet" under Crew, Logged Card Transactions
- [x] The merch cash log's "Spent" asks "Who was it for?" when the category is Band & Crew (2026-10-10), so cash pay lands on the right line with a name on it

## Deposits: left open after 2026-10-09
- [ ] Devin to confirm the names: "Not sure which show yet" (the answer), "Guarantees to sort" and "Merch to sort" (the sections on the Income tab)
- [ ] A phone still on the old build (until the app is reopened) can wipe a Deposit Amount typed on a show that is not received, or hand-tick Received on a "through card" tour, if it saves Log income on that show. Small window; a "new version, reload" gate before saving would close it
- [ ] No undo for a logged deposit: a wrong city has to be fixed by hand in Log income and the deposit never returns to the list. Build an "Undo" (the deposit remembers what the night looked like before)
- [x] One merch deposit over several nights (2026-10-10, migration 0127): Merch has the same show list as Guarantees, with "Not sure which show yet" (it waits in "Merch to sort" and does not count as income: merch counts on its night). "Whole tour" is gone from the list
- [ ] Merch money that belongs to no show at all (an online store payout) has no home on a tour now that "Whole tour" is gone: today it goes on the Off Tour book, or waits in Merch to sort. Ask Devin if he gets any (the Off Tour book is the third tab under a tour's Budget since 2026-10-10)
- [ ] A parked guarantee can still be dropped by "Take it off the book" on a phone running a build from before 2026-10-09 (its entry sits in Other income there). The merch list is guarded in the database (tours_merch_to_sort_gate); the guarantee one is not
- [ ] The rest of a part-placed deposit that turns out to belong to no show has no exit (put-back is refused once part is placed): it waits in the list. Rare; add "this part is not for a show" if it ever happens
- [ ] When the bank feed function is next redeployed from the Supabase dashboard, take settleMerch and settleGuarantees out of it: today they still try on every Refresh and are refused by the database (harmless, but noisy in the logs)
- [ ] Deposits matched automatically before 2026-10-09 (by the bank feed) were never approved by hand: list them for Devin if he wants to confirm them

## Cities and countries: left open after 2026-10-10
- [x] A district counts as its city (2026-10-10; Devin: "What do most people consider? whatever that answer is should be the way it reflects on the page"): Hollywood is Los Angeles, Brooklyn and Queens are New York, Ancol is Jakarta; a town with its own city hall stays its own city (West Hollywood, Pontiac). The list is the table `place_aliases` (migration 0130): a district that turns up later is one more row. I See Stars 392 → 388
- [x] 2012-03-21 (Asking Alexandria / Trivium tour), "South Carolina, TBA": Devin does not remember the city. It stays a show with no city
- [ ] Crew (not band) still see only the tours an artist confirmed for them, counted from their claim; festivals and loose shows are a band-member thing for now
- [ ] `countriesList` on the artist page (not shown anywhere yet) still groups by the raw country name

## Flyers on tour history (Devin's idea, 2026-10-10) — sized up, not built
- [ ] "When you click the tour ... a view flyer tab": keep the announcement's lead picture when the finder reads a ThePRP / Lambgoat article (36 of I See Stars' 57 tours have one behind them), show it from the opened tour row with a credit and a link; let the page's owner upload one for the rest. Open: show the picture from its source or keep our own copy (rights), and pictures that have since gone

## Smaller
- [ ] Artist photo for search-made pages (MusicBrainz → Wikidata → Wikimedia Commons; Concert Archives photos are not available to us)
- [ ] App Store next step: password minimum 8 + leaked-password check
- [ ] Square Merchroom step 4 walkthrough
