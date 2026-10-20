import unittest
from config import parse_config

class TestConfigSpec(unittest.TestCase):
    def test_rules(self):
        text = '\n'.join([
            "# full comment",
            "",
            "name = demo  # trailing comment",
            'title = "  spaced # not comment  "',
            "name = override",
            "empty =",
        ])
        self.assertEqual(parse_config(text), {"name": "override", "title": "  spaced # not comment  ", "empty": ""})

    def test_equals_in_value(self):
        self.assertEqual(parse_config("url = a=b"), {"url": "a=b"})

    def test_bad_line(self):
        with self.assertRaises(ValueError) as ctx:
            parse_config("a = 1\njust words")
        self.assertIn("2", str(ctx.exception))
