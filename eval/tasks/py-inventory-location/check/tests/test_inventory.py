import os
import tempfile
import unittest

from service import Inventory

class TestInventory(unittest.TestCase):
    def test_add_and_list(self):
        with tempfile.TemporaryDirectory() as d:
            inv = Inventory(os.path.join(d, "inv.csv"))
            inv.add("ABC-0001", "bolt", 3)
            inv.adjust("ABC-0001", 2)
            self.assertEqual([(i.sku, i.qty) for i in inv.items()], [("ABC-0001", 5)])
