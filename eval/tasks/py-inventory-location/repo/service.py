from dataclasses import replace

import storage
from models import Item
from validation import validate_item


class Inventory:
    def __init__(self, path):
        self.path = path

    def items(self):
        return sorted(storage.load(self.path), key=lambda i: i.sku)

    def add(self, sku, name, qty):
        item = Item(sku, name, qty)
        validate_item(item)
        items = [i for i in storage.load(self.path) if i.sku != sku]
        storage.save(self.path, items + [item])
        return item

    def adjust(self, sku, delta):
        items = storage.load(self.path)
        updated = [replace(i, qty=i.qty + delta) if i.sku == sku else i for i in items]
        for i in updated:
            validate_item(i)
        storage.save(self.path, updated)
