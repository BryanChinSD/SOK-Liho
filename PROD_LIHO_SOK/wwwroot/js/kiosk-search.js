import {
    ADDON_STARTING_DS_NO,
    FREE_ITEM_BY_VALUE_STARTING_DS_NO,
    FREE_ITEM_STARTING_DS_NO,
    PROMO_TYPE,
    SPECIAL_DISCOUNT_WITH_QUANTITY_ITEM_STARTING_DS_NO,
    SPECIAL_PRICE_ITEM_STARTING_DS_NO,
    TIME_FORMAT,
    ORDERS_TYPE,
    SERVICE_TYPES,
    DEFAULT_MENU_CATEGORY_COLUMNS,
    DEFAULT_MENU_ITEM_COLUMNS,
    DATE_FORMAT,
    STATUS,
    CASH_RECON_STATUS,
    TQR_ORDERS_CAPTURING_PROCESS_TYPE,
    OPEN_ITEM_PREFIX,
    ACTIVE_ORDERS_VIEW,
    WEEKDAY,
    TAKEAWAY_CHARGE_ITEM_STARTING_DS_NO,
    ADDON_2_STARTING_DS_NO,
    CRM_VENDOR,
    CRM_VOUCHER_TYPE,
    MODIFIER_STARTING_DS_NO,
    MODIFIER_2_STARTING_DS_NO
} from "../utils/constants.js";


// ─── KIOSK SEARCH ────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const CFG = {
        debounceMs: 220,
        minChars: 1,
        maxResults: 48,
        highlight: true,
        fields: [
            'item_desc',
            'item_name',
            'display_name',
            'shot_name',
            'describe_info',
            'category_code',
            'sku_no',
        ],
        placeholder: 'Search menu\u2026',
        noResultsText: 'No items found',
    };

    // ─── ORDER-TYPE CONSTANTS (derived from SERVICE_TYPES — no hard-coded letters) ──
    const SERVICE_TYPE_INFO_TO_FIELD = {
        QuickService: 'hide_item_quick_service',
        DineIn: 'hide_item_dinein',
        TakeAway: 'hide_item_takeaway',
        Delivery: 'hide_item_delivery',
    };

    const getServiceTypeByInfo = info =>
        SERVICE_TYPES?.find(s => s.service_type_info === info)?.service_type;

    const DEFAULT_SERVICE_TYPE = getServiceTypeByInfo('QuickService');
    const DELIVERY_SERVICE_TYPE = getServiceTypeByInfo('Delivery');
    const DELIVERY_CATEGORY_SUFFIX = `(${DELIVERY_SERVICE_TYPE})`;

    const HIDE_FIELD_BY_SERVICE_TYPE = (() => {
        try {
            if (Array.isArray(SERVICE_TYPES) && SERVICE_TYPES.length) {
                return Object.fromEntries(
                    SERVICE_TYPES
                        .map(({ service_type, service_type_info }) => [
                            service_type,
                            SERVICE_TYPE_INFO_TO_FIELD[service_type_info] ?? null,
                        ])
                        .filter(([, v]) => v !== null)
                );
            }
        } catch (_) { }
        return {};
    })();

    let _timer = null;
    let _lastQuery = '';
    let _active = false;

    // ─── ITEM POOL CACHE ─────────────────────────────────────────────────────
    let _allItemsCache = null;
    let _allItemsCacheTs = 0;
    let _allItemsCacheVersion = null;
    const CACHE_TTL = 5 * 60 * 1000;
    const CACHE_VERSION = 'v3';

    // ─── HELPERS ─────────────────────────────────────────────────────────────
    const isHidden = v => { const s = String(v || ''); return s === '1' || s === 'Y'; };

    const mergeHideFlag = (a, b) =>
        (isHidden(a) || isHidden(b)) ? '1' : '0';

    const getCats = section =>
        Array.isArray(section.category)
            ? section.category
            : (section.category && typeof section.category === 'object'
                ? [section.category] : []);

    // ─── BUILD HIDDEN CATEGORY SET ───────────────────────────────────────────
    function buildHiddenCategorySet(menuSections) {
        const hiddenSet = new Set();

        // Pass 1 — mark directly hidden root codes, sub-categories, and item categories
        for (const section of menuSections) {
            const rootHidden = isHidden(section.hide_from_tqr);

            if (rootHidden && section.root_category_code) {
                hiddenSet.add(section.root_category_code.trim());
            }

            for (const cat of getCats(section)) {
                if (!cat?.category_code) continue;
                if (rootHidden || isHidden(cat.hide_from_tqr)) {
                    hiddenSet.add(cat.category_code.trim());
                }
            }

            if (rootHidden) {
                for (const item of (section.items || [])) {
                    if (item?.category_code) hiddenSet.add(item.category_code.trim());
                }
            }
        }

        // Pass 2 — propagate: any section whose root_category_code is already
        // hidden should have its sub-categories and items hidden too
        for (const section of menuSections) {
            const rootCode = section.root_category_code?.trim();
            if (!rootCode || !hiddenSet.has(rootCode)) continue;

            for (const cat of getCats(section)) {
                if (cat?.category_code) hiddenSet.add(cat.category_code.trim());
            }

            for (const item of (section.items || [])) {
                if (item?.category_code) hiddenSet.add(item.category_code.trim());
            }
        }

        // Pass 3 — sub-categories of hidden root sections that became their own
        // root sections (e.g. "饮料 BEVERAGE (LARGE)" listed under hidden "ADD ON")
        for (const section of menuSections) {
            const rootCode = section.root_category_code?.trim();
            if (!rootCode || hiddenSet.has(rootCode)) continue;

            // Check if this rootCode appears as a sub-category of any hidden section
            const isSubOfHidden = menuSections.some(parent => {
                if (!hiddenSet.has(parent.root_category_code?.trim())) return false;
                return getCats(parent).some(c => c?.category_code?.trim() === rootCode);
            });

            if (isSubOfHidden) {
                hiddenSet.add(rootCode);
                for (const item of (section.items || [])) {
                    if (item?.category_code) hiddenSet.add(item.category_code.trim());
                }
            }
        }

        return hiddenSet;
    }

    // ─── BUILD CATEGORY HIDE MAP ─────────────────────────────────────────────
    function buildCategoryHideMap(menuSections) {
        const map = new Map();

        for (const section of menuSections) {
            for (const cat of getCats(section)) {
                if (!cat?.category_code) continue;
                const code = cat.category_code.trim();
                map.set(code, mergeHideFlag(map.get(code) || '0', cat.hide_from_tqr));
            }
            if (section.root_category_code) {
                const code = section.root_category_code.trim();
                map.set(code, mergeHideFlag(map.get(code) || '0', section.hide_from_tqr));
            }
        }

        return map;
    }

    // ─── BUILD ALL ITEMS ─────────────────────────────────────────────────────
    function buildAllItems() {
        const now = Date.now();
        if (
            _allItemsCache &&
            _allItemsCacheVersion === CACHE_VERSION &&
            (now - _allItemsCacheTs) < CACHE_TTL
        ) {
            return _allItemsCache;
        }

        // 1. Load menu sections
        let menuSections = [];

        try {
            const c = window.useCache?.();
            if (c?.menuItems?.length) menuSections = c.menuItems;
        } catch (_) { }

        if (!menuSections.length) {
            const api = window.apiManager?.loadedData?.get('menuItems');
            if (Array.isArray(api)) menuSections = api;
        }

        if (!menuSections.length) {
            try {
                const raw = sessionStorage.getItem('sok_menu_cache');
                if (raw) {
                    const { data } = JSON.parse(raw);
                    if (Array.isArray(data)) menuSections = data;
                }
            } catch (_) { }
        }

        // 2. Load full items
        let fullItems = [];

        try {
            const c = window.useCache?.();
            if (c?.items?.length) fullItems = c.items;
        } catch (_) { }

        if (!fullItems.length) fullItems = window.apiManager?.loadedData?.get('items') || [];

        if (!fullItems.length) {
            try {
                const raw = sessionStorage.getItem('FullItems');
                if (raw && typeof LZString !== 'undefined') {
                    const dec = LZString.decompressFromUTF16(raw);
                    if (dec) fullItems = JSON.parse(dec);
                }
            } catch (_) { }
        }

        // 3. Build hidden category set and category hide map
        const hiddenCategorySet = buildHiddenCategorySet(menuSections);
        window.__hiddenCategorySet = hiddenCategorySet;

        const categoryHideMap = buildCategoryHideMap(menuSections);

        const effectiveHide = item => {
            if (isHidden(item.hide_from_tqr)) return '1';
            const catCode = String(item.category_code || '').trim();
            if (catCode && isHidden(categoryHideMap.get(catCode))) return '1';
            return '0';
        };

        // 4. Flatten and deduplicate menu items by item_no
        const flatMap = new Map();

        for (const item of menuSections.flatMap(s => s.items || [])) {
            if (!item?.item_no) continue;
            const ex = flatMap.get(item.item_no);

            if (!ex) {
                flatMap.set(item.item_no, { ...item });
                continue;
            }

            // Merge hide flags — most restrictive wins
            ex.hide_from_tqr = mergeHideFlag(ex.hide_from_tqr, item.hide_from_tqr);
            ex.hide_item_tqr = mergeHideFlag(ex.hide_item_tqr, item.hide_item_tqr);
            ex.is_emenu_disable = mergeHideFlag(ex.is_emenu_disable, item.is_emenu_disable);
            ex.is_soldout = mergeHideFlag(ex.is_soldout, item.is_soldout);
            ex.hide_from_tqr = mergeHideFlag(ex.hide_from_tqr, effectiveHide(item));

            // Keep the richer entry (has image > has price > has description)
            const score = i =>
                (i.tqr_image_url ? 4 : 0) +
                (i.dine_in_price || i.unit_price ? 2 : 0) +
                (i.item_desc ? 1 : 0);

            if (score(item) > score(ex)) {
                flatMap.set(item.item_no, {
                    ...item,
                    hide_from_tqr: mergeHideFlag(ex.hide_from_tqr, item.hide_from_tqr),
                    hide_item_tqr: mergeHideFlag(ex.hide_item_tqr, item.hide_item_tqr),
                    is_emenu_disable: mergeHideFlag(ex.is_emenu_disable, item.is_emenu_disable),
                    is_soldout: mergeHideFlag(ex.is_soldout, item.is_soldout),
                });
            }
        }

        // Apply effective hide after dedup
        for (const [, item] of flatMap) {
            item.hide_from_tqr = mergeHideFlag(item.hide_from_tqr, effectiveHide(item));
        }

        // 5. Merge FullItems data into menu items
        const fullMap = new Map((fullItems || []).map(fi => [fi.item_no, fi]));

        const richest = (a, b) => {
            a = a || ''; b = b || '';
            const hasLatin = s => /[a-zA-Z]/.test(s);
            if (hasLatin(a) && !hasLatin(b)) return a;
            if (hasLatin(b) && !hasLatin(a)) return b;
            return a.length >= b.length ? a : b;
        };

        const richestOf = (...candidates) => {
            const vals = candidates.filter(Boolean);
            if (!vals.length) return '';
            const bilingual = vals.filter(s => /[a-zA-Z]/.test(s));
            if (bilingual.length) return bilingual.reduce((a, b) => a.length >= b.length ? a : b);
            return vals.reduce((a, b) => a.length >= b.length ? a : b);
        };

        const merged = [...flatMap.values()].map(menuItem => {
            const full = fullMap.get(menuItem.item_no);
            if (!full) return menuItem;

            return {
                ...full,
                ...Object.fromEntries(
                    Object.entries(menuItem).filter(([, v]) =>
                        v !== null && v !== undefined && v !== '' &&
                        !(Array.isArray(v) && v.length === 0)
                    )
                ),
                hide_from_tqr: mergeHideFlag(full.hide_from_tqr, menuItem.hide_from_tqr),
                hide_item_tqr: mergeHideFlag(full.hide_item_tqr, menuItem.hide_item_tqr),
                hide_item_dinein: mergeHideFlag(full.hide_item_dinein, menuItem.hide_item_dinein),
                hide_item_takeaway: mergeHideFlag(full.hide_item_takeaway, menuItem.hide_item_takeaway),
                hide_item_quick_service: mergeHideFlag(full.hide_item_quick_service, menuItem.hide_item_quick_service),
                hide_item_delivery: mergeHideFlag(full.hide_item_delivery, menuItem.hide_item_delivery),
                is_emenu_disable: mergeHideFlag(full.is_emenu_disable, menuItem.is_emenu_disable),
                is_soldout: mergeHideFlag(full.is_soldout, menuItem.is_soldout),
                itemmaster_menutype_grpdtls: full.itemmaster_menutype_grpdtls?.length
                    ? full.itemmaster_menutype_grpdtls
                    : (menuItem.itemmaster_menutype_grpdtls || []),
                itemmaster_menutypedtls: full.itemmaster_menutypedtls?.length
                    ? full.itemmaster_menutypedtls
                    : (menuItem.itemmaster_menutypedtls || []),
                selling_uom_dtls: full.selling_uom_dtls?.length
                    ? full.selling_uom_dtls
                    : (menuItem.selling_uom_dtls || []),
                tqr_image_url: menuItem.tqr_image_url || full.tqr_image_url || '',
                item_desc: richestOf(full.item_desc, menuItem.item_desc, full.item_name, menuItem.item_name, full.display_name, menuItem.display_name),
                item_name: richest(full.item_name, menuItem.item_name),
                display_name: richest(full.display_name, menuItem.display_name),
                shot_name: richest(full.shot_name, menuItem.shot_name),
                describe_info: richest(full.describe_info, menuItem.describe_info),
                sku_no: full.sku_no || menuItem.sku_no || '',
            };
        });

        // 6. Final dedup of merged list by item_no
        const seen = new Map();

        for (const item of merged) {
            if (!item?.item_no) continue;
            const ex = seen.get(item.item_no);

            if (!ex) {
                seen.set(item.item_no, item);
                continue;
            }

            const score = i =>
                (i.tqr_image_url ? 4 : 0) +
                (i.dine_in_price || i.unit_price ? 2 : 0) +
                (i.item_desc ? 1 : 0) +
                (i.itemmaster_menutype_grpdtls?.length ? 1 : 0);

            seen.set(item.item_no, {
                ...(score(item) > score(ex) ? item : ex),
                hide_from_tqr: mergeHideFlag(ex.hide_from_tqr, item.hide_from_tqr),
                hide_item_tqr: mergeHideFlag(ex.hide_item_tqr, item.hide_item_tqr),
                hide_item_dinein: mergeHideFlag(ex.hide_item_dinein, item.hide_item_dinein),
                hide_item_takeaway: mergeHideFlag(ex.hide_item_takeaway, item.hide_item_takeaway),
                hide_item_quick_service: mergeHideFlag(ex.hide_item_quick_service, item.hide_item_quick_service),
                hide_item_delivery: mergeHideFlag(ex.hide_item_delivery, item.hide_item_delivery),
                is_emenu_disable: mergeHideFlag(ex.is_emenu_disable, item.is_emenu_disable),
                is_soldout: mergeHideFlag(ex.is_soldout, item.is_soldout),
            });
        }

        _allItemsCache = [...seen.values()];
        _allItemsCacheTs = now;
        _allItemsCacheVersion = CACHE_VERSION;

        console.log(`[KioskSearch] Item pool built: ${_allItemsCache.length} items`);
        console.log(`[KioskSearch] Hidden category set (${hiddenCategorySet.size}):`, [...hiddenCategorySet]);
        return _allItemsCache;
    }

    function invalidateItemPool() {
        _allItemsCache = null;
        _allItemsCacheTs = 0;
        _allItemsCacheVersion = null;
    }

    // ─── VISIBILITY FILTER ───────────────────────────────────────────────────
    function filterVisible(items) {
        const isHiddenFlag = v => { const s = String(v || ''); return s === '1' || s === 'Y'; };

        // Detect active order type
        let activeOrderType = DEFAULT_SERVICE_TYPE;
        try {
            const stored = localStorage.getItem('orderType');
            if (stored) activeOrderType = stored.toUpperCase().trim();
        } catch (_) { }

        // Make sure the live AVL map is built before we read from it
        if (!window._itemAvlMapBuilt && typeof window.buildItemAvlMapFromLocalStorage === 'function') {
            window.buildItemAvlMapFromLocalStorage();
        }

        const resolveAvlRecord = i => {
            const itemNo = i.item_no?.trim();
            const skuNo = i.sku_no?.trim();
            return (itemNo && window.itemAvlMap?.[itemNo]) ||
                (skuNo && window.itemAvlMap?.[skuNo]) ||
                null;
        };

        // Delegate to app-level filter if available
        if (typeof window.shouldShowItem === 'function') {
            const hiddenCategorySet = window.__hiddenCategorySet || new Set();
            return items.filter(i => {
                if (!window.shouldShowItem(i)) return false;
                const catCode = (i.category_code || '').trim();
                if (catCode.endsWith(DELIVERY_CATEGORY_SUFFIX) && activeOrderType !== DELIVERY_SERVICE_TYPE) return false;
                if (catCode && hiddenCategorySet.has(catCode)) return false;
                return true;
            });
        }

        const hideField = HIDE_FIELD_BY_SERVICE_TYPE[activeOrderType] ?? null;
        const hiddenCategorySet = window.__hiddenCategorySet || new Set();

        console.log(`[KioskSearch] filterVisible — orderType: "${activeOrderType}", hideField: "${hideField}"`);
        console.log(`[KioskSearch] hiddenCategorySet (${hiddenCategorySet.size}):`, [...hiddenCategorySet]);

        return items.filter(i => {
            if (!i?.item_no) return false;
            if (isHiddenFlag(i.hide_from_tqr)) return false;

            // Resolve live stock status the same way shouldShowItem() does:
            // prefer the AVL record (real-time feed), fall back to the
            // static item field only when no AVL record exists.
            const avlRecord = resolveAvlRecord(i);

            const isDisabled = avlRecord
                ? avlRecord.is_emenu_disable === 'Y'
                : isHiddenFlag(i.is_emenu_disable);
            if (isDisabled) return false;

            const isSoldOut = avlRecord
                ? avlRecord.is_soldout === 'Y'
                : isHiddenFlag(i.is_soldout);
            if (isSoldOut) return false;

            if (hideField && isHiddenFlag(i[hideField])) return false;

            const catCode = String(i.category_code || '').trim();
            if (catCode && hiddenCategorySet.has(catCode)) return false;
            if (catCode.endsWith(DELIVERY_CATEGORY_SUFFIX) && activeOrderType !== DELIVERY_SERVICE_TYPE) return false;

            return true;
        });
    }
    // ─── SCORING ─────────────────────────────────────────────────────────────
    const norm = str => (str || '').toLowerCase().trim();

    function scoreItem(item, words) {
        let total = 0;
        for (const word of words) {
            let hit = false;
            for (let fi = 0; fi < CFG.fields.length; fi++) {
                const val = norm(item[CFG.fields[fi]]);
                if (!val || !val.includes(word)) continue;
                hit = true;
                total += (CFG.fields.length - fi) * 3;
                if (val.startsWith(word)) total += 5;
                if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(val)) total += 3;
                break;
            }
            if (!hit) return 0;
        }
        return total;
    }

    // ─── SEARCH ──────────────────────────────────────────────────────────────
    function search(raw) {
        const q = norm(raw);
        if (q.length < CFG.minChars) { exitSearch(); return; }

        const words = q.split(/\s+/).filter(Boolean);
        const pool = filterVisible(buildAllItems());

        console.log(`[KioskSearch] pool: ${pool.length} visible, query: "${q}"`);

        const results = pool
            .map(item => ({ item, s: scoreItem(item, words) }))
            .filter(r => r.s > 0)
            .sort((a, b) =>
                b.s - a.s ||
                norm(a.item.item_desc || a.item.item_name)
                    .localeCompare(norm(b.item.item_desc || b.item.item_name))
            )
            .slice(0, CFG.maxResults)
            .map(r => r.item);

        _active = true;
        renderResults(results, words);
        updateCount(results.length, raw);
    }

    function exitSearch() {
        if (!_active) return;
        _active = false;
        _lastQuery = '';
        updateCount(0, '');

        const activeTab =
            document.querySelector('.category-tab.active') ||
            document.querySelector('.category-tab');
        if (!activeTab) return;

        const code = activeTab.dataset.category;
        if (code && typeof window.renderCategoryByCode === 'function') {
            window.renderCategoryByCode(code);
        } else {
            activeTab.click();
        }
    }

    // ─── RENDER ──────────────────────────────────────────────────────────────
    const esc = s => String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function highlight(text, words) {
        if (!CFG.highlight || !text) return esc(text || '');
        let r = esc(text);
        for (const w of words) {
            r = r.replace(
                new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
                '<mark>$1</mark>'
            );
        }
        return r;
    }

    function getImg(item) {
        if (typeof window.getItemImageUrl === 'function') return window.getItemImageUrl(item);
        const raw = item.tqr_image_url || item.item_image || item.image || '';
        if (!raw) return window.RESTAURANT_CONFIG?.logo || '';
        if (raw.startsWith('public/upload/'))
            return `/api/GetImageProxy?imageUrl=${encodeURIComponent(raw)}`;
        return raw;
    }

    function getPrice(item) {
        const priceObj = item?.selling_uom_dtls?.[0]?.price_dtls?.[0] || item;
        if (typeof window.getPriceByServiceType === 'function') {
            const v = parseFloat(window.getPriceByServiceType(priceObj));
            if (!isNaN(v) && v > 0) return `$${v.toFixed(2)}`;
        }
        for (const f of ['dine_in_price', 'takeaway_price', 'unit_price', 'price']) {
            const v = parseFloat(item[f]);
            if (!isNaN(v) && v > 0) return `$${v.toFixed(2)}`;
        }
        if (window._lowestPriceCache?.has(item.item_no)) {
            const lo = window._lowestPriceCache.get(item.item_no);
            if (lo > 0) return `$${lo.toFixed(2)}`;
        }
        return '';
    }

    function renderResults(items, words) {
        const container = document.getElementById('menuGrid');
        if (!container) return;

        if (items.length === 0) {
            container.innerHTML = `
                <div style="grid-column:1/-1;display:flex;flex-direction:column;
                            align-items:center;justify-content:center;
                            padding:5rem 2rem;color:#888;">
                    <svg width="56" height="56" viewBox="0 0 24 24" fill="none"
                         stroke="#ccc" stroke-width="1.5" style="margin-bottom:16px;">
                        <circle cx="11" cy="11" r="8"/>
                        <path d="M21 21l-4.35-4.35"/>
                        <line x1="8" y1="11" x2="14" y2="11"/>
                    </svg>
                    <p style="font-size:1.1rem;margin:0;">${CFG.noResultsText}</p>
                </div>`;
            return;
        }

        window.menuGridItems = items;

        if (window.MENU_CONFIG?.RENDERING_MODE !== 'traditional' && typeof window.renderMenuGridWorkFlow === 'function') {
            window.renderMenuGridWorkFlow(items);
        } else if (typeof window.renderMenuGridTraditional === 'function') {
            window.renderMenuGridTraditional(items);
        } else {
            renderFallback(items, words, container);
        }

        if (CFG.highlight && words.length) {
            requestAnimationFrame(() => {
                container.querySelectorAll('.font-semibold, h3').forEach(el => {
                    if (el.textContent.trim()) el.innerHTML = highlight(el.textContent, words);
                });
            });
        }
    }

    function renderFallback(items, words, container) {
        const logo = window.RESTAURANT_CONFIG?.logo || '';
        const frag = document.createDocumentFragment();

        items.forEach((item, i) => {
            const img = getImg(item);
            const name = item.item_desc || item.display_name || item.item_name || '';
            const price = getPrice(item);

            const card = document.createElement('div');
            card.className = 'menu-item p-4 border rounded shadow';
            card.dataset.itemId = item.item_no;
            card.style.cursor = 'pointer';
            card.innerHTML = `
                <div class="item-image">
                    <div class="image-wrapper"
                         style="position:relative;width:100%;height:100%;
                                background:#f0f0f0;border-radius:var(--radius-md,8px);overflow:hidden;">
                        <img src="${img}" alt="${esc(name)}"
                             fetchpriority="${i < 6 ? 'high' : 'auto'}"
                             decoding="async" loading="eager"
                             style="width:100%;height:100%;object-fit:cover;display:block;"
                             onload="this.classList.add('loaded');"
                             onerror="this.onerror=null;if(this.src!=='${logo}')this.src='${logo}';">
                    </div>
                </div>
                <div class="item-info">
                    <h3 class="font-semibold">${highlight(name, words)}</h3>
                    <div class="item-footer flex justify-between items-center mt-2">
                        <span class="item-price font-bold${price ? '' : ' invisible'}">${price}</span>
                        <button class="add-btn bg-blue-500 hover:bg-blue-600 text-white
                                       px-3 py-1 rounded w-full max-w-[100px]"
                                data-item-id="${item.item_no}">Add to Cart</button>
                    </div>
                </div>`;
            frag.appendChild(card);
        });98

        container.innerHTML = '';
        container.appendChild(frag);
        container.removeEventListener('click', _fallbackClickHandler);
        container.addEventListener('click', _fallbackClickHandler);
    }

    function _fallbackClickHandler(e) {
        const id = e.target.matches('button.add-btn')
            ? e.target.getAttribute('data-item-id')
            : e.target.closest('.menu-item')?.dataset.itemId;
        if (id && typeof window.addToCart === 'function') window.addToCart(id);
    }

    function updateCount(count, query) {
        const el = document.getElementById('ks-count');
        if (!el) return;
        el.textContent = !query ? ''
            : count > 0 ? `${count} result${count !== 1 ? 's' : ''}`
                : 'No results';
    }

    // ─── UI INJECTION ────────────────────────────────────────────────────────
    function inject() {
        if (document.getElementById('ks-bar')) return true;

        const anchor = document.getElementById('ks-search-anchor');
        if (!anchor) {
            console.warn('[KioskSearch] #ks-search-anchor not found');
            return false;
        }

        const bar = document.createElement('div');
        bar.id = 'ks-bar';
        bar.setAttribute('role', 'search');
        bar.innerHTML = `
            <div id="ks-inner">
                <svg id="ks-icon" width="17" height="17" viewBox="0 0 24 24"
                     fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
                    <circle cx="11" cy="11" r="8"/>
                    <path d="M21 21l-4.35-4.35"/>
                </svg>
                <input id="ks-input" type="text" inputmode="none"
                       autocomplete="off" autocorrect="off"
                       autocapitalize="off" spellcheck="false"
                       placeholder="${CFG.placeholder}"
                       aria-label="Search menu" readonly />
                <button id="ks-clear" aria-label="Clear search" style="display:none;">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
            <span id="ks-count" aria-live="polite" aria-atomic="true"></span>`;

        anchor.appendChild(bar);
        injectStyles();
        bindEvents();
        console.log('[KioskSearch] Injected');
        return true;
    }

    function bindEvents() {
        const input = document.getElementById('ks-input');
        const clearBtn = document.getElementById('ks-clear');
        const bar = document.getElementById('ks-bar');
        if (!input) return;

        input.addEventListener('input', () => {
            const v = input.value;
            clearBtn.style.display = v.length ? 'flex' : 'none';
            clearTimeout(_timer);
            if (v.length < CFG.minChars) { if (_active) exitSearch(); return; }
            _timer = setTimeout(() => {
                if (v !== _lastQuery) { _lastQuery = v; search(v); }
            }, CFG.debounceMs);
        });

        clearBtn.addEventListener('click', () => {
            input.value = '';
            clearBtn.style.display = 'none';
            _lastQuery = '';
            exitSearch();
            input.focus();
        });

        input.addEventListener('keydown', e => {
            if (!e._fromVirtualKeyboard) { e.preventDefault(); return; }
            if (e.key === 'Escape') {
                input.value = '';
                clearBtn.style.display = 'none';
                exitSearch();
                input.blur();
            }
        });

        input.addEventListener('focus', () => bar?.classList.add('ks-focused'));
        input.addEventListener('blur', () => bar?.classList.remove('ks-focused'));
    }

    function injectStyles() {
        if (document.getElementById('ks-styles')) return;
        const s = document.createElement('style');
        s.id = 'ks-styles';
        s.textContent = `
#ks-bar { display: flex; align-items: center; gap: 8px; flex: 1; max-width: 420px; margin: 0 16px; }
#ks-inner { display: flex; align-items: center; gap: 8px; flex: 1; background: #f5f5f5; border: 1.5px solid #e0e0e0; border-radius: 999px; padding: 0 14px; height: 40px; transition: border-color .18s, box-shadow .18s, background .18s; }
#ks-bar.ks-focused #ks-inner { border-color: var(--primary, #D3281B); background: #fff; box-shadow: 0 0 0 3px rgba(211,40,27,.12); }
#ks-icon { color: #aaa; flex-shrink: 0; transition: color .18s; }
#ks-bar.ks-focused #ks-icon { color: var(--primary, #D3281B); }
#ks-input { flex: 1; border: none; background: transparent; font-size: 16px; color: #222; outline: none; box-shadow: none; padding: 0; height: 100%; min-width: 0; font-family: inherit; text-transform: uppercase; letter-spacing: 0.05em; }
#ks-input::placeholder { color: #bbb; }
#ks-clear { display: none; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; border: none; background: #ddd; color: #666; cursor: pointer; flex-shrink: 0; padding: 0; transition: background .15s; }
#ks-clear:hover { background: var(--primary, #D3281B); color: #fff; }
#ks-count { font-size: 11px; color: #999; white-space: nowrap; flex-shrink: 0; }
#menuGrid mark { background: rgba(211,40,27,.13); color: inherit; border-radius: 2px; padding: 0 1px; }
@media (max-width: 600px) {
    #ks-bar { flex: 0 0 auto; width: 110px; min-width: 0; margin: 0 3px; }
    #ks-inner { height: 28px; padding: 0 7px; gap: 4px; width: 100%; }
    #ks-input { font-size: 16px; min-width: 0; width: 0; flex: 1; transform: scale(0.75); transform-origin: left center; }
    #ks-input::placeholder { opacity: 0.6; }
    #ks-icon { width: 11px; height: 11px; flex-shrink: 0; }
    #ks-count { display: none; }
    #ks-clear { width: 15px; height: 15px; flex-shrink: 0; padding: 0; }
}`;
        document.head.appendChild(s);
    }

    function tryInject() {
        if (document.getElementById('ks-bar')) return;
        if (!inject()) {
            const obs = new MutationObserver(() => { if (inject()) obs.disconnect(); });
            obs.observe(document.body, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(tryInject, 300));
    } else {
        setTimeout(tryInject, 200);
    }

    // Invalidate pool when order type changes
    const _origSOT = window.selectOrderType;
    if (typeof _origSOT === 'function') {
        window.selectOrderType = async function (...args) {
            const result = await _origSOT.apply(this, args);
            invalidateItemPool();
            setTimeout(tryInject, 800);
            return result;
        };
    }

    window.KioskSearch = {
        inject: tryInject,
        search,
        clear: exitSearch,
        isActive: () => _active,
        invalidatePool: invalidateItemPool,
        getPool: buildAllItems,
    };

})();


// ─── VIRTUAL KEYBOARD ────────────────────────────────────────────────────────
(function () {
    'use strict';

    const LAYOUTS = {
        default: [
            ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
            ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
            ['Z', 'X', 'C', 'V', 'B', 'N', 'M', '\u232b'],
            ['123', 'space', '\u23ce'],
        ],
        numbers: [
            ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
            ['-', '/', ':', ';', '(', ')', '$', '&', '@', '"'],
            ['#+=', '.', '\u00b7', ',', '?', '!', '\'', '\u232b'],
            ['ABC', 'space', '\u23ce'],
        ],
        symbols: [
            ['[', ']', '{', '}', '#', '%', '^', '*', '+', '='],
            ['_', '\\', '|', '~', '<', '>', '\u20ac', '\u00a3', '\u00a5', '\u00b7'],
            ['123', '.', '\u00b7', ',', '?', '!', '\'', '\u232b'],
            ['ABC', 'space', '\u23ce'],
        ],
    };

    let _layout = 'default';
    let _kb = null;
    let _input = null;

    function createKeyboard() {
        if (document.getElementById('vk-board')) return;

        const overlay = document.createElement('div');
        overlay.id = 'vk-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:999998;display:none;';
        overlay.addEventListener('pointerdown', e => {
            if (_kb && !_kb.contains(e.target) && e.target !== _input) hide();
        });
        document.body.appendChild(overlay);

        const board = document.createElement('div');
        board.id = 'vk-board';
        board.setAttribute('aria-label', 'Virtual keyboard');
        board.addEventListener('mousedown', e => e.preventDefault());
        document.body.appendChild(board);

        injectStyles();
        _kb = board;
        renderLayout();
    }

    function renderLayout() {
        if (!_kb) return;
        _kb.innerHTML = '';

        for (const row of LAYOUTS[_layout]) {
            const rowEl = document.createElement('div');
            rowEl.className = 'vk-row';

            for (const key of row) {
                const btn = document.createElement('button');
                btn.className = 'vk-key';
                btn.type = 'button';
                btn.setAttribute('data-key', key);

                switch (key) {
                    case '\u232b':
                        btn.classList.add('vk-backspace');
                        btn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/></svg>`;
                        break;
                    case 'space':
                        btn.classList.add('vk-space');
                        break;
                    case '\u23ce':
                        btn.classList.add('vk-enter');
                        btn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>`;
                        break;
                    case '123': case 'ABC': case '#+=':
                        btn.classList.add('vk-fn');
                        btn.textContent = key;
                        break;
                    default:
                        btn.textContent = key;
                }

                btn.addEventListener('click', e => { e.preventDefault(); handleKey(key); });
                rowEl.appendChild(btn);
            }

            _kb.appendChild(rowEl);
        }
    }

    function handleKey(key) {
        if (!_input) return;

        const pos = _input.selectionStart;
        const val = _input.value;

        switch (key) {
            case '\u232b':
                if (pos > 0) {
                    _input.value = val.slice(0, pos - 1) + val.slice(pos);
                    _input.setSelectionRange(pos - 1, pos - 1);
                }
                break;
            case 'space':
                _input.value = val.slice(0, pos) + ' ' + val.slice(pos);
                _input.setSelectionRange(pos + 1, pos + 1);
                break;
            case '\u23ce':
                hide(); return;
            case '123':
                _layout = 'numbers'; renderLayout(); return;
            case 'ABC':
                _layout = 'default'; renderLayout(); return;
            case '#+=':
                _layout = 'symbols'; renderLayout(); return;
            default:
                _input.value = val.slice(0, pos) + key + val.slice(pos);
                _input.setSelectionRange(pos + 1, pos + 1);
        }

        _input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function show(inputEl) {
        _input = inputEl;
        createKeyboard();
        document.getElementById('vk-overlay').style.display = 'block';
        _kb.classList.add('vk-show');
    }

    function hide() {
        _kb?.classList.remove('vk-show');
        const overlay = document.getElementById('vk-overlay');
        if (overlay) overlay.style.display = 'none';
        _layout = 'default';
    }

    function injectStyles() {
        if (document.getElementById('vk-styles')) return;
        const s = document.createElement('style');
        s.id = 'vk-styles';
        s.textContent = `
#vk-board { position: fixed; bottom: 0; left: 0; width: 100vw; background: #222; padding: 12px 0; box-sizing: border-box; z-index: 999999; display: flex; flex-direction: column; gap: 8px; transform: translateY(100%); transition: transform .25s ease-out; }
#vk-board.vk-show { transform: translateY(0); }
.vk-row { display: flex; justify-content: center; width: 100%; gap: 6px; padding: 0 8px; box-sizing: border-box; }
.vk-key { flex: 1; max-width: 54px; height: 48px; background: #444; color: #fff; border: none; border-radius: 6px; font-size: 18px; font-weight: 600; display: flex; align-items: center; justify-content: center; cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent; }
.vk-key:active { background: #666; }
.vk-space { flex: 4; max-width: 280px; }
.vk-enter { background: var(--primary, #D3281B); flex: 1.5; max-width: 80px; }
.vk-backspace { background: #555; flex: 1.5; max-width: 80px; }
.vk-fn { background: #333; font-size: 14px; flex: 1.2; }`;
        document.head.appendChild(s);
    }

    document.body.addEventListener('focusin', e => {
        if (e.target?.id === 'ks-input') show(e.target);
    });

})();