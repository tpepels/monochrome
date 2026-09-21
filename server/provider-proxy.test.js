import { Writable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { buildDeezerProxyTarget, buildTracksProxyTarget, proxyDeezerStream, proxyTracksRequest } from './provider-proxy.js';

function createOutgoing() {
    return {
        statusCode: 0,
        headers: new Map(),
        ended: false,
        setHeader(name, value) {
            this.headers.set(name.toLowerCase(), value);
        },
        writeHead(status, headers = {}) {
            this.statusCode = status;
            for (const [name, value] of Object.entries(headers)) {
                this.setHeader(name, value);
            }
        },
        end() {
            this.ended = true;
        },
    };
}

function createWritableOutgoing() {
    const chunks = [];
    const outgoing = new Writable({
        write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
        },
    });
    outgoing.statusCode = 0;
    outgoing.headers = new Map();
    outgoing.setHeader = function setHeader(name, value) {
        this.headers.set(name.toLowerCase(), value);
    };
    outgoing.writeHead = function writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(headers)) {
            this.setHeader(name, value);
        }
    };
    outgoing.bodyText = function bodyText() {
        return Buffer.concat(chunks).toString('utf8');
    };
    return outgoing;
}

describe('provider proxy', () => {
    test('builds Deezer stream target from server-owned base URL', () => {
        const target = buildDeezerProxyTarget('/api/provider/deezer/stream?isrc=USWB12600223&format=FLAC', {
            DEEZER_FALLBACK_API_BASE_URL: 'https://dzr.example',
        });

        expect(target.href).toBe('https://dzr.example/stream/?isrc=USWB12600223&format=FLAC');
    });

    test('proxies Deezer HEAD requests with allowed origin and range headers', async () => {
        let received;
        const fetchImpl = vi.fn((url, options) => {
            received = { url, options };
            return Promise.resolve(
                new Response(null, {
                    status: 206,
                    headers: {
                        'accept-ranges': 'bytes',
                        'content-length': '123',
                        'content-range': 'bytes 0-122/123',
                        'content-type': 'audio/mpeg',
                    },
                })
            );
        });
        const outgoing = createOutgoing();

        await proxyDeezerStream(
            {
                method: 'HEAD',
                url: '/api/provider/deezer/stream?isrc=USWB12600223&format=MP3_320',
                headers: {
                    accept: 'audio/*',
                    range: 'bytes=0-122',
                    'user-agent': 'test-agent',
                },
            },
            outgoing,
            {
                env: {
                    DEEZER_FALLBACK_ENABLED: 'true',
                    DEEZER_FALLBACK_API_BASE_URL: 'https://dzr.example',
                },
                fetchImpl,
            }
        );

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(received.url.href).toBe('https://dzr.example/stream/?isrc=USWB12600223&format=MP3_320');
        expect(received.options.headers.origin).toBe('https://monochrome.tf');
        expect(received.options.headers.referer).toBe('https://monochrome.tf/');
        expect(received.options.headers.range).toBe('bytes=0-122');
        expect(outgoing.statusCode).toBe(206);
        expect(outgoing.headers.get('content-type')).toBe('audio/mpeg');
        expect(outgoing.ended).toBe(true);
    });

    test('uses configured allowed origin for the configured Deezer host', async () => {
        let received;
        const fetchImpl = vi.fn((url, options) => {
            received = { url, options };
            return Promise.resolve(new Response(null, { status: 200 }));
        });
        const outgoing = createOutgoing();

        await proxyDeezerStream(
            {
                method: 'HEAD',
                url: '/api/provider/deezer/stream?isrc=USWB12600223&format=FLAC',
                headers: {},
            },
            outgoing,
            {
                env: {
                    DEEZER_FALLBACK_API_BASE_URL: 'https://dzr.example',
                    DEEZER_FALLBACK_ALLOWED_ORIGIN: 'https://allowed.example',
                },
                fetchImpl,
            }
        );

        expect(received.url.href).toBe('https://dzr.example/stream/?isrc=USWB12600223&format=FLAC');
        expect(received.options.headers.origin).toBe('https://allowed.example');
        expect(received.options.headers.referer).toBe('https://allowed.example/');
    });

    test('handles upstream stream errors without throwing', async () => {
        const body = new ReadableStream({
            start(controller) {
                controller.error(new Error('upstream stream failed'));
            },
        });
        const outgoing = createWritableOutgoing();

        await expect(
            proxyDeezerStream(
                {
                    method: 'GET',
                    url: '/api/provider/deezer/stream?isrc=USWB12600223&format=FLAC',
                    headers: {},
                },
                outgoing,
                {
                    env: {
                        DEEZER_FALLBACK_API_BASE_URL: 'https://dzr.example',
                    },
                    fetchImpl: async () =>
                        new Response(body, {
                            status: 200,
                            headers: {
                                'content-type': 'audio/flac',
                            },
                        }),
                }
            )
        ).resolves.toBeUndefined();
    });

    test('builds Tracks target from the local proxy path', () => {
        const target = buildTracksProxyTarget(
            '/api/provider/tracks/search/tracks?q=Dexter%20Wansel%20All%20Night%20Long&limit=6',
            { TRACKS_API_BASE_URL: 'https://tracks.example' }
        );

        expect(target.href).toBe(
            'https://tracks.example/search/tracks?q=Dexter%20Wansel%20All%20Night%20Long&limit=6'
        );
    });

    test('proxies Tracks JSON requests without browser CORS involvement', async () => {
        let received;
        const fetchImpl = vi.fn((url, options) => {
            received = { url, options };
            return Promise.resolve(
                new Response(JSON.stringify({ tracks: [] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })
            );
        });
        const outgoing = createWritableOutgoing();

        await proxyTracksRequest(
            {
                method: 'GET',
                url: '/api/provider/tracks/search/tracks?q=test&limit=6',
                headers: { accept: 'application/json', 'user-agent': 'test-agent' },
            },
            outgoing,
            {
                env: { TRACKS_API_BASE_URL: 'https://tracks.example' },
                fetchImpl,
            }
        );

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(received.url.href).toBe('https://tracks.example/search/tracks?q=test&limit=6');
        expect(received.options.method).toBe('GET');
        expect(outgoing.statusCode).toBe(200);
        expect(outgoing.headers.get('content-type')).toContain('application/json');
        expect(outgoing.bodyText()).toBe(JSON.stringify({ tracks: [] }));
    });

    test('forwards range requests through the Tracks proxy', async () => {
        let received;
        const fetchImpl = vi.fn((url, options) => {
            received = { url, options };
            return Promise.resolve(
                new Response(null, {
                    status: 206,
                    headers: {
                        'accept-ranges': 'bytes',
                        'content-range': 'bytes 0-99/1000',
                        'content-type': 'audio/flac',
                    },
                })
            );
        });
        const outgoing = createOutgoing();

        await proxyTracksRequest(
            {
                method: 'HEAD',
                url: '/api/provider/tracks/track/123456789',
                headers: { range: 'bytes=0-99' },
            },
            outgoing,
            {
                env: { TRACKS_API_BASE_URL: 'https://tracks.example' },
                fetchImpl,
            }
        );

        expect(received.url.href).toBe('https://tracks.example/track/123456789');
        expect(received.options.headers.range).toBe('bytes=0-99');
        expect(outgoing.statusCode).toBe(206);
        expect(outgoing.headers.get('content-type')).toBe('audio/flac');
        expect(outgoing.headers.get('content-range')).toBe('bytes 0-99/1000');
    });

});
