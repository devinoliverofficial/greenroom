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

    inject = ('<link rel="manifest" href="manifest.webmanifest">\n'
              '<meta name="theme-color" content="#000000">\n'
              '<script>window.GREENROOM_BUILD = "' + stamp + '";</script>')
    html = html.replace('<title>Greenroom</title>',
                        '<title>Greenroom</title>\n' + inject)

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
    shutil.copy(SITE / 'manifest.webmanifest', web / 'manifest.webmanifest')
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
    ch = ch.replace('<title>Greenroom</title>',
        '<title>Greenroom Classic</title>\n'
        '<link rel="manifest" href="manifest-classic.webmanifest">\n'
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
    shutil.copy(SITE / 'manifest-classic.webmanifest', web / 'manifest-classic.webmanifest')

    # GitHub Pages must not run Jekyll over this folder.
    (web / '.nojekyll').write_text('')
    print('docs/  (real site) build %s' % stamp)


if __name__ == '__main__':
    build_artifact()
    build_web()
