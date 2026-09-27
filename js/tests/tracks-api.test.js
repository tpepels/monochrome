import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    TRACKS_API_BASE_URL,
    cleanString,
    normalizeTracksTrack,
    normalizeTracksRelease,
    normalizeTracksArtist,
    normalizeTracksPlaylist,
    normalizeTracksSearchResults,
    extractTracksSuggestions,
    scoreTrackCandidate,
    scoreAlternateTrackCandidate,
    TracksStreamerAPI,
    getTracksClientBaseUrl,
    getTracksClientAssetUrl,
    isTracksSnowflake,
} from '../tracks-api.js';

describe('tracks-api module', () => {
    describe('self-host routing helpers', () => {
        it('recognizes Tracks snowflake entity IDs without cache context', () => {
            expect(isTracksSnowflake('159504705419313152')).toBe(true);
            expect(isTracksSnowflake('tracks:artist:159504705419313152')).toBe(true);
            expect(isTracksSnowflake('123456789')).toBe(false);
        });

        it('rewrites Tracks-owned artwork through the active client base', () => {
            expect(
                getTracksClientAssetUrl('https://tracks.monochrome.st/proxy/mi/166516206571143168-1A01.jpg')
            ).toBe(`${getTracksClientBaseUrl()}/proxy/mi/166516206571143168-1A01.jpg`);
        });
    });

    describe('cleanString', () => {
        it('normalizes accents, punctuation, and featuring tags', () => {
            expect(cleanString('Get Lucky (feat. Pharrell Williams)')).toBe('getlucky');
            expect(cleanString('HUMBLE. [Explicit]')).toBe('humble');
            expect(cleanString('Beyoncé')).toBe('beyonce');
            expect(cleanString('Daft Punk - One More Time (12" Mix)')).toBe('daftpunkonemoretime');
        });
    });

    describe('normalizeTracksTrack', () => {
        it('normalizes raw track from tracks.monochrome.st correctly', () => {
            const raw = {
                id: '155142501534011392',
                trackId: '155142501534011392',
                title: 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)',
                artistIds: ['153542153123926016', '152963535956086784'],
                artistNames: ['Daft Punk', 'Pharrell Williams'],
                releaseId: '155142458219433984',
                artwork: 'https://tracks.monochrome.st/proxy/mi/155142458219433984-1A01.jpg',
                explicit: false,
                playable: true,
                duration: 369626,
                isrc: 'USQX91300108',
                recordingId: '156637005457920000',
            };

            const track = normalizeTracksTrack(raw);
            expect(track).toBeDefined();
            expect(track.id).toBe('155142501534011392');
            expect(track.trackId).toBe('155142501534011392');
            expect(track.tracksTrackId).toBe('155142501534011392');
            expect(track.title).toBe('Get Lucky (feat. Pharrell Williams and Nile Rodgers)');
            expect(track.duration).toBe(370); // 369626 ms -> 370 s
            expect(track.explicit).toBe(false);
            expect(track.isUnavailable).toBe(false);
            expect(track.isrc).toBe('USQX91300108');
            expect(track.recordingId).toBe('156637005457920000');
            expect(track.artist.name).toBe('Daft Punk');
            expect(track.artist.id).toBe('153542153123926016');
            expect(track.artists.length).toBe(2);
            expect(track.album.id).toBe('155142458219433984');
            expect(track.url).toBe(`${getTracksClientBaseUrl()}/track/155142501534011392`);
            expect(track._href).toBe('/track/155142501534011392');
            expect(track.audioQuality).toBe('LOSSLESS');
        });
    });

    it('keeps canonical release artist on normalized track album metadata', () => {
        const track = normalizeTracksTrack({
            id: 'track-1',
            title: 'Movement I',
            artistNames: ['Track Performer'],
            releaseId: 'release-1',
            albumTitle: 'Música callada',
            albumArtist: { id: 'album-artist', name: 'Frederic Mompou' },
            albumArtists: [{ id: 'album-artist', name: 'Frederic Mompou' }],
        });

        expect(track.artist.name).toBe('Track Performer');
        expect(track.album.title).toBe('Música callada');
        expect(track.album.releaseId).toBe('release-1');
        expect(track.album.artist.name).toBe('Frederic Mompou');
        expect(track.album.artists.map((artist) => artist.name)).toEqual(['Frederic Mompou']);
    });

    describe('normalizeTracksRelease', () => {
        it('normalizes raw release into album format', () => {
            const raw = {
                id: '155142458219433984',
                releaseId: '155142458219433984',
                title: 'Random Access Memories',
                artistIds: ['153542153123926016'],
                artistNames: ['Daft Punk'],
                releaseDate: '2013-05-20T00:00:00.000Z',
                releaseType: 'ALBUM',
                label: 'Columbia',
                artwork: 'https://tracks.monochrome.st/proxy/mi/155142458219433984-1A01.jpg',
                explicit: false,
                trackCount: 13,
            };

            const album = normalizeTracksRelease(raw);
            expect(album).toBeDefined();
            expect(album.id).toBe('155142458219433984');
            expect(album.releaseId).toBe('155142458219433984');
            expect(album.tracksReleaseId).toBe('155142458219433984');
            expect(album.title).toBe('Random Access Memories');
            expect(album.artist.name).toBe('Daft Punk');
            expect(album.cover).toBe(
                getTracksClientAssetUrl('https://tracks.monochrome.st/proxy/mi/155142458219433984-1A01.jpg')
            );
            expect(album.numberOfTracks).toBe(13);
            expect(album.type).toBe('ALBUM');
            expect(album._href).toBe('/album/155142458219433984');
        });
    });

    describe('normalizeTracksArtist', () => {
        it('normalizes raw artist', () => {
            const raw = {
                id: '153542153123926016',
                artistId: '153542153123926016',
                name: 'Daft Punk',
                displayName: 'Daft Punk',
                avatar: 'https://tracks.monochrome.st/proxy/c/media/153542153123926016-5A04.jpg',
                bio: 'Electronic music duo',
            };

            const artist = normalizeTracksArtist(raw);
            expect(artist).toBeDefined();
            expect(artist.id).toBe('153542153123926016');
            expect(artist.artistId).toBe('153542153123926016');
            expect(artist.name).toBe('Daft Punk');
            expect(artist.picture).toBe(
                getTracksClientAssetUrl('https://tracks.monochrome.st/proxy/c/media/153542153123926016-5A04.jpg')
            );
            expect(artist.biography).toBe('Electronic music duo');
            expect(artist._href).toBe('/artist/153542153123926016');
        });
    });

    describe('normalizeTracksSearchResults', () => {
        it('structures unified search results into standard tracks, albums, artists, playlists', () => {
            const raw = {
                tracks: [
                    {
                        trackId: '101',
                        title: 'Song A',
                        artistNames: ['Artist A'],
                        releaseId: '201',
                        duration: 180000,
                    },
                ],
                releases: [
                    {
                        releaseId: '201',
                        title: 'Album A',
                        artistNames: ['Artist A'],
                        trackCount: 1,
                    },
                ],
                artists: [
                    {
                        artistId: '301',
                        name: 'Artist A',
                    },
                ],
                playlists: [
                    {
                        playlistId: '401',
                        title: 'Playlist A',
                        trackCount: 5,
                    },
                ],
            };

            const normalized = normalizeTracksSearchResults(raw);
            expect(normalized.tracks.items.length).toBe(1);
            expect(normalized.albums.items.length).toBe(1);
            expect(normalized.artists.items.length).toBe(1);
            expect(normalized.playlists.items.length).toBe(1);
            expect(normalized.videos.items.length).toBe(0);
        });
    });

    describe('scoreTrackCandidate', () => {
        it('gives highest score for exact ISRC match', () => {
            const target = { isrc: 'USQX91300108', title: 'Song X', artist: { name: 'Artist Y' } };
            const candidate = { isrc: 'USQX91300108', title: 'Different Title', artistNames: ['Other'] };
            expect(scoreTrackCandidate(candidate, target)).toBe(200);
        });

        it('scores high on matching title and artist', () => {
            const target = { title: 'Get Lucky', artist: { name: 'Daft Punk' }, duration: 247 };
            const candidate = {
                title: 'Get Lucky (feat. Pharrell Williams)',
                artistNames: ['Daft Punk'],
                duration: 248000,
            };
            const score = scoreTrackCandidate(candidate, target);
            expect(score).toBeGreaterThanOrEqual(150);
        });

        it('gives low score on completely mismatched tracks', () => {
            const target = { title: 'Bohemian Rhapsody', artist: { name: 'Queen' }, duration: 354 };
            const candidate = { title: 'Karma Police', artistNames: ['Radiohead'], duration: 264000 };
            expect(scoreTrackCandidate(candidate, target)).toBe(0);
        });
    });

    describe('scoreAlternateTrackCandidate', () => {
        it('accepts exact recording IDs even when other metadata is sparse', () => {
            expect(
                scoreAlternateTrackCandidate(
                    { recordingId: 'rec-1', title: 'Other' },
                    { recordingId: 'rec-1', title: 'Target' }
                )
            ).toBe(300);
        });

        it('accepts exact title and artist when duration is unavailable', () => {
            expect(
                scoreAlternateTrackCandidate(
                    {
                        title: 'Marginalia #90',
                        artist: { name: 'Masayoshi Fujita' },
                        duration: 0,
                    },
                    {
                        title: 'Marginalia #90',
                        artist: { name: 'Masayoshi Fujita' },
                        duration: 0,
                    }
                )
            ).toBe(160);
        });

        it('requires close durations when both candidates provide them', () => {
            const target = {
                title: 'Marginalia #90',
                artist: { name: 'Masayoshi Fujita' },
                duration: 180,
            };
            expect(
                scoreAlternateTrackCandidate(
                    { title: 'Marginalia #90', artist: { name: 'Masayoshi Fujita' }, duration: 182 },
                    target
                )
            ).toBe(190);
            expect(
                scoreAlternateTrackCandidate(
                    { title: 'Marginalia #90', artist: { name: 'Masayoshi Fujita' }, duration: 220 },
                    target
                )
            ).toBe(0);
        });

        it('rejects version-title differences without exact recording identity', () => {
            expect(
                scoreAlternateTrackCandidate(
                    {
                        title: 'Marginalia #90 (Live)',
                        artist: { name: 'Masayoshi Fujita' },
                        duration: 180,
                    },
                    {
                        title: 'Marginalia #90',
                        artist: { name: 'Masayoshi Fujita' },
                        duration: 180,
                    }
                )
            ).toBe(0);
        });

        it('matches non-Latin exact titles and artists', () => {
            expect(
                scoreAlternateTrackCandidate(
                    { title: '琹の葉', artist: { name: 'イロノミ' }, duration: 0 },
                    { title: '琹の葉', artist: { name: 'イロノミ' }, duration: 0 }
                )
            ).toBe(160);
        });
    });

    describe('extractTracksSuggestions', () => {
        it('builds suggestions including query term and tracks', () => {
            const tracks = [
                {
                    trackId: '155142501534011392',
                    title: 'Get Lucky',
                    artistNames: ['Daft Punk'],
                    artwork: 'https://tracks.monochrome.st/proxy/mi/cover.jpg',
                },
            ];

            const suggestions = extractTracksSuggestions(tracks, 'daft punk');
            expect(suggestions.length).toBe(2);
            expect(suggestions[0].kind).toBe('term');
            expect(suggestions[0].searchTerm).toBe('daft punk');
            expect(suggestions[1].kind).toBe('song');
            expect(suggestions[1].displayTerm).toBe('Get Lucky');
            expect(suggestions[1].subtitle).toBe('Daft Punk');
        });
    });

    describe('TracksStreamerAPI client', () => {
        let api;
        beforeEach(() => {
            api = new TracksStreamerAPI(TRACKS_API_BASE_URL);
        });

        it('generates direct stream URL for any track ID', () => {
            const streamInfo = api.getStreamUrl('155142501534011392');
            expect(streamInfo.url).toBe('https://tracks.monochrome.st/track/155142501534011392');
            expect(streamInfo.provider).toBe('monochrome');
            expect(streamInfo.quality).toBe('LOSSLESS');
            expect(streamInfo.qualityDisplay).toBe('FLAC');
            expect(streamInfo.playbackType).toBe('direct');
            expect(streamInfo.mediaMimeType).toBe('audio/flac');
        });

        it('resolves track stream directly when given a tracks track object', async () => {
            const track = {
                id: 'tracks:track:155142501534011392',
                tracksTrackId: '155142501534011392',
                title: 'Get Lucky',
            };

            const stream = await api.resolveTrackStream(track);
            expect(stream).toBeDefined();
            expect(stream.url).toBe('https://tracks.monochrome.st/track/155142501534011392');
        });

        it('finds a strict alternate stream while excluding the broken track id', async () => {
            vi.spyOn(api, 'searchTracks').mockResolvedValueOnce({
                items: [
                    {
                        trackId: '245266990510825472',
                        tracksTrackId: '245266990510825472',
                        title: 'Marginalia #147',
                        artist: { name: 'Masayoshi Fujita' },
                        duration: 180,
                    },
                    {
                        trackId: '999999999999999999',
                        tracksTrackId: '999999999999999999',
                        title: 'Marginalia #147',
                        artist: { name: 'Masayoshi Fujita' },
                        duration: 181,
                    },
                    {
                        trackId: '888888888888888888',
                        tracksTrackId: '888888888888888888',
                        title: 'Marginalia #147 (Live)',
                        artist: { name: 'Masayoshi Fujita' },
                        duration: 240,
                    },
                ],
            });

            const track = {
                id: '245266990510825472',
                tracksTrackId: '245266990510825472',
                title: 'Marginalia #147',
                artist: { name: 'Masayoshi Fujita' },
                duration: 180,
            };

            const stream = await api.resolveAlternateTrackStream(track.id, 'LOSSLESS', {
                track,
                excludeTrackId: track.id,
            });

            expect(api.searchTracks).toHaveBeenCalledWith('Masayoshi Fujita Marginalia #147', {
                limit: 12,
                signal: undefined,
                skipCache: true,
            });
            expect(stream).toMatchObject({
                alternateTrackId: '999999999999999999',
                originalTrackId: '245266990510825472',
                matchScore: 190,
                exactIsrc: false,
                durationVerified: true,
                url: 'https://tracks.monochrome.st/track/999999999999999999',
            });
        });

        it('uses an exact title and artist alternate when duration is unavailable', async () => {
            vi.spyOn(api, 'searchTracks').mockResolvedValueOnce({
                items: [
                    {
                        trackId: '999999999999999999',
                        tracksTrackId: '999999999999999999',
                        title: 'Marginalia #90',
                        artist: { name: 'Masayoshi Fujita' },
                        duration: 0,
                    },
                ],
            });

            const stream = await api.resolveAlternateTrackStream('194521912716636160', 'LOSSLESS', {
                track: {
                    id: '194521912716636160',
                    title: 'Marginalia #90',
                    artist: { name: 'Masayoshi Fujita' },
                    duration: 0,
                },
            });

            expect(stream).toMatchObject({
                alternateTrackId: '999999999999999999',
                originalTrackId: '194521912716636160',
                matchScore: 160,
                durationUnavailable: true,
            });
        });

        it('rejects alternate candidates that do not meet the strict match threshold', async () => {
            vi.spyOn(api, 'searchTracks').mockResolvedValueOnce({
                items: [
                    {
                        trackId: '777777777777777777',
                        tracksTrackId: '777777777777777777',
                        title: 'Marginalia #147',
                        artist: { name: 'Different Artist' },
                        duration: 180,
                    },
                ],
            });

            const stream = await api.resolveAlternateTrackStream('245266990510825472', 'LOSSLESS', {
                track: {
                    id: '245266990510825472',
                    title: 'Marginalia #147',
                    artist: { name: 'Masayoshi Fujita' },
                    duration: 180,
                },
            });

            expect(stream).toBeNull();
        });

        it('resolves external track via search lookup when matching candidate found', async () => {
            vi.spyOn(api, 'searchTracks').mockResolvedValueOnce({
                items: [
                    {
                        trackId: '157107766404747264',
                        tracksTrackId: '157107766404747264',
                        title: 'Get Lucky',
                        artistNames: ['Daft Punk'],
                        isrc: 'USQX91300108',
                        duration: 369,
                    },
                ],
            });

            const externalTrack = {
                id: 'apple:track:12345',
                provider: 'apple',
                title: 'Get Lucky',
                artist: { name: 'Daft Punk' },
                isrc: 'USQX91300108',
                duration: 369,
            };

            const stream = await api.resolveTrackStream(externalTrack);
            expect(stream).toBeDefined();
            expect(stream.url).toBe('https://tracks.monochrome.st/track/157107766404747264');
            expect(externalTrack.tracksTrackId).toBe('157107766404747264');
        });
    });
});
