#!/usr/bin/env node
/**
 * A production build, into a dist directory of its own.
 *
 * `next dev` and `next build` both write to `.next` and overwrite each other's
 * chunks, so a verification build run while somebody has a dev server up leaves
 * that server serving references that no longer exist.
 *
 * Worth running before believing anything is finished: the first production
 * build of this project found a bug dev could never show. The event bus was
 * stashed on globalThis only when NODE_ENV !== 'production', and in a
 * production build Next puts route handlers and Server Actions in separate
 * bundles — so the SSE route and the action that publishes to it ended up with
 * different buses. The console connected, stayed connected, and received
 * nothing.
 *
 *   npm run build:verify
 */

import { spawnSync } from 'node:child_process'

const result = spawnSync('npx next build', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NEXT_DIST_DIR: '.next-prod' },
})

process.exit(result.status ?? 1)
