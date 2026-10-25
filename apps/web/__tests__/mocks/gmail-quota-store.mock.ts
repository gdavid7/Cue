import type {
  GmailQuotaNote,
  GmailQuotaStore,
} from "@/utils/gmail/quota-store";

/**
 * In-memory stand-in for the Redis quota store, following the same bucket
 * and window arithmetic as its Lua scripts on the (fakeable) `Date.now()`
 * clock.
 */
export function createMemoryGmailQuotaStore(): GmailQuotaStore & {
  reset(): void;
} {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const windows = new Map<
    string,
    Array<{ at: number; cost: number; id?: string }>
  >();
  let sequence = 0;
  // Demand episodes: when the yield ends and when the next may start.
  const demands = new Map<string, { endsAt: number; renewsAt: number }>();
  const blocks = new Map<string, number>();
  const usage = new Map<string, Record<string, number>>();
  const budgets = new Map<string, { perMinute: number; at: number }>();
  const trailing = new Map<
    string,
    Array<{ at: number; cost: number; id?: string }>
  >();
  const trailingUnits = (key: string, windowMs: number) => {
    const recent = (trailing.get(key) ?? []).filter(
      (entry) => entry.at > Date.now() - windowMs,
    );
    trailing.set(key, recent);
    return recent.reduce((sum, entry) => sum + entry.cost, 0);
  };
  const claimed = new Set<string>();
  const ttl = (key: string) => Math.max(0, (blocks.get(key) ?? 0) - Date.now());

  const addNotes = (notes: GmailQuotaNote[]) => {
    for (const { usageKey, field, amount } of notes) {
      const fields = usage.get(usageKey) ?? {};
      fields[field] = (fields[field] ?? 0) + amount;
      usage.set(usageKey, fields);
    }
  };

  return {
    async take(input) {
      const now = Date.now();
      addNotes(
        (input.notes ?? []).map((note) => ({
          ...note,
          usageKey: input.usageKey,
        })),
      );
      for (const { reservation, kept } of input.release ?? []) {
        const sent = trailing.get(input.budget.trailingKey) ?? [];
        trailing.set(
          input.budget.trailingKey,
          sent.flatMap((entry) =>
            entry.id !== reservation
              ? [entry]
              : kept > 0
                ? [{ at: entry.at, cost: kept }]
                : [],
          ),
        );
      }
      for (const { reservation, kept, soonerMs } of input.release ?? []) {
        const entries = windows.get(input.pace.key) ?? [];
        const held = entries.find((entry) => entry.id === reservation);
        if (!held) continue;
        windows.set(
          input.pace.key,
          entries
            .flatMap((entry) =>
              entry !== held
                ? [entry]
                : kept > 0
                  ? [
                      {
                        at: entry.at - Math.max(0, Math.floor(soonerMs)),
                        cost: kept,
                      },
                    ]
                  : [],
            )
            .sort((a, b) => a.at - b.at),
        );
      }
      const held = input.blockers.filter(({ key }) => ttl(key) > 0);
      const defer = held.some(({ deferMs }) => deferMs);
      let wait = Math.max(
        0,
        ...held.map(({ key, deferMs }) => deferMs || ttl(key)),
      );
      let gate: "blocker" | "bucket" | "pace" | "interactive_demand" =
        "blocker";
      let blocker = 0;
      input.blockers.forEach(({ key, deferMs }, index) => {
        if (!blocker && ttl(key) > 0 && (deferMs || ttl(key)) === wait)
          blocker = index + 1;
      });
      const { budget } = input;
      let current = budgets.get(budget.key);
      if (!current) {
        current = { perMinute: budget.start, at: now };
        budgets.set(budget.key, current);
      } else if (now - current.at >= budget.raiseEveryMs) {
        const steps = Math.floor((now - current.at) / budget.raiseEveryMs);
        current = {
          perMinute: Math.min(
            budget.max,
            Math.floor(current.perMinute * budget.raiseFactor ** steps),
          ),
          at: current.at + steps * budget.raiseEveryMs,
        };
        budgets.set(budget.key, current);
      }
      const rate = current.perMinute / 60_000;
      const stored = buckets.get(input.bucketKey);
      const tokens = Math.min(
        input.capacity,
        (stored?.tokens ?? input.capacity) +
          Math.max(0, now - (stored?.at ?? now)) * rate,
      );
      const { pace } = input;
      const recent = (windows.get(pace.key) ?? []).filter(
        (entry) => entry.at > now - pace.windowMs,
      );
      windows.set(pace.key, recent);
      const cap =
        pace.slowKey && ttl(pace.slowKey) > 0
          ? Math.floor(pace.cap / 2)
          : pace.cap;
      const demandTtl = (demands.get(pace.demand.key)?.endsAt ?? 0) - now;
      const assess = (
        units: number,
        held: number,
        entries: Array<{ at: number; cost: number }>,
        blocked: { wait: number; gate: typeof gate },
      ) => {
        let { wait, gate: reason } = blocked;
        const need =
          input.floor + Math.min(units, input.capacity - input.floor);
        if (held < need && Math.ceil((need - held) / rate) > wait) {
          wait = Math.ceil((need - held) / rate);
          reason = "bucket";
        }
        const unpaced = wait;
        const inWindow = entries.reduce((sum, entry) => sum + entry.cost, 0);
        const windowWait = (limit: number) => {
          if (limit <= 0) return -1;
          const excess = inWindow + Math.min(units, limit) - limit;
          if (excess <= 0) return 0;
          let freed = 0;
          for (const entry of entries) {
            freed += entry.cost;
            if (freed >= excess) return entry.at + pace.windowMs - now + 1;
          }
          return pace.windowMs;
        };
        let paceWait = windowWait(cap);
        if (pace.demand.yieldCap !== undefined && demandTtl > 0) {
          const afterDemand = Math.max(demandTtl, paceWait);
          const yieldWait = windowWait(pace.demand.yieldCap);
          paceWait =
            yieldWait < 0 || yieldWait > afterDemand ? afterDemand : yieldWait;
          if (paceWait > wait) reason = "interactive_demand";
        } else if (paceWait > wait) {
          reason = "pace";
        }
        return {
          wait: Math.max(wait, paceWait),
          gate: reason,
          unpaced,
          need,
          inWindow,
        };
      };
      const assessed = assess(input.cost, tokens, recent, { wait, gate });
      wait = assessed.wait;
      gate = assessed.gate;
      const { unpaced: unpacedWait, need, inWindow } = assessed;
      const episode = demands.get(pace.demand.key);
      const willWait =
        input.waitBudgetMs === undefined || unpacedWait <= input.waitBudgetMs;
      if (
        pace.demand.markMs &&
        willWait &&
        (!episode || episode.renewsAt <= now)
      )
        demands.set(pace.demand.key, {
          endsAt: now + pace.demand.markMs,
          renewsAt: now + (pace.demand.everyMs ?? pace.demand.markMs),
        });
      if (wait > 0)
        return {
          waitMs: wait,
          defer,
          queued: 0,
          ahead: 0,
          reservation: null,
          held: {
            gate,
            blocker,
            availableUnits: Math.floor(tokens),
            neededUnits: need,
            paceUnits: inWindow,
          },
        };

      const grantCap =
        pace.demand.yieldCap !== undefined && demandTtl > 0
          ? Math.min(cap, pace.demand.yieldCap)
          : cap;
      let used = input.cost;
      let queued = 0;
      const admittedQueued: { cost: number; field: string }[] = [];
      for (const entry of input.queued ?? []) {
        const queuedCost = entry.cost;
        if (
          tokens - used - queuedCost < input.floor ||
          inWindow + used + queuedCost > grantCap
        )
          break;
        used += queuedCost;
        queued++;
        admittedQueued.push(entry);
      }
      let ahead = 0;
      if (input.ahead && input.ahead.units > 0 && input.ahead.step > 0) {
        const room = Math.min(
          grantCap * input.ahead.share - inWindow - used,
          tokens - used - Math.max(input.floor, input.capacity / 2),
          input.ahead.units,
        );
        if (room > 0)
          ahead = Math.floor(room / input.ahead.step) * input.ahead.step;
      }
      buckets.set(input.bucketKey, { tokens: tokens - used - ahead, at: now });
      recent.push({ at: now, cost: used });
      sequence++;
      const reservation = ahead > 0 ? `${sequence}:ahead:${ahead}` : null;
      if (reservation)
        recent.push({
          at: now + (input.ahead?.leaseMs ?? 0),
          cost: ahead,
          id: reservation,
        });
      recent.sort((a, b) => a.at - b.at);
      trailingUnits(budget.trailingKey, budget.trailingWindowMs);
      trailing.get(budget.trailingKey)?.push({ at: now, cost: used });
      if (reservation)
        trailing
          .get(budget.trailingKey)
          ?.push({ at: now, cost: ahead, id: reservation });
      const fields = usage.get(input.usageKey) ?? {};
      fields[input.usageField] = (fields[input.usageField] ?? 0) + input.cost;
      for (const entry of admittedQueued)
        fields[entry.field] = (fields[entry.field] ?? 0) + entry.cost;
      fields["budget:perMinute"] = Math.floor(current.perMinute);
      fields["peak:second"] = Math.max(
        fields["peak:second"] ?? 0,
        inWindow + used,
      );
      usage.set(input.usageKey, fields);
      const left = tokens - used - ahead;
      const next = assess(
        input.queued?.[queued]?.cost ?? input.cost,
        left,
        recent,
        {
          wait: 0,
          gate: "blocker",
        },
      );
      return {
        waitMs: 0,
        defer: false,
        queued,
        ahead,
        reservation,
        ...(next.wait > 0 && {
          nextWait: {
            waitMs: next.wait,
            held: {
              gate: next.gate,
              blocker: 0,
              availableUnits: Math.floor(left),
              neededUnits: next.need,
              paceUnits: next.inWindow,
            },
          },
        }),
      };
    },
    async cutBudget(input) {
      const units = trailingUnits(input.trailingKey, input.trailingWindowMs);
      const perMinute = Math.min(
        budgets.get(input.key)?.perMinute ?? input.start,
        Math.max(input.floor, Math.floor(units * input.fraction)),
      );
      budgets.set(input.key, { perMinute, at: Date.now() });
      return perMinute;
    },
    async block({ key, ms }) {
      if (ttl(key) < ms) blocks.set(key, Date.now() + ms);
    },
    async clear(key) {
      blocks.delete(key);
    },
    async holdDemand({ key, ms, gapMs }) {
      const endsAt = Date.now() + ms;
      if ((demands.get(key)?.endsAt ?? 0) >= endsAt) return 0;
      demands.set(key, { endsAt, renewsAt: endsAt + gapMs });
      return endsAt;
    },
    async releaseDemand({ key, endsAt, gapMs }) {
      if (demands.get(key)?.endsAt !== endsAt) return;
      const now = Date.now();
      demands.set(key, { endsAt: now, renewsAt: now + gapMs });
    },
    async note(notes) {
      addNotes(notes);
    },
    async claimUsages(input, notes = []) {
      addNotes(notes);
      return input.map(({ usageKey, claimKey }) => {
        const fields = usage.get(usageKey);
        if (!fields || claimed.has(claimKey)) return null;
        claimed.add(claimKey);
        return { ...fields };
      });
    },
    reset() {
      buckets.clear();
      windows.clear();
      demands.clear();
      blocks.clear();
      usage.clear();
      budgets.clear();
      trailing.clear();
      claimed.clear();
    },
  };
}
