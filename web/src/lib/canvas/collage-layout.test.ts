import { describe, expect, it } from "vitest";

import {
    clampCollageTransform,
    collageAngleFromCenter,
    collageHandlePoints,
    collageLayerCorners,
    collageSceneSize,
    collageToLocal,
    collageToScene,
    createCollageLayout,
    defaultCollageTransform,
    fitCollagePreview,
    hitTestCollageLayer,
    moveCollageLayer,
    reconcileCollageLayout,
    reorderCollageLayers,
    rotateCollageLayer,
    stretchCollageLayer,
    topmostCollageLayer,
    type CollageTransform,
} from "./collage-layout";

const base = (patch: Partial<CollageTransform> = {}): CollageTransform => ({ x: 100, y: 100, rotation: 0, scale: 1, stretchX: 1, stretchY: 1, ...patch });
const near = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 4);

describe("手柄几何", () => {
    it("未旋转时四角在手柄顺序为左上、右上、右下、左下，旋转柄在顶边中点上方", () => {
        const source = { width: 200, height: 100 };
        const { corners, rotate } = collageHandlePoints(source, base({ x: 0, y: 0 }), 30);
        expect(corners.map((corner) => [corner.x, corner.y])).toEqual([
            [-100, -50],
            [100, -50],
            [100, 50],
            [-100, 50],
        ]);
        expect(rotate.x).toBe(0);
        near(rotate.y, -80);
    });

    it("旋转 90 度后旋转柄跟着转到图层右侧，四角顺序仍按图层自身", () => {
        const source = { width: 200, height: 100 };
        const { corners, rotate } = collageHandlePoints(source, base({ x: 0, y: 0, rotation: 90 }), 30);
        // 画布顺时针转 90 度后，图层「上边」的法线指向 +x，所以旋转柄落在中心右侧。
        near(rotate.x, 80);
        near(rotate.y, 0);
        // 左上角跟着转到 (50, -100)，说明四角始终按图层自身顺序返回。
        near(corners[0].x, 50);
        near(corners[0].y, -100);
    });

    it("图层顶到画布上边缘时旋转柄被夹回画布内，仍然点得到", () => {
        // 800 高的画布里放一张 600x800 的图层并居中，图层顶边正好压在画布上边。
        const source = { width: 600, height: 800 };
        const bounds = { width: 800, height: 800 };
        const transform = base({ x: 400, y: 400 });
        const free = collageHandlePoints(source, transform, 40);
        near(free.rotate.y, -40);
        const clamped = collageHandlePoints(source, transform, 40, bounds);
        near(clamped.rotate.y, 40);
        near(clamped.rotate.x, 400);
    });

    it("手柄坐标随缩放与拉伸一起变化", () => {
        const source = { width: 200, height: 100 };
        const { corners } = collageHandlePoints(source, base({ x: 0, y: 0, scale: 2, stretchX: 3, stretchY: 1 }), 30);
        near(corners[1].x, 600);
        near(corners[1].y, -100);
    });
});

describe("图层变换夹取", () => {
    it("把旋转收敛到 ±180、缩放收敛到 0.2–2、拉伸收敛到 0.05–20", () => {
        const clamped = clampCollageTransform(base({ rotation: 400, scale: 9, stretchX: 0, stretchY: 99 }));
        expect(clamped.rotation).toBe(180);
        expect(clamped.scale).toBe(2);
        expect(clamped.stretchX).toBe(0.05);
        expect(clamped.stretchY).toBe(20);
    });

    it("遇到非法数值回落到安全默认值", () => {
        const clamped = clampCollageTransform(base({ x: Number.NaN, y: Number.NaN, rotation: Number.NaN, scale: Number.NaN }));
        expect(clamped.x).toBe(0);
        expect(clamped.y).toBe(0);
        expect(clamped.rotation).toBe(0);
        expect(clamped.scale).toBe(1);
    });
});

describe("默认布局与画布尺寸", () => {
    const sources = [
        { id: "small", width: 100, height: 100 },
        { id: "big", width: 800, height: 600 },
        { id: "mid", width: 400, height: 300 },
    ];

    it("画布尺寸取 max 宽 × max 高", () => {
        expect(collageSceneSize(sources)).toEqual({ width: 800, height: 600 });
        expect(collageSceneSize([])).toEqual({ width: 1, height: 1 });
    });

    it("所有图层居中，层序按面积降序（大图垫底）", () => {
        const { layout, order } = createCollageLayout(sources);
        expect(order).toEqual(["big", "mid", "small"]);
        for (const id of order) expect(layout[id]).toMatchObject({ x: 400, y: 300, rotation: 0, scale: 1, stretchX: 1, stretchY: 1 });
        expect(defaultCollageTransform({ x: 1, y: 2 })).toEqual({ x: 1, y: 2, rotation: 0, scale: 1, stretchX: 1, stretchY: 1 });
    });

    it("连线变化时补齐新图层、丢弃已断开的图层", () => {
        const first = reconcileCollageLayout(sources, undefined, undefined);
        expect(first?.order).toEqual(["big", "mid", "small"]);

        // 已有布局保持不变，只为新连进来的图层补默认值。
        const custom = { ...first!.layout, mid: base({ x: 11, y: 22, rotation: 30 }) };
        const added = reconcileCollageLayout([...sources, { id: "new", width: 50, height: 50 }], first!.order, custom);
        expect(added?.layout.mid).toMatchObject({ x: 11, y: 22, rotation: 30 });
        expect(added?.layout.new).toMatchObject({ x: 400, y: 300 });
        expect(added?.order).toContain("new");

        const removed = reconcileCollageLayout([sources[1], sources[2]], added!.order, added!.layout);
        expect(removed?.order).toEqual(["big", "mid"]);
        expect(removed?.layout.small).toBeUndefined();
        expect(removed?.layout.new).toBeUndefined();

        // 完全一致时不产生新对象，调用方可以据此跳过写回。
        expect(reconcileCollageLayout(sources, first!.order, first!.layout)).toBeNull();
        expect(reconcileCollageLayout([], undefined, undefined)).toBeNull();
    });
});

describe("旋转感知的坐标换算与命中测试", () => {
    it("局部与画布坐标可以互相还原", () => {
        const transform = base({ rotation: 37 });
        const scene = collageToScene({ x: 30, y: -12 }, transform);
        const local = collageToLocal(scene, transform);
        near(local.x, 30);
        near(local.y, -12);
    });

    it("旋转 45° 时，落在未旋转包围盒内但在旋转矩形外的点不算命中", () => {
        const size = { width: 200, height: 100 };
        const rotated = base({ x: 0, y: 0, rotation: 45 });
        // (95,0) 在未旋转的 ±100×±50 矩形内，但反旋转后是 (67.2,-67.2)，超出半高 50。
        expect(hitTestCollageLayer({ x: 95, y: 0 }, size, base({ x: 0, y: 0 }))).toBe(true);
        expect(hitTestCollageLayer({ x: 95, y: 0 }, size, rotated)).toBe(false);
        // 旋转后沿局部角方向上的点仍然命中。
        const corner = collageToScene({ x: 100, y: 50 }, rotated);
        expect(hitTestCollageLayer(corner, size, rotated)).toBe(true);
    });

    it("层序末尾在最上层，取最上面那个命中的图层", () => {
        const size = { width: 100, height: 100 };
        const layout = { a: base({ x: 50, y: 50 }), b: base({ x: 60, y: 60 }) };
        const sizes = { a: size, b: size };
        expect(topmostCollageLayer({ x: 60, y: 60 }, ["a", "b"], layout, sizes)).toBe("b");
        expect(topmostCollageLayer({ x: 60, y: 60 }, ["b", "a"], layout, sizes)).toBe("a");
        expect(topmostCollageLayer({ x: 500, y: 500 }, ["a", "b"], layout, sizes)).toBeNull();
    });

    it("四角坐标顺序为左上、右上、右下、左下", () => {
        const corners = collageLayerCorners({ width: 200, height: 100 }, base({ x: 0, y: 0 }));
        expect(corners).toEqual([
            { x: -100, y: -50 },
            { x: 100, y: -50 },
            { x: 100, y: 50 },
            { x: -100, y: 50 },
        ]);
    });
});

describe("移动与旋转", () => {
    it("移动只改变中心点", () => {
        expect(moveCollageLayer(base(), 15, -25)).toMatchObject({ x: 115, y: 75, rotation: 0 });
    });

    it("旋转结果始终收敛在 ±180 内", () => {
        expect(rotateCollageLayer(base({ rotation: 170 }), 30).rotation).toBe(-160);
        expect(rotateCollageLayer(base({ rotation: -170 }), -30).rotation).toBe(160);
        expect(rotateCollageLayer(base({ rotation: 0 }), 90).rotation).toBe(90);
    });

    it("以中心为原点算出指向拖拽点的角度", () => {
        near(collageAngleFromCenter({ x: 100, y: 0 }, base()), -90);
        near(collageAngleFromCenter({ x: 200, y: 100 }, base()), 0);
        near(collageAngleFromCenter({ x: 100, y: 200 }, base()), 90);
    });
});

describe("角手柄缩放与拉伸", () => {
    const size = { width: 200, height: 100 };

    it("自由拉伸让被拖的角正好落到鼠标点", () => {
        const next = stretchCollageLayer(size, base(), { x: 1, y: 1 }, { x: 250, y: 180 });
        near(next.stretchX, 1.5);
        near(next.stretchY, 1.6);
        const corners = collageLayerCorners(size, next);
        near(corners[2].x, 250);
        near(corners[2].y, 180);
    });

    it("旋转后拖角同样让该角落到鼠标点，且旋转角不变", () => {
        const rotated = base({ rotation: 90 });
        // 目标点取自旋转后的局部 (+150, +80)，对应拉伸后的右下角。
        const target = collageToScene({ x: 150, y: 80 }, rotated);
        const next = stretchCollageLayer(size, rotated, { x: 1, y: 1 }, target);
        near(next.stretchX, 1.5);
        near(next.stretchY, 1.6);
        const corners = collageLayerCorners(size, next);
        near(corners[2].x, target.x);
        near(corners[2].y, target.y);
        near(next.rotation, 90);
    });

    it("等比模式保持当前拉伸比例", () => {
        const stretched = base({ stretchX: 2, stretchY: 1 });
        const next = stretchCollageLayer(size, stretched, { x: 1, y: 1 }, { x: 400, y: 200 }, { keepRatio: true });
        near(next.stretchX / next.stretchY, 2);
        expect(next.stretchX).toBeGreaterThan(2);
    });

    it("以对角为锚点时，对角保持不动", () => {
        const next = stretchCollageLayer(size, base(), { x: 1, y: 1 }, { x: 300, y: 200 }, { anchorOpposite: true });
        const corners = collageLayerCorners(size, next);
        near(corners[0].x, 0);
        near(corners[0].y, 50);
        near(corners[2].x, 300);
        near(corners[2].y, 200);
    });

    it("拉伸结果被夹取在合法区间内", () => {
        // 拖到贴近中心时半宽接近 0，应被夹到最小拉伸而不是退化成零尺寸。
        const shrink = stretchCollageLayer(size, base(), { x: 1, y: 1 }, { x: 100.001, y: 100.001 });
        expect(shrink.stretchX).toBe(0.05);
        expect(shrink.stretchY).toBe(0.05);
        // 拖到极远时被夹到最大拉伸。
        const grow = stretchCollageLayer(size, base(), { x: 1, y: 1 }, { x: 99999, y: 99999 });
        expect(grow.stretchX).toBe(20);
        expect(grow.stretchY).toBe(20);
    });
});

describe("缩略预览与层序调整", () => {
    it("预览等比缩放且不放大", () => {
        expect(fitCollagePreview({ width: 800, height: 600 }, 252)).toBeCloseTo(252 / 800, 6);
        expect(fitCollagePreview({ width: 100, height: 80 }, 252)).toBe(1);
    });

    it("上移/下移/置顶/置底", () => {
        const order = ["a", "b", "c"];
        expect(reorderCollageLayers(order, "a", "up")).toEqual(["b", "a", "c"]);
        expect(reorderCollageLayers(order, "c", "down")).toEqual(["a", "c", "b"]);
        expect(reorderCollageLayers(order, "a", "top")).toEqual(["b", "c", "a"]);
        expect(reorderCollageLayers(order, "c", "bottom")).toEqual(["c", "a", "b"]);
        expect(reorderCollageLayers(order, "missing", "top")).toEqual(order);
    });
});
