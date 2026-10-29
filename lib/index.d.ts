import { EventEmitter } from "node:events";
/** Standard Art-Net UDP port. */
export declare const ARTNET_PORT = 6454;
export interface ArtnetConfig {
    /** Destination IP. Default `255.255.255.255` (broadcast). */
    host?: string;
    /** Destination (and bind) UDP port. Default `6454`. */
    port?: number;
    /**
     * Keep-alive interval in ms. A universe that has not been sent for this
     * long is re-sent in full. `0` disables keep-alive. Default `1000`.
     */
    refresh?: number;
    /** Always send all 512 channels. Default `false`. */
    sendAll?: boolean;
    /**
     * Local IPv4 address to bind to (for example `"2.0.0.1"`). With this set,
     * prefer the interface's directed broadcast address as `host`
     * (for example `"2.255.255.255"`): on Linux, `255.255.255.255` is routed
     * by the default route, not by the bound address.
     */
    interface?: string;
    /**
     * If `true`, internal timers (keep-alive, throttle) do not keep the
     * Node.js process alive. Default `false`.
     */
    unref?: boolean;
    /**
     * Fill the ArtDmx Sequence field (1..255 per universe) so nodes can drop
     * packets that arrive out of order. `false` sends 0, which disables the
     * feature on the node. Default `true`.
     */
    sequence?: boolean;
    /**
     * Where ArtSync packets go. ArtSync must be broadcast, never unicast, so
     * this defaults to `host` when that is a broadcast address, otherwise
     * `255.255.255.255`. Set it to your network's directed broadcast
     * (for example `"2.255.255.255"`) when sending DMX by unicast.
     */
    syncAddress?: string;
}
export interface CommitOptions {
    /**
     * Send an ArtSync after the universes, so nodes output them all at the
     * same moment. Default `true`.
     */
    sync?: boolean;
    /**
     * Universes to send. Defaults to every universe with staged changes.
     * Listed universes are sent even if nothing changed.
     */
    universes?: number[];
}
/**
 * Represents a discovered Art-Net node (device, which may be a fixture, gateway, or controller).
 */
export interface ArtNetNodeInfo {
    shortName: string;
    longName: string;
    nodeIp: string;
    /** Number of ports reported by the node (across all bind indexes when merged). */
    portCount: number;
    /**
     * First input universe, or the first output universe if the node has no
     * inputs. Full 15-bit Port-Address (Net<<8 | Sub<<4 | Chan).
     */
    universe: number;
    /** Universes of the node's input-capable ports. */
    universesIn: number[];
    /** Universes of the node's output-capable ports. */
    universesOut: number[];
}
export interface DiscoveredNode {
    ip: string;
    port: number;
    info: ArtNetNodeInfo;
}
export interface DiscoverOptions {
    /**
     * Where to send the ArtPoll. Defaults to `host` when it is a broadcast
     * address, otherwise `255.255.255.255`.
     */
    address?: string;
}
export type ArtnetCallback = (error: Error | null, bytes?: number) => void;
/**
 * Extracts important information from an ArtPollReply UDP packet.
 *
 * Offsets (bytes):
 * -  0..7   : "Art-Net\0"
 * -  8..9   : OpCode (reply == 0x2100, little-endian)
 * - 10..13  : Node IP address
 * - 18      : NetSwitch (7 bits used, 0..127)
 * - 19      : SubSwitch (low nibble used, 0..15)
 * - 26..43  : ShortName (18 bytes, null-terminated ASCII)
 * - 44..107 : LongName (64 bytes, null-terminated ASCII)
 * - 172..173: NumPorts (Hi reserved, Lo = 0..4)
 * - 174..177: PortTypes[0..3] (bit 7 = can output, bit 6 = can input)
 * - 186..189: SwIn[0..3]  (low nibble == input universe/channel 0..15)
 * - 190..193: SwOut[0..3] (low nibble == output universe/channel 0..15)
 * - 211     : BindIndex
 *
 * Universe number (15-bit) is composed as:
 *   universe = (NetSwitch << 8) | (SubSwitch << 4) | (PortNibble)
 *
 * Only the first NumPorts ports are listed. A port whose PortTypes byte sets
 * neither the input nor the output bit is listed as both, since some cheap
 * nodes leave PortTypes empty.
 */
export declare function parseArtPollReply(msg: Buffer): ArtNetNodeInfo;
/**
 * Implements the Art-Net v4 protocol for DMX-over-IP communication.
 * Reference: https://art-net.org.uk/downloads/art-net.pdf
 *
 * Emits `error` for socket errors (for example a failed bind) and for send
 * errors that have no callback to report to. Attach an `error` listener:
 * Node.js throws on an unhandled `error` event.
 */
export declare class Artnet extends EventEmitter {
    private host;
    private port;
    private refresh;
    private sendAll;
    private unref;
    private socket;
    private closed;
    private bindReady;
    private useSequence;
    private syncAddress;
    private lastSyncAt;
    private data;
    private dataChanged;
    private refreshTimers;
    private throttleTimers;
    private pendingSends;
    private sequences;
    /** What nodes last received per universe, used for keep-alive. */
    private sentData;
    private discoveryHandlers;
    private activeDiscoveries;
    private discoverySocket;
    private discoverySocketUsers;
    constructor(config?: ArtnetConfig);
    private bindSocket;
    private timer;
    private closedError;
    /**
     * Send a buffer and report the result to every callback. With no
     * callbacks, a send error is emitted as `error` only if someone listens,
     * so a transient network error can't crash the process.
     */
    private transmit;
    /**
     * Send an Art-Net trigger packet.
     * Reference: Art-Net 4 Spec, p40
     */
    sendTrigger(oem: number, key: number, subKey: number, callback?: ArtnetCallback): void;
    private triggerPackage;
    /** Re-send a universe in full after `refresh` ms of inactivity. */
    private scheduleRefresh;
    /**
     * Send DMX data as ArtDmx packet.
     * Reference: Art-Net 4 Spec, p45 (ArtDmx Packet Definition)
     *
     * Sends are throttled to one packet per universe every 25ms. Calls made
     * inside that window are merged into one packet, and every callback is
     * called once with that packet's result.
     */
    send(universe: number, callback?: ArtnetCallback): void;
    send(universe: number, refresh?: boolean, callback?: ArtnetCallback): void;
    private flush;
    /** Build and send one universe now, bypassing the throttle. */
    private transmitUniverse;
    /**
     * Keep-alive: re-send what nodes last received, in full. Staged changes
     * that haven't been committed are not included.
     */
    private sendRefresh;
    /** Next ArtDmx sequence number for a universe: 1..255, wrapping. 0 if disabled. */
    private nextSequence;
    /** True while nodes are likely still in synchronous mode from our last ArtSync. */
    private syncModeActive;
    private syncTarget;
    private transmitSync;
    /**
     * Send an ArtSync now. Nodes that support it output all ArtDmx received
     * since the previous ArtSync at the same moment.
     * Reference: Art-Net 4 Spec, ArtSync
     */
    sync(callback?: ArtnetCallback): void;
    /**
     * Write channel values without sending them. Send them with `commit()`.
     * Same validation and clamping as `set()`.
     * Returns `false` if the instance is closed.
     * @example
     * artnet.stage(0, 1, [255, 0, 0]);
     * artnet.stage(1, 1, [0, 0, 255]);
     * await artnet.commit(); // both universes, then ArtSync
     */
    stage(universe: number, channel: number, value: number | number[]): boolean;
    /**
     * Send staged universes immediately (bypassing the 25ms throttle), then
     * an ArtSync so nodes output them all at once.
     *
     * Any send queued by `set()` for the same universes is folded into this
     * one, and its callbacks get this packet's result. Resolves when every
     * packet has been handed to the OS; rejects with the first send error.
     * Resolves without sending anything if there is nothing to send.
     */
    commit(options?: CommitOptions): Promise<void>;
    private universeData;
    private artdmxPackage;
    /**
     * Write values into a universe buffer. Returns the universe's highest
     * changed channel since its last send (0 if nothing changed).
     */
    private write;
    set(universe: number, channel: number, value: number, callback?: ArtnetCallback): boolean;
    set(universe: number, channel: number, values: number[], callback?: ArtnetCallback): boolean;
    set(channel: number, value: number, callback?: ArtnetCallback): boolean;
    set(channel: number, values: number[], callback?: ArtnetCallback): boolean;
    set(value: number, callback?: ArtnetCallback): boolean;
    set(values: number[], callback?: ArtnetCallback): boolean;
    trigger(oem: number, subKey: number, key: number, callback?: ArtnetCallback): boolean;
    trigger(subKey: number, key: number, callback?: ArtnetCallback): boolean;
    trigger(key: number, callback?: ArtnetCallback): boolean;
    private dispatchMessage;
    /** Main socket bound on the Art-Net port, plus the address it is bound to. */
    private mainDiscoveryBinding;
    /**
     * Discovers all Art-Net nodes (devices) present on the local network.
     *
     * Broadcasts an ArtPoll message and collects all ArtPollReply responses for the timeout period.
     * Each discovered node provides IP address, short name, universes, and port info.
     * Nodes with more than 4 ports answer once per bind index; those replies
     * are merged into one entry per IP.
     *
     * Safe to call concurrently. Rejects if the instance is closed, the
     * listening socket can't be bound, or the poll can't be sent. Closing the
     * instance resolves pending discoveries with what they have so far.
     *
     * @param timeout How long to wait for replies, in milliseconds (default: 2000ms).
     * @returns Promise resolving with an array of discovered nodes.
     */
    discoverNodes(timeout?: number, options?: DiscoverOptions): Promise<DiscoveredNode[]>;
    /**
     * Shared 0.0.0.0:6454 listener for discoveries, so concurrent calls don't
     * each open a socket (unicast replies would reach only one of them).
     * Reference-counted; closed when the last discovery releases it.
     */
    private acquireDiscoverySocket;
    private releaseDiscoverySocket;
    /**
     * Stop all polling/refresh and close the socket. Safe to call more than
     * once. Queued sends are called back with an error.
     */
    close(): void;
    /**
     * Change the Art-Net output host.
     */
    setHost(host: string): void;
    /**
     * Set a new UDP port. (Only allowed when not using broadcast)
     */
    setPort(port: number): void;
}
//# sourceMappingURL=index.d.ts.map