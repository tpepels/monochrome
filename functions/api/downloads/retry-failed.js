import { getDownloadsConfig } from '../../../server/downloads/config.js';
import { downloadQueue } from '../../../server/downloads/queue.js';
import { errorResponse, jsonResponse, methodNotAllowed } from '../../../server/downloads/http.js';

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'POST') {
        return methodNotAllowed(['POST']);
    }

    try {
        const config = getDownloadsConfig(env);
        return jsonResponse(await downloadQueue.retryAllFailed(config), { status: 202 });
    } catch (error) {
        return errorResponse(error);
    }
}
