import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../app.ts";
import { parseInstances, type SweInstance } from "./dataset.ts";
import { docker, dockerOk, run } from "./docker.ts";

export const CACHE_DIR = join(PROJECT_ROOT, ".swebench-cache");
const VENV = join(PROJECT_ROOT, ".swebench-venv");
const PYTHON = join(VENV, "bin", "python");
const HELPER = join(import.meta.dirname, "helper.py");
// Pinned: the eval scripts and log parsers decide what counts as resolved.
const SWEBENCH_VERSION = "5.0.2";
// Pinned revision of SWE-bench/SWE-bench_Verified (2026-08-16): results are only comparable on the same rows.
// The instance images are tagged :latest upstream and can't be pinned the same way.
export const DATASET_REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3";
const DATASET_URL = `https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified/resolve/${DATASET_REVISION}/data/test-00000-of-00001.parquet`;
const CURL_IMAGE = "curlimages/curl:8.11.1";

export async function checkDocker(): Promise<void> {
  const r = await docker(["info", "--format", "{{.ServerVersion}}"], 30_000);
  if (r.code !== 0) throw new Error(`Docker is required for SWE-bench and isn't reachable: ${r.output.trim()}`);
}

// The official swebench package, in its own venv (needs uv: https://docs.astral.sh/uv/).
// Checked by importing it, so a half-finished install is redone rather than skipped.
export async function ensurePython(): Promise<void> {
  const check = await run(PYTHON, ["-c", `import swebench, sys; sys.exit(swebench.__version__ != "${SWEBENCH_VERSION}")`], 60_000);
  if (check.code === 0) return;
  rmSync(VENV, { recursive: true, force: true });
  for (const args of [["venv", "-q", "-p", "3.11", VENV], ["pip", "install", "-q", "-p", VENV, `swebench==${SWEBENCH_VERSION}`]]) {
    const r = await run("uv", args);
    if (r.code !== 0) throw new Error(`uv ${args[0]} failed (is uv installed?): ${r.output.trim()}`);
  }
}

export async function helper(args: readonly string[]): Promise<string> {
  const r = await run(PYTHON, [HELPER, ...args], 300_000);
  if (r.code !== 0) throw new Error(`swebench helper ${args[0]} failed: ${r.output.trim().slice(-2000)}`);
  // stdout only: a warning on stderr would otherwise end up in the eval script or the report JSON.
  return r.stdout;
}

// Downloaded inside a container: Docker Desktop has its own proxy, and Hugging Face may not be reachable from the host.
export async function ensureDataset(): Promise<SweInstance[]> {
  const name = `verified-${DATASET_REVISION.slice(0, 12)}`;
  const json = join(CACHE_DIR, `${name}.json`);
  if (!existsSync(json)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    const parquet = join(CACHE_DIR, `${name}.parquet`);
    // Written under a temporary name and renamed when complete, so an interrupted step is redone next time.
    if (!existsSync(parquet)) {
      await dockerOk(["run", "--rm", "-v", `${CACHE_DIR}:/out`, CURL_IMAGE, "-fsSL", "-o", `/out/${name}.parquet.part`, DATASET_URL]);
      renameSync(`${parquet}.part`, parquet);
    }
    await helper(["export", parquet, `${json}.part`]);
    renameSync(`${json}.part`, json);
  }
  return parseInstances(JSON.parse(readFileSync(json, "utf8")));
}
