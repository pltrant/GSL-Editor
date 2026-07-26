import * as assert from "assert";

import {
    ServerConnection,
    ServerConnectionMode,
} from "../../gsl/serverConnection";

suite("ServerConnection", () => {
    function receive(connection: ServerConnection, text: string): void {
        (
            connection as unknown as {
                socketData(data: Buffer): void;
            }
        ).socketData(Buffer.from(text));
    }

    test("enters game mode when the marker is embedded in settings", () => {
        const markers = [
            '<mode id="GAME"/>\n',
            '<mode id="GAME"/><settingsInfo client="1.0"/>' +
                '<settings client="1.0"><stream id="main"/></settings>\n',
            "<mode id='GAME' /><settings></settings>\r\n",
        ];

        for (const marker of markers) {
            const connection = new ServerConnection({
                key: "test",
                host: "localhost",
                port: 0,
            });
            const modes: ServerConnectionMode[] = [];
            const text: string[] = [];
            connection.on("mode", (mode) => modes.push(mode));
            connection.on("text", (data) => text.push(data));

            receive(connection, marker);
            receive(connection, "ready>");

            assert.deepStrictEqual(modes, [ServerConnectionMode.Unbuffered]);
            assert.deepStrictEqual(text, ["ready>"]);
        }
    });

    test("detects an embedded game marker split across socket data", () => {
        const connection = new ServerConnection({
            key: "test",
            host: "localhost",
            port: 0,
        });
        const modes: ServerConnectionMode[] = [];
        const text: string[] = [];
        connection.on("mode", (mode) => modes.push(mode));
        connection.on("text", (data) => text.push(data));

        receive(connection, '<mode id="GA');
        receive(connection, 'ME"/><settings><stream id="main"/>');
        receive(connection, "</settings>");
        assert.deepStrictEqual(modes, []);

        receive(connection, "\n");
        receive(connection, "ready>");

        assert.deepStrictEqual(modes, [ServerConnectionMode.Unbuffered]);
        assert.deepStrictEqual(text, ["ready>"]);
    });
});
