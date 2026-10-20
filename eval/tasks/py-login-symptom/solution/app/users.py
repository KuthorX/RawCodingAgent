import hashlib

from app.emails import normalize_email

_accounts = {}


def _hash(password):
    return hashlib.sha256(password.encode()).hexdigest()


def register(email, password):
    key = normalize_email(email)
    if key in _accounts:
        raise ValueError("already registered")
    _accounts[key] = _hash(password)


def find(email_key):
    return _accounts.get(email_key)


def reset():
    _accounts.clear()
