/** Builds the app with cloud sync pointed at a fake Supabase (https://sync.test) into dist-sync/, for sync.spec.ts. */
import { execSync } from 'node:child_process';

export default function globalSetup() {
  execSync('npx vite build --outDir dist-sync --emptyOutDir && node scripts/inline.ts dist-sync', {
    stdio: 'ignore',
    env: { ...process.env, VITE_SUPABASE_URL: 'https://sync.test', VITE_SUPABASE_KEY: 'test-publishable-key' },
  });
}
