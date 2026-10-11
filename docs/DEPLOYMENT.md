# Deploying Assingly to the Web

Assingly is a unified full-stack application consisting of a React SPA frontend and an Express.js API backend with a local SQLite database (`better-sqlite3`) and private file storage.

In production, the Express server serves both the React client bundle (`dist/`) and all `/api/*` endpoints from a single port, with automated database migration and demo data seeding on first boot.

Because Assingly uses SQLite and stores private uploads locally, it requires persistent disk storage. Below are the recommended deployment guides for **Render**, **Railway**, **Fly.io**, and **Docker**.

---

## 1. Render (Recommended)

Render provides persistent disks and native Docker service support.

### Option A: Using the Render Blueprint (`render.yaml`)
1. Push your repository to GitHub or GitLab.
2. Log into [Render Dashboard](https://dashboard.render.com).
3. Click **New +** → **Blueprint**.
4. Connect your Assingly repository. Render will automatically detect [`render.yaml`](render.yaml) and configure:
   - Web Service with Docker runtime.
   - 1 GB persistent disk mounted to `/app/data`.
   - Healthcheck on `/api/health`.
5. Click **Apply**. Once built, your app will be live at `https://<your-subdomain>.onrender.com`.

### Option B: Manual Web Service Setup
1. In Render Dashboard, click **New +** → **Web Service**.
2. Connect your repository.
3. Select **Docker** as the environment.
4. Under **Disks**, click **Add Disk**:
   - Name: `assingly-data`
   - Mount Path: `/app/data`
   - Size: `1 GB`
5. Add Environment Variables:
   - `DATABASE_PATH`: `/app/data/assingly.db`
   - `UPLOAD_DIR`: `/app/data/private-uploads`
   - `NODE_ENV`: `production`
6. Click **Create Web Service**.

---

## 2. Railway

Railway detects [`Dockerfile`](Dockerfile) and provides high-performance persistent volumes.

1. Install the Railway CLI or use the web dashboard at [railway.com](https://railway.com).
2. Create a new project from your repository.
3. In the service settings:
   - Add a **Volume**: mount it to `/app/data`.
   - Ensure environment variables are set:
     - `PORT`: `3001` (or Railway's default `$PORT`)
     - `DATABASE_PATH`: `/app/data/assingly.db`
     - `UPLOAD_DIR`: `/app/data/private-uploads`
     - `NODE_ENV`: `production`
4. Under **Networking**, click **Generate Domain** to get your public HTTPS URL.

---

## 3. Fly.io

Fly.io runs the Docker container on lightweight microVMs with dedicated NVMe storage using [`fly.toml`](fly.toml).

1. Install the Fly CLI:
   ```bash
   brew install flyctl
   ```
2. Log in and initialize:
   ```bash
   fly auth login
   fly launch --no-deploy
   ```
3. Create a persistent volume for SQLite data:
   ```bash
   fly volumes create assingly_data --region iad --size 1
   ```
4. Deploy the application:
   ```bash
   fly deploy
   ```
5. View your live application:
   ```bash
   fly open
   ```

---

## 4. Docker / Self-Hosted VPS

To run Assingly in production on any VPS (DigitalOcean, Hetzner, AWS EC2, etc.):

1. Clone the repository on your server:
   ```bash
   git clone <repo-url> assingly
   cd assingly
   ```
2. Start the container with Docker Compose:
   ```bash
   docker compose up -d --build
   ```
3. The application will be running on port `3001` with persistent volume `assingly_data`.
4. (Optional) Put a reverse proxy like Nginx or Caddy in front for automatic SSL:
   ```caddy
   assingly.example.com {
       reverse_proxy localhost:3001
   }
   ```

---

## Production Security Checklist

When deploying to a public domain beyond demo environments:
- [ ] Replace the demo profile switcher in `src/App.tsx` and `X-Demo-User` header with standard session authentication (e.g. session cookies, JWT).
- [ ] Set `DEMO_MODE=false` in environment variables.
- [ ] Ensure the `/app/data` volume is backed up regularly.
- [ ] Configure object storage (S3 / Cloud Storage) for uploads if scaling across multiple container instances.
