import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { executeAlbumDownload, InMemoryPublishLock } from './album-pipeline.js';
import { executeTrackDownload } from './track-pipeline.js';

let root;

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'monochrome-album-pipeline-'));
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

function albumResult(overrides = {}) {
    return {
        id: 'album1',
        metadata: {
            id: 'album1',
            title: 'Album Title',
            artist: { name: 'Album Artist' },
            cover: 'cover-id',
        },
        coverUrl: 'https://cover.test/cover.jpg',
        tracks: [
            { id: 't1', title: 'One', downloadOrder: { trackNumber: 1, discNumber: 1 } },
            { id: 't2', title: 'Two', downloadOrder: { trackNumber: 2, discNumber: 1 } },
        ],
        ...overrides,
    };
}

function resolverFor(album) {
    return {
        async resolveAlbum() {
            return album;
        },
        async resolveTrackDownload() {
            throw new Error('resolveTrackDownload should not be called by fake track executor');
        },
    };
}

function successfulTrackExecutor({ failAt = null, seenFinalDir = null } = {}) {
    return async ({ id, config }) => {
        if (failAt === id) {
            const error = new Error('track failed');
            error.failureCode = 'TRACK_FAILED';
            throw error;
        }

        if (seenFinalDir) {
            await expect(fs.stat(seenFinalDir)).rejects.toMatchObject({ code: 'ENOENT' });
        }

        const fileName = id === 't1' ? '01 - One.wav' : '02 - Two.wav';
        const filePath = path.join(config.downloadRoot, 'Album Artist', 'Album Title', fileName);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, Buffer.from(`audio-${id}`));
        return {
            success: true,
            id,
            finalFile: filePath,
            relativePath: path.join('Album Artist', 'Album Title', fileName),
        };
    };
}

function coverFetch() {
    return async (url) => {
        if (String(url) === 'https://cover.test/cover.jpg') {
            return new Response(Buffer.from('cover'));
        }
        return new Response('missing', { status: 404 });
    };
}

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

function albumResolverWithTrackMetadataMismatch() {
    const tracks = new Map([
        [
            't1',
            {
                id: 't1',
                quality: 'LOSSLESS',
                streamUrl: 'https://cdn.test/t1.wav',
                manifest: null,
                manifestDetails: { kind: 'unknown', urls: [], streamUrl: null, dash: null },
                urls: [],
                duration: 2,
                isPreview: false,
                presentationFlags: { assetPresentation: 'FULL', trackPresentation: 'FULL', isPreview: false },
                metadata: {
                    id: 't1',
                    title: 'One',
                    trackNumber: 1,
                    artist: { name: 'Track Artist' },
                    album: { title: 'Different Track Album', artist: { name: 'Different Track Artist' } },
                },
            },
        ],
        [
            't2',
            {
                id: 't2',
                quality: 'LOSSLESS',
                streamUrl: 'https://cdn.test/t2.wav',
                manifest: null,
                manifestDetails: { kind: 'unknown', urls: [], streamUrl: null, dash: null },
                urls: [],
                duration: 2,
                isPreview: false,
                presentationFlags: { assetPresentation: 'FULL', trackPresentation: 'FULL', isPreview: false },
                metadata: {
                    id: 't2',
                    title: 'Two',
                    trackNumber: 2,
                    artist: { name: 'Track Artist' },
                    album: { title: 'Different Track Album', artist: { name: 'Different Track Artist' } },
                },
            },
        ],
    ]);

    return {
        async resolveAlbum() {
            return albumResult();
        },
        async resolveTrackDownload(id) {
            return tracks.get(id);
        },
    };
}

test('stages all tracks and publishes the complete album with cover atomically', async () => {
    const config = {
        tempRoot: path.join(root, 'tmp'),
        downloadRoot: path.join(root, 'music'),
    };
    const finalAlbumDir = path.join(config.downloadRoot, 'Album Artist', 'Album Title');
    const progress = [];
    const fsOps = {
        ...fs,
        async cp() {
            throw new Error('album publish should not copy the full staging directory');
        },
    };

    const result = await executeAlbumDownload({
        id: 'album1',
        jobId: 'job1',
        config,
        fsOps,
        resolver: resolverFor(albumResult()),
        trackExecutor: successfulTrackExecutor({ seenFinalDir: finalAlbumDir }),
        fetchImpl: coverFetch(),
        publishLock: new InMemoryPublishLock(),
        onProgress: (event) => progress.push(event.phase),
    });

    expect(result.action).toBe('published');
    await expect(fs.stat(path.join(finalAlbumDir, '01 - One.wav'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(finalAlbumDir, '02 - Two.wav'))).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(finalAlbumDir, 'cover.jpg'), 'utf8')).resolves.toBe('cover');
    await expect(fs.stat(path.join(config.tempRoot, 'job1'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(config.downloadRoot, '.monochrome-staging', 'job1'))).rejects.toMatchObject({
        code: 'ENOENT',
    });
    expect(progress).toContain('processing');
    expect(progress).toContain('publishing');
    expect(progress).toContain('completed');
});

test('forces track files into the album metadata directory even when track metadata differs', async () => {
    const config = {
        tempRoot: path.join(root, 'tmp'),
        downloadRoot: path.join(root, 'music'),
    };
    const finalAlbumDir = path.join(config.downloadRoot, 'Album Artist', 'Album Title');
    const fetchImpl = async (url) => {
        if (String(url).startsWith('https://cdn.test/')) {
            return new Response(wavBuffer({ durationSeconds: 2 }));
        }
        return coverFetch()(url);
    };

    await executeAlbumDownload({
        id: 'album1',
        jobId: 'job-normalize-path',
        config,
        resolver: albumResolverWithTrackMetadataMismatch(),
        trackExecutor: executeTrackDownload,
        fetchImpl,
        metadataEmbedder: async () => ({ embedded: true, method: 'test' }),
        publishLock: new InMemoryPublishLock(),
    });

    await expect(fs.stat(path.join(finalAlbumDir, '01 - One.wav'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(finalAlbumDir, '02 - Two.wav'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(config.downloadRoot, 'Different Track Artist'))).rejects.toMatchObject({
        code: 'ENOENT',
    });
});

test('one failed track fails the album and leaves no final album directory', async () => {
    const config = {
        tempRoot: path.join(root, 'tmp'),
        downloadRoot: path.join(root, 'music'),
    };
    const finalAlbumDir = path.join(config.downloadRoot, 'Album Artist', 'Album Title');

    await expect(
        executeAlbumDownload({
            id: 'album1',
            jobId: 'job-fail',
            config,
            resolver: resolverFor(albumResult()),
            trackExecutor: successfulTrackExecutor({ failAt: 't2' }),
            fetchImpl: coverFetch(),
            publishLock: new InMemoryPublishLock(),
        })
    ).rejects.toMatchObject({ failureCode: 'TRACK_FAILED' });

    await expect(fs.stat(finalAlbumDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(config.tempRoot, 'job-fail'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('restores existing album if publication fails after backup creation', async () => {
    const config = {
        tempRoot: path.join(root, 'tmp'),
        downloadRoot: path.join(root, 'music'),
    };
    const finalAlbumDir = path.join(config.downloadRoot, 'Album Artist', 'Album Title');
    await fs.mkdir(finalAlbumDir, { recursive: true });
    await fs.writeFile(path.join(finalAlbumDir, 'old.wav'), 'old');

    const fsOps = {
        ...fs,
        async rename(from, to) {
            if (String(from).includes('.Album Title.publishing-')) {
                const error = new Error('publish rename failed');
                error.code = 'EIO';
                throw error;
            }
            return fs.rename(from, to);
        },
    };

    await expect(
        executeAlbumDownload({
            id: 'album1',
            jobId: 'job-rollback',
            config,
            fsOps,
            resolver: resolverFor(albumResult()),
            trackExecutor: successfulTrackExecutor(),
            fetchImpl: coverFetch(),
            publishLock: new InMemoryPublishLock(),
        })
    ).rejects.toMatchObject({ failureCode: 'ALBUM_PUBLISH_FAILED' });

    await expect(fs.readFile(path.join(finalAlbumDir, 'old.wav'), 'utf8')).resolves.toBe('old');
    await expect(fs.stat(path.join(finalAlbumDir, '01 - One.wav'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('cancellation during staging removes staging and never publishes final album', async () => {
    const config = {
        tempRoot: path.join(root, 'tmp'),
        downloadRoot: path.join(root, 'music'),
    };
    const controller = new AbortController();
    const trackExecutor = async ({ id, config: trackConfig }) => {
        const filePath = path.join(trackConfig.downloadRoot, 'Album Artist', 'Album Title', `${id}.wav`);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, 'audio');
        controller.abort();
        return { success: true, finalFile: filePath };
    };

    await expect(
        executeAlbumDownload({
            id: 'album1',
            jobId: 'job-cancel',
            config,
            resolver: resolverFor(albumResult()),
            trackExecutor,
            fetchImpl: coverFetch(),
            publishLock: new InMemoryPublishLock(),
            signal: controller.signal,
        })
    ).rejects.toMatchObject({ name: 'AbortError' });

    await expect(fs.stat(path.join(config.downloadRoot, 'Album Artist', 'Album Title'))).rejects.toMatchObject({
        code: 'ENOENT',
    });
    await expect(fs.stat(path.join(config.tempRoot, 'job-cancel'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(config.downloadRoot, '.monochrome-staging', 'job-cancel'))).rejects.toMatchObject({
        code: 'ENOENT',
    });
});

test('cancellation during publication restores the previous album without a mixed directory', async () => {
    const config = {
        tempRoot: path.join(root, 'tmp'),
        downloadRoot: path.join(root, 'music'),
    };
    const finalAlbumDir = path.join(config.downloadRoot, 'Album Artist', 'Album Title');
    await fs.mkdir(finalAlbumDir, { recursive: true });
    await fs.writeFile(path.join(finalAlbumDir, 'old.wav'), 'old');

    const controller = new AbortController();
    const fsOps = {
        ...fs,
        async rename(from, to) {
            const result = await fs.rename(from, to);
            if (String(to).includes('.Album Title.backup-')) {
                controller.abort();
            }
            return result;
        },
    };

    await expect(
        executeAlbumDownload({
            id: 'album1',
            jobId: 'job-publish-cancel',
            config,
            fsOps,
            resolver: resolverFor(albumResult()),
            trackExecutor: successfulTrackExecutor(),
            fetchImpl: coverFetch(),
            publishLock: new InMemoryPublishLock(),
            signal: controller.signal,
        })
    ).rejects.toMatchObject({ name: 'AbortError' });

    await expect(fs.readFile(path.join(finalAlbumDir, 'old.wav'), 'utf8')).resolves.toBe('old');
    await expect(fs.stat(path.join(finalAlbumDir, '01 - One.wav'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('can skip a complete existing album before staging', async () => {
    const config = {
        tempRoot: path.join(root, 'tmp'),
        downloadRoot: path.join(root, 'music'),
    };
    const finalAlbumDir = path.join(config.downloadRoot, 'Album Artist', 'Album Title');
    await fs.mkdir(finalAlbumDir, { recursive: true });
    await fs.writeFile(path.join(finalAlbumDir, 'one.wav'), 'one');
    await fs.writeFile(path.join(finalAlbumDir, 'two.wav'), 'two');

    let trackExecutorCalled = false;
    const result = await executeAlbumDownload({
        id: 'album1',
        jobId: 'job-skip',
        config,
        resolver: resolverFor(albumResult()),
        trackExecutor: async () => {
            trackExecutorCalled = true;
        },
        fetchImpl: coverFetch(),
        publishLock: new InMemoryPublishLock(),
        skipExistingComplete: true,
    });

    expect(result.action).toBe('skipped-existing-complete');
    expect(trackExecutorCalled).toBe(false);
});
