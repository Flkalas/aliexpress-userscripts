// ==UserScript==
// @name         Aliexpress 배송비 포함 가격 표시기 (Optimized)
// @namespace    https://github.com/Flkalas/aliexpress-userscripts
// @version      1.1.0
// @description  상품 수량 변경과 배송비 변경을 감지하여 총 가격과 개당 가격을 동적으로 계산하여 표시합니다.
// @author       Mark Ha
// @match        *://*.aliexpress.com/item/*
// @updateURL    https://raw.githubusercontent.com/Flkalas/aliexpress-userscripts/master/aliexpress-total-price.user.js
// @downloadURL  https://raw.githubusercontent.com/Flkalas/aliexpress-userscripts/master/aliexpress-total-price.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    let priceObserver, quantityObserver, shippingObserver;
    let boundPriceEl, boundShippingEl, boundQtyEl;

    const debounce = (fn, delay) => {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    };

    function extractShippingCost(element) {
        const text = element.innerText || '';
        if (/free\s*shipping|무료\s*배송|무료배송/i.test(text)) {
            return 0;
        }
        const match = text.match(
            /(?:Shipping|배송비?|운송비)\s*[:：]?\s*(?:US\s*)?\$?\s*([\d]+(?:[.,]\d+)?)/i
        );
        if (!match) return 0;
        return parseFloat(match[1].replace(',', '.'));
    }

    function extractNumber(text) {
        const match = text.match(/[\d]{1,3}(?:,\d{3})*(?:\.\d+)?|[\d]+(?:\.\d+)?/);
        return match ? parseFloat(match[0].replaceAll(',', '')) : 0;
    }

    function findPriceElement() {
        return (
            document.querySelector('.product-price-value') ||
            document.querySelector('span[class*="price-kr--current--"]') ||
            document.querySelector('[class*="price-kr--current--"]:not([class*="Wrap"])') ||
            document.querySelector('[class*="product-price-current"]')
        );
    }

    function findShippingContainer() {
        return (
            document.querySelector('.dynamic-shipping-line.dynamic-shipping-titleLayout') ||
            document.querySelector('.dynamic-shipping') ||
            document.querySelector('[class*="shipping--content"]')
        );
    }

    function findQuantityElement() {
        return (
            document.querySelector('[class*="quantity--picker"] input') ||
            document.querySelector('.comet-v2-input-number input.comet-v2-input-number-input') ||
            document.querySelector('.comet-v2-input-number input')
        );
    }

    const updatePrice = debounce((priceElement, shippingContainer, quantityElement) => {
        if (!priceElement || !shippingContainer || !quantityElement) return;
        if (!document.contains(priceElement) || !document.contains(shippingContainer) || !document.contains(quantityElement)) {
            return;
        }

        const originalPrice = priceElement.textContent.split('(')[0].trim();
        const shippingText = shippingContainer.innerText || '';

        if (/free\s*shipping|무료\s*배송|무료배송/i.test(shippingText)) {
            if (priceElement.textContent.includes('(')) {
                priceElement.textContent = originalPrice;
            }
            return;
        }

        const basePrice = extractNumber(originalPrice);
        const quantity = parseInt(quantityElement.value, 10) || 1;
        const shipping = extractShippingCost(shippingContainer);
        if (!basePrice) return;

        const subtotal = basePrice * quantity;
        const total = subtotal + shipping;

        let nextText;
        if (quantity === 1) {
            nextText = `${originalPrice} (총 US $${total.toFixed(2)})`;
        } else {
            const pricePerUnit = (total / quantity).toFixed(2);
            nextText = `${originalPrice} (총 US $${total.toFixed(2)}, 수량: ${quantity}, 개당: US $${pricePerUnit})`;
        }

        if (priceElement.textContent !== nextText) {
            priceElement.textContent = nextText;
        }
    }, 300);

    function observeElements(priceElement, shippingContainer, quantityElement) {
        if (priceObserver) priceObserver.disconnect();
        priceObserver = new MutationObserver(() => {
            updatePrice(priceElement, shippingContainer, quantityElement);
        });
        priceObserver.observe(priceElement, { childList: true, characterData: true, subtree: true });

        if (shippingObserver) shippingObserver.disconnect();
        shippingObserver = new MutationObserver(() => {
            updatePrice(priceElement, shippingContainer, quantityElement);
        });
        shippingObserver.observe(shippingContainer, { childList: true, characterData: true, subtree: true });

        if (quantityObserver) quantityObserver.disconnect();
        quantityObserver = new MutationObserver(() => {
            updatePrice(priceElement, shippingContainer, quantityElement);
        });
        quantityObserver.observe(quantityElement, { attributes: true, attributeFilter: ['value'] });

        quantityElement.addEventListener('input', () => {
            updatePrice(priceElement, shippingContainer, quantityElement);
        });

        const quantityContainer = quantityElement.closest('.comet-v2-input-number, [class*="quantity--picker"]');
        if (quantityContainer && !quantityContainer.dataset.aeTotalBound) {
            quantityContainer.dataset.aeTotalBound = '1';
            quantityContainer.addEventListener('click', () => {
                setTimeout(() => {
                    updatePrice(priceElement, shippingContainer, quantityElement);
                }, 50);
            });
        }
    }

    function findAndObserveElements() {
        const priceElement = findPriceElement();
        const shippingContainer = findShippingContainer();
        const quantityElement = findQuantityElement();

        if (!(priceElement && shippingContainer && quantityElement)) {
            return false;
        }

        const rebound =
            priceElement !== boundPriceEl ||
            shippingContainer !== boundShippingEl ||
            quantityElement !== boundQtyEl;

        if (rebound) {
            boundPriceEl = priceElement;
            boundShippingEl = shippingContainer;
            boundQtyEl = quantityElement;
            observeElements(priceElement, shippingContainer, quantityElement);
        }

        updatePrice(priceElement, shippingContainer, quantityElement);
        return true;
    }

    function startObserver() {
        findAndObserveElements();
        // SPA 리렌더 / 늦은 하이드레이션 대응
        setInterval(findAndObserveElements, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObserver);
    } else {
        startObserver();
    }
})();
