import { getDownloadsConfig } from '../../../../server/downloads/config.js';
import { downloadQueue } from '../../../../server/downloads/queue.js';
import { errorResponse, jsonResponse, methodNotAllowed } from '../../../../server/downloads/http.js';

export async function onRequest(context) {
    const { request, params, env } = context;
    const config = getDownloadsConfig(env);

    if (request.method !== 'POST') {
        return methodNotAllowed(['POST']);
    }

    try {
        const job = await downloadQueue.publishPartial(params.jobId, config);
        if (!job) {
            return jsonResponse(
                {
                    success: false,
                    error: 'Download job does not have a publishable partial album',
                    failureCode: 'PARTIAL_ALBUM_NOT_PUBLISHABLE',
                },
                { status: 409 }
            );
        }

        return jsonResponse({ success: true, jobId: job.jobId, job });
    } catch (error) {
        return errorResponse(error);
    }
}
