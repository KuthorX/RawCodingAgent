import { add } from "./math.js";

export function total(items) {
  return add(items.map((item) => item.price * item.qty));
}
