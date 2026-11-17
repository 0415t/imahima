import type { AvailabilityDependencies } from '../../server/app';

const disabled = async (): Promise<never> => {
  throw new Error('Timer mutations are disabled in chat verification');
};

// Chat-only harnesses must satisfy the full app contract without accidentally
// invoking timer RPCs. Each caller retains its own identity and toggle behavior.
export const disabledTimerDependencies: Pick<AvailabilityDependencies,
  'setIsFree' | 'extendIsFree' | 'extendIsFreeFromNotification'> = {
  setIsFree: disabled,
  extendIsFree: disabled,
  extendIsFreeFromNotification: disabled,
};
