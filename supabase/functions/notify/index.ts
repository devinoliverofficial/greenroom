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

function message(type: string, d: Record<string, unknown>, tourName: string): { title: string; body: string } | null {
  const city = String(d.city ?? "");
  switch (type) {
    case "guest":
      return { title: tourName, body: `${d.name ?? "Someone"} was added to the ${city || "show"} guest list (${d.tickets ?? 1} ticket${Number(d.tickets ?? 1) === 1 ? "" : "s"})` };
    case "green":
      return { title: tourName, body: `You're in the green — ${d.net ?? ""} and climbing 🎉` };
    case "merch":
      return { title: tourName, body: `Merch milestone: ${d.amount ?? ""} at ${city || "tonight's show"}` };
    case "soldout":
      return { title: tourName, body: `${city || "Tonight"} is SOLD OUT` };
    default:
      return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  // Who's talking? Supabase already verified the JWT; read the subject.
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  let senderId = "";
  try {
    senderId = JSON.parse(atob(jwt.split(".")[1])).sub ?? "";
  } catch { /* fall through */ }
  if (!senderId) return reply(401, { error: "not_signed_in" });

  let body: NotifyBody;
  try { body = await req.json(); } catch { return reply(400, { error: "invalid" }); }
  const tourId = String(body.tourId ?? "");
  const type = String(body.type ?? "");
  const data = body.data ?? {};
  if (!tourId || !["guest", "green", "merch", "soldout"].includes(type)) {
    return reply(400, { error: "invalid" });
  }

  // The sender must actually be on this tour.
  const { data: tour } = await admin.from("tours").select("id, owner_id, doc").eq("id", tourId).single();
  if (!tour) return reply(404, { error: "no_tour" });
  const { data: members } = await admin.from("members").select("user_id").eq("tour_id", tourId);
  const memberIds = new Set<string>([tour.owner_id, ...(members ?? []).map((m) => m.user_id).filter(Boolean)]);
  if (!memberIds.has(senderId)) return reply(403, { error: "not_on_tour" });

  const tourName = String((tour.doc as Record<string, unknown>)?.name ?? "Greenroom");
  const msg = message(type, data, tourName);
  if (!msg) return reply(400, { error: "invalid" });

  // Everyone else on the tour who opted into this kind of news.
  const targets = [...memberIds].filter((id) => id !== senderId);
  if (!targets.length) return reply(200, { sent: 0 });
  const { data: subs } = await admin.from("push_subs")
    .select("endpoint, p256dh, auth, prefs, user_id")
    .in("user_id", targets);

  let sent = 0;
  const dead: string[] = [];
  for (const sub of subs ?? []) {
    const prefs = (sub.prefs ?? {}) as Record<string, unknown>;
    if (type === "merch") {
      const threshold = Number(prefs.merch);
      if (!threshold || Number(data.amountRaw ?? 0) < threshold) continue;
    } else if (!prefs[type]) continue;
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
