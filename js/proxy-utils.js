export const isTidalAudioUrl = () => false;

const OFFICIAL_MONOCHROME_HOSTNAMES = new Set(['monochrome.tf', 'www.monochrome.tf']);

export const isOfficialMonochromeHostname = (hostname) =>
    OFFICIAL_MONOCHROME_HOSTNAMES.has(String(hostname || '').toLowerCase());

export const canUseUnifiedTurnstile = (locationLike = globalThis.location) =>
    isOfficialMonochromeHostname(locationLike?.hostname);

export const getLocalHiFiProxyUrl = (targetUrl, locationLike = globalThis.location) => {
    if (!targetUrl || !locationLike || isOfficialMonochromeHostname(locationLike.hostname)) return null;

    try {
        const target = new URL(targetUrl, locationLike.origin);
        if (target.origin === locationLike.origin) return null;
        return `/api/hifi-proxy?url=${encodeURIComponent(target.href)}`;
    } catch {
        return null;
    }
};

export const getProxyUrl = (url) => {
    if (!url) return url;
    return url;
};

export const wrapTidalUrl = (url) => {
    if (!url || typeof url !== 'string') return url;
    return url
        .replace('openapi.tidal.com', 'tidal-proxy.monochrome.tf/openapi')
        .replace('api.tidal.com', 'tidal-proxy.monochrome.tf/api')
        .replace('https://tidal.com', 'https://tidal-proxy.monochrome.tf/tidal');
};
