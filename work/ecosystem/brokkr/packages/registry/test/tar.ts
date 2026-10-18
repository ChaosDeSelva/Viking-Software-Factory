import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

export interface TarEntry {
  name: string;
  /** '0' file (default), '5' directory, '2' symlink, '1' hardlink. */
  type?: "0" | "1" | "2" | "5";
  content?: string;
  linkname?: string;
}

function field(buf: Buffer, offset: number, length: number, value: string): void {
  buf.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

/** Hand-build a gzipped ustar archive so tests control every header (including hostile ones). */
export function writeTarGz(file: string, entries: TarEntry[]): void {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const type = e.type ?? "0";
    const data = Buffer.from(type === "0" ? (e.content ?? "") : "");
    const header = Buffer.alloc(512);
    field(header, 0, 100, e.name);
    field(header, 100, 8, octal(type === "5" ? 0o755 : 0o644, 8));
    field(header, 108, 8, octal(0, 8));
    field(header, 116, 8, octal(0, 8));
    field(header, 124, 12, octal(data.length, 12));
    field(header, 136, 12, octal(1_700_000_000, 12));
    field(header, 148, 8, "        ");
    field(header, 156, 1, type);
    if (e.linkname) field(header, 157, 100, e.linkname);
    field(header, 257, 6, "ustar\0");
    field(header, 263, 2, "00");
    let sum = 0;
    for (const byte of header) sum += byte;
    field(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  writeFileSync(file, gzipSync(Buffer.concat(blocks)));
}
