// pm2 process definition for the web control panel.
//
// CommonJS on purpose (.cjs) — the package itself is "type": "module", and
// pm2's config loader wants a file it can require() directly.
//
// Run from the repo root: pm2 start ecosystem.config.cjs
//
// Invokes the local tsx binary directly rather than going through `pnpm web`
// (`pnpm` -> npm-lifecycle shell -> `tsx` -> node): that extra process
// nesting let a `pm2 delete`/restart leave an orphaned node process still
// holding the port, since pm2's tree-kill couldn't see past the pnpm/shell
// hop. One hop (pm2 -> tsx, which execs into the final node process) means
// pm2's signals reach the real process directly.
//
// tsx's --env-file=.env loads secrets itself, so pm2 doesn't need its own
// env block for DEV_API_KEY / SUPERADMIN_PASSWORD etc. — just WEB_PORT if
// you want it visible in `pm2 describe`.
module.exports = {
  apps: [
    {
      name: 'bulk-tryon-web',
      cwd: __dirname,
      script: 'node_modules/.bin/tsx',
      args: ['--env-file=.env', 'webapp/server.mts'],
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
