import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Artnet } from "../src/index";
import { createReceiver, type Receiver, sleep } from "./helpers";

const HEADER = 18;
const OP_DMX = 0x5000;
const OP_SYNC = 0x5200;

let rx: Receiver;
let artnet: Artnet;

/** Unicast to the receiver; ArtSync goes there too via syncAddress. */
function make(config: ConstructorParameters<typeof Artnet>[0] = {}): Artnet {
    artnet = new Artnet({
        host: "127.0.0.1",
        port: rx.port,
        refresh: 0,
        syncAddress: "127.0.0.1",
        ...config,
    });
    return artnet;
}

const opcode = (p: Buffer) => p.readUInt16LE(8);
const isSync = (p: Buffer) => opcode(p) === OP_SYNC;
const universeOf = (p: Buffer) => p[14] | (p[15] << 8);

/** Capture every transmit without touching the network. */
function captureTransmits(a: Artnet): { buf: Buffer; address: string }[] {
    const out: { buf: Buffer; address: string }[] = [];
    const target = a as unknown as {
        transmit: (
            s: unknown,
            b: Buffer,
            port: number,
            address: string,
            cbs: ((e: Error | null, n?: number) => void)[],
        ) => void;
    };
    target.transmit = (_s, buf, _port, address, cbs) => {
        out.push({ buf, address });
        for (const cb of cbs) {
            cb(null, buf.length);
        }
    };
    return out;
}

beforeEach(async () => {
    rx = await createReceiver();
});

afterEach(() => {
    artnet?.close();
    rx.close();
});

describe("sequence numbers", () => {
    it("counts 1, 2, 3 per universe, independently", async () => {
        make();
        for (let i = 0; i < 3; i++) {
            artnet.send(0);
            artnet.send(1);
            await sleep(35);
        }
        await rx.waitFor(6);
        const seqs = (u: number) =>
            rx.packets.filter((p) => universeOf(p) === u).map((p) => p[12]);
        assert.deepEqual(seqs(0), [1, 2, 3]);
        assert.deepEqual(seqs(1), [1, 2, 3]);
    });

    it("wraps from 255 to 1, never 0", () => {
        make();
        const sent = captureTransmits(artnet);
        (artnet as unknown as { sequences: Map<number, number> }).sequences.set(
            0,
            254,
        );
        artnet.stage(0, 1, 1);
        void artnet.commit({ sync: false });
        artnet.stage(0, 1, 2);
        void artnet.commit({ sync: false });
        artnet.stage(0, 1, 3);
        void artnet.commit({ sync: false });
        assert.deepEqual(
            sent.map((s) => s.buf[12]),
            [255, 1, 2],
        );
    });

    it("sends 0 when disabled", async () => {
        make({ sequence: false });
        artnet.send(0);
        await sleep(35);
        artnet.send(0);
        await rx.waitFor(2);
        assert.deepEqual(
            rx.packets.map((p) => p[12]),
            [0, 0],
        );
    });

    it("keep-alive packets get the next sequence number too", async () => {
        make({ refresh: 60 });
        artnet.set(0, 1, 1);
        await rx.waitFor(2, 500);
        assert.deepEqual(
            rx.packets.map((p) => p[12]),
            [1, 2],
        );
    });
});

describe("ArtSync packet", () => {
    it("is byte-exact: OpSync, ProtVer 14, Aux1 0, Aux2 0", async () => {
        make();
        artnet.sync();
        const [p] = await rx.waitFor(1);
        assert.deepEqual(
            [...p],
            [
                0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00, 0x00, 0x52,
                0x00, 0x0e, 0x00, 0x00,
            ],
        );
    });

    it("is broadcast: host when broadcast, else 255.255.255.255, or syncAddress", () => {
        const a = new Artnet({ host: "10.0.0.255", refresh: 0 });
        const b = new Artnet({ host: "10.0.0.5", refresh: 0 });
        const c = new Artnet({
            host: "10.0.0.5",
            syncAddress: "2.255.255.255",
            refresh: 0,
        });
        try {
            const sentA = captureTransmits(a);
            const sentB = captureTransmits(b);
            const sentC = captureTransmits(c);
            a.sync();
            b.sync();
            c.sync();
            assert.equal(sentA[0].address, "10.0.0.255");
            assert.equal(sentB[0].address, "255.255.255.255");
            assert.equal(sentC[0].address, "2.255.255.255");
        } finally {
            a.close();
            b.close();
            c.close();
        }
    });

    it("sync() after close reports an error", () => {
        make();
        artnet.close();
        let error: Error | null = null;
        artnet.sync((err) => {
            error = err;
        });
        assert.match(String(error), /closed/);
    });
});

describe("stage() and commit()", () => {
    it("stage() sends nothing on its own", async () => {
        make();
        artnet.stage(0, 1, [1, 2, 3]);
        artnet.stage(1, 1, 9);
        await sleep(60);
        assert.equal(rx.packets.length, 0);
    });

    it("commit() sends staged universes in order, then one ArtSync", async () => {
        make();
        artnet.stage(5, 1, [1, 2]);
        artnet.stage(2, 3, 7);
        await artnet.commit();
        await rx.waitFor(3);

        assert.equal(rx.packets.length, 3);
        const [a, b, sync] = rx.packets;
        assert.equal(opcode(a), OP_DMX);
        assert.equal(universeOf(a), 2);
        assert.equal(a[HEADER + 2], 7);
        assert.equal(universeOf(b), 5);
        assert.deepEqual([...b.subarray(HEADER, HEADER + 2)], [1, 2]);
        assert.ok(isSync(sync));
    });

    it("commit({ sync: false }) skips the ArtSync", async () => {
        make();
        artnet.stage(0, 1, 1);
        await artnet.commit({ sync: false });
        await sleep(30);
        assert.equal(rx.packets.length, 1);
        assert.ok(!isSync(rx.packets[0]));
    });

    it("commit() with nothing staged sends nothing", async () => {
        make();
        await artnet.commit();
        await sleep(30);
        assert.equal(rx.packets.length, 0);
    });

    it("commit({ universes }) sends listed universes in full even if unchanged", async () => {
        make();
        artnet.set(3, 1, 4);
        await rx.waitFor(1);
        await artnet.commit({ universes: [3] });
        await rx.waitFor(3);
        const full = rx.packets[1];
        assert.equal(universeOf(full), 3);
        assert.equal(full.readUInt16BE(16), 512);
        assert.equal(full[HEADER], 4);
        assert.ok(isSync(rx.packets[2]));
    });

    it("commit() validates universes", () => {
        make();
        assert.throws(() => artnet.commit({ universes: [40000] }), RangeError);
    });

    it("stage() validates like set()", () => {
        make();
        assert.throws(() => artnet.stage(0, 0, 1), RangeError);
        assert.throws(() => artnet.stage(0, 510, [1, 2, 3, 4]), RangeError);
        assert.throws(() => artnet.stage(32768, 1, 1), RangeError);
    });

    it("commit() folds in a send queued by set(), calling its callback once", async () => {
        make();
        artnet.set(0, 1, 1);
        let calls = 0;
        artnet.set(0, 1, 2, () => {
            calls++;
        });
        await artnet.commit();
        await sleep(60);

        assert.equal(calls, 1);
        // set() packet, commit packet, ArtSync; no late throttled packet
        assert.equal(rx.packets.length, 3);
        assert.equal(rx.packets[1][HEADER], 2);
        assert.ok(isSync(rx.packets[2]));
    });

    it("commit() rejects after close, stage() returns false", async () => {
        make();
        artnet.close();
        assert.equal(artnet.stage(0, 1, 1), false);
        await assert.rejects(artnet.commit(), /closed/);
    });

    it("commit() rejects on a send error", async () => {
        make();
        (artnet as unknown as { port: number }).port = 0;
        artnet.stage(0, 1, 1);
        await assert.rejects(artnet.commit());
    });
});

describe("keep-alive with staged data", () => {
    it("re-sends what nodes last received, not uncommitted changes", async () => {
        make({ refresh: 60 });
        artnet.set(0, 1, 10);
        await rx.waitFor(1);
        artnet.stage(0, 1, 99);
        await rx.waitFor(2, 500);
        assert.equal(rx.packets[1].readUInt16BE(16), 512);
        assert.equal(rx.packets[1][HEADER], 10, "staged value leaked");

        await artnet.commit({ sync: false });
        const last = (await rx.waitFor(3)).at(-1) as Buffer;
        assert.equal(last[HEADER], 99);
    });
});

describe("synchronous mode", () => {
    it("set() after a commit is followed by an ArtSync", async () => {
        make();
        artnet.stage(0, 1, 1);
        await artnet.commit();
        await rx.waitFor(2);
        await sleep(30);
        artnet.set(1, 1, 5);
        await rx.waitFor(4);
        assert.equal(universeOf(rx.packets[2]), 1);
        assert.ok(isSync(rx.packets[3]));
    });

    it("keep-alive in sync mode is followed by an ArtSync", async () => {
        make({ refresh: 60 });
        artnet.stage(0, 1, 1);
        await artnet.commit();
        await rx.waitFor(4, 500);
        assert.equal(rx.packets[2].readUInt16BE(16), 512, "keep-alive");
        assert.ok(isSync(rx.packets[3]));
    });

    it("set() is not followed by an ArtSync once sync mode has timed out", async () => {
        make();
        artnet.sync();
        await rx.waitFor(1);
        (artnet as unknown as { lastSyncAt: number }).lastSyncAt =
            Date.now() - 5000;
        artnet.set(0, 1, 1);
        await rx.waitFor(2);
        await sleep(30);
        assert.equal(rx.packets.length, 2);
        assert.ok(!isSync(rx.packets[1]));
    });

    it("set() without any prior sync never sends an ArtSync", async () => {
        make();
        artnet.set(0, 1, 1);
        await rx.waitFor(1);
        await sleep(30);
        assert.equal(rx.packets.length, 1);
    });
});
