/**
 * 画布作品集水印导出：把生成结果加上品牌水印后另存，
 * 便于用户直接分享到社交平台时保留出处。
 */

/** 水印文字相对图片宽度的比例，保证不同分辨率下水印视觉大小一致。 */
const WATERMARK_SCALE = 0.034;
const WATERMARK_MIN_SIZE = 14;

/** 给单张图片叠加右下角水印，返回 PNG Blob。 */
export async function watermarkImageBlob(source: Blob, label: string): Promise<Blob> {
    const bitmap = await createImageBitmap(source);
    try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法创建画布上下文");
        context.drawImage(bitmap, 0, 0);

        const size = Math.max(WATERMARK_MIN_SIZE, Math.round(canvas.width * WATERMARK_SCALE));
        const padding = Math.round(size * 0.9);
        context.font = `600 ${size}px "LXGW WenKai", "KaiTi", "Microsoft YaHei", sans-serif`;
        context.textAlign = "right";
        context.textBaseline = "bottom";
        // 先描一层暗色再叠亮色，深浅背景上都清晰。
        context.fillStyle = "rgba(0, 0, 0, 0.42)";
        context.fillText(label, canvas.width - padding + 1, canvas.height - padding + 1);
        context.fillStyle = "rgba(255, 255, 255, 0.88)";
        context.fillText(label, canvas.width - padding, canvas.height - padding);

        return await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("水印图片编码失败"))), "image/png");
        });
    } finally {
        bitmap.close();
    }
}
