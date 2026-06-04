# TODO 04: Atomic Album Download And Publication

Goal: make album downloads all-or-nothing by staging every track first, then publishing the complete album with rollback-safe filesystem operations.

Only add the most strictly necessary tests needed to prove the product.

## Scope

- [x] Create a per-job album staging directory under the temp root.
- [x] Download and finalize every album track into staging before touching the final album directory.
- [x] Fail the whole album when any track fails.
- [x] Never publish partial albums.
- [x] Publish the complete staged album through hidden transient directories.

## Album Staging

- [x] Resolve album metadata and ordered tracks through `resolveAlbum(albumId)`.
- [x] Build the final album relative path once from normalized album metadata.
- [x] Create staging path under `TEMP_DIR`.
- [x] Download tracks one at a time or with bounded concurrency according to worker policy.
- [x] Place staged tracks using final names, including disc layout when needed.
- [x] Download `cover.jpg` into staging when available.
- [x] Add optional playlist sidecars only after all tracks succeed.
- [x] If any track fails, delete staging and mark the album failed.
- [x] If cancellation is requested, stop pending tracks and remove staging where possible.

## Publication

- [x] Acquire the media-library publish lock before mutating the final library tree.
- [x] Copy staging to `.Album.publishing-<jobId>-<suffix>` under the target artist directory.
- [x] If a final album directory exists, rename it to `.Album.backup-<jobId>-<suffix>`.
- [x] Rename the publishing directory to the final album directory.
- [x] Remove backup after successful publication.
- [x] On failure, restore backup to the final album path.
- [x] On failure, remove publishing and backup transient directories after rollback.
- [x] Release the publish lock in a `finally` path.

## Existing Album Conflict Policy

- [x] Define whether a complete existing album can be skipped before staging.
- [x] If skipping is allowed, verify every expected track is present and valid.
- [x] If overwrite is requested, retain rollback support with the backup directory.
- [x] If an existing album is incomplete or invalid, treat it as overwrite-needed rather than merging into it.

## Progress

- [x] Track per-album job progress as total tracks, completed tracks, current track, failed track, and publication phase.
- [x] Track per-track progress inside the album job.
- [x] Report `processing` while staging tracks.
- [x] Report a distinct publication phase before final completion.
- [x] Mark the job `completed` only after final album directory publication succeeds.

## Acceptance Criteria

- [x] No final album directory appears until all tracks have staged successfully.
- [x] One failed track fails the album and removes staging.
- [x] Existing album rollback works if publish fails after backup creation.
- [x] Published albums contain all expected tracks with final metadata and cover art when available.
- [x] Cancellation during staging leaves no final album directory.
- [x] Cancellation during publication leaves either the previous album or the new complete album, never a mixed directory.

## Implementation Notes

- Implemented in `server/downloads/album-pipeline.js`.
- The album pipeline uses the track pipeline with the album staging root as its temporary publication root.
- A process-local publish lock is included; Redis/process-wide lock orchestration remains part of TODO 05.
- Queue worker scheduling and Redis-backed progress persistence remain part of TODO 05.
