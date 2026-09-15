// pm2 process definition for the web control panel.
//
// CommonJS on purpose (.cjs) — the package itself is "type": "module", and
// pm2's config loader wants a file it can require() directly.
//
// Run from the repo root, as root: pm2 start ecosystem.config.cjs
//
// `script` is pinned to root's own nvm-installed Node 23 binary by absolute
// path rather than the bare 'node' command. This app moved from running
// under the aivastra-batch-tryon user to running under root (2026-09-15);
// root's system-wide `node` is v22.23.2 (too old — package.json requires
// >=23.4.0, needed for node:sqlite to work without a flag), and root also
// runs other pm2-managed apps that may themselves depend on bare `node`
// resolving to that v22 default. Pinning the absolute path means this app
// always launches on 23.x regardless of PATH/nvm state at start time, and
// changing root's nvm default (or installing yet another version) can never
// accidentally change what THIS app runs on. If that path ever moves —
// nvm reinstalled, bumped to a newer 23.x — update it here; confirm the
// real path first with `nvm which 23.11.1` as root.
//
// Runs node directly with tsx as an --import loader, rather than through
// `pnpm web` or even the `tsx` CLI binary. Both of those interpose an extra
// process: `pnpm web` goes pnpm -> npm-lifecycle shell -> tsx -> node, and
// even bare `node_modules/.bin/tsx` spawns its OWN child node process
// internally rather than being the server itself. Either way, pm2 ends up
// owning a wrapper rather than the real listening process — a restart
// signals the wrapper, but the actual child can take a moment longer to
// release the port than pm2's restart_delay allows for, so the next attempt
// hits EADDRINUSE while the old child is still shutting down. Node's own
// --import flag runs tsx's loader in-process, so pm2 supervises the one
// real node process directly with no nesting and no shutdown race.
//
// --env-file=.env loads secrets itself, so pm2 doesn't need its own env
// block for DEV_API_KEY / SUPERADMIN_PASSWORD etc. — just WEB_PORT if you
// want it visible in `pm2 describe`.
module.exports = {
  apps: [
    {
      name: 'bulk-tryon-web',
      cwd: __dirname,
      script: '/root/.nvm/versions/node/v23.11.1/bin/node',
      args: ['--import', 'tsx', '--env-file=.env', 'webapp/server.mts'],
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
