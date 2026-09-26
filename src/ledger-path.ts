import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The override keeps tests and embedded installations out of the user's home. */
export function ledgerPath(baseDir = process.env.S1_PRECOG_HOME || os.homedir()): string {
  const current = path.join(baseDir, '.s1-precog');
  const legacy = path.join(baseDir, '.codex-s1');
  if (!fs.existsSync(current)) {
    if (fs.existsSync(legacy)) {
      fs.cpSync(legacy, current, { recursive: true, errorOnExist: false });
      const oldFilename = path.join(current, 'savings-ledger.json');
      const newFilename = path.join(current, 'ledger.json');
      if (!fs.existsSync(newFilename) && fs.existsSync(oldFilename)) {
        fs.copyFileSync(oldFilename, newFilename);
      }
    } else {
      fs.mkdirSync(current, { recursive: true });
    }
  }
  return path.join(current, 'ledger.json');
}
