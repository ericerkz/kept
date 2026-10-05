const allowedFaults = new Set([
  'before-mutation',
  'after-mutation-before-receipt',
  'after-receipt-before-response'
]);

let armedFault = null;

function armTestFault(name, mode = 'throw', pauseMs = 100) {
  if (process.env.KEPT_TEST_MODE !== '1') throw new Error('Test fault injection is disabled.');
  if (!allowedFaults.has(name)) throw new Error('Unknown test fault point.');
  if (!['throw', 'crash', 'pause'].includes(mode)) throw new Error('Unknown test fault mode.');
  armedFault = { name, mode, pauseMs: 25 + Math.min(2000, Math.max(0, Number(pauseMs) || 100)) };
}

async function hitTestFault(name) {
  if (process.env.KEPT_TEST_MODE !== '1' || armedFault?.name !== name) return;
  const fault = armedFault;
  armedFault = null;
  if (fault.mode === 'crash') process.exit(86);
  if (fault.mode === 'pause') return new Promise(resolve => setTimeout(resolve, fault.pauseMs));
  throw new Error(`Injected test fault at ${name}`);
}

module.exports = { armTestFault, hitTestFault };
