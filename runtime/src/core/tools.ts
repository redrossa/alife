import type { ToolDefinition } from "./contracts.ts";

// Tool schemas are part of what the mind perceives. Their exact bytes are
// versioned with the body profile and hashed into each manifest. This text is
// a draft until the pilot freeze (plan §19, item 3).

export const SHELL_TOOL = "shell";
export const WAIT_TOOL = "wait";

export interface ShellBodyLimits {
  readonly actionWaitMs: number;
}

/** Tools for `shell-body-v5`: waiting is bounded, execution is not (plan §8.3). */
export function shellBodyTools(limits: ShellBodyLimits): readonly ToolDefinition[] {
  const seconds = limits.actionWaitMs / 1000;
  return [
    {
      name: SHELL_TOOL,
      description:
        "Run a command with /bin/sh in the environment. Each call starts a new shell in /world; " +
        "the working directory and shell variables do not carry over between calls. " +
        `If the command finishes within ${seconds} seconds, the result shows its exit status and the first part ` +
        "of its standard output and error. If it is still running then, the result says so and gives its job ID " +
        "and process ID, which is also its process group; the command keeps running, and later observations " +
        "report its status and how many bytes of output it produced, but not the output itself. Output from " +
        "processes it leaves running in the background is not reliably collected.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Shell command text." } },
        required: ["command"],
        additionalProperties: false,
      },
    },
    {
      name: WAIT_TOOL,
      description: "Take no action.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
}
