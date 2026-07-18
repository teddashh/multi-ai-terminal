import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Worktrees may share a parent checkout's node_modules symlink. Tests must
    // exercise this worktree's shared contracts, not the parent checkout's build.
    alias: { '@mat/shared': fileURLToPath(new URL('./shared/src/index.ts', import.meta.url)) },
  },
});
