from shop.users import get_user


def order_owner(order):
    return get_user(order["user_id"])
