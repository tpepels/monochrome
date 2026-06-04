import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { getDownloadsConfig } from './config.js';

function maintenanceError(message, failureCode, details = {}) {
    const error = new Error(message);
    error.failureCode = failureCode;
    Object.assign(error, details);
    return error;
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

export class InMemoryMaintenanceLock {
    constructor() {
        this.locked = false;
    }

    async acquire({ timeoutMs = 30000, pollMs = 10 } = {}) {
        const started = Date.now();
        while (this.locked) {
            if (Date.now() - started >= timeoutMs) {
                throw maintenanceError('Media library maintenance lock timed out', 'MAINTENANCE_LOCK_TIMEOUT');
            }
            await sleep(pollMs);
        }

        this.locked = true;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.locked = false;
        };
    }

    async runExclusive(callback, options = {}) {
        const release = await this.acquire(options);
        try {
            return await callback();
        } finally {
            release();
        }
    }
}

export const defaultMaintenanceLock = new InMemoryMaintenanceLock();

export class RedisMaintenanceLock {
    constructor({ client, key = 'monochrome:downloads:maintenance-lock', ttlMs = 30000 } = {}) {
        this.client = client;
        this.key = key;
        this.ttlMs = ttlMs;
    }

    async acquire({ timeoutMs = 30000, pollMs = 25 } = {}) {
        const started = Date.now();
        const token = crypto.randomUUID();

        while (true) {
            const acquired = await this.client.set(this.key, token, {
                NX: true,
                PX: Math.max(this.ttlMs, timeoutMs),
            });
            if (acquired === 'OK') {
                let released = false;
                return async () => {
                    if (released) return;
                    released = true;
                    await this.client.eval(
                        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                        {
                            keys: [this.key],
                            arguments: [token],
                        }
                    );
                };
            }

            if (Date.now() - started >= timeoutMs) {
                throw maintenanceError('Media library maintenance lock timed out', 'MAINTENANCE_LOCK_TIMEOUT');
            }
            await sleep(pollMs);
        }
    }

    async runExclusive(callback, options = {}) {
        const release = await this.acquire(options);
        try {
            return await callback();
        } finally {
            await release();
        }
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

function isActiveTransient(name, activeJobIds) {
    for (const jobId of activeJobIds) {
        if (name === jobId || name.includes(`-${jobId}-`) || name.includes(`.${jobId}.`)) {
            return true;
        }
    }
    return false;
}

function isTransientAlbumDir(name) {
    return /^\..+\.(?:publishing|backup)-.+-.+$/.test(name);
}

async function removePath(targetPath, { fsOps, dryRun, actions, reason }) {
    actions.push({
        action: dryRun ? 'would-remove' : 'removed',
        path: targetPath,
        reason,
    });

    if (!dryRun) {
        await fsOps.rm(targetPath, { recursive: true, force: true });
    }
}

async function sweepTempRoot({ tempRoot, activeJobIds, minAgeMs, nowMs, dryRun, fsOps, actions }) {
    if (!tempRoot || !(await pathExists(tempRoot, fsOps))) return;

    const entries = await fsOps.readdir(tempRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(tempRoot, entry.name);

        if (isActiveTransient(entry.name, activeJobIds)) {
            actions.push({ action: 'skipped-active', path: fullPath, reason: 'active-job' });
            continue;
        }

        const stat = await fsOps.stat(fullPath).catch(() => null);
        if (!stat) continue;
        if (nowMs - stat.mtimeMs < minAgeMs) {
            actions.push({ action: 'skipped-fresh', path: fullPath, reason: 'too-fresh' });
            continue;
        }

        await removePath(fullPath, { fsOps, dryRun, actions, reason: 'stale-temp-job-dir' });
    }
}

async function sweepLibraryTransients({ root, activeJobIds, minAgeMs, nowMs, dryRun, fsOps, actions }) {
    if (!root || !(await pathExists(root, fsOps))) return;

    const entries = await fsOps.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory() && isTransientAlbumDir(entry.name)) {
            if (isActiveTransient(entry.name, activeJobIds)) {
                actions.push({ action: 'skipped-active', path: fullPath, reason: 'active-publication' });
                continue;
            }

            const stat = await fsOps.stat(fullPath).catch(() => null);
            if (!stat) continue;
            if (nowMs - stat.mtimeMs < minAgeMs) {
                actions.push({ action: 'skipped-fresh', path: fullPath, reason: 'too-fresh' });
                continue;
            }

            const reason = entry.name.includes('.publishing-') ? 'stale-publishing-dir' : 'stale-backup-dir';
            await removePath(fullPath, { fsOps, dryRun, actions, reason });
            continue;
        }

        if (entry.isDirectory() && !entry.name.startsWith('.')) {
            await sweepLibraryTransients({ root: fullPath, activeJobIds, minAgeMs, nowMs, dryRun, fsOps, actions });
        }
    }
}

export async function sweepDownloadTransients({
    config = getDownloadsConfig(),
    activeJobIds = [],
    dryRun = false,
    minAgeMs = config.transientMinAgeMs,
    nowMs = Date.now(),
    fsOps = fs,
    logger = null,
} = {}) {
    const activeSet = new Set(activeJobIds.map(String));
    const actions = [];

    await sweepTempRoot({
        tempRoot: config.tempRoot,
        activeJobIds: activeSet,
        minAgeMs,
        nowMs,
        dryRun,
        fsOps,
        actions,
    });
    await sweepLibraryTransients({
        root: config.downloadRoot,
        activeJobIds: activeSet,
        minAgeMs,
        nowMs,
        dryRun,
        fsOps,
        actions,
    });

    for (const action of actions) {
        logger?.info?.('[downloads:sweep]', action);
    }

    return {
        success: true,
        dryRun,
        actions,
    };
}
