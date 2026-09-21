import { expect, test } from 'vitest';
import { downloadAdminResponse } from './admin-ui.js';

test('serves a standalone download admin page without Monochrome frontend assets', async () => {
    const response = downloadAdminResponse();
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('Server downloads');
    expect(html).toContain('/api/downloads');
    expect(html).toContain('/api/downloads/reset');
    expect(html).not.toContain('<script src=');
    expect(html).not.toContain('<link rel="stylesheet"');
});
