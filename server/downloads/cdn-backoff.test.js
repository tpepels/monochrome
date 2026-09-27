import { beforeEach, expect, test } from 'vitest';
import {
    calculateCdnBackoffDelayMs,
    getCdnBackoffState,
    noteCdnFailure,
    noteCdnSuccess,
    resetCdnBackoffState,
} from './cdn-backoff.js';

beforeEach(() => resetCdnBackoffState());

test('uses exponential backoff with a bounded maximum', () => {
    expect(calculateCdnBackoffDelayMs(1, { baseMs: 5000, maxMs: 300000 })).toBe(5000);
    expect(calculateCdnBackoffDelayMs(2, { baseMs: 5000, maxMs: 300000 })).toBe(10000);
    expect(calculateCdnBackoffDelayMs(3, { baseMs: 5000, maxMs: 300000 })).toBe(20000);
    expect(calculateCdnBackoffDelayMs(7, { baseMs: 5000, maxMs: 300000 })).toBe(300000);
});

test('honors Retry-After when it asks for a longer cooldown', () => {
    expect(
        calculateCdnBackoffDelayMs(2, {
            baseMs: 5000,
            maxMs: 300000,
            retryAfterMs: 60000,
        })
    ).toBe(60000);
});

test('shares failure streak across different URLs on the same CDN origin', () => {
    noteCdnFailure('https://tracks.monochrome.st/track/1', {
        baseMs: 5000,
        maxMs: 300000,
        now: 1000,
    });
    noteCdnFailure('https://tracks.monochrome.st/track/2', {
        baseMs: 5000,
        maxMs: 300000,
        now: 2000,
    });

    expect(getCdnBackoffState('https://tracks.monochrome.st/track/3', 2000)).toMatchObject({
        failureStreak: 2,
        blockedUntil: 12000,
        remainingMs: 10000,
    });
});

test('keeps unrelated origins independent', () => {
    noteCdnFailure('https://tracks.monochrome.st/track/1', {
        baseMs: 5000,
        maxMs: 300000,
        now: 1000,
    });

    expect(getCdnBackoffState('https://example.test/audio', 1000).failureStreak).toBe(0);
});

test('successful transfer resets the origin failure streak', () => {
    noteCdnFailure('https://tracks.monochrome.st/track/1', {
        baseMs: 5000,
        maxMs: 300000,
        now: 1000,
    });

    noteCdnSuccess('https://tracks.monochrome.st/track/2');

    expect(getCdnBackoffState('https://tracks.monochrome.st/track/3', 1000)).toMatchObject({
        failureStreak: 0,
        remainingMs: 0,
    });
});
