# Server Downloads

This module contains the self-hosted download queue and filesystem pipeline added on top of upstream Monochrome.

## Queue lifecycle

- Browser requests are submitted to `/api/downloads`.
- Queue state is persisted to `${TEMP_DIR}/download-queue-state.json`.
- On backend startup, unfinished `processing` or `paused` jobs are restored as `queued` and scheduled again.
- Completed, failed, and cancelled jobs remain terminal.
- Repeated requests for the same active item and quality reuse the existing job instead of creating another active duplicate.

The temp directory must be persistent across container restarts for queue recovery to work. The Docker configurations mount it as a volume/bind mount.

## Standalone administration UI

Self-hosted deployments expose a small download dashboard at:

```
/downloads-admin
```

The page is served by `monochrome-server` and proxied by nginx. It does not import or modify Monochrome frontend code or styles. It shows queue counts, worker state, per-job progress, current track/transfer information, last-progress age, cancel/retry controls, and queue reset/cleanup actions.

## Resetting the queue

The backend exposes a safe reset operation:

```bash
curl -X POST http://localhost:5001/api/downloads/reset
```

This aborts active downloads, clears queued/history state, and persists an empty queue.

To also remove unfinished Monochrome temp and staging data:

```bash
curl -X POST 'http://localhost:5001/api/downloads/reset?cleanup=true'
```

Cleanup is limited to Monochrome transient paths such as `TEMP_DIR`, `.monochrome-staging`, and interrupted publication/backup directories. Normal completed artist/album directories are not removed.

## Restart recovery

Standalone track downloads are temp-first. An interrupted partial track file is not trusted and is overwritten when the job restarts.

Album downloads additionally stage completed tracks under:

```
<DOWNLOAD_DIR>/.monochrome-staging/<jobId>/staging/
```

On restart, completed staged audio files are validated before reuse. Valid files are kept and skipped; invalid or incomplete staged files are removed and downloaded again. The album is only published into its final library directory after every track and sidecar step succeeds.

## Resolution and output

- Server resolution uses the upstream Tracks client directly.
- Browser playback uses the nginx same-origin Tracks proxy.
- Audio downloads are validated before publication.
- Individual audio transfers time out instead of occupying a worker indefinitely.
- Album publication remains atomic: partial albums are not exposed at the final library path.
