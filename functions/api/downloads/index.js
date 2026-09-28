import { getDownloadsConfig } from '../../../server/downloads/config.js';
import { downloadQueue } from '../../../server/downloads/queue.js';
import { errorResponse, jsonResponse, methodNotAllowed, readJsonBody } from '../../../server/downloads/http.js';

export async function onRequest(context) {
    const { request, env } = context;
    const config = getDownloadsConfig(env);

    try {
        if (request.method === 'GET') {
            return jsonResponse(await downloadQueue.snapshot(config));
        }

        if (request.method === 'POST') {
            const body = await readJsonBody(request);
            const job = await downloadQueue.enqueue(body, config);
            return jsonResponse(
                {
                    success: true,
                    jobId: job.jobId,
                    job,
                },
                { status: 202 }
            );
        }

        return methodNotAllowed(['GET', 'POST']);
    } catch (error) {
        return errorResponse(error);
    }
}
