# TODO 05: Queue, Maintenance Safety, And Tests

Goal: provide reliable job state, worker execution, library maintenance safety, startup cleanup, and regression tests for the server download module.

Only add the most strictly necessary tests needed to prove the product.

## Queue And State

- [x] Define statuses: `queued`, `processing`, `paused`, `completed`, `failed`, `cancelled`.
- [x] Define track job state with id, quality, overwrite policy, progress, error, failure code, retryability, and timestamps.
- [x] Define album job state with album metadata, ordered track progress, publication phase, error, failure code, retryability, and timestamps.
- [x] Implement Redis-backed queue when Redis is configured and reachable.
- [x] Implement memory fallback when Redis is unavailable.
- [x] Make fallback visible in `GET /api/downloads`.
- [x] Add configurable worker concurrency.
- [x] Ensure album policy defaults to no partial publish and no quality downgrade.
- [x] Add optional duplicate check against the local library before queueing.

## Cancellation, Pause, And Retry

- [x] Cancel queued jobs without starting work.
- [x] Signal processing jobs with `AbortController` or the server equivalent.
- [x] Clean per-job temp/staging paths on cancellation.
- [x] Preserve enough failure metadata to decide whether a failed album is retryable.
- [x] Only mark failed album jobs retryable for retryable failure categories.
- [x] Ensure retry creates a new clean staging path.
- [x] Add paused status support only if worker scheduling can actually honor it; otherwise keep the status reserved and undocumented in the public UI.

## Maintenance Lock

- [x] Add a media-library publish/maintenance lock.
- [x] Require the lock for album publication.
- [x] Require the lock for repair, dedupe, cleanup, and other library-mutating maintenance jobs.
- [x] Make lock acquisition timeout configurable.
- [x] Ensure lock release in all success, failure, and cancellation paths.
- [x] In Redis mode, use a lock that is safe across processes.
- [x] In memory mode, document that the lock is process-local.

## Startup And Manual Sweeps

- [x] Sweep stale temp album staging directories on startup.
- [x] Sweep stale `.publishing-*` album dirs on startup and through a manual maintenance action.
- [x] Sweep stale `.backup-*` album dirs on startup and through a manual maintenance action.
- [x] Skip active job IDs.
- [x] Skip too-fresh transient directories to avoid racing active publication.
- [x] Log all sweep actions and skipped paths.
- [x] Add dry-run support for manual sweeps.

## Tests To Add Or Port

- [x] Temp-to-final writes to temp first.
- [x] `rename` success path.
- [x] `EXDEV` copy/unlink fallback.
- [x] Conflict handling: overwrite, rename, skip, and overwrite-if-different.
- [x] Temp deletion on skip.
- [x] Temp deletion on failure.
- [x] No final album directory appears until every track succeeds.
- [x] Any failed track fails the album and removes staging.
- [x] Existing album rollback works if publish fails.
- [x] Stale staging, publishing, and backup dirs are swept.
- [x] Preview manifests/assets are rejected.
- [x] Direct URL manifests are parsed and downloaded.
- [x] JSON `{ urls }` manifests are parsed and downloaded.
- [x] DASH segment manifests are parsed and downloaded.
- [x] CDN segment failures are classified correctly.
- [x] Duration/integrity validation catches 30-second previews.
- [x] Duration/integrity validation catches corrupt files.
- [x] Album progress updates per track.
- [x] Failed album retryability follows error category.
- [x] No quality fallback occurs by default.
- [x] Redis unavailable falls back to memory.

## Acceptance Criteria

- [x] Queue behavior is deterministic in memory mode.
- [x] Redis mode and memory fallback expose the same public job shape.
- [x] Library mutation cannot run concurrently with album publication.
- [x] Startup cleanup removes stale transient paths without touching active jobs.
- [x] Tests cover the failure modes that could otherwise publish partial or corrupt music.

## Implementation Notes

- Implemented worker/state orchestration in `server/downloads/queue.js`.
- Redis mode uses the `redis` package for job state/order and `RedisMaintenanceLock` for cross-process library mutation locking.
- Memory fallback remains deterministic and exposes fallback details from `GET /api/downloads`; its maintenance lock is process-local.
- Manual transient cleanup is exposed through `POST /api/downloads/maintenance/sweep`, defaulting to dry-run unless `dryRun: false` is sent.
- Focused regression coverage lives in `server/downloads/queue-maintenance.test.js` plus the TODO 03 and TODO 04 pipeline tests.
