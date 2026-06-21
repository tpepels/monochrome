import { describe, expect, test } from 'vitest';
import { MonochromeResolverFacade, ServerResolverAdapter, inspectManifest } from './resolver-adapter.js';

describe('server resolver adapter', () => {
    function createMemoryStorage() {
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
        };
    }

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

    test('disables browser-only Amazon Turnstile flow on the server when no bypass token is configured', () => {
        const storage = createMemoryStorage();
        const facade = new MonochromeResolverFacade({
            env: {
                AMAZON_MUSIC_ENABLED: 'true',
                AMAZON_MUSIC_TURNSTILE_SITE_KEY: 'site-key',
            },
        });

        facade.applyEnvSettings(storage);

        expect(storage.getItem('amazon-music-enabled')).toBe('false');
        expect(storage.getItem('amazon-music-turnstile-site-key')).toBe(null);
    });

    test('keeps Amazon enabled on the server when a Turnstile bypass token is configured', () => {
        const storage = createMemoryStorage();
        const facade = new MonochromeResolverFacade({
            env: {
                AMAZON_MUSIC_ENABLED: 'true',
                AMAZON_MUSIC_TURNSTILE_BYPASS_TOKEN: 'bypass-token',
            },
        });

        facade.applyEnvSettings(storage);

        expect(storage.getItem('amazon-music-enabled')).toBe('true');
        expect(storage.getItem('amazon-music-turnstile-bypass-token')).toBe('bypass-token');
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
});
