from shop import users


def owners(orders):
    return sorted({users.get_usr(o["user_id"]) for o in orders})
