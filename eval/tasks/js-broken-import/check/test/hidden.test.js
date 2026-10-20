import test from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/index.js";
import { sum } from "../src/math.js";

test("empty cart is zero", () => assert.equal(total([]), 0));
test("math.sum is still exported", () => assert.equal(sum([1, 2, 3]), 6));
