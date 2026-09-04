// pm2 process definition for the web control panel.
//
// CommonJS on purpose (.cjs) — the package itself is "type": "module", and
// pm2's config loader wants a file it can require() directly.
//
// Run from the repo root: pm2 start ecosystem.config.cjs
// tsx's --env-file=.env (baked into the "web" npm script) loads .env itself,
// so pm2 doesn't need its own env block for DEV_API_KEY / SUPERADMIN_PASSWORD
// etc. — just WEB_PORT if you want it visible in `pm2 describe`.
module.exports = {
  apps: [
    {
      name: 'bulk-tryon-web',
      cwd: __dirname,
      script: 'pnpm',
      args: 'web',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
