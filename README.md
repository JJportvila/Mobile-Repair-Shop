# Stitch Repair MVP

This project turns the original `stitch_` prototype export into a runnable Web app with a React frontend, an Express API, and a SQLite database.

## Project Structure

- `frontend`: Vite + React mobile-style Web frontend
- `backend`: Express + SQLite API, seed data, and production static hosting
- `deploy`: PM2 + Nginx deployment templates
- `stitch_`: original design export kept as visual reference

## Local Development

```powershell
cd D:\Jason\我的文档\stitch_1
npm install
npm run install:all
npm run dev
```

Then open:

- Frontend dev: `http://localhost:5173`
- Backend API: `http://localhost:4100`

## Local Production Test

The backend already serves `frontend/dist`, so the production-like Web test only needs one service:

```powershell
cd D:\Jason\我的文档\stitch_1
npm run serve:web
```

Then open:

- App: `http://localhost:4100`
- Health check: `http://localhost:4100/api/health`

Useful scripts:

- `npm run build:web`: build the frontend bundle
- `npm run start:web`: start the backend and serve the built frontend
- `npm run serve:web`: build and start the single-service Web app
- `npm run check:web`: quick production build check

## Production Deployment

This project is designed for same-domain deployment:

- Nginx handles the public domain and reverse proxies requests to the Node service
- Express serves both the built frontend and the `/api` routes
- SQLite stays in `backend/data/stitch.sqlite`

Deployment files:

- `deploy/DEPLOY.md`
- `deploy/ecosystem.config.cjs`
- `deploy/nginx.stitch.conf`
- `backend/.env.production.example`

Recommended production flow:

```bash
cd /var/www/stitch
npm install
npm run install:all
npm run build:web
pm2 start deploy/ecosystem.config.cjs
```
