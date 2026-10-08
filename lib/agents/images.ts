import "server-only";

// Images people attach (in a task's thread or the Chief of Staff chat) are
// shown to the model scaled down to what it reads anyway, as JPEG, which keeps
// requests and stored run records small.

const MODEL_IMAGE_EDGE = 1568;

/** The image types the model is shown; others are passed on by name. */
export const MODEL_IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

/** An image as the model sees it: at most 1568 px on its long edge, upright, JPEG, base64. */
export async function imageForModel(bytes: Buffer): Promise<{ mediaType: "image/jpeg"; data: string }> {
  const { default: sharp } = await import("sharp");
  const scaled = await sharp(bytes)
    .rotate()
    .resize({ width: MODEL_IMAGE_EDGE, height: MODEL_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { mediaType: "image/jpeg", data: scaled.toString("base64") };
}
