interface PendingQuestion {
  resolve: (response: string) => void;
}

const pending = new Map<number, PendingQuestion>();

export function addPending(id: number): Promise<string> {
  return new Promise<string>((resolve) => {
    pending.set(id, { resolve });
  });
}

export function resolvePending(id: number, response: string): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.resolve(response);
  pending.delete(id);
  return true;
}

export function hasPending(id: number): boolean {
  return pending.has(id);
}
