/**
 * Single-line JSON logger to stdout. Railway/Fly capture stdout only and drop
 * lines past a per-second budget, so structured one-liners with stable field
 * names beat any pretty-printer. No dependency (a pino would be overkill for
 * this surface).
 */
type Fields = Record<string, unknown>;

function emit(level: string, msg: string, fields?: Fields): void {
  const line: Fields = { level, msg, ...fields };
  console.log(JSON.stringify(line, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export const log = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
