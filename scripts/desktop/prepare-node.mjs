// Copies the running node.exe to build/node/node.exe for the installer (the services run on it). No download.
// Refuses unless the version satisfies package.json "engines" and the file has a Valid Authenticode signature from "OpenJS Foundation".
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fail = (msg) => {
  console.error(`prepare-node: ${msg}`);
  process.exit(1);
};

const engines = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines?.node ?? "";
const m = /^>=(\d+)\.(\d+)\.(\d+)\s+<(\d+)$/.exec(engines);
if (!m) fail(`cannot read the engines range "${engines}" (expected ">=X.Y.Z <N")`);
const [lo, hiMajor] = [[Number(m[1]), Number(m[2]), Number(m[3])], Number(m[4])];
const cur = process.versions.node.split(".").map(Number);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
if (cmp(cur, lo) < 0 || cur[0] >= hiMajor) fail(`node ${process.versions.node} does not satisfy engines "${engines}"; run this with a matching Node`);

const src = realpathSync(process.execPath);
let sig;
try {
  const ps = `$s = Get-AuthenticodeSignature -LiteralPath $env:NODE_SRC; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
  sig = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, NODE_SRC: src },
  }).trim();
} catch (e) {
  fail(`could not read the signature of ${src}: ${e.message}`);
}
const [status, subject = ""] = sig.split("|");
if (status !== "Valid" || !/\bCN=OpenJS Foundation\b/.test(subject)) {
  fail(`${src} is not an official signed node.exe (status ${status}, signer "${subject}"); install Node from nodejs.org`);
}

const dest = join(root, "build", "node", "node.exe");
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`prepare-node: ${process.versions.node} (${subject.split(",")[0]}) -> ${dest}`);
