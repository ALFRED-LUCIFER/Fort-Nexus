export const OUTPUT_CAP_BYTES = 64 * 1024;
export const TRUNCATION_MARKER = "\n[nexus: output truncated at 64 KB]\n";
const MAX_PARTIAL_LINE = 8 * 1024;
const FLUSH_LINES = 50;
const FLUSH_CHARS = 16 * 1024;

// shortcut: pattern-based redaction of obvious secrets only, upgrade to a vetted secret scanner before untrusted repo code runs (ENG-04).
const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(bearer\s+)[\w.~+/=-]{8,}/gi, "$1[REDACTED]"],
  [/\b(gh[pousr]|github_pat)_\w{10,}/g, "$1_[REDACTED]"],
  [/\bsk-[\w-]{10,}/g, "sk-[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]"],
  [
    /((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&;,]+)/gi,
    "$1[REDACTED]",
  ],
  [/(\/\/[^/\s:@]+:)[^/\s@]+@/g, "$1[REDACTED]@"], // credentials in URLs
];

export const redact = (text: string): string => SECRETS.reduce((t, [re, to]) => t.replace(re, to), text);

export type Stream = "stdout" | "stderr";
export type OutputChunk = { stream: Stream; text: string };

// Buffers child output by whole lines (so redaction never sees half a secret), keeps stdout/stderr
// interleaving, and caps the redacted total at OUTPUT_CAP_BYTES.
export class OutputBuffer {
  // Exact values (e.g. the provider key) masked before the generic patterns run.
  readonly #secrets: readonly string[];
  #partial: Record<Stream, string> = { stdout: "", stderr: "" };
  #ready: OutputChunk[] = [];
  #lines = 0;
  #chars = 0;
  #used = 0;
  #truncated = false;

  constructor(secrets: readonly string[] = []) {
    this.#secrets = secrets;
  }

  get shouldFlush(): boolean {
    return this.#lines >= FLUSH_LINES || this.#chars >= FLUSH_CHARS;
  }

  write(stream: Stream, text: string): void {
    if (this.#truncated) return;
    const buf = this.#partial[stream] + text;
    const cut = buf.length > MAX_PARTIAL_LINE ? buf.length : buf.lastIndexOf("\n") + 1;
    this.#partial[stream] = buf.slice(cut);
    if (cut > 0) this.#push(stream, buf.slice(0, cut));
  }

  // final: the process has exited, so unterminated last lines are emitted too.
  drain(final: boolean): OutputChunk[] {
    if (final) {
      for (const s of ["stdout", "stderr"] as const) if (this.#partial[s]) this.#push(s, this.#partial[s]);
      this.#partial = { stdout: "", stderr: "" };
    }
    const out: OutputChunk[] = [];
    for (const { stream, text } of this.#ready.splice(0)) {
      if (this.#truncated) break;
      let safe = redact(this.#secrets.reduce((t, s) => t.replaceAll(s, "[REDACTED]"), text));
      const bytes = Buffer.byteLength(safe);
      if (this.#used + bytes > OUTPUT_CAP_BYTES) {
        safe =
          Buffer.from(safe)
            .subarray(0, OUTPUT_CAP_BYTES - this.#used)
            .toString() + TRUNCATION_MARKER;
        this.#truncated = true;
      }
      this.#used += bytes;
      out.push({ stream, text: safe });
    }
    this.#lines = this.#chars = 0;
    return out;
  }

  #push(stream: Stream, text: string): void {
    const last = this.#ready.at(-1);
    if (last?.stream === stream) last.text += text;
    else this.#ready.push({ stream, text });
    this.#lines += text.split("\n").length - 1;
    this.#chars += text.length;
  }
}
