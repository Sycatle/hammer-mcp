import { readFileSync } from "node:fs";
import { LUMP_ENTITIES } from "../bsp/header.js";
import type { BspHeader } from "../bsp/header.js";

/** `lumpfileheader_t`: five little-endian int32. */
export const LMP_HEADER_BYTES = 20;

export interface LmpHeader {
  /** Where the payload starts. Always 20 in every file Valve ships. */
  lumpOffset: number;
  /** Which BSP lump this overrides. 0 is the entity list. */
  lumpID: number;
  lumpVersion: number;
  /** Payload length in bytes. */
  lumpLength: number;
  /**
   * Must equal the target BSP's `mapRevision`.
   *
   * This is the trap of the whole mechanism: on a mismatch the engine ignores the patch
   * WITHOUT SAYING ANYTHING. The map loads, looks normal, and none of the edits are
   * there. Never guess it -- read it from the BSP.
   */
  mapRevision: number;
}

export interface LmpFile {
  header: LmpHeader;
  /** Payload bytes, trailing NUL stripped. */
  payload: Buffer;
  nulTerminated: boolean;
}

export class LmpFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LmpFormatError";
  }
}

export function decodeLmp(buf: Buffer): LmpFile {
  if (buf.length < LMP_HEADER_BYTES) {
    throw new LmpFormatError(`too small to be a lump file (${buf.length} bytes)`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const header: LmpHeader = {
    lumpOffset: view.getInt32(0, true),
    lumpID: view.getInt32(4, true),
    lumpVersion: view.getInt32(8, true),
    lumpLength: view.getInt32(12, true),
    mapRevision: view.getInt32(16, true),
  };

  const { lumpOffset, lumpLength } = header;
  if (lumpOffset < LMP_HEADER_BYTES || lumpOffset > buf.length) {
    throw new LmpFormatError(`lumpOffset ${lumpOffset} outside the file (${buf.length} bytes)`);
  }
  if (lumpLength < 0 || lumpOffset + lumpLength > buf.length) {
    throw new LmpFormatError(
      `payload ${lumpOffset}+${lumpLength} runs past end of file (${buf.length} bytes)`,
    );
  }

  const raw = buf.subarray(lumpOffset, lumpOffset + lumpLength);
  const nulTerminated = raw.length > 0 && raw[raw.length - 1] === 0;
  return {
    header,
    payload: nulTerminated ? raw.subarray(0, raw.length - 1) : raw,
    nulTerminated,
  };
}

export function readLmp(path: string): LmpFile {
  return decodeLmp(readFileSync(path));
}

export interface EncodeLmpOptions {
  /** Which lump to override. */
  lumpID: number;
  lumpVersion?: number;
  /**
   * Required, with no default on purpose. Every way of getting this wrong fails
   * silently, so the type system makes you go and fetch it.
   */
  mapRevision: number;
  /** Appends a NUL, matching what vbsp writes into the BSP's own entity lump. */
  nulTerminate?: boolean;
}

export function encodeLmp(payload: Buffer | string, opts: EncodeLmpOptions): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const nulTerminate = opts.nulTerminate ?? opts.lumpID === LUMP_ENTITIES;
  const full = nulTerminate ? Buffer.concat([body, Buffer.from([0])]) : body;

  const header = Buffer.alloc(LMP_HEADER_BYTES);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  view.setInt32(0, LMP_HEADER_BYTES, true);
  view.setInt32(4, opts.lumpID, true);
  view.setInt32(8, opts.lumpVersion ?? 0, true);
  view.setInt32(12, full.length, true);
  view.setInt32(16, opts.mapRevision, true);

  return Buffer.concat([header, full]);
}

/**
 * Refuses a patch whose revision does not match the BSP it targets.
 *
 * This used to say the engine would ignore such a patch, and gate B measured the opposite
 * on 15/08/2026: Garry's Mod **applies it anyway**. A patch stamped 1766 against a
 * `gm_construct.bsp` stamped 1765 spawned its entity exactly as a matching one does, with
 * nothing said on either side.
 *
 * That makes the check more necessary rather than less, and for the reverse reason. The
 * danger is not that edits quietly do nothing; it is that a patch built against an older
 * version of a map keeps being applied to a recompiled one, adding, editing and deleting
 * entities by an index and a name that may since have moved. Nothing in the engine will
 * mention it, so this is the only place it can be caught.
 */
export function assertRevisionMatches(header: LmpHeader, bsp: BspHeader): void {
  if (header.mapRevision !== bsp.mapRevision) {
    throw new LmpFormatError(
      `mapRevision mismatch: patch says ${header.mapRevision}, ${bsp.path} says ${bsp.mapRevision}. ` +
        `Garry's Mod does NOT check this -- gate B measured it applying a mismatched ` +
        `patch in full -- so a patch built against an older compile of this map would be ` +
        `applied to the new one, silently. Rebuild the patch from the current .bsp.`,
    );
  }
}
