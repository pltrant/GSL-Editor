import * as assert from "assert";

import { EAccessClient } from "../../gsl/eaccessClient";

suite("EAccessClient.quickLogin", () => {
    const originalConnect = EAccessClient.prototype.connect;
    const originalTimeout = EAccessClient.quickLoginTimeoutMillis;

    teardown(() => {
        EAccessClient.prototype.connect = originalConnect;
        EAccessClient.quickLoginTimeoutMillis = originalTimeout;
    });

    function quickLogin(): Promise<unknown> {
        return EAccessClient.quickLogin(
            "account",
            "password",
            "GS4D",
            "character",
            "storm",
        );
    }

    test("rejects when the connection closes before login completes", async () => {
        EAccessClient.prototype.connect = function (this: EAccessClient) {
            this.emit("close");
        };

        await assert.rejects(quickLogin(), /closed before login completed/);
    });

    test("does not let a stalled login block later logins", async () => {
        EAccessClient.quickLoginTimeoutMillis = 20;
        let attempts = 0;
        EAccessClient.prototype.connect = function (this: EAccessClient) {
            if (++attempts > 1) {
                this.emit("close");
            } // First attempt never responds
        };
        const stalled = quickLogin();
        const next = quickLogin();

        await assert.rejects(stalled, /timed out after 20ms/);
        await assert.rejects(next, /closed before login completed/);
    });
});
