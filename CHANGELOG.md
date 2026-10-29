# Changelog

## 1.1.0

### Fixed

- **Throttled sends lost callbacks.** Calls to `set()`/`send()` inside the 25ms throttle window now merge into one packet, and every callback is called exactly once. Before, the first callback fired twice and the rest never fired.
- **Out-of-range channels produced invalid packets.** `set(0, 510, [1, 2, 3, 4, 5])` sent a 514-channel packet. Universes (0..32767) and channels (1..512) are now validated and throw `RangeError`.
- **Values wrapped around.** `300` was sent as `44` and `-1` as `255`. Values are now rounded and clamped to 0..255; `NaN` becomes 0.
- **ArtPoll had the wrong protocol version** (`0x200E` instead of `14`).
- **Discovery dropped ports on nodes with more than 4 ports.** Replies for each bind index are now merged per node.
- **Discovery listed ports that don't exist.** Only the first `NumPorts` ports are listed, split by `PortTypes` direction.
- **Short names could include the long name** when the 18-byte field had no null terminator.
- **Discovery could miss replies or crash the process.** It now uses the main socket when that already owns port 6454, shares one listener between concurrent calls, rejects (instead of throwing an unhandled `error`) when port 6454 is taken, and no longer shares result state between calls.
- **`close()` twice, or `set()` after `close()`, threw `ERR_SOCKET_DGRAM_NOT_RUNNING`.** `close()` is now idempotent; calls after close report an error through the callback (`set()`/`trigger()` return `false`). Queued callbacks are failed on close so nothing hangs.
- **Send errors without a callback crashed apps with no `error` listener.** They are now emitted only when someone is listening.
- **Switching to a broadcast host with `setHost()` failed with `EACCES`.** Broadcast is enabled on every bind.
- **`interface` was ignored unless `host` was `255.255.255.255`.**
- `send(universe, callback)` is now allowed by the TypeScript signature.

### Changed

- **Default `refresh` is now 1000ms** (was 4000ms, which is at the edge of some nodes' hold timeout). Keep-alive now only re-sends universes that have been idle for `refresh` ms, instead of firing on a fixed interval. `refresh: 0` disables it.
- `portCount` is capped at 4 per reply, as the spec defines (it previously read the reserved high byte too). For merged nodes it is the total across bind indexes.
- `ArtNetNodeInfo.universe` falls back to the first output universe when the node has no inputs.
- `exports` uses a `default` condition with `types`, instead of `import` plus a `require` entry pointing at an ES module. Node.js 20+ is required (`engines`).

### Added

- Exported types: `ArtnetConfig`, `ArtNetNodeInfo`, `ArtnetCallback`, `DiscoveredNode`, `DiscoverOptions`.
- Exported `parseArtPollReply()` and `ARTNET_PORT`.
- `unref` option so timers don't keep the process alive.
- `discoverNodes(timeout, { address })` to choose where the poll is sent.
- Test suite (`npm test`), `lint` and `typecheck` scripts, GitHub Actions CI on Node 20/22/24. `prepublishOnly` now runs lint, typecheck and tests before building.
