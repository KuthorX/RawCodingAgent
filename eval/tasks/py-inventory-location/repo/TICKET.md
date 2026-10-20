# Ticket: item locations

Every item gets a storage location.

1. `Item.location` (str), default `"MAIN"`. Existing code that creates `Item(sku, name, qty)` must keep working.
2. Validation: 1-10 characters, only `A-Z`, `0-9` and `-`. `Inventory.add` upper-cases the location before
   validating and storing it (`location="wh-2"` is stored as `"WH-2"`); invalid locations raise ValueError.
3. `Inventory.add(sku, name, qty, location="MAIN")`.
4. Storage: a new `location` column. CSV files written before this change (no `location` column) must still
   load, with location `"MAIN"`.
5. CLI: `add` accepts `--location LOC`. `list` prints `SKU NAME QTY LOCATION` (single spaces), sorted by sku.
6. Report: `low_stock(items, threshold)` now returns `{location: [skus]}`: only locations that have low-stock
   items, skus sorted. The CLI `low` command prints one line per location, sorted by location:
   `LOCATION: SKU1, SKU2`.
