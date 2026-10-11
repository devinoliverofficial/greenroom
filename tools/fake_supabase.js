/* A stand-in for supabase-js, so Greenroom's gate (site/backend.js: sign in,
   "I have a code", the one-question sign-up, the invited person's screens)
   can be tried in a browser with NO real project behind it. Used only by
   tools/gate_test.html, which hands it to backend.js as window.GR_SUPABASE.
   Nothing here touches a network or keeps anything: reload and it is new.

   Every call the gate makes is written down in window.__gate.calls as
   { fn, args }, with passwords shown as "***", so a tester can see what
   would have been saved.

   The rules it plays by (tools/gate_test.html lists the same):
   - a Greenroom code is read the way the real ones are: capitals or not,
     with or without its spaces and dashes.
       GR-TEST-0001  good, any number of times
       GR-CREW-0001  good, and made for crew and fans (B.firstRun().suggest)
       GR-ONCE-0001  good for ONE account: a second address only gets in when
                     the first is handed back (the mistyped-email path)
       GR-LAST-0001  good when checked, used up by the time the account is made
       GR-USED-0001  used up: answers "bad", like a code nobody made
       GR-SLOW-0001  answers "too many tries"
       GR-HANG-0001  its check never answers (the gate gives up after 15 s)
     Any other code is bad.
   - the username "brent" is taken;
   - redeeming a code for taken@example.com answers "that email has an
     account", for invited@example.com "that email has a tour invite";
   - sign-up never signs anyone in by itself: the account waits for the
     emailed code 123456 ("Check your email"), as the real project does
     with "Confirm email" on. Going back and giving another address hands
     the first account back (instead_of), and the code gets its use back.
     Some addresses and passwords are refused at that last step:
       bad@example.com    the server says the address is invalid
       slow@example.com   the sign-up never answers, yet the account IS made
                          (the gate gives up after 30 s; "Create account"
                          again goes on to "Check your email")
       the password "password" is too easy to guess
   - a birthday under 18 is refused by save_birth_date ("young");
   - the emailed code 123456 with invited@example.com signs in an invited
     person (Ana Reyes, FOH engineer); with bare@example.com an invited
     person whose invite carried no name and no role; with reset@example.com
     someone resetting a password;
   - anyone@example.com signs in with the password "greenroom": an account
     that answered the first-run questions long ago;
   - the settings read (GET <project>/auth/v1/settings, which the gate asks
     for with fetch, not through supabase-js) says sign-ups are open and
     addresses are confirmed, unless the page address says otherwise:
       ?closed=1 (or ?open=0)  sign-ups are switched off
       ?confirm=0       "Confirm email" is off: the database refuses the account
       ?settings=0      the settings cannot be read: the gate carries on, and
                        with either switch above the refusal comes at the end
       ?settings=hang   the settings read never answers (5 s, then carry on)
       ?mail=0          no email can be sent (the confirmation, a new code)
       ?old=1           a database that has no sign-up functions yet

   THE CARD FEED (migration 0136), so backend.js's own reads of it can be
   tried with no project behind them. Sign in on tools/gate_test.html
   (anyone@example.com / greenroom), then in the console:
     GR_BACKEND.feedWatch(function (s) { console.log(s); })   the feed row and the pile, read a page at a time
     await GR_BACKEND.feedRead()                               the same read again (what Try again does)
     await GR_BACKEND.feedAccount()                            rpc feed_account
     await GR_BACKEND.feedLeftOut('left_out', 'card_payment', 0)   also ('skipped', null, 0); a fourth
                                                               argument { date, id } asks for the page just past that line
     await GR_BACKEND.feedLook(true)                           the "needs a look" lists
     await GR_BACKEND.feedPutBack(['lo-0'])                    rpc feed_put_back
   (The screens themselves are tried in the app harness, tools/make_dbstub.py:
   it has a pretend backend of its own and its switches are listed there.)
   What the pretend database holds: one feed, switched on; 12 lines waiting;
   8 left out by the server (card payments, outside every tour's dates, one
   the bank took back); 3 set aside (one with no reason or date, as an older
   build left them); 4 filed (the bank took one back, and changed the amount
   of another). It refuses every write to feed_items, as the real one does.
   Switches, on window.__harness (set them, then read again):
     feedFail = true     the feed row cannot be read (never "no bank connected")
     pileFail = true     the feed row reads, the waiting lines do not
     noFeed = true       no bank is connected; with allowed = false, and this
                         account is not on the approved list either
     waiting = 2300      how many lines wait (more than 1000 takes several pages)
     cap = 500           the most rows one answer carries (a project set lower
                         than the app's page of 1000)
     account = {...}     feed_account answers exactly this
     moreHistory = true  the bank's read from the start ran out of pages: its entry says
                         more: true, it has no full read yet, and the check's ok is false
     accountFail = true  feed_account errors
     leftOutFail = true  the left-out, set-aside and needs-a-look reads error
     putBackFail = true  feed_put_back errors */
(function () {
  'use strict';

  var gate = window.__gate = { calls: [] };
  var qs = String(location.search || '');
  function flag(name, value) { return new RegExp('[?&]' + name + '=' + value + '(&|$)').test(qs); }
  var CONFIRM = !flag('confirm', '0');
  var CLOSED = flag('closed', '1') || flag('open', '0');
  var SETTINGS = flag('settings', '0') ? 'off' : flag('settings', 'hang') ? 'hang' : 'on';
  var MAIL = !flag('mail', '0');
  var OLD = flag('old', '1');
  var OTP = '123456';
  // left: accounts it can still make. made: what it was made for. late: good until the account is about to be made.
  var CODES = {
    GRTEST0001: { left: 1e9, made: [] },
    GRCREW0001: { left: 1e9, made: ['crew', 'fan'] },
    GRONCE0001: { left: 1, made: [] },
    GRLAST0001: { left: 1e9, made: [], late: true },
    GRUSED0001: { left: 0, made: [] },
    GRSLOW0001: { slow: true },
    GRHANG0001: { left: 1e9, made: [], hang: true }
  };
  var HANDLE = /^[a-z0-9._]{3,24}$/;
  var EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var NEW_FNS = ['signup_code_check', 'signup_handle_free', 'signup_code_redeem', 'my_first_run', 'save_birth_date',
    'finish_first_run', 'save_kinds'];

  var session = null;      // who is signed in
  var listeners = [];      // onAuthStateChange callbacks
  var allowed = {};        // address -> the code that let it in (a redeemed code holds the door for it)
  var waiting = {};        // address -> { user, code }: an account made, waiting on its emailed code
  // What "the database" holds for the signed-in account.
  var account = gate.account = { handle: '', birth: '', onboarded: false, kinds: [] };
  var n = 0;

  // A copy safe to show: no password is ever written into the log.
  function hide(v) {
    try {
      return JSON.parse(JSON.stringify(v === undefined ? null : v, function (k, val) {
        return k === 'password' ? '***' : val;
      }));
    } catch (e) { return String(v); }
  }
  function log(fn, args) { gate.calls.push({ fn: fn, args: hide(args) }); }
  // A short wait, like a real answer coming back.
  function later(v) { return new Promise(function (res) { setTimeout(function () { res(v); }, 120); }); }
  // An answer that never comes, like a request lost on a weak signal.
  function never() { return new Promise(function () { /* left hanging on purpose */ }); }
  function ok(data) { return { data: data === undefined ? null : data, error: null }; }
  function no(message, code) { return { data: null, error: { message: message, code: code || '' } }; }
  function authNo(message) { return { data: { user: null, session: null }, error: { message: message } }; }
  function lower(v) { return String(v || '').trim().toLowerCase(); }

  function makeUser(email, meta) {
    n += 1;
    return { id: '00000000-0000-4000-8000-00000000000' + (n % 10), email: email, created_at: new Date().toISOString(),
      user_metadata: meta || {}, identities: [{ provider: 'email' }] };
  }
  function tell(event) {
    var s = session;
    setTimeout(function () {
      listeners.slice().forEach(function (fn) { try { fn(event, s); } catch (e) { /* the listener's problem */ } });
    }, 0);
  }
  // known: an account that was already there and answered the first-run
  // questions long ago (the test sign-in, a password reset). Anyone else is
  // new: no username, no birthday, nothing ticked yet.
  function signIn(user, known) {
    session = { access_token: 'fake-access', refresh_token: 'fake-refresh', token_type: 'bearer', user: user };
    account.handle = known ? known : ''; account.birth = known ? '1990-06-15' : '';
    account.onboarded = !!known; account.kinds = known ? ['crew'] : [];
    tell('SIGNED_IN');
    return session;
  }

  var auth = {
    getSession: function () { log('auth.getSession', []); return later(ok({ session: session })); },
    refreshSession: function () { log('auth.refreshSession', []); return later(ok({ session: session })); },
    setSession: function (t) {
      log('auth.setSession', [{ access_token: t && t.access_token ? '(a token)' : '', refresh_token: t && t.refresh_token ? '(a token)' : '' }]);
      return later({ data: { session: null, user: null }, error: { message: 'fake: email links are not played here' } });
    },
    onAuthStateChange: function (fn) {
      log('auth.onAuthStateChange', []);
      listeners.push(fn);
      return { data: { subscription: { unsubscribe: function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      } } } };
    },
    signInWithPassword: function (c) {
      log('auth.signInWithPassword', [c]);
      if (lower(c && c.email) === 'anyone@example.com' && String(c.password) === 'greenroom') {
        var s = signIn(makeUser('anyone@example.com', { first_name: 'Any', last_name: 'One', full_name: 'Any One', username: 'Any One' }), 'anyone');
        return later({ data: { user: s.user, session: s }, error: null });
      }
      return later(authNo('Invalid login credentials'));
    },
    signUp: function (c) {
      log('auth.signUp', [c]);
      var email = lower(c && c.email), pass = String((c && c.password) || '');
      var meta = (c && c.options && c.options.data) || {};
      if (CLOSED) return later(authNo('Signups not allowed for this instance'));
      if (email === 'bad@example.com') return later(authNo('Email address "' + email + '" is invalid'));
      if (pass.length < 6) return later(authNo('Password should be at least 6 characters.'));
      if (pass === 'password') return later(authNo('Password is known to be weak and easy to guess, please choose a different one.'));
      // The real door (the signup_gate trigger): no account for an address no code or invite let in,
      // and none once the code that let it in has no use left.
      var key = allowed[email], code = key ? CODES[key] : null;
      if (!code || code.left <= 0) return later(authNo('Database error saving new user'));
      // "Confirm email" is off: the database will not call an address someone's that was never proved.
      if (!CONFIRM) return later(authNo('Database error saving new user'));
      // Nothing is kept when the email cannot go out (the real sign-up undoes itself the same way).
      if (!MAIL) return later(authNo('Error sending confirmation email'));
      // Making the account is what spends the code's use.
      code.left -= 1;
      delete allowed[email];
      var user = makeUser(email, JSON.parse(JSON.stringify(meta)));
      waiting[email] = { user: user, code: key };
      if (email === 'slow@example.com') return never();
      return later({ data: { user: user, session: null }, error: null });
    },
    verifyOtp: function (c) {
      log('auth.verifyOtp', [c]);
      var email = lower(c && c.email), token = String((c && c.token) || ''), type = String((c && c.type) || '');
      var user = null, known = '';
      if (token === OTP) {
        if (waiting[email] && (type === 'signup' || type === 'email')) {
          user = waiting[email].user; delete waiting[email];
        } else if (email === 'invited@example.com' && type === 'invite') {
          user = makeUser(email, { invited: true, first_name: 'Ana', last_name: 'Reyes', full_name: 'Ana Reyes',
            username: 'Ana Reyes', phone: '', tour_role: 'FOH engineer', access: 'viewer', tour_name: 'The Test Tour' });
        } else if (email === 'bare@example.com' && type === 'invite') {
          user = makeUser(email, { invited: true, access: 'viewer', tour_name: 'The Test Tour' });
        } else if (email === 'reset@example.com' && type === 'recovery') {
          user = makeUser(email, { first_name: 'Rae', last_name: 'Set', full_name: 'Rae Set', username: 'Rae Set' });
          known = 'rae';
        }
      }
      if (!user) return later(authNo('Token has expired or is invalid'));
      var s = signIn(user, known);
      return later({ data: { user: user, session: s }, error: null });
    },
    updateUser: function (c) {
      log('auth.updateUser', [c]);
      if (!session) return later(authNo('Auth session missing!'));
      if (c && c.password != null && String(c.password).length < 6) return later(authNo('Password should be at least 6 characters.'));
      if (c && c.data) {
        var meta = Object.assign({}, session.user.user_metadata);
        Object.keys(c.data).forEach(function (k) { meta[k] = c.data[k]; });
        session.user = Object.assign({}, session.user, { user_metadata: meta });
        session = Object.assign({}, session, { user: session.user });
      }
      tell('USER_UPDATED');
      return later({ data: { user: session.user }, error: null });
    },
    resetPasswordForEmail: function (email, o) {
      log('auth.resetPasswordForEmail', [email, o]);
      return later(ok({}));
    },
    resend: function (c) {
      log('auth.resend', [c]);
      if (!MAIL) return later({ data: { user: null, session: null }, error: { message: 'Error sending confirmation email' } });
      return later(ok({}));
    },
    signOut: function (o) {
      log('auth.signOut', [o]);
      session = null;
      tell('SIGNED_OUT');
      return later({ error: null });
    }
  };

  // A code as the database keys it (invite_code_key): capitals, no spaces, no dashes.
  function codeKey(c) { return String(c || '').toUpperCase().replace(/[\s-]/g, ''); }
  // '' when the code is one this fake knows and it is not the slow one.
  function codeSays(c) {
    var code = CODES[codeKey(c)];
    if (!code) return 'bad';
    return code.slow ? 'slow' : '';
  }
  // Whole years old today by the UTC calendar, as save_birth_date counts.
  function yearsOld(day) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!m) return -1;
    var now = new Date(), y = now.getUTCFullYear() - Number(m[1]);
    if (now.getUTCMonth() + 1 < Number(m[2]) || (now.getUTCMonth() + 1 === Number(m[2]) && now.getUTCDate() < Number(m[3]))) y -= 1;
    return y;
  }
  function rpc(name, args) {
    var a = args || {};
    log('rpc ' + name, args === undefined ? [] : [args]);
    if (OLD && NEW_FNS.indexOf(name) >= 0) {
      return later(no('Could not find the function public.' + name + ' in the schema cache', 'PGRST202'));
    }
    var why, key = codeKey(a.c), code = CODES[key];
    if (name === 'signup_code_check') {
      why = codeSays(a.c);
      if (!why && code.hang) return never();
      // A code with no use left is as bad as one nobody made.
      if (!why && code.left <= 0) why = 'bad';
      return later(ok(why ? { ok: false, why: why } : { ok: true, kinds: code.made.slice() }));
    }
    if (name === 'signup_handle_free') {
      why = codeSays(a.c);
      if (why) return later(ok({ ok: false, why: why }));
      if (!HANDLE.test(String(a.h || ''))) return later(ok({ ok: false, why: 'shape' }));
      return later(ok({ ok: true, free: a.h !== 'brent' }));
    }
    if (name === 'signup_code_redeem') {
      why = codeSays(a.c);
      var addr = lower(a.addr), was = lower(a.instead_of);
      if (!why && !EMAIL.test(addr)) why = 'email';
      // instead_of: the account this same code made a moment ago for another
      // address, never confirmed. It goes, and the code has its use back.
      if (!why && was && was !== addr && waiting[was] && waiting[was].code === key) {
        delete waiting[was];
        code.left += 1;
        log('(the fake database took back the account for ' + was + ')', []);
      }
      if (!why && (code.left <= 0 || code.late)) why = 'bad';
      if (!why && (addr === 'taken@example.com' || waiting[addr])) why = 'exists';
      if (!why && addr === 'invited@example.com') why = 'invited';
      if (why) return later(ok({ ok: false, why: why }));
      allowed[addr] = key;
      return later(ok({ ok: true }));
    }
    if (name === 'handle_free') return later(ok(HANDLE.test(String(a.h || '')) && a.h !== 'brent'));
    if (name === 'my_first_run') {
      return later(ok({ onboarded: account.onboarded, kinds: account.kinds.slice(), handle: account.handle,
        hasBirth: !!account.birth }));
    }
    if (name === 'save_birth_date') {
      if (yearsOld(a.d) < 0) return later(no('shape', '22023'));
      if (yearsOld(a.d) < 18) return later(no('young', '22023'));
      account.birth = String(a.d || '');
      return later(ok({ ok: true }));
    }
    if (name === 'finish_first_run') {
      account.onboarded = true; account.kinds = Array.isArray(a.k) ? a.k.slice() : [];
      return later(ok({ ok: true }));
    }
    if (name === 'save_kinds') { account.kinds = Array.isArray(a.k) ? a.k.slice() : []; return later(ok({ ok: true })); }
    if (name === 'feed_account' || name === 'feed_put_back') return feedRpc(name, a);
    // claim_invites and anything else: nothing to say.
    return later(ok(null));
  }

  /* ---- The card feed (0136): a feed row, its lines, and the two functions. ---- */
  var H = window.__harness = window.__harness || {};
  function dayAgo(n) { return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10); }
  var feedLines = null, feedMade = 0;
  function feedDb() {
    var want = H.waiting > 0 ? Math.round(H.waiting) : 12;
    if (feedLines && feedMade === want) return feedLines;
    feedMade = want;
    var line = function (id, status, days, merchant, amount, more) {
      return Object.assign({ id: id, tour_id: 't1', date: dayAgo(days), posted: dayAgo(days), seq: null, merchant: merchant, amount: amount, category: null,
        account: 'Tour Card \u2013 0000', why: '', status: status, reason: null, decided_at: null, bank_amount: null, gone_on: null }, more || {});
    };
    feedLines = [];
    for (var i = 0; i < want; i++) feedLines.push(line('w' + ('0000' + i).slice(-5), 'waiting', i % 60, 'Charge ' + (i + 1), 10 + (i % 90), { why: 'New merchant' }));
    for (i = 0; i < 5; i++) feedLines.push(line('lo-' + i, 'left_out', 10 + i, 'Payment Thank You ' + (i + 1), 500 + i, { tour_id: null, reason: 'card_payment', why: 'Card payment' }));
    feedLines.push(line('lo-5', 'left_out', 70, 'Shell Oil', 48.1, { tour_id: null, reason: 'outside_dates', why: 'Not during a tour' }));
    feedLines.push(line('lo-6', 'left_out', 72, 'Spotify', 11.99, { tour_id: null, reason: 'outside_dates', why: 'Not during a tour' }));
    feedLines.push(line('lo-7', 'left_out', 4, 'Uber *Trip', 23.4, { reason: 'bank_removed', why: 'Taken back by the bank', gone_on: dayAgo(1) }));
    feedLines.push(line('sk-0', 'skipped', 5, 'Netflix.com', 15.49, { reason: 'set_aside', decided_at: new Date(Date.now() - 864e5).toISOString() }));
    feedLines.push(line('sk-1', 'skipped', 7, 'Zelle payment to Ana Reyes', 250, { reason: 'same_as_typed', decided_at: new Date(Date.now() - 2 * 864e5).toISOString() }));
    feedLines.push(line('sk-2', 'skipped', 16, 'Hotel Indigo', 189, { why: 'Maybe already in' }));
    feedLines.push(line('fi-0', 'filed', 8, 'Lyft *Ride', 31.2, { gone_on: dayAgo(2) }));
    feedLines.push(line('fi-1', 'filed', 10, 'Chevron 0092', 50, { bank_amount: 52.1 }));
    feedLines.push(line('fi-2', 'filed', 11, 'Guitar Center #214', 412.88));
    feedLines.push(line('fi-3', 'filed', 12, 'Marriott', 219, { bank_amount: 219 }));
    return feedLines;
  }
  // What feed_account says, counted from the lines above (no tour holds anything here, so every filed line is "on no tour").
  function feedAccount() {
    var rows = feedDb(), by = { waiting: 0, filed: 0, left_out: 0, skipped: 0, mypay: 0 }, lo = {}, left = [], aside = { n: 0, sum: 0 };
    rows.forEach(function (r) {
      by[r.status] += 1;
      if (r.status === 'skipped') { aside.n += 1; aside.sum = Math.round((aside.sum + r.amount) * 100) / 100; }
      if (r.status !== 'left_out') return;
      var g = lo[r.reason];
      if (!g) { g = lo[r.reason] = { reason: r.reason, n: 0, sum: 0, first_day: r.date, last_day: r.date }; left.push(g); }
      // (A reason's total is its lines with the signs taken off.)
      g.n += 1; g.sum = Math.round((g.sum + Math.abs(r.amount)) * 100) / 100;
      if (r.date < g.first_day) g.first_day = r.date;
      if (r.date > g.last_day) g.last_day = r.date;
    });
    // (ok is false only when a read from the start ran out of pages; that bank's entry then says more: true.)
    var more = !!H.moreHistory;
    return { total: rows.length, by_status: by, waiting_by_tour: by.waiting ? [{ tour_id: 't1', name: 'The Test Tour', kind: 'tour', n: by.waiting }] : [],
      left_out: left, set_aside: aside,
      look: { no_tour: by.filed, bank_gone: rows.filter(function (r) { return r.gone_on && r.status !== 'left_out' && r.status !== 'waiting'; }).length,
        bank_changed: rows.filter(function (r) { return r.bank_amount != null && r.bank_amount !== r.amount; }).length },
      banks: [{ institution: 'First Platypus Bank', status: 'ok', last_ok: new Date().toISOString(), linked: dayAgo(40),
        full_read: more ? null : new Date(Date.now() - 2 * 864e5).toISOString(), more: more }],
      check: { at: new Date(Date.now() - 2 * 864e5).toISOString(), bank_sent: rows.length + 21, found: 3, new_waiting: 3, new_filed: 0, new_left_out: 0,
        unexplained: 0, ok: !more },
      not_kept: { off: [], money_in: 21 } };
  }
  // One read of the feed's tables, the way the real ones answer: filters, order, a count, and at most `cap` rows.
  function feedSelect(table, q) {
    var bad = no('fake: the read failed', '57014');
    if (table === 'ynab_allowed') return later(ok(H.allowed === false ? null : { owner_id: 'fake-owner' }));
    if (table === 'feed') {
      if (H.feedFail) return later(bad);
      return later(ok(H.noFeed ? null : { switched_on: true, plan_name: '', since: dayAgo(40), last_run: new Date().toISOString(), last_status: 'ok', source: 'plaid' }));
    }
    var status = q.eq.status;
    if (H.feedFail || (status === 'waiting' && H.pileFail) || (status !== 'waiting' && H.leftOutFail)) return later(bad);
    var rows = feedDb().filter(function (r) {
      return Object.keys(q.eq).every(function (k) { return r[k] === q.eq[k]; }) &&
        Object.keys(q.isIn).every(function (k) { return q.isIn[k].indexOf(r[k]) >= 0; }) &&
        // (Compared the way the rows are put in order below, so "past this line" means the same in both.)
        Object.keys(q.gt).every(function (k) { return String(r[k]).localeCompare(String(q.gt[k])) > 0; }) &&
        Object.keys(q.lt).every(function (k) { return String(r[k]).localeCompare(String(q.lt[k])) < 0; }) &&
        q.notNull.every(function (k) { return r[k] != null; });
    });
    rows.sort(function (a, b) {
      for (var i = 0; i < q.order.length; i++) {
        var k = q.order[i][0], d = String(a[k]).localeCompare(String(b[k]));
        if (d) return q.order[i][1] ? d : -d;
      }
      return 0;
    });
    var count = rows.length, from = q.range ? q.range[0] : 0, to = q.range ? q.range[1] + 1 : rows.length;
    // Like the real one: a page that starts past the last row, asked for with a count, is an error, not an empty page.
    if (q.count && from > 0 && from >= count) return later(no('Requested range not satisfiable', 'PGRST103'));
    var cap = H.cap > 0 ? Math.round(H.cap) : 1000;
    rows = rows.slice(from, Math.min(to, from + cap, q.limit != null ? from + q.limit : Infinity));
    return later({ data: JSON.parse(JSON.stringify(rows)), error: null, count: q.count ? count : null });
  }
  function feedRpc(name, a) {
    if (name === 'feed_account') {
      if (H.accountFail) return later(no('fake: feed_account failed', '57014'));
      return later(ok(H.account ? JSON.parse(JSON.stringify(H.account)) : feedAccount()));
    }
    // feed_put_back: left out (never one the bank took back) or set aside goes back to waiting; so does a filed
    // line no tour holds (here: every filed line). A line the bank has withdrawn (gone_on) stays where it is.
    // The line keeps its warning ("Put back: " and what it was left out for; "Maybe already in" again for one
    // set aside as the one he typed; any other set-aside keeps its words) and takes the bank's latest figure.
    // Answers how many moved.
    if (H.putBackFail) return later(no('fake: feed_put_back failed', '57014'));
    var n = 0;
    feedDb().forEach(function (r) {
      if ((a.ids || []).indexOf(r.id) < 0) return;
      if (r.gone_on || !((r.status === 'left_out' && r.reason !== 'bank_removed') || r.status === 'skipped' || r.status === 'filed')) return;
      r.why = r.status === 'filed' ? 'Put back: it was on no tour'
        : r.status === 'left_out' ? (r.why ? 'Put back: ' + r.why : 'Put back')
        : r.reason === 'same_as_typed' ? 'Maybe already in' : r.why;
      if (r.bank_amount != null) { r.amount = r.bank_amount; r.bank_amount = null; }
      r.status = 'waiting'; r.reason = null; r.decided_at = new Date().toISOString();
      n += 1;
    });
    return later(ok(n));
  }

  // from(table): every step hands the same builder back; waiting on it
  // answers { data: [], error: null } (one row asked for: data null).
  // (The card feed's three tables are really filtered, ordered and paged: see feedSelect.)
  function from(table) {
    var op = 'select', payload, single = false;
    var feedTable = table === 'feed' || table === 'feed_items' || table === 'ynab_allowed';
    var q = { eq: {}, isIn: {}, gt: {}, lt: {}, notNull: [], order: [], range: null, limit: null, count: false };
    var b = {};
    ['select', 'eq', 'neq', 'in', 'or', 'order', 'limit', 'gte', 'lte', 'gt', 'lt', 'is', 'not', 'match', 'filter',
      'range', 'contains', 'ilike', 'like'].forEach(function (m) { b[m] = function () { return b; }; });
    ['insert', 'upsert', 'update', 'delete'].forEach(function (m) {
      b[m] = function (row) { op = m; payload = row; return b; };
    });
    b.maybeSingle = b.single = function () { single = true; return b; };
    if (feedTable) {
      b.select = function (cols, o) { if (o && o.count) q.count = true; return b; };
      b.eq = function (k, v) { q.eq[k] = v; return b; };
      b.in = function (k, list) { q.isIn[k] = list || []; return b; };
      b.gt = function (k, v) { q.gt[k] = v; return b; };
      b.lt = function (k, v) { q.lt[k] = v; return b; };
      b.not = function (k, how, v) { if (how === 'is' && v === null) q.notNull.push(k); return b; };
      b.order = function (k, o) { q.order.push([k, !(o && o.ascending === false)]); return b; };
      b.range = function (a, z) { q.range = [a, z]; return b; };
      b.limit = function (n) { q.limit = n; return b; };
    }
    function run() {
      if (feedTable) {
        log('from(' + table + ').' + op, op === 'select' ? [{ where: q.eq, range: q.range, gt: q.gt, lt: q.lt, limit: q.limit }] : [payload]);
        // The phone may read these tables and nothing else (0136 took its right to write feed_items away).
        if (op !== 'select') return later(no('permission denied for table ' + table, '42501'));
        return feedSelect(table, q);
      }
      log('from(' + table + ').' + op, payload === undefined ? [] : [payload]);
      if (table === 'profiles' && op === 'upsert' && payload && Object.prototype.hasOwnProperty.call(payload, 'handle')) {
        if (payload.handle === 'brent') {
          return later(no('duplicate key value violates unique constraint "profiles_handle_key"', '23505'));
        }
        account.handle = String(payload.handle || '');
      }
      return later(ok(single ? null : []));
    }
    b.then = function (res, rej) { return run().then(res, rej); };
    return b;
  }

  function channel(name) {
    var ch = {
      on: function () { return ch; },
      subscribe: function (fn) {
        log('channel(' + name + ').subscribe', []);
        setTimeout(function () { if (typeof fn === 'function') fn('SUBSCRIBED'); }, 0);
        return ch;
      },
      unsubscribe: function () { return Promise.resolve('ok'); }
    };
    return ch;
  }

  /* The one thing the gate asks the project for outside supabase-js: its
     public sign-up switches (GET <project>/auth/v1/settings). The page's own
     fetch is stood in for that one address only; everything else (the app's
     styles, backend.js itself) goes out as usual. */
  var realFetch = window.fetch;
  window.fetch = function (input) {
    var url = String(input && input.url ? input.url : input);
    if (!/\/auth\/v1\/settings(\?|$)/.test(url)) return realFetch.apply(window, arguments);
    log('fetch /auth/v1/settings', []);
    if (SETTINGS === 'hang') return never();
    if (SETTINGS === 'off') return later(new Response('{"message":"fake: the settings cannot be read"}', { status: 500 }));
    return later(new Response(JSON.stringify({ external: { email: true }, disable_signup: CLOSED,
      mailer_autoconfirm: !CONFIRM }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };

  function createClient(url, key, o) {
    log('createClient', [url, { flowType: o && o.auth ? o.auth.flowType : undefined }]);
    return { auth: auth, rpc: rpc, from: from, channel: channel,
      removeChannel: function () { log('removeChannel', []); return Promise.resolve('ok'); } };
  }

  window.GR_FAKE_SUPABASE = {
    createClient: createClient,
    // backend.js hands this to createClient as the sign-in lock; here it just runs the job.
    processLock: function (name, wait, fn) { return Promise.resolve().then(fn); }
  };
})();
