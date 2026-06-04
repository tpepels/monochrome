import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { InMemoryMaintenanceLock, sweepDownloadTransients } from './maintenance.js';
import { DOWNLOAD_JOB_STATUSES, DownloadQueueManager, MemoryDownloadQueue } from './queue.js';

let root;

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'monochrome-queue-maintenance-'));
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

function config(overrides = {}) {
    return {
        tempRoot: path.join(root, 'tmp'),
        downloadRoot: path.join(root, 'music'),
        workerEnabled: true,
        workerConcurrency: 1,
        redisUrl: null,
        duplicateCheckBeforeQueue: false,
        maintenanceLockTimeoutMs: 1000,
        transientMinAgeMs: 1,
        albumPolicy: {
            partialPublish: false,
            qualityDowngrade: false,
        },
        ...overrides,
    };
}

test('memory worker executes queued jobs deterministically with bounded concurrency', async () => {
    const started = [];
    const queue = new MemoryDownloadQueue({
        trackExecutor: async ({ id }) => {
            started.push(id);
            return {
                action: 'published',
                finalFile: `/music/${id}.wav`,
                relativePath: `${id}.wav`,
                publishMethod: 'rename',
            };
        },
    });

    const first = await queue.enqueue({ type: 'track', id: 'one', quality: 'LOSSLESS' }, config());
    const second = await queue.enqueue({ type: 'track', id: 'two', quality: 'LOSSLESS' }, config());
    await queue.waitForIdleForTests();

    expect(started).toEqual(['one', 'two']);
    expect(queue.get(first.jobId).status).toBe(DOWNLOAD_JOB_STATUSES.COMPLETED);
    expect(queue.get(second.jobId).result).toMatchObject({ relativePath: 'two.wav' });
});

test('cancels processing jobs with AbortController and preserves cancellation state', async () => {
    let signal;
    let release;
    const blocked = new Promise((resolve) => {
        release = resolve;
    });
    const queue = new MemoryDownloadQueue({
        trackExecutor: async ({ signal: jobSignal }) => {
            signal = jobSignal;
            await blocked;
            if (jobSignal.aborted) {
                const error = new DOMException('Aborted', 'AbortError');
                throw error;
            }
            return { action: 'published', finalFile: '/music/file.wav' };
        },
    });

    const job = await queue.enqueue({ type: 'track', id: 'cancel-me', quality: 'LOSSLESS' }, config());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cancelled = queue.cancel(job.jobId);
    release();
    await queue.waitForIdleForTests();

    expect(signal.aborted).toBe(true);
    expect(cancelled.status).toBe(DOWNLOAD_JOB_STATUSES.CANCELLED);
    expect(queue.get(job.jobId).retryable).toBe(false);
});

test('failed retryability follows failure category and retry creates a fresh job id', async () => {
    const queue = new MemoryDownloadQueue({
        trackExecutor: async () => {
            const error = new Error('cdn unavailable');
            error.failureCode = 'CDN_FETCH_FAILED';
            throw error;
        },
    });

    const failed = await queue.enqueue({ type: 'track', id: 'retry-me', quality: 'LOSSLESS' }, config());
    await queue.waitForIdleForTests();

    const failedState = queue.get(failed.jobId);
    expect(failedState.status).toBe(DOWNLOAD_JOB_STATUSES.FAILED);
    expect(failedState.retryable).toBe(true);

    const retry = await queue.retry(failed.jobId, config({ workerEnabled: false }));
    expect(retry.jobId).not.toBe(failed.jobId);
    expect(retry.status).toBe(DOWNLOAD_JOB_STATUSES.QUEUED);
});

test('optional duplicate check can complete a job before worker execution', async () => {
    const relativePath = path.join('Artist', 'Album', '01 - Song.wav');
    await fs.mkdir(path.join(root, 'music', 'Artist', 'Album'), { recursive: true });
    await fs.writeFile(path.join(root, 'music', relativePath), 'audio');

    let executed = false;
    const queue = new MemoryDownloadQueue({
        trackExecutor: async () => {
            executed = true;
        },
    });

    const job = await queue.enqueue(
        { type: 'track', id: 'exists', quality: 'LOSSLESS', localRelativePath: relativePath },
        config({ duplicateCheckBeforeQueue: true })
    );

    expect(job.status).toBe(DOWNLOAD_JOB_STATUSES.COMPLETED);
    expect(job.result.action).toBe('skipped-duplicate-before-queue');
    expect(executed).toBe(false);
});

test('Redis configuration falls back visibly to the memory backend', async () => {
    const manager = new DownloadQueueManager({ memoryQueue: new MemoryDownloadQueue() });
    const snapshot = await manager.snapshot(config({ redisUrl: 'redis://127.0.0.1:6390' }));

    expect(snapshot.backend).toBe('memory');
    expect(snapshot.fallback).toMatchObject({
        from: 'redis',
        to: 'memory',
    });
});

test('maintenance lock serializes library mutations and times out waiters', async () => {
    const lock = new InMemoryMaintenanceLock();
    let release;
    const first = lock.acquire({ timeoutMs: 1000 }).then((unlock) => {
        release = unlock;
    });
    await first;

    await expect(lock.runExclusive(() => null, { timeoutMs: 1, pollMs: 1 })).rejects.toMatchObject({
        failureCode: 'MAINTENANCE_LOCK_TIMEOUT',
    });

    release();
    await expect(lock.runExclusive(() => 'ok', { timeoutMs: 1000 })).resolves.toBe('ok');
});

test('sweeps stale temp, publishing, and backup dirs while skipping active and fresh paths', async () => {
    const cfg = config({ transientMinAgeMs: 1000 });
    const staleTemp = path.join(cfg.tempRoot, 'old-job');
    const activeTemp = path.join(cfg.tempRoot, 'active-job');
    const artistDir = path.join(cfg.downloadRoot, 'Artist');
    const stalePublishing = path.join(artistDir, '.Album.publishing-old-job-abcd');
    const staleBackup = path.join(artistDir, '.Album.backup-old-job-abcd');
    const activePublishing = path.join(artistDir, '.Album.publishing-active-job-abcd');
    const freshBackup = path.join(artistDir, '.Album.backup-fresh-job-abcd');
    const oldDate = new Date(Date.now() - 60 * 60 * 1000);

    for (const dir of [staleTemp, activeTemp, stalePublishing, staleBackup, activePublishing, freshBackup]) {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'marker'), 'x');
    }
    for (const dir of [staleTemp, activeTemp, stalePublishing, staleBackup, activePublishing]) {
        await fs.utimes(dir, oldDate, oldDate);
    }

    const dryRun = await sweepDownloadTransients({
        config: cfg,
        activeJobIds: ['active-job'],
        dryRun: true,
        nowMs: Date.now(),
    });
    expect(dryRun.actions.filter((action) => action.action === 'would-remove')).toHaveLength(3);
    await expect(fs.stat(staleTemp)).resolves.toBeTruthy();

    const result = await sweepDownloadTransients({
        config: cfg,
        activeJobIds: ['active-job'],
        dryRun: false,
        nowMs: Date.now(),
    });

    expect(result.actions.some((action) => action.reason === 'stale-temp-job-dir')).toBe(true);
    await expect(fs.stat(staleTemp)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(stalePublishing)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(staleBackup)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(activeTemp)).resolves.toBeTruthy();
    await expect(fs.stat(activePublishing)).resolves.toBeTruthy();
    await expect(fs.stat(freshBackup)).resolves.toBeTruthy();
});
