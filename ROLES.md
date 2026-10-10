# Greenroom: who is who, the pages, and what has to be built

Devin's definitions, 2026-10-10 (his words in quotes), checked against the app the same day.
This file is the reference for every later build: use these words, in this meaning, everywhere.

## 1. The words

| Word | Meaning | In his words |
|---|---|---|
| **Artist** | The act itself, e.g. I See Stars. Never a person's title. | "this is an artist as in 'I See Stars'" |
| **Member** | A person who is IN the band: an owner of the artist. | "a person who is actually an owner of the artist entity. Like me" · "Anything that is not a Member isn't a part of the band." |
| **Manager** | A permission, not a job. Members have it by default; a member can give it to the tour manager or anyone. Edits a page or a tour, never deletes. | "A manager can basically edit a page or tour but they cannot delete." |
| **Band / Touring Musician** | A hired player on stage. Not a member. Part of the crew. | "These are hired guns. They are not in the band but they are on stage. They are a part of the crew." |
| **Crew** | Everyone else who works for the artist. | role list below |
| **Fan** | Someone who follows and attends. May be endorsed by an artist as a **VIP** (friends, family, high-level fans). | |

One person can be more than one thing: Brent is a Member and the tour manager. Connor plays drums and is crew.

**Crew roles, in his order.** First hires: Tour manager, FOH engineer, Merch manager, Driver, Backline tech.
As you grow: Monitor engineer, Drum tech, Lighting director, Photographer / videographer, Playback tech,
Production manager, Stage manager. Bigger tours: Assistant TM / production coordinator, Truck driver,
Head of security / personal security, VIP coordinator, Wardrobe / stylist, Hair & makeup artist, Head rigger,
Tour accountant. Then the two for hired players: Band, Touring Musician. (`G.CREW_ROLES` in `src/core.js`.)

## 2. The rules

1. **Nothing is ever erased.** "The greenroom app is an archive. A history book. There is no deleting tours or
   deleting artist pages ever."
2. **Artist pages are the centre.** Tours are made there, roles assigned, people endorsed, fans follow, and crew
   claim the tours they worked ("artist pages have to accept all crew claims").
3. **An artist page is claimed by a member, with proof**, "the exact same way Spotify allows people to claim pages".
4. **Dates.** When a member or a crew person is endorsed they are asked how long they were in the band, or worked
   for the artist. Their touring history and every number on their page follow those dates, live.
5. **Firing.** A member or a crew person can be fired from the claimed artist page. It ends their time; it does
   not erase it.
6. **Member pages and crew pages are the same kind of page.** Fan pages are a different experience.
7. **Fans** follow artist, member and crew pages; claim the shows they attended, with proof such as a ticket
   stub; show a lifetime count; are ranked 1 to 100 under each artist by shows attended; can be endorsed as VIPs.
8. **NDAs.** In the beta, everyone signs an NDA straight after typing the invite code, before an account can be
   made, and every signed NDA is kept. An artist can also upload its own NDA, shown to a crew member who is
   seeking endorsement.

## 3. What the app does today (checked 2026-10-10)

**Already matches**
- Members and Crew are two lines on a tour's Expenses tab; a hired player titled Band or Touring Musician is
  crew; a tour manager who is in the band is switched to Member (the Member / Crew switch on the person).
- The crew role list above is the list offered on a tour and on an artist page.
- A tour or an artist page can no longer be erased by anyone using the app (migration 0131). A tour can be
  taken down by its creator and restored for good; the 30-day clear-out and "Delete forever" are gone.
- Crew claim tours and the artist page accepts or sends back each claim.
- One rule counts cities and countries on artist and person pages; a member's Tours list is the artist page's.
- Artist pages can be followed.

**Does not match yet**

| Rule | Today | What it takes |
|---|---|---|
| Member = owner | One account runs a page (`artists.owner_id`). Being listed as a member gives no control. The account that runs a page need not be a member. | A roles table per artist (member, manager, from, until). Every "runs this page" check reads it. |
| Manager | Only per tour, given by the tour's creator. None on an artist page. | Managers on the artist page; members by default; any member can grant it. |
| Hired players | On the artist page a person is "band" or "crew", one of the two, one role. "Band" there means member and gives the whole history. | Listing by Member or Crew with several roles each. Connor is already listed as crew. |
| Dates | None. A member gets every night the artist ever played, the day they are listed. Crew get what they claimed. | From and until on each listing, asked at endorsement; history filtered by them. |
| Firing | "Remove" deletes the listing. A member's history vanishes; a crew person's snaps back to the day they claimed. | Removing sets an end date and keeps the listing as "former". |
| Tours made on the artist page | A tour belongs to the account that made it and names its artist as text. A tour manager's tours never show on the band's page. | Tours carry the artist's id; members and managers of the artist can open and edit them. |
| Claiming like Spotify | A note and an optional link, approved by hand by Devin. No proof step. | See section 5. |
| Sign-up | The only way in is a tour invite. The account is created when the tour manager taps Invite. No account types. | Greenroom invite codes, an NDA step, then the account; a choice of what you are. |
| NDAs | Nothing exists. | Documents and signatures tables; the signup gate refuses an email with no signature. |
| Fans | Only the Follow button. A fan cannot get in, and could not open a person's page. | A fan account type, a fan home, show claims with proof, VIP, the top 100. |
| Never erased | Still possible: account deletion clears that account's taken-down tours; removing a user in the Supabase dashboard cascades to their tours and their artist page; a page's road history can be switched off; search-made pages nobody opens are cleared. | Decide each with Devin (the App Store requires account deletion). |
| Words on invites | The tour invite still offers "Artist" and "Band" as a person's role, and buyouts count for a role containing "artist". | One role list; "Member" from the artist page, not from a title. |

**"Please check the code ... make sure everything here is working well" (history on member and crew pages)**

Solid: a member's numbers are counted from the artist's nights every time the page is opened; cities and
countries use one rule on both pages; tours fold the same way on both; an approved crew claim counts at once;
the phone that made a change refreshes itself.

Not solid, all from the missing dates and the delete-on-remove:
1. A member is credited with nights from before they joined.
2. Removing a member who never sent a claim takes the whole history off their page.
3. Removing a crew person cuts their history back to the day they sent their claim, not the day they left.
4. A fired person who is still endorsed can send a new "all tours" claim dated today.
5. A crew claim that ticked single nights loses a night when setlist.fm's own entry replaces the one they ticked.
6. Another person's phone sees a change within about a minute, on its next redraw. Nothing is pushed.

## 4. Build order

0. **Done 2026-10-10:** the words on tours (Members line, hired players are crew, his crew list), no erasing.
1. **Sign-up, the NDA, and a way to test every kind of login** (his ask for this week). Greenroom invite codes by
   kind (member, crew, hired player, fan); code, then NDA, then account; a Testers screen for Devin listing the
   test accounts with a reset he presses himself.
2. **Roles on the artist page.** Members and Crew with several roles, from and until asked at endorsement,
   firing as an end date, history by dates, Managers, tours that belong to the artist.
3. **Claiming an artist page with proof.**
4. **The artist's own NDA** at endorsement.
5. **Fan pages**: account type, following, show claims with proof, VIP, the top 100.

## 5. Research (2026-10-10)

**How Spotify lets a page be claimed.** A request reviewed by Spotify staff, with a link to the artist's website
or social accounts as the evidence; instant if the music is delivered by a distributor Spotify trusts; one open
request per profile; once claimed nobody can ask to join, an admin invites them; roles are Reader, Editor, Admin,
with a separate "can manage people" flag; disputes go to staff. Greenroom has no distributor, so the equivalent
is: one open claim per page, reviewed by Devin; proof by a code posted on the artist's official site or social
bio, or a reply from an address at the artist's own domain, or an already-claimed member vouching; then
invitation only.

**Proving a fan was at a show.** Nobody offers ticketing data to a small app. What works: a photo of the stub,
order email or wristband, read by the app, matched to a real show in the archive, checked against reuse, with the
barcode masked and the picture not kept; a code shown at the show that changes every minute; an artist or crew
vouch. Suggested: three levels (claimed, supported by a stub, verified at the show), with only the last two
counting toward the top 100.

**An NDA signed in the app.** A ticked box and a typed legal name is a valid signature in the US if the screen is
clear ("By tapping Sign I agree to ...") and the record can be proven: the exact text and its version, the typed
name, the email, the time, the device, and a copy the signer can keep. Signature records must outlive the
account. A lawyer should read the NDA and the signing screen before the beta opens.

## 6. To decide (Devin)

1. Crew dates: does "worked for the artist from A to B" mean every show in between, or do they still tick tours?
2. Who can fire a member: any other member, or all of them together?
3. A tour made by mistake: taken down and restorable (today), or not even that?
4. Account deletion (the App Store requires it): what happens to an artist page whose only member leaves.
5. Whether a fan needs an invite code during the beta.
