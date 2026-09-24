/* Greenroom core: pure logic. No DOM, no storage. Loaded as a classic script
   so the app and the test page can both use it. */
(function (root) {
  'use strict';

  /* ---------------- Categories ---------------- */

  // Commission is last-but-one by convention in the spec's list, but it is the
  // odd one out: its projection is computed from the three commission lines
  // rather than typed in, so it never gets a projected/paid pair of its own.
  var CATEGORIES = [
    { key: 'bus', label: 'Bus' },
    { key: 'crew', label: 'Crew' },
    { key: 'gas', label: 'Gas' },
    { key: 'hotels', label: 'Hotels' },
    { key: 'flights', label: 'Flights' },
    { key: 'production', label: 'Production' },
    // What the merch cost to make. Usually an advance that has to be earned back,
    // which is why it sits here as a cost rather than against merch income.
    { key: 'merch', label: 'Merch bill', note: 'Printing, plus any merch advance you have to pay back.' },
    { key: 'commission', label: 'Commission' },
    { key: 'misc', label: 'Misc' }
  ];
  var TYPED_CATEGORIES = CATEGORIES.filter(function (c) { return c.key !== 'commission'; });

  var COMMISSION_LINES = [
    { key: 'management', label: 'Management', basis: 'income' },
    { key: 'agent', label: 'Booking agent', basis: 'guarantee' },
    { key: 'lawyer', label: 'Lawyer', basis: 'income' }
  ];

  var INCOME_FIELDS = [
    { key: 'guarantee', label: 'Guarantee' },
    { key: 'merch', label: 'Merch' },
    { key: 'vip', label: 'VIPs' },
    { key: 'buyouts', label: 'Buyouts' },
    { key: 'catering', label: 'Catering budget' },
    { key: 'misc', label: 'Misc' }
  ];

  var CREW_TITLES = ['Tour manager', 'FOH engineer', 'Monitor engineer', 'Lighting director',
    'Guitar tech', 'Drum tech', 'Merch manager', 'Driver'];
  var DEBT_CHIPS = ['Credit card', 'Loan', 'Gear payment'];
  var DAILY_CHIPS = ['Food', 'Parking', 'Tolls', 'Repairs', 'Laundry', 'Gear'];

  // Charges can also land on the day-by-day pile, which is not an expense category.
  var DAY_BY_DAY = 'dayByDay';
  var CHARGE_CATEGORIES = CATEGORIES.concat([{ key: DAY_BY_DAY, label: 'Day by day' }]);

  /* ---------------- Numbers ---------------- */

  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (v == null) return 0;
    var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : 0;
  }

  // Blank is meaningfully different from zero: a category with no projection
  // just totals its charges instead of being held to a number.
  function optNum(v) {
    if (v == null || v === '') return null;
    var n = num(v);
    return isFinite(n) ? n : null;
  }

  var round = function (n) { return Math.round(n); };
  var NF = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

  function money(n, sign) {
    var r = round(num(n));
    var s = '$' + NF.format(Math.abs(r));
    if (r < 0) return '-' + s;
    return sign && r > 0 ? '+' + s : s;
  }

  var NF2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Card charges are small enough that the cents matter when checking a statement.
  function moneyCents(n) {
    var v = num(n);
    return (v < 0 ? '-' : '') + '$' + NF2.format(Math.abs(v));
  }

  /* ---------------- Dates ---------------- */

  var ROLLOVER_HOURS = 5; // a tour day runs to 5am, so settling up after midnight counts for that night

  function pad(n) { return String(n).length < 2 ? '0' + n : String(n); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  function parseDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return ymd(d) === s ? d : null;
  }

  function tourToday(now) {
    var t = (now == null ? Date.now() : now) - ROLLOVER_HOURS * 3600e3;
    return ymd(new Date(t));
  }

  function addDays(s, n) {
    var d = parseDay(s) || new Date();
    d.setDate(d.getDate() + n);
    return ymd(d);
  }

  function daysBetween(a, b) {
    var da = parseDay(a), db = parseDay(b);
    if (!da || !db) return 0;
    return Math.round((db - da) / 86400e3);
  }

  /* ---------------- Shapes ---------------- */

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  // Rows live as id-keyed maps so two people editing different rows never collide.
  function rows(map) {
    if (!isObj(map)) return [];
    return Object.keys(map).reduce(function (out, id) {
      if (isObj(map[id])) out.push(Object.assign({ id: id }, map[id]));
      return out;
    }, []);
  }

  function byDate(a, b) {
    return String(a.date || '').localeCompare(String(b.date || '')) ||
      (a.createdAt || 0) - (b.createdAt || 0);
  }

  function emptyExpenses() {
    var o = {};
    TYPED_CATEGORIES.forEach(function (c) { o[c.key] = { projected: null, paid: 0 }; });
    return o;
  }

  function emptyCommission() {
    var o = {};
    COMMISSION_LINES.forEach(function (c) { o[c.key] = { mode: 'flat', value: 0 }; });
    return o;
  }

  function emptyIncome() {
    var o = {};
    INCOME_FIELDS.forEach(function (f) { o[f.key] = 0; });
    return o;
  }

  function normExpenses(e) {
    var out = emptyExpenses();
    var src = isObj(e) ? e : {};
    Object.keys(out).forEach(function (k) {
      var r = isObj(src[k]) ? src[k] : {};
      out[k] = { projected: optNum(r.projected), paid: num(r.paid) };
    });
    return out;
  }

  function normCommission(c) {
    var out = emptyCommission();
    var src = isObj(c) ? c : {};
    COMMISSION_LINES.forEach(function (line) {
      var r = isObj(src[line.key]) ? src[line.key] : {};
      out[line.key] = { mode: r.mode === 'pct' ? 'pct' : 'flat', value: num(r.value) };
    });
    return out;
  }

  function showIncomeTotal(show) {
    var inc = show && isObj(show.income) ? show.income : {};
    return INCOME_FIELDS.reduce(function (t, f) { return t + num(inc[f.key]); }, 0);
  }

  function crewProjection(tour) {
    return rows(tour && tour.crew).reduce(function (t, p) { return t + num(p.pay); }, 0);
  }

  /* ---------------- Commission ---------------- */

  function commissionLine(line, rule, income, guarantees) {
    if (rule.mode !== 'pct') return num(rule.value);
    var basis = line.basis === 'guarantee' ? guarantees : income;
    return (num(rule.value) / 100) * basis;
  }

  function commissionTotal(commission, income, guarantees) {
    var c = normCommission(commission);
    return COMMISSION_LINES.reduce(function (t, line) {
      return t + commissionLine(line, c[line.key], income, guarantees);
    }, 0);
  }

  /* ---------------- The big number ---------------- */

  // `upTo` limits shows, day-by-day costs and card charges to that date or
  // earlier, which is how the balance chart walks the tour day by day.
  // Projections are committed from day one, so the curve starts deep in the red.
  function calc(tour, opts) {
    var o = opts || {};
    var upTo = o.upTo || null;
    var override = o.override || null;

    var allShows = rows(tour && tour.shows).map(function (s) {
      if (override && override.showId === s.id) return Object.assign({}, s, { income: override.income });
      return s;
    }).sort(byDate);

    var shows = upTo ? allShows.filter(function (s) { return s.date && s.date <= upTo; }) : allShows;

    var income = 0, guarantees = 0;
    shows.forEach(function (s) {
      income += showIncomeTotal(s);
      guarantees += num(isObj(s.income) ? s.income.guarantee : 0);
    });

    var charges = rows(tour && tour.charges).filter(function (ch) {
      return !upTo || (ch.date && ch.date <= upTo);
    });
    var chargedTo = {};
    charges.forEach(function (ch) {
      var k = ch.category || null;
      if (!k) return;
      chargedTo[k] = (chargedTo[k] || 0) + num(ch.amount);
    });

    var expenses = normExpenses(tour && tour.expenses);
    var lines = [];
    var fixed = 0;

    TYPED_CATEGORIES.forEach(function (c) {
      var rec = expenses[c.key];
      // Crew's projection is the sum of what the crew is owed, not a typed number.
      var projected = c.key === 'crew' ? crewProjection(tour) || null : rec.projected;
      var paid = num(rec.paid) + (chargedTo[c.key] || 0);
      var effective = projected == null ? paid : Math.max(projected, paid);
      fixed += effective;
      lines.push({
        key: c.key, label: c.label, projected: projected, paid: paid, effective: effective,
        left: projected == null ? null : Math.max(0, projected - paid),
        over: projected == null ? 0 : Math.max(0, paid - projected)
      });
    });

    var commissionProjected = commissionTotal(tour && tour.commission, income, guarantees);
    var commissionPaid = chargedTo.commission || 0;
    var commissionEffective = Math.max(commissionProjected, commissionPaid);
    lines.push({
      key: 'commission', label: 'Commission',
      projected: commissionProjected, paid: commissionPaid, effective: commissionEffective,
      left: Math.max(0, commissionProjected - commissionPaid),
      over: Math.max(0, commissionPaid - commissionProjected)
    });

    var debt = rows(tour && tour.debts).reduce(function (t, d) { return t + num(d.amount); }, 0);

    var extras = rows(tour && tour.extras).filter(function (x) {
      return !upTo || (x.date && x.date <= upTo);
    });
    var dayByDay = extras.reduce(function (t, x) { return t + num(x.amount); }, 0) +
      (chargedTo[DAY_BY_DAY] || 0);

    var out = fixed + commissionEffective + debt + dayByDay;

    return {
      shows: shows, allShows: allShows, income: income, guarantees: guarantees,
      lines: lines, fixed: fixed,
      commission: commissionEffective, commissionProjected: commissionProjected,
      debt: debt, dayByDay: dayByDay, out: out, net: income - out,
      coverage: out > 0 ? income / out : (income > 0 ? 1 : 0)
    };
  }

  function stateOf(c) {
    if (c.out === 0 && c.income === 0) return 'idle';
    return round(c.net) < 0 ? 'red' : 'green';
  }

  function caption(c) {
    var st = stateOf(c);
    if (st === 'idle') return 'Add what the tour costs to start';
    if (st === 'red') return 'to break even';
    return round(c.net) > 0 ? 'in the green' : 'right at break even';
  }

  /* ---------------- Balance by day (the chart) ---------------- */

  function balanceSeries(tour) {
    var c = calc(tour);
    var dated = c.allShows.filter(function (s) { return parseDay(s.date); });
    var extras = rows(tour && tour.extras).filter(function (x) { return parseDay(x.date); });
    var charges = rows(tour && tour.charges).filter(function (x) { return parseDay(x.date); });

    var days = dated.map(function (s) { return s.date; })
      .concat(extras.map(function (x) { return x.date; }))
      .concat(charges.map(function (x) { return x.date; }));
    if (!days.length) return [];

    days.sort();
    var start = days[0], end = days[days.length - 1];
    var span = daysBetween(start, end);
    if (span < 0) return [];
    // One day of activity would be a single point and no line at all. Start the
    // day before instead: that point is the tour fully in the red with nothing
    // earned yet, which is exactly the climb worth seeing.
    if (span === 0) { start = addDays(start, -1); span = 1; }

    var series = [];
    for (var i = 0; i <= span; i++) {
      var day = addDays(start, i);
      var snap = calc(tour, { upTo: day });
      series.push({ date: day, net: snap.net, income: snap.income, out: snap.out });
    }
    return series;
  }

  /* ---------------- The change chip ---------------- */

  // What the most recent thing that happened did to the number, net of commission.
  function latestChange(tour) {
    var events = [];
    rows(tour && tour.shows).forEach(function (s) {
      if (s.loggedAt && showIncomeTotal(s) !== 0) {
        events.push({ at: s.loggedAt, kind: 'show', showId: s.id, label: s.city || 'Show' });
      }
    });
    rows(tour && tour.extras).forEach(function (x) {
      if (x.createdAt) events.push({ at: x.createdAt, kind: 'extra', id: x.id, label: x.label || 'Cost' });
    });
    rows(tour && tour.imports).forEach(function (im) {
      if (im.createdAt) events.push({ at: im.createdAt, kind: 'import', id: im.id, label: 'card charges' });
    });
    if (!events.length) return null;

    events.sort(function (a, b) { return a.at - b.at; });
    var last = events[events.length - 1];

    var after = calc(tour).net;
    var without = calc(stripEvent(tour, last)).net;
    var delta = after - without;
    if (round(delta) === 0) return null;
    return { delta: delta, label: last.label, kind: last.kind };
  }

  function stripEvent(tour, ev) {
    var t = JSON.parse(JSON.stringify(tour || {}));
    if (ev.kind === 'show' && t.shows && t.shows[ev.showId]) {
      t.shows[ev.showId] = Object.assign({}, t.shows[ev.showId], { income: emptyIncome(), loggedAt: null });
    } else if (ev.kind === 'extra' && t.extras) {
      delete t.extras[ev.id];
    } else if (ev.kind === 'import' && t.charges) {
      Object.keys(t.charges).forEach(function (cid) {
        if (t.charges[cid] && t.charges[cid].importId === ev.id) delete t.charges[cid];
      });
    }
    return t;
  }

  /* ---------------- Daily update text ---------------- */

  function dailyUpdate(tour, now) {
    var today = tourToday(now);
    var c = calc(tour);
    var shows = c.allShows;
    var tonight = shows.filter(function (s) { return s.date === today; })[0] || null;
    var next = shows.filter(function (s) { return s.date > today; })[0] || null;

    var fmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    var dayName = function (d) { var p = parseDay(d); return p ? fmt.format(p) : d; };

    var lines = [(tour.name || 'Tour') + ' — ' + dayName(today)];
    if (tonight) {
      lines.push(tonight.loggedAt
        ? 'Tonight: ' + (tonight.city || 'Show') + ', ' + money(showIncomeTotal(tonight)) + ' in'
        : 'Tonight: ' + (tonight.city || 'Show') + ' (income not logged yet)');
    }
    var todayCosts = rows(tour && tour.extras).filter(function (x) { return x.date === today; })
      .reduce(function (t, x) { return t + num(x.amount); }, 0);
    if (todayCosts > 0) lines.push("Today's costs: " + money(todayCosts));

    var r = round(c.net);
    lines.push(r < 0 ? 'Balance: ' + money(-r) + ' in the red'
      : r > 0 ? 'Balance: ' + money(r) + ' in the green' : 'Balance: right at break even');
    if (c.out > 0) {
      lines.push(money(c.income) + ' in, ' + money(c.out) + ' out — ' +
        Math.floor(c.coverage * 100) + '% of costs covered');
    }
    if (shows.length) {
      var logged = shows.filter(function (s) { return s.loggedAt; }).length;
      lines.push(logged + ' of ' + shows.length + ' show' + (shows.length === 1 ? '' : 's') + ' logged');
    }
    if (next) lines.push('Next: ' + dayName(next.date) + ', ' + (next.city || 'TBA'));
    return lines.join('\n');
  }

  /* ---------------- Export ---------------- */

  root.GR = {
    CATEGORIES: CATEGORIES,
    TYPED_CATEGORIES: TYPED_CATEGORIES,
    COMMISSION_LINES: COMMISSION_LINES,
    INCOME_FIELDS: INCOME_FIELDS,
    CHARGE_CATEGORIES: CHARGE_CATEGORIES,
    CREW_TITLES: CREW_TITLES,
    DEBT_CHIPS: DEBT_CHIPS,
    DAILY_CHIPS: DAILY_CHIPS,
    DAY_BY_DAY: DAY_BY_DAY,
    ROLLOVER_HOURS: ROLLOVER_HOURS,

    num: num, optNum: optNum, money: money, moneyCents: moneyCents, round: round,
    pad: pad, ymd: ymd, parseDay: parseDay, tourToday: tourToday,
    addDays: addDays, daysBetween: daysBetween,
    isObj: isObj, rows: rows, byDate: byDate,

    emptyExpenses: emptyExpenses, emptyCommission: emptyCommission, emptyIncome: emptyIncome,
    normExpenses: normExpenses, normCommission: normCommission,
    showIncomeTotal: showIncomeTotal, crewProjection: crewProjection,
    commissionLine: commissionLine, commissionTotal: commissionTotal,

    calc: calc, stateOf: stateOf, caption: caption,
    balanceSeries: balanceSeries, latestChange: latestChange,
    dailyUpdate: dailyUpdate
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
