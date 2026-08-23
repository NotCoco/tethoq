import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class JsonFileStore<T> {
  public constructor(private readonly path: string, private readonly validate: (value: unknown) => T) {}

  public async read(defaultValue: T): Promise<T> {
    try {
      const text = await readFile(this.path, "utf8");
      return this.validate(JSON.parse(text) as unknown);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") return defaultValue;
      throw error;
    }
  }

  public async write(value: T): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await replaceFile(temporary, this.path);
  }
}

/**
 * On Windows a virus scanner or search indexer can hold a freshly written file
 * open for a few milliseconds, and the atomic rename then fails with EPERM or
 * EBUSY. The write is still valid, so retry briefly before giving up rather than
 * losing a preference the user just set.
 */
async function replaceFile(temporary: string, destination: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (attempt >= attempts || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 20));
    }
  }
}
