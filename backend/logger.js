// Tiny structured logger. Keeps a timestamp + level on every line so server
// logs are easy to read and grep, without pulling in a dependency.
//
// Levels: info | warn | error | debug
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[(process.env.ZENITH_LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

function line(level, args) {
  const ts = new Date().toISOString();
  const rest = args
    .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  return `[${ts}] [zenith] [${level.toUpperCase()}] ${rest}`;
}

function emit(level, args) {
  if (LEVELS[level] < current) return;
  const out = line(level, args);
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.log(out);
}

export const log = {
  info: (...args) => emit("info", args),
  warn: (...args) => emit("warn", args),
  error: (...args) => emit("error", args),
  debug: (...args) => emit("debug", args),
};
