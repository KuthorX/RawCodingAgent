import re


def slugify(text):
    """Turn text into a URL slug.

    - lowercase
    - every run of characters that are not ASCII letters or digits becomes a single "-"
    - no leading or trailing "-"
    - an input with no letters or digits returns ""

    Examples: "Hello, World!" -> "hello-world", "  A  b  " -> "a-b"
    """
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
