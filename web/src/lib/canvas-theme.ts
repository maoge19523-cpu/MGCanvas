export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

export const canvasThemes = {
    light: {
        // 液态玻璃（浅色）：外壳用高透玻璃，节点与面板则要保证文字可读性，取较高的不透明度。
        // 底色用柔和的彩色光斑渐变——磨砂面板要透过它才能显出「玻璃」质感，
        // 纯色平底会让 backdrop-filter 看起来毫无效果。
        canvas: {
            background:
                // 先铺细网格纹理再铺光斑：玻璃面需要高频细节才能显出磨砂。
                "linear-gradient(rgba(148,163,184,.10) 1px, transparent 1px)," +
                "linear-gradient(90deg, rgba(148,163,184,.10) 1px, transparent 1px)," +
                "radial-gradient(1200px 820px at 10% 6%, #ff9aa2 0%, rgba(185,212,247,0) 62%)," +
                "radial-gradient(1000px 720px at 92% 10%, #a8c8ff 0%, rgba(205,205,248,0) 58%)," +
                "radial-gradient(1150px 900px at 76% 96%, #8ee6f0 0%, rgba(179,230,238,0) 62%)," +
                "radial-gradient(900px 700px at 26% 92%, #d9b3ff 0%, rgba(232,205,242,0) 60%)," +
                "#eef3fb",
            dot: "rgba(71,85,105,.26)",
            line: "rgba(71,85,105,.10)",
            selectionStroke: "#2563eb",
            selectionFill: "rgba(37,99,235,.08)",
        },
        node: {
            label: "#3f4a5a",
            fill: "rgba(255,255,255,.62)",
            panel: "rgba(255,255,255,.78)",
            // 表单类面板（参数设置等）必须不透明：半透明会透出下层节点文字造成重叠。
            panelSolid: "rgba(253,253,255,.97)",
            stroke: "rgba(148,163,184,.35)",
            activeStroke: "#2563eb",
            placeholder: "#8194ab",
            text: "#0f172a",
            muted: "#5b6b80",
            faint: "#93a3b8",
        },
        toolbar: {
            panel: "rgba(255,255,255,.78)",
            border: "rgba(255,255,255,.85)",
            item: "#3f4a5a",
            itemHover: "rgba(37,99,235,.10)",
            activeBg: "rgba(37,99,235,.14)",
            activeText: "#1d4ed8",
        },
    },
    dark: {
        canvas: {
            background: "#0d0d0d",
            dot: "rgba(255,255,255,.13)",
            line: "rgba(255,255,255,.06)",
            selectionStroke: "#f4f4f5",
            selectionFill: "rgba(244,244,245,.08)",
        },
        node: {
            label: "#c7c9cc",
            fill: "#17191a",
            panel: "#141617",
            // 表单类面板（参数设置等）必须不透明：半透明会透出下层节点文字造成重叠。
            panelSolid: "#141617",
            stroke: "#3b3e40",
            activeStroke: "#f4f4f5",
            placeholder: "#8b8f94",
            text: "#f4f4f5",
            muted: "#b7bbc0",
            faint: "#6f7479",
        },
        toolbar: {
            panel: "rgba(20,22,23,.96)",
            border: "#343739",
            item: "#c7c9cc",
            itemHover: "#202324",
            activeBg: "#2b2e30",
            activeText: "#f4f4f5",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
