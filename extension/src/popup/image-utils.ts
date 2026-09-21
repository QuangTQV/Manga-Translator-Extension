// Downscales a user-picked image to a small JPEG data URL so it can live
// inline in the Story DB document (backend caps: avatar 60k chars,
// reference image 200k chars — see backend/schemas.py).

export interface ResizeOptions {
  maxSide: number;   // longest edge after resize (or the square size when crop is true)
  crop?: boolean;    // center-crop to a square (avatars) instead of keeping the aspect ratio
  quality?: number;  // JPEG quality 0-1
}

export async function fileToDataUrl(file: File, opts: ResizeOptions): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
    let dw: number, dh: number;
    if (opts.crop) {
      const side = Math.min(bitmap.width, bitmap.height);
      sx = (bitmap.width - side) / 2;
      sy = (bitmap.height - side) / 2;
      sw = sh = side;
      dw = dh = opts.maxSide;
    } else {
      const scale = Math.min(1, opts.maxSide / Math.max(bitmap.width, bitmap.height));
      dw = Math.max(1, Math.round(bitmap.width * scale));
      dh = Math.max(1, Math.round(bitmap.height * scale));
    }
    const canvas = document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.fillStyle = '#ffffff'; // JPEG has no alpha — flatten transparent PNGs onto white
    ctx.fillRect(0, 0, dw, dh);
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);
    return canvas.toDataURL('image/jpeg', opts.quality ?? 0.8);
  } finally {
    bitmap.close();
  }
}
