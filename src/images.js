import { randomBytes, createHash } from 'node:crypto';
import { FeedbackError } from './feedback.js';

const INPUT_MAX = 2 * 1024 * 1024, IMAGE_MAX = 1024 * 1024, ARTIFACT_MAX = 4 * IMAGE_MAX, TOTAL_MAX = 32 * IMAGE_MAX;
const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
function dimensions(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (offset + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 8) {
        return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      }
      offset += size;
    }
  }
  throw new FeedbackError('Use a valid PNG or JPEG screenshot');
}

export class ScreenshotStore {
  constructor({ codec, now = Date.now } = {}) { this.codec = codec; this.now = now; this.buckets = new Map(); this.totalBytes = 0; this.pendingBytes = 0; this.pendingCount = 0; }
  available() { return typeof this.codec?.getImageMetadata === 'function' && typeof this.codec?.resizeToJpeg === 'function'; }
  prune() { for (const [id, bucket] of this.buckets) if (this.now() >= bucket.expiresAt) this.remove(id); }
  remove(id) { const bucket = this.buckets.get(id); if (bucket) this.totalBytes -= bucket.bytes; this.buckets.delete(id); }
  clear() { for (const id of this.buckets.keys()) this.remove(id); }
  get(artifactId, imageId) { this.prune(); return validId(imageId) ? this.buckets.get(artifactId)?.images.get(imageId) ?? null : null; }
  async add(artifactId, input, expiresAt) {
    this.prune();
    if (!this.available()) throw new FeedbackError('Screenshot processing unavailable', 503);
    if (!input || Object.keys(input).some(key => !['data', 'id','revisionId'].includes(key)) || typeof input.data !== 'string' || input.data.length > Math.ceil(INPUT_MAX / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) throw new FeedbackError('Invalid or oversized screenshot');
    if(input.revisionId!==undefined&&!validId(input.revisionId))throw new FeedbackError('Invalid screenshot revision');
    if (input.id !== undefined && !validId(input.id)) throw new FeedbackError('Invalid screenshot ID');
    if (!Number.isFinite(expiresAt) || this.now() >= expiresAt) throw new FeedbackError('Artifact expired', 404);
    const bytes = Buffer.from(input.data, 'base64');
    if (bytes.length > INPUT_MAX || bytes.toString('base64') !== input.data) throw new FeedbackError('Invalid screenshot encoding');
    const [width, height] = dimensions(bytes);
    if (!width || !height || width > 8192 || height > 8192 || width * height > 16000000) throw new FeedbackError('Screenshot dimensions exceed the limit');
    let bucket = this.buckets.get(artifactId);
    if (!bucket) { bucket = { expiresAt, images: new Map(), bytes: 0, pending: 0 }; this.buckets.set(artifactId, bucket); }
    const fingerprint = createHash('sha256').update(bytes).digest('hex');
    const id = input.id ?? randomBytes(16).toString('hex');
    const prior = bucket.images.get(id);
    if (prior) {
      if (prior.fingerprint !== fingerprint||prior.revisionId!==input.revisionId) throw new FeedbackError('Screenshot ID already has different bytes or revision', 409);
      return this.describe(prior);
    }
    if (bucket.images.size + bucket.pending >= 8 || bucket.bytes + (bucket.pending + 1) * IMAGE_MAX > ARTIFACT_MAX || this.totalBytes + this.pendingBytes + IMAGE_MAX > TOTAL_MAX || this.pendingCount >= 4) throw new FeedbackError('Screenshot capacity reached', 429);
    bucket.pending++; this.pendingCount++; this.pendingBytes += IMAGE_MAX;
    try {
      const metadata = await this.codec.getImageMetadata(bytes);
      if (!metadata || metadata.width * metadata.height > 16000000 || metadata.width > 8192 || metadata.height > 8192) throw new FeedbackError('Screenshot dimensions exceed the limit');
      const normalized = await this.codec.resizeToJpeg({ buffer: bytes, maxSide: 1600, quality: 75, withoutEnlargement: true });
      if (!Buffer.isBuffer(normalized) || normalized.length > IMAGE_MAX || normalized[0] !== 255 || normalized[1] !== 216) throw new FeedbackError('Screenshot could not be normalized');
      const output = await this.codec.getImageMetadata(normalized);
      if (!output?.width || !output?.height || output.width > 1600 || output.height > 1600) throw new FeedbackError('Invalid normalized screenshot dimensions');
      if (this.buckets.get(artifactId) !== bucket || this.now() >= bucket.expiresAt) throw new FeedbackError('Artifact expired or removed during screenshot processing', 404);
      // Concurrent identical uploads must not consume capacity twice.
      const existing = bucket.images.get(id);
      if (existing) {
        if (existing.fingerprint !== fingerprint||existing.revisionId!==input.revisionId) throw new FeedbackError('Screenshot ID already has different bytes or revision', 409);
        return this.describe(existing);
      }
      const image = { id, mimeType: 'image/jpeg', bytes: normalized, width: output.width, height: output.height, fingerprint,...(input.revisionId?{revisionId:input.revisionId}:{}) };
      bucket.images.set(id, image); bucket.bytes += normalized.length; this.totalBytes += normalized.length;
      return this.describe(image);
    } catch (error) {
      if (error instanceof FeedbackError) throw error;
      throw new FeedbackError('Screenshot could not be processed');
    } finally { bucket.pending--; this.pendingCount--; this.pendingBytes -= IMAGE_MAX; }
  }
  describe(image) { return { id: image.id, mimeType: image.mimeType, width: image.width, height: image.height, size: image.bytes.length,...(image.revisionId?{revisionId:image.revisionId}:{}) }; }
}
