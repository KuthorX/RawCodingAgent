# TokenBucket spec

`TokenBucket(capacity, refill_per_sec, clock=time.monotonic)` keeps one independent bucket per key.

1. A key seen for the first time starts with a full bucket (`capacity` tokens).
2. Tokens refill continuously at `refill_per_sec` per second (fractions of a second count), never above `capacity`.
3. `allow(key, cost=1)` -> bool: if the bucket holds at least `cost` tokens, remove them and return True;
   otherwise return False and remove nothing.
4. `cost` must satisfy `0 < cost <= capacity`; otherwise `allow` and `retry_after` raise ValueError.
5. `retry_after(key, cost=1)` -> float: seconds until `allow(key, cost)` would succeed, `0.0` if it would
   succeed now. It never consumes tokens.
6. If the clock goes backwards, treat it as no time having passed, and measure later refills from the new
   (earlier) time: after a jump back to `t`, the bucket refills normally from `t` onward.
7. `active_keys()` -> sorted list of keys whose bucket is currently not full.
8. `capacity <= 0` or `refill_per_sec <= 0` raises ValueError in the constructor.
