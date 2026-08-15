import { proxyHiFiRequest } from '../../server/hifi-proxy.js';

export async function onRequest(context) {
    return proxyHiFiRequest(context.request, { env: context.env });
}
