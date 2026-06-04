import fs from 'node:fs/promises';
import path from 'node:path';
import { getDownloadsConfig, publicConfig } from './config.js';
import { defaultMaintenanceLock, RedisMaintenanceLock, sweepDownloadTransients } from './maintenance.js';
import { executeAlbumDownload } from './album-pipeline.js';
import { executeTrackDownload } from './track-pipeline.js';

export const DOWNLOAD_JOB_STATUSES = Object.freeze({
    QUEUED: 'queued',
    PROCESSING: 'processing',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

const TERMINAL_STATUSES = new Set([
    DOWNLOAD_JOB_STATUSES.COMPLETED,
    DOWNLOAD_JOB_STATUSES.FAILED,
    DOWNLOAD_JOB_STATUSES.CANCELLED,
]);

const RETRYABLE_FAILURE_CODES = new Set([
    'CDN_FETCH_FAILED',
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
    return {
        jobId: job.jobId,
        type: job.type,
        id: job.id,
        quality: job.quality,
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
        retryable: job.retryable,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        cancelledAt: job.cancelledAt,
    };
}

function isRetryableFailure(error) {
    if (error?.name === 'AbortError') return false;
    return RETRYABLE_FAILURE_CODES.has(error?.failureCode);
}

function isAbortError(error) {
    return error?.name === 'AbortError' || error?.failureCode === 'ALBUM_DOWNLOAD_CANCELLED';
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
        retryable: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
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
    } = {}) {
        this.jobs = new Map();
        this.order = [];
        this.backend = backend;
        this.fallbackReason = fallbackReason;
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
    }

    async enqueue(input, config = this.lastConfig) {
        this.lastConfig = config;
        const payload = normalizePayload(input);

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

        const controller = this.activeControllers.get(jobId);
        controller?.abort();
        this.persistJob(job).catch(() => {});
        this.resolveIdleIfNeeded();
        return summarizeJob(job);
    }

    async retry(jobId, config = this.lastConfig) {
        const existing = this.jobs.get(jobId);
        if (!existing || existing.status !== DOWNLOAD_JOB_STATUSES.FAILED || !existing.retryable) {
            return null;
        }

        return this.enqueue(
            {
                type: existing.type,
                id: existing.id,
                quality: existing.quality,
                forceOverwrite: existing.forceOverwrite,
                overwritePolicy: existing.overwritePolicy,
                musicBrainzReleaseId: existing.musicBrainzReleaseId,
                localRelativePath: existing.localRelativePath,
            },
            config
        );
    }

    snapshot(config = this.lastConfig) {
        this.lastConfig = config;
        this.ensureStartupSweep(config);
        const jobs = this.order.map((jobId) => summarizeJob(this.jobs.get(jobId))).filter(Boolean);
        const counts = Object.values(DOWNLOAD_JOB_STATUSES).reduce((acc, status) => {
            acc[status] = 0;
            return acc;
        }, {});

        for (const job of jobs) {
            counts[job.status] = (counts[job.status] || 0) + 1;
        }

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
            jobs,
        };
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
        this.workerEnabled = config.workerEnabled !== false;
        this.workerReason = this.workerEnabled ? null : 'Download worker is disabled by configuration.';
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
            this.runJob(job, config, controller).finally(() => {
                this.activeWorkers -= 1;
                this.activeControllers.delete(job.jobId);
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
            };
            job.progress = baseProgress('Completed', { percent: 100, phase: 'completed' });
            job.error = null;
            job.failureCode = null;
            job.retryable = false;
            job.completedAt = timestamp;
            job.updatedAt = timestamp;
            await this.persistJob(job);
        } catch (error) {
            const timestamp = nowIso();
            if (job.status === DOWNLOAD_JOB_STATUSES.CANCELLED || isAbortError(error)) {
                job.status = DOWNLOAD_JOB_STATUSES.CANCELLED;
                job.progress = { ...job.progress, message: 'Cancelled' };
                job.cancelledAt = job.cancelledAt || timestamp;
                job.completedAt = job.completedAt || timestamp;
                job.retryable = false;
            } else {
                job.status = DOWNLOAD_JOB_STATUSES.FAILED;
                job.error = error?.message || String(error);
                job.failureCode = error?.failureCode || 'DOWNLOAD_JOB_FAILED';
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

    updateAlbumProgress(job, event) {
        if (!event || job.status === DOWNLOAD_JOB_STATUSES.CANCELLED) return;
        const timestamp = nowIso();
        const totalTracks = Number(event.totalTracks || job.progress.totalTracks || 0);
        const completedTracks = Number(event.completedTracks || 0);
        const percent = totalTracks > 0 ? Math.min(99, Math.round((completedTracks / totalTracks) * 90)) : 1;
        job.publicationPhase = event.phase || job.publicationPhase;
        job.progress = {
            ...job.progress,
            percent: event.phase === 'publishing' ? 95 : percent,
            message: event.phase === 'publishing' ? 'Publishing album' : 'Processing album',
            phase: event.phase,
            totalTracks,
            completedTracks,
            currentTrack: event.currentTrack || null,
            failedTrack: event.failedTrack || null,
        };
        if (event.trackProgress) {
            job.trackProgress = event.trackProgress;
        }
        if (event.error) {
            job.error = event.error;
            job.failureCode = event.failureCode || job.failureCode;
        }
        job.updatedAt = timestamp;
        this.persistJob(job).catch(() => {});
    }

    async persistJob() {}

    async persistOrder() {}

    waitForIdleForTests({ timeoutMs = 5000 } = {}) {
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

    async snapshot(config = this.lastConfig) {
        await this.hydrateFromRedis();
        return super.snapshot(config);
    }

    async persistJob(job) {
        await this.client.hSet(this.jobsKey, job.jobId, JSON.stringify(job));
    }

    async persistOrder() {
        await this.client.del(this.orderKey);
        if (this.order.length) {
            await this.client.rPush(this.orderKey, this.order);
        }
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

    async snapshot(config) {
        const backend = await this.backendFor(config);
        return backend.snapshot(config);
    }

    async sweep(config, options) {
        const backend = await this.backendFor(config);
        return backend.sweep(config, options);
    }

    resetForTests() {
        this.redisFailureReason = null;
        this.redisQueue = null;
        this.redisUrl = null;
        this.memoryQueue.resetForTests();
    }
}

export const downloadQueue = new DownloadQueueManager();
