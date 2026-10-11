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
        k2: { id: 'k2', date: ymd(new Date(today.getTime() - 3 * 864e5)), category: 'gas', amount: 85.5, note: 'Fill up' } } }
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
  // A fake reader: flyers come from __harness.flyers (one list per read);
  // anything else reads as nothing.
  var fakeSample = function () { return Promise.resolve({ text: '' }); };
  fakeSample.json = function (prompt) {
    window.__harness.reads = (window.__harness.reads || 0) + 1;
    if (/concert tour flyer/.test(String(prompt))) return Promise.resolve((window.__harness.flyers || []).shift() || []);
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
    creditStore()[iss.id + ':u-brent'] = { approved: null, pending: { picks: [{ key: 'TRHS', mode: 'all' },
      { key: 'TJTL RNKT', mode: 'shows', shows: ['TJTL RNKT#0', 'TJTL RNKT#1'] }], until: '2026-10-07' },
      submittedAt: new Date(Date.now() - 36e5).toISOString(), declinedAt: null };
  }
  function creditExpand(claim) {
    if (!claim) return [];
    return CREDIT_TOURS.map(function (g) {
      var n = 0;
      if (claim.all) n = g.n;
      else (claim.picks || []).forEach(function (p) { if (p.key === g.key) n = p.mode === 'shows' ? (p.shows || []).length : g.n; });
      return n ? { key: g.key, name: g.name, year: g.year, total: g.n, n: n, first: g.first, last: g.last } : null;
    }).filter(Boolean);
  }
  function creditCount(claim) {
    var l = creditExpand(claim);
    return { tours: l.filter(function (g) { return !g.year; }).length, shows: l.reduce(function (n, g) { return n + g.n; }, 0) };
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
        if (!g.year) out.list.push({ artistId: aid, artist: iss ? iss.name : 'Artist', key: g.key, name: g.name, n: g.n, first: g.first, last: g.last, kind: 'tour' });
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
  // A Manager who did not create the tour (tour role Tour Manager): __harness.asManager = true before the tour is opened, or ?manager.
  try { if (/[?&]manager\b/.test(String(location.search || ''))) window.__harness.asManager = true; } catch (e) { /* no address to read */ }
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
     on, live mode, and this tour given card dates), then open the tour's
     Budget, Cards/Links. The lines sit under Refresh Card; "Left out and set
     aside" opens the sheet; the Tasks button carries "Bank lines".
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
     back), filedPicks and calls (every card call with its body: by and each pick's reason are there). */
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
     it signs nobody out: it sets __harness.legalSignedOut and takes the pages down. */
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
    facesFor: function () { return {}; },
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
          st.status = 'done'; st.eta = 0; st.detail = 'Read 6 articles: 2 tours found, 2 new, 1 added to the page';
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
      st.status = 'done'; st.eta = 0; st.added = (cands || []).length;
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
       anything whole-tour lands in doc.otherIncome; skip just clears it. */
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
      H.catalogued = (H.catalogued || []).concat([{ id: depId, tourId: o.tourId || null, showId: o.showId || null, kind: o.kind }]);
      var dep = (H.deposits || []).filter(function (d) { return d.id === depId; })[0];
      if (!dep) return { ok: false, why: 'gone' };
      if (dep.matched) return { ok: false, why: 'done' };
      if (['merch', 'merch_later', 'guarantee', 'guarantee_later', 'royalties', 'advance', 'skip'].indexOf(o.kind) < 0) throw new Error('what kind');
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
      await db.doc('tours/' + o.tourId).update({ otherIncome: oi });
      return { ok: true };
    },
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
    profileCard: function (uid) {
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
      if (uid === 'u-devin') return Promise.resolve(Object.assign({ userId: uid, name: me.full_name, handle: H.handle || '', verified: true, bio: so.bio || '', roles: so.roles || [], tourRole: me.tour_role, avatar: so.photo || '', artists: so.artists || [],
        // The pages that list the test Devin (his own included), then the ones that only endorsed him.
        acts: (H.acts || []).filter(function (x) { return x.members.some(function (m) { return m.userId === 'u-devin'; }); }).map(function (x) {
          var m = x.members.filter(function (y) { return y.userId === 'u-devin'; })[0];
          return { id: x.id, name: x.name, handle: x.handle, avatar: x.avatar, kind: m.kind, role: m.role || '', endorsed: !!m.endorsed, mine: true, declined: false, past: m.leftAt ? true : undefined, until: m.leftAt || null }; }).concat(devinActs()),
        flowers: 2, endorsements: devinActs().length + (H.acts || []).filter(function (x) { return x.members.some(function (m) { return m.userId === 'u-devin' && m.endorsed; }); }).length,
        roadStats: H.roadStats || (function () { try { return JSON.parse(localStorage.getItem('gr_h_road') || 'null'); } catch (e) { return null; } })() || (function () { var c = creditSums('u-devin'); return { tours: 1 + c.tours, shows: 15 + c.shows, countries: 1 + (c.shows ? 3 : 0), cities: 15 + c.shows, firstYear: c.first || 2026 }; })(),
        credits: creditSums('u-devin').credits, creditTours: creditSums('u-devin').list,
        tours: [{ id: 't1', artist: 'I See Stars', name: 'Harness run', first: '2026-09-27', last: '2026-10-04', shows: 4, mine: true }], logos: {} }, base));
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
        H.acts.push({ id: g.id, handle: slug, name: g.name, avatar: '', bio: '', members: [], mbid: g.mbid, verified: true, about: g.about, country: g.country });
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
      return Promise.resolve(H.acts.map(function (a) { return { id: a.id, handle: a.handle, name: a.name, avatar: a.avatar, mine: true, kind: null }; }));
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
      var k = kind === 'crew' ? 'crew' : 'band', r = String(role || '').trim().slice(0, 40);
      var a = (H.acts || []).filter(function (x) { return x.id === artistId; })[0];
      if (a && a.members.some(function (m) { return m.userId === 'u-devin' && !m.leftAt; })) return Promise.resolve({ ok: false, why: 'listed' });
      if (H.requestWhy) return Promise.resolve({ ok: false, why: H.requestWhy });
      var waiting = H.artistRequests.filter(function (x) { return x.userId === 'u-devin' && x.state === 'pending' && x.artistId !== artistId; });
      if (waiting.length >= 10) return Promise.resolve({ ok: false, why: 'many' });
      if (a) {
        a.members = a.members.filter(function (m) { return m.userId !== 'u-devin'; }).concat([{ userId: 'u-devin', kind: k, role: r }]);
        return Promise.resolve({ ok: true, listed: true });
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
      if (a) a.members.forEach(function (m) { if (m.userId === uid) m.role = String(role || '').trim().slice(0, 40); });
      return Promise.resolve();
    },
    /* Tour credits. The test user runs every test artist, so their own claim
       approves itself; set __harness.creditNotOwner to see it wait instead. */
    creditAsks: function () {
      var H = window.__harness, iss = creditIss(); creditSeed();
      if (!iss) return Promise.resolve([]);
      var me = iss.members.filter(function (m) { return m.userId === 'u-devin'; })[0];
      if (!me || !me.endorsed) return Promise.resolve([]);
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
      var mine = (H.acts || []).map(function (a) { return a.id; });
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
      return Promise.resolve({ id: p.id, name: p.name, city: p.city, region: { Austin: 'TX', Detroit: 'MI', Cleveland: 'OH', 'Lake Buena Vista': 'FL' }[p.city] || '',
        country: { US: 'United States', GB: 'United Kingdom', CA: 'Canada', IE: 'Ireland' }[p.cc] || p.cc,
        address: p.name === 'Mohawk' ? '912 Red River St, Austin, TX 78701' : '', phone: '', unclaimed: true,
        shows: played.reduce(function (n, x) { return n + x.n; }, 0), firstYear: played.length ? 2012 : null, lastYear: played.length ? 2024 : null,
        artists: played, workers: (H.placeWork || []).filter(function (x) { return x.kind === 'venue' && x.id === id; }).length,
        myWork: w ? { role: w.role, state: w.state } : null });
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
        return Promise.resolve({ id: g.id, handle: g.handle, name: g.name, bio: '', avatar: '', mine: false,
          // (The check follows the encyclopedia's answer: a page made a moment ago has none until a nudge confirms it.)
          unclaimed: !g.owner, verified: !!g.owner, checkmark: !!g.checked, claimed: !!g.owner, about: g.about || '', country: g.country || '', myClaim: mc ? mc.status : null,
          myClaimCode: mc && mc.status === 'pending' ? (mc.code || null) : null,
          myRequest: rq ? { kind: rq.kind, role: rq.role || '', state: rq.state || 'pending', at: rq.at } : null,
          iFollow: gf, followers: gf ? 1 : 0, members: waiting, tours: [] });
      }
      if (!a) return Promise.resolve(null);
      var fol = (H.artistFollows || []).indexOf(a.id) >= 0;
      return Promise.resolve({ id: a.id, handle: a.handle, name: a.name, bio: a.bio || '', avatar: a.avatar || '', mine: true,
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
      var all = (H.acts || []).map(function (a) { return { id: a.id, name: a.name, handle: a.handle, avatar: a.avatar, mine: true, unclaimed: false, mbid: a.mbid || '', about: '' }; })
        .concat(ghostList().filter(function (g) { return g.checked; }).map(function (g) {
          return { id: g.id, name: g.name, handle: g.handle, avatar: '', mine: false, unclaimed: !g.owner, mbid: g.mbid, about: g.about || '' }; }));
      return Promise.resolve(t.length < 2 ? [] : all.filter(function (a) { return a.handle.indexOf(t) === 0 || a.name.toLowerCase().indexOf(t) >= 0; }));
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
      window.__harness.invited.push([email, role, name, (extra || {}).tourRole || '']);
      // As live (0133): a Manager is stored as editor + manager; anything else is crew.
      var mgr = role === 'manager' || role === 'editor';
      role = mgr ? 'editor' : 'viewer';
      window.__harness.members.push({ invited_email: email, role: role, manager: mgr, display_name: name, user_id: null });
      // Like the real crew list, which reads the same members table.
      window.__harness.crew = window.__harness.crew.concat([{ owner: false, role: role, manager: mgr, name: name || '', email: email,
        invitedEmail: email, phone: phone || '', tourRole: (extra || {}).tourRole || '', joined: false }]);
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
    pushState: function () { return Promise.resolve({ on: window.__harness.pushOn, prefs: {} }); },
    pushEnable: function (prefs) { window.__harness.pushOn = true; window.__harness.pushPrefs = prefs; return Promise.resolve(); },
    ariKick: function (tourId) { window.__harness.ariKicks = (window.__harness.ariKicks || 0) + 1; return Promise.resolve(); },
    pushDisable: function () { window.__harness.pushOn = false; return Promise.resolve(); },
    notify: function (tourId, type, data) { window.__harness.notified.push([type, data]); return Promise.resolve(window.__harness.phones); },
    // Ari's questions, in memory: Yes sets the night's merch, and she answers in the chat.
    asksFor: function (tourId) {
      return (window.__harness.asks || []).filter(function (a) { return a.tour_id === tourId; }).map(function (a) {
        return { id: a.id, noteId: a.note_id, showId: a.show_id, place: a.place, was: a.was, fix: a.fix, status: a.status }; });
    },
    ariAnswer: async function (id, yes) {
      var H = window.__harness, a = (H.asks || []).filter(function (x) { return x.id === id; })[0];
      if (!a) return 'gone';
      if (a.status !== 'open') return a.status;
      H.answers = (H.answers || []).concat([[id, !!yes]]);
      var said = 'Okay, leaving ' + a.place + ' at $' + a.was + '.';
      if (yes) {
        var db = await window.claude.use('db'), sh = {};
        sh[a.show_id] = { income: { merch: a.fix } };
        await db.doc('tours/' + a.tour_id).update({ shows: sh });
        said = 'Done. ' + a.place + ' merch is now $' + a.fix + ' (it was $' + a.was + ').';
      }
      a.status = yes ? 'fixed' : 'left';
      H.notes.push({ id: 'n-ans-' + id, day: 'chat', body: said, author: 'Ari', at: Date.now() });
      return a.status;
    },
    saveNote: function (tourId, day, note) { window.__harness.notes.push(note); return Promise.resolve(); },
    notesFor: function () { return window.__harness.notes; },
    // A fake card feed: the pile, the switch and the account choices, all in memory.
    feedWatch: function (fn) { window.__harness.feedFns.push(fn); setTimeout(function () { fn(window.__harness.feedState()); }, 0); },
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
      if (action === 'file') {
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
