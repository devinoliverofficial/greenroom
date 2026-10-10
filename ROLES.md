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

| **Venue** | A room. A page of its own, made when searched; claimed by its promoters; rated by artists, members and crew. Later build. | "Venue pages will be almost the same as artist pages. They will 'AUTO CREATE' when searched" |
| **Promoter** | A person who runs shows. A page of the shows they ran. Later build. | "This is how many shows i've ran and these are the exact shows I've worked." |

One person can be more than one thing: Brent is a Member and the tour manager. Connor plays drums and is crew.

**The two sides of touring** (his names, 2026-10-10):

| Name | What it is | Who sees it | Deleting |
|---|---|---|---|
| **Touring Logistics pages** | A tour in the app: Overview, Budget, Day sheet, Guest list, Crew Stats, Chat. | Only the people on it, by role. | "can be edited and deleted and restored" |
| **Touring Social Media Experience** | The public record: tours, shows, cities and countries on artist pages and people's pages, "almost as badges of honor". | Everyone, fans too. | "an archive that forever exists" |

**Crew roles, in his order.** First hires: Tour manager, FOH engineer, Merch manager, Driver, Backline tech.
As you grow: Monitor engineer, Drum tech, Lighting director, Photographer / videographer, Playback tech,
Production manager, Stage manager. Bigger tours: Assistant TM / production coordinator, Truck driver,
Head of security / personal security, VIP coordinator, Wardrobe / stylist, Hair & makeup artist, Head rigger,
Tour accountant. Then the two for hired players: Band, Touring Musician. (`G.CREW_ROLES` in `src/core.js`.)

## 2. The rules

1. **The public record is never deleted; the private pages can be.** "The greenroom app is an archive. A history
   book." An artist page is never deleted. The Touring Social Media Experience "should be an archive that forever
   exists". The Touring Logistics pages "can be edited and deleted and restored": a deleted tour is kept, out of
   sight, and its creator can restore it. Nothing is erased for good.
2. **Artist pages are the centre.** Tours are made there, roles assigned, people endorsed, fans follow, and crew
   claim the tours they worked ("artist pages have to accept all crew claims").
3. **An artist page is claimed by a member, with proof**, "the exact same way Spotify allows people to claim pages".
4. **Dates.** When a member or a crew person is endorsed they are asked how long they were in the band, or worked
   for the artist. Their touring history and every number on their page follow those dates, live. Crew pick the
   exact calendar days: "people should be able to pick the exact calendar to date and then any show and/or tour
   is added to their personal analytics."
5. **Leaving.** "Just because you were fired doesn't mean your history is erased. It just means from the moment you
   were fired you are no longer listed on that artist page and getting analytics added to your page for future
   tours. This should be the same for crew as well." Who decides: "when firing a crew member anyone can do it. But
   when firing a member you need to get the other members to endorse the decision."
6. **Member pages and crew pages are the same kind of page.** Fan pages are a different experience.
7. **Fans** follow artist, member and crew pages; claim the shows they attended, with proof such as a ticket
   stub; show a lifetime count; are ranked 1 to 100 under each artist by shows attended; can be endorsed as VIPs.
8. **NDAs.** In the beta, everyone signs an NDA straight after typing the invite code, before an account can be
   made, and every signed NDA is kept. An artist can also upload its own NDA, shown to a crew member who is
   seeking endorsement. Fans "should need a code as well for now".
9. **The three lines.** "Create a tour" and Merchroom for artists and members; Settings for everyone. Settings:
   contact card, sign out, delete my account (not on an artist's account: "Those just exist"), and Linked Cards
   for members, artists and crew, never fans.
10. **Who sees what on a tour** (the Touring Logistics pages, behind Overview):

| Who | Sees | Edits |
|---|---|---|
| Artists and Members | Every tab, "BUT only for artists that they are a part of". "Each artists should have a clean slate." | Only Managers edit ("Obviously managers are the only ones that can edit"); members are Managers by default |
| Crew | Overview, Day sheets, Guest lists, Crew Stats, Chats; under Budget "they only see MY PAY NOT the bands income/expenses/card information" | Their own MY PAY |
| Fans | "does not have any access to the overview page at all. Just the user profile experience and searching for artist pages" | |

   "If you invite people to your tour then the roles define what you can see."

## 3. What the app does today (checked 2026-10-10)

**Already matches**
- Members and Crew are two lines on a tour's Expenses tab; a hired player titled Band or Touring Musician is
  crew; a tour manager who is in the band is switched to Member (the Member / Crew switch on the person).
- The crew role list above is the list offered on a tour and on an artist page.
- A tour or an artist page can no longer be erased by anyone using the app (migration 0131). A tour's creator can
  delete it (it goes out of sight) and restore it from Settings, Deleted tours, with no time limit; the 30-day
  clear-out and "Delete forever" are gone.
- Leaving keeps your history (migration 0132): taking someone off an artist page ends their listing instead of
  deleting it. They are off the page from that day; everything up to that day stays on their own page (a member:
  every night, the artist's whole list as it stood; crew: what the artist confirmed); nothing later is added.
  Crew are off at once. A member is off when every other member has said yes; one no stops it. Someone listed
  but never endorsed is simply taken off.
- The three lines are Create a tour, Merchroom (artists and members) and Settings; crew get MY PAY alone under
  Budget; on an artist's account Overview only opens that artist's tours.
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
| Leaving | Done 2026-10-10 (0132), with one stretch per person: listing the same person again picks up as if they never left. | From and until for each stretch (the dates build). |
| Only Managers edit | Whoever is invited ALL ACCESS can edit the whole tour; Manager adds little (polls, answering Ari, sorting deposits, Tasks). There is no "sees everything, edits nothing". | Editing a tour asks for Manager, in the app and in the database; ALL ACCESS without it reads only. |
| Members see every tab | What you see comes from how you were invited to that tour (GA or ALL ACCESS), not from being a Member. A Member who was not invited sees nothing of it. | Tours belong to the artist; a Member's access comes from the artist page. |
| Crew never see the band's money | True on every screen and in the database for GA. But a crew person invited ALL ACCESS sees and edits all of it. | Invites offer Member / Manager / Crew, not ALL ACCESS / GA. |
| A clean slate per artist | Each tour's data is walled off by tour. Overview follows the artist only for the account that runs the page; a listed Member cannot switch to the artist. Search still lists every tour you are on. | Tours carry the artist's id; Overview, the picker and Search follow the artist you are on. |
| The public record outlives the private pages | Deleting a tour also takes its card off the artist's and people's tour lists until it is restored. | A tour that has been announced writes its name, dates, cities and venues into the archive, which then stands on its own. |
| Tours made on the artist page | A tour belongs to the account that made it and names its artist as text. A tour manager's tours never show on the band's page. | Tours carry the artist's id; members and managers of the artist can open and edit them. |
| Claiming like Spotify | A note and an optional link, approved by hand by Devin. No proof step. | See section 5. |
| Sign-up | The only way in is a tour invite. The account is created when the tour manager taps Invite. No account types. | Greenroom invite codes, an NDA step, then the account; a choice of what you are. |
| NDAs | Nothing exists. | Documents and signatures tables; the signup gate refuses an email with no signature. |
| Fans | Only the Follow button. A fan cannot get in, and could not open a person's page. | A fan account type, a fan home, show claims with proof, VIP, the top 100. |
| Never erased | Still possible: account deletion erases the tours that account made and had deleted; removing a user in the Supabase dashboard cascades to their tours and their artist page; a page's road history can be switched off, and a tour the tour finder added to it can be removed; search-made pages nobody opens are cleared. | Decide each with Devin (the App Store requires account deletion). |
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

0. **Done 2026-10-10:** the words on tours (Members line, hired players are crew, his crew list), no erasing;
   the three-lines menu and Settings; crew see MY PAY alone; delete and restore for a tour's private pages;
   leaving keeps your history, and letting a member go takes the other members.
1. **Sign-up, the NDA, and a way to test every kind of login** (his ask for this week). Greenroom invite codes by
   kind (member, crew, hired player, fan, promoter: "You can start building both the fan, venue, and promoters
   pages into the login process"); code, then NDA, then account; the account remembers its kind, which is what
   Create a tour, Linked Cards and Overview should ask instead of guessing; a Testers screen for Devin listing
   the test accounts with a reset he presses himself. Waiting on: the NDA text.
2. **Roles on the artist page.** Members and Crew with several roles, from and until asked at endorsement,
   firing as an end date, history by dates, Managers, tours that belong to the artist.
3. **Claiming an artist page with proof.**
4. **The artist's own NDA** at endorsement.
5. **Fan pages**: account type, following, show claims with proof, VIP, the top 100. No Overview.
6. **Venue pages** (made when searched, claimed by promoters, rated by artists, members and crew) and
   **promoter pages** (the shows they ran).

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

## 6. Decided and still to decide (Devin)

**Decided 2026-10-10**
1. Crew dates: exact calendar days, from and until; every show and tour in between counts.
2. Letting a crew person go: whoever runs the page, at once. Letting a member go: every other member has to agree.
3. A tour's private pages can be deleted and restored; the public record cannot.
4. Fans need an invite code too, for now.

**Still to decide**
1. When does a tour become part of the public record? ("as tours are announced"): at an Announce button, or as
   soon as it has dates? Until this is built, deleting a tour also hides its public card.
2. Account deletion (the App Store requires it): today it erases the tours that account made and had deleted, and
   an account that runs an artist page cannot be deleted at all. What should happen to both?
3. "Only Managers edit": does that include the card settings, logging bank deposits and naming other Managers,
   which today only the tour's creator can do?
4. Should anyone at all be able to tap + and add an artist (today yes; it is the only way a new artist starts),
   or only an account that signed up as an artist or member?
5. Merch that belongs to no show (an online store payout): "Get rid of off tour" was about what? The Off Tour
   book itself is in use (it is the third tab under Budget).
6. "View flyer" on a tour in someone's history: build it?
