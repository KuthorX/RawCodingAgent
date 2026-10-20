import random
import time
import unittest

from similar import find_duplicates

# The original implementation, kept here as the behavioural reference.
def normalize(email):
    local, _, domain = email.strip().lower().partition("@")
    local = local.split("+", 1)[0]
    if domain in ("gmail.com", "googlemail.com"):
        local = local.replace(".", "")
        domain = "gmail.com"
    return local + "@" + domain

def reference(records):
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


def random_records(n, seed):
    rng = random.Random(seed)
    names = ["ann", "a.nn", "bob", "b.o.b", "cy", "dee", "ed"]
    domains = ["gmail.com", "googlemail.com", "x.org", "X.ORG", "y.net"]
    out = []
    for i in range(n):
        roll = rng.random()
        if roll < 0.08:
            email = None if roll < 0.04 else ""
        else:
            email = rng.choice(["", " ", "  "]) + rng.choice(names) + rng.choice(["", "+t", "+a+b"]) + "@" + rng.choice(domains)
        record = {"id": "r%d" % i}
        if email is not None or rng.random() < 0.5:
            record["email"] = email
        out.append(record)
    return out

class TestDedupe(unittest.TestCase):
    def test_matches_original_behaviour(self):
        for seed in range(30):
            records = random_records(60, seed)
            self.assertEqual(find_duplicates(records), reference(records), "seed %d" % seed)

    def test_fast_on_50k(self):
        # Quick probe first, so the quadratic original fails in about a second instead of running for minutes.
        probe = [{"id": i, "email": "u%d@a.com" % i} for i in range(1000)]
        start = time.perf_counter()
        find_duplicates(probe)
        self.assertLess(time.perf_counter() - start, 0.2, "too slow on 1,000 records")
        rng = random.Random(1)
        records = [{"id": i, "email": "user%d+x@%s" % (rng.randrange(45000), rng.choice(["gmail.com", "a.com"]))} for i in range(50000)]
        start = time.perf_counter()
        groups = find_duplicates(records)
        self.assertLess(time.perf_counter() - start, 2.0)
        self.assertTrue(groups)
