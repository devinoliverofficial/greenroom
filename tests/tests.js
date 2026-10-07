/* Greenroom unit tests. Runs in any browser via tests/index.html. */
(function () {
  'use strict';

  var G = globalThis.GR;
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
  function near(actual, expected, what) {
    if (Math.abs(actual - expected) > 0.005) {
      throw new Error((what || 'value') + ': expected ~' + expected + ', got ' + actual);
    }
  }

  function keyed(list) {
    var o = {}; list.forEach(function (r, i) { o['r' + i] = r; }); return o;
  }

  /* ============ Acceptance test 1: commission, debt, day by day ============ */

  function tourOne() {
    return {
      name: 'Acceptance one',
      expenses: {
        bus: { projected: 18000, paid: 0 },
        gas: { projected: 4000, paid: 0 },
        hotels: { projected: 6000, paid: 0 },
        flights: { projected: 2500, paid: 0 },
        production: { projected: 3500, paid: 0 },
        misc: { projected: 1000, paid: 0 }
      },
      // Crew's projection is the sum of what the crew is owed: 12,000.
      crew: keyed([
        { name: 'Sam', title: 'Tour manager', pay: 7000 },
        { name: 'Alex', title: 'FOH engineer', pay: 5000 }
      ]),
      commission: {
        management: { mode: 'pct', value: 15 },
        agent: { mode: 'pct', value: 10 },
        lawyer: { mode: 'flat', value: 1500 }
      },
      debts: keyed([{ label: 'Credit card', amount: 5000 }]),
      extras: keyed([{ date: '2026-03-02', label: 'Parking', amount: 85, createdAt: 2 }]),
      shows: keyed([
        { date: '2026-03-01', city: 'Detroit, MI', loggedAt: 1,
          income: { guarantee: 7500, merch: 4200, vip: 1800, buyouts: 0, catering: 0, misc: 0 } },
        { date: '2026-03-02', city: 'Chicago, IL', loggedAt: 2,
          income: { guarantee: 60000, merch: 0, vip: 0, buyouts: 0, catering: 0, misc: 0 } }
      ])
    };
  }

  test('acceptance 1 — income is $73,500', function () {
    eq(G.calc(tourOne()).income, 73500, 'income');
  });

  test('acceptance 1 — crew projection is the sum of crew pay', function () {
    eq(G.crewProjection(tourOne()), 12000, 'crew');
  });

  test('acceptance 1 — commission totals $19,275', function () {
    var c = G.calc(tourOne());
    // management 15% of 73,500 = 11,025; agent 10% of 67,500 guarantees = 6,750; lawyer 1,500 flat
    near(c.commission, 19275, 'commission');
  });

  test('acceptance 1 — booking agent takes guarantees only, not merch or VIPs', function () {
    var t = tourOne();
    var c = G.calc(t);
    eq(c.guarantees, 67500, 'guarantees');
    var agent = G.commissionLine(
      { basis: 'guarantee' }, { mode: 'pct', value: 10 }, c.income, c.guarantees);
    near(agent, 6750, 'agent commission');
  });

  test('acceptance 1 — total out is $71,360', function () {
    near(G.calc(tourOne()).out, 71360, 'out');
  });

  test('acceptance 1 — net is +$2,140', function () {
    near(G.calc(tourOne()).net, 2140, 'net');
  });

  test('acceptance 1 — reads as green', function () {
    var c = G.calc(tourOne());
    eq(G.stateOf(c), 'green', 'state');
    eq(G.caption(c), 'in the green', 'caption');
  });

  /* ============ Acceptance test 2: projected vs paid, one over ============ */

  function tourTwo() {
    return {
      name: 'Acceptance two',
      expenses: {
        // Deposit paid, still under the projection: the projection stands.
        bus: { projected: 10000, paid: 3000 },
        // Projected 2,000 but 2,600 of gas charges landed: over by 600.
        gas: { projected: 2000, paid: 0 },
        // No projection at all: this category is just whatever got charged to it.
        hotels: { projected: null, paid: 0 },
        misc: { projected: null, paid: 0 }
      },
      crew: keyed([{ name: 'Sam', title: 'Tour manager', pay: 5000 }]),
      // Crew fully paid up front: max(5000, 5000) = 5000, counted once.
      commission: {
        management: { mode: 'flat', value: 0 },
        agent: { mode: 'flat', value: 0 },
        lawyer: { mode: 'flat', value: 500 }
      },
      debts: {},
      extras: keyed([{ date: '2026-04-01', label: 'Food', amount: 150, createdAt: 1 }]),
      charges: keyed([
        { date: '2026-04-01', merchant: 'Pilot', amount: 1400, category: 'gas', importId: 'i1' },
        { date: '2026-04-02', merchant: 'Loves', amount: 1200, category: 'gas', importId: 'i1' },
        { date: '2026-04-01', merchant: 'Hampton Inn', amount: 1200, category: 'hotels', importId: 'i1' }
      ]),
      shows: keyed([
        { date: '2026-04-01', city: 'Austin, TX', loggedAt: 1,
          income: { guarantee: 8000, merch: 0, vip: 0, buyouts: 0, catering: 0, misc: 0 } }
      ])
    };
  }

  function lineFor(c, key) {
    return c.lines.filter(function (l) { return l.key === key; })[0];
  }

  test('acceptance 2 — a deposit under the projection does not raise the cost', function () {
    var bus = lineFor(G.calc(tourTwo()), 'bus');
    eq(bus.projected, 10000, 'bus projected');
    eq(bus.paid, 3000, 'bus paid so far');
    eq(bus.effective, 10000, 'bus counted');
    eq(bus.left, 7000, 'bus left to pay');
    eq(bus.over, 0, 'bus over');
  });

  test('acceptance 2 — a category over its projection counts the higher number', function () {
    var gas = lineFor(G.calc(tourTwo()), 'gas');
    eq(gas.projected, 2000, 'gas projected');
    eq(gas.paid, 2600, 'gas paid so far');
    eq(gas.effective, 2600, 'gas counted');
    eq(gas.left, 0, 'gas left to pay');
    eq(gas.over, 600, 'gas over by');
  });

  test('acceptance 2 — a category with no projection just totals its charges', function () {
    var hotels = lineFor(G.calc(tourTwo()), 'hotels');
    eq(hotels.projected, null, 'hotels projected');
    eq(hotels.effective, 1200, 'hotels counted');
    eq(hotels.left, null, 'hotels left to pay');
  });

  test('acceptance 2 — crew paid in full is counted once, not twice', function () {
    var t = tourTwo();
    t.expenses.crew = { projected: null, paid: 5000 };
    var crew = lineFor(G.calc(t), 'crew');
    eq(crew.projected, 5000, 'crew projected from crew list');
    eq(crew.paid, 5000, 'crew paid');
    eq(crew.effective, 5000, 'crew counted');
  });

  test('acceptance 2 — totals', function () {
    var t = tourTwo();
    t.expenses.crew = { projected: null, paid: 5000 };
    var c = G.calc(t);
    // bus 10,000 + crew 5,000 + gas 2,600 + hotels 1,200 + misc 0
    near(c.fixed, 18800, 'fixed');
    near(c.commission, 500, 'commission');
    near(c.dayByDay, 150, 'day by day');
    near(c.out, 19450, 'out');
    eq(c.income, 8000, 'income');
    near(c.net, -11450, 'net');
    eq(G.stateOf(c), 'red', 'state');
    eq(G.caption(c), 'to break even', 'caption');
  });

  /* ============ Merch bill ============ */

  test('the merch bill is an expense category like any other', function () {
    var keys = G.TYPED_CATEGORIES.map(function (c) { return c.key; });
    if (keys.indexOf('merch') < 0) throw new Error('merch missing from categories');
    if (keys.indexOf('commission') >= 0) throw new Error('commission should not be a typed category');
  });

  test('a merch advance counts against the tour until it is paid back', function () {
    var t = {
      expenses: { merch: { projected: 6000, paid: 0 } },
      crew: {}, debts: {}, commission: {}, extras: {},
      shows: keyed([{ date: '2026-09-01', city: 'A', loggedAt: 1,
        income: { guarantee: 4000, merch: 2000 } }])
    };
    var c = G.calc(t);
    var merch = lineFor(c, 'merch');
    eq(merch.projected, 6000, 'projected');
    eq(merch.effective, 6000, 'counted');
    // Merch income does not quietly cancel the merch bill; both show up.
    eq(c.income, 6000, 'income');
    near(c.out, 6000, 'out');
    near(c.net, 0, 'net');
  });

  test('paying the merch bill down leaves the projection standing', function () {
    var t = {
      expenses: { merch: { projected: 6000, paid: 2500 } },
      crew: {}, debts: {}, commission: {}, extras: {}, shows: {}
    };
    var merch = lineFor(G.calc(t), 'merch');
    eq(merch.paid, 2500, 'paid');
    eq(merch.left, 3500, 'left to pay');
    eq(merch.effective, 6000, 'still counts the full bill');
  });

  test('a card charge can be labelled as the merch bill', function () {
    var keys = G.CHARGE_CATEGORIES.map(function (c) { return c.key; });
    if (keys.indexOf('merch') < 0) throw new Error('merch missing from charge categories');
  });

  /* ============ Cards carried into the tour ============ */

  function cardTour() {
    return {
      expenses: {
        bus: { projected: 40000, paid: 0 },      // projection exceeds card spend
        hotels: { projected: 5000, paid: 0 },    // card spend exceeds projection
        gas: { projected: 20000, paid: 0 },
        misc: { projected: null, paid: 0 }
      },
      crew: {}, commission: {}, extras: {}, shows: {}, charges: {},
      debts: keyed([{
        label: 'Amex', amount: 28000, kind: 'card', createdAt: 1,
        breakdown: { bus: 8500, hotels: 6000, gas: 9300 }   // 23,800 of 28,000
      }])
    };
  }

  test('a card balance with a partial breakdown sends the remainder to Misc', function () {
    var c = G.calc(cardTour());
    var misc = lineFor(c, 'misc');
    eq(misc.paid, 4200, 'leftover lands in misc');
    eq(misc.effective, 4200, 'misc counts it');
    eq(misc.cards.length, 1, 'tagged with the card');
    eq(misc.cards[0].label, 'Amex', 'card name');
    eq(misc.cards[0].leftover, true, 'marked as leftover');
  });

  test('a projection bigger than the card spend counts once, not twice', function () {
    var bus = lineFor(G.calc(cardTour()), 'bus');
    eq(bus.projected, 40000, 'projected');
    eq(bus.paid, 8500, 'paid on the card going in');
    eq(bus.left, 31500, 'left to pay');
    eq(bus.effective, 40000, 'counted once, inside the projection');
  });

  test('card spend past the projection raises the category, still counted once', function () {
    var hotels = lineFor(G.calc(cardTour()), 'hotels');
    eq(hotels.projected, 5000, 'projected');
    eq(hotels.paid, 6000, 'paid on the card');
    eq(hotels.over, 1000, 'over by');
    eq(hotels.effective, 6000, 'the higher number wins');
  });

  test('the whole balance is in the total exactly once, and not in the owed pile', function () {
    var c = G.calc(cardTour());
    eq(c.debt, 0, 'cards are not loans');
    // bus 40,000 + hotels 6,000 + gas 20,000 + misc 4,200 = 70,200
    near(c.fixed, 70200, 'total');
    near(c.out, 70200, 'out');
  });

  test('a card with no breakdown is one Misc lump — skipping is free', function () {
    var t = cardTour();
    t.debts.r0.breakdown = {};
    var c = G.calc(t);
    eq(lineFor(c, 'misc').paid, 28000, 'whole balance in misc');
    eq(lineFor(c, 'bus').paid, 0, 'nothing invented elsewhere');
    near(c.out, 40000 + 5000 + 20000 + 28000, 'total still right');
  });

  test('loans and gear payments still work the old way', function () {
    var t = cardTour();
    t.debts.r1 = { label: 'Gear payment', amount: 3000, createdAt: 2 };
    var c = G.calc(t);
    eq(c.debt, 3000, 'in the owed pile');
    near(c.out, 73200, 'added on top');
  });

  test('the cutoff defaults to the first show and takes the latest card', function () {
    var t = cardTour();
    t.shows = keyed([{ date: '2026-05-10', city: 'A' }, { date: '2026-05-12', city: 'B' }]);
    eq(G.preTourCutoff(t), '2026-05-10', 'defaults to tour start');
    t.debts.r0.cutoff = '2026-05-14';
    eq(G.preTourCutoff(t), '2026-05-14', 'an edited cutoff wins');
    t.shows = {};
    t.debts.r0.cutoff = null;
    eq(G.preTourCutoff(t), null, 'no dates, no cutoff');
  });

  test('a card balance the feed read sits under Credit card; its earlier charges move out, never twice', function () {
    var t = {
      expenses: {}, crew: {}, commission: {}, extras: {}, shows: keyed([{ date: '2026-05-10', city: 'A' }]),
      debts: { c1: { label: 'Gold ··1008', amount: 27000, kind: 'card', cutoff: '2026-05-12', breakdown: {},
        feed: { name: 'Gold ··1008' }, createdAt: 1 } },
      charges: {}
    };
    var line = function (k) { return G.calc(t).lines.filter(function (l) { return l.key === k; })[0]; };
    eq(line('card').paid, 27000, 'the whole balance is under Credit card');
    eq(G.calc(t).out, 27000, 'counted once');
    t.charges = {
      a: { date: '2026-05-11', merchant: 'Shell', amount: 200, category: 'gas', account: 'Gold ··1008' },
      b: { date: '2026-05-14', merchant: 'Shell', amount: 50, category: 'gas', account: 'Gold ··1008' },
      c: { date: '2026-05-11', merchant: 'Hotel', amount: 300, category: 'hotels', account: 'Other ··2222' }
    };
    eq(line('gas').paid, 250, 'both gas charges land in Gas');
    eq(line('card').paid, 26800, 'the one inside the balance moved out of Credit card');
    eq(G.calc(t).out, 27000 + 50 + 300, 'the balance once, plus spending after it and on other cards');
    eq(G.preTourCutoff(t), null, 'a read card never hides charges as before the tour');
    t.debts.c1.payments = { p1: { date: '2026-05-20', amount: 10000 } };
    var sm = G.cardSummary(t.debts.c1, t);
    eq(sm.paidOff, 10000, 'payments add up');
    eq(sm.owed, 17000, 'and come off what is still owed');
    eq(G.calc(t).out, 27000 + 50 + 300, 'paying the card never changes what the tour spent');
  });

  test('owed on cards comes from the bank and never changes what the tour spent', function () {
    var t = { shows: {}, expenses: { bus: { projected: 18000, paid: 0 } }, crew: {}, commission: {}, extras: {},
      debts: { c1: { label: 'Amex ··1008', amount: 2000, kind: 'card', cutoff: '2026-05-01', breakdown: {}, feed: { name: 'Amex ··1008' } } },
      charges: { b1: { date: '2026-05-03', merchant: 'Bus Co', amount: 18000, category: 'bus', account: 'Amex ··1008' } } };
    var before = G.calc(t).out;
    eq(before, 18000 + 2000, 'the bus fills its projection; the balance going in counts once');
    t.debts.c1.owedNow = { amount: 20000, at: '2026-05-04T12:00:00Z' };
    eq(G.cardSummary(t.debts.c1, t).owed, 20000, 'the bank says $20,000 is owed');
    eq(G.calc(t).out, before, 'what the tour spent is unchanged');
    t.debts.c1.owedNow = { amount: 5000, at: '2026-05-10T12:00:00Z' };
    eq(G.cardSummary(t.debts.c1, t).owed, 5000, 'after paying the card down');
    eq(G.calc(t).out, before, 'still unchanged');
  });

  test('card charges: within a day, the bank\u2019s own order (the card app\u2019s), not A to Z', function () {
    // As the bank sent them, newest first: Aug 15, then three on Aug 14, then Aug 8.
    var sent = [
      { merchant: 'Storage', date: '2026-08-15', posted: '2026-08-16', seq: 50 },
      { merchant: 'Band van', date: '2026-08-14', posted: '2026-08-14', seq: 51 },
      { merchant: 'Audio', date: '2026-08-14', posted: '2026-08-15', seq: 52 },
      { merchant: 'Shop', date: '2026-08-14', posted: '2026-08-14', seq: 54 },
      { merchant: 'Ride', date: '2026-08-08', posted: '2026-08-08', seq: 55 }
    ];
    var shuffled = [sent[3], sent[4], sent[1], sent[0], sent[2]];
    eq(shuffled.sort(G.newestFirst).map(function (c) { return c.seq; }).join(','), '50,51,52,54,55', 'bank order kept');
    // Same day, same posting day: the bank put the ride first, so it stays first.
    var day = [{ merchant: 'Gym', date: '2026-07-19', posted: '2026-07-19', seq: 65 },
      { merchant: 'Ride', date: '2026-07-19', posted: '2026-07-19', seq: 64 }];
    eq(day.sort(G.newestFirst)[0].merchant, 'Ride', 'ride above gym');
    // Without the bank's order (a statement): later posting day, then A to Z.
    var plain = [{ merchant: 'B', date: '2026-07-19', posted: '2026-07-19' }, { merchant: 'A', date: '2026-07-19', posted: '2026-07-19' },
      { merchant: 'C', date: '2026-07-19', posted: '2026-07-20' }];
    eq(plain.sort(G.newestFirst).map(function (c) { return c.merchant; }).join(''), 'CAB', 'fallback order');
  });

  test('atVenu: the band\u2019s number is picked by rule, never the gross', function () {
    // Reading: a venue cut, and Total Due Artist printed after card fees.
    var r = G.pickBandNumber({ income: { merch: 3974.5 }, totals: { gross: 5000, adjusted: 4566.15, dueArtist: 3823.67, dueVenue: 742.48 } });
    eq(r.income.merch, 3823.67, 'what\u2019s due the artist');
    // Worcester: the venue took nothing, no Total Due Artist line, the reader grabbed the gross.
    r = G.pickBandNumber({ income: { merch: 3565 }, totals: { gross: 3565, adjusted: 3258.54, dueArtist: null, dueVenue: 0 } });
    eq(r.income.merch, 3258.54, 'the adjusted gross when the venue took nothing');
    // A venue cut with no line saying what\u2019s due: the reader\u2019s own number stays (Ari checks it).
    r = G.pickBandNumber({ income: { merch: 2639.16 }, totals: { gross: 3683.5, adjusted: 3290.82, dueArtist: null, dueVenue: null } });
    eq(r.income.merch, 2639.16, 'no guessing past a venue cut');
    // Silver Spring: cash paid out on the night.
    r = G.pickBandNumber({ income: { merch: 2899.52 }, cash: -235, notes: [] });
    eq(r.cash, 0, 'nothing on hand');
    eq(r.notes[0].label + ' ' + r.notes[0].value, 'Cash from show \u2212$235.00 (cash paid out)', 'and a note says what went out');
    r = G.pickBandNumber({ income: { merch: 3258.54 }, cash: 375 });
    eq(r.cash, 375, 'ordinary cash untouched');
  });

  test('a card charge shows the day it was made; the posted day decides the balance', function () {
    var card = { label: 'Gold', amount: 1000, kind: 'card', cutoff: '2026-09-14', breakdown: {}, feed: { name: 'Gold' } };
    var t = { shows: {}, expenses: {}, crew: {}, commission: {}, extras: {}, debts: { c1: card },
      charges: {
        a: { date: '2026-09-13', posted: '2026-09-13', merchant: 'Hotel', amount: 200, category: 'hotels', account: 'Gold' },
        // Made the 13th, posted the 15th: not in the balance read on the 14th.
        b: { date: '2026-09-13', posted: '2026-09-15', merchant: 'Amazon', amount: 52.99, category: 'supplies', account: 'Gold' },
        // An older charge with no posted day falls back to its date.
        c: { date: '2026-09-10', merchant: 'Pilot', amount: 50, category: 'gas', account: 'Gold' } } };
    near(G.cardMoved(card, t), 250, 'the hotel and the gas moved out of the balance; Amazon did not');
    near(G.cardSummary(card, t).remainder, 750, 'what is still to sort');
  });

  test('a card charge logged to another tour leaves this tour\u2019s card balance without counting here', function () {
    var card = { label: 'Gold', amount: 1000, kind: 'card', cutoff: '2026-09-28', breakdown: {}, feed: { name: 'Gold' } };
    var t = { shows: {}, expenses: {}, crew: {}, commission: {}, extras: {}, debts: { c1: card },
      charges: { a: { date: '2026-09-20', merchant: 'Hotel', amount: 200, category: 'hotels', account: 'Gold' } } };
    var before = G.calc(t).out;
    t.cardAway = { pg: { account: 'Gold', amount: 150, date: '2026-09-27', posted: '2026-09-27', to: 'winter' } };
    near(G.cardSummary(card, t).remainder, 650, 'the gear for the next tour is out of what is still to sort');
    near(G.calc(t).out, before - 150, 'and this tour no longer counts it');
  });

  test('buyouts count only what the Artists got as income', function () {
    var show = { date: '2026-05-10', income: { buyouts: 60, guarantee: 1000 }, loggedAt: 1 };
    eq(G.buyoutIncome(show), 0, 'nobody ticked yet: nothing counts');
    show.buyoutTrack = { perHead: 20, paid: { a: { name: 'Devin', artist: true }, b: { name: 'Brent', artist: false } } };
    eq(G.buyoutIncome(show), 20, 'the Artist\u2019s $20 counts; the crew\u2019s passes through');
    show.buyoutTrack.paid.b = null;
    eq(G.buyoutIncome(show), 20, 'an untick (null) changes nothing for crew');
    show.buyoutTrack.paid.c = { name: 'Sam', artist: true };
    eq(G.showIncomeTotal(show), 1040, 'two Artists\u2019 buyouts plus the guarantee');
    var t = { shows: { s1: show }, expenses: {}, crew: {}, commission: {}, extras: {}, charges: {}, debts: {} };
    eq(G.calc(t).incomeBy.buyouts, 40, 'the tour counts the same');
  });

  test('card logging dates follow the tour, rehearsals or a chosen day', function () {
    var t = { shows: keyed([{ date: '2026-05-10', city: 'A' }, { date: '2026-05-20', city: 'B' }]) };
    eq(G.cardWindow(t), null, 'no dates chosen: nothing is logged');
    t.cardLog = { from: 'tour', to: 'tour' };
    eq(JSON.stringify(G.cardWindow(t)), JSON.stringify({ from: '2026-05-10', to: '2026-05-20' }), 'first show to last show');
    t.spanStart = '2026-05-08'; t.spanEnd = '2026-05-22';
    eq(JSON.stringify(G.cardWindow(t)), JSON.stringify({ from: '2026-05-08', to: '2026-05-22' }), 'travel days stretch it');
    t.cardLog.from = 'rehearsals';
    eq(G.cardWindow(t).from, '2026-05-08', 'no rehearsal days: starts with the tour');
    t.rehearsalStart = '2026-05-01'; t.rehearsalEnd = '2026-05-05';
    eq(G.cardWindow(t).from, '2026-05-01', 'start of rehearsals');
    t.cardLog = { from: '2026-04-15', to: '2026-05-31' };
    eq(JSON.stringify(G.cardWindow(t)), JSON.stringify({ from: '2026-04-15', to: '2026-05-31' }), 'custom days');
    t.cardLog = { from: '2026-06-01', to: 'tour' };
    eq(G.cardWindow(t), null, 'an end before the start logs nothing');
  });

  /* ============ Commission behaviour ============ */

  test('percentage commission grows as income is logged', function () {
    var t = {
      expenses: {}, crew: {}, debts: {}, extras: {},
      commission: { management: { mode: 'pct', value: 10 }, agent: { mode: 'flat', value: 0 },
        lawyer: { mode: 'flat', value: 0 } },
      shows: keyed([
        { date: '2026-05-01', city: 'A', loggedAt: 1, income: { guarantee: 1000 } },
        { date: '2026-05-02', city: 'B', loggedAt: 2, income: { guarantee: 1000 } }
      ])
    };
    near(G.calc(t).commission, 200, 'two shows');
    delete t.shows.r1;
    near(G.calc(t).commission, 100, 'one show');
  });

  test('management and lawyer percentages apply to all income', function () {
    var t = {
      expenses: {}, crew: {}, debts: {}, extras: {},
      commission: { management: { mode: 'pct', value: 10 }, agent: { mode: 'flat', value: 0 },
        lawyer: { mode: 'pct', value: 5 } },
      shows: keyed([{ date: '2026-05-01', city: 'A', loggedAt: 1,
        income: { guarantee: 1000, merch: 1000 } }])
    };
    near(G.calc(t).commission, 300, 'management 200 + lawyer 100');
  });

  /* Single entry: anything typed once must reach every readout, and nothing
     may be counted twice. */
  function auditTour() {
    return {
      name: 'Audit',
      expenses: { gas: { projected: 1000, paid: 0 }, hotels: { projected: 0, paid: 500 } },
      crew: keyed([{ name: 'Sam', title: 'TM', pay: 2000 }]),
      commission: { management: { mode: 'pct', value: 10 },
                    agent: { mode: 'flat', value: 0 }, lawyer: { mode: 'flat', value: 0 } },
      debts: keyed([{ label: 'Amex', amount: 3000, kind: 'card', cutoff: null, breakdown: { gas: 1200 } }]),
      extras: keyed([{ date: '2026-03-01', label: 'Parking', amount: 40, createdAt: 1 }]),
      charges: keyed([{ date: '2026-03-01', merchant: 'Pilot', amount: 300, category: 'gas' },
                      { date: '2026-03-01', merchant: 'Already', amount: 999, category: 'gas', accounted: true }]),
      imports: {},
      shows: { s1: { date: '2026-03-01', city: 'Detroit, MI', loggedAt: 1,
        income: { guarantee: 5000, merch: 1000, backend: 0, vip: 0, buyouts: 0, catering: 0, misc: 0 } } }
    };
  }

  test('single entry — income typed once reaches total, commission, chart and closeout', function () {
    var t = auditTour();
    var c = G.calc(t);
    near(c.income, 6000, 'income');
    near(c.commission, 600, 'commission off that same income');
    var series = G.balanceSeries(t);
    var last = series[series.length - 1];
    near(last.income, c.income, 'chart income');
    near(last.net, c.net, 'chart net');
    var csv = G.closeoutCSVs(t)['shows.csv'];
    if (csv.indexOf('Detroit, MI') < 0) throw new Error('show missing from closeout');
  });

  test('single entry — crew pay, card breakdown and charges each count exactly once', function () {
    var t = auditTour();
    var c = G.calc(t);
    near(G.crewProjection(t), 2000, 'crew projection');
    var gas = c.lines.filter(function (l) { return l.key === 'gas'; })[0];
    near(gas.paid, 1500, 'card breakdown 1200 + charge 300, accounted one excluded');
    near(c.debt, 0, 'a card never doubles as debt');
    near(c.dayByDay, 40, 'day by day');
    near(c.out, c.fixed + c.commission + c.debt + c.dayByDay, 'out is exactly its parts');
  });

  test('a charge marked already accounted for is not counted twice', function () {
    var base = { expenses: {}, crew: {}, debts: {}, commission: {}, extras: {}, shows: {}, imports: {},
      charges: keyed([{ date: '2026-03-01', merchant: 'Pilot', amount: 400, category: 'gas' }]) };
    near(G.calc(base).out, 400, 'a normal charge counts');
    var marked = JSON.parse(JSON.stringify(base));
    G.rows(marked.charges).forEach(function (c) { marked.charges[c.id].accounted = true; });
    near(G.calc(marked).out, 0, 'an accounted charge does not');
  });

  test('a custom category (extraCats) counts like any built-in', function () {
    var t = { expenses: {}, crew: {}, debts: {}, commission: {}, extras: {}, shows: {},
      extraCats: { 'x-security': 'Security' },
      charges: keyed([{ date: '2026-03-01', merchant: 'Guard Co', amount: 250, category: 'x-security' }]),
      imports: {} };
    near(G.calc(t).out, 250, 'the security charge is counted');
    eq(G.typedCategoriesFor(t).filter(function (c) { return c.key === 'x-security'; })[0].label,
      'Security', 'label rides along');
  });

  test('Credit card and Loan are plain categories that count', function () {
    var t = { expenses: { card: { projected: null, paid: 900 }, loan: { projected: null, paid: 400 } },
      crew: {}, debts: {}, commission: {}, extras: {}, shows: {}, charges: {}, imports: {} };
    near(G.calc(t).out, 1300, 'both count against the tour');
    ['card', 'loan'].forEach(function (k) {
      if (!G.CATEGORIES.some(function (c) { return c.key === k; })) {
        throw new Error(k + ' missing from CATEGORIES');
      }
    });
  });

  test('bulk guest paste \u2014 +1s, emails and parens parse out', function () {
    var g = G.parseGuestList('Sam Reyes +1 (Label)\n2. Dana Cole - dana@mail.com\nmgmt group x4\n\n');
    eq(g.length, 3, 'three guests');
    eq(g[0].firstName, 'Sam', 'first name');
    eq(g[0].lastName, 'Reyes', 'last name');
    eq(g[0].qty, 2, 'a +1 means two tickets');
    eq(g[0].affiliation, 'Label', 'affiliation from parens');
    eq(g[1].email, 'dana@mail.com', 'email peels off');
    eq(g[1].firstName, 'Dana', 'bullet number stripped');
    eq(g[2].qty, 4, 'x4 means four');
  });

  test('commission base checkboxes — agent can take merch too, VIPs untouched', function () {
    var t = { expenses: {}, crew: {}, debts: {}, extras: {}, charges: {}, imports: {},
      commission: {
        management: { mode: 'flat', value: 0 }, lawyer: { mode: 'flat', value: 0 },
        agent: { mode: 'pct', value: 10,
          base: { guarantee: true, backend: false, merch: true, vip: false,
                  buyouts: false, catering: false, misc: false } }
      },
      shows: keyed([{ date: '2026-03-01', income: { guarantee: 1000, merch: 500, vip: 250 } }])
    };
    near(G.calc(t).commission, 150, '10% of guarantee 1000 + merch 500');
  });

  test('a flat commission ignores income entirely', function () {
    var t = {
      expenses: {}, crew: {}, debts: {}, extras: {},
      commission: { management: { mode: 'flat', value: 2500 }, agent: { mode: 'flat', value: 0 },
        lawyer: { mode: 'flat', value: 0 } },
      shows: keyed([{ date: '2026-05-01', city: 'A', loggedAt: 1, income: { guarantee: 99999 } }])
    };
    near(G.calc(t).commission, 2500, 'flat');
  });

  /* ============ Charges feed categories and day by day ============ */

  test('a card charge tagged day by day lands on the day-by-day pile', function () {
    var t = {
      expenses: {}, crew: {}, debts: {}, commission: {},
      extras: keyed([{ date: '2026-06-01', label: 'Food', amount: 40, createdAt: 1 }]),
      charges: keyed([{ date: '2026-06-01', merchant: 'Shell', amount: 60, category: 'dayByDay', importId: 'i1' }]),
      shows: {}
    };
    near(G.calc(t).dayByDay, 100, 'day by day');
    near(G.calc(t).out, 100, 'out');
  });

  test('a charge with no category yet counts toward nothing', function () {
    var t = {
      expenses: {}, crew: {}, debts: {}, commission: {}, extras: {}, shows: {},
      charges: keyed([{ date: '2026-06-01', merchant: 'Unknown', amount: 500, category: null, importId: 'i1' }])
    };
    near(G.calc(t).out, 0, 'out');
  });

  /* ============ State and captions ============ */

  test('an untouched tour reads as idle, not red', function () {
    var c = G.calc({ expenses: {}, crew: {}, debts: {}, commission: {}, extras: {}, shows: {} });
    eq(G.stateOf(c), 'idle', 'state');
  });

  test('exactly break even reads as green', function () {
    var t = {
      expenses: { bus: { projected: 1000, paid: 0 } },
      crew: {}, debts: {}, commission: {}, extras: {},
      shows: keyed([{ date: '2026-07-01', city: 'A', loggedAt: 1, income: { guarantee: 1000 } }])
    };
    var c = G.calc(t);
    eq(G.round(c.net), 0, 'net');
    eq(G.stateOf(c), 'green', 'state');
    eq(G.caption(c), 'right at break even', 'caption');
  });

  /* ============ Balance series ============ */

  test('the balance walks day by day and ends on the tour total', function () {
    var t = tourOne();
    var s = G.balanceSeries(t);
    eq(s.length, 2, 'two days');
    eq(s[0].date, '2026-03-01', 'first day');
    // Day one: only Detroit's income, and no parking yet.
    near(s[0].income, 13500, 'day one income');
    near(s[s.length - 1].net, G.calc(t).net, 'last day matches the tour total');
  });

  test('the balance starts in the red because projections are committed from day one', function () {
    var s = G.balanceSeries(tourOne());
    if (!(s[0].net < 0)) throw new Error('expected day one to be negative, got ' + s[0].net);
  });

  test('a tour with a single date still draws a line, not a dot', function () {
    var t = {
      expenses: { bus: { projected: 4000, paid: 0 } },
      crew: {}, debts: {}, commission: {}, extras: {},
      shows: keyed([{ date: '2026-10-05', city: 'Detroit, MI', loggedAt: 1,
        income: { guarantee: 5000 } }])
    };
    var s = G.balanceSeries(t);
    eq(s.length, 2, 'two points');
    eq(s[0].date, '2026-10-04', 'starts the day before');
    eq(s[0].income, 0, 'nothing earned on day zero');
    near(s[0].net, -4000, 'day zero is the full cost');
    near(s[1].net, 1000, 'the show pulls it into the green');
  });

  test('agency deposit: the agent holds that whole guarantee as an advance on the tour\u2019s commission', function () {
    var t = {
      expenses: {}, crew: {}, debts: {}, extras: {}, charges: {},
      commission: { agent: { mode: 'pct', value: 10, base: { guarantee: true } }, management: { mode: 'pct', value: 15, base: { guarantee: true, merch: true } } },
      shows: keyed([
        // Not ticked Received, but the agency has it: it's in.
        { date: '2026-10-05', city: 'Detroit, MI', loggedAt: 1, income: { guarantee: 8000, merch: 1000 }, guaranteePaidBy: 'agency', guaranteeReceived: false },
        { date: '2026-10-06', city: 'Chicago, IL', loggedAt: 1, income: { guarantee: 4000 }, guaranteePaidBy: 'check' }])
    };
    var c = G.calc(t);
    var line = c.lines.filter(function (l) { return l.key === 'commission'; })[0];
    near(c.income, 13000, 'the held guarantee is income');
    eq(G.showMoneyState(t.shows.r0), 'settled', 'and not shown as owed');
    near(c.agentOwed, 1200, 'the agent has earned 10% of $12,000');
    near(c.agencyAdvance, 8000, 'and holds all of Detroit\u2019s $8,000');
    eq(c.agencyShows.length, 1, 'one agency show'); eq(c.agencyShows[0].city, 'Detroit, MI', 'which one');
    // Management's 15% of $13,000 is owed on top of what the agent holds.
    near(line.paid, 8000, 'the advance counts as commission paid');
    near(line.projected, 1950 + 8000, 'commission counts as at least what\u2019s held');
    near(line.left, 1950, 'management is still owed');
    // As the tour earns, the agent's 10% works the advance off, then passes it.
    t.shows.r2 = { date: '2026-10-07', city: 'Toledo, OH', loggedAt: 1, income: { guarantee: 100000 }, guaranteePaidBy: 'direct' };
    c = G.calc(t);
    line = c.lines.filter(function (l) { return l.key === 'commission'; })[0];
    near(c.agentOwed, 11200, 'the agent has now earned more than the advance');
    near(line.projected, 16950 + 11200, 'so commission is simply what\u2019s earned');
    near(line.left, 16950 + 11200 - 8000, 'less the advance already held');
    // A check or a direct deposit holds nothing back.
    t.shows.r0.guaranteePaidBy = 'check'; t.shows.r0.guaranteeReceived = true;
    eq(G.calc(t).agencyAdvance, 0, 'no advance');
  });

  test('crew pay: a rate times the tour\u2019s length, unless a total was typed over it', function () {
    var t = {
      expenses: {}, debts: {}, commission: {}, extras: {},
      shows: keyed([{ date: '2026-10-05', city: 'Detroit, MI' }, { date: '2026-11-06', city: 'Chicago, IL' }]),   // 33 days
      crew: keyed([
        { name: 'Weekly', per: 'week', rate: 1500 },                        // 5 weeks (part of a week counts)
        { name: 'Daily', per: 'day', rate: 100 },                           // 33 days
        { name: 'Monthly', per: 'month', rate: 4000 },                      // 2 months
        { name: 'Flat', per: 'other', rate: 0, pay: 2500 },                 // installments: the typed total
        { name: 'Agreed', per: 'week', rate: 1500, pay: 7000, payTyped: true },  // typed over the worked-out total
        { name: 'Old', pay: 900 }])                                         // before rates existed
    };
    eq(G.tourDays(t), 33, 'tour length');
    var by = {};
    G.rows(t.crew).forEach(function (p) { by[p.name] = G.crewPay(t, p); });
    eq(by.Weekly, 7500, 'weekly'); eq(by.Daily, 3300, 'daily'); eq(by.Monthly, 8000, 'monthly');
    eq(by.Flat, 2500, 'other'); eq(by.Agreed, 7000, 'typed over'); eq(by.Old, 900, 'plain total');
    near(G.crewProjection(t), 7500 + 3300 + 8000 + 2500 + 7000 + 900, 'the projection adds them up');
    // Rehearsals stretch the tour; a tour with no dates leaves a rate with nothing to multiply.
    t.rehearsalStart = '2026-09-28';
    eq(G.tourDays(t), 40, 'rehearsals count');
    eq(G.crewPay(t, { per: 'week', rate: 1500 }), 9000, '6 weeks with rehearsals');
    eq(G.crewPay({ shows: {} }, { per: 'week', rate: 1500, pay: 0 }), 0, 'no dates yet');
  });

  test('the chart starts the day the tour does; what was spent before is in its first point', function () {
    var t = {
      expenses: { bus: { projected: 4000, paid: 0 } },
      crew: {}, debts: {}, commission: {}, extras: {},
      charges: keyed([{ date: '2026-09-20', merchant: 'Van rental', amount: 300, category: 'bus' }]),
      shows: keyed([
        { date: '2026-10-05', city: 'Detroit, MI', loggedAt: 1, income: { merch: 1000 } },
        { date: '2026-10-07', city: 'Chicago, IL', loggedAt: 1, income: { merch: 1500 } }])
    };
    var s = G.balanceSeries(t);
    eq(s[0].date, '2026-10-05', 'starts with the first show, not the September charge');
    near(s[0].spent, 300, 'the September charge is already in');
    near(s[0].income, 1000, 'first night in');
    near(s[s.length - 1].income, 2500, 'money in only climbs');
    near(s[s.length - 1].spent, 300, 'spent is what went out, not the $4,000 plan');
    s.forEach(function (p, i) {
      if (i && p.income < s[i - 1].income) throw new Error('money in went down on ' + p.date);
      if (p.spent > p.out + 0.005) throw new Error('spent above the plan on ' + p.date);
    });
    eq(G.balanceSeries(t, { until: '2026-10-06' }).slice(-1)[0].date, '2026-10-06', 'stops at today while the tour is on');
  });

  /* ============ The change chip ============ */

  test('the change chip reports the last show net of commission', function () {
    var t = tourOne();
    var ch = G.latestChange(t);
    // Parking (createdAt 2) and Chicago (loggedAt 2) tie; the parking row sorts last.
    if (!ch) throw new Error('expected a change');
    eq(typeof ch.delta, 'number', 'delta type');
  });

  test('the change chip is empty on a tour where nothing has happened', function () {
    eq(G.latestChange({ expenses: {}, crew: {}, debts: {}, commission: {}, extras: {}, shows: {} }),
      null, 'change');
  });

  test('a show with income is worth its total minus the commission it triggers', function () {
    var t = {
      expenses: {}, crew: {}, debts: {}, extras: {},
      commission: { management: { mode: 'pct', value: 20 }, agent: { mode: 'flat', value: 0 },
        lawyer: { mode: 'flat', value: 0 } },
      shows: keyed([{ date: '2026-08-01', city: 'Detroit, MI', loggedAt: 10,
        income: { guarantee: 10000 } }])
    };
    var ch = G.latestChange(t);
    near(ch.delta, 8000, 'net change');
    eq(ch.label, 'Detroit, MI', 'label');
  });

  /* ============ Back end income ============ */

  test('back end counts as income, but the booking agent stays on guarantees', function () {
    var t = {
      expenses: {}, crew: {}, debts: {}, extras: {},
      commission: { management: { mode: 'pct', value: 10 }, agent: { mode: 'pct', value: 10 },
        lawyer: { mode: 'flat', value: 0 } },
      shows: keyed([{ date: '2026-05-01', city: 'A', loggedAt: 1,
        income: { guarantee: 10000, backend: 2500 } }])
    };
    var c = G.calc(t);
    eq(c.income, 12500, 'back end is income');
    eq(c.guarantees, 10000, 'but not a guarantee');
    // management 10% of 12,500 = 1,250; agent 10% of 10,000 = 1,000
    near(c.commission, 2250, 'agent untouched by back end');
  });

  test('anyone added to the team takes their cut alongside the standing three', function () {
    var comm = {
      management: { mode: 'pct', value: 15 },
      'x-b': { label: 'Tour accountant', mode: 'flat', value: 500, at: 2 },
      'x-a': { label: 'Business manager', mode: 'pct', value: 5, at: 1 },
      'x-gone': null,
      'x-blank': { label: '  ', mode: 'flat', value: 99 }
    };
    var lines = G.commissionLines(comm);
    eq(lines.map(function (l) { return l.label; }).join(','),
      'Management,Booking agent,Lawyer,Business manager,Tour accountant', 'standing three, then the team in order added');
    eq(lines[3].custom, true, 'marked as added');
    var inc = { guarantee: 10000 };
    // 15% + 5% of 10,000 plus a flat 500
    eq(G.commissionTotal(comm, 10000, 10000, inc), 2500, 'every cut counts');
    eq(G.normCommission(comm)['x-gone'], undefined, 'a removed member is gone');
    eq(G.normCommission(comm)['x-blank'], undefined, 'a nameless member is dropped');
  });

  /* ============ Day sheets ============ */

  test('the day sheet prints only what was filled in, in the order the day happens', function () {
    var lines = G.daySheetLines({
      daySheet: {
        busCall: '1:00 AM',
        loadIn: '2:00 PM',
        soundchecks: [{ band: 'In This Moment', time: '4:00 PM' }, { band: 'Support', time: '5:00 PM' }],
        doors: '7:00 PM',
        setTimes: [{ band: 'Support', time: '8:00 PM' }, { band: 'In This Moment', time: '9:15 PM' }],
        loadOut: '11:30 PM',
        lobbyCall: '10 AM',
        wifi: 'Venue5G / password stagepass',
        greenrooms: 'yes', showers: 'no',
        driveNext: '4h 20m — 285 mi',
        notes: 'Catering at 5'
      }
    });
    eq(lines[0], 'Wifi: Venue5G / password stagepass', 'venue info first');
    eq(lines[1], 'Lobby call: 10:00AM', 'lobby call starts the schedule');
    eq(lines[2], 'Load in: 2:00PM', 'then load in');
    eq(lines[3], 'Soundcheck — In This Moment: 4:00PM', 'soundcheck per band');
    eq(lines[5], 'Doors: 7:00PM', 'doors');
    eq(lines[6], 'Support: 8:00PM', 'set times in order');
    eq(lines[8], 'Load out: 11:30PM', 'load out after the sets');
    eq(lines[9], 'Bus call: 1:00AM', 'bus call closes the night');
    eq(lines[10], 'Drive to next venue: 4h 20m — 285 mi', 'then the drive');
    eq(lines[11], 'Greenrooms yes · no showers', 'amenities near the bottom, one line');
    eq(lines[lines.length - 1], 'Notes: Catering at 5', 'notes last');
    // nothing that wasn't filled in
    eq(lines.join('\n').indexOf('VIP'), -1, 'no empty VIP line');
    eq(lines.join('\n').indexOf('Parking'), -1, 'no empty parking line');
  });

  test('the day sheet comes in sections, empty ones left out', function () {
    var secs = G.daySheetSections({ daySheet: { venueAddress: '912 Red River St', doors: '7', laundry: 'yes' } });
    eq(secs.map(function (x) { return x.title; }).join(','), 'Venue,Schedule,Amenities', 'three sections');
    eq(secs[1].lines[0], 'Doors: 7:00', 'a bare number keeps what was typed');
    eq(G.daySheetSections({ daySheet: { busCall: '11 PM' } }).length, 1, 'only the schedule');
  });

  test('an empty day sheet prints nothing at all', function () {
    eq(G.daySheetLines({ daySheet: {} }).length, 0, 'no lines');
    eq(G.daySheetLines({}).length, 0, 'no sheet');
    eq(G.daySheetLines({ daySheet: null }).length, 0, 'a cleared sheet');
  });

  test('the copy text leads with the night, then each section under a heading', function () {
    var text = G.daySheetText({
      date: '2026-05-01', city: 'Detroit, MI', venue: 'The Fillmore',
      daySheet: { doors: '7:00 PM', parking: 'North lot' }
    });
    var t = text.split('\n');
    eq(t[0], 'Detroit, MI — The Fillmore · Fri, May 1', 'header');
    eq(t[1], '', 'a gap');
    eq(t[2], 'VENUE', 'venue heading');
    eq(t[3], 'Parking: North lot', 'venue line');
    eq(t[5], 'SCHEDULE', 'schedule heading');
    eq(t[6], 'Doors: 7:00PM', 'schedule line');
  });

  /* ============ Master Tour import ============ */

  test('a tour-software export becomes one clean entry per real date', function () {
    var r = G.normalizeTourImport({ days: [
      { date: '2026-05-01', city: 'Detroit, MI', venue: 'The Fillmore',
        loadIn: '2:00 PM', doors: '7:00 PM',
        setTimes: [{ band: 'In This Moment', time: '9:15 PM' }],
        greenrooms: 'YES', showers: 'nope', driveNext: '4h 20m' },
      { date: 'not a date', doors: '8:00 PM' },
      { date: '2026-05-02' }  // nothing on it
    ] });
    eq(r.found, 1, 'only the real, non-empty day survives');
    eq(r.days[0].date, '2026-05-01', 'date');
    eq(r.days[0].sheet.loadIn, '2:00 PM', 'load in');
    eq(r.days[0].sheet.greenrooms, 'yes', 'yes normalized');
    eq(r.days[0].sheet.showers, '', 'nonsense answer dropped');
    eq(r.days[0].sheet.setTimes[0].band, 'In This Moment', 'set time kept');
    eq(G.normalizeTourImport({ days: [{ date: '2026-05-01', loadOut: '11:30 PM' }] }).days[0].sheet.loadOut,
      '11:30 PM', 'load out comes through an import');
  });

  test('an import fills gaps but never erases what the manager wrote', function () {
    var merged = G.mergeDaySheet(
      { loadIn: '1:00 PM', wifi: 'OldNet / pass', busCall: '11:00 PM',
        setTimes: [{ band: 'Us', time: '9:00 PM' }] },
      G.normalizeTourImport({ days: [{ date: '2026-05-01', loadIn: '2:00 PM', doors: '7:00 PM',
        soundchecks: [], setTimes: [] }] }).days[0].sheet);
    eq(merged.loadIn, '2:00 PM', 'the import wins where it knows');
    eq(merged.doors, '7:00 PM', 'new field lands');
    eq(merged.wifi, 'OldNet / pass', 'unknown field keeps the old value');
    eq(merged.busCall, '11:00 PM', 'same');
    eq(merged.setTimes[0].band, 'Us', 'an empty import list never wipes a real one');
  });

  /* ============ Budget from a previous tour ============ */

  test('a baseline copies projections and the commission deal — never money', function () {
    var src = {
      expenses: {
        bus: { projected: 18000, paid: 6000 },
        gas: { projected: 4000, paid: 610 },
        hotels: { projected: null, paid: 900 }
      },
      commission: { management: { mode: 'pct', value: 15 }, agent: { mode: 'pct', value: 10 },
        lawyer: { mode: 'flat', value: 1500 } },
      crew: keyed([{ name: 'Sam', pay: 7000 }]),
      charges: keyed([{ date: '2026-01-01', merchant: 'Pilot', amount: 500, category: 'gas' }]),
      debts: keyed([{ label: 'Amex', amount: 9000, kind: 'card' }])
    };
    var b = G.budgetFrom(src);
    eq(b.expenses.bus.projected, 18000, 'projection carries');
    eq(b.expenses.bus.paid, 0, 'paid never carries');
    eq(b.expenses.hotels.projected, null, 'blank stays blank');
    eq(b.expenses.crew.projected, null, 'crew comes from the roster, not the budget');
    eq(b.total, 22000, 'total of the projections');
    eq(b.commission.management.value, 15, 'commission deal carries');
    eq(b.commissionSummary, 'Management 15% · Booking agent 10% · Lawyer $1,500', 'summary reads');
    eq(G.hasBudget(src), true, 'counts as a usable baseline');
    eq(G.hasBudget({}), false, 'an empty tour does not');
  });

  test('crew members file under one stable key per name', function () {
    eq(G.crewKey('Sam Reyes'), 'crew:sam-reyes', 'slug');
    eq(G.crewKey('  SAM  REYES!  '), 'crew:sam-reyes', 'case and junk ignored');
  });

  /* ============ Tour closeout ============ */

  test('CSV cells with commas, quotes and lines survive intact', function () {
    var out = G.toCSV([['a', 'has, comma', 'has "quote"'], ['b', 'plain', '']]);
    eq(out.split('\n')[0], 'a,"has, comma","has ""quote"""', 'escaping');
    eq(out.split('\n')[1], 'b,plain,', 'plain row');
  });

  test('the closeout bundle carries every table an accountant needs', function () {
    var t = tourOne();
    t.charges = keyed([{ date: '2026-03-01', merchant: 'Pilot', amount: 60, category: 'gas' }]);
    var files = G.closeoutCSVs(t);
    var names = Object.keys(files);
    eq(names.length, 5, 'five files');
    var shows = files['shows.csv'].split('\n');
    eq(shows[0].indexOf('Guarantee') > 0 && shows[0].indexOf('Back end') > 0, true, 'gig log header');
    eq(shows[1].indexOf('Detroit, MI') > 0 && shows[1].indexOf('7500') > 0, true, 'detroit row');
    var exp = files['expenses-budget-vs-actual.csv'];
    eq(exp.indexOf('NET') > 0, true, 'net line');
    eq(exp.indexOf('Owed: Credit card') > 0, true, 'loans listed');
    var charges = files['card-charges.csv'].split('\n');
    eq(charges[1], '2026-03-01,Pilot,60,Gas', 'audit trail row');
    var comm = files['commissions.csv'];
    eq(comm.indexOf('15%') > 0 && comm.indexOf('Booking agent') > 0, true, 'commission deal');
  });

  test('food in the day-by-day is flagged for the 50% meal rule', function () {
    var t = tourOne();
    t.extras = keyed([
      { date: '2026-03-01', label: 'Food run', amount: 40 },
      { date: '2026-03-01', label: 'Parking', amount: 20 }
    ]);
    var rows = G.closeoutCSVs(t)['day-by-day.csv'].split('\n');
    eq(rows[1].indexOf('MEAL (50% rule)') > 0, true, 'food flagged');
    eq(rows[2].indexOf('MEAL') < 0, true, 'parking not flagged');
  });

  /* ============ Guest list ============ */

  test('the guest summary counts names and tickets, clamped sane', function () {
    var s = G.guestSummary([
      { firstName: 'A', qty: 2 }, { firstName: 'B', qty: 0 }, { firstName: 'C', qty: 99 }
    ]);
    eq(s.names, 3, 'names');
    eq(s.tickets, 23, 'tickets: 2 + 1 (floor) + 20 (cap)');
  });

  test('the box-office text sorts by last name and totals the door', function () {
    var text = G.guestListText(
      { date: '2026-05-01', city: 'Detroit, MI', venue: 'The Fillmore' },
      [
        { firstName: 'Devin', lastName: 'Oliver', qty: 2, passType: 'All Access' },
        { firstName: 'Sam', lastName: 'Adams', qty: 1, passType: 'GA', affiliation: 'Label' }
      ]);
    var lines = text.split('\n');
    eq(lines[0], 'Guest list — Detroit, MI, The Fillmore · Fri, May 1', 'header');
    eq(lines[1], 'Adams, Sam x1 — GA (Label)', 'sorted by last name');
    eq(lines[2], 'Oliver, Devin x2 — All Access', 'row');
    eq(lines[3], '2 names · 3 tickets', 'door total');  // plural forms
  });

  test('pass types are the four laminate levels', function () {
    eq(G.GUEST_PASSES.join('|'), 'GA|VIP|All Access|Photo Pass', 'passes');
  });

  /* ============ Settlement sheets ============ */

  test('a settlement fills only the numbers it actually found', function () {
    var r = G.normalizeSettlement({
      income: { guarantee: 10000, merch: '2,412.50', vip: null, buyouts: 0, misc: 500, miscLabel: 'Back end' },
      notes: [
        { label: 'Attendance', value: '734 of 900 (82%)' },
        { label: 'Tax withheld', value: '$1,400 — you walked with $8,600' }
      ]
    });
    eq(r.income.guarantee, 10000, 'guarantee');
    eq(r.income.merch, 2412.5, 'merch survives commas');
    eq('vip' in r.income, false, 'null stays empty');
    eq('buyouts' in r.income, false, 'zero stays empty');
    eq(r.income.misc, 500, 'backend in misc');
    eq(r.miscLabel, 'Back end', 'labelled');
    eq(r.found, 3, 'three fields found');
    eq(r.notes.length, 2, 'notes kept');
    eq(r.notes[0].label, 'Attendance', 'note label');
  });

  test('a garbage settlement read comes back empty, never invented', function () {
    var r = G.normalizeSettlement('not even an object');
    eq(r.found, 0, 'nothing found');
    eq(r.notes.length, 0, 'no notes');
    var r2 = G.normalizeSettlement({ income: { guarantee: -500, merch: 'abc' }, notes: [{ label: 'X' }, 'junk'] });
    eq(r2.found, 0, 'negative and nonsense rejected');
    eq(r2.notes.length, 0, 'half-notes rejected');
  });

  test('settlement notes are clipped, not trusted', function () {
    var long = new Array(50).join('very ');
    var r = G.normalizeSettlement({ notes: [{ label: long, value: long }] });
    if (r.notes[0].label.length > 40) throw new Error('label not clipped');
    if (r.notes[0].value.length > 120) throw new Error('value not clipped');
  });

  /* ============ Dates ============ */

  test('the tour day rolls over at 5am, not midnight', function () {
    var lateNight = new Date(2026, 2, 15, 2, 30).getTime();  // 2:30am on the 15th
    eq(G.tourToday(lateNight), '2026-03-14', 'still the 14th at 2:30am');
    var morning = new Date(2026, 2, 15, 6, 0).getTime();
    eq(G.tourToday(morning), '2026-03-15', 'the 15th by 6am');
  });

  test('adding a day rolls across month ends', function () {
    eq(G.addDays('2026-01-31', 1), '2026-02-01', 'january');
    eq(G.addDays('2026-12-31', 1), '2027-01-01', 'new year');
  });

  test('a bad date is rejected rather than guessed', function () {
    eq(G.parseDay('2026-02-30'), null, 'february 30th');
    eq(G.parseDay('not a date'), null, 'nonsense');
  });

  /* ============ Formatting ============ */

  test('money reads with a sign and words, never colour alone', function () {
    eq(G.money(-1234), '-$1,234', 'negative');
    eq(G.money(1234, true), '+$1,234', 'signed positive');
    eq(G.money(0, true), '$0', 'zero');
    eq(G.money(2140, true), '+$2,140', 'acceptance number');
  });

  /* ============ Daily update ============ */

  test("today's update names the balance, the coverage and the next show", function () {
    var t = tourOne();
    var at = new Date(2026, 2, 1, 20, 0).getTime();
    var text = G.dailyUpdate(t, at);
    if (text.indexOf('Detroit, MI') < 0) throw new Error('missing tonight: ' + text);
    if (text.indexOf('% of costs covered') < 0) throw new Error('missing coverage: ' + text);
    if (text.indexOf('Next: ') < 0) throw new Error('missing next show: ' + text);
  });

  /* ============ Money received ============ */

  test('a guarantee not received yet stays out of the budget', function () {
    var t = tourOne();
    var ids = Object.keys(t.shows);
    t.shows[ids[1]].guaranteeReceived = false;           // Chicago's 60,000 is still owed
    eq(G.calc(t).income, 13500, 'income without Chicago');
    t.shows[ids[1]].guaranteeReceived = true;
    eq(G.calc(t).income, 73500, 'income once it lands');
  });

  test('shows logged before the Received box keep counting', function () {
    eq(G.calc(tourOne()).income, 73500, 'legacy income');
    eq(G.showMoneyState(tourOne().shows.r0), 'settled', 'legacy show reads settled');
  });

  test('a show is owed, then partly in, then settled', function () {
    var s = { loggedAt: 1, income: { guarantee: 5000, merch: 1200 }, merchCash: 300,
      guaranteeReceived: false, merchReceived: false };
    eq(G.merchDue(s), 900, 'deposit expected: net minus cash');
    eq(G.showMoneyState(s), 'owed', 'nothing in');
    s.guaranteeReceived = true;
    eq(G.showMoneyState(s), 'partial', 'guarantee in, merch not');
    s.guaranteeReceived = false; s.merchReceived = true;
    eq(G.showMoneyState(s), 'partial', 'merch in, guarantee not');
    s.guaranteeReceived = true;
    s.merchReceived = true;
    eq(G.showMoneyState(s), 'settled', 'both in');
    eq(G.showMoneyState({ income: { guarantee: 1 } }), null, 'a night not logged has no colour');
    eq(G.showMoneyState({ loggedAt: 1, income: { merch: 400 }, merchCash: 400, merchReceived: false }),
      'settled', 'all-cash merch has no deposit to wait for');
  });

  test('merch cash spent on the tour counts; deposits and hand-offs do not', function () {
    var t = tourOne();
    t.shows.r0.merchCash = 1000;
    t.cashLog = keyed([
      { date: '2026-03-02', amount: 150, category: 'gas', label: 'Fuel' },
      { date: '2026-03-02', amount: 600, category: 'deposit', label: 'Bank' },
      { date: '2026-03-02', amount: 100, category: 'handoff', label: 'Per diems float' }
    ]);
    var c = G.calc(t);
    var gas = c.lines.filter(function (l) { return l.key === 'gas'; })[0];
    near(gas.paid, 150, 'gas paid from cash');
    var sum = G.cashSummary(t);
    eq(sum.took, 1000, 'cash taken in');
    eq(sum.used, 850, 'cash accounted for');
    eq(sum.left, 150, 'cash still to account for');
  });

  test('merch cash is caught up show by show, oldest first', function () {
    var t = { shows: keyed([
      { date: '2026-09-25', loggedAt: 1, income: { merch: 800 }, merchCash: 200 },   // Dallas, r0
      { date: '2026-09-27', loggedAt: 1, income: { merch: 1200 }, merchCash: 300 },  // Austin, r1
      { date: '2026-09-28', loggedAt: 1, income: { merch: 500 } }                    // no cash
    ]) };
    t.cashLog = keyed([
      { date: '2026-09-27', amount: 120, category: 'food', showId: 'r1' },   // Austin's cash
      { date: '2026-09-26', amount: 250, category: 'deposit' }               // no show: oldest first
    ]);
    var c = G.cashByShow(t);
    eq(c.nights.length, 2, 'only nights with cash');
    eq(c.nights[0].left, 0, 'Dallas covered by the loose deposit');
    eq(c.nights[1].left, 130, 'Austin: 300 - 120 - the 50 the deposit had left');
  });

  test('an atVenu Settlement says what the card deposit will be', function () {
    var r = G.normalizeSettlement({ reportType: 'settlement', income: { merch: '3,150.00' }, cash: '1,020',
      cards: { receipts: '2,400.00', fee: '64.20' }, cardsBy: 'Artist', notes: [] });
    eq(r.reportType, 'settlement', 'kind');
    eq(r.cardDeposit, 2335.8, 'card sales less fees');
    var show = { loggedAt: 1, income: { merch: 3150 }, merchCash: 1020, merchCardDeposit: r.cardDeposit };
    eq(G.merchDue(show), 2335.8, 'the deposit to expect is the card payout, not net minus cash');
    eq(G.normalizeSettlement({ reportType: 'Tour Progress', income: { merch: 9000 } }).reportType, 'tour_progress', 'a tour-to-date report');
    eq(G.normalizeSettlement({ income: { merch: 100 }, cards: { receipts: 80, fee: 2 }, cardsBy: 'Venue' }).cardDeposit,
      null, 'the venue ran the cards: nothing comes from atVenu');
  });

  test('an atVenu report brings its merch cash along', function () {
    var r = G.normalizeSettlement({ income: { merch: '$1,200.00' }, cash: '$300', notes: [] });
    eq(r.income.merch, 1200, 'net');
    eq(r.cash, 300, 'cash');
    eq(G.normalizeSettlement({ income: { merch: 50 } }).cash, null, 'no cash printed');
  });

  test('day sheet times read one way: 6:00PM', function () {
    eq(G.joinTime('6', 'PM'), '6:00PM', 'a bare hour');
    eq(G.joinTime('630', 'PM'), '6:30PM', 'no colon');
    eq(G.joinTime('6.30', 'AM'), '6:30AM', 'a dot');
    eq(G.joinTime('11:45', 'PM'), '11:45PM', 'with a colon');
    eq(G.cleanTime('7:00 PM'), '7:00PM', 'an older entry');
    eq(G.cleanTime('7pm'), '7:00PM', 'shorthand');
    eq(G.cleanTime('19:00'), '7:00PM', '24-hour');
    eq(G.cleanTime('TBA'), 'TBA', 'not a time, left alone');
    eq(G.joinTime('', 'PM'), '', 'blank stays blank');
    eq(G.splitTime('11:00 AM').ampm, 'AM', 'the AM/PM comes back out for editing');
  });

  /* ============ The money, checked twice ============
     A second calculator, written straight from the rules (not from calc's
     code), run against hundreds of made-up tours with every kind of money
     in them. The tour's total, income, what's out and every category must
     agree to the cent, on the day and on every day of the chart. */
  (function () {
    var seed = 20260929;
    function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
    function pick(a) { return a[Math.floor(rnd() * a.length)]; }
    function amt(max) { var v = Math.round(rnd() * max * 100) / 100; return rnd() < 0.15 ? v.toLocaleString('en-US') : v; }
    function day(i) { return G.addDays('2026-05-01', i); }
    var n = function (v) { return G.num(v); };

    function makeTour() {
      var t = { shows: {}, expenses: {}, crew: {}, commission: {}, extras: {}, charges: {}, debts: {}, cashLog: {}, imports: {} };
      if (rnd() < 0.5) t.extraCats = { 'x-van': 'Van rental' };
      var cats = G.typedCategoriesFor(t).map(function (c) { return c.key; });
      var chargeCats = cats.concat(['commission', 'dayByDay']);
      var ns = 1 + Math.floor(rnd() * 6);
      for (var i = 0; i < ns; i++) {
        var sh = { date: day(i * 2), city: 'C' + i, income: {} };
        G.INCOME_FIELDS.forEach(function (f) { if (rnd() < 0.5) sh.income[f.key] = amt(f.key === 'guarantee' ? 5000 : 900); });
        if (rnd() < 0.4) sh.guaranteeReceived = rnd() < 0.5;
        if (rnd() < 0.5) {
          sh.buyoutTrack = { perHead: amt(40), paid: {} };
          for (var b = 0; b < 4; b++) {
            if (rnd() < 0.6) sh.buyoutTrack.paid['p' + b] = rnd() < 0.2 ? null : { name: 'P' + b, artist: rnd() < 0.4 };
          }
        }
        if (rnd() < 0.5) sh.merchCash = amt(300);
        sh.loggedAt = 1;
        t.shows['s' + i] = sh;
      }
      cats.forEach(function (k) {
        if (rnd() < 0.5) t.expenses[k] = { projected: rnd() < 0.6 ? amt(4000) : null, paid: rnd() < 0.3 ? amt(800) : 0 };
      });
      for (var c = 0; c < 3; c++) if (rnd() < 0.6) t.crew['c' + c] = { name: 'Crew ' + c, pay: amt(3000) };
      var accts = ['Gold ··1008', 'Amex ··2222', ''];
      for (var j = 0; j < 12; j++) {
        if (rnd() < 0.7) t.charges['ch' + j] = { date: rnd() < 0.9 ? day(Math.floor(rnd() * 12) - 2) : '',
          merchant: 'M' + j, amount: amt(400), category: rnd() < 0.9 ? pick(chargeCats) : '',
          account: pick(accts), accounted: rnd() < 0.15, manual: rnd() < 0.2 };
      }
      for (var k2 = 0; k2 < 4; k2++) {
        if (rnd() < 0.5) t.cashLog['x' + k2] = { date: day(Math.floor(rnd() * 12)), amount: amt(150),
          category: pick(cats.concat(['deposit', 'handoff', 'commission'])) };
      }
      for (var e = 0; e < 3; e++) if (rnd() < 0.5) t.extras['e' + e] = { date: day(Math.floor(rnd() * 12)), label: 'Meal', amount: amt(120) };
      if (rnd() < 0.5) t.debts.d1 = { label: 'Trailer loan', amount: amt(5000) };
      if (rnd() < 0.5) {
        var bd = {}; if (rnd() < 0.6) { bd.bus = amt(3000); bd.food = amt(500); }
        t.debts.d2 = { label: 'Visa', amount: amt(6000), kind: 'card', breakdown: bd, cutoff: rnd() < 0.5 ? day(1) : null };
      }
      if (rnd() < 0.6) {
        t.debts.d3 = { label: 'Gold ··1008', amount: amt(20000), kind: 'card', breakdown: {}, cutoff: day(Math.floor(rnd() * 8)),
          feed: { name: 'Gold ··1008' }, payments: rnd() < 0.5 ? { py1: { date: day(9), amount: amt(8000) } } : {} };
      }
      G.commissionLines(t.commission).forEach(function (line) {
        if (rnd() < 0.5) {
          var base = {}; G.INCOME_FIELDS.forEach(function (f) { base[f.key] = rnd() < 0.6; });
          t.commission[line.key] = { mode: rnd() < 0.6 ? 'pct' : 'flat', value: rnd() < 0.6 ? amt(20) : amt(900), base: rnd() < 0.7 ? base : undefined };
        }
      });
      return t;
    }

    // The rules, written out plainly.
    function oracle(t, upTo) {
      var inDay = function (d) { return !upTo || (d && d <= upTo); };
      var shows = Object.keys(t.shows).map(function (k) { return t.shows[k]; }).filter(function (s) { return inDay(s.date); });
      var incomeBy = {};
      G.INCOME_FIELDS.forEach(function (f) { incomeBy[f.key] = 0; });
      shows.forEach(function (s) {
        G.INCOME_FIELDS.forEach(function (f) {
          var v = n(s.income[f.key]);
          if (f.key === 'guarantee' && s.guaranteeReceived === false) v = 0;
          if (f.key === 'buyouts') {
            var tr = s.buyoutTrack, artists = 0;
            if (tr) Object.keys(tr.paid).forEach(function (k) { if (tr.paid[k] && tr.paid[k].artist) artists += 1; });
            v = v > 0 && tr ? Math.min(v, Math.round(n(tr.perHead) * artists * 100) / 100) : 0;
          }
          incomeBy[f.key] += v;
        });
      });
      var income = 0; Object.keys(incomeBy).forEach(function (k) { income += incomeBy[k]; });

      var paidIn = {};
      var add = function (k, v) { paidIn[k] = (paidIn[k] || 0) + v; };
      Object.keys(t.charges).forEach(function (id) {
        var ch = t.charges[id];
        if (!ch.accounted && ch.category && inDay(ch.date)) add(ch.category, n(ch.amount));
      });
      Object.keys(t.cashLog).forEach(function (id) {
        var x = t.cashLog[id];
        if (x.category !== 'deposit' && x.category !== 'handoff' && inDay(x.date)) add(x.category, n(x.amount));
      });
      var loans = 0;
      Object.keys(t.debts).forEach(function (id) {
        var d = t.debts[id];
        if (d.kind !== 'card') { loans += n(d.amount); return; }
        var broken = 0;
        Object.keys(d.breakdown || {}).forEach(function (k) { add(k, n(d.breakdown[k])); broken += n(d.breakdown[k]); });
        var moved = 0;
        if (d.feed) Object.keys(t.charges).forEach(function (cid) {
          var ch = t.charges[cid];
          if (!ch.accounted && ch.category && ch.account === d.feed.name && ch.date && ch.date <= d.cutoff && inDay(ch.date)) moved += n(ch.amount);
        });
        var rest = Math.max(0, n(d.amount) - broken - moved);
        add(d.feed ? 'card' : 'misc', rest);
      });

      var fixed = 0, lines = {};
      G.typedCategoriesFor(t).forEach(function (c) {
        var rec = t.expenses[c.key] || {};
        var crew = 0; Object.keys(t.crew).forEach(function (k) { crew += n(t.crew[k].pay); });
        var proj = c.key === 'crew' ? (crew || null) : (rec.projected == null || rec.projected === '' ? null : n(rec.projected));
        var paid = n(rec.paid) + (paidIn[c.key] || 0);
        var eff = proj == null ? paid : Math.max(proj, paid);
        lines[c.key] = paid; fixed += eff;
      });
      var commProj = 0;
      G.commissionLines(t.commission).forEach(function (line) {
        var r = t.commission[line.key] || {};
        if (r.mode !== 'pct') { commProj += n(r.value); return; }
        var base = r.base;
        var basis = 0;
        G.INCOME_FIELDS.forEach(function (f) {
          var on = base ? !!base[f.key] : (line.basis === 'guarantee' ? f.key === 'guarantee' : true);
          if (on) basis += incomeBy[f.key];
        });
        commProj += n(r.value) / 100 * basis;
      });
      var comm = Math.max(commProj, paidIn.commission || 0);
      var dbd = paidIn.dayByDay || 0;
      Object.keys(t.extras).forEach(function (k) { if (inDay(t.extras[k].date)) dbd += n(t.extras[k].amount); });
      var out = fixed + comm + loans + dbd;
      return { income: income, out: out, net: income - out, lines: lines, commission: comm, debt: loans, dayByDay: dbd };
    }

    function close(a, b, what) {
      if (Math.abs(a - b) > 0.005) throw new Error(what + ': Greenroom ' + a + ' vs check ' + b);
    }
    function compare(t, upTo, label) {
      var c = G.calc(t, upTo ? { upTo: upTo } : {});
      var o = oracle(t, upTo);
      close(c.income, o.income, label + ' income');
      close(c.out, o.out, label + ' out');
      close(c.net, o.net, label + ' net');
      close(c.commission, o.commission, label + ' commission');
      close(c.debt, o.debt, label + ' debts');
      close(c.dayByDay, o.dayByDay, label + ' day by day');
      c.lines.forEach(function (l) { if (l.key !== 'commission') close(l.paid, o.lines[l.key], label + ' ' + l.label + ' paid'); });
    }

    test('money checked twice: 400 random tours, today and every day of the chart', function () {
      for (var i = 0; i < 400; i++) {
        var t = makeTour();
        compare(t, null, 'tour ' + i);
        for (var d = -2; d < 13; d += 3) compare(t, day(d), 'tour ' + i + ' on ' + day(d));
      }
    });

    test('money checked twice: the balance chart ends where the total does', function () {
      for (var i = 0; i < 60; i++) {
        var t = makeTour();
        var s = G.balanceSeries(t);
        if (!s.length) continue;
        var all = G.calc(t);
        var last = s[s.length - 1];
        // The last day of the chart has everything dated; undated charges only count in the total.
        var undated = Object.keys(t.charges).some(function (k) { return !t.charges[k].date && !t.charges[k].accounted && t.charges[k].category; });
        if (!undated) close(last.net, all.net, 'tour ' + i + ' chart end');
      }
    });

    test('money checked twice: a card payment never changes the tour’s spending', function () {
      for (var i = 0; i < 60; i++) {
        var t = makeTour();
        if (!t.debts.d3) continue;
        var before = G.calc(t).out;
        t.debts.d3.payments = { big: { date: day(11), amount: 99999 } };
        close(G.calc(t).out, before, 'tour ' + i + ' out after a payment');
        eq(G.cardSummary(t.debts.d3, t).owed, 0, 'tour ' + i + ' paid off');
      }
    });
  })();

  /* ---- Other income: royalties, advances and payouts on the book itself
     (tour.otherIncome), catalogued from bank deposits. ---- */
  (function () {
    var tour = {
      shows: keyed([{ id: 's1', date: '2026-05-10', city: 'Austin', loggedAt: 1,
        income: { guarantee: 1000, merch: 0 }, guaranteeReceived: true }]),
      otherIncome: {
        dRoy: { date: '2026-05-12', amount: 500, kind: 'royalties', at: 1 },
        dAdv: { date: '2026-05-20', amount: 2000, kind: 'advance', at: 2 },
        dBad: null
      },
      expenses: {},
      commission: { management: { mode: 'pct', value: 10 } }
    };
    test('other income counts in the tour income and net', function () {
      var c = G.calc(tour);
      eq(c.showIncome, 1000, 'show income alone');
      eq(c.otherIncome, 2500, 'other income total');
      eq(c.income, 3500, 'income carries both');
      eq(c.otherRows.length, 2, 'a null entry is no row');
      eq(c.otherRows[0].kind, 'royalties', 'rows sorted by date');
    });
    test('commission stays figured on the shows money alone', function () {
      var c = G.calc(tour);
      near(c.commissionProjected, 100, 'management 10% of 1000, not 3500');
      near(c.net, 3500 - c.out, 'net still income less out');
      // The report's path: a rule with no base falls back to the income
      // argument, which must be the shows' money, never income + other.
      near(G.commissionLine({ key: 'management', label: 'Management', basis: 'income' },
        { mode: 'pct', value: 10 }, c.showIncome, c.guarantees), 100, 'fallback basis is show income');
    });
    test('upTo keeps the chart honest about other income dates', function () {
      eq(G.calc(tour, { upTo: '2026-05-15' }).otherIncome, 500, 'only what landed by then');
      eq(G.calc(tour, { upTo: '2026-05-09' }).income, 0, 'nothing before the night');
    });
    test('balance series walks other income days', function () {
      var series = G.balanceSeries(tour);
      eq(series[series.length - 1].date >= '2026-05-20', true, 'series reaches the advance');
      var may12 = series.filter(function (p) { return p.date === '2026-05-12'; })[0];
      near(may12.income, 1500, 'royalties in by May 12');
    });
    test('closeout carries other income', function () {
      var csv = G.closeoutCSVs(tour)['shows.csv'];
      eq(csv.indexOf('Other income') >= 0, true, 'line present');
      eq(csv.indexOf('Royalties') >= 0, true, 'kind named');
    });
    test('other income kind labels', function () {
      eq(G.otherKindLabel('advance'), 'Advance', 'known kind');
      eq(G.otherKindLabel('mystery'), 'Income', 'unknown kind says Income');
    });
  })();

  /* ---- Road-milestone badges (tour history, setlist.fm). ---- */
  test('road badges land on the right rung', function () {
    eq(G.historyTier(0), null, 'nothing yet');
    eq(G.historyTier(49), null, 'under the first rung');
    eq(G.historyTier(50).label, 'Bronze', 'a real touring act');
    eq(G.historyTier(290).label, 'Silver', 'Michael Jackson solo');
    eq(G.historyTier(736).label, 'Gold', 'I See Stars today');
    eq(G.historyTier(1400).label, 'Diamond', 'The Beatles, lifetime');
    eq(G.historyTier(2300).label, 'Legacy', 'the Grateful Dead');
  });

  globalThis.GR_TESTS = { run: function () { return results; }, results: results };
})();
