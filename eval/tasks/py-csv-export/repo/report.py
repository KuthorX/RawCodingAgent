import sys


def load_totals(path):
    """Sum Amount per Region. Returns {region: total} with totals formatted with two decimals, e.g. "3450.75"."""
    totals = {}
    with open(path) as f:
        f.readline()  # header
        for line in f:
            region, amount, _note = line.strip().split(",")
            totals[region] = totals.get(region, 0) + float(amount)
    return {region: "%.2f" % total for region, total in totals.items()}


def main(argv):
    for region, total in sorted(load_totals(argv[1]).items()):
        print("%s\t%s" % (region, total))


if __name__ == "__main__":
    main(sys.argv)
