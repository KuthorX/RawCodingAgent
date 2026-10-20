from app import users
from app.emails import normalize_email


def login(email, password):
    stored = users.find(normalize_email(email))
    return stored is not None and stored == users._hash(password)
