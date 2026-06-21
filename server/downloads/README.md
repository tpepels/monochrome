# Server Downloads

This module owns only server-side download execution: queue state, server download resolution adapters, temp-first writes, validation, metadata finalization, album publication, and maintenance cleanup.

The intended coupling boundary is:

- Monochrome core remains responsible for catalog/search/provider behavior.
- `MonochromeResolverFacade` is the only server-side bridge into Monochrome's existing `LosslessAPI` resolver/download flow.
- `ServerResolverAdapter` is a thin wrapper around that facade and is responsible for the stable server-download output shape.
- The rest of `server/downloads/` depends on the adapter interface, not on Monochrome catalog/search internals.
- Frontend integration is limited to the download queue calls and the Downloads settings/status panel.

When upstream Monochrome changes provider discovery or stream resolution, the server should keep delegating to the upstream API surface and only adjust `MonochromeResolverFacade` if the upstream method contract changes.
