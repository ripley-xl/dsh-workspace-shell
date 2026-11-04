const MAX_COMMAND_LENGTH = 4096;
const MAX_ARGUMENTS = 64;

export function parseCommandLine(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_COMMAND_LENGTH || /[\0\r\n]/u.test(value)) {
    throw new TypeError('Invalid TUI command.');
  }
  const args = [];
  let part = '';
  let started = false;
  let quote;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\' && quote !== "'") {
      if (index + 1 >= value.length) throw new TypeError('Invalid TUI command escape.');
      part += value[++index];
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else part += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === ' ' || character === '\t') {
      if (!started) continue;
      args.push(part);
      part = '';
      started = false;
      if (args.length > MAX_ARGUMENTS) throw new TypeError('Too many TUI command arguments.');
      continue;
    }
    part += character;
    started = true;
  }
  if (quote) throw new TypeError('Unclosed TUI command quote.');
  if (started) args.push(part);
  if (!args.length || args.length > MAX_ARGUMENTS) throw new TypeError('Invalid TUI command.');
  return args;
}
