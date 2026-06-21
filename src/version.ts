import { readFileSync } from 'fs';
import path from 'path';

import { PROJECT_ROOT } from './config.js';

/**
 * Single source of truth for the app version. Reads `version` from package.json
 * at startup so the number lives in exactly one place — bump package.json (or
 * let the release tooling do it) and everything that reports a version follows.
 */
let cached: string | undefined;

export function getVersion(): string {
  if (cached) return cached;
  let v = '0.0.0';
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
    );
    if (typeof pkg.version === 'string') v = pkg.version;
  } catch {
    // keep the '0.0.0' fallback
  }
  cached = v;
  return v;
}

export const VERSION = getVersion();
