// Refresh atVenu: lay every atVenu report the mailbox has kept for this tour
// manager back onto one of their tours, night by night. Nothing typed by a
// human is overwritten: a night that already has a different merch number is
// left alone and counted, so the manager can check it.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

type Obj = Record<string, unknown>;
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const cents = (v: number) => Math.round(v * 100) / 100;

// Supabase has verified the token; this only reads whose it is (base64url).
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
  const uid = senderOf(req);
  if (!uid) return reply(401, { error: "not_signed_in" });
  let body: Obj = {};
  try { body = await req.json(); } catch { /* empty */ }
  if (body.action !== "refresh") return reply(400, { error: "unknown_action" });

  // Only the tour manager, on their own tour.
  const tourId = String(body.tourId ?? "");
  const { data: tour } = await admin.from("tours").select("id, owner_id, doc").eq("id", tourId).maybeSingle();
  if (!tour || tour.owner_id !== uid) return reply(403, { error: "not_manager" });
  const doc = (tour.doc ?? {}) as Obj;
  const shows = (doc.shows ?? {}) as Record<string, Obj>;

  // One report per night. A Settlement beats anything else (the newest one,
  // if atVenu re-sent a corrected copy). Older reports whose kind wasn't
  // recorded count only when they agree; two different numbers for the same
  // night (a Tour Progress summary crept in once) are left for a human.
  const { data: reports } = await admin.from("merch_reports").select("*").eq("owner_id", uid).order("received_at");
  const nights = new Map<string, Obj[]>();
  for (const r of reports ?? []) {
    const k = String(r.date);
    nights.set(k, (nights.get(k) ?? []).concat([r]));
  }
  const byDate = new Map<string, Obj>();
  let unclear = 0;
  for (const [date, rs] of nights) {
    const settled = rs.filter((r) => r.report_type === "settlement");
    if (settled.length) { byDate.set(date, settled[settled.length - 1]); continue; }
    const amounts = new Set(rs.map((r) => cents(num(r.merch))));
    if (amounts.size === 1) byDate.set(date, rs[rs.length - 1]);
    else unclear += 1;
  }

  let added = 0, same = 0, conflicts = 0, noShow = 0;
  const imports: Obj = {};
  for (const [date, r] of byDate) {
    const onDate = Object.entries(shows).filter(([, s]) => String(s.date ?? "") === date);
    if (!onDate.length) { noShow += 1; continue; }
    // Two shows the same day: the venue or city decides.
    const pick = onDate.sort(([, a], [, b]) => {
      const score = (s: Obj) => (norm(r.venue) && norm(s.venue).includes(norm(r.venue)) ? 2 : 0) +
        (norm(r.city) && norm(s.city).includes(norm(r.city).split(" ")[0]) ? 1 : 0);
      return score(b) - score(a);
    })[0];
    const [showId, s] = pick;
    const inc = (s.income ?? {}) as Obj;
    const merch = cents(num(r.merch));
    const had = cents(num(inc.merch));
    const cash = r.cash == null ? null : cents(num(r.cash));
    // atVenu Register's card payout for the night, when the Settlement showed it.
    const cardDeposit = r.card_receipts == null ? null : cents(num(r.card_receipts) - num(r.card_fee));

    if (had > 0 && Math.abs(had - merch) < 0.01) {
      // Already in. Fill in the cash and card payout if the night is missing them.
      const fill: Obj = {};
      if (cash != null && s.merchCash == null) fill.merchCash = Math.min(cash, merch);
      if (cardDeposit != null && s.merchCardDeposit == null) fill.merchCardDeposit = cardDeposit;
      if (Object.keys(fill).length) {
        await admin.rpc("merge_show", { t_id: tourId, s_id: showId, patch: fill });
        added += 1;
      } else same += 1;
      continue;
    }
    if (had > 0) { conflicts += 1; continue; }  // a human wrote a different number

    const notes = (Array.isArray(r.notes) ? r.notes : []) as { label: string; value: string }[];
    const seen: Record<string, boolean> = {};
    notes.forEach((n) => { seen[String(n.label).toLowerCase()] = true; });
    const old = (Array.isArray(s.settlementNotes) ? s.settlementNotes : []) as { label: string; value: string }[];
    const due = cardDeposit != null ? cardDeposit : cents(merch - (cash ?? 0));
    const patch: Obj = {
      income: { ...inc, merch },
      loggedAt: s.loggedAt || Date.now(),
      settlementNotes: old.filter((n) => !seen[String(n.label).toLowerCase()]).concat(notes),
      merchCash: cash != null ? Math.min(cash, merch) : null,
      merchCardDeposit: cardDeposit,
      merchReceived: s.merchReceived === true ? true : due > 0 ? false : true,
    };
    const up = await admin.rpc("merge_show", { t_id: tourId, s_id: showId, patch });
    if (up.error) continue;
    imports["em-" + date + "-" + Math.round(merch * 100)] =
      { createdAt: Date.now(), count: 1, total: merch, source: "atVenu email" };
    added += 1;
  }
  if (Object.keys(imports).length) {
    await admin.rpc("file_charges", { t_id: tourId, add: {}, imp: imports });
  }
  return reply(200, { ok: true, reports: byDate.size, added, same, conflicts, noShow, unclear });
});
