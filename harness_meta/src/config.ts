import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Framework version managed independently from project config */
export const FRAMEWORK_VERSION = '0.1.0';

export interface HarnessConfig {
  version: string;
  llm: {
    baseURL: string;
    /** API key resolved at runtime from environment variable — never stored in config file */
    apiKey: string;
    /** Environment variable name to read API key from (required) */
    apiKeyEnvVar: string;
    model: string;
    maxTokens: number;
    temperature: number;
  };
  thresholds: {
    maxRetries: number;
    maxSprintIterations: number;
    maxRollbacks: number;
    maxNegotiationRounds: number;
    evaluationPassScore: number;
    evaluationMinDimensionScore: number;
  };
  paths: {
    workspaceRoot: string;
    ideaFile: string;
    targetProject: string;
    metaLogs: string;
  };
}

let _config: HarnessConfig | null = null;

function readJsonConfig(configPath: string): Record<string, unknown> {
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function mergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...base,
    ...override,
  };

  merged.llm = {
    ...((base.llm ?? {}) as Record<string, unknown>),
    ...((override.llm ?? {}) as Record<string, unknown>),
  };
  merged.thresholds = {
    ...((base.thresholds ?? {}) as Record<string, unknown>),
    ...((override.thresholds ?? {}) as Record<string, unknown>),
  };
  merged.paths = {
    ...((base.paths ?? {}) as Record<string, unknown>),
    ...((override.paths ?? {}) as Record<string, unknown>),
  };

  return merged;
}

function assertNoPlaintextApiKey(parsed: Record<string, unknown>, configPath: string): void {
  const llm = (parsed.llm ?? {}) as Record<string, unknown>;
  const apiKey = llm.apiKey;
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
    throw new Error(
      `Plaintext API keys are prohibited in config files. Remove llm.apiKey from ${configPath} and use llm.apiKeyEnvVar instead.`,
    );
  }
}

function loadSecretsConfig(): Record<string, unknown> {
  const secretsPath = resolve(__dirname, '../harness_secrets.local.json');
  if (!existsSync(secretsPath)) {
    return {};
  }
  return readJsonConfig(secretsPath);
}

function validateConfig(parsed: Record<string, unknown>): void {
  const defaults: Record<string, number> = {
    maxRetries: 3,
    maxSprintIterations: 3,
    maxRollbacks: 2,
    maxNegotiationRounds: 3,
    evaluationPassScore: 7,
    evaluationMinDimensionScore: 6,
  };

  const thresholds = (parsed.thresholds ?? {}) as Record<string, unknown>;
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (thresholds[key] === undefined || thresholds[key] === null) {
      thresholds[key] = defaultValue;
    }
  }
  parsed.thresholds = thresholds;
}

export function loadConfig(): HarnessConfig {
  if (_config) return _config;

  const configPath = resolve(__dirname, '../harness_config.json');
  const localConfigPath = resolve(__dirname, '../harness_config.local.json');

  const baseConfig = readJsonConfig(configPath);
  assertNoPlaintextApiKey(baseConfig, 'harness_config.json');

  const localConfig = existsSync(localConfigPath) ? readJsonConfig(localConfigPath) : {};
  if (existsSync(localConfigPath)) {
    assertNoPlaintextApiKey(localConfig, 'harness_config.local.json');
  }

  const secretsConfig = loadSecretsConfig();
  const parsed = mergeConfig(mergeConfig(baseConfig, localConfig), secretsConfig);

  validateConfig(parsed);

  // Resolve API key from secrets config first, then fall back to environment variable.
  const llm = parsed.llm as Record<string, unknown>;
  const apiKeyFromSecrets = typeof llm.apiKey === 'string' ? llm.apiKey.trim() : '';
  const apiKeyEnvVar = (llm.apiKeyEnvVar as string) || 'MINIMAX_API_KEY';
  const apiKey = apiKeyFromSecrets || process.env[apiKeyEnvVar] || '';

  if (!apiKey) {
    throw new Error(
      `API key not configured. Add it to harness_secrets.local.json or set the ${apiKeyEnvVar} environment variable. ` +
      `Plaintext API keys in shared config files are prohibited by framework security rules.`,
    );
  }

  // Resolve relative paths to absolute
  const metaRoot = resolve(__dirname, '..');
  _config = {
    ...parsed,
    version: FRAMEWORK_VERSION,
    llm: {
      ...llm,
      apiKeyEnvVar,
      apiKey,
    },
    paths: {
      workspaceRoot: resolve(metaRoot, parsed.paths.workspaceRoot),
      ideaFile: resolve(metaRoot, parsed.paths.ideaFile),
      targetProject: resolve(metaRoot, parsed.paths.targetProject),
      metaLogs: resolve(metaRoot, parsed.paths.metaLogs),
    },
  };

  return _config!;
}

export function getConfig(): HarnessConfig {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}
