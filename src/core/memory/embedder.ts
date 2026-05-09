/**
 * Deterministic hash-bag embedder. No deps, no LLM, no provider.
 *
 * Tokenizes text into lower-cased words + bigrams, hashes each token to a
 * fixed-dim float bin, L2-normalizes. Two memories whose summaries share
 * vocabulary land near each other in cosine space; pure synonym pairs do
 * not. That's a known limitation — Phase 4's contract is "intelligence
 * multiplies, never gates." When a real provider embedder is wired later,
 * swap `embed()` and store `embedding_model` to differentiate vectors.
 *
 * Storage shape (BLOB): little-endian Float32Array of `dim` floats.
 */

export const EMBED_MODEL = "hashbag-v1";
export const EMBED_DIM = 256;

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const words = lower.match(TOKEN_RE) ?? [];
  if (words.length === 0) return [];
  const out: string[] = [];
  for (const w of words) {
    if (w.length >= 2) out.push(w);
  }
  for (let i = 0; i < words.length - 1; i++) {
    out.push(`${words[i]}_${words[i + 1]}`);
  }
  return out;
}

/** FNV-1a 32-bit. Fast, deterministic, good distribution for short strings. */
function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function embed(text: string, dim = EMBED_DIM): Float32Array {
  const vec = new Float32Array(dim);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;
  for (const tok of tokens) {
    const bin = hashToken(tok) % dim;
    // Sign-trick: use 1 bit of the hash to avoid all-positive collapse.
    const sign = (hashToken(`s:${tok}`) & 1) === 0 ? 1 : -1;
    vec[bin] = (vec[bin] ?? 0) + sign;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += (vec[i] ?? 0) * (vec[i] ?? 0);
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] = (vec[i] ?? 0) / norm;
  }
  return vec;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  // Vectors are unit-normalized at embed() time, so dot == cosine.
  return dot;
}

export function vectorToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function bufferToVector(buf: Buffer | Uint8Array): Float32Array {
  const view = buf instanceof Buffer ? buf : Buffer.from(buf);
  const aligned = new ArrayBuffer(view.byteLength);
  new Uint8Array(aligned).set(view);
  return new Float32Array(aligned);
}

/** Compose embedding source from a memory's content fields. */
export function memoryEmbedSource(summary: string, details: string, topics: string[]): string {
  const t = topics.join(" ");
  return `${summary}\n${details}\n${t}`.trim();
}
