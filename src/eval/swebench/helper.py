"""Thin wrapper over the official swebench package, so grading uses its eval scripts and log parsers verbatim.

Run with the venv that has swebench installed (see src/eval/swebench/setup.ts):
  helper.py export <dataset.parquet> <out.json>    dataset rows as a JSON array
  helper.py script <instance.json>                 the eval script (prints to stdout)
  helper.py report <instance.json> <test.log>      grading report as JSON (prints to stdout)
"""

import json
import sys

from swebench.harness.grading import get_eval_report
from swebench.harness.utils import make_test_spec


def export(parquet_path: str, out_path: str) -> None:
    import pyarrow.parquet as pq

    rows = pq.read_table(parquet_path).to_pylist()
    with open(out_path, "w") as f:
        json.dump(rows, f)
    print(len(rows))


def load(instance_path: str) -> dict:
    with open(instance_path) as f:
        return json.load(f)


def script(instance_path: str) -> None:
    sys.stdout.write(make_test_spec(load(instance_path)).eval_script)


def report(instance_path: str, log_path: str) -> None:
    instance = load(instance_path)
    spec = make_test_spec(instance)
    # The patch itself was applied before the tests ran; the report only needs to know there was one.
    prediction = {"instance_id": instance["instance_id"], "model_name_or_path": "raw-coding-agent", "model_patch": "(applied)"}
    result = get_eval_report(spec, prediction, log_path, include_tests_status=True)[instance["instance_id"]]
    json.dump(result, sys.stdout)


COMMANDS = {"export": (export, 2), "script": (script, 1), "report": (report, 2)}

if __name__ == "__main__":
    name, args = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else ("", [])
    if name not in COMMANDS or len(args) != COMMANDS[name][1]:
        sys.exit(__doc__)
    COMMANDS[name][0](*args)
