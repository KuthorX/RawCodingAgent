def low_stock(items, threshold):
    """{location: sorted skus with qty below threshold}, only locations with low stock."""
    result = {}
    for i in items:
        if i.qty < threshold:
            result.setdefault(i.location, []).append(i.sku)
    return {loc: sorted(skus) for loc, skus in result.items()}
