import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEntityLump } from "../src/bsp/entities.js";
import { readHeader } from "../src/bsp/header.js";
import { applyEntityOps } from "../src/entity/edit.js";
import {
  assertRevisionMatches,
  decodeLmp,
  encodeLmp,
  LmpFormatError,
  LMP_HEADER_BYTES,
} from "../src/lmp/codec.js";

import { FIXTURES, paths } from "./support/env.js";

const PROBE = join(FIXTURES, "hmcp_probe.bsp");
/** One of the three lump patches Valve ships with Half-Life 2, via GMod's maps folder. */
const STOCK_LMP = paths.stockLmp;

describe("lmp codec", () => {
  it("writes the 20-byte header Source expects", () => {
    const buf = encodeLmp('{\n"classname" "info_target"\n}\n', {
      lumpID: 0,
      mapRevision: 42,
    });
    expect(buf.readInt32LE(0)).toBe(LMP_HEADER_BYTES); // lumpOffset
    expect(buf.readInt32LE(4)).toBe(0); // lumpID
    expect(buf.readInt32LE(8)).toBe(0); // lumpVersion
    expect(buf.readInt32LE(12)).toBe(buf.length - LMP_HEADER_BYTES); // lumpLength
    expect(buf.readInt32LE(16)).toBe(42); // mapRevision
  });

  it("NUL-terminates the entity payload, as vbsp does in the BSP itself", () => {
    const buf = encodeLmp("{}", { lumpID: 0, mapRevision: 1 });
    expect(buf[buf.length - 1]).toBe(0);
    expect(decodeLmp(buf).nulTerminated).toBe(true);
    expect(decodeLmp(buf).payload.toString("utf8")).toBe("{}");
  });

  it("round-trips encode -> decode -> encode byte for byte", () => {
    const text = '{\n"classname" "light"\n"origin" "0 0 64"\n}\n';
    const once = encodeLmp(text, { lumpID: 0, mapRevision: 7 });
    const decoded = decodeLmp(once);
    const twice = encodeLmp(decoded.payload, {
      lumpID: decoded.header.lumpID,
      lumpVersion: decoded.header.lumpVersion,
      mapRevision: decoded.header.mapRevision,
      nulTerminate: decoded.nulTerminated,
    });
    expect(twice.equals(once)).toBe(true);
  });

  it("refuses a truncated file and a payload running past the end", () => {
    expect(() => decodeLmp(Buffer.alloc(8))).toThrow(LmpFormatError);
    const bad = encodeLmp("{}", { lumpID: 0, mapRevision: 1 });
    bad.writeInt32LE(9999, 12);
    expect(() => decodeLmp(bad)).toThrow(/runs past end/);
  });

  it("refuses a revision that does not match the target BSP", () => {
    const bsp = readHeader(PROBE);
    const wrong = decodeLmp(encodeLmp("{}", { lumpID: 0, mapRevision: bsp.mapRevision + 1 }));
    // Gate B, 15/08/2026: the engine's answer to a mismatch is not silence, it is to
    // apply the patch anyway -- measured on gm_construct with a patch stamped one revision
    // ahead. So this guard is the ONLY thing between a stale patch and a recompiled map,
    // and the message has to say that rather than promising the engine will decline.
    expect(() => assertRevisionMatches(wrong.header, bsp)).toThrow(/mapRevision mismatch/);
    expect(() => assertRevisionMatches(wrong.header, bsp)).toThrow(/does NOT check/);

    const right = decodeLmp(encodeLmp("{}", { lumpID: 0, mapRevision: bsp.mapRevision }));
    expect(() => assertRevisionMatches(right.header, bsp)).not.toThrow();
  });

  it("decodes a lump patch written by Valve", () => {
    // Read from srcds/ rather than committed: not ours, and that tree is SteamCMD-managed.
    if (!existsSync(STOCK_LMP)) return;
    const file = decodeLmp(readFileSync(STOCK_LMP));
    expect(file.header.lumpOffset).toBe(LMP_HEADER_BYTES);
    expect(file.header.lumpID).toBe(0);
    expect(file.payload.length).toBeGreaterThan(0);
    expect(file.payload.toString("utf8")).toContain('"classname" "worldspawn"');
  });
});

describe("entity operations", () => {
  const lump = readEntityLump(PROBE);

  it("removes an entity and leaves the rest byte-identical", () => {
    const r = applyEntityOps(lump.text, lump.entities, [
      { op: "remove", match: { targetname: "hmcp_probe" } },
    ]);
    expect(r.outcomes[0]!.matched).toBe(1);
    expect(r.entitiesAfter).toBe(r.entitiesBefore - 1);
    expect(r.text).not.toContain("hmcp_probe");
    // Everything else survives untouched.
    expect(r.text).toContain('"classname" "info_player_start"');
    expect(r.text).toContain('"classname" "worldspawn"');
  });

  it("adds an entity by appending, without disturbing the existing text", () => {
    const r = applyEntityOps(lump.text, lump.entities, [
      { op: "add", keyvalues: { classname: "info_target", targetname: "added", origin: "1 2 3" } },
    ]);
    expect(r.entitiesAfter).toBe(r.entitiesBefore + 1);
    expect(r.text.startsWith(lump.text.slice(0, 200))).toBe(true);
    expect(r.text).toContain('"targetname" "added"');
  });

  it("updates keyvalues on a matched entity", () => {
    const r = applyEntityOps(lump.text, lump.entities, [
      { op: "update", match: { targetname: "hmcp_probe" }, set: { origin: "10 20 30" } },
    ]);
    expect(r.outcomes[0]!.matched).toBe(1);
    expect(r.text).toContain('"origin" "10 20 30"');
    expect(r.text).toContain('"targetname" "hmcp_probe"');
  });

  it("warns that a light added by patch does nothing -- vrad bakes lighting", () => {
    const r = applyEntityOps(lump.text, lump.entities, [
      { op: "add", keyvalues: { classname: "light", origin: "0 0 0" } },
    ]);
    expect(r.warnings.join(" ")).toMatch(/baked by vrad/);
  });

  it("warns that a client-side entity will not reach players", () => {
    const r = applyEntityOps(lump.text, lump.entities, [
      { op: "add", keyvalues: { classname: "env_sprite", origin: "0 0 0" } },
    ]);
    expect(r.warnings.join(" ")).toMatch(/never sent to\s+clients|client-side entity/);
  });

  it("refuses an add with no classname and a match with no selector", () => {
    expect(() => applyEntityOps(lump.text, lump.entities, [{ op: "add", keyvalues: {} }])).toThrow(
      /classname/,
    );
    expect(() =>
      applyEntityOps(lump.text, lump.entities, [{ op: "remove", match: {} }]),
    ).toThrow(/at least one of/);
  });

  it("produces text the entity reader can parse back", () => {
    const r = applyEntityOps(lump.text, lump.entities, [
      { op: "add", keyvalues: { classname: "info_target", targetname: "roundtrip" } },
      { op: "remove", match: { classname: "light" } },
    ]);
    const reparsed = decodeLmp(
      encodeLmp(r.text, { lumpID: 0, mapRevision: lump.header.mapRevision }),
    );
    expect(reparsed.payload.toString("utf8")).toBe(r.text);
  });
});
