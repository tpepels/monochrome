import { describe, expect, it, vi, afterEach } from 'vitest';
import { createSelfHostDownloadBridge } from './downloads.js';

function makeUi() {
    const taskEl = document.createElement('div');
    taskEl.innerHTML = '<button class="download-cancel"></button>';

    const bulkEl = document.createElement('div');
    bulkEl.innerHTML =
        '<button class="download-cancel"></button>' +
        '<div class="download-progress-fill"></div>' +
        '<div class="download-status"></div>';

    return {
        showNotification: vi.fn(),
        addDownloadTask: vi.fn(() => ({ taskEl })),
        updateDownloadProgress: vi.fn(),
        completeDownloadTask: vi.fn(),
        createBulkDownloadNotification: vi.fn(() => bulkEl),
        completeBulkDownload: vi.fn(),
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.getElementById('sidebar-nav-downloads-admin')?.remove();
});

describe('self-host download bridge', () => {
    it('marks an unsupported server API as unavailable so upstream can fall back to browser download', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));

        const bridge = createSelfHostDownloadBridge(makeUi());

        await expect(
            bridge.tryQueueTrack({ id: '123', title: 'Track' }, 'LOSSLESS', {})
        ).resolves.toBe(false);
    });

    it('queues a server track using the bridge and reports completion through upstream UI callbacks', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        success: true,
                        jobId: 'job-1',
                        job: { jobId: 'job-1', status: 'queued' },
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                )
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        success: true,
                        job: {
                            jobId: 'job-1',
                            status: 'completed',
                            progress: { percent: 100 },
                        },
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                )
            );
        vi.stubGlobal('fetch', fetchMock);

        const ui = makeUi();
        const bridge = createSelfHostDownloadBridge(ui);
        const track = { id: '123', title: 'Track' };

        await expect(bridge.tryQueueTrack(track, 'LOSSLESS', { name: 'api' })).resolves.toBe(true);

        await vi.waitFor(() => {
            expect(ui.completeDownloadTask).toHaveBeenCalledWith(
                '123',
                true,
                'Server download complete'
            );
        });

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            '/api/downloads',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    type: 'track',
                    id: '123',
                    quality: 'LOSSLESS',
                    track,
                }),
            })
        );
    });
});
