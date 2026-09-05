import { expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fixture, platform, route } from "./helpers.js";

const execute = Effect.fn(function* (args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const processHandle = yield* spawner.spawn(
    ChildProcess.make(process.execPath, ["dist/cli.js", ...args], {
      env: { NO_COLOR: "1", DNS_TOKEN: "secret-canary" },
      extendEnv: false,
    }),
  );
  const [stdout, stderr, code] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(processHandle.stdout)),
      Stream.mkString(Stream.decodeText(processHandle.stderr)),
      processHandle.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, code };
}, Effect.scoped);

it.live(
  "CLI dry-run and status observe isolated real state, persist intent and report not-ready",
  () =>
    Effect.gen(function* () {
      const { fs, path, root, config, registry } = yield* fixture;
      const configFile = path.join(root, "config.json");
      yield* fs.writeFileString(configFile, JSON.stringify(config));
      yield* fs.writeFileString(
        registry,
        JSON.stringify([route(), route("feat.app.dev.example.com")]),
      );
      const first = yield* execute(["dry-run", "--config", configFile]);
      expect(first.code).toBe(0);
      expect(first.stderr).toBe("");
      const report = JSON.parse(first.stdout);
      expect(report.mode).toBe("dry-run");
      expect(report.ready).toBe(false);
      expect(report.observation.hosts).toEqual([
        "app.dev.example.com",
        "feat.app.dev.example.com",
      ]);
      expect(report.certificates).toHaveLength(1);
      expect(first.stdout).not.toContain("secret-canary");
      const second = yield* execute(["status", "--config", configFile]);
      expect(second.code).toBe(0);
      expect(second.stdout).toBe(first.stdout);
      expect(yield* fs.readDirectory(config.dataDir)).toEqual(["intent.json"]);
    }).pipe(Effect.provide(platform)),
  10_000,
);

it.live(
  "CLI rejects apply and credential-bearing config without echoing secrets",
  () =>
    Effect.gen(function* () {
      const { fs, path, root, config } = yield* fixture;
      const file = path.join(root, "config.json");
      yield* fs.writeFileString(
        file,
        JSON.stringify({ ...config, token: "secret-canary" }),
      );
      const invalid = yield* execute(["dry-run", "--config", file]);
      expect(invalid.code).not.toBe(0);
      expect(invalid.stderr).toContain("config-invalid");
      expect(invalid.stderr + invalid.stdout).not.toContain("secret-canary");
      expect((yield* execute(["apply", "--config", file])).code).not.toBe(0);
      expect(
        (yield* execute(["dry-run", "--config", file, "--apply"])).code,
      ).not.toBe(0);
      expect(yield* fs.exists(config.dataDir)).toBe(false);
    }).pipe(Effect.provide(platform)),
  10_000,
);

for (const killSignal of ["SIGTERM", "SIGKILL"] as const)
  it.live(
    `CLI watch handles ${killSignal} and safe restart`,
    () =>
      Effect.gen(function* () {
        const { fs, path, root, config, registry } = yield* fixture;
        const configFile = path.join(root, "config.json");
        yield* fs.writeFileString(configFile, JSON.stringify(config));
        yield* fs.writeFileString(registry, JSON.stringify([route()]));
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            ["dist/cli.js", "watch", "--config", configFile],
            { env: { NO_COLOR: "1" }, extendEnv: false },
          ),
        );
        const first = yield* handle.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.take(1),
          Stream.runCollect,
        );
        expect(JSON.parse(first[0]!).observation.hosts).toEqual([
          "app.dev.example.com",
        ]);
        expect(
          yield* fs.exists(path.join(config.dataDir, "observer.lock")),
        ).toBe(true);
        yield* handle.kill({ killSignal, forceKillAfter: "2 seconds" });
        const exit = yield* Effect.result(handle.exitCode);
        expect(exit._tag).toBe(
          killSignal === "SIGKILL" ? "Failure" : "Success",
        );
        const lock = path.join(config.dataDir, "observer.lock");
        expect(yield* fs.exists(lock)).toBe(killSignal === "SIGKILL");
        if (killSignal === "SIGKILL") {
          expect(
            (yield* execute(["status", "--config", configFile])).code,
          ).not.toBe(0);
          yield* fs.remove(lock, { recursive: true }); // deliberately recover our isolated fixture
          expect(
            (yield* execute(["status", "--config", configFile])).code,
          ).toBe(0);
        }
      }).pipe(Effect.provide(platform), Effect.timeout("5 seconds")),
    10_000,
  );
