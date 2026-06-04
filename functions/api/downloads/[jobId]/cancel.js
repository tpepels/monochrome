import { downloadQueue } from '../../../../server/downloads/queue.js';
import { getDownloadsConfig } from '../../../../server/downloads/config.js';
import { jsonResponse, methodNotAllowed } from '../../../../server/downloads/http.js';

export async function onRequest(context) {
    const { request, params, env } = context;
    const config = getDownloadsConfig(env);

    if (request.method !== 'POST') {
        return methodNotAllowed(['POST']);
    }

    const job = await downloadQueue.cancel(params.jobId, config);
    if (!job) {
        return jsonResponse(
            {
                success: false,
                error: 'Download job not found',
                failureCode: 'DOWNLOAD_JOB_NOT_FOUND',
            },
            { status: 404 }
        );
    }

    return jsonResponse({
        success: true,
        job,
    });
}
