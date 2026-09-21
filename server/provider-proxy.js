import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getDeezerFallbackBaseUrl, withDeezerFallbackHeaders } from './provider-headers.js';

export const DEFAULT_TRACKS_API_BASE_URL = 'https://tracks.monochrome.st';

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

    const baseUrl = getDeezerFallbackBaseUrl(env);
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

    const headers = withDeezerFallbackHeaders(
        target,
        {
            accept: incoming.headers.accept || '*/*',
            'user-agent': incoming.headers['user-agent'] || 'Monochrome server proxy',
        },
        env
    );
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

    try {
        await pipeline(Readable.fromWeb(response.body), outgoing);
    } catch (error) {
        if (outgoing.destroyed || outgoing.writableEnded) return;
        if (outgoing.headersSent) {
            outgoing.destroy?.(error);
            return;
        }
        outgoing.writeHead(502, { 'content-type': 'application/json;charset=UTF-8' });
        outgoing.end(JSON.stringify({ success: false, error: 'Deezer proxy stream failed' }));
    }
}


export function buildTracksProxyTarget(requestUrl, env = {}) {
    const url = new URL(requestUrl, 'http://localhost');
    const prefix = '/api/provider/tracks';
    if (!url.pathname.startsWith(prefix)) {
        const error = new Error('Invalid Tracks proxy path');
        error.status = 400;
        throw error;
    }

    const baseUrl = String(env.TRACKS_API_BASE_URL || DEFAULT_TRACKS_API_BASE_URL).replace(/\/+$/, '');
    const relativePath = url.pathname.slice(prefix.length) || '/';
    const target = new URL(relativePath + url.search, `${baseUrl}/`);
    return target;
}

export async function proxyTracksRequest(incoming, outgoing, { env = process.env, fetchImpl = fetch } = {}) {
    if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
        outgoing.writeHead(405, { allow: 'GET, HEAD' });
        outgoing.end();
        return;
    }

    let target;
    try {
        target = buildTracksProxyTarget(incoming.url, env);
    } catch (error) {
        outgoing.writeHead(error.status || 500, { 'content-type': 'application/json;charset=UTF-8' });
        outgoing.end(JSON.stringify({ success: false, error: error.message || 'Invalid Tracks proxy request' }));
        return;
    }

    const headers = {
        accept: incoming.headers.accept || '*/*',
        'user-agent': incoming.headers['user-agent'] || 'Monochrome server proxy',
    };
    if (incoming.headers.range) headers.range = incoming.headers.range;

    let response;
    try {
        response = await fetchImpl(target, {
            method: incoming.method,
            headers,
            redirect: 'follow',
        });
    } catch (error) {
        outgoing.writeHead(502, { 'content-type': 'application/json;charset=UTF-8' });
        outgoing.end(JSON.stringify({ success: false, error: 'Tracks upstream request failed' }));
        return;
    }

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

    try {
        await pipeline(Readable.fromWeb(response.body), outgoing);
    } catch (error) {
        if (outgoing.destroyed || outgoing.writableEnded) return;
        if (outgoing.headersSent) {
            outgoing.destroy?.(error);
            return;
        }
        outgoing.writeHead(502, { 'content-type': 'application/json;charset=UTF-8' });
        outgoing.end(JSON.stringify({ success: false, error: 'Tracks proxy stream failed' }));
    }
}
