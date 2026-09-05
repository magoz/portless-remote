import { expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeReconciler } from "../src/reconciler.js";
import { watch } from "../src/watch.js";
import { Files } from "../src/io.js";
import {
  configEffect,
  fixture,
  memoryServices,
  platform,
  route,
} from "./helpers.js";

it.effect(
  "renews scoped watchers, polls, deduplicates output, and cancels all resources",
  () =>
    Effect.gen(function* () {
      const config = yield* configEffect;
      const m = yield* memoryServices(config);
      const r = yield* makeReconciler(config, { settleMs: 0 }).pipe(
        Effect.provide(m.services),
      );
      const acquired = yield* Ref.make(0);
      const released = yield* Ref.make(0);
      const passes = yield* Ref.make(0);
      const reports = yield* Ref.make(0);
      const fakeFs = FileSystem.makeNoop({
        watch: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Ref.update(acquired, (n) => n + 1),
                () => Ref.update(released, (n) => n + 1),
              );
              return Stream.never;
            }),
          ),
      });
      const fiber = yield* Effect.forkScoped(
        watch(
          config,
          r.run.pipe(Effect.tap(() => Ref.update(passes, (n) => n + 1))),
          () => Ref.update(reports, (n) => n + 1),
        ).pipe(Effect.provideService(FileSystem.FileSystem, fakeFs)),
      );
      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(passes)).toBeGreaterThanOrEqual(4);
      expect(yield* Ref.get(reports)).toBe(1);
      expect(yield* Ref.get(acquired)).toBeGreaterThanOrEqual(4);
      yield* Fiber.interrupt(fiber);
      expect(yield* Ref.get(released)).toBe(yield* Ref.get(acquired));
      const stopped = yield* Ref.get(passes);
      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(passes)).toBe(stopped);
    }),
);

it.live(
  "real watcher recovers after registry directory removal/recreation and notices unseen apps",
  () =>
    Effect.gen(function* () {
      const { config, fs, registry } = yield* fixture;
      yield* fs.writeFileString(registry, JSON.stringify([route()]));
      const m = yield* memoryServices(config);
      // Use real file reads, with an isolated in-memory intent store and no provider.
      const realFiles = yield* Files;
      const r = yield* makeReconciler(config, { settleMs: 1 }).pipe(
        Effect.provideService(Files, realFiles),
        Effect.provide(m.services),
      );
      const output = yield* Queue.unbounded<readonly string[]>();
      const fiber = yield* Effect.forkScoped(
        watch(config, r.run, (report) =>
          Queue.offer(output, report.observation.hosts).pipe(Effect.asVoid),
        ),
      );
      expect(yield* Queue.take(output)).toEqual(["app.dev.example.com"]);
      yield* fs.remove(config.portlessStateDir, { recursive: true });
      yield* fs.makeDirectory(config.portlessStateDir);
      yield* fs.writeFileString(
        registry,
        JSON.stringify([route("unseen.dev.example.com")]),
      );
      const names = yield* Queue.take(output);
      expect(names).toEqual(["unseen.dev.example.com"]);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(platform), Effect.timeout("5 seconds")),
);
