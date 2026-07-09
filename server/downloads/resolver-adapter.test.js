import { afterEach, describe, expect, test, vi } from 'vitest';
import { MonochromeResolverFacade, ServerResolverAdapter, inspectManifest } from './resolver-adapter.js';
import { installServerLocalStorage } from './monochrome-runtime.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('server resolver adapter', () => {
    test('delegates resolution through the injected Monochrome resolver facade', async () => {
        const calls = [];
        const adapter = new ServerResolverAdapter({
            resolverFacade: {
                async resolveTrackDownload(trackId, quality) {
                    calls.push(['track', trackId, quality]);
                    return { type: 'track', id: trackId, quality };
                },
                async resolveAlbum(albumId) {
                    calls.push(['album', albumId]);
                    return { type: 'album', id: albumId, tracks: [] };
                },
            },
        });

        await expect(adapter.resolveTrackDownload('t1', 'LOSSLESS')).resolves.toMatchObject({ id: 't1' });
        await expect(adapter.resolveAlbum('a1')).resolves.toMatchObject({ id: 'a1' });
        expect(calls).toEqual([
            ['track', 't1', 'LOSSLESS'],
            ['album', 'a1'],
        ]);
    });

    test('normalizes track resolution from the upstream Monochrome download flow', async () => {
        const facade = new MonochromeResolverFacade({
            monochromeApi: {
                async enrichTrack(trackId, { downloadQuality }) {
                    return {
                        externalProvider: 'amazon',
                        externalStreamType: 'dash-cenc',
                        externalStreamUrl: 'blob:amazon-mpd',
                        externalSourceUrl: 'https://amazon.test/encrypted.mp4',
                        externalDecryptionKey: '001122',
                        externalKeyId: 'key-id',
                        externalMimeType: 'application/dash+xml',
                        externalMediaMimeType: 'audio/mp4; codecs="flac"',
                        lookup: {
                            info: {
                                audioQuality: downloadQuality,
                                assetPresentation: 'FULL',
                                trackPresentation: 'FULL',
                                trackReplayGain: -3,
                                trackPeakAmplitude: 0.9,
                            },
                        },
                        enrichedTrack: {
                            id: trackId,
                            title: 'Song',
                            duration: 245,
                            isrc: 'ISRC1',
                            album: { title: 'Album', cover: 'abc-def' },
                            artist: { name: 'Artist' },
                        },
                    };
                },
            },
        });

        const result = await facade.resolveTrackDownload('123', 'LOSSLESS');

        expect(result.provider).toBe('amazon');
        expect(result.streamUrl).toBe('https://amazon.test/encrypted.mp4');
        expect(result.urls).toEqual(['https://amazon.test/encrypted.mp4']);
        expect(result.decryptionKey).toBe('001122');
        expect(result.mediaMimeType).toBe('audio/mp4; codecs="flac"');
        expect(result.metadata.title).toBe('Song');
        expect(result.isPreview).toBe(false);
    });

    test('keeps server manifest inspection for upstream hifi manifests and preview flags', async () => {
        const mpd =
            '<MPD><Period><AdaptationSet mimeType="audio/mp4"><Representation id="r1"><BaseURL>https://audio.tidal.com/base/</BaseURL><SegmentTemplate initialization="init.mp4" media="seg-$Number$.m4s" startNumber="1"><SegmentTimeline><S d="10" r="1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>';
        const facade = new MonochromeResolverFacade({
            monochromeApi: {
                async enrichTrack(trackId) {
                    return {
                        lookup: {
                            info: {
                                manifest: Buffer.from(mpd, 'utf8').toString('base64'),
                                trackPresentation: 'PREVIEW',
                                audioQuality: 'LOSSLESS',
                            },
                        },
                        enrichedTrack: {
                            id: trackId,
                            title: 'Preview',
                            duration: 30,
                            album: { cover: 'cov' },
                            artist: { name: 'A' },
                        },
                    };
                },
            },
        });

        const result = await facade.resolveTrackDownload('124', 'LOSSLESS');

        expect(result.provider).toBe('monochrome');
        expect(result.manifestKind).toBe('dash');
        expect(result.segments).toHaveLength(2);
        expect(result.isPreview).toBe(true);
        expect(result.presentationFlags.trackPresentation).toBe('PREVIEW');
    });

    test('falls back to upstream native TIDAL manifests when external providers miss', async () => {
        const mpd =
            '<MPD><Period><AdaptationSet mimeType="audio/mp4"><Representation id="r1"><SegmentTemplate initialization="https://audio.tidal.test/init.mp4?token=a&amp;info=b" media="https://audio.tidal.test/seg-$Number$.m4s?token=a&amp;info=b" startNumber="1"><SegmentTimeline><S d="10"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>';
        const calls = [];
        const facade = new MonochromeResolverFacade({
            monochromeApi: {
                getTrackManifestFormats() {
                    return ['FLAC'];
                },
                async enrichTrack() {
                    throw new Error('Could not resolve audio stream from Amazon Music, Qobuz, or Deezer');
                },
                async fetchWithRetry(path, options) {
                    calls.push([path, options]);
                    return {
                        async json() {
                            return { native: true };
                        },
                    };
                },
                async normalizeTrackManifestResponse(_json, quality) {
                    return [
                        { id: 125, duration: 240 },
                        {
                            manifest: Buffer.from(mpd, 'utf8').toString('base64'),
                            manifestMimeType: 'application/dash+xml',
                            audioQuality: quality,
                            assetPresentation: 'FULL',
                        },
                    ];
                },
                parseTrackLookup(entries) {
                    return { track: entries[0], info: entries[1] };
                },
                async getTrackMetadata(trackId) {
                    return {
                        id: trackId,
                        title: 'TIDAL Song',
                        duration: 240,
                        isrc: 'ISRC2',
                        album: { title: 'Album', cover: 'cov' },
                        artist: { name: 'Artist' },
                    };
                },
            },
        });

        const result = await facade.resolveTrackDownload('125', 'LOSSLESS');

        expect(calls[0][0]).toContain('/trackManifests/?id=125');
        expect(calls[0][1]).toMatchObject({ type: 'api', directOnly: true });
        expect(result.provider).toBe('tidal');
        expect(result.manifestKind).toBe('dash');
        expect(result.dash.initialization).toContain('&info=b');
        expect(result.dash.initialization).not.toContain('&amp;');
        expect(result.urls).toEqual([]);
        expect(result.providerErrors[0]).toContain('Amazon Music, Qobuz, or Deezer');
        expect(result.isPreview).toBe(false);
    });

    test('normalizes album metadata and stable track order from upstream getAlbum', async () => {
        const facade = new MonochromeResolverFacade({
            monochromeApi: {
                async getAlbum() {
                    return {
                        album: {
                            id: 'alb1',
                            title: 'Album',
                            numberOfTracks: 2,
                            cover: 'cov',
                            artist: { name: 'Artist' },
                        },
                        tracks: [
                            { id: 't1', title: 'One', trackNumber: 1, volumeNumber: 1, album: {} },
                            { id: 't2', title: 'Two', trackNumber: 2, volumeNumber: 1, album: {} },
                        ],
                    };
                },
            },
        });

        const result = await facade.resolveAlbum('alb1');

        expect(result.provider).toBe('monochrome');
        expect(result.tracks).toHaveLength(2);
        expect(result.tracks[0].downloadOrder.trackNumber).toBe(1);
        expect(result.tracks[1].downloadOrder.trackNumber).toBe(2);
        expect(result.coverUrl).toContain('/cov/');
    });

    test('prioritizes lossless URLs in JSON manifests', () => {
        const inspected = inspectManifest({ urls: ['https://x/aac.m4a', 'https://x/flac.flac'] });

        expect(inspected.kind).toBe('json-urls');
        expect(inspected.streamUrl).toBe('https://x/flac.flac');
    });

    test('server-side Deezer lookup uses provider URL with allowed origin headers', async () => {
        const storage = installServerLocalStorage({});
        storage.setItem('deezer-fallback-enabled', 'true');
        storage.setItem('deezer-fallback-api-base-url', 'https://dzr.tabs-vs-spaces.wtf');

        vi.stubGlobal('localStorage', storage);
        vi.stubGlobal('window', undefined);

        const { LosslessAPI } = await import('../../js/api.js');
        const api = new LosslessAPI({});
        const calls = [];
        vi.stubGlobal(
            'fetch',
            vi.fn((url, options) => {
                calls.push({ url: String(url), options });
                return Promise.resolve(new Response(null, { status: 200 }));
            })
        );

        const result = await api.getDeezerStreamUrl('GX7TZ2600001', 'LOSSLESS');

        expect(result.url).toBe('https://dzr.tabs-vs-spaces.wtf/stream/?isrc=GX7TZ2600001&format=FLAC');
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(result.url);
        expect(calls[0].options.headers.origin).toBe('https://monochrome.tf');
        expect(calls[0].options.headers.referer).toBe('https://monochrome.tf/');
    });
});
