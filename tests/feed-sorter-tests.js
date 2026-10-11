/* Tests for the bank feed's sorter: the block of supabase/functions/plaid/index.ts
   between "// ---- pure:start ----" and "// ---- pure:end ----".
   Run with tools/run_feed_tests.js (it explains how), which sets FEED to that
   block's functions and FEED_SOURCE to its text.

   The rule under test: store first, label second. Every posted line a bank
   sends must come out exactly once: as a row (waiting, filed, or left out with
   a reason), as a line already here, or as a count of lines not kept (an
   account switched off; money coming in on a bank account). Never nothing. */
(function () {
  'use strict';

  var F = globalThis.FEED, G = globalThis.GR, S = globalThis.GRS;
  var results = [];

  function test(name, fn) {
    try { fn(); results.push({ name: name, ok: true }); }
    catch (e) { results.push({ name: name, ok: false, msg: (e && e.message) || String(e) }); }
  }
  function eq(actual, expected, what) {
    if (actual !== expected) throw new Error((what || 'value') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
  function ok(cond, what) { if (!cond) throw new Error(what || 'expected true'); }
  function has(list, v, what) { if (list.indexOf(v) < 0) throw new Error((what || 'value') + ': ' + JSON.stringify(v) + ' is not one of ' + JSON.stringify(list)); }

  /* ============================== Fixtures ============================== */

  // "Now" is noon on Oct 22, 2026. The tour logs cards Oct 1 to Oct 20.
  var NOW = new Date(2026, 9, 22, 12, 0, 0).getTime();
  var TODAY = '2026-10-22';
  var FRESH = '2026-10-15';        // inside the tour, a week old
  var REASONS = ['card_payment', 'own_move', 'outside_dates', 'before_tour', 'zero', 'bank_removed'];

  function accounts() {
    return {
      card: { name: 'Gold Card ··1111', type: 'creditCard', plaid: 'creditCard', mode: 'log', asked: true, item: 'bankA' },
      cardAsk: { name: 'Blue Card ··2002', type: 'creditCard', plaid: 'creditCard', mode: 'ask', asked: false, item: 'bankA' },
      chk: { name: 'Checking ··1234', type: 'checking', plaid: 'checking', mode: 'ask', asked: true, income: [], item: 'bankA' },
      chkLog: { name: 'Road Checking ··5678', type: 'checking', plaid: 'checking', mode: 'log', asked: true, income: [], item: 'bankA' },
      // a checking account someone answered "Credit card" by a wrong tap
      wrong: { name: 'Wrong Tap ··4321', type: 'creditCard', plaid: 'checking', card: 'credit', mode: 'log', asked: true, income: [], item: 'bankA' },
      // a credit card someone answered "Debit card"
      debitSaid: { name: 'Said Debit ··8080', type: 'checking', plaid: 'creditCard', card: 'debit', mode: 'log', asked: true, income: [], item: 'bankA' },
      sav: { name: 'Savings ··9999', type: 'savings', plaid: 'savings', mode: 'off', asked: true, income: [], item: 'bankA' },
      inc: { name: 'Income Checking ··7777', type: 'checking', plaid: 'checking', mode: 'ask', asked: true, income: ['merch', 'guarantees'], item: 'bankB' }
    };
  }
  var INCOME = new Map([['inc', 'both']]);

  function tourDoc(extra) {
    return Object.assign({
      name: 'Taste Of Chaos', artist: 'Night Drive',
      shows: { a: { date: '2026-10-01' }, b: { date: '2026-10-20' } },
      cardLog: { from: 'tour', to: 'tour' }, charges: {}, expenses: {}
    }, extra || {});
  }
  function bookDoc(extra) {
    return Object.assign({ kind: 'offtour', artist: 'Night Drive', name: 'Off Tour', offFrom: '2026-01-01', shows: {}, charges: {}, expenses: {} }, extra || {});
  }
  function tours(rows) { return F.asTours(rows || [{ id: 't1', doc: tourDoc() }]); }

  // Shell is a merchant the feed has learned (Gas); nothing else is.
  var LABELS = S.learnLabel({}, 'Shell', 'gas');
  // Labels in which every name in a list is learned, so anything the rules would let file itself does.
  function learnedAll(names) {
    var labels = S.learnLabel({}, 'Shell', 'gas');
    names.forEach(function (nm) {
      var payee = S.cleanMerchant(String((Array.isArray(nm) ? (nm[1] || nm[0]) : nm) || ''));
      if (payee) S.learnLabel(labels, payee, 'misc');
    });
    return labels;
  }
  /* The words, wording and heading the rules before these threw a line away
     for, written out again here on their own (not taken from the function), so
     the tests can say "a line like this never files itself". */
  var OLD_WORDS = /\b(e[ -]?payment|autopay|auto[ -]?pay|pmt)\b|^\s*transfer\b|\btransfer (to|from)\b|online (banking )?transfer|starting balance|balance adjustment|payment.{0,12}thank|credit card payment|card ?member serv|(american express|amex).{0,20}(payment|pmt|ach)|bank of america.{0,20}(payment|pmt|credit card)/i;
  var SENT_WORDS = /\bzelle\b|\b(wire (transfer|out|type|fee)|outgoing wire|fedwire|domestic wire|international wire)\b/i;
  function oldRulesHid(l, account) {
    if (!(l.amount > 0)) return false;
    var fields = [l.original_description, l.name, l.merchant_name].filter(function (x) { return typeof x === 'string' && x; });
    if (fields.some(function (x) { return OLD_WORDS.test(x) || SENT_WORDS.test(x); })) return true;
    var card = !!account && (account.plaid === 'creditCard' || account.type === 'creditCard');
    return card && !!l.personal_finance_category && l.personal_finance_category.primary === 'TRANSFER_IN';
  }

  var n = 0;
  function line(o) {
    n += 1;
    return Object.assign({
      transaction_id: 'tx' + n, account_id: 'card', amount: 42.5, date: FRESH, authorized_date: null,
      name: 'SHELL OIL 5744', merchant_name: 'Shell', pending: false,
      personal_finance_category: { primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_GAS' }
    }, o || {});
  }
  function pfc(primary, detailed) { return primary ? { primary: primary, detailed: detailed || primary + '_OTHER' } : undefined; }

  /* One read of one bank, start to finish, the way the server does it:
     open the bank's answer (takeRead), sort it (sortTransactions), close the
     ledger (ledgerLine). */
  function run(added, o) {
    o = o || {};
    var acc = o.accounts || accounts();
    var item = o.item || 'bankA';
    var took = F.takeRead({ added: added, modified: o.modified || [], removed: o.removed || [] }, acc, o.now || NOW, item, !!o.fromStart, 1000);
    var sorted = F.sortTransactions(took.txs, acc, o.tours || tours(), o.labels || LABELS, o.known || new Map(), 'owner-1',
      o.now || NOW, o.income || INCOME, !!o.hold);
    var led = F.ledgerLine(took.sent, took.pending, sorted.ledger[item]);
    return {
      took: took, sorted: sorted, led: led, accounts: acc,
      row: function (id) { return sorted.items.filter(function (r) { return r.id === id; })[0] || null; },
      fate: function (id) { return sorted.fate[id]; }
    };
  }
  function one(o, opts) {
    var l = line(o), r = run([l], opts);
    return { id: l.transaction_id, row: r.row(l.transaction_id), fate: r.fate(l.transaction_id), r: r };
  }
  // What the database would hold after a run, as the next run's "already here" list.
  function knownFrom(items, into) {
    var m = into || new Map();
    items.forEach(function (r) { m.set(r.id, { status: r.status, amount: r.amount, reason: r.reason, date: r.date, bank_amount: null }); });
    return m;
  }

  /* ============================== The block itself ============================== */

  test('the pure block reads and writes nothing: no database, no network, no clock', function () {
    var bad = /\b(admin|Deno|fetch|plaidCall|await|async|Date\.now|Math\.random|console)\b/.exec(globalThis.FEED_SOURCE || '');
    ok(!bad, 'the pure block mentions ' + (bad && bad[0]));
    ok((globalThis.FEED_SOURCE || '').length > 2000, 'the block text was not handed over');
  });
  test('the rules carry a version, starting at 2', function () { eq(F.RULES, 2, 'RULES'); });
  test('every left-out reason has plain words', function () {
    REASONS.forEach(function (k) { ok(typeof F.LEFT_OUT_WORDS[k] === 'string' && F.LEFT_OUT_WORDS[k].length > 3, 'no words for ' + k); });
    Object.keys(F.LEFT_OUT_WORDS).forEach(function (k) {
      ok(!/[!\u2014]|claude|\bband\b/i.test(F.LEFT_OUT_WORDS[k]), 'words for ' + k + ' break the wording rules');
    });
  });

  /* ============================== (a) THE INVARIANT ============================== */

  var ACCTS = ['card', 'cardAsk', 'chk', 'chkLog', 'wrong', 'debitSaid', 'sav', 'inc', 'nobody-knows-this-id'];
  var AMOUNTS = [42.5, 1500, 0.01, -42.5, -1500, 0];
  var LABELSETS = [
    undefined,
    { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE' },
    { primary: 'BRAND_NEW_HEADING', detailed: 'BRAND_NEW_HEADING_NOBODY_HAS_SEEN' },
    { primary: 'OTHER', detailed: 'OTHER_OTHER' },
    { primary: 'BANK_FEES', detailed: 'BANK_FEES_ATM_FEES' },
    { primary: 'INCOME', detailed: 'INCOME_WAGES' },
    { primary: 'TRANSFER_IN', detailed: 'TRANSFER_IN_DEPOSIT' },
    { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER' },
    { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_OTHER_TRANSFER_OUT' },
    { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_WIRE' },
    { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_SAVINGS' },
    { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' },
    { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_WITHDRAWAL' },
    { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_A_NEW_KIND' },
    { primary: 'TRANSFER_OUT' },
    { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' },
    { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CAR_PAYMENT' },
    { primary: 'LOAN_PAYMENTS' }
  ];
  var NAMES = [
    ['SHELL OIL 5744', 'Shell'],
    ['Zelle payment to Pat Example Conf# w1x2y3z4', null],
    ['WIRE TYPE:WIRE OUT DATE:261009 TRN:2026100900123456 BNF:EXAMPLE BUS CO ID:000123456789', null],
    ['VERIZON WIRELESS AUTOPAY', 'Verizon'],
    ['ATT BILL PMT', null],
    ['PARKING PMT', null],
    ['Transfer Station Brewing', null],
    ['Amex Travel Payment', 'Amex Travel'],
    ['AMEX EPAYMENT ACH PMT W1234', 'American Express'],
    ['PAYMENT THANK YOU', null],
    ['CREDIT CARD PAYMENT', null],
    ['ATM WITHDRAWAL 000123 5TH AVE', null],
    ['Online Transfer to SAV ...9999', null],
    ['', null]
  ];
  var DAYS = ['2026-05-02', '2026-09-30', '2026-10-01', '2026-10-03', FRESH, '2026-10-20', '2026-10-21'];
  var ALL_LEARNED = learnedAll(NAMES);
  var WORLDS = {
    'one tour, no Off Tour book': function () { return tours(); },
    'one tour and one Off Tour book': function () { return tours([{ id: 't1', doc: tourDoc() }, { id: 'off1', doc: bookDoc() }]); },
    'one tour with a hand-typed card, two Off Tour books': function () {
      return tours([{ id: 't1', doc: tourDoc({ debts: { d1: { kind: 'card', label: 'Old card', amount: 900, cutoff: '2026-10-03' } } }) },
        { id: 'off1', doc: bookDoc() }, { id: 'off2', doc: bookDoc({ artist: 'Other Artist' }) }]);
    },
    'no tours at all': function () { return tours([]); }
  };

  function checkInvariant(added, r, what) {
    var fate = r.sorted.fate, items = r.sorted.items;
    var ids = added.map(function (l) { return l.transaction_id; });
    // every line the bank sent has exactly one fate
    eq(Object.keys(fate).length, ids.length, what + ': lines with a fate');
    var counts = { waiting: 0, filed: 0, left_out: 0, off: 0, money_in: 0, already: 0 };
    var rowOf = {};
    items.forEach(function (row) {
      ok(!rowOf[row.id], what + ': two rows for ' + row.id);
      rowOf[row.id] = row;
    });
    ids.forEach(function (id) {
      var f = fate[id];
      ok(typeof f === 'string', what + ': ' + id + ' came out nowhere');
      var row = rowOf[id];
      if (f === 'waiting' || f === 'filed') {
        ok(row && row.status === f, what + ': ' + id + ' says ' + f + ' but its row does not');
        eq(row.reason, null, what + ': a ' + f + ' row carries no reason');
        counts[f] += 1;
      } else if (f.indexOf('left_out:') === 0) {
        ok(row && row.status === 'left_out', what + ': ' + id + ' says left out but has no left-out row');
        has(REASONS, row.reason, what + ': reason of ' + id);
        eq('left_out:' + row.reason, f, what + ': fate and row agree');
        ok(row.why && row.why === F.LEFT_OUT_WORDS[row.reason], what + ': a left-out row says why in plain words');
        counts.left_out += 1;
      } else {
        ok(!row, what + ': ' + id + ' is counted as ' + f + ' and must have no row');
        has(['off', 'money_in', 'already'], f, what + ': fate of ' + id);
        counts[f] += 1;
      }
    });
    eq(items.length, counts.waiting + counts.filed + counts.left_out, what + ': rows');
    items.forEach(function (row) {
      has(['waiting', 'filed', 'left_out'], row.status, what + ': status of a new row');
      ok(G.parseDay(String(row.date)), what + ': a row has a real day');
      ok(typeof row.amount === 'number' && isFinite(row.amount), what + ': a row has a real amount');
      ok(typeof row.merchant === 'string' && row.merchant.length > 0, what + ': a row has a name');
      ok('account_id' in row && 'reason' in row && 'gone_on' in row, what + ': every row has the same columns');
      eq(row.owner_id, 'owner-1', what + ': owner');
    });
    // the ledger agrees with the lines, and nothing is unexplained
    eq(r.led.bank_sent, ids.length, what + ': bank_sent');
    eq(r.led.unexplained, 0, what + ': unexplained');
    eq(r.led.new_waiting, counts.waiting, what + ': ledger waiting');
    eq(r.led.new_filed, counts.filed, what + ': ledger filed');
    eq(r.led.new_left_out, counts.left_out, what + ': ledger left out');
    eq(r.led.already_here, counts.already, what + ': ledger already here');
    eq(r.led.not_kept.money_in, counts.money_in, what + ': ledger money in');
    var off = 0, reasons = 0;
    Object.keys(r.led.not_kept.off).forEach(function (k) { off += r.led.not_kept.off[k]; });
    Object.keys(r.led.reasons).forEach(function (k) { has(REASONS, k, what + ': ledger reason'); reasons += r.led.reasons[k]; });
    eq(off, counts.off, what + ': ledger off');
    eq(reasons, counts.left_out, what + ': ledger reasons add up to left out');
    // what files itself is exactly what is in the buckets
    var inBuckets = 0;
    r.sorted.toFile.forEach(function (b, tid) {
      Object.keys(b.charges).forEach(function (k) {
        var row = rowOf[k.slice(1)];
        ok(k.charAt(0) === 'p' && row && row.status === 'filed' && row.tour_id === tid, what + ': a charge files with no filed row for it');
        inBuckets += 1;
      });
      eq(b.n, Object.keys(b.charges).length, what + ': bucket count');
    });
    eq(inBuckets, counts.filed, what + ': charges that file themselves');
    return counts;
  }

  Object.keys(WORLDS).forEach(function (world) {
    [false, true].forEach(function (hold) {
      test('INVARIANT, ' + world + (hold ? ', read from the start' : '') + ': every line comes out exactly once', function () {
        var total = 0, seen = { waiting: 0, filed: 0, left_out: 0, off: 0, money_in: 0, already: 0 };
        var acc = accounts();
        ACCTS.forEach(function (a) {
          DAYS.forEach(function (day) {
            var added = [];
            LABELSETS.forEach(function (lab) {
              NAMES.forEach(function (nm) {
                AMOUNTS.forEach(function (amt) {
                  added.push(line({ account_id: a, amount: amt, date: day, name: nm[0], merchant_name: nm[1], personal_finance_category: lab }));
                });
              });
            });
            var r = run(added, { tours: WORLDS[world](), hold: hold, fromStart: hold, accounts: acc, labels: ALL_LEARNED });
            var c = checkInvariant(added, r, a + ' on ' + day);
            Object.keys(c).forEach(function (k) { seen[k] += c[k]; });
            total += added.length;

            added.forEach(function (l) {
              var f = r.fate(l.transaction_id), row = r.row(l.transaction_id);
              var account = acc[l.account_id];
              var bankCard = !!account && account.plaid === 'creditCard';
              var lab = l.personal_finance_category || {};
              // an account that is switched off: counted, never stored
              if (account && account.mode === 'off') { eq(f, 'off', 'a line on a switched-off account'); return; }
              ok(f !== 'off', 'only a switched-off account is counted as off (' + l.account_id + ')');
              if (l.amount === 0) { eq(f, 'left_out:zero', 'a zero line'); return; }
              if (l.amount > 0 && bankCard) {
                // money out on a card: no word and no label hides it
                has(['waiting', 'filed', 'left_out:outside_dates', 'left_out:before_tour'], f, 'a charge on a card (' + l.name + ')');
              }
              if (l.amount > 0 && !bankCard) {
                // money out of a bank account is only ever left out for one of these
                has(['waiting', 'filed', 'left_out:outside_dates', 'left_out:before_tour', 'left_out:card_payment', 'left_out:own_move'], f,
                  'money out of a bank account (' + l.name + ')');
              }
              if (l.amount < 0 && !bankCard) {
                // money in on a bank account: counted only, unless it is money coming back
                var back = lab.primary === 'TRANSFER_OUT' || lab.primary === 'LOAN_PAYMENTS';
                if (!back) eq(f, 'money_in', 'money in on a bank account');
                else has(['waiting', 'left_out:outside_dates'], f, 'money coming back into a bank account');
              } else {
                ok(f !== 'money_in', 'only money in on a bank account is counted as money in');
              }
              if (l.amount < 0 && bankCard) has(['waiting', 'left_out:card_payment', 'left_out:outside_dates'], f, 'money in on a card');
              // nothing files itself in a read from the start, or older than two weeks, or on an "ask" account
              if (f === 'filed') {
                ok(!hold, 'a line filed itself in a read from the start');
                ok(account && account.mode === 'log', 'a line filed itself on an account that asks first');
                ok(G.daysBetween(row.date, TODAY) <= 14, 'a line older than two weeks filed itself');
                ok(row.category, 'a line filed itself with no learned category');
                ok(l.amount > 0, 'money in filed itself');
                // a line the rules before these would have hidden never files itself
                ok(!oldRulesHid(l, account), 'a line the old rules hid filed itself (' + l.name + ' on ' + l.account_id + ', ' + JSON.stringify(lab) + ')');
              }
              // and one the old rules hid, when it is stored as money out, is waiting or left out
              if (oldRulesHid(l, account) && row) has(['waiting', 'left_out'], row.status, 'a line the old rules hid (' + l.name + ')');
            });
          });
        });
        ok(total > 13000, 'the crossed set is large (' + total + ' lines)');
        if (world === 'no tours at all') {
          // with no tour and no book, every stored line is left out for its day (or for what it is): none waits, none files
          eq(seen.waiting, 0, 'nothing waits when there is no tour to wait on'); eq(seen.filed, 0, 'nothing files');
        } else {
          ok(seen.waiting > 0, 'the set includes lines that wait');
          if (!hold) ok(seen.filed > 0, 'the set includes lines that do file');
          else eq(seen.filed, 0, 'nothing files in a read from the start');
        }
        ok(seen.left_out > 0 && seen.off > 0 && seen.money_in > 0, 'the set reaches every other kind of fate');
      });
    });
  });

  /* ============================== (b) The same read twice ============================== */

  [false, true].forEach(function (fromStart) {
    test('a second identical read' + (fromStart ? ' from the start' : '') + ' adds nothing and changes nothing', function () {
      var acc = accounts(), added = [];
      ['card', 'chk', 'chkLog', 'wrong', 'sav', 'inc', 'cardAsk'].forEach(function (a) {
        ['2026-09-30', FRESH, '2026-10-02'].forEach(function (day) {
          LABELSETS.forEach(function (lab) {
            NAMES.slice(0, 9).forEach(function (nm) {
              [42.5, -42.5, 0].forEach(function (amt) {
                added.push(line({ account_id: a, amount: amt, date: day, name: nm[0], merchant_name: nm[1], personal_finance_category: lab }));
              });
            });
          });
        });
      });
      var world = WORLDS['one tour with a hand-typed card, two Off Tour books']();
      var first = run(added, { tours: world, accounts: acc, fromStart: fromStart, hold: fromStart });
      checkInvariant(added, first, 'first read');
      ok(first.sorted.items.length > 1000, 'the first read stores rows');
      var known = knownFrom(first.sorted.items);
      var second = run(added, { tours: world, accounts: acc, known: known, fromStart: fromStart, hold: fromStart });
      var c = checkInvariant(added, second, 'second read');
      eq(second.sorted.items.length, 0, 'new rows on the second read');
      eq(second.sorted.toFile.size, 0, 'charges filed on the second read');
      eq(second.sorted.changes.length, 0, 'changes to rows already here');
      eq(c.already, first.sorted.items.length, 'every stored row is already here');
      eq(second.led.new_waiting + second.led.new_filed + second.led.new_left_out, 0, 'ledger: nothing new');
      // what was only counted the first time is only counted again, the same
      eq(second.led.not_kept.money_in, first.led.not_kept.money_in, 'money in, counted again');
      eq(JSON.stringify(second.led.not_kept.off), JSON.stringify(first.led.not_kept.off), 'off, counted again');
    });
  });

  /* ============================== (c) Named cases ============================== */

  function expectRow(c) {
    test(c.name, function () {
      var x = one(c.line, c.opts);
      if (c.fate) { eq(x.fate, c.fate, 'fate'); }
      if (c.fates) { has(c.fates, x.fate, 'fate'); }
      if (c.noRow) { eq(x.row, null, 'row'); return; }
      ok(x.row, 'a row is stored (fate: ' + x.fate + ')');
      if (c.status) eq(x.row.status, c.status, 'status');
      if ('reason' in c) eq(x.row.reason, c.reason, 'reason');
      if (c.why) eq(x.row.why, c.why, 'why');
      if (c.whyStarts) ok(String(x.row.why).indexOf(c.whyStarts) === 0, 'why starts with "' + c.whyStarts + '", got "' + x.row.why + '"');
      if ('tour' in c) eq(x.row.tour_id, c.tour, 'tour_id');
      if ('amount' in c) eq(x.row.amount, c.amount, 'amount');
      if (c.merchantHas) ok(String(x.row.merchant).indexOf(c.merchantHas) >= 0, 'name has "' + c.merchantHas + '", got "' + x.row.merchant + '"');
      if (c.merchantLacks) ok(!c.merchantLacks.test(String(x.row.merchant)), 'name still carries a long number: "' + x.row.merchant + '"');
      eq(x.row.account_id, c.line && c.line.account_id ? c.line.account_id : 'card', 'account_id');
      eq(x.r.led.unexplained, 0, 'unexplained');
      if (c.also) c.also(x);
    });
  }

  var ZELLE = 'Zelle payment to Pat Example Conf# w1x2y3z4';
  var WIRE = 'WIRE TYPE:WIRE OUT DATE:261009 TRN:2026100900123456 BNF:EXAMPLE BUS CO ID:000123456789';
  [
    { name: 'a Zelle from a bank account waits, named for who was paid',
      line: { account_id: 'chk', amount: 500, name: ZELLE, merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER') },
      status: 'waiting', reason: null, why: 'Zelle', tour: 't1', amount: 500, merchantHas: 'Pat Example' },
    { name: 'a wire from a bank account waits, named for who was paid, long numbers taken out',
      line: { account_id: 'chk', amount: 4200, name: WIRE, merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_OTHER_TRANSFER_OUT') },
      status: 'waiting', why: 'Wire', merchantHas: 'Wire to EXAMPLE BUS CO', merchantLacks: /\d{6,}/ },
    { name: 'a transfer out of a bank account waits',
      line: { account_id: 'chk', amount: 250, name: 'Venmo', merchant_name: 'Venmo', personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER') },
      status: 'waiting', why: 'Transfer' },
    { name: 'a transfer waits even on an account set to log by itself, with a learned name',
      line: { account_id: 'chkLog', amount: 250, name: 'SHELL OIL 5744', merchant_name: 'Shell', personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER') },
      status: 'waiting', why: 'Transfer' },
    { name: 'a Zelle the bank filed under "loan payments" is still a Zelle and waits (words before labels)',
      line: { account_id: 'chk', amount: 500, name: ZELLE, merchant_name: null, personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_OTHER_PAYMENT') },
      status: 'waiting', why: 'Zelle' },
    { name: 'a Zelle the bank filed under "credit card payment" is still a Zelle and waits',
      line: { account_id: 'chk', amount: 500, name: ZELLE, merchant_name: null, personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') },
      status: 'waiting', why: 'Zelle' },
    { name: 'a wire the bank filed under "loan payments" is still a wire and waits',
      line: { account_id: 'chk', amount: 4200, name: WIRE, merchant_name: null, personal_finance_category: pfc('LOAN_PAYMENTS') },
      status: 'waiting', why: 'Wire' },
    { name: 'a cash withdrawal (by the bank’s label) waits',
      line: { account_id: 'chk', amount: 300, name: 'WITHDRAWAL 10/15', merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_WITHDRAWAL') },
      status: 'waiting', reason: null, why: 'Cash withdrawal' },
    { name: 'a cash withdrawal (by its wording, no label) waits',
      line: { account_id: 'chkLog', amount: 300, name: 'ATM WITHDRAWAL 000123 5TH AVE', merchant_name: null, personal_finance_category: undefined },
      status: 'waiting', why: 'Cash withdrawal', merchantLacks: /\d{6,}/ },
    { name: 'a van loan payment waits',
      line: { account_id: 'chk', amount: 612.4, name: 'ALLY AUTO PAYMENT', merchant_name: 'Ally Financial', personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CAR_PAYMENT') },
      status: 'waiting', reason: null, why: 'Loan payment' },
    { name: 'a loan payment with no detail waits',
      line: { account_id: 'chkLog', amount: 612.4, name: 'TRAILER LOAN', merchant_name: null, personal_finance_category: { primary: 'LOAN_PAYMENTS' } },
      status: 'waiting', why: 'Loan payment' },
    { name: 'paying a credit card (by the bank’s label) is stored as left out: card payment',
      line: { account_id: 'chk', amount: 2000, name: 'CHASE CREDIT CRD AUTOPAY', merchant_name: 'Chase', personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') },
      status: 'left_out', reason: 'card_payment', why: 'Card payment', amount: 2000 },
    { name: 'paying a credit card (by its wording: AMEX EPAYMENT) is stored as left out: card payment',
      line: { account_id: 'chk', amount: 2000, name: 'AMEX EPAYMENT ACH PMT W1234', merchant_name: 'American Express', personal_finance_category: pfc('OTHER') },
      status: 'left_out', reason: 'card_payment' },
    { name: 'paying a credit card (by its wording: American Express ACH PMT, a transfer label) is stored as left out',
      line: { account_id: 'chk', amount: 2000, name: 'AMERICAN EXPRESS DES:ACH PMT ID:W1234', merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER') },
      status: 'left_out', reason: 'card_payment' },
    { name: 'paying a credit card (by its wording: Bank of America credit card) is stored as left out',
      line: { account_id: 'chk', amount: 800, name: 'BANK OF AMERICA CREDIT CARD Bill Payment', merchant_name: null, personal_finance_category: undefined },
      status: 'left_out', reason: 'card_payment' },
    { name: 'paying a credit card (by its wording: CARDMEMBER SERV) is stored as left out',
      line: { account_id: 'chk', amount: 800, name: 'CARDMEMBER SERV WEB PYMT', merchant_name: null, personal_finance_category: pfc('OTHER') },
      status: 'left_out', reason: 'card_payment' },
    { name: 'a move to savings is stored as left out: own move',
      line: { account_id: 'chk', amount: 1000, name: 'Online Transfer to SAV ...9999', merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_SAVINGS') },
      status: 'left_out', reason: 'own_move', why: 'Moved to savings or investments' },
    { name: 'a move to investments is stored as left out: own move',
      line: { account_id: 'chk', amount: 1000, name: 'VANGUARD BUY', merchant_name: 'Vanguard', personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS') },
      status: 'left_out', reason: 'own_move' },
    { name: 'money sent with a credit card (the bank says "transfer out") waits',
      line: { account_id: 'card', amount: 300, name: 'VENMO *SAM EXAMPLE', merchant_name: 'Shell', personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER') },
      status: 'waiting', reason: null, why: 'Cash advance or money sent from a card' },
    { name: 'a "loan payment" on a credit card (an instalment) waits',
      line: { account_id: 'card', amount: 89, name: 'AFFIRM PAY', merchant_name: 'Affirm', personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_OTHER_PAYMENT') },
      status: 'waiting', why: 'Cash advance or money sent from a card' },
    { name: 'a checking account answered "Credit card": its Zelle still waits as a Zelle',
      line: { account_id: 'wrong', amount: 500, name: ZELLE, merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER') },
      status: 'waiting', why: 'Zelle' },
    { name: 'a checking account answered "Credit card": its transfer still waits as a transfer',
      line: { account_id: 'wrong', amount: 500, name: 'Cash App', merchant_name: 'Cash App', personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER') },
      status: 'waiting', why: 'Transfer' },
    { name: 'a checking account answered "Credit card": a deposit on it is not a card payment and not a refund',
      line: { account_id: 'wrong', amount: -900, name: 'DEPOSIT', merchant_name: null, personal_finance_category: pfc('TRANSFER_IN', 'TRANSFER_IN_DEPOSIT') },
      fate: 'money_in', noRow: true },
    { name: 'a refund on a card waits as a refund, amount negative',
      line: { account_id: 'card', amount: -20, name: 'SHELL OIL 5744', merchant_name: 'Shell' },
      status: 'waiting', why: 'Refund', amount: -20 },
    { name: 'a refund on a card someone answered "Debit card" is still a refund on a card',
      line: { account_id: 'debitSaid', amount: -20, name: 'SHELL OIL 5744', merchant_name: 'Shell' },
      status: 'waiting', why: 'Refund', amount: -20 },
    { name: 'a payment arriving on a card (label) is stored as left out: card payment',
      line: { account_id: 'card', amount: -500, name: 'ONLINE PMT RECEIVED', merchant_name: null, personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') },
      status: 'left_out', reason: 'card_payment', amount: -500,
      also: function (x) { eq(x.r.sorted.payments.length, 1, 'still handed on as a payment'); eq(x.r.sorted.payments[0].amount, 500, 'payment amount'); } },
    { name: 'a payment arriving on a card (transfer in) is stored as left out: card payment',
      line: { account_id: 'card', amount: -500, name: 'AUTOPAY', merchant_name: null, personal_finance_category: pfc('TRANSFER_IN', 'TRANSFER_IN_ACCOUNT_TRANSFER') },
      status: 'left_out', reason: 'card_payment' },
    { name: 'a payment arriving on a card (the word "payment") is stored as left out: card payment',
      line: { account_id: 'card', amount: -500, name: 'PAYMENT THANK YOU', merchant_name: null, personal_finance_category: undefined },
      status: 'left_out', reason: 'card_payment' },
    { name: 'a deposit on a bank account is counted, never stored',
      line: { account_id: 'chk', amount: -1500, name: 'ACH DEPOSIT PROMOTER LLC', merchant_name: null, personal_finance_category: pfc('INCOME', 'INCOME_OTHER_INCOME') },
      fate: 'money_in', noRow: true },
    { name: 'a Zelle that came back into a bank account waits as money back, amount negative',
      line: { account_id: 'chk', amount: -500, name: 'Zelle payment returned Pat Example 000123456789', merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER') },
      status: 'waiting', reason: null, why: 'Money back', amount: -500, merchantHas: 'Pat Example', merchantLacks: /\d{6,}/ },
    { name: 'a returned payment (label "loan payments") coming into a bank account waits as money back',
      line: { account_id: 'chkLog', amount: -612.4, name: 'ALLY AUTO RETURNED PAYMENT', merchant_name: null, personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CAR_PAYMENT') },
      status: 'waiting', why: 'Money back', amount: -612.4 },
    { name: 'a zero line on a card is stored as left out: zero',
      line: { account_id: 'card', amount: 0 }, status: 'left_out', reason: 'zero', why: 'Zero amount' },
    { name: 'a zero line on a bank account is stored as left out: zero',
      line: { account_id: 'chk', amount: 0, personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_SAVINGS') }, status: 'left_out', reason: 'zero' },
    { name: 'a line on an account nobody has listed is stored, waiting',
      line: { account_id: 'nobody-knows-this-id' }, status: 'waiting', why: 'From a bank account',
      also: function (x) { eq(x.row.account, '', 'account name'); } },
    { name: 'a line with no label at all is stored (card, set to log, learned name: it files)',
      line: { account_id: 'card', personal_finance_category: undefined }, status: 'filed', reason: null },
    { name: 'a line with no label at all is stored (bank account that asks: it waits)',
      line: { account_id: 'chk', personal_finance_category: undefined }, status: 'waiting', whyStarts: 'From Checking' },
    { name: 'a line under a heading nobody has seen before is stored (card)',
      line: { account_id: 'card', personal_finance_category: { primary: 'BRAND_NEW_HEADING', detailed: 'BRAND_NEW_HEADING_X' } }, status: 'filed' },
    { name: 'a line under a heading nobody has seen before is stored (bank account)',
      line: { account_id: 'chkLog', name: 'SOMEPLACE NEW', merchant_name: null, personal_finance_category: { primary: 'BRAND_NEW_HEADING', detailed: 'BRAND_NEW_HEADING_X' } },
      status: 'waiting', why: 'New merchant' },
    { name: 'a new merchant on a card set to log waits',
      line: { account_id: 'card', name: 'NEVER SEEN BEFORE LLC', merchant_name: null }, status: 'waiting', why: 'New merchant' },
    { name: 'a card that asks first: a learned merchant still waits',
      line: { account_id: 'cardAsk' }, status: 'waiting', whyStarts: 'From Blue Card' },

    /* ---- days ---- */
    { name: 'a day before every tour’s card dates, no Off Tour book: stored as left out, on no tour',
      line: { date: '2026-09-30' }, status: 'left_out', reason: 'outside_dates', why: 'Not during a tour', tour: null },
    { name: 'the first day of the card dates is on the tour',
      line: { date: '2026-10-01' }, fates: ['waiting', 'filed'], tour: 't1' },
    { name: 'the last day of the card dates is on the tour',
      line: { date: '2026-10-20' }, fates: ['waiting', 'filed'], tour: 't1' },
    { name: 'the day after the last day: stored as left out',
      line: { date: '2026-10-21' }, status: 'left_out', reason: 'outside_dates', tour: null },
    { name: 'the day the charge was MADE decides, not the day it posted',
      line: { date: '2026-10-21', authorized_date: '2026-10-20' }, fates: ['waiting', 'filed'], tour: 't1',
      also: function (x) { eq(x.row.date, '2026-10-20', 'date'); eq(x.row.posted, '2026-10-21', 'posted'); } },
    { name: 'between tours with ONE Off Tour book: it waits on the book',
      line: { date: '2026-09-10', account_id: 'chk' }, opts: { tours: F.asTours([{ id: 't1', doc: tourDoc() }, { id: 'off1', doc: bookDoc() }]) },
      status: 'waiting', tour: 'off1' },
    { name: 'between tours with TWO Off Tour books (two artists): stored as left out, on neither',
      line: { date: '2026-09-10', account_id: 'chk' },
      opts: { tours: F.asTours([{ id: 't1', doc: tourDoc() }, { id: 'off1', doc: bookDoc() }, { id: 'off2', doc: bookDoc({ artist: 'Other Artist' }) }]) },
      status: 'left_out', reason: 'outside_dates', tour: null },
    { name: 'before the Off Tour book starts logging: stored as left out',
      line: { date: '2026-09-10' }, opts: { tours: F.asTours([{ id: 't1', doc: tourDoc() }, { id: 'off1', doc: bookDoc({ offFrom: '2026-09-15' }) }]) },
      status: 'left_out', reason: 'outside_dates' },
    { name: 'a tour with no card dates saved takes nothing: stored as left out when there is no book',
      line: { date: FRESH }, opts: { tours: F.asTours([{ id: 't1', doc: tourDoc({ cardLog: null }) }]) },
      status: 'left_out', reason: 'outside_dates', tour: null },
    { name: 'a tour with no card dates saved: its days go to the one Off Tour book',
      line: { date: FRESH, account_id: 'chk' }, opts: { tours: F.asTours([{ id: 't1', doc: tourDoc({ cardLog: null }) }, { id: 'off1', doc: bookDoc() }]) },
      status: 'waiting', tour: 'off1' },
    { name: 'a tour that was taken down takes nothing',
      line: { date: FRESH }, opts: { tours: F.asTours([{ id: 't1', doc: tourDoc({ deletedAt: 1760000000000 }) }]) },
      status: 'left_out', reason: 'outside_dates', tour: null },
    { name: 'an Off Tour book that was taken down takes nothing',
      line: { date: '2026-09-10' }, opts: { tours: F.asTours([{ id: 't1', doc: tourDoc() }, { id: 'off1', doc: bookDoc({ deletedAt: 1760000000000 }) }]) },
      status: 'left_out', reason: 'outside_dates' },
    { name: 'two tours logging the same day: it waits for a person to pick, on neither',
      line: { date: FRESH }, opts: { tours: F.asTours([{ id: 't1', doc: tourDoc() }, { id: 't2', doc: tourDoc({ name: 'Second Tour' }) }]) },
      status: 'waiting', why: 'Two tours that day', tour: null },
    { name: 'a card payment keeps the tour its day falls in, for when it is brought in',
      line: { account_id: 'chk', amount: 2000, name: 'CHASE CREDIT CRD AUTOPAY', personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') },
      status: 'left_out', reason: 'card_payment', tour: 't1' }
  ].forEach(expectRow);

  /* "VERIZON WIRELESS AUTOPAY", "ATT BILL PMT", "PARKING PMT", "Transfer Station
     Brewing", "Amex Travel Payment": bills and purchases whose names used to
     hide them. As money out they must be stored and waiting or filed, on a card
     and on a bank account, under any ordinary label, an unknown one, or none. */
  var BILLS = [
    ['VERIZON WIRELESS AUTOPAY', 'Verizon'], ['ATT BILL PMT', null], ['PARKING PMT', null],
    ['Transfer Station Brewing', null], ['Amex Travel Payment', 'Amex Travel'],
    ['AUTO PAY STATE FARM INSURANCE', null], ['E-PAYMENT STORAGE UNIT', null],
    ['Bank of America Stadium Parking PMT', null], ['STARTING BALANCE BREWERY', null]
  ];
  var ORDINARY = [undefined, pfc('GENERAL_SERVICES', 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES'), pfc('OTHER', 'OTHER_OTHER'),
    pfc('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_TELEPHONE'), pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR'),
    pfc('TRAVEL', 'TRAVEL_OTHER_TRAVEL'), pfc('BRAND_NEW_HEADING', 'BRAND_NEW_HEADING_X')];
  BILLS.forEach(function (b) {
    ['card', 'cardAsk', 'chk', 'chkLog', 'wrong', 'debitSaid', 'inc', 'nobody-knows-this-id'].forEach(function (a) {
      test('"' + b[0] + '" as money out on ' + a + ' is stored and waits or files, never left out', function () {
        ORDINARY.forEach(function (lab) {
          var x = one({ account_id: a, amount: 86.11, name: b[0], merchant_name: b[1], personal_finance_category: lab });
          ok(x.row, 'stored (fate ' + x.fate + ', label ' + JSON.stringify(lab) + ')');
          has(['waiting', 'filed'], x.row.status, 'status under label ' + JSON.stringify(lab));
          eq(x.row.reason, null, 'reason');
          eq(x.row.amount, 86.11, 'amount');
        });
      });
    });
  });
  test('on a card, a transfer or loan label never leaves one of those names out either: it waits', function () {
    BILLS.forEach(function (b) {
      [pfc('TRANSFER_OUT', 'TRANSFER_OUT_SAVINGS'), pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'), pfc('TRANSFER_OUT', 'TRANSFER_OUT_WITHDRAWAL')].forEach(function (lab) {
        var x = one({ account_id: 'card', amount: 86.11, name: b[0], merchant_name: b[1], personal_finance_category: lab });
        eq(x.row && x.row.status, 'waiting', b[0] + ' under ' + lab.detailed);
        eq(x.row.why, 'Cash advance or money sent from a card', 'why');
      });
    });
  });
  test('true card payments are still told apart from those names (bank account)', function () {
    ['AMEX EPAYMENT ACH PMT', 'AMERICAN EXPRESS ACH PMT A1234', 'American Express Card Payment', 'AMEX Payment',
      'BANK OF AMERICA ONLINE PMT', 'Bank of America Business Card Payment', 'CREDIT CARD PAYMENT', 'PAYMENT - THANK YOU'].forEach(function (nm) {
      var x = one({ account_id: 'chk', amount: 300, name: nm, merchant_name: null, personal_finance_category: pfc('OTHER') });
      eq(x.fate, 'left_out:card_payment', nm);
    });
  });

  test('the before-tour cutoff: a charge on or before a hand-typed card’s opening balance day is left out as "Before the tour"', function () {
    var world = F.asTours([{ id: 't1', doc: tourDoc({ debts: { d1: { kind: 'card', label: 'Old card', amount: 900, cutoff: '2026-10-03' } } }) }]);
    var on = one({ date: '2026-10-03' }, { tours: world });
    eq(on.row.status, 'left_out', 'on the cutoff day'); eq(on.row.reason, 'before_tour', 'reason'); eq(on.row.why, 'Before the tour', 'why');
    eq(on.row.tour_id, 't1', 'it keeps its tour');
    var before = one({ date: '2026-10-01', account_id: 'chk' }, { tours: world });
    eq(before.fate, 'left_out:before_tour', 'before the cutoff day');
    var after = one({ date: '2026-10-04', account_id: 'chk' }, { tours: world });
    eq(after.fate, 'waiting', 'the day after the cutoff');
    // money sent to someone was never inside a card's balance: it waits
    var zelle = one({ date: '2026-10-02', account_id: 'chk', amount: 500, name: ZELLE, merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT') }, { tours: world });
    eq(zelle.fate, 'waiting', 'a Zelle before the cutoff'); eq(zelle.row.why, 'Zelle', 'why');
    // a card the feed read itself has no such cutoff
    var read = F.asTours([{ id: 't1', doc: tourDoc({ debts: { d1: { kind: 'card', label: 'Gold', amount: 900, cutoff: '2026-10-03', feed: { name: 'Gold Card' } } } }) }]);
    eq(one({ date: '2026-10-02', account_id: 'chk' }, { tours: read }).fate, 'waiting', 'no hand-typed card, no cutoff');
  });

  test('nothing files itself: older than two weeks, in a read from the start, or on a new account', function () {
    var long = F.asTours([{ id: 't1', doc: tourDoc({ shows: { a: { date: '2026-09-01' }, b: { date: '2026-10-20' } } }) }]);
    // fresh, on a card set to log, a learned merchant: this is the one thing that may file
    var fresh = one({ date: FRESH }, { tours: long });
    eq(fresh.row.status, 'filed', 'a fresh learned charge'); eq(fresh.row.category, 'gas', 'category'); eq(fresh.row.why, '', 'why');
    var b = fresh.r.sorted.toFile.get('t1');
    ok(b && b.charges['p' + fresh.id], 'its charge is in the tour’s bucket');
    eq(b.charges['p' + fresh.id].amount, 42.5, 'charge amount'); eq(b.charges['p' + fresh.id].paid, false, 'a credit card charge is still owed');
    // exactly 14 days old may still file; 15 may not
    eq(one({ date: '2026-10-08' }, { tours: long }).fate, 'filed', '14 days old');
    var old = one({ date: '2026-10-07' }, { tours: long });
    eq(old.row.status, 'waiting', '15 days old'); eq(old.row.why, 'Older than two weeks', 'why');
    eq(old.r.sorted.toFile.size, 0, 'nothing in a bucket');
    eq(one({ date: '2026-09-05' }, { tours: long }).row.why, 'Older than two weeks', 'weeks old');
    // hold: a read from the start
    var held = one({ date: FRESH }, { tours: long, hold: true, fromStart: true });
    eq(held.row.status, 'waiting', 'held'); eq(held.row.why, 'Found in the catch-up', 'why');
    eq(held.r.sorted.toFile.size, 0, 'nothing in a bucket');
    // a bank account set to log files a fresh learned charge as paid
    var debit = one({ date: FRESH, account_id: 'chkLog' }, { tours: long });
    eq(debit.row.status, 'filed', 'debit'); eq(debit.r.sorted.toFile.get('t1').charges['p' + debit.id].paid, true, 'a debit charge is paid');
    // an account nobody has answered the questions for asks first, whatever kind it is
    eq(F.defaultMode('creditCard'), 'ask', 'a new credit card');
    eq(F.defaultMode('checking'), 'ask', 'a new checking account');
    eq(F.defaultMode('savings'), 'ask', 'a new savings account');
    eq(F.defaultMode('loan'), 'ask', 'a kind of account the app does not know');
    eq(F.defaultMode('other'), 'ask', 'other');
  });

  test('look-alikes and typed totals still wait, as before', function () {
    var typed = F.asTours([{ id: 't1', doc: tourDoc({
      charges: { c1: { date: '2026-10-14', amount: 42.5, merchant: 'Shell', category: 'gas' } },
      cashLog: { k1: { date: '2026-10-13', amount: 500, category: 'crew' } },
      expenses: { food: { paid: 300 } } }) }]);
    eq(one({ date: FRESH }, { tours: typed }).row.why, 'Maybe already in', 'same amount a day apart');
    var z = one({ date: FRESH, account_id: 'chk', amount: 500, name: ZELLE, merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT') }, { tours: typed });
    eq(z.row.why, 'Maybe already in', 'a Zelle two days after the same amount in the cash log');
    var labels = S.learnLabel(S.learnLabel({}, 'Shell', 'gas'), 'Waffle House', 'food');
    var w = one({ date: FRESH, name: 'WAFFLE HOUSE 1123', merchant_name: 'Waffle House', amount: 31 }, { tours: typed, labels: labels });
    eq(w.row.why, 'Already typed into Food', 'a category with a typed total');
  });

  test('a move between his own linked accounts says so, and still waits', function () {
    var out = line({ account_id: 'chk', amount: 700, name: 'Online Transfer to CHK 5678', merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER') });
    var inn = line({ account_id: 'chkLog', amount: -700, name: 'Online Transfer from CHK 1234', merchant_name: null, personal_finance_category: pfc('TRANSFER_IN', 'TRANSFER_IN_ACCOUNT_TRANSFER') });
    var r = run([out, inn]);
    eq(r.row(out.transaction_id).status, 'waiting', 'the sending side');
    ok(/^Transfer · may be a move to Road Checking/.test(r.row(out.transaction_id).why), 'why: ' + r.row(out.transaction_id).why);
    eq(r.fate(inn.transaction_id), 'money_in', 'the arriving side');
    eq(r.led.unexplained, 0, 'unexplained');
  });

  test('sentAs: words before labels, bank accounts only; the bank’s reading decides what a card is', function () {
    var z = { amount: 10, name: 'ZELLE TO SAM', original_description: 'ZELLE TO SAM' };
    eq(F.sentAs(z, { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }, false), 'Zelle', 'Zelle under a loan label');
    eq(F.sentAs(z, { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_SAVINGS' }, false), 'Zelle', 'Zelle under a savings label');
    eq(F.sentAs(z, {}, false), 'Zelle', 'Zelle with no label');
    eq(F.sentAs(z, { primary: 'FOOD_AND_DRINK' }, true), '', 'on a card a word marks nothing');
    eq(F.sentAs({ amount: 10, name: 'LIVE WIRE LOUNGE' }, { primary: 'FOOD_AND_DRINK' }, false), '', 'the Live Wire Lounge is not a wire');
    eq(F.sentAs({ amount: 10, name: 'OUTGOING WIRE 123' }, { primary: 'LOAN_PAYMENTS' }, false), 'Wire', 'a wire under a loan label');
    eq(F.sentAs({ amount: -10, name: 'ZELLE FROM SAM' }, { primary: 'TRANSFER_IN' }, false), '', 'money in is never "sent"');
    eq(F.sentAs({ amount: 10, name: 'Venmo' }, { primary: 'TRANSFER_OUT' }, true), 'Cash advance or money sent from a card', 'a transfer on a card');
    eq(F.outKind({ amount: 10, name: 'SAVINGS XFER' }, { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_SAVINGS' }, false).left, 'own_move', 'savings');
    eq(F.outKind({ amount: 10, name: 'SAVINGS XFER' }, { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_SAVINGS' }, true).left, '', 'nothing is left out on a card');
    eq(F.bankSaysCard({ type: 'creditCard', plaid: 'checking' }), false, 'answered credit, the bank says checking');
    eq(F.bankSaysCard({ type: 'checking', plaid: 'creditCard' }), true, 'answered debit, the bank says credit card');
    eq(F.bankSaysCard({ type: 'creditCard' }), true, 'an older entry with only the type');
    eq(F.bankSaysCard(undefined), false, 'an unknown account');
    eq(F.isCredit({ type: 'creditCard', plaid: 'checking', card: 'credit' }), true, 'owed or paid still follows the person’s answer');
  });

  test('an account switched off: its lines are counted by account name, never stored', function () {
    var a = line({ account_id: 'sav', amount: 20 }), b = line({ account_id: 'sav', amount: -300 }), c = line({ account_id: 'sav', amount: 0 });
    var r = run([a, b, c]);
    eq(r.sorted.items.length, 0, 'rows');
    eq(r.led.not_kept.off['Savings ··9999'], 3, 'counted under the account’s name');
    eq(r.led.unexplained, 0, 'unexplained'); eq(r.led.bank_sent, 3, 'bank_sent');
  });

  test('deposits and card payments are collected exactly as before', function () {
    var dep = line({ account_id: 'inc', amount: -1500, name: 'ACH DEPOSIT PROMOTER LLC', merchant_name: null, personal_finance_category: pfc('INCOME', 'INCOME_OTHER_INCOME') });
    var av = line({ account_id: 'inc', amount: -812.33, name: 'AVT123 ATVENU PAYOUT', merchant_name: null, personal_finance_category: pfc('TRANSFER_IN', 'TRANSFER_IN_DEPOSIT') });
    var back = line({ account_id: 'inc', amount: -500, name: 'Zelle payment returned', merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER') });
    var loanBack = line({ account_id: 'inc', amount: -90, name: 'LOAN REVERSAL', merchant_name: null, personal_finance_category: pfc('LOAN_PAYMENTS') });
    var notWatched = line({ account_id: 'chk', amount: -75, name: 'DEPOSIT', merchant_name: null, personal_finance_category: pfc('INCOME') });
    var out = line({ account_id: 'inc', amount: 60, name: 'SHELL OIL', merchant_name: 'Shell' });
    var pay = line({ account_id: 'card', amount: -400, name: 'PAYMENT THANK YOU', merchant_name: null, personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') });
    var r = run([dep, av, back, loanBack, notWatched, out, pay], { item: 'bankB' });
    var ids = r.sorted.deposits.map(function (d) { return d.id; });
    eq(JSON.stringify(ids), JSON.stringify([dep.transaction_id, av.transaction_id]), 'which lines are deposits');
    eq(r.sorted.deposits[0].amount, 1500, 'deposit amount'); eq(r.sorted.deposits[0].watch, 'both', 'watch'); eq(r.sorted.deposits[0].av, false, 'not atVenu');
    eq(r.sorted.deposits[1].av, true, 'atVenu payout'); eq(r.sorted.deposits[1].date, FRESH, 'deposit day');
    eq(r.fate(dep.transaction_id), 'money_in', 'a deposit has no row');
    eq(r.row(back.transaction_id).why, 'Money back', 'money back is a row, not a deposit');
    eq(r.row(loanBack.transaction_id).why, 'Money back', 'a returned loan payment too');
    eq(r.sorted.payments.length, 1, 'payments'); eq(r.sorted.payments[0].id, pay.transaction_id, 'the card payment');
    eq(r.sorted.payments[0].watch, 'card', 'which card');
    eq(r.led.deposits, 2, 'ledger deposits'); eq(r.led.unexplained, 0, 'unexplained');
  });

  /* ============================== (d) Lines the app already holds ============================== */

  function knownRow(o) { return Object.assign({ status: 'waiting', amount: 42.5, reason: null, date: FRESH, bank_amount: null }, o || {}); }

  test('the bank removes a line that is waiting: one change, "gone", and no new row', function () {
    var known = new Map([['gone1', knownRow()]]);
    var r = run([line()], { known: known, removed: [{ transaction_id: 'gone1', account_id: 'card' }] });
    eq(r.sorted.changes.length, 1, 'changes'); eq(r.sorted.changes[0].kind, 'gone', 'kind'); eq(r.sorted.changes[0].id, 'gone1', 'id');
    eq(r.sorted.changes[0].status, 'waiting', 'what it was');
    eq(r.sorted.items.length, 1, 'only the new line is a row'); eq(r.led.bank_sent, 1, 'a removal is not a line the bank sent'); eq(r.led.unexplained, 0, 'unexplained');
  });
  test('the bank removes a line that is filed: "gone" with its status, for the server to mark and never touch the tour', function () {
    var known = new Map([['gone2', knownRow({ status: 'filed' })], ['gone3', knownRow({ status: 'skipped', reason: 'set_aside' })], ['gone4', knownRow({ status: 'left_out', reason: 'card_payment' })]]);
    var r = run([], { known: known, removed: [{ transaction_id: 'gone2' }, { transaction_id: 'gone3' }, { transaction_id: 'gone4' }, { transaction_id: 'never-stored' }] });
    eq(r.sorted.changes.length, 3, 'changes (a removal of something never stored is nothing)');
    eq(JSON.stringify(r.sorted.changes.map(function (c) { return [c.id, c.kind, c.status]; })),
      JSON.stringify([['gone2', 'gone', 'filed'], ['gone3', 'gone', 'skipped'], ['gone4', 'gone', 'left_out']]), 'each with what it was');
    eq(r.sorted.items.length, 0, 'rows'); eq(r.sorted.toFile.size, 0, 'buckets');
  });
  test('the bank sends a waiting line again with another amount: the row’s amount is to be updated', function () {
    var l = line({ amount: 45.1 });
    var r = run([l], { known: new Map([[l.transaction_id, knownRow({ amount: 42.5 })]]) });
    eq(r.sorted.items.length, 0, 'no new row');
    eq(JSON.stringify(r.sorted.changes), JSON.stringify([{ id: l.transaction_id, kind: 'amount', open: true, amount: 45.1 }]), 'change');
    eq(r.fate(l.transaction_id), 'already', 'fate'); eq(r.led.already_here, 1, 'ledger');
    // a left-out row is still open
    var r2 = run([l], { known: new Map([[l.transaction_id, knownRow({ status: 'left_out', reason: 'card_payment', amount: 42.5 })]]) });
    eq(r2.sorted.changes[0].open, true, 'left out is not dealt with yet');
  });
  test('the bank sends a filed line again with another amount: only the bank’s figure is noted', function () {
    ['filed', 'skipped', 'mypay'].forEach(function (st) {
      var l = line({ amount: 45.1 });
      var r = run([l], { known: new Map([[l.transaction_id, knownRow({ status: st, amount: 42.5 })]]), modified: [] });
      eq(JSON.stringify(r.sorted.changes), JSON.stringify([{ id: l.transaction_id, kind: 'amount', open: false, amount: 45.1 }]), st);
      eq(r.sorted.items.length, 0, 'no new row'); eq(r.sorted.toFile.size, 0, 'nothing touches a tour');
    });
    // already noted: nothing more to do
    var l2 = line({ amount: 45.1 });
    var same = run([l2], { known: new Map([[l2.transaction_id, knownRow({ status: 'filed', amount: 42.5, bank_amount: 45.1 })]]) });
    eq(same.sorted.changes.length, 0, 'the same figure again is no change');
    // to the cent: a float's dust is not a change
    var l3 = line({ amount: 0.1 + 0.2 });
    eq(run([l3], { known: new Map([[l3.transaction_id, knownRow({ amount: 0.3 })]]) }).sorted.changes.length, 0, 'compared to the cent');
  });
  test('a changed line arriving under "modified" is compared the same way, and counted once', function () {
    var l = line({ amount: 42.5 });
    var later = Object.assign({}, l, { amount: 61 });
    var r = run([l], { modified: [later], known: new Map([[l.transaction_id, knownRow({ amount: 42.5 })]]) });
    eq(r.led.bank_sent, 1, 'one line, sent twice in one read'); eq(r.led.already_here, 1, 'already here');
    eq(r.sorted.changes.length, 1, 'changes'); eq(r.sorted.changes[0].amount, 61, 'the bank’s last word');
    // and for a line the app does not hold: the last version is the one stored
    var m = line({ amount: 10 });
    var r2 = run([m], { modified: [Object.assign({}, m, { amount: 12 })] });
    eq(r2.sorted.items.length, 1, 'one row'); eq(r2.row(m.transaction_id).amount, 12, 'the bank’s last word'); eq(r2.led.bank_sent, 1, 'counted once');
  });
  test('left out for its day, and the day is now inside a tour: back to waiting, only on a read from the start', function () {
    var l = line({ account_id: 'chk', date: '2026-09-10' });
    var was = new Map([[l.transaction_id, knownRow({ status: 'left_out', reason: 'outside_dates', date: '2026-09-10' })]]);
    var wider = F.asTours([{ id: 't1', doc: tourDoc({ shows: { a: { date: '2026-09-01' }, b: { date: '2026-10-20' } } }) }]);
    var full = run([l], { known: was, tours: wider, fromStart: true, hold: true });
    eq(JSON.stringify(full.sorted.changes), JSON.stringify([{ id: l.transaction_id, kind: 'resort', tour_id: 't1' }]), 'on a read from the start');
    eq(full.sorted.items.length, 0, 'never a second row');
    eq(run([l], { known: was, tours: wider, fromStart: false }).sorted.changes.length, 0, 'not on an ordinary read');
    eq(run([l], { known: was, fromStart: true, hold: true }).sorted.changes.length, 0, 'still outside: nothing');
    // a "before the tour" row whose cutoff moved
    var b = line({ account_id: 'chk', date: '2026-10-02' });
    var wasB = new Map([[b.transaction_id, knownRow({ status: 'left_out', reason: 'before_tour', date: '2026-10-02' })]]);
    var cut = function (day) { return F.asTours([{ id: 't1', doc: tourDoc({ debts: { d1: { kind: 'card', label: 'Old', amount: 5, cutoff: day } } }) }]); };
    eq(run([b], { known: wasB, tours: cut('2026-10-03'), fromStart: true }).sorted.changes.length, 0, 'still before the cutoff');
    eq(run([b], { known: wasB, tours: cut('2026-10-01'), fromStart: true }).sorted.changes[0].kind, 'resort', 'now after the cutoff');
    // a row left out for what it IS (not for its day) is never re-sorted because the dates moved, while the
    // bank still sends it as that; and neither is anything on a switched-off account
    [['card_payment', { amount: 2000, name: 'CHASE CREDIT CRD AUTOPAY', merchant_name: 'Chase', personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') }, 2000],
      ['own_move', { amount: 1000, name: 'Online Transfer to SAV ...9999', merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_SAVINGS') }, 1000],
      ['zero', { amount: 0 }, 0]].forEach(function (c) {
      var still = line(Object.assign({ account_id: 'chk', date: '2026-09-10' }, c[1]));
      var k = new Map([[still.transaction_id, knownRow({ status: 'left_out', reason: c[0], date: '2026-09-10', amount: c[2] })]]);
      eq(run([still], { known: k, tours: wider, fromStart: true }).sorted.changes.length, 0, c[0]);
    });
    var s = line({ account_id: 'sav', date: '2026-09-10' });
    var ks = new Map([[s.transaction_id, knownRow({ status: 'left_out', reason: 'outside_dates', date: '2026-09-10' })]]);
    var rs = run([s], { known: ks, tours: wider, fromStart: true });
    eq(rs.sorted.changes.length, 0, 'switched off'); eq(rs.fate(s.transaction_id), 'already', 'a stored line on a switched-off account is already here');
  });
  test('a line a person set aside is never sorted again', function () {
    var l = line({ account_id: 'chk', date: '2026-09-10' });
    var wider = F.asTours([{ id: 't1', doc: tourDoc({ shows: { a: { date: '2026-09-01' }, b: { date: '2026-10-20' } } }) }]);
    ['skipped', 'filed', 'mypay', 'waiting'].forEach(function (st) {
      [null, 'set_aside', 'same_as_typed', 'paid_back', 'outside_dates'].forEach(function (reason) {
        if (st !== 'skipped' && reason) return;
        var r = run([l], { known: new Map([[l.transaction_id, knownRow({ status: st, reason: reason, date: '2026-09-10' })]]), tours: wider, fromStart: true, hold: true });
        eq(r.sorted.changes.length, 0, st + ' / ' + reason + ': changes');
        eq(r.sorted.items.length, 0, st + ': rows'); eq(r.sorted.toFile.size, 0, st + ': buckets');
        eq(r.fate(l.transaction_id), 'already', st + ': fate');
      });
    });
  });
  test('a line the bank sends and removes inside one read is kept on record, not as a live row', function () {
    var l = line(), keep = line();
    var r = run([l, keep], { removed: [{ transaction_id: l.transaction_id }] });
    var row = r.row(l.transaction_id);
    eq(row.status, 'left_out', 'status'); eq(row.reason, 'bank_removed', 'reason'); eq(row.gone_on, TODAY, 'the day it went');
    eq(row.why, 'Taken back by the bank', 'why');
    eq(r.sorted.toFile.size ? Object.keys(r.sorted.toFile.get('t1').charges).length : 0, 1, 'only the other line files');
    eq(r.row(keep.transaction_id).status, 'filed', 'the other line is untouched'); eq(r.row(keep.transaction_id).gone_on, null, 'gone_on');
    eq(r.led.bank_sent, 2, 'bank_sent'); eq(r.led.unexplained, 0, 'unexplained'); eq(r.led.reasons.bank_removed, 1, 'ledger reason');
    // already held, sent again and removed in the same read: the removal is what happens
    var k = line();
    var r2 = run([k], { known: new Map([[k.transaction_id, knownRow()]]), removed: [{ transaction_id: k.transaction_id }] });
    eq(JSON.stringify(r2.sorted.changes.map(function (c) { return c.kind; })), '["gone"]', 'known and removed');
    eq(r2.sorted.items.length, 0, 'rows');
  });
  test('pending lines are never stored and never counted as sent; a posted line replaces its pending self', function () {
    var p = line({ pending: true }), posted = line();
    var r = run([p, posted], { removed: [{ transaction_id: p.transaction_id }] });
    eq(r.led.bank_sent, 1, 'bank_sent'); eq(r.led.pending, 1, 'pending'); eq(r.sorted.items.length, 1, 'rows'); eq(r.led.unexplained, 0, 'unexplained');
    eq(r.sorted.changes.length, 0, 'the removal of a pending line is nothing');
  });

  /* ============================== (e) Lines that cannot be read ============================== */

  [
    ['an amount that is not a number', { amount: 'twelve dollars' }, 0],
    ['an amount sent as text', { amount: '12.50' }, 12.5],
    ['no amount', { amount: null }, 0],
    ['no day at all', { date: null, authorized_date: null }, 42.5],
    ['a day that is not a day', { date: '2026-13-45' }, 42.5],
    ['a name that is not text', { name: { text: 'SHELL' } }, 42.5],
    ['a merchant name that is not text', { merchant_name: ['Shell'] }, 42.5],
    ['a description that is not text', { account_id: 'chk', original_description: { raw: 'x' }, personal_finance_category: { primary: 'TRANSFER_OUT' } }, 42.5]
  ].forEach(function (c) {
    test('a line that cannot be read (' + c[0] + ') is stored, waiting: "Could not read this line"', function () {
      var l = line(c[1]);
      var threw = false;
      try { F.asTx(l, accounts()); } catch (e) { threw = true; }
      ok(threw, 'reading it throws');
      var r = run([l]);
      var row = r.row(l.transaction_id);
      ok(row, 'it is stored');
      eq(row.status, 'waiting', 'status'); eq(row.reason, null, 'reason'); eq(row.why, 'Could not read this line', 'why');
      eq(row.merchant, 'Unknown', 'name'); eq(row.amount, c[2], 'amount, as far as it can be read');
      eq(row.account_id, l.account_id, 'account');
      ok(G.parseDay(row.date), 'it has a day the database will take');
      eq(r.sorted.toFile.size, 0, 'it never files itself'); eq(r.led.unexplained, 0, 'unexplained'); eq(r.led.new_waiting, 1, 'ledger');
    });
  });
  test('a line that cannot be read keeps the day it does have, and falls back to today', function () {
    var a = line({ amount: 'x', date: '2026-10-09' });
    eq(run([a]).row(a.transaction_id).date, '2026-10-09', 'its own day');
    var b = line({ amount: 'x', date: null });
    eq(run([b]).row(b.transaction_id).date, TODAY, 'today');
  });
  test('a line that cannot be read is not turned into a deposit or a payment, and one unreadable line does not stop the others', function () {
    var bad = line({ account_id: 'inc', amount: -100, date: 'soon' }), good = line(), good2 = line({ account_id: 'chk' });
    var badPay = line({ account_id: 'card', amount: -400, date: 'soon', name: 'PAYMENT THANK YOU', personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') });
    var badOut = line({ account_id: 'inc', amount: 100, date: 'soon' });
    var r = run([good, bad, good2, badPay, badOut], { item: 'bankB' });
    eq(r.sorted.deposits.length, 0, 'deposits'); eq(r.sorted.payments.length, 0, 'payments');
    eq(r.sorted.items.length, 4, 'four are stored');
    eq(r.row(badOut.transaction_id).why, 'Could not read this line', 'money out that cannot be read is stored');
    eq(r.row(badPay.transaction_id).why, 'Could not read this line', 'anything on a card that cannot be read is stored');
    eq(r.row(good.transaction_id).status, 'filed', 'the first'); eq(r.row(good2.transaction_id).status, 'waiting', 'the third');
    // money coming in on a bank account is only ever counted, also when the line cannot be read
    eq(r.fate(bad.transaction_id), 'money_in', 'money in on a bank account'); eq(r.row(bad.transaction_id), null, 'no row for it');
    eq(r.led.not_kept.money_in, 1, 'counted'); eq(r.led.unexplained, 0, 'unexplained');
  });
  test('money IN on a bank account that cannot be read is counted, never stored; money out and anything on a card is stored', function () {
    [['chk', -100, 'money_in'], ['chkLog', -0.01, 'money_in'], ['inc', -2500, 'money_in'], ['nobody-knows-this-id', -5, 'money_in'], ['wrong', -75, 'money_in'],
      ['chk', 100, 'waiting'], ['chkLog', 0.01, 'waiting'], ['card', -100, 'waiting'], ['card', 100, 'waiting'], ['debitSaid', -100, 'waiting']].forEach(function (c) {
      [{ date: 'soon' }, { name: { text: 'X' } }, { merchant_name: ['X'] }, { date: null, authorized_date: null }].forEach(function (broken) {
        var l = line(Object.assign({ account_id: c[0], amount: c[1] }, broken));
        var r = run([l]);
        eq(r.fate(l.transaction_id), c[2], c[0] + ' ' + c[1] + ' ' + JSON.stringify(broken));
        if (c[2] === 'money_in') {
          eq(r.sorted.items.length, 0, 'no row'); eq(r.led.not_kept.money_in, 1, 'counted');
        } else {
          eq(r.row(l.transaction_id).why, 'Could not read this line', 'why'); eq(r.row(l.transaction_id).amount, c[1], 'amount');
        }
        eq(r.led.unexplained, 0, 'unexplained'); eq(r.sorted.toFile.size, 0, 'nothing files');
        eq(r.sorted.deposits.length, 0, 'never a deposit'); eq(r.sorted.payments.length, 0, 'never a payment');
      });
    });
    // an amount that cannot be read is not known to be money in: the line is stored
    var unknown = line({ account_id: 'chk', amount: 'twelve dollars' });
    eq(run([unknown]).fate(unknown.transaction_id), 'waiting', 'an amount that cannot be read');
  });
  test('a line that cannot be read, already held: nothing about its row changes', function () {
    var l = line({ amount: 'x' });
    var r = run([l], { known: new Map([[l.transaction_id, knownRow({ amount: 42.5 })]]) });
    eq(r.sorted.changes.length, 0, 'changes'); eq(r.sorted.items.length, 0, 'rows'); eq(r.fate(l.transaction_id), 'already', 'fate');
  });
  test('a posted line with no id cannot be stored: it is unexplained, so the read does not move on', function () {
    var r = run([line(), line({ transaction_id: null }), line({ transaction_id: '   ' }), null, 'not a line', line({ transaction_id: 77 })]);
    eq(r.led.bank_sent, 6, 'bank_sent counts every posted line handed over');
    eq(r.took.noId, 4, 'lines with no usable id');
    eq(r.sorted.items.length, 2, 'the two with an id are stored');
    eq(r.led.unexplained, 4, 'unexplained');
    eq(F.ledgerSum([r.led]).unexplained, 4, 'and the run’s total says so');
  });
  test('an account switched off is still counted when its line cannot be read', function () {
    var l = line({ account_id: 'sav', amount: 'x' });
    var r = run([l]);
    eq(r.fate(l.transaction_id), 'off', 'fate'); eq(r.sorted.items.length, 0, 'rows'); eq(r.led.unexplained, 0, 'unexplained');
  });

  test('a tour whose own data the rules cannot read stops nothing: every line is still kept, waiting, on no tour', function () {
    // (asTours would never hand this over; it stands in for anything in a tour's document the rules did not expect)
    var broken = [{ id: 'bad', doc: null, win: { from: '2026-10-01', to: '2026-10-20' } }];
    var added = [line(), line({ account_id: 'chk', amount: 500, name: 'Zelle payment to Sam', merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT') }),
      line({ account_id: 'chk', amount: -900, name: 'DEPOSIT', merchant_name: null, personal_finance_category: pfc('INCOME') }),
      line({ account_id: 'sav' }), line({ account_id: 'card', amount: -20 })];
    var r = run(added, { tours: broken });
    checkInvariant(added, r, 'broken tour');
    eq(r.sorted.items.length, 3, 'rows');
    r.sorted.items.forEach(function (row) {
      eq(row.status, 'waiting', 'status'); eq(row.why, 'Could not read this line', 'why'); eq(row.tour_id, null, 'tour'); eq(row.reason, null, 'reason');
    });
    eq(r.fate(added[2].transaction_id), 'money_in', 'a deposit is still only counted');
    eq(r.fate(added[3].transaction_id), 'off', 'a switched-off account is still only counted');
    eq(r.sorted.toFile.size, 0, 'nothing files');
    // and a row already here is left exactly as it is
    var k = line({ account_id: 'chk', date: '2026-09-10' });
    var again = run([k], { tours: broken, fromStart: true, known: new Map([[k.transaction_id, knownRow({ status: 'left_out', reason: 'outside_dates', date: '2026-09-10' })]]) });
    eq(again.sorted.changes.length, 0, 'changes'); eq(again.fate(k.transaction_id), 'already', 'fate');
  });

  /* ============================== (f) The ledger ============================== */

  test('the ledger adds up per connection, and across them', function () {
    var acc = accounts();
    var a = [], b = [];
    ['card', 'chk', 'chkLog', 'sav', 'wrong'].forEach(function (id) {
      LABELSETS.forEach(function (lab) {
        [42.5, -42.5, 0].forEach(function (amt) {
          ['2026-09-30', FRESH].forEach(function (day) { a.push(line({ account_id: id, amount: amt, date: day, personal_finance_category: lab })); });
        });
      });
    });
    LABELSETS.forEach(function (lab) {
      [300, -300].forEach(function (amt) { b.push(line({ account_id: 'inc', amount: amt, date: FRESH, name: 'PROMOTER LLC', merchant_name: null, personal_finance_category: lab })); });
    });
    a.push(line({ pending: true })); a.push(line({ pending: true })); b.push(line({ account_id: 'inc', pending: true }));
    // some of bank A's lines are already here
    var first = run(a.slice(0, 40), { accounts: acc });
    var known = knownFrom(first.sorted.items);
    var tookA = F.takeRead({ added: a, modified: [], removed: [] }, acc, NOW, 'bankA', false, 0);
    var tookB = F.takeRead({ added: b, modified: [], removed: [] }, acc, NOW, 'bankB', true, 5000);
    var sorted = F.sortTransactions(tookA.txs.concat(tookB.txs), acc, tours(), LABELS, known, 'owner-1', NOW, INCOME, true);
    var la = F.ledgerLine(tookA.sent, tookA.pending, sorted.ledger.bankA), lb = F.ledgerLine(tookB.sent, tookB.pending, sorted.ledger.bankB);
    [[la, a, 'bank A', 2], [lb, b, 'bank B', 1]].forEach(function (x) {
      var l = x[0], posted = x[1].filter(function (t) { return !t.pending; });
      var off = 0; Object.keys(l.not_kept.off).forEach(function (k) { off += l.not_kept.off[k]; });
      var reasons = 0; Object.keys(l.reasons).forEach(function (k) { reasons += l.reasons[k]; });
      eq(l.bank_sent, posted.length, x[2] + ': bank_sent');
      eq(l.pending, x[3], x[2] + ': pending');
      eq(l.already_here + l.new_waiting + l.new_filed + l.new_left_out + off + l.not_kept.money_in, l.bank_sent, x[2] + ': everything is somewhere');
      eq(l.unexplained, 0, x[2] + ': unexplained');
      eq(reasons, l.new_left_out, x[2] + ': reasons add up');
      eq(l.rules, F.RULES, x[2] + ': rules');
      // each connection's rows are its own
      var mine = {}; posted.forEach(function (t) { mine[t.transaction_id] = true; });
      var rows = sorted.items.filter(function (r) { return mine[r.id]; });
      eq(rows.length, l.new_waiting + l.new_filed + l.new_left_out, x[2] + ': rows');
    });
    eq(la.already_here, first.sorted.items.length, 'bank A: already here');
    ok(la.not_kept.off['Savings ··9999'] > 0, 'bank A: the switched-off account is counted by name');
    eq(la.deposits, 0, 'bank A: deposits'); ok(lb.deposits > 0, 'bank B: deposits on the watched account');
    eq(la.first_day, '2026-09-30', 'bank A: first day'); eq(la.last_day, FRESH, 'bank A: last day');
    eq(lb.first_day, FRESH, 'bank B: first day');
    var sum = F.ledgerSum([la, lb]);
    eq(sum.sent, la.bank_sent + lb.bank_sent, 'sum: sent');
    eq(sum.already + sum.waiting + sum.filed + sum.left_out + sum.not_kept, sum.sent, 'sum: everything is somewhere');
    eq(sum.unexplained, 0, 'sum: unexplained');
    eq(sum.filed, 0, 'a run with a read from the start in it files nothing');
  });
  test('the ledger for a bank that sent nothing, or whose read failed, is all zeros', function () {
    var l = F.ledgerLine(0, 0, undefined);
    eq(l.bank_sent, 0, 'bank_sent'); eq(l.unexplained, 0, 'unexplained'); eq(l.first_day, null, 'first_day'); eq(l.rules, F.RULES, 'rules');
    eq(JSON.stringify(l.not_kept), '{"off":{},"money_in":0}', 'not_kept shape'); eq(JSON.stringify(l.reasons), '{}', 'reasons shape');
  });
  test('the ledger cannot be fooled by two banks cancelling out', function () {
    var short = F.ledgerLine(5, 0, F.ledgerOf({}, 'x'));                 // five sent, none accounted for
    var c = F.ledgerOf({}, 'y'); c.waiting = 5;
    var over = F.ledgerLine(0, 0, c);                                    // none sent, five counted
    eq(short.unexplained, 5, 'short'); eq(over.unexplained, -5, 'over');
    eq(F.ledgerSum([short, over]).unexplained, 10, 'the total does not come to zero');
  });
  test('the same id twice in one run is one row', function () {
    var acc = accounts(), l = line();
    var a = F.takeRead({ added: [l] }, acc, NOW, 'bankA', false, 0), b = F.takeRead({ added: [l] }, acc, NOW, 'bankB', false, 10);
    var s = F.sortTransactions(a.txs.concat(b.txs), acc, tours(), LABELS, new Map(), 'owner-1', NOW, INCOME, false);
    eq(s.items.length, 1, 'rows'); eq(s.toFile.get('t1').n, 1, 'charges');
    eq(F.ledgerLine(a.sent, 0, s.ledger.bankA).unexplained, 0, 'bank A'); eq(F.ledgerLine(b.sent, 0, s.ledger.bankB).unexplained, 0, 'bank B');
    eq(s.ledger.bankB.already, 1, 'the second is already here');
  });

  test('asTours leaves out tours that are taken down, and reads each tour’s card dates', function () {
    var t = F.asTours([{ id: 'a', doc: tourDoc() }, { id: 'b', doc: tourDoc({ deletedAt: 5 }) }, { id: 'c', doc: tourDoc({ cardLog: null }) }, { id: 'd', doc: null }]);
    eq(t.map(function (x) { return x.id; }).join(','), 'a,c,d', 'which tours');
    eq(JSON.stringify(t[0].win), '{"from":"2026-10-01","to":"2026-10-20"}', 'card dates'); eq(t[1].win, null, 'no card dates');
  });

  /* ============================== (g) Nothing the old rules hid files itself ============================== */

  var UTIL = pfc('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_TELEPHONE');
  var SERVICES = pfc('GENERAL_SERVICES', 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES');
  var MAYBE = 'May be a payment or a move';

  test('"VERIZON WIRELESS AUTOPAY" on a card set to log, the merchant learned, a fresh day: stored waiting, not filed', function () {
    var labels = S.learnLabel(S.learnLabel({}, 'Shell', 'gas'), 'Verizon Wireless', 'utilities');
    var x = one({ account_id: 'card', amount: 180.23, name: 'VERIZON WIRELESS AUTOPAY', merchant_name: 'Verizon Wireless', personal_finance_category: UTIL }, { labels: labels });
    ok(x.row, 'it is stored'); eq(x.row.status, 'waiting', 'status'); eq(x.row.why, MAYBE, 'why'); eq(x.row.reason, null, 'reason');
    eq(x.row.category, 'utilities', 'what was learned is still offered'); eq(x.row.tour_id, 't1', 'tour'); eq(x.row.amount, 180.23, 'amount');
    eq(x.r.sorted.toFile.size, 0, 'no charge goes to a tour'); eq(x.r.led.new_filed, 0, 'ledger: filed'); eq(x.r.led.new_waiting, 1, 'ledger: waiting');
    // the same merchant, learned, without the word: this is the line that may file
    var plain = one({ account_id: 'card', amount: 180.23, name: 'VERIZON WIRELESS', merchant_name: 'Verizon Wireless', personal_finance_category: UTIL }, { labels: labels });
    eq(plain.row.status, 'filed', 'an ordinary learned merchant with none of the words still files');
    ok(plain.r.sorted.toFile.get('t1').charges['p' + plain.id], 'its charge is in the bucket');
  });
  test('"ATT BILL PMT" from a bank account set to log, the merchant learned, a fresh day: stored waiting, not filed', function () {
    var labels = S.learnLabel(S.learnLabel({}, S.cleanMerchant('ATT BILL PMT'), 'utilities'), S.cleanMerchant('ATT BILL'), 'utilities');
    var x = one({ account_id: 'chkLog', amount: 96.4, name: 'ATT BILL PMT', merchant_name: null, personal_finance_category: UTIL }, { labels: labels });
    ok(x.row, 'it is stored'); eq(x.row.status, 'waiting', 'status'); eq(x.row.why, MAYBE, 'why'); eq(x.row.category, 'utilities', 'category');
    eq(x.r.sorted.toFile.size, 0, 'no charge goes to a tour');
    var plain = one({ account_id: 'chkLog', amount: 96.4, name: 'ATT BILL', merchant_name: null, personal_finance_category: UTIL }, { labels: labels });
    eq(plain.row.status, 'filed', 'an ordinary learned merchant with none of the words still files');
  });
  test('every word the old rules hid a line for makes it wait, on a card and on a bank account, learned and fresh', function () {
    var names = ['VERIZON WIRELESS AUTOPAY', 'STATE FARM AUTO PAY', 'STATE FARM AUTO-PAY', 'STORAGE UNIT E PAYMENT', 'STORAGE UNIT E-PAYMENT', 'STORAGE UNIT EPAYMENT',
      'ATT BILL PMT', 'PARKING PMT', 'CITY WATER WEB PYMT', 'Transfer Station Brewing', 'FUNDS TRANSFER TO PARTNER', 'MONEY TRANSFER FROM SHOP',
      'ONLINE TRANSFER 4411', 'ONLINE BANKING TRANSFER 4411', 'STARTING BALANCE', 'STARTING BALANCE BREWERY', 'Reconciliation Balance Adjustment',
      'Manual Balance Adjustment', 'Amex Travel Payment', 'Bank of America Stadium Parking PMT', 'PAYMENT - THANK YOU', 'CARDMEMBER SERV'];
    var labels = learnedAll(names.concat(['ORDINARY PLACE']));
    ['card', 'chkLog', 'wrong', 'debitSaid'].forEach(function (a) {
      // the set-up can file: an ordinary learned name does
      eq(one({ account_id: a, amount: 61.5, name: 'ORDINARY PLACE', merchant_name: null, personal_finance_category: SERVICES }, { labels: labels }).fate, 'filed', 'control on ' + a);
      names.forEach(function (nm) {
        [SERVICES, UTIL, undefined, pfc('OTHER', 'OTHER_OTHER'), pfc('BRAND_NEW_HEADING', 'BRAND_NEW_HEADING_X')].forEach(function (lab) {
          var x = one({ account_id: a, amount: 61.5, name: nm, merchant_name: null, personal_finance_category: lab }, { labels: labels });
          ok(x.row, nm + ' on ' + a + ': stored');
          has(['waiting', 'left_out'], x.row.status, nm + ' on ' + a + ' under ' + JSON.stringify(lab));
          eq(x.r.sorted.toFile.size, 0, nm + ' on ' + a + ': nothing files');
          // on a card nothing is left out for a word, so it is always the waiting row, with these words
          if (a === 'card' || a === 'debitSaid') { eq(x.row.status, 'waiting', nm + ' on a card'); eq(x.row.why, MAYBE, nm + ' on a card: why'); }
        });
      });
    });
  });
  test('transfer wording that is only in the name of who the money went to still makes the line wait', function () {
    // (The line as the old rules read it waited as a Transfer; it must not file itself now.)
    var labels = learnedAll(['EXAMPLE PARTNER LLC']);
    ['card', 'debitSaid', 'chkLog', 'wrong'].forEach(function (a) {
      [undefined, pfc('OTHER', 'OTHER_OTHER')].forEach(function (lab) {
        var x = one({ account_id: a, amount: 250, name: 'EXAMPLE PARTNER LLC', merchant_name: null, personal_finance_category: lab,
          counterparties: [{ name: 'Transfer to Example Partner' }] }, { labels: labels });
        ok(x.row, 'stored on ' + a);
        eq(x.row.status, 'waiting', 'waits on ' + a + ' under ' + JSON.stringify(lab));
        eq(x.r.sorted.toFile.size, 0, 'nothing files on ' + a);
      });
    });
  });
  test('the word is looked for in the name, the merchant name and the bank’s own description, each on its own', function () {
    var labels = learnedAll(['Verizon Wireless', 'Vzw Autopay']);
    var base = { account_id: 'card', amount: 180.23, personal_finance_category: UTIL };
    eq(one(Object.assign({ name: 'VERIZON WIRELESS', merchant_name: 'Verizon Wireless' }, base), { labels: labels }).fate, 'filed', 'none of them');
    eq(one(Object.assign({ name: 'VERIZON WIRELESS AUTOPAY', merchant_name: 'Verizon Wireless' }, base), { labels: labels }).row.why, MAYBE, 'in the name');
    eq(one(Object.assign({ name: 'VZW', merchant_name: 'VZW Autopay' }, base), { labels: labels }).row.why, MAYBE, 'in the merchant name');
    eq(one(Object.assign({ name: 'VERIZON WIRELESS', merchant_name: 'Verizon Wireless', original_description: 'VERIZON WRLS AUTOPAY 8844' }, base), { labels: labels }).row.why, MAYBE, 'in the bank’s description');
    // F.isWary on its own
    eq(F.isWary({ amount: 5, name: 'ATT BILL PMT' }, {}, false, false), true, 'pmt');
    eq(F.isWary({ amount: -5, name: 'ATT BILL PMT' }, {}, false, false), false, 'money in is not money out');
    eq(F.isWary({ amount: 5, name: 'SHELL OIL' }, { primary: 'TRANSPORTATION' }, true, false), false, 'an ordinary charge');
    eq(F.isWary({ amount: 5, name: 'PAYMENTUS CITY PARKING' }, {}, true, false), false, 'a word inside another word is not the word');
  });
  test('Zelle or wire wording never files itself on any kind of account; a "transfer in" heading on money out of a card neither', function () {
    var labels = learnedAll(['Zelle', 'OUTGOING WIRE FEE', 'LIVE WIRE LOUNGE']);
    var z = one({ account_id: 'card', amount: 25, name: 'ZELLE *SAM', merchant_name: 'Zelle', personal_finance_category: SERVICES }, { labels: labels });
    eq(z.row.status, 'waiting', 'Zelle wording on a card'); eq(z.row.why, MAYBE, 'why');
    var w = one({ account_id: 'card', amount: 30, name: 'OUTGOING WIRE FEE', merchant_name: null, personal_finance_category: pfc('BANK_FEES', 'BANK_FEES_OTHER_BANK_FEES') }, { labels: labels });
    eq(w.row.status, 'waiting', 'wire wording on a card'); eq(w.row.why, MAYBE, 'why');
    eq(one({ account_id: 'card', amount: 30, name: 'LIVE WIRE LOUNGE', merchant_name: null, personal_finance_category: pfc('FOOD_AND_DRINK') }, { labels: labels }).fate, 'filed', 'the Live Wire Lounge is not a wire');
    // a card someone answered "Debit card": the bank still says card, so Zelle wording marks nothing as sent, and it waits all the same
    var d = one({ account_id: 'debitSaid', amount: 25, name: 'ZELLE *SAM', merchant_name: 'Zelle', personal_finance_category: SERVICES }, { labels: labels });
    eq(d.row.status, 'waiting', 'Zelle wording on a card answered Debit');
    // "transfer in" on money OUT of a card, by the bank's reading or by the person's answer
    var TIN = pfc('TRANSFER_IN', 'TRANSFER_IN_ACCOUNT_TRANSFER');
    ['card', 'debitSaid', 'wrong'].forEach(function (a) {
      var x = one({ account_id: a, amount: 42.5, personal_finance_category: TIN });
      eq(x.row.status, 'waiting', 'transfer in, money out, on ' + a); eq(x.row.why, MAYBE, 'why on ' + a);
      eq(one({ account_id: a }).fate, 'filed', 'the same line under an ordinary heading files on ' + a);
    });
  });
  test('a more exact reason still comes first, and the line waits either way', function () {
    var labels = learnedAll(['Verizon Wireless']);
    var l = { amount: 180.23, name: 'VERIZON WIRELESS AUTOPAY', merchant_name: 'Verizon Wireless', personal_finance_category: UTIL };
    var typed = F.asTours([{ id: 't1', doc: tourDoc({ charges: { c1: { date: '2026-10-14', amount: 180.23, merchant: 'Verizon', category: 'utilities' } } }) }]);
    eq(one(Object.assign({ account_id: 'card' }, l), { labels: labels, tours: typed }).row.why, 'Maybe already in', 'a look-alike');
    var two = F.asTours([{ id: 't1', doc: tourDoc() }, { id: 't2', doc: tourDoc({ name: 'Second Tour' }) }]);
    eq(one(Object.assign({ account_id: 'card' }, l), { labels: labels, tours: two }).row.why, 'Two tours that day', 'two tours');
    // and it says so in place of the plain reasons, which tell a person less
    eq(one(Object.assign({ account_id: 'cardAsk' }, l), { labels: labels }).row.why, MAYBE, 'on an account that asks first');
    eq(one(Object.assign({ account_id: 'card' }, l), { labels: {} }).row.why, MAYBE, 'a merchant nobody has learned');
    eq(one(Object.assign({ account_id: 'card' }, l), { labels: labels, hold: true, fromStart: true }).row.why, MAYBE, 'in a read from the start');
    eq(one(Object.assign({ account_id: 'card', date: '2026-10-02' }, l), { labels: labels }).row.why, MAYBE, 'older than two weeks');
  });

  /* ============================== (h) The other half of a card payment ============================== */

  test('money out of a bank account, the same amount arriving as a payment on a linked card: it waits, "May be a payment to" that card', function () {
    var labels = learnedAll(['Capital One']);
    var PAY = pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT');
    function out(o) { return line(Object.assign({ account_id: 'chkLog', amount: 300, name: 'CAPITAL ONE', merchant_name: 'Capital One', personal_finance_category: SERVICES }, o || {})); }
    function inn(o) { return line(Object.assign({ account_id: 'card', amount: -300, name: 'PAYMENT RECEIVED', merchant_name: null, personal_finance_category: PAY }, o || {})); }
    // alone, on an account set to log, learned and fresh, it would file
    var alone = out(); eq(run([alone], { labels: labels }).fate(alone.transaction_id), 'filed', 'alone it files');
    var a = out(), b = inn();
    var r = run([a, b], { labels: labels });
    eq(r.row(a.transaction_id).status, 'waiting', 'the bank side waits');
    eq(r.row(a.transaction_id).why, 'May be a payment to Gold Card ··1111', 'why names the card');
    eq(r.fate(b.transaction_id), 'left_out:card_payment', 'the card side is a card payment');
    eq(r.sorted.toFile.size, 0, 'nothing files'); eq(r.led.unexplained, 0, 'unexplained');
    // the other order, and up to three days apart
    var c = out({ date: '2026-10-12' }), d = inn({ date: '2026-10-15' });
    eq(run([d, c], { labels: labels }).row(c.transaction_id).why, 'May be a payment to Gold Card ··1111', 'three days apart, card side first');
    // not the same amount, not within three days, or not a payment: it is an ordinary line again
    var e = out(), f = inn({ amount: -300.5 });
    eq(run([e, f], { labels: labels }).fate(e.transaction_id), 'filed', 'another amount');
    var g = out({ date: '2026-10-10' }), h = inn({ date: '2026-10-15' });
    eq(run([g, h], { labels: labels }).fate(g.transaction_id), 'filed', 'five days apart');
    var i = out(), j = line({ account_id: 'card', amount: -300, name: 'SHELL OIL 5744', merchant_name: 'Shell' });
    eq(run([i, j], { labels: labels }).fate(i.transaction_id), 'filed', 'a refund of the same amount is not a payment');
    // with one of the old words in its name it waits anyway, and the payment is the more exact reason
    var k = out({ name: 'CAPITAL ONE MOBILE PMT', merchant_name: null }), l = inn();
    var labels2 = learnedAll(['CAPITAL ONE MOBILE PMT']);
    eq(run([k], { labels: labels2 }).row(k.transaction_id).why, MAYBE, 'the word alone');
    eq(run([k, l], { labels: labels2 }).row(k.transaction_id).why, 'May be a payment to Gold Card ··1111', 'the word and the other half');
    // a charge ON a card is never taken for a payment to another card
    var m = line({ account_id: 'card', amount: 300 }), n2 = line({ account_id: 'debitSaid', amount: -300, name: 'PAYMENT RECEIVED', merchant_name: null, personal_finance_category: PAY });
    eq(run([m, n2]).fate(m.transaction_id), 'filed', 'a charge on a card');
  });
  test('the other half is found by amount and day whatever the order and however many lines the read has', function () {
    var by = F.arrivalsOf([{ id: 'a', account_id: 'x', amount: 300000, date: '2026-10-15' }, { id: 'b', account_id: 'x', amount: -300000, date: '2026-10-15' },
      { id: 'c', account_id: 'y', amount: 300000, date: '2026-10-15', deleted: true }, { id: 'd', account_id: 'y', amount: 300000, date: '2026-10-15', unreadable: true }]);
    eq(F.otherHalf(by, { account_id: 'z', amount: -300000, date: '2026-10-16' }).id, 'a', 'found');
    eq(F.otherHalf(by, { account_id: 'x', amount: -300000, date: '2026-10-16' }), null, 'never the same account');
    eq(F.otherHalf(by, { account_id: 'z', amount: -300010, date: '2026-10-16' }), null, 'a cent off is another amount');
    eq(F.otherHalf(by, { account_id: 'z', amount: -300000, date: '2026-10-19' }), null, 'four days off');
    eq(F.otherHalf(by, { account_id: 'z', amount: -300000, date: 'never' }), null, 'no day, no match');
  });

  /* ============================== (i) Before the tour: only money sent from a BANK account is exempt ============================== */

  test('before the tour: money sent from a card is inside the card’s opening balance; money sent from a bank account is not', function () {
    var world = F.asTours([{ id: 't1', doc: tourDoc({ debts: { d1: { kind: 'card', label: 'Old card', amount: 900, cutoff: '2026-10-03' } } }) }]);
    var OUT = pfc('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER');
    var adv = one({ account_id: 'card', date: '2026-10-02', amount: 300, name: 'CASH ADVANCE', merchant_name: null, personal_finance_category: OUT }, { tours: world });
    eq(adv.fate, 'left_out:before_tour', 'a cash advance on a card before the opening balance day');
    var inst = one({ account_id: 'debitSaid', date: '2026-10-03', amount: 89, name: 'AFFIRM PAY', merchant_name: 'Affirm', personal_finance_category: pfc('LOAN_PAYMENTS') }, { tours: world });
    eq(inst.fate, 'left_out:before_tour', 'money sent from a card someone answered Debit card, on the day itself');
    var after = one({ account_id: 'card', date: '2026-10-04', amount: 300, name: 'CASH ADVANCE', merchant_name: null, personal_finance_category: OUT }, { tours: world });
    eq(after.row.why, 'Cash advance or money sent from a card', 'the day after, it waits as before');
    // from a bank account every sent kind still waits, before the day or not
    [[ZELLE, OUT, 'Zelle'], ['Venmo', OUT, 'Transfer'], ['ATM WITHDRAWAL 5TH AVE', undefined, 'Cash withdrawal'], ['TRAILER LOAN', pfc('LOAN_PAYMENTS'), 'Loan payment'], [WIRE, OUT, 'Wire']].forEach(function (c) {
      ['chk', 'wrong'].forEach(function (a) {
        var x = one({ account_id: a, date: '2026-10-02', amount: 500, name: c[0], merchant_name: null, personal_finance_category: c[1] }, { tours: world });
        eq(x.fate, 'waiting', c[2] + ' from ' + a); eq(x.row.why, c[2], 'why');
      });
    });
  });
  test('a "before the tour" row whose day now falls in two tours stays while either tour’s opening balance day still covers it', function () {
    function two(cut1, cut2) {
      return F.asTours([{ id: 't1', doc: tourDoc(cut1 ? { debts: { d1: { kind: 'card', label: 'Old', amount: 5, cutoff: cut1 } } } : {}) },
        { id: 't2', doc: tourDoc(Object.assign({ name: 'Second Tour' }, cut2 ? { debts: { d2: { kind: 'card', label: 'Other', amount: 5, cutoff: cut2 } } } : {})) }]);
    }
    var b = line({ account_id: 'chk', date: '2026-10-02' });
    var was = new Map([[b.transaction_id, knownRow({ status: 'left_out', reason: 'before_tour', date: '2026-10-02' })]]);
    eq(run([b], { known: was, tours: two('2026-10-03', null), fromStart: true }).sorted.changes.length, 0, 'the first tour’s day covers it');
    eq(run([b], { known: was, tours: two(null, '2026-10-02'), fromStart: true }).sorted.changes.length, 0, 'the second tour’s day covers it');
    eq(JSON.stringify(run([b], { known: was, tours: two('2026-10-01', '2026-09-30'), fromStart: true }).sorted.changes),
      JSON.stringify([{ id: b.transaction_id, kind: 'resort', tour_id: null }]), 'neither covers it: it waits for a person to pick the tour');
    eq(JSON.stringify(run([b], { known: was, tours: two(null, null), fromStart: true }).sorted.changes),
      JSON.stringify([{ id: b.transaction_id, kind: 'resort', tour_id: null }]), 'no opening balance day at all');
    // a row left out for its DAY that now falls in two tours waits for a pick, as a new line would
    var wasOut = new Map([[b.transaction_id, knownRow({ status: 'left_out', reason: 'outside_dates', date: '2026-10-02' })]]);
    eq(run([b], { known: wasOut, tours: two('2026-10-03', null), fromStart: true }).sorted.changes[0].kind, 'resort', 'outside_dates');
    // money sent from a card stays before the tour; money sent from a bank account never was
    var one1 = function (cut) { return F.asTours([{ id: 't1', doc: tourDoc({ debts: { d1: { kind: 'card', label: 'Old', amount: 5, cutoff: cut } } }) }]); };
    var adv = line({ account_id: 'card', date: '2026-10-02', amount: 300, name: 'CASH ADVANCE', merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT') });
    var wasAdv = new Map([[adv.transaction_id, knownRow({ status: 'left_out', reason: 'before_tour', date: '2026-10-02', amount: 300 })]]);
    eq(run([adv], { known: wasAdv, tours: one1('2026-10-03'), fromStart: true }).sorted.changes.length, 0, 'sent from a card: still before the tour');
    var z = line({ account_id: 'chk', date: '2026-10-02', amount: 500, name: ZELLE, merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT') });
    var wasZ = new Map([[z.transaction_id, knownRow({ status: 'left_out', reason: 'before_tour', date: '2026-10-02', amount: 500 })]]);
    eq(run([z], { known: wasZ, tours: one1('2026-10-03'), fromStart: true }).sorted.changes[0].kind, 'resort', 'sent from a bank account: it comes to wait');
  });

  /* ============================== (j) A left-out row the bank has changed; a line the bank sends again ============================== */

  test('a left-out row is looked at again when the bank changes the line: it comes to wait, on any read', function () {
    [false, true].forEach(function (fromStart) {
      var o = function (known, extra) { return Object.assign({ known: known, fromStart: fromStart, hold: fromStart }, extra || {}); };
      // held as "Zero amount", the bank now gives 187.40
      var z = line({ account_id: 'chk', amount: 187.4 });
      var rz = run([z], o(new Map([[z.transaction_id, knownRow({ status: 'left_out', reason: 'zero', amount: 0 })]])));
      eq(JSON.stringify(rz.sorted.changes), JSON.stringify([{ id: z.transaction_id, kind: 'amount', open: true, amount: 187.4 }, { id: z.transaction_id, kind: 'relabel', from: 'zero' }]), 'zero, now 187.40');
      // held as "Moved to savings", the bank now files it as a transfer to a person
      var m = line({ account_id: 'chk', amount: 1000, name: 'Online Transfer', merchant_name: null, personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER') });
      var rm = run([m], o(new Map([[m.transaction_id, knownRow({ status: 'left_out', reason: 'own_move', amount: 1000 })]])));
      eq(JSON.stringify(rm.sorted.changes), JSON.stringify([{ id: m.transaction_id, kind: 'relabel', from: 'own_move' }]), 'own_move, now a transfer');
      // held as "Card payment" for its words, the description is now an ordinary bill
      var c = line({ account_id: 'chk', amount: 96.4, name: 'CITY WATER BILL', merchant_name: null, personal_finance_category: UTIL });
      var rc = run([c], o(new Map([[c.transaction_id, knownRow({ status: 'left_out', reason: 'card_payment', amount: 96.4 })]])));
      eq(JSON.stringify(rc.sorted.changes), JSON.stringify([{ id: c.transaction_id, kind: 'relabel', from: 'card_payment' }]), 'card_payment, now a bill');
      // money arriving on a card held as a card payment, now a refund
      var p = line({ account_id: 'card', amount: -20, name: 'SHELL OIL 5744', merchant_name: 'Shell' });
      var rp = run([p], o(new Map([[p.transaction_id, knownRow({ status: 'left_out', reason: 'card_payment', amount: -20 })]])));
      eq(rp.sorted.changes.length, 1, 'card side'); eq(rp.sorted.changes[0].kind, 'relabel', 'card side: kind');
      [rz, rm, rc, rp].forEach(function (r) { eq(r.sorted.items.length, 0, 'never a second row'); eq(r.sorted.toFile.size, 0, 'nothing files'); eq(r.led.already_here, 1, 'already here'); });
    });
  });
  test('a left-out row the bank still sends as what it is stays where it is; so does one a person dealt with, and a deposit', function () {
    var PAY = pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT');
    [['zero', { account_id: 'chk', amount: 0 }, 0],
      ['card_payment', { account_id: 'chk', amount: 2000, name: 'CHASE CREDIT CRD AUTOPAY', merchant_name: 'Chase', personal_finance_category: PAY }, 2000],
      ['card_payment', { account_id: 'chk', amount: 300, name: 'PAYMENT - THANK YOU', merchant_name: null, personal_finance_category: pfc('OTHER') }, 300],
      ['card_payment', { account_id: 'card', amount: -500, name: 'ONLINE PMT RECEIVED', merchant_name: null, personal_finance_category: PAY }, -500],
      ['own_move', { account_id: 'chk', amount: 1000, name: 'VANGUARD BUY', merchant_name: 'Vanguard', personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS') }, 1000]
    ].forEach(function (c) {
      [false, true].forEach(function (fromStart) {
        var l = line(c[1]);
        var r = run([l], { known: new Map([[l.transaction_id, knownRow({ status: 'left_out', reason: c[0], amount: c[2] })]]), fromStart: fromStart, hold: fromStart });
        eq(r.sorted.changes.length, 0, c[0] + ' (' + (c[1].name || 'zero') + ')');
      });
    });
    // rows a person dealt with are never moved, whatever the bank says now
    var bill = line({ account_id: 'chk', amount: 96.4, name: 'CITY WATER BILL', merchant_name: null, personal_finance_category: UTIL });
    ['filed', 'skipped', 'mypay', 'waiting'].forEach(function (st) {
      var r = run([bill], { known: new Map([[bill.transaction_id, knownRow({ status: st, reason: st === 'skipped' ? 'set_aside' : null, amount: 96.4 })]]) });
      eq(r.sorted.changes.length, 0, st);
    });
    // a row held as "Zero amount" that is now money coming in on a bank account: the amount is noted, it is not brought into the pile
    var dep = line({ account_id: 'chk', amount: -75, name: 'DEPOSIT', merchant_name: null, personal_finance_category: pfc('INCOME') });
    var rd = run([dep], { known: new Map([[dep.transaction_id, knownRow({ status: 'left_out', reason: 'zero', amount: 0 })]]) });
    eq(JSON.stringify(rd.sorted.changes.map(function (c) { return c.kind; })), '["amount"]', 'a deposit');
    // an account that is switched off now: nothing
    var off = line({ account_id: 'sav', amount: 50 });
    eq(run([off], { known: new Map([[off.transaction_id, knownRow({ status: 'left_out', reason: 'zero', amount: 0 })]]) }).sorted.changes.filter(function (c) { return c.kind === 'relabel'; }).length, 0, 'switched off');
    // a line that cannot be read changes nothing
    var bad = line({ account_id: 'chk', amount: 'x' });
    eq(run([bad], { known: new Map([[bad.transaction_id, knownRow({ status: 'left_out', reason: 'zero', amount: 0 })]]) }).sorted.changes.length, 0, 'unreadable');
  });
  test('a line the bank took back and now sends again, alive: the row comes to wait, and a filed row loses its "taken back" mark', function () {
    [false, true].forEach(function (fromStart) {
      var l = line({ account_id: 'chk' });
      var r = run([l], { known: new Map([[l.transaction_id, knownRow({ status: 'left_out', reason: 'bank_removed', gone_on: '2026-10-18' })]]), fromStart: fromStart, hold: fromStart });
      eq(JSON.stringify(r.sorted.changes), JSON.stringify([{ id: l.transaction_id, kind: 'alive', open: true }]), 'taken back, alive again');
      eq(r.sorted.items.length, 0, 'never a second row'); eq(r.fate(l.transaction_id), 'already', 'fate');
      ['filed', 'skipped', 'mypay'].forEach(function (st) {
        var f = line();
        var rf = run([f], { known: new Map([[f.transaction_id, knownRow({ status: st, reason: st === 'skipped' ? 'set_aside' : null, gone_on: '2026-10-18' })]]), fromStart: fromStart });
        eq(JSON.stringify(rf.sorted.changes), JSON.stringify([{ id: f.transaction_id, kind: 'alive', open: false }]), st + ' with a taken-back mark');
        var g = line();
        eq(run([g], { known: new Map([[g.transaction_id, knownRow({ status: st, reason: st === 'skipped' ? 'set_aside' : null, gone_on: null })]]), fromStart: fromStart }).sorted.changes.length, 0, st + ' with no mark');
      });
    });
    // sent and removed in the same read: the removal is what happens, it is not "alive"
    var k = line();
    var rk = run([k], { known: new Map([[k.transaction_id, knownRow({ status: 'left_out', reason: 'bank_removed', gone_on: '2026-10-18' })]]), removed: [{ transaction_id: k.transaction_id }] });
    eq(JSON.stringify(rk.sorted.changes.map(function (c) { return c.kind; })), '["gone"]', 'removed again in the same read');
    // a waiting row with no mark: nothing; a taken-back row on an account now switched off: left where it is
    var w = line();
    eq(run([w], { known: new Map([[w.transaction_id, knownRow()]]) }).sorted.changes.length, 0, 'waiting');
    var s2 = line({ account_id: 'sav' });
    eq(run([s2], { known: new Map([[s2.transaction_id, knownRow({ status: 'left_out', reason: 'bank_removed', gone_on: '2026-10-18' })]]) }).sorted.changes.length, 0, 'switched off');
    // alive again and it cannot be read: it still comes to wait (it is a line the bank sent)
    var bad = line({ amount: 'x' });
    eq(JSON.stringify(run([bad], { known: new Map([[bad.transaction_id, knownRow({ status: 'left_out', reason: 'bank_removed', gone_on: '2026-10-18' })]]) }).sorted.changes),
      JSON.stringify([{ id: bad.transaction_id, kind: 'alive', open: true }]), 'unreadable but alive');
  });
  test('nothing a run does to a row it already holds can do anything but mark it or move it to waiting', function () {
    // every kind of change the sorter can ask for, over rows of every status
    var kinds = {};
    ['waiting', 'filed', 'skipped', 'mypay', 'left_out'].forEach(function (st) {
      [null, 'zero', 'card_payment', 'own_move', 'outside_dates', 'before_tour', 'bank_removed', 'set_aside'].forEach(function (reason) {
        [null, '2026-10-18'].forEach(function (gone) {
          [42.5, 0, -42.5, 99].forEach(function (amt) {
            var l = line({ account_id: 'chk', amount: amt, date: '2026-09-10' });
            var wider = F.asTours([{ id: 't1', doc: tourDoc({ shows: { a: { date: '2026-09-01' }, b: { date: '2026-10-20' } } }) }]);
            var r = run([l], { known: new Map([[l.transaction_id, knownRow({ status: st, reason: reason, gone_on: gone, date: '2026-09-10' })]]), tours: wider, fromStart: true, hold: true });
            eq(r.sorted.items.length, 0, 'no new row'); eq(r.sorted.toFile.size, 0, 'nothing files');
            r.sorted.changes.forEach(function (c) {
              kinds[c.kind] = true;
              has(['gone', 'alive', 'amount', 'relabel', 'resort'], c.kind, 'kind of change');
              // only a left-out row is ever moved, and only to waiting
              if (c.kind === 'relabel' || c.kind === 'resort' || (c.kind === 'alive' && c.open)) eq(st, 'left_out', c.kind + ' on a ' + st + ' row');
            });
          });
        });
      });
    });
    ok(kinds.alive && kinds.amount && kinds.relabel && kinds.resort, 'the set reaches every kind');
  });

  /* ============================== (k) A line the rules cannot place: its name carries no long number ============================== */

  test('the row stored when a rule throws has every long number taken out of its name', function () {
    var broken = [{ id: 'bad', doc: null, win: { from: '2026-10-01', to: '2026-10-20' } }];
    var a = line({ account_id: 'chk', amount: 50, name: 'ACH DEBIT 000123456789 SOMEONE 4411', merchant_name: null, personal_finance_category: SERVICES });
    var b = line({ account_id: 'card', amount: 12, name: 'SQ *COFFEE 9988776655', merchant_name: 'Coffee 123456 Bar' });
    var c = line({ account_id: 'chk', amount: 9, name: '000123456789', merchant_name: null, personal_finance_category: SERVICES });
    var r = run([a, b, c], { tours: broken });
    [a, b, c].forEach(function (l) {
      var row = r.row(l.transaction_id);
      eq(row.why, 'Could not read this line', 'why'); eq(row.status, 'waiting', 'status');
      ok(!/\d{6,}/.test(row.merchant), 'the name still carries a long number: "' + row.merchant + '"');
      ok(row.merchant.length > 0, 'it has a name');
    });
    eq(r.row(a.transaction_id).merchant, 'ACH DEBIT SOMEONE 4411', 'short numbers and the words stay');
    eq(r.row(c.transaction_id).merchant, 'Unknown', 'nothing left is "Unknown"');
  });

  /* ============================== (l) Account names; the file itself ============================== */

  test('cleanName: the two characters a paste once put in place of each middle dot are read as the dot', function () {
    eq(F.cleanName('Gold Card \u00ac\u2211\u00ac\u22111111'), 'Gold Card ··1111', 'the wrong characters');
    eq(F.cleanName('Gold Card ··1111'), 'Gold Card ··1111', 'a name that is right is left alone');
    eq(F.cleanName('Checking'), 'Checking', 'no dots at all');
    eq(F.cleanName(null), '', 'nothing'); eq(F.cleanName(undefined), '', 'nothing at all');
    eq(F.cleanName(F.cleanName('A \u00ac\u2211\u00ac\u22112222')), 'A ··2222', 'twice is the same as once');
  });
  test('a row, a charge and the words on a line carry the account’s name as it should read', function () {
    var acc = accounts();
    acc.card.name = 'Gold Card \u00ac\u2211\u00ac\u22111111';
    acc.chk.name = 'Checking \u00ac\u2211\u00ac\u22111234';
    acc.sav.name = 'Savings \u00ac\u2211\u00ac\u22119999';
    var a = line(), b = line({ account_id: 'chk' }), c = line({ account_id: 'sav' });
    var out = line({ account_id: 'chkLog', amount: 300, name: 'CAPITAL ONE', merchant_name: 'Capital One', personal_finance_category: SERVICES });
    var inn = line({ account_id: 'card', amount: -300, name: 'PAYMENT RECEIVED', merchant_name: null, personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') });
    var r = run([a, b, c, out, inn], { accounts: acc });
    eq(r.row(a.transaction_id).account, 'Gold Card ··1111', 'the row');
    eq(r.sorted.toFile.get('t1').charges['p' + a.transaction_id].account, 'Gold Card ··1111', 'the charge');
    eq(r.row(b.transaction_id).why, 'From Checking ··1234', 'the words on a line');
    eq(r.row(out.transaction_id).why, 'May be a payment to Gold Card ··1111', 'the other half');
    eq(r.led.not_kept.off['Savings ··9999'], 1, 'the switched-off account’s name in the ledger');
  });
  test('the function’s file is plain ASCII: it is pasted by hand, and a clipboard must have nothing to get wrong', function () {
    var high = globalThis.FEED_INDEX_HIGH_BYTES;
    ok(Array.isArray(high), 'the runner did not look at the file’s bytes');
    ok(globalThis.FEED_INDEX_LENGTH > 50000, 'the runner did not read the whole file');
    eq(high.length ? 'a byte above 0x7F on line ' + high.slice(0, 12).join(', ') : '', '', 'supabase/functions/plaid/index.ts');
  });

  /* ============================== (m) What the server asks itself between reads ============================== */

  function readRow(o) { return Object.assign({ id: 1, item: 'bankA', at: '2026-10-20T10:00:00.000Z', from_start: true, status: 'ok', rules: F.RULES }, o || {}); }
  var CLOCK = Date.parse('2026-10-22T12:00:00.000Z');
  test('which banks are owed a read from the start: never had one, a week old, older rules, or a note left since', function () {
    eq(JSON.stringify(F.owedFullReads([], ['bankA', 'bankB'], CLOCK)), '{"bankA":"check","bankB":"check"}', 'no reads on record');
    eq(JSON.stringify(F.owedFullReads([readRow()], ['bankA'], CLOCK)), '{}', 'a full read two days ago');
    eq(JSON.stringify(F.owedFullReads([readRow({ status: 'more' })], ['bankA'], CLOCK)), '{}', 'one that ran out of pages counts as done');
    eq(JSON.stringify(F.owedFullReads([readRow({ at: '2026-10-14T10:00:00.000Z' })], ['bankA'], CLOCK)), '{"bankA":"check"}', 'eight days ago');
    eq(JSON.stringify(F.owedFullReads([readRow({ rules: F.RULES - 1 })], ['bankA'], CLOCK)), '{"bankA":"check"}', 'under older rules');
    ['save_failed', 'lines_missing', 'ITEM_LOGIN_REQUIRED'].forEach(function (st) {
      eq(JSON.stringify(F.owedFullReads([readRow({ status: st })], ['bankA'], CLOCK)), '{"bankA":"check"}', 'a full read that ended ' + st);
    });
    eq(JSON.stringify(F.owedFullReads([readRow({ from_start: false })], ['bankA'], CLOCK)), '{"bankA":"check"}', 'an ordinary read is not a full one');
    eq(JSON.stringify(F.owedFullReads([readRow()], ['bankB'], CLOCK)), '{"bankB":"check"}', 'another bank’s read does not count');
    // a note
    var note = function (o) { return readRow(Object.assign({ id: 2, from_start: false, status: 'asked', at: '2026-10-20T10:05:00.000Z' }, o || {})); };
    eq(JSON.stringify(F.owedFullReads([readRow(), note()], ['bankA'], CLOCK)), '{"bankA":"rescan"}', 'a note after the last full read');
    eq(JSON.stringify(F.owedFullReads([note(), readRow({ id: 3, at: '2026-10-20T10:06:00.000Z' })], ['bankA'], CLOCK)), '{}', 'a full read that started after the note answers it');
    eq(JSON.stringify(F.owedFullReads([note(), readRow({ id: 3, at: '2026-10-20T10:06:00.000Z', status: 'save_failed' })], ['bankA'], CLOCK)), '{"bankA":"rescan"}', 'a full read that failed does not');
    eq(JSON.stringify(F.owedFullReads([readRow(), note({ item: 'bankB' })], ['bankA', 'bankB'], CLOCK)), '{"bankB":"rescan"}', 'a note is for its own bank');
  });
  test('a note written while a full read was under way is newer than that read, whichever row was written last', function () {
    // the read started at 10:00 and its row was written at 10:02 (a later id); the note was written at 10:01
    var read = readRow({ id: 9, at: '2026-10-20T10:00:00.000Z' });
    var note = readRow({ id: 8, from_start: false, status: 'asked', at: '2026-10-20T10:01:00.000Z' });
    eq(JSON.stringify(F.owedFullReads([read, note], ['bankA'], CLOCK)), '{"bankA":"rescan"}', 'the read began before the dates were saved');
    eq(JSON.stringify(F.owedFullReads([note, read], ['bankA'], CLOCK)), '{"bankA":"rescan"}', 'in any order');
    // the same millisecond: the row written later is the later one
    var same = '2026-10-20T10:00:00.000Z';
    eq(JSON.stringify(F.owedFullReads([readRow({ id: 5, at: same }), readRow({ id: 6, from_start: false, status: 'asked', at: same })], ['bankA'], CLOCK)), '{"bankA":"rescan"}', 'note written after');
    eq(JSON.stringify(F.owedFullReads([readRow({ id: 7, at: same }), readRow({ id: 6, from_start: false, status: 'asked', at: same })], ['bankA'], CLOCK)), '{}', 'read written after');
  });
  test('a read from the start is told what the bank took back since the saved place', function () {
    var got = { added: [{ transaction_id: 'X2' }, { transaction_id: 'K' }], modified: [{ transaction_id: 'M' }], removed: [{ transaction_id: 'R0' }] };
    var n3 = F.carryRemoved(got, [{ transaction_id: 'X' }, { transaction_id: 'K' }, { transaction_id: 'M' }, { transaction_id: 'R0' }, { transaction_id: 'X' }, { transaction_id: null }, null]);
    eq(n3, 1, 'how many were carried over');
    eq(JSON.stringify(got.removed.map(function (r) { return r.transaction_id; })), '["R0","X"]', 'only the one the full list does not hold, once');
    // through the sorter: the withdrawn line leaves the pile, its replacement waits, and nothing else moves
    var x2 = line({ account_id: 'chk', transaction_id: 'X2-new' }), keep = line({ account_id: 'chk', transaction_id: 'K-kept' });
    var full = { added: [x2, keep], modified: [], removed: [] };
    F.carryRemoved(full, [{ transaction_id: 'X-old' }, { transaction_id: 'K-kept' }]);
    var known = new Map([['X-old', knownRow()], ['K-kept', knownRow()]]);
    var r = run(full.added, { removed: full.removed, known: known, fromStart: true, hold: true });
    eq(JSON.stringify(r.sorted.changes), JSON.stringify([{ id: 'X-old', kind: 'gone', status: 'waiting', reason: null }]), 'the withdrawn line is marked gone');
    eq(r.row('X2-new').status, 'waiting', 'its replacement waits'); eq(r.fate('K-kept'), 'already', 'a line still alive is left alone');
    eq(r.led.unexplained, 0, 'unexplained'); eq(r.led.bank_sent, 2, 'a removal is not a line the bank sent');
    eq(F.carryRemoved({ added: [] }, [{ transaction_id: 'A' }]), 1, 'an answer with no removed list gets one');
  });
  test('switching an account back on, or marking it for income, asks for a read of its bank from the start', function () {
    var was = { a: { mode: 'off', item: 'bankA', income: [] }, b: { mode: 'ask', item: 'bankB', income: ['merch'] }, c: { mode: 'log', item: 'bankC', income: [] }, d: { mode: 'off', income: [] } };
    function next(o) { var n = JSON.parse(JSON.stringify(was)); Object.keys(o).forEach(function (k) { Object.assign(n[k], o[k]); }); return n; }
    eq(JSON.stringify(F.reopenedBanks(was, next({}))), '[]', 'nothing changed');
    eq(JSON.stringify(F.reopenedBanks(was, next({ a: { mode: 'ask' } }))), '["bankA"]', 'off to Ask me');
    eq(JSON.stringify(F.reopenedBanks(was, next({ a: { mode: 'log' } }))), '["bankA"]', 'off to Log');
    eq(JSON.stringify(F.reopenedBanks(was, next({ b: { mode: 'log' }, c: { mode: 'ask' } }))), '[]', 'between Ask me and Log: its lines were stored all along');
    eq(JSON.stringify(F.reopenedBanks(was, next({ c: { mode: 'off' } }))), '[]', 'switched off');
    eq(JSON.stringify(F.reopenedBanks(was, next({ b: { income: ['merch', 'guarantees'] } }))), '["bankB"]', 'a kind of income added');
    eq(JSON.stringify(F.reopenedBanks(was, next({ c: { income: ['merch'] } }))), '["bankC"]', 'marked for income for the first time');
    eq(JSON.stringify(F.reopenedBanks(was, next({ b: { income: [] } }))), '[]', 'a kind of income taken away');
    eq(JSON.stringify(F.reopenedBanks(was, next({ a: { mode: 'ask' }, c: { income: ['merch'] } }))), '["bankA","bankC"]', 'two banks');
    eq(JSON.stringify(F.reopenedBanks(was, next({ d: { mode: 'ask' } }))), '[""]', 'an account that does not say its bank: every bank');
    eq(JSON.stringify(F.reopenedBanks(was, Object.assign(next({}), { fresh: { mode: 'ask', item: 'bankZ', income: [] } }))), '[]', 'a new account was never switched off');
    eq(JSON.stringify(F.reopenedBanks(null, next({}))), '[]', 'no accounts before');
  });
  test('which bank lines already have their charge on a tour (before a filed row is put back to waiting)', function () {
    var held = F.chargesHeld([{ id: 't1', doc: { charges: { pA1: { amount: 5 }, c9: { amount: 1 }, pNull: null, pText: 'x' } } },
      { id: 'gone', doc: { deletedAt: 5, charges: { pB2: { amount: 7 } } } }, { id: 'odd', doc: null }, { id: 'odd2', doc: { charges: 'none' } }, null]);
    eq(JSON.stringify(Array.from(held).sort()), '["A1","B2"]', 'on any tour, a taken-down one included; nothing else');
    eq(F.chargesHeld(null).size, 0, 'no tours');
  });
  test('the tripwire looks at the database: which of the rows a run meant to store are not there', function () {
    eq(JSON.stringify(F.notThere(['a', 'b', 'c'], [{ id: 'a' }, { id: 'c' }, { id: 'z' }])), '["b"]', 'one is missing');
    eq(F.notThere(['a', 'b'], [{ id: 'b' }, { id: 'a' }]).length, 0, 'all there');
    eq(F.notThere(['a', 'b'], []).length, 2, 'none there');
    eq(F.notThere(['a', 'b'], null).length, 2, 'a read that gave nothing back holds none of them');
    eq(F.notThere(['a', 'b'], undefined).length, 2, 'nor one that gave no list at all');
    eq(F.notThere(['a'], [null, {}, { id: null }]).length, 1, 'rows with no id hold nothing');
    eq(F.notThere(['7'], [{ id: 7 }]).length, 0, 'an id is an id, as text or as a number');
    eq(F.notThere([], [{ id: 'a' }]).length, 0, 'nothing was asked for');
  });
  test('a page of a bank’s answer that does not say where the next one starts could not be read', function () {
    eq(F.pagePlace({ added: [], next_cursor: 'abc', has_more: false }), 'abc', 'a real page');
    eq(F.pagePlace({ added: [], next_cursor: '', has_more: false }), '', 'a bank with nothing yet says so with an empty place');
    eq(F.pagePlace({}), null, 'an answer that arrived empty');
    eq(F.pagePlace({ added: [{ transaction_id: 'x' }], has_more: false }), null, 'lines, but no place');
    eq(F.pagePlace({ next_cursor: null }), null, 'no place'); eq(F.pagePlace({ next_cursor: 12 }), null, 'a place that is not text');
    eq(F.pagePlace(null), null, 'nothing'); eq(F.pagePlace(undefined), null, 'nothing at all');
  });
  test('a long list is read to its end: a page shorter than asked for is not the end, an empty page is', function () {
    eq(F.nextPage(0, 1000), 1000, 'a full page');
    eq(F.nextPage(0, 300), 300, 'a short page: the next one starts where it ended');
    eq(F.nextPage(300, 300), 600, 'and again'); eq(F.nextPage(600, 1), 601, 'one row');
    eq(F.nextPage(601, 0), -1, 'an empty page ends the list'); eq(F.nextPage(0, 0), -1, 'an empty list');
    // a list of 2,350 rows that comes 300 at a time: every row is reached, once
    var seen = 0, from = 0, turns = 0;
    while (from >= 0 && turns < 50) { var got = Math.min(300, Math.max(0, 2350 - from)); seen += got; from = F.nextPage(from, got); turns += 1; }
    eq(seen, 2350, 'every row'); eq(turns, 9, 'eight pages of rows, then the empty one');
  });
  test('whose rows a tour’s pile shows: the owner sees a taken-down tour’s rows as no-tour rows, a Manager who is not the owner does not', function () {
    var live = new Set(['t1', 't2']);
    [true, false].forEach(function (mine) {
      eq(F.pilePlace('t1', 't1', live, mine), 'here', 'this tour');
      eq(F.pilePlace('', 't1', live, mine), 'none', 'no tour');
      eq(F.pilePlace('t2', 't1', live, mine), '', 'another tour of the owner’s is never shown');
      eq(F.pilePlace('t9', 't9', live, mine), 'here', 'this tour, whatever the list of tours says');
    });
    eq(F.pilePlace('tgone', 't1', live, true), 'none', 'owner: a tour that is taken down');
    eq(F.pilePlace('never-existed', 't1', live, true), 'none', 'owner: a tour that is gone');
    eq(F.pilePlace('tgone', 't1', live, false), '', 'Manager: a taken-down tour’s row is not theirs to see');
    eq(F.pilePlace('never-existed', 't1', live, false), '', 'Manager: nor one whose tour is gone');
  });
  test('what a Manager who is not the owner is told after a read: how it went and what it found, not the owner’s whole count', function () {
    var ans = { ok: true, status: 'ok', filed: 1, waiting: 2, found: { zelle: 1 }, catchup: false, ledger: { sent: 412, already: 409 }, nowInside: 3 };
    var m = F.forManager(ans);
    eq(JSON.stringify(Object.keys(m).sort()), '["catchup","filed","found","ok","status","waiting"]', 'what is left');
    ok(ans.ledger && ans.nowInside === 3, 'the answer it was made from is not changed');
    eq(JSON.stringify(F.forManager({ ok: false, status: 'save_failed' })), '{"ok":false,"status":"save_failed"}', 'a read that failed');
    eq(JSON.stringify(F.forManager({ ok: true, status: 'recent' })), '{"ok":true,"status":"recent"}', 'nothing to take out');
  });

  /* ============================== (n) The app can never move money ============================== */

  test('the requests this file may make of Plaid are the same read-only ones, and nothing else reaches a network', function () {
    var whole = String(globalThis.FEED_INDEX_TEXT || '');
    ok(whole.length > 50000, 'the runner did not hand over the file');
    // (comments taken out, as for the pure block)
    var text = whole.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\"'])\/\/.*$/gm, '$1');
    var READ_ONLY = ['/accounts/get', '/item/get', '/item/public_token/exchange', '/item/remove', '/link/token/create', '/link/token/get',
      '/sandbox/public_token/create', '/transactions/refresh', '/transactions/sync'];
    var list = /const ALLOWED = new Set\(\[([\s\S]*?)\]\);/.exec(text);
    ok(list, 'the list ALLOWED was not found');
    var allowed = (list[1].match(/"[^"]*"/g) || []).map(function (s) { return s.slice(1, -1); }).sort();
    eq(JSON.stringify(allowed), JSON.stringify(READ_ONLY), 'ALLOWED');
    ok(/if \(!ALLOWED\.has\(path\)\) throw new PlaidError\("not_allowed"\);/.test(text), 'plaidCall no longer refuses a path that is not on the list');
    // every request is plaidCall with its path written out in full, and that path is on the list
    var calls = (text.match(/plaidCall\([^,)]*/g) || []).filter(function (c) { return c !== 'plaidCall(path: string'; });
    ok(calls.length >= 9, 'the requests were not found (' + calls.length + ')');
    calls.forEach(function (c) {
      var m = /^plaidCall\("([^"]+)"$/.exec(c);
      ok(m, 'a request whose path is not written out in full: ' + c);
      has(READ_ONLY, m[1], 'a request for');
    });
    // nothing in the file that looks like a Plaid path is off the list
    (text.match(/"\/[a-z_]+(?:\/[a-z_]+)+"/g) || []).forEach(function (s) { has(READ_ONLY, s.slice(1, -1), 'a path in the file'); });
    eq((text.match(/\bfetch\(/g) || []).length, 1, 'places that reach a network');
  });

  globalThis.GR_FEED_TESTS = { results: results };
})();
