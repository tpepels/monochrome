import { getDownloadsConfig } from '../../../../server/downloads/config.js';
import { downloadQueue } from '../../../../server/downloads/queue.js';
import { errorResponse, jsonResponse, methodNotAllowed, readJsonBody } from '../../../../server/downloads/http.js';

export async function onRequest(context) {
    const { request, env } = context;
    const config = getDownloadsConfig(env);

    try {
        if (request.method !== 'POST') {
            return methodNotAllowed(['POST']);
        }

        const body = await readJsonBody(request).catch(() => ({}));
        const result = await downloadQueue.sweep(config, {
            dryRun: body.dryRun !== false,
        });

        return jsonResponse(result);
    } catch (error) {
        return errorResponse(error);
    }
}
