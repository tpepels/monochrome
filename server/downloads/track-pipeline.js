import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { getDownloadsConfig } from './config.js';
import { createResolverAdapter, inspectManifest } from './resolver-adapter.js';
import { noteCdnFailure, noteCdnSuccess, waitForCdnBackoff } from './cdn-backoff.js';

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
const DOWNLOAD_TRANSFER_MAX_ATTEMPTS = 3;
const DOWNLOAD_RETRY_AFTER_MAX_MS = 2 * 60 * 1000;

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
    const value = Number.parseInt(
        String(track?.trackNumber || track?.number || track?.downloadOrder?.trackNumber || 1),
        10
    );
    return Number.isFinite(value) && value > 0 ? value : 1;
}

export function buildTrackFileName(track, extension) {
    const trackNumber = String(getTrackNumber(track)).padStart(2, '0');
    const title = sanitizePathComponent(getTrackTitle(track), 'Unknown Title');
    return `${trackNumber} - ${title}.${extension}`;
}

export function buildTrackRelativePath(track, extension) {
    const artist = sanitizePathComponent(getAlbumArtistName(track), 'Unknown Artist');
    const album = sanitizePathComponent(getAlbumTitle(track), 'Unknown Album');
    return path.join(artist, album, buildTrackFileName(track, extension));
}

function extensionFromMimeType(value) {
    const mime = String(value || '').toLowerCase();
    if (mime.includes('flac')) return 'flac';
    if (mime.includes('wav')) return 'wav';
    if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
    return null;
}

function extensionFromUrl(value) {
    if (!value) return null;
    try {
        const pathname = new URL(String(value)).pathname.toLowerCase();
        const match = pathname.match(/\.([a-z0-9]+)$/);
        const extension = match?.[1] || null;
        return ['flac', 'm4a', 'mp4', 'mp3', 'ogg', 'wav'].includes(extension) ? extension : null;
    } catch {
        return null;
    }
}

export function expectedAudioExtensions(resolved = {}, quality = resolved.quality) {
    const values = [
        extensionFromMimeType(resolved.mediaMimeType),
        extensionFromMimeType(resolved.manifestMimeType),
        extensionFromUrl(resolved.streamUrl),
        extensionFromUrl(resolved.sourceUrl),
        defaultExtensionForQuality(quality),
    ];

    return [...new Set(values.filter(Boolean).map((extension) => (extension === 'mp4' ? 'm4a' : extension)))];
}

export async function findExistingTrackFile(
    resolved,
    { root, relativeDirectory = null, fsOps = fs, requireDuration = true } = {}
) {
    if (!root) return null;

    for (const extension of expectedAudioExtensions(resolved)) {
        const relativePath = relativeDirectory
            ? path.join(relativeDirectory, buildTrackFileName(resolved.metadata, extension))
            : buildTrackRelativePath(resolved.metadata, extension);
        const filePath = path.resolve(root, relativePath);
        const resolvedRoot = path.resolve(root);
        if (!filePath.startsWith(resolvedRoot + path.sep) && filePath !== resolvedRoot) continue;
        if (!(await pathExists(filePath, fsOps))) continue;

        try {
            const validation = await validateAudioFile(filePath, resolved, { fsOps, requireDuration });
            return {
                finalFile: filePath,
                relativePath,
                validation,
                extension: validation.extension || extension,
            };
        } catch {
            // Existing files are never deleted here. Invalid or incomplete
            // candidates are ignored and the normal download path continues.
        }
    }

    return null;
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

function headersForAudioUrl() {
    return BROWSER_LIKE_HEADERS;
}

function isRetryableTransferError(error) {
    if (!error || error?.failureCode === 'DOWNLOAD_FETCH_TIMEOUT') return false;
    if (error?.name === 'AbortError') return true;

    const status = Number(error?.status);
    if (Number.isFinite(status)) {
        return (
            status === 408 ||
            status === 425 ||
            status === 429 ||
            (status >= 500 && status <= 504) ||
            (status >= 520 && status <= 524)
        );
    }

    const code = String(error?.code || error?.cause?.code || '').toUpperCase();
    if (
        [
            'ECONNRESET',
            'ECONNREFUSED',
            'ECONNABORTED',
            'ETIMEDOUT',
            'EPIPE',
            'ENETRESET',
            'ENETUNREACH',
            'EHOSTUNREACH',
            'CONNECTIONCLOSED',
            'UND_ERR_SOCKET',
        ].includes(code)
    ) {
        return true;
    }

    const message = String(error?.message || error).toLowerCase();
    return (
        message.includes('socket connection was closed unexpectedly') ||
        message.includes('connection reset') ||
        message.includes('premature close') ||
        message.includes('fetch failed') ||
        message.includes('network error')
    );
}

export function parseRetryAfterMs(value, now = Date.now()) {
    if (value == null || value === '') return null;

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(DOWNLOAD_RETRY_AFTER_MAX_MS, Math.round(seconds * 1000));
    }

    const date = Date.parse(String(value));
    if (!Number.isFinite(date)) return null;
    return Math.min(DOWNLOAD_RETRY_AFTER_MAX_MS, Math.max(0, date - now));
}

async function rollbackPartialSegment(filePath, size, fsOps = fs) {
    if (size <= 0) {
        await fsOps.rm(filePath, { force: true }).catch(() => {});
        return;
    }
    await fsOps.truncate(filePath, size);
}

function annotateTransferError(error, { url, attempt, segmentIndex, segmentCount }) {
    if (!error || typeof error !== 'object') return error;
    try {
        error.url = error.url || url;
        error.transferAttempt = error.transferAttempt || attempt;
        error.maxTransferAttempts = error.maxTransferAttempts || DOWNLOAD_TRANSFER_MAX_ATTEMPTS;
        error.segmentIndex = error.segmentIndex ?? segmentIndex;
        error.segmentCount = error.segmentCount ?? segmentCount;
    } catch {
        // Some platform errors may be non-extensible; keep the original error.
    }
    return error;
}

async function fetchAudioUrl(url, { fetchImpl = fetch, signal, env = {} } = {}) {
    const response = await fetchImpl(url, {
        headers: headersForAudioUrl(url, env),
        cache: 'no-store',
        keepalive: false,
        signal,
    });

    if (!response.ok) {
        const cfRay = response.headers.get('cf-ray');
        const retryAfter = response.headers.get('retry-after');
        const suffix = cfRay ? ` (cf-ray ${cfRay})` : '';
        throw pipelineError(`CDN fetch failed: HTTP ${response.status}${suffix}`, 'CDN_FETCH_FAILED', {
            status: response.status,
            url,
            cfRay,
            retryAfter,
        });
    }

    return response;
}

async function writeResponseBodyToFile(
    response,
    filePath,
    { fsOps = fs, append = false, onProgress = null } = {}
) {
    if (!response.body) {
        await fsOps.writeFile(filePath, Buffer.alloc(0), { flag: append ? 'a' : 'w' });
        return;
    }

    const totalBytes = Number.parseInt(response.headers.get('content-length') || '', 10);
    const normalizedTotalBytes = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null;
    let downloadedBytes = 0;
    let lastProgressReportAt = 0;
    const reportProgress = (force = false) => {
        if (!onProgress) return;
        const now = Date.now();
        if (!force && lastProgressReportAt && now - lastProgressReportAt < 750) return;
        lastProgressReportAt = now;
        onProgress({
            downloadedBytes,
            totalBytes: normalizedTotalBytes,
        });
    };
    const progressStream = new Transform({
        transform(chunk, _encoding, callback) {
            downloadedBytes += chunk.length;
            reportProgress();
            callback(null, chunk);
        },
        flush(callback) {
            reportProgress(true);
            callback();
        },
    });

    const handle = await fsOps.open(filePath, append ? 'a' : 'w');
    let stream = null;
    try {
        stream = handle.createWriteStream({ autoClose: true });
        await pipeline(Readable.fromWeb(response.body), progressStream, stream);
    } catch (error) {
        stream?.destroy?.();
        await handle.close().catch(() => {});
        throw error;
    }
}

async function downloadToTempFile(
    resolved,
    tempFile,
    {
        fetchImpl = fetch,
        fsOps = fs,
        signal,
        env = {},
        timeoutMs = 2 * 60 * 1000,
        onProgress = null,
        cdnBackoffBaseMs = 5000,
        cdnBackoffMaxMs = 5 * 60 * 1000,
    } = {}
) {
    const urls = resolveDownloadUrls(resolved);
    if (!urls.length) {
        throw pipelineError('Resolved track has no downloadable URL or segment manifest', 'NO_DOWNLOAD_URL');
    }

    for (let index = 0; index < urls.length; index++) {
        const segmentStartSize =
            index === 0 ? 0 : (await fsOps.stat(tempFile).catch(() => null))?.size || 0;

        for (let attempt = 1; attempt <= DOWNLOAD_TRANSFER_MAX_ATTEMPTS; attempt++) {
            await waitForCdnBackoff(urls[index], { signal, onProgress });

            const timeoutController = new AbortController();
            const onAbort = () => timeoutController.abort(signal?.reason || new DOMException('Aborted', 'AbortError'));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });

            let timeout = null;
            const armTimeout = () => {
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    timeoutController.abort(
                        pipelineError(
                            `Audio transfer stalled for ${Math.round(timeoutMs / 1000)} seconds`,
                            'DOWNLOAD_FETCH_TIMEOUT'
                        )
                    );
                }, timeoutMs);
            };
            armTimeout();

            try {
                const response = await fetchAudioUrl(urls[index], {
                    fetchImpl,
                    signal: timeoutController.signal,
                    env,
                });
                armTimeout();
                await writeResponseBodyToFile(response, tempFile, {
                    fsOps,
                    append: index > 0,
                    onProgress: (progress) => {
                        armTimeout();
                        onProgress?.({
                            ...progress,
                            segmentIndex: index,
                            segmentCount: urls.length,
                        });
                    },
                });
                noteCdnSuccess(urls[index]);
                break;
            } catch (error) {
                const context = {
                    url: urls[index],
                    attempt,
                    segmentIndex: index,
                    segmentCount: urls.length,
                };

                if (signal?.aborted) {
                    throw annotateTransferError(signal.reason || error, context);
                }

                if (timeoutController.signal.aborted) {
                    const reason = timeoutController.signal.reason;
                    if (reason?.failureCode === 'DOWNLOAD_FETCH_TIMEOUT') {
                        throw annotateTransferError(reason, context);
                    }
                }

                annotateTransferError(error, context);
                await rollbackPartialSegment(tempFile, segmentStartSize, fsOps);

                const retryable = isRetryableTransferError(error);
                if (retryable) {
                    noteCdnFailure(urls[index], {
                        retryAfterMs: parseRetryAfterMs(error?.retryAfter),
                        baseMs: cdnBackoffBaseMs,
                        maxMs: cdnBackoffMaxMs,
                    });
                }

                if (!retryable || attempt === DOWNLOAD_TRANSFER_MAX_ATTEMPTS) {
                    if (retryable && !error.failureCode) {
                        error.failureCode = 'CDN_FETCH_FAILED';
                        error.url = error.url || urls[index];
                    }
                    throw error;
                }
            } finally {
                clearTimeout(timeout);
                signal?.removeEventListener?.('abort', onAbort);
            }

        }
    }
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

async function downloadResolvedTrackToTemp(
    resolved,
    tempFile,
    {
        jobTempDir,
        fetchImpl,
        fsOps,
        signal,
        env,
        timeoutMs,
        onProgress,
        cdnBackoffBaseMs,
        cdnBackoffMaxMs,
    } = {}
) {
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
            {
                fetchImpl,
                fsOps,
                signal,
                env,
                timeoutMs,
                onProgress,
                cdnBackoffBaseMs,
                cdnBackoffMaxMs,
            }
        );
        await decryptCencAudioFile(encryptedFile, tempFile, resolved, { fsOps });
        await fsOps.rm(encryptedFile, { force: true }).catch(() => {});
        return;
    }

    await downloadToTempFile(resolved, tempFile, {
        fetchImpl,
        fsOps,
        signal,
        env,
        timeoutMs,
        onProgress,
        cdnBackoffBaseMs,
        cdnBackoffMaxMs,
    });
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

function buildMetadata(resolved, albumMetadata = null) {
    const track = resolved.metadata || {};
    const album = albumMetadata || track.album || null;
    const albumArtist =
        album?.artist?.name ||
        (Array.isArray(album?.artists) ? album.artists.map((artist) => artist?.name).filter(Boolean).join(', ') : '') ||
        getAlbumArtistName(track);

    return {
        title: getTrackTitle(track),
        artist: getArtistName(track),
        album: album?.title || album?.name || getAlbumTitle(track),
        albumArtist,
        discNumber: track.volumeNumber || track.discNumber || 1,
        trackNumber: getTrackNumber(track),
        releaseDate: album?.releaseDate || track.album?.releaseDate || track.releaseDate || track.streamStartDate?.split?.('T')?.[0] || null,
        isrc: resolved.isrc || track.isrc || null,
        coverUrl: album?.coverUrl || album?.cover || resolved.coverUrl || null,
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
    relativeDirectory = null,
    track = null,
    albumMetadata = null,
    resolvedTrack = null,
    onProgress = null,
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
    let resolved = resolvedTrack;

    try {
        await fsOps.mkdir(jobTempDir, { recursive: true });

        if (!resolved) {
            resolved = await resolver.resolveTrackDownload(id, quality, { track });
        }
        assertNotPreview(resolved);

        const existing = await findExistingTrackFile(resolved, {
            root: config.downloadRoot,
            relativeDirectory,
            fsOps,
        });
        if (existing) {
            return {
                success: true,
                jobId,
                resolved,
                validation: existing.validation,
                metadata: buildMetadata(resolved),
                metadataResult: { embedded: true, method: 'existing' },
                finalFile: existing.finalFile,
                relativePath: existing.relativePath,
                action: 'skipped-existing-valid',
                publishMethod: 'reuse',
            };
        }

        try {
            await downloadResolvedTrackToTemp(resolved, tempFile, {
                jobTempDir,
                fetchImpl,
                fsOps,
                signal,
                env,
                timeoutMs: config.fetchTimeoutMs,
                onProgress,
                cdnBackoffBaseMs:
                    config.cdnBackoffBaseMs ??
                    Number(process.env.DOWNLOAD_CDN_BACKOFF_BASE_MS || 5000),
                cdnBackoffMaxMs:
                    config.cdnBackoffMaxMs ??
                    Number(process.env.DOWNLOAD_CDN_BACKOFF_MAX_MS || 5 * 60 * 1000),
            });
        } catch (primaryError) {
            if (
                signal?.aborted ||
                primaryError?.failureCode !== 'CDN_FETCH_FAILED' ||
                typeof resolver.resolveAlternateTrackDownload !== 'function'
            ) {
                throw primaryError;
            }

            const alternate = await resolver.resolveAlternateTrackDownload(id, quality, { track, signal });
            const primaryUrl = resolved?.streamUrl || resolved?.sourceUrl || null;
            const alternateUrl = alternate?.streamUrl || alternate?.sourceUrl || null;

            if (alternate?.alternateUnavailable) {
                try {
                    primaryError.originalTrackId = alternate.originalTrackId || String(id);
                    primaryError.alternateSearchAttempted = Boolean(alternate.alternateSearchAttempted);
                    primaryError.alternateCandidatesConsidered = Number(alternate.alternateCandidatesConsidered || 0);
                    primaryError.alternateBestMatchScore = Number(alternate.alternateBestMatchScore || 0);
                    primaryError.alternateReason = alternate.alternateReason || 'no-safe-alternate-match';
                    primaryError.alternateSearchError = alternate.alternateSearchError || null;
                } catch {
                    // Preserve the primary transfer failure if it is non-extensible.
                }
                throw primaryError;
            }

            if (!alternate || !alternateUrl || alternateUrl === primaryUrl) {
                throw primaryError;
            }

            await fsOps.rm(tempFile, { force: true }).catch(() => {});
            onProgress?.({
                alternateSource: true,
                originalTrackId: alternate.originalTrackId || String(id),
                alternateTrackId: alternate.alternateTrackId || null,
                alternateMatchScore: alternate.alternateMatchScore ?? null,
                alternateExactRecordingId: Boolean(alternate.alternateExactRecordingId),
                alternateExactIsrc: Boolean(alternate.alternateExactIsrc),
                alternateDurationVerified: Boolean(alternate.alternateDurationVerified),
                alternateDurationUnavailable: Boolean(alternate.alternateDurationUnavailable),
                alternateCandidatesConsidered: Number(alternate.alternateCandidatesConsidered || 0),
            });

            try {
                await downloadResolvedTrackToTemp(alternate, tempFile, {
                    jobTempDir,
                    fetchImpl,
                    fsOps,
                    signal,
                    env,
                    timeoutMs: config.fetchTimeoutMs,
                    onProgress,
                    cdnBackoffBaseMs:
                        config.cdnBackoffBaseMs ??
                        Number(process.env.DOWNLOAD_CDN_BACKOFF_BASE_MS || 5000),
                    cdnBackoffMaxMs:
                        config.cdnBackoffMaxMs ??
                        Number(process.env.DOWNLOAD_CDN_BACKOFF_MAX_MS || 5 * 60 * 1000),
                });
                resolved = alternate;
            } catch (alternateError) {
                try {
                    alternateError.originalTrackId = alternate.originalTrackId || String(id);
                    alternateError.alternateTrackId = alternate.alternateTrackId || null;
                    alternateError.alternateMatchScore = alternate.alternateMatchScore ?? null;
                    alternateError.primaryFailureCode = primaryError?.failureCode || null;
                    alternateError.primaryStatus = Number.isFinite(Number(primaryError?.status))
                        ? Number(primaryError.status)
                        : null;
                } catch {
                    // Preserve the alternate transfer error if it is non-extensible.
                }
                throw alternateError;
            }
        }

        let validation = await validateAudioFile(tempFile, resolved, { fsOps });

        const metadata = buildMetadata(resolved, albumMetadata);
        const metadataResult = await metadataEmbedder(tempFile, metadata, { resolved, fsOps, signal });
        validation = await validateAudioFile(tempFile, resolved, { fsOps });

        const extension = validation.extension || defaultExtensionForQuality(quality);
        const relativePath = relativeDirectory
            ? path.join(relativeDirectory, buildTrackFileName(resolved.metadata, extension))
            : buildTrackRelativePath(resolved.metadata, extension);
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
