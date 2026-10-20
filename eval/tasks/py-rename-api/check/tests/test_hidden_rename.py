import os
import re
import unittest
import warnings

from shop import emails, orders, reports, users

class TestRename(unittest.TestCase):
    def test_new_name(self):
        self.assertEqual(users.get_user(1), "ada")
        self.assertIsNone(users.get_user(99))

    def test_deprecated_alias(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            self.assertEqual(users.get_usr(2), "linus")
        self.assertTrue(any(issubclass(w.category, DeprecationWarning) for w in caught))

    def test_callers_still_work_without_warnings(self):
        with warnings.catch_warnings():
            warnings.simplefilter("error", DeprecationWarning)
            self.assertEqual(orders.order_owner({"user_id": 1}), "ada")
            self.assertEqual(reports.owners([{"user_id": 1}]), ["ada"])
            self.assertEqual(emails.greeting(2), "Hi linus")

    def test_no_callers_of_old_name(self):
        for name in os.listdir("shop"):
            if name.endswith(".py") and name != "users.py":
                with open(os.path.join("shop", name)) as f:
                    self.assertNotRegex(f.read(), r"\bget_usr\b", name)
