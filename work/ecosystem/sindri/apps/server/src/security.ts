import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time comparison of a presented bearer token against the expected one. */
export function tokenMatches(authorization: string | undefined, expected: string): boolean {
  if (!authorization) return false;
  const m = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!m || !m[1]) return false;
  return timingSafeEqual(digest(m[1]), digest(expected));
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Hostname part of a Host header, lower-cased; IPv6 literals keep their brackets. */
export function hostnameOf(host: string | undefined): string {
  if (!host) return "";
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  const i = h.lastIndexOf(":");
  return i === -1 ? h : h.slice(0, i);
}

export const isLoopbackHostHeader = (host: string | undefined) =>
  LOOPBACK_HOSTNAMES.has(hostnameOf(host));
