/**
 * Child process for the two-process lock test. Usage: node lock-child.js <lockPath> <holdMs>
 * Prints ACQUIRED and holds the lock for holdMs (0 = release at once), or exits 3 when another instance holds it.
 */
import { acquireLock, EXIT_CODE_LOCK_HELD, LockHeldError } from "../../src/runtime/lock.js";

const lockPath = process.argv[2];
const holdMs = Number(process.argv[3] ?? "0");
if (!lockPath) {
  console.error("usage: lock-child <lockPath> <holdMs>");
  process.exit(2);
}
try {
  const lock = acquireLock(lockPath);
  console.log("ACQUIRED");
  setTimeout(() => {
    lock.release();
    process.exit(0);
  }, holdMs);
} catch (e) {
  if (e instanceof LockHeldError) {
    console.log(`HELD ${e.pid}`);
    process.exit(EXIT_CODE_LOCK_HELD);
  }
  console.error(String(e));
  process.exit(1);
}
