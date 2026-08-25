// ==UserScript==
// @name         AliExpress Tracking Number Collector
// @namespace    https://github.com/Flkalas/aliexpress-userscripts
// @version      1.7.7
// @description  Collect unique AliExpress tracking numbers via mtop.ae.ld.querydetail (sequential)
// @author       Mark Ha
// @match        https://www.aliexpress.com/p/order/index.html*
// @match        https://*.aliexpress.com/p/order/index.html*
// @match        https://www.aliexpress.us/p/order/index.html*
// @exclude      https://www.aliexpress.com/p/order/detail.html*
// @exclude      https://*.aliexpress.com/p/order/detail.html*
// @exclude      https://www.aliexpress.us/p/order/detail.html*
// @updateURL    https://raw.githubusercontent.com/Flkalas/aliexpress-userscripts/master/aliexpress-tracking-collector.user.js
// @downloadURL  https://raw.githubusercontent.com/Flkalas/aliexpress-userscripts/master/aliexpress-tracking-collector.user.js
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // Order detail pages must not run this collector (list-only).
  if (/\/p\/order\/detail\.html/i.test(location.pathname)) return;

  const TRACK_RE =
    /Tracking\s*number\s*[:：]\s*([A-Z0-9][A-Z0-9-]{5,})/gi;
  const JSON_TRACK_RE = /"trackingNumber"\s*:\s*"([^"]+)"/g;
  const PANEL_ID = "ae-tracking-collector-panel";
  const STORAGE_KEY = "ae-tracking-collector-data-v1";

  /** Page window (Tampermonkey sandbox cannot see page `lib.mtop` on plain window). */
  function pageWindow() {
    return typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  }

  /**
   * trackingNumber -> { orderId: { product, totalUsd } }
   * @type {Map<string, Record<string, { product: string, totalUsd: number|null }>>}
   */
  const numbers = new Map();

  /** Set true to cancel in-flight Collect loops. */
  let abortFlag = false;
  let jobRunning = false;
  let saveTimer = null;

  function requestStop() {
    abortFlag = true;
    setStatus("Stopping…");
  }

  function checkAbort() {
    if (abortFlag) {
      const err = new Error("ABORTED");
      err.aborted = true;
      throw err;
    }
  }

  function isAbortError(err) {
    return !!(err && (err.aborted || err.message === "ABORTED"));
  }

  function isDigitsOnlyTracking(num) {
    return /^\d{6,}$/.test(String(num || "").trim());
  }

  /** True if this orderId already exists under any stored tracking. */
  function isOrderInStorage(orderId) {
    const id = String(orderId || "");
    if (!id) return false;
    for (const orders of numbers.values()) {
      if (id in orders) return true;
    }
    return false;
  }

  function findOrderMetaInStorage(orderId) {
    const id = String(orderId || "");
    for (const orders of numbers.values()) {
      if (id in orders) return normalizeOrderEntry(orders[id]);
    }
    return { product: "", totalUsd: null };
  }

  /** OrderIds that currently sit under CNG/AP/N/… (non digits-only) trackings. */
  function listOrderIdsUnderPrefixedTrackings() {
    /** @type {Map<string, true>} */
    const ids = new Map();
    for (const [track, orders] of numbers.entries()) {
      if (isDigitsOnlyTracking(track)) continue;
      for (const orderId of Object.keys(orders)) {
        ids.set(orderId, true);
      }
    }
    return [...ids.keys()];
  }

  /** OrderIds stored with empty product title (need API backfill). */
  function listOrderIdsWithEmptyProduct() {
    /** @type {Map<string, true>} */
    const ids = new Map();
    for (const orders of numbers.values()) {
      for (const [orderId, entry] of Object.entries(orders)) {
        const { product } = normalizeOrderEntry(entry);
        if (!product) ids.set(orderId, true);
      }
    }
    return [...ids.keys()];
  }

  function formatProductTitles(titles) {
    const uniq = [
      ...new Set(
        (titles || [])
          .map((t) => String(t || "").trim())
          .filter(Boolean)
      ),
    ];
    return uniq.length ? uniq.map((p) => p.slice(0, 80)).join(" / ") : "";
  }

  function serializeNumbers() {
    const obj = Object.create(null);
    for (const [track, orders] of numbers.entries()) {
      const row = Object.create(null);
      for (const [orderId, entry] of Object.entries(orders)) {
        row[orderId] = normalizeOrderEntry(entry);
      }
      obj[track] = row;
    }
    return obj;
  }

  function loadFromStorage() {
    try {
      let raw = "";
      if (typeof GM_getValue === "function") {
        raw = GM_getValue(STORAGE_KEY, "") || "";
      }
      if (!raw) {
        try {
          raw = localStorage.getItem(STORAGE_KEY) || "";
        } catch (_) {}
      }
      if (!raw) return 0;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return 0;
      numbers.clear();
      let n = 0;
      for (const [track, orders] of Object.entries(obj)) {
        const key = String(track).trim().toUpperCase();
        if (!key) continue;
        const row = Object.create(null);
        for (const [orderId, entry] of Object.entries(orders || {})) {
          row[String(orderId)] = normalizeOrderEntry(entry);
        }
        numbers.set(key, row);
        n += 1;
      }
      return n;
    } catch (_) {
      return 0;
    }
  }

  function saveToStorageNow() {
    try {
      const json = JSON.stringify(serializeNumbers());
      if (typeof GM_setValue === "function") {
        GM_setValue(STORAGE_KEY, json);
      }
      try {
        localStorage.setItem(STORAGE_KEY, json);
      } catch (_) {}
    } catch (_) {}
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveToStorageNow();
    }, 200);
  }

  function clearStorage() {
    numbers.clear();
    try {
      if (typeof GM_deleteValue === "function") GM_deleteValue(STORAGE_KEY);
    } catch (_) {}
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  /** Drop orderIds not present in current Processed list; remove empty trackings. */
  function pruneOrdersNotInProcessed(liveOrderIds) {
    const live = new Set((liveOrderIds || []).map(String));
    let removedOrders = 0;
    let removedTracks = 0;
    for (const [track, orders] of [...numbers.entries()]) {
      for (const orderId of Object.keys(orders)) {
        if (!live.has(orderId)) {
          delete orders[orderId];
          removedOrders += 1;
        }
      }
      if (!Object.keys(orders).length) {
        numbers.delete(track);
        removedTracks += 1;
      }
    }
    return { removedOrders, removedTracks };
  }

  /**
   * Apply API mailNos for one order: move/merge off stale trackings
   * (e.g. digits-only → CNG…).
   */
  function applyMailsForOrder(orderId, mails, meta = {}) {
    const id = String(orderId || "").trim();
    if (!id) return 0;
    const mailSet = [
      ...new Set(
        (mails || [])
          .map((m) => String(m || "").trim().toUpperCase())
          .filter((m) => m && m.length >= 6)
      ),
    ];
    if (!mailSet.length) return 0;

    // Keep best known product/price from existing entries + meta
    let product = meta.product ? String(meta.product).trim() : "";
    let totalUsd =
      typeof meta.totalUsd === "number" && Number.isFinite(meta.totalUsd)
        ? meta.totalUsd
        : null;
    for (const [, orders] of numbers.entries()) {
      if (!(id in orders)) continue;
      const prev = normalizeOrderEntry(orders[id]);
      if (prev.product && prev.product.length > product.length) {
        product = prev.product;
      }
      if (totalUsd == null && prev.totalUsd != null) totalUsd = prev.totalUsd;
    }

    // Remove this order from trackings not in the new mail set
    for (const [track, orders] of [...numbers.entries()]) {
      if (id in orders && !mailSet.includes(track)) {
        delete orders[id];
        if (!Object.keys(orders).length) numbers.delete(track);
      }
    }

    let added = 0;
    for (const mail of mailSet) {
      if (addNumber(mail, { orderId: id, product, totalUsd })) added += 1;
    }
    return added;
  }

  function findFiber(el) {
    if (!el) return null;
    const key = Object.keys(el).find(
      (k) =>
        k.startsWith("__reactFiber") ||
        k.startsWith("__reactInternalInstance")
    );
    return key ? el[key] : null;
  }

  function findReactHandlers(el) {
    if (!el) return null;
    const key = Object.keys(el).find(
      (k) =>
        k.startsWith("__reactEventHandlers") || k.startsWith("__reactProps")
    );
    return key ? el[key] : null;
  }

  function findPopoverFiber(startFiber) {
    let f = startFiber;
    for (let d = 0; f && d < 12; d += 1, f = f.return) {
      const name =
        typeof f.type === "string"
          ? f.type
          : (f.type && (f.type.displayName || f.type.name)) || "";
      const p = f.memoizedProps || {};
      if (name === "Popover" || ("content" in p && "trigger" in p)) return f;
    }
    return null;
  }

  function extractTrackingsFromValue(value) {
    const found = [];
    if (value == null) return found;
    if (typeof value === "string") {
      TRACK_RE.lastIndex = 0;
      for (const m of value.matchAll(TRACK_RE)) found.push(m[1]);
      return found;
    }
    let json = "";
    try {
      json = JSON.stringify(value);
    } catch (_) {
      return found;
    }
    // Prefer labeled tracking-number nodes from popover React tree
    for (const m of json.matchAll(
      /tracking-number-title[\s\S]{0,200}?"children"\s*:\s*"([A-Z0-9][A-Z0-9-]{5,})"/gi
    )) {
      found.push(m[1]);
    }
    if (!found.length) {
      for (const m of json.matchAll(
        /Tracking\s*number[\s\S]{0,120}?"children"\s*:\s*"([A-Z0-9][A-Z0-9-]{5,})"/gi
      )) {
        found.push(m[1]);
      }
    }
    if (!found.length) {
      JSON_TRACK_RE.lastIndex = 0;
      for (const m of json.matchAll(JSON_TRACK_RE)) found.push(m[1]);
    }
    return found;
  }

  /**
   * @param {string} raw
   * @param {{orderId?: string, product?: string, totalUsd?: number|null}} [meta]
   * @returns {boolean} true if structure changed (new track or new/updated order)
   */
  function addNumber(raw, meta = {}) {
    const num = String(raw || "")
      .trim()
      .toUpperCase();
    if (!num || num.length < 6) return false;

    const orderId = meta.orderId ? String(meta.orderId).trim() : "";
    const product = meta.product ? String(meta.product).trim() : "";
    const totalUsd =
      typeof meta.totalUsd === "number" && Number.isFinite(meta.totalUsd)
        ? meta.totalUsd
        : null;

    let orders = numbers.get(num);
    if (!orders) {
      orders = Object.create(null);
      numbers.set(num, orders);
      if (orderId) {
        orders[orderId] = { product, totalUsd };
      }
      return true;
    }

    if (!orderId) return false;

    if (!(orderId in orders)) {
      orders[orderId] = { product, totalUsd };
      return true;
    }

    const prev = normalizeOrderEntry(orders[orderId]);
    let changed = false;
    if (product && product.length > (prev.product || "").length) {
      prev.product = product;
      changed = true;
    }
    if (totalUsd != null && prev.totalUsd == null) {
      prev.totalUsd = totalUsd;
      changed = true;
    }
    orders[orderId] = prev;
    return changed;
  }

  function normalizeOrderEntry(entry) {
    if (entry && typeof entry === "object" && !Array.isArray(entry) && "product" in entry) {
      return {
        product: entry.product || "",
        totalUsd:
          typeof entry.totalUsd === "number" && Number.isFinite(entry.totalUsd)
            ? entry.totalUsd
            : null,
      };
    }
    // Legacy string product-only entries
    return { product: typeof entry === "string" ? entry : "", totalUsd: null };
  }

  function scrapeText(text, meta = {}) {
    let added = 0;
    if (!text) return added;
    TRACK_RE.lastIndex = 0;
    for (const m of text.matchAll(TRACK_RE)) {
      if (addNumber(m[1], meta)) added += 1;
    }
    JSON_TRACK_RE.lastIndex = 0;
    for (const m of text.matchAll(JSON_TRACK_RE)) {
      if (addNumber(m[1], meta)) added += 1;
    }
    return added;
  }

  function parseUsdTotal(text) {
    const s = String(text || "").replace(/\s+/g, " ");
    const m =
      s.match(/US\s*\$\s*([\d,]+(?:\.\d+)?)/i) ||
      s.match(/\$\s*([\d,]+(?:\.\d+)?)/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function formatUsd(n) {
    if (n == null || !Number.isFinite(n)) return "";
    return `US $${n.toFixed(2)}`;
  }

  function sumOrderTotals(orders) {
    let sum = 0;
    let any = false;
    for (const entry of Object.values(orders || {})) {
      const { totalUsd } = normalizeOrderEntry(entry);
      if (totalUsd != null) {
        sum += totalUsd;
        any = true;
      }
    }
    return any ? Math.round(sum * 100) / 100 : null;
  }

  function orderMeta(orderItem) {
    if (!orderItem) return {};
    const orderId =
      orderItem
        .querySelector(".order-item-header-right-info")
        ?.textContent?.match(/(\d{10,})/)?.[1] || undefined;
    let products = [
      ...orderItem.querySelectorAll(".order-item-content-info-name"),
    ]
      .map((el) => (el.textContent || "").trim())
      .filter(Boolean);
    // Fallbacks when title node class/layout differs
    if (!products.length) {
      products = [
        ...orderItem.querySelectorAll(
          "a[title], img[alt], .order-item-content-info-name span"
        ),
      ]
        .map((el) =>
          (el.getAttribute?.("title") ||
            el.getAttribute?.("alt") ||
            el.textContent ||
            "").trim()
        )
        .filter(
          (t) =>
            t.length >= 8 &&
            !/^aliexpress$/i.test(t) &&
            !/^\$/.test(t) &&
            !/^\d+$/.test(t)
        );
    }
    const product = formatProductTitles(products) || undefined;
    const totalText =
      orderItem.querySelector(".order-item-content-opt-price-total")
        ?.textContent ||
      orderItem.querySelector(".order-item-content-opt-price")?.textContent ||
      "";
    const totalUsd = parseUsdTotal(totalText);
    return { orderId, product, totalUsd };
  }

  function collectFromPopoverProps(trackEl) {
    const fiber = findFiber(trackEl);
    const popover = findPopoverFiber(fiber);
    if (!popover) return 0;
    const meta = orderMeta(trackEl.closest(".order-item"));
    if (!meta.orderId) {
      const fromHref = trackEl.href && trackEl.href.match(/tradeOrderId=(\d+)/);
      if (fromHref) meta.orderId = fromHref[1];
    }
    let added = 0;
    for (const num of extractTrackingsFromValue(popover.memoizedProps?.content)) {
      if (addNumber(num, meta)) added += 1;
    }
    return added;
  }

  function collectFromReactState(orderItem) {
    const fiber = findFiber(orderItem);
    if (!fiber) return 0;
    let added = 0;
    const meta = orderMeta(orderItem);
    let node = fiber;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.return) {
      let st = node.memoizedState;
      let i = 0;
      while (st && i < 40) {
        const v = st.memoizedState;
        if (v && typeof v === "object") {
          for (const num of extractTrackingsFromValue(v)) {
            if (addNumber(num, meta)) added += 1;
          }
        }
        st = st.next;
        i += 1;
      }
    }
    return added;
  }

  function collectFromDom() {
    let added = 0;
    listTrackLinks().forEach((el) => {
      const target = el.closest("a, button") || el;
      added += collectFromPopoverProps(target);
    });
    document
      .querySelectorAll(".order-track-popover, .order-track-popup")
      .forEach((el) => {
        const orderItem = el.closest?.(".order-item") || null;
        added += scrapeText(
          el.innerText || el.textContent || "",
          orderMeta(orderItem)
        );
      });
    document.querySelectorAll(".order-item").forEach((item) => {
      added += collectFromReactState(item);
    });
    added += scrapeText(document.body?.innerText || "");
    return added;
  }

  function sleep(ms) {
    return new Promise(async (resolve, reject) => {
      const end = Date.now() + ms;
      try {
        while (Date.now() < end) {
          checkAbort();
          const left = end - Date.now();
          await new Promise((r) => setTimeout(r, Math.min(80, Math.max(0, left))));
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  function setStatus(text) {
    const panel = document.getElementById(PANEL_ID);
    const el = panel?.querySelector("[data-status]");
    if (el) el.textContent = text || "";
  }

  function getGmtOffset() {
    const offsetMin = -new Date().getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return `GMT${sign}${hh}:${mm}`;
  }

  function getLocaleParams() {
    // aep_usuc_f example: region=KR&b_locale=en_KR&c_tp=USD...
    const raw =
      document.cookie
        .split(";")
        .map((s) => s.trim())
        .find((c) => c.startsWith("aep_usuc_f="))
        ?.slice("aep_usuc_f=".length) || "";
    const decoded = decodeURIComponent(raw);
    const locale = decoded.match(/b_locale=([^&]+)/)?.[1] || "en_KR";
    const currency = decoded.match(/c_tp=([^&]+)/)?.[1] || "USD";
    return {
      _lang: locale,
      _currency: currency,
      timeZone: getGmtOffset(),
    };
  }

  function listOrdersFromDom() {
    /** @type {Map<string, { product: string, totalUsd: number|null }>} */
    const map = new Map();
    document.querySelectorAll(".order-item").forEach((item) => {
      const { orderId, product, totalUsd } = orderMeta(item);
      if (!orderId) return;
      const prev = map.get(orderId);
      if (
        !prev ||
        (product && product.length > (prev.product || "").length) ||
        (totalUsd != null && prev.totalUsd == null)
      ) {
        map.set(orderId, {
          product: product || prev?.product || "",
          totalUsd: totalUsd != null ? totalUsd : prev?.totalUsd ?? null,
        });
      }
    });
    // Fallback: Track status hrefs
    listTrackLinks().forEach((el) => {
      const a = el.closest("a") || el;
      const id = a.href && a.href.match(/tradeOrderId=(\d+)/)?.[1];
      if (id && !map.has(id)) {
        const item = a.closest(".order-item");
        const meta = orderMeta(item);
        map.set(id, {
          product: meta.product || "",
          totalUsd: meta.totalUsd ?? null,
        });
      }
    });
    return [...map.entries()].map(([orderId, info]) => ({
      orderId,
      product: info.product,
      totalUsd: info.totalUsd,
    }));
  }

  function extractMailNosFromQueryDetail(res) {
    const lines = res?.data?.module?.trackingDetailLineList;
    const out = [];
    if (Array.isArray(lines)) {
      for (const line of lines) {
        const mail = line?.mailNo || line?.originMailNo || line?.trackingNumber;
        if (mail) out.push(String(mail));
      }
    }
    // Fallback scan
    if (!out.length) {
      try {
        out.push(...extractTrackingsFromValue(res?.data));
      } catch (_) {}
    }
    return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
  }

  /** Product titles from querydetail packageItemList[].itemTitle */
  function extractProductFromQueryDetail(res) {
    const titles = [];
    const lines = res?.data?.module?.trackingDetailLineList;
    if (Array.isArray(lines)) {
      for (const line of lines) {
        const items = line?.packageItemList;
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          const t =
            item?.itemTitle || item?.productTitle || item?.title || item?.name;
          if (t) titles.push(String(t));
        }
      }
    }
    return formatProductTitles(titles);
  }

  function getMtop() {
    const w = pageWindow();
    return w.lib && w.lib.mtop ? w.lib.mtop : null;
  }

  async function queryTrackingDetail(orderId) {
    const mtop = getMtop();
    if (!mtop || typeof mtop.request !== "function") {
      throw new Error("lib.mtop.request unavailable");
    }
    const locale = getLocaleParams();
    const data = {
      tradeOrderId: String(orderId),
      tradeOrderLineId: "",
      terminalType: "PC",
      needPageDisplayInfo: true,
      timeZone: locale.timeZone,
      __inline: "true",
      _lang: locale._lang,
      _currency: locale._currency,
    };
    // Same API as Track status hover: mtop.ae.ld.querydetail
    // See: https://acs.aliexpress.com/h5/mtop.ae.ld.querydetail/1.0/
    return mtop.request({
      api: "mtop.ae.ld.querydetail",
      v: "1.0",
      data,
      type: "GET",
      dataType: "jsonp",
      timeout: 15000,
    });
  }

  const API_GAP_MS = 320;
  const API_RETRY_GAP_MS = 900;

  async function fetchMailsForOrder(orderId) {
    const res = await queryTrackingDetail(orderId);
    checkAbort();
    const ret = Array.isArray(res?.ret) ? res.ret.join(" ") : "";
    if (/SESSION_EXPIRED|FAIL_SYS|RGV587|FAIL_SYS_USER/i.test(ret)) {
      throw new Error(ret || "API fail");
    }
    return {
      mails: extractMailNosFromQueryDetail(res),
      product: extractProductFromQueryDetail(res),
    };
  }

  async function collectViaApi(orderList) {
    const orders = orderList || listOrdersFromDom();
    if (!orders.length) {
      setStatus("No orders found on page");
      return 0;
    }
    if (!getMtop()) {
      setStatus("mtop client missing");
      return 0;
    }

    let added = 0;
    let fail = 0;
    for (let i = 0; i < orders.length; i += 1) {
      checkAbort();
      const { orderId, product, totalUsd } = orders[i];
      setStatus(`API ${i + 1}/${orders.length} · order ${orderId}`);
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt += 1) {
        checkAbort();
        try {
          const { mails, product: apiProduct } = await fetchMailsForOrder(
            orderId
          );
          const bestProduct =
            (product && product.length >= (apiProduct || "").length
              ? product
              : apiProduct) ||
            product ||
            apiProduct ||
            "";
          added += applyMailsForOrder(orderId, mails, {
            product: bestProduct,
            totalUsd,
          });
          ok = true;
        } catch (err) {
          if (isAbortError(err)) throw err;
          if (attempt === 0) await sleep(API_RETRY_GAP_MS);
          else fail += 1;
        }
      }
      scheduleSave();
      render();
      if (i < orders.length - 1) await sleep(API_GAP_MS);
    }

    setStatus(
      `API done · ${numbers.size} unique · ${orders.length - fail}/${orders.length} ok`
    );
    return added;
  }

  /**
   * Re-query orders under prefixed trackings (CNG/AP/LP/N/…)
   * and any orders still missing a product title.
   * Digits-only trackings are left alone unless product is empty.
   */
  async function refreshPrefixedTrackings(liveOrderMetaById) {
    /** @type {Map<string, { product: string, totalUsd: number|null }>} */
    const metaMap = liveOrderMetaById || new Map();
    const idSet = new Map();
    for (const id of listOrderIdsUnderPrefixedTrackings()) idSet.set(id, true);
    for (const id of listOrderIdsWithEmptyProduct()) idSet.set(id, true);
    const list = [...idSet.keys()];
    if (!list.length) return { updated: 0, productsFilled: 0 };
    if (!getMtop()) return { updated: 0, productsFilled: 0 };

    let updated = 0;
    let productsFilled = 0;
    for (let i = 0; i < list.length; i += 1) {
      checkAbort();
      const orderId = list[i];
      const fromPage = metaMap.get(orderId);
      const fromStore = findOrderMetaInStorage(orderId);
      const beforeProduct = fromStore.product || "";
      let product = fromPage?.product || beforeProduct || "";
      const totalUsd =
        fromPage?.totalUsd != null ? fromPage.totalUsd : fromStore.totalUsd;

      setStatus(`Refresh ${i + 1}/${list.length} · ${orderId}`);
      try {
        const beforeMails = [];
        for (const [track, orders] of numbers.entries()) {
          if (orderId in orders) beforeMails.push(track);
        }
        beforeMails.sort();
        const { mails, product: apiProduct } = await fetchMailsForOrder(
          orderId
        );
        if (
          apiProduct &&
          (!product || apiProduct.length > product.length)
        ) {
          product = apiProduct;
        }
        applyMailsForOrder(orderId, mails, { product, totalUsd });
        const afterMails = [];
        for (const [track, orders] of numbers.entries()) {
          if (orderId in orders) afterMails.push(track);
        }
        afterMails.sort();
        if (beforeMails.join("|") !== afterMails.join("|")) updated += 1;
        const afterProduct = findOrderMetaInStorage(orderId).product || "";
        if (!beforeProduct && afterProduct) productsFilled += 1;
      } catch (err) {
        if (isAbortError(err)) throw err;
      }
      scheduleSave();
      render();
      if (i < list.length - 1) await sleep(API_GAP_MS);
    }
    return { updated, productsFilled };
  }

  async function collectAllFast() {
    const liveOrders = listOrdersFromDom();
    const liveIds = liveOrders.map((o) => o.orderId);
    const liveMeta = new Map(
      liveOrders.map((o) => [
        o.orderId,
        { product: o.product || "", totalUsd: o.totalUsd ?? null },
      ])
    );

    setStatus("Pruning orders left Processed…");
    const pruned = pruneOrdersNotInProcessed(liveIds);
    scheduleSave();
    render();

    // Only fetch trackings for Processed orders not yet in storage
    const newOrders = liveOrders.filter((o) => !isOrderInStorage(o.orderId));
    if (newOrders.length) {
      setStatus(`New orders API · ${newOrders.length}`);
      await collectViaApi(newOrders);
    } else {
      setStatus("No new Processed orders");
    }

    // Re-query CNG/AP/N/… + fill missing product titles from API
    const refreshed = await refreshPrefixedTrackings(liveMeta);

    saveToStorageNow();
    render();
    setStatus(
      `Collected ${numbers.size} unique` +
        (newOrders.length ? ` · new ${newOrders.length}` : "") +
        (pruned.removedOrders
          ? ` · pruned ${pruned.removedOrders} orders`
          : "") +
        (refreshed.updated ? ` · refreshed ${refreshed.updated} prefixed` : "") +
        (refreshed.productsFilled
          ? ` · filled ${refreshed.productsFilled} titles`
          : "")
    );
  }

  function findViewOrdersButton() {
    return (
      [...document.querySelectorAll("button, a")].find((el) => {
        if (!el.offsetParent && !el.getClientRects().length) return false;
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        return /^view orders\b/i.test(text);
      }) || null
    );
  }

  function listOrderTabs() {
    return [...document.querySelectorAll(".order-nav .comet-tabs-nav-item, .comet-tabs-nav-item")];
  }

  function findTab(labelRe) {
    return (
      listOrderTabs().find((el) => {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        return labelRe.test(text);
      }) || null
    );
  }

  function getActiveTabText() {
    const active = listOrderTabs().find((el) =>
      /comet-tabs-nav-item-active/.test(el.className || "")
    );
    return active
      ? (active.textContent || "").replace(/\s+/g, " ").trim()
      : "";
  }

  function isProcessedTabActive() {
    return /^processed\b/i.test(getActiveTabText());
  }

  function isViewAllTabActive() {
    return /^view all\b/i.test(getActiveTabText());
  }

  function makeMouseEvent(type, bubbles = true) {
    // Tampermonkey sandbox `window` is not a real Window for UIEventInit.view
    try {
      return new MouseEvent(type, { bubbles, cancelable: true });
    } catch (_) {
      try {
        const evt = document.createEvent("MouseEvents");
        evt.initEvent(type, bubbles, true);
        return evt;
      } catch (__) {
        return null;
      }
    }
  }

  function clickTabElement(tab) {
    if (!tab) return false;
    // Prefer React handler (AliExpress tabs listen via React)
    const handlerKey = Object.keys(tab).find(
      (k) =>
        k.startsWith("__reactEventHandlers") || k.startsWith("__reactProps")
    );
    const handlers = handlerKey ? tab[handlerKey] : null;
    if (handlers && typeof handlers.onClick === "function") {
      try {
        handlers.onClick({
          type: "click",
          target: tab,
          currentTarget: tab,
          preventDefault() {},
          stopPropagation() {},
          persist() {},
          nativeEvent: makeMouseEvent("click") || { type: "click" },
        });
      } catch (_) {
        /* fall through */
      }
    }
    const evt = makeMouseEvent("click");
    if (evt) {
      try {
        tab.dispatchEvent(evt);
      } catch (_) {
        /* ignore */
      }
    }
    try {
      tab.click();
    } catch (_) {
      /* ignore */
    }
    return true;
  }

  async function waitForOrderTabs(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      checkAbort();
      if (findTab(/^processed\b/i) || findTab(/^view all\b/i)) return true;
      await sleep(200);
    }
    return false;
  }

  /** Switch to Processed so Completed / View-all history are not loaded. */
  async function switchToProcessedTab() {
    setStatus("Waiting for order tabs…");
    if (!(await waitForOrderTabs())) {
      setStatus("Order tabs not found");
      return false;
    }

    if (isProcessedTabActive()) {
      setStatus("Already on Processed");
      return true;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      checkAbort();
      const tab = findTab(/^processed\b/i);
      if (!tab) {
        setStatus("Processed tab not found");
        await sleep(300);
        continue;
      }

      setStatus(`Switching to Processed… (try ${attempt + 1})`);
      clickTabElement(tab);

      for (let i = 0; i < 25; i += 1) {
        checkAbort();
        await sleep(160);
        if (isProcessedTabActive()) {
          await sleep(350);
          setStatus(`Processed · ${orderItemCount()} orders`);
          return true;
        }
      }
    }

    setStatus(
      `Failed to switch to Processed (active: ${getActiveTabText() || "none"})`
    );
    return false;
  }

  function orderItemCount() {
    return document.querySelectorAll(".order-item").length;
  }

  /**
   * Click "View orders" only while on Processed.
   * Never expand View all (infinite history).
   */
  async function expandAllOrders() {
    if (!isProcessedTabActive()) {
      setStatus(
        `Skip expand — not on Processed (active: ${getActiveTabText() || "none"})`
      );
      return 0;
    }

    let rounds = 0;
    const maxRounds = 8; // Processed list is finite; avoid runaway clicks
    let stableMisses = 0;

    while (rounds < maxRounds) {
      checkAbort();
      if (!isProcessedTabActive() || isViewAllTabActive()) {
        setStatus("Abort expand — left Processed tab");
        return rounds;
      }

      const btn = findViewOrdersButton();
      if (!btn) {
        setStatus(
          rounds
            ? `Loaded ${orderItemCount()} Processed orders`
            : `Processed · ${orderItemCount()} orders`
        );
        return rounds;
      }

      const before = orderItemCount();
      setStatus(`Loading Processed orders… (${before})`);
      btn.scrollIntoView({ block: "center", behavior: "instant" });
      btn.click();
      rounds += 1;

      let grew = false;
      for (let i = 0; i < 20; i += 1) {
        checkAbort();
        await sleep(200);
        if (!isProcessedTabActive()) {
          setStatus("Abort expand — left Processed tab");
          return rounds;
        }
        if (orderItemCount() > before) {
          grew = true;
          stableMisses = 0;
          break;
        }
        if (!findViewOrdersButton()) {
          setStatus(`Loaded ${orderItemCount()} Processed orders`);
          return rounds;
        }
      }

      if (!grew) {
        stableMisses += 1;
        if (stableMisses >= 2) {
          setStatus(`Loaded ${orderItemCount()} Processed orders`);
          break;
        }
      }
    }

    return rounds;
  }

  async function prepareOrderList() {
    const ok = await switchToProcessedTab();
    if (!ok) {
      setStatus("Stopped: must be on Processed before loading orders");
      return false;
    }
    await expandAllOrders();
    if (!isProcessedTabActive()) {
      setStatus("Stopped: no longer on Processed");
      return false;
    }
    return true;
  }

  function listTrackLinks() {
    return [...document.querySelectorAll("a, button, span")].filter((el) =>
      /^track status$/i.test((el.textContent || "").trim())
    );
  }

  async function runJob(fn) {
    if (jobRunning) {
      abortFlag = true;
      // Wait for previous job to unwind; force-unlock if stuck
      for (let i = 0; i < 30 && jobRunning; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
      jobRunning = false;
    }
    abortFlag = false;
    jobRunning = true;
    try {
      await fn();
    } catch (err) {
      if (isAbortError(err)) {
        setStatus(`Stopped · ${numbers.size} unique so far`);
        return;
      }
      setStatus(`Error: ${err && err.message ? err.message : String(err)}`);
    } finally {
      jobRunning = false;
      abortFlag = false;
    }
  }

  async function collectAll() {
    await runJob(async () => {
      const ready = await prepareOrderList();
      if (!ready) return;
      await collectAllFast();
      setStatus(`Done · ${numbers.size} unique`);
    });
  }

  function copyText(text) {
    if (typeof GM_setClipboard === "function") {
      GM_setClipboard(text);
      return Promise.resolve();
    }
    return navigator.clipboard.writeText(text);
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <style>
        #${PANEL_ID} {
          --ae-red: #e43225;
          --ae-orange: #ff6a00;
          --ae-text: #222222;
          --ae-muted: #757575;
          --ae-border: #e8e8e8;
          --ae-bg: #ffffff;
          --ae-surface: #fafafa;
          --ae-shadow: 0 8px 28px rgba(228, 50, 37, 0.22);
          position: fixed;
          top: 72px;
          right: 16px;
          z-index: 2147483646;
          width: 340px;
          max-height: min(70vh, 560px);
          display: flex;
          flex-direction: column;
          background: var(--ae-bg);
          color: var(--ae-text);
          border: 1px solid var(--ae-border);
          border-radius: 12px;
          box-shadow: var(--ae-shadow);
          font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
          overflow: hidden;
        }
        #${PANEL_ID} .ae-tc-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 12px;
          background: var(--ae-red);
          color: #fff;
          border-bottom: none;
          cursor: move;
          user-select: none;
        }
        #${PANEL_ID} .ae-tc-title { font-weight: 700; font-size: 13px; }
        #${PANEL_ID} .ae-tc-count {
          color: rgba(255, 255, 255, 0.85);
          font-size: 12px;
        }
        #${PANEL_ID} .ae-tc-status {
          color: #ffe0b2;
          font-size: 11px;
          min-height: 1.2em;
          margin-top: 2px;
        }
        #${PANEL_ID} .ae-tc-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          padding: 8px 10px;
          border-bottom: 1px solid var(--ae-border);
          background: var(--ae-surface);
        }
        #${PANEL_ID} button {
          appearance: none;
          border: 1px solid var(--ae-red);
          background: var(--ae-red);
          color: #fff;
          border-radius: 16px;
          padding: 5px 10px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.1s ease, border-color 0.1s ease;
        }
        #${PANEL_ID} button:hover {
          background: var(--ae-orange);
          border-color: var(--ae-orange);
        }
        #${PANEL_ID} button[data-act="toggle"] {
          background: rgba(255, 255, 255, 0.18);
          border-color: rgba(255, 255, 255, 0.45);
          border-radius: 12px;
          min-width: 28px;
          padding: 2px 8px;
        }
        #${PANEL_ID} button[data-act="toggle"]:hover {
          background: rgba(255, 255, 255, 0.3);
          border-color: #fff;
        }
        #${PANEL_ID} button[data-act="stop"],
        #${PANEL_ID} button[data-act="clear"] {
          background: var(--ae-bg);
          color: var(--ae-red);
        }
        #${PANEL_ID} button[data-act="stop"]:hover,
        #${PANEL_ID} button[data-act="clear"]:hover {
          background: #fff5f2;
          border-color: var(--ae-orange);
          color: var(--ae-orange);
        }
        #${PANEL_ID} .ae-tc-list {
          overflow: auto;
          padding: 8px 10px 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          background: var(--ae-bg);
        }
        #${PANEL_ID} .ae-tc-item {
          background: var(--ae-surface);
          border: 1px solid var(--ae-border);
          border-radius: 10px;
          padding: 8px;
        }
        #${PANEL_ID} .ae-tc-num {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 13px;
          font-weight: 600;
          color: var(--ae-text);
          word-break: break-all;
        }
        #${PANEL_ID} .ae-tc-meta {
          margin-top: 6px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        #${PANEL_ID} .ae-tc-order {
          color: var(--ae-muted);
          font-size: 11px;
          line-height: 1.35;
          border-left: 2px solid var(--ae-orange);
          padding-left: 8px;
        }
        #${PANEL_ID} .ae-tc-order-id {
          color: var(--ae-red);
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        #${PANEL_ID} .ae-tc-order-product {
          color: var(--ae-muted);
        }
        #${PANEL_ID} .ae-tc-sum {
          margin-top: 2px;
          color: var(--ae-orange);
          font-size: 12px;
          font-weight: 600;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        #${PANEL_ID} .ae-tc-order-total {
          color: var(--ae-orange);
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        #${PANEL_ID} .ae-tc-row {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          align-items: flex-start;
        }
        #${PANEL_ID} .ae-tc-empty {
          color: var(--ae-muted);
          padding: 16px 8px;
          text-align: center;
        }
        #${PANEL_ID}.ae-tc-collapsed .ae-tc-actions,
        #${PANEL_ID}.ae-tc-collapsed .ae-tc-list { display: none; }
      </style>
      <div class="ae-tc-head">
        <div>
          <div class="ae-tc-title">Tracking numbers</div>
          <div class="ae-tc-count"><span data-count>0</span> unique</div>
          <div class="ae-tc-status" data-status></div>
        </div>
        <button type="button" data-act="toggle" title="Collapse">−</button>
      </div>
      <div class="ae-tc-actions">
        <button type="button" data-act="collect">Collect</button>
        <button type="button" data-act="stop">Stop</button>
        <button type="button" data-act="copy">Copy MD</button>
        <button type="button" data-act="copy-nums">Copy #s</button>
        <button type="button" data-act="cainiao">Cainiao</button>
        <button type="button" data-act="clear">Clear</button>
      </div>
      <div class="ae-tc-list" data-list></div>
    `;
    document.documentElement.appendChild(panel);

    panel.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const act = btn.getAttribute("data-act");
      if (act === "collect") {
        btn.disabled = true;
        btn.textContent = "Working…";
        try {
          await collectAll();
        } finally {
          btn.disabled = false;
          btn.textContent = "Collect";
        }
      } else if (act === "stop") {
        requestStop();
      } else if (act === "copy") {
        const text = formatCopyMarkdown();
        await copyText(text);
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = "Copy MD"), 900);
      } else if (act === "copy-nums") {
        const text = formatCopyNumbersOnly();
        await copyText(text);
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = "Copy #s"), 900);
      } else if (act === "cainiao") {
        const ok = openCainiaoTracking();
        btn.textContent = ok ? "Opened" : "Empty";
        setTimeout(() => (btn.textContent = "Cainiao"), 900);
      } else if (act === "clear") {
        clearStorage();
        render();
        setStatus("Cleared storage");
      } else if (act === "toggle") {
        panel.classList.toggle("ae-tc-collapsed");
        btn.textContent = panel.classList.contains("ae-tc-collapsed") ? "+" : "−";
      } else if (act === "copy-one") {
        const num = btn.getAttribute("data-num");
        if (num) {
          await copyText(num);
          btn.textContent = "OK";
          setTimeout(() => (btn.textContent = "Copy"), 700);
        }
      }
    });

    // drag
    const head = panel.querySelector(".ae-tc-head");
    let dragging = false;
    let ox = 0;
    let oy = 0;
    head.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = `${Math.max(0, e.clientX - ox)}px`;
      panel.style.top = `${Math.max(0, e.clientY - oy)}px`;
      panel.style.right = "auto";
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });

    return panel;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function orderEntries(orders) {
    return Object.keys(orders)
      .sort()
      .map((orderId) => [orderId, normalizeOrderEntry(orders[orderId])]);
  }

  function formatCopyMarkdown() {
    return [...numbers.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([num, orders]) => {
        const rows = orderEntries(orders);
        const sum = sumOrderTotals(orders);
        const sumLine = sum != null ? `**Total:** ${formatUsd(sum)}` : "";
        const body = rows.length
          ? rows
              .map(([orderId, info]) => {
                const price =
                  info.totalUsd != null ? ` · ${formatUsd(info.totalUsd)}` : "";
                return `- \`${orderId}\`: ${info.product || "(no title)"}${price}`;
              })
              .join("\n")
          : "- _(no order info)_";
        return sumLine
          ? `### \`${num}\`\n\n${sumLine}\n\n${body}`
          : `### \`${num}\`\n\n${body}`;
      })
      .join("\n\n");
  }

  function formatCopyNumbersOnly() {
    return [...numbers.keys()].sort((a, b) => a.localeCompare(b)).join("\n");
  }

  /** Build Cainiao multi-track URL (mailNoList is comma-joined, double-encoded). */
  function buildCainiaoUrl() {
    const list = [...numbers.keys()]
      .map((n) => String(n).trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    if (!list.length) return "";
    // Matches global.cainiao.com usage: encodeURIComponent twice so "," → %252C
    const mailNoList = encodeURIComponent(encodeURIComponent(list.join(",")));
    return `https://global.cainiao.com/newDetail.htm?mailNoList=${mailNoList}&otherMailNoList=`;
  }

  function openCainiaoTracking() {
    const url = buildCainiaoUrl();
    if (!url) {
      setStatus("No tracking numbers to open");
      return false;
    }
    const w = pageWindow();
    w.open(url, "_blank", "noopener,noreferrer");
    setStatus(`Opened Cainiao · ${numbers.size} numbers`);
    return true;
  }

  function render() {
    const panel = ensurePanel();
    const list = panel.querySelector("[data-list]");
    const count = panel.querySelector("[data-count]");
    const entries = [...numbers.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    count.textContent = String(entries.length);

    if (!entries.length) {
      list.innerHTML =
        '<div class="ae-tc-empty">No tracking numbers yet.<br>Click Collect.</div>';
      return;
    }

    list.innerHTML = entries
      .map(([num, orders]) => {
        const rows = orderEntries(orders);
        const sum = sumOrderTotals(orders);
        const sumHtml =
          sum != null
            ? `<div class="ae-tc-sum">Σ ${escapeHtml(formatUsd(sum))}</div>`
            : "";
        const metaHtml = rows.length
          ? `<div class="ae-tc-meta">${rows
              .map(([orderId, info]) => {
                const price =
                  info.totalUsd != null
                    ? ` <span class="ae-tc-order-total">(${escapeHtml(
                        formatUsd(info.totalUsd)
                      )})</span>`
                    : "";
                return `
              <div class="ae-tc-order">
                <span class="ae-tc-order-id">${escapeHtml(orderId)}</span>:
                <span class="ae-tc-order-product">${escapeHtml(
                  info.product || "(no title)"
                )}</span>${price}
              </div>`;
              })
              .join("")}</div>`
          : `<div class="ae-tc-meta"><div class="ae-tc-order">주문 정보 없음</div></div>`;

        return `
          <div class="ae-tc-item">
            <div class="ae-tc-row">
              <div>
                <div class="ae-tc-num">${escapeHtml(num)}</div>
                ${sumHtml}
              </div>
              <button type="button" data-act="copy-one" data-num="${escapeHtml(
                num
              )}">Copy</button>
            </div>
            ${metaHtml}
          </div>`;
      })
      .join("");
  }

  // (DOM/hover observers removed — collection is mtop API only on button click)

  function boot() {
    const loaded = loadFromStorage();
    ensurePanel();
    render();
    // Do NOT auto-collect — Collect uses mtop API only on click
    setStatus(
      loaded
        ? `Restored ${loaded} trackings · click Collect`
        : "Idle · click Collect"
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
