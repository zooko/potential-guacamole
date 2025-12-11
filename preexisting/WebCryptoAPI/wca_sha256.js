
export async function hash(data) {
  // Convert string to Uint8Array if needed
  const buffer = typeof data === 'string' 
    ? new TextEncoder().encode(data) 
    : data;

  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return new Uint8Array(hashBuffer);
}

// Synchronous hex output helper
export async function hashHex(data) {
  const bytes = await hash(data);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
