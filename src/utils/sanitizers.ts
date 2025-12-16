/**
 * Utility functions for sanitizing HTML and generating safe IDs
 */

/**
 * Escape HTML special characters to prevent XSS
 * @param str - String to escape
 * @returns HTML-safe string
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generate a safe HTML ID from a string
 * @param str - String to convert to ID
 * @returns Safe ID string (alphanumeric + underscores only)
 */
export function sanitizeId(str: string): string {
  return str.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * Generate a hash code from a string (for clustering)
 * @param str - String to hash
 * @returns Hash code as hex string
 */
export function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

/**
 * Truncate string to max length with ellipsis
 * @param str - String to truncate
 * @param maxLength - Maximum length
 * @returns Truncated string
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

/**
 * Strip ANSI escape codes from a string
 * @param str - String containing ANSI codes
 * @returns String with ANSI codes removed
 */
export function stripAnsiCodes(str: string): string {
  // Remove ANSI escape sequences (e.g., \x1b[31m, \x1b[0m, etc.)
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Sanitize a string to be used as a safe filename
 * Replaces path separators and other problematic characters while preserving readability
 * @param str - String to sanitize
 * @returns Safe filename string
 */
export function sanitizeFilename(str: string): string {
  // Replace path separators and colons with double underscores for better readability
  return str.replace(/[\/\\:]/g, '__').replace(/[<>"|?*]/g, '_');
}
