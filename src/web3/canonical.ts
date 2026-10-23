/**
 * LitNode's canonical JSON (litnode/protocol/canonical.js), twin for the browser: object keys sorted recursively,
 * arrays in order, `undefined` and functions dropped. A node signs its delta over `"delta\0" + canonical(body)`,
 * so the bytes the escrow verifies must be exactly these.
 */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) if (src[k] !== undefined && typeof src[k] !== 'function') out[k] = src[k];
      return out;
    }
    return v;
  });
