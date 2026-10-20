import unittest
from text_utils import slugify

class TestSlugify(unittest.TestCase):
    def test_examples(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")
        self.assertEqual(slugify("  A  b  "), "a-b")

    def test_edges(self):
        self.assertEqual(slugify("--Already--Slugged--"), "already-slugged")
        self.assertEqual(slugify("Version 2.0 (beta)"), "version-2-0-beta")
        self.assertEqual(slugify("!!!"), "")
        self.assertEqual(slugify(""), "")
        self.assertEqual(slugify("Café au lait"), "caf-au-lait")
