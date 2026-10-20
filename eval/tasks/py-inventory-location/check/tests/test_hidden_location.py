import os
import subprocess
import sys
import tempfile
import unittest

from models import Item
from report import low_stock
from service import Inventory


class TestLocation(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.dir.name, "inv.csv")

    def tearDown(self):
        self.dir.cleanup()

    def cli(self, *args):
        return subprocess.run([sys.executable, "cli.py", "--db", self.db, *args], capture_output=True, text=True)

    def test_model_default(self):
        self.assertEqual(Item("ABC-0001", "bolt", 1).location, "MAIN")
        self.assertEqual(Item("ABC-0001", "bolt", 1, location="WH-2").location, "WH-2")

    def test_add_normalises_and_validates(self):
        inv = Inventory(self.db)
        self.assertEqual(inv.add("ABC-0001", "bolt", 1, location="wh-2").location, "WH-2")
        for bad in ("", "WAREHOUSE-12", "A B", "W_1"):
            with self.assertRaises(ValueError):
                inv.add("ABC-0002", "nut", 1, location=bad)
        self.assertEqual([(i.sku, i.location) for i in inv.items()], [("ABC-0001", "WH-2")])

    def test_storage_roundtrip_and_legacy_file(self):
        Inventory(self.db).add("ABC-0001", "bolt", 1, location="B1")
        Inventory(self.db).adjust("ABC-0001", 1)
        self.assertEqual(Inventory(self.db).items()[0].location, "B1")
        legacy = os.path.join(self.dir.name, "old.csv")
        with open(legacy, "w", newline="") as f:
            f.write("sku,name,qty\r\nXYZ-0009,washer,2\r\n")
        self.assertEqual(Inventory(legacy).items(), [Item("XYZ-0009", "washer", 2, location="MAIN")])

    def test_report(self):
        items = [Item("B-1", "x", 1, location="WH"), Item("A-1", "x", 1, location="WH"), Item("C-1", "x", 9, location="WH"), Item("D-1", "x", 0)]
        self.assertEqual(low_stock(items, 5), {"MAIN": ["D-1"], "WH": ["A-1", "B-1"]})

    def test_cli(self):
        self.assertEqual(self.cli("add", "BBB-0002", "nut", "1", "--location", "wh-2").returncode, 0)
        self.assertEqual(self.cli("add", "AAA-0001", "bolt", "9").returncode, 0)
        self.assertEqual(self.cli("add", "CCC-0003", "gear", "2").returncode, 0)
        self.assertEqual(self.cli("list").stdout, "AAA-0001 bolt 9 MAIN\nBBB-0002 nut 1 WH-2\nCCC-0003 gear 2 MAIN\n")
        self.assertEqual(self.cli("low", "--threshold", "5").stdout, "MAIN: CCC-0003\nWH-2: BBB-0002\n")
