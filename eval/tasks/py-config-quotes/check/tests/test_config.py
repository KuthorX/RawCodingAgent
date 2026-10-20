import unittest
from config import parse_config

class TestConfig(unittest.TestCase):
    def test_hash_inside_quotes_is_not_a_comment(self):
        self.assertEqual(parse_config('color = "#ff0000"  # red'), {"color": "#ff0000"})
