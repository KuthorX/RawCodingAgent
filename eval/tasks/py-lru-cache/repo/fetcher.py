class Fetcher:
    """See SPEC.md."""

    def __init__(self, fetch, max_entries):
        self._fetch = fetch
        self._max = max_entries
        self._cache = {}

    def get(self, key):
        if key not in self._cache:
            self._cache[key] = self._fetch(key)
        return self._cache[key]
