import { DockerEngine, EngineResponseError, type RawStream, type RequestOptions } from "../../src/world/engine.ts";
import { FakeStream } from "./fake-exec.ts";

interface FakeContainer {
  readonly id: string;
  readonly name: string;
  readonly labels: Record<string, string>;
  removed: boolean;
  stream: FakeStream | null;
}

/**
 * Just enough of the Engine API for helper containers: create, inspect,
 * attach, start, wait, kill, and remove. `onStart` drives the output.
 */
export class FakeEngine extends DockerEngine {
  readonly containers = new Map<string, FakeContainer>();
  exitCode = 0;
  onStart: (stream: FakeStream) => void = (stream) => stream.finish("eof");

  constructor() {
    super({ name: "fake", endpoint: "unix:///nonexistent", socketPath: "/nonexistent" });
  }

  #find(route: string): FakeContainer {
    const key = /^\/containers\/([^/]+)/.exec(route)?.[1] ?? "";
    const container = [...this.containers.values()].find((item) => !item.removed && (item.id === key || item.name === decodeURIComponent(key)));
    if (container === undefined) throw new EngineResponseError(404, `${route}: no such container`);
    return container;
  }

  override get(route: string): Promise<unknown> {
    const container = this.#find(route);
    return Promise.resolve({
      Id: container.id,
      Name: `/${container.name}`,
      Image: "sha256:" + "0".repeat(64),
      Config: { Labels: container.labels },
      State: { Running: false, Status: "created", ExitCode: 0, OOMKilled: false, StartedAt: "", FinishedAt: "" },
      HostConfig: {},
      Mounts: [],
    });
  }

  override post(route: string, options: RequestOptions = {}): Promise<unknown> {
    if (route === "/containers/create") {
      const id = String(this.containers.size + 1).padStart(64, "a");
      const body = options.body as { Labels: Record<string, string> };
      this.containers.set(id, { id, name: options.query!.name!, labels: body.Labels, removed: false, stream: null });
      return Promise.resolve({ Id: id });
    }
    const container = this.#find(route);
    if (route.endsWith("/start")) {
      queueMicrotask(() => this.onStart(container.stream!));
      return Promise.resolve(null);
    }
    if (route.endsWith("/wait")) return Promise.resolve({ StatusCode: this.exitCode });
    return Promise.resolve(null);
  }

  override delete(route: string): Promise<unknown> {
    this.#find(route).removed = true;
    return Promise.resolve(null);
  }

  override hijack(route: string): Promise<RawStream> {
    const container = this.#find(route);
    container.stream = new FakeStream();
    return Promise.resolve(container.stream);
  }
}
