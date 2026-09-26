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
  var session = null;
  var cache = { tours: new Map(), labels: new Map(), guests: [], notes: [] };
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

  async function refetch() {
    var tours = await sb.from('tours').select('id, owner_id, doc');
    if (tours.error) throw tours.error;
    cache.tours = new Map(tours.data.map(function (r) {
      var doc = isObj(r.doc) ? r.doc : {};
      doc._ownerId = r.owner_id; // lets the UI know whose tour this is
      return [r.id, doc];
    }));
    var labels = await sb.from('labels').select('id, doc');
    if (labels.error) throw labels.error;
    cache.labels = new Map(labels.data.map(function (r) { return [r.id, r.doc]; }));
    var guests = await sb.from('guests').select('*');
    cache.guests = guests.error ? cache.guests : guests.data;
    var notes = await sb.from('notes').select('*').order('created_at');
    cache.notes = notes.error ? cache.notes : notes.data;
    emit('tours'); emit('labels');
  }
  function scheduleRefetch() {
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(function () {
      refetch().catch(function () { /* next event tries again */ });
    }, 250);
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
          var q = table === 'tours'
            ? await sb.from('tours').insert({ id: id, doc: row.doc })
            : await sb.from('labels').upsert(row);
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
          var q = await sb.from(table)
            .update({ doc: stripped(next), updated_at: new Date().toISOString() })
            .eq('id', id)
            .select('id');
          if (q.error) throw mapError(q.error);
          if (!q.data || !q.data.length) throw err('permission'); // RLS said no
          cache[table].set(id, next);
          emit(table);
        },
        delete: async function () {
          var q = await sb.from(table).delete().eq('id', id).select('id');
          if (q.error) throw mapError(q.error);
          if (!q.data || !q.data.length) throw err('permission');
          cache[table].delete(id);
          emit(table);
        }
      };
    }
  };
  function mapError(e) {
    var msg = String(e && e.message || '');
    if (/permission|policy|denied|42501/i.test(msg)) return err('permission');
    if (/network|fetch/i.test(msg)) return err('unavailable');
    return err('unavailable');
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
      res = await fetch(cfg.url + '/functions/v1/read', {
        method: 'POST',
        signal: o.signal,
        headers: {
          'Content-Type': 'application/json',
          apikey: cfg.anonKey,
          Authorization: 'Bearer ' + (session ? session.access_token : cfg.anonKey)
        },
        body: JSON.stringify({
          prompt: prompt,
          images: images,
          tier: o.modelTier === 'quick' ? 'quick' : undefined
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
    email: function () { return session && session.user ? session.user.email : null; },
    username: function () {
      var m = session && session.user ? session.user.user_metadata : null;
      var n = m ? String(m.username || '').trim() : '';
      return n || null;
    },
    myProfile: function () {
      var m = (session && session.user && session.user.user_metadata) || {};
      return {
        fullName: String(m.full_name || '').trim(),
        username: String(m.username || '').trim(),
        phone: String(m.phone || '').trim(),
        email: session && session.user ? session.user.email : ''
      };
    },
    /* One card, two homes: the account metadata (so it follows you to any
       phone) and the profiles table (so the rest of the tour can read it). */
    saveProfile: async function (p) {
      var card = {
        full_name: String(p.fullName || '').trim().slice(0, 60),
        username: String(p.username || '').trim().slice(0, 24),
        phone: String(p.phone || '').trim().slice(0, 30)
      };
      var q = await sb.auth.updateUser({ data: card });
      if (q.error) throw mapError(q.error);
      if (q.data && q.data.user && session) session.user = q.data.user;
      await pushProfile();
    },
    /* The tour's phone book: everyone invited, plus the manager who owns it. */
    crew: async function (tourId) {
      var mq = await sb.from('members')
        .select('invited_email, role, user_id, display_name, phone')
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
          .select('user_id, full_name, username, email, phone').in('user_id', ids);
        (pq.data || []).forEach(function (x) { byId[x.user_id] = x; });
      }
      var out = [];
      if (ownerId) {
        var op = byId[ownerId] || {};
        out.push({
          owner: true, role: 'owner',
          name: op.full_name || '', username: op.username || '',
          email: op.email || (ownerId === (session && session.user && session.user.id) ? session.user.email : ''),
          phone: op.phone || '', joined: true
        });
      }
      rows.forEach(function (r) {
        var pr = byId[r.user_id] || {};
        out.push({
          owner: false, role: r.role,
          name: pr.full_name || r.display_name || '',
          username: pr.username || '',
          email: pr.email || r.invited_email,
          invitedEmail: r.invited_email,
          phone: pr.phone || r.phone || '',
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
    ownsTour: function (tourId) {
      var doc = cache.tours.get(tourId);
      return !!(doc && session && doc._ownerId === session.user.id);
    },
    members: async function (tourId) {
      var q = await sb.from('members').select('invited_email, role, user_id, display_name')
        .eq('tour_id', tourId).order('created_at');
      if (q.error) throw mapError(q.error);
      return q.data;
    },
    invite: async function (tourId, email, role, name, phone) {
      var addr = String(email).trim().toLowerCase();
      var q = await sb.from('members').upsert({
        tour_id: tourId,
        invited_email: addr,
        role: role === 'editor' ? 'editor' : 'viewer',
        display_name: String(name || '').trim().slice(0, 60),
        phone: String(phone || '').trim().slice(0, 30)
      });
      if (q.error) throw mapError(q.error);
      // The row alone is enough — an account made with this address claims it.
      // The edge function adds the nicety: the account and the invite email.
      try {
        var r = await fetch(cfg.url + '/functions/v1/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey,
            Authorization: 'Bearer ' + (session ? session.access_token : cfg.anonKey) },
          body: JSON.stringify({ tourId: tourId, email: addr, name: String(name || '').trim() })
        });
        var out = await r.json();
        return out && out.status ? out.status : 'nomail';
      } catch (e) { return 'nomail'; }
    },
    uninvite: async function (tourId, email) {
      var q = await sb.from('members').delete()
        .eq('tour_id', tourId).eq('invited_email', email);
      if (q.error) throw mapError(q.error);
    },
    uid: function () { return session && session.user ? session.user.id : null; },
    guestsFor: function (tourId, showId) {
      return cache.guests.filter(function (g) {
        return g.tour_id === tourId && g.show_id === showId;
      }).map(function (g) {
        return { id: g.id, firstName: g.first_name, lastName: g.last_name,
          affiliation: g.affiliation, email: g.email, phone: g.phone,
          qty: g.qty, passType: g.pass_type, addedBy: g.added_by };
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
    notify: function (tourId, type, data) {
      // fire and forget; the show must go on either way
      fetch(cfg.url + '/functions/v1/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey,
          Authorization: 'Bearer ' + (session ? session.access_token : cfg.anonKey) },
        body: JSON.stringify({ tourId: tourId, type: type, data: data || {} })
      }).catch(function () {});
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
    signOut: async function () {
      try { await sb.auth.signOut(); } catch (e) { /* going anyway */ }
      location.reload();
    }
  };

  /* ---------------- Auth gate ---------------- */

  /* Ordinary accounts: email + password, made right here in the app. No
     sign-in emails — on an iPhone, a home-screen app and Safari are separate
     worlds, so email links sign in the wrong one. Passwords don't care. */
  function gate() {
    var mode = 'signin';
    var wrap = document.createElement('div');
    wrap.id = 'gr-gate';
    document.body.appendChild(wrap);

    function render() {
      var signin = mode === 'signin';
      wrap.innerHTML =
        '<div class="gate-card">' +
        '<span class="logo-mark gate-mark" role="img" aria-label="Greenroom"></span>' +
        '<form id="gr-gate-form" novalidate>' +
        (signin ? '' :
          '<input class="input" type="text" id="gr-gate-full" placeholder="Full name" ' +
            'maxlength="60" autocomplete="name" aria-label="Full name">' +
          '<input class="input" type="text" id="gr-gate-name" placeholder="Username \u2014 what the tour sees" ' +
            'maxlength="24" autocomplete="nickname" aria-label="Username">') +
        '<input class="input" type="email" id="gr-gate-email" placeholder="you@band.com" autocomplete="email" inputmode="email" aria-label="Email">' +
        (signin ? '' :
          '<input class="input" type="tel" id="gr-gate-phone" placeholder="Phone number" ' +
            'maxlength="30" autocomplete="tel" inputmode="tel" aria-label="Phone number">') +
        '<input class="input" type="password" id="gr-gate-pass" placeholder="Password" ' +
          'autocomplete="' + (signin ? 'current-password' : 'new-password') + '" aria-label="Password">' +
        '<div class="gate-err" id="gr-gate-err" role="alert"></div>' +
        '<button class="btn primary block" type="submit">' +
          (signin ? 'Sign in' : 'Create account') + '</button>' +
        '</form>' +
        '<button class="linkbtn" id="gr-gate-flip" type="button">' +
          (signin ? 'New here? Create an account' : 'Already have an account? Sign in') + '</button>' +
        '<button class="linkbtn quiet" id="gr-gate-skip" type="button">Use it on this phone only</button>' +
        '</div>';

      var form = wrap.querySelector('#gr-gate-form');
      var emailI = wrap.querySelector('#gr-gate-email');
      var passI = wrap.querySelector('#gr-gate-pass');
      var errEl = wrap.querySelector('#gr-gate-err');
      var btn = form.querySelector('button');

      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        errEl.textContent = '';
        var email = String(emailI.value || '').trim();
        var pass = String(passI.value || '');
        var nameI = wrap.querySelector('#gr-gate-name');
        var fullI = wrap.querySelector('#gr-gate-full');
        var phoneI = wrap.querySelector('#gr-gate-phone');
        var uname = nameI ? String(nameI.value || '').trim() : '';
        var full = fullI ? String(fullI.value || '').trim() : '';
        var phone = phoneI ? String(phoneI.value || '').trim() : '';
        if (fullI && full.length < 2) { errEl.textContent = 'Type your full name.'; fullI.focus(); return; }
        if (nameI && uname.length < 2) { errEl.textContent = 'Pick a username \u2014 it\u2019s what the tour sees in chat.'; nameI.focus(); return; }
        if (phoneI && phone.replace(/\D/g, '').length < 7) { errEl.textContent = 'Type a phone number the tour can reach you on.'; phoneI.focus(); return; }
        if (email.indexOf('@') < 1) { errEl.textContent = 'Type your email address.'; emailI.focus(); return; }
        if (pass.length < 6) { errEl.textContent = 'Password needs at least 6 characters.'; passI.focus(); return; }
        btn.disabled = true;
        try {
          var res = signin
            ? await sb.auth.signInWithPassword({ email: email, password: pass })
            : await sb.auth.signUp({ email: email, password: pass, options: { data: {
                username: uname.slice(0, 24), full_name: full.slice(0, 60), phone: phone.slice(0, 30) } } });
          if (res.error) throw res.error;
          if (!res.data || !res.data.session) throw new Error('no session');
          // onAuthStateChange finishes the job
        } catch (e2) {
          btn.disabled = false;
          var msg = String(e2 && e2.message || '');
          if (/already registered/i.test(msg)) {
            errEl.textContent = 'That email already has an account — sign in instead.';
          } else if (/invalid login credentials/i.test(msg)) {
            errEl.textContent = signin
              ? 'Wrong email or password. New here? Tap “Create an account”.'
              : 'Couldn’t create the account. Try again.';
          } else if (/at least|password/i.test(msg)) {
            errEl.textContent = 'Pick a longer password (6 characters or more).';
          } else {
            errEl.textContent = 'Couldn’t reach the server. Check your connection and try again.';
          }
        }
      });
      wrap.querySelector('#gr-gate-flip').addEventListener('click', function () {
        mode = signin ? 'signup' : 'signin';
        render();
        wrap.querySelector('#gr-gate-email').focus();
      });
      wrap.querySelector('#gr-gate-skip').addEventListener('click', function () {
        wrap.remove();
        resolvers.db(null); resolvers.user(null); resolvers.sample(null);
      });
    }
    render();
    return wrap;
  }

  async function boot() {
    var mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    sb = mod.createClient(cfg.url, cfg.anonKey, {
      auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true }
    });
    var got = await sb.auth.getSession();
    session = got.data ? got.data.session : null;

    if (!session) {
      var g = gate();
      sb.auth.onAuthStateChange(function (_ev, s) {
        if (s && !session) { session = s; g.remove(); online(); }
      });
      return;
    }
    online();
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
     yet. One card: pick the password, then go add it to the home screen. */
  function passwordGate() {
    if (document.getElementById('gr-pass-gate')) return;
    var wrap = document.createElement('div');
    wrap.id = 'gr-pass-gate';
    wrap.className = 'gr-gate-like';
    var uname = (session.user.user_metadata && session.user.user_metadata.username) || '';
    wrap.innerHTML =
      '<div class="gate-card">' +
      '<span class="logo-mark gate-mark" role="img" aria-label="Greenroom"></span>' +
      '<p class="gate-hi">' + (uname ? 'Welcome, ' + uname + '. ' : '') +
        'You\u2019re on the tour \u2014 create a password so you can sign in anywhere.</p>' +
      '<form id="gr-pass-form" novalidate>' +
      '<input class="input" type="password" id="gr-pass-new" placeholder="Create a password" ' +
        'autocomplete="new-password" aria-label="Create a password">' +
      '<div class="gate-err" id="gr-pass-err" role="alert"></div>' +
      '<button class="btn primary block" type="submit">Save password</button>' +
      '</form></div>';
    document.body.appendChild(wrap);
    var form = wrap.querySelector('#gr-pass-form');
    var passI = wrap.querySelector('#gr-pass-new');
    var errEl = wrap.querySelector('#gr-pass-err');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var pass = String(passI.value || '');
      if (pass.length < 6) { errEl.textContent = 'Password needs at least 6 characters.'; passI.focus(); return; }
      form.querySelector('button').disabled = true;
      try {
        var meta = Object.assign({}, session.user.user_metadata || {}, { invited: false });
        var q = await sb.auth.updateUser({ password: pass, data: meta });
        if (q.error) throw q.error;
        if (q.data && q.data.user) session.user = q.data.user;
        wrap.querySelector('.gate-card').innerHTML =
          '<span class="logo-mark gate-mark" role="img" aria-label="Greenroom"></span>' +
          '<p class="gate-hi">Password saved. Put Greenroom on your home screen:</p>' +
          '<p class="gate-hi">Tap the Share button below, then \u201cAdd to Home Screen\u201d. ' +
          'Open it from there and sign in with your email and this password.</p>' +
          '<button class="btn primary block" id="gr-pass-done" type="button">Keep going here</button>';
        wrap.querySelector('#gr-pass-done').addEventListener('click', function () { wrap.remove(); });
      } catch (e2) {
        form.querySelector('button').disabled = false;
        errEl.textContent = 'Couldn\u2019t save it. Try again.';
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
        username: String(m.username || '').slice(0, 24),
        email: session.user.email || '',
        phone: String(m.phone || '').slice(0, 30),
        updated_at: new Date().toISOString()
      });
    } catch (e) { /* the phone book can wait for the next sign-in */ }
  }

  async function online() {
    try { await sb.rpc('claim_invites'); } catch (e) { /* nothing to claim */ }
    pushProfile();
    if (session && session.user && session.user.user_metadata &&
        session.user.user_metadata.invited === true) passwordGate();
    try { await refetch(); } catch (e) { /* the app shows local mode */ }
    try { await importLocalTours(); } catch (e) { /* local copies stay put */ }
    sb.channel('greenroom')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tours' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'labels' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'guests' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notes' }, scheduleRefetch)
      .subscribe();
    resolvers.db(db);
    resolvers.user(user);
    resolvers.sample(sample);
  }

  boot().catch(function () {
    // Supabase unreachable: the app still works, saved on this device.
    resolvers.db(null); resolvers.user(null); resolvers.sample(null);
  });
})();
