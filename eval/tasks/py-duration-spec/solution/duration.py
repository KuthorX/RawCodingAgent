import re
from decimal import Decimal

_UNITS = {"d": 86400, "h": 3600, "m": 60, "s": 1}
_ORDER = "dhms"
_TOKEN = re.compile(r"(?:\d+(?:\.\d+)?[dhms])+")
_PART = re.compile(r"(\d+(?:\.\d+)?)([dhms])")


def parse_duration(text):
    """Parse a duration such as "1h30m" into whole seconds (int).

    - Units: d (86400), h (3600), m (60), s (1). Unit letters are case-insensitive.
    - Parts may be separated by spaces ("1h 30m"); leading/trailing spaces are ignored.
      A number and its unit must not be separated ("1 h" is invalid).
    - Each unit appears at most once, in descending order d, h, m, s ("30m1h" and "1h1h" are invalid).
    - A number is digits with an optional ".digits" fraction ("1.5h"); ".5h" and "1.h" are invalid.
      The total must be a whole number of seconds ("1.5s" is invalid).
    - A bare number means seconds ("45" -> 45) and cannot be combined with units ("45 30", "1h 45" are invalid).
    - An optional leading "-" makes the whole duration negative ("-1h30m" -> -5400).
    - Anything else raises ValueError, including an empty string.
    """
    s = text.strip().lower()
    negative = s.startswith("-")
    if negative:
        s = s[1:]
    if re.fullmatch(r"\d+", s):
        return -int(s) if negative else int(s)
    tokens = s.split()
    if not tokens or (negative and s[:1].isspace()):
        raise ValueError("invalid duration: %r" % text)
    total = Decimal(0)
    last = -1
    for token in tokens:
        if not _TOKEN.fullmatch(token):
            raise ValueError("invalid duration: %r" % text)
        for number, unit in _PART.findall(token):
            index = _ORDER.index(unit)
            if index <= last:
                raise ValueError("units must appear once, in order d, h, m, s: %r" % text)
            last = index
            total += Decimal(number) * _UNITS[unit]
    if total != total.to_integral_value():
        raise ValueError("not a whole number of seconds: %r" % text)
    return -int(total) if negative else int(total)
