import unittest
from ratelimit import TokenBucket

class Clock:
    def __init__(self):
        self.t = 100.0
    def __call__(self):
        return self.t

class TestSpec(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.b = TokenBucket(4, 2, self.clock)  # 4 tokens, 2 per second

    def test_fractional_refill(self):
        for _ in range(4):
            self.assertTrue(self.b.allow("k"))
        self.clock.t += 0.25          # +0.5 token
        self.assertFalse(self.b.allow("k"))
        self.clock.t += 0.25          # +0.5 token -> 1.0
        self.assertTrue(self.b.allow("k"))

    def test_failed_allow_removes_nothing_and_cap(self):
        self.assertTrue(self.b.allow("k", 3))
        self.assertFalse(self.b.allow("k", 2))   # 1 left
        self.assertTrue(self.b.allow("k", 1))
        self.clock.t += 100
        self.assertTrue(self.b.allow("k", 4))
        self.assertFalse(self.b.allow("k", 1))   # capped at 4, not 200

    def test_cost_validation(self):
        for cost in (0, -1, 5):
            with self.assertRaises(ValueError):
                self.b.allow("k", cost)
            with self.assertRaises(ValueError):
                self.b.retry_after("k", cost)

    def test_retry_after(self):
        self.assertEqual(self.b.retry_after("k", 4), 0.0)
        self.assertTrue(self.b.allow("k", 4))
        self.assertAlmostEqual(self.b.retry_after("k", 1), 0.5)
        self.assertAlmostEqual(self.b.retry_after("k", 3), 1.5)
        self.assertAlmostEqual(self.b.retry_after("k", 3), 1.5)  # did not consume
        self.clock.t += 1.5
        self.assertEqual(self.b.retry_after("k", 3), 0.0)
        self.assertTrue(self.b.allow("k", 3))

    def test_clock_backwards(self):
        self.assertTrue(self.b.allow("k", 4))
        self.clock.t -= 50
        self.assertFalse(self.b.allow("k", 1))
        self.clock.t += 0.5               # half a second after the backwards jump
        self.assertTrue(self.b.allow("k", 1))

    def test_active_keys(self):
        self.assertEqual(self.b.active_keys(), [])
        self.b.allow("b"); self.b.allow("a"); self.b.retry_after("c")
        self.assertEqual(self.b.active_keys(), ["a", "b"])
        self.clock.t += 0.5
        self.assertEqual(self.b.active_keys(), [])

    def test_constructor_validation(self):
        for args in ((0, 1), (-1, 1), (1, 0), (1, -2)):
            with self.assertRaises(ValueError):
                TokenBucket(*args, clock=self.clock)
