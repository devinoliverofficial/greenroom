// Pictures from Spotify for the pages the free roads missed. The database's
// own worker (0158/0162) walks MusicBrainz -> Wikidata -> Wikipedia and rests
// a page as 'none' when no free picture exists. This function gives those
// rested pages one more road: Spotify's artist pictures, which the database
// cannot reach itself because Spotify's token door only accepts a
// form-encoded body and pg_net cannot send one.
//
// The hour's cron taps it with the cron key (the plaid pattern). It reads
// the two Spotify keys from Vault through spotify_keys() (service role
// only), mints a fresh hour token, and for up to ten rested bare pages a
// run asks Spotify for the artist by name. Only an EXACT name match (case
// aside) is taken - a near miss would put the wrong face on a page - and
// only a picture served from Spotify's own i.scdn.co. The page then carries
// the picture with the credit "Photo: Spotify" and a link to the artist on
// Spotify, which is how their developer terms ask to be treated: their
// content named as theirs and linked home. A page with no exact match, or
// none with a picture, is marked tried and never asked about again; an
// owner's own upload always wins, as everywhere.
//
// No key in Vault: the run answers off and touches nothing.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "post_only" });

  // The cron's key or nothing: no phone has business here.
  const key = req.headers.get("x-cron-key");
  const ok = await admin.rpc("cron_key_ok", { k: key ?? "" });
  if (ok.data !== true) return reply(401, { error: "bad_key" });

  const keys = await admin.rpc("spotify_keys");
  const id = keys.data?.id ?? "";
  const secret = keys.data?.secret ?? "";
  if (!id || !secret) return reply(200, { off: true });

  // Pages the free roads rested, still nobody's, still bare, not yet tried.
  const { data: rows, error: qerr } = await admin
    .from("artist_image_queue")
    .select("artist_id, state, sp_tried, artists!inner(id, name, owner_id, avatar)")
    .eq("state", "none")
    .eq("sp_tried", false)
    .limit(10);
  if (qerr) return reply(500, { error: "queue_read" });
  const bare = (rows ?? []).filter((r: any) =>
    r.artists && r.artists.owner_id === null && (r.artists.avatar ?? "") === "" &&
    (r.artists.name ?? "").trim() !== "");
  if (!bare.length) return reply(200, { did: 0 });

  // A fresh hour token for this run; nothing stored.
  const tok = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${id}:${secret}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!tok.ok) return reply(200, { error: "token", status: tok.status });
  const bearer = (await tok.json()).access_token as string;
  if (!bearer) return reply(200, { error: "token_shape" });

  let done = 0, tried = 0;
  for (const r of bare) {
    const name = String((r as any).artists.name).trim();
    try {
      const res = await fetch(
        "https://api.spotify.com/v1/search?type=artist&limit=5&q=" + encodeURIComponent(name),
        { headers: { "Authorization": "Bearer " + bearer } });
      if (!res.ok) { await sleep(250); continue; } // turned away: not marked tried, next hour again
      const items = (await res.json())?.artists?.items ?? [];
      // The exact name or nothing: a near miss is the wrong face.
      const hit = items.find((a: any) => String(a?.name ?? "").trim().toLowerCase() === name.toLowerCase());
      const img = hit?.images?.[0]?.url ?? "";
      const home = hit?.external_urls?.spotify ?? "";
      if (hit && typeof img === "string" && img.startsWith("https://i.scdn.co/")) {
        // The last look before writing: still nobody's page, still bare.
        const up = await admin.from("artists")
          .update({ avatar: img.slice(0, 500), avatar_credit: "Photo: Spotify" })
          .eq("id", (r as any).artists.id).is("owner_id", null).eq("avatar", "");
        if (!up.error) {
          await admin.from("artist_image_queue")
            .update({ state: "done", sp_tried: true,
                      source_url: typeof home === "string" && home.startsWith("https://") ? home.slice(0, 500) : "",
                      licence: "", author: "Spotify", updated_at: new Date().toISOString() })
            .eq("artist_id", (r as any).artist_id);
          done += 1;
        }
      } else {
        await admin.from("artist_image_queue")
          .update({ sp_tried: true, updated_at: new Date().toISOString() })
          .eq("artist_id", (r as any).artist_id);
        tried += 1;
      }
    } catch (_e) {
      // One bad row never wedges the run; next hour walks it again.
    }
    await sleep(250); // polite to their door
  }
  return reply(200, { did: done, rested: tried });
});
