"""Pure RFC 7233 HTTP byte-range parser (Functional Core, zero I/O)."""

from dataclasses import dataclass
from enum import StrEnum


class RangeStatus(StrEnum):
    """Outcome classification for HTTP Range evaluation."""

    PARTIAL = "partial"
    UNSATISFIABLE = "unsatisfiable"


@dataclass(frozen=True)
class ByteRange:
    """Validated inclusive byte range [start, end] for a resource of size total."""

    start: int
    end: int
    total: int

    @property
    def length(self) -> int:
        """Number of bytes covered by this range."""
        return self.end - self.start + 1

    @property
    def content_range_header(self) -> str:
        """Format the RFC 7233 Content-Range response header value."""
        return f"bytes {self.start}-{self.end}/{self.total}"


@dataclass(frozen=True)
class RangeUnsatisfiable:
    """Represents an unsatisfiable or malformed bytes Range request (HTTP 416)."""

    total: int

    @property
    def content_range_header(self) -> str:
        """Format the RFC 7233 416 Content-Range response header value."""
        return f"bytes */{self.total}"


def parse_byte_range(
    header: str | None, total_size: int
) -> ByteRange | RangeUnsatisfiable | None:
    """Parse an HTTP Range header against a resource of `total_size` bytes.

    Returns:
        - `None` if no Range header is present, it is empty, uses a non-bytes
          unit, or specifies a multi-range list (falling back to 200 OK).
        - `RangeUnsatisfiable` if the bytes range is syntactically invalid or
          outside `[0, total_size - 1]` (HTTP 416).
        - `ByteRange` with clamped `end` if the request is satisfiable (HTTP 206).
    """
    if header is None:
        return None

    raw = header.strip()
    if not raw or "=" not in raw:
        return None

    unit, spec = raw.split("=", 1)
    if unit.strip().lower() != "bytes":
        return None

    spec = spec.strip()
    # Multi-part byte ranges are declined cleanly by serving the full 200 entity.
    if "," in spec:
        return None

    if total_size <= 0:
        return RangeUnsatisfiable(total=total_size)

    if "-" not in spec:
        return RangeUnsatisfiable(total=total_size)

    start_str, end_str = spec.split("-", 1)
    start_str = start_str.strip()
    end_str = end_str.strip()

    if not start_str and not end_str:
        return RangeUnsatisfiable(total=total_size)

    if not start_str:
        return _parse_suffix_range(end_str, total_size)

    return _parse_explicit_range(start_str, end_str, total_size)


def _parse_suffix_range(
    suffix_str: str, total_size: int
) -> ByteRange | RangeUnsatisfiable:
    if not suffix_str.isascii() or not suffix_str.isdigit():
        return RangeUnsatisfiable(total=total_size)

    suffix_len = int(suffix_str)
    if suffix_len <= 0:
        return RangeUnsatisfiable(total=total_size)

    start = max(0, total_size - suffix_len)
    end = total_size - 1
    return ByteRange(start=start, end=end, total=total_size)


def _parse_explicit_range(
    start_str: str, end_str: str, total_size: int
) -> ByteRange | RangeUnsatisfiable:
    if not start_str.isascii() or not start_str.isdigit():
        return RangeUnsatisfiable(total=total_size)

    start = int(start_str)
    if start >= total_size:
        return RangeUnsatisfiable(total=total_size)

    if not end_str:
        return ByteRange(start=start, end=total_size - 1, total=total_size)

    if not end_str.isascii() or not end_str.isdigit():
        return RangeUnsatisfiable(total=total_size)

    end = int(end_str)
    if end < start:
        return RangeUnsatisfiable(total=total_size)

    clamped_end = min(end, total_size - 1)
    return ByteRange(start=start, end=clamped_end, total=total_size)
