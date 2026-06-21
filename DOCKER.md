# Docker Deployment Guide

## Quick Start

### Monochrome Only

```bash
docker compose -f docker/docker-compose.yml --env-file .env up -d
```

Visit `http://localhost:3000`

### Development

```bash
docker compose -f docker/docker-compose.yml --env-file .env --profile dev up -d
```

Visit `http://localhost:5173` (hot-reload enabled)

---

## How It Works

### Profiles

Docker Compose [profiles](https://docs.docker.com/compose/how-tos/profiles/) control which services start. A service with no profile always runs. A service with a profile only runs when that profile is activated.

| Command                                                   | What starts                          |
| --------------------------------------------------------- | ------------------------------------ |
| `docker compose -f docker/docker-compose.yml --env-file .env up -d`                                    | Monochrome                           |
| `COMPOSE_PROFILES=redis docker compose -f docker/docker-compose.yml --env-file .env up -d`             | Monochrome + Redis download queue    |
| `docker compose -f docker/docker-compose.yml --env-file .env --profile pocketbase up -d`               | Monochrome + PocketBase              |
| `docker compose -f docker/docker-compose.yml --env-file .env --profile dev up -d`                      | Monochrome + Dev server              |
| `docker compose -f docker/docker-compose.yml --env-file .env --profile dev --profile pocketbase up -d` | Monochrome + Dev server + PocketBase |

In `docker-compose.yml`, it looks like this:

```yaml
services:
    monochrome: # no profile -- always starts

    pocketbase:
        profiles: ['pocketbase'] # opt-in

    monochrome-dev:
        profiles: ['dev'] # opt-in
```

### Override File

Docker Compose automatically merges `docker-compose.override.yml` into `docker-compose.yml` if it exists in the same directory. No flags needed.

This is useful for forks that need to add custom services or configuration (Traefik labels, extra containers, custom networks) without modifying the base `docker-compose.yml`.

The override file does not exist in the upstream repo, don't search it!

**Example** -- adding Traefik labels to PocketBase in your fork:

```yaml
# docker-compose.override.yml
services:
    pocketbase:
        labels:
            - traefik.enable=true
            - traefik.http.routers.pocketbase.rule=Host(`pocketbase.example.com`)
            - traefik.http.routers.pocketbase.entrypoints=websecure
            - traefik.http.routers.pocketbase.tls.certresolver=letsencrypt
            - traefik.http.services.pocketbase.loadbalancer.server.port=8090
        networks:
            - proxy-network

networks:
    proxy-network:
        external: true
```

**Example** -- adding a custom service in your fork:

```yaml
# docker-compose.override.yml
services:
    my-custom-api:
        image: my-api:latest
        restart: unless-stopped
        ports:
            - '4000:4000'
        networks:
            - monochrome-network
```

Override files can extend existing services (add labels, env vars, networks) and define entirely new services. See the [Docker docs](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/) for the full merge behavior.

---

## Configuration

The application is configured via environment variables. Copy `.env.example` to `.env` and edit it to match your setup.

### Authentication (Appwrite)

Monochrome uses Appwrite for user authentication. While it defaults to official instances, you can use your own self-hosted Appwrite instance:

1. Create a project in Appwrite.
2. Enable the **Google** or **Email/Password** providers in the Appwrite Console.
3. Set these variables in your `.env`:
    - `APPWRITE_ENDPOINT`: Your Appwrite API endpoint (e.g., `https://auth.yourdomain.com/v1`).
    - `APPWRITE_PROJECT_ID`: Your Appwrite project ID (e.g., `auth-for-monochrome`).

### Database (PocketBase)

Monochrome uses PocketBase to store user data (playlists, favorites, profiles, etc.). You can run it alongside Monochrome using the `pocketbase` profile:

```bash
docker compose -f docker/docker-compose.yml --env-file .env --profile pocketbase up -d
```

#### PocketBase Schema Note

The current PocketBase collection schema is committed at [`database/pb_schema.json`](database/pb_schema.json). Import that schema into a fresh PocketBase instance when setting up account data storage.

### Server-Side Downloads

Server-side downloads are served by the production Monochrome container on the same port as the web app. The container exposes `/api/downloads`, runs the download worker, and writes completed files to `DOWNLOAD_DIR`.

Common variables:

- `MONOCHROME_MUSIC_DIR`: host path mounted into the container, default `./music`.
- `DOWNLOAD_DIR`: path inside the container, default `/data/music`.
- `TEMP_DIR`: temporary download/staging root, default `/tmp/monochrome-downloads`.
- `DOWNLOAD_WORKER_ENABLED`: enable queue execution, default `true`.
- `DOWNLOAD_WORKER_CONCURRENCY`: concurrent server download jobs, default `1`.
- `DOWNLOAD_DUPLICATE_CHECK`: skip known local files before queueing when possible, default `false`.
- `REDIS_URL`: optional Redis queue backend, for example `redis://monochrome-redis:6379`.
- `AMAZON_MUSIC_*` and `DEEZER_FALLBACK_*`: optional upstream provider settings passed to Monochrome's existing resolver flow. Deezer defaults match upstream Monochrome. Amazon is disabled by default in the server container because its Turnstile flow is browser-only unless `AMAZON_MUSIC_TURNSTILE_BYPASS_TOKEN` is configured.

Enable Redis-backed queue state and cross-process locking:

```bash
COMPOSE_PROFILES=redis REDIS_URL=redis://monochrome-redis:6379 docker compose -f docker/docker-compose.yml --env-file .env up -d
```

Verify the server download API:

```bash
curl http://localhost:${MONOCHROME_PORT:-3000}/api/downloads
```

### Add To Existing Media Stack

If this repository is checked out next to your compose file as `./monochrome`, add this service to your existing stack. This runs only the base Monochrome server and server-side downloader; it does not start Redis, PocketBase, or the dev server.

```yaml
  monochrome:
    build:
      context: ./monochrome
      dockerfile: docker/Dockerfile
    container_name: monochrome
    user: "${UID}:${GID}"
    ports:
      - "5001:4173"
    environment:
      TZ: ${TZ}
      PORT: 4173
      DOWNLOAD_DIR: /data/music
      TEMP_DIR: /tmp/monochrome-downloads
      DOWNLOAD_WORKER_ENABLED: "true"
      DOWNLOAD_WORKER_CONCURRENCY: "1"
      DOWNLOAD_DUPLICATE_CHECK: "true"
      DOWNLOAD_MAINTENANCE_LOCK_TIMEOUT_MS: "30000"
      DOWNLOAD_TRANSIENT_MIN_AGE_MS: "900000"
      AMAZON_MUSIC_ENABLED: "false"
      AMAZON_MUSIC_API_BASE_URL: https://amz.geeked.wtf
      AMAZON_MUSIC_CONVERTER_BASE_URL: https://t2a.geeked.wtf
      AMAZON_MUSIC_TURNSTILE_SITE_KEY: 0x4AAAAAADgxqF6QVMm0GLHH
      AMAZON_MUSIC_TURNSTILE_BYPASS_TOKEN: ""
      DEEZER_FALLBACK_ENABLED: "true"
      DEEZER_FALLBACK_API_BASE_URL: https://dzr.tabs-vs-spaces.wtf
    volumes:
      - /srv/completed/music:/data/music
      - /srv/monochrome/tmp:/tmp/monochrome-downloads
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:4173/api/downloads"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 5s
```

Prepare the writable host paths before starting it:

```bash
mkdir -p /srv/completed/music /srv/monochrome/tmp
chown -R "${UID}:${GID}" /srv/completed/music /srv/monochrome/tmp
docker compose up -d --build monochrome
curl http://localhost:5001/api/downloads
```

With your Watchtower command using `--label-enable`, this locally built service is intentionally not labelled. Watchtower cannot rebuild from `./monochrome`; update it with `git pull` inside `./monochrome` and `docker compose up -d --build monochrome`.

### Replacing tidal-ui

Given an old service like:

```yaml
tidal-ui:
  ports:
    - "5001:5000"
  environment:
    - DOWNLOAD_DIR=/data/music
  volumes:
    - /srv/transmission/downloads/completed/music:/data/music
```

Use these Monochrome settings:

```env
MONOCHROME_PORT=5001
MONOCHROME_MUSIC_DIR=/srv/transmission/downloads/completed/music
DOWNLOAD_DIR=/data/music
TEMP_DIR=/tmp/monochrome-downloads
DOWNLOAD_WORKER_ENABLED=true
DOWNLOAD_WORKER_CONCURRENCY=1
DOWNLOAD_DUPLICATE_CHECK=true
COMPOSE_PROFILES=redis
REDIS_URL=redis://monochrome-redis:6379
```

Then deploy:

```bash
docker rm -f tidal-ui
docker compose -f docker/docker-compose.yml --env-file .env up -d --build
docker compose -f docker/docker-compose.yml --env-file .env logs -f monochrome
curl http://localhost:5001/api/downloads
```

---

## Portainer Deployment

Portainer can deploy directly from your GitHub fork with auto-updates on push.

### Setup

1. In Portainer, go to **Stacks > Add Stack > Repository**
2. Enter your fork URL and branch
3. Compose path: `docker-compose.yml`
4. If your fork has a `docker-compose.override.yml`, Portainer loads it automatically
5. Under **Environment variables**, add:
    - `COMPOSE_PROFILES=pocketbase` (to enable PocketBase -- omit if not needed)
    - `PB_ADMIN_EMAIL=your@email.com`
    - `PB_ADMIN_PASSWORD=your_secure_password`
    - Any other variables from `.env.example`
6. Enable **GitOps updates** to auto-redeploy on push

> **Tip:** `COMPOSE_PROFILES` is a built-in Docker Compose variable. Setting it to `pocketbase` is equivalent to passing `--profile pocketbase` on the command line.

> **Warning:** The `dev` profile is for **local development only**. It uses volume mounts to enable hot-reload, which requires the source code to be present on the host machine. Do **not** include `dev` in `COMPOSE_PROFILES` on Portainer deployments from GitHub - it will fail because there's no local source code to mount.

### Fork Workflow

To add custom services (Traefik, monitoring, etc.) to your fork:

1. Create `docker-compose.override.yml` in your fork
2. Remove the `docker-compose.override.yml` line from `.gitignore`
3. Commit both changes to your fork
4. Portainer will auto-load the override file alongside the base compose

When pulling updates from upstream (`git pull upstream main`), there are no conflicts -- the upstream repo does not have an override file.

---

## Common Operations

```bash
# View logs
docker compose -f docker/docker-compose.yml --env-file .env logs -f
docker compose -f docker/docker-compose.yml --env-file .env logs -f pocketbase

# Rebuild after code changes
docker compose -f docker/docker-compose.yml --env-file .env up -d --build

# Stop everything (include all profiles you started)
docker compose -f docker/docker-compose.yml --env-file .env --profile pocketbase down

# Stop and remove volumes (data loss!)
docker compose -f docker/docker-compose.yml --env-file .env --profile pocketbase down -v

# Backup PocketBase data
docker compose -f docker/docker-compose.yml --env-file .env exec pocketbase tar czf - /pb_data > backup.tar.gz

# Restore PocketBase data
docker compose -f docker/docker-compose.yml --env-file .env exec pocketbase tar xzf - -C / < backup.tar.gz
```

---

## Architecture

### Production (Dockerfile)

Bun Alpine image (multi-arch: amd64 + arm64). The builder runs `vite build`; the runtime installs `ffmpeg`/`ffprobe`, serves `dist/`, and handles `/api/downloads` from `server/app.js` on port 4173.

### Development (Dockerfile.dev)

Node.js Alpine image with source code mounted as a volume for hot-reload.

### Files

| File                          | Purpose                       | In upstream repo |
| ----------------------------- | ----------------------------- | :--------------: |
| `docker-compose.yml`          | All services with profiles    |       Yes        |
| `docker-compose.override.yml` | Fork-specific customizations  |        No        |
| `.env.example`                | Environment variable template |       Yes        |
| `.env`                        | Your local configuration      |        No        |
| `Dockerfile`                  | Production build              |       Yes        |
| `Dockerfile.dev`              | Development build             |       Yes        |
| `.dockerignore`               | Build context exclusions      |       Yes        |
