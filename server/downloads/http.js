export function jsonResponse(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set('content-type', 'application/json;charset=UTF-8');
    headers.set('cache-control', 'no-store');

    return new Response(JSON.stringify(body), {
        ...init,
        headers,
    });
}

export function methodNotAllowed(allowed) {
    return jsonResponse(
        {
            success: false,
            error: 'Method not allowed',
            failureCode: 'METHOD_NOT_ALLOWED',
        },
        {
            status: 405,
            headers: {
                allow: allowed.join(', '),
            },
        }
    );
}

export async function readJsonBody(request) {
    const contentType = request.headers.get('content-type') || '';
    if (contentType && !contentType.toLowerCase().includes('application/json')) {
        const error = new Error('Expected application/json request body');
        error.status = 415;
        error.failureCode = 'UNSUPPORTED_MEDIA_TYPE';
        throw error;
    }

    try {
        return await request.json();
    } catch {
        const error = new Error('Invalid JSON request body');
        error.status = 400;
        error.failureCode = 'INVALID_JSON';
        throw error;
    }
}

export function errorResponse(error) {
    return jsonResponse(
        {
            success: false,
            error: error?.message || 'Download request failed',
            failureCode: error?.failureCode || 'DOWNLOAD_REQUEST_FAILED',
        },
        {
            status: error?.status || 500,
        }
    );
}

