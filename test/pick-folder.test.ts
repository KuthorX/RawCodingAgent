import assert from "node:assert/strict";
import { test } from "node:test";
import { dialogFor } from "../src/gui/pick-folder.ts";

test("Windows folder picker writes selected paths as UTF-8", () => {
  const dialog = dialogFor("win32");
  assert.equal(dialog.cmd, "powershell");
  const script = dialog.args.at(-1)!;
  assert.match(script, /\$OutputEncoding = \[Text\.Encoding\]::UTF8/);
  assert.match(script, /\[Console\]::OutputEncoding = \[Text\.Encoding\]::UTF8/);
});
