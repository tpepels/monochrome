import { describe, expect, test, vi } from 'vitest';
import { MonochromeResolverFacade, ServerResolverAdapter, inspectManifest } from './resolver-adapter.js';

describe('server resolver adapter', () => {
    test('delegates queued metadata through the resolver facade', async () => {
        const calls = [];
        const adapter = new ServerResolverAdapter({
            resolverFacade: {
                async resolveTrackDownload(trackId, quality, options) {
                    calls.push(['track', trackId, quality, options.track?.title]);
                    return { type: 'track', id: trackId, quality };
                },
                async resolveAlbum(albumId, options) {
                    calls.push(['album', albumId, options.album?.title, options.tracks?.length]);
                    return { type: 'album', id: albumId, tracks: options.tracks || [] };
                },
            },
        });

        await adapter.resolveTrackDownload('t1', 'LOSSLESS', { track: { title: 'Song' } });
        await adapter.resolveAlbum('a1', { album: { title: 'Album' }, tracks: [{ id: 't1' }] });

        expect(calls).toEqual([
            ['track', 't1', 'LOSSLESS', 'Song'],
            ['album', 'a1', 'Album', 1],
        ]);
    });

    test('resolves a server download with the upstream Tracks client', async () => {
        const tracksApi = {
            resolveTrackStream: vi.fn(async (_id, quality, { track }) => ({
                url: 'https://tracks.example/track/123',
                sourceUrl: 'https://tracks.example/track/123',
                provider: 'monochrome',
                quality,
                qualityDisplay: 'FLAC',
                playbackType: 'direct',
                mediaMimeType: 'audio/flac',
                rgInfo: null,
                track,
            })),
        };
        const facade = new MonochromeResolverFacade({ tracksApi });
        const track = {
            id: '123',
            title: 'Song',
            duration: 245,
            isrc: 'ISRC1',
            album: { title: 'Album', cover: 'https://images.example/cover.jpg' },
            artist: { name: 'Artist' },
        };

        const result = await facade.resolveTrackDownload('123', 'LOSSLESS', { track });

        expect(tracksApi.resolveTrackStream).toHaveBeenCalledWith('123', 'LOSSLESS', { track });
        expect(result.provider).toBe('monochrome');
        expect(result.streamUrl).toBe('https://tracks.example/track/123');
        expect(result.urls).toEqual(['https://tracks.example/track/123']);
        expect(result.mediaMimeType).toBe('audio/flac');
        expect(result.metadata.title).toBe('Song');
        expect(result.coverUrl).toBe('https://images.example/cover.jpg');
        expect(result.isPreview).toBe(false);
    });

    test('reports a resolver failure when Tracks has no stream', async () => {
        const facade = new MonochromeResolverFacade({
            tracksApi: { resolveTrackStream: vi.fn(async () => null) },
        });

        await expect(
            facade.resolveTrackDownload('missing', 'LOSSLESS', {
                track: { id: 'missing', title: 'Missing', artist: { name: 'Artist' } },
            })
        ).rejects.toMatchObject({
            message: 'Could not resolve audio stream for track ID: missing',
            failureCode: 'RESOLVER_FETCH_FAILED',
        });
    });

    test('uses queued album metadata without an additional metadata provider', async () => {
        const tracksApi = { getAlbum: vi.fn() };
        const facade = new MonochromeResolverFacade({ tracksApi });
        const album = {
            id: 'alb1',
            title: 'Album',
            cover: 'https://images.example/album.jpg',
            artist: { name: 'Artist' },
        };
        const tracks = [
            { id: 't1', title: 'One', trackNumber: 1, volumeNumber: 1, album: {} },
            { id: 't2', title: 'Two', trackNumber: 2, volumeNumber: 1, album: {} },
        ];

        const result = await facade.resolveAlbum('alb1', { album, tracks });

        expect(tracksApi.getAlbum).not.toHaveBeenCalled();
        expect(result.tracks).toHaveLength(2);
        expect(result.tracks[0].downloadOrder.trackNumber).toBe(1);
        expect(result.tracks[1].downloadOrder.trackNumber).toBe(2);
        expect(result.coverUrl).toBe('https://images.example/album.jpg');
    });

    test('falls back to Tracks album metadata when it was not queued', async () => {
        const tracksApi = {
            getAlbum: vi.fn(async () => ({
                album: { id: 'alb2', title: 'Fetched', artist: { name: 'Artist' } },
                tracks: [{ id: 't1', title: 'One', trackNumber: 1, volumeNumber: 1, album: {} }],
            })),
        };
        const facade = new MonochromeResolverFacade({ tracksApi });

        const result = await facade.resolveAlbum('alb2');

        expect(tracksApi.getAlbum).toHaveBeenCalledWith('alb2');
        expect(result.metadata.title).toBe('Fetched');
        expect(result.tracks).toHaveLength(1);
    });

    test('prioritizes lossless URLs in JSON manifests', () => {
        const inspected = inspectManifest({ urls: ['https://x/aac.m4a', 'https://x/flac.flac'] });

        expect(inspected.kind).toBe('json-urls');
        expect(inspected.streamUrl).toBe('https://x/flac.flac');
    });

    test('parses DASH segment manifests', () => {
        const mpd =
            '<MPD><Period><AdaptationSet mimeType="audio/mp4"><Representation id="r1"><BaseURL>https://audio.example/base/</BaseURL><SegmentTemplate initialization="init.mp4" media="seg-$Number$.m4s" startNumber="1"><SegmentTimeline><S d="10" r="1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>';

        const inspected = inspectManifest(Buffer.from(mpd, 'utf8').toString('base64'));

        expect(inspected.kind).toBe('dash');
        expect(inspected.dash.segments).toHaveLength(2);
    });
});
