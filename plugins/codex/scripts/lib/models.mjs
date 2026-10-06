// Single source of truth for model aliases. Docs refer here instead of
// restating the slug. `spark` is kept as the fast/cheap-tier keyword for
// backward compatibility; point it at a model the Codex CLI currently lists.
export const MODEL_ALIASES = new Map([["spark", "gpt-6-luna"]]);

export function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}
