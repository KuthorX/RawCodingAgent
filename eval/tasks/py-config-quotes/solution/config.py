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
    for number, raw in enumerate(text.splitlines(), start=1):
        line = _strip_comment(raw).strip()
        if not line:
            continue
        if "=" not in line:
            raise ValueError("line %d: expected key = value" % number)
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
            value = value[1:-1]
        result[key.strip()] = value
    return result


def _strip_comment(line):
    in_quotes = False
    for i, ch in enumerate(line):
        if ch == '"':
            in_quotes = not in_quotes
        elif ch == "#" and not in_quotes:
            return line[:i]
    return line
