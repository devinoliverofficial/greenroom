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
    stats: [], rounds: [], gbVotes: [], asks: [] };
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
    // GA crew can't read a tour's money: the database hands them its own
    // copy of those tours, without it.
    var ga = await sb.from('tour_public').select('id, owner_id, doc');
    var full = {};
    tours.data.forEach(function (r) { full[r.id] = true; });
    var rows = tours.data.concat(ga.error ? [] : ga.data.filter(function (r) { return !full[r.id]; }));
    cache.tours = new Map(rows.map(function (r) {
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
    // The calendar: day-off polls, their votes, and show-day requests.
    var cal = await Promise.all([
      sb.from('day_polls').select('*'),
      sb.from('day_votes').select('*'),
      sb.from('day_requests').select('*').order('created_at')
    ]);
    if (!cal[0].error) cache.polls = cal[0].data;
    if (!cal[1].error) cache.votes = cal[1].data;
    if (!cal[2].error) cache.requests = cal[2].data;
    // Crew Stats and the game ball.
    var fun = await Promise.all([
      sb.from('crew_stats').select('*'),
      sb.from('game_ball_rounds').select('*').order('round'),
      sb.from('game_ball_votes').select('*')
    ]);
    if (!fun[0].error) cache.stats = fun[0].data;
    if (!fun[1].error) cache.rounds = fun[1].data;
    if (!fun[2].error) cache.gbVotes = fun[2].data;
    // Ari's questions to the tour manager (only they and ALL ACCESS see them).
    var asks = await sb.from('ari_asks').select('*').order('created_at');
    if (!asks.error) cache.asks = asks.data;
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
          var uq = sb.from(table)
            .update({ doc: stripped(next), updated_at: new Date().toISOString() })
            .eq('id', id);
          if (table === 'labels') uq = uq.eq('owner_id', session.user.id);
          var q = await uq.select('id');
          if (q.error) throw mapError(q.error);
          if (!q.data || !q.data.length) throw err('permission'); // RLS said no
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
      res = await fetch(cfg.url + '/functions/v1/' + name, Object.assign({}, init, { headers: headers }));
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
    /* The tour's phone book: everyone invited, plus the manager who owns it. */
    crew: async function (tourId) {
      var mq = await sb.from('members')
        .select('invited_email, role, user_id, display_name, phone, tour_role, overrides')
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
          owner: true, role: 'owner',
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
          owner: false, role: r.role,
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
      var q = await sb.from('members').select('role')
        .eq('tour_id', tourId).eq('user_id', session ? session.user.id : '').maybeSingle();
      return (q.data && q.data.role) || 'viewer';
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
      var q = await sb.from('members').upsert({
        tour_id: tourId,
        invited_email: addr,
        role: role === 'editor' ? 'editor' : 'viewer',
        display_name: String(name || '').trim().slice(0, 60),
        phone: String(phone || '').trim().slice(0, 30),
        tour_role: tourRole
      });
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
        .eq('tour_id', tourId).eq('invited_email', email);
      if (q.error) throw mapError(q.error);
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
      var q = await sb.from('day_requests').insert({ tour_id: tourId, date: date, body: String(body || '').trim().slice(0, 300) });
      if (q.error) throw mapError(q.error);
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
    /* Crew Stats. A person is 'owner' or 'e:' + their invite email. */
    statsFor: function (tourId) {
      return cache.stats.filter(function (x) { return x.tour_id === tourId; }).map(function (x) {
        return { id: x.id, person: x.person, stat: x.stat, day: x.day, mine: !!session && x.added_by === session.user.id, at: x.created_at };
      });
    },
    // Stats save fast: the row goes straight into what this phone knows,
    // without reloading everything (live updates bring everyone else's).
    addStat: async function (tourId, person, stat) {
      var q = await sb.from('crew_stats').insert({ tour_id: tourId, person: person, stat: stat }).select('*');
      if (q.error) throw mapError(q.error);
      var row = q.data && q.data[0];
      if (row && !cache.stats.some(function (x) { return x.id === row.id; })) cache.stats.push(row);
      return row ? row.id : null;
    },
    // Check yourself in on a day's sheet (the database knows who you are).
    checkIn: async function (tourId, date) {
      var q = await sb.rpc('check_in', { t_id: tourId, d: date });
      if (q.error) throw mapError(q.error);
      await refetch();
    },
    removeStat: async function (id) {
      var q = await sb.from('crew_stats').delete().eq('id', id).select('id');
      if (q.error) throw mapError(q.error);
      if (!q.data || !q.data.length) throw err('permission');
      cache.stats = cache.stats.filter(function (x) { return x.id !== id; });
    },
    gameBall: function (tourId) {
      return {
        rounds: cache.rounds.filter(function (g) { return g.tour_id === tourId; }).map(function (g) {
          return { round: g.round, opensAt: g.opens_at, closesAt: g.closes_at, status: g.status, winner: g.winner, reason: g.winner_reason };
        }),
        votes: cache.gbVotes.filter(function (v) { return v.tour_id === tourId; }).map(function (v) {
          return { round: v.round, voter: v.voter, voterName: v.voter_name, person: v.person, reason: v.reason, mine: !!session && v.voter === session.user.id };
        })
      };
    },
    voteGameBall: async function (tourId, round, person, reason) {
      var q = await sb.from('game_ball_votes').upsert({ tour_id: tourId, round: round, voter: session.user.id, person: person,
        reason: String(reason || '').trim().slice(0, 200) }, { onConflict: 'tour_id,round,voter' });
      if (q.error) throw mapError(q.error);
      await refetch();
    },
    // A tie: the tour manager makes the call.
    callGameBall: async function (tourId, round, person, reason) {
      var q = await sb.from('game_ball_rounds').update({ status: 'won', winner: person, winner_reason: reason || '' })
        .eq('tour_id', tourId).eq('round', round).select('round');
      if (q.error) throw mapError(q.error);
      if (!q.data || !q.data.length) throw err('permission');
      await refetch();
    },
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
      var r = await callFn('plaid', {
        method: 'POST',
        body: JSON.stringify(Object.assign({ action: action }, body || {}))
      });
      var out = {};
      try { out = await r.json(); } catch (e) { out = {}; }
      if (!r.ok && !out.error) out.error = 'unavailable';
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
      var items = await sb.from('feed_items').select('id, tour_id, date, merchant, amount, category, account, why')
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
        (signin ? '<button class="linkbtn quiet" id="gr-gate-forgot" type="button">Forgot password?</button>' +
          '<button class="linkbtn quiet" id="gr-gate-code-link" type="button">I have a code</button>' : '') +
        '<button class="linkbtn" id="gr-gate-flip" type="button">' +
          (signin ? 'New here? Create an account' : 'Already have an account? Sign in') + '</button>' +
        '<button class="linkbtn quiet" id="gr-gate-skip" type="button">Use it on this phone only</button>' +
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
    var mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    sbMod = mod;
    var link = readEmailLink();
    sb = mod.createClient(cfg.url, cfg.anonKey, {
      // processLock, not the browser's shared lock: on an iPhone the shared
      // one can stay held after the app sleeps, and every sign-in call behind
      // it (signing out, even starting up) waits forever.
      auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true,
        lock: mod.processLock || undefined }
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crew_stats' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_ball_rounds' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_ball_votes' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'labels' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'guests' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notes' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ari_asks' }, scheduleRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'feed_items' }, feedChanged)
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
