import warnings

_USERS = {1: "ada", 2: "linus"}


def get_user(user_id):
    """Return the user name for an id, or None."""
    return _USERS.get(user_id)


def get_usr(user_id):
    """Deprecated alias of get_user."""
    warnings.warn("get_usr is deprecated, use get_user", DeprecationWarning, stacklevel=2)
    return get_user(user_id)
