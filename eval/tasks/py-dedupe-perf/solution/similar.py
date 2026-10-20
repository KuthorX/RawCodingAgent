def normalize(email):
    local, _, domain = email.strip().lower().partition("@")
    local = local.split("+", 1)[0]
    if domain in ("gmail.com", "googlemail.com"):
        local = local.replace(".", "")
        domain = "gmail.com"
    return local + "@" + domain


def find_duplicates(records):
    """Group records whose normalized emails are equal.

    records: list of dicts with "id" and "email". Returns a list of groups (lists of ids) with 2+ records.
    """
    groups = {}
    for record in records:
        email = record.get("email")
        if not email:
            continue
        groups.setdefault(normalize(email), []).append(record["id"])
    return [ids for ids in groups.values() if len(ids) > 1]
