# artnet-proto

A modern **TypeScript** implementation of the [Art‑Net v4 protocol](https://art-net.org.uk/downloads/art-net.pdf) for DMX‑over‑IP communication.

This library lets you send DMX512 channel data over a network to compatible lighting controllers and fixtures using Art‑Net.

[![npm](https://img.shields.io/npm/v/artnet-proto.svg)](https://www.npmjs.com/package/artnet-proto)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/abdullahwaqar/artnet-proto/blob/master/LICENSE)

---

## Features

- Fully written in **TypeScript**
- Supports multiple universes
- Optional throttling and periodic refresh
- Broadcast or unicast output
- `trigger()` support for ArtTrigger packets
- **Discovery** of **Art-Net nodes** via **ArtPoll/ArtPollReply**
  (parses `shortName`, `longName`, `nodeIp`, `portCount`, `universesIn`, `universesOut`)
- Matches **Art‑Net 4** specification for byte‑perfect packet structure

> [!note]
> Discovery returns **nodes** (controllers/gateways), **not** individual DMX fixtures behind them. RDM is not implemented.

---

## Installation

```bash
npm install artnet-proto
```

TypeScript‑based, you get type definitions out‑of‑the‑box.

---

## Basic Usage

```typeScript
import { Artnet } from "artnet-proto";

// Create an Art-Net instance
const artnet = new Artnet({
  host: "255.255.255.255", // broadcast by default
  port: 6454,
  refresh: 4000,
  sendAll: false
});

// Set single DMX channel
artnet.set(0, 1, 255); // Universe 0, Channel 1, Value 255

// Set multiple channels at once (RGB full red)
artnet.set(0, 1, [255, 0, 0]); // channels 1=R, 2=G, 3=B

// Close when done
setTimeout(() => artnet.close(), 5000);
```

## Discovery (ArtPoll / ArtPollReply)

```typescript
import { Artnet } from "artnet-proto";

const artnet = new Artnet(...);
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
| `host` | string | `255.255.255.255` | Target IP or broadcast |
| `port` | number | `6454` | UDP port to send on |
| `refresh` | number | `4000` | Auto‑refresh interval in ms |
| `sendAll` | boolean | `false` | Always send all 512 channels |
| `interface`| string | `undefined` | Network interface to bind |

---

### `.set(...)`

Set DMX channel(s) in a universe and send.
Supports multiple overloads:

```typeScript
set(universe: number, channel: number, value: number, callback?: ArtnetCallback)
set(universe: number, channel: number, values: number[], callback?: ArtnetCallback)
set(channel: number, value: number, callback?: ArtnetCallback)
set(channel: number, values: number[], callback?: ArtnetCallback)
set(value: number, callback?: ArtnetCallback)
set(values: number[], callback?: ArtnetCallback)
```

---

### `.send(universe, refresh?, callback?)`

Manually send ArtDMX packet for a universe.

---

### `.trigger(...)`

Send an **ArtTrigger** packet (per spec p.40).

---

### `.discoverNodes(timeoutMs = 2000): Promise<Array<{ ip, port, info }>>`

Broadcasts ArtPoll, collects ArtPollReply, parses:

```ts
interface ArtNetNodeInfo {
  shortName: string;
  longName: string;
  nodeIp: string;
  portCount: number;
  universe: number; // first input universe for convenience
  universesIn: number[]; // from Net/Sub + SwIn[0..3] low nibble
  universesOut: number[]; // from Net/Sub + SwOut[0..3] low nibble
}
```

---

### `.setHost(host: string): void`

Change the destination IP (e.g., switch to unicast).

---

### `.setPort(port: number): void`

Change UDP port (not allowed when `host` is global broadcast).

---

### `.close()`

Stop all timers and close the UDP socket.

---

## Example: Sending Full Universes at 25fps

Check working demo in [`examples/artnet-demo.ts`](examples/artnet-demo.ts):

---

## Build

Compile TypeScript to `lib/`:

```bash
npm run build
```

Clean build artifacts:

```bash
npm run clean
```

---

## License

See [LICENSE](LICENSE) for details.

---

## Notes / Limits

- Discovery returns **nodes**, not fixtures (no RDM).

- Ensure your node’s DMX output ports are mapped to the universes you’re sending.

- Some fixtures need a **master dimmer** channel ≥ 1 in addition to RGB.

- UDP has no delivery guarantee; if no error is reported, the frame was handed to the OS.

---

## References

- [Art‑Net 4 Protocol Specification (PDF)](https://art-net.org.uk/downloads/art-net.pdf)
- [DMX512-A standard overview](https://tsp.esta.org/tsp/documents/published_docs.php)
