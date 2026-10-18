export function workerInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a worker specification.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,63}$/.test(name)) throw new Error('Use a name of 1–64 letters, numbers, spaces, underscores or dashes.');
  if (!['node','python','general'].includes(input.template)) throw new Error('Select a supported template.');
  if (!Number.isInteger(input.minutes) || input.minutes < 5 || input.minutes > 240) throw new Error('Lifetime must be 5–240 minutes.');
  return { name, template: input.template, minutes: input.minutes };
}
export const actions = new Set(['start','stop','reboot','terminate']);
