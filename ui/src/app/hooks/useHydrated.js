'use client';

import { useState, useEffect } from 'react';

/**
 * Hook that ensures consistent rendering between server and client
 * Prevents hydration mismatches by showing a simple version first,
 * then upgrading to the full version after hydration
 */
export const useHydrated = () => {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  return hydrated;
};
