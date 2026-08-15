import { describe, expect, test } from 'vitest';
import { canUseUnifiedTurnstile, getLocalHiFiProxyUrl, getProxyUrl, isTidalAudioUrl } from '../proxy-utils.js';

describe('proxy-utils', () => {
    test('returns original TIDAL audio segment URLs directly without audio proxying', () => {
        const url = 'https://sp-pr-fa.audio.tidal.com/mediatracks/abc/1.mp4?token=a/b+c==';

        expect(isTidalAudioUrl(url)).toBe(false);
        expect(getProxyUrl(url)).toBe(url);
    });

    test('does not proxy non-audio TIDAL endpoints or non-TIDAL audio URLs', () => {
        expect(getProxyUrl('https://api.tidal.com/v1/tracks/1')).toBe('https://api.tidal.com/v1/tracks/1');
        expect(getProxyUrl('https://resources.tidal.com/images/cover.jpg')).toBe(
            'https://resources.tidal.com/images/cover.jpg'
        );
        expect(getProxyUrl('https://cdn.example.com/audio/1.mp4')).toBe('https://cdn.example.com/audio/1.mp4');
    });

    test('only enables the bundled Turnstile site key on official hostnames', () => {
        expect(canUseUnifiedTurnstile({ hostname: 'monochrome.tf' })).toBe(true);
        expect(canUseUnifiedTurnstile({ hostname: 'www.monochrome.tf' })).toBe(true);
        expect(canUseUnifiedTurnstile({ hostname: '192.168.1.200' })).toBe(false);
        expect(canUseUnifiedTurnstile({ hostname: 'localhost' })).toBe(false);
    });

    test('routes cross-origin HiFi requests through self-hosted deployments', () => {
        const locationLike = { hostname: '192.168.1.200', origin: 'http://192.168.1.200:5001' };
        const target = 'https://eu-central.monochrome.tf/search/?v=Bob%20Dylan';

        expect(getLocalHiFiProxyUrl(target, locationLike)).toBe(`/api/hifi-proxy?url=${encodeURIComponent(target)}`);
        expect(getLocalHiFiProxyUrl(target, { hostname: 'monochrome.tf', origin: 'https://monochrome.tf' })).toBe(null);
    });
});
