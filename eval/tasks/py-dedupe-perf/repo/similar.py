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
    groups = []
    taken = set()
    for i, a in enumerate(records):
        if i in taken or not a.get("email"):
            continue
        group = [a["id"]]
        for j in range(i + 1, len(records)):
            b = records[j]
            if j not in taken and b.get("email") and normalize(a["email"]) == normalize(b["email"]):
                group.append(b["id"])
                taken.add(j)
        if len(group) > 1:
            groups.append(group)
    return groups
