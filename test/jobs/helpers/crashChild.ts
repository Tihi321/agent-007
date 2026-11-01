/**
 * Child process for the hard-crash tests of the Job task. Usage: node crashChild.js <dir> <stateFile> <submit|run>
 *
 * It opens the real Harness on <dir>/agent.sqlite, creates a Job task and runs it against a fake job runner. When the task
 * reaches the chosen point it appends the submits the runner accepted to <stateFile> (standing in for the real runner's
 * journal) and kills itself with `process.exit(9)`: no `close()`, no cleanup, like a crash.
 *   submit: right after the runner accepted the `submit`, before the agent heard the reply (submit phase).
 *   run:    on the first `status` call of the run phase (the job is running; the phase has committed nothing yet).
 */
import { appendFileSync } from "node:fs";
import { FakeJobApprovalTransport } from "../../helpers/fakeJobRunner.js";
import { TPL_PLAIN, jobInput } from "./fixtures.js";
import { FakeRunner } from "./fakeRunner.js";
import { openJobsRig } from "./rig.js";

const [dir, stateFile, mode] = process.argv.slice(2);
if (!dir || !stateFile || (mode !== "submit" && mode !== "run")) {
  console.error("usage: crashChild <dir> <stateFile> <submit|run>");
  process.exit(2);
}

const runner = new FakeRunner();
const client = runner.makeClient();
const die = (): never => {
  appendFileSync(stateFile, `${JSON.stringify(runner.submits)}\n`);
  process.exit(9);
};
if (mode === "submit") client.afterSubmit = () => die();
else
  client.onStatus = (body) => {
    if (body.sinceSeq !== undefined) die();
  };

const rig = await openJobsRig({ dir, client, transport: new FakeJobApprovalTransport() });
await rig.createJob(jobInput(TPL_PLAIN));
console.log("STARTED");
setTimeout(() => {
  console.error("the crash point was not reached");
  process.exit(3);
}, 20_000);
