export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

export const canvasThemes = {
    light: {
        // 液态玻璃（浅色）：冷调浅底 + 半透明玻璃面 + 冷蓝高亮。
        // 底色用柔和的彩色光斑渐变——磨砂面板要透过它才能显出「玻璃」质感，
        // 纯色平底会让 backdrop-filter 看起来毫无效果。
        canvas: {
            background:
                "radial-gradient(1200px 820px at 10% 6%, #d7e6fb 0%, rgba(215,230,251,0) 62%)," +
                "radial-gradient(1000px 720px at 92% 10%, #e2e2fb 0%, rgba(226,226,251,0) 58%)," +
                "radial-gradient(1150px 900px at 76% 96%, #d4f0f4 0%, rgba(212,240,244,0) 62%)," +
                "radial-gradient(900px 700px at 26% 92%, #f2e4f7 0%, rgba(242,228,247,0) 60%)," +
                "#eef3fb",
            dot: "rgba(71,85,105,.26)",
            line: "rgba(71,85,105,.10)",
            selectionStroke: "#2563eb",
            selectionFill: "rgba(37,99,235,.08)",
        },
        node: {
            label: "#3f4a5a",
            fill: "rgba(255,255,255,.44)",
            panel: "rgba(255,255,255,.62)",
            stroke: "rgba(255,255,255,.85)",
            activeStroke: "#2563eb",
            placeholder: "#8194ab",
            text: "#0f172a",
            muted: "#5b6b80",
            faint: "#93a3b8",
        },
        toolbar: {
            panel: "rgba(255,255,255,.58)",
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
