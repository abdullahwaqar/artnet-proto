import { EventEmitter } from "node:events";
import { createSocket } from "dgram";
/**
 * Implements the Art-Net v4 protocol for DMX-over-IP communication.
 * Reference: https://art-net.org.uk/downloads/art-net.pdf
 */
export class Artnet extends EventEmitter {
    host;
    port;
    refresh;
    sendAll;
    socket;
    data = [];
    interval = [];
    sendThrottle = [];
    sendDelayed = [];
    dataChanged = [];
    constructor(config = {}) {
        super();
        this.host = config.host ?? "255.255.255.255";
        this.port = config.port ?? 6454;
        this.refresh = config.refresh ?? 4000;
        this.sendAll = config.sendAll ?? false;
        this.socket = createSocket({ type: "udp4", reuseAddr: true });
        this.socket.on("error", (err) => {
            this.emit("error", err);
        });
        if (config.interface && this.host === "255.255.255.255") {
            this.socket.bind(this.port, config.interface, () => {
                this.socket.setBroadcast(true);
            });
        }
        else if (this.host.endsWith(".255")) {
            this.socket.bind(this.port, () => {
                this.socket.setBroadcast(true);
            });
        }
    }
    /**
     * Send an Art-Net trigger packet.
     * Reference: Art-Net 4 Spec, p40
     */
    sendTrigger(oem, key, subKey, callback) {
        const buf = this.triggerPackage(oem, key, subKey);
        this.socket.send(buf, 0, buf.length, this.port, this.host, callback);
    }
    triggerPackage(oem, key, subkey) {
        // See Art-Net 4, p40 for structure
        const hOem = (oem >> 8) & 0xff;
        const lOem = oem & 0xff;
        const header = [
            65,
            114,
            116,
            45,
            78,
            101,
            116,
            0,
            0,
            153,
            0,
            14,
            0,
            0,
            hOem,
            lOem,
            key,
            subkey,
        ];
        const payload = Array(512).fill(0);
        return Buffer.from(header.concat(payload));
    }
    startRefresh(universe) {
        this.interval[universe] = setInterval(() => {
            this.send(universe, 512);
        }, this.refresh);
    }
    /**
     * Send DMX data as ArtDmx packet.
     * Reference: Art-Net 4 Spec, p45 (ArtDmx Packet Definition)
     */
    send(universe, refresh = false, callback) {
        // Handle overload: send(universe, callback)
        if (typeof refresh === "function") {
            callback = refresh;
            refresh = false;
        }
        // Global override to always send all channels
        if (this.sendAll) {
            refresh = true;
        }
        // Start refresh timer for this universe if needed
        if (!this.interval[universe]) {
            this.startRefresh(universe);
        }
        // Handle throttling
        if (this.sendThrottle[universe]) {
            this.sendDelayed[universe] = true;
            return;
        }
        clearTimeout(this.sendThrottle[universe]);
        // Capture args in closure for the throttle timeout
        const sendRefresh = refresh;
        const sendCallback = callback;
        this.sendThrottle[universe] = setTimeout(() => {
            this.sendThrottle[universe] = undefined;
            if (this.sendDelayed[universe]) {
                this.sendDelayed[universe] = false;
                this.send(universe, sendRefresh, sendCallback);
            }
        }, 25);
        // Enforce minimum length
        let length;
        if (refresh) {
            length = 512;
        }
        else {
            // If no changes recorded, still send full 512 for safety
            length =
                this.dataChanged[universe] && this.dataChanged[universe] > 0
                    ? this.dataChanged[universe]
                    : 512;
        }
        // Build packet and reset change counter
        const buf = this.artdmxPackage(universe, length);
        this.dataChanged[universe] = 0;
        // Send the packet
        this.socket.send(buf, 0, buf.length, this.port, this.host, callback);
    }
    artdmxPackage(universe, length = 2) {
        // Length must be even per Art-Net spec
        if (length % 2) {
            length++;
        }
        const hUni = (universe >> 8) & 0xff;
        const lUni = universe & 0xff;
        const hLen = (length >> 8) & 0xff;
        const lLen = length & 0xff;
        // Art-Net 4, p45 (ArtDmx Packet)
        const header = [
            65,
            114,
            116,
            45,
            78,
            101,
            116,
            0, // "Art-Net" + null terminator
            0,
            80, // OpCode = OpOutput / OpDmx (0x5000 little endian)
            0,
            14, // Protocol Version (14 decimal)
            0,
            0, // Sequence + Physical (set to zero for auto)
            lUni,
            hUni, // Universe (little endian)
            hLen,
            lLen, // Length (DMX length)
        ];
        if (!this.data[universe]) {
            this.data[universe] = Array(512).fill(0);
        }
        const lengthBytes = hLen * 256 + lLen;
        // Ensure we only send numbers 0–255 (replace null with 0)
        const cleanDmx = this.data[universe]
            .slice(0, lengthBytes)
            .map((value) => value ?? 0);
        return Buffer.from(header.concat(cleanDmx));
    }
    /**
     * Set DMX channel(s) to value(s). Can be single value or array.
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
            channel = 1;
            value = arg1;
            callback = arg2;
        }
        // Ensure universe exists
        if (!this.data[universe])
            this.data[universe] = Array(512).fill(0);
        this.dataChanged[universe] = this.dataChanged[universe] || 0;
        // Update data
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
                const index = channel + i - 1;
                if (typeof value[i] === "number" &&
                    this.data[universe][index] !== value[i]) {
                    this.data[universe][index] = value[i];
                    if (index + 1 > this.dataChanged[universe]) {
                        this.dataChanged[universe] = index + 1;
                    }
                }
            }
        }
        else if (typeof value === "number" &&
            this.data[universe][channel - 1] !== value) {
            this.data[universe][channel - 1] = value;
            if (channel > this.dataChanged[universe]) {
                this.dataChanged[universe] = channel;
            }
        }
        // Send if changed
        if (this.dataChanged[universe]) {
            this.send(universe, false, callback);
        }
        else if (typeof callback === "function") {
            callback(null, undefined);
        }
        return true;
    }
    /**
     * Send a trigger event.
     */
    trigger(arg1, arg2, arg3, arg4) {
        let oem;
        let subKey;
        let key;
        let callback;
        if (typeof arg2 === "number" && typeof arg3 === "number") {
            // trigger(oem, subKey, key, [callback])
            oem = arg1;
            subKey = arg2;
            key = arg3;
            callback = arg4;
        }
        else if (typeof arg2 === "number" && typeof arg3 === "function") {
            // trigger(subKey, key, callback)
            oem = 0xffff;
            subKey = arg1;
            key = arg2;
            callback = arg3;
        }
        else if (typeof arg2 === "function") {
            // trigger(key, callback)
            oem = 0xffff;
            subKey = 0;
            key = arg1;
            callback = arg2;
        }
        else if (typeof arg2 === "number") {
            // trigger(subKey, key)
            oem = 0xffff;
            subKey = arg1;
            key = arg2;
        }
        else {
            // trigger(key)
            oem = 0xffff;
            subKey = 0;
            key = arg1;
        }
        // Defaults per Art-Net spec (p40)
        oem = oem ?? 0xffff;
        key = key ?? 255;
        this.sendTrigger(oem, key, subKey, callback);
        return true;
    }
    /**
     * Stop all polling/refresh and close the socket.
     */
    close() {
        for (const interval of this.interval) {
            if (interval)
                clearInterval(interval);
        }
        for (const throttle of this.sendThrottle) {
            if (throttle)
                clearTimeout(throttle);
        }
        this.socket.close();
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
        if (this.host === "255.255.255.255") {
            throw new Error("Can't change port when using broadcast address 255.255.255.255");
        }
        else {
            this.port = port;
        }
    }
}
