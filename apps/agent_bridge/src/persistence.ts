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
    await rename(temporary, this.path);
  }
}
