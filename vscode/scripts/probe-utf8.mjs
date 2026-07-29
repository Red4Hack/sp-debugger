#!/usr/bin/env node
// Reproduce the UTF-8 evaluate parse failure: connect, launch, evaluate a
// NON-ASCII identifier (multi-byte UTF-8 -- intentionally unresolvable, the
// point is the round-trip byte accounting), and dump the raw bytes of the
// response so we can compare Content-Length vs the actual payload size.
// Bypasses the smoke test's framing parser so we see the wire. Defaults to the
// mock srcds + debugger_test; SP_HOST/SP_PROGRAM point it at a real server.
import { DEFAULT_PROGRAM, maybeStartMockSrcds, connectWithRetry } from "./lib/testenv.mjs";

const HOST = process.env.SP_HOST || "127.0.0.1";
const PORT = parseInt(process.env.SP_PORT || "8080", 10);
const PROGRAM = process.env.SP_PROGRAM || DEFAULT_PROGRAM;
const EXPR = process.env.SP_EXPR || "variável_inexistente"; // non-ASCII on purpose

let s = null;
let mock = null;
let seq = 1;
const send = (cmd, args) => {
  const m = JSON.stringify({ seq: seq++, type: "request", command: cmd, arguments: args });
  const h = `Content-Length: ${Buffer.byteLength(m, "utf8")}\r\n\r\n`;
  s.write(h + m);
};

let raw = Buffer.alloc(0);
async function main() {
  mock = await maybeStartMockSrcds({ host: HOST, port: PORT });
  s = await connectWithRetry(HOST, PORT, mock ? 120 : 10, 500);
  s.on("data", (c) => (raw = Buffer.concat([raw, c])));
  s.on("close", report);
  send("initialize", { clientID: "probe" });
  await new Promise((r) => setTimeout(r, 300));
  send("launch", { program: PROGRAM, stopOnEntry: false });
  await new Promise((r) => setTimeout(r, 600));
  send("evaluate", { expression: EXPR, context: "hover" });
  await new Promise((r) => setTimeout(r, 800));
  s.destroy();
  setTimeout(report, 100);
}
let reported = false;
function report() {
  if (reported) return; reported = true;
  // Walk frames, print declared Content-Length vs actual body byte length and a hexdump
  // for any frame whose body fails JSON.parse.
  let off = 0;
  let frame = 0;
  while (off < raw.length) {
    const hdrEnd = raw.indexOf("\r\n\r\n", off);
    if (hdrEnd < 0) break;
    const hdr = raw.slice(off, hdrEnd).toString("utf8");
    const m = hdr.match(/Content-Length: (\d+)/i);
    if (!m) break;
    const len = parseInt(m[1], 10);
    const start = hdrEnd + 4;
    const body = raw.slice(start, start + len);
    frame++;
    let parsed = "OK";
    let parsedObj = null;
    try { parsedObj = JSON.parse(body.toString("utf8")); } catch (e) { parsed = `FAIL: ${e.message}`; }
    const command = parsedObj?.command || parsedObj?.event || "?";
    console.log(`\nframe #${frame} cmd=${command}`);
    console.log(`  declared Content-Length: ${len}`);
    console.log(`  actual body bytes available: ${raw.length - start}`);
    console.log(`  JSON.parse: ${parsed}`);
    if (parsedObj?.body?.result) console.log(`  body.result: ${JSON.stringify(parsedObj.body.result)}`);
    if (parsed !== "OK") {
      console.log(`  hex (last 80B of declared body):`);
      console.log("    " + body.slice(-80).toString("hex").replace(/(..)/g, "$1 "));
      console.log(`  utf8: ${JSON.stringify(body.toString("utf8"))}`);
    }
    off = start + len;
  }
  mock?.stop();
  process.exit(0);
}
main().catch((e) => { console.log(`fatal: ${e.message}`); mock?.stop(); process.exit(2); });
