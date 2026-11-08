import { describe, expect, it } from "vitest";
import { OUTPUT_CAP_BYTES, OutputBuffer, TRUNCATION_MARKER, redact } from "./output.ts";

describe("redact", () => {
  it.each([
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig", "Authorization: Bearer [REDACTED]"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "token ghp_[REDACTED]"],
    ["key sk-ant-api03-abcdefghijklmnop", "key sk-[REDACTED]"],
    ["DB_PASSWORD=hunter2 next", "DB_PASSWORD=[REDACTED] next"],
    ['password: "two words"', "password: [REDACTED]"],
    ["access_token=abc123&x=1", "access_token=[REDACTED]&x=1"],
    ["https://bob:s3cret@github.com/x.git", "https://bob:[REDACTED]@github.com/x.git"],
    ["AKIAABCDEFGHIJKLMNOP", "AKIA[REDACTED]"],
    [
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r x",
      "jwt [REDACTED JWT] x",
    ],
    ["github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789", "github_pat_[REDACTED]"],
    ["gho_abcdefghijklmnopqrstuvwxyz0123456789", "gho_[REDACTED]"],
    ["ghs_abcdefghijklmnopqrstuvwxyz0123456789", "ghs_[REDACTED]"],
    ["ghu_abcdefghijklmnopqrstuvwxyz0123456789", "ghu_[REDACTED]"],
    ["api-key: 0123456789abcdef0123456789abcdef", "api-key: [REDACTED]"],
    ['{"apiKey": "0123456789abcdef0123456789abcdef"}', '{"apiKey": "[REDACTED]"}'],
    ["Ocp-Apim-Subscription-Key: 0123456789abcdef0123456789abcdef", "Ocp-Apim-Subscription-Key: [REDACTED]"],
    ["-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY----- tail", "[REDACTED PRIVATE KEY] tail"],
  ])("%s", (input, expected) => expect(redact(input)).toBe(expected));

  it("leaves ordinary output alone", () => {
    expect(redact("git version 2.47.0\nv24.21.0\n")).toBe("git version 2.47.0\nv24.21.0\n");
  });
});

const PEM = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU",
  "QyNTUxOQAAACBxxxxxxxxxxxxxxxxxxxx",
  "-----END OPENSSH PRIVATE KEY-----",
];

describe("OutputBuffer", () => {
  it("drops a PEM private key block, also when it is split across drains", () => {
    const buf = new OutputBuffer();
    buf.write("stdout", `before\n${PEM[0]}\n${PEM[1]}\n`);
    const first = buf.drain(false);
    buf.write("stdout", `${PEM[2]}\n${PEM[3]}\nafter\n`);
    const text = [...first, ...buf.drain(false)].map((c) => c.text).join("");
    expect(text).toBe("before\n[REDACTED PRIVATE KEY]\nafter\n");
  });

  it("keeps dropping an unterminated PEM block", () => {
    const buf = new OutputBuffer();
    buf.write("stderr", `${PEM[0]}\n${PEM[1]}\n`);
    const first = buf.drain(false);
    buf.write("stderr", "QyNTUxOQAAAC\n");
    const text = [...first, ...buf.drain(true)].map((c) => c.text).join("");
    expect(text).toBe("[REDACTED PRIVATE KEY]");
  });

  it("holds partial lines back so a secret split across chunks is still redacted", () => {
    const buf = new OutputBuffer();
    buf.write("stdout", "password=hun");
    expect(buf.drain(false)).toEqual([]);
    buf.write("stdout", "ter2\nok\n");
    expect(buf.drain(false)).toEqual([{ stream: "stdout", text: "password=[REDACTED]\nok\n" }]);
  });

  it("keeps stdout/stderr interleaving and emits unterminated lines on the final drain", () => {
    const buf = new OutputBuffer();
    buf.write("stdout", "a\n");
    buf.write("stderr", "b\n");
    buf.write("stdout", "c");
    expect(buf.drain(true)).toEqual([
      { stream: "stdout", text: "a\n" },
      { stream: "stderr", text: "b\n" },
      { stream: "stdout", text: "c" },
    ]);
  });

  it("asks for a flush at 50 lines", () => {
    const buf = new OutputBuffer();
    buf.write("stdout", "x\n".repeat(49));
    expect(buf.shouldFlush).toBe(false);
    buf.write("stdout", "x\n");
    expect(buf.shouldFlush).toBe(true);
  });

  it("caps total output at 64 KB with a truncation marker and drops the rest", () => {
    const buf = new OutputBuffer();
    const line = "y".repeat(1023) + "\n";
    for (let i = 0; i < 100; i++) buf.write("stdout", line);
    const text = buf
      .drain(false)
      .map((c) => c.text)
      .join("");
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(text)).toBe(OUTPUT_CAP_BYTES + Buffer.byteLength(TRUNCATION_MARKER));
    buf.write("stdout", "more\n");
    expect(buf.drain(true)).toEqual([]);
  });
});
