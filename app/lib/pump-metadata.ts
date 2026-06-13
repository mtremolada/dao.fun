/**
 * Token metadata helper — turns "upload an image + name/symbol" into a pump
 * metadata URI, client-side (no server). The image is auto-cropped to a
 * square and resized so the user doesn't have to size it, then image + JSON
 * are uploaded to pump.fun's IPFS endpoint (the same one pump's own create
 * page uses) which returns a metadataUri for create_v2.
 */

/** Center-crop to a square and resize — so any image becomes "properly sized". */
export async function prepareImage(file: File, size = 1000): Promise<Blob> {
  const img = await loadImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas not available");
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("could not encode image"))),
      "image/png",
    ),
  );
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not read that image file"));
    };
    img.src = url;
  });
}

export interface PumpMetadataInput {
  image: Blob;
  name: string;
  symbol: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

/** Upload image + metadata JSON to pump's IPFS; returns the metadata URI. */
export async function uploadPumpMetadata(
  input: PumpMetadataInput,
): Promise<string> {
  const fd = new FormData();
  fd.append("file", input.image, "image.png");
  fd.append("name", input.name);
  fd.append("symbol", input.symbol);
  fd.append("description", input.description ?? "");
  fd.append("twitter", input.twitter ?? "");
  fd.append("telegram", input.telegram ?? "");
  fd.append("website", input.website ?? "");
  fd.append("showName", "true");

  let res: Response;
  try {
    res = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: fd });
  } catch {
    throw new Error(
      "Image upload was blocked by the browser (pump.fun CORS). Paste a metadata URI under Advanced instead.",
    );
  }
  if (!res.ok) {
    throw new Error(`metadata upload failed (HTTP ${res.status})`);
  }
  const json = (await res.json()) as {
    metadataUri?: string;
    metadata_uri?: string;
  };
  const uri = json.metadataUri ?? json.metadata_uri;
  if (!uri) throw new Error("metadata upload returned no URI");
  return uri;
}
