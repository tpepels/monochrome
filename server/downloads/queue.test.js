import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, beforeEach } from 'vitest';
import { getDownloadsConfig } from './config.js';
import { downloadQueue, MemoryDownloadQueue } from './queue.js';
import { onRequest as onDownloadsRequest } from '../../functions/api/downloads/index.js';
import { onRequest as onJobRequest } from '../../functions/api/downloads/[jobId].js';
import { onRequest as onCancelRequest } from '../../functions/api/downloads/[jobId]/cancel.js';
import { onRequest as onRetryRequest } from '../../functions/api/downloads/[jobId]/retry.js';
import { onRequest as onSkipTrackRequest } from '../../functions/api/downloads/[jobId]/skip-track.js';
import { onRequest as onPublishPartialRequest } from '../../functions/api/downloads/[jobId]/publish-partial.js';
import { onRequest as onResetRequest } from '../../functions/api/downloads/reset.js';
import { onRequest as onRetryFailedRequest } from '../../functions/api/downloads/retry-failed.js';
import { onRequest as onResumeCancelledRequest } from '../../functions/api/downloads/resume-cancelled.js';

function context(request, params = {}) {
    return {
        request,
        params,
        env: {
            TEMP_DIR: '/tmp/test-downloads',
            DOWNLOAD_DIR: '/music',
            DOWNLOAD_WORKER_ENABLED: 'false',
            DOWNLOAD_WORKER_CONCURRENCY: '2',
        },
    };
}

describe('server download API', () => {
    beforeEach(() => {
        downloadQueue.resetForTests();
    });

    test('queues a track download request', async () => {
        const response = await onDownloadsRequest(
            context(
                new Request('https://example.test/api/downloads', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ type: 'track', id: '123', quality: 'LOSSLESS' }),
                })
            )
        );
        const body = await response.json();

        expect(response.status).toBe(202);
        expect(body.success).toBe(true);
        expect(body.jobId).toBeTruthy();
        expect(body.job).toMatchObject({
            type: 'track',
            id: '123',
            quality: 'LOSSLESS',
            status: 'queued',
        });
    });

    test('persists queue state to disk and restores it in a new queue instance', async () => {
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'monochrome-queue-state-'));
        const config = getDownloadsConfig({
            TEMP_DIR: tempRoot,
            DOWNLOAD_DIR: '/music',
            DOWNLOAD_WORKER_ENABLED: 'false',
        });

        try {
            const firstQueue = new MemoryDownloadQueue({ persistToDisk: true });
            const queued = await firstQueue.enqueue(
                {
                    type: 'album',
                    id: 'durable-album',
                    quality: 'LOSSLESS',
                    album: { id: 'durable-album', title: 'Durable Album' },
                    tracks: [{ id: 'track-1', title: 'Track One' }],
                },
                config
            );
            const internal = firstQueue.jobs.get(queued.jobId);
            internal.status = 'processing';
            internal.progress = {
                percent: 50,
                message: 'Processing album',
                phase: 'processing',
                totalTracks: 2,
                completedTracks: 1,
                currentTrack: 'track-2',
            };
            await firstQueue.persistJob(internal);

            const secondQueue = new MemoryDownloadQueue({ persistToDisk: true });
            const snapshot = await secondQueue.recover(config);
            const restored = snapshot.jobs.find((job) => job.jobId === queued.jobId);

            expect(restored).toMatchObject({
                type: 'album',
                id: 'durable-album',
                status: 'queued',
            });
            expect(restored.progress).toMatchObject({
                percent: 50,
                completedTracks: 1,
                message: 'Queued after server restart',
                phase: 'queued',
                currentTrack: null,
            });
            expect(secondQueue.jobs.get(queued.jobId).album.title).toBe('Durable Album');
            expect(secondQueue.jobs.get(queued.jobId).tracks).toHaveLength(1);
        } finally {
            await fs.rm(tempRoot, { recursive: true, force: true });
        }
    });

    test('shows server-directed retry waits for album track transfers', async () => {
        const config = getDownloadsConfig(context({}).env);
        const queued = await downloadQueue.enqueue(
            { type: 'album', id: 'retry-after-album', quality: 'HI_RES_LOSSLESS' },
            config
        );
        const internal = downloadQueue.memoryQueue.jobs.get(queued.jobId);
        internal.status = 'processing';

        downloadQueue.memoryQueue.updateAlbumProgress(internal, {
            phase: 'processing',
            currentTrack: 'track-1',
            totalTracks: 12,
            completedTracks: 0,
            trackTransfer: {
                retryWaitMs: 60_000,
                retryWaitSeconds: 60,
                retryAttempt: 2,
                retryStatus: 502,
                retryAfter: '60',
            },
        });

        expect(downloadQueue.memoryQueue.get(queued.jobId).progress).toMatchObject({
            message: 'Retrying current track in 60s',
            currentTrack: 'track-1',
            trackTransfer: {
                retryWaitSeconds: 60,
                retryAttempt: 2,
                retryStatus: 502,
                retryAfter: '60',
            },
        });
    });

    test('shows yt-dlp fallback progress for an album track', async () => {
        const config = getDownloadsConfig(context({}).env);
        const queued = await downloadQueue.enqueue(
            { type: 'album', id: 'fallback-album', quality: 'HI_RES_LOSSLESS' },
            config
        );
        const internal = downloadQueue.memoryQueue.jobs.get(queued.jobId);
        internal.status = 'processing';

        downloadQueue.memoryQueue.updateAlbumProgress(internal, {
            phase: 'processing',
            currentTrack: 'track-2',
            totalTracks: 10,
            completedTracks: 1,
            trackTransfer: {
                ytDlpFallback: true,
                ytDlpFallbackProvider: 'spotdl',
            },
        });

        expect(downloadQueue.memoryQueue.get(queued.jobId).progress).toMatchObject({
            message: 'Trying yt-dlp fallback',
            currentTrack: 'track-2',
            ytDlpFallback: true,
            ytDlpFallbackProvider: 'spotdl',
        });
    });

    test('requeues interrupted jobs during recovery', async () => {
        const config = getDownloadsConfig(context({}).env);
        const job = await downloadQueue.enqueue({ type: 'album', id: 'resume-album', quality: 'LOSSLESS' }, config);
        const internalJob = downloadQueue.memoryQueue.jobs.get(job.jobId);
        internalJob.status = 'processing';
        internalJob.progress = {
            percent: 45,
            message: 'Processing album',
            phase: 'processing',
            totalTracks: 10,
            completedTracks: 5,
            currentTrack: 'track-6',
        };

        const snapshot = await downloadQueue.recover(config);
        const recovered = snapshot.jobs.find((item) => item.jobId === job.jobId);

        expect(recovered.status).toBe('queued');
        expect(recovered.progress).toMatchObject({
            percent: 45,
            completedTracks: 5,
            message: 'Queued after server restart',
            phase: 'queued',
            currentTrack: null,
        });
    });

    test('reuses an existing active job for duplicate queue requests', async () => {
        const config = getDownloadsConfig(context({}).env);
        const first = await downloadQueue.enqueue({ type: 'album', id: 'same-album', quality: 'LOSSLESS' }, config);
        const second = await downloadQueue.enqueue({ type: 'album', id: 'same-album', quality: 'LOSSLESS' }, config);

        expect(second.jobId).toBe(first.jobId);

        const snapshot = await downloadQueue.snapshot(config);
        expect(snapshot.jobs).toHaveLength(1);
        expect(snapshot.counts.queued).toBe(1);
    });

    test('skip-track API requeues a failed album with the current track marked unavailable', async () => {
        const config = getDownloadsConfig(context({}).env);
        const queued = await downloadQueue.enqueue(
            {
                type: 'album',
                id: 'skip-api-album',
                quality: 'LOSSLESS',
                album: { id: 'skip-api-album', title: 'Skip API Album' },
                tracks: [
                    { id: 't1', title: 'One', trackNumber: 1 },
                    { id: 't2', title: 'Two', trackNumber: 2 },
                ],
            },
            config
        );
        const internal = downloadQueue.memoryQueue.jobs.get(queued.jobId);
        internal.status = 'failed';
        internal.retryable = true;
        internal.progress = {
            percent: 50,
            message: 'Failed',
            phase: 'failed',
            totalTracks: 2,
            completedTracks: 1,
            failedTrack: 't2',
            currentTrack: 't2',
        };

        const response = await onSkipTrackRequest(
            context(
                new Request('https://example.test/api/downloads/' + queued.jobId + '/skip-track', {
                    method: 'POST',
                }),
                { jobId: queued.jobId }
            )
        );
        const body = await response.json();

        expect(response.status).toBe(202);
        expect(body.job).toMatchObject({
            jobId: queued.jobId,
            status: 'queued',
            skippedTrackIds: ['t2'],
        });
    });

    test('publish-partial API rejects jobs that are not partial', async () => {
        const queued = await downloadQueue.enqueue(
            { type: 'album', id: 'not-partial', quality: 'LOSSLESS' },
            getDownloadsConfig(context({}).env)
        );

        const response = await onPublishPartialRequest(
            context(
                new Request('https://example.test/api/downloads/' + queued.jobId + '/publish-partial', {
                    method: 'POST',
                }),
                { jobId: queued.jobId }
            )
        );
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.failureCode).toBe('PARTIAL_ALBUM_NOT_PUBLISHABLE');
    });

    test('resets the queue through the API', async () => {
        const config = getDownloadsConfig(context({}).env);
        await downloadQueue.enqueue({ type: 'album', id: 'album-a', quality: 'LOSSLESS' }, config);
        await downloadQueue.enqueue({ type: 'album', id: 'album-b', quality: 'LOSSLESS' }, config);

        const response = await onResetRequest(
            context(new Request('https://example.test/api/downloads/reset', { method: 'POST' }))
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
            success: true,
            clearedJobs: 2,
            cleanup: false,
        });

        const snapshot = await downloadQueue.snapshot(config);
        expect(snapshot.jobs).toHaveLength(0);
        expect(snapshot.counts.queued).toBe(0);
        expect(snapshot.counts.processing).toBe(0);
    });

    test('rejects invalid queue requests', async () => {
        const response = await onDownloadsRequest(
            context(
                new Request('https://example.test/api/downloads', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ type: 'playlist', id: '123', quality: 'LOSSLESS' }),
                })
            )
        );
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.success).toBe(false);
        expect(body.failureCode).toBe('INVALID_DOWNLOAD_TYPE');
    });

    test('returns queue snapshot and worker config', async () => {
        await downloadQueue.enqueue({ type: 'album', id: 'abc', quality: 'HI_RES_LOSSLESS' }, getDownloadsConfig(context({}).env));

        const response = await onDownloadsRequest(context(new Request('https://example.test/api/downloads')));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.jobs).toHaveLength(1);
        expect(body.counts.queued).toBe(1);
        expect(body.worker).toMatchObject({
            backend: 'memory',
            enabled: false,
            concurrency: 2,
            reason: 'Download worker is disabled by configuration.',
        });
        expect(body.config.downloadRootConfigured).toBe(true);
    });

    test('reports disabled worker config before any job is queued', async () => {
        const response = await onDownloadsRequest(context(new Request('https://example.test/api/downloads')));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.jobs).toHaveLength(0);
        expect(body.worker).toMatchObject({
            enabled: false,
            reason: 'Download worker is disabled by configuration.',
        });
    });

    test('returns a single job and cancels it', async () => {
        const job = await downloadQueue.enqueue(
            { type: 'track', id: '123', quality: 'LOSSLESS' },
            getDownloadsConfig(context({}).env)
        );

        const getResponse = await onJobRequest(
            context(new Request(`https://example.test/api/downloads/${job.jobId}`), { jobId: job.jobId })
        );
        const getBody = await getResponse.json();

        expect(getResponse.status).toBe(200);
        expect(getBody.job.status).toBe('queued');

        const cancelResponse = await onCancelRequest(
            context(new Request(`https://example.test/api/downloads/${job.jobId}/cancel`, { method: 'POST' }), {
                jobId: job.jobId,
            })
        );
        const cancelBody = await cancelResponse.json();

        expect(cancelResponse.status).toBe(200);
        expect(cancelBody.job.status).toBe('cancelled');
    });

    test('preserves sanitized diagnostics for failed jobs', async () => {
        const originalExecutor = downloadQueue.memoryQueue.trackExecutor;
        downloadQueue.memoryQueue.trackExecutor = async () => {
            const error = new Error(
                'CDN fetch failed at https://cdn.example.test/audio.flac?token=secret&expires=123 HTTP 520'
            );
            error.failureCode = 'CDN_FETCH_FAILED';
            error.status = 520;
            error.url = 'https://cdn.example.test/audio.flac?token=secret&expires=123';
            error.cfRay = 'test-ray';
            error.retryAfter = '60';
            error.transferAttempt = 3;
            error.maxTransferAttempts = 3;
            error.segmentIndex = 0;
            error.segmentCount = 1;
            error.cause = Object.assign(new Error('socket closed by peer'), { code: 'ECONNRESET' });
            throw error;
        };

        try {
            const config = getDownloadsConfig({
                TEMP_DIR: '/tmp/test-downloads',
                DOWNLOAD_DIR: '/music',
                DOWNLOAD_WORKER_ENABLED: 'true',
            });
            const queued = await downloadQueue.enqueue(
                { type: 'track', id: 'diagnostic-track', quality: 'LOSSLESS' },
                config
            );
            await downloadQueue.memoryQueue.waitForIdleForTests();

            const failed = downloadQueue.memoryQueue.get(queued.jobId);
            expect(failed).toMatchObject({
                status: 'failed',
                failureCode: 'CDN_FETCH_FAILED',
                attempts: 1,
                retryable: true,
            });
            expect(failed.diagnostics).toMatchObject({
                error: {
                    failureCode: 'CDN_FETCH_FAILED',
                    httpStatus: 520,
                    requestUrl: 'https://cdn.example.test/audio.flac',
                    cfRay: 'test-ray',
                    retryAfter: '60',
                    transferAttempt: 3,
                    maxTransferAttempts: 3,
                    segmentIndex: 0,
                    segmentCount: 1,
                    causeCode: 'ECONNRESET',
                    causeMessage: 'socket closed by peer',
                },
                state: {
                    jobId: queued.jobId,
                    id: 'diagnostic-track',
                    quality: 'LOSSLESS',
                    queueAttempt: 1,
                    statusAtFailure: 'processing',
                },
            });
            expect(failed.error).toContain('https://cdn.example.test/audio.flac');
            expect(failed.error).not.toContain('token=secret');
            expect(JSON.stringify(failed.diagnostics)).not.toContain('token=secret');
        } finally {
            downloadQueue.memoryQueue.trackExecutor = originalExecutor;
        }
    });

    test('does not classify an unexpected AbortError as a cancellation', async () => {
        const queue = new MemoryDownloadQueue({
            persistToDisk: false,
            trackExecutor: async () => {
                throw new DOMException('provider aborted unexpectedly', 'AbortError');
            },
        });
        const config = getDownloadsConfig({
            TEMP_DIR: '/tmp/test-downloads',
            DOWNLOAD_DIR: '/music',
            DOWNLOAD_WORKER_ENABLED: 'true',
        });

        const queued = await queue.enqueue({ type: 'track', id: 'abort-track', quality: 'LOSSLESS' }, config);
        await queue.waitForIdleForTests();

        expect(queue.get(queued.jobId)).toMatchObject({
            status: 'failed',
            failureCode: 'DOWNLOAD_JOB_FAILED',
            cancelReason: null,
        });
    });

    test('bulk retries every failed download and resumes every cancelled download', async () => {
        const config = getDownloadsConfig(context({}).env);
        const failed = await downloadQueue.enqueue({ type: 'track', id: 'failed-track', quality: 'LOSSLESS' }, config);
        const cancelled = await downloadQueue.enqueue(
            { type: 'album', id: 'cancelled-album', quality: 'HI_RES_LOSSLESS' },
            config
        );

        const failedInternal = downloadQueue.memoryQueue.jobs.get(failed.jobId);
        failedInternal.status = 'failed';
        failedInternal.failureCode = 'PERMANENT_TEST_FAILURE';
        failedInternal.retryable = false;

        const cancelledInternal = downloadQueue.memoryQueue.jobs.get(cancelled.jobId);
        cancelledInternal.status = 'cancelled';
        cancelledInternal.cancelledAt = new Date().toISOString();
        cancelledInternal.cancelReason = 'user-requested';

        const retryResponse = await onRetryFailedRequest(
            context(new Request('https://example.test/api/downloads/retry-failed', { method: 'POST' }))
        );
        const retryBody = await retryResponse.json();

        expect(retryResponse.status).toBe(202);
        expect(retryBody).toMatchObject({
            success: true,
            sourceStatus: 'failed',
            matched: 1,
            unique: 1,
        });
        expect(retryBody.jobs).toHaveLength(1);
        expect(retryBody.jobs[0]).toMatchObject({
            jobId: failed.jobId,
            id: 'failed-track',
            status: 'queued',
        });

        const resumeResponse = await onResumeCancelledRequest(
            context(new Request('https://example.test/api/downloads/resume-cancelled', { method: 'POST' }))
        );
        const resumeBody = await resumeResponse.json();

        expect(resumeResponse.status).toBe(202);
        expect(resumeBody).toMatchObject({
            success: true,
            sourceStatus: 'cancelled',
            matched: 1,
            unique: 1,
        });
        expect(resumeBody.jobs).toHaveLength(1);
        expect(resumeBody.jobs[0]).toMatchObject({
            jobId: cancelled.jobId,
            id: 'cancelled-album',
            status: 'queued',
        });

        const snapshot = await downloadQueue.snapshot(config);
        expect(snapshot.recoverable).toEqual({ failed: 0, cancelled: 0 });
        expect(snapshot.jobs.filter((job) => job.id === 'failed-track')).toHaveLength(1);
        expect(snapshot.jobs.filter((job) => job.id === 'cancelled-album')).toHaveLength(1);
        expect(snapshot.jobs.find((job) => job.id === 'failed-track')?.jobId).toBe(failed.jobId);
        expect(snapshot.jobs.find((job) => job.id === 'cancelled-album')?.jobId).toBe(cancelled.jobId);

        const secondRetry = await onRetryFailedRequest(
            context(new Request('https://example.test/api/downloads/retry-failed', { method: 'POST' }))
        );
        const secondRetryBody = await secondRetry.json();
        expect(secondRetryBody).toMatchObject({ matched: 0, unique: 0 });

        const secondResume = await onResumeCancelledRequest(
            context(new Request('https://example.test/api/downloads/resume-cancelled', { method: 'POST' }))
        );
        const secondResumeBody = await secondResume.json();
        expect(secondResumeBody).toMatchObject({ matched: 0, unique: 0 });
    });

    test('compacts duplicate queue history to one canonical entry per reference', async () => {
        const queue = new MemoryDownloadQueue({ persistToDisk: false });
        const config = getDownloadsConfig({
            TEMP_DIR: '/tmp/test-downloads',
            DOWNLOAD_DIR: '/music',
            DOWNLOAD_WORKER_ENABLED: 'false',
        });
        const basePayload = { type: 'album', id: 'same-album', quality: 'LOSSLESS' };

        const older = {
            ...basePayload,
            jobId: 'old-failed',
            status: 'failed',
            progress: { message: 'Failed' },
            error: 'old failure',
            failureCode: 'CDN_FETCH_FAILED',
            retryable: true,
            createdAt: '2026-09-26T17:00:00.000Z',
            updatedAt: '2026-09-26T18:00:00.000Z',
        };

        const newer = {
            ...basePayload,
            jobId: 'new-cancelled',
            status: 'cancelled',
            progress: { message: 'Cancelled' },
            retryable: false,
            createdAt: '2026-09-26T18:30:00.000Z',
            updatedAt: '2026-09-26T19:00:00.000Z',
            completedAt: '2026-09-26T19:00:00.000Z',
            cancelledAt: '2026-09-26T19:00:00.000Z',
            cancelReason: 'user-requested',
        };

        queue.jobs.set(older.jobId, older);
        queue.jobs.set(newer.jobId, newer);
        queue.order.push(older.jobId, newer.jobId);

        const snapshot = await queue.snapshot(config);

        expect(snapshot.jobs).toHaveLength(1);
        expect(snapshot.jobs[0]).toMatchObject({
            jobId: 'new-cancelled',
            id: 'same-album',
            status: 'cancelled',
        });
        expect(queue.order).toEqual(['new-cancelled']);
    });

    test('retries a retryable failed job through the API', async () => {
        const originalExecutor = downloadQueue.memoryQueue.trackExecutor;
        downloadQueue.memoryQueue.trackExecutor = async () => {
            const error = new Error('cdn failed');
            error.failureCode = 'CDN_FETCH_FAILED';
            throw error;
        };

        try {
            const config = getDownloadsConfig({
                TEMP_DIR: '/tmp/test-downloads',
                DOWNLOAD_DIR: '/music',
                DOWNLOAD_WORKER_ENABLED: 'true',
            });
            const failed = await downloadQueue.enqueue({ type: 'track', id: 'retry-track', quality: 'LOSSLESS' }, config);
            await downloadQueue.memoryQueue.waitForIdleForTests();

            expect(downloadQueue.memoryQueue.get(failed.jobId).retryable).toBe(true);

            const response = await onRetryRequest(
                context(new Request(`https://example.test/api/downloads/${failed.jobId}/retry`, { method: 'POST' }), {
                    jobId: failed.jobId,
                })
            );
            const body = await response.json();

            expect(response.status).toBe(202);
            expect(body.jobId).toBe(failed.jobId);
            expect(body.job.status).toBe('queued');

            const snapshot = await downloadQueue.snapshot(config);
            expect(snapshot.jobs.filter((job) => job.id === 'retry-track')).toHaveLength(1);
        } finally {
            downloadQueue.memoryQueue.trackExecutor = originalExecutor;
        }
    });

    test('normalizes public config defaults', () => {
        const config = getDownloadsConfig({});

        expect(config.tempRoot).toBe('/tmp/monochrome-downloads');
        expect(config.downloadRoot).toBe(null);
        expect(config.workerEnabled).toBe(true);
        expect(config.fetchTimeoutMs).toBe(120000);
        expect(config.albumPolicy).toEqual({
            partialPublish: false,
            qualityDowngrade: false,
        });
    });
});
