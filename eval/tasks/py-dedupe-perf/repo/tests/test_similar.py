import unittest
from similar import find_duplicates

class TestSimilar(unittest.TestCase):
    def test_small(self):
        records = [
            {"id": 1, "email": "A.B@gmail.com"}, {"id": 2, "email": "x@y.com"},
            {"id": 3, "email": "ab+news@googlemail.com"}, {"id": 4, "email": " X@Y.com "},
        ]
        self.assertEqual(find_duplicates(records), [[1, 3], [2, 4]])
