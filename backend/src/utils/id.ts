export function uid(prefix = ""): string {
  const rand = Math.random().toString(16).slice(2);
  const t = Date.now().toString(16);
  return `${prefix}${t}-${rand}`;
}
