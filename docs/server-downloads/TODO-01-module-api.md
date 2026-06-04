# TODO 01: Isolated Server Download Module And API

Goal: add an isolated server-side download feature area without moving Monochrome's existing catalog, search, or stream resolution code into the new module.

## Scope

- [x] Create a standalone server download module, proposed path: `server/downloads/`.
- [x] Keep integration with existing Monochrome code thin and explicit.
- [x] Make server-side downloads the default path for new download requests.
- [x] Do not implement quality downgrade.
- [x] Ensure album jobs are all-or-nothing from the first API design pass.

## Module Shape

- [x] Add an entry module that wires routes, queue, workers, config, and shutdown cleanup.
- [x] Add a `config` layer for:
  - [x] `TEMP_DIR`, defaulting to `/tmp/monochrome-downloads`.
  - [x] `DOWNLOAD_DIR`, defaulting to the configured music library path when present.
  - [x] Worker concurrency.
  - [x] Redis URL or equivalent queue backend config.
  - [x] Duplicate-check setting before queueing.
- [x] Add typed job models for track and album downloads.
- [x] Add typed error categories for validation, resolver, CDN, filesystem, cancellation, and retryable queue errors.
- [x] Avoid edits to core resolver/search/catalog files except for a small export if no existing API can be reused.

## Public API

- [x] Add `POST /api/downloads`.
- [x] Accept body `{ type: "track" | "album", id, quality, forceOverwrite?, musicBrainzReleaseId? }`.
- [x] Validate type, id, quality, and optional flags before queueing.
- [x] Return `{ success: true, jobId }` after queue insertion.
- [x] Add `GET /api/downloads`.
- [x] Return queue snapshot, active workers, configured concurrency, and backend type.
- [x] Add `GET /api/downloads/:jobId`.
- [x] Return status, progress, track progress, error, and failure code.
- [x] Add `POST /api/downloads/:jobId/cancel`.
- [x] Cancel queued jobs immediately.
- [x] Signal processing jobs to stop and clean staging where possible.

## Integration Steps

- [x] Locate the current server/runtime entrypoint for `functions/` or the deployment target used by this fork.
- [x] Decide whether the server download module runs in the existing functions runtime or a separate Node server process.
- [x] If using a separate process, document the run command and env vars.
- [x] Wire the web frontend's existing single-track download actions to `POST /api/downloads` when server downloads are enabled.
- [x] Wire the web frontend's existing album and bulk album download actions to `POST /api/downloads` with `type: "album"`.
- [x] Keep the current browser download path behind a compatibility setting only.
- [x] Add web frontend response handling for queued jobs, cancellation, failure messages, and status polling.
- [x] Show queued, processing, completed, failed, and cancelled server-side jobs in the existing download notification/progress UI or a dedicated queue panel.
- [x] Preserve the existing browser-only download flow when server downloads are disabled or unsupported.
- [x] Do not update the Android app for this feature set.

## Acceptance Criteria

- [x] A track or album can be queued through `POST /api/downloads`.
- [x] Queue state can be inspected through `GET /api/downloads` and `GET /api/downloads/:jobId`.
- [x] Cancelling a queued job marks it `cancelled`.
- [x] The web frontend queues track and album downloads through the server API by default.
- [x] The web frontend can display server job progress and cancel server jobs.
- [x] Android behavior remains unchanged.
- [x] The new module can be disabled or isolated without breaking existing catalog/search/playback behavior.
- [x] No resolver, catalog, or search logic has been copied into `server/downloads/`.

## Implementation Notes

- Implemented in the existing Cloudflare Pages `functions/` runtime.
- Queue backend is memory for now. Redis-backed execution is still covered by TODO 05.
- Track resolver and single-track download pipeline implementations now exist. Queue worker orchestration is still covered by TODO 05.
