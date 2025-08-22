import { EventEmitter } from "node:events";
interface ArtnetConfig {
    host?: string;
    port?: number;
    refresh?: number;
    sendAll?: boolean;
    interface?: string;
}
/**
 * Represents a discovered Art-Net node (device, which may be a fixture, gateway, or controller).
 */
interface ArtNetNodeInfo {
    shortName: string;
    longName: string;
    nodeIp: string;
    portCount: number;
    /**
     * First input port’s full 15-bit universe (Net<<8 | Sub<<4 | Chan) for quick access
     */
    universe: number;
    /**
     * Up to 4 input universes, one per input port (computed from Net/Sub + SwIn[0..3])
     */
    universesIn: number[];
    /**
     * Up to 4 output universes, one per output port (computed from Net/Sub + SwOut[0..3])
     */
    universesOut: number[];
}
type ArtnetCallback = (error: Error | null, bytes?: number) => void;
/**
 * Implements the Art-Net v4 protocol for DMX-over-IP communication.
 * Reference: https://art-net.org.uk/downloads/art-net.pdf
 */
export declare class Artnet extends EventEmitter {
    private host;
    private port;
    private refresh;
    private sendAll;
    private socket;
    private data;
    private interval;
    private sendThrottle;
    private sendDelayed;
    private dataChanged;
    private discoveredNodes;
    constructor(config?: ArtnetConfig);
    /**
     * Send an Art-Net trigger packet.
     * Reference: Art-Net 4 Spec, p40
     */
    sendTrigger(oem: number, key: number, subKey: number, callback?: ArtnetCallback): void;
    private triggerPackage;
    private startRefresh;
    /**
     * Send DMX data as ArtDmx packet.
     * Reference: Art-Net 4 Spec, p45 (ArtDmx Packet Definition)
     */
    send(universe: number, refresh?: number | boolean, callback?: ArtnetCallback): void;
    private artdmxPackage;
    set(universe: number, channel: number, value: number, callback?: ArtnetCallback): boolean;
    set(universe: number, channel: number, values: number[], callback?: ArtnetCallback): boolean;
    set(channel: number, value: number, callback?: ArtnetCallback): boolean;
    set(channel: number, values: number[], callback?: ArtnetCallback): boolean;
    set(value: number, callback?: ArtnetCallback): boolean;
    set(values: number[], callback?: ArtnetCallback): boolean;
    trigger(oem: number, subKey: number, key: number, callback?: ArtnetCallback): boolean;
    trigger(subKey: number, key: number, callback?: ArtnetCallback): boolean;
    trigger(key: number, callback?: ArtnetCallback): boolean;
    /**
     * Discovers all Art-Net nodes (devices) present on the local network.
     *
     * Broadcasts an ArtPoll message and collects all ArtPollReply responses for the timeout period.
     * Each discovered node provides IP address, short name, universes, and port info.
     *
     * @param timeout How long to wait for replies, in milliseconds (default: 2000ms).
     * @returns Promise resolving with an array of discovered nodes.
     */
    discoverNodes(timeout?: number): Promise<{
        ip: string;
        port: number;
        info: ArtNetNodeInfo;
    }[]>;
    /**
     * Generates a valid ArtPoll (discovery) UDP packet per Art-Net specification.
     *
     * @returns Buffer containing the ArtPoll packet.
     */
    private createArtPollPacket;
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
     * - 172..173: NumPorts (Hi, Lo)
     * - 186..189: SwIn[0..3]  (low nibble == input universe/channel 0..15)
     * - 190..193: SwOut[0..3] (low nibble == output universe/channel 0..15)
     *
     * Universe number (15-bit) is composed as:
     *   universe = (NetSwitch << 8) | (SubSwitch << 4) | (PortNibble)
     * Where PortNibble is low-nibble of SwIn[x] or SwOut[x].
     *
     * @param msg Buffer containing the ArtPollReply packet.
     * @returns ArtNetNodeInfo object with extracted node/device details.
     */
    private parseArtPollReply;
    /**
     * Stop all polling/refresh and close the socket.
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
export {};
//# sourceMappingURL=index.d.ts.map