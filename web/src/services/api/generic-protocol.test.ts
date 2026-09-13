import { describe, expect, it } from "vitest";

import { GENERIC_OPERATIONS, getGenericOperation } from "./generic-contract";
import { GENERIC_DOCUMENTED_MEDIA_MODEL_COUNT, GENERIC_MODEL_COUNT, GENERIC_MODEL_PROFILES } from "./generic-models";
import { assertGenericEnvelope, extractGenericCreateTaskIds, extractGenericOutputs, extractGenericText, normalizeGenericTaskResponse, parseGenericSse, pollPathForGenericTask } from "./generic-protocol";

describe("Generic official contract snapshot", () => {
    it("contains every documented operation without camelCase upstream action paths", () => {
        expect(GENERIC_OPERATIONS).toHaveLength(55);
        expect(GENERIC_OPERATIONS.filter((item) => item.group === "general")).toHaveLength(8);
        expect(GENERIC_OPERATIONS.filter((item) => item.group === "midjourney")).toHaveLength(16);
        expect(GENERIC_OPERATIONS.filter((item) => item.group === "suno")).toHaveLength(31);
        expect(new Set(GENERIC_OPERATIONS.map((item) => item.id)).size).toBe(55);
        expect(
            GENERIC_OPERATIONS.map((item) => item.path).filter((path) => /(?:uploadTask|coverSong|upsampleTags|stemsAll|generateMp4|fadeIn|fadeOut|removeSection|replaceMusic|adjustSpeed|alignedLyrics|addVocals|addInstrumental|addStem)/.test(path)),
        ).toEqual([]);
    });

    it("contains the 123 media model ids plus Kimi, Whisper and Suno", () => {
        expect(GENERIC_DOCUMENTED_MEDIA_MODEL_COUNT).toBe(123);
        expect(GENERIC_MODEL_COUNT).toBe(126);
        expect(GENERIC_MODEL_PROFILES).toHaveLength(126);
        expect(new Set(GENERIC_MODEL_PROFILES.map((item) => item.id)).size).toBe(126);
        expect(GENERIC_MODEL_PROFILES.find((item) => item.id === "kimi-k3")?.family).toBe("text");
        expect(GENERIC_MODEL_PROFILES.find((item) => item.id === "whisper-1")?.family).toBe("transcription");
        expect(GENERIC_MODEL_PROFILES.find((item) => item.id === "suno")?.family).toBe("music");
    });

    it("keeps cross-model defaults constraint-safe while retaining documented prompts", () => {
        expect(getGenericOperation("video.generate").defaultPayload).toEqual({ model: "", prompt: "@Text 1" });
        expect(getGenericOperation("suno.generate").requiredFields).toEqual(["version"]);
        expect(getGenericOperation("suno.generate").defaultPayload).toEqual(expect.objectContaining({ model: "suno", version: "v5.5", prompt: "@Text 1" }));
    });
});

describe("Generic family decoders", () => {
    it("extracts task ids from all documented create envelopes", () => {
        expect(extractGenericCreateTaskIds("video", { id: "vid_1", status: "queued" })).toEqual(["vid_1"]);
        expect(extractGenericCreateTaskIds("image", { id: "img_1", task_id: "img_1", status: "queued" })).toEqual(["img_1"]);
        expect(extractGenericCreateTaskIds("audio", { code: "success", data: [{ task_id: "aud_1", status: "submitted" }] })).toEqual(["aud_1"]);
        expect(extractGenericCreateTaskIds("midjourney", { code: 200, data: [{ status: "submitted", task_id: "mj_1" }] })).toEqual(["mj_1"]);
        expect(extractGenericCreateTaskIds("music", { code: 200, data: { id: "music_1", status: "submitted" } })).toEqual(["music_1"]);
    });

    it("normalizes video queued, completed and failed states", () => {
        expect(normalizeGenericTaskResponse("video", "vid_1", { id: "vid_1", status: "queued" }).phase).toBe("queued");
        expect(normalizeGenericTaskResponse("video", "vid_1", { id: "vid_1", status: "in_progress", progress: 0.4 }).progress).toBe(40);
        expect(normalizeGenericTaskResponse("video", "vid_1", { id: "vid_1", status: "completed", progress: 100, metadata: { url: "https://example/video.mp4" } }).phase).toBe("succeeded");
        const failed = normalizeGenericTaskResponse("video", "vid_1", { id: "vid_1", status: "failed", error: { code: "generation_failed", message: "failed" } });
        expect(failed.phase).toBe("failed");
        expect(failed.message).toBe("failed");
    });

    it("normalizes TaskDto, Suno and Midjourney status vocabularies", () => {
        expect(normalizeGenericTaskResponse("image", "img_1", { code: "success", data: { task_id: "img_1", status: "NOT_START" } }).phase).toBe("queued");
        expect(normalizeGenericTaskResponse("audio", "aud_1", { code: "success", data: { task_id: "aud_1", status: "IN_PROGRESS", progress: "55%" } }).progress).toBe(55);
        expect(normalizeGenericTaskResponse("music", "music_1", { code: 200, data: { task_id: "music_1", status: "completed", progress: 100, result: { music: [] } } }).phase).toBe("succeeded");
        expect(normalizeGenericTaskResponse("midjourney", "mj_1", { code: 200, data: { task_id: "mj_1", status: "MODAL" } }).phase).toBe("attention");
        const failed = normalizeGenericTaskResponse("midjourney", "mj_1", { code: 200, data: { task_id: "mj_1", status: "FAILURE", fail_reason: "rejected" } });
        expect(failed.phase).toBe("failed");
        expect(failed.message).toBe("rejected");
    });

    it("accepts each documented successful envelope and rejects explicit API failures", () => {
        expect(() => assertGenericEnvelope({ id: "vid_1" })).not.toThrow();
        expect(() => assertGenericEnvelope({ code: "success", data: {} })).not.toThrow();
        expect(() => assertGenericEnvelope({ code: 200, data: {} })).not.toThrow();
        expect(() => assertGenericEnvelope({ code: true, data: { amount: 0 } })).not.toThrow();
        expect(() => assertGenericEnvelope({ code: 401, message: "unauthorized" })).toThrow("unauthorized");
    });
});

describe("Generic result mapping", () => {
    it("maps video and last-frame URLs to their corresponding canvas media types", () => {
        const outputs = extractGenericOutputs({ id: "vid_1", status: "completed", metadata: { url: "https://example/video.mp4", last_frame_url: "https://example/last.png" } }, "video", "vid_1");
        expect(outputs.map((item) => [item.kind, item.url])).toEqual([
            ["video", "https://example/video.mp4"],
            ["image", "https://example/last.png"],
        ]);
    });

    it("maps nested image and audio TaskDto results", () => {
        const image = extractGenericOutputs({ code: "success", data: { status: "SUCCESS", data: { content: { image_url: "https://example/result.png" } } } }, "image");
        const audio = extractGenericOutputs({ code: "success", data: { status: "SUCCESS", data: { content: { audio_url: "https://example/result.wav" } } } }, "audio");
        expect(image.some((item) => item.kind === "image" && item.url?.endsWith("result.png"))).toBe(true);
        expect(audio.some((item) => item.kind === "audio" && item.url?.endsWith("result.wav"))).toBe(true);
    });

    it("expands Suno multi-track results and preserves audio indexes", () => {
        const raw = {
            code: 200,
            data: {
                task_id: "music_1",
                status: "completed",
                result: {
                    music: [
                        { audio_id: "a1", title: "Track 1", duration: 120, lyrics: "...", tags: "pop", audio_url: "https://example/a1.mp3", image_url: "https://example/a1.jpg", video_url: "https://example/a1.mp4" },
                        { audio_id: "a2", title: "Track 2", audio_url: "https://example/a2.mp3", image_url: "https://example/a2.jpg" },
                    ],
                },
            },
        };
        const outputs = extractGenericOutputs(raw, "audio", "music_1");
        expect(outputs.filter((item) => item.kind === "audio").map((item) => item.audioIndex)).toEqual([1, 2]);
        expect(outputs.some((item) => item.kind === "video" && item.url === "https://example/a1.mp4")).toBe(true);
        expect(outputs.some((item) => item.kind === "image" && item.url === "https://example/a1.jpg")).toBe(true);
        expect(outputs.find((item) => item.kind === "image" && item.url === "https://example/a2.jpg")?.audioIndex).toBe(2);
    });

    it("maps Midjourney images, video URL arrays and describe text", () => {
        const imageOutputs = extractGenericOutputs(
            { code: 200, data: { task_id: "mj_1", status: "SUCCESS", grid_image_url: "https://example/grid.jpg", image_urls: ["https://example/1.jpg", "https://example/2.jpg"], buttons: [{ customId: "U1" }] } },
            "image",
        );
        expect(imageOutputs.filter((item) => item.kind === "image")).toHaveLength(3);
        expect(imageOutputs.filter((item) => item.selectionIndex).map((item) => item.selectionIndex)).toEqual([1, 2]);
        const videoOutputs = extractGenericOutputs({ code: 200, data: { status: "SUCCESS", video_urls: ["https://example/1.mp4", "https://example/2.mp4"] } }, "video");
        expect(videoOutputs.filter((item) => item.kind === "video")).toHaveLength(2);
        expect(extractGenericOutputs({ code: 200, data: { status: "SUCCESS", prompt: "a detailed description" } }, "text")[0]?.text).toBe("a detailed description");
    });

    it("extracts chat reasoning/content and synchronous Suno tags", () => {
        expect(extractGenericText({ choices: [{ message: { content: "answer", reasoning_content: "reasoning" } }] })).toBe("思考过程：\nreasoning\n\nanswer");
        expect(extractGenericText({ code: 200, data: { result: { upsampled_tags: "cinematic pop" } } })).toBe("cinematic pop");
    });
});

describe("Generic transport helpers", () => {
    it("uses only canonical task query paths", () => {
        expect(pollPathForGenericTask("video", "a/b")).toBe("/v1/videos/a%2Fb");
        expect(pollPathForGenericTask("image", "1")).toBe("/v1/image/generations/1");
        expect(pollPathForGenericTask("audio", "1")).toBe("/v1/audio/generations/1");
        expect(pollPathForGenericTask("midjourney", "1")).toBe("/v1/midjourney/tasks/1");
        expect(pollPathForGenericTask("music", "1")).toBe("/v1/music/tasks/1");
    });

    it("parses Chat Completions SSE and ignores malformed frames", () => {
        const sse = [
            'data: {"choices":[{"delta":{"reasoning_content":"rea"}}]}',
            "",
            "data: malformed",
            "",
            'data: {"choices":[{"delta":{"reasoning_content":"son","content":"ans"}}]}',
            "",
            'data: {"choices":[{"delta":{"content":"wer"}}]}',
            "",
            "data: [DONE]",
        ].join("\n");
        expect(parseGenericSse(sse)).toEqual({ content: "answer", reasoning: "reason", text: "思考过程：\nreason\n\nanswer" });
    });
});
