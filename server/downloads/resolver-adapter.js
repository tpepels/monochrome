import { getProxyUrl } from '../../js/proxy-utils.js';

const INSTANCE_TIMEOUT_MS = 8000;
const INSTANCE_DISCOVERY_URL = 'https://tidal-uptime.geeked.wtf';

const FALLBACK_INSTANCES = Object.freeze({
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
    qobuz: [
        { url: 'https://qdl-api.monochrome.tf', version: '1.0' },
        { url: 'https://qobuz.kennyy.com.br', version: '1.0' },
        { url: 'https://mono.scavengerfurs.net', version: '1.0' },
    ],
});

const QUALITY_TO_TIDAL_FORMATS = Object.freeze({
    DOLBY_ATMOS: ['EAC3_JOC'],
    HI_RES_LOSSLESS: ['FLAC_HIRES'],
    LOSSLESS: ['FLAC'],
    HIGH: ['AACLC'],
    LOW: ['HEAACV1'],
});

const QUALITY_TO_QOBUZ = Object.freeze({
    HI_RES_LOSSLESS: '27',
    LOSSLESS: '6',
    HIGH: '5',
    LOW: '5',
});

function resolverError(message, failureCode, details = {}) {
    const error = new Error(message);
    error.failureCode = failureCode;
    Object.assign(error, details);
    return error;
}

function normalizeQuality(quality) {
    const normalized = String(quality || '').trim().toUpperCase();
    if (normalized === 'NORMAL') return 'HIGH';
    if (normalized === 'LOW_MP3') return 'LOW';
    return normalized || 'LOSSLESS';
}

function getTrackManifestFormats(quality) {
    return QUALITY_TO_TIDAL_FORMATS[normalizeQuality(quality)] || ['FLAC'];
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

function normalizeInstanceUrl(instance) {
    const rawUrl = typeof instance === 'string' ? instance : instance?.url;
    return typeof rawUrl === 'string' ? rawUrl.replace(/\/+$/, '') : null;
}

function isBlockedInstance(instance) {
    const url = normalizeInstanceUrl(instance);
    return Boolean(url && /\.squid\.wtf/i.test(url));
}

function coverUrlFromId(id, size = '1280') {
    if (!id) return null;
    return `https://resources.tidal.com/images/${String(id).replace(/-/g, '/')}/${size}x${size}.jpg`;
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || INSTANCE_TIMEOUT_MS);
    try {
        return await fetchImpl(url, {
            ...options,
            signal: options.signal || controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

function unwrapData(json) {
    return json?.data ?? json;
}

function findTrackMetadata(data, id) {
    const items = Array.isArray(data) ? data : [data];
    const found = items.find((item) => item?.id == id || item?.item?.id == id);
    return found?.item || found || null;
}

function parseTrackLookup(data) {
    const entries = Array.isArray(data) ? data : [data];
    let track = null;
    let info = null;
    let originalTrackUrl = null;

    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;

        if (!track && 'duration' in entry) {
            track = entry;
            continue;
        }

        if (!info && 'manifest' in entry) {
            info = entry;
            continue;
        }

        if (!originalTrackUrl && typeof entry.OriginalTrackUrl === 'string') {
            originalTrackUrl = entry.OriginalTrackUrl;
        }
    }

    if (!track || !info) {
        throw resolverError('Malformed track response', 'MALFORMED_TRACK_RESPONSE', { data });
    }

    return { track, info, originalTrackUrl };
}

function decodeBase64(value) {
    if (typeof atob === 'function') return atob(value);
    return Buffer.from(value, 'base64').toString('utf8');
}

function encodeBase64(value) {
    if (typeof btoa === 'function') return btoa(value);
    return Buffer.from(value, 'utf8').toString('base64');
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

async function normalizeTrackManifestResponse(apiResponse, quality, fetchImpl) {
    if (!apiResponse || typeof apiResponse !== 'object') return apiResponse;

    const raw = apiResponse.data?.data ?? apiResponse.data ?? apiResponse;
    const attributes = raw?.attributes ?? {};
    const manifestUrl = attributes.uri;

    if (!manifestUrl) return apiResponse;

    const manifestResponse = await fetchWithTimeout(fetchImpl, manifestUrl);
    if (!manifestResponse.ok) {
        throw resolverError(`Failed to fetch signed track manifest: HTTP ${manifestResponse.status}`, 'SIGNED_MANIFEST_FETCH_FAILED', {
            status: manifestResponse.status,
        });
    }

    const manifestText = await manifestResponse.text();
    const normalizedQuality =
        getAudioQualityFromManifestFormats(attributes.formats) || normalizeQuality(quality) || 'HIGH';
    const isHiRes = normalizedQuality === 'HI_RES_LOSSLESS';
    const isLossless = normalizedQuality === 'LOSSLESS' || isHiRes;
    const trackNorm = attributes.trackAudioNormalizationData || {};
    const albumNorm = attributes.albumAudioNormalizationData || {};

    return [
        {
            duration: raw.duration ?? 0,
            id: Number(raw.id) || null,
        },
        {
            trackId: Number(raw.id) || null,
            assetPresentation: attributes.trackPresentation || attributes.assetPresentation || 'FULL',
            trackPresentation: attributes.trackPresentation || null,
            audioQuality: normalizedQuality,
            manifestMimeType:
                manifestResponse.headers.get('content-type') ||
                (manifestText.includes('<MPD') ? 'application/dash+xml' : 'application/octet-stream'),
            manifestHash: attributes.hash || '',
            manifest: encodeBase64(manifestText),
            bitDepth: isHiRes ? 24 : isLossless ? 16 : undefined,
            sampleRate: isHiRes ? 96000 : isLossless ? 44100 : undefined,
            replayGain: trackNorm.replayGain,
            trackReplayGain: trackNorm.replayGain,
            trackPeakAmplitude: trackNorm.peakAmplitude,
            albumReplayGain: albumNorm.replayGain,
            albumPeakAmplitude: albumNorm.peakAmplitude,
            drmData: attributes.drmData || null,
            formats: attributes.formats || [],
        },
    ];
}

function getAudioQualityFromManifestFormats(formats = []) {
    if (formats.includes('EAC3_JOC')) return 'DOLBY_ATMOS';
    if (formats.includes('FLAC_HIRES')) return 'HI_RES_LOSSLESS';
    if (formats.includes('FLAC')) return 'LOSSLESS';
    if (formats.includes('AACLC')) return 'HIGH';
    if (formats.includes('HEAACV1')) return 'LOW';
    return null;
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
    constructor({ env = {}, fetchImpl = globalThis.fetch } = {}) {
        this.env = env;
        this.fetch = fetchImpl;
        this.instanceCache = null;
    }

    async getInstances(type) {
        const envInstances =
            type === 'api'
                ? envList(this.env, 'DOWNLOAD_API_INSTANCES')
                : type === 'streaming'
                  ? envList(this.env, 'DOWNLOAD_STREAMING_INSTANCES')
                  : type === 'qobuz'
                    ? envList(this.env, 'DOWNLOAD_QOBUZ_INSTANCES')
                    : null;

        if (envInstances?.length) return envInstances;

        if (!this.instanceCache) {
            this.instanceCache = this.discoverInstances();
        }

        const instances = await this.instanceCache;
        return instances[type] || instances.api || [];
    }

    async discoverInstances() {
        try {
            const response = await this.fetchWithTimeout(INSTANCE_DISCOVERY_URL, { timeoutMs: 3000 });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const api = Array.isArray(data.api) ? data.api.filter((item) => !isBlockedInstance(item)) : [];
            const streaming = Array.isArray(data.streaming)
                ? data.streaming.filter((item) => !isBlockedInstance(item))
                : api;
            const qobuz = Array.isArray(data.qobuz) && data.qobuz.length ? data.qobuz : FALLBACK_INSTANCES.qobuz;
            return {
                api: api.length ? api : FALLBACK_INSTANCES.api,
                streaming: streaming.length ? streaming : FALLBACK_INSTANCES.streaming,
                qobuz,
            };
        } catch {
            return { ...FALLBACK_INSTANCES };
        }
    }

    async fetchWithTimeout(url, options = {}) {
        return fetchWithTimeout(this.fetch, url, options);
    }

    async fetchWithRetry(relativePath, type = 'api') {
        const instances = await this.getInstances(type);
        const providerErrors = [];

        for (const instance of instances) {
            const baseUrl = normalizeInstanceUrl(instance);
            if (!baseUrl) continue;

            const url = `${baseUrl}${relativePath.startsWith('/') ? relativePath : `/${relativePath}`}`;
            try {
                const response = await this.fetchWithTimeout(url);
                if (response.ok) return { response, provider: baseUrl };

                providerErrors.push({ provider: baseUrl, status: response.status });
            } catch (error) {
                providerErrors.push({ provider: baseUrl, error: error?.message || String(error) });
            }
        }

        throw resolverError(`All ${type} resolver instances failed for ${relativePath}`, 'RESOLVER_INSTANCES_FAILED', {
            providerErrors,
        });
    }

    async getTrackMetadata(trackId) {
        const { response, provider } = await this.fetchWithRetry(`/info/?id=${encodeURIComponent(trackId)}`, 'api');
        const data = unwrapData(await response.json());
        const track = findTrackMetadata(data, trackId);
        if (!track) {
            throw resolverError('Track metadata not found', 'TRACK_METADATA_NOT_FOUND', { provider });
        }
        return { track: normalizeTrack(track), provider };
    }

    async resolveQobuzStream(isrc, quality) {
        if (!isrc) return null;

        const providerErrors = [];
        for (const instance of await this.getInstances('qobuz')) {
            const baseUrl = normalizeInstanceUrl(instance);
            if (!baseUrl) continue;

            try {
                const searchResponse = await this.fetchWithTimeout(
                    `${baseUrl}/api/get-music?q=${encodeURIComponent(isrc)}&offset=0`
                );
                if (!searchResponse.ok) {
                    providerErrors.push({ provider: baseUrl, status: searchResponse.status, stage: 'search' });
                    continue;
                }

                const searchJson = await searchResponse.json();
                const tracks = searchJson.data?.tracks?.items || [];
                const match = tracks.find((track) => track.isrc?.toLowerCase() === isrc.toLowerCase()) || tracks[0];
                if (!match?.id) {
                    providerErrors.push({ provider: baseUrl, error: 'No Qobuz ISRC match', stage: 'search' });
                    continue;
                }

                const qobuzQuality = QUALITY_TO_QOBUZ[normalizeQuality(quality)] || '6';
                const streamResponse = await this.fetchWithTimeout(
                    `${baseUrl}/api/download-music?track_id=${encodeURIComponent(match.id)}&quality=${qobuzQuality}`
                );
                if (!streamResponse.ok) {
                    providerErrors.push({ provider: baseUrl, status: streamResponse.status, stage: 'stream' });
                    continue;
                }

                const streamJson = await streamResponse.json();
                if (streamJson.success && streamJson.data?.url) {
                    const audioInfo = match.audio_info || {};
                    return {
                        provider: baseUrl,
                        qobuzTrack: match,
                        streamUrl: streamJson.data.url,
                        replayGain: {
                            trackReplayGain: audioInfo.replaygain_track_gain ?? 0,
                            trackPeakAmplitude: audioInfo.replaygain_track_peak ?? 1,
                            albumReplayGain: audioInfo.replaygain_album_gain ?? 0,
                            albumPeakAmplitude: audioInfo.replaygain_album_peak ?? 1,
                        },
                    };
                }

                providerErrors.push({ provider: baseUrl, error: 'Qobuz stream response had no URL', stage: 'stream' });
            } catch (error) {
                providerErrors.push({ provider: baseUrl, error: error?.message || String(error) });
            }
        }

        return { providerErrors };
    }

    async getTrackManifest(trackId, quality) {
        const requestedQuality = normalizeQuality(quality);
        const params = new URLSearchParams({
            id: String(trackId),
            quality: requestedQuality,
            adaptive: 'false',
        });
        for (const format of getTrackManifestFormats(requestedQuality)) {
            params.append('formats', format);
        }

        const { response, provider } = await this.fetchWithRetry(`/trackManifests/?${params.toString()}`, 'streaming');
        const normalized = await normalizeTrackManifestResponse(await response.json(), requestedQuality, this.fetch);
        return {
            ...parseTrackLookup(normalized),
            provider,
        };
    }

    async resolveTrackDownload(trackId, quality = 'LOSSLESS') {
        const normalizedQuality = normalizeQuality(quality);
        const providerErrors = [];
        const { track, provider: metadataProvider } = await this.getTrackMetadata(trackId);

        if (track?.isrc) {
            const qobuz = await this.resolveQobuzStream(track.isrc, normalizedQuality);
            if (qobuz?.streamUrl) {
                return this.buildResolvedTrack({
                    provider: 'qobuz',
                    providerInstance: qobuz.provider,
                    track,
                    streamUrl: qobuz.streamUrl,
                    manifest: null,
                    manifestDetails: inspectManifest(null),
                    quality: normalizedQuality,
                    replayGain: qobuz.replayGain,
                    presentationFlags: getPresentationFlags({ assetPresentation: 'FULL', audioQuality: normalizedQuality }),
                    metadataProvider,
                    providerErrors,
                });
            }
            providerErrors.push(...(qobuz?.providerErrors || []));
        }

        const lookup = await this.getTrackManifest(trackId, normalizedQuality);
        const manifestDetails = inspectManifest(lookup.info?.manifest);
        const streamUrl = lookup.originalTrackUrl || manifestDetails.streamUrl;
        const presentationFlags = getPresentationFlags(lookup.info);

        return this.buildResolvedTrack({
            provider: 'hifi',
            providerInstance: lookup.provider,
            track,
            lookup,
            streamUrl,
            manifest: lookup.info?.manifest || null,
            manifestDetails,
            quality: normalizedQuality,
            replayGain: replayGainFromInfo(lookup.info),
            presentationFlags,
            metadataProvider,
            providerErrors,
        });
    }

    buildResolvedTrack({
        provider,
        providerInstance,
        track,
        lookup = null,
        streamUrl,
        manifest,
        manifestDetails,
        quality,
        replayGain,
        presentationFlags,
        metadataProvider,
        providerErrors,
    }) {
        return {
            type: 'track',
            provider,
            providerInstance,
            providerOrder: ['qobuz', 'hifi'],
            providerErrors,
            id: String(track.id ?? lookup?.track?.id ?? ''),
            quality,
            streamUrl,
            proxiedStreamUrl: streamUrl ? getProxyUrl(streamUrl) : null,
            manifest,
            manifestKind: manifestDetails.kind,
            manifestMimeType: lookup?.info?.manifestMimeType || manifestDetails.dash?.mimeType || null,
            manifestDetails,
            dash: manifestDetails.dash,
            segments: manifestDetails.dash?.segments || [],
            urls: manifestDetails.urls || (streamUrl ? [streamUrl] : []),
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
        const { response, provider } = await this.fetchWithRetry(`/album/?id=${encodeURIComponent(albumId)}`, 'api');
        const data = unwrapData(await response.json());
        let album = null;
        let tracksSection = null;

        if (data && typeof data === 'object' && !Array.isArray(data)) {
            if ('numberOfTracks' in data || 'title' in data) {
                album = normalizeAlbum(data);
            }
            if (Array.isArray(data.items)) {
                tracksSection = data;
                if (!album && data.items.length > 0) {
                    album = normalizeAlbum((data.items[0].item || data.items[0])?.album);
                }
            }
        }

        if (!album) {
            throw resolverError('Album not found', 'ALBUM_NOT_FOUND', { provider });
        }

        if (!album.artist && tracksSection?.items?.length) {
            const firstTrack = tracksSection.items[0].item || tracksSection.items[0];
            if (firstTrack?.artist) album = { ...album, artist: firstTrack.artist };
        }

        if (!album.releaseDate && tracksSection?.items?.length) {
            const firstTrack = tracksSection.items[0].item || tracksSection.items[0];
            if (firstTrack?.album?.releaseDate) {
                album = { ...album, releaseDate: firstTrack.album.releaseDate };
            } else if (firstTrack?.streamStartDate) {
                album = { ...album, releaseDate: firstTrack.streamStartDate.split('T')[0] };
            }
        }

        let tracks = (tracksSection?.items || []).map((item) => normalizeTrack(item.item || item, album));
        tracks = await this.fetchRemainingAlbumTracks(albumId, album, tracks);
        tracks = tracks.map((track, index) => ({
            ...normalizeTrack(track, album),
            downloadOrder: trackOrderInfo(track, index, tracks),
        }));

        return {
            type: 'album',
            provider: 'hifi',
            providerInstance: provider,
            id: String(album.id ?? albumId),
            metadata: normalizeAlbum(album),
            tracks,
            cover: album.cover || null,
            coverUrl: coverUrlFromId(album.cover),
            totalTracks: album.numberOfTracks ?? tracks.length,
            totalDiscs: album.numberOfVolumes || Math.max(1, ...tracks.map((track) => track.downloadOrder.discNumber || 1)),
        };
    }

    async fetchRemainingAlbumTracks(albumId, album, tracks) {
        const expected = Number(album?.numberOfTracks) || tracks.length;
        let offset = tracks.length;
        const safeMaxTracks = 10000;

        while (expected > tracks.length && tracks.length < safeMaxTracks) {
            let data;
            try {
                const { response } = await this.fetchWithRetry(
                    `/album/?id=${encodeURIComponent(albumId)}&offset=${offset}&limit=500`,
                    'api'
                );
                data = unwrapData(await response.json());
            } catch {
                break;
            }

            let nextItems = [];
            if (Array.isArray(data?.items)) {
                nextItems = data.items;
            } else if (Array.isArray(data)) {
                const section = data.find((entry) => Array.isArray(entry?.items));
                nextItems = section?.items || [];
            }

            if (!nextItems.length) break;

            const prepared = nextItems.map((item) => normalizeTrack(item.item || item, album));
            if (!prepared.length) break;
            if (tracks.length > 0 && prepared[0]?.id === tracks[0]?.id) break;

            tracks = tracks.concat(prepared);
            offset += prepared.length;
        }

        return tracks;
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
