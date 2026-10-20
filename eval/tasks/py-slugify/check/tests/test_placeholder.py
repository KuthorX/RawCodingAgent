import unittest

class TestImport(unittest.TestCase):
    def test_module_imports(self):
        import text_utils  # noqa: F401
