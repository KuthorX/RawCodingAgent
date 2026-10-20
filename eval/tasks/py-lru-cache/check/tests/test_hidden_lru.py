import unittest
from fetcher import Fetcher

def make(max_entries=2):
    calls = []
    def fetch(k):
        calls.append(k)
        if k == "boom":
            raise RuntimeError("boom")
        return k.upper()
    return Fetcher(fetch, max_entries), calls

class TestLru(unittest.TestCase):
    def test_evicts_least_recently_used(self):
        f, calls = make(2)
        f.get("a"); f.get("b"); f.get("a")   # a is now most recent
        f.get("c")                           # evicts b
        f.get("a")
        f.get("b")                           # refetch
        self.assertEqual(calls, ["a", "b", "c", "b"])
        self.assertEqual(f.stats(), {"hits": 2, "misses": 4, "size": 2})

    def test_invalidate(self):
        f, calls = make(2)
        f.get("a"); f.invalidate("a"); f.invalidate("missing"); f.get("a")
        self.assertEqual(calls, ["a", "a"])

    def test_errors_not_cached(self):
        f, calls = make(2)
        with self.assertRaises(RuntimeError):
            f.get("boom")
        with self.assertRaises(RuntimeError):
            f.get("boom")
        self.assertEqual(f.stats(), {"hits": 0, "misses": 2, "size": 0})

    def test_invalid_size(self):
        with self.assertRaises(ValueError):
            Fetcher(lambda k: k, 0)
