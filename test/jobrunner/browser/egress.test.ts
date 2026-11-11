/** REQ-0014 A5: the egress proxy refuses loopback, private ranges, project ports and rebinding; it dials the vetted address. Offline. */
import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { startEgressProxy } from "../../../src/jobrunner/drivers/browser/egress.js";

const PUBLIC = "93.184.216.34";
const HTTP_OK = ["HTTP/1.1 200 OK", "Content-Length: 2", "Connection: close", "", "ok"].join("\r\n");

/** Sends one raw request to the proxy and returns what comes back until the socket ends or `until` matches. */
function raw(port: number, request: string, until: RegExp): Promise<{ text: string; sock: net.Socket }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(request));
    let text = "";
    sock.on("data", (d) => {
      text += d.toString("latin1");
      if (until.test(text)) resolve({ text, sock });
    });
    sock.on("end", () => resolve({ text, sock }));
    sock.on("error", reject);
  });
}

test("A5 egress proxy: blocked targets get 403, no credential gets 407, a public name is dialled by its vetted address", async () => {
  const dialled: Array<[string, number]> = [];
  const refused: string[] = [];
  const echo = net.createServer((c) => c.on("data", (d) => (/^GET /.test(d.toString()) ? c.end(HTTP_OK) : c.write(d))));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = (echo.address() as net.AddressInfo).port;
  const names: Record<string, string[]> = { "rebind.test": ["192.168.1.2"], "mixed.test": [PUBLIC, "10.0.0.5"], "public.test": [PUBLIC] };
  const proxy = await startEgressProxy({
    resolver: async (h) => names[h] ?? [],
    onRefused: (h) => refused.push(h),
    dial: (address, port) => {
      dialled.push([address, port]);
      return net.connect(echoPort, "127.0.0.1");
    },
  });
  const pport = Number(new URL(proxy.server).port);
  const auth = `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}\r\n`;
  const connect = (target: string, a = auth): string => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${a}\r\n`;
  try {
    const blocked = ["127.0.0.1:443", "localhost:443", "10.0.0.5:443", "rebind.test:443", "mixed.test:443", "[::ffff:127.0.0.1]:443", "example.com:47009", "example.com:1234"];
    for (const t of blocked) {
      const r = await raw(pport, connect(t), /\r\n\r\n/);
      assert.match(r.text, /^HTTP\/1\.1 403 /, t);
      r.sock.destroy();
    }
    assert.equal(dialled.length, 0, "nothing blocked was dialled");
    assert.equal(refused.length, blocked.length);

    const noCred = await raw(pport, connect("public.test:443", ""), /\r\n\r\n/);
    assert.match(noCred.text, /^HTTP\/1\.1 407 /);
    noCred.sock.destroy();
    const wrong = await raw(pport, connect("public.test:443", "Proxy-Authorization: Basic AAAA\r\n"), /\r\n\r\n/);
    assert.match(wrong.text, /^HTTP\/1\.1 407 /);
    wrong.sock.destroy();
    assert.equal(dialled.length, 0);

    const ok = await raw(pport, connect("public.test:443"), /\r\n\r\n/);
    assert.match(ok.text, /^HTTP\/1\.1 200 /);
    const echoed = new Promise<string>((r) => ok.sock.once("data", (d) => r(d.toString())));
    ok.sock.write("ping");
    assert.equal(await echoed, "ping");
    ok.sock.destroy();
    assert.deepEqual(dialled, [[PUBLIC, 443]]);

    const fwd = await raw(pport, ["GET http://public.test/x HTTP/1.1", "Host: public.test", auth.trimEnd(), "", ""].join("\r\n"), /ok$/);
    assert.match(fwd.text, /^HTTP\/1\.1 200 [\s\S]*ok$/);
    assert.deepEqual(dialled.at(-1), [PUBLIC, 80]);
    fwd.sock.destroy();

    const plain = await raw(pport, `GET http://127.0.0.1/x HTTP/1.1\r\nHost: 127.0.0.1\r\n${auth}\r\n`, /\r\n\r\n/);
    assert.match(plain.text, /^HTTP\/1\.1 403 /);
    plain.sock.destroy();
  } finally {
    await proxy.close();
    await new Promise<void>((r) => echo.close(() => r()));
  }
});
