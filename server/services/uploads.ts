import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB
export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/webp',
];

/**
 * Strips JPEG EXIF (APP1) segments to remove GPS / location and camera metadata.
 * For non-JPEG files, returns the original buffer.
 */
export function sanitizeImageMetadata(buffer: Buffer, mimetype: string): Buffer {
  if (mimetype !== 'image/jpeg' && mimetype !== 'image/jpg') {
    return buffer;
  }
  try {
    // Check for JPEG SOI marker (0xFF, 0xD8)
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      return buffer;
    }
    const chunks: Buffer[] = [buffer.subarray(0, 2)]; // Keep SOI
    let offset = 2;
    while (offset < buffer.length - 1) {
      if (buffer[offset] !== 0xff) {
        // Not a marker, copy remaining
        chunks.push(buffer.subarray(offset));
        break;
      }
      const marker = buffer[offset + 1];
      // SOS (Start of Scan) or EOI (End of Image)
      if (marker === 0xda || marker === 0xd9) {
        chunks.push(buffer.subarray(offset));
        break;
      }
      if (offset + 4 > buffer.length) break;
      const length = buffer.readUInt16BE(offset + 2);
      const segmentEnd = offset + 2 + length;
      // 0xE1 is APP1 (EXIF / GPS metadata)
      if (marker === 0xe1) {
        // Skip this EXIF segment to strip GPS and camera metadata
      } else {
        chunks.push(buffer.subarray(offset, Math.min(segmentEnd, buffer.length)));
      }
      offset = segmentEnd;
    }
    return Buffer.concat(chunks);
  } catch {
    return buffer;
  }
}

export function savePrivateUpload(
  uploadDir: string,
  originalName: string,
  mimetype: string,
  buffer: Buffer,
): { storageKey: string; sha256: string; bytes: number } {
  mkdirSync(uploadDir, { recursive: true });
  const sanitized = sanitizeImageMetadata(buffer, mimetype);
  const ext = extname(originalName).toLowerCase() || '.bin';
  const storageKey = `${randomUUID()}${ext}`;
  const filePath = join(uploadDir, storageKey);
  writeFileSync(filePath, sanitized);
  const sha256 = createHash('sha256').update(sanitized).digest('hex');
  return { storageKey, sha256, bytes: sanitized.length };
}
