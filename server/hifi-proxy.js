const DEFAULT_ALLOWED_HOSTS = ['lol.samidy.workers.dev', 'monochrome-api.samidy.com'];

const PROXY_HEADER = 'x-monochrome-hifi-proxy';

function allowedHosts(env = {}) {
    const configured = String(env.HIFI_PROXY_ALLOWED_HOSTS || '')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean);
    return new Set([...DEFAULT_ALLOWED_HOSTS, ...configured]);
}

function proxyResponse(body, init = {}) {
    const headers = new Headers(init.headers);
    headers.set(PROXY_HEADER, '1');
    return new Response(body, { ...init, headers });
}

function errorResponse(message, status) {
    return proxyResponse(JSON.stringify({ success: false, error: message }), {
        status,
        headers: {
            'content-type': 'application/json;charset=UTF-8',
            'cache-control': 'no-store',
        },
    });
}

export async function proxyHiFiRequest(request, { env = {}, fetchImpl = fetch } = {}) {
    if (!['GET', 'HEAD'].includes(request.method)) {
        return errorResponse('Method not allowed', 405);
    }

    const incomingUrl = new URL(request.url);
    const rawTarget = incomingUrl.searchParams.get('url');
    if (!rawTarget) return errorResponse('Missing url parameter', 400);

    let target;
    try {
        target = new URL(rawTarget);
    } catch {
        return errorResponse('Invalid target URL', 400);
    }

    const hosts = allowedHosts(env);
    const isAllowedTarget = (url) => url.protocol === 'https:' && hosts.has(url.hostname.toLowerCase());
    if (!isAllowedTarget(target)) {
        return errorResponse('Target host is not allowed', 403);
    }

    let upstream;
    try {
        for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
            upstream = await fetchImpl(target, {
                method: request.method,
                headers: {
                    accept: request.headers.get('accept') || 'application/json',
                    'user-agent': request.headers.get('user-agent') || 'Monochrome HiFi proxy',
                },
                redirect: 'manual',
            });

            if (upstream.status < 300 || upstream.status >= 400) break;

            const location = upstream.headers.get('location');
            if (!location) break;
            if (redirectCount === 3) return errorResponse('Too many upstream redirects', 502);

            target = new URL(location, target);
            if (!isAllowedTarget(target)) return errorResponse('Redirect target host is not allowed', 403);
        }
    } catch (error) {
        return errorResponse(error?.message || 'Upstream request failed', 502);
    }

    const headers = new Headers();
    for (const name of ['content-type', 'cache-control', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
    }
    headers.set('cache-control', headers.get('cache-control') || 'no-store');

    return proxyResponse(request.method === 'HEAD' ? null : upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
    });
}
