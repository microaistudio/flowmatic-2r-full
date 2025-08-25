module.exports = {
  apps: [{
    name: 'flowmatic-staging',
    script: './src/server.js',
    cwd: '/var/www/flowmatic',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 5050
    },
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    restart_delay: 1000,
    max_restarts: 5,
    min_uptime: '10s'
  }]
};
