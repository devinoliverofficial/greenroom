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

  /* ============ Day sheets ============ */

  test('the day sheet prints only what was filled in, in run order', function () {
    var lines = G.daySheetLines({
      daySheet: {
        loadIn: '2:00 PM',
        soundchecks: [{ band: 'In This Moment', time: '4:00 PM' }, { band: 'Support', time: '5:00 PM' }],
        doors: '7:00 PM',
        setTimes: [{ band: 'Support', time: '8:00 PM' }, { band: 'In This Moment', time: '9:15 PM' }],
        busCall: '11:45 PM',
        wifi: 'Venue5G / password stagepass',
        greenrooms: 'yes', showers: 'no',
        driveNext: '4h 20m — 285 mi'
      }
    });
    eq(lines[0], 'Load in: 2:00 PM', 'load in first');
    eq(lines[1], 'Soundcheck — In This Moment: 4:00 PM', 'soundcheck per band');
    eq(lines[3], 'Doors: 7:00 PM', 'doors');
    eq(lines[4], 'Support: 8:00 PM', 'set times in order');
    eq(lines.indexOf('Bus call: 11:45 PM') >= 0, true, 'bus call');
    eq(lines.indexOf('Greenrooms yes · no showers') >= 0, true, 'amenities in one line');
    eq(lines[lines.length - 1], 'Drive to next venue: 4h 20m — 285 mi', 'drive last');
    // nothing that wasn't filled in
    eq(lines.join('\n').indexOf('VIP'), -1, 'no empty VIP line');
    eq(lines.join('\n').indexOf('Lobby'), -1, 'no empty lobby line');
  });

  test('an empty day sheet prints nothing at all', function () {
    eq(G.daySheetLines({ daySheet: {} }).length, 0, 'no lines');
    eq(G.daySheetLines({}).length, 0, 'no sheet');
  });

  test('the copy text leads with the city, venue and date', function () {
    var text = G.daySheetText({
      date: '2026-05-01', city: 'Detroit, MI', venue: 'The Fillmore',
      daySheet: { doors: '7:00 PM' }
    });
    eq(text.split('\n')[0], 'Detroit, MI — The Fillmore · Fri, May 1', 'header');
    eq(text.split('\n')[1], 'Doors: 7:00 PM', 'body');
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

  globalThis.GR_TESTS = { run: function () { return results; }, results: results };
})();
