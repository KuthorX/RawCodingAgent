import unittest
from duration import parse_duration

VALID = [
    ("1h30m", 5400), ("90s", 90), ("2d", 172800), ("1.5h", 5400), ("1h 30m", 5400), ("45", 45),
    ("0.1h", 360), ("1d2h3m4s", 93784), ("10m 5s", 605), ("1d 1s", 86401), ("1.5m", 90), ("0s", 0),
    ("3h15m", 11700), ("2d 12h", 216000), ("0.25d", 21600), ("59m59s", 3599),
]
INVALID = ["", "   ", "h", "1x", "30m1h", "1h1h", "1.5s", "0.01m", "1 h", "45 30", "1h 45", "--1h",
           ".5h", "1.h", "1h-30m", "abc", "s1", "1hh"]


def variants(text, seconds):
    yield text, seconds
    yield text.upper(), seconds
    yield "  %s  " % text, seconds
    if seconds:
        yield "-" + text, -seconds
        yield "-" + text.upper(), -seconds


class TestParseDuration(unittest.TestCase):
    def test_valid(self):
        for text, seconds in VALID:
            for variant, expected in variants(text, seconds):
                with self.subTest(text=variant):
                    self.assertEqual(parse_duration(variant), expected)

    def test_invalid(self):
        for text in INVALID:
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    parse_duration(text)
