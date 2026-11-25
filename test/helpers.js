// Shared by the tests; not a test file itself.
import { readdir } from 'node:fs/promises';

/** Every dashboard script, as paths from the repo root. */
export async function dashboardFiles() {
  const names = await readdir(new URL('../dashboard/', import.meta.url));
  return names.filter(n => n.endsWith('.js')).map(n => `dashboard/${n}`);
}
