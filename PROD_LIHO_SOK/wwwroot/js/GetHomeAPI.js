import { useCache, rehydrateCacheFromApiManager } from '../stores/cache-store.js';
import { useOrder, useOrderStore } from '../stores/order-store.js';
import { uiTranslations } from './Translation.js';
import { restoreCacheAfterReload, saveCacheBeforeRedirect, PERSIST_KEYS } from '../js/kiosk-cache-persist.js';
import LZString from "https://esm.sh/lz-string";

import {
    handleMemberLogin,
    clearSessionOnPageLoad,
    attachOrderTypeHandlers,
    handleOrderTypeSelection,
    proceedAsGuest,
    showOrderTypeSelection
} from '../utils/ascentisCRM.js';

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

import {
    getLangs,
    fetchStoreDetails,
    getMenuItems,
    getItems,
    getPromos,
    getAddons,
    getItemRemarks,
    checkStocks,
    getSvcs,
    getMenuCategoryItemTranslations,
    postOrder,
    getStoreRegisterSettings,
    getStoreRegisterPrinter,
    getShift,
    getCashReconStatus,
    getPOSMenuAvailableItems,
    getSystemSettings

} from './netApi.js';

import {
    buildVisibleCategories,
    getCategories,
    getAddonItem,
    addModifierItem,
    getAvailableAddonItems,
    getAvailableModifierItems,
    addAlacarteItem,
    addItemHaveModifierOrAddon,
    changeItemQuantity,
    deleteOrderItem,
    getItemInfo,
    getStockStatus,
    translate,
    populateParentAndAddonItems,
    addAddonItem,
    changeModifierItemQty,
    clearCart,
    takeaway
} from '../utils/tqr.js';
import { getPriceByServiceType, applyPromotions, getNewOrder, getNewOrderSOK, addTax, calcOrderAmt, getSysSetting, isAbsorbTax, getAvailableServiceTypes } from '../utils/pos.js';
import { getNowInAPIFormat } from '../utils/common.js';
import { showAddOnModal, showWizardModal, scrollModalToTop, MENU_CONFIG, setMenuRenderingMode } from './Home.js';
import { renderCartFromOrder, showErrorModal, closeErrorModal, showSuccessModal, closeModal } from './renderCartFromOrder.js';
import { clearLocalImageCache } from './ImageCache.js'; // adjust path

// ─── SESSION STORAGE KEY ──────────────────────────────────────────────────────
// Single key for menu persistence across page reloads and post-order returns.
const MENU_CACHE_KEY = 'sok_menu_cache';
const MENU_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

let menuItems = [];
let cart = [];
let orderCounter = 1;
let store = null;
let isMenuGridClickListenerAttached = false;
const modalContent = document.getElementById('addonModalContent');
const modal = document.getElementById('addonModal');
const storename = localStorage.getItem("strorename");
const language = localStorage.getItem('selectedLang');
const uiText = uiTranslations[language];
let gstRate = parseFloat(sessionStorage.getItem("GST"));
let serviceRate = parseFloat(sessionStorage.getItem("ServiceCharge"));
const selectedLang = sessionStorage.getItem("selectedLang");
const orderType = localStorage.getItem("orderType");
window.__isReload = performance.getEntriesByType("navigation")[0]?.type === "reload";


// ─── FIX 1: Pre-parse AvailablePOSMenuItems ONCE at startup ──────────────────
// Previously parsed inside shouldShowItem() on every single item call.
// Now built once into fast O(1) lookup maps.
function buildItemAvlMapFromLocalStorage() {
    try {
        const raw = sessionStorage.getItem('AvailablePOSMenuItems');
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;

        if (!window.itemAvlMap) window.itemAvlMap = {};
        if (!window.categoryAvlMap) window.categoryAvlMap = {};

        parsed.forEach(entry => {
            if (entry.avl_type === 'I') {
                window.itemAvlMap[entry.item_category?.trim()] = entry;
            } else if (entry.avl_type === 'C') {
                window.categoryAvlMap[entry.item_category?.trim()] = entry;
            }
        });

        window._itemAvlMapBuilt = true;
        console.log('✅ [Boot] itemAvlMap pre-built:', {
            items: Object.keys(window.itemAvlMap).length,
            categories: Object.keys(window.categoryAvlMap).length
        });
    } catch (e) {
        console.warn('⚠️ [Boot] Failed to pre-build itemAvlMap:', e);
    }
}

buildItemAvlMapFromLocalStorage();

function handleLogout() {
    logoutMember();
    window.location.reload();
}

function parseKioskUrl() {
    const deviceId = getDeviceIdFromUrl();
    const location = getSokLocationFromUrl();
    const urlInfo = {
        deviceId: deviceId || 'UNKNOWN',
        location: location || 'Unknown',
        fullUrl: window.location.href,
        isValid: !!(deviceId && location)
    };
    console.log('📍 Parsed Kiosk URL:', urlInfo);
    return urlInfo;
}

class SafeStorageManager {
    constructor() {
        this.memoryStorage = {};
        this.localStorageAvailable = this.testStorage('localStorage');
        this.sessionStorageAvailable = this.testStorage('sessionStorage');
    }

    testStorage(type) {
        try {
            const storage = window[type];
            const testKey = '__storage_test__';
            storage.setItem(testKey, 'test');
            storage.removeItem(testKey);
            return true;
        } catch (e) {
            return false;
        }
    }

    getItem(key) {
        try {
            if (this.localStorageAvailable) return localStorage.getItem(key);
            if (this.sessionStorageAvailable) return sessionStorage.getItem(key);
            return this.memoryStorage[key] || null;
        } catch (e) {
            return this.memoryStorage[key] || null;
        }
    }

    setItem(key, value) {
        try {
            if (this.localStorageAvailable) localStorage.setItem(key, value);
            if (this.sessionStorageAvailable) sessionStorage.setItem(key, value);
            this.memoryStorage[key] = value;
            return true;
        } catch (e) {
            this.memoryStorage[key] = value;
            return false;
        }
    }

    clear() {
        try {
            if (this.localStorageAvailable) localStorage.clear();
            if (this.sessionStorageAvailable) sessionStorage.clear();
            this.memoryStorage = {};
        } catch (e) {
            this.memoryStorage = {};
        }
    }
}

window.safeStorage = new SafeStorageManager();

function getDeviceIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('device_id') || params.get('deviceId');
}

function getSokLocationFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('outlet') || params.get('location') || params.get('sok_location') || 'default';
}

async function initializeDeviceId() {
    console.log('🚀 Initializing device ID...');
    const storage = window.safeStorage;

    let deviceId = getDeviceIdFromUrl();
    if (!deviceId) deviceId = storage.getItem("sok_device_id");
    if (!deviceId) {
        deviceId = `KIOSK_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        console.log('🆕 Generated fallback device ID:', deviceId);
    } else {
        console.log('✅ Using device ID:', deviceId);
    }

    const location = getSokLocationFromUrl();
    storage.setItem("sok_device_id", deviceId);
    storage.setItem("sok_location", location);

    try {
        const rcResponse = await fetch('/API/RemoteControl/register-device', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deviceId,
                deviceName: `Kiosk ${location} - ${deviceId}`,
                location,
                registeredAt: new Date().toISOString()
            })
        });
        if (rcResponse.ok) {
            const result = await rcResponse.json();
            if (result.device) storage.setItem("sok_device_info", JSON.stringify(result.device));
        }
    } catch (error) {
        console.error('❌ RemoteControl registration error:', error);
    }

    try {
        await fetch('/API/SOKOrder/devices/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId, deviceName: `SOK-Kiosk-${deviceId}`, location })
        });
        console.log('✅ SOK Order validation registry updated');
    } catch (error) {
        console.error('❌ SOKOrder registration error:', error);
    }

    if (typeof initializeWebSocket === 'function') {
        await initializeWebSocket(deviceId, location);
    }

    return deviceId;
}

async function registerToSOKOrderRegistry(deviceId, location) {
    try {
        const response = await fetch('/API/SOKOrder/devices/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId, deviceName: `SOK-Kiosk-${deviceId}`, location })
        });
        if (response.ok) {
            console.log('✅ SOK Order Validation Registry Updated');
        } else {
            console.warn('⚠️ SOK Order Registry update failed');
        }
    } catch (error) {
        console.error('❌ SOK Registry network error:', error);
    }
}

async function initializeWebSocket(deviceId, location) {
    console.log('🔌 Initializing WebSocket...');
    if (!deviceId || !location) { console.error('❌ Missing device info for WebSocket'); return; }
    if (typeof window.sokWebSocket === 'undefined') { console.error('❌ window.sokWebSocket undefined'); return; }

    window.sokWebSocket.deviceInfo = { deviceId, outlet: location };

    if (window.sokWebSocket.ws && window.sokWebSocket.ws.readyState === WebSocket.OPEN) {
        console.log('✅ WebSocket already connected');
        return;
    }

    if (window.sokWebSocket.ws) {
        try {
            window.sokWebSocket.disconnect();
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (e) {
            console.warn('⚠️ Error disconnecting old WebSocket:', e);
        }
    }

    try {
        await window.sokWebSocket.initialize();
        let attempts = 0;
        while (attempts < 10) {
            await new Promise(resolve => setTimeout(resolve, 500));
            attempts++;
            if (window.sokWebSocket.isConnected) { console.log('✅ WebSocket connected'); return; }
            if (attempts > 3 && window.sokWebSocket.ws?.readyState >= 2) {
                window.sokWebSocket.deviceInfo = { deviceId, outlet: location };
                await window.sokWebSocket.initialize();
            }
        }
        if (!window.sokWebSocket.isConnected) console.warn('⚠️ WebSocket still not connected');
    } catch (error) {
        console.error('❌ WebSocket init error:', error);
    }
}

window.addEventListener('DOMContentLoaded', async () => {
    const memberInfoRaw = localStorage.getItem('member_info');
    if (memberInfoRaw) {
        console.log("👤 Member detected — logging out before start over");
        handleLogout();
    }
    if (window.__appStarted) return;
    window.__appStarted = true;
    window.isFreshBoot = true;
    console.log('🚀 DOMContentLoaded → Starting initialization');

    try {
        const hasActiveOrder = localStorage.getItem('active_cart') ||
            localStorage.getItem('order-storage') ||
            localStorage.getItem('current_order_id');

        if (hasActiveOrder) {
            const urlParams = new URLSearchParams(window.location.search);
            const outlet = urlParams.get('outlet') || localStorage.getItem("sok_location") || 'MILENIA WALK';
            const deviceId = urlParams.get('device_id') || localStorage.getItem("sok_device_id") || "01";
            const clearUrl = `/API/SOKOrder/${encodeURIComponent(outlet)}/${deviceId}/cache/clear`;
            fetch(clearUrl, { method: "POST", headers: { "Content-Type": "application/json" } })
                .then(r => console.log(`📡 Server Cache Clear: ${r.status}`))
                .catch(err => console.warn("📡 Server Cache Clear failed:", err));

            const orderKeys = ['active_cart', 'order-storage', 'sno-storage', 'current_order_id', 'lastSNo', 'member_session', 'order', 'orderType'];
            orderKeys.forEach(k => localStorage.removeItem(k));

            if (window.useOrderStore) {
                window.useOrderStore.setState({ sales_dtls: [], net_amt: 0, orderId: null, service_type: null }, true);
            }
            if (window.sokWebSocket?.clearOrderCache) {
                await window.sokWebSocket.clearOrderCache().catch(() => { });
            }
        }

        await initializeDeviceId();
        await initializeApp();

        if (typeof renderCart === 'function') renderCart([]);

    } catch (err) {
        console.error('❌ Initialization error:', err);
    } finally {
        setTimeout(() => { window.isFreshBoot = false; }, 5000);
    }
});

class APILoadManager {
    constructor() {
        this.loadingStates = new Map();
        this.loadedData = new Map();
        this.retryAttempts = new Map();
        this.maxRetries = 3;
        this.retryDelay = 1000;
        this.timeout = 60000;
    }

    async loadAPI(name, loadFunction, options = {}) {
        const { forceReload = false, allowEmpty = false, isCritical = false, timeout = this.timeout } = options;

        if (this.loadingStates.get(name) === 'loading') {
            console.log(`⏳ ${name} is already loading, waiting...`);
            return this.waitForLoad(name);
        }

        if (!forceReload && this.loadedData.has(name)) {
            console.log(`✅ ${name} already loaded from cache`);
            return this.loadedData.get(name);
        }

        this.loadingStates.set(name, 'loading');
        console.log(`🔄 Loading ${name}...`);

        try {
            const data = await this.withTimeout(loadFunction(), timeout, name);
            const isEmpty = this.isDataEmpty(data);

            if (isEmpty && !allowEmpty) throw new Error(`${name} returned empty data`);

            this.loadedData.set(name, data || null);
            this.loadingStates.set(name, 'success');
            this.retryAttempts.delete(name);

            if (isEmpty) console.warn(`⚠️ ${name} loaded but empty (allowed)`);
            else console.log(`✅ ${name} loaded successfully`);

            return data || null;

        } catch (error) {
            const errorMsg = error.message || String(error);
            console.error(`❌ Error loading ${name}:`, errorMsg);

            const shouldRetry = this.shouldRetryError(error, isCritical);
            const attempts = this.retryAttempts.get(name) || 0;

            if (shouldRetry && attempts < this.maxRetries) {
                this.retryAttempts.set(name, attempts + 1);
                this.loadingStates.set(name, 'retrying');
                console.log(`🔁 Retrying ${name} (${attempts + 1}/${this.maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, this.retryDelay * Math.pow(2, attempts)));
                return this.loadAPI(name, loadFunction, options);
            }

            this.loadingStates.set(name, 'failed');

            if (!isCritical && allowEmpty) {
                console.warn(`⚠️ ${name} failed but not critical`);
                this.loadedData.set(name, null);
                return null;
            }

            throw error;
        }
    }

    withTimeout(promise, timeoutMs, name) {
        return Promise.race([
            promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Timeout loading ${name} after ${timeoutMs}ms`)), timeoutMs)
            )
        ]);
    }

    isDataEmpty(data) {
        if (data === null || data === undefined) return true;
        if (Array.isArray(data) && data.length === 0) return true;
        if (typeof data === 'object' && Object.keys(data).length === 0) return true;
        return false;
    }

    shouldRetryError(error, isCritical) {
        const errorMsg = String(error.message || error).toLowerCase();
        const noRetry = ['timeout', 'not found', '404', 'unauthorized', '401', '403'];
        if (noRetry.some(p => errorMsg.includes(p))) return false;
        if (isCritical && (errorMsg.includes('500') || errorMsg.includes('network'))) return true;
        return errorMsg.includes('network') || errorMsg.includes('fetch');
    }

    async waitForLoad(name, timeout = 30000) {
        const startTime = Date.now();
        while (this.loadingStates.get(name) === 'loading') {
            if (Date.now() - startTime > timeout) throw new Error(`Timeout waiting for ${name}`);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (this.loadingStates.get(name) === 'success') return this.loadedData.get(name);
        throw new Error(`Failed to load ${name}`);
    }

    // ─── FIX: Surgical cache clear — never wipes menu data ───────────────────
    // Call this instead of clearCache() after an order completes.
    // Menu data is expensive to re-fetch and doesn't change between orders.
    clearOrderCache() {
        const orderKeys = ['stocks', 'cashReconStatus'];
        orderKeys.forEach(key => {
            this.loadedData.delete(key);
            this.loadingStates.delete(key);
            this.retryAttempts.delete(key);
        });
        console.log('🧹 Order cache cleared (menu preserved)');
    }

    clearCache(name) {
        if (name) {
            this.loadedData.delete(name);
            this.loadingStates.delete(name);
            this.retryAttempts.delete(name);
        } else {
            this.loadedData.clear();
            this.loadingStates.clear();
            this.retryAttempts.clear();
        }
    }

    isLoaded(name) { return this.loadingStates.get(name) === 'success'; }
    getLoadingState(name) { return this.loadingStates.get(name) || 'idle'; }
}

const apiManager = new APILoadManager();

export async function loadStoreDetails() {
    return apiManager.loadAPI('store', async () => {
        return await fetchStoreDetails();
    }, { isCritical: true, allowEmpty: false });
}

// ─── FIX 2: loadMenuItems — sessionStorage persistence ───────────────────────
// Survives page reloads and post-order landing returns.
// apiManager resets on every page load (in-memory), but sessionStorage persists
// for the entire browser tab session. This eliminates the 3-API re-fetch that
// was causing the post-order hang.
export async function loadMenuItems() {
    console.log('🔄 loadMenuItems called...');

    // 1. apiManager in-memory hit (fastest — same JS context)
    if (apiManager.isLoaded('menuItems')) {
        console.log('✅ menuItems already in apiManager cache');
        return apiManager.loadedData.get('menuItems');
    }

    // 2. sessionStorage hit (survives page reloads)
    try {
        const persisted = sessionStorage.getItem(MENU_CACHE_KEY);
        if (persisted) {
            const { data, ts } = JSON.parse(persisted);
            const age = Date.now() - ts;
            if (Array.isArray(data) && data.length > 0 && age < MENU_CACHE_TTL) {
                apiManager.loadedData.set('menuItems', data);
                apiManager.loadingStates.set('menuItems', 'success');
                console.log(`⚡ menuItems restored from sessionStorage (age: ${Math.round(age / 1000)}s)`);
                return data;
            } else {
                console.log('🗑️ sessionStorage menu cache expired, fetching fresh');
                sessionStorage.removeItem(MENU_CACHE_KEY);
            }
        }
    } catch (e) {
        console.warn('⚠️ sessionStorage read failed:', e);
    }

    // 3. Network fetch (cold path)
    return apiManager.loadAPI('menuItems', async () => {
        console.log('📡 Calling getMenuItems (force fresh)...');
        const data = await getMenuItems(true);
        if (data && data.length > 0) {
            const firstWithImage = data.flatMap(s => s.items || []).find(i => i.tqr_image_url);
            if (firstWithImage) console.log('✅ Fresh image verified:', firstWithImage.tqr_image_url);

            // Persist to sessionStorage immediately after fetch
            try {
                sessionStorage.setItem(MENU_CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
                console.log('💾 menuItems persisted to sessionStorage');
            } catch (e) {
                console.warn('⚠️ sessionStorage write failed (quota?):', e);
            }
        }
        return data;
    }, { isCritical: true, allowEmpty: false });
}

// Call this after a successful order to invalidate menu cache if needed
// (e.g. stock sold out). Leave it unset normally so cache is reused.
export function invalidateMenuCache() {
    sessionStorage.removeItem(MENU_CACHE_KEY);
    apiManager.clearCache('menuItems');
    clearLocalImageCache();
    console.log('🗑️ Menu cache invalidated');
}

export async function loadItems() {
    return apiManager.loadAPI('items', async () => {
        return await getItems();
    }, { isCritical: true, allowEmpty: false });
}

export async function loadAddons() {
    return apiManager.loadAPI('addons', async () => {
        return await getAddons();
    }, { isCritical: false, allowEmpty: true });
}

export async function loadItemRemarks() {
    return apiManager.loadAPI('itemRemarks', async () => {
        return await getItemRemarks();
    }, { isCritical: false, allowEmpty: true });
}

export async function loadPromos() {
    return apiManager.loadAPI('promos', async () => {
        return await getPromos();
    }, { isCritical: false, allowEmpty: true });
}

export async function loadSvcs() {
    return apiManager.loadAPI('svcs', async () => {
        try {
            return await getSvcs();
        } catch (error) {
            console.warn('⚠️ getSvcs failed, returning defaults');
            return {
                data: [{ output: [{ service_value: 0, service_type: 'D', service_name: 'Default Service', service_desc: 'Default service charge' }] }]
            };
        }
    }, { isCritical: false, allowEmpty: true });
}

export async function loadSystemSetting() {
    return apiManager.loadAPI('systemSettings', async () => {
        return await getSystemSettings();
    }, { isCritical: false, allowEmpty: true });
}

export async function loadLangs() {
    return apiManager.loadAPI('langs', async () => {
        return await getLangs();
    }, { isCritical: false, allowEmpty: true });
}

export async function loadStocks() {
    return apiManager.loadAPI('stocks', async () => {
        return await checkStocks();
    }, { isCritical: false, allowEmpty: true });
}

export async function loadStoreSetting() {
    return apiManager.loadAPI('registerSettings', async () => {
        return await getStoreRegisterSettings();
    }, { isCritical: false, allowEmpty: true });
}

export async function loadgetStoreRegisterPrinter() {
    return apiManager.loadAPI('StoreRegisterPrinter', async () => {
        return await getStoreRegisterPrinter();
    }, { isCritical: false, allowEmpty: true });
}

export async function loadCashReconStatus() {
    return apiManager.loadAPI('cashReconStatus', async () => {
        return await getCashReconStatus();
    }, { isCritical: true, allowEmpty: false });
}

export async function loadMenuAvailability() {
    return apiManager.loadAPI('menuAvailability', async () => {
        return await getPOSMenuAvailableItems();
    }, { isCritical: false, allowEmpty: true });
}

async function waitForOutletOpen() {
    return new Promise(async (resolve) => {
        async function check() {
            console.log('🔄 Checking outlet status...');
            try {
                apiManager.clearCache('cashReconStatus');
                const cashReconStatus = await loadCashReconStatus();
                const isOutletOpen = validateOutletStatus(cashReconStatus);
                if (isOutletOpen) {
                    console.log('✅ Outlet is open');
                    closeErrorModal();
                    resolve(true);
                    return;
                }
                showErrorModal('Outlet Unavailable', 'This outlet is currently closed or the shift has not started.', 'Please contact staff or press Retry.', check);
            } catch (err) {
                showErrorModal('Status Check Failed', 'Unable to verify outlet status.', err.message, check);
            }
        }
        await check();
    });
}

let isInitialized = false;
let isInitializing = false;
let initPromise = null;

function syncApiManagerToCache() {
    const cache = useCache();
    const mgr = window.apiManager?.loadedData;
    if (!mgr || !cache) return;

    const syncs = [
        ['items', 'setItems'],
        ['itemRemarks', 'setItemRemarks'],
        ['addons', 'setAddons'],
        ['promos', 'setPromos'],
        ['stocks', 'setStocks'],
        ['langs', 'setLangs'],
        ['menuItems', 'setMenuItems'],
        ['menuAvailability', 'setMenuAvailability'],
    ];

    syncs.forEach(([key, setter]) => {
        const data = mgr.get(key);
        if (data && typeof cache[setter] === 'function') {
            cache[setter](data);
            console.log(`✅ Synced ${key} → useCache`);
        }
    });

    const currentPrintConfig = cache.printConfig;
    if (!currentPrintConfig?.Kitchen) {
        console.warn('⚠️ printConfig.Kitchen missing — re-fetching...');
        import('./netApi.js').then(({ getPrintConfig }) => getPrintConfig?.());
    }
}

function setBootStatus(message) {
    const el = document.getElementById('kioskBootStatus');
    if (el) el.textContent = message;
    console.log('🔄 [Boot]', message);
}

function dismissBootLoader() {
    const loader = document.getElementById('kioskBootLoader');
    if (!loader) return;
    loader.style.opacity = '0'; 
    loader.style.pointerEvents = 'none';
    setTimeout(() => loader.remove(), 450);
    console.log('✅ [Boot] Loader dismissed');
}

function waitForWebSocket(timeoutMs = 8000) {
    return new Promise(resolve => {
        if (window.sokWebSocket?.ws?.readyState === WebSocket.OPEN) return resolve();
        const start = Date.now();
        const interval = setInterval(() => {
            if (window.sokWebSocket?.ws?.readyState === WebSocket.OPEN) {
                clearInterval(interval); resolve();
            } else if (Date.now() - start > timeoutMs) {
                console.warn('⚠️ [Boot] WebSocket timeout — proceeding anyway');
                clearInterval(interval); resolve();
            }
        }, 100);
    });
}

function rehydrateCacheStoreFromApiManager() {
    const _fullItemsRaw = sessionStorage.getItem('FullItems');
    const fullItems = window.apiManager?.loadedData?.get('FullItems')
        || (_fullItemsRaw ? JSON.parse(LZString.decompressFromUTF16(_fullItemsRaw)) : []);
    const addOnItems = window.apiManager?.loadedData?.get('AddOnItems') || JSON.parse(sessionStorage.getItem('AddOnItems') || '[]');
    const menuItems = window.apiManager?.loadedData?.get('MenuItems') || JSON.parse(sessionStorage.getItem('MenuItems') || '[]');
    const stocks = window.apiManager?.loadedData?.get('stocks') || JSON.parse(sessionStorage.getItem('stocks') || '[]');
    const store = window.apiManager?.loadedData?.get('store') || JSON.parse(sessionStorage.getItem('store') || 'null');

    const state = _useCacheStore.getState();
    if (fullItems.length) state.setItems(fullItems);
    if (addOnItems.length) state.setAddons(addOnItems);
    if (menuItems.length) state.setMenuItems(menuItems);
    if (stocks.length) state.setStocks(stocks);
    if (store) state.setStore(store);

    console.log('✅ Cache store re-hydrated:', { items: fullItems.length, addons: addOnItems.length, menuItems: menuItems.length });
}

async function initializeApp() {
    setBootStatus('Starting up…');

    let restoredCount = 0;
    if (typeof window.restoreCacheAfterReload === 'function') {
        restoredCount = window.restoreCacheAfterReload();
    }
    if (restoredCount > 0) rehydrateCacheFromApiManager();

    const isStartOver = localStorage.getItem('pos_start_over') === 'true';
    const sessionWarm = sessionStorage.getItem('skip_api_on_load') === 'true';
    let isWarm = (restoredCount > 0) || isStartOver || sessionWarm;

    const navEntry = performance.getEntriesByType('navigation')[0];
    const isHardReload = navEntry ? navEntry.type === 'reload' : performance.navigation?.type === 1;
    if (isHardReload && !isStartOver) {
        console.log('🔄 Manual F5 — forcing COLD BOOT');
        isWarm = false;
        sessionStorage.removeItem('skip_api_on_load');
    }

    if (isStartOver) {
        localStorage.removeItem('pos_start_over');
        sessionStorage.removeItem('pos_start_over');
    }

    if (window.isInitialized) { console.log('⏭️ Already initialized'); return; }
    if (window.isInitializing) { console.log('⏭️ Already initializing'); return window.initPromise; }
    window.isInitializing = true;

    window.initPromise = (async () => {
        try {
            console.log(`🔄 Mode: ${isWarm ? 'WARM BOOT' : 'COLD BOOT'}`);

            if (!isWarm) {
                setBootStatus('Connecting to server…');
                await loadStoreDetails();

                setBootStatus('Loading store settings…');
                await Promise.all([loadSvcs(), loadStoreSetting(), loadgetStoreRegisterPrinter()]);
                //loadLangs();
                setBootStatus('Loading menu…');

                // ✅ Store the promise BEFORE awaiting it so _doLoadAndRenderMenu can join it
                // if selectOrderType fires while it's still in-flight (fast user tap)
                window._fullItemsPromise = loadItems().catch(e => {
                    console.warn('⚠️ FullItems preload failed:', e);
                    return [];
                });

                await Promise.all([
                    loadMenuItems(),
                    window._fullItemsPromise,   // await but DON'T null it after
                    loadMenuAvailability(),
                    loadSystemSetting()
                ]);

                // ✅ DO NOT null _fullItemsPromise here — it's already resolved so
                // _doLoadAndRenderMenu awaiting it is instant (no network cost).
                // It acts as a resolved sentinel so _doLoadAndRenderMenu knows
                // FullItems are ready without polling.

                const rawAvailResponse = apiManager.loadedData.get('menuAvailability');
                const availData = parseAvailabilityResponse(rawAvailResponse);
                if (availData.length > 0) {
                    // ✅ Write to sessionStorage to match buildItemAvlMapFromLocalStorage's read path
                    sessionStorage.setItem('AvailablePOSMenuItems', JSON.stringify(availData));
                    const { categoryAvlMap, itemAvlMap } = buildAvailabilityMaps(availData);
                    window.categoryAvlMap = categoryAvlMap;
                    window.itemAvlMap = itemAvlMap;
                    window._itemAvlMapBuilt = true;
                    console.log('✅ Availability maps built:', {
                        categories: Object.keys(categoryAvlMap).length,
                        items: Object.keys(itemAvlMap).length,
                    });
                }

            } else {
                setBootStatus('Restoring session…');
                window.__isWarmBoot = true;
                sessionStorage.setItem('skip_api_on_load', 'true');
                if (!localStorage.getItem('orderType')) localStorage.setItem('orderType', 'E');

                await loadStoreDetails();

                // ✅ 1. Initial fall-back build from cache
                buildItemAvlMapFromLocalStorage();

                // ✅ 2. Fetch fresh availability
                try {
                    await getPOSMenuAvailableItems();
                    console.log('✅ [Warm Boot] Availability refreshed from server');

                    // 🔥 CRITICAL RE-MAP PATCH: Rebuild your memory maps now that sessionStorage has been updated!
                    console.log('🗂️ [Warm Boot] Re-mapping lookup tables with live server data...');
                    buildItemAvlMapFromLocalStorage();

                } catch (err) {
                    console.warn('⚠️ [Warm Boot] Availability fetch failed, using cached map:', err);
                }

                // ✅ Item restore — separate try/catch from availability fetch
                try {
                    const compressed = sessionStorage.getItem('FullItems');
                    if (compressed && typeof LZString !== 'undefined') {
                        const decompressed = LZString.decompressFromUTF16(compressed);
                        if (decompressed) {
                            const items = JSON.parse(decompressed);
                            if (Array.isArray(items) && items.length > 0) {
                                useCache().setItems(items);
                                apiManager.loadedData.set('items', items);
                                apiManager.loadingStates.set('items', 'success');
                                console.log('✅ [Warm Boot] Items restored:', items.length);

                                // ✅ Expose as a resolved promise so _doLoadAndRenderMenu
                                // takes the fast path without polling
                                window._fullItemsPromise = Promise.resolve(items);
                            }
                        }
                    } else {
                        console.warn('⚠️ [Warm Boot] No compressed items — fetching fresh');
                        window._fullItemsPromise = loadItems().catch(() => []);
                        await window._fullItemsPromise;
                    }
                } catch (err) {
                    console.error('❌ [Warm Boot] Item restore failed:', err);
                    window._fullItemsPromise = loadItems().catch(() => []);
                    await window._fullItemsPromise;
                }

                try {
                    const menuData = apiManager.loadedData.get('menuItems');
                    if (!menuData) {
                        await loadMenuItems();
                    }
                } catch (err) {
                    console.warn('⚠️ [Warm Boot] Menu restore failed:', err);
                }
            }

            window.isInitialized = true;
            window.__appInitialized = true;
            console.log("✅ App initialization complete.");
            setBootStatus('Almost ready…');

            // ── BACKGROUND LOADS ───────────────────────────────────────────
            const backgroundLoad = Promise.allSettled([
                loadPromos(),
                ...(isWarm ? [] : [loadAddons(), loadItemRemarks(), loadStocks()])
            ]).then(() => {
                window.__backgroundDataReady = true;
                console.log(`✅ ${isWarm ? 'Warm' : 'Cold'} boot background complete.`);
            });

            if (isWarm) {
                dismissBootLoader();
                await backgroundLoad;
            } else {
                await backgroundLoad;
                dismissBootLoader();
            }

        } catch (error) {
            setBootStatus('Error starting up. Please refresh.');
            console.error('❌ Init Error:', error);
        } finally {
            window.isInitializing = false;
        }
    })();

    return window.initPromise;
}

window.initializeApp = initializeApp;
window.apiManager = apiManager;

function validateOutletStatus(statusData) {
    try {
        if (!statusData) return false;
        const data = Array.isArray(statusData.data) ? statusData.data[0] : statusData;
        const isShiftOpen = data?.shift_open_status === 'Shift already Open';
        const isCashInDone = data?.cash_in_status === 'Cash In Done';
        const isOpen = isShiftOpen && isCashInDone;
        console.log('🏪 Outlet is open:', isOpen);
        return isOpen;
    } catch (err) {
        console.error('❌ Error parsing outlet status:', err);
        return false;
    }
}

function hexToHSL(hex) { 
    if (!hex || typeof hex !== 'string') return { h: 0, s: 0, l: 0 };
    hex = hex.replace('#', '');
    if (!/^[0-9A-Fa-f]{6}$/.test(hex)) return { h: 0, s: 0, l: 0 };
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0, s = 0, l = (max + min) / 2;
    if (delta !== 0) {
        s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
        switch (max) {
            case r: h = ((g - b) / delta + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / delta + 2) / 6; break;
            case b: h = ((r - g) / delta + 4) / 6; break;
        }
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function HSLToHex(h, s, l) {
    s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return `#${Math.round((r + m) * 255).toString(16).padStart(2, '0')}${Math.round((g + m) * 255).toString(16).padStart(2, '0')}${Math.round((b + m) * 255).toString(16).padStart(2, '0')}`;
}

function applyDynamicTheme(primaryHex) {
    if (!primaryHex || typeof primaryHex !== 'string') return;
    const hsl = hexToHSL(primaryHex);
    const adj = (l, d) => Math.max(5, Math.min(95, l + d));
    const vars = {
        '--primary': primaryHex,
        '--primary-hover': HSLToHex(hsl.h, hsl.s, adj(hsl.l, -10)),
        '--primary-light': HSLToHex(hsl.h, Math.max(30, hsl.s - 25), adj(hsl.l, +20)),
        '--secondary': HSLToHex((hsl.h + 150) % 360, hsl.s, adj(hsl.l, +10)),
        '--secondary-foreground': HSLToHex((hsl.h + 150) % 360, hsl.s, adj(hsl.l, -35)),
        '--text-primary': hsl.l > 60 ? '#000' : '#fff',
    };
    Object.entries(vars).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
    console.log('🎨 Dynamic theme applied');
}

export function setKioskLogo(logoUrl) {
    const landingLogo = document.getElementById('langing-kiosk-logo');
    const kioskLogo = document.getElementById('kiosk-logo');
    if (landingLogo) { landingLogo.src = logoUrl; landingLogo.alt = 'Kiosk Logo'; }
    if (kioskLogo) { kioskLogo.src = logoUrl; kioskLogo.alt = 'Kiosk Logo'; }
}

window.GetHomeAPI = {
    selectOrderType,
    addToCart,
    removeFromCart,
    updateQuantity,
    updateQuantityBySno,
    closeModal,
    getItemInfo,
    getStockStatus,
    removeItemByLineId,
    updateQuantityByIndex,
    loadMenu,
    setKioskLogo
};

function normalizeMenuItems(data) {
    return data.map(section => ({
        ...section,
        category: Array.isArray(section.category) ? section.category : [],
        items: Array.isArray(section.items) ? section.items : [],
    }));
}

function parseAvailabilityResponse(rawResponse) {
    try {
        if (rawResponse?.data?.[0]?.output) {
            const output = rawResponse.data[0].output;
            return typeof output === 'string' ? JSON.parse(output) : output;
        }
        if (Array.isArray(rawResponse)) return rawResponse;
        return [];
    } catch (e) {
        console.error('❌ Failed to parse availability response:', e);
        return [];
    }
}

function buildAvailabilityMaps(availData) {
    const categoryAvlMap = {}, itemAvlMap = {};
    if (!Array.isArray(availData)) return { categoryAvlMap, itemAvlMap };
    availData.forEach(entry => {
        if (entry.avl_type === 'C') categoryAvlMap[entry.item_category?.trim()] = entry;
        else if (entry.avl_type === 'I') itemAvlMap[entry.item_category?.trim()] = entry;
    });
    return { categoryAvlMap, itemAvlMap };
}

let _cartCountTimer = null;
function debouncedUpdateCartCount() {
    clearTimeout(_cartCountTimer);
    _cartCountTimer = setTimeout(() => {
        if (typeof updateCartCount === 'function') updateCartCount();
    }, 80);
}


/**
 * After menu renders, patch any category icons that loaded with wrong/fallback src.
 * Matches preloaded URLs back to their category tab images by category code.
 */
function patchCategoryImages() {
    // Get all preloaded image URLs from <link rel="preload"> tags
    const preloadedUrls = Array.from(
        document.querySelectorAll('link[rel="preload"][as="image"]')
    ).map(l => l.href);

    if (!preloadedUrls.length) return;

    // Get raw category data which has the image URLs
    const rawMenuData =
        window.apiManager?.loadedData?.get('menuItems') ||
        window.apiManager?.loadedData?.get('MenuItems') || [];

    const rawCats = rawMenuData.flatMap(s => s.category || []);

    rawCats.forEach(cat => {
        const code = cat.category_code;
        if (!code) return;

        const rawUrl = toProxyUrl(
            cat.tqr_cat_image_url ||
            cat.tqr_image_url ||
            cat.cat_image_url ||
            cat.image_url ||
            null
        );
        if (!rawUrl) return;

        // Find the category tab button for this code
        const btn = document.querySelector(
            `.category-tab[data-category="${code}"], .subcategory-tab[data-category="${code}"]`
        );
        if (!btn) return;

        const img = btn.querySelector('.category-icon, .subcategory-icon');
        if (!img) return;

        // Only patch if currently showing fallback/wrong image
        const currentSrc = img.src || '';
        const isShowingFallback =
            currentSrc.includes('liHO-SG-Logo') ||
            currentSrc.includes('LIHO-logo') ||
            currentSrc.includes('Logo.png') ||
            currentSrc === '' ||
            img.style.display === 'none';

        if (isShowingFallback && rawUrl) {
            console.log(`🔧 Patching category image: ${code}`);
            img.style.display = '';
            img.src = rawUrl;
        }
    });
}

// ─── FIX 4: selectOrderType — non-blocking session refresh ───────────────────
// Previously awaited GetDeviceSession before starting menu load.
// Now fires it in the background and jumps straight to loadAndRenderMenu.
// Also pre-warms menu data on landing show so the tap itself is near-instant.
export async function selectOrderType(type, language = 'en') {
    window._selectStart = performance.now();
    window.isSelectingOrderType = true;
    window._pendingOrderType = type; // ← set before any awaits so isAbsorbTax can read it
    console.log('🎯 selectOrderType called:', { type, language });

    if (!type || (type !== 'T' && type !== 'E' && type !== 'Q')) {
        console.error('❌ Invalid order type:', type);
        window.isSelectingOrderType = false;
        window._pendingOrderType = null;
        return;
    }

    try {
        // ── 1. INSTANT: visual feedback + overlay fade — no awaits yet ─patchCategoryImages─────
        const selectedOption = document.querySelector(`.landing-option[data-type="${type}"]`);
        if (selectedOption) {
            selectedOption.style.transform = 'scale(0.94)';
            selectedOption.style.filter = 'brightness(0.9)';
        }

        const landingOverlay = document.getElementById('landingOverlay');
        if (landingOverlay) {
            landingOverlay.style.opacity = '0';
            setTimeout(() => {
                landingOverlay.classList.add('hidden');
                if (window.sokWebSocket) {
                    window.sokWebSocket.stopSessionTimeout();
                    window.sokWebSocket.startSessionTimeout();
                    console.log('⏱️ Session timeout started — order type selected:', type);
                }
            }, 500);
        }

        // ── 2. Fire all non-blocking work immediately ────────────────────────
        await loadgetStoreRegisterPrinter();

        fetch('/API/GetDeviceSession', {
            method: 'GET', cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
        })
            .then(async res => {
                if (!res.ok) return;
                const data = await res.json();
                const sid = data?.session_id || data?.sessionId || data?.SessionId;
                if (sid) sessionStorage.setItem('device_session_id', sid);
                console.log('✅ Device session refreshed (background)');
            })
            .catch(err => console.warn('⚠️ Device session refresh error (non-fatal):', err.message));

        // ── 3. Await init only if needed — runs while overlay is already fading
        if (!window.isInitialized && !window.isInitializing) {
            await initializeApp();
        } else if (window.isInitializing) {
            await window.initPromise;
        }

        // ── 4. Set AFTER initializeApp — restoreCacheAfterReload wipes localStorage during init
        localStorage.setItem('orderType', type);

        const serviceCharges = JSON.parse(sessionStorage.getItem('ServiceChargeJs') || '[]');
        const svcLookupType = (type === 'Q' || type === 'E') ? 'E' : 'T';
        const matchedSvc = serviceCharges.find(s => s.service_type === svcLookupType);
        sessionStorage.setItem('ServiceCharge', matchedSvc ? matchedSvc.service_value : 0);

        // service_type is just `type` here — already set in localStorage above
        const service_type = type;

        const service_type_info = SERVICE_TYPES
            ?.find(item => item?.service_type === service_type)
            ?.service_type_info;

        // isAbsorbTax reads window._pendingOrderType as fallback when
        // activeOrder.service_type and localStorage are not yet set
        const menuTaxFlag = isAbsorbTax() ? 'Y' : 'N';
        const orderStore = window.useOrderStore?.getState();
        const isColdBoot = !window._orderTypeSelected;
        const isSameType = !isColdBoot
            && orderStore?.service_type === type
            && orderStore?.sales_dtls?.length > 0;

        const getMemberInfo = () => {
            try {
                const raw = localStorage.getItem('member_info') || localStorage.getItem('memberInfo');
                return raw ? JSON.parse(raw) : null;
            } catch { return null; }
        };

        // ── 5. Build order — getNewOrderSOK is synchronous, completes immediately
        let activeOrder;

        if (isSameType) {
            console.log('♻️ Restoring existing draft');
            const m = getMemberInfo();
            activeOrder = {
                ...orderStore,
                service_type: type,
                absorb_tax: menuTaxFlag,
                customer_code: m?.customer_code || orderStore?.customer_code || '',
                customer_name: m?.name || m?.Name || orderStore?.customer_name || '',
                contact_no: m?.phone || m?.MobileNo || orderStore?.contact_no || '',
                email: m?.email || m?.Email || orderStore?.email || '',
            };
        } else {
            console.log(isColdBoot ? '❄️ Cold boot: Creating fresh order' : '🔄 Type mismatch: Wiping old data');
            localStorage.removeItem('orderId');
            localStorage.removeItem('active_cart');

            const m = getMemberInfo();
            console.log('👤 Member at order creation:', {
                found: !!m,
                customer_code: m?.customer_code,
                card_no: m?.card_no || m?.CardNo,
                name: m?.name || m?.Name,
            });

            // getNewOrderSOK is synchronous — result is ready on the next line
            activeOrder = getNewOrderSOK({
                service_type: type,
                service_type_info,
                customer_code: m?.customer_code || '',
                customer_name: m?.name || m?.Name || '',
                contact_no: m?.phone || m?.MobileNo || '',
                email: m?.email || m?.Email || '',
                card_no: m?.card_no || m?.CardNo || '',
                table_no: '',
            });

            window.useOrderStore?.setState({
                orderId: null,
                sales_dtls: [],
                net_amt: 0,
                sub_total: 0,
                total_tax: 0,
                lastSNo: 0,
                service_type: type,
                customer_code: m?.customer_code || '',
                customer_name: m?.name || m?.Name || '',
                contact_no: m?.phone || m?.MobileNo || '',
                email: m?.email || m?.Email || '',
            });
        }

        // activeOrder is fully built here — both paths above are synchronous
        window.useOrderStore?.getState().setOrder(activeOrder);
        if (!isSameType) window.useOrderStore?.getState().setLastSNo(0);
        window._orderTypeSelected = true;

        // ── 6. Fire-and-forget server sync ───────────────────────────────────
        const sanitizedSalesDtls = (activeOrder.sales_dtls || []).map(dtl => ({
            ...dtl,
            is_absorbtax: typeof dtl.is_absorbtax === 'string'
                ? (dtl.is_absorbtax === 'Y' ? 1 : parseInt(dtl.is_absorbtax) || 0)
                : (dtl.is_absorbtax ? 1 : 0),
        }));

        Promise.all([
            typeof updateOrderCacheOnServer === 'function'
                ? updateOrderCacheOnServer(activeOrder)
                    .catch(e => console.warn('⚠️ updateOrderCacheOnServer failed:', e))
                : Promise.resolve(),
            typeof syncOrderCacheToServer === 'function'
                ? syncOrderCacheToServer({
                    orderType: type,
                    status: 'N',
                    orderData: {
                        ...activeOrder,
                        sales_dtls: sanitizedSalesDtls,
                        doc_date: activeOrder.doc_date
                            || new Date().toISOString().replace('T', ' ').substring(0, 19),
                        absorb_tax: menuTaxFlag,
                        absorb_tax_info: menuTaxFlag === 'Y' ? 'Absorb Tax' : 'Not Absorb Tax',
                        service_type: type,
                        sub_total: String(activeOrder.sub_total || '0.00'),
                        total_tax: String(activeOrder.total_tax || '0.00'),
                        net_amt: String(activeOrder.net_amt || '0.00'),
                    },
                }).catch(e => console.warn('⚠️ syncOrderCacheToServer failed:', e))
                : Promise.resolve(),
        ]);

        if (typeof updateCartCount === 'function') updateCartCount();

        // ── 7. Menu load ─────────────────────────────────────────────────────
        await loadAndRenderMenu('all', language);
        await waitForMenuPaint();
        patchCategoryImages();
        hideMenuLoadingShield();

    } catch (error) {
        console.error('❌ Critical error in selectOrderType:', error);
        console.error('❌ Stack:', error?.stack);
        hideMenuLoadingShield();
        //location.reload(true);

        //// Restore landing so user can retry — don't hard reload
        //const landingOverlay = document.getElementById('landingOverlay');
        //if (landingOverlay) {
        //    landingOverlay.style.opacity = '1';
        //    landingOverlay.classList.remove('hidden');
        //}
    } finally {
        window._pendingOrderType = null; // ← clean up after function completes
        setTimeout(() => { window.isSelectingOrderType = false; }, 600);
    }
}

/**
 * Resolves only after the menu UI is fully painted:
 *  - Two requestAnimationFrame ticks (lets the browser layout + paint)
 *  - All category sidebar icons loaded
 *  - All menu item images that have started loading have finished
 *  - Web fonts settled
 */
function waitForMenuPaint() {
    return new Promise(resolve => {
        requestAnimationFrame(() => {
            requestAnimationFrame(async () => {
                try {
                    const MAX_WAIT_MS = 3000;
                    const start = performance.now();

                    // ── Step 1: Wait for category tabs to stabilize ───────────
                    let prevCatCount = -1;
                    let stableFrames = 0;
                    const STABLE_NEEDED = 3;

                    while (
                        stableFrames < STABLE_NEEDED &&
                        performance.now() - start < MAX_WAIT_MS
                    ) {
                        const catCount = document.querySelectorAll('.category-tab').length;
                        if (catCount > 0 && catCount === prevCatCount) {
                            stableFrames++;
                        } else {
                            stableFrames = 0;
                            prevCatCount = catCount;
                        }
                        await new Promise(r => requestAnimationFrame(r));
                    }

                    console.log(`✅ Categories stable: ${prevCatCount} — took ${Math.round(performance.now() - start)}ms`);
                    const afterStep1 = performance.now();

                    // ── Step 2: Wait for at least 1 menu item ─────────────────
                    let itemWaitMs = 0;
                    while (
                        document.querySelectorAll('.menu-item').length === 0 &&
                        itemWaitMs < 2000
                    ) {
                        await new Promise(r => setTimeout(r, 50));
                        itemWaitMs += 50;
                    }

                    console.log(`✅ Menu items present — step2 took ${Math.round(performance.now() - afterStep1)}ms`);
                    const afterStep2 = performance.now();

                    // ── Step 3: Only wait for ITEM images in viewport ─────────
                    await new Promise(r => setTimeout(r, 100));

                    const menuRoot = document.querySelector(
                        '#menuContainer, .menu-container, [data-menu-root], #menuGrid'
                    );

                    const viewportImgs = menuRoot
                        ? Array.from(menuRoot.querySelectorAll('img'))
                            .filter(img => {
                                if (img.complete) return false;
                                const rect = img.getBoundingClientRect();
                                return rect.top < window.innerHeight && rect.bottom > 0;
                            })
                        : [];

                    console.log(`🖼️ waitForMenuPaint: ${viewportImgs.length} viewport item images loading`);

                    const imgPromises = viewportImgs.map(img => {
                        const decodePromise = img.decode
                            ? img.decode().catch(() => { })
                            : new Promise(res => {
                                const done = () => res();
                                img.addEventListener('load', done, { once: true });
                                img.addEventListener('error', done, { once: true });
                            });
                        return Promise.race([
                            decodePromise,
                            new Promise(res => setTimeout(res, 1000))
                        ]);
                    });

                    const remaining = MAX_WAIT_MS - (performance.now() - start);
                    await Promise.race([
                        Promise.all(imgPromises),
                        new Promise(res => setTimeout(res, Math.max(remaining, 300)))
                    ]);

                    console.log(`✅ waitForMenuPaint done — step3 took ${Math.round(performance.now() - afterStep2)}ms — total ${Math.round(performance.now() - start)}ms`);

                } catch (e) {
                    console.warn('⚠️ waitForMenuPaint error (non-fatal):', e);
                }
                resolve();
            });
        });
    });
}
export function showMenuLoadingShield() {
    const shield = document.getElementById('menuLoadingShield');
    if (!shield) { console.error('menuLoadingShield not found'); return; }
    shield.style.display = 'flex';
    shield.style.opacity = '1';
}


export function hideMenuLoadingShield() {
    const shield = document.getElementById('menuLoadingShield');
    if (!shield) return;
    shield.style.transition = 'opacity 0.4s ease';
    shield.style.opacity = '0';
    setTimeout(() => { shield.style.display = 'none'; }, 400);
}

window.showMenuLoadingShield = showMenuLoadingShield;
window.hideMenuLoadingShield = hideMenuLoadingShield;

// ─── FIX 5: Pre-warm menu when landing page shows ────────────────────────────
// Call this whenever the landing overlay becomes visible (after order complete,
// on initial page load, etc.). By the time the user reads and taps, menu data
// is already in cache — the tap just triggers render, not fetch.
export function prewarmMenuOnLanding() {
    console.log('🔥 Pre-warming menu on landing show...');

    if (!apiManager.isLoaded('menuItems')) {
        loadMenuItems().catch(err => console.warn('⚠️ Menu pre-warm failed:', err.message));
    }

    // ✅ Pre-warm FullItems and expose the promise
    if (!apiManager.isLoaded('items')) {
        window._fullItemsPromise = loadItems().catch(err => {
            console.warn('⚠️ FullItems pre-warm failed:', err.message);
            return [];
        });
    } else {
        // Already loaded — expose as resolved promise for _doLoadAndRenderMenu
        window._fullItemsPromise = Promise.resolve(getFullItems());
    }

    apiManager.clearCache('stocks');
    loadStocks().catch(() => { });

    if (!window._itemAvlMapBuilt) buildItemAvlMapFromLocalStorage();
}

// Wire up landing overlay visibility — call prewarmMenuOnLanding whenever
// the landing is shown. Example usage in your order-complete flow:
//   showLandingOverlay();
//   prewarmMenuOnLanding();  // ← add this line
window.prewarmMenuOnLanding = prewarmMenuOnLanding;

const syncOrderCacheToServer = async (order) => {
    try {
        const deviceId = localStorage.getItem("sok_device_id");
        const orderType = localStorage.getItem("orderType");
        const rawStore = localStorage.getItem("storename");
        console.log(`📡 Syncing for: ${rawStore} | Device: ${deviceId}`);

        const itemCount = order?.sales_dtls?.length || order?.orderData?.sales_dtls?.length || 0;
        if (itemCount === 0) {
            console.warn("⏭️ Empty cart. Skipping sync.");
            return { success: true };
        }

        const syncUrl = `/API/SOKOrder/order-cache/sok/${deviceId}`;
        const isAlreadyWrapped = order?.orderType && order?.orderData;
        const payload = isAlreadyWrapped ? order : {
            orderType,
            orderData: {
                ...order,
                service_type: orderType,
                service_type_info: orderType === "E" ? "DineIn" : "Takeaway",
                sub_total: String(order.sub_total || "0.00"),
                total_tax: String(order.total_tax || "0.00"),
                net_amt: String(order.net_amt || "0.00"),
                sales_dtls: (order.sales_dtls || []).map(dtl => ({
                    ...dtl,
                    is_absorbtax: typeof dtl.is_absorbtax === 'string'
                        ? (dtl.is_absorbtax === "Y" ? 1 : parseInt(dtl.is_absorbtax) || 0)
                        : (dtl.is_absorbtax ? 1 : 0)
                }))
            },
            status: "N"
        };

        const response = await fetch(syncUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ Sync failed (${response.status}): ${errorText}`);
            return { success: false };
        }
        console.log("✅ Sync successful");
        return await response.json();
    } catch (err) {
        console.error("💥 Sync Error:", err);
        return { success: false };
    }
};

// ─── FIX 6: loadAndRenderMenu — promise-based lock instead of silent drop ────
// Previously: if isMenuLoading → silent return → UI looks frozen on double-tap.
// Now: second call joins the first load promise instead of being dropped.
let _menuLoadPromise = null;
let _menuLoadActive = false;

export async function loadAndRenderMenu(category = 'all', language = '') {
    console.log('🔄 loadAndRenderMenu called with:', { category, language });

    if (_menuLoadActive && _menuLoadPromise) {
        console.log('⏳ Menu already loading — joining existing promise');
        return _menuLoadPromise;
    }

    _menuLoadActive = true;
    _menuLoadPromise = _doLoadAndRenderMenu(category, language)
        .finally(() => {
            _menuLoadActive = false;
            _menuLoadPromise = null;
        });

    return _menuLoadPromise;
}

const toProxyUrl = (raw) => {
    if (!raw?.trim()) return null;
    // Already a proxy/absolute URL — never double-encode
    if (raw.startsWith('http') || raw.startsWith('data:') || raw.toLowerCase().startsWith('/api/')) {
        return raw;
    }
    return raw.startsWith('public/upload/')
        ? `/api/GetImageProxy?imageUrl=${encodeURIComponent(raw)}`
        : raw;
};

async function _doLoadAndRenderMenu(category, language) {
    try {
        const isWarmBoot = !!window.__isWarmBoot;
        let menuData = apiManager.loadedData?.get('menuItems') || apiManager.loadedData?.get('MenuItems');

        if (!menuData) {
            console.log('📦 Menu not in apiManager, checking sessionStorage...');
            await loadMenuItems();
            menuData = apiManager.loadedData.get('menuItems');
        }

        if (!menuData || menuData.length === 0) {
            if (!isWarmBoot) {
                console.log('📡 Menu not available, loading from server...');
                await loadMenuItems();
                menuData = apiManager.loadedData.get('menuItems');
            } else {
                throw new Error('Menu data missing even after warm-boot restore');
            }
        }

        if (!menuData || menuData.length === 0) throw new Error('No menu data available');

        console.log('✅ Using menu data:', {
            source: isWarmBoot ? 'warm-boot-cache' : 'cache/session/server',
            count: menuData.length
        });

        const allItems = menuData.flatMap(section => section.items || []);

        // ── Set menu items in cache FIRST so buildVisibleCategories works ─────
        const cache = useCache();
        cache.setMenuItems(menuData);

        // ── Shared helpers ────────────────────────────────────────────────────


        const existingPreloads = new Set(
            Array.from(document.querySelectorAll('link[rel="preload"][as="image"]'))
                .map(l => l.href)
        );

        const addPreload = (url, priority) => {
            if (!url || existingPreloads.has(url)) return;
            const link = document.createElement('link');
            link.rel = 'preload';
            link.as = 'image';
            link.href = url;
            link.fetchPriority = priority;
            document.head.appendChild(link);
            existingPreloads.add(url);
        };


        window._categoryImageMap = new Map();
        try {
            const tempCategories = (menuData[0]?.category || [])
                .filter(cat => cat.hide_from_tqr !== '1');

            tempCategories.forEach(cat => {
                // ✅ Try every possible field name
                const rawUrl =
                    cat.tqr_cat_image_url ||
                    cat.tqr_image_url ||
                    cat.cat_image_url ||
                    cat.image_url ||
                    cat.category_image ||
                    cat.icon_url ||
                    cat.img ||
                    // Check all string fields for image-like values
                    Object.values(cat).find(v =>
                        typeof v === 'string' && (
                            v.includes('public/upload/') ||
                            v.includes('.png') ||
                            v.includes('.jpg') ||
                            v.includes('.jpeg') ||
                            v.includes('.webp')
                        )
                    );

                const url = toProxyUrl(rawUrl);
                if (!url) return;

                addPreload(url, 'high');

                // ✅ Store for populateCategoryTabsWorkFlow to use
                const code = cat.category_code;
                if (code) {
                    window._categoryImageMap.set(code, url);
                    window._categoryImageMap.set(code.trim().toLowerCase(), url);
                }
            });

            console.log(`🖼️ Category preloads fired: ${existingPreloads.size} URLs`);
            console.log(`🗂️ _categoryImageMap built: ${window._categoryImageMap.size} entries`);
        } catch (e) {
            console.warn('⚠️ Category preload failed (non-fatal):', e);
        }

        // ── NOW wait for FullItems — category images already fetching ─────────
        const getFullItems = () =>
            useCache()?.items
            || window.apiManager?.loadedData?.get('FullItems')
            || window.apiManager?.loadedData?.get('items')
            || [];

        let fullItems = getFullItems();

        if (!fullItems.length) {
            if (window._fullItemsPromise) {
                // ✅ Join the already-in-flight or already-resolved promise from initializeApp
                // If already resolved (cold boot completed): instant, no network cost
                // If still in-flight (user tapped very fast): waits for it naturally
                console.log('⏳ Joining existing _fullItemsPromise...');
                const waitStart = Date.now();
                const result = await Promise.race([
                    window._fullItemsPromise,
                    new Promise(res => setTimeout(() => res([]), 15000))
                ]);
                fullItems = result?.length ? result : getFullItems();
                console.log(`✅ FullItems via promise: ${fullItems.length} items in ${Date.now() - waitStart}ms`);
            } else {
                // ✅ Fallback: start fresh poll (shouldn't happen after initializeApp fix)
                console.warn('⚠️ _fullItemsPromise not set — falling back to poll');
                const waitStart = Date.now();
                fullItems = await new Promise(resolve => {
                    const poll = setInterval(() => {
                        const items = getFullItems();
                        if (items.length) {
                            clearInterval(poll);
                            console.log(`✅ FullItems polled after ${Date.now() - waitStart}ms`);
                            resolve(items);
                            return;
                        }
                        if (Date.now() - waitStart >= 15000) {
                            clearInterval(poll);
                            console.warn('⚠️ FullItems poll timeout');
                            resolve([]);
                        }
                    }, 150);
                });
            }
        }

        // ── Enrich with FullItems data ────────────────────────────────────────
        const enrichedItems = fullItems.length
            ? (() => {
                const fullItemMap = new Map(fullItems.map(fi => [fi.item_no, fi]));
                return allItems.map(menuItem => {
                    const fullItem = fullItemMap.get(menuItem.item_no);
                    if (!fullItem) return menuItem;
                    return {
                        ...menuItem,
                        itemmaster_menutype_grpdtls: fullItem.itemmaster_menutype_grpdtls?.length
                            ? fullItem.itemmaster_menutype_grpdtls
                            : (menuItem.itemmaster_menutype_grpdtls || []),
                        itemmaster_menutypedtls: fullItem.itemmaster_menutypedtls?.length
                            ? fullItem.itemmaster_menutypedtls
                            : (menuItem.itemmaster_menutypedtls || []),
                        selling_uom_dtls: fullItem.selling_uom_dtls?.length
                            ? fullItem.selling_uom_dtls
                            : (menuItem.selling_uom_dtls || []),
                    };
                });
            })()
            : allItems;

        console.log('✅ Menu items enriched:', {
            total: enrichedItems.length,
            withModifiers: enrichedItems.filter(i => i.itemmaster_menutype_grpdtls?.length > 0).length,
            fullItemsAvailable: fullItems.length,
        });

        window.menuGridItems = enrichedItems;
        requestIdleCallback?.(() => {
            enrichedItems.forEach(item => {
                const url = toProxyUrl(item.tqr_image_url || item.item_image || item.image);
                if (url) poolImage(url);
            });
            console.log(`🖼️ Image pool warmed: ${_decodedImagePool.size} images`);
        }, { timeout: 5000 });
        // ── POST-ENRICHMENT: Preload first 18 item images ─────────────────────
        // tqr_image_url comes from FullItems — must run after enrichment.
        // 18 = 2 full rows of 3 columns × 3 visible rows on kiosk viewport.
        try {
            const itemPreloadUrls = [];
            for (const item of enrichedItems) {
                if (itemPreloadUrls.length >= 18) break;
                const url = toProxyUrl(item.tqr_image_url || item.item_image || item.image);
                if (!url) continue;
                itemPreloadUrls.push(url);
                addPreload(url, itemPreloadUrls.length <= 3 ? 'high' : 'auto');
            }
            preloadImages(itemPreloadUrls, 'high');
            console.log(`🖼️ Item preloads fired: ${itemPreloadUrls.length} URLs (post-enrichment)`);
            console.log(`🖼️ Total preloads: ${existingPreloads.size} URLs`);
        } catch (e) { /* non-fatal */ }

        // ── Price cache ───────────────────────────────────────────────────────
        const cacheFingerprint = enrichedItems.length;
        if (!window._lowestPriceCache
            || window._lowestPriceCache.size === 0
            || window._lowestPriceCacheFor !== cacheFingerprint) {

            const lowestPriceCache = new Map();
            enrichedItems.forEach(item => {
                if (Array.isArray(item.itemmaster_menutype_grpdtls)
                    && item.itemmaster_menutype_grpdtls.length > 0) {
                    lowestPriceCache.set(item.item_no, getLowestModifierPrice(item));
                }
            });
            window._lowestPriceCache = lowestPriceCache;
            window._lowestPriceCacheFor = cacheFingerprint;
            console.log('💰 Price cache pre-built from all items:', lowestPriceCache.size);
        }

        // ── Render tabs ───────────────────────────────────────────────────────
        const categories = buildVisibleCategories?.() || [];
        if (categories.length === 0) throw new Error('No categories found');

        // ── PRELOAD: now we know exactly which categories will render ─────────
        try {
            categories.forEach((cat) => {
                const url = toProxyUrl(cat.tqr_cat_image_url || cat.tqr_image_url);
                if (url) addPreload(url, 'high');
            });
        } catch (e) { /* non-fatal */ }

        populateCategoryTabs?.(categories);
        await waitForMenuGridReady();

        console.log('✅ loadAndRenderMenu completed successfully');

    } catch (error) {
        console.error('❌ Error in loadAndRenderMenu:', error);
        throw error;
    }
}

function waitForMenuGridReady(timeout = 6000) {
    return new Promise((resolve) => {
        const start = Date.now();

        // First, log what's actually in the DOM so we can find the right selector
        const debugSelectors = [
            '.menu-item-card',
            '.menu-grid-item',
            '[data-item-no]',
            '.menu-item',
            '.item-card',
            '.grid-item',
            '.product-card',
        ];

        const check = () => {
            // Debug: log first passing selector
            for (const sel of debugSelectors) {
                const found = document.querySelectorAll(sel);
                if (found.length > 0) {
                    console.log(`✅ waitForMenuGridReady: found ${found.length} via "${sel}"`);
                    return resolve();
                }
            }

            if (Date.now() - start >= timeout) {
                console.warn('⚠️ waitForMenuGridReady timed out — check selector');
                // Log everything in the menu container to find the right class
                const menuContainer = document.querySelector(
                    '#menuGrid, #menu-grid, .menu-grid, #menuContainer, #itemGrid, #menuContent'
                );
                if (menuContainer) {
                    const children = menuContainer.children;
                    if (children.length > 0) {
                        console.log('🔍 Menu container children classes:',
                            Array.from(children).slice(0, 3).map(el => el.className)
                        );
                    }
                }
                return resolve();
            }

            requestAnimationFrame(check);
        };

        requestAnimationFrame(check);
    });
}

async function renderCategoryItems(categoryName, menuData) {
    const categoryItems = [];
    for (const section of menuData) {
        if (section.category && Array.isArray(section.category)) {
            const matchingCategory = section.category.find(cat => cat.name === categoryName || cat.cat_name === categoryName);
            if (matchingCategory && section.items) {
                categoryItems.push(...section.items.filter(item => item.cat_name === categoryName || item.category === categoryName));
            }
        }
        if (section.items) {
            section.items.forEach(item => {
                if ((item.cat_name === categoryName || item.category === categoryName) && !categoryItems.find(ci => ci.item_no === item.item_no)) {
                    categoryItems.push(item);
                }
            });
        }
    }
    if (typeof renderMenuGrid === 'function') renderMenuGrid(categoryItems);
    else renderSimpleMenuGrid(categoryItems);
}

function renderSimpleMenuGrid(items) {
    const menuGrid = document.getElementById('menuGrid');
    if (!menuGrid) return;
    menuGrid.innerHTML = items.map(item => `
        <div class="menu-item-card" data-item-no="${item.item_no}">
            <div class="menu-item-image">
                <img src="${item.tqr_image_url || '/img/placeholder.png'}" alt="${item.name || item.item_name}" onerror="this.src='/img/placeholder.png'">
            </div>
            <div class="menu-item-details">
                <h3 class="menu-item-name">${item.name || item.item_name}</h3>
                <p class="menu-item-price">${item.price || '0.00'}</p>
            </div>
        </div>
    `).join('');
}

window.debugAppState = function () {
    const cache = useCache();
    const order = useOrder();
    console.log('📊 Cache:', { menuItems: cache.menuItems?.length || 0, items: cache.items?.length || 0, addons: cache.addons?.length || 0 });
    console.log('📦 Order:', order);
    return { cache, order, categories: buildVisibleCategories() };
};

window.forceReloadCategories = function () {
    const menuData = apiManager.loadedData.get('menuItems');
    if (menuData?.length) {
        window.menuGridItems = menuData.flatMap(s => s.items || []);
    }
    const categories = buildVisibleCategories();
    if (categories?.length) populateCategoryTabs(categories);
};

function validateCacheBeforeRender() {
    const cache = useCache();
    if (!cache.menuItems?.length) {
        console.warn('⚠️ Cache invalid, forcing reload');
        apiManager.clearCache('menuItems');
        apiManager.clearCache('items');
        return false;
    }
    return true;
}

async function loadImageWithRetry(imageUrl, fallbackUrl, retries = 2) {
    for (let i = 0; i < retries; i++) {
        try {
            const result = await loadImageWithValidation(imageUrl, fallbackUrl, 2000);
            if (result === imageUrl) return imageUrl;
            await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)));
        } catch (error) {
            console.warn(`Image load attempt ${i + 1} failed:`, error);
        }
    }
    return fallbackUrl;
}

function createImageElement(imageUrl, altText, restaurantLogo) {
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = altText;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onload = function () { this.classList.add('loaded'); };
    img.onerror = function () {
        if (this.src !== restaurantLogo) this.src = restaurantLogo;
        else this.style.display = 'none';
    };
    return img;
}

function displayMenuItemsByCategoryCode(categoryCode) {
    const container = document.getElementById('menuGrid');
    if (!container) return;
    const seen = new Set();
    const items = menuItems
        .filter(item => item.category_code === categoryCode)
        .filter(item => { if (!item?.item_no || seen.has(item.item_no)) return false; seen.add(item.item_no); return true; });
    if (items.length === 0) { container.innerHTML = '<p class="text-gray-500">No items in this category.</p>'; return; }
    renderMenuGrid(items);
}

function sortItemsByMobileSticky(items) {
    if (!items?.length) return items;
    const sticky = [], regular = [];
    items.forEach(item => {
        const isSticky = item.mobile_is_sticky === "1" || item.mobile_is_sticky === 1 || item.mobile_is_sticky === true ||
            item.is_sticky_mobile === "1" || item.is_sticky_mobile === 1;
        if (isSticky) sticky.push({ ...item, _isSticky: true });
        else regular.push({ ...item, _isSticky: false });
    });
    return [...sticky, ...regular];
}

async function renderSubcategorySection(subcategoryCode, selectedLanguage, parentContainer) {
    try {
        const translatedSubcategoryName = await getTranslatedName(subcategoryCode, subcategoryCode, selectedLanguage, "category");
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'subcategory-header collapsible-header';
        sectionHeader.dataset.subcategory = subcategoryCode;
        sectionHeader.style.cssText = `background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:16px 20px;margin:20px 0 16px 0;border-radius:8px;font-size:20px;font-weight:600;box-shadow:0 2px 4px rgba(0,0,0,0.1);cursor:pointer;user-select:none;display:flex;justify-content:space-between;align-items:center;transition:all 0.3s ease;`;
        sectionHeader.innerHTML = `<span>${translatedSubcategoryName}</span><svg class="collapse-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transition:transform 0.3s ease;"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
        parentContainer.appendChild(sectionHeader);

        const sectionContainer = document.createElement('div');
        sectionContainer.className = 'subcategory-section menu-grid';
        sectionContainer.style.cssText = `display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1.5rem;margin-bottom:2rem;transition:all 0.3s ease;overflow:hidden;`;
        sectionContainer.dataset.subcategory = subcategoryCode;
        parentContainer.appendChild(sectionContainer);

        sectionHeader.addEventListener('click', function () {
            const isCollapsed = sectionContainer.classList.contains('collapsed');
            const icon = this.querySelector('.collapse-icon');
            if (isCollapsed) {
                sectionContainer.classList.remove('collapsed');
                sectionContainer.style.maxHeight = sectionContainer.scrollHeight + 'px';
                icon.style.transform = 'rotate(0deg)';
                setTimeout(() => { sectionContainer.style.maxHeight = 'none'; }, 300);
            } else {
                sectionContainer.style.maxHeight = sectionContainer.scrollHeight + 'px';
                sectionContainer.offsetHeight;
                sectionContainer.style.maxHeight = '0';
                sectionContainer.classList.add('collapsed');
                icon.style.transform = 'rotate(-90deg)';
            }
        });

        await renderItemsForCategory(subcategoryCode, selectedLanguage, sectionContainer, true);

        if (sectionContainer.children.length > 0) {
            const isMobile = window.innerWidth <= 768;
            if (isMobile) {
                sectionContainer.classList.add('collapsed');
                sectionContainer.style.maxHeight = '0';
                const icon = sectionHeader.querySelector('.collapse-icon');
                if (icon) icon.style.transform = 'rotate(-90deg)';
            } else {
                sectionContainer.style.maxHeight = 'none';
            }
        }
    } catch (error) {
        console.error(`Error rendering subcategory ${subcategoryCode}:`, error);
    }
}

function normalizeMenuItem(item) {
    if (!item) return item;
    const n = { ...item };
    if (typeof n.itemmaster_menutype_grpdtls === 'string') n.itemmaster_menutype_grpdtls = [];
    if (typeof n.itemmaster_menutypedtls === 'string') n.itemmaster_menutypedtls = [];
    if (typeof n.itemmaster_menutype === 'string') n.itemmaster_menutype = [];
    if (typeof n.level_menu_button_dtls === 'string') n.level_menu_button_dtls = [];
    return n;
}

async function createMenuItemElement(item) {
    const itemDiv = document.createElement('div');

    let MenuItems = [];
    try {
        const cached = getMenuItems();
        console.log('🔍 First section keys:', Object.keys(cached?.[0] || {}));
        console.log('🔍 First section sample:', cached?.[0]);
        if (Array.isArray(cached)) MenuItems = cached.flatMap(cat => cat.items || []);
    } catch (err) { console.error("Failed to retrieve MenuItems:", err); }

    const menuItem = MenuItems.find(mi => mi.item_no === item.item_no);

    // ← Single source of truth for display name
    const displayName = menuItem?.item_desc || menuItem?.item_name || item.item_desc || item.item_no;

    itemDiv.className = 'menu-item p-4 border rounded shadow';
    itemDiv.dataset.itemName = displayName;  // ← fix (was item.item_name)

    const imageUrl = resolveImageUrl(item, menuItem);
    const restaurantLogo = RESTAURANT_CONFIG.logo || '';
    const hasMenuTypeGrpDtls = Array.isArray(item.itemmaster_menutype_grpdtls) ? item.itemmaster_menutype_grpdtls.length > 0 : Boolean(item.itemmaster_menutype_grpdtls);
    const priceObj = item?.selling_uom_dtls?.[0]?.price_dtls?.[0] || item;
    //const priceValue = hasMenuTypeGrpDtls ? null : parseFloat(getPriceByServiceType(priceObj));
    //const displayPrice = !isNaN(priceValue) && priceValue > 0 ? `$${priceValue.toFixed(2)}` : '';
    // ✅ Always use selling_uom_dtls price — for combos this is the bundle price ($19.90)
    const priceValue = parseFloat(getPriceByServiceType(priceObj));
    const displayPrice = !isNaN(priceValue) && priceValue > 0 ? `$${priceValue.toFixed(2)}` : '';
    const allergenUrl = resolveAllergenImageUrl(item, menuItem);
    const nutritionUrl = resolveNutritionImageUrl(item, menuItem);
    const allergenBadge = allergenUrl ? `<img src="${allergenUrl}" alt="Allergen information" class="allergen-badge" style="width:32px;height:32px;object-fit:contain;padding:4px;border-radius:6px;" onerror="this.style.display='none';">` : '';
    const nutritionBadge = nutritionUrl ? `<img src="${nutritionUrl}" alt="Nutrition information" class="nutrition-badge" style="position:absolute;bottom:8px;right:1px;width:40px;height:40px;object-fit:contain;padding:4px;border-radius:6px;z-index:10;" onerror="this.style.display='none';">` : '';

    itemDiv.innerHTML = `
        <div class="item-image">
            <div class="image-wrapper" style="position:relative;width:100%;height:100%;background:#f0f0f0;border-radius:var(--radius-md);overflow:hidden;">
                <img src="${imageUrl}" alt="${displayName}" fetchpriority="high" decoding="async" loading="eager"
                    style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius-md);display:block;"
                    onload="this.classList.add('loaded'); this.parentElement.classList.remove('image-loading');"
                    onerror="this.onerror=null;if(this.src!=='${restaurantLogo}')this.src='${restaurantLogo}';" class="loaded">
                ${nutritionBadge}
            </div>
        </div>
        <div class="item-info" style="position:relative;">
            <h3 class="font-semibold">${displayName}</h3>
            <div style="display:flex;align-items:flex-start;gap:8px;">
                ${allergenBadge ? `<div style="flex-shrink:0;display:flex;align-items:center;">${allergenBadge}</div>` : ''}
            </div>
            <div class="item-footer flex justify-between items-center mt-2">
                <span class="item-price font-bold ${hasMenuTypeGrpDtls ? 'invisible' : ''}">${displayPrice}</span>
                <button class="add-btn bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded w-full max-w-[100px]" data-item-id="${item.item_no}">Add to Cart</button>
            </div>
        </div>
    `;

    const addBtn = itemDiv.querySelector('.add-btn');
    if (addBtn) addBtn.addEventListener('click', (e) => { e.stopPropagation(); addToCart(item.item_no); });
    return itemDiv;
}


const imagePreloadMap = new Map();

export function resolveImageUrl(item, menuItem) {
    const menuItemSafe = menuItem || item;
    let imageFilename = item.tqr_image_url || item.item_image || item.image ||
        menuItemSafe.tqr_image_url || menuItemSafe.item_image || menuItemSafe.image || '';
    if (!imageFilename) return RESTAURANT_CONFIG.logo || '';
    imageFilename = imageFilename.split('?')[0];
    if (imageFilename.startsWith('http')) {
        try {
            const url = new URL(imageFilename);
            imageFilename = url.pathname.replace(/^\/liho\//, '');
        } catch { console.warn('⚠️ Invalid URL:', imageFilename); }
    }
    imageFilename = imageFilename.replace(/^\/+/, '');
    if (imageFilename.startsWith('public/upload/')) return `/api/GetImageProxy?imageUrl=${encodeURIComponent(imageFilename)}`;
    return `${RESTAURANT_CONFIG.baseImageUrl}${imageFilename}`;
}

export function getSmartImageUrl(item) {
    if (item.tqr_image_url || item.item_image || item.image) return resolveImageUrl(item);
    const idKey = String(item.item_no || item.product_code || '');
    const nameKey = (item.item_desc || item.item_name || '').trim().toLowerCase();
    if (window.globalImageMap) {
        const cachedUrl = window.globalImageMap.get(idKey) || window.globalImageMap.get(nameKey);
        if (cachedUrl) return cachedUrl;
    }
    return RESTAURANT_CONFIG?.logo || '/img/LIHO-logo.jpg';
}

function preloadImages(urls, priority = 'high') {
    urls.forEach(url => {
        if (!url || imagePreloadMap.has(url)) return;
        const img = new Image();
        img.fetchPriority = priority;
        img.decoding = 'async';
        const loadPromise = new Promise((resolve) => {
            img.onload = () => { imagePreloadMap.set(url, { loaded: true, success: true, image: img }); resolve({ url, success: true }); };
            img.onerror = () => { imagePreloadMap.set(url, { loaded: true, success: false }); resolve({ url, success: false }); };
        });
        imagePreloadMap.set(url, { image: img, promise: loadPromise, loaded: false });
        img.src = url;
    });
}

function resolveAllergenImageUrl(item, menuItem) {
    let f = item.tqr_alergin_type || item.tqr_allergen_image || menuItem?.tqr_alergin_type || menuItem?.tqr_allergen_image || '';
    if (!f?.trim()) return '';
    if (f.startsWith('http') || f.startsWith('blob:') || f.startsWith('/')) return f;
    const clean = f.split('?')[0];
    return clean.startsWith('public/upload/') ? `/api/GetImageProxy?imageUrl=${encodeURIComponent(clean)}` : `${RESTAURANT_CONFIG.baseImageUrl}${clean}`;
}

function loadImageWithValidation(imageUrl, fallbackUrl, timeout = 5000) {
    return new Promise((resolve) => {
        const cached = imagePreloadMap.get(imageUrl);
        if (cached?.loaded && cached?.success) { resolve(imageUrl); return; }
        const img = new Image();
        let resolved = false;
        const timer = setTimeout(() => { if (!resolved) { resolved = true; resolve(fallbackUrl); } }, timeout);
        img.onload = () => { if (!resolved) { resolved = true; clearTimeout(timer); resolve(imageUrl); } };
        img.onerror = () => { if (!resolved) { resolved = true; clearTimeout(timer); resolve(fallbackUrl); } };
        img.src = imageUrl;
    });
}

function isImagePreloaded(url) { return imagePreloadMap.get(url)?.loaded || false; }

function extractImageUrls(items, MenuItems) {
    const urls = new Set();
    items.forEach(item => {
        const menuItem = MenuItems.find(mi => mi.item_no === item.item_no);
        const imageUrl = resolveImageUrl(item, menuItem);
        if (imageUrl) urls.add(imageUrl);
    });
    return Array.from(urls);
}

function loadImageWithFastFallback(imageUrl, fallbackUrl, timeout = 300) {
    return new Promise((resolve) => {
        const img = new Image();
        let resolved = false;
        const timer = setTimeout(() => { if (!resolved) { resolved = true; resolve(fallbackUrl); } }, timeout);
        img.onload = () => { if (!resolved) { resolved = true; clearTimeout(timer); resolve(imageUrl); } };
        img.onerror = () => { if (!resolved) { resolved = true; clearTimeout(timer); resolve(fallbackUrl); } };
        img.src = imageUrl;
    });
}

function addPreloadLinks(items, MenuItems) {
    const head = document.head;
    const existing = new Set(Array.from(document.querySelectorAll('link[rel="preload"][as="image"]')).map(l => l.href));
    extractImageUrls(items.slice(0, 6), MenuItems).forEach(imageUrl => {
        if (imageUrl && !existing.has(imageUrl)) {
            const link = document.createElement('link');
            link.rel = 'preload'; link.as = 'image'; link.href = imageUrl; link.fetchPriority = 'high';
            head.appendChild(link);
        }
    });
}

function resolveNutritionImageUrl(item, menuItem) {
    let f = item.tqr_nutrition_type || menuItem?.tqr_nutrition_type || '';
    if (!f?.trim()) return '';
    if (f.startsWith('http') || f.startsWith('blob:') || f.startsWith('/')) return f;
    const clean = f.split('?')[0];
    return clean.startsWith('public/upload/') ? `/api/GetImageProxy?imageUrl=${encodeURIComponent(clean)}` : `${RESTAURANT_CONFIG.baseImageUrl}${clean}`;
}

function clearImagePreloadCache() { imagePreloadMap.clear(); }
function getPreloadStats() {
    const total = imagePreloadMap.size;
    const loaded = Array.from(imagePreloadMap.values()).filter(e => e.loaded).length;
    return { total, loaded, pending: total - loaded };
}

export function getTranslatedName(itemNo, fallbackName, language, type = "item") {
    const { menuCategoryItemTranslations } = useCache();
    const translations = Array.isArray(menuCategoryItemTranslations) ? menuCategoryItemTranslations : [];
    const trimmedCode = itemNo?.toString().trim().toLowerCase();
    let translation;
    if (type === "item") translation = translations.find(t => t.item_no?.toString().trim().toLowerCase() === trimmedCode);
    else if (type === "category") translation = translations.find(t => t.category_code?.toString().trim().toLowerCase() === trimmedCode);
    if (translation?.item_name_lang?.trim()) return translation.item_name_lang;
    if (translation?.category_name_lang?.trim()) return translation.category_name_lang;
    return fallbackName;
}

async function loadMenu(language) {
    const { menuCategoryItemTranslations, setMenuCategoryItemTranslations } = useCache();
    if (!menuCategoryItemTranslations?.length) {
        const res = await fetch(`/API/GetMenuCategoryItemTranslations?languageName=${encodeURIComponent(language)}`);
        const json = await res.json();
        setMenuCategoryItemTranslations(json || []);
    }
}

window.getAddonsByName = function (itemName) {
    const items = useCache().items || [];
    if (!items.length) { alert("No items loaded."); return; }
    const item = items.find(i => i.item_name?.trim() === itemName.trim());
    if (!item) { alert("Item not found."); return; }
    if (item.is_addon_enable?.toUpperCase() === "Y") alert(`Add-ons available for "${itemName}"`);
    else alert(`No add-ons available for "${itemName}"`);
};

const categoryStateMap = new Map();
const categoryElementMap = new Map();

function buildCategoryHierarchy(categories) {
    const hierarchyMap = new Map();
    categories.forEach(cat => {
        const root = cat.root_category_code;
        if (!hierarchyMap.has(root)) hierarchyMap.set(root, []);
        hierarchyMap.get(root).push(cat);
    });
    return hierarchyMap;
}

function getCachedItems() {
    try { return useCache().items || []; }
    catch (e) { return []; }
}

function isWithinMenuTimeWindow(item) {
    // If no time windows are defined, default to showing the item
    if (!item.start_time || !item.end_time) return true;

    try {
        const now = new Date();
        const currentHms = [
            String(now.getHours()).padStart(2, '0'),
            String(now.getMinutes()).padStart(2, '0'),
            String(now.getSeconds()).padStart(2, '0')
        ].join(':'); // Yields exact current time string like "17:02:45"

        // Lexicographical string comparison works flawlessly on zero-padded "HH:mm:ss" strings
        if (currentHms < item.start_time || currentHms > item.end_time) {
            console.warn(`⏰ [Time-Gate] Hiding ${item.item_name || item.sku_no}: Kiosk time (${currentHms}) is outside menu window (${item.start_time} - ${item.end_time})`);
            return false;
        }

        return true;
    } catch (err) {
        console.error('⚠️ Error validating item time signature:', err);
        return true; // Fallback to safe true so a clock glitch doesn't wipe the menu
    }
}

// ─── FIX 7: shouldShowItem — single map build, never per-item ────────────────
// window._itemAvlMapBuilt prevents repeated rebuild calls across 335+ items.
// The map is built once at startup and once on warm boot (see initializeApp).
function shouldShowItem(item) {
    if (!item) return false;
    if (!isWithinMenuTimeWindow(item)) return false;

    const itemNo = item.item_no?.trim();
    const skuNo = item.sku_no?.trim();
    const currentOrderType = localStorage.getItem('orderType');
    if (item.hide_from_tqr === 'Y' || item.hide_from_tqr === '1') return false;

    if (!window._itemAvlMapBuilt) buildItemAvlMapFromLocalStorage();

    let avlRecord = null;
    if (itemNo && window.itemAvlMap?.[itemNo]) {
        avlRecord = window.itemAvlMap[itemNo];
    } else if (skuNo && window.itemAvlMap?.[skuNo]) {
        avlRecord = window.itemAvlMap[skuNo];
    }

    // is_emenu_disable applies universally across all order types, so it's
    // checked as an OR across both sources — either one flagging disabled
    // is enough to hide the item. No fallback/override priority between
    // avlRecord and the item's own field; both must agree it's enabled.
    const isDisabled =
        item.is_emenu_disable === 'Y' || item.is_emenu_disable === '1' ||
        avlRecord?.is_emenu_disable === 'Y';
    if (isDisabled) return false;

    // Same OR treatment for is_soldout, for the same reason.
    const isSoldOut =
        item.is_soldout === 'Y' || item.is_soldout === '1' ||
        avlRecord?.is_soldout === 'Y';
    if (isSoldOut) return false;

    if (currentOrderType === 'E' && (item.hide_item_dinein === 'Y' || item.hide_item_dinein === '1')) return false;
    if (currentOrderType === 'T' && (item.hide_item_takeaway === 'Y' || item.hide_item_takeaway === '1')) return false;

    return true;
}

function categoryHasVisibleItems(categoryCode, items) {
    const allMenuItems = items || window.menuGridItems || useCache()?.items || [];
    if (!allMenuItems?.length) return true;
    const code = categoryCode.trim().toLowerCase();
    return allMenuItems.some(item => (item.category_code || '').trim().toLowerCase() === code && shouldShowItem(item));
}

function categoryTreeHasItems(categoryCode, hierarchyMap, allItems, shouldFilter) {
    if (!shouldFilter) return true;
    if (categoryHasVisibleItems(categoryCode, allItems)) return true;
    const subcategories = hierarchyMap.get(categoryCode) || [];
    return subcategories.some(subCat => subCat.category_code !== 'MAIN' && categoryHasVisibleItems(subCat.category_code, allItems));
}

function filterVisibleCategories(categories, hierarchyMap, allItems, shouldFilter) {
    const visibleOnly = categories.filter(cat => String(cat.hide_from_tqr) !== "1");
    if (!shouldFilter) return visibleOnly;
    return visibleOnly.filter(cat => categoryTreeHasItems(cat.category_code, hierarchyMap, allItems, shouldFilter));
}

function getVisibleSubcategories(categoryCode, hierarchyMap, items) {
    const resolvedItems = items || window.menuGridItems || useCache()?.items || [];
    const shouldFilter = resolvedItems.length > 0;
    const subcategories = hierarchyMap[categoryCode] || [];
    return subcategories
        .filter(subCat => {
            if (subCat.category_code === 'MAIN') return false;
            if (subCat.hide_from_tqr === 'Y' || subCat.hide_from_tqr === '1') return false;
            if (!shouldFilter) return true;
            return categoryHasVisibleItems(subCat.category_code, resolvedItems);
        })
        .sort((a, b) => {
            const seqA = a.tqr_seq_no || 0, seqB = b.tqr_seq_no || 0;
            if (seqA === 0 && seqB !== 0) return 1;
            if (seqB === 0 && seqA !== 0) return -1;
            return seqA - seqB;
        });
}

function createCategoryButton(category, isActive, isSubcategory, selectedLanguage = "", categoryImageMap = new Map(), categoryIndex = 0) {
    const btn = document.createElement('button');
    btn.className = `${isSubcategory ? 'subcategory-tab' : 'category-tab'}${isActive ? ' active' : ''}`;
    btn.dataset.category = category.category_code;

    const container = document.createElement('div');
    container.className = isSubcategory ? 'subcategory-tab-container' : 'category-tab-container';

    const rawCatImage = category.tqr_cat_image_url || category.tqr_image_url
        || categoryImageMap?.get(category.category_code)
        || categoryImageMap?.get(category.category_code?.trim().toLowerCase());

    const img = document.createElement('img');
    img.alt = category.category_name || category.category_code;
    img.className = isSubcategory ? 'subcategory-icon' : 'category-icon';
    // ── Always eager — sidebar is always on screen, lazy defers these needlessly
    img.loading = 'eager';
    img.decoding = 'async';
    // First 3 categories get high priority, rest auto
    img.fetchPriority = 'high';

    if (rawCatImage?.trim()) {
        img.src = toProxyUrl(rawCatImage) || RESTAURANT_CONFIG.logo;

        img.onerror = function () {
            if (RESTAURANT_CONFIG.logo && this.src !== RESTAURANT_CONFIG.logo) {
                this.src = RESTAURANT_CONFIG.logo;
            } else {
                this.style.display = 'none';
            }
        };
    } else {
        img.src = RESTAURANT_CONFIG.logo;
        img.onerror = function () { this.style.display = 'none'; };
    }

    container.appendChild(img);

    const nameSpan = document.createElement('span');
    nameSpan.className = isSubcategory ? 'subcategory-name' : 'category-name';
    nameSpan.textContent = (selectedLanguage && typeof getTranslatedName === 'function')
        ? getTranslatedName(category.category_code, category.category_name, selectedLanguage, 'category')
        : (category.category_name || category.category_code || '');

    container.appendChild(nameSpan);
    btn.appendChild(container);
    return btn;
}

function resolveCategoryImageFromItem(categoryCode) {
    try {
        const allItems = window.menuGridItems || useCache()?.items || [];
        if (!allItems?.length) return null;
        const categoryItems = allItems.filter(item =>
            item.category_code === categoryCode ||
            item.category_code?.trim().toLowerCase() === categoryCode.trim().toLowerCase()
        );
        if (categoryItems.length > 0) {
            const imageUrl = resolveImageUrl(categoryItems[0], categoryItems[0]);
            if (imageUrl && imageUrl !== RESTAURANT_CONFIG.logo) return imageUrl;
        }
    } catch (error) { console.error('Error resolving category image:', error); }
    return null;
}

function createSubcategoryContainer(isVisible) {
    const container = document.createElement('div');
    container.className = `subcategory-container${isVisible ? '' : ' hidden'}`;
    return container;
}

function resetAllTabs(tabContainer) {
    tabContainer.querySelectorAll('.category-tab').forEach(b => b.classList.remove('active'));
    tabContainer.querySelectorAll('.subcategory-container').forEach(div => {
        div.classList.add('hidden');
        div.querySelectorAll('.subcategory-tab').forEach(btn => btn.style.display = 'none');
    });
}

function handleEmptyCategories(tabContainer, shouldFilter) {
    tabContainer.style.display = "none";
    const menuTitle = document.getElementById("menuTitle");
    const menuGrid = document.getElementById("menuGrid");
    if (menuTitle) menuTitle.innerText = shouldFilter ? "No category available" : "Loading categories...";
    if (menuGrid) menuGrid.innerHTML = shouldFilter ? `<p class="text-gray-500">No visible categories.</p>` : `<p class="text-gray-500">Loading menu items...</p>`;
}

function populateCategoryTabs(categories = [], selectedLanguage = "") {
    if (MENU_CONFIG.RENDERING_MODE === 'traditional') {
        populateCategoryTabsTraditional(categories, selectedLanguage);
    } else {
        populateCategoryTabsWorkFlow(categories, selectedLanguage);
    }
}

function populateCategoryTabsTraditional(categories = [], selectedLanguage = "", options = {}) {
    const config = { enableSticky: options.enableSticky !== false, stickyPrimaryColor: options.stickyPrimaryColor !== false, ...options };
    const tabContainer = document.querySelector('.category-tabs');
    const tabsWrapper = document.querySelector('.category-tabs-wrapper');
    tabContainer.innerHTML = '';
    tabsWrapper.classList.add('sticky');
    const allItems = window.menuGridItems || useCache()?.items || [];
    const shouldFilter = allItems.length > 0;

    function categoryOrSubcategoriesHaveItems(categoryCode, hierarchyMap) {
        if (!shouldFilter) return true;
        if (categoryHasVisibleItems(categoryCode, allItems)) return true;
        const subcats = hierarchyMap[categoryCode] || [];
        return subcats.filter(sub => sub.category_code !== 'MAIN' && sub.hide_from_tqr !== 'Y' && sub.hide_from_tqr !== '1')
            .some(sub => categoryHasVisibleItems(sub.category_code, allItems));
    }

    const hierarchyMap = {};
    categories.forEach(cat => {
        const root = cat.root_category_code || 'MAIN';
        if (!hierarchyMap[root]) hierarchyMap[root] = [];
        hierarchyMap[root].push(cat);
    });

    let mainCategories = (hierarchyMap['MAIN'] || []).filter(c => c.category_code !== 'MAIN');
    if (shouldFilter) mainCategories = mainCategories.filter(cat => categoryOrSubcategoriesHaveItems(cat.category_code, hierarchyMap));
    if (mainCategories.length === 0) { handleEmptyCategories(tabContainer, shouldFilter); return; }

    tabContainer.style.display = "";
    mainCategories = mainCategories.filter(cat => {
        if (cat.hide_from_tqr === 'Y' || cat.hide_from_tqr === '1') return false;
        const catAvl = window.categoryAvlMap?.[cat.category_name?.trim()];
        return catAvl?.is_emenu_disable !== 'Y';
    });
    mainCategories.sort((a, b) => {
        const seqA = a.tqr_seq_no || 0, seqB = b.tqr_seq_no || 0;
        if (seqA === 0 && seqB !== 0) return 1;
        if (seqB === 0 && seqA !== 0) return -1;
        return seqA - seqB;
    });

    tabContainer.classList.add('sticky');

    mainCategories.forEach((cat, idx) => {
        const isFirst = idx === 0;
        const isSticky = cat.mobile_is_sticky == 1;
        const mainBtn = createCategoryButton(cat, isFirst, false, selectedLanguage);
        mainBtn.classList.add('px-4', 'py-2', 'rounded', 'hover:bg-gray-200', 'flex', 'justify-between', 'items-center', 'w-full');

        if (isSticky && config.enableSticky) {
            mainBtn.classList.add("mobile-sticky");
            mainBtn.style.cssText += ';position:sticky;top:0;z-index:100;';
            if (config.stickyPrimaryColor) { mainBtn.style.color = "white"; mainBtn.style.fontWeight = "600"; mainBtn.style.backgroundColor = "var(--primary)"; }
        }
        if (isFirst) mainBtn.classList.add('active', 'bg-gray-300');

        const subContainer = document.createElement('div');
        subContainer.className = 'ml-6 mt-2 space-y-1';
        subContainer.style.display = 'none';

        if (isSticky && isFirst && config.enableSticky) {
            subContainer.style.cssText = 'position:sticky;top:70px;z-index:90;padding-bottom:8px;border-bottom:2px solid rgba(0,0,0,0.08);';
        }

        const visibleSubcats = getVisibleSubcategories(cat.category_code, hierarchyMap, allItems);
        visibleSubcats.forEach((subCat, subIdx) => {
            const subBtn = createCategoryButton(subCat, (isFirst && subIdx === 0), true, selectedLanguage);
            subBtn.classList.add('px-3', 'py-1', 'rounded', 'hover:bg-gray-100', 'w-full', 'text-left');
            subBtn.addEventListener('click', e => {
                e.stopPropagation();
                subContainer.querySelectorAll('.subcategory-tab').forEach(b => b.classList.remove('active', 'bg-gray-300'));
                subBtn.classList.add('active', 'bg-gray-300');
                updateMobileSubcategoryBarOnSubcategoryClick(subCat.category_code, selectedLanguage);
                renderCategoryByCode(subCat.category_code, selectedLanguage);
            });
            subContainer.appendChild(subBtn);
        });

        mainBtn.addEventListener('click', () => {
            tabContainer.querySelectorAll('.category-tab').forEach(b => b.classList.remove('active', 'bg-gray-300'));
            tabContainer.querySelectorAll('.ml-6.mt-2.space-y-1').forEach(div => {
                if (div !== subContainer) { div.style.display = 'none'; div.querySelectorAll('.subcategory-tab').forEach(btn => btn.classList.remove('active', 'bg-gray-300')); }
            });
            mainBtn.classList.add('active', 'bg-gray-300');
            const mainCategoryHasItems = categoryHasVisibleItems(cat.category_code, allItems);
            if (visibleSubcats.length > 0) {
                subContainer.style.display = 'block';
                updateMobileSubcategoryBar(visibleSubcats, selectedLanguage, cat);
                if (!mainCategoryHasItems) {
                    const firstSub = subContainer.querySelector('.subcategory-tab');
                    if (firstSub) firstSub.classList.add('active', 'bg-gray-300');
                    renderCategoryByCode(visibleSubcats[0].category_code, selectedLanguage);
                } else {
                    renderCategoryByCode(cat.category_code, selectedLanguage);
                }
            } else if (mainCategoryHasItems) {
                subContainer.style.display = 'none';
                updateMobileSubcategoryBar([], selectedLanguage);
                renderCategoryByCode(cat.category_code, selectedLanguage);
            } else {
                subContainer.style.display = 'none';
                updateMobileSubcategoryBar([], selectedLanguage);
                const menuGrid = document.getElementById('menuGrid');
                if (menuGrid) menuGrid.innerHTML = `<div class="text-center p-8 text-gray-500"><p class="text-lg font-medium">No items available</p></div>`;
            }
        });

        tabContainer.appendChild(mainBtn);
        tabContainer.appendChild(subContainer);
    });

    if (config.enableSticky) {
        tabContainer.addEventListener('scroll', function () {
            const stickyTab = this.querySelector('.mobile-sticky');
            if (stickyTab) {
                const scrollTop = this.scrollTop;
                stickyTab.style.boxShadow = scrollTop > 10 ? '0 2px 8px rgba(0,0,0,0.2)' : 'none';
                stickyTab.style.borderRadius = scrollTop > 10 ? '0 0 8px 8px' : '8px';
                stickyTab.style.marginBottom = scrollTop > 10 ? '8px' : '0';
            }
        });
    }

    let mobileSubBar = document.querySelector('.mobile-subcategory-bar');
    if (!mobileSubBar) {
        mobileSubBar = document.createElement('div');
        mobileSubBar.className = 'mobile-subcategory-bar';
        mobileSubBar.style.cssText = `display:none;position:sticky;top:0;z-index:90;background:white;border-bottom:1px solid #e5e7eb;padding:12px 16px;overflow-x:auto;white-space:nowrap;gap:8px;scrollbar-width:none;`;
        const navSidebar = document.querySelector('.navigation-sidebar');
        if (navSidebar?.parentNode) navSidebar.parentNode.insertBefore(mobileSubBar, navSidebar.nextSibling);
        else { const menuGrid = document.getElementById('menuGrid'); if (menuGrid?.parentNode) menuGrid.parentNode.insertBefore(mobileSubBar, menuGrid); }
    }

    // FIX 8: First render is immediate — no setTimeout wrapper
    if (mainCategories.length > 0) {
        const firstCategory = mainCategories[0];
        const firstSubcats = getVisibleSubcategories(firstCategory.category_code, hierarchyMap, allItems);
        const firstMainBtn = tabContainer.querySelector(`.category-tab[data-category="${firstCategory.category_code}"]`);
        if (firstMainBtn) firstMainBtn.classList.add('active', 'bg-gray-300');
        const firstSubContainer = tabContainer.querySelector('.ml-6.mt-2.space-y-1');
        const firstCategoryHasItems = categoryHasVisibleItems(firstCategory.category_code, allItems);
        if (firstCategoryHasItems) {
            if (firstSubcats.length > 0 && firstSubContainer) firstSubContainer.style.display = 'block';
            renderCategoryByCode(firstCategory.category_code, selectedLanguage);
            updateMobileSubcategoryBar(firstSubcats, selectedLanguage, firstCategory);
        } else if (firstSubcats.length > 0) {
            if (firstSubContainer) firstSubContainer.style.display = 'block';
            const firstSubBtn = tabContainer.querySelector(`.subcategory-tab[data-category="${firstSubcats[0].category_code}"]`);
            if (firstSubBtn) firstSubBtn.classList.add('active', 'bg-gray-300');
            renderCategoryByCode(firstSubcats[0].category_code, selectedLanguage);
            updateMobileSubcategoryBar(firstSubcats, selectedLanguage, firstCategory);
        } else {
            renderCategoryByCode(firstCategory.category_code, selectedLanguage);
            updateMobileSubcategoryBar([], selectedLanguage);
        }
    }
}

function toggleStickyMode(enable, applyPrimaryColor = true) {
    document.querySelectorAll('.mobile-sticky').forEach(btn => {
        if (enable) {
            btn.style.position = "sticky"; btn.style.top = "0"; btn.style.zIndex = "100";
            if (applyPrimaryColor) { btn.style.color = "white"; btn.style.fontWeight = "600"; btn.style.backgroundColor = "var(--primary)"; }
        } else {
            btn.style.position = ""; btn.style.top = ""; btn.style.zIndex = "";
            btn.style.color = ""; btn.style.fontWeight = ""; btn.style.backgroundColor = "";
        }
    });
    document.querySelectorAll('.ml-6.mt-2.space-y-1').forEach(container => {
        const parentBtn = container.previousElementSibling;
        if (enable && parentBtn?.classList.contains('mobile-sticky')) {
            container.style.position = "sticky"; container.style.top = "70px"; container.style.zIndex = "90";
        } else {
            container.style.position = ""; container.style.top = ""; container.style.zIndex = "";
        }
    });
}
function populateCategoryTabsWorkFlow(categories = [], selectedLanguage = "") {
    const tabContainer = document.querySelector('.category-tabs');
    const tabsWrapper = document.querySelector('.category-tabs-wrapper');
    tabContainer.innerHTML = '';
    tabsWrapper.classList.add('sticky');

    // ✅ Single declaration — uses window._categoryImageMap built in _doLoadAndRenderMenu
    const categoryImageMap = window._categoryImageMap || new Map();
    try {
        categories.forEach(cat => {
            const code = cat.category_code;
            if (!code || categoryImageMap.has(code)) return;
            const url = toProxyUrl(cat.tqr_cat_image_url || cat.tqr_image_url);
            if (!url) return;
            categoryImageMap.set(code, url);
            categoryImageMap.set(code.trim().toLowerCase(), url);
        });
        console.log('🗂️ Category image map final:', categoryImageMap.size, 'entries');
    } catch (e) { /* non-fatal */ }

    const allItems = useCache()?.items || [];
    const shouldFilter = allItems.length > 0;

    const visibleCategoryCodes = new Set();
    if (shouldFilter) {
        allItems.forEach(item => {
            if (shouldShowItem(item)) {
                if (item.category_code) visibleCategoryCodes.add(item.category_code.trim().toUpperCase());
                if (item.cat_name) visibleCategoryCodes.add(item.cat_name.trim().toUpperCase());
                if (item.root_category_code) visibleCategoryCodes.add(item.root_category_code.trim().toUpperCase());
            }
        });
    }

    const hasVisibleItems = (code) => {
        if (!shouldFilter) return true;
        if (!code) return false;
        return visibleCategoryCodes.has(code.trim().toUpperCase());
    };

    function getVisibleSubcategoriesLocal(categoryCode, hierarchyMap) {
        return (hierarchyMap[categoryCode] || [])
            .filter(subCat =>
                subCat.category_code !== 'MAIN' &&
                subCat.hide_from_tqr !== 'Y' &&
                subCat.hide_from_tqr !== '1' &&
                (!shouldFilter || hasVisibleItems(subCat.category_code))
            )
            .sort((a, b) => {
                const seqA = a.tqr_seq_no || 0, seqB = b.tqr_seq_no || 0;
                if (seqA === 0 && seqB !== 0) return 1;
                if (seqB === 0 && seqA !== 0) return -1;
                return seqA - seqB;
            });
    }

    function categoryOrSubcategoriesHaveItems(categoryCode, hierarchyMap) {
        if (!shouldFilter) return true;
        if (hasVisibleItems(categoryCode)) return true;
        return (hierarchyMap[categoryCode] || [])
            .filter(sub => sub.category_code !== 'MAIN' && sub.hide_from_tqr !== 'Y' && sub.hide_from_tqr !== '1')
            .some(sub => hasVisibleItems(sub.category_code));
    }

    const hierarchyMap = {};
    categories.forEach(cat => {
        const root = cat.root_category_code || 'MAIN';
        if (!hierarchyMap[root]) hierarchyMap[root] = [];
        hierarchyMap[root].push(cat);
    });

    let mainCategories = (hierarchyMap['MAIN'] || []).filter(c => c.category_code !== 'MAIN');
    if (shouldFilter) mainCategories = mainCategories.filter(cat => categoryOrSubcategoriesHaveItems(cat.category_code, hierarchyMap));
    if (mainCategories.length === 0) { handleEmptyCategories(tabContainer, shouldFilter); return; }

    tabContainer.style.display = "";
    mainCategories = mainCategories.filter(cat => {
        if (cat.hide_from_tqr === 'Y' || cat.hide_from_tqr === '1') return false;
        return window.categoryAvlMap?.[cat.category_name?.trim()]?.is_emenu_disable !== 'Y';
    });
    mainCategories.sort((a, b) => {
        const seqA = a.tqr_seq_no || 0, seqB = b.tqr_seq_no || 0;
        if (seqA === 0 && seqB !== 0) return 1;
        if (seqB === 0 && seqA !== 0) return -1;
        return seqA - seqB;
    });

    tabContainer.classList.add('sticky');

    const categoryMeta = new Map();
    mainCategories.forEach(cat => {
        categoryMeta.set(cat.category_code, {
            visibleSubcats: getVisibleSubcategoriesLocal(cat.category_code, hierarchyMap),
            mainCategoryHasItems: hasVisibleItems(cat.category_code),
        });
    });

    mainCategories.forEach((cat, idx) => {
        const isFirst = idx === 0;
        const isSticky = cat.mobile_is_sticky == 1;
        const { visibleSubcats, mainCategoryHasItems } = categoryMeta.get(cat.category_code);

        const mainBtn = createCategoryButton(cat, isFirst, false, selectedLanguage, categoryImageMap, idx);
        mainBtn.classList.add('hover:bg-gray-200');
        if (isSticky) { mainBtn.classList.add("mobile-sticky"); mainBtn.style.cssText += ';position:sticky;top:0;z-index:100;color:white;font-weight:600;background-color:var(--primary);'; }
        if (isFirst) mainBtn.classList.add('active', 'bg-gray-300');

        const subContainer = document.createElement('div');
        subContainer.className = 'ml-6 mt-2 space-y-1' + (isFirst ? '' : ' hidden');
        if (isSticky && isFirst) subContainer.style.cssText = 'position:sticky;top:70px;z-index:90;padding-bottom:8px;border-bottom:2px solid rgba(0,0,0,0.08);';

        if (mainCategoryHasItems && visibleSubcats.length > 0) {
            const mainAsSubBtn = createCategoryButton(cat, isFirst, true, selectedLanguage, categoryImageMap, idx);
            mainAsSubBtn.classList.add('px-3', 'py-1', 'rounded', 'hover:bg-gray-100', 'w-full', 'text-left');
            mainAsSubBtn.dataset.isMainCategory = 'true';
            mainAsSubBtn.style.display = isFirst ? 'flex' : 'none';
            if (isFirst) mainAsSubBtn.classList.add('active', 'bg-gray-300');
            mainAsSubBtn.addEventListener('click', e => {
                e.stopPropagation();
                if (mainAsSubBtn.classList.contains('active')) return;
                subContainer.querySelectorAll('.subcategory-tab').forEach(b => b.classList.remove('active', 'bg-gray-300'));
                mainAsSubBtn.classList.add('active', 'bg-gray-300');
                updateMobileSubcategoryBarOnSubcategoryClick(cat.category_code, selectedLanguage);
                renderCategoryByCode(cat.category_code, selectedLanguage);
            });
            subContainer.appendChild(mainAsSubBtn);
        }

        visibleSubcats.forEach((subCat) => {
            const subBtn = createCategoryButton(subCat, false, true, selectedLanguage, categoryImageMap, idx);
            subBtn.classList.add('px-3', 'py-1', 'rounded', 'hover:bg-gray-100', 'w-full', 'text-left');
            subBtn.style.display = isFirst ? 'flex' : 'none';
            subBtn.addEventListener('click', e => {
                e.stopPropagation();
                if (subBtn.classList.contains('active')) return;
                subContainer.querySelectorAll('.subcategory-tab').forEach(b => b.classList.remove('active', 'bg-gray-300'));
                subBtn.classList.add('active', 'bg-gray-300');
                updateMobileSubcategoryBarOnSubcategoryClick(subCat.category_code, selectedLanguage);
                renderCategoryByCode(subCat.category_code, selectedLanguage);
            });
            subContainer.appendChild(subBtn);
        });

        mainBtn.addEventListener('click', () => {
            if (mainBtn.classList.contains('active')) return;
            tabContainer.querySelectorAll('.category-tab').forEach(b => b.classList.remove('active', 'bg-gray-300'));
            tabContainer.querySelectorAll('.ml-6.mt-2.space-y-1').forEach(div => {
                div.classList.add('hidden');
                div.querySelectorAll('.subcategory-tab').forEach(btn => { btn.style.display = 'none'; btn.classList.remove('active', 'bg-gray-300'); });
            });
            mainBtn.classList.add('active', 'bg-gray-300');
            if (visibleSubcats.length > 0 || mainCategoryHasItems) {
                subContainer.classList.remove('hidden');
                subContainer.querySelectorAll('.subcategory-tab').forEach(btn => btn.style.display = 'flex');
                updateMobileSubcategoryBar(visibleSubcats, selectedLanguage, cat);
                const firstSub = subContainer.querySelector('.subcategory-tab');
                if (firstSub) firstSub.classList.add('active', 'bg-gray-300');
                renderCategoryByCode(mainCategoryHasItems ? cat.category_code : visibleSubcats[0].category_code, selectedLanguage);
            } else {
                updateMobileSubcategoryBar([], selectedLanguage);
                const menuGrid = document.getElementById('menuGrid');
                if (menuGrid) menuGrid.innerHTML = `<div class="text-center p-8 text-gray-500"><p class="text-lg font-medium">No items available</p></div>`;
            }
        });

        tabContainer.appendChild(mainBtn);
        tabContainer.appendChild(subContainer);
    });

    if (mainCategories.length > 0) {
        const firstCategory = mainCategories[0];
        const { visibleSubcats: firstSubcats, mainCategoryHasItems: firstCategoryHasItems } = categoryMeta.get(firstCategory.category_code);
        const firstSubContainer = tabContainer.querySelector('.ml-6.mt-2.space-y-1');

        if (firstCategoryHasItems) {
            if (firstSubContainer) { firstSubContainer.classList.remove('hidden'); firstSubContainer.querySelectorAll('.subcategory-tab').forEach(btn => btn.style.display = 'flex'); }
            const firstSubBtn = firstSubContainer?.querySelector('.subcategory-tab');
            if (firstSubBtn) firstSubBtn.classList.add('active', 'bg-gray-300');
            renderCategoryByCode(firstCategory.category_code, selectedLanguage);
            updateMobileSubcategoryBar(firstSubcats, selectedLanguage, firstCategory);
        } else if (firstSubcats.length > 0) {
            if (firstSubContainer) { firstSubContainer.classList.remove('hidden'); firstSubContainer.querySelectorAll('.subcategory-tab').forEach(btn => btn.style.display = 'flex'); }
            const firstSubBtn = firstSubContainer?.querySelector('.subcategory-tab');
            if (firstSubBtn) firstSubBtn.classList.add('active', 'bg-gray-300');
            renderCategoryByCode(firstSubcats[0].category_code, selectedLanguage);
            updateMobileSubcategoryBar(firstSubcats, selectedLanguage, firstCategory);
        } else {
            renderCategoryByCode(firstCategory.category_code, selectedLanguage);
            updateMobileSubcategoryBar([], selectedLanguage);
        }
    }
}
function updateMobileSubcategoryBar(subcategories, selectedLanguage, mainCategory = null) {
    const mobileSubBar = document.querySelector('.mobile-subcategory-bar');
    if (!mobileSubBar) return;
    mobileSubBar.innerHTML = '';
    const allItems = useCache()?.items || [];
    let mainCategoryHasItems = false;
    if (mainCategory) {
        const code = mainCategory.category_code.trim().toLowerCase();
        mainCategoryHasItems = allItems.some(item => {
            if (!item?.item_no) return false;
            try { if (typeof isMenuCategoryOrItemHidden === 'function' && isMenuCategoryOrItemHidden('I', item.item_no)) return false; } catch (e) { }
            return (item.category_code || '').trim().toLowerCase() === code;
        });
    }
    let categoriesToShow = [...(subcategories || [])];
    if (mainCategoryHasItems && categoriesToShow.length > 0) categoriesToShow.unshift({ ...mainCategory, _isMainCategory: true });
    if (!categoriesToShow?.length) { mobileSubBar.style.cssText = 'display:none;height:0;padding:0;border:none;'; return; }

    mobileSubBar.style.display = 'flex';
    mobileSubBar.style.height = '';
    mobileSubBar.style.padding = '12px 16px';
    mobileSubBar.style.borderBottom = '1px solid var(--primary)';

    categoriesToShow.forEach((subCat, index) => {
        const subBtn = document.createElement('button');
        subBtn.className = 'mobile-subcategory-btn';
        subBtn.dataset.category = subCat.category_code;
        subBtn.style.cssText = `flex-shrink:0;padding:8px 16px;border-radius:20px;border:1px solid var(--primary);font-size:14px;font-weight:500;transition:all 0.2s;white-space:nowrap;`;
        subBtn.textContent = getTranslatedName(subCat.category_code, subCat.category_name, selectedLanguage, "category");
        if (index === 0) { subBtn.style.background = 'var(--primary)'; subBtn.style.color = 'white'; }
        else { subBtn.style.background = '#f3f4f6'; subBtn.style.color = '#374151'; subBtn.style.borderColor = 'var(--primary)'; }
        subBtn.addEventListener('click', () => {
            mobileSubBar.querySelectorAll('.mobile-subcategory-btn').forEach(b => { b.style.background = '#f3f4f6'; b.style.color = '#374151'; });
            subBtn.style.background = 'var(--primary)'; subBtn.style.color = 'white';
            const tabContainer = document.querySelector('.category-tabs');
            if (tabContainer) {
                tabContainer.querySelectorAll('.subcategory-tab').forEach(b => b.classList.remove('active', 'bg-gray-300'));
                tabContainer.querySelector(`.subcategory-tab[data-category="${subCat.category_code}"]`)?.classList.add('active', 'bg-gray-300');
            }
            renderCategoryByCode(subCat.category_code, selectedLanguage);
            subBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        });
        mobileSubBar.appendChild(subBtn);
    });

    setTimeout(() => {
        mobileSubBar.querySelector('.mobile-subcategory-btn')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }, 100);
}

function updateMobileSubcategoryBarOnSubcategoryClick(categoryCode, selectedLanguage) {
    const mobileSubBar = document.querySelector('.mobile-subcategory-bar');
    if (!mobileSubBar) return;
    mobileSubBar.querySelectorAll('.mobile-subcategory-btn').forEach(b => { b.style.background = '#f3f4f6'; b.style.color = '#374151'; });
    const mobileBtn = mobileSubBar.querySelector(`.mobile-subcategory-btn[data-category="${categoryCode}"]`);
    if (mobileBtn) {
        mobileBtn.style.background = 'var(--primary)'; mobileBtn.style.color = 'white';
        mobileBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
}

function ensureItemModal() {
    if (document.getElementById('itemDescModal')) return;
    const modal = document.createElement('div');
    modal.id = 'itemDescModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'itemDescModalTitle');
    modal.innerHTML = `
        <div class="idm-card">
            <div class="idm-image-wrap"><img id="idmImg" src="" alt="" /></div>
            <div class="idm-body">
                <p class="idm-category" id="idmCategory"></p>
                <h2 class="idm-title" id="itemDescModalTitle"></h2>
                <p class="idm-desc" id="idmDesc"></p>
                <div class="idm-footer">
                    <span class="idm-price" id="idmPrice"></span>
                    <div class="idm-actions">
                        <button class="idm-close-btn" id="idmCloseBtn">Close</button>
                        <button class="idm-add-btn" id="idmAddBtn">Add to Cart</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const closeModal = () => { modal.classList.remove('idm-open'); document.body.style.overflow = ''; modal._currentItemId = null; };
    document.getElementById('idmCloseBtn').addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
    document.getElementById('idmAddBtn').addEventListener('click', () => {
        if (modal._currentItemId) {
            const fullItem = window.menuGridItems?.find(i => i.item_no === modal._currentItemId);
            if (fullItem) addToCart(fullItem.item_no, [], [], null, false);
            else addToCart(modal._currentItemId);
        }
        closeModal();
    });
}

function openItemModal(item, imageUrl, displayPrice, category = '') {
    ensureItemModal();
    const modal = document.getElementById('itemDescModal');
    modal._currentItemId = item.item_no;
    document.getElementById('idmImg').src = imageUrl || '';
    document.getElementById('idmImg').alt = item.display_name || item.item_name;
    document.getElementById('idmCategory').textContent = category;
    document.getElementById('itemDescModalTitle').textContent = item.item_desc || item.display_name || item.item_name;
    document.getElementById('idmDesc').textContent = '';
    document.getElementById('idmPrice').textContent = displayPrice || '';
    modal.classList.add('idm-open');
    document.body.style.overflow = 'hidden';
}

export function sortMenuItems(items) {
    if (!Array.isArray(items) || items.length === 0) return items;

    const menuSections = useCache()?.menuItems || [];
    const seqMap = new Map();
    menuSections.forEach(section => {
        (section.category || []).forEach(cat => {
            const code = (cat.category_code || '').toUpperCase();
            if (code) seqMap.set(code, parseInt(cat.course_seq) || 999);
        });
    });

    return [...items].sort((a, b) => {
        const catA = (a?.category_code || '').toUpperCase();
        const catB = (b?.category_code || '').toUpperCase();

        // 1️⃣ Sort by category course_seq
        const seqA = seqMap.get(catA) ?? parseInt(a?.course_seq) ?? 999;
        const seqB = seqMap.get(catB) ?? parseInt(b?.course_seq) ?? 999;
        if (seqA !== seqB) return seqA - seqB;

        // 2️⃣ Same category — sort by tqr_seq_type (item-level order)
        const tqrA = parseInt(a?.tqr_seq_type) || 999;
        const tqrB = parseInt(b?.tqr_seq_type) || 999;
        if (tqrA !== tqrB) return tqrA - tqrB;

        // 3️⃣ Same tqr_seq_type — fallback alphabetical by shot_name
        const nameA = (a?.shot_name || a?.item_name || '').toUpperCase();
        const nameB = (b?.shot_name || b?.item_name || '').toUpperCase();
        return nameA.localeCompare(nameB);
    });
}


// ─── FIX 9: renderMenuGridTraditional — removed 400ms artificial delay ────────
// Skeletons show immediately; items replace them after a single microtask tick.
async function renderMenuGridTraditional(items) {
    const container = document.getElementById('menuGrid');
    if (!container) return;
    items = items.filter(item => shouldShowItem(item));
    if (items.length === 0) { container.innerHTML = `<div class="text-center p-8 text-gray-500">No items available.</div>`; return; }
    ensureItemModal();
    items = sortMenuItems(items);

    let MenuItems = [];
    try {
        const cached = getMenuItems();
        if (Array.isArray(cached)) MenuItems = cached.flatMap(cat => cat.items || []);
    } catch (err) { console.error("Failed to retrieve MenuItems:", err); }

    const restaurantLogo = RESTAURANT_CONFIG.logo || '';

    container.innerHTML = Array(items.length).fill(0).map(() => `
        <div class="menu-item-skeleton">
            <div class="skeleton-loader skeleton-image"></div>
            <div class="skeleton-loader skeleton-text"></div>
            <div class="skeleton-loader skeleton-text-short"></div>
            <div class="skeleton-loader skeleton-button"></div>
        </div>
    `).join('');

    const imageUrls = items.map(item => resolveImageUrl(item, MenuItems.find(mi => mi.item_no === item.item_no))).filter(url => url && url !== restaurantLogo);
    const allergenUrls = items.map(item => resolveAllergenImageUrl(item, MenuItems.find(mi => mi.item_no === item.item_no))).filter(Boolean);
    const nutritionUrls = items.map(item => resolveNutritionImageUrl(item, MenuItems.find(mi => mi.item_no === item.item_no))).filter(Boolean);
    preloadImages([...imageUrls, ...allergenUrls, ...nutritionUrls], 'high');

    //// Single microtask yield so skeleton paints before items replace it
    //await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 1)));

    container.innerHTML = items.map((item, index) => {
        const id = item.item_no;
        const menuItem = MenuItems.find(mi => mi.item_no === id);
        const imageUrl = resolveImageUrl(item, menuItem);
        const allergenUrl = resolveAllergenImageUrl(item, menuItem);
        const nutritionUrl = resolveNutritionImageUrl(item, menuItem);
        const hasMenuTypeGrpDtls = Array.isArray(item.itemmaster_menutype_grpdtls) ? item.itemmaster_menutype_grpdtls.length > 0 : Boolean(item.itemmaster_menutype_grpdtls);
        const priceObj = item?.selling_uom_dtls?.[0]?.price_dtls?.[0] || item;
        const priceValue = hasMenuTypeGrpDtls ? null : parseFloat(getPriceByServiceType(priceObj));
        const displayPrice = !isNaN(priceValue) && priceValue > 0 ? `$${priceValue.toFixed(2)}` : '';
        const loadingStrategy = index < 6 ? 'eager' : 'lazy';
        const fetchPriority = index < 6 ? 'high' : 'auto';
        const allergenBadge = allergenUrl ? `<img src="${allergenUrl}" alt="Allergen info" class="allergen-badge" fetchpriority="${fetchPriority}" decoding="async" loading="${loadingStrategy}" style="width:32px;height:32px;object-fit:contain;padding:4px;border-radius:6px;" onerror="this.style.display='none';">` : '';
        const nutritionBadge = nutritionUrl ? `<img src="${nutritionUrl}" alt="Nutrition info" class="nutrition-badge" fetchpriority="${fetchPriority}" decoding="async" loading="${loadingStrategy}" style="position:absolute;bottom:8px;right:1px;width:40px;height:40px;object-fit:contain;padding:4px;border-radius:6px;z-index:10;" onerror="this.style.display='none';">` : '';
        return `
          <div class="menu-item p-4 border rounded shadow" data-item-name="${item.item_name}" data-item-id="${id}" style="cursor:pointer;">
            <div class="item-image">
              <div class="image-wrapper" style="position:relative;width:100%;height:100%;background:#f0f0f0;border-radius:var(--radius-md);overflow:hidden;">
                 <img src="${imageUrl}" alt="${item.item_name}" fetchpriority="${fetchPriority}" decoding="async" loading="${loadingStrategy}"
                      style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius-md);display:block;"
                      onload="this.classList.add('loaded');"
                      onerror="this.onerror=null;if(this.src!=='${restaurantLogo}')this.src='${restaurantLogo}';">
                 ${nutritionBadge}
              </div>
            </div>
            <div class="item-info" style="position:relative;">
              <h3 class="font-semibold">${item.display_name || item.item_name}</h3>
              <div style="display:flex;align-items:flex-start;gap:8px;">
                ${allergenBadge ? `<div style="flex-shrink:0;display:flex;align-items:center;">${allergenBadge}</div>` : ''}
              </div>
              <div class="item-footer flex justify-between items-center mt-2">
                    <span class="item-price font-bold">${displayPrice}</span>
                <button class="add-btn bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded w-full max-w-[100px]" data-item-id="${id}">Add to Cart</button>
              </div>
            </div>
          </div>
        `;
    }).join('');

    window.menuGridItems = items;

    if (!window.isMenuGridClickListenerAttached) {
        container.addEventListener('click', (e) => {
            if (e.target.matches('button.add-btn')) {
                const id = e.target.getAttribute('data-item-id');
                const btn = e.target;
                flyToCart(btn);
                addToCart(id);
                btn.textContent = '✓ Added!';
                btn.style.background = '#16a34a';
                btn.disabled = true;
                setTimeout(() => { btn.textContent = 'Add to Cart'; btn.style.background = ''; btn.disabled = false; }, 1800);
                return;
            }
            if (e.target.closest('.allergen-badge') || e.target.closest('.nutrition-badge')) return;
            const card = e.target.closest('.menu-item');
            if (!card) return;
            const itemId = card.getAttribute('data-item-id');
            const fullItem = window.menuGridItems.find(i => i.item_no === itemId);
            if (!fullItem) return;
            const menuItem = MenuItems.find(mi => mi.item_no === itemId);
            const imageUrl = resolveImageUrl(fullItem, menuItem);
            const priceObj = fullItem?.selling_uom_dtls?.[0]?.price_dtls?.[0] || fullItem;
            const priceValue = parseFloat(getPriceByServiceType(priceObj));
            const displayPrice = !isNaN(priceValue) && priceValue > 0 ? `$${priceValue.toFixed(2)}` : '';
            openItemModal(fullItem, imageUrl, displayPrice, fullItem.category_code || '');
        });
        window.isMenuGridClickListenerAttached = true;
    }

    if (typeof attachItemDetailHandlers === 'function') attachItemDetailHandlers();
    console.log('✅ Menu grid rendered (Traditional)');
}


let currentRenderController = null;

async function renderCategoryByCode(categoryCode, selectedLanguage = "") {
    if (MENU_CONFIG.RENDERING_MODE === 'traditional') {
        renderCategoryByCodeTraditional(categoryCode, selectedLanguage);
    } else {
        renderCategoryByCodeWorkFlow(categoryCode, selectedLanguage);
    }
}

async function renderMenuGrid(items) {
    if (MENU_CONFIG.RENDERING_MODE === 'traditional') {
        renderMenuGridTraditional(items);
    } else {
        renderMenuGridWorkFlow(items);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Double-rAF yield — guarantees the browser has completed at least one full
 * paint before the calling code resumes.
 * A single rAF only schedules work *before* the next paint; the second one
 * waits until that frame has actually been committed to screen.
 */
function waitForPaint() {
    return new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
}

/**
 * Single-rAF yield — hand control back to the browser for one frame.
 * Used inside chunked loops so the thread doesn't stay blocked.
 */
function yieldFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve));
}

/**
 * Build the HTML string for one menu card.
 *
 * FIX (image fallback): The onerror guard now checks that the current src is a
 * real non-logo URL before swapping to the restaurant logo. Previously an item
 * whose resolveImageUrl() returned '' would fire onerror immediately (because
 * '' is not a valid URL) and display the logo in place of the product image.
 */
function buildItemCardHTML(item, index, restaurantLogo) {
    const id = item.item_no;
    const imageUrl = resolveImageUrl(item, item) || '';
    const allergenUrl = resolveAllergenImageUrl(item, item) || '';
    const nutritionUrl = resolveNutritionImageUrl(item, item) || '';
    const isSticky = item._isSticky === true;

    const hasMenuTypeGrpDtls =
        Array.isArray(item.itemmaster_menutype_grpdtls)
            ? item.itemmaster_menutype_grpdtls.length > 0
            : Boolean(item.itemmaster_menutype_grpdtls && item.itemmaster_menutype_grpdtls !== '');

    const priceObj = item?.selling_uom_dtls?.[0]?.price_dtls?.[0] || item;
    const priceValue = parseFloat(getPriceByServiceType(priceObj));

    let displayPrice = '';
    if (hasMenuTypeGrpDtls) {
        //const lowestPrice = window._lowestPriceCache?.get(item.item_no) ?? getLowestModifierPrice(item);
        //if (lowestPrice !== null && lowestPrice > 0) {
        //    displayPrice = `$${lowestPrice.toFixed(2)}`;
        //} else if (!isNaN(priceValue) && priceValue > 0) {
        //    displayPrice = `$${priceValue.toFixed(2)}`;
        //}
        if (!isNaN(priceValue) && priceValue > 0) {
            displayPrice = `$${priceValue.toFixed(2)}`;
        } else {
            const lowestPrice = window._lowestPriceCache?.get(item.item_no) ?? getLowestModifierPrice(item);
            if (lowestPrice !== null && lowestPrice > 0) {
                displayPrice = `$${lowestPrice.toFixed(2)}`;
            }
        }
    } else {
        if (!isNaN(priceValue) && priceValue > 0) {
            displayPrice = `$${priceValue.toFixed(2)}`;
        }
    }

    const shouldHidePrice = !displayPrice;
    const fetchPriority = index < 6 ? 'high' : 'auto';

    // ── Image timing fix: check preload cache ─────────────────────────────
    const alreadyLoaded = isImagePreloaded(imageUrl);
    const imgStyle = alreadyLoaded
        ? 'width:100%;height:100%;object-fit:cover;border-radius:var(--radius-md);display:block;opacity:1;'
        : 'width:100%;height:100%;object-fit:cover;border-radius:var(--radius-md);display:block;opacity:0;transition:opacity 0.2s ease;';
    const imgClass = alreadyLoaded ? 'loaded' : '';

    const allergenBadge = allergenUrl
        ? `<img src="${allergenUrl}" alt="Allergen info" class="allergen-badge"
               fetchpriority="${fetchPriority}" decoding="async" loading="eager"
               style="width:32px;height:32px;object-fit:contain;padding:4px;border-radius:6px;"
               onerror="this.style.display='none';">`
        : '';

    const nutritionBadge = nutritionUrl
        ? `<img src="${nutritionUrl}" alt="Nutrition info" class="nutrition-badge"
               fetchpriority="${fetchPriority}" decoding="async" loading="eager"
               style="position:absolute;bottom:8px;right:1px;width:40px;height:40px;
                      object-fit:contain;padding:4px;border-radius:6px;z-index:10;"
               onerror="this.style.display='none';">`
        : '';

    const stickyBadge = isSticky
        ? `<div class="sticky-badge"
               style="position:absolute;top:8px;left:8px;background:#ff6b6b;color:white;
                      padding:4px 8px;border-radius:4px;font-size:12px;font-weight:bold;z-index:10;">
               📌 Featured
           </div>`
        : '';

    const imgSrc = imageUrl || restaurantLogo;
    const onerrorFn = restaurantLogo
        ? `this.onerror=null;if(this.src&&this.src!=='${restaurantLogo}')this.src='${restaurantLogo}';else this.style.display='none';`
        : `this.onerror=null;this.style.display='none';`;

    return `
        <div class="menu-item ${isSticky ? 'sticky-item' : ''} p-4 border rounded shadow"
             data-item-name="${item.item_name}" data-item-id="${id}" style="cursor:pointer;">
            <div class="item-image">
                <div class="image-wrapper"
                     style="position:relative;width:100%;height:100%;background:#f0f0f0;
                            border-radius:var(--radius-md);overflow:hidden;">
                    ${stickyBadge}
                    <img src="${imgSrc}"
                         alt="${item.item_name}"
                         class="${imgClass}"
                         fetchpriority="${fetchPriority}"
                         decoding="async"
                         loading="eager"
                         style="${imgStyle}"
                         onload="this.style.opacity='1';this.classList.add('loaded');"
                         onerror="${onerrorFn}">
                    ${nutritionBadge}
                </div>
            </div>
            <div class="item-info" style="position:relative;">
                <h3 class="font-semibold">${item.item_desc || item.display_name || item.item_name}</h3>
                <div style="display:flex;align-items:flex-start;gap:8px;">
                    <p class="item-description text-sm text-gray-600" style="flex:1;">
                        ${item.describe_info || item.item_desc}
                    </p>
                    ${allergenBadge
            ? `<div style="flex-shrink:0;display:flex;align-items:center;">${allergenBadge}</div>`
            : ''}
                </div>
                <div class="item-footer flex justify-between items-center mt-2">
                    <span class="item-price font-bold ${shouldHidePrice ? 'invisible' : ''}">
                        ${displayPrice}
                    </span>
                    <button class="add-btn bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded w-full max-w-[100px]"
                            data-item-id="${id}">Add to Cart</button>
                </div>
            </div>
        </div>`;
}


function getLowestModifierPrice(item) {
    // ✅ Use pre-built cache first
    if (window._lowestPriceCache?.has(item.item_no)) {
        return window._lowestPriceCache.get(item.item_no);
    }

    if (!Array.isArray(item.itemmaster_menutype_grpdtls) || !item.itemmaster_menutype_grpdtls.length) return null;
    if (!Array.isArray(item.itemmaster_menutypedtls) || !item.itemmaster_menutypedtls.length) return null;

    let cacheItems = useCache()?.items || [];
    if (!cacheItems.length) {
        cacheItems = window.apiManager?.loadedData?.get('FullItems')
            || window.apiManager?.loadedData?.get('items')
            || [];
    }
    if (!cacheItems.length) {
        console.warn('⚠️ getLowestModifierPrice: no cache items available, skipping');
        return null;
    }

    const SIZE_PREFIXES = ['M-', 'L-', 'H-', '(M)', '(L)', '(H)'];

    // ✅ Sort by item_menutype_grpdtls (sequence number)
    const sortedGroups = [...item.itemmaster_menutype_grpdtls].sort(
        (a, b) => (a.item_menutype_grpdtls || 9999) - (b.item_menutype_grpdtls || 9999)
    );

    let firstGroupItems = [];

    for (const group of sortedGroups) {
        const groupName = group.modifier_name || '';

        // ✅ Match by modifier_name — level_no is unreliable (always 0)
        const candidates = item.itemmaster_menutypedtls.filter(mi => {
            const nameMatch = !groupName || mi.modifier_name === groupName;
            const name = mi.citem_name || mi.item_name || '';
            return nameMatch && SIZE_PREFIXES.some(prefix => name.startsWith(prefix));
        });

        if (candidates.length > 0) {
            firstGroupItems = candidates;
            break;
        }
    }

    if (!firstGroupItems.length) return null;

    const prices = firstGroupItems
        .map(mi => {
            const fullItem = cacheItems.find(ci =>
                ci.item_no === (mi.citem_no || mi.item_no)
            );
            if (!fullItem) return null;
            const price = getPriceByServiceType(
                fullItem?.selling_uom_dtls?.[0]?.price_dtls?.[0]
            );
            return parseFloat(price);
        })
        .filter(p => p !== null && !isNaN(p) && p > 0);

    const result = prices.length ? Math.min(...prices) : null;

    // ✅ Store in cache
    if (window._lowestPriceCache) {
        window._lowestPriceCache.set(item.item_no, result);
    }

    return result;
}

/**
 * Named click handler — stored so it can be cleanly removed before
 * re-attaching on every render. No global flags, no duplicate listeners.
 */
function menuGridClickHandler(e) {
    // ── "Add to Cart" button ──────────────────────────────────────────────────
    if (e.target.matches('button.add-btn')) {
        const id = e.target.getAttribute('data-item-id');
        const btn = e.target;
        flyToCart(btn);
        addToCart(id);
        btn.textContent = '✓ Added!';
        btn.style.background = '#16a34a';
        btn.disabled = true;
        setTimeout(() => {
            btn.textContent = 'Add to Cart';
            btn.style.background = '';
            btn.disabled = false;
        }, 1800);
        return;
    }

    // ── Badge clicks — do nothing ─────────────────────────────────────────────
    if (e.target.closest('.allergen-badge') || e.target.closest('.nutrition-badge')) return;

    // ── Card click → open modal ───────────────────────────────────────────────
    const card = e.target.closest('.menu-item');
    if (!card) return;

    const itemId = card.getAttribute('data-item-id');
    const fullItem = window.menuGridItems?.find(i => i.item_no === itemId);
    if (!fullItem) return;

    const imageUrl = resolveImageUrl(fullItem, fullItem) || '';
    const priceObj = fullItem?.selling_uom_dtls?.[0]?.price_dtls?.[0] || fullItem;
    const priceValue = parseFloat(getPriceByServiceType(priceObj));

    const shouldHidePrice = Boolean(
        (Array.isArray(fullItem.itemmaster_menutype_grpdtls)
            ? fullItem.itemmaster_menutype_grpdtls.length > 0
            : Boolean(fullItem.itemmaster_menutype_grpdtls && fullItem.itemmaster_menutype_grpdtls !== ''))
        || isNaN(priceValue) || priceValue <= 0
    );

    const displayPrice = !shouldHidePrice ? `$${priceValue.toFixed(2)}` : '';
    openItemModal(fullItem, imageUrl, displayPrice, fullItem.category_code || '');
}


const _decodedImagePool = new Map();
const DECODED_POOL_MAX = 400; // ~400 menu images max

function poolImage(url) {
    if (!url || _decodedImagePool.has(url)) return;
    if (_decodedImagePool.size >= DECODED_POOL_MAX) {
        // Evict oldest entry
        const firstKey = _decodedImagePool.keys().next().value;
        _decodedImagePool.delete(firstKey);
    }
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    img.decode?.().catch(() => { });
    _decodedImagePool.set(url, img);
}

/**
 * After a grid render, replace each <img> with its pooled twin (already
 * downloaded + decoded). Pooled images render instantly with no request.
 * Non-pooled images are added to the pool for next time.
 */
function swapInPooledImages(container) {
    container.querySelectorAll('.menu-item .item-image img').forEach(img => {
        const url = img.src;
        if (!url) return;
        const pooled = _decodedImagePool.get(url);
        if (pooled && pooled.complete && pooled.naturalWidth > 0) {
            // Clone attributes/styles onto the pooled node and swap
            const clone = pooled.cloneNode();
            clone.alt = img.alt;
            clone.className = img.className + ' loaded';
            clone.style.cssText = img.style.cssText;
            clone.style.opacity = '1';
            img.replaceWith(clone);
        } else {
            // First sighting — pool it once it finishes loading
            if (img.complete && img.naturalWidth > 0) {
                _decodedImagePool.set(url, img.cloneNode());
            } else {
                img.addEventListener('load', () => poolImage(url), { once: true });
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER MENU GRID  (Workflow variant)
// ─────────────────────────────────────────────────────────────────────────────

async function renderMenuGridWorkFlow(items) {
    items = (items || []).filter(item => shouldShowItem(item));

    if (!window._lowestPriceCache || window._lowestPriceCache.size === 0) {
        console.warn('⚠️ Price cache missing at render time — building from current items');
        const lowestPriceCache = new Map();
        items.forEach(item => {
            if (Array.isArray(item.itemmaster_menutype_grpdtls)
                && item.itemmaster_menutype_grpdtls.length > 0) {
                lowestPriceCache.set(item.item_no, getLowestModifierPrice(item));
            }
        });
        window._lowestPriceCache = lowestPriceCache;
    } else {
        console.log('⚡ Price cache reused:', window._lowestPriceCache.size, 'items');
    }

    const container = document.getElementById('menuGrid');
    if (!container) return;

    if (items.length === 0) {
        container.innerHTML = `
            <div class="text-center p-8">
                <div class="text-6xl mb-4">🍵</div>
                <p class="text-gray-600">No items available in this category</p>
            </div>`;
        return;
    }

    ensureItemModal();
    const restaurantLogo = RESTAURANT_CONFIG.logo || '';
    items = sortMenuItems(items);

    // ── Kick off preloads for first 9 images immediately ─────────────────────
    const firstNineUrls = [];
    try {
        const existingPreloads = new Set(
            Array.from(document.querySelectorAll('link[rel="preload"][as="image"]'))
                .map(l => l.href)
        );
        items.slice(0, 9).forEach((item, idx) => {
            const rawUrl = item.tqr_image_url || item.item_image || item.image;
            if (!rawUrl) return;
            const url = rawUrl.startsWith('public/upload/')
                ? `/api/GetImageProxy?imageUrl=${encodeURIComponent(rawUrl)}`
                : rawUrl;
            firstNineUrls.push(url);
            if (existingPreloads.has(url)) return;
            const link = document.createElement('link');
            link.rel = 'preload';
            link.as = 'image';
            link.href = url;
            link.fetchPriority = idx < 3 ? 'high' : 'auto';
            document.head.appendChild(link);
            existingPreloads.add(url);
        });
    } catch (e) { /* non-fatal */ }

    // Also register with imagePreloadMap so isImagePreloaded() works
    preloadImages(firstNineUrls, 'high');

    // ── Skeleton overlay ──────────────────────────────────────────────────────
    if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
    }

    const skeletonOverlay = document.createElement('div');
    skeletonOverlay.className = 'skeleton-overlay';
    skeletonOverlay.style.cssText = `
        position:absolute;top:0;left:0;width:100%;min-height:100%;
        background:var(--color-background-primary,#fff);
        z-index:2;box-sizing:border-box;
        display:grid;
        grid-template-columns:repeat(3,1fr);
        gap:1rem;padding:1rem;`;

    const skeletonFrag = document.createDocumentFragment();
    for (let i = 0; i < Math.min(items.length, 9); i++) {
        const el = document.createElement('div');
        el.className = 'menu-item-skeleton';
        el.innerHTML = `
            <div class="skeleton-loader skeleton-image"></div>
            <div class="skeleton-loader skeleton-text"></div>
            <div class="skeleton-loader skeleton-text-short"></div>
            <div class="skeleton-loader skeleton-button"></div>`;
        skeletonFrag.appendChild(el);
    }
    skeletonOverlay.appendChild(skeletonFrag);
    container.appendChild(skeletonOverlay);

    await waitForPaint();

    // ── Wait for first 3 images before injecting cards ────────────────────────
    // Uses the existing loadImageWithFastFallback helper (400ms hard timeout)
    // so a slow CDN never blocks the render for more than 400ms total.
    const firstThreeUrls = firstNineUrls.slice(0, 3).filter(url => !isImagePreloaded(url));
    if (firstThreeUrls.length > 0) {
        await Promise.all(
            firstThreeUrls.map(url => loadImageWithFastFallback(url, restaurantLogo, 400))
        );
    }

    // ── Preload remaining images in background (non-blocking) ─────────────────
    const remainingUrls = items.slice(9).map(item => resolveImageUrl(item, item)).filter(Boolean);
    const allergenUrls = items.map(item => resolveAllergenImageUrl(item, item)).filter(Boolean);
    const nutritionUrls = items.map(item => resolveNutritionImageUrl(item, item)).filter(Boolean);
    preloadImages([...remainingUrls, ...allergenUrls, ...nutritionUrls], 'auto');

    // ── Build all cards into a DocumentFragment in chunks ────────────────────
    const CHUNK_SIZE = 8;
    const gridFrag = document.createDocumentFragment();

    for (let i = 0; i < items.length; i++) {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = buildItemCardHTML(items[i], i, restaurantLogo).trim();
        gridFrag.appendChild(wrapper.firstElementChild);

        if ((i + 1) % CHUNK_SIZE === 0 && i < items.length - 1) {
            await yieldFrame();
        }
    }

    // ── Single DOM swap ───────────────────────────────────────────────────────
    skeletonOverlay.remove();
    container.innerHTML = '';
    container.appendChild(gridFrag);
    window.menuGridItems = items;

    container.removeEventListener('click', menuGridClickHandler);
    container.addEventListener('click', menuGridClickHandler);
    if (typeof attachItemDetailHandlers === 'function') attachItemDetailHandlers();
    console.log('✅ Menu grid rendered (Workflow)');
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER CATEGORY BY CODE  (Traditional variant)
// ─────────────────────────────────────────────────────────────────────────────

async function renderCategoryByCodeTraditional(categoryCode, selectedLanguage = '') {
    if (currentRenderController) currentRenderController.abort();
    currentRenderController = new AbortController();
    const signal = currentRenderController.signal;

    const container = document.getElementById('menuGrid');
    if (!container) return;

    if (!categoryCode?.trim()) {
        container.innerHTML = `<p class="text-red-500">Invalid category code.</p>`;
        return;
    }

    container.innerHTML = Array(6).fill(0).map(() => `
        <div class="menu-item skeleton"
             style="height:80px;margin-bottom:12px;
                    background:linear-gradient(90deg,#f0f0f0 25%,#e0e0e0 37%,#f0f0f0 63%);
                    background-size:400% 100%;
                    animation:shimmer 1.2s ease-in-out infinite;
                    border-radius:8px;">
        </div>`).join('');

    try {
        const { menuItems, fullItems } = useCache();

        if (!Array.isArray(menuItems) || !menuItems.length) {
            container.innerHTML = `<p class="text-red-500">No menu items available.</p>`;
            return;
        }

        const code = categoryCode.trim().toUpperCase();
        const section = menuItems.find(s => s.root_category_code?.trim().toUpperCase() === code);

        if (!section || !Array.isArray(section.items)) {
            container.innerHTML = `<p class="text-gray-500">No items found.</p>`;
            return;
        }

        let categoryItems = section.items;
        if (signal.aborted) return;

        if (fullItems?.length) {
            categoryItems = categoryItems.map(menuItem => {
                const fullItem = fullItems.find(fi => fi.item_no === menuItem.item_no);
                if (fullItem) {
                    const clean = Object.fromEntries(
                        Object.entries(menuItem).filter(([, v]) => v !== null && v !== undefined && v !== '')
                    );
                    return {
                        ...fullItem,
                        ...clean,
                        tqr_image_url: menuItem.tqr_image_url || fullItem.tqr_image_url || '',
                        item_image: menuItem.item_image || fullItem.item_image || '',
                    };
                }
                return menuItem;
            });
        }

        const seen = new Set();
        const filteredItems = categoryItems.filter(item => {
            if (!item?.item_no || seen.has(item.item_no)) return false;
            seen.add(item.item_no);
            return true;
        });

        if (signal.aborted) return;

        if (!filteredItems.length) {
            container.innerHTML = `<p class="text-gray-500">No items found.</p>`;
            return;
        }

        const parentItems = filteredItems.filter(item => {
            if (!shouldShowItem(item)) return false;
            const sku = item.sku_no || '';
            const hasVariants =
                (Array.isArray(item.itemmaster_menutype_grpdtls) && item.itemmaster_menutype_grpdtls.length > 0) ||
                (Array.isArray(item.itemmaster_menutypedtls) && item.itemmaster_menutypedtls.length > 0) ||
                (item.itemmaster_menutype_grpdtls && item.itemmaster_menutype_grpdtls !== '') ||
                (item.itemmaster_menutypedtls && item.itemmaster_menutypedtls !== '');
            if (hasVariants) return true;
            if (/^[HLM]-/.test(sku) || /^[HLM]-/.test(item.item_name || '')) return false;
            return true;
        });

        showLoadingSkeleton(container, categoryCode);

        await waitForPaint();

        if (signal.aborted) return;

        if (!parentItems.length) {
            container.innerHTML = `<p class="text-gray-500">No parent items found.</p>`;
            return;
        }

        const translatedItems = await Promise.allSettled(
            parentItems.map(async item => {
                try {
                    return {
                        ...item,
                        display_name: await getTranslatedName(item.item_no, item.item_name, selectedLanguage, 'item'),
                    };
                } catch {
                    return { ...item, display_name: item.item_name || item.item_no };
                }
            })
        );

        if (signal.aborted) return;

        const successfulItems = translatedItems
            .filter(r => r.status === 'fulfilled')
            .map(r => r.value);

        container.innerHTML = '';
        const section2 = document.createElement('div');
        section2.className = 'category-section';
        section2.dataset.categorySection = categoryCode;
        container.appendChild(section2);

        if (typeof renderMenuGrid === 'function') await renderMenuGrid(successfulItems);
        currentRenderController = null;

    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('❌ Error in renderCategoryByCodeTraditional:', error);
        container.innerHTML = `<p class="text-red-500">Error loading: ${error.message}</p>`;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER CATEGORY BY CODE  (Workflow variant)
// ─────────────────────────────────────────────────────────────────────────────
async function renderCategoryByCodeWorkFlow(categoryCode, selectedLanguage = '') {
    if (currentRenderController) currentRenderController.abort();
    currentRenderController = new AbortController();
    const signal = currentRenderController.signal;

    const container = document.getElementById('menuGrid');
    if (!container) return;

    if (!categoryCode?.trim()) {
        container.innerHTML = `<p class="text-red-500">Invalid category code.</p>`;
        return;
    }

    try {
        const { menuItems, items: fullItems } = useCache();

        if (!Array.isArray(menuItems) || !menuItems.length) {
            container.innerHTML = `<p class="text-red-500">No menu items available.</p>`;
            return;
        }

        const code = categoryCode.trim().toUpperCase();
        const section = menuItems.find(s => s.root_category_code?.trim().toUpperCase() === code);

        if (!section || !Array.isArray(section.items)) {
            container.innerHTML = `<p class="text-gray-500">No items found.</p>`;
            return;
        }

        let categoryItems = section.items;
        if (signal.aborted) return;

        if (fullItems?.length) {
            const fullItemMap = new Map(fullItems.map(fi => [fi.item_no, fi]));
            categoryItems = categoryItems.map(menuItem => {
                const fullItem = fullItemMap.get(menuItem.item_no);
                if (fullItem) {
                    const clean = Object.fromEntries(
                        Object.entries(menuItem).filter(([, v]) =>
                            v !== null && v !== undefined && v !== '' &&
                            !(Array.isArray(v) && v.length === 0)
                        )
                    );
                    return {
                        ...fullItem,
                        ...clean,
                        itemmaster_menutype_grpdtls: fullItem.itemmaster_menutype_grpdtls?.length
                            ? fullItem.itemmaster_menutype_grpdtls
                            : (menuItem.itemmaster_menutype_grpdtls || []),
                        itemmaster_menutypedtls: fullItem.itemmaster_menutypedtls?.length
                            ? fullItem.itemmaster_menutypedtls
                            : (menuItem.itemmaster_menutypedtls || []),
                        selling_uom_dtls: fullItem.selling_uom_dtls?.length
                            ? fullItem.selling_uom_dtls
                            : (menuItem.selling_uom_dtls || []),
                        tqr_image_url: menuItem.tqr_image_url || fullItem.tqr_image_url || '',
                        item_image: menuItem.item_image || fullItem.item_image || '',
                    };
                }
                return menuItem;
            });
        }

        const seen = new Set();
        const filteredItems = categoryItems.filter(item => {
            if (!item?.item_no || seen.has(item.item_no)) return false;
            seen.add(item.item_no);
            return true;
        });

        if (signal.aborted) return;

        if (!filteredItems.length) {
            container.innerHTML = `<p class="text-gray-500">No items found.</p>`;
            return;
        }

        const parentItems = filteredItems.filter(item => {
            if (!shouldShowItem(item)) return false;
            const sku = item.sku_no || '';
            const hasVariants =
                (Array.isArray(item.itemmaster_menutype_grpdtls) && item.itemmaster_menutype_grpdtls.length > 0) ||
                (Array.isArray(item.itemmaster_menutypedtls) && item.itemmaster_menutypedtls.length > 0) ||
                (item.itemmaster_menutype_grpdtls && item.itemmaster_menutype_grpdtls !== '') ||
                (item.itemmaster_menutypedtls && item.itemmaster_menutypedtls !== '');
            if (hasVariants) return true;
            if (/^[HLM]-/.test(sku) || /^[HLM]-/.test(item.item_name || '')) return false;
            return true;
        });

        if (!parentItems.length) {
            container.innerHTML = `<p class="text-gray-500">No parent items found.</p>`;
            return;
        }

        if (signal.aborted) return;

        // ── RENDER IMMEDIATELY — no skeleton wait, no translation await ───────
        // Removed: container.innerHTML skeleton at top (caused DOM wipe)
        // Removed: showLoadingSkeleton + waitForPaint (added 300ms+ delay)
        // Removed: Promise.allSettled(translations) before render
        // renderMenuGridWorkFlow handles its own skeleton overlay internally.
        // getTranslatedName is synchronous — use it directly, no await needed.
        const itemsToRender = parentItems.map(item => ({
            ...item,
            display_name: (selectedLanguage && selectedLanguage !== 'en' && typeof getTranslatedName === 'function')
                ? (getTranslatedName(item.item_no, item.item_name, selectedLanguage, 'item') || item.item_name || item.item_no)
                : (item.item_name || item.item_no)
        }));

        if (signal.aborted) return;

        console.log('🔍 Sample item before renderMenuGrid:', {
            item_no: itemsToRender[0]?.item_no,
            item_name: itemsToRender[0]?.item_name,
            display_name: itemsToRender[0]?.display_name,
            modifierGroups: itemsToRender[0]?.itemmaster_menutype_grpdtls?.length,
            modifierItems: itemsToRender[0]?.itemmaster_menutypedtls?.length,
            sellingUom: itemsToRender[0]?.selling_uom_dtls?.length,
            lowestFromCache: window._lowestPriceCache?.get(itemsToRender[0]?.item_no),
        });

        container.innerHTML = '';
        const sectionEl = document.createElement('div');
        sectionEl.className = 'category-section';
        sectionEl.dataset.categorySection = categoryCode;
        container.appendChild(sectionEl);

        if (typeof renderMenuGrid === 'function') await renderMenuGrid(itemsToRender);
        swapInPooledImages(container);
        currentRenderController = null;

    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('❌ Error in renderCategoryByCodeWorkFlow:', error);
        container.innerHTML = `<p class="text-red-500">Error loading: ${error.message}</p>`;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHOW LOADING SKELETON
// ─────────────────────────────────────────────────────────────────────────────

function showLoadingSkeleton(container, categoryCode) {
    container.innerHTML = '';

    const skeletonSection = document.createElement('div');
    skeletonSection.className = 'category-section';
    skeletonSection.dataset.categorySection = categoryCode;

    for (let i = 0; i < 6; i++) {
        const skeleton = document.createElement('div');
        skeleton.className = 'menu-item skeleton';
        skeleton.style.cssText = `
            height: 320px;
            background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 37%, #f0f0f0 63%);
            background-size: 400% 100%;
            animation: shimmer 1.2s ease-in-out infinite;
            border-radius: 8px;`;
        skeletonSection.appendChild(skeleton);
    }

    container.appendChild(skeletonSection);
}

async function renderFlatGridCategory(categoryCode, selectedLanguage, container, signal) {
    const { items } = useCache();
    const code = categoryCode.trim().toLowerCase();
    const seen = new Set();
    const filteredItems = items.filter(item => {
        if (!item?.item_no || seen.has(item.item_no)) return false;
        if ((item.category_code || "").trim().toLowerCase() !== code) return false;
        seen.add(item.item_no); return true;
    });
    if (signal.aborted) return;
    if (!filteredItems.length) { container.innerHTML = `<p class="text-gray-500">No items found.</p>`; return; }

    const translatedItems = await Promise.allSettled(
        filteredItems.map(async item => {
            try { return { ...item, display_name: await getTranslatedName(item.item_no, item.item_name, selectedLanguage, "item") }; }
            catch { return { ...item, display_name: item.item_name || item.item_no }; }
        })
    );
    if (signal.aborted) return;
    const successfulItems = translatedItems.filter(r => r.status === 'fulfilled').map(r => r.value);
    const sortedItems = MENU_CONFIG.OPTIONS.sortStickyItemsFirst ? sortItemsByMobileSticky(successfulItems) : successfulItems;
    container.innerHTML = '';
    const section = document.createElement('div');
    section.className = 'category-section';
    section.dataset.categorySection = categoryCode;
    container.appendChild(section);
    await renderMenuGrid(sortedItems);
}

async function renderHierarchicalCategory(categoryCode, selectedLanguage, container, signal) {
    const { items, menuItems } = useCache();
    const hierarchy = buildCategoryHierarchy(menuItems || []);
    const subcategories = hierarchy[categoryCode] || [];
    const mainCategoryHasItems = categoryHasVisibleItems(categoryCode, items, true);
    const visibleSubcategories = subcategories.filter(sub => sub.category_code !== 'MAIN' && categoryHasVisibleItems(sub.category_code, items, true));
    container.innerHTML = '';
    const categorySection = document.createElement('div');
    categorySection.className = 'category-section hierarchical';
    container.appendChild(categorySection);
    if (signal.aborted) return;
    if (mainCategoryHasItems && MENU_CONFIG.OPTIONS.showSubcategorySections) {
        const mainHeader = document.createElement('div');
        mainHeader.className = 'subcategory-header main-category-header';
        mainHeader.textContent = await getTranslatedName(categoryCode, categoryCode, selectedLanguage, "category");
        categorySection.appendChild(mainHeader);
    }
    if (mainCategoryHasItems) await renderItemsForCategory(categoryCode, selectedLanguage, categorySection, false);
    if (signal.aborted) return;
    if (visibleSubcategories.length > 0 && MENU_CONFIG.OPTIONS.showSubcategorySections) {
        for (const subCat of visibleSubcategories) {
            if (signal.aborted) return;
            await renderSubcategorySection(subCat.category_code, selectedLanguage, categorySection);
        }
    } else if (!mainCategoryHasItems && visibleSubcategories.length > 0) {
        await renderItemsForCategory(visibleSubcategories[0].category_code, selectedLanguage, categorySection, false);
    }
    if (!mainCategoryHasItems && !visibleSubcategories.length) {
        container.innerHTML = `<div class="text-center p-8 text-gray-500"><p>No items available</p></div>`;
    }
}

async function renderItemsForCategory(categoryCode, selectedLanguage, container, isSubcategory = false) {
    const { items } = useCache();
    const seen = new Set();
    const code = categoryCode.trim().toLowerCase();
    const filteredItems = items.filter(item => {
        if (!item?.item_no || seen.has(item.item_no)) return false;
        const itemCat = String(item.category_code || "").trim().toLowerCase();
        if (!itemCat || itemCat === "null" || itemCat !== code) return false;
        seen.add(item.item_no); return true;
    });
    if (!filteredItems.length) {
        if (!isSubcategory) container.innerHTML = `<p class="text-gray-500">No items found.</p>`;
        return;
    }
    const translatedItems = await Promise.allSettled(
        filteredItems.map(async item => {
            try {
                return {
                    ...item,
                    display_name: await getTranslatedName(
                        item.item_no,
                        item.item_desc || item.item_name,  // ← item_desc first
                        selectedLanguage,
                        "item"
                    )
                };
            } catch {
                return {
                    ...item,
                    display_name: item.item_desc || item.item_no  // ← item_desc first
                };
            }
        })
    );


    const successfulItems = translatedItems.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!successfulItems.length) { if (!isSubcategory) container.innerHTML = `<p class="text-red-500">Failed to load items.</p>`; return; }
    const sortedItems = MENU_CONFIG.OPTIONS.sortStickyItemsFirst ? sortItemsByMobileSticky(successfulItems) : successfulItems;
    const fragment = document.createDocumentFragment();
    for (const item of sortedItems) {
        try { const el = await createMenuItemElement(item); if (el) fragment.appendChild(el); }
        catch (error) { console.error(`Error creating item ${item.item_no}:`, error); }
    }
    container.appendChild(fragment);
}


const shimmerStyle = document.createElement('style');
shimmerStyle.innerHTML = `@keyframes shimmer{0%{background-position:-400% 0}100%{background-position:400% 0}}.menu-item.skeleton{overflow:hidden;}`;
document.head.appendChild(shimmerStyle);

function renderInitialCategory(mainCategories, hierarchyMap, allItems, shouldFilter, tabContainer) {
    if (!mainCategories.length) {
        const menuGrid = document.getElementById("menuGrid");
        if (menuGrid) menuGrid.innerHTML = '<p class="text-gray-500">No menu items available.</p>';
        return;
    }
    const firstCategory = mainCategories[0];
    const visibleSubcats = getVisibleSubcategories(firstCategory.category_code, hierarchyMap, allItems, shouldFilter);
    if (visibleSubcats.length > 0) {
        tabContainer.querySelector(`[data-category="${visibleSubcats[0].category_code}"]`)?.classList.add('active');
        renderCategoryByCode(visibleSubcats[0].category_code);
    } else {
        renderCategoryByCode(firstCategory.category_code);
    }
}

function getCategoryState(categoryCode) { return categoryStateMap.get(categoryCode) || null; }

function updateTime() {
    const el = document.getElementById('currentTime');
    if (el) el.textContent = new Date().toLocaleTimeString();
}

function filterItemsByCategory(items, categoryCode) {
    if (categoryCode === "all") return items;
    return items.filter(item => item.category_code === categoryCode);
}

function setupCategoryTabs(menuItems) {
    document.querySelectorAll("[data-category]").forEach(button => {
        button.addEventListener("click", () => renderMenuGrid(filterItemsByCategory(menuItems, button.dataset.category)));
    });
}

function setupEventListeners() {
    const checkoutBtn = document.getElementById('checkoutBtn');
    if (checkoutBtn) checkoutBtn.addEventListener('click', checkout);
    let inactivityTimer;
    function resetTimer() {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
            if (cart.length > 0 && confirm('Clear cart due to inactivity?')) { cart = []; updateCartDisplay(); }
        }, 300000);
    }
    document.addEventListener('click', resetTimer);
    document.addEventListener('touchstart', resetTimer);
}

function removeFromCart(lineIndex) {
    if (!state?.order?.sales_dtls || lineIndex < 0 || lineIndex >= state.order.sales_dtls.length) { console.warn("removeFromCart: Invalid index", lineIndex); return; }
    state.order.sales_dtls.splice(lineIndex, 1);
    if (state?.order?.orderItems?.orderItems?.sales_dtls) state.order.orderItems.orderItems.sales_dtls.splice(lineIndex, 1);
    updateCartDisplay();
}

document.addEventListener('DOMContentLoaded', () => {
    const cartItems = document.getElementById('cartItems');
    cartItems.addEventListener('click', handleRemoveClick);
    renderCartFromOrder();
});

function updateQuantity(itemId, change) {
    const item = cart.find(i => i.item_no === itemId || i.id === itemId);
    if (item) {
        item.quantity += change;
        if (item.quantity <= 0) removeFromCart(itemId);
        else updateCartDisplay();
    }
}

function applyTakeawayCharges(currentOrder) {
    if (!currentOrder?.sales_dtls?.length) return currentOrder;

    // Strip all existing takeaway charge items so takeaway() rebuilds them cleanly
    const strippedDtls = currentOrder.sales_dtls.filter((i) => !isTakeawayItem(i));

    // Collect parent-level items that are flagged as takeaway
    const takeawayItems = strippedDtls.filter(
        (i) => i.take_away_item === "Y" && i.ds_no === 1
    );

    // Feed each takeaway item through takeaway() in batch mode, chaining the
    // returned order snapshot so every iteration sees the latest s_no sequence.
    const updatedOrder = takeawayItems.reduce(
        (orderAcc, item) =>
            // Pass item with take_away_item "N" so the toggle inside takeaway()
            // flips it back to "Y" and adds the charge row
            takeaway({ ...item, take_away_item: "N" }, orderAcc),
        { ...currentOrder, sales_dtls: strippedDtls }
    );

    return updatedOrder;
}

async function convertToTakeaway(sNo) {
    try {
        if (!sNo) return;
        const { order, setOrder } = useOrder();
        if (!order?.sales_dtls) return;
        const orderItem = order.sales_dtls.find(i => String(i.s_no) === String(sNo));
        if (!orderItem) return;

        window._manualOrderUpdate = true;
        window._blockWSSync = true;

        const updatedSales = order.sales_dtls.map(i => {
            if (String(i.s_no) === String(sNo) || String(i.parent_sno) === String(sNo)) {
                const isNowTakeaway = (i.take_away_item || 'N') === 'N';
                return { ...i, take_away_item: isNowTakeaway ? 'Y' : 'N', is_apply_svc: isNowTakeaway ? 0 : 1, svc_amt: 0, tax_amt: 0 };
            }
            return i;
        });

        const updatedOrder = applyTakeawayCharges({ ...order, sales_dtls: updatedSales });
        setOrder(updatedOrder);

        try { await updateOrderCacheOnServer(); console.log('✅ Takeaway status synced'); }
        catch (syncError) { console.error('❌ Sync failed:', syncError); }
    } catch (error) {
        console.error('❌ Error in convertToTakeaway:', error);
    } finally {
        setTimeout(() => {
            window._manualOrderUpdate = false;
            window._blockWSSync = false;
            renderCartFromOrder?.();
            updateCartCount?.();
        }, 500);
    }
}


if (typeof GetHomeAPI !== 'undefined') {
    GetHomeAPI.convertToTakeaway = convertToTakeaway;
} else if (typeof window !== 'undefined') {
    window.convertToTakeaway = convertToTakeaway;
}

async function applyVoucherToOrder(voucherData) {
    console.log('🎟️ Applying voucher:', voucherData);

    const orderObj = useOrder();
    if (!orderObj || !orderObj.order) {
        console.error('❌ No order found');
        return { success: false, message: 'No order found' };
    }

    const order = orderObj.order;
    const subtotal = parseFloat(order.sub_total || 0);

    // ✅ Calculate voucher discount
    let voucherDiscount = 0;
    if (voucherData.voucher_type === 'P' || voucherData.voucher_type === '%') {
        // Percentage discount
        voucherDiscount = (subtotal * parseFloat(voucherData.voucher_value)) / 100;
    } else {
        // Fixed amount discount
        voucherDiscount = parseFloat(voucherData.voucher_value);
    }

    // Cap discount at subtotal
    if (voucherDiscount > subtotal) {
        voucherDiscount = subtotal;
    }

    console.log('💰 Voucher calculation:', {
        subtotal,
        type: voucherData.voucher_type,
        value: voucherData.voucher_value,
        discount: voucherDiscount
    });

    // ✅ Update order with voucher information
    const updatedOrder = {
        ...order,
        // ✅ ADD THESE CRITICAL FIELDS
        voucher_code: voucherData.voucher_code,
        voucher_name: voucherData.voucher_name || voucherData.voucher_code,
        voucher_discount: voucherDiscount.toFixed(2),
        voucher_type: voucherData.voucher_type,
        voucher_value: voucherData.voucher_value,
        voucher_id: voucherData.voucher_id || voucherData.id,

        // Update total discount
        total_disc: (parseFloat(order.total_disc || 0) + voucherDiscount).toFixed(2),
    };

    // ✅ Recalculate order amounts using your POS function
    const { calcOrderAmt } = window;
    let finalOrder;

    if (calcOrderAmt) {
        finalOrder = calcOrderAmt(updatedOrder, updatedOrder.sales_dtls);
    } else {
        // Manual calculation if calcOrderAmt not available
        const newNetAmt = subtotal - voucherDiscount +
            parseFloat(order.total_svc || 0) +
            parseFloat(order.total_tax || 0);
        finalOrder = {
            ...updatedOrder,
            net_amt: newNetAmt.toFixed(2)
        };
    }

    console.log('✅ Final order with voucher:', {
        voucher_code: finalOrder.voucher_code,
        voucher_discount: finalOrder.voucher_discount,
        total_disc: finalOrder.total_disc,
        net_amt: finalOrder.net_amt
    });

    // Save updated order
    orderObj.setOrder(finalOrder);

    // Re-render cart
    renderCartFromOrder();

    return {
        success: true,
        message: 'Voucher applied successfully',
        discount: voucherDiscount
    };
}

function flyToCart(btn) {
    const cartTarget =
        document.querySelector('.nav-item[onclick="toggleCart()"] .cart-icon') ||
        document.querySelector('.nav-item[onclick="toggleCart()"]') ||
        document.querySelector('.bottom-nav') ||
        document.getElementById('cartBadge');

    const from = btn.getBoundingClientRect();
    const startX = from.left + from.width / 2;
    const startY = from.top + from.height / 2;

    // ✅ If target is hidden (first add), fall back to bottom-center of screen
    let endX, endY;
    if (cartTarget) {
        const to = cartTarget.getBoundingClientRect();
        if (to.width > 0 || to.height > 0) {
            endX = to.left + to.width / 2;
            endY = to.top + to.height / 2;
        }
    }
    if (!endX && !endY) {
        endX = window.innerWidth / 2;
        endY = window.innerHeight - 40; // ~bottom nav area
    }

    console.log('🎯 Fly from:', Math.round(startX), Math.round(startY), '→ to:', Math.round(endX), Math.round(endY));

    // Perpendicular arc control point
    const dx = endX - startX;
    const dy = endY - startY;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const bow = dist * 0.35;
    const cx = (startX + endX) / 2 + (-dy / dist) * bow;
    const cy = (startY + endY) / 2 + (dx / dist) * bow;

    // Ripple ring
    const ring = document.createElement('div');
    ring.style.cssText = `
        position:fixed; z-index:9998; pointer-events:none;
        width:60px; height:60px; border-radius:999px;
        border:3px solid #3b82f6; opacity:0.8; transform:scale(0.5);
        left:${startX - 30}px; top:${startY - 30}px;
        transition: opacity 0.5s ease, transform 0.5s ease;
    `;
    document.body.appendChild(ring);
    requestAnimationFrame(() => {
        ring.style.opacity = '0';
        ring.style.transform = 'scale(2.2)';
    });
    setTimeout(() => ring.remove(), 520);

    // Ghost bubble
    const ghost = document.createElement('div');
    const imgEl = btn.closest('.menu-item')?.querySelector('.item-image img');
    ghost.style.cssText = `
        position:fixed; z-index:9999; pointer-events:none;
        width:52px; height:52px; border-radius:999px;
        overflow:hidden; border:3px solid #3b82f6;
        left:${startX - 26}px; top:${startY - 26}px;
        box-shadow:0 4px 16px rgba(59,130,246,0.45);
    `;
    ghost.innerHTML = imgEl
        ? `<img src="${imgEl.src}" style="width:100%;height:100%;object-fit:cover;">`
        : `<div style="width:100%;height:100%;background:#3b82f6;"></div>`;
    document.body.appendChild(ghost);

    const duration = 650;
    const startTime = performance.now();

    function step(now) {
        const t = Math.min((now - startTime) / duration, 1);
        const bx = (1 - t) * (1 - t) * startX + 2 * (1 - t) * t * cx + t * t * endX;
        const by = (1 - t) * (1 - t) * startY + 2 * (1 - t) * t * cy + t * t * endY;

        ghost.style.transform = `translate(${bx - startX}px, ${by - startY}px) scale(${1 - 0.75 * t})`;
        ghost.style.opacity = t < 0.75 ? 1 : 1 - ((t - 0.75) / 0.25);

        if (t < 1) requestAnimationFrame(step);
        else { ghost.remove(); triggerCartArrival(); }
    }
    requestAnimationFrame(step);
}


function triggerCartArrival() {
    // Shake the cart icon
    const cartIcon = document.querySelector('.nav-item[onclick="toggleCart()"] .nav-icon');
    if (cartIcon) {
        cartIcon.style.animation = 'none';
        void cartIcon.offsetWidth;
        cartIcon.style.animation = 'cart-shake 0.4s ease';
    }
    // Pop badge (call your existing updateCartCount, it will update the number)
    const badge = document.getElementById('cartBadge');
    if (badge) {
        badge.style.transition = 'none';
        badge.style.transform = 'scale(1.7)';
        setTimeout(() => {
            badge.style.transition = 'transform 0.3s cubic-bezier(0.34,1.56,0.64,1)';
            badge.style.transform = 'scale(1)';
        }, 10);
    }
}

//export function updateCartCount() {


//    console.log('🔢 updateCartCount called');

//    const orderObj = useOrder();
//    const order = orderObj?.order;

//    // 1. Initial Null Check
//    if (!order || !order.sales_dtls) {
//        hideCartUI();
//        return;
//    }

//    const salesDtls = order.sales_dtls || [];

//    // 2. Combined Logic: Deduplicate and Identify Base Food Items
//    // We do this in one pass to keep the UI snappy
//    const seen = new Set();
//    const baseFoodItems = salesDtls.filter(i => {
//        const key = `${i.s_no ?? ''}-${i.item_no ?? ''}`;

//        // Skip if we've seen this specific line item already
//        if (seen.has(key)) return false;
//        seen.add(key);

//        // Check if it's a "Base" item (not a modifier)
//        const isBase = String(i.s_no) === String(i.parent_sno || i.s_no);

//        // Check if it's a real product (not a system charge)
//        const isNotCharge = i.item_no !== 'TAKEAWAY_CHARGE' && i.item_type !== 'CHARGE';

//        return isBase && isNotCharge;
//    });

//    const itemCount = baseFoodItems.length;

//    console.log('🔢 Cart count debug:', {
//        totalRows: salesDtls.length,
//        baseFoodItems: itemCount
//    });

//    // 3. Early Exit for Empty Cart (Ghost Cart Protection)
//    if (itemCount === 0) {
//        console.log('🛒 No food items found. Hiding UI.');
//        hideCartUI();
//        return;
//    }

//    // 4. Update UI for Active Cart
//    const total = parseFloat(order.net_amt || 0);
//    const formattedTotal = `$${total.toFixed(2)}`;

//    const badge = document.getElementById("cartBadge");
//    const subtotalEl = document.getElementById("navSubtotal");
//    const bottomNav = document.querySelector('.bottom-nav');
//    const cartLabel = document.querySelector('.nav-item[onclick="toggleCart()"] .nav-label');

//    if (badge) {
//        badge.style.display = 'flex';
//        badge.textContent = itemCount;

//        // ← add these 4 lines:
//        badge.style.transition = 'none';
//        badge.style.transform = 'scale(1.5)';
//        setTimeout(() => {
//            badge.style.transition = 'transform 0.2s ease';
//            badge.style.transform = 'scale(1)';
//        }, 10);
//    }

//    if (subtotalEl) {
//        subtotalEl.style.display = "block";
//        subtotalEl.textContent = formattedTotal;
//    }

//    if (bottomNav) {
//        bottomNav.style.display = "flex";
//        bottomNav.classList.add('show');
//    }

//    if (cartLabel) {
//        cartLabel.style.display = "none";
//    }

//    console.log('✅ Cart UI updated:', { items: itemCount, total: formattedTotal });
//}


export function updateCartCount() {
    console.log('🔢 updateCartCount called');
    const addonModal = document.getElementById('addonModal');
    const cartModal = document.getElementById('cartModal');
    if (addonModal?.classList.contains('show') || cartModal?.classList.contains('active')) {
        console.log('⏭️ updateCartCount skipped — modal is open');
        return;
    }

    const orderObj = useOrder();
    const order = orderObj?.order;

    if (!order || !order.sales_dtls) {
        hideCartUI();
        return;
    }

    const salesDtls = order.sales_dtls || [];

    // Deduplicate and identify base food items
    const seen = new Set();
    const baseFoodItems = salesDtls.filter(i => {
        const key = `${i.s_no ?? ''}-${i.item_no ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        const isBase = String(i.s_no) === String(i.parent_sno || i.s_no);
        const isNotCharge = i.item_no !== 'TAKEAWAY_CHARGE' && i.item_type !== 'CHARGE';
        return isBase && isNotCharge;
    });

    const itemCount = baseFoodItems.length;
    console.log('🔢 Cart count debug:', { totalRows: salesDtls.length, baseFoodItems: itemCount });

    if (itemCount === 0) {
        console.log('🛒 No food items found. Hiding UI.');
        hideCartUI();
        return;
    }

    const total = parseFloat(order.net_amt || 0);
    const formattedTotal = `$${total.toFixed(2)}`;
    const tableNo = order.table_no || '';
    const svcType = order.service_type_info || '';

    // ── Badge (legacy, keep for anything still reading it) ────────────────────
    const badge = document.getElementById('cartBadge');
    if (badge) {
        badge.style.display = 'flex';
        badge.textContent = itemCount;
        badge.style.transition = 'none';
        badge.style.transform = 'scale(1.5)';
        setTimeout(() => {
            badge.style.transition = 'transform 0.2s ease';
            badge.style.transform = 'scale(1)';
        }, 10);
    }

    // ── Left: item count ──────────────────────────────────────────────────────
    const itemCountEl = document.getElementById('navItemCount');
    if (itemCountEl) {
        itemCountEl.textContent = `${itemCount} item${itemCount !== 1 ? 's' : ''}`;
    }

    //const imgContainer = document.getElementById('navItemImages');
    //if (imgContainer) {
    //    const restaurantLogo = RESTAURANT_CONFIG?.logo || '/img/LIHO-logo.jpg';
    //    const top3 = baseFoodItems.slice(0, 3);
    //    imgContainer.innerHTML = top3.map((item, idx) => {
    //        const rawUrl = item.tqr_image_url || item.item_image || item.image;
    //        let url;

    //        if (rawUrl && rawUrl !== '' && !rawUrl.includes('Logo.png')) {
    //            url = rawUrl.startsWith('public/upload/')
    //                ? `/api/GetImageProxy?imageUrl=${encodeURIComponent(rawUrl)}`
    //                : rawUrl;
    //        } else {
    //            const gMap = window.globalImageMap;
    //            const idKey = String(item.item_no || item.product_code || '');
    //            const nameKey = (item.item_desc || item.item_name || '').trim().toLowerCase();

    //            // ✅ Parent row has no image — check child rows (size variant carries the image)
    //            const childUrl = salesDtls
    //                .filter(c => String(c.parent_sno) === String(item.s_no) &&
    //                    String(c.s_no) !== String(item.s_no))
    //                .reduce((found, c) => {
    //                    if (found) return found;
    //                    const cKey = String(c.item_no || '');
    //                    const cName = (c.item_desc || c.item_name || '').trim().toLowerCase();
    //                    return (cKey && gMap?.get(cKey)) || (cName && gMap?.get(cName)) || null;
    //                }, null);

    //            url = (idKey && gMap?.get(idKey))
    //                || (nameKey && gMap?.get(nameKey))
    //                || childUrl
    //                || restaurantLogo;
    //        }

    //        const zIndex = top3.length - idx;
    //        const offset = idx > 0 ? 'margin-left:-10px;' : '';
    //        return `<img src="${url}" alt=""
    //            class="nav-cart-img"
    //            style="z-index:${zIndex};${offset}"
    //            onerror="this.onerror=null;this.src='${restaurantLogo}';">`;
    //    }).join('');
    //}
    const imgContainer = document.getElementById('navItemImages');
    if (imgContainer) {
        const restaurantLogo = RESTAURANT_CONFIG?.logo || '/img/LIHO-logo.jpg';
        const top3 = baseFoodItems.slice(0, 4);
        imgContainer.innerHTML = top3.map((item, idx) => {
            const rawUrl = item.tqr_image_url || item.item_image || item.image;
            let url;

            if (rawUrl && rawUrl !== '' && !rawUrl.includes('Logo.png')) {
                url = rawUrl.startsWith('public/upload/')
                    ? `/api/GetImageProxy?imageUrl=${encodeURIComponent(rawUrl)}`
                    : rawUrl;
            } else {
                const gMap = window.globalImageMap;
                const idKey = String(item.item_no || item.product_code || '');
                const nameKey = (item.item_desc || item.item_name || '').trim().toLowerCase();

                // ✅ Parent row has no image — check child rows (size variant carries the image)
                const childUrl = salesDtls
                    .filter(c => String(c.parent_sno) === String(item.s_no) &&
                        String(c.s_no) !== String(item.s_no))
                    .reduce((found, c) => {
                        if (found) return found;
                        const cKey = String(c.item_no || '');
                        const cName = (c.item_desc || c.item_name || '').trim().toLowerCase();
                        return (cKey && gMap?.get(cKey)) || (cName && gMap?.get(cName)) || null;
                    }, null);

                url = (idKey && gMap?.get(idKey))
                    || (nameKey && gMap?.get(nameKey))
                    || childUrl
                    || restaurantLogo;
            }

            const zIndex = top3.length - idx;
            const offset = idx > 0 ? 'margin-left:-12px;' : '';
            return `<img src="${url}" alt=""
                class="nav-cart-img"
                style="z-index:${zIndex};${offset}"
                onerror="this.onerror=null;this.src='${restaurantLogo}';">`;
        }).join('');
    }

    // ── Right: total + service info ───────────────────────────────────────────
    const subtotalEl = document.getElementById('navSubtotal');
    if (subtotalEl) {
        subtotalEl.style.display = 'block';
        subtotalEl.textContent = formattedTotal;
    }

    const serviceInfoEl = document.getElementById('navServiceInfo');
    if (serviceInfoEl) {
        serviceInfoEl.textContent = tableNo ? `${svcType} : ${tableNo}` : svcType;
    }

    // ── Show nav ──────────────────────────────────────────────────────────────
    const bottomNav = document.querySelector('.bottom-nav');
    if (bottomNav) {
        bottomNav.style.display = 'flex';
        bottomNav.classList.add('show');
    }

    const cartLabel = document.querySelector('.nav-item[onclick="toggleCart()"] .nav-label');
    if (cartLabel) cartLabel.style.display = 'none';

    console.log('✅ Cart UI updated:', { items: itemCount, total: formattedTotal });
}


// ✅ Helper function to hide cart UI
function hideCartUI() {
    const badge = document.getElementById("cartBadge");
    const subtotalEl = document.getElementById("navSubtotal");
    const cartLabel = document.querySelector('.nav-item[onclick="toggleCart()"] .nav-label');
    const bottomNav = document.querySelector('.bottom-nav');

    if (badge) badge.style.display = "none";
    if (subtotalEl) subtotalEl.style.display = "none";

    // ✅ Add this — clear stale images when cart is empty
    const imgContainer = document.getElementById('navItemImages');
    if (imgContainer) imgContainer.innerHTML = '';

    const itemCountEl = document.getElementById('navItemCount');
    if (itemCountEl) itemCountEl.textContent = '';

    if (bottomNav) {
        bottomNav.style.display = "none";
        bottomNav.classList.remove('show');
        bottomNav.classList.add('hide');

    }

    if (cartLabel) {
        cartLabel.style.display = "block";
        cartLabel.textContent = "Cart";
    }
}



async function handleRemoveClick(e) {
    try {
        const target = e.target.closest('.cart-remove-btn');
        if (!target) return;
        const sNo = target.getAttribute('data-sno');
        if (!sNo) return;

        // ✅ Prevent double-fire: ignore if already processing this s_no
        if (window._removingItems?.has(sNo)) {
            console.log('⏭️ Already removing s_no:', sNo, '— ignoring duplicate click');
            return;
        }
        window._removingItems = window._removingItems || new Set();
        window._removingItems.add(sNo);

        const { order } = useOrder();
        if (!order || !Array.isArray(order.sales_dtls)) {
            window._removingItems.delete(sNo);
            return;
        }

        console.log('🗑️ Remove button clicked for s_no:', sNo);

        const orderItem = order.sales_dtls.find(item => String(item.s_no) === String(sNo));
        if (!orderItem) {
            console.error('❌ Item not found:', sNo);
            window._removingItems.delete(sNo);
            return;
        }

        const activeVoucherCode = order.voucher_code || null;
        await deleteIndividualItem(orderItem);

        if (activeVoucherCode) {
            console.log('🧹 Clearing voucher after item removal:', activeVoucherCode);
            await removeVoucherAndRecalculate(activeVoucherCode);
        }

        setTimeout(() => {
            if (typeof renderCartFromOrder === 'function') renderCartFromOrder();
            if (typeof updateCartCount === 'function') updateCartCount();
            window._removingItems.delete(sNo);
        }, 50);

    } catch (error) {
        console.error('❌ Error in handleRemoveClick:', error);
        if (typeof renderCartFromOrder === 'function') {
            setTimeout(renderCartFromOrder, 100);
        }
        window._removingItems?.delete(target?.getAttribute('data-sno'));
    }
}

function removeItemByLineId(lineId) {
    const { order, setOrder } = useOrder();
    if (!order || !Array.isArray(order.sales_dtls)) return;

    const filteredSales = order.sales_dtls.filter(item => item.line_id !== lineId);

    const updatedOrder = {
        ...order,
        sales_dtls: filteredSales,
        orderItems: {
            orderItems: {
                sales_dtls: filteredSales
            }
        }
    };

    setOrder(updatedOrder);
    renderCartFromOrder();
}



// Additional utility function for better quantity updates
function updateQuantityByIndex(index, change) {
    const orderObj = useOrder();
    if (!orderObj || !orderObj.order) return;

    const mainSales = Array.isArray(orderObj.order?.sales_dtls) ? orderObj.order.sales_dtls : [];
    const nestedSales = Array.isArray(orderObj.orderItems?.orderItems?.sales_dtls)
        ? orderObj.orderItems.orderItems.sales_dtls
        : [];

    const allSales = [...mainSales, ...nestedSales];

    if (index < 0 || index >= allSales.length) {
        console.error('Invalid index for quantity update:', index);
        return;
    }

    const itemToUpdate = allSales[index];
    const idToUpdate = itemToUpdate.s_no || itemToUpdate.item_no;

    // Find and update in both arrays
    const mainItem = mainSales.find(item => (item.s_no || item.item_no) === idToUpdate);
    const nestedItem = nestedSales.find(item => (item.s_no || item.item_no) === idToUpdate);

    if (mainItem) {
        const newQty = Math.max(1, (mainItem.order_qty || 1) + change);
        mainItem.order_qty = newQty;

        // Recalculate sub_total
        const itemPrice = Number(mainItem.dine_in_price || mainItem.takeaway_price || mainItem.delivery_price || 0);
        const addonTotal = Array.isArray(mainItem.selectedAddons)
            ? mainItem.selectedAddons.reduce((sum, addon) => sum + (Number(addon.price || 0) * Number(addon.qty || 1)), 0)
            : 0;
        mainItem.sub_total = (itemPrice + addonTotal) * newQty;
    }

    if (nestedItem) {
        const newQty = Math.max(1, (nestedItem.order_qty || 1) + change);
        nestedItem.order_qty = newQty;

        // Recalculate sub_total for nested item too
        const itemPrice = Number(nestedItem.dine_in_price || nestedItem.takeaway_price || nestedItem.delivery_price || 0);
        const addonTotal = Array.isArray(nestedItem.selectedAddons)
            ? nestedItem.selectedAddons.reduce((sum, addon) => sum + (Number(addon.price || 0) * Number(addon.qty || 1)), 0)
            : 0;
        nestedItem.sub_total = (itemPrice + addonTotal) * newQty;
    }

    // Persist updated order
    try {
        sessionStorage.setItem("order", JSON.stringify(orderObj));
    } catch (error) {
        console.error('Error saving to sessionStorage:', error);
    }

    // Re-render cart
    renderCartFromOrder();
}


function removeItemBySno(sno, addonSnos = []) {
    const orderObj = useOrder();
    if (!orderObj || !orderObj.order) return;

    let sales = orderObj.order.sales_dtls || [];

    // Remove base item
    sales = sales.filter(item => item.s_no !== sno);

    // Remove all related addons if any
    if (addonSnos.length > 0) {
        sales = sales.filter(item => !addonSnos.includes(item.s_no));
    }

    // Persist back
    orderObj.order.sales_dtls = sales;
    try {
        sessionStorage.setItem("order", JSON.stringify(orderObj));
    } catch (err) {
        console.error("Error saving to sessionStorage:", err);
    }

    // Refresh cart
    updateCartDisplay();
}


function updateCartDisplay() {
    renderCartFromOrder();
}

// ✅ NEW: Separate function for deleting individual items from cart
async function deleteIndividualItem(orderItem) {
    try {
        const { order, setOrder } = useOrder();
        const orderItems = order?.sales_dtls || [];

        console.log('🗑️ Deleting individual item:', {
            s_no: orderItem.s_no,
            parent_sno: orderItem.parent_sno,
            item_name: orderItem.item_name
        });

        // ✅ Prevent WebSocket double-sync
        window._manualOrderUpdate = true;

        try {
            // Remove the item itself AND all its children
            const newOrderItems = orderItems.filter(item => {
                // Delete if it's the item itself
                if (String(item.s_no) === String(orderItem.s_no)) {
                    console.log(`  🗑️ Removing: ${item.item_name} (s_no: ${item.s_no})`);
                    return false;
                }
                // Delete if it's a child of this item
                if (String(item.parent_sno) === String(orderItem.s_no)) {
                    console.log(`  🗑️ Removing child: ${item.item_name} (s_no: ${item.s_no})`);
                    return false;
                }
                // Keep all other items
                return true;
            });

            console.log('📦 Items before:', orderItems.length, 'after:', newOrderItems.length);

            // Apply promotions (if needed)
            let finalOrderItems = newOrderItems;
            if (typeof applyPromotions === 'function') {
                const { orderItems: tempOrderItems } = applyPromotions(newOrderItems, orderItem);
                finalOrderItems = tempOrderItems || newOrderItems;
            }

            // Process svc and tax
            if (typeof addTax === 'function') {
                finalOrderItems = finalOrderItems.map(item => addTax(item));
            }

            // Calculate order amounts
            let updatedOrder = { ...order, sales_dtls: finalOrderItems };
            if (typeof calcOrderAmt === 'function') {
                updatedOrder = calcOrderAmt(updatedOrder);
            } else {
                // Fallback: Manual calculation
                const gstRate = parseFloat(sessionStorage.getItem("GST")) || 9;
                const serviceRate = parseFloat(sessionStorage.getItem("ServiceCharge")) || 10;
                const orderType = localStorage.getItem("orderType");
                const isTakeaway = orderType === "T";

                const subTotal = finalOrderItems.reduce((sum, item) =>
                    sum + parseFloat(item.sub_total || 0), 0
                );
                const totalTax = finalOrderItems.reduce((sum, item) =>
                    sum + parseFloat(item.tax_amt || 0), 0
                );
                const totalService = isTakeaway ? 0 : finalOrderItems.reduce((sum, item) =>
                    sum + parseFloat(item.svc_amt || 0), 0
                );
                const netAmount = subTotal + totalTax + totalService;

                updatedOrder.sub_total = subTotal.toFixed(2);
                updatedOrder.total_tax = totalTax.toFixed(2);
                updatedOrder.total_svc = totalService.toFixed(2);
                updatedOrder.net_amt = netAmount.toFixed(2);
            }

            console.log('💰 Updated totals:', {
                sub_total: updatedOrder.sub_total,
                total_tax: updatedOrder.total_tax,
                net_amt: updatedOrder.net_amt,
                items_remaining: updatedOrder.sales_dtls.length
            });

            // Update order state
            setOrder(updatedOrder);

            // Update localStorage
            const existingCache = JSON.parse(localStorage.getItem("order") || '{}');
            const updatedCache = {
                ...existingCache,
                state: {
                    ...existingCache.state,
                    order: updatedOrder,
                    lastSNo: updatedOrder.sales_dtls.length > 0
                        ? Math.max(...updatedOrder.sales_dtls.map(i => parseInt(i.s_no) || 0))
                        : 0
                },
                version: (existingCache.version || 0) + 1
            };
            localStorage.setItem("order", JSON.stringify(updatedCache));

            // ✅ Sync to server using common function
            console.log('📡 Syncing deletion to server...');
            const syncResult = await updateOrderCacheOnServer();

            if (!syncResult.success) {
                console.error('❌ Failed to sync deletion:', syncResult.error);
                if (typeof window.sokWebSocket?.showUpdateNotification === 'function') {
                    window.sokWebSocket.showUpdateNotification(
                        'Sync Error',
                        'Failed to sync deletion to server'
                    );
                }
            } else {
                console.log('✅ Deletion synced successfully');
            }

            console.log('✅ Individual item deleted successfully');
            return updatedOrder;

        } catch (error) {
            console.error('❌ Error in item deletion:', error);
            throw error;
        } finally {
            // Re-enable WebSocket sync
            setTimeout(() => {
                window._manualOrderUpdate = false;
            }, 100);
        }

    } catch (error) {
        console.error('❌ Error in deleteIndividualItem:', error);
        window._manualOrderUpdate = false;
        throw error;
    }
}

export async function emptyCart() {
    const { order, setOrder } = useOrder();
    if (!order || !Array.isArray(order.sales_dtls) || order.sales_dtls.length === 0) {
        return { success: true }; // Already empty
    }

    try {
        window._manualOrderUpdate = true;

        // Clear all items
        const updatedOrder = { ...order, sales_dtls: [], sub_total: "0.00", total_tax: "0.00", total_svc: "0.00", net_amt: "0.00" };

        // Update state
        setOrder(updatedOrder);

        // Update localStorage cache
        const existingCache = JSON.parse(localStorage.getItem("order") || '{}');
        const updatedCache = {
            ...existingCache,
            state: { ...existingCache.state, order: updatedOrder, lastSNo: 0 },
            version: (existingCache.version || 0) + 1
        };
        localStorage.setItem("order", JSON.stringify(updatedCache));

        // Sync to server & WebSocket broadcast
        const syncResult = await updateOrderCacheOnServer();
        if (!syncResult.success) {
            console.error('❌ Failed to sync empty cart:', syncResult.error);
            return { success: false };
        }

        console.log('✅ Cart emptied and synced successfully');
        return { success: true };
    } catch (err) {
        console.error('❌ Error emptying cart:', err);
        return { success: false };
    } finally {
        setTimeout(() => { window._manualOrderUpdate = false; }, 100);
    }
}

async function updateQuantityBySno(sNo, change) {
    try {
        console.log('🔄 updateQuantityBySno called:', { sNo, change });

        const { order, setOrder } = useOrder();
        if (!order || !Array.isArray(order.sales_dtls)) {
            console.warn('Invalid order structure:', order);
            return;
        }

        const currentOrderId = order.server_order_id || order.order_id;
        if (!currentOrderId) {
            console.warn('⚠️ No order ID before update, will fetch/create one');
            const orderId = await getOrCreateOrderId();
            console.log('✅ Order ID ensured:', orderId);
        } else {
            console.log('✅ Current order ID:', currentOrderId);
        }

        const orderItem = order.sales_dtls.find(item => String(item.s_no) === String(sNo));
        if (!orderItem) {
            console.warn('Order item not found for s_no:', sNo);
            return;
        }

        const currentQty = Number(orderItem.qty) || 0;
        const newQty = Math.max(0, currentQty + Number(change));
        console.log(`🔄 Updating s_no ${sNo}: ${currentQty} → ${newQty}`);

        const isBaseItem = String(orderItem.s_no) === String(orderItem.parent_sno || orderItem.s_no);
        if (!isBaseItem) {
            console.warn('⚠️ Cannot update quantity of addon item directly');
            return;
        }

        window._manualOrderUpdate = true;

        // ── Handle deletion ───────────────────────────────────────────────────
        if (newQty <= 0) {
            console.log('⚠️ Quantity is 0, deleting item');

            const appliedVoucherCode = order?.voucher_code;
            if (appliedVoucherCode) {
                console.log('🗑️ Item deleted with voucher active — clearing voucher');
                await removeVoucherAndRecalculate(appliedVoucherCode);
            }

            if (typeof renderCartFromOrder === 'function') renderCartFromOrder();
            if (typeof updateCartCount === 'function') updateCartCount();

            (async () => {
                try {
                    if (typeof deleteIndividualItem === 'function') {
                        await deleteIndividualItem(orderItem);
                    } else if (typeof deleteOrderItem === 'function') {
                        await deleteOrderItem(orderItem);
                    }

                    // ✅ FIX 1: Read post-delete state before syncing
                    const { order: postDeleteOrder } = useOrder();
                    console.log('📡 Syncing deletion...');
                    const syncResult = await updateOrderCacheOnServer(postDeleteOrder);
                    if (!syncResult.success) {
                        console.error('❌ Failed to sync deletion:', syncResult.error);
                    } else {
                        console.log('✅ Deletion synced, order ID:', syncResult.orderId);
                    }
                } catch (error) {
                    console.error('❌ Background sync error:', error);
                } finally {
                    window._manualOrderUpdate = false;
                    // ✅ FIX 2: Drain any blocked WS message after deletion sync
                    window._blockWSSync = false;
                    window.sokWebSocket?.drainPendingCacheUpdate();
                }
            })();

            return;
        }

        // ── Clear stale discount before qty update ────────────────────────────
        const activeVoucherCode = order?.voucher_code;
        if (activeVoucherCode) {
            setOrder({
                ...order,
                sales_dtls: order.sales_dtls.map(item => ({
                    ...item,
                    pro_disc_amt: '0.00',
                    disc_amt: '0.00',
                })),
            });
            console.log('🧹 Cleared pro_disc_amt before qty update');
        }

        const { order: freshOrder } = useOrder();

        // ── Update all rows manually ──────────────────────────────────────────
        const updatedDtls = freshOrder.sales_dtls.map(row => {
            const recomputeTax = (newSubTotal) => {
                const taxRate = parseFloat(row.tax_rate || row.tax_value || 0);
                if (taxRate === 0 || newSubTotal === 0) return '0.000000';
                const shouldAbsorb = freshOrder.absorb_tax === 'Y'
                    || row.is_absorbtax === 1
                    || row.header_is_absorbtax === 'Y';
                const tax = shouldAbsorb
                    ? newSubTotal * taxRate / (100 + taxRate)
                    : newSubTotal * taxRate / 100;
                return tax.toFixed(6);
            };

            if (String(row.s_no) === String(sNo)) {
                const newSubTotal = parseFloat(row.unit_price || 0) * newQty;
                return {
                    ...row,
                    qty: newQty,
                    sub_total: newSubTotal.toFixed(2),
                    tax_amt: recomputeTax(newSubTotal),
                };
            }

            if (String(row.parent_sno) !== String(sNo)) return row;

            if (row._qty_per_serving !== undefined && row._qty_per_serving !== null) {
                const perServing = row._qty_per_serving || 1;
                const scaledQty = newQty * perServing;
                const scaledSubTotal = parseFloat(row.unit_price || 0) * scaledQty;
                console.log(`🔢 Scaled: ${row.item_name} | ${newQty} × ${perServing} = ${scaledQty} | $${scaledSubTotal.toFixed(2)}`);
                return {
                    ...row,
                    qty: scaledQty,
                    sub_total: scaledSubTotal.toFixed(2),
                    tax_amt: recomputeTax(scaledSubTotal),
                    _qty_per_serving: perServing,
                };
            }

            const childSubTotal = parseFloat(row.unit_price || 0) * newQty;
            console.log(`🔄 Child mirrored: ${row.item_name} qty=${newQty}`);
            return {
                ...row,
                qty: newQty,
                sub_total: childSubTotal.toFixed(2),
                tax_amt: recomputeTax(childSubTotal),
            };
        });

        const { setOrder: setFreshOrder } = useOrder();
        setFreshOrder({ ...freshOrder, sales_dtls: updatedDtls });
        console.log(`✅ Manual qty update complete for s_no: ${sNo} → newQty: ${newQty}`);

        // ── Block WebSocket from overwriting local state ──────────────────────
        window._blockWSSync = true;
        // ✅ FIX 3: drain on release instead of silent clear
        setTimeout(() => {
            window._blockWSSync = false;
            window.sokWebSocket?.drainPendingCacheUpdate();
        }, 5000);

        // ── Snapshot _qty_per_serving before WS sync wipes it ────────────────
        const qtyPerServingSnapshot = new Map();
        const { order: snapOrder } = useOrder();
        (snapOrder?.sales_dtls || []).forEach(row => {
            if (row._qty_per_serving !== undefined) {
                qtyPerServingSnapshot.set(String(row.s_no), row._qty_per_serving);
            }
        });

        if (qtyPerServingSnapshot.size > 0) {
            console.log('📸 Snapshotted _qty_per_serving for', qtyPerServingSnapshot.size, 'rows');

            const rehydrate = () => {
                const { order: syncedOrder, setOrder: setSyncedOrder } = useOrder();
                if (!syncedOrder?.sales_dtls) return;

                const needsUpdate = syncedOrder.sales_dtls.some(row =>
                    qtyPerServingSnapshot.has(String(row.s_no)) &&
                    row._qty_per_serving === undefined
                );

                if (needsUpdate) {
                    setSyncedOrder({
                        ...syncedOrder,
                        sales_dtls: syncedOrder.sales_dtls.map(row => {
                            const perServing = qtyPerServingSnapshot.get(String(row.s_no));
                            return (perServing !== undefined && row._qty_per_serving === undefined)
                                ? { ...row, _qty_per_serving: perServing }
                                : row;
                        }),
                    });
                    console.log('💉 Re-hydrated _qty_per_serving after WS sync');
                }
            };

            document.addEventListener('orderUpdated', rehydrate, { once: true });
            setTimeout(rehydrate, 2000);
        }

        // ── Recalculate order totals ──────────────────────────────────────────
        const { order: recalcOrder, setOrder: setRecalcOrder } = useOrder();
        if (typeof calcOrderAmt === 'function') {
            const recalculated = calcOrderAmt(recalcOrder, recalcOrder.sales_dtls);
            setRecalcOrder(recalculated);
            console.log(`💰 Recalculated totals: sub=${recalculated.sub_total} net=${recalculated.net_amt}`);
        }

        // ── Re-apply or clear voucher after qty change ────────────────────────
        const appliedVoucherCode = freshOrder?.voucher_code || order?.voucher_code;
        if (appliedVoucherCode) {
            console.log('🔄 Qty changed with voucher active — re-evaluating:', appliedVoucherCode);

            let voucher = typeof getAvailableVouchers === 'function'
                ? getAvailableVouchers().find(v => v.code === appliedVoucherCode)
                : null;

            if (!voucher) {
                const cache = useCache?.();
                const rawList = cache?.memberRawData?.data?.VoucherLists
                    || cache?.memberRawData?.VoucherLists
                    || [];
                const rawFound = rawList.find(v => v.VoucherNo === appliedVoucherCode);
                if (rawFound) {
                    console.log('🔄 Voucher rebuilt from raw cache');
                    voucher = {
                        code: rawFound.VoucherNo,
                        name: rawFound.VoucherTypeDescription?.trim() || rawFound.VoucherTypeName || 'Voucher',
                        type: 'issued_reward',
                        posRedeemMethod: rawFound.Type,
                        posRedeemAmount: parseFloat(rawFound.TypeValue || rawFound.BalanceAmt || 0),
                        raw: rawFound,
                    };
                }
            }

            if (voucher) {
                const result = await applyVoucherAndRecalculate(voucher);
                if (result?.success) {
                    console.log('✅ Voucher re-applied after qty change, discount:', result.discount);
                } else if (result?.shouldRemove) {
                    console.log('⚠️ Voucher no longer applicable — clearing');
                    await removeVoucherAndRecalculate(appliedVoucherCode);
                    showToast('Voucher removed — quantity no longer meets requirements', 'info', 'Voucher', 3000);
                }
            } else {
                console.log('⚠️ Applied voucher not found anywhere — clearing');
                await removeVoucherAndRecalculate(appliedVoucherCode);
            }
        }

        if (typeof renderCartFromOrder === 'function') renderCartFromOrder();
        if (typeof updateCartCount === 'function') updateCartCount();

        // ── Sync to server — release block as soon as sync finishes ──────────
        (async () => {
            try {
                const { order: finalOrder } = useOrder();
                console.log('📡 Syncing quantity update...');
                const syncResult = await updateOrderCacheOnServer(finalOrder);
                if (!syncResult.success) {
                    console.error('❌ Sync failed:', syncResult.error);
                } else {
                    console.log('✅ Quantity synced, order ID:', syncResult.orderId);
                }
            } catch (error) {
                console.error('❌ Background sync error:', error);
            } finally {
                setTimeout(() => { window._manualOrderUpdate = false; }, 100);
                // ✅ Release block immediately — don't wait for the 5s timeout
                window._blockWSSync = false;
                window.sokWebSocket?.drainPendingCacheUpdate();
            }
        })();

    } catch (error) {
        console.error('❌ Error in updateQuantityBySno:', error);
        window._manualOrderUpdate = false;
    }
}


window.debugOrderId = async function () {
    console.group('🔍 Complete Order ID Debug');

    const deviceId = localStorage.getItem("sok_device_id");
    const orderType = sessionStorage.getItem("orderType") || "T";

    // 1. Check Zustand
    const { order } = useOrder();
    console.log('1️⃣ Zustand:', {
        server_order_id: order?.server_order_id,
        order_id: order?.order_id,
        has_order: !!order
    });

    // 2. Check localStorage
    const localCache = JSON.parse(localStorage.getItem('order') || '{}');
    console.log('2️⃣ localStorage:', {
        server_order_id: localCache.state?.order?.server_order_id,
        order_id: localCache.state?.order?.order_id
    });

    // 3. Check server cache
    try {
        const cacheResponse = await fetch(`/API/SOKOrder/order-cache/${deviceId}`);
        if (cacheResponse.ok) {
            const cacheData = await cacheResponse.json();
            console.log('3️⃣ Server cache:', {
                orderId: cacheData.cache?.orderId,
                orderDataId: cacheData.cache?.orderData?.server_order_id
            });
        }
    } catch (error) {
        console.error('3️⃣ Server cache error:', error);
    }

    // 4. Check debug endpoint
    try {
        const debugResponse = await fetch(`/API/SOKOrder/debug/order-id/${deviceId}?orderType=${orderType}`);
        if (debugResponse.ok) {
            const debugData = await debugResponse.json();
            console.log('4️⃣ Server debug:', debugData);
        }
    } catch (error) {
        console.error('4️⃣ Server debug error:', error);
    }

    console.groupEnd();
};


// 🎯 Optional: Debounced version for rapid clicks
let qtyUpdateTimeout = null;
async function updateQuantityBySnoDebounced(sNo, change) {
    // Update UI immediately
    await updateQuantityBySno(sNo, change);

    // Clear previous timeout
    if (qtyUpdateTimeout) {
        clearTimeout(qtyUpdateTimeout);
    }

    // Debounce the server sync if user keeps clicking
    qtyUpdateTimeout = setTimeout(() => {
        console.log('🔄 Debounced sync complete');
    }, 500);
}
// Check if an item has legitimate children (modifiers/addons)
function checkForLegitimateChildren(parentItem, allItems) {
    const parentSNo = String(parentItem.s_no);

    // Find potential children
    const potentialChildren = allItems.filter(item =>
        String(item.parent_sno) === parentSNo &&
        String(item.s_no) !== parentSNo
    );

    if (potentialChildren.length === 0) {
        return false;
    }

    // Check if parent has addons or modifiers enabled
    const parentHasAddons = parentItem.is_addon_enable?.toUpperCase() === "Y" &&
        parentItem.add_on_name &&
        parentItem.add_on_name.trim() !== '';

    const parentHasModifiers = Array.isArray(parentItem.itemmaster_menutype_grpdtls) &&
        parentItem.itemmaster_menutype_grpdtls.length > 0;

    // If parent doesn't have addons/modifiers, children are illegitimate
    if (!parentHasAddons && !parentHasModifiers) {
        console.warn(`⚠️ Item ${parentSNo} has children but no addons/modifiers enabled`);
        return false;
    }

    // Check if children are actual modifiers/addons
    const legitimateChildren = potentialChildren.filter(child => {
        // Check if child has modifier_name (indicates it's a modifier)
        const hasModifierName = child.modifier_name && child.modifier_name.trim() !== '';

        // Check if child category differs from parent (modifiers usually have different categories)
        const differentCategory = child.category_code !== parentItem.category_code;

        // Check if child was added as part of addon selection
        const isAddon = child.add_on_name || parentHasAddons;

        // A child is legitimate if it has a modifier_name OR is an addon
        const isLegitimate = hasModifierName || isAddon;

        console.log(`  🔎 Child ${child.s_no} (${child.item_name}):`, {
            hasModifierName,
            modifier_name: child.modifier_name,
            differentCategory,
            isAddon,
            isLegitimate
        });

        return isLegitimate;
    });

    console.log(`🔍 Parent ${parentSNo} analysis:`, {
        potentialChildren: potentialChildren.length,
        legitimateChildren: legitimateChildren.length,
        parentHasAddons,
        parentHasModifiers
    });

    return legitimateChildren.length > 0;
}

// Fallback function if changeItemQuantity is not available
function fallbackUpdateQuantity(sNo, newQty, orderItem, order, hasLegitimateChildren) {
    console.warn('⚠️ Using fallback update method');

    try {
        const { setOrder } = useOrder();
        const currentQty = Number(orderItem.qty) || 0;

        // Determine if this is a parent item with LEGITIMATE children
        const isParentItem = String(orderItem.s_no) === String(orderItem.parent_sno);

        console.log('🔧 Fallback update:', {
            sNo,
            isParent: isParentItem,
            hasLegitimateChildren,
            shouldUpdateChildren: isParentItem && hasLegitimateChildren
        });

        // Update sales details
        const updatedSalesDtls = order.sales_dtls.map(item => {
            const itemSNo = String(item.s_no);
            const itemParentSNo = String(item.parent_sno);
            const targetSNo = String(sNo);

            // Update the target item
            if (itemSNo === targetSNo) {
                const updatedItem = { ...item, qty: newQty };
                updatedItem.sub_total = (Number(updatedItem.unit_price) * newQty).toFixed(2);
                updatedItem.tax_amt = ((Number(updatedItem.sub_total) * Number(updatedItem.tax_rate)) / 100).toFixed(6);

                const svcRate = parseFloat(sessionStorage.getItem("ServiceCharge")) || 10;
                updatedItem.svc_amt = Number(updatedItem.is_apply_svc) === 1
                    ? ((Number(updatedItem.sub_total) * svcRate) / 100).toFixed(6)
                    : "0.000000";

                console.log(`✅ Updated target item ${itemSNo}: qty ${currentQty} → ${newQty}, subtotal: ${updatedItem.sub_total}`);
                return updatedItem;
            }
            // ✅ CRITICAL FIX: Only update children if they are LEGITIMATE
            else if (isParentItem && hasLegitimateChildren && itemParentSNo === targetSNo && itemSNo !== targetSNo) {
                // Double-check this specific child is legitimate
                const childHasModifierName = item.modifier_name && item.modifier_name.trim() !== '';
                const childIsAddon = item.add_on_name && item.add_on_name.trim() !== '';
                const parentHasAddons = orderItem.is_addon_enable?.toUpperCase() === "Y" && orderItem.add_on_name;

                const isLegitimateChild = childHasModifierName || childIsAddon || parentHasAddons;

                if (!isLegitimateChild) {
                    console.warn(`⚠️ Skipping illegitimate child ${itemSNo} (${item.item_name})`);
                    return item; // Don't update
                }

                const baseChildQty = Number(item.qty) / currentQty || 1;
                const childNewQty = baseChildQty * newQty;

                const updatedChild = { ...item, qty: childNewQty };
                updatedChild.sub_total = (Number(updatedChild.unit_price) * childNewQty).toFixed(2);
                updatedChild.tax_amt = ((Number(updatedChild.sub_total) * Number(updatedChild.tax_rate)) / 100).toFixed(6);

                const svcRate = parseFloat(sessionStorage.getItem("ServiceCharge")) || 10;
                updatedChild.svc_amt = Number(updatedChild.is_apply_svc) === 1
                    ? ((Number(updatedChild.sub_total) * svcRate) / 100).toFixed(6)
                    : "0.000000";

                console.log(`✅ Updated legitimate child ${itemSNo}: qty ${item.qty} → ${childNewQty}`);
                return updatedChild;
            }

            // Return all other items unchanged
            return item;
        });

        // Recalculate totals
        const subTotal = updatedSalesDtls.reduce((sum, item) => sum + Number(item.sub_total || 0), 0);
        const totalTax = updatedSalesDtls.reduce((sum, item) => sum + Number(item.tax_amt || 0), 0);
        const totalSvc = updatedSalesDtls.reduce((sum, item) => sum + Number(item.svc_amt || 0), 0);
        const netAmount = subTotal + totalTax + totalSvc - Number(order.total_disc || 0);

        const updatedOrder = {
            ...order,
            sales_dtls: updatedSalesDtls,
            sub_total: subTotal.toFixed(2),
            total_tax: totalTax.toFixed(6),
            total_svc: totalSvc.toFixed(6),
            net_amt: netAmount.toFixed(2)
        };

        setOrder(updatedOrder);
        console.log('✅ Fallback update completed');

    } catch (error) {
        console.error('❌ Fallback update failed:', error);
    }
}

// Usage examples
function handleIncreaseQuantity(sNo) {
    updateQuantityBySno(sNo, 1);
}

function handleDecreaseQuantity(sNo) {
    updateQuantityBySno(sNo, -1);
}

function handleRemoveItem(sNo) {
    // Set quantity to 0 to trigger deletion
    const { order } = useOrder();
    const orderItem = order?.sales_dtls?.find(item => String(item.s_no) === String(sNo));

    if (orderItem && typeof deleteOrderItem === 'function') {
        deleteOrderItem(orderItem);
    } else {
        updateQuantityBySno(sNo, -999);
    }
}

// Export for use in cart rendering
if (typeof window !== 'undefined') {
    window.updateQuantityBySno = updateQuantityBySno;
    window.handleIncreaseQuantity = handleIncreaseQuantity;
    window.handleDecreaseQuantity = handleDecreaseQuantity;
    window.handleRemoveItem = handleRemoveItem;
    window.updateCartCount = updateCartCount;

}


function renderVisibleCategorySections(categories = []) {
    const container = document.getElementById("menuGrid");
    if (!container) return;

    container.innerHTML = '';
    const rendered = new Set();

    function renderCategory(category_code) {
        if (rendered.has(category_code)) return;
        rendered.add(category_code);

        const items = getCategoryItems(category_code);
        if (!items.length) return;

        // 🔴 Skip MAIN completely
        if (category_code === "MAIN") return;

        // Category label
        const label = document.createElement("h2");
        label.className = "text-2xl font-bold text-blue-700 mt-6 mb-3 border-b pb-2";
        label.textContent = category_code; // use actual subcategory code
        container.appendChild(label);

        // Grid layout
        const grid = document.createElement("div");
        grid.className = "menu-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4";

        // ✅ Your item rendering loop here
        items.forEach(item => {
            const id = item.item_no || item.id;
            const emoji = item.emoji || "🍽️";
            const name = item.item_name || item.name || "Unnamed";
            const desc = item.item_desc || item.description || "";
            const price = parseFloat(getPriceByServiceType(item));
            const displayPrice = price > 0
                ? `$${price.toFixed(2)}`
                : `<span class="text-gray-400">Unavailable</span>`;

            const card = document.createElement("div");
            card.className = "menu-item p-4 border rounded shadow";
            card.setAttribute("onclick", `addToCart(${JSON.stringify(item).replace(/'/g, "\\'")})`);

            card.innerHTML = `
                    <div class="item-image text-2xl mb-2">${emoji}</div>
                    <div class="item-info">
                        <h3 class="font-semibold">${name}</h3>
                        <p class="item-description text-sm text-gray-600">${desc}</p>
                        <div class="item-footer flex justify-between items-center mt-2">
                            <span class="item-price font-bold">${displayPrice}</span>
                            <button class="add-btn bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded"
                                onclick="event.stopPropagation(); addToCart('${id}')">
                                Add to Cart
                            </button>
                        </div>
                    </div>
                `;

            grid.appendChild(card);
        });

        container.appendChild(grid);

        // Recursively render subcategories
        const subCategories = getCategories(category_code) || [];
        subCategories.forEach(sub => {
            if (sub?.category_code && sub.category_code !== "MAIN") {
                const isVisible = categories.some(cat =>
                    cat?.category_code === sub.category_code &&
                    cat?.root_category_code === sub.root_category_code
                );
                if (isVisible) {
                    renderCategory(sub.category_code);
                }
            }
        });
    }

    categories.forEach(cat => {
        if (cat?.category_code) {
            renderCategory(cat.category_code);
        }
    });
}



let pendingItem = null;
let selectedAddons = [];
// ✅ Generate key based on item + addon composition
function buildKey(baseItemNo, addons) {
    const addonKeys = (addons || [])
        .map(a => a.item_no)
        .sort()
        .join('|');
    return baseItemNo + '|' + addonKeys;
}
function groupOrderItems(salesDtls) {
    const groups = {};
    salesDtls.forEach(item => {
        const parent = item.parent_sno;
        if (!groups[parent]) groups[parent] = { baseItem: null, addons: [] };
        if (item.s_no === parent) {
            groups[parent].baseItem = item;
        } else {
            groups[parent].addons.push(item);
        }
    });

    // Filter out groups without a base item
    return Object.values(groups).filter(group => group.baseItem != null);
}


let isAddingToCart = false; // Optional safety lock


// Gather all selected addon items from the modal
window.GetHomeAPI = window.GetHomeAPI || {};

let lastSno = 1000;
function generateSno() { return ++lastSno; }

// Gather selected addons from modal
function gatherSelectedAddonsFromModal() {
    const modal = document.getElementById('addonModalContent');
    if (!modal) return [];
    const selectedAddons = [];

    // Handle qty-control items
    modal.querySelectorAll('.qty-control').forEach(ctrl => {
        const qtySpan = ctrl.querySelector('.qty-count');
        const qty = parseInt(qtySpan?.textContent || '0', 10);
        if (qty > 0) {
            const itemId = ctrl.dataset.itemId;
            const category = ctrl.dataset.category || '';

            // Get from data attributes (using camelCase dataset properties)
            const item_name = ctrl.dataset.itemName || '';
            const price = parseFloat(ctrl.dataset.price || '0');

            selectedAddons.push({ item_no: itemId, item_name, qty, price, category });
        }
    });

    // Handle checkbox items
    modal.querySelectorAll('input.addon-checkbox:checked, input[type="checkbox"]:checked').forEach(checkbox => {
        // Skip if already processed as a qty-control item
        if (checkbox.closest('.qty-control')) return;

        const itemId = checkbox.value;
        const category = checkbox.dataset.categoryCode || '';

        // Get from data attributes (using camelCase dataset properties)
        const item_name = checkbox.dataset.itemName || checkbox.dataset.modifierName || '';
        const price = parseFloat(checkbox.dataset.price || '0');

        let qty = 1;
        // Check for associated qty-control
        const parentLabel = checkbox.closest('.addon-label') || checkbox.parentElement;
        const qtyControl = parentLabel?.querySelector('.qty-control');
        if (qtyControl) {
            const qtySpan = qtyControl.querySelector('.qty-count');
            qty = parseInt(qtySpan?.textContent || '1', 10);
        }

        selectedAddons.push({ item_no: itemId, item_name, qty, price, category });
    });

    //console.log('Gathered addons:', selectedAddons);
    return selectedAddons;
}

function gatherSelectedRemarksFromModal() {
    const selectedRemarks = [];

    // Only gather from VISIBLE remark sections
    document.querySelectorAll('.remark-section:not([style*="display: none"]) .addon-checkbox.remark-checkbox:checked').forEach(checkbox => {
        const remarkGroup = checkbox.dataset.remarkGroup;
        const remarkText = checkbox.dataset.remarkText;
        const seqNo = checkbox.value;

        // Find which parent category this remark belongs to
        const remarkSection = checkbox.closest('.remark-section');
        const parentCategory = remarkSection?.dataset.parentCategory;

        selectedRemarks.push({
            remarks_group: remarkGroup,
            remarks: remarkText,
            remarks_item_name: remarkText,
            seq_no: seqNo,
            parent_category: parentCategory
        });
    });

    console.log('📝 Gathered remarks from modal:', selectedRemarks);
    return selectedRemarks;
}

// Helper function to create updateRemarksVisibility - place this BEFORE showAddOnModal
function createUpdateRemarksVisibilityFunction(allPossibleRemarks, itemRemarksCache) {
    // --- SAFELY EXTRACT REMARKS ARRAY ---
    let remarksArray = [];

    if (Array.isArray(itemRemarksCache)) {
        remarksArray = itemRemarksCache;
    } else if (itemRemarksCache && typeof itemRemarksCache === 'object') {
        if (Array.isArray(itemRemarksCache.remarks)) {
            remarksArray = itemRemarksCache.remarks;
        } else if (Array.isArray(itemRemarksCache.itemRemarksCache)) {
            remarksArray = itemRemarksCache.itemRemarksCache;
        } else if (Array.isArray(itemRemarksCache.data)) {
            remarksArray = itemRemarksCache.data;
        } else {
            console.warn('⚠️ itemRemarksCache is an object but no array property found:', itemRemarksCache);
        }
    } else {
        console.warn('⚠️ itemRemarksCache is not an array or object, using empty array', itemRemarksCache);
    }

    console.log(`📦 Remarks array length: ${remarksArray.length}`);

    // Return the actual visibility updater
    return function updateRemarksVisibility() {
        const remarkSections = document.querySelectorAll('.remark-section');

        console.log('🔄 updateRemarksVisibility called');
        console.log('📝 Found remark sections:', remarkSections.length);

        const selectedItemsByCategory = new Map();

        // Get selected addon items (checkboxes)
        document.querySelectorAll('.addon-category[data-type="addon"] .addon-checkbox:not(.remark-checkbox):checked').forEach(cb => {
            const itemNo = cb.value;
            const categoryCode = cb.dataset.categoryCode || cb.dataset.modifierName;

            if (itemNo && categoryCode) {
                if (!selectedItemsByCategory.has(categoryCode)) {
                    selectedItemsByCategory.set(categoryCode, new Set());
                }
                selectedItemsByCategory.get(categoryCode).add(itemNo);
                console.log(`➕ Addon selected: ${itemNo} in category ${categoryCode}`);
            }
        });

        // Get selected modifier items (qty > 0)
        document.querySelectorAll('.addon-category[data-type="modifier"] .qty-count').forEach(qtyEl => {
            const qty = parseInt(qtyEl.textContent, 10) || 0;
            if (qty > 0) {
                const qtyControl = qtyEl.closest('.qty-control');
                const itemNo = qtyControl?.closest('[data-item-no]')?.dataset.itemNo;
                const categoryCode = qtyControl?.dataset.category;

                if (itemNo && categoryCode) {
                    if (!selectedItemsByCategory.has(categoryCode)) {
                        selectedItemsByCategory.set(categoryCode, new Set());
                    }
                    selectedItemsByCategory.get(categoryCode).add(itemNo);
                    console.log(`➕ Modifier selected: ${itemNo} in category ${categoryCode} (qty: ${qty})`);
                }
            }
        });

        // Determine which remark groups should be visible
        const visibleRemarksByCategory = new Map();
        selectedItemsByCategory.forEach((itemNos, categoryCode) => {
            itemNos.forEach(itemNo => {
                const itemRemarks = remarksArray.find(r =>
                    String(r.item_no).trim() === String(itemNo).trim()
                );

                if (itemRemarks?.remarks_item_details) {
                    itemRemarks.remarks_item_details.forEach(remarkGroup => {
                        if (remarkGroup.remarks_group) {
                            if (!visibleRemarksByCategory.has(categoryCode)) {
                                visibleRemarksByCategory.set(categoryCode, new Set());
                            }
                            visibleRemarksByCategory.get(categoryCode).add(remarkGroup.remarks_group);
                        }
                    });
                }
            });
        });

        // --- SINGLE LOOP FOR VISIBILITY ---
        let shownCount = 0;
        remarkSections.forEach(section => {
            // 1. Check for Base Remarks (Always Show)
            if (section.dataset.baseRemark === 'true') {
                section.style.display = 'block';
                shownCount++;
                return; // Move to next section immediately
            }

            // 2. Logic for Addon-dependent Remarks
            const remarkGroup = section.dataset.remarkGroup;
            const parentCategory = section.dataset.parentCategory;

            const shouldBeVisible = visibleRemarksByCategory.has(parentCategory) &&
                visibleRemarksByCategory.get(parentCategory).has(remarkGroup);

            const isCurrentlyVisible = section.style.display !== 'none';

            if (shouldBeVisible) {
                section.style.display = 'block';
                shownCount++;
                console.log(`✅ SHOWING: "${remarkGroup}" for category "${parentCategory}"`);
            } else {
                // Clear selection if we are hiding a section that was open
                if (isCurrentlyVisible) {
                    console.log(`❌ HIDING and clearing: "${remarkGroup}"`);
                    section.querySelectorAll('.addon-checkbox').forEach(cb => {
                        cb.checked = false;
                        cb.closest('.addon-label')?.classList.remove('selected');
                    });
                }
                section.style.display = 'none';
            }
        });

        console.log(`📊 Total remark sections shown: ${shownCount}/${remarkSections.length}`);

        if (typeof validateAddToCart === 'function') {
            validateAddToCart();
        }
    };
}

function getItemPrice(item) {
    if (!item) return 0;

    // Try top-level prices first (dine_in_price, takeaway_price, unit_price)
    const topLevelPrice = parseFloat(item.dine_in_price || item.takeaway_price || item.unit_price || 0);

    if (topLevelPrice > 0) {
        console.log(`✅ Using top-level price for ${item.item_name || item.item_no}: $${topLevelPrice}`);
        return topLevelPrice;
    }

    // If top-level prices are 0 or undefined, check selling_uom_dtls
    const sellingPrice = item.selling_uom_dtls?.[0]?.price_dtls?.[0]?.dine_in_price
        || item.selling_uom_dtls?.[0]?.price_dtls?.[0]?.takeaway_price;

    if (sellingPrice && sellingPrice > 0) {
        console.log(`✅ Using selling_uom_dtls price for ${item.item_name || item.item_no}: $${sellingPrice}`);
        return parseFloat(sellingPrice);
    }

    // Final fallback to 0
    console.warn(`⚠️ No valid price found for ${item.item_name || item.item_no}, using 0`);
    return 0;
}


export function addToCart(itemId, selectedAddons = [], selectedRemarks = [], editingOrderItemSNo = null, fromModal = false, isFreeItem = false) {
    console.log('addToCart called:', itemId, selectedAddons.length, selectedRemarks.length, 'editing:', editingOrderItemSNo, 'free:', isFreeItem);
    console.log('📝 selectedRemarks received:', selectedRemarks);

    // Prevent duplicate calls — but skip debounce for free items
    if (!isFreeItem) {
        if (window.isAddingToCart) {
            console.warn('🚫 addToCart already in progress, skipping:', itemId);
            return;
        }
        window.isAddingToCart = true;
        setTimeout(() => { window.isAddingToCart = false; }, 1500);
    }

    const cache = useCache() || {};
    const { order, setOrder, lastSNo, setLastSNo } = useOrder();
    const items = cache.items || [];

    // ==================== FIND + ENHANCE ITEM ====================
    let item = items.find(i => i.item_no === itemId || i.id === itemId);
    if (!item && window.menuGridItems) {
        item = window.menuGridItems.find(i => i.item_no === itemId || i.id === itemId);
    }
    if (!item) {
        return console.warn("Item not found:", itemId);
    }

    item = {
        ...item,
        comp_code: item.comp_code || '01',
        qty: item.qty || 1,
        unit_price: parseFloat(item.unit_price || item.price || 0),
        price: parseFloat(item.price || item.unit_price || 0),
        net_amt: parseFloat(item.net_amt || item.price || 0),
        sub_total: parseFloat(item.sub_total || item.price || 0),
        sales_dtls: item.sales_dtls || [],
        addons: item.addons || [],
        remarks: item.remarks || [],
        itemmaster_menutype_grpdtls: item.itemmaster_menutype_grpdtls || [],
        is_addon_enable: (item.is_addon_enable || 'N').toUpperCase(),
        isAvailable: true,
        item_desc: item.item_desc || item.item_name || ''
    };

    // ==================== ENRICH WITH MODIFIER DATA ====================
    const cacheItems = useCache()?.items || [];
    let enrichedItems = cacheItems;
    if (!enrichedItems.length) {
        const menuSections = useCache()?.menuItems || [];
        enrichedItems = menuSections.flatMap(s =>
            s.items || s.category?.flatMap(c => c.items || []) || []
        );
        if (enrichedItems.length) {
            console.warn('⚠️ cache.items empty — using menuItems fallback:', enrichedItems.length);
        }
    }

    const cacheItem = enrichedItems.find(i => i.item_no === itemId);
    const gridItem = window.menuGridItems?.find(i => i.item_no === itemId);

    item = {
        ...item,
        itemmaster_menutype_grpdtls: (
            cacheItem?.itemmaster_menutype_grpdtls?.length ? cacheItem.itemmaster_menutype_grpdtls :
                gridItem?.itemmaster_menutype_grpdtls?.length ? gridItem.itemmaster_menutype_grpdtls :
                    item.itemmaster_menutype_grpdtls || []
        ),
        itemmaster_menutypedtls: (
            cacheItem?.itemmaster_menutypedtls?.length ? cacheItem.itemmaster_menutypedtls :
                gridItem?.itemmaster_menutypedtls?.length ? gridItem.itemmaster_menutypedtls :
                    item.itemmaster_menutypedtls || []
        ),
        is_addon_enable: cacheItem?.is_addon_enable || gridItem?.is_addon_enable || item.is_addon_enable || 'N',
        add_on_name: cacheItem?.add_on_name || gridItem?.add_on_name || item.add_on_name || '',
    };

    console.log('🔍 Item enrichment:', {
        item_no: item.item_no,
        foundInCache: !!cacheItem,
        foundInGrid: !!gridItem,
        modifierGroups: item.itemmaster_menutype_grpdtls?.length,
        modifierItems: item.itemmaster_menutypedtls?.length,
        is_addon_enable: item.is_addon_enable,
    });
    // ==================== END ENRICH ====================

    // ==================== REMARKS & FEATURE DETECTION ====================
    let allItemRemarks = cache.itemRemarks || [];

    if (typeof allItemRemarks === 'string') {
        try { allItemRemarks = JSON.parse(allItemRemarks); } catch { allItemRemarks = []; }
    }
    if (!Array.isArray(allItemRemarks)) {
        allItemRemarks = Object.values(allItemRemarks);
    }

    const orderType = localStorage.getItem("orderType") || "Q";
    const isTakeawayLocal = orderType === "T" ? "Y" : "N";
    const isServiceExempt = (orderType === "T" || orderType === "Q");

    const remarksEntry = allItemRemarks.find(r =>
        r.item_no === item.item_no ||
        r.item_no === itemId ||
        r?.item?.item_no === item.item_no
    );

    const hasAddons = item.is_addon_enable === "Y";
    const hasRemarks = Array.isArray(remarksEntry?.remarks_item_details) && remarksEntry.remarks_item_details.length > 0;
    const hasModifierGroups = Array.isArray(item.itemmaster_menutype_grpdtls) && item.itemmaster_menutype_grpdtls.length > 0;

    // ==================== SHOW MODAL IF NEEDED ====================
    let showModal = false;
    if (!fromModal && !editingOrderItemSNo && !isFreeItem) {
        if ((hasAddons && selectedAddons.length === 0) ||
            (hasRemarks && selectedRemarks.length === 0) ||
            (hasModifierGroups && selectedAddons.length === 0)) {
            showModal = true;
        }
    }

    if (showModal) {
        if (window.modalState) window.modalState.addonOpen = true;
        const bottomNav = document.querySelector('.bottom-nav');
        if (bottomNav) bottomNav.style.display = 'none';
        window._blockWSSync = true;
        const addonData = hasAddons ? getAddonsByAddOnName(item.add_on_name) : { cat_dtls: [], item_dtls: [] };
        const enrichedCatDtls = (addonData.cat_dtls || []).map(grp => {
            if (!grp.category_code) {
                const matchedItem = addonData.item_dtls.find(i => i.modifier_name === grp.modifier_name && i.category_code);
                if (matchedItem) grp.category_code = matchedItem.category_code;
            }
            grp.item_dtls = getAvailableAddonItems(addonData, grp);
            return grp;
        });
        showAddOnModal(item, (chosenAddons, chosenRemarks) => {
            addToCart(itemId, chosenAddons || [], chosenRemarks || [], editingOrderItemSNo, true);
        }, { ...addonData, cat_dtls: enrichedCatDtls }, remarksEntry ? remarksEntry.remarks_item_details : []);
        return;
    }

    if (fromModal) {
        window.selectedAddons = [];
        window.currentBaseItemId = null;
        window.tempAddonCache = [];
    }

    let newLastSNo = Math.max(
        order?.lastSNo || 0,
        order?.sales_dtls?.length > 0
            ? Math.max(...order.sales_dtls.map(i => parseInt(i.s_no) || 0))
            : 0
    );

    // ==================== HELPER FUNCTIONS ====================
    function extractRemarkText(r) {
        if (!r) return '';
        if (typeof r === 'string') return r.trim();
        const raw = r.remarks_item_name ?? r.remarks ?? r.remarkText ?? '';
        return String(raw).trim();
    }

    function buildRemarksText(remarks) {
        return remarks
            .map(extractRemarkText)
            .filter(text => text.length > 0)
            .join(', ');
    }

    // ==================== TOPPING DETECTION HELPER ====================
    function isTopping(item) {
        return (item.uom || '').toUpperCase() === 'TOPPING' ||
            (item.category_code || '').toUpperCase() === 'EXTRA OPTIONS';
    }

    const resultItems = [];

    // ==================== EDIT MODE ====================
    if (editingOrderItemSNo) {
        console.log('EDIT MODE - Editing item s_no:', editingOrderItemSNo);
        const originalItem = order.sales_dtls.find(i => i.s_no == editingOrderItemSNo);
        if (!originalItem) {
            console.error('Original item not found for s_no:', editingOrderItemSNo);
            return;
        }

        if (originalItem.remarks !== undefined && typeof originalItem.remarks !== 'string') {
            originalItem.remarks = String(originalItem.remarks ?? '');
        }

        const parentSNo = editingOrderItemSNo;
        const remarksByParentCategory = {};
        selectedRemarks.forEach(r => {
            const parentCat = r.parent_category || '';
            if (parentCat) {
                if (!remarksByParentCategory[parentCat]) remarksByParentCategory[parentCat] = [];
                remarksByParentCategory[parentCat].push(r);
            }
        });

        const parentPrice = hasModifierGroups ? 0 : getItemPrice(item);
        const parentSubTotal = hasModifierGroups ? 0 : parentPrice * 1;
        const hasRealEditChildren = selectedAddons.some(a => {
            const itemNo = a.item_no || a.citem_no;
            return itemNo && itemNo !== itemId;
        });

        const parentRemarks = !hasRealEditChildren
            ? buildRemarksText(selectedRemarks)
            : buildRemarksText(selectedRemarks.filter(r => !r.parent_category));

        console.log('📝 EDIT parentRemarks:', parentRemarks, '| hasRealEditChildren:', hasRealEditChildren);

        let currentDsNo = 1;
        const newQty = originalItem.qty ?? 1;

        //resultItems.push({
        //    ...originalItem,
        //    qty: newQty,
        //    remarks: parentRemarks,
        //    unit_price: parentPrice,
        //    sub_total: parentSubTotal,
        //    ds_no: currentDsNo
        //});

        const hasEditChildren = selectedAddons.length > 0;
        resultItems.push({
            ...originalItem,
            qty: newQty,
            remarks: parentRemarks,
            unit_price: hasEditChildren ? 0 : parentPrice,
            price: hasEditChildren ? 0 : parentPrice,
            net_amt: hasEditChildren ? 0 : parentPrice,
            sub_total: hasEditChildren ? 0 : parentSubTotal,
            ds_no: currentDsNo
        });

        selectedAddons.forEach(addon => {
            const itemNo = addon.item_no || addon.citem_no;
            const fullAddonItem = items.find(i => i.item_no === itemNo);
            if (!fullAddonItem && !addon.item_name && !addon.name) {
                console.warn('⚠️ Skipping edit addon - no item data:', itemNo);
                return;
            }
            const addonSource = fullAddonItem || {
                item_no: itemNo,
                item_name: addon.item_name || addon.name || '',
                item_desc: addon.item_desc || addon.item_name || addon.name || '',
                category_code: addon.category_code || addon.category || '',
                modifier_name: addon.modifier_name || '',
                uom: addon.uom || 'POR',
                uom_cf: 1,
                is_addon_enable: 'N',
                add_on_name: '',
                menu_type: ''
            };
            const childSNo = ++newLastSNo;
            currentDsNo++;

            const addonQty = addon.qty || 1;
            const addonPrice = addon.price !== undefined ? parseFloat(addon.price) : getItemPrice(addonSource);
            const addonCategory = addon.modifier_name || addon.category || addonSource.category_code;
            const addonRemarks = remarksByParentCategory[addonCategory]
                ? buildRemarksText(remarksByParentCategory[addonCategory])
                : (addon.remarks || "");

            const addonRecord = createSalesDtlsRecord(
                {
                    ...addonSource,
                    qty: addonQty,
                    price: addonPrice,
                    remarks: addonRemarks,
                    modifier_name: addon.modifier_name || addon.category || addonSource.modifier_name || ""
                },
                childSNo,
                parentSNo,
                addonQty * addonPrice
            );
            addonRecord.ds_no = currentDsNo;
            addonRecord.order_seq = originalItem.order_seq || 1;
            addonRecord.order_seq_type = originalItem.order_seq_type || "New";
            addonRecord.order_datetime = originalItem.order_datetime;
            addonRecord.take_away_item = isTakeawayLocal;

            //// ── FIX: same as new item mode ────────────────────────────────────────
            if (parseFloat(addonRecord.unit_price || 0) > 0) {
                addonRecord.modifier_name = '';
            }
            // ─────────────────────────────────────────────────────────────────────

            if (isTopping(addonRecord)) {
                addonRecord.qty = newQty * addonQty;
                addonRecord.sub_total = parseFloat(addonRecord.unit_price || 0) * addonRecord.qty;
                addonRecord._qty_per_serving = addonQty;
                console.log(`🧂 Topping scaled: ${addonRecord.item_name} | ${newQty} × ${addonQty} = ${addonRecord.qty}`);
            } else {
                addonRecord.qty = newQty;
                addonRecord.sub_total = parseFloat(addonRecord.unit_price || 0) * newQty;
                addonRecord._qty_per_serving = 1;
            }

            resultItems.push(addonRecord);
        });
    }
    // ==================== NEW ITEM MODE ====================
    else {
        const hasProperStructure = selectedAddons.length > 0 &&
            selectedAddons[0].s_no &&
            selectedAddons[0].parent_sno;

        if (hasProperStructure) {
            const hasRealChildren = selectedAddons.some(a => a.s_no !== a.parent_sno);
            console.log('📝 hasProperStructure | hasRealChildren:', hasRealChildren, '| total addons:', selectedAddons.length);
            resultItems.push(...selectedAddons.map(addon => {
                const isParent = addon.s_no === addon.parent_sno;
                const newSNo = ++newLastSNo;
                let remarksForItem = "";
                if (isParent) {
                    if (!hasRealChildren) {
                        remarksForItem = buildRemarksText(selectedRemarks);
                        console.log('📝 Remarks → parent (no real children):', remarksForItem);
                    }
                } else {
                    const addonCategory = addon.modifier_name || addon.category_code;
                    const matchingRemarks = selectedRemarks.filter(r => {
                        if (r.parent_category && r.parent_category === addonCategory) return true;
                        const remarkGroup = (r.remarks_group || '').toLowerCase();
                        const categoryLower = (addonCategory || '').toLowerCase();
                        return remarkGroup.includes(categoryLower) || categoryLower.includes(remarkGroup.split(' ')[0]);
                    });
                    remarksForItem = buildRemarksText(matchingRemarks);
                }
                return {
                    ...addon,
                    s_no: newSNo,
                    parent_sno: isParent ? newSNo : (addon.parent_sno + (newSNo - addon.s_no)),
                    remarks: remarksForItem,
                    take_away_item: isTakeawayLocal,
                    // ✅ Store per-serving qty for toppings so updateQuantityBySno can scale correctly
                    _qty_per_serving: isTopping(addon) ? (addon.qty || 1) : 1,
                };
            }));
        } else if (selectedAddons.length > 0) {
            const parentSNo = ++newLastSNo;
            const itemPrice = hasModifierGroups ? 0 : getItemPrice(item);
            const allAddonCategories = selectedAddons
                .map(a => a.modifier_name || a.category || '')
                .filter(Boolean);
            const unmatchedRemarks = selectedRemarks.filter(r =>
                !r.parent_category || !allAddonCategories.includes(r.parent_category)
            );
            const parentRemarksText = buildRemarksText(unmatchedRemarks);
            console.log('📝 Parent remarks (unmatched):', parentRemarksText);

            let currentDsNo = 1;

            //const parentItem = createSalesDtlsRecord(
            //    { ...item, qty: 1, price: itemPrice, remarks: parentRemarksText },
            //    parentSNo, parentSNo, itemPrice
            //);
            const parentItem = createSalesDtlsRecord(
                { ...item, qty: 1, unit_price: 0, price: 0, remarks: parentRemarksText },
                parentSNo, parentSNo, 0
            );
            parentItem.ds_no = currentDsNo;
            parentItem.take_away_item = isTakeawayLocal;
            resultItems.push(parentItem);

            selectedAddons.forEach(addon => {
                const itemNo = addon.item_no || addon.citem_no;
                const fullAddonItem = items.find(i => i.item_no === itemNo);
                if (!fullAddonItem && !addon.item_name && !addon.name) {
                    console.warn('⚠️ Skipping addon - no item data at all:', itemNo);
                    return;
                }
                const addonSource = fullAddonItem || {
                    item_no: itemNo,
                    item_name: addon.item_name || addon.name || '',
                    item_desc: addon.item_desc || addon.item_name || addon.name || '',
                    category_code: addon.category_code || addon.category || '',
                    modifier_name: addon.modifier_name || '',
                    uom: addon.uom || 'POR',
                    uom_cf: 1,
                    is_addon_enable: 'N',
                    add_on_name: '',
                    menu_type: ''
                };
                const childSNo = ++newLastSNo;
                currentDsNo++;

                const addonQty = addon.qty || 1;
                const addonPrice = addon.price !== undefined ? parseFloat(addon.price) : getItemPrice(addonSource);
                const addonCategory = addon.modifier_name || addon.category || addonSource.category_code;
                const matchingRemarks = selectedRemarks.filter(r => {
                    if (r.parent_category && r.parent_category === addonCategory) return true;
                    const remarkGroup = (r.remarks_group || '').toLowerCase();
                    const categoryLower = (addonCategory || '').toLowerCase();
                    return remarkGroup.includes(categoryLower) || categoryLower.includes(remarkGroup.split(' ')[0]);
                });
                const addonRemarks = matchingRemarks.length > 0
                    ? buildRemarksText(matchingRemarks)
                    : (addon.remarks || "");

                const addonItem = createSalesDtlsRecord(
                    {
                        ...addonSource,
                        qty: addonQty,
                        price: addonPrice,
                        remarks: addonRemarks,
                        modifier_name: addon.modifier_name || addon.category || addonSource.modifier_name || ""
                    },
                    childSNo, parentSNo, addonQty * addonPrice
                );
                addonItem.ds_no = currentDsNo;
                addonItem.take_away_item = isTakeawayLocal;

                // ── FIX: priced child rows must not carry modifier_name ───────────────
                // modifier_name on a priced child causes calcOrderAmt to treat its parent
                // as a modifier parent and exclude it from totals (double-count bug).
                // Zero-price children (options/remarks) are fine — they don't affect totals.
                if (parseFloat(addonItem.unit_price || 0) > 0) {
                    addonItem.modifier_name = '';
                }
                // ─────────────────────────────────────────────────────────────────────

                if (isTopping(addonItem)) {
                    addonItem._qty_per_serving = addonQty;
                    console.log(`🧂 Topping added: ${addonItem.item_name} | qty_per_serving=${addonQty}`);
                } else {
                    addonItem._qty_per_serving = 1;
                }

                resultItems.push(addonItem);
            });
        }
        // ==================== STANDALONE ITEM ====================
        else {
            const itemSNo = ++newLastSNo;
            const itemPrice = getItemPrice(item);
            const remarksText = buildRemarksText(selectedRemarks);

            console.log('📝 True standalone remarksText:', remarksText);
            console.log('💰 Using itemPrice:', itemPrice, 'for item', item.item_name);

            const baseItemForRecord = {
                ...item,
                price: itemPrice,
                qty: 1,
                remarks: remarksText
            };

            const standaloneItem = createSalesDtlsRecord(baseItemForRecord, itemSNo, itemSNo, itemPrice);
            standaloneItem.take_away_item = isTakeawayLocal;
            standaloneItem.is_apply_svc = isServiceExempt ? 0 : 1;
            resultItems.push(standaloneItem);
        }
    }

    // Apply service charge flag - PRE-SYNC RESET
    const resultItemsWithSvc = resultItems.map(it => ({
        ...it,
        is_apply_svc: isServiceExempt ? 0 : 1,
        svc_amt: "0.000000"
    }));

    let updatedOrderItems;

    if (editingOrderItemSNo) {
        const existingSales = order.sales_dtls.filter(i =>
            i.s_no != editingOrderItemSNo && i.parent_sno != editingOrderItemSNo
        );
        updatedOrderItems = {
            orderItems: {
                ...order,
                sales_dtls: [...existingSales, ...resultItemsWithSvc]
            },
            processFreeItemSelection: null
        };

    } else if (hasModifierGroups || hasAddons) {
        const beforeAddonItems = resultItemsWithSvc.map(i => ({ ...i }));

        const beforeSubTotalMap = new Map(
            beforeAddonItems.map(i => [String(i.s_no), parseFloat(i.sub_total ?? 0)])
        );

        const addonResponse = addItemHaveModifierOrAddon(beforeAddonItems, null);
        const afterAddonItems = addonResponse?.orderItems?.sales_dtls || [];

        const existingItems = order.sales_dtls || [];
        const existingSnos = new Set(existingItems.map(e => String(e.s_no)));

        const newItemsFromPromo = afterAddonItems.filter(
            item => !existingSnos.has(String(item.s_no))
        );

        const newItemsToUse = newItemsFromPromo.length > 0
            ? newItemsFromPromo
            : beforeAddonItems;

        // Restore remarks the promo engine may have wiped
        newItemsToUse.forEach(i => {
            const originalItem = beforeAddonItems.find(b => b.s_no === i.s_no);
            if (!originalItem) return;

            const origRemarks = typeof originalItem.remarks === 'string'
                ? originalItem.remarks
                : String(originalItem.remarks ?? '');
            const currRemarks = typeof i.remarks === 'string'
                ? i.remarks
                : String(i.remarks ?? '');

            if (origRemarks.trim() && !currRemarks.trim()) {
                i.remarks = origRemarks;
                console.log('🔄 Restored remarks (addon path):', i.item_no, '->', i.remarks);
            }

            // ✅ Restore _qty_per_serving if promo engine stripped it
            if (originalItem._qty_per_serving !== undefined && i._qty_per_serving === undefined) {
                i._qty_per_serving = originalItem._qty_per_serving;
            }
        });

        updatedOrderItems = {
            orderItems: {
                ...addonResponse.orderItems,
                sales_dtls: [...existingItems, ...newItemsToUse]
            },
            processFreeItemSelection: addonResponse.processFreeItemSelection
        };

        // ── PROMO OVER-APPLICATION GUARD ─────────────────────────────────────
        (() => {
            if (!updatedOrderItems?.orderItems?.sales_dtls) return;
            const existingDtls = order?.sales_dtls || [];
            if (!existingDtls.length) return;

            const newSnos = new Set(beforeAddonItems.map(i => String(i.s_no)));

            const freePromoCount = {};
            existingDtls.forEach(e => {
                if (String(e.s_no) !== String(e.parent_sno)) return;
                if (!e._is_free) return;
                if (!e.disc_name || e.disc_name === 'None') return;
                const key = e.disc_name.trim().toLowerCase();
                freePromoCount[key] = (freePromoCount[key] || 0) + 1;
            });

            if (Object.keys(freePromoCount).length === 0) return;

            console.log('🔍 Promo guard — voucher promo redemption counts:', freePromoCount);

            const promos = useCache()?.promos || [];

            // Parent strip
            updatedOrderItems.orderItems.sales_dtls =
                updatedOrderItems.orderItems.sales_dtls.map(item => {
                    if (!newSnos.has(String(item.s_no))) return item;
                    if (String(item.s_no) !== String(item.parent_sno)) return item;
                    if (!item.disc_name || item.disc_name === 'None') return item;

                    const discNameLower = item.disc_name.trim().toLowerCase();
                    const alreadyRedeemedCount = freePromoCount[discNameLower] || 0;
                    if (alreadyRedeemedCount === 0) return item;

                    const promo = promos.find(p =>
                        p?.promo_name?.trim().toLowerCase() === discNameLower
                    );
                    if (promo) {
                        const limitEnabled = promo.promo_limit_enable === '1' || promo.promo_limit_enable === 1;
                        const maxQty = parseInt(promo.promo_limit_qty ?? 0);
                        if (limitEnabled && maxQty > 0 && alreadyRedeemedCount < maxQty) {
                            console.log(`✅ "${promo.promo_name}" within configured limit (${alreadyRedeemedCount}/${maxQty}) — keeping`);
                            return item;
                        }
                    }

                    console.log(`🚫 Voucher promo "${item.disc_name}" already redeemed — stripping from s_no:${item.s_no}`);
                    const originalSubTotal = beforeSubTotalMap.get(String(item.s_no)) ?? 0;
                    return {
                        ...item,
                        disc_type: 'N',
                        disc_name: 'None',
                        disc_value: 0,
                        disc_amt: '0.00',
                        sub_total: originalSubTotal,
                    };
                });

            // Children strip
            const strippedParentSnos = new Set(
                updatedOrderItems.orderItems.sales_dtls
                    .filter(i => {
                        if (!newSnos.has(String(i.s_no))) return false;
                        if (String(i.s_no) !== String(i.parent_sno)) return false;
                        const originalNewItem = beforeAddonItems.find(b => String(b.s_no) === String(i.s_no));
                        const hadPromo = originalNewItem?.disc_name && originalNewItem.disc_name !== 'None';
                        return hadPromo && i.disc_name === 'None';
                    })
                    .map(i => String(i.s_no))
            );

            if (strippedParentSnos.size > 0) {
                updatedOrderItems.orderItems.sales_dtls =
                    updatedOrderItems.orderItems.sales_dtls.map(item => {
                        if (String(item.s_no) === String(item.parent_sno)) return item;
                        if (!strippedParentSnos.has(String(item.parent_sno))) return item;

                        const originalSubTotal = beforeSubTotalMap.has(String(item.s_no))
                            ? beforeSubTotalMap.get(String(item.s_no))
                            : parseFloat(item.unit_price || 0) * parseFloat(item.qty || 1);

                        return {
                            ...item,
                            disc_type: 'N',
                            disc_name: 'None',
                            disc_value: 0,
                            disc_amt: '0.00',
                            sub_total: originalSubTotal,
                        };
                    });
            }
        })();

    } else {
        const remarksToPreserve = resultItemsWithSvc[0]?.remarks || "";
        console.log('📝 Preserving remarks before addAlacarteItem:', remarksToPreserve);

        try {
            const apiResponse = addAlacarteItem(resultItemsWithSvc[0]);

            if (!apiResponse || !apiResponse.orderItems) {
                console.error("❌ addAlacarteItem calculation failed");
                return;
            }

            updatedOrderItems = apiResponse;

            if (updatedOrderItems.orderItems.sales_dtls) {
                updatedOrderItems.orderItems.sales_dtls.forEach(s => {
                    if (s.item_no === itemId) {
                        if (remarksToPreserve && !s.remarks) {
                            s.remarks = remarksToPreserve;
                        }
                        const correctPrice = parseFloat(getItemPrice(item));
                        if (!s.unit_price || parseFloat(s.unit_price) === 0) {
                            s.unit_price = correctPrice;
                            s.sub_total = correctPrice * (s.qty || 1);
                        }
                    }
                });
            }

        } catch (err) {
            console.error("❌ Critical error during addAlacarteItem:", err);
            showToast?.("Connection error. Please try again.", 'error');
            return;
        }
    }

    if (updatedOrderItems?.orderItems) {
        let updatedSales = [...(updatedOrderItems.orderItems.sales_dtls || [])].map(it => addTax(it || {}));

        const freshOrderType = localStorage.getItem("orderType") || "Q";
        const isSvcExemptGlobal = (freshOrderType === "T" || freshOrderType === "Q");

        if (!isSvcExemptGlobal) {
            const serviceCharges = useCache()?.serviceCharges || [];
            const svcConfig = serviceCharges[0] || {};
            const svcRate = parseFloat(svcConfig.svc_rate || svcConfig.rate || 10);

            console.log(`🍽️ Applying Dine-In service charge for ${freshOrderType} at`, svcRate, '%');

            updatedSales = updatedSales.map(item => {
                if (item && (item.is_apply_svc === 1 || item.is_apply_svc === "1")) {
                    const subTotal = parseFloat(item.sub_total || item.unit_price * (item.qty || 1) || 0);
                    if (subTotal > 0) {
                        const svcAmt = (subTotal * svcRate / 100);
                        item.svc_amt = svcAmt.toFixed(6);
                        console.log(`    → SVC added to ${item.item_name || 'item'}: $${svcAmt.toFixed(2)}`);
                    }
                }
                return item;
            });
        } else {
            console.log(`🚫 Service charge exempt for type: ${freshOrderType}`);
            updatedSales = updatedSales.map(item => ({ ...item, is_apply_svc: 0, svc_amt: "0.000000" }));

            if (freshOrderType === "T") {
                updatedSales = buildTakeawayChargeLines(updatedSales);
            }
        }

        const orderWithUpdatedSales = {
            ...order,
            ...updatedOrderItems.orderItems,
            sales_dtls: updatedSales,
            lastSNo: newLastSNo
        };

        console.log('🔧 Before calcOrderAmt - sales_dtls length:', orderWithUpdatedSales.sales_dtls.length);

        let finalOrder = calcOrderAmt(orderWithUpdatedSales, orderWithUpdatedSales.sales_dtls);

        console.log('🔧 After calcOrderAmt - sub_total:', finalOrder.sub_total, 'net_amt:', finalOrder.net_amt);

        //if (parseFloat(finalOrder.sub_total || 0) === 0 && finalOrder.sales_dtls?.length > 0) {
        //    console.warn('⚠️ calcOrderAmt returned zero totals — forcing recalc');menu_type
        //    const recalcSubTotal = finalOrder.sales_dtls.reduce((sum, s) => {
        //        return sum + parseFloat(s.sub_total || s.unit_price * (s.qty || 1) || 0);
        //    }, 0);
        //    const totalTax = finalOrder.sales_dtls.reduce((sum, s) => sum + parseFloat(s.tax_amt || 0), 0);
        //    const totalSvc = finalOrder.sales_dtls.reduce((sum, s) => sum + parseFloat(s.svc_amt || 0), 0);

        //    finalOrder = {
        //        ...finalOrder,
        //        sub_total: recalcSubTotal.toFixed(2),
        //        total_tax: totalTax.toFixed(2),
        //        total_svc: totalSvc.toFixed(2),
        //        net_amt: (recalcSubTotal + totalSvc).toFixed(2)
        //    };
        //}

        console.log('Final sales_dtls count before setOrder:', finalOrder.sales_dtls?.length || 0);
        console.log('💰 Final order totals:', {
            sub_total: finalOrder.sub_total,
            total_svc: finalOrder.total_svc,
            total_tax: finalOrder.total_tax,
            net_amt: finalOrder.net_amt
        });

        setOrder(finalOrder);
        setLastSNo(newLastSNo);
        window._blockWSSync = true;
        updateOrderCacheOnServer(finalOrder).finally(() => {
            window._blockWSSync = false;
            window.sokWebSocket?.drainPendingCacheUpdate();
        });
        // Safety fallback in case the promise hangs
        setTimeout(() => {
            if (window._blockWSSync) {
                window._blockWSSync = false;
                window.sokWebSocket?.drainPendingCacheUpdate();
            }
        }, 3000);

        const processFreeItemSelection = isFreeItem ? null : updatedOrderItems?.processFreeItemSelection;

        requestAnimationFrame(() => {
            const addonModal = document.getElementById('addonModal');
            const cartModal = document.getElementById('cartModal');
            const bottomNav = document.querySelector('.bottom-nav');

            if (addonModal) { addonModal.classList.remove('active'); addonModal.style.display = 'none'; }
            if (cartModal) { cartModal.classList.remove('active'); }

            if (bottomNav) {
                bottomNav.style.cssText = '';
            }

            document.querySelectorAll('.modal-overlay, .modal-backdrop').forEach(el => el.remove());
            document.body.style.overflow = '';
            document.body.classList.remove('modal-open');

            // ✅ Only render cart if no modal is currently open
            if (!addonModal?.classList.contains('show') && !window.modalState?.addonOpen) {
                renderCartFromOrder();
            }

            if (processFreeItemSelection) {
                setTimeout(() => showFreeItemSelectionModal(
                    processFreeItemSelection.promo,
                    processFreeItemSelection.item
                ), 150);
            }
        });
    }

    console.log(`Item ${editingOrderItemSNo ? "Updated" : "Added"}:`, itemId);
    if (!isFreeItem) {
        setTimeout(() => delete window.lastAddToCartCall, 1000);
    }
}




export function showFreeItemSelectionModal(promo, triggerOrderItem) {
    console.log('🎁 showFreeItemSelectionModal:', promo?.promo_name);

    const modal = document.getElementById('addonModal');
    const modalContent = document.getElementById('addonModalContent');
    if (!modal || !modalContent) {
        console.error('❌ addonModal not found');
        return;
    }

    const cache = useCache() || {};
    const allItems = cache.items || [];

    // ✅ creteria_item_dtls = FREE items to show in modal (coffees)
    // ✅ item_dtls = TRIGGER items (pasta/beer the customer bought)
    const freeItems = (promo?.creteria_item_dtls || []).map(fi => {
        const fullItem = allItems.find(i => i.item_no === fi.item_no);
        return fullItem ? { ...fullItem, ...fi } : fi;
    }).filter(fi => fi.item_no);

    const limit = promo?.criteria_free_item_qty_limit || 1;

    if (freeItems.length === 0) {
        console.warn('⚠️ No free items to show for promo:', promo?.promo_name);
        return;
    }

    modalContent.innerHTML = `
        <div class="modal-header">
            <h2 class="modal-title">${promo?.promo_name || 'Free Item'}</h2>
            <p class="modal-item-name font-semibold">
                Select up to <strong>${limit}</strong> complimentary item(s)
            </p>
        </div>

        <div class="addon-form space-y-6">
            <div class="addon-category border border-gray-200 rounded-lg p-4 shadow-sm bg-gray-50"
                 data-category-code="free_items"
                 data-max-selectable="${limit}"
                 data-optional="N"
                 data-type="addon">

                <h3 class="addon-category-title text-sm text-gray-600 mb-3 font-semibold uppercase tracking-wide">
                    Choose Your Free Item
                    <span class="max-selection text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full ml-2">
                        Max ${limit}
                    </span>
                </h3>

                <div class="addon-options-wrapper">
                    <div class="addon-options grid grid-cols-1 sm:grid-cols-2 gap-3">
                        ${freeItems.map(freeItem => {
        const imageUrl = getItemImageUrl(freeItem) || RESTAURANT_CONFIG.logo || '';
        const displayName = freeItem.item_desc || freeItem.item_name || freeItem.item_no;
        return `
                            <label class="addon-label block cursor-pointer p-2 border rounded bg-white hover:bg-gray-50"
                                   data-free-item-no=="${freeItem.item_no}">
                                <div class="flex items-center gap-3">
                                    <input
                                        type="checkbox"
                                        value="${freeItem.item_no}"
                                        class="addon-checkbox free-item-checkbox mr-2"
                                        data-item-name="${freeItem.item_name || ''}"
                                        data-free-item-no="${freeItem.item_no}"
                                    />
                                    <img src="${imageUrl}"
                                         alt="${displayName}"
                                         class="w-16 h-16 object-cover rounded"
                                         onerror="this.src='${RESTAURANT_CONFIG.logo || ''}';">
                                    <div class="flex-1">
                                        <div class="font-medium">${freeItem.item_name || freeItem.item_no}</div>
                                        <div class="text-sm text-gray-600">${freeItem.item_desc || 'Complimentary'}</div>
                                        <div class="text-xs text-green-600 font-semibold">FREE</div>
                                    </div>
                                </div>
                            </label>`;
    }).join('')}
                    </div>
                </div>
            </div>
        </div>

        <div class="flex gap-3 mt-4">
            <button id="skipFreeItem" class="btn-add-to-cart flex-1" style="background: #ccc; color: #333;">
                Skip
            </button>
            <button id="confirmFreeItem" class="btn-add-to-cart flex-1">
                Add Free Item(s)
            </button>
        </div>
    `;

    modal.classList.remove('close');
    modal.classList.add('show');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    const bottomNav = document.querySelector('.bottom-nav');
    if (bottomNav) bottomNav.style.display = 'none';

    const checkboxes = modalContent.querySelectorAll('.free-item-checkbox');
    // Inside the checkboxes.forEach loop, add:
    checkboxes.forEach(cb => {
        // ✅ Prevent clicks inside the modal from bubbling to global item-click handlers
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.closest('.addon-label')?.addEventListener('click', (e) => e.stopPropagation());

        cb.addEventListener('change', () => {
            const checked = Array.from(checkboxes).filter(c => c.checked);
            if (cb.checked && checked.length > limit) {
                const first = Array.from(checkboxes).find(c => c.checked && c !== cb);
                if (first) {
                    first.checked = false;
                    first.closest('.addon-label')?.classList.remove('selected');
                }
            }
            cb.closest('.addon-label')?.classList.toggle('selected', cb.checked);
        });
    });

    function closeFreeItemModal() {
        if (typeof closeAddonModal === 'function') {
            closeAddonModal();
        } else {
            modal.classList.remove('show');
            modal.classList.add('close');
            document.body.style.overflow = '';
            if (bottomNav) bottomNav.style.display = 'flex';
        }
    }

    modalContent.querySelector('#skipFreeItem').addEventListener('click', closeFreeItemModal);

    modalContent.querySelector('#confirmFreeItem').addEventListener('click', () => {
        const selected = Array.from(checkboxes).filter(cb => cb.checked);
        closeFreeItemModal();
        if (selected.length === 0) return;

        selected.forEach((cb, index) => {
            setTimeout(() => {
                addToCart(cb.dataset.freeItemNo, [], [], null, true, true); // ✅ matches renamed attr
            }, index * 100);
        });
    });

    modal.onclick = (e) => {
        if (e.target === modal) closeFreeItemModal();
    };

    modal.scrollTop = 0;
    modalContent.scrollTop = 0;
}


window.toggleFreeItemSelection = function (el, limit) {
    const allOptions = document.querySelectorAll('.free-item-option');
    const selected = document.querySelectorAll('.free-item-option.selected');
    const isSelected = el.classList.contains('selected');

    // If not selected and at limit, deselect the first selected
    if (!isSelected && selected.length >= limit) {
        const first = selected[0];
        first.classList.remove('selected');
        first.style.borderColor = '#eee';
        first.querySelector('.free-item-check').style.background = '';
        first.querySelector('.free-item-check').style.borderColor = '#ccc';
        first.querySelector('.free-item-check').textContent = '';
    }

    // Toggle current
    const nowSelected = !isSelected;
    el.classList.toggle('selected', nowSelected);
    el.style.borderColor = nowSelected ? '#222' : '#eee';
    el.querySelector('.free-item-check').style.background = nowSelected ? '#222' : '';
    el.querySelector('.free-item-check').style.borderColor = nowSelected ? '#222' : '#ccc';
    el.querySelector('.free-item-check').textContent = nowSelected ? '✓' : '';
};

window.closeFreeItemModal = function () {
    document.getElementById('freeItemModal')?.remove();
};

window.confirmFreeItemSelection = function (promoName, limit) {
    const selected = document.querySelectorAll('.free-item-option.selected');

    if (selected.length === 0) {
        closeFreeItemModal();
        return;
    }

    // Close modal first
    closeFreeItemModal();

    // Add each selected free item to cart
    selected.forEach(el => {
        const itemNo = el.dataset.itemNo;
        console.log('🎁 Adding free item:', itemNo, 'from promo:', promoName);
        addToCart(itemNo, [], [], null, true);
    });
};


function generateOrderId(deviceId, orderType) {
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    const orderId = `ORD-${deviceId}-${orderType}-${timestamp}`;
    console.log('🆕 Generated order ID:', orderId);
    return orderId;
}

/**
 * Get or create order ID - checks multiple sources
 */
async function getOrCreateOrderId() {
    const deviceId = localStorage.getItem("sok_device_id");
    console.log('🔍 Getting or creating order ID...');

    // 1. Check Zustand store
    const { order } = useOrder();
    if (order?.server_order_id) {
        console.log('✅ Found order ID in Zustand:', order.server_order_id);
        return order.server_order_id;
    }

    // 2. Check localStorage
    const localCache = JSON.parse(localStorage.getItem('order') || '{}');
    if (localCache.state?.order?.server_order_id) {
        console.log('✅ Found order ID in localStorage:', localCache.state.order.server_order_id);
        const { setOrder } = useOrder();
        setOrder({ ...order, server_order_id: localCache.state.order.server_order_id });
        return localCache.state.order.server_order_id;
    }

    // 3. Check server cache
    try {
        const response = await fetch(`/API/SOKOrder/order-cache/${deviceId}`);
        if (response.ok) {
            const data = await response.json();
            if (data.cache?.orderId) {
                console.log('✅ Found order ID in server cache:', data.cache.orderId);
                const { setOrder } = useOrder();
                setOrder({ ...order, server_order_id: data.cache.orderId });
                if (localCache.state?.order) {
                    localCache.state.order.server_order_id = data.cache.orderId;
                    localStorage.setItem('order', JSON.stringify(localCache));
                }
                return data.cache.orderId;
            }
        }
    } catch (error) {
        console.warn('⚠️ Could not check server cache:', error);
    }

    // 4. Generate new order ID
    // ✅ Read service_type from the Zustand order — set by selectOrderType via getNewOrderSOK
    // Falls back to localStorage orderType, then "E" (never default to "T")
    const orderType = order?.service_type
        || localStorage.getItem("orderType")
        || "E";

    const newOrderId = generateOrderId(deviceId, orderType);
    console.log('🆕 Generated order ID:', newOrderId, '| orderType used:', orderType);

    const { setOrder } = useOrder();
    setOrder({ ...order, server_order_id: newOrderId, order_id: newOrderId });

    if (localCache.state?.order) {
        localCache.state.order.server_order_id = newOrderId;
        localCache.state.order.order_id = newOrderId;
        localStorage.setItem('order', JSON.stringify(localCache));
    }

    return newOrderId;
}


async function updateOrderCacheOnServer(orderData = null) {
    try {
        const deviceId = localStorage.getItem("sok_device_id");
        const orderType = localStorage.getItem("orderType");

        if (!deviceId) return { success: false };

        let sourceOrder = orderData;
        if (!sourceOrder) {
            const { order: zustandOrder } = useOrder();
            sourceOrder = zustandOrder;
        }

        // --- 🛡️ GHOST CART PROTECTION START ---
        const realFoodItems = (sourceOrder?.sales_dtls || []).filter(i =>
            i.item_no !== 'TAKEAWAY_CHARGE' &&
            i.item_type !== 'CHARGE'
        );

        if (realFoodItems.length === 0 && (sourceOrder?.sales_dtls?.length > 0)) {
            console.log('🧹 Ghost cart detected (only charges left). Purging for sync.');
            sourceOrder.sales_dtls = [];
            sourceOrder.sub_total = "0.00";
            sourceOrder.net_amt = "0.00";
            sourceOrder.total_tax = "0.00";
            sourceOrder.total_svc = "0.00";
        }
        // --- 🛡️ GHOST CART PROTECTION END ---

        // ✅ No more early-return on empty cart — fall through and sync to
        // server with sales_dtls: [] so backend can persist + broadcast cache_updated.
        const isEmpty = !sourceOrder || !sourceOrder.sales_dtls || sourceOrder.sales_dtls.length === 0;
        if (isEmpty) {
            console.log("📡 Syncing EMPTY cart to server (so cache_updated can broadcast clear)...");
            // Ensure sourceOrder is a usable object even if null/undefined
            sourceOrder = sourceOrder || {};
            sourceOrder.sales_dtls = [];
            sourceOrder.sub_total = "0.00";
            sourceOrder.total_tax = "0.00";
            sourceOrder.total_svc = "0.00";
            sourceOrder.net_amt = "0.00";
            sourceOrder.total_disc = sourceOrder.total_disc ?? "0.00";
            sourceOrder.round_adj_amt = sourceOrder.round_adj_amt ?? "0.00";
            sourceOrder.tips_amt = sourceOrder.tips_amt ?? "0";
            sourceOrder.total_tender_amt = sourceOrder.total_tender_amt ?? "0";
            sourceOrder.change_amt = sourceOrder.change_amt ?? "0";
        }

        const orderId = await getOrCreateOrderId();

        const toStr = (val) => (val === null || val === undefined) ? "0.00" : String(val);
        const toInt = (val) => (val === true || val === "Y" || val === 1) ? 1 : 0;

        const INTERNAL_FIELDS = ['_qty_per_serving', '_is_free', '_promo_applied'];

        const cleanedSalesDtls = sourceOrder.sales_dtls.map(dtl => {
            const cleaned = { ...dtl };

            INTERNAL_FIELDS.forEach(field => delete cleaned[field]);

            cleaned.is_absorbtax = toInt(dtl.is_absorbtax);
            cleaned.IsAbsorbtax = toInt(dtl.is_absorbtax);
            cleaned.unit_price = toStr(dtl.unit_price);
            cleaned.sub_total = toStr(dtl.sub_total);
            cleaned.tax_amt = toStr(dtl.tax_amt);
            cleaned.disc_amt = toStr(dtl.disc_amt);

            return cleaned;
        });

        const payload = {
            OrderType: orderType,
            Status: "N",
            OrderData: {
                ...sourceOrder,
                DocDate: sourceOrder.doc_date || new Date().toISOString().replace('T', ' ').substring(0, 19),
                ServerOrderId: orderId,
                Sub_total: toStr(sourceOrder.sub_total),
                Total_tax: toStr(sourceOrder.total_tax),
                NetAmt: toStr(sourceOrder.net_amt),
                total_disc: toStr(sourceOrder.total_disc),
                total_svc: toStr(sourceOrder.total_svc),
                round_adj_amt: toStr(sourceOrder.round_adj_amt),
                tips_amt: toStr(sourceOrder.tips_amt),
                total_tender_amt: toStr(sourceOrder.total_tender_amt),
                change_amt: toStr(sourceOrder.change_amt),
                ServiceType: orderType,
                ServiceTypeInfo: SERVICE_TYPES?.find(item => item?.service_type === orderType)?.service_type_info,
                sales_dtls: cleanedSalesDtls,
                SalesDtls: cleanedSalesDtls
            }
        };

        const response = await fetch(`/API/SOKOrder/order-cache/sok/${deviceId}`, {
            method: 'POST',
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log(isEmpty ? "✅ Empty cart sync successful" : "✅ Sync Successful");
            return { success: true };
        }

        const errorResponse = await response.json();
        console.error("❌ Final Validation Check:", errorResponse);
        return { success: false };

    } catch (error) {
        console.error('❌ Sync Error:', error);
        return { success: false };
    }
}

// ✅ Helper function to debounce order updates
let updateTimeout;
export function debouncedUpdateOrderCache(delayMs = 500) {
    clearTimeout(updateTimeout);
    updateTimeout = setTimeout(() => {
        updateOrderCacheOnServer();
    }, delayMs);
}

// ✅ Function to check if cache exists
async function checkOrderCacheExists(deviceId, orderType) {
    try {
        const response = await fetch(`/API/SOKOrder/order-cache/sok/${deviceId}?orderType=${orderType}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (response.status === 404) {
            return { exists: false, cache: null };
        }

        if (!response.ok) {
            console.error('Error checking cache:', response.status);
            return { exists: false, cache: null, error: response.status };
        }

        const cache = await response.json();
        return { exists: true, cache };

    } catch (error) {
        console.error('Error checking cache:', error);
        return { exists: false, cache: null, error: error.message };
    }
}

function mergeOrderState(wsState) {
    if (!wsState?.state?.order) return;

    const { order: currentOrder, setOrder, lastSNo, setLastSNo } = useOrder();
    if (!currentOrder) return;

    const incomingOrder = wsState.state.order;

    // Merge sales_dtls
    const existingSales = currentOrder.sales_dtls || [];
    const incomingSales = incomingOrder.sales_dtls || [];

    const salesMap = new Map(existingSales.map(i => [i.s_no, i]));
    const mergedSales = [...existingSales];

    incomingSales.forEach(wsItem => {
        const existingItem = salesMap.get(wsItem.s_no);
        if (existingItem) {
            // Merge: preserve hierarchy and remarks, update qty/subtotals from ws
            mergedSales[mergedSales.findIndex(i => i.s_no === wsItem.s_no)] = {
                ...existingItem,
                ...wsItem,
                remarks: wsItem.remarks || existingItem.remarks,
                sub_total: wsItem.sub_total ?? existingItem.sub_total,
                tax_amt: wsItem.tax_amt ?? existingItem.tax_amt,
                svc_amt: wsItem.svc_amt ?? existingItem.svc_amt,
                unit_price: wsItem.unit_price ?? existingItem.unit_price,
                parent_sno: wsItem.parent_sno ?? existingItem.parent_sno
            };
        } else {
            // New item, append
            mergedSales.push(wsItem);
        }
    });

    // Update lastSNo
    const maxSNo = Math.max(
        lastSNo || 0,
        ...mergedSales.map(i => parseInt(i.s_no) || 0)
    );

    // Update totals using incoming values if present, otherwise recalc from mergedSales
    const finalOrder = {
        ...currentOrder,
        ...incomingOrder, // copy top-level fields like net_amt, total_tax
        sales_dtls: mergedSales,
        lastSNo: maxSNo,
        sub_total: incomingOrder.sub_total ?? mergedSales.reduce((sum, i) => sum + parseFloat(i.sub_total || 0), 0).toFixed(2),
        total_tax: incomingOrder.total_tax ?? mergedSales.reduce((sum, i) => sum + parseFloat(i.tax_amt || 0), 0).toFixed(2),
        total_svc: incomingOrder.total_svc ?? mergedSales.reduce((sum, i) => sum + parseFloat(i.svc_amt || 0), 0).toFixed(2),
        net_amt: incomingOrder.net_amt ?? mergedSales.reduce((sum, i) => sum + parseFloat(i.sub_total || 0) + parseFloat(i.tax_amt || 0) + parseFloat(i.svc_amt || 0), 0).toFixed(2)
    };

    setOrder(finalOrder);
    setLastSNo(maxSNo);

    setTimeout(() => {
        renderCartFromOrder();
        //updateCartCount();
    }, 10);

    console.log('✅ Merged WS order into current order. Total items:', mergedSales.length);
}



// Helper function to collect selected addons from modal
function collectSelectedAddons() {
    const selectedAddons = [];
    const checkedBoxes = document.querySelectorAll('#addonModalContent .addon-checkbox:checked');

    checkedBoxes.forEach(checkbox => {
        selectedAddons.push({
            item_no: checkbox.value,
            value: checkbox.value,
            item_name: checkbox.dataset.itemName,
            data_item_name: checkbox.dataset.itemName,
            price: parseFloat(checkbox.dataset.price || 0),
            data_price: parseFloat(checkbox.dataset.price || 0),
            modifier_name: checkbox.dataset.modifierName,
            category_code: checkbox.dataset.categoryCode,
            qty: 1
        });
    });

    return selectedAddons;
}

export function buildTakeawayChargeLines(salesDtls) {
    let chargeMap = {};
    try {
        const stored = localStorage.getItem('TakeawayCharges');
        if (stored) chargeMap = JSON.parse(stored);
    } catch (e) {
        console.warn('⚠️ Failed to parse TakeawayCharges:', e);
    }

    // ✅ Step 1: Get ta_fixed_item_no from sessionStorage SystemSettings
    let taItemNo = 'TAKEAWAY_CHARGE';
    try {
        const sysRaw = sessionStorage.getItem('SystemSettings');
        if (sysRaw) {
            const allGroups = JSON.parse(sysRaw)?.[0]?.output || [];
            const systemGroup = allGroups.find(g => g.group_name === 'System Settings');
            const taParam = systemGroup?.setting_group_dtls
                ?.find(s => s.sys_param_id === 'ta_fixed_item_no');
            if (taParam?.sys_param_value) {
                taItemNo = taParam.sys_param_value;
                console.log('✅ ta_fixed_item_no:', taItemNo);
            }
        }
    } catch (e) {
        console.warn('⚠️ Failed to read ta_fixed_item_no from SystemSettings:', e);
    }

    // ✅ Step 2: Look up item details from sessionStorage FullItems
    let taItem = null;
    try {
        const fullItemsRaw = sessionStorage.getItem('FullItems');
        if (fullItemsRaw) {
            const fullItems = JSON.parse(fullItemsRaw);
            taItem = Array.isArray(fullItems)
                ? fullItems.find(i => i.item_no === taItemNo)
                : null;
            if (taItem) {
                console.log('✅ Takeaway charge item found:', taItem.item_no, taItem.item_name);
            } else {
                console.warn('⚠️ Takeaway charge item not found for item_no:', taItemNo);
            }
        }
    } catch (e) {
        console.warn('⚠️ Failed to read FullItems from sessionStorage:', e);
    }

    // ✅ Step 3: Extract item details from cache with fallbacks
    const taItemName = taItem?.item_name;
    const taItemDesc = taItem?.item_desc;
    const taCategoryCode = taItem?.category_code;
    const taUom = taItem?.selling_uom_dtls?.[0]?.uom || taItem?.uom;
    const taUomCf = taItem?.selling_uom_dtls?.[0]?.uom_cf;
    const taIsAbsorbtax = taItem?.take_away_is_absorbtax;
    const taIsAddonEnable = taItem?.is_addon_enable;
    // ✅ Price from selling_uom_dtls (root takeaway_price is always 0)
    const taPriceFromItem = taItem?.selling_uom_dtls?.[0]?.price_dtls?.[0]?.takeaway_price ?? null;

    // ✅ Strip existing charge lines (idempotent) — strip both hardcoded and real item_no
    let result = salesDtls.filter(i =>
        i.item_no !== 'TAKEAWAY_CHARGE' && i.item_no !== taItemNo
    );
    let maxSNo = Math.max(...result.map(i => parseInt(i.s_no) || 0));

    result.forEach(item => {
        if (String(item.s_no) !== String(item.parent_sno)) return; // skip children
        if (item.take_away_item !== 'Y') return;

        // ✅ Price priority: chargeMap per item → item selling_uom_dtls → fallback 0.30
        const chargeRate = chargeMap[item.item_no]?.takeaway_charge
            ?? taPriceFromItem
            ?? 0.30;
        const qty = Number(item.qty || 1);
        const chargeAmt = chargeRate * qty;

        if (chargeAmt <= 0) return;

        const childSNo = ++maxSNo;
        const chargeItem = createSalesDtlsRecord(
            {
                item_no: taItemNo,       // ✅ PRD-202410250001
                item_name: taItemName,      // ✅ Takeaway Charges
                item_desc: taItemDesc,      // ✅ 外卖 Takeaway Beverage
                category_code: taCategoryCode,  // ✅ TAKEAWAY CHARGES
                qty: 1,
                price: chargeAmt,       // ✅ 0.30 from selling_uom_dtls
                uom: taUom,           // ✅ POR
                uom_cf: taUomCf,         // ✅ 1
                disc_type: '', disc_name: '', disc_value: 0,
                disc_amt: 0, pro_disc_amt: 0,
                tax_rate: 0,               // ✅ Charge item — no GST
                tax_value: 0,               // ✅ Charge item — no GST
                is_absorbtax: taIsAbsorbtax,   // ✅ from take_away_is_absorbtax
                is_addon_enable: taIsAddonEnable, // ✅ "N"
                add_on_name: '',
                menu_type: '',
                modifier_name: 'TAKEAWAY',
                remarks: ''
            },
            childSNo,
            item.s_no,
            chargeAmt
        );

        // ✅ Override after createSalesDtlsRecord to ensure charge item has no tax
        chargeItem.ds_no = TAKEAWAY_CHARGE_ITEM_STARTING_DS_NO;
        chargeItem.is_apply_svc = 0;
        chargeItem.svc_amt = '0.000000';
        chargeItem.tax_amt = '0.000000';
        chargeItem.tax_rate = 0;
        chargeItem.tax_value = 0;
        chargeItem.take_away_item = 'Y';
        chargeItem.is_charge_item = 'Y';
        chargeItem.order_seq = item.order_seq || 1;
        chargeItem.order_seq_type = item.order_seq_type || 'New';
        chargeItem.order_datetime = item.order_datetime;

        result.push(chargeItem);
    });

    return result;
}


function createSalesDtlsRecord(itemData, sNo, parentSNo, subTotal) {
    const currentDateTime = getNowInAPIFormat();
    //const unitPrice = parseFloat(itemData.unit_price) ||
    //    parseFloat(itemData.price) ||
    //    parseFloat(getItemPrice(itemData)) || 0;
    const explicitPrice = itemData.unit_price ?? itemData.price ?? null;
    const unitPrice = (explicitPrice !== null && !isNaN(parseFloat(explicitPrice)))
        ? parseFloat(explicitPrice)
        : parseFloat(getItemPrice(itemData)) || 0;
    const subTotalValue = parseFloat(subTotal) || (unitPrice * (parseFloat(itemData.qty) || 1));
    return {
        s_no: sNo,
        parent_sno: parentSNo,
        ds_no: 1,
        seat_no: 1,
        category_code: itemData.category_code || "",
        item_no: itemData.item_no,
        item_name: itemData.item_name,
        item_desc: itemData.item_desc || itemData.item_name,
        remarks: itemData.remarks || "",
        qty: itemData.qty || 1,
        uom: itemData.uom || "POR",
        uom_cf: itemData.uom_cf || 1,
        unit_price: unitPrice,
        disc_type: itemData.disc_type || "",
        disc_name: itemData.disc_name || "",
        disc_value: itemData.disc_value || 0,
        disc_amt: itemData.disc_amt || "0.00",
        sub_total: subTotalValue,
        pro_disc_amt: itemData.pro_disc_amt || "0.00",
        svc_amt: "0.000000",
        is_apply_svc: 1,
        tax_amt: "0.000000",
        tax_rate: itemData.tax_rate || 9,
        tax_value: itemData.tax_value || 9,
        tqr_image_url: getItemImageUrl(itemData),
        item_image: getItemImageUrl(itemData),
        is_absorbtax: itemData.is_absorbtax === "Y" ? 1 : 0,
        take_away_item: itemData.take_away_item || "N",
        order_seq: 1,
        order_seq_type: "New",
        order_datetime: currentDateTime,
        print_flag: "Y",
        item_kds_ready_status: "N",
        item_kds_ready_datetime: currentDateTime,
        item_kds_serve_status: "N",
        item_kds_serve_datetime: currentDateTime,
        override_f: 0,
        is_addon_enable: itemData.is_addon_enable || "N",
        add_on_name: itemData.add_on_name || "",
        menu_type: itemData.menu_type || "",
        modifier_name: itemData.modifier_name || "",
        ref_1: "", ref_2: "", ref_3: "", ref_4: ""
    };
}


function pushItemToCart(item, totalPrice, mainPrice = 0, addonTotal = 0, addons = []) {
    const serializeAddons = (addonsArray) => JSON.stringify(addonsArray.map(a => a.item_no).sort());

    const newAddonsSerialized = serializeAddons(addons);

    const existingItem = cart.find(i =>
        i.item_no === item.item_no &&
        serializeAddons(i.addons || []) === newAddonsSerialized
    );

    if (existingItem) {
        existingItem.quantity += 1;
        // Optionally update price in case prices changed
        existingItem.totalPrice = existingItem.basePrice + existingItem.addonTotal;
    } else {
        cart.push({
            item_no: item.item_no,
            name: item.item_name || item.name || "Unnamed",
            quantity: 1,
            basePrice: mainPrice,
            addonTotal: addonTotal,
            totalPrice: totalPrice,
            addons: addons
        });
    }

    updateCartDisplay();
}


export function getRemarksCache() {
    // Try multiple cache sources in order of reliability
    let cache = [];

    // 1. First try window.remarksCache
    if (window.remarksCache?.length > 0) {
        cache = window.remarksCache;
        console.log("📚 Using window.remarksCache:", cache.length, "items");
    }
    // 2. Try useCache()
    else if (typeof useCache === 'function') {
        const cacheManager = useCache();
        if (cacheManager?.getItemRemarks) {
            cache = cacheManager.getItemRemarks() || [];
            console.log("📚 Using useCache():", cache.length, "items");
        }
    }
    // 3. Fallback to sessionStorage
    else {
        const stored = sessionStorage.getItem("ItemRemarks");
        if (stored) {
            try {
                cache = JSON.parse(stored);
                console.log("📚 Using sessionStorage:", cache.length, "items");
                // Update window cache for next time
                window.remarksCache = cache;
            } catch (e) {
                console.error("❌ Failed to parse cached remarks:", e);
            }
        }
    }

    return cache;
}

// Add once at top of the file, outside the function
// ─── Persistent image URL cache ──────────────────────────────────────────────
const IMAGE_URL_CACHE_KEY = 'sok_image_url_cache';
const IMAGE_URL_CACHE_TTL = 30 * 60 * 1000; // match menu cache TTL

const _imageUrlCache = (() => {
    try {
        const raw = sessionStorage.getItem(IMAGE_URL_CACHE_KEY);
        if (raw) {
            const { entries, ts } = JSON.parse(raw);
            if (Date.now() - ts < IMAGE_URL_CACHE_TTL && Array.isArray(entries)) {
                console.log(`⚡ Image URL cache restored: ${entries.length} entries`);
                return new Map(entries);
            }
        }
    } catch (e) { /* corrupt cache — start fresh */ }
    return new Map();
})();

// Debounced write-back so we don't hammer sessionStorage on every lookup
let _imgCachePersistTimer = null;
function persistImageUrlCache() {
    clearTimeout(_imgCachePersistTimer);
    _imgCachePersistTimer = setTimeout(() => {
        try {
            sessionStorage.setItem(IMAGE_URL_CACHE_KEY, JSON.stringify({
                entries: Array.from(_imageUrlCache.entries()),
                ts: Date.now()
            }));
        } catch (e) { /* quota — non-fatal */ }
    }, 500);
}

let _menuItemsIndex = null; // pre-built lookup index
let _fullItemsIndex = null;

function buildMenuItemsIndex() {
    if (_menuItemsIndex) return _menuItemsIndex;
    _menuItemsIndex = new Map();
    try {
        const raw = sessionStorage.getItem('menuItems')
            || sessionStorage.getItem('MenuItems')
            || sessionStorage.getItem('POSMenuItems');
        if (raw) {
            const sections = JSON.parse(raw);
            for (const section of sections) {
                for (const i of (section.items || section.menuItems || [])) {
                    if (i.item_no) _menuItemsIndex.set(i.item_no, i);
                }
            }
        }
    } catch (e) { console.error('Error building menuItems index:', e); }
    return _menuItemsIndex;
}

function buildFullItemsIndex() {
    if (_fullItemsIndex) return _fullItemsIndex;
    _fullItemsIndex = new Map();
    try {
        const raw = sessionStorage.getItem('FullItems');
        if (raw) {
            const items = JSON.parse(LZString.decompressFromUTF16(raw));
            for (const i of items) {
                if (i.item_no) _fullItemsIndex.set(i.item_no, i);
            }
        }
    } catch (e) { console.error('Error building FullItems index:', e); }
    return _fullItemsIndex;
}

export function getItemImageUrl(item) {
    // ✅ Return cached result immediately
    if (_imageUrlCache.has(item.item_no)) {
        return _imageUrlCache.get(item.item_no);
    }

    let imageUrl = item.tqr_image_url || item.item_image || item.image || '';

    if (!imageUrl || imageUrl.trim() === '') {
        // Pass 1: FullItems index (built once, O(1) lookup)
        const fullItem = buildFullItemsIndex().get(item.item_no);
        if (fullItem) {
            imageUrl = fullItem.tqr_image_url || fullItem.item_image || fullItem.image || '';
        }

        // Pass 2: menuItems index (built once, O(1) lookup)
        if (!imageUrl) {
            const menuItem = buildMenuItemsIndex().get(item.item_no);
            if (menuItem) {
                imageUrl = menuItem.tqr_image_url || menuItem.item_image || menuItem.image || '';
            }
        }

        // Pass 3: apiManager fallback
        if (!imageUrl && window.apiManager?.loadedData) {
            const menuData = window.apiManager.loadedData.get('menuItems') || [];
            const found = menuData.flatMap(s => s.items || []).find(i => i.item_no === item.item_no);
            if (found) imageUrl = found.tqr_image_url || found.item_image || found.image || '';
        }
    }

    // URL conversion
    if (imageUrl && imageUrl.trim() !== '') {
        const stripped = imageUrl.startsWith('/') ? imageUrl.substring(1) : imageUrl;
        if (stripped.startsWith('http://') || stripped.startsWith('https://') || stripped.startsWith('data:')) {
            imageUrl = stripped;
        } else if (stripped.startsWith('api/GetImageProxy') || stripped.startsWith('img/')) {
            imageUrl = `/${stripped}`;
        } else {
            imageUrl = `/api/GetImageProxy?imageUrl=${encodeURIComponent(stripped)}`;
        }
    } else {
        imageUrl = RESTAURANT_CONFIG.logo || '/img/Logo.png';
    }

    // ✅ Cache result for all future calls
    _imageUrlCache.set(item.item_no, imageUrl);
    persistImageUrlCache();
    return imageUrl;
}


const IMAGE_DOMAIN_KEY = 'sok_image_domain';

function getImageDomainConfig() {
    if (window._imgDomainCfg) return window._imgDomainCfg;
    try {
        const raw = sessionStorage.getItem(IMAGE_DOMAIN_KEY);
        if (raw) return (window._imgDomainCfg = JSON.parse(raw));
    } catch { }
    const cfg = {
        base: RESTAURANT_CONFIG.baseImageUrl || '',
        proxyPrefix: '/api/GetImageProxy?imageUrl=',
        logo: RESTAURANT_CONFIG.logo || '/img/Logo.png'
    };
    sessionStorage.setItem(IMAGE_DOMAIN_KEY, JSON.stringify(cfg));
    return (window._imgDomainCfg = cfg);
}

// Call this when menu data reloads to invalidate caches
export function clearImageUrlCache() {
    _imageUrlCache.clear();
    _menuItemsIndex = null;
    _fullItemsIndex = null;
    sessionStorage.removeItem(IMAGE_URL_CACHE_KEY);
}
/**
* Helper function to determine temperature from item name
* @param {Object} item - Item object with name/sku fields
* @returns {string} 'hot', 'iced', or '' (empty for neutral items)
*/
export function getItemTemperature(item) {
    const citemName = (item.citem_name || '').trim();
    const itemName = (item.item_name || '').trim();
    const sku = (item.sku_no || '').trim();

    const nameToCheck = citemName || itemName;

    // HOT items
    if (nameToCheck.startsWith('H-') || nameToCheck.startsWith('(H)') || sku.startsWith('H-')) {
        return 'hot';
    }

    // ICED items (L, M, or I prefix)
    if (nameToCheck.startsWith('L-') || nameToCheck.startsWith('(L)') ||
        nameToCheck.startsWith('M-') || nameToCheck.startsWith('(M)') ||
        nameToCheck.startsWith('I-') || nameToCheck.startsWith('(I)') ||
        sku.startsWith('L-') || sku.startsWith('M-') || sku.startsWith('I-')) {
        return 'iced';
    }

    // Neutral items (no temperature prefix)
    return '';
}

/**
* Groups items by temperature based on item name prefixes
* @param {Array} itemmasterItems - Array of itemmaster items
* @param {Object} baseItem - The base item being configured
* @returns {Object} Object with 'hot' and 'iced' arrays
*/
export function groupItemsByTemperature(itemmasterItems, baseItem) {
    const temperatureGroups = { hot: [], iced: [] };

    if (!Array.isArray(itemmasterItems) || itemmasterItems.length === 0) {
        return temperatureGroups;
    }

    itemmasterItems.forEach(item => {
        const citemName = (item.citem_name || '').trim();
        const itemName = (item.item_name || '').trim();
        const sku = (item.sku_no || '').trim();
        const nameToCheck = citemName || itemName;

        if (nameToCheck.startsWith('H-') || nameToCheck.startsWith('(H)') ||
            sku.startsWith('H-')) {
            temperatureGroups.hot.push(item);
        }
        else if (nameToCheck.startsWith('L-') || nameToCheck.startsWith('(L)') ||
            nameToCheck.startsWith('M-') || nameToCheck.startsWith('(M)') ||
            nameToCheck.startsWith('I-') || nameToCheck.startsWith('(I)') ||
            sku.startsWith('L-') || sku.startsWith('M-') || sku.startsWith('I-')) {
            temperatureGroups.iced.push(item);
        }
        // ✅ Neutral items (sugar levels, toppings, ice levels) are NOT temperature variants
        // Don't add them to either group — they don't determine if an item is hot or iced
    });

    console.log('🌡️ Temperature grouping results:', {
        total: itemmasterItems.length,
        hot: temperatureGroups.hot.length,
        iced: temperatureGroups.iced.length,
        hotSamples: temperatureGroups.hot.slice(0, 3).map(i => i.citem_name || i.item_name),
        icedSamples: temperatureGroups.iced.slice(0, 3).map(i => i.citem_name || i.item_name)
    });

    return temperatureGroups;
}
export function showAddOnModalOriginal(baseItem, onConfirm, addonData, remarksData = [], prefilledAddons = [], prefilledRemarks = [], editingOrderItemSNo = null) {
    modal.classList.remove('close');
    modal.classList.add('show');
    modal.onclick = (e) => {
        if (e.target === modal) closeAddonModal();
    };
    window.currentBaseItemId = baseItem.item_no;
    window.selectedAddons = populateParentAndAddonItems(baseItem, editingOrderItemSNo);

    const itemmasterGroups = Array.isArray(baseItem.itemmaster_menutype_grpdtls) ? baseItem.itemmaster_menutype_grpdtls : [];
    const itemmasterItems = Array.isArray(baseItem.itemmaster_menutypedtls) ? baseItem.itemmaster_menutypedtls : [];

    window.itemmasterGroups = itemmasterGroups;
    window.itemmasterItems = itemmasterItems;

    if (!window.remarksCache) {
        window.remarksCache = getRemarksCache();
        console.log("🔄 Initialized window.remarksCache:", window.remarksCache?.length || 0, "items");
    }

    // Load remarks from cache if not passed in
    if (!remarksData || remarksData.length === 0) {
        const itemRemarksCache = getRemarksCache();
        const itemRemarks = itemRemarksCache.find(r =>
            r.item_no === baseItem.item_no ||
            String(r.item_no) === String(baseItem.item_no)
        );

        if (itemRemarks?.remarks_item_details) {
            remarksData = itemRemarks.remarks_item_details;
            console.log("✅ Loaded remarks from cache:", remarksData);
        } else {
            console.warn("⚠️ No remarks found for base item:", baseItem.item_no);
        }
    }

    // Translate modifier groups
    itemmasterGroups.forEach(group => {
        if (group.group_code) {
            group.display_name = getTranslatedName(group.group_code, group.modifier_name, selectedLang, "category");
        } else {
            group.display_name = group.modifier_name;
        }
    });

    itemmasterGroups.forEach(g => g.is_optional = g.is_optional || 'N');
    if (addonData?.cat_dtls) {
        addonData.cat_dtls.forEach(c => c.is_optional = c.is_optional || 'N');
    }

    // Translate modifier items
    itemmasterItems.forEach(item => {
        item.display_name = getTranslatedName(item.citem_no, item.citem_name, selectedLang, "item");
    });

    // Build comprehensive remarks map from ALL items
    const allPossibleRemarks = new Map();

    // ✅ Always add base item remarks first
    if (remarksData && remarksData.length > 0) {
        allPossibleRemarks.set(`base_${baseItem.item_no}`, remarksData);
        console.log("✅ Added base item remarks to map:", baseItem.item_no, remarksData.length, "groups");
    }

    if (addonData?.item_dtls) {
        addonData.item_dtls.forEach(addon => {
            const itemRemarksCache = getRemarksCache();
            const itemRemarks = itemRemarksCache.find(r =>
                r.item_no === addon.item_no ||
                String(r.item_no) === String(addon.item_no)
            );
            if (itemRemarks?.remarks_item_details) {
                allPossibleRemarks.set(`addon_${addon.item_no}`, itemRemarks.remarks_item_details);
            }
        });
    }

    if (itemmasterItems?.length) {
        itemmasterItems.forEach(modItem => {
            const itemRemarksCache = getRemarksCache();
            const itemRemarks = itemRemarksCache.find(r =>
                r.item_no === modItem.citem_no ||
                String(r.item_no) === String(modItem.citem_no)
            );
            if (itemRemarks?.remarks_item_details) {
                allPossibleRemarks.set(`modifier_${modItem.citem_no}`, itemRemarks.remarks_item_details);
            }
        });
    }

    console.log("🗺️ All possible remarks map:", allPossibleRemarks);

    // Translate remarks display names
    allPossibleRemarks.forEach((remarkGroups) => {
        remarkGroups.forEach(group => {
            if (group.remarks_details) {
                group.remarks_details.forEach(r => {
                    r.display_name = getTranslatedName(
                        `${group.remarks_group}_${r.seq_no}`,
                        r.remarks,
                        selectedLang,
                        "item"
                    );
                });
            }
        });
    });

    // ── Build itemmaster section (qty controls) ──────────────────────────────
    let itemmasterSection = '';
    if (itemmasterGroups.length && itemmasterItems.length) {
        const groupsArr = itemmasterGroups
            .slice()
            .sort((a, b) => (a.item_menutype_grpdtls || 9999) - (b.item_menutype_grpdtls || 9999));

        itemmasterSection = groupsArr.map(group => {
            const availableModifierItems = getAvailableModifierItems(baseItem, group);
            if (!availableModifierItems.length) return '';
            const maxQty = group.max_qty;
            const groupLimit = group.group_limit || 0;

            return `
        <div class="addon-category border border-gray-200 rounded-lg p-4 shadow-sm bg-gray-50" 
             data-category-code="${group.modifier_name}" 
             data-max-qty="${maxQty}" 
             data-group-limit="${groupLimit}"
            data-optional="${group.is_optional}"
            data-type="modifier">
            <h3 class="addon-category-title text-sm text-gray-600 mb-3 font-semibold uppercase tracking-wide flex justify-between items-center cursor-pointer">
              <span>${group.display_name} (<span class="selected-count" data-category="${group.modifier_name}">0</span> / ${maxQty})</span>
            </h3>
            <div class="addon-options-wrapper">
                <div class="addon-options grid grid-cols-1 sm:grid-cols-2 gap-3">
                    ${availableModifierItems.map(dtl => {
                const price = getPriceByServiceType(dtl.price_dtls?.[0]);
                const priceDisplay = price > 0 ? ` (+$${price.toFixed(2)})` : '';
                const soldOutText = dtl.isSoldOut ? ' (Sold Out)' : '';
                const imageUrl = getItemImageUrl(dtl);
                const restaurantLogo = RESTAURANT_CONFIG.logo || '';

                return `
                        <div class="flex justify-between items-center gap-4 p-2 border rounded bg-white" data-item-no="${dtl.citem_no}">
                            <div class="flex items-center gap-3 flex-1">
                                <img src="${imageUrl}" 
                                     alt="${dtl.display_name}" 
                                     class="w-16 h-16 object-cover rounded"
                                     onerror="if(this.src!=='${restaurantLogo}') this.src='${restaurantLogo}';">
                                <div class="text-sm">
                                    <div class="font-medium">${dtl.display_name}</div>
                                    <div class="text-gray-600">${priceDisplay}${soldOutText}</div>
                                </div>
                            </div>
                            <div class="qty-control flex gap-2 items-center"
                                 data-item-id="${dtl.citem_no}"
                                 data-item-name="${dtl.display_name}"
                                 data-price="${price}"
                                 data-category="${group.modifier_name}">
                                <button type="button" class="decrement px-2 rounded bg-gray-200">−</button>
                                <span class="qty-count w-6 text-center">0</span>
                                <button type="button" class="increment px-2 rounded bg-gray-200">+</button>
                            </div>
                        </div>`;
            }).join('')}
                </div>
            </div>
        </div>`;
        }).join('');
    }

    // ── Load add-ons data ────────────────────────────────────────────────────
    addonData = getAddonsByAddOnName(baseItem.add_on_name);

    if (addonData?.cat_dtls) {
        addonData.cat_dtls.forEach(cat => {
            if (cat.category_code) {
                cat.display_name = getTranslatedName(
                    cat.category_code,
                    cat.category_name || cat.modifier_name || cat.category_code,
                    selectedLang,
                    "category"
                );
            } else {
                cat.display_name = cat.category_name || cat.modifier_name || cat.category_code;
            }
        });
    }

    // ── Build addon section with embedded remarks ────────────────────────────
    let addonSection = '';
    if (addonData && addonData.cat_dtls && addonData.item_dtls) {
        const categories = addonData.cat_dtls
            .filter(cat => cat.max_qty >= 0)
            .sort((a, b) => a.seq_no - b.seq_no);

        addonSection = categories.map(cat => {
            const maxSelectable = cat.max_qty;
            const fieldName = `addon_${cat.category_code.replace(/\s+/g, '_')}`;
            const isOptional = (cat.is_optional ?? 'N') === 'Y';
            const options = addonData.item_dtls.filter(opt => opt.category_code === cat.category_code);

            let categoryHTML = `
        <div class="addon-category border border-gray-200 rounded-lg p-4 shadow-sm bg-gray-50"
             data-category-code="${cat.category_code}"
             data-max-selectable="${maxSelectable}"
             data-optional="${cat.is_optional || 'Y'}"
             data-type="addon">
            <h3 class="addon-category-title text-sm text-gray-600 mb-3 font-semibold uppercase tracking-wide">
              ${cat.display_name}
              ${maxSelectable > 0 ? `<span class="max-selection text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full ml-2">Max ${maxSelectable}</span>` : ''}
            </h3>
            <div class="addon-options-wrapper" style="display: block;">
              <div class="addon-options grid grid-cols-1 sm:grid-cols-2 gap-3">
                ${options.map(opt => {
                const price = parseFloat(opt.price) || 0;
                const priceDisplay = price > 0 ? ` (+${price.toFixed(2)})` : '';
                const imageUrl = getItemImageUrl(opt);
                const restaurantLogo = RESTAURANT_CONFIG.logo || '';

                return `
                    <label class="addon-label block cursor-pointer p-2 border rounded bg-white hover:bg-gray-50" data-item-no="${opt.item_no}">
                      <div class="flex items-center gap-3">
                        <input
                          type="checkbox"
                          name="${fieldName}"
                          value="${opt.item_no}"
                          data-price="${price}"
                          data-item-name="${getTranslatedName(opt.item_no, opt.item_desc, selectedLang, "item")}"
                          data-modifier-name="${cat.category_code}"
                          data-category-code="${cat.category_code}"
                          class="addon-checkbox mr-2"
                            ${(cat.is_optional !== 'Y') ? 'required' : ''}
                            ${opt.isSoldOut ? 'disabled' : ''}
                        />
                        <img src="${imageUrl}" 
                             alt="${getTranslatedName(opt.item_no, opt.item_desc, selectedLang, "item")}" 
                             class="w-16 h-16 object-cover rounded"
                             onerror="if(this.src!=='${restaurantLogo}') this.src='${restaurantLogo}';">
                        <div class="flex-1">
                          <span class="checkbox-custom rounded-full"></span>
                          <div class="addon-text">
                            <div class="font-medium">${getTranslatedName(opt.item_no, opt.item_desc, selectedLang, "item")}</div>
                            <div class="text-sm text-gray-600">${priceDisplay}${opt.isSoldOut ? ' (Sold Out)' : ''}</div>
                          </div>
                        </div>
                      </div>
                    </label>`;
            }).join('')}
              </div>
            </div>
        </div>`;

            // Add associated remarks (deduplicated by remarks_group)
            const categoryRemarksMap = new Map();
            options.forEach(opt => {
                const remarkGroups = allPossibleRemarks.get(`addon_${opt.item_no}`);
                if (remarkGroups) {
                    remarkGroups.forEach(group => {
                        if (!categoryRemarksMap.has(group.remarks_group)) {
                            categoryRemarksMap.set(group.remarks_group, group);
                        }
                    });
                }
            });

            if (categoryRemarksMap.size > 0) {
                categoryRemarksMap.forEach((group) => {
                    const groupName = group.remarks_group || 'unknown_group';
                    const remarkField = `remark_${groupName.replace(/\s+/g, '_')}`;
                    const remarksList = group.remarks_details || [];
                    if (remarksList.length === 0) return;

                    const isRequired = group.remarks_group_type === 'S';

                    categoryHTML += `
            <div class="addon-category remark-section border border-gray-200 rounded-lg p-4 shadow-sm bg-gray-50 mt-3"
                 data-category-code="${groupName}"
                 data-max-selectable="1"
                 data-optional="${isRequired ? 'N' : 'Y'}"
                 data-type="remark"
                 data-remark-group="${groupName}"
                 data-parent-category="${cat.category_code}"
                 style="display: none;">
                <h3 class="addon-category-title text-sm text-gray-600 mb-3 font-semibold uppercase tracking-wide">
                    ${groupName}
                    <span class="max-selection text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full ml-2">
                        ${isRequired ? 'Required - Select 1' : 'Optional'}
                    </span>
                </h3>
                <div class="error-message text-sm text-red-600 mb-2" style="display: none;">Please select one option for this group.</div>
                <div class="addon-options-wrapper" style="display: block;">
                    <div class="addon-options grid grid-cols-1 sm:grid-cols-2 gap-3">
                        ${remarksList.map(item => `
                            <label class="addon-label block cursor-pointer">
                                <input 
                                    type="checkbox"
                                    name="${remarkField}"
                                    value="${item.seq_no}"
                                    data-remark-text="${item.display_name || item.remarks}"
                                    data-remark-group="${groupName}"
                                    class="addon-checkbox remark-checkbox mr-2"
                                    ${isRequired ? 'required' : ''}
                                >
                                <span class="checkbox-custom"></span>
                                <span class="addon-text">${item.display_name || item.remarks}</span>
                            </label>
                        `).join('')}
                    </div>
                </div>
            </div>`;
                });
            }

            return categoryHTML;
        }).join('');
    }

    // ── Standalone remarks section (no addons / no modifiers) ───────────────
    const hasAddonSection = (addonData?.cat_dtls?.length || 0) > 0;
    const hasModifierSection = itemmasterGroups.length > 0;
    let standaloneRemarksSection = '';

    if (remarksData && remarksData.length > 0 && !hasAddonSection && !hasModifierSection) {
        console.log("📝 Rendering standalone remarks for base item:", baseItem.item_no);

        standaloneRemarksSection = remarksData.map(group => {
            const groupName = group.remarks_group || 'Remarks';
            const fieldName = `remark_${groupName.replace(/\s+/g, '_')}`;
            const isRequired = group.remarks_group_type === 'S';
            const remarksList = group.remarks_details || [];
            if (remarksList.length === 0) return '';

            return `
            <div class="addon-category remark-section border border-gray-200 rounded-lg p-4 shadow-sm bg-gray-50"
                 data-category-code="${groupName}"
                 data-max-selectable="1"
                 data-optional="${isRequired ? 'N' : 'Y'}"
                 data-type="remark"
                 data-remark-group="${groupName}"
                 data-parent-category="${baseItem.item_no}"
                 style="display: block;">
                <h3 class="addon-category-title text-sm text-gray-600 mb-3 font-semibold uppercase tracking-wide">
                    ${groupName}
                    <span class="max-selection text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full ml-2">
                        ${isRequired ? 'Required - Select 1' : 'Optional'}
                    </span>
                </h3>
                <div class="error-message text-sm text-red-600 mb-2" style="display: none;">Please select one option.</div>
                <div class="addon-options-wrapper" style="display: block;">
                    <div class="addon-options grid grid-cols-1 sm:grid-cols-2 gap-3">
                        ${remarksList.map(item => `
                            <label class="addon-label block cursor-pointer p-2 border rounded bg-white hover:bg-gray-50">
                                <div class="flex items-center gap-3">
                                    <input 
                                        type="checkbox"
                                        name="${fieldName}"
                                        value="${item.seq_no}"
                                        data-remark-text="${item.display_name || item.remarks}"
                                        data-remark-group="${groupName}"
                                        data-parent-category="${baseItem.item_no}"
                                        class="addon-checkbox remark-checkbox mr-2"
                                        ${isRequired ? 'required' : ''}
                                    >
                                    <span class="checkbox-custom"></span>
                                    <span class="addon-text font-medium">${item.display_name || item.remarks}</span>
                                </div>
                            </label>
                        `).join('')}
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    // ── Inject modal HTML ────────────────────────────────────────────────────
    modalContent.innerHTML = `
        <div class="modal-header">
            <h2 class="modal-title">Select Add-ons for</h2>
            <p class="modal-item-name font-semibold">${baseItem.item_name}</p>
        </div>
        <form id="addonForm" class="addon-form space-y-6">
            ${itemmasterSection}
            ${addonSection}
            ${standaloneRemarksSection}
        </form>
        <button id="confirmAddons" class="btn-add-to-cart mt-4 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 opacity-50 cursor-not-allowed" disabled>
          Add to Cart
        </button>
        <button id="updateAddOns" class="btn-add-to-cart mt-4 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 opacity-50 cursor-not-allowed" style="display:none;">
          Update Cart
        </button>
    `;

    // ── Remarks visibility helper ────────────────────────────────────────────
    const itemRemarksCache = window.remarksCache || getRemarksCache();
    const updateRemarksVisibility = createUpdateRemarksVisibilityFunction(allPossibleRemarks, itemRemarksCache);

    // ── Unified checkbox logic ───────────────────────────────────────────────
    function bindUnifiedCheckboxLogic() {
        document.querySelectorAll('.addon-category').forEach(group => {
            const maxSelectable = parseInt(group.dataset.maxSelectable || '0', 10);
            const categoryType = group.dataset.type;
            const categoryCode = group.dataset.categoryCode;
            const optional = group.dataset.optional === 'Y';
            const isRemarkSection = categoryType === 'remark';

            const checkboxes = isRemarkSection
                ? group.querySelectorAll('.addon-checkbox.remark-checkbox')
                : group.querySelectorAll('.addon-checkbox:not(.remark-checkbox)');

            if (checkboxes.length === 0) return;

            if (optional) {
                checkboxes.forEach(input => input.removeAttribute("required"));
            }

            function updateCheckboxState() {
                const checked = Array.from(checkboxes).filter(cb => cb.checked);

                if (maxSelectable > 0 && checked.length >= maxSelectable && maxSelectable !== 1) {
                    checkboxes.forEach(cb => {
                        if (!cb.checked && !cb.disabled) cb.disabled = true;
                    });
                } else {
                    checkboxes.forEach(cb => {
                        const isSoldOut = cb.hasAttribute('disabled') && cb.dataset.soldOut === 'true';
                        if (!isSoldOut) cb.disabled = false;
                    });
                }

                checkboxes.forEach(cb => {
                    const label = cb.closest('.addon-label');
                    if (label) label.classList.toggle('selected', cb.checked);
                });
            }

            // Single-select (radio-button behaviour) for max = 1
            if (maxSelectable === 1) {
                checkboxes.forEach(checkbox => {
                    checkbox.setAttribute('data-was-checked', checkbox.checked ? 'true' : 'false');

                    checkbox.addEventListener('click', function (e) {
                        e.stopPropagation();
                        const wasChecked = this.getAttribute('data-was-checked') === 'true';

                        checkboxes.forEach(cb => {
                            cb.checked = false;
                            cb.setAttribute('data-was-checked', 'false');
                            cb.closest('.addon-label')?.classList.remove('selected');
                        });

                        if (!wasChecked) {
                            this.checked = true;
                            this.setAttribute('data-was-checked', 'true');
                            this.closest('.addon-label')?.classList.add('selected');
                            this.dispatchEvent(new Event('change', { bubbles: true }));
                        } else {
                            if (!optional) {
                                // Required: cannot deselect
                                this.checked = true;
                                this.setAttribute('data-was-checked', 'true');
                                this.closest('.addon-label')?.classList.add('selected');
                                console.log(`ℹ️ Cannot uncheck required option in "${categoryCode}"`);
                            } else {
                                this.checked = false;
                                this.setAttribute('data-was-checked', 'false');
                                this.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                        }

                        updateCheckboxState();
                        if (typeof validateAddToCart === 'function') validateAddToCart();
                    });
                });
            }

            checkboxes.forEach(cb => {
                cb.addEventListener('change', () => {
                    const isChecked = cb.checked;
                    const itemNo = cb.value;
                    const itemName = cb.dataset.itemName || cb.dataset.remarkText;
                    const price = parseFloat(cb.dataset.price || 0);

                    if (categoryType === 'addon' && categoryCode) {
                        const addonGroup = addonData?.cat_dtls?.find(cat => cat.category_code === categoryCode);

                        if (addonGroup) {
                            const addonItem = { item_no: itemNo, item_desc: itemName, category_code: categoryCode, price, qty: 1 };
                            window.selectedAddons = window.selectedAddons || [];

                            if (isChecked) {
                                const { selectionItems, exceed } = addAddonItem(addonGroup, addonItem, window.selectedAddons);
                                if (!exceed) {
                                    window.selectedAddons = selectionItems.map(item => ({ ...item, parent_sno: 1, ds_no: 1, seat_no: 1 }));
                                    console.log('✅ Added addon:', itemName);
                                } else {
                                    cb.checked = false;
                                    console.warn('⚠️ Addon limit exceeded');
                                }
                            } else {
                                window.selectedAddons = window.selectedAddons.filter(
                                    item => !(item.item_no === itemNo && item.category_code === categoryCode)
                                );
                                console.log('🗑️ Removed addon:', itemName);
                            }
                        }

                        updateRemarksVisibility();
                    }

                    if (categoryType === 'remark') {
                        console.log(`📝 Remark ${isChecked ? 'selected' : 'deselected'}:`, itemName);
                    }

                    updateCheckboxState();
                    if (typeof validateAddToCart === 'function') validateAddToCart();
                });
            });

            updateCheckboxState();
        });
    }

    function updateCategoryCount(categoryCode) {
        const category = document.querySelector(`.addon-category[data-category-code="${categoryCode}"]`);
        if (!category) return;

        const total = [...category.querySelectorAll('.qty-count')]
            .map(el => parseInt(el.textContent, 10) || 0)
            .reduce((a, b) => a + b, 0);

        const selectedCountEl = category.querySelector(`.selected-count[data-category="${categoryCode}"]`);
        if (selectedCountEl) selectedCountEl.textContent = total;

        const max = parseInt(category.dataset.maxQty || "0", 10);
        category.querySelectorAll('.increment').forEach(btn => {
            btn.disabled = max > 0 && total >= max;
            btn.classList.toggle('opacity-50', btn.disabled);
            btn.classList.toggle('cursor-not-allowed', btn.disabled);
        });

        const wrapper = category.querySelector(".addon-options-wrapper");
        if (wrapper) wrapper.classList.toggle("collapsed", max > 0 && total >= max);
    }

    function attachQtyControls(container) {
        const root = (typeof container === 'string') ? document.getElementById(container) : container;
        if (!root) return;

        window.selectedAddons = window.selectedAddons || [];

        root.querySelectorAll('.qty-control').forEach(control => {
            const decrementBtn = control.querySelector('.decrement');
            const incrementBtn = control.querySelector('.increment');
            const countSpan = control.querySelector('.qty-count');
            const categoryCode = control.dataset.category;
            const itemId = control.dataset.itemId;

            function updateUI(newQty) {
                countSpan.textContent = newQty;
                decrementBtn.disabled = newQty <= 0;
                decrementBtn.classList.toggle('opacity-50', newQty <= 0);
                decrementBtn.classList.toggle('cursor-not-allowed', newQty <= 0);
                updateCategoryCount(categoryCode);
                updateRemarksVisibility();
            }

            function handleQtyChange(newQty) {
                updateUI(newQty);
                const selectedGroup = window.itemmasterGroups?.find(g => g.modifier_name === categoryCode);
                const selectedItem = window.itemmasterItems?.find(i => i.citem_no === itemId);

                if (selectedGroup && selectedItem) {
                    const normalizedItem = {
                        ...selectedItem,
                        citem_no: itemId,
                        citem_name: control.dataset.itemName,
                        modifier_name: selectedGroup.modifier_name || categoryCode,
                    };

                    window.selectedAddons = window.selectedAddons.map(item => ({ ...item, parent_sno: 1, ds_no: 1, seat_no: 1 }));

                    const existingItem = window.selectedAddons.find(
                        item => item.item_no === itemId && item.modifier_name === categoryCode
                    );

                    if (existingItem && newQty > 0) {
                        const { selectionItems: updatedItems, exceed } = changeModifierItemQty(newQty, selectedGroup, normalizedItem, window.selectedAddons);
                        if (!exceed) window.selectedAddons = updatedItems.map(item => ({ ...item, parent_sno: 1, ds_no: 1, seat_no: 1 }));
                    } else if (existingItem && newQty === 0) {
                        const { selectionItems: updatedItems } = changeModifierItemQty(0, selectedGroup, normalizedItem, window.selectedAddons);
                        window.selectedAddons = updatedItems.map(item => ({ ...item, parent_sno: 1, ds_no: 1, seat_no: 1 }));
                    } else if (!existingItem && newQty > 0) {
                        const itemToAdd = { ...normalizedItem, qty: newQty, menu_type: selectedItem.menu_type, level_no: selectedItem.level_no || 0 };
                        const { selectionItems: updatedItems, exceed } = addModifierItem(selectedGroup, itemToAdd, window.selectedAddons);
                        if (!exceed) window.selectedAddons = updatedItems.map(item => ({ ...item, parent_sno: 1, ds_no: 1, seat_no: 1 }));
                    }
                }

                console.log('🎯 Selected Addons:', window.selectedAddons);
            }

            incrementBtn.addEventListener('click', () => handleQtyChange((parseInt(countSpan.textContent, 10) || 0) + 1));
            decrementBtn.addEventListener('click', () => handleQtyChange(Math.max(0, (parseInt(countSpan.textContent, 10) || 0) - 1)));
            updateUI(parseInt(countSpan.textContent, 10) || 0);
        });
    }

    function bindCollapseToggles() {
        document.querySelectorAll(".addon-category-title").forEach(title => {
            title.addEventListener("click", () => {
                const group = title.closest(".addon-category");
                const wrapper = group.querySelector(".addon-options-wrapper");
                if (!wrapper) return;

                const collapsed = group.classList.contains("collapsed");
                group.classList.toggle("collapsed", !collapsed);
                wrapper.classList.toggle("collapsed", !collapsed);
                wrapper.style.display = collapsed ? 'block' : 'none';
            });
        });
    }

    function autoCollapseOnMaxQty() {
        document.querySelectorAll('.addon-category').forEach(category => {
            const maxQty = parseInt(category.dataset.maxQty || '0', 10);
            if (maxQty <= 0) return;

            const totalQty = Array.from(category.querySelectorAll('.qty-count'))
                .reduce((sum, el) => sum + (parseInt(el.textContent || '0', 10)), 0);

            const wrapper = category.querySelector('.addon-options-wrapper');
            if (!wrapper) return;

            if (totalQty >= maxQty) {
                category.classList.add('collapsed');
                wrapper.classList.add('collapsed');
                wrapper.style.display = 'none';
            } else if (totalQty > 0) {
                category.classList.remove('collapsed');
                wrapper.classList.remove('collapsed');
                wrapper.style.display = 'block';
            }
        });
    }

    function initAddonModal() {
        document.querySelectorAll('.addon-category').forEach(cat => {
            updateCategoryCount(cat.dataset.categoryCode);
        });

        attachQtyControls(document.getElementById('addonModalContent'));
        bindUnifiedCheckboxLogic();
        bindCollapseToggles();
        autoCollapseOnMaxQty();

        // Standalone remarks are already display:block — skip visibility toggle
        if (hasAddonSection || hasModifierSection) {
            updateRemarksVisibility();
        } else {
            console.log("📝 Standalone remarks mode — skipping updateRemarksVisibility");
        }
    }

    initAddonModal();

    // ── Show modal ───────────────────────────────────────────────────────────
    modal.style.display = 'flex';
    modal.onclick = (e) => { if (e.target === modal) closeAddonModal(); };

    const bottomNav = document.querySelector('.bottom-nav');
    if (bottomNav) bottomNav.style.display = 'none';

    document.body.style.overflow = 'hidden';

    if (typeof validateAddonSelections === 'function') validateAddonSelections();

    // ── Confirm button ───────────────────────────────────────────────────────
    document.getElementById('confirmAddons').addEventListener('click', () => {
        if (!validateAndSubmit()) return;

        const selectedRemarks = gatherSelectedRemarksFromModal();
        const selectedAddons = gatherSelectedAddonsFromModal();

        console.log("📦 Confirmed Addons:", selectedAddons);
        console.log("💬 Confirmed Remarks:", selectedRemarks);

        addToCart(window.currentBaseItemId, selectedAddons, selectedRemarks, null, true);
        if (typeof onConfirm === 'function') onConfirm(selectedAddons, selectedRemarks);

        closeAddonModal();
    });

    // ── Update button (edit mode) ────────────────────────────────────────────
    const updateBtn = document.getElementById('updateAddOns');
    if (updateBtn) {
        updateBtn.addEventListener('click', () => {
            if (!validateAndSubmit()) return;

            const selectedRemarks = gatherSelectedRemarksFromModal();
            const selectedAddons = gatherSelectedAddonsFromModal();

            console.log("📦 Updated Addons:", selectedAddons);
            console.log("💬 Updated Remarks:", selectedRemarks);

            window.modalState.updateState({ editingMode: true });

            addToCart(window.currentBaseItemId, selectedAddons, selectedRemarks, editingOrderItemSNo, true);
            if (typeof onConfirm === 'function') onConfirm(selectedAddons, selectedRemarks);

            closeAddonModal();
        });
    }
}
function bindCheckboxModifiers() {
    document.querySelectorAll('.modifier-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', function () {
            const itemId = this.dataset.itemId;
            const itemName = this.dataset.itemName;
            const price = parseFloat(this.dataset.price || 0);
            const categoryCode = this.dataset.category;
            const isChecked = this.checked;

            // Visual feedback
            const label = this.closest('.modifier-checkbox-label');
            if (label) {
                label.classList.toggle('bg-blue-50', isChecked);
                label.classList.toggle('border-blue-300', isChecked);
            }

            // Find the group and item
            const selectedGroup = window.itemmasterGroups?.find(g => g.modifier_name === categoryCode);
            const selectedItem = window.itemmasterItems?.find(i => i.citem_no === itemId);

            if (selectedGroup && selectedItem) {
                const normalizedItem = {
                    ...selectedItem,
                    citem_no: itemId,
                    citem_name: itemName,
                    modifier_name: selectedGroup.modifier_name || categoryCode,
                };

                window.selectedAddons = window.selectedAddons || [];

                if (isChecked) {
                    // Add with qty: 1
                    const itemToAdd = {
                        ...normalizedItem,
                        qty: 1,
                        menu_type: selectedItem.menu_type,
                        level_no: selectedItem.level_no || 0,
                    };

                    const { selectionItems: updatedItems, exceed } = addModifierItem(
                        selectedGroup,
                        itemToAdd,
                        window.selectedAddons
                    );

                    if (!exceed) {
                        window.selectedAddons = updatedItems.map(item => ({
                            ...item,
                            parent_sno: 1,
                            ds_no: 1,
                            seat_no: 1
                        }));
                        console.log('✅ Added checkbox item:', itemName);
                    } else {
                        // Revert checkbox if limit exceeded
                        this.checked = false;
                        label?.classList.remove('bg-blue-50', 'border-blue-300');
                        console.warn('⚠️ Cannot add more items');
                    }
                } else {
                    // Remove item
                    const { selectionItems: updatedItems } = changeModifierItemQty(
                        0,
                        selectedGroup,
                        normalizedItem,
                        window.selectedAddons
                    );

                    window.selectedAddons = updatedItems.map(item => ({
                        ...item,
                        parent_sno: 1,
                        ds_no: 1,
                        seat_no: 1
                    }));
                    console.log('🗑️ Removed checkbox item:', itemName);
                }

                console.log('🎯 Selected Addons:', window.selectedAddons);
            }

            // Trigger validation
            if (typeof validateAddToCart === 'function') {
                validateAddToCart();
            }
        });
    });
}


function bindCollapseToggles() {
    document.querySelectorAll(".addon-category-title").forEach(title => {
        title.addEventListener("click", () => {
            const group = title.closest(".addon-category");
            const wrapper = group.querySelector(".addon-options-wrapper");
            if (!wrapper) return;

            const isCurrentlyCollapsed = group.classList.contains("collapsed");

            if (isCurrentlyCollapsed) {
                group.classList.remove("collapsed");
                wrapper.classList.remove("collapsed");
                wrapper.style.display = 'block';
            } else {
                group.classList.add("collapsed");
                wrapper.classList.add("collapsed");
                wrapper.style.display = 'none';
            }
        });
    });
}

function autoCollapseOnMaxQty() {
    const categories = document.querySelectorAll('.addon-category');

    categories.forEach(category => {
        const maxQty = parseInt(category.dataset.maxQty || '0', 10);
        if (maxQty <= 0) return;

        const qtyCounts = category.querySelectorAll('.qty-count');
        const totalQty = Array.from(qtyCounts).reduce(
            (sum, qtySpan) => sum + (parseInt(qtySpan.textContent || '0', 10)),
            0
        );

        const wrapper = category.querySelector('.addon-options-wrapper');
        if (!wrapper) return;

        if (totalQty >= maxQty) {
            category.classList.add('collapsed');
            wrapper.classList.add('collapsed');
            wrapper.style.display = 'none';
        } else if (totalQty > 0) {
            category.classList.remove('collapsed');
            wrapper.classList.remove('collapsed');
            wrapper.style.display = 'block';
        }
    });
}

function prefillEditData(prefilledAddons, prefilledRemarks, addonData) {
    console.log('🔄 Prefilling edit data...', { prefilledAddons, prefilledRemarks });

    if (prefilledAddons?.length) {
        prefilledAddons.forEach(addon => {
            console.log('🔍 Processing addon:', addon);

            // Try to find as qty control first (itemmaster items)
            let qtyControl = document.querySelector(
                `.qty-control[data-item-id="${addon.item_no}"]`
            );

            if (qtyControl) {
                // This is an itemmaster item with quantity controls
                const qtySpan = qtyControl.querySelector('.qty-count');
                const decrementBtn = qtyControl.querySelector('.decrement');

                if (qtySpan) {
                    const qty = addon.qty || 0;
                    qtySpan.textContent = qty;

                    // Update button states
                    if (qty > 0) {
                        decrementBtn.disabled = false;
                        decrementBtn.classList.remove('opacity-50', 'cursor-not-allowed');
                    }

                    const categoryCode = qtyControl.dataset.category;
                    if (categoryCode) {
                        updateCategoryCount(categoryCode);
                    }

                    console.log('✅ Prefilled qty control:', addon.item_no, qty);
                }
            } else {
                // This is an addon checkbox - try to find it by item_no only
                let checkbox = document.querySelector(
                    `.addon-checkbox[value="${addon.item_no}"]`
                );

                if (checkbox) {
                    console.log('📌 Found checkbox for:', addon.item_no, 'disabled:', checkbox.disabled);

                    if (!checkbox.disabled) {
                        checkbox.checked = true;

                        // Get category info from checkbox
                        const categoryCode = checkbox.dataset.categoryCode;
                        const price = parseFloat(checkbox.dataset.price || 0);
                        const itemName = checkbox.dataset.itemName;

                        console.log('📦 Checkbox data:', { categoryCode, price, itemName });

                        // Manually add to selectedAddons if using addAddonItem
                        if (categoryCode && addonData?.cat_dtls) {
                            const addonGroup = addonData.cat_dtls.find(
                                cat => cat.category_code === categoryCode
                            );

                            if (addonGroup) {
                                const addonItem = {
                                    item_no: addon.item_no,
                                    item_desc: itemName,
                                    category_code: categoryCode,
                                    price: price,
                                    qty: 1
                                };

                                window.selectedAddons = window.selectedAddons || [];
                                const { selectionItems, exceed } = addAddonItem(
                                    addonGroup,
                                    addonItem,
                                    window.selectedAddons
                                );

                                if (!exceed) {
                                    window.selectedAddons = selectionItems.map(item => ({
                                        ...item,
                                        parent_sno: 1,
                                        ds_no: 1,
                                        seat_no: 1
                                    }));
                                    console.log('✅ Added to selectedAddons:', addon.item_no);
                                }
                            }
                        }

                        // Update UI state
                        const label = checkbox.closest('.addon-label');
                        if (label) label.classList.add('selected');

                        console.log('✅ Prefilled addon checkbox:', addon.item_no);
                    } else {
                        console.warn('⚠️ Checkbox is disabled:', addon.item_no);
                    }
                } else {
                    console.warn('⚠️ Checkbox not found for:', addon.item_no);
                }
            }
        });
    }

    // Prefill remarks
    if (prefilledRemarks?.length) {
        prefilledRemarks.forEach(remark => {
            let checkbox = document.querySelector(
                `.addon-checkbox[data-remark-text="${remark.remarks}"]`
            );

            if (!checkbox && remark.seq_no) {
                checkbox = document.querySelector(
                    `.addon-checkbox[value="${remark.seq_no}"]`
                );
            }

            if (checkbox && !checkbox.disabled) {
                checkbox.checked = true;
                const label = checkbox.closest('.addon-label');
                if (label) label.classList.add('selected');
                console.log('✅ Prefilled remark:', remark.remarks);
            } else {
                console.warn('⚠️ Remark checkbox not found or disabled:', remark.remarks);
            }
        });
    }

    console.log('🎯 Final selectedAddons after prefill:', window.selectedAddons);

    // Re-run validation after prefilling
    if (typeof validateAddToCart === 'function') {
        setTimeout(() => validateAddToCart(), 50);
    }
}

function updateButtonsForGroup(category) {
    const container = document.getElementById('addonModalContent');
    const allControls = container.querySelectorAll(`.qty-control[data-category="${category}"]`);
    const groupContainer = container.querySelector(`.addon-category[data-category-code="${category}"]`);
    const wrapperInner = groupContainer.querySelector('.addon-options-wrapper');

    const groupData = window.currentAddonData?.cat_dtls?.find(g => g.category_code === category);

    const maxQty = groupData?.max_qty || Infinity;
    const groupLimit = groupData?.group_limit || Infinity;
    const maxPerItem = groupData?.max_per_item || Infinity;

    let currentTotalQty = 0;
    let uniqueSelectedCount = 0;

    allControls.forEach(ctrl => {
        const qty = parseInt(ctrl.querySelector('.qty-count').textContent, 10);
        if (qty > 0) uniqueSelectedCount++;
        currentTotalQty += qty;
    });

    allControls.forEach(ctrl => {
        const btnInc = ctrl.querySelector('.increment');
        const btnDec = ctrl.querySelector('.decrement');
        const qty = parseInt(ctrl.querySelector('.qty-count').textContent, 10);
        const itemId = ctrl.dataset.itemId;

        const isCurrentItemSelected = qty > 0;

        const willExceedUnique = uniqueSelectedCount >= groupLimit && !isCurrentItemSelected;
        const willExceedTotalQty = currentTotalQty >= maxQty;
        const willExceedItem = qty >= maxPerItem;

        btnInc.disabled = willExceedItem || willExceedTotalQty || willExceedUnique;
        btnDec.disabled = qty === 0;

        // 🔹 Hook into addModifierItem when qty > 0
        if (qty > 0 && typeof addModifierItem === "function") {
            const modifierItem = {
                citem_no: itemId,
                citem_name: ctrl.dataset.itemName,
                uom: ctrl.dataset.uom || "UNIT",
                uom_cf: 1,
                qty
            };

            const grp = {
                modifier_name: ctrl.dataset.category || "",
                price_per: groupData?.price_per || 100
            };

            const selectionItems = window.cache?.pendingCartItem
                ? [...window.cache.pendingCartItem]
                : [];

            const { modiferItem, exceed } = addModifierItem(grp, modifierItem, selectionItems);

            if (!exceed && modiferItem) {
                const idx = selectionItems.findIndex(
                    i => i.item_no === modiferItem.item_no && i.parent_sno === modiferItem.parent_sno
                );
                if (idx >= 0) {
                    selectionItems[idx] = modiferItem;
                } else {
                    selectionItems.push(modiferItem);
                }
                window.cache.pendingCartItem = selectionItems;
            }
        }
    });

    // Collapse/expand category when max reached
    if (currentTotalQty >= maxQty) {
        if (wrapperInner.style.display !== 'none') {
            wrapperInner.style.display = 'none';
            groupContainer.classList.add('collapsed');
            groupContainer.querySelector('.addon-category-title')?.classList.add('collapsed');

            const nextGroup = groupContainer.nextElementSibling;
            if (nextGroup?.classList.contains('addon-category')) {
                nextGroup.scrollIntoView({ behavior: 'smooth' });
            }
        }
    } else {
        wrapperInner.style.display = '';
        groupContainer.classList.remove('collapsed');
        groupContainer.querySelector('.addon-category-title')?.classList.remove('collapsed');
    }
}

function validateAddonSelections() {
    const form = document.getElementById('addonForm');
    if (!form) {
        console.error('Form element not found');
        return;
    }
    const confirmBtn = document.getElementById('confirmAddons');

    // Check if all addon categories (not remarks) are optional
    const addonCategories = form.querySelectorAll('.addon-category[data-type="addon"]');
    const allOptional = Array.from(addonCategories).every(category =>
        category.dataset.optional === 'Y'
    );

    // Check if user has selected any addons
    const selectedAddonInputs = form.querySelectorAll('.addon-category[data-type="addon"] input[type="checkbox"]:checked, .addon-category[data-type="addon"] input[type="radio"]:checked');
    const hasSelectedAddons = selectedAddonInputs.length > 0;

    // FIRST PRIORITY: If all optional and nothing selected, allow add to cart
    if (allOptional && !hasSelectedAddons) {
        confirmBtn.disabled = false;
        confirmBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        return;
    }

    // SECOND: If user selected something, begin validation
    if (hasSelectedAddons) {
        let canAddToCart = true;

        // Check each selected addon to see if it has required remarks
        selectedAddonInputs.forEach(input => {
            const categoryCode = input.dataset.categoryCode;

            // Find associated remark section for this category
            const remarkSection = form.querySelector(`.remark-section[data-parent-category="${categoryCode}"]`);

            if (remarkSection) {
                const isRemarkRequired = remarkSection.dataset.optional === 'N';
                const remarkGroup = remarkSection.dataset.remarkGroup;

                // Check if remark section is visible (should be shown when addon is selected)
                const isVisible = remarkSection.style.display !== 'none';

                if (isRemarkRequired && isVisible) {
                    // Check if user has selected a remark for this group
                    const hasRemarkSelected = form.querySelector(`.remark-checkbox[data-remark-group="${remarkGroup}"]:checked`);

                    if (!hasRemarkSelected) {
                        canAddToCart = false;
                    }
                }
            }
        });

        // Also check if there are any required addon groups from window.currentAddonData
        if (window.currentAddonData?.cat_dtls) {
            const requiredGroups = window.currentAddonData.cat_dtls.filter(group => group.is_optional === "N");

            if (requiredGroups.length > 0) {
                const selectedAddons = [];
                form.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked').forEach(input => {
                    selectedAddons.push({
                        modifier_name: input.dataset.modifierName || ''
                    });
                });

                const missingGroups = requiredGroups.filter(group => {
                    const groupName = (group.modifier_name || '').trim();
                    return !selectedAddons.some(addon => (addon.modifier_name || '').trim() === groupName);
                });

                if (missingGroups.length > 0) {
                    canAddToCart = false;
                }
            }
        }

        confirmBtn.disabled = !canAddToCart;

        if (canAddToCart) {
            confirmBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        } else {
            confirmBtn.classList.add('opacity-50', 'cursor-not-allowed');
        }
        return;
    }

    // If we reach here with required categories and nothing selected
    if (!allOptional) {
        confirmBtn.disabled = true;
        confirmBtn.classList.add('opacity-50', 'cursor-not-allowed');
    } else {
        // All optional, nothing selected - should already be handled above
        confirmBtn.disabled = false;
        confirmBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
}

// Assume modal and modalContent are globals or defined outside:

function validateAddToCart() {
    const allGroups = modalContent.querySelectorAll('.addon-category');
    let isValid = true;
    const errors = [];

    allGroups.forEach(group => {
        const categoryCode = group.dataset.categoryCode;
        const categoryType = group.dataset.type; // 'addon', 'remark', or undefined
        const isOptional = group.dataset.optional === 'Y';
        const maxQty = parseInt(group.dataset.maxQty || '0', 10);
        const maxSelectable = parseInt(group.dataset.maxSelectable || '0', 10);

        // Get category title for error messages
        const titleElement = group.querySelector('.addon-category-title');
        const categoryTitle = titleElement?.textContent?.trim() || categoryCode;

        // Get error message element
        const errorMessage = group.querySelector('.error-message');

        // CRITICAL: Skip hidden remark sections (they'll be validated only when visible)
        const isHidden = window.getComputedStyle(group).display === 'none' ||
            group.style.display === 'none';

        if (isHidden) {
            return; // Skip validation for hidden groups
        }

        // Skip validation if optional
        if (isOptional) {
            if (errorMessage) errorMessage.classList.add('hidden');
            return;
        }

        let hasSelection = false;
        let errorText = '';

        // VALIDATION TYPE 1: Checkbox selections (addons & remarks)
        const checkboxes = group.querySelectorAll('.addon-checkbox');
        if (checkboxes.length > 0) {
            const checkedCount = Array.from(checkboxes).filter(cb => cb.checked && !cb.disabled).length;
            hasSelection = checkedCount > 0;

            if (!hasSelection) {
                errorText = maxSelectable === 1
                    ? 'Please select one option for this group.'
                    : 'Please select at least one option for this group.';
            }
        }

        // VALIDATION TYPE 2: Quantity controls (modifiers/itemmaster)
        // Only validate if no checkboxes were found (to avoid double validation)
        if (checkboxes.length === 0 && maxQty > 0) {
            const qtyControls = group.querySelectorAll('.qty-count');
            const totalQty = Array.from(qtyControls).reduce((sum, span) =>
                sum + (parseInt(span.textContent || '0', 10)), 0
            );

            hasSelection = totalQty > 0;

            if (!hasSelection) {
                errorText = `Please select at least one item for this group (max ${maxQty}).`;
            }
        }

        // VALIDATION TYPE 3: If group has qty controls but no max_qty set, check group_limit
        if (checkboxes.length === 0 && maxQty === 0) {
            const qtyControls = group.querySelectorAll('.qty-count');
            if (qtyControls.length > 0) {
                const totalQty = Array.from(qtyControls).reduce((sum, span) =>
                    sum + (parseInt(span.textContent || '0', 10)), 0
                );

                hasSelection = totalQty > 0;

                if (!hasSelection) {
                    errorText = 'Please select at least one item for this group.';
                }
            }
        }

        // Apply validation result for required groups
        if (!hasSelection && !isOptional) {
            if (errorMessage) {
                errorMessage.textContent = errorText;
                errorMessage.classList.remove('hidden');
            }

            // Extract just the category name without count info
            const cleanTitle = categoryTitle.split('(')[0].trim();
            errors.push(`${cleanTitle}: ${errorText}`);
            isValid = false;
        } else {
            // Clear error state if valid
            if (errorMessage) {
                errorMessage.classList.add('hidden');
            }
        }
    });

    // Check if all addon categories are optional and nothing is selected
    const addonCategories = modalContent.querySelectorAll('.addon-category[data-type="addon"]');
    const allAddonsOptional = Array.from(addonCategories).every(cat => cat.dataset.optional === 'Y');
    const hasAnyAddonSelection = modalContent.querySelectorAll('.addon-category[data-type="addon"] input[type="checkbox"]:checked, .addon-category[data-type="addon"] input[type="radio"]:checked').length > 0;

    // If all addons are optional and nothing selected, allow proceed
    if (allAddonsOptional && !hasAnyAddonSelection) {
        isValid = true;
        errors.length = 0; // Clear any errors
    }

    // Scroll to first error if validation fails
    if (!isValid) {
        const firstInvalid = modalContent.querySelector('.addon-category.error-border');
        if (firstInvalid) {
            firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        console.warn('⚠️ Validation failed:', errors);
    } else {
        console.log('✅ All required selections validated');
    }

    // Update Confirm/Update button state
    const confirmBtn = modalContent.querySelector('#confirmAddons');
    const updateBtn = modalContent.querySelector('#updateAddOns');

    [confirmBtn, updateBtn].forEach(btn => {
        if (btn) {
            const isVisible = window.getComputedStyle(btn).display !== 'none';
            if (isVisible) {
                btn.disabled = !isValid;
                btn.classList.toggle('opacity-50', !isValid);
                btn.classList.toggle('cursor-not-allowed', !isValid);

                if (isValid) {
                    btn.classList.remove('opacity-50', 'cursor-not-allowed');
                    btn.classList.add('hover:bg-green-700');
                } else {
                    btn.classList.add('opacity-50', 'cursor-not-allowed');
                    btn.classList.remove('hover:bg-green-700');
                }
            }
        }
    });

    return isValid;
}

// Helper function for form submission with validation
function validateAndSubmit(callback) {
    const isValid = validateAddToCart();

    if (!isValid) {
        // Show toast notification
        showValidationToast('Please complete all required selections');
        return false;
    }

    if (typeof callback === 'function') {
        callback();
    }

    return true;
}

// Toast notification for validation errors
function showValidationToast(message) {
    const existingToast = document.getElementById('validation-toast');
    if (existingToast) {
        existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.id = 'validation-toast';
    toast.className = 'fixed top-4 left-1/2 transform -translate-x-1/2 bg-red-500 text-white px-6 py-3 rounded-lg shadow-lg z-50 transition-all duration-300';
    toast.textContent = message;
    toast.style.opacity = '0';

    document.body.appendChild(toast);

    // Fade in
    setTimeout(() => { toast.style.opacity = '1'; }, 10);

    // Fade out and remove
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Initialize validation styles
function initValidationStyles() {
    if (document.getElementById('validation-styles')) return;

    const validationStyles = `
        .error-border {
            border-color: #DC2626 !important;
            border-width: 2px !important;
        }

        .error-message {
            font-size: 0.875rem;
            margin-top: 0.25rem;
            margin-bottom: 0.5rem;
        }

        .error-message.hidden {
            display: none;
        }
        
    `;

    const styleElement = document.createElement('style');
    styleElement.id = 'validation-styles';
    styleElement.textContent = validationStyles;
    document.head.appendChild(styleElement);
}

// Call this when initializing the modal
initValidationStyles();


function setupValidationListeners() {
    const form = modalContent.querySelector('#addonForm');
    if (!form) return;

    form.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(input => {
        input.addEventListener('change', validateAddToCart);
    });

    validateAddToCart();
}

function setupConfirmButtonListener(onConfirm) {
    modalContent.querySelector('#confirmAddons').addEventListener('click', () => {
        const form = modalContent.querySelector('#addonForm');
        const selectedAddons = [];
        const selectedRemarks = [];

        form.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked').forEach(input => {
            selectedAddons.push({
                item_no: input.value,
                modifier_name: input.dataset.modifierName || '',
                price: parseFloat(input.dataset.price) || 0,
                qty: 1,
                item_name: input.closest('label')?.querySelector('.addon-text')?.textContent.trim() || 'Unnamed',
                group_code: input.closest('.addon-category')?.dataset.categoryCode || '',
            });
        });

        // Call your addToCart logic
        addToCart(window.currentBaseItemId, selectedAddons);
        if (typeof onConfirm === 'function') {
            onConfirm(selectedAddons, selectedRemarks);
        }

        closeAddonModal();
    });
}
let HIDE_BOTTOM_NAV_ON_MODAL = true;

GetHomeAPI.editItem = function (sno, item_no) {
    const { order } = useOrder();
    if (!order) return console.warn("No order found");

    const salesDtls = order.sales_dtls || [];
    const clickedItem = salesDtls.find(i => i.s_no == sno);
    if (!clickedItem) return console.warn("Item not found in cart:", sno);

    const cache = useCache() || {};
    const items = cache.items || [];
    let allItemRemarks = cache.itemRemarks || [];
    if (typeof allItemRemarks === 'string') {
        try { allItemRemarks = JSON.parse(allItemRemarks); } catch { allItemRemarks = []; }
    }
    if (!Array.isArray(allItemRemarks)) allItemRemarks = [];

    const fullItemData = item_no
        ? items.find(i => i.item_no === item_no)
        : clickedItem;
    if (!fullItemData) return console.warn("Item not found in catalog:", item_no);

    console.log("🔍 Editing item s_no:", sno, "item_no:", fullItemData.item_no);

    // Gather child addons from order
    const selectedAddons = clickedItem.selectedAddons?.length
        ? clickedItem.selectedAddons
        : salesDtls.filter(i =>
            String(i.parent_sno) === String(clickedItem.s_no) &&
            String(i.s_no) !== String(clickedItem.s_no)
        );

    // Enrich addons with correct prices — fallback if not in main cache
    selectedAddons.forEach(addon => {
        const fullAddonItem = items.find(i => i.item_no === addon.item_no);
        if (fullAddonItem) {
            addon.price = getItemPrice(fullAddonItem);
            addon.unit_price = addon.price;
        } else {
            addon.price = addon.price ?? addon.unit_price ?? 0;
            addon.unit_price = addon.price;
        }
        if (!addon.qty) addon.qty = 1;
    });

    // Extract remarks for pre-filling modal
    const selectedRemarks = [];

    // Main item remarks
    if (clickedItem.remarks && clickedItem.remarks.trim()) {
        const mainItemRemarksData = allItemRemarks.find(r =>
            r.item_no === clickedItem.item_no ||
            String(r.item_no) === String(clickedItem.item_no)
        );

        if (mainItemRemarksData?.remarks_item_details) {
            mainItemRemarksData.remarks_item_details.forEach(remarkGroup => {
                const remarkGroupName = remarkGroup.remarks_group;
                const remarkTexts = clickedItem.remarks.split(',').map(r => r.trim());

                remarkTexts.forEach(remarkText => {
                    const remarkDetail = remarkGroup.remarks_details?.find(rd => {
                        const rdRemarks = (rd.remarks || '').trim().toLowerCase();
                        const rdItemName = (rd.remarks_item_name || '').trim().toLowerCase();
                        const searchText = remarkText.toLowerCase();
                        return rdRemarks === searchText || rdItemName === searchText;
                    });

                    if (remarkDetail) {
                        selectedRemarks.push({
                            remarks_group: remarkGroupName,
                            remarks: remarkDetail.remarks || remarkDetail.remarks_item_name,
                            remarks_item_name: remarkDetail.remarks_item_name || remarkDetail.remarks,
                            seq_no: remarkDetail.seq_no,
                            parent_category: clickedItem.category_code || clickedItem.modifier_name
                        });
                    }
                });
            });
        }
    }

    // Child addon remarks — for pre-filling modal only
    selectedAddons.forEach(addon => {
        if (!addon.remarks || !addon.remarks.trim()) return;

        const addonCategory = addon.category_code || addon.modifier_name;
        const itemRemarksData = allItemRemarks.find(r =>
            r.item_no === addon.item_no ||
            String(r.item_no) === String(addon.item_no)
        );

        if (itemRemarksData?.remarks_item_details) {
            itemRemarksData.remarks_item_details.forEach(remarkGroup => {
                const remarkGroupName = remarkGroup.remarks_group;
                const remarkTexts = addon.remarks.split(',').map(r => r.trim());

                remarkTexts.forEach(remarkText => {
                    const remarkDetail = remarkGroup.remarks_details?.find(rd => {
                        const rdRemarks = (rd.remarks || '').trim().toLowerCase();
                        const rdItemName = (rd.remarks_item_name || '').trim().toLowerCase();
                        const searchText = remarkText.toLowerCase();
                        return rdRemarks === searchText || rdItemName === searchText;
                    });

                    if (remarkDetail) {
                        selectedRemarks.push({
                            remarks_group: remarkGroupName,
                            remarks: remarkDetail.remarks || remarkDetail.remarks_item_name,
                            remarks_item_name: remarkDetail.remarks_item_name || remarkDetail.remarks,
                            seq_no: remarkDetail.seq_no,
                            parent_category: addonCategory
                        });
                    }
                });
            });
        }
    });

    console.log("💬 Final extracted remarks:", selectedRemarks.length);

    const hasModifierGroups = Array.isArray(fullItemData.itemmaster_menutype_grpdtls)
        && fullItemData.itemmaster_menutype_grpdtls.length > 0;
    const hasAddons = fullItemData.is_addon_enable?.toUpperCase() === "Y";

    const remarksEntry = allItemRemarks.find(r =>
        r.item_no === fullItemData.item_no ||
        r.item_no === item_no ||
        r?.item?.item_no === fullItemData.item_no
    );

    const addonData = hasAddons
        ? getAddonsByAddOnName(fullItemData.add_on_name)
        : { cat_dtls: [], item_dtls: [] };

    const enrichedCatDtls = (addonData.cat_dtls || []).map(grp => {
        if (!grp.category_code) {
            const matchedItem = addonData.item_dtls.find(
                i => i.modifier_name === grp.modifier_name && i.category_code
            );
            if (matchedItem) grp.category_code = matchedItem.category_code;
        }
        return { ...grp, item_dtls: getAvailableAddonItems(addonData, grp) };
    });

    const filteredAddonData = { ...addonData, cat_dtls: enrichedCatDtls };

    // ── Close cart modal ──────────────────────────────────────────────────────
    const cartModal = document.getElementById('cartModal');
    const cartOverlay = document.getElementById('cartModalOverlay');
    const bottomNav = document.querySelector('.bottom-nav');

    if (cartModal) {
        cartModal.classList.remove('active');
        cartModal.style.display = 'none';
    }
    if (cartOverlay) {
        cartOverlay.classList.remove('active');
        cartOverlay.style.display = 'none';
    }
    if (bottomNav && HIDE_BOTTOM_NAV_ON_MODAL) {
        bottomNav.classList.add('hide-on-modal');
    }

    // ✅ Set editing sno BEFORE opening modal so closeAddonModalAndRestoreCart
    // knows to restore the cart modal instead of taking the new item branch
    window.currentEditingSno = sno;
    window.modalState = window.modalState || {};
    window.modalState.cartOpen = false;

    console.log("✅ Set currentEditingSno:", sno);

    // ── Edit callback ─────────────────────────────────────────────────────────
    const editCallback = (chosenAddons, chosenRemarks) => {
        // ✅ Set BEFORE addToCart so it survives async operations
        window.currentEditingSno = sno;
    
        addToCart(
            fullItemData.item_no,
            chosenAddons || [],
            chosenRemarks || [],
            sno,
            true
        );
    
        // ✅ Re-set AFTER too as double guarantee
        window.currentEditingSno = sno;
    };

    const useWizardModal = ADDON_MODAL_CONFIG.style === 'wizard' && hasModifierGroups;

    if (useWizardModal) {
        console.log("🧙 Opening WIZARD modal for editing");
        showWizardModal(
            fullItemData,
            editCallback,
            filteredAddonData,
            remarksEntry ? remarksEntry.remarks_item_details : [],
            selectedAddons,
            selectedRemarks,
            sno
        );
    } else {
        console.log("📦 Opening TRADITIONAL modal for editing (config:", ADDON_MODAL_CONFIG.style, ")");
        showAddOnModal(
            fullItemData,
            editCallback,
            filteredAddonData,
            remarksEntry ? remarksEntry.remarks_item_details : [],
            selectedAddons,
            selectedRemarks,
            sno
        );

        setTimeout(() => {
            prefillAddonModal(selectedAddons, selectedRemarks, fullItemData, sno);
        }, 100);
    }
};
function closeAddonModal() {
    window.modalState = window.modalState || {};
    window.modalState.addonOpen = false;
    window.modalState.addonModalDirect = false;

    console.log('📊 Modal state:', {
        addonOpen: !!document.getElementById('addonModal')?.classList.contains('active'),
        cartOpen: !!document.getElementById('cartModal')?.classList.contains('active')
    });

    const addonModal = document.getElementById('addonModal');
    const addonOverlay = document.getElementById('addonModalOverlay');
    const bottomNav = document.querySelector('.bottom-nav');

    if (addonModal) {
        addonModal.classList.remove('active', 'show');
        addonModal.style.display = 'none';
    }
    if (addonOverlay) {
        addonOverlay.classList.remove('active');
        addonOverlay.style.display = 'none';
    }

    if (bottomNav) {
        bottomNav.classList.remove('modal-open', 'hide-on-modal');
    }
    document.body.classList.remove('modal-open');
    document.body.style.overflow = '';

    if (window.currentEditingSno) {
        // ✅ Edit mode — restore cart modal
        console.log('🔄 Edit mode: restoring cart modal, sno:', window.currentEditingSno);
        window.currentEditingSno = null;
        window.modalState.cartOpen = true;

        const cartModal = document.getElementById('cartModal');
        const cartOverlay = document.getElementById('cartModalOverlay');

        if (cartModal) {
            cartModal.classList.add('active');
            cartModal.style.display = 'block';
        }
        if (cartOverlay) {
            cartOverlay.classList.add('active');
            cartOverlay.style.display = 'block';
        }
        document.body.style.overflow = 'hidden';

        if (HIDE_BOTTOM_NAV_ON_MODAL && bottomNav) {
            bottomNav.classList.add('hide-on-modal');
        }
        console.log('✅ Cart modal restored after edit');
    } else {
        console.log('✅ New item mode: closing addon');
        showBottomNav();
    }

    console.log('✅ Addon modal closed');
}

function closeAddonModalAndRestoreCart() {
    window.modalState = window.modalState || {};
    window.modalState.addonOpen = false;
    window.modalState.addonModalDirect = false;

    const addonModal = document.getElementById('addonModal');
    const addonOverlay = document.getElementById('addonModalOverlay');
    const bottomNav = document.querySelector('.bottom-nav');

    if (addonModal) {
        addonModal.classList.remove('active', 'show');
        addonModal.style.display = 'none';
    }
    if (addonOverlay) {
        addonOverlay.classList.remove('active');
        addonOverlay.style.display = 'none';
    }

    // ✅ Always clean modal-open off the nav first
    if (bottomNav) {
        bottomNav.classList.remove('modal-open');
    }
    document.body.classList.remove('modal-open');

    if (window.currentEditingSno) {
        console.log('🔄 Restoring cart modal after edit, sno:', window.currentEditingSno);

        // ✅ Clear AFTER reading, so the branch runs correctly
        window.currentEditingSno = null;
        window.modalState.cartOpen = true;

        const cartModal = document.getElementById('cartModal');
        const cartOverlay = document.getElementById('cartModalOverlay');

        if (cartModal) {
            cartModal.classList.add('active');
            cartModal.style.display = 'block';
        }
        if (cartOverlay) {
            cartOverlay.classList.add('active');
            cartOverlay.style.display = 'block';
        }

        document.body.style.overflow = 'hidden';

        if (HIDE_BOTTOM_NAV_ON_MODAL && bottomNav) {
            bottomNav.classList.add('hide-on-modal');
            bottomNav.classList.remove('modal-open');
            console.log('🔒 Bottom nav stays hidden (cart modal open)');
        } else if (bottomNav) {
            bottomNav.classList.remove('hide-on-modal', 'modal-open');
            showBottomNav();
        }

    } else {
        console.log('✅ Closing addon modal (new item flow)');

        window.currentEditingSno = null;

        if (bottomNav) {
            bottomNav.classList.remove('hide-on-modal', 'modal-open');
        }

        document.querySelectorAll('.modal-overlay, .modal-backdrop').forEach(el => el.remove());
        document.body.style.overflow = '';

        showBottomNav();
    }
}

function prefillAddonModal(selectedAddons, selectedRemarks, fullItemData, editingSno) {
    const modal = document.getElementById("addonModalContent");
    const categoryTotals = {};
    if (!modal) {
        console.warn("Modal not ready, retrying...");
        return setTimeout(() => prefillAddonModal(selectedAddons, selectedRemarks, fullItemData, editingSno), 50);
    }

    console.log("🎨 Prefilling modal with", selectedAddons.length, "addons");
    console.log("💬 Prefilling with", selectedRemarks.length, "remarks");
    console.log("📦 Selected remarks data:", JSON.stringify(selectedRemarks, null, 2));

    // ========================================
    // PREFILL CHECKBOX ADDONS/MODIFIERS
    // ========================================
    selectedAddons.forEach(addon => {
        const itemNo = addon.item_no || addon.citem_no;

        // Find checkbox by value
        const checkbox = modal.querySelector(`input.addon-checkbox[value="${itemNo}"]:not(.remark-checkbox)`);

        if (checkbox && !checkbox.checked) {
            console.log("✓ Checking addon/modifier checkbox:", itemNo, addon.item_name || addon.citem_name);

            // Check the checkbox
            checkbox.checked = true;

            // Set tracking attribute for single-select mode
            checkbox.setAttribute('data-was-checked', 'true');

            // Add selected class to label
            const label = checkbox.closest('.addon-label');
            if (label) {
                label.classList.add('selected');
            }

            // Get category info
            const categoryCode = checkbox.dataset.categoryCode || checkbox.dataset.modifierName;
            const category = document.querySelector(
                `.addon-category[data-category-code="${categoryCode}"]`
            );
            const categoryType = category?.dataset.type;

            // Add to selectedAddons based on type
            window.selectedAddons = window.selectedAddons || [];

            if (categoryType === 'modifier') {
                // Handle modifier
                const modifierGroup = window.itemmasterGroups?.find(
                    g => g.modifier_name === categoryCode
                );
                const modifierItem = window.itemmasterItems?.find(
                    i => i.citem_no === itemNo
                );

                if (modifierGroup && modifierItem) {
                    const normalizedItem = {
                        ...modifierItem,
                        citem_no: itemNo,
                        citem_name: addon.item_name || addon.citem_name,
                        modifier_name: categoryCode,
                        qty: 1,
                        menu_type: modifierItem.menu_type,
                        level_no: modifierItem.level_no || 0,
                    };

                    const { selectionItems, exceed } = addModifierItem(
                        modifierGroup,
                        normalizedItem,
                        window.selectedAddons
                    );

                    if (!exceed) {
                        window.selectedAddons = selectionItems.map(item => ({
                            ...item,
                            parent_sno: 1,
                            ds_no: 1,
                            seat_no: 1
                        }));
                    }
                }
            } else if (categoryType === 'addon') {
                // Handle addon
                const addonData = window.currentAddonData || getAddonsByAddOnName(fullItemData.add_on_name);
                const addonGroup = addonData?.cat_dtls?.find(
                    cat => cat.category_code === categoryCode
                );

                if (addonGroup) {
                    const addonItem = {
                        item_no: itemNo,
                        item_desc: addon.item_name || addon.item_desc,
                        category_code: categoryCode,
                        price: parseFloat(checkbox.dataset.price || addon.price || 0),
                        qty: 1
                    };

                    const { selectionItems, exceed } = addAddonItem(
                        addonGroup,
                        addonItem,
                        window.selectedAddons
                    );

                    if (!exceed) {
                        window.selectedAddons = selectionItems.map(item => ({
                            ...item,
                            parent_sno: 1,
                            ds_no: 1,
                            seat_no: 1
                        }));
                    }
                }
            }

        } else if (!checkbox) {
            console.warn("⚠️ Checkbox not found for addon:", itemNo, addon.item_name);
        }
    });

    // ========================================
    // PREFILL QTY-CONTROLS (if any)
    // ========================================
    selectedAddons.forEach(addon => {
        const itemNo = addon.item_no || addon.citem_no;
        const ctrl = modal.querySelector(`.qty-control[data-item-id="${itemNo}"]`);

        if (!ctrl) return;

        const qtySpan = ctrl.querySelector(".qty-count");
        const decrementBtn = ctrl.querySelector(".decrement");
        const incrementBtn = ctrl.querySelector(".increment");

        if (qtySpan && addon.qty) {
            qtySpan.textContent = addon.qty;

            // Update button states
            if (addon.qty > 0) {
                decrementBtn.disabled = false;
                decrementBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            }

            // Update category count
            const categoryCode = ctrl.dataset.category;
            if (categoryCode && typeof updateCategoryCount === 'function') {
                updateCategoryCount(categoryCode);
            }

            console.log("✓ Set qty for:", itemNo, "to", addon.qty);
        }
    });

    // ========================================
    // PREFILL REMARKS
    // ========================================
    console.log("\n🎯 Starting remark prefill...");
    console.log("Remarks to prefill:", JSON.stringify(selectedRemarks, null, 2));

    // First, let's see what's available in the modal
    console.log("\n📋 Available remark sections in modal:");
    modal.querySelectorAll('.remark-section').forEach(section => {
        console.log(`  - Section:`, {
            categoryCode: section.dataset.categoryCode,
            parentCategory: section.dataset.parentCategory,
            remarkGroup: section.dataset.remarkGroup,
            type: section.dataset.type
        });

        const checkboxes = section.querySelectorAll('input.remark-checkbox');
        console.log(`    Checkboxes (${checkboxes.length}):`, Array.from(checkboxes).map(cb => ({
            value: cb.value,
            remarkText: cb.getAttribute('data-remark-text'),
            remarkGroup: cb.getAttribute('data-remark-group')
        })));
    });

    selectedRemarks.forEach((remark, index) => {
        const remarkText = remark.remarks || remark.remarks_item_name;
        const parentCategory = remark.parent_category;
        const remarkGroup = remark.remarks_group;

        console.log(`\n🔍 [${index + 1}/${selectedRemarks.length}] Prefilling remark:`, {
            text: remarkText,
            parentCategory: parentCategory,
            remarkGroup: remarkGroup,
            fullRemark: remark
        });

        // Strategy 1: Find by parent category and remark group
        let remarkSection = modal.querySelector(
            `.remark-section[data-parent-category="${parentCategory}"][data-remark-group="${remarkGroup}"]`
        );

        if (remarkSection) {
            console.log(`✅ Found section with Strategy 1 (parent-category + remark-group)`);
        }

        // Strategy 2: If not found, try by remark group only
        if (!remarkSection) {
            console.log(`❌ Strategy 1 failed, trying Strategy 2 (remark-group only)...`);
            remarkSection = modal.querySelector(
                `.remark-section[data-remark-group="${remarkGroup}"]`
            );

            if (remarkSection) {
                console.log(`✅ Found section with Strategy 2 (remark-group only)`);
            }
        }

        // If still not found, log all available sections
        if (!remarkSection) {
            console.error(`❌ Could not find remark section!`);
            console.error(`   Searching for: parentCategory="${parentCategory}", remarkGroup="${remarkGroup}"`);
            return;
        }

        // Find the checkbox with matching remark text
        let checkbox = remarkSection.querySelector(
            `input.remark-checkbox[data-remark-text="${remarkText}"]`
        );

        if (checkbox) {
            console.log(`✅ Found checkbox with exact match`);
        }

        // Fallback: try case-insensitive match
        if (!checkbox) {
            console.log(`❌ Exact match failed, trying case-insensitive match...`);
            const allCheckboxes = remarkSection.querySelectorAll('input.remark-checkbox');

            allCheckboxes.forEach(cb => {
                const cbText = cb.getAttribute('data-remark-text');
                if (cbText && cbText.toLowerCase() === remarkText.toLowerCase()) {
                    checkbox = cb;
                    console.log(`   ✅ Case-insensitive match found!`);
                }
            });
        }

        if (checkbox && !checkbox.checked) {
            console.log(`✅ Checking remark checkbox: "${remarkText}"`);

            // Check the checkbox
            checkbox.checked = true;

            // Set tracking attribute
            checkbox.setAttribute('data-was-checked', 'true');

            // Add selected class
            const label = checkbox.closest('.addon-label');
            if (label) {
                label.classList.add('selected');
            }

            console.log(`   Checkbox is now checked:`, checkbox.checked);
        } else if (!checkbox) {
            console.error(`❌ Could not find checkbox for remark text: "${remarkText}"`);
        }
    });

    // ========================================
    // EXPAND ALL CATEGORIES
    // ========================================
    modal.querySelectorAll(".addon-options-wrapper").forEach(wrapper => {
        wrapper.classList.remove("collapsed");
        wrapper.style.display = "block";
    });

    modal.querySelectorAll(".addon-category").forEach(cat => {
        cat.classList.remove("collapsed");
    });

    // ========================================
    // UPDATE MODAL UI
    // ========================================
    // Set modal title
    const titleEl = modal.querySelector(".modal-item-name");
    if (titleEl) titleEl.textContent = fullItemData.item_name;

    // Setup update button
    const updateBtn = modal.querySelector("#updateAddOns");
    if (updateBtn) {
        updateBtn.style.display = "inline-block";
        updateBtn.classList.remove("opacity-50", "cursor-not-allowed");
        updateBtn.disabled = false;

        const newUpdateBtn = updateBtn.cloneNode(true);
        updateBtn.parentNode.replaceChild(newUpdateBtn, updateBtn);

        newUpdateBtn.onclick = () => {
            const chosenAddons = gatherSelectedAddonsFromModal();
            const chosenRemarks = gatherSelectedRemarksFromModal();

            console.log("🔄 Updating cart item", editingSno);
            console.log("📦 Chosen addons:", chosenAddons);
            console.log("💬 Chosen remarks:", chosenRemarks);

            addToCart(
                fullItemData.item_no,
                chosenAddons,
                chosenRemarks,
                editingSno,
                true
            );

            closeAddonModal();

            // ✅ ADD THIS: Force show bottom nav after closing modal
            setTimeout(() => {
                showBottomNav();
                console.log('🔧 Forced bottom nav visible after modal close');
            }, 100);
        };
    }

    // Hide confirm button
    const confirmBtn = modal.querySelector("#confirmAddons");
    if (confirmBtn) confirmBtn.style.display = "none";

    // ========================================
    // TRIGGER VALIDATION
    // ========================================
    if (typeof validateAddToCart === 'function') {
        setTimeout(() => validateAddToCart(), 100);
    }

    console.log("🔢 Updating category counters...");

    // Count quantities by category


    selectedAddons.forEach(addon => {
        const category = addon.category_code || addon.modifier_name;
        const qty = parseInt(addon.qty) || 0;

        if (category) {
            categoryTotals[category] = (categoryTotals[category] || 0) + qty;
        }
    });

    // Update each category counter
    Object.entries(categoryTotals).forEach(([category, total]) => {
        const counterElement = modal.querySelector(`.selected-count[data-category="${category}"]`);
        if (counterElement) {
            counterElement.textContent = total;
            console.log(`✅ Updated category "${category}" counter to ${total}`);
        } else {
            console.warn(`⚠️ Counter not found for category: ${category}`);
        }
    });

    console.log("✅ Modal prefilled successfully");
    console.log("🎯 Final selectedAddons:", window.selectedAddons);
}


export function preloadCartImages(items, MenuItems) {
    const imageUrls = items.map(item => {
        const menuItem = MenuItems.find(mi => mi.item_no === item.item_no);
        return resolveImageUrl(item, menuItem);
    }).filter(url => url && url !== RESTAURANT_CONFIG.logo);

    // Preload with high priority
    if (imageUrls.length > 0) {
        preloadImages(imageUrls, 'high');
    }
}


window.renderCartFromOrder = renderCartFromOrder;
window.updateOrderCacheOnServer = updateOrderCacheOnServer;
window.updateQuantityBySno = updateQuantityBySno;
window.deleteIndividualItem = deleteIndividualItem;
window.handleRemoveClick = handleRemoveClick;
window.getOrCreateOrderId = getOrCreateOrderId;

console.log('✅ CRUD functions with server sync loaded');

function validateGroupsBeforeAddToCart() {
    let allGroupsValid = true;

    itemmasterGroups.forEach(group => {
        const groupName = group.modifier_name;
        const isOptional = group.is_optional === 'Y';

        const allControls = container.querySelectorAll(`.qty-control[data-category="${groupName}"]`);

        let groupTotalQty = 0;
        for (const control of allControls) {
            const qty = parseInt(control.querySelector('.qty-count')?.textContent || '0', 10);
            groupTotalQty += qty;
        }

        if (!isOptional && groupTotalQty === 0) {
            // Group is required but nothing selected
            allGroupsValid = false;
        }
    });

    // Enable or disable Add to Cart
    const addToCartBtn = document.getElementById('addToCartBtn');
    if (addToCartBtn) {
        addToCartBtn.disabled = !allGroupsValid;
        addToCartBtn.classList.toggle('opacity-50', !allGroupsValid); // optional: visual cue
    }
}
function highlightInvalidGroups() {
    itemmasterGroups.forEach(group => {
        const groupName = group.modifier_name;
        const isOptional = group.is_optional === 'Y';

        const allControls = container.querySelectorAll(`.qty-control[data-category="${groupName}"]`);
        let totalQty = 0;

        for (const control of allControls) {
            const qty = parseInt(control.querySelector('.qty-count')?.textContent || '0', 10);
            totalQty += qty;
        }

        const titleEl = document.querySelector(`.addon-category-title[data-category="${groupName}"]`);
        if (!isOptional && totalQty === 0 && titleEl) {
            titleEl.classList.add('text-red-600'); // or add border, warning icon, etc.
        } else {
            titleEl?.classList.remove('text-red-600');
        }
    });
}

function updateButtonStates(control, quantity) {
    const decrementBtn = control.querySelector('.decrement');
    const incrementBtn = control.querySelector('.increment');
    const category = control.dataset.category;

    if (decrementBtn) {
        decrementBtn.disabled = quantity <= 0;
        decrementBtn.classList.toggle('opacity-50', quantity <= 0);
        decrementBtn.classList.toggle('cursor-not-allowed', quantity <= 0);
    }

    if (incrementBtn) {
        const categoryEl = control.closest('.addon-category');
        const maxQty = parseInt(categoryEl?.dataset.maxQty || '0');
        const currentTotal = calculateCategoryTotal(category);

        const disableIncrement = maxQty > 0 && currentTotal >= maxQty && quantity === 0;
        incrementBtn.disabled = disableIncrement;
        incrementBtn.classList.toggle('opacity-50', disableIncrement);
        incrementBtn.classList.toggle('cursor-not-allowed', disableIncrement);
    }
}

// Helper function to calculate category total
function calculateCategoryTotal(category) {
    if (!window.qtyMap || !window.qtyMap[category]) return 0;
    return Object.values(window.qtyMap[category]).reduce((sum, qty) => sum + qty, 0);
}

// Helper function to update category total display
function updateCategoryTotal(category, modal) {
    let totalQty = 0;

    // Find all quantity controls for this category
    modal.querySelectorAll(`.qty-control[data-category="${category}"]`).forEach(ctrl => {
        const qtySpan = ctrl.querySelector('.qty-count');
        const qty = parseInt(qtySpan?.textContent || '0', 10);
        totalQty += qty;
    });

    // Update the category counter
    const counterSpan = modal.querySelector(`.selected-count[data-category="${category}"]`);
    if (counterSpan) {
        counterSpan.textContent = totalQty;
    }

    // Get category limits
    const categoryDiv = modal.querySelector(`[data-category-code="${category}"]`);
    const maxQty = parseInt(categoryDiv?.dataset.maxQty || '999', 10);
    const groupLimit = parseInt(categoryDiv?.dataset.groupLimit || '0', 10);

    console.log(`📊 Category ${category}: ${totalQty}/${maxQty} selected`);

    // Update button states based on limits
    modal.querySelectorAll(`.qty-control[data-category="${category}"]`).forEach(ctrl => {
        const qtySpan = ctrl.querySelector('.qty-count');
        const currentQty = parseInt(qtySpan?.textContent || '0', 10);
        const incrementBtn = ctrl.querySelector('.increment');
        const decrementBtn = ctrl.querySelector('.decrement');

        // Handle increment button state
        if (incrementBtn) {
            const canIncrement = (totalQty < maxQty) && (groupLimit === 0 || currentQty < groupLimit);

            if (canIncrement) {
                incrementBtn.disabled = false;
                incrementBtn.classList.remove('opacity-50', 'cursor-not-allowed');
                incrementBtn.classList.add('bg-gray-200');
            } else {
                incrementBtn.disabled = true;
                incrementBtn.classList.add('opacity-50', 'cursor-not-allowed');
                incrementBtn.classList.remove('bg-gray-200');
            }
        }

        // Handle decrement button state
        if (decrementBtn) {
            if (currentQty > 0) {
                decrementBtn.disabled = false;
                decrementBtn.classList.remove('opacity-50', 'cursor-not-allowed');
                decrementBtn.classList.add('bg-gray-200');
            } else {
                decrementBtn.disabled = true;
                decrementBtn.classList.add('opacity-50', 'cursor-not-allowed');
                decrementBtn.classList.remove('bg-gray-200');
            }
        }
    });
}
// Helper function to update all categories
function updateAllCategories(modal) {
    const categories = modal.querySelectorAll('.addon-category');
    categories.forEach(categoryEl => {
        const categoryCode = categoryEl.dataset.categoryCode;
        if (categoryCode) {
            updateCategoryTotal(categoryCode, modal);
        }
    });
}

// Example usage with event listeners
function setupAddonControls(modal) {
    modal.addEventListener('click', function (e) {
        if (e.target.classList.contains('increment') || e.target.classList.contains('decrement')) {
            e.preventDefault();

            const button = e.target;
            const qtyControl = button.closest('.qty-control');
            const qtySpan = qtyControl.querySelector('.qty-count');
            const category = qtyControl.dataset.category;

            let currentQty = parseInt(qtySpan.textContent, 10) || 0;

            if (button.classList.contains('increment') && !button.disabled) {
                qtySpan.textContent = currentQty + 1;
            } else if (button.classList.contains('decrement') && !button.disabled && currentQty > 0) {
                qtySpan.textContent = currentQty - 1;
            }

            // Update the category after quantity change
            updateCategoryTotal(category, modal);
        }
    });
}

let currentAddonParentItem = null;
function confirmAddonSelection() {
    const selectedAddons = Array.from(
        document.querySelectorAll('.addon-checkbox:checked')
    ).map(cb => ({
        item_no: cb.value,
        price: parseFloat(cb.dataset.price),
        name: cb.dataset.name
    }));

    // 📝 Get any remarks currently selected in modal (if available)
    const selectedRemarks = window.selectedRemarks || []; // or your actual variable
    const remarksText = selectedRemarks.map(r => r.remark_name).join(", ");

    if (currentAddonParentItem) {
        const price = parseFloat(getPriceByServiceType(currentAddonParentItem));

        // ✅ Inject remarks directly into parent before passing to cart
        const parentWithRemarks = {
            ...currentAddonParentItem,
            remarks: remarksText
        };

        pushItemToCart(parentWithRemarks, price, selectedAddons);
    }

    closeAddonModal();
}

function getAddonsByAddOnName(addOnName) {
    // ✅ Check all possible keys where addons might be stored
    let addonGroups = useCache()?.addons
        || useCache()?.addOnItems
        || useCache()?.AddOnItems
        || [];

    // ✅ Fallback to apiManager/sessionStorage after warm boot
    if (!addonGroups.length) {
        addonGroups = window.apiManager?.loadedData?.get('AddOnItems')
            || JSON.parse(sessionStorage.getItem('AddOnItems') || '[]');

        if (addonGroups.length) {
            console.log(`⚡ getAddonsByAddOnName: using AddOnItems fallback (${addonGroups.length} groups)`);
        }
    }

    const found = addonGroups.find(g => g.add_on_name === addOnName) || null;
    console.log(`🔍 getAddonsByAddOnName("${addOnName}"):`, found ? '✅ found' : '❌ not found');
    return found;
}

function getCategoryItems(category_code) {
    const menuSections = useCache((state) => state.setMenuItems);
    if (!Array.isArray(menuSections)) return [];

    const allItems = menuSections.flatMap(section => section.items || []);

    const seen = new Set();
    return allItems.filter(item => {
        if (!item || typeof item !== 'object') return false;
        if (!item.category_code || !item.item_no) return false;
        if (parseFloat(item.price) <= 0) return false;

        // Remove hidden items if needed
        if (typeof isMenuCategoryOrItemHidden === "function" &&
            isMenuCategoryOrItemHidden("I", item.item_no)) return false;

        if (item.category_code !== category_code) return false;

        if (seen.has(item.item_no)) return false;  // skip duplicates
        seen.add(item.item_no);
        return true;
    });
}

function hasDirectItems(category_code) {
    const menuSections = useCache().menuItems || [];
    const section = menuSections.find(s => s.root_category_code === category_code);
    if (!section || !Array.isArray(section.items)) return false;

    // Filter visible, non-zero-price items
    const visibleItems = section.items.filter(item => {
        if (!item) return false;
        if (parseFloat(item.price) <= 0) return false;
        if (typeof isMenuCategoryOrItemHidden === 'function' && isMenuCategoryOrItemHidden('I', item.item_no)) return false;
        return true;
    });

    return visibleItems.length > 0;
}

document.addEventListener("DOMContentLoaded", () => {
    let langName = document.getElementById("currentLanguage");

    document.addEventListener("click", async function (e) {
        if (e.target.closest(".language-option")) {
            const option = e.target.closest(".language-option");
            //langName = option.getAttribute("ids"); // e.g. "English", "Tamil"

            updateCartTranslations(langName);
            console.log("🌐 Switching language to:", langName);

            // Load translations
            const result = await getMenuCategoryItemTranslations({ info: { language_name: langName } });

            // ✅ Guard against undefined
            if (window.languageSystem?.processTranslations) {
                window.languageSystem.processTranslations(langName, result);
            } else {
                console.warn("⚠️ window.languageSystem not found, skipping processTranslations");
            }

            // Refresh category tabs
            const categories = useCache().categories || [];
            await populateCategoryTabs(categories, langName);

            // Refresh menu grid for first category
            const firstCategory = categories[0];
            if (firstCategory) renderCategoryByCode(firstCategory.category_code, langName);

            console.log("✅ Language switch complete!");
        }
    });
});


let userData = {
    isMember: false,
    phoneNumber: null,
    name: null
};

function showOrderTypeModal() {
    const orderTypeModal = document.getElementById('orderTypeModal');
    const loginModal = document.getElementById('loginModal');

    // Hide login modal if visible
    if (loginModal) {
        loginModal.style.display = 'none';
    }

    // Show order type modal
    if (orderTypeModal) {
        orderTypeModal.style.display = 'flex';
        console.log('✅ Order type modal shown for member');
    } else {
        console.error('❌ Order type modal not found in DOM');
    }
}

// ✅ NEW FUNCTION: Handle order type selection from modal (for members)
window.selectOrderTypeFromModal = function (type) {
    console.log('📦 Order type selected from modal:', type);

    const orderTypeModal = document.getElementById('orderTypeModal');
    const landingOverlay = document.getElementById('landingOverlay');

    // Hide order type modal
    if (orderTypeModal) {
        orderTypeModal.style.display = 'none';
    }

    // Hide landing overlay
    if (landingOverlay) {
        landingOverlay.style.display = 'none';
    }

    // Get current language
    const language = localStorage.getItem('selectedLang') || 'en';

    // Call the existing selectOrderType function
    selectOrderType(type, language);
};

function attachOrderTypeHandlersImmediate() {
    console.log('⚡ Attaching handlers immediately...');

    const orderOptions = document.querySelectorAll('.landing-option[data-type]');

    if (orderOptions.length === 0) {
        console.warn('⚠️ No order type options found');
        return;
    }

    orderOptions.forEach((option) => {
        const type = option.getAttribute('data-type');

        if (!type) return;

        // Remove all existing listeners by cloning
        const newOption = option.cloneNode(true);
        option.parentNode.replaceChild(newOption, option);

        // Add fresh click handler
        newOption.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const clickedType = this.getAttribute('data-type');
            console.log('🎯 Order type clicked (immediate):', clickedType);

            handleOrderTypeSelection(clickedType);
        }, { capture: true });

        // Also add to the button inside
        const button = newOption.querySelector('.landing-option-btn');
        if (button) {
            button.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                const clickedType = newOption.getAttribute('data-type');
                console.log('🎯 Button clicked (immediate):', clickedType);

                handleOrderTypeSelection(clickedType);
            }, { capture: true });
        }

        newOption.dataset.handlerAttached = 'true';
        console.log(`✅ Immediate handler attached (type: ${type})`);
    });

    console.log('✅ All immediate handlers attached');
}

// Watch for DOM changes
function observeOrderTypeChanges() {
    const landingOptions = document.querySelector('.landing-options');

    if (!landingOptions) {
        console.warn('⚠️ .landing-options container not found');
        return;
    }

    console.log('👁️ Setting up DOM observer...');

    let isProcessing = false;

    const observer = new MutationObserver(function (mutations) {
        if (isProcessing) return;

        const hasOrderTypeOptions = landingOptions.querySelector('.landing-option[data-type]');

        if (hasOrderTypeOptions) {
            isProcessing = true;
            console.log('🔄 Order type options detected in DOM');

            setTimeout(() => {
                attachOrderTypeHandlers();
                isProcessing = false;
            }, 150);
        }
    });

    observer.observe(landingOptions, {
        childList: true,
        subtree: true
    });

    console.log('✅ DOM observer active');
}
(function initializeOrderTypeSystem() {
    console.log('🚀 Initializing order type handler system...');

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(() => {
                observeOrderTypeChanges();
                attachOrderTypeHandlers();
            }, 500);
        });
    } else {
        setTimeout(() => {
            observeOrderTypeChanges();
            attachOrderTypeHandlers();
        }, 500);
    }

    console.log('✅ Order type handler system initialized');
})();

window.handleMemberLogin = handleMemberLogin;
window.showLoginScreen = showLoginScreen;
window.closeLoginModal = closeLoginModal;
window.proceedAsGuest = proceedAsGuest;
function updateCartTranslations(langName) {
    const t = uiTranslations[langName];

    if (!t) return; // fallback if language not found

    // Header
    document.querySelector(".cart-header h2").textContent = t.yourOrder;

    // Empty cart message
    const emptyCart = document.querySelector(".empty-cart");
    if (emptyCart) {
        emptyCart.innerHTML = `${t.emptyCart}<br>${t.selectItems}`;
    }

    // Labels
    document.querySelector(".subtotal .cart-total-label").textContent = t.subtotal + ":";
    document.querySelector("#service-charge").closest(".cart-total-row").querySelector(".cart-total-label").childNodes[0].textContent = t.serviceCharge + " (";
    document.querySelector("#gst").closest(".cart-total-row").querySelector(".cart-total-label").childNodes[0].textContent = t.gst + " (";
    document.querySelector(".final-total .cart-total-label").textContent = t.total + ":";

    // Button
    document.querySelector("#checkout-btn").textContent = t.placeOrder;
}

function initMobileOptimizations() {
    // Detect if mobile
    const isMobile = window.innerWidth <= 992;

    if (isMobile) {
        // Force bottom nav visibility
        const bottomNav = document.querySelector('.bottom-nav');
        if (bottomNav && cart.length > 0) {
            bottomNav.style.display = 'flex';
        }

        // Disable hover effects on mobile
        document.body.classList.add('mobile-device');
    }

    // Handle orientation changes
    window.addEventListener('orientationchange', () => {
        setTimeout(() => {
            updateCartCount();
            renderCartFromOrder();
        }, 200);
    });
}
function initMobileCategoryTabs() {
    // Only run on mobile
    if (window.innerWidth > 992) return;

    const sidebar = document.querySelector('.navigation-sidebar');
    const categoryTabs = document.querySelectorAll('.category-tab');

    if (!sidebar || categoryTabs.length === 0) return;

    console.log('📱 Initializing mobile category tabs');

    function scrollToActiveTab() {
        const activeTab = sidebar.querySelector('.category-tab.active');
        if (!activeTab) return;

        const sidebarWidth = sidebar.offsetWidth;
        const tabLeft = activeTab.offsetLeft;
        const tabWidth = activeTab.offsetWidth;

        // Calculate scroll position to center the active tab
        const scrollPosition = tabLeft - (sidebarWidth / 2) + (tabWidth / 2);

        sidebar.scrollTo({
            left: scrollPosition,
            behavior: 'smooth'
        });

        console.log('📍 Scrolled to active tab:', activeTab.textContent.trim());
    }


    let startX = 0;
    let scrollLeft = 0;
    let isDown = false;

    sidebar.addEventListener('mousedown', (e) => {
        isDown = true;
        sidebar.style.cursor = 'grabbing';
        startX = e.pageX - sidebar.offsetLeft;
        scrollLeft = sidebar.scrollLeft;
    });

    sidebar.addEventListener('mouseleave', () => {
        isDown = false;
        sidebar.style.cursor = 'grab';
    });

    sidebar.addEventListener('mouseup', () => {
        isDown = false;
        sidebar.style.cursor = 'grab';
    });

    sidebar.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        e.preventDefault();
        const x = e.pageX - sidebar.offsetLeft;
        const walk = (x - startX) * 2;
        sidebar.scrollLeft = scrollLeft - walk;
    });

    // Touch events for mobile
    let touchStartX = 0;
    let touchScrollLeft = 0;

    sidebar.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].pageX - sidebar.offsetLeft;
        touchScrollLeft = sidebar.scrollLeft;
    });

    sidebar.addEventListener('touchmove', (e) => {
        const x = e.touches[0].pageX - sidebar.offsetLeft;
        const walk = (x - touchStartX) * 2;
        sidebar.scrollLeft = touchScrollLeft - walk;
    });

    // ============================================
    // SCROLL INDICATORS (OPTIONAL)
    // ============================================
    function updateScrollIndicators() {
        const scrollLeft = sidebar.scrollLeft;
        const scrollWidth = sidebar.scrollWidth;
        const clientWidth = sidebar.clientWidth;

        // Add shadow on left if scrolled
        if (scrollLeft > 10) {
            sidebar.style.boxShadow = 'inset 10px 0 10px -10px rgba(0,0,0,0.3), 0 2px 8px rgba(0, 0, 0, 0.1)';
        }
        // Add shadow on right if not at end
        else if (scrollLeft + clientWidth < scrollWidth - 10) {
            sidebar.style.boxShadow = 'inset -10px 0 10px -10px rgba(0,0,0,0.3), 0 2px 8px rgba(0, 0, 0, 0.1)';
        }
        // No shadow if at boundaries
        else {
            sidebar.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.1)';
        }
    }

    sidebar.addEventListener('scroll', updateScrollIndicators);

    // ============================================
    // INITIALIZE ON LOAD
    // ============================================
    setTimeout(() => {
        scrollToActiveTab();
        updateScrollIndicators();
    }, 100);

    console.log('✅ Mobile category tabs initialized');
}

// ============================================
// SNAP SCROLLING TO NEAREST TAB (OPTIONAL)
// ============================================
function initSnapScrolling() {
    if (window.innerWidth > 992) return;

    const sidebar = document.querySelector('.navigation-sidebar');
    if (!sidebar) return;

    let scrollTimeout;

    sidebar.addEventListener('scroll', function () {
        // Clear previous timeout
        clearTimeout(scrollTimeout);

        // Set timeout to snap after scrolling stops
        scrollTimeout = setTimeout(() => {
            const tabs = sidebar.querySelectorAll('.category-tab');
            const sidebarRect = sidebar.getBoundingClientRect();
            const sidebarCenter = sidebarRect.left + sidebarRect.width / 2;

            let closestTab = null;
            let closestDistance = Infinity;

            // Find the tab closest to center
            tabs.forEach(tab => {
                const tabRect = tab.getBoundingClientRect();
                const tabCenter = tabRect.left + tabRect.width / 2;
                const distance = Math.abs(tabCenter - sidebarCenter);

                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestTab = tab;
                }
            });

            // Snap to closest tab
            if (closestTab) {
                const tabLeft = closestTab.offsetLeft;
                const tabWidth = closestTab.offsetWidth;
                const scrollPosition = tabLeft - (sidebarRect.width / 2) + (tabWidth / 2);

                sidebar.scrollTo({
                    left: scrollPosition,
                    behavior: 'smooth'
                });
            }
        }, 150); // Delay after scroll stops
    });
}

// ============================================
// KEYBOARD NAVIGATION (ACCESSIBILITY)
// ============================================
function initKeyboardNavigation() {
    if (window.innerWidth > 992) return;

    const categoryTabs = document.querySelectorAll('.category-tab');

    categoryTabs.forEach((tab, index) => {
        tab.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft' && index > 0) {
                e.preventDefault();
                categoryTabs[index - 1].focus();
                categoryTabs[index - 1].click();
            } else if (e.key === 'ArrowRight' && index < categoryTabs.length - 1) {
                e.preventDefault();
                categoryTabs[index + 1].focus();
                categoryTabs[index + 1].click();
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                tab.click();
            }
        });
    });
}

// ============================================
// INITIALIZE ON DOM READY
// ============================================
document.addEventListener('DOMContentLoaded', function () {
    initMobileCategoryTabs();
    initSnapScrolling();
    initKeyboardNavigation();
});

// Re-initialize on window resize
let resizeTimeout;
window.addEventListener('resize', function () {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        initMobileCategoryTabs();
        initSnapScrolling();
        initKeyboardNavigation();
    }, 250);
});

// ============================================
// AUTO-SCROLL CAROUSEL (AUTO SWITCH CATEGORIES)
// ============================================
let autoScrollInterval = null;
let autoScrollEnabled = false;
const AUTO_SCROLL_DELAY = 5000; // 5 seconds per category

function startAutoScroll() {
    if (window.innerWidth > 992) return;

    const categoryTabs = document.querySelectorAll('.category-tab');
    if (categoryTabs.length === 0) return;

    let currentIndex = 0;

    // Find current active tab index
    categoryTabs.forEach((tab, index) => {
        if (tab.classList.contains('active')) {
            currentIndex = index;
        }
    });

    console.log('🔄 Auto-scroll started');
    autoScrollEnabled = true;

    autoScrollInterval = setInterval(() => {
        // Move to next tab
        currentIndex = (currentIndex + 1) % categoryTabs.length;

        // Click the next tab
        categoryTabs[currentIndex].click();

        console.log(`📱 Auto-switched to: ${categoryTabs[currentIndex].textContent.trim()}`);
    }, AUTO_SCROLL_DELAY);
}

function stopAutoScroll() {
    if (autoScrollInterval) {
        clearInterval(autoScrollInterval);
        autoScrollInterval = null;
        autoScrollEnabled = false;
        console.log('⏸️ Auto-scroll stopped');
    }
}


window.mobileCategoryTabs = {
    init: initMobileCategoryTabs,
    scrollToActive: function () {
        const sidebar = document.querySelector('.navigation-sidebar');
        const activeTab = sidebar?.querySelector('.category-tab.active');
        if (activeTab) {
            const sidebarWidth = sidebar.offsetWidth;
            const tabLeft = activeTab.offsetLeft;
            const tabWidth = activeTab.offsetWidth;
            const scrollPosition = tabLeft - (sidebarWidth / 2) + (tabWidth / 2);

            sidebar.scrollTo({
                left: scrollPosition,
                behavior: 'smooth'
            });
        }
    },
    startAutoScroll: startAutoScroll,
    stopAutoScroll: stopAutoScroll,
    //pauseAutoScroll: pauseAutoScroll,
    isAutoScrollEnabled: function () {
        return autoScrollEnabled;
    }
};



