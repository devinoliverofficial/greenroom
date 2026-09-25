#!/usr/bin/env python3
"""Assemble Greenroom's two build outputs.

dist/  — the Claude Artifact build: the dev wrapper is stripped (the Artifact
         runtime supplies <!doctype>/<html>/<head>/<body>), and vendored pdf.js
         gets its raw control bytes rewritten as \\xNN escapes because the
         publisher rejects them (JavaScript reads both spellings identically).

docs/  — the real site (GitHub Pages): the full document as written, plus the
         PWA pieces — manifest link, icon files, and a service worker stamped
         with the build time so each deploy replaces the last cleanly.
"""
import re
import time
import shutil
import pathlib

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / 'src'
SITE = ROOT / 'site'

CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')


def escape_controls(text):
    return CONTROL.sub(lambda m: '\\x%02x' % ord(m.group(0)), text)


def build_artifact():
    dist = ROOT / 'dist'
    if dist.exists():
        shutil.rmtree(dist)
    (dist / 'vendor').mkdir(parents=True)

    src = (SRC / 'index.html').read_text(encoding='utf-8')
    head = re.search(r'<head>(.*?)</head>', src, re.S).group(1)
    body = re.search(r'<body>(.*?)</body>', src, re.S).group(1)
    keep = [m.group(0) for m in re.finditer(
        r'<title>.*?</title>|<link [^>]*>|<style>.*?</style>', head, re.S)]
    page = '\n'.join(keep).strip() + '\n' + body.strip() + '\n'
    (dist / 'index.html').write_text(page, encoding='utf-8')

    for name in ['core.js', 'statements.js', 'app.js']:
        (dist / name).write_text((SRC / name).read_text(encoding='utf-8'), encoding='utf-8')
    for path in sorted((SRC / 'vendor').glob('*.mjs')):
        (dist / 'vendor' / path.name).write_text(
            escape_controls(path.read_text(encoding='utf-8')), encoding='utf-8')
    shutil.copy(SRC / 'logo-full.png', dist / 'logo-full.png')
    shutil.copy(SRC / 'logo-mastertour.png', dist / 'logo-mastertour.png')
    shutil.copy(SRC / 'logo-atvenu.png', dist / 'logo-atvenu.png')
    print('dist/  (artifact) %d bytes of page' % len(page))


def build_web():
    web = ROOT / 'docs'
    if web.exists():
        shutil.rmtree(web)
    (web / 'vendor').mkdir(parents=True)

    stamp = time.strftime('%Y%m%d-%H%M%S')
    SCRATCH_CLASSIC = ROOT / 'site' / 'classic-icons'
    html = (SRC / 'index.html').read_text(encoding='utf-8')

    inject = ('<link rel="manifest" href="manifest.webmanifest?v=' + stamp + '">\n'
              '<meta name="theme-color" content="#000000">\n'
              '<script>window.GREENROOM_BUILD = "' + stamp + '";</script>')
    html = html.replace('<title>Greenroom</title>',
                        '<title>Greenroom</title>\n' + inject)
    import re as _re0
    icon_name = 'icon-' + stamp + '.png'
    # -precomposed tells iOS the icon is finished art: no gloss, no gradient,
    # no shine overlay. Without it iOS fades the icon top-to-bottom.
    html = _re0.sub(r'<link rel="apple-touch-icon" href="[^"]+">',
                    '<link rel="apple-touch-icon-precomposed" href="' + icon_name + '">\n'
                    '<link rel="apple-touch-icon" href="' + icon_name + '">',
                    html, count=1)

    sw = ('<script>\n'
          "if ('serviceWorker' in navigator && location.protocol === 'https:') {\n"
          "  addEventListener('load', function () { navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }); });\n"
          '}\n</script>\n</body>')
    html = html.replace('<script src="core.js"></script>',
                        '<script src="config.js"></script>\n'
                        '<script src="backend.js"></script>\n'
                        '<script src="core.js"></script>')
    html = html.replace('</body>', sw)
    (web / 'index.html').write_text(html, encoding='utf-8')
    # The same page under a second name: Safari keeps a per-URL icon database
    # that re-adding does not flush, so a fresh URL is the reliable way to get
    # a new home-screen icon (classic.html proved it). The manifest's
    # start_url still opens ./, so the installed app is identical.
    (web / 'app.html').write_text(html, encoding='utf-8')
    # ...and one whose NAME changes with every build: always a virgin URL,
    # so Safari's per-URL icon memory can never have seen it. The build
    # prints the current one; hand that to whoever needs a fresh add.
    (web / ('add-' + stamp + '.html')).write_text(html, encoding='utf-8')
    print('fresh add-from URL: add-' + stamp + '.html')

    for name in ['core.js', 'statements.js', 'app.js']:
        shutil.copy(SRC / name, web / name)
    shutil.copy(SITE / 'config.js', web / 'config.js')
    shutil.copy(SITE / 'backend.js', web / 'backend.js')
    html = None  # guard against accidental reuse below
    for path in sorted((SRC / 'vendor').glob('*.mjs')):
        shutil.copy(path, web / 'vendor' / path.name)
    shutil.copy(SRC / 'logo-full.png', web / 'logo-full.png')
    shutil.copy(SRC / 'logo-mastertour.png', web / 'logo-mastertour.png')
    shutil.copy(SRC / 'logo-atvenu.png', web / 'logo-atvenu.png')
    shutil.copy(SRC / 'icon-180.png', web / 'icon-180.png')
    shutil.copy(SRC / 'icon-512.png', web / 'icon-512.png')
    shutil.copy(SRC / 'gr-stark-180.png', web / 'gr-stark-180.png')
    shutil.copy(SRC / 'gr-stark-512.png', web / 'gr-stark-512.png')
    shutil.copy(SRC / 'gr-icon-1024.png', web / 'gr-icon-1024.png')
    shutil.copy(SRC / 'gr-icon-192.png', web / 'gr-icon-192.png')
    # A brand-new icon FILENAME every build: Safari caches touch icons by
    # file name and ignores ?v= query strings, which is why six correct
    # deploys all replayed the same stale icon.
    shutil.copy(SRC / 'gr-icon-1024.png', web / icon_name)
    _mf = (SITE / 'manifest.webmanifest').read_text(encoding='utf-8')
    (web / 'manifest.webmanifest').write_text(
        _mf.replace('gr-icon-1024.png', icon_name)
           .replace('gr-stark-512.png', 'gr-stark-512.png?v=' + stamp)
           .replace('gr-icon-192.png', 'gr-icon-192.png?v=' + stamp)
           .replace('gr-stark-180.png', 'gr-stark-180.png?v=' + stamp), encoding='utf-8')
    (web / 'sw.js').write_text(
        (SITE / 'sw.js').read_text(encoding='utf-8').replace('__BUILD__', stamp),
        encoding='utf-8')
    # ---- Greenroom Classic: the same app in the original skin, as its own
    # install (second home-screen icon). Only looks differ; code is shared. ----
    import re as _re
    ch = (SRC / 'index.html').read_text(encoding='utf-8')
    capple = (SCRATCH_CLASSIC / 'classic_apple_b64.txt').read_text().strip()
    cfav = (SCRATCH_CLASSIC / 'classic_fav_b64.txt').read_text().strip()
    ch = _re.sub(r'(<link rel="apple-touch-icon" href="data:image/png;base64,)[^"]+(")',
                 lambda mm: mm.group(1) + capple + mm.group(2), ch, count=1)
    ch = _re.sub(r'(<link rel="icon" href="data:image/png;base64,)[^"]+(")',
                 lambda mm: mm.group(1) + cfav + mm.group(2), ch, count=1)
    cicon = 'icon-classic-' + stamp + '.png'
    shutil.copy(SRC / 'icon-classic-512.png', web / cicon)
    ch = _re.sub(r'<link rel="apple-touch-icon" href="[^"]+">',
                 '<link rel="apple-touch-icon-precomposed" href="' + cicon + '">\n'
                 '<link rel="apple-touch-icon" href="' + cicon + '">',
                 ch, count=1)
    ch = ch.replace('<title>Greenroom</title>',
        '<title>Greenroom Classic</title>\n'
        '<link rel="manifest" href="manifest-classic.webmanifest?v=' + stamp + '">\n'
        '<meta name="theme-color" content="#000000">\n'
        '<script>window.GREENROOM_BUILD = "' + stamp + '";\n'
        "window.GR_SKIN = 'classic';\n"
        "document.documentElement.setAttribute('data-theme', 'light');</script>")
    ch = ch.replace('position: fixed; inset: 0; z-index: 120; background: #CCF80A;',
                    'position: fixed; inset: 0; z-index: 120; background: #000A05;')
    ch = ch.replace('<img src="logo-full.png" alt="">', '<img src="logo-full-classic.png" alt="">')
    ch = ch.replace('<script src="core.js"></script>',
                    '<script src="config.js"></script>\n'
                    '<script src="backend.js"></script>\n'
                    '<script src="core.js"></script>')
    ch = ch.replace('</body>', sw)
    (web / 'classic.html').write_text(ch, encoding='utf-8')
    shutil.copy(SRC / 'icon-classic-180.png', web / 'icon-classic-180.png')
    shutil.copy(SRC / 'icon-classic-512.png', web / 'icon-classic-512.png')
    shutil.copy(SRC / 'logo-full-classic.png', web / 'logo-full-classic.png')
    _mfc = (SITE / 'manifest-classic.webmanifest').read_text(encoding='utf-8')
    (web / 'manifest-classic.webmanifest').write_text(
        _mfc.replace('icon-classic-180.png', 'icon-classic-180.png?v=' + stamp)
            .replace('icon-classic-512.png', 'icon-classic-512.png?v=' + stamp), encoding='utf-8')

    # A one-purpose icon diagnostic: unmistakable test icon, virgin URL.
    (web / 'icontest.html').write_text(
        '<!doctype html><html><head><meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<title>GR Icon Test</title>\n'
        '<link rel="apple-touch-icon" sizes="180x180" href="icon-test.png?v=' + stamp + '">\n'
        '<meta name="apple-mobile-web-app-capable" content="yes">\n'
        '</head><body style="font-family:-apple-system,sans-serif;background:#111;color:#eee;'
        'display:grid;place-items:center;height:100vh;margin:0;text-align:center">\n'
        '<div><h1>Icon test</h1><p>Share \u2192 Add to Home Screen.<br>'
        'The icon should be a RED square with a white 1.</p></div></body></html>\n',
        encoding='utf-8')
    shutil.copy(SRC / 'icon-test.png', web / 'icon-test.png')

    # GitHub Pages must not run Jekyll over this folder.
    (web / '.nojekyll').write_text('')
    print('docs/  (real site) build %s' % stamp)


if __name__ == '__main__':
    build_artifact()
    build_web()
