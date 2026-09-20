import { describe, expect, it } from "vitest";

import { inferComfyStartupStage, summarizeComfyDevice, summarizeComfyModelCounts, type ComfyEnvironmentLogEntry, type ComfyEnvironmentStatus, type ComfyObjectInfo } from "./index";

const log = (message: string): ComfyEnvironmentLogEntry => ({ timestamp: 0, stream: "stdout", message });

const status = (value: Partial<ComfyEnvironmentStatus>): ComfyEnvironmentStatus => ({ phase: "idle", ...value });

describe("ComfyUI 运行环境摘要", () => {
    it("从 object_info 统计各类模型数量", () => {
        const counts = summarizeComfyModelCounts({
            CheckpointLoaderSimple: { input: { required: { ckpt_name: [["a.safetensors", "b.safetensors"]] } } },
            LoraLoader: { input: { required: { lora_name: [["x.safetensors"]] } } },
            VAELoader: { input: { required: { vae_name: [[]] } } },
        } as unknown as ComfyObjectInfo);

        expect(counts).toEqual([
            { key: "checkpoints", count: 2 },
            { key: "diffusion", count: 0 },
            { key: "textEncoders", count: 0 },
            { key: "vaes", count: 0 },
            { key: "loras", count: 1 },
        ]);
    });

    it("没有该节点时按 0 计", () => {
        expect(summarizeComfyModelCounts({} as ComfyObjectInfo).every((item) => item.count === 0)).toBe(true);
    });

    it("把显卡名精简成用户认得的型号并换算显存", () => {
        const device = summarizeComfyDevice({
            devices: [{ name: "cuda:0 NVIDIA GeForce RTX 4070 : cudaMallocAsync", vram_total: 12884901888, vram_free: 10737418240 }],
        });

        expect(device).toEqual({ name: "NVIDIA GeForce RTX 4070", vramTotalGb: 12, vramFreeGb: 10 });
    });

    it("没有显卡信息时返回空", () => {
        expect(summarizeComfyDevice({ devices: [] })).toBeNull();
        expect(summarizeComfyDevice(null)).toBeNull();
    });

    it("运行中直接判定为就绪", () => {
        expect(inferComfyStartupStage([], status({ phase: "running" }))).toBe("ready");
        expect(inferComfyStartupStage([log("loading model")], status({ phase: "running" }))).toBe("ready");
    });

    it("失败时判定为失败", () => {
        expect(inferComfyStartupStage([], status({ phase: "failed" }))).toBe("failed");
    });

    it("只有进程没有日志时停在启动进程阶段", () => {
        expect(inferComfyStartupStage([], { phase: "starting", pid: 123 })).toBe("process");
        expect(inferComfyStartupStage([], { phase: "starting" })).toBe("checking");
    });

    it("按日志推进到加载节点与等待网页端", () => {
        expect(inferComfyStartupStage([log("Import times for custom nodes")], { phase: "starting", pid: 1 })).toBe("loading");
        expect(inferComfyStartupStage([log("Loading model checkpoint")], { phase: "starting", pid: 1 })).toBe("loading");
        expect(inferComfyStartupStage([log("To see the GUI go to: http://127.0.0.1:8188")], { phase: "starting", pid: 1 })).toBe("endpoint");
    });

    it("启动完成后出现的加载字样不会把阶段退回去", () => {
        const logs = [log("Import times for custom nodes"), log("Starting server"), log("checkpoint loaded")];
        expect(inferComfyStartupStage(logs, { phase: "starting", pid: 1 })).toBe("loading");
    });
});
