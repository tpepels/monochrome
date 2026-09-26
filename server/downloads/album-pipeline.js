import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDownloadsConfig } from './config.js';
import { InMemoryMaintenanceLock } from './maintenance.js';
import { createResolverAdapter } from './resolver-adapter.js';
import { buildTrackFileName, executeTrackDownload, findExistingTrackFile } from './track-pipeline.js';
import { LIBRARY_STAGING_DIR } from './constants.js';

const COVER_HEADERS = Object.freeze({
    accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'user-agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
});

function albumError(message, failureCode, details = {}) {
    const error = new Error(message);
    error.failureCode = failureCode;
    Object.assign(error, details);
    return error;
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

function getAlbumArtist(album) {
    if (album?.artist?.name) return album.artist.name;
    if (Array.isArray(album?.artists) && album.artists.length) {
        return album.artists.map((artist) => artist?.name).filter(Boolean).join(', ');
    }
    return 'Unknown Artist';
}

function getAlbumTitle(album) {
    return album?.title || album?.name || 'Unknown Album';
}

export function buildAlbumRelativePath(album) {
    return path.join(
        sanitizePathComponent(getAlbumArtist(album), 'Unknown Artist'),
        sanitizePathComponent(getAlbumTitle(album), 'Unknown Album')
    );
}

function assertNotAborted(signal) {
    if (signal?.aborted) {
        const error = new DOMException('Aborted', 'AbortError');
        error.failureCode = 'ALBUM_DOWNLOAD_CANCELLED';
        throw error;
    }
}

async function pathExists(filePath, fsOps = fs) {
    try {
        await fsOps.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function listPreviousStagingRoots(downloadRoot, currentJobId, fsOps = fs) {
    const stagingBase = path.resolve(downloadRoot, LIBRARY_STAGING_DIR);
    const entries = await fsOps.readdir(stagingBase, { withFileTypes: true }).catch(() => []);

    return entries
        .filter((entry) => entry.isDirectory() && entry.name !== String(currentJobId))
        .map((entry) => path.join(stagingBase, entry.name, 'staging'));
}

const REUSABLE_AUDIO_EXTENSIONS = ['flac', 'm4a', 'mp4', 'mp3', 'ogg', 'wav'];

async function hasPotentialTrackFile(root, albumRelativePath, track, fsOps = fs) {
    if (!root) return false;
    for (const extension of REUSABLE_AUDIO_EXTENSIONS) {
        const candidate = path.resolve(root, albumRelativePath, buildTrackFileName(track, extension));
        if (await pathExists(candidate, fsOps)) return true;
    }
    return false;
}

async function resolveTrackOnce(track, quality, resolver, cache) {
    const key = String(track.id);
    if (cache.has(key)) return cache.get(key);
    const resolved = await resolver.resolveTrackDownload(track.id, quality, { track });
    cache.set(key, resolved);
    return resolved;
}

async function isExpectedAlbumComplete({
    albumResult,
    quality,
    resolver,
    resolvedCache,
    downloadRoot,
    albumRelativePath,
    fsOps = fs,
} = {}) {
    for (const track of albumResult.tracks) {
        if (!(await hasPotentialTrackFile(downloadRoot, albumRelativePath, track, fsOps))) return false;
        const resolved = await resolveTrackOnce(track, quality, resolver, resolvedCache);
        const existing = await findExistingTrackFile(resolved, {
            root: downloadRoot,
            relativeDirectory: albumRelativePath,
            fsOps,
        });
        if (!existing) return false;
    }
    return albumResult.tracks.length > 0;
}

async function resolveReusableTrack({
    track,
    quality,
    resolver,
    resolvedCache,
    stagingRoot,
    albumRelativePath,
    candidateSources = [],
    checkCurrentStaging = false,
    fsOps = fs,
} = {}) {
    const currentHasPotential =
        checkCurrentStaging && (await hasPotentialTrackFile(stagingRoot, albumRelativePath, track, fsOps));
    const matchingSources = [];
    for (const source of candidateSources) {
        if (await hasPotentialTrackFile(source.root, albumRelativePath, track, fsOps)) {
            matchingSources.push(source);
        }
    }

    if (!currentHasPotential && matchingSources.length === 0) {
        return { resolved: null, result: null };
    }

    const resolved = await resolveTrackOnce(track, quality, resolver, resolvedCache);

    const current = currentHasPotential
        ? await findExistingTrackFile(resolved, {
              root: stagingRoot,
              relativeDirectory: albumRelativePath,
              fsOps,
          })
        : null;
    if (current) {
        return {
            resolved,
            result: {
                success: true,
                id: track.id,
                resolved,
                validation: current.validation,
                finalFile: current.finalFile,
                relativePath: current.relativePath,
                action: 'resumed-staged-track',
                publishMethod: 'reuse',
            },
        };
    }

    for (const source of candidateSources) {
        const existing = await findExistingTrackFile(resolved, {
            root: source.root,
            relativeDirectory: albumRelativePath,
            fsOps,
        });
        if (!existing) continue;

        const targetFile = path.resolve(stagingRoot, existing.relativePath);
        await fsOps.mkdir(path.dirname(targetFile), { recursive: true });
        await fsOps.copyFile(existing.finalFile, targetFile);

        return {
            resolved,
            result: {
                success: true,
                id: track.id,
                resolved,
                validation: existing.validation,
                finalFile: targetFile,
                relativePath: existing.relativePath,
                action: source.action,
                publishMethod: 'local-reuse',
            },
        };
    }

    return { resolved, result: null };
}

export class InMemoryPublishLock extends InMemoryMaintenanceLock {}

export const defaultPublishLock = new InMemoryPublishLock();

async function downloadCover(album, stagingAlbumDir, { fetchImpl = fetch, fsOps = fs, signal } = {}) {
    if (!album.coverUrl) return null;

    const response = await fetchImpl(album.coverUrl, {
        headers: COVER_HEADERS,
        cache: 'no-store',
        signal,
    });

    if (!response.ok) {
        throw albumError(`Cover fetch failed: HTTP ${response.status}`, 'COVER_FETCH_FAILED', {
            status: response.status,
        });
    }

    const coverPath = path.join(stagingAlbumDir, 'cover.jpg');
    await fsOps.writeFile(coverPath, Buffer.from(await response.arrayBuffer()));
    return coverPath;
}

async function publishAlbumDirectory({
    stagingAlbumDir,
    finalAlbumDir,
    albumName,
    jobId,
    fsOps = fs,
    suffix = crypto.randomBytes(4).toString('hex'),
    signal,
} = {}) {
    assertNotAborted(signal);
    const artistDir = path.dirname(finalAlbumDir);
    await fsOps.mkdir(artistDir, { recursive: true });

    const hiddenName = sanitizePathComponent(albumName, 'Album');
    const publishingDir = path.join(artistDir, `.${hiddenName}.publishing-${jobId}-${suffix}`);
    const backupDir = path.join(artistDir, `.${hiddenName}.backup-${jobId}-${suffix}`);
    let backupCreated = false;

    try {
        await fsOps.rm(publishingDir, { recursive: true, force: true });
        await fsOps.rename(stagingAlbumDir, publishingDir);
        assertNotAborted(signal);

        if (await pathExists(finalAlbumDir, fsOps)) {
            await fsOps.rm(backupDir, { recursive: true, force: true });
            await fsOps.rename(finalAlbumDir, backupDir);
            backupCreated = true;
        }

        assertNotAborted(signal);
        await fsOps.rename(publishingDir, finalAlbumDir);

        if (backupCreated) {
            await fsOps.rm(backupDir, { recursive: true, force: true });
        }

        return {
            finalAlbumDir,
            publishingDir,
            backupDir: backupCreated ? backupDir : null,
            action: backupCreated ? 'replaced' : 'published',
        };
    } catch (error) {
        await fsOps.rm(publishingDir, { recursive: true, force: true }).catch(() => {});
        if (backupCreated) {
            await fsOps.rm(finalAlbumDir, { recursive: true, force: true }).catch(() => {});
            if (await pathExists(backupDir, fsOps)) {
                await fsOps.rename(backupDir, finalAlbumDir);
            }
        }
        if (!error.failureCode) error.failureCode = 'ALBUM_PUBLISH_FAILED';
        throw error;
    }
}

export async function executeAlbumDownload({
    id,
    quality = 'LOSSLESS',
    jobId = crypto.randomUUID(),
    env = {},
    config = getDownloadsConfig(env),
    resolver = createResolverAdapter({ env }),
    trackExecutor = executeTrackDownload,
    fetchImpl = fetch,
    fsOps = fs,
    metadataEmbedder,
    publishLock = defaultPublishLock,
    sidecarWriters = [],
    album = null,
    tracks = null,
    onProgress,
    signal,
} = {}) {
    if (!id) throw albumError('Album id is required', 'INVALID_ALBUM_ID');
    if (!config.downloadRoot) {
        throw albumError('DOWNLOAD_DIR or music library path is required for album downloads', 'DOWNLOAD_ROOT_REQUIRED');
    }

    const albumTempRoot = path.join(config.tempRoot, String(jobId));
    const libraryStagingRoot = path.join(config.downloadRoot, LIBRARY_STAGING_DIR, String(jobId));
    const stagingRoot = path.join(libraryStagingRoot, 'staging');
    const trackTempRoot = path.join(albumTempRoot, 'tracks-temp');
    let albumResult = null;
    let preserveLibraryStaging = false;

    try {
        albumResult = await resolver.resolveAlbum(id, { album, tracks });
        const resolvedAlbum = albumResult.metadata;
        const albumRelativePath = buildAlbumRelativePath(resolvedAlbum);
        const finalAlbumDir = path.resolve(config.downloadRoot, albumRelativePath);
        const stagingAlbumDir = path.resolve(stagingRoot, albumRelativePath);
        const resolvedCache = new Map();
        const finalAlbumExists = await pathExists(finalAlbumDir, fsOps);

        if (
            finalAlbumExists &&
            (await isExpectedAlbumComplete({
                albumResult,
                quality,
                resolver,
                resolvedCache,
                downloadRoot: config.downloadRoot,
                albumRelativePath,
                fsOps,
            }))
        ) {
            return {
                success: true,
                jobId,
                album: albumResult,
                action: 'skipped-existing-complete',
                finalAlbumDir,
                relativePath: albumRelativePath,
                warnings: [],
            };
        }

        const currentStagingExisted = await pathExists(stagingAlbumDir, fsOps);
        const previousStagingRoots = await listPreviousStagingRoots(config.downloadRoot, jobId, fsOps);
        const reusablePreviousStagingRoots = [];
        for (const root of previousStagingRoots) {
            if (await pathExists(path.resolve(root, albumRelativePath), fsOps)) {
                reusablePreviousStagingRoots.push(root);
            }
        }
        const candidateSources = [
            ...(finalAlbumExists ? [{ root: config.downloadRoot, action: 'reused-final-track' }] : []),
            ...reusablePreviousStagingRoots.map((root) => ({ root, action: 'reused-staged-track' })),
        ];

        await fsOps.mkdir(stagingAlbumDir, { recursive: true });
        onProgress?.({ phase: 'processing', totalTracks: albumResult.tracks.length, completedTracks: 0 });

        const trackResults = [];
        for (let index = 0; index < albumResult.tracks.length; index++) {
            assertNotAborted(signal);
            const track = albumResult.tracks[index];
            onProgress?.({
                phase: 'processing',
                currentTrack: track.id,
                totalTracks: albumResult.tracks.length,
                completedTracks: index,
            });

            let result;
            try {
                const resumable = await resolveReusableTrack({
                    track,
                    quality,
                    resolver,
                    resolvedCache,
                    stagingRoot,
                    albumRelativePath,
                    candidateSources,
                    checkCurrentStaging: currentStagingExisted,
                    fsOps,
                });

                result =
                    resumable.result ||
                    (await trackExecutor({
                        id: track.id,
                        quality,
                        jobId: `${jobId}-track-${index + 1}`,
                        env,
                        config: {
                            ...config,
                            tempRoot: trackTempRoot,
                            downloadRoot: stagingRoot,
                        },
                        resolver,
                        resolvedTrack: resumable.resolved,
                        fetchImpl,
                        fsOps,
                        metadataEmbedder,
                        relativeDirectory: albumRelativePath,
                        track,
                        onProgress: (trackTransfer) =>
                            onProgress?.({
                                phase: 'processing',
                                currentTrack: track.id,
                                totalTracks: albumResult.tracks.length,
                                completedTracks: index,
                                trackTransfer,
                            }),
                        signal,
                    }));
            } catch (error) {
                error.trackId = error.trackId || track.id;
                throw error;
            }
            trackResults.push(result);
            onProgress?.({
                phase: 'processing',
                currentTrack: track.id,
                totalTracks: albumResult.tracks.length,
                completedTracks: index + 1,
                trackProgress: trackResults.map((trackResult, trackIndex) => ({
                    id: trackResult.id || trackResult.resolved?.id || albumResult.tracks[trackIndex]?.id,
                    status: 'completed',
                    finalFile: trackResult.finalFile,
                })),
            });
        }

        assertNotAborted(signal);
        const warnings = [];
        try {
            await downloadCover(albumResult, stagingAlbumDir, { fetchImpl, fsOps, signal });
        } catch (error) {
            if (signal?.aborted) throw error;

            const warning = {
                failureCode: error?.failureCode || 'COVER_FETCH_FAILED',
                message: error?.message || 'Cover download failed',
                status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
            };
            warnings.push(warning);
            console.warn('[downloads] Cover unavailable; publishing album without cover:', warning.message);
            onProgress?.({
                phase: 'processing',
                totalTracks: albumResult.tracks.length,
                completedTracks: albumResult.tracks.length,
                warning: warning.message,
                warningCode: warning.failureCode,
            });
        }

        for (const writer of sidecarWriters) {
            assertNotAborted(signal);
            await writer({ album: albumResult, stagingAlbumDir, fsOps });
        }

        onProgress?.({
            phase: 'publishing',
            totalTracks: albumResult.tracks.length,
            completedTracks: albumResult.tracks.length,
        });

        const publication = await publishLock.runExclusive(() =>
            publishAlbumDirectory({
                stagingAlbumDir,
                finalAlbumDir,
                albumName: getAlbumTitle(resolvedAlbum),
                jobId,
                fsOps,
                signal,
            })
        );

        onProgress?.({
            phase: 'completed',
            totalTracks: albumResult.tracks.length,
            completedTracks: albumResult.tracks.length,
        });

        return {
            success: true,
            jobId,
            album: albumResult,
            tracks: trackResults,
            relativePath: albumRelativePath,
            stagingAlbumDir,
            warnings,
            ...publication,
        };
    } catch (error) {
        preserveLibraryStaging = true;
        if (!error.failureCode) error.failureCode = 'ALBUM_DOWNLOAD_FAILED';
        onProgress?.({
            phase: 'failed',
            failedTrack: error.trackId || null,
            error: error.message,
            failureCode: error.failureCode,
        });
        throw error;
    } finally {
        await fsOps.rm(albumTempRoot, { recursive: true, force: true }).catch(() => {});
        if (!preserveLibraryStaging) {
            await fsOps.rm(libraryStagingRoot, { recursive: true, force: true }).catch(() => {});
        }
    }
}
