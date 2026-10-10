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
    asks: [], checkins: [] };
  // Flowers: each tour's crew and gifts, and your own, asked for when a page
  // shows them and kept until something changes.
  var flowerCache = {}, flowerAsk = {}, flowerGen = {}, myFlowerCache = null, myFlowerAsk = null, myFlowerGen = 0, flowerTimer = 0;
  var faceCache = {}, faceAsk = {};
  var FLOWERS_FRESH = 60e3; // asked again after a minute anyway: people join, phones sleep through changes
  var listeners = { tours: [], labels: [] };
  var refetchTimer = 0;

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
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
    // GA crew can't read a tour's money: the database hands them its own
    // copy of those tours, without it.
    var ga = await sb.from('tour_public').select('id, owner_id, doc');
    var full = {};
    tours.data.forEach(function (r) { full[r.id] = true; });
    var rows = tours.data.concat(ga.error ? [] : ga.data.filter(function (r) { return !full[r.id]; }));
    var before = cache.tours, stale = false;
    // The GA copies couldn't be read this time: keep the ones already here.
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
    // Ari's questions to the tour manager (only they and ALL ACCESS see them).
    var asks = await sb.from('ari_asks').select('*').order('created_at');
    if (!asks.error) cache.asks = asks.data;
    emit('tours'); emit('labels');
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
      var q = await sb.from('profiles').upsert({ user_id: session.user.id, handle: String(h || '').trim().toLowerCase() || null,
        updated_at: new Date().toISOString() });
      if (q.error) {
        if (q.error.code === '23505') { var taken = new Error('taken'); taken.code = 'taken'; throw taken; }
        if (q.error.code === '23514') { var bad = new Error('shape'); bad.code = 'shape'; throw bad; }
        throw mapError(q.error);
      }
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
    // Asking for a page nobody runs: who you are to the act, and where that can be checked.
    claimArtist: async function (artistId, note, link) {
      var q = await sb.rpc('claim_artist', { a_id: artistId, note: String(note || '').slice(0, 500), link: String(link || '').slice(0, 200) });
      if (q.error) {
        var m = String(q.error.message || '');
        if (/say who you are/i.test(m)) { var e1 = new Error('short'); e1.code = 'short'; throw e1; }
        if (/too many waiting/i.test(m)) { var e2 = new Error('too-many'); e2.code = 'too-many'; throw e2; }
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
    catalogIncome: async function (depId, opts) {
      var o = opts || {};
      var q = await sb.rpc('catalog_income', {
        dep_id: String(depId), t_id: o.tourId || null, s_id: o.showId || null, kind: String(o.kind || '') });
      if (q.error) throw mapError(q.error);
      var out = isObj(q.data) ? q.data : { ok: false };
      // The write landed inside the database; pull the books fresh so the
      // phone shows it without waiting on realtime.
      if (out.ok && o.tourId) { try { await refetch(); } catch (e) { /* realtime catches up */ } }
      return out;
    },
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
      if (q.error) throw mapError(q.error);
    },
    removeArtistMember: async function (id, userId) {
      var q = await sb.from('artist_members').delete().eq('artist_id', id).eq('user_id', userId);
      if (q.error) throw mapError(q.error);
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
        // then; and over both, whatever the tour manager or ALL ACCESS edited.
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
      // A band's Off Tour book: the database only hands it to ALL ACCESS.
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
       can post as Ari, and only for the tour manager or ALL ACCESS. */
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
      // A Manager is All Access with the manager mark (only the creator's mark sticks).
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
      // The door: the database only makes an account this address was sent
      // for, so the allowance goes first (24 hours, spent by the sign-up).
      var al = await sb.rpc('allow_signup', { addr: addr, note: tourRole });
      if (al.error) throw mapError(al.error);
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
    // The tour manager and ALL ACCESS: someone's role, contact info and
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
      if (q.error) throw mapError(q.error);
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
    // The tour manager (or ALL ACCESS) answers: 'accepted', 'denied', or back to 'pending'.
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
    feedMark: async function (ids, patch) {
      if (!ids.length) return;
      var q = await sb.from('feed_items').update(patch).in('id', ids).select('id');
      if (q.error) throw mapError(q.error);
      loadFeed(false);
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
      location.replace(appUrl());
    }
  };

  var dmListeners = [];
  function dmChanged() { dmListeners.forEach(function (fn) { try { fn(); } catch (e) { /* listener's problem */ } }); }
  var feedListeners = [];
  var feedTimer = 0;
  async function loadFeed(opening) {
    try {
      var f = await sb.from('feed').select('switched_on, plan_name, since, last_run, last_status, source').maybeSingle();
      if (f.error || !f.data) {
        // No feed yet: only accounts on the approved list get a Connect button.
        var ok = await sb.from('ynab_allowed').select('owner_id').maybeSingle();
        var none = (ok.error || !ok.data) ? null : { row: null, items: [], connectOnly: true };
        feedListeners.forEach(function (fn) { fn(none); });
        return;
      }
      var items = await sb.from('feed_items').select('id, tour_id, date, posted, seq, merchant, amount, category, account, why')
        .eq('status', 'waiting').order('date');
      var state = { row: f.data, items: items.error ? [] : items.data };
      feedListeners.forEach(function (fn) { try { fn(state); } catch (e) { /* listener's problem */ } });
      // Opening the app is the manager's cue that fresh charges matter now.
      var last = f.data.last_run ? Date.parse(f.data.last_run) : 0;
      if (opening && f.data.switched_on && Date.now() - last > 15 * 60e3) {
        window.GR_BACKEND.feedCall('sync').catch(function () { /* next open tries again */ });
      }
    } catch (e) { /* the feed is a convenience, never a blocker */ }
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
    clearTimeout(feedTimer);
    feedTimer = setTimeout(function () { loadFeed(false); }, 300);
  }

  /* ---------------- Auth gate ---------------- */

  /* Ordinary accounts: email + password, made right here in the app. No
     sign-in emails — on an iPhone, a home-screen app and Safari are separate
     worlds, so email links sign in the wrong one. Passwords don't care. */
  /* What someone does on the run. A job title for the crew list — never an
     access level; GA / ALL ACCESS are the tour manager's to hand out. */
  var TOUR_ROLES = ['Artist', 'Band', 'Tour Manager', 'Production Manager',
    'Stage Manager', 'Merch', 'Guitar Tech', 'Drum Tech', 'Assistant',
    'FOH Engineer', 'Monitors', 'Friend', 'Family Member', 'Liaison', 'Dancer'];
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
  function openRolePicker(current, onPick) {
    var ov = document.createElement('div');
    ov.className = 'role-picker';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-label', 'Your role on the tour');
    ov.innerHTML = '<div class="rp-card"><div class="rp-head">Your role on the tour</div>' +
      '<div class="rp-list" role="listbox">' + TOUR_ROLES.map(function (r) {
        return '<button type="button" role="option" class="rp-opt' + (r === current ? ' on' : '') +
          '" data-r="' + esc(r) + '" aria-selected="' + (r === current) + '">' + esc(r) + '</button>';
      }).join('') + '</div></div>';
    ov.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.rp-opt') : null;
      if (b) { onPick(b.getAttribute('data-r')); ov.remove(); return; }
      if (e.target === ov) ov.remove();   // tap outside the card to back out
    });
    document.body.appendChild(ov);
    var on = ov.querySelector('.rp-opt.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'center' });
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

  function gate(note, code) {
    // From an email's button: straight to the code, already filled in.
    var mode = code ? 'code' : 'signin';
    var wrap = document.createElement('div');
    wrap.id = 'gr-gate';
    document.body.appendChild(wrap);

    /* "I have a code": the emails carry a code as well as a button, because
       an iPhone always opens email links in Safari, never in the home-screen
       app. Typing the code here signs in without leaving the app. The code
       could be from an invite, a password reset or a sign-in email, so each
       kind is tried in turn. */
    function renderCode() {
      wrap.innerHTML =
        '<div class="gate-card">' +
        '<span class="logo-mark gate-mark" role="img" aria-label="Greenroom"></span>' +
        '<form id="gr-code-form" novalidate>' +
        '<input class="input" type="email" id="gr-gate-email" placeholder="Your email address" ' +
          'autocomplete="email" inputmode="email" aria-label="Email">' +
        '<div class="gate-codewrap">' +
        '<input class="input gate-code" type="text" id="gr-gate-code" placeholder="Code" ' +
          'autocomplete="one-time-code" inputmode="numeric" maxlength="12" aria-label="Code from the email">' +
        '<button class="btn quiet gate-paste" id="gr-code-paste" type="button">Paste</button>' +
        '</div>' +
        '<div class="gate-err" id="gr-gate-err" role="alert"></div>' +
        '<button class="btn primary block" type="submit">Continue</button>' +
        '</form>' +
        '<button class="linkbtn" id="gr-code-back" type="button">Back to sign in</button>' +
        '</div>';
      var form = wrap.querySelector('#gr-code-form');
      var emailI = wrap.querySelector('#gr-gate-email');
      var codeI = wrap.querySelector('#gr-gate-code');
      var errEl = wrap.querySelector('#gr-gate-err');
      var btn = form.querySelector('button');
      if (code) codeI.value = code;
      // Copied the code from the email? One tap puts it in.
      wrap.querySelector('#gr-code-paste').addEventListener('click', async function () {
        try {
          var got = String(await navigator.clipboard.readText() || '').replace(/\D/g, '');
          if (got.length >= 6) { codeI.value = got; errEl.textContent = ''; return; }
          errEl.textContent = 'Nothing to paste yet. In the email, press and hold the code and tap Copy.';
        } catch (e) {
          codeI.focus();
          errEl.textContent = 'Press and hold in the code box and tap Paste.';
        }
      });
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var email = String(emailI.value || '').trim();
        var code = String(codeI.value || '').replace(/\D/g, '');
        // The code typed into the email box: move it where it goes, ask for the email.
        if (email.indexOf('@') < 0 && /^[\d\s]{6,}$/.test(email)) {
          if (!code) codeI.value = email.replace(/\D/g, '');
          emailI.value = '';
          errEl.textContent = 'That\u2019s the code \u2014 it\u2019s in the second box now. Type your email address in the first box.';
          emailI.focus();
          return;
        }
        if (email.indexOf('@') < 1) { errEl.textContent = 'Type your email address in the first box.'; emailI.focus(); return; }
        if (code.length < 6) { errEl.textContent = 'Type the code from the email.'; codeI.focus(); return; }
        btn.disabled = true;
        errEl.textContent = 'Checking\u2026';
        var kinds = ['invite', 'recovery', 'email', 'signup'];
        var ok = false;
        for (var i = 0; i < kinds.length && !ok; i++) {
          // Set before the check: signing in runs the rest of the start-up
          // straight away, and a reset code should land on "new password".
          resetting = kinds[i] === 'recovery';
          try {
            var r = await sb.auth.verifyOtp({ email: email, token: code, type: kinds[i] });
            ok = !r.error && !!(r.data && r.data.session);
          } catch (e2) { ok = false; }
        }
        if (ok) return; // signed in: the start-up takes it from here
        resetting = false;
        btn.disabled = false;
        errEl.textContent = 'That code didn\u2019t work. Codes last an hour and work once. Tap \u201cBack to sign in\u201d, then \u201cForgot password?\u201d for a fresh one.';
      });
      wrap.querySelector('#gr-code-back').addEventListener('click', function () { mode = 'signin'; render(); });
      emailI.focus();
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
        '<input class="input" type="email" id="gr-gate-email" placeholder="' + (signin ? 'you@band.com' : 'Email') +
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
        // Invite-only: there is no sign-up here. The database refuses any
        // account that nobody who runs a tour has sent for (signup_gate).
        '<p class="gate-note">Greenroom is invite-only. Your tour manager sends the invite; the code in it gets you in.</p>' +
        '</div>';

      var form = wrap.querySelector('#gr-gate-form');
      wireRolePicker(wrap, 'gr-gate-role');
      var emailI = wrap.querySelector('#gr-gate-email');
      var passI = wrap.querySelector('#gr-gate-pass');
      var errEl = wrap.querySelector('#gr-gate-err');
      var btn = form.querySelector('button');
      if (note) { errEl.textContent = note; note = ''; }

      // Email a link to set a password. Works for a forgotten password and for
      // anyone invited who never got to pick one.
      async function emailLink() {
        var email = String(emailI.value || '').trim();
        if (email.indexOf('@') < 1) { errEl.textContent = 'Type your email above, then tap it again.'; emailI.focus(); return; }
        errEl.textContent = 'Sending\u2026';
        try {
          await sendPasswordLink(email);
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
          var res = signin
            ? await sb.auth.signInWithPassword({ email: email, password: pass })
            : await sb.auth.signUp({ email: email, password: pass, options: { data: {
                first_name: first.slice(0, 30), last_name: last.slice(0, 30),
                full_name: (first + ' ' + last).slice(0, 60),
                username: (first + ' ' + last).slice(0, 40),
                phone: phone.slice(0, 30), tour_role: tourRole } } });
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
    var mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm');
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
        if (session) { refetchTries = 0; scheduleRefetch(); } // nor did anyone's changes to the tours
        newBuildCheck();
      } else if (refetchOwed && session) { refetchTries = 0; scheduleRefetch(); }
      hiddenAt = 0;
    });
    window.addEventListener('online', function () { flushErrors(); if (session) { refetchTries = 0; scheduleRefetch(); } });
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

  /* Someone arriving from an invite email is signed in but has no password
     yet. One card: pick the password and go. */
  /* Invited crew land here from the email. The tour manager already typed
     their name, role and access, so all that's left is a username (what the
     chat calls them) and a password. Anything the invite didn't carry (an
     older invite) is asked for here too, so the card is never left short. */
  function passwordGate() {
    if (document.getElementById('gr-pass-gate')) return;
    var wrap = document.createElement('div');
    wrap.id = 'gr-pass-gate';
    wrap.className = 'gr-gate-like';
    var m0 = session.user.user_metadata || {};
    var typed = String(m0.full_name || m0.username || '').trim();
    var first0 = String(m0.first_name || typed.split(/\s+/)[0] || '').trim();
    var last0 = String(m0.last_name || typed.split(/\s+/).slice(1).join(' ') || '').trim();
    var needName = !first0 || !last0;
    var needRole = !m0.tour_role;
    var tourName = String(m0.tour_name || '').trim();
    var access = m0.access === 'editor' ? 'ALL ACCESS' : (m0.access === 'viewer' ? 'GA' : '');
    var who = [roleName(m0.tour_role), access].filter(Boolean).join(' \u00b7 ');
    wrap.innerHTML =
      '<div class="gate-card">' +
      '<span class="logo-mark gate-mark" role="img" aria-label="Greenroom"></span>' +
      '<p class="gate-hi">' + (first0 ? 'Welcome, ' + esc(first0) + '.' : 'Welcome.') +
        (tourName ? ' You\u2019re on ' + esc(tourName) + '.' : ' You\u2019re on the tour.') + '</p>' +
      (who ? '<p class="gate-who">' + esc(who) + '</p>' : '') +
      '<p class="gate-hi quiet">Make a username and a password and you\u2019re in.</p>' +
      '<form id="gr-pass-form" novalidate>' +
      (needName ? '<div class="gate-pair">' +
        '<input class="input" type="text" id="gr-pass-first" placeholder="First name" value="' + esc(first0) + '" ' +
          'maxlength="30" autocomplete="given-name" aria-label="First name">' +
        '<input class="input" type="text" id="gr-pass-last" placeholder="Last name" value="' + esc(last0) + '" ' +
          'maxlength="30" autocomplete="family-name" aria-label="Last name">' +
        '</div>' : '') +
      (needRole ? rolePickerHtml('gr-pass-role', '') : '') +
      '<input class="input" type="text" id="gr-pass-user" placeholder="Username" ' +
        'maxlength="24" autocomplete="username" autocapitalize="none" aria-label="Username">' +
      '<input class="input" type="password" id="gr-pass-new" placeholder="Password" ' +
        'autocomplete="new-password" aria-label="Password">' +
      '<div class="gate-err" id="gr-pass-err" role="alert"></div>' +
      '<button class="btn primary block" type="submit">Join the tour</button>' +
      '</form></div>';
    document.body.appendChild(wrap);
    var form = wrap.querySelector('#gr-pass-form');
    if (needRole) wireRolePicker(wrap, 'gr-pass-role');
    var userI = wrap.querySelector('#gr-pass-user');
    var passI = wrap.querySelector('#gr-pass-new');
    var errEl = wrap.querySelector('#gr-pass-err');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var fI = wrap.querySelector('#gr-pass-first'), lI = wrap.querySelector('#gr-pass-last');
      var rI = wrap.querySelector('#gr-pass-role');
      var first = fI ? String(fI.value || '').trim() : first0;
      var last = lI ? String(lI.value || '').trim() : last0;
      var tourRole = rI ? String(rI.value || '') : roleName(m0.tour_role);
      var uname = String(userI.value || '').trim();
      var pass = String(passI.value || '');
      if (fI && !first) { errEl.textContent = 'Type your first name.'; fI.focus(); return; }
      if (lI && !last) { errEl.textContent = 'Type your last name.'; lI.focus(); return; }
      if (rI && !tourRole) { errEl.textContent = 'Pick your role on the tour.'; wrap.querySelector('#gr-pass-role-btn').focus(); return; }
      if (!uname) { errEl.textContent = 'Pick a username. It\u2019s what the chat calls you.'; userI.focus(); return; }
      if (pass.length < 6) { errEl.textContent = 'Password needs at least 6 characters.'; passI.focus(); return; }
      form.querySelector('button').disabled = true;
      try {
        var full = (first + ' ' + last).trim();
        var meta = Object.assign({}, m0, {
          invited: false, first_name: first.slice(0, 30), last_name: last.slice(0, 30),
          full_name: full.slice(0, 60), username: uname.slice(0, 24),
          phone: String(m0.phone || '').slice(0, 30), tour_role: tourRole });
        var q = await sb.auth.updateUser({ password: pass, data: meta });
        if (q.error) throw q.error;
        if (q.data && q.data.user) session.user = q.data.user;
        pushProfile();
        wrap.querySelector('.gate-card').innerHTML =
          '<span class="logo-mark gate-mark" role="img" aria-label="Greenroom"></span>' +
          '<p class="gate-hi">You\u2019re in.</p>' +
          '<button class="btn primary block" id="gr-pass-done" type="button">Let\u2019s go</button>';
        wrap.querySelector('#gr-pass-done').addEventListener('click', function () { wrap.remove(); });
      } catch (e2) {
        form.querySelector('button').disabled = false;
        errEl.textContent = 'Couldn\u2019t save it. Try again.';
      }
    });
  }

  /* A reset link: signed in by the link, now pick the new password. */
  function newPasswordGate() {
    resetting = false;
    if (document.getElementById('gr-pass-gate')) return;
    var wrap = document.createElement('div');
    wrap.id = 'gr-pass-gate';
    wrap.className = 'gr-gate-like';
    wrap.innerHTML =
      '<div class="gate-card">' +
      '<span class="logo-mark gate-mark" role="img" aria-label="Greenroom"></span>' +
      '<p class="gate-hi">Pick a new password.</p>' +
      '<form id="gr-pass-form" novalidate>' +
      '<input class="input" type="password" id="gr-pass-new" placeholder="New password" ' +
        'autocomplete="new-password" aria-label="New password">' +
      '<div class="gate-err" id="gr-pass-err" role="alert"></div>' +
      '<button class="btn primary block" type="submit">Save</button>' +
      '</form>' +
      '<button class="linkbtn quiet" id="gr-pass-keep" type="button">Keep my current password</button>' +
      '</div>';
    document.body.appendChild(wrap);
    wrap.querySelector('#gr-pass-keep').addEventListener('click', function () { wrap.remove(); });
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
        wrap.querySelector('.gate-card').innerHTML =
          '<span class="logo-mark gate-mark" role="img" aria-label="Greenroom"></span>' +
          '<p class="gate-hi">Password saved.</p>' +
          '<button class="btn primary block" id="gr-pass-done" type="button">Keep going</button>';
        wrap.querySelector('#gr-pass-done').addEventListener('click', function () { wrap.remove(); });
      } catch (e2) {
        form.querySelector('button').disabled = false;
        errEl.textContent = /different from the old/i.test(String(e2 && e2.message || ''))
          ? 'That\u2019s the password you already had. Pick a new one, or just keep going.'
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

  async function online() {
    try { await sb.rpc('claim_invites'); } catch (e) { /* nothing to claim */ }
    pushProfile();
    if (session && session.user && session.user.user_metadata &&
        session.user.user_metadata.invited === true) passwordGate();
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
        if (liveOnce && session) { refetchTries = 0; scheduleRefetch(); }
        liveOnce = true;
      });
    resolvers.db(db);
    resolvers.user(user);
    resolvers.sample(sample);
  }

  boot().catch(function () {
    // Supabase unreachable: the app still works, saved on this device.
    resolvers.db(null); resolvers.user(null); resolvers.sample(null);
  });
})();
