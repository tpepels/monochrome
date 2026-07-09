import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { executeTrackDownload } from './track-pipeline.js';

let root;

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'monochrome-track-pipeline-'));
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

function wavBuffer({ durationSeconds = 2, sampleRate = 8000 } = {}) {
    const channels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = durationSeconds * byteRate;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    return buffer;
}

function resolvedTrack(overrides = {}) {
    return {
        id: 'track1',
        quality: 'LOSSLESS',
        streamUrl: 'https://cdn.test/audio.wav',
        manifest: null,
        manifestDetails: { kind: 'unknown', urls: [], streamUrl: null, dash: null },
        urls: [],
        duration: 2,
        isPreview: false,
        presentationFlags: { assetPresentation: 'FULL', trackPresentation: 'FULL', isPreview: false },
        metadata: {
            id: 'track1',
            title: 'Track Title',
            trackNumber: 1,
            artist: { name: 'Track Artist' },
            album: {
                title: 'Album Title',
                artist: { name: 'Album Artist' },
                releaseDate: '2024-01-01',
            },
            isrc: 'ISRC1',
        },
        isrc: 'ISRC1',
        ...overrides,
    };
}

function resolverFor(track) {
    return {
        async resolveTrackDownload() {
            return track;
        },
    };
}

function fetchFor(map) {
    return async (url) => {
        const value = map[String(url)];
        if (!value) return new Response('missing', { status: 404 });
        return new Response(value);
    };
}

async function noOpMetadataEmbedder() {
    return { embedded: true, method: 'test' };
}

test('downloads a valid direct URL to temp, validates it, and publishes final file', async () => {
    const config = {
        tempRoot: path.join(root, 'tmp'),
        downloadRoot: path.join(root, 'music'),
    };

    const result = await executeTrackDownload({
        id: 'track1',
        quality: 'LOSSLESS',
        jobId: 'job1',
        config,
        resolver: resolverFor(resolvedTrack()),
        fetchImpl: fetchFor({ 'https://cdn.test/audio.wav': wavBuffer({ durationSeconds: 2 }) }),
        metadataEmbedder: noOpMetadataEmbedder,
    });

    expect(result.action).toBe('published');
    expect(result.relativePath).toBe(path.join('Album Artist', 'Album Title', '01 - Track Title.wav'));
    expect(await fs.stat(result.finalFile)).toMatchObject({ size: 32044 });
    await expect(fs.stat(path.join(config.tempRoot, 'job1'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('uses the allowed origin headers for Deezer server-side downloads', async () => {
    const calls = [];
    const deezerUrl = 'https://dzr.tabs-vs-spaces.wtf/stream/?isrc=USWB12600223&format=FLAC';

    await executeTrackDownload({
        id: 'track1',
        quality: 'LOSSLESS',
        jobId: 'job-deezer-origin',
        config: {
            tempRoot: path.join(root, 'tmp'),
            downloadRoot: path.join(root, 'music'),
        },
        resolver: resolverFor(
            resolvedTrack({
                streamUrl: deezerUrl,
            })
        ),
        fetchImpl: async (url, options) => {
            calls.push({ url: String(url), headers: options.headers });
            return new Response(wavBuffer({ durationSeconds: 2 }));
        },
        metadataEmbedder: noOpMetadataEmbedder,
    });

    expect(calls[0].url).toBe(deezerUrl);
    expect(calls[0].headers.origin).toBe('https://monochrome.tf');
    expect(calls[0].headers.referer).toBe('https://monochrome.tf/');
});

test('rejects preview-only tracks before fetching audio', async () => {
    let fetched = false;
    await expect(
        executeTrackDownload({
            id: 'track1',
            config: {
                tempRoot: path.join(root, 'tmp'),
                downloadRoot: path.join(root, 'music'),
            },
            resolver: resolverFor(
                resolvedTrack({
                    isPreview: true,
                    presentationFlags: { assetPresentation: 'PREVIEW', trackPresentation: 'PREVIEW', isPreview: true },
                })
            ),
            fetchImpl: async () => {
                fetched = true;
                return new Response(wavBuffer());
            },
            metadataEmbedder: noOpMetadataEmbedder,
        })
    ).rejects.toMatchObject({ failureCode: 'PREVIEW_STREAM_REJECTED' });

    expect(fetched).toBe(false);
});

test('downloads from JSON manifest URLs', async () => {
    const result = await executeTrackDownload({
        id: 'track1',
        config: {
            tempRoot: path.join(root, 'tmp'),
            downloadRoot: path.join(root, 'music'),
        },
        resolver: resolverFor(
            resolvedTrack({
                streamUrl: null,
                manifest: { urls: ['https://cdn.test/audio.wav'] },
                manifestDetails: null,
            })
        ),
        fetchImpl: fetchFor({ 'https://cdn.test/audio.wav': wavBuffer({ durationSeconds: 2 }) }),
        metadataEmbedder: noOpMetadataEmbedder,
    });

    expect(result.action).toBe('published');
    expect(result.validation.extension).toBe('wav');
});

test('downloads from base64 JSON manifests', async () => {
    const encodedManifest = Buffer.from(JSON.stringify({ urls: ['https://cdn.test/audio.wav'] }), 'utf8').toString(
        'base64'
    );

    const result = await executeTrackDownload({
        id: 'track1',
        config: {
            tempRoot: path.join(root, 'tmp'),
            downloadRoot: path.join(root, 'music'),
        },
        resolver: resolverFor(
            resolvedTrack({
                streamUrl: null,
                manifest: encodedManifest,
                manifestDetails: null,
            })
        ),
        fetchImpl: fetchFor({ 'https://cdn.test/audio.wav': wavBuffer({ durationSeconds: 2 }) }),
        metadataEmbedder: noOpMetadataEmbedder,
    });

    expect(result.action).toBe('published');
    expect(result.validation.extension).toBe('wav');
});

test('downloads DASH MPD initialization and media segments', async () => {
    const wav = wavBuffer({ durationSeconds: 2 });
    const mpd = [
        '<MPD><Period><AdaptationSet mimeType="audio/wav"><Representation id="audio">',
        '<BaseURL>https://cdn.test/dash/</BaseURL>',
        '<SegmentTemplate initialization="init.wav" media="seg-$Number$.wav" startNumber="1">',
        '<SegmentTimeline><S d="1"/></SegmentTimeline>',
        '</SegmentTemplate></Representation></AdaptationSet></Period></MPD>',
    ].join('');

    const result = await executeTrackDownload({
        id: 'track1',
        config: {
            tempRoot: path.join(root, 'tmp'),
            downloadRoot: path.join(root, 'music'),
        },
        resolver: resolverFor(
            resolvedTrack({
                streamUrl: null,
                manifest: Buffer.from(mpd, 'utf8').toString('base64'),
                manifestDetails: null,
            })
        ),
        fetchImpl: fetchFor({
            'https://cdn.test/dash/init.wav': wav.subarray(0, 44),
            'https://cdn.test/dash/seg-1.wav': wav.subarray(44),
        }),
        metadataEmbedder: noOpMetadataEmbedder,
    });

    expect(result.action).toBe('published');
    expect(result.validation.extension).toBe('wav');
});

test('rejects duration mismatches that look like previews', async () => {
    await expect(
        executeTrackDownload({
            id: 'track1',
            config: {
                tempRoot: path.join(root, 'tmp'),
                downloadRoot: path.join(root, 'music'),
            },
            resolver: resolverFor(resolvedTrack({ duration: 180 })),
            fetchImpl: fetchFor({ 'https://cdn.test/audio.wav': wavBuffer({ durationSeconds: 30 }) }),
            metadataEmbedder: noOpMetadataEmbedder,
        })
    ).rejects.toMatchObject({ failureCode: 'PREVIEW_DURATION_DETECTED' });
});

test('rejects empty downloads and deletes temp job directory on failure', async () => {
    const config = {
        tempRoot: path.join(root, 'tmp'),
        downloadRoot: path.join(root, 'music'),
    };

    await expect(
        executeTrackDownload({
            id: 'track1',
            jobId: 'empty-job',
            config,
            resolver: resolverFor(resolvedTrack()),
            fetchImpl: fetchFor({ 'https://cdn.test/audio.wav': Buffer.alloc(0) }),
            metadataEmbedder: noOpMetadataEmbedder,
        })
    ).rejects.toMatchObject({ failureCode: 'EMPTY_DOWNLOAD_FILE' });

    await expect(fs.stat(path.join(config.tempRoot, 'empty-job'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('rejects corrupt non-audio downloads', async () => {
    await expect(
        executeTrackDownload({
            id: 'track1',
            config: {
                tempRoot: path.join(root, 'tmp'),
                downloadRoot: path.join(root, 'music'),
            },
            resolver: resolverFor(resolvedTrack()),
            fetchImpl: fetchFor({ 'https://cdn.test/audio.wav': Buffer.from('this is not an audio container') }),
            metadataEmbedder: noOpMetadataEmbedder,
        })
    ).rejects.toMatchObject({ failureCode: 'UNSUPPORTED_AUDIO_CONTAINER' });
});

test('skips publication when an existing final file is identical and valid', async () => {
    const config = {
        tempRoot: path.join(root, 'tmp'),
        downloadRoot: path.join(root, 'music'),
    };
    const finalFile = path.join(config.downloadRoot, 'Album Artist', 'Album Title', '01 - Track Title.wav');
    await fs.mkdir(path.dirname(finalFile), { recursive: true });
    await fs.writeFile(finalFile, wavBuffer({ durationSeconds: 2 }));

    const result = await executeTrackDownload({
        id: 'track1',
        config,
        resolver: resolverFor(resolvedTrack()),
        fetchImpl: fetchFor({ 'https://cdn.test/audio.wav': wavBuffer({ durationSeconds: 2 }) }),
        metadataEmbedder: noOpMetadataEmbedder,
    });

    expect(result.action).toBe('skipped-identical');
    expect(result.finalFile).toBe(finalFile);
});

test('falls back to copy/unlink when final rename crosses devices', async () => {
    const config = {
        tempRoot: path.join(root, 'tmp'),
        downloadRoot: path.join(root, 'music'),
    };
    const fsOps = {
        ...fs,
        async rename(from, to) {
            if (String(from).endsWith('track.download')) {
                const error = new Error('cross-device link not permitted');
                error.code = 'EXDEV';
                throw error;
            }
            return fs.rename(from, to);
        },
    };

    const result = await executeTrackDownload({
        id: 'track1',
        config,
        fsOps,
        resolver: resolverFor(resolvedTrack()),
        fetchImpl: fetchFor({ 'https://cdn.test/audio.wav': wavBuffer({ durationSeconds: 2 }) }),
        metadataEmbedder: noOpMetadataEmbedder,
    });

    expect(result.action).toBe('published');
    expect(result.publishMethod).toBe('copy-unlink');
    await expect(fs.stat(result.finalFile)).resolves.toBeTruthy();
});
