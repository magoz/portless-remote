import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { BoundaryError } from "./model.js";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const fileError = (error: PlatformError) =>
  new BoundaryError({
    code: error.reason._tag === "NotFound" ? "file-missing" : "file-unreadable",
  });

export class Files extends Context.Service<
  Files,
  {
    readonly read: (
      path: string,
      noFollow?: boolean,
    ) => Effect.Effect<string, BoundaryError>;
  }
>()("portless-remote/Files") {
  static readonly layer = Layer.effect(
    Files,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const read = Effect.fn("Files.read")(
        function* (path: string, noFollow = false) {
          if (noFollow) {
            // Native stat follows links, including dangling ones. Inspect the
            // directory entry first so only genuine absence means first run.
            const link = yield* Effect.result(fs.readLink(path));
            if (link._tag === "Success") {
              return yield* Effect.fail(
                new BoundaryError({ code: "file-symlink-rejected" }),
              );
            }
            // POSIX readlink reports EINVAL for an existing non-link. Effect's
            // Node backend preserves this errno in the typed platform cause.
            // All other failures remain failures; no raw cause is retained.
            if (
              !Schema.is(Schema.Struct({ code: Schema.Literal("EINVAL") }))(
                link.failure.reason.cause,
              )
            ) {
              return yield* Effect.fail(link.failure);
            }
          }
          // Check before open to reject FIFOs/devices. The state directory is private;
          // this is not a defense against an attacker running as the same OS user.
          const stat = yield* fs.stat(path);
          if (stat.type !== "File" || stat.size > BigInt(MAX_FILE_BYTES)) {
            return yield* Effect.fail(
              new BoundaryError({ code: "file-unsupported-or-oversized" }),
            );
          }
          if (noFollow && (yield* fs.realPath(path)) !== path) {
            return yield* Effect.fail(
              new BoundaryError({ code: "file-symlink-rejected" }),
            );
          }
          const file = yield* fs.open(path, { flag: "r" });
          const bytes = yield* file.readAlloc(MAX_FILE_BYTES + 1);
          const buffer = Option.getOrElse(bytes, () => new Uint8Array());
          if (buffer.length > MAX_FILE_BYTES) {
            return yield* Effect.fail(
              new BoundaryError({ code: "file-unsupported-or-oversized" }),
            );
          }
          return yield* Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(buffer),
            catch: () => new BoundaryError({ code: "file-invalid-encoding" }),
          });
        },
        Effect.scoped,
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(fileError(error)),
        ),
      );
      return Files.of({ read });
    }),
  );
}

export type Liveness = "alive" | "dead" | "permission-denied" | "unknown";
// Effect has no signal-0 PID visibility API. This is the sole process boundary;
// no app is started, killed, signalled, or given environment variables.
export const probePid = (
  pid: number,
  kill: (pid: number, signal: 0) => unknown = process.kill,
): Effect.Effect<Liveness> =>
  Effect.try({
    try: () => {
      kill(pid, 0);
      return "alive" as const;
    },
    catch: (error): Liveness => {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined;
      return code === "ESRCH"
        ? "dead"
        : code === "EPERM"
          ? "permission-denied"
          : "unknown";
    },
  }).pipe(Effect.catch((status) => Effect.succeed(status)));

export class Processes extends Context.Service<
  Processes,
  {
    readonly probe: (pid: number) => Effect.Effect<Liveness>;
  }
>()("portless-remote/Processes") {
  static readonly layer = Layer.succeed(Processes, { probe: probePid });
}
