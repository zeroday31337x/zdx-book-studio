/**
 * Platform settings live in the database (app_settings table) so they can be
 * managed from the admin dashboard without editing env files or restarting.
 * Resolution order for every key: DB setting > env fallback > built-in
 * default. Env remains the home of bootstrap wiring and secrets only
 * (DB path, listen address, Cognito/OIDC secrets, provider API keys) —
 * secrets never go in this table.
 */

export interface SettingDefinition {
  key: string;
  envName: string;
  label: string;
  kind: "string" | "number" | "json";
  defaultValue: string;
  min?: number;
  max?: number;
  help: string;
}

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: "reviewerModel", envName: "BOOK_REVIEWER_MODEL", label: "Reviewer model",
    kind: "string", defaultValue: "",
    help: "Model for the review gate, served by the ZDX inference pool. Naming a different model than the writer's makes the review independent. You designate the model only — provider selection and key rotation happen inside the pool. Empty = the reviewer uses the writer's model."
  },
  {
    key: "modelRates", envName: "BOOK_STUDIO_MODEL_RATES", label: "Model rate card (JSON)",
    kind: "json", defaultValue: "",
    help: "USD rates per 1M tokens, keyed \"provider:model\", \"model\", \"provider:*\" or \"*\", values {\"inputPer1M\": n, \"outputPer1M\": n}. Self-hosted pool models default to $0."
  },
  {
    key: "legacyMirrorMs", envName: "BOOK_STUDIO_LEGACY_MIRROR_MS", label: "Legacy mirror interval (ms)",
    kind: "number", defaultValue: "900000", min: 0, max: 86_400_000,
    help: "How often the books.json recovery mirror is refreshed. SQLite is the store of record; the mirror also flushes on shutdown."
  },
  {
    key: "writerMaxOutputTokens", envName: "BOOK_WRITER_MAX_OUTPUT_TOKENS", label: "Writer max output tokens",
    kind: "number", defaultValue: "2400", min: 400, max: 32_000,
    help: "Output budget for a chapter generation call."
  },
  {
    key: "writerContinuationTokens", envName: "BOOK_WRITER_CONTINUATION_TOKENS", label: "Continuation max output tokens",
    kind: "number", defaultValue: "2200", min: 400, max: 32_000,
    help: "Output budget for a chapter continuation pass."
  },
  {
    key: "writerRepairTokens", envName: "BOOK_WRITER_REPAIR_TOKENS", label: "Length-repair max output tokens",
    kind: "number", defaultValue: "4400", min: 400, max: 32_000,
    help: "Output budget for a length-repair (compression) pass."
  },
  {
    key: "reviewerMaxOutputTokens", envName: "BOOK_REVIEWER_MAX_OUTPUT_TOKENS", label: "Reviewer max output tokens",
    kind: "number", defaultValue: "1600", min: 1200, max: 32_000,
    help: "Output budget reserved for the structured review envelope."
  },
  {
    key: "modelRequestTimeoutMs", envName: "BOOK_MODEL_REQUEST_TIMEOUT_MS", label: "Model request timeout (ms)",
    kind: "number", defaultValue: "240000", min: 10_000, max: 1_800_000,
    help: "Bounds a single model request so provider fallback cannot hold a chapter indefinitely."
  },
];

export function settingDefinition(key: string): SettingDefinition | undefined {
  return SETTING_DEFINITIONS.find(def => def.key === key);
}

/** Normalize one raw value for a setting; returns the stored string or an error. */
export function normalizeSettingValue(def: SettingDefinition, raw: unknown): { value: string } | { error: string } {
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  switch (def.kind) {
    case "number": {
      if (text === "") return { value: def.defaultValue };
      const num = Number(text);
      if (!Number.isFinite(num) || !Number.isInteger(num)) return { error: `${def.key} must be a whole number` };
      if (def.min !== undefined && num < def.min) return { error: `${def.key} must be at least ${def.min}` };
      if (def.max !== undefined && num > def.max) return { error: `${def.key} must be at most ${def.max}` };
      return { value: String(num) };
    }
    case "json": {
      if (text === "") return { value: "" };
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: `${def.key} must be a JSON object` };
        for (const [rateKey, rate] of Object.entries(parsed as Record<string, unknown>)) {
          const r = rate as { inputPer1M?: unknown; outputPer1M?: unknown };
          if (!r || typeof r !== "object" || !Number.isFinite(Number(r.inputPer1M)) || !Number.isFinite(Number(r.outputPer1M))) {
            return { error: `${def.key} entry "${rateKey}" must be {"inputPer1M": number, "outputPer1M": number}` };
          }
        }
        return { value: text };
      } catch { return { error: `${def.key} is not valid JSON` }; }
    }
    default: {
      if (text.length > 200) return { error: `${def.key} is too long` };
      return { value: text };
    }
  }
}

/** Validate a partial settings patch (admin save). Unknown keys are rejected. */
export function validateSettingsPatch(input: Record<string, unknown>): { values: Record<string, string> } | { error: string } {
  const values: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    const def = settingDefinition(key);
    if (!def) return { error: `unknown setting: ${key}` };
    const result = normalizeSettingValue(def, raw);
    if ("error" in result) return result;
    values[key] = result.value;
  }
  return { values };
}

export interface EffectiveSetting { key: string; value: string; source: "db" | "env" | "default" }

/** Resolve every known setting for display: DB wins, then env, then default. */
export function effectiveSettings(dbValues: Record<string, string>, env: NodeJS.ProcessEnv = process.env): EffectiveSetting[] {
  return SETTING_DEFINITIONS.map(def => {
    if (dbValues[def.key] !== undefined) return { key: def.key, value: dbValues[def.key], source: "db" as const };
    const envValue = env[def.envName];
    if (envValue !== undefined && envValue !== "") return { key: def.key, value: envValue, source: "env" as const };
    return { key: def.key, value: def.defaultValue, source: "default" as const };
  });
}
