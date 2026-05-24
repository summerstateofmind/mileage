const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function sparkline(values: number[], width?: number): string {
  if (values.length === 0) return '';
  let series = values;
  if (width && width < values.length) {
    const stride = values.length / width;
    series = Array.from({ length: width }, (_, i) =>
      values[Math.min(values.length - 1, Math.floor(i * stride))],
    );
  }
  const max = Math.max(...series, 0);
  if (max === 0) return SPARK_CHARS[0].repeat(series.length);
  return series
    .map((v) => {
      const idx = Math.max(
        0,
        Math.min(SPARK_CHARS.length - 1, Math.round((v / max) * (SPARK_CHARS.length - 1))),
      );
      return SPARK_CHARS[idx];
    })
    .join('');
}

export function bar(value: number, max: number, width: number = 20): string {
  if (max <= 0) return ' '.repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return '█'.repeat(filled) + ' '.repeat(width - filled);
}
