// The card feed, through Plaid (MODEL5). Greenroom reads what the tour
// manager's cards and bank accounts spent and files it onto the tour that was
// running that day, exactly as the YNAB feed did. Anything it isn't sure of
// waits in the manager's private pile. Money coming in is never logged.
//
// READ ONLY, by construction:
//   - A connection is made with one Plaid product: Transactions. Never Auth
//     (account and routing numbers), never Transfer or Payment Initiation.
//   - plaidCall() refuses every Plaid path that isn't on ALLOWED below. There
//     is no way in this code to ask Plaid to move money.
//   - Each connection's key is stored scrambled with PLAID_TOKEN_KEY (only in
//     this function's secrets), never returned to any phone, and removed at
//     Plaid when the manager disconnects.
//   - In test mode (PLAID_ENV=sandbox) nothing is ever filed onto a tour.
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

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } });

type Obj = Record<string, unknown>;
const ENV: "sandbox" | "production" = Deno.env.get("PLAID_ENV") === "production" ? "production" : "sandbox";
const TEST = ENV === "sandbox";

/* ---------------- Plaid, read-only ---------------- */

// The only Plaid requests this server can make. Nothing here moves money.
const ALLOWED = new Set([
  "/link/token/create",          // open Plaid's connect window
  "/link/token/get",             // ask how that window went (read-only)
  "/item/public_token/exchange", // save a new connection
  "/item/get",                   // which products a connection has
  "/item/remove",                // disconnect (Plaid deletes its key)
  "/accounts/get",               // account names and types (no balances kept)
  "/transactions/sync",          // new, changed and removed charges
  "/transactions/refresh",       // ask the bank to check now
  "/sandbox/public_token/create", // test mode only: a fake bank for the selftest
]);

class PlaidError extends Error {}

async function plaidCall(path: string, body: Obj): Promise<Obj> {
  if (!ALLOWED.has(path)) throw new PlaidError("not_allowed");
  if (path.startsWith("/sandbox/") && !TEST) throw new PlaidError("not_allowed");
  const id = Deno.env.get("PLAID_CLIENT_ID"), secret = Deno.env.get("PLAID_SECRET");
  if (!id || !secret) throw new PlaidError("not_set_up");
  const r = await fetch((TEST ? "https://sandbox.plaid.com" : "https://production.plaid.com") + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "PLAID-CLIENT-ID": id, "PLAID-SECRET": secret, "Plaid-Version": "2020-09-14" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({})) as Obj;
  if (!r.ok) throw new PlaidError(String(j.error_code || "plaid_" + r.status));
  return j;
}

/* ---------------- Connection keys, scrambled ---------------- */

async function lockKey(): Promise<CryptoKey> {
  const pass = Deno.env.get("PLAID_TOKEN_KEY") ?? "";
  if (pass.length < 12) throw new PlaidError("not_set_up");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("greenroom-plaid:" + pass));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function seal(text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await lockKey(), new TextEncoder().encode(text)));
  return b64(iv) + "." + b64(ct);
}
async function unseal(sealed: string): Promise<string> {
  const [iv, ct] = sealed.split(".");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await lockKey(), unb64(ct));
    return new TextDecoder().decode(pt);
  } catch { throw new PlaidError("lock_changed"); }  // PLAID_TOKEN_KEY isn't the one it was saved with
}

/* ---------------- The feed ---------------- */

type Mode = "log" | "ask" | "off";
// card: the manager's answer to "credit card or debit card?" (Plaid's own
// reading until then). income: which deposits to watch on a bank account.
interface Account {
  name: string; type: string; mode: Mode; item?: string; closed?: boolean;
  plaid?: string; card?: "credit" | "debit"; income?: string[]; asked?: boolean;
  owed?: number | null;   // a credit card's current balance, from the bank
}
interface Feed {
  owner_id: string; accounts: Record<string, Account>; switched_on: boolean; since: string | null;
  last_run: string | null; last_status: string; merch_account: string | null; source: string;
}
interface Item { owner_id: string; item_id: string; env: string; institution: string; token_enc: string; cursor: string | null; status: string }

// Plaid's account types in the feed's own words.
function typeOf(a: Obj): string {
  if (a.type === "credit") return "creditCard";
  if (a.type === "depository") return a.subtype === "savings" ? "savings" : "checking";
  return String(a.type ?? "other");
}
// Cards log on their own; bank accounts ask first (they also pay the cards,
// the crew and each other). Anything else stays out.
function defaultMode(type: string): Mode {
  if (type === "creditCard") return "log";
  if (type === "checking" || type === "savings") return "ask";
  return "off";
}

async function itemsFor(owner: string): Promise<Item[]> {
  const { data } = await admin.from("plaid_items").select("*").eq("owner_id", owner).eq("env", ENV);
  return (data ?? []) as Item[];
}

// Bring one connection's account list up to date; a mode already picked stays.
async function accountsFor(item: Item, token: string, into: Record<string, Account>) {
  const j = await plaidCall("/accounts/get", { access_token: token });
  for (const a of (j.accounts ?? []) as Obj[]) {
    const id = String(a.account_id);
    const plaid = typeOf(a);
    const had = into[id];
    const type = cardType(plaid, had?.card);
    // A credit card's balance is what's owed on it; bank balances aren't kept.
    const cur = Number(((a.balances ?? {}) as Obj).current);
    into[id] = {
      name: [String(a.name ?? a.official_name ?? "Account"), a.mask ? "··" + a.mask : ""].filter(Boolean).join(" "),
      type, plaid, mode: had?.mode ?? defaultMode(type), item: item.item_id,
      ...(had?.card ? { card: had.card } : {}), income: had?.income ?? [], asked: had?.asked ?? false,
      owed: type === "creditCard" && isFinite(cur) ? Math.max(0, Math.round(cur * 100) / 100) : null,
    };
  }
}

// The manager's answer wins over Plaid's reading of the account.
function cardType(plaid: string, card?: string): string {
  if (card === "credit") return "creditCard";
  if (card === "debit") return plaid === "savings" ? "savings" : "checking";
  return plaid;
}
// Bank accounts marked for income, and what their deposits may be.
function incomeAccounts(accounts: Record<string, Account>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, a] of Object.entries(accounts)) {
    if (a.type === "creditCard") continue;
    const m = (a.income ?? []).includes("merch"), g = (a.income ?? []).includes("guarantees");
    if (m || g) out.set(id, m && g ? "both" : m ? "merch" : "guarantees");
  }
  return out;
}

/* One Plaid transaction in the shape the sorter reads (the YNAB shape the
   sorting was written for): amounts in thousandths, money out negative. Plaid
   says money out is positive, so the sign flips. Card payments and money
   leaving for another account are transfers, never spending. */
function asTx(t: Obj, accounts: Record<string, Account>): Obj {
  const pfc = (t.personal_finance_category ?? {}) as Obj;
  const amt = Number(t.amount) || 0;
  // A payment arriving on a card is the other half of a transfer, not a refund.
  const onCard = accounts[String(t.account_id)]?.type === "creditCard";
  const transfer = pfc.primary === "LOAN_PAYMENTS" || pfc.primary === "TRANSFER_OUT" ||
    (pfc.primary === "TRANSFER_IN" && onCard);
  // Money arriving on a card that isn't a refund: the card being paid down.
  const payment = onCard && amt < 0 && (pfc.primary === "LOAN_PAYMENTS" || pfc.primary === "TRANSFER_IN" ||
    /\bpayment\b/i.test(String(t.name || "")));
  return {
    id: String(t.transaction_id), account_id: String(t.account_id), amount: Math.round(-amt * 1000),
    payee_name: String(t.merchant_name || t.name || ""), import_payee_name_original: String(t.name || ""),
    date: String(t.date), deleted: false, transfer_account_id: transfer || payment ? "transfer" : null,
    payment,
  };
}

/* ---------------- The sorting (the YNAB feed's, unchanged) ---------------- */

interface Dep { id: string; date: string; amount: number; av?: boolean; watch?: string }
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
        return c.known === false
          ? d.amount <= c.due + 5 && d.amount >= c.due * 0.2
          : d.amount >= c.due * 0.85 - 5 && d.amount <= c.due * 1.35 + 5;
      }).sort((a, b) =>
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

const NOT_SPENDING = [
  /^starting balance$/i, /reconciliation balance adjustment/i, /manual balance adjustment/i,
  /^transfer\b/i, /\btransfer (to|from)\b/i, /online (banking )?transfer/i,
  /\b(e ?payment|autopay|auto pay|pmt)\b/i, /payment.{0,12}thank/i, /\bcredit card payment\b/i,
  /\bcard ?member serv/i, /(american express|amex).{0,20}(payment|pmt|ach)/i,
  /bank of america.{0,20}(payment|pmt|credit card)/i,
];
const isNotSpending = (payee: string) => NOT_SPENDING.some((re) => re.test(payee));
const FEES = /\b(interest charge|finance charge|annual (membership )?fee|late (payment )?fee|foreign transaction fee|returned payment fee|overdraft fee|monthly (maintenance|service) fee)\b/i;

// A tour takes charges only between the logging dates its manager chose
// (G.cardWindow). Outside every tour's dates, a charge isn't logged at all.
interface Tour { id: string; doc: Obj; win: { from: string; to: string } | null }
function toursOn(tours: Tour[], date: string): Tour[] {
  return tours.filter((t) => t.win && date >= t.win.from && date <= t.win.to);
}

interface Bucket { tour: Tour; charges: Obj; total: number; n: number }
function sortTransactions(
  txs: Obj[], accounts: Record<string, Account>, tours: Tour[], labels: Obj,
  known: Map<string, string>, owner: string, now: number, income = new Map<string, string>(),
): { items: Obj[]; toFile: Map<string, Bucket>; dropped: string[]; deposits: Dep[]; payments: Dep[] } {
  const items: Obj[] = [];
  const deposits: Dep[] = [];
  const payments: Dep[] = [];
  const toFile = new Map<string, Bucket>();
  const dropped: string[] = [];

  for (const t of txs) {
    const id = String(t.id);
    const watch = income.get(String(t.account_id));
    if (watch && !t.deleted && !t.transfer_account_id && Number(t.amount) > 0) {
      const raw = String(t.import_payee_name_original ?? t.payee_name ?? "").trim();
      deposits.push({ id, date: String(t.date), amount: Math.round(Number(t.amount) / 10) / 100,
        av: /^AV[A-Z0-9]/i.test(raw) || /\batvenu\b/i.test(raw), watch });
    }
    if (t.payment && !t.deleted && Number(t.amount) > 0) {
      payments.push({ id, date: String(t.date), amount: Math.round(Number(t.amount) / 10) / 100, watch: String(t.account_id) });
    }
    if (known.has(id)) {
      if (t.deleted && known.get(id) === "waiting") dropped.push(id);
      continue;
    }
    if (t.deleted) continue;
    const acct = accounts[String(t.account_id)];
    const mode: Mode = acct?.mode ?? "ask";
    if (mode === "off") continue;
    if (t.transfer_account_id) continue;
    const payee = String(t.payee_name ?? "").trim();
    if (isNotSpending(payee) || isNotSpending(String(t.import_payee_name_original ?? ""))) continue;
    const isCard = acct ? acct.type === "creditCard" : false;
    const spent = Math.round(-Number(t.amount) / 10) / 100;
    if (!(spent !== 0)) continue;
    if (spent < 0 && !isCard) continue;

    const date = String(t.date);
    const hits = toursOn(tours, date);
    if (!hits.length) continue;
    // Two tours logging the same day: the manager picks.
    const tour = hits.length === 1 ? hits[0] : null;
    const merchant = GRS.cleanMerchant(payee) || "Unknown";
    const cats = tour ? G.chargeCategoriesFor(tour.doc).map((c: Obj) => c.key) : [];
    let category: string | null = FEES.test(payee) ? "interest" : GRS.learnedCategory(labels, merchant);
    if (category && tour && cats.indexOf(category) < 0) category = null;

    const base = { id, owner_id: owner, tour_id: tour?.id ?? null, date, merchant, amount: spent, category, account: acct?.name ?? "" };
    const cutoff = tour ? G.preTourCutoff(tour.doc) : null;
    if (spent > 0 && cutoff && date <= cutoff) { items.push({ ...base, why: "Before the tour", status: "skipped" }); continue; }
    const twin = tour && spent > 0 && G.rows(tour.doc.charges).concat(G.rows(tour.doc.extras)).some((c: Obj) =>
      G.parseDay(String(c.date)) && Math.abs(G.num(c.amount) - spent) < 0.005 &&
      Math.abs(G.daysBetween(String(c.date), date)) <= 1);
    const typed = category && tour ? G.num((G.normExpenses(tour.doc.expenses)[category] ?? {}).paid) : 0;
    const catLabel = typed > 0
      ? String((G.chargeCategoriesFor(tour!.doc).find((c: Obj) => c.key === category) ?? {}).label ?? category)
      : "";

    let why = "";
    if (spent < 0) why = "Refund";
    else if (!tour) why = "Two tours that day";
    else if (twin) why = "Maybe already in";
    else if (typed > 0) why = "Already typed into " + catLabel;
    else if (mode === "ask") why = "From " + (acct?.name ?? "a bank account");
    else if (!category) why = "New merchant";

    if (why) { items.push({ ...base, why, status: "waiting" }); continue; }

    const bucket = toFile.get(tour!.id) ?? { tour: tour!, charges: {}, total: 0, n: 0 };
    (bucket.charges as Obj)["p" + id] = {
      date, merchant, amount: spent, category, accounted: false, account: acct?.name ?? "",
      importId: "cards-" + now, createdAt: now + bucket.n,
    };
    bucket.total += spent; bucket.n += 1;
    toFile.set(tour!.id, bucket);
    items.push({ ...base, why: "", status: "filed" });
  }
  return { items, toFile, dropped, deposits, payments };
}

async function settleMerch(owner: string, tours: Tour[]): Promise<number> {
  const since = G.addDays(G.ymd(new Date()), -60);
  const { data: open } = await admin.from("merch_deposits").select("id, date, amount, atvenu")
    .eq("owner_id", owner).eq("matched", false).in("watch", ["merch", "both"]).gte("date", since);
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

/* A guarantee deposit: the guarantee in full (the promoter paid the band),
   or less the booking agent's cut (the agency paid it), for one show or a
   run of shows on the same tour paid together. Exact to the dollar only,
   from a month before the show to six weeks after. A match ticks that
   show's guarantee Received. */
interface GCand { tourId: string; showId: string; date: string; full: number; net: number }
function matchGuarantees(deps: Dep[], cands: GCand[]): { dep: Dep; picks: GCand[]; net: boolean }[] {
  const used = new Set<string>();
  const out: { dep: Dep; picks: GCand[]; net: boolean }[] = [];
  const near = (c: GCand, d: Dep) => { const g = G.daysBetween(c.date, d.date); return g >= -30 && g <= 45; };
  for (const d of [...deps].sort((a, b) => a.date.localeCompare(b.date))) {
    const open = cands.filter((c) => !used.has(c.tourId + "/" + c.showId) && near(c, d))
      .sort((a, b) => a.date.localeCompare(b.date));
    let hit: { picks: GCand[]; net: boolean } | null = null;
    for (const net of [false, true]) {
      const due = (c: GCand) => net ? c.net : c.full;
      const one = open.filter((c) => Math.abs(due(c) - d.amount) <= 1)
        .sort((a, b) => Math.abs(G.daysBetween(a.date, d.date)) - Math.abs(G.daysBetween(b.date, d.date)));
      if (one.length) { hit = { picks: [one[0]], net }; break; }
      search: for (let i = 0; i < open.length; i++) {
        let sum = 0;
        const run: GCand[] = [];
        for (let j = i; j < open.length && run.length < 7; j++) {
          if (open[j].tourId !== open[i].tourId) break;
          sum += due(open[j]);
          run.push(open[j]);
          if (run.length > 1 && Math.abs(sum - d.amount) <= 1) { hit = { picks: run.slice(), net }; break search; }
          if (sum > d.amount + 1) break;
        }
      }
      if (hit) break;
    }
    if (hit) {
      hit.picks.forEach((p) => used.add(p.tourId + "/" + p.showId));
      out.push({ dep: d, ...hit });
    }
  }
  return out;
}
function agentShare(doc: Obj): number {
  const rule = ((doc.commission ?? {}) as Obj).agent as Obj | undefined;
  return rule && rule.mode === "pct" ? Math.max(0, Math.min(100, G.num(rule.value))) / 100 : 0;
}
async function settleGuarantees(owner: string, tours: Tour[]): Promise<number> {
  const since = G.addDays(G.ymd(new Date()), -90);
  const { data: open } = await admin.from("merch_deposits").select("id, date, amount, atvenu")
    .eq("owner_id", owner).eq("matched", false).eq("atvenu", false).in("watch", ["guarantees", "both"]).gte("date", since);
  if (!open || !open.length) return 0;
  const cands: GCand[] = [];
  for (const t of tours) {
    const cut = agentShare(t.doc);
    for (const s of G.rows(t.doc.shows) as Obj[]) {
      const g = G.num(((s.income ?? {}) as Obj).guarantee);
      if (!s.loggedAt || s.guaranteeReceived !== false || !(g > 0) || !G.parseDay(String(s.date))) continue;
      cands.push({ tourId: t.id, showId: String(s.id), date: String(s.date), full: g, net: Math.round(g * (1 - cut) * 100) / 100 });
    }
  }
  if (!cands.length) return 0;
  const hits = matchGuarantees(open.map((d) => ({ id: d.id, date: String(d.date), amount: Number(d.amount) })), cands);
  let n = 0;
  for (const h of hits) {
    for (const p of h.picks) {
      const r = await admin.rpc("merge_show", { t_id: p.tourId, s_id: p.showId,
        patch: { guaranteeReceived: true, guaranteeReceivedAt: h.dep.date, guaranteeDeposit: h.net ? p.net : p.full } });
      if (!r.error) n += 1;
    }
    await admin.from("merch_deposits").update({ matched: true, tour_id: h.picks[0].tourId,
      show_ids: h.picks.map((p) => p.showId) }).eq("owner_id", owner).eq("id", h.dep.id);
  }
  return n;
}

/* Payments on a card whose balance the feed read come off what's still owed
   on it: each goes to the tour entry for that card read most recently before
   the payment. Once each (by transaction). */
async function applyPayments(tours: Tour[], accounts: Record<string, Account>, pays: Dep[]): Promise<number> {
  let total = 0;
  for (const p of pays) {
    const name = accounts[String(p.watch)]?.name;
    if (!name) continue;
    let best: { tour: Tour; id: string; cutoff: string } | null = null;
    for (const t of tours) {
      for (const [id, d] of Object.entries((t.doc.debts ?? {}) as Record<string, Obj>)) {
        const f = (d?.feed ?? null) as Obj | null;
        if (!f || d.kind !== "card" || f.name !== name || !G.parseDay(String(d.cutoff))) continue;
        const cut = String(d.cutoff);
        if (cut >= p.date || ((d.payments ?? {}) as Obj)[p.id]) continue;
        if (!best || cut > best.cutoff) best = { tour: t, id, cutoff: cut };
      }
    }
    if (!best) continue;
    const r = await admin.rpc("add_card_payment", { t_id: best.tour.id, d_id: best.id, p_id: p.id,
      payment: { date: p.date, amount: p.amount } });
    if (!r.error) total += p.amount;
  }
  return Math.round(total * 100) / 100;
}

/* Owed on cards: each tour entry for a card the feed read gets the bank's
   current balance on that card, as of this refresh. */
async function markOwed(tours: Tour[], accounts: Record<string, Account>) {
  const at = new Date().toISOString();
  const byName = new Map<string, number>();
  for (const a of Object.values(accounts)) if (a.type === "creditCard" && typeof a.owed === "number") byName.set(a.name, a.owed);
  for (const t of tours) {
    for (const [id, d] of Object.entries((t.doc.debts ?? {}) as Record<string, Obj>)) {
      const f = (d?.feed ?? null) as Obj | null;
      if (!f || d.kind !== "card" || !byName.has(String(f.name))) continue;
      await admin.rpc("set_card_owed", { t_id: t.id, d_id: id, owed: { amount: byName.get(String(f.name)), at } });
    }
  }
}

async function toursOf(owner: string): Promise<Tour[]> {
  const { data: tourRows } = await admin.from("tours").select("id, doc, updated_at").eq("owner_id", owner);
  const tours: Tour[] = [];
  for (const r of tourRows ?? []) {
    const doc = (r.doc ?? {}) as Obj;
    if (doc.deletedAt) continue;
    tours.push({ id: r.id, doc, win: G.cardWindow(doc) });
  }
  return tours;
}

/* Everything new from every connection since last time. The place each
   connection has read up to (cursor) only moves once its charges are safely
   saved, and never in test mode, so nothing is skipped or read twice. */
async function pull(item: Item, token: string): Promise<{ added: Obj[]; removed: Obj[]; cursor: string | null }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const added: Obj[] = [], removed: Obj[] = [];
    let cursor = item.cursor || null;
    try {
      for (let page = 0; page < 40; page++) {
        const j = await plaidCall("/transactions/sync", {
          access_token: token, count: 500, ...(cursor ? { cursor } : {}),
          options: { include_personal_finance_category: true },
        });
        for (const t of [...(j.added ?? []) as Obj[], ...(j.modified ?? []) as Obj[]]) added.push(t);
        for (const t of (j.removed ?? []) as Obj[]) removed.push(t);
        cursor = String(j.next_cursor ?? cursor ?? "");
        if (!j.has_more) break;
      }
      return { added, removed, cursor };
    } catch (e) {
      // The bank changed things mid-read: start this connection's read over.
      if (e instanceof PlaidError && e.message === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && attempt === 0) continue;
      throw e;
    }
  }
  return { added: [], removed: [], cursor: item.cursor };
}

async function syncFeed(feed: Feed, opts: { refresh?: boolean } = {}): Promise<Obj> {
  const items = await itemsFor(feed.owner_id);
  if (!items.length) return { ok: false, status: "not_connected" };
  const accounts: Record<string, Account> = {};
  for (const [id, a] of Object.entries(feed.accounts ?? {})) accounts[id] = { ...a };
  const txs: Obj[] = [];
  const cursors = new Map<string, string | null>();
  const problems: string[] = [];

  for (const item of items) {
    try {
      const token = await unseal(item.token_enc);
      if (opts.refresh) { try { await plaidCall("/transactions/refresh", { access_token: token }); } catch { /* the regular read still runs */ } }
      await accountsFor(item, token, accounts);
      if (!feed.switched_on) continue;
      const got = await pull(item, token);
      cursors.set(item.item_id, got.cursor);
      for (const t of got.added) {
        if (t.pending) continue;                       // posted charges only
        txs.push(asTx(t, accounts));
      }
      for (const t of got.removed) txs.push({ id: String(t.transaction_id), account_id: String(t.account_id ?? ""), deleted: true, amount: 0, date: "" });
      if (item.status !== "ok") await admin.from("plaid_items").update({ status: "ok" }).eq("owner_id", item.owner_id).eq("item_id", item.item_id);
    } catch (e) {
      const code = e instanceof PlaidError ? e.message : "failed";
      problems.push(code);
      await admin.from("plaid_items").update({ status: code, updated_at: new Date().toISOString() })
        .eq("owner_id", item.owner_id).eq("item_id", item.item_id);
    }
  }

  if (!feed.switched_on) {
    await admin.from("feed").update({ accounts }).eq("owner_id", feed.owner_id);
    return { ok: true, status: "off" };
  }

  const tours = await toursOf(feed.owner_id);
  const labels: Obj = {};
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
  const { items: rows, toFile, dropped, deposits, payments } =
    sortTransactions(txs, accounts, tours, labels, known, feed.owner_id, now, incomeAccounts(accounts));
  const filed = rows.filter((i) => i.status === "filed").length;
  const waiting = rows.filter((i) => i.status === "waiting").length;

  // Test mode: say what would happen, save nothing.
  if (TEST) {
    await admin.from("feed").update({ accounts, last_run: new Date().toISOString(), last_status: problems[0] ?? "ok" })
      .eq("owner_id", feed.owner_id);
    return { ok: !problems.length, status: problems[0] ?? "ok", test: true, seen: txs.length, filed, waiting };
  }

  for (const b of toFile.values()) {
    const imp: Obj = {};
    imp["cards-" + now] = { createdAt: now, count: b.n, total: Math.round(b.total * 100) / 100, source: "Card feed" };
    const r = await admin.rpc("file_charges", { t_id: b.tour.id, add: b.charges, imp });
    if (r.error) return { ok: false, status: "save_failed" };
  }
  for (let i = 0; i < rows.length; i += 200) {
    const r = await admin.from("feed_items").upsert(rows.slice(i, i + 200));
    if (r.error) return { ok: false, status: "save_failed" };
  }
  if (dropped.length) {
    await admin.from("feed_items").delete().eq("owner_id", feed.owner_id).in("id", dropped).eq("status", "waiting");
  }
  if (deposits.length) {
    await admin.from("merch_deposits").upsert(
      deposits.map((d) => ({ owner_id: feed.owner_id, id: d.id, date: d.date, amount: d.amount, atvenu: !!d.av, watch: d.watch ?? "merch" })),
      { onConflict: "owner_id,id", ignoreDuplicates: true });
  }
  const paid = await settleMerch(feed.owner_id, tours);
  const guaranteesIn = await settleGuarantees(feed.owner_id, tours);
  const paidOff = await applyPayments(tours, accounts, payments);
  await markOwed(tours, accounts);
  // Everything is saved: now each connection's place can move on.
  for (const [itemId, cursor] of cursors) {
    await admin.from("plaid_items").update({ cursor, updated_at: new Date().toISOString() })
      .eq("owner_id", feed.owner_id).eq("item_id", itemId);
  }
  await admin.from("feed").update({
    accounts, last_run: new Date().toISOString(), last_status: problems[0] ?? "ok",
  }).eq("owner_id", feed.owner_id);
  return { ok: !problems.length, status: problems[0] ?? "ok", filed, waiting, merchPaid: paid, guaranteesIn, paidOff };
}

/* ---------------- Requests ---------------- */

function claimsOf(req: Request): Obj {
  try {
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const b = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b + "===".slice((b.length + 3) % 4)));
  } catch { return {}; }
}

// Save a new connection: swap Plaid's one-time token for the lasting key,
// lock the key away, and bring in its accounts.
async function addBank(uid: string, pub: string, name: string): Promise<string> {
  const ex = await plaidCall("/item/public_token/exchange", { public_token: pub });
  const token = String(ex.access_token), itemId = String(ex.item_id);
  const institution = name.slice(0, 80) || "Bank";
  await admin.from("plaid_items").upsert({
    owner_id: uid, item_id: itemId, env: ENV, institution, token_enc: await seal(token),
    cursor: null, status: "ok", updated_at: new Date().toISOString(),
  }, { onConflict: "owner_id,item_id" });
  const { data: row } = await admin.from("feed").select("*").eq("owner_id", uid).maybeSingle();
  // The first bank here (or the first real one after test mode) starts
  // the feed over, so nothing files until the manager has set it up.
  const others = (await itemsFor(uid)).filter((i) => i.item_id !== itemId);
  const fresh = !row || (row as Feed).source !== "plaid" || !others.length;
  const accounts: Record<string, Account> = fresh ? {} : { ...((row as Feed).accounts ?? {}) };
  await accountsFor({ item_id: itemId } as Item, token, accounts);
  if (fresh) {
    await admin.from("feed").upsert({
      owner_id: uid, source: "plaid", plan_name: "", plan_id: "", accounts, switched_on: false,
      since: null, knowledge: null, last_run: null, last_status: "", merch_account: null, personal_token: false,
    }, { onConflict: "owner_id" });
  } else {
    await admin.from("feed").update({ accounts }).eq("owner_id", uid);
  }
  return institution;
}

// Only approved accounts that run a tour may connect cards.
async function mayConnect(uid: string): Promise<boolean> {
  const { data: ok } = await admin.from("ynab_allowed").select("owner_id").eq("owner_id", uid).maybeSingle();
  if (!ok) return false;
  const { data: owns } = await admin.from("tours").select("id").eq("owner_id", uid).limit(1);
  return !!(owns && owns.length);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  let body: Obj = {};
  try { body = await req.json(); } catch { /* empty is fine */ }
  const action = String(body.action ?? "");

  // The timer: every switched-on Plaid feed.
  const knock = req.headers.get("x-cron-key");
  if (knock) {
    const { data: good } = await admin.rpc("cron_key_ok", { k: knock });
    if (good !== true) return reply(401, { error: "bad_key" });
    const { data: feeds } = await admin.from("feed").select("*").eq("source", "plaid").eq("switched_on", true);
    const out: string[] = [];
    for (const f of (feeds ?? []) as Feed[]) {
      if (f.last_run && Date.now() - Date.parse(f.last_run) < 10 * 60_000) { out.push("recent"); continue; }
      try { out.push(String((await syncFeed(f)).status)); } catch { out.push("failed"); }
    }
    return reply(200, { ran: out.length, results: out });
  }

  const claims = claimsOf(req);
  const server = claims.role === "service_role";
  const uid = String(claims.sub ?? "");

  try {
    // Test mode only, run by the server itself: a fake Plaid bank, read and
    // sorted against a made-up tour, then disconnected. Nothing is saved.
    if (action === "selftest") {
      if (!server) return reply(403, { error: "not_allowed" });
      if (!TEST) return reply(200, { ok: false, status: "production" });
      const pub = await plaidCall("/sandbox/public_token/create", { institution_id: "ins_109508", initial_products: ["transactions"] });
      const ex = await plaidCall("/item/public_token/exchange", { public_token: pub.public_token });
      const token = String(ex.access_token);
      const sealed = await seal(token);
      const roundTrip = (await unseal(sealed)) === token;
      try {
        const item = await plaidCall("/item/get", { access_token: token });
        const it = (item.item ?? {}) as Obj;
        const accounts: Record<string, Account> = {};
        await accountsFor({ item_id: String(ex.item_id) } as Item, token, accounts);
        let got = { added: [] as Obj[], removed: [] as Obj[], cursor: null as string | null };
        for (let i = 0; i < 6 && !got.added.length; i++) {
          got = await pull({ cursor: null } as Item, token);
          if (!got.added.length) await new Promise((r) => setTimeout(r, 2500));
        }
        const posted = got.added.filter((t) => !t.pending);
        const dates = posted.map((t) => String(t.date)).sort();
        const doc = { shows: { a: { date: dates[0] ?? G.ymd(new Date()) }, b: { date: dates[dates.length - 1] ?? G.ymd(new Date()) } },
          cardLog: { from: "tour", to: "tour" } };
        const tours: Tour[] = [{ id: "t", doc, win: G.cardWindow(doc) }];
        const r = sortTransactions(posted.map((t) => asTx(t, accounts)), accounts, tours, {}, new Map(), "o", 1);
        const count = (s: string) => r.items.filter((x) => x.status === s).length;
        return reply(200, {
          ok: true, env: ENV, keyLockRoundTrip: roundTrip,
          products: it.products ?? it.billed_products ?? [], availableProducts: it.available_products ?? [],
          accounts: Object.values(accounts).map((a) => a.type + " → " + a.mode),
          transactions: { posted: posted.length, pending: got.added.length - posted.length },
          sorted: { filed: count("filed"), waiting: count("waiting"), skipped: count("skipped"), ignored: posted.length - r.items.length },
          sample: r.items.slice(0, 6).map((x) => [x.date, x.merchant, x.amount, x.status, x.why || x.category]),
        });
      } finally {
        await plaidCall("/item/remove", { access_token: token }).catch(() => null);
      }
    }

    if (server || !uid) return reply(401, { error: "not_signed_in" });
    if (!Deno.env.get("PLAID_CLIENT_ID") || !Deno.env.get("PLAID_SECRET") || !Deno.env.get("PLAID_TOKEN_KEY")) {
      return reply(200, { ok: false, status: "not_set_up" });
    }

    // Open Plaid's connect window: a one-time pass for this manager, as a
    // Plaid-hosted page. The whole bank sign-in happens in that one window, so
    // it works from the home-screen app; afterwards the app asks "finish".
    // With an itemId, it reconnects that bank (after a password change, say).
    if (action === "link") {
      if (!(await mayConnect(uid))) return reply(403, { error: "not_allowed" });
      const params: Obj = {
        client_name: "Greenroom", language: "en", country_codes: ["US"],
        user: { client_user_id: uid }, hosted_link: {},
      };
      let reconnect: string | null = null;
      if (body.itemId) {
        const { data: it } = await admin.from("plaid_items").select("*").eq("owner_id", uid)
          .eq("item_id", String(body.itemId)).eq("env", ENV).maybeSingle();
        if (!it) return reply(404, { error: "no_such_bank" });
        params.access_token = await unseal((it as Item).token_enc);
        reconnect = (it as Item).item_id;
      } else {
        // Transactions only: a read-only list of charges. Cards and bank
        // accounts only; no loans or investments.
        params.products = ["transactions"];
        params.transactions = { days_requested: 180 };
        params.account_filters = {
          credit: { account_subtypes: ["credit card"] },
          depository: { account_subtypes: ["checking", "savings"] },
        };
      }
      const j = await plaidCall("/link/token/create", params);
      if (!j.hosted_link_url) return reply(200, { ok: false, status: "no_hosted_link" });
      await admin.from("plaid_pending").upsert({
        owner_id: uid, link_token: String(j.link_token), item_id: reconnect, created_at: new Date().toISOString(),
      }, { onConflict: "owner_id" });
      return reply(200, { ok: true, url: j.hosted_link_url, test: TEST });
    }

    // Back from Plaid's window: ask Plaid how it went and save any bank the
    // manager connected there. state: none | waiting | exited | connected |
    // reconnected.
    if (action === "finish") {
      const { data: p } = await admin.from("plaid_pending").select("*").eq("owner_id", uid).maybeSingle();
      if (!p) return reply(200, { ok: true, state: "none" });
      const pend = p as { link_token: string; item_id: string | null; created_at: string };
      if (Date.now() - Date.parse(pend.created_at) > 4 * 3600_000) {
        await admin.from("plaid_pending").delete().eq("owner_id", uid);
        return reply(200, { ok: true, state: "none" });
      }
      const j = await plaidCall("/link/token/get", { link_token: pend.link_token });
      const sessions = (j.link_sessions ?? []) as Obj[];
      const found = new Map<string, string>();
      let succeeded = false, exited = false;
      for (const s of sessions) {
        const res = (s.results ?? {}) as Obj;
        for (const a of (res.item_add_results ?? []) as Obj[]) {
          if (a.public_token) found.set(String(a.public_token), String(((a.institution ?? {}) as Obj).name ?? ""));
        }
        const win = s.on_success as Obj | undefined;
        if (win) {
          succeeded = true;
          const meta = (win.metadata ?? {}) as Obj;
          if (win.public_token && !found.size) {
            found.set(String(win.public_token), String(((meta.institution ?? {}) as Obj).name ?? ""));
          }
        }
        if (s.exit) exited = true;
      }
      if (pend.item_id) {
        if (!succeeded && !found.size) return reply(200, { ok: true, state: exited ? "exited" : "waiting" });
        await admin.from("plaid_pending").delete().eq("owner_id", uid);
        await admin.from("plaid_items").update({ status: "ok", updated_at: new Date().toISOString() })
          .eq("owner_id", uid).eq("item_id", pend.item_id);
        return reply(200, { ok: true, state: "reconnected" });
      }
      if (!found.size) return reply(200, { ok: true, state: exited ? "exited" : "waiting" });
      const names: string[] = [];
      for (const [pub, name] of found) names.push(await addBank(uid, pub, name));
      await admin.from("plaid_pending").delete().eq("owner_id", uid).eq("link_token", pend.link_token);
      return reply(200, { ok: true, state: "connected", institutions: names, test: TEST });
    }


    const { data: row } = await admin.from("feed").select("*").eq("owner_id", uid).maybeSingle();
    const feed = row as Feed | null;

    if (action === "status") {
      if (!feed || feed.source !== "plaid") {
        return reply(200, { ok: true, source: feed?.source ?? null, needsConnect: true, test: TEST, allowed: await mayConnect(uid) });
      }
      const items = await itemsFor(uid);
      const live = new Set(items.map((i) => i.item_id));
      const accounts = Object.entries(feed.accounts ?? {}).filter(([, a]) => !a.item || live.has(a.item));
      return reply(200, {
        ok: true, source: "plaid", test: TEST, switchedOn: feed.switched_on, since: feed.since,
        lastRun: feed.last_run, lastStatus: feed.last_status,
        banks: items.map((i) => ({ id: i.item_id, name: i.institution, status: i.status })),
        accounts: accounts.map(([id, a]) => ({ id, name: a.name, type: a.type, mode: a.mode, bank: a.item,
          card: a.card ?? (a.type === "creditCard" ? "credit" : "debit"), plaidCard: (a.plaid ?? a.type) === "creditCard" ? "credit" : "debit",
          income: a.type === "creditCard" ? [] : (a.income ?? []), asked: !!a.asked })),
        needsConnect: !items.length,
      });
    }

    if (!feed || feed.source !== "plaid") return reply(403, { error: "no_feed" });

    if (action === "setup") {
      const accounts = { ...(feed.accounts ?? {}) };
      const modes = (body.modes ?? {}) as Record<string, string>;
      for (const [id, m] of Object.entries(modes)) {
        if (accounts[id] && (m === "log" || m === "ask" || m === "off")) accounts[id] = { ...accounts[id], mode: m };
      }
      // One account's answers: credit or debit, expenses (Log / Ask me) or
      // not, and which income its deposits are.
      const ans = body.account as Obj | undefined;
      if (ans) {
        const id = String(ans.id ?? "");
        if (!accounts[id]) return reply(400, { error: "no_such_account" });
        const a: Account = { ...accounts[id] };
        if (ans.card === "credit" || ans.card === "debit") {
          a.card = ans.card;
          a.type = cardType(a.plaid ?? (a.type === "savings" ? "savings" : a.type), ans.card);
        }
        if (ans.mode === "log" || ans.mode === "ask" || ans.mode === "off") a.mode = ans.mode;
        if (Array.isArray(ans.income)) {
          a.income = [...new Set((ans.income as unknown[]).map(String).filter((k) => k === "merch" || k === "guarantees"))];
        }
        if (a.type === "creditCard") a.income = [];
        a.asked = true;
        accounts[id] = a;
      }
      const patch: Obj = { accounts };
      if (body.on === true && !feed.switched_on) {
        const since = String(body.since ?? "");
        Object.assign(patch, { switched_on: true, since: G.parseDay(since) ? since : G.ymd(new Date()) });
      } else if (body.on === false) {
        patch.switched_on = false;
      }
      // A tour's logging dates changed: read every connection from the start
      // again, so charges now inside the dates come in. Ones already brought
      // in are known and never come in twice.
      if (body.rescan === true) {
        await admin.from("plaid_items").update({ cursor: null }).eq("owner_id", uid).eq("env", ENV);
      }
      await admin.from("feed").update(patch).eq("owner_id", uid);
      return reply(200, { ok: true });
    }

    // The balance on each credit card the feed logs, read once when logging
    // starts on a tour (the phone puts it on that tour under Credit card).
    if (action === "balances") {
      const out: Obj[] = [];
      for (const it of await itemsFor(uid)) {
        try {
          const j = await plaidCall("/accounts/get", { access_token: await unseal(it.token_enc) });
          for (const a of (j.accounts ?? []) as Obj[]) {
            const mine = (feed.accounts ?? {})[String(a.account_id)];
            if (!mine || mine.type !== "creditCard" || mine.mode === "off") continue;
            const cur = Number(((a.balances ?? {}) as Obj).current);
            if (!isFinite(cur)) continue;
            out.push({ id: String(a.account_id), name: mine.name, balance: Math.max(0, Math.round(cur * 100) / 100) });
          }
        } catch { /* that bank's balance can wait */ }
      }
      return reply(200, { ok: true, test: TEST, balances: out });
    }

    if (action === "sync") {
      const last = feed.last_run ? Date.parse(feed.last_run) : 0;
      if (!body.force && Date.now() - last < 60_000) return reply(200, { ok: true, status: "recent" });
      return reply(200, await syncFeed(feed, { refresh: !!body.force }));
    }

    // Disconnect one bank (itemId) or all of them. Plaid deletes its key;
    // we delete ours. Charges already on tours stay; they're the tour's now.
    if (action === "disconnect") {
      const items = await itemsFor(uid);
      const gone = body.itemId ? items.filter((i) => i.item_id === String(body.itemId)) : items;
      for (const it of gone) {
        try { await plaidCall("/item/remove", { access_token: await unseal(it.token_enc) }); } catch { /* removed on our side regardless */ }
        await admin.from("plaid_items").delete().eq("owner_id", uid).eq("item_id", it.item_id);
      }
      const left = items.length - gone.length;
      if (!left) {
        await admin.from("feed_items").delete().eq("owner_id", uid).eq("status", "waiting");
        await admin.from("feed").delete().eq("owner_id", uid);
      } else {
        const accounts = Object.fromEntries(Object.entries(feed.accounts ?? {})
          .filter(([, a]) => !gone.some((g) => g.item_id === a.item)));
        await admin.from("feed").update({ accounts }).eq("owner_id", uid);
      }
      return reply(200, { ok: true, left });
    }
  } catch (e) {
    const status = e instanceof PlaidError ? e.message : "failed";
    return reply(200, { ok: false, status });
  }
  return reply(400, { error: "unknown_action" });
});
