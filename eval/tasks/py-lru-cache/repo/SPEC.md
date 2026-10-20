# Fetcher cache spec

`Fetcher(fetch, max_entries)` wraps a slow `fetch(key)` function.

1. `get(key)` returns `fetch(key)`, calling `fetch` at most once per key while it stays cached.
2. At most `max_entries` keys are cached. When a new key would exceed the limit, evict the
   **least recently used** key ("used" = returned by `get`, whether hit or miss).
3. `invalidate(key)` drops one key (no error if absent). The next `get` calls `fetch` again.
4. `stats()` returns `{"hits": int, "misses": int, "size": int}`.
5. If `fetch` raises, the exception propagates and nothing is cached (counts as a miss).
6. `max_entries < 1` raises `ValueError` in the constructor.
