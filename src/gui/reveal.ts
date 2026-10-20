import { spawn } from "node:child_process";

// Opens the OS file manager with the file selected. Arguments are passed without a shell.
export function revealInFileManager(path: string): Promise<void> {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", ["-R", path]]
      : process.platform === "win32"
        ? ["explorer", [`/select,${path}`]]
        : ["xdg-open", [path.replace(/[^/]+$/, "")]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
