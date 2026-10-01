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
        gas: { projected: 9800 }, flights: { projected: 18250 } }, commission: {}, crew: {}, debts: {}, extras: {},
      charges: { c1: { id: 'c1', date: ymd(today), merchant: 'Prevost', amount: 21456.78, category: 'bus', manual: true, paid: false },
        c2: { id: 'c2', date: ymd(today), merchant: 'Marriott', amount: 4560, category: 'hotels', manual: true, paid: true },
        c3: { id: 'c3', date: ymd(today), merchant: 'Delta', amount: 6890, category: 'flights', manual: true, paid: false } }, imports: {},
      bands: ['Opener Band', 'I See Stars'],
      shows: { s1: { id: 's1', date: ymd(today), city: 'Austin, TX', venue: 'Mohawk',
        daySheet: { doors: '7:00 PM', venueAddress: '912 Red River St, Austin, TX 78701' } },
        // Two nights already played and one ahead, for the Calendar's past days.
        s0: { id: 's0', date: ymd(new Date(today.getTime() - 4 * 864e5)), city: 'Dallas, TX', venue: 'Granada',
          loggedAt: 1, income: { guarantee: 1500, merch: 900 }, merchCash: 400 },
        s00: { id: 's00', date: ymd(new Date(today.getTime() - 2 * 864e5)), city: 'Houston, TX', venue: 'White Oak' },
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
  var db = {
    collection: function (name) { return { onSnapshot: function (cb) {
      if (name === 'tours') { subs.push(cb); setTimeout(function () { cb(snap()); }, 0); }
      else setTimeout(function () { cb({ docs: [] }); }, 0);
      return function () {}; } }; },
    doc: function (path) {
      var id = path.split('/')[1];
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
  window.__harness = { me: me, crew: [
    { owner: true, role: 'owner', name: 'Devin Oliver', email: 'devin@example.com', phone: '555-0100', tourRole: 'Artist', joined: true },
    { owner: false, role: 'editor', name: 'Brent Allen', email: 'brent@example.com', invitedEmail: 'brent@example.com', phone: '(313) 555-0142', tourRole: 'Guitar Tech', joined: true },
    { owner: false, role: 'viewer', name: 'Tasha Lane', email: 'tasha@example.com', invitedEmail: 'tasha@example.com', phone: '', tourRole: 'Production Manager', joined: false }
  ] };
  var d0 = ymd(today);
  window.__harness.feed = {
    row: { switched_on: false, plan_name: '', since: null, last_run: null, last_status: '', source: 'plaid' },
    banks: [{ id: 'b1', name: 'Bank of America', status: 'ok' }, { id: 'b2', name: 'American Express', status: 'ITEM_LOGIN_REQUIRED' }],
    accounts: [
      { id: 'ac1', name: 'Corp Account Bank Of America \u2013 4918', type: 'creditCard', mode: 'log' },
      { id: 'ac2', name: 'Merch \u2013 1885', type: 'checking', mode: 'ask' },
      { id: 'ac3', name: 'Business Adv Relationship \u2013 5370', type: 'checking', mode: 'ask' },
      { id: 'ac4', name: 'Business Gold Card \u2013 1008', type: 'creditCard', mode: 'log' }
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
    // Crew Stats and the game ball, in memory.
    statsFor: function (tourId) {
      return (window.__harness.stats || []).filter(function (x) { return x.tour_id === tourId; })
        .map(function (x) { return { id: x.id, person: x.person, stat: x.stat, day: x.day, mine: x.added_by === 'u-devin', at: x.created_at }; });
    },
    checkIn: function (tourId, date) {
      var H = window.__harness;
      var have = (H.stats || []).some(function (x) { return x.tour_id === tourId && x.stat === 'checkin' && x.day === date && x.person === 'owner'; });
      if (!have) H.stats = (H.stats || []).concat([{ id: 'ci' + Date.now(), tour_id: tourId, person: 'owner', stat: 'checkin', day: date, added_by: 'u-devin', created_at: new Date().toISOString() }]);
      return Promise.resolve();
    },
    addStat: function (tourId, person, stat) {
      var H = window.__harness, id = 'st' + Date.now() + Math.random().toString(36).slice(2, 5);
      H.stats = (H.stats || []).concat([{ id: id, tour_id: tourId, person: person, stat: stat, added_by: 'u-devin', created_at: new Date().toISOString() }]);
      return Promise.resolve(id);
    },
    removeStat: function (id) { window.__harness.stats = (window.__harness.stats || []).filter(function (x) { return x.id !== id; }); return Promise.resolve(); },
    gameBall: function (tourId) {
      var H = window.__harness;
      return { rounds: (H.rounds || []).filter(function (g) { return g.tour_id === tourId; }).map(function (g) {
          return { round: g.round, opensAt: g.opens_at, closesAt: g.closes_at, status: g.status, winner: g.winner, reason: g.winner_reason }; }),
        votes: (H.gbVotes || []).filter(function (v) { return v.tour_id === tourId; }).map(function (v) {
          return { round: v.round, voter: v.voter, voterName: v.voter_name, person: v.person, reason: v.reason, mine: v.voter === 'u-devin' }; }) };
    },
    voteGameBall: function (tourId, round, person, reason) {
      var H = window.__harness;
      H.gbVotes = (H.gbVotes || []).filter(function (v) { return !(v.tour_id === tourId && v.round === round && v.voter === 'u-devin'); });
      H.gbVotes.push({ tour_id: tourId, round: round, voter: 'u-devin', voter_name: 'Devin Oliver', person: person, reason: reason });
      return Promise.resolve();
    },
    callGameBall: function (tourId, round, person, reason) {
      (window.__harness.rounds || []).forEach(function (g) { if (g.tour_id === tourId && g.round === round) { g.status = 'won'; g.winner = person; g.winner_reason = reason; } });
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
      if (action === 'status') return Promise.resolve({ ok: true, source: 'plaid', test: true, switchedOn: F.row.switched_on,
        since: F.row.since, lastRun: F.row.last_run, lastStatus: 'ok', banks: JSON.parse(JSON.stringify(F.banks)),
        needsConnect: !F.banks.length,
        accounts: F.accounts.map(function (a) {
          var plaidCard = a.type === 'creditCard' ? 'credit' : 'debit';
          return { id: a.id, name: a.name, type: a.type, mode: a.mode, card: a.card || plaidCard, plaidCard: plaidCard,
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
      }).map(function (a, i) { return { id: a.id, name: a.name, balance: i ? 4210.55 : 27000 }; }) });
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
