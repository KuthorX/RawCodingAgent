def low_stock(items, threshold):
    """Skus with qty below threshold, sorted."""
    return sorted(i.sku for i in items if i.qty < threshold)
