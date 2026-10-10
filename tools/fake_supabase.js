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
       ?old=1           a database that has no sign-up functions yet */
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
    // claim_invites and anything else: nothing to say.
    return later(ok(null));
  }

  // from(table): every step hands the same builder back; waiting on it
  // answers { data: [], error: null } (one row asked for: data null).
  function from(table) {
    var op = 'select', payload, single = false;
    var b = {};
    ['select', 'eq', 'neq', 'in', 'or', 'order', 'limit', 'gte', 'lte', 'gt', 'lt', 'is', 'not', 'match', 'filter',
      'range', 'contains', 'ilike', 'like'].forEach(function (m) { b[m] = function () { return b; }; });
    ['insert', 'upsert', 'update', 'delete'].forEach(function (m) {
      b[m] = function (row) { op = m; payload = row; return b; };
    });
    b.maybeSingle = b.single = function () { single = true; return b; };
    function run() {
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
