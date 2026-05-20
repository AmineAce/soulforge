import { tool } from "ai";
import { z } from "zod";
import { coerceBoolean } from "./index.js";

export function createSetLockinTool() {
  return tool({
    description:
      "Signal the start of your final answer for THIS tab. " +
      "Tool calls always render as a collapsed rail; this call tells the renderer where the final-answer text begins so it streams visibly to the user. " +
      "Without this call, the renderer guesses (last text segment after tools = final). Calling it explicitly is more reliable, especially for turns with long interstitial narration. " +
      "Call with on:false ONCE as your LAST tool, immediately before writing the final answer. " +
      "on:true is rarely needed — only to rewind the boundary if you wrote text by mistake and want to do more tool work. " +
      "Skip entirely for pure-chat turns with no tool work.",
    inputSchema: z.object({
      on: z
        .preprocess(coerceBoolean, z.boolean())
        .describe(
          "false = mark the commit boundary so final text streams visibly. true = rewind the boundary (rare).",
        ),
      reason: z.string().optional().describe("Optional short reason — for logs/telemetry only."),
    }),
    execute: async ({ on }: { on: boolean; reason?: string }) => {
      return on ? "commit boundary rewound" : "commit boundary set — answer streaming";
    },
  });
}
