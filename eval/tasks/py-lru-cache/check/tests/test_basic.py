import unittest
from fetcher import Fetcher

class TestBasic(unittest.TestCase):
    def test_caches(self):
        calls = []
        f = Fetcher(lambda k: calls.append(k) or k * 2, max_entries=2)
        self.assertEqual(f.get(3), 6)
        self.assertEqual(f.get(3), 6)
        self.assertEqual(calls, [3])
