import fs from 'node:fs/promises';
import path from 'node:path';
import { getDownloadsConfig, publicConfig } from './config.js';
import { defaultMaintenanceLock, RedisMaintenanceLock, sweepDownloadTransients } from './maintenance.js';
import { executeAlbumDownload, publishPartialAlbum } from './album-pipeline.js';
import { executeTrackDownload } from './track-pipeline.js';

export const DOWNLOAD_JOB_STATUSES = Object.freeze({
    QUEUED: 'queued',
    PROCESSING: 'processing',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    FAILED: 'failed',
    PARTIAL: 'partial',
    CANCELLED: 'cancelled',
});

const TERMINAL_STATUSES = new Set([
    DOWNLOAD_JOB_STATUSES.COMPLETED,
    DOWNLOAD_JOB_STATUSES.FAILED,
    DOWNLOAD_JOB_STATUSES.PARTIAL,
    DOWNLOAD_JOB_STATUSES.CANCELLED,
]);

const RETRYABLE_FAILURE_CODES = new Set([
    'CDN_FETCH_FAILED',
    'DOWNLOAD_FETCH_TIMEOUT',
    'COVER_FETCH_FAILED',
    'PROVIDER_FETCH_FAILED',
    'RESOLVER_FETCH_FAILED',
    'ALBUM_PUBLISH_FAILED',
    'PUBLISH_LOCK_BUSY',
    'MAINTENANCE_LOCK_TIMEOUT',
    'TRACK_DOWNLOAD_FAILED',
    'ALBUM_DOWNLOAD_FAILED',
]);

const VALID_TYPES = new Set(['track', 'album']);

function nowIso() {
    return new Date().toISOString();
}

function createJobId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return `download_${globalThis.crypto.randomUUID()}`;
    }

    return `download_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function validationError(message, failureCode = 'INVALID_DOWNLOAD_REQUEST') {
    const error = new Error(message);
    error.status = 400;
    error.failureCode = failureCode;
    return error;
}

function sanitizeDiagnosticUrl(value) {
    if (!value) return null;
    try {
        const url = new URL(String(value));
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return null;
    }
}

function sanitizeErrorMessage(value) {
    return String(value || 'Download failed').replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
        return sanitizeDiagnosticUrl(match) || '[redacted URL]';
    });
}

function numberOrNull(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function buildFailureDiagnostics(error, job, failedAt) {
    const progress = job.progress || {};
    const transfer = progress.trackTransfer || progress;
    const diagnosticTrackId = progress.failedTrack || progress.currentTrack || null;
    const currentTrack =
        diagnosticTrackId == null
            ? null
            : job.tracks?.find((track) => String(track?.id) === String(diagnosticTrackId)) || null;

    return {
        error: {
            name: error?.name || 'Error',
            failureCode: error?.failureCode || 'DOWNLOAD_JOB_FAILED',
            httpStatus: numberOrNull(error?.status),
            requestUrl: sanitizeDiagnosticUrl(error?.url),
            cfRay: error?.cfRay || null,
            retryAfter: error?.retryAfter || null,
            provider: error?.provider || null,
            transferAttempt: numberOrNull(error?.transferAttempt),
            maxTransferAttempts: numberOrNull(error?.maxTransferAttempts),
            segmentIndex: numberOrNull(error?.segmentIndex),
            segmentCount: numberOrNull(error?.segmentCount),
            duration: numberOrNull(error?.duration),
            expectedDuration: numberOrNull(error?.expectedDuration),
            extension: error?.extension || null,
            errorCode: error?.code || null,
            originalTrackId: error?.originalTrackId || null,
            alternateTrackId: error?.alternateTrackId || null,
            alternateMatchScore: numberOrNull(error?.alternateMatchScore),
            alternateSearchAttempted: Boolean(error?.alternateSearchAttempted),
            alternateCandidatesConsidered: numberOrNull(error?.alternateCandidatesConsidered),
            alternateBestMatchScore: numberOrNull(error?.alternateBestMatchScore),
            alternateReason: error?.alternateReason || null,
            alternateSearchError: error?.alternateSearchError ? sanitizeErrorMessage(error.alternateSearchError) : null,
            primaryFailureCode: error?.primaryFailureCode || null,
            primaryStatus: numberOrNull(error?.primaryStatus),
            causeName: error?.cause?.name || null,
            causeCode: error?.cause?.code || null,
            causeMessage: error?.cause?.message ? sanitizeErrorMessage(error.cause.message) : null,
        },
        state: {
            jobId: job.jobId,
            type: job.type,
            id: job.id,
            quality: job.quality,
            queueAttempt: job.attempts,
            statusAtFailure: job.status,
            phase: progress.phase || job.publicationPhase || null,
            progressMessage: progress.message || null,
            currentTrack: diagnosticTrackId,
            failedTrack: progress.failedTrack || diagnosticTrackId,
            failedTracks: Array.isArray(progress.failedTracks) ? progress.failedTracks : [],
            currentTrackTitle: currentTrack?.title || currentTrack?.name || null,
            completedTracks: numberOrNull(progress.completedTracks),
            totalTracks: numberOrNull(progress.totalTracks),
            downloadedBytes: numberOrNull(transfer?.downloadedBytes),
            totalBytes: numberOrNull(transfer?.totalBytes),
            segmentIndex: numberOrNull(transfer?.segmentIndex),
            segmentCount: numberOrNull(transfer?.segmentCount),
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            failedAt,
        },
    };
}

function normalizePayload(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw validationError('Request body must be a JSON object');
    }

    const type = String(input.type || '').trim();
    if (!VALID_TYPES.has(type)) {
        throw validationError('Download type must be "track" or "album"', 'INVALID_DOWNLOAD_TYPE');
    }

    const id = String(input.id ?? '').trim();
    if (!id) {
        throw validationError('Download id is required', 'INVALID_DOWNLOAD_ID');
    }

    const quality = String(input.quality ?? '').trim();
    if (!quality) {
        throw validationError('Download quality is required', 'INVALID_DOWNLOAD_QUALITY');
    }

    const forceOverwrite = Boolean(input.forceOverwrite);
    return {
        type,
        id,
        quality,
        forceOverwrite,
        overwritePolicy: forceOverwrite ? 'overwrite_if_different' : input.overwritePolicy || 'overwrite_if_different',
        musicBrainzReleaseId:
            input.musicBrainzReleaseId == null ? null : String(input.musicBrainzReleaseId).trim() || null,
        localRelativePath: input.localRelativePath == null ? null : String(input.localRelativePath).trim() || null,
        track: input.track && typeof input.track === 'object' && !Array.isArray(input.track) ? input.track : null,
        album: input.album && typeof input.album === 'object' && !Array.isArray(input.album) ? input.album : null,
        tracks: Array.isArray(input.tracks) ? input.tracks : null,
    };
}

function baseProgress(message, extra = {}) {
    return {
        percent: 0,
        message,
        ...extra,
    };
}

function summarizeJob(job) {
    const currentTrackId = job.progress?.currentTrack;
    const currentTrack =
        currentTrackId == null
            ? null
            : job.tracks?.find((track) => String(track?.id) === String(currentTrackId)) || null;
    const displayName =
        job.type === 'album'
            ? job.album?.title || job.album?.name || `Album ${job.id}`
            : job.track?.title || job.track?.name || `Track ${job.id}`;

    return {
        jobId: job.jobId,
        type: job.type,
        id: job.id,
        quality: job.quality,
        displayName,
        currentTrackTitle: currentTrack?.title || currentTrack?.name || null,
        forceOverwrite: job.forceOverwrite,
        overwritePolicy: job.overwritePolicy,
        musicBrainzReleaseId: job.musicBrainzReleaseId,
        localRelativePath: job.localRelativePath,
        status: job.status,
        progress: job.progress,
        trackProgress: job.trackProgress,
        albumMetadata: job.albumMetadata,
        publicationPhase: job.publicationPhase,
        result: job.result,
        error: job.error,
        failureCode: job.failureCode,
        diagnostics: job.diagnostics || null,
        attempts: job.attempts || 0,
        retryable: job.retryable,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        cancelledAt: job.cancelledAt,
        cancelReason: job.cancelReason || null,
        requeuedAsJobId: job.requeuedAsJobId || null,
        requeuedAt: job.requeuedAt || null,
        skippedTrackIds: Array.isArray(job.skippedTrackIds) ? job.skippedTrackIds : [],
        missingTracks: Array.isArray(job.missingTracks) ? job.missingTracks : [],
        partialPublishedAt: job.partialPublishedAt || null,
    };
}

function isRetryableFailure(error) {
    if (error?.name === 'AbortError' && !error?.failureCode) return false;
    return RETRYABLE_FAILURE_CODES.has(error?.failureCode);
}

function jobPayload(job) {
    return {
        type: job.type,
        id: job.id,
        quality: job.quality,
        forceOverwrite: job.forceOverwrite,
        overwritePolicy: job.overwritePolicy,
        musicBrainzReleaseId: job.musicBrainzReleaseId,
        localRelativePath: job.localRelativePath,
        track: job.track,
        album: job.album,
        tracks: job.tracks,
    };
}

function queueReferenceKey(job) {
    return [job.type, job.id, job.quality].join('\u0000');
}

function updatedAtMs(job) {
    const value = Date.parse(job.updatedAt || job.createdAt || '');
    return Number.isFinite(value) ? value : 0;
}

function pickCanonicalJob(group) {
    const active = group.filter((job) => !TERMINAL_STATUSES.has(job.status));
    if (active.length) {
        return active.sort((a, b) => updatedAtMs(b) - updatedAtMs(a))[0];
    }

    const completed = group.filter((job) => job.status === DOWNLOAD_JOB_STATUSES.COMPLETED);
    if (completed.length) {
        return completed.sort((a, b) => updatedAtMs(b) - updatedAtMs(a))[0];
    }

    return [...group].sort((a, b) => updatedAtMs(b) - updatedAtMs(a))[0] || null;
}

function createJob(payload, overrides = {}) {
    const timestamp = nowIso();
    return {
        ...payload,
        jobId: overrides.jobId || createJobId(),
        status: overrides.status || DOWNLOAD_JOB_STATUSES.QUEUED,
        progress: overrides.progress || baseProgress('Queued'),
        trackProgress: payload.type === 'album' ? [] : null,
        albumMetadata: null,
        publicationPhase: null,
        result: null,
        error: null,
        failureCode: null,
        diagnostics: null,
        retryable: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        cancelReason: null,
        requeuedAsJobId: null,
        requeuedAt: null,
        skippedTrackIds: [],
        missingTracks: [],
        partialPublishedAt: null,
        attempts: overrides.attempts || 0,
    };
}

async function safePathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function duplicateExists(payload, config) {
    if (!config.duplicateCheckBeforeQueue || !config.downloadRoot || !payload.localRelativePath) return false;
    const finalPath = path.resolve(config.downloadRoot, path.normalize(payload.localRelativePath));
    const root = path.resolve(config.downloadRoot);
    if (!finalPath.startsWith(root + path.sep) && finalPath !== root) return false;
    return safePathExists(finalPath);
}

export class MemoryDownloadQueue {
    constructor({
        trackExecutor = executeTrackDownload,
        albumExecutor = executeAlbumDownload,
        maintenanceLock = defaultMaintenanceLock,
        backend = 'memory',
        fallbackReason = null,
        persistToDisk = process.env.NODE_ENV !== 'test',
    } = {}) {
        this.jobs = new Map();
        this.order = [];
        this.backend = backend;
        this.fallbackReason = fallbackReason;
        this.persistToDisk = persistToDisk;
        this.activeWorkers = 0;
        this.activeControllers = new Map();
        this.workerEnabled = true;
        this.workerReason = null;
        this.lastConfig = getDownloadsConfig();
        this.trackExecutor = trackExecutor;
        this.albumExecutor = albumExecutor;
        this.maintenanceLock = maintenanceLock;
        this.startupSweepPromise = null;
        this.idleResolvers = [];
        this.hydratedStateFile = null;
        this.persistChain = Promise.resolve();
    }

    async deletePersistedJobs() {
        // Memory persistence serializes only jobs still present in this.order.
    }

    async compactDuplicates() {
        const groups = new Map();
        for (const jobId of this.order) {
            const job = this.jobs.get(jobId);
            if (!job) continue;
            const key = queueReferenceKey(job);
            const group = groups.get(key) || [];
            group.push(job);
            groups.set(key, group);
        }

        const keepIds = new Set();
        const removeIds = [];
        for (const group of groups.values()) {
            const keep = pickCanonicalJob(group);
            if (!keep) continue;
            keepIds.add(keep.jobId);

            for (const job of group) {
                if (job.jobId === keep.jobId) continue;
                this.activeControllers.get(job.jobId)?.abort();
                removeIds.push(job.jobId);
            }
        }

        if (!removeIds.length) return { removed: 0 };

        this.order = this.order.filter((jobId) => keepIds.has(jobId) || !removeIds.includes(jobId));
        for (const jobId of removeIds) this.jobs.delete(jobId);

        await this.deletePersistedJobs(removeIds);
        await this.persistOrder();
        return { removed: removeIds.length };
    }

    queueStateFile(config = this.lastConfig) {
        if (!config?.tempRoot || this.backend !== 'memory' || !this.persistToDisk) return null;
        return path.join(config.tempRoot, 'download-queue-state.json');
    }

    async hydrateFromDisk(config = this.lastConfig) {
        const stateFile = this.queueStateFile(config);
        if (!stateFile || this.hydratedStateFile === stateFile) return;

        this.lastConfig = config;
        await fs.mkdir(config.tempRoot, { recursive: true });
        let parsed = null;
        try {
            parsed = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                console.warn('[downloads] Could not restore queue state:', error?.message || error);
            }
        }

        this.jobs.clear();
        this.order = [];

        if (parsed && Array.isArray(parsed.order) && Array.isArray(parsed.jobs)) {
            const byId = new Map(parsed.jobs.filter(Boolean).map((job) => [job.jobId, job]));
            for (const jobId of parsed.order) {
                const job = byId.get(jobId);
                if (!job) continue;
                this.jobs.set(jobId, job);
                this.order.push(jobId);
            }
        }

        this.hydratedStateFile = stateFile;
    }

    async persistState() {
        const stateFile = this.queueStateFile(this.lastConfig);
        if (!stateFile) return;

        const payload = JSON.stringify(
            {
                version: 1,
                order: this.order,
                jobs: this.order.map((jobId) => this.jobs.get(jobId)).filter(Boolean),
            },
            null,
            2
        );

        this.persistChain = this.persistChain
            .catch(() => {})
            .then(async () => {
                await fs.mkdir(path.dirname(stateFile), { recursive: true });
                const tempFile = `${stateFile}.tmp`;
                await fs.writeFile(tempFile, payload);
                await fs.rename(tempFile, stateFile);
            });

        return this.persistChain;
    }

    async recover(config = this.lastConfig) {
        this.lastConfig = config;
        await this.hydrateFromDisk(config);
        await this.compactDuplicates();

        const timestamp = nowIso();
        let changed = false;
        for (const job of this.jobs.values()) {
            if (job.status !== DOWNLOAD_JOB_STATUSES.PROCESSING && job.status !== DOWNLOAD_JOB_STATUSES.PAUSED) continue;
            job.status = DOWNLOAD_JOB_STATUSES.QUEUED;
            job.progress = {
                ...(job.progress || {}),
                message: 'Queued after server restart',
                phase: 'queued',
                currentTrack: null,
            };
            job.error = null;
            job.failureCode = null;
            job.diagnostics = null;
            job.retryable = false;
            job.completedAt = null;
            job.cancelledAt = null;
            job.cancelReason = null;
            job.updatedAt = timestamp;
            changed = true;
        }

        if (changed) {
            await this.persistState();
        }

        this.schedule(config);
        return this.snapshot(config);
    }

    async enqueue(input, config = this.lastConfig) {
        this.lastConfig = config;
        await this.compactDuplicates();
        const payload = normalizePayload(input);

        const existingActiveJob = this.order
            .map((jobId) => this.jobs.get(jobId))
            .find(
                (job) =>
                    job &&
                    !TERMINAL_STATUSES.has(job.status) &&
                    job.type === payload.type &&
                    job.id === payload.id &&
                    job.quality === payload.quality
            );
        if (existingActiveJob) {
            return summarizeJob(existingActiveJob);
        }

        const duplicate = await duplicateExists(payload, config);
        const job = createJob(payload, duplicate ? {
            status: DOWNLOAD_JOB_STATUSES.COMPLETED,
            progress: baseProgress('Skipped existing local file', { percent: 100 }),
        } : {});

        if (duplicate) {
            job.result = { action: 'skipped-duplicate-before-queue', relativePath: payload.localRelativePath };
            job.completedAt = job.createdAt;
        }

        this.jobs.set(job.jobId, job);
        this.order.push(job.jobId);
        await this.persistJob(job);
        await this.persistOrder();

        if (!duplicate) {
            this.schedule(config);
        }

        return summarizeJob(job);
    }

    get(jobId) {
        const job = this.jobs.get(jobId);
        return job ? summarizeJob(job) : null;
    }

    cancel(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) return null;

        if (TERMINAL_STATUSES.has(job.status)) {
            return summarizeJob(job);
        }

        const timestamp = nowIso();
        job.status = DOWNLOAD_JOB_STATUSES.CANCELLED;
        job.progress = {
            ...job.progress,
            message: 'Cancelled',
        };
        job.updatedAt = timestamp;
        job.completedAt = timestamp;
        job.cancelledAt = timestamp;
        job.cancelReason = 'user-requested';

        const controller = this.activeControllers.get(jobId);
        controller?.abort();
        this.persistJob(job).catch(() => {});
        this.resolveIdleIfNeeded();
        return summarizeJob(job);
    }

    resetJobForRetry(job, message = 'Queued for retry', { preserveSkippedTracks = false } = {}) {
        const timestamp = nowIso();
        job.status = DOWNLOAD_JOB_STATUSES.QUEUED;
        job.progress = baseProgress(message);
        job.trackProgress = job.type === 'album' ? [] : null;
        job.publicationPhase = null;
        job.result = null;
        job.error = null;
        job.failureCode = null;
        job.diagnostics = null;
        job.retryable = false;
        job.startedAt = null;
        job.completedAt = null;
        job.cancelledAt = null;
        job.cancelReason = null;
        job.requeuedAsJobId = null;
        job.requeuedAt = null;
        job.restartRequested = false;
        if (!preserveSkippedTracks) {
            job.skippedTrackIds = [];
            job.missingTracks = [];
        }
        job.updatedAt = timestamp;
    }

    moveJobToBack(jobId) {
        const index = this.order.indexOf(jobId);
        if (index === -1 || index === this.order.length - 1) return false;
        this.order.splice(index, 1);
        this.order.push(jobId);
        return true;
    }

    async requeueInPlace(
        job,
        config = this.lastConfig,
        message = 'Queued for retry',
        { preserveSkippedTracks = false } = {}
    ) {
        if (!job || !TERMINAL_STATUSES.has(job.status)) return job ? summarizeJob(job) : null;

        if (this.activeControllers.has(job.jobId)) {
            job.restartRequested = true;
            job.progress = {
                ...(job.progress || {}),
                message: 'Restart requested; waiting for current worker to stop',
            };
            job.updatedAt = nowIso();
            await this.persistJob(job);
            return summarizeJob(job);
        }

        this.resetJobForRetry(job, message, { preserveSkippedTracks });
        const moved = this.moveJobToBack(job.jobId);
        await this.persistJob(job);
        if (moved) await this.persistOrder();
        this.schedule(config);
        return summarizeJob(job);
    }

    async retry(jobId, config = this.lastConfig) {
        await this.compactDuplicates();
        const existing = this.jobs.get(jobId);
        if (
            !existing ||
            ![DOWNLOAD_JOB_STATUSES.FAILED, DOWNLOAD_JOB_STATUSES.PARTIAL].includes(existing.status) ||
            !existing.retryable
        ) {
            return null;
        }

        return this.requeueInPlace(existing, config, 'Queued for retry');
    }

    async skipFailedTrack(jobId, config = this.lastConfig) {
        await this.compactDuplicates();
        const job = this.jobs.get(jobId);
        if (!job || job.type !== 'album' || job.status !== DOWNLOAD_JOB_STATUSES.FAILED) return null;

        const failedTrackId = job.progress?.failedTrack || job.progress?.currentTrack;
        if (!failedTrackId) return null;

        const skipped = new Set((job.skippedTrackIds || []).map((value) => String(value)));
        skipped.add(String(failedTrackId));
        job.skippedTrackIds = [...skipped];
        job.missingTracks = (job.tracks || [])
            .filter((track) => skipped.has(String(track?.id)))
            .map((track, index) => ({
                trackId: String(track.id),
                title: track.title || track.name || null,
                trackNumber: track.trackNumber || track.number || index + 1,
                discNumber: track.volumeNumber || track.discNumber || 1,
            }));

        return this.requeueInPlace(
            job,
            config,
            'Queued to continue with unavailable track skipped',
            { preserveSkippedTracks: true }
        );
    }

    async publishPartial(jobId, config = this.lastConfig) {
        await this.compactDuplicates();
        const job = this.jobs.get(jobId);
        if (
            !job ||
            job.type !== 'album' ||
            job.status !== DOWNLOAD_JOB_STATUSES.PARTIAL ||
            !job.result?.partial
        ) {
            return null;
        }
        if (job.result.partialPublished) return summarizeJob(job);

        const publication = await publishPartialAlbum({
            stagingAlbumDir: job.result.stagingAlbumDir,
            finalAlbumDir: job.result.finalAlbumDir,
            albumName: job.album?.title || job.album?.name || job.result.albumTitle || ('Album ' + job.id),
            jobId: job.jobId,
            publishLock: this.maintenanceLock,
        });

        const timestamp = nowIso();
        job.result = {
            ...job.result,
            ...publication,
            action: 'partial-published',
            partialPublished: true,
        };
        job.partialPublishedAt = timestamp;
        job.progress = {
            ...job.progress,
            message:
                'Partial - ' +
                Number(job.result.completedTracks || 0) +
                '/' +
                Number(job.result.totalTracks || 0) +
                ' tracks · in library',
            phase: 'partial',
        };
        job.updatedAt = timestamp;
        await this.persistJob(job);
        return summarizeJob(job);
    }

    async requeueAll(status, config = this.lastConfig) {
        await this.compactDuplicates();
        const matching = this.order
            .map((jobId) => this.jobs.get(jobId))
            .filter((job) => job?.status === status && !job.restartRequested);

        const jobs = [];
        for (const job of matching) {
            jobs.push(
                await this.requeueInPlace(
                    job,
                    config,
                    status === DOWNLOAD_JOB_STATUSES.CANCELLED ? 'Queued to resume' : 'Queued for retry'
                )
            );
        }

        return {
            success: true,
            sourceStatus: status,
            matched: matching.length,
            unique: matching.length,
            jobs,
        };
    }

    retryAllFailed(config = this.lastConfig) {
        return this.requeueAll(DOWNLOAD_JOB_STATUSES.FAILED, config);
    }

    resumeAllCancelled(config = this.lastConfig) {
        return this.requeueAll(DOWNLOAD_JOB_STATUSES.CANCELLED, config);
    }

    async snapshot(config = this.lastConfig) {
        this.lastConfig = config;
        await this.compactDuplicates();
        this.ensureStartupSweep(config);
        this.applyWorkerConfig(config);
        const jobs = this.order.map((jobId) => summarizeJob(this.jobs.get(jobId))).filter(Boolean);
        const counts = Object.values(DOWNLOAD_JOB_STATUSES).reduce((acc, status) => {
            acc[status] = 0;
            return acc;
        }, {});

        for (const job of jobs) {
            counts[job.status] = (counts[job.status] || 0) + 1;
        }

        const recoverable = {
            failed: jobs.filter((job) => job.status === DOWNLOAD_JOB_STATUSES.FAILED && !job.restartRequested).length,
            cancelled: jobs.filter((job) => job.status === DOWNLOAD_JOB_STATUSES.CANCELLED && !job.restartRequested).length,
        };

        return {
            success: true,
            backend: this.backend,
            fallback: this.fallbackReason
                ? {
                      from: 'redis',
                      to: 'memory',
                      reason: this.fallbackReason,
                  }
                : null,
            worker: {
                backend: this.backend,
                enabled: this.workerEnabled,
                active: this.activeWorkers,
                concurrency: config.workerConcurrency,
                reason: this.workerReason,
            },
            config: publicConfig(config),
            counts,
            recoverable,
            jobs,
        };
    }

    applyWorkerConfig(config = this.lastConfig) {
        this.workerEnabled = config.workerEnabled !== false;
        this.workerReason = this.workerEnabled ? null : 'Download worker is disabled by configuration.';
    }

    activeJobIds() {
        return this.order.filter((jobId) => {
            const job = this.jobs.get(jobId);
            return job && !TERMINAL_STATUSES.has(job.status);
        });
    }

    async sweep(config = this.lastConfig, options = {}) {
        return this.maintenanceLock.runExclusive(
            () =>
                sweepDownloadTransients({
                    config,
                    activeJobIds: this.activeJobIds(),
                    ...options,
                }),
            { timeoutMs: config.maintenanceLockTimeoutMs }
        );
    }

    ensureStartupSweep(config) {
        if (this.startupSweepPromise || !config.tempRoot) return;
        this.startupSweepPromise = this.sweep(config, { dryRun: false }).catch(() => null);
    }

    schedule(config = this.lastConfig) {
        this.lastConfig = config;
        this.ensureStartupSweep(config);
        this.applyWorkerConfig(config);
        if (!this.workerEnabled) {
            this.resolveIdleIfNeeded();
            return;
        }

        while (this.activeWorkers < config.workerConcurrency) {
            const job = this.nextQueuedJob();
            if (!job) break;
            this.startJob(job, config);
        }
        this.resolveIdleIfNeeded();
    }

    nextQueuedJob() {
        for (const jobId of this.order) {
            const job = this.jobs.get(jobId);
            if (job?.status === DOWNLOAD_JOB_STATUSES.QUEUED) {
                return job;
            }
        }
        return null;
    }

    startJob(job, config) {
        this.activeWorkers += 1;
        const controller = new AbortController();
        this.activeControllers.set(job.jobId, controller);
        const timestamp = nowIso();
        job.status = DOWNLOAD_JOB_STATUSES.PROCESSING;
        job.progress = baseProgress('Processing', { percent: 1 });
        job.startedAt = job.startedAt || timestamp;
        job.updatedAt = timestamp;
        job.attempts += 1;
        this.persistJob(job).catch(() => {});

        queueMicrotask(() => {
            this.runJob(job, config, controller).finally(async () => {
                this.activeWorkers -= 1;
                this.activeControllers.delete(job.jobId);

                if (job.restartRequested && TERMINAL_STATUSES.has(job.status)) {
                    this.resetJobForRetry(
                        job,
                        job.status === DOWNLOAD_JOB_STATUSES.CANCELLED ? 'Queued to resume' : 'Queued for retry'
                    );
                    const moved = this.moveJobToBack(job.jobId);
                    await this.persistJob(job);
                    if (moved) await this.persistOrder();
                }

                this.schedule(config);
                this.resolveIdleIfNeeded();
            });
        });
    }

    async runJob(job, config, controller) {
        try {
            let result;
            if (job.type === 'track') {
                result = await this.trackExecutor({
                    id: job.id,
                    quality: job.quality,
                    jobId: job.jobId,
                    config,
                    conflictPolicy: job.overwritePolicy,
                    track: job.track,
                    onProgress: (transfer) => this.updateTrackTransferProgress(job, transfer),
                    signal: controller.signal,
                });
            } else {
                result = await this.albumExecutor({
                    id: job.id,
                    quality: job.quality,
                    jobId: job.jobId,
                    config,
                    publishLock: this.maintenanceLock,
                    skipExistingComplete: config.duplicateCheckBeforeQueue,
                    album: job.album,
                    tracks: job.tracks,
                    signal: controller.signal,
                    onProgress: (event) => this.updateAlbumProgress(job, event),
                });
            }

            if (job.status === DOWNLOAD_JOB_STATUSES.CANCELLED || controller.signal.aborted) {
                return;
            }

            const timestamp = nowIso();
            job.status = DOWNLOAD_JOB_STATUSES.COMPLETED;
            job.result = {
                action: result.action,
                finalFile: result.finalFile || null,
                finalAlbumDir: result.finalAlbumDir || null,
                relativePath: result.relativePath || null,
                publishMethod: result.publishMethod || null,
                warnings: Array.isArray(result.warnings) ? result.warnings : [],
            };
            job.progress = baseProgress('Completed', { percent: 100, phase: 'completed' });
            job.error = null;
            job.failureCode = null;
            job.diagnostics = null;
            job.retryable = false;
            job.completedAt = timestamp;
            job.updatedAt = timestamp;
            await this.persistJob(job);
        } catch (error) {
            const timestamp = nowIso();
            if (job.status === DOWNLOAD_JOB_STATUSES.CANCELLED || controller.signal.aborted) {
                job.status = DOWNLOAD_JOB_STATUSES.CANCELLED;
                job.progress = { ...job.progress, message: 'Cancelled' };
                job.cancelledAt = job.cancelledAt || timestamp;
                job.completedAt = job.completedAt || timestamp;
                job.retryable = false;
                job.cancelReason = job.cancelReason || 'controller-aborted';
            } else {
                job.diagnostics = buildFailureDiagnostics(error, job, timestamp);
                job.status = DOWNLOAD_JOB_STATUSES.FAILED;
                job.error = sanitizeErrorMessage(error?.message || String(error));
                job.failureCode = error?.failureCode || 'DOWNLOAD_JOB_FAILED';
                job.cancelReason = null;
                job.retryable = isRetryableFailure(error);
                job.progress = {
                    ...job.progress,
                    message: 'Failed',
                    phase: 'failed',
                };
                job.completedAt = timestamp;
            }
            job.updatedAt = timestamp;
            await this.persistJob(job);
        }
    }

    updateTrackTransferProgress(job, transfer) {
        if (!transfer || job.status !== DOWNLOAD_JOB_STATUSES.PROCESSING) return;
        const timestamp = nowIso();
        const downloadedBytes = Number(transfer.downloadedBytes || 0);
        const totalBytes = Number(transfer.totalBytes || 0);
        const transferPercent =
            totalBytes > 0 ? Math.max(0, Math.min(99, Math.round((downloadedBytes / totalBytes) * 100))) : null;

        const retryWaitSeconds = Number(transfer.retryWaitSeconds || 0);
        job.progress = {
            ...job.progress,
            percent: transferPercent ?? job.progress.percent ?? 1,
            message:
                transfer.alternateSource
                    ? 'Trying alternate track source'
                    : retryWaitSeconds > 0
                      ? `Retrying track in ${retryWaitSeconds}s`
                      : 'Downloading track',
            phase: 'processing',
            downloadedBytes,
            totalBytes: totalBytes || null,
            transferPercent,
            segmentIndex: Number.isFinite(Number(transfer.segmentIndex)) ? Number(transfer.segmentIndex) : null,
            segmentCount: Number.isFinite(Number(transfer.segmentCount)) ? Number(transfer.segmentCount) : null,
            retryWaitMs: Number(transfer.retryWaitMs || 0) || null,
            retryWaitSeconds: retryWaitSeconds || null,
            retryAttempt: Number(transfer.retryAttempt || 0) || null,
            retryStatus: Number(transfer.retryStatus || 0) || null,
            retryAfter: transfer.retryAfter || null,
            alternateSource: Boolean(transfer.alternateSource),
            originalTrackId: transfer.originalTrackId || job.progress.originalTrackId || null,
            alternateTrackId: transfer.alternateTrackId || job.progress.alternateTrackId || null,
            alternateMatchScore:
                Number.isFinite(Number(transfer.alternateMatchScore))
                    ? Number(transfer.alternateMatchScore)
                    : job.progress.alternateMatchScore || null,
            alternateExactRecordingId:
                transfer.alternateExactRecordingId == null
                    ? Boolean(job.progress.alternateExactRecordingId)
                    : Boolean(transfer.alternateExactRecordingId),
            alternateExactIsrc:
                transfer.alternateExactIsrc == null
                    ? Boolean(job.progress.alternateExactIsrc)
                    : Boolean(transfer.alternateExactIsrc),
            alternateDurationVerified:
                transfer.alternateDurationVerified == null
                    ? Boolean(job.progress.alternateDurationVerified)
                    : Boolean(transfer.alternateDurationVerified),
            alternateDurationUnavailable:
                transfer.alternateDurationUnavailable == null
                    ? Boolean(job.progress.alternateDurationUnavailable)
                    : Boolean(transfer.alternateDurationUnavailable),
            alternateCandidatesConsidered:
                Number.isFinite(Number(transfer.alternateCandidatesConsidered))
                    ? Number(transfer.alternateCandidatesConsidered)
                    : job.progress.alternateCandidatesConsidered || null,
        };
        job.updatedAt = timestamp;
        this.persistJob(job).catch(() => {});
    }

    updateAlbumProgress(job, event) {
        if (!event || job.status === DOWNLOAD_JOB_STATUSES.CANCELLED) return;
        const timestamp = nowIso();
        const totalTracks = Number(event.totalTracks ?? job.progress.totalTracks ?? 0);
        const completedTracks = Number(event.completedTracks ?? job.progress.completedTracks ?? 0);
        const transferDownloaded = Number(event.trackTransfer?.downloadedBytes || 0);
        const transferTotal = Number(event.trackTransfer?.totalBytes || 0);
        const currentTrackFraction =
            transferTotal > 0 ? Math.max(0, Math.min(1, transferDownloaded / transferTotal)) : 0;
        const percent =
            totalTracks > 0
                ? Math.min(99, Math.round(((completedTracks + currentTrackFraction) / totalTracks) * 90))
                : 1;
        job.publicationPhase = event.phase || job.publicationPhase;
        const retryWaitSeconds = Number(event.trackTransfer?.retryWaitSeconds || 0);
        job.progress = {
            ...job.progress,
            percent: event.phase === 'publishing' ? 95 : percent,
            message:
                event.phase === 'publishing'
                    ? 'Publishing album'
                    : event.trackTransfer?.alternateSource
                      ? 'Trying alternate source for current track'
                      : retryWaitSeconds > 0
                        ? `Retrying current track in ${retryWaitSeconds}s`
                        : 'Processing album',
            phase: event.phase,
            totalTracks,
            completedTracks,
            currentTrack: event.currentTrack || null,
            failedTrack: event.failedTrack || job.progress.failedTrack || null,
            failedTracks: Array.isArray(event.failedTracks) ? event.failedTracks : job.progress.failedTracks || [],
            trackTransfer: event.trackTransfer || null,
            originalTrackId:
                event.trackTransfer?.originalTrackId || job.progress.originalTrackId || null,
            alternateTrackId:
                event.trackTransfer?.alternateTrackId || job.progress.alternateTrackId || null,
            alternateMatchScore:
                Number.isFinite(Number(event.trackTransfer?.alternateMatchScore))
                    ? Number(event.trackTransfer.alternateMatchScore)
                    : job.progress.alternateMatchScore || null,
            alternateExactRecordingId:
                event.trackTransfer?.alternateExactRecordingId == null
                    ? Boolean(job.progress.alternateExactRecordingId)
                    : Boolean(event.trackTransfer.alternateExactRecordingId),
            alternateExactIsrc:
                event.trackTransfer?.alternateExactIsrc == null
                    ? Boolean(job.progress.alternateExactIsrc)
                    : Boolean(event.trackTransfer.alternateExactIsrc),
            alternateDurationVerified:
                event.trackTransfer?.alternateDurationVerified == null
                    ? Boolean(job.progress.alternateDurationVerified)
                    : Boolean(event.trackTransfer.alternateDurationVerified),
            alternateDurationUnavailable:
                event.trackTransfer?.alternateDurationUnavailable == null
                    ? Boolean(job.progress.alternateDurationUnavailable)
                    : Boolean(event.trackTransfer.alternateDurationUnavailable),
            alternateCandidatesConsidered:
                Number.isFinite(Number(event.trackTransfer?.alternateCandidatesConsidered))
                    ? Number(event.trackTransfer.alternateCandidatesConsidered)
                    : job.progress.alternateCandidatesConsidered || null,
        };
        if (event.trackProgress) {
            job.trackProgress = event.trackProgress;
        }
        if (event.error) {
            job.error = sanitizeErrorMessage(event.error);
            job.failureCode = event.failureCode || job.failureCode;
        }
        job.updatedAt = timestamp;
        this.persistJob(job).catch(() => {});
    }

    async persistJob() {
        await this.persistState();
    }

    async persistOrder() {
        await this.persistState();
    }

    waitForIdle({ timeoutMs = 5000 } = {}) {
        if (this.isIdle()) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timed out waiting for download queue to become idle'));
            }, timeoutMs);
            this.idleResolvers.push(() => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }

    waitForIdleForTests(options = {}) {
        return this.waitForIdle(options);
    }

    async clear(config = this.lastConfig, { cleanup = false } = {}) {
        this.lastConfig = config;
        const clearedJobs = this.order.length;

        for (const controller of this.activeControllers.values()) {
            controller.abort();
        }

        this.jobs.clear();
        this.order = [];
        await this.clearPersistedState();

        let cleanupResult = null;
        if (cleanup) {
            await this.waitForIdle({ timeoutMs: Math.max(config.maintenanceLockTimeoutMs || 30000, 5000) });
            cleanupResult = await this.maintenanceLock.runExclusive(
                () =>
                    sweepDownloadTransients({
                        config,
                        activeJobIds: [],
                        minAgeMs: 0,
                        dryRun: false,
                    }),
                { timeoutMs: config.maintenanceLockTimeoutMs }
            );
        }

        this.resolveIdleIfNeeded();
        return {
            success: true,
            clearedJobs,
            cleanup: Boolean(cleanup),
            cleanupActions: cleanupResult?.actions || [],
        };
    }

    async clearPersistedState() {
        await this.persistState();
    }

    isIdle() {
        return this.activeWorkers === 0 && !this.order.some((jobId) => {
            return this.jobs.get(jobId)?.status === DOWNLOAD_JOB_STATUSES.QUEUED;
        });
    }

    resolveIdleIfNeeded() {
        if (!this.isIdle()) return;
        const resolvers = this.idleResolvers.splice(0);
        for (const resolve of resolvers) resolve();
    }

    resetForTests() {
        this.jobs.clear();
        this.order = [];
        this.activeWorkers = 0;
        for (const controller of this.activeControllers.values()) {
            controller.abort();
        }
        this.activeControllers.clear();
        this.startupSweepPromise = null;
        this.hydratedStateFile = null;
        this.persistChain = Promise.resolve();
        this.idleResolvers.splice(0).forEach((resolve) => resolve());
    }
}

export class RedisDownloadQueue extends MemoryDownloadQueue {
    constructor({ client, keyPrefix = 'monochrome:downloads', ...options } = {}) {
        super({ ...options, backend: 'redis' });
        this.client = client;
        this.keyPrefix = keyPrefix;
        this.jobsKey = `${keyPrefix}:jobs`;
        this.orderKey = `${keyPrefix}:order`;
    }

    async hydrateFromRedis() {
        const ids = await this.client.lRange(this.orderKey, 0, -1);
        if (!ids.length) return;

        const values = await this.client.hmGet(this.jobsKey, ids);
        this.jobs.clear();
        this.order = [];
        ids.forEach((id, index) => {
            const raw = values[index];
            if (!raw) return;
            const job = JSON.parse(raw);
            this.jobs.set(id, job);
            this.order.push(id);
        });
    }

    async enqueue(input, config = this.lastConfig) {
        await this.hydrateFromRedis();
        return super.enqueue(input, config);
    }

    async get(jobId) {
        const raw = await this.client.hGet(this.jobsKey, jobId);
        if (!raw) return null;
        return summarizeJob(JSON.parse(raw));
    }

    async cancel(jobId) {
        await this.hydrateFromRedis();
        return super.cancel(jobId);
    }

    async retry(jobId, config = this.lastConfig) {
        await this.hydrateFromRedis();
        return super.retry(jobId, config);
    }

    async retryAllFailed(config = this.lastConfig) {
        await this.hydrateFromRedis();
        return super.retryAllFailed(config);
    }

    async resumeAllCancelled(config = this.lastConfig) {
        await this.hydrateFromRedis();
        return super.resumeAllCancelled(config);
    }

    async snapshot(config = this.lastConfig) {
        await this.hydrateFromRedis();
        return super.snapshot(config);
    }

    async recover(config = this.lastConfig) {
        await this.hydrateFromRedis();
        return super.recover(config);
    }

    async persistJob(job) {
        await this.client.hSet(this.jobsKey, job.jobId, JSON.stringify(job));
    }

    async deletePersistedJobs(jobIds) {
        for (const jobId of jobIds) {
            await this.client.hDel(this.jobsKey, jobId);
        }
    }

    async persistOrder() {
        await this.client.del(this.orderKey);
        if (this.order.length) {
            await this.client.rPush(this.orderKey, this.order);
        }
    }

    async clearPersistedState() {
        await this.client.del(this.jobsKey);
        await this.client.del(this.orderKey);
    }
}

export class DownloadQueueManager {
    constructor({ memoryQueue = null } = {}) {
        this.memoryQueue = memoryQueue || new MemoryDownloadQueue();
        this.redisQueue = null;
        this.redisUrl = null;
        this.redisFailureReason = null;
    }

    async backendFor(config) {
        if (!config.redisUrl) {
            this.memoryQueue.fallbackReason = null;
            return this.memoryQueue;
        }

        if (this.redisQueue && this.redisUrl === config.redisUrl) {
            return this.redisQueue;
        }

        let client = null;
        try {
            const { createClient } = await import('redis');
            client = createClient({
                url: config.redisUrl,
                socket: {
                    connectTimeout: 250,
                    reconnectStrategy: false,
                },
            });
            client.on('error', () => {});
            await Promise.race([
                client.connect(),
                new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Redis connection timed out')), 750);
                }),
            ]);
            this.redisQueue = new RedisDownloadQueue({
                client,
                trackExecutor: this.memoryQueue.trackExecutor,
                albumExecutor: this.memoryQueue.albumExecutor,
                maintenanceLock: new RedisMaintenanceLock({
                    client,
                    ttlMs: config.maintenanceLockTimeoutMs,
                }),
            });
            this.redisUrl = config.redisUrl;
            this.redisFailureReason = null;
            return this.redisQueue;
        } catch (error) {
            try {
                client?.destroy?.();
            } catch {
                // The Redis client may already be closed after a failed connection attempt.
            }
            this.redisQueue = null;
            this.redisUrl = null;
            this.redisFailureReason = error?.message || 'Redis queue backend is unavailable.';
        }
        this.memoryQueue.fallbackReason = this.redisFailureReason;
        return this.memoryQueue;
    }

    async enqueue(input, config) {
        const backend = await this.backendFor(config);
        return backend.enqueue(input, config);
    }

    async get(jobId, config = this.memoryQueue.lastConfig) {
        const backend = await this.backendFor(config);
        return backend.get(jobId);
    }

    async cancel(jobId, config = this.memoryQueue.lastConfig) {
        const backend = await this.backendFor(config);
        return backend.cancel(jobId);
    }

    async retry(jobId, config) {
        const backend = await this.backendFor(config);
        return backend.retry(jobId, config);
    }

    async retryAllFailed(config) {
        const backend = await this.backendFor(config);
        if (backend instanceof RedisDownloadQueue) await backend.hydrateFromRedis();
        else if (backend instanceof MemoryDownloadQueue) await backend.hydrateFromDisk(config);
        return backend.retryAllFailed(config);
    }

    async resumeAllCancelled(config) {
        const backend = await this.backendFor(config);
        if (backend instanceof RedisDownloadQueue) await backend.hydrateFromRedis();
        else if (backend instanceof MemoryDownloadQueue) await backend.hydrateFromDisk(config);
        return backend.resumeAllCancelled(config);
    }

    async snapshot(config) {
        const backend = await this.backendFor(config);
        return backend.snapshot(config);
    }

    async sweep(config, options) {
        const backend = await this.backendFor(config);
        return backend.sweep(config, options);
    }

    async recover(config) {
        const backend = await this.backendFor(config);
        return backend.recover(config);
    }

    async clear(config, options = {}) {
        const backend = await this.backendFor(config);
        if (backend instanceof RedisDownloadQueue) {
            await backend.hydrateFromRedis();
        } else if (backend instanceof MemoryDownloadQueue) {
            await backend.hydrateFromDisk(config);
        }
        return backend.clear(config, options);
    }

    resetForTests() {
        this.redisFailureReason = null;
        this.redisQueue = null;
        this.redisUrl = null;
        this.memoryQueue.resetForTests();
    }
}

export const downloadQueue = new DownloadQueueManager();
