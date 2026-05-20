/**
 * Fallback family — generic, works with any instruction-following model.
 * Used for: DeepSeek, Llama, Qwen, Mistral, Ollama local models, unknown providers
 */
import { SHARED_IDENTITY, SHARED_RULES } from "./shared-rules.js";

export const DEFAULT_PROMPT = `${SHARED_IDENTITY}

<agentic_framing>
Resolve the user's task completely. Read with tools rather than guessing. Find root cause before fixing. Match existing conventions. Keep changes minimal.
</agentic_framing>

${SHARED_RULES}`;
