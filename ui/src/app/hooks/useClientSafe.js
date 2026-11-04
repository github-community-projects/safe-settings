'use client';

import { useState, useEffect } from 'react';

/**
 * Custom hook to handle client-side mounting
 * Helps prevent hydration mismatches by ensuring client-specific code
 * only runs after the component has mounted on the client
 */
export const useIsClient = () => {
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  return isClient;
};

/**
 * Custom hook for client-safe date formatting
 * Returns a consistent format between server and client to prevent hydration issues
 */
export const useClientSafeDate = () => {
  const isClient = useIsClient();

  const formatDate = (dateString) => {
    if (!isClient) {
      // Server-side: return a simple format that matches potential client output
      return new Date(dateString).toISOString().split('T')[0];
    }
    
    // Client-side: full formatting
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return { formatDate, isClient };
};
