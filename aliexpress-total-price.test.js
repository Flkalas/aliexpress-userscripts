const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, 'aliexpress-total-price.user.js'), 'utf8');

function loadScript() {
    const context = {
        document: { readyState: 'loading', addEventListener() {}, contains: () => true },
        clearTimeout() {},
        setTimeout(callback) { callback(); },
    };
    const instrumented = source.replace(/\}\)\(\);\s*$/, 'globalThis.testApi = { extractShippingCost, updatePrice };})();');
    assert.notEqual(instrumented, source);
    vm.runInNewContext(instrumented, context);
    return context.testApi;
}

function renderedPrice(shippingText, quantity = '1') {
    const { updatePrice } = loadScript();
    const price = { textContent: 'US $2.11' };
    updatePrice(price, { innerText: shippingText }, { value: quantity });
    return price.textContent;
}

test('Economy shipping on the reported item is included', () => {
    assert.equal(renderedPrice('Economy:\u00a0US $1.18\u00a0'), 'US $2.11 (총 US $3.29)');
});

test('free shipping still shows a quantity total', () => {
    assert.equal(renderedPrice('Free shipping', '2'), 'US $2.11 (총 US $4.22, 수량: 2, 개당: US $2.11)');
});

test('unknown shipping does not produce a misleading total', () => {
    assert.equal(renderedPrice('Delivery: Oct 15 - 21'), 'US $2.11');
});

test('shipping with thousands separators is parsed fully', () => {
    const { extractShippingCost } = loadScript();
    assert.equal(extractShippingCost({ innerText: 'Economy: ₩12,345' }), 12345);
});
