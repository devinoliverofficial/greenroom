/* Greenroom statement tests. Runs in any browser via tests/index.html. */
(function () {
  'use strict';

  var S = globalThis.GRS;
  var results = [];

  function test(name, fn) {
    try { fn(); results.push({ name: name, ok: true }); }
    catch (e) { results.push({ name: name, ok: false, msg: e && e.message || String(e) }); }
  }
  function eq(actual, expected, what) {
    if (actual !== expected) {
      throw new Error((what || 'value') + ': expected ' + JSON.stringify(expected) +
        ', got ' + JSON.stringify(actual));
    }
  }
  function deq(actual, expected, what) {
    var a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error((what || 'value') + ': expected ' + b + ', got ' + a);
  }

  var NOW = new Date(2026, 8, 24).getTime();

  /* ============ Fixture A: charges as negative numbers ============ */

  var CSV_NEGATIVE = [
    'Transaction Date,Description,Amount',
    '09/08/2026,"PILOT TRAVEL CTR #482 TOLEDO OH",-142.55',
    '09/09/2026,"TST* THE BLIND PIG",-63.20',
    '09/10/2026,"HAMPTON INN CLEVELAND OH",-214.00',
    '09/11/2026,"PAYMENT THANK YOU",1500.00',
    '09/12/2026,"SQ *COFFEE HOUSE CHICAGO IL",-6.75'
  ].join('\n');

  test('CSV with negative charges: reads five rows and keeps the four charges', function () {
    var r = S.parseStatementCSV(CSV_NEGATIVE, { now: NOW });
    eq(r.ok, true, 'ok');
    eq(r.charges.length, 4, 'charges');
    eq(r.skipped, 1, 'skipped');
    eq(r.sign, -1, 'charge sign');
  });

  test('CSV with negative charges: amounts come through positive', function () {
    var r = S.parseStatementCSV(CSV_NEGATIVE, { now: NOW });
    deq(r.charges.map(function (c) { return c.amount; }), [142.55, 63.2, 214, 6.75], 'amounts');
  });

  test('CSV with negative charges: the payment is skipped, not imported', function () {
    var r = S.parseStatementCSV(CSV_NEGATIVE, { now: NOW });
    var any = r.charges.some(function (c) { return /payment/i.test(c.description); });
    eq(any, false, 'payment present');
  });

  /* ============ Fixture B: charges as positive numbers ============ */

  var CSV_POSITIVE = [
    'Date,Merchant,Amount',
    '2026-09-08,PILOT TRAVEL CTR #482,142.55',
    '2026-09-09,LOVES TRAVEL STOP 331,88.10',
    '2026-09-10,DELTA AIR LINES,412.30',
    '2026-09-11,REFUND - GUITAR CENTER,-99.00'
  ].join('\n');

  test('CSV with positive charges: the majority sign decides, refund dropped', function () {
    var r = S.parseStatementCSV(CSV_POSITIVE, { now: NOW });
    eq(r.ok, true, 'ok');
    eq(r.sign, 1, 'charge sign');
    eq(r.charges.length, 3, 'charges');
    eq(r.skipped, 1, 'skipped');
  });

  /* ============ Fixture C: separate debit and credit columns ============ */

  var CSV_COLUMNS = [
    'Posting Date,Details,Debit,Credit',
    '09/08/2026,SHELL OIL 574123,64.20,',
    '09/09/2026,HOLIDAY INN EXPRESS,189.00,',
    '09/10/2026,ONLINE PAYMENT,,900.00',
    '09/11/2026,U-HAUL MOVING,77.45,'
  ].join('\n');

  test('CSV with debit/credit columns: debits are charges, credits are not', function () {
    var r = S.parseStatementCSV(CSV_COLUMNS, { now: NOW });
    eq(r.ok, true, 'ok');
    eq(r.charges.length, 3, 'charges');
    eq(r.skipped, 1, 'skipped');
    deq(r.charges.map(function (c) { return c.amount; }), [64.2, 189, 77.45], 'amounts');
  });

  /* ============ Headers, delimiters and odd files ============ */

  test('a semicolon file is read as well as a comma one', function () {
    var csv = 'Date;Description;Amount\n09/08/2026;PILOT 482;-20.00\n09/09/2026;SHELL;-30.00';
    var r = S.parseStatementCSV(csv, { now: NOW });
    eq(r.ok, true, 'ok');
    eq(r.charges.length, 2, 'charges');
  });

  test('preamble lines above the header are skipped', function () {
    var csv = ['Account 1234', 'Statement period 09/01 - 09/30', '',
      'Date,Description,Amount', '09/08/2026,PILOT 482,-20.00'].join('\n');
    var r = S.parseStatementCSV(csv, { now: NOW });
    eq(r.ok, true, 'ok');
    eq(r.charges.length, 1, 'charges');
  });

  test('a file with no header is read from the shape of the cells', function () {
    var csv = ['09/08/2026,PILOT TRAVEL 482,-20.00', '09/09/2026,SHELL OIL,-30.00',
      '09/10/2026,LOVES TRAVEL,-40.00'].join('\n');
    var r = S.parseStatementCSV(csv, { now: NOW });
    eq(r.ok, true, 'ok');
    eq(r.charges.length, 3, 'charges');
    eq(r.charges[0].merchant.indexOf('Pilot') >= 0, true, 'merchant read');
  });

  test('quoted fields containing commas stay in one piece', function () {
    var rows = S.parseCSV('a,"b,c",d');
    deq(rows[0], ['a', 'b,c', 'd'], 'row');
  });

  test('a file that is not a statement is refused rather than guessed at', function () {
    var r = S.parseStatementCSV('hello world\nthis is not a statement', { now: NOW });
    eq(r.ok, false, 'ok');
  });

  test('a statement of nothing but payments says so', function () {
    var csv = 'Date,Description,Amount\n09/08/2026,PAYMENT THANK YOU,500.00';
    var r = S.parseStatementCSV(csv, { now: NOW });
    eq(r.ok, false, 'ok');
    eq(r.reason, 'all-credits', 'reason');
  });

  /* ============ Amounts and dates ============ */

  test('amounts survive currency symbols, commas and parentheses', function () {
    eq(S.parseAmount('$1,234.56'), 1234.56, 'dollars');
    eq(S.parseAmount('(123.45)'), -123.45, 'parens are negative');
    eq(S.parseAmount('-45'), -45, 'minus');
    eq(S.parseAmount('1.234,56'), 1234.56, 'european');
    eq(S.parseAmount(''), null, 'blank');
    eq(S.parseAmount('abc'), null, 'text');
  });

  test('dates are read month-first, the way US statements write them', function () {
    eq(S.parseDate('09/08/2026', NOW), '2026-09-08', 'slashes');
    eq(S.parseDate('9/8/26', NOW), '2026-09-08', 'short year');
    eq(S.parseDate('2026-09-08', NOW), '2026-09-08', 'iso');
    eq(S.parseDate('Sep 8, 2026', NOW), '2026-09-08', 'month name');
    eq(S.parseDate('8 Sep 2026', NOW), '2026-09-08', 'day first with month name');
    eq(S.parseDate('09/08', NOW), '2026-09-08', 'no year falls back to this year');
    eq(S.parseDate('02/30/2026', NOW), null, 'impossible date');
  });

  /* ============ Merchant cleanup ============ */

  test('processor prefixes, store numbers and locations come off the name', function () {
    eq(S.cleanMerchant('SQ *COFFEE HOUSE CHICAGO IL'), 'Coffee House Chicago', 'square');
    eq(S.cleanMerchant('TST* THE BLIND PIG'), 'The Blind Pig', 'toast');
    eq(S.cleanMerchant('PILOT TRAVEL CTR #482'), 'Pilot Travel Ctr', 'store number');
    eq(S.cleanMerchant('SHELL OIL 574123'), 'Shell Oil', 'trailing digits');
  });

  test('merchants normalize to the same key despite punctuation and case', function () {
    eq(S.normMerchant('Pilot Travel Ctr'), 'pilot travel ctr', 'plain');
    eq(S.normMerchant("LOVE'S  TRAVEL-STOP"), 'love s travel stop', 'punctuation');
  });

  /* ============ Dedupe ============ */

  test('a statement uploaded twice is caught the second time', function () {
    var first = [{ date: '2026-09-08', merchant: 'Pilot', amount: 142.55 }];
    var incoming = [{ date: '2026-09-08', merchant: 'PILOT', amount: 142.55 }];
    var out = S.markDuplicates(incoming, first);
    eq(out[0].duplicate, true, 'duplicate');
  });

  test('two identical coffees on the same day are both real', function () {
    var incoming = [
      { date: '2026-09-08', merchant: 'Coffee House', amount: 6.75 },
      { date: '2026-09-08', merchant: 'Coffee House', amount: 6.75 }
    ];
    var out = S.markDuplicates(incoming, []);
    eq(out[0].duplicate, false, 'first');
    eq(out[1].duplicate, false, 'second');
  });

  test('when one of a pair was already imported, only one is flagged', function () {
    var existing = [{ date: '2026-09-08', merchant: 'Coffee House', amount: 6.75 }];
    var incoming = [
      { date: '2026-09-08', merchant: 'Coffee House', amount: 6.75 },
      { date: '2026-09-08', merchant: 'Coffee House', amount: 6.75 }
    ];
    var out = S.markDuplicates(incoming, existing);
    eq(out[0].duplicate, true, 'first');
    eq(out[1].duplicate, false, 'second');
  });

  test('a different day or a different amount is not a duplicate', function () {
    var existing = [{ date: '2026-09-08', merchant: 'Pilot', amount: 142.55 }];
    eq(S.markDuplicates([{ date: '2026-09-09', merchant: 'Pilot', amount: 142.55 }], existing)[0].duplicate,
      false, 'other day');
    eq(S.markDuplicates([{ date: '2026-09-08', merchant: 'Pilot', amount: 142.56 }], existing)[0].duplicate,
      false, 'other amount');
  });

  /* ============ Label learning ============ */

  test('a merchant labelled once is filled in next time', function () {
    var labels = S.learnLabel({}, 'Pilot', 'gas');
    eq(S.learnedCategory(labels, 'Pilot'), 'gas', 'learned');
    eq(S.learnedCategory(labels, 'PILOT'), 'gas', 'case does not matter');
  });

  test('a merchant labelled two different ways is left blank', function () {
    var labels = S.learnLabel(S.learnLabel({}, 'Pilot', 'gas'), 'Pilot', 'dayByDay');
    eq(S.learnedCategory(labels, 'Pilot'), null, 'ambiguous');
  });

  test('labelling the same way twice is still one category', function () {
    var labels = S.learnLabel(S.learnLabel({}, 'Pilot', 'gas'), 'Pilot', 'gas');
    eq(S.learnedCategory(labels, 'Pilot'), 'gas', 'still gas');
  });

  test('an unknown merchant has no learned category', function () {
    eq(S.learnedCategory({}, 'Brand New Diner'), null, 'unknown');
  });

  test('a removed label stops filling itself in', function () {
    var labels = S.learnLabel({}, 'Pilot', 'gas');
    S.forgetLabel(labels, 'Pilot');
    eq(S.learnedCategory(labels, 'Pilot'), null, 'forgotten');
  });

  test('learned beats suggested; a no-brainer fills in when nothing is learned', function () {
    var labels = S.learnLabel({}, 'Delta Air Lines', 'dayByDay');
    var out = S.applyLabels([
      { merchant: 'Delta Air Lines', suggested: 'flights' },
      { merchant: 'Hampton Inn', suggested: 'hotels' },
      { merchant: 'Some Diner' }
    ], labels);
    eq(out[0].category, 'dayByDay', 'learned wins');
    eq(out[0].source, 'learned', 'learned source');
    eq(out[1].category, 'hotels', 'suggested used');
    eq(out[1].source, 'suggested', 'suggested source');
    eq(out[2].category, null, 'unknown stays blank');
  });

  test('an ambiguous merchant is left blank even with a suggestion', function () {
    var labels = S.learnLabel(S.learnLabel({}, 'Pilot', 'gas'), 'Pilot', 'dayByDay');
    var out = S.applyLabels([{ merchant: 'Pilot' }], labels);
    eq(out[0].category, null, 'blank');
  });

  /* ============ Review grouping ============ */

  test('the review splits into needs a label, filled in, and already imported', function () {
    var g = S.groupForReview([
      { merchant: 'A', category: null },
      { merchant: 'B', category: 'gas', source: 'learned' },
      { merchant: 'C', category: 'hotels', source: 'suggested' },
      { merchant: 'D', category: 'gas', duplicate: true }
    ]);
    eq(g.needs.length, 1, 'needs');
    eq(g.filled.length, 2, 'filled');
    eq(g.already.length, 1, 'already');
    eq(g.before.length, 0, 'before');
  });

  test('charges from before the cutoff are set aside, not counted', function () {
    var marked = S.markPreCutoff([
      { merchant: 'Pilot', date: '2026-05-08', amount: 60 },
      { merchant: 'Shell', date: '2026-05-10', amount: 40 },
      { merchant: 'Loves', date: '2026-05-11', amount: 80 }
    ], '2026-05-10');
    eq(marked[0].preCutoff, true, 'before the cutoff');
    eq(marked[1].preCutoff, true, 'on the cutoff day counts as before');
    eq(marked[2].preCutoff, false, 'after the cutoff');
    var g = S.groupForReview(marked);
    eq(g.before.length, 2, 'set aside');
    eq(g.needs.length, 1, 'only the real one needs a label');
  });

  test('no cutoff means nothing is set aside', function () {
    var marked = S.markPreCutoff([{ merchant: 'Pilot', date: '2026-05-08', amount: 60 }], null);
    eq(marked[0].preCutoff, false, 'untouched');
  });

  test('a duplicate from before the cutoff reads as already imported first', function () {
    var g = S.groupForReview([{ merchant: 'Pilot', date: '2026-05-08', duplicate: true, preCutoff: true }]);
    eq(g.already.length, 1, 'already wins');
    eq(g.before.length, 0, 'not double-listed');
  });

  globalThis.GR_STATEMENT_TESTS = { results: results };
})();
