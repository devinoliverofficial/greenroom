/* Runs the bank feed's sorter tests on this Mac. There is no Node, Deno or Bun
   here, so it uses the JavaScript engine that ships with macOS:

     cd /path/to/Greenroom
     /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc tools/run_feed_tests.js

   What it does:
     1. loads the app's own rules the server uses (lib/core.js, lib/statements.js);
     2. reads supabase/functions/plaid/index.ts and cuts out the text between
        "// ---- pure:start ----" and "// ---- pure:end ----": every function
        that decides what happens to a line from a bank;
     3. takes out the few type notes that block is allowed to carry, so plain
        JavaScript is left, and evaluates it;
     4. looks at every byte of index.ts: the file is pasted by hand into the
        Supabase dashboard, and a clipboard once turned two middle dots into
        other characters, so it must be plain ASCII (a character outside
        ASCII is written as a \u escape in code, and in words in a comment).
        The lines that break this are handed to the tests, which fail on any.
        The file's text is handed over too, for the test that the requests it
        may make of Plaid are the same read-only ones;
     5. runs tests/feed-sorter-tests.js against it and prints
        "feed sorter tests: N pass, M fail", then each failure.

   To also write the stripped block to a file and have jsc check its syntax,
   give a path after "--":
     .../jsc tools/run_feed_tests.js -- /tmp/pure_block.js */
(function () {
  'use strict';

  var INDEX = 'supabase/functions/plaid/index.ts';
  var START = '// ---- pure:start ----', END = '// ---- pure:end ----';
  // What the tests reach for. Every name here must exist in the pure block.
  var NAMES = ['RULES', 'LEFT_OUT_WORDS', 'typeOf', 'defaultMode', 'cardType', 'isCredit', 'bankSaysCard', 'cleanName',
    'outKind', 'sentAs', 'isWary', 'sentName', 'lineId', 'asTx', 'rescueTx', 'takeRead', 'asTours', 'toursOn', 'tourFor',
    'arrivalsOf', 'otherHalf', 'placeLine', 'ledgerOf', 'ledgerLine', 'ledgerSum', 'sortTransactions',
    'owedFullReads', 'carryRemoved', 'reopenedBanks', 'chargesHeld', 'notThere', 'pagePlace', 'nextPage', 'pilePlace', 'forManager'];

  function fail(msg) {
    print('feed sorter tests: 0 pass, 1 fail');
    print('  FAIL the pure block could not be run: ' + msg);
    throw new Error(msg);
  }

  /* The only type notes the pure block may carry (spec B1): ": any",
     ": any[]", ": string", ": number", ": boolean", ": Record<string, any>"
     and "as any". Anything else TypeScript-only is left in, and the block then
     fails to parse, which is the point. */
  function strip(ts) {
    return ts
      .replace(/\s+as\s+any\b/g, '')
      .replace(/:\s*Record<string,\s*any>(?:\[\])?(?=\s*(?:[,)=;{]|$))/gm, '')
      .replace(/:\s*(?:any|string|number|boolean)(?:\[\])?(?=\s*(?:[,)=;{]|$))/gm, '');
  }

  load('supabase/functions/plaid/lib/core.js');
  load('supabase/functions/plaid/lib/statements.js');
  if (!globalThis.GR || !globalThis.GRS) fail('lib/core.js and lib/statements.js did not give GR and GRS');

  var src = readFile(INDEX);

  /* Every byte of the function's file, looked at as a byte: any above 0x7F is
     noted with the line it is on (1-based). If this engine cannot hand the
     file over as bytes, the text is looked at instead: a byte above 0x7F never
     reads back as a character at or below it. */
  var high = [];
  (function () {
    var bytes = null, i, line = 1, last = 0;
    try { bytes = readFile(INDEX, 'binary'); } catch (e) { bytes = null; }
    if (bytes && typeof bytes.length === 'number' && bytes.length > 0 && typeof bytes[0] === 'number') {
      for (i = 0; i < bytes.length; i++) {
        if (bytes[i] === 10) line += 1;
        else if (bytes[i] > 0x7F && last !== line) { high.push(line); last = line; }
      }
    } else {
      for (i = 0; i < src.length; i++) {
        if (src.charCodeAt(i) === 10) line += 1;
        else if (src.charCodeAt(i) > 0x7F && last !== line) { high.push(line); last = line; }
      }
    }
  })();
  globalThis.FEED_INDEX_HIGH_BYTES = high;
  globalThis.FEED_INDEX_LENGTH = src.length;
  // (The whole file's text, for the test that the list of requests it may make of Plaid has not changed.)
  globalThis.FEED_INDEX_TEXT = src;

  var a = src.indexOf(START), b = src.indexOf(END);
  if (a < 0 || b < 0 || b < a) fail('the markers "' + START + '" and "' + END + '" are not both in ' + INDEX);
  if (src.indexOf(START, a + 1) >= 0 || src.indexOf(END, b + 1) >= 0) fail('a marker appears twice in ' + INDEX);
  var ts = src.slice(a + START.length, b);
  var js = strip(ts);

  // Optional: write the stripped block out and let jsc check its syntax as a file.
  var args = globalThis.arguments;
  var out = (args && args.length) ? String(args[0]) : '';
  if (out) {
    writeFile(out, js);
    try { checkSyntax(out); print('checkSyntax: ' + out + ' is valid JavaScript (' + js.split('\n').length + ' lines)'); }
    catch (e) { fail('checkSyntax refused the stripped block: ' + e); }
  }

  var F;
  try {
    F = (new Function('G', 'GRS', js + '\nreturn { ' + NAMES.map(function (n) { return n + ': ' + n; }).join(', ') + ' };'))(globalThis.GR, globalThis.GRS);
  } catch (e) {
    fail('after the type notes were taken out it is not plain JavaScript, or a name is missing (' + e + ')');
  }

  globalThis.FEED = F;
  // (For the test that the block reads and writes nothing: its text with comments taken out.)
  globalThis.FEED_SOURCE = js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\"'])\/\/.*$/gm, '$1');
  load('tests/feed-sorter-tests.js');

  var r = (globalThis.GR_FEED_TESTS && globalThis.GR_FEED_TESTS.results) || [];
  var bad = r.filter(function (x) { return !x.ok; });
  print('feed sorter tests: ' + (r.length - bad.length) + ' pass, ' + bad.length + ' fail');
  bad.forEach(function (x) { print('  FAIL ' + x.name + '\n       ' + x.msg); });
  if (!r.length) throw new Error('no tests ran');
  if (bad.length) throw new Error(bad.length + ' failing');
})();
