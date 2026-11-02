import type { UserRequestAdmission } from "./request_admission";

/** Wait for every owner to finish before allowing a failed exit to recover. */
export async function settle_shutdown(
  operations: readonly (() => Promise<void>)[],
): Promise<void> {
  const outcomes = await Promise.allSettled(
    operations.map((operation) => Promise.resolve().then(operation)),
  );
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(
      errors,
      errors
        .map((error) =>
          error instanceof Error ? error.message : String(error),
        )
        .join("\n"),
    );
}

export class ShutdownCoordinator {
  private pending: Promise<void> | null = null;

  constructor(
    private readonly admission: UserRequestAdmission,
    private readonly operations: readonly (() => Promise<void>)[],
  ) {}

  stop(): Promise<void> {
    if (this.pending) return this.pending;
    this.admission.begin_shutdown();
    const operation = settle_shutdown(this.operations).catch((error) => {
      this.admission.recover_shutdown();
      throw error;
    });
    this.pending = operation;
    void operation
      .finally(() => {
        if (this.pending === operation) this.pending = null;
      })
      .catch(() => undefined);
    return operation;
  }
}
