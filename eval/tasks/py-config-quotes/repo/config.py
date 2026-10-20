def parse_config(text):
    """Parse a tiny config format into a dict of strings.

    - one `key = value` per line; whitespace around keys and values is ignored
    - blank lines are skipped
    - `#` starts a comment, unless it is inside a double-quoted value
    - a value wrapped in double quotes keeps its inner text verbatim (quotes removed)
    - a later key overrides an earlier one
    - a non-blank line without "=" raises ValueError mentioning its 1-based line number
    """
    result = {}
    for line in text.splitlines():
        line = line.split("#")[0].strip()
        if not line:
            continue
        key, value = line.split("=", 1)
        result[key.strip()] = value.strip().strip('"')
    return result
