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
    { key: 'food', label: 'Food' },
    { key: 'gas', label: 'Gas' },
    { key: 'hotels', label: 'Hotels' },
    { key: 'flights', label: 'Flights' },
    { key: 'rideshare', label: 'Uber/Lyft' },
    { key: 'transport', label: 'Transportation' },
    { key: 'production', label: 'Production' },
    { key: 'studio', label: 'Studio' },
    { key: 'supplies', label: 'Supplies' },
    // Debts ride as plain categories now — no separate "owed going in" ledger.
    { key: 'card', label: 'Credit card' },
    // Off-tour spending that rode a tour's card: the tour carries it as debt.
    { key: 'offdebt', label: 'Off Tour Debt' },
    { key: 'loan', label: 'Loan' },
    { key: 'interest', label: 'Interest charges' },
    // What the merch cost to make. Usually an advance that has to be earned back,
    // which is why it sits here as a cost rather than against merch income.
    { key: 'merch', label: 'Merch bill', note: 'Printing, plus any merch advance you have to pay back.' },
    { key: 'commission', label: 'Commission' },
    { key: 'misc', label: 'Misc' },
    // Monthly-type costs sit at the end, by request.
    { key: 'utilities', label: 'Monthly utilities' }
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

  /* Income catalogued onto the book itself, not one night (tour.otherIncome,
     keyed by the bank deposit that brought it): royalties, an advance, or
     merch and guarantees that belong to no one show. */
  var OTHER_INCOME_KINDS = [
    { key: 'merch', label: 'Merch' },
    { key: 'guarantee', label: 'Guarantee' },
    { key: 'royalties', label: 'Royalties' },
    { key: 'advance', label: 'Advance' }
  ];
  function otherKindLabel(kind) {
    var hit = OTHER_INCOME_KINDS.filter(function (k) { return k.key === kind; })[0];
    return hit ? hit.label : 'Income';
  }

  // The titles an artist's page can give its people (or it types its own):
  // what the public sees there, whatever they are behind the scenes.
  var BAND_ROLES = ['Vocals', 'Guitar', 'Bass', 'Drums', 'Keys', 'DJ', 'Programming'];
  var ARTIST_CREW_ROLES = ['Tour Manager', 'Production Manager', 'Stage Manager', 'FOH Engineer',
    'Monitor Engineer', 'Lighting Director', 'Guitar Tech', 'Drum Tech', 'Merch Manager', 'Driver',
    'Photographer', 'Videographer'];

  /* Tour credits. On the confirm page a selection is
     { all: bool, picks: { groupKey: { mode: 'all' | 'shows', shows: { nightId: true } } } }
     over the artist's groups: its tours, and each year's nights that sit
     outside any named tour ({ key: 'year:2024', year: true }). */
  function creditGroupName(g) {
    if (!g) return '';
    if (g.year) {
      var y = String(g.key || '').slice(5);
      return y && y !== '0' ? y + ' · other shows' : 'Undated shows';
    }
    return g.name || 'Untitled tour';
  }
  function pickedIds(p) {
    var shows = p && isObj(p.shows) ? p.shows : {};
    return Object.keys(shows).filter(function (id) { return shows[id]; });
  }
  // How many tours and shows a selection adds up to (a year of loose
  // nights adds shows, never a tour).
  function creditTally(groups, sel) {
    var out = { tours: 0, shows: 0 };
    (groups || []).forEach(function (g) {
      var n = 0;
      if (sel && sel.all) n = num(g.n);
      else {
        var p = sel && isObj(sel.picks) ? sel.picks[g.key] : null;
        if (!isObj(p)) return;
        n = p.mode === 'shows' ? pickedIds(p).length : num(g.n);
      }
      if (!(n > 0)) return;
      out.shows += n;
      if (!g.year) out.tours += 1;
    });
    return out;
  }
  // The selection as the server takes it.
  function creditClaim(sel) {
    if (sel && sel.all) return { all: true };
    var picks = [];
    Object.keys(sel && isObj(sel.picks) ? sel.picks : {}).forEach(function (k) {
      var p = sel.picks[k];
      if (!isObj(p)) return;
      if (p.mode === 'shows') {
        var ids = pickedIds(p);
        if (ids.length) picks.push({ key: k, mode: 'shows', shows: ids });
      } else picks.push({ key: k, mode: 'all' });
    });
    return { picks: picks };
  }
  // What the server keeps, back into a selection (to pick up where they left off).
  function creditSelection(claim) {
    var sel = { all: false, picks: {} };
    if (!isObj(claim)) return sel;
    if (claim.all === true) { sel.all = true; return sel; }
    (Array.isArray(claim.picks) ? claim.picks : []).forEach(function (p) {
      if (!isObj(p) || !p.key) return;
      var shows = {};
      if (p.mode === 'shows') (Array.isArray(p.shows) ? p.shows : []).forEach(function (id) { shows[String(id)] = true; });
      sel.picks[p.key] = { mode: p.mode === 'shows' ? 'shows' : 'all', shows: shows };
    });
    return sel;
  }

  /* A page's Tours tab: every tour there is, newest first, with the one
     being played today on top. `own` are tours on Greenroom ({ name, artist,
     first, last, shows }); `past` are tours known from an artist's history
     or from confirmed credits ({ name, artist, n, first, last }). A past tour
     that overlaps one of the page's own in time is the same tour, so it's
     listed once — on an artist's page (the past tours carry no artist: they
     are all its own), or on a person's when both are filed under the same
     artist. An own tour with no artist filed never hides a credited one. */
  function tourTimeline(own, past, today) {
    var mine = (own || []).filter(isObj), out = [];
    var low = function (v) { return String(v || '').trim().toLowerCase(); };
    mine.forEach(function (t) {
      var a = String(t.first || ''), b = String(t.last || t.first || '');
      out.push({ own: true, tour: t, name: t.name || 'Untitled tour', artist: t.artist || '', first: a, last: b,
        n: num(t.shows), now: !!(a && today && today >= a && today <= b) });
    });
    (past || []).filter(isObj).forEach(function (p) {
      var a = String(p.first || ''), b = String(p.last || p.first || '');
      var dup = !!a && mine.some(function (t) {
        var ta = String(t.first || ''), tb = String(t.last || t.first || '');
        if (!ta) return false;
        if (p.artist && low(p.artist) !== low(t.artist)) return false;
        return a <= tb && b >= ta;
      });
      if (dup) return;
      out.push({ own: false, tour: p, name: p.name || 'Untitled tour', artist: p.artist || '', first: a, last: b,
        n: num(p.n), now: false });
    });
    return out.sort(function (x, y) {
      if (x.now !== y.now) return x.now ? -1 : 1;
      return String(y.last).localeCompare(String(x.last)) || String(x.name).localeCompare(String(y.name));
    });
  }

  /* Road badges (Devin's ladder, 2026-10-07). Shows carry you up the
     rungs — Bronze 50, Silver 250, Gold 500, Diamond 800 — but LEGACY is
     the whole spread at once: 850 shows AND 50 tours AND 30 countries AND
     250 cities. The badge rewards the grind, not the fame: Michael
     Jackson's solo career sits at Silver, and even the Beatles (~1,400
     shows, but few runs around the world) hold at Diamond. */
  var HISTORY_TIERS = [
    { key: 'diamond', label: 'Diamond', n: 800 },
    { key: 'gold', label: 'Gold', n: 500 },
    { key: 'silver', label: 'Silver', n: 250 },
    { key: 'bronze', label: 'Bronze', n: 50 }
  ];
  var LEGACY_BAR = { key: 'legacy', label: 'Legacy', shows: 850, tours: 50, countries: 30, cities: 250 };
  function historyTier(sum) {
    var s = isObj(sum) ? sum : {};
    if (num(s.shows) >= LEGACY_BAR.shows && num(s.tours) >= LEGACY_BAR.tours &&
        num(s.countries) >= LEGACY_BAR.countries && num(s.cities) >= LEGACY_BAR.cities) {
      return LEGACY_BAR;
    }
    for (var i = 0; i < HISTORY_TIERS.length; i++) {
      if (num(s.shows) >= HISTORY_TIERS[i].n) return HISTORY_TIERS[i];
    }
    return null;
  }

  var CREW_TITLES = ['Tour manager', 'FOH engineer', 'Monitor engineer', 'Lighting director',
    'Guitar tech', 'Drum tech', 'Merch manager', 'Driver'];
  var DEBT_CHIPS = ['Credit card', 'Loan', 'Gear payment'];
  var DAILY_CHIPS = ['Food', 'Parking', 'Tolls', 'Repairs', 'Laundry', 'Gear'];

  // Charges can also land on the day-by-day pile, which is not an expense category.
  var DAY_BY_DAY = 'dayByDay';
  var CHARGE_CATEGORIES = CATEGORIES.concat([{ key: DAY_BY_DAY, label: 'Day by day' }]);

  /* Tours can grow their own expense categories (tour.extraCats: {key: label},
     keys prefixed "x-" so they can never collide with the built-ins). They
     count exactly like typed categories everywhere. */
  function extraCategories(tour) {
    var src = tour && isObj(tour.extraCats) ? tour.extraCats : {};
    return Object.keys(src)
      .filter(function (k) { return k.indexOf('x-') === 0 && String(src[k] || '').trim(); })
      .sort(function (a, b) { return String(src[a]).localeCompare(String(src[b])); })
      .map(function (k) { return { key: k, label: String(src[k]).trim().slice(0, 30) }; });
  }
  function typedCategoriesFor(tour) { return TYPED_CATEGORIES.concat(extraCategories(tour)); }
  function chargeCategoriesFor(tour) { return CHARGE_CATEGORIES.concat(extraCategories(tour)); }
  function slugCategory(label) {
    var s = String(label == null ? '' : label).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    return s ? 'x-' + s : '';
  }

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
    // Custom categories ride along under their x- keys.
    Object.keys(src).forEach(function (k) {
      if (out[k] || k.indexOf('x-') !== 0) return;
      var r = isObj(src[k]) ? src[k] : {};
      out[k] = { projected: optNum(r.projected), paid: num(r.paid) };
    });
    return out;
  }

  function normCommission(c) {
    var out = emptyCommission();
    var src = isObj(c) ? c : {};
    var rule = function (line, r) {
      var base = defaultCommissionBase(line);
      if (isObj(r.base)) INCOME_FIELDS.forEach(function (f) { base[f.key] = !!r.base[f.key]; });
      return { mode: r.mode === 'pct' ? 'pct' : 'flat', value: num(r.value), base: base };
    };
    COMMISSION_LINES.forEach(function (line) {
      out[line.key] = rule(line, isObj(src[line.key]) ? src[line.key] : {});
    });
    // Anyone else on the team rides along under an x- key with their name.
    // A removed one is stored as null so the save clears it.
    Object.keys(src).forEach(function (k) {
      if (k.indexOf('x-') !== 0 || !isObj(src[k])) return;
      var r = src[k];
      var label = String(r.label == null ? '' : r.label).trim().slice(0, 40);
      if (!label) return;
      var x = rule({ basis: 'income' }, r);
      x.label = label;
      x.at = num(r.at);
      out[k] = x;
    });
    return out;
  }

  // Every commissioned line on a tour: the three standing ones, then anyone
  // added to the team, oldest first.
  function commissionLines(c) {
    var n = normCommission(c);
    var extra = Object.keys(n).filter(function (k) { return k.indexOf('x-') === 0; })
      .sort(function (a, b) { return n[a].at - n[b].at || (a < b ? -1 : 1); })
      .map(function (k) { return { key: k, label: n[k].label, basis: 'income', custom: true }; });
    return COMMISSION_LINES.concat(extra);
  }

  /* Buyouts: the venue pays one for each person on the road. What goes to
     the crew passes through to them; only what's paid to the Artists is the
     band's income. show.buyoutTrack = { perHead, paid: { who: { name,
     artist } } } says who has theirs; until it does, buyouts count nothing. */
  function buyoutIncome(show) {
    var total = num(show && isObj(show.income) ? show.income.buyouts : 0);
    var tr = show && isObj(show.buyoutTrack) ? show.buyoutTrack : null;
    if (!(total > 0) || !tr) return 0;
    var paid = isObj(tr.paid) ? tr.paid : {};
    var artists = Object.keys(paid).filter(function (k) { return isObj(paid[k]) && paid[k].artist; }).length;
    return Math.min(total, round(num(tr.perHead) * artists * 100) / 100);
  }
  // One income stream of a show, as it counts. (The part of a guarantee a
  // venue or a bank kept never arrives, so it's not the show's money.)
  function incomeOf(show, key) {
    if (key === 'buyouts') return buyoutIncome(show);
    var inc = show && isObj(show.income) ? show.income : {};
    if (key === 'guarantee') return Math.max(0, num(inc.guarantee) - guaranteeLost(show));
    return num(inc[key]);
  }
  function showIncomeTotal(show) {
    return INCOME_FIELDS.reduce(function (t, f) { return t + incomeOf(show, f.key); }, 0);
  }

  /* Money in hand, show by show. A guarantee only counts toward the budget
     once it's ticked Received. Merch counts as soon as it's logged (the cash
     is in hand and the rest is on its way) but the show isn't settled until
     the deposit lands. Shows logged before the Received boxes existed carry
     no flags and read as received, exactly as they always counted. */
  // A guarantee paid by agency deposit is in too: it was paid, to the agent,
  // who holds it against their commission.
  function guaranteeIn(show) { return !show || show.guaranteePaidBy === 'agency' || show.guaranteeReceived !== false; }

  /* The guarantee that was agreed and what actually reached the bank are
     often different. A show keeps both — the total (its logged guarantee
     plus any tax withheld) and the deposit — and, when they differ, why:
     show.guaranteeWhy, dollars by reason. The reasons say where the missing
     money is: a commission taken off the top counts as commission already
     paid; an earlier deposit or cash at the show reached the band another
     way; what the promoter still owes isn't in hand yet; and what a venue
     or a bank kept (or "other") never arrives, so it comes off the
     guarantee counted. Reasons only speak for a gap that exists: with no
     deposit known, or one that covers the logged guarantee, they move
     nothing. */
  var GUARANTEE_REASONS = [
    { key: 'agent', label: 'Booking agent\u2019s commission' },
    { key: 'mgmt', label: 'Management commission' },
    { key: 'tax', label: 'Taxes withheld' },
    { key: 'advance', label: 'Deposit paid earlier' },
    { key: 'cash', label: 'Paid in cash at the show' },
    { key: 'owed', label: 'Still owed by the promoter' },
    { key: 'venue', label: 'Venue deduction' },
    { key: 'fee', label: 'Bank or wire fee' },
    { key: 'other', label: 'Other' }
  ];
  // The reasons on a show, as plain positive dollars. Taxes withheld were
  // kept on their own before this (show.taxWithheld): they still count.
  function guaranteeWhy(show) {
    var src = show && isObj(show.guaranteeWhy) ? show.guaranteeWhy : {};
    var out = {};
    GUARANTEE_REASONS.forEach(function (r) {
      var v = round(num(src[r.key]) * 100) / 100;
      if (v > 0) out[r.key] = v;
    });
    var tax = round(num(show && show.taxWithheld) * 100) / 100;
    if (tax > 0) out.tax = tax; else delete out.tax;
    return out;
  }
  // The agreed total: what's logged, plus the tax that came out of it.
  function guaranteeTotal(show) {
    var inc = show && isObj(show.income) ? show.income : {};
    return round((num(inc.guarantee) + Math.max(0, num(show && show.taxWithheld))) * 100) / 100;
  }
  // Total, deposit, the gap between them, and how much of the gap the
  // reasons account for. deposit is null until one is known.
  function guaranteeGap(show) {
    var total = guaranteeTotal(show);
    var has = !!show && show.guaranteeDeposit != null && num(show.guaranteeDeposit) > 0;
    var deposit = has ? round(num(show.guaranteeDeposit) * 100) / 100 : null;
    var why = guaranteeWhy(show);
    var explained = Object.keys(why).reduce(function (t, k) { return t + why[k]; }, 0);
    var short = deposit == null ? 0 : round((total - deposit) * 100) / 100;
    return { total: total, deposit: deposit, short: short, explained: round(explained * 100) / 100,
      unexplained: round((short - explained) * 100) / 100, why: why };
  }
  // The most the reasons can speak for: the part of the logged guarantee
  // (the tax is already out of it) that the deposit didn't cover.
  function guaranteeRoom(show) {
    if (!show || show.guaranteePaidBy === 'agency' || show.guaranteeReceived === false) return 0;
    if (show.guaranteeDeposit == null || !(num(show.guaranteeDeposit) > 0)) return 0;
    var inc = isObj(show.income) ? show.income : {};
    return Math.max(0, round((num(inc.guarantee) - num(show.guaranteeDeposit)) * 100) / 100);
  }
  // The part of a received guarantee the promoter hasn't paid yet.
  function guaranteeOwed(show) {
    var room = guaranteeRoom(show);
    return room > 0 ? Math.min(room, guaranteeWhy(show).owed || 0) : 0;
  }
  // The part that never arrives: kept by the venue, eaten by a bank fee,
  // or gone for a reason typed by hand.
  function guaranteeLost(show) {
    var room = guaranteeRoom(show);
    if (!(room > 0)) return 0;
    var why = guaranteeWhy(show);
    return Math.max(0, Math.min(room - Math.min(room, why.owed || 0), (why.venue || 0) + (why.fee || 0) + (why.other || 0)));
  }
  // Commission that came off the top before the deposit: already paid.
  // (An agency deposit holds the whole guarantee, counted on its own.)
  // who: 'agent' or 'mgmt' for one of them alone.
  // It can only sit in the part of the gap nothing else accounts for: what
  // is still owed, what was lost, and what came in another way are counted
  // first, so the same missing dollars are never taken off twice.
  function guaranteeKept(show, who) {
    var room = guaranteeRoom(show);
    if (!(room > 0)) return 0;
    var why = guaranteeWhy(show);
    room = Math.max(0, round((room - guaranteeOwed(show) - guaranteeLost(show) - (why.advance || 0) - (why.cash || 0)) * 100) / 100);
    var a = Math.min(room, why.agent || 0), m = Math.min(room - a, why.mgmt || 0);
    return who === 'agent' ? a : who === 'mgmt' ? m : a + m;
  }
  // What should land in the bank for a night's merch. atVenu Register pays the
  // card sales less processing fees, two business days after the show; when
  // the Settlement shows those card figures, that is the deposit to expect.
  // Without them (typed by hand, or the venue sold), it's the net less the
  // cash already in hand.
  function merchDue(show) {
    if (show && show.merchCardDeposit != null && num(show.merchCardDeposit) >= 0) {
      return round(num(show.merchCardDeposit) * 100) / 100;
    }
    var inc = show && isObj(show.income) ? show.income : {};
    return Math.max(0, round((num(inc.merch) - num(show && show.merchCash)) * 100) / 100);
  }
  // Whether each half of a night's money is in. Devin's rule, exactly: a
  // half with money logged is in only when its Received box is ticked (and,
  // for a guarantee, nothing is still owed) — no exceptions for an agency
  // deposit, for all-cash merch, or for a night logged before the boxes
  // existed. A half with NOTHING logged under it counts as in only through
  // its own hand tick ("nothing to wait for here"), kept in guaranteeNone /
  // merchNone so that guaranteeReceived / merchReceived keep meaning "this
  // money has landed", which is what the bank matchers and the atVenu
  // readers go by. (The budget's own counting, guaranteeIn, is unchanged.)
  function showReceived(show) {
    var inc = show && isObj(show.income) ? show.income : {};
    return {
      guarantee: num(inc.guarantee) > 0 ? !!show && show.guaranteeReceived === true && !(guaranteeOwed(show) > 0) : !!show && show.guaranteeNone === true,
      merch: num(inc.merch) > 0 ? !!show && show.merchReceived === true : !!show && show.merchNone === true
    };
  }
  // A logged night's money, two ways only: 'settled' when BOTH the guarantee
  // and the merch are received, 'owed' until then. Null for a night not
  // logged yet.
  function showMoneyState(show) {
    if (!show || !show.loggedAt) return null;
    var r = showReceived(show);
    return r.guarantee && r.merch ? 'settled' : 'owed';
  }

  /* The merch cash log: what the table took in cash, and where every dollar
     went. An entry filed under a category is a tour cost and counts like a
     card charge; a deposit or a hand-off just moves the cash. */
  var CASH_MOVES = { deposit: 'Deposited in the bank', handoff: 'Handed off (not a tour cost)' };
  /* Show by show: what each night's table took in cash, what's been logged
     against it, and what's still to account for. Entries logged without a
     show (the log's first days) cover the oldest nights first. */
  function cashByShow(tour) {
    var nights = rows(tour && tour.shows).filter(function (s) {
      return s.loggedAt && num(s.merchCash) > 0;
    }).sort(byDate).map(function (s) {
      return { show: s, took: round(num(s.merchCash) * 100) / 100, used: 0, entries: [] };
    });
    var byId = {};
    nights.forEach(function (n) { byId[n.show.id] = n; });
    var loose = [];
    rows(tour && tour.cashLog).sort(function (a, b) {
      return String(a.date || '').localeCompare(String(b.date || '')) || (a.createdAt || 0) - (b.createdAt || 0);
    }).forEach(function (x) {
      if (x.showId && byId[x.showId]) { byId[x.showId].used += num(x.amount); byId[x.showId].entries.push(x); }
      else loose.push(x);
    });
    var spare = loose.reduce(function (t, x) { return t + num(x.amount); }, 0);
    nights.forEach(function (n) {
      var room = Math.max(0, n.took - n.used);
      var take = Math.min(room, spare);
      n.used += take; spare -= take;
      n.left = round((n.took - n.used) * 100) / 100;
      n.used = round(n.used * 100) / 100;
    });
    return { nights: nights, loose: loose };
  }

  function cashSummary(tour) {
    var took = rows(tour && tour.shows).reduce(function (t, s) {
      return s.loggedAt ? t + num(s.merchCash) : t;
    }, 0);
    var used = rows(tour && tour.cashLog).reduce(function (t, x) { return t + num(x.amount); }, 0);
    return { took: round(took * 100) / 100, used: round(used * 100) / 100,
      left: round((took - used) * 100) / 100 };
  }

  /* Card charges, newest first. Within a day: the order the bank sent them
     (seq, lower first), which is the order the card's own app shows; without
     it, the later posting day, then A to Z. */
  function newestFirst(a, b) {
    var da = parseDay(a && a.date) ? a.date : '0000', db = parseDay(b && b.date) ? b.date : '0000';
    if (da !== db) return db < da ? -1 : 1;
    if (a.seq != null && b.seq != null && isFinite(a.seq) && isFinite(b.seq) && Number(a.seq) !== Number(b.seq)) {
      return Number(a.seq) - Number(b.seq);
    }
    var pa = String(a.posted || a.date || ''), pb = String(b.posted || b.date || '');
    if (pa !== pb) return pb < pa ? -1 : 1;
    return String(a.merchant || '').localeCompare(String(b.merchant || ''));
  }

  /* ---------------- Vendors inside a category ---------------- */

  /* Monthly utilities is many bills under one line. This sorts a category's
     entries into the companies (or kinds of bill) behind them, from the name
     each charge was stored under. It is a second way of looking at the same
     entries and nothing more: it never changes a total, a stored name, or
     anything calc() counts.
     A bank writes one company a dozen ways ("AMZN Mktp US*2K4LT0Y93",
     "Amazon.com*RT4G12"), so the well-known ones are matched by pattern;
     the first match wins, brands before kinds (so "iCloud storage" is Apple,
     not Storage). Everything else groups under its own name with the order
     codes and store numbers taken off. A few patterns also catch names that
     were stored with the front clipped off ("otify" for Spotify, "trum" for
     Spectrum): the card feed still names charges that way. */
  var VENDOR_ALIASES = [
    { label: 'Amazon', re: /\b(amazon|amzn|amz|prime video)\b/ },
    { label: 'Verizon', re: /\b(verizon|vzw|vzwrlss|vz wireless)\b/ },
    { label: 'AT&T', re: /\b(at t|att)\b/ },
    { label: 'T-Mobile', re: /\b(t mobile|tmobile)\b/ },
    { label: 'LA Fitness', re: /\bla ?fitness\b/ },
    { label: 'Planet Fitness', re: /\bplanet fit(ness)?\b/ },
    { label: 'Apple', re: /\b(apple|itunes|icloud)\b/ },
    { label: 'Google', re: /\b(google|youtube|gsuite)\b/ },
    { label: 'Spotify', re: /\b(sp)?otify\b/ },
    { label: 'Netflix', re: /\bnetflix\b/ },
    { label: 'Adobe', re: /\badobe\b/ },
    { label: 'Dropbox', re: /\bdropbox\b/ },
    { label: 'Squarespace', re: /\b(sq)?uarespace\b/ },
    { label: 'QuickBooks', re: /\b(quickbooks|intuit|tuit)\b/ },
    { label: 'Xfinity', re: /\b(xfinity|comcast)\b/ },
    { label: 'Spectrum', re: /\b(spectrum|ectrum|trum|charter comm\w*)\b/ },
    { label: 'Storage', re: /\b(storage|extra space|cubesmart|storquest|u haul|uhaul)\b/ }
  ];
  // Words at the end of a bank's line that aren't part of the name.
  var VENDOR_TAIL = /^(com|net|org|co|inc|llc|ltd|corp|usa|us|bill|billing|payment|payments|pmt|pymt|autopay|recurring|online|web|www)$/;
  function vendorNorm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  // The group a stored name falls into: { key, label }. '' is "no vendor".
  function vendorOf(name) {
    var n = vendorNorm(name);
    if (!n) return { key: '', label: 'Other' };
    for (var i = 0; i < VENDOR_ALIASES.length; i++) {
      if (VENDOR_ALIASES[i].re.test(n)) return { key: vendorNorm(VENDOR_ALIASES[i].label), label: VENDOR_ALIASES[i].label };
    }
    // Order codes and store numbers (a word with a digit in it, after the
    // first) come off; a number that leads the name is part of it
    // ("24 Hour Fitness", "7-Eleven").
    var words = n.split(' ').filter(function (w, i) { return i === 0 || !/\d/.test(w); });
    while (words.length > 1 && VENDOR_TAIL.test(words[words.length - 1])) words.pop();
    var key = words.join(' ') || n;
    var raw = String(name).trim();
    // The name as it was stored when that's all there is to it (shouty bank
    // capitals become title case; short initials like "PG&E" stay as they are).
    var whole = vendorNorm(raw) === key;
    var label = whole && raw !== raw.toUpperCase() && raw !== raw.toLowerCase() ? raw
      : whole && raw === raw.toUpperCase() && /&/.test(raw) && raw.length <= 6 ? raw
      : key.replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
    return { key: key, label: label };
  }
  /* entries: [{ id, name, amount, counts, how, loose }]
       how: 'credit' | 'debit' | 'cash' (the Expenses column it sits in);
       loose: an entry with no vendor behind it (a typed-in total, a card
       balance going in) — it goes to Other unless moved by hand.
     over: what was changed by hand on this tour; any part may be missing,
     and a cleared one is null:
       { one: { <entry id>: 'Group' },         this one entry goes there
         by: { <vendorNorm(name)>: 'Group' },  every entry stored under this name
         names: { <source key>: 'Shown as' } } a group renamed
     A group is the name it's shown under: two vendors renamed to the same
     thing ("Insurance") become one group. A group picked by hand is that
     group exactly as named; names only renames what sorts by itself. An
     entry with no vendor of its own follows only a rule made for it alone,
     never a name-wide one. Returns the groups, biggest first,
     Other last:
       [{ key, label, keys, total, credit, debit, cash, count, entries }]
     key is '' for Other; keys are the source keys a rename has to cover. */
  function vendorGroups(entries, over) {
    var o = isObj(over) ? over : {};
    var one = isObj(o.one) ? o.one : {}, by = isObj(o.by) ? o.by : {}, names = isObj(o.names) ? o.names : {};
    // (A name with no letter or number in it can't be told from any other: it counts as not said.)
    var said = function (v) { return typeof v === 'string' && vendorNorm(v) ? v.trim() : ''; };
    var map = {}, order = [];
    (entries || []).forEach(function (e) {
      var forced = (e.id != null && said(one[e.id])) || (!e.loose && said(by[vendorNorm(e.name)]));
      var src = forced ? { key: '', label: forced }
        : e.loose ? { key: '', label: 'Other' } : vendorOf(e.name);
      var label = forced || (src.key ? (said(names[src.key]) || src.label) : 'Other');
      var id = vendorNorm(label);
      if (!id || id === 'other') { id = ''; label = 'Other'; }
      var g = map['k:' + id];
      if (!g) {
        g = map['k:' + id] = { key: id, label: label, keys: [], total: 0, credit: 0, debit: 0, cash: 0, count: 0, entries: [] };
        order.push(g);
      }
      if (id && src.key && g.keys.indexOf(src.key) < 0) g.keys.push(src.key);
      g.entries.push(e); g.count += 1;
      if (e.counts === false) return;
      var a = num(e.amount);
      g.total += a;
      g[e.how === 'cash' ? 'cash' : e.how === 'debit' ? 'debit' : 'credit'] += a;
    });
    order.forEach(function (g) {
      ['total', 'credit', 'debit', 'cash'].forEach(function (k) { g[k] = round(g[k] * 100) / 100; });
    });
    return order.sort(function (a, b) {
      return (a.key === '' ? 1 : 0) - (b.key === '' ? 1 : 0) || b.total - a.total || a.label.localeCompare(b.label);
    });
  }

  /* Crew are mostly paid a rate: by the week, the day or the month. Their
     total for the tour is that rate times how long the tour runs (rehearsals
     included when they're set; part of a week or month counts as a whole
     one), unless a total was typed over it (payTyped). Paid any other way
     ("other": installments, a flat fee), the total is whatever was typed. */
  function tourDays(tour) {
    var a = tourStart(tour), b = tourEnd(tour);
    if (!a || !b) return 0;
    if (parseDay(tour.rehearsalStart) && tour.rehearsalStart < a) a = tour.rehearsalStart;
    return Math.max(0, daysBetween(a, b)) + 1;
  }
  function payPeriods(tour, per) {
    var d = tourDays(tour);
    if (!d) return 0;
    if (per === 'day') return d;
    if (per === 'week') return Math.ceil(d / 7);
    if (per === 'month') return Math.max(1, Math.ceil(d / 30));
    return 0;
  }
  function crewPay(tour, p) {
    var rate = num(p && p.rate), n = payPeriods(tour, p && p.per);
    if (p && !p.payTyped && rate > 0 && n > 0) return round(rate * n * 100) / 100;
    return num(p && p.pay);
  }
  function crewProjection(tour) {
    return rows(tour && tour.crew).reduce(function (t, p) { return t + crewPay(tour, p); }, 0);
  }

  /* ---------------- My Pay (a crew member's own book) ---------------- */

  // Devin's MY PAY: everyone on a tour sees their own pay and keeps their own
  // spending, laid out like the tour's Expenses. These read the small book
  // the server keeps for each person on each tour.
  var MY_PAY_CATS = [
    { key: 'food', label: 'Food & drink' },
    { key: 'lodging', label: 'Lodging' },
    { key: 'travel', label: 'Travel' },
    { key: 'gear', label: 'Gear & supplies' },
    { key: 'other', label: 'Other' }
  ];
  // The book's lines, one per category: projected (when typed), then what
  // went on credit, debit and cash, as the Expenses tab reads them.
  function payBook(book) {
    var b = isObj(book) ? book : {};
    var entries = rows(b.entries), proj = isObj(b.projected) ? b.projected : {};
    var by = {};
    MY_PAY_CATS.forEach(function (c) {
      by[c.key] = { key: c.key, label: c.label, projected: optNum(proj[c.key]), credit: 0, debit: 0, cash: 0, total: 0, n: 0 };
    });
    entries.forEach(function (e) {
      var g = by[e && e.category] || by.other, a = num(e && e.amount);
      if (!(a > 0)) return;
      g[e.how === 'cash' ? 'cash' : e.how === 'debit' ? 'debit' : 'credit'] += a;
      g.total += a; g.n += 1;
    });
    var lines = MY_PAY_CATS.map(function (c) {
      var g = by[c.key];
      ['credit', 'debit', 'cash', 'total'].forEach(function (k) { g[k] = round(g[k] * 100) / 100; });
      return g;
    });
    var spent = round(lines.reduce(function (t, l) { return t + l.total; }, 0) * 100) / 100;
    var projected = round(lines.reduce(function (t, l) { return t + (l.projected == null ? 0 : l.projected); }, 0) * 100) / 100;
    return { lines: lines, spent: spent, projected: projected };
  }
  // What a crew member logs as coming in (Devin, 2026-10-07: "Crew gets
  // buyouts, weekly pay, per diems, & you can put Bonus as well"), beside
  // the pay the tour manager logged to them. Gross is the lot.
  var MY_PAY_INCOME = [
    { key: 'weekly', label: 'Weekly pay' },
    { key: 'perdiem', label: 'Per diems' },
    { key: 'buyout', label: 'Buyouts' },
    { key: 'bonus', label: 'Bonus' },
    { key: 'other', label: 'Other' }
  ];
  function payIncome(book, payments) {
    var b = isObj(book) ? book : {};
    var by = {};
    MY_PAY_INCOME.forEach(function (c) { by[c.key] = { key: c.key, label: c.label, total: 0, n: 0 }; });
    var tour = { key: 'tour', label: 'Pay from the tour', total: 0, n: 0 };
    (Array.isArray(payments) ? payments : rows(payments)).forEach(function (p) {
      var a = num(p && p.amount);
      if (a > 0) { tour.total += a; tour.n += 1; }
    });
    rows(b.income).forEach(function (e) {
      var g = by[e && e.category] || by.other, a = num(e && e.amount);
      if (!(a > 0)) return;
      g.total += a; g.n += 1;
    });
    var lines = [tour].concat(MY_PAY_INCOME.map(function (c) { return by[c.key]; }));
    lines.forEach(function (l) { l.total = round(l.total * 100) / 100; });
    return { lines: lines, gross: round(lines.reduce(function (t, l) { return t + l.total; }, 0) * 100) / 100 };
  }
  // The crew member's own climbing graph: money in (the tour's payments and
  // what they logged) against what they spent, day by day up to today.
  function payBalanceSeries(book, payments, until) {
    var b = isObj(book) ? book : {};
    var inc = {}, out = {};
    var add = function (map, d, a) { if (parseDay(d) && a > 0) map[d] = (map[d] || 0) + a; };
    (Array.isArray(payments) ? payments : rows(payments)).forEach(function (p) { add(inc, p && p.date, num(p && p.amount)); });
    rows(b.income).forEach(function (e) { add(inc, e.date, num(e.amount)); });
    rows(b.entries).forEach(function (e) { add(out, e.date, num(e.amount)); });
    var days = Object.keys(inc).concat(Object.keys(out)).filter(function (d, i, a) { return a.indexOf(d) === i; }).sort();
    if (!days.length) return [];
    var end = parseDay(until) && until > days[days.length - 1] ? until : days[days.length - 1];
    if (days.indexOf(end) < 0) days.push(end);
    // A quiet day before the first entry, so the lines rise from zero.
    days.unshift(addDays(days[0], -1));
    var ci = 0, co = 0;
    return days.map(function (d) {
      ci += inc[d] || 0; co += out[d] || 0;
      return { date: d, income: round(ci * 100) / 100, spent: round(co * 100) / 100 };
    });
  }
  // Where one crew member stands: their pay for the tour (the plan on their
  // crew row, run over the tour's dates), what's been logged as paid to
  // them, and what's still owed.
  function payStanding(info) {
    var i = isObj(info) ? info : {};
    var tour = isObj(i.tour) ? i.tour : {};
    var like = { shows: {}, spanStart: tour.spanStart, spanEnd: tour.spanEnd, rehearsalStart: tour.rehearsalStart };
    if (parseDay(tour.first)) like.shows.a = { date: tour.first };
    if (parseDay(tour.last)) like.shows.b = { date: tour.last };
    var total = isObj(i.crew) ? crewPay(like, i.crew) : 0;
    var list = Array.isArray(i.payments) ? i.payments : rows(i.payments);
    var paid = round(list.reduce(function (t, p) { return t + num(p && p.amount); }, 0) * 100) / 100;
    return { total: round(total * 100) / 100, paid: paid, owed: Math.max(0, round((total - paid) * 100) / 100), onCrew: isObj(i.crew) };
  }

  /* ---------------- Add missing tours (the tour finder) ---------------- */

  // A tour name boiled down for matching across articles: lower-case, no
  // punctuation, the filler words dropped (years kept: Warped 2010 is not
  // Warped 2013). The server does its own, by sound, before anything lands.
  var TOUR_FILLER = /\b(the|tour|tours|a|an|of|and|with|presents|leg|part|pt|run)\b/g;
  function tourKeyLoose(name) {
    return String(name || '').toLowerCase().replace(/[\u2019'".,:;!?()\[\]\-\u2013\u2014\/&+]/g, ' ')
      .replace(TOUR_FILLER, ' ').replace(/\s+/g, ' ').trim();
  }
  var TOUR_ROLES = ['headline', 'co-headline', 'support', 'festival'];
  function tourRole(r) { r = String(r || '').toLowerCase().trim(); return TOUR_ROLES.indexOf(r) >= 0 ? r : ''; }
  // "2019-11" reads as a month: its first day as a start, its last as an
  // end — but a month is a guess, and a guess never stretches a real date.
  function dayOrMonth(s, asEnd) {
    s = String(s || '').trim();
    if (parseDay(s)) return { d: s, exact: true };
    if (/^\d{4}-\d{2}$/.test(s)) {
      if (!asEnd) return { d: s + '-01', exact: false };
      var d = new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)), 0));
      return { d: s + '-' + String(d.getUTCDate()).padStart(2, '0'), exact: false };
    }
    return null;
  }
  function daysApart(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5); }
  // One listed night, as an object or as the compact line the reader is
  // asked for ("2019-11-05 | Omaha, NE | Slowdown").
  function tourDate(d) {
    if (isObj(d)) return parseDay(d.date) ? { date: d.date, city: String(d.city || '').trim(), venue: String(d.venue || '').trim() } : null;
    var parts = String(d || '').split('|').map(function (x) { return x.trim(); });
    return parseDay(parts[0]) ? { date: parts[0], city: parts[1] || '', venue: parts[2] || '' } : null;
  }
  function actsOf(lineup) {
    return String(lineup || '').toLowerCase().split(/,|\band\b|&|\//).map(function (x) { return x.trim(); }).filter(function (x) { return x.length > 1; });
  }
  function sharesAct(a, b) {
    var x = actsOf(a), y = actsOf(b);
    return x.some(function (n) { return y.indexOf(n) >= 0; });
  }
  // A description the reader made up ("Fall 2018 run with…") gives way to a real name.
  function madeUpName(n) { return /^(spring|summer|fall|autumn|winter|early|late|\d{4}|[a-z]+ \d{4})\b/i.test(String(n || '')); }
  // The reader's finds from every batch of articles, folded into one list:
  // the same tour spelled two ways is one tour; two accounts of one run
  // (same dates, same role, an act in common) are one run. Dates are kept
  // once each; the sources add up.
  function mergeTourCandidates(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (c) {
      if (!isObj(c)) return;
      var name = String(c.name || '').replace(/\s+/g, ' ').trim();
      var s0 = dayOrMonth(c.start, false), e0 = dayOrMonth(c.end, true);
      if (name.length < 2 || !s0 || !e0 || e0.d < s0.d) return;
      var start = s0.d, end = e0.d;
      var key = tourKeyLoose(name);
      if (!key) return;
      var role = tourRole(c.role);
      var dates = (Array.isArray(c.dates) ? c.dates : []).map(tourDate).filter(Boolean);
      var sources = (Array.isArray(c.sources) ? c.sources : c.source ? [c.source] : [])
        .map(String).filter(function (u) { return /^https:\/\//.test(u); });
      var lineup = String(c.lineup || '').replace(/\s+/g, ' ').trim();
      var hit = null;
      out.forEach(function (o) {
        if (hit) return;
        // The same name is the same tour only when the two accounts are
        // near each other in time: Warped Tour comes round every year.
        var near = o.start <= end && start <= o.end || Math.abs(daysApart(o.end, start)) <= 120 || Math.abs(daysApart(end, o.start)) <= 120;
        if (o.key === key && near) hit = o;
        else if (o.start <= end && start <= o.end && o.role === role && sharesAct(o.lineup, lineup)) hit = o;
      });
      if (!hit) {
        out.push({ key: key, name: name, role: role, start: start, end: end, startExact: s0.exact, endExact: e0.exact,
          region: String(c.region || '').trim(), lineup: lineup, dates: dates, sources: sources });
        return;
      }
      // A real date beats a month's guess; among real dates the wider wins.
      if (s0.exact && !hit.startExact) { hit.start = start; hit.startExact = true; }
      else if (s0.exact === hit.startExact && start < hit.start) hit.start = start;
      if (e0.exact && !hit.endExact) { hit.end = end; hit.endExact = true; }
      else if (e0.exact === hit.endExact && end > hit.end) hit.end = end;
      if (madeUpName(hit.name) && !madeUpName(name)) { hit.name = name; hit.key = key; }
      if (lineup.length > hit.lineup.length) hit.lineup = lineup;
      if (!hit.region && c.region) hit.region = String(c.region).trim();
      var have = {};
      hit.dates.forEach(function (d) { have[d.date] = true; });
      dates.forEach(function (d) { if (!have[d.date]) { have[d.date] = true; hit.dates.push(d); } });
      sources.forEach(function (u) { if (hit.sources.indexOf(u) < 0 && hit.sources.length < 6) hit.sources.push(u); });
    });
    // A name that comes round in more than one year (a package tour) gets
    // its year, so each year stands on its own on the page.
    var byKey = {};
    out.forEach(function (o) { byKey[o.key] = (byKey[o.key] || 0) + 1; });
    out.forEach(function (o) {
      if (byKey[o.key] > 1 && !/\b(19|20)\d{2}\b/.test(o.name)) { o.name = o.name + ' ' + o.start.slice(0, 4); o.key = tourKeyLoose(o.name); }
      o.dates.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      delete o.startExact; delete o.endExact;
    });
    return out;
  }
  // Whether a found tour is already on the page, by its loose name.
  function tourKnown(name, toursList) {
    var k = tourKeyLoose(name);
    return !!k && (Array.isArray(toursList) ? toursList : []).some(function (t) { return tourKeyLoose(t && t.name) === k; });
  }
  // From a long article, only the paragraphs that mention the act (and
  // their neighbours), so the reader isn't handed a whole encyclopedia.
  function paragraphsAbout(text, name) {
    var nm = String(name || '').toLowerCase().trim();
    if (!nm) return '';
    var paras = String(text || '').split(/\n+/), keep = {}, idx = [];
    paras.forEach(function (p, i) {
      if (p.toLowerCase().indexOf(nm) < 0) return;
      [i - 1, i, i + 1].forEach(function (j) { if (j >= 0 && j < paras.length && !keep[j]) { keep[j] = true; idx.push(j); } });
    });
    return idx.sort(function (a, b) { return a - b; }).map(function (i) { return paras[i].trim(); }).filter(Boolean).join('\n').slice(0, 6000);
  }
  /* ---------------- Handed-over concert lists ---------------- */

  // A spreadsheet's rows: quotes, doubled quotes, commas or tabs, CRLF. Blank rows go.
  function parseCsv(text) {
    var s = String(text || '').replace(/^﻿/, '');
    var sep = (s.split('\n')[0] || '').indexOf('\t') >= 0 ? '\t' : ',';
    var rows = [], row = [], cell = '', q = false, i, ch;
    var keep = function () { row.push(cell); cell = ''; if (row.some(function (c) { return c.trim() !== ''; })) rows.push(row); row = []; };
    for (i = 0; i < s.length; i++) {
      ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; keep(); }
      else cell += ch;
    }
    keep();
    return rows;
  }
  var MONTH_NO = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  // A date however a sheet writes it: 2016-02-20, Feb 20, 2016, Sep 02, 2023, 20 Feb 2016, 02/20/2016, 2/20/16 (a weekday in front is fine).
  function readDay(s) {
    s = String(s || '').trim().replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/i, '');
    var m, y, mo, d;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(s))) { mo = MONTH_NO[m[1].slice(0, 3).toLowerCase()]; d = +m[2]; y = +m[3]; }
    else if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(s))) { d = +m[1]; mo = MONTH_NO[m[2].slice(0, 3).toLowerCase()]; y = +m[3]; }
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s))) { mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
    else return '';
    if (!mo || !d || !y) return '';
    var out = y + '-' + pad(mo) + '-' + pad(d);
    return parseDay(out) ? out : '';
  }
  // Which column is which, by its heading (a Concert Archives export, Songkick, Bandsintown, anyone's sheet).
  var CONCERT_COLS = {
    date: /^(date|day|event ?date|show ?date|concert ?date|datetime|start ?date|start)$/i,
    title: /^(concert|title|tour|tour ?title|tour ?name|concert ?title|concert ?title ?(or|\/) ?tour ?title|event|event ?name|event ?title|name)$/i,
    bands: /^(bands?|artists?|line-?up|acts|performers?|with|support(ing)?|bill|other ?bands|bands? on the bill)$/i,
    venue: /^(venue|venue ?name|place|location ?name)$/i,
    city: /^(city|town)$/i, state: /^(state|region|province|state ?(\/|or) ?province|county)$/i, country: /^(country|nation)$/i,
    location: /^(location|where|city, ?state, ?country|city ?\/ ?state ?\/ ?country|address)$/i
  };
  function concertColumns(header) {
    var cols = {}, h = (Array.isArray(header) ? header : []).map(function (c) { return String(c || '').replace(/[_\s]+/g, ' ').trim(); });
    Object.keys(CONCERT_COLS).forEach(function (k) {
      h.forEach(function (c, i) { if (cols[k] == null && CONCERT_COLS[k].test(c)) cols[k] = i; });
    });
    return cols.date != null && (cols.venue != null || cols.location != null || cols.city != null) ? cols : null;
  }
  // The shows on a handed-over spreadsheet, one per row with a date; null when
  // the headings aren't a concert list (then the reader is asked instead).
  function concertRows(rows) {
    if (!Array.isArray(rows) || rows.length < 2) return null;
    var cols = concertColumns(rows[0]);
    if (!cols) return null;
    var get = function (r, k) { return cols[k] == null ? '' : String(r[cols[k]] || '').replace(/\s+/g, ' ').trim(); };
    var out = [];
    rows.slice(1).forEach(function (r) {
      var date = readDay(get(r, 'date'));
      if (!date) return;
      var where = get(r, 'location') || [get(r, 'city'), get(r, 'state'), get(r, 'country')].filter(Boolean).join(', ');
      out.push({ date: date, title: get(r, 'title'), bands: get(r, 'bands'), venue: get(r, 'venue'), where: where });
    });
    return out;
  }
  // Rows → the finder's items: one per tour title and year (Concert Archives
  // writes "Concert Title / Tour Title" when a show has both: the tour is the
  // last part), the shows with no title as one-offs by year. The other acts
  // on the bill become the lineup, the act itself left out.
  function concertItems(list, actName) {
    var me = String(actName || '').toLowerCase().trim();
    var items = {}, order = [];
    (Array.isArray(list) ? list : []).forEach(function (r) {
      if (!parseDay(r.date)) return;
      var parts = String(r.title || '').split(/\s+\/\s+/).map(function (p) { return p.trim(); }).filter(Boolean);
      var tour = parts.length ? parts[parts.length - 1] : '';
      // A "title" that is only the bill (Band / Band) is no tour name.
      if (tour && String(r.bands || '').toLowerCase().indexOf(tour.toLowerCase()) >= 0 && parts.length === 1) tour = '';
      var key = (tour ? tourKeyLoose(tour) : '') + '|' + r.date.slice(0, 4);
      var it = items[key];
      if (!it) { it = items[key] = { name: tour, role: '', start: r.date, end: r.date, region: '', acts: {}, dates: [], seen: {} }; order.push(key); }
      if (r.date < it.start) it.start = r.date;
      if (r.date > it.end) it.end = r.date;
      if (!it.seen[r.date]) { it.seen[r.date] = true; it.dates.push(r.date + ' | ' + String(r.where || '').trim() + ' | ' + String(r.venue || '').trim()); }
      String(r.bands || '').split(/\s*\/\s*|\s*,\s*|\s*;\s*/).forEach(function (b) {
        b = b.trim(); if (!b || b.toLowerCase() === me) return;
        it.acts[b] = (it.acts[b] || 0) + 1;
      });
    });
    return order.map(function (k) {
      var it = items[k];
      var lineup = it.name ? Object.keys(it.acts).sort(function (a, b) { return it.acts[b] - it.acts[a] || a.localeCompare(b); }).slice(0, 6).join(', ') : '';
      it.dates.sort();
      return { name: it.name, role: '', start: it.start, end: it.end, region: '', lineup: lineup, dates: it.dates, sources: [] };
    });
  }

  // "Come back in ~15 min": the finder's time left, rounded the way a person
  // would say it (to the minute under ten, to five minutes under an hour).
  function etaText(sec) {
    sec = num(sec);
    if (sec <= 0) return '';
    if (sec < 90) return 'Almost done.';
    var min = Math.ceil(sec / 60);
    if (min <= 10) return 'Come back in ~' + min + ' min.';
    if (min < 60) return 'Come back in ~' + Math.ceil(min / 5) * 5 + ' min.';
    var hrs = Math.max(1, Math.round(min / 60));
    return 'Come back in ~' + (hrs === 1 ? 'an hour.' : hrs + ' hours.');
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

  /* A guarantee paid by agency deposit never reaches the band: the booking
     agent holds all of it as an advance on their commission for the whole
     tour. So the whole guarantee counts as commission already paid to the
     agent, and their percentage works the advance off as the tour goes. */
  function agencyAdvance(shows) {
    return (shows || []).filter(function (s) { return s && s.guaranteePaidBy === 'agency'; }).map(function (s) {
      return { showId: s.id, city: s.city || 'Show', date: s.date || '',
        amount: round(num(isObj(s.income) ? s.income.guarantee : 0) * 100) / 100 };
    }).filter(function (x) { return x.amount > 0; });
  }

  function commissionTotal(commission, income, guarantees, incomeBy) {
    var c = normCommission(commission);
    return commissionLines(c).reduce(function (t, line) {
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
  /* A card the card feed read (card.feed): its balance was read the day
     logging started (card.cutoff), and it sits under Credit card. Charges on
     that card from on or before that day are already inside the balance, so
     as each one is filed under a category it moves out of Credit card and
     into that category. Payments on the card after that day come off what's
     still owed; the tour's spending doesn't change, the money was spent. */
  // upTo: only what had moved by that day (the balance chart walks the tour).
  function cardMoved(card, tour, upTo) {
    if (!card || !isObj(card.feed) || !parseDay(card.cutoff)) return 0;
    var inside = function (d) { return d && d <= card.cutoff && (!upTo || d <= upTo); };
    var moved = rows(tour && tour.charges).reduce(function (t, ch) {
      if (ch.accounted || !ch.category || ch.account !== card.feed.name) return t;
      // The bank's balance holds posted charges: a charge made before the
      // balance was read but posted after it wasn't inside it yet.
      return inside(ch.posted || ch.date) ? t + num(ch.amount) : t;
    }, 0);
    // Charges on this card that were logged to another tour (tour.cardAway)
    // leave the balance too, without counting as this tour's spending.
    var away = isObj(tour && tour.cardAway) ? tour.cardAway : {};
    Object.keys(away).forEach(function (k) {
      var a = away[k];
      if (isObj(a) && a.account === card.feed.name && inside(a.posted || a.date)) moved += num(a.amount);
    });
    return moved;
  }
  function cardPaidOff(card) {
    var p = isObj(card && card.payments) ? card.payments : {};
    return round(Object.keys(p).reduce(function (t, k) { return t + num(p[k] && p[k].amount); }, 0) * 100) / 100;
  }
  function cardSummary(card, tour, upTo) {
    var bd = isObj(card.breakdown) ? card.breakdown : {};
    var accounted = cardMoved(card, tour, upTo);
    TYPED_CATEGORIES.forEach(function (c) { accounted += num(bd[c.key]); });
    var balance = num(card.amount);
    var paidOff = cardPaidOff(card);
    return {
      id: card.id, label: card.label || 'Card', balance: balance, feed: isObj(card.feed),
      accounted: Math.min(accounted, balance),
      remainder: Math.max(0, balance - accounted),
      over: Math.max(0, accounted - balance),
      paidOff: paidOff,
      // The bank's own number when the feed has read it; otherwise the balance
      // going in less the payments since.
      owed: isObj(card.owedNow) && card.owedNow.amount != null ? Math.max(0, round(num(card.owedNow.amount) * 100) / 100)
        : Math.max(0, round((balance - paidOff) * 100) / 100)
    };
  }
  // What each category was paid on cards going in: { key: [{label, amount}] }
  function cardPaidDetail(tour, upTo) {
    var out = {};
    cardDebts(tour).forEach(function (card) {
      var s = cardSummary(card, tour, upTo);
      var bd = isObj(card.breakdown) ? card.breakdown : {};
      TYPED_CATEGORIES.forEach(function (c) {
        var v = num(bd[c.key]);
        if (v > 0) (out[c.key] = out[c.key] || []).push({ label: s.label, amount: v });
      });
      // A read balance waits under Credit card; a typed one's rest is Misc.
      if (s.remainder > 0 || s.feed) {
        var k = s.feed ? 'card' : 'misc';
        (out[k] = out[k] || []).push({ label: s.label, amount: s.remainder, leftover: true,
          feed: s.feed, balance: s.balance, paidOff: s.paidOff, owed: s.owed });
      }
    });
    return out;
  }
  // The last day whose charges are assumed inside the opening balances.
  /* The run's first and last day: the first and last show, stretched by any
     travel days. */
  function tourStart(tour) {
    var d = rows(tour && tour.shows).map(function (s) { return s.date; }).filter(parseDay).sort();
    if (!d.length) return null;
    return parseDay(tour.spanStart) && tour.spanStart < d[0] ? tour.spanStart : d[0];
  }
  function tourEnd(tour) {
    var d = rows(tour && tour.shows).map(function (s) { return s.date; }).filter(parseDay).sort();
    if (!d.length) return null;
    var last = d[d.length - 1];
    return parseDay(tour.spanEnd) && tour.spanEnd > last ? tour.spanEnd : last;
  }
  /* The days a tour takes card charges for, as the tour manager chose them:
     from the start of the tour, the start of rehearsals or a date, to the end
     of the tour or a date. Named choices follow the tour when its dates move.
     A tour with no choice yet takes none. */
  function cardWindow(tour) {
    var w = tour && tour.cardLog;
    if (!w || !w.from || !w.to) return null;
    var start = tourStart(tour), end = tourEnd(tour);
    var from = w.from === 'tour' ? start
      : w.from === 'rehearsals' ? (parseDay(tour.rehearsalStart) ? tour.rehearsalStart : start)
      : (parseDay(w.from) ? w.from : null);
    var to = w.to === 'tour' ? end : (parseDay(w.to) ? w.to : null);
    if (!from || !to || to < from) return null;
    return { from: from, to: to };
  }

  function preTourCutoff(tour) {
    // A read card's earlier charges move out of its balance instead.
    var cards = cardDebts(tour).filter(function (c) { return !isObj(c.feed); });
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
      if (override && override.showId === s.id) {
        return Object.assign({}, s, { income: override.income }, override.flags || {});
      }
      return s;
    }).sort(byDate);

    var shows = upTo ? allShows.filter(function (s) { return s.date && s.date <= upTo; }) : allShows;

    var income = 0, guarantees = 0;
    var incomeBy = {};
    INCOME_FIELDS.forEach(function (f) { incomeBy[f.key] = 0; });
    shows.forEach(function (s) {
      var inc = isObj(s.income) ? s.income : {};
      INCOME_FIELDS.forEach(function (f) {
        // A guarantee not received yet isn't money the tour has.
        if (f.key === 'guarantee' && !guaranteeIn(s)) return;
        // ...and neither is the part of one the promoter still owes, or
        // the part a venue or a bank kept.
        incomeBy[f.key] += f.key === 'buyouts' ? buyoutIncome(s)
          : f.key === 'guarantee' ? Math.max(0, num(inc.guarantee) - guaranteeOwed(s) - guaranteeLost(s)) : num(inc[f.key]);
      });
    });
    var showIncome = INCOME_FIELDS.reduce(function (t, f) { return t + incomeBy[f.key]; }, 0);
    guarantees = incomeBy.guarantee;

    // Income on the book itself (royalties, an advance, a payout that
    // belongs to no one night). It counts in the tour's income and net;
    // commission stays figured on the shows' money alone.
    var otherRows = rows(tour && tour.otherIncome).filter(function (x) {
      return !upTo || (x.date && x.date <= upTo);
    }).sort(byDate);
    var other = otherRows.reduce(function (t, x) { return t + num(x.amount); }, 0);
    income = showIncome + other;

    // A charge marked "already accounted for" is filed for the record but
    // never counted again — its money is already in the budget as paid.
    var charges = rows(tour && tour.charges).filter(function (ch) {
      if (ch.accounted) return false;
      return !upTo || (ch.date && ch.date <= upTo);
    });
    var chargedTo = {};
    charges.forEach(function (ch) {
      var k = ch.category || null;
      if (!k) return;
      chargedTo[k] = (chargedTo[k] || 0) + num(ch.amount);
    });
    // Merch cash spent on the tour counts where it was spent.
    rows(tour && tour.cashLog).forEach(function (x) {
      var k = x.category || null;
      if (!k || CASH_MOVES[k]) return;
      if (upTo && !(x.date && x.date <= upTo)) return;
      chargedTo[k] = (chargedTo[k] || 0) + num(x.amount);
    });

    // Pre-tour card money lands here as already-paid, category by category.
    var cardDetail = cardPaidDetail(tour, upTo);
    var cardTo = {};
    Object.keys(cardDetail).forEach(function (k) {
      cardTo[k] = cardDetail[k].reduce(function (t, r) { return t + r.amount; }, 0);
    });

    var expenses = normExpenses(tour && tour.expenses);
    var lines = [];
    var fixed = 0;

    typedCategoriesFor(tour).forEach(function (c) {
      var rec = expenses[c.key] || { projected: null, paid: 0 };
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

    var commissionProjected = commissionTotal(tour && tour.commission, showIncome, guarantees, incomeBy);
    // What the booking agent has earned so far, and what they hold as an
    // advance (every guarantee that came by agency deposit, all of it). The
    // advance is out of the band's hands whether or not it's earned yet, so
    // the agent's commission counts as at least what's held; everyone else's
    // commission is still owed on top of it.
    var agentOwed = commissionLine(COMMISSION_LINES.filter(function (l) { return l.key === 'agent'; })[0],
      normCommission(tour && tour.commission).agent, showIncome, guarantees, incomeBy);
    var agencyShows = agencyAdvance(shows);
    var advance = agencyShows.reduce(function (t, x) { return t + x.amount; }, 0);
    // Commission taken out of a guarantee before it was deposited is paid too,
    // and the agent's share of it sits with the agent, beside the advance.
    var kept = shows.reduce(function (t, s) { return t + guaranteeKept(s); }, 0);
    var keptAgent = shows.reduce(function (t, s) { return t + guaranteeKept(s, 'agent'); }, 0);
    var commissionCommitted = (commissionProjected - agentOwed) + Math.max(agentOwed, advance + keptAgent);
    var commissionPaid = (chargedTo.commission || 0) + advance + kept;
    var commissionEffective = Math.max(commissionCommitted, commissionPaid);
    lines.push({
      key: 'commission', label: 'Commission',
      projected: commissionCommitted, paid: commissionPaid, effective: commissionEffective,
      left: Math.max(0, commissionCommitted - commissionPaid),
      over: Math.max(0, commissionPaid - commissionCommitted)
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
      showIncome: showIncome, otherIncome: other, otherRows: otherRows,
      lines: lines, fixed: fixed,
      commission: commissionEffective, commissionProjected: commissionProjected,
      agencyShows: agencyShows, agencyAdvance: advance, agentOwed: agentOwed, commissionKept: kept,
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

  /* What's actually gone out or is owed, as of a calc: what's been spent in
     every category (card balances going in included), the commission on what
     has come in, loans, and the day-by-day costs. Never projections. */
  function spentOf(c) {
    var paid = c.lines.reduce(function (t, l) { return l.key === 'commission' ? t : t + num(l.paid); }, 0);
    return round((paid + num(c.commission) + num(c.debt) + num(c.dayByDay)) * 100) / 100;
  }

  /* The chart, day by day: money in (it only climbs) against what's spent
     and owed. It starts the day the tour does; anything spent before that is
     already in its first point. opts.until stops it there (today, while the
     tour is on). */
  function balanceSeries(tour, opts) {
    var o = opts || {};
    var c = calc(tour);
    var dated = c.allShows.filter(function (s) { return parseDay(s.date); });
    var extras = rows(tour && tour.extras).filter(function (x) { return parseDay(x.date); });
    var charges = rows(tour && tour.charges).filter(function (x) { return parseDay(x.date); });
    var cash = rows(tour && tour.cashLog).filter(function (x) { return parseDay(x.date); });

    var otherInc = rows(tour && tour.otherIncome).filter(function (x) { return parseDay(x.date); });

    var days = dated.map(function (s) { return s.date; })
      .concat(extras.map(function (x) { return x.date; }))
      .concat(charges.map(function (x) { return x.date; }))
      .concat(cash.map(function (x) { return x.date; }))
      .concat(otherInc.map(function (x) { return x.date; }));
    if (!days.length) return [];

    days.sort();
    var start = days[0], end = days[days.length - 1];
    var ts = tourStart(tour);
    if (ts && ts > start) start = ts;
    if (end < start) end = start;
    if (o.until && parseDay(o.until) && o.until >= start && o.until < end) end = o.until;
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
      series.push({ date: day, net: snap.net, income: snap.income, out: snap.out, spent: spentOf(snap) });
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
  /* Day sheet times, one look everywhere: "6:00PM". Typing "6", "630",
     "6:30" or "6.30" and picking AM or PM gets there; older entries like
     "7 pm", "7:00 PM" or "19:00" read the same way. Anything that isn't a
     time (TBA, "after the set") is left exactly as written. */
  function splitTime(v) {
    var t = String(v == null ? '' : v).trim();
    if (!t) return { main: '', ampm: '' };
    var m = /^(\d{1,2})(?:[:.]?(\d{2}))?\s*(?:([ap])\.?\s*m?\.?)?$/i.exec(t);
    if (!m) return { main: t, ampm: '' };
    var hr = +m[1], mins = m[2] || '00', ap = m[3] ? m[3].toUpperCase() + 'M' : '';
    if (+mins > 59 || hr > 23) return { main: t, ampm: '' };
    if (!ap && hr > 12) { ap = 'PM'; hr -= 12; }            // 19:00
    else if (!ap && hr === 0) { ap = 'AM'; hr = 12; }       // 0:30
    if (hr === 0) hr = 12;
    return { main: hr + ':' + mins, ampm: ap };
  }
  function joinTime(main, ampm) {
    var p = splitTime(main);
    if (!p.main) return '';
    if (!/^\d{1,2}:\d{2}$/.test(p.main)) return p.main;     // not a time: as written
    return p.main + (p.ampm || String(ampm || '').toUpperCase());
  }
  function cleanTime(v) { var p = splitTime(v); return joinTime(p.main, p.ampm); }

  /* The day sheet in the order the day happens, in sections: where you are
     (address, phone, wifi, parking), the schedule from lobby call to bus
     call, then the amenities and any notes. Only what the tour manager
     actually filled in; a section with nothing in it isn't there. */
  function daySheetSections(show) {
    var d = show && isObj(show.daySheet) ? show.daySheet : {};
    var out = [];
    var sec = function (key, title) { var x = { key: key, title: title, lines: [] }; out.push(x); return x; };
    var put = function (x, label, v) {
      v = String(v == null ? '' : v).trim();
      if (v) x.lines.push(label + ': ' + v);
    };
    var venue = sec('venue', 'Venue');
    put(venue, 'Address', d.venueAddress);
    put(venue, 'Venue phone', d.venuePhone);
    put(venue, 'Wifi', d.wifi);
    put(venue, 'Wifi password', d.wifiPass);
    put(venue, 'Parking', d.parking);
    var day = sec('schedule', 'Schedule');
    put(day, 'Lobby call', cleanTime(d.lobbyCall));
    put(day, 'Load in', cleanTime(d.loadIn));
    dsList(d.soundchecks).forEach(function (r) {
      day.lines.push('Soundcheck — ' + (String(r.band || '').trim() || 'TBA') + ': ' + (cleanTime(r.time) || 'TBA'));
    });
    put(day, 'VIP', d.vip);
    put(day, 'Doors', cleanTime(d.doors));
    dsList(d.setTimes).forEach(function (r) {
      day.lines.push((String(r.band || '').trim() || 'TBA') + ': ' + (cleanTime(r.time) || 'TBA'));
    });
    put(day, 'Load out', cleanTime(d.loadOut));
    put(day, 'Bus call', cleanTime(d.busCall));
    put(day, 'Drive to next venue', d.driveNext);
    var amen = [];
    DS_AMENITIES.forEach(function (a) {
      var v = d[a[0]];
      if (v === 'yes') amen.push(a[1] + ' yes');
      else if (v === 'no') amen.push('no ' + a[1].toLowerCase());
    });
    var am = sec('amenities', 'Amenities');
    if (amen.length) am.lines.push(amen.join(' · '));
    put(sec('notes', 'Notes'), 'Notes', d.notes);
    return out.filter(function (x) { return x.lines.length; });
  }

  // The same, as one flat list of lines.
  function daySheetLines(show) {
    return daySheetSections(show).reduce(function (all, x) { return all.concat(x.lines); }, []);
  }

  // Ready for the group chat: the night on top, then each section under its
  // own heading with a blank line between.
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
    var parts = daySheetSections(show).map(function (x) {
      return [x.title.toUpperCase()].concat(x.lines).join('\n');
    });
    return head.concat(parts).join('\n\n');
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
    commissionLines(comm).forEach(function (line) {
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

  /* A pasted pile of guest names — texts, an email, whatever — into rows.
     The offline fallback when Claude can't read it: one guest per line;
     "+1"s, "x4"s, emails, phones and (parenthesized) affiliations peel off. */
  function parseGuestList(text) {
    var out = [];
    String(text == null ? '' : text).split(/\r?\n|;/).forEach(function (raw) {
      var line = String(raw).replace(/^[\s\u2022*\u2013\u2014-]+/, '')
        .replace(/^\d{1,3}[.)]\s+/, '').trim();
      if (!line) return;
      var email = (line.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [''])[0];
      if (email) line = line.replace(email, ' ');
      var phone = (line.match(/\+?\d[\d\s().-]{6,}\d/) || [''])[0];
      if (phone) line = line.replace(phone, ' ');
      var qty = 1;
      var plus = line.match(/\+\s*(\d{1,2})\b/);
      var times = line.match(/\bx\s*(\d{1,2})\b/i);
      if (plus) { qty = Math.min(20, 1 + num(plus[1])); line = line.replace(plus[0], ' '); }
      else if (times) { qty = Math.max(1, Math.min(20, num(times[1]))); line = line.replace(times[0], ' '); }
      var affiliation = '';
      var par = line.match(/\(([^)]*)\)/);
      if (par) { affiliation = par[1].trim(); line = line.replace(par[0], ' '); }
      var parts = line.split(/,| \u2013 | \u2014 | - /);
      var name = String(parts[0] || '').replace(/\s+/g, ' ').trim()
        .replace(/[\u2013\u2014-]+$/, '').trim();
      if (!affiliation) affiliation = parts.slice(1).join(', ').replace(/\s+/g, ' ').trim();
      var words = name ? name.split(' ') : [];
      var row = {
        firstName: words[0] || '', lastName: words.slice(1).join(' '),
        affiliation: affiliation.slice(0, 80), email: email, phone: phone.trim(), qty: qty
      };
      if (row.firstName || row.email) out.push(row);
    });
    return out.slice(0, 100);
  }

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
        loadOut: cleanStr(r.loadOut, 40), lobbyCall: cleanStr(r.lobbyCall, 40), busCall: cleanStr(r.busCall, 40),
        wifi: cleanStr(r.wifi, 90), wifiPass: cleanStr(r.wifiPass, 90), parking: cleanStr(r.parking, 160),
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
    ['loadIn', 'vip', 'doors', 'loadOut', 'lobbyCall', 'busCall', 'wifi', 'wifiPass', 'parking', 'driveNext', 'notes']
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
    put('Wifi password', d.wifiPass);
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
  /* An atVenu read: the band's number is picked by rule from the printed
     lines, never taken on faith. What's due the artist; if the venue took
     nothing, the adjusted gross (the gross less card fees and tax). The gross
     is never the band's number when a smaller one is printed. Cash from the
     show below zero was cash paid out: nothing on hand, and a note says so. */
  function pickBandNumber(out) {
    var o = isObj(out) ? JSON.parse(JSON.stringify(out)) : {};
    var n = function (v) { var m = String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''); return m && m !== '-' ? Number(m) : NaN; };
    var tt = isObj(o.totals) ? o.totals : {};
    var due = n(tt.dueArtist), adj = n(tt.adjusted), venue = n(tt.dueVenue);
    o.income = isObj(o.income) ? o.income : {};
    var had = n(o.income.merch);
    if (due > 0) o.income.merch = round(due * 100) / 100;
    else if (adj > 0 && (venue === 0 || !(had > 0))) o.income.merch = round(adj * 100) / 100;
    var cash = n(o.cash);
    if (cash < 0) {
      o.cash = 0;
      o.notes = (Array.isArray(o.notes) ? o.notes : []).concat([{ label: 'Cash from show',
        value: '\u2212$' + (round(-cash * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' (cash paid out)' }]);
    }
    return o;
  }
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
    // Merch cash the table collected, when a merch report shows it.
    var cashRaw = src.cash != null ? src.cash : incSrc.cash;
    var cash = cashRaw == null || cashRaw === '' ? null : round(num(cashRaw) * 100) / 100;
    if (cash != null && !(cash >= 0)) cash = null;
    // The card side of an atVenu Settlement: card sales and the processing fee.
    var cards = isObj(src.cards) ? src.cards : {};
    var receipts = cards.receipts == null || cards.receipts === '' ? null : round(num(cards.receipts) * 100) / 100;
    var fee = cards.fee == null || cards.fee === '' ? null : round(Math.abs(num(cards.fee)) * 100) / 100;
    var cardsBy = /venue/i.test(String(src.cardsBy || '')) ? 'venue' : (/artist/i.test(String(src.cardsBy || '')) ? 'artist' : null);
    var cardDeposit = receipts != null && receipts >= 0 && cardsBy !== 'venue'
      ? round((receipts - (fee || 0)) * 100) / 100 : null;
    var type = String(src.reportType || '').toLowerCase();
    var reportType = /progress|tour/.test(type) ? 'tour_progress' : (/settle/.test(type) ? 'settlement' : (type ? 'other' : null));
    return { income: income, miscLabel: miscLabel, notes: notes, found: found, cash: cash,
      cardReceipts: receipts, cardFee: fee, cardDeposit: cardDeposit, cardsBy: cardsBy, reportType: reportType };
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
        INCOME_FIELDS.map(function (f) { return incomeOf(s, f.key) || ''; }),
        [showIncomeTotal(s) || '', settlementNoteText(s)]));
    });
    // Income on the book itself, under the nights: its amount lands in the
    // same column the show totals use, so the file still sums to the tour.
    c.otherRows.forEach(function (x) {
      showRows.push([x.date || '', 'Other income', otherKindLabel(x.kind), ''].concat(
        INCOME_FIELDS.map(function () { return ''; }), [num(x.amount), '']));
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
    commissionLines(comm).forEach(function (line) {
      var r = comm[line.key];
      commRows.push([line.label,
        r.mode === 'pct' ? r.value + '%' : 'Flat ' + money(r.value),
        r.mode === 'pct' ? (function () {
          var lbl = commissionBaseLabel(r);
          return lbl.charAt(0).toUpperCase() + lbl.slice(1) + ' ' +
            money(commissionBase(r, c.incomeBy) || 0);
        })() : '',
        round(commissionLine(line, r, c.showIncome, c.guarantees, c.incomeBy))]);
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
    COMMISSION_LINES: COMMISSION_LINES, commissionLines: commissionLines,
    INCOME_FIELDS: INCOME_FIELDS, buyoutIncome: buyoutIncome, incomeOf: incomeOf,
    OTHER_INCOME_KINDS: OTHER_INCOME_KINDS, otherKindLabel: otherKindLabel,
    HISTORY_TIERS: HISTORY_TIERS, LEGACY_BAR: LEGACY_BAR, historyTier: historyTier,
    BAND_ROLES: BAND_ROLES, ARTIST_CREW_ROLES: ARTIST_CREW_ROLES,
    creditGroupName: creditGroupName, creditTally: creditTally, creditClaim: creditClaim,
    creditSelection: creditSelection, tourTimeline: tourTimeline,
    CHARGE_CATEGORIES: CHARGE_CATEGORIES,
    extraCategories: extraCategories, typedCategoriesFor: typedCategoriesFor,
    chargeCategoriesFor: chargeCategoriesFor, slugCategory: slugCategory,
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
    vendorNorm: vendorNorm, vendorOf: vendorOf, vendorGroups: vendorGroups,
    showIncomeTotal: showIncomeTotal, crewProjection: crewProjection, newestFirst: newestFirst, spentOf: spentOf, crewPay: crewPay, payPeriods: payPeriods, payBook: payBook, payStanding: payStanding, MY_PAY_CATS: MY_PAY_CATS, payIncome: payIncome, MY_PAY_INCOME: MY_PAY_INCOME, payBalanceSeries: payBalanceSeries, tourKeyLoose: tourKeyLoose, mergeTourCandidates: mergeTourCandidates, tourKnown: tourKnown, paragraphsAbout: paragraphsAbout, etaText: etaText, parseCsv: parseCsv, readDay: readDay, concertRows: concertRows, concertItems: concertItems, tourDays: tourDays, agencyAdvance: agencyAdvance,
    commissionLine: commissionLine, commissionTotal: commissionTotal,
    commissionBase: commissionBase, commissionBaseLabel: commissionBaseLabel,

    cardDebts: cardDebts, otherDebts: otherDebts, cardSummary: cardSummary,
    guaranteeIn: guaranteeIn, merchDue: merchDue, showMoneyState: showMoneyState, showReceived: showReceived,
    GUARANTEE_REASONS: GUARANTEE_REASONS, guaranteeWhy: guaranteeWhy, guaranteeTotal: guaranteeTotal,
    guaranteeGap: guaranteeGap, guaranteeOwed: guaranteeOwed, guaranteeKept: guaranteeKept, guaranteeLost: guaranteeLost,
    CASH_MOVES: CASH_MOVES, cashSummary: cashSummary, cashByShow: cashByShow,
    cardPaidDetail: cardPaidDetail, preTourCutoff: preTourCutoff,
    tourStart: tourStart, tourEnd: tourEnd, cardWindow: cardWindow, cardMoved: cardMoved, cardPaidOff: cardPaidOff,

    calc: calc, stateOf: stateOf, caption: caption,
    balanceSeries: balanceSeries, latestChange: latestChange,
    normalizeSettlement: normalizeSettlement, pickBandNumber: pickBandNumber,
    DS_AMENITIES: DS_AMENITIES, daySheetSections: daySheetSections, daySheetLines: daySheetLines, daySheetText: daySheetText,
    splitTime: splitTime, joinTime: joinTime, cleanTime: cleanTime,
    toCSV: toCSV, closeoutCSVs: closeoutCSVs,
    offDayLines: offDayLines, offDayText: offDayText,
    GUEST_PASSES: GUEST_PASSES, guestSummary: guestSummary, guestListText: guestListText,
    parseGuestList: parseGuestList,
    normalizeTourImport: normalizeTourImport, mergeDaySheet: mergeDaySheet,
    budgetFrom: budgetFrom, hasBudget: hasBudget, crewKey: crewKey,
    dailyUpdate: dailyUpdate
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
