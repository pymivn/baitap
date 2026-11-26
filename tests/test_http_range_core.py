"""Tests for pure RFC 7233 HTTP Range parser."""

import unittest

from scripts.http_range_core import (
    ByteRange,
    RangeUnsatisfiable,
    parse_byte_range,
)


class TestParseByteRange(unittest.TestCase):
    def test_none_header_returns_none(self) -> None:
        self.assertIsNone(parse_byte_range(None, 1024))

    def test_empty_header_returns_none(self) -> None:
        self.assertIsNone(parse_byte_range("   ", 1024))

    def test_non_bytes_unit_returns_none(self) -> None:
        self.assertIsNone(parse_byte_range("items=0-5", 1024))

    def test_closed_range(self) -> None:
        result = parse_byte_range("bytes=0-1023", 4096)
        self.assertEqual(result, ByteRange(start=0, end=1023, total=4096))
        assert isinstance(result, ByteRange)
        self.assertEqual(result.length, 1024)
        self.assertEqual(result.content_range_header, "bytes 0-1023/4096")

    def test_case_insensitive_unit_and_whitespace(self) -> None:
        result = parse_byte_range("  BYTES = 10 - 19 ", 100)
        self.assertEqual(result, ByteRange(start=10, end=19, total=100))

    def test_clamps_end_to_total_minus_one(self) -> None:
        result = parse_byte_range("bytes=500-99999", 1000)
        self.assertEqual(result, ByteRange(start=500, end=999, total=1000))

    def test_open_ended_range(self) -> None:
        result = parse_byte_range("bytes=500-", 1000)
        self.assertEqual(result, ByteRange(start=500, end=999, total=1000))

    def test_suffix_range(self) -> None:
        result = parse_byte_range("bytes=-500", 1200)
        self.assertEqual(result, ByteRange(start=700, end=1199, total=1200))

    def test_suffix_range_larger_than_total_clamps_to_zero(self) -> None:
        result = parse_byte_range("bytes=-5000", 1200)
        self.assertEqual(result, ByteRange(start=0, end=1199, total=1200))

    def test_suffix_zero_is_unsatisfiable(self) -> None:
        result = parse_byte_range("bytes=-0", 1200)
        self.assertEqual(result, RangeUnsatisfiable(total=1200))
        assert isinstance(result, RangeUnsatisfiable)
        self.assertEqual(result.content_range_header, "bytes */1200")

    def test_start_past_eof_is_unsatisfiable(self) -> None:
        result = parse_byte_range("bytes=1000-1500", 1000)
        self.assertEqual(result, RangeUnsatisfiable(total=1000))

    def test_empty_resource_is_unsatisfiable(self) -> None:
        self.assertEqual(
            parse_byte_range("bytes=0-0", 0), RangeUnsatisfiable(total=0)
        )
        self.assertEqual(
            parse_byte_range("bytes=-10", 0), RangeUnsatisfiable(total=0)
        )

    def test_inverted_range_is_unsatisfiable(self) -> None:
        self.assertEqual(
            parse_byte_range("bytes=500-100", 1000),
            RangeUnsatisfiable(total=1000),
        )

    def test_malformed_spec_is_unsatisfiable(self) -> None:
        self.assertEqual(
            parse_byte_range("bytes=-", 1000), RangeUnsatisfiable(total=1000)
        )
        self.assertEqual(
            parse_byte_range("bytes=abc-def", 1000),
            RangeUnsatisfiable(total=1000),
        )
        self.assertEqual(
            parse_byte_range("bytes=100", 1000), RangeUnsatisfiable(total=1000)
        )


if __name__ == "__main__":
    unittest.main()
