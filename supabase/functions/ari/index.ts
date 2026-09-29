// Ari's scheduled messages. Every minute the database taps this function (with
// the cron key from Vault); a signed-in member can also tap it for one tour
// right after posting a day sheet, so DAY SHEET AVAILABLE goes out at once.
//
//   LOAD IN              10 min before the day sheet's load in    → Crew + All
//   SHOW TIME            30 min before our band's set             → Artist + All
//   DAY SHEET AVAILABLE  show day, once the day sheet is up       → everyone
//   MERCH NUMBERS        a night's merch number arrives / changes → phones that asked
//
// Times on a day sheet are the venue's local time, so each show is read in
// its own city's time zone. Every message goes out once (table ari_sent).
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

webpush.setVapidDetails(
  "mailto:devinoliverofficial@gmail.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } });

/* Devin's words, as he wrote them. */
const SAY = {
  loadin: "LOAD IN! It\u2019s that time again gang! Let\u2019s rally the troops, strap the boots and head for war! Load in is in 10 minutes, \\m/",
  showtime: "SHOW TIME! It\u2019s just about show time boys! Start your stretches, stop at bluey for your gear, drink a beer, chug a water, it\u2019s time to rock!",
  daysheet: "DAY SHEET AVAILABLE! Whats up gang! It\u2019s show day, let\u2019s kick today\u2019s ass, watch your brothers/sisters back, throw on that charm, shake some hands and getter done!",
};
type Group = "crew" | "artist" | "all";

/* ---------------- Time zones ---------------- */

const STATE_TZ: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago",
  KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago",
  UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver", PR: "America/Puerto_Rico",
  // Canada
  ON: "America/Toronto", QC: "America/Toronto", BC: "America/Vancouver", AB: "America/Edmonton",
  MB: "America/Winnipeg", SK: "America/Regina", NS: "America/Halifax", NB: "America/Moncton",
  NL: "America/St_Johns", PE: "America/Halifax", YT: "America/Whitehorse",
};
// States split across two zones: the bigger music towns on the other side.
const CITY_TZ: Record<string, string> = {
  "el paso": "America/Denver", "pensacola": "America/Chicago", "panama city": "America/Chicago",
  "knoxville": "America/New_York", "chattanooga": "America/New_York", "johnson city": "America/New_York",
  "bowling green": "America/Chicago", "paducah": "America/Chicago", "owensboro": "America/Chicago",
  "evansville": "America/Chicago", "gary": "America/Chicago", "rapid city": "America/Denver",
  "scottsbluff": "America/Denver", "coeur d'alene": "America/Los_Angeles", "spokane": "America/Los_Angeles",
  "ontario": "America/Boise", "fargo": "America/Chicago", "bismarck": "America/Chicago",
  "sioux falls": "America/Chicago", "ironwood": "America/Chicago",
};
const COUNTRY_TZ: Record<string, string> = {
  "UK": "Europe/London", "ENGLAND": "Europe/London", "SCOTLAND": "Europe/London", "WALES": "Europe/London",
  "IRELAND": "Europe/Dublin", "GERMANY": "Europe/Berlin", "FRANCE": "Europe/Paris", "SPAIN": "Europe/Madrid",
  "ITALY": "Europe/Rome", "NETHERLANDS": "Europe/Amsterdam", "BELGIUM": "Europe/Brussels",
  "SWEDEN": "Europe/Stockholm", "NORWAY": "Europe/Oslo", "DENMARK": "Europe/Copenhagen",
  "FINLAND": "Europe/Helsinki", "POLAND": "Europe/Warsaw", "AUSTRIA": "Europe/Vienna",
  "SWITZERLAND": "Europe/Zurich", "PORTUGAL": "Europe/Lisbon", "CZECHIA": "Europe/Prague",
  "CZECH REPUBLIC": "Europe/Prague", "JAPAN": "Asia/Tokyo", "AUSTRALIA": "Australia/Sydney",
  "NEW ZEALAND": "Pacific/Auckland", "MEXICO": "America/Mexico_City", "BRAZIL": "America/Sao_Paulo",
};
function tzFor(city: string, fallback: string): string {
  const c = String(city || "").trim();
  const parts = c.split(",").map((x) => x.trim()).filter(Boolean);
  const town = (parts[0] || "").toLowerCase();
  const tail = (parts[parts.length - 1] || "").toUpperCase().replace(/\./g, "");
  if (parts.length > 1 && CITY_TZ[town]) return CITY_TZ[town];
  if (STATE_TZ[tail]) return STATE_TZ[tail];
  if (COUNTRY_TZ[tail]) return COUNTRY_TZ[tail];
  return fallback;
}
function validTz(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
// The date (YYYY-MM-DD) and minutes past midnight right now in a time zone.
function localNow(now: Date, tz: string): { date: string; minutes: number } {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now).forEach((x) => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* "6:00PM", "6:30 pm", "18:30", "6" → minutes past midnight. A bare hour
   without AM/PM (an import, say) is read the way a show day runs: a set is
   always afternoon or night; a load in at 8-11 is morning. TBA → null. */
function minutesOf(v: unknown, morningLoadIn = false): number | null {
  const t = String(v ?? "").trim();
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))?\s*(?:([ap])\.?\s*m?\.?)?$/i.exec(t);
  if (!m) return null;
  let hr = Number(m[1]);
  const mins = Number(m[2] || "0");
  if (hr > 23 || mins > 59) return null;
  const ap = (m[3] || "").toLowerCase();
  if (ap === "p" && hr < 12) hr += 12;
  else if (ap === "a" && hr === 12) hr = 0;
  else if (!ap && hr >= 1 && hr <= 11 && !(morningLoadIn && hr >= 8)) hr += 12;
  return hr * 60 + mins;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

// Anything on the day sheet worth announcing?
function hasSheet(ds: Record<string, unknown>): boolean {
  return Object.keys(ds).some((k) => {
    if (k === "postedAt" || k === "tz") return false;
    const v = ds[k];
    if (Array.isArray(v)) return v.some((r) => isObj(r) && (String(r.band ?? "").trim() || String(r.time ?? "").trim()));
    return String(v ?? "").trim() !== "";
  });
}

/* ---------------- Sending ---------------- */

interface Sub { endpoint: string; p256dh: string; auth: string; prefs: Record<string, unknown> | null; user_id: string }

async function crewSubs(tourId: string, ownerId: string): Promise<Sub[]> {
  const { data: members } = await admin.from("members").select("user_id").eq("tour_id", tourId);
  const ids = [ownerId, ...(members ?? []).map((m) => m.user_id).filter(Boolean)];
  const { data: subs } = await admin.from("push_subs").select("endpoint, p256dh, auth, prefs, user_id").in("user_id", ids);
  return (subs ?? []) as Sub[];
}
async function push(subs: Sub[], body: string, tourId: string): Promise<number> {
  let sent = 0;
  const dead: string[] = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: "Ari", body, tourId }));
      sent += 1;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode ?? 0;
      if (code === 404 || code === 410) dead.push(s.endpoint);
    }
  }
  if (dead.length) await admin.from("push_subs").delete().in("endpoint", dead);
  return sent;
}
const groupOf = (s: Sub): Group => {
  const g = String((s.prefs ?? {}).group ?? "all");
  return g === "crew" || g === "artist" ? g : "all";
};

// Claim the message; only the first claim for a show and kind goes out.
async function claim(tourId: string, showId: string, kind: string): Promise<boolean> {
  const { data, error } = await admin.from("ari_sent")
    .upsert({ tour_id: tourId, show_id: showId, kind }, { onConflict: "tour_id,show_id,kind", ignoreDuplicates: true })
    .select("kind");
  return !error && Array.isArray(data) && data.length > 0;
}

async function runTour(tour: { id: string; owner_id: string; doc: Record<string, unknown> }, now: Date, fallbackTz: string) {
  const doc = isObj(tour.doc) ? tour.doc : {};
  if (doc.deletedAt) return 0;
  const shows = isObj(doc.shows) ? Object.entries(doc.shows) : [];
  const ourBand = String(doc.ourBand || doc.artist || "").trim().toLowerCase();
  let subs: Sub[] | null = null;
  const everyone = async () => (subs ??= await crewSubs(tour.id, tour.owner_id));
  let sent = 0;

  const announce = async (showId: string, kind: "loadin" | "showtime" | "daysheet", groups: Group[]) => {
    if (!(await claim(tour.id, showId, kind))) return;
    const to = (await everyone()).filter((s) => groups.includes(groupOf(s)));
    // Phones only: the chat is for settlements and merch, not reminders.
    sent += await push(to, SAY[kind], tour.id);
  };

  for (const [showId, raw] of shows) {
    if (!isObj(raw) || !raw.date || !raw.city) continue;
    const ds = isObj(raw.daySheet) ? raw.daySheet : {};
    const hintTz = typeof ds.tz === "string" && validTz(ds.tz) ? ds.tz : fallbackTz;
    const tz = tzFor(String(raw.city), hintTz);
    const here = localNow(now, tz);

    // MERCH NUMBERS: a recent night's number came in or changed.
    const merch = num(isObj(raw.income) ? raw.income.merch : 0);
    const date = String(raw.date);
    if (merch > 0 && date <= here.date && date >= addDays(here.date, -3)) {
      const { data: prev } = await admin.from("ari_sent").select("value")
        .eq("tour_id", tour.id).eq("show_id", showId).eq("kind", "merch").maybeSingle();
      if (!prev || num(prev.value) !== merch) {
        await admin.from("ari_sent").upsert({ tour_id: tour.id, show_id: showId, kind: "merch", value: merch,
          sent_at: new Date().toISOString() }, { onConflict: "tour_id,show_id,kind" });
        const to = (await everyone()).filter((s) => (s.prefs ?? {}).merchnums === true);
        sent += await push(to, `MERCH NUMBERS! ${raw.city}: ${money(merch)} in merch.`, tour.id);
      }
    }

    // Where "now" falls on this show's day, in minutes from its midnight;
    // the small hours after it still belong to the show (a 12:30AM set).
    const nowOnShowDay = here.date === date ? here.minutes
      : here.date === addDays(date, 1) ? here.minutes + 1440 : null;
    if (nowOnShowDay == null || !hasSheet(ds)) continue;
    const onShowDay = (m: number | null) => (m == null ? null : m < 5 * 60 ? m + 1440 : m);
    const due = (at: number | null, before: number) =>
      at != null && nowOnShowDay >= at - before && nowOnShowDay < at;

    // DAY SHEET AVAILABLE: straight away when it's posted on show day;
    // a sheet posted ahead of time goes out at 9 AM that day.
    if (here.date === date) {
      const posted = num(ds.postedAt);
      const postedToday = posted > 0 && localNow(new Date(posted), tz).date === here.date;
      if (postedToday || here.minutes >= 9 * 60) await announce(showId, "daysheet", ["crew", "artist", "all"]);
    }

    // LOAD IN: 10 minutes out.
    if (due(onShowDay(minutesOf(ds.loadIn, true)), 10)) await announce(showId, "loadin", ["crew", "all"]);

    // SHOW TIME: 30 minutes before our band plays.
    const sets = Array.isArray(ds.setTimes) ? ds.setTimes : [];
    const ours = ourBand ? sets.find((r) => isObj(r) && String(r.band ?? "").trim().toLowerCase() === ourBand) : null;
    if (isObj(ours) && due(onShowDay(minutesOf(ours.time)), 30)) await announce(showId, "showtime", ["artist", "all"]);
  }
  return sent;
}

function senderOf(req: Request): string {
  try {
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const b64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return String(JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4))).sub ?? "");
  } catch { return ""; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  let body: { tourId?: string; tz?: string } = {};
  try { body = await req.json(); } catch { /* the clock sends {} */ }

  let only: string | null = null;
  const key = req.headers.get("x-cron-key");
  if (key) {
    const ok = await admin.rpc("cron_key_ok", { k: key });
    if (ok.data !== true) return reply(401, { error: "bad_key" });
  } else {
    // A member nudging their own tour (right after posting a day sheet).
    const uid = senderOf(req);
    const tourId = String(body.tourId ?? "");
    if (!uid || !tourId) return reply(401, { error: "not_signed_in" });
    const { data: t } = await admin.from("tours").select("owner_id").eq("id", tourId).maybeSingle();
    if (!t) return reply(404, { error: "no_tour" });
    if (t.owner_id !== uid) {
      const { data: m } = await admin.from("members").select("user_id").eq("tour_id", tourId).eq("user_id", uid).maybeSingle();
      if (!m) return reply(403, { error: "not_on_tour" });
    }
    only = tourId;
  }

  const fallbackTz = body.tz && validTz(body.tz) ? body.tz : "America/Chicago";
  let q = admin.from("tours").select("id, owner_id, doc");
  if (only) q = q.eq("id", only);
  const { data: tours, error } = await q;
  if (error) return reply(500, { error: "read_failed" });
  const now = new Date();
  let sent = 0;
  for (const t of tours ?? []) {
    try { sent += await runTour(t as { id: string; owner_id: string; doc: Record<string, unknown> }, now, fallbackTz); }
    catch (_) { /* one tour's trouble never stops the rest */ }
  }
  return reply(200, { sent });
});
