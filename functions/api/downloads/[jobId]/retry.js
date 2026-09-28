import { getDownloadsConfig } from '../../../../server/downloads/config.js';
import { downloadQueue } from '../../../../server/downloads/queue.js';
import { jsonResponse, methodNotAllowed } from '../../../../server/downloads/http.js';

export async function onRequest(context) {
    const { request, params, env } = context;
    const config = getDownloadsConfig(env);

    if (request.method !== 'POST') {
        return methodNotAllowed(['POST']);
    }

    const job = await downloadQueue.retry(params.jobId, config);
    if (!job) {
        return jsonResponse(
            {
                success: false,
                error: 'Download job is not retryable',
                failureCode: 'DOWNLOAD_JOB_NOT_RETRYABLE',
            },
            { status: 409 }
        );
    }

    return jsonResponse(
        {
            success: true,
            jobId: job.jobId,
            job,
        },
        { status: 202 }
    );
}
