// The app's mailbox. atVenu's settlement email lands here (via an inbound
// mail service webhook), Claude pulls out the merch story, and the numbers
// walk themselves onto the right show. Single-entry holds: a settlement
// seen twice is filed once, and a night someone already logged is never
// silently overwritten — the chat gets a note instead.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

interface Attachment { name: string; type: string; b64: string }
interface Mail { from: string; subject: string; text: string; attachments: Attachment[] }

/* Accept the shapes the common inbound-mail services post. */
async function readMail(req: Request): Promise<Mail | null> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
    const form = await req.formData();
    const atts: Attachment[] = [];
    for (const [k, v] of form.entries()) {
      if (v instanceof File && /^attachment/i.test(k)) {
        const buf = new Uint8Array(await v.arrayBuffer());
        if (buf.length > 8_000_000) continue;
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) {
          bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        }
        atts.push({ name: v.name, type: v.type, b64: btoa(bin) });
      }
    }
    return {
      from: String(form.get("from") ?? form.get("envelope[from]") ?? ""),
      subject: String(form.get("subject") ?? form.get("headers[subject]") ?? ""),
      text: String(form.get("plain") ?? form.get("text") ?? form.get("html") ?? ""),
      attachments: atts,
    };
  }
  let j: Record<string, unknown>;
  try { j = await req.json(); } catch { return null; }
  const headers = (j.headers ?? {}) as Record<string, unknown>;
  const rawAtts = (Array.isArray(j.Attachments) ? j.Attachments : Array.isArray(j.attachments) ? j.attachments : []) as Record<string, unknown>[];
  return {
    from: String(j.From ?? j.from ?? (j.envelope as Record<string, unknown>)?.from ?? headers.from ?? ""),
    subject: String(j.Subject ?? j.subject ?? headers.subject ?? ""),
    text: String(j.TextBody ?? j.plain ?? j.HtmlBody ?? j.html ?? ""),
    attachments: rawAtts.slice(0, 6).map((a) => ({
      name: String(a.Name ?? a.file_name ?? a.fileName ?? "file"),
      type: String(a.ContentType ?? a.content_type ?? a.contentType ?? ""),
      b64: String(a.Content ?? a.content ?? ""),
    })).filter((a) => a.b64 && a.b64.length < 11_000_000),
  };
}

function prompt(kind: "text" | "files", body: string): string {
  return [
    kind === "text"
      ? "The text below is an email — a merch summary or settlement from atVenu (or a similar merch report)."
      : "The attached file(s) are a merch summary or settlement from atVenu (or a similar merch report), from an email.",
    "Pull out ONLY the merch story and which show it belongs to — nothing about guarantees, back end or the promoter deal.",
    "",
    "Reply with only a JSON object in this exact shape:",
    '{"show":{"date":"YYYY-MM-DD","venue":"","city":""},"income":{"merch":null},"notes":[{"label":"Merch per head","value":"$12.40"}]}',
    "",
    "Rules:",
    '- merch: the merch sales total. On an atVenu summary this is the line called "Total Gross"',
    '  (sometimes "Gross Total" or "Total Sales") — take that number exactly as printed. If only an',
    '  artist-net figure after the venue cut is shown, take that instead and add a "Venue merch cut" note.',
    "- show.date: the show's date in YYYY-MM-DD, from the report (not the email's sent date, unless nothing else is given).",
    "- Never estimate a number that is not printed.",
    "- notes may ONLY use these labels, and only when shown:",
    '  "Gross merch", "Venue merch cut", "Merch per head" (dollars per attendee, shown or computable from gross and attendance), "Attendance".',
    'Keep every value under a dozen words. If unreadable, reply {"show":{},"income":{},"notes":[]}.',
    kind === "text" ? "\nEmail text:\n" + body.slice(0, 40_000) : "",
  ].join("\n");
}

function jsonOut(text: string): Record<string, unknown> {
  const m = text.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : {}; } catch { return {}; }
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

Deno.serve(async (req) => {
  if (req.method !== "POST") return ok({ status: "ignored" });
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== Deno.env.get("INBOX_KEY")) {
    return new Response("nope", { status: 401 });
  }

  const mail = await readMail(req);
  if (!mail) return ok({ status: "unreadable" });

  // Only the sources we expect may feed the books.
  const allowed = (Deno.env.get("INBOX_FROM") ?? "atvenu,devinoliverofficial@gmail.com")
    .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const from = mail.from.toLowerCase();
  if (!allowed.some((a) => from.includes(a))) return ok({ status: "sender_ignored" });

  // Ask Claude for the merch story.
  const content: Anthropic.ContentBlockParam[] = [];
  for (const a of mail.attachments) {
    if (/pdf/i.test(a.type) || /\.pdf$/i.test(a.name)) {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.b64 } });
    } else if (/^image\/(png|jpeg|webp|gif)/i.test(a.type)) {
      content.push({ type: "image", source: { type: "base64", media_type: a.type as "image/png", data: a.b64 } });
    }
  }
  const kind = content.length ? "files" : "text";
  content.push({ type: "text", text: prompt(kind, mail.text || mail.subject) });
  const res = await anthropic.messages.create({
    model: "claude-opus-5", max_tokens: 700,
    messages: [{ role: "user", content }],
  });
  const out = jsonOut(res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join(""));
  const show = (out.show ?? {}) as Record<string, unknown>;
  const income = (out.income ?? {}) as Record<string, unknown>;
  const merch = Math.round(Number(income.merch ?? 0) * 100) / 100;
  const date = String(show.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(merch > 0)) return ok({ status: "nothing_found" });
  const notes = (Array.isArray(out.notes) ? out.notes : []).slice(0, 8)
    .map((n) => ({ label: String((n as Record<string, unknown>).label ?? "").slice(0, 40),
                   value: String((n as Record<string, unknown>).value ?? "").slice(0, 120) }))
    .filter((n) => n.label && n.value);

  // Which tour is this night on?
  const { data: tours } = await admin.from("tours").select("id, owner_id, doc");
  type Hit = { id: string; owner: string; doc: Record<string, unknown>; showId: string; score: number };
  const hits: Hit[] = [];
  for (const t of tours ?? []) {
    const doc = (t.doc ?? {}) as Record<string, unknown>;
    const shows = (doc.shows ?? {}) as Record<string, Record<string, unknown>>;
    for (const [sid, s] of Object.entries(shows)) {
      if (String(s.date ?? "") !== date) continue;
      let score = 1;
      if (norm(show.venue) && norm(s.venue).includes(norm(show.venue))) score += 2;
      if (norm(show.city) && norm(s.city).includes(norm(show.city).split(" ")[0])) score += 1;
      hits.push({ id: t.id, owner: t.owner_id, doc, showId: sid, score });
    }
  }
  if (!hits.length) return ok({ status: "no_matching_show", date });
  hits.sort((a, b) => b.score - a.score);
  const hit = hits[0];
  const doc = hit.doc;
  const shows = doc.shows as Record<string, Record<string, unknown>>;
  const s = shows[hit.showId];

  // Seen this settlement before? File it once.
  const stamp = "em-" + date + "-" + Math.round(merch * 100);
  const imports = (doc.imports ?? {}) as Record<string, unknown>;
  if (imports[stamp]) return ok({ status: "duplicate" });
  imports[stamp] = { createdAt: Date.now(), count: 1, total: merch, source: "atVenu email" };
  doc.imports = imports;

  const inc = (s.income ?? {}) as Record<string, unknown>;
  const had = Math.round(Number(inc.merch ?? 0) * 100) / 100;
  let note: string;
  const where = String(s.city ?? s.venue ?? date);
  if (had > 0 && had !== merch) {
    // A human already wrote a different number. Humans win; the chat hears about it.
    note = `\u{1F4EC} atVenu settlement for ${where}: says $${merch.toLocaleString("en-US")} merch, but $${had.toLocaleString("en-US")} is already logged — left as is.`;
  } else {
    inc.merch = merch;
    s.income = inc;
    if (!s.loggedAt) s.loggedAt = Date.now();
    const old = (Array.isArray(s.settlementNotes) ? s.settlementNotes : []) as { label: string; value: string }[];
    const seen: Record<string, boolean> = {};
    notes.forEach((n) => { seen[n.label.toLowerCase()] = true; });
    s.settlementNotes = old.filter((n) => !seen[String(n.label).toLowerCase()]).concat(notes);
    const ph = notes.filter((n) => /per head/i.test(n.label))[0];
    note = `\u{1F4EC} atVenu settlement for ${where}: $${merch.toLocaleString("en-US")} merch logged` +
      (ph ? ` · ${ph.value} per head` : "") + ".";
  }
  shows[hit.showId] = s;
  doc.shows = shows;

  const up = await admin.from("tours").update({ doc }).eq("id", hit.id);
  if (up.error) return ok({ status: "save_failed", detail: up.error.message });

  await admin.from("notes").insert({
    id: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    tour_id: hit.id, day: "chat", body: note, author: "atVenu", added_by: hit.owner,
  });
  return ok({ status: "logged", tour: hit.id, merch });
});
