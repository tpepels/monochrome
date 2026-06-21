import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
    SERVER_DEFAULT_INSTANCES,
    applyResolverEnv,
    applyServerInstanceDefaults,
    createMonochromeApi,
    installServerLocalStorage,
} from './monochrome-runtime.js';

const downloadsDir = dirname(fileURLToPath(import.meta.url));

function memoryStorage() {
    const values = new Map();
    return {
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
}

describe('monochrome runtime boundary', () => {
    test('installs a server localStorage shim without replacing an existing one', () => {
        const target = {};
        const storage = installServerLocalStorage(target);

        storage.setItem('key', 'value');

        expect(target.localStorage).toBe(storage);
        expect(installServerLocalStorage(target)).toBe(storage);
        expect(storage.getItem('key')).toBe('value');
    });

    test('maps server env to upstream Monochrome localStorage settings', () => {
        const storage = memoryStorage();

        applyResolverEnv(storage, {
            DOWNLOAD_API_INSTANCES: 'https://api-one.test, https://api-two.test',
            DOWNLOAD_STREAMING_INSTANCES: 'https://stream.test',
            AMAZON_MUSIC_ENABLED: 'true',
            AMAZON_MUSIC_TURNSTILE_BYPASS_TOKEN: 'token',
            DEEZER_FALLBACK_ENABLED: 'true',
        });

        expect(JSON.parse(storage.getItem('monochrome-user-api-instances-v1'))).toEqual({
            api: [
                { url: 'https://api-one.test', isUser: true, version: 'env' },
                { url: 'https://api-two.test', isUser: true, version: 'env' },
            ],
            streaming: [{ url: 'https://stream.test', isUser: true, version: 'env' }],
            qobuz: [],
        });
        expect(storage.getItem('amazon-music-enabled')).toBe('true');
        expect(storage.getItem('amazon-music-turnstile-bypass-token')).toBe('token');
        expect(storage.getItem('deezer-fallback-enabled')).toBe('true');
    });

    test('creates an upstream LosslessAPI instance through the injected boundary', async () => {
        const storage = memoryStorage();
        const seen = {};
        class FakeLosslessAPI {
            constructor(settings) {
                seen.settings = settings;
            }
        }

        const api = await createMonochromeApi({
            env: { AMAZON_MUSIC_ENABLED: 'true' },
            localStorage: storage,
            LosslessAPI: FakeLosslessAPI,
            apiSettings: { source: 'upstream-settings' },
            initializeHiFi: false,
        });

        expect(api).toBeInstanceOf(FakeLosslessAPI);
        expect(seen.settings).toMatchObject({
            source: 'upstream-settings',
            defaultInstances: SERVER_DEFAULT_INSTANCES,
            instancesLoaded: true,
            _loadPromise: null,
        });
        expect(storage.getItem('amazon-music-enabled')).toBe('true');
    });

    test('seeds static server instances by default to avoid depending on uptime worker discovery', () => {
        const settings = {
            defaultInstances: { api: [], streaming: [], qobuz: [] },
            instancesLoaded: false,
            _loadPromise: Promise.resolve(),
        };

        applyServerInstanceDefaults(settings, {});

        expect(settings.instancesLoaded).toBe(true);
        expect(settings._loadPromise).toBe(null);
        expect(settings.defaultInstances.api).toEqual(SERVER_DEFAULT_INSTANCES.api);
        expect(settings.defaultInstances.streaming).toEqual(SERVER_DEFAULT_INSTANCES.streaming);
        expect(settings.defaultInstances.qobuz).toEqual(SERVER_DEFAULT_INSTANCES.qobuz);
    });

    test('keeps explicit server instance envs as user instances while filling missing defaults', () => {
        const settings = {
            defaultInstances: { api: [], streaming: [], qobuz: [] },
            instancesLoaded: false,
            _loadPromise: null,
        };

        applyServerInstanceDefaults(settings, {
            DOWNLOAD_API_INSTANCES: 'https://custom-api.test',
            DOWNLOAD_QOBUZ_INSTANCES: 'https://custom-qobuz.test',
        });

        expect(settings.instancesLoaded).toBe(true);
        expect(settings.defaultInstances.api).toEqual([]);
        expect(settings.defaultInstances.streaming).toEqual(SERVER_DEFAULT_INSTANCES.streaming);
        expect(settings.defaultInstances.qobuz).toEqual([]);
    });

    test('allows explicit opt-in to upstream uptime worker discovery', () => {
        const settings = {
            defaultInstances: { api: [{ url: 'existing' }], streaming: [], qobuz: [] },
            instancesLoaded: false,
            _loadPromise: null,
        };

        applyServerInstanceDefaults(settings, { DOWNLOAD_INSTANCE_DISCOVERY: 'true' });

        expect(settings.instancesLoaded).toBe(false);
        expect(settings.defaultInstances.api).toEqual([{ url: 'existing' }]);
    });

    test('keeps upstream Monochrome imports behind the resolver boundary', () => {
        const allowedFiles = new Set(['monochrome-runtime.js', 'resolver-adapter.js']);
        const implementationFiles = readdirSync(downloadsDir)
            .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'))
            .map((file) => join(downloadsDir, file));

        for (const file of implementationFiles) {
            const source = readFileSync(file, 'utf8');
            const importsUpstreamJs = /(?:from\s+['"]|import\(['"])\.\.\/\.\.\/js\//.test(source);

            if (!allowedFiles.has(basename(file))) {
                expect(importsUpstreamJs, `${basename(file)} must not import upstream js modules directly`).toBe(false);
            }
        }
    });
});
