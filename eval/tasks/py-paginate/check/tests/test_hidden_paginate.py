import unittest
from paginate import paginate

class TestPaginateSpec(unittest.TestCase):
    def test_pages(self):
        items = list(range(7))
        self.assertEqual(paginate(items, 2, 3), [3, 4, 5])
        self.assertEqual(paginate(items, 3, 3), [6])
        self.assertEqual(paginate(items, 4, 3), [])

    def test_invalid(self):
        for page, per_page in ((0, 3), (-1, 3), (1, 0)):
            with self.assertRaises(ValueError):
                paginate([1, 2], page, per_page)
