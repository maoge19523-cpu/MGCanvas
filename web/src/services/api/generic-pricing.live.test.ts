import { describe, expect, it } from "vitest";

import { formatGenericPriceQuote, parseGenericPricingCatalog, quoteGenericPrice, resolveGenericPricingUrl } from "./generic-pricing";

const liveBaseUrl = process.env.GENERIC_LIVE_PRICING_BASE_URL || "";
const live = process.env.GENERIC_LIVE_PRICING === "1" ? describe : describe.skip;

live("Generic live pricing contract", () => {
    it("quotes representative image, video, audio and Midjourney parameters from the current official feed", async () => {
        const pricingUrl = resolveGenericPricingUrl(liveBaseUrl);
        expect(pricingUrl).not.toBe("");
        const response = await fetch(pricingUrl, { headers: { Accept: "application/json" } });
        expect(response.ok).toBe(true);
        const catalog = parseGenericPricingCatalog(await response.json());

        expect(catalog.pricingVersion).not.toBe("");
        expect(Object.keys(catalog.observedPrices).length).toBeGreaterThan(50);
        expect(Object.values(catalog.priceEstimates).filter((profile) => profile.status === "ready").length).toBeGreaterThan(20);

        const image = quoteGenericPrice(catalog, "image.generate", { model: "qwen-image-3.0-global-pro-i2i", n: 4, metadata: { resolution: "1k" } }, { imageReferences: 1 });
        expect(image).toEqual(expect.objectContaining({ source: "estimate", status: "exact" }));
        expect(image.amount).toBeGreaterThan(0);

        const video = quoteGenericPrice(catalog, "video.generate", { model: "generic-video-gk-v15", seconds: "8", metadata: { resolution: "720p" } });
        expect(video).toEqual(expect.objectContaining({ source: "estimate", status: "range" }));
        expect(video.max).toBeGreaterThanOrEqual(video.min || 0);

        const seedance = quoteGenericPrice(catalog, "video.generate", { model: "seedance-2.5-standard-t2v", seconds: "6", metadata: { resolution: "720p", generate_audio: true } });
        expect(seedance).toEqual(expect.objectContaining({ status: "range", currency: "CNY" }));
        expect(formatGenericPriceQuote(seedance)).not.toContain("Token");

        const audio = quoteGenericPrice(catalog, "audio.generate", { model: "doubao-seed-audio-1.0" }, { audioReferences: 2 });
        expect(audio).toEqual(expect.objectContaining({ source: "estimate", status: "range" }));

        const midjourney = quoteGenericPrice(catalog, "midjourney.imagine", { speed: "fast", hd: true });
        expect(midjourney).toEqual(expect.objectContaining({ source: "estimate", status: "range" }));
    });
});
