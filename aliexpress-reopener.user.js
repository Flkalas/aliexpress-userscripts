// ==UserScript==
// @name         AliExpress Reopener
// @namespace    https://github.com/Flkalas/aliexpress-userscripts
// @version      1.0.0
// @description  AliExpress 상품 페이지에서 동일 상품을 여러 sourceType 채널로 새 탭에서 여는 플로팅 버튼을 띄웁니다.
// @author       Mark Ha
// @match        https://www.aliexpress.com/item/*
// @match        https://ko.aliexpress.com/item/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=aliexpress.com
// @updateURL    https://raw.githubusercontent.com/Flkalas/aliexpress-userscripts/master/aliexpress-reopener.user.js
// @downloadURL  https://raw.githubusercontent.com/Flkalas/aliexpress-userscripts/master/aliexpress-reopener.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // 채널 설정: label = 버튼에 표시될 이름, query = 상품 URL에 붙일 쿼리스트링
    const CHANNELS = [
        { label: '코인샵', query: '?sourceType=620&channel=coin' },
        { label: '꽁돈대첩', query: '?sourceType=561' },
        { label: '천원마트', query: '?sourceType=570' },
        { label: '기타할인', query: '?sourceType=562' },
    ];

    const CONTAINER_ID = 'aliexpress-reopener-container';
    const ITEM_ID_RE = /\/item\/(\d+)\.html/;

    // 현재 URL에서 itemId 추출 (실패 시 null)
    function getItemId() {
        const match = location.pathname.match(ITEM_ID_RE);
        return match ? match[1] : null;
    }

    // 현재 접속한 도메인(www/ko)을 유지하며 변형 URL 생성
    function buildUrl(itemId, query) {
        return `${location.origin}/item/${itemId}.html${query}`;
    }

    // 충돌 방지를 위한 스타일 1회 주입
    function injectStyle() {
        if (document.getElementById('aliexpress-reopener-style')) return;
        const style = document.createElement('style');
        style.id = 'aliexpress-reopener-style';
        style.textContent = `
            #${CONTAINER_ID} {
                position: fixed;
                right: 16px;
                bottom: 16px;
                z-index: 2147483647;
                display: flex;
                flex-direction: column;
                gap: 8px;
                font-family: system-ui, -apple-system, sans-serif;
            }
            #${CONTAINER_ID} .axr-btn {
                all: unset;
                box-sizing: border-box;
                cursor: pointer;
                padding: 10px 16px;
                min-width: 120px;
                text-align: center;
                font-size: 14px;
                font-weight: 600;
                color: #fff;
                background: #e62e04;
                border-radius: 24px;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
                transition: transform 0.1s ease, background 0.1s ease;
            }
            #${CONTAINER_ID} .axr-btn:hover {
                background: #ff4518;
                transform: translateY(-1px);
            }
            #${CONTAINER_ID} .axr-btn:active {
                transform: translateY(0);
            }
            #${CONTAINER_ID} .axr-toggle {
                all: unset;
                box-sizing: border-box;
                cursor: pointer;
                align-self: flex-end;
                padding: 4px 10px;
                font-size: 12px;
                color: #666;
                background: #fff;
                border: 1px solid #ddd;
                border-radius: 12px;
                box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
            }
            #${CONTAINER_ID}.axr-collapsed .axr-btn {
                display: none;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    // 기존 컨테이너 제거 (재렌더/비상품 페이지 전환 대비)
    function removeContainer() {
        const existing = document.getElementById(CONTAINER_ID);
        if (existing) existing.remove();
    }

    // 플로팅 버튼 UI 생성
    function buildContainer(itemId) {
        const container = document.createElement('div');
        container.id = CONTAINER_ID;

        const toggle = document.createElement('button');
        toggle.className = 'axr-toggle';
        toggle.textContent = '새탭 열기 ▾';
        toggle.addEventListener('click', () => {
            const collapsed = container.classList.toggle('axr-collapsed');
            toggle.textContent = collapsed ? '새탭 열기 ▸' : '새탭 열기 ▾';
        });
        container.appendChild(toggle);

        CHANNELS.forEach(({ label, query }) => {
            const btn = document.createElement('button');
            btn.className = 'axr-btn';
            btn.textContent = label;
            // 사용자 제스처 컨텍스트에서 직접 window.open 호출 (팝업 차단 회피)
            btn.addEventListener('click', () => {
                window.open(buildUrl(itemId, query), '_blank');
            });
            container.appendChild(btn);
        });

        document.body.appendChild(container);
    }

    // itemId 재추출 + UI 갱신
    function render() {
        removeContainer();
        const itemId = getItemId();
        if (!itemId) return; // 비상품 페이지면 UI 미표시
        injectStyle();
        buildContainer(itemId);
    }

    // SPA 라우팅 대응: URL이 실제로 바뀐 경우에만 재렌더
    let lastUrl = location.href;
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(render, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 초기 진입 시 1회 렌더
    render();
})();
