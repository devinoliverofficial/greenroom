// Sends the actual invite email for a tour. The members row is written by
// the app under RLS; this function only does what the client never could —
// create the account and mail the "Accept invitation" link — using the
// service role. Caller must be the tour's owner or an editor on it.
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  let senderId = "";
  try {
    // The token's middle is base64url: - and _ instead of + and /, and no
    // padding. Plain atob throws on those, which turned nearly every sender away.
    const b64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    senderId = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4))).sub ?? "";
  } catch { /* fall through */ }
  if (!senderId) return reply(401, { error: "not_signed_in" });

  let body: {
    tourId?: string; email?: string; name?: string; first?: string; last?: string;
    tourRole?: string; phone?: string; access?: string;
  };
  try { body = await req.json(); } catch { return reply(400, { error: "invalid" }); }
  const tourId = String(body.tourId ?? "");
  const email = String(body.email ?? "").trim().toLowerCase();
  const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
  const name = clip(body.name, 60);
  const first = clip(body.first, 30) || name.split(/\s+/)[0] || "";
  const last = clip(body.last, 30) || name.split(/\s+/).slice(1).join(" ");
  if (!tourId || email.indexOf("@") < 1) return reply(400, { error: "invalid" });

  // The tour's creator or anyone with ALL ACCESS on it may invite.
  const { data: tour } = await admin.from("tours").select("id, owner_id, doc").eq("id", tourId).single();
  if (!tour) return reply(404, { error: "no_tour" });
  if (tour.owner_id !== senderId) {
    const { data: m } = await admin.from("members").select("role").eq("tour_id", tourId).eq("user_id", senderId).maybeSingle();
    if (!m || m.role !== "editor") return reply(403, { error: "not_manager" });
  }

  // Create the account and send the email in one move. Everything the
  // manager typed rides on the account, so the sign-up page only asks for a
  // username and a password. The link lands on the app itself.
  const full = [first, last].filter(Boolean).join(" ");
  const tourName = clip((tour.doc as Record<string, unknown>)?.name, 80);
  const { error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: {
      invited: true, first_name: first, last_name: last, full_name: full, username: full.slice(0, 24),
      phone: clip(body.phone, 30), tour_role: clip(body.tourRole, 40),
      access: body.access === "editor" ? "editor" : "viewer", tour_name: tourName,
    },
    redirectTo: "https://devinoliverofficial.github.io/greenroom/",
  });
  if (!error) return reply(200, { status: "sent" });

  const msg = String(error.message ?? "");
  if (/already.*(registered|exists)/i.test(msg)) {
    // They have an account: link the invite to it now, so the crew list
    // shows them as on the tour rather than Pending. No email needed.
    await admin.rpc("link_invite", { t_id: tourId, addr: email });
    return reply(200, { status: "existing" });
  }
  if (/rate limit|too many/i.test(msg) || (error as { status?: number }).status === 429) {
    // The free mailer allows a couple of emails an hour. The invite row still
    // stands, so signing up with this address works with or without the email.
    return reply(200, { status: "nomail" });
  }
  return reply(500, { error: "send_failed", detail: msg.slice(0, 120) });
});
