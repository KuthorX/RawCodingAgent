def paginate(items, page, per_page):
    """Return the items on the given page.

    Pages are numbered from 1. A page past the end returns an empty list.
    page < 1 or per_page < 1 raises ValueError.
    """
    if page < 1 or per_page < 1:
        raise ValueError("page and per_page must be >= 1")
    start = (page - 1) * per_page
    return items[start:start + per_page]
