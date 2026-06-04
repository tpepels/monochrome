const API_ROOT = '/api/downloads';

let initialized = false;
let refreshTimer = null;

function byId(id) {
    return document.getElementById(id);
}

async function readJsonResponse(response) {
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success === false) {
        throw new Error(body?.error || `Request failed: ${response.status}`);
    }
    return body;
}

async function fetchQueueSnapshot() {
    return readJsonResponse(
        await fetch(API_ROOT, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
        })
    );
}

async function postJobAction(jobId, action) {
    return readJsonResponse(
        await fetch(`${API_ROOT}/${encodeURIComponent(jobId)}/${action}`, {
            method: 'POST',
            headers: { accept: 'application/json' },
        })
    );
}

async function runSweep(dryRun) {
    return readJsonResponse(
        await fetch(`${API_ROOT}/maintenance/sweep`, {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ dryRun }),
        })
    );
}

function statusLabel(job) {
    if (job.error) return job.error;
    if (job.status === 'processing' && job.progress?.phase) return `${job.status} - ${job.progress.phase}`;
    return job.status || 'unknown';
}

function renderSummary(snapshot) {
    const summary = byId('server-downloads-summary');
    if (!summary) return;

    const worker = snapshot.worker || {};
    const counts = snapshot.counts || {};
    const fallback = snapshot.fallback ? ` fallback: ${snapshot.fallback.reason}` : '';
    summary.textContent = [
        `backend: ${snapshot.backend || worker.backend || 'unknown'}${fallback}`,
        `worker: ${worker.enabled ? 'enabled' : 'disabled'}`,
        `active: ${worker.active || 0}/${worker.concurrency || 1}`,
        `queued: ${counts.queued || 0}`,
        `processing: ${counts.processing || 0}`,
        `failed: ${counts.failed || 0}`,
    ].join(' | ');
}

function jobProgress(job) {
    if (job.type === 'album' && job.progress?.totalTracks) {
        const completed = job.progress.completedTracks || 0;
        const total = job.progress.totalTracks;
        const current = job.progress.currentTrack ? ` current: ${job.progress.currentTrack}` : '';
        return `${completed}/${total}${current}`;
    }

    const percent = Number(job.progress?.percent);
    return Number.isFinite(percent) ? `${Math.round(percent)}%` : '';
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function renderJobs(snapshot) {
    const jobsEl = byId('server-downloads-jobs');
    if (!jobsEl) return;

    const jobs = snapshot.jobs || [];
    if (!jobs.length) {
        jobsEl.innerHTML = '<div class="server-downloads-empty">No server download jobs</div>';
        return;
    }

    jobsEl.innerHTML = jobs
        .slice()
        .reverse()
        .map((job) => {
            const canCancel = job.status === 'queued' || job.status === 'processing';
            const canRetry = job.status === 'failed' && job.retryable;
            const controls = [
                canCancel
                    ? `<button class="btn-secondary server-download-action" data-action="cancel" data-job-id="${job.jobId}">Cancel</button>`
                    : '',
                canRetry
                    ? `<button class="btn-secondary server-download-action" data-action="retry" data-job-id="${job.jobId}">Retry</button>`
                    : '',
            ].join('');

            return `
                <div class="server-download-row">
                    <div class="server-download-main">
                        <span class="server-download-title">${escapeHtml(job.type)}: ${escapeHtml(job.id)}</span>
                        <span class="server-download-meta">${escapeHtml(statusLabel(job))} ${escapeHtml(jobProgress(job))}</span>
                    </div>
                    <div class="server-download-controls">${controls}</div>
                </div>
            `;
        })
        .join('');
}

async function refreshQueue() {
    const status = byId('server-downloads-status');
    try {
        const snapshot = await fetchQueueSnapshot();
        renderSummary(snapshot);
        renderJobs(snapshot);
        if (status) status.textContent = `updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
        if (status) status.textContent = error?.message || 'Server download status unavailable';
    }
}

async function handleJobAction(event) {
    const button = event.target.closest('.server-download-action');
    if (!button) return;

    const jobId = button.dataset.jobId;
    const action = button.dataset.action;
    if (!jobId || !action) return;

    button.disabled = true;
    try {
        await postJobAction(jobId, action);
        await refreshQueue();
    } catch (error) {
        const status = byId('server-downloads-status');
        if (status) status.textContent = error?.message || `${action} failed`;
    } finally {
        button.disabled = false;
    }
}

async function handleSweep(dryRun) {
    const output = byId('server-downloads-sweep-result');
    if (output) output.textContent = dryRun ? 'running dry run...' : 'running cleanup...';

    try {
        const result = await runSweep(dryRun);
        const actions = result.actions || [];
        if (output) {
            output.textContent = actions.length
                ? actions.map((action) => `${action.action}: ${action.path}`).join('\n')
                : 'No transient download paths found';
        }
        await refreshQueue();
    } catch (error) {
        if (output) output.textContent = error?.message || 'Sweep failed';
    }
}

export function initializeServerDownloadsPanel() {
    if (initialized) return;
    const panel = byId('server-downloads-panel');
    if (!panel) return;

    initialized = true;
    byId('server-downloads-refresh')?.addEventListener('click', () => {
        refreshQueue();
    });
    byId('server-downloads-sweep-dry-run')?.addEventListener('click', () => {
        handleSweep(true);
    });
    byId('server-downloads-sweep-apply')?.addEventListener('click', () => {
        const confirmed = window.confirm('Remove stale server download temp and transient publication paths?');
        if (confirmed) handleSweep(false);
    });
    byId('server-downloads-jobs')?.addEventListener('click', handleJobAction);

    refreshQueue();
    refreshTimer = window.setInterval(refreshQueue, 5000);
    window.addEventListener('beforeunload', () => {
        if (refreshTimer) window.clearInterval(refreshTimer);
    });
}
