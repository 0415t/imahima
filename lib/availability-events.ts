const listeners = new Set<() => void>();

export function subscribeAvailabilityChanged(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyAvailabilityChanged() {
  for (const listener of listeners) listener();
}
