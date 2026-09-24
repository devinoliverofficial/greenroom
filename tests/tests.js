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

  globalThis.GR_TESTS = { run: function () { return results; }, results: results };
})();
