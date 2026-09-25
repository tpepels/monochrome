import http from 'node:http';
import { onRequest as downloadsRequest } from '../functions/api/downloads/index.js';
import { onRequest as downloadJobRequest } from '../functions/api/downloads/[jobId].js';
import { onRequest as cancelDownloadRequest } from '../functions/api/downloads/[jobId]/cancel.js';
import { onRequest as retryDownloadRequest } from '../functions/api/downloads/[jobId]/retry.js';
import { onRequest as resetDownloadsRequest } from '../functions/api/downloads/reset.js';
import { onRequest as sweepDownloadsRequest } from '../functions/api/downloads/maintenance/sweep.js';
import { downloadAdminResponse } from './downloads/admin-ui.js';
import { getDownloadsConfig } from './downloads/config.js';
import { jsonResponse } from './downloads/http.js';
import { downloadQueue } from './downloads/queue.js';

const PORT = Number.parseInt(process.env.PORT || '4174', 10);

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
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
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
    for (const [key, value] of response.headers.entries()) outgoing.setHeader(key, value);
    if (response.body) outgoing.end(Buffer.from(await response.arrayBuffer()));
    else outgoing.end();
}

function notFound() {
    return jsonResponse(
        { success: false, error: 'Not found', failureCode: 'NOT_FOUND' },
        { status: 404 }
    );
}

async function handleApi(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const context = { request, env: process.env, params: {} };

    if (url.pathname === '/api/health') {
        return jsonResponse({ success: true, service: 'monochrome-selfhost', downloadsApi: true });
    }

    if (url.pathname === '/api/downloads') return downloadsRequest(context);
    if (url.pathname === '/api/downloads/reset') return resetDownloadsRequest(context);
    if (url.pathname === '/api/downloads/maintenance/sweep') return sweepDownloadsRequest(context);

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

const server = http.createServer(async (incoming, outgoing) => {
    try {
        const pathname = new URL(incoming.url || '/', `http://localhost:${PORT}`).pathname;

        if (pathname === '/downloads-admin' || pathname === '/downloads-admin/') {
            if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
                await writeFetchResponse(outgoing, notFound());
                return;
            }
            await writeFetchResponse(outgoing, downloadAdminResponse());
            return;
        }

        if (incoming.url?.startsWith('/api/')) {
            await writeFetchResponse(outgoing, await handleApi(await toFetchRequest(incoming)));
            return;
        }

        await writeFetchResponse(outgoing, notFound());
    } catch (error) {
        console.error('[server]', error);
        await writeFetchResponse(
            outgoing,
            jsonResponse(
                { success: false, error: error?.message || 'Internal server error', failureCode: error?.failureCode || 'SERVER_ERROR' },
                { status: error?.status || 500 }
            )
        );
    }
});

try {
    const recovered = await downloadQueue.recover(getDownloadsConfig(process.env));
    const resumed = (recovered?.counts?.queued || 0) + (recovered?.counts?.processing || 0);
    if (resumed > 0) {
        console.log(`[downloads] Recovered ${resumed} unfinished job(s) from persistent queue state`);
    }
} catch (error) {
    console.error('[downloads] Queue recovery failed; starting with the available in-memory state:', error);
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Monochrome self-host backend listening on http://0.0.0.0:${PORT}`);
});
