import { EventEmitter } from "node:events";
interface ArtnetConfig {
    host?: string;
    port?: number;
    refresh?: number;
    sendAll?: boolean;
    interface?: string;
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