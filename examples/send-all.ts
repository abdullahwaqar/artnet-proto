import { Artnet } from "../src/index";

(async () => {
    const artnet = new Artnet({
        host: "255.255.255.255",
        port: 6454,
        refresh: 4000,
        sendAll: false,
    });

    console.log("Discovering Art-Net nodes…");
    const nodes = await artnet.discoverNodes(1500);

    if (nodes.length === 0) {
        console.warn(
            "No Art-Net nodes discovered. Falling back to universes 0–7 (broadcast).",
        );
    } else {
        console.log(`Discovered ${nodes.length} node(s):`);
        for (const n of nodes) {
            console.log(
                `- ${n.info.shortName} (${n.info.longName}) @ ${n.ip}\n` +
                    `  Ports: ${n.info.portCount}\n` +
                    `  universesIn:  [${n.info.universesIn?.join(", ")}]\n` +
                    `  universesOut: [${n.info.universesOut?.join(", ")}]`,
            );
        }
    }

    // Prefer discovered output universes; fallback 0..7
    const discoveredOutUniverses = [
        ...new Set(nodes.flatMap((n) => n.info.universesOut ?? [])),
    ].filter((u) => typeof u === "number");

    const targetUniverses =
        discoveredOutUniverses.length > 0
            ? discoveredOutUniverses
            : Array.from({ length: 8 }, (_, i) => i);

    console.log(
        `Target universes: [${targetUniverses.join(", ")}] ` +
            (artnet["host"] === "255.255.255.255"
                ? "(broadcast)"
                : "(unicast)"),
    );

    // --- DMX values ---
    const values = new Array(512).fill(0);

    // Colour palette (RGB triplets). Extend as you like.
    const colors: [number, number, number][] = [
        [255, 0, 0], // red
        [0, 255, 0], // green
        [0, 0, 255], // blue
        [255, 255, 255], // white
    ];
    let colorIndex = 0;

    // Change colour every 2 seconds
    const colorInterval = setInterval(() => {
        colorIndex = (colorIndex + 1) % colors.length;
        console.log(`\nSwitched to colour: ${colors[colorIndex]}`);
    }, 2000);

    // Slide the pattern so we eventually line up with any 3ch/4ch start address
    let patternOffset = 0;
    const patternInterval = setInterval(() => {
        patternOffset = (patternOffset + 1) % 4; // 0..3
    }, 500); // shift every 0.5s

    // Send at ~25 fps
    const tick = () => {
        const [r, g, b] = colors[colorIndex];

        // Fill all 512 channels with a repeating 4-ch pattern [Dimmer, R, G, B] but
        // shift it by patternOffset so we periodically match any fixture's start.
        // This lights:
        // - 4ch fixtures (Dimmer+RGB) when aligned
        // - 3ch fixtures (RGB) when their R/G/B land on the R/G/B steps.
        values.fill(0);
        for (let ch = 1; ch <= 512; ch++) {
            const j = (ch - 1 + patternOffset) % 4;
            if (j === 0) {
                values[ch - 1] = 255; // Master dimmer full
            } else if (j === 1) {
                values[ch - 1] = r;
            } else if (j === 2) {
                values[ch - 1] = g;
            } else if (j === 3) {
                values[ch - 1] = b;
            }
        }

        for (const uni of targetUniverses) {
            artnet.set(uni, 1, values, (err, bytes) => {
                if (err) {
                    console.error(`Error sending to universe ${uni}:`, err);
                    return;
                }

                // bytes may be undefined on some Node/OS combos
                if (typeof bytes === "number" && bytes !== 530) {
                    console.warn(
                        `Universe ${uni}: sent ${bytes} bytes (expected 530)`,
                    );
                }
            });
        }
    };
    const frameInterval = setInterval(tick, 40);

    console.log(
        "Streaming DMX at ~25fps; colour changes every 2s; sliding pattern to hit any address. Ctrl+C to stop.",
    );

    const shutdown = () => {
        clearInterval(frameInterval);
        clearInterval(colorInterval);
        clearInterval(patternInterval);
        artnet.close();
        console.log("\nStopped. Socket closed.");
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
})();
