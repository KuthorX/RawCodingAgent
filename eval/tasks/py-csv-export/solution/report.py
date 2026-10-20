import csv
import sys
from decimal import Decimal


def _amount(text):
    text = text.strip().replace(",", "")
    if text.startswith("(") and text.endswith(")"):
        return -Decimal(text[1:-1])
    return Decimal(text)


def load_totals(path):
    """Sum Amount per Region. Returns {region: total} with totals formatted with two decimals, e.g. "3450.75"."""
    totals = {}
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            if not row["Region"] or not row["Region"].strip():
                continue
            totals[row["Region"]] = totals.get(row["Region"], Decimal(0)) + _amount(row["Amount"])
    return {region: str(total.quantize(Decimal("0.01"))) for region, total in totals.items()}


def main(argv):
    for region, total in sorted(load_totals(argv[1]).items()):
        print("%s\t%s" % (region, total))


if __name__ == "__main__":
    main(sys.argv)
