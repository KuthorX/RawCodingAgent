import { readFileSync } from "node:fs";

const text = readFileSync(0, "utf8");
const counts = new Map();
for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
  counts.set(word, (counts.get(word) ?? 0) + 1);
}
const rows = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
for (const [word, count] of rows) process.stdout.write(`${word} ${count}\n`);
