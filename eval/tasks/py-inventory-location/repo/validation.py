import re

SKU = re.compile(r"^[A-Z]{3}-\d{4}$")


def validate_item(item):
    if not SKU.match(item.sku):
        raise ValueError("bad sku: %r" % item.sku)
    if not item.name.strip() or " " in item.name:
        raise ValueError("name must be a single non-empty word")
    if item.qty < 0:
        raise ValueError("qty must be >= 0")
