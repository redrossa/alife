// World artifacts and model output are untrusted: file names can carry raw
// terminal control bytes (Phase 0, C5). Anything printed for a human passes
// through here so it cannot move the cursor, retitle the window, or hide text.

// C0 controls, DEL, C1 controls, and Unicode line/paragraph separators and
// bidirectional overrides that can visually reorder output.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

export function escapeTerminal(value: string, options: { readonly keepNewlines?: boolean } = {}): string {
  return value.replace(UNSAFE, (char) => {
    if (options.keepNewlines === true && char === "\n") return char;
    const code = char.codePointAt(0)!;
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

// JSON escapes C0 controls itself but not C1 controls or the separators and
// bidirectional overrides above, which terminals may still act on.
const UNSAFE_IN_JSON = /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/** JSON for a terminal: still valid JSON, with every remaining unsafe character as a `\uXXXX` escape. */
export function terminalJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(UNSAFE_IN_JSON, (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}
