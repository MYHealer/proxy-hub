import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readConfigFile() {
  const p = process.env.PROXY_HUB_CONFIG || path.join(__dirname, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

const DEFAULTS = {
  port: 8787,
  proxyKey: '',
  timeoutMs: 180000,
  adapters: { codebuddy: true, traecn: true, traework: true, qoder: true },
  upstreamOverrides: {},
};

function bool(v, d) {
  if (typeof v === 'boolean') return v;
  if (v === undefined) return d;
  return String(v).toLowerCase() !== 'false';
}

/** 读取配置：默认值 < 环境变量 < config.json（文件优先级最高） */
export function loadConfig() {
  const file = readConfigFile();
  const env = process.env;
  return {
    port: Number(env.PROXY_HUB_PORT ?? file.port ?? DEFAULTS.port),
    proxyKey: env.PROXY_HUB_KEY ?? file.proxyKey ?? DEFAULTS.proxyKey,
    timeoutMs: Number(env.PROXY_HUB_TIMEOUT ?? file.timeoutMs ?? DEFAULTS.timeoutMs),
    adapters: {
      codebuddy: bool(env.PROXY_ADAPTER_CODEBUDDY, file.adapters?.codebuddy ?? DEFAULTS.adapters.codebuddy),
      traecn: bool(env.PROXY_ADAPTER_TRAECN, file.adapters?.traecn ?? DEFAULTS.adapters.traecn),
      traework: bool(env.PROXY_ADAPTER_TRAEWORK, file.adapters?.traework ?? DEFAULTS.adapters.traework),
      qoder: bool(env.PROXY_ADAPTER_QODER, file.adapters?.qoder ?? DEFAULTS.adapters.qoder),
    },
    upstreamOverrides: file.upstreamOverrides ?? DEFAULTS.upstreamOverrides,
  };
}
