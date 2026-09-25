/**
 * pm2 process definition.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save                          # survive a reboot
 *   pm2 startup                       # prints the systemd command to run once
 *
 * PLACEHOLDERS: `cwd` below is the only thing that must match your server.
 *
 * ---------------------------------------------------------------------------
 * Read this before changing `exec_mode` or `instances`.
 * ---------------------------------------------------------------------------
 *
 * Fork mode, one instance, deliberately. `pm2 start -i max` is the reflex on a
 * VPS and it would quietly break two things:
 *
 *  1. The SSE event bus (lib/events/bus.ts) is in-process, on globalThis. A
 *     movement recorded by worker 2 never reaches a device console held open by
 *     worker 1. Nothing errors — the screen just stops updating, which is much
 *     worse than a crash because it looks like "no activity".
 *
 *  2. The rate limiter (lib/api/rate-limit.ts) counts in-process too. Four
 *     workers turn the 10/minute per-account sign-in limit into 40/minute. The
 *     limit that actually stops password guessing silently loosens by 4x.
 *
 * Both are single-instance assumptions the code states openly, not oversights.
 * Scaling past one instance means moving both to Redis first — real work, not a
 * config change. Until then this file is the enforcement.
 */

/**
 * The port. Change it here and in deploy/nginx.conf's `upstream` block — those
 * are the only two places, and they must agree or nginx proxies to nothing and
 * every request is a 502.
 *
 * Not 3000: something else on this box already has it. Nothing about the app
 * depends on the number, only that nginx points at the same one.
 */
const PORT = 3012

module.exports = {
  apps: [
    {
      name: 'inventory',

      // CHANGE ME: wherever you cloned the repo on the VPS.
      cwd: '/srv/inventory',

      /**
       * Next's own binary rather than `npm start`. npm sits between pm2 and the
       * server as an extra process, and it forwards signals imperfectly — a
       * reload can leave the old server holding the port while pm2 believes it
       * stopped.
       */
      script: 'node_modules/next/dist/bin/next',
      args: 'start',

      exec_mode: 'fork', // see the note above
      instances: 1, // see the note above

      env: {
        NODE_ENV: 'production',
        // `next start` reads PORT. Declared once, at the top of this file.
        PORT,
      },

      /**
       * The rest of the configuration lives in .env on the server, loaded by
       * Next. Deliberately not here: this file is in git, .env is not, and the
       * moment secrets can live in both places somebody puts one in the wrong
       * one.
       */

      /**
       * Long enough to let open SSE streams close on their own. The default 1.6s
       * kills them mid-flight; every device console then reconnects at once
       * against a server that is still starting.
       */
      kill_timeout: 10_000,

      /**
       * A restart loop against a database that is down should back off rather
       * than hammer it, and should not be mistaken for a healthy service.
       */
      min_uptime: 20_000,
      max_restarts: 10,
      restart_delay: 4_000,

      max_memory_restart: '700M',

      // pm2's own logs. The app's structured JSON goes to stdout and lands here.
      out_file: '/var/log/inventory/out.log',
      error_file: '/var/log/inventory/err.log',
      time: true,

      /**
       * No `watch`. It is a development convenience, and on a production box it
       * means an rsync or an editor swap file restarts the warehouse.
       */
      watch: false,
    },
  ],
}
