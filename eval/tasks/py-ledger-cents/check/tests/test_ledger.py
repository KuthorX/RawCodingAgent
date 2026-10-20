import unittest
from ledger import Ledger

class TestLedger(unittest.TestCase):
    def test_small_amounts_add_up(self):
        ledger = Ledger()
        ledger.deposit("0.10")
        ledger.deposit("0.20")
        self.assertEqual(ledger.balance(), "0.30")
