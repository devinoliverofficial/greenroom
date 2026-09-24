/* Greenroom statement reading: CSV parsing, merchant cleanup, dedupe and label
   learning. Pure logic — no DOM, no network, no storage. */
(function (root) {
  'use strict';

  var G = root.GR || {};

  /* ============================== CSV ============================== */

  function sniffDelimiter(text) {
    var line = String(text).split(/\r?\n/)[0] || '';
    var counts = [[',', 0], [';', 0], ['\t', 0], ['|', 0]];
    var q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { q = !q; continue; }
      if (q) continue;
      for (var j = 0; j < counts.length; j++) if (ch === counts[j][0]) counts[j][1] += 1;
    }
    counts.sort(function (a, b) { return b[1] - a[1]; });
    return counts[0][1] > 0 ? counts[0][0] : ',';
  }

  function parseCSV(text, delim) {
    var d = delim || sniffDelimiter(text);
    var s = String(text == null ? '' : text).replace(/^﻿/, '');
    var rows = [], row = [], cell = '', q = false, i = 0;
    while (i < s.length) {
      var ch = s[i];
      if (q) {
        if (ch === '"') {
          if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
          q = false; i += 1; continue;
        }
        cell += ch; i += 1; continue;
      }
      if (ch === '"') { q = true; i += 1; continue; }
      if (ch === d) { row.push(cell); cell = ''; i += 1; continue; }
      if (ch === '\r') { i += 1; continue; }
      if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; continue; }
      cell += ch; i += 1;
    }
    row.push(cell);
    if (row.length > 1 || String(row[0]).trim() !== '') rows.push(row);
    return rows.map(function (r) { return r.map(function (c) { return String(c).trim(); }); });
  }

  /* ============================== Values ============================== */

  // Handles $1,234.56 / (123.45) / -45.00 / 1 234,56
  function parseAmount(v) {
    if (v == null) return null;
    var t = String(v).trim();
    if (!t) return null;
    var neg = /^\(.*\)$/.test(t) || t.indexOf('-') >= 0;
    t = t.replace(/[()\s$£€]/g, '').replace(/-/g, '').replace(/[A-Za-z]/g, '');
    if (!t) return null;
    // European "1.234,56" — a comma as the decimal mark with dots for thousands.
    if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/,/g, '');
    if (!/^\d+(\.\d+)?$/.test(t)) return null;
    var n = parseFloat(t);
    if (!isFinite(n)) return null;
    return neg ? -n : n;
  }

  var MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
  };

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function iso(y, m, d) {
    if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
    var dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return y + '-' + pad2(m) + '-' + pad2(d);
  }
  function fullYear(y) { return y >= 100 ? y : (y >= 70 ? 1900 + y : 2000 + y); }

  // US card statements are month-first; that is the assumption here.
  function parseDate(v, now) {
    if (v == null) return null;
    var t = String(v).trim();
    if (!t) return null;
    var thisYear = new Date(now == null ? Date.now() : now).getFullYear();
    var m;

    m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t);
    if (m) return iso(+m[1], +m[2], +m[3]);

    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(t);
    if (m) return iso(fullYear(+m[3]), +m[1], +m[2]);

    m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(t);
    if (m) return iso(thisYear, +m[1], +m[2]);

    m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:\s*,)?\s*(\d{4})?/.exec(t);
    if (m && MONTHS[m[1].slice(0, 4).toLowerCase()] || (m && MONTHS[m[1].slice(0, 3).toLowerCase()])) {
      var mo = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
      return iso(m[3] ? +m[3] : thisYear, mo, +m[2]);
    }

    m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s*(\d{4})?/.exec(t);
    if (m) {
      var mo2 = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mo2) return iso(m[3] ? +m[3] : thisYear, mo2, +m[1]);
    }
    return null;
  }

  /* ============================== Columns ============================== */

  var HEADERS = {
    date: ['date', 'transaction date', 'trans date', 'transactiondate', 'posting date', 'post date',
      'posted date', 'posted', 'date posted', 'effective date'],
    desc: ['description', 'merchant', 'merchant name', 'name', 'payee', 'details', 'detail',
      'transaction', 'transaction description', 'memo', 'narrative', 'reference'],
    amount: ['amount', 'transaction amount', 'amt', 'value'],
    debit: ['debit', 'debits', 'withdrawal', 'withdrawals', 'charge', 'charges', 'money out', 'paid out'],
    credit: ['credit', 'credits', 'deposit', 'deposits', 'payment', 'payments', 'money in', 'paid in']
  };

  function headerMatch(cell) {
    var t = String(cell || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    var keys = Object.keys(HEADERS);
    for (var i = 0; i < keys.length; i++) {
      if (HEADERS[keys[i]].indexOf(t) >= 0) return keys[i];
    }
    return null;
  }

  function findHeader(rows) {
    for (var r = 0; r < Math.min(rows.length, 20); r++) {
      var map = {}, hits = 0;
      rows[r].forEach(function (cell, i) {
        var k = headerMatch(cell);
        if (k && map[k] === undefined) { map[k] = i; hits += 1; }
      });
      if (map.date !== undefined && (map.amount !== undefined || map.debit !== undefined) && hits >= 2) {
        return { row: r, cols: map };
      }
    }
    return null;
  }

  // No usable header: work out the columns from what the cells look like.
  function inferColumns(rows, now) {
    var width = rows.reduce(function (w, r) { return Math.max(w, r.length); }, 0);
    var sample = rows.slice(0, 40);
    var dateCol = -1, amountCol = -1, descCol = -1, bestDate = 0, bestAmt = 0, bestLen = 0;
    for (var c = 0; c < width; c++) {
      var dates = 0, amts = 0, len = 0, n = 0;
      sample.forEach(function (r) {
        var v = r[c];
        if (v == null || v === '') return;
        n += 1;
        if (parseDate(v, now)) dates += 1;
        if (parseAmount(v) !== null) amts += 1;
        len += String(v).length;
      });
      if (!n) continue;
      var dRatio = dates / n, aRatio = amts / n, avgLen = len / n;
      if (dRatio > 0.6 && dRatio > bestDate) { bestDate = dRatio; dateCol = c; }
      else if (aRatio > 0.6 && aRatio > bestAmt) { bestAmt = aRatio; amountCol = c; }
      if (dRatio < 0.5 && aRatio < 0.5 && avgLen > bestLen) { bestLen = avgLen; descCol = c; }
    }
    if (dateCol < 0 || amountCol < 0) return null;
    var cols = { date: dateCol, amount: amountCol };
    if (descCol >= 0) cols.desc = descCol;
    return { row: -1, cols: cols };
  }

  /* ============================== Charges ============================== */

  // Payments, credits and refunds are not tour costs.
  var SKIP_PATTERNS = [
    /\bpayment\s+(received|thank|to|posted)\b/i,
    /^payment\b/i,
    /thank\s*you/i,
    /\bauto\s*pay\b/i,
    /\bautopay\b/i,
    /\brefund/i,
    /\breturned?\b/i,
    /statement\s+credit/i,
    /cash\s*back/i,
    /\breversal\b/i,
    /\bcredit\s+adjustment\b/i,
    /\bbalance\s+transfer\b/i
  ];
  function looksLikeCredit(desc) {
    var t = String(desc || '');
    for (var i = 0; i < SKIP_PATTERNS.length; i++) if (SKIP_PATTERNS[i].test(t)) return true;
    return false;
  }

  var PREFIX = /^(sq|tst|sp|py|pp|pos|dd|ec|in|chk|paypal|pmnt|purchase|debit card purchase|pos debit|card purchase|recurring payment|ach debit)\s*\*?\s*[-–]?\s*/i;
  var STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|AB|BC|MB|NB|NL|NS|ON|PE|QC|SK';

  // A deterministic first pass. Claude does the polish, but this stands alone
  // when Claude is unavailable and keeps the fallback readable.
  function cleanMerchant(desc) {
    var t = String(desc || '').trim();
    if (!t) return '';
    for (var i = 0; i < 3; i++) {
      var next = t.replace(PREFIX, '');
      if (next === t) break;
      t = next;
    }
    t = t.replace(/\bx{2,}\d+\b/ig, ' ');                 // masked card tails
    t = t.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, ' '); // phone numbers
    t = t.replace(/\b(https?:\/\/)?www\.[^\s]+/ig, ' ');
    t = t.replace(new RegExp('\\s+(' + STATES + ')\\s*$', 'i'), ' ');
    t = t.replace(/\s#\s*\d+\b/g, ' ');                   // store numbers anywhere
    t = t.replace(/\s\d{3,}\b/g, ' ');
    t = t.replace(/\s+#?\d{3,}\s*$/g, ' ');
    t = t.replace(/[*#]+/g, ' ');
    t = t.replace(/\s{2,}/g, ' ').trim();
    if (!t) return String(desc || '').trim();
    // Shouty statement text reads better in title case.
    if (t === t.toUpperCase()) {
      t = t.toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
    }
    return t;
  }

  function normMerchant(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function chargeKey(c) {
    return String(c.date) + '|' + Math.abs(G.num ? G.num(c.amount) : Number(c.amount)).toFixed(2) +
      '|' + normMerchant(c.merchant);
  }

  /**
   * Read a statement CSV into charges.
   * Returns { ok, charges, skipped, rows, reason }. `charges` carries `description`
   * only so it can be sent for cleaning — it is never persisted.
   */
  function parseStatementCSV(text, opts) {
    var o = opts || {};
    var now = o.now;
    var rows = parseCSV(text, o.delimiter);
    rows = rows.filter(function (r) { return r.some(function (c) { return c !== ''; }); });
    if (rows.length < 2) return { ok: false, reason: 'empty', charges: [], skipped: 0, rows: rows.length };

    var found = findHeader(rows) || inferColumns(rows, now);
    if (!found) return { ok: false, reason: 'columns', charges: [], skipped: 0, rows: rows.length };

    var cols = found.cols;
    var body = rows.slice(found.row + 1);

    var parsed = [];
    body.forEach(function (r) {
      var date = parseDate(r[cols.date], now);
      if (!date) return;
      var desc = cols.desc !== undefined ? r[cols.desc] : '';
      if (!desc) {
        // Some exports split the name across columns; take the longest non-numeric cell.
        var best = '';
        r.forEach(function (cell, i) {
          if (i === cols.date || i === cols.amount) return;
          if (parseAmount(cell) !== null) return;
          if (String(cell).length > best.length) best = String(cell);
        });
        desc = best;
      }
      var amount = null, fromDebit = false;
      if (cols.debit !== undefined || cols.credit !== undefined) {
        var deb = cols.debit !== undefined ? parseAmount(r[cols.debit]) : null;
        var cre = cols.credit !== undefined ? parseAmount(r[cols.credit]) : null;
        if (deb !== null && Math.abs(deb) > 0) { amount = Math.abs(deb); fromDebit = true; }
        else if (cre !== null && Math.abs(cre) > 0) { amount = -Math.abs(cre); }
        else return;
      } else {
        amount = parseAmount(r[cols.amount]);
        if (amount === null || amount === 0) return;
      }
      parsed.push({ date: date, description: String(desc || '').trim(), amount: amount, fromDebit: fromDebit });
    });

    if (!parsed.length) return { ok: false, reason: 'no-rows', charges: [], skipped: 0, rows: rows.length };

    // Banks disagree on which sign means "you spent money". Let the file decide.
    var chargeSign = 1;
    var usingColumns = cols.debit !== undefined || cols.credit !== undefined;
    if (!usingColumns) {
      var neg = 0, pos = 0;
      parsed.forEach(function (p) { if (p.amount < 0) neg += 1; else pos += 1; });
      chargeSign = neg > pos ? -1 : 1;
    }

    var charges = [], skipped = 0;
    parsed.forEach(function (p) {
      var isCharge = usingColumns ? p.fromDebit : (chargeSign < 0 ? p.amount < 0 : p.amount > 0);
      if (!isCharge || looksLikeCredit(p.description)) { skipped += 1; return; }
      charges.push({
        date: p.date,
        amount: Math.abs(p.amount),
        description: p.description,
        merchant: cleanMerchant(p.description)
      });
    });

    if (!charges.length) return { ok: false, reason: 'all-credits', charges: [], skipped: skipped, rows: rows.length };
    return { ok: true, charges: charges, skipped: skipped, rows: rows.length, sign: chargeSign };
  }

  /* ============================== Dedupe ============================== */

  /**
   * Flag charges already imported on this tour. Matching is a multiset against
   * what is already stored, so two identical coffees on the same day both survive
   * a single import while a re-uploaded statement is caught.
   */
  function markDuplicates(incoming, existing) {
    var counts = {};
    (existing || []).forEach(function (c) {
      var k = chargeKey(c);
      counts[k] = (counts[k] || 0) + 1;
    });
    return (incoming || []).map(function (c) {
      var k = chargeKey(c);
      var dup = counts[k] > 0;
      if (dup) counts[k] -= 1;
      return Object.assign({}, c, { duplicate: dup });
    });
  }

  /* ============================== Label learning ============================== */

  /** Labels: { <normalized merchant>: { merchant, cats: { <category>: count } } } */
  function learnedCategory(labels, merchant) {
    var rec = (labels || {})[normMerchant(merchant)];
    if (!rec || !rec.cats) return null;
    var keys = Object.keys(rec.cats).filter(function (k) { return rec.cats[k] > 0; });
    // Labelled two different ways — we do not guess.
    return keys.length === 1 ? keys[0] : null;
  }

  function learnLabel(labels, merchant, category) {
    var out = labels || {};
    var key = normMerchant(merchant);
    if (!key || !category) return out;
    var rec = out[key] || { merchant: String(merchant), cats: {} };
    rec.merchant = String(merchant);
    rec.cats = rec.cats || {};
    rec.cats[category] = (rec.cats[category] || 0) + 1;
    out[key] = rec;
    return out;
  }

  function forgetLabel(labels, merchant) {
    var out = labels || {};
    delete out[normMerchant(merchant)];
    return out;
  }

  /**
   * Fill in what we can. A category is only auto-filled when the merchant has
   * exactly one learned category, or when the reader called it a no-brainer
   * (an airline or a hotel).
   */
  function applyLabels(charges, labels) {
    return (charges || []).map(function (c) {
      var learned = learnedCategory(labels, c.merchant);
      if (learned) return Object.assign({}, c, { category: learned, source: 'learned' });
      if (c.suggested) return Object.assign({}, c, { category: c.suggested, source: 'suggested' });
      return Object.assign({}, c, { category: null, source: null });
    });
  }

  /**
   * Charges dated on or before the cutoff are assumed to be inside a card's
   * opening balance — counting them again would double the money.
   */
  function markPreCutoff(charges, cutoff) {
    return (charges || []).map(function (c) {
      var pre = !!(cutoff && c.date && c.date <= cutoff);
      return Object.assign({}, c, { preCutoff: pre });
    });
  }

  function groupForReview(charges) {
    var needs = [], filled = [], already = [], before = [];
    (charges || []).forEach(function (c) {
      if (c.duplicate) already.push(c);
      else if (c.preCutoff) before.push(c);
      else if (c.category) filled.push(c);
      else needs.push(c);
    });
    return { needs: needs, filled: filled, already: already, before: before };
  }

  root.GRS = {
    sniffDelimiter: sniffDelimiter,
    parseCSV: parseCSV,
    parseAmount: parseAmount,
    parseDate: parseDate,
    findHeader: findHeader,
    inferColumns: inferColumns,
    looksLikeCredit: looksLikeCredit,
    cleanMerchant: cleanMerchant,
    normMerchant: normMerchant,
    chargeKey: chargeKey,
    parseStatementCSV: parseStatementCSV,
    markDuplicates: markDuplicates,
    learnedCategory: learnedCategory,
    learnLabel: learnLabel,
    forgetLabel: forgetLabel,
    applyLabels: applyLabels,
    markPreCutoff: markPreCutoff,
    groupForReview: groupForReview
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
