import type { Decision, MindResponse } from "./contracts.ts";
import { clip } from "./observation.ts";
import { SHELL_TOOL, WAIT_TOOL } from "./tools.ts";

export interface IntentionLimits {
  readonly maximumCommandBytes: number;
}

/**
 * Reads zero or one intention from a response (plan §8.4). Text, refusal, and
 * silence are valid no-action outcomes and are not reprompted. Anything else
 * that is not exactly one well-formed call executes nothing; multiple calls
 * are rejected together, never partially executed.
 */
export function interpretResponse(response: MindResponse, limits: IntentionLimits): Decision {
  const { reply } = response;

  if (response.status === "refused" || reply.refusal !== null) {
    return { kind: "no_action", reason: "refusal" };
  }
  if (reply.toolCalls.length === 0) {
    if (response.status === "incomplete") {
      return { kind: "invalid", reason: "incomplete_response", detail: "response ended before completion" };
    }
    return { kind: "no_action", reason: reply.text !== null && reply.text.length > 0 ? "text" : "empty" };
  }
  if (reply.toolCalls.length > 1) {
    return {
      kind: "invalid",
      reason: "multiple_actions",
      detail: `${reply.toolCalls.length} tool calls; at most one is accepted per tick`,
    };
  }
  if (response.status === "incomplete") {
    return { kind: "invalid", reason: "incomplete_response", detail: "tool call in an incomplete response" };
  }

  const call = reply.toolCalls[0]!;
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return { kind: "invalid", reason: "invalid_arguments", detail: "arguments are not valid JSON" };
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { kind: "invalid", reason: "invalid_arguments", detail: "arguments must be a JSON object" };
  }
  const keys = Object.keys(args);

  switch (call.name) {
    case WAIT_TOOL:
      if (keys.length !== 0) {
        return { kind: "invalid", reason: "invalid_arguments", detail: "wait takes no arguments" };
      }
      return { kind: "action", callId: call.callId, intention: { kind: "wait" } };

    case SHELL_TOOL: {
      const command = (args as Record<string, unknown>).command;
      if (keys.length !== 1 || typeof command !== "string") {
        return { kind: "invalid", reason: "invalid_arguments", detail: "shell takes exactly one string argument, command" };
      }
      if (command.trim().length === 0) {
        return { kind: "invalid", reason: "invalid_arguments", detail: "command is empty" };
      }
      if (command.includes("\0")) {
        return { kind: "invalid", reason: "invalid_arguments", detail: "command contains a NUL character" };
      }
      const bytes = Buffer.byteLength(command, "utf8");
      if (bytes > limits.maximumCommandBytes) {
        return {
          kind: "invalid",
          reason: "command_too_large",
          detail: `command is ${bytes} bytes; the limit is ${limits.maximumCommandBytes}`,
        };
      }
      return { kind: "action", callId: call.callId, intention: { kind: "shell", command } };
    }

    default:
      // The name is the model's text: clipped, so an oversized one cannot overflow a record.
      return { kind: "invalid", reason: "unknown_tool", detail: `no tool named ${clip(JSON.stringify(call.name), 256)}` };
  }
}
