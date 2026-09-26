"""Builds src/_dbstub.html: the real app in 'db' (signed-in) mode against an
in-memory fake backend, so account/crew UI can be tested locally without
signing anything into the live Supabase project. Run after build.py."""
import pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
page = (ROOT / 'src/index.html').read_text(encoding='utf-8')
shim = r"""<script>
/* ---- fake signed-in backend (dev only) ---- */
(function () {
  var today = new Date();
  var ymd = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  var tours = {
    t1: { name: 'Harness run', artist: 'I See Stars', setupDone: true, setupStep: 5, createdAt: 1,
      expenses: {}, commission: {}, crew: {}, debts: {}, extras: {}, charges: {}, imports: {},
      shows: { s1: { id: 's1', date: ymd(today), city: 'Austin, TX', venue: 'Mohawk',
        daySheet: { doors: '7:00 PM', venueAddress: '912 Red River St, Austin, TX 78701' } } } }
  };
  var subs = [];
  function snap() {
    return { docs: Object.keys(tours).map(function (id) {
      return { id: id, exists: true, data: function () { return JSON.parse(JSON.stringify(tours[id])); } }; }) };
  }
  function emit() { subs.forEach(function (cb) { cb(snap()); }); }
  var db = {
    collection: function (name) { return { onSnapshot: function (cb) {
      if (name === 'tours') { subs.push(cb); setTimeout(function () { cb(snap()); }, 0); }
      else setTimeout(function () { cb({ docs: [] }); }, 0);
      return function () {}; } }; },
    doc: function (path) {
      var id = path.split('/')[1];
      return {
        get: function () { return Promise.resolve({ exists: !!tours[id], data: function () { return tours[id]; } }); },
        set: function (v) { if (path.indexOf('tours/') === 0) { tours[id] = v; emit(); } return Promise.resolve(); },
        update: function (v) { if (path.indexOf('tours/') === 0) { tours[id] = Object.assign({}, tours[id], v); emit(); } return Promise.resolve(); },
        delete: function () { delete tours[id]; emit(); return Promise.resolve(); }
      };
    }
  };
  window.claude = { use: function (n) { return Promise.resolve(n === 'db' ? db : null); } };
  var me = { first_name: 'Devin', last_name: 'Oliver', full_name: 'Devin Oliver', username: 'Devin Oliver',
    phone: '555-0100', tour_role: 'Artist/Owner' };
  window.__harness = { me: me, crew: [
    { owner: true, role: 'owner', name: 'Devin Oliver', email: 'devin@example.com', phone: '555-0100', tourRole: 'Artist/Owner', joined: true },
    { owner: false, role: 'editor', name: 'Brent Allen', email: 'brent@example.com', phone: '(313) 555-0142', tourRole: 'Guitar Tech', joined: true },
    { owner: false, role: 'viewer', name: 'Tasha Lane', email: 'tasha@example.com', phone: '', tourRole: 'Production Manager', joined: false }
  ] };
  window.GR_BACKEND = {
    tourRoles: ['Artist/Owner', 'Band', 'Tour Manager', 'Production Manager', 'Stage Manager', 'Merch',
      'Guitar Tech', 'Drum Tech', 'Assistant', 'FOH Engineer', 'Monitors', 'Friend', 'Family Member', 'Liaison', 'Dancer'],
    email: function () { return 'devin@example.com'; },
    uid: function () { return 'u-devin'; },
    username: function () { return me.username; },
    ownsTour: function () { return true; },
    myRole: function () { return Promise.resolve('owner'); },
    crew: function () { return Promise.resolve(window.__harness.crew); },
    myProfile: function () { return { firstName: me.first_name, lastName: me.last_name, fullName: me.full_name,
      username: me.username, phone: me.phone, tourRole: me.tour_role, email: 'devin@example.com' }; },
    saveProfile: function (p) { me.first_name = p.firstName; me.last_name = p.lastName;
      me.full_name = (p.firstName + ' ' + p.lastName).trim(); me.username = me.full_name;
      me.phone = p.phone; me.tour_role = p.tourRole; window.__harness.saved = JSON.parse(JSON.stringify(me));
      return Promise.resolve(); },
    signOut: function () {}
  };
})();
</script>
"""
out = page.replace('<script src="core.js"></script>', shim + '<script src="core.js"></script>')
assert out != page, 'core.js tag not found'
(ROOT / 'src/_dbstub.html').write_text(out, encoding='utf-8')
print('src/_dbstub.html written')
