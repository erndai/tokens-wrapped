// Opens a SQLite database read-only with Node's built-in node:sqlite (Node 22.5+). No dependency, no writes.
// Returns null when node:sqlite isn't available or the file can't be opened; the caller leaves that harness out.

let mod;
export async function sqliteModule() {
  if (mod !== undefined) return mod;
  const orig = process.emitWarning;
  // node:sqlite prints an "experimental" warning on load; it's noise for this tool.
  process.emitWarning = function (w, ...rest) {
    if (/sqlite/i.test(String(w?.message ?? w))) return;
    return orig.call(process, w, ...rest);
  };
  try {
    mod = await import('node:sqlite');
  } catch {
    mod = null;
  } finally {
    process.emitWarning = orig;
  }
  return mod;
}

export async function openReadOnly(path) {
  const m = await sqliteModule();
  if (!m) return null;
  try {
    return new m.DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}
