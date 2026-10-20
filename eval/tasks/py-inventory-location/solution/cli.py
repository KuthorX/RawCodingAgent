import argparse
import sys

from report import low_stock
from service import Inventory


def main(argv=None):
    parser = argparse.ArgumentParser(prog="inventory")
    parser.add_argument("--db", default="inventory.csv")
    sub = parser.add_subparsers(dest="cmd", required=True)
    add = sub.add_parser("add")
    add.add_argument("sku")
    add.add_argument("name")
    add.add_argument("qty", type=int)
    add.add_argument("--location", default="MAIN")
    sub.add_parser("list")
    low = sub.add_parser("low")
    low.add_argument("--threshold", type=int, default=5)
    args = parser.parse_args(argv)

    inv = Inventory(args.db)
    if args.cmd == "add":
        inv.add(args.sku, args.name, args.qty, args.location)
    elif args.cmd == "list":
        for i in inv.items():
            print("%s %s %d %s" % (i.sku, i.name, i.qty, i.location))
    elif args.cmd == "low":
        for location, skus in sorted(low_stock(inv.items(), args.threshold).items()):
            print("%s: %s" % (location, ", ".join(skus)))


if __name__ == "__main__":
    sys.exit(main())
