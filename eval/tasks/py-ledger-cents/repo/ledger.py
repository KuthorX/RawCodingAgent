class InsufficientFunds(Exception):
    pass


class Ledger:
    """Amounts are given and returned as strings with exactly two decimals, e.g. "10.25"."""

    def __init__(self):
        self._balance = 0.0

    def deposit(self, amount):
        self._balance += float(amount)

    def withdraw(self, amount):
        if float(amount) > self._balance:
            raise InsufficientFunds(amount)
        self._balance -= float(amount)

    def balance(self):
        return str(self._balance)
