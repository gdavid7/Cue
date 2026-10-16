import { createHash } from "node:crypto";
import { redis } from "@/utils/redis";

const SUMMARY_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function getSummary(text: string): Promise<string | null> {
  return redis.get(summaryKey(text));
}

export async function saveSummary(text: string, summary: string) {
  return redis.set(summaryKey(text), summary, { ex: SUMMARY_TTL_SECONDS });
}

function summaryKey(text: string) {
  return `summary:${createHash("sha256").update(text).digest("hex")}`;
}
