/* Greenroom UI. Depends on core.js (globalThis.GR). */
(function () {
  'use strict';

  var G = globalThis.GR;
  var LS_DATA = 'greenroom:v1';
  var LS_LAST = 'greenroom:last';
  var LS_LABELS = 'greenroom:labels';
  var LS_THEME = 'greenroom:theme';
  var TABS = [['shows', 'Shows'], ['sheet', 'Day sheet'], ['expenses', 'Expenses'], ['days', 'Day by day']];
  var VIEW_ONLY = 'You have view-only access, so changes can’t be saved.';

  var S = {
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
        if (G.isObj(v) && G.isObj(v.cats)) m[d.id] = v;
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
    S.route = route;
    if (route.name === 'tour') lsSet(LS_LAST, route.id);
    else if (route.name === 'home') lsSet(LS_LAST, '');
    S.focusOnRender = true;
    window.scrollTo(0, 0);
    render(true);
  }
  function clampStep(s) { return Math.min(4, Math.max(2, Number(s) || 2)); }
  function openTour(id) {
    var t = getTour(id);
    if (t && !t.setupDone && canWrite()) go({ name: 'wizard', id: id, step: clampStep(t.setupStep) });
    else go({ name: 'tour', id: id, tab: 'shows' });
  }
  function restoreLastTour() {
    if (S.restored) return;
    S.restored = true;
    if (S.route.name !== 'home') return;
    var last = lsGet(LS_LAST);
    var t = last ? S.tours.get(last) : null;
    if (t && t.setupDone) S.route = { name: 'tour', id: last, tab: 'shows' };
  }

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
          }, 'Cancel'))
      ];
    }, { label: o.title });
  }

  /* ============================== The hero ============================== */

  function heroNode(tour) {
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
      chart.__data = { series: series, nights: loggedNights(tour) };
    }

    var fill = h('div', { class: 'prog-fill', id: 'prog-fill' });
    var prog = h('div', { class: 'prog' },
      h('div', { class: 'prog-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
        'aria-valuenow': String(pct), 'aria-label': pct + '% of the way to green' }, fill),
      h('div', { class: 'prog-cap' },
        h('span', { id: 'prog-pct' }, c.out > 0 ? pct + '% of the way to green' : 'No costs added yet'),
        h('span', { class: 'num' }, money(c.income) + ' in / ' + money(c.out) + ' out')));

    var hero = h('section', { class: 'hero ' + st, id: 'hero', 'aria-label': 'Tour balance' },
      odo, cap, chip, chart, prog);
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

    wrap.replaceChildren(svg, flag, pill,
      h('div', { class: 'chart-ends' },
        h('span', null, dayMD(series[0].date)),
        h('span', null, dayMD(series[last].date))));

    wrap.__geo = { x: x, y: y, W: W, H: H, svg: svg, pill: pill, series: series, nights: d.nights };
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

    var restText = money(c.net, true);
    var restCap = G.caption(c);
    var restPct = hero.__pct;
    var restPctText = pctEl ? pctEl.textContent : '';
    var cur = -1;

    function showIndex(i) {
      var p = geo.series[i];
      if (!p) return;
      cur = i;
      wrap.classList.add('scrubbing');
      hero.classList.add('scrubbing');
      var px = geo.x(i), py = geo.y(p.net);
      var up = p.net >= 0;

      cursor.setAttribute('x1', px); cursor.setAttribute('x2', px);
      dot.setAttribute('cx', px); dot.setAttribute('cy', py);
      dot.setAttribute('class', 'dot ' + (up ? 'pos' : 'neg'));

      renderOdo(odo, money(p.net, true), money(p.net, true));
      setHeroState(hero, up ? 'green' : 'red');

      var night = geo.nights[p.date];
      cap.textContent = dayLong(p.date);

      geo.pill.hidden = false;
      geo.pill.textContent = night
        ? night.city + ' · ' + money(night.total) + ' in'
        : 'No show that night';
      geo.pill.style.left = (px / geo.W * 100) + '%';
      geo.pill.style.top = (py / geo.H * 100) + '%';

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
      geo.pill.hidden = true;
      renderOdo(odo, restText, restText);
      setHeroState(hero, G.stateOf(c));
      cap.textContent = restCap;
      hero.style.setProperty('--cov', restPct + '%');
      setProgress(hero, restPct, c.out);
      if (pctEl) pctEl.textContent = restPctText;
    }

    wrap.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      wrap.setPointerCapture(e.pointerId);
      fromPointer(e);
    });
    wrap.addEventListener('pointermove', function (e) {
      if (wrap.hasPointerCapture(e.pointerId)) fromPointer(e);
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
    var colors = ['#2BE38C', '#16C16C', '#0FA35B', '#8FF3C4', '#FFFFFF'];
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
  function viewLoading() {
    return h('div', { class: 'page' },
      h('div', { class: 'splash' },
        h('span', { class: 'logo-mark', role: 'img', 'aria-label': 'Greenroom' }),
        h('div', { class: 'splash-name' }, 'Loading your tours…')));
  }
  // The mark carries the name on its own — no wordmark beside it.
  function wordmark() {
    return h('span', { class: 'logo-mark top', role: 'img', 'aria-label': 'Greenroom' });
  }

  /* ---- Theme ---- */
  function currentTheme() { return lsGet(LS_THEME) === 'light' ? 'light' : 'black'; }
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

  function allTourEntries() {
    var entries = Array.from(S.tours.entries());
    Object.keys(S.pending).forEach(function (id) {
      if (!S.tours.has(id)) entries.push([id, S.pending[id]]);
    });
    entries.sort(function (a, b) { return (b[1].createdAt || 0) - (a[1].createdAt || 0); });
    return entries;
  }

  function artistOf(t) { return String(t && t.artist || '').trim(); }

  function homePill() {
    if (S.role === 'viewer' || S.writeRefused) return 'View only';
    if (S.role === 'editor') return 'Editor';
    if (S.mode === 'local') return store.lsOk ? 'Saved on this device' : 'Changes won’t be kept';
    return null;
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
    var pill = homePill();

    return h('div', { class: 'page home' },
      h('header', { class: 'topbar' }, wordmark(),
        h('div', { class: 'topbar-actions' },
          pill ? h('span', { class: 'pill' }, pill) : null, themeBtn())),
      dbBanner(),
      canWrite()
        ? h('button', { class: 'add-tour', type: 'button', onclick: startTour },
            icon('plus', 24), h('span', null, 'ADD TOUR'))
        : null,
      byArtist.size
        ? h('ul', { class: 'tour-list' }, Array.from(byArtist, function (pair) {
            return h('li', null, artistCard(pair[0], pair[1]));
          }))
        : null,
      loose.length
        ? h('ul', { class: 'tour-list', style: byArtist.size ? 'margin-top:12px' : null },
            loose.map(function (e) { return h('li', null, tourCard(e[0], e[1])); }))
        : null,
      (!byArtist.size && !loose.length)
        ? emptyState('No tours yet', canWrite()
            ? 'Add a tour, put in what it costs, then log each show as it happens. The big number tells you whether you’re in the red or in the green.'
            : 'Nothing has been shared with you yet.')
        : null,
      canWrite()
        ? h('div', { class: 'home-foot' },
            h('button', { class: 'linkbtn', type: 'button', onclick: loadSample }, 'Load a sample tour'),
            h('span', { class: 'hint' },
              byArtist.size
                ? 'A finished run you can poke at. Delete it whenever.'
                : 'Managing more than one act? Name the artist when you add a tour, and this screen becomes one folder per artist.'))
        : null);
  }

  /* One artist, all their runs rolled up. */
  function artistCard(name, entries) {
    var net = 0, active = false;
    var count = entries.length;
    entries.forEach(function (e) {
      var c = G.calc(e[1]);
      net += c.net;
      if (c.out > 0 || c.income > 0) active = true;
    });
    var st = !active ? 'idle' : (G.round(net) < 0 ? 'red' : 'green');
    return h('button', { class: 'tour-card ' + st, type: 'button',
      onclick: function () { go({ name: 'artist', artist: name }); } },
      h('div', { class: 'tc-top' },
        h('div', { class: 'tc-name' }, name), icon('chevron', 20)),
      h('div', { class: 'tc-meta' }, plural(count, 'tour')),
      h('div', { class: 'tc-num' },
        h('span', { class: 'tc-big num' }, money(net, true)),
        h('span', { class: 'tc-cap' }, !active ? 'Nothing logged yet'
          : (G.round(net) < 0 ? 'to break even, all tours' : 'in the green, all tours'))));
  }

  /* One artist's tours. */
  function viewArtist() {
    var name = S.route.artist || '';
    var entries = allTourEntries().filter(function (e) { return artistOf(e[1]) === name; });
    var pill = homePill();
    return h('div', { class: 'page home' },
      h('header', { class: 'topbar' },
        h('button', { class: 'iconbtn back', type: 'button', onclick: function () { go({ name: 'home' }); } },
          icon('back'), h('span', null, 'Artists')),
        h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
        h('div', { class: 'topbar-actions' },
          pill ? h('span', { class: 'pill' }, pill) : null, themeBtn())),
      dbBanner(),
      h('h1', { class: 'tour-title' }, name),
      canWrite()
        ? h('button', { class: 'add-tour', type: 'button',
            onclick: function () { startTour(name); } },
            icon('plus', 24), h('span', null, 'ADD TOUR'))
        : null,
      entries.length
        ? h('ul', { class: 'tour-list' }, entries.map(function (e) {
            return h('li', null, tourCard(e[0], e[1]));
          }))
        : emptyState('No tours here yet', 'Add ' + name + '’s first run.'));
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
      name: 'Sample tour', createdAt: Date.now(), setupDone: true, setupStep: 5, sample: true,
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
    go({ name: 'tour', id: id, tab: 'shows' });
    toast('Tonight’s show isn’t logged yet — log it and watch the number cross');
  }

  function tourCard(id, t) {
    var c = G.calc(t);
    var st = G.stateOf(c);
    var shows = c.allShows;
    var logged = shows.filter(function (s) { return s.loggedAt; }).length;
    var meta = shows.length
      ? dayMD(shows[0].date) + ' to ' + dayMD(shows[shows.length - 1].date) + ', ' + plural(shows.length, 'show')
      : 'No dates yet';
    var foot = null;
    if (!t.setupDone) foot = 'Setup not finished';
    else if (shows.length) foot = logged + ' of ' + plural(shows.length, 'show') + ' logged';

    return h('button', { class: 'tour-card ' + st, type: 'button', onclick: function () { openTour(id); } },
      h('div', { class: 'tc-top' },
        h('div', { class: 'tc-name' }, t.name || 'Untitled tour'), icon('chevron', 20)),
      h('div', { class: 'tc-meta' }, meta),
      h('div', { class: 'tc-num' },
        h('span', { class: 'tc-big num' }, money(c.net, true)),
        h('span', { class: 'tc-cap' }, G.caption(c))),
      foot ? h('div', { class: 'tc-foot' }, foot) : null);
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
    var exit = function () { return id ? go({ name: 'tour', id: id, tab: 'shows' }) : go({ name: 'home' }); };
    var head = h('div', { class: 'wz-head' },
      h('div', { class: 'wz-bar', 'aria-hidden': 'true' }, [1, 2, 3, 4].map(function (n) {
        return h('i', { class: n <= step ? 'on' : null });
      })),
      h('div', { class: 'wz-meta' },
        h('span', null, 'Step ' + step + ' of 4'),
        h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
        h('button', { class: 'linkbtn', type: 'button', onclick: exit }, id ? 'Finish later' : 'Cancel')));

    var body;
    if (step === 2) body = wzExpenses(id);
    else if (step === 3) body = wzDebt(id, t);
    else if (step === 4) body = wzShows(id, t);
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
      autocomplete: 'off', enterkeyhint: 'next', autofocus: true, 'aria-label': 'Tour name',
      oninput: function (e) { S.drafts.wzName = e.target.value; }
    });
    var artistInput = h('input', {
      class: 'input', type: 'text', id: 'wz-artist', 'data-k': 'wz-artist', list: 'gr-artists',
      value: S.drafts.wzArtist, maxlength: 60, placeholder: 'Optional',
      autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Artist',
      oninput: function (e) { S.drafts.wzArtist = e.target.value; }
    });
    var submit = async function (e) {
      e.preventDefault();
      var name = String(S.drafts.wzName || '').trim();
      var artist = String(S.drafts.wzArtist || '').trim();
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
    return h('form', { class: 'wz-body', onsubmit: submit, novalidate: true },
      h('h1', { class: 'wz-title' }, 'Name the tour'),
      h('p', { class: 'wz-sub' }, 'Whatever you call it on the road.'),
      input,
      field('Artist', artistInput,
        'Managing more than one act? Tours group under their artist on the first screen.'),
      artistDatalist(),
      wzFoot(null, 'Next'));
  }

  function wzExpenses(id) {
    var running = h('div', { class: 'running' },
      h('span', { class: 'lbl' }, 'What the tour costs so far'),
      h('strong', { class: 'amt num' }, '$0'));
    S.runningLed = running;
    var body = expensesEditor(id, 'wizard');
    var submit = async function (e) {
      e.preventDefault();
      blurActive();
      if (!(await saveExpenses(id, { setupStep: 3 }))) return;
      go({ name: 'wizard', id: id, step: 3 });
    };
    return h('form', { class: 'wz-body', onsubmit: submit, novalidate: true },
      h('h1', { class: 'wz-title' }, 'What does the tour cost?'),
      h('p', { class: 'wz-sub' }, 'Your best guess for the whole run. Leave anything you can’t predict blank — you can fill it in later.'),
      running, body,
      wzFoot(function () { go({ name: 'wizard', id: id, step: 1 }); }, 'Next'));
  }

  function wzDebt(id, t) {
    var has = G.rows(t.debts).length > 0;
    return h('div', { class: 'wz-body' },
      h('h1', { class: 'wz-title' }, 'What do you owe going in?'),
      h('p', { class: 'wz-sub' }, 'The card balance you’re carrying into the tour, plus any loans or gear payments. Nothing owed? Skip it.'),
      debtSection(id, t, 'wizard'),
      wzFoot(function () { go({ name: 'wizard', id: id, step: 2 }); }, has ? 'Next' : 'Skip', async function () {
        if (await api.update(id, { setupStep: 4 })) go({ name: 'wizard', id: id, step: 4 });
      }));
  }

  function wzShows(id, t) {
    var shows = G.rows(t.shows).sort(G.byDate);
    return h('div', { class: 'wz-body' },
      h('h1', { class: 'wz-title' }, 'Add your shows'),
      h('p', { class: 'wz-sub' }, S.sample
        ? 'Upload the tour flyer and the dates fill themselves in, or add them one at a time.'
        : 'Each date and city. You can add more any time.'),
      S.sample
        ? h('div', { class: 'stack', style: 'margin-top:0;margin-bottom:18px' },
            fileControl({
              label: 'Upload the flyer', icon: 'flyer', cls: 'btn primary block',
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
      wzFoot(function () { go({ name: 'wizard', id: id, step: 3 }); }, 'Finish', async function () {
        if (!(await api.update(id, { setupDone: true, setupStep: 5 }))) return;
        S.lastNet[id] = 0; // count in from zero the first time the hero is seen
        go({ name: 'tour', id: id, tab: 'shows' });
      }));
  }

  /* ============================== Expenses ============================== */

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
      return k === 'crew' ? (G.crewProjection(t) || null) : d.expenses[k].projected;
    }
    function draftTotal() {
      var sum = 0;
      G.TYPED_CATEGORIES.forEach(function (cat) {
        var p = projectedFor(cat.key);
        var paid = G.num(d.expenses[cat.key].paid) + chargedTo(t, cat.key);
        sum += p == null ? paid : Math.max(p, paid);
      });
      return sum + G.commissionTotal(d.commission, base.income, base.guarantees);
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

    var rows = G.TYPED_CATEGORIES.map(function (cat) {
      if (cat.key === 'crew') return crewRow(id, t);
      var rec = d.expenses[cat.key];
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
      hint.textContent = r.mode === 'pct'
        ? (line.basis === 'guarantee' ? 'of guarantees' : 'of all income')
        : 'flat amount';
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
      r.mode = m; r.value = 0; build(); setHint(); changed();
    }, line.label + ' commission type');
    build(); setHint();
    return h('div', { class: 'row' },
      h('div', { class: 'row-label' },
        h('label', { for: 'comm-' + line.key }, line.label),
        h('div', { class: 'comm-sub' }, seg, hint)),
      holder);
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
      return { text: l.paid > 0 ? money(l.paid) + ' so far' + cardBit(l) : 'Nothing projected yet', cls: '' };
    }
    if (l.left === 0) return { text: 'All ' + money(l.paid) + ' paid' + cardBit(l), cls: ' done' };
    return { text: money(l.paid) + ' paid · ' + money(l.left) + ' left to pay' + cardBit(l), cls: '' };
  }

  function tabExpenses(id, t, c) {
    var rows = c.lines.map(function (l) {
      var hint = lineHint(l);
      var amount = money(l.effective); // what the category actually counts against the tour
      var inner = [
        h('div', { class: 'row-label' }, l.label, h('span', { class: 'hint' + hint.cls }, hint.text)),
        h('span', { class: 'amt num' }, amount)
      ];
      if (!canWrite()) return h('div', { class: 'row' }, inner);
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
      h('strong', { class: 'amt num' }, money(c.fixed + c.commission))));
    var charges = G.rows(t && t.charges);
    return [
      canWrite() ? h('div', { class: 'btnrow' }, fileControl({
        label: 'Import card statement', icon: 'card', cls: 'btn ghost',
        accept: '.csv,.tsv,text/csv,application/pdf,' + imageAccept(), multiple: true,
        onFiles: function (files) { readStatement(id, files); }
      })) : null,
      h('div', { class: 'ledger' }, rows),
      canWrite() ? h('p', { class: 'note' }, 'Tap a category to set what you expect it to cost and what you’ve already paid.') : null,
      h('h3', { class: 'sh-h3', style: 'margin-top:26px' }, 'What you owe going in'),
      h('p', { class: 'note', style: 'margin:2px 2px 12px' },
        'Card balances feed the categories above as money already spent. Loans and gear payments sit on top.'),
      debtSection(id, t, 'tab'),
      charges.length ? h('button', {
        class: 'btn quiet block', type: 'button', style: 'margin-top:14px',
        onclick: function () { openChargesSheet(id); }
      }, icon('card', 18), plural(charges.length, 'card charge')) : null
    ];
  }

  function openCategorySheet(id, key) {
    var cat = G.TYPED_CATEGORIES.filter(function (c) { return c.key === key; })[0];
    var t = getTour(id);
    var rec = G.normExpenses(t && t.expenses)[key];
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
          var v = G.commissionLine(line, d.commission[line.key], base.income, base.guarantees);
          return h('div', null, h('span', null, line.label), h('strong', { class: 'num' }, money(v)));
        });
        kids.push(h('div', null, h('span', null, 'Commission so far'),
          h('strong', { class: 'num' }, money(G.commissionTotal(d.commission, base.income, base.guarantees)))));
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
        h('p', { class: 'sh-sub' }, 'Management and your lawyer take a cut of all income. Your booking agent takes a cut of guarantees only.'),
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

      return [
        h('h2', { class: 'sh-title' }, 'Crew'),
        h('p', { class: 'sh-sub' }, 'Each person’s pay is their total for the tour.'),
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
          toast(person ? 'Crew saved' : 'Added ' + name);
          openCrewSheet(id);
          render(true);
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
    G.TYPED_CATEGORIES.forEach(function (c) { if (G.num(src[c.key]) > 0) f.bd[c.key] = G.num(src[c.key]); });

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
          var cat = G.TYPED_CATEGORIES.filter(function (c) { return c.key === k; })[0];
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
        var unused = G.TYPED_CATEGORIES.filter(function (c) { return !(c.key in f.bd); });
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

  function viewTour() {
    var id = S.route.id;
    var tab = S.route.tab || 'shows';
    var t = getTour(id);
    if (!t) {
      return h('div', { class: 'page' },
        h('header', { class: 'topbar' }, backBtn()),
        emptyState('This tour isn’t here anymore', 'It may have been deleted.'));
    }
    var c = G.calc(t);
    if (tab === 'debt') tab = 'expenses';
    var body;
    if (tab === 'days') body = tabDays(id, t, c);
    else if (tab === 'expenses') body = tabExpenses(id, t, c);
    else if (tab === 'sheet') body = tabDaySheet(id, t);
    else body = tabShows(id, t, c);

    return h('div', { class: 'page tour' },
      h('header', { class: 'topbar' }, backBtn(t),
        h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
        h('div', { class: 'topbar-actions' },
          h('button', { class: 'btn ghost sm', type: 'button', onclick: function () { openShare(id); } },
            icon('share', 17), 'Share'),
          canWrite() ? h('button', {
            class: 'iconbtn', type: 'button', 'aria-label': 'Tour options',
            onclick: function () { openTourMenu(id); }
          }, icon('more')) : null)),
      dbBanner(),
      h('h1', { class: 'tour-title' }, t.name || 'Untitled tour'),
      !t.setupDone && canWrite()
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
      heroNode(t),
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
      h('div', { id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': 'tab-' + tab }, body));
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
    return [
      tonight ? tonightCard(id, tonight) : null,
      canWrite()
        ? h('div', { class: 'btnrow' },
            S.sample ? fileControl({
              label: 'Upload flyer', icon: 'flyer', cls: 'btn primary', accept: imageAccept(),
              onFiles: function (files) { readFlyer(id, files[0]); }
            }) : null,
            h('button', { class: 'btn ghost', type: 'button', onclick: function () { openShowSheet(id); } },
              icon('plus', 18), 'Add show'))
        : null,
      shows.length
        ? [h('p', { class: 'count-line' }, logged + ' of ' + plural(shows.length, 'show') + ' logged'),
           h('ul', { class: 'shows' }, shows.map(function (s) { return showRow(id, s, today); }))]
        : emptyState('No shows yet', canWrite()
            ? 'Add each date and city as they get confirmed.'
            : 'No dates have been added.')
    ];
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
      onclick: function () { openIncome(id, s.id); }
    }, dateBlock(s.date), whereBlock(s), right));
  }

  function tonightCard(id, s) {
    var action;
    if (s.loggedAt) {
      action = h('button', { class: 'btn ghost sm', type: 'button', onclick: function () { openIncome(id, s.id); } },
        money(G.showIncomeTotal(s)));
    } else if (canWrite()) {
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

  function tabDaySheet(id, t) {
    var got = daySheetShowFor(t);
    if (!got) {
      return emptyState('No dates yet', 'Add shows and each one gets its own day sheet.');
    }
    if (S.dsIndex == null || S.dsTour !== id || S.dsIndex >= got.shows.length) {
      S.dsIndex = got.index;
      S.dsTour = id;
    }
    var shows = got.shows;
    var s = shows[S.dsIndex];
    var today = G.tourToday();
    var lines = G.daySheetLines(s);
    var d = G.isObj(s.daySheet) ? s.daySheet : {};

    var nav = h('div', { class: 'ds-nav' },
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Previous show',
        disabled: S.dsIndex === 0,
        onclick: function () { S.dsIndex -= 1; render(true); } }, icon('back', 20)),
      h('div', { class: 'ds-where' },
        h('div', { class: 'ds-city' }, s.city || 'Show',
          s.date === today ? h('span', { class: 'ds-tonight' }) : null),
        h('div', { class: 'hint' }, [dayLong(s.date), s.venue].filter(Boolean).join(' \u00b7 '))),
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Next show',
        disabled: S.dsIndex >= shows.length - 1,
        onclick: function () { S.dsIndex += 1; render(true); } }, icon('chevron', 20)));

    var body;
    if (!lines.length) {
      body = emptyState('Nothing posted for this day yet', canWrite()
        ? 'Fill in the times and the venue details, and the whole tour sees them here.'
        : 'The tour manager hasn\u2019t posted this day yet.');
    } else {
      var rowsOut = [];
      var timeRow = function (label, v) {
        if (!String(v || '').trim()) return;
        rowsOut.push(h('div', { class: 'row ds-row' },
          h('span', { class: 'row-label' }, label),
          h('span', { class: 'ds-time num' }, String(v).trim())));
      };
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
      var amen = [];
      G.DS_AMENITIES.forEach(function (a) {
        if (d[a[0]] === 'yes') amen.push(h('span', { class: 'ds-amen yes' }, a[1]));
        else if (d[a[0]] === 'no') amen.push(h('span', { class: 'ds-amen no' }, 'No ' + a[1].toLowerCase()));
      });
      body = [
        rowsOut.length ? h('div', { class: 'ledger' }, rowsOut) : null,
        venueRows.length ? h('div', { class: 'ledger', style: 'margin-top:12px' }, venueRows) : null,
        amen.length ? h('div', { class: 'ds-amens' }, amen) : null,
        String(d.driveNext || '').trim() ? h('div', { class: 'ds-drive' },
          h('span', { class: 'hint' }, 'Drive to next venue'),
          h('strong', { class: 'num' }, d.driveNext)) : null,
        String(d.notes || '').trim() ? h('p', { class: 'note' }, d.notes) : null
      ];
    }

    var copyBtn = null;
    if (lines.length) {
      copyBtn = h('button', {
        class: 'btn ghost block', type: 'button', style: 'margin-top:14px',
        onclick: async function () {
          var ta = h('textarea', { class: 'sr', readonly: true, value: G.daySheetText(s) });
          document.body.appendChild(ta);
          var ok = await copyText(G.daySheetText(s), ta);
          ta.remove();
          toast(ok ? 'Day sheet copied \u2014 paste it in the group chat' : 'Press and hold to copy');
        }
      }, icon('copy', 18), 'Copy day sheet');
    }

    return [nav,
      canWrite() ? h('div', { class: 'btnrow', style: 'margin-top:14px' },
        h('button', { class: 'btn quiet', type: 'button',
          onclick: function () { openDaySheetEditor(id, s.id); } },
          icon('edit', 18), lines.length ? 'Edit day sheet' : 'Fill in the day sheet')) : null,
      body, copyBtn];
  }

  function openDaySheetEditor(tourId, showId) {
    var t = getTour(tourId);
    var s = t && G.isObj(t.shows) && G.isObj(t.shows[showId]) ? t.shows[showId] : null;
    if (!s) return;
    var d0 = G.isObj(s.daySheet) ? s.daySheet : {};
    var f = {
      loadIn: d0.loadIn || '', vip: d0.vip || '', doors: d0.doors || '',
      lobbyCall: d0.lobbyCall || '', busCall: d0.busCall || '',
      wifi: d0.wifi || '', parking: d0.parking || '',
      driveNext: d0.driveNext || '', notes: d0.notes || '',
      soundchecks: (Array.isArray(d0.soundchecks) ? d0.soundchecks : []).map(function (r) {
        return { band: r.band || '', time: r.time || '' }; }),
      setTimes: (Array.isArray(d0.setTimes) ? d0.setTimes : []).map(function (r) {
        return { band: r.band || '', time: r.time || '' }; })
    };
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
        }
      };
      return [
        h('h2', { class: 'sh-title' }, 'Day sheet \u2014 ' + (s.city || 'Show')),
        h('p', { class: 'sh-sub' }, 'Everything the bus needs for the day. Leave anything blank and it just doesn\u2019t show.'),
        h('form', { class: 'sh-form', onsubmit: submit, novalidate: true },
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
      var reader = settlementReader({
        show: s,
        onResult: function (r) {
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
          syncMisc(); renderNotes(); refresh();
        }
      });
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
        rows.push(h('div', { class: 'row' },
          h('label', { class: 'row-label', for: 'inc-' + f.key }, f.label),
          moneyInput({
            id: 'inc-' + f.key, value: draft[f.key], label: f.label,
            nextId: f.key === 'misc' ? 'inc-misc-label'
              : (i < fields.length - 1 ? 'inc-' + fields[i + 1].key : null),
            last: i === fields.length - 1,
            onValue: function (v) { draft[f.key] = v; syncMisc(); refresh(); }
          })));
        if (f.key === 'misc') rows.push(miscRow);
      });
      syncMisc();

      var form = h('form', { class: 'sh-form', onsubmit: save, novalidate: true },
        reader ? h('div', { style: 'margin-bottom:14px' }, reader,
          h('p', { class: 'note', style: 'margin-top:6px' },
            'A photo or PDF of the promoter’s settlement — the numbers fill in for you to check.')) : null,
        h('div', { class: 'ledger' }, rows),
        notesHost,
        h('div', { class: 'preview' },
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
      venue: s ? s.venue || '' : ''
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
          patch[showId] = { date: f.date, city: city, venue: f.venue.trim() };
          if (await api.update(id, { shows: patch })) { closeSheet(); toast('Show saved'); render(true); }
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
      canWrite() ? addDailyForm(id) : null,
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
        kids.push(h('div', { class: 'row people-row' },
          h('span', { class: 'who' }, m.invited_email),
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
      var emailI = h('input', {
        class: 'input', type: 'email', placeholder: 'their@email.com',
        autocomplete: 'off', inputmode: 'email', 'aria-label': 'Email to invite'
      });
      form = h('form', {
        class: 'card addform', novalidate: true, style: 'margin-top:14px',
        onsubmit: async function (e) {
          e.preventDefault();
          var email = String(emailI.value || '').trim();
          if (email.indexOf('@') < 1) { toast('Type their email address'); emailI.focus(); return; }
          try {
            await B.invite(tourId, email, role);
            emailI.value = '';
            toast(email + ' is on the list — tell them to make an account with that email');
            refresh();
          } catch (e2) { toast('Couldn’t send that invite. Try again.'); }
        }
      },
        emailI,
        h('div', { style: 'display:flex;gap:10px;align-items:center;margin-top:10px' },
          segmented(['GA', 'ALL ACCESS'], 0, function (i) { role = i ? 'editor' : 'viewer'; },
            'Invite role'),
          h('button', { class: 'btn primary', type: 'submit', style: 'flex:1' }, 'Invite')));
    }

    return h('div', null,
      h('p', { class: 'sh-p' }, owns
        ? 'Invite your band, crew or managers by email. GA watches the numbers move live. ALL ACCESS can log shows, costs and statements with you.'
        : 'You’re on this tour’s guest list. The numbers update live as they’re logged.'),
      list, form,
      h('button', {
        class: 'linkbtn', type: 'button', style: 'margin-top:10px',
        onclick: function () { window.GR_BACKEND.signOut(); }
      }, 'Sign out of Greenroom'));
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

  function openTourMenu(id) {
    var t = getTour(id);
    if (!t) return;
    var name = t.name || 'this tour';
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, t.name || 'Tour options'),
        h('div', { class: 'stack' },
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openRename(id); } },
            icon('edit', 18), 'Name and artist'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openCrewSheet(id); } },
            icon('people', 18), 'Crew'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openImportsSheet(id); } },
            icon('history', 18), 'Imports'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openLabelsSheet(); } },
            icon('tag', 18), 'Learned labels'),
          isOwner() || S.mode === 'local' ? h('button', {
            class: 'btn danger block', type: 'button',
            onclick: function () {
              confirmSheet({
                title: 'Delete ' + name + '?',
                body: 'This removes its costs, debt, shows and income' +
                  (S.mode === 'db' ? ' for everyone it’s shared with.' : '.'),
                action: 'Delete tour', danger: true,
                onConfirm: async function () {
                  var ok = await api.remove(id);
                  if (ok) { delete S.lastNet[id]; delete S.lastState[id]; go({ name: 'home' }); toast('Tour deleted'); }
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
      class: o.cls || 'btn ghost', type: 'button', onclick: function () { input.click(); }
    }, o.icon ? icon(o.icon, 18) : null, o.label);
    return [btn, input];
  }

  function imageAccept() {
    return (S.imageTypes.length ? S.imageTypes : ['image/jpeg', 'image/png', 'image/webp']).join(',');
  }

  function busySheet(title, body, onStop) {
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, title),
        h('p', { class: 'sh-sub' }, body),
        h('div', { class: 'scanner', 'aria-hidden': 'true' },
          Array.from({ length: 22 }, function (_, i) { return h('i', { style: '--i:' + i }); })),
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
      '- merch: the artist’s merch money only if the sheet settles merch.',
      '- vip, buyouts, catering: only if the sheet shows them as money paid to the artist.',
      '',
      'Notes: short label/value pairs, only for things the sheet actually shows. Use these labels when present:',
      '- "Attendance" (e.g. "734 of 900"), "Pre-sale tickets", "Door sales", "Comps",',
      '- "Tax withheld" (amount, and what the artist walked with if shown),',
      '- "Back end" (whether the artist hit it, and the math if shown),',
      '- "Ticket price", "Gross box office", and anything else a touring artist would want flagged.',
      'Keep every value under a dozen words. If the sheet is unreadable, reply {"income":{},"notes":[]}.',
      isImage ? '' : '\nSettlement text:\n' + body
    ].join('\n');
  }

  /* Reads the promoter's settlement into the income sheet: numbers into the
     fields (still yours to check before saving), the night's story into notes. */
  function settlementReader(o) {
    if (!S.sample) return null;
    var reading = false;
    var control = fileControl({
      label: 'Read the settlement sheet', icon: 'card', cls: 'btn ghost block',
      accept: 'application/pdf,.pdf,' + imageAccept(), multiple: true,
      onFiles: async function (files) {
        if (reading) return;
        reading = true;
        var btn = control[0];
        var was = btn.textContent;
        btn.textContent = 'Reading the settlement…';
        btn.disabled = true;
        try {
          var pdfFile = files.filter(function (f) { return /pdf/i.test(f.type) || /\.pdf$/i.test(f.name); })[0];
          var images = files.filter(function (f) { return /^image\//i.test(f.type); });
          var out;
          if (pdfFile) {
            var got = await pdfToText(pdfFile);
            if (got.text.replace(/\s/g, '').length > 60) {
              out = await S.sample.json(settlementPrompt(got.text.slice(0, 40000), false, o.show), { cache: false });
            } else {
              var pages = await pdfToImages(got.doc, got.pages);
              out = await S.sample.json(settlementPrompt('', true, o.show), { images: pages, cache: false });
            }
          } else if (images.length) {
            out = await S.sample.json(settlementPrompt('', true, o.show), { images: images, cache: false });
          } else {
            toast('That file type isn’t supported — use a photo or a PDF.');
            return;
          }
          var r = G.normalizeSettlement(out);
          if (!r.found && !r.notes.length) {
            toast('Couldn’t read that sheet. Try a sharper photo.');
            return;
          }
          o.onResult(r);
          toast(r.found
            ? 'Filled in ' + plural(r.found, 'number') + ' — check them against the sheet, then save'
            : 'No dollar amounts found, but the notes came through');
        } catch (e) {
          var code = e && e.code;
          if (code === 'cancelled') return;
          if (SAMPLE_GONE.indexOf(code) >= 0) { S.sample = null; toast('Reading isn’t available right now.'); return; }
          toast(sampleErrorMessage(code, 'statement'));
        } finally {
          reading = false;
          btn.textContent = was;
          btn.disabled = false;
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
      '  a hotel, motel or other lodging is "hotels". Otherwise leave category null.',
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
          suggested: (cat === 'flights' || cat === 'hotels') && valid[cat] ? cat : null
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

  function openImportReview(tourId, rows, source) {
    var importId = newId();

    function counts() {
      var n = 0, total = 0;
      rows.forEach(function (r) { if (r.keep) { n += 1; total += G.num(r.amount); } });
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
          category: r.category, importId: importId, createdAt: Date.now() + i
        };
        total += G.num(r.amount);
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

        var sel = h('select', { class: 'input sm', 'aria-label': 'Category for ' + r.merchant,
          onchange: function (e) {
            r.category = e.target.value;
            r.source = r.category ? 'chosen' : null;
            var tagEl = $('.rv-flag', wrap);
            if (tagEl) tagEl.remove();
            refresh();
          } });
        sel.append(h('option', { value: '' }, 'Pick a category'));
        G.CHARGE_CATEGORIES.forEach(function (c) {
          sel.append(h('option', { value: c.key }, c.label));
        });
        sel.value = r.category || '';

        wrap.append(cb, h('div', { class: 'rv-fields' },
          h('div', { class: 'rv-head' },
            h('span', { class: 'rv-name' }, r.merchant),
            h('span', { class: 'amt num' }, G.moneyCents(r.amount))),
          h('div', { class: 'rv-sub' }, dayMD(r.date),
            r.source === 'learned' ? h('span', { class: 'rv-flag learned' }, 'Learned') : null,
            r.source === 'suggested' ? h('span', { class: 'rv-flag' }, 'Suggested') : null),
          sel));
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
      G.CHARGE_CATEGORIES.forEach(function (c) { catLabel[c.key] = c.label; });

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
            var sel = h('select', { class: 'input sm slim', 'aria-label': 'Category for ' + ch.merchant,
              onchange: async function (e) {
                var v = e.target.value;
                var patch = {}; patch[ch.id] = { category: v || null };
                if (await api.update(tourId, { charges: patch })) {
                  if (v) await writeLabel(ch.merchant, v);
                  toast('Saved'); render(true);
                }
              } });
            sel.append(h('option', { value: '' }, 'No category'));
            G.CHARGE_CATEGORIES.forEach(function (c) { sel.append(h('option', { value: c.key }, c.label)); });
            sel.value = ch.category || '';
            right = sel;
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
      var keys = Object.keys(S.labels).sort(function (a, b) {
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
            ? catLabel[cats[0]] || cats[0]
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
