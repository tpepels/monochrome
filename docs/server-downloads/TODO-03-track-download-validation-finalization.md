# TODO 03: Track Download, Validation, Metadata, And Finalization

Goal: move single-track download execution to the server with temp-first writes, integrity checks, metadata finalization, and safe publication into the music library.

Only add the most strictly necessary tests needed to prove the product.

## Scope

- [x] Download to temp files first, never directly to the library.
- [x] Support all manifest forms described by the resolver adapter.
- [x] Fetch CDN/audio URLs with browser-like headers.
- [x] Validate the file before and after metadata embedding.
- [x] Publish using safe conflict handling.

## Download Inputs

- [x] Support direct stream URLs.
- [x] Support base64-encoded manifests.
- [x] Support JSON manifests shaped like `{ urls }`.
- [x] Support DASH MPD segment manifests.
- [x] Reuse or server-port the MPD parsing behavior from `js/dash-downloader.ts`.
- [x] Classify CDN failures separately from resolver failures.
- [x] Retry individual segment downloads only where doing so cannot mask a partial/corrupt final file.

## Preview Rejection

- [x] Reject `assetPresentation`, `trackPresentation`, or equivalent `PREVIEW` responses immediately.
- [x] Add a validation failure category for preview-only responses.
- [x] Add duration checks that catch 30-second previews even when presentation flags are missing.

## Temp Paths

- [x] Use temp root from `TEMP_DIR` or `/tmp/monochrome-downloads`.
- [x] Create per-job temp directories.
- [x] Write stream data to a temp file under the job directory.
- [x] Never expose temp files as completed downloads.
- [x] Delete temp files after skip, failure, cancellation, or successful finalization.

## Validation

- [x] Reject empty files.
- [x] Detect container from magic bytes before falling back to quality defaults.
- [x] Validate expected container extension.
- [x] Validate duration with `ffprobe` when available.
- [x] Add decode fallback when `ffprobe` is unavailable or inconclusive.
- [x] Compare resolved duration to file duration using a documented tolerance.
- [x] After metadata embedding, re-check file integrity.
- [x] Do not require byte size to match after metadata embedding because metadata changes file size.

## Metadata

- [x] Embed track title, artist, album, album artist, disc number, track number, release date, ISRC, and cover when available.
- [x] Prefer existing metadata helpers where they can run server-side.
- [x] Add a clean server-side fallback path if browser-only metadata code cannot be reused.
- [x] Ensure metadata errors fail the job unless the final file can still be proven valid and policy explicitly allows best-effort metadata.

## Final Paths

- [x] Use final root from `DOWNLOAD_DIR` or configured music library path.
- [x] Build safe relative paths as `Artist/Album/01 - Track Title.ext`.
- [x] Sanitize path components using existing filename/path semantics where possible.
- [x] Prevent path traversal after sanitization.
- [x] Resolve conflicts with `overwrite_if_different` by default.
- [x] If the existing final file is identical and valid, skip publication and delete temp.
- [x] If finalizing, move temp to final with `rename`.
- [x] If `rename` fails with `EXDEV`, fallback to `copyFile` then `unlink`.

## Acceptance Criteria

- [x] A valid track downloads to temp, validates, embeds metadata, and appears at the final library path.
- [x] Preview-only tracks fail before final publication.
- [x] Corrupt, empty, wrong-container, and wrong-duration files fail.
- [x] Existing identical valid files are skipped without rewriting.
- [x] Cross-device finalization works through the `EXDEV` fallback.
- [x] Failed and cancelled jobs leave no temp file behind.

## Implementation Notes

- Implemented in `server/downloads/track-pipeline.js`.
- The default metadata path uses server-side `ffmpeg` when available; tests inject a metadata embedder to keep validation deterministic.
- Duration validation uses `ffprobe`, then `ffmpeg` decode output, then a WAV parser fallback for environments without media binaries.
- Queue worker orchestration remains part of TODO 05; this TODO provides the concrete single-track execution primitive.
