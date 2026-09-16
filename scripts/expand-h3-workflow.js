// 扩展 H3 全能参考工作流：
// 1) 参考图从 3 张扩展到 6 张（节点支持最多 9 张），并命名为「图片一」到「图片六」；
// 2) 追加 3 个参考音频加载节点（节点上限为 3 个独立音频），命名为「音频一」到「音频三」。
// 直接改 JSON 结构，保留原有节点与连线不变。
const fs = require("fs");

const file = process.argv[2];
const workflow = JSON.parse(fs.readFileSync(file, "utf8"));

const H3 = "93";
if (!workflow[H3]) throw new Error("未找到 MiniMax H3 节点 #" + H3);

const IMAGE_TITLES = ["图片一", "图片二", "图片三", "图片四", "图片五", "图片六"];
const AUDIO_TITLES = ["音频一", "音频二", "音频三"];

// 已有 3 个图像加载节点，按顺序改名为图片一 ~ 图片三
const existingImageIds = ["47", "75", "78"];
existingImageIds.forEach((id, index) => {
    if (!workflow[id]) throw new Error("未找到图像节点 #" + id);
    workflow[id]._meta = { title: IMAGE_TITLES[index] };
});

// 追加图片四 ~ 图片六；默认值复用已有文件名，保证未上传时也能通过校验
const fallbackImage = workflow[existingImageIds[0]].inputs.image;
["130", "131", "132"].forEach((id, index) => {
    workflow[id] = {
        inputs: { image: fallbackImage },
        class_type: "LoadImage",
        _meta: { title: IMAGE_TITLES[index + 3] },
    };
    workflow[H3].inputs[`ref_images.ref_image_${index + 3}`] = [id, 0];
});

// 追加音频一 ~ 音频三；"None" 是 ComfyUI 约定的空音频取值
["140", "141", "142"].forEach((id, index) => {
    workflow[id] = {
        inputs: { audio: "None" },
        class_type: "LoadAudio",
        _meta: { title: AUDIO_TITLES[index] },
    };
    workflow[H3].inputs[`ref_audios.ref_audio_${index}`] = [id, 0];
});

fs.writeFileSync(file, JSON.stringify(workflow, null, 2) + "\n", "utf8");

const reloaded = JSON.parse(fs.readFileSync(file, "utf8"));
const refImages = Object.keys(reloaded[H3].inputs).filter((key) => key.startsWith("ref_images."));
const refAudios = Object.keys(reloaded[H3].inputs).filter((key) => key.startsWith("ref_audios."));
console.log("节点总数:", Object.keys(reloaded).length);
console.log("参考图:", refImages.join(", "));
console.log("参考音频:", refAudios.join(", "));
console.log("图片节点标题:", existingImageIds.concat(["130", "131", "132"]).map((id) => reloaded[id]._meta.title).join(" / "));
console.log("音频节点标题:", ["140", "141", "142"].map((id) => reloaded[id]._meta.title).join(" / "));
