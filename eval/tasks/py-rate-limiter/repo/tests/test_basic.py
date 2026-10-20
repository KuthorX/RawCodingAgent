import unittest
from ratelimit import TokenBucket

class Clock:
    def __init__(self):
        self.t = 0.0
    def __call__(self):
        return self.t

class TestBasic(unittest.TestCase):
    def test_burst_then_block(self):
        clock = Clock()
        b = TokenBucket(2, 1, clock)
        self.assertTrue(b.allow("a"))
        self.assertTrue(b.allow("a"))
        self.assertFalse(b.allow("a"))
        self.assertTrue(b.allow("b"))
