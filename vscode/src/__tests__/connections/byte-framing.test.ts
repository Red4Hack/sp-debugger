// Proves byte-accurate DAP framing handles multi-byte UTF-8 payloads (the
// CPrintToChat "»" case). Builds frames the way the server does (Content-Length
// = BYTE count), concatenates them, feeds them through the framing algorithm in
// adversarial chunk splits (including splitting mid-multibyte-char), and checks
// every message parses and stays aligned.
//
// Mirrors the algorithm in TcpConnection.ts (byte buffer + byte slicing).
// Converted from the former vscode/scripts/test-byte-framing.mjs.
import { describe, expect, it } from "bun:test";

function frame(obj: unknown): Buffer {
  const json = JSON.stringify(obj);
  const body = Buffer.from(json, "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "latin1");
  return Buffer.concat([header, body]);
}

// --- the framing algorithm under test (byte-accurate) ---
class Framer {
  buffer = Buffer.alloc(0);
  out: any[] = [];
  errors = 0;
  feed(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.toString("latin1", 0, headerEnd);
      const m = header.match(/^Content-Length: (\d+)$/m);
      if (!m) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buffer.length < start + len) return; // wait for more bytes
      const msg = this.buffer.toString("utf8", start, start + len);
      this.buffer = this.buffer.subarray(start + len);
      try {
        this.out.push(JSON.parse(msg));
      } catch {
        this.errors++;
      }
    }
  }
}

// --- a realistic stream: colored chat strings + plain frames ---
const messages = [
  {
    seq: 1,
    type: "response",
    request_seq: 1,
    command: "evaluate",
    success: true,
    body: { result: "\x01{white}» {green}[SM] {white}Você não pode usar isto agora." },
  },
  { seq: 2, type: "event", event: "stopped", body: { reason: "step", threadId: 1 } },
  {
    seq: 3,
    type: "response",
    request_seq: 2,
    command: "variables",
    success: true,
    body: {
      variables: [
        { name: "buffer2", value: "« acentuação » © ™ €", type: "char[10]", variablesReference: 0 },
        { name: "output", value: "日本語テスト 🎮", type: "char[]", variablesReference: 0 },
        { name: "i", value: "0", type: "int", variablesReference: 0 },
      ],
    },
  },
  {
    seq: 4,
    type: "response",
    request_seq: 3,
    command: "stackTrace",
    success: true,
    body: { stackFrames: [{ id: 0, name: "CPrintToChat [debugger_test.smx]", line: 42 }] },
  },
];

const full = Buffer.concat(messages.map(frame));
const expectedCount = messages.length;

describe("DAP byte framing", () => {
  // Many chunk sizes, including 1 byte (splits every multibyte char) and
  // sizes that land mid-header / mid-body.
  for (const chunkSize of [1, 2, 3, 5, 7, 13, 64, 200, full.length]) {
    it(`parses all frames at chunkSize=${chunkSize}`, () => {
      const f = new Framer();
      for (let i = 0; i < full.length; i += chunkSize) {
        f.feed(full.subarray(i, Math.min(i + chunkSize, full.length)));
      }
      expect(f.errors).toBe(0);
      expect(f.out.length).toBe(expectedCount);
      expect(f.out[0].body.result).toContain("»");
      expect(f.out[2].body.variables[1].value).toBe("日本語テスト 🎮");
      expect(f.out[3].body.stackFrames[0].line).toBe(42);
    });
  }

  // Negative control: the OLD string-based framing (char-count slicing) MUST
  // fail on multi-byte payloads -- proving this was the real bug.
  it("old char-slice framing breaks on multi-byte payloads (negative control)", () => {
    let buf = full.toString(); // decode whole stream to string (the old bug)
    const out: unknown[] = [];
    let errors = 0;
    for (;;) {
      const he = buf.indexOf("\r\n\r\n");
      if (he === -1) break;
      const m = buf.substring(0, he).match(/^Content-Length: (\d+)$/m);
      if (!m) {
        buf = buf.substring(he + 4);
        continue;
      }
      const len = parseInt(m[1], 10); // BYTES
      const start = he + 4;
      if (buf.length < start + len) break; // compares CHARS to BYTES
      const msg = buf.substring(start, start + len); // slices CHARS
      buf = buf.substring(start + len);
      try {
        out.push(JSON.parse(msg));
      } catch {
        errors++;
      }
    }
    expect(errors > 0 || out.length !== expectedCount).toBe(true);
  });
});
