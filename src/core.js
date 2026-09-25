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
    // Overage, points, a door split — whatever the deal pays past the guarantee.
    { key: 'backend', label: 'Back end' },
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
    COMMISSION_LINES.forEach(function (c) {
      o[c.key] = { mode: 'flat', value: 0, base: defaultCommissionBase(c) };
    });
    return o;
  }

  // Which income streams a deal's percentage comes out of, by default:
  // booking agents commission guarantees only; everyone else, everything.
  function defaultCommissionBase(line) {
    var b = {};
    INCOME_FIELDS.forEach(function (f) {
      b[f.key] = line.basis === 'guarantee' ? f.key === 'guarantee' : true;
    });
    return b;
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
      var base = defaultCommissionBase(line);
      if (isObj(r.base)) INCOME_FIELDS.forEach(function (f) { base[f.key] = !!r.base[f.key]; });
      out[line.key] = { mode: r.mode === 'pct' ? 'pct' : 'flat', value: num(r.value), base: base };
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

  // The checked streams' total for one deal, or null when the rule carries no
  // base (old data before checkboxes) or the caller has no per-stream sums.
  function commissionBase(rule, incomeBy) {
    var b = isObj(rule) && isObj(rule.base) ? rule.base : null;
    if (!b || !isObj(incomeBy)) return null;
    return INCOME_FIELDS.reduce(function (t, f) {
      return t + (b[f.key] ? num(incomeBy[f.key]) : 0);
    }, 0);
  }

  function commissionBaseLabel(rule) {
    var b = isObj(rule) && isObj(rule.base) ? rule.base : {};
    var on = INCOME_FIELDS.filter(function (f) { return b[f.key]; });
    if (!on.length) return 'nothing yet';
    if (on.length === INCOME_FIELDS.length) return 'all income';
    return on.map(function (f) {
      return f.key === 'guarantee' ? 'guarantees' : f.label.toLowerCase();
    }).join(' + ');
  }

  function commissionLine(line, rule, income, guarantees, incomeBy) {
    if (rule.mode !== 'pct') return num(rule.value);
    var basis = commissionBase(rule, incomeBy);
    if (basis == null) basis = line.basis === 'guarantee' ? guarantees : income;
    return (num(rule.value) / 100) * basis;
  }

  function commissionTotal(commission, income, guarantees, incomeBy) {
    var c = normCommission(commission);
    return COMMISSION_LINES.reduce(function (t, line) {
      return t + commissionLine(line, c[line.key], income, guarantees, incomeBy);
    }, 0);
  }

  /* ---------------- The big number ---------------- */

  /* ---------------- Cards carried into the tour ---------------- */

  // A card's opening balance is pre-tour spending. It never sits in the debt
  // pile: every dollar of it lands in exactly one category as already-paid
  // money (the breakdown decides where; whatever isn't broken down goes to
  // Misc), and max(projected, paid) then counts each dollar once.
  function cardDebts(tour) {
    return rows(tour && tour.debts).filter(function (d) { return d.kind === 'card'; });
  }
  function otherDebts(tour) {
    return rows(tour && tour.debts).filter(function (d) { return d.kind !== 'card'; });
  }
  function cardSummary(card) {
    var bd = isObj(card.breakdown) ? card.breakdown : {};
    var accounted = 0;
    TYPED_CATEGORIES.forEach(function (c) { accounted += num(bd[c.key]); });
    var balance = num(card.amount);
    return {
      id: card.id, label: card.label || 'Card', balance: balance,
      accounted: Math.min(accounted, balance),
      remainder: Math.max(0, balance - accounted),
      over: Math.max(0, accounted - balance)
    };
  }
  // What each category was paid on cards going in: { key: [{label, amount}] }
  function cardPaidDetail(tour) {
    var out = {};
    cardDebts(tour).forEach(function (card) {
      var s = cardSummary(card);
      var bd = isObj(card.breakdown) ? card.breakdown : {};
      TYPED_CATEGORIES.forEach(function (c) {
        var v = num(bd[c.key]);
        if (v > 0) (out[c.key] = out[c.key] || []).push({ label: s.label, amount: v });
      });
      if (s.remainder > 0) {
        (out.misc = out.misc || []).push({ label: s.label, amount: s.remainder, leftover: true });
      }
    });
    return out;
  }
  // The last day whose charges are assumed inside the opening balances.
  function preTourCutoff(tour) {
    var cards = cardDebts(tour);
    if (!cards.length) return null;
    var shows = rows(tour && tour.shows).filter(function (s) { return parseDay(s.date); })
      .map(function (s) { return s.date; }).sort();
    var start = shows.length ? shows[0] : null;
    var best = null;
    cards.forEach(function (c) {
      var cut = parseDay(c.cutoff) ? c.cutoff : start;
      if (cut && (!best || cut > best)) best = cut;
    });
    return best;
  }

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
    var incomeBy = {};
    INCOME_FIELDS.forEach(function (f) { incomeBy[f.key] = 0; });
    shows.forEach(function (s) {
      var inc = isObj(s.income) ? s.income : {};
      INCOME_FIELDS.forEach(function (f) { incomeBy[f.key] += num(inc[f.key]); });
    });
    income = INCOME_FIELDS.reduce(function (t, f) { return t + incomeBy[f.key]; }, 0);
    guarantees = incomeBy.guarantee;

    var charges = rows(tour && tour.charges).filter(function (ch) {
      return !upTo || (ch.date && ch.date <= upTo);
    });
    var chargedTo = {};
    charges.forEach(function (ch) {
      var k = ch.category || null;
      if (!k) return;
      chargedTo[k] = (chargedTo[k] || 0) + num(ch.amount);
    });

    // Pre-tour card money lands here as already-paid, category by category.
    var cardDetail = cardPaidDetail(tour);
    var cardTo = {};
    Object.keys(cardDetail).forEach(function (k) {
      cardTo[k] = cardDetail[k].reduce(function (t, r) { return t + r.amount; }, 0);
    });

    var expenses = normExpenses(tour && tour.expenses);
    var lines = [];
    var fixed = 0;

    TYPED_CATEGORIES.forEach(function (c) {
      var rec = expenses[c.key];
      // Crew's projection is the sum of what the crew is owed, not a typed number.
      var projected = c.key === 'crew' ? crewProjection(tour) || null : rec.projected;
      var paid = num(rec.paid) + (chargedTo[c.key] || 0) + (cardTo[c.key] || 0);
      var effective = projected == null ? paid : Math.max(projected, paid);
      fixed += effective;
      lines.push({
        key: c.key, label: c.label, projected: projected, paid: paid, effective: effective,
        cards: cardDetail[c.key] || [],
        left: projected == null ? null : Math.max(0, projected - paid),
        over: projected == null ? 0 : Math.max(0, paid - projected)
      });
    });

    var commissionProjected = commissionTotal(tour && tour.commission, income, guarantees, incomeBy);
    var commissionPaid = chargedTo.commission || 0;
    var commissionEffective = Math.max(commissionProjected, commissionPaid);
    lines.push({
      key: 'commission', label: 'Commission',
      projected: commissionProjected, paid: commissionPaid, effective: commissionEffective,
      left: Math.max(0, commissionProjected - commissionPaid),
      over: Math.max(0, commissionPaid - commissionProjected)
    });

    // Only loans and gear payments live here: a card's balance already counts
    // once through the categories above.
    var debt = otherDebts(tour).reduce(function (t, d) { return t + num(d.amount); }, 0);

    var extras = rows(tour && tour.extras).filter(function (x) {
      return !upTo || (x.date && x.date <= upTo);
    });
    var dayByDay = extras.reduce(function (t, x) { return t + num(x.amount); }, 0) +
      (chargedTo[DAY_BY_DAY] || 0);

    var out = fixed + commissionEffective + debt + dayByDay;

    return {
      shows: shows, allShows: allShows, income: income, guarantees: guarantees, incomeBy: incomeBy,
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

  /* ---------------- Day sheets ---------------- */

  var DS_AMENITIES = [
    ['greenrooms', 'Greenrooms'], ['showers', 'Showers'],
    ['productionOffice', 'Production office'], ['laundry', 'Laundry']
  ];

  function dsList(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(function (r) { return isObj(r) && (String(r.band || '').trim() || String(r.time || '').trim()); });
  }

  // The day sheet as lines of text, ready for the group chat. Only what the
  // tour manager actually filled in — no empty labels, no placeholders.
  function daySheetLines(show) {
    var d = show && isObj(show.daySheet) ? show.daySheet : {};
    var lines = [];
    var put = function (label, v) {
      v = String(v == null ? '' : v).trim();
      if (v) lines.push(label + ': ' + v);
    };
    put('Load in', d.loadIn);
    dsList(d.soundchecks).forEach(function (r) {
      lines.push('Soundcheck — ' + (String(r.band || '').trim() || 'TBA') + ': ' + (String(r.time || '').trim() || 'TBA'));
    });
    put('VIP', d.vip);
    put('Doors', d.doors);
    dsList(d.setTimes).forEach(function (r) {
      lines.push((String(r.band || '').trim() || 'TBA') + ': ' + (String(r.time || '').trim() || 'TBA'));
    });
    put('Lobby call', d.lobbyCall);
    put('Bus call', d.busCall);
    put('Wifi', d.wifi);
    put('Parking', d.parking);
    var amen = [];
    DS_AMENITIES.forEach(function (a) {
      var v = d[a[0]];
      if (v === 'yes') amen.push(a[1] + ' yes');
      else if (v === 'no') amen.push('no ' + a[1].toLowerCase());
    });
    if (amen.length) lines.push(amen.join(' · '));
    put('Drive to next venue', d.driveNext);
    put('Notes', d.notes);
    return lines;
  }

  function daySheetText(show) {
    var head = [];
    if (show) {
      var city = String(show.city || '').trim();
      var venue = String(show.venue || '').trim();
      head.push([city, venue].filter(Boolean).join(' — ') || 'Day sheet');
      if (parseDay(show.date)) {
        head[0] = head[0] + ' · ' + new Intl.DateTimeFormat('en-US',
          { weekday: 'short', month: 'short', day: 'numeric' }).format(parseDay(show.date));
      }
    }
    return head.concat(daySheetLines(show)).join('\n');
  }

  /* ---------------- Reuse across tours ---------------- */

  // A tour's budget, stripped to what carries forward: projections and the
  // commission deal. Never money already paid, never charges, never debts.
  function budgetFrom(tour) {
    var exp = normExpenses(tour && tour.expenses);
    var out = {};
    var total = 0;
    TYPED_CATEGORIES.forEach(function (c) {
      var projected = c.key === 'crew' ? null : exp[c.key].projected;
      out[c.key] = { projected: projected, paid: 0 };
      if (projected != null) total += projected;
    });
    var comm = normCommission(tour && tour.commission);
    var commBits = [];
    COMMISSION_LINES.forEach(function (line) {
      var r = comm[line.key];
      if (r.mode === 'pct' && r.value > 0) commBits.push(line.label + ' ' + r.value + '%');
      else if (r.mode === 'flat' && r.value > 0) commBits.push(line.label + ' ' + money(r.value));
    });
    return { expenses: out, commission: comm, total: total, commissionSummary: commBits.join(' · ') };
  }

  function hasBudget(tour) {
    var b = budgetFrom(tour);
    return b.total > 0 || !!b.commissionSummary;
  }

  // The key a saved crew member files under, shared across every tour.
  function crewKey(name) {
    return 'crew:' + String(name == null ? '' : name).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /* ---------------- Guest list ---------------- */

  var GUEST_PASSES = ['GA', 'VIP', 'All Access', 'Photo Pass'];

  function guestSummary(list) {
    var names = 0, tickets = 0;
    (list || []).forEach(function (g) {
      if (!isObj(g)) return;
      names += 1;
      tickets += Math.max(1, Math.min(20, num(g.qty) || 1));
    });
    return { names: names, tickets: tickets };
  }

  // The list the way the box office wants it: "Last, First x2 — VIP".
  function guestListText(show, list) {
    var head = [];
    if (show) {
      var city = String(show.city || '').trim();
      var venue = String(show.venue || '').trim();
      var top = 'Guest list — ' + ([city, venue].filter(Boolean).join(', ') || 'show');
      if (parseDay(show.date)) {
        top += ' · ' + new Intl.DateTimeFormat('en-US',
          { weekday: 'short', month: 'short', day: 'numeric' }).format(parseDay(show.date));
      }
      head.push(top);
    }
    var rows = (list || []).filter(isObj).slice().sort(function (a, b) {
      return String(a.lastName || '').localeCompare(String(b.lastName || '')) ||
        String(a.firstName || '').localeCompare(String(b.firstName || ''));
    }).map(function (g) {
      var name = [String(g.lastName || '').trim(), String(g.firstName || '').trim()]
        .filter(Boolean).join(', ') || 'Guest';
      var qty = Math.max(1, Math.min(20, num(g.qty) || 1));
      var line = name + ' x' + qty;
      if (g.passType) line += ' — ' + g.passType;
      if (String(g.affiliation || '').trim()) line += ' (' + String(g.affiliation).trim() + ')';
      return line;
    });
    var sum = guestSummary(list);
    if (rows.length) rows.push(sum.names + (sum.names === 1 ? ' name' : ' names') + ' · ' + sum.tickets + (sum.tickets === 1 ? ' ticket' : ' tickets'));
    return head.concat(rows).join('\n');
  }

  /* ---------------- Tour software imports (Master Tour etc.) ---------------- */

  function cleanStr(v, cap) { return String(v == null ? '' : v).trim().slice(0, cap || 90); }
  function cleanPairList(v) {
    if (!Array.isArray(v)) return [];
    return v.slice(0, 12).map(function (r) {
      return isObj(r) ? { band: cleanStr(r.band, 60), time: cleanStr(r.time, 20) } : null;
    }).filter(function (r) { return r && (r.band || r.time); });
  }
  function cleanYesNo(v) {
    var t = String(v == null ? '' : v).toLowerCase();
    return t === 'yes' ? 'yes' : t === 'no' ? 'no' : '';
  }

  // What the reader pulls out of a Master Tour day sheet or itinerary export:
  // one entry per date, only real fields, nothing invented.
  function normalizeTourImport(out) {
    var src = isObj(out) ? out : {};
    var raw = Array.isArray(src.days) ? src.days : (Array.isArray(out) ? out : []);
    var days = [];
    raw.slice(0, 90).forEach(function (r) {
      if (!isObj(r)) return;
      var date = cleanStr(r.date, 10);
      if (!parseDay(date)) return;
      var sheet = {
        loadIn: cleanStr(r.loadIn, 40), vip: cleanStr(r.vip, 90), doors: cleanStr(r.doors, 40),
        lobbyCall: cleanStr(r.lobbyCall, 40), busCall: cleanStr(r.busCall, 40),
        wifi: cleanStr(r.wifi, 90), parking: cleanStr(r.parking, 160),
        driveNext: cleanStr(r.driveNext, 60), notes: cleanStr(r.notes, 200),
        soundchecks: cleanPairList(r.soundchecks), setTimes: cleanPairList(r.setTimes)
      };
      DS_AMENITIES.forEach(function (a) { sheet[a[0]] = cleanYesNo(r[a[0]]); });
      var any = daySheetLines({ daySheet: sheet }).length > 0;
      if (!any) return;
      days.push({ date: date, city: cleanStr(r.city, 80), venue: cleanStr(r.venue, 80), sheet: sheet });
    });
    return { days: days, found: days.length };
  }

  // Lay an imported sheet over what's already there: a field the import knows
  // wins; a field it doesn't stays as the tour manager wrote it.
  function mergeDaySheet(existing, incoming) {
    var out = {};
    var ex = isObj(existing) ? existing : {};
    ['loadIn', 'vip', 'doors', 'lobbyCall', 'busCall', 'wifi', 'parking', 'driveNext', 'notes']
      .forEach(function (k) { out[k] = incoming[k] || cleanStr(ex[k], 200); });
    out.soundchecks = incoming.soundchecks.length ? incoming.soundchecks : cleanPairList(ex.soundchecks);
    out.setTimes = incoming.setTimes.length ? incoming.setTimes : cleanPairList(ex.setTimes);
    DS_AMENITIES.forEach(function (a) { out[a[0]] = incoming[a[0]] || cleanYesNo(ex[a[0]]); });
    return out;
  }

  function offDayLines(off) {
    var d = isObj(off) ? off : {};
    var lines = [];
    var put = function (label, v) {
      v = String(v == null ? '' : v).trim();
      if (v) lines.push(label + ': ' + v);
    };
    put('Hotel', d.hotel);
    put('Wifi', d.wifi);
    put('Rooms', d.rooms);
    (Array.isArray(d.plans) ? d.plans : []).forEach(function (r) {
      if (!isObj(r)) return;
      var label = String(r.label || '').trim(), time = String(r.time || '').trim();
      if (label || time) lines.push((time || 'TBA') + ': ' + (label || 'TBA'));
    });
    put('Notes', d.notes);
    return lines;
  }

  function offDayText(date, off) {
    var head = 'OFF DAY';
    var city = String(off && off.city || '').trim();
    if (city) head += ' \u2014 ' + city;
    if (parseDay(date)) {
      head += ' \u00b7 ' + new Intl.DateTimeFormat('en-US',
        { weekday: 'short', month: 'short', day: 'numeric' }).format(parseDay(date));
    }
    return [head].concat(offDayLines(off)).join('\n');
  }

  /* ---------------- Settlement sheets ---------------- */

  // What the reader hands back from a promoter settlement, made safe: only
  // real income fields, only positive numbers, notes as short label/value
  // pairs. Nothing here is saved without the user looking at it first.
  function normalizeSettlement(out) {
    var src = isObj(out) ? out : {};
    var incSrc = isObj(src.income) ? src.income : src;
    var income = {};
    var found = 0;
    INCOME_FIELDS.forEach(function (f) {
      var v = incSrc[f.key];
      if (v == null || v === '') return;
      var n = num(v);
      if (n > 0) { income[f.key] = round(n * 100) / 100; found += 1; }
    });
    var miscLabel = String(incSrc.miscLabel == null ? '' : incSrc.miscLabel).trim().slice(0, 60);

    var notes = [];
    var rawNotes = Array.isArray(src.notes) ? src.notes : [];
    rawNotes.slice(0, 12).forEach(function (n) {
      if (!isObj(n)) return;
      var label = String(n.label == null ? '' : n.label).trim().slice(0, 40);
      var value = String(n.value == null ? '' : n.value).trim().slice(0, 120);
      if (label && value) notes.push({ label: label, value: value });
    });
    return { income: income, miscLabel: miscLabel, notes: notes, found: found };
  }

  /* ---------------- Tour closeout ---------------- */

  function csvCell(v) {
    var t = String(v == null ? '' : v);
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function toCSV(rows) {
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\n') + '\n';
  }

  function settlementNoteText(show) {
    return (Array.isArray(show.settlementNotes) ? show.settlementNotes : [])
      .map(function (n) { return n.label + ': ' + n.value; }).join('; ');
  }

  // The accountant-facing bundle: every number the tour knows, in rows a
  // bookkeeper can import untouched.
  function closeoutCSVs(tour) {
    var c = calc(tour);
    var shows = c.allShows;

    var showRows = [['Date', 'City', 'Venue', 'Sold out'].concat(
      INCOME_FIELDS.map(function (f) { return f.label; }), ['Show total', 'Notes'])];
    shows.forEach(function (s) {
      var inc = isObj(s.income) ? s.income : {};
      showRows.push([s.date || '', s.city || '', s.venue || '', s.soldOut ? 'yes' : ''].concat(
        INCOME_FIELDS.map(function (f) { return num(inc[f.key]) || ''; }),
        [showIncomeTotal(s) || '', settlementNoteText(s)]));
    });

    var expRows = [['Category', 'Projected', 'Actual paid', 'Variance', 'Counted']];
    c.lines.forEach(function (l) {
      expRows.push([l.label,
        l.projected == null ? '' : l.projected,
        l.paid,
        l.projected == null ? '' : (l.paid - l.projected),
        l.effective]);
    });
    otherDebts(tour).forEach(function (d) {
      expRows.push(['Owed: ' + (d.label || 'Debt'), '', num(d.amount), '', num(d.amount)]);
    });
    expRows.push(['Day by day', '', c.dayByDay, '', c.dayByDay]);
    expRows.push(['TOTAL OUT', '', '', '', c.out]);
    expRows.push(['TOTAL INCOME', '', '', '', c.income]);
    expRows.push(['NET', '', '', '', round(c.net)]);

    var catLabel = {};
    CHARGE_CATEGORIES.forEach(function (x) { catLabel[x.key] = x.label; });
    var chargeRows = [['Date', 'Merchant', 'Amount', 'Category']];
    rows(tour && tour.charges).sort(byDate).forEach(function (ch) {
      chargeRows.push([ch.date || '', ch.merchant || '', num(ch.amount),
        catLabel[ch.category] || ch.category || '']);
    });

    var dayRows = [['Date', 'Label', 'Amount', 'Source', 'Meals flag']];
    rows(tour && tour.extras).sort(byDate).forEach(function (x) {
      dayRows.push([x.date || '', x.label || '', num(x.amount), 'Logged',
        /food|meal|catering/i.test(String(x.label)) ? 'MEAL (50% rule)' : '']);
    });
    rows(tour && tour.charges).sort(byDate).forEach(function (ch) {
      if (ch.category !== DAY_BY_DAY) return;
      dayRows.push([ch.date || '', ch.merchant || '', num(ch.amount), 'Card', '']);
    });

    var comm = normCommission(tour && tour.commission);
    var commRows = [['Line', 'Deal', 'Base', 'Amount']];
    COMMISSION_LINES.forEach(function (line) {
      var r = comm[line.key];
      commRows.push([line.label,
        r.mode === 'pct' ? r.value + '%' : 'Flat ' + money(r.value),
        r.mode === 'pct' ? (function () {
          var lbl = commissionBaseLabel(r);
          return lbl.charAt(0).toUpperCase() + lbl.slice(1) + ' ' +
            money(commissionBase(r, c.incomeBy) || 0);
        })() : '',
        round(commissionLine(line, r, c.income, c.guarantees, c.incomeBy))]);
    });
    commRows.push(['TOTAL', '', '', round(c.commission)]);

    return {
      'shows.csv': toCSV(showRows),
      'expenses-budget-vs-actual.csv': toCSV(expRows),
      'card-charges.csv': toCSV(chargeRows),
      'day-by-day.csv': toCSV(dayRows),
      'commissions.csv': toCSV(commRows)
    };
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
    commissionBase: commissionBase, commissionBaseLabel: commissionBaseLabel,

    cardDebts: cardDebts, otherDebts: otherDebts, cardSummary: cardSummary,
    cardPaidDetail: cardPaidDetail, preTourCutoff: preTourCutoff,

    calc: calc, stateOf: stateOf, caption: caption,
    balanceSeries: balanceSeries, latestChange: latestChange,
    normalizeSettlement: normalizeSettlement,
    DS_AMENITIES: DS_AMENITIES, daySheetLines: daySheetLines, daySheetText: daySheetText,
    toCSV: toCSV, closeoutCSVs: closeoutCSVs,
    offDayLines: offDayLines, offDayText: offDayText,
    GUEST_PASSES: GUEST_PASSES, guestSummary: guestSummary, guestListText: guestListText,
    normalizeTourImport: normalizeTourImport, mergeDaySheet: mergeDaySheet,
    budgetFrom: budgetFrom, hasBudget: hasBudget, crewKey: crewKey,
    dailyUpdate: dailyUpdate
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
