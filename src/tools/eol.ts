// Line endings. Models always write \n, but on Windows (git core.autocrlf=true) checked-out files use \r\n.
// Without this, edit_file never matches in such files and write_file silently rewrites every line ending;
// in one session a single failed edit made the model give up on edit_file for the rest of the session.

export function usesCrlf(text: string): boolean {
  const crlf = text.split("\r\n").length - 1;
  return crlf > 0 && crlf >= text.split("\n").length - 1 - crlf;
}

export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}
