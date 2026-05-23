const supports = !!process.stdout.isTTY && !process.env.NO_COLOR;

const code = (n: number) => (s: string) =>
  supports ? `\x1b[${n}m${s}\x1b[0m` : s;

export const bold = code(1);
export const dim = code(2);
export const green = code(32);
export const red = code(31);
export const yellow = code(33);
export const cyan = code(36);
