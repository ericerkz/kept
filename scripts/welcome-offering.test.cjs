const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(fs.readFileSync('src/app/components/auth/welcome/welcome.component.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
}).outputText;

async function load(platform, offering, { pluginAvailable = true, failed = false } = {}) {
  const exports = {};
  let calls = 0;
  vm.runInNewContext(source, { exports, require(name) {
    if (name === '@angular/core') return { Component: () => target => target };
    if (name === '@capacitor/core') return {
      Capacitor: { isNativePlatform: () => platform !== 'web', isPluginAvailable: () => pluginAvailable },
      registerPlugin: name => {
        assert.equal(name, 'KeptManagedHosting');
        return { getOffering: async () => { calls++; if (failed) throw new Error('Store timeout'); return offering; } };
      }
    };
    throw new Error(`Unexpected import: ${name}`);
  } });
  const component = new exports.WelcomeComponent({}, {});
  await component.ngOnInit();
  return { component, calls };
}

for (const platform of ['ios', 'android']) {
  test(`${platform}: welcome retains eligible trial days with the store's localized price`, async () => {
    const { component } = await load(platform, { available: true, price: 'CA$3.99', trialDays: 7 });
    assert.equal(component.managedHostingOffering.price, 'CA$3.99');
    assert.equal(component.managedHostingOffering.trialDays, 7);
    assert.equal(component.cloudOptionLabelledBy, 'cloud-option-title cloud-option-price cloud-option-trial');
  });

  test(`${platform}: welcome never invents eligibility or references a missing badge`, async () => {
    for (const trialDays of [undefined, null, 0, -7, 1.5, '7', Infinity]) {
      const { component } = await load(platform, { available: true, price: '$2.99', trialDays });
      assert.equal(component.managedHostingOffering.trialDays, undefined);
      assert.equal(component.cloudOptionLabelledBy, 'cloud-option-title cloud-option-price');
    }
    const { component } = await load(platform, { available: true });
    assert.equal(component.managedHostingOffering.price, undefined);
    assert.equal(component.managedHostingOffering.trialDays, undefined);
    assert.equal(component.cloudOptionLabelledBy, 'cloud-option-title');
    const eligible = await load(platform, { available: true, trialDays: 14 });
    assert.equal(eligible.component.managedHostingOffering.trialDays, 14);
    assert.equal(eligible.component.cloudOptionLabelledBy, 'cloud-option-title cloud-option-trial');
  });
}

test('browser, missing plugin, unavailable offering and store timeouts do not show an offer', async () => {
  const offering = { available: true, price: '$2.99', trialDays: 7 };
  for (const [platform, value, options] of [['web', offering, {}], ['ios', offering, { pluginAvailable: false }],
    ['android', offering, { failed: true }], ['ios', { ...offering, available: false }, {}]]) {
    const { component, calls } = await load(platform, value, options);
    assert.equal(component.managedHostingOffering, null);
    if (platform === 'web' || options.pluginAvailable === false) assert.equal(calls, 0);
  }
});
