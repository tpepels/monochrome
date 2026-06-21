# TODO 06: Production Docker, Web UI Coverage, And Thin Coupling Audit

Goal: close the remaining integration gaps so the server-side download module is deployable as a live Docker replacement, fully usable from the web UI, and thinly coupled enough that upstream Monochrome merges stay low-friction.

Only add the most strictly necessary tests needed to prove the product.

## Audit Gaps Addressed

- [x] Replace the previous static-only nginx production image with a runtime that serves the frontend and download API.
- [x] Serve `/api/downloads` routes and the download worker from the production Docker container.
- [x] Expose `DOWNLOAD_DIR`, `TEMP_DIR`, `REDIS_URL`, worker concurrency, duplicate checks, provider instance overrides, and upstream provider settings in Docker config.
- [x] Keep the existing web UI queueing path for track and album downloads.
- [x] Add a persistent queue/status view, retry actions, Redis fallback/backend status, and manual maintenance sweep actions.
- [x] Make `server/downloads/resolver-adapter.js` delegate through an explicit resolver facade boundary.
- [x] Add visible UI controls for the manual sweep API.
- [x] Add a public retry route and UI action.

## Production Docker Runtime

- [x] Replace the nginx-only production container with a runtime that serves both built static assets and `/api/downloads`.
- [x] Keep static assets served efficiently, but route `/api/*` to the server runtime.
- [x] Add a server entrypoint such as `server/app.js` or `server/downloads/http-server.js`.
- [x] Serve `dist/` from the same container or through a paired frontend container with a reverse proxy.
- [x] Ensure `ffmpeg` and `ffprobe` can be installed in the production image or through a documented optional image variant.
- [x] Keep the image multi-arch compatible.
- [x] Add health checks that verify both frontend and `/api/downloads` respond.

## Docker Configuration

- [x] Add runtime environment variables to `docker/docker-compose.yml`:
  - `DOWNLOAD_DIR`
  - `TEMP_DIR`
  - `DOWNLOAD_WORKER_ENABLED`
  - `DOWNLOAD_WORKER_CONCURRENCY`
  - `DOWNLOAD_DUPLICATE_CHECK`
  - `DOWNLOAD_MAINTENANCE_LOCK_TIMEOUT_MS`
  - `DOWNLOAD_TRANSIENT_MIN_AGE_MS`
  - `REDIS_URL`
  - `DOWNLOAD_API_INSTANCES`
  - `DOWNLOAD_STREAMING_INSTANCES`
  - `DOWNLOAD_QOBUZ_INSTANCES`
  - `AMAZON_MUSIC_ENABLED`
  - `AMAZON_MUSIC_API_BASE_URL`
  - `AMAZON_MUSIC_CONVERTER_BASE_URL`
  - `AMAZON_MUSIC_TURNSTILE_SITE_KEY`
  - `AMAZON_MUSIC_TURNSTILE_BYPASS_TOKEN`
  - `DEEZER_FALLBACK_ENABLED`
  - `DEEZER_FALLBACK_API_BASE_URL`
- [x] Mount the music library path into the container.
- [x] Add an optional Redis service/profile for persistent queue state and cross-process locking.
- [x] Update `DOCKER.md` with a live deployment example replacing `tidal-ui`.
- [x] Add or update `.env.example` with server-download settings.

## Web UI Coverage

- [x] Add a downloads queue/status panel backed by `GET /api/downloads`.
- [x] Show backend mode, Redis fallback reason, worker status, active count, and concurrency.
- [x] Show queued, processing, paused, completed, failed, and cancelled jobs.
- [x] Show album track progress and publication phase.
- [x] Add cancel actions for queued and processing jobs.
- [x] Add retry actions for retryable failed jobs.
- [x] Add a manual maintenance sweep action with dry-run first and explicit confirm for destructive cleanup.
- [x] Surface sweep results in the UI.
- [x] Keep server-side downloads as the default path while still allowing the existing browser fallback toggle.

## Thin Resolver Coupling

- [x] Use a small resolver facade into Monochrome's existing resolver/download flow from `js/api.js`/`LosslessAPI`.
- [x] Have `server/downloads/resolver-adapter.js` delegate to that facade instead of duplicating provider instance discovery and Qobuz/HiFi request logic.
- [x] Keep server-specific normalization in the adapter only: output shape, preview flags, metadata mapping, and manifest inspection.
- [x] Keep proxy behavior sourced from existing `js/proxy-utils.js`.
- [x] Add a test that proves the server adapter uses the shared resolver facade.
- [x] Document the intended coupling boundary in `server/downloads/README.md`.

## Public API Completion

- [x] Add `POST /api/downloads/:jobId/retry` for retryable failed jobs.
- [x] Make retry return the new job id and copied request parameters.
- [x] Ensure retry creates a fresh temp/staging path.
- [x] Add API tests for retry route behavior.
- [x] Ensure all queue APIs work in both memory and Redis modes.

## Acceptance Criteria

- [x] A production Docker deployment can open the web app and successfully call `POST /api/downloads`.
- [x] A mounted `DOWNLOAD_DIR` receives completed track and album downloads from the server worker.
- [x] Redis can be enabled through Docker config; if Redis is unavailable, the UI clearly shows memory fallback.
- [x] All server download operations needed by an operator are available in the web UI.
- [x] Server-side resolver behavior tracks upstream Monochrome resolver changes through a shared facade instead of copied request logic.
- [x] Pulling upstream Monochrome changes should normally conflict only in the small frontend integration points and the explicit shared resolver facade.

## Implementation Notes

- Production runtime is implemented in `server/app.js`; it serves `dist/` and the server download APIs from one Bun process.
- `docker/Dockerfile` now ships the server runtime, `ffmpeg`/`ffprobe`, static assets, and the isolated server-download module.
- `docker/docker-compose.yml` exposes download runtime settings, upstream provider settings, mounts the music library, and includes an optional Redis profile. Amazon is disabled by default in the server container unless a Turnstile bypass token is configured because the upstream Turnstile flow requires a browser document.
- The Downloads settings tab now includes a server queue panel with backend/fallback status, worker state, job list, cancel, retry, dry-run sweep, and cleanup sweep actions.
- Retry is exposed through `POST /api/downloads/:jobId/retry`.
- `ServerResolverAdapter` delegates through `MonochromeResolverFacade` into `LosslessAPI`, and `server/downloads/README.md` documents the coupling boundary for future upstream merges.
- Verified with Dockerized server-download tests, production image build, and a disposable production container responding from `/api/downloads` and `/`.
