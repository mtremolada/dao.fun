/**
 * Metadata uploaders. Self-host is the always-available default (writes the
 * image + a standard token JSON to a directory served at
 * GET /launchpad/meta/*, with immutable cache headers and ACAO:* so explorers
 * can fetch it). If `sharp` is installed it downscales the image to a 512×512
 * webp — the de-facto Solana token-icon size — otherwise it stores the
 * original (already MIME-checked and size-capped by the handler).
 *
 * A permanent-storage uploader (ar.io Turbo) can be dropped in behind the same
 * MetadataUploader interface later; self-host keeps the zero-signup promise and
 * survives on Railway's volume.
 */
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { MetadataUploader, MetadataUploadInput } from "./handler";

async function toWebp512(image: Buffer): Promise<{ data: Buffer; ext: string; mime: string }> {
  try {
    // Optional dependency: a non-literal specifier keeps the type checker from
    // requiring `sharp` to be installed for the backend to build.
    const specifier = "sharp";
    const mod = (await import(specifier).catch(() => null)) as
      | { default: (b: Buffer) => { resize: (o: unknown) => { webp: (o: unknown) => { toBuffer: () => Promise<Buffer> } } } }
      | null;
    if (mod?.default) {
      const data = await mod
        .default(image)
        .resize({ width: 512, height: 512, fit: "cover" })
        .webp({ quality: 80 })
        .toBuffer();
      return { data, ext: "webp", mime: "image/webp" };
    }
  } catch {
    /* fall through to storing the original */
  }
  return { data: image, ext: "bin", mime: "application/octet-stream" };
}

const extForMime: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export class SelfHostUploader implements MetadataUploader {
  constructor(
    private readonly dir: string,
    /** Public base URL the assets are served from, e.g. https://api.example. */
    private readonly publicBaseUrl: string,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  async upload(input: MetadataUploadInput): Promise<{ uri: string; imageUri: string }> {
    const id = createHash("sha256")
      .update(input.image)
      .update(input.name)
      .update(input.symbol)
      .digest("hex")
      .slice(0, 32);

    const resized = await toWebp512(input.image);
    const imageExt = resized.ext === "bin" ? (extForMime[input.imageMime] ?? "bin") : resized.ext;
    const imageFile = `${id}.${imageExt}`;
    await writeFile(join(this.dir, imageFile), resized.data);
    const base = this.publicBaseUrl.replace(/\/$/, "");
    const imageUri = `${base}/launchpad/meta/${imageFile}`;

    const json = {
      name: input.name,
      symbol: input.symbol,
      description: input.description,
      image: imageUri,
    };
    const jsonFile = `${id}.json`;
    await writeFile(join(this.dir, jsonFile), JSON.stringify(json));
    return { uri: `${base}/launchpad/meta/${jsonFile}`, imageUri };
  }
}
