import { createSocket, type Socket } from "node:dgram";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

export { sleep };

/** A UDP listener on 127.0.0.1 that records every packet it receives. */
export interface Receiver {
    port: number;
    packets: Buffer[];
    /** Resolves once `count` packets in total have arrived. */
    waitFor(count: number, timeoutMs?: number): Promise<Buffer[]>;
    close(): void;
}

export async function createReceiver(): Promise<Receiver> {
    const socket: Socket = createSocket("udp4");
    const packets: Buffer[] = [];
    const waiters: { count: number; resolve: () => void }[] = [];

    socket.on("message", (msg) => {
        packets.push(msg);
        for (const w of [...waiters]) {
            if (packets.length >= w.count) {
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve();
            }
        }
    });

    socket.bind(0, "127.0.0.1");
    await once(socket, "listening");

    return {
        port: socket.address().port,
        packets,
        async waitFor(count, timeoutMs = 1000) {
            if (packets.length < count) {
                await Promise.race([
                    new Promise<void>((resolve) =>
                        waiters.push({ count, resolve }),
                    ),
                    sleep(timeoutMs).then(() => {
                        throw new Error(
                            `expected ${count} packets, got ${packets.length}`,
                        );
                    }),
                ]);
            }
            return packets;
        },
        close() {
            socket.close();
        },
    };
}

/** Build an ArtPollReply the way a node would. */
export function buildPollReply(opts: {
    ip?: [number, number, number, number];
    net?: number;
    sub?: number;
    shortName?: string;
    longName?: string;
    numPorts?: number;
    portTypes?: number[];
    swIn?: number[];
    swOut?: number[];
    bindIndex?: number;
}): Buffer {
    const buf = Buffer.alloc(239);
    Buffer.from("Art-Net\0", "ascii").copy(buf, 0);
    buf.writeUInt16LE(0x2100, 8);
    const ip = opts.ip ?? [127, 0, 0, 1];
    ip.forEach((b, i) => {
        buf[10 + i] = b;
    });
    buf.writeUInt16LE(6454, 14);
    buf[18] = opts.net ?? 0;
    buf[19] = opts.sub ?? 0;
    Buffer.from(opts.shortName ?? "Node", "ascii").copy(buf, 26, 0, 18);
    Buffer.from(opts.longName ?? "Test Node", "ascii").copy(buf, 44, 0, 64);
    buf[173] = opts.numPorts ?? 1;
    (opts.portTypes ?? []).forEach((b, i) => {
        buf[174 + i] = b;
    });
    (opts.swIn ?? []).forEach((b, i) => {
        buf[186 + i] = b;
    });
    (opts.swOut ?? []).forEach((b, i) => {
        buf[190 + i] = b;
    });
    buf[211] = opts.bindIndex ?? 0;
    return buf;
}
