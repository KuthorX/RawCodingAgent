import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "../tasks.ts";
import type { SweInstance } from "./dataset.ts";
import { docker, dockerOk, PLATFORM, removeContainer } from "./docker.ts";
import { helper } from "./setup.ts";

// Same order as the official harness (swebench/harness/run_evaluation.py GIT_APPLY_CMDS).
const APPLY_COMMANDS = ["git apply --verbose", "git apply --verbose --3way", "git apply --verbose --reject", "patch --batch --forward --fuzz=5 -p1 -i"];
const PATCH_IN_CONTAINER = "/tmp/patch.diff";
const EVAL_TIMEOUT_MS = 30 * 60_000;

interface TestsStatus {
  FAIL_TO_PASS: { success: string[]; failure: string[] };
  PASS_TO_PASS: { success: string[]; failure: string[] };
}

interface Report {
  resolved: boolean;
  patch_successfully_applied: boolean;
  tests_status?: TestsStatus;
  infra_failure_reason?: string;
}

const tally = (t: { success: string[]; failure: string[] }): string => `${t.success.length}/${t.success.length + t.failure.length}`;

function result(passed: boolean, output: string, timedOut = false): CheckResult {
  return { passed, exitCode: passed ? 0 : 1, output, timedOut };
}

// Applies the patch to a pristine container, trying each command in turn and resetting after a failed one.
async function applyPatch(container: string): Promise<string | null> {
  let last = "";
  for (const [i, cmd] of APPLY_COMMANDS.entries()) {
    if (i > 0) await docker(["exec", "-w", "/testbed", container, "bash", "-c", "git checkout -- . ; git clean -fd"]);
    const r = await docker(["exec", "-w", "/testbed", container, "bash", "-c", `${cmd} ${PATCH_IN_CONTAINER}`]);
    if (r.code === 0) return null;
    last = r.output;
  }
  // The chain can leave the patch fully applied while each command still exited non-zero.
  const reverse = await docker(["exec", "-w", "/testbed", container, "git", "apply", "--check", "--reverse", PATCH_IN_CONTAINER]);
  return reverse.code === 0 ? null : last;
}

// Grades a patch the way the official harness does: fresh container from the instance image, apply the patch,
// run the instance's eval script (it resets and patches the test files itself), parse the log with swebench.
// Files written to `dir`: instance.json, patch.diff, eval.sh, test.log, report.json.
export async function grade(instance: SweInstance, patch: string, dir: string, container: string): Promise<CheckResult> {
  const instanceFile = join(dir, "instance.json");
  writeFileSync(instanceFile, JSON.stringify(instance));
  writeFileSync(join(dir, "patch.diff"), patch);
  if (!patch.trim()) return result(false, "empty patch: the agent changed no files");

  try {
    await dockerOk(["run", "-d", "--platform", PLATFORM, "--name", container, instance.image, "sleep", "infinity"]);
    await dockerOk(["cp", join(dir, "patch.diff"), `${container}:${PATCH_IN_CONTAINER}`]);
    const applyError = await applyPatch(container);
    if (applyError !== null) return result(false, `patch did not apply:\n${applyError.trim().slice(-2000)}`);

    writeFileSync(join(dir, "eval.sh"), await helper(["script", instanceFile]));
    await dockerOk(["cp", join(dir, "eval.sh"), `${container}:/eval.sh`]);
    const r = await docker(["exec", container, "bash", "/eval.sh"], EVAL_TIMEOUT_MS);
    const logFile = join(dir, "test.log");
    writeFileSync(logFile, r.output);
    if (r.code === null) return result(false, `tests timed out after ${EVAL_TIMEOUT_MS / 60_000} min; log: ${logFile}`, true);

    const reportJson = await helper(["report", instanceFile, logFile]);
    writeFileSync(join(dir, "report.json"), reportJson);
    const report = JSON.parse(reportJson) as Report;
    const tests = report.tests_status;
    const detail = tests
      ? `FAIL_TO_PASS ${tally(tests.FAIL_TO_PASS)}, PASS_TO_PASS ${tally(tests.PASS_TO_PASS)}`
      : `no test results${report.infra_failure_reason ? ` (${report.infra_failure_reason})` : ""}`;
    return result(report.resolved, `${report.resolved ? "resolved" : "not resolved"}: ${detail}; log: ${logFile}`);
  } finally {
    await removeContainer(container);
  }
}
