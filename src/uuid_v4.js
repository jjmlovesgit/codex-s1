const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(str) {
  if (typeof str !== 'string') return false;
  return UUID_V4_REGEX.test(str);
}
