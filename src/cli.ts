#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { parseConfig } from "./model.js";
import { Files, Processes } from "./io.js";
import { dnsInventoryLayer } from "./dns.js";
import { intentStoreLayer } from "./state.js";
import { makeReconciler } from "./reconciler.js";
import { watch } from "./watch.js";

const run = Effect.fn("Cli.run")(
  function* (configFile: string, continuous: boolean) {
    const files = yield* Files;
    const config = yield* files
      .read(configFile)
      .pipe(Effect.flatMap(parseConfig));
    const program = Effect.gen(function* () {
      const reconciler = yield* makeReconciler(config);
      if (continuous) {
        yield* watch(config, reconciler.run, (report) =>
          Console.log(JSON.stringify(report)),
        );
      } else {
        yield* Console.log(JSON.stringify(yield* reconciler.run, null, 2));
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          dnsInventoryLayer(config),
          intentStoreLayer(config),
          Processes.layer,
        ),
      ),
    );
    yield* Effect.scoped(program);
  },
  Effect.catchTag("BoundaryError", (error) =>
    Console.error(JSON.stringify({ error: error.code })).pipe(
      Effect.andThen(Effect.fail(error)),
    ),
  ),
);

const config = Flag.string("config").pipe(
  Flag.withDescription("Path to a credential-free configuration JSON file"),
);
const dryRun = Command.make("dry-run", { config }, ({ config }) =>
  run(config, false),
).pipe(
  Command.withDescription(
    "Observe Portless and print DNS/certificate/gateway intents; no external changes",
  ),
);
const status = Command.make("status", { config }, ({ config }) =>
  run(config, false),
).pipe(
  Command.withDescription(
    "Print the same fresh dry-run report, including readiness blockers",
  ),
);
const watchCommand = Command.make("watch", { config }, ({ config }) =>
  run(config, true),
).pipe(
  Command.withDescription(
    "Continuously observe read-only; emit changed dry-run reports as JSON lines",
  ),
);

Command.make("portless-remote").pipe(
  Command.withDescription(
    "Private HTTPS planning companion for Portless (dry-run foundation)",
  ),
  Command.withSubcommands([dryRun, status, watchCommand]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(Files.layer),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
