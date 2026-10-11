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

// This person's bank connections. null means the list could not be read, which
// is never the same as "no bank is connected": every caller stops on null.
async function itemsFor(owner: string): Promise<Item[] | null> {
  const { data, error } = await admin.from("plaid_items").select("*").eq("owner_id", owner).eq("env", ENV);
  if (error) return null;
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
      // (Two middle dots before the last four digits, written as escapes: this file is pasted by hand, and a
      // clipboard once turned the dots themselves into other characters. See cleanName.)
      name: [String(a.name ?? a.official_name ?? "Account"), a.mask ? "\u00b7\u00b7" + a.mask : ""].filter(Boolean).join(" "),
      // (An account that already has a mode keeps it. A new one asks first: see defaultMode.)
      type, plaid, mode: had?.mode ?? (defaultMode(type) as Mode), item: item.item_id,
      ...(had?.card ? { card: had.card } : {}), income: had?.income ?? [], asked: had?.asked ?? false,
      owed: type === "creditCard" && isFinite(cur) ? Math.max(0, Math.round(cur * 100) / 100) : null,
    };
  }
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

// ---- pure:start ----
/* Everything between these two markers decides what happens to one line from
   a bank, and nothing in it reads or writes anything: no database, no network,
   no clock (the time is passed in as `now`). tools/run_feed_tests.js cuts this
   block out and runs it against thousands of made-up lines, so keep it that
   way, and keep its type notes to the six plain ones the runner knows how to
   take out (any, any[], string, number, boolean, Record of string to any).

   THE ONE RULE: store first, label second. Every posted line a bank sends
   ends as exactly one of
     - a row: waiting, filed, or left_out with its reason;
     - a line the app already holds ("already here");
     - a count in the ledger, with no row: an account that is switched off,
       or money coming in on a bank account (never stored, by the privacy
       page's promise).
   The rules below only decide WHERE a line waits and what it is called. They
   never decide whether it exists. Nothing here files a line that a person
   would not expect to file itself, and a new rule may only ever make a line
   wait or list it as left out. */

// Which version of these rules a read ran under. Raise it when a rule changes
// what is kept or where it lands: every bank is then read again from the
// start, by itself, under the new rules.
const RULES = 2;

// The plain words kept on a left-out line, by reason.
const LEFT_OUT_WORDS: Record<string, any> = {
  card_payment: "Card payment",
  own_move: "Moved to savings or investments",
  outside_dates: "Not during a tour",
  before_tour: "Before the tour",
  zero: "Zero amount",
  bank_removed: "Taken back by the bank",
};

// Plaid's account types in the feed's own words.
function typeOf(a: any): string {
  if (a.type === "credit") return "creditCard";
  if (a.type === "depository") return a.subtype === "savings" ? "savings" : "checking";
  return String(a.type ?? "other");
}
/* A new account asks first, whatever it is: nothing on it files itself until
   its questions are answered. (A credit card used to start on "log", and a
   kind of account the app did not know started "off", which threw its lines
   away. An account that already has a mode keeps it.) */
function defaultMode(_type: string): string {
  return "ask";
}
// The manager's answer wins over Plaid's reading, for what a charge counts as (owed or paid).
function cardType(plaid: string, card: any = null): string {
  if (card === "credit") return "creditCard";
  if (card === "debit") return plaid === "savings" ? "savings" : "checking";
  return plaid;
}
// A credit card's charges are spent but still owed; a debit card's (or a
// bank account's) are paid, the money already gone.
function isCredit(a: any = null): boolean {
  return a ? (a.card ? a.card === "credit" : a.type === "creditCard") : false;
}
/* Is it a card? For every rule about what a line IS, the BANK's own reading
   decides, not the person's answer to "credit card or debit card?". (A
   checking account answered "Credit card" by a wrong tap used to lose its
   Zelle lines again, because money sent "from a card" was thrown away.) */
function bankSaysCard(a: any = null): boolean {
  return a ? String(a.plaid ?? a.type ?? "") === "creditCard" : false;
}
/* An account's name as it should read. This file is pasted by hand, and one
   paste turned the two middle dots before an account's last four digits into
   two other characters each (a "not" sign and a summation sign), so some
   names kept from that night carry them. The list of accounts is written
   again from the bank on every read and heals by itself; names kept elsewhere
   (on a row, on a tour) do not, so every stored name is passed through this
   before it is compared with another or handed on. */
function cleanName(s: any): string {
  return String(s ?? "").replace(/\u00ac\u2211/g, "\u00b7");
}

/* Money SENT from a bank account: a Zelle, a wire, a transfer to someone, a
   payment through an app such as Venmo, cash from a machine, a loan payment.
   The bank files most of these under "transfer out" or "loan payments", the
   same headings as paying a credit card or moving money to your own savings,
   and for a long time the feed threw both headings away whole, so pay sent by
   Zelle never reached the app. Now every one of them is stored. The ones that
   may be spending wait to be sorted (nothing here files itself); the two that
   are not spending are kept as left out, with their reason:
     card_payment: paying a credit card (that card's own charges are counted)
     own_move:     money moved to savings or an investment account */
const NOT_SENT = new Set(["TRANSFER_OUT_SAVINGS", "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS"]);
const SENT_FROM_CARD = "Cash advance or money sent from a card";
// (A wire by its own wording; not a night out at the Live Wire Lounge.)
const WIRE_WORDS = /\b(wire (transfer|out|type|fee)|outgoing wire|fedwire|domestic wire|international wire)\b/i;
const TRANSFER_WORDS = /^transfer\b|\btransfer (to|from)\b|online (banking )?transfer/i;
const CASH_WORDS = /\b(atm|cash) ?(withdrawal|withdrwl|withdraw|w\/d)\b|\bwithdrawal\b.{0,24}\batm\b|\batm\b.{0,24}\bwithdr/i;
/* The only wording that still marks a line as a card payment, and only for
   money leaving a bank account. Generic words ("autopay", "pmt", "e-payment",
   "transfer to") no longer hide anything: "VERIZON WIRELESS AUTOPAY" and "ATT
   BILL PMT" are bills. For the two card companies named, the payment word has
   to follow the name directly (only filler such as "card" or "online" between
   them), so "Amex Travel Payment" and "Bank of America Stadium Parking PMT"
   stay what they are: spending. */
const FILLER = "(?:[\\s:*#.,/-]|\\b(?:credit|card|crd|online|business|des|web|mobile|bill)\\b)*";
const CARD_PAYMENT_WORDS = [
  /payment.{0,12}thank/i, /\bcredit card payment\b/i, /\bcard ?member serv/i,
  new RegExp("\\b(american express|amex)\\b" + FILLER + "(e ?payment|epayment|payment|pmt|ach|autopay)\\b", "i"),
  new RegExp("\\bbank of america\\b" + FILLER + "(payment|pmt|credit card)\\b", "i"),
];
const FEES = /\b(interest charge|finance charge|annual (membership )?fee|late (payment )?fee|foreign transaction fee|returned payment fee|overdraft fee|monthly (maintenance|service) fee)\b/i;
/* The words that used to make the feed throw a line away. They hide nothing
   now: such a line is stored like any other. But a line the old rules would
   not have let through must never file itself either. It waits for a person,
   whatever the account is set to and whatever was learned (see isWary), so
   bringing it onto a tour is always somebody's tap. */
const WARY_WORDS = [
  /\b(e[ -]?payment|autopay|auto[ -]?pay)\b/i, /\b(pmt|pymt)\b/i,
  /^\s*transfer\b/i, /\btransfer (to|from)\b/i, /online (banking )?transfer/i,
  /\bstarting balance\b/i, /\bbalance adjustment\b/i,
  /payment.{0,12}thank/i, /\bcredit card payment\b/i, /\bcard ?member serv/i,
  /(american express|amex).{0,20}(payment|pmt|ach)/i, /bank of america.{0,20}(payment|pmt|credit card)/i,
];
const MAYBE_MOVE = "May be a payment or a move";

// Text the bank sent in one field, or "" when it sent none. Anything else is a shape this code does not know.
function said(v: any): string {
  if (v == null) return "";
  if (typeof v !== "string") throw new Error("shape");
  return v;
}
// Everything the bank said about a line, in one string.
function wordsOf(t: any): string {
  const others = Array.isArray(t.counterparties)
    ? t.counterparties.map((c: any) => (c && typeof c.name === "string" ? c.name : "")) : [];
  return [said(t.original_description), said(t.name), said(t.merchant_name)].concat(others).filter(Boolean).join(" ");
}
function saysCardPayment(t: any): boolean {
  return [said(t.original_description), said(t.name), said(t.merchant_name)]
    .some((s: string) => !!s && CARD_PAYMENT_WORDS.some((re: any) => re.test(s)));
}
/* What kind of money OUT a line is. sent: it may be spending, it always waits
   for a person, and it is named from the bank's own line. left: it is stored
   as left out, with that reason. Neither: an ordinary charge.
   Words come before labels: a Zelle or a wire is one whatever heading the bank
   filed it under, "loan payments" included. On a card no word in the name can
   mark or hide anything; only the bank's two headings make a line wait. */
function outKind(t: any, pfc: any, onCard: boolean): any {
  const none = { sent: "", left: "" };
  if (!(Number(t.amount) > 0)) return none;
  const primary = String(pfc.primary ?? ""), detailed = String(pfc.detailed ?? "");
  if (onCard) return primary === "TRANSFER_OUT" || primary === "LOAN_PAYMENTS" ? { sent: SENT_FROM_CARD, left: "" } : none;
  const line = wordsOf(t);
  if (/\bzelle\b/i.test(line)) return { sent: "Zelle", left: "" };
  if (detailed === "TRANSFER_OUT_WIRE" || WIRE_WORDS.test(line) || (primary === "TRANSFER_OUT" && /\bwire\b/i.test(line))) return { sent: "Wire", left: "" };
  if (detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" || saysCardPayment(t)) return { sent: "", left: "card_payment" };
  if (NOT_SENT.has(detailed)) return { sent: "", left: "own_move" };
  if (detailed === "TRANSFER_OUT_WITHDRAWAL" || CASH_WORDS.test(line)) return { sent: "Cash withdrawal", left: "" };
  if (primary === "LOAN_PAYMENTS") return { sent: "Loan payment", left: "" };
  if (primary === "TRANSFER_OUT") return { sent: "Transfer", left: "" };
  // (The bank's newer labels put some transfers under "other", or give none: the line's own words decide.)
  if ((!primary || primary === "OTHER") && TRANSFER_WORDS.test(line)) return { sent: "Transfer", left: "" };
  return none;
}
function sentAs(t: any, pfc: any, onCard: boolean): string {
  return outKind(t, pfc, onCard).sent;
}
/* Money out that the rules before these would have hidden, and that could
   otherwise pass for an ordinary charge:
     - one of the old words in its name, its merchant name or the bank's own
       description (each looked at on its own);
     - Zelle or wire wording, on any kind of account (on a bank account such a
       line is "sent" and waits anyway; on a card no word marks anything);
     - a "transfer in" heading on money going OUT of a card, by the bank's
       reading of the account or by the person's answer about it.
   Such a line never files itself. */
function isWary(t: any, pfc: any, onCard: boolean, answeredCard: boolean): boolean {
  if (!(Number(t.amount) > 0)) return false;
  const fields = [said(t.original_description), said(t.name), said(t.merchant_name)];
  if (fields.some((s: string) => !!s && WARY_WORDS.some((re: any) => re.test(s)))) return true;
  const line = wordsOf(t);
  if (/\bzelle\b/i.test(line) || WIRE_WORDS.test(line) || TRANSFER_WORDS.test(line)) return true;
  return (onCard || answeredCard) && String(pfc.primary ?? "") === "TRANSFER_IN";
}
/* What to call a line that was sent to someone. The bank's own description is
   the only place that says who was paid ("Zelle payment to Pat Example",
   "WIRE ... BNF:EXAMPLE BUS CO ..."), so for these lines it is kept, with
   every long number (account, routing, confirmation) taken out. */
function sentName(kind: string, t: any): string {
  const saidIt = String(t.original_description || t.name || t.merchant_name || "").replace(/\d{6,}/g, " ").replace(/\s+/g, " ").trim();
  if (kind === "Wire") {
    const to = /\bBNF:\s*(.+?)\s*(?:\bID:|\bBNF BK:|\bPMT DET:|\bOBI:|$)/i.exec(saidIt);
    if (to && to[1].trim().length > 1) return ("Wire to " + to[1].trim()).slice(0, 80);
  }
  const short = saidIt.replace(/\b(conf(irmation)?|ref(erence)?|trn|id)\s*[#:]?\s*[A-Za-z0-9]*\d[A-Za-z0-9]*/gi, " ")
    .replace(/\b(conf(irmation)?|ref(erence)?|trn)\s*[#:]+(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();
  return (short || saidIt || kind).slice(0, 80);
}

// The bank's own id for a line, or "" when it has none that can be used.
function lineId(t: any): string {
  const v = t ? t.transaction_id : null;
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && isFinite(v)) return String(v);
  return "";
}

/* One Plaid transaction in the shape the sorter reads (the YNAB shape the
   sorting was written for): amounts in thousandths, money out negative. Plaid
   says money out is positive, so the sign flips. It throws on a line it
   cannot read (no id, no day, an amount that is not a number, text where text
   should not be); the caller then keeps the line anyway (rescueTx).
     sent:    money out that always waits for a person (outKind)
     left:    money out that is stored as left out, with this reason
     back:    money coming BACK into a bank account (a returned Zelle, wire or
              payment: the bank labels it with the heading it went out under)
     payment: money arriving on a card that is the card being paid down
     wary:    money out the rules before these would have hidden: it never
              files itself (isWary) */
function asTx(t: any, accounts: Record<string, any>): any {
  if (!t || typeof t !== "object") throw new Error("shape");
  const id = lineId(t);
  if (!id) throw new Error("id");
  const pfc: any = t.personal_finance_category && typeof t.personal_finance_category === "object" ? t.personal_finance_category : {};
  if (typeof t.amount !== "number" || !isFinite(t.amount)) throw new Error("amount");
  const amt: number = t.amount;
  const posted = said(t.date);
  if (!G.parseDay(posted)) throw new Error("date");
  // The day the charge was made (what the card statement shows); the day it
  // posted is kept for the balance math.
  const made = G.parseDay(said(t.authorized_date)) ? said(t.authorized_date) : posted;
  const name = said(t.name), merchantName = said(t.merchant_name);
  const accountId = t.account_id == null ? "" : String(t.account_id);
  const acct = accounts[accountId];
  const onCard = bankSaysCard(acct);
  const out = outKind(t, pfc, onCard);
  const back = !onCard && amt < 0 && (pfc.primary === "TRANSFER_OUT" || pfc.primary === "LOAN_PAYMENTS");
  // Money arriving on a card that isn't a refund: the card being paid down.
  const payment = onCard && amt < 0 && (pfc.primary === "LOAN_PAYMENTS" || pfc.primary === "TRANSFER_IN" || /\bpayment\b/i.test(name));
  /* Only the deposit test reads this, and it is worked out exactly as it
     always was (from the person's answer about the account), so which lines
     are kept as deposits does not change by one line: money in is not a
     deposit when the bank labels it a loan payment or a transfer out, or, on
     an account answered "Credit card", a transfer in or a "payment". */
  const answeredCard = !!acct && acct.type === "creditCard";
  const notDeposit = amt < 0 && (pfc.primary === "LOAN_PAYMENTS" || pfc.primary === "TRANSFER_OUT" ||
    (answeredCard && (pfc.primary === "TRANSFER_IN" || /\bpayment\b/i.test(name))));
  return {
    id, account_id: accountId, amount: Math.round(-amt * 1000),
    // (For money sent to someone, or sent back, the bank's own line says who; the "merchant" is only the bank or the app.)
    payee_name: out.sent || back ? sentName(out.sent || "Money back", t) : String(merchantName || name || ""),
    import_payee_name_original: name,
    date: made, posted,
    deleted: false, transfer_account_id: notDeposit ? "transfer" : null,
    payment, sent: out.sent, left: out.left, back,
    wary: isWary(t, pfc, onCard, answeredCard),
  };
}
/* A line asTx could not read is still a line the bank sent: it is kept, and
   it waits ("Could not read this line"), with its id, account, day and amount
   as far as each can be read. A day that cannot be read becomes today, so the
   row can be stored at all. */
function rescueTx(t: any, today: string): any {
  let id = "", accountId = "", date = today, posted = today, amount = 0;
  try { id = lineId(t); } catch { id = ""; }
  try { if (t.account_id != null && typeof t.account_id !== "object") accountId = String(t.account_id); } catch { accountId = ""; }
  try {
    if (typeof t.date === "string" && G.parseDay(t.date)) { date = t.date; posted = t.date; }
    if (typeof t.authorized_date === "string" && G.parseDay(t.authorized_date)) date = t.authorized_date;
  } catch { date = today; posted = today; }
  try { const n = Number(t.amount); if (isFinite(n)) amount = Math.round(-n * 1000); } catch { amount = 0; }
  return {
    id, account_id: accountId, amount, payee_name: "Unknown", import_payee_name_original: "",
    date, posted, deleted: false, transfer_account_id: null,
    payment: false, sent: "", left: "", back: false, wary: false, unreadable: true,
  };
}

/* One connection's answer from the bank, opened. got = { added, modified,
   removed } as Plaid sent them. Gives back:
     txs:     every POSTED line, once (a line sent twice in one read, added
              and then changed, counts once, as the bank last sent it), plus
              a marker for each line the bank says it removed
     sent:    how many posted lines the bank handed over. This is the number
              the ledger must account for, and it is counted HERE, before any
              rule has looked at a line, so it cannot agree with the sorter's
              own counts by construction.
     pending: lines not posted yet (never stored; each comes again, posted,
              under a new id)
     noId:    posted lines with no id that can be used. They cannot be stored
              (the id is the only key) and are counted in sent, so they show
              as unexplained and the read does not move on past them.
   A line the bank sends and removes inside the same read is marked gone: it
   is not kept as a live row. */
function takeRead(got: any, accounts: Record<string, any>, now: number, item: string, fromStart: boolean, seqBase: number): any {
  const today = G.ymd(new Date(now));
  const latest = new Map();
  let noId = 0, pending = 0;
  for (const list of [got && got.added, got && got.modified]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const id = lineId(raw);
      if (id) latest.set(id, raw);
      else if (raw && typeof raw === "object" && raw.pending) pending += 1;
      else noId += 1;
    }
  }
  const removed = new Set();
  for (const r of (got && Array.isArray(got.removed) ? got.removed : [])) {
    const id = lineId(r);
    if (id) removed.add(id);
  }
  const txs: any[] = [];
  let sent = noId, n = 0;
  for (const [id, raw] of latest) {
    if (raw.pending) { pending += 1; continue; }     // posted lines only
    sent += 1;
    let tx: any = null;
    try { tx = asTx(raw, accounts); } catch { tx = rescueTx(raw, today); }
    tx.item = item;
    tx.fromStart = fromStart;
    // Its place in what the bank sent (newest first, and within a day the
    // order the card's own app shows). A later read sits above an earlier one.
    tx.seq = seqBase + n;
    n += 1;
    if (removed.has(id)) tx.gone = true;
    txs.push(tx);
  }
  for (const id of removed) {
    const raw = latest.get(id);
    if (!raw || raw.pending) txs.push({ id, account_id: "", deleted: true, amount: 0, date: "", item });
  }
  return { txs, sent, pending, noId };
}

// A tour takes charges only between the logging dates its manager chose
// (G.cardWindow). A tour that is taken down takes none.
function asTours(rows: any[]): any[] {
  const tours: any[] = [];
  for (const r of rows) {
    const doc = (r && r.doc) || {};
    if (doc.deletedAt) continue;
    tours.push({ id: r.id, doc, win: G.cardWindow(doc) });
  }
  return tours;
}
function toursOn(tours: any[], date: string): any[] {
  return tours.filter((t: any) => t.win && !t.doc.deletedAt && date >= t.win.from && date <= t.win.to);
}
/* Which tour a day belongs to. any: some tour (or the one Off Tour book)
   takes that day. tour: the one it is, or null when two tours log that day
   and a person has to pick. Between tours the line goes to the Off Tour book,
   from the day it logs from; with two books (two artists) there is no telling
   whose it is, and with none there is nowhere for it: any is false, and the
   caller keeps the line as left out ("Not during a tour"). */
function tourFor(tours: any[], date: string): any {
  let hits = toursOn(tours, date);
  if (!hits.length) {
    const books = tours.filter((x: any) => x.doc.kind === "offtour" && !x.doc.deletedAt && String(x.doc.offFrom ?? "9999") <= date);
    if (books.length !== 1) return { any: false, tour: null };
    hits = books;
  }
  return { any: true, tour: hits.length === 1 ? hits[0] : null };
}
// What the look-alike and "already typed" tests read from a tour, worked out once per tour per read
// (the tour as it stood before this read).
function tourFacts(memo: any, tour: any): any {
  let f = memo.get(tour.id);
  if (f) return f;
  const doc = tour.doc;
  const cats = G.chargeCategoriesFor(doc);
  const charges = G.rows(doc.charges), extras = G.rows(doc.extras);
  f = {
    cats,
    keys: cats.map((c: any) => c.key),
    cutoff: G.preTourCutoff(doc),
    // Typed in by hand: for an ordinary charge, every charge and extra on the tour.
    typed: charges.concat(extras),
    // For money sent to someone (often typed days later, or logged from the merch cash): not the
    // charges the card feed itself filed, and the cash log too.
    typedSent: charges.filter((c: any) => !/^(cards|review)-/.test(String(c.importId ?? "")))
      .concat(extras, G.rows(doc.cashLog).filter((c: any) => c.category !== "deposit" && c.category !== "handoff")),
    paid: G.normExpenses(doc.expenses),
  };
  memo.set(tour.id, f);
  return f;
}

/* Money arriving anywhere in one read, by its amount in cents: where the other
   half of a move between his own linked accounts is looked for. */
function arrivalsOf(txs: any[]): any {
  const by = new Map();
  for (const x of txs) {
    if (!x || x.deleted || x.unreadable || !(Number(x.amount) > 0)) continue;
    const k = Math.round(Number(x.amount) / 10);
    const list = by.get(k);
    if (list) list.push(x); else by.set(k, [x]);
  }
  return by;
}
// The same amount as this line's, arriving on another account within three days of it. null when there is none.
function otherHalf(arrivals: any, t: any): any {
  const k = Math.round(-Number(t.amount) / 10);
  for (const key of [k, k - 1, k + 1]) {
    for (const x of (arrivals.get(key) || [])) {
      if (x.account_id !== t.account_id && Math.abs(Number(x.amount) + Number(t.amount)) < 5 &&
        G.parseDay(String(x.posted || x.date)) && G.parseDay(String(t.posted || t.date)) &&
        Math.abs(G.daysBetween(String(x.posted || x.date), String(t.posted || t.date))) <= 3) return x;
    }
  }
  return null;
}

/* Where ONE posted line the app does not hold yet goes. Every way out of this
   function is one of two things, and there is no third:
     { out: "money_in" }                    counted, not stored
     { status, reason, why, tour_id, ... }  a row: waiting, filed or left_out
   (An account that is switched off is counted by the caller before this is
   asked.) In this order:
     1. a line that could not be read waits (money coming IN on a bank
        account is only counted, also when it could not be read)
     2. zero amount: left out
     3. money IN: on a card, a payment to the card is left out, anything else
        is a refund and waits; on a bank account, money coming BACK waits and
        any other money in is counted only
     4. money OUT that is not spending (paying a card, a move to savings):
        left out
     5. no tour takes that day: left out ("Not during a tour")
     6. on or before a hand-typed card's opening balance day: left out
        ("Before the tour"), except money sent from a bank account
     7. otherwise it waits with the reason a person needs, or, only when
        nothing at all stands against it, files itself. A line the rules
        before these would have hidden (t.wary), money sent to someone, and
        money that looks like a payment to one of his own cards never do. */
function placeLine(t: any, acct: any, accounts: Record<string, any>, tours: any[], labels: Record<string, any>,
  arrivals: any, today: string, hold: boolean, memo: any): any {
  const mode = acct?.mode ?? "ask";
  const onCard = bankSaysCard(acct);
  const date = String(t.date);
  const posted = String(t.posted || date);
  const spent = Math.round(-Number(t.amount) / 10) / 100;
  const payee = String(t.payee_name ?? "").trim();
  const sent = String(t.sent || "");
  // (A line named from the bank's own words keeps them as they are.)
  const merchant = (sent || t.back || t.unreadable ? payee.slice(0, 80) : GRS.cleanMerchant(payee)) || "Unknown";
  const where = tourFor(tours, date);
  // Two tours logging the same day: the manager picks.
  const tour = where.tour;
  const facts = tour ? tourFacts(memo, tour) : null;
  let category: any = FEES.test(payee) ? "interest" : GRS.learnedCategory(labels, merchant);
  if (category && facts && facts.keys.indexOf(category) < 0) category = null;
  const base = { tour_id: tour ? tour.id : null, date, posted, merchant, amount: spent, category };
  const left = (reason: string): any => ({ ...base, status: "left_out", reason, why: LEFT_OUT_WORDS[reason] });

  if (t.unreadable) {
    // Money coming in on a bank account is only ever counted, never stored (the privacy page's promise),
    // and that holds for a line the code could not read too. Money out, and anything on a card, is kept.
    if (!onCard && spent < 0) return { out: "money_in" };
    return { ...base, category: null, status: "waiting", reason: null, why: "Could not read this line" };
  }
  if (!(spent !== 0)) return left("zero");
  if (spent < 0) {
    if (onCard && t.payment) return left("card_payment");
    if (!onCard && !t.back) return { out: "money_in" };
  } else if (t.left) {
    return left(String(t.left));
  }

  if (!where.any) return { ...left("outside_dates"), tour_id: null };
  const cutoff = facts ? facts.cutoff : null;
  // (Money sent from a BANK account was never inside a card's opening balance, so it is never "before the
  // tour". Money sent from a card is inside that card's balance, like every other charge on it.)
  if (spent > 0 && cutoff && date <= cutoff && !(sent && !onCard)) return left("before_tour");

  // The same amount arriving on another of his linked accounts within three days: probably a move, not a
  // payment. Looked for on money sent to someone, and on every line of money leaving a bank account.
  const half = sent || (!onCard && spent > 0) ? otherHalf(arrivals, t) : null;
  const halfName = half ? cleanName(accounts[String(half.account_id)]?.name ?? "") : "";
  // Already typed in by hand? Same amount within a day. For money sent to someone the look is wider: three days.
  const twinDays = sent ? 3 : 1;
  const typedRows = facts ? (sent ? facts.typedSent : facts.typed) : [];
  const twin = !!tour && spent > 0 && typedRows.some((c: any) =>
    G.parseDay(String(c.date)) && Math.abs(G.num(c.amount) - spent) < 0.005 &&
    Math.abs(G.daysBetween(String(c.date), date)) <= twinDays);
  const typed = category && facts ? G.num((facts.paid[category] ?? {}).paid) : 0;
  const catLabel = typed > 0
    ? String((facts.cats.find((c: any) => c.key === category) ?? {}).label ?? category)
    : "";

  let why = "";
  if (spent < 0) why = onCard ? "Refund" : "Money back";
  else if (!tour) why = "Two tours that day";
  else if (twin) why = "Maybe already in";
  // Money sent to someone always waits for a person, whatever the account is set to and whatever was learned.
  else if (sent) why = !half ? sent
    : sent + (half.payment ? " \u00b7 may be a payment to " : " \u00b7 may be a move to ") + (halfName || "another account");
  // Money out of a bank account, and the same amount arrived as a payment on one of his linked cards: most
  // likely that card being paid (its own charges are already counted). It waits, whatever was learned.
  else if (half && half.payment) why = "May be a payment to " + (halfName || "another card");
  else if (typed > 0) why = "Already typed into " + catLabel;
  // A line the rules before these would have hidden never files itself, whatever the account is set to.
  else if (t.wary) why = MAYBE_MOVE;
  else if (mode === "ask") why = "From " + (cleanName(acct?.name ?? "") || "a bank account");
  else if (!category) why = "New merchant";
  // A read from the start brings months at once: nothing it finds is filed without a person.
  else if (hold) why = "Found in the catch-up";
  // Older history can arrive on a later, ordinary read (a new bank sends it in parts): it never files itself either.
  else if (G.daysBetween(date, today) > 14) why = "Older than two weeks";

  if (why) return { ...base, status: "waiting", reason: null, why };
  return { ...base, status: "filed", reason: null, why: "", tour };
}

/* The ledger: one connection's count of what became of the lines the bank
   handed over. `sent` is counted where the bank's answer is first opened
   (takeRead); every other number where a line's fate is decided
   (sortTransactions). They are two separate counts of the same lines, so a
   line that got no fate shows up here as unexplained, and the read stops. */
function ledgerOf(ledger: Record<string, any>, item: string): any {
  if (!ledger[item]) {
    ledger[item] = { already: 0, waiting: 0, filed: 0, left_out: 0, reasons: {}, off: {}, money_in: 0, deposits: 0, first_day: "", last_day: "" };
  }
  return ledger[item];
}
function ledgerLine(sent: number, pending: number, counts: any = null): any {
  const k = counts || ledgerOf({}, "");
  let off = 0;
  for (const name of Object.keys(k.off)) off += Number(k.off[name]) || 0;
  return {
    bank_sent: sent, pending, already_here: k.already, new_waiting: k.waiting, new_filed: k.filed, new_left_out: k.left_out,
    reasons: k.reasons, not_kept: { off: k.off, money_in: k.money_in }, deposits: k.deposits,
    unexplained: sent - k.already - k.waiting - k.filed - k.left_out - off - k.money_in,
    first_day: k.first_day || null, last_day: k.last_day || null, rules: RULES,
  };
}
// The run's ledger for the app: every connection's line added up. (unexplained adds up each
// connection's own gap, so one bank short and another over can never read as nothing missing.)
function ledgerSum(lines: any[]): any {
  const out = { sent: 0, already: 0, waiting: 0, filed: 0, left_out: 0, not_kept: 0, unexplained: 0 };
  for (const l of lines) {
    let off = 0;
    for (const name of Object.keys(l.not_kept.off)) off += Number(l.not_kept.off[name]) || 0;
    out.sent += l.bank_sent; out.already += l.already_here; out.waiting += l.new_waiting;
    out.filed += l.new_filed; out.left_out += l.new_left_out;
    out.not_kept += off + l.not_kept.money_in;
    out.unexplained += Math.abs(l.unexplained);
  }
  return out;
}
const cents = (v: any): number => Math.round(Number(v) * 100);

/* Every line of one run, sorted. Gives back:
     items:    the new rows (waiting, filed, left_out), each with its account_id
     toFile:   the charges that file themselves, by tour
     deposits, payments: as they always were
     changes:  what to do to rows the app already holds (never a new row, never
               a delete, never anything on a tour):
                 gone:    the bank took the line back
                 alive:   the bank sends a line again that it had taken back
                 amount:  the bank now gives another amount
                 relabel: a line left out for what it was (a card payment, a
                          move to savings, a zero amount) is not that any more:
                          it comes to wait
                 resort:  a line left out for its day now falls inside the card
                          dates (only on a read from the start)
     ledger:   by connection, the count of every fate
     fate:     by line id, what became of it (for the tests) */
function sortTransactions(txs: any[], accounts: Record<string, any>, tours: any[], labels: Record<string, any>,
  known: any, owner: string, now: number, income: any = null, hold: boolean = false): any {
  const items: any[] = [];
  const deposits: any[] = [];
  const payments: any[] = [];
  const changes: any[] = [];
  const toFile = new Map();
  const ledger: Record<string, any> = {};
  const fate: Record<string, any> = {};
  const memo = new Map();
  const done = new Set();
  const today = G.ymd(new Date(now));
  const watched = income || new Map();
  // Money arriving anywhere in this read: the other half of a move between his own linked accounts.
  const arrivals = arrivalsOf(txs);

  for (const t of txs) {
    const id = String(t.id);
    const had = known.get(id);
    // The bank says it removed a line (one it did not also send in this read).
    if (t.deleted) {
      if (had) changes.push({ id, kind: "gone", status: typeof had === "string" ? had : String(had.status ?? ""), reason: typeof had === "string" ? null : had.reason ?? null });
      continue;
    }
    const led = ledgerOf(ledger, String(t.item ?? ""));
    // (The same id twice in one run is one line: the second is already here.)
    if (done.has(id)) { led.already += 1; continue; }
    done.add(id);
    if (!t.unreadable && G.parseDay(String(t.date))) {
      const d = String(t.date);
      if (!led.first_day || d < led.first_day) led.first_day = d;
      if (!led.last_day || d > led.last_day) led.last_day = d;
    }

    // Deposits on accounts watched for income, and payments arriving on a card: collected first, as they always were.
    const watch = watched.get(String(t.account_id));
    if (watch && !t.unreadable && !t.transfer_account_id && Number(t.amount) > 0) {
      const raw = String(t.import_payee_name_original ?? t.payee_name ?? "").trim();
      deposits.push({ id, date: String(t.posted || t.date), amount: Math.round(Number(t.amount) / 10) / 100,
        av: /^AV[A-Z0-9]/i.test(raw) || /\batvenu\b/i.test(raw), watch });
      led.deposits += 1;
    }
    if (t.payment && Number(t.amount) > 0) {
      payments.push({ id, date: String(t.posted || t.date), amount: Math.round(Number(t.amount) / 10) / 100, watch: String(t.account_id) });
    }

    const acct = accounts[String(t.account_id)];
    const mode = acct?.mode ?? "ask";

    /* A line the app already holds is never sorted again and never added
       twice. A few things only can happen to its row, none of them on a tour,
       none of them a delete, and the only place a row is ever moved to is
       "waiting". */
    if (had) {
      led.already += 1;
      fate[id] = "already";
      const status = typeof had === "string" ? had : String(had.status ?? "");
      const reason = typeof had === "string" ? null : had.reason ?? null;
      const open = status === "waiting" || status === "left_out";   // nobody has dealt with it yet
      if (t.gone) { changes.push({ id, kind: "gone", status, reason }); continue; }
      if (typeof had === "string") continue;
      /* The bank took this line back once, and now sends it again, alive. A
         row kept as "Taken back by the bank" comes to wait; a row a person
         had already dealt with only loses the day it was marked gone. */
      if (status === "left_out" && reason === "bank_removed") {
        if (mode !== "off") changes.push({ id, kind: "alive", open: true });
      } else if (had.gone_on && (status === "filed" || status === "skipped" || status === "mypay")) {
        changes.push({ id, kind: "alive", open: false });
      }
      if (t.unreadable) continue;
      const figure = Math.round(-Number(t.amount) / 10) / 100;
      const onCard = bankSaysCard(acct);
      // The bank sends it again with another amount (a read from the start sends everything again, so this is looked at on every read).
      if (had.amount != null) {
        if (open) {
          if (cents(had.amount) !== cents(figure)) changes.push({ id, kind: "amount", open: true, amount: figure });
        } else if (cents(had.bank_amount ?? had.amount) !== cents(figure)) {
          changes.push({ id, kind: "amount", open: false, amount: figure });
        }
      }
      /* Left out for what it was, and the bank has changed the line since (a
         new amount, another heading, other words): if, as it is sent now, it
         would no longer be left out for that reason, it comes to wait, so
         real spending does not sit under a heading that says it is not
         spending. Looked at on every read. Money coming in on a bank account
         is never brought into the pile; such a row stays listed where it is. */
      if (status === "left_out" && (reason === "zero" || reason === "card_payment" || reason === "own_move") && mode !== "off") {
        const nowLeft = !(figure !== 0) ? "zero" : figure < 0 ? (onCard && t.payment ? "card_payment" : "") : String(t.left || "");
        const countedOnly = figure < 0 && !onCard && !t.back;
        if (nowLeft !== reason && !countedOnly) changes.push({ id, kind: "relabel", from: reason });
      }
      // Left out for its day, and that day is now inside a tour's card dates (they were changed, or a tour was added).
      if (t.fromStart && status === "left_out" && (reason === "outside_dates" || reason === "before_tour") && mode !== "off") {
        try {
          const day = G.parseDay(String(had.date ?? "")) ? String(had.date) : String(t.date);
          const where = tourFor(tours, day);
          if (where.any) {
            // (As in placeLine: only money sent from a bank account is never "before the tour".)
            const fromBank = !!t.sent && !onCard;
            const covered = (tour: any): boolean => {
              const cutoff = tourFacts(memo, tour).cutoff;
              return !!(figure > 0 && cutoff && day <= cutoff && !fromBank);
            };
            /* One tour takes the day: the row stays while that tour's opening
               balance day still covers it. Two tours take it and nobody has
               picked: a "before the tour" row stays while EITHER tour's
               opening balance day still covers it. */
            const still = where.tour ? covered(where.tour) : reason === "before_tour" && toursOn(tours, day).some(covered);
            if (!still) changes.push({ id, kind: "resort", tour_id: where.tour ? where.tour.id : null });
          }
        } catch { /* a tour that cannot be read leaves the row as it is */ }
      }
      continue;
    }

    // An account that is switched off: counted by name, never stored.
    if (mode === "off") {
      const name = cleanName(acct?.name ?? "") || "An account";
      led.off[name] = (led.off[name] || 0) + 1;
      fate[id] = "off";
      continue;
    }

    let p: any = null;
    try {
      p = placeLine(t, acct, accounts, tours, labels, arrivals, today, hold, memo);
    } catch {
      /* The line itself was read, but the rules could not place it (something
         in a tour's own data they did not expect). One such line, or one such
         tour, must not stop every other line: it is kept, waiting, on no tour.
         (Money coming in on a bank account is still only counted.) */
      const amount = Math.round(-Number(t.amount) / 10) / 100;
      // (Its name has not been through the cleaner the rules use: every long number, an account or a
      // confirmation, is taken out of it here, as for a line named from the bank's own words.)
      const name = String(t.payee_name ?? "").replace(/\d{6,}/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      p = !bankSaysCard(acct) && amount < 0 && !t.back ? { out: "money_in" } : {
        tour_id: null, date: String(t.date), posted: String(t.posted || t.date),
        merchant: name || "Unknown", amount, category: null,
        status: "waiting", reason: null, why: "Could not read this line",
      };
    }
    if (p.out === "money_in") {
      led.money_in += 1;
      fate[id] = "money_in";
      continue;
    }
    let status = String(p.status), reason: any = p.reason, why = String(p.why);
    // Sent and taken back inside the same read: it is kept on record, not as a live row.
    if (t.gone) { status = "left_out"; reason = "bank_removed"; why = LEFT_OUT_WORDS.bank_removed; }
    const account = cleanName(acct?.name ?? "");
    items.push({
      id, owner_id: owner, tour_id: p.tour_id, date: p.date, posted: p.posted,
      seq: Number.isFinite(Number(t.seq)) ? Number(t.seq) : null,
      merchant: p.merchant, amount: p.amount, category: p.category, account,
      account_id: String(t.account_id || "") || null,
      why, status, reason, gone_on: t.gone ? today : null,
    });
    if (status === "filed") {
      const bucket = toFile.get(p.tour.id) ?? { tour: p.tour, charges: {}, total: 0, n: 0 };
      bucket.charges["p" + id] = {
        date: p.date, posted: p.posted, merchant: p.merchant, amount: p.amount, category: p.category, accounted: false, account,
        importId: "cards-" + now, createdAt: now + bucket.n, paid: !isCredit(acct),
      };
      bucket.total += p.amount; bucket.n += 1;
      toFile.set(p.tour.id, bucket);
      led.filed += 1;
      fate[id] = "filed";
    } else if (status === "waiting") {
      led.waiting += 1;
      fate[id] = "waiting";
    } else {
      led.left_out += 1;
      led.reasons[reason] = (led.reasons[reason] || 0) + 1;
      fate[id] = "left_out:" + reason;
    }
  }
  return { items, toFile, deposits, payments, changes, ledger, fate };
}

/* Which connections are owed a read from the start, from the rows of the
   ledger (any order). Gives back { <connection>: "rescan" | "check" }:
     "check":  it has had no full read under these rules in the last 7 days.
     "rescan": a note was left for it (status "asked": the card dates were
               saved, or an account was switched on) since its last full read.
   A full read that ran out of pages ("more") counts as done here: the rest
   comes in on the ordinary reads that follow, from the place it reached.
   A read's row carries the time the read STARTED, and a note the time it was
   written. So a note written while a full read was under way is newer than
   that read, which may have looked at the tours before the dates changed, and
   the bank is still owed. (Two rows in the very same millisecond: the one
   written later counts as later.) */
function owedFullReads(rows: any[], itemIds: any[], now: number): any {
  const out: Record<string, any> = {};
  const weekAgo = now - 7 * 86400000;
  const later = (a: any, b: any): boolean => a.at > b.at || (a.at === b.at && a.id > b.id);
  for (const item of itemIds) {
    let full = { at: 0, id: 0 }, asked = { at: 0, id: 0 };
    for (const r of rows) {
      if (!r || r.item !== item) continue;
      const row = { at: Date.parse(String(r.at)) || 0, id: Number(r.id) || 0 };
      if (r.status === "asked") { if (later(row, asked)) asked = row; }
      else if (r.from_start === true && (r.status === "ok" || r.status === "more") && Number(r.rules) === RULES) { if (later(row, full)) full = row; }
    }
    if (asked.at && later(asked, full)) out[String(item)] = "rescan";
    else if (full.at < weekAgo) out[String(item)] = "check";
  }
  return out;
}

/* A read from the start is told today's lines only, never which lines the
   bank has taken back. tookBack is that list as the bank gives it from the
   saved place; the ones that are not in the full answer (a line the bank
   sends there is alive) are added to the answer's removed list, so they are
   handled like any other removal. Gives back how many were carried over. */
function carryRemoved(got: any, tookBack: any[]): number {
  const here = new Set();
  for (const list of [got.added, got.modified, got.removed]) {
    for (const t of (Array.isArray(list) ? list : [])) { const id = lineId(t); if (id) here.add(id); }
  }
  if (!Array.isArray(got.removed)) got.removed = [];
  let n = 0;
  for (const r of (Array.isArray(tookBack) ? tookBack : [])) {
    const id = lineId(r);
    if (!id || here.has(id)) continue;
    here.add(id);
    got.removed.push(r);
    n += 1;
  }
  return n;
}

/* Which banks are owed a read from the start after a person changed the
   answers about their accounts: the bank of every account that went from off
   to Ask me or Log (while it was off its lines were only counted, and the
   bank's place has moved past them), and of every account newly marked for a
   kind of income (its deposits were only counted). "" stands for an account
   that does not say which bank it is from: every bank is then owed. */
function reopenedBanks(was: Record<string, any>, next: Record<string, any>): any[] {
  const out: any[] = [];
  for (const id of Object.keys(next || {})) {
    const a = next[id], old = (was || {})[id];
    if (!a || !old) continue;
    const on = old.mode === "off" && a.mode !== "off";
    const had = Array.isArray(old.income) ? old.income : [];
    const gained = (Array.isArray(a.income) ? a.income : []).some((k: any) => had.indexOf(k) < 0);
    const bank = String(a.item ?? "");
    if ((on || gained) && out.indexOf(bank) < 0) out.push(bank);
  }
  return out;
}

// The bank lines whose charge ("p" + the line's id) is on any of these tours, taken-down tours included.
function chargesHeld(tourRows: any[]): any {
  const held = new Set();
  for (const t of (Array.isArray(tourRows) ? tourRows : [])) {
    const charges = t && t.doc && typeof t.doc === "object" ? t.doc.charges : null;
    if (!charges || typeof charges !== "object") continue;
    for (const k of Object.keys(charges)) {
      if (k.charAt(0) === "p" && charges[k] && typeof charges[k] === "object") held.add(k.slice(1));
    }
  }
  return held;
}

/* Which of these ids have no row among the rows read back from the database.
   This is what the tripwire counts after a run has written its rows: a row
   that is not there, whatever the write answered, is a line with no record.
   Rows that are not a list (the read gave nothing back) hold none of them. */
function notThere(ids: any[], rows: any): any[] {
  const have = new Set();
  for (const r of (Array.isArray(rows) ? rows : [])) if (r && r.id != null) have.add(String(r.id));
  return ids.filter((id: any) => !have.has(String(id)));
}

/* Where the next page of a bank's answer starts, or null when the page does
   not say. Every real page says it (an empty text when the bank has nothing
   yet). One that does not is an answer that could not be read: it arrives as
   an empty one, and taking it for "no more pages" would end a read from the
   start half way and call it whole. */
function pagePlace(page: any): any {
  return page && typeof page.next_cursor === "string" ? page.next_cursor : null;
}

/* Reading a long list from the database a page at a time: where the next page
   starts, or -1 when the list has ended. It ends on an EMPTY page only. A page
   shorter than was asked for is not the end: a project can be set to hand back
   fewer rows a request than the thousand asked for. */
function nextPage(from: number, got: number): number {
  return got > 0 ? from + got : -1;
}

/* Whether a waiting row is shown in one tour's pile, and as what. tour: the
   tour the row is kept for ("" for none). live: the owner's tours that are not
   taken down. mine: the person asking is the one whose banks these are.
     "here": it is for this tour
     "none": it is for no tour, or, for the owner only, for a tour that is
             taken down or gone (it is shown as a no-tour row, or nobody would
             ever see it)
     "":     not shown: another tour's row; or a taken-down tour's row when the
             person asking is this tour's Manager and not the owner (a row of
             another tour of the owner's is not theirs to see) */
function pilePlace(tour: string, tourId: string, live: any, mine: boolean): string {
  if (!tour) return "none";
  if (tour === tourId) return "here";
  if (live.has(tour)) return "";
  return mine ? "none" : "";
}

/* What a tour's Manager who is not the owner is told after a read of the
   owner's banks: how it went and what it found. Not the count of every bank
   line, and not how many lines came back inside the card dates: those cover
   all of the owner's tours, and are the owner's alone. */
function forManager(answer: any): any {
  const out: Record<string, any> = { ...answer };
  delete out.ledger;
  delete out.nowInside;
  return out;
}
// ---- pure:end ----

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

// A tour and the days it takes card charges for (see asTours in the pure block).
interface Tour { id: string; doc: Obj; win: { from: string; to: string } | null }
interface Bucket { tour: Tour; charges: Obj; total: number; n: number }

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
    // (Names are compared as they should read: one kept on a tour may still carry a paste's wrong characters. See cleanName.)
    const name = cleanName(accounts[String(p.watch)]?.name ?? "");
    if (!name) continue;
    // (A read from the start brings every old payment round again: one that any tour already holds is done.)
    if (tours.some((t) => Object.values((t.doc.debts ?? {}) as Record<string, Obj>).some((d) => ((d?.payments ?? {}) as Obj)[p.id]))) continue;
    let best: { tour: Tour; id: string; cutoff: string } | null = null;
    for (const t of tours) {
      for (const [id, d] of Object.entries((t.doc.debts ?? {}) as Record<string, Obj>)) {
        const f = (d?.feed ?? null) as Obj | null;
        if (!f || d.kind !== "card" || cleanName(f.name) !== name || !G.parseDay(String(d.cutoff))) continue;
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
// With the card company's name (the bank the card came in through), so each
// card shows as its own line: the card's name and last four digits, then the
// card company ("Gold Card 1111, AMEX").
async function markOwed(tours: Tour[], accounts: Record<string, Account>, banks: Map<string, string>) {
  const at = new Date().toISOString();
  const byName = new Map<string, { amount: number; bank: string }>();
  for (const a of Object.values(accounts)) {
    if (a.type === "creditCard" && typeof a.owed === "number") byName.set(cleanName(a.name), { amount: a.owed, bank: banks.get(a.item ?? "") ?? "" });
  }
  for (const t of tours) {
    for (const [id, d] of Object.entries((t.doc.debts ?? {}) as Record<string, Obj>)) {
      const f = (d?.feed ?? null) as Obj | null;
      if (!f || d.kind !== "card" || !byName.has(cleanName(f.name))) continue;
      const o = byName.get(cleanName(f.name))!;
      await admin.rpc("set_card_owed", { t_id: t.id, d_id: id, owed: { amount: o.amount, at, ...(o.bank ? { bank: o.bank } : {}) } });
    }
  }
}

/* Charges already in the pile or on a tour show the day they were made, not
   the day they posted: when the bank sends one again, its dates are brought
   into line (only the dates; nothing else about it changes). Never from a
   line that came in a read from the start (such a read changes nothing that
   is already here, not even a day someone corrected by hand), never from a
   line the bank took back, and never from one that could not be read (its
   day may be a stand-in). */
async function fixDates(owner: string, txs: Obj[], known: Map<string, unknown>, tours: Tour[]) {
  const want = new Map<string, { date: string; posted: string }>();
  for (const t of txs) {
    if (t.deleted || t.gone || t.unreadable || t.fromStart || !known.has(String(t.id)) || !G.parseDay(String(t.date))) continue;
    want.set(String(t.id), { date: String(t.date), posted: String(t.posted || t.date) });
  }
  if (!want.size) return;
  const ids = [...want.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await admin.from("feed_items").select("id, date, posted").eq("owner_id", owner).in("id", ids.slice(i, i + 100));
    for (const r of data ?? []) {
      const w = want.get(String(r.id))!;
      if (String(r.date) === w.date && String(r.posted ?? "") === w.posted) continue;
      await admin.from("feed_items").update({ date: w.date, posted: w.posted }).eq("owner_id", owner).eq("id", r.id);
    }
  }
  for (const t of tours) {
    const fixes: Obj = {};
    for (const [cid, ch] of Object.entries((t.doc.charges ?? {}) as Record<string, Obj>)) {
      const w = cid.startsWith("p") ? want.get(cid.slice(1)) : undefined;
      if (!w || !ch || (String(ch.date) === w.date && String(ch.posted ?? "") === w.posted)) continue;
      fixes[cid] = w;
      ch.date = w.date; ch.posted = w.posted;
    }
    if (Object.keys(fixes).length) await admin.rpc("set_charge_dates", { t_id: t.id, fixes });
  }
}

// This person's tours that are not taken down. null means they could not be
// read, and the caller stops: with no tours every line would look like it is
// "not during a tour", and the bank's place would move on past all of them.
async function toursOf(owner: string): Promise<Tour[] | null> {
  const { data: tourRows, error } = await admin.from("tours").select("id, doc, updated_at").eq("owner_id", owner);
  if (error) return null;
  return asTours(tourRows ?? []) as Tour[];
}
// The ids of this person's tours that are not taken down (no document is read).
// A row that points at any other tour counts as being on no tour. null: could not be read.
async function liveTourIds(owner: string): Promise<Set<string> | null> {
  const { data, error } = await admin.from("tours").select("id, gone:doc->>deletedAt").eq("owner_id", owner);
  if (error) return null;
  const out = new Set<string>();
  for (const r of (data ?? []) as Obj[]) {
    const g = r.gone;
    if (g == null || g === "" || g === "0" || g === "false") out.add(String(r.id));
  }
  return out;
}

/* Everything new from one connection since last time. The place it has read
   up to (cursor) only moves once its lines are safely saved, and never in
   test mode, so nothing is skipped or read twice. Added, changed and removed
   lines come back apart. more: the bank still had lines when this read's 40
   pages ran out (the next read carries on from the place this one reached). */
async function pull(item: Item, token: string): Promise<{ added: Obj[]; modified: Obj[]; removed: Obj[]; cursor: string | null; more: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const added: Obj[] = [], modified: Obj[] = [], removed: Obj[] = [];
    let cursor = item.cursor || null;
    let more = false;
    try {
      for (let page = 0; page < 40; page++) {
        const j = await plaidCall("/transactions/sync", {
          access_token: token, count: 500, ...(cursor ? { cursor } : {}),
          options: { include_personal_finance_category: true, include_original_description: true },
        });
        /* Every real page says where the next one starts. One that does not
           is an answer that could not be read (it arrives as an empty one):
           taking it for "no more pages" would end a read from the start half
           way and call it whole, so the read of this bank stops here, before
           anything on the page is used. (See pagePlace.) */
        const place = pagePlace(j);
        if (place == null) throw new PlaidError("failed");
        for (const t of (j.added ?? []) as Obj[]) added.push(t);
        for (const t of (j.modified ?? []) as Obj[]) modified.push(t);
        for (const t of (j.removed ?? []) as Obj[]) removed.push(t);
        cursor = String(place);
        more = !!j.has_more;
        if (!j.has_more) break;
      }
      return { added, modified, removed, cursor, more };
    } catch (e) {
      // The bank changed things mid-read: start this connection's read over.
      if (e instanceof PlaidError && e.message === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && attempt === 0) continue;
      throw e;
    }
  }
  return { added: [], modified: [], removed: [], cursor: item.cursor, more: false };
}

/* ---------------- The ledger of reads ---------------- */

// What the Cards tab shows as the feed's state. Every way a read can end
// badly writes it, so a failed read never looks like the last good one.
async function noteStatus(owner: string, status: string) {
  try { await admin.from("feed").update({ last_status: status }).eq("owner_id", owner); } catch { /* the answer still says so */ }
}

/* Which connections are owed a read from the start in this run, and why
   (the deciding is owedFullReads, in the pure block):
     "check":  it has had no full read under these rules in the last 7 days.
               So after this function is pasted, the first read of each bank
               catches it up under the new rules without anyone tapping
               anything, and a bank that failed during a catch-up is caught up
               on its next good read.
     "rescan": a note was left since its last full read (the card dates were
               saved, or an account was switched on or marked for income: the
               setup action leaves it in the ledger, status "asked").
   If the ledger cannot be read, nobody is owed and this is an ordinary read:
   the feed never waits on its own bookkeeping. */
async function fullReadOwed(owner: string, items: Item[]): Promise<Map<string, string>> {
  const { data, error } = await admin.from("feed_reads").select("id, item, at, from_start, status, rules")
    .eq("owner_id", owner).order("id", { ascending: false }).limit(1000);
  if (error) return new Map<string, string>();
  const owed = owedFullReads((data ?? []) as Obj[], items.map((i) => i.item_id), Date.now()) as Record<string, string>;
  return new Map<string, string>(Object.entries(owed));
}

interface Read { item: string; institution: string; kind: string; fromStart: boolean; status: string; sent: number; pending: number; more: boolean }

/* One row in feed_reads for each connection in a run: counts only, never a
   name or an amount (an account that is switched off is the one name kept,
   with how many lines were not read).
     - a bank that could not be read: its code, and zeros;
     - a run that could not be saved, or that came up short: that word on
       every bank's row (no bank's place moved), with what the sorter counted;
     - counts null: the run stopped before anything was sorted, so zeros.
   Every row of a run carries the time the run STARTED, not the time it was
   written: a note left while the run was under way (the card dates were
   saved, an account was switched on) is then newer than the run, and the
   bank is read from the start again (fullReadOwed). */
function readRows(owner: string, reads: Read[], counts: Record<string, unknown> | null, runStatus: string | null, started: number): Obj[] {
  const at = new Date(started).toISOString();
  return reads.map((r) => {
    const answered = r.status === "ok";
    const line = ledgerLine(answered && counts ? r.sent : 0, answered && counts ? r.pending : 0, answered && counts ? counts[r.item] : null);
    return {
      owner_id: owner, item: r.item, institution: r.institution, at, kind: r.kind, from_start: answered && r.fromStart,
      status: !answered ? r.status : runStatus ?? (r.fromStart && r.more ? "more" : "ok"), ...line,
    };
  });
}
/* A note in the ledger that these banks are owed a read from the start (the
   card dates were saved; an account was switched on, or marked for income).
   It is not a read, and it stands until such a read of that bank has
   succeeded. Gives back false when the note could not be written. */
async function askFullRead(owner: string, banks: Item[]): Promise<boolean> {
  if (!banks.length) return true;
  const at = new Date().toISOString();
  const noted = await admin.from("feed_reads").insert(banks.map((i) => ({
    owner_id: owner, item: i.item_id, institution: String(i.institution ?? ""), at, kind: "rescan", from_start: false, status: "asked", rules: RULES,
  })));
  return !noted.error;
}
async function writeReads(owner: string, rows: Obj[]) {
  try {
    if (rows.length) await admin.from("feed_reads").insert(rows);
    /* Only the newest 400 rows a person are kept. A read from the start is
       the check the Cards tab reports on, so those are kept for 30 days
       however many ordinary reads have piled up since. */
    const { data } = await admin.from("feed_reads").select("id").eq("owner_id", owner).order("id", { ascending: false }).range(400, 400);
    const cut = data && data[0] ? Number(data[0].id) : 0;
    if (!cut) return;
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    // (A note that a bank is owed a full read is kept like one: a bank that could not be read for a day must still get it.)
    await admin.from("feed_reads").delete().eq("owner_id", owner).lte("id", cut).eq("from_start", false).neq("status", "asked");
    await admin.from("feed_reads").delete().eq("owner_id", owner).lte("id", cut).eq("from_start", false).eq("status", "asked").lt("at", old);
    await admin.from("feed_reads").delete().eq("owner_id", owner).lte("id", cut).eq("from_start", true).lt("at", old);
  } catch { /* the ledger never stops the feed */ }
}

/* What a run does to rows the app already holds. These things only, each
   guarded on what the row is at the moment of the write, none of them a
   delete, none of them on a tour, and the only place a row is ever moved to
   is "waiting":
     gone:    the bank took the line back. A line nobody has dealt with leaves
              the pile and is kept as "Taken back by the bank"; one that is
              filed, set aside or in MY PAY only has the day noted.
     amount:  the bank gives another amount. A line nobody has dealt with takes
              it; for any other, the bank's figure is noted beside the row's.
     alive:   the bank sends a line again that it had taken back. A row kept
              as "Taken back by the bank" waits again; on any other row the
              day it was marked gone is cleared.
     relabel: a line left out as a card payment, a move to savings or a zero
              amount is no longer that, as the bank sends it now: it waits.
     resort:  a line left out for its day is now inside the card dates: it waits.
   Gives back how many lines came back to waiting because of the card dates,
   or null when a write failed (the run then ends save_failed and no bank's
   place moves, so it is tried again). */
async function applyChanges(owner: string, changes: Obj[], today: string): Promise<number | null> {
  const gone = changes.filter((c) => c.kind === "gone" && !(c.status === "left_out" && c.reason === "bank_removed")).map((c) => String(c.id));
  for (let i = 0; i < gone.length; i += 100) {
    const ids = gone.slice(i, i + 100);
    const a = await admin.from("feed_items")
      .update({ status: "left_out", reason: "bank_removed", why: LEFT_OUT_WORDS.bank_removed, gone_on: today })
      .eq("owner_id", owner).in("id", ids).in("status", ["waiting", "left_out"]);
    if (a.error) return null;
    const b = await admin.from("feed_items").update({ gone_on: today })
      .eq("owner_id", owner).in("id", ids).in("status", ["filed", "skipped", "mypay"]).is("gone_on", null);
    if (b.error) return null;
  }
  for (const c of changes) {
    if (c.kind !== "amount") continue;
    if (c.open) {
      const a = await admin.from("feed_items").update({ amount: c.amount })
        .eq("owner_id", owner).eq("id", String(c.id)).in("status", ["waiting", "left_out"]);
      if (a.error) return null;
    }
    // (Dealt with all along, or by someone a moment ago: the row keeps its amount and the bank's is noted.)
    const b = await admin.from("feed_items").update({ bank_amount: c.amount })
      .eq("owner_id", owner).eq("id", String(c.id)).in("status", ["filed", "skipped", "mypay"]);
    if (b.error) return null;
  }
  const reopened = changes.filter((c) => c.kind === "alive" && c.open).map((c) => String(c.id));
  for (let i = 0; i < reopened.length; i += 100) {
    const r = await admin.from("feed_items")
      .update({ status: "waiting", reason: null, why: "The bank sent this line again", gone_on: null })
      .eq("owner_id", owner).in("id", reopened.slice(i, i + 100)).eq("status", "left_out").eq("reason", "bank_removed");
    if (r.error) return null;
  }
  const unmarked = changes.filter((c) => c.kind === "alive" && !c.open).map((c) => String(c.id));
  for (let i = 0; i < unmarked.length; i += 100) {
    const r = await admin.from("feed_items").update({ gone_on: null })
      .eq("owner_id", owner).in("id", unmarked.slice(i, i + 100)).in("status", ["filed", "skipped", "mypay"]);
    if (r.error) return null;
  }
  // (Each guarded on the very reason the row was left out for when this run read it.)
  for (const from of ["zero", "card_payment", "own_move"]) {
    const ids = changes.filter((c) => c.kind === "relabel" && c.from === from).map((c) => String(c.id));
    for (let i = 0; i < ids.length; i += 100) {
      const r = await admin.from("feed_items")
        .update({ status: "waiting", reason: null, why: "The bank changed this line" })
        .eq("owner_id", owner).in("id", ids.slice(i, i + 100)).eq("status", "left_out").eq("reason", from);
      if (r.error) return null;
    }
  }
  const byTour = new Map<string, string[]>();
  for (const c of changes) {
    if (c.kind !== "resort") continue;
    const k = c.tour_id == null ? "" : String(c.tour_id);
    byTour.set(k, [...(byTour.get(k) ?? []), String(c.id)]);
  }
  let back = 0;
  for (const [tid, all] of byTour) {
    for (let i = 0; i < all.length; i += 100) {
      const r = await admin.from("feed_items")
        .update({ status: "waiting", reason: null, tour_id: tid || null, why: "Now inside the card dates" })
        .eq("owner_id", owner).in("id", all.slice(i, i + 100)).eq("status", "left_out").in("reason", ["outside_dates", "before_tour"])
        .select("id");
      if (r.error) return null;
      back += (r.data ?? []).length;
    }
  }
  return back;
}

/* One read of every bank a person has linked.
     kind:    who asked (timer, app, refresh, catchup, rescan), for the ledger.
     catchup: read every connection from the start.
     all:     the same, asked for by the server itself (saving the card dates).
   A connection is also read from the start when it has no place saved yet, or
   when it is owed a full read (fullReadOwed). Any read from the start keeps
   the same promises: it only ever adds rows, nothing in the run files itself,
   what is already here is changed only as applyChanges says, and the saved
   place is replaced only after everything is written. */
interface SyncOpts { refresh?: boolean; catchup?: boolean; all?: boolean; kind?: string }
async function syncFeed(feed: Feed, opts: SyncOpts = {}): Promise<Obj> {
  try {
    return await readBanks(feed, opts);
  } catch (e) {
    // Whatever stopped it, the feed must not go on saying the last read went well. No bank's place has moved.
    const status = e instanceof PlaidError ? e.message : "failed";
    await noteStatus(feed.owner_id, status);
    return { ok: false, status };
  }
}
async function readBanks(feed: Feed, opts: SyncOpts): Promise<Obj> {
  const owner = feed.owner_id;
  const kind = opts.catchup ? "catchup" : (opts.kind ?? "app");
  const everything = !!opts.catchup || !!opts.all;
  const items = await itemsFor(owner);
  // (Not being able to read the list of banks is not "no bank is connected".)
  if (!items) { await noteStatus(owner, "failed"); return { ok: false, status: "failed" }; }
  if (!items.length) return { ok: false, status: "not_connected" };
  const accounts: Record<string, Account> = {};
  for (const [id, a] of Object.entries(feed.accounts ?? {})) accounts[id] = { ...a };
  const txs: Obj[] = [];
  const now = Date.now();
  const runRank = (4e12 - now) * 1000;
  const cursors = new Map<string, string | null>();
  const problems: string[] = [];
  const reads: Read[] = [];
  let held = false;   // something in this run was read from the start
  // (Never in test mode, where nothing is saved and every read starts from the start anyway.)
  const owed = TEST || !feed.switched_on || everything ? new Map<string, string>() : await fullReadOwed(owner, items);

  for (const item of items) {
    const read: Read = { item: item.item_id, institution: String(item.institution ?? ""), kind, fromStart: false, status: "ok", sent: 0, pending: 0, more: false };
    try {
      const token = await unseal(item.token_enc);
      if (opts.refresh) { try { await plaidCall("/transactions/refresh", { access_token: token }); } catch { /* the regular read still runs */ } }
      await accountsFor(item, token, accounts);
      if (!feed.switched_on) continue;
      // (A read from the start does not throw the saved place away first: it is only replaced once everything is safely written.)
      const why = owed.get(item.item_id);
      const fromStart = everything || !item.cursor || !!why;
      /* A read from the start is told today's lines only, never which lines
         the bank has taken back since the saved place; and that place is
         replaced when this run ends, so the notice would be lost for good and
         a withdrawn line would stay in the pile beside its replacement. So
         the bank is first asked once from the saved place, for that list
         alone. (The same read-only request as every other read. If it fails,
         the run goes on without it.) */
      let tookBack: Obj[] = [];
      if (fromStart && item.cursor) {
        try { tookBack = (await pull(item, token)).removed; } catch { tookBack = []; }
      }
      const got = await pull(fromStart ? { ...item, cursor: null } : item, token);
      // (Only the ones that are not in the full list: a line the bank sends there is alive.)
      if (tookBack.length) carryRemoved(got, tookBack);
      // Each line is opened inside its own try (takeRead): one the code cannot read is kept, waiting, and stops nothing.
      const took = takeRead(got, accounts, now, item.item_id, fromStart, runRank + txs.length);
      if (fromStart && took.txs.length) held = true;
      for (const t of took.txs as Obj[]) txs.push(t);
      // A connection's place is noted only after its lines were opened.
      cursors.set(item.item_id, got.cursor);
      read.fromStart = fromStart; read.sent = Number(took.sent); read.pending = Number(took.pending); read.more = got.more;
      read.kind = opts.catchup ? "catchup" : (why === "rescan" || opts.kind === "rescan") ? "rescan" : (fromStart && kind === "timer") ? "check" : kind;
    } catch (e) {
      const code = e instanceof PlaidError ? e.message : "failed";
      problems.push(code);
      read.status = code;
      await admin.from("plaid_items").update({ status: code, updated_at: new Date().toISOString() })
        .eq("owner_id", item.owner_id).eq("item_id", item.item_id);
    }
    if (feed.switched_on) reads.push(read);
    if (read.status === "ok" && item.status !== "ok") {
      await admin.from("plaid_items").update({ status: "ok" }).eq("owner_id", item.owner_id).eq("item_id", item.item_id);
    }
  }

  if (!feed.switched_on) {
    await admin.from("feed").update({ accounts }).eq("owner_id", owner);
    return { ok: true, status: "off" };
  }

  /* How a run ends when something could not be read or saved: no bank's place
     moves (so the same lines are read again next time, and what was written
     cannot come in twice), the feed says so, and the ledger keeps the attempt. */
  const stop = async (status: string, counts: Record<string, unknown> | null, extra: Obj = {}): Promise<Obj> => {
    await noteStatus(owner, status);
    if (!TEST) await writeReads(owner, readRows(owner, reads, counts, status, now));
    return { ok: false, status, ...extra };
  };

  // Not knowing the tours is not "there are no tours": stop, save nothing, keep the place.
  const tours = await toursOf(owner);
  if (!tours) return await stop("save_failed", null);
  // A read from the start (a catch-up, a check, or a connection with no place saved) brings months at once:
  // nothing in such a run files itself, whatever an account is set to.
  const hold = everything || held;
  const labels: Obj = {};
  const { data: labelRows } = await admin.from("labels").select("id, doc").eq("owner_id", owner);
  for (const l of labelRows ?? []) labels[l.id] = l.doc;
  /* "Before the tour" rows the function before this one stored as set aside
     (any it wrote after migration 0136 had moved the older ones): they are the
     server's own, and are left out with their reason like the rest. A person's
     set-aside never carries those words. */
  if (!TEST && hold) {
    await admin.from("feed_items").update({ status: "left_out", reason: "before_tour" })
      .eq("owner_id", owner).eq("status", "skipped").eq("why", "Before the tour").is("decided_at", null);
  }
  const ids = [...new Set(txs.map((t) => String(t.id)))];
  const known = new Map<string, Obj>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data: seen, error: seenErr } = await admin.from("feed_items").select("id, status, amount, reason, date, bank_amount, gone_on")
      .eq("owner_id", owner).in("id", ids.slice(i, i + 100));
    // Not knowing what is already here is not "nothing is here": stop, save nothing, keep the place.
    if (seenErr) return await stop("save_failed", null);
    for (const s of (seen ?? []) as Obj[]) known.set(String(s.id), s);
  }
  if (!TEST) await fixDates(owner, txs, known, tours);
  const sorted = sortTransactions(txs, accounts, tours, labels, known, owner, now, incomeAccounts(accounts), hold);
  const rows = sorted.items as Obj[];
  const toFile = sorted.toFile as Map<string, Bucket>;
  const deposits = sorted.deposits as Dep[];
  const payments = sorted.payments as Dep[];
  const counts = sorted.ledger as Record<string, unknown>;
  const filed = rows.filter((i) => i.status === "filed").length;
  const waiting = rows.filter((i) => i.status === "waiting").length;
  // For the catch-up's own sentence: how many of each kind came in, and between which days. Counts and dates only.
  const kindOf = (w: string): "zelle" | "wire" | "transfer" | "other" =>
    /^Zelle/.test(w) ? "zelle" : /^Wire/.test(w) ? "wire" : /^Transfer/.test(w) ? "transfer" : "other";
  const tally = { zelle: 0, wire: 0, transfer: 0, other: 0, maybe: 0 };
  let firstDay = "", lastDay = "";
  for (const r of rows) {
    if (r.status !== "waiting") continue;
    if (r.why === "Maybe already in") tally.maybe += 1; else tally[kindOf(String(r.why))] += 1;
    const d = String(r.date);
    if (!firstDay || d < firstDay) firstDay = d;
    if (!lastDay || d > lastDay) lastDay = d;
  }
  const found = { ...tally, from: firstDay, to: lastDay };
  /* The ledger. What each bank handed over (counted when its answer was
     opened) against what became of every line (counted as each was sorted).
     Every posted line must be somewhere; unexplained is the gap, and it must be 0. */
  const lines = readRows(owner, reads, counts, null, now);
  const ledger = ledgerSum(lines);
  const short = lines.some((l) => Number(l.unexplained) !== 0);

  // Test mode: say what would happen, save nothing.
  if (TEST) {
    await admin.from("feed").update({ accounts, last_run: new Date().toISOString(), last_status: problems[0] ?? "ok" })
      .eq("owner_id", owner);
    return { ok: !problems.length, status: problems[0] ?? "ok", test: true, seen: txs.length, filed, waiting, found, catchup: !!opts.catchup, ledger };
  }

  for (const b of toFile.values()) {
    const imp: Obj = {};
    imp["cards-" + now] = { createdAt: now, count: b.n, total: Math.round(b.total * 100) / 100, source: "Card feed" };
    const r = await admin.rpc("file_charges", { t_id: b.tour.id, add: b.charges, imp });
    if (r.error) return await stop("save_failed", counts);
  }
  /* The account list first, with each name as the bank gives it now: the
     database finds a personal account by its name as each row lands, and a
     row written under a name the list does not hold yet would stay in the
     tour's pile instead of going to that person's own inbox. */
  if (rows.length) {
    const namesSaved = await admin.from("feed").update({ accounts }).eq("owner_id", owner);
    if (namesSaved.error) return await stop("save_failed", counts);
  }
  let unsaved = 0;
  for (let i = 0; i < rows.length; i += 200) {
    // (Only ever adds: a row that is already here, waiting, filed, left out or set aside, is left exactly as it is.)
    const chunk = rows.slice(i, i + 200);
    const r = await admin.from("feed_items").upsert(chunk, { onConflict: "owner_id,id", ignoreDuplicates: true });
    if (!r.error) continue;
    // One row the database refuses must not keep the rest of its batch out: each on its own.
    for (const row of chunk) {
      const one = await admin.from("feed_items").upsert([row], { onConflict: "owner_id,id", ignoreDuplicates: true });
      if (one.error) unsaved += 1;
    }
  }
  // A row that is still refused is a line with no record: the place stays, so it is read again.
  if (unsaved) return await stop("save_failed", counts, { unsaved });
  /* The tripwire looks at the database, not at this run's own counts. Every
     row this run meant to store is asked for by its id (a hundred at a time,
     as the read of what was already here). One that is not there, whatever
     the reason (a write that said yes and kept nothing, a row taken out again
     meanwhile), is a line with no record: the run ends save_failed, no bank's
     place moves, and the ledger rows of this run say so. Not being able to
     look is the same as not being there. */
  const meant = rows.map((r) => String(r.id));
  let missing = 0;
  for (let i = 0; i < meant.length; i += 100) {
    const part = meant.slice(i, i + 100);
    const { data: there, error: thereErr } = await admin.from("feed_items").select("id").eq("owner_id", owner).in("id", part);
    if (thereErr) return await stop("save_failed", counts);
    missing += notThere(part, there).length;
  }
  if (missing) return await stop("save_failed", counts, { unsaved: missing });
  const back = await applyChanges(owner, sorted.changes as Obj[], G.ymd(new Date(now)));
  if (back == null) return await stop("save_failed", counts);
  if (deposits.length) {
    const d = await admin.from("merch_deposits").upsert(
      deposits.map((d) => ({ owner_id: owner, id: d.id, date: d.date, amount: d.amount, atvenu: !!d.av, watch: d.watch ?? "merch" })),
      { onConflict: "owner_id,id", ignoreDuplicates: true });
    // Deposits live nowhere else: if they did not save, the place must not move past them.
    if (d.error) return await stop("save_failed", counts);
  }
  const paid = await settleMerch(owner, tours);
  const guaranteesIn = await settleGuarantees(owner, tours);
  const paidOff = await applyPayments(tours, accounts, payments);
  await markOwed(tours, accounts, new Map(items.map((i) => [i.item_id, i.institution])));
  /* The tripwire. A posted line that ended nowhere (it can only be one with
     no id to store it under, or a fault in the sorter) stops every bank's
     place from moving, and the feed says so. What was written above stays; a
     second read cannot double it. */
  if (short) return await stop("lines_missing", counts, { filed, waiting, found, catchup: !!opts.catchup, ledger });
  // Everything is saved: now each connection's place can move on.
  const at = new Date().toISOString();
  for (const [itemId, cursor] of cursors) {
    const u = await admin.from("plaid_items").update({ cursor, last_ok: at, updated_at: at })
      .eq("owner_id", owner).eq("item_id", itemId);
    // (The place matters more than the day it was saved.)
    if (u.error) await admin.from("plaid_items").update({ cursor, updated_at: at }).eq("owner_id", owner).eq("item_id", itemId);
  }
  await writeReads(owner, lines);
  await admin.from("feed").update({
    accounts, last_run: new Date().toISOString(), last_status: problems[0] ?? "ok",
  }).eq("owner_id", owner);
  if (!problems.length) await reorderOnce(owner, items);
  return { ok: !problems.length, status: problems[0] ?? "ok", filed, waiting, merchPaid: paid, guaranteesIn, paidOff,
    found, catchup: !!opts.catchup, ledger, nowInside: back };
}

/* Once: the bank's order, read fresh from the start, and every waiting
   charge takes its place in it (within a day, the order the card's own app
   shows). It reads only; nothing is filed, moved or saved but that place.
   The order kept from the first read slipped for a charge whose date was
   corrected after it arrived. If the bank is busy, it tries next time. */
async function reorderOnce(owner: string, items: Item[]) {
  const { data: f } = await admin.from("feed").select("ordered_at").eq("owner_id", owner).maybeSingle();
  if (!f || f.ordered_at) return;
  const ids: string[] = [];
  try {
    for (const item of items) {
      const token = await unseal(item.token_enc);
      let cursor = "";
      for (let page = 0; page < 40; page++) {
        const j = await plaidCall("/transactions/sync", { access_token: token, count: 500, ...(cursor ? { cursor } : {}) });
        for (const t of (j.added ?? []) as Obj[]) if (!t.pending) ids.push(String(t.transaction_id));
        cursor = String(j.next_cursor ?? "");
        if (!j.has_more) break;
      }
    }
  } catch { return; }
  if (!ids.length) return;
  const base = (4e12 - Date.now()) * 1000;
  const pos = new Map(ids.map((id, i) => [id, i]));
  const { data: waiting } = await admin.from("feed_items").select("id").eq("owner_id", owner).eq("status", "waiting");
  for (const r of waiting ?? []) {
    const i = pos.get(String(r.id));
    if (i == null) continue;
    await admin.from("feed_items").update({ seq: base + i }).eq("owner_id", owner).eq("id", r.id);
  }
  await admin.from("feed").update({ ordered_at: new Date().toISOString() }).eq("owner_id", owner);
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
  // (Every save here is checked. A bank that looks connected at Plaid but was not saved here is answered as an error, never as "connected".)
  const kept = await admin.from("plaid_items").upsert({
    owner_id: uid, item_id: itemId, env: ENV, institution, token_enc: await seal(token),
    cursor: null, status: "ok", updated_at: new Date().toISOString(),
  }, { onConflict: "owner_id,item_id" });
  if (kept.error) throw new PlaidError("save_failed");
  const { data: row, error: rowErr } = await admin.from("feed").select("*").eq("owner_id", uid).maybeSingle();
  // The first bank here (or the first real one after test mode) starts
  // the feed over, so nothing files until the manager has set it up.
  // Not being able to read the feed or the other banks is not "this is the
  // first bank": the feed (switched on or off, each account's answers) is
  // never started over on a failed read.
  const all = await itemsFor(uid);
  if (rowErr || !all) throw new PlaidError("save_failed");
  const others = all.filter((i) => i.item_id !== itemId);
  const fresh = !row || (row as Feed).source !== "plaid" || !others.length;
  const accounts: Record<string, Account> = fresh ? {} : { ...((row as Feed).accounts ?? {}) };
  await accountsFor({ item_id: itemId } as Item, token, accounts);
  const saved = fresh
    ? await admin.from("feed").upsert({
      owner_id: uid, source: "plaid", plan_name: "", plan_id: "", accounts, switched_on: false,
      since: null, knowledge: null, last_run: null, last_status: "", merch_account: null, personal_token: false,
    }, { onConflict: "owner_id" })
    : await admin.from("feed").update({ accounts }).eq("owner_id", uid);
  if (saved.error) throw new PlaidError("save_failed");
  return institution;
}

// Two docs for the same band (a tour, or the band's Off Tour book), not deleted.
function sameBand(a: Obj | null | undefined, b: Obj | null | undefined): boolean {
  if (!a || !b || a.deletedAt) return false;
  const k = (d: Obj) => String(d.artist ?? "").trim().toLowerCase();
  return !!k(a) && k(a) === k(b);
}
// The band's next tour: the soonest that hasn't started yet.
function nextTourOf(band: { id: string; doc: Obj }[], exceptId: string): { id: string; doc: Obj } | null {
  const today = G.ymd(new Date());
  let best: { id: string; doc: Obj; start: string } | null = null;
  for (const t of band) {
    if (t.id === exceptId || t.doc.kind === "offtour") continue;
    const st = String(G.tourStart(t.doc) ?? "");
    if (!st || st <= today) continue;
    if (!best || st < best.start) best = { ...t, start: st };
  }
  return best;
}

/* Who may work a tour's card charges: its owner, and a member with ALL
   ACCESS whose tour role is Tour Manager. Either one refreshes, sorts and
   files, and the other never has to do it again. Gives back the tour's owner
   (the charges come from their bank connection), or null. */
async function cardLead(uid: string, tourId: string): Promise<string | null> {
  if (!uid || !tourId) return null;
  const { data: t } = await admin.from("tours").select("owner_id, doc").eq("id", tourId).maybeSingle();
  const doc = (t?.doc ?? {}) as Obj;
  if (!t || doc.deletedAt) return null;
  if (t.owner_id === uid) return String(t.owner_id);
  // The band's Off Tour book: the tour manager of any of the band's tours.
  let ids = [tourId];
  if (doc.kind === "offtour") {
    const { data: band } = await admin.from("tours").select("id, doc").eq("owner_id", t.owner_id);
    ids = (band ?? []).filter((b) => sameBand(b.doc as Obj, doc) && (b.doc as Obj)?.kind !== "offtour").map((b) => String(b.id));
    if (!ids.length) return null;
  }
  const { data: ms } = await admin.from("members").select("role, tour_role, overrides")
    .in("tour_id", ids).eq("user_id", uid);
  const { data: p } = await admin.from("profiles").select("tour_role").eq("user_id", uid).maybeSingle();
  const lead = (ms ?? []).some((m) => {
    const ov = (m.overrides ?? {}) as Obj;
    return m.role === "editor" && String(ov.tourRole || p?.tour_role || m.tour_role || "").trim().toLowerCase() === "tour manager";
  });
  return lead ? String(t.owner_id) : null;
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
    const { data: feeds, error: feedsErr } = await admin.from("feed").select("*").eq("source", "plaid").eq("switched_on", true);
    // (Not being able to read the feeds is not "there are none".)
    if (feedsErr) return reply(200, { ran: 0, results: [], error: "failed" });
    const out: string[] = [];
    for (const f of (feeds ?? []) as Feed[]) {
      if (f.last_run && Date.now() - Date.parse(f.last_run) < 10 * 60_000) { out.push("recent"); continue; }
      // An ordinary read; a bank that is owed its weekly full check is read from the start in the same run
      // (kind "check": adds only, nothing files itself). See fullReadOwed.
      try { out.push(String((await syncFeed(f, { kind: "timer" })).status)); }
      catch { await noteStatus(f.owner_id, "failed"); out.push("failed"); }
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
        let got = await pull({ cursor: null } as Item, token);
        for (let i = 0; i < 5 && !got.added.length; i++) {
          await new Promise((r) => setTimeout(r, 2500));
          got = await pull({ cursor: null } as Item, token);
        }
        const posted = got.added.filter((t) => !t.pending);
        const dates = posted.map((t) => String(t.date)).sort();
        const doc = { shows: { a: { date: dates[0] ?? G.ymd(new Date()) }, b: { date: dates[dates.length - 1] ?? G.ymd(new Date()) } },
          cardLog: { from: "tour", to: "tour" } };
        const tours: Tour[] = [{ id: "t", doc, win: G.cardWindow(doc) }];
        const now = Date.now();
        const took = takeRead(got, accounts, now, "t", true, 0);
        const r = sortTransactions(took.txs, accounts, tours, {}, new Map(), "o", now, new Map(), false);
        const sorted = r.items as Obj[];
        const count = (s: string) => sorted.filter((x) => x.status === s).length;
        const line = ledgerLine(Number(took.sent), Number(took.pending), r.ledger.t);
        return reply(200, {
          ok: true, env: ENV, keyLockRoundTrip: roundTrip,
          products: it.products ?? it.billed_products ?? [], availableProducts: it.available_products ?? [],
          accounts: Object.values(accounts).map((a) => a.type + " \u2192 " + a.mode),
          transactions: { posted: posted.length, pending: got.added.length - posted.length },
          sorted: { filed: count("filed"), waiting: count("waiting"), skipped: count("skipped"), leftOut: count("left_out"),
            ignored: posted.length - sorted.length },
          // Counts only: what the bank sent against what became of each line. unexplained must be 0.
          ledger: { sent: line.bank_sent, waiting: line.new_waiting, filed: line.new_filed, leftOut: line.new_left_out,
            reasons: line.reasons, moneyIn: line.not_kept.money_in, unexplained: line.unexplained },
          sample: sorted.slice(0, 6).map((x) => [x.date, x.merchant, x.amount, x.status, x.why || x.category]),
        });
      } finally {
        await plaidCall("/item/remove", { access_token: token }).catch(() => null);
      }
    }

    if (server || !uid) return reply(401, { error: "not_signed_in" });
    if (!Deno.env.get("PLAID_CLIENT_ID") || !Deno.env.get("PLAID_SECRET") || !Deno.env.get("PLAID_TOKEN_KEY")) {
      return reply(200, { ok: false, status: "not_set_up" });
    }

    // A tour's card charges waiting for a look, for its owner or its tour
    // manager: one pile, whoever gets to it first.
    if (action === "pile") {
      const tourId = String(body.tourId ?? "");
      const owner = await cardLead(uid, tourId);
      if (!owner) return reply(403, { error: "not_allowed" });
      // (A read that fails is answered as a failure, never as "no bank" or as an empty pile.)
      const { data: f, error: fErr } = await admin.from("feed").select("accounts, switched_on, last_run, last_status, source")
        .eq("owner_id", owner).maybeSingle();
      if (fErr) return reply(200, { ok: false, status: "failed" });
      if (!f || f.source !== "plaid") return reply(200, { ok: true, connected: false, items: [] });
      /* This tour's pile: the rows waiting for this tour, the rows waiting for
         no tour, and, for the person whose banks these are, the rows whose
         tour was taken down or is gone (they count as no tour, or nobody
         would ever see them). A tour's Manager who is not that person is
         handed this tour's rows and the no-tour rows only: a row that belongs
         to another tour of the owner's, taken down or not, is not theirs to
         see. The tour is part of the question, and the answer is read page
         after page until an empty page, each starting where the last one
         ended, so another tour's rows cannot crowd this one's out and a
         project that hands back fewer rows a request than asked for cannot
         cut the pile short. */
      const mine = owner === uid;
      const live = await liveTourIds(owner);
      if (!live) return reply(200, { ok: false, status: "failed" });
      const plain = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);
      const inQuery = plain(tourId) && [...live].every(plain);
      const want = "tour_id.is.null,tour_id.eq." + tourId + (mine && live.size ? ",tour_id.not.in.(" + [...live].join(",") + ")" : "");
      const rows: Obj[] = [];
      // (Up to 2,000 pages and 200,000 rows; the list ends on an empty page. See nextPage.)
      let from = 0;
      for (let turn = 0; turn < 2000 && from >= 0 && from < 200_000; turn++) {
        let q = admin.from("feed_items")
          .select("id, tour_id, date, posted, seq, merchant, amount, category, account, why")
          .eq("owner_id", owner).eq("status", "waiting");
        // (A tour id with an odd character in it cannot go into the question: every waiting row is read and the same rule is applied below.)
        if (inQuery) q = q.or(want);
        const { data: page, error: pageErr } = await q.order("date").order("id").range(from, from + 999);
        if (pageErr) return reply(200, { ok: false, status: "failed" });
        const got = (page ?? []) as Obj[];
        for (const r of got) {
          const tid = r.tour_id == null || r.tour_id === "" ? null : String(r.tour_id);
          // (Another tour's row is never shown; a taken-down or missing tour's row is shown to the owner only. See pilePlace.)
          const place = pilePlace(tid ?? "", tourId, live, mine);
          if (!place) continue;
          // (The account's name as it should read, so it matches the list of cards below. See cleanName.)
          const row = { ...r, account: cleanName(r.account), why: cleanName(r.why) };
          rows.push(place === "none" && tid ? { ...row, tour_id: null } : row);
        }
        from = nextPage(from, got.length);
      }
      const cards: Obj = {};
      for (const a of Object.values((f.accounts ?? {}) as Record<string, Account>)) cards[cleanName(a.name)] = isCredit(a) ? "credit" : "debit";
      /* feedStatus: how the last read of the owner's banks ended, as one word
         (ok, or a code such as ITEM_LOGIN_REQUIRED). No bank's name: a Manager
         is told that a bank needs a sign-in, not which. */
      const answer: Obj = {
        ok: true, connected: true, switchedOn: !!f.switched_on, lastRun: f.last_run, cards, mine,
        items: rows, feedStatus: String(f.last_status ?? ""),
      };
      if (mine) {
        // Every row of this owner still waiting, on any tour or none: so the screen can say "38 waiting, 9 of them here".
        // (Other tours' numbers are the owner's alone.)
        const { count: total, error: totalErr } = await admin.from("feed_items").select("id", { count: "exact", head: true })
          .eq("owner_id", owner).eq("status", "waiting");
        answer.total = totalErr || total == null ? null : total;
      }
      return reply(200, answer);
    }

    // File a tour's charges, once. Only charges still waiting move, so when
    // the owner and the tour manager sort the same pile, the first one to save
    // wins and the other is told those were already done. The amounts, dates
    // and merchants come from the bank's copy, never from the phone.
    if (action === "file") {
      const tourId = String(body.tourId ?? "");
      const owner = await cardLead(uid, tourId);
      if (!owner) return reply(403, { error: "not_allowed" });
      const { data: tr } = await admin.from("tours").select("doc").eq("id", tourId).maybeSingle();
      const baseDoc = (tr?.doc ?? {}) as Obj;
      const valid = new Set((G.chargeCategoriesFor(baseDoc) as Obj[]).map((c) => String(c.key)));
      valid.delete("offdebt");
      const want = new Map<string, Obj>();
      for (const pk of ((Array.isArray(body.picks) ? body.picks : []) as Obj[]).slice(0, 500)) {
        const id = String(pk.id ?? "");
        if (!id) continue;
        if (pk.keep && !valid.has(String(pk.category ?? ""))) return reply(400, { error: "bad_category" });
        want.set(id, pk);
      }
      if (!want.size) return reply(200, { ok: true, filed: 0, skipped: 0, already: 0, total: 0, refused: 0 });
      // A row whose tour was taken down or is gone counts as on no tour (the pile shows it on every tour).
      const live = await liveTourIds(owner);
      if (!live) return reply(200, { ok: false, status: "save_failed" });
      const asked = [...want.keys()];
      const was = new Map<string, string | null>();
      for (let i = 0; i < asked.length; i += 100) {
        const { data: cand, error: candErr } = await admin.from("feed_items").select("id, tour_id")
          .eq("owner_id", owner).eq("status", "waiting").in("id", asked.slice(i, i + 100));
        // (Not being able to read them is not "someone else sorted them already".)
        if (candErr) return reply(200, { ok: false, status: "save_failed" });
        for (const r of cand ?? []) {
          // (A taken-down or missing tour's row is the owner's alone to sort, as in the pile.)
          if (!r.tour_id || r.tour_id === tourId || (owner === uid && !live.has(String(r.tour_id)))) was.set(String(r.id), r.tour_id ?? null);
        }
      }
      const pick = (keep: boolean) => [...want.values()]
        .filter((pk) => !!pk.keep === keep && was.has(String(pk.id))).map((pk) => String(pk.id));
      // (Each row it moves is added to `into` as it goes, so a stop half way still knows what was moved.)
      const claim = async (ids: string[], patch: Obj, into: Obj[]) => {
        for (let i = 0; i < ids.length; i += 100) {
          const { data, error } = await admin.from("feed_items").update(patch)
            .eq("owner_id", owner).eq("status", "waiting").in("id", ids.slice(i, i + 100))
            .select("id, date, posted, merchant, amount, account");
          if (error) throw new PlaidError("save_failed");
          for (const r of (data ?? []) as Obj[]) into.push(r);
        }
      };
      // Who decided, and when: kept on the row.
      const stamp = { decided_at: new Date().toISOString(), decided_by: uid };
      /* Setting a line aside is a person's act, and the request has to say so
         (by: "hand"). Builds of the app from before Oct 10 set look-alike rows
         aside by themselves through this door; without the word those picks
         are left waiting, exactly as they were, and counted as refused. */
      const aside = pick(false);
      const byHand = body.by === "hand";
      const refused = byHand ? 0 : aside.length;
      const reasonOf = (id: string) => {
        const r = String(want.get(id)?.reason ?? "");
        return r === "same_as_typed" || r === "paid_back" ? r : "set_aside";
      };
      const got: Obj[] = [];
      const skipped: Obj[] = [];
      // The rows whose charge reached a tour in this request, and the tours that were written.
      const onTour = new Set<string>();
      const wrote = new Set<string>();
      let writing = true;     // until every charge is on its tour
      /* Rows marked filed whose charge reached no tour go back to waiting,
         exactly as they were. A row whose charge did land stays filed: putting
         it back would leave it both on the tour and in the pile. A write that
         answered with an error may have landed all the same (the answer was
         lost on the way back), so the owner's tours are read again first, and
         a row whose charge is on any of them stays filed. If the tours cannot
         be read, nothing is put back: a row that says filed on no tour is
         listed for its owner with "Put back" (which looks at the tours again),
         while a row put back whose charge did land could be filed twice. */
      const putBack = async () => {
        const loose = got.filter((r) => !onTour.has(String(r.id)));
        if (!loose.length) return;
        let held = new Set<string>();
        try {
          const { data: all, error: allErr } = await admin.from("tours").select("id, doc").eq("owner_id", owner);
          if (allErr) return;
          held = chargesHeld(all ?? []) as Set<string>;
        } catch { return; }
        for (const r of loose) {
          if (held.has(String(r.id))) continue;
          await admin.from("feed_items")
            .update({ status: "waiting", tour_id: was.get(String(r.id)) ?? null, decided_at: null, decided_by: null })
            .eq("owner_id", owner).eq("id", r.id).eq("status", "filed");
        }
      };
      let total = 0, offTour = 0, upcoming = 0;
      // (From here to the catch below is one try. It is not indented further, so the lines inside read as they always did.)
      try {
      await claim(pick(true), { status: "filed", tour_id: tourId, ...stamp }, got);
      got.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      if (byHand) {
        for (const reason of ["set_aside", "same_as_typed", "paid_back"]) {
          await claim(aside.filter((id) => reasonOf(id) === reason), { status: "skipped", reason, ...stamp }, skipped);
        }
      }
      if (got.length) {
        // Where each goes: this tour; the band's Off Tour book (started if the
        // band has none yet), plus a line under this tour's Off Tour Debt; or
        // the band's next tour.
        const baseOff = baseDoc.kind === "offtour";
        const { data: bandRows } = await admin.from("tours").select("id, doc").eq("owner_id", owner);
        const band = (bandRows ?? []).map((b) => ({ id: String(b.id), doc: (b.doc ?? {}) as Obj }))
          .filter((b) => sameBand(b.doc, baseDoc));
        let book = baseOff ? { id: tourId, doc: baseDoc } : band.find((b) => b.doc.kind === "offtour") ?? null;
        const next = nextTourOf(band, tourId);
        const wantsOff = got.some((r) => want.get(String(r.id))!.dest === "off");
        if (wantsOff && !book && String(baseDoc.artist ?? "").trim()) {
          const today = G.ymd(new Date());
          const bid = "off" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const bdoc = { kind: "offtour", artist: String(baseDoc.artist).trim(), name: "Off Tour", setupDone: true,
            offFrom: today.slice(0, 8) + "01", createdAt: Date.now(), shows: {}, expenses: {}, charges: {} };
          const made = await admin.from("tours").insert({ id: bid, owner_id: owner, doc: bdoc });
          if (!made.error) book = { id: bid, doc: bdoc };
        }
        const { data: f } = await admin.from("feed").select("accounts").eq("owner_id", owner).maybeSingle();
        const byName = new Map<string, Account>();
        for (const a of Object.values((f?.accounts ?? {}) as Record<string, Account>)) byName.set(cleanName(a.name), a);
        const { data: me } = await admin.from("profiles").select("full_name, username").eq("user_id", uid).maybeSingle();
        const by = String(me?.full_name || me?.username || "").trim().slice(0, 60);
        const now = Date.now(), importId = "review-" + now;
        const adds = new Map<string, Obj>();
        const into = (tid: string, key: string, ch: Obj) => { const a = adds.get(tid) ?? {}; a[key] = ch; adds.set(tid, a); };
        const landed = new Map<string, string>();
        // Card charges from this tour's pile logged to another tour: a note
        // here, so they leave this tour's card balance without counting here.
        const away: Obj = {};
        got.forEach((r, i) => {
          const pk = want.get(String(r.id))!;
          const amount = Number(r.amount);
          const ch: Obj = {
            date: String(r.date), posted: String(r.posted || r.date), merchant: String(r.merchant), amount, category: String(pk.category),
            // (The account's name as it should read: see cleanName. A card not found by name would be logged as paid.)
            accounted: !!pk.accounted, account: cleanName(r.account), importId, createdAt: now + i,
            paid: !isCredit(byName.get(cleanName(r.account))), ...(by ? { by } : {}),
          };
          const dest = String(pk.dest ?? (baseOff ? "off" : "tour"));
          // A tour picked by name (the current one from the Off Tour book, or
          // an upcoming one): it has to be one of this band's tours.
          const toId = String(pk.to ?? "");
          const other = dest === "next" ? next
            : dest === "tour" && toId && toId !== tourId ? band.find((b) => b.id === toId && b.doc.kind !== "offtour") ?? null : null;
          if (other) {
            into(other.id, "p" + r.id, ch); landed.set(String(r.id), other.id); upcoming += 1;
            if (!baseOff && ch.account) away["p" + r.id] = { account: ch.account, amount, date: ch.date, posted: ch.posted, to: other.id };
          }
          else if (dest === "off" && book && !baseOff) {
            into(book.id, "p" + r.id, { ...ch, fromTour: tourId });
            // Off-tour spending on this tour's card: the tour carries it as debt.
            into(tourId, "p" + r.id, { ...ch, category: "offdebt", offTour: true, offCategory: String(pk.category) });
            landed.set(String(r.id), book.id); offTour += 1;
          } else { into(tourId, "p" + r.id, ch); landed.set(String(r.id), tourId); }
          if (!pk.accounted) total += amount;
        });
        total = Math.round(total * 100) / 100;
        let failed = false;
        for (const [tid, add] of adds) {
          const n = Object.keys(add).length;
          const imp: Obj = { [importId]: { createdAt: now, count: n, total: Math.round(Object.values(add).reduce((x: number, c) => x + Number((c as Obj).amount), 0) * 100) / 100, source: "Card feed" } };
          const saved = await admin.rpc("file_charges", { t_id: tid, add, imp });
          if (saved.error) { failed = true; break; }
          wrote.add(tid);
          for (const k of Object.keys(add)) onTour.add(k.slice(1));
        }
        if (!failed) writing = false;
        if (!failed && Object.keys(away).length) await admin.rpc("set_card_away", { t_id: tourId, add: away });
        for (const [fid, tid] of landed) {
          if (tid !== tourId && wrote.has(tid) && onTour.has(fid)) await admin.from("feed_items").update({ tour_id: tid }).eq("owner_id", owner).eq("id", fid);
        }
        if (failed) {
          // The ones that reached no tour go back in the pile exactly as they were.
          await putBack();
          return reply(200, { ok: false, status: "save_failed" });
        }
        // Learn each merchant for the owner's feed, so it files itself next time.
        const keys = [...new Set(got.map((r) => String(GRS.normMerchant(r.merchant) || "")).filter(Boolean))];
        if (keys.length) {
          const labels: Obj = {};
          const { data: have } = await admin.from("labels").select("id, doc").eq("owner_id", owner).in("id", keys);
          for (const l of have ?? []) labels[l.id] = l.doc;
          for (const r of got) GRS.learnLabel(labels, r.merchant, want.get(String(r.id))!.category);
          await admin.from("labels").upsert(keys.filter((k) => labels[k]).map((k) => ({
            owner_id: owner, id: k, doc: labels[k], updated_at: new Date().toISOString(),
          })), { onConflict: "owner_id,id" });
        }
      }
      } catch (e) {
        // Anything that stops this between marking rows filed and their charges landing on a tour:
        // those rows must not stay "filed" on no tour.
        if (writing) await putBack();
        throw e;
      }
      return reply(200, {
        ok: true, filed: got.length, skipped: skipped.length, total, offTour, upcoming,
        // (already: sorted by someone else a moment earlier. refused: set-asides this request was not allowed to make.)
        already: want.size - got.length - skipped.length - refused, refused,
      });
    }

    // Undo a card charge logged by mistake (owner or tour manager): it comes
    // off wherever it landed, with the Off Tour Debt line or the "logged to
    // another tour" note that came with it, and goes back in the pile as a
    // new charge for the tour it came from.
    if (action === "unfile") {
      const tourId = String(body.tourId ?? "");
      const fid = String(body.id ?? "").replace(/^p/, "");
      const owner = await cardLead(uid, tourId);
      if (!owner || !fid) return reply(403, { error: "not_allowed" });
      const { data: row } = await admin.from("feed_items").select("id, tour_id, status")
        .eq("owner_id", owner).eq("id", fid).maybeSingle();
      if (!row || row.status !== "filed") return reply(200, { ok: false, status: "not_filed" });
      const key = "p" + fid;
      const { data: all } = await admin.from("tours").select("id, doc").eq("owner_id", owner);
      let home: string | null = null;
      for (const t of all ?? []) {
        const d = (t.doc ?? {}) as Obj;
        const ch = ((d.charges ?? {}) as Obj)[key] as Obj | null | undefined;
        const aw = ((d.cardAway ?? {}) as Obj)[key];
        if (ch && typeof ch === "object" && ch.fromTour) home = String(ch.fromTour);
        if (aw) home = String(t.id);
        if ((ch && typeof ch === "object") || aw) {
          const r = await admin.rpc("unfile_charge", { t_id: t.id, k: key });
          if (r.error) return reply(200, { ok: false, status: "save_failed" });
        }
      }
      const back = home ?? row.tour_id ?? null;
      const u = await admin.from("feed_items").update({ status: "waiting", tour_id: back })
        .eq("owner_id", owner).eq("id", fid);
      if (u.error) return reply(200, { ok: false, status: "save_failed" });
      return reply(200, { ok: true, tourId: back });
    }

    // The tour manager's Refresh: the tour owner's cards, read the same way.
    if (action === "sync" && body.tourId) {
      const owner = await cardLead(uid, String(body.tourId));
      if (!owner) return reply(403, { error: "not_allowed" });
      if (owner !== uid) {
        const { data: of, error: ofErr } = await admin.from("feed").select("*").eq("owner_id", owner).maybeSingle();
        if (ofErr) return reply(200, { ok: false, status: "failed" });
        const f = of as Feed | null;
        if (!f || f.source !== "plaid" || !f.switched_on) return reply(200, { ok: false, status: "not_connected" });
        // One refresh a minute between the two of them.
        const last = f.last_run ? Date.parse(f.last_run) : 0;
        if (Date.now() - last < 60_000) return reply(200, { ok: true, status: "recent" });
        // (The count of every bank line, and how many came back inside the card dates, cover all of the
        // owner's tours: they are the owner's alone. A Manager is told how the read went and what it found.)
        return reply(200, forManager(await syncFeed(f, { refresh: !!body.force, kind: body.force ? "refresh" : "app" })));
      }
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


    const { data: row, error: rowErr } = await admin.from("feed").select("*").eq("owner_id", uid).maybeSingle();
    // (A feed that could not be read is not "no feed": nothing below may answer "connect a bank" or clear anything on it.)
    if (rowErr) return reply(200, { ok: false, status: "failed" });
    const feed = row as Feed | null;

    if (action === "status") {
      if (!feed || feed.source !== "plaid") {
        return reply(200, { ok: true, source: feed?.source ?? null, needsConnect: true, test: TEST, allowed: await mayConnect(uid) });
      }
      const items = await itemsFor(uid);
      // (A list of banks that could not be read is not "no bank is connected".)
      if (!items) return reply(200, { ok: false, status: "failed" });
      const live = new Set(items.map((i) => i.item_id));
      const accounts = Object.entries(feed.accounts ?? {}).filter(([, a]) => !a.item || live.has(a.item));
      return reply(200, {
        ok: true, source: "plaid", test: TEST, switchedOn: feed.switched_on, since: feed.since,
        lastRun: feed.last_run, lastStatus: feed.last_status,
        banks: items.map((i) => ({ id: i.item_id, name: i.institution, status: i.status })),
        accounts: accounts.map(([id, a]) => ({ id, name: cleanName(a.name), type: a.type, mode: a.mode, bank: a.item,
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
      /* A tour's card dates changed: every connection is owed a read from the
         start, so lines that were left out for their day and are now inside
         the dates come back to wait. The saved place is NOT thrown away for
         it (it used to be, and a read that then failed had lost its place):
         a note goes in the ledger, and the next read of each bank, the one
         the app asks for straight after this, is a read from the start (kind
         "rescan": adds only, nothing files itself, no day already here is
         touched). The note stands until such a read has succeeded.

         The same note is left for ONE bank when one of its accounts is
         switched back on (from off to Ask me or Log), or is newly marked for
         a kind of income: while it was off its lines were only counted, and
         while it was not marked its deposits were, and the bank's place has
         moved past them. A read from the start brings them in as rows (and
         as deposits), and nothing in such a read files itself.

         The banks are read before anything is saved: if they cannot be, this
         answers "failed" with nothing changed, so the same request sent again
         still shows which account was switched on. */
      // ("" in this list stands for an account that does not say which bank it is from: every bank is then owed.)
      const reopened = reopenedBanks(feed.accounts ?? {}, accounts) as string[];
      let owed: Item[] = [];
      if (body.rescan === true || reopened.length) {
        const banks = await itemsFor(uid);
        if (!banks) return reply(200, { ok: false, status: "failed" });
        owed = body.rescan === true || reopened.includes("") ? banks : banks.filter((i) => reopened.includes(i.item_id));
      }
      const kept = await admin.from("feed").update(patch).eq("owner_id", uid);
      if (kept.error) return reply(200, { ok: false, status: "save_failed" });
      if (owed.length) {
        const noted = await askFullRead(uid, owed);
        // (The note could not be written: read now instead, so the change is not lost.)
        if (!noted && !TEST) {
          try { await syncFeed({ ...feed, ...patch } as Feed, { all: true, kind: "rescan" }); } catch { await noteStatus(uid, "failed"); }
        }
      }
      return reply(200, { ok: true });
    }

    // The balance on each credit card the feed logs, read once when logging
    // starts on a tour (the phone puts it on that tour under Credit card).
    if (action === "balances") {
      const out: Obj[] = [];
      const banks = await itemsFor(uid);
      if (!banks) return reply(200, { ok: false, status: "failed" });
      for (const it of banks) {
        try {
          const j = await plaidCall("/accounts/get", { access_token: await unseal(it.token_enc) });
          for (const a of (j.accounts ?? []) as Obj[]) {
            const mine = (feed.accounts ?? {})[String(a.account_id)];
            if (!mine || mine.type !== "creditCard" || mine.mode === "off") continue;
            const cur = Number(((a.balances ?? {}) as Obj).current);
            if (!isFinite(cur)) continue;
            out.push({ id: String(a.account_id), name: cleanName(mine.name), bank: it.institution || "",
              balance: Math.max(0, Math.round(cur * 100) / 100) });
          }
        } catch { /* that bank's balance can wait */ }
      }
      return reply(200, { ok: true, test: TEST, balances: out });
    }

    if (action === "sync") {
      // Catch up: read every connection from the start again (as far back as the bank gives, 180 days
      // before it was linked). What is already here is known by the bank's own id and is never added
      // twice; what was missed comes in waiting to be sorted; nothing is filed by this read.
      if (body.catchup === true) {
        return reply(200, await syncFeed(feed, { refresh: false, catchup: true }));
      }
      const last = feed.last_run ? Date.parse(feed.last_run) : 0;
      if (!body.force && Date.now() - last < 60_000) return reply(200, { ok: true, status: "recent" });
      // (For the ledger: "refresh" is a person's tap, "app" is the read the app asks for by itself when it opens.)
      return reply(200, await syncFeed(feed, { refresh: !!body.force, kind: body.force ? "refresh" : "app" }));
    }

    // Disconnect one bank (itemId) or all of them. Plaid deletes its key;
    // we delete ours. Charges already on tours stay; they're the tour's now.
    if (action === "disconnect") {
      const items = await itemsFor(uid);
      // (If the list of banks could not be read, nothing is disconnected and nothing is cleared: an empty list here would read as "the last bank is gone".)
      if (!items) return reply(200, { ok: false, status: "failed" });
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
