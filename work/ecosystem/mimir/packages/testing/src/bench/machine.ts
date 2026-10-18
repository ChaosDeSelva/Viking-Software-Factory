import { execFileSync } from "node:child_process";
import { cpus, loadavg, totalmem } from "node:os";

/** Where a benchmark ran; recorded next to every result set. */
export interface MachineInfo {
  cpu: string;
  cores: number;
  memoryGb: number;
  loadAvg: [number, number, number];
  node: string;
  platform: string;
}

function cpuBrand(): string {
  if (process.platform === "darwin") {
    try {
      const brand = execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], {
        encoding: "utf8",
      }).trim();
      if (brand !== "") return brand;
    } catch {
      // fall through to os.cpus()
    }
  }
  return cpus()[0]?.model ?? "unknown";
}

export function describeMachine(): MachineInfo {
  const [l1 = 0, l5 = 0, l15 = 0] = loadavg();
  return {
    cpu: cpuBrand(),
    cores: cpus().length,
    memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    loadAvg: [l1, l5, l15].map((n) => Math.round(n * 100) / 100) as [number, number, number],
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
  };
}

export function formatMachine(m: MachineInfo): string {
  return [
    `cpu: ${m.cpu} (${m.cores} cores)`,
    `memory: ${m.memoryGb} GB`,
    `load average: ${m.loadAvg.join(" ")}`,
    `node: ${m.node} on ${m.platform}`,
  ].join("\n");
}

/** Heap in use, after a full GC when the process runs with `--expose-gc`. */
export function heapUsedBytes(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  return process.memoryUsage().heapUsed;
}
