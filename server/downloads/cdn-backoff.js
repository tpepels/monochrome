const stateByOrigin = new Map();

function originKey(url) {
    try {
        return new URL(String(url)).origin;
    } catch {
        return String(url || 'unknown');
    }
}

export function calculateCdnBackoffDelayMs(
    failureStreak,
    { baseMs = 5000, maxMs = 5 * 60 * 1000, retryAfterMs = null } = {}
) {
    const streak = Math.max(1, Number(failureStreak) || 1);
    const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(streak - 1, 20));
    const requested = Number.isFinite(Number(retryAfterMs)) ? Math.max(0, Number(retryAfterMs)) : 0;
    return Math.min(maxMs, Math.max(exponential, requested));
}

export function noteCdnFailure(
    url,
    { retryAfterMs = null, baseMs = 5000, maxMs = 5 * 60 * 1000, now = Date.now() } = {}
) {
    const key = originKey(url);
    const current = stateByOrigin.get(key) || { failureStreak: 0, blockedUntil: 0 };
    const failureStreak = current.failureStreak + 1;
    const delayMs = calculateCdnBackoffDelayMs(failureStreak, { baseMs, maxMs, retryAfterMs });
    const state = {
        failureStreak,
        blockedUntil: Math.max(current.blockedUntil || 0, now + delayMs),
        delayMs,
    };
    stateByOrigin.set(key, state);
    return { origin: key, ...state };
}

export function noteCdnSuccess(url) {
    stateByOrigin.delete(originKey(url));
}

export function getCdnBackoffState(url, now = Date.now()) {
    const key = originKey(url);
    const state = stateByOrigin.get(key);
    if (!state) {
        return { origin: key, failureStreak: 0, blockedUntil: 0, remainingMs: 0 };
    }

    const remainingMs = Math.max(0, Number(state.blockedUntil || 0) - now);
    if (remainingMs === 0) {
        return { origin: key, ...state, remainingMs: 0 };
    }
    return { origin: key, ...state, remainingMs };
}

export async function waitForCdnBackoff(
    url,
    { signal = null, onProgress = null, now = Date.now } = {}
) {
    const state = getCdnBackoffState(url, now());
    if (!state.remainingMs) return state;

    onProgress?.({
        cdnBackoff: true,
        cdnBackoffOrigin: state.origin,
        cdnBackoffFailureStreak: state.failureStreak,
        cdnBackoffWaitMs: state.remainingMs,
        cdnBackoffWaitSeconds: Math.ceil(state.remainingMs / 1000),
        retryWaitMs: state.remainingMs,
        retryWaitSeconds: Math.ceil(state.remainingMs / 1000),
    });

    await new Promise((resolve, reject) => {
        let timer = null;
        const finish = () => {
            signal?.removeEventListener?.('abort', onAbort);
            resolve();
        };
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason || new DOMException('Aborted', 'AbortError'));
        };

        timer = setTimeout(finish, state.remainingMs);
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });

    return getCdnBackoffState(url, now());
}

export function resetCdnBackoffState() {
    stateByOrigin.clear();
}
