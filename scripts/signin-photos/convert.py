"""Local photo converter for the one-time sign-in board photo import (ADR 0010
decision 4, amended 2026-11-17). Called by scripts/signin-photos/import.mjs; never on
the server. Needs Pillow and pillow-heif, in a venv OUTSIDE the repo, and is run
isolated from the photo directory (the photos are untrusted input):

    <venv>/bin/python -I scripts/signin-photos/convert.py inspect <file>...
    <venv>/bin/python -I scripts/signin-photos/convert.py convert <src> <outdir>

inspect  one JSON object per line: name, sha256, size, format, width, height,
         capture ("YYYY-MM-DDTHH:MM:SS", EXIF DateTimeOriginal as local wall time, else
         DateTime, else null) and offset (OffsetTimeOriginal, informational).
convert  writes three files to <outdir> (which must exist and be empty) and prints one
         JSON object describing them:
           original.jpg|.png  JPEG and PNG sources are copied byte for byte. A HEIC is
                              converted to a full-resolution JPEG (quality 95, EXIF and
                              colour profile kept), which is what iOS Safari uploads when
                              a HEIC is picked with accept="image/jpeg,image/png"; the
                              schema only stores JPEG/PNG originals.
           display.jpg        long edge 1600px (never upscaled), quality 85
           thumb.jpg          long edge 400px, from the display copy, quality 80
         The copies match the browser path (public/js/admin-media.js): EXIF orientation
         applied, converted to sRGB, transparent areas on white, and NO metadata (no
         EXIF, GPS, XMP or ICC profile), as a canvas export produces.
"""

import hashlib
import io
import json
import os
import shutil
import sys

import pillow_heif
from PIL import Image, ImageCms, ImageOps

pillow_heif.register_heif_opener()
Image.MAX_IMAGE_PIXELS = 120_000_000  # a 48 MP photo is fine; refuse decompression bombs

DISPLAY_EDGE, DISPLAY_QUALITY = 1600, 85
THUMB_EDGE, THUMB_QUALITY = 400, 80
EXIF_IFD = 0x8769
DATETIME, DATETIME_ORIGINAL, OFFSET_ORIGINAL = 306, 36867, 36881


def fit_within(width, height, max_edge):
    """Same rule as fitWithin in public/js/admin-media-lib.js."""
    long_edge = max(width, height)
    if long_edge <= max_edge:
        return width, height
    scale = max_edge / long_edge
    w = max_edge if width >= height else max(1, int(width * scale + 0.5))  # Math.round, not banker's rounding
    h = max_edge if height > width else max(1, int(height * scale + 0.5))
    return w, h


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def exif_capture(im):
    exif = im.getexif()
    sub = exif.get_ifd(EXIF_IFD)
    raw = sub.get(DATETIME_ORIGINAL) or exif.get(DATETIME)
    capture = None
    if isinstance(raw, str) and len(raw) >= 19 and raw[4] == ":" and raw[7] == ":":
        capture = f"{raw[0:4]}-{raw[5:7]}-{raw[8:10]}T{raw[11:19]}"
    offset = sub.get(OFFSET_ORIGINAL)
    return capture, offset if isinstance(offset, str) else None


def inspect(paths):
    for p in paths:
        with Image.open(p) as im:
            capture, offset = exif_capture(im)
            print(json.dumps({
                "name": os.path.basename(p), "sha256": sha256(p), "size": os.path.getsize(p),
                "format": im.format, "width": im.width, "height": im.height,
                "capture": capture, "offset": offset,
            }), flush=True)


def to_srgb_rgb(im):
    """Upright, RGB, sRGB pixels; transparency flattened on white."""
    im = ImageOps.exif_transpose(im)
    icc = im.info.get("icc_profile")
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im)
    im = im.convert("RGB")
    if icc:
        try:
            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            im = ImageCms.profileToProfile(im, src, ImageCms.createProfile("sRGB"), outputMode="RGB")
        except Exception:  # an unreadable profile: keep the pixels as they are
            pass
    return im


def save_jpeg(im, path, quality):
    # No exif=, icc_profile= or xmp=: Pillow then writes none.
    im.save(path, "JPEG", quality=quality, optimize=True, progressive=True)


def convert(src, outdir):
    if not os.path.isdir(outdir) or os.listdir(outdir):
        raise SystemExit("convert: outdir must be an existing empty directory")
    with Image.open(src) as im:
        fmt = im.format
        if fmt == "JPEG":
            original, ctype = os.path.join(outdir, "original.jpg"), "image/jpeg"
            shutil.copyfile(src, original)
        elif fmt == "PNG":
            original, ctype = os.path.join(outdir, "original.png"), "image/png"
            shutil.copyfile(src, original)
        elif fmt in ("HEIF", "HEIC"):
            original, ctype = os.path.join(outdir, "original.jpg"), "image/jpeg"
            kw = {"quality": 95}
            exif = im.info.get("exif")
            if exif:
                kw["exif"] = exif
            if im.info.get("icc_profile"):
                kw["icc_profile"] = im.info["icc_profile"]
            im.convert("RGB").save(original, "JPEG", **kw)
        else:
            raise SystemExit(f"convert: unsupported format {fmt}")

        upright = to_srgb_rgb(im)
    dw, dh = fit_within(upright.width, upright.height, DISPLAY_EDGE)
    display = upright.resize((dw, dh), Image.LANCZOS) if (dw, dh) != upright.size else upright
    tw, th = fit_within(dw, dh, THUMB_EDGE)
    thumb = display.resize((tw, th), Image.LANCZOS) if (tw, th) != display.size else display
    save_jpeg(display, os.path.join(outdir, "display.jpg"), DISPLAY_QUALITY)
    save_jpeg(thumb, os.path.join(outdir, "thumb.jpg"), THUMB_QUALITY)

    def part(path, content_type):
        return {"path": path, "contentType": content_type, "size": os.path.getsize(path)}

    print(json.dumps({
        "original": part(original, ctype),
        "display": {**part(os.path.join(outdir, "display.jpg"), "image/jpeg"), "width": dw, "height": dh},
        "thumb": {**part(os.path.join(outdir, "thumb.jpg"), "image/jpeg"), "width": tw, "height": th},
    }), flush=True)


def main(argv):
    if len(argv) >= 2 and argv[0] == "inspect":
        inspect(argv[1:])
    elif len(argv) == 3 and argv[0] == "convert":
        convert(argv[1], argv[2])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
