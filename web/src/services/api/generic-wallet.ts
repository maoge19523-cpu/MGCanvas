export const GENERIC_WALLET_REFRESH_EVENT = "mgcanvas:generic-wallet-refresh";

export type GenericWalletSummary = {
    amount: number;
    usedAmount?: number;
    currency: string;
};

/** Decode only the documented wallet response envelope. */
export function parseGenericWalletSummary(raw: unknown): GenericWalletSummary | null {
    if (!raw || typeof raw !== "object") return null;
    const envelope = raw as Record<string, unknown>;
    if (envelope.code !== true || !envelope.data || typeof envelope.data !== "object") return null;
    const data = envelope.data as Record<string, unknown>;
    if (data.object !== "wallet_balance" || typeof data.amount !== "number" || typeof data.display_type !== "string") return null;
    return {
        amount: data.amount,
        usedAmount: typeof data.used_amount === "number" ? data.used_amount : undefined,
        currency: data.display_type,
    };
}

export function formatGenericWalletAmount(value: number) {
    return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

/** Notify the canvas shell after a node task has returned its final result. */
export function requestGenericWalletRefresh() {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(GENERIC_WALLET_REFRESH_EVENT));
}
