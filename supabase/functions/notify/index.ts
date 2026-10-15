// Fan-out for Greenroom notifications. A signed-in member reports an event on
// a tour ("guests added", "we're in the green", "merch milestone", "sold
// out"); this looks up everyone else on that tour who opted into that kind of
// news and web-pushes them. Senders never notify themselves.
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
    case "soldout":
      return { title: tourName, body: `${city || "Tonight"} is SOLD OUT` };
    case "alert": {
      const text = String(d.message ?? "").trim().slice(0, 200);
      return text ? { title: `\u{1F6A8} ${tourName}`, body: text } : null;
    }
    case "request": {
      // A special request on the calendar, for the tour manager to answer.
      const text = String(d.text ?? "").trim().slice(0, 140);
      const who = String(d.who ?? "Someone");
      return text ? { title: tourName, body: `${who} has a special request${city ? " for " + city : ""}: "${text}"` } : null;
    }
    default:
      return null;
  }
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
/* News about the tour's money, and a request waiting on an answer, are for
   its Managers (Devin, 2026-10-10: "In the green notifications and any
   notifications that are pertaining to the managers should only be available
   to managers of the tour"). */
const FOR_MANAGERS = ["green", "merch", "request"];

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
  const tourId = String(body.tourId ?? "");
  const type = String(body.type ?? "");
  const data = body.data ?? {};
  if (!tourId || !["guest", "green", "merch", "soldout", "alert", "request"].includes(type)) {
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
  // Only a Manager can send the tour's money news.
  if ((type === "green" || type === "merch") && !managers.has(senderId)) {
    return reply(403, { error: "not_manager" });
  }

  const tourName = cut((tour.doc as Record<string, unknown>)?.name, 80) || "Greenroom";
  if (type === "request") {
    // The asker's own name, never one sent along with the request.
    const { data: prof } = await admin.from("profiles").select("full_name, username").eq("user_id", senderId).maybeSingle();
    data.who = String(prof?.full_name || prof?.username || "Someone");
  }
  const msg = message(type, data, tourName);
  if (!msg) return reply(400, { error: "invalid" });

  // Everyone else on the tour who opted into this kind of news; money news
  // and special requests go to the tour's Managers only.
  const targets = [...memberIds].filter((id) => id !== senderId && (!FOR_MANAGERS.includes(type) || managers.has(id)));
  if (!targets.length) return reply(200, { sent: 0 });
  const { data: subs } = await admin.from("push_subs")
    .select("endpoint, p256dh, auth, prefs, user_id")
    .in("user_id", targets);

  let sent = 0;
  const dead: string[] = [];
  for (const sub of subs ?? []) {
    const prefs = (sub.prefs ?? {}) as Record<string, unknown>;
    // Each phone picks CREW, ARTIST or ALL, plus SOLD OUT and MERCH NUMBERS.
    // A phone set up before those choices counts as ALL.
    const group = String(prefs.group ?? "all");
    if (type === "alert" || type === "request") {
      // An alert, or a request waiting on an answer, ignores preferences.
    } else if (type === "soldout") {
      if (prefs.soldout !== true) continue;
    } else if (type === "merch") {
      if (prefs.merchnums !== true) continue;
    } else if (type === "green") {
      // Only the tour's Managers get it (above), whatever group their phone is on.
    } else if (group !== "all") continue;   // guest list: ALL only
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title: msg.title, body: msg.body, tourId }),
      );
      sent += 1;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode ?? 0;
      if (code === 404 || code === 410) dead.push(sub.endpoint); // device gone
    }
  }
  if (dead.length) await admin.from("push_subs").delete().in("endpoint", dead);
  return reply(200, { sent });
});
