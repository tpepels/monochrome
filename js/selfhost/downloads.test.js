import { describe, expect, it, vi, afterEach } from 'vitest';
import { createSelfHostDownloadBridge } from './downloads.js';

function makeUi() {
    const ui = {
        showNotification: vi.fn(),
        updateDownloadProgress: vi.fn(),
        completeDownloadTask: vi.fn(),
        dismissDownloadTask: vi.fn(),
        completeBulkDownload: vi.fn(),
        dismissBulkDownloadNotification: vi.fn(),
    };

    ui.addDownloadTask = vi.fn((trackId, _track, _filename, _api, abortController, options = {}) => {
        const taskEl = document.createElement('div');
        taskEl.innerHTML = '<button class="download-cancel"></button>';
        const button = taskEl.querySelector('.download-cancel');
        if (options.dismissOnly) {
            button.addEventListener('click', () => ui.dismissDownloadTask(trackId));
        } else {
            button.addEventListener('click', () => abortController.abort());
        }
        return { taskEl, abortController };
    });

    ui.createBulkDownloadNotification = vi.fn((_type, _name, _total, options = {}) => {
        const bulkEl = document.createElement('div');
        bulkEl.innerHTML =
            '<button class="download-cancel"></button>' +
            '<div class="download-progress-fill"></div>' +
            '<div class="download-status"></div>';
        const button = bulkEl.querySelector('.download-cancel');
        if (options.dismissOnly) {
            button.addEventListener('click', () => ui.dismissBulkDownloadNotification(bulkEl));
        }
        return bulkEl;
    });

    return ui;
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.getElementById('sidebar-nav-downloads-admin')?.remove();
    document.getElementById('sidebar-nav-ytdlp')?.remove();
    document.querySelector('.sidebar-nav.main')?.remove();
});

describe('self-host download bridge', () => {
    it('adds self-host Downloads and yt-dlp links to the Monochrome left sidebar', async () => {
        document.body.insertAdjacentHTML(
            'beforeend',
            '<nav class="sidebar-nav main"><ul><li id="sidebar-nav-settings"></li></ul></nav>'
        );

        createSelfHostDownloadBridge(makeUi());
        await new Promise((resolve) => queueMicrotask(resolve));

        const downloads = document.querySelector('#sidebar-nav-downloads-admin a');
        const ytdlp = document.querySelector('#sidebar-nav-ytdlp a');

        expect(downloads?.getAttribute('href')).toBe('/downloads-admin');
        expect(ytdlp?.getAttribute('href')).toBe('http://192.168.1.200:4545/');
        expect(ytdlp?.textContent).toContain('yt-dlp');

        const settings = document.getElementById('sidebar-nav-settings');
        expect(settings?.previousElementSibling?.id).toBe('sidebar-nav-ytdlp');
    });

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
        const bridge = createSelfHostDownloadBridge(ui);
        const track = { id: 'dismiss-track', title: 'Track' };
        await expect(bridge.tryQueueTrack(track, 'LOSSLESS', {})).resolves.toBe(true);

        expect(ui.addDownloadTask).toHaveBeenCalledWith(
            'dismiss-track',
            track,
            null,
            {},
            expect.any(AbortController),
            { dismissOnly: true }
        );
        const taskEl = ui.addDownloadTask.mock.results[0].value.taskEl;
        taskEl.querySelector('.download-cancel').click();

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
        await vi.waitFor(() => {
            expect(ui.completeDownloadTask).toHaveBeenCalledWith(
                'dismiss-track',
                true,
                'Server download complete'
            );
        });
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
        const bridge = createSelfHostDownloadBridge(ui);
        await expect(
            bridge.tryQueueAlbum(
                { id: 'album-dismiss', title: 'Album' },
                [{ id: 'track-1', title: 'One' }],
                'LOSSLESS'
            )
        ).resolves.toBe(true);

        expect(ui.createBulkDownloadNotification).toHaveBeenCalledWith(
            'album',
            'Album',
            1,
            { dismissOnly: true }
        );
        const bulkEl = ui.createBulkDownloadNotification.mock.results[0].value;
        bulkEl.querySelector('.download-cancel').click();

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
        await vi.waitFor(() => {
            expect(ui.completeBulkDownload).toHaveBeenCalledWith(bulkEl, true);
        });
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
