import { describe, expect, it } from "vitest";

import { parseGenericWalletSummary } from "./generic-wallet";

describe("parseGenericWalletSummary", () => {
    it("accepts the documented wallet balance envelope", () => {
        expect(
            parseGenericWalletSummary({
                code: true,
                data: { object: "wallet_balance", amount: 12.3456, used_amount: 3.2, display_type: "USD" },
            }),
        ).toEqual({ amount: 12.3456, usedAmount: 3.2, currency: "USD" });
    });

    it("rejects envelopes that do not match the documented contract", () => {
        expect(parseGenericWalletSummary({ code: 200, data: { amount: 12.34, display_type: "USD" } })).toBeNull();
        expect(parseGenericWalletSummary({ code: true, data: { object: "wallet_balance", amount: "12.34", display_type: "USD" } })).toBeNull();
    });
});
