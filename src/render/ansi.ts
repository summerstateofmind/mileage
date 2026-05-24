const supports = !!process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (codes: number[]) => (s: string) =>
  supports ? `\x1b[${codes.join(';')}m${s}\x1b[0m` : s;

export const bold = wrap([1]);
export const dim = wrap([2]);
export const italic = wrap([3]);
export const green = wrap([32]);
export const red = wrap([31]);
export const yellow = wrap([33]);
export const cyan = wrap([36]);
export const magenta = wrap([35]);
export const blue = wrap([34]);
export const white = wrap([37]);
export const brightCyan = wrap([1, 36]);
export const brightMagenta = wrap([1, 35]);

export function ansi256(code: number): (s: string) => string {
  return (s: string) => (supports ? `\x1b[38;5;${code}m${s}\x1b[0m` : s);
}

/**
 * Render text inside a gradient sparkline-style bar. Used for the dashboard
 * header. Subtle by design — the colors aren't load-bearing for any signal.
 */
export function gradientBar(width: number = 32): string {
  const blocks = '▁▂▃▄▅▆▇█▇▆▅▄▃▂▁';
  const palette = [33, 39, 45, 51, 87, 123, 159];
  let out = '';
  for (let i = 0; i < width; i++) {
    const ch = blocks[i % blocks.length];
    const color = palette[i % palette.length];
    out += ansi256(color)(ch);
  }
  return out;
}
