import { Readable } from 'node:stream';

const DEEZER_ALLOWED_ORIGIN = 'https://monochrome.tf';
const DEFAULT_DEEZER_BASE_URL = 'https://dzr.tabs-vs-spaces.wtf';

function isEnabled(value) {
    return !['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

function copyHeader(source, target, name) {
    const value = source.headers.get(name);
    if (value) target.setHeader(name, value);
}

export function buildDeezerProxyTarget(requestUrl, env = {}) {
    const url = new URL(requestUrl, 'http://localhost');
    const isrc = String(url.searchParams.get('isrc') || '').trim();
    const format = String(url.searchParams.get('format') || 'FLAC').trim();
    if (!isrc) {
        const error = new Error('Missing ISRC');
        error.status = 400;
        throw error;
    }

    const baseUrl = String(env.DEEZER_FALLBACK_API_BASE_URL || DEFAULT_DEEZER_BASE_URL).replace(/\/+$/, '');
    const target = new URL('/stream/', `${baseUrl}/`);
    target.searchParams.set('isrc', isrc);
    target.searchParams.set('format', format || 'FLAC');
    return target;
}

export async function proxyDeezerStream(incoming, outgoing, { env = process.env, fetchImpl = fetch } = {}) {
    if (!isEnabled(env.DEEZER_FALLBACK_ENABLED ?? 'true')) {
        outgoing.writeHead(404, { 'content-type': 'application/json;charset=UTF-8' });
        outgoing.end(JSON.stringify({ success: false, error: 'Deezer fallback is disabled' }));
        return;
    }

    if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
        outgoing.writeHead(405, { allow: 'GET, HEAD' });
        outgoing.end();
        return;
    }

    let target;
    try {
        target = buildDeezerProxyTarget(incoming.url, env);
    } catch (error) {
        outgoing.writeHead(error.status || 500, { 'content-type': 'application/json;charset=UTF-8' });
        outgoing.end(JSON.stringify({ success: false, error: error.message || 'Invalid Deezer proxy request' }));
        return;
    }

    const headers = {
        accept: incoming.headers.accept || '*/*',
        origin: DEEZER_ALLOWED_ORIGIN,
        referer: `${DEEZER_ALLOWED_ORIGIN}/`,
        'user-agent': incoming.headers['user-agent'] || 'Monochrome server proxy',
    };
    if (incoming.headers.range) headers.range = incoming.headers.range;

    const response = await fetchImpl(target, {
        method: incoming.method,
        headers,
        redirect: 'follow',
    });

    outgoing.statusCode = response.status;
    for (const header of [
        'accept-ranges',
        'cache-control',
        'content-length',
        'content-range',
        'content-type',
        'etag',
        'last-modified',
    ]) {
        copyHeader(response, outgoing, header);
    }

    if (incoming.method === 'HEAD' || !response.body) {
        outgoing.end();
        return;
    }

    Readable.fromWeb(response.body).pipe(outgoing);
}
