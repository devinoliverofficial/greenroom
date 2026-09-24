"""Minimal PNG read/write and resampling, in pure Python.

This Mac has no Pillow, and `sips` can't turn a flat dark background into
transparency, so the little that Greenroom needs lives here: decode 8-bit
RGB/RGBA, crop, box-resample, key out a background colour, encode.
"""
import struct
import zlib


def decode(path):
    """Return (width, height, channels, bytearray of pixel data)."""
    raw = open(path, 'rb').read()
    assert raw[:8] == b'\x89PNG\r\n\x1a\n', 'not a PNG'
    pos, idat, ihdr = 8, [], None
    while pos < len(raw):
        ln = struct.unpack('>I', raw[pos:pos + 4])[0]
        tag = raw[pos + 4:pos + 8]
        body = raw[pos + 8:pos + 8 + ln]
        if tag == b'IHDR':
            ihdr = struct.unpack('>IIBBBBB', body)
        elif tag == b'IDAT':
            idat.append(body)
        elif tag == b'IEND':
            break
        pos += 12 + ln

    w, h, depth, ctype, comp, filt, interlace = ihdr
    assert depth == 8 and interlace == 0, 'only 8-bit non-interlaced supported'
    ch = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]

    data = zlib.decompress(b''.join(idat))
    stride = w * ch
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        ft = data[p]; p += 1
        line = bytearray(data[p:p + stride]); p += stride
        if ft == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 255
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif ft == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif ft == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, ch, out


def encode(path, w, h, ch, px):
    ctype = {1: 0, 2: 4, 3: 2, 4: 6}[ch]
    stride = w * ch
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += px[y * stride:(y + 1) * stride]

    def chunk(tag, body):
        return (struct.pack('>I', len(body)) + tag + body +
                struct.pack('>I', zlib.crc32(tag + body) & 0xffffffff))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, ctype, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    open(path, 'wb').write(png)
    return len(png)


def crop(w, h, ch, px, x0, y0, x1, y1):
    nw, nh = x1 - x0, y1 - y0
    out = bytearray(nw * nh * ch)
    for y in range(nh):
        src = ((y + y0) * w + x0) * ch
        dst = y * nw * ch
        out[dst:dst + nw * ch] = px[src:src + nw * ch]
    return nw, nh, out


def resample(w, h, ch, px, nw, nh):
    """Box-average down to (nw, nh). Good enough for icons, and no ringing."""
    out = bytearray(nw * nh * ch)
    for ny in range(nh):
        sy0, sy1 = ny * h // nh, max(ny * h // nh + 1, (ny + 1) * h // nh)
        for nx in range(nw):
            sx0, sx1 = nx * w // nw, max(nx * w // nw + 1, (nx + 1) * w // nw)
            n = (sy1 - sy0) * (sx1 - sx0)
            acc = [0] * ch
            for sy in range(sy0, sy1):
                row = sy * w * ch
                for sx in range(sx0, sx1):
                    i = row + sx * ch
                    for c in range(ch):
                        acc[c] += px[i + c]
            o = (ny * nw + nx) * ch
            for c in range(ch):
                out[o + c] = acc[c] // n
    return out


def bounds(w, h, ch, px, threshold):
    """Bounding box of pixels whose brightest channel exceeds `threshold`."""
    x0, y0, x1, y1 = w, h, 0, 0
    for y in range(h):
        row = y * w * ch
        for x in range(w):
            i = row + x * ch
            if max(px[i], px[i + 1], px[i + 2]) > threshold:
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    return x0, y0, x1 + 1, y1 + 1
