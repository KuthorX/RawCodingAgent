from collections import OrderedDict


class Fetcher:
    """See SPEC.md."""

    def __init__(self, fetch, max_entries):
        if max_entries < 1:
            raise ValueError("max_entries must be >= 1")
        self._fetch = fetch
        self._max = max_entries
        self._cache = OrderedDict()
        self._hits = 0
        self._misses = 0

    def get(self, key):
        if key in self._cache:
            self._hits += 1
            self._cache.move_to_end(key)
            return self._cache[key]
        self._misses += 1
        value = self._fetch(key)
        self._cache[key] = value
        if len(self._cache) > self._max:
            self._cache.popitem(last=False)
        return value

    def invalidate(self, key):
        self._cache.pop(key, None)

    def stats(self):
        return {"hits": self._hits, "misses": self._misses, "size": len(self._cache)}
