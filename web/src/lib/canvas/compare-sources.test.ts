import { describe, expect, it } from "vitest";

import { clampComparePosition, collectCompareSources, MAX_COMPARE_SOURCES, stepComparePosition } from "./compare-sources";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const imageNode = (id: string, content = `blob:${id}`) => ({ id, type: CanvasNodeType.Image, title: id, metadata: { content } }) as unknown as CanvasNodeData;
const videoNode = (id: string) => ({ id, type: CanvasNodeType.Video, title: id, metadata: { content: "blob:video" } }) as unknown as CanvasNodeData;
const link = (id: string, fromNodeId: string, toNodeId: string, toPortId = "images") => ({ id, fromNodeId, toNodeId, toPortId }) as unknown as CanvasConnection;

describe("对比节点的图片来源", () => {
    it("按连线顺序取前两张图片", () => {
        const nodes = [imageNode("a"), imageNode("b"), imageNode("c")];
        const connections = [link("1", "a", "cmp"), link("2", "b", "cmp"), link("3", "c", "cmp")];

        expect(collectCompareSources("cmp", nodes, connections).map((item) => item.id)).toEqual(["a", "b"]);
        expect(MAX_COMPARE_SOURCES).toBe(2);
    });

    it("只接受带图片内容的图片节点", () => {
        const nodes = [videoNode("v"), imageNode("empty", ""), imageNode("ok")];
        const connections = [link("1", "v", "cmp"), link("2", "empty", "cmp"), link("3", "ok", "cmp")];

        expect(collectCompareSources("cmp", nodes, connections).map((item) => item.id)).toEqual(["ok"]);
    });

    it("忽略连到其它端口的连线", () => {
        const nodes = [imageNode("a"), imageNode("b")];
        const connections = [link("1", "a", "cmp", "music"), link("2", "b", "cmp")];

        expect(collectCompareSources("cmp", nodes, connections).map((item) => item.id)).toEqual(["b"]);
    });

    it("忽略连到别的节点的连线，也不会重复同一张图", () => {
        const nodes = [imageNode("a"), imageNode("b")];
        const connections = [link("1", "a", "other"), link("2", "a", "cmp"), link("3", "a", "cmp"), link("4", "b", "cmp")];

        expect(collectCompareSources("cmp", nodes, connections).map((item) => item.id)).toEqual(["a", "b"]);
    });
});

describe("对比分割位置", () => {
    it("限制在 2%–98% 之间", () => {
        expect(clampComparePosition(-20)).toBe(2);
        expect(clampComparePosition(0)).toBe(2);
        expect(clampComparePosition(50)).toBe(50);
        expect(clampComparePosition(120)).toBe(98);
        expect(clampComparePosition(Number.NaN)).toBe(50);
    });

    it("方向键微调 2%，按住 Shift 走 10%", () => {
        expect(stepComparePosition(50, -1)).toBe(48);
        expect(stepComparePosition(50, 1)).toBe(52);
        expect(stepComparePosition(50, 1, true)).toBe(60);
        expect(stepComparePosition(3, -1)).toBe(2);
        expect(stepComparePosition(97, 1, true)).toBe(98);
    });
});
