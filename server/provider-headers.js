export const DEFAULT_DEEZER_FALLBACK_API_BASE_URL = 'https://dzr.tabs-vs-spaces.wtf';
export const DEFAULT_DEEZER_FALLBACK_ALLOWED_ORIGIN = 'https://monochrome.tf';

function trimTrailingSlashes(value) {
    return String(value || '').replace(/\/+$/, '');
}

export function getDeezerFallbackBaseUrl(env = {}) {
    return trimTrailingSlashes(env.DEEZER_FALLBACK_API_BASE_URL || DEFAULT_DEEZER_FALLBACK_API_BASE_URL);
}

export function getDeezerFallbackAllowedOrigin(env = {}) {
    return trimTrailingSlashes(env.DEEZER_FALLBACK_ALLOWED_ORIGIN || DEFAULT_DEEZER_FALLBACK_ALLOWED_ORIGIN);
}

export function isConfiguredDeezerFallbackUrl(url, env = {}) {
    try {
        const parsed = new URL(url);
        const configured = new URL(getDeezerFallbackBaseUrl(env));
        return parsed.host === configured.host;
    } catch {
        return false;
    }
}

export function withDeezerFallbackHeaders(url, headers = {}, env = {}) {
    const nextHeaders = { ...headers };
    const origin = getDeezerFallbackAllowedOrigin(env);
    if (origin && isConfiguredDeezerFallbackUrl(url, env)) {
        nextHeaders.origin = origin;
        nextHeaders.referer = `${origin}/`;
    }
    return nextHeaders;
}
