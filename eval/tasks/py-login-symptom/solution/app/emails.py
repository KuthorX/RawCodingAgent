def normalize_email(email):
    """Canonical form used to store and look up accounts.

    Emails are case-insensitive and surrounding whitespace is ignored.
    """
    return email.strip().lower()
