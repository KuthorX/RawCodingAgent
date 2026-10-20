_USERS = {1: "ada", 2: "linus"}


def get_usr(user_id):
    """Return the user name for an id, or None."""
    return _USERS.get(user_id)
