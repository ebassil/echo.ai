import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Shared schema import — drift guard: build fails if this module is missing
import { CLI_JSON_FILENAME, TOKEN_FILENAME } from '../../src/schema/index';

export interface Discovery {
  dataDir: string;
  cliJsonPath: string;
  tokenPath: string;
  port: number | null;
  token: string | null;
  tokenFingerprint: string | null;
}

function joplinProfileHeuristic(): string | null {
  // Joplin desktop profile locations
  const home = os.homedir();
  if (process.platform === 'linux') {
    return path.join(home, '.config', 'joplin-desktop');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Joplin');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Joplin');
  }
  return null;
}

export async function discoverDataDir(): Promise<string> {
  if (process.env.ECHO_DATA_DIR) {
    return process.env.ECHO_DATA_DIR;
  }
  // Try cli.json sibling in heuristic profile
  const heuristic = joplinProfileHeuristic();
  if (heuristic) {
    // plugin data dir is typically <profile>/plugins/com.echoai.joplin-plugin or via Joplin API
    // We try heuristic + '/cache' fallback, but primary discovery is via file read later.
    // For now return heuristic-based plugin data dir candidate; caller will check existence
    // The actual plugin data dir path is <profile>/plugins or temp; but CLI uses ECHO_DATA_DIR override for tests.
    // We'll try common locations.
    const candidates = [
      path.join(heuristic, 'com.echoai.joplin-plugin'),
      path.join(heuristic, 'plugins', 'com.echoai.joplin-plugin'),
    ];
    for (const c of candidates) {
      try {
        const stat = await fs.stat(c);
        if (stat.isDirectory()) return c;
      } catch {}
    }
  }
  // Fallback: use heuristic direct
  if (heuristic) return heuristic;
  return path.join(os.tmpdir(), 'echo-cli-fallback');
}

export async function loadDiscovery(): Promise<Discovery> {
  const dataDir = await discoverDataDir();
  const cliJsonPath = path.join(dataDir, CLI_JSON_FILENAME);
  const tokenPath = path.join(dataDir, TOKEN_FILENAME);

  let port: number | null = null;
  let token: string | null = null;
  let tokenFingerprint: string | null = null;

  // ECHO_TOKEN env var takes precedence
  if (process.env.ECHO_TOKEN) {
    token = process.env.ECHO_TOKEN;
  }

  try {
    const raw = await fs.readFile(cliJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.port === 'number') port = parsed.port;
    if (typeof parsed.tokenFingerprint === 'string') tokenFingerprint = parsed.tokenFingerprint;
    if (!token && typeof parsed.token === 'string') token = parsed.token;
  } catch {}

  if (!token) {
    try {
      const t = await fs.readFile(tokenPath, 'utf8');
      const trimmed = t.trim();
      if (trimmed) token = trimmed;
    } catch {}
  }

  return { dataDir, cliJsonPath, tokenPath, port, token, tokenFingerprint };
}

export function endpointUrl(port: number, endpointPath: string): string {
  return `http://127.0.0.1:${port}${endpointPath}`;
}
