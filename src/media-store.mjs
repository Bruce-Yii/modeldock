import { createHash } from "node:crypto";

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i;

export class MediaStore {
  #items = new Map();

  constructor({ ttlMs, maxBytes, maxEntries }) {
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }

  put(imageUrl) {
    if (typeof imageUrl !== "string" || imageUrl.length === 0) {
      throw new Error("input_image.image_url must be a non-empty string");
    }

    let size = 0;
    let mime = "remote";
    let digestInput = imageUrl;
    const dataMatch = DATA_URL.exec(imageUrl);
    if (dataMatch) {
      const bytes = Buffer.from(dataMatch[2].replace(/\s/g, ""), "base64");
      size = bytes.byteLength;
      mime = dataMatch[1].toLowerCase();
      digestInput = bytes;
    } else {
      const url = new URL(imageUrl);
      if (url.protocol !== "https:") throw new Error("Only image data URLs and public HTTPS URLs are supported");
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      if (["localhost", "127.0.0.1", "::1"].includes(hostname)) {
        throw new Error("Local image URLs are not accepted");
      }
      size = Buffer.byteLength(imageUrl);
    }

    if (size > this.maxBytes) {
      throw new Error(`Image exceeds the ${this.maxBytes}-byte limit`);
    }

    const ref = `img_${createHash("sha256").update(digestInput).digest("hex").slice(0, 20)}`;
    const now = Date.now();
    this.#items.set(ref, { ref, imageUrl, mime, size, createdAt: now, lastAccessAt: now });
    this.cleanup(now);
    return ref;
  }

  get(ref) {
    this.cleanup();
    const item = this.#items.get(ref);
    if (!item) return undefined;
    item.lastAccessAt = Date.now();
    return { ...item };
  }

  cleanup(now = Date.now()) {
    for (const [ref, item] of this.#items) {
      if (now - item.lastAccessAt > this.ttlMs) this.#items.delete(ref);
    }
    while (this.#items.size > this.maxEntries) {
      const oldest = [...this.#items.values()].sort((a, b) => a.lastAccessAt - b.lastAccessAt)[0];
      if (!oldest) break;
      this.#items.delete(oldest.ref);
    }
  }

  snapshot() {
    this.cleanup();
    let bytes = 0;
    for (const item of this.#items.values()) bytes += item.size;
    return { entries: this.#items.size, bytes, ttlMs: this.ttlMs, maxBytesPerImage: this.maxBytes };
  }
}
