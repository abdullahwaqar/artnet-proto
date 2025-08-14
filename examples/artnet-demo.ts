import { Artnet } from "../src/index";

// Create an Artnet instance (default broadcast to all universes)
const artnet = new Artnet({
    host: "255.255.255.255", // broadcast
    port: 6454, // default Art-Net port
    refresh: 4000, // resend every 4s
    sendAll: false,
});

let c = 0;

// Send to all 512 channels in universes 0–7 at ~25fps
setInterval(() => {
    if (++c > 255) {
        c = 0;
    }

    console.log(`Sending ${c} to all channels in all universes`);

    for (let i = 0; i < 8; i++) {
        // Create array of [c, c, c, ..., c]
        const values = new Array(512).fill(c);

        artnet.set(i, 1, values, (err, res) => {
            if (err) {
                console.error(`Error sending to universe ${i}:`, err);
            } else if (res === 530) {
                // `res` is number of bytes sent — 530 = header (18 bytes) + 512 DMX bytes
                console.log(`Sent ${c} to all channels in universe ${i}`);
            } else {
                console.error(
                    `Error sending to universe ${i}: only ${res} bytes were sent`,
                );
            }
        });
    }
}, 40);
