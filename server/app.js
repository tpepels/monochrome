import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequest as downloadsRequest } from '../functions/api/downloads/index.js';
import { onRequest as downloadJobRequest } from '../functions/api/downloads/[jobId].js';
import { onRequest as cancelDownloadRequest } from '../functions/api/downloads/[jobId]/cancel.js';
import { onRequest as retryDownloadRequest } from '../functions/api/downloads/[jobId]/retry.js';
import { onRequest as sweepDownloadsRequest } from '../functions/api/downloads/maintenance/sweep.js';
import { jsonResponse } from './downloads/http.js';
import { proxyDeezerStream } from './provider-proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || '4173', 10);
const STATIC_ROOT = path.resolve(process.env.MONOCHROME_STATIC_ROOT || path.join(__dirname, '..', 'dist'));

const MIME_TYPES = new Map([
    ['.html', 'text/html;charset=UTF-8'],
    ['.js', 'text/javascript;charset=UTF-8'],
    ['.mjs', 'text/javascript;charset=UTF-8'],
    ['.css', 'text/css;charset=UTF-8'],
    ['.json', 'application/json;charset=UTF-8'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'],
    ['.ico', 'image/x-icon'],
    ['.wasm', 'application/wasm'],
    ['.gz', 'application/gzip'],
    ['.br', 'application/octet-stream'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2'],
    ['.ttf', 'font/ttf'],
]);

function envFromProcess() {
    return process.env;
}

function headersFromIncoming(request) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) {
            for (const item of value) headers.append(key, item);
        } else if (value != null) {
            headers.set(key, String(value));
        }
    }
    return headers;
}

async function bodyFromIncoming(request) {
    if (request.method === 'GET' || request.method === 'HEAD') return undefined;

    const chunks = [];
    for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
    }
    return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function toFetchRequest(incoming) {
    const protocol = incoming.headers['x-forwarded-proto'] || 'http';
    const host = incoming.headers.host || `localhost:${PORT}`;
    return new Request(`${protocol}://${host}${incoming.url}`, {
        method: incoming.method,
        headers: headersFromIncoming(incoming),
        body: await bodyFromIncoming(incoming),
    });
}

async function writeFetchResponse(outgoing, response) {
    outgoing.statusCode = response.status;
    for (const [key, value] of response.headers.entries()) {
        outgoing.setHeader(key, value);
    }

    if (response.body) {
        outgoing.end(Buffer.from(await response.arrayBuffer()));
    } else {
        outgoing.end();
    }
}

function notFound() {
    return jsonResponse(
        {
            success: false,
            error: 'Not found',
            failureCode: 'NOT_FOUND',
        },
        { status: 404 }
    );
}

async function handleApi(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const context = {
        request,
        env: envFromProcess(),
        params: {},
    };

    if (url.pathname === '/api/health') {
        return jsonResponse({ success: true, service: 'monochrome', downloadsApi: true });
    }

    if (url.pathname === '/api/downloads') {
        return downloadsRequest(context);
    }

    if (url.pathname === '/api/downloads/maintenance/sweep') {
        return sweepDownloadsRequest(context);
    }

    if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'downloads') {
        context.params.jobId = decodeURIComponent(parts[2]);
        return downloadJobRequest(context);
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'downloads') {
        context.params.jobId = decodeURIComponent(parts[2]);
        if (parts[3] === 'cancel') return cancelDownloadRequest(context);
        if (parts[3] === 'retry') return retryDownloadRequest(context);
    }

    return notFound();
}

async function fileExists(filePath) {
    try {
        const stat = await fs.stat(filePath);
        return stat.isFile();
    } catch {
        return false;
    }
}

async function serveStatic(incoming, outgoing) {
    const url = new URL(incoming.url, `http://${incoming.headers.host || `localhost:${PORT}`}`);
    const decodedPath = decodeURIComponent(url.pathname);
    const requestedPath = path.resolve(STATIC_ROOT, `.${decodedPath}`);
    const staticRootWithSep = `${STATIC_ROOT}${path.sep}`;
    let filePath = requestedPath.startsWith(staticRootWithSep) || requestedPath === STATIC_ROOT ? requestedPath : null;

    if (!filePath || !(await fileExists(filePath))) {
        filePath = path.join(STATIC_ROOT, 'index.html');
    }

    if (!(await fileExists(filePath))) {
        outgoing.writeHead(404, { 'content-type': 'text/plain;charset=UTF-8' });
        outgoing.end('Not found');
        return;
    }

    const contentType = MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
    outgoing.writeHead(200, {
        'content-type': contentType,
        'cache-control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    createReadStream(filePath).pipe(outgoing);
}

const server = http.createServer(async (incoming, outgoing) => {
    try {
        if (incoming.url?.startsWith('/api/provider/deezer/stream')) {
            await proxyDeezerStream(incoming, outgoing);
            return;
        }

        if (incoming.url?.startsWith('/api/')) {
            await writeFetchResponse(outgoing, await handleApi(await toFetchRequest(incoming)));
            return;
        }

        await serveStatic(incoming, outgoing);
    } catch (error) {
        console.error('[server]', error);
        await writeFetchResponse(
            outgoing,
            jsonResponse(
                {
                    success: false,
                    error: error?.message || 'Internal server error',
                    failureCode: error?.failureCode || 'SERVER_ERROR',
                },
                { status: error?.status || 500 }
            )
        );
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Monochrome listening on http://0.0.0.0:${PORT}`);
    console.log(`Serving static assets from ${STATIC_ROOT}`);
});
