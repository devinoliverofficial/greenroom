/* Greenroom's real backend (the GitHub Pages build only).
   A classic script so it runs before app.js: it stands in for the Claude
   Artifact runtime by defining window.claude.use with the same three
   capabilities the app already speaks — db, user, sample — backed by
   Supabase auth/Postgres/realtime and an edge function holding the
   Anthropic key. With no config filled in, everything resolves null and
   the app quietly runs in saved-on-this-device mode. */
(function () {
  'use strict';

  var cfg = window.GREENROOM_CONFIG || {};
  var ready = { db: null, user: null, sample: null };
  var resolvers = {};
  ['db', 'user', 'sample'].forEach(function (k) {
    ready[k] = new Promise(function (res) { resolvers[k] = res; });
  });

  window.claude = {
    use: function (name) { return ready[name] || Promise.resolve(null); }
  };

  if (!cfg.url || !cfg.anonKey) {
    resolvers.db(null); resolvers.user(null); resolvers.sample(null);
    return;
  }

  var sb = null;           // supabase client
  var sbMod = null;        // the supabase-js module, for one-off clients
  var resetting = false;   // arrived by a password-reset link
  var session = null;
  var cache = { tours: new Map(), labels: new Map(), guests: [], notes: [], polls: [], votes: [], requests: [],
    asks: [], checkins: [], reimb: [] };
  // Flowers: each tour's crew and gifts, and your own, asked for when a page
  // shows them and kept until something changes.
  var flowerCache = {}, flowerAsk = {}, flowerGen = {}, myFlowerCache = null, myFlowerAsk = null, myFlowerGen = 0, flowerTimer = 0;
  var faceCache = {}, faceAsk = {};
  var FLOWERS_FRESH = 60e3; // asked again after a minute anyway: people join, phones sleep through changes
  var listeners = { tours: [], labels: [] };
  var refetchTimer = 0;

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  // Today on this phone, YYYY-MM-DD (the server's clock can be a day ahead of a show night in America).
  function localDay() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  // Mirrors the app's merge-write: nested objects merge, anything else replaces.
  function deepMerge(target, patch) {
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (isObj(v) && isObj(target[k])) target[k] = deepMerge(target[k], v);
      else target[k] = isObj(v) ? clone(v) : v;
    });
    return target;
  }
  function err(code) { var e = new Error(code); e.code = code; return e; }

  /* ---------------- Snapshot plumbing ---------------- */

  function snapshotOf(map) {
    var docs = [];
    map.forEach(function (doc, id) {
      docs.push({ id: id, exists: true, data: function () { return clone(doc); } });
    });
    return { docs: docs };
  }
  function emit(table) {
    listeners[table].forEach(function (fn) {
      try { fn(snapshotOf(cache[table])); } catch (e) { /* listener's problem */ }
    });
  }

  // When each tour was last saved from this phone: a refetch that set off
  // before then is carrying the older copy, and mustn't put it back. Counted,
  // not timed, so a phone's clock being set back can't confuse it.
  var wroteAt = {}, tick = 0;
  async function refetch() {
    var asked = ++tick;
    var tours = await sb.from('tours').select('id, owner_id, doc');
    if (tours.error) throw tours.error;
    // Crew can't read a tour's money: the database hands them its own
    // copy of those tours, without it.
    var ga = await sb.from('tour_public').select('id, owner_id, doc');
    var full = {};
    tours.data.forEach(function (r) { full[r.id] = true; });
    var rows = tours.data.concat(ga.error ? [] : ga.data.filter(function (r) { return !full[r.id]; }));
    var before = cache.tours, stale = false;
    // The Crew copies couldn't be read this time: keep the ones already here.
    if (ga.error && before) before.forEach(function (doc, id) { if (!full[id]) rows.push({ id: id, owner_id: doc._ownerId, doc: doc, kept: true }); });
    cache.tours = new Map(rows.map(function (r) {
      if (r.kept) return [r.id, r.doc];
      // Saved from here after this refetch set off: what's here is newer.
      if (wroteAt[r.id] && wroteAt[r.id] >= asked && before && before.has(r.id)) { stale = true; return [r.id, before.get(r.id)]; }
      var doc = isObj(r.doc) ? r.doc : {};
      doc._ownerId = r.owner_id; // lets the UI know whose tour this is
      return [r.id, doc];
    }));
    if (stale) scheduleRefetch();
    var labels = await sb.from('labels').select('id, doc');
    if (labels.error) throw labels.error;
    cache.labels = new Map(labels.data.map(function (r) { return [r.id, r.doc]; }));
    var guests = await sb.from('guests').select('*');
    cache.guests = guests.error ? cache.guests : guests.data;
    var notes = await sb.from('notes').select('*').order('created_at');
    cache.notes = notes.error ? cache.notes : notes.data;
    // The calendar: day-off polls, their votes, and show-day requests.
    var cal = await Promise.all([
      sb.from('day_polls').select('*'),
      sb.from('day_votes').select('*'),
      sb.from('day_requests').select('*').order('created_at')
    ]);
    if (!cal[0].error) cache.polls = cal[0].data;
    if (!cal[1].error) cache.votes = cal[1].data;
    if (!cal[2].error) cache.requests = cal[2].data;
    // The days you've checked in on (Check In, on your profile's Today).
    if (session) {
      var ci = await sb.from('crew_stats').select('tour_id, day').eq('stat', 'checkin').eq('added_by', session.user.id);
      if (!ci.error) cache.checkins = ci.data;
    }
    // Ari's questions to the tour manager (only they and Managers see them).
    var asks = await sb.from('ari_asks').select('*').order('created_at');
    if (!asks.error) cache.asks = asks.data;
    // Asks to be paid back (never stops the rest: see loadReimbursements).
    await loadReimbursements();
    emit('tours'); emit('labels');
    // A call got through: an agreement to the documents that could not be sent goes now (nothing held: no call).
    legalFlush();
  }
  /* Money people paid out of their own pocket for a tour and asked to be paid
     back. The database hands each account only its own asks, plus every ask
     on a tour it is a Manager of. A read that fails (the table is not there
     yet: a build ahead of its migration) leaves what was here, which starts
     out as an empty list, and never throws. Answers whether it was read.
     Newest first, at most 1000: if there were ever more, the oldest are the
     ones left out (reimbursementsFor sorts what it hands the app anyway). */
  async function loadReimbursements() {
    try {
      var rb = await sb.from('reimbursements')
        .select('id, tour_id, user_id, requester_name, amount, what, spent_on, status, paid_at, paid_by, paid_by_name, paid_how, feed_id, closed_by_name, closed_at, created_at')
        .order('created_at', { ascending: false }).limit(1000);
      if (!rb.error && Array.isArray(rb.data)) { cache.reimb = rb.data; return true; }
    } catch (e) { /* as it was */ }
    return false;
  }
  // A refetch that fails (no signal as the phone wakes) is tried again, a few
  // times, further apart each time; anything that asks for one starts over.
  var refetchOwed = false, refetchTries = 0, liveOnce = false;
  function scheduleRefetch(wait) {
    clearTimeout(refetchTimer);
    refetchOwed = true;
    refetchTimer = setTimeout(function () {
      refetch().then(function () { refetchOwed = false; refetchTries = 0; }, function () {
        if (!session || document.visibilityState === 'hidden' || refetchTries >= 5) return; // the next event tries again
        refetchTries += 1;
        scheduleRefetch(Math.min(30000, 3000 * Math.pow(2, refetchTries - 1)));
      });
    }, typeof wait === 'number' ? wait : 250);
  }

  /* ---------------- The db capability ---------------- */

  var db = {
    collection: function (name) {
      return {
        onSnapshot: function (cb, onError) {
          listeners[name].push(cb);
          Promise.resolve().then(function () { cb(snapshotOf(cache[name])); });
          return function () {
            var i = listeners[name].indexOf(cb);
            if (i >= 0) listeners[name].splice(i, 1);
          };
        }
      };
    },
    doc: function (path) {
      var parts = path.split('/');
      var table = parts[0], id = parts[1];
      function stripped(doc) {
        var d = clone(doc);
        delete d._ownerId;
        return d;
      }
      return {
        set: async function (doc) {
          var row = { id: id, doc: stripped(doc), updated_at: new Date().toISOString() };
          // Labels are each account's own (artist folders, logos, crew, card categories).
          var q = table === 'tours'
            ? await sb.from('tours').insert({ id: id, doc: row.doc })
            : await sb.from('labels').upsert(Object.assign({ owner_id: session.user.id }, row), { onConflict: 'owner_id,id' });
          if (q.error) throw mapError(q.error);
          var local = clone(doc);
          if (table === 'tours') local._ownerId = session.user.id;
          cache[table].set(id, local);
          emit(table);
        },
        update: async function (patch) {
          var cur = cache[table].get(id);
          if (!cur) throw err('invalid_argument');
          var next = deepMerge(clone(cur), clone(patch));
          if (table === 'tours') {
            // A tour's save sends only the change; the server merges it into
            // the tour as it stands right now and hands the result back. (The
            // whole tour used to go up from this phone's copy, so a phone with
            // an older copy put back what someone else had just changed.)
            var pq = await sb.rpc('patch_tour', { t_id: id, patch: stripped(patch) });
            if (pq.error && !patchMissing(pq.error)) throw mapError(pq.error);
            if (!pq.error) {
              if (isObj(pq.data)) { next = pq.data; next._ownerId = cur._ownerId; }
              wroteAt[id] = ++tick;
              cache.tours.set(id, next);
              emit('tours');
              return;
            }
            // The server doesn't have patch_tour (yet): save the old way.
          }
          var uq = sb.from(table)
            .update({ doc: stripped(next), updated_at: new Date().toISOString() })
            .eq('id', id);
          if (table === 'labels') uq = uq.eq('owner_id', session.user.id);
          var q = await uq.select('id');
          if (q.error) throw mapError(q.error);
          if (!q.data || !q.data.length) throw err('permission'); // RLS said no
          if (table === 'tours') wroteAt[id] = ++tick;
          cache[table].set(id, next);
          emit(table);
        },
        delete: async function () {
          var dq = sb.from(table).delete().eq('id', id);
          if (table === 'labels') dq = dq.eq('owner_id', session.user.id);
          var q = await dq.select('id');
          if (q.error) throw mapError(q.error);
          if (!q.data || !q.data.length) throw err('permission');
          cache[table].delete(id);
          emit(table);
        }
      };
    }
  };
  /* Back from the background with a newer Greenroom out: load it, so a phone
     left open for days isn't still running old code. Only when nothing is
     open or being typed, so nothing is lost. */
  function newBuildCheck() {
    var mine = window.GREENROOM_BUILD;
    if (!mine || typeof fetch !== 'function') return;
    fetch('sw.js', { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (txt) {
      var m = /greenroom-(\d{8}-\d{6})/.exec(txt || '');
      if (!m || m[1] === mine || m[1] < mine) return;
      var a = document.activeElement;
      var typing = !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
      if (typing || document.querySelector('#sheet-root .sheet') || document.visibilityState === 'hidden') return;
      window.location.reload();
    }).catch(function () { /* next time */ });
  }
  // patch_tour isn't on the server: the only reason to fall back to the whole-tour save.
  function patchMissing(e) {
    return !!e && (e.code === 'PGRST202' || e.code === '42883' ||
      /could not find the function|function .*patch_tour.* does not exist/i.test(String(e.message || '')));
  }
  function mapError(e) {
    var msg = String(e && e.message || '');
    if (/permission|policy|denied|42501/i.test(msg)) return err('permission');
    if (/network|fetch|load failed|connection/i.test(msg)) return err('offline');
    return err('unavailable');
  }
  // The database doesn't have this function (yet): a build that got ahead of
  // its migration. Never a reason to lock anyone out.
  function fnMissing(e) {
    return !!e && (e.code === 'PGRST202' || e.code === '42883' ||
      /could not find the function|function .* does not exist/i.test(String(e.message || '')));
  }
  /* The four reimbursement writes (reimburse_ask, reimburse_withdraw,
     reimburse_mark, reimburse_restore). Each answers { ok: true } or
     { ok: false, why } and never throws: 'unavailable' when nobody is signed
     in, when the database does not have the function yet, or when the call
     did not go through.
     After an answer the asks are read again (they are all these functions
     touch) and the app is told, so every page shows it before this resolves;
     if that read fails, everything is read again shortly, as after any change.
     A call that did not go through is followed by the same read, without
     waiting on it: the save may have landed with only its answer lost, and
     the list must then show it (so nobody sends it a second time). */
  async function reimburseCall(fn, args) {
    if (!sb || !session || !session.user) return { ok: false, why: 'unavailable' };
    var q = null;
    try { q = await sb.rpc(fn, args); } catch (e) { q = null; }
    if (!q || q.error || !isObj(q.data)) {
      loadReimbursements().then(function (read) { if (read) emit('tours'); else scheduleRefetch(); });
      return { ok: false, why: 'unavailable' };
    }
    if (await loadReimbursements()) emit('tours'); else scheduleRefetch();
    if (q.data.ok === true) return { ok: true };
    return { ok: false, why: String(q.data.why || 'unavailable') };
  }
  // The database's own words for a "no" the app has an answer to (a day's or
  // a queue's limit); anything else the way mapError has it.
  function knownError(e) {
    if (/too many/i.test(String(e && e.message || ''))) return err('too-many');
    return mapError(e);
  }
  // A proof link the way people type one, as the full https address the database keeps.
  function httpsLink(kind, v) {
    var t = String(v || '').trim();
    if (/^https:\/\//i.test(t)) return t;
    if (/^http:\/\//i.test(t)) return 'https://' + t.slice(7);
    if (kind === 'instagram' && /^@?[A-Za-z0-9._]{1,30}$/.test(t)) return 'https://www.instagram.com/' + t.replace(/^@/, '');
    if (/^[^\s\/@]+\.[^\s]+$/.test(t)) return 'https://' + t;
    return t;
  }
  // The four reasons to be here that an account can tick, in his order.
  var KINDS = ['member', 'crew', 'fan', 'promoter'];
  function cleanKinds(list) {
    var got = Array.isArray(list) ? list.map(function (k) { return String(k || '').toLowerCase(); }) : [];
    return KINDS.filter(function (k) { return got.indexOf(k) >= 0; });
  }
  // A birthday as the database wants it: a real day, YYYY-MM-DD.
  function realDay(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
    if (!m) return false;
    var t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return t.getFullYear() === Number(m[1]) && t.getMonth() === Number(m[2]) - 1 && t.getDate() === Number(m[3]);
  }
  // Whole years old today by the UTC calendar, the way the database counts
  // (save_birth_date): by the phone's own date someone could pass the
  // birthday screen on the day they turn 18 and then have the save refused.
  function yearsOld(y, m, d) {
    var now = new Date();
    var n = now.getUTCFullYear() - y;
    if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) n -= 1;
    return n;
  }
  // A developer's own machine, never the live site.
  function localHost() {
    var h = String(location.hostname || '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || /\.localhost$/.test(h) || /\.test$/.test(h);
  }
  /* What a Greenroom code was made for (member, crew, fan, promoter), kept
     from the sign-up to the first run so those start ticked there. It is
     written when the account is made, under the address it was made for, so
     another account on this phone never gets it; the first run's last save
     and signing out clear it. One key; a phone that will not store it only
     loses the head start. */
  var SUGGEST_KEY = 'gr-signup-kinds';
  function suggestSave(email, kinds) {
    var k = cleanKinds(kinds);
    try {
      if (k.length) localStorage.setItem(SUGGEST_KEY, JSON.stringify({ email: String(email || '').toLowerCase(), kinds: k }));
      else localStorage.removeItem(SUGGEST_KEY);
    } catch (e) { /* no head start, nothing else */ }
  }
  function suggestClear() {
    try { localStorage.removeItem(SUGGEST_KEY); } catch (e) { /* nothing stored */ }
  }
  function suggestRead() {
    try {
      var s = JSON.parse(localStorage.getItem(SUGGEST_KEY) || 'null');
      var me = session && session.user ? String(session.user.email || '').toLowerCase() : '';
      if (isObj(s) && me && String(s.email || '').toLowerCase() === me) return cleanKinds(s.kinds);
    } catch (e) { /* none */ }
    return [];
  }

  /* On the road a phone drops its signal all the time, and an iPhone that
     has been asleep can fail its first request outright ("Load failed")
     before it ever leaves the phone. A request that gets no answer at all is
     tried again, twice, after a short wait. (A request the server answered,
     even with an error, is never repeated.) */
  var lastNetFail = 0;
  function sturdyFetch(input, init) {
    var tries = 0;
    function go() {
      return fetch(input, init).catch(function (e) {
        if (init && init.signal && init.signal.aborted) throw e;
        tries += 1;
        if (init) init.__retried = true;
        if (tries > 2) { lastNetFail = Date.now(); throw e; }
        return new Promise(function (res) { setTimeout(res, tries === 1 ? 500 : 1500); }).then(go);
      });
    }
    return go();
  }

  /* When something still can't be saved: what it was and why (never the
     money itself), kept for a look later. Sent now if it can be, otherwise
     the next time the app is back online. */
  var ERR_KEY = 'gr-save-errors';
  function noteError(place, e) {
    var row = { place: String(place || '').slice(0, 60),
      code: String((e && (e.code || e.status || e.error)) || '').slice(0, 60),
      detail: String((e && e.message) || (typeof e === 'string' ? e : '') || '').slice(0, 200),
      offline: navigator.onLine === false || Date.now() - lastNetFail < 8000,
      ua: String(navigator.userAgent || '').slice(0, 160), at: new Date().toISOString() };
    var q = [];
    try { q = JSON.parse(localStorage.getItem(ERR_KEY) || '[]'); } catch (x) { q = []; }
    q.push(row);
    try { localStorage.setItem(ERR_KEY, JSON.stringify(q.slice(-30))); } catch (x) { /* fine */ }
    flushErrors();
  }
  var flushing = false;
  async function flushErrors() {
    if (flushing || !sb || !session) return;
    var q = [];
    try { q = JSON.parse(localStorage.getItem(ERR_KEY) || '[]'); } catch (x) { q = []; }
    if (!q.length) return;
    flushing = true;
    try {
      var r = await sb.from('app_errors').insert(q);
      if (!r.error) { try { localStorage.removeItem(ERR_KEY); } catch (x) { /* fine */ } }
    } catch (x) { /* next time */ }
    flushing = false;
  }

  function newRowId() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* older phones */ }
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  // A real uuid, on phones without randomUUID too (the database checks the shape).
  function newUuid() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* older phones */ }
    var b = new Uint8Array(16), i;
    try { crypto.getRandomValues(b); } catch (e) { for (i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var x = Array.prototype.map.call(b, function (v) { return (v + 256).toString(16).slice(1); }).join('');
    return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
  }

  /* ---------------- The sample capability ---------------- */

  function fileToB64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { rej(err('image_rejected')); };
      r.readAsDataURL(blob);
    });
  }

  /* Server functions want the sign-in pass as it is right now. Supabase
     renews it every hour; asking for the session returns the renewed one
     (renewing on the spot if it just ran out), and a pass that still gets
     turned away is renewed by force and tried once more. */
  async function freshToken(force) {
    try {
      var got = force ? await sb.auth.refreshSession() : await sb.auth.getSession();
      if (got && got.data && got.data.session) session = got.data.session;
    } catch (e) { /* keep the one we have */ }
    return session ? session.access_token : cfg.anonKey;
  }
  async function callFn(name, init) {
    var res = null;
    for (var attempt = 0; attempt < 2; attempt++) {
      var headers = { 'Content-Type': 'application/json', apikey: cfg.anonKey,
        Authorization: 'Bearer ' + await freshToken(attempt > 0) };
      var go = Object.assign({}, init, { headers: headers });
      res = await sturdyFetch(cfg.url + '/functions/v1/' + name, go);
      if (go.__retried) res.__retried = true;
      if (res.status !== 401) break;
    }
    return res;
  }

  async function callRead(prompt, opts) {
    var o = opts || {};
    var images = [];
    var list = o.images ? (Array.isArray(o.images) ? o.images : [o.images]) : [];
    for (var i = 0; i < list.length; i++) {
      images.push({
        media_type: list[i].type || 'image/jpeg',
        data: await fileToB64(list[i])
      });
    }
    var res;
    try {
      res = await callFn('read', {
        method: 'POST',
        signal: o.signal,
        body: JSON.stringify({
          prompt: prompt,
          images: images,
          tier: o.modelTier === 'quick' ? 'quick' : undefined,
          // Look it up on the web (a venue's address), not from memory.
          search: o.search ? true : undefined,
          // The server posts Ari's words to that tour's chat itself.
          ari: o.ariTour ? { tourId: o.ariTour } : undefined
        })
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw err('cancelled');
      throw err('unavailable');
    }
    if (res.status === 401 || res.status === 403) throw err('session_expired');
    if (res.status === 429) throw err('rate_limited');
    if (!res.ok) throw err('unavailable');
    var out = await res.json();
    if (out.error) throw err(out.error);
    return { text: String(out.text || ''), truncated: false };
  }

  var sample = function (prompt, opts) { return callRead(prompt, opts); };
  sample.json = async function (prompt, opts) {
    var r = await callRead(prompt, opts);
    var t = r.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    var a = t.indexOf('['), b = t.lastIndexOf(']');
    var o1 = t.indexOf('{'), o2 = t.lastIndexOf('}');
    try {
      if (a >= 0 && b > a && (o1 < 0 || a < o1)) return JSON.parse(t.slice(a, b + 1));
      if (o1 >= 0 && o2 > o1) return JSON.parse(t.slice(o1, o2 + 1));
      return JSON.parse(t);
    } catch (e) { throw err('invalid_json'); }
  };
  sample.limits = async function () {
    return { images: { mediaTypes: ['image/jpeg', 'image/png', 'image/webp'], maxInputBytes: 15000000 } };
  };

  /* ---------------- The user capability ---------------- */

  var user = {
    isOwner: function () { return true; },   // anyone signed in can run their own tours
    canEdit: function () { return true; },   // per-tour rights are enforced by the database
    can: function () { return Promise.resolve(true); }
  };

  /* ---------------- People (invites), used by the Share sheet ---------------- */

  window.GR_BACKEND = {
    // A save that couldn't go: kept for a look later. And whether the
    // phone's connection is the likely reason.
    noteError: noteError,
    netTrouble: function () { return navigator.onLine === false || Date.now() - lastNetFail < 8000; },
    email: function () { return session && session.user ? session.user.email : null; },
    username: function () {
      var m = session && session.user ? session.user.user_metadata : null;
      var n = m ? String(m.username || '').trim() : '';
      return n || null;
    },
    tourRoles: TOUR_ROLES,
    openRolePicker: openRolePicker,
    /* The documents agreed to at sign-up (migration 0137), for Settings.
       legal(): where this account stands: { ready (the documents are
       loaded), needs (it has yet to agree to the current ones), acceptedAt,
       versions (what it agreed to), current, changed }. legalDocs(): the
       current documents, in order, as { doc, name, title, version, body,
       publishedAt }; [] when none are loaded. Both answer null when they
       could not be read. legalBody(text, title): a document's text as
       pieces for the page; nothing in it is read as HTML. */
    legal: async function () {
      if (!sb || !session) return null;
      try {
        var d = await legalApi.status();
        return { ready: d.ready === true, needs: d.needs === true, acceptedAt: d.accepted_at || null,
          versions: isObj(d.versions) ? d.versions : null, current: isObj(d.current) ? d.current : null,
          changed: Array.isArray(d.changed) ? d.changed.map(String) : [] };
      } catch (e) { return null; }
    },
    legalDocs: async function () {
      if (!sb || !session) return null;
      try {
        var d = legalClean(await legalApi.docs());
        if (!d) return null;
        return d.docs.map(function (x) {
          return { doc: x.doc, name: LEGAL_NAMES[x.doc], title: x.title, version: x.version, body: x.body, publishedAt: x.published_at };
        });
      } catch (e) { return null; }
    },
    legalBody: function (text, title) { sgStyle(); return mdNodes(text, title); },
    /* Who has agreed (migration 0139), for a Greenroom admin: the whole
       record of the documents, { agreed: [...], waiting: [...], current }.
       The database answers null to everyone else, and this answers null
       too when it could not be read or the database does not have the
       function yet: either way there is no list, and Settings shows no
       row. Never thrown. */
    legalList: async function () {
      if (!sb || !session) return null;
      try {
        var q = await sgLimit(sb.rpc('legal_list'), 20000);
        return q.error || !isObj(q.data) ? null : q.data;
      } catch (e) { return null; }
    },
    myProfile: function () {
      var m = (session && session.user && session.user.user_metadata) || {};
      var full = String(m.full_name || '').trim();
      // Accounts from before first/last were asked get split from the full name.
      var first = String(m.first_name || '').trim() || full.split(/\s+/)[0] || '';
      var last = String(m.last_name || '').trim() || full.split(/\s+/).slice(1).join(' ');
      return {
        firstName: first, lastName: last, fullName: full,
        username: String(m.username || '').trim(),
        phone: String(m.phone || '').trim(),
        tourRole: roleName(m.tour_role),
        email: session && session.user ? session.user.email : ''
      };
    },
    /* One card, two homes: the account metadata (so it follows you to any
       phone) and the profiles table (so the rest of the tour can read it).
       The name in chat is simply the person's name. */
    saveProfile: async function (p) {
      var first = String(p.firstName || '').trim().slice(0, 30);
      var last = String(p.lastName || '').trim().slice(0, 30);
      var full = (first + ' ' + last).trim();
      var card = {
        first_name: first, last_name: last,
        full_name: full.slice(0, 60),
        username: full.slice(0, 40),
        phone: String(p.phone || '').trim().slice(0, 30),
        tour_role: String(p.tourRole || '').trim().slice(0, 40)
      };
      var q = await sb.auth.updateUser({ data: card });
      if (q.error) throw mapError(q.error);
      if (q.data && q.data.user && session) session.user = q.data.user;
      await pushProfile();
    },
    /* ---------------- Social: profiles, following, the tour flyer ----------------
       Your own photo, roles and bio live with your labels (yours alone); this
       copies them onto your profile card, where the people you tour with can
       read them. Everything about someone ELSE comes from the database's own
       functions, which hand over a profile and, for each tour, only its name,
       its dates and its flyer. */
    pushSocial: async function (p) {
      if (!session || !session.user) return;
      var q = await sb.from('profiles').upsert({
        user_id: session.user.id,
        bio: String(p.bio || '').slice(0, 300),
        roles: (Array.isArray(p.roles) ? p.roles : []).map(function (r) { return String(r).slice(0, 40); }).slice(0, 20),
        avatar: String(p.photo || '').slice(0, 120000),
        artists: (Array.isArray(p.artists) ? p.artists : []).map(function (a) { return String(a).trim().slice(0, 60); })
          .filter(Boolean).slice(0, 40),
        updated_at: new Date().toISOString()
      });
      if (q.error) throw mapError(q.error);
    },
    // A username is yours once the database says so: one owner each.
    handleFree: async function (h) {
      var q = await sb.rpc('handle_free', { h: String(h || '') });
      if (q.error) throw mapError(q.error);
      return q.data === true;
    },
    setHandle: async function (h) {
      if (!session || !session.user) return;
      var clean = String(h || '').trim().toLowerCase();
      var q = await sb.from('profiles').upsert({ user_id: session.user.id, handle: clean || null,
        updated_at: new Date().toISOString() });
      if (q.error) {
        if (q.error.code === '23505') { var taken = new Error('taken'); taken.code = 'taken'; throw taken; }
        if (q.error.code === '23514') { var bad = new Error('shape'); bad.code = 'shape'; throw bad; }
        throw mapError(q.error);
      }
      // The first run stops asking for a username the moment there is one.
      if (firstFacts) firstFacts.handle = clean;
    },
    /* ---- The first run: what a new account is asked once it is in (what
       brings you here, and a username or birthday it still lacks). The facts
       are read once at start-up, before the app is handed the database
       (loadFirstRun); these keep them true as the answers are saved. If
       they could not be read, the account counts as finished and nothing is
       asked: nobody is ever locked out by this.
       Someone invited to a tour is asked their username, birthday and
       password by the overlay over the app (passwordGate). While it is up
       nothing is due here, or they would be asked the first two twice; when
       it has saved, the facts are read again and the app is told.
       suggest: what their Greenroom code was made for, to start ticked. ---- */
    firstRun: function () {
      var f = firstFacts || { onboarded: true, kinds: [], handle: '', hasBirth: true, unknown: true };
      var p = window.GR_BACKEND.myProfile();
      var asking = !!(session && session.user && session.user.user_metadata &&
        session.user.user_metadata.invited === true);
      return { due: !f.onboarded && !asking, needsHandle: !f.unknown && !f.handle, needsBirth: !f.unknown && !f.hasBirth,
        kinds: f.kinds.slice(), firstName: p.firstName, lastName: p.lastName, handle: f.handle, email: p.email,
        suggest: suggestRead() };
    },
    // Whether Greenroom's project is taking sign-ups at all (open), and whether
    // a new address has to be confirmed by an emailed code (confirm). null
    // when it could not be read.
    signupSettings: function () { return signupSettings(); },
    // Throws 'shape' (not a real day) or 'young' (under 18). Only you can read it back.
    saveBirthDate: async function (d) {
      var day = String(d || '');
      if (!realDay(day)) throw err('shape');
      if (yearsOld(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))) < 18) throw err('young');
      var q = await sb.rpc('save_birth_date', { d: day });
      if (q.error) {
        var m = String(q.error.message || '');
        if (/\byoung\b/i.test(m)) throw err('young');
        if (/\bshape\b/i.test(m) || q.error.code === '22007' || q.error.code === '22008') throw err('shape');
        throw mapError(q.error);
      }
      var out = isObj(q.data) ? q.data : { ok: true };
      if (out.ok === false) throw err(out.why === 'young' || out.why === 'shape' ? out.why : 'unavailable');
      if (firstFacts) firstFacts.hasBirth = true;
      return out;
    },
    // The last step of the first run: what brings you here, and done.
    finishFirstRun: async function (kinds) {
      var k = cleanKinds(kinds);
      var q = await sb.rpc('finish_first_run', { k: k });
      if (q.error) throw mapError(q.error);
      var out = isObj(q.data) ? q.data : { ok: true };
      if (out.ok !== false && firstFacts) { firstFacts.onboarded = true; firstFacts.kinds = k; }
      if (out.ok !== false) suggestClear(); // the code's head start has done its job
      return out;
    },
    // The same ticks, changed later from Settings.
    saveKinds: async function (kinds) {
      var k = cleanKinds(kinds);
      var q = await sb.rpc('save_kinds', { k: k });
      if (q.error) throw mapError(q.error);
      var out = isObj(q.data) ? q.data : { ok: true };
      if (out.ok !== false && firstFacts) firstFacts.kinds = k;
      return out;
    },
    profileCard: async function (userId) {
      var q = await sb.rpc('profile_card', { u: userId });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : null;
    },
    followList: async function (userId, which) {
      var q = await sb.rpc('follow_list', { u: userId, which: which === 'following' ? 'following' : 'followers' });
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    follow: async function (userId) {
      var q = await sb.from('follows').upsert({ follower_id: session.user.id, followee_id: userId },
        { onConflict: 'follower_id,followee_id', ignoreDuplicates: true });
      if (q.error) throw mapError(q.error);
    },
    unfollow: async function (userId) {
      var q = await sb.from('follows').delete().eq('follower_id', session.user.id).eq('followee_id', userId);
      if (q.error) throw mapError(q.error);
    },
    tourCard: async function (tourId, userId) {
      var q = await sb.rpc('tour_card', { t_id: tourId, u: userId });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : null;
    },
    flyer: async function (tourId) {
      var q = await sb.from('tour_flyers').select('image').eq('tour_id', tourId).maybeSingle();
      if (q.error) throw mapError(q.error);
      return q.data ? String(q.data.image || '') : '';
    },
    saveFlyer: async function (tourId, dataUrl) {
      var q = dataUrl
        ? await sb.from('tour_flyers').upsert({ tour_id: tourId, image: dataUrl, updated_by: session.user.id,
            updated_at: new Date().toISOString() })
        : await sb.from('tour_flyers').delete().eq('tour_id', tourId);
      if (q.error) throw mapError(q.error);
    },
    /* Artist profiles: a band or act with a username, a photo, and its band
       and crew, each a Greenroom account its owner found by search. Open to
       everyone signed in; only the owner changes one. */
    // Search before you type: people you follow, people you tour with, artists.
    searchSuggestions: async function () {
      var q = await sb.rpc('search_suggestions');
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : null;
    },
    myArtists: async function () {
      var q = await sb.rpc('my_artists');
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    // An artist endorses someone on its band or crew: for good, no taking it back.
    endorse: async function (artistId, userId) {
      var q = await sb.from('artist_endorsements').insert({ artist_id: artistId, user_id: userId, endorsed_by: session.user.id });
      if (q.error && q.error.code !== '23505') throw mapError(q.error);
      flowersStale(); emit('tours');
    },
    // The one person who can remove an endorsement is the one it was given
    // to. Already gone (say, from their other phone) counts as done.
    removeEndorsement: async function (id) {
      var q = await sb.rpc('remove_endorsement', { e_id: id });
      if (q.error) throw mapError(q.error);
      flowersStale(); emit('tours');
    },
    // The title an artist's page gives one of its people (what the public
    // sees there, whatever they are behind the scenes). The page's owner only.
    setMemberRole: async function (artistId, userId, role) {
      var q = await sb.from('artist_members').update({ role: String(role || '').trim().slice(0, 40) })
        .eq('artist_id', artistId).eq('user_id', userId).select('user_id');
      if (q.error) throw mapError(q.error);
      if (!q.data || !q.data.length) throw err('permission'); // RLS said no
    },
    /* ---- Tour credits: someone an artist endorsed confirms the tours and
       shows they worked; the artist says yes; then those nights count on
       their page. All of it goes through the database's own functions. ---- */
    creditAsks: async function () {
      var q = await sb.rpc('my_credit_asks');
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    creditQueue: async function () {
      var q = await sb.rpc('credit_queue');
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    creditTours: async function (artistId) {
      var q = await sb.rpc('credit_tours', { a_id: artistId });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : null;
    },
    creditShows: async function (artistId, key) {
      var q = await sb.rpc('credit_shows', { a_id: artistId, t_key: String(key) });
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    submitCredits: async function (artistId, claim) {
      var q = await sb.rpc('submit_tour_credits', { a_id: artistId, claim: claim });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    decideCredits: async function (artistId, userId, verdict, seen) {
      var q = await sb.rpc('decide_tour_credits', { a_id: artistId, u_id: userId, verdict: verdict, seen: seen || null });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    withdrawCredits: async function (artistId) {
      var q = await sb.rpc('withdraw_tour_credits', { a_id: artistId });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    creditDetail: async function (artistId, userId) {
      var q = await sb.rpc('credit_detail', { a_id: artistId, u_id: userId });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : null;
    },
    /* ---- Square (MODEL7MERCH, sandbox phase). The token is write-only:
       the table's column grants let it be saved, never read back. ---- */
    squareState: async function () {
      var q = await sb.from('square_connect')
        .select('env, merchant, location_id, location_name, status, detail, last_sync, connected_at')
        .maybeSingle();
      if (q.error) throw mapError(q.error);
      return q.data || null;
    },
    squareNights: async function () {
      var since = new Date(Date.now() - 60 * 864e5).toISOString();
      var q = await sb.from('square_payments').select('id, created_at, amount, tip, refunded, status')
        .gte('created_at', since).order('created_at', { ascending: true }).limit(1000);
      if (q.error) throw mapError(q.error);
      return q.data || [];
    },
    squareConnect: async function (token) {
      // Same two-step save as setlistConnect: the token column is
      // write-only, so a one-step save-or-replace is refused.
      var tok = String(token || '').trim();
      var up = await sb.from('square_connect').update({ env: 'sandbox', token: tok, status: 'new' })
        .eq('owner_id', session.user.id).select('owner_id');
      if (up.error) throw mapError(up.error);
      if (up.data && up.data.length) return;
      var ins = await sb.from('square_connect').insert(
        { owner_id: session.user.id, env: 'sandbox', token: tok, status: 'new' });
      if (ins.error && ins.error.code === '23505') {
        var again = await sb.from('square_connect').update({ env: 'sandbox', token: tok, status: 'new' })
          .eq('owner_id', session.user.id).select('owner_id');
        if (again.error) throw mapError(again.error);
        return;
      }
      if (ins.error) throw mapError(ins.error);
    },
    squareDisconnect: async function () {
      var q = await sb.from('square_connect').delete().eq('owner_id', session.user.id);
      if (q.error) throw mapError(q.error);
    },
    /* ---- Add missing tours: the server reads the news archives; the app
       reads the articles with the reading brain and hands back the tours. */
    // force: a rescan any time (not once a day); a search already running is handed back as it is.
    tourFindStart: async function (artistId, force) {
      var q = await sb.rpc('tour_find_start', { a_id: artistId, force: !!force });
      if (q.error) throw mapError(q.error);
      return q.data;
    },
    tourFindState: async function (artistId) {
      var q = await sb.rpc('tour_find_state', { a_id: artistId });
      if (q.error) throw mapError(q.error);
      return q.data;
    },
    tourFindPages: async function (artistId) {
      var q = await sb.rpc('tour_find_pages_get', { a_id: artistId });
      if (q.error) throw mapError(q.error);
      // null = another phone holds the read for a few minutes.
      return q.data === null ? null : (Array.isArray(q.data) ? q.data : []);
    },
    // readUrls: the articles the phone actually read (a batch the reader failed
    // on stays unread and is asked again); posters and pasted pages pass [].
    // trusted: a page or poster the owner handed over — their word, so it fills the page in by itself.
    tourFindPropose: async function (artistId, cands, readUrls, trusted) {
      var q = await sb.rpc('tour_find_propose', { a_id: artistId, cands: cands || [], read_urls: Array.isArray(readUrls) ? readUrls : null, trusted: !!trusted });
      if (q.error) throw mapError(q.error);
      return q.data;
    },
    tourCandidateDecide: async function (candId, add, name) {
      var q = await sb.rpc('tour_candidate_decide', { c_id: candId, add: !!add, new_name: name || null });
      if (q.error) throw mapError(q.error);
      return q.data;
    },
    // The nights of one tour on an artist page (anyone signed in), and naming a run on your own page.
    tourNights: async function (artistId, name) {
      var q = await sb.rpc('artist_tour_nights', { a_id: artistId, tour_name: name });
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    tourRunName: async function (artistId, first, last, name) {
      var q = await sb.rpc('tour_run_name', { a_id: artistId, first_day: first, last_day: last, new_name: name });
      if (q.error) throw mapError(q.error);
      return q.data;
    },
    tourFindNote: async function (artistId, note) {
      var q = await sb.rpc('tour_find_note', { a_id: artistId, note: note || '' });
      if (q.error) throw mapError(q.error);
    },
    // Correcting a tour the page shows: a new name, or off the page (sticks through re-syncs).
    artistTourEdit: async function (artistId, name, newName) {
      var q = await sb.rpc('artist_tour_edit', { a_id: artistId, tour_name: name, new_name: newName });
      if (q.error) throw mapError(q.error);
      return q.data;
    },
    artistTourRemove: async function (artistId, name) {
      var q = await sb.rpc('artist_tour_remove', { a_id: artistId, tour_name: name });
      if (q.error) throw mapError(q.error);
      return q.data;
    },
    // Tour conflicts: the contested nights of a tour, and settling one (this tour, that tour, or '' for wasn't there).
    artistTourConflicts: async function (artistId, name) {
      var q = await sb.rpc('artist_tour_conflicts', { a_id: artistId, tour_name: name });
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    artistTourPick: async function (artistId, date, name) {
      var q = await sb.rpc('artist_tour_pick', { a_id: artistId, night: date, tour_name: name || '' });
      if (q.error) throw mapError(q.error);
      return q.data;
    },
    tourCandidateUndo: async function (candId) {
      var q = await sb.rpc('tour_candidate_undo', { c_id: candId });
      if (q.error) throw mapError(q.error);
      return q.data;
    },
    /* ---- MY PAY's own cards: which bank accounts are yours, the inbox of
       what landed on them, and filing into your book. */
    myPayAccounts: async function () {
      var q = await sb.from('my_pay_accounts').select('account_id, name, card').eq('user_id', session.user.id);
      if (q.error) throw mapError(q.error);
      return q.data || [];
    },
    myPayClaimAccounts: async function (list) {
      var q = await sb.rpc('my_pay_claim_accounts', { ids: list || [] });
      if (q.error) throw mapError(q.error);
      return q.data;
    },
    myPayClaimItems: async function (items) {
      var q = await sb.rpc('my_pay_claim_items', { ids: items || [] });
      if (q.error) throw mapError(q.error);
      return q.data;
    },
    myPayTwins: async function () {
      var q = await sb.rpc('my_pay_twins');
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    myPayItemIds: async function () {
      var q = await sb.rpc('my_pay_item_ids');
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    myPayReleaseAccount: async function (accountId) {
      var q = await sb.rpc('my_pay_release_account', { acct: accountId });
      if (q.error) throw mapError(q.error);
    },
    myPayInbox: async function () {
      var q = await sb.from('my_pay_feed').select('id, kind, date, merchant, amount, account, card').eq('user_id', session.user.id)
        .eq('status', 'new').order('date', { ascending: false }).limit(200);
      if (q.error) throw mapError(q.error);
      return q.data || [];
    },
    myPayFile: async function (tourId, itemId, category, how) {
      var q = await sb.rpc('my_pay_file', { t_id: tourId, item_id: itemId, category: category, how: how || null });
      if (q.error) throw mapError(q.error);
    },
    myPaySkip: async function (itemId) {
      var q = await sb.rpc('my_pay_skip', { item_id: itemId });
      if (q.error) throw mapError(q.error);
    },
    /* ---- MY PAY: your slice of a tour's money (the server picks out your
       crew row and the pay logged to you) and your own book of spending. */
    myPay: async function (tourId) {
      var q = await sb.rpc('my_pay', { t_id: tourId });
      if (q.error) throw mapError(q.error);
      return q.data || null;
    },
    myPayBook: async function (tourId) {
      var q = await sb.from('my_pay_books').select('doc').eq('tour_id', tourId).eq('user_id', session.user.id).maybeSingle();
      if (q.error) throw mapError(q.error);
      return q.data && q.data.doc ? q.data.doc : {};
    },
    saveMyPayBook: async function (tourId, doc) {
      var q = await sb.from('my_pay_books').upsert({ tour_id: tourId, user_id: session.user.id, doc: doc || {}, updated_at: new Date().toISOString() },
        { onConflict: 'tour_id,user_id' });
      if (q.error) throw mapError(q.error);
    },
    /* ---- Tour history (setlist.fm). The key is write-only, like Square's:
       saved or replaced, never read back. The history row itself is as
       public as the artist page. ---- */
    setlistState: async function () {
      var q = await sb.from('setlist_connect')
        .select('status, detail, last_sync, connected_at').maybeSingle();
      if (q.error) throw mapError(q.error);
      return q.data || null;
    },
    setlistConnect: async function (token) {
      // The key column is write-only, and Postgres refuses a one-step
      // save-or-replace on a column it can't read back. So: replace the
      // row if it's there, insert it fresh if not (and if two phones race,
      // the loser's insert becomes a replace).
      var tok = String(token || '').trim();
      var up = await sb.from('setlist_connect').update({ token: tok, status: 'new' })
        .eq('owner_id', session.user.id).select('owner_id');
      if (up.error) throw mapError(up.error);
      if (up.data && up.data.length) return;
      var ins = await sb.from('setlist_connect').insert(
        { owner_id: session.user.id, token: tok, status: 'new' });
      if (ins.error && ins.error.code === '23505') {
        var again = await sb.from('setlist_connect').update({ token: tok, status: 'new' })
          .eq('owner_id', session.user.id).select('owner_id');
        if (again.error) throw mapError(again.error);
        return;
      }
      if (ins.error) throw mapError(ins.error);
    },
    setlistDisconnect: async function () {
      var q = await sb.from('setlist_connect').delete().eq('owner_id', session.user.id);
      if (q.error) throw mapError(q.error);
    },
    artistHistory: async function (artistId) {
      var q = await sb.from('artist_history')
        .select('artist_id, status, detail, total, pages, next_page, summary, synced_at, mb_url, auto, credits')
        .eq('artist_id', artistId).maybeSingle();
      if (q.error) throw mapError(q.error);
      return q.data || null;
    },
    historyStart: async function (artistId) {
      var q = await sb.rpc('artist_history_start', { a_id: artistId });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    historyStop: async function (artistId) {
      var q = await sb.rpc('artist_history_stop', { a_id: artistId });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    /* ---- Every artist. Search reaches every act there is by asking
       MusicBrainz, the open music encyclopedia, as you type (the phone asks
       it directly: it is public, needs no key, and only ever sees the words
       typed into Search). An act with no page here gets one the moment it
       is opened: unclaimed, run by nobody, until someone in the band claims
       it and a Greenroom admin says yes. ---- */
    mbSearch: async function (text, signal) {
      var words = String(text || '').replace(/["\\+\-!(){}\[\]^~*?:\/&|]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 6);
      if (!words.length || words.join('').length < 2) return [];
      // The whole phrase, or every word with the last one still being typed.
      var query = 'artist:"' + words.join(' ') + '" OR artist:(' + words.map(function (w, i) {
        return i === words.length - 1 ? w + '*' : w;
      }).join(' AND ') + ')';
      var res = await fetch('https://musicbrainz.org/ws/2/artist?fmt=json&limit=12&query=' + encodeURIComponent(query),
        { headers: { Accept: 'application/json' }, signal: signal || undefined });
      if (!res.ok) throw err(res.status === 503 || res.status === 429 ? 'busy' : 'unavailable');
      var body = await res.json();
      var list = Array.isArray(body && body.artists) ? body.artists : [];
      // The encyclopedia also files characters, orchestras' sub-units and
      // plain junk: only acts that tour, with a name a page could carry.
      return list.filter(function (a) {
        var type = String(a.type || '');
        return a && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(a.id || '')) &&
          (type === 'Group' || type === 'Person' || type === 'Orchestra' || type === 'Choir') &&
          String(a.name || '').trim() && String(a.name).length <= 60 && Number(a.score) >= 55;
      }).slice(0, 8).map(function (a) {
        return { mbid: String(a.id), name: String(a.name).trim(), about: String(a.disambiguation || '').slice(0, 80),
          country: String(a.country || ''), type: String(a.type || ''), score: Number(a.score) || 0 };
      });
    },
    // The page for an encyclopedia entry: the one it already has here, or a
    // new unclaimed one. { id, made }
    openMbArtist: async function (mbid, nameHint) {
      var q = await sb.rpc('artist_open_mb', { mb_id: String(mbid || ''), name_hint: String(nameHint || '').slice(0, 60) });
      if (q.error) {
        if (/too many today/i.test(String(q.error.message || ''))) { var many = new Error('too-many'); many.code = 'too-many'; throw many; }
        throw mapError(q.error);
      }
      return isObj(q.data) ? q.data : null;
    },
    // Someone is looking at a page: its history steps along now rather than
    // on the minute. Hands back the history row (null when there is none).
    historyNudge: async function (artistId, fresh) {
      var q = await sb.rpc('artist_history_nudge', { a_id: artistId, fresh: !!fresh });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : null;
    },
    /* Asking for a page nobody runs: who you are to the act, and where that
       can be checked. o = { role, note, links: { spotify, instagram, website } }.
       The answer carries a code ({ ok: true, code: 'GR-7KQ2' }) to put in the
       artist's Instagram bio or on its website, so Greenroom can check it.
       Throws 'short' with no proof at all (no link, and a note under three
       letters) and 'too-many'. Older callers passed (artistId, note, link):
       a string second argument still works. */
    claimArtist: async function (artistId, o, oldLink) {
      var c = isObj(o) ? o : { note: o, link: oldLink };
      var note = String(c.note || '').trim().slice(0, 500);
      var role = String(c.role || '').trim().slice(0, 40);
      // The database keeps a proof link only when it is a full https address
      // (0134, claim_links). People type "@theband" and "theband.com": those
      // are made into addresses here. Anything that still is not one rides
      // in the old single-link box, so nothing typed is lost on the way.
      var links = {}, loose = '';
      ['spotify', 'instagram', 'website'].forEach(function (k) {
        var raw = isObj(c.links) ? String(c.links[k] || '').trim() : '';
        if (!raw) return;
        var url = httpsLink(k, raw).slice(0, 200);
        if (/^https:\/\/\S{4,}$/i.test(url)) links[k] = url;
        else if (!loose) loose = raw.slice(0, 200);
      });
      var link = String(c.link || '').trim().slice(0, 200) || loose;
      if (!link && !Object.keys(links).length && note.length < 3) throw err('short');
      var q = await sb.rpc('claim_artist', { a_id: artistId, note: note, link: link, role: role, links: links });
      if (q.error && fnMissing(q.error)) {
        // The database still has the older claim (a note and one link): send
        // it everything in the note, so whoever reviews it misses nothing.
        var all = [role, note].concat(Object.keys(links).map(function (k) { return k + ': ' + links[k]; }))
          .filter(Boolean).join(' · ').slice(0, 500);
        q = await sb.rpc('claim_artist', { a_id: artistId, note: all,
          link: link || links.website || links.spotify || links.instagram || '' });
      }
      if (q.error) {
        var m = String(q.error.message || '');
        if (/say who you are/i.test(m)) throw err('short');
        if (/too many/i.test(m)) throw err('too-many');
        throw mapError(q.error);
      }
      return isObj(q.data) ? q.data : { ok: false };
    },
    withdrawClaim: async function (artistId) {
      var q = await sb.rpc('withdraw_claim', { a_id: artistId });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    myClaims: async function () {
      var q = await sb.rpc('my_claims');
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    // For a Greenroom admin: every claim waiting. Null for everyone else.
    claimQueue: async function () {
      var q = await sb.rpc('claim_queue');
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : null;
    },
    decideClaim: async function (claimId, approve) {
      var q = await sb.rpc('decide_claim', { c_id: claimId, approve: !!approve });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    /* ---- Asking an artist to list you. A newcomer cannot put themselves on
       an artist's page: they ask (as a Member, kind 'band', or as crew, with
       the role they hold) and the people who run the page say yes or no. A
       yes lists them and endorses them in one go. { ok: false, why } is an
       answer, not a failure: 'listed' (already on the page), 'former_member',
       'wait' (declined in the last week), 'many' (ten already waiting). ---- */
    requestArtist: async function (artistId, kind, role) {
      var q = await sb.rpc('request_artist', { a_id: artistId, k: kind === 'crew' ? 'crew' : 'band',
        r: String(role || '').trim().slice(0, 40) });
      // Someone who left as a member cannot come back as crew yet (0132 says so with an error).
      if (q.error && /former_member/.test(String(q.error.message || ''))) return { ok: false, why: 'former_member' };
      if (q.error) throw knownError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    // Your own asks and where each stands: pending, expired (no answer in 30 days), declined, accepted.
    myArtistRequests: async function () {
      var q = await sb.rpc('my_artist_requests');
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    withdrawArtistRequest: async function (artistId) {
      var q = await sb.rpc('withdraw_artist_request', { a_id: artistId });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    // Who is waiting on one page you run, or (no id) on every page you run.
    artistRequestQueue: async function (artistId) {
      var q = await sb.rpc('artist_request_queue', { a_id: artistId || null });
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    decideArtistRequest: async function (artistId, userId, accept) {
      var q = await sb.rpc('decide_artist_request', { a_id: artistId, u_id: userId, accept: !!accept });
      if (q.error && /former_member/.test(String(q.error.message || ''))) return { ok: false, why: 'former_member' };
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    /* ---- Fans: the nights of one tour (or festival entry) on an artist's
       history, each with whether you were there, and saying you were. Only a
       night already played can be marked. ---- */
    fanNights: async function (artistId, tourName) {
      var q = await sb.rpc('artist_fan_nights', { a_id: artistId, tour_name: tourName });
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    // { ok: true, count } (your lifetime shows attended) or { ok: false, why: 'future' | 'none' | 'many' }.
    markAttended: async function (artistId, date, going) {
      var q = await sb.rpc('mark_attended', { a_id: artistId, night: date, going: going !== false });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    myAttended: async function () {
      var q = await sb.rpc('my_attended');
      if (q.error) throw mapError(q.error);
      var d = isObj(q.data) ? q.data : {};
      return { count: Number(d.count) || 0, artists: Array.isArray(d.artists) ? d.artists : [] };
    },
    /* ---- Venues and festivals ("places"). Search reads the show archive: a
       row is a place with shows on record, not yet a page. Opening one finds
       its page or makes it, the way an artist's page is made. Someone who
       worked there asks to be listed, with their role. ---- */
    findPlaces: async function (text) {
      var q = await sb.rpc('find_places', { q: String(text || '') });
      if (q.error) throw mapError(q.error);
      var d = isObj(q.data) ? q.data : {};
      return { venues: Array.isArray(d.venues) ? d.venues : [], festivals: Array.isArray(d.festivals) ? d.festivals : [] };
    },
    openVenue: async function (name, city, cc) {
      var q = await sb.rpc('venue_open', { v_name: String(name || ''), v_city: String(city || ''), v_cc: String(cc || '') });
      if (q.error) throw knownError(q.error);
      return isObj(q.data) ? q.data : null;
    },
    openFestival: async function (name) {
      var q = await sb.rpc('festival_open', { f_name: String(name || '') });
      if (q.error) throw knownError(q.error);
      return isObj(q.data) ? q.data : null;
    },
    venueCard: async function (id) {
      var q = await sb.rpc('venue_card', { v_id: id });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : null;
    },
    festivalCard: async function (id) {
      var q = await sb.rpc('festival_card', { f_id: id });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : null;
    },
    // o = { venueId } or { festivalId }, plus role. Throws 'too-many'.
    placeWorkAsk: async function (o) {
      var p = o || {};
      var q = await sb.rpc('place_work_ask', { v_id: p.venueId || null, f_id: p.festivalId || null,
        r: String(p.role || '').trim().slice(0, 40) });
      if (q.error) throw knownError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    placeWorkWithdraw: async function (o) {
      var p = o || {};
      var q = await sb.rpc('place_work_withdraw', { v_id: p.venueId || null, f_id: p.festivalId || null });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    myPlaces: async function () {
      var q = await sb.rpc('my_places');
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    /* ---- Invite codes: what gets someone through the door with no tour
       invite. A Greenroom admin makes them; null for everyone else (so the
       app knows not to show the door, like claimQueue). ---- */
    inviteCodes: async function () {
      var q = await sb.rpc('invite_codes');
      if (q.error) throw mapError(q.error);
      return q.data == null ? null : (Array.isArray(q.data) ? q.data : []);
    },
    // o = { kinds ([] = any), uses, days, note }. Hands back { code }.
    makeInviteCode: async function (o) {
      var p = o || {};
      var q = await sb.rpc('invite_code_make', { k: cleanKinds(p.kinds),
        uses: Math.max(1, Math.round(Number(p.uses)) || 1), days: Math.max(1, Math.round(Number(p.days)) || 30),
        note: String(p.note || '').trim().slice(0, 80) });
      if (q.error) throw knownError(q.error);
      return isObj(q.data) ? q.data : null;
    },
    revokeInviteCode: async function (code) {
      var q = await sb.rpc('invite_code_revoke', { c: String(code || '') });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    /* ---- New income: bank deposits on watched accounts (date and amount
       only) that no matcher claimed. RLS hands them to their owner alone. ---- */
    incomeNew: async function () {
      var q = await sb.from('merch_deposits').select('id, date, amount, atvenu, watch')
        .eq('matched', false).order('date', { ascending: false }).limit(200);
      if (q.error) throw mapError(q.error);
      return q.data || [];
    },
    // Says what a deposit was and which book it belongs to. kind 'skip'
    // clears it for good; a showId pins merch or a guarantee to one night.
    // kind 'other' is a deposit that is none of the four: note is the few
    // words typed for it ("Sync licence"), kept on the entry as its label.
    catalogIncome: async function (depId, opts) {
      var o = opts || {};
      var args = { dep_id: String(depId), t_id: o.tourId || null, s_id: o.showId || null, kind: String(o.kind || '') };
      // The note goes only with 'other', and only when something was typed:
      // every other answer is the same four-argument call it has always been,
      // so it also works on a database from before the note existed (0141).
      // (Blanks folded, 60 whole characters at most; the database cleans it again.)
      var note = o.kind === 'other' && o.note != null
        ? Array.from(String(o.note).replace(/\s+/g, ' ').trim())
            .filter(function (ch) { return !/^[\uD800-\uDFFF]$/.test(ch); }).slice(0, 60).join('').trim() : '';
      if (note) args.note = note;
      var q = await sb.rpc('catalog_income', args);
      if (q.error) throw mapError(q.error);
      var out = isObj(q.data) ? q.data : { ok: false };
      // The write landed inside the database; pull the books fresh so the
      // phone shows it without waiting on realtime.
      if (out.ok && o.tourId) { try { await refetch(); } catch (e) { /* realtime catches up */ } }
      return out;
    },
    // This copy of the file sends the note. The app asks before it logs an
    // "Other" deposit with words typed: an older copy would drop them.
    catalogIncomeNote: true,
    // One guarantee deposit that paid for several nights: parts is
    // [{ show, amount, agent? }], the shares adding up to the deposit. Every
    // night is marked received with its share, or nothing is written.
    catalogIncomeSplit: async function (depId, opts) {
      var o = opts || {};
      var q = await sb.rpc('catalog_income_split', {
        dep_id: String(depId), t_id: o.tourId || null, parts: Array.isArray(o.parts) ? o.parts : [] });
      if (q.error) throw mapError(q.error);
      var out = isObj(q.data) ? q.data : { ok: false };
      if (out.ok && o.tourId) { try { await refetch(); } catch (e) { /* realtime catches up */ } }
      return out;
    },
    // Who charges under Crew were for: tags is { <charge key>: <crew id> | null }.
    // The database sets it only on a charge that is there, filed under Crew,
    // for a person on that tour's list.
    setChargeCrew: async function (tourId, tags, keep) {
      var q = await sb.rpc('set_charge_crew', { t_id: String(tourId), tags: isObj(tags) ? tags : {}, keep: !!keep });
      if (q.error) throw mapError(q.error);
      var out = isObj(q.data) ? q.data : { ok: false };
      if (out.ok) { try { await refetch(); } catch (e) { /* realtime catches up */ } }
      return out;
    },
    // A guarantee logged "Sort later" finds its show(s): parts is
    // [{ show, amount, agent? }], all of it or part of it (the rest stays to
    // sort); whole keeps what is left on the tour as money that belongs to no
    // one night. The tour's creator or a Manager.
    sortGuarantee: async function (depId, opts) {
      var o = opts || {};
      var q = await sb.rpc('sort_guarantee', {
        dep_id: String(depId), t_id: o.tourId || null, parts: Array.isArray(o.parts) ? o.parts : [], whole: !!o.whole,
        // What this phone saw waiting: a tap that lands twice, or on an old amount, is refused.
        expect: typeof o.expect === 'number' ? o.expect : null });
      if (q.error) throw mapError(q.error);
      var out = isObj(q.data) ? q.data : { ok: false };
      // (Also when it had changed underneath: the phone must see what is really left.)
      if ((out.ok || out.why === 'changed') && o.tourId) { try { await refetch(); } catch (e) { /* realtime catches up */ } }
      return out;
    },
    // One merch deposit that paid for several nights: parts is [{ show, amount }],
    // the shares adding up to the deposit. Its own call (never a guarantee
    // split with a word added), so a phone running this file's older copy
    // has no way to file merch as guarantees.
    catalogMerchSplit: async function (depId, opts) {
      var o = opts || {};
      var q = await sb.rpc('catalog_merch_split', {
        dep_id: String(depId), t_id: o.tourId || null, parts: Array.isArray(o.parts) ? o.parts : [] });
      if (q.error) throw mapError(q.error);
      var out = isObj(q.data) ? q.data : { ok: false };
      if (out.ok && o.tourId) { try { await refetch(); } catch (e) { /* realtime catches up */ } }
      return out;
    },
    // A merch deposit logged "Not sure which show yet" finds its show(s):
    // parts is [{ show, amount }], all of it or part of it (the rest stays to
    // sort). The tour's creator or a Manager.
    sortMerch: async function (depId, opts) {
      var o = opts || {};
      var q = await sb.rpc('sort_merch', {
        dep_id: String(depId), t_id: o.tourId || null, parts: Array.isArray(o.parts) ? o.parts : [],
        expect: typeof o.expect === 'number' ? o.expect : null });
      if (q.error) throw mapError(q.error);
      var out = isObj(q.data) ? q.data : { ok: false };
      if ((out.ok || out.why === 'changed') && o.tourId) { try { await refetch(); } catch (e) { /* realtime catches up */ } }
      return out;
    },
    // Set aside by mistake: off the tour's list and back into New income.
    unparkMerch: async function (depId, opts) {
      var o = opts || {};
      var q = await sb.rpc('unpark_merch', { dep_id: String(depId), t_id: o.tourId || null });
      if (q.error) throw mapError(q.error);
      var out = isObj(q.data) ? q.data : { ok: false };
      if (out.ok && o.tourId) { try { await refetch(); } catch (e) { /* realtime catches up */ } }
      return out;
    },
    // Logged "Sort later" by mistake: off the tour and back into New income.
    unparkGuarantee: async function (depId, opts) {
      var o = opts || {};
      var q = await sb.rpc('unpark_guarantee', { dep_id: String(depId), t_id: o.tourId || null });
      if (q.error) throw mapError(q.error);
      var out = isObj(q.data) ? q.data : { ok: false };
      if (out.ok && o.tourId) { try { await refetch(); } catch (e) { /* realtime catches up */ } }
      return out;
    },
    // Following an artist's page.
    followArtist: async function (artistId) {
      var q = await sb.from('artist_follows').upsert({ user_id: session.user.id, artist_id: artistId },
        { onConflict: 'user_id,artist_id', ignoreDuplicates: true });
      if (q.error) throw mapError(q.error);
    },
    unfollowArtist: async function (artistId) {
      var q = await sb.from('artist_follows').delete().eq('user_id', session.user.id).eq('artist_id', artistId);
      if (q.error) throw mapError(q.error);
    },
    artistCard: async function (id) {
      var q = await sb.rpc('artist_card', { a_id: id });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : null;
    },
    artistHandleFree: async function (h, forArtist) {
      var q = await sb.rpc('artist_handle_free', { h: String(h || ''), for_artist: forArtist || null });
      if (q.error) throw mapError(q.error);
      return q.data === true;
    },
    createArtist: async function (a) {
      var id = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : null;
      var row = { owner_id: session.user.id, handle: String(a.handle || '').trim().toLowerCase(),
        name: String(a.name || '').trim().slice(0, 60), avatar: String(a.avatar || '').slice(0, 120000) };
      if (id) row.id = id;
      var q = await sb.from('artists').insert(row).select('id').single();
      if (q.error) {
        if (q.error.code === '23505') { var taken = new Error('taken'); taken.code = 'taken'; throw taken; }
        if (q.error.code === '23514') { var bad = new Error('shape'); bad.code = 'shape'; throw bad; }
        throw mapError(q.error);
      }
      return q.data.id;
    },
    saveArtist: async function (id, patch) {
      var row = {};
      if (patch.name != null) row.name = String(patch.name).trim().slice(0, 60);
      if (patch.handle != null) row.handle = String(patch.handle).trim().toLowerCase();
      if (patch.bio != null) row.bio = String(patch.bio).slice(0, 300);
      if (patch.avatar != null) row.avatar = String(patch.avatar).slice(0, 120000);
      var q = await sb.from('artists').update(row).eq('id', id);
      if (q.error) {
        if (q.error.code === '23505') { var taken = new Error('taken'); taken.code = 'taken'; throw taken; }
        if (q.error.code === '23514') { var bad = new Error('shape'); bad.code = 'shape'; throw bad; }
        throw mapError(q.error);
      }
    },
    deleteArtist: async function (id) {
      var q = await sb.from('artists').delete().eq('id', id);
      if (q.error) throw mapError(q.error);
    },
    addArtistMember: async function (id, userId, kind) {
      var q = await sb.from('artist_members').upsert({ artist_id: id, user_id: userId, kind: kind === 'crew' ? 'crew' : 'band' },
        { onConflict: 'artist_id,user_id' });
      // Someone who left as a member cannot be listed again as crew yet (0132).
      if (q.error && /former_member/.test(String(q.error.message || ''))) throw err('former_member');
      if (q.error) throw mapError(q.error);
    },
    /* Taking someone off an artist page ends their listing; it does not erase
       it (0132). Everything up to today stays on their own page. Never
       endorsed: simply taken off ({kept: false}). A member let go by someone
       else waits on every other member's yes ({pending: true, waiting: n}). */
    removeArtistMember: async function (id, userId) {
      var q = await sb.rpc('end_artist_member', { a_id: id, u_id: userId, on_day: localDay() });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : { ok: true };
    },
    memberRemovalAsks: async function () {
      var q = await sb.rpc('member_removal_asks');
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    answerMemberRemoval: async function (id, userId, agree) {
      var q = await sb.rpc('answer_member_removal', { a_id: id, u_id: userId, agree: !!agree, on_day: localDay() });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    cancelMemberRemoval: async function (id, userId) {
      var q = await sb.rpc('cancel_member_removal', { a_id: id, u_id: userId });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : { ok: false };
    },
    findPeople: async function (text) {
      var q = await sb.rpc('find_people', { q: String(text || '') });
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    findArtists: async function (text) {
      var q = await sb.rpc('find_artists', { q: String(text || '') });
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    findTours: async function (text) {
      var q = await sb.rpc('find_tours', { q: String(text || '') });
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    artistTourCard: async function (artistId, tourId) {
      var q = await sb.rpc('artist_tour_card', { a_id: artistId, t_id: tourId });
      if (q.error) throw mapError(q.error);
      return isObj(q.data) ? q.data : null;
    },
    /* Direct messages: readable by the two people in them, nobody else (the
       database's rule, not the app's). A new one arriving pokes dmWatch. */
    dmThreads: async function () {
      var q = await sb.rpc('dm_threads');
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    dmThread: async function (otherId) {
      var me = session.user.id;
      var q = await sb.from('dms').select('id, sender, recipient, body, created_at, read_at')
        .or('and(sender.eq.' + me + ',recipient.eq.' + otherId + '),and(sender.eq.' + otherId + ',recipient.eq.' + me + ')')
        .order('created_at', { ascending: false }).limit(200);
      if (q.error) throw mapError(q.error);
      return (q.data || []).reverse().map(function (m) {
        return { id: m.id, mine: m.sender === me, body: m.body, at: m.created_at, read: !!m.read_at };
      });
    },
    dmSend: async function (otherId, body) {
      var q = await sb.from('dms').insert({ sender: session.user.id, recipient: otherId, body: String(body || '').trim().slice(0, 2000) });
      if (q.error) throw mapError(q.error);
    },
    dmRead: async function (otherId) {
      var q = await sb.rpc('dm_read', { other: otherId });
      if (q.error) throw mapError(q.error);
    },
    dmWatch: function (fn) { dmListeners.push(fn); },
    // How to reach someone you tour with: what's on their contact card.
    contactOf: async function (userId) {
      var q = await sb.from('profiles').select('phone, email').eq('user_id', userId).maybeSingle();
      if (q.error) throw mapError(q.error);
      return { phone: q.data ? String(q.data.phone || '') : '', email: q.data ? String(q.data.email || '') : '' };
    },
    /* The tour's phone book: everyone invited, plus the manager who owns it. */
    crew: async function (tourId) {
      var mq = await sb.from('members')
        .select('invited_email, role, user_id, display_name, phone, tour_role, overrides, manager')
        .eq('tour_id', tourId).order('created_at');
      if (mq.error) throw mapError(mq.error);
      var rows = mq.data || [];
      var doc = cache.tours.get(tourId);
      var ownerId = doc ? doc._ownerId : null;
      var ids = rows.map(function (r) { return r.user_id; }).filter(Boolean);
      if (ownerId) ids.push(ownerId);
      var byId = {};
      if (ids.length) {
        var pq = await sb.from('profiles')
          .select('user_id, full_name, username, email, phone, tour_role').in('user_id', ids);
        (pq.data || []).forEach(function (x) { byId[x.user_id] = x; });
      }
      var out = [];
      if (ownerId) {
        var op = byId[ownerId] || {};
        out.push({
          owner: true, role: 'owner', userId: ownerId,
          name: op.full_name || '', username: op.username || '',
          email: op.email || (ownerId === (session && session.user && session.user.id) ? session.user.email : ''),
          phone: op.phone || '', tourRole: roleName(op.tour_role), joined: true
        });
      }
      rows.forEach(function (r) {
        var pr = byId[r.user_id] || {};
        // Their own card once they've signed up; what the invite said until
        // then; and over both, whatever the tour manager or a Manager edited.
        var base = {
          email: pr.email || r.invited_email,
          phone: pr.phone || r.phone || '',
          tourRole: roleName(pr.tour_role || r.tour_role)
        };
        var ov = isObj(r.overrides) ? r.overrides : {};
        out.push({
          owner: false, role: r.role, manager: !!r.manager && r.role === 'editor', userId: r.user_id || null,
          name: pr.full_name || r.display_name || '',
          username: pr.username || '',
          email: ov.email || base.email,
          invitedEmail: r.invited_email,
          phone: ov.phone || base.phone,
          tourRole: ov.tourRole || base.tourRole,
          base: base,
          joined: !!r.user_id
        });
      });
      return out;
    },
    setUsername: async function (name) {
      var clean = String(name || '').trim().slice(0, 24);
      var q = await sb.auth.updateUser({ data: { username: clean } });
      if (q.error) throw mapError(q.error);
      if (q.data && q.data.user && session) session.user = q.data.user;
    },
    myRole: async function (tourId) {
      var doc = cache.tours.get(tourId);
      if (doc && session && doc._ownerId === session.user.id) return 'owner';
      // An artist's Off Tour book: the database only hands it to Managers.
      if (doc && doc.kind === 'offtour') return 'editor';
      var q = await sb.from('members').select('role')
        .eq('tour_id', tourId).eq('user_id', session ? session.user.id : '').maybeSingle();
      return (q.data && q.data.role) || 'viewer';
    },
    ownsTour: function (tourId) {
      var doc = cache.tours.get(tourId);
      return !!(doc && session && doc._ownerId === session.user.id);
    },
    members: async function (tourId) {
      var q = await sb.from('members').select('invited_email, role, user_id, display_name, manager')
        .eq('tour_id', tourId).order('created_at');
      if (q.error) throw mapError(q.error);
      return q.data;
    },
    /* Ari reads something and says it in the tour's chat. Only the server
       can post as Ari, and only for the tour manager or a Manager. */
    ariSay: async function (tourId, prompt, images) {
      var out = await callRead(prompt, { images: images || undefined, ariTour: tourId });
      scheduleRefetch();
      return out.text;
    },
    /* Lay every atVenu report the mailbox has kept back onto a tour. Waits
       for the fresh tour, so the app can show what came in straight away. */
    // Nudge Ari to look at this tour now (a day sheet was just posted), so
    // DAY SHEET AVAILABLE doesn't wait for the next minute's check.
    ariKick: async function (tourId) {
      try {
        var tz = '';
        try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* none */ }
        await callFn('ari', { method: 'POST', body: JSON.stringify({ tourId: tourId, tz: tz }) });
      } catch (e) { /* the minute clock catches it anyway */ }
    },
    atvenuRefresh: async function (tourId, showId) {
      var r = await callFn('atvenu', { method: 'POST',
        body: JSON.stringify({ action: 'refresh', tourId: tourId, showId: showId || undefined }) });
      var out = {};
      try { out = await r.json(); } catch (e) { out = {}; }
      if (out && out.ok) { try { await refetch(); } catch (e) { /* realtime catches up */ } }
      return out;
    },
    /* Everyone this tour manager has invited before, on any tour. */
    pastCrew: async function () {
      var q = await sb.from('past_crew').select('email, name, phone, role, tour_role').order('name');
      if (q.error) throw mapError(q.error);
      return (q.data || []).map(function (r) { return Object.assign({}, r, { tourRole: roleName(r.tour_role) }); });
    },
    forgetPastCrew: async function (email) {
      var q = await sb.from('past_crew').delete().eq('email', String(email).toLowerCase());
      if (q.error) throw mapError(q.error);
    },
    invite: async function (tourId, email, role, name, phone, extra) {
      var addr = String(email).trim().toLowerCase();
      var x = extra || {};
      var full = String(name || '').trim();
      var first = String(x.first || full.split(/\s+/)[0] || '').trim();
      var last = String(x.last || full.split(/\s+/).slice(1).join(' ') || '').trim();
      var tourRole = String(x.tourRole || '').trim().slice(0, 40);
      // A Manager is stored as 'editor' with the manager mark (only the creator's mark sticks).
      var mgr = role === 'manager';
      if (mgr) role = 'editor';
      var row = {
        tour_id: tourId,
        invited_email: addr,
        role: role === 'editor' ? 'editor' : 'viewer',
        display_name: String(name || '').trim().slice(0, 60),
        phone: String(phone || '').trim().slice(0, 30),
        tour_role: tourRole
      };
      if (mgr) row.manager = true;
      // The door first: the database only makes an account for an address that was let in (24 hours,
      // spent by the sign-up; a day's invites are capped). Refused here, nothing is left half done.
      // Two of its refusals the app has words for: an account that came in on a Greenroom code cannot
      // add people until Greenroom has confirmed an artist page of theirs ('page-first'), and the
      // day's limit ('too-many').
      var al = await sb.rpc('allow_signup', { addr: addr, note: tourRole });
      if (al.error) throw /page first/i.test(String(al.error.message || '')) ? err('page-first') : knownError(al.error);
      var q = await sb.from('members').upsert(row);
      if (q.error) throw mapError(q.error);
      // Remembered for the next tour's invites. A nicety: never blocks the invite.
      try {
        await sb.from('past_crew').upsert({
          owner_id: session.user.id, email: addr,
          name: String(name || '').trim().slice(0, 60),
          phone: String(phone || '').trim().slice(0, 30),
          role: role === 'editor' ? 'editor' : 'viewer',
          tour_role: tourRole,
          updated_at: new Date().toISOString()
        });
      } catch (e) { /* the list can catch up next time */ }
      // The row alone is enough — an account made with this address claims it.
      // The edge function adds the nicety: the account and the invite email.
      try {
        var r = await callFn('invite', {
          method: 'POST',
          // Everything the manager typed rides along, so the invited person's
          // sign-up is only a username and a password.
          body: JSON.stringify({ tourId: tourId, email: addr, name: full, first: first, last: last,
            tourRole: tourRole, phone: String(phone || '').trim(), access: role === 'editor' ? 'editor' : 'viewer' })
        });
        var out = await r.json();
        return out && out.status ? out.status : 'nomail';
      } catch (e) { return 'nomail'; }
    },
    // The tour manager and Managers: someone's role, contact info and
    // access, or off the tour. The database checks who's asking.
    editMember: async function (tourId, email, access, overrides) {
      var q = await sb.rpc('edit_member', { t_id: tourId, addr: email, new_access: access, ov: overrides || {} });
      if (q.error) throw mapError(q.error);
    },
    kickMember: async function (tourId, email) {
      var q = await sb.rpc('kick_member', { t_id: tourId, addr: email });
      if (q.error) throw mapError(q.error);
    },
    uninvite: async function (tourId, email) {
      var q = await sb.from('members').delete()
        .eq('tour_id', tourId).eq('invited_email', email).select('invited_email');
      if (q.error) throw mapError(q.error);
      if (!q.data || !q.data.length) throw err('permission');
    },
    // Letting an address in without a tour invite (a Greenroom admin, or a
    // tour manager sending a code ahead of the tour).
    allowSignup: async function (addr, note) {
      var q = await sb.rpc('allow_signup', { addr: String(addr || ''), note: String(note || '') });
      if (q.error) throw (/page first/i.test(String(q.error.message || '')) ? err('page-first') : knownError(q.error));
      return isObj(q.data) ? q.data : { ok: false };
    },
    // Deleting your own account and what is yours alone. The database says
    // no while you still run a tour or an artist page. Once it's gone the
    // sign-in here is void, so the page starts over at the door.
    deleteAccount: async function () {
      var q = await sb.rpc('delete_my_account');
      if (q.error) throw mapError(q.error);
      var out = isObj(q.data) ? q.data : { ok: false };
      if (out.ok) {
        try { Object.keys(localStorage).forEach(function (k) { if (/^sb-.*-auth-token/.test(k)) localStorage.removeItem(k); }); } catch (e) { /* reload clears what it can */ }
        setTimeout(function () { location.reload(); }, 900);
      }
      return out;
    },
    // Every crew member's road story on a tour, for their badges on Crew Stats.
    roadTiers: async function (tourId) {
      var q = await sb.rpc('road_tiers', { t_id: tourId });
      if (q.error) throw mapError(q.error);
      return Array.isArray(q.data) ? q.data : [];
    },
    uid: function () { return session && session.user ? session.user.id : null; },
    /* The calendar. Everyone on the tour sees every poll, vote and request;
       the database decides who may write what. */
    pollFor: function (tourId, date) {
      var p = cache.polls.filter(function (x) { return x.tour_id === tourId && x.date === date; })[0];
      return p ? { date: p.date, options: Array.isArray(p.options) ? p.options : [], closesAt: p.closes_at, createdAt: p.created_at } : null;
    },
    votesFor: function (tourId, date) {
      return cache.votes.filter(function (v) { return v.tour_id === tourId && v.date === date; })
        .map(function (v) { return { userId: v.user_id, choice: v.choice, name: v.name }; });
    },
    requestsFor: function (tourId, date) {
      return cache.requests.filter(function (r) { return r.tour_id === tourId && r.date === date; })
        .map(function (r) { return { id: r.id, body: r.body, author: r.author, mine: !!session && r.added_by === session.user.id,
          status: r.status || 'pending', at: r.created_at }; });
    },
    savePoll: async function (tourId, date, options, closesAt) {
      var q = await sb.from('day_polls').upsert({ tour_id: tourId, date: date, options: options, closes_at: closesAt },
        { onConflict: 'tour_id,date' });
      if (q.error) throw mapError(q.error);
      await refetch();
    },
    deletePoll: async function (tourId, date) {
      var q = await sb.from('day_polls').delete().eq('tour_id', tourId).eq('date', date);
      if (q.error) throw mapError(q.error);
      await refetch();
    },
    vote: async function (tourId, date, choice) {
      var q = await sb.from('day_votes').upsert({ tour_id: tourId, date: date, user_id: session.user.id, choice: choice },
        { onConflict: 'tour_id,date,user_id' });
      if (q.error) throw mapError(q.error);
      await refetch();
    },
    addRequest: async function (tourId, date, body) {
      var q = await sb.from('day_requests').insert({ id: newRowId(), tour_id: tourId, date: date, body: String(body || '').trim().slice(0, 300) });
      // Already there: a repeat of one that got through.
      if (q.error && q.error.code !== '23505') throw mapError(q.error);
      await refetch();
    },
    // The tour manager (or a Manager) answers: 'accepted', 'denied', or back to 'pending'.
    answerRequest: async function (id, status) {
      var q = await sb.from('day_requests').update({ status: status }).eq('id', id).select('id');
      if (q.error) throw mapError(q.error);
      if (!q.data || !q.data.length) throw err('permission');
      await refetch();
    },
    deleteRequest: async function (id) {
      var q = await sb.from('day_requests').delete().eq('id', id).select('id');
      if (q.error) throw mapError(q.error);
      if (!q.data || !q.data.length) throw err('permission');
      await refetch();
    },
    // A tour crew's profile photos, by account, for the Overview's crew list.
    // Answers at once from what this phone has; asks again after five minutes.
    facesFor: function (tourId) {
      var c = faceCache[tourId];
      if ((!c || Date.now() - c.at > 300e3) && !faceAsk[tourId]) {
        faceAsk[tourId] = sb.rpc('tour_faces', { t_id: tourId }).then(function (q) {
          var ok = !q.error && isObj(q.data);
          // A failed ask tries again in about half a minute, not five.
          faceCache[tourId] = { data: ok ? q.data : (c ? c.data : {}), at: ok ? Date.now() : Date.now() - 270e3 };
        }, function () {
          faceCache[tourId] = { data: c ? c.data : {}, at: Date.now() - 270e3 };
        }).then(function () { delete faceAsk[tourId]; emit('tours'); });
      }
      return c ? c.data : {};
    },
    // Check In: you've seen the day's sheet. Once a day; the database knows who you are.
    checkedIn: function (tourId, date) {
      return cache.checkins.some(function (x) { return x.tour_id === tourId && x.day === date; });
    },
    checkIn: async function (tourId, date) {
      var q = await sb.rpc('check_in', { t_id: tourId, d: date });
      if (q.error) throw mapError(q.error);
      if (!cache.checkins.some(function (x) { return x.tour_id === tourId && x.day === date; })) cache.checkins.push({ tour_id: tourId, day: date });
      emit('tours');
    },
    /* Flowers. Everyone on a tour has 10 to give to the others on it. The
       getters answer at once from what this phone has (null while it's
       first being fetched, { error: true } if that failed) and fetch again
       when something has changed; the page redraws when the answer lands. */
    flowersFor: function (tourId, fresh) {
      var c = flowerCache[tourId];
      if (!c || c.stale || fresh || Date.now() - c.at > FLOWERS_FRESH) loadFlowers(tourId);
      return c ? c.data : null;
    },
    myFlowers: function (fresh) {
      var c = myFlowerCache;
      if (!c || c.stale || fresh || Date.now() - c.at > FLOWERS_FRESH) loadMyFlowers();
      return c ? c.data : null;
    },
    // rid names this gift, so sending it again (a retry) never gives twice.
    newGiftId: newUuid,
    // cat: what they're for, one of the ten (see FLOWER_CATS in the app).
    giveFlowers: async function (tourId, userId, n, note, rid, cat) {
      // Cut by whole characters, so an emoji at the end is never split in half.
      var q = await sb.rpc('give_flowers', { t_id: tourId, to_user: userId, how_many: n, why: Array.from(String(note || '').trim()).slice(0, 100).join(''),
        rid: rid || newUuid(), cat: cat || null });
      if (q.error) {
        if (/no flowers left/.test(q.error.message || '')) {
          // This phone's count was behind: fetch the real one before saying so.
          flowersStale();
          await Promise.all([loadFlowers(tourId), loadMyFlowers()]);
          throw err('none-left');
        }
        throw mapError(q.error);
      }
      // The 10 are the year's, across every tour: everything showing a count asks again.
      flowersStale();
      await Promise.all([loadFlowers(tourId), loadMyFlowers()]);
      return q.data;
    },
    // Remove flowers given to you (giving is final: the giver can't take them back).
    takeBackFlowers: async function (tourId, id) {
      var q = await sb.from('flowers').delete().eq('id', id).select('id');
      if (q.error) throw mapError(q.error);
      if (!q.data || !q.data.length) throw err('permission');
      flowersStale();
      await Promise.all([loadFlowers(tourId), loadMyFlowers()]);
    },
    guestsFor: function (tourId, showId) {
      return cache.guests.filter(function (g) {
        return g.tour_id === tourId && g.show_id === showId;
      }).map(function (g) {
        return { id: g.id, firstName: g.first_name, lastName: g.last_name,
          affiliation: g.affiliation, email: g.email, phone: g.phone,
          qty: g.qty, passType: g.pass_type, addedBy: g.added_by, at: g.created_at };
      });
    },
    saveGuest: async function (tourId, showId, guest) {
      var row = {
        id: guest.id, tour_id: tourId, show_id: showId,
        first_name: guest.firstName, last_name: guest.lastName,
        affiliation: guest.affiliation, email: guest.email, phone: guest.phone,
        qty: guest.qty, pass_type: guest.passType
      };
      var q = await sb.from('guests').upsert(row);
      if (q.error) throw mapError(q.error);
      scheduleRefetch();
    },
    removeGuest: async function (guestId) {
      var q = await sb.from('guests').delete().eq('id', guestId).select('id');
      if (q.error) throw mapError(q.error);
      if (!q.data || !q.data.length) throw err('permission');
      scheduleRefetch();
    },
    /* ---- Reimbursements: "I paid for this, for the tour." Anyone on a tour
       can ask to be paid back; the tour's Managers see every ask on it and
       mark each one paid or not. You are handed your own asks and, on a tour
       you manage, everyone's (the database decides which). Oldest first.
       These never throw: with no database behind the app they answer
       an empty list and { ok: false, why: 'unavailable' }. ---- */
    reimbursementsFor: function (tourId) {
      var me = session && session.user ? session.user.id : null;
      return (Array.isArray(cache.reimb) ? cache.reimb : []).filter(function (r) { return r && r.tour_id === tourId; })
        .map(function (r) {
          return { id: r.id, tourId: r.tour_id, mine: !!me && r.user_id === me, name: r.requester_name || '',
            amount: Number(r.amount) || 0, what: r.what || '', date: r.spent_on || '', status: r.status || 'open',
            paidAt: r.paid_at || null, paidBy: r.paid_by_name || '', how: r.paid_how || '', feedId: r.feed_id || '',
            closedBy: r.closed_by_name || '', closedAt: r.closed_at || null, createdAt: r.created_at || null };
        }).sort(function (a, b) { return String(a.createdAt || '').localeCompare(String(b.createdAt || '')); });
    },
    // { id, amount, what, date }. The id is the caller's: one for a form as it
    // is filled in, sent again on a retry, so a save sent twice is one ask (the
    // database answers ok for an id it already holds as this very ask). One is
    // made here only when none is given; an id of the wrong shape (not 6 to 40
    // of A-Z a-z 0-9 _ -) is refused, never swapped for another.
    // why: 'role', 'tour', 'amount', 'what', 'date', 'many', 'id' (that id is
    // another ask's), 'unavailable'.
    reimburseAsk: async function (tourId, ask) {
      var a = isObj(ask) ? ask : {};
      var given = a.id != null && a.id !== '';
      if (given && !/^[A-Za-z0-9_-]{6,40}$/.test(String(a.id))) return { ok: false, why: 'id' };
      var id = given ? String(a.id) : newRowId();
      var out = await reimburseCall('reimburse_ask', { r_id: id, t_id: tourId, amt: Number(a.amount),
        r_what: String(a.what == null ? '' : a.what).slice(0, 140), r_day: a.date || null });
      return out.ok ? { ok: true, id: id } : out;
    },
    // The asker, or a Manager, while it is waiting. why: 'gone', 'paid', 'unavailable'.
    reimburseWithdraw: function (id) {
      return reimburseCall('reimburse_withdraw', { r_id: id });
    },
    // A Manager says it was paid back (how: 'cash', 'card' or 'other'; feedId:
    // the card charge that was the payback, when there is one) or not paid
    // (which clears who, when and how). Marking one that is already paid keeps
    // who paid and when; it only fills in how, or the card charge.
    // why: 'role', 'gone', 'unavailable'.
    reimburseMark: function (id, paid, how, feedId) {
      return reimburseCall('reimburse_mark', { r_id: id, is_paid: !!paid, how: paid ? String(how || '') : '',
        feed: paid && feedId != null ? String(feedId) : '' });
    },
    // A Manager puts an ask that was taken off back to waiting. why: 'role', 'gone', 'unavailable'.
    reimburseRestore: function (id) {
      return reimburseCall('reimburse_restore', { r_id: id });
    },
    /* ---- Ari asks before she fixes a night's merch ---- */
    asksFor: function (tourId) {
      return cache.asks.filter(function (a) { return a.tour_id === tourId; }).map(function (a) {
        return { id: a.id, noteId: a.note_id, showId: a.show_id, place: a.place, was: Number(a.was), fix: Number(a.fix),
          status: a.status, at: a.created_at };
      });
    },
    // The tour manager's answer. Resolves 'fixed', 'left', 'moved' (the number
    // changed since she asked, so she left it) or 'gone'.
    ariAnswer: async function (id, yes) {
      var q = await sb.rpc('ari_answer', { a_id: id, yes: !!yes });
      if (q.error) throw q.error.code === '42501' ? err('permission') : mapError(q.error);
      await refetch();
      return q.data;
    },
    /* ---- notes on a night: anyone on the tour can leave one ---- */
    notesFor: function (tourId, day) {
      return cache.notes.filter(function (n) {
        return n.tour_id === tourId && (!day || n.day === day);
      }).map(function (n) {
        return { id: n.id, day: n.day, body: n.body, author: n.author,
          addedBy: n.added_by, at: n.created_at };
      });
    },
    saveNote: async function (tourId, day, note) {
      var q = await sb.from('notes').upsert({
        id: note.id, tour_id: tourId, day: day,
        body: note.body, author: note.author || ''
      });
      if (q.error) throw mapError(q.error);
      scheduleRefetch();
    },
    removeNote: async function (noteId) {
      var q = await sb.from('notes').delete().eq('id', noteId).select('id');
      if (q.error) throw mapError(q.error);
      if (!q.data || !q.data.length) throw err('permission');
      scheduleRefetch();
    },
    /* ---- notifications ---- */
    // Resolves with how many phones it reached (null if unknown); never throws,
    // so callers that don't care can fire and forget.
    notify: function (tourId, type, data) {
      return callFn('notify', {
        method: 'POST',
        body: JSON.stringify({ tourId: tourId, type: type, data: data || {} })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (out) { return out && typeof out.sent === 'number' ? out.sent : null; })
        .catch(function () { return null; });
    },
    pushSupported: function () {
      return !!(navigator.serviceWorker && 'PushManager' in window && 'Notification' in window);
    },
    pushState: async function () {
      if (!this.pushSupported()) return { on: false, prefs: {} };
      try {
        var reg = await navigator.serviceWorker.ready;
        var sub = await reg.pushManager.getSubscription();
        if (!sub) return { on: false, prefs: {} };
        var q = await sb.from('push_subs').select('prefs').eq('endpoint', sub.endpoint).single();
        return { on: !q.error, prefs: (q.data && q.data.prefs) || {} };
      } catch (e) { return { on: false, prefs: {} }; }
    },
    pushEnable: async function (prefs) {
      var perm = await Notification.requestPermission();
      if (perm !== 'granted') throw err('denied');
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (!sub) {
        var key = Uint8Array.from(atob((cfg.vapidPublic || '').replace(/-/g, '+').replace(/_/g, '/')
          .padEnd(Math.ceil(cfg.vapidPublic.length / 4) * 4, '=')), function (c) { return c.charCodeAt(0); });
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      var j = sub.toJSON();
      var q = await sb.from('push_subs').upsert({
        endpoint: sub.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, prefs: prefs || {}
      });
      if (q.error) throw mapError(q.error);
    },
    pushSetPrefs: async function (prefs) {
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      await sb.from('push_subs').update({ prefs: prefs }).eq('endpoint', sub.endpoint);
    },
    pushDisable: async function () {
      try {
        var reg = await navigator.serviceWorker.ready;
        var sub = await reg.pushManager.getSubscription();
        if (sub) {
          await sb.from('push_subs').delete().eq('endpoint', sub.endpoint);
          await sub.unsubscribe();
        }
      } catch (e) { /* already gone */ }
    },
    /* ---- the card feed (Plaid, read-only) ----
       The feed belongs to one tour manager. Row-level security hands its row
       and its pile to that person only; for everyone else feedWatch reports
       nothing and the app never mentions it. */
    feedWatch: function (fn) {
      feedListeners.push(fn);
      loadFeed(true);
    },
    feedCall: async function (action, body) {
      var r;
      try {
        r = await callFn('plaid', {
          method: 'POST',
          body: JSON.stringify(Object.assign({ action: action }, body || {}))
        });
      } catch (e) {
        // No answer at all, even after trying again: the phone's connection.
        noteError('cards:' + action, e);
        return { error: 'offline' };
      }
      var out = {};
      try { out = await r.json(); } catch (e) { out = {}; }
      if (!r.ok && !out.error) out.error = 'unavailable';
      // Tried again after no answer: the first one may have got through.
      if (r.__retried) out.retried = true;
      if (out.error || out.ok === false) noteError('cards:' + action, { code: out.error || out.status, message: 'http ' + r.status });
      // Wait for the fresh pile, so the app can act on what just came in.
      if (action !== 'status') await loadFeed(false);
      return out;
    },
    // Read the feed and its pile again now (Try again, after a read that failed).
    feedRead: function () { return loadFeed(false); },
    /* ---- Every bank line accounted for (0136). The phone no longer writes
       feed_items at all: it reads, and asks the database to put a line back.
       Each of these answers null when it could not be asked or read, so the
       app can say "couldn't check" and never mistakes that for "nothing". ---- */
    // The whole account in one answer: counts by where each line stands, what
    // waits on which tour, what was left out and why, each bank, the last full check.
    feedAccount: async function () {
      try {
        var q = await sb.rpc('feed_account');
        if (q.error) { noteError('cards:account', q.error); return null; }
        return isObj(q.data) ? q.data : null;
      } catch (e) { return null; }
    },
    // Back to waiting, by a person's tap: lines left out or set aside, and a
    // line marked filed that is on no tour. Answers how many moved.
    feedPutBack: async function (ids) {
      var list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean).slice(0, 500);
      if (!list.length) return 0;
      var n = null;
      try {
        var q = await sb.rpc('feed_put_back', { ids: list });
        if (q.error) noteError('cards:putback', q.error);
        else n = Number(q.data) || 0;
      } catch (e) { n = null; }
      // (Asked again whatever the answer: one that was lost may still have moved the line.)
      await loadFeed(false);
      return n;
    },
    // One page (100) of the lines that are not in the pile, newest first:
    // status 'left_out' (reason: one code, or null for all of them) or 'skipped'.
    /* after: { date, id } of the last line already in hand. The page then
       starts just past that line (the rest of its day by id, then the days
       before it) and "page" is not used. Lines arrive in these lists while
       one is open (a bank read) and leave them (brought in, here or on
       another phone); a page asked for by its number would then hand back
       lines already shown and never reach the rest. A page of fewer than
       100 is the end of the list. */
    feedLeftOut: async function (status, reason, page, after) {
      var st = status === 'skipped' ? 'skipped' : 'left_out', from = Math.max(0, Math.round(Number(page)) || 0) * FEED_LIST;
      var ask = function () {
        var q = sb.from('feed_items').select(FEED_LIST_COLS).eq('status', st);
        return reason ? q.eq('reason', String(reason)) : q;
      };
      try {
        var day = after && /^\d{4}-\d{2}-\d{2}$/.test(String(after.date || '')) ? String(after.date) : '';
        if (day && after.id != null && String(after.id) !== '') {
          var same = await ask().eq('date', day).gt('id', String(after.id)).order('id').limit(FEED_LIST);
          if (same.error) { noteError('cards:leftout', same.error); return null; }
          var rows = same.data || [];
          if (rows.length < FEED_LIST) {
            var older = await ask().lt('date', day).order('date', { ascending: false }).order('id').limit(FEED_LIST - rows.length);
            if (older.error) { noteError('cards:leftout', older.error); return null; }
            rows = rows.concat(older.data || []);
          }
          return rows;
        }
        var q = await ask().order('date', { ascending: false }).order('id').range(from, from + FEED_LIST - 1);
        if (q.error) { noteError('cards:leftout', q.error); return null; }
        return q.data || [];
      } catch (e) { return null; }
    },
    /* The "needs a look" lists. gone: the bank withdrew a line that a person
       had already dealt with. changed: the bank's figure is no longer the one
       stored. filed (only when asked for): every line marked filed, few
       columns, so the app can find the ones no tour of his holds; the
       database checks again before it puts one back. */
    feedLook: async function (wantFiled) {
      try {
        var gone = await sb.from('feed_items').select(FEED_LIST_COLS).not('gone_on', 'is', null)
          .in('status', ['filed', 'skipped', 'mypay']).order('date', { ascending: false }).order('id').limit(200);
        var changed = await sb.from('feed_items').select(FEED_LIST_COLS).not('bank_amount', 'is', null)
          .order('date', { ascending: false }).order('id').limit(200);
        if (gone.error || changed.error) { noteError('cards:look', gone.error || changed.error); return null; }
        var out = { gone: gone.data || [],
          // (To the cent: a figure the bank sent again unchanged is not a change.)
          changed: (changed.data || []).filter(function (r) { return Math.round(Number(r.bank_amount) * 100) !== Math.round(Number(r.amount) * 100); }),
          filed: null };
        if (wantFiled) {
          var filed = await pageRows(function () {
            return sb.from('feed_items').select('id, tour_id, date, merchant, amount, account, decided_at, gone_on', { count: 'exact' })
              .eq('status', 'filed').order('date', { ascending: false }).order('id');
          });
          if (!filed) return null;
          out.filed = filed.rows;
        }
        return out;
      } catch (e) { return null; }
    },
    /* Straight to the sign-in page. This phone forgets the sign-in at once;
       telling the server is a courtesy that gets two seconds, never a wait. */
    signOut: async function () {
      try {
        await Promise.race([
          sb.auth.signOut({ scope: 'local' }),
          new Promise(function (r) { setTimeout(r, 2000); })
        ]);
      } catch (e) { /* going anyway */ }
      try {
        Object.keys(localStorage).forEach(function (k) {
          if (/^sb-.*-auth-token/.test(k)) localStorage.removeItem(k);
        });
      } catch (e) { /* nothing stored */ }
      suggestClear(); // what a sign-up code was made for is not for whoever signs in next
      legalDrop();    // nor is what a sign-up on this phone agreed to
      location.replace(appUrl());
    }
  };

  var dmListeners = [];
  function dmChanged() { dmListeners.forEach(function (fn) { try { fn(); } catch (e) { /* listener's problem */ } }); }
  var feedListeners = [];
  var feedTimer = 0;
  var FEED_PAGE = 1000;  // the most rows the database hands over in one answer
  var FEED_LIST = 100;   // a page of the left-out and set-aside lists
  var FEED_LIST_COLS = 'id, tour_id, date, posted, merchant, amount, account, why, status, reason, decided_at, bank_amount, gone_on';
  /* Every row of one question, a page at a time, until a short page. make()
     builds the question afresh for each page (it must put the rows in a fixed
     order and ask for the count). The count decides when it is known: the end
     is when the rows in hand have reached it, which guards a project set to
     hand over fewer rows than FEED_PAGE (a short page is then not the end),
     and never asks for a page past the last row (the database answers that
     with an error, not an empty page). Answers { rows, total }, or null when
     any page failed: part of a list is never passed off as the whole of it. */
  async function pageRows(make) {
    var rows = [], seen = {}, from = 0, total = null;
    for (var turn = 0; turn < 60; turn++) {
      var q = await make().range(from, from + FEED_PAGE - 1);
      if (q.error) return null;
      var got = q.data || [];
      if (typeof q.count === 'number') total = q.count;
      // (A row that changed places between two pages is kept once.)
      got.forEach(function (r) { if (!seen[r.id]) { seen[r.id] = true; rows.push(r); } });
      from += got.length;
      if (!got.length || (total != null ? from >= total : got.length < FEED_PAGE)) break;
    }
    return { rows: rows, total: total == null ? rows.length : Math.max(total, rows.length) };
  }
  /* Three answers that must never be mixed up: the read failed (failed: true,
     with the last good pile if there was one, so nothing vanishes from the
     screen and nothing offers to connect a bank that is already connected);
     no bank is connected (connectOnly, for accounts on the approved list, or
     null); and what is waiting, which may be nothing. */
  var feedGood;        // the last state that was really read (undefined: nothing has been read yet)
  // (Each listener's state is a copy: the app may write on what it is handed.)
  function feedTell(state) {
    feedListeners.forEach(function (fn) {
      try { fn(state ? Object.assign({}, state, { row: state.row ? Object.assign({}, state.row) : null, items: (state.items || []).slice() }) : null); }
      catch (e) { /* listener's problem */ }
    });
  }
  // (An account last known to have no cards at all stays that way: nothing to mark as unchecked.)
  function feedFailed() {
    if (feedGood === null) { feedTell(null); return; }
    feedTell(feedGood ? Object.assign({}, feedGood, { failed: true }) : { row: null, items: [], failed: true });
  }
  async function loadFeed(opening) {
    try {
      var f = await sb.from('feed').select('switched_on, plan_name, since, last_run, last_status, source').maybeSingle();
      // The read failed. That is not "no bank is connected": the app must not offer to connect one.
      if (f.error) { feedFailed(); return; }
      if (!f.data) {
        // No feed yet: only accounts on the approved list get a Connect button
        // (and when that list cannot be read, nobody is offered one on a guess).
        var ok = await sb.from('ynab_allowed').select('owner_id').maybeSingle();
        feedGood = (ok.error || !ok.data) ? null : { row: null, items: [], connectOnly: true };
        feedTell(feedGood);
        return;
      }
      var items = await pageRows(function () {
        return sb.from('feed_items').select('id, tour_id, date, posted, seq, merchant, amount, category, account, why, created_at', { count: 'exact' })
          .eq('status', 'waiting').order('date').order('id');
      });
      // The feed row is known, the pile is not: the last pile stays, marked as not checked.
      if (!items) {
        feedTell({ row: f.data, items: feedGood && feedGood.items ? feedGood.items : [], failed: true });
        return;
      }
      // total: every waiting row the database counted (more than items only if the read was cut short).
      feedGood = { row: f.data, items: items.rows, total: items.total };
      feedTell(feedGood);
      // Opening the app is the manager's cue that fresh charges matter now.
      var last = f.data.last_run ? Date.parse(f.data.last_run) : 0;
      if (opening && f.data.switched_on && Date.now() - last > 15 * 60e3) {
        window.GR_BACKEND.feedCall('sync').catch(function () { /* next open tries again */ });
      }
    } catch (e) {
      // The feed is a convenience, never a blocker; but a read that broke is said, not shown as an empty pile.
      feedFailed();
    }
  }
  /* One question in flight at a time. A request that set off before the
     latest change (an older generation) isn't reused, and what it brings
     back only stands until the newer answer lands. A failed request keeps
     what was there and tries again a minute later; with nothing there, the
     page says so and offers Try again. */
  function settle(old, q, gen, now) {
    if (q && !q.error && isObj(q.data)) return { data: q.data, at: Date.now(), stale: gen !== now };
    if (old && old.data && !old.data.error) return { data: old.data, at: Date.now(), stale: false };
    return { data: { error: true }, at: Date.now(), stale: false };
  }
  function loadFlowers(tourId) {
    var gen = flowerGen[tourId] || 0, ask = flowerAsk[tourId];
    if (ask && ask.gen === gen) return ask;
    var p = sb.rpc('tour_flowers', { t_id: tourId }).then(function (q) { return q; }, function () { return null; })
      .then(function (q) {
        flowerCache[tourId] = settle(flowerCache[tourId], q, gen, flowerGen[tourId] || 0);
        if (flowerAsk[tourId] === p) delete flowerAsk[tourId];
        emit('tours');
      });
    p.gen = gen;
    flowerAsk[tourId] = p;
    return p;
  }
  function loadMyFlowers() {
    var gen = myFlowerGen, ask = myFlowerAsk;
    if (ask && ask.gen === gen) return ask;
    var p = sb.rpc('my_flowers').then(function (q) { return q; }, function () { return null; })
      .then(function (q) {
        myFlowerCache = settle(myFlowerCache, q, gen, myFlowerGen);
        if (myFlowerAsk === p) myFlowerAsk = null;
        emit('tours');
      });
    p.gen = gen;
    myFlowerAsk = p;
    return p;
  }
  // Every count shown is out of date: each tour's, and your own.
  function flowersStale() {
    Object.keys(flowerCache).forEach(function (k) { flowerGen[k] = (flowerGen[k] || 0) + 1; flowerCache[k].stale = true; });
    myFlowerGen += 1;
    if (myFlowerCache) myFlowerCache.stale = true;
  }
  // Someone gave (or took back) flowers, or the phone woke up: what's shown is asked for again.
  function flowersChanged() {
    clearTimeout(flowerTimer);
    flowerTimer = setTimeout(function () { flowersStale(); emit('tours'); }, 300);
  }
  function feedChanged() {
    if (!feedListeners.length) return;
    clearTimeout(feedTimer);
    feedTimer = setTimeout(function () { loadFeed(false); }, 300);
  }

  /* ---------------- Auth gate ---------------- */

  /* Ordinary accounts: email + password, made right here in the app. No
     sign-in emails — on an iPhone, a home-screen app and Safari are separate
     worlds, so email links sign in the wrong one. Passwords don't care. */
  /* <shared-screens>
     From here to the matching mark further down are the pieces the gate's
     screens are made of: the role list and its picker, the one-question
     screens, the pages for the documents. tools/make_dbstub.py lifts this
     stretch into the app's offline harness as it stands, so what is tried
     there is this code and not a copy of it. Keep it liftable: a piece that
     needs the server or the sign-in is handed it by whoever calls (the two
     that ask the server themselves, sendPasswordLink and signupSettings, are
     never called there), and nothing in here runs on its own. */
  /* What someone does on the run. A job title for the crew list, never a
     level: Manager or Crew is the level, and the tour's creator hands that
     out. These are Devin's crew roles in his order, then the two words for a
     hired player on stage: the list GR.CREW_ROLES in src/core.js, which is
     the one read whenever it has loaded. (This file runs before that one,
     and the gate's test page runs it alone, so a copy lives here. A title
     someone already has from the older list, Artist or Guitar Tech, is left
     as it is and still shows.) */
  var TOUR_ROLES = ['Tour manager', 'FOH engineer', 'Merch manager', 'Driver', 'Backline tech',
    'Monitor engineer', 'Drum tech', 'Lighting director', 'Photographer / videographer', 'Playback tech',
    'Production manager', 'Stage manager',
    'Assistant TM / production coordinator', 'Truck driver', 'Head of security / personal security',
    'VIP coordinator', 'Wardrobe / stylist', 'Hair & makeup artist', 'Head rigger', 'Tour accountant',
    'Band', 'Touring Musician'];
  function tourRoles() {
    var G = window.GR;
    return (G && Array.isArray(G.CREW_ROLES) && G.CREW_ROLES.length ? G.CREW_ROLES : TOUR_ROLES).slice();
  }
  // "Artist/Owner" is just "Artist" now; older cards read the new way.
  function roleName(r) {
    var t = String(r || '').trim();
    return t === 'Artist/Owner' ? 'Artist' : t;
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /* The role picker is our own list, not the phone's dropdown — iOS's
     native picker misbehaves inside the scrolling sign-up card. A hidden
     input holds the value; the button opens a full-screen list. */
  function rolePickerHtml(id, current) {
    return '<input type="hidden" id="' + id + '" value="' + esc(current || '') + '">' +
      '<button type="button" class="input role-pick' + (current ? '' : ' empty') + '" id="' + id +
      '-btn" aria-haspopup="listbox">' + esc(current || 'Your role on the tour') + '</button>';
  }
  /* o (all optional): title (the words over the list), roles (a list in
     place of the crew roles), groups ([{ key, head, roles }]: several lists
     under a heading each, a Member's roles over the crew's), other: false
     (no "Other"). "Other" opens a line to type the role in. A title someone
     already has that is on no list (one from the older list, or one typed)
     opens in that line as it is, so nothing anyone has is lost or renamed.
     onPick(role, { group, typed }): which list it came from, or that it was
     typed. Built piece by piece; what was typed only goes in as text. */
  function openRolePicker(current, onPick, o) {
    o = o || {};
    sgStyle();
    var cur = String(current || '').trim();
    var title = String(o.title || 'Your role on the tour');
    var groups = Array.isArray(o.groups) && o.groups.length ? o.groups
      : [{ key: '', head: '', roles: Array.isArray(o.roles) && o.roles.length ? o.roles : tourRoles() }];
    var ov = sgEl('div', 'role-picker');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-label', title);
    var card = sgEl('div', 'rp-card');
    card.appendChild(sgEl('div', 'rp-head', title));
    var list = sgEl('div', 'rp-list');
    list.setAttribute('role', 'listbox');
    var onEl = null;
    function done(role, how) { ov.remove(); onPick(role, how); }
    groups.forEach(function (g) {
      if (!g || !Array.isArray(g.roles)) return;
      if (g.head) list.appendChild(sgEl('div', 'rp-head rp-sub', String(g.head)));
      g.roles.forEach(function (r) {
        var name = String(r);
        // (Capitals aside: "Tour Manager" from the older list is "Tour manager" here.)
        var on = !onEl && !!cur && name.toLowerCase() === cur.toLowerCase();
        var b = sgEl('button', 'rp-opt' + (on ? ' on' : ''), name);
        b.type = 'button';
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(on));
        b.addEventListener('click', function () { done(name, { group: String(g.key || ''), typed: false }); });
        if (on) onEl = b;
        list.appendChild(b);
      });
    });
    if (o.other !== false) {
      var mine = !!cur && !onEl;   // a title that is on no list: theirs, typed or from before
      var otherB = sgEl('button', 'rp-opt' + (mine ? ' on' : ''), 'Other');
      otherB.type = 'button';
      otherB.setAttribute('role', 'option');
      otherB.setAttribute('aria-selected', String(mine));
      var box = sgEl('form', 'rp-other');
      box.setAttribute('novalidate', '');
      box.hidden = !mine;
      var inp = sgEl('input', 'input');
      inp.type = 'text';
      inp.setAttribute('maxlength', '40');
      inp.setAttribute('placeholder', 'Type the role');
      inp.setAttribute('aria-label', 'The role, typed');
      inp.setAttribute('autocapitalize', 'words');
      inp.setAttribute('autocomplete', 'off');
      inp.value = mine ? cur : '';
      var use = sgEl('button', 'btn primary block', 'Use this role');
      use.type = 'submit';
      box.appendChild(inp); box.appendChild(use);
      otherB.addEventListener('click', function () {
        box.hidden = false;
        try { inp.focus(); } catch (e) { /* cosmetic */ }
        if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
      });
      box.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = String(inp.value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!v) { try { inp.focus(); } catch (e2) { /* cosmetic */ } return; }
        done(v, { group: '', typed: true });
      });
      list.appendChild(otherB); list.appendChild(box);
      if (mine) onEl = otherB;
    }
    card.appendChild(list);
    ov.appendChild(card);
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });   // tap outside the card to back out
    document.body.appendChild(ov);
    if (onEl && onEl.scrollIntoView) onEl.scrollIntoView({ block: 'center' });
  }
  function wireRolePicker(root, id) {
    var hidden = root.querySelector('#' + id), btn = root.querySelector('#' + id + '-btn');
    if (!hidden || !btn) return;
    btn.addEventListener('click', function () {
      openRolePicker(hidden.value, function (role) {
        hidden.value = role;
        btn.textContent = role;
        btn.classList.remove('empty');
      });
    });
  }

  /* Where email links should land: the app's own folder, whatever page. */
  function appUrl() { return location.origin + location.pathname.replace(/[^/]*$/, ''); }

  /* "Forgot password?" and "set my password": Supabase emails a link. It is
     sent from a throwaway client in the older link style on purpose: an
     iPhone keeps the home-screen app and Safari apart, and the newer style
     only works in the browser that asked for it. This one works anywhere. */
  async function sendPasswordLink(email) {
    var c = sbMod.createClient(cfg.url, cfg.anonKey, { auth: {
      flowType: 'implicit', persistSession: false, autoRefreshToken: false,
      detectSessionInUrl: false, storageKey: 'gr-password-link' } });
    var q = await c.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
    if (q.error) throw q.error;
  }

  /* ---------------- One question per screen ----------------
     The sign-up, and an invited person's first minute, ask one thing at a
     time: an arrow back, a title, a grey sentence, one field, one button.
     (Devin's reference is Instagram's sign-up; the colours are Greenroom's
     own.) The look lives here rather than in the app's stylesheet because
     this file draws these screens, and it runs before the app does. */
  var SG_CSS = [
    '#gr-gate.sg-host, #gr-pass-gate.sg-host { display: block; padding: calc(8px + env(safe-area-inset-top, 0px)) 20px calc(40px + env(safe-area-inset-bottom, 0px)); }',
    '.sg { width: 100%; max-width: 440px; margin: 0 auto; text-align: left; color: var(--ink, #F1F4E3); }',
    '.sg-top { display: flex; align-items: center; height: 44px; margin: 0 0 12px -10px; }',
    '.sg-back { -webkit-appearance: none; appearance: none; border: 0; background: none; color: var(--ink, #F1F4E3); width: 44px; height: 44px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 12px; cursor: pointer; }',
    '.sg-back svg { display: block; width: 26px; height: 26px; }',
    '.sg-title { margin: 0 0 8px; font-size: 26px; line-height: 1.15; font-weight: 800; letter-spacing: -.02em; color: var(--ink, #F1F4E3); }',
    '.sg-sub { margin: 0 0 22px; font-size: 15px; line-height: 1.45; font-weight: 400; color: var(--ink-2, #8F947B); overflow-wrap: break-word; }',
    /* A second grey line (the address the password is for) sits close under the first. */
    '.sg-sub + .sg-sub { margin-top: -14px; }',
    '.sg-form { display: block; margin: 0; }',
    '.sg-field { position: relative; display: block; margin: 0 0 10px; padding: 10px 50px 10px 16px; min-height: 64px; border: 1px solid var(--ink-3, #626750); border-radius: 16px; background: var(--surface, #0C0F02); text-align: left; cursor: text; }',
    '.sg-field:focus-within { border-color: var(--brand, #CCF80A); box-shadow: 0 0 0 3px var(--ring, rgba(204, 248, 10, .3)); }',
    '.sg-label { display: block; font-size: 12.5px; line-height: 1.3; font-weight: 500; color: var(--ink-2, #8F947B); }',
    '.sg-input { display: block; width: 100%; height: 26px; margin: 1px 0 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; color: var(--ink, #F1F4E3); font: inherit; font-size: 17px; font-weight: 600; line-height: 26px; -webkit-appearance: none; appearance: none; }',
    '.sg-input:focus, .sg-input:focus-visible { outline: none; border-radius: 0; box-shadow: none; }',
    /* A saved name or email dropped in by the phone must not paint the box white. */
    '.sg-input:-webkit-autofill { -webkit-text-fill-color: var(--ink, #F1F4E3); caret-color: var(--ink, #F1F4E3); transition: background-color 99999s ease-out 0s; }',
    '.sg-ghost { position: absolute; left: 0; top: 0; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; pointer-events: none; }',
    '.sg-tick { position: absolute; right: 14px; top: 50%; width: 24px; height: 24px; margin-top: -12px; color: var(--pos, #CCF80A); display: none; pointer-events: none; }',
    '.sg-tick svg { display: block; width: 24px; height: 24px; }',
    '.sg-field.ok .sg-tick { display: block; }',
    '.sg-err { min-height: 20px; margin: 0 2px; font-size: 14px; line-height: 1.4; color: var(--neg, #FF5F57); text-align: left; }',
    '.sg-err.quiet { color: var(--ink-2, #8F947B); }',
    '.sg-err .linkbtn { display: inline; min-height: 0; margin: 0; padding: 0; font-size: inherit; }',
    '.sg .btn.primary.sg-next { display: flex; width: 100%; min-height: 52px; margin: 14px 0 0; border-radius: 999px; }',
    /* "Check your email" has two ways out that are always there, under the button. */
    '.sg-more { display: grid; justify-items: start; gap: 2px; margin: 18px 2px 0; }',
    '.sg-more .linkbtn { min-height: 40px; margin: 0; font-size: 15px; text-align: left; font-variant-numeric: tabular-nums; }',
    '.sg-more .linkbtn:disabled { color: var(--ink-3, #626750); text-decoration: none; cursor: default; }',
    /* A birthday (and a role) is picked, not typed: the box holds buttons that read like its value. */
    '.sg-field.sg-picks { cursor: pointer; }',
    '.sg-date { display: flex; flex-wrap: wrap; margin: 1px 0 0; }',
    '.sg-pickb { -webkit-appearance: none; appearance: none; border: 0; background: none; height: 40px; margin: -7px 0; padding: 0 12px 0 0; color: var(--ink, #F1F4E3); font: inherit; font-size: 17px; font-weight: 600; line-height: 40px; text-align: left; cursor: pointer; }',
    '.sg-pickb.empty { color: var(--ink-3, #626750); font-weight: 500; }',
    '.sg-pickb:focus, .sg-pickb:focus-visible { outline: none; }',
    '.sg-pick { position: fixed; inset: 0; z-index: 200; background: rgba(0, 0, 0, .62); display: flex; align-items: flex-end; justify-content: center; }',
    '.sg-pick-card { width: 100%; max-width: 520px; max-height: 72vh; display: flex; flex-direction: column; background: var(--surface-2, #161A07); border: 1px solid var(--ink-3, #626750); border-bottom: 0; border-radius: 20px 20px 0 0; padding-bottom: env(safe-area-inset-bottom, 0px); }',
    '.sg-pick-head { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px 2px 20px; font-size: 13px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2, #8F947B); text-align: left; }',
    '.sg-pick-x { -webkit-appearance: none; appearance: none; flex: none; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 12px; background: none; color: var(--ink-2, #8F947B); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }',
    '.sg-pick-x svg { display: block; width: 22px; height: 22px; }',
    '.sg-pick-list { overflow-y: auto; -webkit-overflow-scrolling: touch; display: grid; gap: 2px; padding: 0 10px 12px; }',
    '.sg-pick-opt { -webkit-appearance: none; appearance: none; display: block; width: 100%; min-height: 48px; padding: 0 2px; border: 0; border-radius: 12px; background: none; color: var(--ink, #F1F4E3); font: inherit; font-size: 16px; font-weight: 600; text-align: center; cursor: pointer; }',
    '.sg-pick-opt.on { color: var(--on-brand, #121500); background: var(--brand, #CCF80A); }',
    /* The documents, one a page, as they were written: the text scrolls with the page and the button waits at its foot. */
    '.sg-doc { margin: 0 0 20px; font-size: 15.5px; line-height: 1.55; font-weight: 400; color: var(--ink, #F1F4E3); text-align: left; overflow-wrap: break-word; }',
    '.sg-doc h2, .sg-doc h3, .sg-doc h4 { margin: 24px 0 8px; line-height: 1.25; font-weight: 800; letter-spacing: -.01em; color: var(--ink, #F1F4E3); }',
    '.sg-doc h2 { font-size: 20px; }',
    '.sg-doc h3 { font-size: 17px; }',
    '.sg-doc h4 { font-size: 15.5px; }',
    '.sg-doc p { margin: 0 0 12px; }',
    '.sg-doc ul { margin: 0 0 12px; padding: 0 0 0 22px; list-style: disc; }',
    '.sg-doc li { margin: 0 0 6px; }',
    '.sg-doc li.in { margin-left: 18px; list-style: circle; }',
    '.sg-doc hr { height: 0; margin: 20px 0; border: 0; border-top: 1px solid var(--ink-3, #626750); }',
    '.sg-doc strong { font-weight: 800; }',
    '.sg-doc > :first-child { margin-top: 0; }',
    /* Which documents changed, over the first page's title. */
    '.sg-flag { margin: 0 0 6px; font-size: 13px; line-height: 1.3; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--pos, #CCF80A); }',
    /* Said over the first page's title when the pages are back because an agreement could not be saved. */
    '.sg-again { margin: 0 0 10px; font-size: 14px; line-height: 1.4; font-weight: 600; color: var(--neg, #FF5F57); }',
    /* "Sign out" under the button, for someone signed in: quiet, and never a way past the pages. */
    '.sg-more .linkbtn.sg-out { color: var(--ink-2, #8F947B); font-weight: 600; }',
    /* The one box to tick, under the last document. */
    '.sg-agree { display: flex; align-items: flex-start; gap: 12px; margin: 0 0 10px; padding: 14px 16px; border: 1px solid var(--ink-3, #626750); border-radius: 16px; background: var(--surface, #0C0F02); font-size: 15px; line-height: 1.45; font-weight: 600; color: var(--ink, #F1F4E3); text-align: left; cursor: pointer; }',
    '.sg-agree input { flex: none; width: 24px; height: 24px; margin: 0; accent-color: var(--brand, #CCF80A); }',
    /* The role picker: a heading between two lists, and the line to type a role under "Other". */
    '.rp-head.rp-sub { padding: 14px 20px 8px; border-top: 1px solid var(--line-2, #2A3305); }',
    '.rp-other { display: grid; gap: 10px; padding: 4px 20px 16px; }',
    '.rp-other[hidden] { display: none; }'
  ].join('\n');
  function sgStyle() {
    if (document.getElementById('gr-sg-style')) return;
    var st = document.createElement('style');
    st.id = 'gr-sg-style';
    st.textContent = SG_CSS;
    document.head.appendChild(st);
  }
  // Our own drawings (nothing typed ever goes near them): the app's back arrow and X, and a ringed tick.
  var SG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var SG_ICON = {
    back: SG_SVG + '<path d="M15 5l-7 7 7 7"/></svg>',
    close: SG_SVG + '<path d="M6 6l12 12M18 6L6 18"/></svg>',
    tick: SG_SVG + '<circle cx="12" cy="12" r="9.5"/><path d="M7.8 12.4l2.9 2.9 5.5-6.1"/></svg>'
  };
  var SG_OFFLINE = 'Couldn’t reach the server. Check your connection and try again.';
  var SG_BADCODE = 'That code didn’t work. Check it and try again.';
  var SG_SLOW = 'Too many tries. Wait a few minutes and try again.';
  var SG_SOON = 'Greenroom isn’t taking new sign-ups just yet. Try again soon.';
  // The code was fine; the project's own switches are what said no.
  var SG_OFF = 'Greenroom isn’t taking new sign-ups yet. Ask the person who gave you the code.';
  var SG_MAIL = 'We couldn’t send the email just now. Wait a few minutes and try again.';
  // The server answered, with something this file has no better words for.
  var SG_AGAIN = 'That didn’t work. Try again in a minute.';
  // How to tell the two kinds of code apart, for someone holding the wrong one.
  var SG_LETTERS = 'A Greenroom code has letters in it, like GR-7KQ2-M4XD.';
  var SG_NOCODE = 'That code wasn’t recognised. Check it and try again. ' + SG_LETTERS;
  var SG_SHAPE = '3 to 24 letters, numbers, dots or underscores.';
  var SG_HANDLE = /^[a-z0-9._]{3,24}$/;   // the database's own rule for a username
  var SG_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var SG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
    'October', 'November', 'December'];
  /* No request may hang a screen. Whatever the gate asks the server gets
     this long to answer (15 seconds unless told otherwise); after that it
     counts as no answer, so the screen says so and its button comes back.
     (sturdyFetch has no limit of its own: on a weak signal a request can sit
     for minutes, and Back was the only way out.) The request itself is not
     called off, so whoever waits on this has to cope with it landing late. */
  function sgLimit(work, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(err('offline')); }, ms || 15000);
      Promise.resolve(work).then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  // No answer at all (no signal, or the limit above), as against a "no" from the server.
  function sgNoAnswer(e) {
    if (!e) return false;
    if (e.code === 'offline' || e.name === 'AuthRetryableFetchError' || e.status === 0) return true;
    return /failed to fetch|load failed|network|timed? ?out/i.test(String(e.message || ''));
  }
  // What to say when a question to the database came back with nothing usable.
  function sgNoData(q) {
    if (fnMissing(q && q.error)) return SG_SOON;
    return !q || q.status === 0 || sgNoAnswer(q.error) ? SG_OFFLINE : SG_AGAIN;
  }
  /* The project's two public sign-up switches (Supabase's /auth/v1/settings,
     readable with the publishable key the client already uses): are new
     accounts being made at all, and must a new address be confirmed by an
     emailed code. The database refuses a code sign-up unless both are on, so
     the code screen asks here first and says so there, not five questions
     later. null: it could not be read (5 seconds at most), and whoever asked
     carries on. */
  async function signupSettings() {
    try {
      var s = await sgLimit(fetch(cfg.url + '/auth/v1/settings', { headers: { apikey: cfg.anonKey }, cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; }), 5000);
      if (!isObj(s)) return null;
      return { open: s.disable_signup !== true && !(isObj(s.external) && s.external.email === false),
        confirm: s.mailer_autoconfirm !== true };
    } catch (e) { return null; }
  }
  // What the server said about a password it would not take.
  function sgPassSay(msg) {
    var n = /at least (\d+)/i.exec(msg);
    if (/weak|easy to guess|pwned|compromised/i.test(msg)) return 'That password is too easy to guess. Pick a different one.';
    return n ? 'Pick a longer password (' + n[1] + ' characters or more).' : 'Pick a longer password.';
  }
  function sgEl(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function sgTick() {
    var t = sgEl('span', 'sg-tick');
    t.setAttribute('aria-hidden', 'true');
    t.innerHTML = SG_ICON.tick;
    return t;
  }

  /* One screen, drawn into host (the gate, or the invited person's overlay).
     o: first (an X, not an arrow), onBack (none: nothing is drawn there),
     title, sub, fields [{ label, type, value, cls, attrs }] or body (a node
     of its own in their place, with focus naming what to focus in it), next
     (the button's word), onInput(ui, input), onNext(ui). onNext may hand
     back a promise: the button waits on it, comes back when it settles (a
     failure included, so no screen is ever left with a dead button), and
     stays off only when it resolves 'wait' (signed in: the page is leaving).
     Whatever was typed only ever goes in through .value and textContent. */
  function sgScreen(host, o) {
    sgStyle();
    host.classList.add('sg-host');
    host.textContent = '';
    host.scrollTop = 0;
    var box = sgEl('div', 'sg');
    var top = sgEl('div', 'sg-top');
    if (o.onBack) {
      var back = sgEl('button', 'sg-back');
      back.type = 'button';
      back.setAttribute('aria-label', o.first ? 'Close' : 'Back');
      back.innerHTML = o.first ? SG_ICON.close : SG_ICON.back;
      back.addEventListener('click', function () { o.onBack(); });
      top.appendChild(back);
    }
    box.appendChild(top);
    box.appendChild(sgEl('h1', 'sg-title', o.title));
    box.appendChild(sgEl('p', 'sg-sub', o.sub));
    var form = sgEl('form', 'sg-form');
    form.setAttribute('novalidate', '');
    var ui = { host: host, form: form, inputs: [], fields: [], labels: [] };
    (o.fields || []).forEach(function (f) {
      var field = sgEl('label', 'sg-field');
      var lab = sgEl('span', 'sg-label', f.label);
      var inp = sgEl('input', 'sg-input' + (f.cls ? ' ' + f.cls : ''));
      inp.type = f.type || 'text';
      inp.setAttribute('enterkeyhint', 'next');
      Object.keys(f.attrs || {}).forEach(function (k) { inp.setAttribute(k, f.attrs[k]); });
      inp.value = f.value || '';
      inp.addEventListener('input', function () { if (o.onInput) o.onInput(ui, inp); });
      field.appendChild(lab); field.appendChild(inp); field.appendChild(sgTick());
      form.appendChild(field);
      ui.inputs.push(inp); ui.fields.push(field); ui.labels.push(lab);
    });
    if (o.body) form.appendChild(o.body);
    var errEl = sgEl('div', 'sg-err');
    errEl.setAttribute('role', 'alert');
    form.appendChild(errEl);
    var btn = sgEl('button', 'btn primary sg-next', o.next || 'Next');
    btn.type = 'submit';
    form.appendChild(btn);
    box.appendChild(form);
    host.appendChild(box);
    var busy = false, stopped = false;
    function sync() { btn.disabled = busy || stopped; }
    // The one quiet line under the field. quiet: not an error ("Checking…").
    ui.say = function (text, quiet) {
      errEl.textContent = text || '';
      errEl.classList.toggle('quiet', !!quiet);
    };
    // A way out, right after the sentence that needs one ("Back to sign in").
    ui.act = function (label, fn) {
      var b = sgEl('button', 'linkbtn inline', label);
      b.type = 'button';
      b.addEventListener('click', fn);
      errEl.appendChild(document.createTextNode(' '));
      errEl.appendChild(b);
    };
    ui.ok = function (i, yes) { if (ui.fields[i]) ui.fields[i].classList.toggle('ok', !!yes); };
    // No going on from here until the answer changes (under 18).
    ui.stop = function (yes) { stopped = !!yes; sync(); };
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy || stopped) return;
      ui.say('');
      var p;
      try { p = o.onNext(ui); } catch (x) { p = Promise.reject(x); }
      if (!p || typeof p.then !== 'function') return;
      busy = true; sync();
      p.then(function (how) { busy = how === 'wait'; sync(); },
        function () { busy = false; sync(); ui.say(SG_OFFLINE); });
    });
    var aim = ui.inputs[0] || o.focus;
    if (aim) {
      try { aim.focus(); } catch (e) { /* cosmetic */ }
      // Carry on typing where the answer ends (an email box refuses this in some browsers).
      try { if (aim.value) aim.setSelectionRange(aim.value.length, aim.value.length); } catch (e) { /* cosmetic */ }
    }
    return ui;
  }

  /* A list of our own to pick from, like the role picker: the phone's
     dropdown misbehaves inside the scrolling gate. cols: how many across
     (months 3, days 7, years 4). near: where to open the list when nothing
     is picked yet. opener: the button that opened it. Tapping outside the
     card, the X in its corner and Escape all back out.
     Only one list is ever open, and while it is the focus is inside it (on
     the current answer): with the focus left on the button behind, Enter
     opened a second list over the first, and a screen reader had no way to
     leave without choosing. Closing hands the focus back to the opener. */
  var sgPickShut = null;   // closes the list that is open, when one is
  function sgPick(title, opts, current, cols, near, onPick, opener) {
    sgStyle();
    if (sgPickShut) sgPickShut(false);
    var ov = sgEl('div', 'sg-pick');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', title);
    var card = sgEl('div', 'sg-pick-card');
    var head = sgEl('div', 'sg-pick-head');
    head.appendChild(sgEl('span', '', title));
    var x = sgEl('button', 'sg-pick-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.innerHTML = SG_ICON.close;
    head.appendChild(x);
    card.appendChild(head);
    var list = sgEl('div', 'sg-pick-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', title);
    list.style.gridTemplateColumns = 'repeat(' + (cols || 1) + ', 1fr)';
    function onKey(e) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      e.preventDefault(); e.stopPropagation();
      shut(true);
    }
    // back: the opener gets the focus again (not when another list is taking this one's place).
    function shut(back) {
      if (sgPickShut !== shut) return;
      sgPickShut = null;
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      if (back && opener) { try { opener.focus(); } catch (e) { /* cosmetic */ } }
    }
    var onEl = null, nearEl = null;
    opts.forEach(function (opt) {
      var b = sgEl('button', 'sg-pick-opt' + (opt.value === current ? ' on' : ''), opt.label);
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(opt.value === current));
      b.addEventListener('click', function () { shut(true); onPick(opt.value); });
      if (opt.value === current) onEl = b;
      if (opt.value === near) nearEl = b;
      list.appendChild(b);
    });
    card.appendChild(list);
    ov.appendChild(card);
    x.addEventListener('click', function () { shut(true); });
    ov.addEventListener('click', function (e) { if (e.target === ov) shut(true); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
    sgPickShut = shut;
    var show = onEl || nearEl;
    if (show && show.scrollIntoView) show.scrollIntoView({ block: 'center' });
    var aim = show || list.firstChild;
    if (aim) { try { aim.focus({ preventScroll: true }); } catch (e) { /* cosmetic */ } }
  }

  /* The questions the sign-up and an invite share. Each takes where to draw
     (host), the answers so far (a: kept while they go back and forth) and
     nav: { first, back, next } plus what that screen needs. */
  function sgName(host, a, nav) {
    function read() {
      a.first = String(ui.inputs[0].value || '').trim().slice(0, 30);
      a.last = String(ui.inputs[1].value || '').trim().slice(0, 30);
      ui.ok(0, !!a.first); ui.ok(1, !!a.last);
    }
    var words = { maxlength: '30', autocapitalize: 'words', autocorrect: 'off', spellcheck: 'false' };
    var ui = sgScreen(host, {
      first: nav.first, onBack: nav.back,
      title: 'What’s your name?',
      sub: 'Your first and last name, the way people on the road know you.',
      fields: [
        { label: 'First name', value: a.first, attrs: Object.assign({ autocomplete: 'given-name' }, words) },
        { label: 'Last name', value: a.last, attrs: Object.assign({ autocomplete: 'family-name' }, words) }
      ],
      onInput: function () { read(); },
      onNext: function () {
        read();
        if (!a.first) { ui.say('Type your first name.'); ui.inputs[0].focus(); return; }
        if (!a.last) { ui.say('Type your last name.'); ui.inputs[1].focus(); return; }
        nav.next();
      }
    });
    read();
  }

  // A username to start from: first.last, cut down to what the rule allows.
  function sgSuggest(first, last) {
    function part(s) {
      var t = String(s || '').toLowerCase();
      // An accented letter splits into the plain letter and its mark; the mark drops out below.
      try { t = t.normalize('NFD'); } catch (e) { /* older phones: the whole letter drops out instead */ }
      return t.replace(/[^a-z0-9]+/g, '');
    }
    var f = part(first), l = part(last);
    var h = (f && l ? f + '.' + l : f || l).slice(0, 24).replace(/\.+$/, '');
    return SG_HANDLE.test(h) ? h : '';
  }
  /* nav.check(h) asks the database whether the name is free and resolves
     { free: true | false } or { why } (it would not say); it rejects when
     it could not be asked at all. nav.skip (an invite): when the question
     itself keeps failing, they may go on without a username rather than be
     stuck behind it; the first run asks again. */
  function sgHandle(host, a, nav) {
    if (!a.handleMine) a.handle = sgSuggest(a.first, a.last);
    var timer = 0, seq = 0, known = '';
    function clean(v) { return String(v || '').toLowerCase().replace(/\s+/g, '').replace(/^@+/, '').slice(0, 24); }
    // Resolves true only when the database has just said this name is free.
    function look(v, pressed) {
      var mine = ++seq;
      if (!SG_HANDLE.test(v)) { ui.ok(0, false); ui.say(SG_SHAPE); return Promise.resolve(false); }
      return nav.check(v).then(function (r) {
        if (mine !== seq) return false;
        if (r && r.free === true) { known = v; ui.ok(0, true); ui.say(''); return true; }
        ui.ok(0, false);
        if (r && r.free === false) ui.say('That one is taken.');
        else if (r && r.why === 'slow') ui.say(SG_SLOW);
        else if (r && r.why === 'bad') ui.say(SG_BADCODE);
        else if (r && r.why === 'shape') ui.say(SG_SHAPE);
        else ui.say('Couldn’t check that name. Try again.');
        return false;
      }, function () {
        if (mine !== seq) return false;
        ui.ok(0, false);
        ui.say('Couldn’t check that name. Check your connection and try again.');
        if (pressed && nav.skip) ui.act('Skip for now', function () { a.handle = ''; a.handleMine = false; nav.next(); });
        return false;
      });
    }
    var ui = sgScreen(host, {
      first: nav.first,
      onBack: nav.back ? function () { clearTimeout(timer); seq += 1; nav.back(); } : null,
      title: 'Create a username',
      sub: 'This is your @name on Greenroom. Letters, numbers, dots and underscores. You can change it later.',
      fields: [{ label: 'Username', value: a.handle, attrs: { maxlength: '24', autocomplete: 'off',
        autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' } }],
      onInput: function (u, inp) {
        var v = clean(inp.value);
        if (v !== inp.value) inp.value = v;
        a.handle = v; a.handleMine = true;
        ui.ok(0, false); ui.say('');
        clearTimeout(timer); seq += 1;
        // Checked a moment after the last key, not on every one.
        if (v) timer = setTimeout(function () { look(v, false); }, 350);
      },
      onNext: function () {
        var v = clean(ui.inputs[0].value);
        clearTimeout(timer);
        if (!v) { ui.say('Pick a username.'); ui.inputs[0].focus(); return; }
        if (known === v) { a.handle = v; nav.next(); return; }
        return look(v, true).then(function (free) { if (free) { a.handle = v; nav.next(); } });
      }
    });
    if (a.handle) look(a.handle, false);
  }

  // How many days that month has (29 for a February with no year yet, so a leap day can be picked).
  function sgDays(y, m) { return m ? new Date(y || 2000, m, 0).getDate() : 31; }
  function sgBirth(host, a, nav) {
    var row = sgEl('div', 'sg-field sg-picks');
    var lab = sgEl('span', 'sg-label', 'Birthday');
    var line = sgEl('div', 'sg-date');
    function part(word, open) {
      var b = sgEl('button', 'sg-pickb empty', word);
      b.type = 'button';
      b.setAttribute('aria-haspopup', 'listbox');
      b.addEventListener('click', open);
      line.appendChild(b);
      return b;
    }
    var bM = part('Month', openM), bD = part('Day', openD), bY = part('Year', openY);
    row.appendChild(lab); row.appendChild(line); row.appendChild(sgTick());
    // Anywhere else on the box: whichever part is still missing.
    row.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.sg-pickb')) return;
      if (!a.month) openM(); else if (!a.day) openD(); else if (!a.year) openY(); else openM();
    });
    function set(b, text, word) { b.textContent = text || word; b.classList.toggle('empty', !text); }
    function draw() {
      var whole = !!(a.month && a.day && a.year);
      set(bM, a.month ? SG_MONTHS[a.month - 1] : '', 'Month');
      set(bD, a.day ? String(a.day) + (whole ? ',' : '') : '', 'Day');
      set(bY, a.year ? String(a.year) : '', 'Year');
      var age = whole ? yearsOld(a.year, a.month, a.day) : 0;
      // Greenroom's terms say 18 (the database refuses anyone younger: save_birth_date).
      var young = whole && age < 18;
      lab.textContent = whole && age >= 0 ? 'Birthday (' + age + (age === 1 ? ' year old)' : ' years old)') : 'Birthday';
      a.birth = whole && !young ? a.year + '-' + ('0' + a.month).slice(-2) + '-' + ('0' + a.day).slice(-2) : '';
      row.classList.toggle('ok', !!a.birth);
      ui.stop(young);
      ui.say(young ? 'Greenroom is for people 18 and older.' : '');
    }
    // A day the month does not have (the 31st, then February) shows as its last day. The day they
    // actually picked is kept (a.dayPicked), so going on to March shows the 31st again.
    function fit() {
      var want = a.dayPicked || a.day;
      if (want) a.day = Math.min(want, sgDays(a.year, a.month));
    }
    // Picking one part opens the next one still missing, so a birthday is three taps in a row.
    function openM() {
      sgPick('Month', SG_MONTHS.map(function (n, i) { return { value: i + 1, label: n }; }), a.month, 3, 0, function (v) {
        a.month = v; fit(); draw();
        if (!a.day) openD(); else if (!a.year) openY();
      }, bM);
    }
    function openD() {
      var opts = [];
      for (var d = 1; d <= sgDays(a.year, a.month); d++) opts.push({ value: d, label: String(d) });
      sgPick('Day', opts, a.day, 7, 0, function (v) {
        a.day = v; a.dayPicked = v; draw();
        if (!a.month) openM(); else if (!a.year) openY();
      }, bD);
    }
    function openY() {
      var now = new Date().getFullYear(), opts = [];
      for (var y = now; y >= now - 110; y--) opts.push({ value: y, label: String(y) });
      sgPick('Year', opts, a.year, 4, now - 25, function (v) {
        a.year = v; fit(); draw();
        if (!a.month) openM(); else if (!a.day) openD();
      }, bY);
    }
    var ui = sgScreen(host, {
      first: nav.first, onBack: nav.back,
      title: 'What’s your birthday?',
      sub: 'Use your own birthday. Only you can see it.',
      body: row, focus: bM,
      onNext: function () {
        if (!a.birth) { ui.say('Pick your birthday: the month, the day and the year.'); return; }
        nav.next();
      }
    });
    draw();
  }

  /* nav.label: the button's word. nav.email: whose password this is, said
     in a grey line ("You'll sign in with ...") and given to the phone's
     password keeper (it files a new password under the email in the same
     form; that box is there for it alone, out of sight).
     nav.next(ui) does the saving and hands back its promise. */
  function sgPass(host, a, nav) {
    var ui = sgScreen(host, {
      first: nav.first, onBack: nav.back,
      title: 'Create a password',
      sub: 'At least 6 letters or numbers. Something others can’t guess.',
      fields: [{ label: 'Password', type: 'password', value: a.pass, attrs: { autocomplete: 'new-password',
        autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'done' } }],
      next: nav.label,
      onInput: function (u, inp) { a.pass = String(inp.value || ''); ui.ok(0, a.pass.length >= 6); },
      onNext: function () {
        a.pass = String(ui.inputs[0].value || '');
        if (a.pass.length < 6) { ui.say('Password needs at least 6 characters.'); ui.inputs[0].focus(); return; }
        return nav.next(ui);
      }
    });
    if (nav.email) {
      // The address, in plain sight before the account is made: a slip in it is
      // caught here, not after an email that never comes.
      ui.form.parentNode.insertBefore(sgEl('p', 'sg-sub', 'You’ll sign in with ' + nav.email + '.'), ui.form);
      var who = sgEl('input', 'sg-ghost');
      who.type = 'email';
      who.setAttribute('autocomplete', 'username');
      who.setAttribute('tabindex', '-1');
      who.setAttribute('aria-hidden', 'true');
      who.readOnly = true;
      who.value = nav.email;
      ui.form.insertBefore(who, ui.form.firstChild);
    }
    ui.ok(0, a.pass.length >= 6);
  }

  /* ---------------- The documents ----------------
     Everyone agrees to three documents before they are in: the Beta Tester
     Non-Disclosure Agreement, the Terms of Use and the Privacy Policy. Their
     text is in no file of the app: it lives in the database, which hands it
     only to someone holding a live Greenroom code or to someone signed in
     (legal_docs_for), and it shows here as it was written.
     There are three ways to these pages, one for each way in:
       a Greenroom code: after the code is found good, before the name;
       a tour invite: before the invited person's own questions;
       someone already in, or a document that changed: over everything, at
       start-up.
     One document a page, then one box to tick and "I Agree". There is no
     skip and no close. What was agreed to is recorded by the database
     (legal_accept: who, which versions, when, from which address), and
     nobody goes on while that has not been saved. */
  // Devin's sentence for the one box, word for word. It is sent with the
  // acceptance, so the record holds the words the person agreed under.
  var LEGAL_SAID = 'I am 18 or older, I agree to the Greenroom Beta Tester Non-Disclosure Agreement and Terms of Use, and I have read the Privacy Policy.';
  var LEGAL_ORDER = ['nda', 'terms', 'privacy'];
  // Short names, for the buttons ("Next: Terms of Use") and the "Updated:" line. A page's title is the document's own.
  var LEGAL_NAMES = { nda: 'Non-Disclosure Agreement', terms: 'Terms of Use', privacy: 'Privacy Policy' };
  var LEGAL_NOLOAD = 'Couldn’t load the documents. Try again.';
  var LEGAL_NOSAVE = 'Couldn’t save that. Try again.';
  // The pages are back because what was agreed to could not be saved: said over the first page's title.
  var LEGAL_AGAIN = 'We couldn’t save your agreement. Please read and agree again.';
  // The server will not record an agreement for an address nobody has proved is theirs.
  var LEGAL_EMAIL = 'Confirm your email first: use the code we emailed you.';
  var LEGAL_STALE = 'The documents were updated while you were reading. Please read them again.';
  /* "Sign out", quiet, under a screen's button: for someone signed in who
     will not agree, or who is in the wrong account. It leaves; it is never a
     way past the pages. fn does the signing out (handed in by whoever drew
     the screen: this stretch knows nothing of the sign-in). */
  function sgOut(ui, fn) {
    var more = sgEl('div', 'sg-more');
    var b = sgEl('button', 'linkbtn sg-out', 'Sign out');
    b.type = 'button';
    b.addEventListener('click', function () { b.disabled = true; fn(); });
    more.appendChild(b);
    ui.form.appendChild(more);
  }

  /* The documents are written in markdown, and this much of it is read:
     headings (#, ##, ###), paragraphs, **bold**, lists whose lines start
     with "- ", and a line ending in two spaces as a line break. Anything
     else shows as the text it is. Every piece is made with createElement
     and its words go in as text: nothing in a document is ever read as HTML,
     and nothing in it can run. */
  // **bold** (and ***this***, shown bold): the stars must hug the words, so "2 ** 3" stays as typed.
  function mdBold(into, text) {
    var re = /(\*{2,3})([^\s*]|[^\s*][\s\S]*?[^\s*])\1(?!\*)/g, at = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > at) into.appendChild(document.createTextNode(text.slice(at, m.index)));
      into.appendChild(sgEl('strong', '', m[2]));
      at = m.index + m[0].length;
    }
    if (at < text.length) into.appendChild(document.createTextNode(text.slice(at)));
  }
  // A paragraph's (or a list line's) own lines: run together with a space, broken where one ended in two spaces.
  function mdLines(into, lines) {
    var run = '';
    lines.forEach(function (l, i) {
      run += (run ? ' ' : '') + l.t;
      if (l.br && i < lines.length - 1) {
        mdBold(into, run);
        into.appendChild(document.createElement('br'));
        run = '';
      }
    });
    if (run) mdBold(into, run);
  }
  /* title: the page's own title. A document that opens by repeating it (a
     first line "# Privacy Policy") does not show it twice. The headings come
     out one size down (# is an h2): the page's title is the h1. */
  function mdNodes(src, title) {
    var frag = document.createDocumentFragment();
    var rows = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    var lines = [], into = null, ul = null, gap = true, seen = false;
    function plain(s) { return String(s || '').replace(/[^a-z0-9]+/gi, '').toLowerCase(); }
    function flush() {
      if (into && lines.length) mdLines(into, lines);
      lines = []; into = null;
    }
    rows.forEach(function (raw) {
      var br = / {2,}$/.test(raw);
      var line = raw.replace(/\s+$/, '');
      var text = line.trim(), m;
      if (!text) { flush(); gap = true; return; }
      var first = !seen;
      seen = true;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(text))) {
        flush(); ul = null; gap = true;
        var words = m[2].replace(/\s+#+$/, '').trim();
        if (first && m[1].length === 1 && title && plain(words) === plain(title)) return;
        var hd = document.createElement('h' + (Math.min(m[1].length, 3) + 1));
        mdBold(hd, words);
        frag.appendChild(hd);
        return;
      }
      // A line of nothing but dashes (or stars) is a rule across the page.
      if (/^([-*_])(\s*\1){2,}$/.test(text)) {
        flush(); ul = null; gap = true;
        frag.appendChild(document.createElement('hr'));
        return;
      }
      if ((m = /^[-*]\s+(.+)$/.exec(text))) {
        flush();
        if (!ul) { ul = document.createElement('ul'); frag.appendChild(ul); }
        into = document.createElement('li');
        if (/^(\t| {2,})/.test(line)) into.className = 'in';   // a list inside a list sits a step in
        ul.appendChild(into);
        lines = [{ t: m[1], br: br }]; gap = false;
        return;
      }
      // A numbered line ("1. ...") and a table's row are not lists here: each shows as typed, on a line of its own.
      var own = /^\d{1,3}[.)]\s+\S/.test(text) || text.charAt(0) === '|';
      if (into && !gap && !own) { lines.push({ t: text, br: br }); return; }
      flush(); ul = null;
      into = document.createElement('p');
      frag.appendChild(into);
      lines = [{ t: text, br: br }]; gap = false;
    });
    flush();
    return frag;
  }

  /* What legal_docs_for answered, checked. null: no usable answer (not let
     in, or not the three documents it promised). { ready: false }: no
     documents are loaded, so nothing is asked of anyone. Else the three, in
     order: { doc, title, version, body, sha, published_at }. */
  function legalClean(d) {
    if (!isObj(d) || d.ok !== true) return null;
    if (d.ready !== true) return { ready: false, docs: [] };
    var by = {}, docs = [];
    (Array.isArray(d.docs) ? d.docs : []).forEach(function (x) {
      if (isObj(x) && LEGAL_ORDER.indexOf(x.doc) >= 0) by[x.doc] = x;
    });
    for (var i = 0; i < LEGAL_ORDER.length; i++) {
      var k = LEGAL_ORDER[i], x = by[k];
      if (!x || !String(x.version == null ? '' : x.version).trim() || !String(x.body == null ? '' : x.body).trim()) return null;
      docs.push({ doc: k, title: String(x.title || '').trim() || LEGAL_NAMES[k], version: String(x.version).trim(),
        body: String(x.body), sha: String(x.sha || ''), published_at: x.published_at || null });
    }
    return { ready: true, docs: docs };
  }
  function legalVersions(docs) {
    var v = {};
    docs.forEach(function (d) { v[d.doc] = d.version; });
    return v;
  }
  // "Terms of Use and Privacy Policy", in the documents' own order.
  function legalList(keys) {
    var names = LEGAL_ORDER.filter(function (k) { return (keys || []).indexOf(k) >= 0; }).map(function (k) { return LEGAL_NAMES[k]; });
    return names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names.join('');
  }

  /* The pages, drawn into host (the gate, or an overlay over the app).
     o.docs: the three documents in order. o.onBack: where Back on the first
     page goes (none: nothing is drawn there; there is never a close).
     o.changed: the documents that changed since this person last agreed
     (['privacy']), said over the first page's title. o.again: a sentence
     said over the first page's title, above that (what they agreed to could
     not be saved, so the pages are back). o.note: a grey line for the first
     page (the documents changed while they were being read). o.signOut: for
     someone signed in, what "Sign out" under each page's button does (none:
     no such link; it is never a skip). o.onAgree(ui): the box is ticked and
     "I Agree" pressed. It does the saving and hands back its promise, the
     way a screen's onNext does. */
  function legalPages(host, o) {
    var docs = o.docs;
    function show(n, note) {
      var d = docs[n], last = n === docs.length - 1;
      var body = sgEl('div');
      var text = sgEl('div', 'sg-doc');
      text.appendChild(mdNodes(d.body, d.title));
      body.appendChild(text);
      var tick = null;
      if (last) {
        // The one box, unticked every time this page is drawn.
        var row = sgEl('label', 'sg-agree');
        tick = sgEl('input');
        tick.type = 'checkbox';
        tick.checked = false;
        row.appendChild(tick);
        row.appendChild(sgEl('span', '', LEGAL_SAID));
        body.appendChild(row);
      }
      var ui = sgScreen(host, {
        onBack: n > 0 ? function () { show(n - 1, ''); } : (o.onBack || null),
        title: d.title,
        sub: 'Document ' + (n + 1) + ' of ' + docs.length + '. Version ' + d.version + '.',
        body: body,
        next: last ? 'I Agree' : 'Next: ' + LEGAL_NAMES[docs[n + 1].doc],
        onNext: function () {
          if (!last) { show(n + 1, ''); return; }
          if (!tick.checked) return;   // (the button is off until the box is ticked: this is the belt to that brace)
          return o.onAgree(ui);
        }
      });
      var box = ui.form.parentNode;
      if (n === 0) {
        var changed = legalList(o.changed);
        // (Over the title: the arrow's row is the box's first child, the title its second.)
        var titleEl = box.firstChild.nextSibling;
        if (o.again) {
          var again = sgEl('p', 'sg-again', String(o.again));
          again.setAttribute('role', 'alert');
          box.insertBefore(again, titleEl);
        }
        if (changed) box.insertBefore(sgEl('p', 'sg-flag', 'Updated: ' + changed), titleEl);
        if (note) box.insertBefore(sgEl('p', 'sg-sub', note), ui.form);
      }
      if (o.signOut) sgOut(ui, o.signOut);
      if (last) {
        ui.stop(true);
        tick.addEventListener('change', function () { ui.stop(!tick.checked); ui.say(''); });
      }
    }
    show(0, o.note || '');
  }

  /* For someone signed in: load the documents, show the pages, save the
     acceptance. o.api is how the server is asked: docs() and status()
     resolve what legal_docs_for and legal_status answered (docs() rejects
     when there was no answer at all), accept(versions, said, via) what
     legal_accept answered (it rejects when there was no answer at all: a
     refusal is an answer). o.via: 'invite' or 'inside'. o.must: this person
     may not go on without the documents (someone new), so when they cannot
     be loaded the screen says so and waits to be tried again; without it
     (someone who was already in, with no signal) they carry on and the next
     start asks. o.before(): something to try first, each time the documents
     are loaded (an agreement given earlier that has yet to be saved); when
     it answers 'owed' that save failed, and the pages say so over their
     first title ('owed-stale': a document changed since, said in the grey
     line). o.again: the caller already knows such a save failed.
     o.note: a grey line for the first page. o.blind: nobody knows yet
     whether any documents are loaded (the account's facts could not be
     read), so the waiting screen does not speak of documents. o.signOut:
     what "Sign out" does, under the button of every page and of the "Try
     again" screen (it leaves; it is not a way past). o.hold(versions, said):
     only for someone who was already in. When "I Agree" gets NO ANSWER (the
     signal dropped while they read), what they agreed to is handed here to
     be kept and sent later, and they carry on: nobody is shut out of an app
     they could use yesterday by a dead spot. A refusal never goes this way.
     Resolves 'agreed' (saved; or these versions were agreed to already, a
     moment ago or on another phone), 'none' (no documents are loaded:
     nothing to ask), 'unread' (could not be loaded, and may carry on) or
     'held' (agreed, kept by o.hold, still to be sent). */
  function legalRun(host, o) {
    return new Promise(function (done) {
      var over = false;
      function end(how) { if (!over) { over = true; done(how); } }
      var LOADING = o.blind ? 'Checking your account…' : 'Loading the documents…';
      // The grey line under "One moment": there while something is loading, gone once it has failed.
      function grey(text) {
        var el = host.querySelector('.sg-sub');
        if (el) el.textContent = text;
      }
      // fresh: the pages are being loaded anew because a document changed mid-read, not because a save failed.
      async function load(ui, note, fresh) {
        var raw = null, st = null, lost = false, again = !fresh && !!o.again;
        if (o.before) {
          try {
            var tried = await o.before();
            if (tried === 'owed') again = true;
            else if (tried === 'owed-stale' && !note) note = LEGAL_STALE;
          } catch (e0) { /* the answer below says where things stand */ }
        }
        // Both asked at once; either may fail without taking the other with it.
        var asked = [
          Promise.resolve().then(function () { return o.api.docs(); }).then(null, function (e) { lost = sgNoAnswer(e); return null; }),
          Promise.resolve().then(function () { return o.api.status(); }).then(null, function () { return null; })
        ];
        raw = await asked[0]; st = await asked[1];
        // Nothing is owed after all: these versions were agreed to already (just now, or on another phone).
        if (isObj(st) && st.ready === true && st.needs === false) { end('agreed'); return; }
        var d = legalClean(raw);
        if (d && !d.ready) { end('none'); return; }
        if (!d) {
          if (!o.must) { end('unread'); return; }
          ui.stop(false);
          grey('');
          // No answer at all is the connection, and is said as that: whether there are any documents to
          // speak of is not even known. A "no" or an error from the server is about the documents.
          ui.say(lost ? SG_OFFLINE : LEGAL_NOLOAD);
          return;
        }
        pages(d.docs, isObj(st) && Array.isArray(st.changed) ? st.changed : [], note, again);
      }
      // A plain screen while the documents come (and the place to try again from when they do not).
      function wait(note, fresh) {
        var ui = sgScreen(host, {
          title: 'One moment', sub: LOADING, next: 'Try again',
          onNext: function () { ui.stop(true); ui.say(''); grey(LOADING); return load(ui, note, fresh); }
        });
        if (o.signOut) sgOut(ui, o.signOut);
        ui.stop(true);
        load(ui, note, fresh);
      }
      function pages(docs, changed, note, again) {
        legalPages(host, { docs: docs, changed: changed, note: note, again: again ? LEGAL_AGAIN : '', onBack: null,
          signOut: o.signOut || null,
          onAgree: async function (ui) {
            ui.say('Saving…', true);
            var r = null;
            try { r = await o.api.accept(legalVersions(docs), LEGAL_SAID, o.via); } catch (e) { r = null; }
            if (isObj(r) && r.ok === true) { end('agreed'); return 'wait'; }
            var why = isObj(r) ? String(r.why || '') : '';
            // A document changed while it was being read: the new one is shown, from the first page.
            if (why === 'stale') { wait(LEGAL_STALE, true); return 'wait'; }
            // The documents were taken down in the meantime: there is nothing left to agree to.
            if (why === 'not ready') { end('none'); return 'wait'; }
            if (!isObj(r)) {
              // No answer. Someone who was already in carries on, with what they agreed to kept to be sent.
              if (typeof o.hold === 'function') {
                var kept = false;
                try { kept = o.hold(legalVersions(docs), LEGAL_SAID) !== false; } catch (e2) { kept = false; }
                if (kept) { end('held'); return 'wait'; }
              }
              ui.say(SG_OFFLINE);
              return;
            }
            // A refusal stays on the page, with its reason when there are words for it.
            ui.say(why === 'email' ? LEGAL_EMAIL : LEGAL_NOSAVE);
          } });
      }
      wait(o.note || '');
    });
  }
  /* </shared-screens> */

  /* How the documents' three functions are asked (migration 0137). A
     database that does not have them yet (a build ahead of its migration)
     counts as "no documents loaded": nothing is asked, as before them. */
  var legalApi = {
    // code: a Greenroom code, for someone not signed in. Signed in, none is needed.
    docs: async function (code) {
      var q = await sgLimit(sb.rpc('legal_docs_for', code ? { c: code } : {}), 12000);
      if (q.error) {
        if (fnMissing(q.error)) return { ok: true, ready: false, docs: [] };
        throw q.error;
      }
      return q.data;
    },
    status: async function () {
      var q = await sgLimit(sb.rpc('legal_status'), 8000);
      if (q.error || !isObj(q.data)) throw (q.error || new Error('no answer'));
      return q.data;
    },
    accept: async function (v, said, via) {
      var q = await sgLimit(sb.rpc('legal_accept', { nda_v: v.nda, terms_v: v.terms, privacy_v: v.privacy, said: said, via: via }));
      if (q.error) {
        if (fnMissing(q.error)) return { ok: false, why: 'not ready' };
        // No answer at all is thrown (the screen then says to check the connection); an error the server sent back is a "no".
        if (q.status === 0 || sgNoAnswer(q.error)) throw q.error;
        return { ok: false, why: 'failed' };
      }
      return isObj(q.data) ? q.data : { ok: false, why: 'failed' };
    }
  };

  /* An agreement that cannot be recorded yet waits here, in memory and on
     the phone, until the server can be told. Two kinds:
     via 'code': a sign-up agrees to the documents before there is an
       account to record that on. What was agreed (which versions, the
       sentence, when) is kept so that closing the app to fetch the emailed
       code does not lose it. It is tied to the Greenroom code it was given
       under (kept as a short print of the code, never the code itself) and,
       once the sign-up has one, to the address the account is for. The
       moment that account is signed in it is sent (legalSendHeld) and
       forgotten.
     via 'inside': someone who was already in tapped "I Agree" and got no
       answer (the signal dropped while they read). It is tied to their
       account and sent as soon as a call gets through (legalFlush).
     The rules that keep the record true:
     - It never lets a NEW visit past the pages. Only the visit that made it
       may skip them (the person pressed Back and typed the same code
       again): legalHere says the record in hand was made by this page load.
       After a reload, or for the next person on the same phone, the three
       pages are shown again, and a fresh "I Agree" replaces what was kept.
     - It is never re-pointed. An address is put on it only by the visit that
       made it (a mistyped address corrected on "Check your email" is the
       same person in the same sitting); one kept from an earlier visit is
       only ever sent for the address it already has, or not at all.
     - With no address yet it lives 30 minutes; with one, a day. After that
       it is forgotten unsent, and the documents are simply shown again. */
  var LEGAL_KEY = 'gr-legal-held';
  var legalHeld = null;
  var legalHere = false;   // the record in hand was made in this visit, by whoever is at the screen now
  function legalTag(code) {
    var s = String(code || '').toUpperCase().replace(/[\s-]/g, ''), n = 5381;
    for (var i = 0; i < s.length; i++) n = ((n << 5) + n + s.charCodeAt(i)) >>> 0;
    return s ? n.toString(36) + '.' + s.length : '';
  }
  function legalHeldRead() {
    if (!legalHeld) {
      try {
        var h = JSON.parse(localStorage.getItem(LEGAL_KEY) || 'null');
        if (isObj(h) && isObj(h.v) && h.said === LEGAL_SAID && (h.via === 'inside' ? !!h.uid && !!h.email : !!h.tag)) legalHeld = h;
      } catch (e) { /* nothing kept */ }
    }
    if (legalHeld && !(Date.now() - Date.parse(legalHeld.at) < (legalHeld.email ? 864e5 : 18e5))) legalDrop();
    return legalHeld;
  }
  function legalKeep() {
    try { localStorage.setItem(LEGAL_KEY, JSON.stringify(legalHeld)); } catch (e) { /* kept for this visit only */ }
  }
  function legalDrop() {
    legalHeld = null;
    legalHere = false;
    try { localStorage.removeItem(LEGAL_KEY); } catch (e) { /* nothing kept */ }
  }
  // "I Agree" at the Greenroom-code door: whatever was kept before is replaced by this.
  function legalHold(code, docs) {
    legalHeld = { via: 'code', tag: legalTag(code), email: '', at: new Date().toISOString(), said: LEGAL_SAID, v: legalVersions(docs) };
    legalHere = true;
    legalKeep();
  }
  /* Did THIS visit agree, with this code (and, when docs are given, to
     exactly these versions)? Never true for a record a page load found
     waiting on the phone. */
  function legalHeldHere(code, docs) {
    var h = legalHeldRead();
    if (!h || !legalHere || h.via === 'inside' || !h.tag || h.tag !== legalTag(code)) return false;
    // (Half an hour, however long the app is left open: a phone handed to the next person shows them the pages.)
    if (!(Date.now() - Date.parse(h.at) < 18e5)) return false;
    if (!docs) return true;
    var v = legalVersions(docs);
    return LEGAL_ORDER.every(function (k) { return !!v[k] && String(h.v[k] || '') === v[k]; });
  }
  /* The address the sign-up is making its account for: from here on the
     agreement is that account's alone. Only the visit that agreed may say
     so; a record from an earlier visit keeps the address it has. */
  function legalMine(code, email) {
    if (!legalHeldHere(code)) return;
    legalHeld.email = String(email || '').trim().toLowerCase();
    legalKeep();
  }
  /* Someone already in agreed and the save got no answer: kept for their
     account, to be sent when a call gets through. false when there is nobody
     to keep it for (then they stay on the page). */
  function legalHoldInside(v, said) {
    if (!session || !session.user || !session.user.id || said !== LEGAL_SAID) return false;
    legalHeld = { via: 'inside', tag: '', uid: String(session.user.id), email: String(session.user.email || '').toLowerCase() || '-',
      at: new Date().toISOString(), said: said, v: v };
    legalHere = true;
    legalKeep();
    return true;
  }
  // Is an agreement of the signed-in account's own waiting to be sent?
  function legalHeldInside() {
    var h = legalHeldRead();
    return !!h && h.via === 'inside' && !!session && !!session.user && h.uid === session.user.id;
  }
  /* Signed in: send what is waiting for this account, if anything is.
     ''       nothing was waiting for it (or the documents were taken down
              since: nothing to record, nothing owed);
     'saved'  its agreement is recorded.
     A sign-up's own (via 'code'):
     'owed'   the save did not go through: the start-up shows the documents
              again and nobody gets past them. It is kept, to be tried again;
     'owed-stale'  the same, because a document changed since it was read:
              that agreement will never be taken, so it is forgotten.
     Someone already in (via 'inside'):
     'held'   still no answer: kept, and tried again at the next chance;
     'stale'  a document changed since they read it: forgotten, and the pages
              are shown again;
     'again'  the server refused it: forgotten, and the pages are shown
              again, saying the agreement could not be saved. */
  async function legalSendHeld() {
    var h = legalHeldRead();
    if (!h || !session || !session.user) return '';
    var r = null;
    if (h.via === 'inside') {
      if (h.uid !== session.user.id) return '';
      try { r = await legalApi.accept(h.v, h.said, 'inside'); } catch (e0) { r = null; }
      if (!isObj(r)) return 'held';
      // (Whatever the answer, it is an answer: nothing is left waiting.)
      if (legalHeld === h) legalDrop();
      if (r.ok === true) return 'saved';
      if (r.why === 'not ready') return '';
      return r.why === 'stale' ? 'stale' : 'again';
    }
    if (!h.email) return '';
    if (String(session.user.email || '').toLowerCase() !== h.email) return '';
    // Only ever onto the account that sign-up just made (as savePending has it).
    var born = Date.parse(session.user.created_at || '');
    if (born && Date.now() - born > 864e5) { legalDrop(); return ''; }
    try { r = await legalApi.accept(h.v, h.said, 'code'); } catch (e) { r = null; }
    if (isObj(r) && r.ok === true) { legalDrop(); return 'saved'; }
    // The documents were taken down since: there is nothing to record, and nothing owed.
    if (isObj(r) && r.why === 'not ready') { legalDrop(); return ''; }
    // A document changed since it was read: that agreement will never be taken, so the pages are shown afresh.
    if (isObj(r) && r.why === 'stale') { legalDrop(); return 'owed-stale'; }
    // Anything else (no answer, or the save failed): it is kept, and tried again from the screen that follows
    // (see legalInside).
    return 'owed';
  }
  // This visit has seen the documents settled for the signed-in account: agreed and saved, or none are loaded.
  var legalPassed = false;
  /* Agreed and saved, for someone signed in. A seat on a tour waits for the
     documents (claim_invites links nothing while they are owed), so it is
     claimed again now. */
  async function legalDone() {
    legalDrop();
    legalPassed = true;
    if (firstFacts) firstFacts.needsLegal = false;
    try { await sgLimit(sb.rpc('claim_invites'), 10000); } catch (e) { /* the next start claims it */ }
  }
  function legalSignOut() { window.GR_BACKEND.signOut(); }
  /* The documents over everything. For someone already in (they have never
     agreed, or a document changed): via 'inside', and a failure to load
     them does not keep them out. For someone new, or invited to a tour, or
     whose agreement could not be saved (must): they do not get past a
     failure to load the documents either, and via is 'invite' for an
     invited person. o: { again, note, blind } as legalRun takes them.
     Resolves when whoever called may carry on, with how it ended: 'agreed',
     'none', 'unread', 'held' (see legalRun), or '' when nothing was shown
     because another question is already up. */
  async function legalInside(must, via, o) {
    if (document.getElementById('gr-pass-gate')) return '';
    o = o || {};
    var wrap = document.createElement('div');
    wrap.id = 'gr-pass-gate';   // the overlay's own name: one at a time, and the app knows a question is up
    wrap.className = 'gr-gate-like';
    // Over a running app (back from the background): a box being typed in underneath lets go of the keyboard.
    // Nothing typed is lost: the app is as it was when the pages lift.
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e0) { /* cosmetic */ }
    document.body.appendChild(wrap);
    var how = '';
    try {
      how = await legalRun(wrap, { api: legalApi, via: via === 'invite' ? 'invite' : 'inside', must: !!must,
        again: !!o.again, note: o.note || '', blind: !!o.blind, signOut: legalSignOut,
        // What the sign-up agreed to and could not save is tried again first: saved, there is nothing to read twice.
        before: must ? legalSendHeld : null,
        // Only someone who was already in is let on with an agreement still to be sent: never someone new or invited.
        hold: !must && via !== 'invite' ? legalHoldInside : null });
    } catch (e) { how = must ? 'broken' : ''; }
    if (how === 'broken') {
      // Someone who must agree is never waved through by a fault in the pages: the app behind stays shut.
      try {
        wrap.textContent = '';
        var p = document.createElement('p');
        p.className = 'gate-hi quiet';
        p.textContent = 'Couldn\u2019t show the documents. Close Greenroom and open it again.';
        wrap.appendChild(p);
      } catch (e2) { /* the overlay stays as it is */ }
      return new Promise(function () {});
    }
    if (how === 'agreed') await legalDone();
    else if (how === 'none') legalPassed = true;
    wrap.remove();
    return how;
  }
  /* An agreement someone already in gave with no signal (via 'inside') is
     sent the moment a call gets through: after every read of the tours, on
     coming back online, on returning from the background. Nothing is held:
     nothing is asked, and no call is made. If the server says the documents
     changed since, or refuses it, the pages are shown again. */
  var legalFlushing = false;
  async function legalFlush() {
    if (legalFlushing || !legalHeldInside()) return '';
    legalFlushing = true;
    var how = '';
    try { how = await legalSendHeld(); } catch (e) { how = 'held'; }
    legalFlushing = false;
    try {
      if (how === 'saved') { await legalDone(); refetchTries = 0; scheduleRefetch(); }
      else if (how === 'stale' || how === 'again') {
        if (firstFacts) firstFacts.needsLegal = true;
        var then = await legalInside(false, 'inside', how === 'stale' ? { note: LEGAL_STALE } : { again: true });
        if (then === 'agreed') { refetchTries = 0; scheduleRefetch(); }
      }
    } catch (e2) { /* the next start asks */ }
    return how;
  }
  /* People who keep Greenroom open are asked too. The start-up only runs
     when the page loads, and a phone can keep the app alive for days: so
     when it comes back from the background (after more than 30 seconds: see
     boot) the documents' status is read, and when it says this account has
     yet to agree (they were loaded, or one changed, while the app sat open)
     the same pages come up over the app, recorded with via 'inside'; then
     the tours are read again. Never before the start-up has had its own
     turn, and never while another question is up.
     legalStarted: the start-up is past the documents (see online). Until
     then nothing reads the tours either: not a return from the background,
     not the signal coming back. */
  var legalStarted = false, legalWaking = false;
  async function legalWake() {
    if (!legalStarted || legalWaking || !session || !session.user) return;
    if (document.getElementById('gr-pass-gate') || document.getElementById('gr-gate')) return;
    legalWaking = true;
    try {
      // An agreement already given and still to be sent goes first; nobody is asked for it twice.
      if (legalHeldInside()) { await legalFlush(); return; }
      var st = null;
      try { st = await legalApi.status(); } catch (e) { st = null; }
      if (!isObj(st) || st.ready !== true || st.needs !== true) return;
      if (firstFacts) firstFacts.needsLegal = true;
      var how = await legalInside(false, 'inside');
      if (how === 'agreed') { refetchTries = 0; scheduleRefetch(); }
    } catch (e2) { /* the next start asks */ } finally { legalWaking = false; }
  }

  function gate(note, code) {
    // From an email's button: straight to the code, already filled in.
    var mode = code ? 'code' : 'signin';
    var wrap = document.createElement('div');
    wrap.id = 'gr-gate';
    document.body.appendChild(wrap);

    /* "I have a code": the way in for someone new, one question a screen.
       A Greenroom code (it has letters in it, like GR-7KQ2-M4XD) starts the
       sign-up: name, username, birthday, email, password. A code with no
       letter in it came in an email (a tour invite, a password reset): the
       emails carry a code as well as a button, because an iPhone always
       opens email links in Safari, never in the home-screen app. That one
       only needs the email it was sent to, and since it could be any of
       those kinds, each is tried in turn. */
    // What they have typed so far, kept while they go back and forth.
    // kinds: what the code was made for. made: the address an account was
    // made for that is still waiting on its emailed code (madePass: with which
    // password; sentAt: when a code last went out to it). tried: an address
    // whose sign-up got no answer, so the account may be there all the same.
    // legalOk: the Greenroom code the documents step has been passed with in
    // this visit (agreed to, or there was nothing to ask: legalFree).
    var a = { code: code || '', codeOk: '', legalOk: '', legalFree: false, kinds: [], codeEmail: '', first: '', last: '', handle: '', handleMine: false,
      month: 0, day: 0, dayPicked: 0, year: 0, birth: '', email: '', pass: '', made: '', madePass: '', sentAt: 0,
      tried: '', triedPass: '' };
    // An address to put in the sign-in card's email box ("That email already has an account").
    var signinEmail = '';
    function toSignin(email) {
      // Whatever was typed for a new account is not for the one about to sign in.
      pendingAnswers = null;
      signinEmail = email || '';
      mode = 'signin';
      wrap.classList.remove('sg-host');
      render();
    }
    // The answers that can only be saved once signed in wait here (see savePending).
    function hold(email) {
      // What this sign-up agreed to (the documents) in this visit is recorded on this address's account and no other.
      if (a.legalOk && !a.legalFree) legalMine(a.legalOk, email);
      // The password the account for this address was made with, when one was (or may have been).
      var sent = a.made === email ? a.madePass : a.tried === email ? a.triedPass : a.pass;
      pendingAnswers = { email: email, first: a.first, last: a.last, handle: a.handle, birth: a.birth,
        // Back from "Check your email" and a different password typed: that is the one they will remember.
        pass: sent !== a.pass ? a.pass : '' };
    }
    function sayWhy(ui, why, email) {
      if (why === 'exists') {
        ui.say('That email already has an account.');
        ui.act('Back to sign in', function () { toSignin(email); });
      } else if (why === 'invited') {
        // The invite made their account already. Its code has often run out by now, so the other
        // way in is named too.
        ui.say('That address already has a tour invite. Use the code from the invite email, or tap Forgot password on the sign-in screen.');
        ui.act('Back to sign in', function () { toSignin(email); });
      } else if (why === 'slow') {
        ui.say(SG_SLOW);
      } else if (why === 'bad') {
        // Good when it was checked, not any more (used up, or run out): the code screen asks afresh.
        a.codeOk = '';
        ui.say(SG_BADCODE);
        ui.act('Change the code', askCode);
      } else if (why === 'email') {
        ui.say('That email address doesn\u2019t look right. Go back and check it.');
      } else {
        ui.say(SG_AGAIN);
      }
    }
    function renderCode() { askCode(); }

    function askCode() {
      var ui = sgScreen(wrap, {
        first: true, onBack: function () { toSignin(''); },
        title: 'Enter your code',
        sub: 'Greenroom is invite-only. Type the code you were given.',
        fields: [{ label: 'Code', value: a.code, attrs: { maxlength: '40', autocomplete: 'one-time-code',
          autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false' } }],
        onInput: function (u, inp) {
          var v = String(inp.value || '').toUpperCase();
          if (v !== inp.value) inp.value = v;
          a.code = v.trim();
          ui.ok(0, !!a.code && a.codeOk === a.code);
          ui.say('');
        },
        onNext: async function () {
          var c = String(ui.inputs[0].value || '').toUpperCase().trim();
          a.code = c;
          if (!c) { ui.say('Type your code.'); ui.inputs[0].focus(); return; }
          // No letter in it: it came in an email, and which email is the next
          // question. Only its digits count, so "123456." pasted from the
          // email works. (It never goes to the database as a Greenroom code,
          // where it would count as a wrong try.)
          if (!/[A-Z]/.test(c)) {
            var digits = c.replace(/\D/g, '');
            if (digits.length < 6) { ui.say('That code is too short. Check it and try again. ' + SG_LETTERS); return; }
            a.code = digits;
            askCodeEmail();
            return;
          }
          // Already checked a moment ago, and past the documents in this very visit (they came Back): no need
          // to ask twice. (What they agreed to must still be in hand: with no address yet it lasts 30 minutes.)
          if (a.codeOk === c && a.legalOk === c && (a.legalFree || legalHeldHere(c))) { askName(); return; }
          ui.say('Checking\u2026', true);
          var kinds = a.kinds;
          if (a.codeOk !== c) {
            var q = await sgLimit(sb.rpc('signup_code_check', { c: c }));
            if (q.error || !isObj(q.data)) { ui.say(sgNoData(q)); return; }
            if (q.data.ok !== true) { ui.say(q.data.why === 'slow' ? SG_SLOW : SG_NOCODE); return; }
            // A good code, but would the account at the end be refused? Better
            // said now than after five more questions. (No answer: carry on.)
            var set = await signupSettings();
            if (set && (!set.open || !set.confirm)) {
              ui.say('Your code is good, but sign-up isn\u2019t switched on yet. Ask the person who gave you the code.');
              return;
            }
            kinds = cleanKinds(q.data.kinds);
          }
          a.codeOk = c;
          a.kinds = kinds;
          /* The documents come next, before the name. The code is what lets
             them be read (it is not spent by that). No answer, or a "no":
             said here, and nobody goes on. None loaded: on to the name, and
             nothing is recorded. Only an agreement given in THIS visit, to
             these very versions, lets the pages be passed without reading
             (the code had to be checked again after a Back). What a page
             load finds kept on the phone never does: after a reload, or for
             the next person to pick the phone up, the three pages are shown
             again, and their "I Agree" replaces what was kept. */
          var raw = null, answered = true, lost = false;
          try { raw = await legalApi.docs(c); } catch (e) { answered = false; lost = sgNoAnswer(e); }
          var d = legalClean(raw);
          if (!d) {
            // A "no" (the code ran out since it was checked): the next press checks the code again, and says so.
            if (answered) a.codeOk = '';
            // No answer at all is the connection (whether any documents are loaded is not even known): the
            // gate's ordinary offline line. Anything the server did answer is about the documents.
            ui.say(lost ? SG_OFFLINE : LEGAL_NOLOAD);
            return;
          }
          if (!d.ready) { a.legalOk = c; a.legalFree = true; askName(); return; }
          a.legalFree = false;
          if (a.legalOk === c && legalHeldHere(c, d.docs)) { askName(); return; }
          a.legalOk = '';
          askLegal(d.docs);
        }
      });
      ui.ok(0, !!a.code && a.codeOk === a.code);
    }
    /* One document a page; Back on the first goes to the code. "I Agree"
       cannot record anything yet (there is no account), so what was agreed
       is remembered for this sign-up and sent the moment its account is
       signed in (see legalSendHeld). */
    function askLegal(docs) {
      legalPages(wrap, { docs: docs, onBack: askCode,
        onAgree: function () {
          legalHold(a.codeOk, docs);
          a.legalOk = a.codeOk;
          askName();
        } });
    }

    // The emailed code: an invite, a password reset or a sign-in email.
    function askCodeEmail() {
      var ui = sgScreen(wrap, {
        onBack: askCode,
        title: 'Which email did it come to?',
        sub: 'Type the email address the code was sent to.',
        fields: [{ label: 'Email', type: 'email', value: a.codeEmail, attrs: { autocomplete: 'email', inputmode: 'email',
          autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'done' } }],
        onInput: function (u, inp) {
          a.codeEmail = String(inp.value || '').trim();
          ui.ok(0, SG_EMAIL.test(a.codeEmail));
        },
        onNext: async function () {
          var email = String(ui.inputs[0].value || '').trim();
          a.codeEmail = email;
          if (!SG_EMAIL.test(email)) { ui.say('Type your email address.'); ui.inputs[0].focus(); return; }
          // Answers typed for a new account ride along only into the account they just made.
          // (a.tried: its sign-up got no answer, yet the email with the code came.)
          var mine = email.toLowerCase();
          var startedHere = mine === a.made || mine === a.tried;
          if (startedHere) hold(mine); else pendingAnswers = null;
          ui.say('Checking\u2026', true);
          var kinds = ['invite', 'recovery', 'email', 'signup'];
          var ok = false;
          for (var i = 0; i < kinds.length && !ok; i++) {
            // Set before the check: signing in runs the rest of the start-up
            // straight away, and a reset code should land on "new password".
            resetting = kinds[i] === 'recovery';
            var r;
            try { r = await sgLimit(sb.auth.verifyOtp({ email: email, token: a.code, type: kinds[i] })); }
            catch (e2) { r = { error: e2 }; }
            // No answer is not a wrong code: stop and say so (the screen's own
            // offline line), not try the other kinds one slow request after another.
            if (r && r.error && sgNoAnswer(r.error)) { resetting = false; throw r.error; }
            ok = !!r && !r.error && !!(r.data && r.data.session);
            // The code proves the mailbox, not who chose the password: a sign-up
            // somebody else started for this address is confirmed by its owner
            // typing the code here. They choose the password themselves before
            // anything else (saving one signs every other device out).
            if (ok && !startedHere && (kinds[i] === 'email' || kinds[i] === 'signup')) {
              var who = r.data.user || r.data.session.user || {};
              var conf = Date.parse(who.email_confirmed_at || who.confirmed_at || '');
              if ((who.user_metadata || {}).invited !== true && conf && Math.abs(Date.now() - conf) < 36e5) mustPassSet(who.id);
            }
          }
          if (ok) return 'wait'; // signed in: the start-up takes it from here
          resetting = false;
          // Not "Forgot password": someone here may have no account at all (a
          // Greenroom code typed without its letters lands on this screen).
          ui.say('That code didn\u2019t work with that email. Emailed codes last an hour and work once. ' + SG_LETTERS);
          ui.act('Back to sign in', function () { toSignin(email); });
        }
      });
      ui.ok(0, SG_EMAIL.test(a.codeEmail));
    }

    function askName() { sgName(wrap, a, { back: askCode, next: askHandle }); }
    function askHandle() {
      sgHandle(wrap, a, { back: askName, next: askBirth,
        // Signed out, so the code vouches for the question.
        check: async function (h) {
          var q = await sgLimit(sb.rpc('signup_handle_free', { c: a.code, h: h }));
          if (q.error || !isObj(q.data)) throw (q.error || new Error('no answer'));
          if (q.data.ok !== true && q.data.why === 'bad') a.codeOk = ''; // the code ran out since it was checked
          return q.data.ok === true ? { free: q.data.free === true } : { why: String(q.data.why || '') };
        } });
    }
    function askBirth() { sgBirth(wrap, a, { back: askHandle, next: askEmail }); }
    function askEmail() {
      var ui = sgScreen(wrap, {
        onBack: askBirth,
        title: 'What\u2019s your email?',
        sub: 'This is how you sign in. The people you tour with can see it.',
        fields: [{ label: 'Email', type: 'email', value: a.email, attrs: { autocomplete: 'email', inputmode: 'email',
          autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' } }],
        onInput: function (u, inp) {
          a.email = String(inp.value || '').trim().toLowerCase();
          ui.ok(0, SG_EMAIL.test(a.email));
        },
        onNext: function () {
          a.email = String(ui.inputs[0].value || '').trim().toLowerCase();
          if (!SG_EMAIL.test(a.email)) { ui.say('That doesn\u2019t look like an email address. Check it and try again.'); ui.inputs[0].focus(); return; }
          askPass();
        }
      });
      ui.ok(0, SG_EMAIL.test(a.email));
    }
    function askPass() {
      sgPass(wrap, a, { back: askEmail, label: 'Create account', email: a.email, next: makeAccount });
    }
    /* The code lets this one address in (signup_code_redeem), then the
       account is made. The database has the last word both times. */
    async function makeAccount(ui) {
      var email = a.email;
      var full = (a.first + ' ' + a.last).trim();
      // Already made for this address and waiting on the emailed code (they came Back): on to that.
      if (a.made === email) { askConfirm(); return; }
      ui.say('Creating your account\u2026', true);
      // An account this sign-up made a moment ago for another address (a typo,
      // seen on "Check your email") is named to the database: it takes that
      // never-confirmed account away and gives the code its use back, so the
      // right address can have it.
      var was = a.made || a.tried;
      if (was === email) was = '';
      var q = await sgLimit(sb.rpc('signup_code_redeem', { c: a.code, addr: email, instead_of: was || null }));
      if (q.error || !isObj(q.data)) { ui.say(sgNoData(q)); return; }
      var why = q.data.ok === true ? '' : String(q.data.why || 'no');
      // The database got as far as looking at the new address, so the earlier account is gone.
      if (was && (!why || why === 'exists' || why === 'invited')) {
        if (a.made === was) { a.made = ''; a.madePass = ''; }
        if (a.tried === was) { a.tried = ''; a.triedPass = ''; }
      }
      // A moment ago this address's sign-up got no answer, and now it "already
      // has an account" (or the code, good seconds ago, has no use left: a
      // one-use code this very sign-up spent). That try got through after
      // all. On to its emailed code.
      if ((why === 'exists' || why === 'bad') && a.tried === email) {
        a.made = email; a.madePass = a.triedPass; a.tried = ''; a.triedPass = '';
        suggestSave(email, a.kinds);
        askConfirm();
        return;
      }
      if (why) { sayWhy(ui, why, email); return; }
      // Before the account is made: signing in starts the rest of the start-up at once.
      hold(email);
      suggestSave(email, a.kinds);
      var res;
      try {
        res = await sgLimit(sb.auth.signUp({ email: email, password: a.pass, options: { data: {
          first_name: a.first.slice(0, 30), last_name: a.last.slice(0, 30),
          full_name: full.slice(0, 60), username: full.slice(0, 40) } } }), 30000);
      } catch (e2) { res = { error: e2 }; }
      if (res.error) {
        pendingAnswers = null;
        var msg = String(res.error.message || ''), kind = String(res.error.code || '');
        if (/already registered|already exists/i.test(msg) || kind === 'user_already_exists' || kind === 'email_exists') {
          sayWhy(ui, 'exists', email);
        } else if (/email address .*invalid|validate email|invalid format/i.test(msg) || kind === 'email_address_invalid') {
          ui.say('That email address doesn\u2019t look right.');
        } else if (/password/i.test(msg) && /at least|short|weak|characters|guess/i.test(msg)) {
          ui.say(sgPassSay(msg));
        } else if (/signups? (are )?(not allowed|disabled)|confirm email first|database error/i.test(msg) ||
            kind === 'signup_disabled' || kind === 'email_provider_disabled') {
          // Sign-ups are switched off, or the database turned the account
          // down because "Confirm email" is off (that reaches here as a bare
          // "Database error"). The code just passed, so it is not the code.
          ui.say(SG_OFF);
        } else if (/sending .*mail|email rate limit|only request this after/i.test(msg) || kind === 'over_email_send_rate_limit') {
          ui.say(SG_MAIL);
        } else if (/rate limit|too many/i.test(msg)) {
          ui.say(SG_SLOW);
        } else if (sgNoAnswer(res.error)) {
          // No answer is not a "no": the account may have been made all the
          // same. Remembered, so the next try can tell (see a.tried above).
          a.tried = email; a.triedPass = a.pass; a.sentAt = Date.now();
          ui.say(SG_OFFLINE);
          return;
        } else {
          ui.say(SG_AGAIN);
        }
        suggestClear();
        return;
      }
      if (res.data && res.data.session) return 'wait'; // signed in: the start-up takes it from here
      // An address that already has an account comes back looking like a new one with nothing in it.
      var made = res.data && res.data.user;
      if (made && Array.isArray(made.identities) && !made.identities.length) {
        pendingAnswers = null;
        suggestClear();
        sayWhy(ui, 'exists', email);
        return;
      }
      // The project wants the email confirmed first: one more screen, for the code it just sent.
      a.made = email; a.madePass = a.pass; a.sentAt = Date.now();
      a.tried = ''; a.triedPass = '';
      askConfirm();
    }
    /* The account is made and a code has gone to the address to prove it is
       theirs. Two ways on are always there under the button: a new code (one
       a minute: the link counts the seconds down) and back to the address,
       for someone who sees here that they mistyped it. */
    function askConfirm() {
      var email = a.made;
      var more = sgEl('div', 'sg-more');
      var againB = sgEl('button', 'linkbtn', 'Send a new code');
      againB.type = 'button';
      var wrongB = sgEl('button', 'linkbtn', 'Wrong address? Go back');
      wrongB.type = 'button';
      more.appendChild(againB); more.appendChild(wrongB);
      var timer = 0, sending = false;
      function count() {
        // The screen has gone (signed in, or they went back): nothing left to count for.
        if (!document.body.contains(more)) { clearInterval(timer); return; }
        var left = Math.min(60, 60 - Math.floor((Date.now() - a.sentAt) / 1000));
        againB.disabled = sending || left > 0;
        againB.textContent = left > 0 ? 'Send a new code in ' + left + (left === 1 ? ' second' : ' seconds') : 'Send a new code';
        if (left <= 0) clearInterval(timer);
      }
      function countdown() { clearInterval(timer); timer = setInterval(count, 1000); count(); }
      async function again() {
        sending = true; againB.disabled = true;
        ui.say('Sending\u2026', true);
        try {
          var r = await sgLimit(sb.auth.resend({ type: 'signup', email: email }));
          if (r && r.error) throw r.error;
          a.sentAt = Date.now();
          ui.say('Sent. Check your email for the new code.', true);
        } catch (e3) {
          ui.say(sgNoAnswer(e3) ? SG_OFFLINE : SG_MAIL);
        }
        sending = false;
        countdown();
      }
      againB.addEventListener('click', again);
      wrongB.addEventListener('click', askEmail);
      var ui = sgScreen(wrap, {
        onBack: askPass,
        title: 'Check your email',
        sub: 'We sent a code to ' + email + '. Type it here.',
        fields: [{ label: 'Code', value: '', attrs: { maxlength: '12', autocomplete: 'one-time-code', inputmode: 'numeric',
          enterkeyhint: 'done' } }],
        onInput: function (u, inp) {
          ui.ok(0, String(inp.value || '').replace(/\D/g, '').length >= 6);
          ui.say('');
        },
        onNext: async function () {
          var token = String(ui.inputs[0].value || '').replace(/\D/g, '');
          if (token.length < 6) { ui.say('Type the code from the email.'); ui.inputs[0].focus(); return; }
          hold(email);
          ui.say('Checking\u2026', true);
          var kinds = ['signup', 'email'];
          var ok = false;
          for (var i = 0; i < kinds.length && !ok; i++) {
            var r;
            try { r = await sgLimit(sb.auth.verifyOtp({ email: email, token: token, type: kinds[i] })); }
            catch (e2) { r = { error: e2 }; }
            // No answer is not a wrong code: the screen's own offline line says so.
            if (r && r.error && sgNoAnswer(r.error)) throw r.error;
            ok = !!r && !r.error && !!(r.data && r.data.session);
          }
          if (ok) return 'wait'; // signed in: the start-up takes it from here
          ui.say('That code didn\u2019t work. Check it, or send a new one.');
        }
      });
      ui.form.appendChild(more);
      countdown();
    }

    function render() {
      if (mode === 'code') { renderCode(); return; }
      var signin = mode === 'signin';
      wrap.innerHTML =
        '<div class="gate-card">' +
        '<span class="logo-mark gate-mark" role="img" aria-label="Greenroom"></span>' +
        '<form id="gr-gate-form" novalidate>' +
        (signin ? '' :
          '<div class="gate-pair">' +
          '<input class="input" type="text" id="gr-gate-first" placeholder="First name" ' +
            'maxlength="30" autocomplete="given-name" aria-label="First name">' +
          '<input class="input" type="text" id="gr-gate-last" placeholder="Last name" ' +
            'maxlength="30" autocomplete="family-name" aria-label="Last name">' +
          '</div>') +
        '<input class="input" type="email" id="gr-gate-email" placeholder="' + (signin ? 'you@email.com' : 'Email') +
          '" autocomplete="email" inputmode="email" aria-label="Email">' +
        (signin ? '' :
          '<input class="input" type="tel" id="gr-gate-phone" placeholder="Phone number" ' +
            'maxlength="30" autocomplete="tel" inputmode="tel" aria-label="Phone number">' +
          rolePickerHtml('gr-gate-role', '')) +
        '<input class="input" type="password" id="gr-gate-pass" placeholder="Password" ' +
          'autocomplete="' + (signin ? 'current-password' : 'new-password') + '" aria-label="Password">' +
        '<div class="gate-err" id="gr-gate-err" role="alert"></div>' +
        '<button class="btn primary block" type="submit">' +
          (signin ? 'Sign in' : 'Create account') + '</button>' +
        '</form>' +
        '<button class="linkbtn quiet" id="gr-gate-forgot" type="button">Forgot password?</button>' +
        '<button class="linkbtn quiet" id="gr-gate-code-link" type="button">I have a code</button>' +
        // Invite-only: making an account starts with a code ("I have a code"
        // above). The database refuses any account whose address no code or
        // invite has let in (signup_gate).
        '<p class="gate-note">Greenroom is invite-only. You need a code to make an account.</p>' +
        '</div>';

      var form = wrap.querySelector('#gr-gate-form');
      wireRolePicker(wrap, 'gr-gate-role');
      var emailI = wrap.querySelector('#gr-gate-email');
      var passI = wrap.querySelector('#gr-gate-pass');
      var errEl = wrap.querySelector('#gr-gate-err');
      var btn = form.querySelector('button');
      if (note) { errEl.textContent = note; note = ''; }
      // Sent back from the sign-up ("That email already has an account"): the address is already in.
      if (signinEmail) { emailI.value = signinEmail; signinEmail = ''; }

      // Email a link to set a password. Works for a forgotten password and for
      // anyone invited who never got to pick one.
      async function emailLink() {
        var email = String(emailI.value || '').trim();
        if (email.indexOf('@') < 1) { errEl.textContent = 'Type your email above, then tap it again.'; emailI.focus(); return; }
        errEl.textContent = 'Sending\u2026';
        try {
          await sgLimit(sendPasswordLink(email));
          errEl.textContent = 'Check your email. Tap the button in it, or come back here, tap \u201cI have a code\u201d and type the code from it.';
        } catch (e3) {
          var m3 = String(e3 && e3.message || '');
          errEl.textContent = /rate limit|too many|seconds/i.test(m3)
            ? 'Too many emails went out in the last hour. Try again in a little while.'
            : 'Couldn\u2019t send the email. Check your connection and try again.';
        }
      }
      var forgot = wrap.querySelector('#gr-gate-forgot');
      if (forgot) forgot.addEventListener('click', emailLink);
      var codeLink = wrap.querySelector('#gr-gate-code-link');
      if (codeLink) codeLink.addEventListener('click', function () { mode = 'code'; render(); });

      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        errEl.textContent = '';
        var email = String(emailI.value || '').trim();
        var pass = String(passI.value || '');
        var firstI = wrap.querySelector('#gr-gate-first');
        var lastI = wrap.querySelector('#gr-gate-last');
        var phoneI = wrap.querySelector('#gr-gate-phone');
        var roleI = wrap.querySelector('#gr-gate-role');
        var first = firstI ? String(firstI.value || '').trim() : '';
        var last = lastI ? String(lastI.value || '').trim() : '';
        var phone = phoneI ? String(phoneI.value || '').trim() : '';
        var tourRole = roleI ? String(roleI.value || '') : '';
        if (firstI && !first) { errEl.textContent = 'Type your first name.'; firstI.focus(); return; }
        if (lastI && !last) { errEl.textContent = 'Type your last name.'; lastI.focus(); return; }
        if (phoneI && phone.replace(/\D/g, '').length < 7) { errEl.textContent = 'Type a phone number the tour can reach you on.'; phoneI.focus(); return; }
        if (roleI && !tourRole) { errEl.textContent = 'Pick your role on the tour.'; wrap.querySelector('#gr-gate-role-btn').focus(); return; }
        if (email.indexOf('@') < 1) { errEl.textContent = 'Type your email address.'; emailI.focus(); return; }
        if (pass.length < 6) { errEl.textContent = 'Password needs at least 6 characters.'; passI.focus(); return; }
        btn.disabled = true;
        try {
          // With a limit (sgLimit): no answer in time lands in the catch below, and the button comes back.
          var res = signin
            ? await sgLimit(sb.auth.signInWithPassword({ email: email, password: pass }))
            : await sgLimit(sb.auth.signUp({ email: email, password: pass, options: { data: {
                first_name: first.slice(0, 30), last_name: last.slice(0, 30),
                full_name: (first + ' ' + last).slice(0, 60),
                username: (first + ' ' + last).slice(0, 40),
                phone: phone.slice(0, 30), tour_role: tourRole } } }), 30000);
          if (res.error) throw res.error;
          if (!res.data || !res.data.session) throw new Error('no session');
          // onAuthStateChange finishes the job
        } catch (e2) {
          btn.disabled = false;
          var msg = String(e2 && e2.message || '');
          if (/already registered|already exists/i.test(msg)) {
            // Often someone who was invited: the invite made their account,
            // but they never got to pick a password. One tap fixes either case.
            errEl.textContent = 'That email already has an account. If you were invited or don\u2019t know the password, ';
            var fix = document.createElement('button');
            fix.type = 'button'; fix.className = 'linkbtn inline';
            fix.textContent = 'email me a link to set it.';
            fix.addEventListener('click', emailLink);
            errEl.appendChild(fix);
          } else if (/invalid login credentials/i.test(msg)) {
            errEl.textContent = signin
              ? 'Wrong email or password. Tap \u201cForgot password?\u201d below to set a new one.'
              : 'Couldn\u2019t create the account. Try again.';
          } else if (/not confirmed/i.test(msg)) {
            errEl.textContent = 'That account isn\u2019t set up yet. Tap \u201cForgot password?\u201d below and we\u2019ll email you a link to finish.';
          } else if (/at least|password/i.test(msg)) {
            errEl.textContent = 'Pick a longer password (6 characters or more).';
          } else {
            errEl.textContent = 'Couldn’t reach the server. Check your connection and try again.';
          }
        }
      });
    }
    render();
    return wrap;
  }

  /* Links in Supabase's emails (Accept invitation, Reset password) come back
     with the sign-in after a # in the address, the older style. This client
     runs the newer code flow, and supabase-js turns those links away in that
     mode, which left invited crew signed out with no password to sign in
     with. So the app reads them itself, then wipes them from the address. */
  function readEmailLink() {
    // The GREENROOM emails' button opens the app with the code in the
    // address (?code=12345678): it doesn't sign in by itself, so the code
    // still works when typed into the home-screen app.
    var q = new URLSearchParams(location.search);
    var code = String(q.get('code') || '').replace(/\D/g, '');
    if (code) {
      q.delete('code');
      var rest = q.toString();
      try { history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch (e) { /* cosmetic */ }
      return { code: code };
    }
    var raw = String(location.hash || '').replace(/^#/, '');
    if (!/access_token=|error_description=|error_code=/.test(raw)) return {};
    var p = new URLSearchParams(raw);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* cosmetic */ }
    return {
      access: p.get('access_token') || '', refresh: p.get('refresh_token') || '',
      type: p.get('type') || '',
      error: p.get('error_description') || p.get('error_code') || ''
    };
  }

  async function boot() {
    // Pinned to one exact version: a library that could change under the app is not one to trust.
    // (window.GR_SUPABASE is the seam for trying the gate with no real project:
    // tools/gate_test.html sets it to a stand-in. It is honoured only on a
    // developer's own machine; on the live site it is ignored, so nothing
    // that got onto the page could swap the server for one of its own.)
    var mod = (localHost() && window.GR_SUPABASE) || await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm');
    sbMod = mod;
    var link = readEmailLink();
    sb = mod.createClient(cfg.url, cfg.anonKey, {
      // processLock, not the browser's shared lock: on an iPhone the shared
      // one can stay held after the app sleeps, and every sign-in call behind
      // it (signing out, even starting up) waits forever.
      auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true,
        lock: mod.processLock || undefined },
      global: { fetch: sturdyFetch }
    });
    // Back from the background: freshen the sign-in and wake the connection
    // before the first tap needs it, and send any saves that couldn't go.
    var hiddenAt = 0;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 30e3) {
        freshToken(false).then(function () { flushErrors(); }).catch(function () { /* next tap tries */ });
        flowersChanged(); // gifts while the phone slept never came down the live line
        // Nor did anyone's changes to the tours, or new bank lines. (Not while the start-up is still waiting at
        // the documents: someone reading them who looks away and comes back has agreed to nothing yet, and
        // nothing of a tour is read for them until they have. The start-up reads everything when it carries on.)
        if (session && legalStarted) { refetchTries = 0; scheduleRefetch(); feedChanged(); }
        newBuildCheck();
        // The documents may have been loaded, or one changed, while the app sat open: asked here too (see legalWake).
        if (session) legalWake();
      } else if (refetchOwed && session) { refetchTries = 0; scheduleRefetch(); }
      hiddenAt = 0;
    });
    window.addEventListener('online', function () {
      flushErrors();
      if (session && legalStarted) { refetchTries = 0; scheduleRefetch(); feedChanged(); legalFlush(); }
    });
    var got = await sb.auth.getSession();
    session = got.data ? got.data.session : null;
    var note = '';
    if (link.access && link.refresh) {
      var set = await sb.auth.setSession({ access_token: link.access, refresh_token: link.refresh });
      if (set.data && set.data.session) session = set.data.session;
      else note = 'That link has expired or was already used. Tap \u201cForgot password?\u201d for a fresh one.';
    } else if (link.error) {
      note = /expired|invalid/i.test(link.error)
        ? 'That link has expired or was already used. Tap \u201cForgot password?\u201d for a fresh one.'
        : 'That link didn\u2019t work. Tap \u201cForgot password?\u201d for a fresh one.';
    }
    resetting = link.type === 'recovery' && !!session;

    if (!session) {
      var g = gate(note, link.code);
      sb.auth.onAuthStateChange(function (_ev, s) {
        if (s && !session) { session = s; g.remove(); online(); }
      });
    }
    // Every hourly renewal of the sign-in pass lands here, so the copy the
    // server calls use never goes stale. (After the gate's listener, which
    // needs to see the very first sign-in.)
    sb.auth.onAuthStateChange(function (_ev, s) { if (s) session = s; });
    if (session) online();
  }

  /* Tours made before signing in (phone-only mode) follow their owner into
     the account the first time it's empty — nothing gets left behind. */
  async function importLocalTours() {
    if (cache.tours.size) return;
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem('greenroom:v1') || 'null'); } catch (e) { return; }
    if (!raw || !isObj(raw.tours)) return;
    var ids = Object.keys(raw.tours).filter(function (k) { return isObj(raw.tours[k]); });
    if (!ids.length) return;
    for (var i = 0; i < ids.length; i++) {
      try { await sb.from('tours').insert({ id: ids[i], doc: raw.tours[ids[i]] }); }
      catch (e) { /* keep going; the backup below preserves it */ }
    }
    try {
      localStorage.setItem('greenroom:v1:backup', JSON.stringify(raw));
      localStorage.removeItem('greenroom:v1');
    } catch (e) { /* cosmetic */ }
    try { await refetch(); } catch (e) { /* realtime will catch up */ }
  }

  /* Invited crew land here from the email: signed in by its code, with no
     password yet. The tour manager already typed their name and role, so
     what is left is asked one question a screen, over the app, the same way
     the sign-up asks: a username (their @name), a birthday, a password.
     Anything the invite didn't carry (an older invite: the name, the role)
     is asked first. There is no way out of the first screen on purpose: an
     account with no password could never sign in again.
     Before any of it come the documents (see "The documents"): the three
     pages, recorded at once (they are signed in). There is no Back from the
     first of them and no way round: when they cannot be loaded the screen
     says so and waits. The start-up shows them itself and waits there,
     BEFORE the tours are read and the app is started (see online), so by the
     time this overlay is drawn they are normally settled and it goes
     straight to its questions. Its own check below stays as a second lock:
     should it ever be reached with the documents still owed, they are asked
     here, as the first step. owed: this start-up already tried to record an
     agreement and could not. */
  function passwordGate(owed) {
    if (document.getElementById('gr-pass-gate')) return;
    var wrap = document.createElement('div');
    wrap.id = 'gr-pass-gate';
    wrap.className = 'gr-gate-like';
    document.body.appendChild(wrap);
    var m0 = session.user.user_metadata || {};
    var typed = String(m0.full_name || m0.username || '').trim();
    var a = { first: String(m0.first_name || typed.split(/\s+/)[0] || '').trim(),
      last: String(m0.last_name || typed.split(/\s+/).slice(1).join(' ') || '').trim(),
      role: roleName(m0.tour_role), handle: '', handleMine: false, month: 0, day: 0, year: 0, birth: '', pass: '' };
    var steps = [];
    if (!a.first || !a.last) steps.push(askName);
    if (!m0.tour_role) steps.push(askRole);
    steps.push(askHandle, askBirth, askPass);
    function go(i) { steps[i](i); }
    function nav(i) {
      return { back: i > 0 ? function () { go(i - 1); } : null, next: function () { go(i + 1); } };
    }
    function askName(i) { sgName(wrap, a, nav(i)); }
    // The job title for the crew list, from the same list the old card offered.
    function askRole(i) {
      var n = nav(i);
      var row = sgEl('div', 'sg-field sg-picks' + (a.role ? ' ok' : ''));
      var pick = sgEl('button', 'sg-pickb' + (a.role ? '' : ' empty'), a.role || 'Your role on the tour');
      pick.type = 'button';
      pick.setAttribute('aria-haspopup', 'listbox');
      var line = sgEl('div', 'sg-date');
      line.appendChild(pick);
      row.appendChild(sgEl('span', 'sg-label', 'Role')); row.appendChild(line); row.appendChild(sgTick());
      row.addEventListener('click', function () {
        openRolePicker(a.role, function (role) {
          a.role = role;
          pick.textContent = role;
          pick.classList.remove('empty');
          row.classList.add('ok');
          ui.say('');
        });
      });
      var ui = sgScreen(wrap, {
        onBack: n.back,
        title: 'What\u2019s your role on the tour?',
        sub: 'Your job on this run. It shows next to your name on the crew list.',
        body: row, focus: pick,
        onNext: function () {
          if (!a.role) { ui.say('Pick your role on the tour.'); return; }
          n.next();
        }
      });
    }
    function askHandle(i) {
      var n = nav(i);
      // Signed in now, so the ordinary question does.
      n.check = function (h) { return sgLimit(window.GR_BACKEND.handleFree(h)).then(function (free) { return { free: free }; }); };
      n.skip = true;
      sgHandle(wrap, a, n);
    }
    function askBirth(i) { sgBirth(wrap, a, nav(i)); }
    function askPass(i) {
      var n = nav(i);
      n.label = 'Join the tour';
      n.email = session.user.email || '';
      n.next = finish;
      sgPass(wrap, a, n);
    }
    async function finish(ui) {
      var full = (a.first + ' ' + a.last).trim();
      // The name in chat is simply the person's name (as saveProfile has it); the @name goes on the profile.
      var meta = Object.assign({}, m0, {
        invited: false, first_name: a.first.slice(0, 30), last_name: a.last.slice(0, 30),
        full_name: full.slice(0, 60), username: full.slice(0, 40),
        phone: String(m0.phone || '').slice(0, 30), tour_role: a.role });
      // Said on the button the moment it is tapped: the saves below can take several seconds.
      var btn = ui.form.querySelector('.sg-next'), word = btn ? btn.textContent : '';
      if (btn) btn.textContent = 'Saving\u2026';
      var q;
      try { q = await sgLimit(sb.auth.updateUser({ password: a.pass, data: meta })); } catch (e2) { q = { error: e2 }; }
      // An earlier try that seemed to get no answer did save the password, and
      // the server will not take the same one twice: only the rest is sent.
      if (q.error && /different from the old/i.test(String(q.error.message || ''))) {
        try { q = await sgLimit(sb.auth.updateUser({ data: meta })); } catch (e5) { q = { error: e5 }; }
      }
      if (q.error) {
        if (btn) btn.textContent = word;
        var msg = String(q.error.message || '');
        ui.say(/password/i.test(msg) && /at least|short|weak|characters|guess/i.test(msg) ? sgPassSay(msg)
          : sgNoAnswer(q.error) ? SG_OFFLINE : 'Couldn\u2019t save it. Try again.');
        return;
      }
      // (Always "not invited" on this phone from here, whatever came back: firstRun reads it.)
      session.user = q.data && q.data.user ? q.data.user : Object.assign({}, session.user, { user_metadata: meta });
      // The password is in: from here nothing may keep them out. What does
      // not stick (the username went to someone else a moment ago) the
      // first run asks again.
      var landed = false;
      var saves = (async function () {
        await pushProfile();
        if (a.handle) { try { await window.GR_BACKEND.setHandle(a.handle); } catch (e3) { /* asked again */ } }
        if (a.birth) { try { await window.GR_BACKEND.saveBirthDate(a.birth); } catch (e4) { /* asked again */ } }
        landed = true;
      })();
      await soon(saves, 10000);
      // The first run was held back while this overlay was up (see firstRun).
      // What it still has to ask is read from the server again, now that the
      // answers given here are saved there, and then the app is told.
      await rereadFirstRun();
      wrap.remove();
      emit('tours'); // the app redraws with what it now knows about this account
      // Still out when the wait ran out: the app hears again when they land.
      if (!landed) saves.then(function () { emit('tours'); });
      return 'wait';
    }
    /* The documents are owed when the first-run facts say so. When those
       could not be read at all, the documents' own functions are asked
       (someone new must not slip past on a weak signal); they answer "none
       loaded" on a database that has no documents, and then nothing is
       asked, as before. */
    var f = firstFacts || { unknown: true };
    // (legalPassed: the start-up already waited at the documents in this visit, and they are agreed to or there are none.)
    if (legalPassed || (!owed && !f.needsLegal && !f.unknown)) { go(0); return; }
    legalRun(wrap, { api: legalApi, via: 'invite', must: true, blind: !owed && !f.needsLegal, signOut: legalSignOut,
      before: owed ? legalSendHeld : null }).then(function (how) {
      if (how !== 'agreed') return;
      // Their seat on the tour was waiting for this: claimed now, and the tours are read again.
      return legalDone().then(function () { refetchTries = 0; scheduleRefetch(); });
    }).then(function () { go(0); }, function () { go(0); });
  }

  /* A reset link: signed in by the link, now pick the new password. */
  /* "This account must choose its own password": kept on the phone until one
     is saved, so closing the app does not get round it. */
  var MUST_PASS = 'gr-must-pass';
  var mustPassNow = '';
  function mustPassSet(id) {
    try { localStorage.setItem(MUST_PASS, String(id || '')); } catch (e) { /* asked this once, then */ }
    mustPassNow = String(id || '');
  }
  function mustPassDue() {
    var id = mustPassNow;
    if (!id) { try { id = localStorage.getItem(MUST_PASS) || ''; } catch (e) { id = ''; } }
    return !!id && !!session && !!session.user && session.user.id === id;
  }
  function mustPassDone() {
    mustPassNow = '';
    try { localStorage.removeItem(MUST_PASS); } catch (e) { /* nothing kept */ }
  }
  function newPasswordGate(must) {
    resetting = false;
    if (document.getElementById('gr-pass-gate')) return;
    var wrap = document.createElement('div');
    wrap.id = 'gr-pass-gate';
    wrap.className = 'gr-gate-like';
    wrap.innerHTML =
      '<div class="gate-card">' +
      '<span class="logo-mark gate-mark" role="img" aria-label="Greenroom"></span>' +
      '<p class="gate-hi">' + (must ? 'Choose your password.' : 'Pick a new password.') + '</p>' +
      (must ? '<p class="gate-hi quiet">This account was started for your email. Set a password only you know.</p>' : '') +
      '<form id="gr-pass-form" novalidate>' +
      '<input class="input" type="password" id="gr-pass-new" placeholder="New password" ' +
        'autocomplete="new-password" aria-label="New password">' +
      '<div class="gate-err" id="gr-pass-err" role="alert"></div>' +
      '<button class="btn primary block" type="submit">Save</button>' +
      '</form>' +
      (must ? '' : '<button class="linkbtn quiet" id="gr-pass-keep" type="button">Keep my current password</button>') +
      '</div>';
    document.body.appendChild(wrap);
    if (!must) wrap.querySelector('#gr-pass-keep').addEventListener('click', function () { wrap.remove(); });
    var form = wrap.querySelector('#gr-pass-form');
    var passI = wrap.querySelector('#gr-pass-new');
    var errEl = wrap.querySelector('#gr-pass-err');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var pass = String(passI.value || '');
      if (pass.length < 6) { errEl.textContent = 'Password needs at least 6 characters.'; passI.focus(); return; }
      form.querySelector('button').disabled = true;
      try {
        var q = await sb.auth.updateUser({ password: pass });
        if (q.error) throw q.error;
        if (q.data && q.data.user) session.user = q.data.user;
        mustPassDone();
        wrap.querySelector('.gate-card').innerHTML =
          '<span class="logo-mark gate-mark" role="img" aria-label="Greenroom"></span>' +
          '<p class="gate-hi">Password saved.</p>' +
          '<button class="btn primary block" id="gr-pass-done" type="button">Keep going</button>';
        wrap.querySelector('#gr-pass-done').addEventListener('click', function () { wrap.remove(); });
      } catch (e2) {
        form.querySelector('button').disabled = false;
        errEl.textContent = /different from the old/i.test(String(e2 && e2.message || ''))
          ? (must ? 'Pick a different password from the one this account started with.'
                  : 'That\u2019s the password you already had. Pick a new one, or just keep going.')
          : 'Couldn\u2019t save it. Try again.';
      }
    });
  }

  /* The account is the truth; the profiles row is the copy the crew can read. */
  async function pushProfile() {
    if (!session || !session.user) return;
    var m = session.user.user_metadata || {};
    try {
      await sb.from('profiles').upsert({
        user_id: session.user.id,
        full_name: String(m.full_name || '').slice(0, 60),
        first_name: String(m.first_name || '').slice(0, 30),
        last_name: String(m.last_name || '').slice(0, 30),
        username: String(m.username || '').slice(0, 40),
        email: session.user.email || '',
        phone: String(m.phone || '').slice(0, 30),
        tour_role: roleName(m.tour_role).slice(0, 40),
        updated_at: new Date().toISOString()
      });
    } catch (e) { /* the phone book can wait for the next sign-in */ }
  }

  /* What the sign-up asked before there was an account to keep it on: the
     name, the @username, the birthday. Saved the moment that account is
     signed in. Whatever does not stick here (the username went to someone
     else in the meantime, say) the first run simply asks again. */
  var pendingAnswers = null;
  async function savePending() {
    var p = pendingAnswers;
    pendingAnswers = null;
    if (!p || !session || !session.user) return;
    // Only ever onto the account that sign-up just made: never one that was
    // already there (another address, or an account older than a day).
    if (String(session.user.email || '').toLowerCase() !== p.email) return;
    var born = Date.parse(session.user.created_at || '');
    if (born && Date.now() - born > 864e5) return;
    var first = p.first.slice(0, 30), last = p.last.slice(0, 30), full = (p.first + ' ' + p.last).trim();
    try {
      var m = session.user.user_metadata || {};
      var change = {};
      if (String(m.first_name || '') !== first || String(m.last_name || '') !== last) {
        change.data = { first_name: first, last_name: last, full_name: full.slice(0, 60), username: full.slice(0, 40) };
      }
      if (p.pass) change.password = p.pass;
      if (change.data || change.password) {
        var q = await sb.auth.updateUser(change);
        if (!q.error && q.data && q.data.user) session.user = q.data.user;
      }
    } catch (e) { /* the name went onto the account with the sign-up itself */ }
    await pushProfile();
    if (p.handle) {
      try { await window.GR_BACKEND.setHandle(p.handle); } catch (e) { /* taken since it was checked: asked again */ }
    }
    if (p.birth) {
      // (saveBirthDate is the save_birth_date call, and it keeps the first-run facts true.)
      try { await window.GR_BACKEND.saveBirthDate(p.birth); } catch (e) { /* asked again */ }
    }
  }
  // Waits for a save, but never longer than ms: a request with no answer
  // must not hold the app's start (the save carries on behind it).
  function soon(work, ms) {
    return Promise.race([Promise.resolve(work).catch(function () { /* whoever asked has its own answer for a failure */ }),
      new Promise(function (res) { setTimeout(res, ms); })]);
  }

  /* The first-run facts, read once before the app starts: has this account
     finished the questions, what it ticked, its @username, whether it has a
     birthday on file. If they cannot be read for ANY reason (the database
     change not live yet, no signal, an answer that never comes) the account
     counts as finished: better to skip the questions than to keep anyone
     from their tours. */
  var firstFacts = null;
  async function loadFirstRun(ms) {
    var got = null;
    try {
      var q = await Promise.race([sb.rpc('my_first_run'),
        new Promise(function (res) { setTimeout(function () { res(null); }, ms || 8000); })]);
      if (q && !q.error && isObj(q.data)) got = q.data;
    } catch (e) { got = null; }
    // needsLegal: the documents are loaded and this account has not agreed to
    // the current ones (my_first_run's needs_legal; a database from before
    // the documents never says so).
    firstFacts = got
      ? { onboarded: got.onboarded !== false, kinds: cleanKinds(got.kinds), handle: String(got.handle || ''),
          hasBirth: got.hasBirth === true, needsLegal: got.needs_legal === true }
      : { onboarded: true, kinds: [], handle: '', hasBirth: true, unknown: true };
  }
  /* Read again after the invited person's overlay has saved its answers, so
     the first run asks only what the server still lacks. If the answer does
     not come this time, what was already known stays (the saves keep it true
     as they land): "could not be read" must not quietly cancel a first run
     that was due. */
  async function rereadFirstRun() {
    var before = firstFacts;
    await loadFirstRun(5000);
    if (firstFacts.unknown && before && !before.unknown) firstFacts = before;
  }

  async function online() {
    /* Fresh from a sign-up that agreed to the documents before it had an
       account: that is recorded first, before anything else is asked of the
       server (a seat on a tour and the first run both wait for it). The same
       goes for an agreement someone already in gave with no signal. Anyone
       else has nothing waiting, and this costs them nothing. owed: a
       sign-up's could not be saved, so the documents are shown again below
       and nobody gets past them. */
    var sent = await legalSendHeld();
    var owed = sent === 'owed' || sent === 'owed-stale';
    // An ordinary sign-in has nothing waiting to be saved, so the first-run
    // facts are asked for alongside the invites: the app starts no later than
    // it used to. (loadFirstRun never throws: no answer counts as "finished".)
    var facts = pendingAnswers ? null : loadFirstRun();
    try { await sb.rpc('claim_invites'); } catch (e) { /* nothing to claim */ }
    if (facts) await facts;
    else {
      // Fresh from the sign-up: its answers first, then the facts they change.
      await soon(savePending(), 10000); // what does not get saved, the first run asks again
      await loadFirstRun();
    }
    pushProfile();
    var invited = !!(session && session.user && session.user.user_metadata &&
      session.user.user_metadata.invited === true);
    /* THE DOCUMENTS, before anything of a tour is read and before the app
       is told the database is ready. Nothing below this block runs until
       whoever must agree has agreed and that is saved.
       needs: the facts say the documents are owed, or a sign-up's agreement
         could not be saved. blind: the facts could not be read at all.
       Someone invited to a tour (needs or blind): waits here, recorded with
         via 'invite'. Their own questions (passwordGate) come after, over an
         app that is only started once they have agreed.
       A brand-new account (needs or blind): waits here too. With the facts
         unread it must not walk in with nothing agreed; the documents' own
         status is asked, and it passes at once when the account has already
         agreed or no documents are loaded. Brand new: made within the last
         day, or its address proved within the last day (a sign-up that sat
         longer than that before its emailed code was typed is just as new).
       Someone already in (an account that finished its first run; with the
         facts unread, one older than a day): asked once, and again whenever
         a document changes, but never kept out by a weak signal: when the
         facts or the documents cannot be read they carry on, and the next
         start (or the next return to the app) asks. An agreement of theirs
         that is still waiting to be sent is not asked for twice. */
    var who = (session && session.user) || {};
    var born = Date.parse(who.created_at || ''), proved = Date.parse(who.email_confirmed_at || who.confirmed_at || '');
    var fresh = (!!born && Date.now() - born < 864e5) || (!!proved && Date.now() - proved < 864e5);
    // (Saved a moment ago: the server has just taken the current versions, so unread facts are no reason to ask twice.)
    var blind = !!firstFacts.unknown && sent !== 'saved';
    var needs = owed || firstFacts.needsLegal === true;
    // (What the pages say when they are back because of what was just tried: see legalSendHeld.)
    var said = sent === 'again' ? { again: true } : (sent === 'stale' || sent === 'owed-stale') ? { note: LEGAL_STALE } : {};
    if (invited) {
      if (needs || blind) await legalInside(true, 'invite', { again: !!said.again, note: said.note || '', blind: !needs });
    } else if (needs || (blind && fresh)) {
      var must = owed || firstFacts.onboarded === false || (blind && fresh);
      if (must || !legalHeldInside()) await legalInside(must, 'inside', { again: !!said.again, note: said.note || '', blind: !needs });
    }
    legalStarted = true;   // from here the return-from-background check may ask (see legalWake)
    if (invited) passwordGate(owed);
    else if (mustPassDue()) newPasswordGate(true);
    else if (resetting) newPasswordGate();
    try { await refetch(); } catch (e) { /* the app shows local mode */ }
    try { await importLocalTours(); } catch (e) { /* local copies stay put */ }
    sb.channel('greenroom')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tours' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tour_public' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'day_polls' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'day_votes' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'day_requests' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'flowers' }, flowersChanged)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'labels' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'guests' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notes' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ari_asks' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'feed_items' }, feedChanged)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dms' }, dmChanged)
      // The live line dropped and came back (a tunnel, a dead spot): what was
      // missed in between never comes down it, so ask again.
      .subscribe(function (status) {
        if (status !== 'SUBSCRIBED') return;
        if (liveOnce && session) { refetchTries = 0; scheduleRefetch(); feedChanged(); }
        liveOnce = true;
      });
    /* Asks to be paid back, heard as they happen (a new one, one marked paid);
       each phone only hears about the rows it may read. On a line of its own:
       the server sets up everything one line listens to in a single step, and
       refuses the lot when a table is not there to listen to. So with a build
       that is ahead of its migration this line stays quiet, and the tours,
       guests and notes above keep theirs. (When that line reconnects it reads
       everything again, these included.) */
    try {
      sb.channel('greenroom-reimbursements')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'reimbursements' }, scheduleRefetch)
        .subscribe();
    } catch (e) { /* the list is still read with everything else */ }
    resolvers.db(db);
    resolvers.user(user);
    resolvers.sample(sample);
  }

  boot().catch(function () {
    // Supabase unreachable: the app still works, saved on this device.
    resolvers.db(null); resolvers.user(null); resolvers.sample(null);
  });
})();
