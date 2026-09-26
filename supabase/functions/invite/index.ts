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
  try { senderId = JSON.parse(atob(jwt.split(".")[1])).sub ?? ""; } catch { /* fall through */ }
  if (!senderId) return reply(401, { error: "not_signed_in" });

  let body: { tourId?: string; email?: string; name?: string };
  try { body = await req.json(); } catch { return reply(400, { error: "invalid" }); }
  const tourId = String(body.tourId ?? "");
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").trim().slice(0, 24);
  if (!tourId || email.indexOf("@") < 1) return reply(400, { error: "invalid" });

  // Only the tour manager may invite.
  const { data: tour } = await admin.from("tours").select("id, owner_id").eq("id", tourId).single();
  if (!tour) return reply(404, { error: "no_tour" });
  if (tour.owner_id !== senderId) return reply(403, { error: "not_manager" });

  // Create the account and send the email in one move. The username they
  // start with is the name the inviter typed; they can change it later.
  const { error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { username: name, invited: true },
  });
  if (!error) return reply(200, { status: "sent" });

  const msg = String(error.message ?? "");
  if (/already.*(registered|exists)/i.test(msg)) {
    // They have an account: the tour shows up on their next open. No email needed.
    return reply(200, { status: "existing" });
  }
  if (/rate limit|too many/i.test(msg) || (error as { status?: number }).status === 429) {
    // The free mailer allows a couple of emails an hour. The invite row still
    // stands, so signing up with this address works with or without the email.
    return reply(200, { status: "nomail" });
  }
  return reply(500, { error: "send_failed", detail: msg.slice(0, 120) });
});
