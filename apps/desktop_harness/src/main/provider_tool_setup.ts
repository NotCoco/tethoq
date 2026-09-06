export interface ProviderToolSetupIssue {
  readonly providerId: string;
  readonly message: string;
}

export async function installProviderToolHelpers(tasks: readonly { providerId: string; install: () => Promise<void> }[]): Promise<ProviderToolSetupIssue[]> {
  const results = await Promise.allSettled(tasks.map((task) => task.install()));
  return results.flatMap((result, index) => result.status === "rejected"
    ? [{ providerId: tasks[index]!.providerId, message: "Tethoq could not install this harness's tool helper. Check that its local configuration folder is writable, then retry the connection." }]
    : []);
}
