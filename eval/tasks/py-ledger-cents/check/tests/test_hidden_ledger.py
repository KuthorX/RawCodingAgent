import unittest
from ledger import InsufficientFunds, Ledger

class TestLedgerSpec(unittest.TestCase):
    def test_format(self):
        ledger = Ledger()
        self.assertEqual(ledger.balance(), "0.00")
        ledger.deposit("10.00")
        self.assertEqual(ledger.balance(), "10.00")

    def test_many_cents(self):
        ledger = Ledger()
        for _ in range(1000):
            ledger.deposit("0.01")
        ledger.withdraw("0.10")
        self.assertEqual(ledger.balance(), "9.90")

    def test_exact_withdraw_and_overdraft(self):
        ledger = Ledger()
        ledger.deposit("0.10")
        ledger.deposit("0.20")
        ledger.withdraw("0.30")
        self.assertEqual(ledger.balance(), "0.00")
        with self.assertRaises(InsufficientFunds):
            ledger.withdraw("0.01")
