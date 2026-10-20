import time


class TokenBucket:
    """See SPEC.md."""

    def __init__(self, capacity, refill_per_sec, clock=time.monotonic):
        self.capacity = capacity
        self.rate = refill_per_sec
        self.clock = clock
        self.buckets = {}

    def allow(self, key, cost=1):
        now = self.clock()
        tokens, last = self.buckets.get(key, (self.capacity, now))
        tokens = min(self.capacity, tokens + int(now - last) * self.rate)
        if tokens >= cost:
            self.buckets[key] = (tokens - cost, now)
            return True
        return False
