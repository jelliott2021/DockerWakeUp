module.exports = {
  apps: [
    {
      name: 'docker-wakeup',
      script: 'dist/wake-proxy.js',
      cwd: '/full/path/to/docker-wakeup/wake-proxy',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production'
      },
      error_file: '/var/log/docker-wakeup/error.log',
      out_file: '/var/log/docker-wakeup/out.log',
      log_file: '/var/log/docker-wakeup/combined.log',
      time: true,
      merge_logs: true
    }
  ]
};
