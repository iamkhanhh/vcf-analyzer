module.exports = {
  apps: [
    {
      name: 'vcf-analyzer',
      script: 'dist/main.js',
      instances: 1,
      max_memory_restart: '4G',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
