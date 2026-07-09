import { describe, expect, test, vi } from 'vitest';
import { buildDeezerProxyTarget, proxyDeezerStream } from './provider-proxy.js';

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
});
