function envList(env, key) {
    const value = env?.[key];
    if (!value) return null;
    return String(value)
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean)
        .map((url) => ({ url, isUser: true, version: 'env' }));
}

export const SERVER_DEFAULT_INSTANCES = {
    api: [
        { url: 'https://hifi.geeked.wtf', version: '2.7' },
        { url: 'https://eu-central.monochrome.tf', version: '2.7' },
        { url: 'https://us-west.monochrome.tf', version: '2.7' },
        { url: 'https://api.monochrome.tf', version: '2.5' },
        { url: 'https://monochrome-api.samidy.com', version: '2.3' },
        { url: 'https://maus.qqdl.site', version: '2.6' },
        { url: 'https://vogel.qqdl.site', version: '2.6' },
        { url: 'https://katze.qqdl.site', version: '2.6' },
        { url: 'https://hund.qqdl.site', version: '2.6' },
        { url: 'https://tidal.kinoplus.online', version: '2.2' },
        { url: 'https://wolf.qqdl.site', version: '2.2' },
    ],
    streaming: [
        { url: 'https://hifi.geeked.wtf', version: '2.7' },
        { url: 'https://maus.qqdl.site', version: '2.6' },
        { url: 'https://vogel.qqdl.site', version: '2.6' },
        { url: 'https://katze.qqdl.site', version: '2.6' },
        { url: 'https://hund.qqdl.site', version: '2.6' },
        { url: 'https://wolf.qqdl.site', version: '2.6' },
    ],
    qobuz: [{ url: 'https://qobuz.kennyy.com.br', version: '1.0' }],
};

function explicitResolverInstances(env = {}) {
    return {
        api: envList(env, 'DOWNLOAD_API_INSTANCES') || [],
        streaming: envList(env, 'DOWNLOAD_STREAMING_INSTANCES') || [],
        qobuz: envList(env, 'DOWNLOAD_QOBUZ_INSTANCES') || [],
    };
}

function isEnabled(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function cloneInstances(instances) {
    return instances.map((instance) => ({ ...instance }));
}

export function installServerLocalStorage(target = globalThis) {
    if (target.localStorage) return target.localStorage;

    const values = new Map();
    target.localStorage = {
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(key, String(value));
        },
        removeItem(key) {
            values.delete(key);
        },
        clear() {
            values.clear();
        },
    };
    return target.localStorage;
}

export function applyResolverEnv(localStorage, env = {}) {
    const userInstances = explicitResolverInstances(env);
    if (userInstances.api.length || userInstances.streaming.length || userInstances.qobuz.length) {
        localStorage.setItem('monochrome-user-api-instances-v1', JSON.stringify(userInstances));
    }

    const envToStorage = [
        ['AMAZON_MUSIC_ENABLED', 'amazon-music-enabled'],
        ['AMAZON_MUSIC_API_BASE_URL', 'amazon-music-api-base-url'],
        ['AMAZON_MUSIC_CONVERTER_BASE_URL', 'amazon-music-converter-base-url'],
        ['AMAZON_MUSIC_TURNSTILE_SITE_KEY', 'amazon-music-turnstile-site-key'],
        ['AMAZON_MUSIC_TURNSTILE_BYPASS_TOKEN', 'amazon-music-turnstile-bypass-token'],
        ['DEEZER_FALLBACK_ENABLED', 'deezer-fallback-enabled'],
        ['DEEZER_FALLBACK_API_BASE_URL', 'deezer-fallback-api-base-url'],
    ];

    for (const [envKey, storageKey] of envToStorage) {
        if (env?.[envKey] != null && String(env[envKey]).trim() !== '') {
            localStorage.setItem(storageKey, String(env[envKey]));
        }
    }
}

export function applyServerInstanceDefaults(apiSettings, env = {}) {
    if (isEnabled(env.DOWNLOAD_INSTANCE_DISCOVERY)) return;

    const explicit = explicitResolverInstances(env);
    apiSettings.defaultInstances = {
        api: explicit.api.length ? [] : cloneInstances(SERVER_DEFAULT_INSTANCES.api),
        streaming: explicit.streaming.length ? [] : cloneInstances(SERVER_DEFAULT_INSTANCES.streaming),
        qobuz: explicit.qobuz.length ? [] : cloneInstances(SERVER_DEFAULT_INSTANCES.qobuz),
    };
    apiSettings.instancesLoaded = true;
    apiSettings._loadPromise = null;
}

export async function initializeHiFiClient(localStorage, { timeoutMs = 5000 } = {}) {
    const { HiFiClient } = await import('../../js/HiFi.ts');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        await HiFiClient.initialize({
            storage: [localStorage],
            token: localStorage.getItem('hifi_token') || undefined,
            tokenExpiry: Number.parseInt(localStorage.getItem('hifi_token_expiry') || '0', 10),
            refreshToken: localStorage.getItem('hifi_refresh_token') || undefined,
            signal: controller.signal,
        });
    } catch (error) {
        if (!String(error?.message || '').includes('already initialized')) {
            console.warn('Failed to initialize server HiFiClient:', error);
        }
    } finally {
        clearTimeout(timeout);
    }
}

export async function createMonochromeApi({
    env = {},
    fetchImpl = null,
    localStorage = null,
    LosslessAPI = null,
    apiSettings = null,
    initializeHiFi = true,
} = {}) {
    const storage = localStorage || installServerLocalStorage();
    applyResolverEnv(storage, env);
    if (fetchImpl) {
        globalThis.fetch = fetchImpl;
    }

    const [{ LosslessAPI: MonochromeLosslessAPI }, { apiSettings: monochromeApiSettings }] = await Promise.all([
        LosslessAPI ? Promise.resolve({ LosslessAPI }) : import('../../js/api.js'),
        apiSettings ? Promise.resolve({ apiSettings }) : import('../../js/storage.js'),
    ]);
    applyServerInstanceDefaults(monochromeApiSettings, env);

    if (initializeHiFi) {
        await initializeHiFiClient(storage);
    }

    return new MonochromeLosslessAPI(monochromeApiSettings);
}
