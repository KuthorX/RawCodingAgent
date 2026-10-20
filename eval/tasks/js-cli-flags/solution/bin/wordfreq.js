import { readFileSync } from "node:fs";

let reverse = false;
let top = Infinity;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--reverse") reverse = true;
  else if (args[i] === "--top" && /^\d+$/.test(args[i + 1] ?? "")) top = Number(args[++i]);
  else {
    process.stderr.write(`unknown argument: ${args[i]}\n`);
    process.exit(2);
  }
}

const text = readFileSync(0, "utf8");
const counts = new Map();
for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
  counts.set(word, (counts.get(word) ?? 0) + 1);
}
const dir = reverse ? 1 : -1;
const rows = [...counts].sort((a, b) => dir * (a[1] - b[1]) || a[0].localeCompare(b[0])).slice(0, top);
for (const [word, count] of rows) process.stdout.write(`${word} ${count}\n`);
