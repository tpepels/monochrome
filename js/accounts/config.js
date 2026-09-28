// js/accounts/config.js
import { createAuthClient } from 'better-auth/client';

function isOfficialHostname(hostname) {
    return (
        hostname === 'monochrome.st' ||
        hostname.endsWith('.monochrome.st') ||
        hostname === 'monochrome.tf' ||
        hostname.endsWith('.monochrome.tf')
    );
}

const configuredAuthUrl = () => {
    const local = localStorage.getItem('monochrome-auth-url');
    if (local) return local;
    if (window.__AUTH_URL__) return window.__AUTH_URL__;
    return '';
};

export const AUTH_ENABLED = Boolean(configuredAuthUrl() || isOfficialHostname(window.location.hostname));

export const AUTH_BASE_URL = configuredAuthUrl() || 'https://auth.monochrome.st';

export const authClient = createAuthClient({
    baseURL: AUTH_BASE_URL,
});

export { authClient as auth };
