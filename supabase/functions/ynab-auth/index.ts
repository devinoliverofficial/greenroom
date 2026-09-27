// Where YNAB sends a tour manager back after they tap Allow on YNAB's own
// page. It is reached by a plain browser redirect, so it carries no Greenroom
// sign-in; the one-time ticket (state) made by the ynab function is what
// proves who started the trip. The key YNAB hands over is stored where only
// the server can read it, and the manager lands back in Greenroom.
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const REDIRECT = Deno.env.get("SUPABASE_URL") + "/functions/v1/ynab-auth";
const HOME = "https://devinoliverofficial.github.io/greenroom/";

function land(back: string, result: string): Response {
  const u = new URL(back);
  u.searchParams.set("ynab", result);
  return new Response(null, { status: 302, headers: { Location: u.toString(), "Cache-Control": "no-store" } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  if (!state) return land(HOME, "failed");

  // Single use: the ticket is torn up whatever happens next.
  const { data: ticket } = await admin.from("ynab_states").select("*").eq("state", state).maybeSingle();
  await admin.from("ynab_states").delete().eq("state", state);
  if (!ticket || Date.now() - Date.parse(ticket.created_at) > 15 * 60_000) return land(HOME, "failed");
  const back = String(ticket.back || HOME);

  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code) return land(back, "cancelled");

  const r = await fetch("https://app.ynab.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("YNAB_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("YNAB_CLIENT_SECRET") ?? "",
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
      code,
      code_verifier: ticket.verifier,
    }),
  });
  if (!r.ok) return land(back, "failed");
  const j = await r.json() as Record<string, unknown>;
  if (!j.access_token || !j.refresh_token) return land(back, "failed");

  const saved = await admin.from("ynab_links").upsert({
    owner_id: ticket.owner_id,
    access_token: String(j.access_token),
    refresh_token: String(j.refresh_token),
    expires_at: new Date(Date.now() + Number(j.expires_in ?? 7200) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (saved.error) return land(back, "failed");

  // A feed row makes the Card feed theirs. An existing one keeps its plan and
  // choices, and stops leaning on the hand-saved personal token.
  const { data: had } = await admin.from("feed").select("owner_id").eq("owner_id", ticket.owner_id).maybeSingle();
  if (had) await admin.from("feed").update({ personal_token: false, last_status: "" }).eq("owner_id", ticket.owner_id);
  else await admin.from("feed").insert({ owner_id: ticket.owner_id });

  return land(back, "connected");
});
