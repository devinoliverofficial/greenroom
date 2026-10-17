// Fan-out for Greenroom notifications. A signed-in member reports an event on
// a tour ("guests added", "we're in the green", "merch milestone", "sold
// out", and since 2026-10-15 Devin's event kinds: a day-off poll vote, flowers
// given, a chat message, a payment logged, a day sheet posted, a buyout
// tracked; since 2026-10-17 a buyout asked for, and a paid back ask); this
// looks up everyone on that tour the kind is for who opted into that kind of
// news and web-pushes them. Senders never notify themselves.
//
// Since 2026-10-17 three kinds are about a person, not a tour: a page claim
// (for Greenroom's admins, who decide it), an ask to join an artist page (for
// whoever runs the page), and a direct message (for the person it was sent
// to). For those the phone sends only the kind and the row's id; this reads
// the row itself, checks the sender made it moments ago, and works out who
// hears it from the database. Nothing about who hears it comes from the phone.
//
// Each kind's pref key on push_subs.prefs, and what a phone that never saved
// the key counts as: vote and chat are OFF until asked for (brand new, and
// chatty); flowers, payment, buyout (each about you alone) and sheet (the day
// sheet everyone already got) are ON unless switched off; green stays with
// the Managers and is ON unless switched off; requests honor prefs.requests
// the same way (and since 2026-10-17 reach everyone on the tour); reimburse
// (Managers), claims, joinreqs and dms are ON unless switched off; guests
// decides the guest list once saved, and before that the phone's group says
// (ALL only, as it always was). soldout and merchnums stay opt-in as stored.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

webpush.setVapidDetails(
  "mailto:devinoliverofficial@gmail.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

interface NotifyBody { tourId?: string; type?: string; data?: Record<string, unknown> }

/* What a phone sends is cut to size here, so one sender cannot push a page of
   text (or a ticket count of a million) to everyone on the tour. */
const cut = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

function message(type: string, d: Record<string, unknown>, tourName: string): { title: string; body: string } | null {
  const city = cut(d.city, 60);
  switch (type) {
    case "guest": {
      const n = Math.min(99, Math.max(1, Math.floor(Number(d.tickets ?? 1)) || 1));
      return { title: tourName, body: `${cut(d.name, 60) || "Someone"} was added to the ${city || "show"} guest list (${n} ticket${n === 1 ? "" : "s"})` };
    }
    case "green":
      return { title: tourName, body: `You're in the green: ${cut(d.net, 24)} and climbing \u{1F389}` };
    case "merch":
      return { title: tourName, body: `MERCH NUMBERS. ${city || "Tonight"}: ${cut(d.amount, 24)} in merch.` };
    case "wearebus":
      // The completing On Bus sends it; the wheel alone hears it.
      return { title: "WE ARE A BUS", body: `Everyone on ${tourName} is on the bus.` };
    case "soldout":
      return { title: tourName, body: `${city || "Tonight"} is SOLD OUT` };
    case "alert": {
      const text = String(d.message ?? "").trim().slice(0, 200);
      return text ? { title: `\u{1F6A8} ${tourName}`, body: text } : null;
    }
    case "request": {
      // A special request on the calendar, for everyone on the tour (Devin,
      // 2026-10-17: "This can be everyone").
      const text = String(d.text ?? "").trim().slice(0, 140);
      const who = String(d.who ?? "Someone");
      return text ? { title: tourName, body: `${who} has a special request${city ? " for " + city : ""}: "${text}"` } : null;
    }
    case "vote": {
      // A day-off poll vote landed, for the tour's Managers.
      const who = String(d.who ?? "Someone");
      const day = cut(d.date, 12);
      return { title: tourName, body: `${who} voted on the day off poll${day ? " (" + day + ")" : ""}` };
    }
    case "flowers": {
      // Flowers were given, for the one person who got them.
      const who = String(d.who ?? "Someone");
      const n = Math.min(10, Math.max(1, Math.floor(Number(d.n ?? 1)) || 1));
      return { title: tourName, body: `${who} gave you ${n === 1 ? "a flower" : n + " flowers"}` };
    }
    case "chat": {
      // A chat message landed, for everyone on the tour who asked for it.
      const text = String(d.text ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
      const who = String(d.who ?? "Someone");
      return text ? { title: tourName, body: `${who}: ${text}` } : null;
    }
    case "payment": {
      // The band logged a payment, for the one person who was paid.
      const amount = Math.max(0, Math.min(1e7, Number(d.amount) || 0));
      return { title: tourName, body: amount > 0 ? `${money(amount)} was logged as paid to you` : "A payment to you was logged" };
    }
    case "sheet":
      // A day sheet was posted (Ari's own DAY SHEET AVAILABLE still runs on
      // show day; this one says it the moment it is saved).
      return { title: tourName, body: `The ${city || "show day"} day sheet is up` };
    case "buyout":
      // A buyout was marked tracked, for the one person it was handed to.
      return { title: tourName, body: `Your buyout${city ? " for " + city : ""} is marked received` };
    case "buyoutask": {
      // Someone still waiting on their buyout bumped the Tour Manager, in the
      // splash's own words (Devin, 2026-10-17: "give X their buyout").
      const who = String(d.who ?? "Someone");
      return { title: tourName, body: `Give ${who} their buyout${city ? " for " + city : ""}` };
    }
    case "reimburse":
      // Someone asked to be paid back, for the tour's Managers. The amount and
      // the words are the ask's own, read from the database.
      return { title: tourName, body: paidBackWords(d) };
    default:
      return null;
  }
}

// ---- pure: words, recipients and gates (tools check these with fake rows) ----
type Prefs = Record<string, unknown>;
type Row = Record<string, unknown> | null | undefined;

// The words for a person-scoped kind. The title is the app's name: these are
// not about a tour. A message's own text is never shown (lock screens).
function personMessage(type: string, d: Prefs): { title: string; body: string } | null {
  const who = cut(d.who, 60) || "Someone";
  const artist = cut(d.artist, 80);
  if (type === "claim") return { title: "Greenroom", body: artist ? `${who} asked to run ${artist}\u2019s page.` : `${who} asked to run a page.` };
  if (type === "joinreq") return { title: "Greenroom", body: `${who} asked to join ${artist || "your page"} as ${d.kind === "band" ? "a Member" : "crew"}.` };
  if (type === "dm") return { title: "Greenroom", body: `${who} sent you a message.` };
  return null;
}

// "$42.17", or "$1,200" when there are no cents.
function moneyCents(n: number): string {
  const c = Math.round(n * 100) / 100;
  const whole = Math.abs(c - Math.round(c)) < 0.005;
  return "$" + c.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

// "<Name> asked to be paid back <$amount> for <what>."
function paidBackWords(d: Prefs): string {
  const who = cut(d.who, 60) || "Someone";
  const amount = Math.max(0, Math.min(1e5, Number(d.amount) || 0));
  const what = cut(d.what, 80).replace(/[\s.]+$/, "");
  return `${who} asked to be paid back${amount > 0 ? " " + moneyCents(amount) : ""}${what ? " for " + what : ""}.`;
}

// A row made in the last ten minutes (a minute of clock slack ahead).
function fresh(at: unknown, now: number): boolean {
  const t = Date.parse(String(at ?? ""));
  return Number.isFinite(t) && t <= now + 60000 && now - t <= 10 * 60 * 1000;
}

function othersThan(ids: string[], senderId: string): string[] {
  return [...new Set(ids.map((x) => String(x ?? "")))].filter((x) => x && x !== senderId);
}

// B1: a claim the sender just filed and still waiting is decided by
// Greenroom's admins (platform_admins, the rule claim_queue and decide_claim
// use).
function claimTargets(claim: Row, admins: string[], senderId: string, now: number): string[] {
  if (!claim || String(claim.user_id) !== senderId || claim.status !== "pending" || !fresh(claim.created_at, now)) return [];
  return othersThan(admins, senderId);
}

// B2: an ask to be listed, still waiting, is answered by whoever runs the
// page (runs_artist: the page's owner, the rule artist_request_queue and
// decide_artist_request use). A page nobody runs has nobody to tell.
function joinTargets(req: Row, artist: Row, senderId: string, now: number): string[] {
  if (!req || !artist || String(req.user_id) !== senderId || String(req.artist_id) !== String(artist.id)) return [];
  if (req.status !== "pending" || !fresh(req.created_at, now)) return [];
  return othersThan([String(artist.owner_id ?? "")], senderId);
}

// B3: a message the sender just sent, not read yet, is for its recipient.
function dmTargets(dm: Row, senderId: string, now: number): string[] {
  if (!dm || String(dm.sender) !== senderId || dm.read_at || !fresh(dm.created_at, now)) return [];
  return othersThan([String(dm.recipient ?? "")], senderId);
}

// D: a paid back ask the sender just made on this tour, still open.
function reimburseOk(row: Row, tourId: string, senderId: string, now: number): boolean {
  return !!row && String(row.user_id) === senderId && String(row.tour_id) === tourId &&
    row.status === "open" && fresh(row.created_at, now);
}

// News about the tour's money is for its Managers (Devin, 2026-10-10: "In the
// green notifications and any notifications that are pertaining to the
// managers should only be available to managers of the tour"). A special
// request left this list on 2026-10-17: everyone hears it now.
const FOR_MANAGERS = ["green", "merch"];

// Who hears a kind that goes to the whole tour: everyone on it but the
// sender, or only its Managers for money news.
function broadTargets(type: string, memberIds: string[], managers: string[], senderId: string): string[] {
  const lead = new Set(managers);
  return othersThan(memberIds, senderId).filter((id) => !FOR_MANAGERS.includes(type) || lead.has(id));
}

// Does this phone's prefs let a tour kind through?
function tourGate(type: string, prefs: Prefs): boolean {
  // Each phone picks CREW, ARTIST or ALL, plus SOLD OUT and MERCH NUMBERS.
  // A phone set up before those choices counts as ALL.
  const group = String(prefs.group ?? "all");
  // An alert ignores preferences: it is the Managers' siren.
  if (type === "alert") return true;
  // A special request: on unless the phone said no.
  if (type === "request") return prefs.requests !== false;
  if (type === "soldout") return prefs.soldout === true;
  if (type === "merch") return prefs.merchnums === true;
  // Only the tour's Managers get it: on unless their phone said no.
  if (type === "green") return prefs.green !== false;
  // Brand new, and chatty: off until the phone asks for it.
  if (type === "vote" || type === "chat") return prefs[type] === true;
  // It reaches only the person driving, whose job it answers: on unless
  // their phone said no.
  if (type === "wearebus") return prefs.wearebus !== false;
  // Rides the phone's buyout switch: on unless it said no.
  if (type === "buyoutask") return prefs.buyout !== false;
  // About you alone (or the day sheet everyone already got): on unless the
  // phone switched it off.
  if (type === "flowers" || type === "payment" || type === "buyout" || type === "sheet") return prefs[type] !== false;
  // A paid back ask, for the Managers: on unless their phone said no.
  if (type === "reimburse") return prefs.reimburse !== false;
  // The guest list: its own switch once the phone has saved one; before
  // that, ALL only, as it always was.
  if (type === "guest" && typeof prefs.guests === "boolean") return prefs.guests;
  return group === "all";
}

// Does this phone's prefs let a person kind through? On unless it said no.
function personGate(type: string, prefs: Prefs): boolean {
  if (type === "claim") return prefs.claims !== false;
  if (type === "joinreq") return prefs.joinreqs !== false;
  if (type === "dm") return prefs.dms !== false;
  return false;
}
// ---- end pure ----

const TOUR_KINDS = ["guest", "green", "merch", "soldout", "alert", "request",
  "vote", "flowers", "chat", "payment", "sheet", "buyout", "buyoutask", "wearebus", "reimburse"];
const PERSON_KINDS = ["claim", "joinreq", "dm"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Each person-scoped event, and each paid back ask, goes out once: the first
   call to write its key wins. The keys live in Ari's ari_sent under the tour
   id "_notify", which no tour has, so Ari's rows never meet them. */
async function firstTime(key: string): Promise<boolean> {
  const { data, error } = await admin.from("ari_sent")
    .upsert({ tour_id: "_notify", show_id: key.slice(0, 200), kind: "once" },
      { onConflict: "tour_id,show_id,kind", ignoreDuplicates: true })
    .select("kind");
  return !error && Array.isArray(data) && data.length > 0;
}

/* Now and then, the keys nobody can need again (every one is checked against
   a row made in the last ten minutes, or a day's key) are cleared away. */
async function tidyKeys(): Promise<void> {
  if (Math.random() > 0.02) return;
  try {
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    await admin.from("ari_sent").delete().eq("tour_id", "_notify").eq("kind", "once").lt("sent_at", old);
  } catch { /* next time */ }
}

/* A person's name as the app shows it: their full name, else first and last,
   else their username. */
async function whoIs(uid: string): Promise<string> {
  const { data: p } = await admin.from("profiles").select("full_name, first_name, last_name, username")
    .eq("user_id", uid).maybeSingle();
  const both = [p?.first_name, p?.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
  return cut(String(p?.full_name ?? "").trim() || both || String(p?.username ?? "").trim(), 60) || "Someone";
}

/* Push one message to every phone of these people that lets it through, and
   forget the phones that are gone. */
async function deliver(targets: string[], allow: (prefs: Prefs) => boolean, payload: Record<string, unknown>): Promise<number> {
  if (!targets.length) return 0;
  const { data: subs } = await admin.from("push_subs")
    .select("endpoint, p256dh, auth, prefs, user_id")
    .in("user_id", targets);
  let sent = 0;
  const dead: string[] = [];
  for (const sub of subs ?? []) {
    if (!allow((sub.prefs ?? {}) as Prefs)) continue;
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      );
      sent += 1;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode ?? 0;
      if (code === 404 || code === 410) dead.push(sub.endpoint); // device gone
    }
  }
  if (dead.length) await admin.from("push_subs").delete().in("endpoint", dead);
  return sent;
}

/* A claim, an ask to join a page, or a direct message. data.id is the
   artist's id for a claim or an ask (the row is the sender's own on that
   page), and the message's id for a message. */
async function personScoped(senderId: string, type: string, data: Prefs): Promise<Response> {
  const id = cut(data.id, 40);
  if (!UUID.test(id)) return reply(400, { error: "invalid" });
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  let targets: string[] = [];
  let words: Prefs = {};
  let keys: string[] = [];
  if (type === "claim") {
    const { data: c } = await admin.from("artist_claims").select("id, artist_id, user_id, status, created_at")
      .eq("artist_id", id).eq("user_id", senderId).maybeSingle();
    const { data: ad } = await admin.from("platform_admins").select("user_id");
    targets = claimTargets(c, (ad ?? []).map((r) => String(r.user_id)), senderId, now);
    if (targets.length) {
      const { data: a } = await admin.from("artists").select("name").eq("id", id).maybeSingle();
      words = { artist: a?.name };
    }
    // One a day for one person and one page, however often it is withdrawn and sent again.
    keys = [`claim:${id}:${senderId}:${day}`];
  } else if (type === "joinreq") {
    const { data: r } = await admin.from("artist_requests").select("artist_id, user_id, kind, status, created_at")
      .eq("artist_id", id).eq("user_id", senderId).maybeSingle();
    const { data: a } = await admin.from("artists").select("id, name, owner_id").eq("id", id).maybeSingle();
    targets = joinTargets(r, a, senderId, now);
    words = { artist: a?.name, kind: r?.kind };
    keys = [`joinreq:${id}:${senderId}:${day}`];
  } else if (type === "dm") {
    const { data: m } = await admin.from("dms").select("id, sender, recipient, created_at, read_at")
      .eq("id", id).maybeSingle();
    targets = dmTargets(m, senderId, now);
    // Each message once, and one buzz a minute from one person to another
    // (the words never carry the text, so a run of messages is one buzz).
    keys = [`dm:${id}`, `dmpair:${senderId}:${targets[0] ?? ""}:${Math.floor(now / 60000)}`];
  }
  if (!targets.length) return reply(200, { sent: 0 });
  const msg = personMessage(type, { ...words, who: await whoIs(senderId) });
  if (!msg) return reply(400, { error: "invalid" });
  for (const k of keys) if (!(await firstTime(k))) return reply(200, { sent: 0, said: true });
  await tidyKeys();
  const sent = await deliver(targets, (p) => personGate(type, p), { title: msg.title, body: msg.body });
  return reply(200, { sent });
}

/* The tour's Tour Manager: ALL ACCESS on it, with that role (their own
   card, what the invite said, or what the crew list was edited to). */
async function isTourManager(tourId: string, uid: string): Promise<boolean> {
  if (!uid) return false;
  const { data: m } = await admin.from("members").select("role, tour_role, overrides")
    .eq("tour_id", tourId).eq("user_id", uid).maybeSingle();
  if (!m || m.role !== "editor") return false;
  const { data: p } = await admin.from("profiles").select("tour_role").eq("user_id", uid).maybeSingle();
  const ov = (m.overrides ?? {}) as Record<string, unknown>;
  return String(ov.tourRole || p?.tour_role || m.tour_role || "").trim().toLowerCase() === "tour manager";
}

/* Every job title a seat carries, wherever it is kept (the crew list's edit,
   their own card, the invite), each split into its up-to-six roles. */
async function seatTitles(tourId: string): Promise<Map<string, { manager: boolean; roles: string[] }>> {
  const out = new Map<string, { manager: boolean; roles: string[] }>();
  const { data: ms } = await admin.from("members").select("user_id, role, manager, tour_role, overrides")
    .eq("tour_id", tourId);
  const ids = (ms ?? []).map((m) => m.user_id).filter(Boolean) as string[];
  const { data: ps } = ids.length
    ? await admin.from("profiles").select("user_id, tour_role").in("user_id", ids)
    : { data: [] as { user_id: string; tour_role: string | null }[] };
  const prof = new Map<string, string>((ps ?? []).map((p) => [String(p.user_id), String(p.tour_role ?? "")]));
  for (const m of ms ?? []) {
    if (!m.user_id) continue;
    const ov = (m.overrides ?? {}) as Record<string, unknown>;
    const roles = [ov.tourRole, prof.get(String(m.user_id)), m.tour_role]
      .flatMap((v) => String(v ?? "").split(","))
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean);
    out.set(String(m.user_id), { manager: m.role === "editor" && !!m.manager, roles });
  }
  return out;
}

/* Who keeps the buyout track: the database says (buyout_trackers, migration
   0176: a creator or Manager titled Tour manager, else the creator and the
   Managers). Before 0176, the same rule here; and if nothing can be read,
   the Managers. */
async function buyoutTrackersOf(tourId: string, ownerId: string): Promise<string[]> {
  try {
    const { data, error } = await admin.rpc("buyout_trackers", { t_id: tourId });
    if (!error && Array.isArray(data)) return (data as string[]).filter(Boolean).map(String);
  } catch { /* the rule below */ }
  try {
    const seats = await seatTitles(tourId);
    const { data: op } = await admin.from("profiles").select("tour_role").eq("user_id", ownerId).maybeSingle();
    const isTM = (roles: string[]) => roles.includes("tour manager");
    const titled = [...seats.entries()].filter(([, s]) => s.manager && isTM(s.roles)).map(([id]) => id);
    if (isTM(String(op?.tour_role ?? "").split(",").map((r) => r.trim().toLowerCase()))) titled.push(ownerId);
    if (titled.length) return titled;
  } catch { /* the Managers */ }
  return [...(await managersOf(tourId, ownerId))];
}

/* The tour's Managers: its creator, and whoever the database says manages it
   (tour_managers, migration 0133: the rule lives there, so it can change
   without pasting this function again). If the database cannot say, only the
   creator counts. */
async function managersOf(tourId: string, ownerId: string): Promise<Set<string>> {
  const out = new Set<string>([ownerId]);
  try {
    const { data } = await admin.rpc("tour_managers", { t_id: tourId });
    for (const id of (data ?? []) as string[]) if (id) out.add(String(id));
  } catch { /* the creator alone */ }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  // Who's talking? The server checks the sign-in itself (getUser), not only
  // the gateway's "Verify JWT" switch, so a token nobody signed is never trusted.
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  let senderId = "";
  try {
    if (jwt) {
      const { data: who } = await admin.auth.getUser(jwt);
      if (who?.user) senderId = String(who.user.id);
    }
  } catch { /* fall through */ }
  if (!senderId) return reply(401, { error: "not_signed_in" });

  let body: NotifyBody;
  try { body = await req.json(); } catch { return reply(400, { error: "invalid" }); }
  const type = String(body?.type ?? "");
  // A claim, an ask to join a page, a direct message: about a person, not a tour.
  if (PERSON_KINDS.includes(type)) {
    const pd = body?.data && typeof body.data === "object" ? body.data : {};
    return await personScoped(senderId, type, pd);
  }
  const tourId = String(body?.tourId ?? "");
  const data = body?.data ?? {};
  if (!tourId || !TOUR_KINDS.includes(type)) {
    return reply(400, { error: "invalid" });
  }

  // The sender must actually be on this tour.
  const { data: tour } = await admin.from("tours").select("id, owner_id, doc").eq("id", tourId).single();
  if (!tour) return reply(404, { error: "no_tour" });
  const { data: members } = await admin.from("members").select("user_id, role").eq("tour_id", tourId);
  const memberIds = new Set<string>([tour.owner_id, ...(members ?? []).map((m) => m.user_id).filter(Boolean)]);
  if (!memberIds.has(senderId)) return reply(403, { error: "not_on_tour" });

  const managers = await managersOf(tourId, tour.owner_id);
  // Alerts are the Managers' siren (a Tour Manager by title, from before there were Managers, still counts).
  if (type === "alert" && !managers.has(senderId) && !(await isTourManager(tourId, senderId))) {
    return reply(403, { error: "not_manager" });
  }
  // Only a Manager can send the tour's money news; a payment or a buyout
  // tick is the tour's money too, so only a Manager says one happened.
  if ((type === "green" || type === "merch" || type === "payment" || type === "buyout") && !managers.has(senderId)) {
    return reply(403, { error: "not_manager" });
  }

  // A buyout bump goes out only for one the database just kept (0176's
  // buyout_asks lets one in only while the asker is still untracked on a
  // show day from the fresh start through today, and one an hour), and
  // names the show's own town, never one sent along with it.
  if (type === "buyoutask") {
    const showId = cut(data.showId, 80);
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: asks } = showId
      ? await admin.from("buyout_asks").select("asked_at").eq("tour_id", tourId).eq("show_id", showId)
        .eq("user_id", senderId).gte("asked_at", since).limit(1)
      : { data: [] };
    if (!asks || !asks.length) return reply(403, { error: "no_ask" });
    const shows = ((tour.doc as Record<string, unknown>)?.shows ?? {}) as Record<string, Record<string, unknown>>;
    data.city = String(shows?.[showId]?.city ?? "").split(",")[0];
  }

  // A paid back ask goes out only for one the sender just made on this tour,
  // still open, and says the ask's own amount and words, never ones sent
  // along with it.
  let reimbKey = "";
  if (type === "reimburse") {
    const rid = cut(data.id, 40);
    const { data: row } = /^[A-Za-z0-9_-]{6,40}$/.test(rid)
      ? await admin.from("reimbursements").select("id, tour_id, user_id, requester_name, amount, what, status, created_at")
        .eq("id", rid).maybeSingle()
      : { data: null };
    if (!reimburseOk(row, tourId, senderId, Date.now())) return reply(403, { error: "no_ask" });
    data.who = cut(row?.requester_name, 60) || await whoIs(senderId);
    data.amount = Number(row?.amount) || 0;
    data.what = String(row?.what ?? "");
    reimbKey = `reimburse:${rid}`;
  }

  const tourName = cut((tour.doc as Record<string, unknown>)?.name, 80) || "Greenroom";
  if (["request", "vote", "chat", "flowers", "buyoutask"].includes(type)) {
    // The sender's own name, never one sent along with the event.
    const { data: prof } = await admin.from("profiles").select("full_name, username").eq("user_id", senderId).maybeSingle();
    data.who = String(prof?.full_name || prof?.username || "Someone");
  }
  if (type === "buyoutask" && data.who !== "Someone") {
    // The splash's words: a first name, in full where someone else on the
    // tour shares it.
    const full = String(data.who).trim().replace(/\s+/g, " ");
    const first = full.split(" ")[0];
    const others = [...memberIds].filter((id) => id && id !== senderId);
    let shared = false;
    if (others.length) {
      const { data: profs } = await admin.from("profiles").select("full_name").in("user_id", others);
      shared = (profs ?? []).some((x) => String(x.full_name ?? "").trim().split(/\s+/)[0].toLowerCase() === first.toLowerCase());
    }
    data.who = shared ? full : first;
  }
  const msg = message(type, data, tourName);
  if (!msg) return reply(400, { error: "invalid" });

  // Who hears it: money news, poll votes and paid back asks go to the tour's
  // Managers; flowers, a payment and a buyout go to the one person they are
  // about (who must be on the tour); everything else, a special request
  // included, goes to everyone on the tour. Senders never notify themselves.
  const PERSONAL = ["flowers", "payment", "buyout"];
  let targets: string[];
  if (type === "vote" || type === "reimburse") {
    targets = [...managers].filter((id) => id !== senderId);
  } else if (PERSONAL.includes(type)) {
    const to = String(data.to ?? "");
    targets = memberIds.has(to) && to !== senderId ? [to] : [];
  } else if (type === "buyoutask") {
    // Whoever keeps the buyout track: the Tour Manager.
    targets = (await buyoutTrackersOf(tourId, tour.owner_id)).filter((id) => memberIds.has(id) && id !== senderId);
  } else if (type === "wearebus") {
    // The wheel alone: tour crew whose job title reads driver. (The title,
    // not members.role, which only ever says viewer or editor.)
    const seats = await seatTitles(tourId);
    targets = [...seats.entries()]
      .filter(([, s]) => s.roles.some((r) => /driver/i.test(r)))
      .map(([id]) => id)
      .filter((id) => id && id !== senderId);
  } else {
    targets = broadTargets(type, [...memberIds], [...managers], senderId);
  }
  if (!targets.length) return reply(200, { sent: 0 });
  // (Each paid back ask once, however often the phone says it.)
  if (reimbKey) {
    if (!(await firstTime(reimbKey))) return reply(200, { sent: 0, said: true });
    await tidyKeys();
  }
  const sent = await deliver(targets, (p) => tourGate(type, p), { title: msg.title, body: msg.body, tourId });
  return reply(200, { sent });
});
