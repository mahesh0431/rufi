// heic-decode ships no types: what Rufi uses of it.
declare module "heic-decode" {
  /** Decodes a HEIC's main image, upright, as RGBA pixels. */
  export default function decode(input: {
    buffer: ArrayBufferLike | Uint8Array;
  }): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
}
