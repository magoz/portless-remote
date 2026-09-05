import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { BoundaryError } from "../src/model.js";
import { DnsInventory } from "../src/dns.js";
import { makeReconciler } from "../src/reconciler.js";
import { configEffect, memoryServices, route } from "./helpers.js";

it.effect(
  "discovers unseen projects, reuses certificates across worktrees and retains intent after restarts",
  () =>
    Effect.gen(function* () {
      const config = yield* configEffect;
      const m = yield* memoryServices(config);
      const r = yield* makeReconciler(config, { settleMs: 0 }).pipe(
        Effect.provide(m.services),
      );
      const first = yield* r.run;
      expect(first.ready).toBe(false);
      expect(first.certificates).toHaveLength(1);
      yield* Ref.set(
        m.text,
        JSON.stringify([
          route(),
          route("feat.app.dev.example.com"),
          route("unseen.dev.example.com"),
        ]),
      );
      const added = yield* r.run;
      expect(added.certificates).toHaveLength(2);
      expect(added.retainedHosts).toHaveLength(3);
      expect(added.gateway.routes.map((r) => r.hostname)).toContain(
        "feat.app.dev.example.com",
      );
      expect(yield* r.run).toEqual(added);
      expect(yield* Ref.get(m.saveCount)).toBe(2);
      const restarted = yield* makeReconciler(config, { settleMs: 0 }).pipe(
        Effect.provide(m.services),
      );
      expect(yield* restarted.run).toEqual(added);
      expect(yield* Ref.get(m.saveCount)).toBe(2);
    }),
);

it.effect(
  "removal requires confirmation; DNS and certificate intent survive empty snapshots",
  () =>
    Effect.gen(function* () {
      const config = yield* configEffect;
      const m = yield* memoryServices(config);
      const r = yield* makeReconciler(config, { settleMs: 0 }).pipe(
        Effect.provide(m.services),
      );
      const original = yield* r.run;
      yield* Ref.set(m.text, "[]");
      const pending = yield* r.run;
      expect(pending.gateway.action).toBe("hold");
      expect(pending.gateway.routes).toHaveLength(1);
      yield* TestClock.adjust(config.pollIntervalMs);
      const removed = yield* r.run;
      expect(removed.gateway.routes).toEqual([]);
      expect(removed.certificates).toEqual(original.certificates);
      expect(removed.dns).toEqual(original.dns);
      expect(yield* Ref.get(m.saveCount)).toBe(1);
    }),
);

it.effect(
  "a restart with one empty snapshot cannot propose clearing retained gateway names",
  () =>
    Effect.gen(function* () {
      const config = yield* configEffect;
      const m = yield* memoryServices(config);
      const first = yield* makeReconciler(config, { settleMs: 0 }).pipe(
        Effect.provide(m.services),
      );
      yield* first.run;
      yield* Ref.set(m.text, "[]");
      const restarted = yield* makeReconciler(config, { settleMs: 0 }).pipe(
        Effect.provide(m.services),
      );
      expect((yield* restarted.run).gateway.action).toBe("hold");
      yield* TestClock.adjust(config.pollIntervalMs);
      expect((yield* restarted.run).gateway.routes).toEqual([]);
    }),
);

it.effect(
  "corrupt snapshots hold the last good gateway and never erase retained names",
  () =>
    Effect.gen(function* () {
      const config = yield* configEffect;
      const m = yield* memoryServices(config);
      const r = yield* makeReconciler(config, { settleMs: 0 }).pipe(
        Effect.provide(m.services),
      );
      const original = yield* r.run;
      yield* Ref.set(m.text, "[{secret-canary");
      const fiber = yield* Effect.forkScoped(r.run);
      yield* TestClock.adjust("1 second");
      const broken = yield* Fiber.join(fiber);
      expect(broken.observation.status).toBe("unavailable");
      expect(broken.gateway.action).toBe("hold");
      expect(broken.gateway.routes).toEqual(original.gateway.routes);
      expect(broken.certificates).toEqual(original.certificates);
      expect(JSON.stringify(broken)).not.toContain("secret-canary");
      yield* Ref.set(m.text, JSON.stringify([route()]));
      expect(yield* r.run).toEqual(original);
    }),
);

it.effect(
  "bounds provider retries, redacts errors, holds on failure and recovers",
  () =>
    Effect.gen(function* () {
      const config = yield* configEffect;
      const m = yield* memoryServices(config);
      const failing = yield* Ref.make(true);
      const reads = yield* Ref.make(0);
      const r = yield* makeReconciler(config, { settleMs: 0 }).pipe(
        Effect.provideService(DnsInventory, {
          read: Effect.gen(function* () {
            yield* Ref.update(reads, (n) => n + 1);
            if (yield* Ref.get(failing))
              return yield* Effect.fail(
                new BoundaryError({ code: "secret-canary" }),
              );
            return {
              version: 1 as const,
              namespace: config.namespace,
              records: [],
            };
          }),
        }),
        Effect.provide(m.services),
      );
      const fiber = yield* Effect.forkScoped(r.run);
      yield* TestClock.adjust("1 second");
      const failed = yield* Fiber.join(fiber);
      expect(failed.dns).toEqual({ source: "unavailable", changes: [] });
      expect(failed.gateway.action).toBe("hold");
      expect(yield* Ref.get(reads)).toBe(3);
      expect(JSON.stringify(failed)).not.toContain("secret-canary");
      yield* Ref.set(failing, false);
      expect(
        (yield* r.run).dns.changes.every((c) => c.action === "create"),
      ).toBe(true);
    }),
);

it.effect("times out unresponsive providers and remains cancellable", () =>
  Effect.gen(function* () {
    const config = yield* configEffect;
    const m = yield* memoryServices(config);
    const r = yield* makeReconciler(config, { settleMs: 0 }).pipe(
      Effect.provideService(DnsInventory, { read: Effect.never }),
      Effect.provide(m.services),
    );
    const fiber = yield* Effect.forkScoped(r.run);
    yield* TestClock.adjust("7 seconds");
    expect((yield* Fiber.join(fiber)).dns.source).toBe("unavailable");
  }),
);

it.effect(
  "failed persistence never advances desired intent or claims provisioning",
  () =>
    Effect.gen(function* () {
      const config = yield* configEffect;
      const m = yield* memoryServices(config);
      yield* Ref.set(m.failSave, true);
      const r = yield* makeReconciler(config, { settleMs: 0 }).pipe(
        Effect.provide(m.services),
      );
      const failed = yield* r.run;
      expect(failed.retainedHosts).toEqual([]);
      expect(failed.certificates).toEqual([]);
      expect(failed.gateway.action).toBe("hold");
      yield* Ref.set(m.failSave, false);
      expect((yield* r.run).retainedHosts).toEqual(["app.dev.example.com"]);
    }),
);

it.effect(
  "serializes concurrent reconciliation requests and persists each intent only once",
  () =>
    Effect.gen(function* () {
      const config = yield* configEffect;
      const m = yield* memoryServices(config);
      const r = yield* makeReconciler(config, { settleMs: 0 }).pipe(
        Effect.provide(m.services),
      );
      const results = yield* Effect.all(
        Array.from({ length: 20 }, () => r.run),
        { concurrency: "unbounded" },
      );
      expect(
        results.every((r) => JSON.stringify(r) === JSON.stringify(results[0])),
      ).toBe(true);
      expect(yield* Ref.get(m.saveCount)).toBe(1);
    }),
);

it.effect(
  "bounds retained names and emits a strict, non-executable gateway intent",
  () =>
    Effect.gen(function* () {
      const config = { ...(yield* configEffect), maxHosts: 1 };
      const m = yield* memoryServices(config);
      const r = yield* makeReconciler(config, { settleMs: 0 }).pipe(
        Effect.provide(m.services),
      );
      const original = yield* r.run;
      const gatewayRoute = original.gateway.routes[0]!;
      expect(gatewayRoute.upstream).toBe("https://127.0.0.1:443");
      expect(gatewayRoute.tls).toEqual({
        serverName: "app.dev.example.com",
        caFile: config.portlessCaFile,
        insecureSkipVerify: false,
      });
      expect(gatewayRoute.headers).toEqual({
        Host: "app.dev.example.com",
        "X-Forwarded-Host": "app.dev.example.com",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Port": "443",
      });
      expect(JSON.stringify(original.gateway)).not.toContain("4321");
      yield* Ref.set(m.text, JSON.stringify([route("new.dev.example.com")]));
      const limited = yield* r.run;
      expect(limited.blockers).toContain(
        "retention-limit-manual-review-required",
      );
      expect(limited.retainedHosts).toEqual(original.retainedHosts);
    }),
);
