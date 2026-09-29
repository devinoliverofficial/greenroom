// The card feed. Greenroom reads the band's YNAB plan and files what the
// cards spent onto the tour that was running that day, sorted by what the app
// has already learned about each merchant. Anything it isn't sure of waits in
// the tour manager's private pile instead. Money coming in is never logged.
//
// Each tour manager connects their own YNAB through YNAB's sign-in page (see
// ynab-auth); their read-only key sits in ynab_links, which only this server
// can read, and never leaves it. That is the only way in: there is no
// hand-saved key to fall back on. Nothing here returns a balance, and a feed
// only ever files onto its own manager's tours.
import { createClient } from "npm:@supabase/supabase-js@2";
// The app's own rules, copied in by build.py so the server sorts charges the
// same way the statement importer does.
import "./lib/core.js";
import "./lib/statements.js";

// deno-lint-ignore no-explicit-any
const G = (globalThis as any).GR;
// deno-lint-ignore no-explicit-any
const GRS = (globalThis as any).GRS;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-cron-key",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

type Obj = Record<string, unknown>;

// Where YNAB sends people back to, and where they may land afterwards.
const REDIRECT = Deno.env.get("SUPABASE_URL") + "/functions/v1/ynab-auth";
const HOME = "https://devinoliverofficial.github.io/greenroom/";
const SITE = /^https:\/\/devinoliverofficial\.github\.io\/greenroom\//;
type Mode = "log" | "ask" | "off";
interface Account { name: string; type: string; mode: Mode; closed?: boolean }
interface Feed {
  owner_id: string; plan_name: string; plan_id: string;
  accounts: Record<string, Account>; switched_on: boolean;
  since: string | null; knowledge: number | null; last_run: string | null; last_status: string;
  personal_token: boolean;
  merch_account: string | null;
}

function claimsOf(jwt: string): Obj {
  try {
    const b64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)));
  } catch { return {}; }
}

class YnabError extends Error {}

/* The key for one manager's YNAB. A key from the Connect button lasts two
   hours and is renewed here, quietly, a couple of minutes before it runs out. */
async function tokenFor(feed: Feed): Promise<string> {
  const { data: link } = await admin.from("ynab_links").select("*").eq("owner_id", feed.owner_id).maybeSingle();
  if (link) {
    if (Date.parse(link.expires_at) - Date.now() > 120_000) return link.access_token;
    const r = await fetch("https://app.ynab.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: Deno.env.get("YNAB_CLIENT_ID") ?? "",
        client_secret: Deno.env.get("YNAB_CLIENT_SECRET") ?? "",
        grant_type: "refresh_token",
        refresh_token: link.refresh_token,
      }),
    });
    // Turned down: the manager disconnected Greenroom inside YNAB.
    if (r.status === 400 || r.status === 401) throw new YnabError("token_refused");
    if (!r.ok) throw new YnabError("ynab_" + r.status);
    const j = await r.json() as Obj;
    await admin.from("ynab_links").update({
      access_token: String(j.access_token),
      refresh_token: String(j.refresh_token ?? link.refresh_token),
      expires_at: new Date(Date.now() + Number(j.expires_in ?? 7200) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("owner_id", feed.owner_id);
    return String(j.access_token);
  }
  throw new YnabError("not_connected");
}

async function ynab(path: string, token: string): Promise<Obj> {
  const r = await fetch("https://api.ynab.com/v1" + path, { headers: { Authorization: "Bearer " + token } });
  if (r.status === 401) throw new YnabError("token_refused");
  if (r.status === 429) throw new YnabError("ynab_busy");
  if (!r.ok) throw new YnabError("ynab_" + r.status);
  return ((await r.json()) as Obj).data as Obj;
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Cards log on their own; bank accounts ask first, because they also pay the
// cards, the crew and each other. Loans and the like stay out entirely.
function defaultMode(type: string): Mode {
  if (type === "creditCard" || type === "lineOfCredit") return "log";
  if (type === "checking" || type === "savings" || type === "cash") return "ask";
  return "off";
}

/* Find the plan and bring the account list up to date. New accounts join
   with their default; a mode the manager picked is never overwritten. */
async function listPlans(token: string): Promise<Obj[]> {
  const data = await ynab("/plans?include_accounts=true", token);
  return (data.plans ?? []) as Obj[];
}
async function refreshPlan(feed: Feed, token: string): Promise<{ planId: string; accounts: Record<string, Account> } | null> {
  const plans = await listPlans(token);
  const plan = plans.find((p) => feed.plan_id && p.id === feed.plan_id) ??
    plans.find((p) => feed.plan_name && norm(p.name) === norm(feed.plan_name));
  if (!plan) return null;
  const accounts: Record<string, Account> = {};
  for (const a of (plan.accounts ?? []) as Obj[]) {
    if (a.deleted) continue;
    const id = String(a.id);
    const had = feed.accounts?.[id];
    accounts[id] = {
      name: String(a.name ?? ""), type: String(a.type ?? ""),
      mode: had?.mode ?? defaultMode(String(a.type ?? "")),
      closed: !!a.closed,
    };
  }
  return { planId: String(plan.id), accounts };
}

// Where merch payouts land: the manager's pick, or on first look a bank
// account with "merch" in its name.
function merchAccountFor(feed: Feed, accounts: Record<string, Account>): string {
  if (feed.merch_account != null) return feed.merch_account;
  const hit = Object.entries(accounts).find(([, a]) =>
    (a.type === "checking" || a.type === "savings") && !a.closed && /merch/i.test(a.name));
  return hit ? hit[0] : "";
}

/* A merch payout matched to the show(s) it pays for.
   - An atVenu Register payout ("AV..." on the statement) is one show's card
     sales less fees, sent two business days after that show. It matches the
     open show 1-7 days before it whose expected payout is nearest, allowing
     for card tips and late sales the Settlement doesn't show.
   - Any other deposit (a venue's check or wire) has to match within a
     dollar: one show, or a run of back-to-back shows on one tour (a weekly
     payout), from the month before it. */
interface Dep { id: string; date: string; amount: number; av?: boolean }
// atVenu pays two business days after the show (weekends skipped).
function payoutDay(showDate: string): string {
  let d = showDate, left = 2;
  while (left > 0) {
    d = G.addDays(d, 1);
    const wd = G.parseDay(d).getDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}
interface Cand { tourId: string; showId: string; date: string; due: number; known?: boolean }
function matchDeposits(deps: Dep[], cands: Cand[]): { dep: Dep; picks: Cand[] }[] {
  const used = new Set<string>();
  const out: { dep: Dep; picks: Cand[] }[] = [];
  for (const d of [...deps].sort((a, b) => a.date.localeCompare(b.date))) {
    const open = cands.filter((c) => !used.has(c.tourId + "/" + c.showId) && c.date <= d.date &&
      G.daysBetween(c.date, d.date) <= 30).sort((a, b) => a.date.localeCompare(b.date));
    let picks: Cand[] | null = null;
    if (d.av) {
      const near = open.filter((c) => {
        const gap = G.daysBetween(c.date, d.date);
        if (gap < 1 || gap > 7) return false;
        // Card figures known: close to them. Not known (logged before the
        // Settlement's card lines were read): the card payout can't be more
        // than the night's net, and is rarely under a fifth of it.
        return c.known === false
          ? d.amount <= c.due + 5 && d.amount >= c.due * 0.2
          : d.amount >= c.due * 0.85 - 5 && d.amount <= c.due * 1.35 + 5;
      }).sort((a, b) =>
        // The show whose payout day this is, first; then known card figures; then the nearest amount.
        Math.abs(G.daysBetween(payoutDay(a.date), d.date)) - Math.abs(G.daysBetween(payoutDay(b.date), d.date)) ||
        (a.known === false ? 1 : 0) - (b.known === false ? 1 : 0) ||
        Math.abs(a.due - d.amount) - Math.abs(b.due - d.amount));
      if (near.length) picks = [near[0]];
      if (picks) { used.add(picks[0].tourId + "/" + picks[0].showId); out.push({ dep: d, picks }); }
      continue;
    }
    for (const c of open) {
      if (Math.abs(c.due - d.amount) <= 1 && (!picks || c.date > picks[0].date)) picks = [c];
    }
    if (!picks) {
      search: for (let i = 0; i < open.length; i++) {
        let sum = 0;
        const run: Cand[] = [];
        for (let j = i; j < open.length && run.length < 7; j++) {
          if (open[j].tourId !== open[i].tourId) break;
          sum += open[j].due;
          run.push(open[j]);
          if (run.length > 1 && Math.abs(sum - d.amount) <= 1) { picks = run.slice(); break search; }
          if (sum > d.amount + 1) break;
        }
      }
    }
    if (picks) {
      picks.forEach((p) => used.add(p.tourId + "/" + p.showId));
      out.push({ dep: d, picks });
    }
  }
  return out;
}

// Paying off a card, moving money between accounts, YNAB's own bookkeeping.
// None of it is spending.
const NOT_SPENDING = [
  /^starting balance$/i, /reconciliation balance adjustment/i, /manual balance adjustment/i,
  /^transfer\b/i, /\btransfer (to|from)\b/i, /online (banking )?transfer/i,
  /\b(e ?payment|autopay|auto pay|pmt)\b/i, /payment.{0,12}thank/i, /\bcredit card payment\b/i,
  /\bcard ?member serv/i, /(american express|amex).{0,20}(payment|pmt|ach)/i,
  /bank of america.{0,20}(payment|pmt|credit card)/i,
];
const isNotSpending = (payee: string) => NOT_SPENDING.some((re) => re.test(payee));
const FEES = /\b(interest charge|finance charge|annual (membership )?fee|late (payment )?fee|foreign transaction fee|returned payment fee|overdraft fee|monthly (maintenance|service) fee)\b/i;

interface Tour { id: string; doc: Obj; first: string; last: string; touched: string }

// The tour running that day: first show a week out through two days after the
// last. Pre-tour prep (rehearsals, the flight to the first show) belongs to it.
function tourFor(tours: Tour[], date: string): Tour | null {
  const hits = tours.filter((t) => t.first && date >= G.addDays(t.first, -7) && date <= G.addDays(t.last, 2));
  hits.sort((a, b) => b.touched.localeCompare(a.touched));
  return hits[0] ?? null;
}

/* The sorting itself, kept free of any network or database so it can be
   exercised on made-up charges (the server's selftest). */
interface Bucket { tour: Tour; charges: Obj; total: number; n: number }
function sortTransactions(
  txs: Obj[], accounts: Record<string, Account>, tours: Tour[], labels: Obj,
  known: Map<string, string>, owner: string, now: number, merchAccount = "",
): { items: Obj[]; toFile: Map<string, Bucket>; dropped: string[]; deposits: Dep[] } {
  const items: Obj[] = [];
  const deposits: Dep[] = [];
  const toFile = new Map<string, Bucket>();
  const dropped: string[] = [];

  for (const t of txs) {
    const id = String(t.id);
    // Money into the merch account: kept only as a date and an amount, to
    // match against atVenu. Transfers between the band's own accounts aren't payouts.
    if (merchAccount && String(t.account_id) === merchAccount && !t.deleted &&
        !t.transfer_account_id && Number(t.amount) > 0) {
      // atVenu Register payouts read "AV<account name><id>" on the statement.
      const raw = String(t.import_payee_name_original ?? t.import_payee_name ?? t.payee_name ?? "").trim();
      deposits.push({ id, date: String(t.date), amount: Math.round(Number(t.amount) / 10) / 100,
        av: /^AV[A-Z0-9]/i.test(raw) || /\batvenu\b/i.test(raw) });
    }
    if (known.has(id)) {
      // Deleted or edited in YNAB after we saw it: an unfiled one leaves the
      // pile; a filed one stays, since the manager already said yes to it.
      if (t.deleted && known.get(id) === "waiting") dropped.push(id);
      continue;
    }
    if (t.deleted) continue;
    const acct = accounts[String(t.account_id)];
    const mode: Mode = acct?.mode ?? "ask";
    if (mode === "off") continue;
    if (t.transfer_account_id) continue;
    const payee = String(t.payee_name ?? t.import_payee_name ?? "").trim();
    if (isNotSpending(payee)) continue;
    const isCard = acct ? (acct.type === "creditCard" || acct.type === "lineOfCredit") : false;
    const spent = Math.round(-Number(t.amount) / 10) / 100; // milliunits -> dollars, out is positive
    if (!(spent !== 0)) continue;
    // Money into a bank account is income, and income never comes through here.
    if (spent < 0 && !isCard) continue;

    const date = String(t.date);
    const merchant = GRS.cleanMerchant(payee) || "Unknown";
    const tour = tourFor(tours, date);
    const cats = tour ? G.chargeCategoriesFor(tour.doc).map((c: Obj) => c.key) : [];
    let category: string | null = FEES.test(payee) ? "interest" : GRS.learnedCategory(labels, merchant);
    if (category && tour && cats.indexOf(category) < 0) category = null;

    const base = {
      id, owner_id: owner, tour_id: tour?.id ?? null, date, merchant,
      amount: spent, category, account: acct?.name ?? "",
    };

    // Already inside a card balance entered at the start of the tour.
    const cutoff = tour ? G.preTourCutoff(tour.doc) : null;
    if (spent > 0 && cutoff && date <= cutoff) { items.push({ ...base, why: "Before the tour", status: "skipped" }); continue; }

    // The same amount a day either side of something already on the tour (a
    // statement upload, or a cost logged by hand) is probably the same money.
    const twin = tour && spent > 0 && G.rows(tour.doc.charges).concat(G.rows(tour.doc.extras)).some((c: Obj) =>
      G.parseDay(String(c.date)) && Math.abs(G.num(c.amount) - spent) < 0.005 &&
      Math.abs(G.daysBetween(String(c.date), date)) <= 1);

    // A paid amount typed by hand may already include this charge. Only the
    // manager can say, so it waits rather than counting twice.
    const typed = category && tour ? G.num((G.normExpenses(tour.doc.expenses)[category] ?? {}).paid) : 0;
    const catLabel = typed > 0
      ? String((G.chargeCategoriesFor(tour!.doc).find((c: Obj) => c.key === category) ?? {}).label ?? category)
      : "";

    let why = "";
    if (spent < 0) why = "Refund";
    else if (!tour) why = "No tour that day";
    else if (twin) why = "Maybe already in";
    else if (typed > 0) why = "Already typed into " + catLabel;
    else if (mode === "ask") why = "From " + (acct?.name ?? "a bank account");
    else if (!category) why = "New merchant";

    if (why) { items.push({ ...base, why, status: "waiting" }); continue; }

    const bucket = toFile.get(tour!.id) ?? { tour: tour!, charges: {}, total: 0, n: 0 };
    (bucket.charges as Obj)["y" + id] = {
      date, merchant, amount: spent, category, accounted: false,
      importId: "ynab-" + now, createdAt: now + bucket.n,
    };
    bucket.total += spent; bucket.n += 1;
    toFile.set(tour!.id, bucket);
    items.push({ ...base, why: "", status: "filed" });
  }

  return { items, toFile, dropped, deposits };
}

// Open deposits against shows still waiting on merch. Returns how many shows
// it marked received.
async function settleMerch(owner: string, tours: Tour[]): Promise<number> {
  const since = G.addDays(G.ymd(new Date()), -60);
  const { data: open } = await admin.from("merch_deposits").select("id, date, amount, atvenu")
    .eq("owner_id", owner).eq("matched", false).gte("date", since);
  if (!open || !open.length) return 0;
  const cands: Cand[] = [];
  for (const t of tours) {
    for (const s of G.rows(t.doc.shows) as Obj[]) {
      if (s.merchReceived !== false || !s.loggedAt) continue;
      const due = G.merchDue(s);
      if (due > 0 && G.parseDay(String(s.date))) {
        cands.push({ tourId: t.id, showId: String(s.id), date: String(s.date), due, known: s.merchCardDeposit != null });
      }
    }
  }
  if (!cands.length) return 0;
  const hits = matchDeposits(open.map((d) => ({ id: d.id, date: String(d.date), amount: Number(d.amount), av: !!d.atvenu })), cands);
  let n = 0;
  for (const h of hits) {
    for (const p of h.picks) {
      const r = await admin.rpc("merge_show", { t_id: p.tourId, s_id: p.showId,
        patch: { merchReceived: true, merchReceivedAt: h.dep.date, merchDeposit: h.picks.length === 1 ? h.dep.amount : p.due } });
      if (!r.error) n += 1;
    }
    await admin.from("merch_deposits").update({ matched: true, tour_id: h.picks[0].tourId,
      show_ids: h.picks.map((p) => p.showId) }).eq("owner_id", owner).eq("id", h.dep.id);
  }
  return n;
}

async function syncFeed(feed: Feed, opts: { preview?: boolean } = {}): Promise<Obj> {
  const token = await tokenFor(feed);
  const plan = await refreshPlan(feed, token);
  if (!plan) {
    await admin.from("feed").update({ last_run: new Date().toISOString(), last_status: "plan_missing" })
      .eq("owner_id", feed.owner_id);
    return { ok: false, status: "plan_missing" };
  }
  if (!feed.switched_on || !feed.since) {
    await admin.from("feed").update({ plan_id: plan.planId, accounts: plan.accounts })
      .eq("owner_id", feed.owner_id);
    return { ok: true, status: "off" };
  }

  const q = "since_date=" + feed.since + (feed.knowledge ? "&last_knowledge_of_server=" + feed.knowledge : "");
  const data = await ynab("/plans/" + plan.planId + "/transactions?" + q, token);
  const txs = (data.transactions ?? []) as Obj[];

  // This manager's live tours, with their date spans.
  const { data: tourRows } = await admin.from("tours").select("id, doc, updated_at").eq("owner_id", feed.owner_id);
  const tours: Tour[] = [];
  for (const r of tourRows ?? []) {
    const doc = (r.doc ?? {}) as Obj;
    if (doc.deletedAt) continue;
    const dates = G.rows(doc.shows).map((s: Obj) => String(s.date ?? "")).filter((d: string) => G.parseDay(d)).sort();
    tours.push({ id: r.id, doc, first: dates[0] ?? "", last: dates[dates.length - 1] ?? "", touched: String(r.updated_at ?? "") });
  }

  const labels: Obj = {};
  // The feed owner's own learned categories (labels are per account).
  const { data: labelRows } = await admin.from("labels").select("id, doc").eq("owner_id", feed.owner_id);
  for (const l of labelRows ?? []) labels[l.id] = l.doc;

  const ids = txs.map((t) => String(t.id));
  const known = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: seen } = await admin.from("feed_items").select("id, status")
      .eq("owner_id", feed.owner_id).in("id", ids.slice(i, i + 200));
    for (const s of seen ?? []) known.set(s.id, s.status);
  }

  const now = Date.now();
  const merchAccount = merchAccountFor(feed, plan.accounts);
  const { items, toFile, dropped, deposits } =
    sortTransactions(txs, plan.accounts, tours, labels, known, feed.owner_id, now, merchAccount);

  const filed = items.filter((i) => i.status === "filed").length;
  const waiting = items.filter((i) => i.status === "waiting").length;
  if (opts.preview) return { ok: true, preview: true, seen: txs.length, filed, waiting };

  for (const b of toFile.values()) {
    const imp: Obj = {};
    imp["ynab-" + now] = { createdAt: now, count: b.n, total: Math.round(b.total * 100) / 100, source: "YNAB" };
    const r = await admin.rpc("file_charges", { t_id: b.tour.id, add: b.charges, imp });
    if (r.error) return { ok: false, status: "save_failed", detail: r.error.message };
  }
  for (let i = 0; i < items.length; i += 200) {
    const r = await admin.from("feed_items").upsert(items.slice(i, i + 200));
    if (r.error) return { ok: false, status: "save_failed", detail: r.error.message };
  }
  if (dropped.length) {
    await admin.from("feed_items").delete().eq("owner_id", feed.owner_id).in("id", dropped).eq("status", "waiting");
  }

  // Merch payouts: keep new ones, then try every open one against every show
  // still waiting on its deposit (merch may be logged days after it lands).
  if (deposits.length) {
    await admin.from("merch_deposits").upsert(
      deposits.map((d) => ({ owner_id: feed.owner_id, id: d.id, date: d.date, amount: d.amount, atvenu: !!d.av })),
      { onConflict: "owner_id,id", ignoreDuplicates: true });
  }
  const paid = await settleMerch(feed.owner_id, tours);

  await admin.from("feed").update({
    plan_id: plan.planId, accounts: plan.accounts, knowledge: Number(data.server_knowledge) || feed.knowledge,
    merch_account: merchAccount, last_run: new Date().toISOString(), last_status: "ok",
  }).eq("owner_id", feed.owner_id);
  return { ok: true, status: "ok", filed, waiting, merchPaid: paid };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  let body: Obj = {};
  try { body = await req.json(); } catch { /* empty is fine */ }
  const action = String(body.action ?? "");

  // The timer: every switched-on feed, and nothing else. Its key lives in
  // Vault; the database says whether this knock carries it.
  const knock = req.headers.get("x-cron-key");
  if (knock) {
    const { data: good } = await admin.rpc("cron_key_ok", { k: knock });
    if (good !== true) return reply(401, { error: "bad_key" });
    // YNAB feeds only; a feed moved to Plaid is the plaid function's.
    const { data: feeds } = await admin.from("feed").select("*").eq("switched_on", true).eq("source", "ynab");
    const out: string[] = [];
    for (const f of (feeds ?? []) as Feed[]) {
      // Opening the app may have just done this.
      if (f.last_run && Date.now() - Date.parse(f.last_run) < 10 * 60_000) { out.push("recent"); continue; }
      try { out.push(String((await syncFeed(f)).status)); }
      catch (e) {
        const status = e instanceof YnabError ? e.message : "failed";
        await admin.from("feed").update({ last_run: new Date().toISOString(), last_status: status }).eq("owner_id", f.owner_id);
        out.push(status);
      }
    }
    return reply(200, { ran: out.length, results: out });
  }

  // Supabase has already verified this token; we only read who it belongs to.
  const claims = claimsOf((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  const server = claims.role === "service_role";
  const uid = String(claims.sub ?? "");

  // The sorting run on made-up charges: no YNAB, no database, nothing saved.
  if (action === "selftest") {
    if (!server) return reply(403, { error: "not_allowed" });
    const accounts: Record<string, Account> = {
      card: { name: "Test card", type: "creditCard", mode: "log" },
      bank: { name: "Test bank", type: "checking", mode: "ask" },
      gone: { name: "Test off", type: "checking", mode: "off" },
    };
    const doc = {
      shows: { s1: { date: "2026-09-22" }, s2: { date: "2026-10-26" } },
      charges: { c1: { date: "2026-09-24", amount: 212.4, merchant: "Hotel Van Zandt", category: "hotels" } },
      expenses: { bus: { projected: 35000, paid: 35000 }, gas: { projected: 3000, paid: 0 } },
      extras: { e1: { date: "2026-09-25", amount: 40, label: "Food" } },
    };
    const tours: Tour[] = [{ id: "t", doc, first: "2026-09-22", last: "2026-10-26", touched: "" }];
    const labels = { shell: { merchant: "Shell", cats: { gas: 2 } }, "premier coaches": { merchant: "Premier Coaches", cats: { bus: 1 } } };
    const tx = (id: string, account: string, amount: number, payee: string, date = "2026-09-25", extra: Obj = {}) =>
      ({ id, account_id: account, amount, payee_name: payee, date, deleted: false, transfer_account_id: null, ...extra });
    const txs = [
      tx("gas", "card", -45000, "Shell"),
      tx("new", "card", -64120, "BUC-EE'S #22 TX"),
      tx("twin", "card", -212400, "Hotel Van Zandt"),
      tx("refund", "card", 120000, "Marriott"),
      tx("cardpay_in", "card", 900000, "Payment Thank You - Web"),
      tx("cardpay_out", "bank", -900000, "AMEX EPAYMENT ACH PMT"),
      tx("bank_buy", "bank", -89990, "Guitar Center"),
      tx("income", "bank", 3915000, "atVenu Settlement"),
      tx("transfer", "bank", -50000, "Transfer : Merch", "2026-09-25", { transfer_account_id: "card" }),
      tx("opening", "card", -1500000, "Starting Balance"),
      tx("interest", "card", -23110, "Interest Charge on Purchases"),
      tx("ignored", "gone", -10000, "Anything"),
      tx("no_tour", "card", -30000, "Shell", "2026-08-01"),
      tx("deleted", "card", -30000, "Shell", "2026-09-25", { deleted: true }),
      tx("bus_paid_by_hand", "card", -12000000, "Premier Coaches"),
      tx("dinner_logged_by_hand", "card", -40000, "Shell", "2026-09-26"),
    ];
    const r = sortTransactions(txs, accounts, tours, labels, new Map(), "o", 1, "bank");
    const cands: Cand[] = [
      { tourId: "t", showId: "austin", date: "2026-09-22", due: 900 },
      { tourId: "t", showId: "dallas", date: "2026-09-23", due: 1250.5 },
      { tourId: "t", showId: "houston", date: "2026-09-24", due: 610 },
      { tourId: "t", showId: "tulsa", date: "2026-08-01", due: 777 },
    ];
    const deps: Dep[] = [
      { id: "one", date: "2026-09-25", amount: 900.4 },      // Austin alone
      { id: "week", date: "2026-09-28", amount: 1860.5 },    // Dallas + Houston together
      { id: "stale", date: "2026-09-28", amount: 777 },      // Tulsa, but two months old
      { id: "stray", date: "2026-09-28", amount: 55 },       // nothing like it
    ];
    // atVenu payouts: card sales less fees, two business days after each show,
    // a little over the Settlement when fans tipped.
    const avCands: Cand[] = [
      { tourId: "t", showId: "raleigh", date: "2026-09-23", due: 2335.8 },
      { tourId: "t", showId: "johnson", date: "2026-09-24", due: 1480.1 },
      { tourId: "t", showId: "tonight", date: "2026-09-29", due: 1900 },
      { tourId: "t", showId: "oldstyle", date: "2026-09-30", due: 3150, known: false },  // net only
    ];
    const avDeps: Dep[] = [
      { id: "av_raleigh", date: "2026-09-25", amount: 2361.4, av: true },   // + tips
      { id: "av_johnson", date: "2026-09-28", amount: 1480.1, av: true },   // over a weekend
      { id: "av_toosoon", date: "2026-09-29", amount: 1900, av: true },     // same day as the show: not yet
      { id: "av_oldstyle", date: "2026-10-02", amount: 2210, av: true },    // under the net, 2 days on
    ];
    return reply(200, {
      sorted: Object.fromEntries(r.items.map((i) => [i.id, [i.status, i.why || i.category]])),
      ignored: txs.map((t) => t.id).filter((id) => !r.items.some((i) => i.id === id)),
      merchDepositsSeen: r.deposits.map((d) => d.id),
      matched: Object.fromEntries(matchDeposits(deps, cands).map((m) => [m.dep.id, m.picks.map((p) => p.showId)])),
      avMatched: Object.fromEntries(matchDeposits(avDeps, avCands).map((m) => [m.dep.id, m.picks.map((p) => p.showId)])),
    });
  }

  // Connect YNAB: hand back the address of YNAB's own sign-in page. The trip
  // carries a one-time ticket (state) and a PKCE proof, both checked by
  // ynab-auth when YNAB sends the manager back.
  if (action === "connect") {
    if (server || !uid) return reply(401, { error: "not_signed_in" });
    const clientId = Deno.env.get("YNAB_CLIENT_ID");
    if (!clientId || !Deno.env.get("YNAB_CLIENT_SECRET")) return reply(200, { ok: false, status: "not_set_up" });
    // Only accounts on the approved list, and only someone who runs a tour.
    const { data: ok } = await admin.from("ynab_allowed").select("owner_id").eq("owner_id", uid).maybeSingle();
    if (!ok) return reply(403, { error: "not_allowed" });
    const { data: owns } = await admin.from("tours").select("id").eq("owner_id", uid).limit(1);
    if (!owns || !owns.length) return reply(403, { error: "not_manager" });
    const rand = (n: number) => {
      const b = crypto.getRandomValues(new Uint8Array(n));
      return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const state = rand(24);
    const verifier = rand(48);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const back = String(body.back ?? "");
    await admin.from("ynab_states").delete().lt("created_at", new Date(Date.now() - 3600_000).toISOString());
    await admin.from("ynab_states").insert({ state, owner_id: uid, verifier, back: SITE.test(back) ? back : HOME });
    const q = new URLSearchParams({
      client_id: clientId, redirect_uri: REDIRECT, response_type: "code", scope: "read-only",
      state, code_challenge: challenge, code_challenge_method: "S256",
    });
    return reply(200, { ok: true, url: "https://app.ynab.com/oauth/authorize?" + q.toString() });
  }

  // Everything else acts on one manager's feed: their own, or (for the server)
  // one named by owner. Anyone without a feed row gets nothing.
  const owner = server ? String(body.owner ?? "") : uid;
  if (!owner) return reply(401, { error: "not_signed_in" });
  const { data: row } = await admin.from("feed").select("*").eq("owner_id", owner).maybeSingle();
  if (!row || (row as { source?: string }).source === "plaid") return reply(403, { error: "no_feed" });
  const feed = row as Feed;

  // Disconnect: the key is deleted on the spot, along with the pile.
  // Charges already filed on a tour stay; they belong to the tour now.
  if (action === "disconnect") {
    if (server) return reply(403, { error: "manager_only" });
    await admin.from("ynab_links").delete().eq("owner_id", owner);
    await admin.from("feed_items").delete().eq("owner_id", owner);
    await admin.from("feed").delete().eq("owner_id", owner);
    return reply(200, { ok: true });
  }

  try {
    if (action === "status") {
      const token = await tokenFor(feed);
      const plan = (feed.plan_id || feed.plan_name) ? await refreshPlan(feed, token) : null;
      if (!plan) {
        // Not picked yet, or renamed or deleted in YNAB: offer the list.
        const plans = await listPlans(token);
        return reply(200, {
          ok: true, needsPlan: true, missing: !!(feed.plan_id || feed.plan_name), plan: feed.plan_name,
          plans: plans.filter((p) => !p.deleted).map((p) => ({ id: p.id, name: p.name })),
        });
      }
      await admin.from("feed").update({ plan_id: plan.planId, accounts: plan.accounts }).eq("owner_id", owner);
      return reply(200, {
        ok: true, plan: feed.plan_name, switchedOn: feed.switched_on, since: feed.since,
        viaButton: !feed.personal_token,
        lastRun: feed.last_run, lastStatus: feed.last_status,
        accounts: Object.entries(plan.accounts).filter(([, a]) => !a.closed)
          .map(([id, a]) => ({ id, name: a.name, type: a.type, mode: a.mode })),
        merchAccount: merchAccountFor(feed, plan.accounts),
      });
    }

    if (action === "setup") {
      // The server may look, but only the manager switches the feed on or
      // changes what it files.
      if (server) return reply(403, { error: "manager_only" });
      const accounts = { ...(feed.accounts ?? {}) };
      const modes = (body.modes ?? {}) as Record<string, string>;
      for (const [id, m] of Object.entries(modes)) {
        if (accounts[id] && (m === "log" || m === "ask" || m === "off")) accounts[id] = { ...accounts[id], mode: m };
      }
      const patch: Obj = { accounts };
      if (typeof body.merchAccount === "string") {
        // '' means none; otherwise it has to be one of this plan's accounts.
        if (body.merchAccount && !accounts[body.merchAccount]) return reply(400, { error: "no_such_account" });
        patch.merch_account = body.merchAccount;
      }
      if (typeof body.plan === "string" && body.plan) {
        // A different plan starts clean: its own accounts, off until switched on.
        const plans = await listPlans(await tokenFor(feed));
        const pick = plans.find((p) => p.id === body.plan);
        if (!pick) return reply(400, { error: "no_such_plan" });
        Object.assign(patch, {
          plan_id: String(pick.id), plan_name: String(pick.name ?? ""), accounts: {},
          switched_on: false, since: null, knowledge: null, last_status: "", merch_account: null,
        });
        await admin.from("feed").update(patch).eq("owner_id", owner);
        return reply(200, { ok: true });
      }
      if (body.on === true && !feed.switched_on) {
        const since = String(body.since ?? "");
        if (!G.parseDay(since)) return reply(400, { error: "bad_since" });
        // Starting over means reading from the start date again.
        Object.assign(patch, { switched_on: true, since, knowledge: null });
      } else if (body.on === false) {
        patch.switched_on = false;
      }
      await admin.from("feed").update(patch).eq("owner_id", owner);
      return reply(200, { ok: true });
    }

    if (action === "sync") {
      if (server) {
        // The server's own test run counts and never files.
        return reply(200, await syncFeed(feed, { preview: true }));
      }
      // Opening the app nudges a sync; a minute between them is plenty.
      const last = feed.last_run ? Date.parse(feed.last_run) : 0;
      if (!body.force && Date.now() - last < 60_000) return reply(200, { ok: true, status: "recent" });
      return reply(200, await syncFeed(feed));
    }
  } catch (e) {
    const status = e instanceof YnabError ? e.message : "failed";
    await admin.from("feed").update({ last_run: new Date().toISOString(), last_status: status }).eq("owner_id", owner);
    return reply(200, { ok: false, status });
  }

  return reply(400, { error: "unknown_action" });
});
