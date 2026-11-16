import { readFileSync } from 'node:fs';
import { join } from 'node:path';
try {
  const timestamp = Number(readFileSync(join(process.env.DATA_DIR || 'data', 'heartbeat'), 'utf8'));
  if (!timestamp || Date.now() - timestamp > 180000) process.exitCode = 1;
} catch { process.exitCode = 1; }
