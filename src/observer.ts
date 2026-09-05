import { join } from "node:path";
import { Effect, Schedule, Schema } from "effect";
import {
  BoundaryError,
  inNamespace,
  RouteSchema,
  sortedUnique,
} from "./model.js";
import type { Config } from "./model.js";
import { Files, Processes } from "./io.js";

export interface Notice {
  readonly index: number;
  readonly code: string;
}
export interface Snapshot {
  readonly hosts: readonly string[];
  readonly notices: readonly Notice[];
}

// Read directly: RouteStore intentionally collapses missing/corrupt/unreadable to [].
// Preserve that distinction and never invoke its mutating cleanup/lock methods.
export const observe = Effect.fn("Observer.observe")(function* (
  config: Config,
  settleMs = 75,
) {
  const files = yield* Files;
  const processes = yield* Processes;
  const path = join(config.portlessStateDir, "routes.json");
  const readStable = Effect.gen(function* () {
    const first = yield* files.read(path);
    yield* Effect.sleep(settleMs);
    const second = yield* files.read(path);
    if (first !== second)
      return yield* Effect.fail(
        new BoundaryError({ code: "registry-unstable" }),
      );
    // Ignore optional Portless transport metadata. It is never logged or persisted.
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(RouteSchema)),
    )(second).pipe(
      Effect.mapError(() => new BoundaryError({ code: "registry-invalid" })),
    );
  });
  const routes = yield* readStable.pipe(
    Effect.retry({
      schedule: Schedule.exponential("50 millis"),
      times: 2,
    }),
  );
  if (routes.length > config.maxHosts)
    return yield* Effect.fail(new BoundaryError({ code: "registry-limit" }));
  const hosts: string[] = [];
  const notices: Notice[] = [];
  const seen = new Set<string>();
  for (const [index, route] of routes.entries()) {
    if (!inNamespace(route.hostname, config.namespace)) {
      notices.push({ index, code: "hostname-outside-namespace-or-invalid" });
      continue;
    }
    if (seen.has(route.hostname))
      return yield* Effect.fail(
        new BoundaryError({ code: "registry-duplicate-host" }),
      );
    seen.add(route.hostname);
    if (route.pid === 0) {
      notices.push({
        index,
        code: config.includePersistentAliases
          ? "alias-liveness-unverified"
          : "alias-excluded",
      });
      if (config.includePersistentAliases) hosts.push(route.hostname);
      continue;
    }
    if (config.pidMode === "unverified") {
      // No PID probing across namespaces; never misclassify a foreign PID as dead.
      notices.push({ index, code: "pid-namespace-unverified-excluded" });
      continue;
    }
    const status = yield* processes.probe(route.pid);
    if (status === "dead" || status === "unknown") {
      notices.push({
        index,
        code: status === "dead" ? "process-dead" : "pid-probe-unknown-excluded",
      });
      continue;
    }
    if (status === "permission-denied")
      notices.push({ index, code: "pid-permission-denied-assumed-alive" });
    hosts.push(route.hostname);
  }
  return { hosts: sortedUnique(hosts), notices } satisfies Snapshot;
});
