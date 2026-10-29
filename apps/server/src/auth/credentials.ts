import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/**
 * Credentials in one JSON file readable only by its owner. Operations run one at a time, so a
 * token refresh and a sign-out never interleave; pi-ai refreshes OAuth tokens through `modify`.
 */
export class FileCredentialStore implements CredentialStore {
  #chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  #enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(job, job);
    this.#chain = run.catch(() => {});
    return run;
  }

  async #load(): Promise<Record<string, Credential>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, Credential>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async #save(all: Record<string, Credential>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(all, null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
  }

  read(providerId: string): Promise<Credential | undefined> {
    return this.#enqueue(async () => (await this.#load())[providerId]);
  }

  list(): Promise<readonly CredentialInfo[]> {
    return this.#enqueue(async () =>
      Object.entries(await this.#load()).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      })),
    );
  }

  /** `fn` returning undefined leaves the credential as it is, as a request that lost a refresh race does. */
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.#enqueue(async () => {
      const all = await this.#load();
      const next = await fn(all[providerId]);
      if (next === undefined) return all[providerId];
      all[providerId] = next;
      await this.#save(all);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.#enqueue(async () => {
      const all = await this.#load();
      delete all[providerId];
      await this.#save(all);
    });
  }
}
