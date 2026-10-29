import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Artnet, type ArtnetCallback, parseArtPollReply } from "../src/index";
import {
    buildPollReply,
    createReceiver,
    type Receiver,
    sleep,
} from "./helpers";

const HEADER = 18;

let rx: Receiver;
let artnet: Artnet;

function make(config: ConstructorParameters<typeof Artnet>[0] = {}): Artnet {
    artnet = new Artnet({
        host: "127.0.0.1",
        port: rx.port,
        refresh: 0,
        ...config,
    });
    return artnet;
}

function sent(
    universe: number,
    channel: number,
    value: number | number[],
): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
        artnet.set(universe, channel, value as number, (err, bytes) =>
            err ? reject(err) : resolve(bytes),
        );
    });
}

beforeEach(async () => {
    rx = await createReceiver();
});

afterEach(() => {
    artnet?.close();
    rx.close();
});

describe("ArtDmx packet", () => {
    it("has the correct header, universe and length encoding", async () => {
        make();
        await sent(0x1234, 1, [1, 2, 3, 4]);
        const [p] = await rx.waitFor(1);

        assert.equal(p.subarray(0, 8).toString("latin1"), "Art-Net\0");
        assert.equal(p.readUInt16LE(8), 0x5000, "OpDmx");
        assert.deepEqual([p[10], p[11]], [0, 14], "ProtVer 14");
        assert.equal(p[14], 0x34, "SubUni (low byte)");
        assert.equal(p[15], 0x12, "Net (high byte)");
        assert.equal(p.readUInt16BE(16), 4, "length is big-endian");
        assert.deepEqual([...p.subarray(HEADER)], [1, 2, 3, 4]);
    });

    it("rounds an odd changed length up to even", async () => {
        make();
        await sent(0, 3, 9);
        const [p] = await rx.waitFor(1);
        assert.equal(p.readUInt16BE(16), 4);
        assert.equal(p.length, HEADER + 4);
        assert.equal(p[HEADER + 2], 9);
    });

    it("encodes the highest universe (32767)", async () => {
        make();
        await sent(32767, 1, 1);
        const [p] = await rx.waitFor(1);
        assert.deepEqual([p[14], p[15]], [0xff, 0x7f]);
    });

    it("sends all 512 channels with sendAll", async () => {
        make({ sendAll: true });
        await sent(0, 1, 5);
        const [p] = await rx.waitFor(1);
        assert.equal(p.readUInt16BE(16), 512);
        assert.equal(p.length, HEADER + 512);
    });

    it("never sends more than 512 channels", async () => {
        make();
        await sent(0, 505, [1, 2, 3, 4, 5, 6, 7, 8]);
        const [p] = await rx.waitFor(1);
        assert.equal(p.readUInt16BE(16), 512);
        assert.equal(p.length, HEADER + 512);
        assert.equal(p[HEADER + 511], 8);
    });
});

describe("value and range validation", () => {
    it("clamps and rounds values instead of wrapping", async () => {
        make();
        await sent(0, 1, [300, -1, 12.7, Number.NaN, 255.4, Infinity]);
        const [p] = await rx.waitFor(1);
        assert.deepEqual(
            [...p.subarray(HEADER, HEADER + 6)],
            [255, 0, 13, 0, 255, 255],
        );
    });

    it("skips non-number holes in arrays", async () => {
        make();
        await sent(0, 1, [10, 20]);
        await sleep(40);
        await sent(0, 1, [
            undefined as unknown as number,
            null as unknown as number,
            30,
        ]);
        const p = (await rx.waitFor(2))[1];
        assert.deepEqual([...p.subarray(HEADER, HEADER + 3)], [10, 20, 30]);
    });

    it("rejects bad channels and universes", () => {
        make();
        assert.throws(() => artnet.set(0, 0, 1), RangeError);
        assert.throws(() => artnet.set(0, 513, 1), RangeError);
        assert.throws(() => artnet.set(0, 1.5, 1), RangeError);
        assert.throws(() => artnet.set(-1, 1, 1), RangeError);
        assert.throws(() => artnet.set(32768, 1, 1), RangeError);
        assert.throws(() => artnet.set(0, 510, [1, 2, 3, 4]), RangeError);
        assert.throws(() => artnet.send(40000), RangeError);
    });

    it("accepts an array that ends exactly on channel 512", () => {
        make();
        assert.doesNotThrow(() => artnet.set(0, 509, [1, 2, 3, 4]));
    });
});

describe("throttling", () => {
    it("calls every callback exactly once and sends the latest data", async () => {
        make();
        const calls = new Map<number, number>();
        const done = new Promise<void>((resolve) => {
            for (let i = 1; i <= 5; i++) {
                artnet.set(0, 1, i * 10, () => {
                    calls.set(i, (calls.get(i) ?? 0) + 1);
                    if (calls.size === 5) {
                        resolve();
                    }
                });
            }
        });
        await done;
        await sleep(60);

        assert.deepEqual(
            [...calls.entries()].sort((a, b) => a[0] - b[0]),
            [
                [1, 1],
                [2, 1],
                [3, 1],
                [4, 1],
                [5, 1],
            ],
        );
        assert.equal(rx.packets.length, 2, "first send + one merged send");
        assert.equal(rx.packets[1][HEADER], 50);
    });

    it("merges a refresh request into the queued send", async () => {
        make();
        artnet.set(0, 1, 1);
        artnet.set(0, 2, 2);
        artnet.send(0, true);
        await rx.waitFor(2);
        assert.equal(rx.packets[1].readUInt16BE(16), 512);
    });

    it("supports send(universe, callback)", async () => {
        make();
        const bytes = await new Promise<number | undefined>((resolve, reject) =>
            artnet.send(3, (err, n) => (err ? reject(err) : resolve(n))),
        );
        assert.equal(bytes, HEADER + 512);
    });

    it("calls back immediately when a single value is unchanged", async () => {
        make();
        await sent(0, 1, 7);
        const bytes = await sent(0, 1, 7);
        assert.equal(bytes, undefined);
        await sleep(40);
        assert.equal(rx.packets.length, 1);
    });
});

describe("keep-alive refresh", () => {
    it("re-sends an idle universe in full", async () => {
        make({ refresh: 60 });
        await sent(0, 1, 1);
        await rx.waitFor(2, 500);
        assert.equal(rx.packets[0].readUInt16BE(16), 2);
        assert.equal(rx.packets[1].readUInt16BE(16), 512);
    });

    it("does not refresh while the universe is actively sent", async () => {
        make({ refresh: 150 });
        for (let i = 0; i < 6; i++) {
            await sent(0, 1, i + 1);
            await sleep(40);
        }
        assert.ok(
            rx.packets.every((p) => p.readUInt16BE(16) === 2),
            "no full-universe refresh packets while active",
        );
    });

    it("unref option keeps timers from holding the process open", async () => {
        make({ refresh: 1000, unref: true });
        await sent(0, 1, 1);
        const timers = (
            artnet as unknown as { refreshTimers: Map<number, NodeJS.Timeout> }
        ).refreshTimers;
        assert.equal([...timers.values()][0].hasRef(), false);
    });
});

describe("ArtTrigger packet", () => {
    it("has the correct layout", async () => {
        make();
        artnet.trigger(0x1234, 7, 3);
        const [p] = await rx.waitFor(1);
        assert.equal(p.readUInt16LE(8), 0x9900);
        assert.deepEqual([p[10], p[11]], [0, 14]);
        assert.equal(p.readUInt16BE(14), 0x1234, "OEM");
        assert.equal(p[16], 3, "Key");
        assert.equal(p[17], 7, "SubKey");
        assert.equal(p.length, HEADER + 512);
    });

    it("defaults OEM to 0xFFFF and subKey to 0", async () => {
        make();
        artnet.trigger(2);
        const [p] = await rx.waitFor(1);
        assert.equal(p.readUInt16BE(14), 0xffff);
        assert.equal(p[16], 2);
        assert.equal(p[17], 0);
    });

    it("rejects out-of-range values", () => {
        make();
        assert.throws(() => artnet.trigger(0x10000, 0, 0), RangeError);
        assert.throws(() => artnet.trigger(256), RangeError);
    });
});

describe("ArtPoll packet", () => {
    it("is byte-exact: OpPoll, ProtVer 14, Flags 0, DiagPriority 0", () => {
        make();
        // Capture the poll without the network by intercepting transmit
        let packet: Buffer | undefined;
        const proto = artnet as unknown as {
            transmit: (s: unknown, b: Buffer, ...rest: unknown[]) => void;
        };
        proto.transmit = (_s, b) => {
            packet = b;
        };
        void artnet.discoverNodes(10, { address: "127.0.0.1" }).catch(() => {});
        return sleep(50).then(() => {
            assert.ok(packet, "poll was sent");
            assert.deepEqual(
                [...packet],
                [
                    0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00, 0x00, 0x20,
                    0x00, 0x0e, 0x00, 0x00,
                ],
            );
        });
    });
});

describe("parseArtPollReply", () => {
    it("bounds the short name to its 18-byte field", () => {
        const info = parseArtPollReply(
            buildPollReply({
                shortName: "EXACTLY18CHARSNAME",
                longName: "Long Name",
            }),
        );
        assert.equal(info.shortName, "EXACTLY18CHARSNAME");
        assert.equal(info.longName, "Long Name");
    });

    it("strips control and non-ASCII bytes", () => {
        const msg = buildPollReply({ shortName: "ab" });
        msg[28] = 0x07;
        msg[29] = 0xe9;
        msg[30] = 0x63;
        assert.equal(parseArtPollReply(msg).shortName, "abc");
    });

    it("only lists ports that exist, by direction", () => {
        const info = parseArtPollReply(
            buildPollReply({
                net: 1,
                sub: 2,
                numPorts: 2,
                portTypes: [0x80, 0x40],
                swIn: [5, 6, 7, 8],
                swOut: [1, 2, 3, 4],
            }),
        );
        assert.equal(info.portCount, 2);
        assert.deepEqual(info.universesOut, [(1 << 8) | (2 << 4) | 1]);
        assert.deepEqual(info.universesIn, [(1 << 8) | (2 << 4) | 6]);
        assert.equal(info.universe, info.universesIn[0]);
    });

    it("treats ports with empty PortTypes as both directions", () => {
        const info = parseArtPollReply(
            buildPollReply({ numPorts: 1, swIn: [3], swOut: [4] }),
        );
        assert.deepEqual(info.universesIn, [3]);
        assert.deepEqual(info.universesOut, [4]);
    });

    it("falls back to the first output universe when there are no inputs", () => {
        const info = parseArtPollReply(
            buildPollReply({ numPorts: 1, portTypes: [0x80], swOut: [9] }),
        );
        assert.deepEqual(info.universesIn, []);
        assert.equal(info.universe, 9);
    });

    it("caps portCount at 4 and survives short packets", () => {
        const info = parseArtPollReply(buildPollReply({ numPorts: 9 }));
        assert.equal(info.portCount, 4);
        const short = parseArtPollReply(buildPollReply({}).subarray(0, 40));
        assert.equal(short.portCount, 0);
        assert.deepEqual(short.universesOut, []);
    });
});

describe("discoverNodes", () => {
    async function replyFromFakeNode(packets: Buffer[]): Promise<void> {
        const node = createSocket("udp4");
        node.bind(0, "127.0.0.1");
        await once(node, "listening");
        await sleep(30);
        for (const p of packets) {
            node.send(p, 6454, "127.0.0.1");
        }
        await sleep(30);
        node.close();
    }

    it("merges replies from multiple bind indexes into one node", async () => {
        make();
        const discovery = artnet.discoverNodes(200, { address: "127.0.0.1" });
        const root = buildPollReply({
            shortName: "Gateway",
            numPorts: 4,
            portTypes: [0x80, 0x80, 0x80, 0x80],
            swOut: [0, 1, 2, 3],
            bindIndex: 1,
        });
        const second = buildPollReply({
            shortName: "Gateway",
            sub: 1,
            numPorts: 4,
            portTypes: [0x80, 0x80, 0x80, 0x80],
            swOut: [0, 1, 2, 3],
            bindIndex: 2,
        });
        await replyFromFakeNode([second, root, root]);
        const nodes = await discovery;

        assert.equal(nodes.length, 1);
        assert.equal(nodes[0].info.shortName, "Gateway");
        assert.equal(nodes[0].info.portCount, 8);
        assert.deepEqual(
            nodes[0].info.universesOut,
            [0, 1, 2, 3, 16, 17, 18, 19],
        );
    });

    it("uses the main socket in broadcast mode, right after construction", async () => {
        artnet = new Artnet({ host: "127.255.255.255", refresh: 0 });
        const discovery = artnet.discoverNodes(200);
        await replyFromFakeNode([buildPollReply({ shortName: "Main" })]);
        const nodes = await discovery;
        assert.equal(nodes.length, 1);
        assert.equal(nodes[0].info.shortName, "Main");
        const shared = (artnet as unknown as { discoverySocket: unknown })
            .discoverySocket;
        assert.equal(shared, null, "no extra socket was opened");
    });

    it("supports concurrent discoveries", async () => {
        make();
        const a = artnet.discoverNodes(200, { address: "127.0.0.1" });
        const b = artnet.discoverNodes(200, { address: "127.0.0.1" });
        await replyFromFakeNode([buildPollReply({ shortName: "Solo" })]);
        const [na, nb] = await Promise.all([a, b]);
        assert.equal(na.length, 1);
        assert.equal(nb.length, 1);
    });

    it("rejects instead of crashing when port 6454 is taken", async () => {
        const blocker = createSocket({ type: "udp4", reuseAddr: false });
        blocker.bind({ port: 6454, exclusive: true });
        await once(blocker, "listening");
        try {
            make();
            await assert.rejects(
                artnet.discoverNodes(100, { address: "127.0.0.1" }),
                /EADDRINUSE/,
            );
        } finally {
            blocker.close();
        }
    });

    it("resolves early when the instance is closed", async () => {
        make();
        const discovery = artnet.discoverNodes(5000, {
            address: "127.0.0.1",
        });
        await sleep(30);
        const started = Date.now();
        artnet.close();
        assert.deepEqual(await discovery, []);
        assert.ok(Date.now() - started < 500);
    });
});

describe("lifecycle", () => {
    it("close() is idempotent", () => {
        make();
        artnet.close();
        assert.doesNotThrow(() => artnet.close());
    });

    it("set/send/trigger after close report an error instead of throwing", async () => {
        make();
        artnet.close();
        const errors: string[] = [];
        const cb: ArtnetCallback = (err) => errors.push(err?.message ?? "");
        assert.equal(artnet.set(0, 1, 1, cb), false);
        artnet.send(0, cb);
        assert.equal(artnet.trigger(1, cb), false);
        assert.deepEqual(errors, [
            "Artnet instance is closed",
            "Artnet instance is closed",
            "Artnet instance is closed",
        ]);
        await assert.rejects(artnet.discoverNodes(10), /closed/);
    });

    it("fails queued callbacks on close so nothing hangs", async () => {
        make();
        artnet.set(0, 1, 1);
        const queued = new Promise<Error | null>((resolve) =>
            artnet.set(0, 1, 2, (err) => resolve(err)),
        );
        artnet.close();
        const err = await queued;
        assert.match(err?.message ?? "", /closed/);
    });

    it("send errors without a callback don't crash when nobody listens", async () => {
        make({ host: "127.0.0.1", port: 1 });
        // Port 0 is invalid for send; force a synchronous send failure
        (artnet as unknown as { port: number }).port = 0;
        artnet.trigger(1);
        await sleep(30);
    });

    it("send errors without a callback are emitted when someone listens", async () => {
        make();
        (artnet as unknown as { port: number }).port = 0;
        const error = once(artnet, "error");
        artnet.trigger(1);
        const [err] = await error;
        assert.ok(err instanceof Error);
    });
});

describe("broadcast", () => {
    it("can switch to a broadcast host after starting unicast", async () => {
        make();
        await sent(0, 1, 1);
        artnet.setHost("127.255.255.255");
        await sleep(40);
        const err = await new Promise<Error | null>((resolve) =>
            artnet.send(0, true, (e) => resolve(e)),
        );
        assert.equal(err, null);
    });
});
