import { describe, expect, it } from "vitest";

import { inspectComfyWorkflow, type ComfyApiWorkflow, type ComfyObjectInfo, type ComfyObjectInfoNode } from "./index";

const workflow = (nodes: ComfyApiWorkflow): ComfyApiWorkflow => nodes;

const objectInfo = (nodes: Record<string, ComfyObjectInfoNode>): ComfyObjectInfo => nodes;

const loader = (field: string, options: string[]): ComfyObjectInfoNode => ({
    input: { required: { [field]: [options] } },
});

describe("ComfyUI 工作流依赖诊断", () => {
    it("缺节点时按 class_type 报出来", () => {
        const inspection = inspectComfyWorkflow(
            workflow({
                "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "base.safetensors" } },
                "2": { class_type: "IPAdapterPlus", inputs: { weight: 1 } },
            }),
            objectInfo({ CheckpointLoaderSimple: loader("ckpt_name", ["base.safetensors"]) }),
        );

        expect(inspection.missingClassTypes).toEqual(["IPAdapterPlus"]);
        expect(inspection.missingFiles).toEqual([]);
        expect(inspection.runnable).toBe(false);
    });

    it("缺模型时报出文件名", () => {
        const inspection = inspectComfyWorkflow(
            workflow({ "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl.safetensors" } } }),
            objectInfo({ CheckpointLoaderSimple: loader("ckpt_name", ["sd15.safetensors"]) }),
        );

        expect(inspection.missingFiles).toEqual(["sdxl.safetensors"]);
        expect(inspection.runnable).toBe(false);
    });

    it("模型存在时视为可运行", () => {
        const inspection = inspectComfyWorkflow(
            workflow({ "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd15.safetensors" } } }),
            objectInfo({ CheckpointLoaderSimple: loader("ckpt_name", ["sd15.safetensors"]) }),
        );

        expect(inspection.missingFiles).toEqual([]);
        expect(inspection.runnable).toBe(true);
    });

    it("不把采样器这类普通枚举误判成缺模型", () => {
        const inspection = inspectComfyWorkflow(
            workflow({ "3": { class_type: "KSampler", inputs: { sampler_name: "euler", scheduler: "missing_scheduler" } } }),
            objectInfo({
                KSampler: {
                    input: {
                        required: {
                            sampler_name: [["euler", "dpmpp_2m"]],
                            scheduler: [["normal", "karras"]],
                        },
                    },
                },
            }),
        );

        expect(inspection.missingFiles).toEqual([]);
        // 取值不在清单里，但由于清单不含模型文件、字段也不是空清单，不应报成缺模型。
        expect(inspection.runnable).toBe(true);
    });

    it("本机一个模型都没装时靠字段名判断", () => {
        const inspection = inspectComfyWorkflow(
            workflow({
                "1": { class_type: "LoraLoader", inputs: { lora_name: "add_detail.safetensors" } },
                "2": { class_type: "VAELoader", inputs: { vae_name: "sdxl_vae.safetensors" } },
            }),
            objectInfo({ LoraLoader: loader("lora_name", []), VAELoader: loader("vae_name", []) }),
        );

        expect(inspection.missingFiles).toEqual(["add_detail.safetensors", "sdxl_vae.safetensors"]);
        expect(inspection.runnable).toBe(false);
    });

    it("空清单但字段不是模型槽位时不报缺模型", () => {
        const inspection = inspectComfyWorkflow(
            workflow({ "1": { class_type: "SomeNode", inputs: { mode: "fast" } } }),
            objectInfo({ SomeNode: { input: { required: { mode: [[]] } } } }),
        );

        expect(inspection.missingFiles).toEqual([]);
        expect(inspection.runnable).toBe(true);
    });

    it("模型名去重且排序", () => {
        const inspection = inspectComfyWorkflow(
            workflow({
                "1": { class_type: "LoraLoader", inputs: { lora_name: "b.safetensors" } },
                "2": { class_type: "LoraLoader", inputs: { lora_name: "b.safetensors" } },
                "3": { class_type: "LoraLoader", inputs: { lora_name: "a.safetensors" } },
            }),
            objectInfo({ LoraLoader: loader("lora_name", ["c.safetensors"]) }),
        );

        expect(inspection.missingFiles).toEqual(["a.safetensors", "b.safetensors"]);
    });
});
