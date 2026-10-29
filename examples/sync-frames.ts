import { Artnet } from "../src/index";

// Frame-synced output across several universes with stage() + commit().
// Every frame, all universes are sent and then one ArtSync, so nodes that
// support ArtSync switch every universe at the same moment (no tearing on
// fixtures or pixel strips that span universes).

const artnet = new Artnet({
    host: "255.255.255.255", // ArtSync is always broadcast
    refresh: 1000,
});
artnet.on("error", (err) => console.error("Art-Net error:", err));

const UNIVERSES = [0, 1, 2, 3];
const PIXELS_PER_UNIVERSE = 170; // 170 RGB pixels = 510 channels
let frame = 0;

const tick = async () => {
    frame++;
    const values = new Array(PIXELS_PER_UNIVERSE * 3).fill(0);

    for (const [i, universe] of UNIVERSES.entries()) {
        values.fill(0);
        // A dot that travels across all universes as if they were one strip
        const total = UNIVERSES.length * PIXELS_PER_UNIVERSE;
        const pos = frame % total;
        const local = pos - i * PIXELS_PER_UNIVERSE;
        if (local >= 0 && local < PIXELS_PER_UNIVERSE) {
            values[local * 3] = 255; // red
        }
        artnet.stage(universe, 1, values);
    }

    try {
        await artnet.commit(); // all universes, then ArtSync
    } catch (err) {
        console.error("Frame send failed:", err);
    }
};

const interval = setInterval(tick, 25); // 40fps
console.log(
    `Sending synced frames to universes [${UNIVERSES.join(", ")}]. Ctrl+C to stop.`,
);

const shutdown = () => {
    clearInterval(interval);
    artnet.close();
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
