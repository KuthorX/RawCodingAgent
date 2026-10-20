import unittest
from shop import emails, orders, reports

class TestShop(unittest.TestCase):
    def test_behaviour(self):
        data = [{"user_id": 2}, {"user_id": 1}, {"user_id": 2}]
        self.assertEqual(orders.order_owner(data[0]), "linus")
        self.assertEqual(reports.owners(data), ["ada", "linus"])
        self.assertEqual(emails.greeting(1), "Hi ada")
