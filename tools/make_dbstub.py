"""Builds src/_dbstub.html: the real app in 'db' (signed-in) mode against an
in-memory fake backend, so account/crew UI can be tested locally without
signing anything into the live Supabase project. Run after build.py."""
import pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
page = (ROOT / 'src/index.html').read_text(encoding='utf-8')
shim = r"""<script>
/* ---- fake signed-in backend (dev only) ---- */
(function () {
  var today = new Date();
  var ymd = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  var tours = {
    t1: { name: 'Harness run', artist: 'I See Stars', setupDone: true, setupStep: 5, createdAt: 1,
      // Real-tour-sized numbers, so the Expenses Total row is tested at full width.
      expenses: { bus: { projected: 85000 }, hotels: { projected: 23400 }, food: { projected: 12500 },
        gas: { projected: 9800 }, flights: { projected: 18250 } }, commission: {}, crew: {},
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
        u6: { id: 'u6', date: ymd(new Date(today.getTime() - 5 * 864e5)), merchant: 'Extra Space 1234', amount: 164, category: 'utilities', manual: true, paid: false } }, imports: {},
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
    return Promise.resolve([]);
  };
  fakeSample.limits = function () { return Promise.resolve({ images: { mediaTypes: ['image/png', 'image/jpeg'], maxInputBytes: 5000000 } }); };
  window.claude = { use: function (n) { return Promise.resolve(n === 'db' ? db : (n === 'sample' ? fakeSample : null)); } };
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
        link: 'https://example.com/sws-crew', status: 'pending', at: new Date(Date.now() - 36e5).toISOString() }]);
      H.histories = H.histories || {};
      H.histories.pub1 = { artist_id: 'pub1', status: 'ok', detail: '', total: 58, pages: 3, next_page: 0, synced_at: new Date(Date.now() - 864e5).toISOString(),
        mb_url: 'https://www.setlist.fm/setlists/example.html', auto: true,
        summary: { shows: 58, tours: 3, countries: 4, cities: 41, firstYear: 2010, lastYear: 2026,
          toursList: [{ name: 'Feel Tour', n: 30, first: '2025-03-01', last: '2025-04-12', lineup: 'Our Last Night, The Word Alive, Ashland' }] } };
    }
    return H.ghosts;
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
        if (!g.year) out.list.push({ artistId: aid, artist: iss ? iss.name : 'Artist', key: g.key, name: g.name, n: g.n, first: g.first, last: g.last });
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
      { id: 'y5', tour_id: 't1', date: d0, merchant: 'AMAZON MKTPL*2X4Y67ZQ3 AMZN.COM/BILL WA 98109', amount: 1249.37, category: null, account: 'Business Gold Card \u2013 1008', why: 'New merchant' }
    ]
  };
  window.__harness.calls = []; window.__harness.marked = []; window.__harness.feedFns = [];
  window.__harness.members = []; window.__harness.invited = []; window.__harness.notified = []; window.__harness.notes = [];
  window.__harness.past = [{ email: 'brent@example.com', name: 'Brent Allen', phone: '555-0142', role: 'editor' },
    { email: 'tasha@example.com', name: 'Tasha Lane', phone: '', role: 'viewer' }];
  window.__harness.pushSupported = true; window.__harness.pushOn = false; window.__harness.phones = 3;
  window.__harness.feedState = function () { var F = window.__harness.feed; return { row: Object.assign({}, F.row), items: F.items.slice() }; };
  window.__harness.feedPush = function () { var st = window.__harness.feedState(); window.__harness.feedFns.forEach(function (fn) { fn(st); }); };
  window.GR_BACKEND = {
    tourRoles: ['Artist', 'Band', 'Tour Manager', 'Production Manager', 'Stage Manager', 'Merch',
      'Guitar Tech', 'Drum Tech', 'Assistant', 'FOH Engineer', 'Monitors', 'Friend', 'Family Member', 'Liaison', 'Dancer'],
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
      return Promise.resolve([{ date: '2025-03-01', city: 'Dallas', state: 'TX', country: 'US', venue: 'House of Blues', url: '', announced: false },
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
        return { id: d.id, date: d.date, amount: d.amount, atvenu: d.atvenu };
      }));
    },
    catalogIncome: async function (depId, opts) {
      var H = window.__harness, o = opts || {};
      H.catalogued = (H.catalogued || []).concat([{ id: depId, tourId: o.tourId || null, showId: o.showId || null, kind: o.kind }]);
      var dep = (H.deposits || []).filter(function (d) { return d.id === depId; })[0];
      if (!dep) return { ok: false, why: 'gone' };
      if (dep.matched) return { ok: false, why: 'done' };
      dep.matched = true;
      if (o.kind === 'skip') return { ok: true };
      if (o.showId && (o.kind === 'merch' || o.kind === 'guarantee')) {
        var sh = {};
        if (o.kind === 'merch') sh[o.showId] = { merchReceived: true, merchReceivedAt: dep.date, merchDeposit: dep.amount };
        else {
          // Same rule as migrations 0072 + 0074: only bank money beyond what's on the show is new.
          var tdoc = tours[o.tourId] || {};
          var cur = (tdoc.shows || {})[o.showId] || {};
          var had = Number(cur.guaranteeDeposit) > 0 ? Number(cur.guaranteeDeposit) : 0;
          if (cur.guaranteeReceived === true && had > 0) {
            var seen = Math.min(cur.guaranteeSeen != null ? Number(cur.guaranteeSeen) : cur.guaranteeReceivedAt ? had : 0, had) + dep.amount;
            if (seen > had + 1) {
              var gw = Object.assign({}, cur.guaranteeWhy || {});
              var owed = Math.max(0, (Number(gw.owed) || 0) - (seen - had));
              gw.owed = owed > 0 ? owed : null;
              sh[o.showId] = { guaranteeReceived: true, guaranteeReceivedAt: dep.date, guaranteeDeposit: seen, guaranteeSeen: seen, guaranteeWhy: gw };
            } else if (seen >= had - 1) sh[o.showId] = { guaranteeReceivedAt: dep.date, guaranteeDeposit: seen, guaranteeSeen: seen };
            else sh[o.showId] = { guaranteeSeen: seen };
          } else sh[o.showId] = { guaranteeReceived: true, guaranteeReceivedAt: dep.date, guaranteeDeposit: dep.amount, guaranteeSeen: dep.amount };
        }
        await db.doc('tours/' + o.tourId).update({ shows: sh });
        return { ok: true };
      }
      var oi = {};
      oi[depId] = { date: dep.date, amount: dep.amount, kind: o.kind, at: Date.now() };
      await db.doc('tours/' + o.tourId).update({ otherIncome: oi });
      return { ok: true };
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
    username: function () { return me.username; },
    ownsTour: function () { return true; },
    myRole: function () { return Promise.resolve('owner'); },
    crew: function () { window.__harness.crewCalls = (window.__harness.crewCalls || 0) + 1; return Promise.resolve(window.__harness.crew); },
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
          return { id: x.id, name: x.name, handle: x.handle, avatar: x.avatar, kind: m.kind, role: m.role || '', endorsed: !!m.endorsed, mine: true, declined: false }; }).concat(devinActs()),
        flowers: 2, endorsements: devinActs().length + (H.acts || []).filter(function (x) { return x.members.some(function (m) { return m.userId === 'u-devin' && m.endorsed; }); }).length,
        roadStats: H.roadStats || (function () { try { return JSON.parse(localStorage.getItem('gr_h_road') || 'null'); } catch (e) { return null; } })() || (function () { var c = creditSums('u-devin'); return { tours: 1 + c.tours, shows: 15 + c.shows, countries: 1 + (c.shows ? 3 : 0), cities: 15 + c.shows, firstYear: c.first || 2026 }; })(),
        credits: creditSums('u-devin').credits, creditTours: creditSums('u-devin').list,
        tours: [{ id: 't1', artist: 'I See Stars', name: 'Harness run', first: '2026-09-27', last: '2026-10-04', shows: 4, mine: true }], logos: {} }, base));
      if (uid === 'u-brent') return Promise.resolve(Object.assign({ userId: uid, name: 'Brent Allen', handle: 'brent', bio: 'Guitars, backline, bad jokes.',
        roles: ['Guitar Tech', 'Stage Manager'], tourRole: 'Guitar Tech', avatar: '', artists: ['Sleeping With Sirens', 'I See Stars'],
        acts: (H.acts || []).filter(function (x) { return x.members.some(function (m) { return m.userId === 'u-brent'; }); }).map(function (x) { return { id: x.id, name: x.name, handle: x.handle, avatar: x.avatar, kind: x.members.filter(function (m) { return m.userId === 'u-brent'; })[0].kind, endorsed: !!x.members.filter(function (m) { return m.userId === 'u-brent'; })[0].endorsed }; })
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
    claimArtist: function (artistId, note, link) {
      var H = window.__harness; H.claims = H.claims || [];
      var g = ghostList().filter(function (x) { return x.id === artistId; })[0];
      if (!g || g.owner) return Promise.resolve({ ok: false, why: 'taken' });
      if (String(note || '').trim().length < 3) return Promise.reject(Object.assign(new Error('short'), { code: 'short' }));
      H.claims = H.claims.filter(function (c) { return !(c.artistId === artistId && c.userId === 'u-devin'); });
      H.claims.push({ id: 'cl' + Date.now(), artistId: artistId, userId: 'u-devin', note: String(note).trim(), link: String(link || '').trim(), status: 'pending', at: new Date().toISOString() });
      return Promise.resolve({ ok: true });
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
        return { artistId: c.artistId, artist: g.name || '', status: c.status, at: c.at, mine: false }; }));
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
    addArtistMember: function (id, uid, kind) {
      var H = window.__harness, a = H.acts.filter(function (x) { return x.id === id; })[0];
      a.members = a.members.filter(function (m) { return m.userId !== uid; }).concat([{ userId: uid, kind: kind }]);
      return Promise.resolve();
    },
    removeArtistMember: function (id, uid) {
      var H = window.__harness, a = H.acts.filter(function (x) { return x.id === id; })[0];
      a.members = a.members.filter(function (m) { return m.userId !== uid; }); return Promise.resolve();
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
        return Promise.resolve({ id: g.id, handle: g.handle, name: g.name, bio: '', avatar: '', mine: false,
          unclaimed: !g.owner, verified: !!g.owner, checkmark: true, claimed: !!g.owner, about: g.about || '', country: g.country || '', myClaim: mc ? mc.status : null,
          iFollow: gf, followers: gf ? 1 : 0, members: [], tours: [] });
      }
      if (!a) return Promise.resolve(null);
      var fol = (H.artistFollows || []).indexOf(a.id) >= 0;
      return Promise.resolve({ id: a.id, handle: a.handle, name: a.name, bio: a.bio || '', avatar: a.avatar || '', mine: true,
        unclaimed: false, verified: !!a.verified || /i see stars/i.test(a.name || ''), checkmark: !!a.verified || /i see stars/i.test(a.name || ''), claimed: !!a.verified || /i see stars/i.test(a.name || ''), about: a.about || '', country: a.country || '', myClaim: null,
        iFollow: fol, followers: (a.followers || 0) + (fol ? 1 : 0),
        members: a.members.map(function (m) { return Object.assign({ userId: m.userId, kind: m.kind, role: m.role || '', avatar: '', endorsed: !!m.endorsed,
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
    invite: function (tourId, email, role, name, phone, extra) {
      window.__harness.invited.push([email, role, name, (extra || {}).tourRole || '']);
      window.__harness.members.push({ invited_email: email, role: role, display_name: name, user_id: null });
      // Like the real crew list, which reads the same members table.
      window.__harness.crew = window.__harness.crew.concat([{ owner: false, role: role, name: name || '', email: email,
        invitedEmail: email, phone: phone || '', tourRole: (extra || {}).tourRole || '', joined: false }]);
      return Promise.resolve('sent');
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
        return Promise.resolve({ ok: true, connected: true, switchedOn: !!F.row.switched_on, lastRun: F.row.last_run, cards: cards,
          mine: !window.__harness.asTM, items: F.items.filter(function (it) { return !it.tour_id || it.tour_id === body.tourId; }) });
      }
      if (action === 'file') {
        // Like the server: each charge where it's pointed (H.offTourId / H.nextTourId
        // stand in for the band's Off Tour book and next tour).
        var H = window.__harness;
        var picks = body.picks || [], adds = {}, filed = 0, skipped = 0, already = 0, total = 0, now = Date.now(), offN = 0, nextN = 0;
        var into = function (tid, key, ch) { adds[tid] = adds[tid] || {}; adds[tid][key] = ch; };
        picks.forEach(function (pk, i) {
          var it = F.items.filter(function (x) { return x.id === pk.id; })[0];
          if (!it) { already += 1; return; }
          F.items = F.items.filter(function (x) { return x.id !== pk.id; });
          if (pk.keep) { H.filedItems = H.filedItems || {}; H.filedItems[it.id] = it; }
          if (!pk.keep) { skipped += 1; return; }
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
        }).then(function () { return { ok: true, filed: filed, skipped: skipped, already: already, offTour: offN, upcoming: nextN,
          total: Math.round(total * 100) / 100 }; });
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
        return Promise.resolve({ ok: true, left: F.banks.length });
      }
      if (action === 'disconnect') { window.__harness.feedFns.forEach(function (fn) { fn({ row: null, items: [], connectOnly: true }); }); return Promise.resolve({ ok: true }); }
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
      if (action === 'sync') F.row.last_run = new Date().toISOString();
      window.__harness.feedPush();
      return Promise.resolve(action === 'sync' ? (window.__harness.syncReply || { ok: true, status: 'ok', test: true, seen: 16, filed: 3, waiting: 10 }) : { ok: true });
    },
    feedMark: function (ids, patch) {
      var F = window.__harness.feed;
      window.__harness.marked.push([ids.slice(), patch]);
      F.items = F.items.filter(function (it) { return ids.indexOf(it.id) < 0; });
      window.__harness.feedPush();
      return Promise.resolve();
    },
    // same markup as backend.js's picker, so the contact card can be exercised here
    openRolePicker: function (current, onPick) {
      var ov = document.createElement('div'); ov.className = 'role-picker';
      ov.innerHTML = '<div class="rp-card"><div class="rp-head">Your role on the tour</div><div class="rp-list">' +
        window.GR_BACKEND.tourRoles.map(function (r) {
          return '<button type="button" class="rp-opt' + (r === current ? ' on' : '') + '" data-r="' + r + '">' + r + '</button>';
        }).join('') + '</div></div>';
      ov.addEventListener('click', function (e) {
        var b = e.target.closest('.rp-opt');
        if (b) { onPick(b.getAttribute('data-r')); ov.remove(); } else if (e.target === ov) ov.remove();
      });
      document.body.appendChild(ov);
    }
  };
})();
</script>
"""
out = page.replace('<script src="core.js"></script>', shim + '<script src="core.js"></script>')
assert out != page, 'core.js tag not found'
(ROOT / 'src/_dbstub.html').write_text(out, encoding='utf-8')
print('src/_dbstub.html written')
