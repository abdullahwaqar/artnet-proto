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
- Matches **Art‑Net 4** specification for byte‑perfect packet structure

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

## References

- [Art‑Net 4 Protocol Specification (PDF)](https://art-net.org.uk/downloads/art-net.pdf)
- [DMX512-A standard overview](https://tsp.esta.org/tsp/documents/published_docs.php)
