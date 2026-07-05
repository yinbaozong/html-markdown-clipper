export function now() {
  return performance.now();
}

export function durationSince(startTime) {
  return performance.now() - startTime;
}

export function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function formatMs(value) {
  return `${Number(value || 0).toFixed(1)} ms`;
}
