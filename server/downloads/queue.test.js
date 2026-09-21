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
import { onRequest as onResetRequest } from '../../functions/api/downloads/reset.js';

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
            expect(body.jobId).toBeTruthy();
            expect(body.jobId).not.toBe(failed.jobId);
            expect(body.job.status).toBe('queued');
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
