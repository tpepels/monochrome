# Server Downloads

This module owns only server-side download execution: queue state, server download resolution adapters, temp-first writes, validation, metadata finalization, album publication, and maintenance cleanup.

The intended coupling boundary is:

- Monochrome core remains responsible for catalog/search/provider behavior.
- `monochrome-runtime.js` is the only server-side runtime bridge into Monochrome's existing `LosslessAPI` resolver/download flow.
- `MonochromeResolverFacade` normalizes upstream `LosslessAPI` results into the server-download output shape.
- `ServerResolverAdapter` is a thin wrapper around that facade.
- The rest of `server/downloads/` depends on the adapter interface, not on Monochrome catalog/search internals.
- Frontend integration is limited to the download queue calls and the Downloads settings/status panel.

When upstream Monochrome changes provider discovery or stream resolution, the server should keep delegating to the upstream API surface and only adjust `MonochromeResolverFacade` if the upstream method contract changes.

Server downloads default to static Monochrome-compatible resolver instances instead of uptime-worker discovery. Set `DOWNLOAD_INSTANCE_DISCOVERY=true` to use upstream dynamic discovery from the server runtime.
