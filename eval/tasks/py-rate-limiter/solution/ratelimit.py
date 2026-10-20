import time


class TokenBucket:
    """See SPEC.md."""

    def __init__(self, capacity, refill_per_sec, clock=time.monotonic):
        if capacity <= 0 or refill_per_sec <= 0:
            raise ValueError("capacity and refill_per_sec must be > 0")
        self.capacity = capacity
        self.rate = refill_per_sec
        self.clock = clock
        self.buckets = {}

    def _check(self, cost):
        if not 0 < cost <= self.capacity:
            raise ValueError("cost must be in (0, capacity]")

    def _tokens(self, key):
        now = self.clock()
        tokens, last = self.buckets.get(key, (self.capacity, now))
        elapsed = max(0.0, now - last)
        tokens = min(self.capacity, tokens + elapsed * self.rate)
        # A backwards clock moves the reference point back too, so later refills count from there.
        self.buckets[key] = (tokens, now)
        return tokens

    def allow(self, key, cost=1):
        self._check(cost)
        tokens = self._tokens(key)
        if tokens >= cost:
            self.buckets[key] = (tokens - cost, self.buckets[key][1])
            return True
        return False

    def retry_after(self, key, cost=1):
        self._check(cost)
        missing = cost - self._tokens(key)
        return 0.0 if missing <= 0 else missing / self.rate

    def active_keys(self):
        return sorted(k for k in list(self.buckets) if self._tokens(k) < self.capacity)
