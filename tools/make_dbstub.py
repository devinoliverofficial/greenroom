"""Builds src/_dbstub.html: the real app in 'db' (signed-in) mode against an
in-memory fake backend, so account/crew UI can be tested locally without
signing anything into the live Supabase project. Run after build.py."""
import pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
page = (ROOT / 'src/index.html').read_text(encoding='utf-8')
# The gate's own screens (the role picker, the one-question screens, the pages
# for the documents) are not copied here: the stretch of site/backend.js
# between its two marks is lifted in as it stands, so the harness tries the
# real code. It goes where the shim says /*SHARED-SCREENS*/.
backend = (ROOT / 'site/backend.js').read_text(encoding='utf-8')
MARK_A, MARK_B = '/* <shared-screens>', '/* </shared-screens> */'
assert backend.count(MARK_A) == 1 and backend.count(MARK_B) == 1, 'the shared-screens marks are missing from site/backend.js'
shared = backend[backend.index(MARK_A):backend.index(MARK_B) + len(MARK_B)]
assert '</script' not in shared.lower(), 'the shared screens cannot be put inside a script tag as they stand'
shim = r"""<script>
/* ---- fake signed-in backend (dev only) ---- */
(function () {
  var today = new Date();
  var ymd = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  var tours = {
    t1: { name: 'Harness run', artist: 'I See Stars', setupDone: true, setupStep: 5, createdAt: 1,
      // Real-tour-sized numbers, so the Expenses Total row is tested at full width.
      expenses: { bus: { projected: 85000 }, hotels: { projected: 23400 }, food: { projected: 12500 },
        gas: { projected: 9800 }, flights: { projected: 18250 } }, commission: {},
      // One person on the list, so a payment typed under Crew can say who it paid.
      crew: { jm: { name: 'Jeff Mora', title: 'FOH Engineer', pay: 1500, payTyped: true, createdAt: 1 } },
      // A card linked to the app: its row leads the Expenses chart.
      debts: { d1: { id: 'd1', label: 'Business Gold Card \u2013 1008', amount: 3200, kind: 'card', breakdown: {},
        cutoff: ymd(new Date(today.getTime() - 20 * 864e5)), feed: { name: 'Business Gold Card \u2013 1008', bank: 'American Express' }, createdAt: 1 } },
      extras: {},
      charges: { c1: { id: 'c1', date: ymd(today), merchant: 'Prevost', amount: 21456.78, category: 'bus', manual: true, paid: false },
        c2: { id: 'c2', date: ymd(today), merchant: 'Marriott', amount: 4560, category: 'hotels', manual: true, paid: true },
        c3: { id: 'c3', date: ymd(today), merchant: 'Delta', amount: 6890, category: 'flights', manual: true, paid: false },
        // Before the first show: the chart folds it into its first day.
        c4: { id: 'c4', date: ymd(new Date(today.getTime() - 12 * 864e5)), merchant: 'Van rental', amount: 450, category: 'bus', manual: true, paid: true },
        // Monthly utilities, the way a bank spells them: these break down into vendor groups.
        u1: { id: 'u1', date: ymd(new Date(today.getTime() - 9 * 864e5)), merchant: 'AMZN Mktp US*2K4LT0Y93', amount: 42.17, category: 'utilities', manual: true, paid: false },
        u2: { id: 'u2', date: ymd(new Date(today.getTime() - 6 * 864e5)), merchant: 'Amazon.com*RT4G12', amount: 18.4, category: 'utilities', manual: true, paid: false },
        u3: { id: 'u3', date: ymd(new Date(today.getTime() - 8 * 864e5)), merchant: 'VZWRLSS*APOCC VISB', amount: 210.5, category: 'utilities', manual: true, paid: true },
        u4: { id: 'u4', date: ymd(new Date(today.getTime() - 7 * 864e5)), merchant: 'LA FITNESS 8005551234', amount: 39.99, category: 'utilities', manual: true, paid: false },
        u5: { id: 'u5', date: ymd(new Date(today.getTime() - 5 * 864e5)), merchant: 'PUBLIC STORAGE 28511', amount: 189, category: 'utilities', manual: true, paid: true },
        u6: { id: 'u6', date: ymd(new Date(today.getTime() - 5 * 864e5)), merchant: 'Extra Space 1234', amount: 164, category: 'utilities', manual: true, paid: false },
        // Jeff's pay, typed by hand two days before the bank's Zelle of the same amount (feed row z1): a possible double, named on the row.
        zp1: { id: 'zp1', date: ymd(new Date(today.getTime() - 3 * 864e5)), merchant: 'Pay: Jeff', amount: 500, category: 'crew', crewId: 'jm', manual: true, paid: true, createdAt: 2 } }, imports: {},
      bands: ['Opener Band', 'I See Stars'],
      shows: { s1: { id: 's1', date: ymd(today), city: 'Austin, TX', venue: 'Mohawk',
        daySheet: { doors: '7:00 PM', venueAddress: '912 Red River St, Austin, TX 78701' } },
        // Two nights already played and one ahead, for the Calendar's past days.
        s0: { id: 's0', date: ymd(new Date(today.getTime() - 4 * 864e5)), city: 'Dallas, TX', venue: 'Granada',
          loggedAt: 1, income: { guarantee: 1500, merch: 900 }, merchCash: 400,
          merchSquare: { sales: 1480, tips: 118, taps: 37, env: 'sandbox', net: 1551.4 } },
        s00: { id: 's00', date: ymd(new Date(today.getTime() - 2 * 864e5)), city: 'Houston, TX', venue: 'White Oak' },
        // Tomorrow too, so Today counts more than one day until the day off.
        s1b: { id: 's1b', date: ymd(new Date(today.getTime() + 864e5)), city: 'San Antonio, TX', venue: 'Paper Tiger' },
        s2: { id: 's2', date: ymd(new Date(today.getTime() + 3 * 864e5)), city: 'Phoenix, AZ', venue: 'Crescent' } },
      // Merch cash spent on food and gas: the Expenses tab's Cash column.
      cashLog: { k1: { id: 'k1', date: ymd(new Date(today.getTime() - 3 * 864e5)), category: 'food', amount: 120, note: 'Catering run' },
        k2: { id: 'k2', date: ymd(new Date(today.getTime() - 3 * 864e5)), category: 'gas', amount: 85.5, note: 'Fill up' } } },
    // The harness artist's Off Tour book (Budget, OFF TOUR): a few invented charges between tours (on
    // credit, by debit and in cash) and two deposits logged as income, one of them "Other" with the words
    // typed for it. Nothing is planned on it, so its big number reads "net so far"; type a projection on a
    // line and it reads "net, counting what is planned". See THE OFF TOUR FRAME below for the switches.
    off1: { kind: 'offtour', artist: 'I See Stars', name: 'Off Tour', setupDone: true, createdAt: 3,
      offFrom: ymd(new Date(today.getTime() - 60 * 864e5)).slice(0, 8) + '01',
      shows: {}, expenses: {},
      charges: {
        o1: { id: 'o1', date: ymd(new Date(today.getTime() - 41 * 864e5)), merchant: 'Rehearsal Room B', amount: 600, category: 'studio', manual: true, paid: true },
        o2: { id: 'o2', date: ymd(new Date(today.getTime() - 33 * 864e5)), merchant: 'String and Stick Supply', amount: 219.5, category: 'supplies', manual: true, paid: false },
        o3: { id: 'o3', date: ymd(new Date(today.getTime() - 21 * 864e5)), merchant: 'PUBLIC STORAGE 28511', amount: 189, category: 'utilities', manual: true, paid: true },
        o4: { id: 'o4', date: ymd(new Date(today.getTime() - 12 * 864e5)), merchant: 'Van service', amount: 840.75, category: 'transport', manual: true, paid: false },
        o5: { id: 'o5', date: ymd(new Date(today.getTime() - 6 * 864e5)), merchant: 'Parking', amount: 40, category: 'transport', manual: true, paid: true, cash: true } },
      otherIncome: {
        i1: { id: 'i1', date: ymd(new Date(today.getTime() - 30 * 864e5)), amount: 1850, kind: 'royalties' },
        i2: { id: 'i2', date: ymd(new Date(today.getTime() - 9 * 864e5)), amount: 500, kind: 'other', label: 'Sync licence' } } }
  };
  var subs = [];
  // Same merge-write as the real backend: nested objects merge.
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function deepMerge(t, p) {
    Object.keys(p).forEach(function (k) {
      if (isObj(p[k]) && isObj(t[k])) t[k] = deepMerge(t[k], p[k]); else t[k] = p[k];
    });
    return t;
  }
  function snap() {
    return { docs: Object.keys(tours).map(function (id) {
      return { id: id, exists: true, data: function () { return JSON.parse(JSON.stringify(tours[id])); } }; }) };
  }
  function emit() { subs.forEach(function (cb) { cb(snap()); }); }
  // Labels (artist folders, logos, your profile) are kept and played back the
  // way the real store does: a write lands, then a fresh snapshot arrives.
  var labels = {}, labelSubs = [];
  function labelSnap() {
    return { docs: Object.keys(labels).map(function (id) {
      return { id: id, exists: true, data: function () { return JSON.parse(JSON.stringify(labels[id])); } }; }) };
  }
  function emitLabels() { labelSubs.forEach(function (cb) { cb(labelSnap()); }); }
  var db = {
    collection: function (name) { return { onSnapshot: function (cb) {
      if (name === 'tours') { subs.push(cb); setTimeout(function () { cb(snap()); }, 0); }
      else if (name === 'labels') { labelSubs.push(cb); setTimeout(function () { cb(labelSnap()); }, 0); }
      else setTimeout(function () { cb({ docs: [] }); }, 0);
      return function () {}; } }; },
    doc: function (path) {
      var id = path.split('/')[1];
      if (path.indexOf('labels/') === 0) return {
        get: function () { return Promise.resolve({ exists: !!labels[id], data: function () { return labels[id]; } }); },
        set: function (v) { labels[id] = JSON.parse(JSON.stringify(v)); setTimeout(emitLabels, 0); return Promise.resolve(); },
        update: function (v) { labels[id] = Object.assign({}, labels[id], JSON.parse(JSON.stringify(v))); setTimeout(emitLabels, 0); return Promise.resolve(); },
        delete: function () { delete labels[id]; setTimeout(emitLabels, 0); return Promise.resolve(); }
      };
      return {
        get: function () { return Promise.resolve({ exists: !!tours[id], data: function () { return tours[id]; } }); },
        set: function (v) { if (path.indexOf('tours/') === 0) { tours[id] = v; emit(); } return Promise.resolve(); },
        update: function (v) { if (path.indexOf('tours/') === 0) { tours[id] = deepMerge(JSON.parse(JSON.stringify(tours[id])), JSON.parse(JSON.stringify(v))); emit(); } return Promise.resolve(); },
        delete: function () { delete tours[id]; emit(); return Promise.resolve(); }
      };
    }
  };
  // A fake reader: flyer readings come from __harness.flyers when a test has
  // set it to a list, one list per read; anything else reads as nothing.
  // (Out of the box __harness.flyers is the TOUR FLYERS seeding function,
  // further down, so only a list put there on purpose feeds the reader.)
  var fakeSample = function () { return Promise.resolve({ text: '' }); };
  fakeSample.json = function (prompt) {
    window.__harness.reads = (window.__harness.reads || 0) + 1;
    if (/concert tour flyer/.test(String(prompt))) return Promise.resolve((Array.isArray(window.__harness.flyers) ? window.__harness.flyers : []).shift() || []);
    // The tour finder's reading: two tours out of the pretend archives.
    if (/TOUR FINDER/.test(String(prompt))) return Promise.resolve([
      { name: 'Let Light Overcome the Darkness Tour', role: 'support', start: '2019-11-05', end: '2019-12-08', region: 'US', lineup: 'Our Last Night, The Word Alive, Ashland',
        dates: ['2019-11-05 | Omaha, NE | Slowdown', '2019-12-08 | Lake Buena Vista, FL | House of Blues'], source: 'https://www.theprp.com/2019/09/x/' },
      { name: 'Spring 2018 run with Dance Gavin Dance', role: 'support', start: '2018-05-26', end: '2018-06-21', region: 'US/Canada', lineup: 'Dance Gavin Dance, Erra, Sianvar',
        dates: [{ date: '2018-05-26', city: 'San Antonio, TX', venue: 'Aztec Theatre' }], source: 'https://lambgoat.com/news/2/x/' }]);
    if (/concert venue with web search/.test(String(prompt))) {
      window.__harness.venueAsks = (window.__harness.venueAsks || []).concat([{ prompt: String(prompt), opts: arguments[1] || {} }]);
      var v = window.__harness.venue || { address: null, phone: null };
      return new Promise(function (res) { setTimeout(function () { res(v); }, 300); });
    }
    /* More info on one bank or card line. Every prompt is kept, with its
       options, in __harness.infoAsks, so a test can read exactly what was
       sent. The answer is __harness.info when set; else a fixed one (for a
       charge: under 'gas' when the prompt offers that key, else the first key
       it offers; for a deposit: words that name no night). __harness.infoFail
       rejects with that code; __harness.infoSlow waits that many ms first.
       A stopped question rejects 'cancelled', as the real reader does. */
    /* The category for each line of a sorting sheet, asked by itself as the
       sheet opens (askLineCats). Every prompt is kept in __harness.catAsks.
       The answer is __harness.catAnswer when set (an object from line number
       to key, or a function (lines) -> that object); else each line by its
       name: a travel stop or a gas station is 'gas', a hotel 'hotels', a bus
       'bus', a music shop 'supplies', when the prompt offers that key, and
       anything else null. __harness.catSlow (or ?catslow=1500) waits that
       many ms first, default 700, so the Suggested mark is seen arriving;
       __harness.catFail rejects with that code. */
    if (/^CHARGE CATEGORIES\./.test(String(prompt))) {
      var Hc = window.__harness, oc = arguments[1] || {}, ctext = String(prompt);
      Hc.catAsks = (Hc.catAsks || []).concat([{ prompt: ctext, opts: oc }]);
      var coffered = {};
      ((ctext.split('CATEGORIES (key: label)')[1] || '').split('WHAT TO DO')[0]).split('\n').forEach(function (ln) {
        var mk = /^([a-z0-9-]+): /.exec(ln); if (mk) coffered[mk[1]] = true;
      });
      var clines = ((ctext.split('THE LINES')[1] || '').split('About the names')[0]).split('\n').slice(1).filter(Boolean)
        .map(function (ln) { var parts = ln.split(' | '); return { n: parts[0], name: parts[1] || '' }; });
      var guess = function (name) {
        var k = /buc|shell|exxon|love’s|fuel|gas/i.test(name) ? 'gas' : /hotel|marriott|inn\b/i.test(name) ? 'hotels'
          : /\bbus\b|nightliner/i.test(name) ? 'bus' : /guitar|sweetwater|music/i.test(name) ? 'supplies' : null;
        return k && coffered[k] ? k : null;
      };
      var cans = typeof Hc.catAnswer === 'function' ? Hc.catAnswer(clines) : Hc.catAnswer;
      if (!cans) { cans = {}; clines.forEach(function (l) { cans[l.n] = guess(l.name); }); }
      var cslowQ = null; try { cslowQ = /[?&]catslow=(\d{1,5})\b/.exec(String(location.search || '')); } catch (e) { cslowQ = null; }
      var cwait = Hc.catSlow != null ? Number(Hc.catSlow) : cslowQ ? Number(cslowQ[1]) : 700;
      return new Promise(function (res, rej) {
        var stopped = function () { rej(Object.assign(new Error('cancelled'), { code: 'cancelled' })); };
        if (oc.signal && oc.signal.aborted) { stopped(); return; }
        var timer = setTimeout(function () {
          if (Hc.catFail) rej(Object.assign(new Error(String(Hc.catFail)), { code: Hc.catFail }));
          else res(JSON.parse(JSON.stringify(cans)));
        }, cwait || 0);
        if (oc.signal && oc.signal.addEventListener) oc.signal.addEventListener('abort', function () { clearTimeout(timer); stopped(); });
      });
    }
    if (/^CHARGE INFO\./.test(String(prompt))) {
      var H = window.__harness, o = arguments[1] || {}, text = String(prompt);
      H.infoAsks = (H.infoAsks || []).concat([{ prompt: text, opts: o }]);
      var isDep = /^Kind: a deposit/m.test(text);
      var offered = (text.split('CATEGORIES IT COULD BE FILED UNDER')[1] || '').split('WHAT TO DO')[0];
      var first = /^([a-z0-9-]+): /m.exec(offered);
      var key = /^gas: /m.test(offered) ? 'gas' : first ? first[1] : null;
      var ans = H.info || (isDep
        ? { what: 'The numbers alone do not say what this deposit was for.',
            why: ['The bank gives only the date and the amount for money coming in.'], sure: 'low' }
        : { what: 'Most likely fuel and snacks at a highway travel stop.',
            why: ['The name is a chain of travel stops along the interstate.', 'The tour had a show within two days of that date.',
              'The amount is about what a van fill-up and a few snacks cost.'],
            category: key, sure: o.search ? 'high' : 'medium' });
      return new Promise(function (res, rej) {
        var stopped = function () { rej(Object.assign(new Error('cancelled'), { code: 'cancelled' })); };
        if (o.signal && o.signal.aborted) { stopped(); return; }
        var timer = setTimeout(function () {
          if (H.infoFail) rej(Object.assign(new Error(String(H.infoFail)), { code: H.infoFail }));
          else res(JSON.parse(JSON.stringify(ans)));
        }, Number(H.infoSlow) || 0);
        if (o.signal && o.signal.addEventListener) o.signal.addEventListener('abort', function () { clearTimeout(timer); stopped(); });
      });
    }
    return Promise.resolve([]);
  };
  fakeSample.limits = function () { return Promise.resolve({ images: { mediaTypes: ['image/png', 'image/jpeg'], maxInputBytes: 5000000 } }); };
  // (With ?legal in the address the documents come first, as at a real start-up: nothing is handed over until
  // they are agreed to. gateDone is called further down, once __harness exists.)
  var gateDone, gatePassed = new Promise(function (res) { gateDone = res; });
  window.claude = { use: function (n) { return gatePassed.then(function () { return n === 'db' ? db : (n === 'sample' ? fakeSample : null); }); } };
  var me = { first_name: 'Devin', last_name: 'Oliver', full_name: 'Devin Oliver', username: 'Devin Oliver',
    phone: '555-0100', tour_role: 'Artist' };
  // The artists that endorsed the test Devin: one still on Greenroom, one whose page is gone.
  /* Tour credits, in memory. Only the test "I See Stars" has a history to
     confirm against: three tours and a year of loose nights. A claim from
     Brent waits on it, so the artist's approve screen has something to show. */
  var CREDIT_TOURS = [
    { key: 'SPN WL', name: 'Spin the Wheel', year: false, n: 4, first: '2026-02-26', last: '2026-05-09' },
    { key: 'TRHS', name: 'Treehouse Tour', year: false, n: 3, first: '2017-03-08', last: '2017-06-09' },
    { key: 'TJTL RNKT', name: 'Digital Renegade', year: false, n: 5, first: '2012-03-01', last: '2012-05-20' },
    { key: 'year:2024', name: '', year: true, n: 3, first: '2024-02-01', last: '2024-11-20' }];
  var CREDIT_CITIES = ['Dallas', 'Austin', 'Houston', 'Phoenix', 'Denver'];
  // The pretend encyclopedia (MusicBrainz), and the pages nobody runs.
  var MB = [
    { mbid: '11111111-1111-4111-8111-111111111111', name: 'Sleeping With Sirens', about: '', country: 'US' },
    { mbid: '22222222-2222-4222-8222-222222222222', name: 'Bring Me the Horizon', about: 'British rock band', country: 'GB' },
    { mbid: '33333333-3333-4333-8333-333333333333', name: 'Dance Gavin Dance', about: '', country: 'US' },
    { mbid: '44444444-4444-4444-8444-444444444444', name: 'Nirvana', about: '90s US grunge band', country: 'US' },
    { mbid: '55555555-5555-4555-8555-555555555555', name: 'Nirvana', about: '60s UK psychedelic band', country: 'GB' },
    { mbid: '66666666-6666-4666-8666-666666666666', name: 'I See Stars', about: '', country: 'US' },
    { mbid: '77777777-7777-4777-8777-777777777777', name: 'U2', about: 'Irish rock band', country: 'IE' },
    { mbid: '88888888-8888-4888-8888-888888888888', name: 'Godspeed You! Black Emperor', about: 'Canadian post-rock collective', country: 'CA' }
  ];
  function ghostList() {
    var H = window.__harness;
    if (!H.ghosts) {
      H.ghosts = [{ id: 'pub1', handle: 'mb.11111111111141118111', name: 'Sleeping With Sirens', mbid: MB[0].mbid, about: '', country: 'US', owner: null, checked: true }];
      H.claims = (H.claims || []).concat([{ id: 'cl1', artistId: 'pub1', userId: 'u-brent', note: 'I tour-manage them. Ask their management.',
        link: 'https://example.com/sws-crew', role: 'Guitar', links: { spotify: 'https://open.spotify.com/artist/3N8Hy6xQnQv1F1XCiyGQqA', instagram: 'https://instagram.com/sleepingwithsirens', website: '' },
        code: 'GR-7KQ2MX', status: 'pending', at: new Date(Date.now() - 36e5).toISOString() }]);
      H.histories = H.histories || {};
      H.histories.pub1 = { artist_id: 'pub1', status: 'ok', detail: '', total: 58, pages: 3, next_page: 0, synced_at: new Date(Date.now() - 864e5).toISOString(),
        mb_url: 'https://www.setlist.fm/setlists/example.html', auto: true,
        summary: { shows: 58, tours: 3, countries: 4, cities: 41, firstYear: 2010, lastYear: 2026,
          toursList: [{ name: 'Feel Tour', n: 30, first: '2025-03-01', last: '2025-04-12', lineup: 'Our Last Night, The Word Alive, Ashland' }] } };
    }
    return H.ghosts;
  }
  // Is this person on that artist's page now (listed, and not left)?
  function listedOn(artistId, userId) {
    var a = ((window.__harness.acts) || []).filter(function (x) { return x.id === artistId; })[0];
    return !!(a && (a.members || []).some(function (m) { return m.userId === userId && !m.leftAt; }));
  }
  function creditShowsOf(key) {
    var g = CREDIT_TOURS.filter(function (x) { return x.key === key; })[0];
    if (!g) return [];
    var out = [], start = new Date(g.first + 'T12:00:00Z').getTime();
    for (var i = 0; i < g.n; i++) {
      out.push({ id: key + '#' + i, date: new Date(start + i * 3 * 864e5).toISOString().slice(0, 10),
        city: CREDIT_CITIES[i % CREDIT_CITIES.length], state: 'Texas', country: i === 4 ? 'GB' : 'US', venue: 'Venue ' + (i + 1) });
    }
    return out;
  }
  function creditStore() {
    var H = window.__harness;
    if (!H.creditRows) H.creditRows = {};
    return H.creditRows;
  }
  function creditIss() { return ((window.__harness.acts) || []).filter(function (a) { return /i see stars/i.test(a.name || ''); })[0] || null; }
  function creditSeed() {
    var H = window.__harness, iss = creditIss();
    if (!iss || H.creditSeeded) return;
    H.creditSeeded = true;
    creditStore()[iss.id + ':u-brent'] = { approved: null, pending: { picks: [{ key: 'TRHS', mode: 'all', role: 'Backline tech, Driver' },
      { key: 'TJTL RNKT', mode: 'shows', shows: ['TJTL RNKT#0', 'TJTL RNKT#1'] }], until: '2026-10-07' },
      submittedAt: new Date(Date.now() - 36e5).toISOString(), declinedAt: null };
  }
  function creditExpand(claim) {
    if (!claim) return [];
    return CREDIT_TOURS.map(function (g) {
      var n = 0, role = '';
      if (claim.all) n = g.n;
      else (claim.picks || []).forEach(function (p) { if (p.key === g.key) { n = p.mode === 'shows' ? (p.shows || []).length : g.n; role = p.role || ''; } });
      return n ? { key: g.key, name: g.name, year: g.year, fest: !!g.fest, total: g.n, n: n, first: g.first, last: g.last, role: role } : null;
    }).filter(Boolean);
  }
  // "I was on this tour" (0146): the pretend archive's tour for a name the artist's page shows. A tour of the
  // page's list that the pretend archive has no entry for is given one the first time it is claimed.
  function creditTourKey(name) {
    var low = String(name || '').trim().toLowerCase();
    var g = CREDIT_TOURS.filter(function (x) { return !x.year && x.name.toLowerCase() === low; })[0];
    return g ? g.key : 'T:' + low.toUpperCase();
  }
  function creditTourByName(artistId, name) {
    var H = window.__harness, low = String(name || '').trim().toLowerCase();
    var g = CREDIT_TOURS.filter(function (x) { return !x.year && x.name.toLowerCase() === low; })[0];
    if (g) return g;
    var hr = (H.histories || {})[artistId];
    var t = ((hr && hr.summary && hr.summary.toursList) || []).filter(function (x) { return x.kind !== 'shows' && String(x.name || '').trim().toLowerCase() === low; })[0];
    if (!t) return null;
    // (fest: a festival's entry. 0147: it is its own thing, listed as a festival on the profile and never counted as a tour.)
    g = { key: creditTourKey(t.name), name: t.name, year: false, fest: t.kind === 'festival', n: t.n || 1, first: t.first || '2025-01-01', last: t.last || t.first || '2025-01-01' };
    CREDIT_TOURS.push(g);
    return g;
  }
  function creditPickOf(claim, key) {
    if (!claim) return null;
    if (claim.all) return { key: key, mode: 'all' };
    return (claim.picks || []).filter(function (p) { return p.key === key; })[0] || null;
  }
  function creditCount(claim) {
    var l = creditExpand(claim);
    return { tours: l.filter(function (g) { return !g.year && !g.fest; }).length, shows: l.reduce(function (n, g) { return n + g.n; }, 0) };
  }
  // What's approved for one person, across artists: the sums a profile card carries.
  function creditSums(uid) {
    creditSeed();
    var rows = creditStore(), out = { tours: 0, shows: 0, first: 0, credits: [], list: [] }, iss = creditIss();
    Object.keys(rows).forEach(function (k) {
      if (k.split(':')[1] !== uid || !rows[k].approved) return;
      var c = creditCount(rows[k].approved), aid = k.split(':')[0];
      out.tours += c.tours; out.shows += c.shows;
      out.credits.push({ artistId: aid, tours: c.tours, shows: c.shows });
      creditExpand(rows[k].approved).forEach(function (g) {
        var y = parseInt(g.first.slice(0, 4), 10);
        if (!out.first || y < out.first) out.first = y;
        // (0147) A festival is listed as one, on its own, with its role; it is not one of their tours.
        if (!g.year) out.list.push({ artistId: aid, artist: iss ? iss.name : 'Artist', key: g.fest ? '' : g.key, name: g.name, n: g.n, first: g.first, last: g.last,
          kind: g.fest ? 'festival' : 'tour', role: g.role || '' });
      });
    });
    return out;
  }
  function devinActs() {
    var H = window.__harness;
    if (!H.devinActs) H.devinActs = [
      { id: 'a-sws', name: 'Sleeping With Sirens', handle: 'sws', avatar: '', kind: 'crew', endorsed: true, eid: 'e-sws' },
      { id: null, name: 'Old Band', handle: '', avatar: '', kind: 'band', endorsed: true, past: true, eid: 'e-old' }];
    return H.devinActs;
  }
  window.__harness = { me: me, crew: [
    { owner: true, role: 'owner', userId: 'u-devin', name: 'Devin Oliver', email: 'devin@example.com', phone: '555-0100', tourRole: 'Artist', joined: true },
    { owner: false, role: 'editor', manager: true, userId: 'u-brent', name: 'Brent Allen', email: 'brent@example.com', invitedEmail: 'brent@example.com', phone: '(313) 555-0142', tourRole: 'Guitar Tech', joined: true },
    { owner: false, role: 'viewer', userId: null, name: 'Tasha Lane', email: 'tasha@example.com', invitedEmail: 'tasha@example.com', phone: '', tourRole: 'Production Manager', joined: false }
  ] };
  var d0 = ymd(today);
  window.__harness.feed = {
    row: { switched_on: false, plan_name: '', since: null, last_run: null, last_status: '', source: 'plaid' },
    banks: [{ id: 'b1', name: 'Bank of America', status: 'ok' }, { id: 'b2', name: 'American Express', status: 'ITEM_LOGIN_REQUIRED' }],
    accounts: [
      { id: 'ac1', name: 'Corp Account Bank Of America \u2013 4918', type: 'creditCard', mode: 'log', bank: 'b1' },
      { id: 'ac2', name: 'Merch \u2013 1885', type: 'checking', mode: 'ask', bank: 'b1' },
      { id: 'ac3', name: 'Business Adv Relationship \u2013 5370', type: 'checking', mode: 'ask', bank: 'b1' },
      { id: 'ac4', name: 'Business Gold Card \u2013 1008', type: 'creditCard', mode: 'log', bank: 'b2' }
    ],
    items: [
      { id: 'y1', tour_id: 't1', date: d0, merchant: 'Buc-Ee\u2019s', amount: 64.12, category: null, account: 'Business Gold Card \u2013 1008', why: 'New merchant' },
      { id: 'y2', tour_id: null, date: d0, merchant: 'Guitar Center', amount: 89.99, category: null, account: 'Merch \u2013 1885', why: 'From Merch \u2013 1885' },
      { id: 'y3', tour_id: 't1', date: d0, merchant: 'Hotel Van Zandt', amount: 212.4, category: 'hotels', account: 'Business Gold Card \u2013 1008', why: 'Maybe already in' },
      { id: 'y4', tour_id: 't1', date: d0, merchant: 'Marriott', amount: -120, category: 'hotels', account: 'Business Gold Card \u2013 1008', why: 'Refund' },
      // A bank-style name as long as they really come: the row must still show all of itself.
      { id: 'y5', tour_id: 't1', date: d0, merchant: 'AMAZON MKTPL*2X4Y67ZQ3 AMZN.COM/BILL WA 98109', amount: 1249.37, category: null, account: 'Business Gold Card \u2013 1008', why: 'New merchant' },
      // Money sent from a bank account, as the catch-up brings it in: a Zelle (the same amount as
      // Jeff's pay typed two days earlier, charge zp1), a wire, and a transfer that may be a move
      // between his own accounts (a long reason: it must wrap inside the row).
      { id: 'z1', tour_id: 't1', date: ymd(new Date(today.getTime() - 864e5)), merchant: 'Zelle payment to Jeff Mora', amount: 500, category: null, account: 'Merch \u2013 1885', why: 'Zelle' },
      { id: 'w1', tour_id: 't1', date: ymd(new Date(today.getTime() - 3 * 864e5)), merchant: 'Wire to Nightliner Bus Co', amount: 4200, category: null, account: 'Merch \u2013 1885', why: 'Wire' },
      { id: 'x1', tour_id: 't1', date: ymd(new Date(today.getTime() - 2 * 864e5)), merchant: 'Online Transfer to CHK 1885', amount: 1500, category: null, account: 'Business Adv Relationship \u2013 5370', why: 'Transfer \u00b7 may be a move to Merch \u00b7\u00b71885' }
    ]
  };
  window.__harness.calls = []; window.__harness.feedFns = [];
  // A Crew phone: __harness.asCrew = true before the tour is opened, or the page opened with ?crew.
  try { if (/[?&]crew\b/.test(String(location.search || ''))) window.__harness.asCrew = true; } catch (e) { /* no address to read */ }
  try { if (/[?&]placeslow\b/.test(String(location.search || ''))) window.__harness.placesReadyAt = Date.now() + 1500; } catch (e) { /* no address to read */ }
  // A Manager who did not create the tour (tour role Tour Manager): __harness.asManager = true before the tour is opened, or ?manager.
  try { if (/[?&]manager\b/.test(String(location.search || ''))) window.__harness.asManager = true; } catch (e) { /* no address to read */ }
  /* ---- THE PROFILE NUMBERS: a profile card that comes late, fails, or comes back empty ----
     The four numbers on your own profile (tours, shows, countries, cities) come with your profile card. The
     app keeps the last real ones on the phone (localStorage "gr-road:u-devin" here) and draws those until a
     newer real answer arrives; the single "tours" stand-in is only for a phone that has never had an answer.
     SWITCHES (they act on every profile card asked for from then on, yours and other people's):
       __harness.cardLate = 4000    each answer takes that many milliseconds.     Or  ?cardlate=4000
       __harness.cardFail = true    each ask fails, as with no signal.             Or  ?cardfail
       __harness.cardEmpty = true   each answer comes back with nothing in it.     Or  ?cardempty
       __harness.roadStats = {...}  the numbers the test Devin's card carries (tours, shows, countries,
                                    cities, firstYear), as before.
       __harness.cardAsks           how many times a card has been asked for.
     (A card is asked for again a minute after the last answer, or at once with View profile.)
     TO SEE THE NUMBERS HOLD: open the page once as it is (the card arrives, the numbers are kept), then open it
     again with ?cardlate=4000 : the four numbers are there from the first frame and stay. With ?cardfail or
     ?cardempty they are still there and nothing replaces them.
     The followers and following line under the photo, and the check by the name, are kept with the numbers
     and hold the same way. An empty answer for YOUR OWN card is taken as an ask that went wrong, not a profile
     that is gone: with __harness.cardEmpty set after the page has opened, View profile still opens your page;
     with ?cardempty from the start it says it could not load (never "This profile isn't available").
     ALSO KEPT, DRAWN NOWHERE: in the same localStorage entry, "at" (when the numbers were last got) and "trail"
     (the last 30 times this phone saw them change: when, when it had last got them before, what they were).
     To see one: open the page, set __harness.roadStats to other numbers, wait a minute or tap View profile,
     then JSON.parse(localStorage.getItem('gr-road:u-devin')).trail .
     TO SEE A PHONE THAT NEVER HAD AN ANSWER: localStorage.removeItem('gr-road:u-devin') , then open with
     ?cardlate=4000 : one number for four seconds (how many tours the harness account has), then the four.
     THE TOURS TAB IS NEVER SILENTLY SHORT (2026-10-16, his bug "my tour tab on my user side doesnt show all
     the tours"): the profile's Tours tab draws the confirmed tours from this same card, so with the card still
     on its way it now says "Loading your confirmed tours." where they belong (open with ?cardlate=4000, Tours
     tab), and after a failed ask "Your confirmed tours could not load. It keeps trying on its own." (open with
     ?cardfail) - never an empty space that reads as no tours. A card that is here with nothing confirmed shows
     nothing there, as before. */
  try {
    var cardAsk = String(location.search || ''), cardLate = /[?&]cardlate=(\d{1,5})\b/.exec(cardAsk);
    if (cardLate) window.__harness.cardLate = Number(cardLate[1]);
    if (/[?&]cardfail\b/.test(cardAsk)) window.__harness.cardFail = true;
    if (/[?&]cardempty\b/.test(cardAsk)) window.__harness.cardEmpty = true;
  } catch (e) { /* no address to read */ }
  /* ---- THE OFF TOUR FRAME: the Off Tour book, and an account with no tour on the road ----
     As the page opens, the harness tour ("Harness run") is on the road today and its artist has an Off Tour
     book (off1 above: five charges and two income entries, Royalties and an "Other" called Sync licence).
     TO SEE OFF TOUR INSIDE A TOUR: Budget (on the bottom bar, from anywhere), then the OFF TOUR tab: the
     same top tabs with OFF TOUR lit, Expenses | Cards/Links | Income for the book, the tour's bottom bar; the
     left tab (the tour's name) goes back to the tour's Budget.
     SWITCHES:
       __harness.offTour('next')   no tour is on the road and one is on the calendar: the harness tour's shows
                                   move a month into the past, "Winter run" starts in 26 days, and "Spring run"
                                   (last year) joins the list so "Tours" has two years. The profile's Overview
                                   button opens Winter run ("Next on the calendar"); its Budget tab lands on
                                   OFF TOUR with Tours | MY PAY | OFF TOUR on top.
       __harness.offTour('none')   the same with nothing on the calendar: Overview opens the frame that says
                                   "No tour on the calendar yet" on every tab, and offers Create a tour.
       __harness.offTour('travel') like 'next', but Winter run's own days have begun: two days were added before
                                   its first show (they started yesterday) and the first show is in two days.
                                   Nobody is on a stage today, yet the app is in tour mode: Overview opens Winter
                                   run with no "Next on the calendar" line, and its Budget tab opens the tour's
                                   own Budget with Winter run | MY PAY | OFF TOUR on top.
       __harness.offTour(false)    back to the harness tour on the road today (the two extra tours go).
       (Setting it works too:  __harness.offTour = 'next'  /  'none'  /  'travel'  /  false. What it is now:
       __harness.offTourNow.)
       Or open the page with  ?offtour=next ,  ?offtour=none  or  ?offtour=travel  (add &crew or &manager for
       those phones).
       __harness.undated(true)     adds two tours that have no dates yet: "Idea for a run" (its setup finished
                                   long ago) and "Half-made run" (still in setup). Neither is ever "next on the
                                   calendar". With offTour('none') the Overview page lists them under "No tour on
                                   the calendar yet", each with "Add its shows" (the first opens its Add shows
                                   page, the second the rest of its setup).  undated(false)  takes them away.
                                   Or add  &undated  to the address.
       __harness.offBook(false)    takes the Off Tour book away, as for an artist who has never opened OFF TOUR.
                                   Off tour, Budget then lands on "Start the Off Tour book" (one button, for the
                                   artist's owner; nothing is started by landing there). The OFF TOUR tab of a
                                   tour's own Budget still starts an empty one on the tap, as it always did.
                                   offBook(true)  puts the seeded book back.
       __harness.offYear(true)     THE BOOK'S GRAPH, MONTH BY MONTH. The seeded book only has the last six weeks on
                                   it, so its graph is two bars. This fills it with a year shaped like the live one:
                                   charges from January to this month (most of them April to June, one a refund,
                                   and a month with nothing spent), money in on four months, one charge dated next
                                   month (months to come stay dashed outlines; the quiet line under the graph says
                                   what is dated ahead), and a total typed straight into Studio, which has no date
                                   (the quiet line names it too). Two more tours of the artist join the list,
                                   "March run" (about seven months ago) and "Summer festivals" (about two months
                                   ago), so the graph has three shaded bands with the harness tour's own.
                                   Budget, OFF TOUR, Expenses shows it: tap or drag across the months, or focus the
                                   graph and use the arrow keys.  offYear(false)  puts the seeded book back and
                                   takes the two tours away. Or add  &offyear  to the address. For the empty
                                   book's graph (twelve dashed outlines): elsewhere(), or offBook(false) and the
                                   OFF TOUR tab of the tour's Budget.
     (elsewhere(), further down, still swaps the book for the empty one it always made, with a row waiting on it.) */
  var inDays = function (n) { return ymd(new Date(today.getTime() + n * 864e5)); };
  var runDays = { s0: -4, s00: -2, s1: 0, s1b: 1, s2: 3 };
  var seededBook = JSON.stringify(tours.off1);
  var setOffTour = function (kind) {
    var off = kind === 'next' || kind === 'none' || kind === 'travel';
    Object.keys(runDays).forEach(function (k) { if (tours.t1.shows[k]) tours.t1.shows[k].date = inDays(runDays[k] - (off ? 31 : 0)); });
    delete tours.tnext; delete tours.tpast;
    if (off) {
      tours.tpast = { name: 'Spring run', artist: tours.t1.artist, setupDone: true, setupStep: 5, createdAt: 0, expenses: { bus: { projected: 30000 } }, commission: {},
        crew: {}, debts: {}, extras: {}, imports: {},
        charges: { q1: { id: 'q1', date: (today.getFullYear() - 1) + '-04-10', merchant: 'Coach hire', amount: 28500, category: 'bus', manual: true, paid: true } },
        shows: { p1: { id: 'p1', date: (today.getFullYear() - 1) + '-04-11', city: 'Tulsa, OK', venue: 'Cain\u2019s', loggedAt: 1, income: { guarantee: 9000, merch: 2100 } },
          p2: { id: 'p2', date: (today.getFullYear() - 1) + '-04-12', city: 'Wichita, KS', venue: 'The Cotillion', loggedAt: 1, income: { guarantee: 12000, merch: 2600 } } } };
    }
    if (kind === 'next' || kind === 'travel') {
      // ('travel': the run's own days began yesterday, two days before its first show.)
      var first = kind === 'travel' ? 2 : 26;
      tours.tnext = { name: 'Winter run', artist: tours.t1.artist, setupDone: true, setupStep: 5, createdAt: 5, expenses: { bus: { projected: 42000 } }, commission: {},
        crew: {}, debts: {}, extras: {}, charges: {}, imports: {}, bands: ['I See Stars'], ourBand: 'I See Stars',
        shows: { n1: { id: 'n1', date: inDays(first), city: 'Chicago, IL', venue: 'Metro', daySheet: { doors: '6:30 PM', venueAddress: '3730 N Clark St, Chicago, IL 60613' } },
          n2: { id: 'n2', date: inDays(first + 1), city: 'Detroit, MI', venue: 'Saint Andrew\u2019s Hall' },
          n3: { id: 'n3', date: inDays(first + 3), city: 'Cleveland, OH', venue: 'House of Blues' } } };
      if (kind === 'travel') tours.tnext.spanStart = inDays(-1);
    }
    window.__harness.offTourNow = off ? kind : '';
    emit();
  };
  // (Called or set: both say which state the account is in.)
  Object.defineProperty(window.__harness, 'offTour', { get: function () { return setOffTour; }, set: function (kind) { setOffTour(kind); } });
  window.__harness.offBook = function (on) {
    if (on === false) delete tours.off1; else tours.off1 = JSON.parse(seededBook);
    emit();
  };
  // A year on the Off Tour book, for its month by month graph (see offYear in THE OFF TOUR FRAME above).
  window.__harness.offYear = function (on) {
    delete tours.tmarch; delete tours.tfest;
    tours.off1 = JSON.parse(seededBook);
    if (on !== false) {
      var Y = today.getFullYear(), M = today.getMonth() + 1;
      var on2 = function (m, d) { return Y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); };
      // [month, day, merchant, amount, category]. Only the months up to this one go on the book; August has nothing.
      [[1, 6, 'PUBLIC STORAGE 28511', 189, 'utilities'], [2, 14, 'Rehearsal Room B', 640, 'studio'], [3, 2, 'PUBLIC STORAGE 28511', 189, 'utilities'],
        [4, 3, 'Van service', 2840.75, 'transport'], [4, 19, 'Rehearsal Room B', 1900, 'studio'], [5, 3, 'String and Stick Supply', 3280.1, 'supplies'],
        [5, 20, 'String and Stick Supply', -40.1, 'supplies'], [6, 11, 'Rehearsal Room B', 2420, 'studio'], [7, 11, 'PUBLIC STORAGE 28511', 189, 'utilities']
      ].forEach(function (r, i) {
        if (r[0] > M || on2(r[0], r[1]) > ymd(today)) return;
        tours.off1.charges['y' + i] = { id: 'y' + i, date: on2(r[0], r[1]), merchant: r[2], amount: r[3], category: r[4], manual: true, paid: true };
      });
      // One charge dated next month: it is in the book's totals and on no bar yet.
      if (M < 12) tours.off1.charges.ynext = { id: 'ynext', date: on2(M + 1, 5), merchant: 'Studio deposit', amount: 300, category: 'studio', manual: true, paid: false };
      // [month, day, amount, kind]
      [[1, 20, 310.4, 'royalties'], [4, 15, 2600, 'advance'], [5, 5, 900, 'merch'], [7, 21, 1310.4, 'royalties']].forEach(function (r, i) {
        if (r[0] > M || on2(r[0], r[1]) > ymd(today)) return;
        tours.off1.otherIncome['yi' + i] = { id: 'yi' + i, date: on2(r[0], r[1]), amount: r[2], kind: r[3] };
      });
      // A total typed straight into a category: money with no date.
      tours.off1.expenses = { studio: { projected: null, paid: 450 } };
      var run = function (name, from, to) {
        return { name: name, artist: tours.t1.artist, setupDone: true, setupStep: 5, createdAt: 0, expenses: {}, commission: {},
          crew: {}, debts: {}, extras: {}, charges: {}, imports: {},
          shows: { a: { id: 'a', date: inDays(from), city: 'Tulsa, OK', venue: 'Cain’s' }, b: { id: 'b', date: inDays(to), city: 'Wichita, KS', venue: 'The Cotillion' } } };
      };
      tours.tmarch = run('March run', -215, -191);
      tours.tfest = run('Summer festivals', -75, -50);
    }
    emit();
  };
  // Two tours with no dates yet (see THE OFF TOUR FRAME above).
  window.__harness.undated = function (on) {
    delete tours.tidea; delete tours.thalf;
    if (on !== false) {
      tours.tidea = { name: 'Idea for a run', artist: tours.t1.artist, setupDone: true, setupStep: 5, createdAt: 1, expenses: {}, commission: {},
        crew: {}, debts: {}, extras: {}, charges: {}, imports: {}, shows: {} };
      tours.thalf = { name: 'Half-made run', artist: tours.t1.artist, setupDone: false, setupStep: 2, createdAt: 2, expenses: {}, commission: {},
        crew: {}, debts: {}, extras: {}, charges: {}, imports: {}, shows: {} };
    }
    emit();
  };
  /* ---- THE SET LIST: Overview, View Setlist (beside View calendar) ----
     One list for the whole tour, on the tour doc's setlist key. The sheet opens empty ("No set list yet";
     the lead, who owns the harness tour, sees "Add the set list"). Edits go through the fake backend's
     update, so Save, close and reopen shows the saved list; a Crew phone (?crew) reads it with no Edit.
     SWITCHES:
       __harness.setlist(true)   puts a ten-song list on the harness tour, so the read-only and numbered
                                 looks can be seen without typing; (false) clears it. Or open the page
                                 with ?setlist (add &crew for the viewer look). */
  window.__harness.setlist = function (on) {
    if (on === false) delete tours.t1.setlist;
    else tours.t1.setlist = ['Ten Thousand Feet', 'Murder Mitten', 'New Demons', 'Everyone’s Safe in the Treehouse',
      'Running with Scissors', 'Mobbin’ Out', 'What This Means to Me', 'Calm Snow', 'Portals', 'Full Circle'];
    emit();
  };
  try { if (/[?&]setlist\b/.test(String(location.search || ''))) window.__harness.setlist(true); } catch (e) { /* no address to read */ }
  /* ---- THE CREW PAY CHART, ONE TOUR AT A TIME: a tap on the tour turns the year into its days ----
     Nothing on the database: the chart draws the payments the tour already holds (crewPayments in app.js),
     so there is no probe and nothing to switch off. Out of the box Jeff Mora has one payment (zp1, three
     days ago) and the harness run is nine days with its home day (the day after the last show), so the day
     chart has one dot.
     TO SEE IT: Budget (bottom bar), the Expenses tab, the Crew line, then Jeff Mora's row: his pay page.
     Under PROJECTED and PAID is the year chart. The harness run's shaded days, with its name over them, sit
     inside a thin outline (never narrower than a fingertip): tap it, or Tab to it and press Enter. The chart
     becomes the run alone, day by day, its first day to the home day, with "Harness run" over it and a
     small Year pill on the right that goes back. Tap a day, draw a finger across, hover with a mouse, or
     focus the drawing and use the arrow keys (Home, End, Escape): the line under it names the day and what
     was paid (three days ago reads like "Tue, Oct 13: $500 paid", a show day adds its city, the last day
     says "home day", today says "(today)"); a second tap on the same day lets go. On the year chart a month
     that is named (a tap outside the outline, a finger drawn across, the arrow keys) says what was paid in
     it in the same line, e.g. "September: nothing paid". Close the page and open Jeff's row again: it
     comes back on the tour until the Year pill is tapped. At 375 px wide nothing is cut: a long tour name
     ends in "...", and a long day's line falls back to the short "Oct 13: $500 paid".
     HOOKS:
       __harness.crewPayRun(true)   fills it out: two rehearsal days before the first show (so the run starts
                                    six days ago), and five more payments to Jeff: $300 on the first rehearsal
                                    day, $250 and $100 two days ago (one day, "in 2 payments"), $200 on the
                                    home day (dated ahead, to see the home day's dot), $300 a week before the
                                    run began and $150 with no date. The last two are on no day of the run:
                                    the quiet line under the day chart reads "Not on the chart: $300 paid
                                    before ...; $150 paid with no date." (false) takes it all away again.
                                    Or open the page with ?crewpayrun . Use it with the harness run on the road
                                    (offTour(false)): offTour moves the shows, not these payments. */
  window.__harness.crewPayRun = function (on) {
    var t = tours.t1, keys = ['cpr1', 'cpr2', 'cpr3', 'cpr4', 'cpr5', 'cpr6'];
    keys.forEach(function (k) { delete t.charges[k]; });
    delete t.rehearsalStart; delete t.rehearsalEnd;
    if (on !== false) {
      t.rehearsalStart = inDays(-6); t.rehearsalEnd = inDays(-5);
      // [key, days from today (null: no date), amount, words]
      [['cpr1', -6, 300, 'Pay: Jeff, deposit'], ['cpr2', -2, 250, 'Pay: Jeff'], ['cpr3', -2, 100, 'Pay: Jeff, per diem'],
        ['cpr4', 4, 200, 'Pay: Jeff, last week'], ['cpr5', -13, 300, 'Pay: Jeff, advance'], ['cpr6', null, 150, 'Pay: Jeff, cash']
      ].forEach(function (r, i) {
        t.charges[r[0]] = { id: r[0], date: r[1] == null ? '' : inDays(r[1]), merchant: r[3], amount: r[2], category: 'crew', crewId: 'jm',
          manual: true, paid: true, createdAt: 10 + i };
      });
    }
    emit();
    return on === false ? 'Jeff is back to one payment' : 'Jeff has six payments; the run starts with two rehearsal days';
  };
  try { if (/[?&]crewpayrun\b/.test(String(location.search || ''))) window.__harness.crewPayRun(true); } catch (e) { /* no address to read */ }
  /* ---- LIVE WITHOUT A RESTART (0144): a seat, an artist's yes, a new request, tours confirmed ----
     On the real thing the database touches the account's own row in "pokes" and the phone hears it: the
     backend links any waiting seat, reads the tours again and calls the one function the app handed to
     GR_BACKEND.socialWatch, and the app asks again for everything it holds about where the person stands.
     Here there is no database, so each call below changes the pretend data the way the database would and
     then pokes. Nothing is reloaded: watch the page change by itself.
       __harness.poke(what)        the poke alone: a fresh copy of the tours goes to the app, then the app's
                                   function is called with what ('seat', 'listing', 'endorsement', 'request',
                                   'credits', or '' for "one may have been missed"). Every poke is kept in
                                   __harness.pokes, and how many times the app was told in __harness.socialTold.
       __harness.seat()            the test person is given a seat on a tour they were not on ("Seat run",
                                   I See Stars, a show today, tomorrow and in three days) and is poked.
                                   On their profile's Today tab the day appears; the Overview button opens
                                   the tour with its tabs. Best seen on a phone that is on no tour: open the
                                   page with ?newcrew (below). seat(false) takes the seat away again and pokes.
       __harness.acceptRequest()   the artist says yes to the test person's waiting request (the oldest one,
                                   or acceptRequest('pub1') for that page): they are listed and endorsed
                                   there, the request is gone from the waiting ones, and they are poked. On
                                   the profile the artist stops saying pending and the endorsement shows.
                                   Answers false when no request is waiting (send one first: the first run,
                                   or an unclaimed artist's page such as Sleeping With Sirens).
       __harness.newRequest()      someone asks to be listed on a page the test person runs (Ana Reyes, crew,
                                   FOH engineer; a second call is Jeff Valentine, a Member, Drums), and the test
                                   person is poked: the card shows at the top of their profile and on the
                                   artist's page. With no test artist yet, "I See Stars" is made first.
       __harness.confirmTours()    the artist confirms tours for the test person (what they claimed and is
                                   waiting; with nothing waiting, every tour of the pretend I See Stars), and
                                   they are poked: the tours and the numbers show on their profile. With no
                                   I See Stars page yet one is made, run by somebody else on a ?newcrew
                                   phone, with the test person listed on it as crew.
       __harness.crewOf(roles)     SEVERAL ROLES AND "I WAS ON THIS TOUR" (0146). The test person becomes crew on
                                   the pretend I See Stars, endorsed, on a page somebody else runs (roles: the
                                   line of roles they hold there; left out it is 'Production manager, Driver'),
                                   and is poked. It answers the page's id. Open the page from the profile's
                                   Artists tab (the I See Stars row), then Tours: every tour and festival has
                                   the button "I was on this tour" (the year's loose shows have none). Tapping
                                   it asks "What did you do on this tour?" with those roles ticked; Send puts
                                   "Waiting on I See Stars" on the row at once. __harness.tourClaimsSent holds
                                   what was sent. confirmTours() is then the artist's yes: the row reads "On
                                   your profile" with the role, and the profile's Tours tab prints the role
                                   under the tour. On the Artists tab the row for I See Stars reads "Confirm
                                   the shows and tours..." only while nothing is confirmed or waiting; then
                                   "Waiting on I See Stars to approve your tours"; then the count, as a fact,
                                   which opens "Your tours with I See Stars".
                                   THE PROFILE'S TOUR DROPDOWN: after confirmTours(), tap a confirmed tour on
                                   the profile's Tours tab and its dates drop down right there, the artist
                                   page's own dropdown (the pretend tourNights answers three nights for any
                                   tour; no "I was on this tour" line ever shows on a profile). The same on a
                                   viewer profile: approve Brent's waiting claim on the artist page (Manage,
                                   the "... to approve" card), then open his profile's Tours tab and tap one.
       __harness.artistSide()      the same page seen from the artist's side: the page is handed to the test
                                   person (they run it, as a Member, Vocals), so what they sent as crew waits
                                   on their own yes. Open the page (Manage): the card "... to approve" opens
                                   the review, where each tour says "Role: ..." and what is new is marked. A
                                   claim from Brent ("Backline tech, Driver" on Treehouse Tour) waits there too.
                                   As a Member the test person gets no ask to confirm tours: no row on the
                                   Artists tab and no Tasks card. (__harness.askMembers = true makes the fake
                                   database send the ask anyway, as it did before 0146: the app still shows none.)
     THE ENDORSEMENTS DOOR (Devin, 2026-10-16): the button that said "Ask to be listed" says "Endorsements"
       now, same seat, same gates (signed in, not the page you run, not already listed, no claim waiting; a
       request already sent still shows "Request pending" or "No answer in 30 days" on the button itself).
       It opens a sheet titled with the artist's name and up to four rows, each a door to an existing flow:
       Crew Endorsement and Member Endorsement open the ask sheet landed on that question; Tour Endorsement
       and Show Endorsement open the confirm-your-tours sheet, where Specific shows narrows a tour to nights.
       The two claim rows are drawn only once creditTours answers with tours for this account, so on a page
       where this account cannot claim (a stranger on a claimed page with no endorsement, or any page with no
       tour history) only the two ask rows show.
       __harness.visitorOf()       ALL FOUR ROWS AT ONCE: the pretend I See Stars page run by somebody else,
                                   with the test person NOT on it (it answers the page's id). Search
                                   "I See Stars", open the page: the Endorsements button sits by Fan, and
                                   tapping it draws all four rows, at 375px too. Crew/Member Endorsement land
                                   the ask sheet on Crew or Member; Tour/Show Endorsement open "Confirm the
                                   shows and tours you've done with I See Stars" with "Send to I See Stars"
                                   (the stub lets any account claim; live, the server answers the tours only
                                   for the page's runner or someone the artist has endorsed).
     UNCLAIMED PAGES AND FESTIVALS (0147):
       A crew ask to a page nobody runs is accepted at once. Open Sleeping With Sirens (an unclaimed page: search
       "sleeping"), Endorsements, Crew Endorsement (the unclaimed page has no tour history here, so only the two
       ask rows show): the sheet says crew are listed at once and the button reads "List me
       as crew"; sending it says "Sleeping With Sirens's page isn't run by anyone yet, so you're listed for now.
       Whoever claims the page will see you and can keep you or take you off." The page's Crew tab lists the test
       person, and so does their profile's Artists tab, endorsed. The same through the first run on a ?newcrew
       phone (Crew, search "sleeping", the role, Send): the last screen says "You're listed" with those words.
       A Member's ask (Endorsements, Member Endorsement) still waits, as before. __harness.joined holds who joined how.
       __harness.joinedBeforeClaim()   the page is then claimed: two crew joined Sleeping With Sirens while nobody
                                   ran it (Ana Reyes, FOH engineer, with the whole Feel Tour confirmed; Brent Allen,
                                   Backline tech, Driver, no tours), and the test person's claim on it is approved
                                   by a Greenroom admin, so the page is theirs (a Promise of its id, 'pub1'). The
                                   prompt "People who joined Sleeping With Sirens before you claimed it" shows at
                                   the top of the profile, on the page itself (Manage) and as a Tasks card. It opens
                                   each person with their roles and the tours they confirmed; Keep, or Take off
                                   (tap twice). Kept, they stay on the page's Crew tab; taken off, they come off
                                   it with their tours. The card stays until both are answered.
                                   __harness.joinedAnswers holds each answer; __harness.joinedWhy = 'gone' makes
                                   one come back as already answered.
       A festival's row: crewOf() first, open I See Stars, Tours: "Aftershock 2025" (tagged festival) has
       "I played this festival", which asks "What did you do at this festival?" ("Your role at this festival").
       Send, then confirmTours(): the profile's Tours tab lists Aftershock 2025 as a festival, on its own, with
       the role; it is not counted as a tour (the tours number on the pretend card goes up by tours only).
       Several roles, anywhere a role with an artist is asked (the first run with ?newcrew, "Ask to be
       listed" on an artist's page, the artist's Endorse / role sheet): tick up to six; what is ticked reads
       back inside the question; __harness.frCalls holds the line that was sent (roles joined with ", ").
     A BRAND-NEW CREW ACCOUNT:  open the page with  ?newcrew  (it has to be the address: the account is set
     up before the app starts). No phone number, no role, no tour, nobody has endorsed it, and its first run
     is due with CREW ticked: Next, then "Your phone number" (the step this build adds; it is not shown to
     someone who ticks only Fan or Promoter, nor once the account has a number), then "Which artist do you
     work for?" (search "sleeping"), the role, Send request. __harness.saved is the card as last saved (the
     phone after the phone step, the role after the request is sent); __harness.me is the account. Then
     acceptRequest(), seat() and confirmTours() show the rest with no reload. Not meant to be mixed with the
     other tour switches (offTour, offYear, undated), which expect the harness tour to be there. */
  window.__harness.poke = function (what) {
    var H = window.__harness;
    H.pokes = (H.pokes || []).concat([String(what || '')]);
    // (As the real backend does it: the tours first, then the app is told.)
    setTimeout(function () {
      emit();
      if (typeof H.socialFn === 'function') { H.socialTold = (H.socialTold || 0) + 1; H.socialFn(String(what || '')); }
    }, 0);
  };
  window.__harness.seat = function (on) {
    if (on === false) delete tours.tseat;
    else tours.tseat = { name: 'Seat run', artist: 'I See Stars', setupDone: true, setupStep: 5, createdAt: 9, expenses: {}, commission: {},
      crew: {}, debts: {}, extras: {}, charges: {}, imports: {}, bands: ['I See Stars'], ourBand: 'I See Stars',
      shows: { q1: { id: 'q1', date: inDays(0), city: 'Denver, CO', venue: 'Summit', daySheet: { doors: '7:00 PM', venueAddress: '1902 Blake St, Denver, CO 80202' } },
        q2: { id: 'q2', date: inDays(1), city: 'Salt Lake City, UT', venue: 'The Depot' },
        q3: { id: 'q3', date: inDays(3), city: 'Boise, ID', venue: 'Knitting Factory' } } };
    window.__harness.poke('seat');
  };
  // The pretend I See Stars page, made when there is none. someoneElses: the test person does not run it (a Crew phone).
  function issPage(someoneElses) {
    var H = window.__harness, a = creditIss();
    if (a) return a;
    H.acts = H.acts || [];
    a = { id: 'act' + (H.acts.length + 1), handle: 'iseestars', name: 'I See Stars', avatar: '', bio: '', notMine: !!someoneElses,
      members: someoneElses ? [] : [{ userId: 'u-devin', kind: 'band', role: 'Vocals', endorsed: true }] };
    H.acts.push(a);
    return a;
  }
  window.__harness.acceptRequest = function (artistId) {
    var H = window.__harness;
    var x = (H.artistRequests || []).filter(function (y) {
      return (y.userId || 'u-devin') === 'u-devin' && (y.state || 'pending') === 'pending' && (!artistId || y.artistId === artistId); })[0];
    if (!x) return false;
    H.artistRequests = H.artistRequests.filter(function (y) { return y !== x; });
    var a = (H.acts || []).filter(function (y) { return y.id === x.artistId; })[0];
    var g = ghostList().filter(function (y) { return y.id === x.artistId; })[0] || {};
    // Listed and endorsed in one go, as decide_artist_request does it.
    if (a) a.members = a.members.filter(function (m) { return m.userId !== 'u-devin'; }).concat([{ userId: 'u-devin', kind: x.kind, role: x.role || '', endorsed: true }]);
    else H.devinActs = devinActs().filter(function (y) { return y.id !== x.artistId; }).concat([
      // (A username Greenroom made up for an unclaimed page, "mb." and twenty characters, is never shown as a name.)
      { id: x.artistId, name: g.name || 'Artist', handle: /^mb\./.test(g.handle || '') ? '' : (g.handle || ''), avatar: '', kind: x.kind, role: x.role || '', endorsed: true, eid: 'e-' + x.artistId }]);
    window.__harness.poke('request,listing,endorsement');
    return true;
  };
  window.__harness.newRequest = function () {
    var H = window.__harness, a = (H.acts || []).filter(function (y) { return !y.notMine; })[0] || issPage(false);
    H.artistRequests = H.artistRequests || [];
    var who = [{ userId: 'u-ana', kind: 'crew', role: 'FOH engineer' }, { userId: 'u-jeff', kind: 'band', role: 'Drums' }].filter(function (w) {
      return !listedOn(a.id, w.userId) && !H.artistRequests.some(function (y) { return y.artistId === a.id && y.userId === w.userId && (y.state || 'pending') === 'pending'; }); })[0];
    if (!who) return false;
    H.artistRequests = H.artistRequests.filter(function (y) { return !(y.artistId === a.id && y.userId === who.userId); });
    H.artistRequests.push({ artistId: a.id, userId: who.userId, kind: who.kind, role: who.role, state: 'pending', at: new Date().toISOString() });
    window.__harness.poke('request');
    return true;
  };
  window.__harness.confirmTours = function () {
    var H = window.__harness, a = issPage(!!H.isNewCrew), rows = creditStore(), k = a.id + ':u-devin';
    if (!listedOn(a.id, 'u-devin')) a.members.push({ userId: 'u-devin', kind: 'crew', role: me.tour_role || 'Crew', endorsed: true });
    var row = rows[k] || { approved: null, pending: null, submittedAt: new Date().toISOString(), declinedAt: null };
    row.approved = row.pending || { all: true, until: ymd(today) };
    row.pending = null; row.declined = null; row.declinedAt = null;
    rows[k] = row;
    window.__harness.poke('credits');
    return true;
  };
  // Crew on a page somebody else runs, endorsed, with a line of roles (see crewOf above).
  window.__harness.crewOf = function (roles) {
    var H = window.__harness, a = issPage(true);
    a.notMine = true; H.creditNotOwner = true;
    a.members = a.members.filter(function (m) { return m.userId !== 'u-devin'; })
      .concat([{ userId: 'u-devin', kind: 'crew', role: String(roles || 'Production manager, Driver').slice(0, 160), endorsed: true }]);
    window.__harness.poke('listing,endorsement');
    return a.id;
  };
  // A plain visitor on a page somebody else runs: the test person is not on it (see THE ENDORSEMENTS DOOR above).
  window.__harness.visitorOf = function () {
    var H = window.__harness, a = issPage(true);
    a.notMine = true; H.creditNotOwner = true;
    a.members = a.members.filter(function (m) { return m.userId !== 'u-devin'; });
    window.__harness.poke('listing');
    return a.id;
  };
  // The same page from the artist's side: the test person runs it, as a Member (see artistSide above).
  window.__harness.artistSide = function () {
    var H = window.__harness, a = issPage(false);
    a.notMine = false; H.creditNotOwner = false;
    a.members = a.members.filter(function (m) { return m.userId !== 'u-devin'; })
      .concat([{ userId: 'u-devin', kind: 'band', role: 'Vocals', endorsed: true }]);
    window.__harness.poke('listing,credits');
    return a.id;
  };
  // A page nobody ran, claimed by the test person, with crew who joined before (see UNCLAIMED PAGES above).
  window.__harness.joinedBeforeClaim = function () {
    var H = window.__harness, g = ghostList().filter(function (x) { return x.id === 'pub1'; })[0];
    if (!g || g.owner) return null;
    H.ghostCrew = H.ghostCrew || {};
    H.ghostCrew.pub1 = ((H.ghostCrew.pub1 || []).filter(function (m) { return m.userId !== 'u-ana' && m.userId !== 'u-brent'; }))
      .concat([{ userId: 'u-ana', kind: 'crew', role: 'FOH engineer', endorsed: true },
               { userId: 'u-brent', kind: 'crew', role: 'Backline tech, Driver', endorsed: true }]);
    var ago = function (h) { return new Date(Date.now() - h * 36e5).toISOString(); };
    H.joined = (H.joined || []).filter(function (j) { return j.artistId !== 'pub1' || j.userId === 'u-devin'; })
      .concat([{ artistId: 'pub1', userId: 'u-ana', listed: true, at: ago(30) }, { artistId: 'pub1', userId: 'u-brent', listed: true, at: ago(5) }]);
    // Ana said she was on the whole Feel Tour, and it went on her page at once.
    var feel = creditTourByName('pub1', 'Feel Tour');
    if (feel) creditStore()['pub1:u-ana'] = { approved: { picks: [{ key: feel.key, mode: 'all', role: 'FOH engineer' }], until: ymd(today) },
      pending: null, submittedAt: ago(29), declinedAt: null };
    // The test person's claim, approved by a Greenroom admin: the page is theirs, and the people come with it.
    H.claims = (H.claims || []).filter(function (c) { return !(c.artistId === 'pub1' && c.userId === 'u-devin'); })
      .concat([{ id: 'cl-joined', artistId: 'pub1', userId: 'u-devin', note: 'I sing in it.', link: '', role: 'Vocals', links: {}, code: 'GR-J01NED', status: 'pending', at: ago(1) }]);
    return window.GR_BACKEND.decideClaim('cl-joined', true).then(function () { window.__harness.poke('listing,joined'); return 'pub1'; });
  };
  /* ---- TOUR FLYERS (0156): the poster above a tour dropdown's dates ----
     The probe answers true here and the map starts empty, so every open
     dropdown shows nothing new and the rows of a page the test person runs
     say "Add flyer".
     HOOKS:
       __harness.flyers()          seeds one flyer (a drawn stand-in poster) on the test artist's
                                   "10 Years In The Black" and answers the page's id. Open that page
                                   (__harness.artistSide(), then Search, I See Stars) and tap the
                                   tour: the dropdown says View flyer above the dates, the sheet
                                   shows the poster full width with Remove flyer, and the row says
                                   Change flyer; the page's other tours still say Add flyer. Careful:
                                   a test that assigns a LIST to __harness.flyers feeds the fake
                                   reader instead (the old hook, unchanged); the seeding function
                                   only sits there until then.
       __harness.tourFlyers        what's seeded or saved: { <artistId>: { <group key>: { url, sourceUrl } } }.
       __harness.flyerPuts         every save the app made: [{ artistId, gk, size }].
       __harness.flyerDrops        every removal: [{ artistId, gk }].
       __harness.flyerFail = true  every save fails, as with no signal.
       __harness.flyersOff = true  the probe answers false, as before migration 0156: no flyer
                                   lines anywhere. */
  window.__harness.flyers = function () {
    var H = window.__harness, a = issPage(false);
    H.tourFlyers = H.tourFlyers || {};
    var m = H.tourFlyers[a.id] = H.tourFlyers[a.id] || {};
    m['10 Years In The Black'] = { url: 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 420"><rect width="300" height="420" fill="#101418"/>' +
      '<rect x="14" y="14" width="272" height="392" fill="none" stroke="#3ddc84" stroke-width="3"/>' +
      '<text x="150" y="150" fill="#3ddc84" font-family="Arial" font-size="30" font-weight="bold" text-anchor="middle">PRETEND</text>' +
      '<text x="150" y="195" fill="#3ddc84" font-family="Arial" font-size="30" font-weight="bold" text-anchor="middle">FLYER</text>' +
      '<text x="150" y="260" fill="#e8f1ea" font-family="Arial" font-size="14" text-anchor="middle">10 Years In The Black</text>' +
      '<text x="150" y="285" fill="#8a949c" font-family="Arial" font-size="12" text-anchor="middle">a stand-in poster for the harness</text></svg>'),
      sourceUrl: 'https://example.com/pretend-flyer-page' };
    emit();
    return a.id;
  };
  /* ---- THE TOURS TAB'S GEAR (Devin, 2026-10-17: "Get rid of all that text") ----
     Under an artist page's tour list there is now one gear (centred) and the quiet setlist.fm credit, and
     nothing else. The gear is drawn for the page's runner (a verified page with a road story) and, on a page
     nobody runs, for a Greenroom admin, the same people the old Rescan button and Tour search block were
     drawn for. A green dot sits on it while runs of nights with no tour name wait on the owner. Tapping it
     opens Tour settings: Add tour (opens From a flyer / By hand), Refresh, the search's own words under
     them, and Waiting for you (the runs, folded, each with Name this run).
     HOOKS:
       __harness.tourGear(waiting, sheet)   the pretend I See Stars page is the test person's (artistSide),
                                   with a search Greenroom finished by itself two days ago and, unless waiting
                                   is false, two runs waiting. It lands on the page's Tours tab as its runner
                                   (the gear with its dot, the credit under it) and, with sheet true, opens
                                   Tour settings too. Answers the page's id. Or open the page with ?tourgear
                                   (?tourgear=sheet opens the sheet as well, ?tourgear=none has nothing waiting).
       Refresh: tap it. The row dims to "Searching now" and the van drives under it ("Reading tour
                                   announcements: 0 articles, 6 to go", then 3 and 3), then the phone reads
                                   with the pretend reader ("Sorting out the tours") and the search settles
                                   ("Searched on <today>. Read 2 articles: ..."; two runs wait again).
                                   __harness.rescans counts forced searches, __harness.freshNudges the
                                   setlist.fm re-reads asked for. __harness.tfBrain = true before tapping
                                   makes it the server's read instead ("Sorting out the tours: 2 of 4 batches").
       Add tour, From a flyer: the photo picker. With no real photo to hand, from the console:
                                   var i = document.querySelector('.tf-sheet input[type=file]'),
                                   dt = new DataTransfer(); dt.items.add(new File(['x'], 'flyer.png',
                                   { type: 'image/png' })); i.files = dt.files; i.dispatchEvent(new Event('change'));
                                   Tour settings comes back, the pretend reader answers at once, and the toast
                                   says what was added from that poster.
       Add tour, By hand: the saved-page sheet, now titled "Add a missing tour"; Read it (and Cancel) come
                                   back to Tour settings, where the reading shows. __harness.proposed holds
                                   what was handed over.
       Waiting for you: open the fold, Name this run, Name it: back on Tour settings with the toast "3 shows
                                   named ...", the fold still open and that run gone from it (the dot on the
                                   page goes once none are left). Cancel comes back the same way.
                                   __harness.namedRuns holds each one named.
       A visitor sees no gear: __harness.visitorOf(), then Search, I See Stars, Tours. */
  window.__harness.tourGear = function (waiting, sheet) {
    var H = window.__harness, id = H.artistSide();
    var ago = new Date(Date.now() - 2 * 864e5).toISOString();
    H.tf = H.tf || {};
    H.tf[id] = { status: 'done', detail: 'Read 343 articles: 33 tours found, 31 new, 31 added to the page', day: ago.slice(0, 10),
      pages: 0, waiting: 0, brain: !!H.tfBrain, eta: 0, unread: 0, batches: { total: 0, done: 0 }, sources: {}, finishedAt: ago, auto: true,
      candidates: [], runs: waiting === false ? [] : [
        { first: '2018-05-26', last: '2018-06-21', n: 15, countries: 'CA, US', nights: [{ date: '2018-05-26', city: 'San Antonio', state: 'TX', country: 'US', venue: 'Aztec Theatre' }, { date: '2018-06-21', city: 'Houston', state: 'TX', country: 'US', venue: 'Warehouse Live' }] },
        { first: '2017-07-15', last: '2017-08-04', n: 11, countries: 'US', nights: [{ date: '2017-07-15', city: 'St. Louis', state: 'MO', country: 'US', venue: 'Pop’s' }] }] };
    (function openIt(n) {
      if (H.openTourGear) { H.openTourGear(id, !!sheet); return; }
      if (n < 40) setTimeout(function () { openIt(n + 1); }, 250);
    })(0);
    return id;
  };
  try {
    var gearAsk = /[?&]tourgear(?:=(sheet|none))?\b/.exec(String(location.search || ''));
    if (gearAsk) window.__harness.tourGear(gearAsk[1] !== 'none', gearAsk[1] === 'sheet');
  } catch (e) { /* no address to read */ }
  // A brand-new Crew account (see LIVE WITHOUT A RESTART above): set up before the app starts.
  var held = {};
  window.__harness.newCrew = function () {
    var H = window.__harness;
    H.isNewCrew = true; H.asCrew = true;
    me.phone = ''; me.tour_role = '';
    ['t1', 'off1'].forEach(function (id) { if (tours[id]) { held[id] = tours[id]; delete tours[id]; } });
    H.devinActs = []; H.kinds = [];
    H.firstRun = { suggest: ['crew'] };
    emit();
  };
  try { if (/[?&]newcrew\b/.test(String(location.search || ''))) window.__harness.newCrew(); } catch (e) { /* no address to read */ }
  /* ---- A FAN'S PHONE: the bottom bar with no tour pages on it ----
     A strictly-fan account (runs no artist, Member of none, Crew on no tour,
     not a promoter) has no tour pages, so its bottom bar is Search and the
     photo alone. __harness.fan() turns the test account into one before the
     app starts: the tours go away, the artist list empties, and the account
     said only "fan" at sign-up. Or open the page with ?fan. */
  window.__harness.fan = function () {
    var H = window.__harness;
    H.asCrew = false; H.asManager = false;
    ['t1', 'off1'].forEach(function (id) { if (tours[id]) { held[id] = tours[id]; delete tours[id]; } });
    H.devinActs = []; H.kinds = ['fan'];
    emit();
  };
  try { if (/[?&]fan\b/.test(String(location.search || ''))) window.__harness.fan(); } catch (e) { /* no address to read */ }
  /* ---- THE FAN ROUND (0159): the Top 10, and an artist page's Top Fans ----
     The probe answers true here, so your own profile carries its Top 10 tab
     from the start (last on the row, after Spots; Devin, 2026-10-16: "its
     own tab on the user profile so it's not just randomly hovering over the
     tabs" - the floating strip above your own tabs is gone), and since
     2026-10-17 the page others see carries it as a tab too (Devin: "the
     'top 10 artists' should be in a tab next to stats and tours and
     artists"): Artists, Tours, Stats, Top 10, the same list read only, and
     no strip above the tabs any more.
     HOOKS:
       __harness.topten()   puts up to five artists on the test account's Top 10 and answers
                            how many. Open your profile's Top 10 tab: the full
                            list sits there with Edit your Top 10 under it; the
                            sheet has the arrows, the off buttons and the
                            artist search (empty, the tab holds the pick
                            card instead). With To Do List and Spots both
                            live the row holds six tabs - check it at 375px.
                            View profile (the viewer experience) shows the
                            row Artists, Tours, Stats, Top 10 at 375px with
                            nothing above it; tap Top 10 for the same list,
                            no Edit your Top 10 under it. Empty, the tab
                            reads "No Top 10 yet". Or open the page with
                            ?topten.
       __harness.topTens    every list: { userId: [{ artistId, rank, name, avatar }] }. Change
                            one by hand, then render follows the next save or reopen.
       __harness.favCalls   every save the app made: [{ fn: 'favAdd' | 'favRemove' | 'favSwap', args }].
       __harness.favFail = true   every save fails, as with no signal.
       __harness.topfans()  seeds twelve ranked fans on the test artist's page and answers the
                            page's id. Open that page as a visitor (__harness.artistSide(),
                            then Search, I See Stars): beside the fan count sits Top Fans, and
                            its sheet lists photo, name and shows attended, most shows first.
                            Or open the page with ?topfans.
       __harness.fanRanks   what topFans answers: { artistId: [{ userId, name, avatar, shows }] }.
       __harness.favoritesOff = true   the probe answers false, as before migration 0159: no
                            strip, no pick card, no Top Fans line anywhere. */
  window.__harness.topten = function () {
    var H = window.__harness;
    var ids = (H.acts || []).map(function (a) { return a.id; })
      .concat(ghostList().map(function (g) { return g.id; })).slice(0, 5);
    H.topTens = H.topTens || {};
    H.topTens['u-devin'] = ids.map(function (id, i) { return { artistId: id, rank: i + 1 }; });
    emit();
    return H.topTens['u-devin'].length + ' on the list';
  };
  try { if (/[?&]topten\b/.test(String(location.search || ''))) window.__harness.topten(); } catch (e) { /* no address to read */ }
  window.__harness.topfans = function () {
    var H = window.__harness, a = issPage(false);
    var names = ['Riley Sun', 'Maya Tran', 'Jo Marsh', 'Sam Petty', 'Noor Vale', 'Pat Quinn',
      'Dana Reyes', 'Lee Marino', 'Ash Cole', 'Remy Stone', 'Kit Lawson', 'Billie Park'];
    H.fanRanks = H.fanRanks || {};
    H.fanRanks[a.id] = names.map(function (n, i) {
      return { userId: 'u-fan' + (i + 1), name: n, avatar: '', shows: Math.max(1, 40 - i * 3) };
    });
    emit();
    return a.id;
  };
  try { if (/[?&]topfans\b/.test(String(location.search || ''))) window.__harness.topfans(); } catch (e) { /* no address to read */ }
  /* ---- BUS CHECK IN (0150, tightened 2026-10-16): the Overview's button, its sheet, the bus list ----
     Everyone joined on the crew list rides unless their row says ridesBus:
     false; each person's word for today sits in __harness.busStates
     ({ userId: { state: 'on' | 'off', at } }). This phone's account is
     u-devin: its On Bus / Off Bus taps land there and poke 'bus', the way
     the database pokes every phone on the tour, so open pages draw again by
     themselves. The button sits on the OVERVIEW's two-column button grid,
     under View Setlist (Devin, 2026-10-16: "Move 'bus check in' button to
     the overview" - it left the Chat's tools row that same day; View
     calendar sits over BUYOUT ALERT in the left column, and a column one
     button short, the alert being Managers-only and the bus waiting on its
     table, centres what it has). The button
     wears the green glow from the day's bus call until this phone's own On
     Bus, a word said before the 5 AM day line reads as "No word yet", and
     the sheet carries the Overview look: crew rows with pictures, On Bus /
     Off Bus in View calendar's dress, the bus call time glowing, and the
     line "Don't get left behind". The head again (2026-10-16): no 'Bus
     Check In' title any more - the bus call time IS the big top line, and
     right under it the day's one status word: WE ARE A BUS in the house
     green once every rider said On bus today, MISSING CREW in red for
     anything else (someone unsaid, someone off, nobody yet). A sheet with
     no bus call set keeps the old title, having no time to lead with.
       __harness.bus()      tonight's Austin show gets a bus call half an hour
                            from now (within the hour, so it counts as due),
                            four ride the bus (Jeff Mora and Dana
                            Cole join the seeded crew; Tasha hasn't signed up,
                            so she isn't counted), and Brent and Jeff are on:
                            the Overview's Bus Check in button glows green
                            (bus call due, your own word not said). Tap On
                            Bus and the glow stops for you, with Dana still
                            showing "No word yet". Set another word by hand:
                            __harness.busStates['u-jeff']
                            = { state: 'off', at: new Date().toISOString() };
                            __harness.poke('bus') and Jeff's row reads "Off
                            bus" (the button stays quiet once you are on).
       ?bus                 the same seed, and the sheet itself opens over the
                            start screen as soon as the app is up (the app
                            lends the harness openBusSheet), so the restyled
                            head, buttons, rows and line show at 375px
                            without walking to the Overview. Two of four
                            riders are on, so the head reads MISSING CREW in red.
       __harness.busAllOn() every rider says On bus now and a 'bus' poke
                            lands: an open sheet's head turns to WE ARE A
                            BUS in the house green by itself.
       __harness.busStates  every word said today; empty it ({}) then poke
                            'bus' for "no word yet" all round (MISSING CREW).
       __harness.busOff = true   the probe answers as with no table (a build
                            ahead of its migration): no button on the Overview
                            (View Setlist stands centred in its column) and no
                            "Riding on the bus?" on the invite form.
     An invite's "Riding on the bus?" answer lands on its __harness.crew row
     as ridesBus (false keeps them off the list) and rides in
     __harness.invited as each row's fifth entry. */
  window.__harness.bus = function () {
    var H = window.__harness;
    var at = new Date(Date.now() + 30 * 60e3);
    var hr = at.getHours() % 12 || 12, mm = ('0' + at.getMinutes()).slice(-2);
    tours.t1.shows.s1.daySheet.busCall = hr + ':' + mm + (at.getHours() >= 12 ? 'PM' : 'AM');
    [['u-jeff', 'Jeff Mora', 'FOH Engineer'], ['u-dana', 'Dana Cole', 'Merch']].forEach(function (x) {
      if (!H.crew.some(function (m) { return m.userId === x[0]; })) {
        H.crew.push({ owner: false, role: 'viewer', userId: x[0], name: x[1], email: x[0] + '@example.com',
          invitedEmail: x[0] + '@example.com', phone: '', tourRole: x[2], joined: true });
      }
    });
    var now = new Date().toISOString();
    H.busStates = { 'u-brent': { state: 'on', at: now }, 'u-jeff': { state: 'on', at: now } };
    H.poke('bus');
    return 'bus call ' + tours.t1.shows.s1.daySheet.busCall;
  };
  // Every rider aboard, so the sheet's head turns to WE ARE A BUS (see the
  // BUS CHECK IN notes above).
  window.__harness.busAllOn = function () {
    var H = window.__harness, now = new Date().toISOString();
    var st = H.busStates || (H.busStates = {});
    (H.crew || []).forEach(function (m) {
      if (m.joined && m.userId && m.ridesBus !== false) st[m.userId] = { state: 'on', at: now };
    });
    H.poke('bus');
    return Object.keys(st).length + ' riders on';
  };
  try { if (/[?&]bus\b/.test(String(location.search || ''))) {
    window.__harness.bus();
    // And the sheet itself, as soon as the app lends its opener (see the
    // BUS CHECK IN notes above): the restyled look with no walking.
    (function openIt(n) {
      if (window.__harness.openBusSheet) { window.__harness.openBusSheet('t1', tours.t1.shows.s1.daySheet.busCall); return; }
      if (n < 40) setTimeout(function () { openIt(n + 1); }, 250);
    })(0);
  } } catch (e) { /* no address to read */ }
  /* ---- FOUR SHEETS, MORE SPACIOUS (2026-10-17) ----
     Devin: "more spacious and clean", with Budget's Expenses rows and the
     Overview crew list as the yardstick. Each flag opens its sheet itself,
     the way ?bus does, once the app lends its opener:
       ?look=spot            Add a spot: City, Name (the place search drops
                            the card's full width), Kind, Note on one card
                            of rows, Share with my tour on a card of its own.
       ?spots&look=spotedit  the first of the test person's spots in the
                            same sheet, with Delete spot.
       ?todos&look=todo      I See Stars's To Do List page (what a profile To
                            Do row opens): each category a card of tall rows
                            under a quiet heading, the folds quiet.
       ?supplies&look=supplies   the Harness run's Supplies: open lines on
                            one card, the ticked ones on their own under
                            Done, the add bar level at the bottom.
       ?look=guest           Add a guest for tonight's Austin show: who,
                            how to reach them and their ticket, each a card.
     By hand: __harness.openLook('spot') / ('spotedit') /
     ('todo', artistId, name) / ('supplies', 't1') / ('guest', 't1', 's1'). */
  try {
    var lookQ = /[?&]look=(spot|spotedit|todo|supplies|guest)\b/.exec(String(location.search || ''));
    if (lookQ) (function openLook(n) {
      if (window.__harness.openLook) {
        var iss = lookQ[1] === 'todo' ? issPage(false) : null;
        window.__harness.openLook(lookQ[1], iss ? iss.id : 't1', iss ? iss.name : 's1');
        return;
      }
      if (n < 40) setTimeout(function () { openLook(n + 1); }, 250);
    })(0);
  } catch (e) { /* no address to read */ }
  /* ---- BUYOUTS (0151 + 0176): the BUYOUT ALERT, defined (Devin, 2026-10-17) ----
     The database table buyout_tracks is __harness.buyoutTicks here
     ([{ tourId, showId, userId, at }]): one row = this person received the
     buyout that show logged. buyout_asks (0176, "ping the TM") is
     __harness.buyoutAskRows ([{ tourId, showId, userId, at }]). This phone's
     account is u-devin; a tick, an undo or a ping pokes 'buyout', the way
     the database does.
     THE RULES THE APP NOW FOLLOWS: only shows dated 2026-10-16 or later
     count (G.BUYOUT_FROM, a fixed day). From the moment a buyout is logged
     on such a show until a person is tracked on it, THEIR BUYOUTS tab head
     (MY PAY: INCOME / EXPENSES / BUYOUTS) and their BUYOUT ALERT glow green.
     Only the Tour Manager (a creator or Manager whose title says Tour
     manager) sees the tick list; everyone else's BUYOUT ALERT opens their own
     status, Received or Not yet per show, with Ping the TM on a Not yet. No
     one titled Tour manager: the creator and the Managers see the tick list.
       __harness.buyouts()  puts buyout money on Dallas (4 days ago, $1,200),
                            Houston (2 days ago, $900) and tonight's Austin
                            ($800), ticks everyone joined on Dallas, and has
                            Brent ping for Austin. Dallas and Houston are
                            before the fresh start, so ONLY Austin counts,
                            anywhere. Or open the page with ?buyouts.
                            Then Budget > MY PAY > BUYOUTS:
       ?buyouts             (this phone the creator; nobody titled Tour
                            manager) THE FALLBACK: the tab glows (Devin's own
                            Austin buyout is not in), and BUYOUT ALERT opens
                            the tick list: Austin, "0 of 2 tracked · 1
                            asked", Brent marked Asked. Tick everyone and
                            both glows stop.
       ?buyouts=tm          Brent becomes the tour's Tour manager: this phone
                            (the creator) now sees ITS OWN status in BUYOUT
                            ALERT: Austin, Not yet, Ping the TM. Tap it: it
                            says Sent, and __harness.notified ends with
                            ['buyoutask', { showId: 's1' }].
       ?buyouts&manager     this phone is an editor Manager titled Tour
                            Manager on someone else's tour: the tick list,
                            three people, Brent Asked.
       ?buyouts&crew        Crew: the tab and the button glow; the button
                            opens Austin, Not yet, Ping the TM.
       __harness.buyoutGive('u-devin')   ticks that person on tonight's show
                            as the Tour Manager would from another phone,
                            and pokes: on ?buyouts=tm or ?crew the glow stops.
       __harness.buyoutTicks  every tick; empty it ([]) then poke 'buyout'
                            and nobody has theirs.
       __harness.buyoutAsksOff = true   as before 0176: no Ping the TM, no
                            Asked marks; everything else stays.
       __harness.buyoutsOff = true   the probe answers as with no table (a
                            build ahead of its migration): MY PAY shows no
                            third tab, and the Today card's "Who received?"
                            uses the show's own marks.
     THE TODAY CARD (Tasks, on a show day) reads the same truth: with
     ?buyouts as the tracker, "Who received?" lists tonight's people with the
     same ticks; ticking all of them clears it here AND the BUYOUT ALERT's
     glow. "Log in buyouts" also takes "No buyouts tonight". */
  window.__harness.buyouts = function () {
    var H = window.__harness;
    tours.t1.shows.s0.income = Object.assign({}, tours.t1.shows.s0.income, { buyouts: 1200 });
    tours.t1.shows.s0.loggedAt = tours.t1.shows.s0.loggedAt || 1;
    tours.t1.shows.s00.income = Object.assign({}, tours.t1.shows.s00.income, { buyouts: 900 });
    tours.t1.shows.s00.loggedAt = tours.t1.shows.s00.loggedAt || 1;
    tours.t1.shows.s1.income = Object.assign({}, tours.t1.shows.s1.income, { buyouts: 800 });
    tours.t1.shows.s1.loggedAt = tours.t1.shows.s1.loggedAt || 1;
    var now = new Date().toISOString();
    var joined = (H.crew || []).filter(function (m) { return m.joined && m.userId; });
    H.buyoutTicks = joined.map(function (m) { return { tourId: 't1', showId: 's0', userId: m.userId, at: now }; });
    H.buyoutAskRows = [{ tourId: 't1', showId: 's1', userId: 'u-brent', at: new Date(Date.now() - 20 * 60e3).toISOString() }];
    H.poke('buyout');
    return 'Only tonight counts (Austin): nobody tracked, Brent asked';
  };
  // Brent (an editor Manager) titled Tour manager: the creator sees their own status.
  window.__harness.buyoutTM = function () {
    var H = window.__harness;
    H.crew = H.crew.map(function (m) { return m.userId === 'u-brent' ? Object.assign({}, m, { tourRole: 'Tour manager' }) : m; });
    H.poke('buyout');
    return 'Brent keeps the track';
  };
  window.__harness.buyoutGive = function (userId, showId) {
    var H = window.__harness, ticks = H.buyoutTicks || (H.buyoutTicks = []);
    var sid = showId || 's1', uid = userId || 'u-devin';
    if (!ticks.some(function (r) { return r.tourId === 't1' && r.showId === sid && r.userId === uid; })) {
      ticks.push({ tourId: 't1', showId: sid, userId: uid, at: new Date().toISOString() });
    }
    H.buyoutAskRows = (H.buyoutAskRows || []).filter(function (r) { return !(r.showId === sid && r.userId === uid); });
    H.poke('buyout');
    return uid + ' tracked on ' + sid;
  };
  try {
    var boq = String(location.search || '');
    if (/[?&]buyouts\b/.test(boq)) window.__harness.buyouts();
    if (/[?&]buyouts=tm\b/.test(boq)) window.__harness.buyoutTM();
  } catch (e) { /* no address to read */ }
  /* ---- SUPPLIES (0155): the tour's shared list, under Overview ----
     The database table tour_supplies is __harness.supplyRows here
     ([{ id, tourId, body, addedBy, doneAt, doneBy, at }]). Anyone on the
     tour adds and ticks; the words of a line, and its delete, belong to
     whoever wrote it or a Manager, and the fake refuses the rest with the
     database's own plain words (code 'said'), so the sheet's toast is
     tested as it ships. This phone's account is u-devin; with ?crew its
     taps are a Crew phone's (ticks still land, another's words refuse).
     HOOKS:
       __harness.supplies()  seeds the Harness run's list: three open lines
                            (one Brent's), two ticked off, and answers how
                            many are open. The Overview grows a Supplies
                            button beside View Setlist with the open count;
                            its sheet lists open lines first, then Done, the
                            add field pinned at the bottom. Or open the page
                            with ?supplies.
       __harness.supplyRows  every line; change them by hand, then
                            __harness.poke('supply') and an open sheet draws
                            again by itself.
       __harness.suppliesOff = true   the probe answers as with no table (a
                            build ahead of its migration): no button on the
                            Overview and no sheet anywhere. */
  window.__harness.supplies = function () {
    var H = window.__harness;
    var ago = function (h) { return new Date(Date.now() - h * 36e5).toISOString(); };
    H.supplyRows = [
      { id: 'sp1', tourId: 't1', body: 'Gaff tape, two rolls', addedBy: 'u-devin', doneAt: null, doneBy: null, at: ago(30) },
      { id: 'sp2', tourId: 't1', body: 'Guitar strings, 10-46', addedBy: 'u-brent', doneAt: null, doneBy: null, at: ago(26) },
      { id: 'sp3', tourId: 't1', body: 'Water for the bus', addedBy: 'u-devin', doneAt: null, doneBy: null, at: ago(4) },
      { id: 'sp4', tourId: 't1', body: 'Sharpies for the signing', addedBy: 'u-brent', doneAt: ago(20), doneBy: 'u-devin', at: ago(28) },
      { id: 'sp5', tourId: 't1', body: 'Batteries, AA', addedBy: 'u-devin', doneAt: ago(2), doneBy: 'u-brent', at: ago(25) }];
    H.poke('supply');
    return H.supplyRows.filter(function (r) { return !r.doneAt; }).length + ' open lines';
  };
  try { if (/[?&]supplies\b/.test(String(location.search || ''))) window.__harness.supplies(); } catch (e) { /* no address to read */ }
  /* ---- TO DO LISTS (0152): a tab on the artist page, and "Your To Do List" on the profile ----
     The database tables todo_items and todo_invites are __harness.todoItems
     ([{ id, artistId, cat, body, assignedTo, due, doneAt, createdBy, createdAt }])
     and __harness.todoInvites ([{ artistId, userId, invitedBy, at }]) here.
     Who sees a list follows the database's rule: the page's runner, its
     Members, and the invited; a task also reaches the person it was handed
     to, wherever they stand. This phone's account is u-devin.
       __harness.todos()    two lists get tasks: I See Stars (the page the
                            test person runs; studio, business management,
                            tour and merch tasks, one of them Brent's and
                            past due, one done, one handed to the test
                            person) and Opener Band (a page somebody else
                            runs, the test person invited onto its list with
                            a task of their own there too), then a 'todo'
                            poke lands, the way the database tells an
                            assignee. The I See Stars page grows its To Do
                            List tab (fourth in its tab row) and the profile
                            its To Do List tab, one tappable row per artist
                            (I See Stars and Opener Band). Since 2026-10-16
                            a profile row opens the LIST ITSELF: a
                            full-height sheet with the artist's name CENTRED
                            on top, holding exactly what the page's tab
                            holds (the Collaborators fold, the tasks, Add a
                            task, Invite someone), never the artist's page;
                            a tick inside it draws at once. The page's own
                            tab stays for whoever browses the page with a
                            list to see. Each task wears the crew list's
                            dress (Devin, 2026-10-16): the tick circle on
                            the left, then the assignee's picture and name
                            as a crew row reads them ('Anyone' on a quiet
                            empty face when nobody has it), then the task
                            words on the right with the due date in the
                            quiet line under them. 'On this list' is gone:
                            the Collaborators fold up top says how many and
                            drops down everyone the list reaches - members
                            and invited - as crew rows with pictures.
                            Or open the page with ?todos.
       __harness.todoItems / __harness.todoInvites   every row; change them
                            by hand, then __harness.poke('todo') and every
                            open list draws again by itself.
       __harness.todosOff = true   the probe answers as with no table (a
                            build ahead of its migration): no tab on any
                            artist page and none on the profile. */
  // Their name the way the real list reads it back (the profiles table here
  // is the people map).
  function todoName(uid) {
    var P = (window.GR_BACKEND && window.GR_BACKEND.people) || {};
    return (P[uid] && P[uid].name) || 'Someone';
  }
  // Who may see an artist's list, the database's own rule: the page's
  // runner, its current Members, and the invited.
  function todoCanSee(artistId) {
    var H = window.__harness;
    var a = (H.acts || []).filter(function (x) { return x.id === artistId; })[0];
    if (a && !a.notMine) return true;
    if (a && (a.members || []).some(function (m) { return m.userId === 'u-devin' && m.kind === 'band' && !m.leftAt; })) return true;
    return (H.todoInvites || []).some(function (v) { return v.artistId === artistId && v.userId === 'u-devin'; });
  }
  function todoOut(r) {
    return { id: r.id, artistId: r.artistId, cat: r.cat, body: r.body, assignedTo: r.assignedTo || null,
      assignedName: r.assignedTo ? todoName(r.assignedTo) : '', due: r.due || null, doneAt: r.doneAt || null,
      createdBy: r.createdBy, createdAt: r.createdAt };
  }
  window.__harness.todos = function () {
    var H = window.__harness, iss = issPage(false);
    // The second list: Opener Band's page, run by somebody else, with the
    // test person invited onto its list and nothing else of the page.
    var ob = (H.acts || []).filter(function (a) { return /opener band/i.test(a.name || ''); })[0];
    if (!ob) {
      H.acts = H.acts || [];
      ob = { id: 'actOB', handle: 'openerband', name: 'Opener Band', avatar: '', bio: '', notMine: true,
        members: [{ userId: 'u-jeff', kind: 'band', role: 'Vocals', endorsed: true }] };
      H.acts.push(ob);
    }
    var day = function (n) { return ymd(new Date(Date.now() + n * 864e5)); };
    var now = new Date().toISOString();
    H.todoInvites = [{ artistId: ob.id, userId: 'u-devin', invitedBy: 'u-jeff', at: now },
      { artistId: iss.id, userId: 'u-ana', invitedBy: 'u-devin', at: now }];
    H.todoItems = [
      { id: 1, artistId: iss.id, cat: 'studio', body: 'Book two days at the studio for vocal comps', assignedTo: null, due: day(6), doneAt: null, createdBy: 'u-devin', createdAt: now },
      { id: 2, artistId: iss.id, cat: 'business management', body: 'Send the W-9 to the Austin promoter', assignedTo: 'u-brent', due: day(-2), doneAt: null, createdBy: 'u-devin', createdAt: now },
      { id: 3, artistId: iss.id, cat: 'tour', body: 'Advance the Phoenix show: doors, curfew, parking', assignedTo: null, due: day(2), doneAt: null, createdBy: 'u-brent', createdAt: now },
      { id: 4, artistId: iss.id, cat: 'merch', body: 'Reorder medium tees before San Antonio', assignedTo: 'u-devin', due: day(1), doneAt: null, createdBy: 'u-brent', createdAt: now },
      { id: 5, artistId: iss.id, cat: 'other', body: 'Thank the Dallas street team', assignedTo: null, due: null, doneAt: now, createdBy: 'u-devin', createdAt: now },
      { id: 6, artistId: ob.id, cat: 'tour', body: 'Share the trailer measurements with the openers', assignedTo: 'u-devin', due: day(3), doneAt: null, createdBy: 'u-jeff', createdAt: now },
      { id: 7, artistId: ob.id, cat: 'other', body: 'Collect sizes for the crew hoodies', assignedTo: null, due: null, doneAt: null, createdBy: 'u-jeff', createdAt: now }
    ];
    H.todoNext = 8;
    H.poke('todo');
    return 'two lists seeded, one task assigned to the test person on each';
  };
  try { if (/[?&]todos\b/.test(String(location.search || ''))) window.__harness.todos(); } catch (e) { /* no address to read */ }
  /* ---- FAVORITE LOCAL SPOTS (0153): the profile's Spots tab, and TOUR SPOTS on the day sheet ----
     The database table local_spots is __harness.spotRows here
     ([{ id, userId, tourId, city, name, kind, note, createdAt }, and since
     0175 lat, lon, address, osmRef when the spot knows where it is]). The
     profile tab holds the test person's own rows (u-devin); the day sheet's
     TOUR SPOTS (the heading green with the tab's heart, each row its
     recommender's photo from __harness.faces) holds every row pinned to the
     open tour whose city keys like the day's city (GR.roadCityKey, the
     counting rules' own spelling), with each saver's first name.
       __harness.spots()    seeds tonight's Austin with places from two
                            people: two of the test person's (one shared with
                            the tour, one kept to themselves) and two of
                            Brent's (both shared), plus one of the test
                            person's in Phoenix a day older. The Spots tab
                            grows its two city folds (the cities are the
                            groups since 2026-10-16, the Tours tab's own
                            pt-run dress: Austin leads with 2 spots because
                            its newest spot is newest, Phoenix under it with
                            1; tap a city and its spots drop down, tap again
                            and they fold) and tonight's day sheet its PLACES
                            RECOMMENDED BY TOUR block, the sheet's LAST
                            section, under ALSO IN TOWN TONIGHT when both
                            show (three places: Devin's tacos and Brent's
                            two; the unshared coffee shop stays off it). Or
                            open the page with ?spots.
       __harness.spotRows   every row; change them by hand, then
                            __harness.poke('spots') and every open page draws
                            again by itself.
       __harness.spotsOff = true   the probe answers as with no table (a
                            build ahead of its migration): no Spots tab on
                            the profile and no block on any day sheet.
     SPOT CARDS (0175): a tap on any spot row (the Spots tab inside an open
     city, the day sheet's TOUR SPOTS, Today's spots from people you follow)
     opens the spot's card: the name big, kind and neighbourhood, Walk /
     Website / Call, the Hours and Distance facts, the address, the week's
     hours, the phone and site, who recommended it with their photo and
     note, and Edit spot on your own. The server's details road
     (spot_details_ask/take) is played by spotDetails here: the first open
     of a spot in a session answers what the row has with "Looking up the
     details…" and fills in after __harness.spotDetailsBeat ms (600 by
     default; 0 for at once); a spot with no lat/lon is looked up in
     __harness.placeRows by its exact name in its own town, as the server's
     look-up does, and the details come from __harness.placeDetails by the
     map's id (osmRef). With ?spots: Veracruz All Natural knows where it is
     and has every detail (Open or Closed by the clock, since tonight's town
     is Austin); Houndstooth Coffee and Hotel Vegas are found on open (Hotel
     Vegas' hours run past midnight); Barton Springs Pool is found but the
     map has no details for it (no Website, no Call, no Hours); The
     Churchill in Phoenix is not found at all (Walk goes by its name and
     town, no Distance, no credit line).
       __harness.here(lat, lon, state)   the phone's location for the cards:
                            here(30.2669, -97.7428) is downtown Austin with
                            location already allowed (Distance and the Walk
                            minutes show at once); here(30.2669, -97.7428,
                            'prompt') has the phone not asked yet (the card
                            shows a green How far? that asks on a tap, then
                            fills in); here(null) is location turned off (no
                            Distance at all). Or open the page with ?here
                            (allowed) or ?hereask (not asked yet). Without
                            any of these the browser's own location is used.
       __harness.placeDetails   { osmRef: { website, phone, hours, cuisine,
                            area, street, postcode } }, change by hand.
       __harness.spotDetailAsks  every card's ask: [{ id, face }] (face is
                            true when the card had no photo for the
                            recommender and asked the server for it).
       __harness.spotDetailsOff = true   the road answers as with no 0175:
                            cards open from what the row carries, no details.
       __harness.faces      { userId: photo } for the day sheet's crew photos
                            (the tour_faces answer); ?spots seeds Brent's.
     FINDING PLACES AS YOU TYPE (0164, NEAR THE CITY since 0166): the
     Add/Edit spot sheet's Name field searches once three characters are
     down, and a quiet list drops under the field (name over street and
     town, '212 East 6th Street · Austin' - the street when the map knows
     one, the town always - with Places from OpenStreetMap at its foot).
     The ask leans to a town, like the map in his pocket: the sheet's City
     words when two or more characters are typed there, else tonight's city
     while the account is on a live tour (the harness run is, so an empty
     City field leans to Austin), else nowhere. Picking a row fills the
     name, the city, and the Kind when the row's OpenStreetMap word maps
     onto one of the app's kinds. Open the page with ?spots (or plain),
     profile > Spots > Add a spot, and type "voo" at 375 pixels wide to see
     it: two Voodoo Doughnut rows, the Austin one first while the sheet
     leans there; clear the City field to 'Portland' and the Portland one
     leads instead.
       __harness.placeRows  what typing finds: rows of { name, kind, street,
                            city, state, country }, matched on the name's
                            words, up to eight, after a wire's beat; rows
                            whose city matches the lean lead the list.
                            Seeded at load (no switch needed) with the two
                            Voodoo Doughnut branches (picking one sets Kind
                            to Food), a Berlin nightclub (no state, so it
                            writes "Berlin, Germany" and sets Club), a row
                            with no street (Barton Springs Pool: the muted
                            line is the town alone), and a Portland books
                            row whose word maps onto nothing, so the picker
                            is left as it stands.
       __harness.placeAsks  every ask the sheet sent: [{ q, near }], so a
                            check can see what the lean really was.
       __harness.placesOff = true   the probe answers as with no 0164: the
                            Name field types plain, no list under it.
       ?placeslow (or __harness.placesReadyAt = Date.now() + ms): the probe
                            takes its real-world beat to answer, the way a
                            fresh session's does; typing at once must STILL
                            end in suggestions (the backend waits the probe
                            out). The first-open race Devin hit, kept
                            visible.
     SPOTS FROM PEOPLE YOU FOLLOW (0169): the profile Today tab's closing
     Spots section - tonight's town through the people this account follows,
     the viewer's own (only their phone asks with their follows; the rest of
     the tour sees nothing of it). The database function follow_spots(near)
     is __harness.followSpotRows here, rows the shape the live answer takes
     ({ userId, who, city, name, kind, note, createdAt }), matched on the
     town before near's comma (the live rule: the function keys only
     split_part(near, ',', 1), so a row whose city says 'Austin, TX' never
     matches - the seeded rows say 'Austin' alone, as live rows that match
     do) and handed back newest first.
       __harness.followSpots()  seeds two spots in tonight's Austin from two
                            people the test person follows who are NOT on
                            the tour (one with a note, one without). Open
                            the profile's Today tab and the quiet Spots
                            section sits under History, each row the place,
                            its kind, the note when it has one, and
                            'from <who>'. Or open the page with
                            ?followspots.
       __harness.followSpotRows  every row; change them by hand, then
                            __harness.poke('followspots') and every open
                            page draws again by itself.
       __harness.followSpotsOff = true   the probe answers as with no
                            function (a build ahead of 0169): Today simply
                            ends at History. */
  // A row the way the real backend hands one over (the key worked out from
  // the city with the one rule, as the database's trigger keeps it).
  function spotOut(r) {
    var it = { id: r.id, tourId: r.tourId || null, city: r.city, cityKey: window.GR.roadCityKey(String(r.city).split(',')[0]),
      name: r.name, kind: r.kind, note: r.note || '', createdAt: r.createdAt };
    // Where it is (0175), when the row knows.
    if (typeof r.lat === 'number' && typeof r.lon === 'number') { it.lat = r.lat; it.lon = r.lon; }
    if (r.address) it.address = r.address;
    if (r.osmRef) it.osmRef = r.osmRef;
    return it;
  }
  // Where a spot is, as a save hands it over (0175): kept as the table keeps it.
  function spotWhere(row, p) {
    if ('lat' in p || 'lon' in p) {
      var ok = typeof p.lat === 'number' && typeof p.lon === 'number';
      row.lat = ok ? p.lat : undefined; row.lon = ok ? p.lon : undefined;
    }
    if ('address' in p) row.address = String(p.address || '').slice(0, 160);
    if ('osmRef' in p) row.osmRef = /^[NWR]\d{1,20}$/.test(String(p.osmRef || '')) ? p.osmRef : '';
  }
  // The server's look-up by name and town for a spot that does not know
  // where it is, played on __harness.placeRows: the exact name in its own town.
  function spotFind(row) {
    if (typeof row.lat === 'number' || row.osmRef) return;
    var G = window.GR, town = G.roadCityKey(String(row.city || '').split(',')[0]);
    var hit = (window.__harness.placeRows || []).filter(function (p) {
      return String(p.name || '').toLowerCase() === String(row.name || '').toLowerCase() &&
        G.roadCityKey(String(p.city || '')) === town && typeof p.lat === 'number';
    })[0];
    if (!hit) return;
    row.lat = hit.lat; row.lon = hit.lon;
    row.address = [hit.street, hit.postcode].filter(Boolean).join(', ');
    row.osmRef = hit.osmRef || '';
  }
  window.__harness.spots = function () {
    var H = window.__harness;
    var now = new Date().toISOString();
    H.spotRows = [
      { id: 1, userId: 'u-devin', tourId: 't1', city: 'Austin, TX', name: 'Veracruz All Natural', kind: 'food', note: 'Migas tacos, ten minutes from the venue', createdAt: now,
        lat: 30.2557, lon: -97.7238, address: '1704 East Cesar Chavez Street, 78702', osmRef: 'N1001' },
      { id: 2, userId: 'u-devin', tourId: null, city: 'Austin, TX', name: 'Houndstooth Coffee', kind: 'coffee', note: 'Quiet in the morning', createdAt: now },
      { id: 3, userId: 'u-brent', tourId: 't1', city: 'Austin, TX', name: 'Hotel Vegas', kind: 'bar', note: 'Patio after load out', createdAt: now },
      { id: 4, userId: 'u-brent', tourId: 't1', city: 'Austin, TX', name: 'Barton Springs Pool', kind: 'to do', note: 'Cold water, best on a day off', createdAt: now },
      // A day older, so the Spots tab's newest-city-first order can be seen:
      // Austin (tonight) leads, Phoenix folds under it.
      { id: 5, userId: 'u-devin', tourId: 't1', city: 'Phoenix, AZ', name: 'The Churchill', kind: 'club', note: '', createdAt: new Date(Date.now() - 864e5).toISOString() }
    ];
    H.spotNext = 6;
    H.spotDetailSeen = {};
    // What the map knows (0175), by its id; Barton Springs (W1004) has nothing.
    H.placeDetails = {
      N1001: { website: 'https://example.com/veracruz', phone: '+1 512-555-0142', hours: 'Mo-Su 07:00-15:00',
        cuisine: 'mexican', area: 'East Cesar Chavez', street: '1704 East Cesar Chavez Street', postcode: '78702' },
      N1002: { website: 'https://example.com/houndstooth', hours: 'Mo-Fr 07:00-18:00; Sa,Su 08:00-18:00', cuisine: 'coffee_shop', area: 'Rosedale' },
      N1003: { phone: '+1 512-555-0187', hours: 'Mo-Th 17:00-00:00; Fr,Sa 15:00-02:00; Su 15:00-00:00', area: 'East Austin' },
      N1201: { hours: 'Mo-Su 16:00-02:00', area: 'East Austin' }
    };
    // Brent's profile photo, the way the tour's faces answer carries one.
    H.faces = Object.assign({}, H.faces, { 'u-brent': 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#3a6ea5"/>' +
      '<circle cx="20" cy="15" r="7" fill="#f1d2b6"/><rect x="8" y="25" width="24" height="15" rx="8" fill="#22303f"/></svg>') });
    // (No word of its own on the real thing; here the nudge just redraws open pages.)
    H.poke('spots');
    return 'Austin seeded from two people, one Phoenix spot a day older';
  };
  try { if (/[?&]spots\b/.test(String(location.search || ''))) window.__harness.spots(); } catch (e) { /* no address to read */ }
  // Spots from people you follow (0169): the live function's answer, played
  // by rows in __harness.followSpotRows. Rosa and Theo are people the test
  // person follows who are not on the harness tour; their word reaches this
  // phone alone.
  window.__harness.followSpots = function () {
    var H = window.__harness;
    H.followSpotRows = [
      { id: 901, userId: 'u-rosa', who: 'Rosa Vane', city: 'Austin', name: 'Nickel City', kind: 'bar', note: 'Frozen Irish coffee after the show', createdAt: new Date().toISOString(),
        lat: 30.2697, lon: -97.7222, address: '1133 East 11th Street, 78702', osmRef: 'N1201' },
      { id: 902, userId: 'u-theo', who: 'Theo Marsh', city: 'Austin', name: 'Cenote', kind: 'coffee', note: '', createdAt: new Date(Date.now() - 864e5).toISOString() }
    ];
    // (No word of its own on the real thing; here the nudge just redraws open pages.)
    H.poke('followspots');
    return 'two Austin spots from people the test person follows, one with a note';
  };
  try { if (/[?&]followspots\b/.test(String(location.search || ''))) window.__harness.followSpots(); } catch (e) { /* no address to read */ }
  // The places typing can find (0164), there from the start so the Name
  // field's list can be seen without a switch. Rows the shape the real take
  // hands over; kind is OpenStreetMap's own word.
  // Since 0175 each also says where it is: postcode, lat, lon and the map's id.
  window.__harness.placeRows = [
    { name: 'Voodoo Doughnut', kind: 'pastry', street: '22 Southwest 3rd Avenue', city: 'Portland', state: 'Oregon', country: 'United States', postcode: '97204', lat: 45.5226, lon: -122.6731, osmRef: 'N1101' },
    { name: 'Voodoo Doughnut', kind: 'pastry', street: '212 East 6th Street', city: 'Austin', state: 'Texas', country: 'United States', postcode: '78701', lat: 30.2672, lon: -97.7408, osmRef: 'N1102' },
    { name: 'Voodoo Brewing', kind: 'bar', street: '215 Arch Street', city: 'Meadville', state: 'Pennsylvania', country: 'United States', postcode: '16335', lat: 41.6407, lon: -80.1514, osmRef: 'N1103' },
    { name: 'Veracruz All Natural', kind: 'restaurant', street: '1704 East Cesar Chavez Street', city: 'Austin', state: 'Texas', country: 'United States', postcode: '78702', lat: 30.2557, lon: -97.7238, osmRef: 'N1001' },
    { name: 'Houndstooth Coffee', kind: 'cafe', street: '4200 North Lamar Boulevard', city: 'Austin', state: 'Texas', country: 'United States', postcode: '78756', lat: 30.3082, lon: -97.7395, osmRef: 'N1002' },
    { name: 'Hotel Vegas', kind: 'bar', street: '1502 East 6th Street', city: 'Austin', state: 'Texas', country: 'United States', postcode: '78702', lat: 30.2629, lon: -97.7276, osmRef: 'N1003' },
    { name: 'Berghain', kind: 'nightclub', street: 'Am Wriezener Bahnhof', city: 'Berlin', state: '', country: 'Germany', postcode: '10243', lat: 52.5111, lon: 13.443, osmRef: 'W1104' },
    { name: 'Barton Springs Pool', kind: 'park', street: '', city: 'Austin', state: 'Texas', country: 'United States', postcode: '', lat: 30.264, lon: -97.7713, osmRef: 'W1004' },
    { name: 'Powell’s City of Books', kind: 'books', street: '1005 West Burnside Street', city: 'Portland', state: 'Oregon', country: 'United States', postcode: '97209', lat: 45.5231, lon: -122.6812, osmRef: 'W1105' }
  ];
  /* The phone's location for spot cards (0175): see SPOT CARDS under
     FAVORITE LOCAL SPOTS. Plays the browser's own location and its
     permission answer: 'granted' answers at once, 'prompt' answers the
     How far? tap (and is 'granted' after), a null lat is location off. */
  window.__harness.here = function (lat, lon, state) {
    var st = lat == null ? 'denied' : (state || 'granted');
    var pos = lat == null ? null : { coords: { latitude: lat, longitude: lon, accuracy: 30 } };
    try {
      navigator.geolocation.getCurrentPosition = function (ok, fail) {
        setTimeout(function () {
          if (pos) { st = 'granted'; ok(pos); } else if (fail) fail({ code: 1, message: 'User denied Geolocation' });
        }, 300);
      };
      if (navigator.permissions) {
        navigator.permissions.query = function (d) {
          return Promise.resolve({ state: d && d.name === 'geolocation' ? st : 'prompt' });
        };
      }
    } catch (e) { return 'this browser would not take the stand-in'; }
    return pos ? 'the phone is at ' + lat + ', ' + lon + ' (' + st + ')' : 'location is off';
  };
  try {
    if (/[?&]here\b/.test(String(location.search || ''))) window.__harness.here(30.2669, -97.7428);
    else if (/[?&]hereask\b/.test(String(location.search || ''))) window.__harness.here(30.2669, -97.7428, 'prompt');
  } catch (e) { /* no address to read */ }
  /* ---- ALSO IN TOWN TONIGHT (0157): the night's other concerts on the day sheet ----
     The database's little cache and its two functions are played by
     __harness.cityEventRows here ({ showId: [{ name, venue, time, url }] }).
     The block sits under everything on tonight's day sheet, each row linking
     its Ticketmaster page, with the Listings: Ticketmaster line under it; it
     only draws on the day being played and only when there are rows.
       __harness.cityEvents()   seeds five concerts for tonight's Austin show
                            (s1) and answers how many. Open the tour's day
                            sheet and the block is there. Or open the page
                            with ?cityevents. (An already-open sheet holds
                            its empty answer up to a minute before asking
                            again.)
       __harness.cityEventRows  every seeded answer, by show id; change it,
                            then reopen the day sheet.
       __harness.cityEventsWait = 2   the next two asks answer {wait}, the
                            way the server answers while Ticketmaster is
                            asked, so the app's polling of the take function
                            is tested: the block appears a few seconds late.
       __harness.cityEventsDark = true   every ask answers {off}, as with no
                            key in the dashboard's Vault: the app stays
                            silent.
       __harness.cityEventsOff = true   the probe answers as with no function
                            (a build ahead of its migration): no block on any
                            day sheet. */
  window.__harness.cityEvents = function () {
    var H = window.__harness;
    H.cityEventRows = H.cityEventRows || {};
    H.cityEventRows.s1 = [
      { name: 'The Midnight Division', venue: 'Stubbs', time: '8:00 PM', url: 'https://www.ticketmaster.com/event/0000000000000001' },
      { name: 'Glass Harbor', venue: 'Emos', time: '7:30 PM', url: 'https://www.ticketmaster.com/event/0000000000000002' },
      { name: 'Carmen Vela', venue: 'ACL Live', time: '8:00 PM', url: 'https://www.ticketmaster.com/event/0000000000000003' },
      { name: 'Driveway Kids', venue: 'The Parish', time: '9:00 PM', url: 'https://www.ticketmaster.com/event/0000000000000004' },
      { name: 'Low Tide Choir', venue: 'Antones', time: '7:00 PM', url: 'https://www.ticketmaster.com/event/0000000000000005' }
    ];
    return H.cityEventRows.s1.length + ' concerts seeded for tonight';
  };
  try { if (/[?&]cityevents\b/.test(String(location.search || ''))) window.__harness.cityEvents(); } catch (e) { /* no address to read */ }
  /* ---- VENUE HISTORY (0160): "Your 4th time at Mohawk" under tonight's venue ----
     The database's venue_history is played by __harness.venueHistoryRows here
     ({ showId: { artistId, artist, count, nights: [{ date, name, kind }] } }).
     A show with no row answers nothing, the way the server answers a tour
     with no artist page or a page with no road history: no line at all. The
     probe answers true here. The line sits under the venue (and its address)
     on Today and on the day sheet, only on the day being played; a tap opens
     the sheet of the nights before tonight, newest first.
     The line lives in two places: on the TOUR day sheet it still sits under
     the venue; on the profile's TODAY tab it is the History section right
     under the schedule, where Notes was (2026-10-16 night), dressed as the
     schedule is: the centred heading over one card of label-and-value rows.
     The venue line is the first row (a chevron and a tap when there are
     earlier nights); then, from 0174, "Times in Austin" (cityCount nights
     before tonight, or "First time"), "Last time in Austin" (cityLast: its
     tour and date), "Average merch" (merchAvg over merchN shows, for
     everyone on the tour) and "Average guarantee" (guaranteeAvg over
     guaranteeN shows, which the server sends to Members alone); last the
     "Rating" row when the answer carries 'stars' and 'ratings' (0165, the
     band alone). A key the answer lacks is a row that is not there.
     HOOKS:
       __harness.venueHistory()   what a Member (or the tour's owner) sees: five
                            earlier nights at Mohawk for tonight's Austin show (s1),
                            two tours, a festival, a third tour and a year's shows
                            outside a tour, so Today and the day sheet read "Your
                            6th time at Mohawk"; the town (9 nights before tonight,
                            last on Spin the Wheel, Mar 7, 2026), merch $2,311 over
                            3 shows, guarantee $6,250 over 2 shows, and the band's
                            own stars (4.5 from 3 ratings). Answers the words. Or
                            open the page with ?venuehistory, then the profile's
                            TODAY tab.
       __harness.venueHistoryCrew()   what a crew phone sees: the same answer with no
                            guarantee and no stars (the server never sends either
                            to Crew or a hired Manager). Or ?venuehistory=crew.
                            Delete the city and money keys from
                            __harness.venueHistoryRows.s1 (then switch tabs) for
                            the look before 0174 is live: the venue row alone.
       __harness.venueHistoryFirst()   tonight's row with no nights before it: the
                            line reads "Your first time at Mohawk" and is not a button;
                            the town row reads "First time".
       __harness.venueHistoryRows   every seeded answer, by show id. Change it, then
                            redraw (switch tabs); delete s1's row and the line goes.
       __harness.venueHistoryLast   the last ask the app made: { tourId, showId, sig }
                            (sig is the venue and city the phone holds, lower-cased).
       __harness.venueHistoryOff = true   the probe answers false, as before migration
                            0160: no line on Today or the day sheet. */
  window.__harness.venueHistory = function () {
    var H = window.__harness, a = creditIss();
    H.venueHistoryRows = H.venueHistoryRows || {};
    H.venueHistoryRows.s1 = { artistId: a ? a.id : 'act-iss', artist: 'I See Stars', count: 5, stars: 4.5, ratings: 3, nights: [
      { date: '2026-03-07', name: 'Spin the Wheel', kind: 'tour' },
      { date: '2019-03-15', name: 'SXSW 2019', kind: 'festival' },
      { date: '2017-03-14', name: 'Treehouse Tour', kind: 'tour' },
      { date: '2012-03-04', name: 'Digital Renegade', kind: 'tour' },
      { date: '2010-08-21', name: 'Shows outside a tour', kind: 'shows' }],
      cityCount: 9, cityLast: { date: '2026-03-07', name: 'Spin the Wheel', kind: 'tour' },
      merchAvg: 2310.67, merchN: 3, guaranteeAvg: 6250, guaranteeN: 2 };
    emit();   // (open pages draw again, as when the real answer lands)
    return 'Your 6th time at Mohawk';
  };
  window.__harness.venueHistoryCrew = function () {
    var H = window.__harness;
    H.venueHistory();
    ['guaranteeAvg', 'guaranteeN', 'stars', 'ratings'].forEach(function (k) { delete H.venueHistoryRows.s1[k]; });
    emit();
    return 'Your 6th time at Mohawk, the town and merch; no guarantee, no stars';
  };
  window.__harness.venueHistoryFirst = function () {
    var H = window.__harness, a = creditIss();
    H.venueHistoryRows = H.venueHistoryRows || {};
    H.venueHistoryRows.s1 = { artistId: a ? a.id : 'act-iss', artist: 'I See Stars', count: 0, nights: [], cityCount: 0 };
    emit();
    return 'Your first time at Mohawk';
  };
  try {
    if (/[?&]venuehistory=crew\b/.test(String(location.search || ''))) window.__harness.venueHistoryCrew();
    else if (/[?&]venuehistory\b/.test(String(location.search || ''))) window.__harness.venueHistory();
  } catch (e) { /* no address to read */ }
  /* ---- TODAY AS CLIFF NOTES (2026-10-16): the profile's Today keeps six kinds of schedule row ----
     Devin: "the today tab should be more 'cliff notes' of the day sheet...
     Load in, soundcheck, VIP's (only if it's pertaining to the band that is
     using, doors, set times, bus call, history, and the ratings." Of the
     day sheet's SCHEDULE, Today keeps exactly Load in, Soundcheck, VIP,
     Doors, Set times and Bus call; lobby call, last call, load out, the
     drive, and the sheet's leftover lines (More from the sheet - where a
     curfew or catering call lands) show ONLY on the Day sheet tab. Where a
     row names a band (soundchecks, set times on a shared bill), Today keeps
     the rows naming the tour's "your band" or naming no band, and drops
     another band's; VIP, one line of text, follows the same rule by its
     words. With no "your band" picked, nothing is called foreign. The
     venue/wifi section, amenities, notes, the Tonight card, History and Bus
     Check in all stay as they were.
     HOOKS:
       __harness.cliff()    seeds a FULL day sheet on tonight's Austin show
                            (lobby call, load in, both bands' soundchecks
                            and set times, VIP, last call, doors, load out,
                            bus call, the drive, a Curfew and a Catering
                            extra) and sets "your band" to I See Stars.
                            The profile's TODAY then shows, under Schedule:
                            Load in, Soundcheck (I See Stars only - Opener
                            Band's row is the seeded foreign row, absent),
                            VIP, Doors, Set times (I See Stars only) and
                            Bus call, nothing else; open the tour's DAY
                            SHEET tab beside it for every row including
                            Opener Band's, lobby call, load out and the
                            curfew. Answers what Today keeps. Or open the
                            page with ?cliff.
                            delete tours.t1.ourBand (then switch tabs) and
                            Today keeps both bands' rows: no band picked,
                            nothing is foreign. */
  window.__harness.cliff = function () {
    tours.t1.ourBand = 'I See Stars';
    tours.t1.shows.s1.daySheet = Object.assign({}, tours.t1.shows.s1.daySheet, {
      lobbyCall: '2:00PM', loadIn: '3:00PM', loadInEnd: '4:00PM',
      soundchecks: [
        { band: 'Opener Band', time: '4:30PM', end: '5:00PM' },
        { band: 'I See Stars', time: '5:00PM', end: '5:45PM' }],
      vip: 'Meet & greet 6:00PM', lastCall: '6:30PM', doors: '7:00PM',
      setTimes: [
        { band: 'Opener Band', time: '8:00PM', end: '8:45PM' },
        { band: 'I See Stars', time: '9:15PM', end: '10:30PM' }],
      loadOut: '11:00PM', busCall: '11:45PM', driveNext: 'Overnight to San Antonio',
      extras: [{ label: 'Curfew', value: '11:00PM' }, { label: 'Catering', value: '5:30PM' }] });
    emit();
    return 'Today keeps Load in, Soundcheck (I See Stars), VIP, Doors, Set times (I See Stars), Bus call; the Day sheet tab keeps it all';
  };
  try { if (/[?&]cliff\b/.test(String(location.search || ''))) window.__harness.cliff(); } catch (e) { /* no address to read */ }
  /* ---- THE DAY SHEET'S BUTTONS AND NO NOTES (2026-10-16 night) ----
     Devin: "get rid of 'edit day sheet' button at the bottom if the day
     sheet is already added... 'import from master tour' - put that under
     the spots and notes. Get rid of 'copy day sheet' and just put the copy
     icon underneath the pencil icon but paralell with the 'schedule'
     text", and "just get rid of notes on both main day sheet and the today
     tab". On the tour's DAY SHEET tab, tonight's Austin show (s1) has a
     sheet: no big button at the bottom, the pencil left of the venue name
     edits it, the copy icon sits right under the pencil on the Schedule
     heading's line, the spots sit under the sheet, and Import from Master
     Tour is the last thing on the page. Tap tomorrow's chip in the day
     rail (San Antonio, no sheet): "No day sheet added." with the "Fill in
     the day sheet" button under it, and no copy icon.
     HOOKS:
       __harness.dayNotes()   writes Notes on tonight's sheet. Neither the Day
                            sheet tab nor Today shows them, the editor (the
                            pencil) has no Notes box, Post day sheet keeps
                            them in tours.t1.shows.s1.daySheet.notes, and the
                            copy icon leaves them out. Or ?daynotes.
       __harness.dayBare()    takes tonight's sheet away (address included):
                            the Day sheet tab shows "No day sheet added." and
                            the Fill in button. Or ?daybare. */
  window.__harness.dayNotes = function () {
    tours.t1.shows.s1.daySheet = Object.assign({}, tours.t1.shows.s1.daySheet, { notes: 'Side door, parking pass at will call' });
    emit();
    return 'notes saved on tonight, shown nowhere';
  };
  window.__harness.dayBare = function () {
    tours.t1.shows.s1.daySheet = null;
    emit();
    return 'tonight has no day sheet';
  };
  try {
    if (/[?&]daynotes\b/.test(String(location.search || ''))) window.__harness.dayNotes();
    if (/[?&]daybare\b/.test(String(location.search || ''))) window.__harness.dayBare();
  } catch (e) { /* no address to read */ }
  /* ---- THE GREEN CHECK EVERYWHERE (0161): the check by the rule in every list that names a person ----
     The database's person_checks (verified, or Bronze plus an endorsement
     that stands) is played by __harness.checks here: { userId: true | false }.
     Out of the box Devin (checked by Greenroom), Brent (Bronze with an
     endorsement), Ana Reyes (found by @ana) and the second of the seeded Top
     Fans (u-fan2) wear it; anyone not in the map answers false. The probe
     answers true here. A list draws the check at once for someone already
     answered for, and an empty place for the rest, then asks once for the
     whole list and fills the places in where they stand. Where to look: an
     artist page's Members and Crew tabs, the Overview's crew list, Search
     (results, Recent, Following, People you tour with), the profile's
     followers and following, Messages, the tour's Chat, the Add members and
     To Do invite pickers, Top Fans (__harness.topfans()), a claim or a
     listing request being answered, and the people who joined a page before
     it was claimed.
     HOOKS:
       __harness.checks       the answers, by account id. Change one, then
                            __harness.checksReset() so the phone forgets what it
                            was told and the open page draws again.
       __harness.checksReset()   forgets every answer held (as ten minutes going by).
       __harness.checkAsks    every ask the app made, one list of ids per ask: a list
                            drawn once is one ask, and nobody already answered for
                            is asked about again.
       __harness.checksLate = 1500   answers after that many milliseconds, so the
                            checks can be seen filling in where they stand (no
                            redraw, nothing moves but the check).
       __harness.checksOff = true   the probe answers false, as before migration
                            0161: every list draws the check for a verified
                            account only, exactly as before, and nothing is asked. */
  window.__harness.checksReset = function () {
    var H = window.__harness;
    H.checksHeld = {};
    emit();   // (open pages draw again)
    return 'answers forgotten';
  };
  /* ---- ARTIST PICTURES (0158): a bare page's picture from Wikimedia Commons ----
     The worker that walks MusicBrainz to Wikidata to Commons never runs
     here; what it leaves behind does: an unclaimed page whose avatar came
     that way carries avatarCredit ("Photo: <author> - <licence>") and
     avatarSource (the picture's own Commons page) on its card, and the
     artist page draws a quiet credit line under the header linking the
     source. A page whose picture an owner picked carries no credit and no
     line.
       __harness.artistPhoto()  gives the unclaimed Sleeping With Sirens page
                            (pub1) a small pretend picture with its credit
                            and source. Search for it and open the page: the
                            photo is there with the credit line under the
                            header. Or open the page with ?artistphoto.
       __harness.ghosts[0].avatar / .avatarCredit / .avatarSource   the raw
                            fields; empty the credit and the line goes while
                            the picture stays, as after an owner's upload. */
  window.__harness.artistPhoto = function () {
    var g = ghostList()[0];
    g.avatar = 'data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22><rect width=%2264%22 height=%2264%22 fill=%22%23194d33%22/><circle cx=%2232%22 cy=%2226%22 r=%2210%22 fill=%22%23cde8d8%22/><path d=%22M12 56c3-12 10-16 20-16s17 4 20 16z%22 fill=%22%23cde8d8%22/></svg>';
    g.avatarCredit = 'Photo: Alex Example - CC BY-SA 4.0';
    g.avatarSource = 'https://commons.wikimedia.org/wiki/File:Example_band.jpg';
    return 'the unclaimed page has a credited picture';
  };
  try { if (/[?&]artistphoto\b/.test(String(location.search || ''))) window.__harness.artistPhoto(); } catch (e) { /* no address to read */ }
  try {
    var offAsk = /[?&]offtour=(next|none|travel)\b/.exec(String(location.search || ''));
    if (offAsk) window.__harness.offTour(offAsk[1]);
    if (/[?&]undated\b/.test(String(location.search || ''))) window.__harness.undated(true);
    if (/[?&]offyear\b/.test(String(location.search || ''))) window.__harness.offYear(true);
  } catch (e) { /* no address to read */ }
  // Asks to be paid back (see reimbursementsFor below).
  function reimbList() {
    var H = window.__harness, ago = function (ms) { return new Date(Date.now() - ms).toISOString(); };
    if (!H.reimb) H.reimb = [
      { id: 'rb-jeff-1', tourId: 't1', mine: false, name: 'Jeff Mora', amount: 60, what: 'Parking at the venue', date: ymd(new Date(today.getTime() - 4 * 864e5)),
        status: 'paid', paidAt: ago(26 * 36e5), paidBy: 'Devin Oliver', how: 'cash', feedId: '', closedBy: '', closedAt: null, createdAt: ago(80 * 36e5) },
      { id: 'rb-brent-1', tourId: 't1', mine: false, name: 'Brent Allen', amount: 64.12, what: 'Gas for the van', date: ymd(new Date(today.getTime() - 864e5)),
        status: 'open', paidAt: null, paidBy: '', how: '', feedId: '', closedBy: '', closedAt: null, createdAt: ago(20 * 36e5) },
      { id: 'rb-tasha-1', tourId: 't1', mine: false, name: 'Tasha Lane', amount: 18, what: 'Guitar strings', date: ymd(new Date(today.getTime() - 2 * 864e5)),
        status: 'open', paidAt: null, paidBy: '', how: '', feedId: '', closedBy: '', closedAt: null, createdAt: ago(3 * 36e5) }];
    return H.reimb;
  }
  // One write: the answer __harness.reimbFail forces, else what the change says; then the tours go out again.
  // __harness.reimbLost = true: the write lands and its answer is lost (weak signal), so the app hears 'unavailable'.
  function reimbAnswer(change) {
    var H = window.__harness;
    var out = H.reimbFail ? { ok: false, why: String(H.reimbFail) } : change();
    if (!H.reimbFail && H.reimbLost) out = { ok: false, why: 'unavailable' };
    setTimeout(emit, 0);
    return Promise.resolve(out);
  }
  window.__harness.members = []; window.__harness.invited = []; window.__harness.notified = []; window.__harness.notes = [];
  /* ---- THE TOUR CHAT, LIKE A PHONE'S GROUP CHAT (2026-10-17) ----
     Devin: "Let's make the greenroom chat better. Look at the reference I
     sent" (an iPhone group chat). __harness.chat() (or open the page with
     ?chat) seats Jeff Mora and Maya Ortiz on the harness tour beside Brent
     (Brent and Maya with photos, Jeff without) and fills its chat: Brent,
     Jeff, a run of three from Maya, half an hour's quiet, two of yours,
     then Brent again. Open Chat on the bottom bar:
       the top: Brent's, Jeff's and Maya's faces overlapping over the tour's
         name (Harness run) in a grey pill, ARI on the left, the bell on the
         right;
       the messages: each sender's name in small grey over the first bubble
         of their run and their photo (Jeff: his initial) by the last; grey
         bubbles on the left, yours green on the right; the curl only on the
         last bubble of a run; a time line ("Today 1:05 PM") over the first
         message and again after the quiet;
       a tap on a bubble shows its time, and Delete for whoever may delete
         it (tap again to close); the page opens at the newest message;
       the bar: a round + (More: Ari, Send Tour Alert, tour notifications)
         and the grey "Message" pill. Send one: it lands at the bottom, green.
     ?chat&crew: the same chat on a Crew phone (no ARI, no Send Tour Alert;
     Delete only under your own). */
  window.__harness.chat = function () {
    var H = window.__harness, now = Date.now(), min = 6e4;
    var seat = function (uid, name, role) {
      if (H.crew.some(function (r) { return r.userId === uid; })) return;
      var mail = name.split(' ')[0].toLowerCase() + '@example.com';
      H.crew.push({ owner: false, role: 'viewer', userId: uid, name: name, email: mail, invitedEmail: mail, phone: '', tourRole: role, joined: true });
    };
    seat('u-jeff', 'Jeff Mora', 'FOH Engineer');
    seat('u-maya', 'Maya Ortiz', 'Merch');
    var face = function (bg, skin, shirt) {
      return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="' + bg + '"/>' +
        '<circle cx="20" cy="15" r="7" fill="' + skin + '"/><rect x="8" y="25" width="24" height="15" rx="8" fill="' + shirt + '"/></svg>');
    };
    H.faces = Object.assign({}, H.faces, { 'u-brent': face('#3a6ea5', '#f1d2b6', '#22303f'), 'u-maya': face('#8a4f7d', '#e7c1a0', '#2b2b2b') });
    var say = function (k, uid, name, ago, body) { return { id: 'n-chat-' + k, day: 'chat', author: name, addedBy: uid, at: now - ago * min, body: body }; };
    H.notes = (H.notes || []).filter(function (n) { return !/^n-chat-/.test(n.id); }).concat([
      say(1, 'u-brent', 'Brent Allen', 190, 'Load in moved to 2:30. The dock is shared with the opener.'),
      say(2, 'u-jeff', 'Jeff Mora', 186, 'Copy'),
      say(3, 'u-maya', 'Maya Ortiz', 180, 'Packed and ready. Is the bus still out back or did it move?'),
      say(4, 'u-maya', 'Maya Ortiz', 179, 'Grabbing coffee first'),
      say(5, 'u-maya', 'Maya Ortiz', 178, 'Anyone want one?'),
      say(6, 'u-devin', 'Devin Oliver', 95, 'Bus is out front now'),
      say(7, 'u-devin', 'Devin Oliver', 94, 'Doors at 7, we are on at 9:40'),
      say(8, 'u-brent', 'Brent Allen', 20, 'On my way')]);
    emit();
    return 'Jeff and Maya seated, eight messages in the chat';
  };
  try { if (/[?&]chat\b/.test(String(location.search || ''))) window.__harness.chat(); } catch (e) { /* no address to read */ }
  /* ---- THE TASKS DECK: EVERY JOB DONE ONCE (2026-10-17) ----
     Devin: "you should never do a task twice. Whether you've done it through
     the task button or did it through the app." __harness.taskDeck() (or open
     the page with ?taskdeck) puts one of each case on the harness tour. Then
     the profile's Tasks button (or Tasks, List) shows:
       Ari needs an answer, Dallas merch ($900 logged, the settlement says
         $1,040). Open Budget, Income, Dallas, type 1040 for merch, Save:
         the card is gone, nothing written by Ari (her Yes now answers that
         the number moved). Leave merch at 900 and the card stays.
       Special request: only Brent's waiting one. The one this phone asked
         itself and the one already accepted never show.
       New expenses: only Brent's Whataburger. The Guitar Center charge the
         bank feed filed with this account's name never shows. Opening
         Budget (Expenses) marks the rest seen. A charge you log yourself
         is marked the moment it saves: log one (Budget, a category, Log),
         then __harness.taskMemory().tour.done holds its exp:<id>.
       Merch logged automatically, Houston: opening Log income for Houston
         clears it.
       Income not received yet, Houston guarantee and merch deposit: Handle
         now opens the Say which show sheet for the parked $2,000 guarantee
         (Guarantees to sort) and the parked $500 merch (Merch to sort), never
         Log income. Sort them (or take the parked rows off) and the cards
         go back to opening Log income.
       New on the guest list, Austin: only Jordan Price, never Alex Rivera
         (this phone put Alex on). Opening the guest list on Austin clears it.
       Reimbursements and Merch cash: Mark paid on Brent's or Tasha's ask
         offers Merch cash; one tap marks it paid AND writes its Handed off
         line, so the Merch cash card's amount drops by the same money. Not
         paid takes the line back off.
       HANDLE NOW ON A STANDING CARD (Ari, a request, a guarantee, the day
         off with no poll, Merch cash): swipe it right, back out without
         doing the job, open Tasks again: it is still there. Later still
         puts it at the back. A notice card (New expenses, guests, Merch
         logged automatically) still goes for good once handled.
     __harness.taskMemory() reads back this account's Tasks memory for the
     harness tour and for every tour (its done, later and held keys). */
  window.__harness.taskDeck = function () {
    var H = window.__harness, now = Date.now(), iso = function (ms) { return new Date(ms).toISOString(); };
    var day = function (n) { return ymd(new Date(today.getTime() + n * 864e5)); };
    var t = tours.t1;
    H.asks = (H.asks || []).filter(function (a) { return a.id !== 'ask-dallas'; }).concat([{ id: 'ask-dallas', tour_id: 't1', note_id: 'n-ask-dallas',
      show_id: 's0', place: 'Dallas', was: 900, fix: 1040, status: 'open', created_at: iso(now - 2 * 36e5) }]);
    H.notes = (H.notes || []).filter(function (n) { return n.id !== 'n-ask-dallas'; }).concat([{ id: 'n-ask-dallas', day: 'chat', author: 'Ari', at: now - 2 * 36e5,
      body: 'atVenu settlement for Dallas: says $1,040 merch, but $900 is already logged. I left it as is. Check which one is right.\n\nWould you like me to correct this to $1,040? Tap Yes and I\'ll fix it.' }]);
    H.requests = (H.requests || []).filter(function (r) { return !/^rq-tk-/.test(r.id); }).concat([
      { id: 'rq-tk-brent', tour_id: 't1', date: day(0), body: 'Two extra wristbands for the openers', author: 'Brent Allen', added_by: 'u-brent', status: 'pending', created_at: iso(now - 3 * 36e5) },
      { id: 'rq-tk-mine', tour_id: 't1', date: day(0), body: 'Hot tea in the green room', author: 'Devin Oliver', added_by: 'u-devin', status: 'pending', created_at: iso(now - 2 * 36e5) },
      { id: 'rq-tk-done', tour_id: 't1', date: day(0), body: 'Parking pass for the van', author: 'Brent Allen', added_by: 'u-brent', status: 'accepted', created_at: iso(now - 36e5) }]);
    t.charges['tk-mine'] = { id: 'tk-mine', date: day(0), merchant: 'Guitar Center', amount: 89.99, category: 'food', paid: true, by: 'Devin Oliver', createdAt: now - 36e5 };
    t.charges['tk-brent'] = { id: 'tk-brent', date: day(0), merchant: 'Whataburger', amount: 42.6, category: 'food', paid: false, by: 'Brent Allen', createdAt: now - 54e5 };
    var hou = t.shows.s00;
    hou.income = { guarantee: 2000, merch: 700 }; hou.merchCash = 200; hou.loggedAt = now - 5 * 36e5;
    hou.guaranteeReceived = false; hou.merchReceived = false;
    t.imports['em-' + hou.date + '-tk'] = { createdAt: now - 36e5, count: 1, total: 700, source: 'atVenu email' };
    t.otherIncome = Object.assign({}, t.otherIncome, { 'tk-ug': { date: day(-1), amount: 2000, kind: 'guarantee', unsorted: true, at: now } });
    t.merchToSort = Object.assign({}, t.merchToSort, { 'tk-ms': { date: day(-1), amount: 500, at: now } });
    H.guests = (H.guests || []).filter(function (g) { return !/^g-tk-/.test(g.id); }).concat([
      { id: 'g-tk-mine', tour_id: 't1', show_id: 's1', first_name: 'Alex', last_name: 'Rivera', affiliation: '', email: '', phone: '', qty: 1,
        pass_type: 'GA', added_by: 'u-devin', created_at: now - 30 * 6e4 },
      { id: 'g-tk-brent', tour_id: 't1', show_id: 's1', first_name: 'Jordan', last_name: 'Price', affiliation: 'Opener', email: '', phone: '', qty: 2,
        pass_type: 'VIP', added_by: 'u-brent', created_at: now - 20 * 6e4 }]);
    emit();
    return 'an open Ari ask on Dallas, three requests on Austin, two new charges, Houston owed with its money parked, ' +
      'an atVenu import on Houston and two new guests on Austin';
  };
  window.__harness.taskMemory = function () {
    var read = function (k) { return labels[k] ? JSON.parse(JSON.stringify(labels[k])) : null; };
    return { tour: read('seen-wn-t1'), everywhere: read('seen-wn-everywhere') };
  };
  // (After the rest of this file has seeded the guest list, which taskDeck adds to.)
  try { if (/[?&]taskdeck\b/.test(String(location.search || ''))) setTimeout(function () { window.__harness.taskDeck(); }, 0); } catch (e) { /* no address to read */ }
  /* ---- VENUE AND SHOW RATINGS (0154 + 0165): stars on a venue's page, and the band's word on a night ----
     A venue page shows its rating line ("8.3 from 3 ratings", or "No ratings
     yet") and a Rate this venue button once the card carries rating keys,
     which this fake backend always sends (see venueCard above). The band's
     Rate button sits on the CALENDAR's tonight row after doors (Devin,
     2026-10-16: "'rate' 'vote' 'requests'"; the show-day button reads
     Requests now) AND on every show row already played (Devin, later the
     same day: "I should be able to see 'rate' on all previous shows on the
     current tour" - the database lets the band rate any show of the tour,
     no date rule), for the tour's owner (this phone, u-devin) and the
     artist's Members. Since 2026-10-16 a rate-able row reads its buttons in
     ONE row, Day sheet then Rate then Requests (Devin: "The 'rate' button
     should be centered between day sheets and requests"); rows without Rate
     keep Day sheet and Requests with no hole. ONCE, FOR GOOD (Devin,
     2026-10-17: "Once you rate the show you can't rate again (obviously
     until next time you play)"; 0173): sent, the row reads Rated with a
     green check in Rate's place and nothing opens on a tap; the sheets
     say "You rate each show once." TO SEE THE PLAYED ROWS: Calendar > View
     previous dates - Dallas and Houston each carry Rate (plain, no switch
     needed); send one and only that row turns to Rated, each opening the
     wizard on its own city and venue. Or run __harness.rated() below. A tap
     opens the one-question wizard (0165): eleven screens at 375px, five
     stars with halves (LEFT half of a star is the half step, RIGHT the
     whole), word chips by star side, a 100-character note each, Yes/No for
     shower, laundry and accommodated, Next through to Done. Done writes one
     row: the review rides __harness.showStars (its review key) and
     __harness.rateCalls, with the THREE SCORES the review gives (crowd =
     the crowd stars, city = the area stars, venue = the mean of the
     venue-based questions; core's showReviewScores) mirrored into the old
     1-10 ints, stars times two - city fills now when the area was answered.
     THE ASK ON OPENING THE APP (Devin, 2026-10-16, evening: "I actually
     think the rating prompt should happen an hour after the bands set
     ends" - it anchored on bus call for a few hours before that): once an
     hour has passed since the band's own set ended by the most recent
     played show's day sheet (the set-times row naming the tour's "your
     band", or the only set row; small-hours ends belong to that night) and
     this account hasn't rated that show, opening the profile's Today tab
     or the tour's Overview brings up a small sheet - the city and venue,
     "How was the show?", Rate the show (the wizard) and Not now. A sheet
     with no readable set end for the band falls back to the OLD bus-call
     rule, so show nights without set times still ask. The phone remembers
     it asked (localStorage, per tour and show), so it never nags twice;
     __harness.ratePrompt() clears that mark.
       __harness.venue()    opens the way to a rated venue page: Mohawk
                            (Austin) becomes a page with three people's stars
                            on it, 9, 8 and 8 (8.3 from 3 ratings), and the
                            0168 review line under it ('4.2 from 12 reviews',
                            seeded in __harness.venueScores). Find it in
                            Search ("Mohawk"), under Venues; your own stars
                            land in __harness.venueStars['v-mohawk'] and move
                            the average on the page. Or open with ?venue.
                            delete __harness.venueScores['v-mohawk'] and
                            reopen: the card loses the 0168 keys and the page
                            must show NO review line (a build ahead of that
                            staged migration).
       __harness.rate()     tonight's Austin show reads as after doors (its
                            day sheet's doors time moves to half an hour ago),
                            merch is logged on it, two band rows land in
                            __harness.showStars, the venue history is
                            seeded with the band's stars (venueHistory()
                            below), and ratePrompt() below runs too, so one
                            address shows everything: the Calendar's tonight
                            row reads Day sheet / Rate / Requests in one row
                            (the wizard, every screen), the profile's
                            Today tab ends in the History section - dressed
                            like the day sheet's Notes since 2026-10-16, the
                            centred heading over the one card - with the
                            small stars line, and the Today tab or Overview
                            opens under the rate-the-show ask. Or open with
                            ?rate.
       __harness.ratePrompt()   the ask on opening the app, alone: tonight's
                            set times gain Opener Band (a fixed evening
                            set) and I See Stars, whose set end reads as 70
                            minutes ago - ten past the hour-after line, and
                            the tour's "your band" is set so the timing
                            reads the band's own row, never the opener's.
                            Before about 1:10 PM no PM time can sit 70
                            minutes back, so the band's end seeds as TBA
                            and the ask runs on the OLD bus-call fallback
                            (noon, read as hit from 11 AM), which is itself
                            a shipped rule; delete that show's
                            daySheet.setTimes and run this again to walk
                            the fallback at any hour. This phone's
                            asked-mark for tonight is cleared and its own
                            rating taken off. Then open the profile's Today
                            tab or the tour's Overview: the sheet rises
                            after the intro (and the countdown splash, when
                            one fires). Rate the show or Not now both mark
                            the phone asked; run ratePrompt() again to see
                            it again.
       __harness.rated()    this phone's own rating lands on Dallas (played)
                            and comes off Houston: Calendar > View previous
                            dates shows Dallas reading Rated with its check
                            (a tap does nothing) and Houston still Rate.
                            Tap Houston's Rate and send it: Houston turns to
                            Rated too. A second send of the same night
                            answers 'already-rated' here as the database
                            does (a duplicate refused): the app closes the
                            sheet with "You already rated this show" and no
                            error. To walk that, open Houston's wizard, then
                            in the console push u-devin's Houston row into
                            __harness.showStars by hand, and tap Done.
       __harness.ratingsLoading = true   the band's rows answer null, as while
                            they are still on their way: every Rate slot
                            stays EMPTY (a rated show never reads as one to
                            rate). Set it back to false and reopen the
                            Calendar to see Rate and Rated return.
       __harness.venueStars every venue's stars ({ venueId: { userId: stars } });
       __harness.showStars  every night's band rows, each with its review;
                            __harness.rateCalls what this phone wrote.
       __harness.ratingsOff = true   the probe answers as with no tables (a
                            build ahead of its migration): no rating line, no
                            buttons, no sheets, anywhere.
       __harness.reviewOff = true   the review column alone answers as before
                            0165: Rate opens the old three-slider sheet; set
                            it while the wizard is open and Done answers
                            'review-missing', so the old sheet appears. */
  window.__harness.venue = function () {
    var H = window.__harness;
    H.places = H.places || [];
    if (!H.places.some(function (p) { return p.kind === 'venue' && p.id === 'v-mohawk'; })) {
      H.places.push({ id: 'v-mohawk', kind: 'venue', name: 'Mohawk', city: 'Austin', cc: 'US' });
    }
    H.venueStars = H.venueStars || {};
    H.venueStars['v-mohawk'] = { 'u-amy': 9, 'u-ben': 8, 'u-cal': 8 };
    // The 0168 review keys, seeded so the quiet 'x.x from n reviews' line
    // shows under the rating line; delete this entry and reopen the page to
    // see the keys absent (the staged migration not applied: no line).
    H.venueScores = H.venueScores || {};
    H.venueScores['v-mohawk'] = { score: 4.2, count: 12 };
    return 'v-mohawk (Search for Mohawk, open it under Venues)';
  };
  /* The ask on opening the app (2026-10-16, reshaped the same night: the
     trigger is an hour after the band's own set ends, not bus call).
     Tonight's set times gain two rows, Opener Band with a fixed evening set
     and I See Stars (the tour's "your band", set here too) with a set end
     SEVENTY minutes ago when the clock can say so as a PM time - ten
     minutes past the hour-after line, so the ask reads as due right now,
     and off the opener's row, proving the band match. Before about 1:10 PM
     no PM value can sit 70 minutes back; the band's end is seeded as TBA
     then, and the ask falls back to the OLD bus-call rule, which this hook
     still feeds (noon, read as hit from 11 AM) - the fallback is a shipped
     rule, so the morning path tests it on purpose. Delete
     tours.t1.shows.s1.daySheet.setTimes by hand, run this again, and the
     evening path walks the same fallback. This phone's own rating on
     tonight comes off, and the asked-mark this phone keeps (localStorage,
     per tour and show) is cleared, so the ask rises again on the profile's
     Today tab or the tour's Overview. */
  window.__harness.ratePrompt = function () {
    var H = window.__harness;
    var end = new Date(Date.now() - 70 * 60e3);
    var setEnd = end.getHours() >= 12
      ? ((end.getHours() % 12 || 12) + ':' + ('0' + end.getMinutes()).slice(-2) + 'PM') : 'TBA';
    tours.t1.ourBand = 'I See Stars';
    tours.t1.shows.s1.daySheet.setTimes = [
      { band: 'Opener Band', time: '7:45PM', end: '8:15PM' },
      { band: 'I See Stars', time: '9:00PM', end: setEnd }];
    // The old anchor stays seeded: it is the shipped fallback for a sheet
    // with no readable set end for the band.
    var at = new Date(Date.now() - 30 * 60e3);
    tours.t1.shows.s1.daySheet.busCall = at.getHours() >= 13
      ? ((at.getHours() % 12 || 12) + ':' + ('0' + at.getMinutes()).slice(-2) + 'PM') : '12:00PM';
    H.showStars = (H.showStars || []).filter(function (r) { return !(r.tourId === 't1' && r.showId === 's1' && r.userId === 'u-devin'); });
    try { localStorage.removeItem('gr-rateask:t1:s1'); } catch (e) { /* the phone forgets on its own */ }
    emit();
    return 'I See Stars set end ' + setEnd + ' (70 minutes back), bus call ' + tours.t1.shows.s1.daySheet.busCall +
      ' as the fallback - open the profile Today tab or the tour Overview (before about 1:10 PM the set end seeds as TBA and the bus-call fallback carries the ask from 11 AM)';
  };
  window.__harness.rate = function () {
    var H = window.__harness;
    var at = new Date(Date.now() - 30 * 60e3);
    var hr = at.getHours() % 12 || 12, mm = ('0' + at.getMinutes()).slice(-2);
    tours.t1.shows.s1.daySheet.doors = hr + ':' + mm + (at.getHours() >= 12 ? 'PM' : 'AM');
    tours.t1.shows.s1.loggedAt = tours.t1.shows.s1.loggedAt || 1;
    tours.t1.shows.s1.income = Object.assign({}, tours.t1.shows.s1.income, { merch: 1400 });
    var now = new Date().toISOString();
    H.showStars = (H.showStars || []).filter(function (r) { return !(r.tourId === 't1' && r.showId === 's1' && r.userId !== 'u-devin'); });
    H.showStars.push({ tourId: 't1', showId: 's1', userId: 'u-amy', crowd: 8, venue: 7, city: 9, at: now },
      { tourId: 't1', showId: 's1', userId: 'u-ben', crowd: 6, venue: 7, city: null, at: now });
    // Tonight's room in the band's history too, stars and all, so one
    // address shows the wizard and the Today History section together; and
    // the ask on opening the app rides along (the band's set end 70 minutes
    // back, the asked-mark cleared), so Today and the Overview open under it.
    H.venueHistory();
    H.ratePrompt();
    emit();
    return 'doors ' + tours.t1.shows.s1.daySheet.doors + ', set end ' + (tours.t1.shows.s1.daySheet.setTimes[1] || {}).end +
      ', merch 1400 logged, two band rows, the rated history and the open-ask on tonight';
  };
  window.__harness.rated = function () {
    var H = window.__harness;
    H.ratingsLoading = false;
    H.showStars = (H.showStars || []).filter(function (r) { return !(r.tourId === 't1' && (r.showId === 's0' || r.showId === 's00') && r.userId === 'u-devin'); });
    H.showStars.push({ tourId: 't1', showId: 's0', userId: 'u-devin', crowd: 8, venue: 7, city: 8,
      review: { crowd: { stars: 4 }, venue: { stars: 3.5 }, area: { stars: 4 } }, at: new Date().toISOString() });
    emit();
    return 'Dallas rated by this phone, Houston not - Calendar > View previous dates';
  };
  try { if (/[?&]venue\b/.test(String(location.search || ''))) window.__harness.venue(); } catch (e) { /* no address to read */ }
  try { if (/[?&]rate\b/.test(String(location.search || ''))) window.__harness.rate(); } catch (e) { /* no address to read */ }
  /* ---- TONIGHT'S QUICK GUARANTEE, AND THE ONE MENU (2026-10-16) ----
     The Tonight card asks the guarantee with the SAME three numbers Log
     income keeps. To see it: open the profile's Today tab, tap Tasks, swipe
     the Today card right, and walk the questions to Log in Guarantees
     (?rate arms tonight's pieces: s1 is today with merch 1400 logged, so
     the guarantee question is still the open one). The card shows Guarantee
     Total, Deposit Amount and Taxes withheld, with the Received line
     following the tour's Received-boxes rule - manual: the tick; through
     card: the locked words 'Not received · ticks when the card shows it'.
     Log it saves through the one patch builder Log income's Save uses
     (incomePatchFor in src/app.js), so the same numbers on either door
     write the same show document key for key; a deposit short by MORE than
     the typed taxes says one quiet line instead and Log it opens Log income
     with the three numbers filled in (openIncome's carry).
     The three dots beside the three lines are gone from the tour band: the
     three-lines menu now holds one group headed by the current tour's name
     (the route's tour, else the profile's - here 'Harness run'), with the
     old Tour options rows in their old order, plus Sync atVenu (the way to
     Cards/Links, where its switch stays - one source of truth) and
     Received boxes (a second door to the sheet the Cards/Links row opens).
     Open the three lines from the tour or the profile and the group is
     there; sign in as ?crew and it is not (crew never had Tour options). */
  /* ---- THE GUEST LIST: rows beside the tour, as on the real backend ----
     Tonight's Austin show (s1) starts with three names in __harness.guests: one this phone put on
     (added_by u-devin), one Brent put on, and one old row with no added_by at all. Tap a name to
     edit or remove it. The fake saveGuest/removeGuest keep the database's line: a Manager phone
     (plain, or ?manager) may touch all three; with ?crew only your own row saves or comes off,
     the others answer { code: 'permission' } the way RLS does, and their rows don't open at all. */
  window.__harness.guests = [
    { id: 'g1', tour_id: 't1', show_id: 's1', first_name: 'Robin', last_name: 'Alvarez', affiliation: 'Label',
      email: '', phone: '', qty: 2, pass_type: 'VIP', added_by: 'u-devin', created_at: 1 },
    { id: 'g2', tour_id: 't1', show_id: 's1', first_name: 'Sam', last_name: 'Fields', affiliation: 'Press',
      email: 'sam@example.com', phone: '', qty: 1, pass_type: 'GA', added_by: 'u-brent', created_at: 2 },
    { id: 'g3', tour_id: 't1', show_id: 's1', first_name: 'Kim', last_name: 'Nolan', affiliation: '',
      email: '', phone: '555-0199', qty: 1, pass_type: 'All Access', added_by: null, created_at: 3 }];
  window.__harness.past = [{ email: 'brent@example.com', name: 'Brent Allen', phone: '555-0142', role: 'editor', tourRole: 'Tour manager' },
    { email: 'tasha@example.com', name: 'Tasha Lane', phone: '', role: 'viewer', tourRole: 'Production manager' },
    { email: 'ana@example.com', name: 'Ana Reyes', phone: '', role: 'viewer', tourRole: 'FOH engineer' }];
  window.__harness.pushSupported = true; window.__harness.pushOn = false; window.__harness.phones = 3;
  // What the app is told about the cards: the feed's row and the pile. feedFail (see the switches below):
  // the read failed, over the last pile; 'cold': it failed with nothing read before.
  window.__harness.feedState = function () {
    var H = window.__harness, F = H.feed;
    // (asManager: the cards are the tour creator's. This phone has no feed of its own; it is handed the pile.)
    if (H.asManager) return null;
    if (H.feedFail === 'cold') return { row: null, items: [], failed: true };
    var row = Object.assign({}, F.row);
    if (H.linesMissing) row.last_status = 'lines_missing';
    var st = { row: row, items: F.items.slice(), total: F.items.length };
    if (H.feedFail) st.failed = true;
    return st;
  };
  window.__harness.feedPush = function () { var st = window.__harness.feedState(); window.__harness.feedFns.forEach(function (fn) { fn(st); }); };
  /* ---- Every bank line accounted for (0136): the fake database's side ----
     The Cards tab's lines above the pile, the sheet "Left out and set aside",
     the Tasks card and the catch-up's ledger sentence, all in memory.

     TO SEE IT: in the console run  __harness.cardsOn()  (linked cards switched
     on, live mode, and this tour given card dates), or open the page with
     ?cardson, then open the tour's Budget, Cards/Links. The lines sit in one
     panel under Refresh Card: the last check with its dot, a red row for each
     thing that needs you, "Also waiting" rows, and the rest under Details
     (where "Left out and set aside" opens the sheet); the Tasks button
     carries "Bank lines". ?cardsall (or __harness.cardsAll()) shows every
     kind of row at once (see cardsAll below).
     After changing a switch below, run  __harness.feedPush()  to draw again.

     SWITCHES (all on window.__harness):
       cardsOn({ noDates: true })  as above but the tour keeps no card dates: the "no card dates yet" line
                            (Refresh Card then opens Card settings, as on a real tour without dates)
       oldFeed = true       STATE 1: the database change is live, the bank feed is still the older one. The
                            server leaves nothing out (only the "Before the tour" rows the migration relabelled),
                            no full check and no last good read are on record, a catch-up answer has no ledger,
                            a set-aside keeps no reason and no date, and a row from a taken-down tour is refused
       account = {...}      feedAccount answers exactly this (to try a field that is missing, or odd numbers)
       accountFail = true   STATE 3: feedAccount answers null: "Couldn't check the bank lines. Try again."
       feedFail = true      the read of the cards fails: "Couldn't check the cards." over the last pile read
       feedFail = 'cold'    the same with nothing read before: only that line, and never Add Card Info
       leftOutFail = true   the lists in the sheet (and "Needs a look") cannot be read
       putBackFail = true   Bring it in / Put back gets no answer;  putBackNone = true: it answers that nothing moved
       linesMissing = true  the bank feed could not store every line: the red line, and a catch-up that says so
       noCheck = true       no full check on record yet;  halfChecked = true: American Express not fully checked yet
       checkNew = [40, 1160]  what the last full check found that was not here before: [waiting, left out]
                            (3 waiting and none left out when it is not set)
       moreHistory = true   the first bank's read from the start ran out of pages: its entry says more: true, it has
                            no full read yet, and the check's ok is false (ok: false means that, or a full read
                            that came up short, linesMissing; a bank that did not answer is simply not in the check)
       offWas = [__harness.feed.accounts[1].name]  accounts, by name, that did not log expenses at the last full
                            check but do now
       asManager = true     this phone is a Manager with the tour role Tour Manager on a tour someone else created
                            (set it before the tour is opened, or open the page with ?manager): no feed of its own,
                            the pile comes from the creator's cards, and the pile's answer says how the creator's last
                            bank read ended (feedStatus; none with oldFeed). feed.row.last_status = 'failed' to try a
                            read that did not finish; bankDown() for a bank that needs a sign-in
       noFeed = true        Linked Cards is told there is no feed at all, and that this account may connect a bank;
                            notAllowed = true: no feed, and it may not (no Connect button)
       look = true          rows for "Needs a look": one the bank took back, one whose amount changed, one filed on no
                            tour, and a set-aside line the bank took back (listed, with no Put back)
       manyLeftOut = 230    that many extra card payments left out (pages of 100, "Show more")
       elsewhere()          adds a second tour and an Off Tour book with rows waiting on each ("Also waiting")
       goneTour()           adds a taken-down tour with two rows still waiting on it (they show in this pile for the
                            cards' owner; a Manager who is not the owner is not handed them)
       bankDown(code)       American Express gets that trouble ('ITEM_LOGIN_REQUIRED' when no code is given, e.g.
                            'INSTITUTION_DOWN', 'ITEM_NOT_FOUND');  bankDown(false)  makes every bank healthy
       out                  the rows themselves that are not in the pile (left out, set aside): change or add to
                            them to try any shape; set it to null to have them made afresh
     Banks: American Express starts out needing a new sign-in, as in Linked Cards, so its red line and the Tasks
     card show from the start;  __harness.bankDown(false)  clears it.
     An account set to Neither or Income (Linked Cards, or __harness.feed.accounts[2].mode = 'off') gets the
     "does not log expenses: 37 lines were not read" line.
     Kept for a test to read: accountCalls (how many times the account was asked for), putBacks (the ids asked
     back), filedPicks and calls (every card call with its body: by and each pick's reason are there).
     The sorting sheet's saves can be made slow or made to fail: fileSlow and fileFail (or ?fileslow=1500,
     ?filefail=offline), described where the fake files a charge (THE SORTING SHEET'S SAVES, further down). */
  var daysAgo = function (n) { return ymd(new Date(today.getTime() - n * 864e5)); };
  var stampAgo = function (n) { return new Date(Date.now() - n * 864e5).toISOString(); };
  // The rows that are not in the pile: left out by the server, set aside by a tap, or (look) marked filed.
  function outRows() {
    var H = window.__harness, old = !!H.oldFeed;
    // (Built once, and again when a switch that shapes them is changed.)
    var sig = [old, !!H.look, H.manyLeftOut > 0 ? H.manyLeftOut : 0].join('|');
    if (!H.out || H.outFor !== sig) {
      H.outFor = sig;
      // (Each line carries one of the feed's own accounts, listed with the feed above: a card and two bank accounts.)
      var acctName = function (i) { return H.feed.accounts[i].name; };
      var gold = acctName(3), merch = acctName(1), adv = acctName(2);
      var lo = function (id, reason, why, days, merchant, amount, account, more) {
        return Object.assign({ id: id, tour_id: null, date: daysAgo(days), posted: daysAgo(days), merchant: merchant, amount: amount, account: account,
          why: why, status: 'left_out', reason: reason, decided_at: null, bank_amount: null, gone_on: null }, more || {});
      };
      var aside = function (id, reason, days, merchant, amount, account, why, decided) {
        return { id: id, tour_id: 't1', date: daysAgo(days), posted: daysAgo(days), merchant: merchant, amount: amount, account: account, why: why || '',
          status: 'skipped', reason: old ? null : reason, decided_at: old || decided == null ? null : stampAgo(decided), bank_amount: null, gone_on: null };
      };
      H.out = old ? [
        // (All the older bank feed ever kept out of sight: its own "Before the tour" rows, relabelled by the migration.)
        lo('lo-bt1', 'before_tour', 'Before the tour', 25, 'Sweetwater Sound', 320, gold, { tour_id: 't1' })
      ] : [
        lo('lo-cp1', 'card_payment', 'Card payment', 6, 'AMEX EPAYMENT ACH PMT', 1500, merch),
        lo('lo-cp2', 'card_payment', 'Card payment', 6, 'Payment Thank You - Web', -1500, gold),
        lo('lo-cp3', 'card_payment', 'Card payment', 34, 'BANK OF AMERICA CREDIT CARD Bill Payment', 2750.5, adv),
        lo('lo-om1', 'own_move', 'Moved to savings or investments', 12, 'Online Transfer to SAV 0000', 2000, adv),
        lo('lo-od1', 'outside_dates', 'Not during a tour', 61, 'Shell Oil 5744', 48.1, gold),
        lo('lo-od2', 'outside_dates', 'Not during a tour', 58, 'Zelle payment to Ana Reyes', 300, merch),
        lo('lo-bt1', 'before_tour', 'Before the tour', 25, 'Sweetwater Sound', 320, gold, { tour_id: 't1' }),
        lo('lo-z1', 'zero', 'Zero amount', 9, 'Card verification', 0, gold),
        lo('lo-br1', 'bank_removed', 'Taken back by the bank', 4, 'Uber *Trip', 23.4, gold, { tour_id: 't1', gone_on: daysAgo(1) })
      ];
      H.out = H.out.concat([
        aside('sk-1', 'set_aside', 5, 'Netflix.com', 15.49, gold, 'New merchant', 1),
        aside('sk-2', 'same_as_typed', 7, 'Zelle payment to Tasha Lane', 250, merch, 'Zelle', 2),
        // Set aside by an older build, by itself: no reason and no date were ever kept.
        aside('sk-3', null, 16, 'Hotel Indigo', 189, gold, 'Maybe already in', null)
      ]);
      for (var k = 0; k < (H.manyLeftOut > 0 ? H.manyLeftOut : 0); k++) {
        H.out.push(lo('lo-many' + k, 'card_payment', 'Card payment', 40 + k, 'Payment Thank You ' + (k + 1), 100 + k, gold));
      }
      // (The first two are on the tour as charges, like any filed line; the third is on no tour.)
      if (H.look && !tours.t1.charges['plk-gone']) {
        tours.t1.charges['plk-gone'] = { id: 'plk-gone', date: daysAgo(8), merchant: 'Lyft *Ride', amount: 31.2, category: 'food', account: gold, importId: 'review-look', paid: false };
        tours.t1.charges['plk-chg'] = { id: 'plk-chg', date: daysAgo(10), merchant: 'Chevron 0092', amount: 50, category: 'gas', account: gold, importId: 'review-look', paid: false };
        tours.t1.imports = Object.assign({}, tours.t1.imports, { 'review-look': { createdAt: Date.now() - 9 * 864e5, count: 2, total: 81.2, source: 'Card feed' } });
        setTimeout(emit, 0);
      }
      if (H.look) H.out = H.out.concat([
        { id: 'lk-gone', tour_id: 't1', date: daysAgo(8), posted: daysAgo(8), merchant: 'Lyft *Ride', amount: 31.2, account: gold, why: '', status: 'filed',
          reason: null, decided_at: stampAgo(7), bank_amount: null, gone_on: daysAgo(2) },
        { id: 'lk-chg', tour_id: 't1', date: daysAgo(10), posted: daysAgo(10), merchant: 'Chevron 0092', amount: 50, account: gold, why: '', status: 'filed',
          reason: null, decided_at: stampAgo(9), bank_amount: 52.1, gone_on: null },
        // Marked filed, but no tour has a charge "plk-none".
        { id: 'lk-none', tour_id: 't1', date: daysAgo(11), posted: daysAgo(11), merchant: 'Guitar Center #214', amount: 412.88, account: gold, why: '', status: 'filed',
          reason: null, decided_at: stampAgo(10), bank_amount: null, gone_on: null },
        // Set aside by a tap, and then taken back by the bank: listed, and never put back.
        { id: 'lk-sgone', tour_id: 't1', date: daysAgo(9), posted: daysAgo(9), merchant: 'Parking Meter 0417', amount: 6.5, account: gold, why: 'New merchant', status: 'skipped',
          reason: 'set_aside', decided_at: stampAgo(8), bank_amount: null, gone_on: daysAgo(3) }
      ]);
    }
    return H.out;
  }
  // Does any tour hold this bank line as a charge? (A taken-down tour still counts.)
  function tourHolds(fid) {
    return Object.keys(tours).some(function (tid) { var c = (tours[tid].charges || {})['p' + fid]; return !!c && typeof c === 'object'; });
  }
  function tourGone(tid) { return !!tid && (!tours[tid] || !!tours[tid].deletedAt); }
  // What feed_account answers, counted from what the fake holds.
  function fakeAccount() {
    var H = window.__harness, F = H.feed, out = outRows(), old = !!H.oldFeed, noCheck = old || !!H.noCheck;
    var by = { waiting: F.items.length, filed: Object.keys(H.filedItems || {}).length, left_out: 0, skipped: 0, mypay: 0 };
    out.forEach(function (r) { by[r.status] = (by[r.status] || 0) + 1; });
    var wb = {}, where = [];
    F.items.forEach(function (it) {
      var t = it.tour_id ? tours[it.tour_id] : null;
      var kind = !it.tour_id ? 'none' : tourGone(it.tour_id) ? 'gone' : t.kind === 'offtour' ? 'offtour' : 'tour';
      var key = kind + ':' + (it.tour_id || '');
      if (!wb[key]) { wb[key] = { tour_id: it.tour_id || null, name: t ? String(t.name || '') : '', kind: kind, n: 0 }; where.push(wb[key]); }
      wb[key].n += 1;
    });
    var lo = {}, left = [];
    out.forEach(function (r) {
      if (r.status !== 'left_out') return;
      var g = lo[r.reason];
      if (!g) { g = lo[r.reason] = { reason: r.reason, n: 0, sum: 0, first_day: r.date, last_day: r.date }; left.push(g); }
      // (A reason's total is its lines with the signs taken off: a payment out and the same payment arriving do not cancel.)
      g.n += 1; g.sum = Math.round((g.sum + Math.abs(r.amount)) * 100) / 100;
      if (r.date < g.first_day) g.first_day = r.date;
      if (r.date > g.last_day) g.last_day = r.date;
    });
    var aside = out.filter(function (r) { return r.status === 'skipped'; });
    var total = by.waiting + by.filed + by.left_out + by.skipped + by.mypay;
    // The last full check, as the database answers it: each bank's latest read from the start that was carried
    // through, added up. A bank that did not answer is simply not in it. ok is false only when one of those
    // reads ran out of pages (moreHistory), and that bank's own entry then says more: true, or when one came
    // up short of what the bank sent (linesMissing, which also counts the lines as unexplained).
    var more = !!H.moreHistory && !noCheck;
    var fresh = Array.isArray(H.checkNew) ? H.checkNew : [3, 0];
    return {
      total: total, by_status: by, waiting_by_tour: where, left_out: left,
      set_aside: { n: aside.length, sum: Math.round(aside.reduce(function (n, r) { return n + r.amount; }, 0) * 100) / 100 },
      look: { no_tour: out.filter(function (r) { return r.status === 'filed' && !tourHolds(r.id); }).length,
        bank_gone: out.filter(function (r) { return r.gone_on && r.status !== 'left_out'; }).length,
        bank_changed: out.filter(function (r) { return r.bank_amount != null && Math.round(r.bank_amount * 100) !== Math.round(r.amount * 100); }).length },
      banks: F.banks.map(function (b) {
        var ok = !b.status || b.status === 'ok';
        return { institution: b.name, status: b.status || 'ok', linked: daysAgo(40),
          // (The older bank feed never notes a good read. A bank in trouble was last read 8 days ago.)
          last_ok: old ? null : stampAgo(ok ? 0.05 : 8),
          full_read: noCheck || !ok || (H.halfChecked && b.id === 'b2') || (more && b.id === 'b1') ? null : stampAgo(2),
          more: more && b.id === 'b1' };
      }),
      check: noCheck ? null : { at: stampAgo(2), bank_sent: Math.max(total, 412), found: fresh[0] + fresh[1], new_waiting: fresh[0], new_filed: 0,
        new_left_out: fresh[1], unexplained: H.linesMissing ? 2 : 0, ok: !more && !H.linesMissing },
      not_kept: noCheck ? { off: [], money_in: 0 } : {
        off: F.accounts.filter(function (a) { return a.mode === 'off'; }).map(function (a) { return { account: a.name, n: 37 }; })
          .concat((H.offWas || []).map(function (nm) { return { account: nm, n: 12 }; })),
        money_in: 21 }
    };
  }
  // How the last read of the banks ended, as the bank feed keeps it on the feed's row: its own word, or the
  // code of a bank that is in trouble.
  function lastStatusNow() {
    var H = window.__harness, F = H.feed;
    if (H.linesMissing) return 'lines_missing';
    if (F.row.last_status && F.row.last_status !== 'ok') return F.row.last_status;
    var down = F.banks.filter(function (b) { return b.status && b.status !== 'ok'; })[0];
    return down ? down.status : 'ok';
  }
  // asManager: the crew list of a tour someone else created, on which this phone (the harness's own account,
  // first in the list) is a Manager with the tour role Tour Manager.
  function crewAsManager() {
    var H = window.__harness;
    return [{ owner: true, role: 'owner', userId: 'u-creator', name: 'Tour Creator', email: 'creator@example.com', phone: '', tourRole: 'Artist', joined: true },
      Object.assign({}, H.crew[0], { owner: false, role: 'editor', manager: true, tourRole: 'Tour Manager' })].concat(H.crew.slice(1));
  }
  window.__harness.bankDown = function (code) {
    var H = window.__harness;
    H.feed.banks.forEach(function (b, i) { b.status = code === false ? 'ok' : i === 1 ? (typeof code === 'string' ? code : 'ITEM_LOGIN_REQUIRED') : b.status; });
    H.feedPush();
  };
  /* cardsOn: the one call that makes the Cards tab live in the harness. */
  window.__harness.cardsOn = function (o) {
    var H = window.__harness, F = H.feed;
    F.row.switched_on = true; F.row.since = daysAgo(30); F.row.last_run = stampAgo(0.01); F.live = true;
    F.accounts.forEach(function (a) { a.asked = true; });
    tours.t1.cardLog = o && o.noDates ? null : { from: 'tour', to: 'tour' };
    emit(); H.feedPush();
  };
  window.__harness.elsewhere = function () {
    var H = window.__harness, F = H.feed;
    tours.t2 = { name: 'Taste Of Chaos', artist: tours.t1.artist, setupDone: true, setupStep: 5, createdAt: 2, expenses: {}, commission: {}, charges: {}, imports: {},
      cardLog: { from: 'tour', to: 'tour' }, shows: { a1: { id: 'a1', date: daysAgo(-30), city: 'Denver, CO', venue: 'Summit' } } };
    tours.off1 = { kind: 'offtour', artist: tours.t1.artist, name: 'Off Tour', setupDone: true, offFrom: daysAgo(90).slice(0, 8) + '01', createdAt: 3, shows: {}, expenses: {}, charges: {} };
    F.items = F.items.concat([
      { id: 'e1', tour_id: 't2', date: daysAgo(2), merchant: 'Sweetwater Sound', amount: 219, category: null, account: F.accounts[3].name, why: 'New merchant' },
      { id: 'e2', tour_id: 't2', date: daysAgo(3), merchant: 'Penske Truck Rental', amount: 640.2, category: null, account: F.accounts[3].name, why: 'New merchant' },
      { id: 'e3', tour_id: 'off1', date: daysAgo(5), merchant: 'Adobe Creative Cloud', amount: 59.99, category: null, account: F.accounts[3].name, why: 'New merchant' }
    ]);
    emit(); H.feedPush();
  };
  /* WHO A CREW LINE PAID, and the category asked by itself (src/app.js hintWho, askLineCats).
       payLines()       adds three bank lines on Business Adv Relationship – 5370, the way his real pay lines read:
                        "Online transfer to CHK 2264 ; Mora" (Jeff Mora's last name: opens under Crew with Jeff
                        picked, both marked Suggested), "Online transfer to CHK 2264" (no name: suggested only once
                        the 2264 has been learned, by adding the first under Crew for Jeff and opening the card
                        again, or by whoSeed() before it is opened), and
                        "Zelle payment to Sam Okafor" (nobody by that name: the place to try + Add someone new).
                        Or open the page with ?paylines.
       whoSeed()        writes the memory as if the first line had been added for Jeff (account 2264, the word mora).
       whoMemory()      the memory as it is now (labels 'who:i-see-stars').
       learn(name, key) a merchant learned under a category, as filing one teaches it: learn('Shell', 'gas'), then the
                        merch cash log's Spent form suggests Gas when Shell is typed in Expense details.
       tourDoc(id)      a copy of a tour as the fake database holds it (a helper's row, a charge's crewId).
       catForget()      forgets every category asked about on this browser (and the day's count), so the next sheet
                        asks again and the Suggested marks are seen arriving.
     A helper added from a picker sits in tours.t1.crew with helper: true; __harness.tourDoc('t1') shows it. */
  window.__harness.payLines = function () {
    var H = window.__harness, F = H.feed, acct = F.accounts[2].name;
    if (F.items.some(function (x) { return x.id === 'pl1'; })) return;
    F.items = F.items.concat([
      { id: 'pl1', tour_id: 't1', date: daysAgo(1), merchant: 'Online transfer to CHK 2264 ; Mora', amount: 750, category: null, account: acct, why: 'Transfer' },
      { id: 'pl2', tour_id: 't1', date: daysAgo(2), merchant: 'Online transfer to CHK 2264', amount: 650, category: null, account: acct, why: 'Transfer' },
      { id: 'pl3', tour_id: 't1', date: daysAgo(2), merchant: 'Zelle payment to Sam Okafor', amount: 300, category: null, account: acct, why: 'Zelle' }
    ]);
    emit(); H.feedPush();
  };
  window.__harness.whoSeed = function () {
    var now = Date.now(), jeff = { who: 'jeff mora', name: 'Jeff Mora', id: 'jm', n: 1, off: 0, at: now };
    labels['who:i-see-stars'] = { kind: 'crewClues', artist: 'I See Stars',
      clues: { 'd:2264': Object.assign({}, jeff), 'w:mora': Object.assign({}, jeff) } };
    setTimeout(emitLabels, 0);
  };
  window.__harness.learn = function (merchant, category) {
    var key = window.GRS.normMerchant(merchant), had = labels[key] || { merchant: merchant, cats: {} };
    had.cats[category] = (had.cats[category] || 0) + 1; labels[key] = had;
    setTimeout(emitLabels, 0);
  };
  window.__harness.whoMemory = function () { return labels['who:i-see-stars'] ? JSON.parse(JSON.stringify(labels['who:i-see-stars'])) : null; };
  window.__harness.tourDoc = function (id) { return tours[id] ? JSON.parse(JSON.stringify(tours[id])) : null; };
  window.__harness.catForget = function () {
    try { localStorage.removeItem('gr-ci-cat'); localStorage.removeItem('gr-ci-cat-day'); } catch (e) { /* nothing kept */ }
  };
  try { if (/[?&]paylines\b/.test(String(location.search || ''))) setTimeout(function () { window.__harness.payLines(); }, 0); } catch (e) { /* no address to read */ }
  window.__harness.goneTour = function () {
    var H = window.__harness, F = H.feed;
    tours.t9 = { name: 'Cancelled run', artist: tours.t1.artist, setupDone: true, createdAt: 4, deletedAt: Date.now() - 864e5, expenses: {}, charges: {}, shows: {} };
    F.items = F.items.concat([
      { id: 'gt1', tour_id: 't9', date: daysAgo(6), merchant: 'Love’s Travel Stop', amount: 88.4, category: null, account: F.accounts[3].name, why: 'New merchant' },
      // (A tour that is not there at all, not even in Deleted tours.)
      { id: 'gt2', tour_id: 'nowhere', date: daysAgo(6), merchant: 'FedEx Office', amount: 41.07, category: null, account: F.accounts[3].name, why: 'New merchant' }
    ]);
    emit(); H.feedPush();
  };
  /* cardsAll: the Cards tab's panel with every kind of row. Red: American Express needs a sign-in (Linked
     Cards). Rows: lines also waiting on a second tour and on an Off Tour book. Under Details: the last full
     check, Left out and set aside, Bank of America with more history than one read takes, Business Adv
     Relationship not logging expenses (Change), the charges from a taken-down tour, Catch up on missed
     payments. Then  __harness.accountFail = true; __harness.feedPush()  for "Couldn't check the bank lines". */
  window.__harness.cardsAll = function () {
    var H = window.__harness;
    H.moreHistory = true;
    H.feed.accounts[2].mode = 'off';
    H.cardsOn(); H.elsewhere(); H.goneTour();
  };
  try {
    if (/[?&]cardsall\b/.test(String(location.search || ''))) setTimeout(function () { window.__harness.cardsAll(); }, 0);
    else if (/[?&]cardson\b/.test(String(location.search || ''))) setTimeout(function () { window.__harness.cardsOn(); }, 0);
  } catch (e) { /* no address to read */ }
  /* The gate's own screens, as site/backend.js has them (lifted in by this
     script, not copied): the role list and its picker, the one-question
     screens, the pages for the documents and the markdown they are written
     in. The few names that stretch leans on from the rest of backend.js are
     stood in for here; nothing in the harness reaches a server. */
  var shared = (function () {
    'use strict';
    function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
    function err(code) { var e = new Error(code); e.code = code; return e; }
    function fnMissing() { return false; }
    function yearsOld(y, m, d) {
      var now = new Date(), n = now.getUTCFullYear() - y;
      if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) n -= 1;
      return n;
    }
    var cfg = {}, sbMod = null;
  /*SHARED-SCREENS*/
    return { tourRoles: tourRoles, openRolePicker: openRolePicker, sgStyle: sgStyle, mdNodes: mdNodes,
      legalRun: legalRun, legalPages: legalPages, LEGAL_NAMES: LEGAL_NAMES, LEGAL_SAID: LEGAL_SAID,
      used: [err, fnMissing, yearsOld, cfg, sbMod] };
  })();
  /* THE DOCUMENTS (0137), in memory: three short invented documents (the real
     ones are in no file of this project), the gate that asks for them, and
     the Settings row.
     TO SEE THE GATE (the three pages over everything, as at a real start-up):
       open the page with  ?legal            someone already in who never agreed
                           ?legal=privacy    a version changed: "Updated: Privacy Policy" over page one
                                             (several: ?legal=terms,privacy)
       The app is handed nothing until "I Agree" has saved. Or, at any time, in the console:
         __harness.legal = { needs: true, changed: ['privacy'] };  __harness.legalGate()
       (legalGate() resolves 'agreed', 'none' or 'unread'; what it asked is in __harness.legalCalls.)
     TO SEE THE SETTINGS ROW: the three lines, Settings. "Documents you agreed to" sits last, with
       "You accepted on <date>" under it; it opens the three documents to read again.
     SWITCHES (all inside __harness.legal; set them, then open Settings or call legalGate() again):
       needs: true          this account has yet to agree to the current documents
       changed: ['terms']   which changed since it last agreed
       acceptedAt: null     it has never agreed (the Settings row is hidden); else an ISO time
       ready: false         no documents are loaded: the gate asks nothing, the row is hidden
       versions: { nda: '1.0', terms: '0.9', privacy: '1.0' }   what it agreed to (Settings says when one is older)
       docsFail: true       the documents cannot be loaded (gate: carries on unless must; Settings: says so)
       docsFail: 'offline'  loading them gets no answer at all: with must, the screen says the ordinary
                            "Couldn't reach the server" line, not a sentence about documents
       must: true           someone new or invited: the gate waits with "Try again" when the documents cannot
                            be loaded, and is never let on with an agreement that could not be sent
       acceptFail: true     saving the acceptance fails: "I Agree" says so and nobody gets past
       acceptWhy: 'email'   saving is refused for that reason: "Confirm your email first: use the code we emailed you."
       acceptLost: true     saving gets NO ANSWER (the signal dropped while they read). Someone already in
                            (no must) is let on: legalGate() resolves 'held', and what they agreed to is in
                            __harness.legalHeld until it is sent. With must they stay on the page
       stale: true          the Terms change while they are read: once, then version 1.1 is shown
       again: true          the pages are back because an agreement could not be saved: said over the first title
       blind: true          nobody knows yet whether documents are loaded: the waiting screen does not speak of them
       statusFail: true     where the account stands cannot be read (the row stays hidden; no "Updated" line)
     "Sign out" sits under the button of every page and of the "Try again" screen (people signed in only). Here
     it signs nobody out: it sets __harness.legalSignedOut and takes the pages down.
     WHO HAS AGREED (0139), a Greenroom admin's list: the three lines, Settings, "Who has agreed" (directly
       under "Invite codes"). Every person in it is invented. It opens the list: the first line ("6 people have
       agreed. 4 have not yet."), a search box (there are more than 10 people), "Not yet agreed", then "Agreed";
       a tap on someone who agreed opens the whole record, with "Copy this record".
       What the page is handed is __harness.legalList = { agreed: [...], waiting: [...] } (filled with the
       invented people the first time it is asked for). Two things are worked out on the way, as the server
       does: "current" (the documents' own versions, top level and on each agreed row that does not say), and,
       while no documents are loaded (__harness.legal = { ready: false }), nobody waiting and current null.
       __harness.admin = false          not an admin: the answer is null and there is no row (Invite codes too)
       __harness.legalList = null       the same for this row alone
       __harness.legalListFail = true   the call fails, which the real B.legalList also answers with null. Set
                                        before Settings is opened: no row. Set with Settings already open,
                                        then tap the row: "Couldn't load the list. Close and try again."
       __harness.legalList = { agreed: [], waiting: [] }   "Nobody has agreed yet."
       __harness.legalListMany = 250    that many more invented people who agreed: the "Show all" link, and
                                        a search through a long list
       __harness.legalList.agreed.length = 4; __harness.legalList.waiting.length = 2   10 people or fewer:
                                        no search box
       How often it was asked is counted in __harness.legalListCalls. The app keeps the yes or no behind the
       row for a minute, so load the page again after changing whether there is a list. */
  var LEGAL_DOCS = [
    { doc: 'nda', title: 'Harness Non-Disclosure Agreement', version: '1.0', body:
      '# Harness Non-Disclosure Agreement\n\n**Version 1.0.** An invented stand-in. It is not a real agreement.\n\n## What stays in the room\n\n' +
      'What you see in the harness is not finished.  \nThis line follows two spaces, so it starts on a new line.\n\n' +
      '- Do not post **screenshots**.\n- Do tell whoever invited you what broke.\n\n### A smaller heading\n\n' +
      'This must show exactly as typed and run nothing: <img src=x onerror="window.__harness.ran = true"> <b>not bold</b>\n\n' +
      'A last paragraph, long enough to wrap on a phone, so there is something to scroll through before the button at the foot of the page.' },
    { doc: 'terms', title: 'Harness Terms of Use', version: '1.0', body:
      '# Harness Terms of Use\n\nThese are **pretend terms**.\n\n## Who may use it\n\n- People who are 18 or older.\n- People holding a code.\n\n## What it is for\n\nTrying the screens.' },
    { doc: 'privacy', title: 'Harness Privacy Policy', version: '1.0', body:
      'This one does not repeat its title.\n\n## What is recorded when you agree\n\n- Who you are.\n- The **versions** you agreed to.\n- When, and from which address.' }
  ];
  function legalNow() {
    var H = window.__harness, L = H.legal || (H.legal = {}), cur = {};
    LEGAL_DOCS.forEach(function (d) { cur[d.doc] = d.version; });
    var ready = L.ready !== false, changed = Array.isArray(L.changed) ? L.changed : [];
    // (Unless told otherwise the account agreed twenty days ago, to the versions before any that "changed".)
    var at = L.acceptedAt === undefined ? new Date(Date.now() - 20 * 864e5).toISOString() : L.acceptedAt;
    var had = L.versions || (at ? { nda: cur.nda, terms: cur.terms, privacy: cur.privacy } : null);
    if (had && !L.versions) changed.forEach(function (k) { if (had[k]) had[k] = '0.9'; });
    return { L: L, cur: cur, ready: ready, at: at || null, had: had, changed: ready ? changed : [], needs: ready && !!L.needs };
  }
  var legalApi = {
    docs: function () {
      var H = window.__harness, n = legalNow();
      (H.legalCalls = H.legalCalls || []).push({ fn: 'legal_docs_for', args: [] });
      // (true: the server answered with an error. 'offline': no answer at all.)
      if (n.L.docsFail) return Promise.reject(n.L.docsFail === 'offline' ? Object.assign(new Error('offline'), { code: 'offline' })
        : Object.assign(new Error('unavailable'), { code: 'unavailable' }));
      return Promise.resolve(n.ready ? { ok: true, ready: true, docs: JSON.parse(JSON.stringify(LEGAL_DOCS)) } : { ok: true, ready: false, docs: [] });
    },
    status: function () {
      var H = window.__harness, n = legalNow();
      (H.legalCalls = H.legalCalls || []).push({ fn: 'legal_status', args: [] });
      if (n.L.statusFail) return Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
      return Promise.resolve({ ready: n.ready, needs: n.needs, accepted_at: n.at, versions: n.had, current: n.ready ? n.cur : null, changed: n.changed });
    },
    accept: function (v, said, via) {
      var H = window.__harness, n = legalNow();
      (H.legalCalls = H.legalCalls || []).push({ fn: 'legal_accept', args: [v, said, via] });
      // (No answer at all is thrown, as site/backend.js's own legalApi.accept does; a refusal is an answer.)
      if (n.L.acceptLost) return Promise.reject(Object.assign(new Error('offline'), { code: 'offline' }));
      if (n.L.acceptFail) return Promise.resolve({ ok: false, why: 'failed' });
      if (n.L.acceptWhy) return Promise.resolve({ ok: false, why: String(n.L.acceptWhy) });
      if (n.L.stale) {
        n.L.stale = false;
        LEGAL_DOCS[1].version = '1.1'; LEGAL_DOCS[1].body += '\n\n**New in version 1.1:** this paragraph arrived while you were reading.';
        return Promise.resolve({ ok: false, why: 'stale' });
      }
      if (!n.ready) return Promise.resolve({ ok: false, why: 'not ready' });
      if (!v || v.nda !== n.cur.nda || v.terms !== n.cur.terms || v.privacy !== n.cur.privacy) return Promise.resolve({ ok: false, why: 'stale' });
      n.L.needs = false; n.L.changed = []; n.L.acceptedAt = new Date().toISOString(); n.L.versions = n.cur;
      return Promise.resolve({ ok: true, at: n.L.acceptedAt, versions: n.cur });
    }
  };
  // The inside gate, as site/backend.js draws it (legalInside): over everything, under the overlay's own name.
  window.__harness.legalGate = function () {
    var H = window.__harness, L = H.legal || (H.legal = {});
    if (document.getElementById('gr-pass-gate')) return Promise.resolve('busy');
    var wrap = document.createElement('div');
    wrap.id = 'gr-pass-gate'; wrap.className = 'gr-gate-like';
    document.body.appendChild(wrap);
    return shared.legalRun(wrap, { api: legalApi, via: 'inside', must: !!L.must, again: !!L.again, blind: !!L.blind,
      signOut: function () { H.legalSignedOut = true; wrap.remove(); },
      // As site/backend.js has it: only someone who was already in is let on with an agreement still to be sent.
      hold: L.must ? null : function (v, said) { H.legalHeld = { v: v, said: said, via: 'inside' }; return true; }
    }).then(function (how) {
      wrap.remove(); H.legalHow = how;
      return how;
    });
  };
  (function () {
    var m = /[?&]legal(?:=([a-z,]*))?(?:&|$)/.exec(String(location.search || ''));
    if (!m) { gateDone(); return; }
    var changed = String(m[1] || '').split(',').filter(function (k) { return k === 'nda' || k === 'terms' || k === 'privacy'; });
    window.__harness.legal = changed.length ? { needs: true, changed: changed } : { needs: true, acceptedAt: null };
    // (Whatever goes wrong with the gate itself, the harness still starts: it is the gate that is being tried.)
    try { window.__harness.legalGate().then(gateDone, gateDone); } catch (e) { gateDone(); throw e; }
  })();
  window.GR_BACKEND = {
    // (The crew roles, from the lifted stretch of backend.js: GR.CREW_ROLES once core.js has loaded.)
    tourRoles: shared.tourRoles(),
    legal: function () {
      return legalApi.status().then(function (d) {
        return { ready: d.ready === true, needs: d.needs === true, acceptedAt: d.accepted_at || null, versions: d.versions || null,
          current: d.current || null, changed: (d.changed || []).slice() };
      }, function () { return null; });
    },
    legalDocs: function () {
      return legalApi.docs().then(function (d) {
        return (d.docs || []).map(function (x) {
          return { doc: x.doc, name: shared.LEGAL_NAMES[x.doc], title: x.title, version: x.version, body: x.body, publishedAt: null };
        });
      }, function () { return null; });
    },
    legalBody: function (text, title) { shared.sgStyle(); return shared.mdNodes(text, title); },
    email: function () { return 'devin@example.com'; },
    uid: function () { return 'u-devin'; },
    // Flowers, in memory. Devin (you), Brent and Jeff are on the tour; Brent
    // gave you two after Dallas, and two artist pages list Brent as crew.
    flowersFor: function (tourId) {
      var H = window.__harness, me = 'u-devin';
      H.flowers = H.flowers || [{ id: 'f1', tour: 't1', from: 'u-brent', to: 'u-devin', n: 2, note: 'Killer set in Dallas', category: 'talent', at: new Date(Date.now() - 2 * 864e5).toISOString() },
        { id: 'f2', tour: 't1', from: 'u-jeff', to: 'u-brent', n: 3, note: 'Loaded the trailer solo', category: 'hustle', at: new Date(Date.now() - 864e5).toISOString() }];
      var sum = function (f) { return H.flowers.filter(f).reduce(function (a, x) { return a + x.n; }, 0); };
      var people = [
        { userId: 'u-devin', owner: true, name: 'Devin Oliver', handle: H.handle || '', avatar: '', tourRole: 'Artist', verified: true },
        { userId: 'u-brent', owner: false, name: 'Brent Allen', handle: 'brent', avatar: '', tourRole: 'Guitar Tech', verified: false },
        { userId: 'u-jeff', owner: false, name: 'Jeff Mora', handle: 'jeffmora', avatar: '', tourRole: 'FOH Engineer', verified: false }
      ].map(function (p) {
        p.here = sum(function (x) { return x.tour === tourId && x.to === p.userId; });
        p.counts = { flowers: sum(function (x) { return x.to === p.userId; }), endorsements: p.userId === 'u-brent' ? 2 : 0, tours: p.userId === 'u-devin' ? 3 : 1 };
        return p;
      }).sort(function (a, b) { return (b.here - a.here) || (b.owner - a.owner); });
      return { left: 10 - sum(function (x) { return x.from === me; }), canGive: true, people: people,
        given: H.flowers.filter(function (x) { return x.tour === tourId; }).slice().reverse().map(function (x) {
          return { id: x.id, from: x.from, to: x.to, n: x.n, note: x.note, category: x.category || '', at: x.at, mine: x.from === me, fromName: '', toName: '' }; }) };
    },
    myFlowers: function () {
      var H = window.__harness, names = { 'u-brent': 'Brent Allen', 'u-jeff': 'Jeff Mora' };
      window.GR_BACKEND.flowersFor('t1');
      var got = H.flowers.filter(function (x) { return x.to === 'u-devin'; });
      return { counts: { flowers: got.reduce(function (a, x) { return a + x.n; }, 0), endorsements: devinActs().length, tours: 3 },
        left: 10 - H.flowers.filter(function (x) { return x.from === 'u-devin'; }).reduce(function (a, x) { return a + x.n; }, 0),
        got: got.slice().reverse().map(function (x) { return { id: x.id, n: x.n, note: x.note, category: x.category || '', at: x.at, from: x.from, name: names[x.from] || '', avatar: '', tourId: x.tour, tour: 'Harness run' }; }) };
    },
    searchSuggestions: function () {
      var P = window.GR_BACKEND.people, row = function (uid) { var p = P[uid] || (uid === 'u-jeff' ? { name: 'Jeff Mora', handle: 'jeffmora', roles: ['FOH Engineer'], canOpen: true, followers: 3 } : {}); return Object.assign({ userId: uid, avatar: '', followers: 0, roles: [] }, p); };
      return Promise.resolve({ following: [Object.assign(row('u-brent'), { iFollow: true })], crew: [row('u-jeff')],
        artists: (window.__harness.acts || []).map(function (a) { return { id: a.id, handle: a.handle, name: a.name, avatar: '' }; }) });
    },
    facesFor: function () { return window.__harness.faces || {}; },
    removeEndorsement: function (eid) { var H = window.__harness; H.devinActs = devinActs().filter(function (x) { return x.eid !== eid; }); return Promise.resolve(); },
    endorse: function (aid, uid) { var H = window.__harness, a = (H.acts || []).filter(function (x) { return x.id === aid; })[0]; if (a) a.members.forEach(function (m) { if (m.userId === uid) m.endorsed = true; }); return Promise.resolve(); },
    /* Square, in memory (MODEL7MERCH): connected to the sandbox with two test nights. */
    squareState: function () {
      var H = window.__harness;
      if (H.square === undefined) H.square = { env: 'sandbox', merchant: 'MLZE3W9FYYE1Q', location_id: 'LH2B1ZQ4', location_name: 'Merch Table',
        status: 'ok', detail: '', last_sync: new Date(Date.now() - 3 * 60e3).toISOString(), connected_at: new Date(Date.now() - 864e5).toISOString() };
      return Promise.resolve(H.square);
    },
    squareNights: function () {
      var H = window.__harness;
      if (!H.square) return Promise.resolve([]);
      if (!H.squarePays) {
        var mk = function (daysAgo, hourUTC, amount, tip, i) {
          var d = new Date(); d.setUTCDate(d.getUTCDate() - daysAgo); d.setUTCHours(hourUTC, 10 + i * 7, 0, 0);
          return { id: 'sqp' + daysAgo + '-' + i, created_at: d.toISOString(), amount: amount, tip: tip, status: 'COMPLETED' };
        };
        H.squarePays = [mk(1, 2, 45, 5, 0), mk(1, 2, 90, 0, 1), mk(1, 3, 35, 7, 2), mk(0, 1, 60, 10, 0), mk(0, 2, 25, 0, 1)];
      }
      return Promise.resolve(H.squarePays);
    },
    squareConnect: function (tok) {
      var H = window.__harness;
      H.square = { env: 'sandbox', merchant: '', location_id: '', location_name: '', status: 'new', detail: '',
        last_sync: null, connected_at: new Date().toISOString() };
      return Promise.resolve();
    },
    squareDisconnect: function () { window.__harness.square = null; window.__harness.squarePays = null; return Promise.resolve(); },
    /* Tour history, in memory: the key saved, I See Stars synced with an
       ISS-shaped summary (the real page reads ~735 shows / 34 tours). */
    setlistState: function () {
      var H = window.__harness;
      if (H.setlist === undefined) H.setlist = { status: 'ok', detail: '', last_sync: new Date(Date.now() - 9 * 60e3).toISOString(),
        connected_at: new Date(Date.now() - 864e5).toISOString() };
      return Promise.resolve(H.setlist);
    },
    setlistConnect: function () {
      window.__harness.setlist = { status: 'new', detail: '', last_sync: null, connected_at: new Date().toISOString() };
      return Promise.resolve();
    },
    setlistDisconnect: function () { window.__harness.setlist = null; return Promise.resolve(); },
    // Add missing tours: the pretend archives come in over a few polls, then two candidates.
    tourFindStart: function (artistId, force) {
      window.__harness.rescans = (window.__harness.rescans || 0) + (force ? 1 : 0);
      var H = window.__harness; H.tf = H.tf || {};
      H.tf[artistId] = { status: 'reading', detail: '', day: new Date().toISOString().slice(0, 10), pages: 0, waiting: 6, brain: !!H.tfBrain, eta: 540, unread: 0, batches: { total: 0, done: 0 },
        startedAt: new Date().toISOString(),
        sources: { theprp: 'reading', lambgoat: 'new' }, candidates: (H.tf[artistId] && H.tf[artistId].candidates || []),
        runs: [{ first: '2018-05-26', last: '2018-06-21', n: 15, countries: 'CA, US', nights: [{ date: '2018-05-26', city: 'San Antonio', state: 'TX', country: 'US', venue: 'Aztec Theatre' }, { date: '2018-05-27', city: 'Houston', state: 'TX', country: 'US', venue: 'Warehouse Live' }] },
               { first: '2017-07-15', last: '2017-08-04', n: 11, countries: 'US', nights: [{ date: '2017-07-15', city: 'St. Louis', state: 'MO', country: 'US', venue: 'Pop\u2019s' }] }] };
      return Promise.resolve(JSON.parse(JSON.stringify(H.tf[artistId])));
    },
    tourFindState: function (artistId) {
      var H = window.__harness; H.tf = H.tf || {};
      var st = H.tf[artistId] || { status: 'idle', detail: '', pages: 0, waiting: 0, sources: {}, candidates: [], runs: [], brain: false, eta: 0, batches: { total: 0, done: 0 } };
      if (st.status === 'reading') { st.pages += 3; st.waiting -= 3; st.eta = 300; if (st.waiting <= 0) { st.waiting = 0; st.status = st.brain ? 'thinking' : 'ready'; st.sources = { theprp: 'done', lambgoat: 'done' }; st.batches = { total: 4, done: 0 }; st.eta = 60; } }
      else if (st.status === 'thinking') {
        // The server's own read: four batches, then the finds land and the sure one fills in.
        st.batches.done += 2; st.eta = Math.max(0, (st.batches.total - st.batches.done) * 12);
        if (st.batches.done >= st.batches.total) {
          st.status = 'done'; st.eta = 0; st.detail = 'Read 6 articles: 2 tours found, 2 new, 1 added to the page'; st.finishedAt = new Date().toISOString();
          st.candidates.push({ id: 'auto1', name: 'Let Light Overcome the Darkness Tour', role: 'support', first: '2019-11-05', last: '2019-12-08', region: 'US', lineup: 'Our Last Night, The Word Alive',
            n: 2, sources: [], status: 'added', auto: true, decidedAt: new Date().toISOString(), matched: 0, have: 2, named: 2, toAdd: 0, fill: false });
          st.candidates.push({ id: 'tie1', name: 'Tie One', role: 'support', first: '2018-05-26', last: '2018-06-21', region: 'US', lineup: 'Dance Gavin Dance', n: 0, sources: [], status: 'new', auto: false, matched: 15, have: 15, toAdd: 0, fill: false });
          st.candidates.push({ id: 'tie2', name: 'Tie Two', role: 'support', first: '2018-05-28', last: '2018-06-30', region: 'US', lineup: 'Erra', n: 0, sources: [], status: 'new', auto: false, matched: 15, have: 15, toAdd: 0, fill: false });
        }
      }
      return Promise.resolve(JSON.parse(JSON.stringify(st)));
    },
    tourFindPages: function (artistId) {
      return Promise.resolve([{ url: 'https://www.theprp.com/2019/09/x/', source: 'theprp', title: 'Our Last Night tour', published: '2019-09-10', body: 'Our Last Night ... 11/05 Omaha, NE' },
        { url: 'https://lambgoat.com/news/2/x/', source: 'lambgoat', title: 'DGD tour', published: '2018-03-01', body: 'Dance Gavin Dance ... 5/26 San Antonio, TX' }]);
    },
    tourFindPropose: function (artistId, cands, readUrls, trusted) {
      var H = window.__harness; H.tf = H.tf || {};
      // A poster or pasted page can come before any search: the entry is made on the spot.
      var st = H.tf[artistId] || (H.tf[artistId] = { status: 'idle', detail: '', pages: 0, waiting: 0, sources: {}, candidates: [], runs: [], brain: false, eta: 0, batches: { total: 0, done: 0 } });
      H.proposed = (H.proposed || []).concat(cands);
      H.readUrls = (H.readUrls || []).concat(readUrls || []);
      // The first find adds dates, so the server fills it in by itself; the second is left to look at.
      var filled = 0;
      H.trusted = (H.trusted || []).concat([!!trusted]);
      (cands || []).forEach(function (c, i) {
        // Handed over (trusted): everything with dates fills in; from the archives only the first find is sure.
        var sure = trusted ? (c.dates || []).length > 0 : i === 0;
        if (sure) filled += 1;
        st.candidates.push({ id: 'cand' + (st.candidates.length + 1), name: c.name, role: c.role, first: c.start, last: c.end, region: c.region, lineup: c.lineup,
          n: (c.dates || []).length, sources: c.sources || [], status: sure ? 'added' : 'new', auto: sure, decidedAt: sure ? new Date().toISOString() : null,
          matched: i === 0 ? 16 : 0, have: i === 0 ? 16 : 0, named: sure ? 16 : 0, toAdd: i === 0 ? 2 : 0, fill: false });
      });
      st.filled = filled;
      // And one tour the page already has, with dates the page lacks.
      st.candidates.push({ id: 'candfill', name: 'The Godmode', role: 'support', first: '2024-05-07', last: '2024-05-25', region: 'US', lineup: 'In This Moment, Kim Dracula',
        n: 13, sources: ['https://www.theprp.com/2024/02/13/x/'], status: 'new', matched: 0, have: 2, toAdd: 11, fill: true });
      st.status = 'done'; st.eta = 0; st.added = (cands || []).length; st.finishedAt = new Date().toISOString(); st.auto = false;
      st.detail = 'Read 2 articles: ' + (cands || []).length + ' tours found, ' + (cands || []).length + ' new, ' + filled + ' added to the page';
      return Promise.resolve(JSON.parse(JSON.stringify(st)));
    },
    tourCandidateDecide: function (candId, add, name) {
      var H = window.__harness; var st = null, c = null;
      Object.keys(H.tf || {}).forEach(function (k) { H.tf[k].candidates.forEach(function (x) { if (x.id === candId) { st = H.tf[k]; c = x; } }); });
      c.status = add ? 'added' : 'no'; if (add && name) c.name = name;
      // What the real server reports back: how many nights took the name, how many dates were added.
      return Promise.resolve(Object.assign(JSON.parse(JSON.stringify(st)), add ? { renamed: c.matched, inserted: Math.max(0, c.n - c.have) } : {}));
    },
    tourNights: function (artistId, name) {
      // Three pretend nights for any named tour.
      return Promise.resolve([{ date: '2025-03-01', city: 'Dallas', state: 'TX', country: 'US', venue: 'House of Blues', url: 'https://web.archive.org/web/20090318071425id_/http://www.myspace.com/iseestars', announced: false },
        { date: '2025-03-02', city: 'Austin', state: 'TX', country: 'US', venue: 'Emo\u2019s', url: '', announced: false },
        { date: '2025-03-04', city: 'Houston', state: 'TX', country: 'US', venue: 'Warehouse Live', url: '', announced: true, festival: 'South By So What?! 2025' }]);
    },
    tourRunName: function (artistId, first, last, name) {
      var H = window.__harness; H.tf = H.tf || {}; var st = H.tf[artistId] || (H.tf[artistId] = { status: 'idle', detail: '', pages: 0, waiting: 0, sources: {}, candidates: [], runs: [] });
      st.runs = (st.runs || []).filter(function (r) { return r.first !== first; });
      st.candidates.push({ id: 'run' + Date.now(), name: name, role: '', first: first, last: last, n: 3, sources: [], status: 'added', matched: 0, have: 3, fill: false });
      H.namedRuns = (H.namedRuns || []).concat([{ first: first, last: last, name: name }]);
      return Promise.resolve(Object.assign(JSON.parse(JSON.stringify(st)), { named: 3 }));
    },
    tourFindNote: function (artistId, note) { var H = window.__harness; H.tfNotes = (H.tfNotes || []).concat([note]); return Promise.resolve(); },
    artistTourEdit: function (artistId, name, newName) {
      var H = window.__harness; H.tourEdits = (H.tourEdits || []).concat([{ artistId: artistId, name: name, newName: newName }]);
      Object.keys(H.histories || {}).forEach(function (k) { var hr = H.histories[k]; (hr && hr.summary && hr.summary.toursList || []).forEach(function (t) { if (t.name === name) t.name = newName; }); });
      return Promise.resolve({});
    },
    artistTourRemove: function (artistId, name) {
      var H = window.__harness; H.tourRemoved = (H.tourRemoved || []).concat([{ artistId: artistId, name: name }]);
      Object.keys(H.histories || {}).forEach(function (k) { var hr = H.histories[k]; if (hr && hr.summary && hr.summary.toursList) hr.summary.toursList = hr.summary.toursList.filter(function (t) { return t.name !== name; }); });
      return Promise.resolve({});
    },
    artistTourConflicts: function (artistId, name) {
      var H = window.__harness; H.conflicts = H.conflicts || [{ date: '2016-07-01', a: 'Vans Warped Tour 2016', b: 'Pretend Side Run', holder: 'Vans Warped Tour 2016', city: 'Pomona', venue: 'Fairplex' },
        { date: '2016-07-02', a: 'Vans Warped Tour 2016', b: 'Pretend Side Run', holder: 'Pretend Side Run', city: 'Ventura', venue: 'Fairgrounds' }];
      return Promise.resolve(H.conflicts.filter(function (c) { return c.a === name || c.b === name; }));
    },
    artistTourPick: function (artistId, date, name) {
      var H = window.__harness; H.picks = (H.picks || []).concat([{ date: date, name: name }]); H.conflicts = (H.conflicts || []).filter(function (c) { return c.date !== date; });
      return Promise.resolve({ ok: true, left: H.conflicts.length });
    },
    tourCandidateUndo: function (candId) {
      var H = window.__harness; var st = null;
      Object.keys(H.tf || {}).forEach(function (k) { H.tf[k].candidates.forEach(function (x) { if (x.id === candId) { st = H.tf[k]; x.status = x.auto ? 'no' : 'new'; } }); });
      return Promise.resolve(JSON.parse(JSON.stringify(st)));
    },
    // MY PAY's own cards: two pretend charges and a deposit wait in the inbox.
    myPayAccounts: function () { var H = window.__harness; return Promise.resolve((H.myPayAccounts || []).slice()); },
    myPayClaimAccounts: function (list) {
      var H = window.__harness; H.myPayAccounts = H.myPayAccounts || [];
      (list || []).forEach(function (x) { if (!H.myPayAccounts.some(function (a) { return a.account_id === x.id; })) H.myPayAccounts.push({ account_id: x.id, name: x.id === 'acc-chk' ? 'My Checking' : 'Card ' + x.id, card: x.card || 'debit' }); });
      return Promise.resolve({ ok: true, n: (list || []).length });
    },
    myPayClaimItems: function (items) { var H = window.__harness; H.myPayAccounts = H.myPayAccounts || []; (items || []).forEach(function (it) { H.myPayAccounts.push({ account_id: 'acc-' + it, name: 'Personal ' + it, card: 'debit' }); }); return Promise.resolve({ ok: true, accounts: (items || []).length, list: H.myPayAccounts.slice() }); },
    myPayItemIds: function () { return Promise.resolve([]); },
    myPayTwins: function () { return Promise.resolve([]); },
    myPayReleaseAccount: function (id) { var H = window.__harness; H.myPayAccounts = (H.myPayAccounts || []).filter(function (a) { return a.account_id !== id; }); return Promise.resolve(); },
    myPayInbox: function () {
      var H = window.__harness;
      if (!H.myPayInbox) H.myPayInbox = [{ id: 'tx-a', kind: 'charge', date: '2026-10-02', merchant: 'Whole Foods', amount: 18.2, account: 'My Checking', card: 'debit' },
        { id: 'tx-b', kind: 'charge', date: '2026-10-01', merchant: 'Shell', amount: 42.5, account: 'My Checking', card: 'debit' },
        { id: 'dep-a', kind: 'deposit', date: '2026-10-03', merchant: 'Deposit', amount: 500, account: '', card: 'debit' }];
      return Promise.resolve(H.myPayInbox.slice());
    },
    myPayFile: function (tourId, itemId, category, how) {
      var H = window.__harness; H.payBooks = H.payBooks || {}; var doc = H.payBooks[tourId] || (H.payBooks[tourId] = {});
      var it = (H.myPayInbox || []).filter(function (x) { return x.id === itemId; })[0]; if (!it) return Promise.reject({ code: 'not_found' });
      if (it.kind === 'charge') { doc.entries = doc.entries || {}; doc.entries['b' + itemId] = { date: it.date, amount: it.amount, how: how || it.card, category: category, note: it.merchant, bank: itemId, createdAt: Date.now() }; }
      else { doc.income = doc.income || {}; doc.income['b' + itemId] = { date: it.date, amount: it.amount, category: category, note: 'From the bank', bank: itemId, createdAt: Date.now() }; }
      H.myPayInbox = H.myPayInbox.filter(function (x) { return x.id !== itemId; });
      return Promise.resolve();
    },
    myPaySkip: function (itemId) { var H = window.__harness; H.myPayInbox = (H.myPayInbox || []).filter(function (x) { return x.id !== itemId; }); return Promise.resolve(); },
    // MY PAY: the harness Devin is a crew member paid by the week, with one payment logged.
    myPay: function (tourId) {
      return Promise.resolve(tourId === 't1' ? { crew: { id: 'c-dev', name: 'Devin Oliver', title: 'Vocals', pay: 0, rate: 500, per: 'week', payTyped: false },
        payments: [{ id: 'p1', date: '2026-09-28', amount: 500, how: 'Debit', label: 'Devin Oliver \u2014 pay' }],
        tour: { spanStart: null, spanEnd: null, rehearsalStart: null, first: '2026-09-27', last: '2026-10-04' } }
        : { crew: null, payments: [], tour: { first: null, last: null } });
    },
    myPayBook: function (tourId) { var H = window.__harness; H.payBooks = H.payBooks || {}; return Promise.resolve(H.payBooks[tourId] || {}); },
    saveMyPayBook: function (tourId, doc) { var H = window.__harness; H.payBooks = H.payBooks || {}; H.payBooks[tourId] = doc; return Promise.resolve(); },
    artistHistory: function (artistId) {
      var H = window.__harness;
      H.histories = H.histories || {};
      var a = (H.acts || []).filter(function (x) { return x.id === artistId; })[0];
      // Seeded once; after Turn off it stays off, like the real table.
      if (!H.histSeeded && a && /i see stars/i.test(a.name || '')) {
        H.histSeeded = true;
        H.histories[artistId] = { artist_id: artistId, status: 'ok', detail: '', total: 735, pages: 37, next_page: 0,
          synced_at: new Date(Date.now() - 36e5).toISOString(),
          mb_url: 'https://www.setlist.fm/setlists/i-see-stars-3bd2d464.html', credits: ['concertarchives.org', 'web.archive.org'],
          summary: { shows: 735, tours: 34, countries: 33, cities: 212, firstYear: 2007, lastYear: 2026,
            years: { 2026: 44, 2025: 21, 2024: 86 },
            toursList: [ { name: '10 Years In The Black', n: 33, first: '2016-11-01', last: '2017-02-18', lineup: 'Asking Alexandria, Born Of Osiris, After The Burial, Upon A Burning Body' },
              { name: 'Aftershock 2025', n: 1, first: '2025-10-04', last: '2025-10-04', lineup: '', kind: 'festival' },
              { name: 'Shows outside a tour \u00b7 2009', key: 'year:2009', n: 3, first: '2009-01-24', last: '2009-12-28', lineup: '', kind: 'shows' },
              { name: 'Treehouse Tour', conflict: true, n: 39, first: '2016-06-01', last: '2016-08-12' } ],
            countriesList: [ { name: 'United States', n: 595 }, { name: 'United Kingdom', n: 27 } ] } };
      }
      var hr = H.histories[artistId];
      if (!hr) return Promise.resolve(null);
      // Only the columns the real read asks for, so a field the app leans on
      // that isn't among them shows up here as missing.
      var cols = {};
      ['artist_id', 'status', 'detail', 'total', 'pages', 'next_page', 'summary', 'synced_at', 'mb_url', 'auto', 'credits'].forEach(function (k) { cols[k] = hr[k] == null && k === 'auto' ? false : hr[k] == null && k === 'credits' ? [] : hr[k]; });
      return Promise.resolve(cols);
    },
    historyStart: function (artistId) {
      var H = window.__harness;
      H.histories = H.histories || {};
      H.histories[artistId] = { artist_id: artistId, status: 'finding', detail: '', total: 0, pages: 0, next_page: 1,
        synced_at: null, mb_url: '', summary: {} };
      return Promise.resolve({ ok: true });
    },
    historyStop: function (artistId) {
      var H = window.__harness;
      if (H.histories) delete H.histories[artistId];
      return Promise.resolve({ ok: true });
    },
    /* New income, in memory: two bank deposits no matcher claimed (one
       atVenu-looking near s0's night, one plain). catalogIncome mirrors the
       real RPC: merch/guarantee with a show write the received fields;
       anything whole-tour lands in doc.otherIncome; skip just clears it.
       'other' (0141) is the book's own money too, and keeps the words typed
       for it as label (cleaned as the database cleans them; none typed, no
       label; a show id sent with it is not used). */
    incomeNew: function () {
      var H = window.__harness;
      if (!H.deposits) {
        var day = function (daysAgo) { var d = new Date(Date.now() - daysAgo * 864e5); return d.toISOString().slice(0, 10); };
        H.deposits = [
          { id: 'dep1', date: day(1), amount: 912.34, atvenu: true, matched: false },
          { id: 'dep2', date: day(3), amount: 1500.5, atvenu: false, matched: false }
        ];
      }
      return Promise.resolve(H.deposits.filter(function (d) { return !d.matched; }).map(function (d) {
        return { id: d.id, date: d.date, amount: d.amount, atvenu: d.atvenu, watch: d.watch || '' };
      }));
    },
    /* Who charges under Crew were for (set_charge_crew, 0126): only onto a
       charge that is there, under Crew, for a person on the tour's list. */
    setChargeCrew: async function (tourId, tags, keep) {
      var H = window.__harness, tdoc = tours[tourId] || {}, patch = {}, n = 0;
      H.crewTags = (H.crewTags || []).concat([{ tourId: tourId, tags: JSON.parse(JSON.stringify(tags || {})), keep: !!keep }]);
      Object.keys(tags || {}).forEach(function (k) {
        var ch = (tdoc.charges || {})[k], who = tags[k];
        if (!ch || typeof ch !== 'object') return;
        if (who == null) { patch[k] = { crewId: null }; n += 1; return; }
        if (ch.category !== 'crew' || !(tdoc.crew || {})[who]) return;
        if (keep && ch.crewId && ch.crewId !== who) return;
        patch[k] = { crewId: who }; n += 1;
      });
      if (n) await db.doc('tours/' + tourId).update({ charges: patch });
      return { ok: true, tagged: n, asked: Object.keys(tags || {}).length };
    },
    /* One night's guarantee met by bank money (catalog_guarantee_night, 0121
       restated in 0124). A night not yet received takes what the bank shows
       and is received on it, whatever Deposit Amount was expected. A night
       already received with a Deposit Amount is compared with it: confirmed,
       added to (the extra comes off what's owed), or only "seen so far". */
    __nightPatch: function (cur, amount, date) {
      cur = cur || {};
      var had = Number(cur.guaranteeDeposit) > 0 ? Number(cur.guaranteeDeposit) : 0;
      if (!(cur.guaranteeReceived === true && had > 0)) {
        // (A part payment seen earlier on a night whose tick was taken off is part of it; a full sighting is not counted again.)
        var prior = had > 0 && cur.guaranteeSeen != null ? Number(cur.guaranteeSeen) : 0;
        if (prior >= had - 1) prior = 0;
        var tot = Math.round((prior + amount) * 100) / 100;
        return { guaranteeReceived: true, guaranteeReceivedAt: date, guaranteeDeposit: tot, guaranteeSeen: tot };
      }
      var seen = cur.guaranteeSeen != null ? Number(cur.guaranteeSeen) : (cur.guaranteeReceivedAt ? had : 0);
      seen = Math.round((Math.min(seen, had) + amount) * 100) / 100;
      if (seen > had + 1) {
        var gw = Object.assign({}, cur.guaranteeWhy || {});
        var owed = Math.max(0, (Number(gw.owed) || 0) - (seen - had));
        gw.owed = owed > 0 ? owed : null;
        return { guaranteeReceived: true, guaranteeReceivedAt: date, guaranteeDeposit: seen, guaranteeSeen: seen, guaranteeWhy: gw };
      }
      if (seen >= had - 1) return { guaranteeReceivedAt: date, guaranteeDeposit: seen, guaranteeSeen: seen };
      return { guaranteeSeen: seen };
    },
    /* One night's merch met by bank money (catalog_merch_night, 0127): received
       on what lands; a second deposit adds to what the bank has shown. */
    __merchNight: function (cur, amount, date) {
      cur = cur || {};
      var had = Number(cur.merchDeposit) > 0 ? Number(cur.merchDeposit) : 0;
      if (cur.merchReceivedAt && had > 0) {
        return { merchReceived: true, merchReceivedAt: cur.merchReceivedAt > date ? cur.merchReceivedAt : date, merchDeposit: Math.round((had + amount) * 100) / 100 };
      }
      return { merchReceived: true, merchReceivedAt: date, merchDeposit: Math.round(amount * 100) / 100 };
    },
    /* Shares over nights' merch (catalog_merch_parts): checked whole, then filed. */
    __merchParts: function (tourId, parts, total, date) {
      var tdoc = tours[tourId] || {}, sum = 0, seenIds = {}, sh = {}, self = this;
      if (!Array.isArray(parts) || !parts.length) throw new Error('which nights');
      parts.forEach(function (p) {
        var cur = (tdoc.shows || {})[p.show];
        if (!cur || seenIds[p.show] || !(Number(cur.income && cur.income.merch) > 0) || !(Number(p.amount) > 0)) throw new Error('bad part');
        seenIds[p.show] = 1; sum += Number(p.amount);
      });
      if (Math.abs(sum - total) > 0.02) throw new Error('does not add up');
      parts.forEach(function (p) { sh[p.show] = self.__merchNight((tdoc.shows || {})[p.show], Number(p.amount), date); });
      return sh;
    },
    /* Shares over nights (catalog_guarantee_parts): checked whole, then filed. */
    __parts: function (tourId, parts, total, date) {
      var tdoc = tours[tourId] || {}, sum = 0, seenIds = {}, sh = {}, self = this;
      if (!Array.isArray(parts) || !parts.length) throw new Error('which nights');
      parts.forEach(function (p) {
        var cur = (tdoc.shows || {})[p.show];
        if (!cur || seenIds[p.show] || !(Number(cur.income && cur.income.guarantee) > 0) || !(Number(p.amount) > 0)) throw new Error('bad part');
        seenIds[p.show] = 1; sum += Number(p.amount);
      });
      if (Math.abs(sum - total) > 0.02) throw new Error('does not add up');
      parts.forEach(function (p) {
        var cur = (tdoc.shows || {})[p.show] || {}, out = self.__nightPatch(cur, Number(p.amount), date);
        var g = Number(cur.income.guarantee), had = Number(cur.guaranteeDeposit) > 0 ? Number(cur.guaranteeDeposit) : 0;
        var depNow = out.guaranteeDeposit != null ? out.guaranteeDeposit : had;
        var agent = Math.min(Number(p.agent) || 0, Math.max(0, g - depNow));
        var hasWhy = cur.guaranteeWhy && Object.keys(cur.guaranteeWhy).some(function (k) { return Number(cur.guaranteeWhy[k]) > 0; });
        if (agent > 0 && !hasWhy && cur.guaranteePaidBy !== 'agency') { out.guaranteeWhy = { agent: Math.round(agent * 100) / 100 }; out.guaranteeWhyAsked = true; }
        sh[p.show] = out;
      });
      return sh;
    },
    catalogIncome: async function (depId, opts) {
      var H = window.__harness, o = opts || {};
      var sent = { id: depId, tourId: o.tourId || null, showId: o.showId || null, kind: o.kind };
      // (For 'other', what the app sent as its words, as sent. Every other record is as it always was.)
      if (o.kind === 'other') sent.note = o.note == null ? null : o.note;
      H.catalogued = (H.catalogued || []).concat([sent]);
      var dep = (H.deposits || []).filter(function (d) { return d.id === depId; })[0];
      if (!dep) return { ok: false, why: 'gone' };
      if (dep.matched) return { ok: false, why: 'done' };
      if (['merch', 'merch_later', 'guarantee', 'guarantee_later', 'royalties', 'advance', 'other', 'skip'].indexOf(o.kind) < 0) throw new Error('what kind');
      // 'other' is never one night's money: a show id sent with it is not used.
      if (o.kind === 'other') o = Object.assign({}, o, { showId: null });
      if (o.showId && o.kind !== 'merch' && o.kind !== 'guarantee' && o.kind !== 'skip') throw new Error('not show money');
      if (o.showId && o.kind !== 'skip' && !(((tours[o.tourId] || {}).shows || {})[o.showId] && typeof tours[o.tourId].shows[o.showId] === 'object')) throw new Error('no such show');
      if (/_later$/.test(o.kind) && (tours[o.tourId] || {}).kind === 'offtour') throw new Error('no nights on this book');
      dep.matched = true;
      if (o.kind === 'skip') return { ok: true };
      if (o.showId && (o.kind === 'merch' || o.kind === 'guarantee')) {
        var sh = {};
        if (o.kind === 'merch') sh[o.showId] = this.__merchNight(((tours[o.tourId] || {}).shows || {})[o.showId], dep.amount, dep.date);
        else sh[o.showId] = this.__nightPatch(((tours[o.tourId] || {}).shows || {})[o.showId], dep.amount, dep.date);
        await db.doc('tours/' + o.tourId).update({ shows: sh });
        return { ok: true };
      }
      // Merch with no show yet: set aside on the tour, apart from income (0127).
      if (o.kind === 'merch_later') {
        var ms = {};
        ms[depId] = { date: dep.date, amount: dep.amount, at: Date.now() };
        await db.doc('tours/' + o.tourId).update({ merchToSort: ms });
        return { ok: true };
      }
      // The whole tour's money; "Sort later" is a guarantee flagged unsorted (0124).
      var oi = {};
      oi[depId] = { date: dep.date, amount: dep.amount, kind: o.kind === 'guarantee_later' ? 'guarantee' : o.kind, at: Date.now() };
      if (o.kind === 'guarantee_later') oi[depId].unsorted = true;
      // 'other': the words typed for it, cleaned; nothing typed, no label. Ignored for every other kind.
      var said = o.kind !== 'other' ? '' : window.GR && window.GR.otherNote ? window.GR.otherNote(o.note)
        : String(o.note == null ? '' : o.note).replace(/\s+/g, ' ').trim().slice(0, 60).trim();
      if (said) oi[depId].label = said;
      await db.doc('tours/' + o.tourId).update({ otherIncome: oi });
      return { ok: true };
    },
    // (As the real backend file says: this copy takes the note.)
    catalogIncomeNote: true,
    /* One guarantee deposit over several nights (0121, 0124). */
    catalogIncomeSplit: async function (depId, opts) {
      var H = window.__harness, o = opts || {}, parts = Array.isArray(o.parts) ? o.parts : [];
      H.catalogued = (H.catalogued || []).concat([{ id: depId, tourId: o.tourId || null, parts: parts, kind: 'guarantee' }]);
      var dep = (H.deposits || []).filter(function (d) { return d.id === depId; })[0];
      if (!dep) return { ok: false, why: 'gone' };
      if (dep.matched) return { ok: false, why: 'done' };
      var sh = this.__parts(o.tourId, parts, dep.amount, dep.date);
      dep.matched = true;
      await db.doc('tours/' + o.tourId).update({ shows: sh });
      return { ok: true, nights: parts.length };
    },
    /* One merch deposit over several nights (catalog_merch_split, 0127). */
    catalogMerchSplit: async function (depId, opts) {
      var H = window.__harness, o = opts || {}, parts = Array.isArray(o.parts) ? o.parts : [];
      H.catalogued = (H.catalogued || []).concat([{ id: depId, tourId: o.tourId || null, parts: parts, kind: 'merch' }]);
      var dep = (H.deposits || []).filter(function (d) { return d.id === depId; })[0];
      if (!dep) return { ok: false, why: 'gone' };
      if (dep.matched) return { ok: false, why: 'done' };
      var sh = this.__merchParts(o.tourId, parts, dep.amount, dep.date);
      dep.matched = true;
      await db.doc('tours/' + o.tourId).update({ shows: sh });
      return { ok: true, nights: parts.length };
    },
    /* "Sort later" money finds its show(s): all of it, or part of it with the
       rest left to sort; or it stays on the whole tour (sort_guarantee, 0125). */
    sortGuarantee: async function (depId, opts) {
      var H = window.__harness, o = opts || {}, parts = Array.isArray(o.parts) ? o.parts : [];
      H.sorted = (H.sorted || []).concat([{ id: depId, tourId: o.tourId, parts: parts, whole: !!o.whole, expect: o.expect }]);
      var entry = ((tours[o.tourId] || {}).otherIncome || {})[depId];
      if (!entry || entry.unsorted !== true) return { ok: false, why: 'done' };
      var amt = Number(entry.amount);
      if (typeof o.expect === 'number' && Math.abs(o.expect - amt) > 0.02) return { ok: false, why: 'changed', left: amt };
      var oi = {};
      if (o.whole) {
        oi[depId] = { unsorted: null };
        await db.doc('tours/' + o.tourId).update({ otherIncome: oi });
        return { ok: true, nights: 0, left: 0 };
      }
      var placing = parts.reduce(function (n, p) { return n + (Number(p.amount) || 0); }, 0);
      if (!(placing > 0)) throw new Error('bad share');
      if (placing > amt + 0.02) throw new Error('more than is left');
      var rest = Math.round((amt - placing) * 100) / 100;
      var sh = this.__parts(o.tourId, parts, placing, entry.date);
      if (rest < 0.01) { rest = 0; oi[depId] = null; }
      else oi[depId] = { amount: rest, of: Number(entry.of) > 0 ? Number(entry.of) : amt };
      await db.doc('tours/' + o.tourId).update({ otherIncome: oi, shows: sh });
      return { ok: true, nights: parts.length, left: rest };
    },
    /* Logged "Sort later" by mistake: back into New income (unpark_guarantee);
       refused once part of it has been placed. */
    unparkGuarantee: async function (depId, opts) {
      var H = window.__harness, o = opts || {};
      var entry = ((tours[o.tourId] || {}).otherIncome || {})[depId];
      if (!entry || entry.unsorted !== true) return { ok: false, why: 'done' };
      if (entry.of != null) return { ok: false, why: 'partly' };
      var dep = (H.deposits || []).filter(function (d) { return d.id === depId; })[0];
      if (!dep || !dep.matched) return { ok: false, why: 'gone' };
      dep.matched = false;
      var oi = {}; oi[depId] = null;
      await db.doc('tours/' + o.tourId).update({ otherIncome: oi });
      return { ok: true };
    },
    /* A parked merch deposit finds its show(s), all of it or part of it
       (sort_merch, 0127); and back into New income (unpark_merch). */
    sortMerch: async function (depId, opts) {
      var H = window.__harness, o = opts || {}, parts = Array.isArray(o.parts) ? o.parts : [];
      H.sorted = (H.sorted || []).concat([{ id: depId, tourId: o.tourId, parts: parts, expect: o.expect, kind: 'merch' }]);
      var entry = ((tours[o.tourId] || {}).merchToSort || {})[depId];
      if (!entry) return { ok: false, why: 'done' };
      var amt = Number(entry.amount);
      if (typeof o.expect === 'number' && Math.abs(o.expect - amt) > 0.02) return { ok: false, why: 'changed', left: amt };
      var placing = parts.reduce(function (n, p) { return n + (Number(p.amount) || 0); }, 0);
      if (!(placing > 0)) throw new Error('bad share');
      if (placing > amt + 0.02) throw new Error('more than is left');
      var rest = Math.round((amt - placing) * 100) / 100, ms = {};
      var sh = this.__merchParts(o.tourId, parts, placing, entry.date);
      if (rest < 0.01) { rest = 0; ms[depId] = null; }
      else ms[depId] = { amount: rest, of: Number(entry.of) > 0 ? Number(entry.of) : amt };
      await db.doc('tours/' + o.tourId).update({ merchToSort: ms, shows: sh });
      return { ok: true, nights: parts.length, left: rest };
    },
    unparkMerch: async function (depId, opts) {
      var H = window.__harness, o = opts || {};
      var entry = ((tours[o.tourId] || {}).merchToSort || {})[depId];
      if (!entry) return { ok: false, why: 'done' };
      if (entry.of != null) return { ok: false, why: 'partly' };
      var dep = (H.deposits || []).filter(function (d) { return d.id === depId; })[0];
      if (!dep || !dep.matched) return { ok: false, why: 'gone' };
      dep.matched = false;
      var ms = {}; ms[depId] = null;
      await db.doc('tours/' + o.tourId).update({ merchToSort: ms });
      return { ok: true };
    },
    /* Opt-in seed for Members and Crew as two lines: two members (one of them
       the tour manager) and two crew (one a hired player titled Band) with pay set, a card payment and a merch-cash payment to the band (over
       its plan), one payment to the crew (under its plan), and a Crew charge
       with no person on it. */
    seedBand: async function () {
      var day = function (daysAgo) { var d = new Date(Date.now() - daysAgo * 864e5); return d.toISOString().slice(0, 10); };
      await db.doc('tours/t1').update({
        crew: {
          b1: { name: 'Devin Oliver', title: 'Artist', pay: 600, payTyped: true, createdAt: 1 },
          b2: { name: 'Brent Allen', title: 'Tour Manager', member: true, pay: 400, payTyped: true, createdAt: 2 },
          c1: { name: 'Tasha Reed', title: 'Tour Manager', pay: 700, payTyped: true, createdAt: 3 },
          c2: { name: 'Connor Reyes', title: 'Band', pay: 300, payTyped: true, createdAt: 4 },
          // (The everyday seed's one person and his typed pay come off, so this seed's sums stay its own.)
          jm: null },
        charges: {
          zp1: null,
          bp1: { date: day(4), merchant: 'Pay: Devin', amount: 900, category: 'crew', crewId: 'b1', paid: true, manual: true },
          cp1: { date: day(3), merchant: 'Pay: Tasha', amount: 500, category: 'crew', crewId: 'c1', paid: true, manual: true },
          cp2: { date: day(2), merchant: 'VENMO PAYMENT', amount: 200, category: 'crew' } },
        // (Brent's pay came out of the merch cash: an entry in the cash log, with his name on it.)
        cashLog: { bp2: { date: day(3), amount: 300, label: 'Pay: Brent', category: 'crew', crewId: 'b2', createdAt: 2 } } });
      return true;
    },
    /* Opt-in seed for merch deposits answered like guarantees (0127): three
       nights with merch logged and not seen in the bank (one with a card
       estimate, one with cash kept, one ticked by hand), one night the bank
       has already shown, and four deposits: one night's merch to the dollar,
       two nights' together, one that fits nothing, and one more for the night
       already shown. */
    seedMerch: async function () {
      var H = window.__harness;
      var day = function (daysAgo) { var d = new Date(Date.now() - daysAgo * 864e5); return d.toISOString().slice(0, 10); };
      await db.doc('tours/t1').update({ shows: {
        m1: { id: 'm1', date: day(9), city: 'Detroit, MI', venue: 'Saint Andrew\u2019s Hall', loggedAt: 1, income: { merch: 2400, guarantee: 2500 }, merchReceived: false, merchCardDeposit: 1810.55, guaranteeReceived: false },
        m2: { id: 'm2', date: day(8), city: 'Chicago, IL', venue: 'Bottom Lounge', loggedAt: 1, income: { merch: 1900 }, merchCash: 300, merchReceived: false },
        m3: { id: 'm3', date: day(7), city: 'Milwaukee, WI', venue: 'The Rave', loggedAt: 1, income: { merch: 1200 }, merchReceived: true },
        m4: { id: 'm4', date: day(6), city: 'Cleveland, OH', venue: 'House of Blues', loggedAt: 1, income: { merch: 1500 }, merchReceived: true, merchReceivedAt: day(4), merchDeposit: 1500 } } });
      H.deposits = [
        { id: 'md1', date: day(2), amount: 1200, atvenu: false, matched: false, watch: 'merch' },
        { id: 'md2', date: day(2), amount: 3410.55, atvenu: false, matched: false, watch: 'merch' },
        { id: 'md3', date: day(2), amount: 777, atvenu: false, matched: false, watch: 'merch' },
        { id: 'md4', date: day(1), amount: 88.5, atvenu: false, matched: false, watch: 'both' }
      ];
      return true;
    },
    /* Opt-in seed for guarantees as Devin runs them: a night with the
       Guarantee Total set and a Deposit Amount typed from the settlement (not
       received), two nights with only the total, a guarantee and a merch night
       ticked Received by hand, and three deposits: one that is the typed
       Deposit Amount, one that matches nothing (to log "Sort later"), one that
       is the merch. */
    seedGuarantees: async function () {
      var H = window.__harness;
      var day = function (daysAgo) { var d = new Date(Date.now() - daysAgo * 864e5); return d.toISOString().slice(0, 10); };
      await db.doc('tours/t1').update({ commission: { agent: { mode: 'pct', value: 10 } }, shows: {
        g1: { id: 'g1', date: day(9), city: 'Detroit, MI', venue: 'Saint Andrew\u2019s Hall', loggedAt: 1, income: { guarantee: 5000 }, guaranteeReceived: false, guaranteeDeposit: 4500 },
        g2: { id: 'g2', date: day(8), city: 'Chicago, IL', venue: 'Bottom Lounge', loggedAt: 1, income: { guarantee: 3000 }, guaranteeReceived: false },
        g3: { id: 'g3', date: day(7), city: 'Columbus, OH', venue: 'Newport', loggedAt: 1, income: { guarantee: 2000 }, guaranteeReceived: false },
        g4: { id: 'g4', date: day(6), city: 'Milwaukee, WI', venue: 'The Rave', loggedAt: 1, income: { merch: 1200 }, merchReceived: true },
        g5: { id: 'g5', date: day(5), city: 'Cleveland, OH', venue: 'House of Blues', loggedAt: 1, income: { guarantee: 4100 }, guaranteeReceived: true } } });
      H.deposits = [
        { id: 'gd1', date: day(2), amount: 4500, atvenu: false, matched: false, watch: 'both' },
        { id: 'gd2', date: day(2), amount: 7777, atvenu: false, matched: false, watch: 'both' },
        { id: 'gd3', date: day(2), amount: 1200, atvenu: false, matched: false, watch: 'both' }
      ];
      return true;
    },
    /* Opt-in seed for the lump-sum sheet (the default harness books stay as
       they are): three nights with guarantees logged and not received, a 10%
       booking agent, and three deposits: the three nights in full, the three
       less the agent's cut, and one that fits nothing. */
    seedLump: async function () {
      var H = window.__harness;
      var day = function (daysAgo) { var d = new Date(Date.now() - daysAgo * 864e5); return d.toISOString().slice(0, 10); };
      await db.doc('tours/t1').update({ commission: { agent: { mode: 'pct', value: 10 } }, shows: {
        l1: { id: 'l1', date: day(9), city: 'Detroit, MI', venue: 'Saint Andrew\u2019s Hall', loggedAt: 1, income: { guarantee: 2500 }, guaranteeReceived: false },
        l2: { id: 'l2', date: day(8), city: 'Chicago, IL', venue: 'Bottom Lounge', loggedAt: 1, income: { guarantee: 3000 }, guaranteeReceived: false },
        l3: { id: 'l3', date: day(7), city: 'Columbus, OH', venue: 'Newport', loggedAt: 1, income: { guarantee: 2000 }, guaranteeReceived: false },
        l4: { id: 'l4', date: day(6), city: 'Cleveland, OH', venue: 'House of Blues', loggedAt: 1, income: { guarantee: 4100 }, guaranteeReceived: true, guaranteeReceivedAt: day(5), guaranteeDeposit: 4100, guaranteeSeen: 4100 } } });
      H.deposits = [
        { id: 'lump1', date: day(1), amount: 7500, atvenu: false, matched: false, watch: 'guarantees' },
        { id: 'lump2', date: day(1), amount: 6750, atvenu: false, matched: false, watch: 'guarantees' },
        { id: 'lump3', date: day(1), amount: 5100, atvenu: false, matched: false, watch: 'guarantees' }
      ];
      return true;
    },
    followArtist: function (id) { var H = window.__harness; H.artistFollows = (H.artistFollows || []).concat([id]); return Promise.resolve(); },
    unfollowArtist: function (id) { var H = window.__harness; H.artistFollows = (H.artistFollows || []).filter(function (x) { return x !== id; }); return Promise.resolve(); },
    checkedIn: function (tourId, date) { return (window.__harness.checkins || []).indexOf(tourId + '|' + date) >= 0; },
    checkIn: function (tourId, date) { var H = window.__harness; H.checkins = (H.checkins || []).concat([tourId + '|' + date]); return Promise.resolve(); },
    // Bus Check in (0150), in memory: see BUS CHECK IN near LIVE WITHOUT A
    // RESTART. Riders are the joined crew whose row doesn't say ridesBus
    // false; each person's word for today sits in __harness.busStates.
    busOn: function () { return !window.__harness.busOff; },
    busList: function () {
      var H = window.__harness, st = H.busStates || (H.busStates = {});
      var riders = (H.crew || []).filter(function (m) { return m.joined && m.userId && m.ridesBus !== false; });
      return { day: ymd(new Date()), people: riders.map(function (m) {
        var w = st[m.userId];
        return { userId: m.userId, name: m.name, state: w ? w.state : '', at: w ? w.at : null };
      }) };
    },
    busSet: function (tourId, state) {
      var H = window.__harness, st = H.busStates || (H.busStates = {});
      st['u-devin'] = { state: state === 'on' ? 'on' : 'off', at: new Date().toISOString() };
      // As the database does it: everyone on the tour hears a 'bus' poke.
      window.__harness.poke('bus');
      return Promise.resolve();
    },
    // Buyout ticks (0151), in memory: see BUYOUTS near LIVE WITHOUT A
    // RESTART. The rows live in __harness.buyoutTicks; a Crew phone (asCrew)
    // only reads its own, the way the database's policy cuts them.
    buyoutsOn: function () { return !window.__harness.buyoutsOff; },
    buyoutTracks: function (tourId) {
      var H = window.__harness;
      return (H.buyoutTicks || []).filter(function (r) {
        return r.tourId === tourId && (!H.asCrew || r.userId === 'u-devin');
      }).map(function (r) { return { showId: r.showId, userId: r.userId, at: r.at }; });
    },
    buyoutTrack: function (tourId, showId, userId) {
      var H = window.__harness, ticks = H.buyoutTicks || (H.buyoutTicks = []);
      if (H.asCrew) return Promise.reject(new Error('permission'));
      if (!ticks.some(function (r) { return r.tourId === tourId && r.showId === showId && r.userId === userId; })) {
        ticks.push({ tourId: tourId, showId: showId, userId: userId, at: new Date().toISOString() });
      }
      // (0176: the tick settles that person's pings for the show.)
      H.buyoutAskRows = (H.buyoutAskRows || []).filter(function (r) {
        return !(r.tourId === tourId && r.showId === showId && r.userId === userId);
      });
      // As the database does it: the ticked person hears a 'buyout' poke.
      window.__harness.poke('buyout');
      return Promise.resolve();
    },
    buyoutUntrack: function (tourId, showId, userId) {
      var H = window.__harness;
      if (H.asCrew) return Promise.reject(new Error('permission'));
      H.buyoutTicks = (H.buyoutTicks || []).filter(function (r) {
        return !(r.tourId === tourId && r.showId === showId && r.userId === userId);
      });
      window.__harness.poke('buyout');
      return Promise.resolve();
    },
    // Buyout pings (0176), in memory: __harness.buyoutAskRows. A Crew phone
    // reads only its own; a ping is kept only while this account is still
    // untracked on a show with a buyout, and one an hour per show.
    buyoutAsksOn: function () { var H = window.__harness; return !H.buyoutsOff && !H.buyoutAsksOff; },
    buyoutAsks: function (tourId) {
      var H = window.__harness;
      return (H.buyoutAskRows || []).filter(function (r) {
        return r.tourId === tourId && (!H.asCrew || r.userId === 'u-devin');
      }).map(function (r) { return { showId: r.showId, userId: r.userId, at: r.at }; });
    },
    buyoutAskSend: function (tourId, showId) {
      var H = window.__harness, rows = H.buyoutAskRows || (H.buyoutAskRows = []);
      var sh = tours[tourId] && tours[tourId].shows ? tours[tourId].shows[showId] : null;
      var owed = sh && sh.date >= '2026-10-16' && Number(sh.income && sh.income.buyouts) > 0 &&
        !(H.buyoutTicks || []).some(function (r) { return r.tourId === tourId && r.showId === showId && r.userId === 'u-devin'; });
      if (!owed) return Promise.reject(Object.assign(new Error('permission'), { code: 'permission' }));
      var recent = rows.some(function (r) {
        return r.tourId === tourId && r.showId === showId && r.userId === 'u-devin' && Date.now() - Date.parse(r.at) < 3600e3;
      });
      if (!recent) rows.push({ tourId: tourId, showId: showId, userId: 'u-devin', at: new Date().toISOString() });
      window.__harness.poke('buyout');
      return Promise.resolve();
    },
    /* Also in town tonight (0157), in memory: see ALSO IN TOWN TONIGHT near
       FAVORITE LOCAL SPOTS. Answers come from __harness.cityEventRows by
       show id; cityEventsWait counts down {wait} answers so the app's poll
       of the take function is exercised, and cityEventsDark answers {off},
       as with no key in Vault. */
    cityEventsOn: function () { return !window.__harness.cityEventsOff; },
    cityEventsAsk: function (tourId, showId) {
      var H = window.__harness;
      if (H.cityEventsOff) return Promise.reject(new Error('unavailable'));
      if (H.cityEventsDark) return Promise.resolve({ off: true });
      if (H.cityEventsWait > 0) { H.cityEventsWait -= 1; return Promise.resolve({ wait: 7 }); }
      return Promise.resolve({ events: (H.cityEventRows || {})[showId] || [] });
    },
    cityEventsTake: function (reqId, tourId, showId) {
      var H = window.__harness;
      if (H.cityEventsOff) return Promise.reject(new Error('unavailable'));
      if (H.cityEventsDark) return Promise.resolve({ off: true });
      if (H.cityEventsWait > 0) { H.cityEventsWait -= 1; return Promise.resolve({ wait: reqId }); }
      return Promise.resolve({ events: (H.cityEventRows || {})[showId] || [] });
    },
    /* Venue history (0160), in memory: see VENUE HISTORY near ALSO IN TOWN
       TONIGHT. The answer is __harness.venueHistoryRows[showId] (a copy), or
       null for a show with no row, as the real backend answers a tour with
       no artist page or no road history. The last ask is kept in
       __harness.venueHistoryLast. */
    venueHistoryOn: function () { return !window.__harness.venueHistoryOff; },
    venueHistory: function (tourId, showId, sig) {
      var H = window.__harness;
      if (H.venueHistoryOff) return null;
      H.venueHistoryLast = { tourId: tourId, showId: showId, sig: String(sig || '') };
      var r = (H.venueHistoryRows || {})[showId];
      return r ? JSON.parse(JSON.stringify(r)) : null;
    },
    /* The green check for a list of people (0161), in memory: see THE GREEN
       CHECK EVERYWHERE near VENUE HISTORY. Answers are held in
       __harness.checksHeld the way the real backend holds them; an id
       another list is still waiting on is waited on, not asked twice; at
       most 200 ids go in one ask; each ask is kept in __harness.checkAsks. */
    personChecksOn: function () { return !window.__harness.checksOff; },
    personChecked: function (uid) {
      var H = window.__harness, held = H.checksHeld || {};
      return !H.checksOff && uid && Object.prototype.hasOwnProperty.call(held, uid) ? held[uid] : undefined;
    },
    personChecks: function (uids) {
      var H = window.__harness;
      if (H.checksOff) return Promise.resolve(false);
      if (!H.checks) H.checks = { 'u-devin': true, 'u-brent': true, 'u-ana': true, 'u-fan2': true };
      H.checksHeld = H.checksHeld || {}; H.checksAsking = H.checksAsking || {};
      var need = [], waits = [];
      (Array.isArray(uids) ? uids : []).forEach(function (u) {
        if (!u || need.indexOf(u) >= 0 || Object.prototype.hasOwnProperty.call(H.checksHeld, u)) return;
        if (H.checksAsking[u]) { if (waits.indexOf(H.checksAsking[u]) < 0) waits.push(H.checksAsking[u]); return; }
        need.push(u);
      });
      for (var i = 0; i < need.length; i += 200) (function (ids) {
        H.checkAsks = (H.checkAsks || []).concat([ids]);
        var late = Number(H.checksLate) || 0;
        var p = new Promise(function (res) { setTimeout(res, late); }).then(function () {
          ids.forEach(function (u) { H.checksHeld[u] = !!H.checks[u]; if (H.checksAsking[u] === p) delete H.checksAsking[u]; });
        });
        ids.forEach(function (u) { H.checksAsking[u] = p; });
        waits.push(p);
      })(need.slice(i, i + 200));
      return waits.length ? Promise.all(waits).then(function () { return true; }) : Promise.resolve(false);
    },
    /* Supplies (0155), in memory: see SUPPLIES near LIVE WITHOUT A RESTART.
       The rows live in __harness.supplyRows; anyone ticks, but the words and
       the delete of someone else's line refuse with the database's own plain
       words (code 'said') unless this phone is a Manager (not ?crew), the
       way the trigger and the delete policy cut them. */
    suppliesOn: function () { return !window.__harness.suppliesOff; },
    supplies: function (tourId) {
      var H = window.__harness;
      return (H.supplyRows || []).filter(function (r) { return r.tourId === tourId; })
        .map(function (r) { return { id: r.id, body: r.body, addedBy: r.addedBy, doneAt: r.doneAt, doneBy: r.doneBy, at: r.at }; });
    },
    supplyAdd: function (tourId, body) {
      var H = window.__harness, rows = H.supplyRows || (H.supplyRows = []);
      var words = String(body == null ? '' : body).replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!words) return Promise.reject(new Error('unavailable'));
      if (rows.filter(function (r) { return r.tourId === tourId && !r.doneAt; }).length >= 200) {
        return Promise.reject(Object.assign(new Error('This tour’s supplies list is full. Tick things off or delete old lines first.'), { code: 'said' }));
      }
      var row = { id: 'sp' + Date.now() + Math.floor(Math.random() * 1000), tourId: tourId, body: words,
        addedBy: 'u-devin', doneAt: null, doneBy: null, at: new Date().toISOString() };
      rows.push(row);
      window.__harness.poke('supply');
      return Promise.resolve(row.id);
    },
    supplyTick: function (id, on) {
      var H = window.__harness;
      (H.supplyRows || []).forEach(function (r) {
        if (r.id === id) { r.doneAt = on ? new Date().toISOString() : null; r.doneBy = on ? 'u-devin' : null; }
      });
      window.__harness.poke('supply');
      return Promise.resolve();
    },
    supplySave: function (id, body) {
      var H = window.__harness;
      var r = (H.supplyRows || []).filter(function (x) { return x.id === id; })[0];
      if (!r) return Promise.reject(Object.assign(new Error('permission'), { code: 'permission' }));
      if (r.addedBy !== 'u-devin' && H.asCrew) {
        return Promise.reject(Object.assign(new Error('Only whoever added a line, or a Manager, can change its words.'), { code: 'said' }));
      }
      r.body = String(body == null ? '' : body).replace(/\s+/g, ' ').trim().slice(0, 120) || r.body;
      window.__harness.poke('supply');
      return Promise.resolve();
    },
    supplyDrop: function (id) {
      var H = window.__harness;
      var r = (H.supplyRows || []).filter(function (x) { return x.id === id; })[0];
      if (!r) return Promise.reject(Object.assign(new Error('permission'), { code: 'permission' }));
      if (r.addedBy !== 'u-devin' && H.asCrew) return Promise.reject(Object.assign(new Error('permission'), { code: 'permission' }));
      H.supplyRows = (H.supplyRows || []).filter(function (x) { return x.id !== id; });
      window.__harness.poke('supply');
      return Promise.resolve();
    },
    /* To Do Lists (0152), in memory: see TO DO LISTS near LIVE WITHOUT A
       RESTART. The rows live in __harness.todoItems and __harness.todoInvites;
       who may see a list follows the database's rule (todoCanSee above), so
       todoList answers null for a page none of the test person's business
       and the app draws no To Do List tab there. */
    todosOn: function () { return !window.__harness.todosOff; },
    todoList: function (artistId) {
      var H = window.__harness;
      if (H.todosOff || !todoCanSee(artistId)) return null;
      return (H.todoItems || []).filter(function (r) { return r.artistId === artistId; }).map(todoOut);
    },
    todoInvites: function (artistId) {
      var H = window.__harness;
      if (H.todosOff || !todoCanSee(artistId)) return null;
      // An invited person is handed their own row only, the way the policy cuts them.
      var runs = (H.acts || []).some(function (a) { return a.id === artistId && (!a.notMine ||
        (a.members || []).some(function (m) { return m.userId === 'u-devin' && m.kind === 'band' && !m.leftAt; })); });
      return (H.todoInvites || []).filter(function (v) { return v.artistId === artistId && (runs || v.userId === 'u-devin'); })
        .map(function (v) { return { userId: v.userId, name: todoName(v.userId), invitedBy: v.invitedBy, at: v.at }; });
    },
    todoAdd: function (artistId, cat, body, more) {
      var H = window.__harness, m = more || {};
      // The database's cap, word for word.
      if ((H.todoItems || []).filter(function (r) { return r.artistId === artistId && !r.doneAt; }).length >= 500) {
        return Promise.reject(Object.assign(new Error('This list already holds 500 tasks not done. Tick some off or delete some first.'), { code: 'full' }));
      }
      H.todoItems = H.todoItems || [];
      var id = H.todoNext || 100;
      H.todoNext = id + 1;
      var row = { id: id, artistId: artistId, cat: cat || 'other', body: String(body || '').slice(0, 300),
        assignedTo: m.assignedTo || null, due: m.due || null, doneAt: null, createdBy: 'u-devin', createdAt: new Date().toISOString() };
      H.todoItems.push(row);
      // As the database does it: a task handed to somebody pokes their phone
      // with 'todo' (never the hand that wrote it).
      if (row.assignedTo && row.assignedTo !== 'u-devin') window.__harness.poke('todo');
      return Promise.resolve(id);
    },
    todoSave: function (id, patch) {
      var H = window.__harness, p = patch || {};
      var row = (H.todoItems || []).filter(function (r) { return r.id === id; })[0];
      if (!row) return Promise.reject(Object.assign(new Error('permission'), { code: 'permission' }));
      var was = row.assignedTo;
      if ('done' in p) row.doneAt = p.done ? new Date().toISOString() : null;
      if ('body' in p) row.body = String(p.body || '').slice(0, 300);
      if ('cat' in p) row.cat = p.cat || 'other';
      if ('assignedTo' in p) row.assignedTo = p.assignedTo || null;
      if ('due' in p) row.due = p.due || null;
      if (row.assignedTo && row.assignedTo !== was && row.assignedTo !== 'u-devin') window.__harness.poke('todo');
      return Promise.resolve();
    },
    todoDrop: function (id) {
      var H = window.__harness;
      H.todoItems = (H.todoItems || []).filter(function (r) { return r.id !== id; });
      return Promise.resolve();
    },
    todoInvite: function (artistId, userId) {
      var H = window.__harness;
      H.todoInvites = H.todoInvites || [];
      if (!H.todoInvites.some(function (v) { return v.artistId === artistId && v.userId === userId; })) {
        H.todoInvites.push({ artistId: artistId, userId: userId, invitedBy: 'u-devin', at: new Date().toISOString() });
      }
      return Promise.resolve();
    },
    todoUninvite: function (artistId, userId) {
      var H = window.__harness;
      H.todoInvites = (H.todoInvites || []).filter(function (v) { return !(v.artistId === artistId && v.userId === userId); });
      return Promise.resolve();
    },
    // What the database's policy hands the profile tab: every task of the
    // lists this account may see, plus any task handed to it elsewhere.
    myTodos: function () {
      var H = window.__harness;
      if (H.todosOff) return null;
      var actName = function (artistId) {
        var a = (H.acts || []).filter(function (x) { return x.id === artistId; })[0];
        return a ? a.name : 'Artist';
      };
      return (H.todoItems || []).filter(function (r) { return todoCanSee(r.artistId) || r.assignedTo === 'u-devin'; })
        .map(function (r) { var it = todoOut(r); it.artistName = actName(r.artistId); return it; });
    },
    /* Favorite Local Spots (0153), in memory: see FAVORITE LOCAL SPOTS near
       TO DO LISTS. The rows live in __harness.spotRows; the test person's
       account is u-devin, and tourSpots keys the day's city the way the app
       does (GR.roadCityKey), so what matches here matches the real table. */
    spotsOn: function () { return !window.__harness.spotsOff; },
    mySpots: function () {
      var H = window.__harness;
      if (H.spotsOff) return null;
      return (H.spotRows || []).filter(function (r) { return r.userId === 'u-devin'; }).map(spotOut);
    },
    spotAdd: function (p) {
      var H = window.__harness, q = p || {};
      H.spotRows = H.spotRows || [];
      var id = H.spotNext || 100;
      H.spotNext = id + 1;
      var row = { id: id, userId: 'u-devin', tourId: q.tourId || null, city: String(q.city || '').slice(0, 60),
        name: String(q.name || '').slice(0, 80), kind: q.kind || 'other', note: String(q.note || '').slice(0, 240),
        createdAt: new Date().toISOString() };
      spotWhere(row, q);
      H.spotRows.push(row);
      return Promise.resolve(id);
    },
    spotSave: function (id, patch) {
      var H = window.__harness, p = patch || {};
      var row = (H.spotRows || []).filter(function (r) { return r.id === id && r.userId === 'u-devin'; })[0];
      if (!row) return Promise.reject(Object.assign(new Error('permission'), { code: 'permission' }));
      if ('city' in p) row.city = String(p.city || '').slice(0, 60);
      if ('name' in p) row.name = String(p.name || '').slice(0, 80);
      if ('kind' in p) row.kind = p.kind || 'other';
      if ('note' in p) row.note = String(p.note || '').slice(0, 240);
      if ('tourId' in p) row.tourId = p.tourId || null;
      spotWhere(row, p);
      return Promise.resolve();
    },
    spotDrop: function (id) {
      var H = window.__harness;
      H.spotRows = (H.spotRows || []).filter(function (r) { return !(r.id === id && r.userId === 'u-devin'); });
      return Promise.resolve();
    },
    tourSpots: function (tourId, cityKey) {
      var H = window.__harness;
      if (H.spotsOff) return null;
      return (H.spotRows || []).filter(function (r) {
        return r.tourId === tourId && window.GR.roadCityKey(String(r.city).split(',')[0]) === cityKey;
      }).map(function (r) {
        var it = spotOut(r);
        it.userId = r.userId;
        // Who recommends it, by first name, the way the real read answers.
        it.who = (todoName(r.userId) || 'Someone').split(' ')[0];
        return it;
      });
    },
    /* Spot cards (0175), in memory: see SPOT CARDS under FAVORITE LOCAL
       SPOTS. spotDetails answers the way the live road does: at once with
       what the spot is, then (the first open of a spot in a session) after
       __harness.spotDetailsBeat ms with where it is (found in
       __harness.placeRows by exact name in its own town when it did not
       know) and the map's details from __harness.placeDetails. */
    spotDetailsOn: function () { return !window.__harness.spotDetailsOff; },
    spotDetails: function (id, cb, face) {
      var H = window.__harness;
      (H.spotDetailAsks = H.spotDetailAsks || []).push({ id: id, face: !!face });
      if (H.spotDetailsOff) { cb(null); return; }
      var row = (H.spotRows || []).filter(function (r) { return r.id === id; })[0] ||
        (H.followSpotRows || []).filter(function (r) { return r.id === id; })[0];
      if (!row) { cb(null); return; }
      var answer = function (waiting) {
        var o = { spot: { id: id, lat: typeof row.lat === 'number' ? row.lat : null, lon: typeof row.lon === 'number' ? row.lon : null,
          address: row.address || '', osmRef: row.osmRef || '' }, userId: row.userId,
          who: row.who || todoName(row.userId) || 'Someone', waiting: waiting };
        if (face) o.avatar = (H.faces && H.faces[row.userId]) || '';
        var d = !waiting && row.osmRef && H.placeDetails && H.placeDetails[row.osmRef];
        if (d) o.details = JSON.parse(JSON.stringify(d));
        else if (!waiting && row.osmRef) o.details = {};
        return o;
      };
      H.spotDetailSeen = H.spotDetailSeen || {};
      var beat = H.spotDetailsBeat == null ? 600 : H.spotDetailsBeat;
      if (H.spotDetailSeen[id] || !beat) { H.spotDetailSeen[id] = true; spotFind(row); cb(answer(false)); return; }
      H.spotDetailSeen[id] = true;
      cb(answer(true));
      setTimeout(function () { spotFind(row); cb(answer(false)); }, beat);
    },
    /* Spots ride the following (0169), in memory: see SPOTS FROM PEOPLE YOU
       FOLLOW under FAVORITE LOCAL SPOTS. __harness.followSpotRows play the
       live function's own answer; followSpots(near) hands back the rows
       whose town is the words before near's comma (the live matching rule),
       newest first, the answer's shape exactly. */
    followSpotsOn: function () { return !window.__harness.followSpotsOff; },
    followSpots: function (near) {
      var H = window.__harness;
      if (H.followSpotsOff) return null;
      var k = window.GR.roadCityKey(String(near || '').split(',')[0]);
      if (!k) return [];
      return (H.followSpotRows || []).filter(function (r) {
        return window.GR.roadCityKey(String(r.city).split(',')[0]) === k;
      }).slice().sort(function (a, b) {
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      }).map(function (r) {
        var it = { userId: r.userId, who: r.who || 'Someone', city: r.city, name: r.name, kind: r.kind || 'other', note: r.note || '' };
        // Since 0175: which spot it is, and where when known.
        if (r.id != null) it.id = r.id;
        if (typeof r.lat === 'number' && typeof r.lon === 'number') { it.lat = r.lat; it.lon = r.lon; }
        if (r.address) it.address = r.address;
        if (r.osmRef) it.osmRef = r.osmRef;
        return it;
      });
    },
    /* Finding places as you type (0164, near a town since 0166), in memory:
       see FINDING PLACES AS YOU TYPE under FAVORITE LOCAL SPOTS. Answers
       come from __harness.placeRows (each row carrying its street), matched
       on the typed words against the name, up to eight, after a wire's
       beat. `near` is honored the way the server leans to a town: rows
       whose city matches near's first words lead the list, the rest follow.
       The last ask is kept in __harness.placeAsks ([{ q, near }]), so a
       check can see what the sheet really sent. */
    placeSearchOn: function () {
      var H = window.__harness;
      if (H.placesOff) return false;
      // ?placeslow: the real backend's probe takes a beat on a fresh
      // session; this mimics it so the first-open race stays visible.
      return !(H.placesReadyAt && Date.now() < H.placesReadyAt);
    },
    placeSearch: function (q, near, cb) {
      if (typeof near === 'function') { cb = near; near = ''; }
      var H = window.__harness;
      var qk = String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
      var nk = String(near || '').split(',')[0].toLowerCase().replace(/\s+/g, ' ').trim();
      (H.placeAsks = H.placeAsks || []).push({ q: qk, near: String(near || '') });
      if (H.placesOff || qk.length < 2) { cb([]); return; }
      if (H.placesReadyAt && Date.now() < H.placesReadyAt) {
        // The real backend waits its probe out rather than answering
        // nothing; the stub does the same.
        var me = this;
        setTimeout(function () { me.placeSearch(q, near, cb); }, 250);
        return;
      }
      var rows = (H.placeRows || []).filter(function (p) {
        return String(p.name || '').toLowerCase().indexOf(qk) !== -1;
      });
      if (nk) {
        var here = rows.filter(function (p) { return String(p.city || '').toLowerCase() === nk; });
        rows = here.concat(rows.filter(function (p) { return here.indexOf(p) < 0; }));
      }
      rows = rows.slice(0, 8);
      setTimeout(function () { cb(JSON.parse(JSON.stringify(rows))); }, 250);
    },
    newGiftId: function () { return 'g' + Date.now() + Math.random().toString(36).slice(2, 6); },
    giveFlowers: function (tourId, uid, n, note, rid, cat) {
      var H = window.__harness, d = window.GR_BACKEND.flowersFor(tourId);
      if (H.flowers.some(function (x) { return x.id === rid; })) return Promise.resolve({ left: d.left });
      if (n > d.left) { var e = new Error('none-left'); e.code = 'none-left'; return Promise.reject(e); }
      H.flowers.push({ id: rid, tour: tourId, from: 'u-devin', to: uid, n: n, note: String(note || '').trim().slice(0, 100), category: cat || '', at: new Date().toISOString() });
      return Promise.resolve({ left: d.left - n });
    },
    takeBackFlowers: function (tourId, id) {
      window.__harness.flowers = window.__harness.flowers.filter(function (x) { return x.id !== id; });
      return Promise.resolve();
    },
    // The calendar, in memory: polls, votes, special requests.
    pollFor: function (tourId, date) {
      var p = (window.__harness.polls || []).filter(function (x) { return x.tour_id === tourId && x.date === date; })[0];
      return p ? { date: p.date, options: p.options, closesAt: p.closes_at, createdAt: p.created_at } : null;
    },
    votesFor: function (tourId, date) {
      return (window.__harness.votes || []).filter(function (v) { return v.tour_id === tourId && v.date === date; })
        .map(function (v) { return { userId: v.user_id, choice: v.choice, name: v.name }; });
    },
    requestsFor: function (tourId, date) {
      return (window.__harness.requests || []).filter(function (r) { return r.tour_id === tourId && r.date === date; })
        .map(function (r) { return { id: r.id, body: r.body, author: r.author, mine: r.added_by === 'u-devin', status: r.status || 'pending', at: r.created_at }; });
    },
    savePoll: function (tourId, date, options, closesAt) {
      var H = window.__harness; H.polls = (H.polls || []).filter(function (x) { return !(x.tour_id === tourId && x.date === date); });
      H.polls.push({ tour_id: tourId, date: date, options: options, closes_at: closesAt, created_at: new Date().toISOString() });
      return Promise.resolve();
    },
    deletePoll: function (tourId, date) {
      var H = window.__harness;
      H.polls = (H.polls || []).filter(function (x) { return !(x.tour_id === tourId && x.date === date); });
      H.votes = (H.votes || []).filter(function (x) { return !(x.tour_id === tourId && x.date === date); });
      return Promise.resolve();
    },
    vote: function (tourId, date, choice) {
      var H = window.__harness;
      var p = (H.polls || []).filter(function (x) { return x.tour_id === tourId && x.date === date; })[0];
      if (!p || Date.parse(p.closes_at) <= Date.now()) return Promise.reject(new Error('closed'));
      H.votes = (H.votes || []).filter(function (x) { return !(x.tour_id === tourId && x.date === date && x.user_id === 'u-devin'); });
      H.votes.push({ tour_id: tourId, date: date, user_id: 'u-devin', choice: choice, name: 'Devin Oliver' });
      return Promise.resolve();
    },
    addRequest: function (tourId, date, body) {
      var H = window.__harness;
      H.requests = (H.requests || []).concat([{ id: 'rq' + Date.now(), tour_id: tourId, date: date, body: body, author: 'Devin Oliver',
        added_by: 'u-devin', status: 'pending', created_at: new Date().toISOString() }]);
      H.notified = (H.notified || []).concat([['request', tourId, date, body]]);
      return Promise.resolve();
    },
    answerRequest: function (id, status) {
      (window.__harness.requests || []).forEach(function (r) { if (r.id === id) r.status = status; });
      return Promise.resolve();
    },
    deleteRequest: function (id) {
      window.__harness.requests = (window.__harness.requests || []).filter(function (r) { return r.id !== id; });
      return Promise.resolve();
    },
    /* Reimbursements, in memory: __harness.reimb, rows in the app's own shape.
       Seeded on the harness tour with two asks waiting (Brent's is the same
       amount as the Buc-Ee's charge in the card pile, so the sorting sheet has
       a match to show) and one already paid back in cash. A write re-sends the
       tours, as the real backend's re-read does, so every page follows.
       __harness.reimbFail = 'role' (or any why) makes the four writes answer
       that; __harness.reimbLost = true lets a write land and loses its answer;
       __harness.reimbCalls keeps what was asked. With __harness.asCrew
       the list is only your own asks and the Manager's writes are refused,
       like the database. An ask keeps the id it is sent with: the same id
       again is the same ask (ok, nothing added), and an id that is another
       tour's or another person's ask answers 'id'. */
    reimbursementsFor: function (tourId) {
      var H = window.__harness;
      return reimbList().filter(function (r) { return r.tourId === tourId && (!H.asCrew || r.mine); })
        .map(function (r) { return JSON.parse(JSON.stringify(r)); })
        .sort(function (a, b) { return String(a.createdAt || '').localeCompare(String(b.createdAt || '')); });
    },
    reimburseAsk: function (tourId, ask) {
      var H = window.__harness, a = ask || {};
      H.reimbCalls = (H.reimbCalls || []).concat([['ask', tourId, JSON.parse(JSON.stringify(a))]]);
      return reimbAnswer(function () {
        var amount = Math.round(Number(a.amount) * 100) / 100, what = String(a.what || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        if (!tours[tourId] || tours[tourId].deletedAt || tours[tourId].kind === 'offtour') return { ok: false, why: 'tour' };
        if (!(amount > 0) || amount > 10000) return { ok: false, why: 'amount' };
        if (!what) return { ok: false, why: 'what' };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.date || ''))) return { ok: false, why: 'date' };
        if (a.id != null && a.id !== '' && !/^[A-Za-z0-9_-]{6,40}$/.test(String(a.id))) return { ok: false, why: 'id' };
        var id = a.id ? String(a.id) : 'rb-' + Date.now().toString(36) + '-' + reimbList().length;
        var same = reimbList().filter(function (x) { return x.id === id; })[0];
        if (same) return same.mine && same.tourId === tourId ? { ok: true, id: id } : { ok: false, why: 'id' };
        reimbList().push({ id: id, tourId: tourId, mine: true, name: 'Devin Oliver', amount: amount, what: what, date: a.date, status: 'open',
          paidAt: null, paidBy: '', how: '', feedId: '', closedBy: '', closedAt: null, createdAt: new Date().toISOString() });
        return { ok: true, id: id };
      });
    },
    reimburseWithdraw: function (id) {
      var H = window.__harness;
      H.reimbCalls = (H.reimbCalls || []).concat([['withdraw', id]]);
      return reimbAnswer(function () {
        var r = reimbList().filter(function (x) { return x.id === id; })[0];
        if (!r || (H.asCrew && !r.mine)) return { ok: false, why: 'gone' };
        if (r.status === 'withdrawn') return { ok: true };
        if (r.status === 'paid') return { ok: false, why: 'paid' };
        r.status = 'withdrawn'; r.closedBy = 'Devin Oliver'; r.closedAt = new Date().toISOString();
        return { ok: true };
      });
    },
    reimburseMark: function (id, paid, how, feedId) {
      var H = window.__harness;
      H.reimbCalls = (H.reimbCalls || []).concat([['mark', id, !!paid, how || '', feedId == null ? '' : String(feedId)]]);
      return reimbAnswer(function () {
        var r = reimbList().filter(function (x) { return x.id === id; })[0];
        if (!r) return { ok: false, why: 'gone' };
        if (H.asCrew) return { ok: false, why: r.mine ? 'role' : 'gone' };
        if (r.status === 'withdrawn') return { ok: false, why: 'gone' };
        if (paid) {
          // (Already paid: who paid and when stand. Only how, or the card charge, is filled in.)
          var was = r.status === 'paid', h2 = ['cash', 'card', 'other'].indexOf(how) >= 0 ? how : '', f2 = feedId == null ? '' : String(feedId);
          if (!was) { r.paidAt = new Date().toISOString(); r.paidBy = 'Devin Oliver'; }
          r.status = 'paid';
          r.how = h2 || (was ? r.how : ''); r.feedId = f2 || (was ? r.feedId : '');
        } else { r.status = 'open'; r.paidAt = null; r.paidBy = ''; r.how = ''; r.feedId = ''; }
        return { ok: true };
      });
    },
    // A Manager puts a taken-off ask back to waiting (one that is not taken off is left as it is).
    reimburseRestore: function (id) {
      var H = window.__harness;
      H.reimbCalls = (H.reimbCalls || []).concat([['restore', id]]);
      return reimbAnswer(function () {
        var r = reimbList().filter(function (x) { return x.id === id; })[0];
        if (!r) return { ok: false, why: 'gone' };
        if (H.asCrew) return { ok: false, why: r.mine ? 'role' : 'gone' };
        if (r.status === 'withdrawn') { r.status = 'open'; r.closedBy = ''; r.closedAt = null; }
        return { ok: true };
      });
    },
    username: function () { return me.username; },
    // __harness.asCrew (or opening the page with ?crew): this phone is Crew on every tour, not its creator.
    // __harness.asManager (or ?manager): a Manager with the tour role Tour Manager on every tour, not its creator.
    ownsTour: function () { return !window.__harness.asCrew && !window.__harness.asManager; },
    myRole: function () { return Promise.resolve(window.__harness.asCrew ? 'viewer' : window.__harness.asManager ? 'editor' : 'owner'); },
    crew: function () {
      window.__harness.crewCalls = (window.__harness.crewCalls || 0) + 1;
      return Promise.resolve(window.__harness.asManager && !window.__harness.asCrew ? crewAsManager() : window.__harness.crew);
    },
    /* Social, in memory. Brent has a profile with a tour you share and one
       you don't; Tasha is still pending, so she has none to open. */
    pushSocial: function (p) { var H = window.__harness; H.social = JSON.parse(JSON.stringify(p)); H.socialPushes = (H.socialPushes || 0) + 1; return Promise.resolve(); },
    handleFree: function (h) { return Promise.resolve(['brent', 'tasha.lane'].indexOf(String(h).toLowerCase()) < 0); },
    setHandle: function (h) {
      if (['brent', 'tasha.lane'].indexOf(String(h).toLowerCase()) >= 0) { var e = new Error('taken'); e.code = 'taken'; return Promise.reject(e); }
      window.__harness.handle = h || ''; return Promise.resolve();
    },
    // What the app asks for. The switches under THE PROFILE NUMBERS (near the top) make the answer fail, come
    // back empty, or come late; with none set it is profileCardNow's answer, at once, as it always was.
    profileCard: function (uid) {
      var H = window.__harness, late = Number(H.cardLate) || 0;
      H.cardAsks = (H.cardAsks || 0) + 1;
      var answer = function () {
        return H.cardFail ? Promise.reject(Object.assign(new Error('offline'), { code: 'offline' }))
          : H.cardEmpty ? Promise.resolve(null) : window.GR_BACKEND.profileCardNow(uid);
      };
      return late > 0 ? new Promise(function (res, rej) { setTimeout(function () { answer().then(res, rej); }, late); }) : answer();
    },
    profileCardNow: function (uid) {
      var H = window.__harness; H.follows = H.follows || [{ a: 'u-brent', b: 'u-devin' }];
      var n = function (f) { return H.follows.filter(f).length; };
      var base = { followers: n(function (x) { return x.b === uid; }), following: n(function (x) { return x.a === uid; }),
        iFollow: H.follows.some(function (x) { return x.a === 'u-devin' && x.b === uid; }),
        followsMe: H.follows.some(function (x) { return x.a === uid && x.b === 'u-devin'; }) };
      var so = H.social || {};
      var names = { 'u-devin': 'Devin Oliver', 'u-brent': 'Brent Allen', 'u-jeff': 'Jeff Mora' };
      window.GR_BACKEND.flowersFor('t1');
      base.gotFlowers = (H.flowers || []).filter(function (x) { return x.to === uid; }).slice().reverse().map(function (x) {
        return { id: x.id, n: x.n, note: x.note, category: x.category || '', at: x.at, from: x.from, name: names[x.from] || '', avatar: '' }; });
      if (uid === 'u-devin') return Promise.resolve(Object.assign({ userId: uid, name: me.full_name, handle: H.handle || '', verified: !H.isNewCrew, bio: so.bio || '', roles: so.roles || [], tourRole: me.tour_role, avatar: so.photo || '', artists: so.artists || [],
        // The pages that list the test Devin (his own included), then the ones that only endorsed him.
        acts: (H.acts || []).filter(function (x) { return x.members.some(function (m) { return m.userId === 'u-devin'; }); }).map(function (x) {
          var m = x.members.filter(function (y) { return y.userId === 'u-devin'; })[0];
          return { id: x.id, name: x.name, handle: x.handle, avatar: x.avatar, kind: m.kind, role: m.role || '', endorsed: !!m.endorsed, mine: true, declined: false, past: m.leftAt ? true : undefined, until: m.leftAt || null }; }).concat(devinActs()),
        flowers: 2, endorsements: devinActs().length + (H.acts || []).filter(function (x) { return x.members.some(function (m) { return m.userId === 'u-devin' && m.endorsed; }); }).length,
        roadStats: H.roadStats || (function () { try { return JSON.parse(localStorage.getItem('gr_h_road') || 'null'); } catch (e) { return null; } })() || (function () { var c = creditSums('u-devin'), nw = H.isNewCrew ? 0 : 1; return { tours: nw + c.tours, shows: 15 * nw + c.shows, countries: nw + (c.shows ? 3 : 0), cities: 15 * nw + c.shows, firstYear: c.first || 2026 }; })(),
        credits: creditSums('u-devin').credits, creditTours: creditSums('u-devin').list,
        // (A brand-new Crew account, ?newcrew: only the tour it has been given a seat on.)
        tours: H.isNewCrew ? (tours.tseat ? [{ id: 'tseat', artist: 'I See Stars', name: 'Seat run', first: inDays(0), last: inDays(3), shows: 3, mine: true }] : [])
          : [{ id: 't1', artist: 'I See Stars', name: 'Harness run', first: '2026-09-27', last: '2026-10-04', shows: 4, mine: true }], logos: {} }, base));
      if (uid === 'u-brent') return Promise.resolve(Object.assign({ userId: uid, name: 'Brent Allen', handle: 'brent', bio: 'Guitars, backline, bad jokes.',
        roles: ['Guitar Tech', 'Stage Manager'], tourRole: 'Guitar Tech', avatar: '', artists: ['Sleeping With Sirens', 'I See Stars'],
        acts: (H.acts || []).filter(function (x) { return x.members.some(function (m) { return m.userId === 'u-brent'; }); }).map(function (x) { var bm = x.members.filter(function (m) { return m.userId === 'u-brent'; })[0]; return { id: x.id, name: x.name, handle: x.handle, avatar: x.avatar, kind: bm.kind, role: bm.role || '', endorsed: !!bm.endorsed, past: bm.leftAt ? true : undefined, until: bm.leftAt || null }; })
          .concat([{ id: null, name: 'Old Band', handle: '', avatar: '', kind: 'crew', endorsed: true, past: true }]),
        flowers: 3, endorsements: 1 + (H.acts || []).filter(function (x) { return x.members.some(function (m) { return m.userId === 'u-brent' && m.endorsed; }); }).length,
        roadStats: (function () { var c = creditSums('u-brent'); return { tours: 2 + c.tours, shows: 43 + c.shows, countries: 2 + (c.shows ? 3 : 0), cities: 38 + c.shows, firstYear: c.first || 2019 }; })(),
        credits: creditSums('u-brent').credits, creditTours: creditSums('u-brent').list,
        tours: [{ id: 't1', artist: 'I See Stars', name: 'Harness run', first: '2026-09-27', last: '2026-10-04', shows: 4, mine: true },
                { id: 'x9', artist: 'Other Band', name: 'Spring Fling', first: '2026-03-02', last: '2026-04-11', shows: 28, mine: false }], logos: {} }, base));
      return Promise.resolve(null);
    },
    followList: function (uid, which) {
      var H = window.__harness; H.follows = H.follows || [{ a: 'u-brent', b: 'u-devin' }];
      var who = { 'u-devin': { name: 'Devin Oliver', verified: true, handle: H.handle || '', roles: [], tourRole: 'Artist' }, 'u-brent': { name: 'Brent Allen', handle: 'brent', roles: ['Guitar Tech', 'Stage Manager'], tourRole: 'Guitar Tech' } };
      return Promise.resolve(H.follows.filter(function (x) { return which === 'following' ? x.a === uid : x.b === uid; }).map(function (x) {
        var o = which === 'following' ? x.b : x.a;
        return Object.assign({ userId: o, avatar: '', canOpen: true, iFollow: H.follows.some(function (y) { return y.a === 'u-devin' && y.b === o; }) }, who[o]);
      }));
    },
    follow: function (uid) { var H = window.__harness; H.follows = (H.follows || []).concat([{ a: 'u-devin', b: uid }]); return Promise.resolve(); },
    unfollow: function (uid) { var H = window.__harness; H.follows = (H.follows || []).filter(function (x) { return !(x.a === 'u-devin' && x.b === uid); }); return Promise.resolve(); },
    tourCard: function (tourId, uid) {
      var H = window.__harness; H.tourCards = (H.tourCards || []).concat([tourId + '|' + uid]);
      if (tourId === 't1') return Promise.resolve({ id: 't1', artist: 'I See Stars', name: 'Harness run', flyer: (H.flyers2 || {}).t1 || '',
        dates: [{ date: '2026-09-27', city: 'Dallas, TX', venue: 'Granada' }, { date: '2026-10-01', city: 'Austin, TX', venue: 'Mohawk' }] });
      if (tourId !== 'x9') return Promise.resolve(null);
      return Promise.resolve({ id: 'x9', artist: 'Other Band', name: 'Spring Fling', flyer: H.flyerX9 || '',
        dates: [{ date: '2026-03-02', city: 'Detroit, MI', venue: 'Saint Andrew’s Hall' }, { date: '2026-03-04', city: 'Chicago, IL', venue: 'Bottom Lounge' }, { date: '2026-04-11', city: 'Anaheim, CA', venue: '' }] });
    },
    /* Every artist, in memory. MB is the pretend encyclopedia; a hit with no
       page gets an unclaimed one when opened, whose history then reads in a
       page per nudge. Sleeping With Sirens starts out as an unclaimed page
       with a claim from Brent waiting, and the test user is a Greenroom
       admin (set __harness.admin = false to see the app without that). */
    mbSearch: function (text) {
      var H = window.__harness, t = String(text || '').trim().toLowerCase();
      H.mbAsks = (H.mbAsks || []).concat([t]);
      if (H.mbDown) return Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
      return new Promise(function (res) { setTimeout(function () {
        res(t.length < 2 ? [] : MB.filter(function (a) { return a.name.toLowerCase().indexOf(t) >= 0; }).slice(0, 8).map(function (a) { return Object.assign({ type: 'Group', score: 100 }, a); }));
      }, 120); });
    },
    openMbArtist: function (mbid, nameHint) {
      var H = window.__harness;
      var has = (H.acts || []).filter(function (a) { return a.mbid === mbid; })[0] || ghostList().filter(function (g) { return g.mbid === mbid; })[0];
      if (has) return Promise.resolve({ id: has.id, made: false });
      if (H.mbTooMany) return Promise.reject(Object.assign(new Error('too-many'), { code: 'too-many' }));
      var m = MB.filter(function (a) { return a.mbid === mbid; })[0] || { name: nameHint || 'Artist', about: '', country: '' };
      // (The real username is random; any twenty hex characters do here.)
      H.ghostSeq = (H.ghostSeq || 1) + 1;
      var g = { id: 'gh' + H.ghostSeq, handle: 'mb.' + ('f00d' + String(mbid).replace(/-/g, '')).slice(0, 20), name: m.name, mbid: mbid,
        about: m.about || '', country: m.country || '', owner: null, checked: false };
      H.ghosts.push(g);
      H.histories = H.histories || {};
      H.histories[g.id] = { artist_id: g.id, status: 'checking', detail: '', total: 0, pages: 0, next_page: 1, synced_at: null, mb_url: '', summary: {}, auto: true };
      return Promise.resolve({ id: g.id, made: true });
    },
    historyNudge: function (artistId, fresh) {
      var H = window.__harness;
      H.nudges = (H.nudges || 0) + 1;
      // (A fresh one is a Refresh from the Tours tab's gear: see THE TOURS TAB'S GEAR.)
      if (fresh) H.freshNudges = (H.freshNudges || 0) + 1;
      return window.GR_BACKEND.artistHistory(artistId).then(function (plain) {
        // (The stored row itself: a nudge moves it along.)
        var row = (H.histories || {})[artistId];
        if (!row || !plain) return null;
        if (!row.auto) return plain;
        // __harness.budgetGone: the day's allowance is used up, so nothing moves.
        if (H.budgetGone && row.status === 'syncing') return Object.assign(JSON.parse(JSON.stringify(row)), { waiting: true });
        var g = ghostList().filter(function (x) { return x.id === artistId; })[0];
        // __harness.checkSlow: the encyclopedia has not answered yet, so a new page stays unchecked
        // (it cannot be claimed, and its shows are "still being read").
        if (H.checkSlow && row.status === 'checking') return JSON.parse(JSON.stringify(row));
        // One step a nudge: confirmed by the encyclopedia, then three pages, then done.
        if (fresh && row.status === 'ok') { row.status = 'syncing'; row.next_page = 1; }
        else if (row.status === 'checking') { row.status = 'syncing'; row.pages = 3; row.total = 58; if (g) g.checked = true; }
        else if (row.status === 'syncing') {
          row.next_page += 1;
          row.summary = { shows: Math.min(58, (row.next_page - 1) * 20), tours: row.next_page - 1, countries: Math.min(4, row.next_page), cities: Math.min(41, (row.next_page - 1) * 15),
            firstYear: 2010, lastYear: 2026, toursList: [{ name: 'Feel Tour', n: 20, first: '2025-03-01', last: '2025-04-12', lineup: 'Our Last Night, The Word Alive, Ashland' }].slice(0, row.next_page - 1) };
          if (row.next_page > 3) { row.status = 'ok'; row.next_page = 0; row.synced_at = new Date().toISOString();
            row.mb_url = 'https://www.setlist.fm/setlists/example.html'; }
        }
        return JSON.parse(JSON.stringify(row));
      });
    },
    // (artistId, { role, note, links: { spotify, instagram, website } }); the old (artistId, note, link) still works.
    // Proof is a link or a note of three letters; the answer carries the code to put in the act's bio.
    claimArtist: function (artistId, o, oldLink) {
      var H = window.__harness; H.claims = H.claims || [];
      (H.frCalls = H.frCalls || []).push({ fn: 'claimArtist', args: [artistId, isObj(o) ? JSON.parse(JSON.stringify(o)) : o, oldLink] });
      var c = isObj(o) ? o : { note: o, link: oldLink };
      var from = isObj(c.links) ? c.links : {}, links = {};
      ['spotify', 'instagram', 'website'].forEach(function (k) { links[k] = String(from[k] || '').trim().slice(0, 200); });
      var note = String(c.note || '').trim().slice(0, 500);
      var link = String(c.link || links.website || links.instagram || links.spotify || '').trim();
      var g = ghostList().filter(function (x) { return x.id === artistId; })[0];
      // (As live: a page the encyclopedia has not confirmed yet cannot be claimed, and says 'taken' too.)
      if (!g || g.owner || !g.checked) return Promise.resolve({ ok: false, why: 'taken' });
      if (!link && note.length < 3) return Promise.reject(Object.assign(new Error('short'), { code: 'short' }));
      H.claims = H.claims.filter(function (x) { return !(x.artistId === artistId && x.userId === 'u-devin'); });
      // (The code is "GR-" and six characters since the review; four before.)
      H.claims.push({ id: 'cl' + Date.now(), artistId: artistId, userId: 'u-devin', note: note, link: link, role: String(c.role || '').trim().slice(0, 40),
        links: links, code: 'GR-T3ST9K', status: 'pending', at: new Date().toISOString() });
      return Promise.resolve({ ok: true, code: 'GR-T3ST9K' });
    },
    withdrawClaim: function (artistId) {
      var H = window.__harness, n = (H.claims || []).length;
      H.claims = (H.claims || []).filter(function (c) { return !(c.artistId === artistId && c.userId === 'u-devin' && c.status === 'pending'); });
      return Promise.resolve({ ok: H.claims.length < n });
    },
    myClaims: function () {
      var H = window.__harness;
      return Promise.resolve((H.claims || []).filter(function (c) { return c.userId === 'u-devin'; }).map(function (c) {
        var g = ghostList().filter(function (x) { return x.id === c.artistId; })[0] || {};
        // (0134: each claim carries the role and links it was sent with, and the code to put in the act's bio.)
        return { artistId: c.artistId, artist: g.name || '', status: c.status, at: c.at, role: c.role || '',
          links: Object.assign({ spotify: '', instagram: '', website: '' }, c.links || {}), code: c.code || '', mine: false }; }));
    },
    claimQueue: function () {
      var H = window.__harness, P = window.GR_BACKEND.people;
      ghostList();
      if (H.admin === false) return Promise.resolve(null);
      return Promise.resolve((H.claims || []).filter(function (c) { return c.status === 'pending'; }).map(function (c) {
        var g = H.ghosts.filter(function (x) { return x.id === c.artistId; })[0] || {}, p = P[c.userId] || {};
        return { id: c.id, artistId: c.artistId, artist: g.name || '', about: g.about || '', country: g.country || '', userId: c.userId,
          name: p.name || 'Devin Oliver', handle: c.userId === 'u-devin' ? (H.handle || '') : (p.handle || ''), avatar: '', roles: p.roles || [], tourRole: p.tourRole || '',
          email: c.userId === 'u-brent' ? 'brent@example.com' : 'devin@example.com', note: c.note, link: c.link, at: c.at,
          role: c.role || '', links: Object.assign({ spotify: '', instagram: '', website: '' }, c.links || {}), code: c.code || '',
          others: H.claims.filter(function (o) { return o.artistId === c.artistId && o.status === 'pending' && o.id !== c.id; }).length };
      }));
    },
    decideClaim: function (claimId, approve) {
      var H = window.__harness, c = (H.claims || []).filter(function (x) { return x.id === claimId; })[0];
      H.decided = (H.decided || []).concat([{ id: claimId, approve: !!approve }]);
      if (!c || c.status !== 'pending') return Promise.resolve({ ok: false, why: 'gone' });
      if (!approve) { c.status = 'declined'; return Promise.resolve({ ok: true }); }
      var g = H.ghosts.filter(function (x) { return x.id === c.artistId; })[0];
      if (!g || g.owner) { c.status = 'declined'; return Promise.resolve({ ok: false, why: 'taken' }); }
      c.status = 'approved';
      H.claims.forEach(function (o) { if (o.artistId === c.artistId && o.id !== c.id && o.status === 'pending') o.status = 'declined'; });
      var slug = g.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
      // As on the server: no usable name (too short, or taken) keeps the machine username.
      if (slug.length < 3 || (H.acts || []).some(function (a) { return a.handle === slug; })) slug = g.handle;
      if (c.userId === 'u-devin') {
        // Theirs now: it moves in with the pages the test user runs, history and all.
        H.ghosts = H.ghosts.filter(function (x) { return x.id !== g.id; });
        H.acts = H.acts || [];
        // (0147) Crew listed while nobody ran it come with it, still waiting on the new owner's answer (H.joined).
        H.acts.push({ id: g.id, handle: slug, name: g.name, avatar: '', bio: '', mbid: g.mbid, verified: true, about: g.about, country: g.country,
          members: ((H.ghostCrew || {})[g.id] || []).filter(function (m) { return m.userId !== 'u-devin'; }).map(function (m) { return Object.assign({}, m); }) });
        H.joined = (H.joined || []).filter(function (j) { return !(j.artistId === g.id && j.userId === 'u-devin'); });
      } else { g.owner = c.userId; g.handle = slug; }
      return Promise.resolve({ ok: true });
    },
    /* Artist profiles, in memory. Searchable accounts: Brent, plus two people
       you don't tour with (found by @username only). */
    allowSignup: function (addr) { var H = window.__harness; H.allowed = (H.allowed || []).concat([String(addr).toLowerCase()]); return Promise.resolve({ ok: true }); },
    deleteAccount: function () { var H = window.__harness; H.deleted = true; return Promise.resolve(H.deleteWhy ? { ok: false, why: H.deleteWhy, n: 1 } : { ok: true }); },
    // Each crew member's road story: Devin a lifer, Brent a few years in.
    roadTiers: function () {
      return Promise.resolve([{ userId: 'u-devin', shows: 736, tours: 33, countries: 33, cities: 266 },
        { userId: 'u-brent', shows: 120, tours: 6, countries: 2, cities: 80 }]);
    },
    myArtists: function () {
      var H = window.__harness; H.acts = H.acts || [];
      // (notMine: a page somebody else runs, see issPage. It is in this list only while the test person is listed on it.)
      return Promise.resolve(H.acts.filter(function (a) { return !a.notMine || listedOn(a.id, 'u-devin'); }).map(function (a) {
        // (askMembers, see artistSide: the real list says how a page you run lists you too, which is what the app
        // goes by to leave a Member out of the asks. Without that switch a page you run says nothing here, as before.)
        var m = a.notMine || H.askMembers ? a.members.filter(function (y) { return y.userId === 'u-devin' && !y.leftAt; })[0] : null;
        return { id: a.id, handle: a.handle, name: a.name, avatar: a.avatar, mine: !a.notMine, kind: m ? m.kind : null }; }));
    },
    /* Venues and festivals (0134). findPlaces answers from a few pretend
       places with shows on record; a place becomes a page only when it is
       opened, and those are kept in __harness.places as { id: 'v1' | 'f1'...,
       kind: 'venue' | 'festival', name, city, cc }. Who said they worked
       there is in __harness.placeWork as { kind, id, userId, role, state }.
       __harness.placesDown = true makes the search fail. */
    findPlaces: function (q) {
      var H = window.__harness, t = String(q || '').trim().toLowerCase();
      (H.frCalls = H.frCalls || []).push({ fn: 'findPlaces', args: [q] });
      var venues = [
        { name: 'Mohawk', city: 'Austin', region: 'TX', cc: 'US', nights: 41, artists: 37 },
        { name: 'Saint Andrew’s Hall', city: 'Detroit', region: 'MI', cc: 'US', nights: 63, artists: 52 },
        { name: 'House of Blues', city: 'Cleveland', region: 'OH', cc: 'US', nights: 88, artists: 70 },
        { name: 'House of Blues', city: 'Lake Buena Vista', region: 'FL', cc: 'US', nights: 54, artists: 49 },
        { name: 'O2 Academy Brixton', city: 'London', region: '', cc: 'GB', nights: 1, artists: 1 }];
      var fests = [{ name: 'Vans Warped Tour', editions: 12, artists: 240 }, { name: 'Download Festival', editions: 6, artists: 180 },
        { name: 'Austin City Limits', editions: 1, artists: 30 }];
      if (H.placesDown) return Promise.reject(Object.assign(new Error('offline'), { code: 'offline' }));
      if (t.length < 2) return Promise.resolve({ venues: [], festivals: [] });
      return new Promise(function (res) { setTimeout(function () {
        res({ venues: venues.filter(function (v) { return v.name.toLowerCase().indexOf(t) >= 0 || v.city.toLowerCase().indexOf(t) >= 0; }),
          festivals: fests.filter(function (f) { return f.name.toLowerCase().indexOf(t) >= 0; }) });
      }, 80); });
    },
    openVenue: function (name, city, cc) {
      var H = window.__harness; H.places = H.places || [];
      (H.frCalls = H.frCalls || []).push({ fn: 'openVenue', args: [name, city, cc] });
      var same = function (p) { return p.kind === 'venue' && p.name === String(name || '') && p.city === String(city || '') && p.cc === String(cc || ''); };
      var p = H.places.filter(same)[0];
      if (!p) {
        p = { id: 'v' + (H.places.filter(function (x) { return x.kind === 'venue'; }).length + 1), kind: 'venue', name: String(name || ''), city: String(city || ''), cc: String(cc || '') };
        H.places.push(p);
      }
      return Promise.resolve({ id: p.id });
    },
    openFestival: function (name) {
      var H = window.__harness; H.places = H.places || [];
      (H.frCalls = H.frCalls || []).push({ fn: 'openFestival', args: [name] });
      var p = H.places.filter(function (x) { return x.kind === 'festival' && x.name === String(name || ''); })[0];
      if (!p) {
        p = { id: 'f' + (H.places.filter(function (x) { return x.kind === 'festival'; }).length + 1), kind: 'festival', name: String(name || ''), city: '', cc: '' };
        H.places.push(p);
      }
      return Promise.resolve({ id: p.id });
    },
    placeWorkAsk: function (o) {
      var H = window.__harness; o = o || {};
      (H.frCalls = H.frCalls || []).push({ fn: 'placeWorkAsk', args: [JSON.parse(JSON.stringify(o))] });
      if (H.placeTooMany) return Promise.reject(Object.assign(new Error('too-many'), { code: 'too-many' }));
      var kind = o.venueId ? 'venue' : 'festival', id = o.venueId || o.festivalId;
      H.placeWork = (H.placeWork || []).filter(function (w) { return !(w.kind === kind && w.id === id && w.userId === 'u-devin'); })
        .concat([{ kind: kind, id: id, userId: 'u-devin', role: String(o.role || '').trim().slice(0, 40), state: 'pending' }]);
      return Promise.resolve({ ok: true });
    },
    placeWorkWithdraw: function (o) {
      var H = window.__harness; o = o || {};
      (H.frCalls = H.frCalls || []).push({ fn: 'placeWorkWithdraw', args: [JSON.parse(JSON.stringify(o))] });
      var kind = o.venueId ? 'venue' : 'festival', id = o.venueId || o.festivalId;
      H.placeWork = (H.placeWork || []).filter(function (w) { return !(w.kind === kind && w.id === id && w.userId === 'u-devin'); });
      return Promise.resolve({ ok: true });
    },
    myPlaces: function () {
      var H = window.__harness;
      return Promise.resolve((H.placeWork || []).filter(function (w) { return w.userId === 'u-devin'; }).map(function (w) {
        var p = (H.places || []).filter(function (x) { return x.kind === w.kind && x.id === w.id; })[0] || {};
        return { kind: w.kind, id: w.id, name: p.name || '', city: p.city || '', role: w.role, state: w.state };
      }));
    },
    /* Asking an artist to list you (0134). The asks are kept in
       __harness.artistRequests as { artistId, userId, kind, role, state, at }.
       The test user runs every test artist, so asking one of those lists them
       at once (or says 'listed' when they are on it already); a page nobody
       runs keeps the ask waiting. __harness.requestWhy = 'wait' | 'many' |
       'former_member' makes the next ask come back refused that way. */
    requestArtist: function (artistId, kind, role) {
      var H = window.__harness; (H.frCalls = H.frCalls || []).push({ fn: 'requestArtist', args: [artistId, kind, role] });
      H.artistRequests = H.artistRequests || [];
      // (0146: one role or several joined with ", ", 160 characters.)
      var k = kind === 'crew' ? 'crew' : 'band', r = String(role || '').trim().slice(0, 160);
      var a = (H.acts || []).filter(function (x) { return x.id === artistId; })[0];
      if (a && a.members.some(function (m) { return m.userId === 'u-devin' && !m.leftAt; })) return Promise.resolve({ ok: false, why: 'listed' });
      if (H.requestWhy) return Promise.resolve({ ok: false, why: H.requestWhy });
      var waiting = H.artistRequests.filter(function (x) { return x.userId === 'u-devin' && x.state === 'pending' && x.artistId !== artistId; });
      if (waiting.length >= 10) return Promise.resolve({ ok: false, why: 'many' });
      if (a) {
        a.members = a.members.filter(function (m) { return m.userId !== 'u-devin'; }).concat([{ userId: 'u-devin', kind: k, role: r }]);
        return Promise.resolve({ ok: true, listed: true });
      }
      // (0147) Crew asking a page nobody runs are listed at once, endorsed, and written down for whoever claims it.
      var gh = ghostList().filter(function (x) { return x.id === artistId; })[0];
      if (gh && !gh.owner && k === 'crew') {
        H.ghostCrew = H.ghostCrew || {};
        if ((H.ghostCrew[gh.id] || []).some(function (m) { return m.userId === 'u-devin'; })) return Promise.resolve({ ok: false, why: 'listed' });
        H.ghostCrew[gh.id] = (H.ghostCrew[gh.id] || []).concat([{ userId: 'u-devin', kind: 'crew', role: r, endorsed: true }]);
        H.joined = (H.joined || []).concat([{ artistId: gh.id, userId: 'u-devin', listed: true, at: new Date().toISOString() }]);
        H.artistRequests = H.artistRequests.filter(function (x) { return !(x.artistId === artistId && x.userId === 'u-devin'); });
        H.devinActs = devinActs().filter(function (y) { return y.id !== gh.id; }).concat([
          { id: gh.id, name: gh.name, handle: /^mb\./.test(gh.handle || '') ? '' : (gh.handle || ''), avatar: '', kind: 'crew', role: r, endorsed: true, eid: 'e-' + gh.id }]);
        window.__harness.poke('listing,endorsement');
        return Promise.resolve({ ok: true, listed: true, unclaimed: true });
      }
      // (Asking again replaces the ask that was waiting.)
      H.artistRequests = H.artistRequests.filter(function (x) { return !(x.artistId === artistId && x.userId === 'u-devin'); });
      H.artistRequests.push({ artistId: artistId, userId: 'u-devin', kind: k, role: r, state: 'pending', at: new Date().toISOString() });
      return Promise.resolve({ ok: true });
    },
    // (As live since the review: a request from someone who is on that page by now is left out, whatever its state.)
    myArtistRequests: function () {
      var H = window.__harness;
      return Promise.resolve((H.artistRequests || []).filter(function (x) { return x.userId === 'u-devin' && !listedOn(x.artistId, 'u-devin'); }).map(function (x) {
        var a = (H.acts || []).filter(function (y) { return y.id === x.artistId; })[0];
        var g = ghostList().filter(function (y) { return y.id === x.artistId; })[0];
        var p = a || g || {};
        return { artistId: x.artistId, artist: p.name || '', handle: p.handle || '', avatar: p.avatar || '', unclaimed: !a && !!g && !g.owner,
          kind: x.kind, role: x.role, state: x.state, at: x.at };
      }));
    },
    // Takes the request back while it waits, and takes its row away once it has run out or been declined ("Remove").
    withdrawArtistRequest: function (artistId) {
      var H = window.__harness; (H.frCalls = H.frCalls || []).push({ fn: 'withdrawArtistRequest', args: [artistId] });
      H.artistRequests = (H.artistRequests || []).filter(function (x) { return !(x.artistId === artistId && x.userId === 'u-devin'); });
      return Promise.resolve({ ok: true });
    },
    /* The first run, in memory (0134). The test account has answered already,
       so nothing is asked. __harness.firstRun = { needsHandle, needsBirth }
       (or just true) makes it due, as for an account fresh from the gate;
       a username or birthday saved since stops being needed. What it ticked
       is kept in __harness.kinds. Every call the first run makes is noted in
       __harness.frCalls as { fn, args }, and __harness.frFail = true makes the
       save at its end fail. __harness.firstRun.suggest = ['fan'] is what the
       account's invite code was made for (the cards that start ticked); it is
       always answered in the order member, crew, fan, promoter, [] for none. */
    firstRun: function () {
      var H = window.__harness, d = H.firstRun;
      var suggest = ['member', 'crew', 'fan', 'promoter'].filter(function (k) { return !!(d && Array.isArray(d.suggest)) && d.suggest.indexOf(k) >= 0; });
      return { due: !!d, needsHandle: !!(d && d.needsHandle) && !H.handle, needsBirth: !!(d && d.needsBirth) && !H.birthDate,
        kinds: (H.kinds || []).slice(), suggest: suggest,
        firstName: me.first_name, lastName: me.last_name, handle: H.handle || '', email: 'devin@example.com' };
    },
    /* What the project's sign-up switches say, for the Invite codes sheet:
       __harness.signup = { open: false } or { confirm: false } shows each
       warning; both are on unless set, and __harness.signup = null is "could
       not be read". */
    signupSettings: function () {
      var H = window.__harness;
      if (H.signup === null) return Promise.resolve(null);
      var s = H.signup || {};
      return Promise.resolve({ open: s.open !== false, confirm: s.confirm !== false });
    },
    saveBirthDate: function (d) {
      var H = window.__harness; (H.frCalls = H.frCalls || []).push({ fn: 'saveBirthDate', args: [d] });
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '')), now = new Date();
      var day = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
      if (!day || day.getMonth() !== Number(m[2]) - 1 || day.getDate() !== Number(m[3]) || Number(m[1]) < 1900 || day > now) {
        return Promise.reject(Object.assign(new Error('shape'), { code: 'shape' }));
      }
      var age = now.getFullYear() - day.getFullYear() - ((now.getMonth() < day.getMonth() || (now.getMonth() === day.getMonth() && now.getDate() < day.getDate())) ? 1 : 0);
      // (18, as the terms say; it was 13.)
      if (age < 18) return Promise.reject(Object.assign(new Error('young'), { code: 'young' }));
      H.birthDate = String(d);
      return Promise.resolve({ ok: true });
    },
    finishFirstRun: function (kinds) {
      var H = window.__harness; (H.frCalls = H.frCalls || []).push({ fn: 'finishFirstRun', args: [kinds] });
      if (H.frFail) return Promise.reject(Object.assign(new Error('offline'), { code: 'offline' }));
      H.kinds = ['member', 'crew', 'fan', 'promoter'].filter(function (k) { return (kinds || []).indexOf(k) >= 0; });
      H.firstRun = undefined;
      return Promise.resolve({ ok: true });
    },
    saveKinds: function (kinds) {
      var H = window.__harness; (H.frCalls = H.frCalls || []).push({ fn: 'saveKinds', args: [kinds] });
      if (H.frFail) return Promise.reject(Object.assign(new Error('offline'), { code: 'offline' }));
      H.kinds = ['member', 'crew', 'fan', 'promoter'].filter(function (k) { return (kinds || []).indexOf(k) >= 0; });
      return Promise.resolve({ ok: true });
    },
    artistHandleFree: function (h, forArtist) {
      var H = window.__harness; H.acts = H.acts || [];
      var taken = ['brent', 'tasha.lane', H.handle || ''].indexOf(String(h).toLowerCase()) >= 0 ||
        H.acts.some(function (a) { return a.handle === h && a.id !== forArtist; });
      return new Promise(function (res) { setTimeout(function () { res(!taken); }, 60); });
    },
    createArtist: function (a) {
      var H = window.__harness; H.acts = H.acts || [];
      if (H.acts.some(function (x) { return x.handle === a.handle; })) { var e = new Error('taken'); e.code = 'taken'; return Promise.reject(e); }
      var id = 'act' + (H.acts.length + 1);
      H.acts.push({ id: id, handle: a.handle, name: a.name, avatar: a.avatar || '', bio: '', members: [] });
      return Promise.resolve(id);
    },
    saveArtist: function (id, patch) {
      var H = window.__harness, a = (H.acts || []).filter(function (x) { return x.id === id; })[0];
      if (patch.handle && H.acts.some(function (x) { return x.handle === patch.handle && x.id !== id; })) { var e = new Error('taken'); e.code = 'taken'; return Promise.reject(e); }
      Object.assign(a, patch); return Promise.resolve();
    },
    deleteArtist: function (id) { var H = window.__harness; H.acts = (H.acts || []).filter(function (x) { return x.id !== id; }); return Promise.resolve(); },
    setMemberRole: function (id, uid, role) {
      var H = window.__harness, a = (H.acts || []).filter(function (x) { return x.id === id; })[0];
      H.roleSaves = (H.roleSaves || []).concat([{ id: id, uid: uid, role: role }]);
      if (a) a.members.forEach(function (m) { if (m.userId === uid) m.role = String(role || '').trim().slice(0, 160); });
      return Promise.resolve();
    },
    /* Tour credits. The test user runs every test artist, so their own claim
       approves itself; set __harness.creditNotOwner to see it wait instead. */
    creditAsks: function () {
      var H = window.__harness, iss = creditIss(); creditSeed();
      if (!iss) return Promise.resolve([]);
      var me = iss.members.filter(function (m) { return m.userId === 'u-devin'; })[0];
      if (!me || !me.endorsed) return Promise.resolve([]);
      // (0146) A Member has every night of the artist by rule: the database leaves that artist out of the asks.
      // __harness.askMembers = true gives the answer from before that change (the app must still show no ask).
      if (me.kind === 'band' && !H.askMembers) return Promise.resolve([]);
      var row = creditStore()[iss.id + ':u-devin'] || null, c = row && row.approved ? creditCount(row.approved) : { tours: 0, shows: 0 };
      return Promise.resolve([{ artistId: iss.id, artist: iss.name, handle: iss.handle, avatar: '', owner: !H.creditNotOwner,
        at: new Date(Date.now() - 6e5).toISOString(),
        state: row && row.pending ? 'pending' : row && row.approved ? 'approved' : row && row.declinedAt ? 'declined' : 'ask',
        hasApproved: !!(row && row.approved), submittedAt: row ? row.submittedAt : null, declinedAt: row ? row.declinedAt : null,
        tours: c.tours, shows: c.shows }]);
    },
    creditQueue: function () {
      var iss = creditIss(); creditSeed();
      if (!iss) return Promise.resolve([]);
      var rows = creditStore(), P = window.GR_BACKEND.people;
      return Promise.resolve(Object.keys(rows).filter(function (k) { return k.split(':')[0] === iss.id && rows[k].pending; }).map(function (k) {
        var uid = k.split(':')[1], c = creditCount(rows[k].pending);
        return { artistId: iss.id, artist: iss.name, userId: uid, name: (P[uid] || {}).name || 'Someone', avatar: '',
          submittedAt: rows[k].submittedAt, all: !!rows[k].pending.all, hasApproved: !!rows[k].approved, tours: c.tours, shows: c.shows };
      }));
    },
    creditTours: function (id) {
      var H = window.__harness, a = (H.acts || []).filter(function (x) { return x.id === id; })[0], iss = creditIss();
      if (!a) return Promise.resolve(null);
      var me = a.members.filter(function (m) { return m.userId === 'u-devin'; })[0];
      var row = creditStore()[id + ':u-devin'] || null;
      return Promise.resolve({ artistId: id, artist: a.name, owner: !H.creditNotOwner, endorsed: !!(me && me.endorsed),
        url: 'https://www.setlist.fm/setlists/i-see-stars-3bd2d464.html',
        tours: iss && iss.id === id ? CREDIT_TOURS.map(function (g) { return Object.assign({}, g); }) : [],
        mine: row ? { approved: row.approved, pending: row.pending, declined: row.declined || null, declinedAt: row.declinedAt, submittedAt: row.submittedAt } : null });
    },
    creditShows: function (id, key) { return Promise.resolve(creditShowsOf(key)); },
    submitCredits: function (id, claim) {
      var H = window.__harness, rows = creditStore(), k = id + ':u-devin', own = !H.creditNotOwner;
      H.creditSubmits = (H.creditSubmits || []).concat([JSON.parse(JSON.stringify(claim))]);
      var norm = claim.all ? { all: true, until: '2026-10-07' } : { picks: claim.picks, until: '2026-10-07' };
      var row = rows[k] || { approved: null, pending: null, submittedAt: null, declinedAt: null };
      if (own) { row.approved = norm; row.pending = null; } else row.pending = norm;
      row.submittedAt = new Date().toISOString(); row.declinedAt = null; row.declined = null;
      rows[k] = row;
      return Promise.resolve({ ok: true, auto: own });
    },
    decideCredits: function (id, uid, verdict, seen) {
      var H = window.__harness, rows = creditStore(), row = rows[id + ':' + uid];
      H.creditDecisions = (H.creditDecisions || []).concat([{ id: id, uid: uid, verdict: verdict, seen: seen }]);
      if (!row) return Promise.resolve({ ok: false, why: 'gone' });
      if (verdict !== 'revoke' && (!row.pending || (seen && seen !== row.submittedAt))) return Promise.resolve({ ok: false, why: 'changed' });
      if (verdict === 'approve') { row.approved = row.pending; row.pending = null; }
      else if (verdict === 'decline') { row.declined = row.pending; row.pending = null; row.declinedAt = new Date().toISOString(); }
      else row.approved = null;
      return Promise.resolve({ ok: true });
    },
    withdrawCredits: function (id) { delete creditStore()[id + ':u-devin']; return Promise.resolve({ ok: true }); },
    creditDetail: function (id, uid) {
      var H = window.__harness, row = creditStore()[id + ':' + uid], a = (H.acts || []).filter(function (x) { return x.id === id; })[0];
      if (!row) return Promise.resolve(null);
      return Promise.resolve({ artistId: id, userId: uid, artist: a ? a.name : '', name: (window.GR_BACKEND.people[uid] || {}).name || '',
        url: 'https://www.setlist.fm', approvedAll: !!(row.approved && row.approved.all), approved: creditExpand(row.approved),
        pendingAll: !!(row.pending && row.pending.all), pending: row.pending ? creditExpand(row.pending) : null,
        submittedAt: row.submittedAt, declinedAt: row.declinedAt });
    },
    /* "I was on this tour" (0146). tourClaims: where the test person stands on each tour of a page that lists
       them as crew and has endorsed them ({ crew: false } for a Member or a stranger). addTourCredit: the tour
       is added, whole, with the role, to what they have waiting (else to what is confirmed), never in place of
       it; it waits for the artist, or is confirmed at once when the test person runs the page. Every call is
       kept in __harness.tourClaimsSent as { id, name, role }. __harness.addTourFails = true refuses it. */
    tourClaims: function (id) {
      var H = window.__harness, a = (H.acts || []).filter(function (x) { return x.id === id; })[0];
      var me = a ? a.members.filter(function (m) { return m.userId === 'u-devin' && !m.leftAt; })[0] : null;
      if (!me || me.kind !== 'crew' || !me.endorsed) return Promise.resolve({ crew: false, role: '', tours: [] });
      var row = creditStore()[id + ':u-devin'] || {}, hr = (H.histories || {})[id];
      var names = ((hr && hr.summary && hr.summary.toursList) || []).filter(function (t) { return t.kind !== 'shows'; }).map(function (t) { return t.name; });
      CREDIT_TOURS.forEach(function (g) { if (!g.year && names.indexOf(g.name) < 0) names.push(g.name); });
      var out = [];
      names.forEach(function (nm) {
        var key = creditTourKey(nm);
        var ap = creditPickOf(row.approved, key), pe = creditPickOf(row.pending, key), de = creditPickOf(row.declined, key);
        if (ap) out.push({ name: nm, state: 'approved', role: ap.role || '' });
        else if (pe) out.push({ name: nm, state: 'pending', role: pe.role || '' });
        else if (de) out.push({ name: nm, state: 'declined', role: de.role || '' });
      });
      return Promise.resolve({ crew: true, role: me.role || '', tours: out });
    },
    addTourCredit: function (id, name, role) {
      var H = window.__harness, rows = creditStore(), k = id + ':u-devin', a = (H.acts || []).filter(function (x) { return x.id === id; })[0];
      H.tourClaimsSent = (H.tourClaimsSent || []).concat([{ id: id, name: name, role: role }]);
      if (H.addTourFails) return Promise.reject(Object.assign(new Error('permission'), { code: 'permission' }));
      var g = creditTourByName(id, name);
      if (!g) return Promise.resolve({ ok: false, why: 'no_tour' });
      var row = rows[k] || { approved: null, pending: null, submittedAt: null, declinedAt: null };
      var base = row.pending || row.approved;
      if (base && base.all) return Promise.resolve({ ok: true, covered: true });
      var r = String(role || '').trim().slice(0, 160);
      var norm = { picks: ((base && base.picks) || []).filter(function (p) { return p.key !== g.key; }).concat([{ key: g.key, mode: 'all', role: r }]), until: ymd(today) };
      var own = !H.creditNotOwner && !(a && a.notMine);
      if (own) { row.approved = norm; row.pending = null; } else row.pending = norm;
      row.submittedAt = new Date().toISOString(); row.declinedAt = null; row.declined = null;
      rows[k] = row;
      return Promise.resolve({ ok: true, auto: own });
    },
    // Listing someone (again): their role and endorsement stay, and a day they left is cleared.
    // __harness.listFails = true refuses it the way the database does on a page Greenroom has not
    // confirmed, for someone who is not on one of the runner's tours ('permission').
    addArtistMember: function (id, uid, kind) {
      var H = window.__harness, a = H.acts.filter(function (x) { return x.id === id; })[0];
      if (H.listFails) return Promise.reject(Object.assign(new Error('permission'), { code: 'permission' }));
      var was = a.members.filter(function (m) { return m.userId === uid; })[0];
      if (was && was.endorsed && !was.leftAt && was.kind === 'band' && kind === 'crew') return Promise.resolve();
      a.members = a.members.filter(function (m) { return m.userId !== uid; }).concat([Object.assign({}, was || {}, { userId: uid, kind: kind, leftAt: null, leaving: null })]);
      return Promise.resolve();
    },
    // Taking someone off ends the listing, as live (0132): never endorsed, simply off; a member with
    // other members to ask waits on them; else off from today with their history kept.
    removeArtistMember: function (id, uid) {
      var H = window.__harness, a = H.acts.filter(function (x) { return x.id === id; })[0];
      var m = a.members.filter(function (x) { return x.userId === uid; })[0];
      H.memberEnds = (H.memberEnds || []).concat([{ id: id, uid: uid }]);
      if (!m || m.leftAt) return Promise.resolve({ ok: true, gone: true });
      if (!m.endorsed && (m.kind !== 'band' || !m.settled)) { a.members = a.members.filter(function (x) { return x.userId !== uid; }); return Promise.resolve({ ok: true, kept: false }); }
      var others = a.members.filter(function (x) { return x.kind === 'band' && !x.leftAt && x.userId !== uid && x.userId !== 'u-devin'; }).length;
      if (m.kind === 'band' && others && uid !== 'u-devin') { m.leaving = { at: new Date().toISOString(), waiting: others }; return Promise.resolve({ ok: true, pending: true, waiting: others }); }
      m.leftAt = new Date().toISOString().slice(0, 10);
      return Promise.resolve({ ok: true, kept: true, until: m.leftAt });
    },
    cancelMemberRemoval: function (id, uid) {
      var H = window.__harness, a = H.acts.filter(function (x) { return x.id === id; })[0];
      var had = false;
      a.members.forEach(function (m) { if (m.userId === uid && m.leaving) { m.leaving = null; had = true; } });
      return Promise.resolve({ ok: had });
    },
    // H.memberAsks = [{artistId, artist, userId, name, askedBy, waiting}] puts a card on your Artists tab.
    memberRemovalAsks: function () { return Promise.resolve((window.__harness.memberAsks || []).slice()); },
    answerMemberRemoval: function (id, uid, agree) {
      var H = window.__harness;
      H.memberAnswers = (H.memberAnswers || []).concat([{ id: id, uid: uid, agree: !!agree }]);
      var ask = (H.memberAsks || []).filter(function (x) { return x.artistId === id && x.userId === uid; })[0];
      if (!ask) return Promise.resolve({ ok: false, why: 'gone' });
      H.memberAsks = (H.memberAsks || []).filter(function (x) { return x !== ask; });
      if (!agree) return Promise.resolve({ ok: true, ended: false, stopped: true });
      if (ask.waiting > 1) return Promise.resolve({ ok: true, ended: false, waiting: ask.waiting - 1 });
      var a = (H.acts || []).filter(function (x) { return x.id === id; })[0];
      if (a) a.members.forEach(function (m) { if (m.userId === uid) { m.leftAt = new Date().toISOString().slice(0, 10); m.leaving = null; } });
      return Promise.resolve({ ok: true, ended: true });
    },
    /* Who is asking to be listed on a page the test user runs (0134): the
       asks in __harness.artistRequests from anyone else, pending ones only.
       __harness.seedRequests = true puts two on the first test artist: Ana
       (crew, FOH engineer) and Jeff (a Member, Drums). */
    artistRequestQueue: function (artistId) {
      var H = window.__harness, P = window.GR_BACKEND.people;
      H.artistRequests = H.artistRequests || [];
      if (H.seedRequests && !H.requestsSeeded && (H.acts || []).length) {
        H.requestsSeeded = true;
        var first = H.acts[0].id;
        H.artistRequests.push({ artistId: first, userId: 'u-ana', kind: 'crew', role: 'FOH engineer', state: 'pending', at: new Date(Date.now() - 2 * 36e5).toISOString() },
          { artistId: first, userId: 'u-jeff', kind: 'band', role: 'Drums', state: 'pending', at: new Date(Date.now() - 3 * 864e5).toISOString() });
      }
      var mine = (H.acts || []).filter(function (a) { return !a.notMine; }).map(function (a) { return a.id; });
      (H.queueAsks = H.queueAsks || []).push(artistId == null ? null : artistId);
      // (As live since the review: someone who is on the page by now is left out, so their card goes.)
      return Promise.resolve(H.artistRequests.filter(function (x) {
        return (x.userId || 'u-devin') !== 'u-devin' && (x.state || 'pending') === 'pending' && mine.indexOf(x.artistId) >= 0 && (!artistId || x.artistId === artistId) &&
          !listedOn(x.artistId, x.userId);
      }).map(function (x) {
        var a = H.acts.filter(function (y) { return y.id === x.artistId; })[0], p = P[x.userId] || {};
        return { artistId: x.artistId, artist: a.name, userId: x.userId, name: p.name || 'Someone', handle: p.handle || '', avatar: '',
          roles: p.roles || [], kind: x.kind, role: x.role || '', at: x.at };
      }));
    },
    // Yes lists them with the kind and role they gave, endorsed; no marks the ask declined.
    // __harness.decideWhy = 'gone' | 'expired' | 'former_member' makes the answer come back refused that way.
    decideArtistRequest: function (artistId, userId, accept) {
      var H = window.__harness;
      H.requestDecisions = (H.requestDecisions || []).concat([{ artistId: artistId, userId: userId, accept: !!accept }]);
      if (H.decideWhy) return Promise.resolve({ ok: false, why: H.decideWhy });
      var x = (H.artistRequests || []).filter(function (y) { return y.artistId === artistId && y.userId === userId && (y.state || 'pending') === 'pending'; })[0];
      var a = (H.acts || []).filter(function (y) { return y.id === artistId; })[0];
      if (!x || !a) return Promise.resolve({ ok: false, why: 'gone' });
      x.state = accept ? 'accepted' : 'declined';
      if (accept) a.members = a.members.filter(function (m) { return m.userId !== userId; }).concat([{ userId: userId, kind: x.kind, role: x.role || '', endorsed: true }]);
      return Promise.resolve({ ok: true, accepted: !!accept });
    },
    /* People who joined a page before the test user claimed it (0147). The notes are
       kept in __harness.joined as { artistId, userId, listed, at }; only the pages the
       test user runs are answered here, as live. Every answer is kept in
       __harness.joinedAnswers as { artistId, userId, keep }. Keep lets the listing and
       the tours stand; Take off takes the listing, the endorsement and the tours
       confirmed there away. __harness.joinedWhy = 'gone' makes an answer come back
       refused that way. */
    unclaimedJoins: function (artistId) {
      var H = window.__harness, P = window.GR_BACKEND.people, rows = creditStore();
      var mine = (H.acts || []).filter(function (a) { return !a.notMine; });
      return Promise.resolve((H.joined || []).filter(function (j) {
        return j.userId !== 'u-devin' && (!artistId || j.artistId === artistId) && mine.some(function (a) { return a.id === j.artistId; });
      }).map(function (j) {
        var a = mine.filter(function (y) { return y.id === j.artistId; })[0], p = P[j.userId] || {};
        var m = a.members.filter(function (y) { return y.userId === j.userId && !y.leftAt; })[0];
        var row = rows[j.artistId + ':' + j.userId], c = row && row.approved ? creditCount(row.approved) : { tours: 0, shows: 0 };
        return { artistId: a.id, artist: a.name, userId: j.userId, name: p.name || 'Someone', handle: p.handle || '', avatar: '',
          kind: m ? m.kind : 'crew', role: m ? m.role || '' : '', listed: !!j.listed, onPage: !!m, at: j.at,
          list: row && row.approved ? creditExpand(row.approved) : [], tours: c.tours, shows: c.shows };
      }));
    },
    answerUnclaimedJoin: function (artistId, userId, keep) {
      var H = window.__harness, a = (H.acts || []).filter(function (y) { return y.id === artistId; })[0];
      H.joinedAnswers = (H.joinedAnswers || []).concat([{ artistId: artistId, userId: userId, keep: !!keep }]);
      if (H.joinedWhy) return Promise.resolve({ ok: false, why: H.joinedWhy });
      var j = (H.joined || []).filter(function (x) { return x.artistId === artistId && x.userId === userId; })[0];
      if (!a || !j) return Promise.resolve({ ok: false, why: 'gone' });
      H.joined = H.joined.filter(function (x) { return x !== j; });
      if (!keep) {
        delete creditStore()[artistId + ':' + userId];
        if (j.listed) a.members = a.members.filter(function (m) { return m.userId !== userId; });
      }
      window.__harness.poke('listing');
      return Promise.resolve({ ok: true, kept: !!keep });
    },
    /* A fan's shows (0134). The nights are the ones tourNights pretends for
       any entry, plus one still to come (so the row with no button can be
       seen); the ones ticked are kept in __harness.attended as
       'artistId|date'. __harness.attendMany = true answers 'many', the
       day's limit. */
    fanNights: function (artistId, tourName) {
      var H = window.__harness; H.attended = H.attended || [];
      H.fanNightAsks = (H.fanNightAsks || []).concat([[artistId, tourName]]);
      return window.GR_BACKEND.tourNights(artistId, tourName).then(function (list) {
        var ahead = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
        return list.map(function (n) { return { date: n.date, city: n.city, state: n.state, country: n.country, venue: n.venue, festival: n.festival || '' }; })
          .concat([{ date: ahead, city: 'Phoenix', state: 'AZ', country: 'US', venue: 'Crescent Ballroom', festival: '' }])
          .map(function (n) { n.attended = H.attended.indexOf(artistId + '|' + n.date) >= 0; return n; });
      });
    },
    markAttended: function (artistId, date, going) {
      var H = window.__harness; H.attended = H.attended || [];
      H.attendCalls = (H.attendCalls || []).concat([{ artistId: artistId, date: date, going: !!going }]);
      if (H.attendMany) return Promise.resolve({ ok: false, why: 'many' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return Promise.resolve({ ok: false, why: 'none' });
      if (String(date) > new Date().toISOString().slice(0, 10)) return Promise.resolve({ ok: false, why: 'future' });
      var k = artistId + '|' + date;
      H.attended = H.attended.filter(function (x) { return x !== k; });
      if (going) H.attended.push(k);
      return Promise.resolve({ ok: true, count: H.attended.length });
    },
    myAttended: function () {
      var H = window.__harness, by = {};
      (H.attended || []).forEach(function (k) { var id = k.split('|')[0]; by[id] = (by[id] || 0) + 1; });
      return Promise.resolve({ count: (H.attended || []).length, artists: Object.keys(by).map(function (id) {
        var a = (H.acts || []).filter(function (x) { return x.id === id; })[0] || ghostList().filter(function (x) { return x.id === id; })[0] || {};
        return { artistId: id, artist: a.name || 'Artist', handle: a.handle || '', avatar: a.avatar || '', n: by[id] };
      }).sort(function (a, b) { return b.n - a.n; }) });
    },
    /* The fan round (0159), in memory: see THE FAN ROUND above for the
       seeds. The Top 10s live in __harness.topTens ({ userId: [{ artistId,
       rank, name, avatar }] }); an artist page's ranked fans in
       __harness.fanRanks ({ artistId: [{ userId, name, avatar, shows }] }).
       This phone's account is u-devin; every save is noted in
       __harness.favCalls. Names and pictures are read from the acts the
       harness knows, so a spot seeded by id alone still says its artist. */
    favoritesOn: function () { return !window.__harness.favoritesOff; },
    favoritesOf: function (uid) {
      var H = window.__harness;
      if (H.favoritesOff) return null;
      return (((H.topTens || {})[uid]) || []).slice().sort(function (a, b) { return a.rank - b.rank; }).map(function (r) {
        var a = (H.acts || []).filter(function (x) { return x.id === r.artistId; })[0]
          || ghostList().filter(function (x) { return x.id === r.artistId; })[0] || {};
        return { artistId: r.artistId, rank: r.rank, name: a.name || r.name || 'Artist',
          handle: a.handle || '', avatar: a.avatar || r.avatar || '' };
      });
    },
    favAdd: function (artistId, rank, info) {
      var H = window.__harness;
      (H.favCalls = H.favCalls || []).push({ fn: 'favAdd', args: [artistId, rank] });
      if (H.favFail) return Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
      var m = H.topTens = H.topTens || {}, rows = m['u-devin'] = m['u-devin'] || [];
      // Already there, or the spot is taken: refused, as the live keys refuse it.
      if (rows.some(function (r) { return r.artistId === artistId || r.rank === rank; })) {
        return Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
      }
      rows.push({ artistId: artistId, rank: rank, name: info && info.name, avatar: info && info.avatar });
      return Promise.resolve();
    },
    favRemove: function (artistId) {
      var H = window.__harness;
      (H.favCalls = H.favCalls || []).push({ fn: 'favRemove', args: [artistId] });
      if (H.favFail) return Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
      var m = H.topTens = H.topTens || {};
      m['u-devin'] = (m['u-devin'] || []).filter(function (r) { return r.artistId !== artistId; });
      return Promise.resolve();
    },
    favSwap: function (aId, bId) {
      var H = window.__harness;
      (H.favCalls = H.favCalls || []).push({ fn: 'favSwap', args: [aId, bId] });
      if (H.favFail) return Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
      var rows = (H.topTens || {})['u-devin'] || [];
      var a = rows.filter(function (r) { return r.artistId === aId; })[0];
      var b = rows.filter(function (r) { return r.artistId === bId; })[0];
      if (!a || !b) return Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
      var t = a.rank; a.rank = b.rank; b.rank = t;
      return Promise.resolve();
    },
    topFans: function (artistId) {
      var H = window.__harness;
      if (H.favoritesOff) return null;
      return (((H.fanRanks || {})[artistId]) || []).slice(0, 100);
    },
    /* A venue's or a festival's page (0134): the place as openVenue or
       openFestival made it (__harness.places), with pretend shows on record
       and the test artists as who played there. myWork comes from
       __harness.placeWork. An id nobody opened answers null. */
    venueCard: function (id) {
      var H = window.__harness, p = (H.places || []).filter(function (x) { return x.kind === 'venue' && x.id === id; })[0];
      if (!p) return Promise.resolve(null);
      var w = (H.placeWork || []).filter(function (x) { return x.kind === 'venue' && x.id === id && x.userId === 'u-devin'; })[0];
      var played = (H.acts || []).map(function (a, i) { return { id: a.id, name: a.name, avatar: a.avatar || '', n: 4 - Math.min(i, 3), first: '2012-04-05', last: '2024-10-12' }; })
        .concat(ghostList().filter(function (g) { return g.checked; }).map(function (g) { return { id: g.id, name: g.name, avatar: '', n: 2, first: '2015-06-20', last: '2015-06-21' }; }));
      // (As live: the card's country is a name, not the two-letter code the search row carries.)
      var out = { id: p.id, name: p.name, city: p.city, region: { Austin: 'TX', Detroit: 'MI', Cleveland: 'OH', 'Lake Buena Vista': 'FL' }[p.city] || '',
        country: { US: 'United States', GB: 'United Kingdom', CA: 'Canada', IE: 'Ireland' }[p.cc] || p.cc,
        address: p.name === 'Mohawk' ? '912 Red River St, Austin, TX 78701' : '', phone: '', unclaimed: true,
        shows: played.reduce(function (n, x) { return n + x.n; }, 0), firstYear: played.length ? 2012 : null, lastYear: played.length ? 2024 : null,
        artists: played, workers: (H.placeWork || []).filter(function (x) { return x.kind === 'venue' && x.id === id; }).length,
        myWork: w ? { role: w.role, state: w.state } : null };
      // Ratings (0154) ride on the card, as venue_card sends them after the
      // migration; with __harness.ratingsOff the card reads as 0134 made it.
      if (!H.ratingsOff) {
        var st = (H.venueStars || {})[id] || {}, vals = Object.keys(st).map(function (u) { return st[u]; });
        out.rating = vals.length ? Math.round(vals.reduce(function (n, v) { return n + v; }, 0) / vals.length * 10) / 10 : null;
        out.ratings = vals.length;
      }
      // The 0168 keys (the venue's average review score out of five, and
      // how many reviews), only when __harness.venueScores seeds them: a
      // card without them reads as a build ahead of that staged migration,
      // and the page must show no review line for it.
      var sc = (H.venueScores || {})[id];
      if (sc) { out.score = sc.score; out.scoreCount = sc.count; }
      return Promise.resolve(out);
    },
    festivalCard: function (id) {
      var H = window.__harness, p = (H.places || []).filter(function (x) { return x.kind === 'festival' && x.id === id; })[0];
      if (!p) return Promise.resolve(null);
      var w = (H.placeWork || []).filter(function (x) { return x.kind === 'festival' && x.id === id && x.userId === 'u-devin'; })[0];
      var played = (H.acts || []).map(function (a) { return { id: a.id, name: a.name, avatar: a.avatar || '', n: 3 }; })
        .concat(ghostList().filter(function (g) { return g.checked; }).map(function (g) { return { id: g.id, name: g.name, avatar: '', n: 1 }; }));
      return Promise.resolve({ id: p.id, name: p.name, unclaimed: true, shows: played.reduce(function (n, x) { return n + x.n; }, 0),
        editions: played.length ? [{ year: 2014, n: 1 }, { year: 2016, n: 1 }, { year: 2018, n: 1 }] : [],
        artists: played, workers: (H.placeWork || []).filter(function (x) { return x.kind === 'festival' && x.id === id; }).length,
        myWork: w ? { role: w.role, state: w.state } : null });
    },
    /* Ratings (0154), in memory. Venue stars live in __harness.venueStars
       ({ venueId: { userId: stars } }); the band's words on a night in
       __harness.showStars ([{ tourId, showId, userId, crowd, venue, city,
       review, at }]). This phone's account is u-devin. __harness.ratingsOff
       = true answers as with no tables (a build ahead of its migration): no
       rating line, no sheets, and the venue card loses its rating keys.
       The structured review (0165): showReviewOn answers true here, so the
       Rate button opens the one-question wizard; __harness.reviewOff = true
       answers as before 0165 (the old three-slider sheet opens instead,
       and a wizard already open answers Done with 'review-missing', the
       way a write that finds no column does, so the old sheet appears).
       A rating stands once sent (0173): a second showRate for the same
       night answers 'already-rated', as the database's duplicate refusal
       does; __harness.ratingsLoading = true makes showRatings answer null,
       as while the band's rows are still on their way. */
    ratingsOn: function () { return !window.__harness.ratingsOff; },
    showReviewOn: function () { return !window.__harness.ratingsOff && !window.__harness.reviewOff; },
    venueRate: function (id, stars) {
      var H = window.__harness;
      if (H.ratingsOff) return Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
      H.venueStars = H.venueStars || {};
      var m = H.venueStars[id] = H.venueStars[id] || {};
      m['u-devin'] = Math.max(1, Math.min(10, Math.round(Number(stars) || 0)));
      (H.rateCalls = H.rateCalls || []).push({ fn: 'venueRate', args: [id, stars] });
      return Promise.resolve();
    },
    myVenueRating: function (id) {
      var H = window.__harness, m = (H.venueStars || {})[id];
      return Promise.resolve(!H.ratingsOff && m && m['u-devin'] >= 1 ? m['u-devin'] : null);
    },
    showRate: function (tourId, showId, o) {
      var H = window.__harness, p = o || {};
      if (H.ratingsOff) return Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
      // A review sent to a database without the column (reviewOff flipped on
      // after the wizard opened): the write answers the way the real one does.
      if (p.review && H.reviewOff) return Promise.reject(Object.assign(new Error('review-missing'), { code: 'review-missing' }));
      var one = function (v) { var n = Math.round(Number(v)); return n >= 1 && n <= 10 ? n : null; };
      if ((H.showStars || []).some(function (r) { return r.tourId === tourId && r.showId === showId && r.userId === 'u-devin'; })) {
        (H.rateCalls = H.rateCalls || []).push({ fn: 'showRate', args: [tourId, showId, p], refused: 'already-rated' });
        return Promise.reject(Object.assign(new Error('already-rated'), { code: 'already-rated' }));
      }
      H.showStars = H.showStars || [];
      H.showStars.push({ tourId: tourId, showId: showId, userId: 'u-devin', crowd: one(p.crowd), venue: one(p.venue), city: one(p.city),
        review: p.review || null, at: new Date().toISOString() });
      (H.rateCalls = H.rateCalls || []).push({ fn: 'showRate', args: [tourId, showId, p] });
      return Promise.resolve();
    },
    showRatings: function (tourId) {
      var H = window.__harness;
      if (H.ratingsOff || H.ratingsLoading) return null;
      return (H.showStars || []).filter(function (r) { return r.tourId === tourId; }).map(function (r) {
        return { showId: r.showId, userId: r.userId, crowd: r.crowd, venue: r.venue, city: r.city, review: r.review || null, at: r.at };
      });
    },
    /* Invite codes (0134), for a Greenroom admin: __harness.admin = false
       answers null, as it does for anyone else. Kept in __harness.codes,
       newest first: one in use, one used up, one switched off. */
    inviteCodes: function () {
      var H = window.__harness;
      if (H.admin === false) return Promise.resolve(null);
      var day = function (d) { return new Date(Date.now() + d * 864e5).toISOString(); };
      if (!H.codes) H.codes = [
        { code: 'GR-7KQ2-M4XP', kinds: [], usesLeft: 3, used: 2, expiresAt: day(21), note: 'Fall run crew', revoked: false, at: day(-9) },
        { code: 'GR-B3NT-9WLA', kinds: ['fan'], usesLeft: 0, used: 25, expiresAt: day(5), note: 'Detroit meet and greet', revoked: false, at: day(-25) },
        { code: 'GR-HX4D-22RV', kinds: ['member', 'crew'], usesLeft: 4, used: 1, expiresAt: day(2), note: '', revoked: true, at: day(-28) }];
      return Promise.resolve(H.codes.map(function (c) { return Object.assign({}, c); }));
    },
    makeInviteCode: function (o) {
      var H = window.__harness; o = o || {};
      H.codeCalls = (H.codeCalls || []).concat([JSON.parse(JSON.stringify(o))]);
      if (H.admin === false) return Promise.reject(Object.assign(new Error('permission'), { code: 'permission' }));
      return window.GR_BACKEND.inviteCodes().then(function () {
        var abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        var four = function () { var s = ''; for (var i = 0; i < 4; i++) s += abc.charAt(Math.floor(Math.random() * abc.length)); return s; };
        var code = 'GR-' + four() + '-' + four();
        var uses = Math.max(1, Math.min(500, parseInt(o.uses, 10) || 1)), days = Math.max(1, parseInt(o.days, 10) || 30);
        H.codes.unshift({ code: code, kinds: ['member', 'crew', 'fan', 'promoter'].filter(function (k) { return (o.kinds || []).indexOf(k) >= 0; }),
          usesLeft: uses, used: 0, expiresAt: new Date(Date.now() + days * 864e5).toISOString(), note: String(o.note || '').trim().slice(0, 60),
          revoked: false, at: new Date().toISOString() });
        return { code: code };
      });
    },
    revokeInviteCode: function (code) {
      var H = window.__harness;
      H.codeCalls = (H.codeCalls || []).concat([{ revoke: code }]);
      (H.codes || []).forEach(function (c) { if (c.code === code) c.revoked = true; });
      return Promise.resolve({ ok: true });
    },
    /* Who has agreed (0139), for a Greenroom admin: what legal_list() would
       answer, from __harness.legalList. Every person here is invented. The
       switches are listed with the other documents' hooks, further up. */
    legalList: function () {
      var H = window.__harness, n = legalNow();
      H.legalListCalls = (H.legalListCalls || 0) + 1;
      // (Not an admin, or the call failed: site/backend.js answers null for both.)
      if (H.admin === false || H.legalList === null || H.legalListFail) return Promise.resolve(null);
      var ago = function (days) { return new Date(Date.now() - days * 864e5).toISOString(); };
      var hex = function (k) { var s = ''; for (var i = 0; i < 64; i++) s += ((k * 7 + i * 13 + (i * i) % 11) % 16).toString(16); return s; };
      var phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
      var row = function (name, email, handle, days, via, o) {
        return Object.assign({ name: name, email: email, handle: handle, at: ago(days), via: via,
          versions: { nda: n.cur.nda, terms: n.cur.terms, privacy: n.cur.privacy },
          ip: '203.0.113.' + (20 + Math.round(days * 3) % 200), agent: phone,
          shas: { nda: hex(1), terms: hex(2), privacy: hex(3) }, said: shared.LEGAL_SAID, gone: false }, o || {});
      };
      if (!H.legalList) H.legalList = {
        // Newest first, as the server sends them. Jordan agreed twice (a version changed in between), one
        // account has been deleted, one person has no name, and Quinn is still on an older version.
        agreed: [
          row('Riley Stone', 'riley.stone@example.com', 'riley.foh', 0.1, 'invite'),
          row('', 'casey.marlow@example.com', '', 1, 'code'),
          row('Avery Lang', 'avery.lang@example.org', '', 2, 'invite', { ip: '2001:db8::7a1c', agent: '' }),
          row('Jordan Vale', 'jordan.vale@example.com', 'jordanvale', 3, 'inside'),
          row('Morgan Tate', 'morgan.tate@example.com', 'morgan.ld', 5, 'code'),
          row('', 'closed.account@example.com', '', 6, 'code', { gone: true }),
          row('Quinn Harper', 'quinn.harper@example.com', 'quinn', 30, 'inside',
            { versions: { nda: n.cur.nda, terms: '0.9', privacy: n.cur.privacy }, shas: { nda: hex(1), terms: hex(4), privacy: hex(3) } }),
          row('Jordan Vale', 'jordan.vale@example.com', 'jordanvale', 40, 'inside',
            { versions: { nda: n.cur.nda, terms: '0.9', privacy: n.cur.privacy }, shas: { nda: hex(1), terms: hex(4), privacy: hex(3) } })],
        // Oldest account first.
        waiting: [
          { name: 'Quinn Harper', email: 'quinn.harper@example.com', handle: 'quinn', since: ago(60), invited: false },
          { name: 'Skyler Brooks', email: 'skyler.brooks@example.com', handle: 'sky.ld', since: ago(12), invited: false },
          { name: '', email: 'new.tech@example.com', handle: '', since: ago(2), invited: true },
          { name: 'Dana Whit', email: 'dana.whit@example.com', handle: '', since: ago(1), invited: true }]
      };
      var L = JSON.parse(JSON.stringify(H.legalList));
      L.agreed = Array.isArray(L.agreed) ? L.agreed : []; L.waiting = Array.isArray(L.waiting) ? L.waiting : [];
      for (var k = 0; k < (parseInt(H.legalListMany, 10) || 0); k++) {
        L.agreed.push(row('Harness Person ' + (k + 1), 'person' + (k + 1) + '@example.com', '', 50 + k, k % 3 ? 'code' : 'invite'));
      }
      // As the server works them out: which rows carry the current versions, and nobody waiting (and no
      // current versions) while the three documents are not loaded.
      L.agreed.forEach(function (x) {
        var v = x.versions || {};
        if (typeof x.current !== 'boolean') x.current = n.ready && v.nda === n.cur.nda && v.terms === n.cur.terms && v.privacy === n.cur.privacy;
        if (!n.ready) x.current = false;
      });
      if (!n.ready) L.waiting = [];
      L.current = n.ready ? { nda: n.cur.nda, terms: n.cur.terms, privacy: n.cur.privacy } : null;
      return Promise.resolve(L);
    },
    people: { 'u-devin': { name: 'Devin Oliver', handle: '', verified: true, roles: ['Artist'], tourRole: 'Artist', canOpen: true },
      'u-brent': { name: 'Brent Allen', handle: 'brent', roles: ['Guitar Tech', 'Stage Manager'], tourRole: 'Guitar Tech', canOpen: true, followers: 12 },
      'u-jeff': { name: 'Jeff Valentine', handle: 'jeffv', roles: ['Artist'], tourRole: 'Artist', canOpen: false },
      'u-ana': { name: 'Ana Reyes', handle: 'ana.foh', roles: ['FOH Engineer'], tourRole: 'FOH Engineer', canOpen: false } },
    findPeople: function (text) {
      var H = window.__harness, P = window.GR_BACKEND.people, t = String(text || '').trim().replace(/^@/, '').toLowerCase();
      H.searches = (H.searches || []).concat([t]);
      if (t.length < 2) return Promise.resolve([]);
      return Promise.resolve(Object.keys(P).filter(function (id) {
        var p = P[id], h = id === 'u-devin' ? (H.handle || '') : p.handle;
        return (h && h.indexOf(t) === 0) || (p.canOpen && p.name.toLowerCase().indexOf(t) >= 0);
      }).map(function (id) { return Object.assign({ userId: id, avatar: '', followers: 0,
        iFollow: (H.follows || []).some(function (x) { return x.a === 'u-devin' && x.b === id; }) }, P[id], id === 'u-devin' ? { handle: H.handle || '' } : {}); }));
    },
    artistCard: function (id) {
      var H = window.__harness, P = window.GR_BACKEND.people, a = (H.acts || []).filter(function (x) { return x.id === id; })[0];
      var g = ghostList().filter(function (x) { return x.id === id; })[0];
      if (!a && g) {
        // A page nobody runs (or one someone else was given): the viewer's side only.
        var gf = (H.artistFollows || []).indexOf(g.id) >= 0;
        var mc = (H.claims || []).filter(function (c) { return c.artistId === g.id && c.userId === 'u-devin'; })[0];
        // (0134) What the test user asked this page for, and the claimants still waiting: each is
        // listed as a Member marked pending, shown to the claimant and to a Greenroom admin only.
        var rq = (H.artistRequests || []).filter(function (x) { return x.artistId === g.id && (x.userId || 'u-devin') === 'u-devin'; })[0];
        var waiting = g.owner ? [] : (H.claims || []).filter(function (c) {
          return c.artistId === g.id && c.status === 'pending' && (c.userId === 'u-devin' || H.admin !== false);
        }).map(function (c) {
          return Object.assign({ userId: c.userId, kind: 'band', role: c.role || '', avatar: '', endorsed: false, pending: true }, P[c.userId], c.userId === 'u-devin' ? { handle: H.handle || '' } : {});
        });
        // (0147) Crew listed while nobody runs the page: on its Crew tab for everyone.
        if (!g.owner) waiting = waiting.concat(((H.ghostCrew || {})[g.id] || []).map(function (m) {
          return Object.assign({ userId: m.userId, kind: 'crew', role: m.role || '', avatar: '', endorsed: true }, P[m.userId], m.userId === 'u-devin' ? { handle: H.handle || '' } : {});
        }));
        // (0158) A bare page's picture from Wikimedia Commons rides the card
        // with its credit and source; see ARTIST PICTURES above.
        return Promise.resolve({ id: g.id, handle: g.handle, name: g.name, bio: '', avatar: g.avatar || '',
          avatarCredit: g.avatarCredit || '', avatarSource: g.avatarSource || '', mine: false,
          // (The check follows the encyclopedia's answer: a page made a moment ago has none until a nudge confirms it.)
          unclaimed: !g.owner, verified: !!g.owner, checkmark: !!g.checked, claimed: !!g.owner, about: g.about || '', country: g.country || '', myClaim: mc ? mc.status : null,
          myClaimCode: mc && mc.status === 'pending' ? (mc.code || null) : null,
          myRequest: rq ? { kind: rq.kind, role: rq.role || '', state: rq.state || 'pending', at: rq.at } : null,
          iFollow: gf, followers: gf ? 1 : 0, members: waiting, tours: [] });
      }
      if (!a) return Promise.resolve(null);
      var fol = (H.artistFollows || []).indexOf(a.id) >= 0;
      return Promise.resolve({ id: a.id, handle: a.handle, name: a.name, bio: a.bio || '', avatar: a.avatar || '',
        avatarCredit: a.avatarCredit || '', avatarSource: a.avatarSource || '', mine: !a.notMine,
        unclaimed: false, verified: !!a.verified || /i see stars/i.test(a.name || ''), checkmark: !!a.verified || /i see stars/i.test(a.name || ''), claimed: !!a.verified || /i see stars/i.test(a.name || ''), about: a.about || '', country: a.country || '', myClaim: null,
        myClaimCode: null, myRequest: null,
        iFollow: fol, followers: (a.followers || 0) + (fol ? 1 : 0),
        members: a.members.filter(function (m) { return !m.leftAt; }).map(function (m) { return Object.assign({ userId: m.userId, kind: m.kind, role: m.role || '', avatar: '', endorsed: !!m.endorsed, leaving: m.leaving || null, settled: m.kind === 'band' && (!!m.endorsed || !!m.settled),
          hasCredits: !!((H.creditRows || {})[a.id + ':' + m.userId] && H.creditRows[a.id + ':' + m.userId].approved) }, P[m.userId], m.userId === 'u-devin' ? { handle: H.handle || '' } : {}); }),
        tours: a.name.toLowerCase() === 'i see stars' ? [{ id: 't1', artist: a.name, name: 'Harness run', first: '2026-09-27', last: '2026-10-04', shows: 4, mine: true }] : [] });
    },
    artistTourCard: function () { return Promise.resolve(null); },
    findArtists: function (text) {
      var H = window.__harness, t = String(text || '').trim().replace(/^@/, '').toLowerCase();
      // Spelled-solid forms count too (spaces and punctuation out), so
      // "iseestars" or "Dreambeach" finds a page whose name carries spaces.
      var solid = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); };
      var ft = solid(t);
      var all = (H.acts || []).map(function (a) { return { id: a.id, name: a.name, handle: a.handle, avatar: a.avatar, mine: true, unclaimed: false, mbid: a.mbid || '', about: '' }; })
        .concat(ghostList().filter(function (g) { return g.checked; }).map(function (g) {
          return { id: g.id, name: g.name, handle: g.handle, avatar: '', mine: false, unclaimed: !g.owner, mbid: g.mbid, about: g.about || '' }; }));
      return Promise.resolve(t.length < 2 ? [] : all.filter(function (a) {
        return a.handle.indexOf(t) === 0 || a.name.toLowerCase().indexOf(t) >= 0 ||
          (ft.length >= 2 && (solid(a.name).indexOf(ft) >= 0 || solid(a.handle).indexOf(ft) === 0));
      }));
    },
    findTours: function (text) {
      var t = String(text || '').trim().toLowerCase();
      var all = [{ id: 'pubt1', artistId: 'pub1', artist: 'Sleeping With Sirens', name: 'Feel Tour', first: '2026-11-03', last: '2026-12-12', shows: 30, mine: false }];
      return Promise.resolve(t.length < 2 ? [] : all.filter(function (x) { return x.name.toLowerCase().indexOf(t) >= 0 || x.artist.toLowerCase().indexOf(t) >= 0; }));
    },
    /* Messages, in memory: one conversation with Brent, his last line unread. */
    dmThreads: function () {
      var H = window.__harness; H.dms = H.dms || [{ id: 'm1', from: 'u-devin', to: 'u-brent', body: 'Load-in is 2 tomorrow', at: new Date(Date.now() - 864e5).toISOString(), read: true }, { id: 'm2', from: 'u-brent', to: 'u-devin', body: 'Got it. Bringing the spare head.', at: new Date(Date.now() - 36e5).toISOString(), read: false }];
      var last = H.dms[H.dms.length - 1];
      return Promise.resolve(H.dms.length ? [{ userId: 'u-brent', name: 'Brent Allen', handle: 'brent', avatar: '', verified: false, last: last.body, at: last.at, fromMe: last.from === 'u-devin',
        unread: H.dms.filter(function (m) { return m.to === 'u-devin' && !m.read; }).length }] : []);
    },
    dmThread: function (uid) {
      var H = window.__harness; if (!H.dms) window.GR_BACKEND.dmThreads();
      return Promise.resolve(uid === 'u-brent' ? H.dms.map(function (m) { return { id: m.id, mine: m.from === 'u-devin', body: m.body, at: m.at, read: m.read }; }) : []);
    },
    dmSend: function (uid, body) {
      var H = window.__harness; if (!H.dms) window.GR_BACKEND.dmThreads();
      if (H.dmFail) return Promise.reject(new Error('offline'));
      H.dms.push({ id: 'm' + Date.now(), from: 'u-devin', to: uid, body: body, at: new Date().toISOString(), read: false });
      return Promise.resolve();
    },
    dmRead: function (uid) { var H = window.__harness; (H.dms || []).forEach(function (m) { if (m.from === uid) m.read = true; }); H.dmReads = (H.dmReads || 0) + 1; return Promise.resolve(); },
    dmWatch: function (fn) { window.__harness.dmPoke = fn; },
    contactOf: function (uid) { return Promise.resolve(uid === 'u-brent' ? { phone: '(313) 555-0142', email: 'brent@example.com' } : { phone: '', email: '' }); },
    flyer: function (tourId) { return Promise.resolve((window.__harness.flyers2 || {})[tourId] || ''); },
    saveFlyer: function (tourId, img) { var H = window.__harness; H.flyers2 = H.flyers2 || {}; H.flyers2[tourId] = img || ''; return Promise.resolve(); },
    /* Tour flyers (0156), the poster above a tour dropdown's dates: the probe
       answers true (set __harness.flyersOff for a build ahead of its
       migration), reads come straight from __harness.tourFlyers, and a save
       keeps the picked file as a data address, as the bucket would keep a
       public one. See TOUR FLYERS above for the hooks. */
    flyersOn: function () { return !window.__harness.flyersOff; },
    tourFlyers: function (artistId) { return (window.__harness.tourFlyers || {})[artistId] || {}; },
    flyerPut: function (artistId, gk, file) {
      var H = window.__harness;
      if (H.flyerFail) return Promise.reject(Object.assign(new Error('offline'), { code: 'offline' }));
      H.tourFlyers = H.tourFlyers || {};
      var m = H.tourFlyers[artistId] = H.tourFlyers[artistId] || {};
      return new Promise(function (res, rej) {
        var r = new FileReader();
        r.onload = function () {
          // (A hand-picked image clears the source receipt, as the real save does.)
          m[gk] = { url: String(r.result), sourceUrl: '' };
          H.flyerPuts = (H.flyerPuts || []).concat([{ artistId: artistId, gk: gk, size: file && file.size }]);
          emit(); res(m[gk].url);
        };
        r.onerror = function () { rej(Object.assign(new Error('unavailable'), { code: 'unavailable' })); };
        r.readAsDataURL(file);
      });
    },
    flyerDrop: function (artistId, gk) {
      var H = window.__harness, m = (H.tourFlyers || {})[artistId];
      if (m) delete m[gk];
      H.flyerDrops = (H.flyerDrops || []).concat([{ artistId: artistId, gk: gk }]);
      emit();
      return Promise.resolve();
    },
    myProfile: function () { return { firstName: me.first_name, lastName: me.last_name, fullName: me.full_name,
      username: me.username, phone: me.phone, tourRole: me.tour_role, email: 'devin@example.com' }; },
    saveProfile: function (p) { me.first_name = p.firstName; me.last_name = p.lastName;
      me.full_name = (p.firstName + ' ' + p.lastName).trim(); me.username = me.full_name;
      me.phone = p.phone; me.tour_role = p.tourRole; window.__harness.saved = JSON.parse(JSON.stringify(me));
      return Promise.resolve(); },
    signOut: function () {},
    members: function () { return Promise.resolve(window.__harness.members); },
    editMember: function (tourId, email, access, ov) {
      window.__harness.edits = (window.__harness.edits || []).concat([[email, access, ov]]);
      window.__harness.crew.forEach(function (c) {
        if (c.invitedEmail !== email) return;
        c.role = access; c.tourRole = ov.tourRole || c.tourRole; c.phone = ov.phone || c.phone; c.email = ov.email || c.email;
      });
      return Promise.resolve();
    },
    kickMember: function (tourId, email) {
      window.__harness.kicked = (window.__harness.kicked || []).concat([email]);
      window.__harness.crew = window.__harness.crew.filter(function (c) { return c.invitedEmail !== email; });
      return Promise.resolve();
    },
    // __harness.inviteFails = 'page-first' (the account came in on a code and its artist page is not
    // confirmed yet) or 'too-many' (the day's limit) refuses the invite the way the real one does.
    // __harness.inviteStatus = 'existing' (that address already has an account) or 'nomail' (the email did
    // not go out): what the invite answers in place of 'sent'.
    invite: function (tourId, email, role, name, phone, extra) {
      var why = window.__harness.inviteFails;
      if (why) return Promise.reject(Object.assign(new Error(String(why)), { code: String(why) }));
      // (The fifth entry is the invite's "Riding on the bus?" answer, 0150.)
      window.__harness.invited.push([email, role, name, (extra || {}).tourRole || '', (extra || {}).ridesBus !== false]);
      // As live (0133): a Manager is stored as editor + manager; anything else is crew.
      var mgr = role === 'manager' || role === 'editor';
      role = mgr ? 'editor' : 'viewer';
      window.__harness.members.push({ invited_email: email, role: role, manager: mgr, display_name: name, user_id: null });
      // Like the real crew list, which reads the same members table.
      window.__harness.crew = window.__harness.crew.concat([{ owner: false, role: role, manager: mgr, name: name || '', email: email,
        invitedEmail: email, phone: phone || '', tourRole: (extra || {}).tourRole || '', joined: false,
        ridesBus: (extra || {}).ridesBus !== false }]);
      return Promise.resolve(window.__harness.inviteStatus || 'sent');
    },
    uninvite: function (tourId, email) {
      window.__harness.kicked = (window.__harness.kicked || []).concat([email]);
      window.__harness.members = window.__harness.members.filter(function (m) { return m.invited_email !== email; });
      window.__harness.crew = window.__harness.crew.filter(function (m) { return m.invitedEmail !== email && m.email !== email; });
      return Promise.resolve();
    },
    atvenuRefresh: function (tourId) { window.__harness.refreshed = (window.__harness.refreshed || 0) + 1;
      return Promise.resolve({ ok: true, reports: 4, added: 0, same: 2, conflicts: 1, noShow: 1 }); },
    pastCrew: function () { return Promise.resolve(window.__harness.past.slice()); },
    forgetPastCrew: function (email) { window.__harness.past = window.__harness.past.filter(function (p) { return p.email !== email; }); return Promise.resolve(); },
    pushSupported: function () { return window.__harness.pushSupported; },
    /* NOTIFICATIONS: what the phone saved comes back on the next open, so
       the rebuilt sheet (every kind its own toggle) and the sign-up's "Turn
       notifications on" screen are tested end to end.
       HOOKS:
         __harness.pushPrefs    the one prefs object the last save sent: every
                                kind's key (loadin, soundcheck, vip, lastcall,
                                stage, stage30, loadout, buscall, sheet,
                                soldout, requests, vote, flowers, chat,
                                payment, buyout, green, received, merchnums)
                                beside the old group.
         __harness.pushOn       whether this phone is signed up.
         __harness.notified     every sendNotify the app fired: [type, data],
                                now including vote, flowers, chat, payment,
                                sheet and buyout.
         __harness.pushSupported = false   the browser cannot (an iPhone
                                Safari tab): the sign-up screen stays away and
                                the sheet explains the home screen. */
    pushState: function () { return Promise.resolve({ on: window.__harness.pushOn, prefs: window.__harness.pushPrefs || {} }); },
    pushEnable: function (prefs) { window.__harness.pushOn = true; window.__harness.pushPrefs = prefs; return Promise.resolve(); },
    ariKick: function (tourId) { window.__harness.ariKicks = (window.__harness.ariKicks || 0) + 1; return Promise.resolve(); },
    pushDisable: function () { window.__harness.pushOn = false; return Promise.resolve(); },
    notify: function (tourId, type, data) { window.__harness.notified.push([type, data]); return Promise.resolve(window.__harness.phones); },
    // Ari's questions, in memory: Yes sets the night's merch, and she answers in the chat.
    asksFor: function (tourId) {
      return (window.__harness.asks || []).filter(function (a) { return a.tour_id === tourId; }).map(function (a) {
        return { id: a.id, noteId: a.note_id, showId: a.show_id, place: a.place, was: a.was, fix: a.fix, status: a.status, at: a.created_at }; });
    },
    // (As ari_answer does: a Yes on a night whose merch is no longer the number she asked about, or a night
    // that is gone, changes nothing and answers 'moved'.)
    ariAnswer: async function (id, yes) {
      var H = window.__harness, a = (H.asks || []).filter(function (x) { return x.id === id; })[0];
      if (!a) return 'gone';
      if (a.status !== 'open') return a.status;
      H.answers = (H.answers || []).concat([[id, !!yes]]);
      var said = 'Okay, leaving ' + a.place + ' at $' + a.was + '.', night = ((tours[a.tour_id] || {}).shows || {})[a.show_id];
      var nowMerch = night && night.income && typeof night.income.merch === 'number' ? night.income.merch : 0;
      var moved = yes && (!night || Math.round(nowMerch * 100) !== Math.round(Number(a.was) * 100));
      if (moved) said = a.place + ' merch is $' + nowMerch + ' now, not the $' + a.was + ' I asked about, so I left it alone.';
      else if (yes) {
        var db = await window.claude.use('db'), sh = {};
        sh[a.show_id] = { income: { merch: a.fix } };
        await db.doc('tours/' + a.tour_id).update({ shows: sh });
        said = 'Done. ' + a.place + ' merch is now $' + a.fix + ' (it was $' + a.was + ').';
      }
      a.status = moved ? 'moved' : yes ? 'fixed' : 'left';
      H.notes.push({ id: 'n-ans-' + id, day: 'chat', body: said, author: 'Ari', at: Date.now() });
      return a.status;
    },
    // As the table does: the note's day, the account that wrote it and when; the chat and a night's notes kept apart.
    saveNote: function (tourId, day, note) { window.__harness.notes.push(Object.assign({ day: day, addedBy: 'u-devin', at: Date.now() }, note)); return Promise.resolve(); },
    notesFor: function (tourId, day) { return window.__harness.notes.filter(function (n) { return !day || !n.day || n.day === day; }); },
    // A Crew phone deletes only its own; the tour's leads delete anyone's.
    removeNote: function (id) {
      var H = window.__harness, n = H.notes.filter(function (x) { return x.id === id; })[0];
      if (!n || (H.asCrew && n.addedBy !== 'u-devin')) return Promise.reject(Object.assign(new Error('permission'), { code: 'permission' }));
      H.notes = H.notes.filter(function (x) { return x.id !== id; });
      return Promise.resolve();
    },
    // The guest list, in memory (see THE GUEST LIST near the top): the same
    // shapes and the same who-may-touch-it line the real table enforces.
    guestsFor: function (tourId, showId) {
      return (window.__harness.guests || []).filter(function (g) { return g.tour_id === tourId && g.show_id === showId; })
        .map(function (g) {
          return { id: g.id, firstName: g.first_name, lastName: g.last_name, affiliation: g.affiliation,
            email: g.email, phone: g.phone, qty: g.qty, passType: g.pass_type, addedBy: g.added_by, at: g.created_at };
        });
    },
    saveGuest: function (tourId, showId, guest) {
      var H = window.__harness, list = H.guests = H.guests || [];
      var row = list.filter(function (g) { return g.id === guest.id; })[0];
      if (row && H.asCrew && row.added_by !== 'u-devin') {
        return Promise.reject(Object.assign(new Error('permission'), { code: 'permission' }));
      }
      if (!row) { row = { id: guest.id, tour_id: tourId, show_id: showId, added_by: 'u-devin', created_at: Date.now() }; list.push(row); }
      row.first_name = guest.firstName; row.last_name = guest.lastName; row.affiliation = guest.affiliation;
      row.email = guest.email; row.phone = guest.phone; row.qty = guest.qty; row.pass_type = guest.passType;
      return Promise.resolve();
    },
    removeGuest: function (guestId) {
      var H = window.__harness, list = H.guests = H.guests || [];
      var row = list.filter(function (g) { return g.id === guestId; })[0];
      if (!row || (H.asCrew && row.added_by !== 'u-devin')) {
        return Promise.reject(Object.assign(new Error('permission'), { code: 'permission' }));
      }
      H.guests = list.filter(function (g) { return g.id !== guestId; });
      return Promise.resolve();
    },
    // A fake card feed: the pile, the switch and the account choices, all in memory.
    feedWatch: function (fn) { window.__harness.feedFns.push(fn); setTimeout(function () { fn(window.__harness.feedState()); }, 0); },
    // The app's one function for "something of yours changed" (0144): called by __harness.poke and the hooks built on it.
    socialWatch: function (fn) { window.__harness.socialFn = fn; },
    feedCall: function (action, body) {
      var F = window.__harness.feed;
      window.__harness.calls.push([action, JSON.parse(JSON.stringify(body || {}))]);
      // The shared pile (owner or tour manager) and filing it once, like the server.
      if (action === 'pile') {
        if (window.__harness.pileDenied) return Promise.resolve({ error: 'not_allowed' });
        var cards = {};
        F.accounts.forEach(function (a) { cards[a.name] = a.type === 'creditCard' ? 'credit' : 'debit'; });
        // (The newer bank feed counts a row on a taken-down tour as a no-tour row for the cards' owner only: a
        // Manager who is not the owner is never handed it. It says how many wait in all to the owner, and says
        // how the last read of the owner's banks ended: feedStatus, one word, no bank's name.)
        var pileMine = !(window.__harness.asTM || window.__harness.asManager);
        var pile = { ok: true, connected: true, switchedOn: !!F.row.switched_on, lastRun: F.row.last_run, cards: cards,
          mine: pileMine, items: F.items.filter(function (it) {
            return !it.tour_id || it.tour_id === body.tourId || (pileMine && !window.__harness.oldFeed && tourGone(it.tour_id)); }) };
        if (pileMine) pile.total = F.items.length;
        if (!window.__harness.oldFeed) pile.feedStatus = lastStatusNow();
        return Promise.resolve(pile);
      }
      /* THE SORTING SHEET'S SAVES (Add, ADD n, set aside). Switches, all on window.__harness:
           fileSlow = 1500       every save takes that many milliseconds to answer, as on a weak signal, so Add
                                 can be tapped on other rows while one is out.       Or open with  ?fileslow=1500
           fileFail = 'offline'  saves are not done, and answer as the real thing does when it fails: 'offline'
                                 (no answer got through), 'save_failed', 'not_allowed', or any other word (an
                                 error by that name). fileFail = 2 : only the next two fail ('save_failed'),
                                 then saves go through again.                        Or  ?filefail=offline
           fileAsks              how many saves were asked for (Adds tapped while one is out go together as one).
         Like the server, a save is refused whole (bad_category, nothing filed) when a charge is to be kept
         under a category the pile's own book does not have. */
      if (action === 'file') {
        var Hf = window.__harness;
        // (The address can set them too, unless they were set by hand: read once, at the first save.)
        if (!Hf.fileAsks) {
          var fileQ = ''; try { fileQ = String(location.search || ''); } catch (e) { fileQ = ''; }
          var fileSlowQ = /[?&]fileslow=(\d{1,5})\b/.exec(fileQ), fileFailQ = /[?&]filefail=([a-z_]{1,24})\b/.exec(fileQ);
          if (fileSlowQ && Hf.fileSlow == null) Hf.fileSlow = Number(fileSlowQ[1]);
          if (fileFailQ && Hf.fileFail == null) Hf.fileFail = fileFailQ[1];
        }
        var fileWait = Number(Hf.fileSlow) || 0;
        Hf.fileAsks = (Hf.fileAsks || 0) + 1;
        var fileAnswer = function () {
          var fail = Hf.fileFail;
          if (fail) {
            if (typeof fail === 'number') { Hf.fileFail = fail > 1 ? fail - 1 : 0; fail = 'save_failed'; }
            if (fail === true) fail = 'save_failed';
            return Promise.resolve(fail === 'save_failed' ? { ok: false, status: 'save_failed' } : { error: String(fail) });
          }
          var okCat = {};
          window.GR.chargeCategoriesFor(tours[body.tourId] || {}).forEach(function (c) { okCat[c.key] = true; });
          delete okCat.offdebt;
          if ((body.picks || []).some(function (pk) { return pk.keep && !okCat[String(pk.category == null ? '' : pk.category)]; })) {
            return Promise.resolve({ error: 'bad_category' });
          }
          return fileNow();
        };
        return fileWait > 0 ? new Promise(function (res) { setTimeout(function () { fileAnswer().then(res); }, fileWait); }) : fileAnswer();
      }
      function fileNow() {
        // Like the server: each charge where it's pointed (H.offTourId / H.nextTourId
        // stand in for the band's Off Tour book and next tour).
        var H = window.__harness;
        var picks = body.picks || [], adds = {}, filed = 0, skipped = 0, already = 0, refused = 0, total = 0, now = Date.now(), offN = 0, nextN = 0;
        var into = function (tid, key, ch) { adds[tid] = adds[tid] || {}; adds[tid][key] = ch; };
        var oldFeed = !!H.oldFeed;
        picks.forEach(function (pk, i) {
          var it = F.items.filter(function (x) { return x.id === pk.id; })[0];
          if (!it) { already += 1; return; }
          // The older bank feed only takes a row from its own tour's pile: one on a taken-down tour is
          // answered "already" and stays waiting. (The newer one takes it as a no-tour row.)
          if (it.tour_id && it.tour_id !== body.tourId && (oldFeed || !tourGone(it.tour_id))) { already += 1; return; }
          // The newer bank feed sets a charge aside only for a request marked by: 'hand'; any other is left waiting.
          if (!pk.keep && !oldFeed && body.by !== 'hand') { refused += 1; return; }
          F.items = F.items.filter(function (x) { return x.id !== pk.id; });
          if (pk.keep) { H.filedItems = H.filedItems || {}; H.filedItems[it.id] = it; }
          if (!pk.keep) {
            // Set aside: kept, with why and when (the older bank feed keeps neither), for "Left out and set aside".
            outRows().push({ id: it.id, tour_id: it.tour_id || null, date: it.date, posted: it.date, merchant: it.merchant, amount: it.amount,
              account: it.account, why: it.why || '', status: 'skipped', bank_amount: null, gone_on: null,
              reason: oldFeed ? null : (pk.reason === 'same_as_typed' || pk.reason === 'paid_back' ? pk.reason : 'set_aside'),
              decided_at: oldFeed ? null : new Date().toISOString() });
            skipped += 1; return;
          }
          var acct = F.accounts.filter(function (a) { return a.name === it.account; })[0];
          var ch = { date: it.date, merchant: it.merchant, amount: it.amount, category: pk.category, accounted: !!pk.accounted,
            account: it.account, importId: 'review-' + now, createdAt: now + i, paid: !(acct && acct.type === 'creditCard'),
            by: H.asTM ? 'Brent Allen' : 'Devin Oliver' };
          if (pk.dest === 'next' && H.nextTourId) { into(H.nextTourId, 'p' + it.id, ch); nextN += 1; }
          else if (pk.dest === 'tour' && pk.to && pk.to !== body.tourId) {
            into(pk.to, 'p' + it.id, ch); nextN += 1;
            H.away = H.away || {}; H.away['p' + it.id] = { account: it.account, amount: it.amount, date: it.date, posted: it.date, to: pk.to };
          }
          else if (pk.dest === 'off' && H.offTourId && body.tourId !== H.offTourId) {
            into(H.offTourId, 'p' + it.id, Object.assign({}, ch, { fromTour: body.tourId }));
            into(body.tourId, 'p' + it.id, Object.assign({}, ch, { category: 'offdebt', offTour: true, offCategory: pk.category }));
            offN += 1;
          } else into(body.tourId, 'p' + it.id, ch);
          filed += 1; if (!pk.accounted) total += it.amount;
        });
        H.filedPicks = (H.filedPicks || []).concat([picks]);
        H.feedPush();
        return window.claude.use('db').then(function (db) {
          if (H.away && Object.keys(H.away).length) { var aw = H.away; H.away = null; adds.__away = { tid: body.tourId, away: aw }; }
          var awayNote = adds.__away; delete adds.__away;
          if (awayNote) db.doc('tours/' + awayNote.tid).update({ cardAway: awayNote.away });
          return Promise.all(Object.keys(adds).map(function (tid) {
            var imp = {}; imp['review-' + now] = { createdAt: now, count: Object.keys(adds[tid]).length, total: 0, source: 'Card feed' };
            return db.doc('tours/' + tid).update({ charges: adds[tid], imports: imp });
          }));
        }).then(function () { return Object.assign({ ok: true, filed: filed, skipped: skipped, already: already, offTour: offN, upcoming: nextN,
          total: Math.round(total * 100) / 100 }, oldFeed ? {} : { refused: refused }); });
      }
      // Undo, like the server: off every tour it landed on, back in the pile.
      if (action === 'unfile') {
        var H2 = window.__harness, fid = String((body && body.id) || '').replace(/^p/, '');
        var back = (H2.filedItems || {})[fid];
        if (!back) return Promise.resolve({ ok: false, status: 'not_filed' });
        delete H2.filedItems[fid];
        return window.claude.use('db').then(function (db) {
          var key = 'p' + fid;
          var tids = ['t1'].concat([H2.offTourId, H2.nextTourId].filter(Boolean));
          // (And any other tour or Off Tour book that holds it: one filed from the book's own screen, or sent on to the next tour.)
          Object.keys(tours).forEach(function (tid) { if (tids.indexOf(tid) < 0 && tours[tid] && tours[tid].charges && tours[tid].charges[key]) tids.push(tid); });
          return Promise.all(tids.map(function (tid) {
            var c = {}; c[key] = null; var aw = {}; aw[key] = null;
            return db.doc('tours/' + tid).update({ charges: c, cardAway: aw });
          }));
        }).then(function () {
          F.items.push(Object.assign({}, back, { tour_id: body.tourId }));
          H2.feedPush();
          return { ok: true, tourId: body.tourId };
        });
      }
      // Plaid's shape: banks, accounts, test mode.
      // Plaid's hosted window: 'finish' says waiting until the harness sets plaidDone.
      if (action === 'link') { window.__harness.plaidDone = null; return Promise.resolve({ ok: true, url: 'about:blank#plaid-harness', test: true }); }
      if (action === 'finish') {
        var done = window.__harness.plaidDone;
        if (!done) return Promise.resolve({ ok: true, state: 'waiting' });
        window.__harness.plaidDone = null;
        return Promise.resolve(done === 'connected' ? { ok: true, state: 'connected', institutions: ['First Platypus Bank'], test: true } : { ok: true, state: done });
      }
      if (action === 'disconnect' && body && body.itemId) {
        F.banks = F.banks.filter(function (b) { return b.id !== body.itemId; });
        // Like the server: with the last bank goes every charge still waiting, and the feed itself.
        if (!F.banks.length) { F.items = []; window.__harness.feedFns.forEach(function (fn) { fn({ row: null, items: [], connectOnly: true }); }); }
        return Promise.resolve({ ok: true, left: F.banks.length });
      }
      if (action === 'disconnect') { window.__harness.feedFns.forEach(function (fn) { fn({ row: null, items: [], connectOnly: true }); }); return Promise.resolve({ ok: true }); }
      // No feed at all (noFeed, notAllowed): the answer says whether this account may connect a bank.
      if (action === 'status' && (window.__harness.noFeed || window.__harness.notAllowed)) {
        return Promise.resolve({ ok: true, source: null, needsConnect: true, test: !F.live, allowed: !window.__harness.notAllowed });
      }
      // F.live: answer as the real thing does (not Plaid's test mode), for trying the Cards tab.
      if (action === 'status') return Promise.resolve({ ok: true, source: 'plaid', test: !F.live, switchedOn: F.row.switched_on,
        since: F.row.since, lastRun: F.row.last_run, lastStatus: 'ok', banks: JSON.parse(JSON.stringify(F.banks)),
        needsConnect: !F.banks.length,
        accounts: F.accounts.map(function (a) {
          var plaidCard = a.type === 'creditCard' ? 'credit' : 'debit';
          return { id: a.id, name: a.name, type: a.type, mode: a.mode, bank: a.bank, card: a.card || plaidCard, plaidCard: plaidCard,
            income: a.income || [], asked: !!a.asked };
        }) });
      // One account's answers, as the server keeps them.
      if (action === 'setup' && body && body.account) {
        F.accounts.forEach(function (a) {
          if (a.id !== body.account.id) return;
          a.card = body.account.card; a.mode = body.account.mode; a.income = body.account.income; a.asked = true;
        });
      }
      // Credit card balances, read when logging starts on a tour.
      if (action === 'balances') return Promise.resolve({ ok: true, test: false, balances: F.accounts.filter(function (a) {
        return (a.card || (a.type === 'creditCard' ? 'credit' : 'debit')) === 'credit' && a.mode !== 'off';
      }).map(function (a, i) { return { id: a.id, name: a.name, balance: i ? 4210.55 : 27000,
        bank: (F.banks.filter(function (b) { return b.id === a.bank; })[0] || {}).name || '' }; }) });
      if (action === 'setup' && typeof body.merchAccount === 'string') F.merchAccount = body.merchAccount;
      if (action === 'setup' && body.plan) { F.row.plan_name = body.plan === 'p1' ? 'I SEE STARS' : 'Personal Plan'; }
      if (action === 'setup') {
        Object.keys(body.modes || {}).forEach(function (id) { F.accounts.forEach(function (a) { if (a.id === id) a.mode = body.modes[id]; }); });
        if (body.on === true) { F.row.switched_on = true; F.row.since = body.since; }
        if (body.on === false) F.row.switched_on = false;
      }
      /* Catch up (sync with catchup: true): the counts of one read from the start. The three sent
         rows it speaks of are in the pile from the beginning (z1, w1, x1). __harness.catchupOld = true
         answers like a server that does not know the word; __harness.catchupFail = true like a request
         that got no answer (a string instead, say 'ITEM_LOGIN_REQUIRED', like a bank that refused);
         __harness.catchupReply, when set, is answered as it is (zeros, for a phone that asked twice);
         __harness.catchupSlow waits that many ms first.
         The newer bank feed also says what the bank handed over and where each line went (ledger: it adds up to
         sent); with __harness.oldFeed there is none. __harness.linesMissing: its count did not add up, so it
         answers lines_missing (what could be stored is in). */
      if (action === 'sync' && body && body.catchup === true) {
        var Hc = window.__harness, ans;
        if (Hc.catchupFail) ans = typeof Hc.catchupFail === 'string' ? { ok: false, status: Hc.catchupFail } : { error: 'offline' };
        else {
          F.row.last_run = new Date().toISOString();
          ans = Hc.catchupOld ? { ok: true, status: 'ok', filed: 0, waiting: 0 }
            : (Hc.catchupReply || { ok: true, status: 'ok', waiting: 3, filed: 0, catchup: true,
              found: { zelle: 1, wire: 1, transfer: 1, other: 0, maybe: 0, from: '2026-10-02', to: '2026-10-08' } });
          if (!Hc.catchupOld && !Hc.catchupReply && !Hc.oldFeed) {
            ans.ledger = { sent: 412, already: 300, waiting: 3, filed: 0, left_out: 88, not_kept: 21, unexplained: 0 };
            if (Hc.linesMissing) { ans.ok = false; ans.status = 'lines_missing'; ans.ledger.already = 298; ans.ledger.unexplained = 2; }
          }
        }
        return new Promise(function (res) { setTimeout(function () { Hc.feedPush(); res(ans); }, Hc.catchupSlow > 0 ? Hc.catchupSlow : 0); });
      }
      if (action === 'sync') F.row.last_run = new Date().toISOString();
      window.__harness.feedPush();
      if (action === 'sync' && window.__harness.linesMissing && !window.__harness.syncReply) return Promise.resolve({ ok: false, status: 'lines_missing' });
      return Promise.resolve(action === 'sync' ? (window.__harness.syncReply || { ok: true, status: 'ok', test: true, seen: 16, filed: 3, waiting: 10 }) : { ok: true });
    },
    /* Every bank line accounted for (0136), as the real backend answers it; the switches are listed
       above (at outRows). Each answers null when it "could not be read". accountSlow: ms to wait first. */
    feedRead: function () { window.__harness.feedPush(); return Promise.resolve(); },
    feedAccount: function () {
      var H = window.__harness;
      H.accountCalls = (H.accountCalls || 0) + 1;
      var ans = H.accountFail ? null : H.account ? JSON.parse(JSON.stringify(H.account)) : fakeAccount();
      return new Promise(function (res) { setTimeout(function () { res(ans); }, H.accountSlow > 0 ? H.accountSlow : 30); });
    },
    // (after: { date, id } of the last line in hand: the page starts just past it, newest first, as the real
    // one does, and the page number is not used. leftOutCalls keeps what was asked.)
    feedLeftOut: function (status, reason, page, after) {
      var H = window.__harness;
      H.leftOutCalls = (H.leftOutCalls || []).concat([[status, reason, page, after ? { date: after.date, id: after.id } : null]]);
      if (H.leftOutFail) return Promise.resolve(null);
      var st = status === 'skipped' ? 'skipped' : 'left_out', from = Math.max(0, Math.round(Number(page)) || 0) * 100;
      var rows = outRows().filter(function (r) { return r.status === st && (!reason || r.reason === reason); })
        .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || String(a.id).localeCompare(String(b.id)); });
      if (after && after.date && after.id != null) {
        from = 0;
        rows = rows.filter(function (r) {
          return String(r.date) < String(after.date) || (String(r.date) === String(after.date) && String(r.id).localeCompare(String(after.id)) > 0);
        });
      }
      return Promise.resolve(JSON.parse(JSON.stringify(rows.slice(from, from + 100))));
    },
    // Back to waiting, as feed_put_back does it: left out (never one the bank took back) or set aside; a row
    // marked filed only when no tour holds it. A line the bank has withdrawn (gone_on) stays where it is. The
    // line keeps its warning: "Put back: " and what it was left out for; "Maybe already in" again for one set
    // aside as the one he typed; any other set-aside keeps its words. It takes the bank's latest figure.
    // Answers how many moved.
    feedPutBack: function (ids) {
      var H = window.__harness, F = H.feed, n = 0;
      H.putBacks = (H.putBacks || []).concat([(ids || []).slice()]);
      if (H.putBackFail) return Promise.resolve(null);
      if (H.putBackNone) return Promise.resolve(0);
      (ids || []).forEach(function (id) {
        var r = outRows().filter(function (x) { return x.id === id; })[0];
        if (!r) return;
        var orphan = r.status === 'filed' && !tourHolds(r.id);
        if (r.gone_on || !((r.status === 'left_out' && r.reason !== 'bank_removed') || r.status === 'skipped' || orphan)) return;
        H.out = H.out.filter(function (x) { return x !== r; });
        F.items.push({ id: r.id, tour_id: r.tour_id || null, date: r.date, merchant: r.merchant, category: null, account: r.account,
          amount: r.bank_amount != null ? r.bank_amount : r.amount,
          why: orphan ? 'Put back: it was on no tour'
            : r.status === 'left_out' ? (r.why ? 'Put back: ' + r.why : 'Put back')
            : r.reason === 'same_as_typed' ? 'Maybe already in' : (r.why || '') });
        n += 1;
      });
      H.feedPush();
      return Promise.resolve(n);
    },
    feedLook: function (wantFiled) {
      var H = window.__harness, out = outRows();
      if (H.leftOutFail) return Promise.resolve(null);
      var filed = Object.keys(H.filedItems || {}).map(function (k) { var it = H.filedItems[k];
        return { id: it.id, tour_id: it.tour_id || 't1', date: it.date, merchant: it.merchant, amount: it.amount, account: it.account, gone_on: null }; })
        .concat(out.filter(function (r) { return r.status === 'filed'; }));
      return Promise.resolve(JSON.parse(JSON.stringify({
        gone: out.filter(function (r) { return r.gone_on && r.status !== 'left_out'; }),
        changed: out.filter(function (r) { return r.bank_amount != null && Math.round(r.bank_amount * 100) !== Math.round(r.amount * 100); }),
        filed: wantFiled ? filed : null })));
    },
    // backend.js's own picker (lifted in above, not a copy): the crew roles, "Other" and its line to type in.
    openRolePicker: shared.openRolePicker
  };
})();
</script>
"""
assert shim.count('/*SHARED-SCREENS*/') == 1, 'the place for the shared screens is missing from the shim'
shim = shim.replace('/*SHARED-SCREENS*/', shared)
out = page.replace('<script src="core.js"></script>', shim + '<script src="core.js"></script>')
assert out != page, 'core.js tag not found'
(ROOT / 'src/_dbstub.html').write_text(out, encoding='utf-8')
print('src/_dbstub.html written')
