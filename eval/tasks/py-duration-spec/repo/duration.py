import re


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
    total = 0
    for number, unit in re.findall(r"(\d+)([dhms])", text):
        total += int(number) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[unit]
    if total == 0 and text.strip().isdigit():
        return int(text)
    return total
