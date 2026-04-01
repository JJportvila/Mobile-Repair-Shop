module.exports = {
  apps: [
    {
      name: "stitch-backend",
      cwd: "/var/www/stitch/backend",
      script: "src/index.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 4100,
        DATABASE_PATH: "./data/stitch.sqlite",
        FRONTEND_ORIGIN: "https://stitch.yourdomain.com,https://www.stitch.yourdomain.com",
      },
    },
  ],
};
