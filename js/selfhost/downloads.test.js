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
        dismissDownloadTask: vi.fn(() => taskEl.remove()),
        createBulkDownloadNotification: vi.fn(() => bulkEl),
        completeBulkDownload: vi.fn(),
        dismissBulkDownloadNotification: vi.fn(() => bulkEl.remove()),
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

    it('dismisses a server track toast without aborting or cancelling the server job', async () => {
        let resolveStatus;
        const statusPromise = new Promise((resolve) => {
            resolveStatus = resolve;
        });
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        success: true,
                        jobId: 'job-dismiss-track',
                        job: { jobId: 'job-dismiss-track', status: 'queued' },
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                )
            )
            .mockImplementationOnce(() => statusPromise);
        vi.stubGlobal('fetch', fetchMock);

        const ui = makeUi();
        const originalButton = ui.addDownloadTask().taskEl.querySelector('.download-cancel');
        const inheritedCancel = vi.fn();
        originalButton.addEventListener('click', inheritedCancel);

        const taskEl = ui.addDownloadTask.mock.results[0].value.taskEl;
        ui.addDownloadTask.mockClear();
        ui.addDownloadTask.mockImplementation(() => ({ taskEl }));

        const bridge = createSelfHostDownloadBridge(ui);
        const track = { id: 'dismiss-track', title: 'Track' };
        await expect(bridge.tryQueueTrack(track, 'LOSSLESS', {})).resolves.toBe(true);

        taskEl.querySelector('.download-cancel').click();

        expect(inheritedCancel).not.toHaveBeenCalled();
        expect(ui.dismissDownloadTask).toHaveBeenCalledWith('dismiss-track');
        expect(
            fetchMock.mock.calls.some(([url]) => String(url).includes('/cancel'))
        ).toBe(false);

        resolveStatus(
            new Response(
                JSON.stringify({
                    success: true,
                    job: {
                        jobId: 'job-dismiss-track',
                        status: 'completed',
                        progress: { percent: 100 },
                    },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        );
    });

    it('dismisses a server album toast without cancelling the server job', async () => {
        let resolveStatus;
        const statusPromise = new Promise((resolve) => {
            resolveStatus = resolve;
        });
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        success: true,
                        jobId: 'job-dismiss-album',
                        job: {
                            jobId: 'job-dismiss-album',
                            status: 'queued',
                            progress: { percent: 0, totalTracks: 1, completedTracks: 0 },
                        },
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                )
            )
            .mockImplementationOnce(() => statusPromise);
        vi.stubGlobal('fetch', fetchMock);

        const ui = makeUi();
        const bulkEl = ui.createBulkDownloadNotification();
        const originalButton = bulkEl.querySelector('.download-cancel');
        const inheritedCancel = vi.fn();
        originalButton.addEventListener('click', inheritedCancel);
        ui.createBulkDownloadNotification.mockClear();
        ui.createBulkDownloadNotification.mockImplementation(() => bulkEl);

        const bridge = createSelfHostDownloadBridge(ui);
        await expect(
            bridge.tryQueueAlbum(
                { id: 'album-dismiss', title: 'Album' },
                [{ id: 'track-1', title: 'One' }],
                'LOSSLESS'
            )
        ).resolves.toBe(true);

        bulkEl.querySelector('.download-cancel').click();

        expect(inheritedCancel).not.toHaveBeenCalled();
        expect(ui.dismissBulkDownloadNotification).toHaveBeenCalledWith(bulkEl);
        expect(
            fetchMock.mock.calls.some(([url]) => String(url).includes('/cancel'))
        ).toBe(false);

        resolveStatus(
            new Response(
                JSON.stringify({
                    success: true,
                    job: {
                        jobId: 'job-dismiss-album',
                        status: 'completed',
                        progress: { percent: 100, totalTracks: 1, completedTracks: 1 },
                    },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        );
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
