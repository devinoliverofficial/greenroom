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

/* Every email that reaches the door gets a line in the log, delivered or
   not — a settlement that quietly matched nothing must still be explainable. */
async function logMail(sender: string, subject: string, status: string, detail = "") {
  try {
    await admin.from("inbox_log").insert({
      sender: sender.slice(0, 200), subject: subject.slice(0, 200),
      status: status, detail: String(detail).slice(0, 400),
    });
  } catch { /* the log is a courtesy, never the point */ }
}

interface Attachment { name: string; type: string; b64: string }
interface Mail { from: string; to: string; subject: string; text: string; attachments: Attachment[] }

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
      from: [form.get("from"), form.get("envelope[from]"), form.get("headers[From]"),
             form.get("headers[from]")].filter(Boolean).join(" "),
      to: [form.get("to"), form.get("envelope[to]"), form.get("headers[To]"),
           form.get("headers[to]")].filter(Boolean).join(" "),
      subject: String(form.get("subject") ?? form.get("headers[Subject]") ?? form.get("headers[subject]") ?? ""),
      text: String(form.get("plain") ?? form.get("text") ?? form.get("html") ?? ""),
      attachments: atts,
    };
  }
  let j: Record<string, unknown>;
  try { j = await req.json(); } catch { return null; }
  const headers = (j.headers ?? {}) as Record<string, unknown>;
  // CloudMailin capitalises header names; Postmark uses top-level keys.
  const hget = (name: string): string => {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === name) return String(v ?? "");
    }
    return "";
  };
  const env = (j.envelope ?? {}) as Record<string, unknown>;
  const rawAtts = (Array.isArray(j.Attachments) ? j.Attachments : Array.isArray(j.attachments) ? j.attachments : []) as Record<string, unknown>[];
  return {
    // Both senders matter: a forwarded settlement carries the forwarder in the
    // envelope and atVenu in the From header, and either one may be the proof.
    from: [j.From, j.from, env.from, hget("from")].filter(Boolean).join(" "),
    to: [j.To, j.to, env.to, env.recipients, hget("to")].flat().filter(Boolean).join(" "),
    subject: String(j.Subject ?? j.subject ?? hget("subject") ?? ""),
    text: String(j.TextBody ?? j.plain ?? j.HtmlBody ?? j.html ?? ""),
    attachments: rawAtts.slice(0, 6).map((a) => ({
      name: String(a.Name ?? a.file_name ?? a.fileName ?? "file"),
      type: String(a.ContentType ?? a.content_type ?? a.contentType ?? ""),
      b64: String(a.Content ?? a.content ?? ""),
    })).filter((a) => a.b64 && !/^https?:/i.test(a.b64) && a.b64.length < 11_000_000),
  };
}

/* How an atVenu Settlement is laid out (per their help center): Credit
   Card/Cash, Gross Sales (Adjusted Gross = Total Gross less card fees, tax and
   off-top costs), Settlement (the venue's cut of the Adjusted Gross; Total Due
   Artist and Total Due Venue), Final Payment (how the venue is paid) and Cash
   from Show (the cash the band holds at the end of the night). The card money
   arrives on its own: atVenu Register deposits card sales less fees two
   business days after the show, one deposit per show, named "AV...". */
function prompt(kind: "text" | "files", body: string): string {
  return [
    kind === "text"
      ? "The text below is an email — a merch report from atVenu (or a similar merch report)."
      : "The attached file(s) are a merch report from atVenu (or a similar merch report), from an email.",
    "Pull out ONLY the merch story and which show it belongs to — nothing about guarantees, back end or the promoter deal.",
    "",
    "Reply with only a JSON object in this exact shape:",
    '{"reportType":"settlement","show":{"date":"YYYY-MM-DD","venue":"","city":""},"income":{"merch":null},"cash":null,',
    ' "cards":{"receipts":null,"fee":null},"cardsBy":null,"notes":[{"label":"Merch per head","value":"$12.40"}]}',
    "",
    "Rules:",
    '- reportType: "settlement" when this is ONE show\'s Settlement (sections like Credit Card/Cash, Gross Sales,',
    '  Settlement, Final Payment, Cash from Show; subjects usually end in "Settlement"). "tour_progress" when it covers',
    '  several shows or the tour so far (Tour Progress, tour-to-date, a summary across dates). Anything else: "other".',
    '- merch: what the band keeps for the show — "Total Due Artist" (or "Net to Artist" / "Due to Artist"). If no such',
    '  line exists and the venue took no cut (0%, or nothing due to the venue), take the "Adjusted Gross" (the gross less',
    '  card fees, sales tax and off-top costs). Only if neither is printed take "Total Gross" and add a note "Gross merch".',
    '  Never compute it yourself. Never report the gross as merch when a smaller band number is printed.',
    '- cash: the "Cash from Show" total — the cash the band holds at the end of the night after paying the venue any',
    '  cash. If the venue collected the cash, 0. If there is no such line, null.',
    '- cards.receipts: the "Total CC Receipts" (credit card sales). cards.fee: the credit card "Fee ($)" amount.',
    '- cardsBy: who collected the credit cards ("Credit Cards Collected By"): "artist" or "venue".',
    "- show.date: the show's date in YYYY-MM-DD, from the report (not the email's sent date, unless nothing else is given).",
    "- Never estimate a number that is not printed.",
    "- notes may ONLY use these labels, and only when shown:",
    '  "Gross merch" (Total Gross Sales), "Venue merch cut", "Card fees", "Sales tax", "Paid to venue" (amount and how:',
    '  cash / check / to follow), "Merch per head" (dollars per attendee), "Attendance".',
    'Keep every value under a dozen words. If unreadable, reply {"show":{},"income":{},"notes":[]}.',
    kind === "text" ? "\nEmail text:\n" + body.slice(0, 40_000) : "",
  ].join("\n");
}

/* A settlement's notes laid over the night's own, one per label. */
function mergedNotes(had: unknown, notes: { label: string; value: string }[]) {
  const old = (Array.isArray(had) ? had : []) as { label: string; value: string }[];
  const seen: Record<string, boolean> = {};
  notes.forEach((n) => { seen[n.label.toLowerCase()] = true; });
  return old.filter((n) => !seen[String(n.label).toLowerCase()]).concat(notes);
}

const usd = (n: number) => "$" + n.toLocaleString("en-US",
  Number.isInteger(n) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* Ari only offers a number she can point to on the page: "3,258.54" must be
   printed in the settlement itself, not worked out. */
function printed(n: number, text: string): boolean {
  const flat = text.replace(/,/g, "");
  if (flat.includes(n.toFixed(2))) return true;
  return Number.isInteger(n) && new RegExp("(^|[^0-9.])" + n + "(?![0-9]|\\.[0-9])").test(flat);
}

/* Ari, the tour manager who reads the paperwork so nobody else has to.
   Plain words, real numbers, no lecture. */
function ariPrompt(body: string, where: string, merch: number, notes: { label: string; value: string }[], kept: number): string {
  return [
    "You are Ari, the tour manager for a touring band. A merch settlement just came in for " + where + ".",
    "Explain it to the whole crew in a group chat — the drummer, the merch kid, the guitar tech.",
    "Most of them have never read a settlement and will not ask questions if it sounds complicated.",
    "",
    kept > 0
      ? "The app did NOT change anything: $" + kept.toLocaleString("en-US") + " merch was already logged by hand for this night, " +
        "and the settlement says $" + merch.toLocaleString("en-US") + ". Say this plainly in one line so the tour manager can check which is right."
      : "What the app already logged: $" + merch.toLocaleString("en-US") + " merch (the artist's net — what the band keeps)" +
        (notes.length ? " · " + notes.map((n) => n.label + " " + n.value).join(" · ") : "") + ".",
    "",
    "Rules for your message:",
    "- Under 90 words. Short lines. No greeting, no sign-off, no emoji.",
    "- Say what sold, what the venue took and why, and what the band actually keeps.",
    "- Explain any term the moment you use it (a per head is dollars of merch per person in the room).",
    "- Use only numbers that appear in the settlement or above. Never invent one. If something is",
    "  missing or looks off, say so plainly in one line.",
    "- Say whether this night was strong, normal or soft for merch, and why, in one line.",
    "",
    "Then, on its own last line (the app reads it; the crew never sees it), write KEEPS: and the settlement's own",
    "number for what the band keeps this night, copied exactly as printed: Total Due Artist (or Net to Artist /",
    "Due to Artist), or, when the venue took no cut and there is no such line, the Adjusted Gross. Like KEEPS: 3,258.54",
    "If the settlement prints no such number, write KEEPS: none",
    "",
    "The settlement:",
    body.slice(0, 20000),
  ].join("\n");
}

function jsonOut(text: string): Record<string, unknown> {
  const m = text.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : {}; } catch { return {}; }
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// "\$3,915.00" is a number wearing clothes. Undress it before judging it.
const money = (v: unknown): number => {
  if (typeof v === "number") return v;
  const m = String(v ?? "").replace(/[^0-9.\-]/g, "");
  return m ? Number(m) : NaN;
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return ok({ status: "ignored" });
  const url = new URL(req.url);
  const want = Deno.env.get("INBOX_KEY");
  const pathKey = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const given = url.searchParams.get("key") ?? req.headers.get("x-inbox-key") ?? pathKey;
  if (given !== want) {
    // Worth recording: a stripped query string looks exactly like this.
    await logMail("", "", "bad_key", "path=" + url.pathname + " q=" + (url.search ? "yes" : "none"));
    return new Response("nope", { status: 401 });
  }

  const mail = await readMail(req);
  if (!mail) { await logMail("", "", "unreadable"); return ok({ status: "unreadable" }); }

  // Only the sources we expect may feed the books.
  const allowed = (Deno.env.get("INBOX_FROM") ?? "atvenu,devinoliverofficial@gmail.com")
    .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const from = mail.from.toLowerCase();
  if (!allowed.some((a) => from.includes(a))) {
    await logMail(mail.from, mail.subject, "sender_ignored", "allowed: " + allowed.join(","));
    return ok({ status: "sender_ignored" });
  }

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
    model: "claude-opus-5", max_tokens: 4000,
    messages: [{ role: "user", content }],
  });
  const out = jsonOut(res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join(""));
  const show = (out.show ?? {}) as Record<string, unknown>;
  const income = (out.income ?? {}) as Record<string, unknown>;
  const merch = Math.round((money(income.merch) || 0) * 100) / 100;
  const cashRead = money(out.cash);
  const cash = cashRead >= 0 ? Math.round(cashRead * 100) / 100 : NaN;
  const reportType = /progress|tour/i.test(String(out.reportType ?? "")) ? "tour_progress"
    : /settle/i.test(String(out.reportType ?? "")) ? "settlement" : "unknown";
  const cardsIn = (out.cards ?? {}) as Record<string, unknown>;
  const cardReceipts = money(cardsIn.receipts);
  const cardFee = Math.abs(money(cardsIn.fee));
  const cardsByVenue = /venue/i.test(String(out.cardsBy ?? ""));
  // atVenu Register's payout for the night: card sales less fees.
  const cardDeposit = cardReceipts >= 0 && !cardsByVenue
    ? Math.round((cardReceipts - (cardFee >= 0 ? cardFee : 0)) * 100) / 100 : NaN;
  const date = String(show.date ?? "");
  // The tour so far is not one night's merch; filing it on a show would lie.
  if (reportType === "tour_progress") {
    await logMail(mail.from, mail.subject, "tour_progress_skipped", "date=" + date);
    return ok({ status: "tour_progress_skipped" });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(merch > 0)) {
    await logMail(mail.from, mail.subject, "nothing_found", "date=" + date + " merch=" + merch);
    return ok({ status: "nothing_found" });
  }
  const notes = (Array.isArray(out.notes) ? out.notes : []).slice(0, 8)
    .map((n) => ({ label: String((n as Record<string, unknown>).label ?? "").slice(0, 40),
                   value: String((n as Record<string, unknown>).value ?? "").slice(0, 120) }))
    .filter((n) => n.label && n.value);

  // A settlement sent to the tour's own address names its tour outright.
  // Everything else falls back to matching the date across the live tours.
  const tagged = (mail.to.match(/\+([A-Za-z0-9]{6,40})@/) ?? [])[1] ?? "";

  const { data: tours } = await admin.from("tours").select("id, owner_id, updated_at, doc");
  type Hit = { id: string; owner: string; doc: Record<string, unknown>; showId: string; score: number; touched: string };
  const hits: Hit[] = [];
  for (const t of tours ?? []) {
    const doc = (t.doc ?? {}) as Record<string, unknown>;
    // A tour in Recently deleted is not where tonight's money goes.
    if (doc.deletedAt) continue;
    if (tagged && t.id !== tagged) continue;
    const shows = (doc.shows ?? {}) as Record<string, Record<string, unknown>>;
    for (const [sid, s] of Object.entries(shows)) {
      if (String(s.date ?? "") !== date) continue;
      let score = 1;
      if (norm(show.venue) && norm(s.venue).includes(norm(show.venue))) score += 2;
      if (norm(show.city) && norm(s.city).includes(norm(show.city).split(" ")[0])) score += 1;
      hits.push({ id: t.id, owner: t.owner_id, doc, showId: sid, score,
                  touched: String(t.updated_at ?? "") });
    }
  }
  // Keep the report itself, matched or not, for its tour manager: Refresh
  // lays these back onto a tour. The owner is whoever runs the tour it was
  // sent to (or the one it matched).
  let reportOwner = hits.length ? hits.sort((a, b) => b.score - a.score)[0].owner : "";
  if (!reportOwner && tagged) {
    const { data: tg } = await admin.from("tours").select("owner_id").eq("id", tagged).maybeSingle();
    reportOwner = tg?.owner_id ?? "";
  }
  if (reportOwner) {
    const kept = await admin.from("merch_reports").upsert({
      owner_id: reportOwner, tour_tag: tagged || null, date,
      venue: String(show.venue ?? "").slice(0, 120), city: String(show.city ?? "").slice(0, 120),
      merch, cash: cash >= 0 ? cash : null, notes, received_at: new Date().toISOString(),
      report_type: reportType, card_receipts: cardReceipts >= 0 ? cardReceipts : null,
      card_fee: cardFee >= 0 ? cardFee : null,
    }, { onConflict: "owner_id,date,merch" });
    if (kept.error) await logMail(mail.from, mail.subject, "report_not_kept", kept.error.message);
  }

  if (!hits.length) {
    await logMail(mail.from, mail.subject, "no_matching_show",
      "date=" + date + " venue=" + String(show.venue ?? "") + " merch=" + merch +
      (tagged ? " tour=" + tagged : " (no tour tag)"));
    return ok({ status: "no_matching_show", date });
  }
  // Same date on two tours? The one being worked in wins — a copy nobody has
  // opened in days is not where tonight's settlement belongs.
  hits.sort((a, b) => (b.score - a.score) || b.touched.localeCompare(a.touched));
  const hit = hits[0];
  const doc = hit.doc;
  const shows = doc.shows as Record<string, Record<string, unknown>>;
  const s = shows[hit.showId];

  // Seen this settlement before? File it once.
  const stamp = "em-" + date + "-" + Math.round(merch * 100);
  const imports = (doc.imports ?? {}) as Record<string, unknown>;
  if (imports[stamp]) { await logMail(mail.from, mail.subject, "duplicate", stamp); return ok({ status: "duplicate" }); }
  imports[stamp] = { createdAt: Date.now(), count: 1, total: merch, source: "atVenu email" };
  doc.imports = imports;

  const inc = (s.income ?? {}) as Record<string, unknown>;
  const had = Math.round(Number(inc.merch ?? 0) * 100) / 100;
  let note: string;
  const where = String(s.city ?? s.venue ?? date);
  if (had > 0 && had !== merch) {
    // A human already wrote a different number. Humans win; the chat hears about it.
    note = `atVenu settlement for ${where}: says $${merch.toLocaleString("en-US")} merch, but $${had.toLocaleString("en-US")} is already logged. I left it as is. Check which one is right.`;
  } else {
    inc.merch = merch;
    s.income = inc;
    if (!s.loggedAt) s.loggedAt = Date.now();
    // The cash stays with the band; the rest is a deposit on its way, and the
    // show stays owed (red on the Budget tab) until it lands.
    if (cash >= 0) s.merchCash = Math.min(cash, merch);
    if (cardDeposit >= 0) s.merchCardDeposit = cardDeposit;
    else if (cardsByVenue) s.merchCardDeposit = null;
    const due = cardDeposit >= 0 ? cardDeposit : Math.round((merch - Number(s.merchCash ?? 0)) * 100) / 100;
    if (s.merchReceived !== true) s.merchReceived = due > 0 ? false : true;
    s.settlementNotes = mergedNotes(s.settlementNotes, notes);
    const ph = notes.filter((n) => /per head/i.test(n.label))[0];
    note = `atVenu settlement for ${where}: $${merch.toLocaleString("en-US")} merch logged` +
      (ph ? `, ${ph.value} per head` : "") + ". That's what the band keeps after the venue's cut.";
  }
  shows[hit.showId] = s;
  doc.shows = shows;

  const up = await admin.from("tours").update({ doc }).eq("id", hit.id);
  if (up.error) { await logMail(mail.from, mail.subject, "save_failed", up.error.message); return ok({ status: "save_failed", detail: up.error.message }); }

  await logMail(mail.from, mail.subject, "logged", hit.id + " $" + merch);

  // One message in the chat: Ari reading the paperwork out loud. If Ari
  // can't speak, the plain filing line goes out under her name instead, so
  // the chat never stays silent about money that just landed.
  const kept = had > 0 && had !== merch ? had : 0;
  const logged = kept > 0 ? kept : merch;
  // One id for her message, whichever version goes out, so her question
  // stays tied to it.
  const id = "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const say = (id: string, body: string) => admin.from("notes").insert({
    id, tour_id: hit.id, day: "chat", body, author: "Ari", added_by: hit.owner,
  });
  // When the settlement's number for the band isn't the one logged, Ari asks
  // the tour manager before anything changes (0035_ari_asks.sql). Yes applies
  // this: the settlement's number and the rest of that night, worked out the
  // same way a clean filing would.
  let asked = "";
  const ask = async (fix: number): Promise<string> => {
    if (asked || !(fix > 0) || Math.abs(fix - logged) < 0.01) return asked;
    const heldCash = cash >= 0 ? cash : typeof s.merchCash === "number" ? Number(s.merchCash) : NaN;
    const patch: Record<string, unknown> = { settlementNotes: mergedNotes(s.settlementNotes, notes) };
    if (heldCash >= 0) patch.merchCash = Math.min(heldCash, fix);
    if (cardDeposit >= 0) patch.merchCardDeposit = cardDeposit;
    else if (cardsByVenue) patch.merchCardDeposit = null;
    const due = cardDeposit >= 0 ? cardDeposit : Math.round((fix - Number(patch.merchCash ?? 0)) * 100) / 100;
    patch.received = !(due > 0);
    const put = await admin.from("ari_asks").insert({
      tour_id: hit.id, note_id: id, show_id: hit.showId, place: where, was: logged, fix, patch,
    });
    if (put.error) { await logMail(mail.from, mail.subject, "ask_failed", put.error.message); return ""; }
    asked = `\n\nWould you like me to correct this to ${usd(fix)}? Reply yes and I'll fix it.`;
    return asked;
  };
  const plain = async (why: string) => {
    const q = kept > 0 ? await ask(merch) : asked;
    await say(id, note + q);
    await logMail(mail.from, mail.subject, "ari_quiet", why);
  };
  try {
    const hasText = !!mail.text && mail.text.replace(/\s/g, "").length > 60;
    const source = hasText
      ? mail.text
      : "(the settlement came as an attachment; the numbers above are what was read from it)";
    const ari = await anthropic.messages.create({
      // Opus thinks before it answers and thinking spends this budget too —
      // 400 bought a long think and an empty message.
      model: "claude-opus-5", max_tokens: 4000,
      messages: [{ role: "user", content: ariPrompt(source, where, merch, notes, kept) }],
    });
    const raw = ari.content.filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text).join("").trim();
    // Her last line names what the band keeps, for the app only.
    const line = raw.match(/^[ \t]*KEEPS:[ \t]*(.*)$/im);
    const said = raw.replace(/^[ \t]*KEEPS:.*$/gim, "").trim();
    const read = line && !/none/i.test(line[1]) ? money(line[1]) : NaN;
    const keeps = hasText && read > 0 && printed(read, mail.text) ? Math.round(read * 100) / 100 : NaN;
    const q = await ask(keeps > 0 ? keeps : kept > 0 ? merch : NaN);
    // supabase-js hands back errors instead of throwing them, so a silent
    // Ari would otherwise look exactly like a happy one.
    const ins = said ? await say(id, said.slice(0, 1500) + q) : { error: null };
    if (!said || ins.error) {
      await plain("len=" + said.length + " stop=" + String(ari.stop_reason) + " err=" + (ins.error?.message ?? "none"));
    }
  } catch (e) {
    // The money is filed either way, but a mute Ari should never be a mystery.
    await plain("failed: " + String((e as Error)?.message ?? e));
  }

  return ok({ status: "logged", tour: hit.id, merch });
});
