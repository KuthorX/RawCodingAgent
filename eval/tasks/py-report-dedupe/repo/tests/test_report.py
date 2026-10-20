import unittest
from report import department_report

class TestReport(unittest.TestCase):
    def test_single(self):
        rows = department_report([{"name": "a", "department": "x", "salary": 1}])
        self.assertEqual(rows, [{"department": "x", "headcount": 1, "total": 1, "top": ["a"]}])
