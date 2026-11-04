/**
 * URL prefix utility for handling deployment behind proxies
 * Reads the public build-time prefix shared with next.config.js
 */

// Normalize URL prefix: add leading '/' if missing, treat '/' as empty for root
const normalizePrefix = (prefix) => {
  if (!prefix || prefix === '/') return '';
  return prefix.startsWith('/') ? prefix : `/${prefix}`;
};

// Next.js handles routing and assets; this is for manual URL construction.
export const BASE_PATH = normalizePrefix(
  process.env.NEXT_PUBLIC_SAFE_SETTINGS_HUB_URL_PREFIX ?? '/safe-settings'
);

/**
 * Prepend base path to a URL
 * Note: Next.js Link component and router.push already handle basePath automatically
 * This is primarily for <a> tags and manual URL construction
 * @param {string} path - The path to prepend base path to
 * @returns {string} The full path with base path
 */
export function withBasePath(path) {
  // Ensure path starts with /
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  
  // If no base path, return as-is
  if (!BASE_PATH) return normalizedPath;
  
  // Remove trailing slash from base path if present
  const cleanBasePath = BASE_PATH.endsWith('/') ? BASE_PATH.slice(0, -1) : BASE_PATH;
  
  return `${cleanBasePath}${normalizedPath}`;
}
