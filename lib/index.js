import { createSocket } from "node:dgram";
import { EventEmitter } from "node:events";
/** Standard Art-Net UDP port. */
export const ARTNET_PORT = 6454;
const ARTNET_ID = Buffer.from("Art-Net\0", "ascii");
const PROTOCOL_VERSION = 14;
const OP_POLL = 0x2000;
const OP_POLL_REPLY = 0x2100;
const OP_DMX = 0x5000;
const OP_TRIGGER = 0x9900;
const GLOBAL_BROADCAST = "255.255.255.255";
const DMX_CHANNELS = 512;
const MAX_UNIVERSE = 0x7fff;
const THROTTLE_MS = 25;
const CLOSED_MESSAGE = "Artnet instance is closed";
function isBroadcastAddress(host) {
    return host === GLOBAL_BROADCAST || host.endsWith(".255");
}
function assertUniverse(universe) {
    if (!Number.isInteger(universe) ||
        universe < 0 ||
        universe > MAX_UNIVERSE) {
        throw new RangeError(`universe must be an integer from 0 to ${MAX_UNIVERSE}, got ${universe}`);
    }
}
function assertChannel(channel) {
    if (!Number.isInteger(channel) || channel < 1 || channel > DMX_CHANNELS) {
        throw new RangeError(`channel must be an integer from 1 to ${DMX_CHANNELS}, got ${channel}`);
    }
}
function assertByteRange(name, value, max) {
    if (!Number.isInteger(value) || value < 0 || value > max) {
        throw new RangeError(`${name} must be an integer from 0 to ${max}, got ${value}`);
    }
}
/** Clamp any number to a valid DMX value (0..255, rounded). NaN becomes 0. */
function toDmxValue(value) {
    if (Number.isNaN(value)) {
        return 0;
    }
    return Math.min(255, Math.max(0, Math.round(value)));
}
function isArtNetPacket(msg, opcode) {
    return (msg.length >= 10 &&
        msg.subarray(0, 8).equals(ARTNET_ID) &&
        msg.readUInt16LE(8) === opcode);
}
/** BindIndex (byte 211). 0 and 1 both mean the root device. */
function readBindIndex(msg) {
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
export function parseArtPollReply(msg) {
    const getString = (start, length) => {
        if (msg.length <= start) {
            return "";
        }
        const limit = Math.min(start + length, msg.length);
        let end = msg.indexOf(0, start);
        if (end === -1 || end > limit) {
            end = limit;
        }
        // Strip control and non-ASCII bytes (common garbage on cheap nodes)
        return (msg
            .subarray(start, end)
            .toString("latin1")
            // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes is the point
            .replace(/[\x00-\x1F\x7F-\xFF]/g, "")
            .trim());
    };
    const nodeIp = msg.length >= 14
        ? `${msg[10]}.${msg[11]}.${msg[12]}.${msg[13]}`
        : "0.0.0.0";
    const net = msg.length > 18 ? msg[18] & 0x7f : 0;
    const sub = msg.length > 19 ? msg[19] & 0x0f : 0;
    const compose = (nibble) => (net << 8) | (sub << 4) | (nibble & 0x0f);
    const portCount = msg.length > 173 ? Math.min(4, msg[173]) : 0;
    const universesIn = [];
    const universesOut = [];
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
    host;
    port;
    refresh;
    sendAll;
    unref;
    socket;
    closed = false;
    bindReady = null;
    data = new Map();
    dataChanged = new Map();
    refreshTimers = new Map();
    throttleTimers = new Map();
    pendingSends = new Map();
    discoveryHandlers = new Set();
    activeDiscoveries = new Set();
    discoverySocket = null;
    discoverySocketUsers = 0;
    constructor(config = {}) {
        super();
        this.host = config.host ?? GLOBAL_BROADCAST;
        this.port = config.port ?? ARTNET_PORT;
        this.refresh = config.refresh ?? 1000;
        this.sendAll = config.sendAll ?? false;
        this.unref = config.unref ?? false;
        this.socket = createSocket({ type: "udp4", reuseAddr: true });
        this.socket.on("error", (err) => {
            this.emit("error", err);
        });
        // Enable broadcast on every bind (explicit or implicit), so switching
        // to a broadcast host later with setHost() works.
        this.socket.on("listening", () => {
            try {
                this.socket.setBroadcast(true);
            }
            catch {
                // Socket closed between bind and this handler
            }
        });
        this.socket.on("message", (msg, rinfo) => {
            this.dispatchMessage(msg, rinfo);
        });
        if (config.interface) {
            this.bindReady = this.bindSocket(this.port, config.interface);
        }
        else if (isBroadcastAddress(this.host)) {
            this.bindReady = this.bindSocket(this.port);
        }
    }
    bindSocket(port, address) {
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
    timer(timeout) {
        if (this.unref) {
            timeout.unref();
        }
        return timeout;
    }
    closedError() {
        return new Error(CLOSED_MESSAGE);
    }
    /**
     * Send a buffer and report the result to every callback. With no
     * callbacks, a send error is emitted as `error` only if someone listens,
     * so a transient network error can't crash the process.
     */
    transmit(socket, buf, port, address, callbacks) {
        const report = (err, bytes) => {
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
        }
        catch (err) {
            process.nextTick(() => report(err));
        }
    }
    /**
     * Send an Art-Net trigger packet.
     * Reference: Art-Net 4 Spec, p40
     */
    sendTrigger(oem, key, subKey, callback) {
        assertByteRange("oem", oem, 0xffff);
        assertByteRange("key", key, 0xff);
        assertByteRange("subKey", subKey, 0xff);
        if (this.closed) {
            callback?.(this.closedError());
            return;
        }
        const buf = this.triggerPackage(oem, key, subKey);
        this.transmit(this.socket, buf, this.port, this.host, callback ? [callback] : []);
    }
    triggerPackage(oem, key, subKey) {
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
    scheduleRefresh(universe) {
        const existing = this.refreshTimers.get(universe);
        if (existing) {
            clearTimeout(existing);
        }
        if (this.refresh <= 0) {
            this.refreshTimers.delete(universe);
            return;
        }
        this.refreshTimers.set(universe, this.timer(setTimeout(() => {
            this.refreshTimers.delete(universe);
            if (!this.closed) {
                this.send(universe, true);
            }
        }, this.refresh)));
    }
    send(universe, refreshOrCallback, callback) {
        let refresh = false;
        if (typeof refreshOrCallback === "function") {
            callback = refreshOrCallback;
        }
        else {
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
    flush(universe, refresh, callbacks) {
        this.throttleTimers.set(universe, this.timer(setTimeout(() => {
            this.throttleTimers.delete(universe);
            const pending = this.pendingSends.get(universe);
            if (pending && !this.closed) {
                this.pendingSends.delete(universe);
                this.flush(universe, pending.refresh, pending.callbacks);
            }
        }, THROTTLE_MS)));
        const changed = this.dataChanged.get(universe) ?? 0;
        // No recorded changes (manual send): send the full universe
        const length = refresh || changed === 0 ? DMX_CHANNELS : changed;
        this.dataChanged.set(universe, 0);
        const buf = this.artdmxPackage(universe, length);
        this.transmit(this.socket, buf, this.port, this.host, callbacks);
        this.scheduleRefresh(universe);
    }
    universeData(universe) {
        let data = this.data.get(universe);
        if (!data) {
            data = new Uint8Array(DMX_CHANNELS);
            this.data.set(universe, data);
        }
        return data;
    }
    artdmxPackage(universe, length) {
        // Length must be even, 2..512 (Art-Net 4, p45)
        if (length % 2) {
            length++;
        }
        length = Math.min(DMX_CHANNELS, Math.max(2, length));
        const buf = Buffer.alloc(18 + length);
        ARTNET_ID.copy(buf, 0);
        buf.writeUInt16LE(OP_DMX, 8);
        buf.writeUInt16BE(PROTOCOL_VERSION, 10);
        // 12: Sequence (0 = disabled), 13: Physical
        buf[14] = universe & 0xff; // SubUni
        buf[15] = (universe >> 8) & 0x7f; // Net
        buf.writeUInt16BE(length, 16);
        buf.set(this.universeData(universe).subarray(0, length), 18);
        return buf;
    }
    /**
     * Set DMX channel(s) to value(s). Can be single value or array.
     * Values are clamped to 0..255 and rounded. Universe must be 0..32767 and
     * channels 1..512, otherwise a RangeError is thrown.
     * Returns `false` (and calls back with an error) if the instance is closed.
     * @example set(1, 1, 255) // universe 1, channel 1 = 255
     */
    set(arg1, arg2, arg3, arg4) {
        let universe = 0;
        let channel = 1;
        let value;
        let callback;
        if (typeof arg1 === "number" &&
            typeof arg2 === "number" &&
            (typeof arg3 === "number" || Array.isArray(arg3))) {
            // set(universe, channel, value/arr, [callback])
            universe = arg1;
            channel = arg2;
            value = arg3;
            callback = arg4;
        }
        else if (typeof arg1 === "number" &&
            (typeof arg2 === "number" || Array.isArray(arg2))) {
            // set(channel, value/arr, [callback])
            channel = arg1;
            value = arg2;
            callback = arg3;
        }
        else {
            // set(value/arr, [callback])
            value = arg1;
            callback = arg2;
        }
        assertUniverse(universe);
        assertChannel(channel);
        if (this.closed) {
            callback?.(this.closedError());
            return false;
        }
        const data = this.universeData(universe);
        let changed = this.dataChanged.get(universe) ?? 0;
        if (Array.isArray(value)) {
            if (channel - 1 + value.length > DMX_CHANNELS) {
                throw new RangeError(`${value.length} values starting at channel ${channel} run past channel ${DMX_CHANNELS}`);
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
        }
        else if (typeof value === "number") {
            // Single-channel path keeps change detection, so polling a channel
            // that is already at the desired value doesn't flood the bus.
            const v = toDmxValue(value);
            if (data[channel - 1] !== v) {
                data[channel - 1] = v;
                changed = Math.max(changed, channel);
            }
        }
        else {
            throw new TypeError("value must be a number or an array of numbers");
        }
        this.dataChanged.set(universe, changed);
        if (changed) {
            this.send(universe, false, callback);
        }
        else {
            callback?.(null, undefined);
        }
        return true;
    }
    /**
     * Send a trigger event. OEM defaults to 0xFFFF (all), subKey to 0.
     */
    trigger(arg1, arg2, arg3, arg4) {
        let oem = 0xffff;
        let subKey = 0;
        let key;
        let callback;
        if (typeof arg2 === "number" && typeof arg3 === "number") {
            // trigger(oem, subKey, key, [callback])
            oem = arg1;
            subKey = arg2;
            key = arg3;
            callback = arg4;
        }
        else if (typeof arg2 === "number") {
            // trigger(subKey, key, [callback])
            subKey = arg1;
            key = arg2;
            callback = arg3;
        }
        else {
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
    dispatchMessage(msg, rinfo) {
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
    async mainDiscoveryBinding() {
        if (!this.bindReady || !(await this.bindReady) || this.closed) {
            return null;
        }
        try {
            const address = this.socket.address();
            return address.port === ARTNET_PORT ? address.address : null;
        }
        catch {
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
    async discoverNodes(timeout = 2000, options = {}) {
        if (this.closed) {
            throw this.closedError();
        }
        const target = options.address ??
            (isBroadcastAddress(this.host) ? this.host : GLOBAL_BROADCAST);
        const mainAddress = await this.mainDiscoveryBinding();
        if (this.closed) {
            throw this.closedError();
        }
        const replies = new Map();
        const collect = (msg, rinfo) => {
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
        let pollSocket = this.socket;
        let usingShared = false;
        this.discoveryHandlers.add(collect);
        if (mainAddress !== "0.0.0.0") {
            try {
                const shared = await this.acquireDiscoverySocket();
                usingShared = true;
                if (mainAddress === null) {
                    pollSocket = shared;
                }
            }
            catch (err) {
                // With a working main socket, carry on without broadcast replies
                if (mainAddress === null) {
                    this.discoveryHandlers.delete(collect);
                    throw err;
                }
            }
        }
        return new Promise((resolve, reject) => {
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
            const fail = (err) => {
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
            this.transmit(pollSocket, createArtPollPacket(), ARTNET_PORT, target, [
                (err) => {
                    if (err) {
                        fail(err);
                    }
                },
            ]);
        });
    }
    /**
     * Shared 0.0.0.0:6454 listener for discoveries, so concurrent calls don't
     * each open a socket (unicast replies would reach only one of them).
     * Reference-counted; closed when the last discovery releases it.
     */
    acquireDiscoverySocket() {
        this.discoverySocketUsers++;
        if (!this.discoverySocket) {
            const socket = createSocket({ type: "udp4", reuseAddr: true });
            socket.on("message", (msg, rinfo) => {
                this.dispatchMessage(msg, rinfo);
            });
            this.discoverySocket = new Promise((resolve, reject) => {
                const onError = (err) => {
                    this.discoverySocket = null;
                    try {
                        socket.close();
                    }
                    catch {
                        // never bound
                    }
                    reject(err);
                };
                socket.once("error", onError);
                socket.bind(ARTNET_PORT, () => {
                    socket.off("error", onError);
                    // Errors after bind are per-send and reported there
                    socket.on("error", () => { });
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
    releaseDiscoverySocket() {
        this.discoverySocketUsers--;
        if (this.discoverySocketUsers > 0 || !this.discoverySocket) {
            return;
        }
        const pending = this.discoverySocket;
        this.discoverySocket = null;
        pending.then((socket) => {
            try {
                socket.close();
            }
            catch {
                // already closed
            }
        }, () => { });
    }
    /**
     * Stop all polling/refresh and close the socket. Safe to call more than
     * once. Queued sends are called back with an error.
     */
    close() {
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
        }
        catch {
            // never bound or already closed
        }
    }
    /**
     * Change the Art-Net output host.
     */
    setHost(host) {
        this.host = host;
    }
    /**
     * Set a new UDP port. (Only allowed when not using broadcast)
     */
    setPort(port) {
        if (this.host === GLOBAL_BROADCAST) {
            throw new Error("Can't change port when using broadcast address 255.255.255.255");
        }
        this.port = port;
    }
}
/**
 * ArtPoll (Art-Net 4, p17): ID, OpCode 0x2000, ProtVer 14, Flags, DiagPriority.
 */
function createArtPollPacket() {
    const buf = Buffer.alloc(14);
    ARTNET_ID.copy(buf, 0);
    buf.writeUInt16LE(OP_POLL, 8);
    buf.writeUInt16BE(PROTOCOL_VERSION, 10);
    // 12: Flags = 0, 13: DiagPriority = 0
    return buf;
}
function mergeNodeReplies(entry) {
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
