import { describe, expect, test, vi } from 'vitest';
import { proxyHiFiRequest } from './hifi-proxy.js';

describe('HiFi proxy', () => {
    test('proxies an allowlisted instance and marks the response', async () => {
        const fetchImpl = vi.fn(async () =>
            Response.json({ data: { items: [] } }, { headers: { 'cache-control': 'max-age=60' } })
        );
        const target = 'https://lol.samidy.workers.dev/search/?v=Bob%20Dylan';
        const request = new Request(`http://localhost/api/hifi-proxy?url=${encodeURIComponent(target)}`);

        const response = await proxyHiFiRequest(request, { fetchImpl });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls[0][0].href).toBe(target);
        expect(response.status).toBe(200);
        expect(response.headers.get('x-monochrome-hifi-proxy')).toBe('1');
        expect(await response.json()).toEqual({ data: { items: [] } });
    });

    test('rejects arbitrary targets to avoid exposing an open proxy', async () => {
        const fetchImpl = vi.fn();
        const target = 'https://example.com/private';
        const request = new Request(`http://localhost/api/hifi-proxy?url=${encodeURIComponent(target)}`);

        const response = await proxyHiFiRequest(request, { fetchImpl });

        expect(response.status).toBe(403);
        expect(response.headers.get('x-monochrome-hifi-proxy')).toBe('1');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('does not follow an allowlisted response to an arbitrary host', async () => {
        const fetchImpl = vi.fn(
            async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })
        );
        const target = 'https://lol.samidy.workers.dev/search/?v=Bob%20Dylan';
        const request = new Request(`http://localhost/api/hifi-proxy?url=${encodeURIComponent(target)}`);

        const response = await proxyHiFiRequest(request, { fetchImpl });

        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: 'Redirect target host is not allowed' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    test('allows additional hostnames configured by the self-host', async () => {
        const fetchImpl = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
        const target = 'https://hifi.internal.example/info/?id=1';
        const request = new Request(`http://localhost/api/hifi-proxy?url=${encodeURIComponent(target)}`);

        const response = await proxyHiFiRequest(request, {
            env: { HIFI_PROXY_ALLOWED_HOSTS: 'hifi.internal.example' },
            fetchImpl,
        });

        expect(response.status).toBe(200);
        expect(fetchImpl.mock.calls[0][0].href).toBe(target);
    });
});
