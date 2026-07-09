// js/accounts/config.js
import { createAuthClient } from 'https://esm.sh/better-auth/client';

const OFFICIAL_AUTH_HOSTS = new Set(['monochrome.tf', 'www.monochrome.tf']);

const getBaseURL = () => {
    const local = localStorage.getItem('monochrome-auth-url');
    if (local) return local;

    if (window.__AUTH_URL__) return window.__AUTH_URL__;

    const hostname = window.location.hostname;
    if (OFFICIAL_AUTH_HOSTS.has(hostname)) {
        return 'https://auth.monochrome.tf';
    }
    return '';
};

export const AUTH_BASE_URL = getBaseURL();
export const AUTH_ENABLED = Boolean(AUTH_BASE_URL);

export const authClient = AUTH_ENABLED
    ? createAuthClient({
          baseURL: AUTH_BASE_URL,
      })
    : null;

export { authClient as auth };
