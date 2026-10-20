import os
import subprocess
import sys
import tempfile
import unittest

from report import load_totals

OTHER = '\ufeffRegion,Amount,Note\r\nWest,"12,000.10",\r\n"West, Coast",(0.10),refund\r\nWest,(2.00),\r\n\r\nEast,0.01,"a, b, c"\r\nWest,"(1,000.05)",refund\r\n'

class TestReport(unittest.TestCase):
    def test_sales_file(self):
        self.assertEqual(load_totals("data/sales.csv"), {"North": "3450.75", "North, East": "300.00", "South": "-910.00"})

    def test_another_export(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "x.csv")
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(OTHER)
            self.assertEqual(load_totals(path), {"West": "10998.05", "West, Coast": "-0.10", "East": "0.01"})

    def test_cli_output(self):
        out = subprocess.run([sys.executable, "report.py", "data/sales.csv"], capture_output=True, text=True, check=True).stdout
        self.assertEqual(out, "North\t3450.75\nNorth, East\t300.00\nSouth\t-910.00\n")
