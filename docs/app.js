/* Greenroom UI. Depends on core.js (globalThis.GR). */
(function () {
  'use strict';

  var G = globalThis.GR;
  var LS_DATA = 'greenroom:v1';
  var LS_LAST = 'greenroom:last';
  var LS_LABELS = 'greenroom:labels';
  // Each skin (the main app and Greenroom Classic) remembers its own choice.
  var LS_THEME = 'greenroom:theme' + (window.GR_SKIN ? ':' + window.GR_SKIN : '');
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
  /* A button that fires when the finger lifts, not on the click that would
     follow. On an iPhone, tapping a button while the keyboard is up closes
     the keyboard first; the page shifts under the finger and the click lands
     on nothing, so the button seems to need two taps. A tap (the finger
     didn't travel) fires once, at once; a mouse click still works. */
  function pressable(btn, fn) {
    var x0 = 0, y0 = 0, firedAt = 0;
    btn.addEventListener('touchstart', function (e) { var t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
    btn.addEventListener('touchend', function (e) {
      var t = e.changedTouches && e.changedTouches[0];
      if (!t || btn.disabled || Math.abs(t.clientX - x0) > 12 || Math.abs(t.clientY - y0) > 12) return;
      if (e.cancelable) e.preventDefault();
      firedAt = Date.now();
      fn(e);
    });
    btn.addEventListener('click', function (e) {
      if (Date.now() - firedAt < 800) { e.preventDefault(); return; }
      if (btn.disabled) return;
      fn(e);
    });
    return btn;
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
  // Fill an element with these pieces, skipping any that aren't there. (The
  // browser's own append / replaceChildren print the word "null" for those.)
  function fillEl(el, kids) {
    el.replaceChildren.apply(el, flatten([kids]).filter(function (x) { return x != null && x !== false; }));
    return el;
  }

  var ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
    /* the five tabs along the bottom */
    tabsheet: '<path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5"/><path d="M9 12h7M9 16h5"/>',
    tabmoney: '<path d="M12 3v18"/><path d="M16.5 7.5c0-1.7-2-2.5-4.5-2.5S7.5 5.8 7.5 7.5 9.5 10 12 10s4.5.8 4.5 2.5S14.5 15 12 15s-4.5-.8-4.5-2.5"/>',
    tabmap: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
    tabguest: '<circle cx="9" cy="8" r="3.4"/><path d="M3.5 20c.6-3.4 2.9-5.2 5.5-5.2s4.9 1.8 5.5 5.2"/><path d="M17 9h5M19.5 6.5v5"/>',
    tabcost: '<path d="M4 20V10M10 20V5M16 20v-7M22 20H2"/>',
    tabstats: '<path d="M8 4h8v5a4 4 0 0 1-8 0V4z"/><path d="M8 6H5.5a2.5 2.5 0 0 0 2.6 3.6M16 6h2.5a2.5 2.5 0 0 1-2.6 3.6M12 13v4M8.5 20.5h7M10 17h4"/>',
    tabchat: '<path d="M21 11.5c0 3.6-4 6.5-9 6.5-1.1 0-2.1-.13-3-.37L4 20l1.5-3.4C4.1 15.4 3 13.6 3 11.5 3 7.9 7 5 12 5s9 2.9 9 6.5z"/>',
    bell: '<path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16l-2-3z"/><path d="M10.5 21a2.2 2.2 0 0 0 3 0"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
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
    history: '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4"/><path d="M12 8v4.5l3 1.8"/>',
    check: '<path d="M4.5 12.5l5 5 10-11"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    deck: '<rect x="6.5" y="4" width="11" height="15" rx="2.2"/><path d="M4 7.5v10A2.5 2.5 0 0 0 6.5 20h8"/><path d="M9.5 9.5l1.6 1.6 3.2-3.4"/>',
    music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    up: '<path d="M12 19V5.5"/><path d="M6 11l6-6 6 6"/>',
    cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v.01M18 14.5v.01"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.4L4 8.5"/><path d="M4 3.5v5h5"/><path d="M4 13a8 8 0 0 0 14.6 4.4l1.4-1.9"/><path d="M20 20.5v-5h-5"/>'
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

  // AM or PM, two taps side by side. No dropdown: the phone's own picker
  // popped up wherever it liked inside a scrolling sheet.
  function ampmSwitch(value, onChange) {
    var wrap = h('div', { class: 'ampm', role: 'radiogroup', 'aria-label': 'AM or PM' });
    ['AM', 'PM'].forEach(function (v) {
      wrap.append(h('button', {
        type: 'button', class: 'ampm-b', role: 'radio', 'aria-checked': String(v === value),
        onclick: function () {
          Array.prototype.forEach.call(wrap.children, function (b) {
            b.setAttribute('aria-checked', String(b.textContent === v));
          });
          onChange(v);
        }
      }, v));
    });
    return wrap;
  }

  /* Every half hour, as a list to pick from; the time box stays typeable for
     anything in between. Runs from 6:00 AM around to 5:30 AM, the shape of a
     show day. */
  function openTimePicker(current, pick) {
    var times = [];
    for (var i = 0; i < 48; i++) {
      var mins = (6 * 60 + i * 30) % 1440, hr = Math.floor(mins / 60), mm = mins % 60;
      var a = hr < 12 ? 'AM' : 'PM', h12 = hr % 12 || 12;
      times.push({ main: h12 + ':' + (mm ? '30' : '00'), ampm: a });
    }
    var cur = String(current || '').replace(/\s+/g, '').toUpperCase();
    var grid = h('div', { class: 'tp-grid' }, times.map(function (x) {
      var label = x.main + ' ' + x.ampm;
      var on = cur === (x.main + x.ampm);
      return h('button', { class: 'tp-b' + (on ? ' on' : ''), type: 'button', onclick: function () { close(); pick(x.main, x.ampm); } }, label);
    }));
    var pop = h('div', { class: 'pop', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Pick a time' },
      h('div', { class: 'pop-card tp' },
        h('div', { class: 'tp-title' }, 'Pick a time'),
        grid,
        h('button', { class: 'btn ghost block', type: 'button', style: 'margin-top:12px', onclick: function () { close(); } }, 'Cancel')));
    function close() { pop.classList.remove('on'); setTimeout(function () { pop.remove(); }, 250); }
    pop.addEventListener('click', function (e) { if (e.target === pop) close(); });
    document.body.appendChild(pop);
    requestAnimationFrame(function () {
      pop.classList.add('on');
      var sel = grid.querySelector('.tp-b.on') || grid.children[24];
      if (sel) grid.scrollTop = sel.offsetTop - grid.clientHeight / 2 + sel.offsetHeight / 2;
    });
  }

  // Hold a row, then drag it into place, the way apps move on an iPhone.
  // A quick touch still types or taps as usual; moving before the hold lands
  // is a scroll. onDrop(from, to) gets the row's old and new spots.
  function holdToReorder(host, rowSel, onDrop) {
    var HOLD = 320, SLOP = 8;
    var st = null;
    function at(e) {
      var p = e.touches && e.touches.length ? e.touches[0] : e.changedTouches ? e.changedTouches[0] : e;
      return { x: p.clientX, y: p.clientY };
    }
    function start(e) {
      if (st || (e.type === 'mousedown' && e.button !== 0)) return;
      if (e.target.closest('button')) return;
      var row = e.target.closest(rowSel);
      if (!row || !host.contains(row) || host.querySelectorAll(rowSel).length < 2) return;
      var p = at(e);
      st = { row: row, x0: p.x, y0: p.y, lifted: false, mouse: e.type === 'mousedown' };
      st.timer = setTimeout(lift, HOLD);
      if (st.mouse) {
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', end);
      }
    }
    function lift() {
      if (!st) return;
      var rows = [].slice.call(host.querySelectorAll(rowSel));
      var tops = rows.map(function (r) { return r.getBoundingClientRect().top; });
      st.rows = rows;
      st.from = st.to = rows.indexOf(st.row);
      st.step = tops[1] - tops[0];
      st.lifted = true;
      blurActive();
      try { window.getSelection().removeAllRanges(); } catch (e) { /* nothing selected */ }
      host.classList.add('reordering');
      st.row.classList.add('lifted');
      if (navigator.vibrate) navigator.vibrate(12);
    }
    function move(e) {
      if (!st) return;
      var p = at(e);
      if (!st.lifted) {
        if (Math.abs(p.x - st.x0) > SLOP || Math.abs(p.y - st.y0) > SLOP) stop(false);
        return;
      }
      if (e.cancelable) e.preventDefault();
      var dy = p.y - st.y0, n = st.rows.length;
      var to = Math.max(0, Math.min(n - 1, st.from + Math.round(dy / st.step)));
      st.row.style.transform = 'translateY(' + dy + 'px) scale(1.03)';
      if (to === st.to) return;
      st.to = to;
      st.rows.forEach(function (r, i) {
        if (i === st.from) return;
        var off = st.from < to && i > st.from && i <= to ? -st.step
          : st.from > to && i >= to && i < st.from ? st.step : 0;
        r.style.transform = off ? 'translateY(' + off + 'px)' : '';
      });
    }
    function stop(drop) {
      var s = st;
      st = null;
      clearTimeout(s.timer);
      if (s.mouse) {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', end);
      }
      if (!s.lifted) return;
      host.classList.remove('reordering');
      s.rows.forEach(function (r) { r.style.transform = ''; r.classList.remove('lifted'); });
      if (drop && s.to !== s.from) onDrop(s.from, s.to);
    }
    function end(e) {
      if (!st) return;
      // After a drag, the lift of the finger is not a tap on whatever is under it.
      if (st.lifted && e.cancelable) e.preventDefault();
      stop(true);
    }
    host.addEventListener('touchstart', start, { passive: true });
    host.addEventListener('touchmove', move, { passive: false });
    host.addEventListener('touchend', end);
    host.addEventListener('touchcancel', function () { if (st) stop(false); });
    host.addEventListener('mousedown', start);
    host.addEventListener('contextmenu', function (e) { if (st) e.preventDefault(); });
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
    if (db) { store.db = db; S.mode = 'db'; subscribe(); subscribeLabels(); subscribeFeed(); }
    else { S.mode = 'local'; S.role = S.role || 'owner'; loadLocal(); loadLocalLabels(); dataArrived(); }
  }

  /* The card feed belongs to the tour manager who connected it. For everyone
     else S.feed stays null and they only ever see a Connect button on tours
     they run. */
  var feedSeen = false;
  function subscribeFeed() {
    var B = window.GR_BACKEND;
    if (!B || !B.feedWatch) return;
    B.feedWatch(function (f) {
      S.feed = f;
      if (S.loaded) render();
      // Opened fresh while Plaid's window was out: finish what was started.
      if (!feedSeen) { feedSeen = true; whenLoaded(function () { checkPlaid(false); }); }
    });
  }
  function whenLoaded(fn, tries) {
    if (S.loaded || (tries || 0) > 40) { fn(); return; }
    setTimeout(function () { whenLoaded(fn, (tries || 0) + 1); }, 150);
  }

  /* Merchant labels are remembered across every tour, and anyone with edit
     access adds to the same pile. */
  function subscribeLabels() {
    if (store.unsubLabels) { try { store.unsubLabels(); } catch (e) { /* already closed */ } }
    store.unsubLabels = store.db.collection('labels').onSnapshot(function (snap) {
      var m = {}, seen = seenMap();
      snap.docs.forEach(function (d) {
        if (!d.exists) return;
        var v = d.data();
        // When you last looked at something: yours alone, never a merchant label.
        if (G.isObj(v) && v.kind === 'seen') { if (G.num(v.at) >= seenShape(seen[d.id]).at) seen[d.id] = seenShape(v); return; }
        if (G.isObj(v) && (G.isObj(v.cats) || v.kind === 'crew' || v.kind === 'artistLogo' || v.kind === 'artist' || v.kind === 'profile')) m[d.id] = v;
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
    saveFailed('tour', e);
  }

  /* A save that couldn't go: say why plainly (most often it's the phone's
     connection, and the app has already tried again), and keep a note of it
     to look at later. */
  var NO_SIGNAL = 'No connection right now, so that didn\u2019t save. Try again when you have signal.';
  function saveFailed(place, e) {
    var B = window.GR_BACKEND;
    var offline = (e && (e.code === 'offline' || e.error === 'offline')) || (B && B.netTrouble && B.netTrouble());
    // Card calls keep their own note.
    if (B && B.noteError && !/^cards:/.test(place)) B.noteError(place, e);
    toast(offline ? NO_SIGNAL : 'Couldn\u2019t save that. Try again.');
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
    // On an artist account, home is that artist's page (see actingAs).
    if (route.name === 'home' && actingAs()) { S.fromMap = {}; route = actHome(); }
    // OVERVIEW always opens on today's show, not wherever you last flipped to.
    if (route.name === 'tour' && route.view === 'details') S.dsIndex = null;
    // The tour you were last in is the one the menu's tour rows open.
    if (route.name === 'tour' && route.id) rememberTour(route.id);
    // A page reached from the menu (or its Tours / Artists lists) goes back
    // there, however many tabs you visit inside it. Home wipes the slate.
    if (route.name === 'home') S.fromMap = {};
    var key = routeKey(route), prevKey = S.route ? routeKey(S.route) : '';
    if (key) {
      S.fromMap = S.fromMap || {};
      if (route.from) S.fromMap[key] = { back: route.from, label: route.fromLabel || 'Back' };
      // Reached afresh some other way: its back button goes where it always
      // did. Not arriving afresh: returning from a side trip (someone's
      // profile, a message) to the very page you left, and stepping back
      // from a tour to its artist.
      else if (key !== prevKey && !(S.route && S.route.back === route) &&
        !(route.name === 'artist' && S.route && S.route.name === 'tour')) delete S.fromMap[key];
    }
    // The menu slides in when you open it (the three lines), not when you step back to it.
    // Opened from your profile, its Budget drop-down starts closed; from a page under it, it stays as you left it.
    if (route.name === 'mainmenu' && route.fresh) {
      S.menuIn = true;
      if (S.route && S.route.name === 'home') { S.mnBudget = false; S.mnArtist = null; }
    }
    // Leaving your profile: how far down its tabs you were, for the way back.
    if (S.route && S.route.name === 'home' && route.name !== 'home') S.homeY = window.scrollY;
    var backToTabs = route === PF_HOME && S.homeY;
    S.route = route;
    S.xsAt = null; // the Expenses flow eases in afresh each time you arrive
    S.focusOnRender = !backToTabs;
    window.scrollTo(0, 0);
    render(true);
    // Back from a tour opened under your profile's tabs: the same spot in the list.
    if (backToTabs) window.scrollTo(0, S.homeY);
  }
  function clampStep(s) { return 2; } // one resume point: the shows
  // A tour's setup wizard counts as that tour: where you came from survives it.
  function routeKey(route) {
    return (route.name === 'tour' || route.name === 'wizard') && route.id ? 'tour:' + route.id
      : route.name === 'artist' && route.artist ? 'artist:' + route.artist : '';
  }
  function cameFrom(key) { return (S.fromMap && S.fromMap[key]) || null; }
  function lastTourKey() {
    var B = window.GR_BACKEND;
    return 'gr-last-tour:' + ((S.mode === 'db' && B && B.uid && B.uid()) || 'me');
  }
  // Kept on the phone, and in memory for phones that won't keep anything.
  function rememberTour(id) { S.lastTour = id; lsSet(lastTourKey(), id); }
  // view: which tab to land on; from / fromLabel: where its back button returns.
  function openTour(id, view, from, fromLabel, book) {
    var t = getTour(id);
    // Coming in from the menu or its lists is a fresh visit: today, not the day you last flipped to.
    if (from) { S.dsIndex = null; S.glTour = null; S.glShow = null; }
    // Its money pages open without its shows, so the book skips the setup detour.
    if (t && !t.setupDone && canEditTour(id) && !book) go({ name: 'wizard', id: id, step: clampStep(t.setupStep), from: from || null, fromLabel: fromLabel || null });
    else go({ name: 'tour', id: id, view: typeof view === 'string' ? view : 'menu', from: from || null, fromLabel: fromLabel || null });
  }
  // A hard close and reopen always lands on the Artists screen — the top of
  // the app, not wherever the last session wandered.
  function restoreLastTour() {}

  /* A tap is never pulled out from under a finger. Live updates redraw the
     whole screen, and a button swapped out mid-tap swallows the tap, so a
     redraw that lands while a finger is down waits until it lifts and the
     tap has gone through. */
  var fingerDown = 0, redrawAfterTouch = false;
  document.addEventListener('touchstart', function () { fingerDown = Date.now(); }, { passive: true, capture: true });
  var fingerUp = function () {
    fingerDown = 0;
    if (!redrawAfterTouch) return;
    redrawAfterTouch = false;
    // After the click the lifted finger makes (it can open something new).
    setTimeout(function () { render(); }, 250);
  };
  document.addEventListener('touchend', fingerUp, { passive: true, capture: true });
  document.addEventListener('touchcancel', fingerUp, { passive: true, capture: true });

  function render(force) {
    var view = $('#view');
    if (!view) return;
    if (fingerDown && Date.now() - fingerDown < 4000) { redrawAfterTouch = true; return; }
    var a = document.activeElement;
    var typing = !!(a && view.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'));
    if (!force && typing) { S.pendingRender = true; return; }
    S.pendingRender = false;
    var key = typing ? a.getAttribute('data-k') : null;
    var sel = null;
    if (key) { try { sel = [a.selectionStart, a.selectionEnd]; } catch (e) { sel = null; } }

    var node;
    if (S.loaded && S.route.name === 'act' && S.route.home) {
      // The artist you were on is gone (deleted on another phone): back to your own page.
      var gone = S.actCards && S.actCards[S.route.id];
      if (gone && gone.gone && S.actAs === S.route.id) setActingAs(null);
      if (!actingAs() || S.route.id !== actingAs()) S.route = PF_HOME;
    }
    if (S.loaded && S.route.name === 'home' && actingAs()) S.route = actHome();
    if (!S.loaded) node = viewLoading();
    else if (S.route.name === 'wizard') node = viewWizard();
    else if (S.route.name === 'tour') node = viewTour();
    else if (S.route.name === 'artist') node = viewArtist();
    else if (S.route.name === 'newartist') node = viewNewArtist();
    else if (S.route.name === 'profile') node = viewProfile();
    else if (S.route.name === 'dm') node = viewDm();
    else if (S.route.name === 'act') node = viewAct();
    else if (S.route.name === 'search') node = viewSearch();
    else if (S.route.name === 'mainmenu') node = viewMenu();
    else if (S.route.name === 'tours') node = viewAllTours();
    else if (S.route.name === 'artists') node = viewAllArtists();
    else if (S.route.name === 'book') node = viewBook();
    else if (S.route.name === 'merchroom') node = viewMerchroom();
    else node = viewHome();
    // The tab bar stays the same element when nothing about it changed, so a
    // tap on it always lands.
    var oldBar = view.querySelector('nav.tabbar');
    var newBar = node && node.querySelector ? node.querySelector('nav.tabbar') : null;
    if (oldBar && newBar && oldBar.getAttribute('data-sig') === newBar.getAttribute('data-sig')) newBar.replaceWith(oldBar);
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
    // MY PAY's own climbing graph (the Income side).
    var payChart = $('.pay-chart');
    if (payChart) drawChart(payChart);
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
      class: 'sheet' + (o.cls ? ' ' + o.cls : ''), role: 'dialog', 'aria-modal': 'true',
      'aria-label': o.label || 'Dialog', tabindex: '-1'
    });
    var content = flatten([build(panel)]).filter(Boolean);
    panel.append(h('button', {
      class: 'iconbtn sheet-x', type: 'button', 'aria-label': 'Close',
      onclick: function () { closeSheet(); }
    }, icon('close')));
    content.forEach(function (c) { panel.append(c); });
    pullToClose(panel);
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
  /* Pull a sheet down from the top to close it, like any phone sheet: when
     it's scrolled to its top (or the pull starts on its top edge), a
     downward drag carries it with the finger; far or fast enough and it
     closes, otherwise it springs back. Scrolling, sideways strips and
     fields are left alone. */
  function pullToClose(panel) {
    var y0 = null, dy = 0, t0 = 0, active = false;
    panel.addEventListener('touchstart', function (e) {
      y0 = null;
      if (e.touches.length !== 1) return;
      if (e.target.closest && e.target.closest('.rv-chips, input, select, textarea, .no-pull')) return;
      var fromTop = e.touches[0].clientY - panel.getBoundingClientRect().top < 56;
      if (panel.scrollTop > 0 && !fromTop) return;
      y0 = e.touches[0].clientY; dy = 0; t0 = Date.now(); active = false;
    }, { passive: true });
    panel.addEventListener('touchmove', function (e) {
      if (y0 == null) return;
      dy = e.touches[0].clientY - y0;
      if (!active) {
        if (dy < -4) { y0 = null; return; }        // heading up: it's a scroll
        if (dy < 8) return;
        if (panel.scrollTop > 0 && e.touches[0].clientY - panel.getBoundingClientRect().top >= 56) { y0 = null; return; }
        active = true;
        panel.style.transition = 'none';
      }
      if (e.cancelable) e.preventDefault();
      panel.style.transform = 'translateY(' + Math.max(0, dy) + 'px)';
    }, { passive: false });
    var end = function () {
      if (y0 == null) return;
      var flick = dy > 50 && Date.now() - t0 < 260;
      y0 = null;
      if (!active) return;
      active = false;
      panel.style.transition = '';
      panel.style.transform = '';
      if (dy > 110 || flick) closeSheet();
    };
    panel.addEventListener('touchend', end);
    panel.addEventListener('touchcancel', end);
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
    // So far: the line stops at today while the tour is on.
    var series = G.balanceSeries(tour, { until: G.tourToday() });
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
        'aria-label': 'Money in against what\u2019s spent and owed, from ' + dayLong(series[0].date) + ' to ' +
          dayLong(series[series.length - 1].date) + '. Now ' + money(series[series.length - 1].income) + ' in and ' +
          money(series[series.length - 1].spent) + ' spent and owed. ' +
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
    var H = 140, PAD = 14, PADX = 8; // PADX keeps the first and last markers whole

    // Two lines on one scale from zero: money in (the dots, only ever
    // climbing) and what's spent and owed (dashed, stepping up as costs come
    // in). Green between them while money in is ahead, red while spending is.
    var top = Math.max.apply(null, series.map(function (p) { return Math.max(p.income, p.spent); }).concat([1])) * 1.12;
    var y = function (v) { return PAD + (1 - v / top) * (H - PAD * 2); };
    var x = function (i) { return last < 1 ? PADX : PADX + (i / last) * (W - PADX * 2); };
    var pts = function (key) { return series.map(function (p, i) { return x(i).toFixed(1) + ' ' + y(p[key]).toFixed(1); }); };
    var inc = pts('income'), out = pts('spent');
    var lineOf = function (a) { return 'M' + a.join(' L'); };
    var edge = function (key, i) { return y(series[i][key]).toFixed(1); };
    // The region under a line, and the region over it (edge to edge).
    var under = function (a, key) { return 'M0 ' + edge(key, 0) + ' L' + a.join(' L') + ' L' + W + ' ' + edge(key, last) + ' L' + W + ' ' + H + ' L0 ' + H + ' Z'; };
    var over = function (a, key) { return 'M0 ' + edge(key, 0) + ' L' + a.join(' L') + ' L' + W + ' ' + edge(key, last) + ' L' + W + ' 0 L0 0 Z'; };

    var uid = 'gr' + (++chartSeq);
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'chart');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.setAttribute('aria-hidden', 'true');

    var head = series[last];
    var parts = [
      '<defs>',
      '<clipPath id="' + uid + '-overout"><path d="' + over(out, 'spent') + '"/></clipPath>',
      '<clipPath id="' + uid + '-overin"><path d="' + over(inc, 'income') + '"/></clipPath>',
      '</defs>',
      '<line class="zero" x1="' + PADX + '" y1="' + y(0).toFixed(1) + '" x2="' + (W - PADX) + '" y2="' + y(0).toFixed(1) + '"/>',
      '<path class="fill-pos" d="' + under(inc, 'income') + '" clip-path="url(#' + uid + '-overout)"/>',
      '<path class="fill-neg" d="' + under(out, 'spent') + '" clip-path="url(#' + uid + '-overin)"/>',
      '<path class="curve spent" d="' + lineOf(out) + '"/>',
      '<path class="curve inc" d="' + lineOf(inc) + '"/>'
    ];
    // A dot on every night money came in; the head is today.
    series.forEach(function (p, i) {
      if (i === last) return;
      if (!(i === 0 ? p.income > 0 : p.income > series[i - 1].income + 0.004)) return;
      parts.push('<circle class="night pos" cx="' + x(i).toFixed(1) + '" cy="' + y(p.income).toFixed(1) + '" r="4"/>');
    });
    parts.push('<circle class="spent-head" cx="' + x(last).toFixed(1) + '" cy="' + y(head.spent).toFixed(1) + '" r="3.5"/>');
    parts.push('<circle class="head ' + (head.income >= head.spent ? 'pos' : 'neg') + '" cx="' +
      x(last).toFixed(1) + '" cy="' + y(head.income).toFixed(1) + '" r="5.5"/>');
    parts.push('<line class="cursor" x1="0" y1="0" x2="0" y2="' + H + '"/>');
    parts.push('<circle class="dot2" cx="0" cy="0" r="4"/>');
    parts.push('<circle class="dot pos" cx="0" cy="0" r="5.5"/>');
    svg.innerHTML = parts.join('');

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
    parkBus(bus, x(last), y(head.income), head.income >= head.spent);

    wrap.replaceChildren(svg, pill, notes, pins, bus,
      h('div', { class: 'chart-ends' },
        h('span', null, dayMD(series[0].date)),
        h('span', { class: 'chart-key' },
          h('i', { class: 'k-in' }), 'Money in', h('i', { class: 'k-out' }), 'Spent & owed'),
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
    Array.prototype.forEach.call(svg.querySelectorAll('.curve:not(.spent)'), function (p) {
      var len = 0;
      try { len = p.getTotalLength(); } catch (e) { return; }
      if (!len) return;
      p.style.strokeDasharray = len + ' ' + len;
      p.style.strokeDashoffset = String(len);
      void p.getBoundingClientRect();
      p.style.transition = 'stroke-dashoffset .95s cubic-bezier(.22,.9,.18,1)';
      p.style.strokeDashoffset = '0';
    });
    Array.prototype.forEach.call(svg.querySelectorAll('.fill-pos, .fill-neg, .curve.spent'), function (f) {
      f.style.opacity = '0';
      f.style.transition = 'opacity .95s ease';
      requestAnimationFrame(function () { f.style.opacity = ''; });
    });
    Array.prototype.forEach.call(svg.querySelectorAll('.night, .head, .spent-head'), function (m, i) {
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
      var pay = $('.pay-chart');
      if (pay) drawChart(pay);
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
    var dot2 = geo.svg.querySelector('.dot2');
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
      var px = geo.x(i), py = geo.y(p.income);
      var gap = p.income - p.spent;
      var up = gap >= 0;

      cursor.setAttribute('x1', px); cursor.setAttribute('x2', px);
      dot.setAttribute('cx', px); dot.setAttribute('cy', py);
      dot.setAttribute('class', 'dot ' + (up ? 'pos' : 'neg'));
      if (dot2) { dot2.setAttribute('cx', px); dot2.setAttribute('cy', geo.y(p.spent)); }
      if (geo.bus) geo.parkBus(geo.bus, px, py, up);

      // The number: that day's money in less what was spent and owed by then.
      renderOdo(odo, money(gap, true), money(gap, true));
      setHeroState(hero, up ? 'green' : 'red');

      var night = geo.nights[p.date];
      // Under the number: money in and spent by that day, rolling like the number does.
      var tookText = money(p.income) + ' in \u00b7 ' + money(p.spent) + ' out';
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
        geo.parkBus(geo.bus, geo.x(geo.headI), geo.y(hp.income), hp.income >= hp.spent);
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

  /* After an invite: the splash, and behind it the app goes back to the
     Overview, where the crew list (asked for fresh) shows them as Pending
     until they make an account. */
  function afterInvite(tourId, who) {
    forgetCrew(tourId);
    inviteSplash(who);
    closeSheet(true);
    go({ name: 'tour', id: tourId, view: 'details' });
  }

  /* INVITE SENT: a moment on screen, a burst of confetti, then gone. */
  function inviteSplash(name) {
    var el = h('div', { class: 'splash-note', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'sn-card' },
        h('span', { class: 'sn-check' }, icon('check', 30)),
        h('div', { class: 'sn-big' }, 'INVITE SENT'),
        name ? h('div', { class: 'sn-sub' }, name) : null));
    document.body.appendChild(el);
    confetti();
    requestAnimationFrame(function () { el.classList.add('on'); });
    setTimeout(function () {
      el.classList.remove('on');
      setTimeout(function () { el.remove(); }, 350);
    }, reduced() ? 1200 : 1500);
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
    // A band's Off Tour book rides with the tours but is never one of them.
    entries = entries.filter(function (e) { return !isOffTour(e[1]); });
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
    if (S.mode === 'db' && !createdTour(id)) { toast('Only the tour\u2019s creator can delete it.'); return false; }
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

  /* ============================== Off Tour ==============================
     Each band's book of expenses between tours: a tour-shaped record
     (kind 'offtour') with the band's name and no shows, so the Expenses
     screens, the card feed and the money rules all work on it as they are.
     The owner runs it; ALL ACCESS on any of the band's tours can see it. */
  function isOffTour(t) { return !!(t && t.kind === 'offtour'); }
  function offTourOf(artist) {
    var key = String(artist || '').trim().toLowerCase(), hit = null;
    var look = function (t, id) { if (!hit && isOffTour(t) && !t.deletedAt && artistOf(t).toLowerCase() === key) hit = id; };
    S.tours.forEach(look);
    Object.keys(S.pending).forEach(function (id) { look(S.pending[id], id); });
    return hit;
  }
  function bandTours(artist) {
    return allTourEntries().filter(function (e) { return artistOf(e[1]) === artist; });
  }
  function ownsBand(artist) {
    if (S.mode !== 'db') return canWrite();
    return bandTours(artist).some(function (e) { return tourRole(e[0]) === 'owner'; });
  }
  // Only the owner and ALL ACCESS see OFF TOUR; GA never does.
  function canSeeOffTour(artist) {
    if (S.mode !== 'db') return true;
    if (offTourOf(artist)) return true;
    return bandTours(artist).some(function (e) { var r = tourRole(e[0]); return r === 'owner' || r === 'editor'; });
  }
  async function ensureOffTour(artist) {
    var id = offTourOf(artist);
    if (id || !ownsBand(artist) || S.offMaking) return id;
    S.offMaking = true;
    id = newId();
    var today = G.tourToday();
    // It logs card charges from the first of this month on.
    var ok = await api.create(id, { kind: 'offtour', artist: artist, name: 'Off Tour', setupDone: true,
      offFrom: today.slice(0, 8) + '01', createdAt: Date.now(), shows: {}, expenses: {}, charges: {} });
    S.offMaking = false;
    return ok ? id : null;
  }
  // The band's tours that haven't started yet, soonest first.
  function upcomingToursOf(artist, exceptId) {
    var today = G.tourToday();
    return bandTours(artist).filter(function (e) { return e[0] !== exceptId; })
      .map(function (e) { return { id: e[0], name: e[1].name || 'Tour', start: G.tourStart(e[1]) }; })
      .filter(function (x) { return x.start && x.start > today; })
      .sort(function (a, b) { return a.start.localeCompare(b.start); });
  }
  // The band's tour running today, if there is one.
  function currentTourOf(artist) {
    var today = G.tourToday(), hit = null;
    bandTours(artist).forEach(function (e) {
      var a = G.tourStart(e[1]), b = G.tourEnd(e[1]);
      if (!hit && a && b && a <= today && today <= b) hit = { id: e[0], name: e[1].name || 'Tour' };
    });
    return hit;
  }
  // The band's next tour: the soonest one that hasn't started yet.
  function nextTourOf(artist, exceptId) {
    var today = G.tourToday(), best = null;
    bandTours(artist).forEach(function (e) {
      if (e[0] === exceptId) return;
      var st = G.tourStart(e[1]);
      if (!st || st <= today) return;
      if (!best || st < best.start) best = { id: e[0], start: st, name: e[1].name || 'Next tour' };
    });
    return best;
  }

  function homePill() {
    if (S.role === 'viewer' || S.writeRefused) return 'View only';
    if (S.role === 'editor') return 'Editor';
    if (S.mode === 'local') return store.lsOk ? 'Saved on this device' : 'Changes won’t be kept';
    return null;
  }

  /* Swipe a card left and a delete button rides in under it. Vertical
     scrolling stays untouched; the gesture only engages sideways. */
  function swipeable(card, onDelete, label, opts) {
    var o = opts || {};
    var OPEN = -(o.open || 92);
    var behind = o.actions
      ? h('div', { class: 'swipe-acts' }, o.actions.map(function (a) {
          return h('button', { class: 'swipe-act' + (a.cls ? ' ' + a.cls : ''), type: 'button',
            'aria-label': a.text + ' ' + label, onclick: function () { a.onClick(); } }, a.text);
        }))
      : h('button', { class: 'swipe-del', type: 'button', 'aria-label': (o.text || 'Delete') + ' ' + label,
          onclick: function () { onDelete(); } }, o.text || 'Delete');
    var wrap = h('div', { class: 'swipe-wrap' + (o.cls ? ' ' + o.cls : '') }, behind, card);
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
  /* ============================== Profile ==============================
     MODEL6 SOCIAL, step one. The app opens on you: your photo, how many tours
     you've been on, followers and following, the roles you've held, a short
     bio, and under it every artist and tour you've been part of.
     The photo, roles and bio are kept with the account's own labels (the
     artist logos live there too), so they follow you to any phone and only
     you can read them. Followers and following have nothing behind them yet:
     they wait for the step where other people can see a profile. */
  var PROFILE_KEY = 'profile:me';
  var BIO_MAX = 150;
  function myCard() {
    var rec = S.labels[PROFILE_KEY];
    rec = G.isObj(rec) && rec.kind === 'profile' ? rec : {};
    return { bio: String(rec.bio || ''), photo: String(rec.photo || ''),
      handle: String(rec.handle || ''),
      // Artists you say you've toured with (the ones your tours show are added on top).
      artists: Array.isArray(rec.artists) ? rec.artists.map(String).filter(Boolean) : [],
      roles: Array.isArray(rec.roles) ? rec.roles.map(String).filter(Boolean) : null };
  }
  async function saveMyCard(patch) {
    var cur = myCard();
    var rec = Object.assign({ kind: 'profile', bio: cur.bio, photo: cur.photo, handle: cur.handle, artists: cur.artists,
      roles: cur.roles || myRoles() }, patch);
    rec.bio = String(rec.bio || '').trim().slice(0, BIO_MAX);
    var before = S.labels[PROFILE_KEY];
    S.labels[PROFILE_KEY] = rec;
    try {
      if (S.mode === 'db' && store.db) await store.db.doc('labels/' + PROFILE_KEY).set(rec);
      else saveLocalLabels();
      syncSocial();
      return true;
    } catch (e) {
      if (before) S.labels[PROFILE_KEY] = before; else delete S.labels[PROFILE_KEY];
      saveFailed('profile', e);
      return false;
    }
  }
  // The name on your profile: first and last from your contact card. Empty
  // when there's no account behind the app (phone-only mode), where the
  // header shows the Greenroom wordmark instead. (profileName(), further down, is
  // the name your chat messages carry, and is never empty.)
  function profileName() {
    var B = window.GR_BACKEND, me = S.mode === 'db' && B && B.myProfile ? B.myProfile() : null;
    return me ? ((me.firstName + ' ' + me.lastName).trim() || me.fullName || (B.username && B.username()) || '') : '';
  }
  // The roles you've picked; until you pick, the one on your contact card.
  function myRoles() {
    var card = myCard();
    if (card.roles) return card.roles;
    var B = window.GR_BACKEND, me = S.mode === 'db' && B && B.myProfile ? B.myProfile() : null;
    return me && me.tourRole ? [me.tourRole] : [];
  }
  function roleChoices() {
    var B = window.GR_BACKEND;
    return (B && B.tourRoles ? B.tourRoles : ['Artist', 'Band', 'Tour Manager', 'Production Manager', 'Stage Manager',
      'Merch', 'Guitar Tech', 'Drum Tech', 'Assistant', 'FOH Engineer', 'Monitors', 'Liaison', 'Dancer'])
      .filter(function (r) { return !NOT_CREW.test(r); });
  }
  /* A new profile photo is sized before it's kept: the picture sits behind a
     round window; drag it to move, pinch or slide to zoom, and what's inside
     the circle is what's saved (320 across, as a JPEG, so a photo weighs
     about as much as a logo). Closing the sheet keeps the old photo. */
  function readPhotoFile(file, cb, onCancel) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () { openPhotoCrop(img, url, cb, onCancel); };
    img.onerror = function () { URL.revokeObjectURL(url); toast('Couldn\u2019t read that picture \u2014 try a JPG or PNG'); };
    img.src = url;
  }
  function openPhotoCrop(img, url, cb, onCancel) {
    var iw = img.naturalWidth || img.width || 1, ih = img.naturalHeight || img.height || 1;
    var st = { s: 1, x: 0, y: 0 }, STAGE = 280, base = 1, done = false, MAX = 4;
    var pic = h('img', { class: 'pc-img', src: url, alt: '', draggable: 'false' });
    var stage = h('div', { class: 'pc-stage no-pull' }, pic, h('div', { class: 'pc-ring', 'aria-hidden': 'true' }));
    var zoom = h('input', { class: 'pc-zoom', type: 'range', min: '1', max: String(MAX), step: '0.01', value: '1',
      'aria-label': 'Zoom', oninput: function (e) { setScale(Number(e.target.value)); } });
    // The picture always covers the window: it can't be dragged off the edge.
    function apply() {
      var mx = Math.max(0, (iw * base * st.s - STAGE) / 2), my = Math.max(0, (ih * base * st.s - STAGE) / 2);
      st.x = Math.max(-mx, Math.min(mx, st.x)); st.y = Math.max(-my, Math.min(my, st.y));
      pic.style.width = (iw * base) + 'px'; pic.style.height = (ih * base) + 'px';
      pic.style.transform = 'translate(-50%, -50%) translate(' + st.x.toFixed(1) + 'px,' + st.y.toFixed(1) + 'px) scale(' + st.s.toFixed(3) + ')';
    }
    // Zooming holds the spot under the fingers (or the middle) where it is.
    function setScale(next, cx, cy) {
      next = Math.max(1, Math.min(MAX, next || 1));
      var k = next / st.s;
      cx = cx || 0; cy = cy || 0;
      st.x = cx - (cx - st.x) * k; st.y = cy - (cy - st.y) * k; st.s = next;
      zoom.value = String(next);
      apply();
    }
    function layout() { STAGE = stage.clientWidth || 280; base = STAGE / Math.min(iw, ih); apply(); }
    var pts = {}, lastDist = 0, lastMid = null;
    var at = function (e) { var r = stage.getBoundingClientRect(); return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }; };
    var two = function () {
      var k = Object.keys(pts);
      if (k.length < 2) return null;
      var a = pts[k[0]], b = pts[k[1]];
      return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };
    stage.addEventListener('pointerdown', function (e) {
      try { stage.setPointerCapture(e.pointerId); } catch (x) { /* fine without */ }
      pts[e.pointerId] = at(e);
      var t = two(); lastDist = t ? t.d : 0; lastMid = t;
    });
    stage.addEventListener('pointermove', function (e) {
      if (!pts[e.pointerId]) return;
      var was = pts[e.pointerId], now = at(e);
      pts[e.pointerId] = now;
      var t = two();
      if (t) {
        if (lastMid) { st.x += t.x - lastMid.x; st.y += t.y - lastMid.y; }
        if (lastDist > 0) setScale(st.s * t.d / lastDist, t.x, t.y); else apply();
        lastDist = t.d; lastMid = t;
      } else { st.x += now.x - was.x; st.y += now.y - was.y; apply(); }
    });
    var lift = function (e) { delete pts[e.pointerId]; var t = two(); lastDist = t ? t.d : 0; lastMid = t; };
    stage.addEventListener('pointerup', lift);
    stage.addEventListener('pointercancel', lift);
    stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = at(e);
      setScale(st.s * (e.deltaY < 0 ? 1.08 : 0.93), p.x, p.y);
    }, { passive: false });
    var use = function () {
      var SZ = 320, c = document.createElement('canvas');
      c.width = SZ; c.height = SZ;
      var ctx = c.getContext('2d'), disp = base * st.s, side = STAGE / disp;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, SZ, SZ);
      ctx.drawImage(img, iw / 2 - (STAGE / 2 + st.x) / disp, ih / 2 - (STAGE / 2 + st.y) / disp, side, side, 0, 0, SZ, SZ);
      done = true;
      cb(c.toDataURL('image/jpeg', 0.85));
    };
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title pe-title' }, 'Size your photo'),
        h('p', { class: 'sh-sub pc-sub' }, 'Drag to move it. Pinch, or use the slider, to zoom.'),
        stage,
        h('div', { class: 'pc-zoom-row' }, icon('minus', 16), zoom, icon('plus', 16)),
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary block', type: 'button', onclick: use }, 'Use photo'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel'))
      ];
    }, { label: 'Size your photo', cls: 'pc-sheet',
      // Closed without choosing: nothing changes, and you're back where you were.
      onClose: function () {
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        if (!done) { done = true; if (onCancel) setTimeout(onCancel, 0); }
      } });
    requestAnimationFrame(layout);
  }
  // The green check: Greenroom's own mark that an account is who it says.
  function verifiedBadge(cls) {
    var b = h('span', { class: 'pf-check' + (cls ? ' ' + cls : ''), role: 'img', 'aria-label': 'Verified' });
    b.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><g class="seal"><circle cx="12" cy="12" r="8.6"/>' +
      '<circle cx="20.30" cy="12.00" r="2.75"/><circle cx="18.71" cy="16.88" r="2.75"/><circle cx="14.56" cy="19.89" r="2.75"/><circle cx="9.44" cy="19.89" r="2.75"/><circle cx="5.29" cy="16.88" r="2.75"/><circle cx="3.70" cy="12.00" r="2.75"/><circle cx="5.29" cy="7.12" r="2.75"/><circle cx="9.44" cy="4.11" r="2.75"/><circle cx="14.56" cy="4.11" r="2.75"/><circle cx="18.71" cy="7.12" r="2.75"/></g><path class="tick" d="M8.1 12.3l2.7 2.7 5.1-5.6"/></svg>';
    return b;
  }
  function profilePhoto(cls, after) {
    var card = myCard(), name = profileName();
    return fileControl({
      label: card.photo ? null : (name.trim().charAt(0).toUpperCase() || '?'),
      logo: card.photo || undefined,
      cls: 'pf-photo ' + (cls || '') + (card.photo ? ' has' : ' letter'),
      accept: imageAccept(),
      ariaLabel: (card.photo ? 'Change' : 'Add') + ' your profile photo',
      onFiles: function (files) {
        readPhotoFile(files[0], async function (dataUrl) {
          if (await saveMyCard({ photo: dataUrl })) { toast('Photo in'); if (after) after(); else { closeSheet(); render(true); } }
        }, after);
      }
    });
  }
  function profileHead(tourCount) {
    var card = myCard(), roles = myRoles(), edit = canWrite() || S.mode === 'db';
    var stat = pfStat;
    var uid = socialOn() ? window.GR_BACKEND.uid() : null;
    var counts = myCounts();
    var unread = dmOn() ? dmUnread() : 0;
    var checked = !!(uid && cardOf(uid).card && cardOf(uid).card.verified);
    syncSocial();
    return h('section', { class: 'pf', 'aria-label': 'Your profile' },
      (function () {
        var own = uid ? cardOf(uid).card : null;
        var rs = own && G.isObj(own.roadStats) ? own.roadStats : null;
        var B2 = window.GR_BACKEND, mine = flowersOn() && B2.myFlowers ? B2.myFlowers() : null;
        var fans = h('p', { class: 'hist-fans' },
          h('button', { class: 'hf-btn', type: 'button', onclick: function () { if (uid) openFollowList(uid, 'followers'); } },
            plural(G.num(counts.followers), 'follower')),
          ' · ',
          h('button', { class: 'hf-btn', type: 'button', onclick: function () { if (uid) openFollowList(uid, 'following'); } },
            G.num(counts.following) + ' following'));
        return roadHead({
          name: (card.handle && profileName()) ? h('strong', { class: 'vp-name' }, h('span', { class: 'vp-name-t' }, profileName()),
            checked ? verifiedBadge() : null) : null,
          photo: h('div', { class: 'pf-photo-wrap' }, profilePhoto(),
            card.photo ? null : h('span', { class: 'pf-plus', 'aria-hidden': 'true' }, icon('plus', 14))),
          left: rs ? [stat(G.num(rs.tours), G.num(rs.tours) === 1 ? 'tour' : 'tours'), stat(G.num(rs.shows), G.num(rs.shows) === 1 ? 'show' : 'shows')]
            : [stat(tourCount, tourCount === 1 ? 'tour' : 'tours')],
          right: rs ? [stat(G.num(rs.countries), G.num(rs.countries) === 1 ? 'country' : 'countries'), stat(G.num(rs.cities), G.num(rs.cities) === 1 ? 'city' : 'cities')] : [],
          under: fans,
          flowers: mine && !mine.error && mine.counts ? flowerLine(mine.counts.flowers, mine.counts.endorsements) : null
        });
      })(),
      roles.length ? h('p', { class: 'pf-roles' }, roles.join(' \u00b7 '))
        : (edit ? h('button', { class: 'pf-roles pf-ask', type: 'button', onclick: function () { openProfileSheet(); } }, 'Add your roles on tour') : null),
      card.bio ? h('p', { class: 'pf-bio' }, card.bio)
        : (edit ? h('button', { class: 'pf-bio pf-ask', type: 'button', onclick: function () { openProfileSheet(); } }, 'Add a short bio') : null),
      // The same badge ladder the artists climb, on your own numbers.
      roadLine(uid && cardOf(uid).card ? cardOf(uid).card.roadStats : null),
      edit ? h('div', { class: 'pf-actions three' + (tasksBtn() ? ' four' : '') },
        // On a narrow phone with four buttons, Edit profile and View profile drop the word "profile".
        h('button', { class: 'pf-btn', type: 'button', onclick: function () { openProfileSheet(); } },
          h('span', { class: 'pf-btn-t' }, 'Edit', h('span', { class: 'pf-btn-x' }, ' profile'))),
        uid ? h('button', { class: 'pf-btn', type: 'button', onclick: function () { openViewerExperience(); } },
          h('span', { class: 'pf-btn-t' }, 'View', h('span', { class: 'pf-btn-x' }, ' profile'))) : null,
        dmOn() ? h('button', { class: 'pf-btn', type: 'button', onclick: function () { openInbox(); } }, h('span', { class: 'pf-btn-t' }, 'Messages'),
          unread ? h('span', { class: 'dm-dot num', 'aria-label': unread + ' unread' }, String(unread)) : null) : null,
        tasksBtn()) : null);
  }
  /* New tour tasks, for the managers of the tour your profile follows: a
     button beside Messages, glowing green while there are new tasks. */
  function tasksBtn() {
    var id = profileTourId();
    if (!id || !getTour(id) || !moneyLead(id)) return null;
    var st = taskState(id), n = st.tasks.length;
    var shown = st.glow && st.fresh ? st.fresh : n;
    return h('button', { class: 'pf-btn pf-tasks' + (st.glow ? ' on' : ''), type: 'button',
        'aria-label': 'New tour tasks' + (n ? ', ' + plural(n, 'task') + (st.fresh ? ', ' + st.fresh + ' new' : '') : ''),
        onclick: function () { openTaskDeck(id); } },
      h('span', { class: 'pf-btn-t' }, 'Tasks'), n ? h('span', { class: 'dm-dot num' + (st.glow ? '' : ' quiet') }, String(shown)) : null);
  }
  /* Edit profile, laid out like a social app's: the photo up top, then a
     row each for name, @username, role and bio, then the artists you've
     toured with. What's typed stays put while the sheet redraws (a new
     photo, a trip to the role list). */
  var HANDLE_OK = /^[a-z0-9._]{3,24}$/;
  function cleanHandle(v) { return String(v || '').trim().replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9._]/g, '').slice(0, 24); }
  // The artists your own tours show: these are on your profile already.
  function tourArtists() {
    var seen = {}, out = [];
    allTourEntries().forEach(function (e) {
      var a = artistOf(e[1]), k = String(a || '').trim().toLowerCase();
      if (k && !seen[k]) { seen[k] = true; out.push(a); }
    });
    return out;
  }
  function openProfileSheet(keep) {
    var B = window.GR_BACKEND;
    var card = myCard();
    var online = S.mode === 'db' && B && B.saveProfile && B.myProfile;
    var f = G.isObj(keep) && Array.isArray(keep.roles) ? keep
      : { name: profileName(), handle: card.handle, bio: card.bio, roles: myRoles().slice(), artists: card.artists.slice(), adding: '' };
    var redraw = function () { openProfileSheet(f); };
    openSheet(function () {
      var now = myCard();
      var count = h('span', { class: 'pe-count num' }, f.bio.length + ' / ' + BIO_MAX);
      var bio = h('textarea', { class: 'pe-in pe-bio', maxlength: BIO_MAX, rows: 2,
        placeholder: 'A line or two about you', value: f.bio,
        oninput: function (e) { f.bio = e.target.value; count.textContent = f.bio.length + ' / ' + BIO_MAX; } });
      // Username: checked against everyone else's as you type.
      var said = h('span', { class: 'pe-said' });
      var askTimer = 0, askSeq = 0;
      var check = function () {
        clearTimeout(askTimer);
        var v = f.handle;
        said.className = 'pe-said';
        if (!v) { said.textContent = ''; return; }
        if (!HANDLE_OK.test(v)) { said.textContent = '3 to 24 letters, numbers, dots or underscores'; said.classList.add('bad'); return; }
        if (v === now.handle) { said.textContent = 'This is yours'; said.classList.add('ok'); return; }
        if (!(S.mode === 'db' && B && B.handleFree)) { said.textContent = ''; return; }
        said.textContent = 'Checking\u2026';
        var seq = ++askSeq;
        askTimer = setTimeout(function () {
          B.handleFree(v).then(function (free) {
            if (seq !== askSeq) return;
            said.textContent = free ? '@' + v + ' is available' : '@' + v + ' is taken';
            said.classList.add(free ? 'ok' : 'bad');
          }).catch(function () { if (seq === askSeq) said.textContent = ''; });
        }, 350);
      };
      var handle = h('input', { class: 'pe-in', type: 'text', value: f.handle, maxlength: 24, placeholder: 'username',
        autocapitalize: 'none', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false',
        oninput: function (e) { var v = cleanHandle(e.target.value); if (v !== e.target.value) e.target.value = v; f.handle = v; check(); } });
      check();
      var row = function (label, control, extra) {
        return h('label', { class: 'pe-row' }, h('span', { class: 'pe-label' }, label),
          h('span', { class: 'pe-val' }, control, extra || null));
      };
      // Artists: the ones your tours show are fixed; the rest are yours to add.
      var fromTours = tourArtists(), fromKeys = fromTours.map(function (a) { return a.toLowerCase(); });
      var addArtist = function () {
        var v = String(f.adding || '').trim().replace(/\s+/g, ' ').slice(0, 60), k = v.toLowerCase();
        if (!v) return;
        if (fromKeys.indexOf(k) >= 0 || f.artists.some(function (a) { return a.toLowerCase() === k; })) { toast(v + ' is already on your list'); return; }
        if (f.artists.length >= 40) { toast('That\u2019s the most a profile can hold'); return; }
        f.artists.push(v); f.adding = ''; redraw();
      };
      return [
        h('h2', { class: 'sh-title pe-title' }, 'Edit profile'),
        h('div', { class: 'pe-photo' },
          profilePhoto('lg', redraw),
          h('div', { class: 'pe-photo-links' },
            fileControl({ label: now.photo ? 'Edit picture' : 'Add a picture', cls: 'pe-link', accept: imageAccept(),
              onFiles: function (files) {
                readPhotoFile(files[0], async function (dataUrl) { if (await saveMyCard({ photo: dataUrl })) { toast('Photo in'); redraw(); } }, redraw);
              } }),
            now.photo ? h('button', { class: 'pe-link quiet', type: 'button', onclick: async function () {
              if (await saveMyCard({ photo: '' })) { toast('Photo removed'); redraw(); }
            } }, 'Remove') : null)),
        h('form', { class: 'sh-form pe-form', novalidate: true,
          onsubmit: async function (e) {
            e.preventDefault();
            blurActive();
            var name = String(f.name || '').trim().replace(/\s+/g, ' ');
            if (online && !name) { toast('Type your name'); return; }
            if (f.handle && !HANDLE_OK.test(f.handle)) { toast('Usernames are 3 to 24 letters, numbers, dots or underscores'); return; }
            // The username first: it's the one thing someone else can beat you to.
            if (S.mode === 'db' && B && B.setHandle && f.handle !== now.handle) {
              try { await B.setHandle(f.handle); }
              catch (x) {
                if (x && x.code === 'taken') { toast('@' + f.handle + ' is taken. Try another.'); return; }
                if (x && x.code === 'shape') { toast('That username can\u2019t be used. Try another.'); return; }
                saveFailed('username', x); return;
              }
            }
            if (online && name !== profileName()) {
              var me = B.myProfile(), parts = name.split(' ');
              try {
                await B.saveProfile({ firstName: parts[0], lastName: parts.slice(1).join(' '), phone: me.phone, tourRole: me.tourRole });
                forgetCrew();
              } catch (x2) { saveFailed('name', x2); return; }
            }
            var order = roleChoices();
            var roles = f.roles.slice().sort(function (a, b) {
              var ia = order.indexOf(a), ib = order.indexOf(b);
              return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
            });
            if (await saveMyCard({ bio: f.bio, roles: roles, artists: f.artists.slice(), handle: f.handle })) {
              if (socialOn()) cardOf(B.uid(), true);
              closeSheet(); toast('Profile saved'); render(true);
            }
          } },
          h('div', { class: 'pe-rows' },
            online ? row('Name', h('input', { class: 'pe-in', type: 'text', value: f.name, maxlength: 60, placeholder: 'Your name',
              autocomplete: 'name', oninput: function (e) { f.name = e.target.value; } })) : null,
            (S.mode === 'db' && B && B.setHandle) ? row('Username', h('span', { class: 'pe-at' }, h('span', { 'aria-hidden': 'true' }, '@'), handle), said) : null,
            h('button', { class: 'pe-row tap', type: 'button', onclick: function () { openRolePick(f, redraw); } },
              h('span', { class: 'pe-label' }, 'Role'),
              h('span', { class: 'pe-val' + (f.roles.length ? '' : ' empty') }, f.roles.length ? f.roles.join(' \u00b7 ') : 'What you\u2019ve done on tour'),
              icon('chevron', 16)),
            row(h('span', null, 'Bio'), bio, count)),
          h('div', { class: 'pe-sec' },
            h('h3', { class: 'pe-h' }, 'Which artists have you toured with?'),
            h('div', { class: 'pe-artists' },
              fromTours.map(function (a) {
                return h('div', { class: 'pe-artist' }, h('span', { class: 'pe-artist-name' }, a), h('span', { class: 'pe-from' }, 'From your tours'));
              }),
              f.artists.map(function (a, i) {
                return h('div', { class: 'pe-artist' }, h('span', { class: 'pe-artist-name' }, a),
                  h('button', { class: 'pe-x', type: 'button', 'aria-label': 'Remove ' + a,
                    onclick: function () { f.artists.splice(i, 1); redraw(); } }, icon('close', 14)));
              })),
            h('div', { class: 'pe-add' },
              h('input', { class: 'pe-in', type: 'text', value: f.adding, maxlength: 60, placeholder: 'Artist name', autocapitalize: 'words',
                'aria-label': 'Add an artist you\u2019ve toured with',
                oninput: function (e) { f.adding = e.target.value; },
                onkeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); addArtist(); } } }),
              h('button', { class: 'add-pill', type: 'button', onclick: addArtist }, icon('plus', 16), 'Add your artist'))),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Save'),
            online ? h('button', { class: 'btn ghost block', type: 'button',
              onclick: function () { openUsernameSheet(false); } }, icon('people', 18), 'Phone and contact card') : null,
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel')))
      ];
    }, { label: 'Edit profile', cls: 'pe-sheet' });
  }
  // Role: tap every one you've had; Done takes you back to Edit profile.
  function openRolePick(f, back) {
    openSheet(function () {
      var list = roleChoices().concat(f.roles.filter(function (r) { return roleChoices().indexOf(r) < 0; }));
      return [
        h('h2', { class: 'sh-title' }, 'Role'),
        h('p', { class: 'sh-sub' }, 'Tap every role you\u2019ve had on tour.'),
        h('div', { class: 'pf-chips' }, list.map(function (r) {
          var on = f.roles.indexOf(r) >= 0;
          return h('button', { class: 'rv-chip pf-chip' + (on ? ' on' : ''), type: 'button', 'aria-pressed': on ? 'true' : 'false',
            onclick: function (e) {
              var i = f.roles.indexOf(r);
              if (i >= 0) f.roles.splice(i, 1); else f.roles.push(r);
              e.currentTarget.classList.toggle('on', i < 0);
              e.currentTarget.setAttribute('aria-pressed', i < 0 ? 'true' : 'false');
            } }, r);
        })),
        h('div', { class: 'stack', style: 'margin-top:18px' },
          h('button', { class: 'btn primary block', type: 'button', onclick: back }, 'Done'))
      ];
    }, { label: 'Role' });
  }

  /* ---- Step two: other people. ----
     Whoever you tour with can open your profile, and you theirs: photo,
     roles, bio, the counts, and the artists and tours they've been on. A tour
     there is only its name and dates; tap it and you get the dates and the
     flyer, nothing else of it, unless you're on that tour yourself, in which
     case it opens the way it always does for you. The database decides all
     of this; the app only shows what it's handed. */
  function socialOn() {
    var B = window.GR_BACKEND;
    return !!(S.mode === 'db' && B && B.profileCard && B.uid && B.uid());
  }
  // Devin's layout (2026-10-07, third reading): the name directly above the
  // photo, the photo in the centre, tours and shows stacked on its left,
  // countries and cities stacked on its right, followers and following
  // under the photo, flowers under that.
  function roadHead(o) {
    return h('div', { class: 'pf-top pf-center' },
      o.name ? h('div', { class: 'pc-name' }, o.name) : null,
      h('div', { class: 'pc-row' },
        h('div', { class: 'pf-stats pc-side pc-left' }, o.left),
        o.photo,
        h('div', { class: 'pf-stats pc-side pc-right' }, o.right)),
      o.under ? h('div', { class: 'pc-under' }, o.under) : null,
      o.flowers ? h('div', { class: 'pc-fl' }, o.flowers) : null);
  }
  function pfStat(n, label, onTap) {
    var inner = [h('strong', { class: 'pf-n num' }, String(n)), h('span', { class: 'pf-l' }, label)];
    return onTap ? h('button', { class: 'pf-stat tap', type: 'button', onclick: onTap }, inner)
      : h('div', { class: 'pf-stat' }, inner);
  }
  // Your photo, roles and bio, copied to your profile card whenever they
  // change, so the people you tour with see what you see.
  function syncSocial() {
    var B = window.GR_BACKEND;
    if (S.mode !== 'db' || !B || !B.pushSocial || !B.uid || !B.uid()) return;
    if (!G.isObj(S.labels[PROFILE_KEY])) return;
    var card = myCard(), roles = myRoles();
    var sig = [card.bio, roles.join(','), card.artists.join(','), card.photo.length, card.photo.slice(-32)].join('|');
    var key = 'gr-social:' + B.uid();
    if (S.socialSig === sig || (S.socialTry && Date.now() - S.socialTry < 60e3)) return;
    if (lsGet(key) === sig) { S.socialSig = sig; return; }
    S.socialTry = Date.now();
    B.pushSocial({ bio: card.bio, roles: roles, photo: card.photo, artists: card.artists })
      .then(function () { S.socialSig = sig; S.socialTry = 0; lsSet(key, sig); })
      .catch(function () { /* tried again in a minute */ });
  }
  // Profiles looked up this session: { card, at, asking, gone }.
  function cardOf(uid, fresh) {
    S.cards = S.cards || {};
    var c = S.cards[uid] || (S.cards[uid] = { card: null, at: 0, asking: false, gone: false });
    // Asked afresh while an older ask is out (it was just changed): that answer is stale, ask again.
    if (fresh && c.asking) c.again = true;
    // Flowers given, taken back or removed since this card came: it asks again.
    if (!c.asking && (fresh || Date.now() - c.at > 60e3 || (S.flowersAt && c.at < S.flowersAt))) {
      c.asking = true;
      window.GR_BACKEND.profileCard(uid).then(function (card) {
        c.asking = false;
        if (c.again) { c.again = false; cardOf(uid, true); return; }
        c.card = card; c.gone = !card; c.at = Date.now(); c.failed = false; render();
      }).catch(function () { c.asking = false; c.failed = true; c.at = Date.now(); if (c.again) { c.again = false; cardOf(uid, true); } render(); });
    }
    return c;
  }
  function myCounts() {
    if (!socialOn()) return { followers: 0, following: 0 };
    var c = cardOf(window.GR_BACKEND.uid()).card;
    return { followers: c ? G.num(c.followers) : 0, following: c ? G.num(c.following) : 0 };
  }
  function openProfile(uid) {
    if (!uid || !socialOn()) return;
    if (sheet) closeSheet(true);
    if (uid === window.GR_BACKEND.uid()) {
      if (actingAs()) { cardOf(uid, true); go({ name: 'profile', user: uid, preview: true, back: S.route }); }
      else go({ name: 'home' });
      return;
    }
    var back = S.route && S.route.name === 'profile' ? (S.route.back || { name: 'home' }) : S.route;
    go({ name: 'profile', user: uid, back: back });
  }
  /* View profile: your own profile exactly as other people get it (what
     Devin calls the viewer experience; the one you see yourself, with Edit
     profile on it, is the user's experience). Same screen as anyone else's,
     fed by the same database answer, with nothing added to say so; the
     buttons are there to look at, and a tour opens its public card. */
  function openViewerExperience() {
    var B = window.GR_BACKEND;
    if (!socialOn()) return;
    cardOf(B.uid(), true);
    go({ name: 'profile', user: B.uid(), preview: true, back: { name: 'home' } });
  }
  function personPhoto(p, cls) {
    var initial = String(p.name || '?').trim().charAt(0).toUpperCase() || '?';
    return h('span', { class: 'pf-photo ' + (cls || '') + (p.avatar ? ' has' : ' letter'), 'aria-hidden': 'true' },
      p.avatar ? h('img', { class: 'brand-logo', src: p.avatar, alt: '' }) : initial);
  }
  function personRoles(p) {
    var roles = Array.isArray(p.roles) ? p.roles.filter(Boolean) : [];
    return roles.length ? roles : (p.tourRole ? [p.tourRole] : []);
  }
  /* Someone else's profile, laid out the way a social app shows one: their
     username (and check) across the top, photo with name and counts beside
     it, roles and bio, then Following | Message | Contact, and two tabs,
     Artists and Tours, where a photo grid would be. */
  /* The header of the viewer experience (a person's page or an artist's, as
     anyone else gets it). Black, not green: this isn't your own page. One
     row, the way a social app heads a profile: the back arrow, then the
     username and its check right beside it; the GR mark keeps the far corner. */
  function viewerHead(title, checked, backTo) {
    return h('div', { class: 'headband dark vp-head' },
      h('header', { class: 'topbar vp-top' },
        h('h1', { class: 'band-name vp-user' }, h('span', { class: 'vp-user-t' }, title), checked ? verifiedBadge() : null),
        h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' })));
  }
  function viewProfile() {
    var uid = S.route.user, B = window.GR_BACKEND;
    var backTo = S.route.back || { name: 'home' };
    var c = socialOn() ? cardOf(uid) : { gone: true };
    var card = c.card;
    // Looking at your own page the way others get it.
    var preview = !!(S.route.preview && socialOn() && uid === B.uid());
    var justLooking = function (what) { return function () { toast(what); }; };
    var head = function (title, checked) { return viewerHead(title, checked, backTo); };
    if (!card) {
      return h('div', { class: 'page home profile has-tabs' }, head('Profile'),
        c.gone ? emptyState('This profile isn\u2019t available', 'You can see the profiles of people you\u2019ve toured with.')
          : c.failed ? emptyState('Couldn\u2019t load this profile', 'Check your signal and try again.')
          : h('p', { class: 'note', style: 'margin-top:24px' }, 'Loading\u2026'),
        socialBar(''));
    }
    var roles = personRoles(card);
    var tours = Array.isArray(card.tours) ? card.tours : [];
    var logos = G.isObj(card.logos) ? card.logos : {};
    var first = String(card.name || '').trim().split(/\s+/)[0] || 'They';
    // Artists in the order of their latest tour; then the ones they've added.
    var byArtist = new Map();
    tours.forEach(function (t) {
      var a = t.artist || 'Other tours';
      if (!byArtist.has(a)) byArtist.set(a, []);
      byArtist.get(a).push(t);
    });
    var said = (Array.isArray(card.artists) ? card.artists : []).filter(function (a) {
      var k = String(a).toLowerCase();
      return !Array.from(byArtist.keys()).some(function (b) { return String(b).toLowerCase() === k; });
    });
    var busy = false;
    var setFollow = async function (on) {
      if (busy || !!card.iFollow === on) return;
      busy = true;
      // Shown at once; put back if it didn't take.
      card.iFollow = on; card.followers = Math.max(0, G.num(card.followers) + (on ? 1 : -1));
      render(true);
      try {
        await (on ? B.follow(uid) : B.unfollow(uid));
        cardOf(uid, true); cardOf(B.uid(), true);
      } catch (e) {
        card.iFollow = !on; card.followers = Math.max(0, G.num(card.followers) + (on ? -1 : 1));
        saveFailed('follow', e); render(true);
      }
      busy = false;
    };
    var followBtn = preview ? h('button', { class: 'pf-btn go', type: 'button', onclick: justLooking('This is where people follow you.') }, 'Follow')
      : card.iFollow
      ? h('button', { class: 'pf-btn on', type: 'button', 'aria-label': 'Following ' + (card.name || '') + '. Tap to unfollow.',
          onclick: function () {
            confirmSheet({ title: 'Unfollow ' + (card.name || 'them') + '?', body: 'You can follow them again any time.',
              action: 'Unfollow', danger: true, onConfirm: function () { setFollow(false); return true; } });
          } }, 'Following', icon('chevron', 14))
      : h('button', { class: 'pf-btn go', type: 'button', onclick: function () { setFollow(true); } },
          card.followsMe ? 'Follow back' : 'Follow');
    var tab = (S.vpTab && S.vpTab.uid === uid && S.vpTab.tab) || 'artists';
    var pickTab = function (t) { S.vpTab = { uid: uid, tab: t }; render(true); };
    var tabBtn = function (key, label, ic) {
      return h('button', { class: 'vp-tab' + (tab === key ? ' on' : ''), type: 'button', role: 'tab',
        'aria-selected': tab === key ? 'true' : 'false', onclick: function () { if (tab !== key) pickTab(key); } },
        icon(ic, 20), h('span', null, label));
    };
    var acts = Array.isArray(card.acts) ? card.acts : [];
    var actNames = acts.map(function (a) { return String(a.name).trim().toLowerCase(); });
    var actRows = acts.map(function (a) {
      var n = (byArtist.get(Array.from(byArtist.keys()).filter(function (k) { return String(k).trim().toLowerCase() === String(a.name).trim().toLowerCase(); })[0]) || []).length;
      // On the artist's own account, its row on someone it lists carries Endorse
      // (unless they took its endorsement off before).
      // What this artist has confirmed for them (tour credits), if anything.
      var conf = (Array.isArray(card.credits) ? card.credits : []).filter(function (x) { return a.id && x.artistId === a.id && G.num(x.shows) > 0; })[0] || null;
      var canEndorse = !!(a.id && a.id === actingAs() && !a.endorsed && !a.past && !a.declined && B && B.endorse);
      var endorseBtn = canEndorse ? h('button', { class: 'am-endorse', type: 'button', onclick: function () {
        openEndorse(a.id, a.name, { userId: uid, name: card.name, kind: a.kind, role: a.role, endorsed: false },
          { after: function (gave) { if (gave) a.endorsed = true; } });
      } }, h('span', { 'aria-hidden': 'true' }, TROPHY), ' Endorse') : null;
      // An endorsement outlives the artist's page; one whose page is gone just shows.
      return h('li', canEndorse ? { class: 'pa-li' } : null, h(a.id ? 'button' : 'div', a.id ? { class: 'list-row art-row', type: 'button', onclick: function () { openAct(a.id); } }
          : { class: 'list-row art-row still' },
        h('span', { class: 'avatar' + (a.avatar ? ' has photo' : ' letter') },
          a.avatar ? h('img', { class: 'brand-logo', src: a.avatar, alt: '' }) : String(a.name).trim().charAt(0).toUpperCase()),
        h('span', { class: 'lr-text' },
          h('span', { class: 'lr-title' }, a.name),
          // The role the artist gave them leads; then what the artist confirmed.
          a.past ? h('span', { class: 'lr-sub' }, [a.role, a.kind === 'band' ? 'Former band member' : 'Former crew',
              conf ? tallyText(conf) + ' confirmed' : (n ? plural(n, 'tour') : '')].filter(Boolean).join(' \u00b7 '))
            : h('span', { class: 'lr-sub vp-vouch' }, a.role || (a.kind === 'band' ? 'Band member' : 'Crew'), verifiedBadge('sm'),
              conf ? ' \u00b7 ' + tallyText(conf) + ' confirmed' : (n ? ' \u00b7 ' + plural(n, 'tour') : ''))),
        // Endorsed by this artist: the trophy on the right, the word under it.
        a.endorsed ? h('span', { class: 'vp-endorsed', 'aria-label': 'Endorsed by ' + a.name },
          h('span', { class: 'vp-endorsed-t', 'aria-hidden': 'true' }, TROPHY), h('span', { class: 'vp-endorsed-l' }, 'Endorsed'))
          : canEndorse ? null : icon('chevron', 18)), endorseBtn);
    });
    var artistRows = actRows.concat(Array.from(byArtist, function (pair) {
      if (actNames.indexOf(String(pair[0]).trim().toLowerCase()) >= 0) return null;
      var logo = logos[String(pair[0]).trim().toLowerCase()] || '';
      return h('li', null, h('div', { class: 'list-row art-row still' },
        h('span', { class: 'avatar' + (logo ? ' has' : ' letter') },
          logo ? h('img', { class: 'brand-logo', src: logo, alt: '' }) : String(pair[0]).trim().charAt(0).toUpperCase()),
        h('span', { class: 'lr-text' },
          h('span', { class: 'lr-title' }, pair[0]),
          h('span', { class: 'lr-sub' }, plural(pair[1].length, 'tour')))));
    }).filter(Boolean)).concat(said.filter(function (a) { return actNames.indexOf(String(a).trim().toLowerCase()) < 0; }).map(function (a) {
      return h('li', null, h('div', { class: 'list-row art-row still' },
        h('span', { class: 'avatar letter' }, String(a).trim().charAt(0).toUpperCase()),
        h('span', { class: 'lr-text' }, h('span', { class: 'lr-title' }, a), h('span', { class: 'lr-sub' }, 'Toured with'))));
    }));
    // Every tour they've done: the ones on Greenroom, and the ones an artist
    // confirmed for them. The one they're out on right now leads, glowing.
    var tourRows = G.tourTimeline(tours, Array.isArray(card.creditTours) ? card.creditTours : [], G.tourToday()).map(function (r) {
      var t = r.tour;
      return timelineRow(r, r.own ? function () {
        if (!preview && t.mine && getTour(t.id)) openTour(t.id); else openTourCard(t.id, uid, t);
      } : (t.artistId ? function () { openAct(t.artistId); } : null), true);
    });
    var peer = { name: card.name, handle: card.handle, avatar: card.avatar, verified: card.verified };
    return h('div', { class: 'page home profile has-tabs' },
      head(card.handle || card.name || 'Profile', card.verified),
      h('section', { class: 'pf vp', 'aria-label': (card.name || 'Their') + ' profile' },
        (function () {
          var rs = G.isObj(card.roadStats) ? card.roadStats : null;
          return roadHead({
            name: (card.handle && card.name) ? h('strong', { class: 'vp-name' }, h('span', { class: 'vp-name-t' }, card.name),
              card.verified ? verifiedBadge() : null) : null,
            photo: h('div', { class: 'pf-photo-wrap' }, personPhoto(card)),
            left: rs ? [pfStat(G.num(rs.tours), G.num(rs.tours) === 1 ? 'tour' : 'tours', function () { pickTab('tours'); }),
                        pfStat(G.num(rs.shows), G.num(rs.shows) === 1 ? 'show' : 'shows')]
              : [pfStat(tours.length, tours.length === 1 ? 'tour' : 'tours', function () { pickTab('tours'); })],
            right: rs ? [pfStat(G.num(rs.countries), G.num(rs.countries) === 1 ? 'country' : 'countries'),
                         pfStat(G.num(rs.cities), G.num(rs.cities) === 1 ? 'city' : 'cities')] : [],
            under: h('p', { class: 'hist-fans' },
              h('button', { class: 'hf-btn', type: 'button', onclick: function () { openFollowList(uid, 'followers', card.name); } },
                plural(G.num(card.followers), 'follower')),
              ' · ',
              h('button', { class: 'hf-btn', type: 'button', onclick: function () { openFollowList(uid, 'following', card.name); } },
                G.num(card.following) + ' following')),
            flowers: flowerLine(card.flowers, card.endorsements)
          });
        })(),
        roles.length ? h('p', { class: 'pf-roles' }, roles.join(' \u00b7 ')) : null,
        card.bio ? h('p', { class: 'pf-bio' }, card.bio) : null,
        roadLine(card.roadStats),
        (card.followsMe && !preview) ? h('p', { class: 'pf-note' }, first + ' follows you') : null,
        h('div', { class: 'pf-actions three' },
          followBtn,
          h('button', { class: 'pf-btn', type: 'button',
            onclick: preview ? justLooking('This is where people message you.') : function () { openDm(uid, peer); } }, 'Message'),
          h('button', { class: 'pf-btn', type: 'button', onclick: function () { openContact(uid, card); } }, 'Contact'))),
      h('div', { class: 'vp-tabs three', role: 'tablist' }, tabBtn('artists', 'Artists', 'people'), tabBtn('tours', 'Tours', 'tabmap'),
        tabBtn('stats', 'Stats', 'tabstats')),
      tab === 'artists'
        ? (artistRows.length ? h('ul', { class: 'tour-list rows vp-list' }, artistRows)
            : emptyState('No artists yet', first + ' hasn\u2019t added any artists yet.'))
        : tab === 'stats' ? personFlowers(card)
        : (tourRows.length ? h('ul', { class: 'tour-list rows vp-list' }, tourRows)
            : emptyState('No tours yet', first + ' hasn\u2019t been on a tour in Greenroom yet.')),
      // Confirmed credits count nights from an artist's synced history: its source gets its line.
      Array.isArray(card.credits) && card.credits.length ? setlistCredit() : null,
      h('span', { class: 'logo-mark home-mark', 'aria-hidden': 'true' }),
      socialBar(''));
  }
  /* Someone's Stats tab: their three numbers, then every flower they've been
     given, newest first: who sent it, what for, the date, and the note. */
  function personFlowers(card) {
    var got = Array.isArray(card.gotFlowers) ? card.gotFlowers : [];
    return [
      h('section', { class: 'fw-me vp-fw' }, fwStats(card.flowers, { endorsements: card.endorsements, tours: (card.tours || []).length })),
      got.length ? h('ul', { class: 'fw-feed vp-fw-feed' }, got.map(function (g) {
        var who = String(g.name || '').trim();
        var face = personPhoto({ name: who || '?', avatar: g.avatar }, 'xs');
        return h('li', { class: 'fw-gift' },
          g.from ? h('button', { class: 'fw-gift-face', type: 'button', 'aria-label': 'Open ' + (who || 'their') + ' profile',
            onclick: function () { openProfile(g.from); } }, face) : face,
          h('div', { class: 'fw-gift-t' },
            h('p', { class: 'fw-gift-l' }, h('strong', null, who || 'Someone'), ' \u00b7 ' + plural(g.n, 'flower') + ' ',
              h('span', { 'aria-hidden': 'true' }, FLOWER), catTag(g.category)),
            g.note ? h('p', { class: 'fw-note' }, '\u201c' + g.note + '\u201d') : null,
            h('p', { class: 'fw-when' }, flowerDate(g.at))));
      })) : null
    ];
  }
  // The day flowers were given: "Oct 3", with the year when it isn't this one.
  function flowerDate(at) {
    var dt = new Date(at);
    if (isNaN(dt)) return '';
    var day = G.ymd(dt);
    return dayMD(day) + (day.slice(0, 4) !== G.ymd(new Date()).slice(0, 4) ? ', ' + day.slice(0, 4) : '');
  }
  // Contact: what's on their contact card, for the people they tour with.
  function openContact(uid, card) {
    var state = { info: null, failed: false };
    var draw = function () {
      openSheet(function () {
        var c = state.info, tel = c ? String(c.phone || '').replace(/[^0-9+]/g, '') : '';
        return [
          h('h2', { class: 'sh-title' }, 'Contact'),
          h('p', { class: 'sh-sub' }, card.name || ''),
          !c ? h('p', { class: 'note' }, state.failed ? 'Couldn\u2019t load their contact card. Check your signal and try again.' : 'Loading\u2026')
            : (!tel && !c.email) ? h('p', { class: 'note' }, 'No phone or email on their contact card yet.')
            : h('div', { class: 'ct-rows' },
                tel ? h('div', { class: 'ct-row' },
                  h('span', { class: 'ct-main' }, h('span', { class: 'ct-k' }, 'Phone'), h('span', { class: 'ct-v num' }, c.phone)),
                  h('a', { class: 'ct-act', href: 'tel:' + tel }, icon('phone', 17), 'Call'),
                  h('a', { class: 'ct-act', href: 'sms:' + tel }, icon('mail', 17), 'Text')) : null,
                c.email ? h('div', { class: 'ct-row' },
                  h('span', { class: 'ct-main' }, h('span', { class: 'ct-k' }, 'Email'), h('span', { class: 'ct-v' }, c.email)),
                  h('a', { class: 'ct-act', href: 'mailto:' + String(c.email).trim() }, icon('mail', 17), 'Email')) : null),
          h('div', { class: 'stack' },
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Close'))
        ];
      }, { label: 'Contact' });
    };
    draw();
    window.GR_BACKEND.contactOf(uid)
      .then(function (info) { state.info = info || { phone: '', email: '' }; if (sheet) draw(); })
      .catch(function () { state.failed = true; if (sheet) draw(); });
  }
  /* ---- Messages: one person to another. ----
     A conversation is its own screen: their name up top, the lines in
     bubbles (yours on the right, in green), the typing bar at the bottom.
     Your profile's Messages button lists every conversation, with a count
     of what you haven't read. New lines arrive on their own while the app
     is open; there's no phone notification for them yet. */
  function dmState() {
    return S.dm || (S.dm = { threads: null, at: 0, asking: false, open: {}, watching: false });
  }
  function dmOn() { var B = window.GR_BACKEND; return !!(socialOn() && B.dmThreads); }
  function loadThreads(fresh) {
    var d = dmState(), B = window.GR_BACKEND;
    if (!dmOn()) return d;
    if (!d.watching && B.dmWatch) {
      d.watching = true;
      // Something new came in: the list, and the conversation on screen.
      B.dmWatch(function () {
        loadThreads(true);
        if (S.route && S.route.name === 'dm') loadThread(S.route.user, true);
      });
    }
    if (!d.asking && (fresh || Date.now() - d.at > 60e3)) {
      d.asking = true;
      B.dmThreads().then(function (rows) { d.threads = rows; d.at = Date.now(); d.asking = false; render(); })
        .catch(function () { d.asking = false; d.at = Date.now(); });
    }
    return d;
  }
  function dmUnread() {
    var d = loadThreads();
    return (d.threads || []).reduce(function (n, t) { return n + G.num(t.unread); }, 0);
  }
  function loadThread(uid, fresh) {
    var d = dmState(), B = window.GR_BACKEND;
    var th = d.open[uid] || (d.open[uid] = { msgs: null, at: 0, asking: false, failed: false });
    if (!th.asking && (fresh || !th.at)) {
      th.asking = true;
      B.dmThread(uid).then(function (msgs) {
        var grew = !th.msgs || msgs.length !== th.msgs.length;
        th.msgs = msgs; th.at = Date.now(); th.asking = false; th.failed = false;
        // Being here is reading it.
        if (S.route && S.route.name === 'dm' && S.route.user === uid && msgs.some(function (m) { return !m.mine && !m.read; })) {
          B.dmRead(uid).then(function () { loadThreads(true); }).catch(function () { /* next visit */ });
        }
        if (grew) S.dmJump = true;
        render(true);
      }).catch(function () { th.asking = false; th.failed = true; th.at = Date.now(); render(true); });
    }
    return th;
  }
  function openDm(uid, peer) {
    if (!dmOn() || !uid) return;
    if (sheet) closeSheet(true);
    var back = S.route && S.route.name === 'dm' ? (S.route.back || { name: 'home' }) : S.route;
    dmState().open[uid] = { msgs: null, at: 0, asking: false, failed: false };
    S.dmJump = true;
    go({ name: 'dm', user: uid, peer: peer || {}, back: back });
  }
  function dmWhen(at) {
    var dt = new Date(at);
    if (isNaN(dt)) return '';
    var clock = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return G.ymd(dt) === G.ymd(new Date()) ? clock : dayMD(G.ymd(dt)) + ', ' + clock;
  }
  function viewDm() {
    var uid = S.route.user, B = window.GR_BACKEND, backTo = S.route.back || { name: 'home' };
    var peer = S.route.peer || {};
    var known = S.cards && S.cards[uid] && S.cards[uid].card;
    var name = peer.name || (known && known.name) || 'Message';
    var th = dmOn() ? loadThread(uid) : { msgs: [], failed: true };
    var msgs = th.msgs || [];
    var draftKey = 'dm:' + uid;
    var sendBtn = h('button', { class: 'chat-send', type: 'submit', 'aria-label': 'Send',
      disabled: !String(S.drafts[draftKey] || '').trim() }, icon('up', 17));
    var input = h('input', { class: 'chat-in', type: 'text', maxlength: 2000, 'data-k': 'dm-in',
      value: S.drafts[draftKey] || '', placeholder: 'Message', autocomplete: 'off', enterkeyhint: 'send', 'aria-label': 'Message ' + name,
      oninput: function (e) { S.drafts[draftKey] = e.target.value; sendBtn.disabled = !e.target.value.trim(); } });
    var send = async function (e) {
      e.preventDefault();
      var body = String(S.drafts[draftKey] || '').trim();
      if (!body || !th.msgs) return;
      // Up at once, greyed until it lands.
      var mine = { id: 'new' + Date.now(), mine: true, body: body, at: new Date().toISOString(), sending: true };
      th.msgs = th.msgs.concat([mine]);
      delete S.drafts[draftKey];
      S.dmJump = true;
      render(true);
      try {
        await B.dmSend(uid, body);
        mine.sending = false;
        loadThread(uid, true); loadThreads(true);
      } catch (x) {
        th.msgs = th.msgs.filter(function (m) { return m !== mine; });
        S.drafts[draftKey] = body;
        toast(B.netTrouble && B.netTrouble() ? 'No signal. Your message is still in the box.' : 'Couldn\u2019t send that. Try again.');
        if (B.noteError) B.noteError('message', x);
        render(true);
      }
    };
    var lastDay = '';
    var list = [];
    msgs.forEach(function (m, i) {
      var day = G.ymd(new Date(m.at));
      if (day !== lastDay) {
        lastDay = day;
        list.push(h('div', { class: 'dm-day' }, day === G.ymd(new Date()) ? 'Today' : dayLong(day)));
      }
      var last = i === msgs.length - 1;
      list.push(h('div', { class: 'dm-msg ' + (m.mine ? 'mine' : 'theirs') + (m.sending ? ' sending' : '') },
        h('div', { class: 'dm-b' }, m.body),
        last ? h('div', { class: 'dm-t' }, m.sending ? 'Sending\u2026' : dmWhen(m.at) + (m.mine && m.read ? ' \u00b7 Read' : '')) : null));
    });
    if (S.dmJump) {
      S.dmJump = false;
      requestAnimationFrame(function () { window.scrollTo(0, document.documentElement.scrollHeight); });
    }
    return h('div', { class: 'page home dm-page has-tabs' },
      h('div', { class: 'headband' },
        h('header', { class: 'topbar' },
          h('span', { class: 'top-side' }),
          h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
          h('span', { class: 'top-side right' })),
        h('div', { class: 'band-row' },
          h('button', { class: 'band-name dm-who', type: 'button', onclick: function () { openProfile(uid); } }, name))),
      !th.msgs ? h('p', { class: 'note', style: 'margin-top:24px' }, th.failed ? 'Couldn\u2019t load this conversation. Check your signal and try again.' : 'Loading\u2026')
        : list.length ? h('div', { class: 'dm-list' }, list)
        : h('p', { class: 'note dm-empty' }, 'No messages yet. Say hello.'),
      h('form', { class: 'chat-form dm-form', onsubmit: send, novalidate: true },
        h('div', { class: 'chat-field' }, input, sendBtn)),
      socialBar(''));
  }
  function openInbox() {
    var d = loadThreads(true);
    openSheet(function () {
      var rows = d.threads;
      return [
        h('h2', { class: 'sh-title' }, 'Messages'),
        !rows ? h('p', { class: 'note' }, 'Loading\u2026')
          : !rows.length ? h('p', { class: 'note' }, 'No messages yet. Open someone\u2019s profile and tap Message to start one.')
          : h('div', { class: 'fl-list' }, rows.map(function (t) {
              var unread = G.num(t.unread);
              return h('button', { class: 'fl-row dm-row' + (unread ? ' unread' : ''), type: 'button',
                onclick: function () { openDm(t.userId, { name: t.name, handle: t.handle, avatar: t.avatar, verified: t.verified }); } },
                personPhoto(t, 'xs'),
                h('span', { class: 'lr-text' },
                  h('span', { class: 'lr-title fl-name' }, t.name || 'Someone', t.verified ? verifiedBadge() : null),
                  h('span', { class: 'lr-sub' }, (t.fromMe ? 'You: ' : '') + (t.last || ''))),
                h('span', { class: 'dm-meta' }, h('span', { class: 'dm-at' }, dmWhen(t.at)),
                  unread ? h('span', { class: 'dm-dot num', 'aria-label': unread + ' unread' }, String(unread)) : null));
            })),
        h('div', { class: 'stack' },
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Close'))
      ];
    }, { label: 'Messages' });
    // The list may land after the sheet opens: draw it again when it does.
    if (!d.threads) {
      var tries = 0, wait = setInterval(function () {
        if (d.threads || ++tries > 20) { clearInterval(wait); if (d.threads && sheet) openInbox(); }
      }, 250);
    }
  }
  /* A tour from someone's profile: what's on the poster. Its name, the flyer
     if the tour has one, and the dates. Nothing else of the tour comes down. */
  function openTourCard(tourId, userId, t, artistId) {
    var state = { card: null, failed: false };
    var draw = function () {
      openSheet(function () {
        var c = state.card;
        var title = (c && c.name) || (t && t.name) || 'Tour';
        var artist = (c && c.artist) || (t && t.artist) || '';
        var dates = c && Array.isArray(c.dates) ? c.dates : [];
        return [
          h('h2', { class: 'sh-title' }, title),
          artist ? h('p', { class: 'sh-sub' }, artist) : null,
          !c ? h('p', { class: 'note' }, state.failed ? 'Couldn\u2019t load this tour. Check your signal and try again.' : 'Loading\u2026') : [
            c.flyer ? h('img', { class: 'tc-flyer', src: c.flyer, alt: title + ' flyer' }) : null,
            dates.length ? h('div', { class: 'tc-dates' }, dates.map(function (d) {
              var day = G.parseDay(d.date);
              return h('div', { class: 'tc-date' },
                h('span', { class: 'tc-day num' }, day ? F.md.format(day) : d.date),
                h('span', { class: 'tc-where' },
                  h('span', { class: 'tc-city' }, d.city || 'TBA'),
                  d.venue ? h('span', { class: 'tc-venue' }, d.venue) : null));
            })) : h('p', { class: 'note' }, 'No dates yet.')
          ],
          h('div', { class: 'stack' },
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Close'))
        ];
      }, { label: 'Tour', cls: 'tc-sheet' });
    };
    draw();
    (artistId ? window.GR_BACKEND.artistTourCard(artistId, tourId) : window.GR_BACKEND.tourCard(tourId, userId))
      .then(function (c) { state.card = c; state.failed = !c; if (sheet) draw(); })
      .catch(function () { state.failed = true; if (sheet) draw(); });
  }
  function openFollowList(uid, which, whose) {
    var B = window.GR_BACKEND, mine = uid === B.uid();
    var state = { rows: null, failed: false };
    var title = which === 'following' ? 'Following' : 'Followers';
    var draw = function () {
      openSheet(function () {
        var rows = state.rows;
        return [
          h('h2', { class: 'sh-title' }, title),
          !mine && whose ? h('p', { class: 'sh-sub' }, whose) : null,
          !rows ? h('p', { class: 'note' }, state.failed ? 'Couldn\u2019t load the list. Check your signal and try again.' : 'Loading\u2026')
            : !rows.length ? h('p', { class: 'note' }, which === 'following'
                ? (mine ? 'You\u2019re not following anyone yet. Open someone\u2019s profile from a tour\u2019s crew list to follow them.' : 'Not following anyone yet.')
                : (mine ? 'No followers yet.' : 'No followers yet.'))
            : h('div', { class: 'fl-list' }, rows.map(function (p) {
                var roles = personRoles(p);
                var inner = [personPhoto(p, 'xs'),
                  h('span', { class: 'lr-text' },
                    h('span', { class: 'lr-title fl-name' }, p.name || 'Someone', p.verified ? verifiedBadge() : null),
                    (p.handle || roles.length) ? h('span', { class: 'lr-sub' },
                      [p.handle ? '@' + p.handle : '', roles.join(' \u00b7 ')].filter(Boolean).join(' \u00b7 ')) : null)];
                return p.canOpen
                  ? h('button', { class: 'fl-row', type: 'button', onclick: function () { openProfile(p.userId); } }, inner, icon('chevron', 16))
                  : h('div', { class: 'fl-row' }, inner);
              })),
          h('div', { class: 'stack' },
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Close'))
        ];
      }, { label: title });
    };
    draw();
    B.followList(uid, which)
      .then(function (rows) { state.rows = rows || []; if (sheet) draw(); })
      .catch(function () { state.failed = true; if (sheet) draw(); });
  }
  /* The tour's flyer: kept when it's uploaded, so the people on the tour, and
     anyone looking at a tour-mate's profile, can see it. The tour manager and
     ALL ACCESS put it up or take it down. */
  function shrinkFlyer(file, cb) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var out = '', side = 1400, quality = 0.82;
      // Smaller until it fits what the store takes.
      for (var i = 0; i < 6; i++) {
        var r = Math.min(1, side / Math.max(img.width, img.height, 1));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * r)); c.height = Math.max(1, Math.round(img.height * r));
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        out = c.toDataURL('image/jpeg', quality);
        if (out.length <= 650000) break;
        side = Math.round(side * 0.8); quality = Math.max(0.6, quality - 0.06);
      }
      cb(out.length <= 650000 ? out : '');
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(''); };
    img.src = url;
  }
  function keepFlyer(tourId, file, quiet, after) {
    var B = window.GR_BACKEND;
    if (S.mode !== 'db' || !B || !B.saveFlyer || !leadsTour(tourId)) return;
    shrinkFlyer(file, async function (dataUrl) {
      if (!dataUrl) { if (!quiet) toast('Couldn\u2019t read that picture \u2014 try a JPG or PNG'); return; }
      try {
        await B.saveFlyer(tourId, dataUrl);
        S.flyers = S.flyers || {}; S.flyers[tourId] = dataUrl;
        if (!quiet) toast('Flyer saved');
        if (after) after();
      } catch (e) { if (!quiet) saveFailed('flyer', e); }
    });
  }
  function openFlyerSheet(tourId) {
    var B = window.GR_BACKEND, t = getTour(tourId), lead = leadsTour(tourId);
    S.flyers = S.flyers || {};
    var state = { image: S.flyers[tourId], failed: false };
    var draw = function () {
      openSheet(function () {
        var has = !!state.image;
        return [
          h('h2', { class: 'sh-title' }, 'Tour flyer'),
          h('p', { class: 'sh-sub' }, lead
            ? 'Everyone on the tour can see it here, and it shows on your profile when a tour-mate taps this tour.'
            : (t && t.name) || ''),
          state.image === undefined ? h('p', { class: 'note' }, state.failed ? 'Couldn\u2019t load the flyer.' : 'Loading\u2026')
            : has ? h('img', { class: 'tc-flyer', src: state.image, alt: 'Tour flyer' })
            : h('p', { class: 'note' }, lead ? 'No flyer yet.' : 'The tour manager hasn\u2019t added a flyer yet.'),
          h('div', { class: 'stack' },
            lead ? fileControl({ label: has ? 'Replace flyer' : 'Add flyer', icon: 'flyer', cls: 'btn primary block', accept: imageAccept(),
              onFiles: function (files) { keepFlyer(tourId, files[0], false, function () { state.image = S.flyers[tourId]; if (sheet) draw(); }); } }) : null,
            lead && has ? h('button', { class: 'btn ghost block', type: 'button', onclick: async function () {
              try { await B.saveFlyer(tourId, ''); S.flyers[tourId] = ''; state.image = ''; toast('Flyer removed'); draw(); }
              catch (e) { saveFailed('flyer', e); }
            } }, 'Remove flyer') : null,
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Close'))
        ];
      }, { label: 'Tour flyer', cls: 'tc-sheet' });
    };
    draw();
    if (state.image === undefined) {
      B.flyer(tourId).then(function (img) { S.flyers[tourId] = img || ''; state.image = img || ''; if (sheet) draw(); })
        .catch(function () { state.failed = true; if (sheet) draw(); });
    }
  }

  /* ---- Artist profiles. ----
     A band or act gets a profile of its own. The arrow beside your username
     lists the profiles you run (and the ones that list you), with Create
     Greenroom Artist at the bottom. Making one is three short steps: a name
     and username, then the band members, then the crew, each found by
     searching their account. The artist's page shows its photo, bio, band,
     crew and tours; only whoever made it can change it. */
  function accountTitle(who) {
    var card = myCard(), uid = socialOn() ? window.GR_BACKEND.uid() : null;
    var checked = !!(uid && cardOf(uid).card && cardOf(uid).card.verified);
    var can = !!(uid && window.GR_BACKEND.myArtists);
    var inner = [h('span', { class: 'vp-user-t' }, card.handle || who), checked ? verifiedBadge() : null,
      can ? h('span', { class: 'acct-arrow', 'aria-hidden': 'true' }, icon('chevron', 16)) : null];
    return can
      ? h('h1', { class: 'band-name vp-user mid' }, h('button', { class: 'acct-btn', type: 'button',
          'aria-label': 'Your profiles: ' + (card.handle || who), onclick: function () { openAccounts(); } }, inner))
      : h('h1', { class: 'band-name vp-user mid' }, inner);
  }
  /* Which of your accounts you're on: yourself, or an artist page you run.
     Switched from the arrow by the name at the top, the way a social app
     switches accounts, and kept on the phone, so the app opens where you
     left it. On an artist, its page is home (the photo at the bottom is its
     photo and takes you there), and your own page is like anyone else's to
     it: tapping your name opens the viewer experience. Switch back from the
     arrow by the artist's name. */
  function actingKey() { var B = window.GR_BACKEND; return 'gr-acting:' + ((B && B.uid && B.uid()) || 'me'); }
  function actingAs() {
    if (!socialOn()) return null;
    if (S.actAs === undefined) S.actAs = lsGet(actingKey()) || null;
    if (!S.actAs) return null;
    // A page that's gone, or isn't yours any more, puts you back on your own
    // account (judged on a settled list, not one being fetched again after a change).
    var a = myActs(), list = a.list;
    if (list && !a.asking && !list.some(function (x) { return x.id === S.actAs && x.mine; })) { setActingAs(null); return null; }
    return S.actAs;
  }
  function setActingAs(id) {
    S.actAs = id || null;
    lsSet(actingKey(), S.actAs || '');
  }
  function actHome() { return { name: 'act', id: S.actAs, manage: true, home: true }; }
  // The artist you're on, for the photo at the bottom: its page if loaded, else its row in your list.
  function actingCard() {
    var id = actingAs();
    if (!id) return null;
    var c = S.actCards && S.actCards[id] && S.actCards[id].card;
    var row = ((S.acts && S.acts.list) || []).filter(function (x) { return x.id === id; })[0];
    return c || row || { id: id, name: '', handle: '', avatar: '' };
  }
  function switchAccount(id) {
    if (sheet) closeSheet(true);
    setActingAs(id);
    if (id) actOf(id, true);
    go(id ? actHome() : PF_HOME);
  }
  function myActs(fresh) {
    var a = S.acts || (S.acts = { list: null, at: 0, asking: false });
    var B = window.GR_BACKEND;
    if (!socialOn() || !B.myArtists) return a;
    // Asked afresh while an older ask is out (an artist was just made or deleted): that answer is stale.
    if (fresh && a.asking) a.again = true;
    if (!a.asking && (fresh || Date.now() - a.at > 60e3)) {
      a.asking = true;
      B.myArtists().then(function (rows) {
        a.asking = false;
        if (a.again) { a.again = false; myActs(true); return; }
        a.list = rows; a.at = Date.now();
        if (a.onLoad) { var f = a.onLoad; a.onLoad = null; f(); }
        // The artist you're on isn't yours any more: redraw, which puts you back on your own account.
        if (S.actAs && !rows.some(function (x) { return x.id === S.actAs && x.mine; })) render();
      })
        .catch(function () { a.asking = false; a.at = Date.now(); if (a.again) { a.again = false; myActs(true); } });
    }
    return a;
  }
  function actOf(id, fresh) {
    S.actCards = S.actCards || {};
    var c = S.actCards[id] || (S.actCards[id] = { card: null, at: 0, asking: false, gone: false });
    if (fresh && c.asking) c.again = true;
    if (!c.asking && (fresh || Date.now() - c.at > 60e3)) {
      c.asking = true;
      window.GR_BACKEND.artistCard(id).then(function (card) {
        c.asking = false;
        if (c.again) { c.again = false; actOf(id, true); return; }
        c.card = card; c.gone = !card; c.at = Date.now(); c.failed = false; render();
      }).catch(function () { c.asking = false; c.failed = true; c.at = Date.now(); if (c.again) { c.again = false; actOf(id, true); } render(); });
    }
    return c;
  }
  /* An artist's page has the same two sides a person's does. Reached any
     ordinary way (search, someone's profile), it's the viewer experience,
     even for the account that runs it. Only the list under your own
     username opens it to be run: the photo, Edit artist, adding and
     removing band and crew. */
  // A username Greenroom made up for a page nobody had claimed ("mb." and
  // twenty characters): never shown as a name. A page that was claimed can
  // still carry one, when the act's own name wasn't free to use.
  function machineHandle(v) { return /^mb\.[0-9a-f]{20}$/.test(String(v || '')); }
  function openAct(id, manage) {
    if (!id || !socialOn()) return;
    if (sheet) closeSheet(true);
    var back = S.route && S.route.name === 'act' ? (S.route.back || { name: 'home' }) : S.route;
    go({ name: 'act', id: id, manage: !!manage, back: back });
  }
  // Artist names that already have something under them (tours you made, or
  // a folder of yours) and no artist profile yet: these can be claimed.
  function claimable() {
    var have = ((S.acts && S.acts.list) || []).map(function (x) { return String(x.name).trim().toLowerCase(); });
    var seen = {}, out = [];
    var add = function (name, tours) {
      var k = String(name || '').trim().toLowerCase();
      if (!k || have.indexOf(k) >= 0) return;
      if (!seen[k]) { seen[k] = { name: String(name).trim(), tours: 0 }; out.push(seen[k]); }
      seen[k].tours += tours;
    };
    allTourEntries().forEach(function (e) { if (S.mode !== 'db' || createdTour(e[0])) add(artistOf(e[1]), 1); });
    registeredArtists().forEach(function (a) { add(a, 0); });
    return out;
  }
  function openAccounts() {
    var a = myActs(), me = myCard(), who = profileName();
    // One sheet, opened once: the artists drop into it when they arrive.
    var box = h('div', { class: 'acct-acts' });
    var tail = h('div', { class: 'acct-tail' });
    var fill = function () {
      var list = a.list;
      var on = actingAs();
      box.replaceChildren.apply(box, !list ? [h('p', { class: 'note' }, 'Loading\u2026')] : list.map(function (x) {
        // An artist you run is an account to switch to; one that only lists you opens as anyone sees it.
        return h('button', { class: 'acct-row', type: 'button',
            onclick: function () { if (x.mine) switchAccount(x.id); else openAct(x.id); } },
          personPhoto(x, 'xs'),
          h('span', { class: 'lr-text' },
            h('span', { class: 'lr-title' }, machineHandle(x.handle) ? x.name : x.handle),
            h('span', { class: 'lr-sub' }, x.name + (x.mine ? '' : x.kind === 'band' ? ' \u00b7 Band member' : ' \u00b7 Crew'))),
          x.mine && on === x.id ? h('span', { class: 'acct-on', 'aria-label': 'You are here' }, icon('check', 14)) : icon('chevron', 16));
      }));
      var can = list ? claimable() : [];
      var waiting = claimQ().list;
      tail.replaceChildren.apply(tail, [
        // Only a Greenroom admin has this row.
        waiting ? h('button', { class: 'acct-row add', type: 'button', onclick: function () { openClaimQueue(); } },
          h('span', { class: 'acct-plus', 'aria-hidden': 'true' }, icon('check', 18)),
          h('span', { class: 'lr-text' },
            h('span', { class: 'lr-title' }, 'Page claims'),
            h('span', { class: 'lr-sub' }, waiting.length ? plural(waiting.length, 'claim') + ' waiting on you' : 'None waiting')),
          icon('chevron', 16)) : null,
        h('button', { class: 'acct-row add', type: 'button', onclick: function () { openCreateArtist(); } },
          h('span', { class: 'acct-plus', 'aria-hidden': 'true' }, icon('plus', 18)),
          h('span', { class: 'lr-text' }, h('span', { class: 'lr-title' }, 'Create Greenroom Artist'))),
        can.length ? h('button', { class: 'acct-row add', type: 'button', onclick: function () { openClaim(); } },
          h('span', { class: 'acct-plus', 'aria-hidden': 'true' }, icon('check', 18)),
          h('span', { class: 'lr-text' },
            h('span', { class: 'lr-title' }, 'Claim an artist'),
            h('span', { class: 'lr-sub' }, can.length === 1 ? can[0].name + ' already has ' + (can[0].tours ? plural(can[0].tours, 'tour') : 'a folder') + ' here'
              : plural(can.length, 'artist') + ' of yours already have tours here')),
          icon('chevron', 16)) : null
      ].filter(Boolean));
    };
    a.onLoad = function () { if (box.isConnected) fill(); };
    fill();
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title pe-title' }, 'Your profiles'),
        h('div', { class: 'acct-list' },
          h(actingAs() ? 'button' : 'div', { class: 'acct-row me', type: actingAs() ? 'button' : null,
              onclick: actingAs() ? function () { switchAccount(null); } : null },
            personPhoto({ name: who, avatar: me.photo }, 'xs'),
            h('span', { class: 'lr-text' },
              h('span', { class: 'lr-title' }, me.handle || who),
              me.handle ? h('span', { class: 'lr-sub' }, who) : null),
            actingAs() ? icon('chevron', 16) : h('span', { class: 'acct-on', 'aria-label': 'You are here' }, icon('check', 14))),
          box, tail)
      ];
    }, { label: 'Your profiles', cls: 'acct-sheet' });
  }
  /* Claim: an artist name that already has tours (or a folder) under it gets
     its profile. The name is kept exactly, so those tours show on it. */
  function openClaim() {
    var list = claimable();
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title ca-title' }, 'Claim an artist'),
        h('p', { class: 'sh-sub' }, 'These names already have tours of yours under them. Claiming one gives it a profile, with those tours on it.'),
        list.length ? h('div', { class: 'acct-list' }, list.map(function (x) {
          return h('div', { class: 'acct-row' },
            (function () {
              var logo = artistLogo(x.name);
              return h('span', { class: 'avatar' + (logo ? ' has' : ' letter') },
                logo ? h('img', { class: 'brand-logo', src: logo, alt: '' }) : x.name.charAt(0).toUpperCase());
            })(),
            h('span', { class: 'lr-text' },
              h('span', { class: 'lr-title' }, x.name),
              h('span', { class: 'lr-sub' }, x.tours ? plural(x.tours, 'tour') : 'No tours yet')),
            h('button', { class: 'am-add', type: 'button',
              onclick: function () { openCreateArtist({ name: x.name, claim: true, tours: x.tours, handle: '', handleOk: false, handleTyped: false, busy: false }); } }, 'Claim'));
        })) : h('p', { class: 'note' }, 'Nothing to claim: every artist you have tours under already has a profile.'),
        h('div', { class: 'stack' },
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Close'))
      ];
    }, { label: 'Claim an artist', cls: 'ca-sheet' });
  }
  // A username box that says whether the name is free as you type.
  function handleField(f, check, onState) {
    var mark = h('span', { class: 'ca-mark', 'aria-hidden': 'true' });
    var said = h('span', { class: 'pe-said' });
    var timer = 0, seq = 0;
    var set = function (state, text) {
      f.handleOk = state === 'ok';
      mark.className = 'ca-mark ' + state;
      mark.replaceChildren(state === 'ok' ? icon('check', 14) : state === 'bad' ? icon('close', 13) : '');
      said.className = 'pe-said' + (state === 'ok' ? ' ok' : state === 'bad' ? ' bad' : '');
      said.textContent = text || '';
      if (onState) onState();
    };
    var run = function () {
      clearTimeout(timer);
      var v = f.handle;
      if (!v) return set('', '');
      if (!HANDLE_OK.test(v)) return set('bad', '3 to 24 letters, numbers, dots or underscores');
      set('', 'Checking\u2026');
      var n = ++seq;
      timer = setTimeout(function () {
        check(v).then(function (free) { if (n === seq) set(free ? 'ok' : 'bad', free ? '@' + v + ' is available' : '@' + v + ' is taken'); })
          .catch(function () { if (n === seq) set('', ''); });
      }, 350);
    };
    var input = h('input', { class: 'ca-in', type: 'text', value: f.handle || '', maxlength: 24, placeholder: 'username',
      autocapitalize: 'none', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Username',
      oninput: function (e) { var v = cleanHandle(e.target.value); if (v !== e.target.value) e.target.value = v; f.handle = v; f.handleTyped = true; run(); } });
    return { input: input, mark: mark, said: said, run: run, set: function (v) { f.handle = v; input.value = v; run(); } };
  }
  function openCreateArtist(keep) {
    var B = window.GR_BACKEND;
    var f = G.isObj(keep) ? keep : { name: '', handle: '', handleOk: false, handleTyped: false, busy: false };
    openSheet(function () {
      var next = h('button', { class: 'btn primary block ca-next', type: 'submit' }, 'Next');
      var ready = function () { next.disabled = !(String(f.name).trim() && f.handleOk) || f.busy; };
      var hf = handleField(f, function (v) { return B.artistHandleFree(v, null); }, ready);
      var nameIn = h('input', { class: 'ca-in', type: 'text', value: f.name, maxlength: 60, placeholder: 'I See Stars',
        autocapitalize: 'words', autocomplete: 'off', 'aria-label': 'Artist name',
        oninput: function (e) {
          f.name = e.target.value;
          // Until you type a username yourself, it follows the name.
          if (!f.handleTyped) hf.set(cleanHandle(f.name.replace(/\s+/g, '')));
          ready();
        } });
      // A claim starts with a username made from the name it's claiming.
      if (f.claim && !f.handle && !f.handleTyped) hf.set(cleanHandle(String(f.name).replace(/\s+/g, '')));
      else if (f.handle) hf.run();
      ready();
      return [
        h('h2', { class: 'sh-title ca-title' }, f.claim ? 'Claim ' + f.name : 'Create a Greenroom Artist'),
        h('p', { class: 'sh-sub' }, f.claim
          ? 'Pick a username for ' + f.name + '. ' + (f.tours ? 'Its ' + plural(f.tours, 'tour') + ' will show on the profile. ' : '') + 'You can change the username at any time.'
          : 'Name the artist and pick a username. You can change both at any time. ' +
            'If the act already tours, find it in Search and claim its page instead: that one comes with its road history.'),
        h('form', { class: 'sh-form ca-form', novalidate: true,
          onsubmit: async function (e) {
            e.preventDefault();
            if (next.disabled) return;
            blurActive();
            f.busy = true; ready();
            try {
              var id = await B.createArtist({ name: String(f.name).trim(), handle: f.handle, avatar: '' });
              myActs(true);
              openAddMembers(id, 'band', { wizard: true, name: String(f.name).trim() });
            } catch (x) {
              f.busy = false; ready();
              if (x && x.code === 'taken') { toast('@' + f.handle + ' is taken. Try another.'); hf.run(); }
              else if (x && x.code === 'shape') toast('That username can\u2019t be used. Try another.');
              else saveFailed('artist', x);
            }
          } },
          f.claim ? h('div', { class: 'ca-field fixed' }, h('span', { class: 'ca-label' }, 'Artist name'),
              h('span', { class: 'ca-in' }, f.name))
            : h('label', { class: 'ca-field' }, h('span', { class: 'ca-label' }, 'Artist name'), nameIn),
          h('label', { class: 'ca-field' }, h('span', { class: 'ca-label' }, 'Username'),
            h('span', { class: 'ca-line' }, h('span', { class: 'ca-at', 'aria-hidden': 'true' }, '@'), hf.input, hf.mark)),
          hf.said,
          next)
      ];
    }, { label: 'Create a Greenroom Artist', cls: 'ca-sheet' });
  }
  /* Add band members, or crew: search for an account, tap Add. In the
     set-up it's a step with Next; from the artist's page it's just Done. */
  function openAddMembers(artistId, kind, o) {
    o = o || {};
    var B = window.GR_BACKEND, band = kind === 'band';
    var known = S.actCards && S.actCards[artistId] && S.actCards[artistId].card;
    var on = {};
    ((known && known.members) || []).forEach(function (m) { on[m.userId] = m.kind; });
    var results = h('div', { class: 'am-results' });
    var timer = 0, seq = 0, last = [];
    var row = function (p) {
      var roles = personRoles(p);
      var has = on[p.userId];
      var btn = h('button', { class: 'am-add' + (has ? ' on' : ''), type: 'button' }, has === kind ? 'Added' : has ? (has === 'band' ? 'In the band' : 'On the crew') : 'Add');
      btn.onclick = async function () {
        btn.disabled = true;
        try {
          if (on[p.userId] === kind) { await B.removeArtistMember(artistId, p.userId); delete on[p.userId]; }
          else { await B.addArtistMember(artistId, p.userId, kind); on[p.userId] = kind; }
          actOf(artistId, true);
          paint();
        } catch (x) { btn.disabled = false; saveFailed('member', x); }
      };
      return h('div', { class: 'fl-row am-row' }, personPhoto(p, 'xs'),
        h('span', { class: 'lr-text' },
          h('span', { class: 'lr-title fl-name' }, p.name || 'Someone', p.verified ? verifiedBadge() : null),
          (p.handle || roles.length) ? h('span', { class: 'lr-sub' },
            [p.handle ? '@' + p.handle : '', roles.join(' \u00b7 ')].filter(Boolean).join(' \u00b7 ')) : null),
        btn);
    };
    var paint = function (note) {
      results.replaceChildren.apply(results, note ? [h('p', { class: 'note' }, note)] : last.map(row));
    };
    var search = function (v) {
      clearTimeout(timer);
      v = String(v || '').trim();
      if (v.replace(/^@/, '').length < 2) { last = []; paint('Type a name or an @username.'); return; }
      var n = ++seq;
      timer = setTimeout(function () {
        B.findPeople(v).then(function (rows) {
          if (n !== seq) return;
          last = rows;
          paint(rows.length ? null : 'Nobody found. They need a Greenroom account, and a username makes them easy to find.');
        }).catch(function () { if (n === seq) paint('Couldn\u2019t search. Check your signal and try again.'); });
      }, 300);
    };
    var done = function () {
      if (o.wizard && band) { openAddMembers(artistId, 'crew', o); return; }
      closeSheet();
      if (o.wizard) { toast((o.name || 'Artist') + ' is on Greenroom'); myActs(true); switchAccount(artistId); } else render(true);
    };
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title ca-title' }, band ? 'Add band members' : 'Add crew members'),
        h('p', { class: 'sh-sub' }, (band ? 'Who\u2019s in the band?' : 'Who\u2019s on the crew?') + ' Search for their Greenroom account.'),
        h('div', { class: 'rv-find am-find' }, icon('search', 17),
          h('input', { class: 'input rv-search', type: 'search', placeholder: 'Search name or @username', autocomplete: 'off',
            autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Search accounts',
            oninput: function (e) { search(e.target.value); } })),
        results,
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary block', type: 'button', onclick: done }, o.wizard ? (band ? 'Next' : 'Done') : 'Done'))
      ];
    }, { label: band ? 'Add band members' : 'Add crew members', cls: 'ca-sheet am-sheet' });
    paint('Type a name or an @username.');
  }
  function viewAct() {
    var id = S.route.id, B = window.GR_BACKEND, backTo = S.route.back || { name: 'home' };
    var c = socialOn() ? actOf(id) : { gone: true };
    var card = c.card;
    // Opened from your own list, and yours: the page you run. Any other way in: the viewer's.
    var manage = !!(S.route.manage && card && card.mine);
    // The synced road story, when the page has one.
    var hc0 = histOf(id);
    var hsum = hc0.row && G.isObj(hc0.row.summary) ? hc0.row.summary : null;
    // A history Greenroom reads by itself moves while someone is looking.
    if (card && histBusy(hc0.row)) histPoll(id);
    var head = function (title) {
      if (!(S.route.manage && (!card || card.mine))) return viewerHead(title, false, backTo);
      // The same green head as your own page (Devin, 2026-10-08: "it should be
      // the exact same"): + on the left, the mark, the menu, then the
      // username with its check and the switcher arrow.
      return h('div', { class: 'headband' },
        h('header', { class: 'topbar' },
          h('span', { class: 'top-side' },
            canWrite() ? h('button', { class: 'iconbtn pf-add', type: 'button', 'aria-label': 'Add an artist or a tour',
              onclick: function () { go({ name: 'newartist' }); } }, icon('plus', 24)) : null),
          h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
          h('span', { class: 'top-side right' }, menuBtn())),
        h('div', { class: 'band-row' }, h('h1', { class: 'band-name vp-user mid' },
          h('button', { class: 'acct-btn', type: 'button', 'aria-label': 'Your profiles: ' + title, onclick: function () { openAccounts(); } },
            h('span', { class: 'vp-user-t' }, title), card && card.verified ? verifiedBadge() : null,
            h('span', { class: 'acct-arrow', 'aria-hidden': 'true' }, icon('chevron', 16))))));
    };
    if (!card) {
      return h('div', { class: 'page home profile has-tabs' }, head('Artist'),
        c.gone ? emptyState('This artist isn\u2019t on Greenroom', 'The profile may have been removed.')
          : c.failed ? h('div', { class: 'fw-fail' }, emptyState('Couldn\u2019t load this artist', 'Check your signal and try again.'),
              h('button', { class: 'btn ghost', type: 'button', onclick: function () { actOf(id, true); render(true); } }, 'Try again'))
          : h('p', { class: 'note', style: 'margin-top:24px' }, 'Loading\u2026'),
        socialBar(''));
    }
    var members = Array.isArray(card.members) ? card.members : [];
    var bandList = members.filter(function (m) { return m.kind === 'band'; });
    var crewList = members.filter(function (m) { return m.kind === 'crew'; });
    var tours = Array.isArray(card.tours) ? card.tours : [];
    // A page nobody runs yet: no band or crew to show, so it opens on its tours.
    var unclaimed = !!card.unclaimed;
    var tab = (S.actTab && S.actTab.id === id && S.actTab.tab) || (unclaimed ? 'tours' : 'band');
    var pickTab = function (t) { S.actTab = { id: id, tab: t }; render(true); };
    var tabBtn = function (key, label, ic) {
      return h('button', { class: 'vp-tab' + (tab === key ? ' on' : ''), type: 'button', role: 'tab',
        'aria-selected': tab === key ? 'true' : 'false', onclick: function () { if (tab !== key) pickTab(key); } },
        icon(ic, 20), h('span', null, label));
    };
    var photo = manage ? fileControl({
      label: card.avatar ? null : (String(card.name).trim().charAt(0).toUpperCase() || '?'), logo: card.avatar || undefined,
      cls: 'pf-photo' + (card.avatar ? ' has' : ' letter'), accept: imageAccept(),
      ariaLabel: (card.avatar ? 'Change' : 'Add') + ' the photo for ' + card.name,
      onFiles: function (files) {
        readPhotoFile(files[0], async function (dataUrl) {
          try { await B.saveArtist(id, { avatar: dataUrl }); card.avatar = dataUrl; myActs(true); toast('Photo in'); closeSheet(); render(true); }
          catch (x) { saveFailed('artist photo', x); }
        });
      }
    }) : personPhoto(card);
    var memberRow = function (m) {
      // The title this artist gave them leads; without one, their own roles.
      var roles = m.role ? [m.role] : personRoles(m);
      var inner = [personPhoto(m, 'xs'),
        h('span', { class: 'lr-text' },
          h('span', { class: 'lr-title fl-name' }, m.name || 'Someone', m.verified ? verifiedBadge() : null),
          (m.handle || roles.length) ? h('span', { class: 'lr-sub' },
            [m.handle ? '@' + m.handle : '', roles.join(' \u00b7 ')].filter(Boolean).join(' \u00b7 ')) : null)];
      // The trophy: the artist's word that this person really worked for them. For good.
      // On the page you run it's a button either way: Endorse asks their role
      // first, and Endorsed (or Role) opens the role to change it.
      var trophy = m.endorsed
        ? (manage && m.userId && B && B.setMemberRole
            ? h('button', { class: 'am-endorsed am-tap', type: 'button', 'aria-label': (m.name || 'Their') + ' is endorsed. Change their role.',
                onclick: function () { openEndorse(id, card.name, m); } }, h('span', { 'aria-hidden': 'true' }, TROPHY), ' Endorsed')
            : h('span', { class: 'am-endorsed', 'aria-label': 'Endorsed by ' + card.name }, h('span', { 'aria-hidden': 'true' }, TROPHY), ' Endorsed'))
        : manage && m.userId && B && B.endorse
          ? (m.declined
              ? h('button', { class: 'am-endorse', type: 'button', onclick: function () { openEndorse(id, card.name, m, { roleOnly: true }); } }, 'Role')
              : h('button', { class: 'am-endorse', type: 'button', onclick: function () { openEndorse(id, card.name, m); } },
                  h('span', { 'aria-hidden': 'true' }, TROPHY), ' Endorse'))
          : null;
      return h('li', { class: 'am-li' },
        m.canOpen ? h('button', { class: 'fl-row', type: 'button', onclick: function () { openProfile(m.userId); } }, inner)
          : h('div', { class: 'fl-row' }, inner),
        trophy,
        manage ? h('button', { class: 'pe-x', type: 'button', 'aria-label': 'Remove ' + (m.name || 'them'),
          onclick: function () {
            confirmSheet({ title: 'Remove ' + (m.name || 'them') + ' from ' + card.name + '?', body: 'You can add them again any time.',
              action: 'Remove', danger: true,
              onConfirm: async function () {
                try { await B.removeArtistMember(id, m.userId); actOf(id, true); return true; }
                catch (x) { saveFailed('member', x); return false; }
              } });
          } }, icon('close', 14)) : null);
    };
    var people = function (list, kind) {
      return [
        list.length ? h('ul', { class: 'tour-list rows vp-list am-list' }, list.map(memberRow))
          : unclaimed ? emptyState('Nobody runs this page yet', 'Once ' + card.name + ' claims it, their ' + (kind === 'band' ? 'band' : 'crew') + ' shows up here.')
          : emptyState(kind === 'band' ? 'No band members yet' : 'No crew yet',
              manage ? 'Search for their Greenroom account to add them.' : card.name + ' hasn\u2019t added anyone here yet.'),
        manage ? h('div', { class: 'am-more' },
          h('button', { class: 'add-pill', type: 'button', onclick: function () { openAddMembers(id, kind); } },
            icon('plus', 16), kind === 'band' ? 'Add band members' : 'Add crew members')) : null
      ];
    };
    // Every tour there is: the ones on Greenroom (they open) and the ones the
    // synced history knows by name; the tour being played today leads, glowing.
    var pastTours = hsum && Array.isArray(hsum.toursList) ? hsum.toursList : [];
    var tourRows = G.tourTimeline(tours, pastTours, G.tourToday()).map(function (r) {
      var t = r.tour;
      if (!r.own) return historyTourRow(id, r);
      return timelineRow(r, function () {
        if ((manage || !card.mine) && t.mine && getTour(t.id)) openTour(t.id); else openTourCard(t.id, null, t, id);
      }, false);
    });
    // Anyone can follow an artist's page; shown at once, put back if it didn't take.
    var following = false;
    var setFollow = async function (on) {
      if (following || !!card.iFollow === on) return;
      following = true;
      card.iFollow = on; card.followers = Math.max(0, G.num(card.followers) + (on ? 1 : -1));
      render(true);
      try {
        await (on ? B.followArtist(id) : B.unfollowArtist(id));
        actOf(id, true);
        S.searchSug = null; // Search's Artists list puts the ones you follow first
      } catch (e) {
        card.iFollow = !on; card.followers = Math.max(0, G.num(card.followers) + (on ? -1 : 1));
        saveFailed('follow', e); render(true);
      }
      following = false;
    };
    // Artists have fans, not followers (Devin's rule): the button says so.
    var followBtn = !B || !B.followArtist ? null : card.iFollow
      ? h('button', { class: 'pf-btn on', type: 'button', 'aria-label': 'You are a fan of ' + card.name + '. Tap to stop being one.',
          onclick: function () {
            confirmSheet({ title: 'Not a fan of ' + card.name + ' anymore?', body: 'You can be a fan again any time.',
              action: 'Not a fan', danger: true, onConfirm: function () { setFollow(false); return true; } });
          } }, 'Fan', icon('chevron', 14))
      : h('button', { class: 'pf-btn go', type: 'button', onclick: function () { setFollow(true); } }, 'Fan');
    // Claiming a page nobody runs: who you are to the act goes to a Greenroom admin.
    var claimBtn = !unclaimed || !B || !B.claimArtist ? null
      : card.myClaim === 'pending'
        ? h('button', { class: 'pf-btn on', type: 'button', onclick: function () { openClaimPage(id); } }, 'Claim sent', icon('chevron', 14))
        : h('button', { class: 'pf-btn', type: 'button', onclick: function () { openClaimPage(id); } },
            card.myClaim === 'declined' ? 'Claim again' : 'Claim this page');
    var aboutLine = unclaimed ? [card.about, regionName(card.country)].filter(Boolean).join(' \u00b7 ') : '';
    // The page you run gets the same compact green band as your own page (pf-home).
    return h('div', { class: 'page home profile has-tabs' + (S.route.manage && card.mine ? ' pf-home' : '') },
      // A page nobody runs has only a machine's username: its name leads instead.
      head(unclaimed || machineHandle(card.handle) ? card.name : card.handle),
      h('section', { class: 'pf vp', 'aria-label': card.name + ' profile' },
        (function () {
          var synced = hsum && G.num(hsum.shows) > 0;
          return roadHead({
            name: h('strong', { class: 'vp-name' }, card.name),
            photo: h('div', { class: 'pf-photo-wrap' }, photo,
              (manage && !card.avatar) ? h('span', { class: 'pf-plus', 'aria-hidden': 'true' }, icon('plus', 14)) : null),
            // The road story is the headline: tours, shows, countries (of the
            // world's 195), cities. Until it's synced, the page counts what Greenroom knows.
            left: synced ? [pfStat(G.num(hsum.tours), G.num(hsum.tours) === 1 ? 'tour' : 'tours', function () { pickTab('tours'); }),
                            pfStat(G.num(hsum.shows), G.num(hsum.shows) === 1 ? 'show' : 'shows')]
              : [pfStat(tours.length, tours.length === 1 ? 'tour' : 'tours', function () { pickTab('tours'); }),
                 pfStat(tours.reduce(function (n, x) { return n + G.num(x.shows); }, 0), tours.reduce(function (n, x) { return n + G.num(x.shows); }, 0) === 1 ? 'show' : 'shows')],
            right: synced ? [pfStat(G.num(hsum.countries) + '/195', 'countries'),
                             pfStat(G.num(hsum.cities), G.num(hsum.cities) === 1 ? 'city' : 'cities')]
              : [pfStat(bandList.length, 'band', function () { pickTab('band'); }),
                 pfStat(crewList.length, 'crew', function () { pickTab('crew'); })],
            under: h('p', { class: 'hist-fans' }, h('span', { class: 'hf-txt' }, plural(G.num(card.followers), 'fan')))
          });
        })(),
        h('p', { class: 'pf-roles' }, 'Artist', unclaimed ? h('span', { class: 'act-tag' }, 'Unclaimed') : null),
        card.bio ? h('p', { class: 'pf-bio' }, card.bio)
          : aboutLine ? h('p', { class: 'pf-bio act-about' }, aboutLine)
          : (manage ? h('button', { class: 'pf-bio pf-ask', type: 'button', onclick: function () { openActEdit(id); } }, 'Add a short bio') : null),
        historyBlock(id, manage, tours),
        unclaimed ? h('p', { class: 'hist-note act-note' }, 'Nobody runs this page yet. If this is your band, claim it.') : null,
        manage ? h('div', { class: 'pf-actions' },
          h('button', { class: 'pf-btn', type: 'button', onclick: function () { openActEdit(id); } }, 'Edit artist'),
          h('button', { class: 'pf-btn', type: 'button', onclick: function () { openHistorySheet(id, card.name); } }, 'Tour history'))
          : (followBtn || claimBtn) ? h('div', { class: 'pf-actions' + (followBtn && claimBtn ? ' two' : '') }, followBtn, claimBtn) : null),
      // On the page you run: whoever is waiting on your yes for their tours.
      manage ? creditQueueCards(id) : null,
      // For a Greenroom admin: whoever is asking to run this page.
      unclaimed ? claimQueueCards(id) : null,
      h('div', { class: 'vp-tabs three', role: 'tablist' }, tabBtn('band', 'Band', 'music'), tabBtn('crew', 'Crew', 'people'), tabBtn('tours', 'Tours', 'tabmap')),
      tab === 'band' ? people(bandList, 'band')
        : tab === 'crew' ? people(crewList, 'crew')
        : [tourRows.length ? h('ul', { class: 'tour-list rows vp-list' }, tourRows)
            : emptyState('No tours yet', manage ? 'Tours you file under ' + card.name + ' show up here.'
                : histBusy(hc0.row) ? (histWaiting(hc0.row) ? 'The rest of ' + card.name + '\u2019s road history comes in tomorrow.' : 'Reading ' + card.name + '\u2019s road history\u2026')
                : card.name + ' has no tours on Greenroom yet.'),
           // Under the tours, for whoever runs the page: the ones setlist.fm never named.
           tourFinderBlock(id, card, manage, unclaimed)],
      historyCredit(id),
      h('span', { class: 'logo-mark home-mark', 'aria-hidden': 'true' }),
      socialBar(manage && id === actingAs() ? 'me' : ''));
  }
  /* ---- Endorsing, and the role that goes with it. The artist's page says
     what this person IS to it — the title the public sees there (Brent is
     "Guitar" on the band's page, whatever he does behind the scenes) — and
     then gives the trophy, which is for good. Someone already endorsed (or
     who took the trophy off) gets the same sheet for the role alone. ---- */
  function openEndorse(artistId, artistName, m, opts) {
    var B = window.GR_BACKEND, o = opts || {};
    var me = B && B.uid ? B.uid() : null, self = !!m.userId && m.userId === me;
    var roleOnly = !!(m.endorsed || o.roleOnly);
    var was = String(m.role || '').trim(), role = was;
    var presets = m.kind === 'band' ? G.BAND_ROLES : G.ARTIST_CREW_ROLES;
    var who = self ? 'you' : (m.name || 'they');
    openSheet(function () {
      var input = h('input', { class: 'input', type: 'text', maxlength: 40, value: role, autocapitalize: 'words',
        placeholder: m.kind === 'band' ? 'Or type it: Guitar and vocals…' : 'Or type it: Backline tech…',
        'aria-label': 'Role with ' + artistName });
      var chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Pick a role' }, presets.map(function (r) {
        return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(r === role),
          onclick: function () { role = r; input.value = r; sync(); } }, r);
      }));
      function sync() {
        Array.prototype.forEach.call(chips.children, function (b) { b.setAttribute('aria-pressed', String(b.textContent === role)); });
      }
      input.addEventListener('input', function () { role = input.value.trim(); sync(); });
      var busy = false;
      async function save(endorse, btn) {
        if (busy) return;
        busy = true; btn.disabled = true;
        role = input.value.trim().slice(0, 40);
        try {
          if (role !== was && B.setMemberRole) { await B.setMemberRole(artistId, m.userId, role); was = role; }
          m.role = role;
          if (endorse) { await B.endorse(artistId, m.userId); m.endorsed = true; }
        } catch (x) { busy = false; btn.disabled = false; saveFailed('endorsement', x); return; }
        closeSheet();
        actOf(artistId, true);
        if (m.userId) cardOf(m.userId, true);
        S.creditAsks = null;
        toast(endorse ? (self ? 'You’re endorsed ' : (m.name || 'They') + ' is endorsed ') + TROPHY : 'Role saved');
        if (o.after) o.after(endorse);
        render(true);
        // Endorsed yourself: straight on to confirming your own tours.
        if (endorse && self && creditsOn()) setTimeout(function () { openCreditClaim(artistId); }, 420);
      }
      return [
        h('h2', { class: 'sh-title' }, roleOnly ? (self ? 'Your role' : (m.name || 'Their') + '’s role')
          : 'Endorse ' + (self ? 'yourself' : (m.name || 'them')) + '?'),
        h('p', { class: 'sh-sub' }, 'What ' + (self ? 'is your' : 'was their') + ' role with ' + artistName + '? It shows under ' +
          (self ? 'your' : 'their') + ' name on ' + artistName + '’s page.'),
        chips, input,
        roleOnly ? null : h('p', { class: 'note' }, 'Endorsing says ' + who + ' really worked for ' + artistName + '. It shows on ' +
          (self ? 'your' : 'their') + ' page and can’t be taken back. Then ' + (self ? 'you confirm' : 'they’re asked to confirm') +
          ' the tours and shows ' + who + ' did with ' + artistName + '.'),
        h('div', { class: 'stack', style: 'margin-top:14px' },
          // What this page confirmed for them can be taken back (the trophy can't).
          roleOnly && m.hasCredits && B.decideCredits ? h('button', { class: 'linkbtn rv-aside tc-off', type: 'button',
            onclick: async function (e) {
              var btn = e.currentTarget;
              if (!btn.armed) { btn.armed = true; btn.textContent = 'Take their confirmed tours off their page?'; return; }
              if (busy) return;
              busy = true; btn.disabled = true;
              var out = null, bad = null;
              try { out = await B.decideCredits(artistId, m.userId, 'revoke'); } catch (x) { bad = x; }
              busy = false;
              if (!out) { btn.disabled = false; saveFailed('credits', bad); return; }
              m.hasCredits = false;
              closeSheet(); actOf(artistId, true); cardOf(m.userId, true);
              toast('Their confirmed tours are off their page'); render(true);
            } }, 'Take back the tours ' + artistName + ' confirmed for ' + (self ? 'you' : 'them')) : null,
          roleOnly
            ? h('button', { class: 'btn primary block', type: 'button', onclick: function (e) { save(false, e.currentTarget); } }, 'Save role')
            : [h('button', { class: 'btn primary block', type: 'button', onclick: function (e) { save(true, e.currentTarget); } }, TROPHY + ' Endorse'),
               h('button', { class: 'btn quiet block', type: 'button', onclick: function (e) { save(false, e.currentTarget); } }, 'Just save the role')],
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel'))
      ];
    }, { label: roleOnly ? 'Role' : 'Endorse' });
  }

  /* ---- Tour credits. Someone an artist has endorsed confirms the shows and
     tours they've done with it: ALL TOURS, or tour by tour, each one the
     entire tour or just the nights they were on. Nothing reaches their page
     until the artist says yes. Then those nights count in their road story
     and their tours list. ---- */
  function creditsOn() {
    var B = window.GR_BACKEND;
    return S.mode === 'db' && socialOn() && !!(B && B.creditAsks && B.creditTours);
  }
  // Artists asking you to confirm, and where each one stands.
  function creditAsks(fresh) {
    var c = S.creditAsks || (S.creditAsks = { list: [], at: 0, asking: false });
    if (!creditsOn()) return c;
    if (!c.asking && (fresh || Date.now() - c.at > 60e3)) {
      c.asking = true;
      window.GR_BACKEND.creditAsks().then(function (l) {
        c.list = Array.isArray(l) ? l : []; c.at = Date.now(); c.asking = false; render();
      }).catch(function () { c.asking = false; c.at = Date.now(); });
    }
    return c;
  }
  // Claims waiting on the artist pages you run.
  function creditQueue(fresh) {
    var c = S.creditQueue || (S.creditQueue = { list: [], at: 0, asking: false });
    if (!creditsOn() || !window.GR_BACKEND.creditQueue) return c;
    if (!c.asking && (fresh || Date.now() - c.at > 60e3)) {
      c.asking = true;
      window.GR_BACKEND.creditQueue().then(function (l) {
        c.list = Array.isArray(l) ? l : []; c.at = Date.now(); c.asking = false; render();
      }).catch(function () { c.asking = false; c.at = Date.now(); });
    }
    return c;
  }
  function tallyText(t) { return plural(G.num(t.tours), 'tour') + ' · ' + plural(G.num(t.shows), 'show'); }
  // "Mar 8 – Jun 9, 2017", years said once when they match.
  function tourSpan(first, last) {
    if (!first) return '';
    var y1 = String(first).slice(0, 4), y2 = String(last || first).slice(0, 4);
    if (!last || last === first) return dayMD(first) + ', ' + y1;
    return y1 === y2 ? dayMD(first) + ' – ' + dayMD(last) + ', ' + y2
      : dayMD(first) + ', ' + y1 + ' – ' + dayMD(last) + ', ' + y2;
  }
  /* ---- Claiming a page. Every act has a page; one nobody runs can be asked
     for by whoever is really in it. The ask (who you are to the act, and a
     link that shows it) goes to a Greenroom admin; a yes makes the page
     theirs to run, and verified. ---- */
  function openClaimPage(id) {
    var B = window.GR_BACKEND;
    var card = S.actCards && S.actCards[id] && S.actCards[id].card;
    if (!card || !B || !B.claimArtist) return;
    var f = { note: '', link: '', busy: false };
    var after = function () { actOf(id, true); S.claimQ = null; };
    openSheet(function () {
      if (card.myClaim === 'pending') {
        return [
          h('h2', { class: 'sh-title ca-title' }, 'Your claim is with Greenroom'),
          h('p', { class: 'sh-sub' }, 'Someone at Greenroom checks every claim by hand. The moment it\u2019s approved, ' + card.name + ' is yours to run.'),
          h('div', { class: 'stack' },
            h('button', { class: 'btn danger block', type: 'button', onclick: function () {
              confirmSheet({ title: 'Withdraw your claim?', body: 'You can claim ' + card.name + ' again any time.', action: 'Withdraw', danger: true,
                onConfirm: async function () {
                  try { await B.withdrawClaim(id); card.myClaim = null; after(); toast('Claim withdrawn'); return true; }
                  catch (e) { saveFailed('claim', e); return false; }
                } });
            } }, 'Withdraw the claim'),
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Close'))
        ];
      }
      var send = h('button', { class: 'btn primary block', type: 'submit' }, 'Send the claim');
      var ready = function () { send.disabled = f.note.trim().length < 3 || f.busy; };
      ready();
      return [
        h('h2', { class: 'sh-title ca-title' }, 'Claim ' + card.name),
        h('p', { class: 'sh-sub' }, (card.myClaim === 'declined' ? 'The last claim wasn\u2019t approved. Say more, or add a link that shows it\u2019s you. ' : '') +
          'Tell Greenroom who you are to ' + card.name + '. Someone checks it by hand; a yes makes this page yours to run.'),
        h('form', { class: 'sh-form ca-form', novalidate: true, onsubmit: async function (e) {
          e.preventDefault();
          if (send.disabled) return;
          blurActive();
          f.busy = true; ready();
          try {
            var r = await B.claimArtist(id, f.note.trim(), f.link.trim());
            if (r && r.ok) { card.myClaim = 'pending'; after(); closeSheet(); toast('Claim sent'); render(true); return; }
            f.busy = false; ready();
            toast(r && r.why === 'taken' ? 'Someone already runs this page.' : 'Couldn\u2019t send that. Try again.');
            if (r && r.why === 'taken') { after(); closeSheet(); }
          } catch (x) {
            f.busy = false; ready();
            if (x && x.code === 'short') toast('Say who you are to ' + card.name + '.');
            else if (x && x.code === 'too-many') toast('You have a lot of claims waiting. Let those be answered first.');
            else saveFailed('claim', x);
          }
        } },
          field('Who are you to ' + card.name + '?', h('textarea', { class: 'input', rows: 3, maxlength: 500,
            placeholder: 'e.g. I sing in the band. / I\u2019m their tour manager.', 'aria-label': 'Who you are to ' + card.name,
            oninput: function (e) { f.note = e.target.value; ready(); } })),
          field('A link that shows it (optional)', h('input', { class: 'input', type: 'url', maxlength: 200, autocapitalize: 'none', autocorrect: 'off',
            autocomplete: 'off', spellcheck: 'false', placeholder: 'The band\u2019s site or socials, where you appear', 'aria-label': 'A link that shows it',
            oninput: function (e) { f.link = e.target.value; } })),
          h('div', { class: 'stack' }, send,
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Not now')))
      ];
    }, { label: 'Claim ' + card.name, cls: 'ca-sheet' });
  }
  // For a Greenroom admin: every claim waiting. Everyone else gets nothing
  // back and never sees a door to it.
  function claimQ(fresh) {
    var B = window.GR_BACKEND;
    var c = S.claimQ || (S.claimQ = { list: null, at: 0, asking: false });
    if (S.mode !== 'db' || !socialOn() || !B || !B.claimQueue) return c;
    // An admin's list is asked again each minute; "not an admin" holds for ten.
    if (!c.asking && (fresh || Date.now() - c.at > (c.list ? 60e3 : 600e3))) {
      c.asking = true;
      B.claimQueue().then(function (l) {
        c.list = Array.isArray(l) ? l : null; c.at = Date.now(); c.asking = false; render();
      }).catch(function () { c.asking = false; c.at = Date.now(); });
    }
    return c;
  }
  // On an unclaimed page, for an admin: who is asking to run it.
  function claimQueueCards(artistId) {
    var list = (claimQ().list || []).filter(function (x) { return x.artistId === artistId; });
    if (!list.length) return null;
    return h('div', { class: 'tc-asks' }, list.map(function (x) {
      return h('button', { class: 'tc-ask on', type: 'button', onclick: function () { openClaimReview(x); } },
        h('span', { class: 'tc-ask-t' }, (x.name || 'Someone') + ' is asking to run this page'), icon('chevron', 16));
    }));
  }
  // Every claim waiting, for an admin (from Your profiles).
  function openClaimQueue() {
    var host = h('div', { class: 'acct-list' });
    var draw = function () {
      var list = claimQ().list || [];
      fillEl(host, list.length ? list.map(function (x) {
        return h('button', { class: 'acct-row', type: 'button', onclick: function () { openClaimReview(x, function () { openClaimQueue(); }); } },
          personPhoto({ name: x.name, avatar: x.avatar }, 'xs'),
          h('span', { class: 'lr-text' },
            h('span', { class: 'lr-title' }, x.artist),
            h('span', { class: 'lr-sub' }, (x.name || 'Someone') + (x.handle ? ' \u00b7 @' + x.handle : ''))),
          icon('chevron', 16));
      }) : [h('p', { class: 'note' }, 'No claims waiting.')]);
    };
    draw();
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title pe-title' }, 'Page claims'),
        h('p', { class: 'sh-sub' }, 'People asking to run an artist\u2019s page. A yes makes it theirs, and verified.'),
        host,
        h('div', { class: 'stack' }, h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Close'))
      ];
    }, { label: 'Page claims', cls: 'acct-sheet' });
  }
  // One claim, to answer: who is asking, for which act, and what they said.
  function openClaimReview(x, back) {
    var B = window.GR_BACKEND, busy = false;
    var done = function () { S.claimQ = null; claimQ(true); if (S.actCards && S.actCards[x.artistId]) actOf(x.artistId, true); myActs(true); };
    var answer = async function (yes) {
      if (busy) return true;
      busy = true;
      var r = null;
      try { r = await B.decideClaim(x.id, yes); } catch (e) { busy = false; saveFailed('claim', e); return false; }
      busy = false;
      done();
      toast(r && r.ok ? (yes ? x.artist + ' is now run by ' + (x.name || 'them') : 'Claim declined')
        : r && r.why === 'taken' ? 'Someone already runs that page.' : 'That claim was already answered.');
      closeSheet();
      if (back) setTimeout(back, 300); else render(true);
      return true;
    };
    var safeLink = /^https?:\/\//i.test(String(x.link || '')) ? x.link : '';
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title ca-title' }, 'Claim: ' + x.artist),
        h('p', { class: 'sh-sub' }, [x.about, regionName(x.country)].filter(Boolean).join(' \u00b7 ') || 'Artist page nobody runs yet'),
        h('div', { class: 'ledger cq-card' },
          h('div', { class: 'row' }, h('div', { class: 'row-label' }, x.name || 'Someone',
            h('span', { class: 'hint' }, [x.handle ? '@' + x.handle : ''].concat([x.tourRole].concat(x.roles || []).filter(function (v, i, all) { return v && all.indexOf(v) === i; })).filter(Boolean).join(' \u00b7 ')),
            x.email ? h('span', { class: 'hint' }, x.email) : null),
            h('button', { class: 'btn sm quiet', type: 'button', onclick: function () { closeSheet(true); openProfile(x.userId); } }, 'Profile')),
          h('div', { class: 'row cq-note' }, h('div', { class: 'row-label' }, 'What they said', h('span', { class: 'hint cq-said' }, x.note || '\u2014'))),
          x.link ? h('div', { class: 'row cq-note' }, h('div', { class: 'row-label' }, 'Their link',
            safeLink ? h('a', { class: 'hint cq-link', href: safeLink, target: '_blank', rel: 'noopener noreferrer' }, x.link)
              : h('span', { class: 'hint cq-said' }, x.link))) : null,
          G.num(x.others) > 0 ? h('div', { class: 'row cq-note' }, h('div', { class: 'row-label' },
            plural(G.num(x.others), 'other person') .replace('persons', 'people') + ' also asked for this page',
            h('span', { class: 'hint' }, 'Approving this one declines the rest.'))) : null),
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary block', type: 'button', onclick: function () {
            confirmSheet({ title: 'Give ' + x.artist + ' to ' + (x.name || 'them') + '?',
              body: 'They\u2019ll run the page: its photo, bio, band, crew and tour history. It gets marked verified.',
              action: 'Approve', onConfirm: function () { return answer(true); } });
          } }, 'Approve'),
          h('button', { class: 'btn danger block', type: 'button', onclick: function () { answer(false); } }, 'Decline'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); if (back) setTimeout(back, 300); } }, back ? 'Back' : 'Close'))
      ];
    }, { label: 'Claim: ' + x.artist, cls: 'ca-sheet' });
  }
  // On your own Artists tab: one line per artist that endorsed you.
  function creditAskCards() {
    if (!creditsOn()) return null;
    var list = creditAsks().list || [];
    if (!list.length) return null;
    return h('div', { class: 'tc-asks' }, list.map(function (a) {
      var todo = a.state === 'ask' || a.state === 'declined';
      var main = a.state === 'ask' ? 'Confirm the shows and tours you’ve done with ' + a.artist
        : a.state === 'declined' ? a.artist + ' sent your tours back — fix and resend'
        : a.state === 'pending' ? 'Waiting on ' + a.artist + ' to approve your tours'
        : tallyText(a) + ' confirmed with ' + a.artist;
      return h('button', { class: 'tc-ask' + (todo ? ' on' : ''), type: 'button', onclick: function () { openCreditClaim(a.artistId); } },
        h('span', { class: 'tc-ask-t' }, main), icon('chevron', 16));
    }));
  }
  // On an artist page you run: who is waiting on your yes.
  function creditQueueCards(artistId) {
    if (!creditsOn()) return null;
    var list = (creditQueue().list || []).filter(function (x) { return x.artistId === artistId; });
    if (!list.length) return null;
    return h('div', { class: 'tc-asks' }, list.map(function (x) {
      return h('button', { class: 'tc-ask on', type: 'button', onclick: function () { openCreditReview(x); } },
        h('span', { class: 'tc-ask-t' }, (x.name || 'Someone') + ' · ' + (x.all ? 'all tours · ' : '') + tallyText(x) + ' to approve'),
        icon('chevron', 16));
    }));
  }
  /* The confirm page, built like the card-charge review: ALL TOURS on top,
     then every tour to tick; a ticked tour asks Entire tour or Specific
     shows, and Specific shows opens that tour's nights to tick. */
  function openCreditClaim(artistId) {
    var B = window.GR_BACKEND;
    var host = h('div', { class: 'tc-host' }), foot = h('div', { class: 'stack tc-foot' });
    var title = h('h2', { class: 'sh-title' }, 'Confirm your tours');
    var st = { d: null, failed: false, sel: { all: false, picks: {} }, shows: {}, busy: false, armed: false };
    function load() {
      B.creditTours(artistId).then(function (d) {
        st.d = d; st.failed = !d;
        // Pick up where they left off: what's waiting, else what was sent back, else what's confirmed.
        if (d && d.mine) st.sel = G.creditSelection(d.mine.pending || d.mine.declined || d.mine.approved);
        if (d) title.textContent = 'Confirm the shows and tours you’ve done with ' + d.artist;
        // A tour picked night by night before: its nights are needed to show the ticks.
        Object.keys(st.sel.picks).forEach(function (k) { if (st.sel.picks[k].mode === 'shows') loadShows(k); });
        draw();
      }).catch(function () { st.failed = true; draw(); });
    }
    function loadShows(key) {
      if (st.shows[key] && !st.shows[key].failed) return;
      st.shows[key] = { list: null };
      B.creditShows(artistId, key).then(function (l) { st.shows[key] = { list: Array.isArray(l) ? l : [] }; draw(); })
        .catch(function () { st.shows[key] = { list: null, failed: true }; draw(); });
    }
    function groups() { return st.d && Array.isArray(st.d.tours) ? st.d.tours : []; }
    function showLine(x) {
      return [dayMD(x.date), [x.city, x.country && x.country !== 'US' ? x.country : ''].filter(Boolean).join(', '), x.venue]
        .filter(Boolean).join(' · ');
    }
    function groupRow(g) {
      var p = st.sel.picks[g.key], on = st.sel.all || !!p;
      var cb = h('input', { type: 'checkbox', class: 'rv-check', checked: on, disabled: st.sel.all || st.busy || null,
        'aria-label': G.creditGroupName(g),
        onchange: function (e) {
          if (e.target.checked) st.sel.picks[g.key] = { mode: 'all', shows: {} };
          else delete st.sel.picks[g.key];
          draw();
        } });
      var flip = function () {
        if (st.sel.all || st.busy) return;
        if (st.sel.picks[g.key]) delete st.sel.picks[g.key]; else st.sel.picks[g.key] = { mode: 'all', shows: {} };
        draw();
      };
      var kids = [
        h('div', { class: 'rv-head tc-tap', onclick: flip },
          h('span', { class: 'rv-name' }, G.creditGroupName(g)),
          h('span', { class: 'amt num' }, plural(G.num(g.n), 'show'))),
        h('div', { class: 'rv-sub tc-tap', onclick: flip }, g.year ? 'Nights outside a named tour' : tourSpan(g.first, g.last))];
      if (p && !st.sel.all) {
        kids.push(h('div', { class: 'rv-dest', role: 'group', 'aria-label': 'How much of ' + G.creditGroupName(g) },
          [['all', g.year ? 'All of them' : 'Entire tour'], ['shows', 'Specific shows']].map(function (m) {
            return h('button', { class: 'rv-dpill' + (p.mode === m[0] ? ' on' : ''), type: 'button',
              onclick: function () {
                if (st.busy) return;
                p.mode = m[0];
                if (p.mode === 'shows') loadShows(g.key);
                draw();
              } }, m[1]);
          })));
        if (p.mode === 'shows') {
          var got = st.shows[g.key];
          if (got && got.failed) {
            kids.push(h('p', { class: 'note' }, 'Couldn’t load those shows. ',
              h('button', { class: 'linkbtn', type: 'button', onclick: function () { loadShows(g.key); draw(); } }, 'Try again')));
          } else if (!got || !got.list) kids.push(h('p', { class: 'note' }, 'Loading the shows…'));
          else {
            var n = got.list.filter(function (x) { return p.shows[x.id]; }).length;
            kids.push(h('div', { class: 'tc-shows' },
              h('div', { class: 'tc-shows-h' },
                h('span', null, n + ' of ' + got.list.length + ' picked'),
                h('button', { class: 'linkbtn', type: 'button', onclick: function () {
                  var every = n === got.list.length;
                  got.list.forEach(function (x) { if (every) delete p.shows[x.id]; else p.shows[x.id] = true; });
                  draw();
                } }, n === got.list.length ? 'Clear' : 'Tick all')),
              got.list.map(function (x) {
                return h('label', { class: 'tc-show' },
                  h('input', { type: 'checkbox', class: 'rv-check', checked: !!p.shows[x.id], disabled: st.busy || null,
                    onchange: function (e) { if (e.target.checked) p.shows[x.id] = true; else delete p.shows[x.id]; draw(); } }),
                  h('span', null, showLine(x)));
              })));
          }
        }
      }
      return h('div', { class: 'rv-row' + (on ? ' on' : '') + (st.sel.all ? ' tc-all' : '') }, cb, h('div', { class: 'rv-fields' }, kids));
    }
    function draw() {
      var d = st.d;
      if (!d) {
        fillEl(host, h('p', { class: 'note' }, st.failed ? 'Couldn’t open this just now. Close and try again.' : 'Loading…'));
        fillEl(foot, h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Close'));
        return;
      }
      var gs = groups(), mine = d.mine || null;
      if (!gs.length) {
        fillEl(host, h('p', { class: 'note' }, d.artist + ' hasn’t put its tour history on Greenroom yet, so there’s nothing to confirm against. ' +
          'Once it does, this page fills in.'));
        fillEl(foot, h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Close'));
        return;
      }
      var named = gs.filter(function (g) { return !g.year; }), loose = gs.filter(function (g) { return g.year; });
      var status = !mine ? null
        : mine.pending ? 'Waiting on ' + d.artist + ' to approve what you sent. Sending again replaces it.'
        : mine.declined ? d.artist + ' sent it back. It’s ticked the way you sent it — fix it and send it again.'
        : mine.approved ? 'Confirmed. Change it and send again — ' + (d.owner ? 'it’s yours to confirm.' : d.artist + ' approves the change.') : null;
      fillEl(host, [
        status ? h('p', { class: 'note tc-status' }, status) : null,
        h('label', { class: 'rv-row tc-allrow' + (st.sel.all ? ' on' : '') },
          h('input', { type: 'checkbox', class: 'rv-check', checked: st.sel.all, disabled: st.busy || null,
            onchange: function (e) { st.sel.all = e.target.checked; draw(); } }),
          h('div', { class: 'rv-fields' },
            h('div', { class: 'rv-head' }, h('span', { class: 'rv-name' }, 'ALL TOURS'),
              h('span', { class: 'amt num' }, plural(gs.reduce(function (n, g) { return n + G.num(g.n); }, 0), 'show'))),
            h('div', { class: 'rv-sub' }, 'Every tour and show ' + d.artist + ' has played, through today'))),
        named.length ? h('h3', { class: 'sh-h3' }, 'Or tour by tour') : null,
        named.map(groupRow),
        loose.length ? h('h3', { class: 'sh-h3' }, 'Shows outside a tour') : null,
        loose.map(groupRow),
        // Their data, their credit.
        setlistCredit(d.url)
      ]);
      var t = G.creditTally(gs, st.sel);
      fillEl(foot, [
        h('button', { class: 'btn primary block', type: 'button', disabled: st.busy || !t.shows || null, onclick: send },
          st.busy ? 'Sending…' : !t.shows ? 'Tick the tours you were on'
            : (d.owner ? 'Confirm · ' : 'Send to ' + d.artist + ' · ') + tallyText(t)),
        mine && (mine.approved || mine.pending) ? h('button', { class: 'linkbtn rv-aside tc-off', type: 'button', disabled: st.busy || null,
          onclick: withdraw }, st.armed ? 'Take them off for good?' : 'Take my tours with ' + d.artist + ' off my page') : null,
        h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Not now')
      ]);
    }
    async function send() {
      var d = st.d, t = G.creditTally(groups(), st.sel);
      if (st.busy || !d) return;
      if (!t.shows) { toast('Tick the tours you were on first.'); return; }
      var waiting = Object.keys(st.sel.picks).some(function (k) {
        return !st.sel.all && st.sel.picks[k].mode === 'shows' && !(st.shows[k] && st.shows[k].list);
      });
      if (waiting) { toast('Still loading a tour’s shows — one moment.'); return; }
      st.busy = true; draw();
      var out = null, bad = null;
      try { out = await B.submitCredits(artistId, G.creditClaim(st.sel)); } catch (e) { bad = e; }
      st.busy = false;
      if (!out || !out.ok) { draw(); saveFailed('credits', bad || out); return; }
      closeSheet();
      S.creditAsks = null; S.creditQueue = null;
      if (B.uid) cardOf(B.uid(), true);
      if (out.auto) hornSplash('Tours confirmed', tallyText(t) + ' on your page');
      else toast('Sent — once ' + d.artist + ' approves, it’s on your page');
      render(true);
    }
    async function withdraw() {
      if (st.busy) return;
      // Two taps: it comes off the page at once.
      if (!st.armed) { st.armed = true; draw(); return; }
      st.busy = true; draw();
      var out = null, bad = null;
      try { out = await B.withdrawCredits(artistId); } catch (e) { bad = e; }
      st.busy = false; st.armed = false;
      if (!out) { draw(); saveFailed('credits', bad); return; }
      closeSheet();
      S.creditAsks = null; S.creditQueue = null;
      if (B.uid) cardOf(B.uid(), true);
      toast('Taken off your page');
      render(true);
    }
    draw(); load();
    openSheet(function (panel) {
      panel.classList.add('rv-sheet');
      return [title,
        h('p', { class: 'sh-sub' }, 'Tick what you were on. Nothing shows on your page until the artist says yes.'),
        host, foot];
    }, { label: 'Confirm your tours' });
  }
  /* The artist's side: what someone says they worked, laid out, and the yes
     or no. Approving puts it on their page; it never changes anything else. */
  function openCreditReview(item) {
    var B = window.GR_BACKEND;
    var host = h('div', { class: 'tc-host' }), foot = h('div', { class: 'stack tc-foot' });
    var st = { d: null, failed: false, busy: false, armed: false };
    var who = item.name || 'They', first = String(who).split(' ')[0];
    function load() {
      st.d = null; st.failed = false; draw();
      B.creditDetail(item.artistId, item.userId).then(function (d) { st.d = d; st.failed = !d; draw(); })
        .catch(function () { st.failed = true; draw(); });
    }
    function line(g) {
      return h('div', { class: 'row' },
        h('div', { class: 'row-label' }, G.creditGroupName(g),
          h('span', { class: 'hint' }, [g.year ? '' : tourSpan(g.first, g.last),
            G.num(g.n) >= G.num(g.total) ? (g.year ? 'all of them' : 'entire tour') : g.n + ' of ' + g.total + ' shows'].filter(Boolean).join(' · '))),
        h('span', { class: 'amt num' }, plural(G.num(g.n), 'show')));
    }
    function total(list) {
      return { tours: list.filter(function (g) { return !g.year; }).length,
        shows: list.reduce(function (n, g) { return n + G.num(g.n); }, 0) };
    }
    function draw() {
      var d = st.d;
      var close = h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Not now');
      if (!d) {
        fillEl(host, h('p', { class: 'note' }, st.failed ? 'Couldn’t open this just now. Close and try again.' : 'Loading…'));
        fillEl(foot, close);
        return;
      }
      var pend = Array.isArray(d.pending) ? d.pending : null, had = Array.isArray(d.approved) ? d.approved : [];
      if (!pend) {
        fillEl(host, h('p', { class: 'note' }, 'Nothing is waiting from ' + first + ' any more.'));
        fillEl(foot, close);
        return;
      }
      var t = total(pend);
      fillEl(host, [
        h('p', { class: 'note' }, who + ' says they worked these with ' + d.artist +
          (d.pendingAll ? ' — ALL TOURS, every show through the day they sent it.' : ':')),
        h('div', { class: 'ledger' }, pend.map(line),
          h('div', { class: 'row total' }, h('span', null, tallyText(t)), h('strong', { class: 'amt num' }, plural(t.shows, 'show')))),
        had.length ? h('p', { class: 'note' }, 'This replaces what you approved before (' + tallyText(total(had)) + ').') : null,
        setlistCredit(d.url)
      ]);
      fillEl(foot, [
        h('button', { class: 'btn primary block', type: 'button', disabled: st.busy || null,
          onclick: function () { decide('approve'); } }, st.busy ? 'Saving…' : 'Approve · it goes on ' + first + '’s page'),
        h('button', { class: 'btn danger block', type: 'button', disabled: st.busy || null,
          onclick: function () { if (!st.armed) { st.armed = true; draw(); return; } decide('decline'); } },
          st.armed ? 'Send it back to ' + first + '?' : 'Not right — send it back'),
        close
      ]);
    }
    async function decide(verdict) {
      if (st.busy || !st.d) return;
      st.busy = true; draw();
      var out = null, bad = null;
      try { out = await B.decideCredits(item.artistId, item.userId, verdict, st.d.submittedAt); } catch (e) { bad = e; }
      st.busy = false; st.armed = false;
      if (!out) { draw(); saveFailed('credits', bad); return; }
      S.creditQueue = null;
      if (!out.ok) {
        // They sent a newer one while this was open: look again before saying yes.
        toast(out.why === 'changed' ? first + ' sent a newer one. Take another look.' : 'Already handled');
        load(); render(true);
        return;
      }
      closeSheet();
      cardOf(item.userId, true);
      toast(verdict === 'approve' ? 'Approved — it’s on ' + first + '’s page' : 'Sent back to ' + first);
      render(true);
    }
    load();
    openSheet(function (panel) {
      panel.classList.add('rv-sheet');
      return [h('h2', { class: 'sh-title' }, who + '’s tours'), host, foot];
    }, { label: 'Tour credits to approve' });
  }
  /* One line of a Tours tab (an artist's or a person's). The tour being
     played today sits on top and glows: "Currently on". */
  function timelineRow(r, onTap, withArtist) {
    var span = r.first ? tourSpan(r.first, r.last) + (r.n ? ' · ' + plural(r.n, 'show') : '')
      : (r.n ? plural(r.n, 'show') : 'No dates yet');
    var inner = [h('span', { class: 'lr-text' },
      r.now ? h('span', { class: 'lr-title tl-title' }, h('span', { class: 'tl-name' }, r.name), h('span', { class: 'tl-now' }, 'Currently on'))
        : h('span', { class: 'lr-title' }, r.name),
      h('span', { class: 'lr-sub' }, [withArtist ? r.artist : '', span].filter(Boolean).join(' · '))),
      onTap ? icon('chevron', 18) : null];
    return h('li', { class: r.now ? 'tl-live' : null },
      onTap ? h('button', { class: 'list-row tour-row', type: 'button', onclick: onTap }, inner)
        : h('div', { class: 'list-row tour-row still' }, inner));
  }
  // A tour from the synced history: tap it and every night drops down
  // (Devin, 2026-10-07: like the tours on a crew member's profile).
  function tourNightsOf(artistId, name, fresh) {
    var B = window.GR_BACKEND;
    S.tourNights = S.tourNights || {};
    var k = artistId + '|' + name;
    var c = S.tourNights[k] || (S.tourNights[k] = { list: null, at: 0, asking: false, failed: false });
    if (S.mode !== 'db' || !B || !B.tourNights) { c.none = true; return c; }
    if (!c.asking && (fresh || !c.at)) {
      c.asking = true;
      B.tourNights(artistId, name).then(function (list) { c.list = Array.isArray(list) ? list : []; c.at = Date.now(); c.asking = false; c.failed = false; render(true); },
        function () { c.failed = true; c.at = Date.now(); c.asking = false; render(true); });
    }
    return c;
  }
  function historyTourRow(artistId, r) {
    S.tnOpen = S.tnOpen || {};
    var k = artistId + '|' + r.name, open = !!S.tnOpen[k];
    var span = r.first ? tourSpan(r.first, r.last) + (r.n ? ' \u00b7 ' + plural(r.n, 'show') : '') : (r.n ? plural(r.n, 'show') : 'No dates yet');
    var body = null;
    if (open) {
      var c = tourNightsOf(artistId, r.name);
      body = c.none ? null
        : c.failed && !c.list ? h('p', { class: 'pt-next pt-nodates' }, 'Couldn\u2019t load the dates just now.')
        : !c.list ? h('p', { class: 'pt-next pt-nodates' }, 'Loading\u2026')
        : !c.list.length ? h('p', { class: 'pt-next pt-nodates' }, 'No dates yet')
        : h('ul', { class: 'shows cal-list tn-list' }, c.list.map(function (n) {
            var where = [n.city, n.state && n.country === 'US' ? n.state : (n.country && n.country !== 'US' ? n.country : '')].filter(Boolean).join(', ');
            return h('li', { class: 'tn-row' + (n.announced ? ' announced' : '') },
              h('span', { class: 'tn-date' }, dayMD(n.date) + ', ' + String(n.date).slice(0, 4)),
              h('span', { class: 'tn-where' }, where || '\u2014', n.venue ? h('span', { class: 'tn-venue' }, ' \u00b7 ' + n.venue) : null),
              n.announced ? h('span', { class: 'tn-tag' }, 'announced') : null);
          }));
    }
    return h('li', { class: 'pt-run tn-run' + (open ? ' open' : '') },
      h('button', { class: 'pt-run-h', type: 'button', 'aria-expanded': open ? 'true' : 'false',
        onclick: function () { S.tnOpen[k] = !open; render(true); } },
        h('span', { class: 'lr-text' }, h('span', { class: 'lr-title' }, r.name), h('span', { class: 'lr-sub' }, span)),
        icon('chevron', 16)),
      body);
  }
  // A person's badge and "On the road since": the same ladder the artists climb.
  function roadLine(rs) {
    if (!G.isObj(rs)) return null;
    var tier = G.historyTier(rs), since = G.num(rs.firstYear);
    if (!tier && !(since > 1900)) return null;
    return h('p', { class: 'hist-line' },
      tier ? h('span', { class: 'hist-tier tier-' + tier.key }, tier.label) : null,
      since > 1900 ? 'On the road since ' + since : null);
  }

  /* ---- Tour history (the road story). setlist.fm — the fans' setlist
     archive — holds nearly every night a band ever played. The server reads
     it with the owner's key (write-only, like Square's) and boils it down
     to one summary per artist page: shows, tours, countries, cities. Their
     data, so their credit: the block links back to setlist.fm. ---- */
  function histOf(id, fresh) {
    var B = window.GR_BACKEND;
    S.histCards = S.histCards || {};
    var c = S.histCards[id] || (S.histCards[id] = { row: null, at: 0, asking: false, none: false });
    if (S.mode !== 'db' || !B || !B.artistHistory) { c.none = true; return c; }
    if (!c.asking && (fresh || Date.now() - c.at > 60e3)) {
      c.asking = true;
      // Looking is also a nudge: a history Greenroom reads by itself steps
      // along while its page is open (and the plain read stands in if the
      // nudge can't be reached).
      var was = c.row && c.row.status;
      (B.historyNudge ? B.historyNudge(id).catch(function () { return B.artistHistory(id); }) : B.artistHistory(id)).then(function (row) {
        c.row = row; c.at = Date.now(); c.asking = false; c.failed = false;
        // The encyclopedia just confirmed the act (or said it isn't one): the page's own card has changed.
        if (was === 'checking' && (!row || row.status !== 'checking')) actOf(id, true);
        render();
      }).catch(function () { c.asking = false; c.failed = true; c.at = Date.now(); render(); });
    }
    return c;
  }
  // Still being read in by Greenroom itself.
  function histBusy(row) { return !!(row && row.auto && /^(new|finding|checking|syncing)$/.test(String(row.status))); }
  // While such a page is open, ask again every few seconds until it settles.
  // Still to read, but not right now: the day's setlist.fm allowance (or
  // this account's share of it) is used up, or there's no key to read with
  // yet. The server says so; the page waits instead of asking every few seconds.
  function histWaiting(row) {
    return histBusy(row) && row.status === 'syncing' && (row.waiting === true || /read its fill/.test(String(row.detail || '')));
  }
  function histPoll(id) {
    S.histPolls = S.histPolls || {};
    if (S.histPolls[id]) return;
    var c = S.histCards && S.histCards[id];
    S.histPolls[id] = setTimeout(function () {
      S.histPolls[id] = 0;
      if (!(S.route && S.route.name === 'act' && S.route.id === id)) return;
      // Out of sight: keep the chain, and ask once the page is back in view.
      if (document.hidden) histPoll(id); else histOf(id, true);
    }, c && histWaiting(c.row) ? 300e3 : 3500);
  }
  // "US" -> "United States", where the phone knows how.
  function regionName(code) {
    var c = String(code || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) return '';
    try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(c) || c; } catch (e) { return c; }
  }
  // The one key per account, like squareInfo for Square.
  function setlistInfo(fresh) {
    var B = window.GR_BACKEND;
    var c = S.setlist || (S.setlist = { row: null, at: 0, asking: false, none: false });
    if (S.mode !== 'db' || !B || !B.setlistState) { c.none = true; return c; }
    if (!c.asking && (fresh || Date.now() - c.at > 60e3)) {
      c.asking = true;
      B.setlistState().then(function (row) {
        c.row = row; c.none = !row; c.at = Date.now(); c.asking = false; c.failed = false; render();
      }).catch(function () { c.asking = false; c.failed = true; c.at = Date.now(); render(); });
    }
    return c;
  }
  function histStatusLine(row) {
    if (!row) return '';
    if (row.status === 'checking') return 'Looking the act up…';
    if (row.status === 'idle') return '';
    if (row.status === 'finding') return 'Finding the band on setlist.fm…';
    if (row.status === 'syncing') {
      if (histWaiting(row)) return 'Greenroom has read its fill from setlist.fm for today. The rest of the road history comes in tomorrow.';
      return 'Reading the road history…' +
        (row.pages > 0 ? ' page ' + Math.min(G.num(row.next_page) || 1, row.pages) + ' of ' + row.pages : '');
    }
    if (row.status === 'bad_token') return 'setlist.fm refused the key — replace it.';
    if (row.status === 'error') {
      return row.auto ? 'setlist.fm had trouble, so this isn’t the whole story yet. It tries again on its own.'
        : (row.detail || 'setlist.fm had trouble. It tries again on its own.');
    }
    if (row.status === 'ok') {
      var sum = G.isObj(row.summary) ? row.summary : {};
      return 'Synced · ' + plural(G.num(sum.shows), 'show') +
        (row.synced_at ? ' · ' + feedAgo(row.synced_at) : '');
    }
    return 'Switched on — the first read lands within minutes.';
  }
  // Under the bio: the road badge and "On the road since YYYY" — every
  // artist page says it. The year is the first night on record, or, until
  // a page has its history, its first tour on Greenroom.
  /* ========================== Add missing tours ==========================
     Devin (2026-10-07): "a bunch of tours I've done in the app are missing"
     — because no database keeps tour names. So the page's owner (or a
     Greenroom admin, on a page nobody runs) presses Find missing tours: the
     server reads the two news archives that keep a page per band (ThePRP,
     Lambgoat), the app reads Wikipedia, the reading brain boils the articles
     down to tours, and each one waits here for a yes or no. A yes names the
     blank nights inside its dates and adds the announced dates setlist.fm
     never had. It looks like Greenroom all the way: the sources are only
     ever a guide. */
  function tfOf(id, fresh) {
    var B = window.GR_BACKEND;
    S.tf = S.tf || {};
    var c = S.tf[id] || (S.tf[id] = { state: null, at: 0, asking: false, failed: false, busy: false, phase: '', progress: '', none: false, timer: null });
    if (S.mode !== 'db' || !B || !B.tourFindState) { c.none = true; return c; }
    if (!c.asking && (fresh || !c.at)) {
      c.asking = true;
      B.tourFindState(id).then(function (st) {
        c.state = G.isObj(st) ? st : { status: 'idle', candidates: [] };
        c.failed = false; c.at = Date.now(); c.asking = false; tfAfter(id); render(true);
      }, function () {
        c.failed = true; c.at = Date.now(); c.asking = false;
        // Mid-read, a missed answer is asked again a little later.
        if (c.state && c.state.status === 'reading') { clearTimeout(c.timer); c.timer = setTimeout(function () { c.timer = null; c.at = 0; render(true); }, 8000); }
        render(true);
      });
    }
    return c;
  }
  // While the archives are being read, ask again every few seconds (each
  // ask also moves the read along); once they're in, read them.
  function tfAfter(id) {
    var c = S.tf && S.tf[id], st = c && c.state;
    if (!st) return;
    clearTimeout(c.timer); c.timer = null;
    if (st.status === 'reading') {
      c.timer = setTimeout(function () {
        c.timer = null;
        // Away from the page: stop asking, and make the next look a fresh one.
        if (S.route && S.route.name === 'act' && S.route.id === id) tfOf(id, true); else c.at = 0;
      }, 4000);
    } else if (st.status === 'ready' && !c.busy && !c.error && S.sample) {
      tfExtract(id);
    }
  }
  async function tfStart(id) {
    var B = window.GR_BACKEND, c = tfOf(id);
    if (c.busy) return;
    var before = c.state || {};
    c.busy = true; c.phase = 'Starting\u2026'; c.error = ''; render(true);
    try {
      c.state = await B.tourFindStart(id); c.failed = false; c.at = Date.now();
      // The server reads once a day; asked twice, it hands the same read back.
      if (before.day && c.state && c.state.day === before.day && before.status === c.state.status) toast('Already read today \u2014 look again tomorrow');
    } catch (e) { saveFailed('tours', e); }
    c.busy = false; c.phase = '';
    tfAfter(id); render(true);
  }
  // The reading brain's brief, one batch of articles at a time.
  function tfPrompt(name, pages) {
    var head = 'TOUR FINDER. You are helping a touring app list the tours of the act "' + name + '". Below are news articles and encyclopedia passages, each with its date and URL. ' +
      'Return ONLY a JSON array. Each item is one tour or run that ' + name + ' was part of: a headline or co-headline tour, a support slot on another act\u2019s tour, or a package/festival tour (Warped, Taste of Chaos). ' +
      'Fields: "name" (the announced tour name; if the run had no name, a short description such as "Fall 2018 run with Dance Gavin Dance"), ' +
      '"role" (one of headline, co-headline, support, festival), "start" and "end" (YYYY-MM-DD; when a listing gives month/day only, take the year from the article date, and remember a run announced in the fall may start the next year), ' +
      '"lineup" (the other acts, comma separated), "region" (US, UK/Europe, Australia, Japan, Canada\u2026), ' +
      '"dates" (every date listed for ' + name + ', each as one short string "YYYY-MM-DD | City, ST | Venue"; an empty array if none are listed), "source" (the article URL). ' +
      'Rules: only runs ' + name + ' is on; skip one-off festival appearances and anything that is not a tour (album news, videos, members leaving); when a later article updates an earlier one (dates added, moved or cancelled) fold them into one item; never invent dates; if nothing qualifies return [].\n\n';
    return head + pages.map(function (p, i) {
      return '--- ARTICLE ' + (i + 1) + ' | ' + (p.published || 'date unknown') + ' | ' + p.url + '\n' + (p.title ? p.title + '\n' : '') + p.body + '\n';
    }).join('\n');
  }
  // Wikipedia, read from the phone: the articles that mention the act, cut to the paragraphs that do.
  async function tfWikipedia(name) {
    if (window.__harness) return [];
    var out = [];
    try {
      var api = 'https://en.wikipedia.org/w/api.php?format=json&origin=*&action=query';
      var q = await fetch(api + '&list=search&srlimit=12&srsearch=' + encodeURIComponent('"' + name + '"')).then(function (r) { return r.json(); });
      var hits = (q && q.query && Array.isArray(q.query.search) ? q.query.search : []).map(function (x) { return x.title; });
      for (var i = 0; i < hits.length; i++) {
        var r = await fetch(api + '&prop=extracts&explaintext=1&titles=' + encodeURIComponent(hits[i])).then(function (x) { return x.json(); });
        var pages = r && r.query && r.query.pages ? r.query.pages : {};
        var pg = pages[Object.keys(pages)[0]];
        var about = pg ? G.paragraphsAbout(pg.extract, name) : '';
        if (about) out.push({ url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(hits[i].replace(/ /g, '_')), source: 'wikipedia', title: hits[i], published: null, body: about });
      }
    } catch (e) { /* Wikipedia is a bonus; the archives carry the day. */ }
    return out;
  }
  // One batch through the reader. An answer that doesn't parse (the reader
  // ran out of room) is asked again in two halves, down to one article.
  async function tfRead(name, batch) {
    try {
      return await S.sample.json(tfPrompt(name, batch), { cache: false });
    } catch (e) {
      if (e && (e.code === 'session_expired' || SAMPLE_GONE.indexOf(e.code) >= 0)) throw e;
      if (e && e.code === 'rate_limited') {
        await new Promise(function (r) { setTimeout(r, 4000); });
        try { return await S.sample.json(tfPrompt(name, batch), { cache: false }); } catch (e2) { if (e2 && (e2.code === 'session_expired' || SAMPLE_GONE.indexOf(e2.code) >= 0)) throw e2; }
      }
      if (batch.length > 1) {
        var mid = Math.ceil(batch.length / 2);
        var a = await tfRead(name, batch.slice(0, mid)), b = await tfRead(name, batch.slice(mid));
        return (Array.isArray(a) ? a : []).concat(Array.isArray(b) ? b : []);
      }
      return [];
    }
  }
  async function tfExtract(id) {
    var B = window.GR_BACKEND, c = tfOf(id);
    if (c.busy || !S.sample) return;
    var name = (actOf(id).card || {}).name || '';
    c.busy = true; c.phase = 'Sorting out the tours\u2026'; c.progress = ''; c.error = ''; render(true);
    try {
      var pages = await B.tourFindPages(id);
      if (pages === null) { c.error = 'Another phone is sorting the tours right now. Give it a few minutes.'; throw { code: 'busy' }; }
      var wiki = await tfWikipedia(name);
      // Small batches: the reader answers in full for a handful of articles
      // and runs out of room for twenty (that is how a first run came back
      // with one tour out of 137 articles).
      var all = pages.concat(wiki), batches = [], cur = [], size = 0;
      all.forEach(function (p) {
        var len = String(p.body || '').length + 200;
        if (cur.length && (size + len > 12000 || cur.length >= 6)) { batches.push(cur); cur = []; size = 0; }
        cur.push(p); size += len;
      });
      if (cur.length) batches.push(cur);
      // What earlier tries already read is kept: a Try again never re-spends it.
      var found = Array.isArray(c.found) ? c.found : (c.found = []);
      var done = c.doneBatches || (c.doneBatches = {});
      for (var i = 0; i < batches.length; i++) {
        var key = batches[i].map(function (p) { return p.url; }).join('|');
        if (done[key]) continue;
        c.progress = (i + 1) + ' of ' + batches.length; render(true);
        var out = await tfRead(name, batches[i]);
        if (Array.isArray(out)) found.push.apply(found, out);
        done[key] = true;
      }
      var hc = histOf(id), sum = hc.row && G.isObj(hc.row.summary) ? hc.row.summary : {};
      var all2 = G.mergeTourCandidates(found);
      var merged = all2.filter(function (x) { return !G.tourKnown(x.name, sum.toursList); })
        .map(function (x) { return { name: x.name, role: x.role, start: x.start, end: x.end, region: x.region, lineup: x.lineup, dates: x.dates, sources: x.sources }; });
      c.state = await B.tourFindPropose(id, merged);
      // How the reading went, kept on the server (so a run that ends with nothing can be understood).
      if (B.tourFindNote) { try { await B.tourFindNote(id, 'Read ' + all.length + ' articles in ' + batches.length + ' batches: ' + found.length + ' mentions, ' + all2.length + ' tours, ' + (all2.length - merged.length) + ' already on the page, ' + G.num(c.state && c.state.added) + ' new'); } catch (e) { /* a note, nothing more */ } }
      c.at = Date.now(); c.found = null; c.doneBatches = null;
    } catch (e) {
      if (!(e && e.code === 'busy')) c.error = e && e.code === 'session_expired' ? 'Sign in again to finish.' : 'Couldn\u2019t sort the tours just now.';
      if (e && SAMPLE_GONE.indexOf(e.code) >= 0) S.sample = null;
    }
    c.busy = false; c.phase = ''; c.progress = ''; render(true);
  }
  async function tfDecide(id, x, add, name) {
    var B = window.GR_BACKEND, c = tfOf(id);
    if (c.busy) return;
    c.busy = true; render(true);
    try {
      var st = await B.tourCandidateDecide(x.id, add, name || null);
      c.state = st;
      var did = G.num(st && st.renamed), put = G.num(st && st.inserted);
      toast(!add ? 'Left off'
        : did || put ? (name || x.name) + ' is on the page: ' + [did ? plural(did, 'show') + ' named' : null, put ? plural(put, 'date') + ' added' : null].filter(Boolean).join(', ')
        : (name || x.name) + ' is on the page, though those nights already had a name');
      if (add) histOf(id, true);
    } catch (e) { saveFailed('tours', e); }
    c.busy = false; render(true);
  }
  async function tfUndo(id, x) {
    var B = window.GR_BACKEND, c = tfOf(id);
    if (c.busy) return;
    c.busy = true; render(true);
    try { c.state = await B.tourCandidateUndo(x.id); toast(x.name + ' taken off'); histOf(id, true); }
    catch (e) { saveFailed('tours', e); }
    c.busy = false; render(true);
  }
  function tfSpan(a, b) {
    if (!G.parseDay(a) || !G.parseDay(b)) return '';
    var ya = a.slice(0, 4), yb = b.slice(0, 4);
    if (a === b) return dayMD(a) + ', ' + ya;
    return ya === yb ? dayMD(a) + ' \u2013 ' + dayMD(b) + ', ' + ya : dayMD(a) + ', ' + ya + ' \u2013 ' + dayMD(b) + ', ' + yb;
  }
  var TF_ROLE = { headline: 'Headliner', 'co-headline': 'Co-headliner', support: 'Support', festival: 'Festival tour' };
  // Add it under a name of your own (the one on the poster, say).
  function openTfRename(id, x) {
    var st = { name: x.name };
    openSheet(function () {
      var input = h('input', { class: 'input', type: 'text', maxlength: 120, value: st.name, 'aria-label': 'Tour name',
        oninput: function (e) { st.name = e.target.value; } });
      return [h('h2', { class: 'sh-title' }, 'Add this tour as\u2026'),
        h('p', { class: 'sh-sub' }, tfSpan(x.first, x.last) + (x.lineup ? ' \u00b7 with ' + x.lineup : '')),
        input,
        h('div', { class: 'stack', style: 'margin-top:14px' },
          h('button', { class: 'btn primary block', type: 'button', onclick: function () {
            var nm = String(st.name || '').replace(/\s+/g, ' ').trim();
            if (nm.length < 2) { toast('Give it a name'); return; }
            closeSheet(); tfDecide(id, x, true, nm);
          } }, 'Add to the page'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel'))];
    }, { label: 'Tour name' });
  }
  // A run of nights already on the page with no tour name: the owner names it in one go.
  function tfRunCard(id, run, cands, busy) {
    var nights = Array.isArray(run.nights) ? run.nights : [];
    var cities = nights.map(function (n) { return n.city; }).filter(Boolean);
    var where = cities.length ? cities[0] + (cities.length > 1 ? ' \u2192 ' + cities[cities.length - 1] : '') : '';
    // The found tours that fall on these dates are the likely names.
    var guesses = (cands || []).filter(function (c) { return c.status === 'new' && c.first && c.last && c.first <= run.last && run.first <= c.last; });
    return h('div', { class: 'tf-card tf-run' },
      h('p', { class: 'tf-name tf-run-t' }, tfSpan(run.first, run.last)),
      h('p', { class: 'tf-sub' }, plural(G.num(run.n), 'show') + (run.countries ? ' \u00b7 ' + run.countries : '') + (where ? ' \u00b7 ' + where : '')),
      guesses.length ? h('p', { class: 'tf-fit' }, 'Could be: ' + guesses.map(function (c) { return c.name; }).slice(0, 2).join(' or ')) : h('p', { class: 'tf-sub' }, 'No tour name on these nights yet'),
      h('div', { class: 'pt-two tf-acts' },
        h('button', { class: 'btn primary', type: 'button', disabled: busy, onclick: function () { openRunName(id, run, guesses); } }, 'Name this run')));
  }
  function openRunName(id, run, guesses) {
    var st = { name: guesses && guesses.length ? guesses[0].name : '' };
    openSheet(function () {
      var input = h('input', { class: 'input', type: 'text', maxlength: 120, value: st.name, placeholder: 'Tour name', 'aria-label': 'Tour name',
        oninput: function (e) { st.name = e.target.value; } });
      return [h('h2', { class: 'sh-title' }, 'Name this run'),
        h('p', { class: 'sh-sub' }, tfSpan(run.first, run.last) + ' \u00b7 ' + plural(G.num(run.n), 'show') + '. Every one of these nights takes the name.'),
        guesses && guesses.length ? h('div', { class: 'tf-guess' }, guesses.slice(0, 3).map(function (c) {
          return h('button', { class: 'pf-btn', type: 'button', onclick: function () { st.name = c.name; input.value = c.name; } }, c.name);
        })) : null,
        input,
        h('div', { class: 'stack', style: 'margin-top:14px' },
          h('button', { class: 'btn primary block', type: 'button', onclick: async function (e) {
            var nm = String(st.name || '').replace(/\s+/g, ' ').trim();
            if (nm.length < 2) { toast('Give it a name'); return; }
            var b = e.currentTarget; b.disabled = true;
            var B = window.GR_BACKEND, c = tfOf(id);
            try {
              var res = await B.tourRunName(id, run.first, run.last, nm);
              c.state = res; closeSheet();
              toast(plural(G.num(res && res.named), 'show') + ' named ' + nm);
              histOf(id, true); render(true);
            } catch (x) { b.disabled = false; saveFailed('tours', x); }
          } }, 'Name it'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel'))];
    }, { label: 'Name this run' });
  }
  // Posters and flyers (Devin: "every flyer"): the one source that always
  // carries the tour's name and its dates. Each image is read on its own.
  function tfPosterPrompt(name) {
    return 'TOUR FINDER. The attached image is a concert tour poster, flyer or admat. Today is ' + G.ymd(new Date()) + '. The act we care about is "' + name + '". ' +
      'Return ONLY a JSON array with one item per tour or run the poster announces that ' + name + ' is on (usually one). Fields: "name" (the tour name as printed; if none, a short description like "Fall 2018 run with Dance Gavin Dance"), ' +
      '"role" (headline, co-headline, support or festival), "start" and "end" (YYYY-MM-DD; when the poster has no year, pick the most likely year from the context and say so in "note"), ' +
      '"lineup" (the other acts), "region", "dates" (every date on the poster as "YYYY-MM-DD | City, ST | Venue"), "note" (anything uncertain). Never invent dates; if the image is not a tour poster return [].';
  }
  async function tfPosters(id, files) {
    var B = window.GR_BACKEND, c = tfOf(id);
    if (!S.sample) { toast('Reading isn\u2019t available right now.'); return; }
    if (c.busy) return;
    var name = (actOf(id).card || {}).name || '';
    c.busy = true; c.phase = 'Reading the posters\u2026'; c.progress = ''; c.error = ''; render(true);
    var found = [];
    try {
      for (var i = 0; i < files.length; i++) {
        c.progress = (i + 1) + ' of ' + files.length; render(true);
        try {
          var out = await S.sample.json(tfPosterPrompt(name), { images: [files[i]], cache: false });
          if (Array.isArray(out)) out.forEach(function (x) { if (G.isObj(x)) { x.sources = ['https://devinoliverofficial.github.io/greenroom/#poster']; found.push(x); } });
        } catch (e) {
          if (e && (e.code === 'session_expired' || SAMPLE_GONE.indexOf(e.code) >= 0)) throw e;
          // One poster the reader couldn't make out is skipped.
        }
      }
      var hc = histOf(id), sum = hc.row && G.isObj(hc.row.summary) ? hc.row.summary : {};
      var merged = G.mergeTourCandidates(found).map(function (x) { return { name: x.name, role: x.role, start: x.start, end: x.end, region: x.region, lineup: x.lineup, dates: x.dates, sources: x.sources }; });
      if (!merged.length) { toast('No tour dates found on ' + (files.length === 1 ? 'that poster' : 'those posters')); }
      else {
        var st = await B.tourFindPropose(id, merged);
        c.state = st; c.at = Date.now();
        toast(plural(G.num(st && st.added), 'tour') + ' from ' + plural(files.length, 'poster') + (G.num(st && st.added) < merged.length ? ' (the rest were already on the page)' : ''));
      }
    } catch (e) {
      c.error = e && e.code === 'session_expired' ? 'Sign in again to finish.' : 'Couldn\u2019t read the posters just now.';
      if (e && SAMPLE_GONE.indexOf(e.code) >= 0) S.sample = null;
    }
    c.busy = false; c.phase = ''; c.progress = ''; render(true);
  }
  function tfPosterButton(id, busy) {
    if (!S.sample) return null;
    return fileControl({ accept: imageAccept(), multiple: true, cls: 'btn ghost block', icon: 'plus',
      label: 'Add from posters', ariaLabel: 'Add tours from poster photos',
      onFiles: function (files) { tfPosters(id, files.slice(0, 20)); } });
  }
  function tfCandCard(id, x, busy) {
    var what = [TF_ROLE[x.role] || null, x.lineup ? 'with ' + x.lineup : null].filter(Boolean).join(' \u00b7 ');
    var toAdd = x.toAdd == null ? G.num(x.n) : G.num(x.toAdd);
    var fit = G.num(x.matched) > 0 ? plural(G.num(x.matched), 'unnamed show') + ' on the page fall in these dates' + (toAdd ? ', ' + plural(toAdd, 'announced date') + ' to add' : '')
      : toAdd > 0 ? plural(toAdd, 'announced date') + ' to add'
      : G.num(x.have) > 0 ? 'These dates are already on the page under another name' : 'No dates listed';
    return h('div', { class: 'tf-card' + (x.fill ? ' tf-fill' : '') },
      x.fill ? h('p', { class: 'tf-kicker' }, 'Already on the page \u2014 fill in its dates') : null,
      h('button', { class: 'tf-name', type: 'button', 'aria-label': 'Change the name: ' + x.name, onclick: function () { openTfRename(id, x); } },
        h('span', { class: 'tf-name-t' }, x.name), icon('chevron', 14)),
      h('p', { class: 'tf-sub' }, tfSpan(x.first, x.last) + (x.region ? ' \u00b7 ' + x.region : '')),
      what ? h('p', { class: 'tf-sub' }, what) : null,
      h('p', { class: 'tf-fit' }, fit),
      h('div', { class: 'pt-two tf-acts' },
        h('button', { class: 'btn primary', type: 'button', disabled: busy, onclick: function () { tfDecide(id, x, true); } }, 'Add'),
        h('button', { class: 'btn ghost', type: 'button', disabled: busy, onclick: function () { tfDecide(id, x, false); } }, 'Not ours')));
  }
  function tourFinderBlock(id, card, manage, unclaimed) {
    if (!manage && !(unclaimed && claimQ().list)) return null;
    if (!(manage ? card.verified : true) || !histOf(id).row) return null;
    var c = tfOf(id);
    if (c.none) return null;
    var st = c.state || {}, status = c.state ? (st.status || 'idle') : (c.failed ? 'failed' : 'loading');
    // A read left mid-way (the page was closed) picks up where it was; the
    // articles are read as soon as the reading brain is here.
    if ((status === 'reading' && !c.timer && !c.asking) || (status === 'ready' && !c.busy && !c.error && S.sample)) tfAfter(id);
    if (status === 'extracting' && !c.busy) status = 'ready';
    var cands = Array.isArray(st.candidates) ? st.candidates : [];
    var fresh = cands.filter(function (x) { return x.status === 'new'; });
    var added = cands.filter(function (x) { return x.status === 'added'; });
    var findBtn = function (label) {
      return h('button', { class: 'btn primary block', type: 'button', disabled: c.busy, onclick: function () { tfStart(id); } }, icon('search', 18), label);
    };
    var body;
    if (status === 'loading') body = h('p', { class: 'note tf-status' }, 'Looking\u2026');
    else if (status === 'failed') body = h('button', { class: 'btn ghost block', type: 'button', onclick: function () { tfOf(id, true); render(true); } }, 'Try again');
    else if (status === 'idle' || status === 'error') {
      var idleRuns = Array.isArray(st.runs) ? st.runs : [];
      body = [status === 'error' ? h('p', { class: 'note bad' }, st.detail || 'That read didn\u2019t finish.') : null, findBtn(status === 'error' ? 'Try again' : 'Find missing tours'),
        tfPosterButton(id, c.busy),
        idleRuns.length ? [h('h4', { class: 'tf-h2' }, 'Nights on the page with no tour name'),
          h('p', { class: 'note tf-p' }, 'setlist.fm has these shows but nobody named the tour. Name a run and every night in it is filed under it.'),
          idleRuns.map(function (r) { return tfRunCard(id, r, cands, c.busy); })] : null];
    } else if (status === 'reading') {
      var srcs = st.sources || {};
      body = h('p', { class: 'tf-status' }, h('span', { class: 'tf-dot', 'aria-hidden': 'true' }),
        'Reading tour announcements\u2026 ' + plural(G.num(st.pages), 'article') +
        (G.num(srcs.sites) ? ' from ' + G.num(srcs.sitesWithNews) + ' of ' + (G.num(srcs.sites) + 2) + ' sites so far' : '') +
        (G.num(st.waiting) > 0 ? ', ' + st.waiting + ' to go' : ''));
    } else if (status === 'ready' || (c.busy && c.phase)) {
      body = c.busy ? h('p', { class: 'tf-status' }, h('span', { class: 'tf-dot', 'aria-hidden': 'true' }), c.phase + (c.progress ? ' ' + c.progress : ''))
        : S.sample && !c.error ? h('p', { class: 'tf-status' }, h('span', { class: 'tf-dot', 'aria-hidden': 'true' }), 'Sorting out the tours\u2026')
        : [h('p', { class: 'note bad' }, c.error || 'Reading isn\u2019t available right now.'),
           h('button', { class: 'btn ghost block', type: 'button', onclick: function () { c.error = ''; tfExtract(id); } }, 'Try again')];
    } else {
      var runs = Array.isArray(st.runs) ? st.runs : [];
      body = [
        c.error ? h('p', { class: 'note bad' }, c.error) : null,
        st.sources && st.sources.lambgoat === 'none' && G.num(st.pages) > 0 ? h('p', { class: 'note' }, 'One of the two archives didn\u2019t answer this time; the other was read.') : null,
        fresh.length ? fresh.map(function (x) { return tfCandCard(id, x, c.busy); })
          : h('p', { class: 'note' }, st.detail || (added.length ? 'Nothing else found in the announcements.' : 'Nothing found in the announcements that isn\u2019t already on the page.')),
        runs.length ? [h('h4', { class: 'tf-h2' }, 'Nights on the page with no tour name'),
          h('p', { class: 'note tf-p' }, 'setlist.fm has these shows but nobody named the tour. Name a run and every night in it is filed under it.'),
          runs.map(function (r) { return tfRunCard(id, r, cands, c.busy); })] : null,
        added.length ? h('details', { class: 'tf-added' },
          h('summary', null, plural(added.length, 'tour') + ' added from here'),
          added.map(function (x) {
            return h('div', { class: 'row tf-added-row' },
              h('div', { class: 'row-label' }, x.name, h('span', { class: 'hint' }, tfSpan(x.first, x.last))),
              h('button', { class: 'pf-btn', type: 'button', disabled: c.busy, onclick: function () { tfUndo(id, x); } }, 'Take off'));
          })) : null,
        tfPosterButton(id, c.busy),
        st.day && st.today && st.day !== st.today ? findBtn('Look again') : h('p', { class: 'note tf-again' }, 'The archives are read once a day. Come back tomorrow to look again.')
      ];
    }
    return h('section', { class: 'tf-block', 'aria-label': 'Add missing tours' },
      h('h3', { class: 'mn-h mn-over tf-h' }, 'Add missing tours'),
      h('p', { class: 'note tf-p' }, 'Tours setlist.fm never named. Greenroom reads the tour announcements and lists what it finds; you say which are yours, and they go on the page.'),
      body);
  }

  function historyBlock(id, manage, tours) {
    var c = histOf(id);
    var row = c.row;
    var sum = row && G.isObj(row.summary) ? row.summary : null;
    var has = !!(sum && G.num(sum.shows) > 0);
    var tier = has ? G.historyTier(sum) : null;
    var since = has && G.num(sum.firstYear) > 0 ? G.num(sum.firstYear) : 0;
    if (!since) {
      var today = G.tourToday();
      (tours || []).forEach(function (t) {
        // Only a tour that has started counts: no "since next year".
        if (!t.first || String(t.first) > today) return;
        var y = parseInt(String(t.first).slice(0, 4), 10);
        if (y > 1900 && (!since || y < since)) since = y;
      });
    }
    return [
      tier || since ? h('p', { class: 'hist-line' },
        tier ? h('span', { class: 'hist-tier tier-' + tier.key }, tier.label) : null,
        since ? 'On the road since ' + since : null) : null,
      // While the history is still reading in, the owner sees how far along
      // it is; so does anyone, on a page Greenroom is reading by itself.
      (manage && row && !has) || histBusy(row) || (row && row.auto && row.status === 'error') ? h('p', { class: 'hist-note' }, histStatusLine(row)) : null
    ];
  }
  // Their data, their credit: one quiet line at the foot of a page that
  // shows setlist.fm's numbers (their terms ask for the link; only their
  // own address is trusted in it).
  function historyCredit(id) {
    var c = histOf(id), row = c.row;
    var sum = row && G.isObj(row.summary) ? row.summary : null;
    if (!(sum && G.num(sum.shows) > 0)) return null;
    return setlistCredit(row.mb_url);
  }
  function setlistCredit(url) {
    return h('p', { class: 'hist-credit' }, 'Tour data: ',
      h('a', { class: 'hist-src', target: '_blank', rel: 'noopener',
        href: /^https:\/\/www\.setlist\.fm\//.test(String(url || '')) ? url : 'https://www.setlist.fm' },
        'setlist.fm'));
  }
  // The owner's switchboard: the key, and the switch per artist page. The
  // sheet reads the key row and the history row itself, and redraws when
  // the answers land (the first open would otherwise race them).
  function openHistorySheet(id, name) {
    var B = window.GR_BACKEND;
    var host = h('div');
    var got = { done: false, key: null, row: null };
    function load() {
      Promise.all([
        B && B.setlistState ? B.setlistState().catch(function () { return null; }) : Promise.resolve(null),
        B && B.artistHistory ? B.artistHistory(id).catch(function () { return null; }) : Promise.resolve(null)
      ]).then(function (ans) {
        got.done = true; got.key = ans[0]; got.row = ans[1];
        var card0 = S.actCards && S.actCards[id] && S.actCards[id].card;
        got.verified = !card0 || card0.verified !== false;
        // Keep the page's own caches in step.
        if (S.setlist) { S.setlist.row = ans[0]; S.setlist.none = !ans[0]; S.setlist.at = Date.now(); }
        if (S.histCards && S.histCards[id]) { S.histCards[id].row = ans[1]; S.histCards[id].at = Date.now(); }
        draw();
      });
    }
    function draw() {
      var kids = [];
      if (!got.done) {
        kids.push(h('p', { class: 'note' }, 'Looking…'));
      } else if (got.row && got.row.auto) {
        // Greenroom reads this one with its own key: nothing to paste.
        kids.push(h('p', { class: 'note' }, histStatusLine(got.row) || 'Greenroom keeps this page\u2019s road story up to date by itself.'));
        kids.push(h('div', { class: 'stack' },
          h('button', { class: 'btn primary block', type: 'button', disabled: histBusy(got.row) || null, onclick: async function (e) {
            var b = e.currentTarget; b.disabled = true;
            try { await B.historyNudge(id, true); } catch (x) { b.disabled = false; saveFailed('history', x); return; }
            histOf(id, true); closeSheet(); toast('Reading it fresh');
          } }, 'Sync fresh')));
        kids.push(h('p', { class: 'note' }, 'Fan-logged data from ',
          h('a', { class: 'hist-src', href: 'https://www.setlist.fm', target: '_blank', rel: 'noopener' }, 'setlist.fm'),
          ' — a missing night just hasn’t been logged there yet.'));
      } else if (!got.row && !got.verified) {
        // A page made by hand isn't tied to a known act, so it can't borrow one's road story.
        kids.push(h('p', { class: 'note' }, 'Tour history is for verified pages, so nobody can borrow another band\u2019s road story. ' +
          'Find ' + (name || 'the act') + ' in Search and claim its page: that one comes with its history.'));
      } else if (!got.key) {
        kids.push(
          h('p', { class: 'note' }, 'First, the key: sign in at setlist.fm, then Settings → API. It’s free and instant.'),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'button',
              onclick: function () { openSetlistConnect(false, id, name); } }, 'Paste the setlist.fm key')));
      } else {
        kids.push(h('p', { class: 'note' }, got.key.status === 'bad_token'
          ? 'setlist.fm refused the key. Paste a fresh one.'
          : 'Key saved — stored where only Greenroom’s server can read it.'));
        if (!got.row) {
          kids.push(h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'button', onclick: async function (e) {
              var b = e.currentTarget; b.disabled = true;
              try { await B.historyStart(id); } catch (x) { b.disabled = false; saveFailed('history', x); return; }
              histOf(id, true); closeSheet();
              toast('On — the first numbers land within minutes');
            } }, 'Turn on for ' + (name || 'this artist')),
            h('button', { class: 'btn ghost block', type: 'button',
              onclick: function () { openSetlistConnect(true, id, name); } }, 'Replace the key')));
        } else {
          kids.push(h('p', { class: 'note' }, histStatusLine(got.row)));
          kids.push(h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'button', onclick: async function (e) {
              var b = e.currentTarget; b.disabled = true;
              try { await B.historyStart(id); } catch (x) { b.disabled = false; saveFailed('history', x); return; }
              histOf(id, true); closeSheet(); toast('Reading it fresh');
            } }, 'Sync fresh'),
            h('button', { class: 'btn ghost block', type: 'button',
              onclick: function () { openSetlistConnect(true, id, name); } }, 'Replace the key'),
            h('button', { class: 'btn danger block', type: 'button', onclick: function () {
              confirmSheet({ title: 'Turn off tour history?', body: 'The numbers come off ' + (name || 'the page') +
                  '. Switch it back on any time — the road story reads back in fresh within a couple of hours.',
                action: 'Turn off', danger: true,
                onConfirm: async function () {
                  try { await B.historyStop(id); histOf(id, true); toast('Tour history off'); return true; }
                  catch (e) { saveFailed('history', e); return false; }
                } });
            } }, 'Turn off')));
        }
        // Their data, their credit — the link rides along in the sheet too.
        kids.push(h('p', { class: 'note' }, 'Fan-logged data from ',
          h('a', { class: 'hist-src', href: 'https://www.setlist.fm', target: '_blank', rel: 'noopener' }, 'setlist.fm'),
          ' — a missing night just hasn’t been logged there yet.'));
      }
      fillEl(host, kids);
    }
    draw(); load();
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'Tour history'),
        h('p', { class: 'sh-sub' }, 'The band’s whole road story — every show, tour, country and city — ' +
          'read from setlist.fm, the fans’ setlist archive, and counted on the page by itself.'),
        host
      ];
    }, { label: 'Tour history' });
  }
  // The key goes in once and can never be read back out of the app.
  function openSetlistConnect(hasKey, artistId, name) {
    var B = window.GR_BACKEND;
    openSheet(function () {
      var input = h('input', { class: 'input', type: 'password', autocomplete: 'off', autocapitalize: 'none',
        placeholder: 'setlist.fm API key', 'aria-label': 'setlist.fm API key' });
      return [
        h('h2', { class: 'sh-title' }, hasKey ? 'Replace the setlist.fm key' : 'Connect setlist.fm'),
        h('p', { class: 'sh-sub' }, 'From setlist.fm: sign in, then Settings → API → your API key.'),
        h('p', { class: 'note' }, 'It’s stored where only Greenroom’s server can read it — the app (and anyone in it) can’t get it back out.'),
        input,
        h('div', { class: 'stack', style: 'margin-top:14px' },
          h('button', { class: 'btn primary block', type: 'button', onclick: async function (e) {
            var tok = input.value.trim();
            if (!tok) { toast('Paste the key first.'); return; }
            var b = e.currentTarget; b.disabled = true;
            try { await B.setlistConnect(tok); } catch (x) { b.disabled = false; saveFailed('history', x); return; }
            setlistInfo(true);
            closeSheet();
            if (artistId) openHistorySheet(artistId, name);
            else toast('Key saved');
          } }, 'Save'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel'))
      ];
    }, { label: 'Connect setlist.fm' });
  }

  function openActEdit(id, keep) {
    var B = window.GR_BACKEND;
    var card = S.actCards && S.actCards[id] && S.actCards[id].card;
    if (!card) return;
    var f = G.isObj(keep) ? keep : { name: card.name, handle: card.handle, handleOk: true, bio: card.bio || '' };
    openSheet(function () {
      var save = h('button', { class: 'btn primary block', type: 'submit' }, 'Save');
      var ready = function () { save.disabled = !(String(f.name).trim() && (f.handle === card.handle || f.handleOk)); };
      var hf = handleField(f, function (v) { return v === card.handle ? Promise.resolve(true) : B.artistHandleFree(v, id); }, ready);
      var count = h('span', { class: 'pe-count num' }, f.bio.length + ' / ' + BIO_MAX);
      ready();
      return [
        h('h2', { class: 'sh-title pe-title' }, 'Edit artist'),
        h('form', { class: 'sh-form pe-form', novalidate: true,
          onsubmit: async function (e) {
            e.preventDefault();
            if (save.disabled) return;
            blurActive();
            try {
              await B.saveArtist(id, { name: f.name, handle: f.handle, bio: f.bio });
              actOf(id, true); myActs(true);
              closeSheet(); toast('Artist saved');
            } catch (x) {
              if (x && x.code === 'taken') toast('@' + f.handle + ' is taken. Try another.');
              else if (x && x.code === 'shape') toast('That username can\u2019t be used. Try another.');
              else saveFailed('artist', x);
            }
          } },
          h('div', { class: 'pe-rows' },
            h('label', { class: 'pe-row' }, h('span', { class: 'pe-label' }, 'Name'),
              h('span', { class: 'pe-val' }, h('input', { class: 'pe-in', type: 'text', value: f.name, maxlength: 60,
                oninput: function (e) { f.name = e.target.value; ready(); } }))),
            h('label', { class: 'pe-row' }, h('span', { class: 'pe-label' }, 'Username'),
              h('span', { class: 'pe-val' }, h('span', { class: 'pe-at' }, h('span', { 'aria-hidden': 'true' }, '@'), hf.input), hf.said)),
            h('label', { class: 'pe-row' }, h('span', { class: 'pe-label' }, 'Bio'),
              h('span', { class: 'pe-val' }, h('textarea', { class: 'pe-in pe-bio', maxlength: BIO_MAX, rows: 2, placeholder: 'A line or two about the artist', value: f.bio,
                oninput: function (e) { f.bio = e.target.value; count.textContent = f.bio.length + ' / ' + BIO_MAX; } }), count))),
          h('div', { class: 'stack' },
            save,
            h('button', { class: 'btn danger block', type: 'button', onclick: function () {
              confirmSheet({ title: 'Delete ' + card.name + '\u2019s profile?',
                body: 'The artist profile and its band and crew lists go. Anyone it endorsed keeps the endorsement. Your tours are not touched.',
                action: 'Delete artist profile', danger: true,
                onConfirm: async function () {
                  try {
                    await B.deleteArtist(id); delete S.actCards[id];
                    if (S.actAs === id) setActingAs(null); // back on your own account
                    if (S.acts && S.acts.list) S.acts.list = S.acts.list.filter(function (x) { return x.id !== id; });
                    myActs(true); go({ name: 'home' }); toast('Artist profile deleted'); return true;
                  }
                  catch (x) { saveFailed('artist', x); return false; }
                } });
            } }, icon('trash', 18), 'Delete artist profile'),
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel')))
      ];
    }, { label: 'Edit artist', cls: 'pe-sheet' });
  }

  /* MERCHROOM (MODEL7MERCH): the merch table's own room. Phase 0: the band's
     Square account, connected by a token that Greenroom can write but never
     read back, synced by the server every few minutes; each night's card
     sales and tips land on that night's show by themselves. Sandbox (test
     mode) only for now: fake money until the real account is blessed. */
  function squareInfo(fresh) {
    var B = window.GR_BACKEND;
    var c = S.square || (S.square = { row: null, nights: [], at: 0, asking: false, failed: false, none: false });
    if (S.mode !== 'db' || !B || !B.squareState) { c.none = true; return c; }
    if (!c.asking && (fresh || Date.now() - c.at > 60e3)) {
      c.asking = true;
      Promise.all([B.squareState(), B.squareNights()]).then(function (got) {
        c.row = got[0]; c.nights = got[1] || []; c.none = !got[0];
        c.at = Date.now(); c.asking = false; c.failed = false; render();
      }).catch(function () { c.asking = false; c.failed = true; c.at = Date.now(); render(); });
    }
    return c;
  }
  // Card taps land in UTC; a show night is picked by pulling the clock back
  // ten hours (the night turns over at 6am New York / 3am LA), the same rule
  // the server uses to lay them on the show.
  function squareNightsRows(nights) {
    var by = {};
    nights.forEach(function (p) {
      if (p.status && p.status !== 'COMPLETED') return;
      // Same rule as the server: pull back ten hours, then take the UTC date.
      var k = new Date(new Date(p.created_at).getTime() - 10 * 3600e3).toISOString().slice(0, 10);
      var b = by[k] || (by[k] = { sales: 0, tips: 0, taps: 0 });
      b.sales += G.num(p.amount) - G.num(p.refunded); b.tips += G.num(p.tip); b.taps += 1;
    });
    var days = Object.keys(by).sort().reverse();
    return days.map(function (d) {
      var b = by[d];
      // The show that night, if one of your tours has it.
      var city = '';
      allTourEntries().some(function (e) {
        return G.rows(e[1].shows).some(function (x) {
          if (x.date !== d) return false;
          city = String(x.city || '').split(',')[0]; return true;
        });
      });
      return h('div', { class: 'row' },
        h('div', { class: 'row-label' }, dayMD(d) + (city ? ' \u00b7 ' + city : ''),
          h('span', { class: 'hint' }, plural(b.taps, 'tap') + ' \u00b7 ' + money(b.tips) + ' tips' + (city ? ' \u00b7 on the show' : ''))),
        h('span', { class: 'amt num' }, money(b.sales)));
    });
  }
  function viewMerchroom() {
    var backTo = S.route.back || { name: 'mainmenu', back: { name: 'home' } };
    var c = squareInfo();
    var row = c.row;
    var ago = row && row.last_sync ? feedAgo(row.last_sync) : 'not yet';
    var statusLine = c.failed ? 'Couldn\u2019t check Square just now. It tries again on its own.'
      : !row ? ''
      : row.status === 'bad_token' ? 'Square refused the token. Paste a fresh one.'
      : row.status === 'error' ? (row.detail || 'Square had trouble. It tries again every few minutes.')
      : row.status === 'new' || !row.location_id ? 'Connecting\u2026 first sync lands within five minutes.'
      : (row.location_name || row.merchant || 'Connected') + ' \u00b7 synced ' + ago;
    var body;
    if (c.none && !row && !c.failed) {
      body = [
        h('div', { class: 'mr-card' },
          h('h3', { class: 'mr-t' }, 'Square', h('span', { class: 'mr-badge' }, 'TEST')),
          h('p', { class: 'mr-p' }, 'The card reader for the merch table. The band\u2019s own Square account takes the money \u2014 fans to Square to the bank, never through Greenroom \u2014 and every tap shows up here on its night, tips and all.'),
          h('p', { class: 'mr-p' }, 'Right now this is Square\u2019s test world: pretend cards, pretend money, zero risk.'),
          h('button', { class: 'btn primary block', type: 'button', onclick: function () { openSquareConnect(); } },
            icon('card', 18), 'Connect Square (test)'))
      ];
    } else {
      var nights = squareNightsRows(c.nights);
      body = [
        h('div', { class: 'mr-card' },
          h('h3', { class: 'mr-t' }, 'Square',
            row && row.env !== 'production' ? h('span', { class: 'mr-badge' }, 'TEST') : null),
          h('p', { class: 'mr-p' + (row && (row.status === 'bad_token' || row.status === 'error') ? ' bad' : '') },
            c.asking && !row ? 'Looking\u2026' : statusLine || 'Not connected yet.'),
          h('div', { class: 'pt-two' },
            c.failed && !row ? h('button', { class: 'pf-btn', type: 'button', onclick: function () { squareInfo(true); render(true); } }, 'Try again')
              : h('button', { class: 'pf-btn', type: 'button', onclick: function () { openSquareConnect(row); } },
                  row ? 'Replace token' : 'Connect'),
            row ? h('button', { class: 'pf-btn', type: 'button', onclick: function () {
              confirmSheet({ title: 'Disconnect Square?', body: 'Greenroom stops reading the account. Nights already on your shows stay.',
                action: 'Disconnect', danger: true,
                onConfirm: async function () {
                  try { await window.GR_BACKEND.squareDisconnect(); squareInfo(true); toast('Square disconnected'); return true; }
                  catch (e) { saveFailed('square', e); return false; }
                } });
            } }, 'Disconnect') : null)),
        nights.length ? [h('h3', { class: 'mn-h mn-over' }, 'Nights'), h('div', { class: 'ledger' }, nights)]
          : row && row.status === 'ok' ? h('p', { class: 'note' }, 'No card taps read yet. The first sale shows up within five minutes of being rung.') : null
      ];
    }
    return h('div', { class: 'page home profile menu-page has-tabs' },
      menuHead('Merchroom', { menu: true }),
      dbBanner(),
      body,
      socialBar(''));
  }
  // The token goes in once and can never be read back out of the app.
  function openSquareConnect(row) {
    var B = window.GR_BACKEND;
    openSheet(function () {
      var input = h('input', { class: 'input', type: 'password', autocomplete: 'off', autocapitalize: 'none',
        placeholder: 'Sandbox access token', 'aria-label': 'Square sandbox access token' });
      return [
        h('h2', { class: 'sh-title' }, row ? 'Replace the Square token' : 'Connect Square'),
        h('p', { class: 'sh-sub' }, 'From developer.squareup.com: open your application, switch the dashboard to Sandbox, and copy the Sandbox access token.'),
        h('p', { class: 'note' }, 'It\u2019s stored where only Greenroom\u2019s server can read it \u2014 the app (and anyone in it) can\u2019t get it back out. Test mode reads fake money only.'),
        input,
        h('div', { class: 'stack', style: 'margin-top:14px' },
          h('button', { class: 'btn primary block', type: 'button', onclick: async function (e) {
            var tok = input.value.trim();
            if (!tok) { toast('Paste the token first.'); return; }
            var b = e.currentTarget; b.disabled = true;
            try { await B.squareConnect(tok); } catch (x) { b.disabled = false; saveFailed('square', x); return; }
            closeSheet(); squareInfo(true); toast('Connected \u2014 first sync lands within five minutes');
          } }, 'Save'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel'))
      ];
    }, { label: 'Connect Square' });
  }

  /* ---- The bar along the bottom of the social pages. ----
     Search on the left, your own photo on the right: the photo takes you to
     your profile from anywhere. (Inside a tour, the tour's own tabs sit
     there instead.) More doors can join these two later. */
  /* The bar along the bottom of every page: your photo dead centre, and one
     tap on it always brings you home to your profile (on your profile, back
     to its top). Whatever tabs the page has sit either side of it. */
  function homeFace(current) {
    var me = myCard(), who = profileName(), on = current === 'me';
    // On an artist account, the artist's photo, and home is its page.
    var act = actingCard();
    var photo = act ? String(act.avatar || '') : me.photo;
    var letter = act ? String(act.name || act.handle || '?') : who;
    var face = h('span', { class: 'sb-face' + (photo ? ' has' : '') + (on ? ' on' : ''), 'aria-hidden': 'true' },
      photo ? h('img', { src: photo, alt: '' }) : (letter.trim().charAt(0).toUpperCase() || '?'));
    var b = tabButton(on, act ? 'Your artist page' : 'Your profile', null, function () {
      if (act ? (S.route && S.route.name === 'act' && S.route.manage && S.route.id === act.id) : (S.route && S.route.name === 'home')) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else go(PF_HOME); // back where you were on it (the artist's page, on an artist account)
    }, face);
    b.classList.add('dock-me');
    return b;
  }
  function actingSig() { var a = actingCard(); return a ? a.id + ':' + String(a.avatar || '').length + ':' + (a.name || '') : ''; }
  function dock(left, right, current, sig, o) {
    o = o || {};
    var me = myCard();
    return h('nav', { class: 'tabbar dock' + (o.cls ? ' ' + o.cls : ''), 'aria-label': o.label || 'Greenroom',
      'data-sig': 'dock|' + sig + '|' + current + '|' + me.photo.length + '|' + profileName() + '|' + actingSig() },
      h('div', { class: 'dock-half left' }, left), homeFace(current), h('div', { class: 'dock-half right' }, right));
  }
  // The social pages' bar: Search on the left of your photo, and on its right
  // a shortcut to the Overview of the tour you're on (the one the profile's
  // Today follows).
  function socialBar(current) {
    var search = socialOn() ? tabButton(current === 'search', 'Search', 'search', function () {
      // The magnifying glass opens Search without the keyboard (Devin, 2026-10-08): tap the box to type.
      if (current !== 'search') go({ name: 'search', back: S.route });
    }) : null;
    var tid = profileTourId();
    var overview = tid ? tabButton(false, 'Overview', 'tabmap', function () { openTour(tid, 'details', S.route, 'Back'); }) : null;
    return dock([search], [overview], current, 'social|' + (tid || ''), { cls: 'social-bar' });
  }
  /* Search, the way a social app does it: a back arrow and one rounded box
     across the top. Before you type, it lists what you opened lately
     (Recent), each with an x to drop it; a search you sent with the Search
     key is kept there too, under a clock. As you type, people, artist
     profiles and tours fill in under the box without the keyboard dropping.
     Opening anything from here puts it at the top of Recent. */
  function recentKey() { var B = window.GR_BACKEND; return 'gr-recent:' + ((B && B.uid && B.uid()) || 'me'); }
  function recents() {
    try { var a = JSON.parse(lsGet(recentKey()) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function remember(item) {
    var list = recents().filter(function (x) { return !(x.kind === item.kind && x.id === item.id); });
    list.unshift(item);
    // Kept short: each one carries its picture.
    while (list.length > 12 || (list.length > 1 && !lsSet(recentKey(), JSON.stringify(list)))) list.pop();
    lsSet(recentKey(), JSON.stringify(list));
  }
  function forget(item) {
    lsSet(recentKey(), JSON.stringify(recents().filter(function (x) { return !(x.kind === item.kind && x.id === item.id); })));
  }
  function viewSearch() {
    var B = window.GR_BACKEND, backTo = S.route.back || { name: 'home' };
    var st = S.search || (S.search = { q: '', seq: 0, res: null, busy: false, all: false });
    var results = h('div', { class: 'sr-results' });
    var followers = function (n) { n = G.num(n); return n + (n === 1 ? ' follower' : ' followers'); };
    var span = function (t) {
      return t.first ? dayMD(t.first) + (t.last && t.last !== t.first ? ' \u2013 ' + dayMD(t.last) : '') + ', ' + String(t.last || t.first).slice(0, 4) : 'No dates yet';
    };
    // Everything a row needs to be drawn, opened, and kept in Recent.
    var asItem = {
      person: function (p) {
        var roles = personRoles(p);
        return { kind: 'person', id: p.userId, title: p.handle || p.name || 'Someone', verified: !!p.verified, avatar: p.avatar || '', letter: p.name,
          sub: p.handle ? [p.name, p.iFollow ? 'Following' : followers(p.followers)].filter(Boolean).join(' \u00b7 ') : roles.join(' \u00b7 '),
          canOpen: !!p.canOpen };
      },
      // A page nobody runs has no username of its own: the act's name leads.
      artist: function (a) {
        var bare = machineHandle(a.handle);
        // Whether anyone runs the page is the server's to say; only a list
        // that doesn't say is read by the username.
        var ghost = a.unclaimed != null ? !!a.unclaimed : bare;
        return ghost
          ? { kind: 'artist', id: a.id, title: a.name, name: a.name, sub: [a.about, 'Artist', 'Unclaimed'].filter(Boolean).join(' \u00b7 '), avatar: '', letter: a.name }
          : { kind: 'artist', id: a.id, title: bare ? a.name : a.handle, name: a.name, sub: bare ? 'Artist' : [a.name, 'Artist'].join(' \u00b7 '), avatar: a.avatar || '', letter: a.name };
      },
      // An act the encyclopedia knows that has no page on Greenroom yet.
      mb: function (m) {
        return { kind: 'mb', id: m.mbid, title: m.name, sub: [m.about, regionName(m.country), 'Artist'].filter(Boolean).join(' \u00b7 '), letter: m.name };
      },
      folder: function (a) { return { kind: 'folder', id: a, title: a, sub: 'Your artist folder', avatar: artistLogo(a) || '', letter: a, logo: true }; },
      tour: function (t) {
        return { kind: 'tour', id: t.id, title: t.name || 'Untitled tour', sub: [t.artist, span(t)].filter(Boolean).join(' \u00b7 '),
          avatar: (t.artist && artistLogo(t.artist)) || '', letter: t.artist || t.name, logo: true, artistId: t.artistId || null, artist: t.artist || '' };
      },
      term: function (q) { return { kind: 'term', id: q.toLowerCase(), title: q, sub: 'Search' }; }
    };
    // Opening an act that has no page yet makes its page (unclaimed, run by
    // nobody) and goes there. Recent then keeps the page, not the lookup.
    var openMb = function (it) {
      if (st.opening === it.id) return;   // this one is already on its way
      st.opening = it.id;                 // the latest tap wins: an answer to an earlier one no longer navigates
      var redraw = function () { if (results.isConnected) paint(); else if (S.route && S.route.name === 'search') render(true); };
      var mine = function () { if (st.opening !== it.id) return false; st.opening = ''; return true; };
      redraw();                           // its row reads "Opening…"
      B.openMbArtist(it.id, it.title).then(function (r) {
        if (r && r.id) remember({ kind: 'artist', id: r.id, title: it.title, name: it.title, sub: 'Artist', avatar: '', letter: it.title, unclaimed: true });
        if (!mine()) return;
        if (!r || !r.id) { toast('Couldn\u2019t open that page. Try again.'); redraw(); return; }
        // Only while they're still waiting here: an answer never pulls someone
        // off another page, or shuts a sheet opened since.
        if (!S.route || S.route.name !== 'search') { st.res = null; st.mb = null; return; }
        if (sheet) { redraw(); return; }
        st.res = null; st.mb = null;   // the next search finds the page itself
        openAct(r.id);
      }, function (e) {
        if (!mine()) return;
        toast(e && e.code === 'too-many' ? 'That\u2019s a lot of new pages for one day. Try again tomorrow.'
          : e && e.code === 'offline' ? NO_SIGNAL : 'Couldn\u2019t open that page. Try again.');
        redraw();
      });
    };
    var open = function (it) {
      if (it.kind !== 'term' && it.kind !== 'mb') remember(it);
      if (it.kind === 'mb') openMb(it);
      else if (it.kind === 'person') {
        if (it.canOpen) openProfile(it.id);
        else { toast('You can open the profiles of people you tour with or share an artist with.'); paint(); }
      } else if (it.kind === 'artist') openAct(it.id);
      else if (it.kind === 'folder') go({ name: 'artist', artist: it.id });
      else if (it.kind === 'tour') {
        if (getTour(it.id)) openTour(it.id);
        else if (it.artistId) openTourCard(it.id, null, { name: it.title, artist: it.artist }, it.artistId);
        else toast('That tour isn\u2019t open to you any more.');
      } else if (it.kind === 'term') { st.q = it.title; input.value = it.title; run(); }
    };
    var row = function (it, onDrop) {
      var face = it.kind === 'term' ? h('span', { class: 'sr-face clock', 'aria-hidden': 'true' }, icon('clock', 22))
        : h('span', { class: 'sr-face' + (it.avatar ? (it.logo ? ' logo' : ' has') : ' letter'), 'aria-hidden': 'true' },
            it.avatar ? h('img', { src: it.avatar, alt: '' }) : (String(it.letter || it.title || '?').trim().charAt(0).toUpperCase() || '?'));
      return h('div', { class: 'sr-row' },
        h('button', { class: 'sr-main', type: 'button', onclick: function () { open(it); } }, face,
          h('span', { class: 'lr-text' },
            h('span', { class: 'sr-title' }, h('span', { class: 'sr-title-t' }, it.title), it.verified ? verifiedBadge() : null),
            it.kind === 'mb' && st.opening === it.id ? h('span', { class: 'sr-sub' }, 'Opening\u2026')
              : it.sub ? h('span', { class: 'sr-sub' }, it.sub) : null)),
        onDrop ? h('button', { class: 'sr-x', type: 'button', 'aria-label': 'Remove ' + it.title + ' from Recent', onclick: onDrop }, icon('close', 18)) : null);
    };
    // Your own tours and artist folders, matched on this phone.
    var local = function (q) {
      var t = q.toLowerCase(), tours = [], folders = {};
      allTourEntries().forEach(function (e) {
        var d = e[1], name = String(d.name || ''), artist = artistOf(d) || '';
        var places = G.rows(d.shows).map(function (x) { return String(x.city || '') + ' ' + String(x.venue || ''); }).join(' ').toLowerCase();
        if (name.toLowerCase().indexOf(t) >= 0 || artist.toLowerCase().indexOf(t) >= 0 || places.indexOf(t) >= 0) {
          var dates = G.rows(d.shows).map(function (x) { return x.date; }).filter(G.parseDay).sort();
          tours.push({ id: e[0], name: name, artist: artist, first: dates[0], last: dates[dates.length - 1] });
        }
        if (artist && artist.toLowerCase().indexOf(t) >= 0) folders[artist.toLowerCase()] = artist;
      });
      registeredArtists().forEach(function (a) { if (a.toLowerCase().indexOf(t) >= 0) folders[a.toLowerCase()] = a; });
      return { tours: tours, folders: Object.keys(folders).map(function (k) { return folders[k]; }) };
    };
    /* Before you type: who you're most likely after, no instructions. What
       you opened lately (Recent), then the people you follow, the people you
       tour with, the artists (their pages, then your own artist folders),
       and your tours. Nobody shows twice. */
    var suggested = function () {
      var list = recents(), shown = st.all ? list : list.slice(0, 5), seen = {};
      var d = S.searchSug && S.searchSug.data;
      var key = function (it) { return it.kind === 'folder' || it.kind === 'artist' ? 'a:' + String(it.kind === 'artist' ? (it.name || it.letter) : it.id).toLowerCase() : it.kind + ':' + it.id; };
      shown.forEach(function (it) { seen[it.kind + ':' + it.id] = seen[key(it)] = true; });
      var section = function (title, items, more) {
        items = items.filter(function (it) {
          var k = it.kind + ':' + it.id, k2 = key(it);
          if (seen[k] || seen[k2]) return false;
          seen[k] = seen[k2] = true;
          return true;
        });
        return items.length ? [h('div', { class: 'sr-head' }, h('h2', { class: 'sr-h' }, title), more || null),
          h('div', { class: 'sr-list' }, items.map(function (it) { return row(it); }))] : null;
      };
      var artists = d ? (d.artists || []).map(function (a) { var it = asItem.artist(a); it.name = a.name; return it; }) : [];
      var folders = registeredArtists().concat(Array.from(tourGroups().byArtist.keys())).filter(function (a, i, all) { return all.indexOf(a) === i; });
      var tours = toursByNow().slice(0, 6).map(function (e) {
        var t = e[1], dates = G.rows(t.shows).map(function (x) { return x.date; }).filter(G.parseDay).sort();
        return asItem.tour({ id: e[0], name: t.name, artist: artistOf(t), first: dates[0], last: dates[dates.length - 1] });
      });
      return [
        list.length ? [h('div', { class: 'sr-head' }, h('h2', { class: 'sr-h' }, 'Recent'),
            list.length > shown.length ? h('button', { class: 'sr-all', type: 'button', onclick: function () { st.all = true; paint(); } }, 'See all') : null),
          h('div', { class: 'sr-list' }, shown.map(function (it) { return row(it, function () { forget(it); paint(); }); }))] : null,
        d ? section('Following', (d.following || []).map(asItem.person)) : null,
        d ? section('People you tour with', (d.crew || []).map(asItem.person)) : null,
        section('Artists', artists.concat(folders.map(asItem.folder))),
        section('Your tours', tours)
      ];
    };
    // Asked once a visit, and again after a few minutes.
    if (B && B.searchSuggestions && socialOn()) {
      var sug = S.searchSug;
      if (!sug || (!sug.asking && Date.now() - sug.at > 180e3)) {
        S.searchSug = { data: sug ? sug.data : null, at: Date.now(), asking: true };
        B.searchSuggestions().then(function (d) { S.searchSug = { data: d, at: Date.now() }; }, function () {
          S.searchSug = { data: sug ? sug.data : null, at: Date.now() };
        }).then(function () {
          if (results.isConnected) paint();
          else if (S.route && S.route.name === 'search') render(true);
        });
      }
    }
    var paint = function () {
      var q = st.q.trim();
      if (q.replace(/^@/, '').length < 2) {
        results.replaceChildren.apply(results, flatten(suggested()).filter(Boolean));
        return;
      }
      var mine = local(q.replace(/^@/, ''));
      var r = st.res && st.res.q === q ? st.res : null;
      var items = (r ? r.people : []).map(asItem.person);
      var actNames = (r ? r.artists : []).map(function (a) { return String(a.name).trim().toLowerCase(); });
      items = items.concat((r ? r.artists : []).map(asItem.artist),
        mine.folders.filter(function (a) { return actNames.indexOf(a.toLowerCase()) < 0; }).map(asItem.folder));
      var seen = {};
      mine.tours.forEach(function (t) { seen[t.id] = true; });
      items = items.concat(mine.tours.map(asItem.tour), (r ? r.tours : []).filter(function (t) { return !seen[t.id]; }).map(asItem.tour));
      var kids = items.length ? [h('div', { class: 'sr-list' }, items.map(function (it) { return row(it); }))] : [];
      // Every other act there is, under Greenroom's own answers (an act that
      // already has a page shows once, as its page).
      var mb = st.mb && st.mb.q === q ? st.mb : null;
      var haveMb = {};
      (r ? r.artists : []).forEach(function (a) { if (a.mbid) haveMb[a.mbid] = true; });
      var more = (mb ? mb.list : []).filter(function (m) { return !haveMb[m.mbid]; }).map(asItem.mb);
      if (more.length) {
        kids.push(h('div', { class: 'sr-head' }, h('h2', { class: 'sr-h' }, items.length ? 'More artists' : 'Artists')),
          h('div', { class: 'sr-list' }, more.map(function (it) { return row(it); })));
      }
      if (st.busy || !r) kids.push(h('p', { class: 'note sr-hint' }, 'Searching\u2026'));
      else if (r.failed && !more.length) kids.push(h('p', { class: 'note sr-hint' }, 'Couldn\u2019t reach Greenroom. Check your signal and try again.'));
      else if (!items.length && !more.length) {
        kids.push(h('p', { class: 'note sr-hint' }, st.mbWait === q ? 'Searching\u2026'
          : mb && mb.failed ? 'Couldn\u2019t reach the artist list just now. Try again in a moment.'
          : 'Nothing found for \u201c' + q + '\u201d.'));
      }
      results.replaceChildren.apply(results, kids);
    };
    // Every act there is, from MusicBrainz (the open music encyclopedia).
    // Asked on its own clock — it allows one question a second — so it never
    // holds up Greenroom's own answers. A username search ("@...") never
    // leaves Greenroom.
    var askMb = function (q) {
      clearTimeout(st.mbTimer);
      st.mbWait = '';
      // (A lookup that failed isn't an answer: the same words are asked again next time.)
      if (!B.mbSearch || q.charAt(0) === '@' || (st.mb && st.mb.q === q && !st.mb.failed)) return;
      st.mbWait = q;
      st.mbTimer = setTimeout(function () {
        st.mbAt = Date.now();
        var settle = function (list, failed) {
          if (st.mbWait === q) st.mbWait = '';
          if (st.q.trim() !== q) return;
          st.mb = { q: q, list: list || [], failed: !!failed };
          if (results.isConnected) paint();
          else if (S.route && S.route.name === 'search') render(true);
        };
        B.mbSearch(q).then(function (list) { settle(list, false); }, function () { settle([], true); });
      }, Math.max(450, 1100 - (Date.now() - (st.mbAt || 0))));
    };
    var timer = 0;
    var run = function () {
      clearTimeout(timer);
      var q = st.q.trim();
      if (q.replace(/^@/, '').length < 2) { st.busy = false; clearTimeout(st.mbTimer); st.mbWait = ''; paint(); return; }
      askMb(q);
      if (st.res && st.res.q === q) { st.busy = false; paint(); return; }
      st.busy = true;
      paint();
      var n = ++st.seq;
      timer = setTimeout(function () {
        var safe = function (p) { return p.catch(function () { return null; }); };
        Promise.all([safe(B.findPeople(q)), safe(B.findArtists(q)), safe(B.findTours(q))]).then(function (out) {
          if (n !== st.seq) return;
          st.busy = false;
          st.res = { q: q, people: out[0] || [], artists: out[1] || [], tours: out[2] || [], failed: !out[0] && !out[1] && !out[2] };
          if (results.isConnected) paint();
        });
      }, 300);
    };
    var input = h('input', { class: 'sr-in', type: 'search', value: st.q, placeholder: 'Search', autocomplete: 'off',
      autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search', 'data-k': 'search-in',
      autofocus: (S.route.focus && !st.q) ? true : null,
      'aria-label': 'Search people, artists and tours',
      oninput: function (e) { st.q = e.target.value; run(); } });
    run();
    return h('div', { class: 'page home profile has-tabs search-page' },
      h('div', { class: 'sr-top' },
        h('div', { class: 'band-row sr-bar' },
          h('form', { class: 'sr-pill', role: 'search',
            // The Search key keeps what you looked for in Recent, under a clock.
            onsubmit: function (e) {
              e.preventDefault();
              var q = st.q.trim();
              if (q.replace(/^@/, '').length >= 2) remember(asItem.term(q));
              blurActive();
            } }, icon('search', 18), input))),
      results,
      h('span', { class: 'logo-mark home-mark', 'aria-hidden': 'true' }),
      socialBar('search'));
  }

  /* ============================== MODEL7: the menu ==============================
     Three lines in the top-right of your profile open one page that reaches
     everything in a single list: the money (Budget: an artist, then Off
     Tour or a tour's Expenses and Income), the tour you were last in
     (Overview, Day sheet, Crew Stats, Chat) and Settings. Tours, artists
     and the guest list are tabs on your profile, so they aren't repeated here. Laid out
     against a social app's settings page on the same phone: 16-point labels,
     22-point icons, 48-point rows, a quiet heading over each group and a
     thick rule between groups. An experiment: the tabs along the bottom of
     a tour are still there. */
  function tourGroups() {
    var byArtist = new Map(), loose = [];
    allTourEntries().forEach(function (e) {
      var a = artistOf(e[1]);
      if (!a) { loose.push(e); return; }
      if (!byArtist.has(a)) byArtist.set(a, []);
      byArtist.get(a).push(e);
    });
    registeredArtists().forEach(function (a) { if (!byArtist.has(a)) byArtist.set(a, []); });
    return { byArtist: byArtist, loose: loose };
  }
  // An artist's row; swipe it away if every tour under it is yours to delete.
  function artistRow(name, entries, from, fromLabel) {
    var cardEl = artistCard(name, entries, from, fromLabel);
    if (!canWrite() || (S.mode === 'db' && !entries.every(function (e) { return createdTour(e[0]); }))) return cardEl;
    return swipeable(cardEl, function () {
      confirmSheet({
        title: 'Delete everything for ' + name + '?',
        body: entries.length
          ? plural(entries.length, 'tour') + ' move to Recently deleted for ' + TRASH_DAYS + ' days.'
          : 'They have no runs yet, so nothing else goes with them.',
        action: entries.length ? 'Delete ' + plural(entries.length, 'tour') : 'Delete ' + name,
        danger: true,
        onConfirm: async function () {
          for (var i = 0; i < entries.length; i++) {
            await api.update(entries[i][0], { deletedAt: Date.now() });
          }
          await forgetArtist(name);
          toast(name + ' moved to Recently deleted');
          return true;
        }
      });
    }, name);
  }
  // The tour the menu's tour rows open: the one you were last in, else the
  // one on the road now, else the newest.
  function currentTourId() {
    var entries = allTourEntries();
    if (!entries.length) return null;
    var has = function (x) { return !!x && entries.some(function (e) { return e[0] === x; }); };
    if (has(S.lastTour)) return S.lastTour;
    var last = lsGet(lastTourKey());
    if (has(last)) return last;
    var live = entries.filter(function (e) { return tourIsLive(e[1]); })[0];
    return (live || entries[0])[0];
  }
  /* The three lines, top right of your profile and of every page the menu
     leads to: the menu, from wherever you are. */
  function menuBtn() {
    return h('button', { class: 'iconbtn pf-menu', type: 'button', 'aria-label': 'Menu', onclick: openMenu }, icon('menu', 26));
  }
  function openMenu() {
    go({ name: 'mainmenu', back: S.route || { name: 'home' }, fresh: true });
  }
  /* The top of the menu and the pages under it: no band at all, just the GR
     mark in green, centred, the way someone else's profile wears it; o.menu
     adds the three lines. A page's name (if it has one) sits under it. */
  function menuHead(title, o) {
    return [
      h('div', { class: 'headband dark mn-top' },
        h('header', { class: 'topbar' },
          h('span', { class: 'top-side' }),
          h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
          h('span', { class: 'top-side right' }, o && o.menu ? menuBtn() : null))),
      title ? h('h1', { class: 'mn-page-t' }, title) : null
    ];
  }
  // o.open: a row that drops more rows down under it (true or false); o.face: a picture in place of the icon; o.cls.
  function menuRow(ic, label, onTap, sub, o) {
    o = o || {};
    var drops = typeof o.open === 'boolean';
    return h('button', { class: 'mn-row' + (o.cls ? ' ' + o.cls : '') + (o.open ? ' open' : ''), type: 'button',
      'aria-expanded': drops ? (o.open ? 'true' : 'false') : null, onclick: onTap },
      h('span', { class: 'mn-ic', 'aria-hidden': 'true' }, o.face || icon(ic, 24)),
      h('span', { class: 'mn-text' }, h('span', { class: 'mn-label' }, label), sub ? h('span', { class: 'mn-sub' }, sub) : null),
      h('span', { class: 'mn-chev', 'aria-hidden': 'true' }, icon('chevron', 18)));
  }
  /* BUDGET in the menu. The row drops down your artists; an artist drops
     down Off Tour (what the band spends between tours) and Tours (a page of
     that artist's tours; a tour opens as two tabs, Expenses and Income).
     Money only: an artist is listed when you can see its Off Tour book or
     the money of one of its tours, so GA never gets the row at all. */
  function bookTours(name) {
    return toursByNow().filter(function (e) { return artistOf(e[1]) === name && canSeeMoney(e[0]); });
  }
  function budgetArtists() {
    return Array.from(tourGroups().byArtist.keys()).filter(function (name) {
      return bookTours(name).length || canSeeOffTour(name);
    });
  }
  function budgetRows(here) {
    var artists = budgetArtists();
    var loose = bookTours(''); // tours not filed under an artist yet
    if (!artists.length && !loose.length) return null;
    var open = !!S.mnBudget;
    return [
      menuRow('tabmoney', 'Budget', function () { S.mnBudget = !open; render(true); }, null, { open: open }),
      !open ? null : h('div', { class: 'mn-drop' }, artists.map(function (name) {
        var on = S.mnArtist === name, logo = artistLogo(name), tours = bookTours(name);
        var face = h('span', { class: 'avatar mn-face' + (logo ? ' has' : ' letter') },
          logo ? h('img', { class: 'brand-logo', src: logo, alt: '' }) : String(name).trim().charAt(0).toUpperCase());
        return [
          menuRow(null, name, function () { S.mnArtist = on ? null : name; render(true); }, null, { open: on, face: face }),
          !on ? null : h('div', { class: 'mn-drop' },
            canSeeOffTour(name) ? menuRow('tabcost', 'Off Tour', function () {
              go({ name: 'artist', artist: name, view: 'off', from: here, fromLabel: 'Menu' });
            }) : null,
            tours.length ? menuRow('calendar', 'Tours', function () {
              go({ name: 'book', artist: name, back: here });
            }) : null)
        ];
      }), loose.length ? menuRow('calendar', 'Tours with no artist', function () {
        go({ name: 'book', artist: '', back: here });
      }) : null)
    ];
  }
  function viewMenu() {
    var backTo = S.route.back || { name: 'home' };
    var here = { name: 'mainmenu', back: backTo };
    var entries = allTourEntries();
    var id = currentTourId(), t = id ? getTour(id) : null;
    // Expenses and Income live under Budget, and the guest list under your profile, so the tour's own rows leave them out.
    var tabs = !t ? [] : TOUR_TABS.filter(function (x) { return ['money', 'costs', 'guests'].indexOf(x.view) < 0; });
    var first = S.menuIn; S.menuIn = false;
    // One list, no rules between: the money first, then the tour you're in, then Settings.
    return h('div', { class: 'page home menu-page has-tabs' + (first ? ' mn-in' : '') },
      menuHead(null),
      dbBanner(),
      h('section', { class: 'mn-group' },
        budgetRows(here),
        menuRow('tag', 'Merchroom', function () { go({ name: 'merchroom', back: here }); }),
        (t && !t.setupDone && canEditTour(id))
          ? menuRow('edit', 'Finish setting up', function () { openTour(id, 'details', here, 'Menu'); }, 'Add its shows to open the rest')
        : t ? tabs.map(function (x) {
          return menuRow(x.icon, x.label, function () { openTour(id, x.view, here, 'Menu'); });
        }) : h('p', { class: 'mn-none' }, canWrite()
          ? 'No tours yet. Tap + on your profile to add an artist, then their first tour.'
          : 'No tours have been shared with you yet.'),
        menuRow('gear', 'Settings', function () { openSettingsSheet(); })),
      h('span', { class: 'logo-mark home-mark', 'aria-hidden': 'true' }),
      socialBar(''));
  }
  /* Every tour you're on, all artists together: on the road first, then the
     newest. A tour opened from here comes back here. */
  function viewAllTours() {
    var backTo = S.route.back || { name: 'mainmenu', back: { name: 'home' } };
    var here = { name: 'tours', back: backTo };
    var entries = toursByNow();
    return h('div', { class: 'page home profile menu-page has-tabs' },
      menuHead('Tours', { menu: true }),
      dbBanner(),
      entries.length ? h('ul', { class: 'tour-list rows mn-list' }, entries.map(function (e) {
        return h('li', null, tourListRow(e, function () { openTour(e[0], 'details', here, 'Tours'); }));
      })) : emptyState('No tours yet', canWrite()
        ? 'Tap + on your profile to add an artist, then their first tour.'
        : 'Nothing has been shared with you yet.'),
      socialBar(''));
  }
  // A tour as a row in a list: its artist's picture, its name, and where it stands (on the road, or its dates).
  function tourListRow(e, onTap) {
    var t = e[1], artist = artistOf(t), logo = artist ? artistLogo(artist) : null;
    var dates = G.rows(t.shows).map(function (x) { return x.date; }).filter(G.parseDay).sort();
    var live = tourIsLive(t);
    var span = dates.length ? dayMD(dates[0]) + (dates.length > 1 ? ' \u2013 ' + dayMD(dates[dates.length - 1]) : '') + ', ' + String(dates[dates.length - 1]).slice(0, 4) : 'No shows yet';
    return h('button', { class: 'list-row tour-row', type: 'button', onclick: onTap },
      h('span', { class: 'avatar' + (logo ? ' has' : ' letter'), 'aria-hidden': 'true' },
        logo ? h('img', { class: 'brand-logo', src: logo, alt: '' }) : String(artist || t.name || '?').trim().charAt(0).toUpperCase()),
      h('span', { class: 'lr-text' },
        h('span', { class: 'lr-title' }, t.name || 'Untitled tour'),
        h('span', { class: 'lr-sub' + (live ? ' live' : '') }, [artist, live ? 'On the road' : span].filter(Boolean).join(' \u00b7 '))),
      icon('chevron', 18));
  }
  /* Budget, then an artist, then Tours: that artist's tours whose money you
     can see. A tour opens as its money book: two tabs, Expenses and Income. */
  function viewBook() {
    var name = S.route.artist || '';
    var backTo = S.route.back || { name: 'mainmenu', back: { name: 'home' } };
    var here = { name: 'book', artist: name, back: backTo };
    var entries = bookTours(name);
    return h('div', { class: 'page home profile menu-page has-tabs' },
      menuHead(name || 'Budget', { menu: true }),
      dbBanner(),
      h('h2', { class: 'mn-h mn-over' }, 'Budget \u00b7 Tours'),
      entries.length ? h('ul', { class: 'tour-list rows mn-list' }, entries.map(function (e) {
        return h('li', null, tourListRow(e, function () { openTour(e[0], 'costs', here, 'Tours', true); }));
      })) : emptyState('No tours here', 'Tours whose budget you can see show up here.'),
      socialBar(''));
  }
  // Your artists, each opening its own page of tours (and Off Tour). An artist opened from here comes back here.
  function viewAllArtists() {
    var backTo = S.route.back || { name: 'mainmenu', back: { name: 'home' } };
    var here = { name: 'artists', back: backTo };
    var groups = tourGroups();
    return h('div', { class: 'page home profile menu-page has-tabs' },
      menuHead('Artists', { menu: true }),
      dbBanner(),
      groups.byArtist.size ? h('ul', { class: 'tour-list rows mn-list' }, Array.from(groups.byArtist, function (pair) {
        return h('li', null, artistRow(pair[0], pair[1], here, 'Artists'));
      })) : emptyState('No artists yet', canWrite()
        ? 'Tap + on your profile to add your artist, then their first tour.'
        : 'Nothing has been shared with you yet.'),
      socialBar(''));
  }

  /* ---- The tabs under your own profile. ----
     Where a social app keeps the photo grid, your profile keeps the tour:
     TODAY (where you are today, and the day sheet under it when there is
     one), ARTISTS (who you work for, names only), TOURS (every run with its
     dates, laid out like the calendar, with the Day sheet, Special requests
     and vote buttons, and no way to add shows from here), GUEST LIST
     (tonight's) and STATS (your flowers, from every tour). Today, Stats and Guest list read the tour
     you were last in, the same one the menu's rows open. Switching tabs
     redraws in place; nothing here is a route. */
  var PF_TABS = [
    { key: 'today', label: 'Today', icon: 'tabmap' },
    { key: 'artists', label: 'Artists', icon: 'music' },
    { key: 'tours', label: 'Tours', icon: 'calendar' },
    { key: 'guests', label: 'Guest list', icon: 'tabguest' },
    { key: 'stats', label: 'Stats', icon: 'tabstats' }
  ];
  var PF_HOME = { name: 'home' };
  // On the road first, then the newest; a tour with no dates yet sorts by the day it was made.
  function toursByNow() {
    var when = function (t) {
      var d = G.rows(t.shows).map(function (x) { return x.date; }).filter(G.parseDay).sort();
      return d.length ? d[d.length - 1] : (t.createdAt ? G.ymd(new Date(t.createdAt)) : '');
    };
    return allTourEntries().slice().sort(function (a, b) {
      var la = tourIsLive(a[1]) ? 1 : 0, lb = tourIsLive(b[1]) ? 1 : 0;
      return (lb - la) || String(when(b[1])).localeCompare(String(when(a[1]))) || ((b[1].createdAt || 0) - (a[1].createdAt || 0));
    });
  }
  /* The tour the profile's Today, Stats and Guest list read: the one you
     picked, else the one on the road, else the one you were last in. Opening
     an old tour to look something up doesn't move Today off the road. */
  function profileTourId() {
    var entries = allTourEntries();
    if (S.pfTour && entries.some(function (e) { return e[0] === S.pfTour; })) return S.pfTour;
    var last = currentTourId();
    if (last && tourIsLive(getTour(last))) return last;
    var live = toursByNow().filter(function (e) { return tourIsLive(e[1]); })[0];
    return live ? live[0] : last;
  }
  // Pick the tour the menu's rows and the profile's Today, Stats and Guest list read.
  function openTourPicker(cur) {
    var entries = toursByNow(), id = cur || currentTourId();
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'Which tour?'),
        h('p', { class: 'sh-sub' }, 'Today, Stats, Guest list and the menu follow this tour.'),
        h('div', { class: 'fl-list' }, entries.map(function (e) {
          var on = e[0] === id, live = tourIsLive(e[1]);
          return h('button', { class: 'fl-row', type: 'button', 'aria-pressed': on ? 'true' : 'false',
            onclick: function () { rememberTour(e[0]); S.pfTour = e[0]; closeSheet(); render(true); } },
            h('span', { class: 'lr-text' },
              h('span', { class: 'lr-title' }, e[1].name || 'Untitled tour'),
              h('span', { class: 'lr-sub' + (live ? ' live' : '') }, [artistOf(e[1]), live ? 'On the road' : ''].filter(Boolean).join(' \u00b7 '))),
            on ? h('span', { class: 'acct-on', 'aria-hidden': 'true' }, icon('check', 14)) : null);
        })),
        h('div', { class: 'stack' },
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Close'))
      ];
    }, { label: 'Which tour?' });
  }
  // Which tour a tab is about, with a way to change it when there's more than one.
  function pfTourBar(id, t, count, view) {
    return h('div', { class: 'pt-tourbar' },
      h('button', { class: 'pt-tourname', type: 'button', 'aria-label': 'Open ' + (t.name || 'the tour'),
        onclick: function () { openTour(id, view, PF_HOME, 'Profile'); } },
        h('span', null, t.name || 'Untitled tour'), icon('chevron', 14)),
      count > 1 ? h('button', { class: 'mn-change', type: 'button', onclick: function () { openTourPicker(id); } }, 'Change') : null);
  }
  /* TODAY: the tour name, New tour tasks for its managers right under it,
     then where the tour is today (the show, or the day off and its hotel),
     or the next show when the run hasn't started; how many days until a day
     off; then that day's sheet. A day with nothing filled in shows nothing
     under it at all. Check In sits at the bottom of the screen. */
  function pfToday(id, t, count) {
    var got = overviewDays(t);
    if (!got) return [pfTourBar(id, t, count, 'details'), emptyState('No dates yet', 'Once shows are on the run, today shows up here.')];
    var today = G.tourToday();
    var entry = got.days[got.index];
    // A run that's over rests on its last show, not on the travel day after it.
    if (entry.date < today && !entry.show) {
      entry = got.days.filter(function (x) { return x.show; }).pop() || entry;
    }
    var s = entry.show, off = s ? null : offDayFor(t, entry.date);
    var isToday = entry.date === today;
    var d = s && G.isObj(s.daySheet) ? s.daySheet : {};
    var shows = got.days.filter(function (x) { return x.show; }).map(function (x) { return x.show; });
    var firstShow = shows[0], lastShow = shows[shows.length - 1];
    var travel = !s && ((firstShow && entry.date < firstShow.date) || (lastShow && entry.date > lastShow.date));
    var kind = isRehearsalDay(t, entry.date) ? 'Rehearsal' : travel ? 'Travel day' : 'Day off';
    // With no city for the day off, the kind of day is the headline, so the tag doesn't say it twice.
    var when = s ? (isToday ? 'Tonight' : entry.date > today ? 'Next show' : 'Last show')
      : (off.city || !isToday) ? kind : 'Today';
    var city = s ? (s.city || 'Show') : (off.city || kind);
    var place = s ? String(s.venue || '').trim() : String(off.hotel || '').trim();
    var address = String(d.venueAddress || '').trim();
    // On a day off, the next show is one quiet line under it.
    var next = !s ? shows.filter(function (x) { return x.date > entry.date; })[0] : null;
    var sheet = daySheetNodes(s, off, { onlySet: true });
    var checkIn = isToday ? checkInBtn(id, entry.date, true) : null;
    // Tonight, the day and the city on the left; the venue and its address in
    // the middle; how many days until a day off in the right corner.
    return [
      pfTourBar(id, t, count, 'details'),
      dayRow(h('span', { class: 'pt-chip' + (isToday ? ' on' : '') }, when), entry.date, city, place, address,
        s && s.soldOut ? h('span', { class: 'pt-chip sold' }, 'Sold out') : null, pfOffCount(t)),
      next ? h('p', { class: 'pt-next' }, 'Next show: ' + dayMD(next.date) + ' \u00b7 ' +
        [next.city, next.venue].map(function (x) { return String(x || '').trim(); }).filter(Boolean).join(' \u00b7 ')) : null,
      sheet ? h('div', { class: 'pt-sheet' }, sheet) : null,
      // Room at the end, so the last of the day sheet scrolls clear of Check In.
      checkIn ? [h('div', { class: 'ci-room', 'aria-hidden': 'true' }), checkIn] : null
    ];
  }
  /* How many days until a day off, while the run is on and today's a show:
     the same count as Overview's, in days, the number over the words. A day
     off already says so. */
  function pfOffCount(t) {
    var c = daysUntilOff(t);
    if (!c || c.off) return null;
    if (c.n === 1) return h('p', { class: 'pt-off', 'aria-label': (c.last ? 'Last show' : 'Day off') + (c.last ? ' tonight' : ' tomorrow') },
      h('b', null, c.last ? 'Last show' : 'Day off'), h('span', null, c.last ? 'tonight' : 'tomorrow'));
    return h('p', { class: 'pt-off', 'aria-label': c.n + ' days until day off' },
      h('b', { class: 'num' }, String(c.n)), h('span', null, 'days until'), h('span', null, 'day off'));
  }
  /* A day in three columns: what and where in the left corner (the tag, the
     date, the city), the venue and its address in the middle, and corner
     (Today's days until a day off) in the right corner. */
  function dayRow(chip, date, city, place, address, extra, corner) {
    return h('div', { class: 'pt-dayrow' },
      h('div', { class: 'pt-dayrow-l' },
        chip || extra ? h('p', { class: 'pt-dr-chips' }, chip, extra) : null,
        h('p', { class: 'pt-dr-date' }, dayLong(date)),
        h('p', { class: 'pt-dr-city' }, city)),
      h('div', { class: 'pt-dayrow-c' },
        place ? h('p', { class: 'pt-dr-venue' }, place) : null,
        address ? h('a', { class: 'pt-dr-addr', href: mapsHref(address), target: '_blank', rel: 'noopener' }, address) : null),
      h('div', { class: 'pt-dayrow-r' }, corner || null));
  }
  /* STATS: your flowers. The three numbers from every tour you've been on
     (flowers between the laurels, the trophy for the artists who list you
     as their crew, your tours), Give flowers with how many of this year's 10
     you've still to give, and the flowers you've been given, with who and
     what for. */
  function pfStats(id, t, count) {
    var B = window.GR_BACKEND;
    if (!flowersOn()) return emptyState('Flowers are for signed-in tours', 'Sign in and the people you tour with can give you your flowers.');
    var mine = B.myFlowers();
    if (!mine) return fwLoading('Picking your flowers…');
    if (mine.error) return fwFailed(function () { B.myFlowers(true); });
    var c = mine.counts || {};
    var left = typeof mine.left === 'number' ? Math.max(0, mine.left) : null;
    var got = Array.isArray(mine.got) ? mine.got : [];
    return [
      h('section', { class: 'fw-me' }, fwStats(c.flowers, c)),
      got.length ? [
        h('h3', { class: 'fw-h' }, 'Your flowers'),
        h('ul', { class: 'fw-feed' }, got.map(function (g) {
          var who = String(g.name || '').trim();
          return h('li', { class: 'fw-gift' },
            personPhoto({ name: who || '?', avatar: g.avatar }, 'xs'),
            h('div', { class: 'fw-gift-t' },
              h('p', { class: 'fw-gift-l' }, h('strong', null, who ? who.split(/\s+/)[0] : 'Someone'), ' gave you ' + plural(g.n, 'flower') + ' ',
                h('span', { 'aria-hidden': 'true' }, FLOWER), catTag(g.category)),
              g.note ? h('p', { class: 'fw-note' }, '“' + g.note + '”') : null,
              h('p', { class: 'fw-when' }, [g.tour, dmWhen(g.at)].filter(Boolean).join(' · '),
                h('button', { class: 'fw-undo', type: 'button', onclick: function () { removeGotFlowers(g); } }, 'Remove'))));
        }))
      ] : null,
      // Give flowers pinned at the bottom of the screen, with this year's count
      // under it (room first, so the list scrolls clear of it).
      t ? h('div', { class: 'fw-room', 'aria-hidden': 'true' }) : null,
      t ? h('div', { class: 'fw-me-give pinned' },
        h('button', { class: 'fw-give', type: 'button', onclick: function () { openTour(id, 'stats', PF_HOME, 'Profile'); } },
          'Give flowers ', h('span', { 'aria-hidden': 'true' }, FLOWER)),
        left == null ? null : h('p', { class: 'fw-me-left' }, left + ' left')) : null
    ];
  }
  /* GUEST LIST: tonight's (or the next show's), with Add guest and Import
     List right under it. Other nights are on the tour's own Guest list. */
  function pfGuests(id, t, count) {
    var bar = pfTourBar(id, t, count, 'guests');
    var backend = !!(window.GR_BACKEND && S.mode === 'db' && window.GR_BACKEND.guestsFor);
    var myUid = backend ? window.GR_BACKEND.uid() : null;
    var today = G.tourToday();
    var shows = G.rows(t && t.shows).filter(function (x) { return G.parseDay(x.date); }).sort(G.byDate);
    if (!shows.length) return [bar, emptyState('No dates yet', 'Once shows are on the run, each night gets its own guest list.')];
    var s = shows.filter(function (x) { return x.date === today; })[0] ||
      shows.filter(function (x) { return x.date > today; })[0] || shows[shows.length - 1];
    var refresh = function () { setTimeout(function () { render(true); }, backend ? 500 : 150); };
    var list = guestsFor(t, id, s.id);
    var sum = G.guestSummary(list);
    var rows = guestRowsFor(id, s, list, backend, myUid, refresh);
    var when = s.date === today ? 'Tonight' : s.date > today ? 'Next show' : 'Last show';
    var venue = String(s.venue || '').trim(), city = String(s.city || '').trim();
    var address = String((G.isObj(s.daySheet) && s.daySheet.venueAddress) || '').trim();
    // Where: the address (it names the city), else the city under the venue.
    var town = city.split(',')[0].trim().toLowerCase();
    var where = address ? (town && address.toLowerCase().indexOf(town) < 0 ? city + ' \u00b7 ' + address : address)
      : (venue ? city : '');
    // Laid out like the references: the show on one card (when, then the
    // venue, then where, with directions on the right), then the list under
    // a plain header with Other nights on its right.
    return [
      bar,
      h('div', { class: 'gl-show' },
        h('div', { class: 'gl-show-t' },
          h('p', { class: 'gl-show-when' + (s.date === today ? ' on' : '') }, when + ' \u00b7 ' + dayLong(s.date)),
          h('p', { class: 'gl-show-venue' }, venue || city || 'Show'),
          where ? h('p', { class: 'gl-show-where' }, where) : null),
        address ? h('a', { class: 'gl-show-go', href: mapsHref(address), target: '_blank', rel: 'noopener',
          'aria-label': 'Directions to ' + (venue || address) }, icon('tabmap', 20)) : null),
      h('div', { class: 'gl-head' },
        h('div', null,
          h('h3', { class: 'gl-head-t' }, 'Guest list'),
          h('p', { class: 'gl-head-n' }, plural(sum.names, 'name') + ' \u00b7 ' + plural(sum.tickets, 'ticket'))),
        shows.length > 1 ? h('button', { class: 'gl-head-more', type: 'button',
          onclick: function () { openTour(id, 'guests', PF_HOME, 'Profile'); } }, 'Other nights') : null),
      rows.length ? h('div', { class: 'pt-sheet pt-gl' }, guestLedger(rows)) : null,
      guestSendRow(id, t, s, list),
      // Add guest and Import list stay at the bottom of the screen; room so the list scrolls clear of them.
      h('div', { class: 'gl-room', 'aria-hidden': 'true' }),
      h('div', { class: 'pt-two pinned' },
        h('button', { class: 'pf-btn go', type: 'button',
          onclick: function () { openGuestForm(id, s.id, s, backend, function () { closeSheet(); refresh(); }); } }, icon('plus', 16), 'Add guest'),
        h('button', { class: 'pf-btn', type: 'button',
          onclick: function () { openGuestImport(id, s.id, s, backend, function () { closeSheet(); refresh(); }); } }, 'Import list'))
    ];
  }
  /* The artists' Greenroom pages this account is near (its own, the ones it's
     on, the ones whose tours it's on), by name, so a name can open its page.
     Shares Search's answer; asked once a visit. */
  function artistPagesByName() {
    var B = window.GR_BACKEND;
    if (!(socialOn() && B && B.searchSuggestions)) return {};
    var sug = S.searchSug;
    if (!sug || (!sug.asking && Date.now() - sug.at > 180e3)) {
      S.searchSug = { data: sug ? sug.data : null, at: Date.now(), asking: true };
      B.searchSuggestions().then(function (d) { S.searchSug = { data: d, at: Date.now() }; }, function () {
        S.searchSug = { data: sug ? sug.data : null, at: Date.now() };
      }).then(function () { render(true); });
    }
    var out = {};
    ((S.searchSug && S.searchSug.data && S.searchSug.data.artists) || []).forEach(function (a) {
      out[String(a.name || '').trim().toLowerCase()] = a;
    });
    return out;
  }
  /* ARTISTS: who you work for, and who you've said you toured with. An
     artist with a Greenroom page opens it the way anyone else sees it (the
     viewer experience); their tours are the next tab. */
  function pfArtists(byArtist, declared, loose) {
    var B = window.GR_BACKEND;
    var meCard = socialOn() ? cardOf(B.uid()).card : null;
    var ends = ((meCard && Array.isArray(meCard.acts)) ? meCard.acts : []).filter(function (x) { return x && x.endorsed && x.name; });
    var names = Array.from(byArtist.keys()).concat(declared);
    var pages = artistPagesByName();
    // A name gets the trophy when exactly one endorsement fits it (the page
    // by that name first); names aren't unique, so the rest get rows of their own.
    var used = [];
    var trophyFor = function (name) {
      var key = String(name).trim().toLowerCase(), page = pages[key];
      var fit = ends.filter(function (x) { return used.indexOf(x) < 0 && String(x.name).trim().toLowerCase() === key; });
      var pick = (page && fit.filter(function (x) { return x.id === page.id; })[0]) || (fit.length === 1 ? fit[0] : null);
      if (pick) used.push(pick);
      return pick;
    };
    var named = names.map(function (a) { return { name: a, endorsed: trophyFor(a) }; });
    // An artist that endorsed you shows here even when none of your tours is theirs.
    var extra = ends.filter(function (x) { return used.indexOf(x) < 0; });
    // Artists that endorsed you ask you to confirm your tours with them, on top.
    var asks = creditAskCards();
    if (!names.length && !extra.length) {
      return [asks, emptyState('No artists yet', loose.length
        ? 'Your tours are under Tours. Open one, then \u22ef, then Name and artist, to file it under its artist.'
        : canWrite() ? 'Tap + to add your artist, then their first tour.'
        : 'Nothing has been shared with you yet.')];
    }
    // The trophy: tap it to see who endorsed you, and remove it if it isn't right.
    var trophy = function (x) {
      var face = [h('span', { class: 'vp-endorsed-t', 'aria-hidden': 'true' }, TROPHY), h('span', { class: 'vp-endorsed-l' }, 'Endorsed')];
      if (!x.eid || !B.removeEndorsement) return h('span', { class: 'vp-endorsed', 'aria-label': 'Endorsed by ' + x.name }, face);
      return h('button', { class: 'vp-endorsed pa-endorsed', type: 'button', 'aria-label': 'Endorsed by ' + x.name,
        onclick: function () {
          confirmSheet({ title: 'Endorsed by ' + x.name,
            body: x.name + ' endorsed you: their word that you really worked for them. Everyone who can see your page sees it. Remove it only if it isn\u2019t right.',
            action: 'Remove endorsement', danger: true,
            onConfirm: async function () {
              try {
                await B.removeEndorsement(x.eid);
                // Off the page now, before the fresh answer comes back.
                var mc = cardOf(B.uid());
                if (mc.card && Array.isArray(mc.card.acts)) {
                  mc.card.acts = mc.card.acts.filter(function (y) { return y.eid !== x.eid; });
                  mc.card.endorsements = Math.max(0, G.num(mc.card.endorsements) - 1);
                }
                S.creditAsks = null;
                cardOf(B.uid(), true); toast('Endorsement removed'); return true;
              }
              catch (e) { saveFailed('endorsement', e); return false; }
            } });
        } }, face);
    };
    var row = function (name, page, logo, endorsed, sub) {
      var inner = [
        h('span', { class: 'avatar' + (logo ? ' has' : ' letter') + (page && page.avatar ? ' photo' : ''), 'aria-hidden': 'true' },
          logo ? h('img', { class: 'brand-logo', src: logo, alt: '' }) : String(name).trim().charAt(0).toUpperCase()),
        h('span', { class: 'lr-text' }, h('span', { class: 'lr-title' }, name),
          (sub || (page && page.handle)) ? h('span', { class: 'lr-sub' }, sub || page.handle) : null)];
      var main = page && page.id
        ? h('button', { class: 'list-row art-row', type: 'button', onclick: function () { openAct(page.id); } }, inner, endorsed ? null : icon('chevron', 18))
        : h('div', { class: 'list-row art-row still' }, inner);
      return endorsed ? h('li', { class: 'pa-li' }, main, trophy(endorsed)) : h('li', null, main);
    };
    return [asks, h('ul', { class: 'tour-list rows' },
      named.map(function (n) {
        var page = pages[String(n.name).trim().toLowerCase()];
        return row(n.name, page, (page && page.avatar) || artistLogo(n.name), n.endorsed);
      }).concat(extra.map(function (x) {
        return row(x.name, x.id ? { id: x.id, handle: x.handle, avatar: x.avatar } : null, x.avatar || artistLogo(x.name), x,
          x.id ? null : 'No longer on Greenroom');
      })))];
  }
  /* TOURS: each run by name. Tap one and its dates drop down under it, laid
     out like the tour's calendar: a show with Day sheet and Special
     requests, a day off with Day sheet and the vote. On a run still going,
     days already played fold away. Shows are added on the tour, not here. */
  function pfTours() {
    var entries = toursByNow();
    // The tour you're out on right now leads the list.
    entries = entries.filter(function (e) { return tourIsLive(e[1]); })
      .concat(entries.filter(function (e) { return !tourIsLive(e[1]); }));
    // Then the tours an artist confirmed for you that aren't already here.
    var B = window.GR_BACKEND, meCard = socialOn() && B && B.uid ? cardOf(B.uid()).card : null;
    var ownSpans = entries.map(function (e) {
      var d = G.rows(e[1] && e[1].shows).map(function (x) { return x.date; }).filter(G.parseDay).sort();
      return { name: e[1].name, artist: artistOf(e[1]), first: d[0] || '', last: d[d.length - 1] || '', shows: d.length };
    });
    var credited = G.tourTimeline(ownSpans, meCard && Array.isArray(meCard.creditTours) ? meCard.creditTours : [], G.tourToday())
      .filter(function (r) { return !r.own; });
    var creditedList = credited.length ? h('ul', { class: 'tour-list rows tl-credited' }, credited.map(function (r) {
      return timelineRow(r, r.tour.artistId ? function () { openAct(r.tour.artistId); } : null, true);
    })) : null;
    if (!entries.length) {
      return creditedList || emptyState('No tours yet', canWrite()
        ? 'Tap + to add an artist, then their first tour.'
        : 'Nothing has been shared with you yet.');
    }
    S.pfOpen = S.pfOpen || {};
    return entries.map(function (e) {
      var id = e[0], t = e[1], artist = artistOf(t), live = tourIsLive(t);
      var open = !!S.pfOpen[id];
      var cal = null;
      if (open) {
        tourRole(id); // asked for now, so a sheet opened from a row already knows what you may do
        cal = calendarRows(id, t, { from: PF_HOME, fromLabel: 'Profile' });
      }
      return h('section', { class: 'pt-run' + (open ? ' open' : '') + (live ? ' tl-live' : '') },
        h('button', { class: 'pt-run-h', type: 'button', 'aria-expanded': open ? 'true' : 'false',
          onclick: function () { S.pfOpen[id] = !open; render(true); } },
          h('span', { class: 'lr-text' },
            live ? h('span', { class: 'lr-title tl-title' }, h('span', { class: 'tl-name' }, t.name || 'Untitled tour'),
                h('span', { class: 'tl-now' }, 'Currently on'))
              : h('span', { class: 'lr-title' }, t.name || 'Untitled tour'),
            h('span', { class: 'lr-sub' }, artist || 'No artist yet')),
          icon('chevron', 16)),
        !cal ? null : !(cal.pastBtn || cal.rows.length) ? h('p', { class: 'pt-next pt-nodates' }, 'No dates yet') : [
          cal.pastBtn ? h('div', { class: 'cal-past-wrap' + (cal.open ? ' open' : '') }, cal.pastBtn) : null,
          cal.rows.length ? h('ul', { class: 'shows cal-list' }, cal.rows) : null]);
    }).concat(creditedList ? [creditedList] : []);
  }
  function profileTabs(entries, byArtist, loose, declared) {
    var id = profileTourId(), t = id ? getTour(id) : null;
    var tab = S.pfTab || (t ? 'today' : 'artists');
    var pick = function (k) { if (k !== tab) { S.pfTab = k; render(true); } };
    var none = function () {
      return emptyState('No tours yet', canWrite()
        ? 'Tap + to add an artist, then their first tour. Its day shows up here.'
        : 'Nothing has been shared with you yet.');
    };
    var body = tab === 'today' ? (t ? pfToday(id, t, entries.length) : none())
      : tab === 'stats' ? pfStats(id, t, entries.length)
      : tab === 'guests' ? (t ? pfGuests(id, t, entries.length) : none())
      : tab === 'tours' ? pfTours()
      : pfArtists(byArtist, declared, loose);
    return [
      h('div', { class: 'vp-tabs pt-tabs', role: 'tablist' }, PF_TABS.map(function (x) {
        var on = x.key === tab;
        return h('button', { class: 'vp-tab pt-tab' + (on ? ' on' : ''), type: 'button', role: 'tab',
          'aria-selected': on ? 'true' : 'false', onclick: function () { pick(x.key); } },
          icon(x.icon, 20), h('span', null, x.label));
      })),
      h('div', { class: 'pt-body', role: 'tabpanel' }, body)
    ];
  }

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
    var who = profileName();
    // Artists you've said you toured with that no tour here already shows.
    var declared = myCard().artists.filter(function (a) {
      var k = a.toLowerCase();
      return !Array.from(byArtist.keys()).some(function (b) { return String(b).toLowerCase() === k; });
    });
    return h('div', { class: 'page home profile pf-home has-tabs' },
      h('div', { class: 'headband' },
        h('header', { class: 'topbar' },
          // Top left, where a social app keeps it: + adds an artist, then their tours.
          h('span', { class: 'top-side' },
            canWrite() ? h('button', { class: 'iconbtn pf-add', type: 'button', 'aria-label': 'Add an artist or a tour',
              onclick: function () { go({ name: 'newartist' }); } }, icon('plus', 24)) : null,
            pill ? h('span', { class: 'pill' }, pill) : null),
          h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
          h('span', { class: 'top-side right' },
            menuBtn())),
        who ? h('div', { class: 'band-row' }, accountTitle(who))
          : h('div', { class: 'band-row wordmark-row' },
              h('span', { class: 'wordmark-full', role: 'img', 'aria-label': 'Greenroom' }))),
      dbBanner(),
      profileHead(entries.length),
      profileTabs(entries, byArtist, loose, declared),
      // Your numbers count nights from an artist's synced history once it
      // confirms them: that data's source gets its line, on every tab.
      (function () {
        var B = window.GR_BACKEND, mc = socialOn() && B && B.uid ? cardOf(B.uid()).card : null;
        return mc && Array.isArray(mc.credits) && mc.credits.length ? setlistCredit() : null;
      })(),
      h('span', { class: 'logo-mark home-mark', 'aria-hidden': 'true' }),
      socialBar('me'),
      (function () {
        if (S.mode === 'db' && !S.askedUsername && window.GR_BACKEND &&
            window.GR_BACKEND.saveProfile && window.GR_BACKEND.myProfile &&
            !window.GR_BACKEND.myProfile().tourRole) {
          S.askedUsername = true;
          setTimeout(function () {
            // Still on your profile with nothing open? Otherwise ask next time.
            if (S.route && S.route.name === 'home' && !sheet) openUsernameSheet(true); else S.askedUsername = false;
          }, 700);
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
          // On the Off Tour page, its card settings are here too.
          S.route && S.route.view === 'off' && offTourOf(S.route.artist || '') ? cardMenuItem(offTourOf(S.route.artist || '')) : null,
          h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () { closeSheet(); openTrash(); } },
            icon('trash', 18), 'Recently deleted' + (trashed ? ' (' + trashed + ')' : '')),
          signedIn ? h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () { openUsernameSheet(false); } },
            icon('people', 18),
            (B.myProfile && B.myProfile().tourRole) ? 'Your contact card' : 'Add your details') : null,
          signedIn ? h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () { openNotifications(null); } },
            icon('bell', 18), 'Notifications') : null,
          (signedIn && S.feed && S.feed.row) ? h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () { openFeedSheet(null); } },
            icon('card', 18), 'Card feed') : null,
          (signedIn && S.feed && S.feed.connectOnly && runsATour()) ? h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () { closeSheet(); connectCards(null); } },
            icon('card', 18), 'Connect the cards') : null,
          signedIn ? h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () {
              confirmSheet({
                title: 'Sign out of Greenroom?',
                body: (who ? 'You\u2019re signed in as ' + who + '. ' : '') +
                  'Your tours stay safe in your account.',
                action: 'Sign out',
                // Say so at once: the sign-in page follows in a moment.
                onConfirm: function () { toast('Signing out\u2026'); B.signOut(); return false; }
              });
            } }, icon('back', 18), 'Sign out') : null,
          signedIn && B.deleteAccount ? h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () { openDeleteAccount(); } }, icon('trash', 18), 'Delete my account') : null)
      ];
    }, { label: 'Settings' });
  }
  /* Deleting your account: everything that is yours alone goes for good. A
     tour or an artist page you run is the band's — hand it off first. */
  function openDeleteAccount() {
    var B = window.GR_BACKEND;
    if (!B || !B.deleteAccount) return;
    confirmSheet({
      title: 'Delete your account?',
      body: 'Your profile, messages, flowers, follows and settings are deleted for good. Tours and artist pages you run have to be handed off or deleted first.',
      action: 'Delete my account', danger: true,
      onConfirm: async function () {
        var r = null;
        try { r = await B.deleteAccount(); } catch (e) { saveFailed('account', e); return false; }
        if (r && r.ok) { toast('Your account is deleted.'); return false; }
        toast(r && r.why === 'tours' ? 'You still run ' + plural(G.num(r.n), 'tour') + '. Hand them off or delete them first.'
          : r && r.why === 'artists' ? 'You still run ' + plural(G.num(r.n), 'artist page') + '. Hand them off or delete them first.'
          : 'Couldn\u2019t delete the account. Try again.');
        return false;
      }
    });
  }

  /* One artist: just the name. The numbers wait behind the doors. */
  function artistCard(name, entries, from, fromLabel) {
    var logo = artistLogo(name);
    var open = function () { go({ name: 'artist', artist: name, from: from || null, fromLabel: fromLabel || null }); };
    // The slot left of the name IS the logo: a + until they bring one in,
    // the mark itself after — tap it either way to set or swap it.
    // Round mark on the left: the logo once there is one, the first letter
    // until then (tap it to bring the logo in).
    var initial = String(name || '?').trim().charAt(0).toUpperCase() || '?';
    var slot = canWrite() ? fileControl({
      label: logo ? null : initial,
      logo: logo || undefined,
      cls: 'avatar' + (logo ? ' has' : ' letter'),
      accept: imageAccept(),
      ariaLabel: (logo ? 'Change' : 'Import') + ' the logo for ' + name,
      onFiles: function (files) {
        readLogoFile(files[0], async function (dataUrl) {
          if (await saveArtistLogo(name, dataUrl)) { toast('Logo in'); render(true); }
        });
      }
    }) : h('span', { class: 'avatar' + (logo ? ' has' : ' letter') },
      logo ? h('img', { class: 'brand-logo', src: logo, alt: '' }) : initial);
    var live = entries.some(function (e) { return tourIsLive(e[1]); });
    return h('div', { class: 'list-row art-row' },
      slot,
      h('button', { class: 'lr-main', type: 'button', onclick: open },
        h('span', { class: 'lr-text' },
          h('span', { class: 'lr-title' }, name),
          h('span', { class: 'lr-sub' + (live ? ' live' : '') },
            entries.length ? plural(entries.length, 'tour') + (live ? ' \u00b7 on the road' : '') : 'No tours yet')),
        icon('chevron', 18)));
  }

  // On the road today: today falls between the tour's first and last show.
  function tourIsLive(t) {
    var d = G.rows(t && t.shows).map(function (x) { return x.date; }).filter(G.parseDay).sort();
    var today = G.tourToday();
    return d.length > 0 && today >= d[0] && today <= d[d.length - 1];
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
    return h('div', { class: 'page home has-tabs' },
      h('div', { class: 'headband' },
        h('header', { class: 'topbar' },
          h('span', { class: 'top-side' }),
          h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
          h('span', { class: 'top-side right' }, menuBtn()))),
      h('form', { class: 'sh-form', onsubmit: submit, novalidate: true, style: 'margin-top:18px' },
        field('Artist', input),
        h('button', { class: 'btn primary block', type: 'submit', style: 'margin-top:18px' }, 'Save')),
      socialBar(''));
  }

  /* One artist's tours. */
  function bandHead(name, sub) {
    return h('div', { class: 'headband' },
        h('header', { class: 'topbar' },
          h('span', { class: 'top-side' }),
          h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
          h('span', { class: 'top-side right' }, menuBtn())),
        h('div', { class: 'band-row' },
          h('h1', { class: 'band-name' }, name),
          sub ? h('p', { class: 'band-sub' }, sub) : null));
  }
  function viewArtist() {
    var name = S.route.artist || '';
    if (S.route.view === 'off' && canSeeOffTour(name)) return viewOffTour(name);
    var entries = allTourEntries().filter(function (e) { return artistOf(e[1]) === name; });
    var pill = homePill();
    var tabs = artistTabs(name, 'tours');
    return h('div', { class: 'page home has-tabs' },
      h('div', { class: 'headband' },
        h('header', { class: 'topbar' },
          h('span', { class: 'top-side' }),
          h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
          h('span', { class: 'top-side right' }, menuBtn())),
        h('div', { class: 'band-row' },
          h('h1', { class: 'band-name' }, name))),
      dbBanner(),
      h('div', { class: 'sec-head split' },
        h('div', null,
          h('h2', { class: 'sec-title hdr' }, 'Tours'),
          entries.length ? h('p', { class: 'sec-sub' }, plural(entries.length, 'run') + ' for ' + name) : null),
        canWrite()
          ? h('button', { class: 'add-pill', type: 'button',
              onclick: function () { startTour(name); } },
              icon('plus', 16), 'Add')
          : null),
      entries.length
        ? h('ul', { class: 'tour-list rows' }, entries.map(function (e, i) {
            var cardEl = tourCard(e[0], e[1], i + 1);
            if (!canWrite() || (S.mode === 'db' && !createdTour(e[0]))) return h('li', null, cardEl);
            return h('li', null, swipeable(cardEl, function () {
              softDeleteTour(e[0]).then(function () { render(true); });
            }, e[1].name || 'tour'));
          }))
        : emptyState('No tours here yet', 'Add ' + name + '’s first run.'),
      h('span', { class: 'logo-mark home-mark', 'aria-hidden': 'true' }),
      tabs);
  }

  /* OFF TOUR: the band's spending between tours, on the same Expenses screen
     a tour has (Projected, Spent, Paid), with the card feed's charges from
     off the road to sort. The owner's first visit starts the book. */
  function viewOffTour(name) {
    var id = offTourOf(name);
    if (!id && ownsBand(name) && canWrite()) ensureOffTour(name).then(function (made) { if (made) render(true); });
    var t = id ? getTour(id) : null;
    var body;
    if (!t) {
      body = ownsBand(name) ? h('p', { class: 'note', style: 'margin-top:24px' }, 'Starting the Off Tour book\u2026')
        : emptyState('Nothing off tour yet', 'Once the tour manager starts ' + name + '\u2019s Off Tour book, it shows up here.');
    } else {
      var oc = G.calc(t);
      body = [h('p', { class: 'note off-intro' }, 'What the band spends between tours. Card charges from off the road land here to sort; ' +
        'anything for the next tour can go straight to it.'),
        // Income catalogued onto the Off Tour book (royalties, advances)
        // sits above the spending, so the money in is never invisible.
        otherIncomeList(id, oc),
        tabExpenses(id, t, oc, { off: true })];
    }
    return h('div', { class: 'page home has-tabs exp-page off-page' },
      bandHead(name, 'Off Tour'), dbBanner(), body, artistTabs(name, 'off'));
  }
  // Log by hand on the Off Tour book: pick a category, then the same sheet a tour uses.
  function openOffLog(id) {
    var cats = G.typedCategoriesFor(getTour(id)).filter(function (c) { return c.key !== 'offdebt' && c.key !== 'commission'; });
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'Log an expense'),
        h('p', { class: 'sh-sub' }, 'Pick where it goes.'),
        h('div', { class: 'ledger' }, cats.map(function (c) {
          return h('button', { class: 'row rowbtn', type: 'button', onclick: function () {
            closeSheet(); setTimeout(function () { openCategorySheet(id, c.key); }, 320);
          } }, h('span', { class: 'row-label' }, c.label), icon('chevron', 18));
        }))
      ];
    }, { label: 'Log an expense', cls: 'cat-sheet' });
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

  /* A tour, the way a good finance app lists things: a round mark, the name
     in plain white, the dates and show count in grey underneath. */
  function tourCard(id, t, num) {
    var dates = G.rows(t && t.shows).map(function (x) { return x.date; }).filter(G.parseDay).sort();
    var live = tourIsLive(t);
    var sub = dates.length
      ? dayMD(dates[0]) + (dates.length > 1 ? ' \u2013 ' + dayMD(dates[dates.length - 1]) : '') +
        ' \u00b7 ' + plural(dates.length, 'show')
      : 'No shows yet';
    var name = t.name || 'Untitled tour';
    return h('button', { class: 'list-row tour-row', type: 'button', onclick: function () { openTour(id); } },
      h('span', { class: 'avatar letter', 'aria-hidden': 'true' },
        num ? String(num) : String(name).trim().charAt(0).toUpperCase()),
      h('span', { class: 'lr-text' },
        h('span', { class: 'lr-title' }, name),
        h('span', { class: 'lr-sub' + (live ? ' live' : '') }, (live ? 'On the road \u00b7 ' : '') + sub)),
      icon('chevron', 18));
  }

  /* ============================== Views: setup wizard ============================== */

  function viewWizard() {
    var id = S.route.id;
    var step = S.route.step || 1;
    var t = id ? getTour(id) : null;
    if (id && !t) {
      return h('div', { class: 'page has-tabs' },
        h('header', { class: 'topbar' }),
        S.pending[id] ? emptyState('Saving the tour…', null) : emptyState('This tour isn’t here anymore', 'It may have been deleted.'),
        socialBar(''));
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
    return h('div', { class: 'page wizard has-tabs' }, head, body, socialBar(''));
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
        ? 'Upload the tour flyer and the dates fill themselves in \u2014 they land in OVERVIEW and INCOME both.'
        : 'Each date and city \u2014 they land in OVERVIEW and INCOME both.'),
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
    // The same arithmetic as the tour's own total, with the draft plugged in:
    // card balances, merch cash spent and "already accounted for" all count
    // exactly as they do everywhere else.
    function draftTotal() {
      var c2 = G.calc(Object.assign({}, t, { expenses: d.expenses, commission: d.commission }));
      return c2.fixed + c2.commission;
    }
    function refresh() {
      var total = draftTotal();
      totalEl.textContent = money(total);
      var anyPct = G.commissionLines(d.commission).some(function (l) {
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
      var paid = linePaid(base, cat.key);
      return h('div', { class: 'row' },
        h('div', { class: 'row-label' },
          h('label', { for: 'exp-' + cat.key }, cat.label),
          paid > 0 ? h('span', { class: 'hint' }, money(paid) + ' spent so far') : null),
        moneyInput({
          id: 'exp-' + cat.key, value: rec.projected, slim: true,
          label: cat.label + ' projected cost', placeholder: '—',
          onValue: function (v) { rec.projected = v > 0 ? v : null; changed(); }
        }));
    });

    rows.push(h('div', { class: 'row head' }, h('span', null, 'Commission')));
    G.commissionLines(d.commission).forEach(function (line) { rows.push(commissionRow(d, line, changed)); });
    rows.push(h('div', { class: 'row total' },
      h('span', null, 'What the tour costs'), totalEl));

    refresh();
    return [h('div', { class: 'ledger' }, rows), note];
  }

  // What a category has paid, exactly as the tour's total counts it.
  function linePaid(c, key) {
    var l = c.lines.filter(function (x) { return x.key === key; })[0];
    return l ? G.num(l.paid) : 0;
  }

  function commissionRow(d, line, changed, onRemove) {
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
      holder,
      onRemove ? h('button', { class: 'iconbtn sm', type: 'button', 'aria-label': 'Remove ' + line.label,
        onclick: onRemove }, icon('trash', 16)) : null), chipRow];
  }

  function crewRow(id, t) {
    var crew = G.rows(t && t.crew);
    var total = G.crewProjection(t);
    var paid = linePaid(G.calc(t), 'crew');
    return h('button', {
      class: 'row rowbtn', type: 'button', onclick: function () { openCrewSheet(id, true); }
    },
      h('div', { class: 'row-label' }, 'Crew',
        h('span', { class: 'hint' }, crew.length
          ? plural(crew.length, 'person').replace('persons', 'people') +
            (paid > 0 ? ' · ' + money(paid) + ' spent' : '')
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
    var read = l.cards.filter(function (r) { return r.feed; });
    var typed = l.cards.filter(function (r) { return !r.feed; });
    var out = typed.length ? ' · ' + typed.map(function (r) {
      return money(r.amount) + (r.leftover ? ' left over from ' : ' on ') + r.label;
    }).join(', ') + ' going in' : '';
    read.forEach(function (r) {
      out += ' · ' + r.label + ': ' + (r.owed > 0 ? money(r.owed) + ' still owed' : 'paid off') +
        (r.paidOff > 0 && r.owed > 0 ? ', ' + money(r.paidOff) + ' paid' : '');
    });
    return out;
  }
  // The two numbers sit in their own columns; this line says how they compare.
  function lineHint(l) {
    if (l.over > 0) return { text: 'Over by ' + money(l.over) + cardBit(l), cls: ' over' };
    if (l.key === 'commission') return { text: '', cls: '' };
    if (l.projected == null) return { text: cardBit(l).replace(/^ · /, ''), cls: '' };
    if (l.left === 0) return { text: 'All spent' + cardBit(l), cls: ' done' };
    return { text: money(l.left) + ' left to pay' + cardBit(l), cls: '' };
  }

  /* A credit card the feed reads, as its own category: its name and card
     company, and in the Spent column what of its balance is still to sort.
     Each charge sorted into a category moves out of it. */
  function cardBank(card) {
    var b = String((G.isObj(card.feed) && card.feed.bank) || (G.isObj(card.owedNow) && card.owedNow.bank) || '').trim();
    return /^american express$/i.test(b) ? 'AMEX' : b;
  }
  /* A card the way people say it: the bank, then the last digits of the
     number. "AMEX (1008)". The feed writes a card as its name, then "··" and
     the bank's 2 to 4 closing characters; older names end in four digits.
     With no bank known, the account's own name leads; with no digits, the
     bank and the account's name. */
  function cardTail(name) {
    var nm = String(name || '');
    var m = /··\s*([A-Za-z0-9]{2,4})\s*$/.exec(nm) || /(\d{4})\s*$/.exec(nm);
    return m ? m[1] : '';
  }
  function cardOwnName(name) {
    return String(name || '').replace(/\s*··\s*[A-Za-z0-9]{2,4}\s*$/, '').replace(/[\s·–—.\-]*\d{4}\s*$/, '').trim();
  }
  function cardShort(name, bank) {
    var b = String(bank || '').trim();
    if (/^american express$/i.test(b)) b = 'AMEX';
    var last = cardTail(name), own = cardOwnName(name);
    if (b && last) return b + ' (' + last + ')';
    if (b) return own && own.toLowerCase() !== b.toLowerCase() ? b + ' · ' + own : b;
    return (own || 'Card') + (last ? ' (' + last + ')' : '');
  }
  /* Every card linked to this tour: the ones the card feed logs (kept on the
     tour as feedCards, so the whole team sees them) and any credit card
     already carried on it. A card is the same card by its bank id or its
     name (a reissued card keeps its id and changes its name). Credit cards first. */
  function tourCards(t) {
    var out = [], used = [];
    var debts = G.cardDebts(t).filter(function (d) { return G.isObj(d.feed) && d.feed.name; });
    var reg = G.isObj(t && t.feedCards) ? t.feedCards : {};
    Object.keys(reg).forEach(function (k) {
      var c = reg[k];
      if (!G.isObj(c) || !c.name) return;
      // An account you marked as your own on MY PAY is not one of the tour's cards.
      if (isMyPayAccount(k)) return;
      var debt = debts.filter(function (d) { return used.indexOf(d) < 0 && (d.id === 'feed-' + k || d.feed.name === c.name); })[0] || null;
      if (debt) used.push(debt);
      out.push({ id: k, name: String(c.name), bank: String(c.bank || ''), kind: c.kind === 'debit' ? 'debit' : 'credit', debt: debt,
        income: Array.isArray(c.income) ? c.income : [] });
    });
    debts.forEach(function (d) {
      if (used.indexOf(d) >= 0) return;
      out.push({ id: String(d.id).replace(/^feed-/, ''), name: d.feed.name, bank: '', kind: 'credit', debt: d });
    });
    out.forEach(function (c) {
      // Every name this card's charges may carry: the one it has now, and the one it came onto the tour with.
      c.names = [c.name];
      if (c.debt && c.debt.feed.name !== c.name) c.names.push(c.debt.feed.name);
      if (!c.bank && c.debt) c.bank = String((c.debt.feed && c.debt.feed.bank) || (G.isObj(c.debt.owedNow) && c.debt.owedNow.bank) || '');
      c.label = cardShort(c.name, c.bank);
    });
    // Two cards that would read the same get their own names added.
    out.forEach(function (c) {
      if (out.some(function (x) { return x !== c && x.label === c.label; })) c.clash = true;
    });
    out.forEach(function (c) { if (c.clash) { var own = cardOwnName(c.name); if (own && c.label.indexOf(own) < 0) c.label += ' · ' + own; } });
    return out.sort(function (a, b) { return (a.kind === b.kind ? 0 : a.kind === 'credit' ? -1 : 1) || a.label.localeCompare(b.label); });
  }
  // The short name for the card a charge came from ("AMEX (1008)").
  function cardLabelFor(t, account) {
    var nm = String(account || '').trim();
    if (!nm) return '';
    var hit = function (x) { return x.names.indexOf(nm) >= 0; };
    var c = tourCards(t).filter(hit)[0];
    // Not on this tour's list (the Off Tour book keeps none): any of your tours that knows the card.
    if (!c) allTourEntries().some(function (e) { c = tourCards(e[1]).filter(hit)[0]; return !!c; });
    return c ? c.label : cardShort(nm, '');
  }
  // This tour's charges from one card (by any name it has had), oldest first.
  function cardCharges(t, c) {
    var names = typeof c === 'string' ? [c] : c.names || [c.name];
    return G.rows(t && t.charges).filter(function (ch) { return names.indexOf(ch.account) >= 0 && G.num(ch.amount) !== 0; })
      .sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
  }
  /* The owner's phone keeps the tour's list of linked cards in step with the
     card feed, so a card connected after logging began still gets its line:
     every card that logs expenses is listed (feedCards), and a credit card
     that isn't carried on the tour yet has its balance read onto it. */
  function syncCards(id, force) {
    var B = window.GR_BACKEND;
    // The creator's phone only, on a tour that logs cards, once the card feed has answered.
    if (S.mode !== 'db' || !B || !B.feedCall || !createdTour(id) || !S.feed || S.feed.connectOnly || !feedLogs(id)) return;
    S.cardSync = S.cardSync || {};
    if (!force && S.cardSync[id] && Date.now() - S.cardSync[id] < 10 * 60e3) return;
    S.cardSync[id] = Date.now();
    B.feedCall('status').then(async function (st) {
      var t = getTour(id);
      if (!st || !st.ok || st.test || !t) return;
      var accounts = Array.isArray(st.accounts) && !st.needsConnect ? st.accounts : [];
      var banks = {};
      (st.banks || []).forEach(function (b) { banks[b.id] = String(b.name || ''); });
      var reg = G.isObj(t.feedCards) ? t.feedCards : {}, patch = {}, changed = 0, missing = [];
      var w = G.cardWindow(t), today = G.tourToday();
      var running = !isOffTour(t) && w && today >= w.from && today <= w.to;
      var ended = !isOffTour(t) && w && today > w.to;
      var onTour = function (name) {
        return cardCharges(t, String(name)).length > 0 ||
          G.cardDebts(t).some(function (d) { return G.isObj(d.feed) && d.feed.name === name; }) ||
          feedWaiting(id).some(function (it) { return it.account === name; });
      };
      var logging = {};
      // Connected but its questions never answered: it gets a "needs your answers" line, not a guess.
      S.cardUnasked = S.cardUnasked || {};
      S.cardUnasked[id] = accounts.filter(function (a) { return a && a.id && !a.asked && a.mode !== 'off'; });
      accounts.forEach(function (a) {
        // Cards that log expenses (answered, and not switched off).
        if (!a || !a.id || !a.asked || a.mode === 'off') return;
        logging[a.id] = true;
        // (income: which deposits a bank account is watched for — merch, guarantees — so the Cards tab can say.)
        var want = { name: String(a.name || 'Card'), bank: banks[a.bank] || '', kind: a.card === 'debit' ? 'debit' : 'credit',
          income: a.card === 'debit' && Array.isArray(a.income) ? a.income.map(String).sort() : [] };
        var have = reg[a.id];
        // A finished tour only lists cards that have something on it.
        if (!G.isObj(have) && ended && !onTour(want.name)) return;
        if (!G.isObj(have) || have.name !== want.name || have.bank !== want.bank || have.kind !== want.kind ||
            JSON.stringify(Array.isArray(have.income) ? have.income : []) !== JSON.stringify(want.income)) { patch[a.id] = want; changed += 1; }
        if (want.kind === 'credit' && !G.cardDebts(t).some(function (d) {
          return d.id === 'feed-' + a.id || (G.isObj(d.feed) && d.feed.name === want.name);
        })) missing.push(String(a.id));
      });
      // A card switched off or disconnected comes off the list, unless it has something on this tour.
      Object.keys(reg).forEach(function (k) {
        if (!G.isObj(reg[k]) || logging[k] || onTour(reg[k].name)) return;
        patch[k] = null; changed += 1;
      });
      if (changed && !(await api.update(id, { feedCards: patch }))) { S.cardSync[id] = 0; return; }
      // A credit card not on the tour yet: its balance is read onto it, while the
      // tour is logging. Tried once a visit for each card, not every ten minutes.
      S.cardTried = S.cardTried || {};
      missing = missing.filter(function (k) { return !S.cardTried[id + ':' + k]; });
      missing.forEach(function (k) { S.cardTried[id + ':' + k] = true; });
      if (missing.length && running) await readCardBalances(id, missing);
      render(true);
    }).catch(function () { S.cardSync[id] = 0; });
  }
  function cardRow(id, t, card, paidCell, creditCell, cashCell) {
    var sm = G.cardSummary(card, t);
    var bank = cardBank(card);
    var inner = [
      h('div', { class: 'row-label' },
        // The same short name the Cards tab gives it (its current name, if the bank reissued it).
        h('span', { class: 'cc-name' }, (tourCards(t).filter(function (c) { return c.debt && c.debt.id === card.id; })[0] || {}).label ||
          cardShort(card.feed.name || card.label, bank)),
        h('span', { class: 'hint' + (sm.remainder > 0.004 ? '' : ' done') },
          (sm.remainder > 0.004 ? money(sm.remainder) + ' to sort' : 'All sorted') +
          ' \u00b7 ' + (sm.owed > 0 ? money(sm.owed) + ' owed' : 'paid off'))),
      h('span', { class: 'amt num glow ex-proj', 'aria-label': 'Projected not set' }, '\u2014'),
      creditCell(sm.remainder),
      paidCell(sm.paidOff),
      cashCell(0)
    ];
    if (!canSeeMoney(id)) return h('div', { class: 'row ex-row cc-row' }, inner);
    return h('button', { class: 'row rowbtn ex-row cc-row', type: 'button',
      onclick: function () { openFeedCardSheet(id, card.id); } }, inner, icon('chevron', 18));
  }
  /* A linked card with no balance carried on the tour (a debit card, or a
     credit card whose balance hasn't been read on yet): its line in
     Expenses. Its charges already count under their categories, so the
     columns stay empty; tapping it lists them. */
  function plainCardRow(id, t, c) {
    var list = cardCharges(t, c).filter(function (ch) { return !ch.accounted && ch.category; });
    var total = list.reduce(function (n, ch) { return n + G.num(ch.amount); }, 0);
    var dash = function (cls) { return h('span', { class: 'amt num ' + cls }, '\u2014'); };
    var inner = [
      h('div', { class: 'row-label' },
        h('span', { class: 'cc-name' }, c.label),
        h('span', { class: 'hint' }, (c.kind === 'debit' ? 'Debit card' : 'Credit card') +
          (list.length ? ' \u00b7 ' + money(total) + ' \u00b7 ' + plural(list.length, 'charge') : ''))),
      dash('glow ex-proj'), dash('ex-paid'), dash('ex-done'), dash('ex-cash')
    ];
    if (!canSeeMoney(id)) return h('div', { class: 'row ex-row cc-row' }, inner);
    return h('button', { class: 'row rowbtn ex-row cc-row', type: 'button',
      onclick: function () { openCardCharges(id, c); } }, inner, icon('chevron', 18));
  }
  // One card's charges on this tour: what, when, where it was filed, how much.
  function openCardCharges(id, c) {
    var t = getTour(id);
    var cats = {};
    G.chargeCategoriesFor(t).forEach(function (x) { cats[x.key] = x.label; });
    var list = cardCharges(t, c);
    var total = list.reduce(function (n, ch) { return ch.accounted ? n : n + G.num(ch.amount); }, 0);
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, c.label),
        h('p', { class: 'sh-sub' }, (c.kind === 'debit' ? 'Debit card' : 'Credit card') + ' \u00b7 ' +
          plural(list.length, 'charge') + ' \u00b7 ' + money(total)),
        list.length ? h('div', { class: 'ledger logged' }, list.slice().reverse().map(function (ch) {
          return h('div', { class: 'row' },
            h('div', { class: 'row-label' }, ch.merchant || 'Charge',
              h('span', { class: 'hint' }, [ch.date ? dayMD(ch.date) : '', cats[ch.category] || 'Not sorted',
                ch.accounted ? 'already accounted for' : ''].filter(Boolean).join(' \u00b7 '))),
            h('span', { class: 'amt num' + (ch.accounted ? ' quiet' : '') }, money(G.num(ch.amount))));
        })) : null
      ];
    }, { label: c.label, cls: 'cat-sheet' });
  }
  /* One credit card: the balance it came into the tour with, where the sorted
     part of it went, what's still to sort, and what the card company is owed. */
  function openFeedCardSheet(id, cardId) {
    var t = getTour(id);
    var card = G.cardDebts(t).filter(function (d) { return d.id === cardId; })[0];
    if (!card || !G.isObj(card.feed)) return;
    var sm = G.cardSummary(card, t);
    var bank = cardBank(card);
    var cats = {};
    G.chargeCategoriesFor(t).forEach(function (c) { cats[c.key] = c.label; });
    var byCat = {}, since = 0, sinceN = 0;
    G.rows(t.charges).forEach(function (ch) {
      if (ch.accounted || !ch.category || ch.account !== card.feed.name) return;
      var d = ch.posted || ch.date;
      if (d && d <= card.cutoff) byCat[ch.category] = (byCat[ch.category] || 0) + G.num(ch.amount);
      else { since += G.num(ch.amount); sinceN += 1; }
    });
    var awayTo = {};
    G.rows(t.cardAway).forEach(function (a) {
      var d = a.posted || a.date;
      if (a.account === card.feed.name && d && d <= card.cutoff) {
        var nm = (getTour(a.to) || {}).name || 'another tour';
        awayTo[nm] = (awayTo[nm] || 0) + G.num(a.amount);
      }
    });
    Object.keys(awayTo).forEach(function (nm) { byCat['\u2192 ' + nm] = awayTo[nm]; });
    var waiting = feedWaiting(id).filter(function (it) { return it.account === card.feed.name; }).length;
    var at = G.isObj(card.owedNow) && card.owedNow.at ? new Date(card.owedNow.at) : null;
    var line = function (label, v, cls) {
      return h('div', null, h('span', null, label), h('strong', { class: 'num' + (cls ? ' ' + cls : '') }, v));
    };
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, card.label || card.feed.name),
        h('p', { class: 'sh-sub' }, [bank, 'Credit card'].filter(Boolean).join(' \u00b7 ')),
        // The whole balance, as the card company has it right now.
        h('div', { class: 'cc-total' },
          h('span', { class: 'cc-total-l' }, 'Card balance'),
          h('strong', { class: 'cc-total-v num' + (sm.owed > 0 ? '' : ' clear') }, sm.owed > 0 ? G.moneyCents(sm.owed) : 'Paid off'),
          h('span', { class: 'cc-total-at' }, (bank || 'The bank') + (at ? ', as of ' + dayMD(G.ymd(at)) + ' ' +
            at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''))),
        h('h3', { class: 'wn-h', style: 'margin-top:14px' }, 'Sorting it on this tour'),
        h('div', { class: 'preview' },
          line('Balance when logging started' + (G.parseDay(card.cutoff) ? ' (' + dayMD(card.cutoff) + ')' : ''), G.moneyCents(sm.balance)),
          line('Sorted into categories', '\u2212 ' + G.moneyCents(sm.accounted)),
          line('Still to sort', G.moneyCents(sm.remainder), sm.remainder > 0.004 ? '' : 'pos'),
          sm.over > 0.004 ? line('Sorted past the balance', G.moneyCents(sm.over), 'neg') : null),
        Object.keys(byCat).length
          ? h('section', { class: 'wn-sec' }, h('h3', { class: 'wn-h' }, 'Where it went'),
              h('div', { class: 'ledger' }, Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; }).map(function (k) {
                return h('div', { class: 'row' }, h('span', { class: 'row-label' }, cats[k] || k),
                  h('span', { class: 'amt num' }, G.moneyCents(byCat[k])));
              })))
          : h('p', { class: 'note' }, 'As you sort this card\u2019s charges, each one moves out of this balance and into its category.'),
        h('section', { class: 'wn-sec' }, h('h3', { class: 'wn-h' }, 'The card company'),
          h('div', { class: 'preview' },
            sinceN ? line('Charged since, already in their categories', G.moneyCents(since)) : null,
            sm.paidOff > 0 ? line('Paid on the card since', '\u2212 ' + G.moneyCents(sm.paidOff)) : null,
            line('Card balance now', sm.owed > 0 ? G.moneyCents(sm.owed) : 'Paid off', sm.owed > 0 ? 'neg' : 'pos'))),
        h('div', { class: 'stack' },
          waiting ? h('button', { class: 'btn primary block', type: 'button', onclick: function () {
            closeSheet(); setTimeout(function () { openFeedReview(id, 0, card.feed.name); }, 320);
          } }, icon('card', 18), 'Sort ' + plural(waiting, 'charge') + ' from this card') : null,
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Close'))
      ];
    }, { label: card.label || 'Credit card', cls: 'cat-sheet' });
  }

  /* The plan stays put in its column and what's actually been paid sits next
     to it, so over and under are there to read at a glance. */
  /* Up top on Expenses: a flow. Income comes in on the left by source
     (guarantees with any back end, merch, everything else), runs through one
     trunk, and fans out on the right into where it went: crew, bus, each
     linked card by its name, commission, the merch bill, everything else, and
     what's left over (Ahead). Spent more than came in, and the shortfall
     joins the left as Behind, so both sides always add up to the same height.
     Each side's total sits on top of its bar. The Off Tour book has no
     income: the trunk fans straight out into its expenses. */
  function expenseSummary(c, expParts, off) {
    var by = G.isObj(c.incomeBy) ? c.incomeBy : {};
    var guar = Math.max(0, G.num(by.guarantee) + G.num(by.backend)), merch = Math.max(0, G.num(by.merch));
    var income = Math.max(0, G.num(c.income));
    var incParts = Array.isArray(c.incParts) ? c.incParts.map(function (x) { return { label: x.label, v: Math.max(0, G.num(x.v)), cls: x.cls }; })
      : [{ label: 'Guarantees', v: guar, cls: 'guar' }, { label: 'Merch', v: merch, cls: 'merch' },
         { label: 'Other', v: Math.max(0, income - guar - merch), cls: 'inother' }];
    var r2 = function (v) { return Math.round(v * 100) / 100; };
    expParts = expParts.map(function (x) { return { label: x.label, v: r2(x.v), cls: x.cls }; });
    var spent = r2(expParts.reduce(function (n, x) { return n + x.v; }, 0));
    if (!(income > 0) && !(spent > 0)) return null;
    var net = r2(income - spent);
    var some = function (x) { return x.v > 0; };
    var left = off ? [] : incParts.filter(some);
    // Ahead / Behind reads as the two totals up top subtract, to the dollar.
    var gap = money(Math.abs(Math.round(income) - Math.round(spent)));
    if (!off && net < 0) left.push({ label: 'Behind', v: -net, cls: 'behind', say: gap });
    var right = expParts.filter(some);
    if (!off && net > 0) right.push({ label: 'Ahead', v: net, cls: 'ahead', say: gap });

    // Drawn 300 wide and scaled to the card. A part's bar is true to size;
    // its slot is never shorter than its label, so small ones stay readable.
    // Off Tour has one side only, so it stands just tall enough for its parts.
    var W = 300, TRUNK = off ? Math.min(184, Math.max(72, right.length * 30)) : 184, PAD = 6;
    var XL = off ? 0 : 70, XM = off ? 8 : 118, XR = off ? 96 : 166, BAR = 8;
    var column = function (parts, minSlot, gap) {
      var sum = parts.reduce(function (n, x) { return n + x.v; }, 0) || 1, y = 0, at = 0;
      parts.forEach(function (x) {
        x.t0 = at; at += x.v / sum * TRUNK; x.t1 = at;          // where it meets the trunk
        x.h = Math.max(1.5, x.v / sum * TRUNK);
        x.slot = Math.max(x.h, minSlot); x.s0 = y; y += x.slot + gap;
      });
      return parts.length ? y - gap : 0;
    };
    var hl = column(left, 27, 5), hr = column(right, 13.5, 4);
    var H = Math.max(hl, hr, TRUNK) + PAD * 2, trunkY = (H - TRUNK) / 2;
    // The parts ease in once, on arriving. The page redraws as data lands, so
    // each redraw picks the easing up where the last one left it.
    if (!S.xsAt) S.xsAt = Date.now();
    var since = Date.now() - S.xsAt;
    var NS = 'http://www.w3.org/2000/svg';
    var s = function (tag, attrs, kids) {
      var n = document.createElementNS(NS, tag);
      Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      (kids || []).forEach(function (k) { if (k != null) n.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); });
      return n;
    };
    var f = function (v) { return v.toFixed(1); };
    var ribbon = function (xa, a0, a1, xb, b0, b1) {
      var cx = f((xa + xb) / 2);
      return 'M' + f(xa) + ' ' + f(a0) + ' C' + cx + ' ' + f(a0) + ' ' + cx + ' ' + f(b0) + ' ' + f(xb) + ' ' + f(b0) +
        ' L' + f(xb) + ' ' + f(b1) + ' C' + cx + ' ' + f(b1) + ' ' + cx + ' ' + f(a1) + ' ' + f(xa) + ' ' + f(a1) + ' Z';
    };
    var short = function (name) { name = String(name || ''); return name.length > 12 ? name.slice(0, 11).trim() + '…' : name; };
    var part = function (x, i, side, top) {
      var slot0 = top + x.s0, y0 = slot0 + (x.slot - x.h) / 2, y1 = y0 + x.h, mid = slot0 + x.slot / 2;
      var net = x.cls === 'ahead' || x.cls === 'behind';
      var g = s('g', { class: 'xs-p ' + x.cls + (net ? ' net' : ''), style: 'animation-delay:' + (i * 45 - since) + 'ms' });
      if (side === 'in') {
        g.appendChild(s('path', { class: 'xs-rb', d: ribbon(XL + BAR, y0, y1, XM, trunkY + x.t0, trunkY + x.t1) }));
        g.appendChild(s('rect', { class: 'xs-n', x: XL, y: f(y0), width: BAR, height: f(x.h), rx: 2 }));
        g.appendChild(s('text', { class: 'xs-t', x: XL - 6, y: f(mid - 1.5), 'text-anchor': 'end' }, [short(x.label)]));
        g.appendChild(s('text', { class: 'xs-a', x: XL - 6, y: f(mid + 10.5), 'text-anchor': 'end' }, [x.say || money(x.v)]));
        g.appendChild(s('rect', { class: 'xs-hit', x: 0, y: f(slot0), width: XM, height: f(x.slot) }));
      } else {
        g.appendChild(s('path', { class: 'xs-rb', d: ribbon(XM + BAR, trunkY + x.t0, trunkY + x.t1, XR, y0, y1) }));
        g.appendChild(s('rect', { class: 'xs-n', x: XR, y: f(y0), width: BAR, height: f(x.h), rx: 2 }));
        g.appendChild(s('text', { class: 'xs-t', x: XR + BAR + 6, y: f(mid + 3.8) },
          [short(x.label) + ' ', s('tspan', { class: 'xs-a' }, [x.say || money(x.v)])]));
        g.appendChild(s('rect', { class: 'xs-hit', x: XM + BAR, y: f(slot0 - 2), width: W - XM - BAR, height: f(x.slot + 4) }));
      }
      return g;
    };
    var svg = s('svg', { class: 'xs-flow' + (since < 1200 ? ' anim' : ''), viewBox: '0 0 ' + W + ' ' + f(H), width: '100%', 'aria-hidden': 'true' });
    left.forEach(function (x, i) { svg.appendChild(part(x, i, 'in', (H - hl) / 2)); });
    svg.appendChild(s('rect', { class: 'xs-trunk', x: XM, y: f(trunkY), width: BAR, height: TRUNK, rx: 2 }));
    right.forEach(function (x, i) { svg.appendChild(part(x, left.length + i, 'out', (H - hr) / 2)); });
    // Tap a part and the rest step back; tap it again, or anywhere else, to let go.
    svg.addEventListener('click', function (e) {
      var g = e.target.closest ? e.target.closest('.xs-p') : null, was = g && g.classList.contains('on');
      Array.prototype.forEach.call(svg.querySelectorAll('.xs-p.on'), function (n) { n.classList.remove('on'); });
      if (g && !was) g.classList.add('on');
      svg.classList.toggle('pick', !!(g && !was));
    });

    var head = function (label, amount, cls) {
      return h('div', { class: 'xs-head ' + cls }, h('span', { class: 'xs-k' }, label), h('strong', { class: 'xs-v num' }, money(amount)));
    };
    var say = function (parts) { return parts.map(function (x) { return x.label + ' ' + money(x.v); }).join(', '); };
    // The words on the right run shorter than the room kept for them, which
    // left the picture sitting to the left. Once it's on the page, measure
    // what's actually drawn (totals, bars, labels) and slide the lot so the
    // space either side is equal. The last answer is kept, so a redraw
    // starts in the right place.
    var kind = off ? 'off' : 'on';
    var body = h('div', { class: 'xs-body' },
      h('div', { class: 'xs-heads' }, off ? null : head('Income', income, 'in'), head('Expenses', spent, 'out')),
      svg);
    var slide = function (pct) { body.style.transform = pct ? 'translateX(' + pct.toFixed(2) + '%)' : ''; };
    S.xsShift = S.xsShift || {};
    slide(S.xsShift[kind] || 0);
    var centre = function () {
      if (!body.isConnected) return;
      slide(0);
      var box = body.getBoundingClientRect(), lo = Infinity, hi = -Infinity;
      if (!box.width) return;
      Array.prototype.forEach.call(body.querySelectorAll('.xs-head > *, text, .xs-n, .xs-trunk'), function (n) {
        var r = n.getBoundingClientRect();
        if (r.width) { lo = Math.min(lo, r.left); hi = Math.max(hi, r.right); }
      });
      if (hi > lo) S.xsShift[kind] = ((box.right - hi) - (lo - box.left)) / 2 / box.width * 100;
      slide(S.xsShift[kind] || 0);
    };
    requestAnimationFrame(centre);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(centre);
    return h('section', { class: 'xs-card' + (off ? ' solo' : ''), role: 'img',
      'aria-label': (off ? '' : 'Income ' + money(income) + ': ' + say(incParts) + '. ') +
        'Expenses ' + money(spent) + ': ' + say(expParts) +
        (off ? '' : '. ' + gap + (net >= 0 ? ' ahead' : ' behind') + ' so far') + '.' },
      body);
  }

  function tabExpenses(id, t, c, o) {
    var off = !!(o && o.off);
    if (!off) syncCrew(id);
    // The Off Tour book leaves out what only a tour has.
    if (off) c = Object.assign({}, c, { lines: c.lines.filter(function (l) { return l.key !== 'offdebt' && l.key !== 'commission'; }) });
    var edit = canEditTour(id);
    var chev = edit ? h('span', { class: 'ex-chev', 'aria-hidden': 'true' }) : null;
    var head = h('div', { class: 'row ex-head', 'aria-hidden': 'true' },
      h('span', null, ''), h('span', { class: 'ex-proj' }, 'Projected'), h('span', { class: 'ex-paid' }, 'Credit'),
      h('span', { class: 'ex-done' }, 'Debit'), h('span', { class: 'ex-cash' }, 'Cash'), chev ? chev.cloneNode() : null);
    // Credit: what went on a credit card (still owed until the card is paid).
    // Debit: money that's gone, paid by debit card, cash or check, and on a
    // card's own line the payments made to the card company (the splashes).
    var paidOutTotal = 0, creditTotal = 0;
    // What each row comes to (its credit + debit + cash), for the bars up top.
    var byRow = {}, rowKey = '';
    var tally = function (v) { byRow[rowKey] = (byRow[rowKey] || 0) + v; };
    var paidCell = function (v) {
      v = Math.round(G.num(v) * 100) / 100;
      paidOutTotal += v; tally(v);
      return h('span', { class: 'amt num ex-done', 'aria-label': 'Debit ' + money(v) }, v > 0.004 ? money(v) : '\u2014');
    };
    var cashTotal = 0;
    var cashCell = function (v) {
      v = Math.round(G.num(v) * 100) / 100;
      cashTotal += v; tally(v);
      return h('span', { class: 'amt num ex-cash', 'aria-label': 'Cash ' + money(v) }, v > 0.004 ? money(v) : '\u2014');
    };
    var creditCell = function (v, over) {
      v = Math.round(G.num(v) * 100) / 100;
      creditTotal += v; tally(v);
      return h('span', { class: 'amt num ex-paid' + (over ? ' over' : ''), 'aria-label': 'Credit ' + money(v) },
        Math.abs(v) > 0.004 ? money(v) : '\u2014');
    };
    // Commission reads like every other category, a plain line, until a
    // deal is actually filled in.
    var comm = G.normCommission(t && t.commission);
    var commSet = G.commissionLines(comm).some(function (cl) { return G.num(comm[cl.key].value) > 0; });
    var feedCards = G.cardDebts(t).filter(function (d) { return G.isObj(d.feed); });
    var lineRow = function (l) {
      // "Credit card (other)" is not a linked card: it counts under Other.
      rowKey = l.label === 'Credit card (other)' ? 'card-other' : l.key;
      var hint = lineHint(l);
      var unset = l.projected == null || (l.key === 'commission' && !l.projected && !commSet);
      var inner = [
        h('div', { class: 'row-label' }, l.label,
          hint.text ? h('span', { class: 'hint' + hint.cls }, hint.text) : null),
        h('span', { class: 'amt num glow ex-proj', 'aria-label': 'Projected ' + (unset ? 'not set' : money(l.projected)) },
          unset ? '\u2014' : money(l.projected)),
        // Commission is paid from the bank, so it reads as debit.
        creditCell(l.key === 'commission' ? 0 : l.creditOut != null ? l.creditOut : l.paid - paidPart(t, l.key), l.over > 0),
        paidCell(l.paidOut != null ? l.paidOut : l.key === 'commission' ? l.paid : debitPart(t, l.key) +
          (l.key === 'card' ? G.cardDebts(t).reduce(function (n, d) { return n + G.cardSummary(d, t).paidOff; }, 0) : 0)),
        cashCell(l.key === 'commission' ? 0 : l.cashOut != null ? l.cashOut : cashPart(t, l.key))
      ];
      if (!edit) return h('div', { class: 'row ex-row' }, inner);
      return h('button', {
        class: 'row rowbtn ex-row', type: 'button',
        onclick: function () {
          if (l.key === 'crew') openCrewSheet(id, true);
          else if (l.key === 'commission') openCommissionSheet(id);
          else openCategorySheet(id, l.key);
        }
      }, inner, icon('chevron', 18));
    };
    // The order: the cards linked to the app first. Then every category by
    // what's owed on credit, the most first; then by what's been spent; then
    // by what's projected. Untouched ones keep their usual order at the end.
    var owedOn = function (l) {
      return l.key === 'commission' ? 0 : Math.max(0, l.creditOut != null ? l.creditOut : l.paid - paidPart(t, l.key));
    };
    var entries = [];
    c.lines.forEach(function (l, i) {
      if (l.key !== 'card' || !feedCards.length) { entries.push({ l: l, i: i }); return; }
      // Anything else under Credit card (a card typed in by hand, or a charge
      // sorted there) keeps a line of its own.
      var inCards = feedCards.reduce(function (n, card) { return n + G.cardSummary(card, t).remainder; }, 0);
      var rest = Math.round((l.paid - inCards) * 100) / 100;
      var otherPaid = debitPart(t, 'card') + cashPart(t, 'card') + G.cardDebts(t).filter(function (d) { return !G.isObj(d.feed); })
        .reduce(function (n, d) { return n + G.cardSummary(d, t).paidOff; }, 0);
      if (rest > 0.004 || l.projected != null || otherPaid > 0.004) {
        entries.push({ i: i, l: Object.assign({}, l, {
          label: 'Credit card (other)', paid: Math.max(0, rest),
          cards: (l.cards || []).filter(function (r) { return !r.feed; }),
          over: l.projected != null ? Math.max(0, rest - l.projected) : 0,
          paidOut: otherPaid - cashPart(t, 'card'),
          cashOut: cashPart(t, 'card'),
          creditOut: Math.max(0, rest) - paidPart(t, 'card'),
          left: l.projected != null ? Math.max(0, l.projected - Math.max(0, rest)) : l.left
        }) });
      }
    });
    entries.forEach(function (e) { e.owed = Math.round(owedOn(e.l) * 100) / 100; e.spent = G.num(e.l.paid); e.proj = G.num(e.l.projected); });
    entries.sort(function (a, b) { return (b.owed - a.owed) || (b.spent - a.spent) || (b.proj - a.proj) || (a.i - b.i); });
    var rows = [];
    feedCards.forEach(function (card) { rowKey = 'feed:' + card.id; rows.push(cardRow(id, t, card, paidCell, creditCell, cashCell)); });
    // Every other linked card (debit cards; a credit card whose balance isn't on the tour yet) has its line too.
    tourCards(t).filter(function (c) { return !c.debt; }).forEach(function (c) { rows.push(plainCardRow(id, t, c)); });
    if (!off) { syncCards(id); ensurePile(id); }
    entries.forEach(function (e) {
      rows.push(lineRow(e.l));
      // Monthly utilities opens out into the vendors behind it.
      if (VENDOR_CATS[e.l.key]) vendorRows(id, t, e.l.key, edit).forEach(function (r) { rows.push(r); });
    });
    // The bars' Expenses segments: crew, bus, each linked card by its name,
    // commission, the merch bill, and everything else together.
    var named = [['Crew', 'crew', 'crew'], ['Bus', 'bus', 'bus']]
      .concat(feedCards.map(function (card) { return [cardShort(card.feed.name || card.label, cardBank(card)), 'feed:' + card.id, 'lcard']; }))
      .concat([['Commission', 'commission', 'comm'], ['Merch bill', 'merch', 'mbill']]);
    var spentAll = Object.keys(byRow).reduce(function (n, k) { return n + Math.max(0, byRow[k]); }, 0);
    var expParts = named.map(function (x) { return { label: x[0], v: Math.max(0, byRow[x[1]] || 0), cls: x[2] }; });
    expParts.push({ label: 'Other', cls: 'other',
      v: Math.max(0, spentAll - expParts.reduce(function (n, x) { return n + x.v; }, 0)) });
    var projTotal = 0, paidTotal = 0;
    c.lines.forEach(function (l) { projTotal += l.projected || 0; paidTotal += l.paid; });
    rows.unshift(head);
    // One straight line, each total under its column.
    rows.push(h('div', { class: 'row total ex-total' },
      h('span', null, 'Total'),
      h('strong', { class: 'amt num glow ex-proj' }, money(projTotal)),
      h('strong', { class: 'amt num ex-paid' }, money(creditTotal)),
      h('strong', { class: 'amt num ex-done' }, money(paidOutTotal)),
      h('strong', { class: 'amt num ex-cash' }, money(cashTotal)),
      chev ? chev.cloneNode() : null));
    var charges = G.rows(t && t.charges);
    var baselineOffer = (!off && canEditTour(id) && budgetIsBlank(t) && !charges.length && baselineCandidates(id).length)
      ? h('button', { class: 'btn quiet block', type: 'button', style: 'margin-bottom:14px',
          onclick: function () { openBaselinePicker(id); } },
          icon('copy', 18), 'Start from a previous tour’s budget')
      : null;
    return [
      expenseSummary(c, expParts, off),
      // On a tour, Refresh Card Expenses lives on the Cards tab; the Off Tour book keeps it here.
      off ? feedEntry(id) : null,
      baselineOffer,
      // The chart says it all: nothing under the Total.
      h('div', { class: 'ledger' }, rows)
    ];
  }

  /* Where each dollar in a category came from, so a wrong one is easy to
     spot: PLAID (the card feed), MANUAL (logged by hand), PDF, SCREENSHOT or
     CSV (a statement imported), and UNKNOWN when Greenroom can't tell, which
     is a bug worth reporting. */
  function chargeSource(t, ch) {
    if (ch.manual) return 'MANUAL';
    var imp = ch.importId && G.isObj(t && t.imports) ? t.imports[ch.importId] : null;
    var src = imp ? String(imp.source || '') : '';
    if (src === 'Card feed' || (!imp && /^p/.test(ch.id) && /^cards-/.test(String(ch.importId || '')))) return 'PLAID';
    if (src === 'csv') return 'CSV';
    if (src === 'pdf') return 'PDF';
    if (src === 'image') return 'SCREENSHOT';
    return 'UNKNOWN';
  }
  // Of what's spent in a category, what's already paid: debit, cash, check.
  // Debit: paid by debit card or check. Cash: what the merch cash log spent
  // in this category, plus cash logged by hand that didn't come out of it.
  // Both are money already gone (paidPart is the two).
  function debitPart(t, key) {
    var n = 0;
    G.rows(t && t.charges).forEach(function (ch) {
      if (ch.category === key && ch.paid && !ch.cash && !ch.accounted) n += G.num(ch.amount);
    });
    return Math.round(n * 100) / 100;
  }
  function cashPart(t, key) {
    var n = 0;
    G.rows(t && t.charges).forEach(function (ch) {
      if (ch.category === key && ch.cash && !ch.accounted) n += G.num(ch.amount);
    });
    G.rows(t && t.cashLog).forEach(function (x) { if (x.category === key) n += G.num(x.amount); });
    return Math.round(n * 100) / 100;
  }
  function paidPart(t, key) { return Math.round((debitPart(t, key) + cashPart(t, key)) * 100) / 100; }
  function categoryEntries(t, key) {
    var out = [];
    G.rows(t && t.charges).forEach(function (ch) {
      if (ch.category !== key) return;
      out.push({ date: ch.date || '', label: ch.merchant || 'Charge', amount: G.num(ch.amount),
        detail: [ch.cash ? 'Cash' : ch.paid ? 'Debit' : 'Credit', ch.by ? 'sorted by ' + ch.by : '',
          ch.accounted ? 'already accounted for' : ''].filter(Boolean).join(' · '),
        // The card it came from, by its short name.
        card: cardLabelFor(t, ch.account),
        // name: exactly as stored (what a vendor group is read from); how: its Expenses column.
        name: ch.merchant || '', how: ch.cash ? 'cash' : ch.paid ? 'debit' : 'credit',
        source: chargeSource(t, ch), chargeId: ch.id, counts: !ch.accounted });
    });
    G.rows(t && t.cashLog).forEach(function (x) {
      if (x.category !== key) return;
      out.push({ date: x.date || '', label: x.note || x.label || 'Merch cash', amount: G.num(x.amount),
        name: x.note || x.label || '', how: 'cash',
        detail: 'Merch cash', source: 'MANUAL', cashId: x.id, counts: true });
    });
    (G.cardPaidDetail(t)[key] || []).forEach(function (r) {
      out.push({ date: '', label: r.label + (r.feed ? ' balance' : r.leftover ? ' (left over going in)' : ' going in'),
        amount: r.amount, detail: r.feed ? 'Still under Credit card' : 'Card balance going into the tour',
        source: r.feed ? 'PLAID' : 'MANUAL', counts: true });
    });
    // Each guarantee the booking agent holds as an advance (agency deposit).
    if (key === 'commission') {
      G.calc(t).agencyShows.forEach(function (x) {
        out.push({ date: x.date, label: 'Agency advance \u00b7 ' + String(x.city).split(',')[0], amount: x.amount,
          detail: 'Guarantee held by the booking agent', source: 'AGENCY', counts: true });
      });
    }
    var typed = G.num((G.normExpenses(t && t.expenses)[key] || {}).paid);
    if (typed > 0) out.push({ date: '', label: 'Paid (typed in)', amount: typed, detail: 'One total, typed in by hand',
      source: 'MANUAL', typed: true, counts: true });
    // Newest first (Devin, 2026-10-07); the balances going in (no date) still lead the list.
    return out.sort(function (a, b) {
      var ua = a.date ? 1 : 0, ub = b.date ? 1 : 0;
      if (ua !== ub) return ua - ub;
      return String(b.date).localeCompare(String(a.date)) || (G.num(b.createdAt) - G.num(a.createdAt));
    });
  }
  /* A category that's really many bills under one line breaks down into the
     vendors behind them (G.vendorGroups): Monthly utilities into Amazon,
     Verizon, Storage... It's the same entries looked at a second way, so no
     total moves. What was regrouped by hand lives on the tour, under
     vendorGroups.<category>. */
  var VENDOR_CATS = { utilities: true };
  function categoryGroups(t, key) {
    var cat = (G.typedCategoriesFor(t).filter(function (c) { return c.key === key; })[0] || {}).label || '';
    var list = categoryEntries(t, key).map(function (r) {
      var eid = r.chargeId || r.cashId || null;
      // A payment logged with its details left blank is stored under the
      // category's own name: there's no vendor in that.
      var loose = !eid || !r.name || G.vendorNorm(r.name) === G.vendorNorm(cat);
      return { id: eid, name: r.name || '', amount: r.amount, counts: r.counts, how: r.how, loose: loose, row: r };
    });
    return G.vendorGroups(list, G.isObj(t && t.vendorGroups) ? t.vendorGroups[key] : null);
  }
  var entryCount = function (n) { return n + (n === 1 ? ' entry' : ' entries'); };
  // The dropdown under the category's line on Expenses: one row per group,
  // its numbers under the same Credit / Debit / Cash columns. These cells are
  // drawn plain on purpose: the page's totals already count the category once.
  function vendorRows(id, t, key, canOpen) {
    var groups = categoryGroups(t, key);
    // One pile with no vendor in it (or nothing at all): nothing to break down.
    if (!groups.some(function (g) { return g.key; })) return [];
    S.exOpen = S.exOpen || {};
    var k = id + ':' + key;
    if (S.exOpen[k] === undefined) S.exOpen[k] = lsGet('gr-exopen:' + k) === '1';
    var open = !!S.exOpen[k];
    var cell = function (cls, v, word) {
      return h('span', { class: 'amt num ' + cls, 'aria-label': word + ' ' + money(v) }, Math.abs(v) > 0.004 ? money(v) : '\u2014');
    };
    var toggle = h('button', { class: 'row ex-sub-toggle' + (open ? ' open' : ''), type: 'button', 'aria-expanded': open ? 'true' : 'false',
      onclick: function () { S.exOpen[k] = !open; lsSet('gr-exopen:' + k, open ? '' : '1'); render(true); } },
      icon('chevron', 14), h('span', null, open ? 'Hide the breakdown' : 'Break it down \u00b7 ' + plural(groups.length, 'group')));
    if (!open) return [toggle];
    return [toggle].concat(groups.map(function (g) {
      var inner = [
        h('div', { class: 'row-label' }, g.label, h('span', { class: 'hint' }, entryCount(g.count))),
        h('span', { class: 'amt num ex-proj', 'aria-hidden': 'true' }, ''),
        cell('ex-paid', g.credit, 'Credit'), cell('ex-done', g.debit, 'Debit'), cell('ex-cash', g.cash, 'Cash')];
      if (!canOpen) return h('div', { class: 'row ex-row ex-sub' }, inner, h('span', { class: 'ex-chev', 'aria-hidden': 'true' }));
      return h('button', { class: 'row rowbtn ex-row ex-sub', type: 'button', 'aria-label': g.label + ', ' + money(g.total) + ', ' + entryCount(g.count),
        onclick: function () { openLoggedSheet(id, key, null, { group: g.key }); } }, inner, icon('chevron', 18));
    }));
  }
  /* Move an entry to another group: an existing one, or a new one typed in.
     For a card charge the choice can cover every charge stored under the
     same name, so next month's bill lands there by itself. */
  function openVendorMove(id, key, r, after) {
    var t = getTour(id);
    var groups = categoryGroups(t, key);
    var eid = r.chargeId || r.cashId;
    var mine = groups.filter(function (g) { return g.entries.some(function (e) { return e.id === eid; }); })[0];
    var me = mine ? mine.entries.filter(function (e) { return e.id === eid; })[0] : null;
    // Stored under the category's own name (details left blank): there is no
    // vendor to make a name-wide rule from, so only this one entry moves.
    var nameKey = me && me.loose ? '' : G.vendorNorm(r.name);
    var over = (G.isObj(t.vendorGroups) && G.isObj(t.vendorGroups[key])) ? t.vendorGroups[key] : {};
    var moved = !!((G.isObj(over.one) && over.one[eid]) || (nameKey && G.isObj(over.by) && over.by[nameKey]));
    var f = { pick: mine ? mine.label : '', fresh: '', all: !!nameKey };
    var again = function () { setTimeout(after, 260); };
    openSheet(function () {
      var freshIn = h('input', { class: 'input', type: 'text', maxlength: 30, autocomplete: 'off', placeholder: 'New group, e.g. Insurance',
        'aria-label': 'New group name', value: f.fresh,
        oninput: function (e) { f.fresh = e.target.value; if (f.fresh.trim()) { f.pick = ''; paint(); } } });
      var listHost = h('div', { class: 'vg-list', role: 'radiogroup', 'aria-label': 'Group' });
      var paint = function () {
        fillEl(listHost, groups.map(function (g) {
          var on = !f.fresh.trim() && f.pick === g.label;
          return h('button', { class: 'vg-pick' + (on ? ' on' : ''), type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false',
            onclick: function () { f.pick = g.label; f.fresh = ''; freshIn.value = ''; paint(); } },
            h('span', { class: 'vg-dot', 'aria-hidden': 'true' }), h('span', { class: 'vg-name' }, g.label),
            h('span', { class: 'amt num' }, money(g.total)));
        }));
      };
      paint();
      var allBox = h('input', { type: 'checkbox', class: 'rv-check', checked: f.all, onchange: function (e) { f.all = e.target.checked; } });
      var write = async function (label) {
        var patch = { one: {}, by: {} };
        // One rule per entry: the name-wide one, or this entry alone.
        if (label == null) { patch.one[eid] = null; if (nameKey) patch.by[nameKey] = null; }
        else if (f.all && nameKey) { patch.by[nameKey] = label; patch.one[eid] = null; }
        else patch.one[eid] = label;
        var vg = {}; vg[key] = patch;
        if (!(await api.update(id, { vendorGroups: vg }))) return;
        toast(label == null ? 'Back where it sorts by itself' : 'Moved to ' + label);
        render(true);
        closeSheet(); again();
      };
      return [
        h('h2', { class: 'sh-title' }, 'Move to a group'),
        h('p', { class: 'sh-sub' }, r.label + ' \u00b7 ' + money(r.amount)),
        h('form', { class: 'sh-form', novalidate: true, onsubmit: function (e) {
          e.preventDefault(); blurActive();
          // Only a name typed here is cut to size; a group picked from the list goes whole.
          var label = f.fresh.trim() ? f.fresh.trim().slice(0, 30) : f.pick;
          if (!label) { toast('Pick a group, or name a new one'); return; }
          if (!G.vendorNorm(label)) { toast('Use letters or numbers in the group name'); return; }
          write(label);
        } },
          listHost,
          field('Or a new group', freshIn),
          nameKey ? h('label', { class: 'vg-all' }, allBox,
            h('span', null, 'Every charge from \u201c' + r.name + '\u201d, now and later')) : null,
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Move'),
            moved ? h('button', { class: 'btn quiet block', type: 'button', onclick: function () { write(null); } }, 'Let it sort by itself again') : null,
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); again(); } }, 'Cancel')))
      ];
    }, { label: 'Move to a group', cls: 'cat-sheet' });
  }
  // A group's name on this tour. Renaming two groups to the same thing makes them one.
  function openVendorRename(id, key, g, after) {
    var f = { name: g.label };
    // A name that is already longer than a typed one may be is never clipped.
    var cap = Math.max(30, g.label.length);
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'Rename this group'),
        h('p', { class: 'sh-sub' }, 'Give two groups the same name and they become one.'),
        h('form', { class: 'sh-form', novalidate: true, onsubmit: async function (e) {
          e.preventDefault(); blurActive();
          var name = f.name.trim().slice(0, cap);
          if (!name) { toast('Type a name'); return; }
          if (!G.vendorNorm(name)) { toast('Use letters or numbers in the group name'); return; }
          // Other has no name to change back, so nothing is renamed into it.
          if (G.vendorNorm(name) === 'other') { toast('Other is where everything else goes. Swipe a charge and tap Group to move it there.'); return; }
          // The rename covers what sorts into this group by itself, and
          // whatever was put in it by hand.
          var t0 = getTour(id);
          var ov = (G.isObj(t0 && t0.vendorGroups) && G.isObj(t0.vendorGroups[key])) ? t0.vendorGroups[key] : {};
          var names = {}, one = {}, by = {};
          g.keys.forEach(function (k) { names[k] = name; });
          var mineToo = function (from, to) {
            Object.keys(G.isObj(from) ? from : {}).forEach(function (k) {
              if (typeof from[k] === 'string' && G.vendorNorm(from[k]) === g.key) to[k] = name;
            });
          };
          mineToo(ov.one, one); mineToo(ov.by, by);
          var vg = {}; vg[key] = { names: names, one: one, by: by };
          if (!(await api.update(id, { vendorGroups: vg }))) return;
          toast('Renamed');
          render(true);
          closeSheet(); setTimeout(function () { after(G.vendorNorm(name) === 'other' ? '' : G.vendorNorm(name)); }, 260);
        } },
          field('Group name', h('input', { class: 'input', type: 'text', maxlength: cap, autocomplete: 'off', value: f.name,
            'aria-label': 'Group name', oninput: function (e) { f.name = e.target.value; } })),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Save'),
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); setTimeout(function () { after(g.key); }, 260); } }, 'Cancel')))
      ];
    }, { label: 'Rename this group', cls: 'cat-sheet' });
  }

  /* A row that slides left to show its actions (Edit, Undo). A tap opens
     it too, and tapping again closes it. */
  function swipeRow(inner, acts) {
    var tray = h('div', { class: 'sw-acts' }, acts);
    var face = h('div', { class: 'sw-face' }, inner);
    var row = h('div', { class: 'sw-row' }, tray, face);
    var x0 = null, y0 = 0, dx = 0, open = false, drag = false, W = 0;
    function set(px, anim) {
      face.style.transition = anim ? 'transform .22s ease' : 'none';
      face.style.transform = px ? 'translateX(' + px + 'px)' : '';
      row.classList.toggle('open', px < 0);
    }
    face.addEventListener('touchstart', function (e) {
      var t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dx = open ? -W : 0; drag = false; W = tray.offsetWidth;
    }, { passive: true });
    face.addEventListener('touchmove', function (e) {
      if (x0 == null) return;
      var t = e.touches[0], mx = t.clientX - x0, my = t.clientY - y0;
      if (!drag && Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my) * 1.2) drag = true;
      if (!drag) return;
      dx = Math.max(-W, Math.min(0, (open ? -W : 0) + mx));
      set(dx, false);
    }, { passive: true });
    face.addEventListener('touchend', function () {
      if (x0 == null) return;
      x0 = null;
      if (!drag) return;
      open = dx < -W / 3;
      set(open ? -W : 0, true);
      row.dataset.swiped = String(Date.now());
    });
    face.addEventListener('click', function () {
      if (Date.now() - Number(row.dataset.swiped || 0) < 400) return;   // the end of a swipe, not a tap
      W = tray.offsetWidth; open = !open; set(open ? -W : 0, true);
    });
    return row;
  }

  // A card charge logged by mistake goes back under "X new charges" (the
  // tour manager's, as filing is). Edit sends it back and opens it straight
  // away to sort again: category, and Off Tour / Current / Upcoming.
  async function unfileCharge(id, chargeId) {
    var B = window.GR_BACKEND, r = null;
    try { r = await B.feedCall('unfile', { tourId: id, id: chargeId }); } catch (e) { r = null; }
    if (!r || !r.ok) {
      toast(r && r.error === 'not_allowed' ? 'Only the tour manager can undo card charges.'
        : r && r.error === 'offline' ? NO_SIGNAL : 'Couldn\u2019t undo that. Try again.');
      return null;
    }
    S.pile = {};   // the tour manager's pile reads again
    return r;
  }
  async function editCharge(id, ch) {
    var r = await unfileCharge(id, ch.id);
    if (!r) return;
    var home = r.tourId || id;
    var valid = {};
    G.chargeCategoriesFor(getTour(home)).forEach(function (c) { valid[c.key] = true; });
    var was = ch.category === 'offdebt' ? ch.offCategory : ch.category;
    var row = { feedId: String(ch.id).replace(/^p/, ''), date: ch.date, posted: ch.posted || ch.date, merchant: ch.merchant,
      amount: G.num(ch.amount), account: ch.account || '', category: was && valid[was] && was !== 'offdebt' ? was : '',
      source: null, why: '', duplicate: false, preCutoff: false, keep: G.num(ch.amount) > 0 };
    closeSheet();
    render(true);
    setTimeout(function () { openImportReview(home, [row], 'Card feed', { feed: true, card: row.account || 'Card' }); }, 340);
  }

  /* Edit an entry logged by hand: a payment (credit, debit or cash), a merch
     cash entry, or a category's typed-in total. The amount, the details, the
     day, how it was paid, and the category, if it went under the wrong one. */
  function openManualEdit(id, key, r, back, ret) {
    var t = getTour(id);
    var again = function () { setTimeout(ret || function () { openLoggedSheet(id, key, back); }, 260); };
    var ch = r.chargeId ? (t.charges || {})[r.chargeId] : null;
    var cl = r.cashId ? (t.cashLog || {})[r.cashId] : null;
    if (!r.typed && !ch && !cl) { toast('That entry isn\u2019t there anymore.'); return; }
    var cats = G.chargeCategoriesFor(t).filter(function (c) { return c.key !== 'commission' && c.key !== 'offdebt'; });
    var f = {
      amount: r.typed ? r.amount : G.num((ch || cl).amount),
      what: r.typed ? '' : String(ch ? ch.merchant || '' : cl.label || cl.note || ''),
      date: r.typed ? '' : String((ch || cl).date || ''),
      how: ch ? (ch.cash ? 'cash' : ch.paid ? 'paid' : 'spent') : null,
      category: key
    };
    openSheet(function () {
      var sel = h('select', { class: 'input', 'aria-label': 'Category', onchange: function (e) { f.category = e.target.value; } },
        cats.map(function (c) { return h('option', { value: c.key }, c.label); }));
      sel.value = f.category;
      var submit = async function (e) {
        e.preventDefault();
        blurActive();
        if (!(f.amount > 0)) { toast('Enter how much it was'); return; }
        var patch;
        if (r.typed) { patch = { expenses: {} }; patch.expenses[key] = { paid: f.amount }; }
        else {
          if (!G.parseDay(f.date)) { toast('Pick the day'); return; }
          if (ch) {
            patch = { charges: {} };
            patch.charges[r.chargeId] = { amount: f.amount, merchant: f.what.trim() || ch.merchant || 'Charge', date: f.date,
              category: f.category, paid: f.how !== 'spent', cash: f.how === 'cash' };
          } else {
            patch = { cashLog: {} };
            patch.cashLog[r.cashId] = { amount: f.amount, label: f.what.trim() || cl.label || 'Cash', date: f.date, category: f.category };
          }
        }
        if (await api.update(id, patch)) {
          delete S.drafts['exp:' + id];
          toast('Saved');
          render(true);
          if (f.category !== key && !ret) { closeSheet(); } else again();
        }
      };
      return [
        h('h2', { class: 'sh-title' }, 'Edit this entry'),
        h('p', { class: 'sh-sub' }, r.typed ? 'A total typed in by hand.' : cl ? 'From the merch cash log.' : 'Logged by hand.'),
        h('form', { class: 'sh-form', novalidate: true, onsubmit: submit },
          ch ? segmented(['Credit', 'Debit', 'Cash'], ['spent', 'paid', 'cash'].indexOf(f.how), function (i) {
            f.how = ['spent', 'paid', 'cash'][i];
          }, 'Credit, debit or cash') : null,
          field('How much', moneyInput({ id: 'me-amt', value: f.amount, label: 'Amount', nextId: r.typed ? null : 'me-what',
            onValue: function (v) { f.amount = v; } })),
          r.typed ? null : [
            field('Expense details', h('input', { class: 'input', type: 'text', id: 'me-what', maxlength: 60, autocomplete: 'off',
              value: f.what, oninput: function (e) { f.what = e.target.value; } })),
            field('Day', h('input', { class: 'input', type: 'date', value: f.date, 'aria-label': 'Day',
              onchange: function (e) { f.date = e.target.value; } })),
            field('Category', h('div', { class: 'sel-wrap' }, sel, icon('chevron', 16)))],
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Save'),
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); again(); } }, 'Cancel')))
      ];
    }, { label: 'Edit this entry', cls: 'cat-sheet' });
  }

  // o.group: only that vendor group (its key; '' is Other) of a category that breaks down.
  function openLoggedSheet(id, key, back, o) {
    var reopen = function (group) {
      openLoggedSheet(id, key, back, group === undefined ? o : (group == null ? null : { group: group }));
    };
    function build() {
      var t = getTour(id);
      var cat = G.typedCategoriesFor(t).filter(function (c) { return c.key === key; })[0] || { label: key };
      var groups = VENDOR_CATS[key] ? categoryGroups(t, key) : null;
      if (groups && !groups.some(function (g) { return g.key; })) groups = null;
      // The one group asked for (if a move just emptied it, the whole category shows instead).
      var only = groups && o && o.group != null ? groups.filter(function (g) { return g.key === o.group; })[0] || null : null;
      var list = only ? only.entries.map(function (e) { return e.row; }) : categoryEntries(t, key);
      var total = list.reduce(function (a, r) { return r.counts ? a + r.amount : a; }, 0);
      // (Even when everything sits in Other: that's how a charge gets out of it.)
      var canGroup = function (r) { return !!VENDOR_CATS[key] && canWrite() && canEditTour(id) && !!(r.chargeId || r.cashId); };
      var groupBtn = function (r) {
        return h('button', { class: 'sw-edit sw-group', type: 'button', 'aria-label': 'Move ' + r.label + ' to another group',
          onclick: function () { openVendorMove(id, key, r, function () { reopen(); }); } }, icon('tag', 16), 'Group');
      };
      var lead = S.mode === 'db' && bookLead(id) && serverLead(id);
      var slides = function (r) { return lead && r.source === 'PLAID' && /^p/.test(String(r.chargeId || '')); };
      // Logged by hand (a payment, a merch cash entry, a typed-in total): Edit or Delete.
      var mine = function (r) { return canWrite() && canEditTour(id) && (r.typed || r.cashId || (r.chargeId && r.source === 'MANUAL')); };
      var anySlide = list.some(function (r) { return slides(r) || mine(r); });
      var anyGroup = list.some(canGroup);
      var entryNode = function (r) {
          var line = logRow(r);
          var first = canGroup(r) ? [groupBtn(r)] : [];
          if (mine(r)) {
            return swipeRow(line, first.concat([
              h('button', { class: 'sw-edit', type: 'button', 'aria-label': 'Edit ' + r.label,
                onclick: function () { openManualEdit(id, key, r, back, o ? function () { reopen(); } : null); } }, icon('edit', 16), 'Edit'),
              h('button', { class: 'sw-undo', type: 'button', 'aria-label': 'Delete ' + r.label,
                onclick: function () { removeEntry(r); } }, icon('trash', 16), 'Delete')]));
          }
          if (!slides(r)) return first.length ? swipeRow(line, first) : line;
          var ch = (t.charges || {})[r.chargeId];
          ch = Object.assign({ id: r.chargeId }, ch || {});
          var busy = false;
          return swipeRow(line, first.concat([
            h('button', { class: 'sw-edit', type: 'button', 'aria-label': 'Edit ' + r.label,
              onclick: function () { if (busy) return; busy = true; editCharge(id, ch).then(function () { busy = false; }); } },
              icon('edit', 16), 'Edit'),
            h('button', { class: 'sw-undo', type: 'button', 'aria-label': 'Undo ' + r.label + ', back to new charges',
              onclick: async function () {
                if (busy) return; busy = true;
                var ok = await unfileCharge(id, r.chargeId);
                busy = false;
                if (!ok) return;
                toast(r.label + ' is back in new charges');
                render(true);
                setTimeout(function () { reopen(); }, 700);
              } }, icon('back', 16), 'Undo')]));
      };
      // A category that breaks down lists each group under its own heading
      // (tap one for just that group); one group alone is a plain list.
      var body = !list.length ? emptyState('Nothing logged yet', 'Charges from the card feed, statements you import and payments you log by hand all show up here.')
        : (groups && !only) ? h('div', { class: 'ledger logged' }, groups.map(function (g) {
            return [h('button', { class: 'row head lg-head', type: 'button', 'aria-label': g.label + ', ' + money(g.total) + '. Show only this group.',
                onclick: function () { reopen(g.key); } },
                h('span', { class: 'lg-name' }, g.label, icon('chevron', 12)), h('span', { class: 'amt num' }, money(g.total)))]
              .concat(g.entries.map(function (e) { return entryNode(e.row); }));
          }))
        : h('div', { class: 'ledger logged' }, list.map(entryNode));
      return [
        h('h2', { class: 'sh-title' }, only ? only.label : 'Logged Card Transactions'),
        h('p', { class: 'sh-sub' }, cat.label + ' \u00b7 ' + entryCount(list.length) + ' \u00b7 ' + money(total)),
        anySlide || anyGroup ? h('p', { class: 'note sw-hint' }, anyGroup
          ? 'Swipe one left to move it to another group' + (anySlide ? ', or to fix it.' : '.')
          : 'Logged one wrong? Swipe it left to fix it.') : null,
        body,
        h('div', { class: 'stack' },
          only && only.key && canWrite() && canEditTour(id) ? h('button', { class: 'btn quiet block', type: 'button',
            onclick: function () { openVendorRename(id, key, only, function (gk) { reopen(gk); }); } }, icon('edit', 18), 'Rename this group') : null,
          only ? h('button', { class: 'btn quiet block', type: 'button', onclick: function () { reopen(null); } },
            'All of ' + cat.label) : null,
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { if (back) back(); else closeSheet(); } },
            back ? 'Back' : 'Close'))
      ];
      function logRow(r) {
        return h('div', { class: 'row' },
          h('div', { class: 'row-label' }, r.label,
            h('span', { class: 'hint' }, [r.date ? dayMD(r.date) : '', r.detail].filter(Boolean).join(' \u00b7 '))),
          // How it was logged, and under it the card it came from.
          h('span', { class: 'src-col' },
            h('span', { class: 'src-tag src-' + r.source.toLowerCase() }, r.source),
            r.card ? h('span', { class: 'src-card' }, r.card) : null),
          h('span', { class: 'amt num' + (r.counts ? '' : ' quiet') }, money(r.amount)));
      }
      function removeEntry(r) {
        confirmSheet({
          title: 'Delete this?', body: money(r.amount) + ' comes off ' + cat.label + '.',
          action: 'Delete', danger: true,
          onConfirm: async function () {
            var patch;
            if (r.typed) { patch = { expenses: {} }; patch.expenses[key] = { paid: 0 }; }
            else if (r.cashId) { patch = { cashLog: {} }; patch.cashLog[r.cashId] = null; }
            else { patch = { charges: {} }; patch.charges[r.chargeId] = null; }
            var ok = await api.update(id, patch);
            if (ok) { toast('Deleted'); setTimeout(function () { reopen(); }, 250); }
            return ok;
          }
        });
      }
    }
    openSheet(build, { label: 'Logged Card Transactions', cls: 'cat-sheet' });
  }
  function loggedButton(id, key, back) {
    var n = categoryEntries(getTour(id), key).length;
    return h('button', { class: 'btn quiet block', type: 'button', style: 'margin-top:14px',
      onclick: function () { openLoggedSheet(id, key, back); } },
      icon('card', 18), 'Logged Card Transactions' + (n ? ' (' + n + ')' : ''));
  }
  // A payment logged by hand: an entry of its own, dated, marked MANUAL.
  // Each one adds to what's been spent.
  // Credit: put on a credit card, still owed until the card is paid off.
  // Debit: a debit card or a check, so the money is already gone.
  // Cash: gone too. It can come out of the merch cash log (then it's an
  // entry there, and that log's "left" goes down) or from anywhere else.
  function paidLogForm(id, key, label, after, how) {
    var cash = how === 'cash';
    var paid = how === 'paid' || cash;
    var kindWord = cash ? 'cash' : paid ? 'debit' : 'credit';
    var word = paid ? 'paid' : 'charged';
    var t0 = getTour(id);
    // The Off Tour book has no merch cash log to take it from.
    var asks = cash && !(t0 && t0.kind === 'offtour');
    var f = { amount: 0, date: G.tourToday(), what: '', merch: null };
    var yes = null, no = null;
    var submit = async function (e) {
      e.preventDefault();
      blurActive();
      if (!(f.amount > 0)) { toast('Enter how much was ' + word); return; }
      if (!G.parseDay(f.date)) { toast('Pick the day it was ' + word); return; }
      if (asks && f.merch == null) { toast('Deduct from the Merch Cash Log? Tick Yes or No'); return; }
      var patch;
      if (asks && f.merch) {
        patch = { cashLog: {} };
        patch.cashLog[newId()] = { date: f.date, amount: f.amount, label: f.what.trim() || label, category: key, createdAt: Date.now() };
      } else {
        patch = { charges: {} };
        patch.charges[newId()] = { date: f.date, merchant: f.what.trim() || label, amount: f.amount, category: key,
          accounted: false, manual: true, paid: paid, cash: cash || undefined, createdAt: Date.now() };
      }
      if (await api.update(id, patch)) {
        delete S.drafts['exp:' + id];
        toast(money(f.amount) + ' logged as ' + kindWord + (asks && f.merch ? ' \u00b7 taken from the merch cash log' : ''));
        render(true);
        if (after) after(); else closeSheet();
      }
    };
    var pick = function (v) {
      f.merch = v;
      yes.checked = v === true; no.checked = v === false;
    };
    if (asks) {
      yes = h('input', { type: 'checkbox', class: 'rv-check', onchange: function (e) { pick(e.target.checked ? true : null); } });
      no = h('input', { type: 'checkbox', class: 'rv-check', onchange: function (e) { pick(e.target.checked ? false : null); } });
    }
    return h('form', { class: 'sh-form', onsubmit: submit, novalidate: true },
      h('p', { class: 'note' }, cash ? 'Cash: paid in cash. The money\u2019s already gone.'
        : paid ? 'Debit: a debit card or a check. The money\u2019s already gone.'
        : 'Credit: put on a credit card. It counts now and stays owed until the card is paid off.'),
      field('How much was ' + word, moneyInput({ id: 'log-paid', value: 0, label: label + ' ' + word, nextId: 'log-what',
        onValue: function (v) { f.amount = v; } })),
      field('Expense details', h('input', { class: 'input', type: 'text', id: 'log-what', maxlength: 60, autocomplete: 'off',
        placeholder: 'Optional, e.g. per diems', oninput: function (e) { f.what = e.target.value; } })),
      field('Day it was ' + word, h('input', { class: 'input', type: 'date', value: f.date, 'aria-label': 'Day it was ' + word,
        onchange: function (e) { f.date = e.target.value; } })),
      asks ? h('fieldset', { class: 'yn-ask' },
        h('legend', null, 'Deduct from Merch Cash Log?'),
        h('label', { class: 'yn-opt' }, yes, h('span', null, 'Yes')),
        h('label', { class: 'yn-opt' }, no, h('span', null, 'No'))) : null,
      h('div', { class: 'stack' },
        h('button', { class: 'btn primary block', type: 'submit' }, 'Log it as ' + kindWord)));
  }

  function openCategorySheet(id, key) {
    var t = getTour(id);
    var cat = G.typedCategoriesFor(t).filter(function (c) { return c.key === key; })[0];
    var rec = G.normExpenses(t && t.expenses)[key] || { projected: null, paid: 0 };
    var line = G.calc(t).lines.filter(function (l) { return l.key === key; })[0] || { paid: 0 };
    var f = { projected: rec.projected };
    var kind = null;
    // Add to total, or New total: always both, even at $0.
    var pmode = 'add';

    openSheet(function () {
      var readout = h('div', { class: 'preview' });
      var paid = G.num(line.paid);
      var settled = paidPart(t, key);
      var p = rec.projected;
      fillEl(readout, [
        h('div', null, h('span', null, 'Projected'), h('strong', { class: 'num' }, p == null ? 'Not set' : money(p))),
        h('div', null, h('span', null, 'Spent so far'), h('strong', { class: 'num' }, money(paid))),
        paid > 0 ? h('div', null, h('span', null, '\u21b3 Credit'), h('strong', { class: 'num' }, money(paid - settled))) : null,
        paid > 0 ? h('div', null, h('span', null, '\u21b3 Debit'), h('strong', { class: 'num' }, money(debitPart(t, key)))) : null,
        cashPart(t, key) > 0 ? h('div', null, h('span', null, '\u21b3 Cash'), h('strong', { class: 'num' }, money(cashPart(t, key)))) : null,
        p == null ? h('div', null, h('span', null, 'Counts as'), h('strong', { class: 'num' }, money(paid)))
          : paid > p ? h('div', null, h('span', null, 'Over by'), h('strong', { class: 'num neg' }, money(paid - p)))
          : h('div', null, h('span', null, 'Left to pay'), h('strong', { class: 'num' }, money(p - paid)))]);

      var box = h('div');
      function draw() {
        if (kind === 'projected') {
          // A projection grows as the tour goes (the merch bill, say): add to
          // it, or change the whole total. Every change is kept, so it's
          // always clear how the number got where it is.
          var had = rec.projected != null ? G.num(rec.projected) : 0;
          // New total opens with the total as it is, ready to be changed.
          var amt = pmode === 'set' && had > 0 ? had : null;
          var preview = h('p', { class: 'note proj-preview' });
          var showPreview = function () {
            if (pmode === 'add') preview.textContent = amt > 0 ? money(had) + ' + ' + money(amt) + ' = ' + money(had + amt)
              : 'Now ' + money(had) + '. Type how much to add.';
            else preview.textContent = 'Now ' + money(had) + '. What you type replaces it.';
          };
          var input = moneyInput({
            id: 'cat-proj', value: amt, label: cat.label + (pmode === 'add' ? ' amount to add' : ' new total'),
            placeholder: '\u2014', last: true, onValue: function (v) { amt = v > 0 ? v : null; showPreview(); }
          });
          // Tapping into the filled-in total selects it, so typing replaces it.
          var typed = input.querySelector('input');
          if (typed && amt) typed.addEventListener('focus', function () {
            setTimeout(function () { try { typed.setSelectionRange(0, typed.value.length); } catch (e) { /* not selectable */ } }, 0);
          });
          showPreview();
          var history = G.rows(G.isObj(t.projLog) ? t.projLog[key] : null).sort(function (a, b) { return G.num(b.at) - G.num(a.at); });
          fillEl(box, [
            segmented(['Add to total', 'New total'], pmode === 'add' ? 0 : 1, function (i) {
              pmode = i ? 'set' : 'add'; draw();
            }, 'Add to the total or type a new total'),
            h('form', { class: 'sh-form', novalidate: true, onsubmit: async function (e) {
              e.preventDefault();
              blurActive();
              if (pmode === 'add' && !(amt > 0)) { toast('Type how much to add'); return; }
              // The total as it stands right now (someone may have changed it since this sheet opened).
              var nowRec = G.normExpenses((getTour(id) || t || {}).expenses)[key];
              var hadNow = nowRec && nowRec.projected != null ? G.num(nowRec.projected) : 0;
              // New total left as it was filled in: nothing to save.
              if (pmode === 'set' && had > 0 && amt === had) { closeSheet(); return; }
              var next = pmode === 'add' ? Math.round((hadNow + amt) * 100) / 100 : (amt > 0 ? amt : null);
              var patch = { expenses: {}, projLog: {} };
              patch.expenses[key] = { projected: next };
              patch.projLog[key] = {};
              patch.projLog[key][newId()] = { at: Date.now(), by: myName() || '', add: pmode === 'add' ? amt : null, total: next };
              if (await api.update(id, patch)) {
                delete S.drafts['exp:' + id];
                closeSheet();
                toast(pmode === 'add' ? '+' + money(amt) + ' \u00b7 ' + cat.label + ' now projected at ' + money(next)
                  : cat.label + ' projection ' + (next ? 'set to ' + money(next) : 'cleared'));
                render(true);
              }
            } },
              field(pmode === 'add' ? 'Amount to add' : 'New total', input,
                'What you expect it to cost. What\u2019s spent fills it up; it doesn\u2019t add on top.'),
              preview,
              h('div', { class: 'stack' }, h('button', { class: 'btn primary block', type: 'submit' },
                pmode === 'add' ? 'Add to total' : 'Save new total'))),
            history.length ? h('div', { class: 'proj-log' },
              h('h3', { class: 'wn-h' }, 'How the projection got here'),
              h('div', { class: 'ledger' }, history.slice(0, 8).map(function (x) {
                var when = x.at ? dayMD(G.ymd(new Date(x.at))) : '';
                return h('div', { class: 'row' },
                  h('span', { class: 'row-label' }, x.add ? '+' + money(G.num(x.add)) : (x.total ? 'Set to ' + money(G.num(x.total)) : 'Cleared'),
                    h('span', { class: 'hint' }, [when, x.by].filter(Boolean).join(' \u00b7 '))),
                  h('span', { class: 'amt num' }, x.total ? money(G.num(x.total)) : '\u2014'));
              }))) : null]);
        } else if (kind === 'spent' || kind === 'paid' || kind === 'cash') {
          box.replaceChildren(paidLogForm(id, key, cat.label, null, kind));
        } else box.replaceChildren();
      }
      draw();
      return [
        h('h2', { class: 'sh-title' }, cat.label),
        cat.note ? h('p', { class: 'sh-sub' }, cat.note) : null,
        readout,
        canWrite() ? [
          segmented(['Projection', 'Credit', 'Debit', 'Cash'], -1, function (i) {
            kind = ['projected', 'spent', 'paid', 'cash'][i]; draw();
            // The form it opens comes into view, not left below the fold.
            requestAnimationFrame(function () { try { box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* older phones */ } });
          }, 'Projection, credit, debit or cash'),
          box
        ] : null,
        loggedButton(id, key, function () { openCategorySheet(id, key); })
      ];
    }, { label: cat.label, cls: 'cat-sheet' });
  }

  function openCommissionSheet(id) {
    var t = getTour(id);
    var base = G.calc(t);
    var d = { commission: G.normCommission(t && t.commission) };
    openSheet(function () {
      var readout = h('div', { class: 'preview' });
      function refresh() {
        var agentNow = 0;
        var kids = G.commissionLines(d.commission).map(function (line) {
          // Commission is figured on the shows' money; income catalogued on
          // the book itself (royalties, advances) stays out of it.
          var v = G.commissionLine(line, d.commission[line.key], base.showIncome, base.guarantees, base.incomeBy);
          if (line.key === 'agent') agentNow = v;
          return h('div', null, h('span', null, line.label), h('strong', { class: 'num' }, money(v)));
        });
        kids.push(h('div', null, h('span', null, 'Commission so far'),
          h('strong', { class: 'num' }, money(G.commissionTotal(d.commission, base.showIncome, base.guarantees, base.incomeBy)))));
        // The booking agent's cut on guarantees that came by agency deposit is already paid.
        // Guarantees that came by agency deposit: the booking agent holds all
        // of each one as an advance on their commission for the whole tour.
        if (G.num(base.commissionKept) > 0) {
          kids.push(h('div', null, h('span', null, '\u21b3 Taken out of guarantees before deposit (already paid)'),
            h('strong', { class: 'num' }, money(base.commissionKept))));
        }
        var agencyList = G.agencyAdvance(base.shows);
        var held = agencyList.reduce(function (n, x) { return n + x.amount; }, 0);
        if (held > 0) {
          kids.push(h('div', null, h('span', null, '\u21b3 Held by the booking agent (advance)'),
            h('strong', { class: 'num' }, money(held))));
          agencyList.forEach(function (x) {
            kids.push(h('div', { class: 'pv-sub' },
              h('span', null, String(x.city).split(',')[0] + (x.date ? ' \u00b7 ' + dayMD(x.date) : '')),
              h('span', { class: 'num' }, money(x.amount))));
          });
          // What the agent took off the top of other guarantees is theirs already too.
          var keptAgent = base.shows.reduce(function (n, x) { return n + G.guaranteeKept(x, 'agent'); }, 0);
          var agentHas = held + keptAgent;
          kids.push(agentHas >= agentNow
            ? h('div', null, h('span', null, keptAgent > 0 ? 'Booking agent is ahead by' : 'Advance not earned yet'),
                h('strong', { class: 'num' }, money(agentHas - agentNow)))
            : h('div', null, h('span', null, 'Still owed to the booking agent'), h('strong', { class: 'num' }, money(agentNow - agentHas))));
        }
        readout.replaceChildren.apply(readout, kids);
      }
      var ledger = h('div', { class: 'ledger' });
      function buildRows() {
        var kids = [];
        G.commissionLines(d.commission).forEach(function (line) {
          kids = kids.concat(commissionRow(d, line, refresh, line.custom ? function () {
            // Stored as null so the save clears them from the tour.
            d.commission[line.key] = null;
            buildRows(); refresh();
          } : null));
        });
        ledger.replaceChildren.apply(ledger, kids);
      }
      // Anyone else who takes a cut: a name, then the same $ or % deal.
      var adder = h('div', { class: 'comm-add' });
      function showAddButton() {
        adder.replaceChildren(h('button', { class: 'btn quiet block', type: 'button',
          onclick: showAddForm }, icon('plus', 18), 'Add Team'));
      }
      function showAddForm() {
        var name = h('input', { class: 'input', type: 'text', maxlength: 40, autocomplete: 'off',
          placeholder: 'Who? e.g. Business manager', 'aria-label': 'Team member',
          onkeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } } });
        function add() {
          var label = name.value.trim();
          if (!label) { name.focus(); return; }
          var key = 'x-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          var all = {};
          G.INCOME_FIELDS.forEach(function (f) { all[f.key] = true; });
          d.commission[key] = { label: label, mode: 'flat', value: 0, base: all, at: Date.now() };
          buildRows(); refresh(); showAddButton();
        }
        adder.replaceChildren(h('div', { class: 'af-row' }, name,
          h('button', { class: 'btn primary', type: 'button', onclick: add }, 'Add')));
        name.focus();
      }
      var submit = async function (e) {
        e.preventDefault();
        blurActive();
        if (await api.update(id, { commission: d.commission })) {
          delete S.drafts['exp:' + id];
          closeSheet(); toast('Commission saved'); render(true);
        }
      };
      buildRows(); showAddButton(); refresh();
      return [
        h('h2', { class: 'sh-title' }, 'Commission'),
        h('form', { class: 'sh-form', onsubmit: submit, novalidate: true },
          ledger,
          adder,
          readout,
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Save commission'),
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel')))
      ];
    }, { label: 'Commission', cls: 'cat-sheet' });
  }

  /* ============================== Crew ============================== */

  // What's been logged as paid to one crew member (their Pay button).
  function crewPayments(t, p) {
    var out = [];
    G.rows(t && t.charges).forEach(function (ch) {
      if (ch.crewId === p.id && !ch.accounted) out.push({ chargeId: ch.id, date: ch.date || '', amount: G.num(ch.amount),
        how: ch.cash ? 'Cash' : ch.paid ? 'Debit' : 'Credit', label: ch.merchant || 'Pay', source: 'MANUAL', counts: true });
    });
    G.rows(t && t.cashLog).forEach(function (x) {
      if (x.crewId === p.id) out.push({ cashId: x.id, date: x.date || '', amount: G.num(x.amount),
        how: 'Cash \u00b7 merch cash', label: x.label || 'Pay', source: 'MANUAL', counts: true });
    });
    return out.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  }
  function crewPaidTo(t, p) {
    return Math.round(crewPayments(t, p).reduce(function (a, x) { return a + x.amount; }, 0) * 100) / 100;
  }
  var crewKind = {};
  function openCrewSheet(id, fresh) {
    if (fresh) crewKind[id] = null;
    function build() {
      var t = getTour(id);
      var crew = G.rows(t && t.crew).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      var total = G.crewProjection(t);
      var exp = G.normExpenses(t && t.expenses);
      var paid = G.num(exp.crew.paid);
      var paidCrew = linePaid(G.calc(t), 'crew');

      var list = crew.length
        ? h('div', { class: 'ledger cw-list' },
            crew.map(function (p) {
              var got = crewPaidTo(t, p), pay = G.crewPay(t, p);
              var sub = [p.title || 'No title', got > 0 ? money(got) + ' of ' + money(pay) + ' paid' : ''].filter(Boolean).join(' \u00b7 ');
              return h('div', { class: 'row cw-row' },
                h('div', { class: 'row-label' }, p.name || 'Crew',
                  h('span', { class: 'hint' + (got >= pay && got > 0 ? ' done' : '') }, sub)),
                canWrite() ? h('button', { class: 'btn sm quiet cw-edit', type: 'button', 'aria-label': 'Edit ' + (p.name || 'crew'),
                  onclick: function () { openCrewPayEdit(id, p.id); } }, 'Edit') : null,
                h('span', { class: 'amt num' }, pay > 0 ? money(pay) : '\u2014'));
            }),
            h('div', { class: 'row total' },
              h('span', null, 'Crew projection'), h('strong', { class: 'amt num' }, money(total))))
        : emptyState('No crew yet', canWrite()
            ? 'Add everyone out with you. What each one is paid adds up to your crew projection.'
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
      // People already on the tour (invited before this) who aren't listed yet.
      var onTour = ((S.crewCache && S.crewCache[id] && S.crewCache[id].rows) || []).filter(function (m) {
        var nm = m.name || m.username || '';
        return nm && !NOT_CREW.test(String(m.tourRole || '')) && !crewListed(t, nm, m.invitedEmail || m.email);
      });
      var addOnTour = onTour.length && canEditTour(id) ? h('button', { class: 'btn quiet block', type: 'button', style: 'margin-top:12px',
        onclick: async function () {
          for (var i = 0; i < onTour.length; i++) {
            var m = onTour[i];
            await addToCrewExpenses(id, m.name || m.username, m.tourRole, m.invitedEmail || m.email);
          }
          toast(plural(onTour.length, 'person') .replace('persons', 'people') + ' added to Crew \u2014 fill in their pay');
          setTimeout(function () { openCrewSheet(id); }, 250);
        } }, icon('plus', 18), 'Add ' + onTour.map(function (m) { return (m.name || m.username).split(' ')[0]; }).join(', ') + ' from the tour') : null;
      return [
        h('h2', { class: 'sh-title' }, 'Crew'),
        h('p', { class: 'sh-sub' }, paidCrew > 0 ? 'Paid so far: ' + money(paidCrew) + ' of ' + money(total) + '.'
          : 'Everyone on the tour and what they\u2019re paid. Tap Edit to set someone\u2019s pay and log payments.'),
        list,
        addOnTour,
        canWrite() ? h('button', { class: 'btn quiet block', type: 'button', style: 'margin-top:12px',
          onclick: function () { openCrewPerson(id, null); } }, icon('plus', 18), 'Add someone') : null,
        benchRow ? h('div', { style: 'margin-top:16px' }, benchRow) : null,
        loggedButton(id, 'crew', function () { openCrewSheet(id); })
      ];
    }
    openSheet(build, { label: 'Crew', cls: 'cat-sheet' });
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
      title: person ? person.title || '' : ''
    };
    var backTo = function () { if (person) openCrewPayEdit(id, person.id); else openCrewSheet(id); };
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
        var row = { name: name, title: f.title.trim() };
        if (!person) row.pay = 0;
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
            toast(person ? 'Saved' : 'Added ' + name);
            backTo();
          }
        }
      };
      return [
        h('h2', { class: 'sh-title' }, person ? 'Name & role' : 'Add someone'),
        h('form', { class: 'sh-form', onsubmit: submit, novalidate: true },
          field('Name', nameInput),
          field('Title', titleInput),
          chips,
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, person ? 'Save' : 'Add to crew'),
            h('button', { class: 'btn ghost block', type: 'button', onclick: backTo }, 'Back'),
            person ? h('button', {
              class: 'btn danger block', type: 'button',
              onclick: function () {
                confirmSheet({
                  title: 'Remove ' + (person.name || 'this person') + '?',
                  body: money(G.crewPay(getTour(id), person)) + ' comes off the crew projection.',
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
    }, { label: person ? 'Name & role' : 'Add someone', cls: 'cat-sheet' });
  }

  var PAY_PER = [['week', 'Weekly', 'week', 'weeks'], ['day', 'Daily', 'day', 'days'], ['month', 'Monthly', 'month', 'months'], ['other', 'Other', '', '']];
  function payPlanText(t, p) {
    var row = PAY_PER.filter(function (x) { return x[0] === p.per; })[0];
    var n = G.payPeriods(t, p.per), rate = G.num(p.rate);
    if (!row || p.per === 'other' || !(rate > 0)) return '';
    if (!n) return money(rate) + ' a ' + row[2] + '. Add the tour\u2019s dates and the total works itself out.';
    return money(rate) + ' a ' + row[2] + ' \u00d7 ' + n + ' ' + (n === 1 ? row[2] : row[3]) + ' = ' + money(rate * n);
  }
  // What they've been paid against their total, the same three lines everywhere.
  function crewReadout(t, p) {
    var pay = G.crewPay(t, p), got = crewPaidTo(t, p);
    return h('div', { class: 'preview' },
      h('div', null, h('span', null, 'Total projection'), h('strong', { class: 'num' }, pay > 0 ? money(pay) : 'Not set')),
      h('div', null, h('span', null, 'Paid so far'), h('strong', { class: 'num' }, money(got))),
      got > pay && pay > 0 ? h('div', null, h('span', null, 'Over by'), h('strong', { class: 'num neg' }, money(got - pay)))
        : h('div', null, h('span', null, 'Left to pay'), h('strong', { class: 'num' }, money(Math.max(0, pay - got)))));
  }

  /* Edit one person: their total projection, and Payments. */
  function openCrewPayEdit(id, pid) {
    openSheet(function () {
      var t = getTour(id);
      var p = G.rows(t && t.crew).filter(function (x) { return x.id === pid; })[0];
      if (!p) return [h('h2', { class: 'sh-title' }, 'Crew'), emptyState('Not on the crew anymore', null)];
      var worked = G.crewPay(t, Object.assign({}, p, { payTyped: false }));
      var plan = payPlanText(t, p);
      var planned = !!plan && G.payPeriods(t, p.per) > 0;
      var f = { pay: G.crewPay(t, p) };
      var save = async function (e) {
        e.preventDefault(); blurActive();
        var patch = {};
        // A total typed over the worked-out one is kept as typed.
        patch[pid] = { pay: f.pay, payTyped: planned ? Math.abs(f.pay - worked) > 0.004 : false };
        if (await api.update(id, { crew: patch })) {
          delete S.drafts['exp:' + id];
          toast('Total saved'); render(true); openCrewPayEdit(id, pid);
        }
      };
      return [
        h('h2', { class: 'sh-title' }, p.name || 'Crew'),
        h('p', { class: 'sh-sub' }, p.title || 'No title'),
        crewReadout(t, p),
        h('form', { class: 'sh-form', novalidate: true, onsubmit: save },
          field('Total projection', moneyInput({ id: 'cw-total', value: f.pay, label: 'Total projection for the tour', last: true,
            onValue: function (v) { f.pay = v; } }),
            planned ? (p.payTyped ? 'You typed this over the worked-out total (' + plan + ').' : 'Worked out: ' + plan + '. Type over it if you agreed something different.')
              : 'What they\u2019re paid for the whole tour. Set a weekly, daily or monthly rate under Payments and it works itself out.'),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Save total'),
            planned && p.payTyped ? h('button', { class: 'btn ghost block', type: 'button', onclick: async function () {
              var patch = {}; patch[pid] = { payTyped: false };
              if (await api.update(id, { crew: patch })) { toast('Back to the worked-out total'); render(true); openCrewPayEdit(id, pid); }
            } }, 'Use the worked-out total (' + money(worked) + ')') : null)),
        h('div', { class: 'stack cw-more' },
          h('button', { class: 'btn quiet block', type: 'button', onclick: function () { openCrewPayments(id, pid); } },
            icon('cash', 18), 'Payments'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openCrewPerson(id, p); } }, 'Name & role'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openCrewSheet(id); } }, 'Back to crew'))
      ];
    }, { label: 'Edit crew', cls: 'cat-sheet' });
  }

  /* Payments: how they're paid (weekly, daily, monthly, or some other way:
     installments, a flat fee) and their rate, then each payment, logged by
     hand as it's made. */
  function openCrewPayments(id, pid, keep) {
    var st = keep || { per: null, rate: null, how: 'paid', amount: null, date: G.tourToday(), merch: null };
    openSheet(function () {
      var t = getTour(id);
      var p = G.rows(t && t.crew).filter(function (x) { return x.id === pid; })[0];
      if (!p) return [h('h2', { class: 'sh-title' }, 'Payments'), emptyState('Not on the crew anymore', null)];
      if (st.per == null) st.per = p.per || 'week';
      if (st.rate == null) st.rate = G.num(p.rate);
      var again = function () { openCrewPayments(id, pid, st); };
      var perRow = PAY_PER.filter(function (x) { return x[0] === st.per; })[0];
      var planLine = h('p', { class: 'note proj-preview' });
      var saveBtn = h('button', { class: 'btn primary block', type: 'button' }, 'Save pay plan');
      // The button shows once there's something to save.
      var showPlan = function () {
        planLine.textContent = st.per === 'other'
          ? 'Installments, a flat fee, anything else: log each payment as you make it. Their total is set under Edit.'
          : (payPlanText(t, { per: st.per, rate: st.rate }) || 'Type the rate and the total works itself out.');
        var changed = st.per !== p.per || (st.per !== 'other' && Math.abs(G.num(st.rate) - G.num(p.rate)) > 0.004);
        saveBtn.hidden = !changed || (st.per !== 'other' && !(st.rate > 0));
      };
      showPlan();
      var savePlan = async function () {
        blurActive();
        if (st.per !== 'other' && !(st.rate > 0)) { toast('Type the ' + perRow[1].toLowerCase() + ' rate'); return; }
        var patch = {};
        patch[pid] = { per: st.per, rate: st.per === 'other' ? 0 : st.rate, payTyped: false };
        // Paid some other way: the total they had stays as the typed total.
        if (st.per === 'other') patch[pid].pay = G.crewPay(t, p);
        if (await api.update(id, { crew: patch })) {
          delete S.drafts['exp:' + id];
          st.amount = null;
          toast('Pay plan saved'); render(true); again();
        }
      };

      // The payment being logged: one period's pay to start, or what's left.
      var left = Math.max(0, G.crewPay(t, p) - crewPaidTo(t, p));
      if (st.amount == null) st.amount = G.num(p.rate) > 0 && p.per !== 'other' ? G.num(p.rate) : left;
      saveBtn.onclick = savePlan;
      var pick = function (v) { st.merch = v; yes.checked = v === true; no.checked = v === false; };
      var yes = h('input', { type: 'checkbox', class: 'rv-check', checked: st.merch === true, onchange: function (e) { pick(e.target.checked ? true : null); } });
      var no = h('input', { type: 'checkbox', class: 'rv-check', checked: st.merch === false, onchange: function (e) { pick(e.target.checked ? false : null); } });
      // Cash asks where it came from; the question shows only for cash.
      var cashAsk = h('fieldset', { class: 'yn-ask', hidden: st.how !== 'cash' },
        h('legend', null, 'Deduct from Merch Cash Log?'),
        h('label', { class: 'yn-opt' }, yes, h('span', null, 'Yes')),
        h('label', { class: 'yn-opt' }, no, h('span', null, 'No')));
      var logIt = async function (e) {
        e.preventDefault(); blurActive();
        if (!(st.amount > 0)) { toast('Enter how much you paid'); return; }
        if (!G.parseDay(st.date)) { toast('Pick the day it was paid'); return; }
        if (st.how === 'cash' && st.merch == null) { toast('Deduct from the Merch Cash Log? Tick Yes or No'); return; }
        var label = (p.name || 'Crew') + ' \u2014 pay', patch;
        if (st.how === 'cash' && st.merch) {
          patch = { cashLog: {} };
          patch.cashLog[newId()] = { date: st.date, amount: st.amount, label: label, category: 'crew', crewId: pid, createdAt: Date.now() };
        } else {
          patch = { charges: {} };
          patch.charges[newId()] = { date: st.date, merchant: label, amount: st.amount, category: 'crew', accounted: false,
            manual: true, paid: st.how !== 'spent', cash: st.how === 'cash', crewId: pid, createdAt: Date.now() };
        }
        if (await api.update(id, patch)) {
          delete S.drafts['exp:' + id];
          toast(money(st.amount) + ' paid to ' + (p.name || 'crew'));
          st.amount = null; st.merch = null;
          render(true); again();
        }
      };
      var paid = crewPayments(t, p);
      return [
        h('h2', { class: 'sh-title' }, 'Payments'),
        h('p', { class: 'sh-sub' }, (p.name || 'Crew') + (p.title ? ' \u00b7 ' + p.title : '')),
        crewReadout(t, p),

        h('h3', { class: 'sh-h3' }, 'How are they paid?'),
        segmented(PAY_PER.map(function (x) { return x[1]; }), PAY_PER.map(function (x) { return x[0]; }).indexOf(st.per), function (i) {
          st.per = PAY_PER[i][0]; again();
        }, 'Weekly, daily, monthly or other'),
        st.per !== 'other' ? h('div', { class: 'sh-form', style: 'margin-top:10px' },
          field(perRow[1] + ' rate', moneyInput({ id: 'cw-rate', value: st.rate, label: perRow[1] + ' rate', last: true,
            onValue: function (v) { st.rate = v; showPlan(); } }))) : null,
        planLine,
        saveBtn,

        h('h3', { class: 'sh-h3 cw-h' }, 'Log a payment'),
        h('form', { class: 'sh-form', novalidate: true, onsubmit: logIt },
          segmented(['Credit', 'Debit', 'Cash'], ['spent', 'paid', 'cash'].indexOf(st.how), function (i) {
            st.how = ['spent', 'paid', 'cash'][i]; cashAsk.hidden = st.how !== 'cash';
          }, 'Credit, debit or cash'),
          field('How much', moneyInput({ id: 'cw-amt', value: st.amount, label: 'Amount paid', last: true,
            onValue: function (v) { st.amount = v; } })),
          field('Day paid', h('input', { class: 'input', type: 'date', value: st.date, 'aria-label': 'Day paid',
            onchange: function (e) { st.date = e.target.value; } })),
          cashAsk,
          h('div', { class: 'stack' }, h('button', { class: 'btn primary block', type: 'submit' }, 'Log payment'))),

        h('h3', { class: 'sh-h3 cw-h' }, 'Payments so far'),
        paid.length ? h('div', { class: 'ledger logged' }, paid.map(function (r) {
          var line = h('div', { class: 'row' },
            h('div', { class: 'row-label' }, r.date ? dayLong(r.date) : 'No date', h('span', { class: 'hint' }, r.how)),
            h('span', { class: 'amt num' }, money(r.amount)));
          return swipeRow(line, [
            h('button', { class: 'sw-edit', type: 'button', onclick: function () { openManualEdit(id, 'crew', r, null, again); } },
              icon('edit', 16), 'Edit'),
            h('button', { class: 'sw-undo', type: 'button', onclick: function () {
              confirmSheet({ title: 'Delete this payment?', body: money(r.amount) + ' goes back to what\u2019s left to pay.',
                action: 'Delete', danger: true,
                onConfirm: async function () {
                  var patch = r.cashId ? { cashLog: {} } : { charges: {} };
                  (patch.cashLog || patch.charges)[r.cashId || r.chargeId] = null;
                  var ok = await api.update(id, patch);
                  if (ok) { toast('Deleted'); setTimeout(again, 250); }
                  return ok;
                } });
            } }, icon('trash', 16), 'Delete')]);
        })) : h('p', { class: 'note' }, 'No payments logged yet.'),
        paid.length ? h('p', { class: 'note sw-hint', style: 'margin-top:8px' }, 'Swipe a payment left to edit or delete it.') : null,

        h('div', { class: 'stack', style: 'margin-top:16px' },
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openCrewPayEdit(id, pid); } }, 'Back'))
      ];
    }, { label: 'Payments', cls: 'cat-sheet' });
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
    var s = G.cardSummary(card, getTour(tourId));
    var bd = G.isObj(card.breakdown) ? card.breakdown : {};
    var used = Object.keys(bd).filter(function (k) { return G.num(bd[k]) > 0; });
    if (s.feed) {
      // Read by the card feed: the balance, what's moved into categories, and
      // what's been paid off since.
      return h('div', { class: 'ledger', style: 'margin-bottom:14px' },
        h('div', { class: 'row' },
          h('div', { class: 'row-label' }, s.label,
            h('span', { class: 'hint' }, 'Balance read ' + dayMD(card.cutoff))),
          h('span', { class: 'amt num' }, money(s.balance))),
        h('div', { class: 'row bd-row' },
          h('span', { class: 'row-label' }, h('span', { class: 'hint' },
            money(s.accounted) + ' filed into categories \u00b7 ' + money(s.remainder) + ' still under Credit card')),
          h('span', null)),
        h('div', { class: 'row bd-row' },
          h('span', { class: 'row-label' }, h('span', { class: 'hint' + (s.owed > 0 ? '' : ' done') },
            s.owed > 0 ? money(s.paidOff) + ' paid off \u00b7 ' + money(s.owed) + ' still owed' : 'Paid off')),
          h('span', null)));
    }

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

  /* A tour page's green band, as slim as the GR mark: the mark, ⋯ and the
     three lines. The page's name sits under it, on the black. */
  // center: what rides the middle of the band in place of the GR mark (Chat's wordmark).
  function tourBand(t, id, view, center) {
    return h('div', { class: 'headband slim' }, tourTopbar(t, id, view, center));
  }
  // Budget's three tabs, above the chart: Expenses, Cards in the middle, Income.
  function bookStrip(id, current) {
    return h('div', { class: 'vp-tabs pt-tabs bk-tabs three', role: 'tablist' }, BOOK_STRIP.map(function (t) {
      var v = t.view, on = v === current;
      return h('button', { class: 'vp-tab pt-tab' + (on ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false',
        onclick: function () { if (!on || S.route.view !== v) go({ name: 'tour', id: id, view: v }); } },
        icon(t.icon, 20), h('span', null, t.label));
    }));
  }
  function tourTopbar(t, id, view, center) {
    // No back button: your photo at the bottom takes you home, the three lines open the menu.
    return h('header', { class: 'topbar' }, h('span', { class: 'top-side' }),
      center || h('span', { class: 'logo-mark bar', 'aria-hidden': 'true' }),
      h('div', { class: 'topbar-actions' },
        canEditTour(id) ? h('button', {
          class: 'iconbtn', type: 'button', 'aria-label': 'Tour options',
          onclick: function () { openTourMenu(id); }
        }, icon('more')) : null,
        menuBtn()));
  }


  /* ============================== My Pay ==============================
     Devin (2026-10-07): the Budget tab is for everyone on the tour. Up top,
     the tour's name and MY PAY sit side by side, two equal tabs. The tour's
     own book is ALL ACCESS only; MY PAY is each person's own: their pay for
     the tour, what's been paid to them, and the spending they keep for
     themselves, laid out like Expenses. The server hands each person only
     their own crew row, so GA never sees anyone else's line. */
  function payTabs(id, t, current) {
    var tabs = [{ view: 'costs', label: t.name || 'Untitled tour' }, { view: 'mypay', label: 'MY PAY' }];
    return h('div', { class: 'vp-tabs pt-tabs pay-tabs', role: 'tablist' }, tabs.map(function (x) {
      var on = x.view === current;
      return h('button', { class: 'vp-tab pt-tab' + (on ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false',
        onclick: function () { if (!on || S.route.view !== x.view) go({ name: 'tour', id: id, view: x.view }); } },
        h('span', { class: 'pay-tab-t' }, x.label));
    }));
  }
  function payLocked() {
    return h('div', { class: 'pay-locked' },
      h('p', { class: 'pay-locked-t' }, 'ALL ACCESS MEMBERS ONLY'),
      h('p', { class: 'note' }, 'The tour\u2019s budget is for the tour manager and ALL ACCESS. Your own pay and spending are under MY PAY.'));
  }
  // Your slice (from the server) and your own book, asked for together and kept a minute.
  function myPayInfo(id, fresh) {
    var B = window.GR_BACKEND;
    S.myPay = S.myPay || {};
    var c = S.myPay[id] || (S.myPay[id] = { info: null, book: null, at: 0, asking: false, failed: false, none: false });
    if (S.mode !== 'db' || !B || !B.myPay) { c.none = true; return c; }
    if (!c.asking && (fresh || !c.at || Date.now() - c.at > 60000)) {
      c.asking = true;
      Promise.all([B.myPay(id), B.myPayBook(id)]).then(function (got) {
        c.info = G.isObj(got[0]) ? got[0] : { crew: null, payments: [], tour: {} };
        c.book = G.isObj(got[1]) ? got[1] : {};
        c.failed = false; c.at = Date.now(); c.asking = false; render(true);
      }, function () { c.failed = true; c.at = Date.now(); c.asking = false; render(true); });
    }
    return c;
  }
  // Saves go one at a time, each one built from the book as it stands when
  // its turn comes, so two quick taps can't overwrite each other.
  function saveMyPayBook(id, change) {
    var B = window.GR_BACKEND;
    S.myPay = S.myPay || {};
    var c = S.myPay[id] || (S.myPay[id] = { info: null, book: {}, at: Date.now(), asking: false, failed: false, none: false });
    var step = function () {
      var next = JSON.parse(JSON.stringify(G.isObj(c.book) ? c.book : {}));
      next = change(next) || next;
      return B.saveMyPayBook(id, next).then(function () { c.book = next; render(true); return true; },
        function (e) { saveFailed('pay', e); return false; });
    };
    c.saving = (c.saving || Promise.resolve()).then(step, step);
    return c.saving;
  }
  function viewMyPay(id, t) {
    return h('div', { class: 'page tour has-tabs exp-page pay-page' },
      tourBand(t, id, 'mypay'),
      payTabs(id, t, 'mypay'),
      dbBanner(),
      myPayBody(id, t),
      tourTabs(id, 'mypay'));
  }
  function myPayBody(id, t) {
    var c = myPayInfo(id);
    if (c.none) return emptyState('MY PAY is for a signed-in tour', 'Once you\u2019re signed in, your pay and your own spending for this tour live here.');
    if (c.failed && !c.info) {
      return h('div', { class: 'stack' }, h('p', { class: 'note' }, 'Couldn\u2019t load your pay just now.'),
        h('button', { class: 'btn ghost block', type: 'button', onclick: function () { myPayInfo(id, true); render(true); } }, 'Try again'));
    }
    if (!c.info) return h('p', { class: 'note pay-note' }, 'Loading\u2026');
    var st = G.payStanding(c.info), book = G.payBook(c.book), inc = G.payIncome(c.book, c.info.payments);
    S.payTab = S.payTab || {};
    var tab = S.payTab[id] === 'income' ? 'income' : 'expenses';
    var B = window.GR_BACKEND, me = B && B.uid ? B.uid() : null, meCard = me ? cardOf(me).card : null;
    // Devin (2026-10-07): your photo up top with two summary tabs, INCOME and
    // EXPENSES, on both tabs, and the same graph the tour has underneath.
    var sumTab = function (key, label, amount) {
      var on = tab === key;
      return h('button', { class: 'pay-sum-tab' + (on ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false',
        onclick: function () { S.payTab[id] = key; render(true); } },
        h('span', { class: 'pay-sum-k' }, label), h('strong', { class: 'pay-sum-v num' }, money(amount)));
    };
    var head = h('div', { class: 'pay-top' },
      h('div', { class: 'pay-photo' }, meCard ? personPhoto(meCard, 'sm') : null),
      h('div', { class: 'pay-sum-tabs', role: 'tablist' }, sumTab('income', 'INCOME', inc.gross), sumTab('expenses', 'EXPENSES', book.spent)));
    var inCls = { tour: 'guar', weekly: 'merch', perdiem: 'inother', buyout: 'guar', bonus: 'merch', other: 'inother' };
    var exCls = { food: 'crew', lodging: 'bus', travel: 'lcard', gear: 'mbill', other: 'other' };
    var chart = expenseSummary({ income: inc.gross, incomeBy: {},
        incParts: inc.lines.filter(function (l) { return l.total > 0; }).map(function (l) { return { label: l.label, v: l.total, cls: inCls[l.key] || 'inother' }; }) },
      book.lines.filter(function (l) { return l.total > 0; }).map(function (l) { return { label: l.label, v: l.total, cls: exCls[l.key] || 'other' }; }), false)
      || h('p', { class: 'note pay-note' }, 'Nothing logged yet. Log your pay under INCOME and what you spend under EXPENSES, and the picture draws itself.');
    var net = Math.round((inc.gross - book.spent) * 100) / 100;
    var netLine = h('p', { class: 'pay-sum' }, 'Gross ', h('strong', { class: 'num' }, money(inc.gross)), ' \u00b7 spent ', h('strong', { class: 'num' }, money(book.spent)),
      ' \u00b7 net ', h('strong', { class: 'num' + (net < 0 ? ' neg' : '') }, money(net)));
    var pays = Array.isArray(c.info.payments) ? c.info.payments : [];
    if (tab === 'income') {
      // Devin: the Income side carries the tour's climbing graph — money in
      // against what's spent, day by day — drawn once it's on the page.
      var series = G.payBalanceSeries(c.book, c.info.payments, G.tourToday());
      var climb = series.length > 1 ? h('div', { class: 'chart-wrap pay-chart', role: 'img',
        'aria-label': 'Money in against what you spent, from ' + dayLong(series[0].date) + ' to ' + dayLong(series[series.length - 1].date) + '. Now ' +
          money(series[series.length - 1].income) + ' in and ' + money(series[series.length - 1].spent) + ' spent.' }) : null;
      if (climb) climb.__data = { series: series, nights: [], tourId: null };
      var incRows = inc.lines.map(function (l) {
        var tourLine = l.key === 'tour';
        return h('button', { class: 'row rowbtn ex-row', type: 'button', onclick: function () { if (tourLine) openMyPayments(c.info); else openMyPayIncome(id, l.key); } },
          h('div', { class: 'row-label' }, l.label, h('span', { class: 'hint' }, tourLine ? (pays.length ? plural(pays.length, 'payment') + ' logged by the tour manager' : 'none logged by the tour manager yet')
            : (l.n ? plural(l.n, 'entry') : ''))),
          h('span', { class: 'amt num' + (l.total > 0 ? ' glow' : '') }, l.total > 0 ? money(l.total) : '\u2014'), icon('chevron', 18));
      });
      return [head, climb || h('p', { class: 'note pay-note' }, 'The graph draws itself once there\u2019s a payment or an entry to show.'), netLine,
        h('div', { class: 'ledger' }, myPayCardsRow(id)),
        st.onCrew ? h('p', { class: 'note pay-note' }, 'Pay plan: ' + money(st.total) + ' for the tour \u00b7 ' + money(st.paid) + ' logged as paid \u00b7 ' + money(st.owed) + ' still owed')
          : h('p', { class: 'note pay-note' }, 'You\u2019re not on this tour\u2019s crew list yet, so there is no pay plan here. The tour manager adds you under Crew with your email.'),
        h('h3', { class: 'mn-h mn-over' }, 'My income'),
        h('div', { class: 'ledger' }, incRows),
        h('div', { class: 'stack' }, h('button', { class: 'btn primary block', type: 'button', onclick: function () { openMyPayIncome(id, null); } },
          icon('plus', 18), 'Log income'))];
    }
    var colHead = h('div', { class: 'row ex-head', 'aria-hidden': 'true' },
      h('span', null, ''), h('span', { class: 'ex-proj' }, 'Projected'), h('span', { class: 'ex-paid' }, 'Credit'),
      h('span', { class: 'ex-done' }, 'Debit'), h('span', { class: 'ex-cash' }, 'Cash'), h('span', { class: 'ex-chev', 'aria-hidden': 'true' }));
    var cell = function (v, cls, label) {
      return h('span', { class: 'amt num ' + cls, 'aria-label': label + ' ' + money(v) }, v > 0.004 ? money(v) : '\u2014');
    };
    var lines = book.lines.map(function (l) {
      return h('button', { class: 'row rowbtn ex-row', type: 'button', onclick: function () { openMyPayCat(id, l.key); } },
        h('div', { class: 'row-label' }, l.label, l.n ? h('span', { class: 'hint' }, plural(l.n, 'expense')) : null),
        h('span', { class: 'amt num glow ex-proj', 'aria-label': 'Projected ' + (l.projected == null ? 'not set' : money(l.projected)) },
          l.projected == null ? '\u2014' : money(l.projected)),
        cell(l.credit, 'ex-paid', 'Credit'), cell(l.debit, 'ex-done', 'Debit'), cell(l.cash, 'ex-cash', 'Cash'),
        icon('chevron', 18));
    });
    return [head, chart, netLine,
      h('div', { class: 'ledger' }, myPayCardsRow(id)),
      h('h3', { class: 'mn-h mn-over' }, 'My expenses'),
      h('div', { class: 'ledger' }, colHead, lines),
      h('div', { class: 'stack' }, h('button', { class: 'btn primary block', type: 'button', onclick: function () { openMyPayCat(id, null); } },
        icon('plus', 18), 'Add expense'))];
  }
  // Logging what came in: weekly pay, per diems, buyouts, a bonus.
  function openMyPayIncome(id, key, keep) {
    var c = myPayInfo(id);
    var st = keep || { key: key || 'weekly', amount: null, date: G.ymd(new Date()), note: '', closed: false, saving: false };
    st.closed = false;
    var again = function () { if (!st.closed) openMyPayIncome(id, st.key, st); };
    openSheet(function () {
      var book = G.isObj(c.book) ? c.book : {};
      var cats = G.MY_PAY_INCOME;
      var idx = Math.max(0, cats.map(function (x) { return x.key; }).indexOf(st.key));
      var entries = G.rows(book.income).filter(function (e) { return (e.category || 'other') === st.key; })
        .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
      var amount = h('input', { class: 'input', type: 'number', inputmode: 'decimal', step: '0.01', min: '0', placeholder: '0.00',
        'aria-label': 'Amount', value: st.amount == null ? '' : st.amount,
        oninput: function (e) { st.amount = e.target.value === '' ? null : Number(e.target.value); } });
      var date = h('input', { class: 'input', type: 'date', 'aria-label': 'Day', value: st.date, oninput: function (e) { st.date = e.target.value; } });
      var note = h('input', { class: 'input', type: 'text', maxlength: 60, placeholder: 'A note (optional)', 'aria-label': 'Note', value: st.note,
        oninput: function (e) { st.note = e.target.value; } });
      var add = async function (e) {
        e.preventDefault(); blurActive();
        if (st.saving) return;
        if (!(st.amount > 0) || !isFinite(st.amount) || st.amount > 1e7) { toast('Enter the amount'); return; }
        if (!G.parseDay(st.date)) { toast('Pick the day'); return; }
        var amount = Math.round(st.amount * 100) / 100, entry = { date: st.date, amount: amount, category: st.key,
          note: String(st.note || '').trim().slice(0, 60), createdAt: Date.now() };
        st.saving = true;
        var ok = await saveMyPayBook(id, function (next) { next.income = G.isObj(next.income) ? next.income : {}; next.income[newId()] = entry; });
        st.saving = false;
        if (ok) { toast(money(amount) + ' logged'); st.amount = null; st.note = ''; again(); }
      };
      var drop = function (eid) {
        return async function () {
          if (st.saving) return;
          st.saving = true;
          var ok = await saveMyPayBook(id, function (next) { if (G.isObj(next.income)) delete next.income[eid]; });
          st.saving = false;
          if (ok) { toast('Removed'); again(); }
        };
      };
      return [
        h('h2', { class: 'sh-title' }, 'Log income'),
        segmented(cats.map(function (x) { return x.label; }), idx, function (i) { st.key = cats[i].key; again(); }, 'Kind of pay'),
        h('form', { class: 'stack', onsubmit: add },
          h('div', { class: 'pt-two' }, amount, date),
          note,
          h('button', { class: 'btn primary block', type: 'submit' }, 'Log it')),
        entries.length ? h('div', { class: 'ledger' }, entries.map(function (e) {
          return h('div', { class: 'row ex-row' },
            h('div', { class: 'row-label' }, e.note || cats[idx].label, h('span', { class: 'hint' }, e.date ? dayMD(e.date) : '')),
            h('span', { class: 'amt num' }, money(G.num(e.amount))),
            h('button', { class: 'pay-entry-x', type: 'button', 'aria-label': 'Remove this entry', onclick: drop(e.id) }, '\u00d7'));
        })) : h('p', { class: 'note' }, 'Nothing under ' + cats[idx].label.toLowerCase() + ' yet.'),
        h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Done')
      ];
    }, { label: 'Log income', onClose: function () { st.closed = true; } });
  }
  async function claimNewLogin(trip) {
    var B = window.GR_BACKEND, st = null;
    try { st = await B.feedCall('status'); } catch (e) { st = null; }
    var acc = st && G.isObj(st.accounts) ? st.accounts : (S.feed && S.feed.row && G.isObj(S.feed.row.accounts) ? S.feed.row.accounts : {});
    if (S.feed && st && G.isObj(st.accounts)) { S.feed.row = st; S.feed.at = Date.now(); }
    var before = Array.isArray(trip.itemsBefore) ? trip.itemsBefore : [];
    var mine = [];
    try { mine = await B.myPayItemIds(); } catch (e) { mine = []; }
    var fresh = Object.keys(acc).map(function (k) { return acc[k] && acc[k].item; }).filter(Boolean)
      .filter(function (x, i, a) { return a.indexOf(x) === i && before.indexOf(x) < 0 && mine.indexOf(x) < 0; });
    if (fresh.length) {
      try {
        var r = await B.myPayClaimItems(fresh);
        var list = r && Array.isArray(r.list) ? r.list : [];
        // Each new account: ask-only on the feed, and watched for 'guarantees' alone — the tag that says "personal" to the deposit routing.
        for (var i = 0; i < list.length; i++) {
          var a = acc[list[i].id] || {};
          if (!fresh.some(function (it) { return it === a.item; })) continue;
          try { await B.feedCall('setup', { account: { id: list[i].id, card: list[i].card, mode: 'ask', income: list[i].card === 'credit' ? [] : ['guarantees'] } }); } catch (e) { /* still yours */ }
        }
        if (S.feed) S.feed.at = 0;
        toast(plural(list.length, 'account') + ' added to MY PAY');
      } catch (e) { saveFailed('cards', e); }
    }
    await quietTwins();
    myPayCardsInfo(true);
    openMyPayCards(trip.tourId || null, true);
  }
  // The same bank account connected on both sides is one account: the person
  // said it's theirs, so the tour's copy is switched off (it stops reading).
  async function quietTwins() {
    var B = window.GR_BACKEND;
    if (!B.myPayTwins) return;
    var twins = [];
    try { twins = await B.myPayTwins(); } catch (e) { twins = []; }
    for (var i = 0; i < twins.length; i++) {
      try { await B.feedCall('setup', { account: { id: twins[i].id, mode: 'off', income: [] } }); } catch (e) { /* tried */ }
    }
    if (twins.length) { if (S.feed) S.feed.at = 0; toast(plural(twins.length, 'account') + ' moved from the tour\u2019s cards to yours'); }
  }
  /* ---- MY PAY's own cards (Devin, 2026-10-08): a separate connection from
     the tour's. Accounts you claim as yours feed your inbox here, never the
     tour's new charges; you file each one into your book, or skip it. ---- */
  function myPayCardsInfo(fresh) {
    var B = window.GR_BACKEND;
    var c = S.myPayCards || (S.myPayCards = { accounts: [], inbox: [], at: 0, asking: false, failed: false, none: false });
    if (S.mode !== 'db' || !B || !B.myPayAccounts) { c.none = true; return c; }
    if (!c.asking && (fresh || !c.at || Date.now() - c.at > 60000)) {
      c.asking = true;
      Promise.all([B.myPayAccounts(), B.myPayInbox()]).then(function (got) {
        c.accounts = Array.isArray(got[0]) ? got[0] : []; c.inbox = Array.isArray(got[1]) ? got[1] : [];
        c.failed = false; c.at = Date.now(); c.asking = false; render(true);
      }, function () { c.failed = true; c.at = Date.now(); c.asking = false; render(true); });
    }
    return c;
  }
  function isMyPayAccount(accountId) {
    var c = S.myPayCards;
    return !!(c && c.accounts.some(function (a) { return a.account_id === accountId; }));
  }
  function myPayCardsRow(id) {
    var c = myPayCardsInfo();
    if (c.none) return null;
    var n = c.inbox.length, k = c.accounts.length;
    return h('button', { class: 'row rowbtn ex-row pay-row', type: 'button', onclick: function () { openMyPayCards(id); } },
      h('div', { class: 'row-label' }, 'Your cards', h('span', { class: 'hint' }, k ? plural(k, 'account') + ' connected' : 'Connect your own card')),
      n ? h('span', { class: 'amt num glow' }, n + ' new') : null, icon('chevron', 18));
  }
  function openMyPayCards(id, justLinked) {
    var B = window.GR_BACKEND;
    var again = function () { if (sheet && sheet.myPayCards) openMyPayCards(id); };
    openSheet(function () {
      var c = myPayCardsInfo();
      var release = function (a) {
        return async function () {
          try { await B.myPayReleaseAccount(a.account_id); myPayCardsInfo(true); toast(a.name + ' taken off'); again(); }
          catch (x) { saveFailed('cards', x); }
        };
      };
      var file = function (it, cat, how) {
        return async function (e) {
          var b = e.currentTarget; b.disabled = true;
          try { await B.myPayFile(id, it.id, cat, how); c.inbox = c.inbox.filter(function (x) { return x.id !== it.id; }); myPayInfo(id, true); toast(money(G.num(it.amount)) + ' filed'); again(); }
          catch (x) { b.disabled = false; saveFailed('cards', x); }
        };
      };
      var skip = function (it) {
        return async function (e) {
          var b = e.currentTarget; b.disabled = true;
          try { await B.myPaySkip(it.id); c.inbox = c.inbox.filter(function (x) { return x.id !== it.id; }); toast('Skipped'); again(); }
          catch (x) { b.disabled = false; saveFailed('cards', x); }
        };
      };
      var inboxCard = function (it) {
        var charge = it.kind === 'charge';
        var cats = charge ? G.MY_PAY_CATS : G.MY_PAY_INCOME;
        // Short names here: five of them have to share one phone-wide row.
        var shortNames = { food: 'Food', lodging: 'Lodging', travel: 'Travel', gear: 'Gear', other: 'Other', weekly: 'Weekly', perdiem: 'Per diem', buyout: 'Buyout', bonus: 'Bonus' };
        var pick = { cat: charge ? 'other' : 'weekly' };
        var idx = cats.map(function (x) { return x.key; }).indexOf(pick.cat);
        return h('div', { class: 'tf-card mpc-item' },
          h('p', { class: 'tf-name tf-run-t' }, charge ? (it.merchant || 'Charge') : 'Deposit', h('span', { class: 'mpc-amt num' }, money(G.num(it.amount)))),
          h('p', { class: 'tf-sub' }, [it.date ? dayMD(it.date) : '', it.account, charge ? (it.card === 'credit' ? 'Credit' : 'Debit') : ''].filter(Boolean).join(' \u00b7 ')),
          segmented(cats.map(function (x) { return shortNames[x.key] || x.label; }), idx, function (i) { pick.cat = cats[i].key; }, charge ? 'Category' : 'Kind of pay'),
          h('div', { class: 'pt-two tf-acts' },
            h('button', { class: 'btn primary', type: 'button', onclick: function (e) { file(it, pick.cat, charge ? it.card : null)(e); } }, charge ? 'File it' : 'Log it'),
            h('button', { class: 'btn ghost', type: 'button', onclick: skip(it) }, 'Skip')));
      };
      return [
        h('h2', { class: 'sh-title' }, 'Your cards'),
        h('p', { class: 'sh-sub' }, 'Your own bank or cards, nothing to do with the tour\u2019s. A bank you connect here is yours, every account on it. What lands on them comes to you here, and you file it into your MY PAY book.'),
        justLinked && !c.accounts.length ? h('p', { class: 'note' }, 'Your bank is connected. Its accounts land here as soon as the bank hands them over (a minute or so).') : null,
        c.accounts.length ? h('div', { class: 'ledger' }, c.accounts.map(function (a) {
          return h('div', { class: 'row ex-row' }, h('div', { class: 'row-label' }, a.name, h('span', { class: 'hint' }, a.card === 'credit' ? 'Credit card' : 'Debit card')),
            h('button', { class: 'pf-btn', type: 'button', onclick: release(a) }, 'Remove'));
        })) : h('p', { class: 'note' }, 'No bank connected here yet.'),
        h('button', { class: 'btn primary block', type: 'button', onclick: function () { connectCards(id, null, { myPay: true }); } }, icon('card', 18), 'Connect a bank or card'),
        c.inbox.length ? [h('h3', { class: 'sh-h3' }, plural(c.inbox.length, 'new item') + ' from your cards'), c.inbox.map(inboxCard)] : null,
        h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Done')
      ];
    }, { label: 'Your cards' });
    if (sheet) sheet.myPayCards = true;
  }
  // What the tour manager has logged as paid to you, newest first.
  function openMyPayments(info) {
    var pays = Array.isArray(info && info.payments) ? info.payments : [];
    openSheet(function () {
      return [h('h2', { class: 'sh-title' }, 'Payments to you'),
        pays.length ? h('div', { class: 'ledger' }, pays.map(function (p) {
          return h('div', { class: 'row ex-row' },
            h('div', { class: 'row-label' }, p.label || 'Pay', h('span', { class: 'hint' }, [p.date ? dayMD(p.date) : '', p.how].filter(Boolean).join(' \u00b7 '))),
            h('span', { class: 'amt num' }, money(G.num(p.amount))));
        })) : h('p', { class: 'note' }, 'Nothing logged as paid to you yet. The tour manager logs pay under Crew.'),
        h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Close')];
    }, { label: 'Payments' });
  }
  // One category of your own spending: its entries, a projected figure, and a way to add one.
  function openMyPayCat(id, key, keep) {
    var c = myPayInfo(id);
    var st = keep || { key: key || 'food', amount: null, how: 'debit', date: G.ymd(new Date()), note: '', closed: false };
    st.closed = false;
    // Dismissed while a save was still on its way: it stays dismissed.
    var again = function () { if (!st.closed) openMyPayCat(id, st.key, st); };
    openSheet(function () {
      var book = G.isObj(c.book) ? c.book : {};
      var cats = G.MY_PAY_CATS;
      var idx = Math.max(0, cats.map(function (x) { return x.key; }).indexOf(st.key));
      var entries = G.rows(book.entries).filter(function (e) { return (e.category || 'other') === st.key; })
        .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
      var proj = G.isObj(book.projected) ? book.projected : {};
      var amount = h('input', { class: 'input', type: 'number', inputmode: 'decimal', step: '0.01', min: '0', placeholder: '0.00',
        'aria-label': 'Amount', value: st.amount == null ? '' : st.amount,
        oninput: function (e) { st.amount = e.target.value === '' ? null : Number(e.target.value); } });
      var date = h('input', { class: 'input', type: 'date', 'aria-label': 'Day', value: st.date, oninput: function (e) { st.date = e.target.value; } });
      var note = h('input', { class: 'input', type: 'text', maxlength: 60, placeholder: 'What for (optional)', 'aria-label': 'Note', value: st.note,
        oninput: function (e) { st.note = e.target.value; } });
      var projIn = h('input', { class: 'input', type: 'number', inputmode: 'decimal', step: '1', min: '0', placeholder: 'Not set',
        'aria-label': 'Projected for this category', value: proj[st.key] == null ? '' : proj[st.key],
        onchange: async function (e) {
          var v = e.target.value;
          if (await saveMyPayBook(id, function (next) {
            next.projected = G.isObj(next.projected) ? next.projected : {};
            if (v === '') delete next.projected[st.key]; else next.projected[st.key] = Math.max(0, Number(v) || 0);
          })) toast('Projected saved');
        } });
      var add = async function (e) {
        e.preventDefault(); blurActive();
        if (st.saving) return;
        if (!(st.amount > 0) || !isFinite(st.amount) || st.amount > 1e7) { toast('Enter the amount'); return; }
        if (!G.parseDay(st.date)) { toast('Pick the day'); return; }
        var amount = Math.round(st.amount * 100) / 100, entry = { date: st.date, amount: amount, how: st.how, category: st.key,
          note: String(st.note || '').trim().slice(0, 60), createdAt: Date.now() };
        st.saving = true;
        var ok = await saveMyPayBook(id, function (next) { next.entries = G.isObj(next.entries) ? next.entries : {}; next.entries[newId()] = entry; });
        st.saving = false;
        if (ok) { toast(money(amount) + ' added'); st.amount = null; st.note = ''; again(); }
      };
      var drop = function (eid) {
        return async function () {
          if (st.saving) return;
          st.saving = true;
          var ok = await saveMyPayBook(id, function (next) { if (G.isObj(next.entries)) delete next.entries[eid]; });
          st.saving = false;
          if (ok) { toast('Removed'); again(); }
        };
      };
      return [
        h('h2', { class: 'sh-title' }, 'My expenses'),
        segmented(cats.map(function (x) { return x.label; }), idx, function (i) { st.key = cats[i].key; again(); }, 'Category'),
        h('form', { class: 'stack', onsubmit: add },
          h('div', { class: 'pt-two' }, amount, date),
          note,
          segmented(['Credit', 'Debit', 'Cash'], ['credit', 'debit', 'cash'].indexOf(st.how), function (i) { st.how = ['credit', 'debit', 'cash'][i]; }, 'How it was paid'),
          h('button', { class: 'btn primary block', type: 'submit' }, 'Add')),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Projected for ' + cats[idx].label.toLowerCase()), projIn),
        entries.length ? h('div', { class: 'ledger' }, entries.map(function (e) {
          return h('div', { class: 'row ex-row' },
            h('div', { class: 'row-label' }, e.note || cats[idx].label,
              h('span', { class: 'hint' }, [e.date ? dayMD(e.date) : '', e.how === 'cash' ? 'Cash' : e.how === 'debit' ? 'Debit' : 'Credit'].filter(Boolean).join(' \u00b7 '))),
            h('span', { class: 'amt num' }, money(G.num(e.amount))),
            h('button', { class: 'pay-entry-x', type: 'button', 'aria-label': 'Remove this expense', onclick: drop(e.id) }, '\u00d7'));
        })) : h('p', { class: 'note' }, 'Nothing under ' + cats[idx].label.toLowerCase() + ' yet.'),
        h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Done')
      ];
    }, { label: 'My expenses', onClose: function () { st.closed = true; } });
  }

  /* Five tabs along the bottom. The day sheet is where a tour opens. */
  var TOUR_TABS = [
    { view: 'details', label: 'Overview', icon: 'tabmap' },
    { view: 'money', label: 'Income', icon: 'tabmoney' },
    { view: 'day', label: 'Day sheet', icon: 'tabsheet' },
    { view: 'costs', label: 'Expenses', icon: 'tabcost' },
    { view: 'guests', label: 'Guest list', icon: 'tabguest' },
    { view: 'stats', label: 'Crew Stats', icon: 'tabstats' },
    { view: 'chat', label: 'Chat', icon: 'tabchat' }
  ];

  /* A tour's tabs, either side of your photo. The money is one tab, Budget,
     which opens Expenses; Expenses and Income are two tabs above the chart
     there. GA never sees the Budget tab. */
  var BOOK_TABS = ['costs', 'cards', 'money', 'mypay'];
  var BOOK_STRIP = [{ view: 'costs', label: 'Expenses', icon: 'tabcost' }, { view: 'cards', label: 'Cards', icon: 'card' },
    { view: 'money', label: 'Income', icon: 'tabmoney' }];
  var BUDGET_TAB = { view: 'costs', label: 'Budget', icon: 'tabmoney', book: true };
  function tourTabs(id, current) {
    // Everyone gets the Budget tab now (Devin, 2026-10-07): GA opens it to
    // MY PAY; the tour's own book inside stays ALL ACCESS only.
    var tabs = TOUR_TABS.filter(function (t) { return t.view !== 'money' && t.view !== 'costs'; });
    tabs.splice(1, 0, BUDGET_TAB);
    var buttons = tabs.map(function (t) {
      // Budget is lit on Expenses and Income (their own two tabs sit above the chart).
      var on = t.book ? BOOK_TABS.indexOf(current) >= 0 : t.view === current;
      return tabButton(on, t.label, t.icon, function () {
        if (!on || (S.route.view || 'details') !== t.view) go({ name: 'tour', id: id, view: t.view });
      });
    });
    var half = Math.ceil(buttons.length / 2);
    return dock(buttons.slice(0, half), buttons.slice(half), '',
      id + '|' + current + '|' + tabs.map(function (t) { return t.label; }).join(','), { label: 'Tour sections' });
  }
  function tabButton(on, label, iconName, goThere, face) {
        var down = null;
        return h('button', {
          class: 'tabbar-b' + (on ? ' on' : ''), type: 'button',
          'aria-current': on ? 'page' : null,
          // A clean tap goes the moment the finger lifts. iPhone can drop the
          // click on a fixed bar right after a scroll; the click still serves
          // a mouse or a keyboard.
          ontouchstart: function (e) {
            var p = e.changedTouches && e.changedTouches[0];
            down = p ? { x: p.clientX, y: p.clientY, at: Date.now() } : null;
          },
          ontouchend: function (e) {
            var p = e.changedTouches && e.changedTouches[0], d = down;
            down = null;
            if (!p || !d || Math.abs(p.clientX - d.x) > 14 || Math.abs(p.clientY - d.y) > 14 || Date.now() - d.at > 900) return;
            e.preventDefault();
            goThere();
          },
          ontouchcancel: function () { down = null; },
          onclick: goThere
        }, face || icon(iconName, 23), h('span', null, label));
  }
  // The band page's two tabs either side of your photo: TOUR and OFF TOUR (the owner and ALL ACCESS only).
  function artistTabs(name, current) {
    if (!canSeeOffTour(name)) return dock([], [], '', 'band|' + name);
    var tabs = [{ view: 'tours', label: 'TOUR', icon: 'tabmap' }, { view: 'off', label: 'OFF TOUR', icon: 'tabcost' }].map(function (t) {
      var on = t.view === current;
      return tabButton(on, t.label, t.icon, function () { if (!on) go({ name: 'artist', artist: name, view: t.view }); });
    });
    return dock([tabs[0]], [tabs[1]], '', 'band|' + name + '|' + current, { cls: 'band-tabs', label: name + ' sections' });
  }


  /* The bus group chat: one thread for the whole run, riding the notes
     store under the 'chat' day so GA can talk too and RLS stays the judge. */
  /* The bus group chat: the crew and the team talking, nothing else. Ari's
     merch and settlement readings live on her own page (the ARI button),
     so nothing the crew says gets buried under paperwork. */
  function isAriNote(n) { var a = String(n && n.author || ''); return a === 'Ari' || a === 'atVenu'; }
  function noteTime(n) { return typeof n.at === 'number' ? n.at : Date.parse(n.at) || 0; }
  function noteWhen(n) {
    var ts = noteTime(n), dt = ts ? new Date(ts) : null;
    if (!dt) return '';
    var clock = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return G.ymd(dt) === G.ymd(new Date()) ? clock : dayMD(G.ymd(dt)) + ' ' + clock;
  }
  function viewTourChat(id, t) {
    var backend = !!(window.GR_BACKEND && S.mode === 'db' && window.GR_BACKEND.notesFor);
    var myUid = backend && window.GR_BACKEND.uid ? window.GR_BACKEND.uid() : null;
    var list = notesFor(t, id, 'chat').filter(function (n) { return !isAriNote(n); }).slice()
      .sort(function (a, b) { return noteTime(a) - noteTime(b); });
    var refresh = function () { setTimeout(function () { render(true); }, backend ? 500 : 150); };

    var msgs = list.map(function (n) {
      var mine = !backend || !myUid || (n.addedBy && n.addedBy === myUid);
      var ts = noteTime(n), dt = ts ? new Date(ts) : null;
      var when = !dt ? '' : G.ymd(dt) === G.ymd(new Date())
        ? dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : dayMD(G.ymd(dt));
      return h('div', { class: 'chat-msg' },
        h('div', { class: 'chat-top' },
          h('span', { class: 'chat-a' }, n.author || 'Someone'),
          h('span', { class: 'chat-t' }, when),
          (canWrite() || mine) ? h('button', { class: 'iconbtn sm chat-x', type: 'button',
            'aria-label': 'Delete this message',
            onclick: async function () {
              try { await removeNote(id, 'chat', n.id); refresh(); }
              catch (e2) { toast('Only the tour manager can delete someone else’s message.'); }
            } }, icon('trash', 14)) : null),
        h('div', { class: 'chat-b' }, n.body));
    });

    // The typing bar, iMessage size: a thin pill, the send arrow inside its
    // right end, lit once there's something to send.
    var draftKey = 'chat:' + id;
    var sendBtn = h('button', { class: 'chat-send', type: 'submit', 'aria-label': 'Send',
      disabled: !String(S.drafts[draftKey] || '').trim() }, icon('up', 17));
    var input = h('input', { class: 'chat-in', type: 'text', maxlength: 300,
      value: S.drafts[draftKey] || '', placeholder: 'Message',
      autocomplete: 'off', enterkeyhint: 'send', 'aria-label': 'Message',
      oninput: function (e) {
        S.drafts[draftKey] = e.target.value;
        sendBtn.disabled = !e.target.value.trim();
      } });
    var send = async function (e) {
      e.preventDefault();
      var body = String(S.drafts[draftKey] || '').trim();
      if (!body) return;
      try {
        await saveNote(id, 'chat', { id: newId(), body: body, author: myName() });
        delete S.drafts[draftKey];
        refresh();
      } catch (e2) { toast('Couldn’t send that. Try again.'); }
    };

    return h('div', { class: 'page tour has-tabs chat-page' },
      // The full Greenroom wordmark with Chat small under it, sized to the slim band.
      tourBand(t, id, 'chat', h('h1', { class: 'band-brand' },
        h('span', { class: 'wordmark-full', role: 'img', 'aria-label': 'Greenroom' }), h('span', { class: 'band-brand-t' }, 'Chat'))),
      dbBanner(),
      // The bus, barely there behind the conversation.
      h('div', { class: 'chat-bus', 'aria-hidden': 'true' }),
      h('div', { class: 'chat-tools' }, h('span', { class: 'ct-side' }), ariButton(id), alertsBell(id) || h('span', { class: 'ct-side' })),
      msgs.length ? h('div', { class: 'chat-list' }, msgs) : null,
      h('form', { class: 'chat-form', onsubmit: send, novalidate: true },
        h('div', { class: 'chat-field' }, input, sendBtn)),
      tourTabs(id, 'chat'));
  }

  /* ================================ Ari ================================
     Ari's own page: her merch and settlement readings, her questions ("Would
     you like me to correct this?") and her answers. ALL ACCESS only (the
     database never hands her messages to GA). The ARI button glows green
     while there's something you haven't read, and greys out once you have;
     each person's reading is their own. */
  function ariSeenKey(tourId) { return 'seen-ari-' + tourId; }
  function ariNotes(tourId) {
    return notesFor(getTour(tourId), tourId, 'chat').filter(isAriNote)
      .sort(function (a, b) { return noteTime(b) - noteTime(a); });
  }
  function ariUnread(tourId) {
    var seen = seenShape(seenMap()[ariSeenKey(tourId)]).at;
    return ariNotes(tourId).filter(function (n) { return noteTime(n) > seen; }).length;
  }
  function markAriRead(tourId) {
    var key = ariSeenKey(tourId), rec = seenShape(seenMap()[key]);
    rec.at = Date.now();
    seenMap()[key] = rec;
    lsSet(seenKey(), JSON.stringify(S.seen));
    if (S.mode === 'db' && store.db) {
      Promise.resolve(store.db.doc('labels/' + key).set({ kind: 'seen', at: rec.at })).catch(function () { /* this phone remembers */ });
    }
  }
  function ariButton(tourId) {
    if (!leadsTour(tourId)) return h('span', { class: 'ct-side' });
    var n = ariUnread(tourId);
    return h('button', { class: 'ari-btn' + (n ? ' on' : ' seen'), type: 'button',
      'aria-label': 'Ari' + (n ? ', ' + plural(n, 'new message') : ''),
      onclick: function () { openAriSheet(tourId); } },
      'ARI', n ? h('span', { class: 'ari-count' }, String(n)) : null);
  }

  // Answer Ari's question (or several at once).
  async function answerAri(tourId, list, yes) {
    if (S.ariAnswering) return;
    S.ariAnswering = true;
    var said = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      try {
        var out = await window.GR_BACKEND.ariAnswer(a.id, yes);
        said.push(out === 'fixed' ? '✅ ' + a.place + ' merch corrected to ' + G.moneyCents(a.fix)
          : out === 'left' ? 'Left ' + a.place + ' at ' + G.moneyCents(a.was)
          : out === 'moved' ? a.place + ' changed since Ari asked, so she left it' : a.place + ' already answered');
      } catch (e2) {
        said.push(e2 && e2.code === 'permission' ? 'Only the tour manager can answer Ari.' : 'Couldn’t reach Ari. Try again.');
        break;
      }
    }
    S.ariAnswering = false;
    toast(said.join(' · '));
  }

  function openAriSheet(tourId) {
    var B = window.GR_BACKEND;
    var box = h('div');
    function askRow(a) {
      if (a.status !== 'open') {
        return h('div', { class: 'ask-done' }, a.status === 'fixed' ? '✓ Corrected to ' + G.moneyCents(a.fix)
          : a.status === 'left' ? 'Left at ' + G.moneyCents(a.was) : 'Left alone (the number had changed)');
      }
      if (!moneyLead(tourId)) return h('div', { class: 'ask-done' }, 'Waiting on the tour manager');
      var go1 = function (yes) { return async function () { await answerAri(tourId, [a], yes); markAriRead(tourId); draw(); }; };
      return h('div', { class: 'ask-row' },
        h('button', { class: 'btn sm ask-yes', type: 'button', onclick: go1(true) }, 'Yes, correct it'),
        h('button', { class: 'btn sm quiet', type: 'button', onclick: go1(false) }, 'No, leave it'));
    }
    function draw() {
      var asks = S.mode === 'db' && B && B.asksFor ? B.asksFor(tourId) : [];
      var askOf = function (id2) { return asks.filter(function (a) { return a.noteId === id2; })[0] || null; };
      var open = asks.filter(function (a) { return a.status === 'open'; });
      var notes = ariNotes(tourId);
      box.replaceChildren(
        open.length > 1 && moneyLead(tourId) ? h('div', { class: 'ari-all' },
          h('span', null, plural(open.length, 'question') + ' waiting'),
          h('button', { class: 'btn sm ask-yes', type: 'button', onclick: async function () {
            await answerAri(tourId, open, true); markAriRead(tourId); draw();
          } }, 'Yes to all')) : h('span'),
        notes.length ? h('div', { class: 'ari-list' }, notes.map(function (n) {
          var q = askOf(n.id);
          return h('div', { class: 'chat-msg from-ari' + (q && q.status === 'open' ? ' asking' : '') },
            h('div', { class: 'chat-top' },
              h('span', { class: 'chat-a' }, 'Ari · tour manager'),
              h('span', { class: 'chat-t' }, noteWhen(n))),
            h('div', { class: 'chat-b' }, n.body),
            q ? askRow(q) : null);
        })) : h('p', { class: 'note wn-clear' }, 'Nothing from Ari yet. Her merch and settlement readings show up here.'));
    }
    markAriRead(tourId);
    draw();
    openSheet(function (panel) {
      panel.classList.add('ari-sheet');
      return [h('h2', { class: 'sh-title' }, 'Ari'),
        h('p', { class: 'sh-sub' }, 'Merch and settlement readings, and anything she needs from you. Newest first.'),
        box];
    }, { label: 'Ari', onClose: function () { markAriRead(tourId); render(true); } });
  }

  var ARI_ADDRESS = '30bb39e4368b9e23ff77@cloudmailin.net';

  /* The address this tour's settlements should be mailed to. The +tag is the
     tour itself, so atVenu can feed twenty runs at once and never cross them. */
  function settlementAddress(tourId) {
    var at = ARI_ADDRESS.indexOf('@');
    return ARI_ADDRESS.slice(0, at) + '+' + tourId + ARI_ADDRESS.slice(at);
  }

  // The same plain voice as Ari's atVenu breakdowns: one short message the
  // whole crew can follow.
  function ariPrompt(body, isImage, merchOnly) {
    return [
      'You are Ari, the tour manager for a touring band. A ' + (merchOnly ? 'merch summary' : 'settlement sheet') +
        ' just came in' + (isImage ? ' as a photo or PDF.' : '.'),
      'Explain it to the whole crew in a group chat \u2014 the drummer, the merch kid, the guitar tech.',
      'Most of them have never read a settlement and will not ask questions if it sounds complicated.',
      '',
      'Rules for your message:',
      '- Under 90 words. Short lines. No greeting, no sign-off, no emoji.',
      '- Say what came in, what was taken out and why, and what the band actually keeps.',
      '- Explain any term the moment you use it (a per head is dollars of merch per person in',
      '  the room; a backend is the cut above the guarantee once the room is full enough).',
      '- Use only numbers printed on the sheet. Never invent or estimate one. If something is',
      '  missing or looks off, say so plainly in one line.',
      '- Say whether this night was strong, normal or soft, and why, in one line.',
      isImage ? '' : '\nThe sheet:\n' + String(body).slice(0, 20000)
    ].join('\n');
  }

  /* Ari reads a settlement (text or images) and posts her breakdown to chat. */
  async function ariExplain(tourId, textBody, images, merchOnly) {
    var B = window.GR_BACKEND;
    var prompt = images ? ariPrompt('', true, merchOnly) : ariPrompt(textBody, false, merchOnly);
    try {
      // Signed in: the server posts Ari's message, so only it can speak as Ari.
      if (S.mode === 'db' && B && B.ariSay) {
        var told = await B.ariSay(tourId, prompt, images || null);
        return !!String(told || '').trim();
      }
      var out = images
        ? await S.sample(prompt, { images: images, cache: false })
        : await S.sample(prompt, { cache: false });
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
        h('h2', { class: 'sh-title' }, 'Send Tour Alert'),
        h('p', { class: 'sh-sub' }, 'Pings the phone of everyone on this tour who has alerts turned on, right now. It lands in the chat too.'),
        h('form', { class: 'sh-form', novalidate: true,
          onsubmit: async function (e) {
            e.preventDefault();
            var msg = f.message.trim();
            if (!msg) { toast('Write the alert first'); return; }
            blurActive();
            try {
              await saveNote(tourId, 'chat', { id: newId(), body: '\ud83d\udea8 ' + msg, author: myName() });
            } catch (e2) { toast('Couldn\u2019t post it. Try again.'); return; }
            closeSheet();
            if (S.mode !== 'db') toast('Posted \u2014 pushes go out on the real app');
            else {
              toast('Sending\u2026');
              sendNotify(tourId, 'alert', { message: msg }).then(function (n) {
                toast(n == null ? 'Posted in the chat. The ping may not have gone out \u2014 try again.'
                  : n === 0 ? 'Posted in the chat. Nobody on the tour has alerts on yet.'
                  : 'Alert sent to ' + plural(n, 'phone'));
              });
            }
            setTimeout(function () { render(true); }, 400);
          } },
          field('The alert', h('textarea', { class: 'gl-paste', maxlength: 200,
            placeholder: 'Bus call moved to 11:30\u2026',
            oninput: function (e) { f.message = e.target.value; } })),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Send Tour Alert'),
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
  // ALL ACCESS edits a tour like its creator does (Devin, 2026-09-30).
  function canEditTour(id) { var r = tourRole(id); return r === 'owner' || r === 'editor'; }
  // What stays the creator's: deleting the tour, the bank and card settings,
  // Crew Stats' tour-manager stats, starting the band's Off Tour book.
  function createdTour(id) { return tourRole(id) === 'owner'; }
  // The tour manager and ALL ACCESS: polls, and marking requests done.
  function leadsTour(id) { return tourRole(id) === 'owner' || tourRole(id) === 'editor'; }
  function canSeeMoney(id) { return tourRole(id) !== 'viewer'; }

  function tourBands(t) {
    return Array.isArray(t && t.bands)
      ? t.bands.filter(function (b) { return String(b || '').trim(); }) : [];
  }

  // Which band on the bill is the one using the app: whose set time is
  // "show time" for Ari's SHOW TIME message.
  function ourBand(t) {
    var mine = String(t && t.ourBand || '').trim();
    return mine && tourBands(t).some(function (b) { return b.toLowerCase() === mine.toLowerCase(); }) ? mine : '';
  }
  function openOurBandSheet(tourId, then) {
    var t = getTour(tourId);
    var bands = tourBands(t);
    if (!bands.length) { if (then) then(); return; }
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'Which band are you?'),
        h('p', { class: 'sh-sub' }, 'Ari sends SHOW TIME to the band 30 minutes before this band\u2019s set.'),
        h('div', { class: 'stack band-pick' }, bands.map(function (b) {
          return h('button', { class: 'btn ' + (ourBand(t) === b ? 'primary' : 'ghost') + ' block', type: 'button',
            onclick: async function () {
              if (await api.update(tourId, { ourBand: b })) {
                closeSheet(); toast(b + ' \u2014 got it'); render(true);
                if (then) setTimeout(then, 350);
              }
            } }, b);
        })),
        h('button', { class: 'btn ghost block', type: 'button', style: 'margin-top:10px',
          onclick: function () { closeSheet(); if (then) setTimeout(then, 350); } }, 'Skip for now')
      ];
    }, { label: 'Which band are you?' });
  }
  // The lineup and our band, changeable any time (ADD MORE SHOWS menu).
  function openLineupSheet(tourId) {
    openSheet(function () {
      var t = getTour(tourId);
      var mine = ourBand(t);
      return [
        h('h2', { class: 'sh-title' }, 'Lineup & your band'),
        h('p', { class: 'sh-sub' }, 'Every day sheet starts with these bands. Tap one to take it off.'),
        lineupEditor(tourId, t),
        h('div', { class: 'ds-yn', style: 'margin-top:16px;min-height:48px' },
          h('div', { class: 'row-label', style: 'flex:1' }, 'Your band',
            h('span', { class: 'hint' }, mine || 'Not picked yet')),
          tourBands(t).length ? h('button', { class: 'btn quiet', type: 'button',
            onclick: function () { openOurBandSheet(tourId); } }, mine ? 'Change' : 'Pick') : null)
      ];
    }, { label: 'Lineup' });
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
    return h('div', { class: 'page tour has-tabs' },
      tourBand(t, id, 'addshows'),
      h('h1', { class: 'tour-title' }, 'Add shows'),
      dbBanner(),
      addShowsBody(id, t),
      tourTabs(id, 'details'));
  }

  /* Everywhere shows come from, in one place — its own page from the wizard,
     and the Budget tab called "Add more shows". */
  /* Every way dates get onto the tour: the flyer first, then by hand,
     then the days around the run. */
  function addShowsOptions(id) {
    if (!canEditTour(id)) return null;
    return h('div', { class: 'stack add-shows' },
      S.sample ? fileControl({
        label: 'Upload Flyer', icon: 'flyer', cls: 'btn primary block',
        accept: imageAccept(),
        onFiles: function (files) { readFlyer(id, files[0]); }
      }) : unavailableBtn('Upload Flyer', 'btn primary block'),
      h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openShowSheet(id); } },
        icon('edit', 18), 'Add Shows Manually'),
      h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openTravelDaysSheet(id); } },
        icon('tabmap', 18), 'Add Travel Days'),
      h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openRehearsalSheet(id); } },
        icon('music', 18), 'Add Rehearsal Days'),
      h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openLineupSheet(id); } },
        icon('music', 18), 'Lineup & Your Band'));
  }
  function openAddShowsMenu(id) {
    openSheet(function () {
      return [h('h2', { class: 'sh-title' }, 'Add more shows'), addShowsOptions(id)];
    }, { label: 'Add more shows' });
  }
  // The stand-alone page a tour with no dates lands on.
  function addShowsBody(id, t) {
    return [
      addShowsOptions(id),
      G.rows(t.shows).length ? null : emptyState('No shows yet', canEditTour(id)
        ? 'Shoot the flyer and the dates fill themselves in.' : 'No dates have been added.')
    ];
  }


  function viewTour() {
    var id = S.route.id;
    var view = S.route.view || 'details';
    var tab = S.route.tab || 'shows';
    var t = getTour(id);
    if (!t) {
      return h('div', { class: 'page has-tabs' },
        h('header', { class: 'topbar' }),
        emptyState('This tour isn’t here anymore', 'It may have been deleted.'),
        socialBar(''));
    }
    if (view === 'addshows') return viewAddShows(id, t);
    if (view === 'menu') view = 'details';
    // GA never sees money: only the screens named here open for them; anything
    // else (Budget, Expenses and their sub-pages, or a name nobody recognises,
    // which would otherwise fall through to Budget) is Overview.
    if (!canSeeMoney(id) && ['details', 'day', 'guests', 'chat', 'calendar', 'stats', 'costs', 'mypay'].indexOf(view) < 0) {
      view = 'details';
    }
    if (view === 'day' || view === 'details' || view === 'guests') {
      return viewTourDay(id, t, view);
    }
    if (view === 'chat') return viewTourChat(id, t);
    if (view === 'calendar') return viewCalendar(id, t);
    if (view === 'stats') return viewStats(id, t);
    if (view === 'mypay') return viewMyPay(id, t);
    // GA on the Budget tab: the tour's book is ALL ACCESS only; MY PAY is theirs.
    if (view === 'costs' && !canSeeMoney(id)) {
      return h('div', { class: 'page tour has-tabs exp-page' },
        tourBand(t, id, 'costs'),
        payTabs(id, t, 'costs'),
        dbBanner(),
        payLocked(),
        tourTabs(id, 'costs'));
    }
    var c = G.calc(t);
    if (view === 'costs') {
      return h('div', { class: 'page tour has-tabs exp-page' },
        tourBand(t, id, 'costs'),
        payTabs(id, t, 'costs'),
        bookStrip(id, 'costs'),
        dbBanner(),
        tabExpenses(id, t, c),
        tourTabs(id, 'costs'));
    }
    if (view === 'cards') {
      return h('div', { class: 'page tour has-tabs exp-page' },
        tourBand(t, id, 'cards'),
        payTabs(id, t, 'costs'),
        bookStrip(id, 'cards'),
        dbBanner(),
        tabCards(id, t),
        tourTabs(id, 'cards'));
    }
    if (view === 'daybyday') {
      return h('div', { class: 'page tour has-tabs exp-page' },
        tourBand(t, id, 'daybyday'),
        h('h1', { class: 'tour-title' }, 'Day by day'),
        bookStrip(id, 'costs'),
        dbBanner(),
        tabDays(id, t, c),
        tourTabs(id, 'costs'));
    }
    if (view === 'cashlog') {
      return h('div', { class: 'page tour has-tabs exp-page' },
        tourBand(t, id, 'cashlog'),
        h('h1', { class: 'tour-title' }, 'MERCH CASH LOG'),
        bookStrip(id, 'costs'),
        dbBanner(),
        cashLogBody(id, t),
        tourTabs(id, 'costs'));
    }
    var body = tabShows(id, t, c);

    return h('div', { class: 'page tour has-tabs budget-page' },
      tourBand(t, id, 'money'),
      payTabs(id, t, 'costs'),
      bookStrip(id, 'money'),
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
      h('div', { class: 'shows-panel' }, body),
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
    var quote = String(d.quote || '').trim();
    return [
      h('div', { class: 'ov-today' },
        // Top-left, level with the pencil on the right.
        buyoutAlertBtn(id, t),
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
      h('div', { class: 'cal-open' },
        h('button', { class: 'btn quiet sm glow', type: 'button',
          onclick: function () { go({ name: 'tour', id: id, view: 'calendar' }); } },
          icon('calendar', 16), 'View calendar')),

      (S.mode === 'db' && window.GR_BACKEND && window.GR_BACKEND.crew) ? crewSection(id) : null
    ];
  }

  /* The tour's phone book: who is on the run and how to reach them. */
  // Apple Maps on an iPhone; the same link opens a map anywhere else.
  function mapsHref(addr) {
    return 'https://maps.apple.com/?q=' + encodeURIComponent(String(addr).trim());
  }

  /* The crew list is remembered per tour, so the Overview redraws it
     straight away instead of flashing "Loading" every time anything else on
     the screen updates. It's asked for again at most once a minute, and only
     redrawn when someone actually changed. */
  function forgetCrew(tourId) {
    // Asked for again next time it's needed (who manages may have changed).
    if (S.crewAsk) { if (tourId) delete S.crewAsk[tourId]; else S.crewAsk = {}; }
    if (!S.crewCache) return;
    if (tourId) delete S.crewCache[tourId]; else S.crewCache = {};
  }

  /* The name column is sized to the widest name, so the badges stand in one
     straight column, centred in the gap before the contact icons. Shared by
     the Overview crew and the guest lists. */
  function sizeNameColumn(list, boxW) {
    var rowsEl = list.querySelectorAll('.crew-row');
    if (!rowsEl.length) return;
    var first = rowsEl[0];
    var cs = getComputedStyle(first);
    var content = first.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var cap = content - 6 - (boxW || 112) - 84; // row gap, badge box, mail + call with their gaps
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

  /* The Overview crew: the side columns (names, icons) share one width, the
     widest name's or the two icons', whichever is more, capped so the middle
     keeps room for a role. */
  function sizeCrewSides(list) {
    var rowsEl = list.querySelectorAll('.crew-row');
    if (!rowsEl.length) return;
    var first = rowsEl[0];
    var cs = getComputedStyle(first);
    var content = first.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var gap = 8, icons = 78, roleRoom = 92;
    var widest = 0;
    Array.prototype.forEach.call(rowsEl, function (r) {
      var lab = r.querySelector('.row-label');
      // With a photo: the photo, its gap, and the wider of the name and the line under it.
      var who = lab.querySelector('.crew-who'), pic = lab.querySelector('.crew-face');
      var extra = who && pic ? pic.getBoundingClientRect().width + 8 : 0;
      Array.prototype.forEach.call((who || lab).childNodes, function (n) {
        var rg = document.createRange();
        rg.selectNodeContents(n);
        var w = rg.getBoundingClientRect().width + extra;
        if (w > widest) widest = w;
      });
    });
    var cap = Math.floor((content - 2 * gap - roleRoom) / 2);
    if (!(cap > icons)) return;
    list.style.setProperty('--crew-side', Math.min(cap, Math.max(icons, Math.ceil(widest + 2))) + 'px');
    list.classList.add('sized');
  }

  function crewSection(tourId) {
    var B = window.GR_BACKEND;
    var owns = B.ownsTour && B.ownsTour(tourId);
    // The tour manager and ALL ACCESS can edit someone or kick them off.
    var manages = owns || tourRole(tourId) === 'editor';
    S.crewCache = S.crewCache || {};
    var cached = S.crewCache[tourId] || null;
    var faces = (S.mode === 'db' && B.facesFor && B.facesFor(tourId)) || {};
    var list = h('div', { class: 'ledger crew-list crew-sym' },
      cached ? null : h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Loading\u2026')));

    /* The badge column sits centred in the gap between the names and the
       icons: the name column is sized to the widest name (so the gap is the
       same in every row), and each badge box is centred in that gap with the
       badge flush left inside it — straight column, same starting point. */
    // Mirror image: the names' column and the icons' column are the same
    // width, so the role sits dead centre (under "Crew" and "Invite crew")
    // and just as far from the names as from the mail icon.
    function sizeColumns() { sizeCrewSides(list); }

    function draw(rows) {
      if (!rows.length) {
        list.replaceChildren(h('div', { class: 'row' },
          h('span', { class: 'hint' }, 'Nobody else on the run yet.')));
        return;
      }
      list.replaceChildren.apply(list, rows.map(function (m) {
        var row = crewRow(m);
        // The tour manager and ALL ACCESS, never on the Creator's row: swipe
        // left to edit someone or kick them off the tour.
        if (!manages || m.owner || !m.invitedEmail) return row;
        // A Manager is the creator's to edit or take off the tour.
        if (m.manager && !owns) return row;
        var who = m.name || m.username || m.email;
        return swipeable(row, null, who, { open: 196, cls: 'in-list kick', actions: [
          { text: 'Edit', cls: 'edit', onClick: function () { openCrewEdit(tourId, m); } },
          { text: 'Kick Off Tour', cls: 'kick', onClick: function () { kickOff(tourId, m.invitedEmail, who); } }
        ] });
      }));
      requestAnimationFrame(sizeColumns);
    }
    // What's new?, under Invite crew: the Creator sees it straight away; the
    // tour manager once the crew list says who they are.
    function crewRow(m) {
      var title = m.name || m.username || m.email;
      // Invited but no account yet: "Pending", and no contact buttons until
      // they sign up and their own card fills in.
      var pending = !m.joined;
      // Access sits under the name; the role is the green badge in the middle.
      var access = m.owner ? 'Creator' : m.manager ? 'Manager' : (m.role === 'editor' ? 'All Access' : 'GA');
      var canOpen = !pending && m.userId && socialOn();
      // Their profile photo beside the name (the first letter until they add one).
      var face = personPhoto({ name: title, avatar: (m.userId && faces[m.userId]) || '' }, 'xs crew-face');
      return h('div', { class: 'row crew-row' },
        h('div', { class: 'row-label crew-label' },
          canOpen ? h('button', { class: 'crew-face-btn', type: 'button', tabindex: '-1', 'aria-hidden': 'true',
            onclick: function () { openProfile(m.userId); } }, face) : face,
          h('div', { class: 'crew-who' },
            canOpen ? h('button', { class: 'crew-name', type: 'button', 'aria-label': 'Open ' + title + '\u2019s profile',
              onclick: function () { openProfile(m.userId); } }, title) : h('span', { class: 'crew-name' }, title),
            h('span', { class: 'hint crew-sub' }, access,
              pending ? h('span', { class: 'pending' }, ' \u00b7 Pending') : null))),
        h('div', { class: 'crew-side' },
          // Every badge sits in the same-width slot, so the roles line up in
          // one column; someone without a role just leaves the slot empty.
          h('span', { class: 'role-slot' },
            h('span', { class: 'role-box' },
              m.tourRole ? h('span', { class: 'role-tag aa' }, m.tourRole) : null)),
          // Fixed slots: a missing phone leaves an empty seat, so every mail
          // icon and every phone icon lines up in its own column.
          h('span', { class: 'crew-contact' },
            !pending && m.email ? h('a', { class: 'crew-call', href: 'mailto:' + String(m.email).trim(),
              'aria-label': 'Email ' + title }, icon('mail', 17))
              : h('span', { class: 'crew-call empty', 'aria-hidden': 'true' }),
            !pending && m.phone ? h('a', { class: 'crew-call', href: 'tel:' + String(m.phone).replace(/[^0-9+]/g, ''),
              'aria-label': 'Call ' + title }, icon('phone', 17))
              : h('span', { class: 'crew-call empty', 'aria-hidden': 'true' }))));
    }
    if (cached) draw(cached.rows);
    if (!cached || Date.now() - cached.at > 60e3) {
      B.crew(tourId).then(function (rows) {
        var same = !!cached && JSON.stringify(cached.rows) === JSON.stringify(rows);
        S.crewCache[tourId] = { rows: rows, at: Date.now() };
        if (!same) draw(rows);
      }).catch(function () {
        if (cached) return; // keep showing what we had
        list.replaceChildren(h('div', { class: 'row' },
          h('span', { class: 'hint' }, 'Couldn\u2019t load the crew.')));
      });
    }

    return [
      h('div', { class: 'sec-head', style: 'margin-top:30px;text-align:center' },
        h('h2', { class: 'sec-title hdr' }, 'Crew')),
      list,
      manages ? h('div', { style: 'display:flex;justify-content:center;margin-top:14px' },
        h('button', { class: 'crew-invite', type: 'button',
          onclick: function () { openInviteSheet(tourId); } },
          h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), 'Invite crew')) : null
    ];
  }

  /* ============================ NEW TOUR TASKS ============================
     For the tour manager: the Creator, and whoever's tour role is Tour
     Manager. Everything that wants a look, one card at a time, like a dating
     app: swipe right to handle it now (it takes you there), left to deal with
     it later. Anything new stays in the deck until it's swiped right; things
     still open (a request with no answer, money still to land) stay until
     they're done. The button glows green while something's new since you last
     looked, or on a new day with tasks still waiting, and greys out once
     you've looked. Each person's looks and "later" pile are their own, kept
     with their account. */
  function seenKey() {
    var B = window.GR_BACKEND;
    var uid = S.mode === 'db' && B && B.uid ? B.uid() : '';
    return 'gr-seen' + (uid ? ':' + uid : '');
  }
  function seenMap() {
    if (!S.seen) { try { S.seen = JSON.parse(lsGet(seenKey()) || '{}') || {}; } catch (e) { S.seen = {}; } }
    return S.seen;
  }
  // at: when you last looked. held: new things seen but not decided yet.
  // later: swiped left. done: swiped right (handled), never shown again.
  function seenShape(v) {
    if (typeof v === 'number') v = { at: v };
    if (!G.isObj(v)) v = {};
    var obj = function (x) { return G.isObj(x) ? x : {}; };
    return { at: G.num(v.at), held: obj(v.held), later: obj(v.later), done: obj(v.done) };
  }
  function wnKey(tourId) { return 'seen-wn-' + tourId; }
  function seenRec(tourId) { return seenShape(seenMap()[wnKey(tourId)]); }
  function saveSeen(tourId, rec) {
    // Two months is plenty to remember a decision.
    var old = Date.now() - 60 * 864e5;
    ['held', 'later', 'done'].forEach(function (k) {
      Object.keys(rec[k]).forEach(function (key) { if (G.num(rec[k][key]) < old) delete rec[k][key]; });
    });
    seenMap()[wnKey(tourId)] = rec;
    lsSet(seenKey(), JSON.stringify(S.seen));
    if (S.mode === 'db' && store.db) {
      Promise.resolve(store.db.doc('labels/' + wnKey(tourId)).set({ kind: 'seen', at: rec.at, held: rec.held, later: rec.later, done: rec.done }))
        .catch(function () { /* this phone still remembers */ });
    }
  }
  /* The tour's managers: the creator, and anyone the creator made a Manager
     (All Access plus the card refresh, the polls, Ari's questions, alerts
     and New tour tasks). Read from the crew list, asked once per tour. */
  function isMe(m) {
    var B = window.GR_BACKEND;
    var uid = B && B.uid ? B.uid() : null, me = String((B && B.email && B.email()) || '').trim().toLowerCase();
    if (uid && m.userId) return m.userId === uid;
    return !!me && [m.email, m.invitedEmail].some(function (e) { return String(e || '').trim().toLowerCase() === me; });
  }
  function moneyLead(tourId) {
    var B = window.GR_BACKEND;
    if (S.mode !== 'db') return true;
    if (B && B.ownsTour && B.ownsTour(tourId)) return true;
    var cached = S.crewCache && S.crewCache[tourId];
    if (!cached) {
      S.crewCache = S.crewCache || {};
      S.crewAsk = S.crewAsk || {};
      if (!S.crewAsk[tourId] && B && B.crew) {
        S.crewAsk[tourId] = true;
        B.crew(tourId).then(function (rows) { S.crewCache[tourId] = { rows: rows, at: Date.now() }; render(true); })
          .catch(function () { delete S.crewAsk[tourId]; /* asked again next time */ });
      }
      return false;
    }
    return cached.rows.some(function (m) { return !m.owner && m.role === 'editor' && m.manager && isMe(m); });
  }
  /* A band's Off Tour book has no crew of its own: a Manager on any of the
     band's tours manages it, the same as the database says. */
  function bookLead(tourId) {
    var t = getTour(tourId);
    if (t && isOffTour(t)) {
      var B = window.GR_BACKEND;
      if (S.mode !== 'db' || (B && B.ownsTour && B.ownsTour(tourId))) return true;
      return bandTours(artistOf(t)).some(function (e) { return moneyLead(e[0]); });
    }
    return moneyLead(tourId);
  }
  /* The card feed (undo a charge, the pile, Refresh) and the alert siren are
     still checked by the server the old way: a Manager there also needs the
     tour role "Tour Manager". Shown only when the server will say yes. */
  function serverLead(tourId) {
    var B = window.GR_BACKEND;
    if (S.mode !== 'db' || (B && B.ownsTour && B.ownsTour(tourId))) return true;
    var t = getTour(tourId), ids = t && isOffTour(t) ? bandTours(artistOf(t)).map(function (e) { return e[0]; }) : [tourId];
    return ids.some(function (x) {
      var c = S.crewCache && S.crewCache[x];
      if (!c) { moneyLead(x); return false; }
      return c.rows.some(function (m) {
        return !m.owner && m.role === 'editor' && m.manager && isMe(m) && /^\s*tour manager\s*$/i.test(String(m.tourRole || ''));
      });
    });
  }
  function managesTour(tourId) { return moneyLead(tourId); }

  // Every task on the tour right now, most pressing first. `open` goes there.
  function tourTasks(tourId, rec) {
    var t = getTour(tourId) || {};
    var B = window.GR_BACKEND, live = S.mode === 'db' && B;
    var now = Date.now(), since = rec.at, week = now - 7 * 864e5;
    var shows = G.rows(t.shows).filter(function (x) { return G.parseDay(x.date); }).sort(G.byDate);
    var byDate = {};
    shows.forEach(function (x) { byDate[x.date] = x; });
    var imps = G.isObj(t.imports) ? t.imports : {};
    var when = function (v) { return typeof v === 'number' ? v : Date.parse(v) || 0; };
    var place = function (x) { return dayMD(x.date) + ' · ' + (String(x.city || '').split(',')[0] || x.venue || 'Show'); };
    var view = function (v) { return function () { go({ name: 'tour', id: tourId, view: v }); }; };
    var onDay = function (v, date) {
      return function () {
        var got = overviewDays(getTour(tourId));
        var i = got ? got.days.map(function (x) { return x.date; }).indexOf(date) : -1;
        if (i >= 0) { S.dsIndex = i; S.dsTour = tourId; }
        go({ name: 'tour', id: tourId, view: v });
      };
    };
    // Something new: in the deck while it's new, or until it's swiped right.
    var pending = function (key, at) {
      return !rec.done[key] && at > week && (at > since || !!rec.held[key] || !!rec.later[key]);
    };
    // A night's money opens that night's income log.
    var incomeLog = function (showId) {
      return canEditTour(tourId) ? function () { openIncome(tourId, showId); } : view('money');
    };
    var tasks = [];

    // Ari's questions, waiting on the tour manager.
    var asks = live && B.asksFor ? B.asksFor(tourId) : [];
    asks.filter(function (a) { return a.status === 'open'; }).forEach(function (a) {
      tasks.push({ key: 'ask:' + a.id, standing: true, at: when(a.at), emoji: '🤖', title: 'Ari needs an answer',
        main: a.place + ' merch', sub: 'Logged ' + G.moneyCents(a.was) + ' · the settlement says ' + G.moneyCents(a.fix),
        open: function () { openAriSheet(tourId); } });
    });
    // Special requests: waiting on an answer, or answered since you looked.
    if (live && B.requestsFor) shows.forEach(function (x) {
      B.requestsFor(tourId, x.date).forEach(function (r) {
        var at = when(r.at), open = r.status === 'pending', key = 'req:' + r.id;
        if (!open && !pending(key, at)) return;
        tasks.push({ key: key, standing: open, at: at, emoji: '🙋', title: 'Special request', main: r.body,
          sub: [place(x), r.author, open ? 'Waiting for an answer' : r.status === 'accepted' ? 'Accepted' : 'Denied'].filter(Boolean).join(' · '),
          open: function () { openRequests(tourId, x); } });
      });
    });
    // New expenses: what was logged, whoever sorted it, for both of you to see.
    var cats = {};
    G.chargeCategoriesFor(t).forEach(function (c) { cats[c.key] = c.label; });
    var fresh = [];
    G.rows(t.charges).forEach(function (ch) {
      var im = ch.importId ? imps[ch.importId] : null;
      var at = G.num(ch.createdAt) || G.num(im && im.createdAt);
      if (!ch.accounted && G.num(ch.amount) !== 0 && pending('exp:' + ch.id, at)) fresh.push({ ch: ch, at: at });
    });
    if (fresh.length) {
      fresh.sort(function (a, b) { return String(a.ch.date).localeCompare(String(b.ch.date)); });
      var total = fresh.reduce(function (n, x) { return n + G.num(x.ch.amount); }, 0);
      var by = [];
      fresh.forEach(function (x) { var w = x.ch.by || (x.ch.manual ? '' : 'the card feed'); if (w && by.indexOf(w) < 0) by.push(w); });
      tasks.push({ key: 'exp', keys: fresh.map(function (x) { return 'exp:' + x.ch.id; }),
        at: Math.max.apply(null, fresh.map(function (x) { return x.at; })), emoji: '🧾', title: 'New expenses',
        main: plural(fresh.length, 'charge') + ' logged', amount: total,
        sub: by.length ? 'Sorted by ' + by.join(' and ') : null,
        lines: fresh.slice(0, 4).map(function (x) {
          return (x.ch.merchant || 'Charge') + ' · ' + (cats[x.ch.category] || 'Not sorted') + ' · ' + G.moneyCents(x.ch.amount);
        }).concat(fresh.length > 4 ? ['+ ' + (fresh.length - 4) + ' more'] : []),
        open: function () { openNewCharges(tourId, fresh.map(function (x) { return x.ch; })); } });
    }
    // Merch the mailbox logged on its own (a night Ari is still asking about
    // is her card instead).
    Object.keys(imps).forEach(function (k) {
      var im = imps[k], date = (k.match(/^em-(\d{4}-\d{2}-\d{2})-/) || [])[1], x = date && byDate[date];
      if (!x || !im || im.source !== 'atVenu email' || !pending('merch:' + k, G.num(im.createdAt))) return;
      var ask = asks.filter(function (a) { return a.showId === x.id; }).pop();
      if (ask && ask.status === 'open') return;
      var logged = G.num(x.income && x.income.merch);
      if (!(Math.abs(logged - G.num(im.total)) < 0.01 || (ask && ask.status === 'fixed'))) return;
      tasks.push({ key: 'merch:' + k, at: G.num(im.createdAt), emoji: '💰', title: 'Merch logged automatically',
        main: place(x), amount: logged, sub: 'From the atVenu settlement', open: incomeLog(x.id) });
    });
    // Money a show still owes the band.
    shows.forEach(function (x) {
      // A guarantee that came in short with nobody having said why yet.
      var gap = x.loggedAt && x.guaranteePaidBy !== 'agency' && x.guaranteeReceived !== false ? G.guaranteeGap(x) : null;
      if (gap && gap.deposit != null && gap.unexplained >= 1) tasks.push({ key: 'inc:' + x.id + ':gs:' + gap.deposit, standing: true, at: 0,
        emoji: '\ud83e\uddfe', title: 'Guarantee came in short', main: money(gap.deposit) + ' deposited of ' + money(gap.total),
        amount: gap.unexplained, sub: place(x) + ' \u00b7 say why', open: incomeLog(x.id) });
      var st = G.showMoneyState(x);
      if (st !== 'owed') return;
      var g = G.num(x.income && x.income.guarantee), md = G.merchDue(x);
      if (g > 0 && x.guaranteeReceived === false) tasks.push({ key: 'inc:' + x.id + ':g', standing: true, at: 0,
        emoji: '⏳', title: 'Income not received yet', main: 'Guarantee', amount: g, sub: place(x), open: incomeLog(x.id) });
      // Deposited short, with the rest still owed by the promoter.
      else if (G.guaranteeOwed(x) > 0) tasks.push({ key: 'inc:' + x.id + ':go', standing: true, at: 0,
        emoji: '\u23f3', title: 'Income not received yet', main: 'Rest of the guarantee', amount: G.guaranteeOwed(x),
        sub: place(x), open: incomeLog(x.id) });
      if (md > 0 && x.merchReceived === false) tasks.push({ key: 'inc:' + x.id + ':m', standing: true, at: 0,
        emoji: '⏳', title: 'Income not received yet', main: 'Merch deposit', amount: md, sub: place(x), open: incomeLog(x.id) });
    });
    // Merch cash still not accounted for.
    var cs = G.cashSummary(t);
    if (cs.took > 0 && cs.left > 0.004) tasks.push({ key: 'cash', standing: true, at: 0, emoji: '💵', title: 'Merch cash',
      main: 'Not accounted for yet', amount: cs.left, sub: 'Square it up in the Merch cash log', open: view('cashlog') });
    // Days off still ahead with no poll, while there's time to vote.
    var got = overviewDays(t);
    if (got && shows.length && live && B.pollFor) {
      var first = shows[0].date, last = shows[shows.length - 1].date;
      got.days.forEach(function (x) {
        if (x.show || x.date < first || x.date > last || isRehearsalDay(t, x.date)) return;
        if (pollCloses(x.date).getTime() <= now || B.pollFor(tourId, x.date)) return;
        tasks.push({ key: 'poll:' + x.date, standing: true, at: 0, emoji: '🗳️', title: 'Day off with no poll',
          main: dayLong(x.date), sub: 'Voting closes noon the day before',
          open: moneyLead(tourId) ? function () { openPollEditor(tourId, x.date, null); } : view('calendar') });
      });
    }
    // New names on the guest list, a card per night.
    shows.forEach(function (x) {
      var names = [], keys = [], newest = 0;
      guestsFor(t, tourId, x.id).forEach(function (g) {
        var at = when(g.at || g.createdAt);
        if (!pending('guest:' + g.id, at)) return;
        names.push([g.firstName, g.lastName].filter(Boolean).join(' ') + (G.num(g.qty) > 1 ? ' +' + (G.num(g.qty) - 1) : ''));
        keys.push('guest:' + g.id);
        newest = Math.max(newest, at);
      });
      if (keys.length) tasks.push({ key: 'guests:' + x.id, keys: keys, at: newest, emoji: '🎟️',
        title: 'New on the guest list', main: names.join(', '), sub: place(x), open: onDay('guests', x.date) });
    });
    // Not this tour's, but yours: tours to confirm with an artist that endorsed
    // you, and (for an artist page you run) credits waiting on your yes.
    if (creditsOn()) {
      (creditAsks().list || []).forEach(function (a) {
        if (a.state !== 'ask' && a.state !== 'declined') return;
        var stamp = a.declinedAt || a.at || '';
        tasks.push({ key: 'credit:' + a.artistId + ':' + stamp, standing: true, at: when(stamp), emoji: TROPHY, title: 'Tour credits',
          main: 'Confirm the shows and tours you\u2019ve done with ' + a.artist,
          sub: a.state === 'declined' ? 'Sent back \u2014 fix it and send it again' : a.artist + ' endorsed you',
          open: function () { openCreditClaim(a.artistId); } });
      });
      (creditQueue().list || []).forEach(function (x) {
        tasks.push({ key: 'creditq:' + x.artistId + ':' + x.userId + ':' + (x.submittedAt || ''), standing: true, at: when(x.submittedAt),
          emoji: '\u2705', title: 'Tour credits to approve', main: (x.name || 'Someone') + ' \u00b7 ' + x.artist,
          sub: (x.all ? 'All tours \u00b7 ' : '') + tallyText(x), open: function () { openCreditReview(x); } });
      });
    }
    // For a Greenroom admin: people asking to run an artist's page.
    (claimQ().list || []).forEach(function (x) {
      tasks.push({ key: 'claim:' + x.id + ':' + (x.at || ''), standing: true, at: when(x.at), emoji: '\ud83c\udfa4', title: 'Page claim',
        main: (x.name || 'Someone') + ' \u00b7 ' + x.artist, sub: 'Asking to run the page', open: function () { openClaimReview(x); } });
    });
    tasks.forEach(function (c) { c.keys = c.keys || [c.key]; c.fresh = c.at > since; });
    // Handled is handled. Then the ones you haven't decided on, in order;
    // then the ones you put off, oldest "later" first.
    tasks = tasks.filter(function (c) { return !c.keys.every(function (k) { return rec.done[k]; }); });
    var laterAt = function (c) { return Math.max.apply(null, c.keys.map(function (k) { return G.num(rec.later[k]); })); };
    var undecided = tasks.filter(function (c) { return !(laterAt(c) > 0); });
    var put = tasks.filter(function (c) { return laterAt(c) > 0; }).sort(function (a, b) { return laterAt(a) - laterAt(b); });
    return undecided.concat(put);
  }
  function taskState(tourId) {
    var rec = seenRec(tourId), tasks = tourTasks(tourId, rec);
    var fresh = tasks.filter(function (c) { return c.fresh; }).length;
    // Green while something's new, or on a new day with tasks still waiting.
    var glow = fresh > 0 || (tasks.length > 0 && (!rec.at || G.ymd(new Date(rec.at)) < G.ymd(new Date())));
    return { tasks: tasks, fresh: fresh, glow: glow };
  }

  /* The deck: one task at a time. Right (or "Handle now") goes there; left
     (or "Later") keeps it for later. Arrow keys work too. */
  function openTaskDeck(tourId) {
    var rec = seenRec(tourId);
    var tasks = tourTasks(tourId, rec);
    // Everything new waits in the deck until you decide on it.
    tasks.forEach(function (c) {
      if (!c.standing) c.keys.forEach(function (k) { if (!rec.later[k]) rec.held[k] = c.at || Date.now(); });
    });
    rec.at = Date.now();
    saveSeen(tourId, rec);
    var decided = function (c, how) {
      var r2 = seenRec(tourId), now = Date.now();
      c.keys.forEach(function (k) {
        delete r2.held[k];
        if (how === 'done') { delete r2.later[k]; r2.done[k] = now; } else r2.later[k] = now;
      });
      saveSeen(tourId, r2);
    };

    var i = 0, deferred = 0, busy = false;
    var count = h('span', { class: 'dk-count' });
    var stage = h('div', { class: 'dk-stage' });
    var acts = h('div', { class: 'dk-acts' },
      h('button', { class: 'dk-act later', type: 'button', onclick: function () { decide(-1); } },
        h('span', { class: 'dk-ico', 'aria-hidden': 'true' }, '✕'), 'Later'),
      h('button', { class: 'dk-act now', type: 'button', onclick: function () { decide(1); } },
        h('span', { class: 'dk-ico', 'aria-hidden': 'true' }, '✓'), 'Handle now'));
    var hint = h('p', { class: 'dk-hint' }, 'Swipe right to handle it now · left for later');
    var root = h('div', { class: 'deck', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'New tour tasks', tabindex: '-1' },
      h('div', { class: 'dk-top' },
        h('button', { class: 'linkbtn dk-list', type: 'button', onclick: function () { close(); setTimeout(function () { openTaskList(tourId); }, 260); } }, 'List'),
        h('div', { class: 'dk-head' }, h('span', { class: 'dk-title' }, 'NEW TOUR TASKS'), count),
        h('button', { class: 'iconbtn dk-x', type: 'button', 'aria-label': 'Close', onclick: function () { close(); } }, icon('close'))),
      stage, acts, hint);
    function close() {
      document.removeEventListener('keydown', onKey);
      root.classList.remove('on');
      document.body.classList.remove('locked');
      setTimeout(function () { root.remove(); }, 260);
      render(true);
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight' && i < tasks.length) decide(1);
      else if (e.key === 'ArrowLeft' && i < tasks.length) decide(-1);
    }
    function cardEl(c, back) {
      return h('div', { class: 'dk-card' + (back ? ' back' : '') },
        back ? null : [h('span', { class: 'dk-stamp now', 'aria-hidden': 'true' }, 'HANDLE NOW'),
          h('span', { class: 'dk-stamp later', 'aria-hidden': 'true' }, 'LATER')],
        h('div', { class: 'dk-emoji', 'aria-hidden': 'true' }, c.emoji),
        h('div', { class: 'dk-kind' }, c.title, c.fresh ? h('span', { class: 'wn-new' }, 'New') : null),
        h('div', { class: 'dk-main' }, c.main),
        c.amount != null ? h('div', { class: 'dk-amt num' }, G.moneyCents(c.amount)) : null,
        c.sub ? h('div', { class: 'dk-sub' }, c.sub) : null,
        c.lines && c.lines.length ? h('ul', { class: 'dk-lines' }, c.lines.map(function (l) { return h('li', null, l); })) : null);
    }
    function show() {
      busy = false;
      stage.replaceChildren();
      if (i >= tasks.length) {
        count.textContent = '';
        acts.hidden = true; hint.hidden = true;
        stage.append(h('div', { class: 'dk-card dk-end' },
          h('div', { class: 'dk-emoji', 'aria-hidden': 'true' }, '🤘'),
          h('div', { class: 'dk-main' }, tasks.length ? 'That’s everything' : 'All caught up'),
          h('div', { class: 'dk-sub' }, deferred ? plural(deferred, 'task') + ' saved for later. They’ll be here next time.'
            : 'Nothing waiting on you.'),
          h('div', { class: 'stack' },
            tasks.length ? h('button', { class: 'btn quiet block', type: 'button',
              onclick: function () { close(); setTimeout(function () { openTaskList(tourId); }, 260); } }, 'See the full list') : null,
            h('button', { class: 'btn primary block', type: 'button', onclick: function () { close(); } }, 'Done'))));
        return;
      }
      count.textContent = (i + 1) + ' of ' + tasks.length;
      if (tasks[i + 1]) stage.append(cardEl(tasks[i + 1], true));
      var top = cardEl(tasks[i], false);
      stage.append(top);
      drag(top);
    }
    function decide(dir) {
      if (busy || i >= tasks.length) return;
      busy = true;
      var c = tasks[i];
      var top = stage.querySelector('.dk-card:not(.back)');
      if (top) {
        top.style.transition = 'transform .28s ease, opacity .28s ease';
        top.style.transform = 'translateX(' + (dir * 140) + '%) rotate(' + (dir * 16) + 'deg)';
        top.style.opacity = '0';
      }
      if (dir > 0) {
        // Handled: gone from the deck for good, and off to it.
        decided(c, 'done');
        setTimeout(function () { close(); setTimeout(c.open, 280); }, 240);
      } else {
        decided(c, 'later');
        deferred += 1; i += 1;
        setTimeout(show, 260);
      }
    }
    function drag(el) {
      var x0 = null, dx = 0;
      el.addEventListener('pointerdown', function (e) {
        if (busy) return;
        x0 = e.clientX; dx = 0;
        try { el.setPointerCapture(e.pointerId); } catch (x) { /* fine */ }
        el.style.transition = 'none';
      });
      el.addEventListener('pointermove', function (e) {
        if (x0 == null) return;
        dx = e.clientX - x0;
        el.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 20) + 'deg)';
        el.style.setProperty('--now', String(Math.max(0, Math.min(1, dx / 90))));
        el.style.setProperty('--later', String(Math.max(0, Math.min(1, -dx / 90))));
      });
      var up = function () {
        if (x0 == null) return;
        x0 = null;
        if (dx > 90) decide(1);
        else if (dx < -90) decide(-1);
        else {
          el.style.transition = 'transform .25s ease';
          el.style.transform = '';
          el.style.setProperty('--now', '0');
          el.style.setProperty('--later', '0');
        }
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
    document.body.appendChild(root);
    document.body.classList.add('locked');
    document.addEventListener('keydown', onKey);
    show();
    requestAnimationFrame(function () { root.classList.add('on'); root.focus({ preventScroll: true }); });
  }

  // The same tasks as a plain list, grouped, for a look at everything at once.
  function openTaskList(tourId) {
    var tasks = tourTasks(tourId, seenRec(tourId));
    var groups = [], byTitle = {};
    tasks.forEach(function (c) {
      if (!byTitle[c.title]) { byTitle[c.title] = { emoji: c.emoji, title: c.title, list: [] }; groups.push(byTitle[c.title]); }
      byTitle[c.title].list.push(c);
    });
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'New tour tasks'),
        h('p', { class: 'sh-sub' }, tasks.length ? plural(tasks.length, 'task') + ' · tap one to handle it' : 'All caught up'),
        groups.map(function (g) {
          return h('section', { class: 'wn-sec' },
            h('h3', { class: 'wn-h' }, h('span', { 'aria-hidden': 'true' }, g.emoji), g.title),
            h('div', { class: 'ledger' }, g.list.map(function (c) {
              return h('button', { class: 'row wn-row', type: 'button', onclick: function () {
                var r2 = seenRec(tourId), now = Date.now();
                c.keys.forEach(function (k) { delete r2.held[k]; delete r2.later[k]; r2.done[k] = now; });
                saveSeen(tourId, r2);
                closeSheet(); setTimeout(c.open, 320);
              } },
                h('span', { class: 'row-label' }, c.main, c.fresh ? h('span', { class: 'wn-new' }, 'New') : null,
                  c.sub ? h('span', { class: 'hint' }, c.sub) : null),
                c.amount != null ? h('span', { class: 'amt num' }, G.moneyCents(c.amount)) : null);
            })));
        }),
        tasks.length ? null : h('p', { class: 'note wn-clear' }, 'Nothing waiting on you 🤘')
      ];
    }, { label: 'New tour tasks', onClose: function () { render(true); } });
  }

  // What was logged: every new charge, how it was paid and who sorted it.
  function openNewCharges(tourId, list) {
    var t = getTour(tourId) || {};
    var cats = {};
    G.chargeCategoriesFor(t).forEach(function (c) { cats[c.key] = c.label; });
    var total = list.reduce(function (n, ch) { return n + G.num(ch.amount); }, 0);
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'New expenses'),
        h('p', { class: 'sh-sub' }, plural(list.length, 'charge') + ' · ' + G.moneyCents(total) + ' · oldest first'),
        h('div', { class: 'ledger' }, list.map(function (ch) {
          return h('div', { class: 'row' },
            h('div', { class: 'row-label' }, ch.merchant || 'Charge',
              h('span', { class: 'hint' }, [dayMD(ch.date), cats[ch.category] || 'Not sorted', ch.account || (ch.manual ? 'Logged by hand' : ''),
                ch.cash ? 'Cash' : ch.paid ? 'Debit' : 'Credit', ch.by ? 'sorted by ' + ch.by : ''].filter(Boolean).join(' · '))),
            h('span', { class: 'src-tag src-' + chargeSource(t, ch).toLowerCase() }, chargeSource(t, ch)),
            h('span', { class: 'amt num' }, G.moneyCents(ch.amount)));
        })),
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary block', type: 'button',
            onclick: function () { closeSheet(); setTimeout(function () { go({ name: 'tour', id: tourId, view: 'costs' }); }, 320); } },
            'Open Expenses'))
      ];
    }, { label: 'New expenses', cls: 'cat-sheet' });
  }

  function kickOff(tourId, email, who) {
    var t = getTour(tourId);
    confirmSheet({
      title: 'Kick ' + who + ' off the tour?',
      body: 'They lose access to ' + ((t && t.name) || 'this tour') + ' right away. You can invite them again any time.',
      action: 'Kick Off Tour', danger: true,
      onConfirm: async function () {
        try {
          var BK = window.GR_BACKEND;
          await (BK.kickMember ? BK.kickMember(tourId, email) : BK.uninvite(tourId, email));
          forgetCrew(tourId);
          toast(who + ' is off the tour');
          return true;
        } catch (e) { toast('Couldn\u2019t do that. Try again.'); return false; }
      }
    });
  }

  /* Edit someone on the crew: their role on the tour, how to reach them, and
     their access. Their login email never changes here. */
  function openCrewEdit(tourId, m) {
    var who = m.name || m.username || m.email;
    var base = m.base || { tourRole: '', phone: '', email: m.invitedEmail };
    var f = { tourRole: m.tourRole || '', phone: m.phone || '', email: m.email || '', access: m.manager ? 'manager' : (m.role === 'editor' ? 'editor' : 'viewer') };
    var levels = createdTour(tourId) ? ['viewer', 'editor', 'manager'] : ['viewer', 'editor'];
    openSheet(function () {
      var submit = async function (e) {
        e.preventDefault();
        blurActive();
        // Only what differs from their own card is kept as an edit.
        var ov = {};
        ['tourRole', 'phone', 'email'].forEach(function (k) {
          var v = String(f[k] || '').trim();
          if (v && v !== String(base[k] || '').trim()) ov[k] = v;
        });
        try {
          await window.GR_BACKEND.editMember(tourId, m.invitedEmail, f.access, ov);
        } catch (x) { saveFailed('crew edit', x); return; }
        forgetCrew(tourId);
        closeSheet(); toast(who + ' updated'); render(true);
      };
      return [
        h('h2', { class: 'sh-title' }, who),
        h('p', { class: 'sh-sub' }, 'Their login stays ' + m.invitedEmail + '.'),
        h('form', { class: 'sh-form', onsubmit: submit, novalidate: true },
          field('Role', h('input', { class: 'input', type: 'text', value: f.tourRole, maxlength: 40, autocomplete: 'off',
            placeholder: 'Role', oninput: function (e) { f.tourRole = e.target.value; } })),
          field('Phone number', h('input', { class: 'input', type: 'tel', value: f.phone, maxlength: 40, autocomplete: 'off',
            placeholder: 'Phone number', oninput: function (e) { f.phone = e.target.value; } })),
          field('Email', h('input', { class: 'input', type: 'email', value: f.email, maxlength: 120, autocomplete: 'off',
            placeholder: 'Email', oninput: function (e) { f.email = e.target.value; } })),
          h('h3', { class: 'sh-h3' }, 'Access'),
          segmented(['GA', 'ALL ACCESS', 'MANAGER'].slice(0, levels.length), Math.max(0, levels.indexOf(f.access)), function (i) { f.access = levels[i]; }, 'Access'),
          h('p', { class: 'note' }, 'GA sees the shows, day sheets and guest list. ALL ACCESS also sees the money, and can edit or kick crew. ' +
            'MANAGER is ALL ACCESS plus the card refresh, the polls and New tour tasks; only the tour\u2019s creator makes someone a Manager.'),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Save'),
            h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel')))
      ];
    }, { label: 'Edit ' + who });
  }

  /* Inviting is its own sheet now — the Overview keeps one small button. */
  function openInviteSheet(tourId) {
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'Invite crew'),
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
    return { n: n, last: today === dates[dates.length - 1] };
  }
  function offCounter(t) {
    var c = daysUntilOff(t);
    if (!c) return null;
    // Tonight's the only show before a break: just "Day off tomorrow"
    // (or, on the run's final night, "Last show tonight").
    var pair = c.off ? ['Day off', 'today'] : c.n === 1 ? (c.last ? ['Last show', 'tonight'] : ['Day off', 'tomorrow']) : null;
    return h('div', { class: 'off-count', 'aria-label': pair ? pair.join(' ') : c.n + ' shows until day off' },
      pair ? [h('b', null, pair[0]), h('span', { class: 'oc-2' }, pair[1])]
        : [h('b', { class: 'num' }, String(c.n)), h('span', { class: 'oc-2' }, 'shows until day off')]);
  }

  function viewTourDay(id, t, view) {
    // A tour with a lineup but no "which band are you" yet asks once, so
    // Ari knows whose set is SHOW TIME.
    if (view === 'details' && canEditTour(id) && tourBands(t).length && !ourBand(t)) {
      S.bandAsked = S.bandAsked || {};
      if (!S.bandAsked[id]) {
        S.bandAsked[id] = true;
        setTimeout(function () {
          var here = S.route && S.route.name === 'tour' && S.route.id === id;
          if (here && !document.querySelector('#sheet-root .sheet')) openOurBandSheet(id);
          else if (!here) S.bandAsked[id] = false; // left before it could ask: next visit
        }, 700);
      }
    }
    if (view === 'details') {
      return h('div', { class: 'page tour has-tabs' },
        tourBand(t, id, view),
        h('div', { class: 'title-row' },
          h('h1', { class: 'tour-title' }, t.name || 'Untitled tour'),
          offCounter(t)),
        dbBanner(),
        overviewBody(id, t),
        tourTabs(id, view));
    }
    return h('div', { class: 'page tour has-tabs' + (view === 'guests' ? ' guest-page' : ' ds-page') },
      tourBand(t, id, view),
      h('h1', { class: 'tour-title' }, t.name || 'Untitled tour'),
      dbBanner(),
      view === 'guests' ? guestsBody(id, t) : detailsBody(id, t, 'sheet'),
      tourTabs(id, view));
  }

  /* Guest list tab: tonight's list up front, any other night one tap away. */
  // A night's guests as rows, by last name; yours (or anyone's, for the tour manager) come off with a tap.
  function guestRowsFor(id, s, list, backend, myUid, refresh) {
    return list.slice().sort(function (a, b) {
      return String(a.lastName || '').localeCompare(String(b.lastName || '')) ||
        String(a.firstName || '').localeCompare(String(b.firstName || ''));
    }).map(function (g) {
      var mine = !backend || (g.addedBy && g.addedBy === myUid);
      return guestRow(g, { canManage: canEditTour(id) || mine,
        onRemove: async function () { await removeGuest(id, s.id, g.id); refresh(); } });
    });
  }
  // Send the night's list straight to the promoter: Messages or Mail opens
  // with the whole list already written; the manager picks who it goes to.
  function guestSendRow(id, t, s, list) {
    if (!list.length) return null;
    var copyBtn = null;
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
    return copyBtn;
  }

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

    var rowsOut = guestRowsFor(id, s, list, backend, myUid, refresh);
    var copyBtn = guestSendRow(id, t, s, list);

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
        h('h2', { class: 'sec-title hdr' }, 'Guest List')),
      h('p', { class: 'note', style: 'margin:0 2px 2px;text-align:center' },
        [String(s.city || '').trim(), String(s.venue || '').trim()].filter(Boolean).join(' · ') +
        (sum.names ? ' · ' + plural(sum.names, 'name') + ' · ' + plural(sum.tickets, 'ticket') : '')),
      rowsOut.length
        ? guestLedger(rowsOut)
        : h('div', { style: 'min-height:60px' }),
      copyBtn,
      h('div', { class: 'gl-dock' },
        rail,
        h('div', { class: 'gl-dock-btns' },
          // The night on screen is the night the guest is for: no picker.
          h('button', { class: 'add-mini', type: 'button',
            onclick: function () { openGuestForm(id, s.id, s, backend, function () { closeSheet(); refresh(); }); } },
            h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), 'Add guest'),
          h('button', { class: 'add-mini', type: 'button',
            onclick: function () { openGuestImport(id, s.id, s, backend, function () { closeSheet(); refresh(); }); } },
            h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), 'Import List')))
    ];
  }

  /* A guest, laid out like the Overview crew: the name on the left, the pass
     lit up in the middle, then mail and phone. Tap the name to take them off. */
  function guestRow(g, o) {
    var name = [g.firstName, g.lastName].map(function (x) { return String(x || '').trim(); })
      .filter(Boolean).join(' ') || 'Guest';
    var q = Math.max(1, Math.min(20, G.num(g.qty) || 1));
    var pass = (q > 1 ? '+' + (q - 1) + ' \u00b7 ' : '') + (g.passType || 'GA');
    var email = String(g.email || '').trim(), phone = String(g.phone || '').trim();
    var aff = String(g.affiliation || '').trim();
    var inner = [name, aff ? h('span', { class: 'hint crew-sub' }, aff) : null];
    var label = o.canManage
      ? h('button', { class: 'row-label gl-name', type: 'button', 'aria-label': name + ', ' + pass + '. Tap to remove',
          onclick: function () {
            confirmSheet({
              title: 'Take ' + name + ' off the list?',
              body: pass + (aff ? ' \u00b7 ' + aff : ''),
              action: 'Remove', danger: true,
              onConfirm: async function () {
                try { await o.onRemove(); toast('Off the list'); return true; }
                catch (e) { toast('Only the tour manager can remove someone else\u2019s guest.'); return false; }
              }
            });
          } }, inner)
      : h('div', { class: 'row-label' }, inner);
    return h('div', { class: 'row crew-row' }, label,
      h('div', { class: 'crew-side' },
        h('span', { class: 'role-slot' },
          h('span', { class: 'role-box' },
            h('span', { class: 'role-tag' + (g.passType === 'All Access' ? ' aa' : '') }, pass.toUpperCase()))),
        email ? h('a', { class: 'crew-call', href: 'mailto:' + email, 'aria-label': 'Email ' + name }, icon('mail', 17))
          : h('span', { class: 'crew-call empty', 'aria-hidden': 'true' }),
        phone ? h('a', { class: 'crew-call', href: 'tel:' + phone.replace(/[^0-9+]/g, ''), 'aria-label': 'Call ' + name }, icon('phone', 17))
          : h('span', { class: 'crew-call empty', 'aria-hidden': 'true' })));
  }
  function guestLedger(rows) {
    var el = h('div', { class: 'ledger crew-list guest-rows' }, rows);
    requestAnimationFrame(function () { sizeNameColumn(el); });
    return el;
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
    // Only the nights income is logged for: no rehearsal, travel or off days.
    // Dated shows in order; undated holds keep their place at the end.
    var rowsOut = shows.filter(function (s) { return G.parseDay(s.date); }).sort(G.byDate)
      .concat(shows.filter(function (s) { return !G.parseDay(s.date); }))
      .map(function (s) { return showRow(id, s, today); });
    return [
      tonight ? tonightCard(id, tonight) : null,
      shows.length
        ? [h('p', { class: 'count-line' }, logged + ' of ' + plural(shows.length, 'show') + ' logged'),
           h('ul', { class: 'shows' }, rowsOut)]
        : emptyState('No shows yet', canWrite()
            ? 'Add each date and city as they get confirmed.'
            : 'No dates have been added.'),
      otherIncomeList(id, c)
    ];
  }

  /* Income on the book itself, under the nights: royalties, an advance, a
     payout that belongs to no one show — catalogued from the Cards tab. It
     counts in the tour's income; a tap can take a wrong one off the book
     (the deposit stays catalogued and won't come back as new income). */
  function otherIncomeList(id, c) {
    var list = (c && c.otherRows) || [];
    if (!list.length) return null;
    var total = list.reduce(function (t, x) { return t + G.num(x.amount); }, 0);
    return [
      h('h3', { class: 'oi-head' }, 'Other income'),
      h('div', { class: 'ledger oi-list' },
        list.map(function (x) {
          var label = G.otherKindLabel(x.kind);
          var inner = [
            h('div', { class: 'row-label' }, label,
              h('span', { class: 'hint' }, dayMD(x.date))),
            h('span', { class: 'amt num' }, money(G.num(x.amount)))];
          if (!canEditTour(id)) return h('div', { class: 'row' }, inner);
          return h('button', { class: 'row rowbtn', type: 'button',
            'aria-label': label + ' ' + money(G.num(x.amount)),
            onclick: function () { openOtherIncome(id, x); } }, inner);
        }).concat(h('div', { class: 'row total' },
          h('span', null, 'Other income'),
          h('strong', { class: 'amt num' }, money(total)))))
    ];
  }
  function openOtherIncome(id, x) {
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, G.otherKindLabel(x.kind)),
        h('p', { class: 'sh-sub' }, dayMD(x.date) + ' · ' + money(G.num(x.amount))),
        h('p', { class: 'note' }, 'Logged from a bank deposit on the Cards tab. ' +
          'Taking it off the book doesn’t bring the deposit back as new income.'),
        h('div', { class: 'stack' },
          h('button', { class: 'btn block danger', type: 'button', onclick: async function (e) {
            e.currentTarget.disabled = true;
            var patch = { otherIncome: {} };
            patch.otherIncome[x.id] = null;
            if (!(await api.update(id, patch))) { e.currentTarget.disabled = false; return; }
            closeSheet();
            toast('Taken off the book');
            render(true);
          } }, 'Take it off the book'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Keep it'))
      ];
    }, { label: G.otherKindLabel(x.kind) });
  }

  function showRow(id, s, today) {
    var isToday = s.date === today;
    // The date and city say where the night's money stands, two ways only:
    // green once BOTH the guarantee and the merch are marked received, red
    // until then. A night that's been played and not logged at all is red
    // too; one still to come has no colour.
    // (A night with nothing logged that has both boxes ticked by hand — a
    // cancelled date, say — is green: the ticks decide.)
    var got = G.showReceived(s);
    var money_ = G.showMoneyState(s) ||
      (got.guarantee && got.merch ? 'settled' : s.date && s.date < today ? 'owed' : null);
    var owedWhat = [];
    if (money_ === 'owed') {
      if (!got.guarantee) owedWhat.push(G.guaranteeOwed(s) > 0 ? 'rest of the guarantee' : 'guarantee');
      if (!got.merch) owedWhat.push(G.num(s.income && s.income.merch) > 0 ? 'merch deposit' : 'merch');
    }
    // Log income is always there, in the middle; a night that's been played
    // and isn't logged yet gets the bright one. The night's total sits on
    // the right.
    var due = !s.loggedAt && money_ !== 'settled' && s.date && s.date <= today;
    var log = canEditTour(id) ? h('button', { class: 'btn sm inc-btn ' + (due ? 'primary' : 'quiet'), type: 'button',
      'aria-label': 'Log income for ' + (s.city || 'this show'),
      onclick: function () { openIncome(id, s.id); } }, 'Log income') : h('span');
    var total = h('span', { class: 'amt num inc-total' + (s.loggedAt ? '' : ' quiet'),
      'aria-label': s.loggedAt ? 'Income ' + money(G.showIncomeTotal(s)) : 'Not logged yet' },
      s.loggedAt ? money(G.showIncomeTotal(s)) : '\u2014');
    // Under the venue, the night's money in three parts; Total on the right.
    var where = whereBlock(s);
    if (s.loggedAt) where.append(incSplit(s));
    var totalCell = h('span', { class: 'inc-tot' }, s.loggedAt ? h('span', { class: 'inc-k' }, 'Total') : null, total);
    return h('li', null, h('div', {
      class: 'show-row inc-row' + (isToday ? ' is-today' : '') + (money_ ? ' ' + money_ : ''), role: 'group',
      'aria-label': owedWhat.length ? (s.city || 'Show') + ': waiting on the ' + owedWhat.join(' and ') : (s.city || 'Show')
    }, dateBlock(s.date), where, log, totalCell));
  }
  // Guarantee, merch, and everything else (back end, VIPs, buyouts, catering, misc) as one.
  function incSplit(s) {
    var g = G.incomeOf(s, 'guarantee'), m = G.incomeOf(s, 'merch');
    var other = Math.max(0, Math.round((G.showIncomeTotal(s) - g - m) * 100) / 100);
    var part = function (label, v) {
      return h('span', { class: 'inc-part' + (v > 0 ? '' : ' none') }, h('span', { class: 'inc-k' }, label), ' ', v > 0 ? money(v) : '\u2014');
    };
    return h('div', { class: 'inc-split', 'aria-label': 'Guarantee ' + money(g) + ', merch ' + money(m) + ', other ' + money(other) },
      part('Guarantee', g), part('Merch', m), part('Other', other));
  }

  /* ============================== Crew Stats: Flowers ==============================
     Devin: "each person when they sign on gets 10 flowers that they can hand
     out... giving someone their flowers, like credit where credit is due.
     Keep this thing positive: instead of reviewing a crew member you're
     simply giving someone their flowers," and "10 flowers to hand out once a
     year." Everyone has 10 a year, given on a tour to anyone else on it, a
     few at a time, with a line on what for if they like. The crew stack up the way a social app heads a profile:
     photo, name, and three numbers. Flowers on this tour between two
     laurels, the trophy for the artists who list them as their crew, and
     their tours. Your own flowers add up across every tour on your
     profile's Stats tab. */
  var FLOWERS_EACH = 10;
  var FLOWER = '💐', TROPHY = '🏆';
  // What flowers are for: one of these ten, picked when you give them.
  var FLOWER_CATS = [['talent', 'Talent'], ['reliability', 'Reliability'], ['trust', 'Trust'], ['hustle', 'Hustle'],
    ['versatility', 'Versatility'], ['adaptability', 'Adaptability'], ['communication', 'Communication'],
    ['professionalism', 'Professionalism'], ['morale', 'Morale'], ['cleanliness', 'Cleanliness']];
  var FLOWER_NOTE_MAX = 100;
  function flowerCat(key) {
    var c = FLOWER_CATS.filter(function (x) { return x[0] === key; })[0];
    return c ? c[1] : '';
  }
  // The category as a small green tag (flowers from before categories have none).
  function catTag(key) { var l = flowerCat(key); return l ? h('span', { class: 'fw-cat' }, l) : null; }
  function flowersOn() {
    var B = window.GR_BACKEND;
    return S.mode === 'db' && !!(B && B.flowersFor);
  }
  // A laurel branch each side of a number, the way a social app crowns a favourite.
  var LAUREL = '<svg viewBox="0 0 12 24" aria-hidden="true"><path class="lau-stem" d="M9.2 23.2C3.6 19.6 2 12.6 4.9 3.6"/>' +
    '<ellipse cx="4.1" cy="19.4" rx="1.55" ry="3" transform="rotate(-58 4.1 19.4)"/>' +
    '<ellipse cx="2.7" cy="14.3" rx="1.5" ry="2.9" transform="rotate(-34 2.7 14.3)"/>' +
    '<ellipse cx="2.7" cy="9.2" rx="1.45" ry="2.8" transform="rotate(-14 2.7 9.2)"/>' +
    '<ellipse cx="4.7" cy="4" rx="1.35" ry="2.7" transform="rotate(14 4.7 4)"/>' +
    '<ellipse cx="7.6" cy="17.1" rx="1.25" ry="2.5" transform="rotate(42 7.6 17.1)"/>' +
    '<ellipse cx="6.6" cy="11.6" rx="1.2" ry="2.4" transform="rotate(26 6.6 11.6)"/></svg>';
  function laurels(inner) {
    var branch = function (flip) {
      var s = h('span', { class: 'lau' + (flip ? ' flip' : ''), 'aria-hidden': 'true' });
      s.innerHTML = LAUREL;
      return s;
    };
    return h('span', { class: 'laurels' }, branch(false), h('span', { class: 'lau-n' }, inner), branch(true));
  }
  // Under someone's tours / followers / following, a size smaller: their flowers and their endorsements.
  function flowerLine(flowers, endorsements) {
    if (flowers == null && endorsements == null) return null;
    var f = G.num(flowers), e = G.num(endorsements);
    return h('div', { class: 'pf-flowers' },
      h('span', { class: 'pf-fl' }, laurels(String(f)), h('span', { class: 'pf-fl-l' }, f === 1 ? 'flower' : 'flowers')),
      h('span', { class: 'pf-fl' }, h('span', { class: 'pf-fl-n' }, h('span', { 'aria-hidden': 'true' }, TROPHY), String(e)),
        h('span', { class: 'pf-fl-l' }, e === 1 ? 'endorsement' : 'endorsements')));
  }
  function fwName(p) { return String((p && p.name) || (p && p.handle ? '@' + p.handle : '') || 'Someone').trim(); }
  function fwFirst(p) { return fwName(p).split(/\s+/)[0]; }
  function fwStat(num, label) {
    return h('div', { class: 'fw-stat' }, h('strong', { class: 'fw-n num' }, num), h('span', { class: 'fw-l' }, label));
  }
  // The three numbers: flowers (here, or everywhere), the trophy, the tours.
  function fwStats(flowers, c) {
    c = c || {};
    var e = c.endorsements || 0, n = c.tours || 0;
    return h('div', { class: 'fw-stats' },
      fwStat(laurels(String(flowers || 0)), flowers === 1 ? 'flower' : 'flowers'),
      fwStat([h('span', { class: 'fw-emo', 'aria-hidden': 'true' }, TROPHY), String(e)], e === 1 ? 'endorsement' : 'endorsements'),
      fwStat(String(n), n === 1 ? 'tour' : 'tours'));
  }
  /* Each crew member's road badge (Bronze to Legacy, the same ladder as an
     artist's), read for the whole tour in one go and kept a few minutes. */
  function roadTiers(tourId) {
    var B = window.GR_BACKEND;
    S.roadTiers = S.roadTiers || {};
    var c = S.roadTiers[tourId] || (S.roadTiers[tourId] = { by: null, at: 0, asking: false });
    if (S.mode !== 'db' || !B || !B.roadTiers) return c;
    if (!c.asking && (!c.by || Date.now() - c.at > 300e3)) {
      c.asking = true;
      B.roadTiers(tourId).then(function (list) {
        var by = {};
        (list || []).forEach(function (x) { if (x && x.userId) by[x.userId] = x; });
        c.by = by; c.at = Date.now(); c.asking = false; render();
      }).catch(function () { c.asking = false; c.at = Date.now(); });
    }
    return c;
  }
  function roadPill(tourId, uid) {
    var c = roadTiers(tourId), st = c.by && c.by[uid];
    var tier = st ? G.historyTier(st) : null;
    return tier ? h('span', { class: 'hist-tier sm tier-' + tier.key, title: plural(G.num(st.shows), 'show') + ' on the road' }, tier.label) : null;
  }
  // One person on the tour: photo, name (with their road badge), the three numbers, and Give flowers.
  function flowerCard(id, p, me, data) {
    var mine = p.userId === me;
    // Tap a crew member and the flowers they were given open under them:
    // who gave them, the note, when (Devin, 2026-10-07: not a list for the
    // whole page, a dropdown per person).
    var open = !!(S.fwOpen && S.fwOpen[p.userId]);
    var toggle = function () { S.fwOpen = S.fwOpen || {}; S.fwOpen[p.userId] = !open; render(true); };
    return h('li', { class: 'fw-card' + (mine ? ' me' : '') + (open ? ' open' : '') },
      h('div', { class: 'fw-main' },
        h('button', { class: 'fw-face', type: 'button', 'aria-label': mine ? 'Your profile' : 'Open ' + fwName(p) + '’s profile',
          onclick: function () { openProfile(p.userId); } }, personPhoto(p, 'fw-photo')),
        h('div', { class: 'fw-side' },
          h('button', { class: 'fw-name fw-name-btn', type: 'button', 'aria-expanded': open ? 'true' : 'false',
            'aria-label': (open ? 'Hide' : 'Show') + ' the flowers ' + (mine ? 'you were' : fwName(p) + ' was') + ' given', onclick: toggle },
            h('span', { class: 'fw-name-t' }, fwName(p)), roadPill(id, p.userId), p.verified ? verifiedBadge('sm') : null,
            mine ? h('span', { class: 'fw-you' }, 'You') : null,
            h('span', { class: 'fw-chev', 'aria-hidden': 'true' }, icon('chevron', 14))),
          p.tourRole ? h('p', { class: 'fw-role' }, p.tourRole) : null,
          fwStats(p.here, p.counts)),
        // Small, at the right edge of the stats (Devin, 2026-10-07).
        mine || !data.canGive ? null : h('button', { class: 'fw-give sm', type: 'button', disabled: data.left <= 0,
          'aria-label': data.left > 0 ? 'Give flowers to ' + fwName(p) : 'All ' + FLOWERS_EACH + ' flowers given',
          onclick: function () { openGiveFlowers(id, p, data.left); } },
          data.left > 0 ? ['Give ', h('span', { 'aria-hidden': 'true' }, FLOWER)] : 'All given')),
      open ? fwGiven(p, me, data) : null);
  }
  // The flowers one person was given on this tour, newest first: the giver, how many, the note, when.
  function fwGiven(p, me, data) {
    var by = {};
    data.people.forEach(function (x) { by[x.userId] = x; });
    var nameOf = function (uid, given) {
      if (uid === me) return 'You';
      return by[uid] ? fwFirst(by[uid]) : (String(given || '').trim().split(/\s+/)[0] || 'Someone');
    };
    var got = (data.given || []).filter(function (g) { return g.to === p.userId; });
    if (!got.length) return h('div', { class: 'fw-drop' }, h('p', { class: 'fw-none' }, 'No flowers yet.'));
    return h('ul', { class: 'fw-drop fw-feed' }, got.map(function (g) {
      var giver = by[g.from] || { name: g.fromName || '?' };
      return h('li', { class: 'fw-gift' },
        personPhoto(giver, 'xs'),
        h('div', { class: 'fw-gift-t' },
          h('p', { class: 'fw-gift-l' }, h('strong', null, nameOf(g.from, g.fromName)), ' gave ' + plural(g.n, 'flower') + ' ',
            h('span', { 'aria-hidden': 'true' }, FLOWER), catTag(g.category)),
          g.note ? h('p', { class: 'fw-note' }, '\u201c' + g.note + '\u201d') : null,
          h('p', { class: 'fw-when' }, dmWhen(g.at))));
    }));
  }
  // Give flowers, pinned at the bottom of the screen on Crew Stats, with this year's count under it, the way your profile shows it.
  function fwMine(id, data, me) {
    if (!data.canGive) return null;
    var left = Math.max(0, data.left);
    var others = data.people.filter(function (p) { return p.userId !== me; });
    return [h('div', { class: 'fw-room', 'aria-hidden': 'true' }), h('div', { class: 'fw-me-give pinned' },
      h('button', { class: 'fw-give', type: 'button', disabled: left <= 0 || !others.length,
        onclick: function () { pickFlowerPerson(id, others, left); } },
        'Give flowers ', h('span', { 'aria-hidden': 'true' }, FLOWER)),
      h('p', { class: 'fw-me-left' }, left + ' left'))];
  }
  // Who gets them: everyone else on the tour, then the same sheet as their card's button.
  function pickFlowerPerson(id, people, left) {
    var mine = null;
    openSheet(function (panel) {
      mine = panel;
      return [
        h('h2', { class: 'sh-title' }, 'Give flowers to\u2026'),
        h('div', { class: 'fl-list' }, people.map(function (p) {
          return h('button', { class: 'fl-row', type: 'button',
            onclick: function () { if (sheet && sheet.panel === mine) closeSheet(true); openGiveFlowers(id, p, left); } },
            personPhoto(p, 'xs'),
            h('span', { class: 'lr-text' }, h('span', { class: 'lr-title' }, fwName(p)), p.tourRole ? h('span', { class: 'lr-sub' }, p.tourRole) : null));
        }))
      ];
    }, { label: 'Give flowers' });
  }
  /* Check In, at the bottom of the screen on your profile's Today (pinned:
     it stays put above the bottom bar): your way of saying you've seen the
     day's info. Once a day, on a tour day. */
  function checkInBtn(id, date, pinned) {
    var B = window.GR_BACKEND;
    if (S.mode !== 'db' || !B || !B.checkIn || !B.checkedIn) return null;
    var done = B.checkedIn(id, date);
    return h('div', { class: 'ci-wrap' + (pinned ? ' pinned' : '') }, h('button', { class: 'ci-btn' + (done ? ' done' : ''), type: 'button', disabled: done,
      onclick: async function (e) {
        var b = e.currentTarget;
        b.disabled = true;
        try { await B.checkIn(id, date); } catch (x) { b.disabled = false; toast('Couldn\u2019t check in. Try again.'); return; }
        hornSplash('Checked in!', dayMD(date));
        render(true);
      } }, done ? '\u2705 Checked in' : 'Check In'));
  }
  // Flowers given to you that you'd rather not keep (and their note) come off.
  function removeGotFlowers(g) {
    var B = window.GR_BACKEND;
    confirmSheet({
      title: 'Remove ' + plural(g.n, 'flower') + '?',
      body: 'They come off your flowers, note and all.',
      action: 'Remove', danger: true,
      onConfirm: async function () {
        try { await B.takeBackFlowers(g.tourId, g.id); } catch (e) { toast('Couldn’t remove them just now.'); return false; }
        S.flowersAt = Date.now();
        toast('Removed');
        return true;
      }
    });
  }
  // Give someone their flowers: tap how many, say what for if you like.
  function openGiveFlowers(id, p, left) {
    var B = window.GR_BACKEND, n = 1, picks = [], giveBtn = null, note = null, mine = null, cat = '', cats = [];
    // While a gift is on its way, the count and the reason stay as they were sent.
    var sending = false;
    // One gift id per person until it lands, so a gift sent again (a retry,
    // or the sheet closed and opened again while it was on its way) gives once.
    var key = id + '|' + p.userId;
    S.giftIds = S.giftIds || {};
    if (!S.giftIds[key] && B.newGiftId) S.giftIds[key] = B.newGiftId();
    var rid = S.giftIds[key] || null;
    var closeMine = function () { if (sheet && sheet.panel === mine) closeSheet(); };
    var paint = function () {
      picks.forEach(function (b, i) { b.classList.toggle('on', i < n); b.setAttribute('aria-pressed', i < n ? 'true' : 'false'); });
      cats.forEach(function (b) { var on = b.getAttribute('data-cat') === cat; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      // Nothing goes until you've said what for.
      giveBtn.disabled = sending || !cat;
      giveBtn.replaceChildren('Give ' + plural(n, 'flower') + ' ', h('span', { 'aria-hidden': 'true' }, FLOWER));
    };
    openSheet(function (panel) {
      mine = panel;
      picks = [];
      for (var i = 1; i <= Math.min(left, FLOWERS_EACH); i++) (function (k) {
        picks.push(h('button', { class: 'fw-pick', type: 'button', 'aria-label': plural(k, 'flower'),
          onclick: function () { if (sending) return; n = k; paint(); } }, FLOWER));
      })(i);
      cats = FLOWER_CATS.map(function (c) {
        return h('button', { class: 'fw-catpick', type: 'button', 'data-cat': c[0], onclick: function () { if (sending) return; cat = c[0]; paint(); } }, c[1]);
      });
      note = h('input', { class: 'input', type: 'text', maxlength: String(FLOWER_NOTE_MAX), placeholder: 'A quick note (optional)',
        'aria-label': 'A quick note', autocomplete: 'off', enterkeyhint: 'done' });
      giveBtn = h('button', { class: 'btn primary block', type: 'button', onclick: async function () {
        if (!cat || sending) return;
        sending = true;
        giveBtn.disabled = true;
        try {
          await B.giveFlowers(id, p.userId, n, note.value, rid, cat);
        } catch (e) {
          sending = false;
          giveBtn.disabled = false;
          if (e && e.code === 'none-left') {
            // Fewer left than this phone thought (given from another phone): show the real count.
            var d = B.flowersFor(id), have = d && !d.error ? d.left : 0;
            closeMine();
            render(true);
            toast(have > 0 ? 'You have ' + plural(have, 'flower') + ' left this year.' : 'You’ve given all ' + FLOWERS_EACH + ' this year.');
            return;
          }
          toast('Couldn’t give them just now. Try again.');
          return;
        }
        sending = false;
        delete S.giftIds[key];
        S.flowersAt = Date.now(); // profiles showing flowers ask again
        closeMine();
        toast(fwFirst(p) + ' got their flowers ' + FLOWER);
        render(true);
      } });
      paint();
      return [
        h('div', { class: 'fw-sh-head' }, personPhoto(p, 'sm'),
          h('div', null,
            h('h2', { class: 'sh-title' }, 'Give ' + fwFirst(p) + ' their flowers'),
            h('p', { class: 'sh-sub' }, left + ' left this year'))),
        h('div', { class: 'fw-picks', role: 'group', 'aria-label': 'How many flowers' }, picks),
        h('h3', { class: 'fw-sh-h' }, 'What for?'),
        h('div', { class: 'fw-cats', role: 'group', 'aria-label': 'What for' }, cats),
        note,
        h('div', { class: 'stack' }, giveBtn,
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Not now'))
      ];
    }, { label: 'Give flowers' });
  }
  function fwLoading(what) { return h('p', { class: 'note fw-wait' }, what); }
  function fwFailed(again) {
    return h('div', { class: 'fw-fail' }, emptyState('Couldn’t load the flowers', 'Check your signal and try again.'),
      h('button', { class: 'btn ghost', type: 'button', onclick: function () { again(); render(true); } }, 'Try again'));
  }
  function viewStats(id, t) {
    var B = window.GR_BACKEND, me = B && B.uid ? B.uid() : null;
    var data = flowersOn() ? B.flowersFor(id) : null;
    var body = !flowersOn()
      ? emptyState('Flowers are for a signed-in tour', 'Once everyone’s signed in, each of you gets ' + FLOWERS_EACH + ' to give.')
      : !data ? fwLoading('Picking the flowers…')
      : data.error ? fwFailed(function () { B.flowersFor(id, true); })
      : [h('ul', { class: 'fw-list' }, data.people.slice()
           // Whoever is signed in leads the list (Devin, 2026-10-07).
           .sort(function (a, b) { return (b.userId === me ? 1 : 0) - (a.userId === me ? 1 : 0); })
           .map(function (p) { return flowerCard(id, p, me, data); })),
         fwMine(id, data, me)];
    return h('div', { class: 'page tour has-tabs fw-page' },
      tourBand(t, id, 'stats'),
      h('h1', { class: 'tour-title' }, 'Crew Stats'),
      dbBanner(),
      body,
      tourTabs(id, 'stats'));
  }

  /* ============================== Calendar ==============================
     Every day of the run, laid out like the Budget but with no money: show
     days take special requests, days off take a vote. Everyone on the tour
     sees everything here. */
  /* Every day of a run as calendar rows (a show day with its Day sheet and
     Special requests, a day off with its Day sheet and vote). The list
     starts where we are; days already done are greyed and tucked behind
     "View previous dates". o.from / o.fromLabel: where a Day sheet's back
     button returns. */
  function calendarRows(id, t, o) {
    o = o || {};
    var today = G.tourToday();
    var got = overviewDays(t);
    var rowsOut = [], pastBtn = null;
    if (got) {
      var firstShow = got.days.filter(function (x) { return x.show; })[0];
      var lastShow = got.days.slice().reverse().filter(function (x) { return x.show; })[0];
      var past = got.days.filter(function (x) { return x.date < today; }).length;
      var ahead = past < got.days.length;
      S.calPast = S.calPast || {};
      var fold = ahead;
      var showPast = !fold || !!S.calPast[id];
      rowsOut = got.days.filter(function (x) { return showPast || x.date >= today; }).map(function (x) {
        var row = x.show ? calShowRow(id, x.show, today, o.from, o.fromLabel) : calOffRow(id, t, x.date,
          (firstShow && x.date < firstShow.date) || (lastShow && x.date > lastShow.date), o.from, o.fromLabel);
        if (x.date < today) row.firstChild.classList.add('is-past');
        return row;
      });
      if (past && fold) pastBtn = h('button', { class: 'btn quiet sm cal-past', type: 'button',
        'aria-expanded': showPast ? 'true' : 'false',
        onclick: function () { S.calPast[id] = !showPast; render(true); } },
        icon('chevron', 16), showPast ? 'Hide previous dates' : 'View previous dates (' + past + ')');
    }
    return { rows: rowsOut, pastBtn: pastBtn, open: !!(S.calPast && S.calPast[id]) };
  }
  function viewCalendar(id, t) {
    var cal = calendarRows(id, t);
    var rowsOut = cal.rows, pastBtn = cal.pastBtn;
    return h('div', { class: 'page tour has-tabs' },
      tourBand(t, id, 'calendar'),
      h('h1', { class: 'tour-title' }, 'Calendar'),
      dbBanner(),
      canEditTour(id) ? h('button', { class: 'btn quiet glow block add-more', type: 'button',
        onclick: function () { openAddShowsMenu(id); } }, icon('plus', 18), 'ADD MORE SHOWS') : null,
      rowsOut.length
        ? [h('p', { class: 'count-line' }, 'Special requests on show days · a vote on days off'),
           pastBtn ? h('div', { class: 'cal-past-wrap' + (S.calPast[id] ? ' open' : '') }, pastBtn) : null,
           h('ul', { class: 'shows cal-list' }, rowsOut)]
        : emptyState('No dates yet', 'Once the shows are in, every day of the run shows up here.'),
      tourTabs(id, 'details'));
  }
  function calShowRow(id, s, today, from, fromLabel) {
    var B = window.GR_BACKEND;
    var asks = !!(B && B.requestsFor); // requests live with a signed-in tour
    var reqs = asks ? B.requestsFor(id, s.date) : [];
    var open = reqs.filter(function (r) { return r.status === 'pending'; }).length;
    return h('li', null, h('div', { class: 'show-row cal-row' + (s.date === today ? ' is-today' : '') },
      dateBlock(s.date), whereBlock(s), daySheetBtn(id, s.date, from, fromLabel),
      !asks ? h('span', { 'aria-hidden': 'true' }) : h('button', { class: 'cal-btn' + (open ? ' on' : ''), type: 'button',
        'aria-label': 'Special requests for ' + (s.city || 'this show') + (open ? ', ' + open + ' waiting for an answer' : ''),
        onclick: function () { openRequests(id, s); } },
        'Special requests')));
  }
  /* A day off's poll button, the same on the Calendar and the day sheet:
     Create poll for the tour manager only (the creator, or whoever's tour
     role is Tour Manager) until there is one. Then Vote for everyone, ALL
     ACCESS included: green and pulsing until you vote, steady white with a
     white 🤘 once you have, and Results once it's closed. */
  function pollBtn(id, date) {
    var B = window.GR_BACKEND;
    var poll = B && B.pollFor ? B.pollFor(id, date) : null;
    var closed = poll && Date.parse(poll.closesAt) <= Date.now();
    var mine = poll && B.uid ? B.votesFor(id, date).filter(function (v) { return v.userId === B.uid(); })[0] : null;
    var cls = 'cal-btn vote', kids;
    if (!poll && moneyLead(id)) kids = ['Create poll'];
    else if (!poll) { cls += ' idle'; kids = ['Vote']; }
    else if (mine) { cls += ' voted'; kids = ['Vote ', h('span', { class: 'horns', 'aria-hidden': 'true' }, '\ud83e\udd18')]; }
    else if (closed) kids = ['Results'];
    else { cls += ' on'; kids = ['Vote']; }
    return h('button', { class: cls, type: 'button', 'aria-label': (mine ? 'Voted' : kids[0]) + ', day off ' + dayMD(date),
      onclick: function () { openPoll(id, date); } }, kids);
  }
  function calOffRow(id, t, date, travel, from, fromLabel) {
    var off = offDayFor(t, date);
    var reh = isRehearsalDay(t, date);
    var right;
    if (reh || travel) right = h('span', { class: 'tag quiet' }, reh ? 'Rehearsal' : 'Travel');
    else if (!(window.GR_BACKEND && window.GR_BACKEND.pollFor)) right = h('span', { 'aria-hidden': 'true' }); // polls live with a signed-in tour
    else right = pollBtn(id, date);
    return h('li', null, h('div', { class: 'show-row is-off cal-row' },
      dateBlock(date),
      h('div', { class: 'where' },
        h('div', { class: 'city' }, off.city || (reh ? 'Rehearsal day' : travel ? 'Travel day' : 'Day off')),
        off.hotel ? h('div', { class: 'venue' }, off.hotel) : null),
      daySheetBtn(id, date, from, fromLabel),
      right));
  }
  /* Checking in, and logging card charges: a big 🤘 pops and rocks, and
     throws a ring of smaller ones, with the words under it. */
  function hornSplash(big, sub) {
    var bits = [];
    if (!reduced()) for (var i = 0; i < 12; i++) {
      var a = (i / 12) * Math.PI * 2 + Math.random() * 0.4, r = 115 + Math.random() * 75;
      bits.push(h('span', { class: 'hs-bit', 'aria-hidden': 'true',
        style: '--dx:' + Math.round(Math.cos(a) * r) + 'px;--dy:' + Math.round(Math.sin(a) * r) + 'px;--rot:' +
          Math.round(Math.random() * 90 - 45) + 'deg;--d:' + (140 + i * 22) + 'ms' }, '🤘'));
    }
    var el = h('div', { class: 'splash-note horns', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'sn-card' },
        h('span', { class: 'hs-horn', 'aria-hidden': 'true' }, '🤘', bits),
        h('div', { class: 'sn-big' }, big),
        sub ? h('div', { class: 'sn-sub' }, sub) : null));
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('on'); });
    setTimeout(function () {
      el.classList.remove('on');
      setTimeout(function () { el.remove(); }, 350);
    }, reduced() ? 1800 : 2300);
  }

  // Straight to that day's day sheet.
  function daySheetBtn(id, date, from, fromLabel) {
    return h('button', { class: 'cal-btn ds-jump', type: 'button', 'aria-label': 'Day sheet for ' + dayMD(date),
      onclick: function () {
        var got = overviewDays(getTour(id));
        var i = got ? got.days.map(function (x) { return x.date; }).indexOf(date) : -1;
        if (i >= 0) { S.dsIndex = i; S.dsTour = id; }
        go({ name: 'tour', id: id, view: 'day', from: from || null, fromLabel: fromLabel || null });
      } }, 'Day sheet');
  }

  // Voting closes at noon the day before the day off.
  function pollCloses(date) {
    var d = G.parseDay(date);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12, 0, 0);
  }
  function closesText(iso) {
    var d = new Date(iso);
    return F.long.format(d) + ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function openPoll(id, date) {
    var B = window.GR_BACKEND;
    var poll = B && B.pollFor ? B.pollFor(id, date) : null;
    if (!poll) {
      if (moneyLead(id)) openPollEditor(id, date, null);
      else toast('No poll for ' + dayMD(date) + ' yet. The tour manager posts the options.');
      return;
    }
    var box = h('div');
    var busy = false;
    function draw() {
      var p = B.pollFor(id, date);
      if (!p) { closeSheet(); return; }
      var votes = B.votesFor(id, date);
      var me = B.uid ? B.uid() : null;
      var closed = Date.parse(p.closesAt) <= Date.now();
      var counts = {};
      votes.forEach(function (v) { counts[v.choice] = (counts[v.choice] || 0) + 1; });
      var top = Math.max.apply(null, [0].concat(p.options.map(function (o) { return counts[o.id] || 0; })));
      fillEl(box, [
        h('p', { class: 'sh-sub' }, closed ? 'Voting closed ' + closesText(p.closesAt) + '.'
          : 'Vote by ' + closesText(p.closesAt) + '. You can change your vote until then.'),
        h('div', { class: 'ledger poll' }, p.options.map(function (o) {
          var who = votes.filter(function (v) { return v.choice === o.id; });
          var mineHere = who.some(function (v) { return v.userId === me; });
          var n = counts[o.id] || 0;
          return h('button', { class: 'row poll-opt' + (mineHere ? ' mine' : '') + (closed && n && n === top ? ' won' : ''),
            type: 'button', disabled: closed,
            onclick: async function () {
              if (busy || closed || mineHere) return;
              busy = true;
              try { await B.vote(id, date, o.id); toast('Voted: ' + o.label); }
              catch (e) { toast(Date.parse(p.closesAt) <= Date.now() ? 'Voting has closed.' : 'Couldn’t vote. Try again.'); }
              busy = false;
              draw(); render(true);
            } },
            h('span', { class: 'poll-dot' }, mineHere ? icon('check', 14) : null),
            h('div', { class: 'row-label' }, o.label,
              h('span', { class: 'hint' }, who.length ? who.map(function (v) { return v.name || 'Someone'; }).join(', ') : 'No votes yet')),
            h('span', { class: 'amt num' }, String(n)));
        })),
        moneyLead(id) ? h('div', { class: 'stack' },
          !closed ? h('button', { class: 'btn quiet block', type: 'button',
            onclick: function () { openPollEditor(id, date, p); } }, 'Edit options') : null,
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () {
            confirmSheet({ title: 'Delete this poll?', body: 'The options and every vote go.', action: 'Delete poll', danger: true,
              onConfirm: async function () {
                try { await B.deletePoll(id, date); toast('Poll deleted'); return true; }
                catch (e) { toast('Couldn’t do that. Try again.'); return false; }
              } });
          } }, 'Delete poll')) : null]);
    }
    draw();
    openSheet(function () {
      return [h('h2', { class: 'sh-title' }, 'Day off · ' + dayLong(date)), box];
    }, { label: 'Day off poll' });
  }
  function openPollEditor(id, date, poll) {
    var B = window.GR_BACKEND;
    var opts = poll ? poll.options.map(function (o) { return { id: o.id, label: o.label }; })
      : [{ id: 'o1', label: '' }, { id: 'o2', label: '' }];
    var closes = pollCloses(date);
    var list = h('div', { class: 'poll-edit' });
    function draw() {
      list.replaceChildren.apply(list, opts.map(function (o, i) {
        return h('div', { class: 'af-row' },
          h('input', { class: 'input', type: 'text', value: o.label, maxlength: 60, autocomplete: 'off',
            placeholder: 'Option ' + (i + 1) + (i === 0 ? ', e.g. Bowling' : i === 1 ? ', e.g. Beach day' : ''),
            'aria-label': 'Option ' + (i + 1), oninput: function (e) { o.label = e.target.value; } }),
          opts.length > 2 ? h('button', { class: 'iconbtn sm', type: 'button', 'aria-label': 'Remove option ' + (i + 1),
            onclick: function () { opts.splice(i, 1); draw(); } }, icon('trash', 16)) : null);
      }));
    }
    draw();
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, poll ? 'Edit the poll' : 'Create a poll'),
        h('p', { class: 'sh-sub' }, 'Day off · ' + dayLong(date) + '. The crew can vote until noon ' + F.long.format(closes) + '.'),
        list,
        opts.length < 8 ? h('button', { class: 'btn quiet block', type: 'button', style: 'margin-top:10px', onclick: function () {
          opts.push({ id: 'o' + Date.now().toString(36) + opts.length, label: '' }); draw();
          var ins = list.querySelectorAll('input'); if (ins.length) ins[ins.length - 1].focus();
        } }, icon('plus', 18), 'Add option') : null,
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary block', type: 'button', onclick: async function (e) {
            var clean = opts.map(function (o) { return { id: o.id, label: String(o.label || '').trim().slice(0, 60) }; })
              .filter(function (o) { return o.label; });
            if (clean.length < 2) { toast('Give the crew at least two options'); return; }
            if (closes.getTime() <= Date.now()) { toast('It’s past noon the day before, so voting would already be closed.'); return; }
            e.currentTarget.disabled = true;
            try { await B.savePoll(id, date, clean, closes.toISOString()); }
            catch (x) { e.currentTarget.disabled = false; toast('Couldn’t save the poll. Try again.'); return; }
            closeSheet(); toast(poll ? 'Poll updated' : 'Poll is up. The crew can vote until noon ' + F.long.format(closes) + '.');
            render(true);
          } }, poll ? 'Save poll' : 'Post the poll'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Cancel'))
      ];
    }, { label: 'Create a poll' });
  }

  function openRequests(id, s) {
    var B = window.GR_BACKEND;
    var box = h('div');
    var text = '';
    function draw() {
      var reqs = B.requestsFor(id, s.date);
      box.replaceChildren(
        reqs.length ? h('div', { class: 'ledger reqs' }, reqs.map(function (r) {
          var when = r.at ? new Date(r.at) : null;
          var answer = async function (status) {
            try { await B.answerRequest(r.id, status); } catch (x) { toast('Couldn\u2019t save that.'); }
            draw(); render(true);
          };
          return h('div', { class: 'row req ' + r.status },
            h('div', { class: 'row-label' }, r.body,
              h('span', { class: 'hint' }, [r.author || 'Someone', when ? dayMD(G.ymd(when)) + ' ' +
                when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''].filter(Boolean).join(' \u00b7 ')),
              leadsTour(id) && r.status === 'pending'
                ? h('span', { class: 'req-answer' },
                    h('button', { class: 'btn sm primary', type: 'button', onclick: function () { answer('accepted'); } }, 'Accept'),
                    h('button', { class: 'btn sm quiet', type: 'button', onclick: function () { answer('denied'); } }, 'Deny'))
                : h('span', { class: 'req-status ' + r.status },
                    r.status === 'accepted' ? 'Accepted' : r.status === 'denied' ? 'Denied' : 'Waiting for an answer',
                    leadsTour(id) ? h('button', { class: 'linkbtn', type: 'button', onclick: function () { answer('pending'); } }, 'Change') : null)),
            (r.mine || leadsTour(id)) ? h('button', { class: 'iconbtn sm', type: 'button', 'aria-label': 'Remove request',
              onclick: async function () {
                try { await B.deleteRequest(r.id); toast('Request removed'); } catch (x) { toast('Couldn\u2019t do that.'); }
                draw(); render(true);
              } }, icon('trash', 16)) : null);
        })) : h('p', { class: 'note' }, 'No requests yet. Need something on this day? Ask here and everyone on the tour sees it.'));
    }
    draw();
    var input = h('input', { class: 'input', type: 'text', maxlength: 300, autocomplete: 'off',
      placeholder: 'What do you need?', 'aria-label': 'Your request', enterkeyhint: 'send',
      oninput: function (e) { text = e.target.value; } });
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, 'Special requests'),
        h('p', { class: 'sh-sub' }, [s.city, dayLong(s.date), s.venue].filter(Boolean).join(' · ')),
        box,
        h('form', { class: 'af-row', style: 'margin-top:14px', novalidate: true, onsubmit: async function (e) {
          e.preventDefault();
          var body = text.trim();
          if (!body) { input.focus(); return; }
          try { await B.addRequest(id, s.date, body); }
          catch (x) { toast('Couldn’t add that. Try again.'); return; }
          // The tour manager and ALL ACCESS hear about it on their phones.
          sendNotify(id, 'request', { city: s.city || '', date: s.date, text: body });
          text = ''; input.value = '';
          toast('Request added'); draw(); render(true);
        } }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Add'))
      ];
    }, { label: 'Special requests' });
  }

  function tonightCard(id, s) {
    // Log income in the middle, always; tonight's total on the right.
    var log = canEditTour(id) ? h('button', { class: 'btn sm inc-btn ' + (s.loggedAt ? 'quiet' : 'primary'), type: 'button',
      onclick: function () { openIncome(id, s.id); } }, 'Log income')
      : (s.loggedAt ? h('span') : h('span', { class: 'tag attn' }, 'Not logged yet'));
    return h('div', { class: 'tonight inc-row' },
      h('div', { class: 'tn-text' },
        h('div', { class: 'tn-label' }, 'Tonight'),
        h('div', { class: 'tn-city' }, s.city || 'Show'),
        s.venue ? h('div', { class: 'venue' }, s.venue) : null),
      log,
      h('span', { class: 'amt num inc-total' + (s.loggedAt ? '' : ' quiet') }, s.loggedAt ? money(G.showIncomeTotal(s)) : '\u2014'));
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
      tourBand(t, id, 'details'),
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

  /* A day's sheet as it reads: the venue, the schedule and the amenities on a
     show day; the hotel and the plans on a day off. Null when nothing has
     been filled in, so a caller can show nothing at all. o.onlySet is for
     the profile's Today, which has the address above it already: only what
     someone filled in counts (the address and phone the app looks up by
     itself don't make a sheet), the address isn't said twice, and the
     amenities nobody answered are left out instead of a row of dashes. */
  function daySheetNodes(s, off, o) {
    var lines = s ? G.daySheetLines(s) : G.offDayLines(off || {});
    if (o && o.onlySet && s) lines = lines.filter(function (x) { return !/^(Address|Venue phone): /.test(x); });
    if (!lines.length) return null;
    var d = s && G.isObj(s.daySheet) ? s.daySheet : {};
    off = off || {};
    var body;
    if (s) {
      // In sections, in the order the day happens: where you are, the
      // schedule from lobby call to bus call, then the amenities.
      var dsRow = function (label, val) {
        return h('div', { class: 'row ds-row' }, h('span', { class: 'row-label' }, label), val);
      };
      var textRow = function (label, v) {
        v = String(v || '').trim();
        return v ? dsRow(label, h('span', { class: 'ds-val' }, v)) : null;
      };
      var clockRow = function (label, v) {
        v = G.cleanTime(v);
        return v ? dsRow(label, h('span', { class: 'ds-time num' }, v)) : null;
      };
      // Soundchecks and set times: a small heading, then one row per band.
      var bandRows = function (title, list) {
        var got = (Array.isArray(list) ? list : []).filter(function (r) {
          return r && (String(r.band || '').trim() || String(r.time || '').trim());
        });
        if (!got.length) return [];
        return [h('div', { class: 'row ds-sub' }, title)].concat(got.map(function (r) {
          return h('div', { class: 'row ds-row ds-band-row' },
            h('span', { class: 'row-label' }, String(r.band || '').trim() || 'TBA'),
            h('span', { class: 'ds-time num' }, G.cleanTime(r.time) || 'TBA'));
        }));
      };
      var section = function (title, rows) {
        rows = [].concat.apply([], rows).filter(Boolean);
        return rows.length ? h('section', { class: 'ds-sec' },
          h('h3', { class: 'ds-sec-h' }, title), h('div', { class: 'ledger' }, rows)) : null;
      };
      // The schedule in blocks, each its own card: VIP and Doors sit on their
      // own between the soundchecks and the set times.
      var blocks = function (title, groups) {
        var cards = groups.map(function (g) { return [].concat.apply([], g).filter(Boolean); })
          .filter(function (g) { return g.length; })
          .map(function (g) { return h('div', { class: 'ledger ds-block' }, g); });
        return cards.length ? h('section', { class: 'ds-sec' }, h('h3', { class: 'ds-sec-h' }, title), cards) : null;
      };
      var address = String(d.venueAddress || '').trim();
      body = [
        section('Venue', [
          (address && !(o && o.onlySet)) ? dsRow('Address', h('a', { class: 'ds-val ds-link', href: mapsHref(address),
            target: '_blank', rel: 'noopener' }, address)) : null,
          textRow('Venue phone', d.venuePhone),
          textRow('Wifi', d.wifi),
          textRow('Wifi password', d.wifiPass),
          textRow('Parking', d.parking)]),
        blocks('Schedule', [
          [clockRow('Lobby call', d.lobbyCall), clockRow('Load in', d.loadIn)],
          [bandRows('Soundcheck', d.soundchecks)],
          [textRow('VIP', d.vip), clockRow('Doors', d.doors)],
          [bandRows('Set times', d.setTimes)],
          [clockRow('Load out', d.loadOut), clockRow('Bus call', d.busCall), textRow('Drive to next venue', d.driveNext)]]),
        // Every amenity listed, a plain yes or no beside it.
        section('Amenities', G.DS_AMENITIES.map(function (a) {
          if (o && o.onlySet && d[a[0]] !== 'yes' && d[a[0]] !== 'no') return null;
          return dsRow(a[1], h('span', { class: 'ds-val' },
            d[a[0]] === 'yes' ? 'Yes' : (d[a[0]] === 'no' ? 'No' : '\u2014')));
        })),
        String(d.notes || '').trim() ? h('section', { class: 'ds-sec' },
          h('h3', { class: 'ds-sec-h' }, 'Notes'), h('p', { class: 'ds-notes' }, String(d.notes).trim())) : null
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
      if (String(off.hotel || '').trim()) {
        // The hotel's name and the town are enough for Maps to find it.
        offRows.push(h('div', { class: 'row ds-row' },
          h('span', { class: 'row-label' }, 'Hotel'),
          h('a', { class: 'ds-val ds-link', target: '_blank', rel: 'noopener',
            href: mapsHref(String(off.hotel).trim() + (off.city ? ', ' + off.city : '')) }, String(off.hotel).trim())));
      }
      offRow('Wifi', off.wifi);
      offRow('Wifi password', off.wifiPass);
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
    return body;
  }

  function detailsBody(id, t, only) {
    var got = overviewDays(t);
    if (!got) {
      return [
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

    var body = daySheetNodes(s, off);
    if (!body) {
      body = emptyState('No day sheet added.', null);
      body.classList.add('ds-empty');
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

    // The night's venue, filled in from the show, centred over its day sheet.
    // An off day shows the hotel instead, when there is one.
    var placeName = s ? String(s.venue || '').trim() : String((off && off.hotel) || '').trim();
    // A trash can in the corner clears the sheet to start over, after asking.
    var trashBtn = canEditTour(id) && lines.length ? h('button', {
      class: 'iconbtn sm ds-trash', type: 'button', 'aria-label': 'Clear this day sheet',
      onclick: function () { clearDaySheet(id, s, entry.date, off); } }, icon('trash', 18)) : null;
    // And a pencil in the other corner opens the editor.
    var editBtn = canEditTour(id) ? h('button', {
      class: 'iconbtn sm ds-pencil', type: 'button', 'aria-label': lines.length ? 'Edit this day sheet' : 'Fill in this day sheet',
      onclick: function () { if (s) openDaySheetEditor(id, s.id); else openOffDaySheet(id, entry.date); } }, icon('edit', 18)) : null;
    var placeEl = placeName || trashBtn || editBtn ? h('div', { class: 'ds-venue-row' },
      editBtn, placeName ? h('div', { class: 'ds-venue' }, placeName) : null, trashBtn) : null;

    // A day off with nothing decided yet: the same poll as the Calendar,
    // Create poll for the tour manager, Vote for everyone else. Once the
    // tour manager fills the day sheet in, the plan's made and it goes.
    var pollRow = null;
    var B = window.GR_BACKEND;
    if (!s && !lines.length && B && B.pollFor && !isRehearsalDay(t, entry.date)) {
      var showDays = days.filter(function (x) { return x.show; });
      var inRun = showDays.length && entry.date > showDays[0].date && entry.date < showDays[showDays.length - 1].date;
      if (inRun) pollRow = h('div', { class: 'ds-poll' }, pollBtn(id, entry.date));
    }

    // The same day picker serves three tabs; each shows its own half.
    if (only === 'guests') return [hero, rail, guestBtn];
    // Check In sits right under the venue's name.
    if (only === 'sheet') return [rail, placeEl, body, pollRow, editRow, copyBtn];

    return [hero, rail, editRow, body, pollRow, guestBtn, copyBtn];
  }

  function clearDaySheet(tourId, show, date, off) {
    var where = show ? (show.city || 'this night') : (off.city || 'this day off');
    confirmSheet({
      title: 'Clear this day sheet?',
      body: 'Everything on ' + where + '\u2019s day sheet is erased so you can start over. ' +
        (show ? 'The show itself, its money and its guest list stay.' : 'The day itself stays on the tour.'),
      action: 'Clear day sheet', danger: true,
      onConfirm: async function () {
        var patch;
        if (show) {
          patch = { shows: {} };
          patch.shows[show.id] = { daySheet: null };
        } else {
          // An off day keeps its town, so the day picker still says where you are.
          patch = { offDays: {} };
          patch.offDays[date] = String(off.city || '').trim()
            ? { city: off.city, hotel: '', wifi: '', wifiPass: '', rooms: '', notes: '', plans: [] } : null;
        }
        var ok = await api.update(tourId, patch);
        if (ok) toast('Day sheet cleared');
        return ok;
      }
    });
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
      city: d0.city || '', hotel: d0.hotel || '', wifi: d0.wifi || '', wifiPass: d0.wifiPass || '',
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
          city: f.city.trim(), hotel: f.hotel.trim(), wifi: f.wifi.trim(), wifiPass: f.wifiPass.trim(),
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
            field('Wifi', textIn('wifi', 'Network name')),
            field('Rooms', textIn('rooms', 'Under D. Oliver'))),
          field('Wifi password', textIn('wifiPass', 'Password')),
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
            setTimeout(function () { openOurBandSheet(tourId); }, 400);
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
    // A second flyer asks again, but travel days already on the run stay
    // exactly as they are unless the stepper is actually touched.
    var had = !!(G.parseDay(t.spanStart) || G.parseDay(t.spanEnd));
    var touched = false;
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
            onclick: function () { touched = true; set(Math.max(0, get() - 1)); refresh(); } }, '\u2212'),
          h('button', { class: 'seg-b', type: 'button', 'aria-label': 'More',
            onclick: function () { touched = true; set(Math.min(14, get() + 1)); refresh(); } }, '+'));
      }
      refresh();
      return [
        h('h2', { class: 'sh-title' }, 'Travel days'),
        h('p', { class: 'sh-sub' }, had
          ? 'The travel days you already set stay on the run. Add more only if these shows stretch the tour.'
          : 'Days on the road before the first show and after the last one. They join the run as off days you can fill in.'),
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
              if (!touched) { closeSheet(); done(); return; }
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
            onclick: function () { closeSheet(); done(); } }, had ? 'Keep as is' : 'Not now'))
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
    var had = !!(G.parseDay(f.start) && G.parseDay(f.end));
    var touched = false;
    openSheet(function () {
      function dateIn(key, label) {
        return field(label, h('input', { class: 'input', type: 'date', value: f[key],
          'aria-label': label, oninput: function (e) { touched = true; f[key] = e.target.value; } }));
      }
      return [
        h('h2', { class: 'sh-title' }, had ? 'Rehearsal days' : 'Rehearsal days before the tour?'),
        h('p', { class: 'sh-sub' }, had
          ? 'These are already on the run and stay put. Change the dates only if they moved.'
          : 'They join the run so day sheets and plans can start before the first show.'),
        h('form', { class: 'sh-form', novalidate: true,
          onsubmit: async function (e) {
            e.preventDefault();
            if (had && !touched) { closeSheet(); done(); return; }
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
              onclick: function () { closeSheet(); done(); } }, had ? 'Keep as is' : 'No rehearsals')))
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
              forgetCrew();
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
        var mine = !backend || (g.addedBy && g.addedBy === myUid);
        return guestRow(g, { canManage: canEditTour(tourId) || mine,
          onRemove: async function () {
            await removeGuest(tourId, showId, g.id);
            setTimeout(function () { openGuestList(tourId, showId); }, backend ? 500 : 150);
          } });
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
              h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), 'Import List')),
          rowsOut.length ? guestLedger(rowsOut) : null,
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
      loadOut: d0.loadOut || '', lobbyCall: d0.lobbyCall || '', busCall: d0.busCall || '',
      wifi: d0.wifi || '', wifiPass: d0.wifiPass || '', parking: d0.parking || '',
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

    // The venue's address (and phone) fill themselves in: straight from any
    // day sheet that already has this venue, or else looked up online while
    // the rest gets filled out. Never over anything typed.
    var inputs = {};
    var addrNote = h('span', { class: 'hint ds-found' }, '');
    var lookUp = false;
    if (!f.venueAddress.trim() && String(s.venue || '').trim()) {
      var known = knownVenue(s.venue, s.city, showId);
      if (known) {
        f.venueAddress = known.address;
        if (!f.venuePhone.trim() && known.phone) f.venuePhone = known.phone;
        addrNote.textContent = known.online ? 'Found online \u2014 worth a quick look' : 'From the last time you played here';
      } else if (S.sample) {
        lookUp = true;
        addrNote.textContent = 'Looking up the address\u2026';
      }
    }

    openSheet(function () {
      function textIn(key, ph) {
        return inputs[key] = h('input', { class: 'input', type: 'text', value: f[key], maxlength: 80,
          autocomplete: 'off', placeholder: ph || '',
          oninput: function (e) {
            f[key] = e.target.value;
            if (key === 'venueAddress') addrNote.textContent = '';
          } });
      }
      // A time: type the number ("6", "630", "6:30"), pick AM or PM, and it
      // posts as 6:00PM. Anything that isn't a time (TBA) is kept as typed.
      function clockIn(get, set, ph, defAmpm) {
        var p = G.splitTime(get());
        var main = p.main, ampm = p.ampm || defAmpm || 'PM';
        var push = function () { set(G.joinTime(main, ampm)); };
        var num = h('input', { class: 'input time-num', type: 'text', inputmode: 'decimal', value: main,
          maxlength: 12, autocomplete: 'off', placeholder: ph || '6', 'aria-label': 'Time',
          oninput: function (e) { main = e.target.value; push(); } });
        var ap = ampmSwitch(ampm, function (v) { ampm = v; push(); });
        var pickBtn = h('button', { class: 'time-pick', type: 'button', 'aria-label': 'Pick a time',
          onclick: function () {
            openTimePicker(G.joinTime(main, ampm), function (m, a) {
              main = m; num.value = m;
              Array.prototype.forEach.call(ap.children, function (b) { if (b.textContent === a) b.click(); });
              push();
            });
          } }, icon('chevron', 16));
        return h('div', { class: 'time-in' }, h('div', { class: 'time-box' }, num, pickBtn), ap);
      }
      function timeIn(key, ph, defAmpm) {
        return clockIn(function () { return f[key]; }, function (v) { f[key] = v; }, ph, defAmpm);
      }
      function bandList(key, addLabel) {
        var host = h('div', { class: 'ds-bands' });
        function build() {
          var kids = f[key].map(function (r, i) {
            return h('div', { class: 'af-row ds-band' },
              h('input', { class: 'input', type: 'text', value: r.band, maxlength: 60,
                placeholder: 'Band', autocomplete: 'off',
                oninput: function (e) { r.band = e.target.value; } }),
              clockIn(function () { return r.time; }, function (v) { r.time = v; }, 'Time'),
              h('button', { class: 'iconbtn sm', type: 'button', 'aria-label': 'Remove',
                onclick: function () { f[key].splice(i, 1); build(); } }, icon('trash', 16)));
          });
          kids.push(h('button', { class: 'btn quiet block', type: 'button', style: 'min-height:42px',
            onclick: function () { f[key].push({ band: '', time: '' }); build(); } }, addLabel));
          host.replaceChildren.apply(host, kids);
        }
        build();
        // Hold a band and drag it: the running order is the order they play.
        holdToReorder(host, '.ds-band', function (from, to) {
          var moved = f[key].splice(from, 1)[0];
          f[key].splice(to, 0, moved);
          build();
        });
        return host;
      }
      // A plain box, not a <label>: a label hands every stray tap to its
      // first input, so a tap between rows would jump to the top band.
      function group(label, control) {
        return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), control);
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
          loadOut: f.loadOut.trim(), lobbyCall: f.lobbyCall.trim(), busCall: f.busCall.trim(),
          wifi: f.wifi.trim(), wifiPass: f.wifiPass.trim(), parking: f.parking.trim(),
          driveNext: f.driveNext.trim(), notes: f.notes.trim(),
          soundchecks: clean(f.soundchecks), setTimes: clean(f.setTimes)
        };
        G.DS_AMENITIES.forEach(function (a) { sheet[a[0]] = f[a[0]] || ''; });
        // When it went up (Ari's DAY SHEET AVAILABLE waits for show day) and the
        // poster's time zone (a backup for reading the times, after the city).
        sheet.postedAt = Date.now();
        try { sheet.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e2) { sheet.tz = ''; }
        var patch = {};
        patch[showId] = { daySheet: sheet };
        if (await api.update(tourId, { shows: patch })) {
          closeSheet(); toast('Day sheet posted'); render(true);
          if (window.GR_BACKEND && window.GR_BACKEND.ariKick) window.GR_BACKEND.ariKick(tourId);
          // Most runs keep the same set times every night — offer to carry them.
          if (sheet.setTimes.length) askSetTimesEverywhere(tourId, showId, sheet.setTimes);
        }
      };
      return [
        h('h2', { class: 'sh-title clean' }, 'Day sheet \u2014 ' + (s.city || 'Show')),
        h('p', { class: 'sh-sub clean' }, 'Everything the bus needs for the day. Leave anything blank and it just doesn\u2019t show.'),
        h('form', { class: 'sh-form ds-editor', onsubmit: submit, novalidate: true },
          h('h3', { class: 'ds-sec-h' }, 'Venue'),
          h('div', { class: 'field' },
            h('label', { class: 'field-label', for: 'ds-addr' }, 'Venue address'),
            Object.assign(textIn('venueAddress', '2115 Woodward Ave'), { id: 'ds-addr' }), addrNote),
          field('Venue phone', textIn('venuePhone', '(313) 961-5451')),
          field('Wifi', textIn('wifi', 'Network name')),
          field('Wifi password', textIn('wifiPass', 'Password')),
          field('Parking', textIn('parking', 'Load in off 4th St alley, bus on the north lot')),
          // The schedule, in the order the day happens.
          h('h3', { class: 'ds-sec-h' }, 'Schedule'),
          h('div', { class: 'field-row' },
            field('Lobby call', timeIn('lobbyCall', '11', 'AM')),
            field('Load in', timeIn('loadIn', '2'))),
          group('Soundchecks', bandList('soundchecks', '+ Add a band\u2019s soundcheck')),
          field('VIP', textIn('vip', '6:00 PM meet & greet')),
          h('div', { class: 'field-row' },
            field('Doors', timeIn('doors', '7')), h('div', null)),
          group('Set times', bandList('setTimes', '+ Add a band\u2019s set time')),
          h('div', { class: 'field-row' },
            field('Load out', timeIn('loadOut', '11:30')),
            field('Bus call', timeIn('busCall', '1', 'AM'))),
          field('Drive time to next venue', textIn('driveNext', '4h 20m \u2014 285 mi')),
          h('h3', { class: 'ds-sec-h' }, 'Amenities'),
          h('div', { class: 'ds-yns' }, G.DS_AMENITIES.map(function (a) { return yesNo(a[0], a[1]); })),
          field('Anything else', textIn('notes', 'Optional')),
          h('div', { class: 'stack' },
            h('button', { class: 'btn primary block', type: 'submit' }, 'Post day sheet'),
            h('button', { class: 'btn ghost block', type: 'button',
              onclick: function () { closeSheet(); } }, 'Cancel')))
      ];
    }, { label: 'Day sheet' });

    if (!lookUp) return;
    lookupVenue(s.venue, s.city).then(function (got) {
      var filled = false;
      if (got.address && !f.venueAddress.trim()) {
        f.venueAddress = got.address;
        if (inputs.venueAddress) inputs.venueAddress.value = got.address;
        filled = true;
      }
      if (got.phone && !f.venuePhone.trim()) {
        f.venuePhone = got.phone;
        if (inputs.venuePhone) inputs.venuePhone.value = got.phone;
      }
      if (addrNote.textContent.indexOf('Looking') === 0) {
        addrNote.textContent = filled ? 'Found online \u2014 worth a quick look' : '';
      }
    }, function () {
      if (addrNote.textContent.indexOf('Looking') === 0) addrNote.textContent = '';
    });
  }

  // A venue already on a day sheet somewhere (this tour or any other), or
  // found online earlier this session.
  function venueKey(venue, city) {
    return String(venue || '').trim().toLowerCase() + '|' + String(city || '').trim().toLowerCase();
  }
  function knownVenue(venue, city, skipShowId) {
    var key = venueKey(venue, city);
    var hit = null;
    S.tours.forEach(function (tour) {
      G.rows(tour && tour.shows).forEach(function (x) {
        if (hit || x.id === skipShowId || venueKey(x.venue, x.city) !== key) return;
        var d = G.isObj(x.daySheet) ? x.daySheet : {};
        var addr = String(d.venueAddress || '').trim();
        if (addr) hit = { address: addr, phone: String(d.venuePhone || '').trim() };
      });
    });
    if (hit) return hit;
    var c = S.venueCache && S.venueCache[key];
    return c && c.address ? Object.assign({ online: true }, c) : null;
  }
  function venueLookupPrompt(venue, city) {
    return [
      'Look up this concert venue with web search and give its street address and main phone number.',
      'Venue: ' + venue + (city ? ' \u2014 ' + city : ''),
      'Go by the venue\u2019s own website or its official listing. If you cannot confirm a field, use null for it \u2014 never guess.',
      'Reply with only a JSON object in this exact shape:',
      '{"address":"2115 Woodward Ave, Detroit, MI 48201","phone":"(313) 961-5451"}'
    ].join('\n');
  }
  async function lookupVenue(venue, city) {
    var key = venueKey(venue, city);
    S.venueCache = S.venueCache || {};
    if (S.venueCache[key]) return S.venueCache[key];
    var clean = function (v, n) {
      v = String(v == null ? '' : v).trim();
      return /^(null|none|n\/a|unknown)$/i.test(v) ? '' : v.slice(0, n);
    };
    var out = await S.sample.json(venueLookupPrompt(venue, city),
      window.GR_BACKEND ? { cache: false, search: true } : { cache: false });
    if (Array.isArray(out)) out = out[0];
    var got = { address: G.isObj(out) ? clean(out.address, 120) : '', phone: G.isObj(out) ? clean(out.phone, 40) : '' };
    if (got.address || got.phone) S.venueCache[key] = got;
    return got;
  }

  /* ============================== Income ============================== */

  /* Buyouts: tick each person as they get theirs. The venue's total, split
     per person; what the crew gets passes through, and only the Artists'
     share is the band's income. */
  function buyoutPaidCount(track) {
    var p = G.isObj(track) && G.isObj(track.paid) ? track.paid : {};
    return Object.keys(p).filter(function (k) { return G.isObj(p[k]); }).length;
  }
  // Shows before today whose buyouts aren't all handed out: nobody ticked
  // yet, or fewer ticked than the venue paid for.
  function buyoutsOwed(t) {
    var today = G.tourToday();
    return G.rows(t && t.shows).filter(function (sh) {
      var total = G.num(G.isObj(sh.income) ? sh.income.buyouts : 0);
      if (!G.parseDay(sh.date) || sh.date >= today || !(total > 0)) return false;
      var per = G.isObj(sh.buyoutTrack) ? G.num(sh.buyoutTrack.perHead) : 0;
      var paid = buyoutPaidCount(sh.buyoutTrack);
      return !paid || (per > 0 && paid < Math.round(total / per));
    }).sort(G.byDate);
  }
  function saveBuyouts(id, sh, next) {
    var patch = { shows: {} };
    patch.shows[sh.id] = { buyoutTrack: next };
    api.update(id, patch).then(function (ok) { if (ok) { toast('Buyouts saved'); render(true); } });
  }
  /* BUYOUT ALERT, top-left of the Overview: it glows and pulses while someone
     from an earlier show still hasn't had their buyout. */
  function buyoutAlertBtn(id, t) {
    if (!canEditTour(id)) return null;
    var owed = buyoutsOwed(t);
    return h('div', { class: 'bo-wrap' }, h('button', { class: 'btn sm bo-alert' + (owed.length ? ' on' : ''), type: 'button',
      onclick: function () {
        if (!owed.length) { toast('Everyone has their buyouts'); return; }
        if (owed.length === 1) {
          var one = owed[0];
          openBuyoutTracker(id, one, G.num(one.income.buyouts), one.buyoutTrack, function (next) { saveBuyouts(id, one, next); });
          return;
        }
        openSheet(function () {
          return [
            h('h2', { class: 'sh-title' }, 'BUYOUT ALERT'),
            h('p', { class: 'sh-sub' }, 'These shows still have people waiting on their buyout.'),
            h('div', { class: 'ledger' }, owed.map(function (sh) {
              var per = G.isObj(sh.buyoutTrack) ? G.num(sh.buyoutTrack.perHead) : 0;
              var paid = buyoutPaidCount(sh.buyoutTrack);
              return h('button', { class: 'row rowbtn', type: 'button', onclick: function () {
                closeSheet();
                openBuyoutTracker(id, sh, G.num(sh.income.buyouts), sh.buyoutTrack, function (next) { saveBuyouts(id, sh, next); });
              } },
                h('div', { class: 'row-label' }, (sh.city || 'Show') + ' \u00b7 ' + dayMD(sh.date),
                  h('span', { class: 'hint' }, paid ? paid + ' of ' + Math.round(G.num(sh.income.buyouts) / per) + ' paid' : 'Nobody ticked yet')),
                h('span', { class: 'amt num' }, money(G.num(sh.income.buyouts))), icon('chevron', 18));
            }))
          ];
        }, { label: 'Buyout alert' });
      } }, icon('bell', 15), 'BUYOUT ALERT'));
  }

  function openBuyoutTracker(id, show, total, track, done) {
    var B = window.GR_BACKEND;
    var t = getTour(id);
    var cur = { perHead: G.isObj(track) ? track.perHead : null, paid: {} };
    var before = G.isObj(track) && G.isObj(track.paid) ? track.paid : {};
    Object.keys(before).forEach(function (k) { if (G.isObj(before[k])) cur.paid[k] = before[k]; });
    var people = [];
    var seen = {};
    function add(name, role, key) {
      name = String(name || '').trim();
      if (!name) return;
      var k = key || 'n:' + name.toLowerCase();
      if (seen[k] || seen['n:' + name.toLowerCase()]) return;
      seen[k] = true; seen['n:' + name.toLowerCase()] = true;
      people.push({ key: k, name: name, role: String(role || ''), artist: /artist/i.test(String(role || '')) });
    }
    // Anyone already ticked stays on the list, even if they've left the tour.
    Object.keys(cur.paid).forEach(function (k) {
      var x = cur.paid[k];
      if (G.isObj(x)) add(x.name, x.artist ? 'Artist' : '', k);
    });
    var pop = h('div', { class: 'pop', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Track buyouts' });
    var listEl = h('div', { class: 'ledger bo-list' });
    var perIn = null;
    var foot = h('p', { class: 'bo-foot' });
    function perHead() { return G.num(cur.perHead) > 0 ? G.num(cur.perHead) : (people.length ? Math.round(total / people.length * 100) / 100 : 0); }
    function drawFoot() {
      var artists = people.filter(function (p) { return p.artist && cur.paid[p.key]; }).length;
      var got = Object.keys(cur.paid).length;
      foot.textContent = (got === 1 ? '1 person' : got + ' people') + ' paid \u00b7 ' + money(Math.min(total, perHead() * artists)) +
        ' counts as income (' + plural(artists, 'Artist') + ')';
    }
    function drawList() {
      listEl.replaceChildren.apply(listEl, people.length ? people.map(function (p) {
        var cb = h('input', { type: 'checkbox', class: 'rv-check', checked: !!cur.paid[p.key],
          'aria-label': p.name + ' has their buyout',
          onchange: function (e) {
            if (e.target.checked) cur.paid[p.key] = { name: p.name, artist: p.artist };
            else delete cur.paid[p.key];
            drawFoot();
          } });
        return h('label', { class: 'row bo-row' }, cb,
          h('span', { class: 'row-label' }, p.name, h('span', { class: 'hint' }, p.role || 'Crew')),
          p.artist ? h('span', { class: 'src-tag src-plaid' }, 'INCOME') : h('span', { class: 'hint' }, 'passes through'));
      }) : [h('div', { class: 'row' }, h('span', { class: 'hint' }, 'No crew on this tour yet. Invite them from the Overview, or add crew under Expenses.'))]);
      drawFoot();
    }
    function close(save) {
      if (save) {
        cur.perHead = perHead();
        Object.keys(before).forEach(function (k) { if (!cur.paid[k]) cur.paid[k] = null; });
        done(cur);
      }
      pop.classList.remove('on');
      setTimeout(function () { pop.remove(); }, 250);
    }
    perIn = moneyInput({ id: 'bo-per', value: perHead(), label: 'Buyout per person', last: true,
      onValue: function (v) { cur.perHead = v > 0 ? v : null; drawFoot(); } });
    pop.append(h('div', { class: 'pop-card' },
      h('h2', { class: 'sh-title' }, 'Buyouts'),
      h('p', { class: 'sh-sub' }, money(total) + ' from the venue' + (show.city ? ' in ' + show.city : '') +
        '. Tick each person as they get theirs. The crew\u2019s pass through to them; only the Artists\u2019 count as income.'),
      field('Buyout per person', perIn),
      listEl,
      foot,
      h('div', { class: 'stack' },
        h('button', { class: 'btn primary block', type: 'button', onclick: function () { close(true); } }, 'Done'),
        h('button', { class: 'btn ghost block', type: 'button', onclick: function () { close(false); } }, 'Cancel'))));
    document.body.appendChild(pop);
    requestAnimationFrame(function () { pop.classList.add('on'); });
    // The crew on the Overview (with their roles), then crew listed under Expenses.
    G.rows(t && t.crew).forEach(function (c) { add(c.name, c.title); });
    drawList();
    var cached = S.crewCache && S.crewCache[id];
    function fromMembers(rows) {
      (rows || []).forEach(function (m) { add(m.name || m.username || m.email, m.tourRole, m.email ? 'e:' + String(m.email).toLowerCase() : null); });
      people.sort(function (a, b) { return (b.artist ? 1 : 0) - (a.artist ? 1 : 0) || a.name.localeCompare(b.name); });
      if (!(G.num(cur.perHead) > 0) && perIn) {
        var inp = perIn.querySelector ? perIn.querySelector('input') : null;
        if (inp) inp.value = (Math.round(perHead() * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
      }
      drawList();
    }
    if (cached) fromMembers(cached.rows);
    else if (B && B.crew && S.mode === 'db') B.crew(id).then(fromMembers).catch(function () { /* the Expenses crew is enough */ });
  }

  // ", $500 booking agent's commission, $250 taxes withheld" for a read-only line.
  function guaranteeWhyText(why) {
    var bits = G.GUARANTEE_REASONS.filter(function (r) { return G.num(why && why[r.key]) > 0; })
      .map(function (r) { return money(why[r.key]) + ' ' + r.label.charAt(0).toLowerCase() + r.label.slice(1); });
    return bits.length ? ' \u00b7 ' + bits.join(', ') : '';
  }
  function openIncome(id, showId) {
    var t = getTour(id);
    var s = t && G.isObj(t.shows) && G.isObj(t.shows[showId]) ? t.shows[showId] : null;
    if (!s) return;
    var draft = {};
    G.INCOME_FIELDS.forEach(function (f) {
      draft[f.key] = G.num(G.isObj(s.income) ? s.income[f.key] : 0);
    });
    // Taxes withheld come out of the guarantee. The full guarantee is what's
    // typed; what's logged (and counted everywhere) is the guarantee less the
    // tax, with the tax kept beside it.
    var tax = Math.max(0, G.num(s.taxWithheld));
    var gross = draft.guarantee + tax;
    /* The guarantee that was agreed and what actually reached the bank are
       often different. The sheet keeps both — Guarantee Total and Deposit
       Amount — and when they differ asks why: dollars by reason (taxes
       withheld are one of them). */
    var why = G.guaranteeWhy(s);
    var whyNote = String(s.guaranteeWhyNote || '');
    var dep = s.guaranteeDeposit != null && G.num(s.guaranteeDeposit) > 0 ? Math.round(G.num(s.guaranteeDeposit) * 100) / 100 : null;
    // The amount the bank itself showed (matched by the feed, or catalogued from Cards).
    var depSeen = dep != null && s.guaranteeReceivedAt ? dep : null;
    var agentRule = G.normCommission(t && t.commission).agent;
    var agentPct = agentRule && agentRule.mode === 'pct' ? Math.max(0, Math.min(100, G.num(agentRule.value))) / 100 : 0;
    // How the guarantee is paid: a check, straight into the bank, or to the agency first.
    var PAID_BY = [['check', 'Check'], ['direct', 'Direct Deposit'], ['agency', 'Agency Deposit']];
    var paidBy = PAID_BY.some(function (x) { return x[0] === s.guaranteePaidBy; }) ? s.guaranteePaidBy : null;
    var miscLabel = String((G.isObj(s.income) && s.income.miscLabel) || '');
    // Who has their buyout (only the Artists' count as income).
    var track = G.isObj(s.buyoutTrack) ? JSON.parse(JSON.stringify(s.buyoutTrack)) : null;
    var settNotes = Array.isArray(s.settlementNotes)
      ? JSON.parse(JSON.stringify(s.settlementNotes)) : [];
    // Merch cash collected at the table, and whether each payment has landed.
    // A night logged before the Received boxes existed reads as received.
    var merchCash = G.num(s.merchCash);
    // atVenu's card payout for the night (card sales less fees), when the
    // Settlement showed it. That is the deposit to watch for.
    var merchCardDeposit = s.merchCardDeposit != null ? G.num(s.merchCardDeposit) : null;
    var legacy = !!s.loggedAt;
    /* A Received box ticked beside an EMPTY line means "nothing to wait for
       here" (no merch table, no guarantee): the night can still read as
       paid. It is kept in keys of its own, guaranteeNone / merchNone, so
       guaranteeReceived / merchReceived go on meaning "this money has
       landed" for the bank matchers and the atVenu readers. noneBy: the
       tick on each line is that kind. noneStored: it came with the show, so
       it gives way the moment an amount turns up on its line. */
    var noneBy = { guarantee: !(gross > 0) && s.guaranteeNone === true, merch: !(draft.merch > 0) && s.merchNone === true };
    var noneStored = { guarantee: noneBy.guarantee, merch: noneBy.merch };
    // Ticked only when the show says so: a night logged before the boxes
    // existed opens unticked, and reads red until someone ticks it.
    var recv = {
      guarantee: s.guaranteeReceived === true || noneBy.guarantee,
      merch: s.merchReceived === true || noneBy.merch
    };
    // A deposit only stands beside a received guarantee.
    if (!recv.guarantee) { dep = null; depSeen = null; }
    // As saved: when the deposit is raised by hand, the extra comes off what
    // the promoter still owed (the same thing a second payment catalogued
    // from the bank does), unless the owed amount was set by hand just now.
    var dep0 = dep, owed0 = G.num(why.owed), owedTouched = false;
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
                  f.key === 'misc' && miscLabel ? h('span', { class: 'hint' }, miscLabel) : null,
                  f.key === 'guarantee' && tax > 0 ? h('span', { class: 'hint' }, 'After ' + money(tax) + ' taxes withheld') : null,
                  f.key === 'guarantee' && dep != null && Math.abs(gross - dep) >= 0.005 ? h('span', { class: 'hint' },
                    money(dep) + ' deposited of ' + money(gross) + guaranteeWhyText(why)) : null,
                  f.key === 'guarantee' && paidBy ? h('span', { class: 'hint' }, 'Paid by ' +
                    PAID_BY.filter(function (x) { return x[0] === paidBy; })[0][1].toLowerCase()) : null),
                h('span', { class: 'amt num' }, money(draft[f.key])));
            }),
            h('div', { class: 'row total' },
              h('span', null, 'This show'),
              h('strong', { class: 'amt num' }, money(G.showIncomeTotal(s))))),
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
        showEl.textContent = money(G.showIncomeTotal(Object.assign({ income: draft }, currentFlags())));
        var c2 = G.calc(cur, { override: { showId: showId, income: draft, flags: currentFlags() } });
        afterEl.textContent = money(c2.net, true);
        afterEl.className = 'num ' + (G.round(c2.net) < 0 ? 'neg' : 'pos');
      }
      var saveBtn = h('button', { class: 'btn primary block', type: 'button' }, 'Save income');
      pressable(saveBtn, function (e) { save(e); });
      var saveNow = async function (e) {
        e.preventDefault();
        blurActive();
        var total = G.showIncomeTotal({ income: draft, buyoutTrack: track });
        var before = G.calc(getTour(id) || t).net;
        var flagsNow = currentFlags();
        var income = Object.assign({}, draft);
        income.miscLabel = draft.misc > 0 ? miscLabel.trim() : '';
        var patch = {};
        var due = G.merchDue({ income: draft, merchCash: merchCash, merchCardDeposit: merchCardDeposit });
        var anyLogged = G.INCOME_FIELDS.some(function (f) { return G.num(draft[f.key]) > 0; });
        patch[showId] = { income: income, loggedAt: total > 0 || anyLogged ? Date.now() : null,
          buyoutTrack: draft.buyouts > 0 && track ? track : null,
          settlementNotes: settNotes.length ? settNotes : null,
          merchCash: draft.merch > 0 && merchCash > 0 ? merchCash : null,
          merchCardDeposit: draft.merch > 0 && merchCardDeposit != null ? merchCardDeposit : null,
          guaranteeReceived: draft.guarantee > 0 ? !!recv.guarantee : null,
          // A tick made by hand beside an empty line ("nothing to wait for
          // here"): the night only reads as paid when both are ticked.
          guaranteeNone: !(gross > 0) && recv.guarantee && noneBy.guarantee ? true : null,
          merchNone: !(draft.merch > 0) && recv.merch && noneBy.merch ? true : null,
          taxWithheld: tax > 0 && gross > 0 ? Math.min(tax, gross) : null,
          guaranteePaidBy: gross > 0 ? paidBy : null,
          guaranteeWhy: whyOut(true),
          guaranteeWhyNote: G.num(effWhy().other) > 0 && whyNote.trim() ? whyNote.trim().slice(0, 80) : null,
          // All-cash merch has no deposit to wait for.
          merchReceived: draft.merch > 0 ? (due > 0 ? !!recv.merch : true) : null };
        if (!(draft.merch > 0 && due > 0 && recv.merch)) {
          patch[showId].merchReceivedAt = null;
          patch[showId].merchDeposit = null;
        }
        // The deposit goes with a received guarantee (unticking clears it), and
        // the bank's date stays only beside the amount the bank itself showed.
        var hasDep = depKept() != null;
        patch[showId].guaranteeDeposit = hasDep ? dep : null;
        // The "why" question has been on the sheet for this deposit.
        patch[showId].guaranteeWhyAsked = hasDep && listOn() ? true : null;
        if (!hasDep || depSeen == null || dep !== depSeen) patch[showId].guaranteeReceivedAt = null;
        // What the bank itself has shown for this guarantee (kept by the
        // database as deposits are catalogued) goes when the deposit goes,
        // and stays on record when the amount is corrected by hand.
        if (!hasDep) patch[showId].guaranteeSeen = null;
        else if (depSeen != null && dep !== depSeen && s.guaranteeSeen == null) patch[showId].guaranteeSeen = depSeen;
        if (!(await api.update(id, { shows: patch }))) return;
        closeSheet();
        var after = G.calc(getTour(id) || t, { override: { showId: showId, income: draft, flags: flagsNow } }).net;
        var r = G.round(after);
        if (G.round(before) < 0 && r >= 0) sendNotify(id, 'green', { net: money(r, true) });
        if (G.round(before) < 0 && r >= 0) toast('Income saved. You’re in the green.');
        else if (r < 0) toast('Income saved. ' + money(-r) + ' to break even.');
        else toast('Income saved. ' + money(r) + ' in the green.');
        render(true);
      };
      // One save at a time: a second tap while the first is on its way does nothing.
      var saving = false;
      var save = async function (e) {
        if (saving) { if (e && e.preventDefault) e.preventDefault(); return; }
        saving = true; saveBtn.disabled = true; saveBtn.textContent = 'Saving\u2026';
        try { await saveNow(e); }
        finally { saving = false; saveBtn.disabled = false; saveBtn.textContent = 'Save income'; }
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
      function currentFlags() {
        return { guaranteePaidBy: gross > 0 ? paidBy : null, guaranteeReceived: draft.guarantee > 0 ? !!recv.guarantee : null,
          merchReceived: draft.merch > 0 ? !!recv.merch : null, merchCash: merchCash,
          merchCardDeposit: merchCardDeposit, buyoutTrack: track,
          // What's still owed, and commission taken off the top, change the tour's numbers too.
          taxWithheld: tax, guaranteeWhy: whyOut(false), guaranteeDeposit: depKept() };
      }
      var perHeadEl = h('span', { class: 'amt num mx-val' }, '');
      function updatePerHead() {
        var hit = (settNotes || []).filter(function (x) { return /per head/i.test(x.label); })[0];
        perHeadEl.textContent = hit ? hit.value : '\u2014';
        perHeadEl.classList.toggle('known', !!hit);
      }
      updatePerHead();
      // Received ticked by the sheet itself (Agency Deposit chosen, or a
      // deposit amount typed) rather than by hand: it goes back when that is
      // undone, so a mis-tap never leaves a guarantee counted as in hand.
      var recvAuto = false;
      function autoReceived() {
        var need = paidBy === 'agency' || dep != null;
        if (need && !recv.guarantee) { recv.guarantee = true; recvAuto = true; }
        else if (!need && recvAuto) { recv.guarantee = false; recvAuto = false; }
        else return;
        var rb = document.getElementById('rcv-guarantee');
        if (rb) rb.checked = recv.guarantee;
      }
      // The deposit an untick put aside, so ticking Received again brings it back.
      var depAside = null;
      // An amount has turned up on a line (typed, or read from a settlement).
      // A "nothing to wait for" tick that came with the show was about an
      // empty line, so it goes: the money now on the line isn't received
      // until someone says so. One made in this sitting stays, as a plain
      // Received.
      function amountLanded(key) {
        if (!((key === 'guarantee' ? gross : draft.merch) > 0)) {
          // The line is empty again: a tick still showing beside it (one made
          // by hand, not by the sheet) now means "nothing to wait for here".
          if (recv[key] && !(key === 'guarantee' && recvAuto)) noneBy[key] = true;
          return;
        }
        if (noneStored[key]) {
          recv[key] = false;
          var rb = document.getElementById('rcv-' + key);
          if (rb) rb.checked = false;
        }
        noneStored[key] = false; noneBy[key] = false;
      }
      // "Received" beside a payment: ticked means the money is in hand.
      function receivedBox(key, what) {
        var cb = h('input', { type: 'checkbox', class: 'rcv-check', id: 'rcv-' + key,
          'aria-label': what + ' received' });
        cb.checked = !!recv[key];
        cb.addEventListener('change', function () {
          recv[key] = cb.checked;
          // Ticked by hand beside an empty line: "nothing to wait for here".
          noneBy[key] = cb.checked && !((key === 'guarantee' ? gross : draft.merch) > 0);
          noneStored[key] = false;
          if (key === 'guarantee') {
            // Ticked or unticked by hand: it's the person's call from here.
            recvAuto = false;
            var de = depInput.querySelector('input');
            if (!cb.checked && dep != null) {
              // Not received means nothing reached the bank...
              depAside = dep; dep = null;
              if (de) de.value = '';
            } else if (cb.checked && dep == null && depAside != null) {
              // ...and ticking it again is an undo: the deposit comes back,
              // and with it the reasons and the bank's date.
              dep = depAside; depAside = null;
              if (de) de.value = fmtInput(dep);
            }
            syncWhy();
          }
          refresh(); updateDeposit();
        });
        return h('label', { class: 'rcv', for: 'rcv-' + key }, cb, h('span', null, 'Received'));
      }
      // What should land in the bank: the net, less the cash already in hand.
      var depositHint = h('span', { class: 'hint' }, '');
      var depositAmt = h('span', { class: 'amt num mx-val' }, '');
      var depositRow = h('div', { class: 'row mx-row' },
        h('div', { class: 'row-label' }, 'Deposit', depositHint),
        depositAmt);
      // The night as Square saw it (MODEL7MERCH): taps, tips, and the net once known.
      var ms = G.isObj(s.merchSquare) ? s.merchSquare : null;
      var squareRow = !ms ? null : h('div', { class: 'row mx-row' },
        h('div', { class: 'row-label' }, 'Square' + (ms.env !== 'production' ? ' (test)' : ''),
          h('span', { class: 'hint' }, plural(G.num(ms.taps), 'tap') + ' \u00b7 incl. ' + money(G.num(ms.tips)) + ' tips' +
            (G.num(ms.refunds) > 0 ? ' \u00b7 ' + money(G.num(ms.refunds)) + ' refunded' : '') +
            (ms.net != null ? ' \u00b7 ' + money(G.num(ms.net)) + ' after fees' : ''))),
        h('span', { class: 'amt num mx-val known' }, money(G.num(ms.sales) - G.num(ms.refunds))));
      function updateDeposit() {
        var due = G.merchDue({ income: draft, merchCash: merchCash, merchCardDeposit: merchCardDeposit });
        depositRow.hidden = !(draft.merch > 0 && due > 0);
        var landed = recv.merch && s.merchReceivedAt && G.num(s.merchDeposit) > 0;
        var off = landed && merchCardDeposit != null ? Math.round((G.num(s.merchDeposit) - merchCardDeposit) * 100) / 100 : 0;
        depositHint.textContent = landed
          ? 'Landed ' + dayMD(s.merchReceivedAt) + ' \u00b7 seen in the bank' +
            (Math.abs(off) > Math.max(5, merchCardDeposit * 0.03)
              ? ' \u00b7 ' + money(Math.abs(off)) + (off > 0 ? ' more' : ' less') + ' than the Settlement' + (off > 0 ? ' (card tips?)' : '')
              : '')
          : merchCardDeposit != null
            ? 'atVenu card payout (sales + tips \u2212 fees), usually lands 3 business days after'
            : 'Net minus cash, due in the bank';
        depositAmt.textContent = money(landed ? G.num(s.merchDeposit) : due);
        depositAmt.classList.toggle('known', !!recv.merch);
      }
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
            if (k === 'guarantee') { gross = G.num(r.income[k]); amountLanded('guarantee'); followGap(); syncWhy(); }
            if (k === 'merch') amountLanded('merch');
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
          amountLanded('merch');
          var el = document.getElementById('inc-merch');
          if (el) el.value = (Math.round(r.income.merch * 100) / 100)
            .toLocaleString('en-US', { maximumFractionDigits: 2 });
        }
        // The card payout replaces the net-minus-cash guess; a venue-run card
        // table means nothing comes from atVenu.
        if (r.cardDeposit != null) merchCardDeposit = r.cardDeposit;
        else if (r.cardsBy === 'venue') merchCardDeposit = null;
        if (r.cash != null) {
          merchCash = r.cash;
          var ce = document.getElementById('inc-merch-cash');
          if (ce) ce.value = r.cash ? (Math.round(r.cash * 100) / 100)
            .toLocaleString('en-US', { maximumFractionDigits: 2 }) : '';
        }
        updateDeposit();
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

      var buyoutHint = h('span', { class: 'hint' }, '');
      function updateBuyouts() {
        var counted = G.buyoutIncome({ income: draft, buyoutTrack: track });
        var paid = buyoutPaidCount(track);
        buyoutHint.textContent = !(draft.buyouts > 0) ? 'Only the Artists\u2019 buyouts count as income'
          : !paid ? 'Tap Track: only what the Artists get counts as income'
          : money(counted) + ' counts as income \u00b7 ' + (paid === 1 ? '1 person' : paid + ' people') + ' paid';
      }
      updateBuyouts();
      // The note under Paid by, filled in where the boxes are built.
      var sayAgency = function () {};
      // Under the guarantee: the taxes withheld, and what's left to log.
      var netAmt = h('span', { class: 'amt num mx-val known' }, '');
      var netHint = h('span', { class: 'hint' }, '');
      var netRow = h('div', { class: 'row mx-row' },
        h('div', { class: 'row-label' }, 'Guarantee logged', netHint), netAmt);
      function syncGuarantee() {
        draft.guarantee = Math.max(0, Math.round((gross - tax) * 100) / 100);
        // Counted the way the book counts it, so the sheet and the tour agree.
        var as = { income: { guarantee: draft.guarantee }, taxWithheld: tax, guaranteePaidBy: paidBy,
          guaranteeReceived: !!recv.guarantee, guaranteeDeposit: depKept(), guaranteeWhy: whyOut(false) };
        var owed = G.guaranteeOwed(as), lost = G.guaranteeLost(as);
        netRow.hidden = !(tax > 0 || owed > 0 || lost > 0);
        netAmt.textContent = money(draft.guarantee - owed - lost);
        netHint.textContent = tax > gross ? 'The taxes are more than the guarantee'
          : money(gross) + [tax > 0 ? ' less ' + money(tax) + ' withheld' : '', owed > 0 ? ' less ' + money(owed) + ' still owed' : '',
            lost > 0 ? ' less ' + money(lost) + ' that won\u2019t arrive' : ''].join('');
        sayAgency();
      }
      var r2 = function (v) { return Math.round(G.num(v) * 100) / 100; };
      // The gap between the two numbers; reasons only count while there is one.
      function shortNow() { return dep != null && gross > 0 ? r2(gross - dep) : 0; }
      // The reasons are asked for (and kept) only while the deposit is short.
      function listOn() { return paidBy !== 'agency' && gross > 0 && dep != null && shortNow() >= 0.005; }
      // The deposit as it's saved: it goes with a received guarantee.
      function depKept() { return draft.guarantee > 0 && recv.guarantee && paidBy !== 'agency' && dep != null ? dep : null; }
      function effWhy() { return listOn() && depKept() != null ? why : {}; }
      function whySum() { var w = effWhy(); return Object.keys(w).reduce(function (n, k) { return n + G.num(w[k]); }, 0); }
      // As it's saved: every reason by name, the unticked ones cleared (forSave)
      // or just the ticked ones (for the live preview).
      function whyOut(forSave) {
        var w = effWhy(), out = {}, any = false;
        G.GUARANTEE_REASONS.forEach(function (r) {
          var v = r2(w[r.key]);
          if (v > 0) { out[r.key] = v; any = true; } else if (forSave) out[r.key] = null;
        });
        return any ? out : (forSave ? null : {});
      }
      // Taxes are one of the reasons, but they stand without a gap too: they
      // come off the guarantee whatever the deposit turns out to be. So the
      // tax is whatever is on the sheet, never a by-product of the deposit.
      function setTax() { tax = gross > 0 ? Math.max(0, G.num(why.tax)) : 0; }
      // The tax box of its own, shown whenever the reasons list isn't.
      var taxInput = moneyInput({
        id: 'inc-tax', value: tax, label: 'Taxes withheld', nextId: 'inc-backend',
        onValue: function (v) { if (v > 0) why.tax = r2(v); else delete why.tax; setTax(); syncGuarantee(); refresh(); }
      });
      var taxRow = h('div', { class: 'row mx-row' },
        h('label', { class: 'row-label', for: 'inc-tax' }, 'Taxes withheld',
          h('span', { class: 'hint' }, 'Comes off the guarantee logged')), taxInput);
      function syncTaxRow() {
        taxRow.hidden = listOn() || !(gross > 0);
        var te = taxInput.querySelector('input');
        if (te && document.activeElement !== te) te.value = G.num(why.tax) > 0 ? fmtInput(G.num(why.tax)) : '';
      }
      var depHint = h('span', { class: 'hint' }, '');
      var depInput = moneyInput({
        id: 'inc-deposit', value: dep, label: 'Deposit Amount', nextId: 'inc-backend',
        onValue: function (v) {
          // A deposit typed (or emptied) by hand wins over one put aside.
          depAside = null;
          dep = v > 0 ? r2(v) : null;
          if (dep0 != null && owed0 > 0 && !owedTouched) {
            var o2 = r2(owed0 - Math.max(0, G.num(dep) - dep0));
            if (o2 > 0) why.owed = o2; else delete why.owed;
          }
          // Money in the bank is money received.
          autoReceived();
          followGap(); syncWhy(); refresh();
        }
      });
      var depRow = h('div', { class: 'row mx-row' },
        h('label', { class: 'row-label', for: 'inc-deposit' }, 'Deposit Amount', depHint), depInput);
      var whyHost = h('div', { class: 'gw' });
      var leftLine = h('p', { class: 'gw-left' });
      // A lone reason ticked just now, taking the whole gap, follows it as the
      // numbers change. Amounts that were saved earlier never move by themselves.
      var autoKey = null;
      // The booking-agent guess is offered once; after any reason has been
      // touched by hand it never comes back.
      // (Once per show, not per opening: a save with the list on the sheet
      // marks the question as asked.)
      var whyTouched = !!s.guaranteeWhyAsked;
      function followGap() {
        var keys = Object.keys(why);
        if (!autoKey || keys.length !== 1 || keys[0] !== autoKey) return;
        var sh = shortNow();
        // An untouched lone reason can only be the agent guess (a tick by
        // hand counts as touching): it stands while the gap is still the
        // agent's cut, and is withdrawn the moment it isn't.
        if (!whyTouched && !(sh > 0 && Math.abs(sh - gross * agentPct) <= 1)) { delete why[autoKey]; autoKey = null; return; }
        if (sh > 0) why[autoKey] = sh;
      }
      function sayLeft() {
        var left = r2(shortNow() - whySum());
        leftLine.className = 'gw-left' + (Math.abs(left) >= 0.005 ? ' warn' : '');
        leftLine.textContent = left >= 0.005 ? G.moneyCents(left) + ' not explained yet'
          : left <= -0.005 ? 'That\u2019s ' + G.moneyCents(-left) + ' more than what\u2019s missing'
          : 'All accounted for';
      }
      var WHY_HINT = { agent: 'Counts as commission already paid', mgmt: 'Counts as commission already paid',
        tax: 'Comes off the guarantee logged', owed: 'Stays marked as owed until it lands',
        advance: 'Already in hand, so it still counts', cash: 'Already in hand, so it still counts',
        venue: 'Won\u2019t arrive, so it isn\u2019t counted', fee: 'Won\u2019t arrive, so it isn\u2019t counted',
        other: 'Won\u2019t arrive, so it isn\u2019t counted' };
      function syncWhy() {
        var sh = shortNow();
        depRow.hidden = paidBy === 'agency' || !(gross > 0);
        depHint.textContent = depSeen != null && dep === depSeen
          ? 'Landed ' + dayMD(s.guaranteeReceivedAt) + ' \u00b7 seen in the bank' : 'What actually reached the bank';
        syncTaxRow();
        if (depRow.hidden || dep == null || Math.abs(sh) < 0.005) {
          whyHost.hidden = true;
          setTax(); syncGuarantee();
          return;
        }
        whyHost.hidden = false;
        if (sh < 0) {
          fillEl(whyHost, [
            h('div', { class: 'gw-head' }, h('span', null, 'Deposited over the guarantee'), h('strong', { class: 'num' }, G.moneyCents(-sh))),
            h('p', { class: 'hint gw-note' }, 'A bonus or overage belongs under Back end, so it counts as income.')]);
          setTax(); syncGuarantee();
          return;
        }
        // The gap is exactly the booking agent's cut: say so for them.
        if (!whyTouched && !Object.keys(why).length && agentPct > 0 && Math.abs(sh - gross * agentPct) <= 1) { why.agent = sh; autoKey = 'agent'; }
        fillEl(whyHost, [
          h('div', { class: 'gw-head' }, h('span', null, 'Not deposited'), h('strong', { class: 'num' }, G.moneyCents(sh))),
          h('p', { class: 'gw-q' }, 'Why?'),
          G.GUARANTEE_REASONS.map(function (r) {
            var on = why[r.key] != null;
            var cb = h('input', { type: 'checkbox', class: 'rv-check', checked: on, 'aria-label': r.label,
              onchange: function (e) {
                whyTouched = true;
                if (r.key === 'owed') owedTouched = true;
                if (e.target.checked) {
                  var left = r2(shortNow() - whySum());
                  why[r.key] = left > 0 ? left : 0;
                  autoKey = Object.keys(why).length === 1 ? r.key : null;
                } else {
                  delete why[r.key];
                  if (autoKey === r.key) autoKey = null;
                }
                syncWhy(); refresh();
              } });
            return h('div', { class: 'gw-row' + (on ? ' on' : '') },
              h('label', { class: 'gw-pick' }, cb,
                h('span', { class: 'gw-label' }, r.label, on && WHY_HINT[r.key] ? h('span', { class: 'hint' }, WHY_HINT[r.key]) : null)),
              on ? moneyInput({ id: 'inc-why-' + r.key, value: why[r.key], label: r.label + ' amount', slim: true,
                // Typing an amount never rebuilds the list (the box would lose its place).
                onValue: function (v) { why[r.key] = Math.max(0, r2(v)); autoKey = null; whyTouched = true; if (r.key === 'owed') owedTouched = true; setTax(); syncGuarantee(); sayLeft(); refresh(); } }) : null);
          }),
          why.other != null ? h('input', { class: 'input sm gw-other', type: 'text', maxlength: 80, value: whyNote, autocomplete: 'off',
            placeholder: 'What was it?', 'aria-label': 'What the other reason was',
            oninput: function (e) { whyNote = e.target.value; } }) : null,
          leftLine]);
        setTax(); syncGuarantee(); sayLeft();
      }
      syncWhy();
      var rows = [];
      fields.forEach(function (f, i) {
        var mkInput = moneyInput({
          id: 'inc-' + f.key, value: f.key === 'guarantee' ? gross : draft[f.key], label: f.label,
          nextId: f.key === 'guarantee' ? 'inc-deposit' : f.key === 'misc' ? 'inc-misc-label'
            : (i < fields.length - 1 ? 'inc-' + fields[i + 1].key : null),
          last: i === fields.length - 1,
          onValue: function (v) {
            if (f.key === 'guarantee') { gross = v; amountLanded('guarantee'); followGap(); syncWhy(); } else draft[f.key] = v;
            if (f.key === 'merch') amountLanded('merch');
            syncMisc(); refresh();
            if (f.key === 'merch') updateDeposit();
            if (f.key === 'buyouts') updateBuyouts();
          }
        });
        if (f.key === 'merch') {
          // Merch gets room of its own: the net atVenu reports, the cash the
          // table kept, the per head, and whether the deposit has landed.
          // Every dollar sits on the right.
          var cashInput = moneyInput({
            id: 'inc-merch-cash', value: merchCash, label: 'Merch cash',
            onValue: function (v) { merchCash = v; refresh(); updateDeposit(); }
          });
          // The atVenu bubble opens two choices: upload a report, or refresh
          // from the atVenu emails the mailbox has kept for this tour.
          var avReader = settlementReader({ show: s, mode: 'atvenu', onResult: atvenuResult, ariTour: id,
            btnLabel: '', btnLogo: 'logo-atvenu.png',
            ariaLabel: 'Read the atVenu merch summary', btnCls: 'av-bubble av-hidden' });
          var BK = window.GR_BACKEND;
          var canRefresh = S.mode === 'db' && BK && BK.atvenuRefresh;
          var avMenu = h('div', { class: 'row av-menu', hidden: true },
            h('button', { class: 'btn quiet sm', type: 'button', onclick: function () {
              avMenu.hidden = true;
              avReader[0].click();
            } }, icon('flyer', 16), 'Upload'),
            canRefresh ? h('button', { class: 'btn quiet glow sm', type: 'button', onclick: async function (e) {
              var b = e.currentTarget;
              b.disabled = true;
              var r = null;
              try { r = await BK.atvenuRefresh(id, showId); } catch (e2) { r = null; }
              b.disabled = false;
              avMenu.hidden = true;
              if (!r || !r.ok) { toast('Couldn\u2019t reach the atVenu reports. Try again.'); return; }
              // This night only.
              var where = s.city || 'this night';
              var bits = [r.added ? 'Brought in ' + where + '\u2019s atVenu report'
                : r.same ? where + ' already matches atVenu'
                : r.conflicts ? 'Left alone \u2014 a different merch number is already logged for ' + where
                : r.unclear ? 'Two different atVenu numbers for ' + where + '; upload the night\u2019s Settlement'
                : 'No atVenu report for ' + where + ' yet'];
              toast(bits.join(' \u00b7 '));
              // Show what came in on this night straight away.
              if (r.added) { closeSheet(); setTimeout(function () { openIncome(id, showId); }, 350); }
            } }, icon('refresh', 16), 'Refresh') : null);
          var avBtn = h('button', { class: 'av-bubble', type: 'button', 'aria-label': 'atVenu: upload or refresh',
            onclick: function () { avMenu.hidden = !avMenu.hidden; } },
            h('img', { class: 'brand-logo', src: 'logo-atvenu.png', alt: '' }));
          // Typed by hand like every other line, or filled from atVenu.
          // Received: ticked by hand when the deposit isn't spotted on its own.
          rows.push(h('div', { class: 'row mx-head' },
            h('div', { class: 'row-label' },
              h('label', { for: 'inc-merch' }, 'Merch'),
              receivedBox('merch', 'Merch deposit')),
            // atVenu where Buyouts has Track; the amount lines up with the rest.
            avReader, avBtn, mkInput));
          rows.push(avMenu);
          rows.push(h('div', { class: 'row mx-row' },
            h('label', { class: 'row-label', for: 'inc-merch-cash' }, 'Cash',
              h('span', { class: 'hint' }, 'Cash from the show, on hand')),
            cashInput));
          rows.push(h('div', { class: 'row mx-row' },
            h('span', { class: 'row-label' }, '$ per head'),
            perHeadEl));
          rows.push(depositRow);
          if (squareRow) rows.push(squareRow);
        } else if (f.key === 'buyouts') {
          rows.push(h('div', { class: 'row' },
            h('div', { class: 'row-label' },
              h('label', { for: 'inc-buyouts' }, f.label),
              buyoutHint),
            h('button', { class: 'btn sm quiet bo-track', type: 'button', onclick: function () {
              if (!(draft.buyouts > 0)) { toast('Log the buyout total first'); return; }
              openBuyoutTracker(id, s, draft.buyouts, track, function (next) { track = next; updateBuyouts(); refresh(); });
            } }, 'Track'),
            mkInput));
        } else if (f.key === 'guarantee') {
          rows.push(h('div', { class: 'row' },
            h('div', { class: 'row-label' },
              h('label', { for: 'inc-guarantee' }, 'Guarantee Total'),
              receivedBox('guarantee', 'Guarantee')),
            mkInput));
          // What was agreed above; what actually reached the bank here. When
          // the two differ, the section under them asks why.
          rows.push(depRow);
          rows.push(whyHost);
          rows.push(taxRow);
          rows.push(netRow);
          // Paid by: one of the three (tap the ticked one again to clear it).
          var boxes = [];
          // An agency deposit: the booking agent holds the whole guarantee as
          // an advance on their commission for the tour. It counts as income
          // received (the agent has it) and as commission paid.
          var agencyNote = h('p', { class: 'hint gp-note' });
          sayAgency = function () {
            agencyNote.hidden = paidBy !== 'agency';
            agencyNote.textContent = 'The booking agent holds this whole guarantee' + (draft.guarantee > 0 ? ' (' + money(draft.guarantee) + ')' : '') +
              ' as an advance on their commission for the tour. It counts as commission already paid.';
          };
          sayAgency();
          rows.push(h('div', { class: 'row gp-row' },
            h('span', { class: 'row-label' }, 'Paid by'),
            h('div', { class: 'gp-opts', role: 'group', 'aria-label': 'How the guarantee is paid' }, PAID_BY.map(function (x) {
              var cb = h('input', { type: 'checkbox', class: 'rv-check', checked: paidBy === x[0],
                onchange: function (e) {
                  paidBy = e.target.checked ? x[0] : null;
                  boxes.forEach(function (o) { o.checked = o === cb && !!paidBy; });
                  // Held by the agency is received: the agent has it.
                  autoReceived();
                  syncWhy(); sayAgency(); refresh();
                } });
              boxes.push(cb);
              return h('label', { class: 'yn-opt' }, cb, h('span', null, x[1]));
            })),
            agencyNote));
        } else {
          rows.push(h('div', { class: 'row' },
            h('label', { class: 'row-label', for: 'inc-' + f.key }, f.label),
            mkInput));
        }
        if (f.key === 'misc') rows.push(miscRow);
      });
      syncMisc();
      updateDeposit();

      var form = h('form', { class: 'sh-form income-sheet', onsubmit: save, novalidate: true },
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
          saveBtn,
          h('button', {
            class: 'btn ghost block', type: 'button',
            onclick: function () { openShowSheet(id, showId); }
          }, 'Edit date, city or venue')));
      refresh(); renderNotes();
      if (!s.loggedAt) {
        var first = form.querySelector('input');
        if (first) first.setAttribute('autofocus', '');
      }
      return [h('h2', { class: 'sh-title clean' }, title), h('p', { class: 'sh-sub clean' }, sub), form];
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
      (canEditTour(id) && feedOn()) ? h('p', { class: 'note' },
        'Card and bank spending comes in from the card feed by itself. Log cash and anything off the linked accounts here.') : null,
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

  /* ============================== Merch cash log ==============================
     Cash the merch table took in, and where every dollar of it went, so all
     of it is accounted for. Spending filed under a category counts toward the
     budget like any charge; a deposit or a hand-off just moves the cash. */

  // Cash comes in odd amounts: show the cents whenever there are any, so
  // what's on screen is exactly what's left to type in.
  function cashMoney(v) {
    v = Math.round(G.num(v) * 100) / 100;
    return Math.abs(v - Math.round(v)) > 0.004 ? G.moneyCents(v) : money(v);
  }
  // Where merch cash can go: the Expenses categories (so it lands in their
  // Cash column), plus a deposit or a hand-off, which just move the cash.
  function cashCats(t) {
    return G.chargeCategoriesFor(t).filter(function (c) { return c.key !== 'commission' && c.key !== 'offdebt'; });
  }
  function cashCatLabels(t) {
    var out = {};
    G.chargeCategoriesFor(t).forEach(function (c) { out[c.key] = c.label; });
    Object.keys(G.CASH_MOVES).forEach(function (k) { out[k] = G.CASH_MOVES[k]; });
    return out;
  }

  /* Up top, the cash still to account for. Under it, only the cities whose
     cash isn't all accounted for yet, laid out like the Budget's cities: tap
     one to log what was spent or deposited. The rest wait behind a button. */
  function cashLogBody(id, t) {
    var sum = G.cashSummary(t);
    var byShow = G.cashByShow(t);
    var catLabel = cashCatLabels(t);
    var edit = canEditTour(id);
    var open = byShow.nights.filter(function (n) { return n.left > 0.004; });
    var done = byShow.nights.filter(function (n) { return n.left <= 0.004; });
    var over = sum.left < -0.004;
    var hero = h('div', { class: 'cl-hero' + (sum.left > 0.004 || over ? ' owed' : '') },
      h('div', { class: 'cl-k' }, over ? 'Logged more than came in' : 'Cash not accounted for'),
      h('div', { class: 'cl-n num' }, sum.left > 0.004 ? cashMoney(sum.left) : over ? cashMoney(-sum.left)
        : sum.took > 0 ? 'All in' : cashMoney(0)),
      sum.took > 0 ? h('div', { class: 'cl-sub' }, cashMoney(sum.took) + ' taken in · ' + cashMoney(sum.used) + ' accounted for') : null);
    var row = function (n) {
      var sh = n.show, left = n.left > 0.004;
      return h('li', null, h('button', { class: 'show-row' + (left ? ' owed' : ''), type: 'button',
        'aria-label': (sh.city || 'Show') + ', ' + cashMoney(n.took) + ' cash taken, ' +
          (left ? cashMoney(n.left) + ' still to account for' : 'all accounted for'),
        onclick: function () { openCashNight(id, sh.id); } },
        dateBlock(sh.date),
        h('div', { class: 'where' }, h('div', { class: 'city' }, sh.city || 'Show'),
          h('div', { class: 'venue' }, cashMoney(n.took) + ' cash taken')),
        h('span', { class: 'amt num ' + (left ? 'neg' : 'pos') }, left ? cashMoney(n.left) + ' left' : 'All in')));
    };
    var cities = function (k) { return k === 1 ? '1 city' : k + ' cities'; };
    S.cashDone = S.cashDone || {};
    var showDone = !!S.cashDone[id];
    var rest = done.length + (byShow.loose.length ? 1 : 0);
    return [
      hero,
      !byShow.nights.length
        ? h('p', { class: 'note' }, 'Cash shows up here as atVenu reports come in, or when you type it under Merch → Cash while logging a show.')
        : open.length
          ? [h('p', { class: 'count-line' }, cities(open.length) + ' still to account for' + (edit ? ' · tap one' : '')),
             h('ul', { class: 'shows cl-list' }, open.map(row))]
          : h('div', { class: 'cash-done' }, icon('check', 18), 'Every city’s merch cash is accounted for.'),
      rest ? h('div', { class: 'cal-past-wrap' + (showDone ? ' open' : '') },
        h('button', { class: 'btn quiet sm cal-past', type: 'button', 'aria-expanded': String(showDone),
          onclick: function () { S.cashDone[id] = !showDone; render(true); } },
          icon('chevron', 16), done.length
            ? (showDone ? 'Hide accounted-for cities' : 'View accounted-for cities (' + done.length + ')')
            : (showDone ? 'Hide cash logged without a city' : 'View cash logged without a city'))) : null,
      showDone && done.length ? h('ul', { class: 'shows cl-list cl-done' }, done.map(row)) : null,
      showDone && byShow.loose.length ? [h('h3', { class: 'sh-h3', style: 'margin-top:18px' }, 'Logged without a city'),
        h('div', { class: 'ledger' }, byShow.loose.map(function (x) { return cashEntryRow(id, x, catLabel, edit); }))] : null
    ];
  }

  /* One city's cash: Spent (how much, and which Expenses category it goes
     under, in the Cash column) or Deposited (how much, and when). */
  function openCashNight(id, showId, how) {
    openSheet(function () {
      var t = getTour(id);
      var n = G.cashByShow(t).nights.filter(function (x) { return x.show.id === showId; })[0];
      if (!n) return [h('h2', { class: 'sh-title' }, 'Merch cash'),
        emptyState('Nothing to account for', 'This show has no merch cash logged.')];
      var sh = n.show, edit = canEditTour(id), catLabel = cashCatLabels(t);
      var left = Math.round(Math.max(0, n.left) * 100) / 100;
      var place = sh.city ? String(sh.city).split(',')[0] : 'this show';
      var readout = h('div', { class: 'preview' },
        h('div', null, h('span', null, 'Cash taken in'), h('strong', { class: 'num' }, cashMoney(n.took))),
        h('div', null, h('span', null, 'Accounted for'), h('strong', { class: 'num' }, cashMoney(n.used))),
        h('div', null, h('span', null, 'Left to account for'), h('strong', { class: 'num' + (left > 0.004 ? ' neg' : '') }, cashMoney(left))));
      var box = h('div');
      function draw() {
        if (!how) { box.replaceChildren(); return; }
        var deposit = how === 'deposit';
        var f = { amount: 0, category: '', what: '', date: G.tourToday() };
        var sel = null;
        if (!deposit) {
          sel = h('select', { class: 'input', 'aria-label': 'Category', onchange: function (e) { f.category = e.target.value; } },
            h('option', { value: '' }, 'Pick a category'),
            cashCats(t).map(function (c) { return h('option', { value: c.key }, c.label); }));
        }
        box.replaceChildren(h('form', { class: 'sh-form', novalidate: true,
          onsubmit: async function (e) {
            e.preventDefault();
            blurActive();
            if (!(f.amount > 0)) { toast('Enter how much was ' + (deposit ? 'deposited' : 'spent')); return; }
            if (f.amount > left + 0.004) { toast('Only ' + cashMoney(left) + ' of ' + place + '’s cash is left to account for'); return; }
            if (!deposit && !f.category) { toast('Pick a category'); return; }
            if (deposit && !G.parseDay(f.date)) { toast('Pick the day it was deposited'); return; }
            var patch = {};
            patch[newId()] = { date: deposit ? f.date : G.tourToday(), amount: f.amount, showId: sh.id,
              label: deposit ? G.CASH_MOVES.deposit : (f.what.trim() || catLabel[f.category] || 'Cash'),
              category: deposit ? 'deposit' : f.category, createdAt: Date.now() };
            if (await api.update(id, { cashLog: patch })) {
              var leftNow = Math.round((left - f.amount) * 100) / 100;
              toast(cashMoney(f.amount) + (deposit ? ' deposit logged' : ' logged under ' + catLabel[f.category]) +
                (leftNow > 0.004 ? ' · ' + cashMoney(leftNow) + ' of ' + place + ' left' : ' · ' + place + ' is all accounted for'));
              render(true);
              if (leftNow > 0.004) openCashNight(id, showId); else closeSheet();
            }
          } },
          field(deposit ? 'How much was deposited' : 'How much was spent', moneyInput({ id: 'cl-amt', value: 0,
            label: deposit ? 'Amount deposited' : 'Amount spent', nextId: deposit ? null : 'cl-what',
            onValue: function (v) { f.amount = v; } }), 'Up to ' + cashMoney(left)),
          deposit ? field('Date deposited', h('input', { class: 'input', type: 'date', value: f.date, 'aria-label': 'Date deposited',
              onchange: function (e) { f.date = e.target.value; } }))
            : [field('Category', h('div', { class: 'sel-wrap' }, sel, icon('chevron', 16)),
                'It shows up under this category on Expenses, in the Cash column.'),
               field('Expense details', h('input', { class: 'input', type: 'text', id: 'cl-what', maxlength: 60, autocomplete: 'off',
                 placeholder: 'Optional, e.g. per diems', oninput: function (e) { f.what = e.target.value; } }))],
          h('div', { class: 'stack' }, h('button', { class: 'btn primary block', type: 'submit' },
            deposit ? 'Log the deposit' : 'Log it as spent'))));
      }
      draw();
      return [
        h('h2', { class: 'sh-title' }, sh.city || 'Show'),
        h('p', { class: 'sh-sub' }, dayLong(sh.date) + (sh.venue ? ' · ' + sh.venue : '')),
        readout,
        edit && left > 0.004 ? [
          segmented(['Spent', 'Deposited'], how === 'spent' ? 0 : how === 'deposit' ? 1 : -1, function (i) {
            how = i ? 'deposit' : 'spent'; draw();
          }, 'Spent or deposited'),
          box] : null,
        n.entries.length ? [h('h3', { class: 'sh-h3', style: 'margin-top:18px' }, 'Logged for ' + place),
          h('div', { class: 'ledger' }, n.entries.map(function (x) { return cashEntryRow(id, x, catLabel, edit); }))] : null
      ];
    }, { label: (function () { var x = G.rows(getTour(id) && getTour(id).shows).filter(function (s) { return s.id === showId; })[0];
      return 'Merch cash, ' + ((x && x.city) || 'show'); })(), cls: 'cat-sheet' });
  }

  function cashEntryRow(id, x, catLabel, edit) {
    var spent = x.category && !G.CASH_MOVES[x.category];
    return h('div', { class: 'row' },
      h('div', { class: 'row-label' }, x.label || 'Cash',
        h('span', { class: 'hint' }, dayMD(x.date) + ' · ' + (catLabel[x.category] || 'Other') +
          (spent ? ' · counts as an expense' : ''))),
      h('span', { class: 'amt num' }, cashMoney(x.amount)),
      edit ? h('button', { class: 'iconbtn sm', type: 'button', 'aria-label': 'Remove ' + (x.label || 'entry'),
        onclick: function () {
          confirmSheet({
            title: 'Remove this entry?',
            body: money(G.num(x.amount)) + ' goes back to cash still to account for.',
            action: 'Remove', danger: true,
            onConfirm: async function () {
              var patch = {}; patch[x.id] = null;
              var ok = await api.update(id, { cashLog: patch });
              if (ok) toast('Removed');
              return ok;
            }
          });
        } }, icon('trash', 18)) : null);
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

  /* Everyone on the tour lands under Crew on the Expenses tab, their pay
     left to fill in: the crew, the band, and whoever started the tour. Only
     friends and family (guests, not paid) are left out, and someone already
     listed (same name or email) isn't added twice. */
  var NOT_CREW = /^\s*(friend|family member)\s*$/i;
  function crewListed(t, name, email) {
    var nm = String(name || '').trim().toLowerCase(), em = String(email || '').trim().toLowerCase();
    return G.rows(t && t.crew).some(function (c) {
      return (nm && String(c.name || '').trim().toLowerCase() === nm) || (em && String(c.email || '').trim().toLowerCase() === em);
    });
  }
  async function addToCrewExpenses(tourId, name, tourRole, email) {
    var t = getTour(tourId);
    var nm = String(name || '').trim();
    if (!t || !nm || NOT_CREW.test(String(tourRole || '')) || crewListed(t, nm, email)) return false;
    var patch = { crew: {}, crewSeen: {} };
    patch.crew[newId()] = { name: nm, title: String(tourRole || '').trim(), pay: 0,
      email: String(email || '').trim().toLowerCase(), createdAt: Date.now() };
    patch.crewSeen[crewSeenKey(nm, email)] = true;
    return api.update(tourId, patch);
  }
  function crewSeenKey(name, email) {
    var em = String(email || '').trim().toLowerCase();
    return (em ? 'e_' + em : 'n_' + String(name || '').trim().toLowerCase()).replace(/[^a-z0-9_]+/g, '_');
  }
  /* Everyone already on the tour shows up under Crew too: the first time the
     Expenses tab sees someone who isn't listed, they're added with their pay
     left to fill in. doc.crewSeen remembers who was added, so someone taken
     off the Crew list stays off (the crew sheet can still put them back). */
  function syncCrew(id) {
    var B = window.GR_BACKEND;
    if (S.mode !== 'db' || !B || !B.crew || !canEditTour(id)) return;
    S.crewSync = S.crewSync || {};
    if (S.crewSync[id] && Date.now() - S.crewSync[id] < 60e3) return;
    S.crewSync[id] = Date.now();
    B.crew(id).then(function (rows) {
      S.crewCache = S.crewCache || {};
      S.crewCache[id] = { rows: rows, at: Date.now() };
      var t = getTour(id);
      if (!t) return;
      var seen = G.isObj(t.crewSeen) ? t.crewSeen : {};
      var patch = { crew: {}, crewSeen: {} }, added = 0;
      rows.forEach(function (m) {
        var nm = String(m.name || m.username || '').trim(), em = m.invitedEmail || m.email;
        var k = crewSeenKey(nm, em);
        if (!nm || NOT_CREW.test(String(m.tourRole || '')) || seen[k]) return;
        patch.crewSeen[k] = true;
        if (crewListed(t, nm, em)) return;
        patch.crew[newId()] = { name: nm, title: String(m.tourRole || '').trim(), pay: 0,
          email: String(em || '').trim().toLowerCase(), createdAt: Date.now() };
        added++;
      });
      if (!Object.keys(patch.crewSeen).length) return;
      if (!added) delete patch.crew;
      return api.update(id, patch).then(function (ok) { if (ok && added) render(true); });
    }).catch(function () { S.crewSync[id] = 0; });
  }

  /* Real invites (the GitHub Pages build): the tour manager runs the guest
     list; everyone else just sees who's on it. */
  function peopleSection(tourId) {
    var B = window.GR_BACKEND;
    var owns = B.ownsTour(tourId);
    // The creator and everyone with ALL ACCESS invite, and take back invites.
    // (leadsTour: the form below has its own "tourRole" for the person being invited.)
    var runs = owns || leadsTour(tourId);
    var list = h('div', { class: 'ledger' },
      h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Loading…')));

    function renderMembers(rows) {
      var kids = [h('div', { class: 'row people-row' },
        h('span', { class: 'who' }, B.email() || 'You'),
        h('span', { class: 'role-tag' }, owns ? 'Creator' : 'You'))];
      rows.forEach(function (m) {
        var shown = String(m.display_name || '').trim();
        kids.push(h('div', { class: 'row people-row' },
          h('span', { class: 'who' }, shown || m.invited_email,
            h('span', { class: 'hint', style: 'display:block' },
              shown ? m.invited_email : null,
              !m.user_id ? h('span', { class: 'crew-sub pending' }, (shown ? ' \u00b7 ' : '') + 'Pending') : null)),
          h('span', { class: 'role-tag' + (m.role === 'editor' ? ' aa' : '') },
            m.manager && m.role === 'editor' ? 'MANAGER' : m.role === 'editor' ? 'ALL ACCESS' : 'GA'),
          // A Manager is the creator's to take off the tour.
          runs && (owns || !m.manager) ? h('button', {
            class: 'iconbtn sm', type: 'button', 'aria-label': 'Remove ' + m.invited_email,
            onclick: async function () {
              try { await B.uninvite(tourId, m.invited_email); forgetCrew(tourId); toast('Removed'); refresh(); }
              catch (e) { toast('Couldn’t remove them. Try again.'); }
            }
          }, icon('trash', 18)) : null));
      });
      list.replaceChildren.apply(list, kids);
    }

    // Past crew: everyone invited to an earlier tour, one tap from this one.
    var past = h('div', null);
    function renderPast(people, onTour) {
      var me = String(B.email() || '').toLowerCase();
      var here = {};
      onTour.forEach(function (m) { here[String(m.invited_email || '').toLowerCase()] = true; });
      var left = people.filter(function (p) { return !here[p.email] && p.email !== me; });
      if (!left.length) { past.replaceChildren(); return; }
      past.replaceChildren(
        h('h3', { class: 'sh-h3', style: 'margin-top:14px' }, 'Past crew'),
        h('div', { class: 'ledger', style: 'margin-bottom:22px' }, left.map(function (p) {
          var who = p.name || p.email;
          var addBtn = h('button', { class: 'btn sm primary', type: 'button',
            onclick: async function () {
              addBtn.disabled = true;
              try {
                var status = await B.invite(tourId, p.email, p.role, p.name, p.phone,
                  { tourRole: p.tourRole || '' });
                await addToCrewExpenses(tourId, p.name || who, p.tourRole, p.email);
                afterInvite(tourId, who);
                if (status === 'existing') setTimeout(function () { toast(who + ' already has an account — the tour is in it now'); }, 1700);
              } catch (e) { addBtn.disabled = false; toast('Couldn\u2019t invite them. Try again.'); }
            } }, 'Invite');
          return h('div', { class: 'row people-row past-row' },
            h('span', { class: 'who' }, who,
              h('span', { class: 'hint', style: 'display:block' },
                (p.name ? p.email + ' \u00b7 ' : '') + (p.role === 'editor' ? 'ALL ACCESS' : 'GA'))),
            addBtn,
            h('button', { class: 'iconbtn sm', type: 'button', 'aria-label': 'Forget ' + who,
              onclick: async function () {
                try { await B.forgetPastCrew(p.email); refresh(); }
                catch (e) { toast('Couldn\u2019t take them off the list. Try again.'); }
              } }, icon('close', 16)));
        })));
    }

    function refresh() {
      B.members(tourId).then(function (rows) {
        renderMembers(rows);
        if (runs && B.pastCrew) {
          B.pastCrew().then(function (people) { renderPast(people, rows); })
            .catch(function () { past.replaceChildren(); });
        }
      }).catch(function () {
        list.replaceChildren(h('div', { class: 'row' },
          h('span', { class: 'hint' }, 'Couldn’t load the guest list.')));
      });
    }
    refresh();

    var form = null;
    if (runs) {
      // Everything about them is typed here, so their sign-up is just a
      // username and a password: name, email, their role, and their access.
      var role = 'viewer';
      var tourRole = '';
      var inp = function (type, ph, max, extra) {
        return h('input', Object.assign({ class: 'input', type: type, placeholder: ph, maxlength: max,
          autocomplete: 'off', 'aria-label': ph }, extra || {}));
      };
      var firstI = inp('text', 'First name', 30);
      var lastI = inp('text', 'Last name', 30);
      var emailI = inp('email', 'Email', 120, { inputmode: 'email', 'aria-label': 'Email to invite' });
      var phoneI = inp('tel', 'Phone number', 30, { inputmode: 'tel', 'aria-label': 'Phone number' });
      var roleBtn = h('button', { class: 'input role-pick empty', type: 'button', 'aria-haspopup': 'listbox',
        onclick: function () {
          B.openRolePicker(tourRole, function (r) {
            tourRole = r; roleBtn.textContent = r; roleBtn.classList.remove('empty');
          });
        } }, 'Role');
      form = h('form', {
        class: 'card addform invite-form', novalidate: true, style: 'margin-top:14px',
        onsubmit: async function (e) {
          e.preventDefault();
          var first = String(firstI.value || '').trim();
          var last = String(lastI.value || '').trim();
          var email = String(emailI.value || '').trim();
          if (!first) { toast('Type their first name'); firstI.focus(); return; }
          if (!last) { toast('Type their last name'); lastI.focus(); return; }
          if (email.indexOf('@') < 1) { toast('Type their email address'); emailI.focus(); return; }
          if (!tourRole) { toast('Pick their role on the tour'); roleBtn.focus(); return; }
          var name = first + ' ' + last;
          var sendBtn = form.querySelector('button[type=submit]');
          sendBtn.disabled = true;
          try {
            var status = await B.invite(tourId, email, role, name, String(phoneI.value || '').trim(),
              { first: first, last: last, tourRole: tourRole });
            await addToCrewExpenses(tourId, name, tourRole, email);
            afterInvite(tourId, name);
            if (status === 'existing') setTimeout(function () { toast(first + ' already has an account \u2014 the tour is in it now'); }, 1700);
            else if (status !== 'sent') setTimeout(function () { toast('The email didn\u2019t go out, but ' + first + ' can still sign up in Greenroom with ' + email); }, 1700);
          } catch (e2) { sendBtn.disabled = false; toast('Couldn\u2019t send that invite. Try again.'); }
        }
      },
        h('div', { class: 'gate-pair' }, firstI, lastI),
        emailI,
        phoneI,
        roleBtn,
        // The tour's creator can invite someone straight in as a Manager.
        createdTour(tourId)
          ? h('div', { style: 'display:grid;gap:10px;margin-top:10px' },
              segmented(['GA', 'ALL ACCESS', 'MANAGER'], 0, function (i) { role = ['viewer', 'editor', 'manager'][i]; }, 'Invite role'),
              h('button', { class: 'btn primary block', type: 'submit' }, 'Invite'))
          : h('div', { style: 'display:flex;gap:10px;align-items:center;margin-top:10px' },
              segmented(['GA', 'ALL ACCESS'], 0, function (i) { role = i ? 'editor' : 'viewer'; }, 'Invite role'),
              h('button', { class: 'btn primary', type: 'submit', style: 'flex:1' }, 'Invite')));
    }

    return h('div', null, past, list, form);
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
        // The tour's own mailbox: settlements sent here log themselves.
        S.mode === 'db' ? [
          h('p', { class: 'note', style: 'margin:2px 2px 10px' },
            'Send this tour\u2019s atVenu settlements to this address and they log themselves \u2014 Ari breaks each one down in the chat.'),
          h('div', { class: 'mailrow', style: 'margin-bottom:14px' },
            h('code', { class: 'mailcode' }, settlementAddress(tourId)),
            h('button', { class: 'btn quiet sm', type: 'button',
              onclick: async function () {
                var addr = settlementAddress(tourId);
                var ta = h('textarea', { class: 'sr', readonly: true, value: addr });
                document.body.appendChild(ta);
                var okc = await copyText(addr, ta);
                ta.remove();
                toast(okc ? 'Address copied' : 'Press and hold to copy');
              } }, icon('copy', 16), 'Copy'))
        ] : null,
        h('p', { class: 'note', style: 'margin:2px 2px 10px' },
          'Or, after the show, upload the Settlement on the show you\u2019re logging. Net merch lands in income; the cash, ' +
          'the per head and the venue\u2019s cut come through with it.'),
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
      return window.GR_BACKEND.notify(tourId, type, data);
    }
    return Promise.resolve(null);
  }

  /* Everyone on the tour, not just the manager, needs a way to let tour
     alerts reach their phone. Shown in the chat until this phone is on. */
  /* Tour alerts live behind one glowing bell at the top of the chat: the
     manager sends from there, and everyone turns alerts on for their phone.
     A small dot on the bell means this phone isn't getting alerts yet. */
  function alertsBell(tourId) {
    var B = window.GR_BACKEND;
    var db = S.mode === 'db' && B && B.pushSupported;
    if (db && S.pushOn == null && !S.pushAsked) {
      S.pushAsked = true;
      if (B.pushSupported()) {
        B.pushState().then(function (st) { S.pushOn = !!st.on; render(); })
          .catch(function () { S.pushOn = false; render(); });
      } else S.pushOn = false;
    }
    if (!db && !canEditTour(tourId)) return null;
    var off = db && S.pushOn === false;
    // Its own corner cell (not a second chat-tools grid, which pushed it in).
    return h('div', { class: 'ct-side ct-bell' },
      h('button', { class: 'iconbtn bell-btn', type: 'button',
        'aria-label': 'Tour alerts' + (off ? ' (not on for this phone)' : ''),
        onclick: function () { openAlertsMenu(tourId); } },
        icon('bell', 24), off ? h('span', { class: 'bell-dot', 'aria-hidden': 'true' }) : null));
  }

  function openAlertsMenu(tourId) {
    var B = window.GR_BACKEND;
    var db = S.mode === 'db' && B && B.pushSupported;
    openSheet(function () {
      var phone;
      if (!db) phone = null;
      else if (!B.pushSupported()) {
        phone = h('p', { class: 'note' },
          'To get tour alerts on this phone, add Greenroom to your Home Screen (Share \u2192 Add to Home Screen) and open it from there.');
      } else {
        phone = h('button', { class: 'btn ' + (S.pushOn ? 'ghost' : 'quiet glow') + ' block', type: 'button',
          onclick: function () { openNotifications(tourId); } },
          icon('bell', 18), S.pushOn ? 'Tour notifications are on \u00b7 settings' : 'Get tour notifications on this phone');
      }
      return [
        h('h2', { class: 'sh-title' }, 'Tour alerts'),
        h('div', { class: 'stack' },
          (createdTour(tourId) || (moneyLead(tourId) && serverLead(tourId))) ? h('button', { class: 'btn primary block', type: 'button',
            onclick: function () { openAlertSheet(tourId); } }, icon('bell', 18), 'Send Tour Alert') : null,
          phone)
      ];
    }, { label: 'Tour alerts' });
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
      var saved = state.prefs || {};
      // One group per phone (what Ari sends it), plus two extras. A phone set
      // up before the groups counts as ALL, same as the server.
      var prefs = {
        group: saved.group === 'crew' || saved.group === 'artist' ? saved.group : 'all',
        soldout: !!saved.soldout,
        merchnums: !!saved.merchnums
      };
      var GROUPS = ['crew', 'artist', 'all'];
      var SAYS = {
        crew: 'LOAD IN 10 minutes before load in, and DAY SHEET AVAILABLE.',
        artist: 'SHOW TIME 30 minutes before your set, and DAY SHEET AVAILABLE.',
        all: 'Everything: LOAD IN, SHOW TIME, DAY SHEET AVAILABLE, guest list adds and in-the-green news.'
      };
      openSheet(function () {
        var groupHint = h('span', { class: 'hint' }, SAYS[prefs.group]);
        function toggleRow(key, label, hint) {
          return h('div', { class: 'ds-yn', style: 'min-height:48px' },
            h('div', { class: 'row-label', style: 'flex:1' }, label,
              hint ? h('span', { class: 'hint' }, hint) : null),
            segmented(['Off', 'On'], prefs[key] ? 1 : 0, function (i) { prefs[key] = i === 1; }, label));
        }
        var saveBtn = h('button', { class: 'btn primary block', type: 'button',
          onclick: async function () {
            saveBtn.disabled = true;
            try {
              // Tour alerts always come through once this phone is signed up.
              await B.pushEnable({ group: prefs.group, soldout: prefs.soldout, merchnums: prefs.merchnums });
              S.pushOn = true;
              toast('This phone gets ' + prefs.group.toUpperCase() + ' notifications');
              closeSheet();
              render(true);
            } catch (e) {
              saveBtn.disabled = false;
              toast(e && e.code === 'denied'
                ? 'Your phone said no \u2014 allow notifications for Greenroom in Settings'
                : 'Couldn\u2019t turn that on. Try again.');
            }
          } }, on ? 'Save' : 'Turn on for this phone');
        return [
          h('h2', { class: 'sh-title' }, 'Notifications'),
          h('p', { class: 'sh-sub' }, 'Your choices, this phone only \u2014 everyone on the tour picks their own.'),
          h('div', { class: 'ds-yn', style: 'min-height:48px' },
            h('div', { class: 'row-label', style: 'flex:1' }, 'Tour alerts',
              h('span', { class: 'hint' }, 'From the tour manager \u2014 always on')),
            h('span', { class: 'role-tag aa' }, on ? 'ON' : 'ON AFTER SAVE')),
          h('div', { class: 'notif-group' },
            h('div', { class: 'row-label' }, 'From Ari', groupHint),
            segmented(['CREW', 'ARTIST', 'ALL'], GROUPS.indexOf(prefs.group), function (i) {
              prefs.group = GROUPS[i];
              groupHint.textContent = SAYS[prefs.group];
            }, 'Which notifications')),
          h('div', { class: 'ds-yns' },
            toggleRow('soldout', 'SOLD OUT', 'A show gets marked sold out'),
            toggleRow('merchnums', 'MERCH NUMBERS', 'A night\u2019s merch numbers come in')),
          h('div', { class: 'stack' }, saveBtn,
            on ? h('button', { class: 'btn ghost block', type: 'button',
              onclick: async function () {
                await B.pushDisable(); S.pushOn = false;
                toast('Notifications off \u2014 tour alerts too'); closeSheet(); render(true);
              }
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
          G.INCOME_FIELDS.map(function (f) { return G.incomeOf(sh, f.key) ? money(G.incomeOf(sh, f.key)) : '\u2014'; }),
          [money(G.showIncomeTotal(sh))]));
      }),
      // Income on the book itself, under the nights, so the column still
      // adds up to the tour's total income.
      c.otherRows.map(function (x) {
        return repRow([dayMD(x.date), 'Other income \u00b7 ' + G.otherKindLabel(x.kind)].concat(
          G.INCOME_FIELDS.map(function () { return '\u2014'; }), [money(G.num(x.amount))]));
      }),
      repRow(['', 'Total'].concat(G.INCOME_FIELDS.map(function (f) {
        var sum = shows.reduce(function (a, sh) { return a + G.incomeOf(sh, f.key); }, 0);
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
      h('tbody', null, G.commissionLines(comm).map(function (line) {
        var r = comm[line.key];
        // Commission is figured on the shows' money; income catalogued on
        // the book itself (royalties, advances) stays out of it.
        return repRow([line.label,
          r.mode === 'pct' ? r.value + '%' : 'Flat',
          r.mode === 'pct' ? (line.basis === 'guarantee' ? 'Guarantees, ' + money(c.guarantees)
            : 'Show income, ' + money(c.showIncome)) : '\u2014',
          money(G.commissionLine(line, r, c.showIncome, c.guarantees, c.incomeBy))]);
      }),
      repRow(['Total commission', '', '', money(c.commission)], 'rp-total')));

    var cards = G.cardDebts(t).map(function (card) {
      var sm = G.cardSummary(card, t);
      var bd = G.isObj(card.breakdown) ? card.breakdown : {};
      var bits = G.TYPED_CATEGORIES.filter(function (x) { return G.num(bd[x.key]) > 0; })
        .map(function (x) { return x.label + ' ' + money(G.num(bd[x.key])); });
      if (sm.accounted > 0 && sm.feed) bits.push('filed into categories ' + money(sm.accounted));
      if (sm.remainder > 0) bits.push((sm.feed ? 'Credit card ' : 'Misc ') + money(sm.remainder));
      if (sm.feed && sm.paidOff > 0) bits.push('paid off ' + money(sm.paidOff));
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

  // The card settings live here (the creator's): the feed's choices once a
  // card is in, or adding one before that.
  function cardMenuItem(id) {
    var B = window.GR_BACKEND;
    if (S.mode !== 'db' || !createdTour(id) || !S.feed || !B || !B.feedCall) return null;
    var ready = !S.feed.connectOnly && !!(S.feed.row && S.feed.row.switched_on);
    return h('button', { class: 'btn ghost block', type: 'button',
      onclick: function () { if (S.feed.connectOnly) connectCards(id); else openFeedSheet(id); } },
      icon(ready ? 'gear' : 'card', 18), ready ? 'Card settings' : 'Add card info');
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
          cardMenuItem(id),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openRename(id); } },
            icon('edit', 18), 'Name and artist'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openCrewSheet(id); } },
            icon('people', 18), 'Crew'),
          (S.mode === 'db' && window.GR_BACKEND && window.GR_BACKEND.flyer) ? h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () { openFlyerSheet(id); } }, icon('flyer', 18), 'Tour flyer') : null,
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openImportHub(id); } },
            icon('card', 18), 'Bring in your info'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openNotifications(id); } },
            icon('share', 18), 'Notifications'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openCloseout(id); } },
            icon('copy', 18), 'Tour closeout'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openImportsSheet(id); } },
            icon('history', 18), 'Card statement history'),
          canSeeMoney(id) && !isOffTour(t) ? h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () { closeSheet(true); go({ name: 'tour', id: id, view: 'cashlog' }); } },
            icon('cash', 18), 'Merch cash log') : null,
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { openLabelsSheet(); } },
            icon('tag', 18), 'Learned labels'),
          createdTour(id) || S.mode === 'local' ? h('button', {
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
    // The picture itself is kept too, quietly, so the tour has its flyer.
    keepFlyer(tourId, file, true);
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
      // Travel and rehearsal days are asked once, with the tour's first
      // flyer. Later flyers just add their shows (the days can still be
      // changed from the Overview).
      var before = getTour(tourId);
      var firstFlyer = !(before && before.flyerAsked) &&
        !G.rows(before && before.shows).some(function (x) { return G.parseDay(x.date); });
      var upd = { shows: patch };
      if (firstFlyer) upd.flyerAsked = true;
      if (await api.update(tourId, upd)) {
        closeSheet(); toast(plural(n, 'show') + ' added'); render(true);
        var lineupCheck = function () {
          var t1 = getTour(tourId);
          if (t1 && !tourBands(t1).length) openLineupPrompt(tourId);
        };
        setTimeout(function () {
          if (firstFlyer) openTravelDaysSheet(tourId, function () { openRehearsalSheet(tourId, lineupCheck); });
          else lineupCheck();
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
      '  "loadOut":"","lobbyCall":"","busCall":"","wifi":"","parking":"",',
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
  /* How an atVenu Settlement is laid out (per their help center): Credit
     Card/Cash, Gross Sales (Adjusted Gross = Total Gross less card fees, tax
     and off-top costs), Settlement (the venue's cut of the Adjusted Gross;
     Total Due Artist and Total Due Venue), Final Payment (how the venue is
     paid: cash, check or to follow) and Cash from Show (the cash the band
     holds at the end of the night). Card money arrives separately: atVenu
     Register deposits card sales less fees two business days later. */
  function atvenuPrompt(body, isImage) {
    return [
      isImage
        ? 'The attached image(s) are a merch report from atVenu (or a similar merch report).'
        : 'The text below was pulled out of a merch report from atVenu (or a similar merch report).',
      'Pull out ONLY the merch story — nothing about guarantees, back end or the promoter deal.',
      '',
      'Reply with only a JSON object in this exact shape:',
      '{"reportType":"settlement","income":{"merch":null},"cash":null,"cards":{"receipts":null,"fee":null},"cardsBy":null,',
      ' "totals":{"gross":null,"adjusted":null,"dueArtist":null,"dueVenue":null},',
      ' "notes":[{"label":"Merch per head","value":"$12.40"}]}',
      '',
      'Rules:',
      '- reportType: "settlement" when this is ONE show’s Settlement (sections like Credit Card/Cash, Gross Sales,',
      '  Settlement, Final Payment, Cash from Show). "tour_progress" when it covers several shows or the tour so far',
      '  (Tour Progress, tour-to-date, a summary across dates). Anything else: "other".',
      '- merch: what the band keeps for the show — "Total Due Artist" (or "Net to Artist" / "Due to Artist"). If no such',
      '  line exists and the venue took no cut, the "Adjusted Gross" (the gross less card fees, sales tax and off-top',
      '  costs). Only if neither is printed take "Total Gross" and add a note "Gross merch". Never compute it yourself.',
      '- totals: the report\u2019s own printed lines, copied exactly, null when not printed: gross = "Total Gross",',
      '  adjusted = "Adjusted Gross", dueArtist = "Total Due Artist", dueVenue = "Total Due Venue" (0 when the venue took nothing).',
      '- cash: the "Cash from Show" total — the cash the band holds at the end of the night after paying the venue',
      '  any cash, copied with its sign (it can be below zero). If the venue collected the cash, 0. No such line: null.',
      '- cards.receipts: the "Total CC Receipts" (credit card sales). cards.fee: the credit card "Fee ($)" amount.',
      '- cardsBy: who collected the credit cards ("Credit Cards Collected By"): "artist" or "venue".',
      '- Never estimate a number that is not printed on the report.',
      '- notes may ONLY use these labels, and only when the report shows them:',
      '  "Gross merch" (Total Gross Sales), "Venue merch cut", "Card fees", "Sales tax", "Paid to venue" (amount and how:',
      '  cash / check / to follow), "Merch per head" (dollars per attendee), "Attendance".',
      'Keep every value under a dozen words. If the report is unreadable, reply {"income":{},"notes":[]}.',
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
          // The band's number by rule, the same one the mailbox uses.
          if (o.mode === 'atvenu') out = G.pickBandNumber(out);
          var r = G.normalizeSettlement(out);
          if (o.mode === 'atvenu' && r.reportType === 'tour_progress') {
            toast('That\u2019s a Tour Progress report (the tour so far). Upload the night\u2019s Settlement instead.');
            return;
          }
          if (o.mode === 'atvenu') {
            var m = r.income.merch;
            r.income = m != null ? { merch: m } : {};
            r.found = m != null ? 1 : 0;
            r.miscLabel = '';
            r.notes = r.notes.filter(function (n) { return /merch|attendance|per head|fees|tax|paid to venue|cash/i.test(n.label); });
          }
          if (!r.found && !r.notes.length) {
            toast('Couldn’t read that sheet. Try a sharper photo.');
            return;
          }
          await o.onResult(r);
          // The income sheet logs itself now, and Ari reads the same sheet
          // to the chat while the numbers land.
          if (o.ariTour && r.found) ariExplain(o.ariTour, ariBody, ariPics, o.mode === 'atvenu');
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
      .map(function (k) { return S.labels[k] && S.labels[k].merchant; })
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

  /* Review charges before they go on the tour, from the card feed (one card
     at a time) or a statement, newest first. Check charges, tap a category to
     sort them all at once, then ADD; or sort and Add each one on its own.
     From the feed, anything not added stays in the pile for later, and "Set
     aside" drops a charge that isn't the tour's. */
  function openImportReview(tourId, rows, source, opts) {
    var importId = newId();
    // Newest charge at the top, oldest at the bottom.
    // Within a day, the order the card's own app shows (the bank's order).
    rows.sort(G.newestFirst);
    var feed = !!(opts && opts.feed);
    // Where each charge is logged, picked under its category:
    //   Off Tour: the band's Off Tour book only (from a tour, the tour also
    //     carries it under Off Tour Debt);
    //   Current Tour: the tour being reviewed (from the Off Tour book, the
    //     band's tour running today);
    //   Upcoming Tour: any of the band's tours that hasn't started (pick one).
    var base = getTour(tourId) || {};
    var baseOff = isOffTour(base);
    var band = artistOf(base);
    var curTour = baseOff ? (band ? currentTourOf(band) : null) : { id: tourId, name: base.name || 'This tour' };
    var ups = band ? upcomingToursOf(band, tourId) : [];
    // All three always show; one that can't be used right now is greyed out
    // with the reason (no tour running today, or none coming up).
    var dests = band ? [
      ['off', 'Off Tour', ''],
      ['cur', 'Current Tour', curTour ? '' : 'No tour is running today'],
      ['up', 'Upcoming Tour', ups.length ? '' : 'No upcoming tours yet']
    ] : [];
    rows.forEach(function (r) { r.pick = false; r.dest = baseOff ? 'off' : 'cur'; r.upTo = ups.length ? ups[0].id : null; });
    // The tour a charge lands on (null for the Off Tour book).
    var landsOn = function (r) {
      if (r.dest === 'off') return null;
      if (r.dest === 'up' && r.upTo) return r.upTo;
      return curTour ? curTour.id : tourId;
    };
    var nameOf = function (id2) { var x = getTour(id2); return (x && x.name) || 'the tour'; };
    var live = rows.slice();
    var busy = false;

    // Add these charges to the tour (keep), or set them aside (feed only).
    async function file(list, keep, btn) {
      if (busy || !list.length) return;
      if (keep) {
        var missing = list.filter(function (r) { return !r.category; });
        if (missing.length) {
          toast(list.length === 1 ? 'Pick a category first' : 'Pick a category for ' + plural(missing.length, 'checked charge'));
          return;
        }
      }
      busy = true;
      var was = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = keep ? 'Adding\u2026' : 'Moving\u2026'; }
      var said = '', addedN = 0;
      try {
        if (feed) {
          var B = window.GR_BACKEND, r = null;
          try {
            r = await B.feedCall('file', { tourId: tourId, picks: list.map(function (x) {
              return { id: x.feedId, keep: keep, category: keep ? x.category : null, accounted: false,
                dest: x.dest === 'off' ? 'off' : 'tour', to: landsOn(x) };
            }) });
          } catch (e) { r = null; }
          if (!r || !r.ok) {
            if (r && r.error === 'not_allowed') toast('Only the tour manager can sort card charges.');
            else saveFailed('cards:file', r);
            return;
          }
          if (S.pile && S.pile[tourId] && S.pile[tourId].lead) await loadPile(tourId);
          var bits = [];
          if (r.retried && keep && !r.filed && r.already) {
            r.filed = r.already; r.already = 0;
            r.total = Math.round(list.reduce(function (n, x) { return n + G.num(x.amount); }, 0) * 100) / 100;
          }
          addedN = r.filed || 0;
          if (r.filed) bits.push(plural(r.filed, 'charge') + ' added, ' + G.moneyCents(r.total));
          if (r.skipped) bits.push(plural(r.skipped, 'charge') + ' set aside');
          if (r.already) bits.push(plural(r.already, 'charge') + ' already sorted by someone else');
          if (r.offTour) bits.push(r.offTour + ' to Off Tour');
          if (r.upcoming) bits.push(r.upcoming + ' to ' + (list.length === 1 && landsOn(list[0]) ? nameOf(landsOn(list[0])) : 'another tour'));
          said = bits.join(' \u00b7 ');
        } else {
          // A statement: each charge goes where it was pointed.
          var offs = [], byTour = {};
          list.forEach(function (x) {
            var to = landsOn(x);
            if (!to) offs.push(x); else (byTour[to] = byTour[to] || []).push(x);
          });
          var total = 0;
          var put = async function (where, xs, extra) {
            if (!where || !xs.length) return true;
            var patch = {}, sum = 0;
            xs.forEach(function (x, k) {
              // Only ever these fields: no card numbers, no raw text, no file names.
              patch[newId() + k] = Object.assign({ date: x.date, merchant: x.merchant, amount: G.num(x.amount), category: x.category,
                accounted: false, importId: importId, createdAt: Date.now() + k }, extra ? extra(x) : {});
              sum += G.num(x.amount);
            });
            var wt = getTour(where) || {};
            var had = (G.isObj(wt.imports) ? wt.imports : {})[importId];
            var imports = {};
            imports[importId] = { createdAt: had ? had.createdAt : Date.now(), count: (had ? G.num(had.count) : 0) + xs.length,
              total: (had ? G.num(had.total) : 0) + sum, source: source };
            return api.update(where, { charges: patch, imports: imports });
          };
          var offId = offs.length ? (baseOff ? tourId : await ensureOffTour(band)) : null;
          if (offs.length && !offId) { toast('Only the tour\u2019s creator can start the Off Tour book.'); return; }
          var tids = Object.keys(byTour);
          for (var q = 0; q < tids.length; q++) { if (!(await put(tids[q], byTour[tids[q]]))) return; }
          if (!(await put(offId, offs))) return;
          // Off-tour spending on this tour's card: the tour carries it as Off Tour Debt.
          if (!baseOff && !(await put(tourId, offs, function (x) { return { category: 'offdebt', offTour: true, offCategory: x.category }; }))) return;
          for (var i = 0; i < list.length; i++) { await writeLabel(list[i].merchant, list[i].category); total += G.num(list[i].amount); }
          var away = tids.filter(function (x) { return x !== tourId; });
          addedN = list.length;
          said = plural(list.length, 'charge') + ' added, ' + G.moneyCents(total) +
            (offs.length && !baseOff ? ' \u00b7 ' + offs.length + ' to Off Tour' : '') +
            (away.length ? ' \u00b7 ' + away.map(function (x) { return byTour[x].length + ' to ' + nameOf(x); }).join(', ') : '');
        }
      } finally { busy = false; if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = was; } }
      live = live.filter(function (x) { return list.indexOf(x) < 0; });
      // Everything the search found is sorted: the search clears, the rest comes back.
      if (query && !live.some(shown)) { query = ''; search.value = ''; }
      if (keep && addedN) { topCat = null; markChips(); hornSplash('Expenses Logged', said); }
      else toast(said);
      render(true);
      if (!live.length) {
        closeSheet();
        if (opts && opts.next) setTimeout(opts.next, 380);
      } else draw();
    }

    var title = h('h2', { class: 'sh-title' });
    // Search: "uber" shows every Uber charge (an amount works too). Check
    // all, the categories and ADD only touch what's showing; a charge the
    // search hides is unchecked, so nothing out of sight gets added.
    var query = '';
    var shown = function (r) {
      if (!query) return true;
      if (String(r.merchant || '').toLowerCase().indexOf(query) >= 0) return true;
      var num = query.replace(/[$,\s]/g, '');
      return /^\d+(\.\d*)?$/.test(num) && G.num(r.amount).toFixed(2).indexOf(num) === 0;
    };
    var search = h('input', { class: 'input rv-search', type: 'search', placeholder: 'Search, e.g. Uber',
      'aria-label': 'Search the charges', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
      oninput: function (e) {
        query = String(e.target.value || '').trim().toLowerCase();
        live.forEach(function (r) { if (!shown(r)) r.pick = false; });
        draw();
      } });
    var found = h('p', { class: 'rv-found', 'aria-live': 'polite' });
    var allBox = h('input', { type: 'checkbox', class: 'rv-check', 'aria-label': 'Check all',
      onchange: function (e) { live.filter(shown).forEach(function (r) { r.pick = e.target.checked; }); draw(); } });
    var addTop = pressable(h('button', { class: 'btn primary sm rv-addall', type: 'button' }, 'ADD'),
      function () { file(live.filter(function (r) { return r.pick; }), true, addTop); });
    var topCat = null;
    var chips = h('div', { class: 'rv-chips', role: 'group', 'aria-label': 'Sort the checked charges' });
    var markChips = function () {
      Array.prototype.forEach.call(chips.children, function (b) {
        if (!b.dataset || !b.dataset.key) return;
        var on = b.dataset.key === topCat;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
    };
    var applyCat = function (key, label) {
      var picked = live.filter(function (r) { return r.pick; });
      if (!picked.length) { toast('Check the charges first, then tap a category'); return; }
      picked.forEach(function (r) { r.category = key; r.source = 'chosen'; });
      topCat = key; markChips();
      draw();
      toast(plural(picked.length, 'charge') + ' \u2192 ' + label);
    };
    // "+" first, then every category the tour has (its own included).
    function buildChips() {
      var list = G.chargeCategoriesFor(getTour(tourId) || base).filter(function (c) { return c.key !== 'commission' && c.key !== 'offdebt'; });
      chips.replaceChildren.apply(chips, [h('button', { class: 'rv-chip rv-plus', type: 'button', 'aria-label': 'Add a category',
        onclick: growChip }, '+')].concat(list.map(function (c) {
        return h('button', { class: 'rv-chip', type: 'button', 'data-key': c.key, 'aria-pressed': 'false',
          onclick: function () { applyCat(c.key, c.label); } }, c.label);
      })));
      markChips();
    }
    // "+": a category that isn't there yet. Name it and it's a category on
    // the tour everywhere (Expenses too); checked charges go straight under it.
    function growChip() {
      var inp = h('input', { class: 'input sm rv-newcat', type: 'text', maxlength: 30, autocomplete: 'off',
        placeholder: 'New category, e.g. Security', 'aria-label': 'New category name',
        onkeydown: function (e) {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') buildChips();
        } });
      async function commit() {
        var label = String(inp.value || '').trim();
        var key = G.slugCategory(label);
        if (!label || !key) { buildChips(); return; }
        var clash = G.chargeCategoriesFor(getTour(tourId)).filter(function (c) {
          return c.key === key || c.label.toLowerCase() === label.toLowerCase();
        })[0];
        if (clash) { key = clash.key; label = clash.label; }
        else {
          var patch = { extraCats: {} };
          patch.extraCats[key] = label;
          if (!(await api.update(tourId, patch))) { buildChips(); return; }
        }
        buildChips();
        if (live.some(function (r) { return r.pick; })) applyCat(key, label);
        else { draw(); toast('\u201c' + label + '\u201d is a category now. Check charges, then tap it.'); }
      }
      chips.replaceChildren(h('div', { class: 'rv-newrow' }, inp,
        h('button', { class: 'btn sm primary', type: 'button', onclick: commit }, 'Add'),
        h('button', { class: 'iconbtn sm', type: 'button', 'aria-label': 'Cancel', onclick: buildChips }, icon('close', 16))));
      setTimeout(function () { inp.focus(); }, 30);
    }
    buildChips();
    var tools = h('div', { class: 'rv-tools' },
      live.length > 1 ? h('div', { class: 'rv-find' }, icon('search', 16), search) : null,
      found,
      h('div', { class: 'rv-bar' },
        h('label', { class: 'rv-all' }, allBox, h('span', null, 'Check all')),
        addTop),
      chips);
    var listHost = h('div');

    function refreshBar() {
      var picked = live.filter(function (r) { return r.pick; });
      var total = picked.reduce(function (n, r) { return n + G.num(r.amount); }, 0);
      var vis = live.filter(shown);
      allBox.checked = vis.length > 0 && vis.every(function (r) { return r.pick; });
      allBox.indeterminate = picked.length > 0 && !allBox.checked;
      var m = vis.reduce(function (n, r) { return n + G.num(r.amount); }, 0);
      found.textContent = query ? (vis.length ? plural(vis.length, 'match') .replace('matchs', 'matches') + ' \u00b7 ' + G.moneyCents(m) : 'Nothing matches \u201c' + query + '\u201d') : '';
      found.hidden = !query;
      addTop.textContent = picked.length ? 'ADD ' + picked.length + ' · ' + G.moneyCents(total) : 'ADD';
      addTop.disabled = !picked.length;
      title.textContent = feed
        ? plural(live.length, 'new charge')
        : 'Found ' + plural(live.length, 'charge');
    }

    // Under the category: Log to Off Tour, Current Tour or Upcoming Tour (and
    // which one, when the band has more than one coming up).
    function destRow(r) {
      if (!dests.length) return null;
      var upSel = ups.length ? h('select', { class: 'input sm rv-upsel', 'aria-label': 'Which upcoming tour',
        onchange: function (e) { r.upTo = e.target.value; } },
        ups.map(function (u) { return h('option', { value: u.id }, u.name + ' \u00b7 starts ' + dayMD(u.start)); })) : null;
      if (upSel) { upSel.value = r.upTo || ''; upSel.hidden = r.dest !== 'up'; }
      return h('div', { class: 'rv-dwrap' },
        h('div', { class: 'rv-dest', role: 'group', 'aria-label': 'Log ' + r.merchant + ' to' },
          h('span', { class: 'rv-dlabel' }, 'Log to'),
          dests.map(function (d) {
            return h('button', { class: 'rv-dpill' + (r.dest === d[0] ? ' on' : '') + (d[2] ? ' na' : ''), type: 'button',
              title: d[2] || (d[0] === 'cur' && curTour ? curTour.name : null), 'aria-disabled': d[2] ? 'true' : null,
              onclick: function (e) {
                if (d[2]) { toast(d[2]); return; }
                r.dest = d[0];
                Array.prototype.forEach.call(e.currentTarget.parentNode.querySelectorAll('.rv-dpill'), function (b) {
                  b.classList.toggle('on', b === e.currentTarget);
                });
                if (upSel) upSel.hidden = r.dest !== 'up';
              } }, d[1]);
          })),
        upSel);
    }
    function chargeRow(r) {
      var wrap = h('div', { class: 'rv-row rv-charge' + (r.pick ? ' on' : '') });
      var cb = h('input', { type: 'checkbox', class: 'rv-check', 'aria-label': 'Check ' + r.merchant,
        onchange: function (e) { r.pick = e.target.checked; wrap.classList.toggle('on', r.pick); refreshBar(); } });
      cb.checked = !!r.pick;
      var sel = categorySelect(tourId, {
        value: r.category || '', aria: 'Category for ' + r.merchant,
        onPick: function (v) { r.category = v; r.source = v ? 'chosen' : null; var f = $('.rv-flag.learned', wrap); if (f) f.remove(); }
      });
      wrap.append(cb, h('div', { class: 'rv-fields' },
        h('div', { class: 'rv-head' },
          h('span', { class: 'rv-name' }, r.merchant),
          h('span', { class: 'amt num' }, G.moneyCents(r.amount))),
        h('div', { class: 'rv-sub' }, dayMD(r.date),
          r.why ? h('span', { class: 'rv-flag' + (r.why === 'Refund' ? ' learned' : '') }, r.why) : null,
          (r.source === 'learned' && !r.why) ? h('span', { class: 'rv-flag learned' }, 'Learned') : null,
          r.source === 'suggested' ? h('span', { class: 'rv-flag' }, 'Suggested') : null),
        h('div', { class: 'rv-act' }, sel,
          (function () {
            var b = h('button', { class: 'btn sm primary rv-add1', type: 'button' }, 'Add');
            return pressable(b, function () { file([r], true, b); });
          })()),
        destRow(r),
        feed ? h('button', { class: 'linkbtn rv-aside', type: 'button', onclick: function () { file([r], false); } },
          'Not a tour charge — set it aside') : null));
      return wrap;
    }

    // Statements only: charges already imported, or from before the tour
    // (already inside a card balance going in), wait folded away.
    var openBefore = false, openDup = false;
    function draw() {
      var main = live.filter(function (r) { return !r.duplicate && !r.preCutoff && shown(r); });
      var before = live.filter(function (r) { return r.preCutoff && !r.duplicate && shown(r); });
      var dup = live.filter(function (r) { return r.duplicate && shown(r); });
      var kids = [h('div', { class: 'review' }, main.map(chargeRow))];
      if (before.length) {
        var t2 = getTour(tourId);
        var names = G.cardDebts(t2).map(function (c) { return c.label || 'your card'; });
        kids.push(h('button', { class: 'btn quiet block', type: 'button', style: 'margin-top:18px',
          onclick: function () { openBefore = !openBefore; draw(); } },
          (openBefore ? 'Hide ' : 'Show ') + plural(before.length, 'charge') + ' from before the tour started'));
        if (openBefore) {
          kids.push(h('p', { class: 'note' }, 'These are already inside ' + (names.length === 1 ? 'the ' + names[0] + ' balance' : 'the card balance') +
            ' you entered, so adding them would count the money twice. Add one only if it isn’t.'));
          kids.push(h('div', { class: 'review' }, before.map(chargeRow)));
        }
      }
      if (dup.length) {
        kids.push(h('button', { class: 'btn quiet block', type: 'button', style: 'margin-top:18px',
          onclick: function () { openDup = !openDup; draw(); } },
          (openDup ? 'Hide ' : 'Show ') + plural(dup.length, 'charge') + (feed ? ' that may already be logged' : ' already imported')));
        if (openDup) {
          if (feed) {
            kids.push(h('p', { class: 'note' }, 'Each of these matches a charge already on the tour \u2014 same amount, within a day \u2014 ' +
              'so it\u2019s probably the bank\u2019s copy of one you logged from a statement or by hand. Adding it would count the money twice: ' +
              'set it aside unless it really is a second charge.'));
          }
          kids.push(h('div', { class: 'review' }, dup.map(chargeRow)));
        }
      }
      listHost.replaceChildren.apply(listHost, kids);
      refreshBar();
    }
    draw();

    openSheet(function (panel) {
      panel.classList.add('rv-sheet');
      return [
        opts && opts.card ? h('p', { class: 'rv-card' }, (opts.steps > 1 ? 'Card ' + opts.step + ' of ' + opts.steps + ' · ' : '') +
          opts.card + ' · newest first') : null,
        title,
        h('p', { class: 'sh-sub' }, feed
          ? 'Check charges and tap a category to sort them all, then ADD. Or sort and Add them one at a time. Anything you don’t add stays here for later.'
          : 'Check charges and tap a category to sort them all, then ADD. Or sort and Add them one at a time. Nothing you don’t add is saved.'),
        tools,
        listHost,
        h('div', { class: 'stack', style: 'margin-top:14px' },
          opts && opts.next ? h('button', { class: 'btn quiet block', type: 'button',
            onclick: function () { closeSheet(); setTimeout(opts.next, 380); } }, 'Next card →') : null,
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } },
            feed ? 'Not now' : 'Done'))
      ];
    }, { label: 'Review card charges' });
  }

  /* ---------------- The card feed (Plaid) ----------------
     Greenroom reads what the tour manager's cards and bank accounts spend,
     through Plaid, read-only, and files it on the tour that was running that
     day. What it can't place with confidence waits here, for the manager
     only. */

  // With the feed on, the cards and bank accounts say what's been paid.
  function feedOn() { return !!(S.feed && S.feed.row && S.feed.row.switched_on); }
  function feedSince() { return S.feed && S.feed.row && S.feed.row.since ? dayMD(S.feed.row.since) : 'the feed started'; }

  /* A charge logged some other way first (a statement upload, typed by
     hand) comes round again as the bank's copy on the next refresh. When
     the bank's copies pair off one to one with charges already on the tour
     (same amount, within a day), there's no doubt which they are, so they
     are set aside by themselves and never show up as new. Where the count
     doesn't match (three hotel rooms at one price and only two logged), the
     extra waits in the "may already be logged" fold, because one of them is
     real. Charges that came in through the feed itself never pair: the bank
     never sends the same charge twice, so a look-alike of one of those is a
     second, real charge. */
  function autoAsideTwins(id) {
    var B = window.GR_BACKEND, t = getTour(id);
    if (S.mode !== 'db' || !B || !B.feedCall || !t || !canEditTour(id)) return;
    var P = S.pile && S.pile[id];
    if (!(createdTour(id) || (P && P.lead))) return;
    S.asideDone = S.asideDone || {};
    var waiting = feedWaiting(id).filter(function (it) { return G.num(it.amount) > 0 && !S.asideDone[it.id]; });
    if (!waiting.length) return;
    var others = G.rows(t.charges).filter(function (ch) { return chargeSource(t, ch) !== 'PLAID' && G.parseDay(ch.date); })
      .concat(G.rows(t.extras).filter(function (x) { return G.parseDay(x.date); }));
    if (!others.length) return;
    var key = function (v) { return (Math.round(G.num(v) * 100) / 100).toFixed(2); };
    var byAmt = {};
    waiting.forEach(function (it) { (byAmt[key(it.amount)] = byAmt[key(it.amount)] || []).push(it); });
    var picks = [];
    Object.keys(byAmt).forEach(function (k) {
      var items = byAmt[k];
      var twins = others.filter(function (c) {
        return key(c.amount) === k && items.some(function (it) { return Math.abs(G.daysBetween(String(c.date), String(it.date))) <= 1; });
      });
      if (twins.length && items.length <= twins.length) items.forEach(function (it) { picks.push(it); });
    });
    if (!picks.length) return;
    picks.forEach(function (it) { S.asideDone[it.id] = true; });
    B.feedCall('file', { tourId: id, picks: picks.map(function (it) {
      return { id: it.id, keep: false, category: null, accounted: false, dest: 'tour', to: id };
    }) }).then(function (r) {
      if (!r || !r.ok) { picks.forEach(function (it) { delete S.asideDone[it.id]; }); return; }
      var gone = {};
      picks.forEach(function (it) { gone[it.id] = true; });
      if (S.feed && S.feed.items) S.feed.items = S.feed.items.filter(function (it) { return !gone[it.id]; });
      if (P && P.items) P.items = P.items.filter(function (it) { return !gone[it.id]; });
      toast(picks.length === 1 ? 'A charge you\u2019d already logged came round from the bank and was set aside.'
        : picks.length + ' charges you\u2019d already logged came round from the bank and were set aside.');
      render(true);
    }).catch(function () { picks.forEach(function (it) { delete S.asideDone[it.id]; }); });
  }
  function feedWaiting(tourId) {
    var P = S.pile && S.pile[tourId];
    if (P && P.lead) return P.items || [];
    // Your own feed's charges belong on the tours you made, never on someone else's.
    if (!S.feed || !createdTour(tourId)) return [];
    return S.feed.items.filter(function (it) { return !it.tour_id || it.tour_id === tourId; });
  }
  function feedAgo(iso) {
    var ms = Date.now() - Date.parse(iso || '');
    if (!(ms >= 0)) return 'not yet';
    var m = Math.round(ms / 60e3);
    if (m < 2) return 'just now';
    if (m < 60) return m + ' min ago';
    var hr = Math.round(m / 60);
    if (hr < 24) return plural(hr, 'hour') + ' ago';
    return plural(Math.round(hr / 24), 'day') + ' ago';
  }
  function runsATour() {
    return allTourEntries().some(function (e) { return tourRole(e[0]) === 'owner'; });
  }

  /* Plaid's connect window is a Plaid-hosted page in its own window. The bank
     sign-in happens entirely there, never in Greenroom, and it works from the
     home-screen app. When the manager comes back, Greenroom asks the server
     how it went, and the server saves the bank. */
  var plaidTrip = null;      // { tourId, itemId, at } while Plaid's window is out
  var plaidChecking = false;
  var plaidPoll = 0;
  function keepPlaidTrip(t) {
    plaidTrip = t;
    try {
      if (t) localStorage.setItem('gr-plaid', JSON.stringify(t));
      else localStorage.removeItem('gr-plaid');
    } catch (e) { /* this visit remembers it */ }
    clearInterval(plaidPoll);
    plaidPoll = 0;
    // Plaid's window can sit over the app without the app noticing it closed,
    // so look every few seconds while it's out.
    if (t) plaidPoll = setInterval(function () {
      if (!plaidTrip || Date.now() - plaidTrip.at > 20 * 60e3) { clearInterval(plaidPoll); plaidPoll = 0; return; }
      if (document.visibilityState === 'visible') checkPlaid(false);
    }, 5000);
  }
  function currentPlaidTrip() {
    if (plaidTrip) return plaidTrip;
    var t = null;
    try { t = JSON.parse(localStorage.getItem('gr-plaid') || 'null'); } catch (e) { t = null; }
    if (t && t.at && Date.now() - t.at < 4 * 3600e3) { plaidTrip = t; return t; }
    if (t) keepPlaidTrip(null);
    return null;
  }
  async function checkPlaid(manual) {
    var trip = currentPlaidTrip();
    var B = window.GR_BACKEND;
    if (!trip || plaidChecking || !B || !B.feedCall) return;
    plaidChecking = true;
    var r = null;
    try { r = await B.feedCall('finish'); } catch (e) { r = null; }
    plaidChecking = false;
    if (!plaidTrip) return;
    if (!r || !r.ok) { if (manual) toast(feedProblem(r && (r.status || r.error))); return; }
    if (r.state === 'waiting') {
      if (manual) toast('Plaid isn\u2019t finished yet. Finish in Plaid\u2019s window, then tap Done.');
      return;
    }
    keepPlaidTrip(null);
    if (sheet && sheet.plaid) closeSheet();
    if (r.state === 'none') { if (manual) toast('Nothing to finish. Tap Connect to start again.'); return; }
    if (r.state === 'exited') { toast('Plaid closed before a bank was connected. Tap Connect to try again.'); return; }
    if (r.state === 'reconnected') {
      toast('Reconnected');
      B.feedCall('sync', { force: true }).catch(function () { /* the Refresh button tries again */ });
      return;
    }
    var names = r.institutions && r.institutions.length ? r.institutions.join(' and ') : 'Bank';
    toast(names + ' connected' + (r.test ? ' (test bank)' : ''));
    // A bank connected from MY PAY is yours, whole: every account on the new
    // login is claimed, set to ask (never files itself anywhere), and tagged
    // so its deposits come to you. The tour's side never lists it.
    if (trip.myPay) { whenLoaded(function () { claimNewLogin(trip); }); return; }
    whenLoaded(function () { openFeedSheet(trip.tourId || null, true); });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkPlaid(false);
  });
  window.addEventListener('focus', function () { checkPlaid(false); });

  // Connect a bank (or, with itemId, sign back in to one that asked). Plaid's
  // page opens from a real tap on a link, so the phone never blocks it.
  async function connectCards(tourId, itemId, opts) {
    var B = window.GR_BACKEND;
    var r = null;
    try { r = await B.feedCall('link', itemId ? { itemId: itemId } : {}); } catch (e) { r = null; }
    if (!r || !r.ok || !r.url) { toast(feedProblem(r && (r.status || r.error))); return; }
    // Started from MY PAY: remember which bank logins the feed had, so the new one can be claimed whole.
    var acc = S.feed && S.feed.row && G.isObj(S.feed.row.accounts) ? S.feed.row.accounts : {};
    var itemsBefore = Object.keys(acc).map(function (k) { return acc[k] && acc[k].item; }).filter(Boolean)
      .filter(function (x, i, a) { return a.indexOf(x) === i; });
    keepPlaidTrip({ tourId: tourId || null, itemId: itemId || null, myPay: !!(opts && opts.myPay), itemsBefore: itemsBefore, at: Date.now() });
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, itemId ? 'Sign back in to your bank' : 'Connect a bank or card'),
        h('p', { class: 'sh-sub' }, 'Plaid opens in its own window. Sign in to your bank there. ' +
          'When Plaid says you\u2019re done, tap Done at the top to come back, and Greenroom finishes by itself.'),
        h('div', { class: 'stack' },
          h('a', { class: 'btn primary block', href: r.url, target: '_blank', rel: 'noopener' }, 'Open Plaid'),
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { checkPlaid(true); } },
            'I\u2019m done in Plaid'))
      ];
    }, { label: 'Connect a bank or card' });
    if (sheet) sheet.plaid = true;
  }

  function feedProblem(code) {
    return ({
      ITEM_LOGIN_REQUIRED: 'A bank needs you to sign in again. Open Card feed settings and tap Reconnect next to it.',
      PENDING_EXPIRATION: 'A bank connection is about to expire. Open Card feed settings and tap Reconnect next to it.',
      not_connected: 'No bank is connected yet. Open Card feed settings to connect one.',
      not_set_up: 'The Plaid keys aren\u2019t in place yet.',
      not_allowed: 'This account can\u2019t connect cards.',
      lock_changed: 'The lock password in Supabase changed, so Greenroom can\u2019t open the bank connections. Put the old one back, or disconnect and reconnect the banks.',
      PRODUCT_NOT_READY: 'The bank is still sending its history. Try again in a few minutes.',
      RATE_LIMIT_EXCEEDED: 'Plaid asked Greenroom to slow down. Try again in a minute.',
      INSTITUTION_DOWN: 'The bank isn\u2019t answering right now. Try again later.',
      INSTITUTION_NOT_RESPONDING: 'The bank isn\u2019t answering right now. Try again later.',
      save_failed: 'Couldn\u2019t save what came in. Try again.',
      no_hosted_link: 'Plaid didn\u2019t open its connect window. Try again in a moment.'
    })[code] || 'Couldn\u2019t reach the cards just now. Try again in a moment.';
  }
  function feedResult(r) {
    if (!r || !r.ok) return feedProblem(r && (r.status || r.error));
    if (r.status === 'recent') return 'Checked a moment ago';
    if (r.test) {
      return 'Test mode \u00b7 ' + plural(r.seen || 0, 'charge') + ' seen \u00b7 ' + (r.filed || 0) + ' would file \u00b7 ' +
        (r.waiting || 0) + ' would ask \u00b7 nothing saved';
    }
    var bits = [];
    if (r.merchPaid) bits.push('merch payout landed for ' + plural(r.merchPaid, 'show'));
    if (r.guaranteesIn) bits.push('guarantee landed for ' + plural(r.guaranteesIn, 'show'));
    if (r.paidOff) bits.push(money(r.paidOff) + ' paid on the cards');
    if (r.filed) bits.push(plural(r.filed, 'charge') + ' filed');
    if (r.waiting) bits.push(plural(r.waiting, 'new charge'));
    return bits.length ? bits.join(' \u00b7 ') : 'Nothing new on the cards';
  }

  // A tour whose logging dates are set takes card charges between them.
  function feedLogs(tourId) { var t = getTour(tourId); return isOffTour(t) || !!G.cardWindow(t); }

  function feedEntry(id) {
    var B = window.GR_BACKEND;
    if (!createdTour(id)) return tmFeedEntry(id);
    if (!S.feed) return null;
    // Only accounts on the approved list ever get this far without a feed.
    // Until a card is in (connected and set up), the one button adds it.
    var addCard = function (go_) {
      return h('div', { class: 'feed-entry' }, h('div', { class: 'feed-bar' },
        h('button', { class: 'btn quiet glow feed-refresh', type: 'button', onclick: go_ },
          icon('card', 18), h('span', null, 'Add Card Info'))));
    };
    if (S.feed.connectOnly) {
      if (S.mode !== 'db' || !B || !B.feedCall) return null;
      return addCard(function () { connectCards(id); });
    }
    var row = S.feed.row || {};
    // Connected but not set up yet: the one time the choices are asked.
    if (!row.switched_on) return addCard(function () { openFeedSheet(id); });
    // Set up: one button does the rest. The choices are in the tour menu.
    autoAsideTwins(id);
    var n = feedWaiting(id).length;
    var label = h('span', null, 'Refresh Card');
    // A tour without logging dates yet gets asked for them first.
    var refreshBtn = h('button', { class: 'btn quiet glow feed-refresh', type: 'button',
      onclick: function () { if (feedLogs(id)) refreshCards(id, refreshBtn, label); else openFeedSheet(id); } },
      icon('refresh', 18), label);
    // Under the button: what's waiting out of the bank, both ways. Charges
    // to sort, and (on the Cards tab) deposits no matcher could place.
    var depBtn = null;
    if (incomeReady(id)) {
      ensureIncomeNew(id);
      var nInc = ((S.incomeNew && S.incomeNew.items) || []).length;
      depBtn = h('button', { class: 'btn ' + (nInc ? 'primary' : 'quiet') + ' feed-new', type: 'button',
        onclick: function () {
          if (nInc) openIncomeReview(id);
          else toast(S.incomeBusy || !S.incomeNew ? 'Checking the bank\u2026' : 'No new deposits. Deposits on the accounts you watch land here.');
        } }, icon('cash', 18), plural(nInc, 'new deposit'));
    }
    return h('div', { class: 'feed-entry' },
      h('div', { class: 'feed-bar' }, refreshBtn),
      h('p', { class: 'feed-checked' }, 'Last checked ' + feedAgo(row.last_run)),
      h('button', { class: 'btn ' + (n ? 'primary' : 'quiet') + ' feed-new', type: 'button',
        onclick: function () { if (n) openFeedReview(id); else toast('No new charges. Tap Refresh Card to check again.'); } },
        icon('card', 18), plural(n, 'new charge')),
      depBtn);
  }

  /* CARDS, the middle tab of Budget: Refresh Card Expenses on top, then each
     linked card by its short name ("AMEX (1008)") with how many new charges
     are waiting on it. A card with new charges opens them to sort; one with
     none opens what it has on this tour. */
  /* ---- New income (the Cards tab's other half). The bank feed keeps every
     deposit on a watched account — date and amount, nothing else — and the
     matchers claim what they recognise. Whatever's left waits here for the
     tour manager to say what it was: merch, a guarantee, royalties or an
     advance, onto Off Tour, the current tour or an upcoming one, the same
     way charges are sorted. Owner only: it's their bank. ---- */
  function incomeReady(id) {
    var B = window.GR_BACKEND;
    return S.mode === 'db' && !!(B && B.incomeNew) && createdTour(id) && !!(S.feed && S.feed.row);
  }
  async function loadIncomeNew() {
    var B = window.GR_BACKEND;
    S.incomeBusy = true;
    var items = null;
    try { items = await B.incomeNew(); } catch (e) { items = null; }
    S.incomeBusy = false;
    S.incomeNew = { items: items || [], at: Date.now(), failed: !items };
    return S.incomeNew;
  }
  // Fetched when stale, like the Tour Manager's pile.
  function ensureIncomeNew(id) {
    if (!incomeReady(id)) return;
    var P = S.incomeNew;
    if ((!P || Date.now() - P.at > 120e3) && !S.incomeBusy) {
      loadIncomeNew().then(function () { render(true); });
    }
  }
  /* One sheet, every waiting deposit: what it was, and which book it lands
     on. Merch and a guarantee can pin to one night (the dropdown); Whole
     tour writes it on the book itself. Clearing one is final. */
  function openIncomeReview(tourId) {
    var B = window.GR_BACKEND;
    var base = getTour(tourId) || {};
    var band = artistOf(base);
    var curTour = isOffTour(base) ? (band ? currentTourOf(band) : null) : { id: tourId, name: base.name || 'This tour' };
    var ups = band ? upcomingToursOf(band, tourId) : [];
    var dests = band ? [
      ['off', 'Off Tour', ''],
      ['cur', 'Current Tour', curTour ? '' : 'No tour is running today'],
      ['up', 'Upcoming Tour', ups.length ? '' : 'No upcoming tours yet']
    ] : [];
    var live = ((S.incomeNew && S.incomeNew.items) || []).map(function (d) {
      return { id: String(d.id), date: String(d.date || ''), amount: G.num(d.amount), av: !!d.atvenu,
        dest: curTour ? 'cur' : 'off', upTo: ups.length ? ups[0].id : null,
        kind: d.atvenu ? 'merch' : '', show: '', showTouched: false, armed: false };
    });
    if (!live.length) { toast('No new income'); return; }
    // The book a deposit lands on (null = the Off Tour book, made if needed).
    function landsOn(r) {
      if (r.dest === 'off') return null;
      if (r.dest === 'up' && r.upTo) return r.upTo;
      return curTour ? curTour.id : tourId;
    }
    function showChoices(r) {
      var tid = landsOn(r);
      if (!tid || (r.kind !== 'merch' && r.kind !== 'guarantee')) return null;
      var t2 = getTour(tid);
      // Only nights where that money is actually logged — the same rule the
      // automatic matchers use. Pinning a guarantee to a night that has none
      // would be wiped by the income sheet's next save; Whole tour keeps it.
      var list = G.rows(t2 && t2.shows).filter(function (s) {
        return G.parseDay(s.date) && s.loggedAt &&
          G.num(s.income && s.income[r.kind === 'merch' ? 'merch' : 'guarantee']) > 0;
      }).sort(G.byDate).reverse();
      return list.length ? list : null;
    }
    // A deposit on the night that the bank hasn't shown yet: typed by hand,
    // or corrected upward. (The same reading the database makes when a
    // deposit is catalogued: its running total, else the whole deposit when
    // the bank feed matched it, else nothing.)
    function unseen(s) {
      var dep = G.num(s.guaranteeDeposit);
      if (s.guaranteeReceived !== true || s.guaranteePaidBy === 'agency' || !(dep > 0)) return 0;
      var seen = s.guaranteeSeen != null ? Math.min(G.num(s.guaranteeSeen), dep) : (s.guaranteeReceivedAt ? dep : 0);
      return Math.max(0, Math.round((dep - seen) * 100) / 100);
    }
    // Ticked Received by hand, no amount typed, never seen in the bank: the
    // deposit to expect there is the whole guarantee.
    function handTicked(s) {
      return s.guaranteeReceived === true && s.guaranteePaidBy !== 'agency' && !(G.num(s.guaranteeDeposit) > 0) && !s.guaranteeReceivedAt;
    }
    // Which nights are still waiting on this money.
    function owedBit(r, s) {
      if (r.kind === 'merch') return !!s.loggedAt && s.merchReceived === false && G.merchDue(s) > 0;
      return !!s.loggedAt && G.num(s.income && s.income.guarantee) > 0 &&
        (s.guaranteeReceived === false || G.guaranteeOwed(s) > 0 || unseen(s) > 1);
    }
    // What that night is waiting to see from the bank.
    function expects(s) {
      if (s.guaranteeReceived === false || handTicked(s)) return G.num(s.income && s.income.guarantee);
      return unseen(s) > 1 ? unseen(s) : G.guaranteeOwed(s);
    }
    // The night a deposit most likely belongs to: one waiting on exactly this
    // amount beats the nearest one waiting on anything. A deposit that was
    // already typed onto a night must land there (it confirms it); logged to
    // the whole tour it would be counted a second time.
    // A whole guarantee may arrive less the booking agent's cut: the same two
    // amounts the bank matcher accepts for a night.
    function agentCut(r) {
      var t2 = getTour(landsOn(r));
      var rule = G.normCommission(t2 && t2.commission).agent;
      return rule && rule.mode === 'pct' ? Math.max(0, Math.min(100, G.num(rule.value))) / 100 : 0;
    }
    function fits(r, s) {
      var amt = G.num(r.amount), want = expects(s);
      if (Math.abs(want - amt) <= 1) return true;
      if (s.guaranteeReceived !== false && !handTicked(s)) return false;
      return Math.abs(Math.round(want * (1 - agentCut(r)) * 100) / 100 - amt) <= 1;
    }
    // Exact amount first; then a night that is genuinely unpaid; a night
    // that's already counted (typed, not seen in the bank yet) only when
    // nothing is unpaid — so it still beats "Whole tour", never an owed night.
    function defaultShow(r, choices) {
      var best = '', bd = Infinity, bk = -1;
      choices.forEach(function (s) {
        var waiting = owedBit(r, s);
        var m = r.kind === 'guarantee' && !!s.loggedAt && G.num(s.income && s.income.guarantee) > 0 &&
          (waiting || handTicked(s)) && fits(r, s);
        if (!waiting && !m) return;
        var unpaid = r.kind !== 'guarantee' || s.guaranteeReceived === false || G.guaranteeOwed(s) > 0;
        var rank = m ? 2 : unpaid ? 1 : 0;
        var gap = Math.abs(G.daysBetween(s.date, r.date));
        if (rank > bk || (rank === bk && gap < bd)) { bd = gap; best = s.id; bk = rank; }
      });
      return best;
    }
    var listHost = h('div', { class: 'iv-list' });
    function drop(r) {
      live = live.filter(function (x) { return x !== r; });
      if (S.incomeNew && S.incomeNew.items) {
        S.incomeNew.items = S.incomeNew.items.filter(function (d) { return String(d.id) !== r.id; });
      }
      if (!live.length) { closeSheet(); render(true); return; }
      draw();
      render(true);
    }
    async function logOne(r, row) {
      if (r.busy) return;
      if (!r.kind) { toast('Pick what it was'); return; }
      // Everything this call needs, read before any waiting; the row is
      // frozen (busy) so nothing can change under it either way.
      var pick = { showId: r.show || null, kind: r.kind };
      var wantsOff = !landsOn(r);
      r.busy = true; row.redraw();
      var tid = landsOn(r);
      if (wantsOff) {
        tid = offTourOf(band) || await ensureOffTour(band);
        if (!tid) { r.busy = false; row.redraw(); saveFailed('income:off'); return; }
      }
      var out = null, bad = null;
      try { out = await B.catalogIncome(r.id, { tourId: tid, showId: pick.showId, kind: pick.kind }); }
      catch (e) { bad = e; }
      // 'done': a matcher claimed it first — same ending, the money is logged.
      if (!out || (!out.ok && out.why !== 'done')) {
        r.busy = false; row.redraw();
        saveFailed('income:log', bad || out); return;
      }
      toast(out.why === 'done' ? 'Already logged' : 'Logged ' + G.moneyCents(r.amount));
      drop(r);
    }
    async function skipOne(r, row) {
      if (r.busy) return;
      // Two taps: clearing is final, so the first one asks.
      if (!r.armed) { r.armed = true; row.redraw(); return; }
      r.busy = true; row.redraw();
      var out = null, bad = null;
      try { out = await B.catalogIncome(r.id, { kind: 'skip' }); }
      catch (e) { bad = e; }
      if (!out || (!out.ok && out.why !== 'done')) {
        r.armed = false; r.busy = false; row.redraw();
        saveFailed('income:skip', bad || out); return;
      }
      // 'done': a matcher logged it first, so it was never cleared.
      toast(out.why === 'done' ? 'Already logged' : 'Cleared');
      drop(r);
    }
    function destPills(r, redraw) {
      if (!dests.length) return null;
      var upSel = ups.length ? h('select', { class: 'input sm rv-upsel', 'aria-label': 'Which upcoming tour',
        disabled: r.busy || null,
        onchange: function (e) { r.upTo = e.target.value; r.showTouched = false; r.show = ''; redraw(); } },
        ups.map(function (u) { return h('option', { value: u.id }, u.name + ' · starts ' + dayMD(u.start)); })) : null;
      if (upSel) { upSel.value = r.upTo || ''; upSel.hidden = r.dest !== 'up'; }
      return h('div', { class: 'rv-dwrap' },
        h('div', { class: 'rv-dest', role: 'group', 'aria-label': 'Log this deposit to' },
          h('span', { class: 'rv-dlabel' }, 'Log to'),
          dests.map(function (d) {
            return h('button', { class: 'rv-dpill' + (r.dest === d[0] ? ' on' : '') + (d[2] ? ' na' : ''), type: 'button',
              title: d[2] || (d[0] === 'cur' && curTour ? curTour.name : null), 'aria-disabled': d[2] ? 'true' : null,
              onclick: function () {
                if (r.busy) return;
                if (d[2]) { toast(d[2]); return; }
                r.dest = d[0]; r.showTouched = false; r.show = '';
                redraw();
              } }, d[1]);
          })),
        upSel);
    }
    function rowEl(r) {
      var wrap = h('div', { class: 'rv-row on iv-row' });
      var row = { redraw: redraw };
      function redraw() {
        var kindSel = h('select', { class: 'input sm', 'aria-label': 'What this deposit was',
          disabled: r.busy || null,
          onchange: function (e) { r.kind = e.target.value; r.showTouched = false; r.show = ''; redraw(); } },
          h('option', { value: '' }, 'What was it?'),
          G.OTHER_INCOME_KINDS.map(function (k) { return h('option', { value: k.key }, k.label); }));
        kindSel.value = r.kind;
        var choices = showChoices(r);
        var showSel = null;
        if (choices) {
          if (!r.showTouched) r.show = defaultShow(r, choices);
          showSel = h('select', { class: 'input sm', 'aria-label': 'Which show',
            disabled: r.busy || null,
            onchange: function (e) { r.show = e.target.value; r.showTouched = true; } },
            h('option', { value: '' }, 'Whole tour'),
            choices.map(function (s) {
              return h('option', { value: s.id },
                [dayMD(s.date), s.city || s.venue || 'Show'].filter(Boolean).join(' · ') +
                (!owedBit(r, s) ? '' : r.kind === 'guarantee' && s.guaranteeReceived !== false && !(G.guaranteeOwed(s) > 0)
                  ? ' · not seen in the bank yet' : ' · owed'));
            }));
          showSel.value = r.show || '';
        } else {
          r.show = '';
        }
        var logBtn = h('button', { class: 'btn sm primary', type: 'button', disabled: r.busy || null },
          r.busy ? 'Logging…' : 'Log');
        var aside = h('button', { class: 'linkbtn rv-aside', type: 'button', disabled: r.busy || null },
          r.armed ? 'Clear it for good?' : 'Not tour income — clear it');
        logBtn.onclick = function () { logOne(r, row); };
        aside.onclick = function () { skipOne(r, row); };
        fillEl(wrap,
          h('div', { class: 'rv-fields' },
            h('div', { class: 'rv-head' },
              h('span', { class: 'rv-name' }, 'Bank deposit'),
              h('span', { class: 'amt num' }, G.moneyCents(r.amount))),
            h('div', { class: 'rv-sub' }, dayMD(r.date),
              r.av ? h('span', { class: 'rv-flag' }, 'Looks like atVenu') : null),
            destPills(r, redraw),
            h('div', { class: 'iv-sels' }, kindSel, showSel),
            h('div', { class: 'rv-act iv-act' }, logBtn, aside)));
      }
      redraw();
      return wrap;
    }
    function draw() {
      fillEl(listHost, live.map(rowEl));
    }
    draw();
    openSheet(function (panel) {
      panel.classList.add('rv-sheet');
      return [
        h('h2', { class: 'sh-title' }, 'New income'),
        h('p', { class: 'sh-sub' }, 'Deposits into your watched accounts. Say what each one was and it’s on the books.'),
        listHost,
        h('div', { class: 'stack' },
          h('button', { class: 'btn ghost block', type: 'button', onclick: function () { closeSheet(); } }, 'Not now'))
      ];
    }, { label: 'New income' });
  }

  function tabCards(id, t) {
    syncCards(id);
    autoAsideTwins(id);
    var waiting = feedWaiting(id);
    var cards = tourCards(t);
    // A card with charges waiting that isn't on the list yet still shows.
    waiting.forEach(function (it) {
      var nm = String(it.account || '').trim();
      if (nm && !cards.some(function (c) { return c.names.indexOf(nm) >= 0; })) cards.push({ id: nm, name: nm, names: [nm], bank: '', kind: '', debt: null, label: cardLabelFor(t, nm) });
    });
    var rows = cards.map(function (c) {
      var n = waiting.filter(function (it) { return c.names.indexOf(String(it.account || '').trim()) >= 0; }).length;
      var first = n ? String(waiting.filter(function (it) { return c.names.indexOf(String(it.account || '').trim()) >= 0; })[0].account || '').trim() : '';
      return h('button', { class: 'row rowbtn card-line', type: 'button',
        'aria-label': c.label + ', ' + plural(n, 'new charge'),
        onclick: function () {
          if (n) openFeedReview(id, null, first);
          else if (c.debt) openFeedCardSheet(id, c.debt.id);
          else openCardCharges(id, c);
        } },
        h('div', { class: 'row-label' }, c.label,
          // A debit card says which deposits it's watched for; the bank feed
          // files deposits without saying which account they landed in, so
          // the count of new deposits is one number for all of them (above).
          c.kind ? h('span', { class: 'hint' }, c.kind === 'debit'
            ? 'Debit card \u00b7 ' + (c.income && c.income.length
                ? 'deposits watched: ' + c.income.map(function (k) { return k === 'guarantees' ? 'guarantees' : 'merch'; }).join(', ')
                : 'deposits not watched')
            : 'Credit card') : null),
        h('span', { class: 'card-new' + (n ? ' on' : '') }, plural(n, 'new charge')),
        icon('chevron', 18));
    });
    // Connected, but never told what it's for: one tap answers it, and then it's listed.
    var unasked = createdTour(id) && S.cardUnasked && S.cardUnasked[id] ? S.cardUnasked[id] : [];
    if (unasked.length) rows.push(h('button', { class: 'row rowbtn card-line ask', type: 'button',
      onclick: function () { openAccountQuestions(unasked, 0, id); } },
      h('div', { class: 'row-label' }, plural(unasked.length, 'new account'),
        h('span', { class: 'hint' }, 'Needs your answers')),
      icon('chevron', 18)));
    // Under the cards: the money coming IN. Deposits no matcher claimed
    // wait here to be catalogued, the same way charges are sorted.
    if (incomeReady(id)) {
      ensureIncomeNew(id);
      var incs = (S.incomeNew && S.incomeNew.items) || [];
      var nInc = incs.length;
      // A failed read says so; it never passes as a quiet zero.
      var incFailed = !!(S.incomeNew && S.incomeNew.failed);
      rows.push(h('button', { class: 'row rowbtn card-line', type: 'button',
        'aria-label': 'Income, ' + (incFailed ? 'couldn’t check' : nInc + ' new'),
        onclick: function () {
          if (nInc) { openIncomeReview(id); return; }
          if (incFailed) { S.incomeNew = null; ensureIncomeNew(id); toast('Trying the bank again…'); return; }
          toast(S.incomeBusy || !S.incomeNew ? 'Checking the bank…'
            : 'No new income. Deposits on your watched accounts land here.');
        } },
        h('div', { class: 'row-label' }, 'Deposits',
          h('span', { class: 'hint' }, 'Money into the bank, to sort')),
        h('span', { class: 'card-new' + (nInc ? ' on' : '') },
          incFailed ? 'couldn’t check' : plural(nInc, 'new deposit')),
        icon('chevron', 18)));
    }
    var entry = feedEntry(id);
    // Nothing to show, and nothing still on its way: say so rather than a blank page.
    var loading = !!(S.pileBusy && S.pileBusy[id]) || (S.mode === 'db' && createdTour(id) && S.feed === undefined);
    return [
      entry,
      rows.length ? h('div', { class: 'ledger cards-list' }, rows)
        : entry || loading ? null : emptyState('No cards linked', 'Cards linked to this tour show up here.')
    ];
  }

  /* The tour manager (ALL ACCESS, tour role Tour Manager) works the owner's
     card charges: the same Refresh, the same pile. Whoever sorts a charge
     first files it, and it's gone from the other one's pile. */
  async function loadPile(tourId) {
    var B = window.GR_BACKEND;
    var r = null;
    S.pile = S.pile || {};
    S.pileBusy = S.pileBusy || {};
    S.pileBusy[tourId] = true;
    try { r = await B.feedCall('pile', { tourId: tourId }); } catch (e) { r = null; }
    S.pileBusy[tourId] = false;
    S.pile[tourId] = r && r.ok
      ? { lead: !r.mine && !!r.connected && !!r.switchedOn, items: r.items || [], lastRun: r.lastRun, at: Date.now() }
      : { lead: false, items: [], at: Date.now() };
    return S.pile[tourId];
  }
  // The Tour Manager's pile of the owner's charges for this tour, fetched when it's stale.
  function ensurePile(id) {
    var B = window.GR_BACKEND;
    if (S.mode !== 'db' || !B || !B.feedCall || createdTour(id) || !bookLead(id)) return;
    var P = S.pile && S.pile[id];
    if ((!P || Date.now() - P.at > 120e3) && !(S.pileBusy && S.pileBusy[id])) {
      loadPile(id).then(function (np) { if (np.lead || (P && P.lead)) render(true); });
    }
  }
  function tmFeedEntry(id) {
    var B = window.GR_BACKEND;
    if (S.mode !== 'db' || !B || !B.feedCall || !bookLead(id)) return null;
    ensurePile(id);
    var P = S.pile && S.pile[id];
    if (!P || !P.lead) return null;
    var n = (P.items || []).length;
    var label = h('span', null, 'Refresh Card');
    var refreshBtn = h('button', { class: 'btn quiet glow feed-refresh', type: 'button',
      onclick: function () { tmRefresh(id, refreshBtn, label); } }, icon('refresh', 18), label);
    return h('div', { class: 'feed-entry' },
      h('div', { class: 'feed-bar' }, refreshBtn),
      h('p', { class: 'feed-checked' }, 'Last checked ' + feedAgo(P.lastRun)),
      n ? h('button', { class: 'btn primary feed-new', type: 'button',
        onclick: function () { openFeedReview(id); } },
        icon('card', 18), plural(n, 'new charge')) : null);
  }
  async function tmRefresh(id, btn, label) {
    var B = window.GR_BACKEND;
    if (btn.disabled) return;
    btn.disabled = true;
    label.textContent = 'Checking the cards\u2026';
    var r = null;
    try { r = await B.feedCall('sync', { force: true, tourId: id }); } catch (e) { r = null; }
    await loadPile(id);
    btn.disabled = false;
    label.textContent = 'Refresh Card Expenses';
    if (r && r.ok && feedWaiting(id).length) { openFeedReview(id); return; }
    toast(feedResult(r));
    render(true);
  }

  /* Refresh: ask the bank to check now, read anything new, then take the next
     step: charges that need a look open straight away; otherwise a word on
     what came in. A bank that wants a sign-in opens the settings. */
  async function refreshCards(id, btn, label) {
    var B = window.GR_BACKEND;
    if (btn.disabled) return;
    btn.disabled = true;
    label.textContent = 'Checking the cards\u2026';
    var r = null;
    try { r = await B.feedCall('sync', { force: true }); } catch (e) { r = null; }
    btn.disabled = false;
    label.textContent = 'Refresh Card Expenses';
    if (!r || !r.ok) {
      var code = r && (r.status || r.error);
      toast(feedProblem(code));
      if (code === 'ITEM_LOGIN_REQUIRED' || code === 'PENDING_EXPIRATION' || code === 'not_connected' ||
          code === 'token_refused' || code === 'plan_missing') openFeedSheet(id);
      return;
    }
    if (!r.test) await celebratePayments(id, G.num(r.paidOff));
    // The sync may have brought deposits in (or matched some): read them fresh.
    if (incomeReady(id)) { S.incomeNew = null; ensureIncomeNew(id); }
    // Test mode says what it would have done; the pile (older, real charges) waits.
    if (!r.test && feedWaiting(id).length) openFeedReview(id);
    else toast(feedResult(r));
  }

  function openFeedReview(tourId, done, only) {
    autoAsideTwins(tourId);
    var cards = [];
    feedWaiting(tourId).slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); })
      .forEach(function (it) { var k = it.account || ''; if (cards.indexOf(k) < 0 && (only == null || k === only)) cards.push(k); });
    if (!cards.length) { toast('Nothing waiting'); return; }
    var i = done || 0;
    var next = function () {
      if (i >= cards.length) return;
      var card = cards[i];
      var here = feedRows(tourId).filter(function (r) { return (r.account || '') === card; });
      i += 1;
      if (!here.length) { next(); return; }
      openImportReview(tourId, here, 'Card feed', { feed: true, card: card || 'Card',
        step: i, steps: cards.length, next: i < cards.length ? next : null });
    };
    next();
  }
  function feedRows(tourId) {
    var valid = {};
    G.chargeCategoriesFor(getTour(tourId)).forEach(function (c) { valid[c.key] = true; });
    return feedWaiting(tourId).map(function (it) {
      var cat = it.category && valid[it.category] ? it.category : '';
      var amt = G.num(it.amount);
      return {
        feedId: it.id, date: it.date, posted: it.posted || it.date, seq: it.seq, merchant: it.merchant, amount: amt, account: it.account || '',
        category: cat, source: cat ? 'learned' : null, why: it.why || '',
        // A look-alike of a charge already on the tour (same amount, within a
        // day — usually the bank's copy of one logged from a statement or by
        // hand) waits in its own fold, unticked, so it isn't added twice.
        duplicate: it.why === 'Maybe already in', preCutoff: false,
        // Refunds and look-alikes start unticked.
        keep: amt > 0 && it.why !== 'Maybe already in'
      };
    });
  }

  /* Each account, as it arrives: credit card or debit card, then expenses or
     income, and for income which kind. Plaid's own reading is picked to start. */
  function acctSummary(a) {
    var bits = [a.card === 'credit' ? 'Credit card' : 'Debit card'];
    var inc = a.card !== 'credit' ? (a.income || []) : [];
    if (a.mode !== 'off') bits.push('Expenses' + (a.mode === 'ask' ? ', ask me first' : ''));
    if (inc.length) {
      bits.push(inc.map(function (k) { return k === 'merch' ? 'Merch' : 'Guarantees'; }).join(' + ') + ' income');
    }
    if (a.mode === 'off' && !inc.length) bits.push('Not logged');
    return bits.join(' \u00b7 ');
  }
  function openAccountQuestions(list, i, tourId) {
    var B = window.GR_BACKEND;
    var a = list[i];
    var ans = {
      card: a.card || a.plaidCard || 'debit',
      what: null,
      mode: a.mode === 'ask' ? 'ask' : 'log',
      income: (a.income || []).slice()
    };
    if (a.asked) {
      var exp = a.mode !== 'off', inc = ans.card !== 'credit' && ans.income.length > 0;
      ans.what = exp && inc ? 'both' : inc ? 'income' : exp ? 'expenses' : 'none';
    } else {
      // New account: cards log on their own; for a bank account, you say.
      ans.what = ans.card === 'credit' ? 'expenses' : null;
      ans.mode = ans.card === 'credit' ? 'log' : 'ask';
    }
    var box = h('div');
    function whatOptions() {
      return ans.card === 'credit' ? [['expenses', 'Expenses'], ['none', 'Neither']]
        : [['expenses', 'Expenses'], ['income', 'Income'], ['both', 'Both'], ['none', 'Neither']];
    }
    function tick(key, label, note) {
      var cb = h('input', { type: 'checkbox', class: 'rv-check', checked: ans.income.indexOf(key) >= 0,
        onchange: function (e) {
          ans.income = ans.income.filter(function (k) { return k !== key; });
          if (e.target.checked) ans.income.push(key);
        } });
      return h('label', { class: 'fa-tick' }, cb, h('span', null, h('b', null, label), h('span', { class: 'hint' }, note)));
    }
    function draw() {
      var opts = whatOptions();
      if (ans.what && !opts.some(function (o) { return o[0] === ans.what; })) ans.what = null;
      var kids = [
        h('h3', { class: 'sh-h3' }, 'Is this a credit card or debit card?'),
        segmented(['Credit card', 'Debit card'], ans.card === 'credit' ? 0 : 1, function (k) {
          ans.card = k === 0 ? 'credit' : 'debit';
          if (ans.card === 'credit' && !ans.what) ans.what = 'expenses';
          draw();
        }, 'Credit card or debit card'),
        a.plaidCard ? h('p', { class: 'note' }, 'Your bank calls it a ' + (a.plaidCard === 'credit' ? 'credit card.' : 'bank account (debit).') +
          (ans.card === 'credit' ? ' Greenroom reads its balance once when logging starts and puts it under Credit card.' : '')) : null,
        h('h3', { class: 'sh-h3' }, 'Do you want to log expenses or income?'),
        segmented(opts.map(function (o) { return o[1]; }),
          opts.map(function (o) { return o[0]; }).indexOf(ans.what), function (k) {
            ans.what = opts[k][0];
            draw();
          }, 'Expenses or income')
      ];
      if (ans.what === 'expenses' || ans.what === 'both') {
        kids.push(
          h('h3', { class: 'sh-h3' }, 'When a charge comes in'),
          segmented(['Log it', 'Ask me first'], ans.mode === 'ask' ? 1 : 0, function (k) { ans.mode = k ? 'ask' : 'log'; },
            'Log it or ask first'),
          h('p', { class: 'note' }, 'Log it: filed on the tour by itself once Greenroom knows the merchant; new ones ask. ' +
            'Ask me first: every charge waits for you.'));
      }
      if (ans.what === 'income' || ans.what === 'both') {
        // Devin (2026-10-07): every deposit on an income account shows up to be
        // logged; the merch/guarantee matching is a suggestion, not a filter.
        ans.income = ['merch', 'guarantees'];
        kids.push(h('p', { class: 'note' }, 'Every deposit into this account shows up under New deposits. One that matches a show\u2019s merch or guarantee marks that show received; the rest wait for you to log.'));
      }
      box.replaceChildren.apply(box, kids);
    }
    draw();
    var last = i === list.length - 1;
    openSheet(function () {
      return [
        h('h2', { class: 'sh-title' }, a.name),
        list.length > 1 ? h('p', { class: 'sh-sub' }, 'Account ' + (i + 1) + ' of ' + list.length) : null,
        box,
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary block', type: 'button', onclick: async function (e) {
            if (!ans.what) { toast('Pick expenses, income, both or neither.'); return; }
            var wantsIncome = ans.card !== 'credit' && (ans.what === 'income' || ans.what === 'both');
            if (wantsIncome && !ans.income.length) { toast('Check Merch, Guarantees or both.'); return; }
            var btn = e.currentTarget;
            btn.disabled = true;
            var r = null;
            try {
              r = await B.feedCall('setup', { account: {
                id: a.id, card: ans.card,
                mode: ans.what === 'expenses' || ans.what === 'both' ? ans.mode : 'off',
                income: wantsIncome ? ans.income : []
              } });
            } catch (x) { r = null; }
            btn.disabled = false;
            if (!r || !r.ok) { saveFailed('cards:setup', r); return; }
            if (!last) openAccountQuestions(list, i + 1, tourId);
            else { if (tourId) syncCards(tourId, true); openFeedSheet(tourId); }
          } }, last ? 'Done' : 'Next'),
          i > 0 ? h('button', { class: 'btn ghost block', type: 'button',
            onclick: function () { openAccountQuestions(list, i - 1, tourId); } }, 'Back') : null)
      ];
    }, { label: a.name });
  }

  /* Logging starts on a tour: each credit card's balance is read once and
     put on the tour under Credit card. Its earlier charges move out of it as
     they're filed; payments later come off what's still owed. */
  // only: the account ids to add (a card connected mid-tour); without it, every logged credit card.
  async function readCardBalances(tourId, only) {
    var B = window.GR_BACKEND;
    var r = null;
    try { r = await B.feedCall('balances'); } catch (e) { r = null; }
    if (!r || !r.ok || !r.balances || !r.balances.length) return;
    if (r.test) {
      toast('Test mode: ' + r.balances.map(function (b) { return b.name + ' ' + money(b.balance); }).join(', ') + ' not saved');
      return;
    }
    var t = getTour(tourId);
    var have = {}, haveId = {};
    G.cardDebts(t).forEach(function (d) { haveId[d.id] = true; if (d.feed) have[d.feed.name] = true; });
    var today = G.tourToday();
    var patch = {}, n = 0;
    // The cards the bank reports right now, by id and by name.
    var live = {}, liveName = {};
    r.balances.forEach(function (b) { live['feed-' + b.id] = true; liveName[b.name] = true; });
    var reissued = function (b) {
      var bank = String(b.bank || '').trim().toLowerCase();
      return !!bank && G.cardDebts(t).some(function (d) {
        if (!G.isObj(d.feed) || live[d.id] || liveName[d.feed.name]) return false;
        var its = String(d.feed.bank || (G.isObj(d.owedNow) && d.owedNow.bank) || '').trim().toLowerCase();
        return its === bank;
      });
    };
    r.balances.forEach(function (b) {
      // Every logged credit card is tracked from here, even at $0 owed.
      // Already carried on the tour (by its id or its name): its balance is never read over.
      if (have[b.name] || haveId['feed-' + b.id] || !(b.balance >= 0)) return;
      if (only && only.indexOf(String(b.id)) < 0) return;
      // A card added mid-tour while the tour still carries one from the same bank that the
      // bank no longer reports: most likely the same card reissued, so its balance isn't read again.
      if (only && reissued(b)) return;
      patch['feed-' + b.id] = { label: b.name, amount: b.balance, kind: 'card', cutoff: today, breakdown: {},
        feed: { name: b.name, readAt: today, bank: b.bank || '' },
        owedNow: { amount: b.balance, at: new Date().toISOString(), bank: b.bank || '' }, createdAt: Date.now() + n };
      n += 1;
    });
    if (n && (await api.update(tourId, { debts: patch }))) {
      var owed = r.balances.filter(function (b) { return patch['feed-' + b.id] && b.balance > 0; });
      if (owed.length) toast(owed.map(function (b) {
        return cardShort(b.name, b.bank) + ' balance ' + money(b.balance);
      }).join(', ') + ' logged under Credit card');
    }
  }

  /* Paying the card down: a moment to enjoy it. Each payment is celebrated
     once on this phone. */
  function paidSeen() {
    try { return JSON.parse(localStorage.getItem('gr-paid-seen') || '[]'); } catch (e) { return []; }
  }
  function unseenPayments(tourId) {
    var seen = paidSeen(), ids = [], total = 0;
    G.cardDebts(getTour(tourId)).forEach(function (d) {
      var p = G.isObj(d.payments) ? d.payments : {};
      Object.keys(p).forEach(function (k) {
        if (seen.indexOf(k) >= 0) return;
        ids.push(k);
        total += G.num(p[k] && p[k].amount);
      });
    });
    return { ids: ids, total: Math.round(total * 100) / 100 };
  }
  function paidSplash(amount) {
    var el = h('div', { class: 'splash-note paid', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'sn-card' },
        h('span', { class: 'sn-check' }, icon('check', 30)),
        h('div', { class: 'sn-big' }, 'Congratulations!'),
        h('div', { class: 'sn-sub' }, 'You paid ' + money(amount) + ' of your credit card debt')));
    document.body.appendChild(el);
    confetti();
    requestAnimationFrame(function () { el.classList.add('on'); });
    setTimeout(function () {
      el.classList.remove('on');
      setTimeout(function () { el.remove(); }, 350);
    }, reduced() ? 2200 : 2800);
  }
  async function celebratePayments(tourId, expected) {
    // The server's note of the payment reaches this phone a moment later.
    var u = unseenPayments(tourId);
    for (var n = 0; n < 12 && expected > 0 && u.total + 0.005 < expected; n++) {
      await new Promise(function (r) { setTimeout(r, 250); });
      u = unseenPayments(tourId);
    }
    if (!u.ids.length) return false;
    try { localStorage.setItem('gr-paid-seen', JSON.stringify(paidSeen().concat(u.ids).slice(-500))); } catch (e) { /* shows again next time */ }
    paidSplash(u.total);
    await new Promise(function (r) { setTimeout(r, reduced() ? 2300 : 2900); });
    return true;
  }

  function openFeedSheet(tourId, askNew) {
    var B = window.GR_BACKEND;
    var t = tourId ? getTour(tourId) : null;
    var settingUp = !(S.feed && S.feed.row && S.feed.row.switched_on) || (t && !feedLogs(tourId));
    var body = h('div', { class: 'feed-body' }, h('p', { class: 'sh-sub' }, 'Checking the cards\u2026'));
    var st = null;
    var busy = false;
    // This tour's logging dates: a named choice follows the tour's own dates.
    var had = t && t.cardLog ? t.cardLog : {};
    var plan = {
      from: had.from === 'rehearsals' ? 'rehearsals' : G.parseDay(had.from) ? 'custom' : 'tour',
      fromDate: G.parseDay(had.from) ? had.from : '',
      to: G.parseDay(had.to) ? 'custom' : 'tour',
      toDate: G.parseDay(had.to) ? had.to : ''
    };
    function planLog() {
      return { from: plan.from === 'custom' ? plan.fromDate : plan.from, to: plan.to === 'custom' ? plan.toDate : plan.to };
    }
    function planFrom() {
      if (plan.from === 'custom') return G.parseDay(plan.fromDate) ? plan.fromDate : null;
      if (plan.from === 'rehearsals' && G.parseDay(t.rehearsalStart)) return t.rehearsalStart;
      return G.tourStart(t);
    }
    function planTo() {
      if (plan.to === 'custom') return G.parseDay(plan.toDate) ? plan.toDate : null;
      return G.tourEnd(t);
    }
    function logSection() {
      var fromIn = h('input', { class: 'input', type: 'date', value: plan.fromDate, 'aria-label': 'Start logging on',
        onchange: function (e) { plan.fromDate = e.target.value; notes(); } });
      var toIn = h('input', { class: 'input', type: 'date', value: plan.toDate, 'aria-label': 'Stop logging after',
        onchange: function (e) { plan.toDate = e.target.value; notes(); } });
      var fromNote = h('p', { class: 'note' }), toNote = h('p', { class: 'note' });
      function notes() {
        fromIn.hidden = plan.from !== 'custom';
        toIn.hidden = plan.to !== 'custom';
        var f = planFrom(), e = planTo();
        fromNote.textContent = plan.from === 'rehearsals' && !G.parseDay(t.rehearsalStart)
          ? 'This tour has no rehearsal days yet, so logging starts with the tour' + (f ? ', ' + dayLong(f) : '') +
            '. Add them from the Overview.'
          : f ? 'From ' + dayLong(f) + '.' + (f < G.addDays(G.tourToday(), -180)
            ? ' Banks share about the last 6 months, so older charges may not come in.' : '')
          : 'Pick the first day to log.';
        toNote.textContent = e ? 'Through ' + dayLong(e) + '.' + (f && e < f ? ' That\u2019s before the start.' : '')
          : 'Pick the last day to log.';
      }
      notes();
      return [
        h('h3', { class: 'sh-h3' }, 'How far back would you like to log?'),
        segmented(['Start of tour', 'Start of rehearsals', 'Custom'], ['tour', 'rehearsals', 'custom'].indexOf(plan.from),
          function (i) { plan.from = ['tour', 'rehearsals', 'custom'][i]; notes(); }, 'How far back to log'),
        fromIn, fromNote,
        h('h3', { class: 'sh-h3' }, 'When would you like to conclude logging for this tour?'),
        segmented(['End of tour', 'Custom'], plan.to === 'custom' ? 1 : 0,
          function (i) { plan.to = i ? 'custom' : 'tour'; notes(); }, 'When to stop logging'),
        toIn, toNote
      ];
    }
    // Save this tour's dates; the server then reads the cards from the start
    // again so everything inside them comes in (and nothing twice).
    async function saveDates(turnOn) {
      var f = planFrom(), e = planTo();
      if (!f || !e) { toast('Pick both dates first.'); return false; }
      if (e < f) { toast('The last day is before the first day.'); return false; }
      var unasked = (st.accounts || []).filter(function (a) { return !a.asked; });
      if (unasked.length) {
        toast('Answer the questions for each account first.');
        openAccountQuestions(unasked, 0, tourId);
        return false;
      }
      var firstTime = !feedLogs(tourId);
      if (!(await api.update(tourId, { cardLog: planLog() }))) return false;
      if (firstTime) await readCardBalances(tourId);
      var r = await B.feedCall('setup', turnOn ? { on: true, since: f, rescan: true } : { rescan: true });
      if (!r || !r.ok) { toast(feedProblem(r && (r.status || r.error))); return false; }
      closeSheet();
      toast((turnOn ? 'Logging ' : 'Dates saved. Logging ') + dayMD(f) + '\u2013' + dayMD(e) + '. Reading the cards\u2026');
      var got = await B.feedCall('sync', { force: true });
      render(true);
      if (got && got.ok && !got.test && feedWaiting(tourId).length) openFeedReview(tourId);
      else toast(feedResult(got));
      return true;
    }

    async function load() {
      try { st = await B.feedCall('status'); } catch (e) { st = { error: 'unavailable' }; }
      draw();
    }
    async function run(label, fn) {
      if (busy) return;
      busy = true;
      body.classList.add('busy');
      body.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      try { await fn(); } catch (e) { toast(feedProblem('unavailable')); }
      busy = false;
      body.classList.remove('busy');
      await load();
    }
    function connectBtn(label, cls) {
      return h('button', { class: 'btn ' + (cls || 'primary') + ' block', type: 'button',
        onclick: function () { closeSheet(); connectCards(tourId); } }, icon('card', 18), label);
    }
    function disconnectAll() {
      return h('button', { class: 'btn quiet block', type: 'button', onclick: function () {
        confirmSheet({
          title: 'Disconnect every bank?',
          body: 'Greenroom tells Plaid to delete each connection right away, and clears the charges waiting for a look. ' +
            'Charges already on your tours stay. You can connect again anytime.',
          action: 'Disconnect', danger: true,
          onConfirm: async function () {
            var r = await B.feedCall('disconnect');
            toast(r && r.ok ? 'Banks disconnected' : feedProblem('unavailable'));
            return true;
          }
        });
      } }, 'Disconnect every bank');
    }
    var safety = h('p', { class: 'note feed-privacy' },
      'Read-only through Plaid: Greenroom can see charges, never move money. Your bank password goes only to Plaid or your bank. ',
      h('a', { href: 'privacy.html', target: '_blank', rel: 'noopener' }, 'How Greenroom handles your card data'));
    function bankNote(code) {
      return code === 'ITEM_LOGIN_REQUIRED' || code === 'PENDING_EXPIRATION' ? 'Needs you to sign in again'
        : code === 'lock_changed' ? 'Can\u2019t be opened (lock password changed)' : 'Having trouble \u2014 try Refresh';
    }

    function draw() {
      // Just connected: every new account's questions come first.
      if (askNew && st && st.ok && !st.needsConnect) {
        askNew = false;
        var fresh = (st.accounts || []).filter(function (a) { return !a.asked; });
        if (fresh.length) { openAccountQuestions(fresh, 0, tourId); return; }
      }
      if (!st || !st.ok) {
        body.replaceChildren(h('div', null, h('p', { class: 'note' }, feedProblem(st && (st.status || st.error))), safety));
        return;
      }
      var parts = [];
      if (st.test) {
        parts.push(h('div', { class: 'feed-test' }, h('b', null, 'TEST MODE'),
          ' Plaid\u2019s fake banks only. Nothing is filed onto your tours.'));
      }
      if (st.needsConnect) {
        parts.push(
          h('p', { class: 'note' },
            'Connect the bank or card company your tour cards are with. You sign in on Plaid\u2019s screen, or your bank\u2019s.'),
          h('div', { class: 'stack' }, connectBtn('Connect a bank or card')));
        parts.push(safety);
        body.replaceChildren(h('div', null, parts));
        return;
      }

      parts.push(h('h3', { class: 'sh-h3' }, 'Banks'),
        h('div', { class: 'ledger feed-banks' }, st.banks.map(function (bk) {
          var trouble = bk.status && bk.status !== 'ok';
          return h('div', { class: 'row' },
            h('div', { class: 'row-label' }, bk.name,
              trouble ? h('span', { class: 'hint over' }, bankNote(bk.status)) : null),
            trouble ? h('button', { class: 'btn sm quiet', type: 'button',
              onclick: function () { closeSheet(); connectCards(tourId, bk.id); } }, 'Reconnect') : null,
            h('button', { class: 'iconbtn sm', type: 'button', 'aria-label': 'Disconnect ' + bk.name,
              onclick: function () {
                confirmSheet({
                  title: 'Disconnect ' + bk.name + '?',
                  body: 'Greenroom tells Plaid to delete this connection right away. Charges already on your tours stay.',
                  action: 'Disconnect', danger: true,
                  onConfirm: async function () {
                    var r = await B.feedCall('disconnect', { itemId: bk.id });
                    toast(r && r.ok ? bk.name + ' disconnected' : feedProblem('unavailable'));
                    return true;
                  }
                });
              } }, icon('trash', 16)));
        })),
        h('div', { class: 'stack', style: 'margin-top:10px' }, connectBtn('Connect another bank or card', 'ghost')));

      // Each account says what it is and what to log; tap one to change it.
      parts.push(
        h('h3', { class: 'sh-h3' }, 'Accounts'),
        h('div', { class: 'ledger feed-accts' }, st.accounts.map(function (a) {
          return h('button', { class: 'row fa-row', type: 'button',
            onclick: function () { openAccountQuestions([a], 0, tourId); } },
            h('div', { class: 'row-label' }, a.name,
              h('span', { class: 'hint' + (a.asked ? '' : ' over') }, a.asked ? acctSummary(a) : 'Needs your answers')),
            icon('chevron', 18));
        })));
      if (t && G.tourStart(t)) {
        // Asked for every tour before anything is logged onto it.
        parts.push(logSection());
        var logsNow = st.switchedOn && feedLogs(tourId);
        parts.push(h('div', { class: 'stack' },
          h('button', { class: 'btn primary block', type: 'button', onclick: function () {
            run('dates', function () { return saveDates(!st.switchedOn); });
          } }, logsNow ? 'Save dates' : 'Start logging')));
      } else if (t) {
        parts.push(h('p', { class: 'note' }, 'Add this tour\u2019s shows first, then choose its logging dates here.'));
      } else {
        parts.push(h('p', { class: 'note' }, 'Each tour has its own logging dates. Open a tour\u2019s Expenses and tap the gear to choose them.'));
      }
      if (st.switchedOn) {
        parts.push(
          h('p', { class: 'sh-sub feed-when' }, 'Last checked ' + feedAgo(st.lastRun)),
          st.lastStatus && st.lastStatus !== 'ok' ? h('p', { class: 'note' }, feedProblem(st.lastStatus)) : null,
          h('div', { class: 'stack' },
            h('button', { class: 'btn quiet block', type: 'button', onclick: function () {
              run('off', async function () {
                var r = await B.feedCall('setup', { on: false });
                toast(r && r.ok ? 'Card feed off. Charges already filed stay put.' : feedProblem('unavailable'));
              });
            } }, 'Turn the feed off')));
      }
      parts.push(h('div', { class: 'stack', style: 'margin-top:14px' }, disconnectAll()), safety);
      body.replaceChildren(h('div', null, parts));
    }

    openSheet(function () {
      load();
      return [
        h('h2', { class: 'sh-title' }, settingUp ? 'Set up the card feed' : 'Card feed'),
        h('p', { class: 'sh-sub' }, 'Greenroom reads what your cards spend through Plaid and logs it. ' +
          'Money coming in is never logged, and only you see this.'),
        body
      ];
    }, { label: settingUp ? 'Set up the card feed' : 'Card feed' });
  }

  /* ---------------- Card charges, imports and learned labels ---------------- */

  function openChargesSheet(tourId) {
    function build() {
      var t = getTour(tourId);
      // Oldest first, newest last.
      var charges = G.rows(t && t.charges).sort(function (a, b) {
        return String(a.date || '').localeCompare(String(b.date || '')) || (a.createdAt || 0) - (b.createdAt || 0);
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
        return k.indexOf('crew:') !== 0 && k.indexOf('alogo:') !== 0 && k.indexOf('artist:') !== 0 && k.indexOf('profile:') !== 0;
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
