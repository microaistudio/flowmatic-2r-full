module.exports = {
  apps: [
    {
      name: 'fm-r2f',
      script: './src/server.js',
      cwd: '/home/subhash.thakur.india/projects/fm-r2-full',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        PORT: 5050,
        ADMIN_PASSWORD: 'ulan',
        SESSION_SECRET: 'ulan-session-secret-2025'
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      out_file: './logs/out.log',
      error_file: './logs/error.log'
    }
  ]
};
