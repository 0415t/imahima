import { useEffect, useState } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

/**
 * To support static rendering, this value needs to be re-calculated on the client side for web
 */
export function useColorScheme() {
  const [hasHydrated, setHasHydrated] = useState(false);

  useEffect(() => {
    let mounted = true;
    // Keep the light fallback for both server rendering and the first client render.
    queueMicrotask(() => {
      if (mounted) setHasHydrated(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const colorScheme = useRNColorScheme();

  if (hasHydrated) {
    return colorScheme;
  }

  return 'light';
}
