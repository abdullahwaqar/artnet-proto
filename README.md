# artnet-proto

A modern **TypeScript** implementation of the [Art‑Net v4 protocol](https://art-net.org.uk/downloads/art-net.pdf) for DMX‑over‑IP communication.

This library lets you send DMX512 channel data over a network to compatible lighting controllers and fixtures using Art‑Net.

[![npm](https://img.shields.io/npm/v/artnet-proto.svg)](https://www.npmjs.com/package/artnet-proto)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/abdullahwaqar/artnet-proto/blob/master/LICENSE)

---

## Features

- Fully written in **TypeScript**, with exported types
- Supports all 32,768 universes (15-bit Port-Address)
- Built-in send throttling (25ms per universe) and idle keep-alive refresh
- Broadcast or unicast output
- `trigger()` support for ArtTrigger packets
- **Discovery** of **Art-Net nodes** via **ArtPoll/ArtPollReply**
  (parses `shortName`, `longName`, `nodeIp`, `portCount`, `universesIn`, `universesOut`, merges multi-bind-index nodes)
- Byte-exact ArtDmx, ArtTrigger and ArtPoll packets per the **Art‑Net 4** specification
- Input validation: bad universes and channels throw, values are clamped to 0..255

> [!note]
> Discovery returns **nodes** (controllers/gateways), **not** individual DMX fixtures behind them. RDM is not implemented.

---

## Installation

```bash
npm install artnet-proto
```

Requires Node.js 20 or newer. The package is ESM; on Node.js 20.19+ / 22.12+ it can also be loaded with `require()`.

---

## Basic Usage

```typescript
import { Artnet } from "artnet-proto";

// Create an Art-Net instance
const artnet = new Artnet({
  host: "255.255.255.255", // broadcast by default
  port: 6454,
  refresh: 1000,
  sendAll: false,
});

// Always handle errors: Node.js throws on an unhandled "error" event
artnet.on("error", (err) => console.error("Art-Net error:", err));

// Set single DMX channel
artnet.set(0, 1, 255); // Universe 0, Channel 1, Value 255

// Set multiple channels at once (RGB full red)
artnet.set(0, 1, [255, 0, 0]); // channels 1=R, 2=G, 3=B

// Close when done
setTimeout(() => artnet.close(), 5000);
```

> [!tip]
> Universes are **0-based** in Art-Net. Many consoles and node web UIs show them starting at 1, so "Universe 1" in a UI is often `0` here. Channels are 1-based (1..512).

## Discovery (ArtPoll / ArtPollReply)

```typescript
import { Artnet } from "artnet-proto";

const artnet = new Artnet({ host: "255.255.255.255" });
artnet.on("error", console.error);

const nodes = await artnet.discoverNodes(1500);

for (const n of nodes) {
  console.log(
    `${n.info.shortName} @ ${n.ip} | ports=${n.info.portCount} ` +
      `outs=[${n.info.universesOut.join(", ")}]`,
  );
}

// Optional: switch to unicast → first node
if (nodes[0]) artnet.setHost(nodes[0].ip);
```

---

## API Reference

### `new Artnet(config?: ArtnetConfig)`

Creates a new Art‑Net sender instance.

**`ArtnetConfig` options:**
| Key | Type | Default | Description |
|------------|-----------|----------------------|-------------|
| `host` | string | `255.255.255.255` | Target IP or broadcast address |
| `port` | number | `6454` | UDP port to send on |
| `refresh` | number | `1000` | Keep-alive: a universe idle for this many ms is re-sent in full. `0` disables it |
| `sendAll` | boolean | `false` | Always send all 512 channels |
| `interface`| string | `undefined` | Local IPv4 address to bind to (e.g. `"2.0.0.1"`) |
| `unref` | boolean | `false` | Don't let internal timers keep the process alive |

> [!note]
> When you set `interface`, use that network's directed broadcast address as `host` (for example `2.255.255.255`). On Linux, packets to `255.255.255.255` follow the default route, not the bound interface.

---

### `.set(...)`

Set DMX channel(s) in a universe and send.
Supports multiple overloads:

```typescript
set(universe: number, channel: number, value: number, callback?: ArtnetCallback)
set(universe: number, channel: number, values: number[], callback?: ArtnetCallback)
set(channel: number, value: number, callback?: ArtnetCallback)   // universe 0
set(channel: number, values: number[], callback?: ArtnetCallback)
set(value: number, callback?: ArtnetCallback)                    // universe 0, channel 1
set(values: number[], callback?: ArtnetCallback)
```

- Throws `RangeError` if the universe isn't 0..32767, the channel isn't 1..512, or an array runs past channel 512.
- Values are rounded and clamped to 0..255 (`NaN` becomes 0). Non-number entries in an array leave that channel unchanged.
- Setting a single channel to the value it already has doesn't send anything; the callback is called with `bytes` undefined.
- Returns `false` and calls back with an error if the instance is closed.

---

### `.send(universe, refresh?, callback?)` / `.send(universe, callback?)`

Manually send an ArtDmx packet for a universe. `refresh: true` sends all 512 channels.

Sends are throttled to one packet per universe every 25ms. Calls made inside that window are merged into a single packet with the latest data, and **every** callback is called once with that packet's result.

---

### `.trigger(...)`

Send an **ArtTrigger** packet (per spec p.40).

```typescript
trigger(oem: number, subKey: number, key: number, callback?: ArtnetCallback)
trigger(subKey: number, key: number, callback?: ArtnetCallback) // OEM 0xFFFF
trigger(key: number, callback?: ArtnetCallback)                 // OEM 0xFFFF, subKey 0
```

`oem` must be 0..0xFFFF, `key` and `subKey` 0..255.

---

### `.discoverNodes(timeoutMs = 2000, options?): Promise<DiscoveredNode[]>`

Broadcasts ArtPoll, collects ArtPollReply for `timeoutMs`, and returns one entry per node IP.

- Nodes with more than 4 ports reply once per bind index; those replies are merged, so `universesIn`/`universesOut` list every port.
- Only ports the node reports (`NumPorts`) are listed, split by direction using `PortTypes`. Ports with empty `PortTypes` are listed in both.
- `options.address` sets where the poll goes. It defaults to `host` when that is a broadcast address, otherwise `255.255.255.255`.
- Safe to call concurrently. Rejects if the instance is closed, port 6454 can't be bound, or the poll can't be sent.

```typescript
interface DiscoveredNode {
  ip: string;
  port: number;
  info: ArtNetNodeInfo;
}

interface ArtNetNodeInfo {
  shortName: string;
  longName: string;
  nodeIp: string;
  portCount: number;
  universe: number; // first input universe, else first output
  universesIn: number[];
  universesOut: number[];
}
```

`parseArtPollReply(buffer)` is also exported if you receive ArtPollReply packets yourself.

---

### `.setHost(host: string): void`

Change the destination IP (e.g., switch between unicast and broadcast).

---

### `.setPort(port: number): void`

Change UDP port (not allowed when `host` is global broadcast).

---

### `.close()`

Stop all timers and close the UDP socket. Safe to call more than once. Queued sends are called back with an error, and running discoveries resolve with what they found so far.

---

### Events

| Event | Payload | When |
|---------|---------|------|
| `error` | `Error` | Socket errors (e.g. failed bind), and send errors that have no callback to report to |

---

## Examples

- [`examples/artnet-demo.ts`](examples/artnet-demo.ts): sends full universes 0..7 at 25fps (`npm run dev`)
- [`examples/send-all.ts`](examples/send-all.ts): discovers nodes, then sends a sliding colour pattern to their output universes (`npm run demo:discover`)

---

## Development

```bash
npm run build      # compile to lib/
npm test           # run the test suite (uses UDP on 127.0.0.1 and port 6454)
npm run lint       # biome
npm run typecheck  # src, tests and examples
```

---

## License

See [LICENSE](LICENSE) for details.

---

## Notes / Limits

- Discovery returns **nodes**, not fixtures (no RDM).

- Ensure your node's DMX output ports are mapped to the universes you're sending.

- Some fixtures need a **master dimmer** channel ≥ 1 in addition to RGB.

- UDP has no delivery guarantee; if no error is reported, the frame was handed to the OS.

---

## References

- [Art‑Net 4 Protocol Specification (PDF)](https://art-net.org.uk/downloads/art-net.pdf)
- [DMX512-A standard overview](https://tsp.esta.org/tsp/documents/published_docs.php)
