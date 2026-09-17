export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

export const canvasThemes = {
    light: {
        // 液态玻璃（浅色）：冷调浅底 + 半透明玻璃面 + 冷蓝高亮。
        canvas: {
            background: "#e9eff8",
            dot: "rgba(71,85,105,.26)",
            line: "rgba(71,85,105,.10)",
            selectionStroke: "#2563eb",
            selectionFill: "rgba(37,99,235,.08)",
        },
        node: {
            label: "#3f4a5a",
            fill: "rgba(255,255,255,.58)",
            panel: "rgba(255,255,255,.78)",
            stroke: "rgba(148,163,184,.38)",
            activeStroke: "#2563eb",
            placeholder: "#8194ab",
            text: "#0f172a",
            muted: "#5b6b80",
            faint: "#93a3b8",
        },
        toolbar: {
            panel: "rgba(255,255,255,.72)",
            border: "rgba(148,163,184,.36)",
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
