# Self-host integration contract

This fork intentionally stays close to upstream Monochrome: the `upstream-rebase`
branch should remain **current upstream + one squashed self-host commit**.

The self-host changes are small, but several of them sit on browser/provider
boundaries where an upstream merge can be syntactically clean and still break
the deployment. Treat the rules below as invariants, not optional preferences.

## Why this file exists

The self-host deployment differs from the public Monochrome deployment in a few
important ways:

- the browser is served from a private origin such as `http://server:5001`;
- browser calls to `tracks.monochrome.st` therefore need a same-origin proxy;
- server-side downloads run in `monochrome-server` and survive browser closure;
- download administration lives on a standalone page, not in the upstream app;
- Tracks/Rythm entity IDs can be opened directly after a hard reload, when
  in-memory provider caches are empty;
- Tracks artwork can be an absolute URL and must not be reformatted as a TIDAL
  image identifier.

Several regressions seen during development came from violating exactly these
boundaries while the application still built successfully.

## Required invariants

### 1. Browser Tracks traffic stays same-origin

`js/tracks-api.js` is the browser source of truth.

- Official Monochrome hosts may use `https://tracks.monochrome.st` directly.
- Self-hosted browser origins must use `/api/provider/tracks`.
- nginx must keep the `/api/provider/tracks/` proxy.
- Browser source files must not introduce new hard-coded
  `https://tracks.monochrome.st` calls.

Large audio responses are proxied directly by nginx. Do not route them through
the Bun download API unless there is a deliberate architecture change.

### 2. Tracks artwork remains a resolved URL

Tracks can return artwork such as:

```
https://tracks.monochrome.st/proxy/mi/...jpg
```

On self-host this becomes:

```
/api/provider/tracks/proxy/mi/...jpg
```

A leading-slash URL is already resolved. It must pass through `getCoverUrl`
and `getArtistPictureUrl` unchanged.

The corresponding `srcset` helpers must return an empty srcset for these
resolved URLs. Otherwise the browser can choose a generated TIDAL URL such as:

```
https://resources.tidal.com/images//api/provider/tracks/proxy/.../320x320.jpg
```

which returns 403.

### 3. Tracks snowflake IDs stay on the Tracks provider

Tracks/Rythm IDs are typically 17-20 digit snowflakes.

A direct route such as:

```
/artist/159504705419313152
/album/173961523931811840
```

must still be recognized as Tracks-native after a hard reload. Provider
selection must not depend only on in-memory caches populated by search.

Otherwise a Tracks artist/album can be sent into TIDAL endpoints and produce
404/400 fallback chains.

### 4. External playback IDs must resolve before direct Tracks streaming

A short legacy/TIDAL ID such as `553569385` is **not** a native Tracks
stream ID.

The playback sequence must be:

```
external ID -> original metadata -> Tracks title/artist/ISRC resolution
            -> native Tracks ID -> /api/provider/tracks/track/<Tracks-ID>
```

If Tracks cannot resolve the metadata, use the configured legacy playback
fallbacks or fail cleanly. Never manufacture:

```
/api/provider/tracks/track/<external-id>
```

Doing so makes the upstream Tracks service return 502 and the browser then
reports misleading secondary `MEDIA_ELEMENT_ERROR` / `NotSupportedError`
codec errors.

The same rule applies to download enrichment: an unresolved external ID must
not be converted into a direct Tracks URL.

### 5. Cached instance data cannot bypass the proxy

`js/storage.js` may read old `tracks.monochrome.st` instance entries from
localStorage. Rewrite those entries to the current browser Tracks base at read
time.

Do not require users to clear localStorage after an upstream update.

### 6. Frontend server-download code stays isolated

The upstream download implementation should not contain the self-host queue
client, polling loop, sidebar implementation, or server-progress renderer.

Those live in:

```
js/selfhost/downloads.js
```

`js/downloads.js` should contain only the small bridge boundary:

- one import of `createSelfHostDownloadBridge`;
- one adapter object exposing the upstream notification helpers;
- one `tryQueueTrack(...)` decision;
- one `tryQueueAlbum(...)` decision.

If upstream changes its download UI, adapt that small bridge. Do not move the
self-host implementation back into `js/downloads.js`.

The invariant guard intentionally fails if server API/polling/sidebar
implementation starts leaking back into the upstream module.

### 7. Download administration remains isolated

The self-host download UI lives at:

```
/downloads-admin
```

It is served by `monochrome-server` and proxied by nginx.

The upstream frontend should only contain a small self-host-only sidebar link.
Do not move the admin dashboard into the upstream router or add a persistent
floating overlay.

Required backend routes include:

```
/api/downloads
/api/downloads/reset
/downloads-admin
```

### 8. Runtime fallback images must exist in the production image

Upstream markup uses `images/monochrome_logo.svg` as an image fallback.
The current Vite build does not copy the repository-root `images/` directory
into `dist`, so the Docker build explicitly copies it.

If upstream changes its asset pipeline, this workaround may become unnecessary,
but do not remove it until the built image demonstrably contains the fallback
asset.

## Automated guard

Run:

```bash
bun run check:selfhost
```

The guard checks the critical implementation boundaries above and exits non-zero
when one is lost.

It intentionally checks both:

- searchable `SELF-HOST INVARIANT` comments, so conflict resolution retains
  the rationale; and
- behavior-critical source snippets/routes, so preserving a comment while
  deleting the implementation does not pass.

The guard is also run by the fork CI on `main` and pull requests. It is **not**
run automatically on every `upstream-rebase` push, to avoid notification spam
during iterative work.

## Regression tests that must remain

The self-host browser tests cover, among other things:

- rewriting Tracks artwork through the active client base;
- recognizing Tracks snowflake IDs without cache context;
- keeping Tracks artists out of TIDAL similar-artist calls;
- passing `/api/provider/tracks/proxy/...` artwork through unchanged;
- returning no TIDAL srcset for resolved proxy artwork.

The server tests cover the durable download queue, restart recovery, staged
album reuse, reset/cleanup behavior, and transfer progress.

Do not delete a failing self-host regression test just because upstream changed.
First determine whether upstream has genuinely replaced the workaround with an
equivalent behavior.

## Upstream rebase procedure

For every upstream refresh:

1. Update the temporary branch/base to the desired upstream commit.
2. Reapply/rebase the single self-host customization commit.
3. Resolve conflicts in favor of **upstream structure plus these invariants**,
   not mechanically in favor of either side.
4. Run:

   ```bash
   bun run check:selfhost
   ```

5. Run the targeted self-host tests when the test environment is available:

   ```bash
   bunx vitest run --config=vitest.server.config.ts
   HEADLESS=true bunx vitest run --config=vite.config.ts \
     js/tests/tracks-api.test.js js/tests/music-api-tracks.test.js
   ```

6. Build the production frontend and backend images.
7. Smoke-test at least:
   - search artwork;
   - a Tracks-native album opened directly by URL;
   - a Tracks-native artist opened directly by URL;
   - playback;
   - one server-side download;
   - `/downloads-admin`;
   - queue restart/recovery.
8. Only then force-update the squashed `upstream-rebase` branch.

## Conflict-resolution rule

When upstream changes one of these files, do not ask merely:

> "Which version is newer?"

Ask:

> "Does upstream now provide the same self-host guarantee?"

If yes, remove the redundant workaround and update the guard/test accordingly.
If no, adapt the self-host integration to the new upstream structure while
preserving the invariant.

Sensitive files currently include:

```
js/tracks-api.js
js/music-api.js
js/api.js
js/storage.js
js/downloads.js
js/selfhost/downloads.js
nginx.conf
docker/Dockerfile
server/app.js
server/downloads/*
functions/api/downloads/*
```
