const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monochrome Downloads</title>
<style>
:root {
    color-scheme: light dark;
    --bg:#111214; --panel:#1a1c20; --panel-2:#22252a; --text:#f3f4f6;
    --muted:#9ca3af; --border:#343840; --accent:#e5e7eb; --good:#65a30d;
    --warn:#ca8a04; --bad:#dc2626; --blue:#2563eb;
}
@media (prefers-color-scheme: light) {
    :root {
        --bg:#f5f6f8; --panel:#fff; --panel-2:#f0f1f3; --text:#17181b;
        --muted:#6b7280; --border:#d8dbe0; --accent:#17181b;
    }
}
* { box-sizing:border-box; }
body {
    margin:0; background:var(--bg); color:var(--text);
    font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
main { max-width:980px; margin:0 auto; padding:28px 18px 60px; }
header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:22px; }
h1 { font-size:23px; margin:0 0 4px; }
.subtle,.small { color:var(--muted); }
.actions,.job-actions { display:flex; flex-wrap:wrap; gap:8px; }
.actions { justify-content:flex-end; }
button,a.button {
    border:1px solid var(--border); background:var(--panel); color:var(--text);
    padding:8px 11px; border-radius:8px; cursor:pointer; font:inherit;
    text-decoration:none;
}
button:hover,a.button:hover { background:var(--panel-2); }
button.danger { border-color:var(--bad); }
button:disabled { opacity:.45; cursor:default; }
.summary { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:8px; margin-bottom:16px; }
.metric,.worker,.job {
    background:var(--panel); border:1px solid var(--border); border-radius:10px;
}
.metric { padding:11px 12px; }
.metric strong { display:block; font-size:19px; }
.metric span { color:var(--muted); font-size:12px; }
.worker { padding:10px 12px; margin-bottom:16px; color:var(--muted); }
.job { border-radius:12px; padding:14px; margin-bottom:10px; }
.job-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
.job-title { font-weight:650; font-size:15px; overflow-wrap:anywhere; }
.job-meta { margin-top:2px; color:var(--muted); font-size:12px; }
.badge {
    display:inline-block; border:1px solid var(--border); border-radius:999px;
    padding:2px 7px; font-size:11px; text-transform:uppercase; letter-spacing:.04em;
}
.badge.processing { border-color:var(--blue); }
.badge.completed { border-color:var(--good); }
.badge.failed { border-color:var(--bad); }
.badge.queued { border-color:var(--warn); }
.progress { height:6px; background:var(--panel-2); border-radius:999px; overflow:hidden; margin:11px 0 8px; }
.progress > div { height:100%; background:var(--accent); transition:width .25s ease; }
.details { display:grid; grid-template-columns:1fr auto; gap:8px 14px; align-items:end; }
.detail-lines { min-width:0; }
.detail-lines div { margin-top:2px; }
.small { font-size:12px; }
.stalled { color:var(--warn); font-weight:650; }
.error { color:var(--bad); margin-top:7px; overflow-wrap:anywhere; }
.error-meta { color:var(--muted); font-size:12px; margin-top:3px; }
.error-details { margin-top:9px; border:1px solid var(--border); border-radius:8px; background:var(--panel-2); }
.error-details summary { cursor:pointer; padding:8px 10px; color:var(--text); font-weight:600; }
.error-details[open] summary { border-bottom:1px solid var(--border); }
.diagnostic-body { padding:10px; }
.diagnostic-grid { display:grid; grid-template-columns:minmax(120px,auto) 1fr; gap:5px 12px; }
.diagnostic-label { color:var(--muted); }
.diagnostic-value { min-width:0; overflow-wrap:anywhere; }
.diagnostic-value code { font-size:12px; }
.diagnostic-actions { display:flex; justify-content:flex-end; margin:10px 0 7px; }
.diagnostic-actions button { padding:5px 8px; font-size:12px; }
.diagnostic-json { margin:0; padding:9px; max-height:260px; overflow:auto; border-radius:7px; background:var(--bg); color:var(--muted); font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre-wrap; word-break:break-word; }
.empty { border:1px dashed var(--border); border-radius:12px; padding:30px; text-align:center; color:var(--muted); }
#message { min-height:20px; margin:0 0 10px; color:var(--muted); }
@media (max-width:700px) {
    header { display:block; }
    .actions { justify-content:flex-start; margin-top:12px; }
    .summary { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .details { grid-template-columns:1fr; }
    .job-actions { margin-top:6px; }
}
</style>
</head>
<body>
<main>
<header>
    <div>
        <h1>Server downloads</h1>
        <div class="subtle">Standalone queue monitor — separate from the Monochrome frontend.</div>
    </div>
    <div class="actions">
        <a class="button" href="/">Monochrome</a>
        <button id="refresh">Refresh</button>
        <button id="reset">Clear queue</button>
        <button id="hard-reset" class="danger">Clear + cleanup</button>
    </div>
</header>

<div id="summary" class="summary"></div>
<div id="worker" class="worker">Loading worker state…</div>
<div id="message"></div>
<section id="jobs"><div class="empty">Loading downloads…</div></section>
</main>

<script>
const POLL_MS = 1500;
let busy = false;

const esc = (value) =>
    String(value == null ? '' : value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');

function age(iso) {
    const timestamp = Date.parse(iso || '');
    if (!Number.isFinite(timestamp)) return 'unknown';
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's ago';
    return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm ago';
}

function bytes(value) {
    const n = Number(value || 0);
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GiB';
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MiB';
    if (n >= 1024) return Math.round(n / 1024) + ' KiB';
    return n + ' B';
}

function diagnosticRow(label, value, code) {
    if (value == null || value === '') return '';
    return '<div class="diagnostic-label">' + esc(label) + '</div>' +
        '<div class="diagnostic-value">' + (code ? '<code>' + esc(value) + '</code>' : esc(value)) + '</div>';
}

function renderError(job) {
    if (!job.error) return '';

    const diagnostics = job.diagnostics || {};
    const error = diagnostics.error || {};
    const state = diagnostics.state || {};
    const meta = [];

    if (job.failureCode) meta.push(job.failureCode);
    if (error.httpStatus) meta.push('HTTP ' + error.httpStatus);
    if (error.transferAttempt) {
        meta.push(
            'transfer attempt ' + error.transferAttempt +
            (error.maxTransferAttempts ? ' / ' + error.maxTransferAttempts : '')
        );
    }

    let details = '';
    if (job.diagnostics) {
        const segment =
            error.segmentIndex != null
                ? String(Number(error.segmentIndex) + 1) + (error.segmentCount ? ' / ' + error.segmentCount : '')
                : null;
        const stateSegment =
            state.segmentIndex != null
                ? String(Number(state.segmentIndex) + 1) + (state.segmentCount ? ' / ' + state.segmentCount : '')
                : null;
        const rows = [
            diagnosticRow('Failure code', error.failureCode || job.failureCode, true),
            diagnosticRow('HTTP status', error.httpStatus),
            diagnosticRow('Request URL', error.requestUrl, true),
            diagnosticRow('Cloudflare ray', error.cfRay, true),
            diagnosticRow('Retry-After', error.retryAfter),
            diagnosticRow('Provider', error.provider),
            diagnosticRow('Transfer attempt', error.transferAttempt && (error.transferAttempt + (error.maxTransferAttempts ? ' / ' + error.maxTransferAttempts : ''))),
            diagnosticRow('Segment', segment),
            diagnosticRow('Job ID', state.jobId || job.jobId, true),
            diagnosticRow('Queue attempt', state.queueAttempt || job.attempts),
            diagnosticRow('State at failure', state.statusAtFailure),
            diagnosticRow('Phase', state.phase),
            diagnosticRow('Progress', state.progressMessage),
            diagnosticRow('Current track', state.currentTrackTitle || state.currentTrack),
            diagnosticRow('Tracks complete', state.completedTracks != null && state.totalTracks != null ? state.completedTracks + ' / ' + state.totalTracks : null),
            diagnosticRow('Transferred', state.downloadedBytes != null ? bytes(state.downloadedBytes) + (state.totalBytes ? ' / ' + bytes(state.totalBytes) : '') : null),
            diagnosticRow('Transfer segment', stateSegment),
            diagnosticRow('Started', state.startedAt),
            diagnosticRow('Failed', state.failedAt)
        ].join('');

        details =
            '<details class="error-details">' +
                '<summary>Error details</summary>' +
                '<div class="diagnostic-body">' +
                    '<div class="diagnostic-grid">' + rows + '</div>' +
                    '<div class="diagnostic-actions"><button type="button" data-copy-diagnostics>Copy diagnostics</button></div>' +
                    '<pre class="diagnostic-json">' + esc(JSON.stringify(job.diagnostics, null, 2)) + '</pre>' +
                '</div>' +
            '</details>';
    }

    return '<div class="error">' +
        '<div>' + esc(job.error) + '</div>' +
        (meta.length ? '<div class="error-meta">' + esc(meta.join(' · ')) + '</div>' : '') +
        details +
    '</div>';
}

async function copyDiagnostics(button) {
    const pre = button.closest('details') && button.closest('details').querySelector('.diagnostic-json');
    if (!pre) return;
    const value = pre.textContent || '';

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(value);
        } else {
            throw new Error('Clipboard API unavailable');
        }
    } catch {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
    }

    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(function () { button.textContent = original; }, 1200);
}

function setMessage(text, isError) {
    const el = document.getElementById('message');
    el.textContent = text || '';
    el.style.color = isError ? 'var(--bad)' : 'var(--muted)';
}

async function api(url, options) {
    const response = await fetch(url, Object.assign({ cache:'no-store' }, options || {}));
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) {
        throw new Error(body.error || 'Request failed (' + response.status + ')');
    }
    return body;
}

function renderSummary(data) {
    const counts = data.counts || {};
    const values = [
        ['Queued', counts.queued || 0],
        ['Processing', counts.processing || 0],
        ['Completed', counts.completed || 0],
        ['Failed', counts.failed || 0],
        ['Cancelled', counts.cancelled || 0]
    ];

    document.getElementById('summary').innerHTML = values.map(function (item) {
        return '<div class="metric"><strong>' + item[1] + '</strong><span>' + item[0] + '</span></div>';
    }).join('');

    const worker = data.worker || {};
    document.getElementById('worker').innerHTML =
        '<strong>Worker:</strong> ' +
        esc(worker.enabled ? 'enabled' : 'disabled') +
        ' · ' + esc(worker.active || 0) +
        ' active / ' + esc(worker.concurrency || 0) +
        ' concurrency · backend: ' +
        esc(data.backend || worker.backend || 'unknown');
}

function jobDetails(job) {
    const progress = job.progress || {};
    const total = Number(progress.totalTracks || 0);
    const completed = Number(progress.completedTracks || 0);
    const lines = [];

    if (total > 0) {
        let line = completed + ' / ' + total + ' tracks complete';
        if (progress.currentTrack) {
            line += ' · current: ' + (job.currentTrackTitle || ('track ' + progress.currentTrack));
        }
        lines.push(esc(line));
    }

    const transfer = progress.trackTransfer;
    if (transfer && Number(transfer.downloadedBytes) > 0) {
        const got = Number(transfer.downloadedBytes || 0);
        const all = Number(transfer.totalBytes || 0);
        const text = all > 0
            ? 'Current track: ' + bytes(got) + ' / ' + bytes(all) + ' (' + Math.round((got / all) * 100) + '%)'
            : 'Current track: ' + bytes(got) + ' received';
        lines.push(esc(text));
    } else if (Number(progress.downloadedBytes) > 0) {
        const got = Number(progress.downloadedBytes || 0);
        const all = Number(progress.totalBytes || 0);
        const text = all > 0
            ? 'Transfer: ' + bytes(got) + ' / ' + bytes(all) + ' (' + Math.round((got / all) * 100) + '%)'
            : 'Transfer: ' + bytes(got) + ' received';
        lines.push(esc(text));
    }

    const updated = Date.parse(job.updatedAt || '');
    const staleSeconds = Number.isFinite(updated) ? Math.floor((Date.now() - updated) / 1000) : 0;
    const stalled = job.status === 'processing' && staleSeconds >= 120;
    lines.push(
        '<span class="' + (stalled ? 'stalled' : 'small') + '">' +
        'Last progress ' + esc(age(job.updatedAt)) +
        (stalled ? ' · possibly stalled' : '') +
        '</span>'
    );

    return lines.join('<br>');
}

function renderJobs(data) {
    const root = document.getElementById('jobs');
    const jobs = data.jobs || [];

    if (!jobs.length) {
        root.innerHTML = '<div class="empty">Queue is empty.</div>';
        return;
    }

    root.innerHTML = jobs.map(function (job) {
        const p = Math.max(0, Math.min(100, Number(job.progress && job.progress.percent) || 0));
        const canCancel = ['queued', 'processing', 'paused'].includes(job.status);
        const canRetry = job.status === 'failed' && job.retryable;
        const title = job.displayName || (job.type + ' ' + job.id);

        return '<article class="job">' +
            '<div class="job-head">' +
                '<div>' +
                    '<div class="job-title">' + esc(title) + '</div>' +
                    '<div class="job-meta">' + esc(job.type) + ' · ' + esc(job.quality) + ' · ' + esc(job.id) + '</div>' +
                '</div>' +
                '<span class="badge ' + esc(job.status) + '">' + esc(job.status) + '</span>' +
            '</div>' +
            '<div class="progress"><div style="width:' + p + '%"></div></div>' +
            '<div class="details">' +
                '<div class="detail-lines">' +
                    '<div>' + esc((job.progress && job.progress.message) || job.status) + ' · ' + p + '%</div>' +
                    '<div class="small">' + jobDetails(job) + '</div>' +
                    renderError(job) +
                '</div>' +
                '<div class="job-actions">' +
                    (canCancel ? '<button data-cancel="' + esc(job.jobId) + '">Cancel</button>' : '') +
                    (canRetry ? '<button data-retry="' + esc(job.jobId) + '">Retry</button>' : '') +
                '</div>' +
            '</div>' +
        '</article>';
    }).join('');

    root.querySelectorAll('[data-cancel]').forEach(function (button) {
        button.addEventListener('click', function () { runJobAction(button, 'cancel'); });
    });
    root.querySelectorAll('[data-retry]').forEach(function (button) {
        button.addEventListener('click', function () { runJobAction(button, 'retry'); });
    });
    root.querySelectorAll('[data-copy-diagnostics]').forEach(function (button) {
        button.addEventListener('click', function () { copyDiagnostics(button); });
    });
}

async function refresh() {
    try {
        const snapshot = await api('/api/downloads');
        renderSummary(snapshot);
        renderJobs(snapshot);
        if (!busy) setMessage('Auto-refreshing every ' + (POLL_MS / 1000) + 's');
    } catch (error) {
        setMessage('Could not load queue: ' + error.message, true);
    }
}

async function runJobAction(button, action) {
    const jobId = button.dataset[action];
    if (!jobId || busy) return;

    busy = true;
    button.disabled = true;
    setMessage((action === 'cancel' ? 'Cancelling' : 'Retrying') + ' job…');

    try {
        await api('/api/downloads/' + encodeURIComponent(jobId) + '/' + action, { method:'POST' });
        await refresh();
    } catch (error) {
        setMessage(error.message, true);
    } finally {
        busy = false;
        button.disabled = false;
    }
}

async function resetQueue(cleanup) {
    if (busy) return;

    const warning = cleanup
        ? 'Abort all active downloads, clear the queue, and delete unfinished Monochrome temp/staging data? Completed music is kept.'
        : 'Abort all active downloads and clear the queue? Unfinished staging data will be kept.';

    if (!confirm(warning)) return;

    busy = true;
    setMessage(cleanup ? 'Clearing queue and unfinished data…' : 'Clearing queue…');

    try {
        const result = await api('/api/downloads/reset' + (cleanup ? '?cleanup=true' : ''), { method:'POST' });
        setMessage(
            'Cleared ' + result.clearedJobs + ' job(s)' +
            (cleanup ? ' and ' + ((result.cleanupActions && result.cleanupActions.length) || 0) + ' transient path(s).' : '.')
        );
        await refresh();
    } catch (error) {
        setMessage(error.message, true);
    } finally {
        busy = false;
    }
}

document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('reset').addEventListener('click', function () { resetQueue(false); });
document.getElementById('hard-reset').addEventListener('click', function () { resetQueue(true); });

refresh();
setInterval(refresh, POLL_MS);
</script>
</body>
</html>`;

export function downloadAdminResponse() {
    const headers = new Headers();
    headers.set('content-type', 'text/html; charset=UTF-8');
    headers.set('cache-control', 'no-store');
    return new Response(ADMIN_HTML, { headers });
}
