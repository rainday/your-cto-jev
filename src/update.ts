import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { credentialsPath } from './brain.js';

const PKG = 'your-cto-jev';
const DAY = 86_400_000;

export const currentVersion = (): string =>
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** a > b for plain x.y.z versions. */
export function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

const cachePath = () => join(dirname(credentialsPath()), 'update-check.json');

/**
 * Latest version if it is newer than this one, else undefined.
 * Hits the npm registry at most once a day (cached next to the credentials file); every failure is silent.
 * CTO_NO_UPDATE_CHECK=1 turns it off.
 */
export async function checkUpdate(timeoutMs = 1000, now = Date.now()): Promise<string | undefined> {
  if (process.env.CTO_NO_UPDATE_CHECK === '1') return undefined;
  let latest: string | undefined;
  try {
    const c = JSON.parse(readFileSync(cachePath(), 'utf8'));
    if (now - c.checked_at < DAY && typeof c.latest === 'string') latest = c.latest;
  } catch { /* no cache yet */ }
  if (!latest) {
    try {
      const r = await fetch(`https://registry.npmjs.org/${PKG}/latest`, { signal: AbortSignal.timeout(timeoutMs) });
      const v = (await r.json())?.version;
      if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) return undefined;
      latest = v;
      mkdirSync(dirname(cachePath()), { recursive: true });
      writeFileSync(cachePath(), JSON.stringify({ checked_at: now, latest }) + '\n');
    } catch {
      return undefined;
    }
  }
  return newer(latest, currentVersion()) ? latest : undefined;
}

/** npm install -g your-cto-jev@latest, output streamed to the terminal. */
export function runUpdate(): number {
  // npm is npm.cmd on Windows, which needs a shell. One constant command string: nothing user-supplied is interpolated.
  const r = spawnSync(`npm install -g ${PKG}@latest`, { stdio: 'inherit', shell: true });
  try { writeFileSync(cachePath(), JSON.stringify({ checked_at: 0 }) + '\n'); } catch { /* cache is optional */ }
  return r.status ?? 1;
}
