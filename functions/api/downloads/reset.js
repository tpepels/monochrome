import { getDownloadsConfig } from '../../../server/downloads/config.js';
import { errorResponse, jsonResponse, methodNotAllowed } from '../../../server/downloads/http.js';
import { downloadQueue } from '../../../server/downloads/queue.js';

function parseBooleanParam(value) {
    if (value == null) return false;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'POST') {
        return methodNotAllowed(['POST']);
    }

    try {
        const config = getDownloadsConfig(env);
        const url = new URL(request.url);
        const cleanup = parseBooleanParam(url.searchParams.get('cleanup'));
        return jsonResponse(await downloadQueue.clear(config, { cleanup }));
    } catch (error) {
        return errorResponse(error);
    }
}
