import type { Brain } from "../src/agent/brain.ts";
import type { Account } from "../src/core/types.ts";
import { Cue } from "../src/engine.ts";
import { demoConnectors } from "../src/ingest/connectors.ts";
import { DEMO_NOW, demoUser, topicSeeds } from "../src/ingest/fixtures.ts";

export async function demoCue(opts: { brain?: Brain } = {}): Promise<Cue> {
  const cue = new Cue({
    userName: demoUser.name,
    accounts: demoUser.accounts as unknown as Account[],
    family: [...demoUser.family],
    connectors: demoConnectors(),
    topics: topicSeeds,
    tz: "America/Los_Angeles",
    now: () => DEMO_NOW,
    brain: opts.brain,
    actionDelayMs: 0,
  });
  await cue.sync();
  return cue;
}

export const laneOf = (cue: Cue, threadId: string) =>
  Object.entries(cue.home()).find(([, cards]) => cards.some((c) => c.threadId === threadId))?.[0];
