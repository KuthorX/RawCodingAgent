import test from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/index.js";

test("total sums prices times quantities", () => {
  assert.equal(total([{ price: 2, qty: 3 }, { price: 5, qty: 1 }]), 11);
});
