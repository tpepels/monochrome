import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const failures = [];

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function requireFile(relativePath) {
    if (!fs.existsSync(path.join(ROOT, relativePath))) {
        failures.push(`${relativePath}: required self-host file is missing`);
        return false;
    }
    return true;
}

function requireText(relativePath, source, needle, reason) {
    if (!source.includes(needle)) {
        failures.push(`${relativePath}: ${reason}\n  missing: ${needle}`);
    }
}

function walk(dir) {
    const absolute = path.join(ROOT, dir);
    if (!fs.existsSync(absolute)) return [];

    const results = [];
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        const relative = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walk(relative));
        } else {
            results.push(relative);
        }
    }
    return results;
}

const tracksPath = 'js/tracks-api.js';
const musicPath = 'js/music-api.js';
const storagePath = 'js/storage.js';
const downloadsPath = 'js/downloads.js';
const apiPath = 'js/api.js';
const nginxPath = 'nginx.conf';
const dockerPath = 'docker/Dockerfile';
const appPath = 'server/app.js';
const adminPath = 'server/downloads/admin-ui.js';
const contractPath = 'SELF_HOSTING.md';
const selfHostDownloadsPath = 'js/selfhost/downloads.js';

for (const file of [
    tracksPath,
    musicPath,
    storagePath,
    downloadsPath,
    apiPath,
    nginxPath,
    dockerPath,
    appPath,
    adminPath,
    contractPath,
    selfHostDownloadsPath,
]) {
    requireFile(file);
}

if (failures.length === 0) {
    const tracks = read(tracksPath);
    const music = read(musicPath);
    const storage = read(storagePath);
    const downloads = read(downloadsPath);
    const api = read(apiPath);
    const nginx = read(nginxPath);
    const dockerfile = read(dockerPath);
    const app = read(appPath);
    const admin = read(adminPath);
    const contract = read(contractPath);
    const selfHostDownloads = read(selfHostDownloadsPath);

    // Browser Tracks traffic must stay same-origin when self-hosted.
    requireText(
        tracksPath,
        tracks,
        "return isOfficialHost ? TRACKS_API_BASE_URL : '/api/provider/tracks';",
        'self-host browser Tracks base no longer points at the nginx proxy'
    );
    requireText(
        tracksPath,
        tracks,
        'export function getTracksClientAssetUrl(value)',
        'Tracks artwork normalizer was removed'
    );
    requireText(
        tracksPath,
        tracks,
        'export function isTracksSnowflake(value)',
        'provider-independent Tracks snowflake recognition was removed'
    );

    // Resolved proxy paths must never be interpreted as TIDAL artwork IDs.
    requireText(
        musicPath,
        music,
        String.raw`/^(?:https?:|blob:|data:|assets\/|images\/|\/)/`,
        'resolved artwork detection no longer accepts leading-slash same-origin paths'
    );
    requireText(
        musicPath,
        music,
        'if (!id || isResolvedArtworkReference(id))',
        'cover srcset no longer suppresses generated TIDAL candidates for resolved artwork'
    );
    requireText(
        musicPath,
        music,
        'if (isTracksSnowflake(id)) return true;',
        'hard-reload Tracks provider recognition no longer treats snowflake IDs as Tracks-native'
    );
    requireText(
        musicPath,
        music,
        'return this.getAPI().getStreamUrl(cleanId, quality, { ...options, track });',
        'external playback no longer falls back through the legacy provider after Tracks resolution'
    );
    if (music.includes('return this.tracksStreamerAPI.getStreamUrl(cleanId, quality, { track });')) {
        failures.push(
            `${musicPath}: unsafe external-ID fallback to direct Tracks stream was reintroduced`
        );
    }
    if (api.includes('streamResult = tracksStreamerAPI.getStreamUrl(cleanId')) {
        failures.push(
            `${apiPath}: unsafe LosslessAPI/download fallback to direct Tracks stream was reintroduced`
        );
    }
    requireText(
        apiPath,
        api,
        'fallback = await this.getUnifiedPlaybackStreamUrl(id, quality, { ...options, track });',
        'external playback no longer tries the configured legacy fallback after Tracks resolution'
    );
    requireText(
        apiPath,
        api,
        String.raw`/^(?:https?:|blob:|data:|assets\/|images\/|\/)/`,
        'legacy artwork helper no longer accepts same-origin paths'
    );

    // Stale localStorage instance data must not bypass the self-host proxy.
    requireText(
        storagePath,
        storage,
        'normalized.url = tracksClientBaseUrl;',
        'cached tracks.monochrome.st instances are no longer rewritten at read time'
    );

    // Self-host UI/admin integration should stay intentionally tiny and isolated.
    requireText(
        downloadsPath,
        downloads,
        "import { createSelfHostDownloadBridge } from './selfhost/downloads.js';",
        'upstream downloads.js no longer imports the isolated self-host bridge'
    );
    requireText(
        downloadsPath,
        downloads,
        'const selfHostDownloads = createSelfHostDownloadBridge({',
        'upstream downloads.js no longer exposes the tiny UI adapter boundary'
    );
    requireText(
        downloadsPath,
        downloads,
        'selfHostDownloads.tryQueueTrack(track, quality, api)',
        'single-track server download hook was removed'
    );
    requireText(
        downloadsPath,
        downloads,
        'selfHostDownloads.tryQueueAlbum(album, tracks, quality)',
        'album server download hook was removed'
    );
    for (const forbidden of [
        "const SERVER_DOWNLOAD_API = '/api/downloads'",
        'function pollServerDownloadJob',
        'function ensureServerDownloadsSidebarLink',
        'function updateServerBulkDownloadProgress',
    ]) {
        if (downloads.includes(forbidden)) {
            failures.push(
                `${downloadsPath}: self-host implementation leaked back into the upstream download module: ${forbidden}`
            );
        }
    }
    requireText(
        selfHostDownloadsPath,
        selfHostDownloads,
        "item.id = 'sidebar-nav-downloads-admin';",
        'self-host Downloads sidebar entry was removed from the isolated module'
    );
    requireText(
        selfHostDownloadsPath,
        selfHostDownloads,
        'href="/downloads-admin"',
        'Downloads sidebar entry no longer points at the standalone admin page'
    );
    requireText(
        selfHostDownloadsPath,
        selfHostDownloads,
        "const SERVER_DOWNLOAD_API = '/api/downloads';",
        'isolated self-host module no longer owns the download API client'
    );
    requireText(
        appPath,
        app,
        "pathname === '/downloads-admin'",
        'backend no longer serves the standalone download admin page'
    );
    requireText(
        appPath,
        app,
        "url.pathname === '/api/downloads/reset'",
        'download reset API route was removed'
    );
    requireText(adminPath, admin, 'Server downloads', 'standalone download admin UI no longer looks intact');
    requireText(
        contractPath,
        contract,
        'bun run check:selfhost',
        'self-host rebase contract no longer documents the invariant guard'
    );

    // nginx owns the browser proxy boundary; do not move large audio through Bun accidentally.
    requireText(
        nginxPath,
        nginx,
        'location ^~ /api/provider/tracks/',
        'same-origin Tracks proxy route is missing'
    );
    requireText(
        nginxPath,
        nginx,
        'proxy_pass https://tracks.monochrome.st/;',
        'Tracks proxy no longer targets the upstream service directly'
    );
    requireText(nginxPath, nginx, 'location ^~ /api/downloads', 'download API proxy route is missing');
    requireText(nginxPath, nginx, 'location ^~ /downloads-admin', 'download admin proxy route is missing');

    // Vite currently does not copy the root images directory used by upstream fallback markup.
    requireText(
        dockerPath,
        dockerfile,
        'cp -r images dist/images',
        'production build no longer copies upstream runtime fallback images'
    );

    // Detect new direct browser calls to the public Tracks host. The one source
    // of truth is TRACKS_API_BASE_URL in js/tracks-api.js; tests are excluded.
    const browserFiles = [...walk('js'), ...walk('src')].filter((file) => {
        if (!/\.(?:js|ts|tsx)$/.test(file)) return false;
        if (file === tracksPath) return false;
        if (file.includes('/tests/')) return false;
        if (/\.test\.(?:js|ts|tsx)$/.test(file)) return false;
        return true;
    });

    for (const file of browserFiles) {
        const source = read(file);
        if (/['"`]https:\/\/tracks\.monochrome\.st/.test(source)) {
            failures.push(
                `${file}: direct browser string literal for https://tracks.monochrome.st detected; use getTracksClientBaseUrl()/getTracksClientAssetUrl() instead`
            );
        }
    }

    // Protect the rationale as well as the implementation. These comments are
    // intentionally searchable during upstream conflict resolution.
    for (const file of [
        tracksPath,
        musicPath,
        apiPath,
        storagePath,
        downloadsPath,
        selfHostDownloadsPath,
        nginxPath,
        dockerPath,
    ]) {
        const source = read(file);
        if (!source.includes('SELF-HOST INVARIANT')) {
            failures.push(`${file}: SELF-HOST INVARIANT marker was removed`);
        }
    }
}

if (failures.length > 0) {
    console.error('\nSelf-host invariant check FAILED:\n');
    for (const failure of failures) {
        console.error(`- ${failure}`);
    }
    console.error(
        '\nDo not force-update the self-host branch after an upstream rebase until these are reconciled. See SELF_HOSTING.md.\n'
    );
    process.exit(1);
}

console.log('Self-host invariants: OK');
