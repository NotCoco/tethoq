import { dirname } from "node:path";
import type { DeviceCredentialPayload, PairingState } from "../../../packages/protocol/src/index.js";
import { JsonFileStore } from "./persistence.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function device(value: unknown): DeviceCredentialPayload {
  if (!isRecord(value) || value.version !== 1 || typeof value.credentialId !== "string" || typeof value.hostId !== "string" || typeof value.deviceId !== "string" || typeof value.devicePublicKeyPem !== "string" || typeof value.issuedAt !== "string") {
    throw new Error("Persisted paired-device record is invalid");
  }
  return {
    version: 1,
    credentialId: value.credentialId,
    hostId: value.hostId,
    deviceId: value.deviceId,
    devicePublicKeyPem: value.devicePublicKeyPem,
    issuedAt: value.issuedAt,
  };
}

function validate(value: unknown): PairingState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.devices) || !Array.isArray(value.revokedCredentialIds) || !value.revokedCredentialIds.every((entry) => typeof entry === "string")) {
    throw new Error("Pairing-state file is invalid");
  }
  return { version: 1, devices: value.devices.map(device), revokedCredentialIds: value.revokedCredentialIds };
}

export function defaultPairingStatePath(configPath: string): string {
  return `${dirname(configPath)}/paired-devices.json`;
}

export class PairingStateStore {
  readonly #store: JsonFileStore<PairingState>;
  #tail: Promise<void> = Promise.resolve();

  public constructor(path: string) {
    this.#store = new JsonFileStore(path, validate);
  }

  public async read(): Promise<PairingState> {
    return await this.#store.read({ version: 1, devices: [], revokedCredentialIds: [] });
  }

  public scheduleWrite(state: PairingState): void {
    this.#tail = this.#tail.then(() => this.#store.write(state));
  }

  public async flush(): Promise<void> {
    await this.#tail;
  }
}
