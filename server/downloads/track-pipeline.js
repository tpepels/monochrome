import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { getDownloadsConfig } from './config.js';
import { createResolverAdapter, inspectManifest } from './resolver-adapter.js';

const execFileAsync = promisify(execFile);

const BROWSER_LIKE_HEADERS = Object.freeze({
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'user-agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
});

const DURATION_TOLERANCE_SECONDS = 8;
const PREVIEW_DURATION_SECONDS = 35;

function pipelineError(message, failureCode, details = {}) {
    const error = new Error(message);
    error.failureCode = failureCode;
    Object.assign(error, details);
    return error;
}

function normalizeQuality(quality) {
    return String(quality || 'LOSSLESS').trim().toUpperCase();
}

function defaultExtensionForQuality(quality) {
    switch (normalizeQuality(quality)) {
        case 'HIGH':
        case 'LOW':
            return 'm4a';
        default:
            return 'flac';
    }
}

function sanitizePathComponent(value, fallback) {
    const sanitized = String(value || '')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+$/, '')
        .slice(0, 180);
    return sanitized || fallback;
}

function getArtistName(track) {
    if (track?.artist?.name) return track.artist.name;
    if (Array.isArray(track?.artists) && track.artists.length) {
        return track.artists.map((artist) => artist?.name).filter(Boolean).join(', ');
    }
    return 'Unknown Artist';
}

function getAlbumArtistName(track) {
    return track?.album?.artist?.name || track?.album?.artist || getArtistName(track);
}

function getTrackTitle(track) {
    if (!track?.title) return 'Unknown Title';
    return track.version ? `${track.title} (${track.version})` : track.title;
}

function getAlbumTitle(track) {
    return track?.album?.title || 'Unknown Album';
}

function getTrackNumber(track) {
    const value = Number.parseInt(String(track?.trackNumber || track?.number || 1), 10);
    return Number.isFinite(value) && value > 0 ? value : 1;
}

export function buildTrackRelativePath(track, extension) {
    const artist = sanitizePathComponent(getAlbumArtistName(track), 'Unknown Artist');
    const album = sanitizePathComponent(getAlbumTitle(track), 'Unknown Album');
    const trackNumber = String(getTrackNumber(track)).padStart(2, '0');
    const title = sanitizePathComponent(getTrackTitle(track), 'Unknown Title');
    return path.join(artist, album, `${trackNumber} - ${title}.${extension}`);
}

function assertSafeRelativePath(relativePath) {
    if (path.isAbsolute(relativePath)) {
        throw pipelineError('Final path must be relative', 'UNSAFE_FINAL_PATH');
    }

    const normalized = path.normalize(relativePath);
    if (normalized.startsWith('..') || normalized.includes(`${path.sep}..${path.sep}`)) {
        throw pipelineError('Final path escapes download root', 'UNSAFE_FINAL_PATH');
    }
    return normalized;
}

export function detectContainer(buffer, fallbackExtension = null) {
    if (!buffer || buffer.length < 4) return fallbackExtension;

    if (buffer.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
    if (buffer.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
    if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mp3';
    if (buffer.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE') {
        return 'wav';
    }
    if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a';

    return buffer.length < 4 ? fallbackExtension : null;
}

function parseWavDuration(buffer) {
    if (buffer.length < 44) return null;
    if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WAVE') {
        return null;
    }

    let offset = 12;
    let byteRate = null;
    let dataSize = null;

    while (offset + 8 <= buffer.length) {
        const chunkId = buffer.subarray(offset, offset + 4).toString('ascii');
        const chunkSize = buffer.readUInt32LE(offset + 4);
        const chunkStart = offset + 8;

        if (chunkId === 'fmt ' && chunkStart + 12 <= buffer.length) {
            byteRate = buffer.readUInt32LE(chunkStart + 8);
        } else if (chunkId === 'data') {
            dataSize = chunkSize;
            break;
        }

        offset = chunkStart + chunkSize + (chunkSize % 2);
    }

    if (!byteRate || !dataSize) return null;
    return dataSize / byteRate;
}

async function sha256(filePath, fsOps = fs) {
    const data = await fsOps.readFile(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
}

async function pathExists(filePath, fsOps = fs) {
    try {
        await fsOps.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function readHead(filePath, fsOps = fs, bytes = 64) {
    const handle = await fsOps.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

async function ffprobeDuration(filePath) {
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            filePath,
        ]);
        const parsed = Number.parseFloat(stdout.trim());
        return Number.isFinite(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

async function ffmpegDecodeDuration(filePath) {
    try {
        const { stderr } = await execFileAsync('ffmpeg', ['-v', 'info', '-i', filePath, '-f', 'null', '-']);
        const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (durationMatch) {
            return (
                Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number.parseFloat(durationMatch[3])
            );
        }

        const times = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
        const last = times[times.length - 1];
        if (last) {
            return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number.parseFloat(last[3]);
        }
    } catch {
        // ffmpeg is optional; fall back to container-specific parsing below.
    }

    return null;
}

export async function getAudioDuration(filePath, fsOps = fs) {
    const probed = await ffprobeDuration(filePath);
    if (probed != null) return probed;

    const decoded = await ffmpegDecodeDuration(filePath);
    if (decoded != null) return decoded;

    const buffer = await fsOps.readFile(filePath);
    return parseWavDuration(buffer);
}

export async function validateAudioFile(filePath, resolved, { fsOps = fs, requireDuration = true } = {}) {
    const stat = await fsOps.stat(filePath);
    if (!stat.size) {
        throw pipelineError('Downloaded file is empty', 'EMPTY_DOWNLOAD_FILE');
    }

    const fallbackExtension = defaultExtensionForQuality(resolved.quality);
    const extension = detectContainer(await readHead(filePath, fsOps), fallbackExtension);
    const allowed = new Set(['flac', 'mp3', 'm4a', 'mp4', 'wav', 'ogg']);
    if (!extension || !allowed.has(extension)) {
        throw pipelineError('Downloaded file container is not supported', 'UNSUPPORTED_AUDIO_CONTAINER', {
            extension,
        });
    }

    const expectedDuration = Number(resolved.duration);
    const duration = await getAudioDuration(filePath, fsOps);

    if (duration != null && Number.isFinite(expectedDuration) && expectedDuration > 0) {
        if (expectedDuration > PREVIEW_DURATION_SECONDS && duration <= PREVIEW_DURATION_SECONDS) {
            throw pipelineError('Downloaded file looks like a preview by duration', 'PREVIEW_DURATION_DETECTED', {
                duration,
                expectedDuration,
            });
        }

        if (Math.abs(duration - expectedDuration) > Math.max(DURATION_TOLERANCE_SECONDS, expectedDuration * 0.08)) {
            throw pipelineError('Downloaded file duration does not match resolved metadata', 'DURATION_MISMATCH', {
                duration,
                expectedDuration,
            });
        }
    } else if (requireDuration && Number.isFinite(expectedDuration) && expectedDuration > PREVIEW_DURATION_SECONDS) {
        throw pipelineError('Could not validate downloaded file duration', 'DURATION_VALIDATION_UNAVAILABLE', {
            expectedDuration,
        });
    }

    return {
        extension: extension === 'mp4' ? 'm4a' : extension,
        size: stat.size,
        duration,
    };
}

function resolveTemplate(template, segment, representationId) {
    return template
        .replace(/\$RepresentationID\$/g, representationId ?? '')
        .replace(/\$Number(?:%0([0-9]+)d)?\$/g, (_, width) => {
            const value = String(segment.number);
            return width ? value.padStart(Number.parseInt(width, 10), '0') : value;
        })
        .replace(/\$Time(?:%0([0-9]+)d)?\$/g, (_, width) => {
            const value = String(segment.time);
            return width ? value.padStart(Number.parseInt(width, 10), '0') : value;
        });
}

function absolutizeUrl(url, baseUrl) {
    try {
        return new URL(url, baseUrl || undefined).toString();
    } catch {
        return url;
    }
}

function getDashUrls(dash) {
    if (!dash?.media) return [];
    const urls = [];
    if (dash.initialization) {
        urls.push(absolutizeUrl(resolveTemplate(dash.initialization, { number: 0, time: 0 }, dash.representationId), dash.baseUrl));
    }

    for (const segment of dash.segments || []) {
        urls.push(absolutizeUrl(resolveTemplate(dash.media, segment, dash.representationId), dash.baseUrl));
    }
    return urls;
}

function resolveDownloadUrls(resolved) {
    if (resolved.streamUrl) return [resolved.streamUrl];

    const inspected = resolved.manifestDetails || inspectManifest(resolved.manifest);
    if (inspected.streamUrl) return [inspected.streamUrl];
    if (inspected.urls?.length) return inspected.urls;
    if (inspected.dash) return getDashUrls(inspected.dash);
    if (resolved.dash) return getDashUrls(resolved.dash);
    if (resolved.urls?.length) return resolved.urls;
    return [];
}

async function fetchAudioUrl(url, { fetchImpl = fetch, signal } = {}) {
    let response = await fetchImpl(url, {
        headers: BROWSER_LIKE_HEADERS,
        cache: 'no-store',
        signal,
    });

    if (!response.ok) {
        response = await fetchImpl(url, {
            headers: BROWSER_LIKE_HEADERS,
            cache: 'no-store',
            signal,
        });
    }

    if (!response.ok) {
        throw pipelineError(`CDN fetch failed: HTTP ${response.status}`, 'CDN_FETCH_FAILED', { status: response.status, url });
    }

    return Buffer.from(await response.arrayBuffer());
}

async function downloadToTempFile(resolved, tempFile, { fetchImpl = fetch, fsOps = fs, signal } = {}) {
    const urls = resolveDownloadUrls(resolved);
    if (!urls.length) {
        throw pipelineError('Resolved track has no downloadable URL or segment manifest', 'NO_DOWNLOAD_URL');
    }

    const chunks = [];
    for (const url of urls) {
        chunks.push(await fetchAudioUrl(url, { fetchImpl, signal }));
    }

    await fsOps.writeFile(tempFile, Buffer.concat(chunks));
}

async function decryptCencAudioFile(encryptedFile, outputFile, resolved, { fsOps = fs } = {}) {
    if (!resolved.decryptionKey) {
        throw pipelineError('Encrypted audio is missing a decryption key', 'AUDIO_DECRYPTION_KEY_REQUIRED');
    }

    const tempOutput = `${outputFile}.decrypted.flac`;
    try {
        await execFileAsync('ffmpeg', [
            '-y',
            '-decryption_key',
            String(resolved.decryptionKey),
            '-i',
            encryptedFile,
            '-c:a',
            'flac',
            tempOutput,
        ]);
        await fsOps.rename(tempOutput, outputFile);
    } catch (error) {
        await fsOps.rm(tempOutput, { force: true }).catch(() => {});
        throw pipelineError('Encrypted audio decryption failed', 'AUDIO_DECRYPTION_FAILED', {
            cause: error?.message || String(error),
        });
    }
}

function assertNotPreview(resolved) {
    const flags = resolved.presentationFlags || {};
    const values = [
        flags.assetPresentation,
        flags.trackPresentation,
        flags.presentation,
        resolved.assetPresentation,
        resolved.trackPresentation,
    ];

    if (resolved.isPreview || values.some((value) => String(value || '').toUpperCase() === 'PREVIEW')) {
        throw pipelineError('Preview-only streams are not downloadable', 'PREVIEW_STREAM_REJECTED');
    }
}

function buildMetadata(resolved) {
    const track = resolved.metadata || {};
    return {
        title: getTrackTitle(track),
        artist: getArtistName(track),
        album: getAlbumTitle(track),
        albumArtist: getAlbumArtistName(track),
        discNumber: track.volumeNumber || track.discNumber || 1,
        trackNumber: getTrackNumber(track),
        releaseDate: track.album?.releaseDate || track.releaseDate || track.streamStartDate?.split?.('T')?.[0] || null,
        isrc: resolved.isrc || track.isrc || null,
        coverUrl: resolved.coverUrl || null,
    };
}

async function defaultMetadataEmbedder(filePath, metadata, { fsOps = fs, resolved = {} } = {}) {
    const extension = detectContainer(await readHead(filePath, fsOps), defaultExtensionForQuality(resolved.quality));
    const tempOutput = `${filePath}.metadata.${extension || defaultExtensionForQuality(resolved.quality)}`;
    try {
        const args = ['-y', '-i', filePath, '-map', '0', '-c', 'copy'];
        for (const [key, value] of Object.entries(metadata)) {
            if (value == null || key === 'coverUrl') continue;
            args.push('-metadata', `${key}=${value}`);
        }
        args.push(tempOutput);
        await execFileAsync('ffmpeg', args);
        await fsOps.rename(tempOutput, filePath);
        return { embedded: true, method: 'ffmpeg' };
    } catch (error) {
        await fsOps.rm(tempOutput, { force: true }).catch(() => {});
        throw pipelineError('Metadata embedding failed', 'METADATA_EMBED_FAILED', {
            cause: error?.message || String(error),
        });
    }
}

async function publishTempFile(tempFile, finalFile, { fsOps = fs } = {}) {
    await fsOps.mkdir(path.dirname(finalFile), { recursive: true });
    try {
        await fsOps.rename(tempFile, finalFile);
        return { method: 'rename' };
    } catch (error) {
        if (error?.code !== 'EXDEV') throw error;
        await fsOps.copyFile(tempFile, finalFile);
        await fsOps.unlink(tempFile);
        return { method: 'copy-unlink' };
    }
}

async function finalizeTrack(tempFile, relativePath, validation, { config, fsOps = fs, conflictPolicy = 'overwrite_if_different' } = {}) {
    const safeRelativePath = assertSafeRelativePath(relativePath);
    const finalFile = path.resolve(config.downloadRoot, safeRelativePath);
    const root = path.resolve(config.downloadRoot);
    if (!finalFile.startsWith(root + path.sep) && finalFile !== root) {
        throw pipelineError('Final path escapes download root', 'UNSAFE_FINAL_PATH');
    }

    if (await pathExists(finalFile, fsOps)) {
        const existingValidation = await validateAudioFile(finalFile, { ...validation.resolved, duration: validation.resolved.duration }, {
            fsOps,
            requireDuration: false,
        }).catch(() => null);
        if (existingValidation && (await sha256(finalFile, fsOps)) === (await sha256(tempFile, fsOps))) {
            await fsOps.unlink(tempFile);
            return { finalFile, relativePath: safeRelativePath, action: 'skipped-identical', publishMethod: 'skip' };
        }

        if (conflictPolicy !== 'overwrite_if_different') {
            throw pipelineError('Final file already exists', 'FINAL_FILE_EXISTS', { finalFile });
        }
    }

    const publish = await publishTempFile(tempFile, finalFile, { fsOps });
    return { finalFile, relativePath: safeRelativePath, action: 'published', publishMethod: publish.method };
}

export async function executeTrackDownload({
    id,
    quality = 'LOSSLESS',
    jobId = crypto.randomUUID(),
    env = {},
    config = getDownloadsConfig(env),
    resolver = createResolverAdapter({ env }),
    fetchImpl = fetch,
    fsOps = fs,
    metadataEmbedder = defaultMetadataEmbedder,
    conflictPolicy = 'overwrite_if_different',
    signal,
} = {}) {
    if (!id) {
        throw pipelineError('Track id is required', 'INVALID_TRACK_ID');
    }
    if (!config.downloadRoot) {
        throw pipelineError('DOWNLOAD_DIR or music library path is required for server downloads', 'DOWNLOAD_ROOT_REQUIRED');
    }

    const jobTempDir = path.join(config.tempRoot, String(jobId));
    const tempFile = path.join(jobTempDir, 'track.download');
    let resolved = null;

    try {
        await fsOps.mkdir(jobTempDir, { recursive: true });

        resolved = await resolver.resolveTrackDownload(id, quality);
        assertNotPreview(resolved);

        if (resolved.decryptionKey) {
            const encryptedFile = path.join(jobTempDir, 'track.encrypted');
            await downloadToTempFile(
                {
                    ...resolved,
                    streamUrl: resolved.sourceUrl || resolved.streamUrl,
                    manifest: null,
                    manifestDetails: inspectManifest(null),
                    urls: [],
                },
                encryptedFile,
                { fetchImpl, fsOps, signal }
            );
            await decryptCencAudioFile(encryptedFile, tempFile, resolved, { fsOps });
            await fsOps.rm(encryptedFile, { force: true }).catch(() => {});
        } else {
            await downloadToTempFile(resolved, tempFile, { fetchImpl, fsOps, signal });
        }
        let validation = await validateAudioFile(tempFile, resolved, { fsOps });

        const metadata = buildMetadata(resolved);
        const metadataResult = await metadataEmbedder(tempFile, metadata, { resolved, fsOps, signal });
        validation = await validateAudioFile(tempFile, resolved, { fsOps });

        const relativePath = buildTrackRelativePath(resolved.metadata, validation.extension || defaultExtensionForQuality(quality));
        const publication = await finalizeTrack(
            tempFile,
            relativePath,
            { ...validation, resolved },
            { config, fsOps, conflictPolicy }
        );

        return {
            success: true,
            jobId,
            resolved,
            validation,
            metadata,
            metadataResult,
            ...publication,
        };
    } catch (error) {
        if (!error.failureCode) {
            error.failureCode = error?.message?.includes('fetch') ? 'CDN_FETCH_FAILED' : 'TRACK_DOWNLOAD_FAILED';
        }
        throw error;
    } finally {
        await fsOps.rm(jobTempDir, { recursive: true, force: true }).catch(() => {});
    }
}
