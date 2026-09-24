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
  var cache = { tours: new Map(), labels: new Map() };
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
    ownsTour: function (tourId) {
      var doc = cache.tours.get(tourId);
      return !!(doc && session && doc._ownerId === session.user.id);
    },
    members: async function (tourId) {
      var q = await sb.from('members').select('invited_email, role, user_id')
        .eq('tour_id', tourId).order('created_at');
      if (q.error) throw mapError(q.error);
      return q.data;
    },
    invite: async function (tourId, email, role) {
      var q = await sb.from('members').upsert({
        tour_id: tourId,
        invited_email: String(email).trim().toLowerCase(),
        role: role === 'editor' ? 'editor' : 'viewer'
      });
      if (q.error) throw mapError(q.error);
      // A magic link lands in their inbox; opening it signs them straight in.
      try {
        await sb.auth.signInWithOtp({
          email: String(email).trim().toLowerCase(),
          options: { emailRedirectTo: location.origin + location.pathname }
        });
      } catch (e) { /* the invite row alone still works next time they sign in */ }
    },
    uninvite: async function (tourId, email) {
      var q = await sb.from('members').delete()
        .eq('tour_id', tourId).eq('invited_email', email);
      if (q.error) throw mapError(q.error);
    },
    signOut: async function () {
      try { await sb.auth.signOut(); } catch (e) { /* going anyway */ }
      location.reload();
    }
  };

  /* ---------------- Auth gate ---------------- */

  function gate() {
    var wrap = document.createElement('div');
    wrap.id = 'gr-gate';
    wrap.innerHTML =
      '<div class="gate-card">' +
      '<span class="logo-mark" style="width:76px;height:60px"></span>' +
      '<h2>Sign in to Greenroom</h2>' +
      '<p>Type your email and we’ll send you a sign-in link. No password to remember.</p>' +
      '<form id="gr-gate-form" novalidate>' +
      '<input class="input" type="email" id="gr-gate-email" placeholder="you@band.com" autocomplete="email" inputmode="email">' +
      '<button class="btn primary block" type="submit">Email me a sign-in link</button>' +
      '</form>' +
      '<button class="linkbtn" id="gr-gate-skip" type="button">Use it on this phone only</button>' +
      '</div>';
    document.body.appendChild(wrap);
    var form = wrap.querySelector('#gr-gate-form');
    var input = wrap.querySelector('#gr-gate-email');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = String(input.value || '').trim();
      if (!email || email.indexOf('@') < 0) { input.focus(); return; }
      form.querySelector('button').disabled = true;
      try {
        await sb.auth.signInWithOtp({
          email: email,
          options: { emailRedirectTo: location.origin + location.pathname }
        });
        wrap.querySelector('.gate-card').innerHTML =
          '<span class="logo-mark" style="width:76px;height:60px"></span>' +
          '<h2>Check your email</h2>' +
          '<p>We sent a sign-in link to <b>' + email.replace(/</g, '&lt;') +
          '</b>. Open it on this phone and you’ll land right back here, signed in.</p>';
      } catch (e2) {
        form.querySelector('button').disabled = false;
        alert('Couldn’t send the link. Check the address and try again.');
      }
    });
    wrap.querySelector('#gr-gate-skip').addEventListener('click', function () {
      wrap.remove();
      resolvers.db(null); resolvers.user(null); resolvers.sample(null);
    });
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

  async function online() {
    try { await sb.rpc('claim_invites'); } catch (e) { /* nothing to claim */ }
    try { await refetch(); } catch (e) { /* the app shows local mode */ }
    sb.channel('greenroom')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tours' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'labels' }, scheduleRefetch)
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
