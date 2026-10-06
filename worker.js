// Web Worker für die Monte-Carlo-Simulation, damit die Oberfläche flüssig bleibt.
import { monteCarlo } from './calc.js';

self.onmessage = (ev) => {
  const { id, input, rates } = ev.data;
  try {
    let last = 0;
    const result = monteCarlo(input, {
      rates,
      onProgress: (p) => {
        if (p - last >= 0.1 || p === 1) { last = p; self.postMessage({ id, progress: p }); }
      },
    });
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
