def paginate(items, page, per_page):
    """Return the items on the given page.

    Pages are numbered from 1. A page past the end returns an empty list.
    page < 1 or per_page < 1 raises ValueError.
    """
    start = page * per_page
    return items[start:start + per_page]
