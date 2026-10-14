import struct

import pytest

from bocc_events import config
from bocc_events.images import MAX_BYTES, ImageError, load_cover_image


def png_bytes(width, height):
    ihdr = struct.pack(">II", width, height) + b"\x08\x02\x00\x00\x00"
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + ihdr + b"\x00" * 4


def jpeg_bytes(width, height, sof=0xC0):
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x00" * 9
    frame = b"\xff" + bytes([sof]) + struct.pack(">HBHH", 11, 8, height, width) + b"\x01\x11\x00"
    return b"\xff\xd8" + app0 + frame + b"\xff\xd9"


@pytest.fixture
def write(tmp_path):
    def _write(name, data):
        path = tmp_path / name
        path.write_bytes(data)
        return path

    return _write


def test_png_dimensions(write):
    image = load_cover_image(write("cover.png", png_bytes(1280, 720)))
    assert (image.content_type, image.width, image.height) == ("image/png", 1280, 720)
    assert image.warnings == []


@pytest.mark.parametrize("sof", [0xC0, 0xC2])  # baseline and progressive
def test_jpeg_dimensions(write, sof):
    image = load_cover_image(write("cover.jpg", jpeg_bytes(1920, 1080, sof)))
    assert (image.content_type, image.width, image.height) == ("image/jpeg", 1920, 1080)


def test_magic_bytes_beat_extension(write):
    image = load_cover_image(write("actually-a-png.jpg", png_bytes(1280, 720)))
    assert image.content_type == "image/png"


def test_non_16_9_warns(write):
    image = load_cover_image(write("wide.png", png_bytes(1280, 640)))
    assert "not 16:9" in image.warnings[0]


@pytest.mark.parametrize(
    "name, data, message",
    [
        ("small.png", png_bytes(400, 225), "minimum"),
        ("huge.png", png_bytes(10000, 10000), "pixel limit"),
        ("cover.gif", b"GIF89a" + b"\x00" * 32, "not a PNG or JPEG"),
        ("script.png", b"#!/bin/sh\nrm -rf /\n", "not a PNG or JPEG"),
        ("broken.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 16, "IHDR"),
        ("noframe.jpg", b"\xff\xd8\xff\xd9", "no frame"),
    ],
)
def test_rejects_bad_images(write, name, data, message):
    with pytest.raises(ImageError, match=message):
        load_cover_image(write(name, data))


def test_rejects_oversized_file(write):
    path = write("big.png", png_bytes(1280, 720) + b"\x00" * MAX_BYTES)
    with pytest.raises(ImageError, match="MiB"):
        load_cover_image(path)


def test_rejects_missing_and_directories(tmp_path):
    with pytest.raises(ImageError, match="not a file"):
        load_cover_image(tmp_path / "missing.png")
    with pytest.raises(ImageError, match="not a file"):
        load_cover_image(tmp_path)


def test_default_image_is_valid():
    image = load_cover_image(config.DEFAULT_IMAGE)
    assert image.content_type == "image/png"
