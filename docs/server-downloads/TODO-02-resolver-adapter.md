# TODO 02: Resolver Adapter

Goal: expose Monochrome's existing stream and album resolution behavior to the server download module without duplicating provider logic.

Only add the most strictly necessary tests needed to prove the product.

## Scope

- [x] Build a resolver adapter consumed by `server/downloads/`.
- [x] Preserve Monochrome's current provider/download flow by delegating to `LosslessAPI`.
- [x] Reuse existing proxy behavior from `js/proxy-utils.js` or the equivalent server-safe export.
- [x] Keep resolver changes additive and limited to exports or wrapper functions.

## Adapter API

- [x] Implement `resolveTrackDownload(trackId, quality)`.
- [x] Return:
  - [x] Stream URL when available.
  - [x] Raw manifest.
  - [x] Segment list or enough data to derive one.
  - [x] Track metadata.
  - [x] Duration.
  - [x] Cover identifier or cover URL.
  - [x] ISRC when available.
  - [x] Presentation flags such as `assetPresentation`, `trackPresentation`, or equivalent preview indicators.
- [x] Implement `resolveAlbum(albumId)`.
- [x] Return:
  - [x] Complete album metadata.
  - [x] Ordered tracks.
  - [x] Disc and track numbering needed for final path construction.
  - [x] Cover identifier or cover URL.

## Existing Code To Reuse

- [x] Review `js/api.js` for track lookup, manifest extraction, provider fallback, and proxy wrapping.
- [x] Review `js/music-api.js` for public client-facing API composition.
- [x] Review `js/proxy-utils.js` for CDN/proxy behavior.
- [x] Review `js/dash-downloader.ts` for DASH MPD parsing rules that should be shared or ported server-side.
- [x] Review `js/utils.js` for filename, artist, title, cover, and extension helpers.

## Implementation Steps

- [x] Identify the smallest resolver function or class method that already returns track metadata and playback info.
- [x] Export that function for server use if possible.
- [x] If browser-only APIs are mixed into resolver code, add a server-safe adapter boundary instead of importing browser modules directly.
- [x] Normalize all provider responses into one internal `ResolvedTrackDownload` shape.
- [x] Normalize album responses into one internal `ResolvedAlbumDownload` shape.
- [x] Preserve provider error details for queue failure classification.
- [x] Add preview detection helpers that inspect all known presentation fields.
- [x] Ensure preview detection happens before any CDN/audio download starts.

## Acceptance Criteria

- [x] Track resolution returns enough information for direct URL, JSON URL list, base64 manifest, and DASH MPD downloads.
- [x] Album resolution returns stable track order matching Monochrome's album view.
- [x] Provider selection and fallback behavior matches current playback/download resolution behavior because it is sourced from `LosslessAPI`.
- [x] No quality fallback is introduced by the adapter.
- [x] Preview responses can be rejected deterministically from adapter output.

## Implementation Notes

- Implemented in `server/downloads/resolver-adapter.js`.
- `server/downloads/index.js` exports the adapter for later queue worker and download pipeline use.
- The adapter delegates to `js/api.js` through `LosslessAPI.enrichTrack()` and `LosslessAPI.getAlbum()` instead of copying provider-specific request logic.
- Server instance lists can be overridden with `DOWNLOAD_API_INSTANCES`, `DOWNLOAD_STREAMING_INSTANCES`, and `DOWNLOAD_QOBUZ_INSTANCES`.
