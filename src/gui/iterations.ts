import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../workspace/git.ts";
import { HttpError } from "./http.ts";

// The iteration log (docs/iterations.json): what each round of changes solved, grouped by module.
// Commits come from git, so dates and subjects can't drift from the history.

export interface Commit {
  sha: string; // full hash
  short: string;
  date: string; // author date, ISO
  subject: string;
  // Only touched docs/iterations.json: linking entries to commits, not an iteration of its own.
  bookkeeping: boolean;
}

interface RawEntry {
  module: string;
  title: string;
  problem: string;
  change: string;
  commits: string[];
}

export interface Entry extends Omit<RawEntry, "commits"> {
  date: string | null; // earliest of its commits; null while not committed yet
  commits: (Commit | { sha: string; missing: true })[];
}

const DATA = "docs/iterations.json";
const SHA = /^[0-9a-f]{7,40}$/;
const MAX_DETAIL_CHARS = 400_000;

// git@github.com:owner/repo.git or https://github.com/owner/repo(.git) -> https://github.com/owner/repo
export function webUrl(remote: string): string | null {
  const m = /^(?:git@([^:]+):|https?:\/\/([^/]+)\/)(.+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `https://${m[1] ?? m[2]}/${m[3]}` : null;
}

async function history(root: string): Promise<Commit[]> {
  // One record per commit: header line, then the files it touched under this project.
  const out = await git(root, ["log", "--format=%x00%H%x09%h%x09%aI%x09%s", "--name-only", "--relative", "--", "."]);
  return out
    .split("\0")
    .filter((block) => block.trim())
    .map((block) => {
      const [header, ...files] = block.split("\n").filter(Boolean);
      const [sha, short, date, subject] = header!.split("\t");
      return { sha: sha!, short: short!, date: date!, subject: subject ?? "", bookkeeping: files.length > 0 && files.every((f) => f === DATA) };
    });
}

export async function loadIterations(root: string) {
  const data = JSON.parse(readFileSync(join(root, DATA), "utf8")) as { modules: Record<string, string>; entries: RawEntry[] };
  const commits = await history(root);
  const find = (ref: string) => commits.find((c) => c.sha.startsWith(ref));
  const entries: Entry[] = data.entries.map((e) => {
    const resolved = e.commits.map((ref) => find(ref) ?? { sha: ref, missing: true as const });
    const dates = resolved.flatMap((c) => ("date" in c ? [c.date] : [])).sort();
    return { ...e, date: dates[0] ?? null, commits: resolved };
  });
  const referenced = new Set(entries.flatMap((e) => e.commits.map((c) => c.sha)));
  const unfiled = commits.filter((c) => !referenced.has(c.sha) && !c.bookkeeping);
  let repoUrl: string | null = null;
  try {
    repoUrl = webUrl(await git(root, ["remote", "get-url", "origin"]));
  } catch {
    // no remote: commit links stay local
  }
  return { modules: data.modules, entries, unfiled, repoUrl };
}

// `git show` of one commit of this project (stat + patch), for the detail panel.
export async function commitDetail(root: string, ref: string): Promise<{ sha: string; text: string; truncated: boolean }> {
  if (!SHA.test(ref)) throw new HttpError(400, "invalid commit");
  const commit = (await history(root)).find((c) => c.sha.startsWith(ref));
  if (!commit) throw new HttpError(404, "not a commit of this project");
  const text = await git(root, ["show", "--stat", "--patch", "--format=fuller", "--relative", commit.sha, "--", "."]);
  return { sha: commit.sha, text: text.slice(0, MAX_DETAIL_CHARS), truncated: text.length > MAX_DETAIL_CHARS };
}
