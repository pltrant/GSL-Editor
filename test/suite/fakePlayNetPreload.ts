// Preloaded into a spawned daemon: answers the play.net login in-process
// and sends the game connection to FAKE_GAME_PORT, so no test reaches a
// live server.
import * as fs from "fs";
import * as path from "path";
import tls = require("tls");
import { Duplex } from "stream";

// The client checks the server's pinned public key.
const [, pubkey] = /const PUBKEY =\s*"([0-9a-f]+)"/.exec(
    fs.readFileSync(
        path.resolve(__dirname, "../../gsl/eaccessClient.ts"),
        "utf8",
    ),
)!;

function reply(command: string): string {
    switch (command[0]) {
        case "K":
            return "hashhashhashhashhashhashhashhash";
        case "A":
            return "A\tTEST\tKEY\tkey\towner\n";
        case "M":
            return "M\tGS4D\tGemStone IV Development\n";
        case "F":
            return "F\tNORMAL\n";
        case "G":
            return "G\tGemStone IV Development\t0\n";
        case "N":
            return "N\tDEVELOPMENT\n";
        case "C":
            return "C\t1\t1\t0\t0\tW_TEST_000\tTestChar\n";
        case "L":
            return `L\tOK\tGAMEHOST=127.0.0.1\tGAMEPORT=${process.env.FAKE_GAME_PORT}\tKEY=key\n`;
        default:
            throw new Error(`Unexpected play.net command: ${command}`);
    }
}

(tls as any).connect = (...args: unknown[]) => {
    const socket = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
            socket.push(reply(chunk.toString()));
            callback();
        },
    });
    Object.assign(socket, {
        getPeerCertificate: () => ({ pubkey: Buffer.from(pubkey, "hex") }),
    });
    const onSecureConnect = args.find((arg) => typeof arg === "function");
    process.nextTick(onSecureConnect as () => void);
    return socket;
};
