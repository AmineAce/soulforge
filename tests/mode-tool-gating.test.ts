/**
 * Mode tool gating — cache-stability + execution-time deny.
 *
 * Restricted modes (architect/socratic/challenge/plan) and plan-execution must
 * send the FULL tool schema (byte-identical across modes) so the prompt-cache
 * prefix (tools → system → messages) survives mode switches (discussion #85).
 * Restriction is enforced at execution: a disallowed tool returns a deny result
 * (error: mode_restricted) instead of running.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// No repo map needed — the gate is pure logic over the tool set. Disabling it
// keeps the background AST-summary worker from spinning up on the tmp dir
// (which logs disk-I/O noise on teardown). Must be set before ContextManager.
process.env.SOULFORGE_NO_REPOMAP = "1";

import { createForgeAgent } from "../src/core/agents/forge.js";
import { ContextManager } from "../src/core/context/manager.js";

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "mode-gate-"));
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: minimal model stub for agent construction
const mockModel = (id: string) => ({ modelId: id, doGenerate: async () => ({}) }) as any;

type Agent = { tools: Record<string, { execute?: (...a: unknown[]) => unknown }> };

function makeAgent(forgeMode: "default" | "architect", planExecution = false): Agent {
  return createForgeAgent({
    model: mockModel("anthropic/claude-sonnet-4-6"),
    contextManager: new ContextManager(TMP),
    forgeMode,
    planExecution,
  }) as unknown as Agent;
}

function toolNames(agent: Agent): string[] {
  return Object.keys(agent.tools).sort();
}

describe("mode tool gating", () => {
  test("architect mode sends the SAME tool schema as default mode", () => {
    expect(toolNames(makeAgent("architect"))).toEqual(toolNames(makeAgent("default")));
  });

  test("plan-execution sends the SAME tool schema as default mode", () => {
    expect(toolNames(makeAgent("default", true))).toEqual(toolNames(makeAgent("default")));
  });

  test("disallowed tool (edit_file) denies at execution in architect mode", async () => {
    const editTool = makeAgent("architect").tools.edit_file;
    expect(editTool?.execute).toBeDefined();
    const result = (await editTool!.execute!(
      { path: "x.ts", oldString: "a", newString: "b" },
      {},
    )) as { success: boolean; error?: string; output: string };
    expect(result.success).toBe(false);
    expect(result.error).toBe("mode_restricted");
    expect(result.output).toContain("architect");
  });

  test("allowed tool (read) is NOT deny-stubbed in architect mode", () => {
    const archRead = makeAgent("architect").tools.read;
    expect(typeof archRead?.execute).toBe("function");
  });

  test("default mode does not deny-stub edit_file (distinct execute from architect's stub)", () => {
    // The architect edit_file execute is the deny stub; the default one is the
    // real tool. They must be different function references — proves default
    // mode left edit_file untouched. Avoids running a real edit (which would hit
    // the live repo-map worker) so the assertion stays a pure structural check.
    const defaultEdit = makeAgent("default").tools.edit_file;
    const architectEdit = makeAgent("architect").tools.edit_file;
    expect(typeof defaultEdit?.execute).toBe("function");
    expect(typeof architectEdit?.execute).toBe("function");
    expect(defaultEdit?.execute).not.toBe(architectEdit?.execute);
  });
});
