import { describe, expect, test } from 'vitest';
import { ServerResolverAdapter, inspectManifest } from './resolver-adapter.js';

const jsonResponse = (data, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
    });

const textResponse = (data, status = 200, contentType = 'text/plain') =>
    new Response(data, {
        status,
        headers: { 'content-type': contentType },
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

    test('prefers Qobuz when ISRC lookup returns a stream URL', async () => {
        const calls = [];
        const fetchImpl = async (url) => {
            calls.push(String(url));

            if (String(url).includes('/info/')) {
                return jsonResponse({
                    data: {
                        id: '123',
                        title: 'Song',
                        duration: 245,
                        isrc: 'ISRC1',
                        album: { id: 'alb1', title: 'Album', cover: 'abc-def' },
                        artist: { name: 'Artist' },
                    },
                });
            }

            if (String(url).includes('/api/get-music')) {
                return jsonResponse({
                    data: {
                        tracks: {
                            items: [
                                {
                                    id: 'q1',
                                    isrc: 'ISRC1',
                                    audio_info: {
                                        replaygain_track_gain: -4,
                                        replaygain_track_peak: 0.9,
                                    },
                                },
                            ],
                        },
                    },
                });
            }

            if (String(url).includes('/api/download-music')) {
                return jsonResponse({ success: true, data: { url: 'https://cdn.qobuz.test/song.flac' } });
            }

            throw new Error(`Unexpected fetch: ${url}`);
        };

        const adapter = new ServerResolverAdapter({
            fetchImpl,
            env: {
                DOWNLOAD_API_INSTANCES: 'https://api.test',
                DOWNLOAD_QOBUZ_INSTANCES: 'https://qobuz.test',
                DOWNLOAD_STREAMING_INSTANCES: 'https://stream.test',
            },
        });

        const result = await adapter.resolveTrackDownload('123', 'LOSSLESS');

        expect(result.provider).toBe('qobuz');
        expect(result.streamUrl).toBe('https://cdn.qobuz.test/song.flac');
        expect(result.isrc).toBe('ISRC1');
        expect(result.isPreview).toBe(false);
        expect(calls.some((url) => url.includes('/trackManifests'))).toBe(false);
    });

    test('falls back to hifi manifests and exposes preview flags', async () => {
        const mpd =
            '<MPD><Period><AdaptationSet mimeType="audio/mp4"><Representation id="r1"><BaseURL>https://audio.tidal.com/base/</BaseURL><SegmentTemplate initialization="init.mp4" media="seg-$Number$.m4s" startNumber="1"><SegmentTimeline><S d="10" r="1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>';

        const fetchImpl = async (url) => {
            if (String(url).includes('/info/')) {
                return jsonResponse({
                    data: {
                        id: '124',
                        title: 'Preview',
                        duration: 30,
                        isrc: null,
                        album: { cover: 'cov' },
                        artist: { name: 'A' },
                    },
                });
            }

            if (String(url).includes('/trackManifests/')) {
                return jsonResponse({
                    data: {
                        data: {
                            id: '124',
                            duration: 30,
                            attributes: {
                                uri: 'https://manifest.test/124',
                                trackPresentation: 'PREVIEW',
                                formats: ['FLAC'],
                            },
                        },
                    },
                });
            }

            if (String(url) === 'https://manifest.test/124') {
                return textResponse(mpd, 200, 'application/dash+xml');
            }

            throw new Error(`Unexpected fetch: ${url}`);
        };

        const adapter = new ServerResolverAdapter({
            fetchImpl,
            env: {
                DOWNLOAD_API_INSTANCES: 'https://api.test',
                DOWNLOAD_STREAMING_INSTANCES: 'https://stream.test',
            },
        });

        const result = await adapter.resolveTrackDownload('124', 'LOSSLESS');

        expect(result.provider).toBe('hifi');
        expect(result.manifestKind).toBe('dash');
        expect(result.segments).toHaveLength(2);
        expect(result.isPreview).toBe(true);
        expect(result.presentationFlags.trackPresentation).toBe('PREVIEW');
    });

    test('normalizes album metadata and stable track order', async () => {
        const fetchImpl = async (url) => {
            if (String(url).includes('/album/')) {
                return jsonResponse({
                    data: {
                        id: 'alb1',
                        title: 'Album',
                        numberOfTracks: 2,
                        cover: 'cov',
                        artist: { name: 'Artist' },
                        items: [
                            { id: 't1', title: 'One', trackNumber: 1, volumeNumber: 1, album: {} },
                            { id: 't2', title: 'Two', trackNumber: 2, volumeNumber: 1, album: {} },
                        ],
                    },
                });
            }

            throw new Error(`Unexpected fetch: ${url}`);
        };

        const adapter = new ServerResolverAdapter({
            fetchImpl,
            env: { DOWNLOAD_API_INSTANCES: 'https://api.test' },
        });

        const result = await adapter.resolveAlbum('alb1');

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
