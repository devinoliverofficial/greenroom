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
        c4: { id: 'c4', date: ymd(new Date(today.getTime() - 12 * 864e5)), merchant: 'Van rental', amount: 450, category: 'bus', manual: true, paid: true } }, imports: {},
      bands: ['Opener Band', 'I See Stars'],
      shows: { s1: { id: 's1', date: ymd(today), city: 'Austin, TX', venue: 'Mohawk',
        daySheet: { doors: '7:00 PM', venueAddress: '912 Red River St, Austin, TX 78701' } },
        // Two nights already played and one ahead, for the Calendar's past days.
        s0: { id: 's0', date: ymd(new Date(today.getTime() - 4 * 864e5)), city: 'Dallas, TX', venue: 'Granada',
          loggedAt: 1, income: { guarantee: 1500, merch: 900 }, merchCash: 400 },
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
      { id: 'y4', tour_id: 't1', date: d0, merchant: 'Marriott', amount: -120, category: 'hotels', account: 'Business Gold Card \u2013 1008', why: 'Refund' }
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
          return { id: x.id, name: x.name, handle: x.handle, avatar: x.avatar, kind: m.kind, endorsed: !!m.endorsed, mine: true, declined: false }; }).concat(devinActs()),
        flowers: 2, endorsements: devinActs().length + (H.acts || []).filter(function (x) { return x.members.some(function (m) { return m.userId === 'u-devin' && m.endorsed; }); }).length,
        tours: [{ id: 't1', artist: 'I See Stars', name: 'Harness run', first: '2026-09-27', last: '2026-10-04', shows: 4, mine: true }], logos: {} }, base));
      if (uid === 'u-brent') return Promise.resolve(Object.assign({ userId: uid, name: 'Brent Allen', handle: 'brent', bio: 'Guitars, backline, bad jokes.',
        roles: ['Guitar Tech', 'Stage Manager'], tourRole: 'Guitar Tech', avatar: '', artists: ['Sleeping With Sirens', 'I See Stars'],
        acts: (H.acts || []).filter(function (x) { return x.members.some(function (m) { return m.userId === 'u-brent'; }); }).map(function (x) { return { id: x.id, name: x.name, handle: x.handle, avatar: x.avatar, kind: x.members.filter(function (m) { return m.userId === 'u-brent'; })[0].kind, endorsed: !!x.members.filter(function (m) { return m.userId === 'u-brent'; })[0].endorsed }; })
          .concat([{ id: null, name: 'Old Band', handle: '', avatar: '', kind: 'crew', endorsed: true, past: true }]),
        flowers: 3, endorsements: 1 + (H.acts || []).filter(function (x) { return x.members.some(function (m) { return m.userId === 'u-brent' && m.endorsed; }); }).length,
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
    /* Artist profiles, in memory. Searchable accounts: Brent, plus two people
       you don't tour with (found by @username only). */
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
      if (!a) return Promise.resolve(null);
      var fol = (H.artistFollows || []).indexOf(a.id) >= 0;
      return Promise.resolve({ id: a.id, handle: a.handle, name: a.name, bio: a.bio || '', avatar: a.avatar || '', mine: true,
        iFollow: fol, followers: (a.followers || 0) + (fol ? 1 : 0),
        members: a.members.map(function (m) { return Object.assign({ userId: m.userId, kind: m.kind, avatar: '', endorsed: !!m.endorsed }, P[m.userId], m.userId === 'u-devin' ? { handle: H.handle || '' } : {}); }),
        tours: a.name.toLowerCase() === 'i see stars' ? [{ id: 't1', artist: a.name, name: 'Harness run', first: '2026-09-27', last: '2026-10-04', shows: 4, mine: true }] : [] });
    },
    artistTourCard: function () { return Promise.resolve(null); },
    findArtists: function (text) {
      var H = window.__harness, t = String(text || '').trim().replace(/^@/, '').toLowerCase();
      var all = (H.acts || []).map(function (a) { return { id: a.id, name: a.name, handle: a.handle, avatar: a.avatar, mine: true }; })
        .concat([{ id: 'pub1', name: 'Sleeping With Sirens', handle: 'sws', avatar: '', mine: false }]);
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
