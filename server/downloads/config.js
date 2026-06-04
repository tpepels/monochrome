export const DEFAULT_TEMP_ROOT = '/tmp/monochrome-downloads';
export const DEFAULT_TRANSIENT_MIN_AGE_MS = 15 * 60 * 1000;
export const DEFAULT_MAINTENANCE_LOCK_TIMEOUT_MS = 30 * 1000;

function readEnv(env, key) {
    if (!env || typeof env !== 'object') return undefined;
    return env[key];
}

function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
    if (value == null) return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

export function getDownloadsConfig(env = {}) {
    const tempRoot = readEnv(env, 'TEMP_DIR') || DEFAULT_TEMP_ROOT;
    const downloadRoot = readEnv(env, 'DOWNLOAD_DIR') || readEnv(env, 'MUSIC_LIBRARY_DIR') || null;

    return {
        tempRoot,
        downloadRoot,
        workerEnabled: parseBoolean(readEnv(env, 'DOWNLOAD_WORKER_ENABLED'), true),
        workerConcurrency: parsePositiveInteger(readEnv(env, 'DOWNLOAD_WORKER_CONCURRENCY'), 1),
        maintenanceLockTimeoutMs: parsePositiveInteger(
            readEnv(env, 'DOWNLOAD_MAINTENANCE_LOCK_TIMEOUT_MS'),
            DEFAULT_MAINTENANCE_LOCK_TIMEOUT_MS
        ),
        transientMinAgeMs: parsePositiveInteger(
            readEnv(env, 'DOWNLOAD_TRANSIENT_MIN_AGE_MS'),
            DEFAULT_TRANSIENT_MIN_AGE_MS
        ),
        redisUrl: readEnv(env, 'REDIS_URL') || null,
        duplicateCheckBeforeQueue: parseBoolean(readEnv(env, 'DOWNLOAD_DUPLICATE_CHECK'), false),
        albumPolicy: {
            partialPublish: false,
            qualityDowngrade: false,
        },
    };
}

export function publicConfig(config) {
    return {
        tempRoot: config.tempRoot,
        downloadRootConfigured: Boolean(config.downloadRoot),
        workerEnabled: config.workerEnabled,
        workerConcurrency: config.workerConcurrency,
        maintenanceLockTimeoutMs: config.maintenanceLockTimeoutMs,
        transientMinAgeMs: config.transientMinAgeMs,
        redisConfigured: Boolean(config.redisUrl),
        duplicateCheckBeforeQueue: config.duplicateCheckBeforeQueue,
        albumPolicy: config.albumPolicy,
    };
}
