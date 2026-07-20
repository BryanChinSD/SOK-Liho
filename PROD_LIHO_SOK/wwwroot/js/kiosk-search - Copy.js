// ─── KIOSK SEARCH MODULE ──────────────────────────────────────────────────────
// LiHO Tea Kiosk — header search bar
// Searches ALL items across ALL categories, not just the active one.
//
// Usage:
//   1. Copy to /js/kiosk-search.js
//   2. Add <div id="ks-search-anchor"></div> inside .header in your HTML
//      (between .landing-logo1 and .header-info)
//   3. Add at bottom of GetHomeAPI.js:
//        window.renderCategoryByCode = renderCategoryByCode;
//   4. Add in <head> after Payment.js:
//        <script type="module" src="/js/kiosk-search.js" asp-append-version="true"></script>

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
        placeholder: 'Search menu…',
        noResultsText: 'No items found',
    };

    let _timer = null;
    let _lastQuery = '';
    let _active = false;

    // ─── FULL ITEM POOL ───────────────────────────────────────────────────────
    // Cached once — ALL items from ALL categories.
    // Never reads window.menuGridItems (that only has the active category).
    let _allItemsCache = null;
    let _allItemsCacheTs = 0;
    const CACHE_TTL = 5 * 60 * 1000; // rebuild if stale > 5 min

    function buildAllItems() {
        const now = Date.now();
        if (_allItemsCache && (now - _allItemsCacheTs) < CACHE_TTL) {
            return _allItemsCache;
        }

        let menuSections = [];
        let fullItems = [];

        // 1. menuItems — all sections with category structure
        try {
            const c = window.useCache?.();
            if (c?.menuItems?.length) {
                menuSections = c.menuItems;
            }
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

        // 2. FullItems — has item_desc, shot_name, selling_uom_dtls, modifiers etc.
        try {
            const c = window.useCache?.();
            if (c?.items?.length) fullItems = c.items;
        } catch (_) { }

        if (!fullItems.length) {
            fullItems = window.apiManager?.loadedData?.get('items') || [];
        }

        if (!fullItems.length) {
            try {
                // LZ-compressed in sessionStorage
                const raw = sessionStorage.getItem('FullItems');
                if (raw && typeof LZString !== 'undefined') {
                    const dec = LZString.decompressFromUTF16(raw);
                    if (dec) fullItems = JSON.parse(dec);
                }
            } catch (_) { }
        }

        // 3. Flatten all menu items across every section
        const flat = menuSections.flatMap(s => s.items || []);

        // 4. Merge FullItems data into menu items (same pattern as _doLoadAndRenderMenu)
        const fullMap = new Map((fullItems || []).map(fi => [fi.item_no, fi]));

        const merged = flat.map(menuItem => {
            const full = fullMap.get(menuItem.item_no);
            if (!full) return menuItem;
            return {
                ...full,
                // Menu item fields take priority for display/image
                ...Object.fromEntries(
                    Object.entries(menuItem).filter(([, v]) =>
                        v !== null && v !== undefined && v !== '' &&
                        !(Array.isArray(v) && v.length === 0)
                    )
                ),
                // Always keep rich modifier/uom data from FullItems
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
                // FullItems has better text fields
                item_desc: full.item_desc || menuItem.item_desc || '',
                shot_name: full.shot_name || menuItem.shot_name || '',
                describe_info: full.describe_info || menuItem.describe_info || '',
                sku_no: full.sku_no || menuItem.sku_no || '',
            };
        });

        // 5. Deduplicate by item_no
        const seen = new Map();
        for (const item of merged) {
            if (!item?.item_no) continue;
            const ex = seen.get(item.item_no);
            if (!ex) { seen.set(item.item_no, item); continue; }
            // Keep whichever has more data
            const score = i => (i.tqr_image_url ? 2 : 0) + (i.item_desc ? 1 : 0) +
                (i.itemmaster_menutype_grpdtls?.length ? 1 : 0);
            if (score(item) > score(ex)) seen.set(item.item_no, item);
        }

        _allItemsCache = [...seen.values()];
        _allItemsCacheTs = now;

        console.log(`[KioskSearch] Item pool built: ${_allItemsCache.length} items across all categories`);
        return _allItemsCache;
    }

    // Invalidate cache when new data arrives (warm boot, post-order reload etc.)
    function invalidateItemPool() {
        _allItemsCache = null;
        _allItemsCacheTs = 0;
    }

    // ─── VISIBILITY FILTER ────────────────────────────────────────────────────

    function filterVisible(items) {
        if (typeof window.shouldShowItem === 'function') {
            return items.filter(i => window.shouldShowItem(i));
        }
        return items.filter(i =>
            i?.item_no &&
            i.hide_from_tqr !== 'Y' && i.hide_from_tqr !== '1' &&
            i.is_emenu_disable !== 'Y' && i.is_emenu_disable !== '1'
        );
    }

    // ─── SCORING ──────────────────────────────────────────────────────────────

    const norm = str => (str || '').toLowerCase().trim();

    function scoreItem(item, words) {
        let total = 0;
        for (const word of words) {
            let hit = false;
            for (let fi = 0; fi < CFG.fields.length; fi++) {
                const val = norm(item[CFG.fields[fi]]);
                if (!val) continue;
                if (val.includes(word)) {
                    hit = true;
                    // Higher score for earlier fields (item_desc, item_name are most important)
                    const fieldBonus = (CFG.fields.length - fi) * 3;
                    const startBonus = val.startsWith(word) ? 5 : 0;
                    const exactBonus = new RegExp(
                        `\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`
                    ).test(val) ? 3 : 0;
                    total += fieldBonus + startBonus + exactBonus;
                    break;
                }
            }
            if (!hit) return 0; // all words must match
        }
        return total;
    }

    // ─── SEARCH ───────────────────────────────────────────────────────────────

    function search(raw) {
        const q = norm(raw);
        if (q.length < CFG.minChars) { exitSearch(); return; }

        const words = q.split(/\s+/).filter(Boolean);
        const pool = filterVisible(buildAllItems());

        const scored = [];
        for (const item of pool) {
            const s = scoreItem(item, words);
            if (s > 0) scored.push({ item, s });
        }

        scored.sort((a, b) =>
            b.s - a.s ||
            norm(a.item.item_desc || a.item.item_name)
                .localeCompare(norm(b.item.item_desc || b.item.item_name))
        );

        const results = scored.slice(0, CFG.maxResults).map(r => r.item);

        _active = true;
        renderResults(results, words);
        updateCount(results.length, raw);
    }

    function exitSearch() {
        if (!_active) return;
        _active = false;
        _lastQuery = '';
        updateCount(0, '');

        // Restore active category
        const activeTab =
            document.querySelector('.category-tab.active') ||
            document.querySelector('.category-tab');
        if (activeTab) {
            const code = activeTab.dataset.category;
            if (code && typeof window.renderCategoryByCode === 'function') {
                window.renderCategoryByCode(code);
                return;
            }
            activeTab.click();
        }
    }

    // ─── RENDER ───────────────────────────────────────────────────────────────

    function esc(s) {
        return String(s || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

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

        // Hand off to existing render pipeline — it handles skeletons,
        // modifier modals, add-to-cart etc. correctly.
        // We must NOT set window.menuGridItems here because that would
        // break the "exit search → restore category" flow.
        // Instead we pass a copy and let the render fn use it.
        const useWorkflow = window.MENU_CONFIG?.RENDERING_MODE !== 'traditional';
        const snapshot = window.menuGridItems; // save current category items

        window.menuGridItems = items; // render needs this for card click handler

        if (useWorkflow && typeof window.renderMenuGridWorkFlow === 'function') {
            window.renderMenuGridWorkFlow(items);
        } else if (typeof window.renderMenuGridTraditional === 'function') {
            window.renderMenuGridTraditional(items);
        } else {
            renderFallback(items, words, container);
        }

        // After render, restore snapshot reference so exit search can tell
        // the active category tab click will repopulate correctly
        // (renderCategoryByCode re-sets menuGridItems itself anyway)

        // Apply text highlights
        if (CFG.highlight && words.length) {
            requestAnimationFrame(() => {
                container.querySelectorAll('.font-semibold, h3').forEach(el => {
                    if (el.textContent.trim())
                        el.innerHTML = highlight(el.textContent, words);
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
        });
        container.innerHTML = '';
        container.appendChild(frag);
        container.removeEventListener('click', _fallbackClickHandler);
        container.addEventListener('click', _fallbackClickHandler);
    }

    function _fallbackClickHandler(e) {
        if (e.target.matches('button.add-btn')) {
            const id = e.target.getAttribute('data-item-id');
            if (id && typeof window.addToCart === 'function') window.addToCart(id);
            return;
        }
        const card = e.target.closest('.menu-item');
        if (card && typeof window.addToCart === 'function') window.addToCart(card.dataset.itemId);
    }

    function updateCount(count, query) {
        const el = document.getElementById('ks-count');
        if (!el) return;
        el.textContent = query && count > 0
            ? `${count} result${count !== 1 ? 's' : ''}`
            : query && count === 0 ? 'No results' : '';
    }

    // ─── INJECT UI ────────────────────────────────────────────────────────────

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
                <input id="ks-input"
                       type="text"
                       inputmode="none"
                       autocomplete="off" autocorrect="off"
                       autocapitalize="off" spellcheck="false"
                       placeholder="${CFG.placeholder}"
                       aria-label="Search menu"
                       readonly />
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
        console.log('[KioskSearch] ✅ Injected — item pool will build on first search');
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
            // Block all physical keyboard input — virtual keyboard only
            if (!e._fromVirtualKeyboard) {
                e.preventDefault();
                return;
            }
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
#ks-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    max-width: 420px;
    margin: 0 16px;
}
#ks-inner {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    background: #f5f5f5;
    border: 1.5px solid #e0e0e0;
    border-radius: 999px;
    padding: 0 14px;
    height: 40px;
    transition: border-color .18s, box-shadow .18s, background .18s;
}
#ks-bar.ks-focused #ks-inner {
    border-color: var(--primary, #D3281B);
    background: #fff;
    box-shadow: 0 0 0 3px rgba(211,40,27,.12);
}
#ks-icon {
    color: #aaa;
    flex-shrink: 0;
    transition: color .18s;
}
#ks-bar.ks-focused #ks-icon { color: var(--primary, #D3281B); }
#ks-input {
    flex: 1;
    border: none;
    background: transparent;
    font-size: 16px; /* must be >=16px to prevent iOS auto-zoom */
    color: #222;
    outline: none;
    box-shadow: none;
    padding: 0;
    height: 100%;
    min-width: 0;
    font-family: inherit;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    transform-origin: left center;
}
#ks-input::placeholder { color: #bbb; }
#ks-input::-webkit-search-cancel-button { display: none; }
#ks-clear {
    display: none;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: none;
    background: #ddd;
    color: #666;
    cursor: pointer;
    flex-shrink: 0;
    padding: 0;
    transition: background .15s;
}
#ks-clear:hover { background: var(--primary, #D3281B); color: #fff; }
#ks-count {
    font-size: 11px;
    color: #999;
    white-space: nowrap;
    flex-shrink: 0;
}
#menuGrid mark {
    background: rgba(211,40,27,.13);
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
}

/* ── Mobile / portrait kiosk responsive ── */
@media (max-width: 600px) {
    #ks-bar {
        flex: 0 0 auto;
        width: 110px;
        min-width: 0;
        margin: 0 3px;
    }
    #ks-inner {
        height: 28px;
        padding: 0 7px;
        gap: 4px;
        width: 100%;
    }
    #ks-input {
        font-size: 16px; /* keep 16px — iOS zooms when < 16px */
        min-width: 0;
        width: 0;
        flex: 1;
        transform: scale(0.75);
        transform-origin: left center;
    }
    #ks-input::placeholder {
        opacity: 0.6;
    }
    #ks-icon {
        width: 11px;
        height: 11px;
        flex-shrink: 0;
    }
    #ks-count {
        display: none;
    }
    #ks-clear {
        width: 15px;
        height: 15px;
        flex-shrink: 0;
        padding: 0;
    }
}
        `;
        document.head.appendChild(s);
    }

    // ─── AUTO-INJECT & HOOKS ──────────────────────────────────────────────────

    function tryInject() {
        if (document.getElementById('ks-bar')) return;
        if (!inject()) {
            const obs = new MutationObserver(() => {
                if (inject()) obs.disconnect();
            });
            obs.observe(document.body, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(tryInject, 300));
    } else {
        setTimeout(tryInject, 200);
    }

    // After selectOrderType finishes (menu + FullItems loaded), re-inject
    // and invalidate pool so next search uses fresh data
    const _origSOT = window.selectOrderType;
    if (typeof _origSOT === 'function') {
        window.selectOrderType = async function (...args) {
            const result = await _origSOT.apply(this, args);
            invalidateItemPool();
            setTimeout(tryInject, 800);
            return result;
        };
    }

    // Public API
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
// On-screen keyboard for kiosk touch screens.
// Appears below the header when the search input is focused.
// Dismissed by tapping X, pressing Escape, or tapping outside.

(function initVirtualKeyboard() {
    'use strict';

    const LAYOUTS = {
        default: [
            ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
            ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
            ['Z', 'X', 'C', 'V', 'B', 'N', 'M', '⌫'],
            ['123', 'space', '⏎']
        ],
        numbers: [
            ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
            ['-', '/', ':', ';', '(', ')', '$', '&', '@', '"'],
            ['#+=', '.', '·', ',', '?', '!', '\'', '⌫'],
            ['ABC', 'space', '⏎']
        ],
        symbols: [
            ['[', ']', '{', '}', '#', '%', '^', '*', '+', '='],
            ['_', '\\', '|', '~', '<', '>', '€', '£', '¥', '·'],
            ['123', '.', '·', ',', '?', '!', '\'', '⌫'],
            ['ABC', 'space', '⏎']
        ]
    };

    let _layout = 'default';
    let _shift = false;
    let _kb = null;
    let _input = null;
    let _visible = false;

    function createKeyboard() {
        if (document.getElementById('vk-overlay')) return;

        // Overlay (transparent, catches outside taps)
        const overlay = document.createElement('div');
        overlay.id = 'vk-overlay';
        overlay.addEventListener('mousedown', e => {
            if (!document.getElementById('vk-board').contains(e.target) &&
                e.target !== _input) {
                hide();
            }
        });
        document.body.appendChild(overlay);

        // Keyboard board
        const board = document.createElement('div');
        board.id = 'vk-board';
        board.setAttribute('aria-label', 'Virtual keyboard');
        document.body.appendChild(board);

        // Prevent keyboard taps from stealing focus from input
        // Only preventDefault on mousedown (desktop), NOT touchstart (breaks touchscreen)
        board.addEventListener('mousedown', e => e.preventDefault());

        injectKbStyles();
        _kb = board;
        renderLayout();
    }

    function renderLayout() {
        if (!_kb) return;
        const rows = LAYOUTS[_layout];
        _kb.innerHTML = '';

        rows.forEach(row => {
            const rowEl = document.createElement('div');
            rowEl.className = 'vk-row';

            row.forEach(key => {
                const btn = document.createElement('button');
                btn.className = 'vk-key';
                btn.type = 'button';
                btn.setAttribute('data-key', key);

                // Apply special class
                if (key === '⌫') btn.classList.add('vk-backspace');
                else if (key === '⇧') { btn.classList.add('vk-shift'); if (_shift) btn.classList.add('vk-shift-active'); }
                else if (key === 'space') { btn.classList.add('vk-space'); btn.textContent = ''; }
                else if (key === '⏎') btn.classList.add('vk-enter');
                else if (key === '123' || key === 'ABC' || key === '#+=') btn.classList.add('vk-fn');
                else btn.textContent = key;

                if (key === '⌫') btn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/></svg>`;
                if (key === '⏎') btn.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>`;
                if (key === '⇧') btn.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="17 11 12 6 7 11"/><line x1="12" y1="6" x2="12" y2="18"/></svg>`;
                if (key === '123') btn.textContent = '123';
                if (key === 'ABC') btn.textContent = 'ABC';
                if (key === '#+=') btn.textContent = '#+=';

                btn.addEventListener('click', () => handleKey(key));

                // touchstart — instant visual feedback (press down feeling)
                btn.addEventListener('touchstart', e => {
                    e.stopPropagation();
                    btn.classList.add('vk-pressed');
                }, { passive: true });

                // touchend — fire key + remove press state
                btn.addEventListener('touchend', e => {
                    e.preventDefault();
                    btn.classList.remove('vk-pressed');
                    handleKey(key);
                }, { passive: false });

                // touchcancel — clean up if touch is interrupted
                btn.addEventListener('touchcancel', () => {
                    btn.classList.remove('vk-pressed');
                });
                rowEl.appendChild(btn);
            });

            _kb.appendChild(rowEl);
        });
    }

    function handleKey(key) {
        if (!_input) return;

        if (key === '⌫') {
            const pos = _input.selectionStart;
            if (pos > 0) {
                const val = _input.value;
                _input.value = val.slice(0, pos - 1) + val.slice(pos);
                _input.setSelectionRange(pos - 1, pos - 1);
            }
        } else if (key === 'space') {
            insertAt(_input, ' ');
        } else if (key === '⏎') {
            hide();
        } else if (key === '123') {
            _layout = 'numbers';
            renderLayout();
            return;
        } else if (key === '#+=') {
            _layout = 'symbols';
            renderLayout();
            return;
        } else if (key === 'ABC') {
            _layout = 'default';
            _shift = false;
            renderLayout();
            return;
        } else {
            insertAt(_input, key.toUpperCase());
            // Auto-lowercase after one shifted character
            if (_shift) {
                _shift = false;
                _layout = 'default';
                renderLayout();
            }
        }

        // Trigger input event so search fires — marked so keydown block allows it
        const vkEvent = new Event('input', { bubbles: true });
        vkEvent._fromVirtualKeyboard = true;
        _input.dispatchEvent(vkEvent);
        // Re-focus without scrolling — prevents page jump on touchscreen
        _input.focus({ preventScroll: true });
    }

    function insertAt(el, text) {
        const start = el.selectionStart;
        const end = el.selectionEnd;
        el.value = el.value.slice(0, start) + text + el.value.slice(end);
        el.setSelectionRange(start + text.length, start + text.length);
    }

    function show(inputEl) {
        _input = inputEl;
        // Remove readonly so virtual keyboard can write to the field
        _input.removeAttribute('readonly');
        if (!_kb) createKeyboard();
        _layout = 'default';
        _shift = false;
        renderLayout();

        const overlay = document.getElementById('vk-overlay');
        if (overlay) overlay.style.display = 'block';
        _kb.classList.add('vk-visible');
        _kb.style.display = 'flex';
        _visible = true;

        // Push page content up so keyboard doesn't cover the menu grid
        document.querySelector('.main-content')?.style.setProperty(
            'padding-bottom', (_kb.offsetHeight + 12) + 'px'
        );
    }

    function hide() {
        if (!_visible) return;
        _visible = false;

        const overlay = document.getElementById('vk-overlay');
        if (overlay) overlay.style.display = 'none';
        if (_kb) {
            _kb.classList.remove('vk-visible');
            _kb.style.display = 'none';
        }
        // Restore readonly so Windows touch keyboard won't appear on next tap
        if (_input) _input.setAttribute('readonly', true);
        // Remove extra padding
        document.querySelector('.main-content')?.style.removeProperty('padding-bottom');
    }

    // Hook into the search input once it's injected
    function hookInput() {
        const input = document.getElementById('ks-input');
        if (!input || input._vkHooked) return;
        input._vkHooked = true;

        input.addEventListener('focus', () => show(input));
        // Don't hide on blur — blur fires when user taps a key (mousedown steals focus momentarily)
        // Instead we hide on overlay tap or clear/escape (handled above)

        console.log('[VirtualKeyboard] ✅ Hooked to #ks-input');
    }

    // Wait for #ks-input to appear
    function waitForInput() {
        if (document.getElementById('ks-input')) {
            hookInput();
        } else {
            const obs = new MutationObserver(() => {
                if (document.getElementById('ks-input')) {
                    hookInput();
                    obs.disconnect();
                }
            });
            obs.observe(document.body, { childList: true, subtree: true });
        }
    }

    // Also hide keyboard when clear button or escape is used
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
    document.addEventListener('click', e => {
        if (e.target.id === 'ks-clear') hide();
    });

    function injectKbStyles() {
        if (document.getElementById('vk-styles')) return;
        const s = document.createElement('style');
        s.id = 'vk-styles';
        s.textContent = `
#vk-overlay {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 8998;
    background: transparent;
}
#vk-board {
    display: none;
    flex-direction: column;
    gap: 12px;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 8999;
    background: #d1d5db;
    padding: 20px 16px 32px;
    box-shadow: 0 -6px 32px rgba(0,0,0,0.22);
    border-top: 1px solid #b0b5be;
    transform: translateY(100%);
    transition: transform 0.22s cubic-bezier(0.4,0,0.2,1);
}
#vk-board.vk-visible {
    transform: translateY(0);
}
.vk-row {
    display: flex;
    justify-content: center;
    gap: 10px;
}
.vk-key {
    height: 72px;
    min-width: 56px;
    flex: 1;
    max-width: 96px;
    background: #fff;
    border: none;
    border-radius: 10px;
    font-size: 26px;
    font-weight: 500;
    color: #111;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 3px 0 #9ca3af;
    transition: background 0.08s, transform 0.08s;
    user-select: none;
    -webkit-user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
.vk-key:active,
.vk-key.vk-pressed {
    background: #d0d0d0;
    transform: translateY(2px);
    box-shadow: 0 1px 0 #9ca3af;
}
.vk-backspace.vk-pressed,
.vk-shift.vk-pressed,
.vk-fn.vk-pressed {
    background: #6b7280;
}
.vk-enter.vk-pressed {
    background: #b91c1c;
    transform: translateY(2px);
    box-shadow: 0 1px 0 #7f1d1d;
}
.vk-shift-active.vk-pressed {
    background: #b91c1c;
}
.vk-backspace,
.vk-shift,
.vk-fn {
    background: #9ca3af;
    color: #111;
    font-size: 18px;
    flex: 1.5;
    max-width: 112px;
}
.vk-shift-active {
    background: var(--primary, #D3281B);
    color: #fff;
}
.vk-shift-active svg { stroke: #fff; }
.vk-space {
    flex: 5;
    max-width: 480px;
    background: #fff;
    border-radius: 10px;
}
.vk-enter {
    background: var(--primary, #D3281B);
    color: #fff;
    flex: 2;
    max-width: 140px;
}
.vk-enter svg { stroke: #fff; }

/* ── Mobile / portrait kiosk keyboard ── */
@media (max-width: 600px) {
    #vk-board {
        padding: 10px 6px 16px;
        gap: 7px;
    }
    .vk-row {
        gap: 5px;
    }
    .vk-key {
        height: 52px;
        min-width: 28px;
        max-width: 999px;
        font-size: 20px;
        border-radius: 7px;
        box-shadow: 0 2px 0 #9ca3af;
    }
    .vk-backspace,
    .vk-shift,
    .vk-fn {
        font-size: 13px;
        flex: 1.3;
    }
    .vk-space {
        flex: 4;
    }
    .vk-enter {
        flex: 1.6;
    }
    .vk-key svg {
        width: 20px;
        height: 20px;
    }
}

/* ── Tablet / landscape kiosk keyboard ── */
@media (min-width: 601px) and (max-width: 1024px) {
    #vk-board {
        padding: 14px 12px 22px;
        gap: 10px;
    }
    .vk-row { gap: 8px; }
    .vk-key {
        height: 62px;
        font-size: 28px;
    }
}
        `;
        document.head.appendChild(s);
    }

    // Export
    window.VirtualKeyboard = { show, hide, isVisible: () => _visible };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForInput);
    } else {
        waitForInput();
    }

})();