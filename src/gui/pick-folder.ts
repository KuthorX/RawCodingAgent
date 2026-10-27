import { execFile } from "node:child_process";

// Resolves to the chosen absolute path, or null when the user cancels.
export type PickFolder = () => Promise<string | null>;

const PROMPT = "选择工作区文件夹";

interface Dialog {
  cmd: string;
  args: string[];
  // Exit codes that mean "the user cancelled" rather than "the dialog failed".
  cancelCodes: number[];
}

export function dialogFor(platform: NodeJS.Platform): Dialog {
  if (platform === "darwin") {
    // `activate` brings the dialog in front of the browser; -128 (exit 1) is "User canceled".
    return { cmd: "osascript", args: ["-e", "activate", "-e", `POSIX path of (choose folder with prompt "${PROMPT}")`], cancelCodes: [1] };
  }
  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$OutputEncoding = [Text.Encoding]::UTF8",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$d.Description = '${PROMPT}'`,
      "if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
    ].join("; ");
    return { cmd: "powershell", args: ["-NoProfile", "-STA", "-Command", script], cancelCodes: [] };
  }
  return { cmd: "zenity", args: ["--file-selection", "--directory", `--title=${PROMPT}`], cancelCodes: [1] };
}

// Shows the OS-native folder chooser on the machine running the server (the GUI only listens on localhost,
// so that is the user's own desktop). Arguments are passed without a shell.
export const pickFolder: PickFolder = () => {
  const { cmd, args, cancelCodes } = dialogFor(process.platform);
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8" }, (err, stdout) => {
      if (err) {
        const code = typeof err.code === "number" ? err.code : null;
        if (code !== null && cancelCodes.includes(code)) return resolve(null);
        const reason = err.code === "ENOENT" ? `找不到 ${cmd}` : err.message;
        return reject(new Error(`无法打开系统文件夹选择框（${reason}），请直接输入路径`));
      }
      const path = stdout.trim();
      // Keep "/" itself; otherwise drop the trailing slash osascript adds.
      resolve(path === "" ? null : path.length > 1 ? path.replace(/[\\/]+$/, "") : path);
    });
  });
};
