import csv
import os

from models import Item

FIELDS = ["sku", "name", "qty"]


def load(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="") as f:
        return [Item(row["sku"], row["name"], int(row["qty"])) for row in csv.DictReader(f)]


def save(path, items):
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        for item in items:
            writer.writerow({"sku": item.sku, "name": item.name, "qty": item.qty})
