import { describe, expect, test, beforeEach } from 'vitest';
import { getDownloadsConfig } from './config.js';
import { downloadQueue } from './queue.js';
import { onRequest as onDownloadsRequest } from '../../functions/api/downloads/index.js';
import { onRequest as onJobRequest } from '../../functions/api/downloads/[jobId].js';
import { onRequest as onCancelRequest } from '../../functions/api/downloads/[jobId]/cancel.js';
import { onRequest as onRetryRequest } from '../../functions/api/downloads/[jobId]/retry.js';

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
        expect(config.albumPolicy).toEqual({
            partialPublish: false,
            qualityDowngrade: false,
        });
    });
});
