// Resize and compress pictures in the browser before they're uploaded and copied to the boxes.

const MAX_BYTES = 8 * 1024 * 1024;

async function decode(file: Blob): Promise<{ img: CanvasImageSource; w: number; h: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { img: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall back to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const el = new Image();
    el.decoding = 'async';
    el.src = url;
    await el.decode();
    return { img: el, w: el.naturalWidth, h: el.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('That file isn’t a picture this browser can open. Try a JPEG or PNG.');
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not compress the picture'))), type, quality));
}

async function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  let q = quality;
  let out = await toBlob(canvas, 'image/jpeg', q);
  while (out.size > MAX_BYTES && q > 0.5) {
    q -= 0.1;
    out = await toBlob(canvas, 'image/jpeg', q);
  }
  return out;
}

/** Wallpaper: fill 1920 × 1080 (centre crop, like the TV), JPEG ≈ q0.85. */
export async function wallpaperJpeg(file: Blob, width = 1920, height = 1080, quality = 0.85): Promise<Blob> {
  const { img, w, h, close } = await decode(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser can’t resize pictures');
    const s = Math.max(width / w, height / h);
    const dw = w * s, dh = h * s;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
    return await encodeJpeg(canvas, quality);
  } finally {
    close();
  }
}

/** Card art: fit inside 1280 × 1280 without cropping. PNGs stay PNG (transparency), others become JPEG q0.9. */
export async function cardImage(file: Blob, max = 1280): Promise<Blob> {
  const { img, w, h, close } = await decode(file);
  try {
    const s = Math.min(1, max / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * s));
    canvas.height = Math.max(1, Math.round(h * s));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser can’t resize pictures');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (file.type === 'image/png') {
      const png = await toBlob(canvas, 'image/png');
      if (png.size <= MAX_BYTES) return png;
    }
    return await encodeJpeg(canvas, 0.9);
  } finally {
    close();
  }
}
