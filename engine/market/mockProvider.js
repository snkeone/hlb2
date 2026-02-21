let midPx = 50000;
let oi = 100000;

export function getMarket() {
  midPx += (Math.random() - 0.5) * 20;
  oi += (Math.random() - 0.5) * 200;
  return {
    midPx: Number(midPx.toFixed(2)),
    oi: Math.max(0, Math.floor(oi)),
    ts: Date.now(),
    _src: 'mock'
  };
}
