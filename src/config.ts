import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ConfigProvider = 'deepseek' | 'openai' | 'openrouter' | 'groq' | 'local' | 'custom';

export interface PrecogConfig {
  provider?: ConfigProvider;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  keySource?: string;
}

export function configPath(): string {
  return path.join(os.homedir(), '.precog', 'config.json');
}

function sanitize(value: unknown): PrecogConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const providers: ConfigProvider[] = ['deepseek', 'openai', 'openrouter', 'groq', 'local', 'custom'];
  const result: PrecogConfig = {};
  if (typeof input.provider === 'string' && providers.includes(input.provider as ConfigProvider)) result.provider = input.provider as ConfigProvider;
  if (typeof input.baseUrl === 'string' && input.baseUrl.trim()) result.baseUrl = input.baseUrl.trim();
  if (typeof input.model === 'string' && input.model.trim()) result.model = input.model.trim();
  if (typeof input.apiKey === 'string' && input.apiKey) result.apiKey = input.apiKey;
  if (typeof input.keySource === 'string' && input.keySource.trim()) result.keySource = input.keySource.trim();
  return result;
}

export function loadConfig(file = configPath()): PrecogConfig {
  try {
    return sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

export function saveConfig(config: PrecogConfig, file = configPath()): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows and restrictive filesystems may ignore chmod. */ }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(sanitize(config), null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(temporary, 0o600); } catch { /* Windows and restrictive filesystems may ignore chmod. */ }
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows and restrictive filesystems may ignore chmod. */ }
}

export function clearConfig(file = configPath()): void {
  try { fs.rmSync(file, { force: true }); } catch { /* A missing config is already reset. */ }
}
