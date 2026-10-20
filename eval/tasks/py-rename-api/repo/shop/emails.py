from shop.users import get_usr as lookup


def greeting(user_id):
    return "Hi %s" % lookup(user_id)
