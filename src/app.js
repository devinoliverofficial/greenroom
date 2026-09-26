/* Greenroom UI. Depends on core.js (globalThis.GR). */
(function () {
  'use strict';

  var G = globalThis.GR;
  var LS_DATA = 'greenroom:v1';
  var LS_LAST = 'greenroom:last';
  var LS_LABELS = 'greenroom:labels';
  // Each skin (the main app and Greenroom Classic) remembers its own choice.
  var LS_THEME = 'greenroom:theme' + (window.GR_SKIN ? ':' + window.GR_SKIN : '');
  var TABS = [['shows', 'Shows'], ['add', 'Add more shows']];
  var VIEW_ONLY = 'You have view-only access, so changes can’t be saved.';

  var S = {
    roles: {}, rolesAsked: {},
    mode: 'loading', loaded: false, tours: new Map(), pending: {},
    role: null, writeRefused: false, dbError: null,
    route: { name: 'home' }, drafts: {}, lastNet: {}, lastState: {},
    restored: false, pendingRender: false, focusOnRender: false,
    io: null, scrub: null, runningLed: null,
    labels: {}, sample: null, imageTypes: [], imageMax: 0
  };
  var store = { db: null, local: null, lsOk: true, queues: {}, retries: 0, unsub: null, unsubLabels: null };

  function canWrite() { return !S.writeRefused && S.role !== 'viewer'; }
  function isOwner() { return S.role === 'owner'; }

  /* ============================== Small helpers ============================== */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function reduced() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function clone(v) {
    return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
  }
  function deepMerge(target, patch) {
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (G.isObj(v) && G.isObj(target[k])) target[k] = deepMerge(target[k], v);
      else target[k] = G.isObj(v) ? clone(v) : v;
    });
    return target;
  }
  function newId() {
    var r = '';
    try {
      var a = new Uint8Array(8);
      crypto.getRandomValues(a);
      r = Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join('');
    } catch (e) { r = Math.random().toString(36).slice(2, 10); }
    return Date.now().toString(36) + r;
  }
  function blurActive() {
    var a = document.activeElement;
    if (a && a !== document.body && typeof a.blur === 'function') a.blur();
  }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }

  var F = {
    long: new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
    md: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }),
    mon: new Intl.DateTimeFormat('en-US', { month: 'short' }),
    wd: new Intl.DateTimeFormat('en-US', { weekday: 'short' })
  };
  function dayLong(s) { var d = G.parseDay(s); return d ? F.long.format(d) : String(s || ''); }
  function dayMD(s) { var d = G.parseDay(s); return d ? F.md.format(d) : String(s || ''); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function fmtInput(n) {
    return n ? (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '';
  }
  var money = G.money;
  function getTour(id) { return (id && (S.tours.get(id) || S.pending[id])) || null; }

  /* ============================== DOM ============================== */

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'value') el.value = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    var kids = Array.prototype.slice.call(arguments, 2);
    flatten(kids).forEach(function (kid) {
      if (kid == null || kid === false || kid === true) return;
      el.append(kid instanceof Node ? kid : String(kid));
    });
    return el;
  }
  function flatten(list) {
    return list.reduce(function (out, v) {
      return out.concat(Array.isArray(v) ? flatten(v) : [v]);
    }, []);
  }

  var ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    /* the five tabs along the bottom */
    tabsheet: '<path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5"/><path d="M9 12h7M9 16h5"/>',
    tabmoney: '<path d="M12 3v18"/><path d="M16.5 7.5c0-1.7-2-2.5-4.5-2.5S7.5 5.8 7.5 7.5 9.5 10 12 10s4.5.8 4.5 2.5S14.5 15 12 15s-4.5-.8-4.5-2.5"/>',
    tabmap: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
    tabguest: '<circle cx="9" cy="8" r="3.4"/><path d="M3.5 20c.6-3.4 2.9-5.2 5.5-5.2s4.9 1.8 5.5 5.2"/><path d="M17 9h5M19.5 6.5v5"/>',
    tabcost: '<path d="M4 20V10M10 20V5M16 20v-7M22 20H2"/>',
    tabchat: '<path d="M21 11.5c0 3.6-4 6.5-9 6.5-1.1 0-2.1-.13-3-.37L4 20l1.5-3.4C4.1 15.4 3 13.6 3 11.5 3 7.9 7 5 12 5s9 2.9 9 6.5z"/>',
    bell: '<path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16l-2-3z"/><path d="M10.5 21a2.2 2.2 0 0 0 3 0"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    phone: '<path d="M6.5 3h3l1.5 4-2 1.5a12 12 0 0 0 5.5 5.5l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.2 2 2 0 0 1 6.5 3z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    chevron: '<path d="M9 5l7 7-7 7"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    more: '<circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none"/>',
    flyer: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    people: '<circle cx="9" cy="8" r="3.4"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M19 8v6M16 11h6"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
    share: '<path d="M12 16V4M8 8l4-4 4 4"/><path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"/>',
    card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/>',
    tag: '<path d="M3 12.5V4a1 1 0 0 1 1-1h8.5L21 11.5 12.5 20 3 12.5z"/><circle cx="7.5" cy="7.5" r="1.3" fill="currentColor" stroke="none"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4"/><path d="M12 8v4.5l3 1.8"/>'
  };
  function icon(name, size) {
    var s = size || 22;
    var span = document.createElement('span');
    span.className = 'ic';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' +
      (ICONS[name] || '') + '</svg>';
    return span;
  }

  function moneyInput(o) {
    var clampV = function (v) { return o.pct ? Math.min(v, 100) : v; };
    var input = h('input', {
      id: o.id, 'data-k': o.key || o.id, type: 'text', inputmode: 'decimal', autocomplete: 'off',
      enterkeyhint: o.last ? 'done' : 'next', 'aria-label': o.label,
      placeholder: o.placeholder || '0', value: o.value ? fmtInput(o.value) : '',
      oninput: function (e) { o.onValue(clampV(G.num(e.target.value))); },
      onblur: function (e) { e.target.value = fmtInput(clampV(G.num(e.target.value))); },
      onkeydown: function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var nx = o.nextId && document.getElementById(o.nextId);
        if (nx) nx.focus(); else advance(e.target);
      }
    });
    return h('div', { class: 'money-in' + (o.big ? ' big' : '') + (o.slim ? ' slim' : '') },
      o.pct ? null : h('span', { class: 'cur', 'aria-hidden': 'true' }, '$'),
      input,
      o.pct ? h('span', { class: 'cur', 'aria-hidden': 'true' }, '%') : null);
  }

  // Enter walks to the next field, and submits on the last one.
  function advance(el) {
    var scope = el.closest('form') || el.closest('.sheet') || el.closest('.page') || document;
    var list = Array.prototype.filter.call(
      scope.querySelectorAll('input[type=text], input[type=date], select, textarea'),
      function (i) { return !i.disabled && !i.readOnly && i.offsetParent !== null; });
    var i = list.indexOf(el);
    if (i >= 0 && i < list.length - 1) { list[i + 1].focus(); return; }
    var form = el.closest('form');
    if (form) submitForm(form); else el.blur();
  }
  function submitForm(form) {
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else { var b = form.querySelector('[type=submit]'); if (b) b.click(); }
  }

  function segmented(options, index, onChange, label) {
    var wrap = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
    options.forEach(function (opt, i) {
      wrap.append(h('button', {
        type: 'button', class: 'seg-b', role: 'radio', 'aria-checked': String(i === index),
        onclick: function () {
          Array.prototype.forEach.call(wrap.children, function (b, j) {
            b.setAttribute('aria-checked', String(j === i));
          });
          onChange(i);
        }
      }, opt));
    });
    return wrap;
  }

  function chipRow(options, current, onPick) {
    var wrap = h('div', { class: 'chips' });
    wrap.sync = function (val) {
      Array.prototype.forEach.call(wrap.children, function (b) {
        b.setAttribute('aria-pressed', String(b.textContent === val));
      });
    };
    options.forEach(function (o) {
      wrap.append(h('button', {
        type: 'button', class: 'chip', 'aria-pressed': String(o === current),
        onclick: function () { onPick(o); wrap.sync(o); }
      }, o));
    });
    return wrap;
  }

  function field(label, control, hint) {
    return h('label', { class: 'field' },
      h('span', { class: 'field-label' }, label), control,
      hint ? h('span', { class: 'hint' }, hint) : null);
  }
  function emptyState(title, body) {
    return h('div', { class: 'empty' }, h('h3', null, title), body ? h('p', null, body) : null);
  }
  function backBtn(tour) {
    var artist = tour ? String(tour.artist || '').trim() : '';
    if (artist) {
      return h('button', { class: 'iconbtn back', type: 'button',
        onclick: function () { go({ name: 'artist', artist: artist }); } },
        icon('back'), h('span', null, artist.length > 14 ? 'Tours' : artist));
    }
    return h('button', { class: 'iconbtn back', type: 'button', onclick: function () { go({ name: 'home' }); } },
      icon('back'), h('span', null, 'Tours'));
  }
  function dbBanner() {
    if (!S.dbError) return null;
    return h('div', { class: 'banner' }, h('span', null,
      S.dbError === 'revoked'
        ? 'Live updates have stopped. Your access may have changed.'
        : 'Live updates stopped. Reload the page to reconnect.'));
  }

  /* ============================== Storage ============================== */

  async function initStore() {
    var db = null;
    var c = window.claude;
    if (c && typeof c.use === 'function') {
      try { db = await c.use('db'); } catch (e) { db = null; }
    }
    if (db) { store.db = db; S.mode = 'db'; subscribe(); subscribeLabels(); }
    else { S.mode = 'local'; S.role = S.role || 'owner'; loadLocal(); loadLocalLabels(); dataArrived(); }
  }

  /* Merchant labels are remembered across every tour, and anyone with edit
     access adds to the same pile. */
  function subscribeLabels() {
    if (store.unsubLabels) { try { store.unsubLabels(); } catch (e) { /* already closed */ } }
    store.unsubLabels = store.db.collection('labels').onSnapshot(function (snap) {
      var m = {};
      snap.docs.forEach(function (d) {
        if (!d.exists) return;
        var v = d.data();
        if (G.isObj(v) && (G.isObj(v.cats) || v.kind === 'crew' || v.kind === 'artistLogo' || v.kind === 'artist')) m[d.id] = v;
      });
      S.labels = m;
      if (S.loaded) render();
    }, function () { /* labels are a convenience; failing to read them is survivable */ });
  }
  function loadLocalLabels() {
    try { S.labels = JSON.parse(lsGet(LS_LABELS) || '{}') || {}; } catch (e) { S.labels = {}; }
  }
  function saveLocalLabels() { lsSet(LS_LABELS, JSON.stringify(S.labels)); }

  async function writeLabel(merchant, category) {
    var key = GRS.normMerchant(merchant);
    if (!key || !category) return;
    var next = GRS.learnLabel(JSON.parse(JSON.stringify(S.labels)), merchant, category);
    S.labels = next;
    if (S.mode === 'db') {
      try { await store.db.doc('labels/' + key).set(next[key]); } catch (e) { /* not fatal */ }
    } else saveLocalLabels();
  }
  /* Saved crew: the roster that follows you from tour to tour. It rides the
     same shared labels store, filed under crew: keys. */
  function rosterList() {
    return Object.keys(S.labels)
      .filter(function (k) { return k.indexOf('crew:') === 0 && S.labels[k] && S.labels[k].kind === 'crew'; })
      .map(function (k) { return S.labels[k]; })
      .sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
  }
  function rosterHas(name) { return !!S.labels[G.crewKey(name)]; }
  async function rosterSave(person) {
    var key = G.crewKey(person.name);
    if (key === 'crew:') return;
    var rec = { kind: 'crew', name: person.name, title: person.title || '', pay: G.num(person.pay) };
    S.labels[key] = rec;
    if (S.mode === 'db' && store.db) {
      try { await store.db.doc('labels/' + key).set(rec); } catch (e) { /* roster is a convenience */ }
    } else saveLocalLabels();
  }
  async function rosterRemove(name) {
    var key = G.crewKey(name);
    delete S.labels[key];
    if (S.mode === 'db' && store.db) {
      try { await store.db.doc('labels/' + key).delete(); } catch (e) { /* fine */ }
    } else saveLocalLabels();
  }

  /* An artist is a thing in its own right, not just a field on a tour, so a
     name registered here shows up before their first run exists. */
  function artistKey(name) {
    return 'artist:' + String(name || '').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }
  function registeredArtists() {
    return Object.keys(S.labels)
      .filter(function (k) { return k.indexOf('artist:') === 0 && S.labels[k] && S.labels[k].kind === 'artist'; })
      .map(function (k) { return String(S.labels[k].name || ''); })
      .filter(Boolean);
  }
  async function registerArtist(name) {
    var key = artistKey(name);
    if (key === 'artist:') return false;
    var rec = { kind: 'artist', name: String(name).trim() };
    S.labels[key] = rec;
    if (S.mode === 'db' && store.db) {
      try { await store.db.doc('labels/' + key).set(rec); } catch (e) { /* a convenience */ }
    } else saveLocalLabels();
    return true;
  }
  async function forgetArtist(name) {
    var key = artistKey(name);
    delete S.labels[key];
    if (S.mode === 'db' && store.db) {
      try { await store.db.doc('labels/' + key).delete(); } catch (e) { /* fine */ }
    } else saveLocalLabels();
  }

  /* Artist logos ride the shared labels store too, under alogo: keys —
     one logo per artist name, following the account across tours. */
  function artistLogoKey(name) {
    return 'alogo:' + String(name || '').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }
  function artistLogo(name) {
    var rec = S.labels[artistLogoKey(name)];
    return rec && rec.kind === 'artistLogo' && rec.dataUrl ? rec.dataUrl : null;
  }
  async function saveArtistLogo(name, dataUrl) {
    var key = artistLogoKey(name);
    if (key === 'alogo:') return false;
    var rec = { kind: 'artistLogo', name: String(name), dataUrl: dataUrl };
    S.labels[key] = rec;
    if (S.mode === 'db' && store.db) {
      try { await store.db.doc('labels/' + key).set(rec); } catch (e) { /* a nicety */ }
    } else saveLocalLabels();
    return true;
  }
  /* Any image in, a small square PNG out — logos stay tiny in the store. */
  function readLogoFile(file, cb) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var SZ = 128;
      var c = document.createElement('canvas');
      c.width = SZ; c.height = SZ;
      var ctx = c.getContext('2d');
      var r = Math.min(SZ / img.width, SZ / img.height);
      var w2 = Math.max(1, Math.round(img.width * r));
      var h2 = Math.max(1, Math.round(img.height * r));
      ctx.drawImage(img, (SZ - w2) / 2, (SZ - h2) / 2, w2, h2);
      URL.revokeObjectURL(url);
      cb(c.toDataURL('image/png'));
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast('Couldn\u2019t read that image \u2014 try a PNG or JPG'); };
    img.src = url;
  }

  async function removeLabel(merchant) {
    var key = GRS.normMerchant(merchant);
    delete S.labels[key];
    if (S.mode === 'db') {
      try { await store.db.doc('labels/' + key).delete(); } catch (e) { /* not fatal */ }
    } else saveLocalLabels();
    render(true);
  }

  function subscribe() {
    if (store.unsub) { try { store.unsub(); } catch (e) { /* already closed */ } }
    store.unsub = store.db.collection('tours').onSnapshot(function (snap) {
      store.retries = 0;
      var m = new Map();
      snap.docs.forEach(function (d) {
        if (!d.exists) return;
        var v = d.data();
        if (G.isObj(v)) m.set(d.id, v);
      });
      S.tours = m;
      Object.keys(S.pending).forEach(function (id) { if (m.has(id)) delete S.pending[id]; });
      S.dbError = null;
      dataArrived();
    }, function (err) {
      var code = err && err.code;
      if (code === 'unavailable' && store.retries < 3) {
        store.retries += 1;
        setTimeout(subscribe, 1200 * store.retries + Math.random() * 800);
        return;
      }
      if (code === 'revoked') S.writeRefused = true;
      S.dbError = code || 'unavailable';
      S.loaded = true;
      render(true);
    });
  }

  function dataArrived() {
    var first = !S.loaded;
    S.loaded = true;
    if (first) restoreLastTour();
    render(first);
    if (first && canWrite()) setTimeout(function () { purgeTrash(); }, 4000);
  }
  function loadLocal() {
    var data = null;
    try { data = JSON.parse(lsGet(LS_DATA) || 'null'); } catch (e) { data = null; }
    store.local = data && G.isObj(data.tours) ? data : { tours: {} };
    store.lsOk = lsSet(LS_DATA, JSON.stringify(store.local));
    S.tours = new Map(Object.entries(store.local.tours));
  }
  function saveLocal() {
    store.lsOk = lsSet(LS_DATA, JSON.stringify(store.local));
    S.tours = new Map(Object.entries(store.local.tours));
  }
  function enqueue(id, fn) {
    var run = (store.queues[id] || Promise.resolve()).catch(function () {}).then(fn);
    store.queues[id] = run;
    return run;
  }
  async function withRetry(fn) {
    try { return await fn(); }
    catch (e) {
      if (e && e.code === 'unavailable') { await sleep(400 + Math.random() * 700); return fn(); }
      throw e;
    }
  }
  function onWriteError(e) {
    var code = e && e.code;
    if (code === 'revoked' || code === 'not_granted') {
      S.writeRefused = true; toast(VIEW_ONLY); render(true); return;
    }
    if (code === 'quota_exceeded') { toast('Storage is full. Delete an old tour to make room.'); return; }
    if (code === 'resource_exhausted') { toast('Saving too fast. Wait a moment, then try again.'); return; }
    if (code === 'invalid_argument') { toast('That change couldn’t be saved.'); return; }
    toast('Couldn’t save. Check your connection and try again.');
  }

  var api = {
    async create(id, doc) {
      if (!canWrite()) { toast(VIEW_ONLY); return false; }
      if (S.mode === 'db') {
        S.pending[id] = doc;
        try {
          await enqueue(id, function () { return withRetry(function () { return store.db.doc('tours/' + id).set(doc); }); });
          return true;
        } catch (e) { delete S.pending[id]; onWriteError(e); return false; }
      }
      store.local.tours[id] = clone(doc); saveLocal(); render(); return true;
    },
    async update(id, patch) {
      if (!canWrite()) { toast(VIEW_ONLY); return false; }
      if (S.mode === 'db') {
        try {
          await enqueue(id, function () { return withRetry(function () { return store.db.doc('tours/' + id).update(patch); }); });
          return true;
        } catch (e) { onWriteError(e); return false; }
      }
      var cur = store.local.tours[id];
      if (!cur) return false;
      store.local.tours[id] = deepMerge(clone(cur), patch); saveLocal(); render(); return true;
    },
    async remove(id) {
      if (!canWrite()) { toast(VIEW_ONLY); return false; }
      if (S.mode === 'db') {
        try {
          await enqueue(id, function () { return withRetry(function () { return store.db.doc('tours/' + id).delete(); }); });
          delete S.pending[id];
          return true;
        } catch (e) { onWriteError(e); return false; }
      }
      delete store.local.tours[id]; saveLocal(); render(); return true;
    }
  };

  /* ============================== Routing ============================== */

  function go(route) {
    // OVERVIEW always opens on today's show, not wherever you last flipped to.
    if (route.name === 'tour' && route.view === 'details') S.dsIndex = null;
    S.route = route;
    S.focusOnRender = true;
    window.scrollTo(0, 0);
    render(true);
  }
  function clampStep(s) { return 2; } // one resume point: the shows
  function openTour(id) {
    var t = getTour(id);
    if (t && !t.setupDone && canEditTour(id)) go({ name: 'wizard', id: id, step: clampStep(t.setupStep) });
    else go({ name: 'tour', id: id, view: 'menu' });
  }
  // A hard close and reopen always lands on the Artists screen — the top of
  // the app, not wherever the last session wandered.
  function restoreLastTour() {}

  function render(force) {
    var view = $('#view');
    if (!view) return;
    var a = document.activeElement;
    var typing = !!(a && view.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'));
    if (!force && typing) { S.pendingRender = true; return; }
    S.pendingRender = false;
    var key = typing ? a.getAttribute('data-k') : null;
    var sel = null;
    if (key) { try { sel = [a.selectionStart, a.selectionEnd]; } catch (e) { sel = null; } }

    var node;
    if (!S.loaded) node = viewLoading();
    else if (S.route.name === 'wizard') node = viewWizard();
    else if (S.route.name === 'tour') node = viewTour();
    else if (S.route.name === 'artist') node = viewArtist();
    else if (S.route.name === 'newartist') node = viewNewArtist();
    else node = viewHome();
    view.replaceChildren(node);

    if (key) {
      var el = view.querySelector('[data-k="' + key + '"]');
      if (el) {
        el.focus({ preventScroll: true });
        if (sel) { try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ } }
      }
    }
    afterRender();
  }
  document.addEventListener('focusout', function () {
    setTimeout(function () { if (S.pendingRender) render(); }, 320);
  });

  function afterRender() {
    if (S.route.name === 'tour') mountHero();
    else teardownMinibar();
    if (S.focusOnRender) {
      S.focusOnRender = false;
      var af = $('#view [autofocus]');
      if (af) af.focus({ preventScroll: true });
    }
  }

  /* ============================== Toast + sheets ============================== */

  var toastTimer = 0;
  function toast(msg) {
    var root = $('#toast');
    var t = h('div', { class: 't' }, msg);
    root.replaceChildren(t);
    requestAnimationFrame(function () { t.classList.add('is-on'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-on'); }, 3200);
  }

  var sheet = null;
  function openSheet(build, opts) {
    var o = opts || {};
    if (sheet) closeSheet(true);
    var root = $('#sheet-root');
    var prevFocus = document.activeElement;
    var panel = h('div', {
      class: 'sheet', role: 'dialog', 'aria-modal': 'true',
      'aria-label': o.label || 'Dialog', tabindex: '-1'
    });
    var content = flatten([build(panel)]).filter(Boolean);
    panel.append(h('button', {
      class: 'iconbtn sheet-x', type: 'button', 'aria-label': 'Close',
      onclick: function () { closeSheet(); }
    }, icon('close')));
    content.forEach(function (c) { panel.append(c); });
    root.replaceChildren(h('div', { class: 'scrim', onclick: function () { closeSheet(); } }), panel);
    root.hidden = false;
    document.body.classList.add('locked');
    sheet = { root: root, panel: panel, prevFocus: prevFocus, onClose: o.onClose };
    requestAnimationFrame(function () {
      root.classList.add('open');
      var af = panel.querySelector('[autofocus]');
      (af || panel).focus({ preventScroll: true });
    });
  }
  function closeSheet(immediate) {
    if (!sheet) return;
    var s = sheet;
    sheet = null;
    if (s.onClose) { try { s.onClose(); } catch (e) { /* ignore */ } }
    s.root.classList.remove('open');
    document.body.classList.remove('locked');
    var finish = function () { if (!sheet) { s.root.replaceChildren(); s.root.hidden = true; } };
    if (immediate || reduced()) finish(); else setTimeout(finish, 300);
    if (!immediate && s.prevFocus && s.prevFocus.isConnected && s.prevFocus.tagName === 'BUTTON') {
      try { s.prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }
  document.addEventListener('keydown', function (e) {
    if (!sheet) return;
    if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
    if (e.key !== 'Tab') return;
    var f = Array.prototype.filter.call(
      sheet.panel.querySelectorAll('button, input, select, textarea'),
      function (el) { return !el.disabled && el.getAttribute('tabindex') !== '-1' && el.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet.panel)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  });

  function confirmSheet(o) {
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, o.title),
        o.body ? h('p', { class: 'sh-sub' }, o.body) : null,
        h('div', { class: 'stack' },
          h('button', {
            class: 'btn block ' + (o.danger ? 'danger-solid' : 'primary'), type: 'button',
            onclick: async function (e) {
              e.currentTarget.disabled = true;
              var ok = await o.onConfirm();
              closeSheet();
              if (ok !== false) render(true);
            }
          }, o.action),
          h('button', {
            class: 'btn ghost block', type: 'button', autofocus: true,
            onclick: function () { closeSheet(); }
          }, o.cancel || 'Cancel'))
      ];
    }, { label: o.title });
  }

  /* ============================== The hero ============================== */

  function heroNode(tour, tourId) {
    var c = G.calc(tour);
    var st = G.stateOf(c);
    var series = G.balanceSeries(tour);
    var change = G.latestChange(tour);
    var pct = Math.max(0, Math.min(100, Math.floor(c.coverage * 100)));

    var odo = h('div', { class: 'odo num', id: 'odo', role: 'text', 'aria-label': money(c.net, true) });
    var cap = h('div', { class: 'hero-cap', id: 'hero-cap' }, G.caption(c));

    var chip = null;
    if (change) {
      var up = change.delta > 0;
      var from = change.kind === 'import' ? 'from card charges'
        : change.kind === 'extra' ? 'from ' + change.label
        : 'from ' + change.label;
      chip = h('div', { class: 'change-chip ' + (up ? 'up' : 'down') },
        h('b', { class: 'num' }, money(change.delta, true)),
        h('span', null, from));
    }

    // The chart is measured and drawn once it is in the document, so circles stay
    // round and strokes keep their weight at whatever width the phone gives us.
    var chart = null;
    if (series.length > 1) {
      chart = h('div', {
        class: 'chart-wrap', tabindex: '0', role: 'img',
        'aria-label': 'Running balance from ' + dayLong(series[0].date) + ' to ' +
          dayLong(series[series.length - 1].date) + '. Now ' + money(c.net, true) + '. ' +
          'Use the left and right arrow keys to step through the tour night by night.'
      });
      chart.__data = { series: series, nights: loggedNights(tour), tourId: tourId };
    }

    var fill = h('div', { class: 'prog-fill', id: 'prog-fill' });
    var prog = h('div', { class: 'prog' },
      h('div', { class: 'prog-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
        'aria-valuenow': String(pct), 'aria-label': pct + '% of the way to green' }, fill),
      h('div', { class: 'prog-cap' },
        h('span', { id: 'prog-pct' }, c.out > 0 ? pct + '% of the way to green' : 'No costs added yet'),
        h('span', { class: 'num' }, money(c.income) + ' in / ' + money(c.out) + ' out')));

    // Under the number: the day's take on the left, its comment on the right.
    // The row is always there at a fixed height, so nothing shifts when it fills.
    var dayNote = h('div', { class: 'hero-note', id: 'hero-note' });
    var capRow = h('div', { class: 'cap-row' }, cap, dayNote);
    var hero = h('section', { class: 'hero ' + st, id: 'hero', 'aria-label': 'Tour balance' },
      odo, capRow, chip, chart, prog);
    hero.__calc = c;
    hero.__series = series;
    hero.__pct = pct;
    return hero;
  }

  // The nights that actually moved the number, so the line can mark them.
  function loggedNights(tour) {
    var m = {};
    G.rows(tour && tour.shows).forEach(function (s) {
      var total = G.showIncomeTotal(s);
      if (s.loggedAt && total > 0 && s.date) m[s.date] = { city: s.city || 'Show', total: total };
    });
    return m;
  }

  var chartSeq = 0;

  function drawChart(wrap) {
    var d = wrap.__data;
    if (!d) return;
    var series = d.series;
    var last = series.length - 1;
    var W = Math.max(260, Math.round(wrap.clientWidth || 340));
    var H = 184, PAD = 14, PADX = 8; // PADX keeps the first and last markers whole

    var nets = series.map(function (p) { return p.net; });
    var lo = Math.min.apply(null, nets.concat([0]));
    var hi = Math.max.apply(null, nets.concat([0]));
    if (hi === lo) hi = lo + 1;
    // Keep break-even off the edge so it reads as a line to cross, not a border.
    var room = (hi - lo) * 0.16;
    hi += room; lo -= room;
    var span = hi - lo;
    var y = function (v) { return PAD + (hi - v) / span * (H - PAD * 2); };
    var x = function (i) { return last < 1 ? PADX : PADX + (i / last) * (W - PADX * 2); };
    var y0 = y(0);

    var line = series.map(function (p, i) {
      return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.net).toFixed(1);
    }).join(' ');
    var area = line + ' L' + x(last).toFixed(1) + ' ' + y0.toFixed(1) +
      ' L' + x(0).toFixed(1) + ' ' + y0.toFixed(1) + ' Z';

    var uid = 'gr' + (++chartSeq);
    var above = Math.max(0, Math.min(H, y0));
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'chart');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.setAttribute('aria-hidden', 'true');

    var parts = [
      '<defs>',
      '<clipPath id="' + uid + '-pos"><rect x="0" y="0" width="' + W + '" height="' + above.toFixed(1) + '"/></clipPath>',
      '<clipPath id="' + uid + '-neg"><rect x="0" y="' + above.toFixed(1) + '" width="' + W + '" height="' + (H - above).toFixed(1) + '"/></clipPath>',
      '</defs>',
      '<path class="fill-pos" d="' + area + '" clip-path="url(#' + uid + '-pos)"/>',
      '<path class="fill-neg" d="' + area + '" clip-path="url(#' + uid + '-neg)"/>',
      '<line class="baseline" x1="' + PADX + '" y1="' + y0.toFixed(1) + '" x2="' + (W - PADX) + '" y2="' + y0.toFixed(1) + '"/>',
      // The line itself is red under break-even and green over it.
      '<path class="curve pos" d="' + line + '" clip-path="url(#' + uid + '-pos)"/>',
      '<path class="curve neg" d="' + line + '" clip-path="url(#' + uid + '-neg)"/>'
    ];

    series.forEach(function (p, i) {
      if (!d.nights[p.date] || i === last) return;
      parts.push('<circle class="night ' + (p.net < 0 ? 'neg' : 'pos') + '" cx="' +
        x(i).toFixed(1) + '" cy="' + y(p.net).toFixed(1) + '" r="4"/>');
    });
    parts.push('<circle class="head ' + (series[last].net < 0 ? 'neg' : 'pos') + '" cx="' +
      x(last).toFixed(1) + '" cy="' + y(series[last].net).toFixed(1) + '" r="5.5"/>');
    parts.push('<line class="cursor" x1="0" y1="0" x2="0" y2="' + H + '"/>');
    parts.push('<circle class="dot neg" cx="0" cy="0" r="5.5"/>');
    svg.innerHTML = parts.join('');

    var flag = h('span', { class: 'break-even' }, 'break even');
    flag.style.top = (y0 / H * 100) + '%';
    var pill = h('div', { class: 'scrub-pill', hidden: true });
    // Comments for the night you're on, below the line.
    var notes = h('div', { class: 'scrub-notes', hidden: true });
    // A pin under every night that carries a comment, so you can see
    // where the talk is before you ever touch the line.
    var pins = h('div', { class: 'note-pins', 'aria-hidden': 'true' });
    if (d.tourId) {
      var tt = getTour(d.tourId);
      series.forEach(function (pt, i) {
        var n = notesFor(tt, d.tourId, pt.date).length;
        if (!n) return;
        var pin = h('span', { class: 'note-pin', 'data-i': String(i) });
        pin.style.left = (x(i) / W * 100) + '%';
        pins.append(pin);
      });
    }

    // The bus rides the line: parked at the head, and out in front of the dot
    // while a finger is on the chart. It never hangs off either edge.
    var BUS_W = 42, BUS_DX = 0.2; // BUS_DX matches .chart-bus's translateX
    var parkBus = function (el, px, py, up) {
      var lx = Math.max(0, Math.min(px, W - BUS_W * (1 + BUS_DX)));
      el.style.left = (lx / W * 100) + '%';
      el.style.top = (py / H * 100) + '%';
      el.classList.toggle('neg', !up);
    };
    var bus = h('span', { class: 'chart-bus', 'aria-hidden': 'true' });
    parkBus(bus, x(last), y(series[last].net), series[last].net >= 0);

    wrap.replaceChildren(svg, flag, pill, notes, pins, bus,
      h('div', { class: 'chart-ends' },
        h('span', null, dayMD(series[0].date)),
        h('span', null, dayMD(series[last].date))));

    wrap.__geo = { x: x, y: y, W: W, H: H, svg: svg, pill: pill, notes: notes,
      series: series, nights: d.nights, tourId: d.tourId, pins: pins, bus: bus,
      headI: last, parkBus: parkBus };
    animateDraw(svg);
    setupScrub(wrap);
  }

  // The line draws itself in, then the marks arrive.
  function animateDraw(svg) {
    if (reduced()) return;
    Array.prototype.forEach.call(svg.querySelectorAll('.curve'), function (p) {
      var len = 0;
      try { len = p.getTotalLength(); } catch (e) { return; }
      if (!len) return;
      p.style.strokeDasharray = len + ' ' + len;
      p.style.strokeDashoffset = String(len);
      void p.getBoundingClientRect();
      p.style.transition = 'stroke-dashoffset .95s cubic-bezier(.22,.9,.18,1)';
      p.style.strokeDashoffset = '0';
    });
    Array.prototype.forEach.call(svg.querySelectorAll('.fill-pos, .fill-neg'), function (f) {
      f.style.opacity = '0';
      f.style.transition = 'opacity .95s ease';
      requestAnimationFrame(function () { f.style.opacity = ''; });
    });
    Array.prototype.forEach.call(svg.querySelectorAll('.night, .head'), function (m, i) {
      m.style.opacity = '0';
      m.style.transition = 'opacity .3s ease ' + (0.6 + i * 0.06).toFixed(2) + 's';
      requestAnimationFrame(function () { m.style.opacity = '1'; });
    });
  }

  function setHeroState(hero, st) {
    hero.classList.remove('red', 'green', 'idle');
    hero.classList.add(st);
  }

  function mountHero() {
    var hero = $('#hero');
    if (!hero) { teardownMinibar(); return; }
    var id = S.route.id;
    var c = hero.__calc;
    var st = G.stateOf(c);

    var odo = $('#odo', hero);
    var prev = S.lastNet[id];
    var target = money(c.net, true);
    // First look at a tour this session: roll in from zero rather than landing flat.
    var from = prev === undefined ? 0 : prev;
    renderOdo(odo, target, money(from, true));

    hero.style.setProperty('--cov', hero.__pct + '%');
    setProgress(hero, hero.__pct, c.out);

    var wrap = $('.chart-wrap', hero);
    if (wrap) drawChart(wrap);
    setupMinibar(id, c);

    var wasState = S.lastState[id];
    if (prev !== undefined && prev < 0 && G.round(c.net) >= 0 && wasState !== 'green') {
      confetti();
      if (!reduced()) {
        hero.classList.remove('celebrate');
        void hero.offsetWidth;
        hero.classList.add('celebrate');
      }
    }
    S.lastNet[id] = c.net;
    S.lastState[id] = st;
  }

  function setProgress(hero, pct, out) {
    var fill = $('#prog-fill', hero);
    if (!fill) return;
    fill.style.width = Math.max(out > 0 ? 2 : 0, pct) + '%';
    fill.style.background = progColor(pct / 100);
  }

  var redrawTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(function () {
      var wrap = $('#hero .chart-wrap');
      if (wrap) drawChart(wrap);
    }, 180);
  });

  // The bar is red until the tour covers its costs, then green. Length carries
  // the progress; colour carries only the one thing that matters.
  function progColor(p) { return p >= 1 ? 'var(--pos)' : 'var(--neg)'; }

  // Odometer: one rolling column per digit, staggered. Aligned from the right so
  // the dollars column keeps its identity when the number gains a digit.
  function renderOdo(host, text, fromText) {
    var chars = text.split('');
    var prev = (fromText || text).split('');
    var offset = chars.length - prev.length;
    host.replaceChildren();
    host.setAttribute('aria-label', text);
    var targets = [];
    var digitIndex = 0;
    chars.forEach(function (ch, i) {
      if (ch >= '0' && ch <= '9') {
        var strip = h('span', { class: 'odo-strip' });
        for (var d = 0; d <= 9; d++) strip.append(h('span', null, String(d)));
        var pj = i - offset;
        var pc = prev[pj];
        var from = (pc >= '0' && pc <= '9') ? +pc : +ch;
        strip.style.setProperty('--i', String(digitIndex));
        strip.style.transform = 'translateY(-' + (from * 10) + '%)';
        host.append(h('span', { class: 'odo-c odo-d' }, strip));
        targets.push([strip, +ch]);
        digitIndex += 1;
      } else {
        host.append(h('span', { class: 'odo-c' }, ch));
      }
    });
    var roll = function () {
      targets.forEach(function (t) { t[0].style.transform = 'translateY(-' + (t[1] * 10) + '%)'; });
    };
    if (reduced() || fromText === text) roll();
    else requestAnimationFrame(function () { requestAnimationFrame(roll); });
  }

  /* Drag a finger along the line to see where the tour stood after any night.
     Arrow keys do the same thing for anyone not using a pointer. */
  function setupScrub(wrap) {
    var geo = wrap.__geo;
    var hero = wrap.closest('.hero');
    if (!geo || !hero) return;

    var odo = $('#odo', hero);
    var cap = $('#hero-cap', hero);
    var pctEl = $('#prog-pct', hero);
    var cursor = geo.svg.querySelector('.cursor');
    var dot = geo.svg.querySelector('.dot');
    var c = hero.__calc;

    // The whole booked run, logged or not, so an unlogged night can still
    // say where the band is playing — and a day off can say what's next.
    var schedule = {};
    if (geo.tourId) {
      G.rows((getTour(geo.tourId) || {}).shows).forEach(function (sh) {
        if (G.parseDay(sh.date)) schedule[sh.date] = sh;
      });
    }
    var showDates = Object.keys(schedule).sort();
    function nightLabel(date, night) {
      if (night) return night.city || 'Show';
      var sh = schedule[date];
      var today = G.tourToday();
      if (sh) {
        return (sh.city || 'Show') +
          (date === today ? ' \u00b7 tonight' : date > today ? ' \u00b7 upcoming' : ' \u00b7 not logged');
      }
      var nxt = showDates.filter(function (d) { return d > date; })[0];
      return nxt ? 'Day off \u00b7 next ' + (String(schedule[nxt].city || 'show').split(',')[0]) : 'Day off';
    }

    var restText = money(c.net, true);
    var restCap = G.caption(c);
    var restPct = hero.__pct;
    var restPctText = pctEl ? pctEl.textContent : '';
    var cur = -1;

    // A small tap each time the scrub lands on a new night. Android and
    // desktop honour navigator.vibrate; iPhones do not, and the only thing
    // that buzzes in Safari is a switch-style checkbox being toggled — so we
    // nudge one. Neither is allowed to interrupt the scrub if it refuses.
    var buzzer = null;
    function tick() {
      try { if (navigator.vibrate) navigator.vibrate(9); } catch (e) { /* no motor */ }
      try {
        if (!buzzer) {
          buzzer = h('input', { type: 'checkbox', class: 'sr', tabindex: '-1', 'aria-hidden': 'true' });
          buzzer.setAttribute('switch', '');
          wrap.appendChild(buzzer);
        }
        buzzer.click();
      } catch (e) { /* no haptics here */ }
    }

    function showIndex(i) {
      var p = geo.series[i];
      if (!p) return;
      if (i !== cur) tick();
      cur = i;
      wrap.classList.add('scrubbing');
      hero.classList.add('scrubbing');
      var px = geo.x(i), py = geo.y(p.net);
      var up = p.net >= 0;

      cursor.setAttribute('x1', px); cursor.setAttribute('x2', px);
      dot.setAttribute('cx', px); dot.setAttribute('cy', py);
      dot.setAttribute('class', 'dot ' + (up ? 'pos' : 'neg'));
      if (geo.bus) geo.parkBus(geo.bus, px, py, up);

      renderOdo(odo, money(p.net, true), money(p.net, true));
      setHeroState(hero, up ? 'green' : 'red');

      var night = geo.nights[p.date];
      // Under the number: what came in that day, rolling like the number does.
      var took = night ? night.total : 0;
      var tookText = money(took) + ' in';
      if (cap.__last !== tookText) {
        cap.classList.add('num', 'cap-odo');
        renderOdo(cap, tookText, cap.__last || tookText);
        cap.__last = tookText;
      }

      var mineNow = geo.tourId ? notesFor(getTour(geo.tourId), geo.tourId, p.date) : [];
      geo.pill.hidden = !mineNow.length;
      if (mineNow.length) {
        geo.pill.replaceChildren(h('b', null, mineNow[0].author || 'Someone'), ' ' + mineNow[0].body);
        geo.pill.style.left = (px / geo.W * 100) + '%';
      }

      // Where the comment used to sit: the night itself.
      var noteEl = $('#hero-note', hero);
      if (noteEl) noteEl.textContent = nightLabel(p.date, night);
      if (geo.pins) {
        Array.prototype.forEach.call(geo.pins.children, function (pin) {
          pin.classList.toggle('on', Number(pin.getAttribute('data-i')) === i);
        });
      }

      var pct = p.out > 0 ? Math.max(0, Math.min(100, Math.floor(p.income / p.out * 100))) : 0;
      hero.style.setProperty('--cov', pct + '%');
      setProgress(hero, pct, p.out);
      if (pctEl) pctEl.textContent = pct + '% of the way to green';
    }

    function fromPointer(e) {
      var r = wrap.getBoundingClientRect();
      var f = r.width ? (e.clientX - r.left) / r.width : 0;
      showIndex(Math.round(Math.max(0, Math.min(1, f)) * (geo.series.length - 1)));
    }

    function end() {
      cur = -1;
      wrap.classList.remove('scrubbing');
      hero.classList.remove('scrubbing');
      if (geo.bus) {
        var hp = geo.series[geo.headI];
        geo.parkBus(geo.bus, geo.x(geo.headI), geo.y(hp.net), hp.net >= 0);
      }
      geo.pill.hidden = true;
      geo.notes.hidden = true;
      var noteEnd = $('#hero-note', hero);
      if (noteEnd) noteEnd.textContent = '';
      cap.classList.remove('num', 'cap-odo');
      cap.__last = null;
      if (geo.pins) {
        Array.prototype.forEach.call(geo.pins.children, function (pin) { pin.classList.remove('on'); });
      }
      renderOdo(odo, restText, restText);
      setHeroState(hero, G.stateOf(c));
      cap.textContent = restCap;
      hero.style.setProperty('--cov', restPct + '%');
      setProgress(hero, restPct, c.out);
      if (pctEl) pctEl.textContent = restPctText;
    }

    var downAt = null;
    wrap.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // A refused capture must not cost us the scrub — the swipe cards learned
      // this the same way.
      try { wrap.setPointerCapture(e.pointerId); } catch (e2) { /* track anyway */ }
      downAt = { x: e.clientX, y: e.clientY, t: Date.now() };
      fromPointer(e);
    });
    // A tap, not a drag, opens the night's comments.
    wrap.addEventListener('pointerup', function (e) {
      if (!downAt) return;
      var moved = Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y);
      var quick = Date.now() - downAt.t < 450;
      var i = cur;
      downAt = null;
      if (moved < 10 && quick && geo.tourId && geo.series[i]) {
        openDayNotes(geo.tourId, geo.series[i].date);
      }
    });
    wrap.addEventListener('pointermove', function (e) {
      // The finger being down is what makes it a scrub — asking whether the
      // capture took leaves the chart dead wherever capture is refused.
      if (downAt) fromPointer(e);
    });
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
    wrap.addEventListener('blur', end);
    wrap.addEventListener('keydown', function (e) {
      var n = geo.series.length;
      if (e.key === 'ArrowRight') { e.preventDefault(); showIndex(Math.min(n - 1, (cur < 0 ? -1 : cur) + 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); showIndex(Math.max(0, (cur < 0 ? n : cur) - 1)); }
      else if (e.key === 'Home') { e.preventDefault(); showIndex(0); }
      else if (e.key === 'End') { e.preventDefault(); showIndex(n - 1); }
      else if (e.key === 'Escape') { end(); }
    });
  }

  function setupMinibar(id, c) {
    var bar = $('#minibar');
    var t = getTour(id);
    if (!bar || !t) return;
    bar.setAttribute('data-state', G.stateOf(c));
    $('.name', bar).textContent = t.name || '';
    $('.num', bar).textContent = money(c.net, true);
    if (S.io) S.io.disconnect();
    var hero = $('#hero');
    if (!hero || !('IntersectionObserver' in window)) return;
    S.io = new IntersectionObserver(function (entries) {
      var e = entries[entries.length - 1];
      bar.classList.toggle('is-on', !e.isIntersecting && e.boundingClientRect.bottom <= 0);
    });
    S.io.observe(hero);
  }
  function teardownMinibar() {
    if (S.io) { S.io.disconnect(); S.io = null; }
    var bar = $('#minibar');
    if (bar) bar.classList.remove('is-on');
  }

  function confetti() {
    if (reduced()) return;
    var cv = $('#confetti');
    if (!cv) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.hidden = false;
    cv.width = window.innerWidth * dpr;
    cv.height = window.innerHeight * dpr;
    var ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    var colors = ['#CCF80A', '#A8CC00', '#E7FF4F', '#F1F4E3', '#FFFFFF'];
    var cx = window.innerWidth / 2, cy = window.innerHeight * 0.3;
    var bits = [];
    for (var i = 0; i < 90; i++) {
      var ang = (Math.PI * 2 * i) / 90 + Math.random() * 0.3;
      var sp = 5 + Math.random() * 8;
      bits.push({
        x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 3,
        s: 4 + Math.random() * 5, r: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.35, c: colors[i % colors.length]
      });
    }
    var t0 = performance.now();
    function frame(now) {
      var el = now - t0;
      if (el > 1400 || !cv.isConnected) { ctx.clearRect(0, 0, cv.width, cv.height); cv.hidden = true; return; }
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.globalAlpha = Math.max(0, 1 - el / 1400);
      bits.forEach(function (b) {
        b.vy += 0.28; b.x += b.vx; b.y += b.vy; b.vx *= 0.99; b.r += b.vr;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r);
        ctx.fillStyle = b.c; ctx.fillRect(-b.s / 2, -b.s / 2, b.s, b.s * 0.6);
        ctx.restore();
      });
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ============================== Views: loading + home ============================== */

  // The mark gets its moment here, before the money takes the screen back.
  /* The bus, driving — shown wherever the app is working. */
  function roadie() {
    return h('div', { class: 'roadie', 'aria-hidden': 'true' },
      h('span', { class: 'bus-mark' }),
      h('span', { class: 'rd-road' }));
  }

  function viewLoading() {
    return h('div', { class: 'page' },
      h('div', { class: 'splash' },
        roadie(),
        h('div', { class: 'splash-name' }, 'Loading your tours…')));
  }
  // The mark carries the name on its own — no wordmark beside it.
  function wordmark() {
    return h('span', { class: 'logo-mark top', role: 'img', 'aria-label': 'Greenroom' });
  }

  /* ---- Theme ---- */
  function currentTheme() {
    var stored = lsGet(LS_THEME);
    if (stored === 'light' || stored === 'black') return stored;
    // Classic boots on the original look; the main app on the new green.
    return window.GR_SKIN === 'classic' ? 'light' : 'black';
  }
  function applyTheme(t) {
    if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
  }
  function themeBtn() {
    var t = currentTheme();
    return h('button', {
      class: 'iconbtn sm', type: 'button',
      'aria-label': t === 'light' ? 'Switch to the black look' : 'Switch to the light look',
      onclick: function () {
        var next = currentTheme() === 'light' ? 'black' : 'light';
        lsSet(LS_THEME, next);
        applyTheme(next);
        render(true);
      }
    }, icon(t === 'light' ? 'moon' : 'sun', 19));
  }

  function allTourEntries(includeDeleted) {
    var entries = Array.from(S.tours.entries());
    Object.keys(S.pending).forEach(function (id) {
      if (!S.tours.has(id)) entries.push([id, S.pending[id]]);
    });
    if (!includeDeleted) {
      entries = entries.filter(function (e) { return !e[1].deletedAt; });
    }
    entries.sort(function (a, b) { return (b[1].createdAt || 0) - (a[1].createdAt || 0); });
    return entries;
  }

  var TRASH_DAYS = 30;

  function trashedEntries() {
    return allTourEntries(true).filter(function (e) { return e[1].deletedAt; });
  }
  async function softDeleteTour(id) {
    if (await api.update(id, { deletedAt: Date.now() })) {
      toast('Deleted — it sits in Recently deleted for ' + TRASH_DAYS + ' days');
      return true;
    }
    return false;
  }
  async function restoreTour(id) {
    return api.update(id, { deletedAt: null });
  }
  // Old enough trash takes itself out, once per session.
  async function purgeTrash() {
    if (S.purged) return;
    S.purged = true;
    var cutoff = Date.now() - TRASH_DAYS * 86400e3;
    var old = trashedEntries().filter(function (e) { return e[1].deletedAt < cutoff; });
    for (var i = 0; i < old.length; i++) {
      try { await api.remove(old[i][0]); } catch (e) { /* not ours to purge */ }
    }
  }

  function artistOf(t) { return String(t && t.artist || '').trim(); }

  function homePill() {
    if (S.role === 'viewer' || S.writeRefused) return 'View only';
    if (S.role === 'editor') return 'Editor';
    if (S.mode === 'local') return store.lsOk ? 'Saved on this device' : 'Changes won’t be kept';
    return null;
  }

  /* Swipe a card left and a delete button rides in under it. Vertical
     scrolling stays untouched; the gesture only engages sideways. */
  function swipeable(card, onDelete, label) {
    var OPEN = -92;
    var wrap = h('div', { class: 'swipe-wrap' },
      h('button', { class: 'swipe-del', type: 'button', 'aria-label': 'Delete ' + label,
        onclick: function () { onDelete(); } }, 'Delete'),
      card);
    card.classList.add('swipe-card');
    var startX = 0, startY = 0, base = 0, dragging = false, horizontal = null;
    card.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startX = e.clientX; startY = e.clientY;
      base = card.classList.contains('open') ? OPEN : 0;
      dragging = true; horizontal = null;
      card.style.transition = 'none';
    });
    card.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (horizontal == null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        horizontal = Math.abs(dx) > Math.abs(dy);
        if (horizontal) {
          wrap.classList.add('revealed');
          try { card.setPointerCapture(e.pointerId); } catch (e2) {}
        }
      }
      if (!horizontal) { dragging = false; card.style.transition = ''; return; }
      var x = Math.max(OPEN - 24, Math.min(0, base + dx));
      card.style.transform = 'translateX(' + x + 'px)';
    });
    function settle(e) {
      if (!dragging) return;
      dragging = false;
      card.style.transition = '';
      if (horizontal) {
        var dx = e.clientX - startX;
        var open = (base + dx) < OPEN / 2;
        card.classList.toggle('open', open);
        card.style.transform = open ? 'translateX(' + OPEN + 'px)' : '';
        if (!open) setTimeout(function () { wrap.classList.remove('revealed'); }, 240);
        if (horizontal && Math.abs(dx) > 8) card.__swiped = Date.now();
      }
    }
    card.addEventListener('pointerup', settle);
    card.addEventListener('pointercancel', function () {
      dragging = false; card.style.transition = ''; 
    });
    // a tap right after a swipe is the swipe finishing, not a click
    card.addEventListener('click', function (e) {
      if (card.classList.contains('open') || (card.__swiped && Date.now() - card.__swiped < 350)) {
        e.stopPropagation(); e.preventDefault();
        card.classList.remove('open');
        card.style.transform = '';
        setTimeout(function () { wrap.classList.remove('revealed'); }, 240);
      }
    }, true);
    return wrap;
  }

  /* The first screen: artists as folders, plus any tours that don't belong to
     one yet. With no artists named it looks exactly like a plain tour list. */
  function viewHome() {
    var entries = allTourEntries();
    var byArtist = new Map();
    var loose = [];
    entries.forEach(function (e) {
      var a = artistOf(e[1]);
      if (!a) { loose.push(e); return; }
      if (!byArtist.has(a)) byArtist.set(a, []);
      byArtist.get(a).push(e);
    });
    registeredArtists().forEach(function (a) { if (!byArtist.has(a)) byArtist.set(a, []); });
    var pill = homePill();

    return h('div', { class: 'page home' },
      h('div', { class: 'headband' },
        h('header', { class: 'topbar' },
          h('span', { class: 'top-side' }, pill ? h('span', { class: 'pill' }, pill) : null),
          h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
          h('span', { class: 'top-side right' },
            h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Settings',
              onclick: openSettingsSheet }, icon('more')))),
        h('div', { class: 'band-row wordmark-row' },
          h('span', { class: 'wordmark-full', role: 'img', 'aria-label': 'Greenroom' }))),
      dbBanner(),
      h('div', { class: 'sec-head split' },
        h('div', null,
          h('h2', { class: 'sec-title' }, 'ARTISTS'),
          byArtist.size ? h('p', { class: 'sec-sub' }, plural(byArtist.size, 'act') +
            ' \u00b7 ' + plural(entries.filter(function (e) { return artistOf(e[1]); }).length, 'run')) : null),
        canWrite()
          ? h('button', { class: 'add-mini', type: 'button', onclick: function () { go({ name: 'newartist' }); } },
              h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), 'Add artist')
          : null),
      byArtist.size
        ? h('ul', { class: 'tour-list' }, Array.from(byArtist, function (pair) {
            var cardEl = artistCard(pair[0], pair[1]);
            if (!canWrite()) return h('li', null, cardEl);
            return h('li', null, swipeable(cardEl, function () {
              confirmSheet({
                title: 'Delete everything for ' + pair[0] + '?',
                body: pair[1].length
                  ? plural(pair[1].length, 'tour') + ' move to Recently deleted for ' + TRASH_DAYS + ' days.'
                  : 'They have no runs yet, so nothing else goes with them.',
                action: pair[1].length ? 'Delete ' + plural(pair[1].length, 'tour') : 'Delete ' + pair[0],
                danger: true,
                onConfirm: async function () {
                  for (var i = 0; i < pair[1].length; i++) {
                    await api.update(pair[1][i][0], { deletedAt: Date.now() });
                  }
                  await forgetArtist(pair[0]);
                  toast(pair[0] + ' moved to Recently deleted');
                  return true;
                }
              });
            }, pair[0]));
          }))
        : null,
      loose.length
        ? [h('p', { class: 'count-line', style: 'margin-top:22px' }, 'Not filed under an artist yet'),
           h('ul', { class: 'tour-list' },
             loose.map(function (e) {
               var cardEl = tourCard(e[0], e[1]);
               if (!canWrite()) return h('li', null, cardEl);
               return h('li', null, swipeable(cardEl, function () { softDeleteTour(e[0]).then(function () { render(true); }); },
                 e[1].name || 'tour'));
             })),
           canWrite() ? h('p', { class: 'note' },
             'Open one \u2192 \u22ef \u2192 Name and artist to file it.') : null]
        : null,
      (!byArtist.size && !loose.length)
        ? emptyState('No artists yet', canWrite()
            ? 'Add your artist, then their first tour. Every act you manage gets its own folder here.'
            : 'Nothing has been shared with you yet.')
        : null,
      h('span', { class: 'logo-mark home-mark', 'aria-hidden': 'true' }),
      (function () {
        if (S.mode === 'db' && !S.askedUsername && window.GR_BACKEND &&
            window.GR_BACKEND.saveProfile && window.GR_BACKEND.myProfile &&
            !window.GR_BACKEND.myProfile().tourRole) {
          S.askedUsername = true;
          setTimeout(function () { openUsernameSheet(true); }, 700);
        }
        return null;
      })(),
      null);
  }

  /* Settings, behind the gear: the trash, who you are to the tour, the way out. */
  function openSettingsSheet() {
    var B = window.GR_BACKEND;
    var signedIn = S.mode === 'db' && B && B.signOut;
    var who = signedIn && B.email ? B.email() : null;
    var trashed = trashedEntries().length;
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'Settings'),
        who ? h('p', { class: 'sh-sub' }, 'Signed in as ' + who) : null,
        h('div', { class: 'stack' },
          h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () { closeSheet(); openTrash(); } },
            icon('trash', 18), 'Recently deleted' + (trashed ? ' (' + trashed + ')' : '')),
          signedIn ? h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () { openUsernameSheet(false); } },
            icon('people', 18),
            (B.myProfile && B.myProfile().tourRole) ? 'Your contact card' : 'Add your details') : null,
          signedIn ? h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () {
              confirmSheet({
                title: 'Sign out of Greenroom?',
                body: (who ? 'You\u2019re signed in as ' + who + '. ' : '') +
                  'Your tours stay safe in your account.',
                action: 'Sign out',
                onConfirm: function () { B.signOut(); return true; }
              });
            } }, icon('back', 18), 'Sign out') : null)
      ];
    }, { label: 'Settings' });
  }

  /* One artist: just the name. The numbers wait behind the doors. */
  function artistCard(name, entries) {
    var logo = artistLogo(name);
    var open = function () { go({ name: 'artist', artist: name }); };
    // The slot left of the name IS the logo: a + until they bring one in,
    // the mark itself after — tap it either way to set or swap it.
    var slot = canWrite() ? fileControl({
      label: logo ? null : '+',
      logo: logo || undefined,
      cls: 'logo-slot' + (logo ? ' has' : ''),
      accept: imageAccept(),
      ariaLabel: (logo ? 'Change' : 'Import') + ' the logo for ' + name,
      onFiles: function (files) {
        readLogoFile(files[0], async function (dataUrl) {
          if (await saveArtistLogo(name, dataUrl)) { toast('Logo in'); render(true); }
        });
      }
    }) : (logo ? h('img', { class: 'artist-logo', src: logo, alt: '' }) : null);
    return h('div', { class: 'tour-card idle name-card art-row' },
      slot,
      h('button', { class: 'art-main', type: 'button', onclick: open },
        h('span', { class: 'tc-name glow' }, name),
        icon('chevron', 20)));
  }

  /* Naming an artist: one word, one box, nothing else. */
  function viewNewArtist() {
    if (S.drafts.newArtist == null) S.drafts.newArtist = '';
    var input = h('input', {
      class: 'input big', type: 'text', id: 'na-name', 'data-k': 'na-name',
      value: S.drafts.newArtist, maxlength: 60, placeholder: 'In This Moment',
      autocomplete: 'off', enterkeyhint: 'done', autofocus: true, 'aria-label': 'Artist',
      oninput: function (e) { S.drafts.newArtist = e.target.value; }
    });
    var submit = async function (e) {
      e.preventDefault();
      var name = String(S.drafts.newArtist || '').trim();
      if (!name) { toast('Give the artist a name'); input.focus(); return; }
      blurActive();
      if (!(await registerArtist(name))) { toast('Couldn\u2019t save that name'); return; }
      delete S.drafts.newArtist;
      go({ name: 'artist', artist: name });
    };
    return h('div', { class: 'page home' },
      h('div', { class: 'headband' },
        h('header', { class: 'topbar' },
          h('button', { class: 'iconbtn back', type: 'button',
            onclick: function () { delete S.drafts.newArtist; go({ name: 'home' }); } },
            icon('back'), h('span', null, 'Artists')),
          h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
          h('div', { class: 'topbar-actions' }, h('span', { style: 'width:44px' })))),
      h('form', { class: 'sh-form', onsubmit: submit, novalidate: true, style: 'margin-top:18px' },
        field('Artist', input),
        h('button', { class: 'btn primary block', type: 'submit', style: 'margin-top:18px' }, 'Save')));
  }

  /* One artist's tours. */
  function viewArtist() {
    var name = S.route.artist || '';
    var entries = allTourEntries().filter(function (e) { return artistOf(e[1]) === name; });
    var pill = homePill();
    return h('div', { class: 'page home' },
      h('div', { class: 'headband' },
        h('header', { class: 'topbar' },
          h('span', { class: 'top-side' },
            h('button', { class: 'iconbtn back', type: 'button', onclick: function () { go({ name: 'home' }); } },
              icon('back'), h('span', null, 'Artists'))),
          h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
          h('span', { class: 'top-side right' },
            h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Settings',
              onclick: openSettingsSheet }, icon('more')))),
        h('div', { class: 'band-row' },
          h('h1', { class: 'band-name' }, name))),
      dbBanner(),
      h('div', { class: 'sec-head split' },
        h('div', null,
          h('h2', { class: 'sec-title' }, 'TOURS'),
          entries.length ? h('p', { class: 'sec-sub' }, plural(entries.length, 'run') + ' for ' + name) : null),
        canWrite()
          ? h('button', { class: 'add-mini', type: 'button',
              onclick: function () { startTour(name); } },
              h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), 'Add tour')
          : null),
      entries.length
        ? h('ul', { class: 'tour-list' }, entries.map(function (e, i) {
            var cardEl = tourCard(e[0], e[1], i + 1);
            if (!canWrite()) return h('li', null, cardEl);
            return h('li', null, swipeable(cardEl, function () {
              softDeleteTour(e[0]).then(function () { render(true); });
            }, e[1].name || 'tour'));
          }))
        : emptyState('No tours here yet', 'Add ' + name + '’s first run.'),
      h('span', { class: 'logo-mark home-mark', 'aria-hidden': 'true' }));
  }

  function startTour(artist) {
    S.drafts.wzName = '';
    S.drafts.wzArtist = typeof artist === 'string' ? artist : '';
    go({ name: 'wizard', id: null, step: 1 });
  }

  /* A worked-through tour, so the chart, the rolling number and the celebration
     have something to show. It is left a few thousand short of break even with
     tonight's show unlogged — logging that one crosses it into the green. */
  function sampleTour() {
    var today = G.tourToday();
    var d = function (n) { return G.addDays(today, n); };
    var keyed = function (list) {
      var o = {};
      list.forEach(function (r, i) { o['s' + i] = r; });
      return o;
    };
    var inc = function (g, m) {
      return { guarantee: g, merch: m, vip: 0, buyouts: 0, catering: 0, misc: 0, miscLabel: '' };
    };
    var played = [
      [-14, 'Detroit, MI', 'The Fillmore', 4000, 1200],
      [-12, 'Cleveland, OH', 'House of Blues', 4600, 1500],
      [-10, 'Pittsburgh, PA', 'Mr. Smalls', 5600, 1800],
      [-8, 'Philadelphia, PA', 'Union Transfer', 5200, 1600],
      [-6, 'Brooklyn, NY', 'Music Hall of Williamsburg', 6200, 2000],
      [-4, 'Boston, MA', 'Paradise Rock Club', 4800, 1500],
      [-2, 'Montreal, QC', 'Corona Theatre', 5800, 1800]
    ];
    var ahead = [
      [0, 'Toronto, ON', 'The Danforth'],
      [2, 'Chicago, IL', 'Metro'],
      [4, 'Minneapolis, MN', 'First Avenue'],
      [6, 'Denver, CO', 'Bluebird Theater'],
      [8, 'Salt Lake City, UT', 'The Depot']
    ];
    var shows = played.map(function (s, i) {
      return { date: d(s[0]), city: s[1], venue: s[2], income: inc(s[3], s[4]),
        loggedAt: Date.now() - (20 - i) * 3600e3, createdAt: i };
    }).concat(ahead.map(function (s, i) {
      return { date: d(s[0]), city: s[1], venue: s[2], income: G.emptyIncome(),
        loggedAt: null, createdAt: played.length + i };
    }));

    return {
      name: 'Sample tour', artist: 'Sample artist', createdAt: Date.now(), setupDone: true, setupStep: 5, sample: true,
      expenses: {
        bus: { projected: 14000, paid: 5000 },
        crew: { projected: null, paid: 0 },
        gas: { projected: 3000, paid: 0 },
        hotels: { projected: 4500, paid: 0 },
        flights: { projected: null, paid: 0 },
        production: { projected: 2500, paid: 0 },
        merch: { projected: 3000, paid: 1000 },
        misc: { projected: null, paid: 0 }
      },
      crew: keyed([
        { name: 'Sam Reyes', title: 'Tour manager', pay: 5000, createdAt: 1 },
        { name: 'Alex Kim', title: 'FOH engineer', pay: 4000, createdAt: 2 }
      ]),
      commission: {
        management: { mode: 'pct', value: 15 },
        agent: { mode: 'pct', value: 10 },
        lawyer: { mode: 'flat', value: 1500 }
      },
      debts: keyed([{ label: 'Credit card', amount: 2000, createdAt: 1 }]),
      shows: keyed(shows),
      extras: keyed([
        { date: d(-12), label: 'Parking', amount: 85, createdAt: 3 },
        { date: d(-8), label: 'Repairs', amount: 275, createdAt: 4 },
        { date: d(-4), label: 'Food', amount: 140, createdAt: 5 }
      ]),
      charges: keyed([
        { date: d(-11), merchant: 'Pilot', amount: 420, category: 'gas', importId: 'sample', createdAt: 6 },
        { date: d(-9), merchant: 'Hampton Inn', amount: 380, category: 'hotels', importId: 'sample', createdAt: 7 }
      ]),
      imports: { sample: { createdAt: Date.now() - 86400e3, count: 2, total: 800, source: 'csv' } }
    };
  }

  async function loadSample() {
    var id = newId();
    if (!(await api.create(id, sampleTour()))) return;
    delete S.lastNet[id];
    delete S.lastState[id];
    go({ name: 'tour', id: id, view: 'menu' });
    toast('Tonight’s show isn’t logged yet — log it and watch the number cross');
  }

  function tourCard(id, t, num) {
    return h('button', { class: 'tour-card idle name-card', type: 'button', onclick: function () { openTour(id); } },
      h('div', { class: 'tc-top' },
        num ? h('span', { class: 'tour-num num', 'aria-hidden': 'true' }, String(num)) : null,
        h('div', { class: 'tc-name glow' + (num ? ' centered' : '') }, t.name || 'Untitled tour'),
        icon('chevron', 20)));
  }

  /* ============================== Views: setup wizard ============================== */

  function viewWizard() {
    var id = S.route.id;
    var step = S.route.step || 1;
    var t = id ? getTour(id) : null;
    if (id && !t) {
      return h('div', { class: 'page' },
        h('header', { class: 'topbar' }, backBtn()), emptyState('Saving the tour…', null));
    }
    var exit = function () { return id ? go({ name: 'tour', id: id, view: 'menu' }) : go({ name: 'home' }); };
    var head = h('div', { class: 'wz-head' },
      h('div', { class: 'wz-bar', 'aria-hidden': 'true' }, [1, 2].map(function (n) {
        return h('i', { class: n <= step ? 'on' : null });
      })),
      h('div', { class: 'wz-meta' },
        h('span', null, 'Step ' + step + ' of 2'),
        h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
        h('button', { class: 'linkbtn', type: 'button', onclick: exit }, id ? 'Finish later' : 'Cancel')));

    var body;
    // Costs and debts are no longer asked here — the Expenses tab owns both.
    if (step >= 2) body = wzShows(id, t);
    else body = wzName(id, t);
    return h('div', { class: 'page wizard' }, head, body);
  }

  function wzFoot(back, label, onNext) {
    return h('div', { class: 'wz-foot' },
      back ? h('button', { class: 'btn ghost', type: 'button', onclick: back }, 'Back') : null,
      onNext
        ? h('button', { class: 'btn primary', type: 'button', onclick: onNext }, label)
        : h('button', { class: 'btn primary', type: 'submit' }, label));
  }

  function artistDatalist() {
    var names = {};
    allTourEntries().forEach(function (e) {
      var a = artistOf(e[1]);
      if (a) names[a] = true;
    });
    return h('datalist', { id: 'gr-artists' },
      Object.keys(names).map(function (n) { return h('option', { value: n }); }));
  }

  function wzName(id, t) {
    if (S.drafts.wzName == null) S.drafts.wzName = t ? t.name || '' : '';
    if (S.drafts.wzArtist == null) S.drafts.wzArtist = t ? String(t.artist || '') : '';
    var input = h('input', {
      class: 'input big', type: 'text', id: 'wz-name', 'data-k': 'wz-name',
      value: S.drafts.wzName, maxlength: 80, placeholder: 'Fall headliner 2026',
      autocomplete: 'off', enterkeyhint: 'next', autofocus: !!S.drafts.wzArtist, 'aria-label': 'Tour name',
      oninput: function (e) { S.drafts.wzName = e.target.value; }
    });
    var artistInput = h('input', {
      class: 'input big', type: 'text', id: 'wz-artist', 'data-k': 'wz-artist', list: 'gr-artists',
      value: S.drafts.wzArtist, maxlength: 60, placeholder: 'In This Moment',
      autocomplete: 'off', enterkeyhint: 'next', 'aria-label': 'Artist',
      autofocus: !S.drafts.wzArtist,
      oninput: function (e) { S.drafts.wzArtist = e.target.value; }
    });
    var submit = async function (e) {
      e.preventDefault();
      var name = String(S.drafts.wzName || '').trim();
      var artist = String(S.drafts.wzArtist || '').trim();
      if (!artist) { toast('Who\u2019s this tour for? Name the artist first'); artistInput.focus(); return; }
      if (!name) { toast('Give the tour a name to keep going'); input.focus(); return; }
      blurActive();
      var tid = id;
      if (tid) {
        if (!(await api.update(tid, { name: name, artist: artist }))) return;
      } else {
        tid = newId();
        var doc = {
          name: name, artist: artist, createdAt: Date.now(), setupDone: false, setupStep: 2,
          expenses: G.emptyExpenses(), commission: G.emptyCommission(),
          crew: {}, debts: {}, shows: {}, extras: {}, charges: {}, imports: {}
        };
        if (!(await api.create(tid, doc))) return;
      }
      delete S.drafts.wzName;
      delete S.drafts.wzArtist;
      go({ name: 'wizard', id: tid, step: 2 });
    };
    var known = String(S.drafts.wzArtist || '').trim();
    return h('form', { class: 'wz-body', onsubmit: submit, novalidate: true },
      known ? null : [field('Artist', artistInput), artistDatalist()],
      field('Tour', input),
      wzFoot(null, 'Next'));
  }


  function wzShows(id, t) {
    var shows = G.rows(t.shows).sort(G.byDate);
    return h('div', { class: 'wz-body' },
      h('h1', { class: 'wz-title' }, 'Add your shows'),
      h('p', { class: 'wz-sub' }, S.sample
        ? 'Upload the tour flyer and the dates fill themselves in \u2014 they land in OVERVIEW and BUDGET both.'
        : 'Each date and city \u2014 they land in OVERVIEW and BUDGET both.'),
      S.sample
        ? h('div', { class: 'stack', style: 'margin-top:0;margin-bottom:18px' },
            fileControl({
              label: 'Upload flyer', icon: 'flyer', cls: 'btn primary block',
              accept: imageAccept(),
              onFiles: function (files) { readFlyer(id, files[0]); }
            }),
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openShowSheet(id); } },
              icon('plus', 18), 'Add them by hand'))
        : h('div', { class: 'btnrow' },
            h('button', { class: 'btn primary', type: 'button', onclick: function () { openShowSheet(id); } },
              icon('plus', 18), 'Add show')),
      shows.length
        ? h('ul', { class: 'shows' }, shows.map(function (s) {
            return h('li', null, h('button', {
              class: 'show-row', type: 'button', onclick: function () { openShowSheet(id, s.id); }
            }, dateBlock(s.date), whereBlock(s), icon('chevron', 18)));
          }))
        : null,
      wzFoot(function () { go({ name: 'wizard', id: id, step: 1 }); }, 'Finish', function () {
        blurActive();
        S.lastNet[id] = 0; // count in from zero the first time the hero is seen
        go({ name: 'tour', id: id, view: 'details' });
        api.update(id, { setupDone: true, setupStep: 5 });
      }));
  }

  /* ============================== Expenses ============================== */

  /* Other tours whose budget is worth borrowing: same artist first, newest first. */
  function baselineCandidates(id) {
    var me = getTour(id);
    var myArtist = me ? String(me.artist || '') : '';
    return allTourEntries().filter(function (e) {
      return e[0] !== id && G.hasBudget(e[1]);
    }).sort(function (a, b) {
      var sa = String(a[1].artist || '') === myArtist ? 0 : 1;
      var sb = String(b[1].artist || '') === myArtist ? 0 : 1;
      return sa - sb || (b[1].createdAt || 0) - (a[1].createdAt || 0);
    });
  }

  function budgetIsBlank(t) {
    var b = G.budgetFrom(t);
    if (b.total > 0 || b.commissionSummary) return false;
    var exp = G.normExpenses(t && t.expenses);
    return Object.keys(exp).every(function (k) { return !exp[k].paid; });
  }

  function openBaselinePicker(id, afterApply) {
    var cands = baselineCandidates(id);
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'Start from a previous tour'),
        h('p', { class: 'sh-sub' }, 'Copies that tour\u2019s projections and commission deal as your starting budget \u2014 never what was actually spent. Tweak anything after.'),
        h('div', { class: 'ledger' }, cands.map(function (e) {
          var b = G.budgetFrom(e[1]);
          return h('button', { class: 'row rowbtn', type: 'button',
            onclick: async function () {
              delete S.drafts['exp:' + id];
              if (await api.update(id, { expenses: b.expenses, commission: b.commission })) {
                closeSheet();
                toast('Budget started from ' + (e[1].name || 'that tour') + ' \u2014 tweak anything');
                if (afterApply) afterApply(); else render(true);
              }
            } },
            h('div', { class: 'row-label' },
              (e[1].artist ? e[1].artist + ' \u2014 ' : '') + (e[1].name || 'Untitled tour'),
              h('span', { class: 'hint' }, [b.total ? money(b.total) + ' projected' : '',
                b.commissionSummary].filter(Boolean).join(' \u00b7 '))),
            icon('chevron', 18));
        })),
        h('button', { class: 'btn ghost block', type: 'button', style: 'margin-top:14px',
          onclick: function () { closeSheet(); } }, 'Start from scratch instead')
      ];
    }, { label: 'Start from a previous tour' });
  }

  function expenseDraft(id, mode) {
    var t = getTour(id);
    var key = 'exp:' + id;
    var d = S.drafts[key];
    if (!d || (mode === 'tab' && !d.dirty)) {
      d = S.drafts[key] = {
        expenses: G.normExpenses(t && t.expenses),
        commission: G.normCommission(t && t.commission),
        dirty: false
      };
    }
    return d;
  }

  // The wizard's fast pass: one projected number per category, in a single list.
  function expensesEditor(id, mode) {
    var t = getTour(id);
    var d = expenseDraft(id, mode);
    var base = G.calc(t);
    var totalEl = h('strong', { class: 'amt num' }, '');
    var note = h('p', { class: 'note' }, '');

    function projectedFor(k) {
      return k === 'crew' ? (G.crewProjection(t) || null)
        : (d.expenses[k] ? d.expenses[k].projected : null);
    }
    function draftTotal() {
      var sum = 0;
      G.typedCategoriesFor(t).forEach(function (cat) {
        var p = projectedFor(cat.key);
        var paid = G.num(d.expenses[cat.key].paid) + chargedTo(t, cat.key);
        sum += p == null ? paid : Math.max(p, paid);
      });
      return sum + G.commissionTotal(d.commission, base.income, base.guarantees, base.incomeBy);
    }
    function refresh() {
      var total = draftTotal();
      totalEl.textContent = money(total);
      var anyPct = G.COMMISSION_LINES.some(function (l) {
        return d.commission[l.key].mode === 'pct' && G.num(d.commission[l.key].value) > 0;
      });
      note.textContent = anyPct ? 'Percentage commissions are worked out from income as you log each show.' : '';
      note.hidden = !anyPct;
      if (S.runningLed) $('.amt', S.runningLed).textContent = money(-total, true);
    }
    var changed = function () { d.dirty = true; refresh(); };

    var rows = G.typedCategoriesFor(t).map(function (cat) {
      if (cat.key === 'crew') return crewRow(id, t);
      var rec = d.expenses[cat.key] || (d.expenses[cat.key] = { projected: null, paid: 0 });
      var paid = G.num(rec.paid) + chargedTo(t, cat.key);
      return h('div', { class: 'row' },
        h('div', { class: 'row-label' },
          h('label', { for: 'exp-' + cat.key }, cat.label),
          paid > 0 ? h('span', { class: 'hint' }, money(paid) + ' paid so far') : null),
        moneyInput({
          id: 'exp-' + cat.key, value: rec.projected, slim: true,
          label: cat.label + ' projected cost', placeholder: '—',
          onValue: function (v) { rec.projected = v > 0 ? v : null; changed(); }
        }));
    });

    rows.push(h('div', { class: 'row head' }, h('span', null, 'Commission')));
    G.COMMISSION_LINES.forEach(function (line) { rows.push(commissionRow(d, line, changed)); });
    rows.push(h('div', { class: 'row total' },
      h('span', null, 'What the tour costs'), totalEl));

    refresh();
    return [h('div', { class: 'ledger' }, rows), note];
  }

  function chargedTo(tour, key) {
    return G.rows(tour && tour.charges).reduce(function (sum, ch) {
      return ch.category === key ? sum + G.num(ch.amount) : sum;
    }, 0);
  }

  function commissionRow(d, line, changed) {
    var r = d.commission[line.key];
    var holder = h('div', null);
    var hint = h('span', { class: 'hint' }, '');
    function setHint() {
      hint.textContent = r.mode === 'pct' ? 'of ' + G.commissionBaseLabel(r) : 'flat amount';
    }
    // Every team's deal is different: a % deal picks which income it comes
    // out of, one chip per stream.
    var chipRow = h('div', { class: 'row stackrow cbase' });
    function buildChips() {
      if (r.mode !== 'pct') { chipRow.replaceChildren(); chipRow.hidden = true; return; }
      chipRow.hidden = false;
      chipRow.replaceChildren.apply(chipRow, G.INCOME_FIELDS.map(function (f) {
        var b = h('button', {
          class: 'cbase-chip', type: 'button',
          'aria-pressed': r.base && r.base[f.key] ? 'true' : 'false',
          onclick: function () {
            if (!r.base) r.base = {};
            r.base[f.key] = !r.base[f.key];
            b.setAttribute('aria-pressed', r.base[f.key] ? 'true' : 'false');
            setHint(); changed();
          }
        }, f.key === 'guarantee' ? 'Guarantees' : f.label);
        return b;
      }));
    }
    function build() {
      holder.replaceChildren(moneyInput({
        id: 'comm-' + line.key, key: 'comm-' + line.key + '-' + r.mode, slim: true,
        value: r.value, pct: r.mode === 'pct',
        label: line.label + (r.mode === 'pct' ? ' commission, percent' : ' commission'),
        onValue: function (v) { r.value = v; changed(); }
      }));
    }
    var seg = segmented(['$', '%'], r.mode === 'pct' ? 1 : 0, function (i) {
      var m = i ? 'pct' : 'flat';
      if (m === r.mode) return;
      r.mode = m; r.value = 0; build(); buildChips(); setHint(); changed();
    }, line.label + ' commission type');
    build(); buildChips(); setHint();
    return [h('div', { class: 'row' },
      h('div', { class: 'row-label' },
        h('label', { for: 'comm-' + line.key }, line.label),
        h('div', { class: 'comm-sub' }, seg, hint)),
      holder), chipRow];
  }

  function crewRow(id, t) {
    var crew = G.rows(t && t.crew);
    var total = G.crewProjection(t);
    var paid = G.num((G.normExpenses(t && t.expenses)).crew.paid) + chargedTo(t, 'crew');
    return h('button', {
      class: 'row rowbtn', type: 'button', onclick: function () { openCrewSheet(id); }
    },
      h('div', { class: 'row-label' }, 'Crew',
        h('span', { class: 'hint' }, crew.length
          ? plural(crew.length, 'person').replace('persons', 'people') +
            (paid > 0 ? ' · ' + money(paid) + ' paid' : '')
          : 'Add who’s out with you')),
      h('span', { class: 'amt num' }, total ? money(total) : '—'),
      icon('chevron', 18));
  }

  async function saveExpenses(id, extra) {
    var key = 'exp:' + id;
    var d = S.drafts[key];
    var t = getTour(id);
    var patch = Object.assign({
      expenses: d ? d.expenses : G.normExpenses(t && t.expenses),
      commission: d ? d.commission : G.normCommission(t && t.commission)
    }, extra || {});
    var ok = await api.update(id, patch);
    if (ok) delete S.drafts[key];
    return ok;
  }

  /* Expenses tab: one row per category, each opening its own sheet. */
  function cardBit(l) {
    if (!l.cards || !l.cards.length) return '';
    return ' · ' + l.cards.map(function (r) {
      return money(r.amount) + (r.leftover ? ' left over from ' : ' on ') + r.label;
    }).join(', ') + ' going in';
  }
  function lineHint(l) {
    if (l.over > 0) return { text: 'Over by ' + money(l.over) + ' · ' + money(l.paid) + ' paid' + cardBit(l), cls: ' over' };
    if (l.key === 'commission') {
      return { text: l.paid > 0 ? money(l.paid) + ' paid so far' : 'Worked out from income as you log shows', cls: '' };
    }
    if (l.projected == null) {
      return { text: l.paid > 0 ? money(l.paid) + ' so far' + cardBit(l) : '', cls: '' };
    }
    if (l.left === 0) return { text: 'All ' + money(l.paid) + ' paid' + cardBit(l), cls: ' done' };
    return { text: money(l.paid) + ' paid · ' + money(l.left) + ' left to pay' + cardBit(l), cls: '' };
  }

  function tabExpenses(id, t, c) {
    var rows = c.lines.map(function (l) {
      var hint = lineHint(l);
      var amount = money(l.effective); // what the category actually counts against the tour
      var inner = [
        h('div', { class: 'row-label' }, l.label,
          hint.text ? h('span', { class: 'hint' + hint.cls }, hint.text) : null),
        h('span', { class: 'amt num glow' }, amount)
      ];
      if (!canEditTour(id)) return h('div', { class: 'row' }, inner);
      return h('button', {
        class: 'row rowbtn', type: 'button',
        onclick: function () {
          if (l.key === 'crew') openCrewSheet(id);
          else if (l.key === 'commission') openCommissionSheet(id);
          else openCategorySheet(id, l.key);
        }
      }, inner, icon('chevron', 18));
    });
    rows.push(h('div', { class: 'row total' },
      h('span', null, 'What the tour costs'),
      h('strong', { class: 'amt num glow' }, money(c.fixed + c.commission))));
    var charges = G.rows(t && t.charges);
    var baselineOffer = (canEditTour(id) && budgetIsBlank(t) && !charges.length && baselineCandidates(id).length)
      ? h('button', { class: 'btn quiet block', type: 'button', style: 'margin-bottom:14px',
          onclick: function () { openBaselinePicker(id); } },
          icon('copy', 18), 'Start from a previous tour’s budget')
      : null;
    return [
      baselineOffer,
      h('div', { class: 'btnrow' },
        canEditTour(id) ? fileControl({
          label: 'Import card statement', icon: 'card', cls: 'btn ghost',
          accept: '.csv,.tsv,text/csv,application/pdf,' + imageAccept(), multiple: true,
          onFiles: function (files) { readStatement(id, files); }
        }) : null,
        h('button', { class: 'btn ghost', type: 'button',
          onclick: function () { go({ name: 'tour', id: id, view: 'daybyday' }); } },
          icon('edit', 18), 'Log an expense')),
      h('div', { class: 'ledger' }, rows),
      canEditTour(id) ? h('p', { class: 'note' }, 'Tap a category to set what you expect it to cost and what you’ve already paid.') : null,
      // Debts logged before Credit card and Loan became plain categories still
      // count, so a tour that has them keeps its ledger; fresh tours never see it.
      G.rows(t && t.debts).length ? [
        h('h3', { class: 'sh-h3', style: 'margin-top:26px' }, 'What you owe going in'),
        debtSection(id, t, 'tab')
      ] : null,
      charges.length ? h('button', {
        class: 'btn quiet block', type: 'button', style: 'margin-top:14px',
        onclick: function () { openChargesSheet(id); }
      }, icon('card', 18), plural(charges.length, 'card charge')) : null
    ];
  }

  function openCategorySheet(id, key) {
    var t = getTour(id);
    var cat = G.typedCategoriesFor(t).filter(function (c) { return c.key === key; })[0];
    var rec = G.normExpenses(t && t.expenses)[key] || { projected: null, paid: 0 };
    var f = { projected: rec.projected, paid: G.num(rec.paid) };
    var charged = chargedTo(t, key);
    var onCards = (G.cardPaidDetail(t)[key] || []);
    var cardTotal = onCards.reduce(function (a, r) { return a + r.amount; }, 0);

    openSheet(function () {
      var readout = h('div', { class: 'preview' });
      function refresh() {
        var paid = f.paid + charged + cardTotal;
        var p = f.projected;
        var kids = [
          h('div', null, h('span', null, 'Projected'),
            h('strong', { class: 'num' }, p == null ? 'Not set' : money(p))),
          h('div', null, h('span', null, 'Paid so far'), h('strong', { class: 'num' }, money(paid)))
        ];
        if (p == null) {
          kids.push(h('div', null, h('span', null, 'Counts as'), h('strong', { class: 'num' }, money(paid))));
        } else if (paid > p) {
          kids.push(h('div', null, h('span', null, 'Over by'),
            h('strong', { class: 'num neg' }, money(paid - p))));
        } else {
          kids.push(h('div', null, h('span', null, 'Left to pay'),
            h('strong', { class: 'num' }, money(p - paid))));
        }
        readout.replaceChildren.apply(readout, kids);
      }
      var submit = async function (e) {
        e.preventDefault();
        blurActive();
        var patch = { expenses: {} };
        patch.expenses[key] = { projected: f.projected, paid: f.paid };
        if (await api.update(id, patch)) {
          delete S.drafts['exp:' + id];
          closeSheet(); toast(cat.label + ' saved'); render(true);
        }
      };
      var form = h('form', { class: 'sh-form', onsubmit: submit, novalidate: true },
          field('Projected for the whole tour', moneyInput({
            id: 'cat-proj', value: f.projected, label: cat.label + ' projected cost',
            placeholder: '—', nextId: 'cat-paid',
            onValue: function (v) { f.projected = v > 0 ? v : null; refresh(); }
          }), 'Leave this blank and the category just totals what actually gets spent.'),
          field('Already paid', moneyInput({
            id: 'cat-paid', value: f.paid, label: cat.label + ' already paid', last: true,
            onValue: function (v) { f.paid = v; refresh(); }
          }), [
            charged > 0 ? money(charged) + ' of imported charges is counted on top of this. ' : '',
            onCards.map(function (r) {
              return money(r.amount) + (r.leftover ? ' left over from ' : ' on ') + r.label + ' going in. ';
            }).join(''),
            (!charged && !onCards.length) ? 'Deposits or anything settled up front.' : ''
          ].join('')),
          readout,
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Save'),
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel')));
      refresh();
      return [
        h('h2', { class: 'sh-title' }, cat.label),
        cat.note ? h('p', { class: 'sh-sub' }, cat.note) : null,
        form
      ];
    }, { label: cat.label });
  }

  function openCommissionSheet(id) {
    var t = getTour(id);
    var base = G.calc(t);
    var d = { commission: G.normCommission(t && t.commission) };
    openSheet(function () {
      var readout = h('div', { class: 'preview' });
      function refresh() {
        var kids = G.COMMISSION_LINES.map(function (line) {
          var v = G.commissionLine(line, d.commission[line.key], base.income, base.guarantees, base.incomeBy);
          return h('div', null, h('span', null, line.label), h('strong', { class: 'num' }, money(v)));
        });
        kids.push(h('div', null, h('span', null, 'Commission so far'),
          h('strong', { class: 'num' }, money(G.commissionTotal(d.commission, base.income, base.guarantees, base.incomeBy)))));
        readout.replaceChildren.apply(readout, kids);
      }
      var rows = G.COMMISSION_LINES.map(function (line) {
        return commissionRow(d, line, refresh);
      });
      var submit = async function (e) {
        e.preventDefault();
        blurActive();
        if (await api.update(id, { commission: d.commission })) {
          delete S.drafts['exp:' + id];
          closeSheet(); toast('Commission saved'); render(true);
        }
      };
      refresh();
      return [
        h('h2', { class: 'sh-title' }, 'Commission'),
        h('p', { class: 'sh-sub' }, 'Every team\u2019s deal is different \u2014 set the cut, then check which pieces of the income it comes out of.'),
        h('form', { class: 'sh-form', onsubmit: submit, novalidate: true },
          h('div', { class: 'ledger' }, rows),
          readout,
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Save commission'),
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel')))
      ];
    }, { label: 'Commission' });
  }

  /* ============================== Crew ============================== */

  function openCrewSheet(id) {
    function build() {
      var t = getTour(id);
      var crew = G.rows(t && t.crew).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      var total = G.crewProjection(t);
      var exp = G.normExpenses(t && t.expenses);
      var paid = G.num(exp.crew.paid);

      var list = crew.length
        ? h('div', { class: 'ledger' },
            crew.map(function (p) {
              return canWrite()
                ? h('button', { class: 'row rowbtn', type: 'button', onclick: function () { openCrewPerson(id, p); } },
                    h('div', { class: 'row-label' }, p.name || 'Crew',
                      h('span', { class: 'hint' }, p.title || 'No title')),
                    h('span', { class: 'amt num' }, money(G.num(p.pay))), icon('chevron', 18))
                : h('div', { class: 'row' },
                    h('div', { class: 'row-label' }, p.name || 'Crew',
                      h('span', { class: 'hint' }, p.title || 'No title')),
                    h('span', { class: 'amt num' }, money(G.num(p.pay))));
            }),
            h('div', { class: 'row total' },
              h('span', null, 'Crew projection'), h('strong', { class: 'amt num' }, money(total))))
        : emptyState('No crew yet', canWrite()
            ? 'Add everyone out with you and what they’re paid for the whole tour. The total becomes your crew projection.'
            : 'No crew has been added.');

      var onTour = {};
      crew.forEach(function (pp) { onTour[G.crewKey(pp.name)] = true; });
      var bench = rosterList().filter(function (r) { return !onTour[G.crewKey(r.name)]; });
      var benchRow = null;
      if (canWrite() && bench.length) {
        benchRow = h('div', { style: 'margin-bottom:16px' },
          h('p', { class: 'note', style: 'margin:0 2px 8px' }, 'From past tours — tap to add:'),
          h('div', { class: 'chips', style: 'margin:0' }, bench.map(function (r) {
            return h('button', { class: 'chip', type: 'button',
              onclick: async function () {
                var patch = {};
                patch[newId()] = { name: r.name, title: r.title || '', pay: G.num(r.pay), createdAt: Date.now() };
                if (await api.update(id, { crew: patch })) {
                  delete S.drafts['exp:' + id];
                  toast(r.name + ' added' + (r.pay ? ' at ' + money(G.num(r.pay)) : ''));
                  openCrewSheet(id); render(true);
                }
              } }, r.name + (r.title ? ' · ' + r.title : ''));
          })),
          h('button', { class: 'linkbtn', type: 'button', style: 'min-height:32px',
            onclick: function () { openRosterManager(id); } }, 'Manage saved crew'));
      }
      return [
        h('h2', { class: 'sh-title' }, 'Crew'),
        h('p', { class: 'sh-sub' }, 'Each person’s pay is their total for the tour.'),
        benchRow,
        canWrite() ? h('button', {
          class: 'btn primary block', type: 'button', style: 'margin-bottom:16px',
          onclick: function () { openCrewPerson(id, null); }
        }, icon('plus', 18), 'Add someone') : null,
        list,
        canWrite() ? h('div', { style: 'margin-top:18px' },
          field('Already paid to crew',
            moneyInput({
              id: 'crew-paid', value: paid, label: 'Already paid to crew',
              onValue: function (v) { S.drafts['crewPaid:' + id] = v; }
            }),
            'Advances or per diems you’ve already handed out.'),
          h('button', {
            class: 'btn ghost block', type: 'button',
            onclick: async function () {
              var v = S.drafts['crewPaid:' + id];
              if (v == null) { closeSheet(); return; }
              if (await api.update(id, { expenses: { crew: { paid: v } } })) {
                delete S.drafts['crewPaid:' + id];
                delete S.drafts['exp:' + id];
                toast('Saved'); closeSheet(); render(true);
              }
            }
          }, 'Save what’s paid')) : null
      ];
    }
    openSheet(build, { label: 'Crew' });
  }

  function openRosterManager(tourId) {
    function build() {
      var people = rosterList();
      openSheet(function () {
        return [
          h('h2', { class: 'sh-title' }, 'Saved crew'),
          h('p', { class: 'sh-sub' }, 'The people Greenroom remembers for every tour.'),
          people.length ? h('div', { class: 'ledger' }, people.map(function (r) {
            return h('div', { class: 'row' },
              h('div', { class: 'row-label' }, r.name,
                h('span', { class: 'hint' },
                  [r.title, r.pay ? money(G.num(r.pay)) + ' a tour' : ''].filter(Boolean).join(' \u00b7 ') || 'No details')),
              h('button', { class: 'iconbtn sm', type: 'button', 'aria-label': 'Forget ' + r.name,
                onclick: async function () {
                  await rosterRemove(r.name);
                  toast('Forgot ' + r.name);
                  build();
                } }, icon('trash', 18)));
          })) : emptyState('Nobody saved yet',
            'When you add crew to a tour, Greenroom offers to remember them here.'),
          h('button', { class: 'btn ghost block', type: 'button', style: 'margin-top:14px',
            onclick: function () { openCrewSheet(tourId); } }, 'Back to crew')
        ];
      }, { label: 'Saved crew' });
    }
    build();
  }

  function openCrewPerson(id, person) {
    var f = {
      name: person ? person.name || '' : '',
      title: person ? person.title || '' : '',
      pay: person ? G.num(person.pay) : 0
    };
    openSheet(function () {
      var titleInput;
      var nameInput = h('input', {
        class: 'input', type: 'text', value: f.name, maxlength: 60, autocomplete: 'off',
        placeholder: 'Name', autofocus: !person, enterkeyhint: 'next',
        oninput: function (e) { f.name = e.target.value; }
      });
      titleInput = h('input', {
        class: 'input', type: 'text', value: f.title, maxlength: 60, autocomplete: 'off',
        placeholder: 'What they do', enterkeyhint: 'next',
        oninput: function (e) { f.title = e.target.value; if (chips) chips.sync(f.title); }
      });
      var chips = chipRow(G.CREW_TITLES, f.title, function (v) { f.title = v; titleInput.value = v; });

      var submit = async function (e) {
        e.preventDefault();
        var name = f.name.trim();
        if (!name) { toast('Add a name so you know who this is'); nameInput.focus(); return; }
        blurActive();
        var row = { name: name, title: f.title.trim(), pay: f.pay };
        var patch = {};
        if (person) patch[person.id] = row;
        else { row.createdAt = Date.now(); patch[newId()] = row; }
        if (await api.update(id, { crew: patch })) {
          delete S.drafts['exp:' + id];
          render(true);
          if (!person && !rosterHas(name)) {
            confirmSheet({
              title: 'Save ' + name + ' for future tours?',
              body: 'They’ll be one tap to add on the next run — title and pay come along, and you can still change either.',
              action: 'Save for future tours',
              onConfirm: async function () {
                await rosterSave(row);
                toast(name + ' saved to your crew');
                setTimeout(function () { openCrewSheet(id); }, 250);
                return true;
              }
            });
            // Cancel path lands back on the crew sheet too
            var prevClose = sheet && sheet.onClose;
            if (sheet) sheet.onClose = function () {
              if (prevClose) prevClose();
              setTimeout(function () { if (!sheet) openCrewSheet(id); }, 250);
            };
          } else {
            toast(person ? 'Crew saved' : 'Added ' + name);
            openCrewSheet(id);
          }
        }
      };
      return [
        h('h2', { class: 'sh-title' }, person ? 'Edit crew' : 'Add crew'),
        h('form', { class: 'sh-form', onsubmit: submit, novalidate: true },
          field('Name', nameInput),
          field('Title', titleInput),
          chips,
          field('Pay for the tour', moneyInput({
            id: 'crew-pay', value: f.pay, label: 'Pay for the whole tour', last: true,
            onValue: function (v) { f.pay = v; }
          })),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, person ? 'Save' : 'Add to crew'),
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openCrewSheet(id); } }, 'Back to crew'),
            person ? h('button', {
              class: 'btn danger block', type: 'button',
              onclick: function () {
                confirmSheet({
                  title: 'Remove ' + (person.name || 'this person') + '?',
                  body: money(G.num(person.pay)) + ' comes off the crew projection.',
                  action: 'Remove', danger: true,
                  onConfirm: async function () {
                    var patch = {}; patch[person.id] = null;
                    var ok = await api.update(id, { crew: patch });
                    if (ok) { delete S.drafts['exp:' + id]; toast('Removed'); }
                    return ok;
                  }
                });
              }
            }, 'Remove from crew') : null))
      ];
    }, { label: person ? 'Edit crew' : 'Add crew' });
  }

  /* ============================== Debt ============================== */

  function debtSection(id, t, mode) {
    var cards = G.cardDebts(t).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    var others = G.otherDebts(t).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    var total = others.reduce(function (s, d) { return s + G.num(d.amount); }, 0);
    var parts = [];

    cards.forEach(function (card) { parts.push(cardBlock(id, card)); });
    if (canWrite()) parts.push(addDebtForm(id, cards.length === 0));

    if (others.length) {
      parts.push(h('div', { class: 'ledger' },
        others.map(function (d) {
          return canWrite()
            ? h('button', { class: 'row rowbtn', type: 'button', onclick: function () { openDebtSheet(id, d); } },
                h('span', { class: 'row-label' }, d.label || 'Debt'),
                h('span', { class: 'amt num' }, money(G.num(d.amount))), icon('chevron', 18))
            : h('div', { class: 'row' },
                h('span', { class: 'row-label' }, d.label || 'Debt'),
                h('span', { class: 'amt num' }, money(G.num(d.amount))));
        }),
        h('div', { class: 'row total' },
          h('span', null, 'To pay off'), h('strong', { class: 'amt num' }, money(total)))));
    } else if (mode === 'tab' && !cards.length) {
      parts.push(emptyState('Nothing owed going in', canWrite()
        ? 'Add the card balance you’re carrying into the tour, or a loan or gear payment.'
        : 'This tour carries nothing in.'));
    }
    return parts;
  }

  /* One card: its balance, and an optional breakdown of where that money went.
     Whatever isn't broken down goes to Misc — plainly said, never required. */
  function cardBlock(tourId, card) {
    var s = G.cardSummary(card);
    var bd = G.isObj(card.breakdown) ? card.breakdown : {};
    var used = Object.keys(bd).filter(function (k) { return G.num(bd[k]) > 0; });

    var kids = [
      h('div', { class: 'row' },
        h('div', { class: 'row-label' }, s.label,
          h('span', { class: 'hint' }, 'Balance going into the tour')),
        h('span', { class: 'amt num' }, money(s.balance)),
        canWrite() ? h('button', {
          class: 'iconbtn sm', type: 'button', 'aria-label': 'Edit ' + s.label,
          onclick: function () { openCardSheet(tourId, card); }
        }, icon('edit', 18)) : null)
    ];
    used.forEach(function (k) {
      var cat = G.TYPED_CATEGORIES.filter(function (c) { return c.key === k; })[0];
      kids.push(h('div', { class: 'row bd-row' },
        h('span', { class: 'row-label' }, cat ? cat.label : k),
        h('span', { class: 'amt num' }, money(G.num(bd[k])))));
    });
    if (s.over > 0) {
      kids.push(h('div', { class: 'row bd-row' },
        h('span', { class: 'row-label hint over' },
          'That’s ' + money(s.over) + ' more than the balance — trim a line'),
        h('span', null)));
    } else {
      kids.push(h('div', { class: 'row bd-row' },
        h('span', { class: 'row-label' },
          h('span', { class: 'hint' }, used.length
            ? money(s.accounted) + ' of ' + money(s.balance) + ' accounted for' +
              (s.remainder > 0 ? ' · ' + money(s.remainder) + ' left over goes to Misc' : '')
            : 'Break it down by category if you remember — or don’t, and it all goes to Misc')),
        canWrite() ? h('button', {
          class: 'btn sm quiet', type: 'button',
          onclick: function () { openCardSheet(tourId, card); }
        }, used.length ? 'Edit breakdown' : 'Break it down') : null));
    }
    return h('div', { class: 'ledger', style: 'margin-bottom:14px' }, kids);
  }

  function addDebtForm(id, leadWithCard) {
    var key = 'debt:' + id;
    var f = S.drafts[key] || (S.drafts[key] = { label: '', amount: 0, kind: leadWithCard ? 'card' : 'card' });
    var labelInput = h('input', {
      class: 'input', type: 'text', id: 'debt-label', 'data-k': 'debt-label', value: f.label,
      maxlength: 60, autocomplete: 'off',
      placeholder: f.kind === 'card' ? 'Which card? e.g. Amex' : 'What is it? e.g. Trailer loan',
      'aria-label': 'Name it', enterkeyhint: 'next',
      oninput: function (e) { f.label = e.target.value; },
      onkeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); advance(e.target); } }
    });
    var seg = segmented(['Card balance', 'Loan or other'], f.kind === 'card' ? 0 : 1, function (i) {
      f.kind = i === 0 ? 'card' : 'other';
      labelInput.placeholder = f.kind === 'card' ? 'Which card? e.g. Amex' : 'What is it? e.g. Trailer loan';
    }, 'What kind of debt');
    var submit = async function (e) {
      e.preventDefault();
      var label = f.label.trim() || (f.kind === 'card' ? 'Card' : '');
      if (!label) { toast('Name it first, like “Trailer loan”'); labelInput.focus(); return; }
      if (!(f.amount > 0)) { toast('Enter how much is owed'); return; }
      blurActive();
      var did = newId();
      var patch = {};
      patch[did] = f.kind === 'card'
        ? { label: label, amount: f.amount, kind: 'card', cutoff: null, breakdown: {}, createdAt: Date.now() }
        : { label: label, amount: f.amount, createdAt: Date.now() };
      if (await api.update(id, { debts: patch })) {
        delete S.drafts[key];
        toast(f.kind === 'card'
          ? label + ' added — break it down if you remember where it went'
          : 'Added ' + label);
        render(true);
      }
    };
    return h('form', { class: 'card addform', onsubmit: submit, novalidate: true },
      h('div', { style: 'margin-bottom:12px' }, seg),
      h('div', { class: 'af-row' }, labelInput,
        moneyInput({ id: 'debt-amount', value: f.amount, slim: true, label: 'Amount owed', last: true,
          onValue: function (v) { f.amount = v; } })),
      h('button', { class: 'btn quiet block', type: 'submit', style: 'margin-top:12px' }, 'Add'));
  }

  /* The card editor: balance, the breakdown, and the statement cutoff date. */
  function openCardSheet(tourId, card) {
    var f = {
      label: card.label || 'Card',
      amount: G.num(card.amount),
      cutoff: card.cutoff || '',
      bd: {}
    };
    var src = G.isObj(card.breakdown) ? card.breakdown : {};
    G.typedCategoriesFor(getTour(tourId)).forEach(function (c) { if (G.num(src[c.key]) > 0) f.bd[c.key] = G.num(src[c.key]); });

    openSheet(function () {
      var tally = h('p', { class: 'note', 'aria-live': 'polite' }, '');
      var rowsHost = h('div', { class: 'ledger' });

      function refresh() {
        var acc = 0;
        Object.keys(f.bd).forEach(function (k) { acc += G.num(f.bd[k]); });
        if (acc > f.amount) {
          tally.textContent = 'That’s ' + money(acc - f.amount) + ' more than the balance — trim a line.';
          tally.className = 'note over-note';
        } else {
          var left = f.amount - acc;
          tally.textContent = acc
            ? money(acc) + ' of ' + money(f.amount) + ' accounted for' +
              (left > 0 ? ' · ' + money(left) + ' left over goes to Misc' : ' — all of it')
            : 'Anything you don’t break down goes to Misc. That’s fine.';
          tally.className = 'note';
        }
      }

      function buildRows() {
        var kids = [];
        Object.keys(f.bd).forEach(function (k) {
          var cat = G.typedCategoriesFor(getTour(tourId)).filter(function (c) { return c.key === k; })[0];
          kids.push(h('div', { class: 'row' },
            h('span', { class: 'row-label' }, cat ? cat.label : k),
            moneyInput({
              id: 'bd-' + k, value: f.bd[k], slim: true, label: (cat ? cat.label : k) + ' on this card',
              onValue: function (v) { if (v > 0) f.bd[k] = v; else delete f.bd[k]; refresh(); }
            }),
            h('button', {
              class: 'iconbtn sm', type: 'button', 'aria-label': 'Remove this line',
              onclick: function () { delete f.bd[k]; buildRows(); refresh(); }
            }, icon('trash', 16))));
        });
        var unused = G.typedCategoriesFor(getTour(tourId)).filter(function (c) { return !(c.key in f.bd); });
        if (unused.length) {
          var sel = h('select', { class: 'input sm', 'aria-label': 'Add a category',
            onchange: function (e) {
              if (!e.target.value) return;
              f.bd[e.target.value] = 0;
              buildRows(); refresh();
              var el = document.getElementById('bd-' + e.target.value);
              if (el) { var inp = el.querySelector ? el.querySelector('input') : null; (inp || el).focus(); }
            } });
          sel.append(h('option', { value: '' }, '+ Where did it go?'));
          unused.forEach(function (c) { sel.append(h('option', { value: c.key }, c.label)); });
          kids.push(h('div', { class: 'row' }, sel));
        }
        rowsHost.replaceChildren.apply(rowsHost, kids);
      }

      var submit = async function (e) {
        e.preventDefault();
        blurActive();
        if (!(f.amount > 0)) { toast('Enter the balance'); return; }
        // one write: keep new lines, null out lines that were removed
        var bd = {};
        Object.keys(src).forEach(function (k) { bd[k] = null; });
        Object.keys(f.bd).forEach(function (k) { if (G.num(f.bd[k]) > 0) bd[k] = G.num(f.bd[k]); });
        var patch = {};
        patch[card.id] = { label: f.label.trim() || 'Card', amount: f.amount, kind: 'card',
          cutoff: f.cutoff || null, breakdown: bd };
        if (await api.update(tourId, { debts: patch })) { closeSheet(); toast('Saved'); render(true); }
      };

      buildRows(); refresh();
      return [
        h('h2', { class: 'sh-title' }, f.label),
        h('p', { class: 'sh-sub' }, 'The balance this card is carrying into the tour, and where that money went — as far as you remember.'),
        h('form', { class: 'sh-form', onsubmit: submit, novalidate: true },
          h('div', { class: 'field-row' },
            field('Card name', h('input', { class: 'input', type: 'text', value: f.label, maxlength: 40,
              autocomplete: 'off', oninput: function (e) { f.label = e.target.value; } })),
            field('Balance', moneyInput({ id: 'card-balance', value: f.amount, label: 'Balance going in',
              onValue: function (v) { f.amount = v; refresh(); } }))),
          rowsHost,
          tally,
          field('Statement charges through', h('input', {
            class: 'input', type: 'date', value: f.cutoff,
            oninput: function (e) { f.cutoff = e.target.value; }
          }), 'Charges on or before this date are already inside this balance, so imports set them aside. Left blank, it’s the first show.'),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Save'),
            h('button', {
              class: 'btn danger block', type: 'button',
              onclick: function () {
                confirmSheet({
                  title: 'Remove ' + (f.label || 'this card') + '?',
                  body: money(f.amount) + ' and its breakdown come off the tour.',
                  action: 'Remove card', danger: true,
                  onConfirm: async function () {
                    var patch = {}; patch[card.id] = null;
                    var ok = await api.update(tourId, { debts: patch });
                    if (ok) toast('Removed');
                    return ok;
                  }
                });
              }
            }, 'Remove card')))
      ];
    }, { label: 'Card balance' });
  }

  function openDebtSheet(id, d) {
    var label = d.label || '';
    var amount = G.num(d.amount);
    openSheet(function () {
      var labelI = h('input', {
        class: 'input', type: 'text', value: label, maxlength: 60, autocomplete: 'off',
        oninput: function (e) { label = e.target.value; }
      });
      var submit = async function (e) {
        e.preventDefault();
        var l = label.trim();
        if (!l) { toast('Name it first'); return; }
        if (!(amount > 0)) { toast('Enter how much is owed'); return; }
        var patch = {}; patch[d.id] = { label: l, amount: amount };
        if (await api.update(id, { debts: patch })) { closeSheet(); toast('Saved'); render(true); }
      };
      return [
        h('h2', { class: 'sh-title' }, 'Edit'),
        h('form', { class: 'sh-form', onsubmit: submit, novalidate: true },
          field('What is it?', labelI),
          field('Amount owed', moneyInput({
            id: 'debt-edit-amount', value: amount, label: 'Amount owed', last: true,
            onValue: function (v) { amount = v; }
          })),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Save'),
            h('button', {
              class: 'btn danger block', type: 'button',
              onclick: function () {
                confirmSheet({
                  title: 'Remove ' + (d.label || 'this') + '?',
                  body: money(G.num(d.amount)) + ' comes off what the tour has to pay off.',
                  action: 'Remove', danger: true,
                  onConfirm: async function () {
                    var patch = {}; patch[d.id] = null;
                    var ok = await api.update(id, { debts: patch });
                    if (ok) toast('Removed');
                    return ok;
                  }
                });
              }
            }, 'Remove')))
      ];
    }, { label: 'Edit debt' });
  }

  /* ============================== Tour view ============================== */

  function tourTopbar(t, id, view) {
    // Inside a tour the tabs do the moving, so back always leaves it —
    // except the subpages, which step back to the tab they hang off.
    var back = view === 'addshows' || view === 'daybyday'
      ? h('button', { class: 'iconbtn back', type: 'button',
          onclick: function () {
            go({ name: 'tour', id: id, view: view === 'daybyday' ? 'costs' : 'details' });
          } },
          icon('back'), h('span', null, view === 'daybyday' ? 'Expenses' : 'Tour'))
      : backBtn(t);
    return h('header', { class: 'topbar' }, back,
      h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
      h('div', { class: 'topbar-actions' },
        canEditTour(id) ? h('button', {
          class: 'iconbtn', type: 'button', 'aria-label': 'Tour options',
          onclick: function () { openTourMenu(id); }
        }, icon('more')) : h('span', { style: 'width:44px' })));
  }


  /* Five tabs along the bottom. The day sheet is where a tour opens. */
  var TOUR_TABS = [
    { view: 'details', label: 'Overview', icon: 'tabmap' },
    { view: 'money', label: 'Budget', icon: 'tabmoney' },
    { view: 'day', label: 'Day sheet', icon: 'tabsheet' },
    { view: 'costs', label: 'Expenses', icon: 'tabcost' },
    { view: 'guests', label: 'Guest list', icon: 'tabguest' },
    { view: 'chat', label: 'Chat', icon: 'tabchat' }
  ];

  function tourTabs(id, current) {
    var tabs = canSeeMoney(id) ? TOUR_TABS : TOUR_TABS.filter(function (t) {
      return t.view !== 'money' && t.view !== 'costs';
    });
    return h('nav', { class: 'tabbar', 'aria-label': 'Tour sections',
      style: 'grid-template-columns: repeat(' + tabs.length + ', 1fr)' },
      tabs.map(function (t) {
        var on = t.view === current;
        return h('button', {
          class: 'tabbar-b' + (on ? ' on' : ''), type: 'button',
          'aria-current': on ? 'page' : null,
          onclick: function () { if (!on) go({ name: 'tour', id: id, view: t.view }); }
        }, icon(t.icon, 23), h('span', null, t.label));
      }));
  }


  /* The bus group chat: one thread for the whole run, riding the notes
     store under the 'chat' day so GA can talk too and RLS stays the judge. */
  function viewTourChat(id, t) {
    var backend = !!(window.GR_BACKEND && S.mode === 'db' && window.GR_BACKEND.notesFor);
    var myUid = backend && window.GR_BACKEND.uid ? window.GR_BACKEND.uid() : null;
    var list = notesFor(t, id, 'chat').slice().sort(function (a, b) {
      var ta = typeof a.at === 'number' ? a.at : Date.parse(a.at) || 0;
      var tb = typeof b.at === 'number' ? b.at : Date.parse(b.at) || 0;
      return ta - tb;
    });
    var refresh = function () { setTimeout(function () { render(true); }, backend ? 500 : 150); };

    var msgs = list.map(function (n) {
      var ts = typeof n.at === 'number' ? n.at : Date.parse(n.at) || 0;
      var dt = ts ? new Date(ts) : null;
      var sameDay = dt && G.ymd(dt) === G.ymd(new Date());
      var when = !dt ? '' : sameDay
        ? dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : dayMD(G.ymd(dt));
      var mine = !backend || !myUid || (n.addedBy && n.addedBy === myUid);
      var isAri = String(n.author || '') === 'Ari';
      return h('div', { class: 'chat-msg' + (isAri ? ' from-ari' : '') },
        h('div', { class: 'chat-top' },
          h('span', { class: 'chat-a' }, isAri ? 'Ari · tour manager' : (n.author || 'Someone')),
          h('span', { class: 'chat-t' }, when),
          (canWrite() || mine) ? h('button', { class: 'iconbtn sm chat-x', type: 'button',
            'aria-label': 'Delete this message',
            onclick: async function () {
              try { await removeNote(id, 'chat', n.id); refresh(); }
              catch (e2) { toast('Only the tour manager can delete someone else\u2019s message.'); }
            } }, icon('trash', 14)) : null),
        h('div', { class: 'chat-b' }, n.body));
    });

    var draftKey = 'chat:' + id;
    var input = h('input', { class: 'input', type: 'text', maxlength: 300,
      value: S.drafts[draftKey] || '', placeholder: 'Message the tour\u2026',
      autocomplete: 'off', enterkeyhint: 'send', 'aria-label': 'Message',
      oninput: function (e) { S.drafts[draftKey] = e.target.value; } });
    var send = async function (e) {
      e.preventDefault();
      var body = String(S.drafts[draftKey] || '').trim();
      if (!body) return;
      try {
        await saveNote(id, 'chat', { id: newId(), body: body, author: myName() });
        delete S.drafts[draftKey];
        refresh();
      } catch (e2) { toast('Couldn\u2019t send that. Try again.'); }
    };

    return h('div', { class: 'page tour has-tabs chat-page' },
      h('div', { class: 'headband' },
        tourTopbar(t, id, 'chat'),
        h('h1', { class: 'tour-title' }, t.name || 'Untitled tour')),
      dbBanner(),
      canEditTour(id) ? h('button', { class: 'btn ghost block', type: 'button',
        style: 'margin-bottom:4px',
        onclick: function () { openAlertSheet(id); } },
        icon('bell', 18), 'Send alert notification') : null,
      msgs.length
        ? h('div', { class: 'chat-list' }, msgs)
        : emptyState('Special requests, notes for the team, send here.', null),
      h('form', { class: 'chat-form', onsubmit: send, novalidate: true },
        input,
        h('button', { class: 'btn primary', type: 'submit' }, 'Send')),
      tourTabs(id, 'chat'));
  }

  var ARI_ADDRESS = '30bb39e4368b9e23ff77@cloudmailin.net';

  /* The address this tour's settlements should be mailed to. The +tag is the
     tour itself, so atVenu can feed twenty runs at once and never cross them. */
  function settlementAddress(tourId) {
    var at = ARI_ADDRESS.indexOf('@');
    return ARI_ADDRESS.slice(0, at) + '+' + tourId + ARI_ADDRESS.slice(at);
  }

  function ariPrompt(body, isImage) {
    return [
      'You are Ari, the tour manager for a touring band. A settlement sheet was just posted',
      'in the crew group chat' + (isImage ? ' as a photo or PDF.' : '.'),
      'Explain it to the whole crew — the drummer, the merch kid, the guitar tech.',
      'Most of them have never read a settlement and will not ask questions if it sounds complicated.',
      '',
      'Rules for your message:',
      '- Under 120 words. Short lines. No greeting, no sign-off, no emoji.',
      '- Walk the money in order: what came in, what was taken out and why, what the band keeps.',
      '- Explain every term the moment you use it (a per head is dollars of merch per person in',
      '  the room; a backend is the cut above the guarantee once the room is full enough).',
      '- Use only numbers printed on the sheet. Never invent or estimate one.',
      '- End with one line on whether this looks right, or what to question with the promoter.',
      isImage ? '' : '\nThe settlement:\n' + String(body).slice(0, 20000)
    ].join('\n');
  }

  /* Ari reads a settlement (text or images) and posts her breakdown to chat. */
  async function ariExplain(tourId, textBody, images) {
    try {
      var out = images
        ? await S.sample(ariPrompt('', true), { images: images, cache: false })
        : await S.sample(ariPrompt(textBody, false), { cache: false });
      var said = String((out && out.text) || '').trim();
      if (!said) return false;
      await saveNote(tourId, 'chat', { id: newId(), body: said.slice(0, 1200), author: 'Ari' });
      return true;
    } catch (e) { return false; }
  }

  /* Post a settlement into the chat and let Ari read it out loud. */
  function askAriControl(tourId) {
    if (!S.sample) return unavailableBtn('Ask Ari', 'btn ghost block');
    var busy = false;
    var control = fileControl({
      label: 'Post a settlement for Ari', icon: 'flyer', cls: 'btn ghost block',
      ariaLabel: 'Post a settlement sheet for Ari to explain',
      accept: 'application/pdf,.pdf,' + imageAccept(), multiple: true,
      onFiles: async function (files) {
        if (busy) return;
        busy = true;
        var btn = control[0];
        var was = btn.textContent;
        btn.textContent = 'Ari is reading\u2026';
        btn.disabled = true;
        var road = roadie();
        road.style.margin = '12px 0 4px';
        if (btn.parentNode) btn.parentNode.insertBefore(road, btn.nextSibling);
        try {
          var pdfFile = files.filter(function (f) { return /pdf/i.test(f.type) || /\.pdf$/i.test(f.name); })[0];
          var images = files.filter(function (f) { return /^image\//i.test(f.type); });
          var body = '', pics = null;
          if (pdfFile) {
            var got = await pdfToText(pdfFile);
            if (got.text.replace(/\s/g, '').length > 60) body = got.text;
            else pics = await pdfToImages(got.doc, got.pages);
          } else if (images.length) {
            pics = images;
          } else {
            toast('That file type isn\u2019t supported \u2014 use a photo or a PDF.');
            return;
          }
          await saveNote(tourId, 'chat', { id: newId(),
            body: myName() + ' posted a settlement sheet.', author: myName() });
          var okAri = await ariExplain(tourId, body, pics);
          if (!okAri) { toast('Ari couldn\u2019t read that sheet. Try a sharper photo.'); return; }
          toast('Ari broke it down in the chat');
          setTimeout(function () { render(true); }, 400);
        } catch (e) {
          var code = e && e.code;
          if (code === 'cancelled') return;
          if (SAMPLE_GONE.indexOf(code) >= 0) { S.sample = null; toast('Reading isn\u2019t available right now.'); return; }
          toast(sampleErrorMessage(code, 'statement'));
        } finally {
          busy = false;
          btn.textContent = was;
          btn.disabled = false;
          road.remove();
        }
      }
    });
    return control;
  }

  /* The tour manager's siren: a push to every phone on the tour, and the
     same words dropped into the chat so there's a record. */
  function openAlertSheet(tourId) {
    var f = { message: '' };
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'Send an alert'),
        h('p', { class: 'sh-sub' }, 'A push notification to everyone on this tour, right now. It lands in the chat too.'),
        h('form', { class: 'sh-form', novalidate: true,
          onsubmit: async function (e) {
            e.preventDefault();
            var msg = f.message.trim();
            if (!msg) { toast('Write the alert first'); return; }
            blurActive();
            try {
              await saveNote(tourId, 'chat', { id: newId(), body: '\ud83d\udea8 ' + msg, author: myName() });
            } catch (e2) { toast('Couldn\u2019t post it. Try again.'); return; }
            sendNotify(tourId, 'alert', { message: msg });
            closeSheet();
            toast(S.mode === 'db' ? 'Alert on its way to the tour' : 'Posted \u2014 pushes go out on the real app');
            setTimeout(function () { render(true); }, 400);
          } },
          field('The alert', h('textarea', { class: 'gl-paste', maxlength: 200,
            placeholder: 'Bus call moved to 11:30\u2026',
            oninput: function (e) { f.message = e.target.value; } })),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Send it'),
            h('button', { class: 'btn ghost block', type: 'button',
              onclick: function () { closeSheet(); } }, 'Cancel')))
      ];
    }, { label: 'Alert' });
  }

  /* Devin's spec: only the tour manager edits. ALL ACCESS sees everything
     and changes nothing; GA sees Overview, Day sheet, Guest list and Chat. */
  function tourRole(id) {
    if (S.mode !== 'db') return canWrite() ? 'owner' : 'viewer';
    var B = window.GR_BACKEND;
    if (B && B.ownsTour && B.ownsTour(id)) return 'owner';
    if (S.roles[id]) return S.roles[id];
    if (!S.rolesAsked[id] && B && B.myRole) {
      S.rolesAsked[id] = true;
      B.myRole(id).then(function (r) {
        S.roles[id] = r;
        if (r !== 'viewer') render(true);
      }).catch(function () { /* stays viewer */ });
    }
    return 'viewer';
  }
  function canEditTour(id) { return tourRole(id) === 'owner'; }
  function canSeeMoney(id) { return tourRole(id) !== 'viewer'; }

  function tourBands(t) {
    return Array.isArray(t && t.bands)
      ? t.bands.filter(function (b) { return String(b || '').trim(); }) : [];
  }

  function lineupEditor(tourId, t) {
    var bands = tourBands(t);
    var input = h('input', { class: 'input', type: 'text', maxlength: 60,
      placeholder: bands.length ? 'Another band' : 'In This Moment', autocomplete: 'off',
      onkeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } } });
    async function add() {
      var name = String(input.value || '').trim();
      if (!name) return;
      if (bands.some(function (b) { return b.toLowerCase() === name.toLowerCase(); })) {
        toast(name + ' is already on the lineup'); return;
      }
      if (await api.update(tourId, { bands: bands.concat([name]) })) {
        input.value = '';
        toast(name + ' on the bill');
        render(true);
      }
    }
    return h('div', null,
      bands.length ? h('div', { class: 'chips', style: 'margin:0 0 10px' }, bands.map(function (b, i) {
        return h('button', { class: 'chip', type: 'button',
          'aria-label': 'Remove ' + b + ' from the lineup',
          onclick: function () {
            confirmSheet({
              title: 'Take ' + b + ' off the lineup?',
              body: 'Day sheets already written keep their rows; new ones stop pre-filling ' + b + '.',
              action: 'Take them off', danger: true,
              onConfirm: async function () {
                var next = bands.slice(); next.splice(i, 1);
                var ok = await api.update(tourId, { bands: next });
                if (ok) toast(b + ' off the lineup');
                return ok;
              }
            });
          } }, b + ' \u00d7');
      })) : null,
      h('div', { class: 'af-row' }, input,
        h('button', { class: 'btn quiet', type: 'button', style: 'flex:0 0 auto', onclick: add }, 'Add')));
  }

  /* The shows door: every way dates get onto the tour, one place, once.
     Both other doors read from what lands here. */
  function viewAddShows(id, t) {
    return h('div', { class: 'page tour' },
      h('div', { class: 'headband' },
        tourTopbar(t, id, 'addshows'),
        h('h1', { class: 'tour-title' }, 'Add shows')),
      dbBanner(),
      addShowsBody(id, t));
  }

  /* Everywhere shows come from, in one place — its own page from the wizard,
     and the Budget tab called "Add more shows". */
  function addShowsBody(id, t) {
    var shows = G.rows(t.shows).sort(G.byDate);
    var today = G.tourToday();
    return [
      canEditTour(id) ? (S.sample ? fileControl({
        label: 'Upload flyer', icon: 'flyer', cls: 'btn primary block',
        accept: imageAccept(),
        onFiles: function (files) { readFlyer(id, files[0]); }
      }) : unavailableBtn('Upload flyer', 'btn primary block')) : null,
      shows.length
        ? [h('p', { class: 'count-line' }, plural(shows.length, 'show') + ' on the run'),
           h('ul', { class: 'shows' }, shows.map(function (x) {
             return h('li', null, h('button', {
               class: 'show-row' + (x.date === today ? ' is-today' : ''), type: 'button',
               onclick: function () { if (canEditTour(id)) openShowSheet(id, x.id); }
             }, dateBlock(x.date), whereBlock(x), canEditTour(id) ? icon('chevron', 18) : h('span')));
           }))]
        : emptyState('No shows yet', canEditTour(id)
            ? 'Shoot the flyer and the dates fill themselves in.'
            : 'No dates have been added.'),
      canEditTour(id) ? h('div', { class: 'home-foot', style: 'margin-top:10px' },
        h('button', { class: 'linkbtn', type: 'button', onclick: function () { openShowSheet(id); } },
          'Type a show in by hand'),
        h('button', { class: 'linkbtn', type: 'button', onclick: function () { openTravelDaysSheet(id); } },
          'Travel days before or after the run'),
        h('button', { class: 'linkbtn', type: 'button', onclick: function () { openRehearsalSheet(id); } },
          'Rehearsal days before the tour')) : null,
      canEditTour(id) ? [
        S.mode === 'db' ? [
          h('h3', { class: 'sh-h3', style: 'margin-top:26px' },
            h('img', { class: 'brand-logo', src: 'logo-atvenu.png', alt: '' }), 'Settlements by email'),
          h('p', { class: 'note', style: 'margin:2px 2px 10px' },
            'Send this tour\u2019s atVenu settlements here and they log themselves \u2014 Ari breaks each one down in the chat. ' +
            'Every tour has its own address, so nothing lands on the wrong run.'),
          h('div', { class: 'mailrow' },
            h('code', { class: 'mailcode' }, settlementAddress(id)),
            h('button', { class: 'btn quiet sm', type: 'button',
              onclick: async function () {
                var addr = settlementAddress(id);
                var ta = h('textarea', { class: 'sr', readonly: true, value: addr });
                document.body.appendChild(ta);
                var okc = await copyText(addr, ta);
                ta.remove();
                toast(okc ? 'Address copied' : 'Press and hold to copy');
              } }, icon('copy', 16), 'Copy'))
        ] : null,
        h('h3', { class: 'sh-h3', style: 'margin-top:26px' }, h('img', { class: 'brand-logo', src: 'logo-mastertour.png', alt: '' }), 'Master Tour'),
        h('p', { class: 'note', style: 'margin:2px 2px 10px' },
          'Print your day sheets or itinerary to PDF in Master Tour (or export CSV) and upload it \u2014 ' +
          'schedules fill in across every matching date.'),
        h('div', { class: 'btnrow' }, tourImportControl(id))
      ] : null
    ];
  }

  function viewTour() {
    var id = S.route.id;
    var view = S.route.view || 'details';
    var tab = S.route.tab || 'shows';
    var t = getTour(id);
    if (!t) {
      return h('div', { class: 'page' },
        h('header', { class: 'topbar' }, backBtn()),
        emptyState('This tour isn’t here anymore', 'It may have been deleted.'));
    }
    if (view === 'addshows') return viewAddShows(id, t);
    if (view === 'menu') view = 'details';
    if (!canSeeMoney(id) && (view === 'money' || view === 'costs' || view === 'daybyday' || view === 'addshows')) {
      view = 'details';
    }
    if (view === 'day' || view === 'details' || view === 'guests') {
      return viewTourDay(id, t, view);
    }
    if (view === 'chat') return viewTourChat(id, t);
    var c = G.calc(t);
    if (view === 'costs') {
      return h('div', { class: 'page tour has-tabs' },
        h('div', { class: 'headband' },
          tourTopbar(t, id, 'costs'),
          h('h1', { class: 'tour-title' }, t.name || 'Untitled tour')),
        dbBanner(),
        tabExpenses(id, t, c),
        tourTabs(id, 'costs'));
    }
    if (view === 'daybyday') {
      return h('div', { class: 'page tour has-tabs' },
        h('div', { class: 'headband' },
          tourTopbar(t, id, 'daybyday'),
          h('h1', { class: 'tour-title' }, 'Day by day')),
        dbBanner(),
        tabDays(id, t, c),
        tourTabs(id, 'costs'));
    }
    if (tab === 'debt' || tab === 'sheet' || tab === 'expenses' || tab === 'days') tab = 'shows';
    var body = tab === 'add' ? addShowsBody(id, t) : tabShows(id, t, c);

    return h('div', { class: 'page tour has-tabs' },
      h('div', { class: 'headband' },
        tourTopbar(t, id, 'money'),
        h('h1', { class: 'tour-title' }, t.name || 'Untitled tour')),
      dbBanner(),
      !t.setupDone && canEditTour(id)
        ? h('div', { class: 'banner' },
            h('span', null, 'Setup isn’t finished'),
            h('button', {
              class: 'btn sm primary', type: 'button',
              onclick: function () { go({ name: 'wizard', id: id, step: clampStep(t.setupStep) }); }
            }, 'Continue'))
        : null,
      t.setupDone && updateDue(t)
        ? h('div', { class: 'banner' },
            h('span', null, 'Today’s update is ready'),
            h('button', {
              class: 'btn sm quiet', type: 'button',
              onclick: async function () {
                await api.update(id, { updateSentOn: G.ymd(new Date()) });
                openShare(id);
              }
            }, 'Send it'))
        : null,
      (function () {
        var dated = c.allShows.filter(function (x) { return G.parseDay(x.date); });
        var over = dated.length && dated[dated.length - 1].date < G.tourToday();
        return over && canEditTour(id) ? h('div', { class: 'banner' },
          h('span', null, 'The run is over \u2014 wrap it up'),
          h('button', { class: 'btn sm quiet', type: 'button',
            onclick: function () { openCloseout(id); } }, 'Tour closeout')) : null;
      })(),
      heroNode(t, id),
      h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Tour sections' },
        TABS.map(function (pair) {
          return h('button', {
            class: 'tab', type: 'button', role: 'tab', id: 'tab-' + pair[0],
            'aria-selected': String(pair[0] === tab), 'aria-controls': 'tabpanel',
            onclick: function () {
              if (pair[0] === tab) return;
              S.route = Object.assign({}, S.route, { tab: pair[0] });
              render(true);
            }
          }, pair[1]);
        })),
      h('div', { id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': 'tab-' + tab }, body),
      tourTabs(id, 'money'));
  }

  /* Today, and only today: where you are, who you're playing to, and a line
     from the tour manager. */
  function overviewBody(id, t) {
    var today = G.tourToday();
    var shows = G.rows(t && t.shows).filter(function (x) { return G.parseDay(x.date); }).sort(G.byDate);
    var s = shows.filter(function (x) { return x.date === today; })[0];
    // Today's show, else the next one, else the last one we played.
    var next = s || shows.filter(function (x) { return x.date > today; })[0] || shows[shows.length - 1];
    var off = !s && G.isObj(t.offDays) && G.isObj(t.offDays[today]) ? t.offDays[today] : null;
    var d = next && G.isObj(next.daySheet) ? next.daySheet : {};

    if (!shows.length) {
      return emptyState('No dates yet', 'Once shows are on the run, today shows up here.');
    }
    var when = s ? 'Tonight' : (next ? 'Next show' : 'Last show');
    var line = function (label, value, href) {
      if (!value) return null;
      return h('div', { class: 'ov-line' },
        h('span', { class: 'ov-msg-k' }, label),
        href
          ? h('a', { class: 'ov-v ov-link', href: href, target: '_blank', rel: 'noopener' }, value)
          : h('span', { class: 'ov-v' }, value));
    };
    // Apple Maps on an iPhone; the same link opens a map anywhere else.
    var mapsHref = function (addr) {
      return 'https://maps.apple.com/?q=' + encodeURIComponent(String(addr).trim());
    };
    var quote = String(d.quote || '').trim();
    return [
      h('div', { class: 'ov-today' },
        canEditTour(id) ? h('button', { class: 'iconbtn ov-edit', type: 'button',
          'aria-label': 'Edit today',
          onclick: function () { openTodaySheet(id, next ? next.id : null); } },
          icon('edit', 20)) : null,
        h('div', { class: 'ov-when' },
          h('span', { class: 'vh-when' + (s ? ' vh-tonight' : '') }, when),
          h('span', null, dayLong(s ? today : (next ? next.date : today)))),
        h('div', { class: 'ov-city' }, s ? (s.city || 'Show')
          : (off && off.city ? off.city : (next ? next.city : 'Day off'))),
        next && next.venue ? h('div', { class: 'ov-venue' }, next.venue) : null,
        // No label needed: it reads as the address, and a tap opens Maps.
        d.venueAddress ? h('a', { class: 'ov-addr', href: mapsHref(d.venueAddress),
          target: '_blank', rel: 'noopener' }, d.venueAddress) : null),
      quote
        ? h('div', { class: 'ov-msg' },
            h('span', { class: 'ov-msg-k' }, 'Tour Manager says'),
            // Curly quotes wrap whatever the TM wrote (stripping any they typed).
            h('blockquote', { class: 'ov-quote' }, h('p', null,
              '\u201c' + quote.replace(/^["\u201c\u201d']+|["\u201c\u201d']+$/g, '').trim() + '\u201d')))
        : null,
      d.presale ? h('div', { class: 'ov-presale' },
        h('span', { class: 'ov-msg-k' }, 'Pre-sale'),
        h('strong', { class: 'ov-presale-n num' }, d.presale)) : null,
      h('div', { class: 'ov-lines' },
        line('Doors', d.doors)),

      (S.mode === 'db' && window.GR_BACKEND && window.GR_BACKEND.crew) ? crewSection(id) : null
    ];
  }

  /* The tour's phone book: who is on the run and how to reach them. */
  function crewSection(tourId) {
    var B = window.GR_BACKEND;
    var owns = B.ownsTour && B.ownsTour(tourId);
    var list = h('div', { class: 'ledger crew-list' },
      h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Loading\u2026')));

    /* The badge column sits centred in the gap between the names and the
       icons: the name column is sized to the widest name (so the gap is the
       same in every row), and each badge box is centred in that gap with the
       badge flush left inside it — straight column, same starting point. */
    function sizeColumns() {
      var rowsEl = list.querySelectorAll('.crew-row');
      if (!rowsEl.length) return;
      var first = rowsEl[0];
      var cs = getComputedStyle(first);
      var content = first.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      var cap = content - 6 - 112 - 84; // row gap, badge box, mail + call with their gaps
      var widest = 0;
      Array.prototype.forEach.call(rowsEl, function (r) {
        var lab = r.querySelector('.row-label');
        Array.prototype.forEach.call(lab.childNodes, function (n) {
          var rg = document.createRange();
          rg.selectNodeContents(n);
          var w = rg.getBoundingClientRect().width;
          if (w > widest) widest = w;
        });
      });
      if (!(widest > 0) || !(cap > 40)) return;
      list.style.setProperty('--crew-name-w', Math.ceil(Math.min(widest + 2, cap)) + 'px');
      list.classList.add('sized');
    }

    function draw(rows) {
      if (!rows.length) {
        list.replaceChildren(h('div', { class: 'row' },
          h('span', { class: 'hint' }, 'Nobody else on the run yet.')));
        return;
      }
      list.replaceChildren.apply(list, rows.map(function (m) {
        var title = m.name || m.username || m.email;
        var sub = [];
        if (m.tourRole) sub.push(m.tourRole);
        if (!m.joined) sub.push('invited');
        return h('div', { class: 'row crew-row' },
          h('div', { class: 'row-label' }, title,
            sub.length ? h('span', { class: 'hint crew-sub' }, sub.join(' \u00b7 ')) : null),
          h('div', { class: 'crew-side' },
            // Every badge sits in the same-width slot, flush left, so TOUR
            // MANAGER, ALL ACCESS and GA all start at the same point.
            h('span', { class: 'role-slot' },
              h('span', { class: 'role-box' },
                h('span', { class: 'role-tag' + (m.role === 'editor' || m.owner ? ' aa' : '') },
                  m.owner ? 'TOUR MANAGER' : (m.role === 'editor' ? 'ALL ACCESS' : 'GA')))),
            // Fixed slots: a missing phone leaves an empty seat, so every mail
            // icon and every phone icon lines up in its own column.
            m.email ? h('a', { class: 'crew-call', href: 'mailto:' + String(m.email).trim(),
              'aria-label': 'Email ' + title }, icon('mail', 17))
              : h('span', { class: 'crew-call empty', 'aria-hidden': 'true' }),
            m.phone ? h('a', { class: 'crew-call', href: 'tel:' + String(m.phone).replace(/[^0-9+]/g, ''),
              'aria-label': 'Call ' + title }, icon('phone', 17))
              : h('span', { class: 'crew-call empty', 'aria-hidden': 'true' })));
      }));
      requestAnimationFrame(sizeColumns);
    }
    B.crew(tourId).then(draw).catch(function () {
      list.replaceChildren(h('div', { class: 'row' },
        h('span', { class: 'hint' }, 'Couldn\u2019t load the crew.')));
    });

    return [
      h('div', { class: 'sec-head', style: 'margin-top:30px;text-align:center' },
        h('h2', { class: 'sec-title' }, 'CREW')),
      list,
      owns ? h('div', { style: 'display:flex;justify-content:center;margin-top:14px' },
        h('button', { class: 'crew-invite', type: 'button',
          onclick: function () { openInviteSheet(tourId); } },
          h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), 'Invite crew')) : null
    ];
  }

  /* Inviting is its own sheet now — the Overview keeps one small button. */
  function openInviteSheet(tourId) {
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'Invite crew'),
        h('p', { class: 'sh-sub' }, 'They get an email, pick a password, and this tour is already in their account.'),
        peopleSection(tourId)
      ];
    }, { label: 'Invite crew' });
  }

  /* Pre-sale and the quote of the day, kept with that night's day sheet. */
  function openTodaySheet(tourId, showId) {
    var t = getTour(tourId);
    var s = showId && G.isObj(t.shows) ? t.shows[showId] : null;
    if (!s) { toast('Add a show first'); return; }
    var d0 = G.isObj(s.daySheet) ? s.daySheet : {};
    var f = { presale: d0.presale || '', quote: d0.quote || '' };
    openSheet(function () {
      var submit = async function (e) {
        e.preventDefault();
        blurActive();
        var patch = {};
        patch[showId] = { daySheet: Object.assign({}, d0, {
          presale: f.presale.trim(), quote: f.quote.trim() }) };
        if (await api.update(tourId, { shows: patch })) {
          closeSheet(); toast('Posted'); render(true);
        }
      };
      return [
        h('h2', { class: 'sh-title' }, 'Today'),
        h('p', { class: 'sh-sub' }, 'What the whole tour sees on the Overview.'),
        h('form', { class: 'sh-form', onsubmit: submit, novalidate: true },
          field('Pre-sale', h('input', { class: 'input', type: 'text', maxlength: 40,
            value: f.presale, placeholder: '312 of 900', autocomplete: 'off',
            oninput: function (e) { f.presale = e.target.value; } })),
          field('Message from the tour manager', h('textarea', { class: 'gl-paste', maxlength: 180,
            placeholder: 'Anything the whole tour should know today\u2026',
            oninput: function (e) { f.quote = e.target.value; } }, f.quote)),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Post it'),
            h('button', { class: 'btn ghost block', type: 'button',
              onclick: function () { closeSheet(); } }, 'Cancel')))
      ];
    }, { label: 'Today' });
  }

  /* Day sheet, Overview and Guest list all hang off the same day picker. */
  /* Shows in a row from today (today included) until the next night off.
     Only while today is inside the run; a day off says so. */
  function daysUntilOff(t) {
    var shows = G.rows(t && t.shows).filter(function (x) { return G.parseDay(x.date); });
    if (!shows.length) return null;
    var on = {};
    shows.forEach(function (x) { on[x.date] = true; });
    var dates = Object.keys(on).sort();
    var today = G.tourToday();
    if (today < dates[0] || today > dates[dates.length - 1]) return null;
    if (!on[today]) return { off: true };
    var n = 0, d = today;
    while (on[d] && n < 400) { n += 1; d = G.addDays(d, 1); }
    return { n: n };
  }
  function offCounter(t) {
    var c = daysUntilOff(t);
    if (!c) return null;
    return h('div', { class: 'off-count', 'aria-label': c.off ? 'Day off today'
        : c.n + (c.n === 1 ? ' show' : ' shows') + ' until day off' },
      c.off ? [h('b', null, 'Day off'), h('span', { class: 'oc-2' }, 'today')]
        : [h('b', { class: 'num' }, String(c.n)),
           h('span', { class: 'oc-2' }, (c.n === 1 ? 'show' : 'shows') + ' until day off')]);
  }

  function viewTourDay(id, t, view) {
    if (view === 'details') {
      return h('div', { class: 'page tour has-tabs' },
        h('div', { class: 'headband' },
          tourTopbar(t, id, view),
          h('div', { class: 'title-row' },
            h('h1', { class: 'tour-title' }, t.name || 'Untitled tour'),
            offCounter(t))),
        dbBanner(),
        overviewBody(id, t),
        tourTabs(id, view));
    }
    return h('div', { class: 'page tour has-tabs' + (view === 'guests' ? ' guest-page' : '') },
      h('div', { class: 'headband' },
        tourTopbar(t, id, view),
        h('h1', { class: 'tour-title' }, t.name || 'Untitled tour')),
      dbBanner(),
      view === 'guests' ? guestsBody(id, t) : detailsBody(id, t, 'sheet'),
      tourTabs(id, view));
  }

  /* Guest list tab: tonight's list up front, any other night one tap away. */
  function guestsBody(id, t) {
    var backend = !!(window.GR_BACKEND && S.mode === 'db' && window.GR_BACKEND.guestsFor);
    var myUid = backend ? window.GR_BACKEND.uid() : null;
    var today = G.tourToday();
    var shows = G.rows(t && t.shows).filter(function (x) { return G.parseDay(x.date); }).sort(G.byDate);
    if (!shows.length) {
      return emptyState('No dates yet', 'Once shows are on the run, each night gets its own guest list.');
    }
    // Tonight's show by default; the rail scrolls to any other night.
    var picked = S.glTour === id && S.glShow
      ? shows.filter(function (x) { return x.id === S.glShow; })[0] : null;
    var s = picked ||
      shows.filter(function (x) { return x.date === today; })[0] ||
      shows.filter(function (x) { return x.date > today; })[0] || shows[shows.length - 1];
    S.glTour = id; S.glShow = s.id;
    var refresh = function () { setTimeout(function () { render(true); }, backend ? 500 : 150); };
    var list = guestsFor(t, id, s.id);
    var sum = G.guestSummary(list);

    var rowsOut = list.slice().sort(function (a, b) {
      return String(a.lastName || '').localeCompare(String(b.lastName || '')) ||
        String(a.firstName || '').localeCompare(String(b.firstName || ''));
    }).map(function (g) {
      var name = [g.firstName, g.lastName].map(function (x) { return String(x || '').trim(); })
        .filter(Boolean).join(' ') || 'Guest';
      var mine = !backend || (g.addedBy && g.addedBy === myUid);
      var canManage = canWrite() || mine;
      var sub = [String(g.affiliation || '').trim(),
        [String(g.email || '').trim(), String(g.phone || '').trim()].filter(Boolean).join(' · ')]
        .filter(Boolean).join(' · ');
      return h('div', { class: 'row' },
        h('div', { class: 'row-label' }, name,
          sub ? h('span', { class: 'hint' }, sub) : null),
        h('span', { class: 'guest-pass' + (g.passType === 'All Access' ? ' aa' : '') },
          (function () {
            var q = Math.max(1, Math.min(20, G.num(g.qty) || 1));
            return (q > 1 ? '+' + (q - 1) + ' · ' : '') + (g.passType || 'GA');
          })()),
        canManage ? h('button', { class: 'iconbtn sm', type: 'button',
          'aria-label': 'Remove ' + name,
          onclick: async function () {
            try { await removeGuest(id, s.id, g.id); toast('Off the list'); refresh(); }
            catch (e2) { toast('Only the tour manager can remove someone else’s guest.'); }
          } }, icon('trash', 16)) : null);
    });

    // Send the night's list straight to the promoter: Messages or Mail opens
    // with the whole list already written; the manager picks who it goes to.
    var copyBtn = null;
    if (list.length) {
      var listText = G.guestListText(s, list);
      var subject = 'Guest list \u00b7 ' + (t.artist || t.name || 'Greenroom') +
        (s.city ? ' \u00b7 ' + s.city : '') + (G.parseDay(s.date) ? ' \u00b7 ' + dayMD(s.date) : '');
      var copyOne = h('button', { class: 'btn ghost gl-send', type: 'button',
        onclick: async function () {
          var ta = h('textarea', { class: 'sr', readonly: true, value: listText });
          document.body.appendChild(ta);
          var ok = await copyText(listText, ta);
          ta.remove();
          toast(ok ? 'Guest list copied for the box office' : 'Press and hold to copy');
        } }, icon('copy', 17), 'Copy');
      copyBtn = h('div', { class: 'gl-sendrow' + (canEditTour(id) ? '' : ' solo') },
        canEditTour(id) ? h('a', { class: 'btn ghost gl-send', href: 'sms:?&body=' + encodeURIComponent(listText) },
          icon('tabchat', 17), 'Text') : null,
        canEditTour(id) ? h('a', { class: 'btn ghost gl-send',
          href: 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(listText) },
          icon('mail', 17), 'Email') : null,
        copyOne);
    }

    var rail = h('div', { class: 'ds-rail gl-rail' }, shows.map(function (x) {
      var dd = G.parseDay(x.date);
      return h('button', {
        class: 'ds-chip' + (x.id === s.id ? ' on' : '') + (x.date === today ? ' tonight' : ''),
        type: 'button',
        onclick: function () { S.glShow = x.id; S.glTour = id; render(true); }
      },
        h('span', { class: 'ds-chip-d num' }, dd ? String(dd.getDate()) : '?'),
        h('span', { class: 'ds-chip-c' }, String(x.city || '').split(',')[0] || 'Show'));
    }));
    // The picked night sits dead centre in the wheel — measured, not guessed.
    requestAnimationFrame(function () {
      var sel = rail.querySelector('.ds-chip.on');
      if (sel) rail.scrollLeft = sel.offsetLeft - (rail.clientWidth - sel.offsetWidth) / 2;
    });

    return [
      h('div', { class: 'sec-head', style: 'margin-top:8px;text-align:center;margin-bottom:4px' },
        h('p', { class: 'gl-when glow' }, s.date === today ? 'Today\u2019s' : dayLong(s.date)),
        h('h2', { class: 'sec-title' }, 'GUEST LIST')),
      h('p', { class: 'note', style: 'margin:0 2px 2px;text-align:center' },
        [String(s.city || '').trim(), String(s.venue || '').trim()].filter(Boolean).join(' · ') +
        (sum.names ? ' · ' + plural(sum.names, 'name') + ' · ' + plural(sum.tickets, 'ticket') : '')),
      rowsOut.length
        ? h('div', { class: 'ledger' }, rowsOut)
        : h('div', { style: 'min-height:60px' }),
      copyBtn,
      h('div', { class: 'gl-dock' },
        rail,
        h('div', { class: 'gl-dock-btns' },
          h('button', { class: 'add-mini', type: 'button',
            onclick: function () { openGuestDatePicker(id); } },
            h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), 'Add guest'),
          h('button', { class: 'add-mini', type: 'button',
            onclick: function () { openGuestImport(id, s.id, s, backend, function () { closeSheet(); refresh(); }); } },
            h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), 'Import a list')))
    ];
  }

  /* Add guest starts with the night: pick the date, then the name. */
  function openGuestDatePicker(tourId) {
    var backend = !!(window.GR_BACKEND && S.mode === 'db' && window.GR_BACKEND.guestsFor);
    var t = getTour(tourId);
    var shows = G.rows(t && t.shows).filter(function (x) { return G.parseDay(x.date); }).sort(G.byDate);
    if (!shows.length) { toast('Add a show first'); return; }
    var today = G.tourToday();
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'Which night?'),
        h('p', { class: 'sh-sub' }, 'Pick the date the guest is coming to.'),
        h('div', { class: 'ledger' }, shows.map(function (x) {
          var n = G.guestSummary(guestsFor(t, tourId, x.id)).names;
          return h('button', { class: 'row rowbtn', type: 'button',
            onclick: function () {
              S.glTour = tourId; S.glShow = x.id; // the page follows the night you picked
              openGuestForm(tourId, x.id, x, backend, function () {
                closeSheet();
                setTimeout(function () { render(true); }, backend ? 500 : 150);
              });
            } },
            h('div', { class: 'row-label' },
              dayMD(x.date) + ' · ' + (String(x.city || '').split(',')[0] || 'Show'),
              h('span', { class: 'hint' }, x.date === today ? 'Tonight'
                : (n ? plural(n, 'name') + ' so far' : 'No names yet'))),
            icon('chevron', 18));
        }))
      ];
    }, { label: 'Add a guest' });
  }

  function dateBlock(ds) {
    var d = G.parseDay(ds);
    return h('div', { class: 'date', 'aria-hidden': 'true' },
      h('div', { class: 'm' }, d ? F.mon.format(d) : '?'),
      h('div', { class: 'd num' }, d ? String(d.getDate()) : '?'),
      h('div', { class: 'w' }, d ? F.wd.format(d) : ''));
  }
  function whereBlock(s) {
    return h('div', { class: 'where' },
      h('span', { class: 'sr' }, dayLong(s.date) + ', '),
      h('div', { class: 'city' }, s.city || 'City not set'),
      s.venue ? h('div', { class: 'venue' }, s.venue) : null);
  }

  function tabShows(id, t, c) {
    var today = G.tourToday();
    var shows = c.allShows;
    var tonight = shows.filter(function (s) { return s.date === today; })[0];
    var logged = shows.filter(function (s) { return s.loggedAt; }).length;
    // The whole run, travel and off days included — the schedule tells the truth.
    var got = overviewDays(t);
    var rowsOut;
    if (got) {
      var firstShow = got.days.filter(function (x) { return x.show; })[0];
      var lastShow = got.days.slice().reverse().filter(function (x) { return x.show; })[0];
      rowsOut = got.days.map(function (x) {
        if (x.show) return showRow(id, x.show, today);
        var travel = (firstShow && x.date < firstShow.date) || (lastShow && x.date > lastShow.date);
        return offDayRow(t, x.date, travel);
      });
      shows.forEach(function (s) { // undated holds keep their place at the end
        if (!G.parseDay(s.date)) rowsOut.push(showRow(id, s, today));
      });
    } else {
      rowsOut = shows.map(function (s) { return showRow(id, s, today); });
    }
    return [
      tonight ? tonightCard(id, tonight) : null,
      shows.length
        ? [h('p', { class: 'count-line' }, logged + ' of ' + plural(shows.length, 'show') + ' logged'),
           h('ul', { class: 'shows' }, rowsOut)]
        : emptyState('No shows yet', canWrite()
            ? 'Add each date and city as they get confirmed.'
            : 'No dates have been added.')
    ];
  }

  function offDayRow(t, date, travel) {
    var off = offDayFor(t, date);
    var reh = isRehearsalDay(t, date);
    return h('li', null, h('div', { class: 'show-row is-off' },
      dateBlock(date),
      h('div', { class: 'where' },
        h('div', { class: 'city' }, off.city ||
          (reh ? 'Rehearsal day' : travel ? 'Travel day' : 'Day off')),
        off.hotel ? h('div', { class: 'venue' }, off.hotel) : null),
      h('span', { class: 'tag quiet' }, reh ? 'Rehearsal' : travel ? 'Travel' : 'Off')));
  }

  function showRow(id, s, today) {
    var isToday = s.date === today;
    var right;
    if (s.loggedAt) right = h('span', { class: 'amt num' }, money(G.showIncomeTotal(s)));
    else if (isToday) right = h('span', { class: 'tag attn' }, 'Tonight');
    else if (s.date < today) right = h('span', { class: 'tag attn' }, 'Log income');
    else right = h('span', { class: 'tag quiet' }, 'Upcoming');
    return h('li', null, h('button', {
      class: 'show-row' + (isToday ? ' is-today' : ''), type: 'button',
      onclick: function () { if (canEditTour(id)) openIncome(id, s.id); }
    }, dateBlock(s.date), whereBlock(s), right));
  }

  function tonightCard(id, s) {
    var action;
    if (s.loggedAt) {
      action = h('button', { class: 'btn ghost sm', type: 'button', onclick: function () { openIncome(id, s.id); } },
        money(G.showIncomeTotal(s)));
    } else if (canEditTour(id)) {
      action = h('button', { class: 'btn primary sm', type: 'button', onclick: function () { openIncome(id, s.id); } },
        'Log income');
    } else {
      action = h('span', { class: 'tag attn' }, 'Not logged yet');
    }
    return h('div', { class: 'tonight' },
      h('div', { class: 'tn-text' },
        h('div', { class: 'tn-label' }, 'Tonight'),
        h('div', { class: 'tn-city' }, s.city || 'Show'),
        s.venue ? h('div', { class: 'venue' }, s.venue) : null),
      action);
  }

  /* ============================== Day sheet ==============================
     The one screen the whole bus checks: today's times, the venue's facts,
     and the drive. The tour manager fills it; everyone reads it. */

  function daySheetShowFor(t) {
    var shows = G.rows(t && t.shows).filter(function (x) { return G.parseDay(x.date); }).sort(G.byDate);
    if (!shows.length) return null;
    var today = G.tourToday();
    var pick = shows.filter(function (x) { return x.date === today; })[0]
      || shows.filter(function (x) { return x.date > today; })[0]
      || shows[shows.length - 1];
    return { shows: shows, index: shows.indexOf(pick) };
  }

  function viewTourDetails(id, t) {
    return h('div', { class: 'page tour' },
      h('div', { class: 'headband' }, tourTopbar(t, id, 'details')),
      dbBanner(),
      detailsBody(id, t));
  }

  /* Every calendar day of the run, shows and off days alike. Travel days
     stretch the span past the first and last show. */
  function overviewDays(t) {
    var shows = G.rows(t && t.shows).filter(function (x) { return G.parseDay(x.date); }).sort(G.byDate);
    if (!shows.length) return null;
    var byDate = {};
    shows.forEach(function (x) { byDate[x.date] = x; });
    var start = shows[0].date, end = shows[shows.length - 1].date;
    if (G.parseDay(t.spanStart) && t.spanStart < start) start = t.spanStart;
    if (G.parseDay(t.spanEnd) && t.spanEnd > end) end = t.spanEnd;
    if (G.parseDay(t.rehearsalStart) && t.rehearsalStart < start) start = t.rehearsalStart;
    var days = [];
    var d = start, guard = 0;
    while (d <= end && guard < 120) {
      days.push({ date: d, show: byDate[d] || null });
      d = G.addDays(d, 1);
      guard += 1;
    }
    var today = G.tourToday();
    var idx = -1;
    days.forEach(function (x, i) { if (x.date === today) idx = i; });
    if (idx < 0) {
      days.some(function (x, i) { if (x.date > today && x.show) { idx = i; return true; } return false; });
    }
    if (idx < 0) idx = days.length - 1;
    return { days: days, index: idx };
  }

  function isRehearsalDay(t, date) {
    return !!(t && G.parseDay(t.rehearsalStart) && G.parseDay(t.rehearsalEnd) &&
      date >= t.rehearsalStart && date <= t.rehearsalEnd);
  }

  function offDayFor(t, date) {
    var bag = t && G.isObj(t.offDays) ? t.offDays : {};
    return G.isObj(bag[date]) ? bag[date] : {};
  }

  function detailsBody(id, t, only) {
    var got = overviewDays(t);
    if (!got) {
      return [h('h1', { class: 'tour-title' }, t.name || 'Untitled tour'),
        emptyState('No dates yet', 'Once shows are on the run, each one gets its own day sheet here.'),
        canWrite() ? h('div', { class: 'btnrow' },
          h('button', { class: 'btn quiet', type: 'button',
            onclick: function () { go({ name: 'tour', id: id, view: 'addshows' }); } },
            icon('back', 18), 'Back to Add shows')) : null];
    }
    if (S.dsIndex == null || S.dsTour !== id || S.dsIndex >= got.days.length) {
      S.dsIndex = got.index;
      S.dsTour = id;
    }
    var days = got.days;
    var entry = days[S.dsIndex];
    var s = entry.show;
    var today = G.tourToday();
    var off = s ? null : offDayFor(t, entry.date);
    var lines = s ? G.daySheetLines(s) : G.offDayLines(off);
    var d = s && G.isObj(s.daySheet) ? s.daySheet : {};

    // The centerpiece: where you are, when.
    var whenChip;
    if (s) {
      whenChip = entry.date === today ? h('span', { class: 'vh-tonight' }, 'Tonight')
        : h('span', { class: 'vh-when' }, entry.date > today ? 'Next show' : 'Last show');
    } else {
      whenChip = h('span', { class: entry.date === today ? 'vh-tonight' : 'vh-when' }, 'OFF DAY');
    }
    var hero = h('section', { class: 'venue-hero' },
      h('button', { class: 'iconbtn vh-arrow', type: 'button', 'aria-label': 'Previous day',
        disabled: S.dsIndex === 0,
        onclick: function () { S.dsIndex -= 1; render(true); } }, icon('back', 22)),
      h('div', { class: 'vh-mid' },
        h('div', { class: 'vh-date' }, dayLong(entry.date), whenChip,
          s && s.soldOut ? h('span', { class: 'vh-soldout' }, 'SOLD OUT') : null),
        h('div', { class: 'vh-city' }, s ? (s.city || 'Show') : (off.city || 'Day off')),
        s && s.venue ? h('div', { class: 'vh-venue' }, s.venue) : null,
        !s && off.hotel ? h('div', { class: 'vh-venue' }, off.hotel) : null),
      h('button', { class: 'iconbtn vh-arrow', type: 'button', 'aria-label': 'Next day',
        disabled: S.dsIndex >= days.length - 1,
        onclick: function () { S.dsIndex += 1; render(true); } }, icon('chevron', 22)));

    var body;
    if (!lines.length) {
      body = emptyState('No day sheet added.', null);
    } else if (s) {
      var rowsOut = [];
      var timeRow = function (label, v) {
        if (!String(v || '').trim()) return;
        rowsOut.push(h('div', { class: 'row ds-row' },
          h('span', { class: 'row-label' }, label),
          h('span', { class: 'ds-time num' }, String(v).trim())));
      };
      timeRow('Address', d.venueAddress);
      timeRow('Venue phone', d.venuePhone);
      timeRow('Load in', d.loadIn);
      (Array.isArray(d.soundchecks) ? d.soundchecks : []).forEach(function (r) {
        if (r && (r.band || r.time)) timeRow('Soundcheck \u2014 ' + (r.band || 'TBA'), r.time || 'TBA');
      });
      timeRow('VIP', d.vip);
      timeRow('Doors', d.doors);
      (Array.isArray(d.setTimes) ? d.setTimes : []).forEach(function (r) {
        if (r && (r.band || r.time)) timeRow(r.band || 'TBA', r.time || 'TBA');
      });
      timeRow('Lobby call', d.lobbyCall);
      timeRow('Bus call', d.busCall);
      var venueRows = [];
      if (String(d.wifi || '').trim()) venueRows.push(h('div', { class: 'row ds-row' },
        h('span', { class: 'row-label' }, 'Wifi'), h('span', { class: 'ds-val' }, d.wifi)));
      if (String(d.parking || '').trim()) venueRows.push(h('div', { class: 'row ds-row' },
        h('span', { class: 'row-label' }, 'Parking'), h('span', { class: 'ds-val' }, d.parking)));
      // Every amenity listed, a plain yes or no beside it.
      G.DS_AMENITIES.forEach(function (a) {
        var v = d[a[0]] === 'yes' ? 'Yes' : (d[a[0]] === 'no' ? 'No' : '\u2014');
        venueRows.push(h('div', { class: 'row ds-row' },
          h('span', { class: 'row-label' }, a[1]),
          h('span', { class: 'ds-val' }, v)));
      });
      body = [
        rowsOut.length ? h('div', { class: 'ledger' }, rowsOut) : null,
        venueRows.length ? h('div', { class: 'ledger', style: 'margin-top:12px' }, venueRows) : null,
        String(d.driveNext || '').trim() ? h('div', { class: 'ds-drive' },
          h('span', { class: 'hint' }, 'Drive to next venue'),
          h('strong', { class: 'num' }, d.driveNext)) : null
      ];
    } else {
      // An off day: the hotel and the plans.
      var offRows = [];
      var offRow = function (label, v) {
        if (!String(v || '').trim()) return;
        offRows.push(h('div', { class: 'row ds-row' },
          h('span', { class: 'row-label' }, label),
          h('span', { class: 'ds-val' }, String(v).trim())));
      };
      offRow('Hotel', off.hotel);
      offRow('Wifi', off.wifi);
      offRow('Rooms', off.rooms);
      var planRows = (Array.isArray(off.plans) ? off.plans : []).filter(function (r) {
        return r && (String(r.label || '').trim() || String(r.time || '').trim());
      }).map(function (r) {
        return h('div', { class: 'row ds-row' },
          h('span', { class: 'row-label' }, r.label || 'Plan'),
          h('span', { class: 'ds-time num' }, r.time || 'TBA'));
      });
      body = [
        offRows.length ? h('div', { class: 'ledger' }, offRows) : null,
        planRows.length ? [h('h3', { class: 'sh-h3' }, 'Reservations & plans'),
          h('div', { class: 'ledger' }, planRows)] : null,
        String(off.notes || '').trim() ? h('p', { class: 'note' }, off.notes) : null
      ];
    }

    var copyBtn = null;
    if (lines.length) {
      var copyText2 = s ? G.daySheetText(s) : G.offDayText(entry.date, off);
      copyBtn = h('button', {
        class: 'btn ghost block', type: 'button', style: 'margin-top:14px',
        onclick: async function () {
          var ta = h('textarea', { class: 'sr', readonly: true, value: copyText2 });
          document.body.appendChild(ta);
          var ok = await copyText(copyText2, ta);
          ta.remove();
          toast(ok ? 'Copied \u2014 paste it in the group chat' : 'Press and hold to copy');
        }
      }, icon('copy', 18), 'Copy day sheet');
    }

    var guestBtn = null;
    if (s) {
      var gl = guestsFor(t, id, s.id);
      var gsum = G.guestSummary(gl);
      guestBtn = h('div', { class: 'ledger inv-card', style: 'margin-top:14px' },
        h('button', { class: 'row rowbtn', type: 'button',
          onclick: function () { openGuestList(id, s.id); } },
          h('div', { class: 'row-label' }, 'Guest list',
            h('span', { class: 'hint' }, gsum.names
              ? plural(gsum.names, 'name') + ' \u00b7 ' + plural(gsum.tickets, 'ticket')
              : 'Anyone on the tour can add names')),
          icon('chevron', 18)));
    }

    // Every day of the run, one tap away; the hero follows.
    var rail = h('div', { class: 'ds-rail' }, days.map(function (x, i) {
      var dd = G.parseDay(x.date);
      var hasOff = !x.show && G.offDayLines(offDayFor(t, x.date)).length > 0;
      return h('button', {
        class: 'ds-chip' + (i === S.dsIndex ? ' on' : '') + (x.date === today ? ' tonight' : '') +
          (!x.show ? ' offd' + (hasOff ? ' filled' : '') : ''),
        type: 'button',
        onclick: function () { S.dsIndex = i; render(true); }
      },
        h('span', { class: 'ds-chip-d num' }, dd ? String(dd.getDate()) : '?'),
        h('span', { class: 'ds-chip-c' }, x.show
          ? String(x.show.city || '').split(',')[0]
          : (String(offDayFor(t, x.date).city || '').split(',')[0] ||
             (isRehearsalDay(t, x.date) ? 'rehearsal' : 'off'))));
    }));
    requestAnimationFrame(function () {
      var sel = rail.querySelector('.ds-chip.on');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ inline: 'center', block: 'nearest' });
    });

    var editRow = canEditTour(id) ? h('div', { class: 'btnrow ov-actions', style: 'margin-top:14px' },
      s
        ? h('button', { class: 'btn quiet glow', type: 'button',
            onclick: function () { openDaySheetEditor(id, s.id); } },
            icon('edit', 18), lines.length ? 'Edit day sheet' : 'Fill in the day sheet')
        : h('button', { class: 'btn quiet glow', type: 'button',
            onclick: function () { openOffDaySheet(id, entry.date); } },
            icon('edit', 18), lines.length ? 'Edit the off day' : 'Fill in the off day'),
      tourImportControl(id)) : null;

    // The same day picker serves three tabs; each shows its own half.
    if (only === 'guests') return [hero, rail, guestBtn];
    if (only === 'sheet') return [rail, editRow, body, copyBtn];
    return [hero, rail, editRow, body, guestBtn, copyBtn];
  }

  /* Set times rarely move on a run, so ask once and fill the rest. Only ever
     fills nights that have none — a night you already wrote is never touched. */
  function askSetTimesEverywhere(tourId, showId, setTimes) {
    var t = getTour(tourId);
    var others = G.rows(t && t.shows).filter(function (x) {
      if (x.id === showId || !G.parseDay(x.date)) return false;
      var d = G.isObj(x.daySheet) ? x.daySheet : {};
      var mine = Array.isArray(d.setTimes) ? d.setTimes : [];
      return !mine.some(function (r) { return String(r && r.time || '').trim(); });
    });
    if (!others.length) return;
    setTimeout(function () {
      confirmSheet({
        title: 'Are these set times the same all tour?',
        body: 'Say yes and they fill in on ' + plural(others.length, 'other night') +
          ' that has none yet. Any night you have already written stays as you wrote it.',
        action: 'Yes, every night',
        cancel: 'Just this night',
        onConfirm: async function () {
          var patch = {};
          others.forEach(function (x) {
            var d = G.isObj(x.daySheet) ? x.daySheet : {};
            patch[x.id] = { daySheet: Object.assign({}, d, {
              setTimes: setTimes.map(function (r) { return { band: r.band, time: r.time }; }) }) };
          });
          if (await api.update(tourId, { shows: patch })) {
            toast('Set times on ' + plural(others.length, 'night'));
            render(true);
          }
          return true;
        }
      });
    }, 500);
  }

  /* The off-day editor: where you land, where you sleep, what's planned. */
  function openOffDaySheet(tourId, date) {
    var t = getTour(tourId);
    var d0 = offDayFor(t, date);
    var f = {
      city: d0.city || '', hotel: d0.hotel || '', wifi: d0.wifi || '',
      rooms: d0.rooms || '', notes: d0.notes || '',
      plans: (Array.isArray(d0.plans) ? d0.plans : []).map(function (r) {
        return { label: r.label || '', time: r.time || '' }; })
    };
    openSheet(function () {
      function textIn(key, ph) {
        return h('input', { class: 'input', type: 'text', value: f[key], maxlength: 120,
          autocomplete: 'off', placeholder: ph || '',
          oninput: function (e) { f[key] = e.target.value; } });
      }
      var plansHost = h('div', null);
      function buildPlans() {
        var kids = f.plans.map(function (r, i) {
          return h('div', { class: 'af-row', style: 'margin-bottom:8px' },
            h('input', { class: 'input', type: 'text', value: r.label, maxlength: 80,
              placeholder: 'Dinner at\u2026', autocomplete: 'off',
              oninput: function (e) { r.label = e.target.value; } }),
            h('input', { class: 'input', type: 'text', value: r.time, maxlength: 20,
              placeholder: 'Time', autocomplete: 'off', style: 'flex:0 0 110px',
              oninput: function (e) { r.time = e.target.value; } }),
            h('button', { class: 'iconbtn sm', type: 'button', 'aria-label': 'Remove',
              onclick: function () { f.plans.splice(i, 1); buildPlans(); } }, icon('trash', 16)));
        });
        kids.push(h('button', { class: 'btn quiet block', type: 'button', style: 'min-height:42px',
          onclick: function () { f.plans.push({ label: '', time: '' }); buildPlans(); } },
          '+ Add a reservation or plan'));
        plansHost.replaceChildren.apply(plansHost, kids);
      }
      var submit = async function (e) {
        e.preventDefault();
        blurActive();
        var sheet = {
          city: f.city.trim(), hotel: f.hotel.trim(), wifi: f.wifi.trim(),
          rooms: f.rooms.trim(), notes: f.notes.trim(),
          plans: f.plans.filter(function (r) { return r.label.trim() || r.time.trim(); })
            .map(function (r) { return { label: r.label.trim(), time: r.time.trim() }; })
        };
        var patch = { offDays: {} };
        patch.offDays[date] = sheet;
        if (await api.update(tourId, patch)) {
          closeSheet(); toast('Off day posted'); render(true);
        }
      };
      buildPlans();
      return [
        h('h2', { class: 'sh-title' }, 'Off day \u2014 ' + dayLong(date)),
        h('p', { class: 'sh-sub' }, 'Where the day lands, where everyone sleeps, and what\u2019s planned. Blank fields just don\u2019t show.'),
        h('form', { class: 'sh-form', onsubmit: submit, novalidate: true },
          field('City', textIn('city', 'Salt Lake City, UT')),
          field('Hotel', textIn('hotel', 'Hotel name and address')),
          h('div', { class: 'field-row' },
            field('Wifi', textIn('wifi', 'Network / password')),
            field('Rooms', textIn('rooms', 'Under D. Oliver'))),
          field('Reservations & plans', plansHost),
          field('Anything else', textIn('notes', 'Optional')),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Post the off day'),
            h('button', { class: 'btn ghost block', type: 'button',
              onclick: function () { closeSheet(); } }, 'Cancel')))
      ];
    }, { label: 'Off day' });
  }

  /* Travel days stretch the run past the first and last show. */
  /* Straight after a flyer: who is on this bill, in running order. The list
     seeds every day sheet on the run, so nobody types it twice. */
  function openLineupPrompt(tourId) {
    var count = 3;
    var names = [];
    function roleOf(i, n) {
      if (i === n - 1) return 'Headliner';
      if (i === 0) return 'Opener';
      if (i === n - 2) return 'Direct support';
      return 'Support';
    }
    function step2() {
      names = names.slice(0, count);
      while (names.length < count) names.push('');
      openSheet(function () {
        var rows = names.map(function (_, i) {
          return field(roleOf(i, count), h('input', {
            class: 'input', type: 'text', maxlength: 60, value: names[i],
            placeholder: roleOf(i, count) === 'Headliner' ? 'The act everyone came for' : 'Band name',
            autocomplete: 'off',
            oninput: function (e) { names[i] = e.target.value; }
          }));
        });
        var save = async function (e) {
          e.preventDefault();
          blurActive();
          var clean = names.map(function (x) { return String(x || '').trim(); }).filter(Boolean);
          if (!clean.length) { closeSheet(); return; }
          if (await api.update(tourId, { bands: clean })) {
            closeSheet();
            toast(plural(clean.length, 'band') + ' on the bill \u2014 every day sheet starts with them');
            render(true);
          }
        };
        return [
          h('h2', { class: 'sh-title' }, 'What bands are on this tour?'),
          h('p', { class: 'sh-sub' }, 'Opener at the top, headliner at the bottom \u2014 the order they play. Every day sheet on this run starts with these, and you can drop anyone from a night.'),
          h('form', { class: 'sh-form', onsubmit: save, novalidate: true },
            rows,
            h('div', { class: 'stack' },
              h('button', { class: 'btn primary block', type: 'submit' }, 'Save the bill'),
              h('button', { class: 'btn ghost block', type: 'button',
                onclick: function () { closeSheet(); } },
                'Skip for now')))
        ];
      }, { label: 'The bill' });
    }
    openSheet(function () {
      var picked = h('strong', { class: 'num' }, String(count));
      function set(v) { count = Math.max(1, Math.min(8, v)); picked.textContent = String(count); }
      return [
        h('h2', { class: 'sh-title' }, 'How many bands are on this tour?'),
        h('p', { class: 'sh-sub' }, 'Counting the headliner. You can change it later.'),
        h('div', { class: 'ledger' },
          h('div', { class: 'row' },
            h('div', { class: 'row-label' }, 'Bands on the bill', h('span', { class: 'hint' }, picked)),
            h('div', { class: 'seg big' },
              h('button', { class: 'seg-b', type: 'button', 'aria-label': 'Fewer',
                onclick: function () { set(count - 1); } }, '\u2212'),
              h('button', { class: 'seg-b', type: 'button', 'aria-label': 'More',
                onclick: function () { set(count + 1); } }, '+')))),
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary block', type: 'button', onclick: step2 }, 'Next'),
          h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () { closeSheet(); } },
            'Skip for now'))
      ];
    }, { label: 'The bill' });
  }

  function openTravelDaysSheet(tourId, onDone) {
    var done = function () { if (onDone) setTimeout(onDone, 300); };
    var t = getTour(tourId);
    var shows = G.rows(t && t.shows).filter(function (x) { return G.parseDay(x.date); }).sort(G.byDate);
    if (!shows.length) { done(); return; }
    var first = shows[0].date, last = shows[shows.length - 1].date;
    var before = G.parseDay(t.spanStart) && t.spanStart < first ? G.daysBetween(t.spanStart, first) : 0;
    var after = G.parseDay(t.spanEnd) && t.spanEnd > last ? G.daysBetween(last, t.spanEnd) : 0;
    openSheet(function () {
      var beforeEl = h('strong', { class: 'num' }, '');
      var afterEl = h('strong', { class: 'num' }, '');
      function refresh() {
        beforeEl.textContent = before ? plural(before, 'day') + ' \u00b7 from ' + dayMD(G.addDays(first, -before)) : 'None';
        afterEl.textContent = after ? plural(after, 'day') + ' \u00b7 to ' + dayMD(G.addDays(last, after)) : 'None';
      }
      function stepper(get, set) {
        // Big targets: these were 38x34 and missed a lot of taps.
        return h('div', { class: 'seg big' },
          h('button', { class: 'seg-b', type: 'button', 'aria-label': 'Fewer',
            onclick: function () { set(Math.max(0, get() - 1)); refresh(); } }, '\u2212'),
          h('button', { class: 'seg-b', type: 'button', 'aria-label': 'More',
            onclick: function () { set(Math.min(14, get() + 1)); refresh(); } }, '+'));
      }
      refresh();
      return [
        h('h2', { class: 'sh-title' }, 'Travel days'),
        h('p', { class: 'sh-sub' }, 'Days on the road before the first show and after the last one. They join the run as off days you can fill in.'),
        h('div', { class: 'ledger' },
          h('div', { class: 'row' },
            h('div', { class: 'row-label' }, 'Before the tour', h('span', { class: 'hint' }, beforeEl)),
            stepper(function () { return before; }, function (v) { before = v; })),
          h('div', { class: 'row' },
            h('div', { class: 'row-label' }, 'After the tour', h('span', { class: 'hint' }, afterEl)),
            stepper(function () { return after; }, function (v) { after = v; }))),
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary block', type: 'button',
            onclick: async function () {
              var patch = {
                spanStart: before ? G.addDays(first, -before) : null,
                spanEnd: after ? G.addDays(last, after) : null
              };
              if (await api.update(tourId, patch)) {
                closeSheet();
                toast(before || after ? 'Travel days on the run' : 'No travel days');
                render(true);
                done();
              }
            } }, 'Save'),
          h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () { closeSheet(); done(); } }, 'Not now'))
      ];
    }, { label: 'Travel days' });
  }

  /* Rehearsal days before the run: asked after travel days, with real dates,
     so the schedule shows the whole picture from the first downbeat. */
  function openRehearsalSheet(tourId, onDone) {
    var done = function () { if (onDone) setTimeout(onDone, 300); };
    var t = getTour(tourId);
    var shows = G.rows(t && t.shows).filter(function (x) { return G.parseDay(x.date); }).sort(G.byDate);
    if (!shows.length) { done(); return; }
    var first = shows[0].date;
    var f = { start: t.rehearsalStart || '', end: t.rehearsalEnd || '' };
    openSheet(function () {
      function dateIn(key, label) {
        return field(label, h('input', { class: 'input', type: 'date', value: f[key],
          'aria-label': label, oninput: function (e) { f[key] = e.target.value; } }));
      }
      return [
        h('h2', { class: 'sh-title' }, 'Rehearsal days before the tour?'),
        h('p', { class: 'sh-sub' }, 'They join the run so day sheets and plans can start before the first show.'),
        h('form', { class: 'sh-form', novalidate: true,
          onsubmit: async function (e) {
            e.preventDefault();
            if (!G.parseDay(f.start) || !G.parseDay(f.end)) { toast('Pick both dates'); return; }
            if (f.start > f.end) { toast('The first day has to come before the last'); return; }
            if (f.end >= first) { toast('Rehearsals wrap before the first show on ' + dayMD(first)); return; }
            blurActive();
            if (await api.update(tourId, { rehearsalStart: f.start, rehearsalEnd: f.end })) {
              closeSheet();
              toast(plural(G.daysBetween(f.start, f.end) + 1, 'rehearsal day') + ' on the run');
              render(true);
              done();
            }
          } },
          dateIn('start', 'First rehearsal'),
          dateIn('end', 'Last rehearsal'),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Save'),
            h('button', { class: 'btn ghost block', type: 'button',
              onclick: function () { closeSheet(); done(); } }, 'No rehearsals')))
      ];
    }, { label: 'Rehearsals' });
  }

  /* Guests live in their own table on the real backend (so GA can add names
     without being able to touch the money); on-device they ride the tour doc. */
  function guestsFor(t, tourId, showId) {
    if (window.GR_BACKEND && S.mode === 'db' && window.GR_BACKEND.guestsFor) {
      return window.GR_BACKEND.guestsFor(tourId, showId);
    }
    var bag = t && G.isObj(t.guests) && G.isObj(t.guests[showId]) ? t.guests[showId] : {};
    return G.rows(bag);
  }
  async function saveGuest(tourId, showId, guest) {
    if (window.GR_BACKEND && S.mode === 'db' && window.GR_BACKEND.saveGuest) {
      await window.GR_BACKEND.saveGuest(tourId, showId, guest);
      return true;
    }
    var patch = { guests: {} };
    patch.guests[showId] = {};
    patch.guests[showId][guest.id] = {
      firstName: guest.firstName, lastName: guest.lastName, affiliation: guest.affiliation,
      email: guest.email, phone: guest.phone, qty: guest.qty, passType: guest.passType,
      createdAt: Date.now()
    };
    return api.update(tourId, patch);
  }
  /* One night's comments: read them, add one, take your own back. */
  function openDayNotes(tourId, day) {
    var backend = !!(window.GR_BACKEND && S.mode === 'db' && window.GR_BACKEND.notesFor);
    var myUid = backend ? window.GR_BACKEND.uid() : null;
    function build() {
      var t = getTour(tourId);
      var list = notesFor(t, tourId, day);
      var night = (G.rows(t && t.shows) || []).filter(function (x) { return x.date === day; })[0];
      var input = h('input', { class: 'input', type: 'text', maxlength: 180,
        placeholder: 'Say something about this night\u2026', autocomplete: 'off',
        enterkeyhint: 'send' });
      var rows = list.map(function (n) {
        // Yours to delete if you wrote it — or if we can't tell yet, let the
        // server be the judge rather than hiding the button.
        var mine = !backend || !myUid || (n.addedBy && n.addedBy === myUid);
        return h('div', { class: 'row' },
          h('div', { class: 'row-label' }, n.author || 'Someone',
            h('span', { class: 'hint' }, n.body)),
          (canWrite() || mine) ? h('button', { class: 'iconbtn sm', type: 'button',
            'aria-label': 'Delete this note',
            onclick: async function () {
              var gone = false;
              try {
                await removeNote(tourId, day, n.id);
                gone = true;
              } catch (e) {
                toast(e && e.code === 'permission'
                  ? 'That note belongs to someone else.'
                  : 'That note could not be deleted. Try again.');
              }
              if (gone) { render(true); setTimeout(build, backend ? 500 : 120); }
            } }, icon('trash', 16)) : null);
      });
      openSheet(function () {
        return [
          h('h2', { class: 'sh-title' }, dayLong(day)),
          h('p', { class: 'sh-sub' }, night
            ? (night.city || 'Show') + ' \u2014 anyone on the tour can leave a note here.'
            : 'Anyone on the tour can leave a note here.'),
          h('form', { class: 'sh-form', novalidate: true,
            onsubmit: async function (e) {
              e.preventDefault();
              var body = String(input.value || '').trim();
              if (!body) return;
              blurActive();
              try {
                await saveNote(tourId, day, { id: newId(), body: body, author: myName() });
                input.value = '';
                render(true);
                setTimeout(build, backend ? 500 : 120);
              } catch (e2) { toast('Couldn\u2019t post that. Try again.'); }
            } },
            input,
            h('button', { class: 'btn primary block', type: 'submit' }, 'Post')),
          rows.length ? h('div', { class: 'ledger' }, rows)
            : h('p', { class: 'note' }, 'Nothing yet \u2014 be the first.')
        ];
      }, { label: 'Notes' });
    }
    build();
  }

  /* Notes on a night — the comments that ride under the balance line.
     Anyone on the tour can leave one, same as the guest list. */
  function notesFor(t, tourId, day) {
    if (window.GR_BACKEND && S.mode === 'db' && window.GR_BACKEND.notesFor) {
      return window.GR_BACKEND.notesFor(tourId, day);
    }
    var bag = t && G.isObj(t.dayNotes) && G.isObj(t.dayNotes[day]) ? t.dayNotes[day] : {};
    return G.rows(bag).map(function (n) { return Object.assign({ day: day }, n); });
  }
  function myName() {
    var B = window.GR_BACKEND;
    var u = B && B.username ? B.username() : null;
    if (u) return u;
    var e = B && B.email ? B.email() : null;
    return e ? String(e).split('@')[0] : 'You';
  }

  /* Your card in the tour's phone book. Asked once for accounts made before
     it existed, changeable any time from the home page. */
  function openUsernameSheet(firstRun) {
    var B = window.GR_BACKEND;
    if (!B || !B.saveProfile) return;
    var cur = B.myProfile ? B.myProfile() : {};
    var f = { firstName: cur.firstName || '', lastName: cur.lastName || '',
      phone: cur.phone || '', tourRole: cur.tourRole || '' };
    openSheet(function () {
      function textIn(key, ph, extra) {
        return h('input', Object.assign({
          class: 'input', type: 'text', value: f[key], maxlength: 30,
          autocomplete: 'off', placeholder: ph,
          oninput: function (e) { f[key] = e.target.value; }
        }, extra || {}));
      }
      // Our own list, not the phone's dropdown (which misbehaves in sheets).
      var roleSel = h('button', { class: 'input role-pick' + (f.tourRole ? '' : ' empty'), type: 'button',
        'aria-haspopup': 'listbox', 'aria-label': 'Your role on the tour',
        onclick: function () {
          if (!B.openRolePicker) return;
          B.openRolePicker(f.tourRole, function (r) {
            f.tourRole = r;
            roleSel.textContent = r;
            roleSel.classList.remove('empty');
          });
        } }, f.tourRole || 'Your role on the tour');
      return [
        h('h2', { class: 'sh-title' }, cur.tourRole ? 'Your contact card' : 'Add your details'),
        h('p', { class: 'sh-sub' }, 'Your name rides everything you write. The rest is how the tour reaches you \u2014 everyone on the run can see it.'),
        h('form', { class: 'sh-form', novalidate: true,
          onsubmit: async function (e) {
            e.preventDefault();
            if (!f.firstName.trim()) { toast('Type your first name'); return; }
            if (!f.lastName.trim()) { toast('Type your last name'); return; }
            if (!f.tourRole) { toast('Pick your role on the tour'); return; }
            blurActive();
            try {
              await B.saveProfile(f);
              closeSheet();
              toast('Saved \u2014 you\u2019re ' + (f.firstName.trim() + ' ' + f.lastName.trim()) + ', ' + f.tourRole);
              render(true);
            } catch (e2) { toast('Couldn\u2019t save it. Try again.'); }
          } },
          h('div', { class: 'field-row' },
            field('First name', textIn('firstName', 'Devin', { autocomplete: 'given-name' })),
            field('Last name', textIn('lastName', 'Oliver', { autocomplete: 'family-name' }))),
          field('Phone', textIn('phone', '(555) 555-5555',
            { type: 'tel', inputmode: 'tel', autocomplete: 'tel' })),
          field('Role on the tour', roleSel),
          cur.email ? h('p', { class: 'note' }, 'Signed in as ' + cur.email) : null,
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Save'),
            h('button', { class: 'btn ghost block', type: 'button',
              onclick: function () { closeSheet(); } }, firstRun ? 'Later' : 'Cancel')))
      ];
    }, { label: 'Your details' });
  }
  async function saveNote(tourId, day, note) {
    if (window.GR_BACKEND && S.mode === 'db' && window.GR_BACKEND.saveNote) {
      await window.GR_BACKEND.saveNote(tourId, day, note);
      return true;
    }
    var patch = { dayNotes: {} };
    patch.dayNotes[day] = {};
    patch.dayNotes[day][note.id] = { body: note.body, author: note.author, at: Date.now() };
    return api.update(tourId, patch);
  }
  async function removeNote(tourId, day, noteId) {
    if (window.GR_BACKEND && S.mode === 'db' && window.GR_BACKEND.removeNote) {
      await window.GR_BACKEND.removeNote(noteId);
      return true;
    }
    var patch = { dayNotes: {} };
    patch.dayNotes[day] = {};
    patch.dayNotes[day][noteId] = null;
    return api.update(tourId, patch);
  }

  async function removeGuest(tourId, showId, guestId) {
    if (window.GR_BACKEND && S.mode === 'db' && window.GR_BACKEND.removeGuest) {
      await window.GR_BACKEND.removeGuest(guestId);
      return true;
    }
    var patch = { guests: {} };
    patch.guests[showId] = {};
    patch.guests[showId][guestId] = null;
    return api.update(tourId, patch);
  }

  function openGuestList(tourId, showId) {
    var backend = !!(window.GR_BACKEND && S.mode === 'db' && window.GR_BACKEND.guestsFor);
    var myUid = backend ? window.GR_BACKEND.uid() : null;

    function build() {
      var t = getTour(tourId);
      var show = t && G.isObj(t.shows) && G.isObj(t.shows[showId]) ? t.shows[showId] : {};
      var list = guestsFor(t, tourId, showId);
      var sum = G.guestSummary(list);

      var rowsOut = list.slice().sort(function (a, b) {
        return String(a.lastName || '').localeCompare(String(b.lastName || '')) ||
          String(a.firstName || '').localeCompare(String(b.firstName || ''));
      }).map(function (g) {
        var name = [g.firstName, g.lastName].map(function (x) { return String(x || '').trim(); })
          .filter(Boolean).join(' ') || 'Guest';
        var mine = !backend || (g.addedBy && g.addedBy === myUid);
        var canManage = canWrite() || mine;
        var sub = [String(g.affiliation || '').trim(),
          [String(g.email || '').trim(), String(g.phone || '').trim()].filter(Boolean).join(' \u00b7 ')]
          .filter(Boolean).join(' \u00b7 ');
        return h('div', { class: 'row' },
          h('div', { class: 'row-label' }, name,
            sub ? h('span', { class: 'hint' }, sub) : null),
          h('span', { class: 'guest-pass' + (g.passType === 'All Access' ? ' aa' : '') },
            (function () {
              var q = Math.max(1, Math.min(20, G.num(g.qty) || 1));
              return (q > 1 ? '+' + (q - 1) + ' \u00b7 ' : '') + (g.passType || 'GA');
            })()),
          canManage ? h('button', { class: 'iconbtn sm', type: 'button',
            'aria-label': 'Remove ' + name,
            onclick: async function () {
              try { await removeGuest(tourId, showId, g.id); toast('Off the list'); setTimeout(build, backend ? 500 : 150); }
              catch (e2) { toast('Only the tour manager can remove someone else\u2019s guest.'); }
            } }, icon('trash', 16)) : null);
      });

      var copyBtn = list.length ? h('button', {
        class: 'btn ghost block', type: 'button', style: 'margin-top:12px',
        onclick: async function () {
          var text = G.guestListText(show, list);
          var ta = h('textarea', { class: 'sr', readonly: true, value: text });
          document.body.appendChild(ta);
          var ok = await copyText(text, ta);
          ta.remove();
          toast(ok ? 'Guest list copied for the box office' : 'Press and hold to copy');
        }
      }, icon('copy', 18), 'Copy for the box office') : null;

      openSheet(function () {
        return [
          h('h2', { class: 'sh-title' }, 'Guest list \u2014 ' + (show.city || 'Show')),
          h('p', { class: 'sh-sub' }, sum.names
            ? plural(sum.names, 'name') + ' \u00b7 ' + plural(sum.tickets, 'ticket')
            : 'Anyone on the tour can add names here \u2014 band, crew, GA, everyone.'),
          h('div', { class: 'gl-actions' },
            h('button', { class: 'add-mini', type: 'button',
              onclick: function () { openGuestForm(tourId, showId, show, backend, build); } },
              h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), 'Add guest'),
            h('button', { class: 'add-mini', type: 'button',
              onclick: function () { openGuestImport(tourId, showId, show, backend, build); } },
              h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), 'Import a list')),
          rowsOut.length ? h('div', { class: 'ledger' }, rowsOut) : null,
          copyBtn
        ];
      }, { label: 'Guest list' });
    }
    build();
  }

  /* One guest at a time — its own sheet, then straight back to the list. */
  function openGuestForm(tourId, showId, show, backend, done) {
    var f = { firstName: '', lastName: '', affiliation: '', email: '', phone: '',
      qty: 1, passType: 'GA' };
    function textIn(key, ph, extra) {
      return h('input', Object.assign({
        class: 'input', type: 'text', value: f[key], maxlength: 80,
        autocomplete: 'off', placeholder: ph,
        oninput: function (e) { f[key] = e.target.value; }
      }, extra || {}));
    }
    var qtySel = h('select', { class: 'input', 'aria-label': 'How many they bring',
      onchange: function (e) { f.qty = G.num(e.target.value) || 1; } });
    qtySel.append(h('option', { value: '1' }, 'Just them'));
    for (var i = 1; i <= 10; i++) qtySel.append(h('option', { value: String(i + 1) }, '+' + i));
    var passSel = h('select', { class: 'input', 'aria-label': 'Pass type',
      onchange: function (e) { f.passType = e.target.value; } });
    G.GUEST_PASSES.forEach(function (ptype) { passSel.append(h('option', { value: ptype }, ptype)); });
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'Add a guest \u2014 ' + (show.city || 'Show')),
        h('form', { class: 'sh-form', novalidate: true,
          onsubmit: async function (e) {
            e.preventDefault();
            if (!f.firstName.trim() && !f.lastName.trim()) {
              toast('Give the guest at least a name'); return;
            }
            blurActive();
            try {
              await saveGuest(tourId, showId, {
                id: newId(),
                firstName: f.firstName.trim(), lastName: f.lastName.trim(),
                affiliation: f.affiliation.trim(), email: f.email.trim(), phone: f.phone.trim(),
                qty: Math.max(1, Math.min(20, f.qty)), passType: f.passType
              });
              toast('On the list: ' + (f.firstName + ' ' + f.lastName).trim());
              sendNotify(tourId, 'guest', { name: (f.firstName + ' ' + f.lastName).trim(),
                city: show.city || '', tickets: Math.max(1, Math.min(20, f.qty)) });
              setTimeout(done, backend ? 500 : 150); // let the refetch land
            } catch (e2) { toast('Couldn\u2019t add them. Try again.'); }
          } },
          h('div', { class: 'field-row' },
            field('First name', textIn('firstName', 'Devin')),
            field('Last name', textIn('lastName', 'Oliver'))),
          field('Affiliation', textIn('affiliation', 'Label, press, family\u2026')),
          h('div', { class: 'field-row' },
            field('Contact email', textIn('email', 'Optional', { type: 'email', inputmode: 'email' })),
            field('Contact phone', textIn('phone', 'Optional', { type: 'tel', inputmode: 'tel' }))),
          h('div', { class: 'field-row' },
            field('Brings', qtySel),
            field('Pass type', passSel)),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Add to the list'),
            h('button', { class: 'btn ghost block', type: 'button',
              onclick: function () { done(); } }, 'Back to the list')))
      ];
    }, { label: 'Add a guest' });
  }

  /* Someone sends a pile of names: paste it, Claude (or a plain parser) sorts
     it into guests, and the whole batch lands at once. */
  function openGuestImport(tourId, showId, show, backend, done) {
    var parsed = null;
    var defaultPass = 'GA';
    function sheet() { openSheet(body, { label: 'Import a guest list' }); }
    function body() {
      if (!parsed) {
        var ta = h('textarea', { class: 'gl-paste',
          placeholder: 'Sam Reyes +1 (label)\nDana Cole \u2014 dana@mail.com\nmgmt group x4',
          'aria-label': 'The guest list text' });
        var readBtn = h('button', { class: 'btn primary block', type: 'button',
          onclick: async function () {
            var text = String(ta.value || '').trim();
            if (!text) { toast('Paste the list first'); return; }
            readBtn.disabled = true; readBtn.textContent = 'Extracting\u2026';
            var got = null;
            if (S.sample) {
              try {
                var out = await S.sample.json(guestImportPrompt(text), { modelTier: 'quick', cache: false });
                got = normalizeGuestImport(out);
              } catch (e) { got = null; }
            }
            if (!got || !got.length) got = G.parseGuestList(text);
            if (!got.length) {
              readBtn.disabled = false; readBtn.textContent = 'Read the list';
              toast('No names found in that \u2014 check the text'); return;
            }
            parsed = got;
            sheet();
          } }, 'Read the list');
        return [
          h('h2', { class: 'sh-title' }, 'Import a guest list'),
          h('p', { class: 'sh-sub' }, 'Drop in the whole pile \u2014 texts, an email, whatever. One name per line reads best; \u201c+1\u201ds, emails and phone numbers come along for the ride.'),
          ta,
          h('div', { class: 'stack' }, readBtn,
            h('button', { class: 'btn ghost block', type: 'button',
              onclick: function () { done(); } }, 'Cancel'))
        ];
      }
      var passSel = h('select', { class: 'input', 'aria-label': 'Pass type for everyone',
        onchange: function (e) { defaultPass = e.target.value; } });
      G.GUEST_PASSES.forEach(function (ptype) { passSel.append(h('option', { value: ptype }, ptype)); });
      passSel.value = defaultPass;
      var listOut = h('div', { class: 'ledger' });
      function renderRows() {
        listOut.replaceChildren.apply(listOut, parsed.map(function (g, i) {
          var name = [g.firstName, g.lastName].filter(Boolean).join(' ') || 'Guest';
          var qtySel = h('select', { class: 'input', style: 'width:auto;flex:none', 'aria-label': 'Who ' + name + ' brings',
            onchange: function (e) { g.qty = G.num(e.target.value) || 1; } });
          qtySel.append(h('option', { value: '1' }, 'Just them'));
          for (var q = 1; q <= 10; q++) qtySel.append(h('option', { value: String(q + 1) }, '+' + q));
          qtySel.value = String(Math.max(1, Math.min(11, G.num(g.qty) || 1)));
          var sub = [g.affiliation, g.email, g.phone].filter(Boolean).join(' \u00b7 ');
          return h('div', { class: 'row' },
            h('div', { class: 'row-label' }, name,
              sub ? h('span', { class: 'hint' }, sub) : null),
            qtySel,
            h('button', { class: 'iconbtn sm', type: 'button', 'aria-label': 'Remove ' + name,
              onclick: function () {
                parsed.splice(i, 1);
                if (parsed.length) renderRows(); else { parsed = null; sheet(); }
              } }, icon('trash', 16)));
        }));
      }
      renderRows();
      var addBtn = h('button', { class: 'btn primary block', type: 'button',
        onclick: async function () {
          addBtn.disabled = true; addBtn.textContent = 'Adding\u2026';
          var n = 0; var first = ''; var tickets = 0;
          try {
            for (var i = 0; i < parsed.length; i++) {
              var g = parsed[i];
              var q2 = Math.max(1, Math.min(20, G.num(g.qty) || 1));
              await saveGuest(tourId, showId, {
                id: newId() + i, firstName: g.firstName, lastName: g.lastName,
                affiliation: g.affiliation, email: g.email, phone: g.phone,
                qty: q2, passType: defaultPass
              });
              if (!n) first = [g.firstName, g.lastName].filter(Boolean).join(' ');
              n += 1; tickets += q2;
            }
          } catch (e) { /* whatever landed, landed */ }
          if (n) {
            toast(plural(n, 'guest') + ' on the list');
            sendNotify(tourId, 'guest', {
              name: n === 1 ? first : first + ' and ' + (n - 1) + ' more',
              city: show.city || '', tickets: tickets });
            setTimeout(done, backend ? 600 : 150);
          } else {
            addBtn.disabled = false; addBtn.textContent = 'Add them to the list';
            toast('Couldn\u2019t add them. Try again.');
          }
        } }, 'Add them to the list');
      return [
        h('h2', { class: 'sh-title' }, plural(parsed.length, 'name') + ' found'),
        h('p', { class: 'sh-sub' }, 'Check the tickets, pick everyone\u2019s pass type, then add the lot. Fix anyone\u2019s details from the list after.'),
        field('Pass type for everyone', passSel),
        listOut,
        h('div', { class: 'stack' }, addBtn,
          h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () { parsed = null; sheet(); } }, 'Back to the paste'))
      ];
    }
    sheet();
  }

  function guestImportPrompt(text) {
    return [
      'The text below is a concert guest list \u2014 names people sent in, however messy.',
      'Turn it into structured guests. Reply with only a JSON object in this exact shape:',
      '{"guests":[{"firstName":"","lastName":"","affiliation":"","email":"","phone":"","qty":1}]}',
      '',
      'Rules:',
      '- qty is that entry\u2019s TOTAL tickets: "Sam +1" is qty 2, a plain name is 1. Cap at 20.',
      '- affiliation only when the text says it (label, press, family, management). Never invent anything.',
      '- Skip lines that are not guests \u2014 greetings, dates, sign-offs.',
      '',
      'Guest list text:',
      String(text).slice(0, 8000)
    ].join('\n');
  }

  function normalizeGuestImport(out) {
    var arr = G.isObj(out) && Array.isArray(out.guests) ? out.guests : (Array.isArray(out) ? out : []);
    var res = [];
    arr.slice(0, 100).forEach(function (g) {
      if (!G.isObj(g)) return;
      var take = function (k, cap) { return String(g[k] == null ? '' : g[k]).trim().slice(0, cap || 80); };
      var row = { firstName: take('firstName'), lastName: take('lastName'),
        affiliation: take('affiliation'), email: take('email'), phone: take('phone', 40),
        qty: Math.max(1, Math.min(20, G.num(g.qty) || 1)) };
      if (row.firstName || row.lastName || row.email) res.push(row);
    });
    return res;
  }

  function openDaySheetEditor(tourId, showId) {
    var t = getTour(tourId);
    var s = t && G.isObj(t.shows) && G.isObj(t.shows[showId]) ? t.shows[showId] : null;
    if (!s) return;
    var d0 = G.isObj(s.daySheet) ? s.daySheet : {};
    var f = {
      venueAddress: d0.venueAddress || '', venuePhone: d0.venuePhone || '',
      loadIn: d0.loadIn || '', vip: d0.vip || '', doors: d0.doors || '',
      lobbyCall: d0.lobbyCall || '', busCall: d0.busCall || '',
      wifi: d0.wifi || '', parking: d0.parking || '',
      driveNext: d0.driveNext || '', notes: d0.notes || '',
      soundchecks: (Array.isArray(d0.soundchecks) ? d0.soundchecks : []).map(function (r) {
        return { band: r.band || '', time: r.time || '' }; }),
      setTimes: (Array.isArray(d0.setTimes) ? d0.setTimes : []).map(function (r) {
        return { band: r.band || '', time: r.time || '' }; })
    };
    // A blank day starts with the tour's lineup already in the rows —
    // one soundcheck and one set time per band, times waiting to be typed.
    var lineup = tourBands(t);
    if (lineup.length) {
      if (!f.soundchecks.length) {
        f.soundchecks = lineup.map(function (b) { return { band: b, time: '' }; });
      }
      if (!f.setTimes.length) {
        f.setTimes = lineup.map(function (b) { return { band: b, time: '' }; });
      }
    }
    G.DS_AMENITIES.forEach(function (a) { f[a[0]] = d0[a[0]] || ''; });

    openSheet(function () {
      function textIn(key, ph) {
        return h('input', { class: 'input', type: 'text', value: f[key], maxlength: 80,
          autocomplete: 'off', placeholder: ph || '',
          oninput: function (e) { f[key] = e.target.value; } });
      }
      function bandList(key, addLabel) {
        var host = h('div', { class: 'ds-bands' });
        function build() {
          var kids = f[key].map(function (r, i) {
            return h('div', { class: 'af-row', style: 'margin-bottom:8px' },
              h('input', { class: 'input', type: 'text', value: r.band, maxlength: 60,
                placeholder: 'Band', autocomplete: 'off',
                oninput: function (e) { r.band = e.target.value; } }),
              h('input', { class: 'input', type: 'text', value: r.time, maxlength: 20,
                placeholder: 'Time', autocomplete: 'off', style: 'flex:0 0 110px',
                oninput: function (e) { r.time = e.target.value; } }),
              h('button', { class: 'iconbtn sm', type: 'button', 'aria-label': 'Remove',
                onclick: function () { f[key].splice(i, 1); build(); } }, icon('trash', 16)));
          });
          kids.push(h('button', { class: 'btn quiet block', type: 'button', style: 'min-height:42px',
            onclick: function () { f[key].push({ band: '', time: '' }); build(); } }, addLabel));
          host.replaceChildren.apply(host, kids);
        }
        build();
        return host;
      }
      function yesNo(key, label) {
        var idx = f[key] === 'yes' ? 1 : f[key] === 'no' ? 2 : 0;
        return h('div', { class: 'ds-yn' },
          h('span', { class: 'field-label', style: 'margin:0' }, label),
          segmented(['\u2014', 'Yes', 'No'], idx, function (i) {
            f[key] = i === 1 ? 'yes' : i === 2 ? 'no' : '';
          }, label));
      }
      var submit = async function (e) {
        e.preventDefault();
        blurActive();
        var clean = function (list) {
          return list.filter(function (r) { return r.band.trim() || r.time.trim(); })
            .map(function (r) { return { band: r.band.trim(), time: r.time.trim() }; });
        };
        var sheet = {
          venueAddress: f.venueAddress.trim(), venuePhone: f.venuePhone.trim(),
          loadIn: f.loadIn.trim(), vip: f.vip.trim(), doors: f.doors.trim(),
          lobbyCall: f.lobbyCall.trim(), busCall: f.busCall.trim(),
          wifi: f.wifi.trim(), parking: f.parking.trim(),
          driveNext: f.driveNext.trim(), notes: f.notes.trim(),
          soundchecks: clean(f.soundchecks), setTimes: clean(f.setTimes)
        };
        G.DS_AMENITIES.forEach(function (a) { sheet[a[0]] = f[a[0]] || ''; });
        var patch = {};
        patch[showId] = { daySheet: sheet };
        if (await api.update(tourId, { shows: patch })) {
          closeSheet(); toast('Day sheet posted'); render(true);
          // Most runs keep the same set times every night — offer to carry them.
          if (sheet.setTimes.length) askSetTimesEverywhere(tourId, showId, sheet.setTimes);
        }
      };
      return [
        h('h2', { class: 'sh-title' }, 'Day sheet \u2014 ' + (s.city || 'Show')),
        h('p', { class: 'sh-sub' }, 'Everything the bus needs for the day. Leave anything blank and it just doesn\u2019t show.'),
        h('form', { class: 'sh-form', onsubmit: submit, novalidate: true },
          field('Venue address', textIn('venueAddress', '2115 Woodward Ave')),
          field('Venue phone', textIn('venuePhone', '(313) 961-5451')),
          h('div', { class: 'field-row' },
            field('Load in', textIn('loadIn', '2:00 PM')),
            field('Doors', textIn('doors', '7:00 PM'))),
          field('Soundchecks', bandList('soundchecks', '+ Add a band\u2019s soundcheck')),
          field('VIP', textIn('vip', '6:00 PM meet & greet')),
          field('Set times', bandList('setTimes', '+ Add a band\u2019s set time')),
          h('div', { class: 'field-row' },
            field('Lobby call', textIn('lobbyCall', '11:00 AM')),
            field('Bus call', textIn('busCall', '11:45 PM'))),
          field('Wifi', textIn('wifi', 'Network / password')),
          field('Parking', textIn('parking', 'Load in off 4th St alley, bus on the north lot')),
          h('div', { class: 'ds-yns' }, G.DS_AMENITIES.map(function (a) { return yesNo(a[0], a[1]); })),
          field('Drive time to next venue', textIn('driveNext', '4h 20m \u2014 285 mi')),
          field('Anything else', textIn('notes', 'Optional')),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Post day sheet'),
            h('button', { class: 'btn ghost block', type: 'button',
              onclick: function () { closeSheet(); } }, 'Cancel')))
      ];
    }, { label: 'Day sheet' });
  }

  /* ============================== Income ============================== */

  function openIncome(id, showId) {
    var t = getTour(id);
    var s = t && G.isObj(t.shows) && G.isObj(t.shows[showId]) ? t.shows[showId] : null;
    if (!s) return;
    var draft = {};
    G.INCOME_FIELDS.forEach(function (f) {
      draft[f.key] = G.num(G.isObj(s.income) ? s.income[f.key] : 0);
    });
    var miscLabel = String((G.isObj(s.income) && s.income.miscLabel) || '');
    var settNotes = Array.isArray(s.settlementNotes)
      ? JSON.parse(JSON.stringify(s.settlementNotes)) : [];
    var title = s.city || 'Show';
    var sub = [dayLong(s.date), s.venue].filter(Boolean).join(' · ');

    if (!canWrite()) {
      openSheet(function () {
        return [
          h('h2', { class: 'sh-title' }, title),
          h('p', { class: 'sh-sub' }, sub),
          h('div', { class: 'ledger' },
            G.INCOME_FIELDS.map(function (f) {
              return h('div', { class: 'row' },
                h('div', { class: 'row-label' }, f.label,
                  f.key === 'misc' && miscLabel ? h('span', { class: 'hint' }, miscLabel) : null),
                h('span', { class: 'amt num' }, money(draft[f.key])));
            }),
            h('div', { class: 'row total' },
              h('span', null, 'This show'),
              h('strong', { class: 'amt num' }, money(G.showIncomeTotal({ income: draft }))))),
          settNotes.length ? [
            h('h3', { class: 'sh-h3' }, 'From the settlement'),
            h('div', { class: 'ledger' }, settNotes.map(function (n) {
              return h('div', { class: 'row sn-row' },
                h('span', { class: 'row-label' }, n.label),
                h('span', { class: 'sn-val' }, n.value));
            }))
          ] : null
        ];
      }, { label: 'Income for ' + title });
      return;
    }

    openSheet(function () {
      var showEl = h('strong', { class: 'num' }, '');
      var afterEl = h('strong', { class: 'num' }, '');
      function refresh() {
        var cur = getTour(id) || t;
        showEl.textContent = money(G.showIncomeTotal({ income: draft }));
        var c2 = G.calc(cur, { override: { showId: showId, income: draft } });
        afterEl.textContent = money(c2.net, true);
        afterEl.className = 'num ' + (G.round(c2.net) < 0 ? 'neg' : 'pos');
      }
      var save = async function (e) {
        e.preventDefault();
        blurActive();
        var total = G.showIncomeTotal({ income: draft });
        var before = G.calc(getTour(id) || t).net;
        var income = Object.assign({}, draft);
        income.miscLabel = draft.misc > 0 ? miscLabel.trim() : '';
        var patch = {};
        patch[showId] = { income: income, loggedAt: total > 0 ? Date.now() : null,
          settlementNotes: settNotes.length ? settNotes : null };
        if (!(await api.update(id, { shows: patch }))) return;
        closeSheet();
        var after = G.calc(getTour(id) || t, { override: { showId: showId, income: draft } }).net;
        var r = G.round(after);
        if (G.round(before) < 0 && r >= 0) sendNotify(id, 'green', { net: money(r, true) });
        if (draft.merch > 0) sendNotify(id, 'merch', {
          amount: money(draft.merch), amountRaw: draft.merch, city: s.city || '' });
        if (G.round(before) < 0 && r >= 0) toast('Income saved. You’re in the green.');
        else if (r < 0) toast('Income saved. ' + money(-r) + ' to break even.');
        else toast('Income saved. ' + money(r) + ' in the green.');
        render(true);
      };
      var fields = G.INCOME_FIELDS;
      var notesHost = h('div', null);
      function renderNotes() {
        if (!settNotes.length) { notesHost.replaceChildren(); return; }
        notesHost.replaceChildren(
          h('h3', { class: 'sh-h3' }, 'From the settlement'),
          h('div', { class: 'ledger' }, settNotes.map(function (n) {
            return h('div', { class: 'row sn-row' },
              h('span', { class: 'row-label' }, n.label),
              h('span', { class: 'sn-val' }, n.value));
          })));
      }
      var perHeadEl = h('span', { class: 'hint ph-hint' }, '');
      function updatePerHead() {
        var hit = (settNotes || []).filter(function (x) { return /per head/i.test(x.label); })[0];
        perHeadEl.textContent = hit ? hit.value + ' per head' : 'atVenu net $ per head';
        perHeadEl.classList.toggle('known', !!hit);
      }
      updatePerHead();
      var readerResult = function (r) { /* assigned below */ };
      var reader = settlementReader({
        show: s, btnCls: 'btn primary block', autoSave: true, ariTour: id,
        onResult: async function (r) {
          readerResult(r);
          // Everything the sheet paid us logs itself; nothing found means
          // nothing saved, and the sheet stays open to type by hand.
          if (r.found) await save({ preventDefault: function () {} });
        }
      });
      readerResult = (function () { return function (r) {
          Object.keys(r.income).forEach(function (k) {
            draft[k] = r.income[k];
            var el = document.getElementById('inc-' + k);
            if (el) el.value = r.income[k] ? (Math.round(r.income[k] * 100) / 100)
              .toLocaleString('en-US', { maximumFractionDigits: 2 }) : '';
          });
          if (r.miscLabel) {
            miscLabel = r.miscLabel;
            var ml = document.getElementById('inc-misc-label');
            if (ml) ml.value = r.miscLabel;
          }
          if (r.notes.length) settNotes = r.notes;
          syncMisc(); renderNotes(); refresh(); updatePerHead();
        }; })();
      // The atVenu summary touches merch and its notes only — the guarantee,
      // back end and the promoter's numbers stay exactly as they were.
      var atvenuResult = function (r) {
        if (r.income.merch != null) {
          draft.merch = r.income.merch;
          var el = document.getElementById('inc-merch');
          if (el) el.value = (Math.round(r.income.merch * 100) / 100)
            .toLocaleString('en-US', { maximumFractionDigits: 2 });
        }
        if (r.notes.length) {
          var seen = {};
          r.notes.forEach(function (n) { seen[n.label.toLowerCase()] = true; });
          settNotes = (settNotes || []).filter(function (n) {
            return !seen[n.label.toLowerCase()];
          }).concat(r.notes);
        }
        renderNotes(); refresh(); updatePerHead();
      };
      // Misc gets its own note, so "$400 misc" still means something in a month.
      var miscNote = h('input', {
        class: 'input sm', type: 'text', id: 'inc-misc-label', maxlength: 60,
        value: miscLabel, autocomplete: 'off', enterkeyhint: 'done',
        placeholder: 'What was it? e.g. tip jar, support buyout',
        'aria-label': 'What the misc income was',
        oninput: function (e) { miscLabel = e.target.value; }
      });
      var miscRow = h('div', { class: 'row stackrow' }, miscNote);
      function syncMisc() { miscRow.hidden = !(draft.misc > 0); }

      var rows = [];
      fields.forEach(function (f, i) {
        var mkInput = moneyInput({
          id: 'inc-' + f.key, value: draft[f.key], label: f.label,
          nextId: f.key === 'misc' ? 'inc-misc-label'
            : (i < fields.length - 1 ? 'inc-' + fields[i + 1].key : null),
          last: i === fields.length - 1,
          onValue: function (v) { draft[f.key] = v; syncMisc(); refresh(); }
        });
        if (f.key === 'merch') {
          rows.push(h('div', { class: 'row' },
            h('div', { class: 'row-label' },
              h('label', { for: 'inc-merch' }, f.label),
              perHeadEl),
            settlementReader({ show: s, mode: 'atvenu', onResult: atvenuResult,
              btnLabel: '', btnLogo: 'logo-atvenu.png',
              ariaLabel: 'Read the atVenu merch summary', btnCls: 'av-bubble' }),
            mkInput));
        } else {
          rows.push(h('div', { class: 'row' },
            h('label', { class: 'row-label', for: 'inc-' + f.key }, f.label),
            mkInput));
        }
        if (f.key === 'misc') rows.push(miscRow);
      });
      syncMisc();

      var form = h('form', { class: 'sh-form', onsubmit: save, novalidate: true },
        reader ? h('div', { style: 'margin-bottom:14px' }, reader,
          h('p', { class: 'note', style: 'margin-top:6px' },
            'The settlement sheet — photo or PDF. Every dollar it shows logs itself, ' +
            'and Ari breaks the sheet down in the chat. Merch has its own atVenu bubble below.')) : null,
        h('div', { class: 'ledger inv-card' }, rows),
        notesHost,
        h('div', { class: 'preview inv-card' },
          h('div', null, h('span', null, 'This show'), showEl),
          h('div', null, h('span', null, 'Tour after this show'), afterEl)),
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary block', type: 'submit' }, 'Save income'),
          h('button', {
            class: 'btn ghost block', type: 'button',
            onclick: function () { openShowSheet(id, showId); }
          }, 'Edit date, city or venue')));
      refresh(); renderNotes();
      if (!s.loggedAt) {
        var first = form.querySelector('input');
        if (first) first.setAttribute('autofocus', '');
      }
      return [h('h2', { class: 'sh-title' }, title), h('p', { class: 'sh-sub' }, sub), form];
    }, { label: 'Income for ' + title });
  }

  /* ============================== Shows ============================== */

  function suggestDate(t) {
    var shows = G.rows(t.shows).filter(function (s) { return G.parseDay(s.date); }).sort(G.byDate);
    return shows.length ? G.addDays(shows[shows.length - 1].date, 1) : G.tourToday();
  }

  function openShowSheet(id, showId) {
    var t = getTour(id);
    if (!t) return;
    var s = showId && G.isObj(t.shows) && G.isObj(t.shows[showId]) ? t.shows[showId] : null;
    var f = {
      date: s ? s.date : suggestDate(t),
      city: s ? s.city || '' : '',
      venue: s ? s.venue || '' : '',
      soldOut: !!(s && s.soldOut)
    };
    openSheet(function () {
      var venueI;
      var dateI = h('input', {
        class: 'input', type: 'date', value: f.date, 'aria-label': 'Date',
        oninput: function (e) { f.date = e.target.value; }
      });
      var cityI = h('input', {
        class: 'input', type: 'text', value: f.city, maxlength: 80, autocomplete: 'off',
        placeholder: 'Detroit, MI', autofocus: !s, enterkeyhint: 'next',
        oninput: function (e) { f.city = e.target.value; },
        onkeydown: function (e) { if (e.key === 'Enter' && venueI) { e.preventDefault(); venueI.focus(); } }
      });
      venueI = h('input', {
        class: 'input', type: 'text', value: f.venue, maxlength: 80, autocomplete: 'off',
        placeholder: 'Optional', enterkeyhint: 'done',
        oninput: function (e) { f.venue = e.target.value; }
      });
      var submit = async function (e) {
        e.preventDefault();
        var city = f.city.trim();
        if (!G.parseDay(f.date)) { toast('Pick a date for this show'); return; }
        if (!city) { toast('Add a city for this show'); cityI.focus(); return; }
        var patch = {};
        if (s) {
          patch[showId] = { date: f.date, city: city, venue: f.venue.trim(), soldOut: f.soldOut };
          if (await api.update(id, { shows: patch })) {
            closeSheet(); toast('Show saved'); render(true);
            if (f.soldOut && !s.soldOut) sendNotify(id, 'soldout', { city: city, date: f.date });
          }
          return;
        }
        patch[newId()] = {
          date: f.date, city: city, venue: f.venue.trim(),
          income: G.emptyIncome(), loggedAt: null, createdAt: Date.now()
        };
        if (!(await api.update(id, { shows: patch }))) return;
        toast('Added ' + city + ', ' + dayMD(f.date));
        // Keep the sheet open and walk the date forward a day.
        f.date = G.addDays(f.date, 1); f.city = ''; f.venue = '';
        dateI.value = f.date; cityI.value = ''; venueI.value = '';
        cityI.focus();
        render(true);
      };
      return [
        h('h2', { class: 'sh-title' }, s ? 'Edit show' : 'Add a show'),
        s ? null : h('p', { class: 'sh-sub' }, 'Add as many as you like — the date moves forward a day each time.'),
        // Got the admat on your phone? Don't type any of this.
        !s && S.sample
          ? [fileControl({
              label: 'Read them off the flyer instead', icon: 'flyer', cls: 'btn ghost block',
              accept: imageAccept(),
              onFiles: function (files) { readFlyer(tourId, files[0]); }
            }), h('div', { class: 'or-line' }, 'or type them in')]
          : null,
        h('form', { class: 'sh-form', onsubmit: submit, novalidate: true },
          field('Date', dateI), field('City', cityI), field('Venue', venueI),
          s ? h('div', { class: 'ds-yn', style: 'margin-bottom:14px' },
            h('span', { class: 'field-label', style: 'margin:0' }, 'Sold out'),
            segmented(['\u2014', 'Yes'], f.soldOut ? 1 : 0, function (i) { f.soldOut = i === 1; },
              'Sold out')) : null,
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, s ? 'Save show' : 'Add show'),
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } },
              s ? 'Cancel' : 'Done'),
            s ? h('button', {
              class: 'btn danger block', type: 'button',
              onclick: function () { confirmDeleteShow(id, showId, s); }
            }, 'Delete show') : null))
      ];
    }, { label: s ? 'Edit show' : 'Add a show' });
  }

  function confirmDeleteShow(id, showId, s) {
    var total = G.showIncomeTotal(s);
    confirmSheet({
      title: 'Delete ' + (s.city || 'this show') + '?',
      body: s.loggedAt && total > 0
        ? 'This also takes ' + money(total) + ' of logged income off the tour.'
        : 'This removes the date from the tour.',
      action: 'Delete show', danger: true,
      onConfirm: async function () {
        var patch = {}; patch[showId] = null;
        var ok = await api.update(id, { shows: patch });
        if (ok) toast('Show deleted');
        return ok;
      }
    });
  }

  /* ============================== Day by day ============================== */

  function tabDays(id, t, c) {
    var items = G.rows(t.extras).map(function (x) {
      return { id: x.id, date: x.date, label: x.label, amount: x.amount, createdAt: x.createdAt, card: false };
    });
    G.rows(t.charges).forEach(function (ch) {
      if (ch.category !== G.DAY_BY_DAY) return;
      items.push({
        id: ch.id, date: ch.date, label: ch.merchant || 'Card charge',
        amount: ch.amount, createdAt: ch.createdAt, card: true
      });
    });
    items.sort(function (a, b) {
      return String(b.date || '').localeCompare(String(a.date || '')) || (b.createdAt || 0) - (a.createdAt || 0);
    });
    var groups = new Map();
    items.forEach(function (x) {
      var k = x.date || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(x);
    });
    return [
      canEditTour(id) ? addDailyForm(id) : null,
      items.length
        ? h('div', { class: 'section-total' },
            h('span', null, 'Day-to-day costs so far'),
            h('strong', { class: 'amt num' }, money(c.dayByDay)))
        : null,
      items.length
        ? Array.from(groups).map(function (g) { return dayGroup(id, g[0], g[1]); })
        : emptyState('Nothing logged yet', canWrite()
            ? 'Costs that show up out of nowhere go here: a flat tire, a parking ticket, a late-night food run.'
            : 'No day-to-day costs so far.')
    ];
  }

  function addDailyForm(id) {
    var key = 'day:' + id;
    var f = S.drafts[key] || (S.drafts[key] = { amount: 0, label: '', date: G.tourToday() });
    var chips;
    var labelInput = h('input', {
      class: 'input', type: 'text', id: 'day-label', 'data-k': 'day-label', value: f.label,
      maxlength: 60, autocomplete: 'off', placeholder: 'What was it for?',
      'aria-label': 'What it was for', enterkeyhint: 'done',
      oninput: function (e) { f.label = e.target.value; if (chips) chips.sync(f.label); }
    });
    chips = chipRow(G.DAILY_CHIPS, f.label, function (v) { f.label = v; labelInput.value = v; });
    var dateInput = h('input', {
      class: 'input', type: 'date', id: 'day-date', 'data-k': 'day-date', value: f.date,
      'aria-label': 'Date', oninput: function (e) { f.date = e.target.value; }
    });
    var submit = async function (e) {
      e.preventDefault();
      if (!(f.amount > 0)) { toast('Enter an amount first'); return; }
      var label = f.label.trim() || 'Cost';
      var date = G.parseDay(f.date) ? f.date : G.tourToday();
      var amt = f.amount;
      blurActive();
      var patch = {};
      patch[newId()] = { date: date, label: label, amount: amt, createdAt: Date.now() };
      if (await api.update(id, { extras: patch })) {
        S.drafts[key] = { amount: 0, label: '', date: date };
        toast('Added ' + label + ', ' + money(amt));
        render(true);
      }
    };
    return h('form', { class: 'card addform', onsubmit: submit, novalidate: true },
      h('div', { class: 'af-row' },
        moneyInput({ id: 'day-amount', value: f.amount, label: 'Amount', big: true, nextId: 'day-label',
          onValue: function (v) { f.amount = v; } }),
        dateInput),
      labelInput,
      chips,
      h('button', { class: 'btn quiet block', type: 'submit' }, 'Add cost'));
  }

  function dayGroup(id, date, xs) {
    var total = xs.reduce(function (s, x) { return s + G.num(x.amount); }, 0);
    return h('section', { class: 'daygroup' },
      h('div', { class: 'dg-head' },
        h('span', null, date ? dayLong(date) : 'No date'),
        h('span', { class: 'amt num' }, money(total))),
      h('ul', { class: 'dg-list' }, xs.map(function (x) {
        return h('li', { class: 'dg-item' },
          h('span', { class: 'dg-label' }, x.label || 'Cost'),
          x.card ? h('span', { class: 'mini-tag' }, 'Card') : null,
          h('span', { class: 'amt num' }, money(G.num(x.amount))),
          canWrite() && !x.card ? h('button', {
            class: 'iconbtn sm', type: 'button', 'aria-label': 'Remove ' + (x.label || 'cost'),
            onclick: function () {
              confirmSheet({
                title: 'Remove ' + (x.label || 'this cost') + '?',
                body: money(G.num(x.amount)) + ' comes off your day-to-day costs.',
                action: 'Remove', danger: true,
                onConfirm: async function () {
                  var patch = {}; patch[x.id] = null;
                  var ok = await api.update(id, { extras: patch });
                  if (ok) toast('Removed');
                  return ok;
                }
              });
            }
          }, icon('trash', 18)) : null);
      })));
  }

  /* ============================== Share + menu ============================== */

  async function copyText(text, ta) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through */ }
    try {
      ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
      if (document.execCommand('copy')) return true;
    } catch (e) { /* fall through */ }
    try { ta.focus(); ta.select(); } catch (e) { /* ignore */ }
    return false;
  }

  // The iPhone share sheet lands straight in the band's group chat, which is
  // where these updates actually live.
  async function sendUpdate(text, ta) {
    if (navigator.share) {
      try { await navigator.share({ text: text }); return 'sent'; }
      catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
    }
    return (await copyText(text, ta)) ? 'copied' : 'manual';
  }

  var ROLE_WORDS = {
    owner: 'You started this tour, so you’re the tour manager.',
    editor: 'You can log shows, costs and statements on this tour.',
    viewer: 'You can see everything on this tour, but not change it.'
  };

  function openShare(id) {
    var t = getTour(id);
    if (!t) return;
    var text = G.dailyUpdate(t, Date.now());
    var time = String(t.updateAt || '');

    openSheet(function () {
      var ta = h('textarea', {
        class: 'update', readonly: true, 'aria-label': 'Today’s update',
        rows: String(Math.min(10, text.split('\n').length + 1)), value: text
      });

      var timeInput = h('input', {
        class: 'input', type: 'time', value: time, 'aria-label': 'Daily update time',
        onchange: async function (e) {
          var v = e.target.value || '';
          if (await api.update(id, { updateAt: v })) {
            toast(v ? 'Reminder set for ' + prettyTime(v) : 'Reminder turned off');
            render(true);
          }
        }
      });

      var roleBlock = [];
      if (window.GR_BACKEND && S.mode === 'db') {
        roleBlock = [peopleSection(id)];
      } else if (S.mode === 'db') {
        roleBlock = [
          h('p', { class: 'sh-p' }, ROLE_WORDS[S.role] || ROLE_WORDS.editor),
          h('p', { class: 'sh-p' }, 'Use Share at the top of this window to invite your band, crew or managers by email. Everyone you invite watches these numbers move live.'),
          h('div', { class: 'ledger' },
            h('div', { class: 'row' },
              h('div', { class: 'row-label' }, 'Invite as “can view”',
                h('span', { class: 'hint' }, 'They watch the number. They can’t change anything.'))),
            h('div', { class: 'row' },
              h('div', { class: 'row-label' }, 'Invite as “can edit”',
                h('span', { class: 'hint' }, 'They can log shows, costs and statements alongside you.'))))
        ];
      } else {
        roleBlock = [h('p', { class: 'sh-p' }, 'This copy saves to this device only. Open Greenroom in Claude to invite people.')];
      }

      return [
        h('h2', { class: 'sh-title' }, 'Share this tour'),
        roleBlock,

        h('h3', { class: 'sh-h3' }, 'Today’s update'),
        h('p', { class: 'sh-sub' }, 'Tonight’s show, today’s costs, and where the tour stands.'),
        ta,
        h('div', { class: 'stack' },
          h('button', {
            class: 'btn primary block', type: 'button',
            onclick: async function () {
              var r = await sendUpdate(text, ta);
              if (r === 'sent') toast('Update sent');
              else if (r === 'copied') toast('Copied — paste it in the group chat');
              else if (r === 'manual') toast('Press and hold the text to copy it');
            }
          }, icon('share', 18), 'Send today’s update'),
          h('button', {
            class: 'btn ghost block', type: 'button',
            onclick: async function () {
              var ok = await copyText(text, ta);
              toast(ok ? 'Copied' : 'Press and hold the text to copy it');
            }
          }, icon('copy', 18), 'Copy instead')),

        canWrite() ? [
          h('h3', { class: 'sh-h3' }, 'Daily reminder'),
          h('p', { class: 'sh-sub' }, 'Greenroom nudges you at this time each day to send the update. Leave it blank to turn it off.'),
          timeInput
        ] : null
      ];
    }, { label: 'Share this tour' });
  }

  /* Real invites (the GitHub Pages build): the tour manager runs the guest
     list; everyone else just sees who's on it. */
  function peopleSection(tourId) {
    var B = window.GR_BACKEND;
    var owns = B.ownsTour(tourId);
    var list = h('div', { class: 'ledger' },
      h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Loading…')));

    function renderMembers(rows) {
      var kids = [h('div', { class: 'row people-row' },
        h('span', { class: 'who' }, B.email() || 'You'),
        h('span', { class: 'role-tag' }, owns ? 'Tour manager' : 'You'))];
      rows.forEach(function (m) {
        var shown = String(m.display_name || '').trim();
        kids.push(h('div', { class: 'row people-row' },
          h('span', { class: 'who' }, shown || m.invited_email,
            shown ? h('span', { class: 'hint', style: 'display:block' }, m.invited_email) : null),
          h('span', { class: 'role-tag' + (m.role === 'editor' ? ' aa' : '') },
            m.role === 'editor' ? 'ALL ACCESS' : 'GA'),
          owns ? h('button', {
            class: 'iconbtn sm', type: 'button', 'aria-label': 'Remove ' + m.invited_email,
            onclick: async function () {
              try { await B.uninvite(tourId, m.invited_email); toast('Removed'); refresh(); }
              catch (e) { toast('Couldn’t remove them. Try again.'); }
            }
          }, icon('trash', 18)) : null));
      });
      list.replaceChildren.apply(list, kids);
    }
    function refresh() {
      B.members(tourId).then(renderMembers).catch(function () {
        list.replaceChildren(h('div', { class: 'row' },
          h('span', { class: 'hint' }, 'Couldn’t load the guest list.')));
      });
    }
    refresh();

    var form = null;
    if (owns) {
      var role = 'viewer';
      var nameI = h('input', {
        class: 'input', type: 'text', placeholder: 'Their name', maxlength: 24,
        autocomplete: 'off', 'aria-label': 'Name'
      });
      var emailI = h('input', {
        class: 'input', type: 'email', placeholder: 'their@email.com',
        autocomplete: 'off', inputmode: 'email', 'aria-label': 'Email to invite'
      });
      var phoneI = h('input', {
        class: 'input', type: 'tel', placeholder: 'Their phone (optional)', maxlength: 30,
        autocomplete: 'off', inputmode: 'tel', 'aria-label': 'Phone'
      });
      form = h('form', {
        class: 'card addform', novalidate: true, style: 'margin-top:14px',
        onsubmit: async function (e) {
          e.preventDefault();
          var name = String(nameI.value || '').trim();
          var email = String(emailI.value || '').trim();
          if (!name) { toast('Type their name first'); nameI.focus(); return; }
          if (email.indexOf('@') < 1) { toast('Type their email address'); emailI.focus(); return; }
          try {
            var status = await B.invite(tourId, email, role, name, String(phoneI.value || '').trim());
            nameI.value = ''; emailI.value = ''; phoneI.value = '';
            if (status === 'sent') toast(name + ' is invited — the email is on its way');
            else if (status === 'existing') toast(name + ' already has an account — the tour is in it now');
            else toast(name + ' is on the list — the email service is busy, but signing up with ' + email + ' works');
            refresh();
          } catch (e2) { toast('Couldn’t send that invite. Try again.'); }
        }
      },
        nameI,
        emailI,
        phoneI,
        h('div', { style: 'display:flex;gap:10px;align-items:center;margin-top:10px' },
          segmented(['GA', 'ALL ACCESS'], 0, function (i) { role = i ? 'editor' : 'viewer'; },
            'Invite role'),
          h('button', { class: 'btn primary', type: 'submit', style: 'flex:1' }, 'Invite')));
    }

    return h('div', null,
      h('p', { class: 'sh-p' }, owns
        ? 'Invite your band, crew or managers by email. GA watches the numbers move live. ALL ACCESS can log shows, costs and statements with you.'
        : 'You’re on this tour’s guest list. The numbers update live as they’re logged.'),
      list, form);
  }

  function prettyTime(v) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ''));
    if (!m) return String(v || '');
    var hr = +m[1];
    var ampm = hr >= 12 ? 'pm' : 'am';
    var h12 = hr % 12 === 0 ? 12 : hr % 12;
    return h12 + (m[2] === '00' ? '' : ':' + m[2]) + ampm;
  }

  // Past the reminder time and today's update hasn't gone out yet.
  function updateDue(t) {
    if (!t || !t.updateAt) return false;
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(t.updateAt));
    if (!m) return false;
    var now = new Date();
    var mins = now.getHours() * 60 + now.getMinutes();
    if (mins < (+m[1]) * 60 + (+m[2])) return false;
    return String(t.updateSentOn || '') !== G.ymd(now);
  }

  function openTrash() {
    function build() {
      var list = trashedEntries();
      openSheet(function () {
        return [
          h('h2', { class: 'sh-title' }, 'Recently deleted'),
          h('p', { class: 'hint', style: 'margin:-4px 0 10px;opacity:.7' }, 'Version ' + (window.GREENROOM_BUILD || 'dev')),
          h('p', { class: 'sh-sub' }, 'Deleted tours wait here for ' + TRASH_DAYS +
            ' days, then clear out on their own.'),
          list.length ? h('div', { class: 'ledger' }, list.map(function (e) {
            var id = e[0], t = e[1];
            var days = Math.max(0, TRASH_DAYS - Math.floor((Date.now() - t.deletedAt) / 86400e3));
            return h('div', { class: 'row' },
              h('div', { class: 'row-label' },
                (t.artist ? t.artist + ' — ' : '') + (t.name || 'Untitled tour'),
                h('span', { class: 'hint' }, days ? 'Clears in ' + plural(days, 'day') : 'Clearing soon')),
              h('button', { class: 'btn sm quiet', type: 'button',
                onclick: async function () {
                  if (await restoreTour(id)) { toast('Restored'); build(); render(); }
                } }, 'Restore'),
              h('button', { class: 'iconbtn sm', type: 'button',
                'aria-label': 'Delete forever',
                onclick: function () {
                  confirmSheet({
                    title: 'Delete ' + (t.name || 'this tour') + ' forever?',
                    body: 'No coming back from this one.',
                    action: 'Delete forever', danger: true,
                    onConfirm: async function () {
                      var ok = await api.remove(id);
                      if (ok) { toast('Gone for good'); setTimeout(build, 200); }
                      return ok;
                    }
                  });
                } }, icon('trash', 18)));
          })) : emptyState('Nothing here', 'Deleted tours land here before they’re gone for good.')
        ];
      }, { label: 'Recently deleted' });
    }
    build();
  }

  function openRename(id) {
    var t = getTour(id);
    if (!t) return;
    var name = t.name || '';
    var artist = String(t.artist || '');
    openSheet(function () {
      var input = h('input', {
        class: 'input', type: 'text', value: name, maxlength: 80, autocomplete: 'off',
        autofocus: true, oninput: function (e) { name = e.target.value; }
      });
      var artistI = h('input', {
        class: 'input', type: 'text', value: artist, maxlength: 60, autocomplete: 'off',
        list: 'gr-artists', placeholder: 'Optional',
        oninput: function (e) { artist = e.target.value; }
      });
      var submit = async function (e) {
        e.preventDefault();
        var n = name.trim();
        if (!n) { toast('Enter a name for the tour'); return; }
        if (await api.update(id, { name: n, artist: artist.trim() })) {
          closeSheet(); toast('Saved'); render(true);
        }
      };
      return [
        h('h2', { class: 'sh-title' }, 'Name and artist'),
        h('form', { class: 'sh-form', onsubmit: submit, novalidate: true },
          field('Tour name', input),
          field('Artist', artistI, 'Tours group under their artist on the first screen.'),
          artistDatalist(),
          h('div', { class: 'stack' }, h('button', { class: 'btn primary block', type: 'submit' }, 'Save')))
      ];
    }, { label: 'Name and artist' });
  }

  /* One home for "bring in what I already have". Both readers live here with
     their names on them, plus the honest word on what sync does and doesn't
     mean today. */
  function openImportHub(tourId) {
    openSheet(function () {
      var mt = tourImportControl(tourId);
      var av = settlementSourceControl(tourId);
      return [
        h('h2', { class: 'sh-title' }, 'Bring in your info'),
        h('p', { class: 'sh-sub' }, 'Already keeping this somewhere else? Export it from there and Greenroom reads it.'),

        h('h3', { class: 'sh-h3' }, h('img', { class: 'brand-logo', src: 'logo-mastertour.png', alt: '' }), 'Master Tour'),
        h('p', { class: 'note', style: 'margin:2px 2px 10px' },
          'In Master Tour: print your day sheets or itinerary to PDF (or export CSV), then upload it here. ' +
          'Load-ins, soundchecks, doors, set times, bus calls and drives fill in across the whole run. ' +
          'Anything you already typed by hand is kept.'),
        mt,

        h('h3', { class: 'sh-h3' }, h('img', { class: 'brand-logo', src: 'logo-atvenu.png', alt: '' }), 'atVenu'),
        h('p', { class: 'note', style: 'margin:2px 2px 10px' },
          'After the show, export the merch settlement from atVenu (or screenshot the register report) ' +
          'and upload it on the show you’re logging. Net merch lands in income; gross, the venue’s cut ' +
          'and the per head come through as notes.'),
        av,

        h('h3', { class: 'sh-h3' }, 'About live sync'),
        h('p', { class: 'note', style: 'margin:2px 2px 10px' },
          'Neither company offers an open connection yet — theirs are partner-only. ' +
          'So this is upload-and-read rather than a live link. It takes one file and a few seconds, ' +
          'and nothing has to be typed twice.')
      ];
    }, { label: 'Bring in your info' });
  }

  /* The settlement reader, reachable from the hub: pick a show, then read. */
  function settlementSourceControl(tourId) {
    var t = getTour(tourId);
    var shows = G.rows(t && t.shows).filter(function (x) { return G.parseDay(x.date); }).sort(G.byDate);
    if (!shows.length) return h('p', { class: 'note' }, 'Add a show first, then its merch can come in here.');
    return h('button', { class: 'btn ghost block', type: 'button',
      onclick: function () {
        var today = G.tourToday();
        var pick = shows.filter(function (x) { return x.date === today; })[0] ||
          shows.filter(function (x) { return x.loggedAt; }).pop() || shows[0];
        openIncome(tourId, pick.id);
      } }, h('img', { class: 'brand-logo', src: 'logo-atvenu.png', alt: '' }), 'Open a show to add merch');
  }

  function sendNotify(tourId, type, data) {
    if (window.GR_BACKEND && S.mode === 'db' && window.GR_BACKEND.notify) {
      window.GR_BACKEND.notify(tourId, type, data);
    }
  }

  /* Per-device notification choices: what this phone wants to hear about. */
  function openNotifications(tourId) {
    var B = window.GR_BACKEND;
    if (!B || S.mode !== 'db') {
      readFail('Notifications need an account',
        'Sign in and install Greenroom to your home screen, then each person picks what they want to hear about.',
        null, null);
      return;
    }
    if (!B.pushSupported()) {
      readFail('This browser can\u2019t do notifications',
        'On iPhone, add Greenroom to your home screen and open it from there \u2014 notifications work in the installed app.',
        null, null);
      return;
    }
    B.pushState().then(function (state) {
      var on = state.on;
      var prefs = {
        guest: !!state.prefs.guest,
        green: !!state.prefs.green,
        soldout: !!state.prefs.soldout,
        merch: G.num(state.prefs.merch) || 0
      };
      openSheet(function () {
        function toggleRow(key, label, hint) {
          return h('div', { class: 'ds-yn', style: 'min-height:48px' },
            h('div', { class: 'row-label', style: 'flex:1' }, label,
              hint ? h('span', { class: 'hint' }, hint) : null),
            segmented(['Off', 'On'], prefs[key] ? 1 : 0, function (i) { prefs[key] = i === 1; }, label));
        }
        var merchIn = moneyInput({ id: 'notif-merch', value: prefs.merch, slim: true,
          label: 'Merch milestone', placeholder: '\u2014',
          onValue: function (v) { prefs.merch = v; } });
        var saveBtn = h('button', { class: 'btn primary block', type: 'button',
          onclick: async function () {
            saveBtn.disabled = true;
            var out = { guest: prefs.guest, green: prefs.green, soldout: prefs.soldout,
              merch: prefs.merch > 0 ? prefs.merch : false };
            try {
              var any = prefs.guest || prefs.green || prefs.soldout || prefs.merch > 0;
              if (any) { await B.pushEnable(out); toast('You\u2019ll hear about it'); }
              else { await B.pushDisable(); toast('Notifications off'); }
              closeSheet();
            } catch (e) {
              saveBtn.disabled = false;
              toast(e && e.code === 'denied'
                ? 'Your phone said no \u2014 allow notifications for Greenroom in Settings'
                : 'Couldn\u2019t turn that on. Try again.');
            }
          } }, 'Save');
        return [
          h('h2', { class: 'sh-title' }, 'Notifications'),
          h('p', { class: 'sh-sub' }, 'Your choices, this phone only \u2014 everyone on the tour picks their own.'),
          h('div', { class: 'ds-yns' },
            toggleRow('guest', 'Guest list', 'Someone adds a name'),
            toggleRow('green', 'In the green', 'The tour crosses break even'),
            toggleRow('soldout', 'Sold out', 'A show gets marked sold out')),
          h('div', { class: 'ds-yn', style: 'min-height:48px;margin-top:8px' },
            h('div', { class: 'row-label', style: 'flex:1' }, 'Merch milestone',
              h('span', { class: 'hint' }, 'A show\u2019s merch hits this number \u2014 blank for off')),
            merchIn),
          h('div', { class: 'stack' }, saveBtn,
            on ? h('button', { class: 'btn ghost block', type: 'button',
              onclick: async function () { await B.pushDisable(); toast('Notifications off'); closeSheet(); }
            }, 'Turn all of it off') : null)
        ];
      }, { label: 'Notifications' });
    });
  }

  /* ---------------- Tour closeout ----------------
     The professional package: a printable report for humans, CSVs for the
     bookkeeper. Presentation only — every number comes from calc(). */

  function openCloseout(id) {
    var t = getTour(id);
    if (!t) return;
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'Tour closeout'),
        h('p', { class: 'sh-sub' }, 'The package your business manager actually wants: a clean report to read, and spreadsheets their bookkeeper can import untouched.'),
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary block', type: 'button',
            onclick: function () { closeSheet(); openReport(id); } },
            'Open the report'),
          h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () { shareCloseoutCSVs(id); } },
            icon('share', 18), 'Share the spreadsheets'),
          h('p', { class: 'note' },
            'The report prints to PDF from the share button on the next screen. The spreadsheets are five CSV files — shows, budget vs actual, card charges, day by day, commissions.'))
      ];
    }, { label: 'Tour closeout' });
  }

  async function shareCloseoutCSVs(id) {
    var t = getTour(id);
    var files = G.closeoutCSVs(t);
    var stamp = (t.name || 'tour').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    var list = Object.keys(files).map(function (name) {
      return new File([files[name]], stamp + '-' + name, { type: 'text/csv' });
    });
    if (navigator.canShare && navigator.canShare({ files: list })) {
      try { await navigator.share({ files: list, title: (t.name || 'Tour') + ' closeout' }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    // No share sheet here: hand the files over one by one.
    list.forEach(function (f) {
      var a = h('a', { href: URL.createObjectURL(f), download: f.name });
      document.body.appendChild(a); a.click(); a.remove();
    });
    toast('Spreadsheets saved');
  }

  function repRow(cells, cls) {
    return h('tr', { class: cls || null }, cells.map(function (cell, i) {
      return h('td', { class: i === 0 ? 'rp-l' : 'rp-n' }, cell);
    }));
  }

  function openReport(id) {
    var t = getTour(id);
    var c = G.calc(t);
    var shows = c.allShows;
    var first = shows.length ? shows[0].date : null;
    var last = shows.length ? shows[shows.length - 1].date : null;
    var comm = G.normCommission(t.commission);
    var today = new Intl.DateTimeFormat('en-US', { dateStyle: 'long' }).format(new Date());

    var budget = h('table', { class: 'rp-table' },
      h('thead', null, repRow(['Category', 'Projected', 'Actual paid', 'Variance', 'Counted'])),
      h('tbody', null,
        c.lines.map(function (l) {
          var v = l.projected == null ? '' : l.paid - l.projected;
          return repRow([l.label,
            l.projected == null ? '\u2014' : money(l.projected),
            money(l.paid),
            v === '' ? '\u2014' : (v > 0 ? money(v) + ' over' : v < 0 ? money(-v) + ' under' : 'on budget'),
            money(l.effective)]);
        }),
        G.otherDebts(t).map(function (d) {
          return repRow(['Owed: ' + (d.label || 'Debt'), '\u2014', money(G.num(d.amount)), '\u2014', money(G.num(d.amount))]);
        }),
        repRow(['Day by day', '\u2014', money(c.dayByDay), '\u2014', money(c.dayByDay)]),
        repRow(['Total out', '', '', '', money(c.out)], 'rp-total'),
        repRow(['Total income', '', '', '', money(c.income)], 'rp-total'),
        repRow(['Net', '', '', '', money(c.net, true)], 'rp-total rp-net')));

    var gig = h('table', { class: 'rp-table rp-wide' },
      h('thead', null, repRow(['Date', 'City \u00b7 venue'].concat(
        G.INCOME_FIELDS.map(function (f) { return f.label; }), ['Total']))),
      h('tbody', null, shows.map(function (sh) {
        var inc = G.isObj(sh.income) ? sh.income : {};
        return repRow([dayMD(sh.date),
          (sh.city || '') + (sh.venue ? ' \u00b7 ' + sh.venue : '') + (sh.soldOut ? ' (sold out)' : '')].concat(
          G.INCOME_FIELDS.map(function (f) { return G.num(inc[f.key]) ? money(G.num(inc[f.key])) : '\u2014'; }),
          [money(G.showIncomeTotal(sh))]));
      }),
      repRow(['', 'Total'].concat(G.INCOME_FIELDS.map(function (f) {
        var sum = shows.reduce(function (a, sh) {
          return a + G.num((sh.income || {})[f.key]); }, 0);
        return sum ? money(sum) : '\u2014';
      }), [money(c.income)]), 'rp-total')));

    var notes = shows.filter(function (sh) {
      return Array.isArray(sh.settlementNotes) && sh.settlementNotes.length;
    }).map(function (sh) {
      return h('p', { class: 'rp-note' }, h('b', null, (sh.city || '') + ' \u00b7 ' + dayMD(sh.date) + ': '),
        sh.settlementNotes.map(function (n) { return n.label + ' \u2014 ' + n.value; }).join('; '));
    });

    var commTable = h('table', { class: 'rp-table' },
      h('thead', null, repRow(['Line', 'Deal', 'Base', 'Amount'])),
      h('tbody', null, G.COMMISSION_LINES.map(function (line) {
        var r = comm[line.key];
        return repRow([line.label,
          r.mode === 'pct' ? r.value + '%' : 'Flat',
          r.mode === 'pct' ? (line.basis === 'guarantee' ? 'Guarantees, ' + money(c.guarantees)
            : 'All income, ' + money(c.income)) : '\u2014',
          money(G.commissionLine(line, r, c.income, c.guarantees))]);
      }),
      repRow(['Total commission', '', '', money(c.commission)], 'rp-total')));

    var cards = G.cardDebts(t).map(function (card) {
      var sm = G.cardSummary(card);
      var bd = G.isObj(card.breakdown) ? card.breakdown : {};
      var bits = G.TYPED_CATEGORIES.filter(function (x) { return G.num(bd[x.key]) > 0; })
        .map(function (x) { return x.label + ' ' + money(G.num(bd[x.key])); });
      if (sm.remainder > 0) bits.push('Misc ' + money(sm.remainder));
      return h('p', { class: 'rp-note' }, h('b', null, sm.label + ' \u2014 ' + money(sm.balance) + ' carried in. '),
        bits.length ? 'Broken down: ' + bits.join(', ') + '.' : 'Not broken down.');
    });

    var wrap = h('div', { id: 'gr-report' },
      h('div', { class: 'rp-bar' },
        h('button', { class: 'btn quiet sm', type: 'button',
          onclick: function () { wrap.remove(); document.body.classList.remove('reporting'); } }, 'Close'),
        h('button', { class: 'btn primary sm', type: 'button',
          onclick: function () { window.print(); } }, 'Print / save as PDF')),
      h('header', { class: 'rp-head' },
        h('div', { class: 'rp-kicker' }, 'Final tour report'),
        h('h1', null, t.name || 'Tour'),
        h('p', { class: 'rp-sub' },
          [t.artist, first && last ? dayLong(first) + ' \u2013 ' + dayLong(last) : null,
           plural(shows.length, 'show')].filter(Boolean).join(' \u00b7 '))),
      h('section', null,
        h('h2', null, 'Summary'),
        h('div', { class: 'rp-cards' },
          h('div', { class: 'rp-card' }, h('span', null, 'Total income'), h('strong', null, money(c.income))),
          h('div', { class: 'rp-card' }, h('span', null, 'Total out'), h('strong', null, money(c.out))),
          h('div', { class: 'rp-card' }, h('span', null, 'Net'), h('strong', {
            class: G.round(c.net) < 0 ? 'rp-neg' : 'rp-pos' }, money(c.net, true))),
          h('div', { class: 'rp-card' }, h('span', null, 'Costs covered'),
            h('strong', null, Math.floor(c.coverage * 100) + '%')))),
      h('section', null, h('h2', null, 'Budget vs actual'), budget),
      h('section', null, h('h2', null, 'Income by show'), gig,
        notes.length ? [h('h3', null, 'Settlement notes'), notes] : null),
      h('section', null, h('h2', null, 'Commissions'), commTable),
      cards.length ? h('section', null, h('h2', null, 'Carried in on cards'), cards) : null,
      h('section', { class: 'rp-tax' },
        h('h2', null, 'Notes for your tax preparer'),
        h('p', null, 'Categories are the tour\u2019s own, not Schedule C lines \u2014 mapping is yours. ' +
          'Day-by-day food entries are flagged as meals in the spreadsheets (50% limit generally applies). ' +
          'Receipts are kept outside this app. Card charges carry dates and merchant names for your audit trail.')),
      h('footer', { class: 'rp-foot' },
        'Prepared with Greenroom \u00b7 ' + today));

    document.body.appendChild(wrap);
    document.body.classList.add('reporting');
    wrap.scrollTop = 0;
  }

  function openTourMenu(id) {
    var t = getTour(id);
    if (!t) return;
    var name = t.name || 'this tour';
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, t.name || 'Tour options'),
        h('div', { class: 'stack' },
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openShare(id); } },
            icon('share', 18), 'Share this tour'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openRename(id); } },
            icon('edit', 18), 'Name and artist'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openCrewSheet(id); } },
            icon('people', 18), 'Crew'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openImportHub(id); } },
            icon('card', 18), 'Bring in your info'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openNotifications(id); } },
            icon('share', 18), 'Notifications'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openCloseout(id); } },
            icon('copy', 18), 'Tour closeout'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openImportsSheet(id); } },
            icon('history', 18), 'Card statement history'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openLabelsSheet(); } },
            icon('tag', 18), 'Learned labels'),
          isOwner() || S.mode === 'local' ? h('button', {
            class: 'btn danger block', type: 'button',
            onclick: function () {
              confirmSheet({
                title: 'Delete ' + name + '?',
                body: 'It moves to Recently deleted for ' + TRASH_DAYS + ' days, then it’s gone for good' +
                  (S.mode === 'db' ? ' — for everyone it’s shared with.' : '.'),
                action: 'Delete tour', danger: true,
                onConfirm: async function () {
                  var ok = await api.update(id, { deletedAt: Date.now() });
                  if (ok) { delete S.lastNet[id]; delete S.lastState[id]; go({ name: 'home' }); toast('Moved to Recently deleted'); }
                  return ok;
                }
              });
            }
          }, icon('trash', 18), 'Delete tour') : null)
      ];
    }, { label: 'Tour options' });
  }

  /* ============================== Reading things ==============================
     Flyers and card statements both end in the same place: an editable review
     list the user confirms before anything is saved. */

  function fileControl(o) {
    var input = h('input', {
      type: 'file', class: 'file-hidden', tabindex: '-1', 'aria-hidden': 'true',
      accept: o.accept, multiple: o.multiple || null,
      onchange: function (e) {
        var files = Array.prototype.slice.call(e.target.files || []);
        e.target.value = '';
        if (files.length) o.onFiles(files);
      }
    });
    var btn = h('button', {
      class: o.cls || 'btn ghost', type: 'button',
      'aria-label': o.ariaLabel || null,
      onclick: function () { input.click(); }
    }, o.logo ? h('img', { class: 'brand-logo', src: o.logo, alt: '' })
      : (o.icon ? icon(o.icon, 18) : null), o.label || null);
    return [btn, input];
  }

  function imageAccept() {
    return (S.imageTypes.length ? S.imageTypes : ['image/jpeg', 'image/png', 'image/webp']).join(',');
  }

  /* Reading anything looks the same: the bus, and one word. */
  function busySheet(title, body, onStop) {
    openSheet(function () {
      return [
        roadie(),
        h('div', { class: 'busy-word' }, 'Extracting'),
        h('button', { class: 'btn ghost block', type: 'button', onclick: onStop }, 'Stop')
      ];
    }, { label: title });
  }

  var SAMPLE_GONE = ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled',
    'capability_removed', 'images_unavailable'];

  function sampleErrorMessage(code, kind) {
    var messages = {
      image_rejected: 'That file couldn’t be read. Try a JPG or PNG.',
      rate_limited: 'Too many requests right now. Try again in a minute.',
      session_expired: 'Sign in to Claude again, then try once more.',
      prompt_too_large: 'That file is too big to read in one go. Try splitting it up.',
      refused: 'That file couldn’t be read. Try a clearer copy.',
      invalid_json: kind === 'flyer'
        ? 'No show dates found on that image. Try a sharper photo, or add the dates by hand.'
        : 'No charges found in that statement. Try a clearer copy, or a CSV.',
      empty_completion: kind === 'flyer'
        ? 'No show dates found on that image. Try a sharper photo, or add the dates by hand.'
        : 'No charges found in that statement. Try a clearer copy, or a CSV.'
    };
    return messages[code] || 'Reading was interrupted. Try again.';
  }

  /* ---------------- Flyers ---------------- */

  function flyerPrompt() {
    var now = new Date();
    var y = now.getFullYear();
    return [
      'The attached image is a concert tour flyer (an admat or a list of tour dates).',
      'Today is ' + G.ymd(now) + '.',
      'List every show date on it.',
      '',
      'Rules:',
      '- One entry per show. Skip days off, ticket info, support acts and anything that is not a show date.',
      '- date: YYYY-MM-DD. If the year is not printed, use ' + y + ', and use ' + (y + 1) +
        ' for dates that continue into January or later after December dates.' +
        ' If every date would already be months in the past in ' + y + ', use ' + (y + 1) + ' instead.',
      '- city: "City, ST" for the US and Canada (two-letter state or province code),',
      '  "City, Country" elsewhere. If only a city is printed, give the city alone.',
      '- venue: the venue name if printed, otherwise "".',
      '- Keep the order the dates appear in.',
      '',
      'Reply with only a JSON array, for example:',
      '[{"date":"' + y + '-10-03","city":"Detroit, MI","venue":"The Fillmore"}]',
      'If there are no show dates, reply with [].'
    ].join('\n');
  }

  function normalizeFlyer(out) {
    var arr = Array.isArray(out) ? out : (G.isObj(out) && Array.isArray(out.shows) ? out.shows : []);
    var rows = [];
    arr.slice(0, 150).forEach(function (r) {
      if (!G.isObj(r)) return;
      var date = String(r.date == null ? '' : r.date).trim();
      var city = String(r.city == null ? '' : r.city).trim().slice(0, 80);
      var venue = String(r.venue == null ? '' : r.venue).trim().slice(0, 80);
      if (!G.parseDay(date) || !city) return;
      rows.push({ date: date, city: city, venue: venue, keep: true, dup: false });
    });
    return rows;
  }

  /* The flyer names the venues; Claude may know the buildings. Ask for the
     address and phone ONLY where it is sure, pencil them into blank day
     sheets, and say so — a wrong number is worse than a blank, so these are
     flagged for a double-check and never overwrite anything a human typed. */
  function venueInfoPrompt(items) {
    return [
      'These are concert venues on a tour. For each one, give the street address and the venue\u2019s main phone number',
      'ONLY if you are confident you know that exact real venue. If you are not sure, use null for that field \u2014',
      'never guess, never make up a number.',
      'Reply with only a JSON array in this exact shape:',
      '[{"venue":"The Fillmore","city":"Detroit, MI","address":"2115 Woodward Ave, Detroit, MI 48201","phone":"(313) 961-5451"}]',
      '',
      'Venues:',
      items.map(function (v) { return '- ' + v.venue + ' \u2014 ' + v.city; }).join('\n')
    ].join('\n');
  }

  async function lookupVenueInfo(tourId, showsPatch) {
    if (!S.sample) return;
    var items = [];
    Object.keys(showsPatch).forEach(function (id) {
      var sh = showsPatch[id];
      if (sh && sh.venue) items.push({ id: id, venue: sh.venue, city: sh.city || '' });
    });
    if (!items.length) return;
    try {
      var out = await S.sample.json(venueInfoPrompt(items), { cache: false });
      var byKey = {};
      (Array.isArray(out) ? out : []).forEach(function (v) {
        if (!G.isObj(v)) return;
        byKey[String(v.venue || '').toLowerCase() + '|' + String(v.city || '').toLowerCase()] = v;
      });
      var patch = {}; var n = 0;
      var t = getTour(tourId);
      items.forEach(function (it) {
        var hit = byKey[it.venue.toLowerCase() + '|' + it.city.toLowerCase()];
        if (!hit) return;
        var addr = String(hit.address == null ? '' : hit.address).trim().slice(0, 120);
        var ph = String(hit.phone == null ? '' : hit.phone).trim().slice(0, 40);
        if (!addr && !ph) return;
        var cur = t && G.isObj(t.shows) && G.isObj(t.shows[it.id]) ? t.shows[it.id] : null;
        if (!cur) return;
        var ds = Object.assign({}, G.isObj(cur.daySheet) ? cur.daySheet : {});
        if (ds.venueAddress || ds.venuePhone) return; // never overwrite a human
        if (addr) ds.venueAddress = addr;
        if (ph) ds.venuePhone = ph;
        patch[it.id] = { daySheet: ds };
        n += 1;
      });
      if (n && await api.update(tourId, { shows: patch })) {
        toast('Address and phone penciled in for ' + plural(n, 'venue') + ' \u2014 double-check them on the day sheets');
        render(true);
      }
    } catch (e) { /* a nicety, never worth an error */ }
  }

  async function readFlyer(tourId, file) {
    if (!S.sample) return;
    if (S.imageMax && file.size > S.imageMax) {
      readFail('Couldn’t read that flyer', 'That image is too large. Try a screenshot of the flyer instead.',
        function () { openShowSheet(tourId); }, 'Add dates by hand');
      return;
    }
    var ctl = new AbortController();
    var settled = false;
    busySheet('Reading the flyer', 'Finding every date and city. This can take up to a minute.',
      function () { ctl.abort(); closeSheet(); });
    try {
      var out = await S.sample.json(flyerPrompt(), { images: file, signal: ctl.signal, cache: false });
      settled = true;
      var rows = normalizeFlyer(out);
      if (!rows.length) {
        readFail('Couldn’t read that flyer',
          'No show dates found on that image. Try a sharper photo, or add the dates by hand.',
          function () { openShowSheet(tourId); }, 'Add dates by hand');
        return;
      }
      openFlyerReview(tourId, rows);
    } catch (e) {
      settled = true;
      var code = e && e.code;
      if (code === 'cancelled') return;
      if (SAMPLE_GONE.indexOf(code) >= 0) {
        S.sample = null;
        render(true);
        readFail('Reading isn’t available here', 'Add the dates by hand instead.',
          function () { openShowSheet(tourId); }, 'Add dates by hand');
        return;
      }
      readFail('Couldn’t read that flyer', sampleErrorMessage(code, 'flyer'),
        function () { openShowSheet(tourId); }, 'Add dates by hand');
    }
    if (!settled) ctl.abort();
  }

  function readFail(title, message, onFallback, fallbackLabel) {
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, title),
        h('p', { class: 'sh-sub' }, message),
        h('div', { class: 'stack' },
          onFallback ? h('button', {
            class: 'btn primary block', type: 'button',
            onclick: function () { onFallback(); }
          }, fallbackLabel || 'OK') : null,
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Close'))
      ];
    }, { label: title });
  }

  function openFlyerReview(tourId, rows) {
    var t = getTour(tourId);
    var existing = {};
    G.rows(t && t.shows).forEach(function (s) {
      existing[s.date + '|' + String(s.city || '').toLowerCase()] = true;
    });
    rows.forEach(function (r) {
      r.dup = !!existing[r.date + '|' + r.city.toLowerCase()];
      r.keep = !r.dup;
    });

    async function save() {
      var patch = {};
      var n = 0;
      rows.forEach(function (r, i) {
        var city = r.city.trim();
        if (!r.keep || !city || !G.parseDay(r.date)) return;
        patch[newId() + i] = {
          date: r.date, city: city, venue: r.venue.trim(),
          income: G.emptyIncome(), loggedAt: null, createdAt: Date.now() + i
        };
        n += 1;
      });
      if (!n) { toast('Each show needs a date and a city'); return; }
      if (await api.update(tourId, { shows: patch })) {
        closeSheet(); toast(plural(n, 'show') + ' added'); render(true);
        var t0 = getTour(tourId);
        setTimeout(function () {
          openTravelDaysSheet(tourId, function () {
            openRehearsalSheet(tourId, function () {
              var t1 = getTour(tourId);
              if (t1 && !tourBands(t1).length) openLineupPrompt(tourId);
            });
          });
        }, 400);
        lookupVenueInfo(tourId, patch); // fire and forget — a nicety
      }
    }

    openSheet(function () {
      var addBtn = h('button', { class: 'btn primary block', type: 'button', onclick: save }, '');
      function refresh() {
        var n = rows.filter(function (r) { return r.keep; }).length;
        addBtn.textContent = n ? 'Add ' + plural(n, 'show') : 'Pick the shows to add';
        addBtn.disabled = !n;
      }
      var list = h('div', { class: 'review' }, rows.map(function (r) {
        var wrap = h('div', { class: 'rv-row' + (r.keep ? '' : ' off') });
        var cb = h('input', {
          type: 'checkbox', class: 'rv-check', 'aria-label': 'Add ' + (r.city || 'this show'),
          onchange: function (e) { r.keep = e.target.checked; wrap.classList.toggle('off', !r.keep); refresh(); }
        });
        cb.checked = r.keep;
        wrap.append(cb, h('div', { class: 'rv-fields' },
          h('div', { class: 'rv-line' },
            h('input', { class: 'input sm', type: 'date', value: r.date, 'aria-label': 'Date',
              oninput: function (e) { r.date = e.target.value; } }),
            h('input', { class: 'input sm', type: 'text', value: r.city, maxlength: 80, 'aria-label': 'City',
              oninput: function (e) { r.city = e.target.value; } })),
          h('input', { class: 'input sm', type: 'text', value: r.venue, maxlength: 80,
            placeholder: 'Venue (optional)', 'aria-label': 'Venue',
            oninput: function (e) { r.venue = e.target.value; } }),
          r.dup ? h('span', { class: 'rv-flag' }, 'Already on this tour') : null));
        return wrap;
      }));
      refresh();
      return [
        h('h2', { class: 'sh-title' }, 'Found ' + plural(rows.length, 'show')),
        h('p', { class: 'sh-sub' }, 'Check each date and city, and fix anything that looks off before adding them.'),
        list,
        h('div', { class: 'stack' }, addBtn,
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel'))
      ];
    }, { label: 'Review shows from the flyer' });
  }

  /* ---------------- Master Tour import ---------------- */

  function tourImportPrompt(body, isImage) {
    return [
      isImage
        ? 'The attached image(s) are exported day sheets or an itinerary from tour management software (Master Tour or similar).'
        : 'The text below was pulled out of exported day sheets or an itinerary from tour management software (Master Tour or similar).',
      'Pull out the schedule for every date shown.',
      '',
      'Reply with only a JSON object in this exact shape:',
      '{"days":[{"date":"2026-05-01","city":"Detroit, MI","venue":"The Fillmore",',
      '  "loadIn":"2:00 PM","soundchecks":[{"band":"In This Moment","time":"4:00 PM"}],',
      '  "vip":"","doors":"7:00 PM","setTimes":[{"band":"Support","time":"8:00 PM"}],',
      '  "lobbyCall":"","busCall":"","wifi":"","parking":"",',
      '  "greenrooms":null,"showers":null,"productionOffice":null,"laundry":null,',
      '  "driveNext":"","notes":""}]}',
      '',
      'Rules:',
      '- One entry per calendar date. date is YYYY-MM-DD using the year printed.',
      '- Fill a field ONLY if the export actually shows it; otherwise leave it empty or null. Never invent.',
      '- Times exactly as printed. Per-band soundchecks and set times as separate list entries.',
      '- greenrooms/showers/productionOffice/laundry: "yes" or "no" only if the export states it.',
      '- driveNext: the drive or mileage to the next city if shown.',
      '- Skip days off unless they carry hotel or travel info worth keeping (put it in notes).',
      'If nothing readable, reply {"days":[]}.',
      isImage ? '' : '\nExport text:\n' + body
    ].join('\n');
  }

  function unavailableBtn(label, cls) {
    return h('button', { class: cls || 'btn ghost', type: 'button',
      onclick: function () {
        readFail('Reading needs an account',
          S.mode === 'db'
            ? 'Reading files runs on Greenroom\u2019s servers, so it needs you signed in. Try again in a moment, or reopen the app.'
            : 'You\u2019re using Greenroom on this phone only. Sign out and create an account to read flyers, statements and exports.',
          null, null);
      } }, icon('card', 18), label);
  }

  function tourImportControl(tourId) {
    if (!S.sample) return unavailableBtn('Import from Master Tour', 'btn ghost');
    var busy = false;
    var control = fileControl({
      label: 'Import from Master Tour', logo: 'logo-mastertour.png', cls: 'btn ghost',
      accept: 'application/pdf,.pdf,.csv,.tsv,text/csv,' + imageAccept(), multiple: true,
      onFiles: async function (files) {
        if (busy) return;
        busy = true;
        var btn = control[0];
        var was = btn.textContent;
        btn.textContent = 'Reading the export\u2026';
        btn.disabled = true;
        try {
          var pdfFile = files.filter(function (f) { return /pdf/i.test(f.type) || /\.pdf$/i.test(f.name); })[0];
          var textFile = files.filter(function (f) { return /\.csv$|\.tsv$|text\//i.test(f.name + ' ' + f.type); })[0];
          var images = files.filter(function (f) { return /^image\//i.test(f.type); });
          var out;
          if (pdfFile) {
            var got = await pdfToText(pdfFile);
            if (got.text.replace(/\s/g, '').length > 60) {
              out = await S.sample.json(tourImportPrompt(got.text.slice(0, 60000), false), { cache: false });
            } else {
              var pages = await pdfToImages(got.doc, got.pages);
              out = await S.sample.json(tourImportPrompt('', true), { images: pages, cache: false });
            }
          } else if (textFile) {
            out = await S.sample.json(tourImportPrompt((await textFile.text()).slice(0, 60000), false), { cache: false });
          } else if (images.length) {
            out = await S.sample.json(tourImportPrompt('', true), { images: images, cache: false });
          } else {
            toast('Use a PDF, a CSV, or screenshots of the export.');
            return;
          }
          var r = G.normalizeTourImport(out);
          if (!r.found) { toast('Nothing readable in that export. Try the day sheet PDF.'); return; }
          openTourImportReview(tourId, r.days);
        } catch (e) {
          var code = e && e.code;
          if (code === 'cancelled') return;
          if (SAMPLE_GONE.indexOf(code) >= 0) { S.sample = null; toast('Reading isn\u2019t available right now.'); return; }
          toast(sampleErrorMessage(code, 'statement'));
        } finally {
          busy = false;
          btn.textContent = was;
          btn.disabled = false;
        }
      }
    });
    return control;
  }

  function openTourImportReview(tourId, days) {
    var t = getTour(tourId);
    var byDate = {};
    G.rows(t && t.shows).forEach(function (x) { if (x.date) byDate[x.date] = x; });
    days.forEach(function (d) {
      d.show = byDate[d.date] || null;
      d.keep = !!d.show;
    });
    var matched = days.filter(function (d) { return d.show; });
    var loose = days.filter(function (d) { return !d.show; });

    openSheet(function () {
      var applyBtn = h('button', { class: 'btn primary block', type: 'button' }, '');
      function refresh() {
        var n = days.filter(function (d) { return d.keep && d.show; }).length;
        applyBtn.textContent = n ? 'Fill ' + plural(n, 'day sheet') : 'Pick the days to fill';
        applyBtn.disabled = !n;
      }
      applyBtn.addEventListener('click', async function () {
        var patch = {};
        var n = 0;
        days.forEach(function (d) {
          if (!d.keep || !d.show) return;
          patch[d.show.id] = { daySheet: G.mergeDaySheet(d.show.daySheet, d.sheet) };
          n += 1;
        });
        if (!n) return;
        if (await api.update(tourId, { shows: patch })) {
          closeSheet();
          toast(plural(n, 'day sheet') + ' filled from the export');
          render(true);
        }
      });

      var rows = matched.map(function (d) {
        var wrap = h('div', { class: 'rv-row' });
        var cb = h('input', { type: 'checkbox', class: 'rv-check',
          'aria-label': 'Fill ' + d.date,
          onchange: function (e) { d.keep = e.target.checked; wrap.classList.toggle('off', !d.keep); refresh(); } });
        cb.checked = d.keep;
        var preview = G.daySheetLines({ daySheet: d.sheet }).slice(0, 3).join(' \u00b7 ');
        wrap.append(cb, h('div', { class: 'rv-fields' },
          h('div', { class: 'rv-head' },
            h('span', { class: 'rv-name' }, (d.show.city || d.city || 'Show') + ' \u00b7 ' + dayMD(d.date))),
          h('div', { class: 'rv-sub' }, preview || 'Schedule details')));
        return wrap;
      });
      refresh();
      return [
        h('h2', { class: 'sh-title' }, 'Found ' + plural(days.length, 'day')),
        h('p', { class: 'sh-sub' }, 'Anything the export knows fills in; anything you already wrote by hand stays.'),
        rows.length ? h('div', { class: 'review' }, rows)
          : emptyState('No matching dates', 'None of these days line up with shows on this tour.'),
        loose.length ? h('p', { class: 'note' },
          plural(loose.length, 'day') + ' in the export (' +
          loose.map(function (d) { return dayMD(d.date); }).join(', ') +
          ') ' + (loose.length === 1 ? 'has' : 'have') + ' no show on this tour, so ' +
          (loose.length === 1 ? 'it was' : 'they were') + ' left out.') : null,
        h('div', { class: 'stack' }, applyBtn,
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel'))
      ];
    }, { label: 'Import from Master Tour' });
  }

  /* ---------------- Settlement sheets ---------------- */

  function settlementPrompt(body, isImage, show) {
    return [
      isImage
        ? 'The attached image(s) are a concert settlement sheet from a promoter or venue.'
        : 'The text below was pulled out of a concert settlement sheet from a promoter or venue.',
      show && show.city ? 'The show: ' + show.city + (show.venue ? ', ' + show.venue : '') +
        (show.date ? ', ' + show.date + '.' : '.') : '',
      'Pull out what the ARTIST earned, and the story of the night.',
      '',
      'Reply with only a JSON object in this exact shape:',
      '{"income":{"guarantee":null,"backend":null,"merch":null,"vip":null,"buyouts":null,"catering":null,"misc":null,"miscLabel":""},',
      ' "notes":[{"label":"Attendance","value":"734 of 900"}]}',
      '',
      'Income rules:',
      '- Fill a number ONLY if it is actually on the sheet; otherwise leave it null. Never estimate.',
      '- guarantee: the contracted guarantee, before any tax or deductions.',
      '- backend: overage / points / percentage-of-door the artist hit, past the guarantee.',
      '- misc: anything else paid to the artist, with miscLabel naming it.',
      '- merch: the artist’s NET merch money after any venue cut, if the sheet settles merch.',
      '- vip, buyouts, catering: only if the sheet shows them as money paid to the artist.',
      '',
      'Notes: short label/value pairs, only for things the sheet actually shows. Use these labels when present:',
      '- "Attendance" (e.g. "734 of 900"), "Pre-sale tickets", "Door sales", "Comps",',
      '- "Tax withheld" (amount, and what the artist walked with if shown),',
      '- "Back end" (whether the artist hit it, and the math if shown),',
      '- "Gross merch", "Venue merch cut" (the % or amount the venue took), "Merch per head" (dollars per attendee if shown or computable from attendance),',
      '- "Ticket price", "Gross box office", and anything else a touring artist would want flagged.',
      'Keep every value under a dozen words. If the sheet is unreadable, reply {"income":{},"notes":[]}.',
      isImage ? '' : '\nSettlement text:\n' + body
    ].join('\n');
  }

  /* atVenu is merch-only: the summary fills merch and the per-head, never the
     guarantee or the promoter's side of the night. */
  function atvenuPrompt(body, isImage) {
    return [
      isImage
        ? 'The attached image(s) are a merch summary or merch settlement from atVenu (or a similar merch report).'
        : 'The text below was pulled out of a merch summary or merch settlement from atVenu (or a similar merch report).',
      'Pull out ONLY the merch story \u2014 nothing about guarantees, back end or the promoter deal.',
      '',
      'Reply with only a JSON object in this exact shape:',
      '{"income":{"merch":null},"notes":[{"label":"Merch per head","value":"$12.40"}]}',
      '',
      'Rules:',
      '- merch: what the band actually keeps \u2014 the NET. Look for "Net to Artist", "Artist Net",',
      '  "Due to Artist" or the total after the venue cut and fees. Only if no net line exists anywhere',
      '  take "Total Gross" instead and add a note "Gross merch" so it is clear no net was shown.',
      '- Never estimate a number that is not printed on the sheet \u2014 do NOT compute the net yourself.',
      '- notes may ONLY use these labels, and only when the sheet shows them:',
      '  "Gross merch", "Venue merch cut", "Card fees", "Merch per head" (dollars per attendee, shown or computable from gross and attendance), "Attendance".',
      'Keep every value under a dozen words. If the sheet is unreadable, reply {"income":{},"notes":[]}.',
      isImage ? '' : '\nMerch report text:\n' + body
    ].join('\n');
  }

  /* Reads the promoter's settlement into the income sheet: numbers into the
     fields (still yours to check before saving), the night's story into notes. */
  function settlementReader(o) {
    var face = o.btnLabel != null ? o.btnLabel : 'Import Settlement Sheet';
    var cls = o.btnCls || 'btn ghost block';
    var mkPrompt = o.mode === 'atvenu'
      ? function (b, img) { return atvenuPrompt(b, img); }
      : function (b, img) { return settlementPrompt(b, img, o.show); };
    if (!S.sample) return [unavailableBtn(face || 'atVenu Settlement', cls)];
    var reading = false;
    var control = fileControl({
      label: face, logo: o.btnLogo, icon: o.btnLogo ? undefined : 'card', cls: cls,
      ariaLabel: o.ariaLabel,
      accept: 'application/pdf,.pdf,' + imageAccept(), multiple: true,
      onFiles: async function (files) {
        if (reading) return;
        reading = true;
        var btn = control[0];
        var was = btn.textContent;
        if (face) btn.textContent = 'Extracting…';
        btn.disabled = true;
        btn.classList.add('reading');
        // The bus drives next to the button while the sheet is being read.
        var road = roadie();
        road.style.margin = '12px 0 4px';
        if (btn.parentNode) btn.parentNode.insertBefore(road, btn.nextSibling);
        try {
          var pdfFile = files.filter(function (f) { return /pdf/i.test(f.type) || /\.pdf$/i.test(f.name); })[0];
          var images = files.filter(function (f) { return /^image\//i.test(f.type); });
          var out;
          var ariBody = '', ariPics = null; // the same sheet, kept for Ari
          if (pdfFile) {
            var got = await pdfToText(pdfFile);
            if (got.text.replace(/\s/g, '').length > 60) {
              ariBody = got.text;
              out = await S.sample.json(mkPrompt(got.text.slice(0, 40000), false), { cache: false });
            } else {
              var pages = await pdfToImages(got.doc, got.pages);
              ariPics = pages;
              out = await S.sample.json(mkPrompt('', true), { images: pages, cache: false });
            }
          } else if (images.length) {
            ariPics = images;
            out = await S.sample.json(mkPrompt('', true), { images: images, cache: false });
          } else {
            toast('That file type isn’t supported — use a photo or a PDF.');
            return;
          }
          var r = G.normalizeSettlement(out);
          if (o.mode === 'atvenu') {
            var m = r.income.merch;
            r.income = m != null ? { merch: m } : {};
            r.found = m != null ? 1 : 0;
            r.miscLabel = '';
            r.notes = r.notes.filter(function (n) { return /merch|attendance|per head|fees/i.test(n.label); });
          }
          if (!r.found && !r.notes.length) {
            toast('Couldn’t read that sheet. Try a sharper photo.');
            return;
          }
          await o.onResult(r);
          // The income sheet logs itself now, and Ari reads the same sheet
          // to the chat while the numbers land.
          if (o.ariTour && r.found) ariExplain(o.ariTour, ariBody, ariPics);
          if (o.autoSave && r.found) {
            // the save spoke for itself
          } else if (o.mode === 'atvenu') {
            toast(r.found ? 'Merch filled in from atVenu — check it, then save'
              : 'No merch total found, but the notes came through');
          } else {
            toast(r.found
              ? 'Filled in ' + plural(r.found, 'number') + ' — check them against the sheet, then save'
              : 'No dollar amounts found, but the notes came through');
          }
        } catch (e) {
          var code = e && e.code;
          if (code === 'cancelled') return;
          if (SAMPLE_GONE.indexOf(code) >= 0) { S.sample = null; toast('Reading isn’t available right now.'); return; }
          toast(sampleErrorMessage(code, 'statement'));
        } finally {
          reading = false;
          if (face) btn.textContent = was;
          btn.disabled = false;
          btn.classList.remove('reading');
          road.remove();
        }
      }
    });
    return control;
  }

  /* ---------------- Statements ---------------- */

  var pdfLib = null;
  async function loadPdfJs() {
    if (pdfLib) return pdfLib;
    var mod = await import('./vendor/pdf.min.mjs');
    try {
      mod.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', document.baseURI).href;
    } catch (e) { /* the default worker path will be tried instead */ }
    pdfLib = mod;
    return mod;
  }

  async function pdfToText(file) {
    var lib = await loadPdfJs();
    var buf = await file.arrayBuffer();
    var doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
    var pages = Math.min(doc.numPages, 24);
    var out = [];
    for (var i = 1; i <= pages; i++) {
      var page = await doc.getPage(i);
      var content = await page.getTextContent();
      var lines = {};
      content.items.forEach(function (it) {
        if (!it.str) return;
        var yKey = Math.round(it.transform[5]);
        (lines[yKey] = lines[yKey] || []).push(it.str);
      });
      Object.keys(lines).sort(function (a, b) { return b - a; }).forEach(function (k) {
        out.push(lines[k].join(' ').replace(/\s{2,}/g, ' ').trim());
      });
    }
    return { text: out.join('\n'), doc: doc, pages: pages };
  }

  // A scanned statement has no text layer, so the pages become images instead.
  async function pdfToImages(doc, pages) {
    var blobs = [];
    for (var i = 1; i <= Math.min(pages, 6); i++) {
      var page = await doc.getPage(i);
      var viewport = page.getViewport({ scale: 1.6 });
      var canvas = document.createElement('canvas');
      canvas.width = Math.min(1600, Math.round(viewport.width));
      canvas.height = Math.round(viewport.height * (canvas.width / viewport.width));
      var ctx = canvas.getContext('2d');
      await page.render({
        canvasContext: ctx,
        viewport: page.getViewport({ scale: 1.6 * (canvas.width / viewport.width) })
      }).promise;
      var blob = await new Promise(function (res) { canvas.toBlob(res, 'image/jpeg', 0.85); });
      if (blob) blobs.push(blob);
    }
    return blobs;
  }

  function chargesPrompt(body, isImage) {
    return [
      isImage
        ? 'The attached images are pages of a credit card statement.'
        : 'The text below was pulled out of a credit card statement.',
      'List every purchase or charge on it.',
      '',
      'Rules:',
      '- Skip payments, credits, refunds, reversals and anything that reduces the balance.',
      '- date: YYYY-MM-DD. Use the year printed on the statement.',
      '- description: the merchant line exactly as printed.',
      '- amount: a positive number with no currency symbol.',
      '',
      'Reply with only a JSON array, for example:',
      '[{"date":"2026-09-08","description":"PILOT TRAVEL CTR #482","amount":142.55}]',
      'If there are no charges, reply with [].',
      isImage ? '' : '\nStatement text:\n' + body
    ].join('\n');
  }

  function normalizeCharges(out) {
    var arr = Array.isArray(out) ? out : (G.isObj(out) && Array.isArray(out.charges) ? out.charges : []);
    var rows = [];
    arr.slice(0, 400).forEach(function (r) {
      if (!G.isObj(r)) return;
      var date = String(r.date == null ? '' : r.date).trim();
      var desc = String(r.description == null ? '' : r.description).trim().slice(0, 140);
      var amount = Math.abs(G.num(r.amount));
      if (!G.parseDay(date) || !amount) return;
      rows.push({ date: date, description: desc, amount: amount, merchant: GRS.cleanMerchant(desc) });
    });
    return rows;
  }

  /* One call on a fast model: clean merchant names, and a category only when it
     is a no-brainer. Everything else stays blank for the user to decide. */
  async function cleanMerchants(charges, signal) {
    var fallback = charges.map(function (c) {
      return Object.assign({}, c, { merchant: GRS.cleanMerchant(c.description) });
    });
    if (!S.sample || !charges.length) return fallback;

    var known = Object.keys(S.labels)
      .map(function (k) { return S.labels[k].merchant; })
      .filter(Boolean).slice(0, 150);

    var lines = charges.map(function (c, i) { return i + ': ' + (c.description || c.merchant); }).join('\n');
    var prompt = [
      'Each line below is a raw credit card statement description.',
      'For each one, give a clean, human merchant name.',
      '',
      'Rules:',
      '- Strip store numbers, street addresses, city and state, phone numbers,',
      '  and processor prefixes such as "SQ *", "TST*", "SP ", "PAYPAL *".',
      '- Keep the brand. "PILOT TRAVEL CTR #482 TOLEDO OH" becomes "Pilot".',
      '- If the merchant is already in the known names list, reuse that exact spelling.',
      '- Set "category" ONLY when it is a no-brainer: an airline is "flights",',
      '  a hotel, motel or other lodging is "hotels", Uber or Lyft is "rideshare".',
      '  Otherwise leave category null.',
      '',
      known.length ? 'Known names: ' + known.join(', ') : 'Known names: (none yet)',
      '',
      'Reply with only a JSON array, one entry per line, same order:',
      '[{"i":0,"merchant":"Pilot","category":null}]',
      '',
      'Lines:',
      lines
    ].join('\n');

    try {
      var out = await S.sample.json(prompt, { modelTier: 'quick', signal: signal, cache: false });
      var arr = Array.isArray(out) ? out : (G.isObj(out) && Array.isArray(out.items) ? out.items : []);
      var byIndex = {};
      arr.forEach(function (r, n) {
        if (!G.isObj(r)) return;
        var i = Number(r.i);
        if (!isFinite(i)) i = n;
        byIndex[i] = r;
      });
      var valid = {};
      G.CHARGE_CATEGORIES.forEach(function (c) { valid[c.key] = true; });
      return charges.map(function (c, i) {
        var r = byIndex[i] || {};
        var name = String(r.merchant == null ? '' : r.merchant).trim().slice(0, 60);
        var cat = String(r.category == null ? '' : r.category).trim();
        return Object.assign({}, c, {
          merchant: name || GRS.cleanMerchant(c.description),
          suggested: (cat === 'flights' || cat === 'hotels' || cat === 'rideshare') && valid[cat] ? cat : null
        });
      });
    } catch (e) {
      if (e && SAMPLE_GONE.indexOf(e.code) >= 0) S.sample = null;
      return fallback; // the deterministic cleanup is a perfectly usable answer
    }
  }

  async function readStatement(tourId, files) {
    var ctl = new AbortController();
    busySheet('Reading the statement', 'Pulling out the charges. This can take a minute.',
      function () { ctl.abort(); closeSheet(); });

    try {
      var csvFile = files.filter(function (f) { return /\.csv$|\.tsv$|text\/csv/i.test(f.name + ' ' + f.type); })[0];
      var pdfFile = files.filter(function (f) { return /pdf/i.test(f.type) || /\.pdf$/i.test(f.name); })[0];
      var images = files.filter(function (f) { return /^image\//i.test(f.type); });
      var raw = null;
      var source = 'csv';

      if (csvFile) {
        var text = await csvFile.text();
        var parsed = GRS.parseStatementCSV(text, {});
        if (parsed.ok) {
          raw = parsed.charges;
        } else if (S.sample) {
          raw = normalizeCharges(await S.sample.json(chargesPrompt(text.slice(0, 60000), false),
            { signal: ctl.signal, cache: false }));
        } else {
          finishFail('That CSV couldn’t be read', 'The date and amount columns weren’t where we expected. Try exporting it again, or upload a screenshot instead.');
          return;
        }
      } else if (pdfFile) {
        source = 'pdf';
        var got;
        try { got = await pdfToText(pdfFile); }
        catch (e) { finishFail('That PDF couldn’t be opened', 'It may be password-protected. Try a screenshot of the statement instead.'); return; }
        if (!S.sample) {
          finishFail('Reading PDFs isn’t available here', 'Upload a CSV export of the statement instead.');
          return;
        }
        if (got.text.replace(/\s/g, '').length > 60) {
          raw = normalizeCharges(await S.sample.json(chargesPrompt(got.text.slice(0, 60000), false),
            { signal: ctl.signal, cache: false }));
        } else {
          var pages = await pdfToImages(got.doc, got.pages);
          if (!pages.length) { finishFail('That PDF couldn’t be read', 'Try a screenshot of the statement instead.'); return; }
          raw = normalizeCharges(await S.sample.json(chargesPrompt('', true),
            { images: pages, signal: ctl.signal, cache: false }));
        }
      } else if (images.length) {
        source = 'image';
        if (!S.sample) { finishFail('Reading images isn’t available here', 'Upload a CSV export of the statement instead.'); return; }
        raw = normalizeCharges(await S.sample.json(chargesPrompt('', true),
          { images: images, signal: ctl.signal, cache: false }));
      } else {
        finishFail('That file type isn’t supported', 'Upload a CSV, a PDF, or screenshots of the statement.');
        return;
      }

      if (!raw || !raw.length) {
        finishFail('No charges found', 'Nothing in that file looked like a purchase. Try a different export, or a screenshot.');
        return;
      }

      var cleaned = await cleanMerchants(raw, ctl.signal);
      var labelled = GRS.applyLabels(cleaned, S.labels);
      var t = getTour(tourId);
      var marked = GRS.markDuplicates(labelled, G.rows(t && t.charges));
      // Anything dated inside a card's opening balance is set aside, not counted.
      marked = GRS.markPreCutoff(marked, G.preTourCutoff(t));
      // Raw descriptions stop here. Nothing past this point keeps them.
      var rows = marked.map(function (c) {
        return {
          date: c.date, merchant: c.merchant, amount: c.amount,
          category: c.category || '', source: c.source || null,
          duplicate: !!c.duplicate, preCutoff: !!c.preCutoff && !c.duplicate,
          keep: !c.duplicate && !c.preCutoff
        };
      });
      openImportReview(tourId, rows, source);
    } catch (e) {
      var code = e && e.code;
      if (code === 'cancelled') return;
      if (SAMPLE_GONE.indexOf(code) >= 0) {
        S.sample = null; render(true);
        finishFail('Reading isn’t available here', 'Upload a CSV export of the statement instead.');
        return;
      }
      finishFail('Couldn’t read that statement', sampleErrorMessage(code, 'statement'));
    }

    function finishFail(title, msg) { readFail(title, msg, null, null); }
  }

  /* A category picker that can grow: its last option turns into a small
     name-it input, and the new category is saved on the tour (extraCats) and
     counted like any built-in. */
  function categorySelect(tourId, o) {
    var holder = h('span', { class: 'catpick' });
    var sel;
    function build() {
      sel = h('select', { class: o.cls || 'input sm', 'aria-label': o.aria || 'Category',
        onchange: function (e) {
          if (e.target.value === '__new') { grow(); return; }
          o.value = e.target.value;
          o.onPick(e.target.value || null);
        } });
      sel.append(h('option', { value: '' }, o.noneLabel || 'Pick a category'));
      G.chargeCategoriesFor(getTour(tourId)).forEach(function (c) {
        sel.append(h('option', { value: c.key }, c.label));
      });
      sel.append(h('option', { value: '__new' }, '+ New category\u2026'));
      sel.value = o.value || '';
      holder.replaceChildren(sel);
    }
    function grow() {
      var inp = h('input', { class: 'input sm', type: 'text', maxlength: 30,
        placeholder: 'Name it \u2014 e.g. Security', autocomplete: 'off',
        onkeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } } });
      async function commit() {
        var label = String(inp.value || '').trim();
        var key = G.slugCategory(label);
        if (!label || !key) { build(); return; }
        var t = getTour(tourId);
        var clash = G.chargeCategoriesFor(t).filter(function (c) {
          return c.key === key || c.label.toLowerCase() === label.toLowerCase();
        })[0];
        if (clash) key = clash.key;
        else {
          var patch = { extraCats: {} };
          patch.extraCats[key] = label;
          if (!(await api.update(tourId, patch))) { build(); return; }
          toast('\u201c' + label + '\u201d is a category now \u2014 on this tour everywhere');
        }
        o.value = key;
        build();
        o.onPick(key);
      }
      holder.replaceChildren(h('span', { class: 'af-row', style: 'display:flex;gap:8px' }, inp,
        h('button', { class: 'btn sm primary', type: 'button', onclick: commit }, 'Add')));
      setTimeout(function () { inp.focus(); }, 30);
    }
    build();
    return holder;
  }

  function openImportReview(tourId, rows, source) {
    var importId = newId();

    function counts() {
      var n = 0, total = 0;
      rows.forEach(function (r) {
        if (!r.keep) return;
        n += 1;
        if (!r.accounted) total += G.num(r.amount);
      });
      return { n: n, total: total };
    }

    async function save() {
      var missing = rows.filter(function (r) { return r.keep && !r.category; });
      if (missing.length) {
        toast('Pick a category for each charge you’re adding');
        return;
      }
      var chosen = rows.filter(function (r) { return r.keep; });
      if (!chosen.length) { toast('Pick at least one charge'); return; }

      var patch = {};
      var total = 0;
      chosen.forEach(function (r, i) {
        // Only ever these four fields: no card numbers, no raw text, no file names.
        patch[newId() + i] = {
          date: r.date, merchant: r.merchant, amount: G.num(r.amount),
          category: r.category, accounted: !!r.accounted,
          importId: importId, createdAt: Date.now() + i
        };
        if (!r.accounted) total += G.num(r.amount);
      });
      var imports = {};
      imports[importId] = { createdAt: Date.now(), count: chosen.length, total: total, source: source };

      if (!(await api.update(tourId, { charges: patch, imports: imports }))) return;
      for (var i = 0; i < chosen.length; i++) await writeLabel(chosen[i].merchant, chosen[i].category);
      closeSheet();
      toast(plural(chosen.length, 'charge') + ' added, ' + G.moneyCents(total));
      render(true);
    }

    openSheet(function () {
      var saveBtn = h('button', { class: 'btn primary block', type: 'button', onclick: save }, '');
      function refresh() {
        var c = counts();
        saveBtn.textContent = c.n ? 'Add ' + plural(c.n, 'charge') + ' · ' + G.moneyCents(c.total) : 'Pick the charges to add';
        saveBtn.disabled = !c.n;
      }

      function chargeRow(r) {
        var wrap = h('div', { class: 'rv-row' + (r.keep ? '' : ' off') });
        var cb = h('input', {
          type: 'checkbox', class: 'rv-check', 'aria-label': 'Add ' + r.merchant,
          onchange: function (e) { r.keep = e.target.checked; wrap.classList.toggle('off', !r.keep); refresh(); }
        });
        cb.checked = r.keep;

        var sel = categorySelect(tourId, {
          value: r.category || '', aria: 'Category for ' + r.merchant,
          onPick: function (v) {
            r.category = v;
            r.source = v ? 'chosen' : null;
            var tagEl = $('.rv-flag', wrap);
            if (tagEl) tagEl.remove();
            refresh();
          }
        });

        // Some charges are already in the budget as money paid. Saying yes
        // files the charge without counting it a second time.
        var already = h('div', { class: 'rv-acc' },
          h('span', { class: 'rv-acc-q' }, 'Already accounted for?'),
          segmented(['No', 'Yes'], r.accounted ? 1 : 0, function (i) {
            r.accounted = i === 1;
            wrap.classList.toggle('accounted', r.accounted);
            refresh();
          }, 'Is this charge already accounted for?'));

        wrap.append(cb, h('div', { class: 'rv-fields' },
          h('div', { class: 'rv-head' },
            h('span', { class: 'rv-name' }, r.merchant),
            h('span', { class: 'amt num' }, G.moneyCents(r.amount))),
          h('div', { class: 'rv-sub' }, dayMD(r.date),
            r.source === 'learned' ? h('span', { class: 'rv-flag learned' }, 'Learned') : null,
            r.source === 'suggested' ? h('span', { class: 'rv-flag' }, 'Suggested') : null),
          sel, already));
        return wrap;
      }

      var groups = GRS.groupForReview(rows.map(function (r) {
        return Object.assign({}, r, { category: r.category || null });
      }));
      // Work against the live rows, not the copies the grouping made.
      var needs = rows.filter(function (r) { return !r.duplicate && !r.preCutoff && !r.category; });
      var filled = rows.filter(function (r) { return !r.duplicate && !r.preCutoff && r.category; });
      var already = rows.filter(function (r) { return r.duplicate; });
      var before = rows.filter(function (r) { return r.preCutoff && !r.duplicate; });

      var body = [];
      if (needs.length) {
        body.push(h('h3', { class: 'sh-h3' }, 'Needs a label'));
        body.push(h('p', { class: 'sh-sub' }, 'Pick where each of these belongs. Greenroom remembers for next time.'));
        body.push(h('div', { class: 'review' }, needs.map(chargeRow)));
      }
      if (filled.length) {
        body.push(h('h3', { class: 'sh-h3' }, 'Filled in'));
        body.push(h('div', { class: 'review' }, filled.map(chargeRow)));
      }
      if (before.length) {
        var t2 = getTour(tourId);
        var cardNames = G.cardDebts(t2).map(function (c) { return c.label || 'your card'; });
        var whose = cardNames.length === 1 ? 'the ' + cardNames[0] + ' balance' : 'the card balance';
        var beforeList = h('div', { class: 'review', hidden: true }, before.map(chargeRow));
        body.push(h('button', {
          class: 'btn quiet block', type: 'button', style: 'margin-top:18px',
          onclick: function (e) {
            beforeList.hidden = !beforeList.hidden;
            e.currentTarget.textContent = (beforeList.hidden ? 'Show ' : 'Hide ') +
              plural(before.length, 'charge') + ' from before the tour started';
          }
        }, 'Show ' + plural(before.length, 'charge') + ' from before the tour started'));
        body.push(h('p', { class: 'note' },
          'These are already inside ' + whose + ' you entered, so adding them would count the money twice. Tick one only if it isn’t.'));
        body.push(beforeList);
      }
      if (already.length) {
        var alreadyList = h('div', { class: 'review', hidden: true }, already.map(chargeRow));
        body.push(h('button', {
          class: 'btn quiet block', type: 'button', style: 'margin-top:18px',
          onclick: function (e) {
            alreadyList.hidden = !alreadyList.hidden;
            e.currentTarget.textContent = (alreadyList.hidden ? 'Show ' : 'Hide ') +
              plural(already.length, 'charge') + ' already imported';
          }
        }, 'Show ' + plural(already.length, 'charge') + ' already imported'));
        body.push(alreadyList);
      }
      refresh();

      return [
        h('h2', { class: 'sh-title' }, 'Found ' + plural(rows.length, 'charge')),
        h('p', { class: 'sh-sub' }, 'Tick the ones that belong to this tour. Nothing you leave unticked is saved.'),
        body,
        h('div', { class: 'stack' }, saveBtn,
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel'))
      ];
    }, { label: 'Review card charges' });
  }

  /* ---------------- Card charges, imports and learned labels ---------------- */

  function openChargesSheet(tourId) {
    function build() {
      var t = getTour(tourId);
      var charges = G.rows(t && t.charges).sort(function (a, b) {
        return String(b.date || '').localeCompare(String(a.date || ''));
      });
      var catLabel = {};
      G.chargeCategoriesFor(getTour(tourId)).forEach(function (c) { catLabel[c.key] = c.label; });

      if (!charges.length) {
        return [
          h('h2', { class: 'sh-title' }, 'Card charges'),
          emptyState('Nothing imported yet', 'Import a card statement and the charges land here.')
        ];
      }
      return [
        h('h2', { class: 'sh-title' }, 'Card charges'),
        h('p', { class: 'sh-sub' }, 'Change a category here and Greenroom learns the new one for that merchant.'),
        h('div', { class: 'ledger' }, charges.map(function (ch) {
          var right;
          if (canWrite()) {
            right = categorySelect(tourId, {
              value: ch.category || '', cls: 'input sm slim', noneLabel: 'No category',
              aria: 'Category for ' + ch.merchant,
              onPick: async function (v) {
                var patch = {}; patch[ch.id] = { category: v || null };
                if (await api.update(tourId, { charges: patch })) {
                  if (v) await writeLabel(ch.merchant, v);
                  toast('Saved'); render(true);
                }
              }
            });
          } else {
            right = h('span', { class: 'hint' }, catLabel[ch.category] || 'No category');
          }
          return h('div', { class: 'row' },
            h('div', { class: 'row-label' }, ch.merchant || 'Charge',
              h('span', { class: 'hint' }, dayMD(ch.date) + ' · ' + G.moneyCents(ch.amount))),
            right);
        }))
      ];
    }
    openSheet(build, { label: 'Card charges' });
  }

  function openImportsSheet(tourId) {
    function build() {
      var t = getTour(tourId);
      var imports = G.rows(t && t.imports).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      if (!imports.length) {
        return [h('h2', { class: 'sh-title' }, 'Imports'),
          emptyState('No imports yet', 'Statements you import show up here so you can undo one.')];
      }
      var names = { csv: 'CSV', pdf: 'PDF', image: 'Screenshots' };
      return [
        h('h2', { class: 'sh-title' }, 'Imports'),
        h('p', { class: 'sh-sub' }, 'Uploaded the wrong statement? Remove the whole import.'),
        h('div', { class: 'ledger' }, imports.map(function (im) {
          var when = new Date(im.createdAt || Date.now());
          return h('div', { class: 'row' },
            h('div', { class: 'row-label' },
              plural(G.num(im.count), 'charge') + ' · ' + money(G.num(im.total)),
              h('span', { class: 'hint' }, (names[im.source] || 'Statement') + ' · ' +
                F.long.format(when))),
            canWrite() ? h('button', {
              class: 'iconbtn sm', type: 'button', 'aria-label': 'Remove this import',
              onclick: function () {
                confirmSheet({
                  title: 'Remove this import?',
                  body: plural(G.num(im.count), 'charge') + ' worth ' + money(G.num(im.total)) +
                    ' comes off the tour. What Greenroom learned about those merchants stays.',
                  action: 'Remove import', danger: true,
                  onConfirm: async function () {
                    var cur = getTour(tourId);
                    var patch = {};
                    G.rows(cur && cur.charges).forEach(function (ch) {
                      if (ch.importId === im.id) patch[ch.id] = null;
                    });
                    var imPatch = {}; imPatch[im.id] = null;
                    var ok = await api.update(tourId, { charges: patch, imports: imPatch });
                    if (ok) toast('Import removed');
                    return ok;
                  }
                });
              }
            }, icon('trash', 18)) : null);
        }))
      ];
    }
    openSheet(build, { label: 'Imports' });
  }

  function openLabelsSheet() {
    function build() {
      var keys = Object.keys(S.labels).filter(function (k) {
        return k.indexOf('crew:') !== 0 && k.indexOf('alogo:') !== 0 && k.indexOf('artist:') !== 0;
      }).sort(function (a, b) {
        var an = (S.labels[a].merchant || a).toLowerCase();
        var bn = (S.labels[b].merchant || b).toLowerCase();
        return an.localeCompare(bn);
      });
      var catLabel = {};
      G.CHARGE_CATEGORIES.forEach(function (c) { catLabel[c.key] = c.label; });

      if (!keys.length) {
        return [h('h2', { class: 'sh-title' }, 'Learned labels'),
          emptyState('Nothing learned yet',
            'When you label a card charge, Greenroom remembers that merchant for every tour.')];
      }
      return [
        h('h2', { class: 'sh-title' }, 'Learned labels'),
        h('p', { class: 'sh-sub' }, 'What Greenroom fills in for you. These carry across every tour.'),
        h('div', { class: 'ledger' }, keys.map(function (k) {
          var rec = S.labels[k];
          var cats = Object.keys(rec.cats || {}).filter(function (c) { return rec.cats[c] > 0; });
          var text = cats.length === 1
            ? catLabel[cats[0]] || (String(cats[0]).indexOf('x-') === 0
              ? cats[0].slice(2).replace(/-/g, ' ') : cats[0])
            : 'Labelled ' + cats.length + ' different ways — left blank';
          return h('div', { class: 'row' },
            h('div', { class: 'row-label' }, rec.merchant || k,
              h('span', { class: 'hint' + (cats.length === 1 ? '' : ' over') }, text)),
            canWrite() ? h('button', {
              class: 'iconbtn sm', type: 'button', 'aria-label': 'Forget ' + (rec.merchant || k),
              onclick: async function () {
                await removeLabel(rec.merchant || k);
                toast('Forgot ' + (rec.merchant || k));
                openLabelsSheet();
              }
            }, icon('trash', 18)) : null);
        }))
      ];
    }
    openSheet(build, { label: 'Learned labels' });
  }

  /* ============================== Start ============================== */

  function initRole() {
    var c = window.claude;
    if (!c || typeof c.use !== 'function') { S.role = 'owner'; return; }
    c.use('user').then(async function (user) {
      if (!user) { S.role = 'owner'; render(true); return; }
      try {
        if (user.isOwner()) S.role = 'owner';
        else if (user.canEdit()) S.role = 'editor';
        else {
          var w = await user.can('data.write');
          S.role = w === false ? 'viewer' : 'editor';
        }
      } catch (e) { S.role = 'editor'; }
      render(true);
    }).catch(function () { S.role = 'owner'; });
  }

  function initCapabilities() {
    var c = window.claude;
    if (!c || typeof c.use !== 'function') return;
    c.use('sample').then(async function (sample) {
      if (!sample) return;
      var lim = null;
      try { lim = await sample.limits(); } catch (e) { lim = null; }
      S.sample = sample;
      if (lim && lim.images) {
        S.imageTypes = Array.isArray(lim.images.mediaTypes) ? lim.images.mediaTypes : [];
        S.imageMax = Number(lim.images.maxInputBytes) || 0;
      }
      render();
    }).catch(function () { /* reading stays off; everything else works */ });
  }

  function init() {
    applyTheme(currentTheme());
    render(true);
    initRole();
    initCapabilities();
    initStore();
    $('#minibar button').addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
    });
    // Keeps the Tonight card honest across the 5am rollover.
    setInterval(function () { if (!sheet && S.loaded) render(); }, 5 * 60 * 1000);
  }
  init();
})();
