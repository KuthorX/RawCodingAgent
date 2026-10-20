import unittest
from app import auth, users

class TestSmoke(unittest.TestCase):
    def setUp(self):
        users.reset()

    def test_plain_login(self):
        users.register("bob@example.com", "pw")
        self.assertTrue(auth.login("bob@example.com", "pw"))
