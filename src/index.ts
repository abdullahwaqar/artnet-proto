import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { EventEmitter } from "node:events";

/** Standard Art-Net UDP port. */
export const ARTNET_PORT = 6454;

const ARTNET_ID = Buffer.from("Art-Net\0", "ascii");
const PROTOCOL_VERSION = 14;
const OP_POLL = 0x2000;
const OP_POLL_REPLY = 0x2100;
const OP_DMX = 0x5000;
const OP_TRIGGER = 0x9900;
const OP_SYNC = 0x5200;

const GLOBAL_BROADCAST = "255.255.255.255";
const DMX_CHANNELS = 512;
const MAX_UNIVERSE = 0x7fff;
const THROTTLE_MS = 25;
/** Nodes leave synchronous mode after this long without an ArtSync. */
const SYNC_TIMEOUT_MS = 4000;
const CLOSED_MESSAGE = "Artnet instance is closed";

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

type MessageHandler = (msg: Buffer, rinfo: RemoteInfo) => void;

interface PendingSend {
    refresh: boolean;
    callbacks: ArtnetCallback[];
}

function isBroadcastAddress(host: string): boolean {
    return host === GLOBAL_BROADCAST || host.endsWith(".255");
}

function assertUniverse(universe: number): void {
    if (
        !Number.isInteger(universe) ||
        universe < 0 ||
        universe > MAX_UNIVERSE
    ) {
        throw new RangeError(
            `universe must be an integer from 0 to ${MAX_UNIVERSE}, got ${universe}`,
        );
    }
}

function assertChannel(channel: number): void {
    if (!Number.isInteger(channel) || channel < 1 || channel > DMX_CHANNELS) {
        throw new RangeError(
            `channel must be an integer from 1 to ${DMX_CHANNELS}, got ${channel}`,
        );
    }
}

function assertByteRange(name: string, value: number, max: number): void {
    if (!Number.isInteger(value) || value < 0 || value > max) {
        throw new RangeError(
            `${name} must be an integer from 0 to ${max}, got ${value}`,
        );
    }
}

/** Clamp any number to a valid DMX value (0..255, rounded). NaN becomes 0. */
function toDmxValue(value: number): number {
    if (Number.isNaN(value)) {
        return 0;
    }
    return Math.min(255, Math.max(0, Math.round(value)));
}

function isArtNetPacket(msg: Buffer, opcode: number): boolean {
    return (
        msg.length >= 10 &&
        msg.subarray(0, 8).equals(ARTNET_ID) &&
        msg.readUInt16LE(8) === opcode
    );
}

/** BindIndex (byte 211). 0 and 1 both mean the root device. */
function readBindIndex(msg: Buffer): number {
    const value = msg.length > 211 ? msg[211] : 0;
    return value === 0 ? 1 : value;
}

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
export function parseArtPollReply(msg: Buffer): ArtNetNodeInfo {
    const getString = (start: number, length: number): string => {
        if (msg.length <= start) {
            return "";
        }
        const limit = Math.min(start + length, msg.length);
        let end = msg.indexOf(0, start);
        if (end === -1 || end > limit) {
            end = limit;
        }
        // Strip control and non-ASCII bytes (common garbage on cheap nodes)
        return (
            msg
                .subarray(start, end)
                .toString("latin1")
                // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes is the point
                .replace(/[\x00-\x1F\x7F-\xFF]/g, "")
                .trim()
        );
    };

    const nodeIp =
        msg.length >= 14
            ? `${msg[10]}.${msg[11]}.${msg[12]}.${msg[13]}`
            : "0.0.0.0";

    const net = msg.length > 18 ? msg[18] & 0x7f : 0;
    const sub = msg.length > 19 ? msg[19] & 0x0f : 0;
    const compose = (nibble: number) =>
        (net << 8) | (sub << 4) | (nibble & 0x0f);

    const portCount = msg.length > 173 ? Math.min(4, msg[173]) : 0;

    const universesIn: number[] = [];
    const universesOut: number[] = [];
    for (let i = 0; i < portCount; i++) {
        const type = msg.length > 174 + i ? msg[174 + i] : 0;
        const known = (type & 0xc0) !== 0;
        const canOutput = !known || (type & 0x80) !== 0;
        const canInput = !known || (type & 0x40) !== 0;

        if (canInput && msg.length > 186 + i) {
            universesIn.push(compose(msg[186 + i]));
        }
        if (canOutput && msg.length > 190 + i) {
            universesOut.push(compose(msg[190 + i]));
        }
    }

    return {
        shortName: getString(26, 18),
        longName: getString(44, 64),
        nodeIp,
        portCount,
        universe: universesIn[0] ?? universesOut[0] ?? compose(0),
        universesIn,
        universesOut,
    };
}

/**
 * Implements the Art-Net v4 protocol for DMX-over-IP communication.
 * Reference: https://art-net.org.uk/downloads/art-net.pdf
 *
 * Emits `error` for socket errors (for example a failed bind) and for send
 * errors that have no callback to report to. Attach an `error` listener:
 * Node.js throws on an unhandled `error` event.
 */
export class Artnet extends EventEmitter {
    private host: string;
    private port: number;
    private refresh: number;
    private sendAll: boolean;
    private unref: boolean;
    private socket: Socket;
    private closed = false;
    private bindReady: Promise<boolean> | null = null;
    private useSequence: boolean;
    private syncAddress: string | undefined;
    private lastSyncAt = 0;

    private data = new Map<number, Uint8Array>();
    private dataChanged = new Map<number, number>();
    private refreshTimers = new Map<number, NodeJS.Timeout>();
    private throttleTimers = new Map<number, NodeJS.Timeout>();
    private pendingSends = new Map<number, PendingSend>();
    private sequences = new Map<number, number>();
    /** What nodes last received per universe, used for keep-alive. */
    private sentData = new Map<number, Uint8Array>();

    private discoveryHandlers = new Set<MessageHandler>();
    private activeDiscoveries = new Set<() => void>();
    private discoverySocket: Promise<Socket> | null = null;
    private discoverySocketUsers = 0;

    constructor(config: ArtnetConfig = {}) {
        super();
        this.host = config.host ?? GLOBAL_BROADCAST;
        this.port = config.port ?? ARTNET_PORT;
        this.refresh = config.refresh ?? 1000;
        this.sendAll = config.sendAll ?? false;
        this.unref = config.unref ?? false;
        this.useSequence = config.sequence ?? true;
        this.syncAddress = config.syncAddress;

        this.socket = createSocket({ type: "udp4", reuseAddr: true });

        this.socket.on("error", (err) => {
            this.emit("error", err);
        });

        // Enable broadcast on every bind (explicit or implicit), so switching
        // to a broadcast host later with setHost() works.
        this.socket.on("listening", () => {
            try {
                this.socket.setBroadcast(true);
            } catch {
                // Socket closed between bind and this handler
            }
        });

        this.socket.on("message", (msg, rinfo) => {
            this.dispatchMessage(msg, rinfo);
        });

        if (config.interface) {
            this.bindReady = this.bindSocket(this.port, config.interface);
        } else if (isBroadcastAddress(this.host)) {
            this.bindReady = this.bindSocket(this.port);
        }
    }

    private bindSocket(port: number, address?: string): Promise<boolean> {
        return new Promise((resolve) => {
            const onListening = () => {
                this.socket.off("error", onError);
                resolve(true);
            };
            const onError = () => {
                this.socket.off("listening", onListening);
                resolve(false);
            };
            this.socket.once("listening", onListening);
            this.socket.once("error", onError);
            this.socket.bind(port, address);
        });
    }

    private timer(timeout: NodeJS.Timeout): NodeJS.Timeout {
        if (this.unref) {
            timeout.unref();
        }
        return timeout;
    }

    private closedError(): Error {
        return new Error(CLOSED_MESSAGE);
    }

    /**
     * Send a buffer and report the result to every callback. With no
     * callbacks, a send error is emitted as `error` only if someone listens,
     * so a transient network error can't crash the process.
     */
    private transmit(
        socket: Socket,
        buf: Buffer,
        port: number,
        address: string,
        callbacks: ArtnetCallback[],
    ): void {
        const report = (err: Error | null, bytes?: number) => {
            if (callbacks.length === 0) {
                if (err && this.listenerCount("error") > 0) {
                    this.emit("error", err);
                }
                return;
            }
            for (const cb of callbacks) {
                cb(err, err ? undefined : (bytes ?? buf.length));
            }
        };

        try {
            socket.send(buf, 0, buf.length, port, address, (err, bytes) => {
                report(err ?? null, bytes);
            });
        } catch (err) {
            process.nextTick(() => report(err as Error));
        }
    }

    /**
     * Send an Art-Net trigger packet.
     * Reference: Art-Net 4 Spec, p40
     */
    public sendTrigger(
        oem: number,
        key: number,
        subKey: number,
        callback?: ArtnetCallback,
    ): void {
        assertByteRange("oem", oem, 0xffff);
        assertByteRange("key", key, 0xff);
        assertByteRange("subKey", subKey, 0xff);

        if (this.closed) {
            callback?.(this.closedError());
            return;
        }

        const buf = this.triggerPackage(oem, key, subKey);
        this.transmit(
            this.socket,
            buf,
            this.port,
            this.host,
            callback ? [callback] : [],
        );
    }

    private triggerPackage(oem: number, key: number, subKey: number): Buffer {
        // Art-Net 4, p40: ID, OpCode, ProtVer, Filler1, Filler2, OemHi, OemLo, Key, SubKey, Data[512]
        const buf = Buffer.alloc(18 + DMX_CHANNELS);
        ARTNET_ID.copy(buf, 0);
        buf.writeUInt16LE(OP_TRIGGER, 8);
        buf.writeUInt16BE(PROTOCOL_VERSION, 10);
        buf.writeUInt16BE(oem, 14);
        buf[16] = key;
        buf[17] = subKey;
        return buf;
    }

    /** Re-send a universe in full after `refresh` ms of inactivity. */
    private scheduleRefresh(universe: number): void {
        const existing = this.refreshTimers.get(universe);
        if (existing) {
            clearTimeout(existing);
        }
        if (this.refresh <= 0) {
            this.refreshTimers.delete(universe);
            return;
        }
        this.refreshTimers.set(
            universe,
            this.timer(
                setTimeout(() => {
                    this.refreshTimers.delete(universe);
                    if (!this.closed) {
                        this.sendRefresh(universe);
                    }
                }, this.refresh),
            ),
        );
    }

    /**
     * Send DMX data as ArtDmx packet.
     * Reference: Art-Net 4 Spec, p45 (ArtDmx Packet Definition)
     *
     * Sends are throttled to one packet per universe every 25ms. Calls made
     * inside that window are merged into one packet, and every callback is
     * called once with that packet's result.
     */
    public send(universe: number, callback?: ArtnetCallback): void;
    public send(
        universe: number,
        refresh?: boolean,
        callback?: ArtnetCallback,
    ): void;
    public send(
        universe: number,
        refreshOrCallback?: boolean | ArtnetCallback,
        callback?: ArtnetCallback,
    ): void {
        let refresh = false;
        if (typeof refreshOrCallback === "function") {
            callback = refreshOrCallback;
        } else {
            refresh = Boolean(refreshOrCallback);
        }

        assertUniverse(universe);

        if (this.closed) {
            callback?.(this.closedError());
            return;
        }

        if (this.sendAll) {
            refresh = true;
        }

        // Inside the throttle window: queue and merge with the pending send
        if (this.throttleTimers.has(universe)) {
            const pending = this.pendingSends.get(universe) ?? {
                refresh: false,
                callbacks: [],
            };
            pending.refresh ||= refresh;
            if (callback) {
                pending.callbacks.push(callback);
            }
            this.pendingSends.set(universe, pending);
            return;
        }

        this.flush(universe, refresh, callback ? [callback] : []);
    }

    private flush(
        universe: number,
        refresh: boolean,
        callbacks: ArtnetCallback[],
    ): void {
        this.throttleTimers.set(
            universe,
            this.timer(
                setTimeout(() => {
                    this.throttleTimers.delete(universe);
                    const pending = this.pendingSends.get(universe);
                    if (pending && !this.closed) {
                        this.pendingSends.delete(universe);
                        this.flush(
                            universe,
                            pending.refresh,
                            pending.callbacks,
                        );
                    }
                }, THROTTLE_MS),
            ),
        );

        this.transmitUniverse(universe, refresh, callbacks);
        // Nodes in synchronous mode hold ArtDmx until the next ArtSync
        if (this.syncModeActive()) {
            this.transmitSync([]);
        }
    }

    /** Build and send one universe now, bypassing the throttle. */
    private transmitUniverse(
        universe: number,
        refresh: boolean,
        callbacks: ArtnetCallback[],
    ): void {
        const changed = this.dataChanged.get(universe) ?? 0;
        // No recorded changes (manual send): send the full universe
        const length = refresh || changed === 0 ? DMX_CHANNELS : changed;
        this.dataChanged.set(universe, 0);

        const data = this.universeData(universe);
        const buf = this.artdmxPackage(universe, length, data);
        this.sentData.set(universe, data.slice());
        this.transmit(this.socket, buf, this.port, this.host, callbacks);
        this.scheduleRefresh(universe);
    }

    /**
     * Keep-alive: re-send what nodes last received, in full. Staged changes
     * that haven't been committed are not included.
     */
    private sendRefresh(universe: number): void {
        const data = this.sentData.get(universe) ?? this.universeData(universe);
        const buf = this.artdmxPackage(universe, DMX_CHANNELS, data);
        this.transmit(this.socket, buf, this.port, this.host, []);
        if (this.syncModeActive()) {
            this.transmitSync([]);
        }
        this.scheduleRefresh(universe);
    }

    /** Next ArtDmx sequence number for a universe: 1..255, wrapping. 0 if disabled. */
    private nextSequence(universe: number): number {
        if (!this.useSequence) {
            return 0;
        }
        const next = ((this.sequences.get(universe) ?? 0) % 255) + 1;
        this.sequences.set(universe, next);
        return next;
    }

    /** True while nodes are likely still in synchronous mode from our last ArtSync. */
    private syncModeActive(): boolean {
        return (
            this.lastSyncAt > 0 &&
            Date.now() - this.lastSyncAt < SYNC_TIMEOUT_MS
        );
    }

    private syncTarget(): string {
        return (
            this.syncAddress ??
            (isBroadcastAddress(this.host) ? this.host : GLOBAL_BROADCAST)
        );
    }

    private transmitSync(callbacks: ArtnetCallback[]): void {
        this.lastSyncAt = Date.now();
        this.transmit(
            this.socket,
            createArtSyncPacket(),
            this.port,
            this.syncTarget(),
            callbacks,
        );
    }

    /**
     * Send an ArtSync now. Nodes that support it output all ArtDmx received
     * since the previous ArtSync at the same moment.
     * Reference: Art-Net 4 Spec, ArtSync
     */
    public sync(callback?: ArtnetCallback): void {
        if (this.closed) {
            callback?.(this.closedError());
            return;
        }
        this.transmitSync(callback ? [callback] : []);
    }

    /**
     * Write channel values without sending them. Send them with `commit()`.
     * Same validation and clamping as `set()`.
     * Returns `false` if the instance is closed.
     * @example
     * artnet.stage(0, 1, [255, 0, 0]);
     * artnet.stage(1, 1, [0, 0, 255]);
     * await artnet.commit(); // both universes, then ArtSync
     */
    public stage(
        universe: number,
        channel: number,
        value: number | number[],
    ): boolean {
        assertUniverse(universe);
        assertChannel(channel);
        if (this.closed) {
            return false;
        }
        this.write(universe, channel, value);
        return true;
    }

    /**
     * Send staged universes immediately (bypassing the 25ms throttle), then
     * an ArtSync so nodes output them all at once.
     *
     * Any send queued by `set()` for the same universes is folded into this
     * one, and its callbacks get this packet's result. Resolves when every
     * packet has been handed to the OS; rejects with the first send error.
     * Resolves without sending anything if there is nothing to send.
     */
    public commit(options: CommitOptions = {}): Promise<void> {
        if (this.closed) {
            return Promise.reject(this.closedError());
        }

        let universes: number[];
        if (options.universes) {
            for (const u of options.universes) {
                assertUniverse(u);
            }
            universes = [...new Set(options.universes)];
        } else {
            universes = [...this.dataChanged.entries()]
                .filter(([, changed]) => changed > 0)
                .map(([u]) => u)
                .sort((a, b) => a - b);
        }

        if (universes.length === 0) {
            return Promise.resolve();
        }

        const sends: Promise<void>[] = [];
        const settle =
            (resolve: () => void, reject: (err: Error) => void) =>
            (err: Error | null) =>
                err ? reject(err) : resolve();

        for (const universe of universes) {
            const pending = this.pendingSends.get(universe);
            this.pendingSends.delete(universe);
            sends.push(
                new Promise<void>((resolve, reject) => {
                    this.transmitUniverse(
                        universe,
                        this.sendAll || (pending?.refresh ?? false),
                        [
                            ...(pending?.callbacks ?? []),
                            settle(resolve, reject),
                        ],
                    );
                }),
            );
        }

        if (options.sync ?? true) {
            sends.push(
                new Promise<void>((resolve, reject) => {
                    this.transmitSync([settle(resolve, reject)]);
                }),
            );
        }

        return Promise.all(sends).then(() => undefined);
    }

    private universeData(universe: number): Uint8Array {
        let data = this.data.get(universe);
        if (!data) {
            data = new Uint8Array(DMX_CHANNELS);
            this.data.set(universe, data);
        }
        return data;
    }

    private artdmxPackage(
        universe: number,
        length: number,
        data: Uint8Array,
    ): Buffer {
        // Length must be even, 2..512 (Art-Net 4, p45)
        if (length % 2) {
            length++;
        }
        length = Math.min(DMX_CHANNELS, Math.max(2, length));

        const buf = Buffer.alloc(18 + length);
        ARTNET_ID.copy(buf, 0);
        buf.writeUInt16LE(OP_DMX, 8);
        buf.writeUInt16BE(PROTOCOL_VERSION, 10);
        buf[12] = this.nextSequence(universe); // 0 = disabled
        // 13: Physical
        buf[14] = universe & 0xff; // SubUni
        buf[15] = (universe >> 8) & 0x7f; // Net
        buf.writeUInt16BE(length, 16);
        buf.set(data.subarray(0, length), 18);
        return buf;
    }

    /**
     * Write values into a universe buffer. Returns the universe's highest
     * changed channel since its last send (0 if nothing changed).
     */
    private write(
        universe: number,
        channel: number,
        value: number | number[],
    ): number {
        const data = this.universeData(universe);
        let changed = this.dataChanged.get(universe) ?? 0;

        if (Array.isArray(value)) {
            if (channel - 1 + value.length > DMX_CHANNELS) {
                throw new RangeError(
                    `${value.length} values starting at channel ${channel} run past channel ${DMX_CHANNELS}`,
                );
            }
            for (let i = 0; i < value.length; i++) {
                const v = value[i];
                // Non-numbers (holes, null) leave the channel untouched
                if (typeof v !== "number") {
                    continue;
                }
                const index = channel - 1 + i;
                data[index] = toDmxValue(v);
                changed = Math.max(changed, index + 1);
            }
        } else if (typeof value === "number") {
            // Single-channel path keeps change detection, so polling a channel
            // that is already at the desired value doesn't flood the bus.
            const v = toDmxValue(value);
            if (data[channel - 1] !== v) {
                data[channel - 1] = v;
                changed = Math.max(changed, channel);
            }
        } else {
            throw new TypeError(
                "value must be a number or an array of numbers",
            );
        }

        this.dataChanged.set(universe, changed);
        return changed;
    }

    public set(
        universe: number,
        channel: number,
        value: number,
        callback?: ArtnetCallback,
    ): boolean;
    public set(
        universe: number,
        channel: number,
        values: number[],
        callback?: ArtnetCallback,
    ): boolean;
    public set(
        channel: number,
        value: number,
        callback?: ArtnetCallback,
    ): boolean;
    public set(
        channel: number,
        values: number[],
        callback?: ArtnetCallback,
    ): boolean;
    public set(value: number, callback?: ArtnetCallback): boolean;
    public set(values: number[], callback?: ArtnetCallback): boolean;

    /**
     * Set DMX channel(s) to value(s). Can be single value or array.
     * Values are clamped to 0..255 and rounded. Universe must be 0..32767 and
     * channels 1..512, otherwise a RangeError is thrown.
     * Returns `false` (and calls back with an error) if the instance is closed.
     * @example set(1, 1, 255) // universe 1, channel 1 = 255
     */
    public set(
        arg1: number | number[],
        arg2?: number | number[] | ArtnetCallback,
        arg3?: number | number[] | ArtnetCallback,
        arg4?: ArtnetCallback,
    ): boolean {
        let universe = 0;
        let channel = 1;
        let value: number | number[];
        let callback: ArtnetCallback | undefined;

        if (
            typeof arg1 === "number" &&
            typeof arg2 === "number" &&
            (typeof arg3 === "number" || Array.isArray(arg3))
        ) {
            // set(universe, channel, value/arr, [callback])
            universe = arg1;
            channel = arg2;
            value = arg3;
            callback = arg4;
        } else if (
            typeof arg1 === "number" &&
            (typeof arg2 === "number" || Array.isArray(arg2))
        ) {
            // set(channel, value/arr, [callback])
            channel = arg1;
            value = arg2;
            callback = arg3 as ArtnetCallback | undefined;
        } else {
            // set(value/arr, [callback])
            value = arg1;
            callback = arg2 as ArtnetCallback | undefined;
        }

        assertUniverse(universe);
        assertChannel(channel);

        if (this.closed) {
            callback?.(this.closedError());
            return false;
        }

        const changed = this.write(universe, channel, value);

        if (changed) {
            this.send(universe, false, callback);
        } else {
            callback?.(null, undefined);
        }
        return true;
    }

    public trigger(
        oem: number,
        subKey: number,
        key: number,
        callback?: ArtnetCallback,
    ): boolean;
    public trigger(
        subKey: number,
        key: number,
        callback?: ArtnetCallback,
    ): boolean;
    public trigger(key: number, callback?: ArtnetCallback): boolean;

    /**
     * Send a trigger event. OEM defaults to 0xFFFF (all), subKey to 0.
     */
    public trigger(
        arg1: number,
        arg2?: number | ArtnetCallback,
        arg3?: number | ArtnetCallback,
        arg4?: ArtnetCallback,
    ): boolean {
        let oem = 0xffff;
        let subKey = 0;
        let key: number;
        let callback: ArtnetCallback | undefined;

        if (typeof arg2 === "number" && typeof arg3 === "number") {
            // trigger(oem, subKey, key, [callback])
            oem = arg1;
            subKey = arg2;
            key = arg3;
            callback = arg4;
        } else if (typeof arg2 === "number") {
            // trigger(subKey, key, [callback])
            subKey = arg1;
            key = arg2;
            callback = arg3 as ArtnetCallback | undefined;
        } else {
            // trigger(key, [callback])
            key = arg1;
            callback = arg2;
        }

        if (this.closed) {
            callback?.(this.closedError());
            return false;
        }

        this.sendTrigger(oem, key, subKey, callback);
        return true;
    }

    private dispatchMessage(msg: Buffer, rinfo: RemoteInfo): void {
        if (this.discoveryHandlers.size === 0) {
            return;
        }
        if (!isArtNetPacket(msg, OP_POLL_REPLY)) {
            return;
        }
        for (const handler of this.discoveryHandlers) {
            handler(msg, rinfo);
        }
    }

    /** Main socket bound on the Art-Net port, plus the address it is bound to. */
    private async mainDiscoveryBinding(): Promise<string | null> {
        if (!this.bindReady || !(await this.bindReady) || this.closed) {
            return null;
        }
        try {
            const address = this.socket.address();
            return address.port === ARTNET_PORT ? address.address : null;
        } catch {
            return null;
        }
    }

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
    public async discoverNodes(
        timeout: number = 2000,
        options: DiscoverOptions = {},
    ): Promise<DiscoveredNode[]> {
        if (this.closed) {
            throw this.closedError();
        }

        const target =
            options.address ??
            (isBroadcastAddress(this.host) ? this.host : GLOBAL_BROADCAST);

        const mainAddress = await this.mainDiscoveryBinding();
        if (this.closed) {
            throw this.closedError();
        }

        const replies = new Map<
            string,
            { ip: string; port: number; parts: Map<number, ArtNetNodeInfo> }
        >();
        const collect: MessageHandler = (msg, rinfo) => {
            let entry = replies.get(rinfo.address);
            if (!entry) {
                entry = {
                    ip: rinfo.address,
                    port: rinfo.port,
                    parts: new Map(),
                };
                replies.set(rinfo.address, entry);
            }
            const bindIndex = readBindIndex(msg);
            if (!entry.parts.has(bindIndex)) {
                entry.parts.set(bindIndex, parseArtPollReply(msg));
            }
        };

        // Collect on the main socket when it already owns 0.0.0.0:6454.
        // Otherwise also listen on a shared 0.0.0.0:6454 socket: either the
        // main socket isn't on the Art-Net port, or it is bound to one address
        // (on Linux that misses broadcast replies).
        let pollSocket: Socket = this.socket;
        let usingShared = false;
        this.discoveryHandlers.add(collect);

        if (mainAddress !== "0.0.0.0") {
            try {
                const shared = await this.acquireDiscoverySocket();
                usingShared = true;
                if (mainAddress === null) {
                    pollSocket = shared;
                }
            } catch (err) {
                // With a working main socket, carry on without broadcast replies
                if (mainAddress === null) {
                    this.discoveryHandlers.delete(collect);
                    throw err;
                }
            }
        }

        return new Promise<DiscoveredNode[]>((resolve, reject) => {
            let settled = false;

            const cleanup = () => {
                settled = true;
                clearTimeout(timer);
                this.discoveryHandlers.delete(collect);
                this.activeDiscoveries.delete(finish);
                if (usingShared) {
                    this.releaseDiscoverySocket();
                }
            };
            const finish = () => {
                if (settled) {
                    return;
                }
                cleanup();
                resolve([...replies.values()].map(mergeNodeReplies));
            };
            const fail = (err: Error) => {
                if (settled) {
                    return;
                }
                cleanup();
                reject(err);
            };

            const timer = this.timer(setTimeout(finish, timeout));
            this.activeDiscoveries.add(finish);

            if (this.closed) {
                finish();
                return;
            }

            this.transmit(
                pollSocket,
                createArtPollPacket(),
                ARTNET_PORT,
                target,
                [
                    (err) => {
                        if (err) {
                            fail(err);
                        }
                    },
                ],
            );
        });
    }

    /**
     * Shared 0.0.0.0:6454 listener for discoveries, so concurrent calls don't
     * each open a socket (unicast replies would reach only one of them).
     * Reference-counted; closed when the last discovery releases it.
     */
    private acquireDiscoverySocket(): Promise<Socket> {
        this.discoverySocketUsers++;
        if (!this.discoverySocket) {
            const socket = createSocket({ type: "udp4", reuseAddr: true });
            socket.on("message", (msg, rinfo) => {
                this.dispatchMessage(msg, rinfo);
            });
            this.discoverySocket = new Promise<Socket>((resolve, reject) => {
                const onError = (err: Error) => {
                    this.discoverySocket = null;
                    try {
                        socket.close();
                    } catch {
                        // never bound
                    }
                    reject(err);
                };
                socket.once("error", onError);
                socket.bind(ARTNET_PORT, () => {
                    socket.off("error", onError);
                    // Errors after bind are per-send and reported there
                    socket.on("error", () => {});
                    socket.setBroadcast(true);
                    resolve(socket);
                });
            });
        }
        return this.discoverySocket.catch((err) => {
            this.discoverySocketUsers--;
            throw err;
        });
    }

    private releaseDiscoverySocket(): void {
        this.discoverySocketUsers--;
        if (this.discoverySocketUsers > 0 || !this.discoverySocket) {
            return;
        }
        const pending = this.discoverySocket;
        this.discoverySocket = null;
        pending.then(
            (socket) => {
                try {
                    socket.close();
                } catch {
                    // already closed
                }
            },
            () => {},
        );
    }

    /**
     * Stop all polling/refresh and close the socket. Safe to call more than
     * once. Queued sends are called back with an error.
     */
    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;

        for (const timeout of this.refreshTimers.values()) {
            clearTimeout(timeout);
        }
        for (const timeout of this.throttleTimers.values()) {
            clearTimeout(timeout);
        }
        this.refreshTimers.clear();
        this.throttleTimers.clear();

        const pending = [...this.pendingSends.values()];
        this.pendingSends.clear();
        for (const { callbacks } of pending) {
            for (const cb of callbacks) {
                cb(this.closedError());
            }
        }

        for (const finish of [...this.activeDiscoveries]) {
            finish();
        }

        try {
            this.socket.close();
        } catch {
            // never bound or already closed
        }
    }

    /**
     * Change the Art-Net output host.
     */
    public setHost(host: string): void {
        this.host = host;
    }

    /**
     * Set a new UDP port. (Only allowed when not using broadcast)
     */
    public setPort(port: number): void {
        if (this.host === GLOBAL_BROADCAST) {
            throw new Error(
                "Can't change port when using broadcast address 255.255.255.255",
            );
        }
        this.port = port;
    }
}

/**
 * ArtPoll (Art-Net 4, p17): ID, OpCode 0x2000, ProtVer 14, Flags, DiagPriority.
 */
function createArtPollPacket(): Buffer {
    const buf = Buffer.alloc(14);
    ARTNET_ID.copy(buf, 0);
    buf.writeUInt16LE(OP_POLL, 8);
    buf.writeUInt16BE(PROTOCOL_VERSION, 10);
    // 12: Flags = 0, 13: DiagPriority = 0
    return buf;
}

/**
 * ArtSync (Art-Net 4): ID, OpCode 0x5200, ProtVer 14, Aux1 = 0, Aux2 = 0.
 */
function createArtSyncPacket(): Buffer {
    const buf = Buffer.alloc(14);
    ARTNET_ID.copy(buf, 0);
    buf.writeUInt16LE(OP_SYNC, 8);
    buf.writeUInt16BE(PROTOCOL_VERSION, 10);
    return buf;
}

function mergeNodeReplies(entry: {
    ip: string;
    port: number;
    parts: Map<number, ArtNetNodeInfo>;
}): DiscoveredNode {
    const parts = [...entry.parts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, info]) => info);
    const root = parts[0];
    const universesIn = parts.flatMap((p) => p.universesIn);
    const universesOut = parts.flatMap((p) => p.universesOut);

    return {
        ip: entry.ip,
        port: entry.port,
        info: {
            ...root,
            portCount: parts.reduce((sum, p) => sum + p.portCount, 0),
            universe: universesIn[0] ?? universesOut[0] ?? root.universe,
            universesIn,
            universesOut,
        },
    };
}
