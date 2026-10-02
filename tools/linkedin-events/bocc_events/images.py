"""Cover image validation.

We read just enough of the file header to confirm it really is a PNG or JPEG
and to get its dimensions, without a third-party imaging library. Nothing is
decoded; the bytes are uploaded to LinkedIn verbatim.
"""

import struct
from dataclasses import dataclass
from pathlib import Path

# LinkedIn's help center: at least 480px wide, 16:9 recommended (1280x720 example).
MIN_WIDTH = 480
MIN_HEIGHT = 270
# No official byte limit is published for event backgrounds. 8 MiB is generous
# for a 16:9 cover and keeps a mistaken huge file from being uploaded.
MAX_BYTES = 8 * 1024 * 1024
# Matches the Images API pixel ceiling; anything larger is surely not a cover photo.
MAX_PIXELS = 36_152_320
TARGET_RATIO = 16 / 9
RATIO_TOLERANCE = 0.05

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# JPEG start-of-frame markers carry the dimensions. C4 (DHT), C8 (JPG) and
# CC (DAC) share the range but are not frames.
JPEG_SOF_MARKERS = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


class ImageError(ValueError):
    """The cover image is missing, not a PNG/JPEG, or outside size limits."""


@dataclass(frozen=True)
class CoverImage:
    path: Path
    content_type: str  # image/png or image/jpeg
    width: int
    height: int
    data: bytes

    @property
    def warnings(self) -> list[str]:
        """Non-fatal issues worth showing before upload."""
        ratio = self.width / self.height
        if abs(ratio - TARGET_RATIO) / TARGET_RATIO > RATIO_TOLERANCE:
            return [
                f"{self.width}x{self.height} is not 16:9 (ratio {ratio:.2f}); LinkedIn may crop it"
            ]
        return []


def _png_dimensions(data: bytes) -> tuple[int, int]:
    # IHDR must be the first chunk: 4-byte length (13), b"IHDR", width, height.
    if len(data) < 24 or data[12:16] != b"IHDR":
        raise ImageError("PNG is missing its IHDR header")
    return struct.unpack(">II", data[16:24])


def _jpeg_dimensions(data: bytes) -> tuple[int, int]:
    # Walk the marker segments after SOI (FFD8) until a start-of-frame segment.
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            raise ImageError("JPEG marker stream is malformed")
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte before a marker
            i += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:  # standalone markers
            i += 2
            continue
        (length,) = struct.unpack(">H", data[i + 2 : i + 4])
        if length < 2:
            raise ImageError("JPEG segment length is invalid")
        if marker in JPEG_SOF_MARKERS:
            if i + 9 > len(data):
                break
            height, width = struct.unpack(">HH", data[i + 5 : i + 9])
            return width, height
        if marker in (0xD9, 0xDA):  # end of image / start of scan before any frame
            break
        i += 2 + length
    raise ImageError("JPEG has no frame header")


def load_cover_image(path: Path) -> CoverImage:
    """Validate `path` as an uploadable cover image and return its bytes and metadata."""
    if not path.is_file():
        raise ImageError(f"{path} is not a file")
    size = path.stat().st_size
    if size > MAX_BYTES:
        raise ImageError(f"{path} is {size / 1_048_576:.1f} MiB; the limit is {MAX_BYTES // 1_048_576} MiB")
    data = path.read_bytes()

    # Trust the magic bytes, never the file extension.
    if data.startswith(PNG_SIGNATURE):
        content_type = "image/png"
        width, height = _png_dimensions(data)
    elif data.startswith(b"\xff\xd8\xff"):
        content_type = "image/jpeg"
        width, height = _jpeg_dimensions(data)
    else:
        raise ImageError(f"{path} is not a PNG or JPEG")

    if width < MIN_WIDTH or height < MIN_HEIGHT:
        raise ImageError(f"{path} is {width}x{height}; minimum is {MIN_WIDTH}x{MIN_HEIGHT}")
    if width * height > MAX_PIXELS:
        raise ImageError(f"{path} is {width}x{height}, over the {MAX_PIXELS:,} pixel limit")
    return CoverImage(path=path, content_type=content_type, width=width, height=height, data=data)
