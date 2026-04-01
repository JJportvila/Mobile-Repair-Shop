# Production Deployment

## Deployment Model

This project uses a single Node service behind Nginx:

- Express serves the built frontend from `frontend/dist`
- Express also serves all `/api` routes
- Nginx only handles the public domain, reverse proxy, and HTTPS
- SQLite stays on disk at `backend/data/stitch.sqlite`

Recommended server path:

```bash
/var/www/stitch
```

## 1. Install server packages

```bash
sudo apt update
sudo apt install -y nginx
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

## 2. Upload project

Copy the full project to:

```bash
/var/www/stitch
```

Expected layout:

- `/var/www/stitch/frontend`
- `/var/www/stitch/backend`
- `/var/www/stitch/deploy`

## 3. Install dependencies

```bash
cd /var/www/stitch
npm install
npm run install:all
```

## 4. Configure production environment

```bash
cd /var/www/stitch/backend
cp .env.production.example .env
```

Recommended values:

- `NODE_ENV=production`
- `PORT=4100`
- `DATABASE_PATH=./data/stitch.sqlite`
- `FRONTEND_ORIGIN=https://stitch.yourdomain.com,https://www.stitch.yourdomain.com`

`FRONTEND_ORIGIN` is mainly used for allowed origins and can stay on the same public domain as the app.

## 5. Build the Web app

Because the backend serves the frontend bundle directly, build the frontend before starting PM2:

```bash
cd /var/www/stitch
npm run build:web
```

If you need a frontend production env file, keep the API base empty for same-domain deployment:

```bash
cd /var/www/stitch/frontend
cat > .env.production <<'EOF'
VITE_API_BASE_URL=
EOF
```

## 6. Start with PM2

```bash
cd /var/www/stitch
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup
```

The provided PM2 config starts the backend from:

- `cwd=/var/www/stitch/backend`
- `script=src/index.js`
- `PORT=4100`

## 7. Configure Nginx

```bash
sudo cp /var/www/stitch/deploy/nginx.stitch.conf /etc/nginx/sites-available/stitch.conf
sudo ln -s /etc/nginx/sites-available/stitch.conf /etc/nginx/sites-enabled/stitch.conf
sudo nginx -t
sudo systemctl reload nginx
```

Make sure the `proxy_pass` target in the Nginx file points at the same backend port used by PM2.

## 8. Enable HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d stitch.yourdomain.com -d www.stitch.yourdomain.com
```

## 9. Verify deployment

Check these exact URLs after deployment:

- `https://stitch.yourdomain.com`
- `https://stitch.yourdomain.com/api/health`

Useful commands:

```bash
pm2 status
pm2 logs stitch-backend
curl https://stitch.yourdomain.com/api/health
```

## Operational Notes

- Rebuild the frontend with `npm run build:web` before restarting PM2 after frontend changes.
- Restart the app with `pm2 restart stitch-backend` after backend or env changes.
- Back up `backend/data/stitch.sqlite` before redeploys.
- If you deploy on a different domain, update both `FRONTEND_ORIGIN` and the Nginx `server_name`.
