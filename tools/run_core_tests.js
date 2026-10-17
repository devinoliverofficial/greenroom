/* Runs the app's core and statement tests on this Mac with the JavaScript
   engine that ships with macOS (there is no Node here). The same two suites
   tests/index.html runs in a browser.

     cd /path/to/Greenroom
     /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc tools/run_core_tests.js

   Prints "core tests: N pass, M fail" and "statement tests: N pass, M fail",
   then each failure, and exits non-zero when anything fails. */
(function () {
  'use strict';
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  load('src/core.js');
  load('tests/tests.js');
  load('src/statements.js');
  load('tests/statement-tests.js');
  var bad = 0;
  [['core', globalThis.GR_TESTS], ['statement', globalThis.GR_STATEMENT_TESTS]].forEach(function (p) {
    var r = (p[1] && p[1].results) || [];
    var fails = r.filter(function (x) { return !x.ok; });
    print(p[0] + ' tests: ' + (r.length - fails.length) + ' pass, ' + fails.length + ' fail');
    fails.forEach(function (x) { print('  FAIL ' + x.name + '\n       ' + x.msg); });
    if (!r.length) { print('  (no ' + p[0] + ' tests ran)'); bad += 1; }
    bad += fails.length;
  });
  if (bad) throw new Error(bad + ' failing');
})();
