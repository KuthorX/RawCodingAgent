import unittest
from app import auth, users
from app.emails import normalize_email

class TestLoginCase(unittest.TestCase):
    def setUp(self):
        users.reset()

    def test_mixed_case_and_spaces(self):
        users.register(" Alice@Example.com", "pw")
        self.assertTrue(auth.login("alice@example.COM ", "pw"))
        self.assertTrue(auth.login(" Alice@Example.com", "pw"))
        self.assertFalse(auth.login("alice@example.com", "wrong"))

    def test_duplicate_detection_is_normalized(self):
        users.register("carol@example.com", "pw")
        with self.assertRaises(ValueError):
            users.register("  CAROL@example.com ", "pw2")

    def test_normalize(self):
        self.assertEqual(normalize_email("  X@Y.Z "), "x@y.z")
