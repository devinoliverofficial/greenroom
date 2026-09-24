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
    print('dist/  (artifact) %d bytes of page' % len(page))


def build_web():
    web = ROOT / 'docs'
    if web.exists():
        shutil.rmtree(web)
    (web / 'vendor').mkdir(parents=True)

    stamp = time.strftime('%Y%m%d-%H%M%S')
    html = (SRC / 'index.html').read_text(encoding='utf-8')

    inject = ('<link rel="manifest" href="manifest.webmanifest">\n'
              '<meta name="theme-color" content="#000000">')
    html = html.replace('<title>Greenroom</title>',
                        '<title>Greenroom</title>\n' + inject)

    sw = ('<script>\n'
          "if ('serviceWorker' in navigator && location.protocol === 'https:') {\n"
          "  addEventListener('load', function () { navigator.serviceWorker.register('sw.js'); });\n"
          '}\n</script>\n</body>')
    html = html.replace('</body>', sw)
    (web / 'index.html').write_text(html, encoding='utf-8')

    for name in ['core.js', 'statements.js', 'app.js']:
        shutil.copy(SRC / name, web / name)
    for path in sorted((SRC / 'vendor').glob('*.mjs')):
        shutil.copy(path, web / 'vendor' / path.name)
    shutil.copy(SRC / 'icon-180.png', web / 'icon-180.png')
    shutil.copy(SRC / 'icon-512.png', web / 'icon-512.png')
    shutil.copy(SITE / 'manifest.webmanifest', web / 'manifest.webmanifest')
    (web / 'sw.js').write_text(
        (SITE / 'sw.js').read_text(encoding='utf-8').replace('__BUILD__', stamp),
        encoding='utf-8')
    # GitHub Pages must not run Jekyll over this folder.
    (web / '.nojekyll').write_text('')
    print('docs/  (real site) build %s' % stamp)


if __name__ == '__main__':
    build_artifact()
    build_web()
