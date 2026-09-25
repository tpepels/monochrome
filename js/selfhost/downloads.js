// js/selfhost/downloads.js
//
// Self-host-only browser integration for the server-side download service.
//
// IMPORTANT:
// This module intentionally owns all fork-specific download behavior so that
// upstream js/downloads.js needs only a tiny adapter and two decision hooks.
// When upstream changes its download UI, adapt the bridge at the boundary
// instead of moving this implementation back into the upstream file.

const SERVER_DOWNLOAD_API = '/api/downloads';
const SERVER_DOWNLOAD_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const SERVER_DOWNLOAD_UNSUPPORTED_STATUSES = new Set([404, 405, 501]);
const SERVER_DOWNLOAD_POLL_INTERVAL_MS = 1500;

const serverOngoingDownloads = new Set();

function isOfficialMonochromeHost() {
    const hostname = typeof window !== 'undefined' ? window.location?.hostname || '' : '';
    return (
        hostname === 'monochrome.st' ||
        hostname.endsWith('.monochrome.st') ||
        hostname === 'monochrome.tf' ||
        hostname.endsWith('.monochrome.tf')
    );
}

function shouldUseServerDownloads() {
    return !isOfficialMonochromeHost();
}

/**
 * SELF-HOST INVARIANT:
 * Keep the admin entry as one small self-host-only sidebar item. The admin
 * dashboard itself stays outside the upstream frontend at /downloads-admin.
 */
function ensureServerDownloadsSidebarLink() {
    if (
        typeof document === 'undefined' ||
        !shouldUseServerDownloads() ||
        document.getElementById('sidebar-nav-downloads-admin')
    ) {
        return;
    }

    const navList = document.querySelector('.sidebar-nav.main > ul');
    if (!navList) return;

    const item = document.createElement('li');
    item.className = 'nav-item';
    item.id = 'sidebar-nav-downloads-admin';
    item.innerHTML = `
        <a href="/downloads-admin" target="_blank" rel="noopener noreferrer" title="Server Downloads">
            <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
            >
                <path d="M12 3v12"></path>
                <path d="m7 10 5 5 5-5"></path>
                <path d="M5 21h14"></path>
            </svg>
            <span>Downloads</span>
        </a>
    `;

    const settingsItem = document.getElementById('sidebar-nav-settings');
    navList.insertBefore(item, settingsItem || null);
}

function scheduleSidebarLink() {
    if (typeof document === 'undefined') return;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureServerDownloadsSidebarLink, { once: true });
    } else {
        queueMicrotask(ensureServerDownloadsSidebarLink);
    }
}

function createServerDownloadsUnavailableError(message = 'Server-side downloads are unavailable') {
    const error = new Error(message);
    error.serverDownloadsUnavailable = true;
    return error;
}

async function queueServerDownload(payload, { signal } = {}) {
    let response;
    try {
        response = await fetch(SERVER_DOWNLOAD_API, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal,
        });
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw createServerDownloadsUnavailableError(error?.message);
    }

    if (SERVER_DOWNLOAD_UNSUPPORTED_STATUSES.has(response.status)) {
        throw createServerDownloadsUnavailableError();
    }

    let body = null;
    try {
        body = await response.json();
    } catch {
        // Keep body null so the status code becomes the useful error.
    }

    if (!response.ok || !body?.success) {
        throw new Error(body?.error || `Server download request failed: ${response.status}`);
    }

    return body;
}

async function fetchServerDownloadJob(jobId, { signal } = {}) {
    const response = await fetch(`${SERVER_DOWNLOAD_API}/${encodeURIComponent(jobId)}`, {
        signal,
        headers: {
            accept: 'application/json',
        },
    });

    if (SERVER_DOWNLOAD_UNSUPPORTED_STATUSES.has(response.status)) {
        throw createServerDownloadsUnavailableError();
    }

    const body = await response.json();
    if (!response.ok || !body?.success) {
        throw new Error(body?.error || `Server download status failed: ${response.status}`);
    }
    return body.job;
}

async function cancelServerDownload(jobId) {
    const response = await fetch(`${SERVER_DOWNLOAD_API}/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        headers: {
            accept: 'application/json',
        },
    });

    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) {
        throw new Error(body?.error || `Server download cancel failed: ${response.status}`);
    }
    return body.job;
}

function delayMs(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }

        const timeout = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timeout);
                reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true }
        );
    });
}

async function pollServerDownloadJob(jobId, { signal, onUpdate }) {
    let transientFailures = 0;

    while (!signal?.aborted) {
        try {
            const job = await fetchServerDownloadJob(jobId, { signal });
            transientFailures = 0;
            onUpdate?.(job);

            if (SERVER_DOWNLOAD_TERMINAL_STATUSES.has(job.status)) {
                return job;
            }
        } catch (error) {
            if (error?.name === 'AbortError') throw error;

            transientFailures += 1;
            // ~60 seconds of reconnect tolerance at the default polling rate.
            if (transientFailures > 40) throw error;
        }

        await delayMs(SERVER_DOWNLOAD_POLL_INTERVAL_MS, signal);
    }

    throw new DOMException('Aborted', 'AbortError');
}

function serverJobStatusText(job) {
    if (job.error) return job.error;

    switch (job.status) {
        case 'queued':
            return 'Queued on server';
        case 'processing':
            return job.progress?.message || 'Processing on server';
        case 'paused':
            return 'Paused on server';
        case 'completed':
            return 'Server download complete';
        case 'cancelled':
            return 'Server download cancelled';
        case 'failed':
            return job.failureCode || 'Server download failed';
        default:
            return job.progress?.message || `Server job: ${job.status}`;
    }
}

function attachServerCancel(button, jobId) {
    button?.addEventListener(
        'click',
        () => {
            cancelServerDownload(jobId).catch((error) => {
                console.warn('Failed to cancel server download:', error);
            });
        },
        { once: true }
    );
}

function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
    if (value >= 1024) return `${(value / 1024).toFixed(0)} KiB`;
    return `${value} B`;
}

function updateServerBulkDownloadProgress(notifEl, job, tracks = []) {
    const progressFill = notifEl.querySelector('.download-progress-fill');
    const statusEl = notifEl.querySelector('.download-status');
    if (!progressFill || !statusEl) return;

    const percent = Math.max(0, Math.min(100, Number(job.progress?.percent) || 0));
    progressFill.style.width = `${percent}%`;
    progressFill.style.background = 'var(--highlight)';
    statusEl.textContent = serverJobStatusText(job);

    let detailsEl = notifEl.querySelector('.server-download-details');
    if (!detailsEl) {
        detailsEl = document.createElement('div');
        detailsEl.className = 'server-download-details';
        detailsEl.style.cssText =
            'font-size:0.72rem;color:var(--muted-foreground);margin-top:0.35rem;line-height:1.35;overflow-wrap:anywhere;';
        statusEl.insertAdjacentElement('afterend', detailsEl);
    }

    const total = Number(job.progress?.totalTracks || tracks.length || 0);
    const completed = Number(job.progress?.completedTracks || 0);
    const currentTrackId = job.progress?.currentTrack;
    const currentIndex =
        currentTrackId == null
            ? -1
            : tracks.findIndex((track) => String(track?.id) === String(currentTrackId));
    const currentTrack = currentIndex >= 0 ? tracks[currentIndex] : null;
    const currentTitle = currentTrack?.title || currentTrack?.name || null;
    const currentNumber = currentIndex >= 0 ? currentIndex + 1 : completed < total ? completed + 1 : null;

    const lines = [];
    if (total > 0) {
        let progressLine = `${completed} / ${total} complete`;
        if (currentTrackId != null && currentNumber != null) {
            progressLine += ` · Track ${currentNumber}`;
            if (currentTitle) progressLine += `: ${currentTitle}`;
        }
        lines.push(progressLine);
    }

    const transfer = job.progress?.trackTransfer;
    if (transfer && Number(transfer.downloadedBytes) > 0) {
        const downloadedBytes = Number(transfer.downloadedBytes || 0);
        const totalBytes = Number(transfer.totalBytes || 0);
        if (totalBytes > 0) {
            const transferPercent = Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)));
            lines.push(
                `Current track: ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)} (${transferPercent}%)`
            );
        } else {
            lines.push(`Current track: ${formatBytes(downloadedBytes)} received`);
        }
    }

    const updatedAt = job.updatedAt ? Date.parse(job.updatedAt) : NaN;
    if (Number.isFinite(updatedAt)) {
        const ageSeconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
        let ageLabel;
        if (ageSeconds < 60) ageLabel = `${ageSeconds}s ago`;
        else if (ageSeconds < 3600) ageLabel = `${Math.floor(ageSeconds / 60)}m ${ageSeconds % 60}s ago`;
        else ageLabel = `${Math.floor(ageSeconds / 3600)}h ${Math.floor((ageSeconds % 3600) / 60)}m ago`;

        lines.push(`Last progress ${ageLabel}${ageSeconds >= 120 ? ' · possibly stalled' : ''}`);
        detailsEl.style.opacity = ageSeconds >= 120 ? '1' : '0.85';
        detailsEl.style.fontWeight = ageSeconds >= 120 ? '600' : '400';
    }

    detailsEl.textContent = lines.join('\n');
    detailsEl.style.whiteSpace = 'pre-line';
}

function validateBridge(ui) {
    const required = [
        'showNotification',
        'addDownloadTask',
        'updateDownloadProgress',
        'completeDownloadTask',
        'createBulkDownloadNotification',
        'completeBulkDownload',
    ];
    for (const name of required) {
        if (typeof ui?.[name] !== 'function') {
            throw new TypeError(`Self-host download bridge requires ui.${name}()`);
        }
    }
}

/**
 * Creates the only integration boundary between upstream js/downloads.js and
 * the self-host download implementation.
 *
 * Keep this API small. If upstream changes notification internals, update only
 * the adapter in js/downloads.js and this bridge contract.
 */
export function createSelfHostDownloadBridge(ui) {
    validateBridge(ui);
    scheduleSidebarLink();

    return {
        async tryQueueTrack(track, quality, api) {
            if (!shouldUseServerDownloads() || !track?.id) return false;

            try {

            const downloadKey = `server-track-${track.id}`;
            if (serverOngoingDownloads.has(downloadKey)) {
                ui.showNotification('This track is already queued on the server');
                return true;
            }

            const controller = new AbortController();
            const body = await queueServerDownload(
                {
                    type: 'track',
                    id: track.id,
                    quality,
                    track,
                },
                { signal: controller.signal }
            );

            serverOngoingDownloads.add(downloadKey);
            const { taskEl } = ui.addDownloadTask(track.id, track, null, api, controller);
            attachServerCancel(taskEl.querySelector('.download-cancel'), body.jobId);
            ui.updateDownloadProgress(track.id, { message: 'Queued on server' });

            pollServerDownloadJob(body.jobId, {
                signal: controller.signal,
                onUpdate: (job) => {
                    if (job.status === 'completed') {
                        ui.completeDownloadTask(track.id, true, serverJobStatusText(job));
                    } else if (job.status === 'failed' || job.status === 'cancelled') {
                        ui.completeDownloadTask(track.id, false, serverJobStatusText(job));
                    } else {
                        ui.updateDownloadProgress(track.id, { message: serverJobStatusText(job) });
                    }
                },
            })
                .catch((error) => {
                    if (error?.name !== 'AbortError') {
                        ui.completeDownloadTask(track.id, false, error?.message || 'Server download failed');
                    }
                })
                .finally(() => {
                    serverOngoingDownloads.delete(downloadKey);
                });

                return true;
            } catch (error) {
                if (error?.serverDownloadsUnavailable) {
                    console.warn('Server-side downloads unavailable, falling back to browser download:', error);
                    return false;
                }

                ui.showNotification(error?.message || 'Failed to queue server download');
                return true;
            }
        },

        async tryQueueAlbum(album, tracks, quality) {
            const albumId = album?.id || album?.album?.id;
            if (!shouldUseServerDownloads() || !albumId) return false;

            try {

            const controller = new AbortController();
            const body = await queueServerDownload(
                {
                    type: 'album',
                    id: albumId,
                    quality,
                    album,
                    tracks,
                },
                { signal: controller.signal }
            );

            const notification = ui.createBulkDownloadNotification(
                'album',
                album.title || album.name || 'Album',
                1
            );
            attachServerCancel(notification.querySelector('.download-cancel'), body.jobId);
            updateServerBulkDownloadProgress(notification, body.job, tracks);

            pollServerDownloadJob(body.jobId, {
                signal: controller.signal,
                onUpdate: (job) => {
                    if (job.status === 'completed') {
                        ui.completeBulkDownload(notification, true);
                    } else if (job.status === 'failed' || job.status === 'cancelled') {
                        ui.completeBulkDownload(notification, false, serverJobStatusText(job));
                    } else {
                        updateServerBulkDownloadProgress(notification, job, tracks);
                    }
                },
            }).catch((error) => {
                if (error?.name !== 'AbortError') {
                    ui.completeBulkDownload(notification, false, error?.message || 'Server download failed');
                }
            });

                return true;
            } catch (error) {
                if (error?.serverDownloadsUnavailable) {
                    console.warn(
                        'Server-side downloads unavailable, falling back to browser album download:',
                        error
                    );
                    return false;
                }

                ui.showNotification(error?.message || 'Failed to queue server album download');
                throw error;
            }
        },
    };
}
