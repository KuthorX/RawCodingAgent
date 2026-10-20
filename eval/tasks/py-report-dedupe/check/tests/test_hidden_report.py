import unittest
from report import department_report

E = lambda n, d, s: {"name": n, "department": d, "salary": s}

class TestReportSpec(unittest.TestCase):
    def test_full(self):
        rows = department_report([
            E("zoe", "sales", 50), E("amy", "eng", 90), E("bob", "eng", 90),
            E("cat", "eng", 120), E("amy", "eng", 95), E("amy", "sales", 10),
        ])
        self.assertEqual(rows, [
            {"department": "eng", "headcount": 3, "total": 305, "top": ["cat", "amy", "bob"]},
            {"department": "sales", "headcount": 2, "total": 60, "top": ["zoe", "amy"]},
        ])

    def test_empty(self):
        self.assertEqual(department_report([]), [])
