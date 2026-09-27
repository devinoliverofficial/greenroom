// Greenroom's reading brain: the only place the Anthropic key lives.
// The app sends a prompt (plus statement/flyer images) with the user's
// Supabase session token; Supabase verifies the JWT before we run, so only
// signed-in band members can spend credits. The key itself never reaches
// the browser.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// Supabase has verified the token; this only reads whose it is. The middle is
// base64url (- and _, no padding), which plain atob refuses.
function senderOf(req: Request): string {
  try {
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const b64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return String(JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4))).sub ?? "");
  } catch { return ""; }
}

/* Ari speaks in the chat only through here. The tour manager or ALL ACCESS
   asks; the server posts, so nobody can put words in Ari's mouth. */
async function mayPostAsAri(tourId: string, uid: string): Promise<boolean> {
  if (!tourId || !uid) return false;
  const { data: tour } = await admin.from("tours").select("owner_id").eq("id", tourId).maybeSingle();
  if (!tour) return false;
  if (tour.owner_id === uid) return true;
  const { data: m } = await admin.from("members").select("role")
    .eq("tour_id", tourId).eq("user_id", uid).maybeSingle();
  return m?.role === "editor";
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

interface ImageIn { media_type: string; data: string }
interface ReadRequest { prompt?: string; images?: ImageIn[]; tier?: string; ari?: { tourId?: string } }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  let body: ReadRequest;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "invalid_argument" });
  }

  const prompt = String(body.prompt ?? "").slice(0, 120_000);
  if (!prompt) return reply(400, { error: "invalid_argument" });

  // Asked to post Ari's reading to a tour's chat: check before spending a cent.
  const ariTour = String(body.ari?.tourId ?? "");
  const uid = senderOf(req);
  if (ariTour && !(await mayPostAsAri(ariTour, uid))) return reply(200, { error: "not_granted" });

  const images = Array.isArray(body.images) ? body.images.slice(0, 8) : [];
  for (const im of images) {
    if (!im || typeof im.data !== "string" || im.data.length > 20_000_000) {
      return reply(400, { error: "image_rejected" });
    }
  }

  // Devin's spec: merchant cleanup runs on a fast, cheap model. Everything
  // else (flyers, statement pages) gets the capable one.
  const model = body.tier === "quick" ? "claude-haiku-4-5" : "claude-opus-5";

  const content: Anthropic.ContentBlockParam[] = [
    ...images.map((im): Anthropic.ImageBlockParam => ({
      type: "image",
      source: {
        type: "base64",
        media_type: im.media_type as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
        data: im.data,
      },
    })),
    { type: "text", text: prompt },
  ];

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 8000,
      messages: [{ role: "user", content }],
    });
    if (response.stop_reason === "refusal") return reply(200, { error: "refused" });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as Anthropic.TextBlock).text)
      .join("");
    if (!text.trim()) return reply(200, { error: "empty_completion" });
    if (ariTour) {
      const ins = await admin.from("notes").insert({
        id: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        tour_id: ariTour, day: "chat", body: text.trim().slice(0, 1600), author: "Ari", added_by: uid,
      });
      if (ins.error) return reply(200, { error: "unavailable" });
    }
    return reply(200, { text });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 0;
    if (status === 429) return reply(200, { error: "rate_limited" });
    if (status === 401 || status === 403) return reply(200, { error: "not_granted" });
    if (status === 400) return reply(200, { error: "prompt_too_large" });
    return reply(200, { error: "unavailable" });
  }
});
