from decimal import Decimal


class InsufficientFunds(Exception):
    pass


class Ledger:
    """Amounts are given and returned as strings with exactly two decimals, e.g. "10.25"."""

    def __init__(self):
        self._balance = Decimal("0")

    def deposit(self, amount):
        self._balance += Decimal(amount)

    def withdraw(self, amount):
        if Decimal(amount) > self._balance:
            raise InsufficientFunds(amount)
        self._balance -= Decimal(amount)

    def balance(self):
        return str(self._balance.quantize(Decimal("0.01")))
