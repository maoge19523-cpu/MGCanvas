import fs from "node:fs/promises";
import path from "node:path";

import type { SkillStore } from "./store.js";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 200;
const MAX_LIST_DEPTH = 4;
/** 这两个文件由 SkillStore 自己维护，资源文件接口不允许碰。 */
const RESERVED = new Set(["skill.md", "agents/openai.yaml"]);

export type SkillResourceFile = { path: string; size: number };

function skillDir(store: SkillStore, nameValue: string) {
    const name = String(nameValue || "").trim();
    if (!NAME_PATTERN.test(name) || name.length > 64) throw new Error("Skill 名称不合法");
    return path.join(store.skillsPath, name);
}

/** 资源文件必须落在该 Skill 目录内：拒绝绝对路径、上级跳转与保留文件。 */
function resourcePath(dir: string, relativeValue: string) {
    const relative = String(relativeValue || "").trim().replace(/\\/g, "/");
    if (!relative) throw new Error("请填写文件路径");
    if (path.isAbsolute(relative) || relative.split("/").some((part) => part === ".." || part === "")) throw new Error("文件路径不合法");
    if (RESERVED.has(relative.toLowerCase())) throw new Error("这个文件由 Skill 本体管理，请用编辑 Skill 的方式修改");
    const target = path.resolve(dir, relative);
    const prefix = path.resolve(dir) + path.sep;
    if (!target.startsWith(prefix)) throw new Error("文件路径不合法");
    return target;
}

/** 列出 Skill 目录下的资源文件（不含 SKILL.md 这类本体文件）。 */
export async function listSkillResources(store: SkillStore, name: string): Promise<SkillResourceFile[]> {
    const dir = skillDir(store, name);
    const files: SkillResourceFile[] = [];
    const walk = async (current: string, depth: number) => {
        if (depth > MAX_LIST_DEPTH || files.length >= MAX_FILES) return;
        const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (files.length >= MAX_FILES) return;
            if (entry.isSymbolicLink()) continue;
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(absolute, depth + 1);
                continue;
            }
            if (!entry.isFile()) continue;
            const relative = path.relative(dir, absolute).split(path.sep).join("/");
            if (RESERVED.has(relative.toLowerCase())) continue;
            const stat = await fs.stat(absolute).catch(() => null);
            if (stat) files.push({ path: relative, size: stat.size });
        }
    };
    await walk(dir, 1);
    return files;
}

/** 读取一个资源文件，只支持文本且限制大小。 */
export async function readSkillResource(store: SkillStore, name: string, relative: string) {
    const target = resourcePath(skillDir(store, name), relative);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error("文件不存在");
    if (stat.size > MAX_FILE_BYTES) throw new Error("文件超过 512KB，暂不支持在这里查看");
    const content = await fs.readFile(target, "utf8");
    if (content.includes("\u0000")) throw new Error("这是二进制文件，暂不支持在这里查看");
    return { path: relative, size: stat.size, content };
}

/** 新增或覆盖一个资源文件。 */
export async function writeSkillResource(store: SkillStore, name: string, relative: string, content: string) {
    const target = resourcePath(skillDir(store, name), relative);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) throw new Error("文件超过 512KB，无法保存");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return { path: relative, size: bytes };
}

/** 删除一个资源文件。 */
export async function deleteSkillResource(store: SkillStore, name: string, relative: string) {
    const target = resourcePath(skillDir(store, name), relative);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error("文件不存在");
    await fs.unlink(target);
    return { path: relative };
}
