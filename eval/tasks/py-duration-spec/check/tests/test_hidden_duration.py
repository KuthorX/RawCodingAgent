import unittest
from duration import parse_duration

class TestDurationExtra(unittest.TestCase):
    def test_more_valid(self):
        for text, expected in (("2D3H", 183600), ("1.25m", 75), ("0.5d", 43200), ("1d 2h 3m 4s", 93784), ("-0.5m", -30), ("007", 7)):
            with self.subTest(text=text):
                self.assertEqual(parse_duration(text), expected)

    def test_more_invalid(self):
        for text in ("1m1m", "1s1m", "-", "1.25s", "1d 1d", "1h 30", "+1h", "1.5.5h", "1 d2h"):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    parse_duration(text)

    def test_returns_int(self):
        self.assertIs(type(parse_duration("1.5h")), int)
