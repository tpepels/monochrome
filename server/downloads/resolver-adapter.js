import { getProxyUrl } from '../../js/proxy-utils.js';

function normalizeQuality(quality) {
    const normalized = String(quality || '').trim().toUpperCase();
    if (normalized === 'NORMAL') return 'HIGH';
    if (normalized === 'LOW_MP3') return 'LOW';
    return normalized || 'LOSSLESS';
}

function envList(env, key) {
    const value = env?.[key];
    if (!value) return null;
    return String(value)
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean)
        .map((url) => ({ url, isUser: true, version: 'env' }));
}

function coverUrlFromId(id, size = '1280') {
    if (!id) return null;
    return `https://resources.tidal.com/images/${String(id).replace(/-/g, '/')}/${size}x${size}.jpg`;
}

function decodeBase64(value) {
    if (typeof atob === 'function') return atob(value);
    return Buffer.from(value, 'base64').toString('utf8');
}

function decodeManifest(manifest) {
    if (!manifest) return null;
    if (typeof manifest === 'object') return manifest;
    if (typeof manifest !== 'string') return null;

    try {
        return decodeBase64(manifest);
    } catch {
        return manifest;
    }
}

function sortUrlsByQuality(urls) {
    const priorityKeywords = ['flac', 'lossless', 'hi-res', 'high'];
    return [...urls].sort((a, b) => {
        const aLow = String(a).toLowerCase();
        const bLow = String(b).toLowerCase();
        const aScore = priorityKeywords.findIndex((keyword) => aLow.includes(keyword));
        const bScore = priorityKeywords.findIndex((keyword) => bLow.includes(keyword));
        return (aScore === -1 ? 999 : aScore) - (bScore === -1 ? 999 : bScore);
    });
}

function getAttr(text, name) {
    const match = text.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'));
    return match ? match[1] : null;
}

function firstTagText(xml, tagName) {
    const match = xml.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
    return match ? match[1].trim() : '';
}

function extractTag(xml, tagName) {
    const match = xml.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tagName}>`, 'i'));
    return match ? match[0] : '';
}

function parseDashSegmentManifest(xml) {
    if (!xml || !String(xml).includes('<MPD')) return null;

    const period = extractTag(xml, 'Period') || xml;
    const adaptationSets = [...period.matchAll(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/gi)].map((match) => match[0]);
    const audioSet =
        adaptationSets.find((set) => /mimeType=["']audio\//i.test(set)) ||
        adaptationSets[0] ||
        period;
    const representationMatch = audioSet.match(/<Representation\b([\s\S]*?)(?:\/>|>[\s\S]*?<\/Representation>)/i);
    const representationAttrs = representationMatch?.[1] || '';
    const representation = representationMatch?.[0] || '';
    const segmentTemplateMatch =
        representation.match(/<SegmentTemplate\b[\s\S]*?(?:\/>|>[\s\S]*?<\/SegmentTemplate>)/i) ||
        audioSet.match(/<SegmentTemplate\b[\s\S]*?(?:\/>|>[\s\S]*?<\/SegmentTemplate>)/i);
    const segmentTemplate = segmentTemplateMatch?.[0] || '';

    if (!segmentTemplate) {
        return {
            kind: 'dash',
            baseUrl: firstTagText(representation, 'BaseURL') || firstTagText(audioSet, 'BaseURL') || firstTagText(xml, 'BaseURL'),
            initialization: null,
            media: null,
            segments: [],
            representationId: getAttr(representationAttrs, 'id'),
            mimeType: getAttr(audioSet, 'mimeType') || getAttr(representationAttrs, 'mimeType'),
        };
    }

    const startNumber = Number.parseInt(getAttr(segmentTemplate, 'startNumber') || '1', 10);
    const segments = [];
    let currentTime = 0;
    let currentNumber = startNumber;

    for (const match of segmentTemplate.matchAll(/<S\b([^>]*)\/?>/gi)) {
        const attrs = match[1] || '';
        const tAttr = getAttr(attrs, 't');
        if (tAttr) currentTime = Number.parseInt(tAttr, 10);

        const duration = Number.parseInt(getAttr(attrs, 'd') || '0', 10);
        const repeat = Number.parseInt(getAttr(attrs, 'r') || '0', 10);
        const count = repeat >= 0 ? repeat + 1 : 1;

        for (let i = 0; i < count; i++) {
            segments.push({ number: currentNumber, time: currentTime });
            currentTime += duration;
            currentNumber++;
        }
    }

    return {
        kind: 'dash',
        baseUrl: firstTagText(representation, 'BaseURL') || firstTagText(audioSet, 'BaseURL') || firstTagText(xml, 'BaseURL'),
        initialization: getAttr(segmentTemplate, 'initialization'),
        media: getAttr(segmentTemplate, 'media'),
        segments,
        representationId: getAttr(representationAttrs, 'id'),
        mimeType: getAttr(audioSet, 'mimeType') || getAttr(representationAttrs, 'mimeType'),
    };
}

export function inspectManifest(manifest) {
    const decoded = decodeManifest(manifest);

    if (!decoded) {
        return {
            kind: 'unknown',
            raw: manifest || null,
            decoded: null,
            urls: [],
            streamUrl: null,
            dash: null,
        };
    }

    if (typeof decoded === 'object') {
        const urls = Array.isArray(decoded.urls) ? sortUrlsByQuality(decoded.urls) : [];
        return {
            kind: urls.length ? 'json-urls' : 'json',
            raw: manifest,
            decoded,
            urls,
            streamUrl: urls[0] || null,
            dash: null,
        };
    }

    const text = String(decoded);
    if (text.includes('<MPD')) {
        return {
            kind: 'dash',
            raw: manifest,
            decoded: text,
            urls: [],
            streamUrl: null,
            dash: parseDashSegmentManifest(text),
        };
    }

    try {
        const parsed = JSON.parse(text);
        const urls = Array.isArray(parsed?.urls) ? sortUrlsByQuality(parsed.urls) : [];
        return {
            kind: urls.length ? 'json-urls' : 'json',
            raw: manifest,
            decoded: parsed,
            urls,
            streamUrl: urls[0] || null,
            dash: null,
        };
    } catch {
        const match = text.match(/https?:\/\/[\w\-.~:?#[@!$&'()*+,;=%/]+/);
        return {
            kind: match ? 'direct-url-text' : 'text',
            raw: manifest,
            decoded: text,
            urls: match ? [match[0]] : [],
            streamUrl: match ? match[0] : null,
            dash: null,
        };
    }
}

function getPresentationFlags(info = {}) {
    const flags = {
        assetPresentation: info.assetPresentation ?? info.AssetPresentation ?? null,
        trackPresentation: info.trackPresentation ?? info.TrackPresentation ?? null,
        audioMode: info.audioMode ?? info.AudioMode ?? null,
        audioQuality: info.audioQuality ?? info.AudioQuality ?? null,
        manifestMimeType: info.manifestMimeType ?? info.ManifestMimeType ?? null,
    };

    return {
        ...flags,
        isPreview: Object.values(flags).some((value) => String(value || '').toUpperCase() === 'PREVIEW'),
    };
}

function replayGainFromInfo(info = {}) {
    return {
        trackReplayGain: info.trackReplayGain ?? info.replayGain ?? 0,
        trackPeakAmplitude: info.trackPeakAmplitude ?? info.peakAmplitude ?? 1,
        albumReplayGain: info.albumReplayGain ?? 0,
        albumPeakAmplitude: info.albumPeakAmplitude ?? 1,
    };
}

function normalizeTrack(track, album = null) {
    const normalized = { ...(track || {}) };
    if (!normalized.artist && Array.isArray(normalized.artists) && normalized.artists.length > 0) {
        normalized.artist = normalized.artists[0];
    }
    if (album && normalized.album) {
        normalized.album = {
            ...normalized.album,
            releaseDate: normalized.album.releaseDate || album.releaseDate,
            cover: normalized.album.cover || album.cover,
        };
    }
    return normalized;
}

function normalizeAlbum(album) {
    if (!album) return album;
    if (!album.artist && Array.isArray(album.artists) && album.artists.length > 0) {
        return { ...album, artist: album.artists[0] };
    }
    return album;
}

function getDiscNumber(track) {
    return track?.volumeNumber || track?.discNumber || track?.album?.volumeNumber || 1;
}

function trackOrderInfo(track, index, albumTracks) {
    const discNumber = getDiscNumber(track);
    const discTracks = albumTracks.filter((candidate) => getDiscNumber(candidate) === discNumber);
    const trackNumber = track?.trackNumber || track?.number || index + 1;

    return {
        index,
        discNumber,
        trackNumber,
        totalTracksOnDisc: discTracks.length || undefined,
    };
}

export class MonochromeResolverFacade {
    constructor({ env = {}, fetchImpl = null, monochromeApi = null } = {}) {
        this.env = env;
        this.fetch = fetchImpl;
        this.monochromeApi = monochromeApi;
        this.apiPromise = null;
    }

    installServerLocalStorage() {
        if (globalThis.localStorage) return globalThis.localStorage;

        const values = new Map();
        globalThis.localStorage = {
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
        return globalThis.localStorage;
    }

    applyEnvSettings(localStorage) {
        const userInstances = {
            api: envList(this.env, 'DOWNLOAD_API_INSTANCES') || [],
            streaming: envList(this.env, 'DOWNLOAD_STREAMING_INSTANCES') || [],
            qobuz: envList(this.env, 'DOWNLOAD_QOBUZ_INSTANCES') || [],
        };
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
            if (this.env?.[envKey] != null && String(this.env[envKey]).trim() !== '') {
                localStorage.setItem(storageKey, String(this.env[envKey]));
            }
        }

        this.applyServerRuntimeProviderGuards(localStorage);
    }

    applyServerRuntimeProviderGuards(localStorage) {
        const hasBrowserTurnstile = typeof window !== 'undefined' && typeof document !== 'undefined';
        const bypassToken =
            this.env?.AMAZON_MUSIC_TURNSTILE_BYPASS_TOKEN ||
            localStorage.getItem('amazon-music-turnstile-bypass-token');

        if (!hasBrowserTurnstile && !String(bypassToken || '').trim()) {
            localStorage.setItem('amazon-music-enabled', 'false');
            localStorage.removeItem('amazon-music-turnstile-site-key');
        }
    }

    async initializeHiFiClient(localStorage) {
        const { HiFiClient } = await import('../../js/HiFi.ts');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

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

    async getApi() {
        if (this.monochromeApi) return this.monochromeApi;
        if (this.apiPromise) return this.apiPromise;

        this.apiPromise = (async () => {
            const localStorage = this.installServerLocalStorage();
            this.applyEnvSettings(localStorage);
            if (this.fetch) {
                globalThis.fetch = this.fetch;
            }

            const [{ LosslessAPI }, { apiSettings }] = await Promise.all([
                import('../../js/api.js'),
                import('../../js/storage.js'),
            ]);
            await this.initializeHiFiClient(localStorage);
            return new LosslessAPI(apiSettings);
        })();
        return this.apiPromise;
    }

    async resolveTrackDownload(trackId, quality = 'LOSSLESS') {
        const normalizedQuality = normalizeQuality(quality);
        const api = await this.getApi();
        const enriched = await api.enrichTrack(trackId, { downloadQuality: normalizedQuality });
        const lookup = enriched.lookup || {};
        const track = enriched.enrichedTrack || {};
        const manifestDetails = inspectManifest(lookup.info?.manifest);
        const streamUrl =
            enriched.externalStreamType?.includes('cenc')
                ? enriched.externalSourceUrl || enriched.externalStreamUrl
                : enriched.externalStreamUrl || enriched.qobuzStreamUrl || lookup.originalTrackUrl || manifestDetails.streamUrl;
        const presentationFlags = getPresentationFlags(lookup.info);

        return this.buildResolvedTrack({
            provider: enriched.externalProvider || (enriched.qobuzStreamUrl ? 'qobuz' : 'monochrome'),
            providerInstance: null,
            track,
            lookup,
            streamUrl,
            sourceUrl: enriched.externalSourceUrl || streamUrl,
            manifest: lookup.info?.manifest || null,
            manifestDetails,
            quality: normalizedQuality,
            replayGain: track.replayGain || replayGainFromInfo(lookup.info),
            presentationFlags,
            metadataProvider: 'monochrome',
            providerErrors: [],
            external: {
                streamType: enriched.externalStreamType || null,
                decryptionKey: enriched.externalDecryptionKey || null,
                keyId: enriched.externalKeyId || null,
                mimeType: enriched.externalMimeType || lookup.info?.manifestMimeType || null,
                mediaMimeType: enriched.externalMediaMimeType || null,
                qualityDisplay: enriched.externalQualityDisplay || null,
            },
        });
    }

    buildResolvedTrack({
        provider,
        providerInstance,
        track,
        lookup = null,
        streamUrl,
        sourceUrl,
        manifest,
        manifestDetails,
        quality,
        replayGain,
        presentationFlags,
        metadataProvider,
        providerErrors,
        external = {},
    }) {
        return {
            type: 'track',
            provider,
            providerInstance,
            providerErrors,
            id: String(track.id ?? lookup?.track?.id ?? ''),
            quality,
            streamUrl,
            sourceUrl,
            proxiedStreamUrl: streamUrl ? getProxyUrl(streamUrl) : null,
            manifest,
            manifestKind: manifestDetails.kind,
            manifestMimeType: external?.mimeType || lookup?.info?.manifestMimeType || manifestDetails.dash?.mimeType || null,
            manifestDetails,
            dash: manifestDetails.dash,
            segments: manifestDetails.dash?.segments || [],
            urls: manifestDetails.urls?.length ? manifestDetails.urls : streamUrl ? [streamUrl] : [],
            decryptionKey: external?.decryptionKey || null,
            keyId: external?.keyId || null,
            mediaMimeType: external?.mediaMimeType || null,
            externalStreamType: external?.streamType || null,
            qualityDisplay: external?.qualityDisplay || null,
            metadata: track,
            metadataProvider,
            duration: track.duration ?? lookup?.track?.duration ?? null,
            cover: track.album?.cover || track.cover || null,
            coverUrl: coverUrlFromId(track.album?.cover || track.cover),
            isrc: track.isrc || null,
            replayGain,
            presentationFlags,
            isPreview: presentationFlags.isPreview,
        };
    }

    async resolveAlbum(albumId) {
        const api = await this.getApi();
        const albumResponse = await api.getAlbum(albumId);
        const album = albumResponse.album;
        const rawTracks = albumResponse.tracks || [];
        const tracks = rawTracks.map((track, index) => ({
            ...normalizeTrack(track, album),
            downloadOrder: trackOrderInfo(track, index, rawTracks),
        }));

        return {
            type: 'album',
            provider: 'monochrome',
            providerInstance: null,
            id: String(album.id ?? albumId),
            metadata: normalizeAlbum(album),
            tracks,
            cover: album.cover || null,
            coverUrl: coverUrlFromId(album.cover),
            totalTracks: album.numberOfTracks ?? tracks.length,
            totalDiscs: album.numberOfVolumes || Math.max(1, ...tracks.map((track) => track.downloadOrder.discNumber || 1)),
        };
    }
}

export class ServerResolverAdapter {
    constructor({ resolverFacade = null, ...options } = {}) {
        this.facade = resolverFacade || new MonochromeResolverFacade(options);
    }

    async resolveTrackDownload(trackId, quality = 'LOSSLESS') {
        return this.facade.resolveTrackDownload(trackId, quality);
    }

    async resolveAlbum(albumId) {
        return this.facade.resolveAlbum(albumId);
    }
}

export function createResolverAdapter(options = {}) {
    return new ServerResolverAdapter(options);
}

export async function resolveTrackDownload(trackId, quality = 'LOSSLESS', options = {}) {
    return createResolverAdapter(options).resolveTrackDownload(trackId, quality);
}

export async function resolveAlbum(albumId, options = {}) {
    return createResolverAdapter(options).resolveAlbum(albumId);
}
