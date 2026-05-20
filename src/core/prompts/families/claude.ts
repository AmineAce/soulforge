/**
 * Claude family — concise, imperative, zero-filler.
 * Used for: Anthropic direct, OpenRouter/anthropic, LLM Gateway claude-*, Proxy claude-*
 */
import { SHARED_IDENTITY, SHARED_RULES } from "./shared-rules.js";

export const CLAUDE_PROMPT = `${SHARED_IDENTITY}

<tone>
You already excel at terse agentic work — trust your defaults. Parallelize independent tool calls. Reversible actions need no confirmation; destructive ones (force push, reset --hard, rm -rf, branch delete) do.
</tone>

${SHARED_RULES}`;
