// ============================================
// ASCENTIS CRM - Complete Member & Voucher Management
// ============================================

import { useCache } from "../stores/cache-store.js";
import { useOrder } from "../stores/order-store.js";
import { selectOrderType, setKioskLogo, resolveImageUrl } from "../js/GetHomeAPI.js";
import { applyPromotions, getSetting, calcOrderAmt, checkDiscApplicable } from "../utils/pos.js";
import { HTTPS, PROMO_BY, PROMO_TYPE, URL } from "../utils/constants.js";
import { contains, same } from "../utils/common.js";

// ============================================
// CONSTANTS
// ============================================
const ORIGINAL_URL = window.location.href;
console.log('📍 URL locked:', ORIGINAL_URL);
let isSelectingOrderType = false;

// ============================================
// CRM VENDOR DETECTION
// ============================================
export function getCRMVendor() {
    return localStorage.getItem("crmVendor") || "Ascentis";
}

export function setCRMVendor(vendor) {
    localStorage.setItem("crmVendor", vendor);
    console.log("✅ CRM Vendor set to:", vendor);
}

const parseAscentisDate = (value) => {
    if (!value || typeof value !== 'string') return null;
    const m = value.match(/\/Date\((\d+)\)\//);
    if (!m) return null;
    const d = dayjs(Number(m[1]));
    return d.isValid() ? d.toISOString() : null;
};

function normalizeVoucherForBuilder(raw) {
    const parseDate = (val) => {
        if (!val) return null;
        const iso = parseAscentisDate(val);
        return iso || val;
    };
    return {
        ...raw,
        Type: (raw.Type || '').toUpperCase(),
        ValidFrom: dayjs(parseDate(raw.ValidFrom)).format('YYYY-MM-DD HH:mm:ss'),
        ValidTo: dayjs(parseDate(raw.ValidTo)).format('YYYY-MM-DD HH:mm:ss'),
    };
}

// ============================================
// REF7 PARSER — single source of truth
// ============================================
function parseRef7(raw) {
    if (!raw) return null;
    const value = raw.includes('|-|') ? raw.split('|-|')[1]?.trim() : raw.trim();
    if (!value || value === ' ') return null;
    const parts = value.split('|');

    if (parts[0].startsWith('SETXCC:')) {
        const excludeCats = parts[0].replace('SETXCC:', '').split(',').map(c => c.trim());
        return { pattern: 'SETXCC', excludeCats, setQty: parseInt(parts[1]) || 2, criteria: parts[2]?.trim() || 'LD' };
    }
    if (parts[0].startsWith('SETXC:')) {
        return { pattern: 'SETXC', excludeCat: parts[0].replace('SETXC:', '').trim(), setQty: parseInt(parts[1]) || 2, criteria: parts[2]?.trim() || 'LD' };
    }
    if (parts[0].startsWith('SETSCC:')) {
        const includeCats = parts[0].replace('SETSCC:', '').split(',').map(c => c.trim());
        return { pattern: 'SETSCC', includeCats, setQty: parseInt(parts[1]) || 2, criteria: parts[2]?.trim() || 'LD' };
    }
    if (parts[0].startsWith('SETSIC:')) {
        const includeSKUs = parts[0].replace('SETSIC:', '').split(',').map(c => c.trim());
        return { pattern: 'SETSIC', includeSKUs, setQty: parseInt(parts[1]) || 2, criteria: parts[2]?.trim() || 'LD' };
    }
    if (parts[0].startsWith('PREFIXC:')) {
        const prefixes = parts[0].replace('PREFIXC:', '').split(',').map(p => p.trim().toUpperCase());
        return { pattern: 'PREFIXC', excludePrefix: prefixes[0], prefixes, qty: 1 };
    }
    if (parts[1]?.startsWith('XCC:')) {
        const excludeCats = parts[1].replace('XCC:', '').split(',').map(c => c.trim());
        return { pattern: 'XCC', value: parseFloat(parts[0]) || 0, excludeCats };
    }
    if (parts[1]?.startsWith('PREFIXC:')) {
        const prefixes = parts[1].replace('PREFIXC:', '').split(',').map(p => p.trim().toUpperCase());
        return { pattern: 'PREFIXC', excludePrefix: prefixes[0], prefixes, qty: parseInt(parts[0]) || 1 };
    }
    if (parts[1]?.startsWith('SIC:')) {
        const items = parts[1].replace('SIC:', '').split(',').map(s => s.trim());
        return { pattern: 'SIC', value: parseFloat(parts[0]) || 0, items };
    }
    if (parts[1]?.startsWith('SCC:')) {
        const cats = parts[1].replace('SCC:', '').split(',').map(c => c.trim());
        return { pattern: 'SCC', value: parseFloat(parts[0]) || 0, categories: cats, category: cats[0] || '', maxQty: parseInt(parts[2]) || null };
    }
    if (parts[1]?.toUpperCase() === 'AI') {
        return { pattern: 'VALUE_BY', value: parseFloat(parts[0]) || 0, by: 'AI' };
    }
    if (parts.length >= 2) {
        return { pattern: 'VALUE_BY', value: parseFloat(parts[0]) || 0, by: parts[1]?.trim() || 'AI' };
    }
    return { pattern: 'VALUE', value: parseFloat(parts[0]) || 0 };
}

// ============================================
// PROMOTION BUILDER — uses parseRef7
// ============================================
export const buildPromotionObjectFromAscentisConfig = (rawVoucher) => {
    const voucher = normalizeVoucherForBuilder(rawVoucher);
    const Type = voucher?.Type;
    const VoucherTypeName = voucher?.VoucherTypeName;

    const parsed = parseRef7(voucher?.Ref7);
    if (!parsed) return null;

    const isItemLevelVoucher = ['IDDISCOUNT', 'IPDISCOUNT'].includes(Type);

    let by_item = PROMO_BY.ALL_ITEMS;
    let item_menu_category_dtls = [];
    let item_dtls = [];
    let si_item_codes = [];
    let criteria_disc_value = 0;
    let criteria_payment_name = '1';
    let criteria_type = '';

    switch (parsed.pattern) {

        case 'XCC': {
            criteria_disc_value = parsed.value;
            if (isItemLevelVoucher) {
                const excludeIds = new Set(parsed.excludeCats.map(c => c.toUpperCase()));
                const { menuItems = [] } = useCache() || {};
                const seen = new Set();
                item_menu_category_dtls = menuItems
                    .filter(mi => Array.isArray(mi?.category) && mi.category.length > 0)
                    .flatMap(mi => mi.category)
                    .filter(cat => {
                        const code = (cat?.category_code || '').trim().toUpperCase();
                        return code && !excludeIds.has(code) && !seen.has(code) && seen.add(code);
                    })
                    .map(cat => ({ category_code: cat.category_code.trim().toUpperCase(), qty: 1 }));
                by_item = PROMO_BY.SELECTED_CATEGORIES;
                console.log('✅ XCC item discount — excluded:', [...excludeIds], '| included:', item_menu_category_dtls.map(c => c.category_code));
            }
            break;
        }

        case 'SCC': {
            criteria_disc_value = parsed.value;
            item_menu_category_dtls = parsed.categories.map(c => ({ category_code: c.trim().toUpperCase(), qty: 1 }));
            by_item = PROMO_BY.SELECTED_CATEGORIES;
            // 0 = unlimited, positive integer = explicit cap
            criteria_payment_name = parsed.maxQty != null ? String(parsed.maxQty) : '0';
            break;
        }

        case 'SIC': {
            criteria_disc_value = parsed.value;
            si_item_codes = parsed.items.map(s => s.trim().toUpperCase());
            item_dtls = parsed.items.map(id => ({ prefix: id.trim().toUpperCase(), qty: 0 }));
            by_item = PROMO_BY.SELECTED_ITEMS;
            break;
        }

        case 'PREFIXC': {
            criteria_disc_value = parsed.qty || 1;
            item_dtls = parsed.prefixes.map(p => ({ prefix: p, qty: 0 }));
            by_item = PROMO_BY.PREFIX_CHILD;
            break;
        }

        case 'SETSCC': {
            criteria_payment_name = String(parsed.setQty || 2);
            criteria_type = parsed.criteria || 'LD';
            item_menu_category_dtls = parsed.includeCats.map(c => ({ category_code: c.trim().toUpperCase(), qty: 1 }));
            by_item = PROMO_BY.SET_DEALS;
            break;
        }

        case 'SETSIC': {
            criteria_payment_name = String(parsed.setQty || 2);
            criteria_type = parsed.criteria || 'LD';
            const { items = [] } = useCache() || {};
            item_dtls = parsed.includeSKUs.map(sku => {
                const found = items.find(i => (i?.sku_no || '').toUpperCase() === sku.toUpperCase());
                return found ? { item_no: found.item_no, qty: 0 } : { prefix: sku.toUpperCase(), qty: 0 };
            });
            by_item = PROMO_BY.SET_DEALS;
            break;
        }

        case 'SETXC':
        case 'SETXCC': {
            criteria_payment_name = String(parsed.setQty || 2);
            criteria_type = parsed.criteria || 'LD';
            const excludeIds = new Set(
                (parsed.excludeCats || [parsed.excludeCat]).filter(Boolean).map(c => c.toUpperCase())
            );
            const { menuItems: mi = [] } = useCache() || {};
            const seen = new Set();
            item_menu_category_dtls = mi
                .filter(m => Array.isArray(m?.category) && m.category.length > 0)
                .flatMap(m => m.category)
                .filter(cat => {
                    const code = (cat?.category_code || '').trim().toUpperCase();
                    return code && !excludeIds.has(code) && !seen.has(code) && seen.add(code);
                })
                .map(cat => ({ category_code: cat.category_code.trim().toUpperCase(), qty: 1 }));
            by_item = PROMO_BY.SET_DEALS;
            break;
        }

        case 'VALUE_BY': {
            criteria_disc_value = parsed.value;
            if (parsed.by === 'AI') {
                by_item = PROMO_BY.ALL_ITEMS;
            } else if (parsed.by?.startsWith('SC:')) {
                by_item = PROMO_BY.SELECTED_CATEGORIES;
                item_menu_category_dtls = [{ category_code: parsed.by.replace('SC:', '').toUpperCase(), qty: 1 }];
            } else {
                by_item = PROMO_BY.ALL_ITEMS;
            }
            break;
        }

        default: {
            criteria_disc_value = parsed.value || 0;
            by_item = PROMO_BY.ALL_ITEMS;
            break;
        }
    }

    // ── Map Type → criteria_type and criteria_disc_type ───────────────────────
    let criteria_disc_type = '';
    switch (Type) {
        case 'IDDISCOUNT': criteria_type = PROMO_TYPE.ITEM_DISCOUNT; criteria_disc_type = 'V'; break;
        case 'IPDISCOUNT': criteria_type = PROMO_TYPE.ITEM_DISCOUNT; criteria_disc_type = 'P'; break;
        case 'DDISCOUNT':
        case 'DISCOUNT': criteria_type = PROMO_TYPE.TOTAL_DISCOUNT; criteria_disc_type = 'V'; break;
        case 'PDISCOUNT': criteria_type = PROMO_TYPE.TOTAL_DISCOUNT; criteria_disc_type = 'P'; break;
        case 'FREEITEM':
            if (criteria_type === 'LD') {
                criteria_type = PROMO_TYPE.LOWEST_PRICE_DISCOUNT;
                criteria_disc_type = 'P';
            } else if (!criteria_type) {
                criteria_type = PROMO_TYPE.ITEM_DISCOUNT;
            }
            break;
    }

    const isTotalDiscount = ['DDISCOUNT', 'PDISCOUNT', 'DISCOUNT'].includes(Type);
    const finalDiscValue = (Type === 'FREEITEM' && criteria_type === PROMO_TYPE.LOWEST_PRICE_DISCOUNT)
        ? 100 : criteria_disc_value;

    return {
        promo_name: VoucherTypeName,
        promo_desc: VoucherTypeName,
        by_target_customer: 'A',
        by_item: isTotalDiscount
            ? (item_menu_category_dtls.length > 0 ? PROMO_BY.SELECTED_CATEGORIES : PROMO_BY.ALL_ITEMS)
            : by_item,
        apply_terminal: 2,
        apply_mobile: 1,
        apply_web: 1,
        receipt_terms_amount: parseFloat(rawVoucher?.MinSpendingValue || 0),
        promo_st_date: voucher.ValidFrom,
        promo_ed_date: voucher.ValidTo,
        priority_seq: 2,
        criteria_type,
        criteria_disc_type,
        criteria_disc_value: finalDiscValue,
        criteria_payment_name,
        si_item_codes,
        service_type: [
            { service_type: 'D' }, { service_type: 'E' },
            { service_type: 'Q' }, { service_type: 'T' },
        ],
        exclude_customer_group: '',
        time_slot_dtls: [],
        item_menu_category_dtls,
        item_dtls,
        creteria_item_dtls: '',
        by_prefix: (by_item === PROMO_BY.PREFIX || by_item === PROMO_BY.PREFIX_CHILD)
            ? (item_dtls[0]?.prefix || '').toUpperCase() : '',
        by_prefixes: (by_item === PROMO_BY.PREFIX || by_item === PROMO_BY.PREFIX_CHILD)
            ? item_dtls.map(d => d.prefix).filter(Boolean) : [],
    };
};

// ============================================
// VOUCHER STATE MANAGEMENT
// ============================================
const voucherState = {
    appliedVouchers: [],
    selectedVoucher: null,
    availableVouchers: [],
    loadingVoucher: null,
    previousOrderBeforeVouchers: null,

    isApplied(voucherCode) {
        return this.appliedVouchers.some(v => v?.code === voucherCode || v?.raw?.redeem_code === voucherCode);
    },
    setSelected(voucher) { this.selectedVoucher = voucher; console.log('✅ Voucher selected:', voucher?.code); },
    add(voucher) {
        const code = voucher?.code || voucher?.raw?.redeem_code;
        if (!this.isApplied(code)) { this.appliedVouchers.push(voucher); this.selectedVoucher = voucher; console.log('✅ Voucher added:', code); }
    },
    remove(voucherCode) {
        this.appliedVouchers = this.appliedVouchers.filter(v => (v?.code || v?.raw?.redeem_code) !== voucherCode);
        if (this.selectedVoucher?.code === voucherCode) this.selectedVoucher = null;
        console.log('🗑️ Voucher removed:', voucherCode);
    },
    clear() { this.appliedVouchers = []; this.selectedVoucher = null; this.loadingVoucher = null; this.previousOrderBeforeVouchers = null; console.log('🗑️ All vouchers cleared'); },
    getApplied() { return this.appliedVouchers; },
    setLoading(v) { this.loadingVoucher = v; },
    clearLoading() { this.loadingVoucher = null; },
    savePreviousOrder(order) {
        if (!this.previousOrderBeforeVouchers) { this.previousOrderBeforeVouchers = JSON.parse(JSON.stringify(order)); console.log('💾 Saved order state before vouchers'); }
    },
    getPreviousOrder() { return this.previousOrderBeforeVouchers; },
    clearPreviousOrder() { this.previousOrderBeforeVouchers = null; },
};

let _voucherCache = null;
let _voucherCacheTime = 0;
const VOUCHER_CACHE_TTL_MS = 30000;
let _updateVoucherUITimer = null;

export function invalidateVoucherCache() {
    _voucherCache = null;
    _voucherCacheTime = 0;
    console.log('🗑️ Voucher cache invalidated');
}

function sendVoucherWS(payload) {
    const ws = window.sokWebSocket?.ws;
    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ...payload, deviceId: localStorage.getItem("sok_device_id"), timestamp: new Date().toISOString() }));
    } else {
        console.warn('⚠️ WebSocket not open, voucher event not sent:', payload.action);
    }
}

// ============================================
// GET VOUCHER INFO
// ============================================
export function getVoucherInfo(crmVendor, voucher) {
    const cache = useCache();
    let promos = cache?.promos;

    if (!voucher) { console.warn('⚠️ No voucher provided to getVoucherInfo'); return null; }

    if (voucher?.redeem_type === 'REWARD' || voucher?.code?.startsWith('rewardid-') || voucher?.redeem_code?.startsWith('rewardid-')) {
        return { raw: voucher, code: voucher.redeem_code || voucher.code, name: voucher.redeem_name || voucher.name, type: 'REWARD', promotion: null, promo_name: voucher.redeem_name || voucher.name, limit: 0, is_reward: true };
    }

    const voucherInfo = { raw: voucher, promo_name: '', limit: 0, type: null, promotion: null, code: voucher.redeem_code || voucher.code, name: voucher.redeem_name || voucher.name };

    if (crmVendor === 'Ascentis') {
        const raw = voucher?._ascentis_raw || voucher?.raw?._ascentis_raw || voucher;
        const voucherType = (raw?.Type || '').toUpperCase();
        const typeValue = parseFloat(raw?.TypeValue || 0);
        const balanceAmt = parseFloat(raw?.BalanceAmt || 0);
        const redeemValue = parseFloat(raw?.VoucherRedemptionValue ?? 0);

        voucherInfo.code = raw?.VoucherNo || voucherInfo.code;
        voucherInfo.name = (raw?.VoucherTypeDescription?.trim()) || raw?.VoucherTypeName || voucherInfo.name || 'Voucher';

        console.log('📦 Ascentis getVoucherInfo:', { code: voucherInfo.code, type: voucherType, typeValue, balanceAmt, Ref7: raw?.Ref7 });

        // ── DDISCOUNT ────────────────────────────────────────────────────────
        if (voucherType === 'DDISCOUNT') {
            let discountAmt = balanceAmt > 0 ? balanceAmt : typeValue;
            if (discountAmt === 0) {
                const ref7Val = (raw?.Ref7 || '').includes('|-|') ? raw.Ref7.split('|-|')[1]?.trim() : '';
                const ref7Num = parseFloat(ref7Val);
                if (ref7Num > 0) { discountAmt = ref7Num; console.log('✅ DDISCOUNT amount from Ref7:', discountAmt); }
            }
            const builtPromo = buildPromotionObjectFromAscentisConfig(raw);
            if (builtPromo && builtPromo.item_menu_category_dtls?.length > 0) {
                voucherInfo.type = 'BILL';
                voucherInfo.promo_name = voucherInfo.name;
                voucherInfo.promotion = { ...builtPromo, criteria_type: PROMO_TYPE.TOTAL_DISCOUNT, criteria_disc_type: 'V', criteria_disc_value: discountAmt, apply_terminal: 2 };
                console.log('✅ DDISCOUNT → BILL (V) with category restriction:', discountAmt);
                return voucherInfo;
            }
            voucherInfo.type = 'BILL';
            voucherInfo.promo_name = voucherInfo.name;
            voucherInfo.promotion = { promo_name: voucherInfo.name, criteria_type: PROMO_TYPE.TOTAL_DISCOUNT, criteria_disc_type: 'V', criteria_disc_value: discountAmt, apply_terminal: 2, is_synthetic: true };
            console.log('✅ DDISCOUNT → BILL (V):', discountAmt);
            return voucherInfo;
        }

        // ── PDISCOUNT ────────────────────────────────────────────────────────
        if (voucherType === 'PDISCOUNT') {
            const pct = typeValue || balanceAmt;
            voucherInfo.type = 'BILL';
            voucherInfo.promo_name = voucherInfo.name;
            voucherInfo.promotion = { promo_name: voucherInfo.name, criteria_type: PROMO_TYPE.TOTAL_DISCOUNT, criteria_disc_type: 'P', criteria_disc_value: pct, apply_terminal: 2, is_synthetic: true };
            console.log('✅ PDISCOUNT → BILL (P):', pct, '%');
            return voucherInfo;
        }

        // ── IDDISCOUNT / IPDISCOUNT ──────────────────────────────────────────
        if (['IDDISCOUNT', 'IPDISCOUNT'].includes(voucherType)) {
            const ref7Val = (raw?.Ref7 || '').split('|-|')[1]?.trim() || '';
            const hasPrefixC = ref7Val.toUpperCase().includes('PREFIXC:');
            const isFreeUpsize = (raw?.VoucherTypeCode || '').toUpperCase().includes('FREEUPSIZE');

            if (hasPrefixC || isFreeUpsize) {
                voucherInfo.type = 'FREE_ITEM';
                voucherInfo.promotion = null;
                voucherInfo.is_points_redemption = false;
                voucherInfo.points_cost = 0;
                console.log('✅ FREEUPSIZE/PREFIXC → FREE_ITEM');
                return voucherInfo;
            }

            const promotion = buildPromotionObjectFromAscentisConfig(raw);
            if (promotion) {
                voucherInfo.type = 'ITEM';
                voucherInfo.promotion = promotion;
                console.log('✅', voucherType, '→ ITEM via builder');
                return voucherInfo;
            }

            const isPercent = voucherType === 'IPDISCOUNT';
            let discVal = isPercent ? (typeValue || balanceAmt) : (balanceAmt > 0 ? balanceAmt : typeValue);
            if (discVal === 0) {
                const ref7Pipe = (raw?.Ref7 || '').split('|-|')[1] || '';
                const ref7Num = parseFloat(ref7Pipe.split('|')[0]?.trim());
                if (ref7Num > 0) { discVal = ref7Num; console.log('✅ IDDISCOUNT: disc value from Ref7:', discVal); }
            }
            if (discVal === 0) {
                console.warn('⚠️ IDDISCOUNT: cannot resolve disc_value');
                showToast('This voucher applies only to qualifying items. Add qualifying items to use it.', 'warning', 'Voucher Not Applicable', 5000);
                return null;
            }
            voucherInfo.type = 'ITEM';
            voucherInfo.promotion = { promo_name: voucherInfo.name, criteria_type: PROMO_TYPE.ITEM_DISCOUNT, criteria_disc_type: isPercent ? 'P' : 'V', criteria_disc_value: discVal, by_item: PROMO_BY.ALL_ITEMS, apply_terminal: 2, is_synthetic: true };
            console.log('✅', voucherType, '→ ITEM synthetic:', discVal);
            return voucherInfo;
        }

        // ── FREEITEM ─────────────────────────────────────────────────────────
        if (voucherType === 'FREEITEM') {
            const promotion = buildPromotionObjectFromAscentisConfig(raw);
            if (promotion) {
                if (promotion.criteria_type === PROMO_TYPE.LOWEST_PRICE_DISCOUNT) {
                    voucherInfo.type = 'ITEM'; voucherInfo.promotion = promotion;
                    console.log('✅ FREEITEM (LD) → ITEM');
                    return voucherInfo;
                }
                if (promotion.criteria_type === PROMO_TYPE.ITEM_DISCOUNT) {
                    promotion.criteria_disc_type = 'P'; promotion.criteria_disc_value = 100;
                    voucherInfo.type = 'ITEM'; voucherInfo.promotion = promotion;
                    console.log('✅ FREEITEM (PREFIX/SCC) → ITEM 100%');
                    return voucherInfo;
                }
                voucherInfo.type = 'FREE_ITEM'; voucherInfo.promotion = promotion;
                console.log('✅ FREEITEM → FREE_ITEM (structured)');
                return voucherInfo;
            }
            voucherInfo.type = 'FREE_ITEM'; voucherInfo.is_points_redemption = false; voucherInfo.promotion = null;
            console.log('✅ FREEITEM (issued, no config)');
            return voucherInfo;
        }

        // ── Unknown type — try builder ────────────────────────────────────────
        const promotion = buildPromotionObjectFromAscentisConfig(raw);
        if (promotion) { voucherInfo.type = 'ITEM'; voucherInfo.promotion = promotion; console.log('✅ Unknown type', voucherType, '→ ITEM via builder'); return voucherInfo; }
        console.warn('⚠️ Could not resolve voucherInfo for:', voucherInfo.code, 'type:', voucherType);
        voucherInfo.type = 'FREE_ITEM';
        return voucherInfo;
    }

    // ── Non-Ascentis (EBER) path ─────────────────────────────────────────────
    if (voucher?.pos_redeem_extra) {
        const config = voucher.pos_redeem_extra.split(',');
        const [drPart, qtyPart] = config;
        if (drPart) voucherInfo.promo_name = drPart.split('=')[1] || '';
        if (qtyPart) voucherInfo.limit = parseInt(qtyPart.split('=')[1]) || 0;
    } else if (voucher.redeem_name || voucher.name) {
        voucherInfo.promo_name = voucher.redeem_name || voucher.name;
    }

    if (typeof promos === 'string') { try { promos = JSON.parse(promos); } catch { return createFallbackVoucherInfo(voucher, voucherInfo); } }
    if (!Array.isArray(promos) && typeof promos === 'object') promos = Object.values(promos);
    if (!Array.isArray(promos) || promos.length === 0) return createFallbackVoucherInfo(voucher, voucherInfo);

    const promotion = promos.find(p => p?.promo_name === voucherInfo.promo_name && p?.apply_terminal === 2);
    if (promotion) {
        voucherInfo.promotion = promotion;
        voucherInfo.type = promotion.criteria_type === PROMO_TYPE.TOTAL_DISCOUNT ? 'BILL' : 'ITEM';
    } else {
        return createFallbackVoucherInfo(voucher, voucherInfo);
    }
    return voucherInfo;
}

function createFallbackVoucherInfo(voucher, voucherInfo) {
    const posRedeemMethod = voucher?.pos_redeem_method;
    const posRedeemAmount = voucher?.pos_redeem_amount;
    const posRedeemPercentage = voucher?.pos_redeem_percentage;

    if (posRedeemMethod || posRedeemAmount || posRedeemPercentage) {
        const syntheticPromotion = { promo_name: voucherInfo.name || 'Direct Discount', criteria_type: 'TOTAL_DISCOUNT', criteria_disc_type: 'V', criteria_disc_value: parseFloat(posRedeemAmount || 0), apply_terminal: 2, is_synthetic: true };
        if (posRedeemPercentage && parseFloat(posRedeemPercentage) > 0) { syntheticPromotion.criteria_disc_type = 'P'; syntheticPromotion.criteria_disc_value = parseFloat(posRedeemPercentage); }
        voucherInfo.promotion = syntheticPromotion;
        voucherInfo.type = 'BILL';
        voucherInfo.promo_name = syntheticPromotion.promo_name;
        return voucherInfo;
    }
    console.error('❌ Cannot create voucher info: no promotion mapping and no direct discount data');
    return voucherInfo;
}

// ============================================
// APPLY BILL VOUCHER
// ============================================
async function applyBillVoucher(order, voucherInfo) {
    console.log('💳 Applying bill voucher:', voucherInfo.code);
    const promotion = voucherInfo.promotion;
    if (!promotion) { console.error('❌ No promotion found for bill voucher'); return { success: false, error: 'Invalid voucher configuration' }; }

    const salesDtls = order.sales_dtls;
    const pricedChildren = salesDtls.filter(item => String(item.s_no) !== String(item.parent_sno) && parseFloat(item.sub_total || 0) > 0);
    const subtotal = pricedChildren.reduce((sum, item) => sum + parseFloat(item.sub_total || 0), 0);
    console.log('💰 Bill voucher subtotal:', subtotal);
    if (subtotal <= 0) return { success: false, error: 'No priced items found' };

    let discountAmount = 0;
    if (promotion.criteria_disc_type === 'V') {
        discountAmount = Math.min(parseFloat(promotion.criteria_disc_value || 0), subtotal);
    } else if (promotion.criteria_disc_type === 'P') {
        discountAmount = Math.round(subtotal * parseFloat(promotion.criteria_disc_value || 0) / 100 * 100) / 100;
    }
    console.log('💰 Discount amount:', discountAmount);

    let totalDiscApplied = 0;
    const discountedItems = salesDtls.map(item => {
        const itemSubtotal = parseFloat(item.sub_total || 0);
        const isEligibleChild = pricedChildren.some(c => String(c.s_no) === String(item.s_no));
        if (!isEligibleChild || itemSubtotal <= 0) return item;

        const isLast = String(item.s_no) === String(pricedChildren[pricedChildren.length - 1].s_no);
        let itemDiscount;
        if (isLast) {
            itemDiscount = Math.round((discountAmount - totalDiscApplied) * 100) / 100;
        } else {
            const proportion = itemSubtotal / subtotal;
            itemDiscount = Math.round(discountAmount * proportion * 100) / 100;
            totalDiscApplied += itemDiscount;
        }
        return { ...item, disc_type: promotion.criteria_disc_type, disc_name: voucherInfo.name, disc_value: parseFloat(promotion.criteria_disc_value || 0), disc_amt: itemDiscount.toFixed(2), pro_disc_amt: itemDiscount.toFixed(2) };
    });

    const updatedOrder = calcOrderAmt({ ...order, sales_dtls: discountedItems, voucher_code: voucherInfo.code, voucher_name: voucherInfo.name, voucher_type: 'BILL', voucher_meta: { is_points_redemption: voucherInfo.is_points_redemption ?? false, points_cost: voucherInfo.points_cost ?? 0 } });
    console.log('💰 Bill voucher calcOrderAmt:', { sub: updatedOrder.sub_total, disc: updatedOrder.total_disc, net: updatedOrder.net_amt });
    return { success: true, order: updatedOrder, discount: parseFloat(updatedOrder.total_disc || 0) };
}

// ============================================
// APPLY ITEM VOUCHER
// ============================================
async function applyItemVoucher(order, voucherInfo) {
    console.log('💳 Applying item voucher:', voucherInfo.code);
    const promotion = voucherInfo.promotion;
    if (!promotion) { console.error('❌ No promotion found for item voucher'); return { success: false, error: 'Invalid voucher configuration' }; }
    if (!order.sales_dtls?.length) return { success: false, error: 'Invalid order structure' };

    const allPrefixes = (promotion.by_prefixes?.length > 0 ? promotion.by_prefixes : promotion.by_prefix ? [promotion.by_prefix] : []).map(p => p.toUpperCase());
    const PREFIXC_BY_ITEMS = [PROMO_BY.PREFIX, PROMO_BY.PREFIX_CHILD, 'PREFIXC'];
    const isPrefixVoucher = PREFIXC_BY_ITEMS.includes(promotion.by_item) && allPrefixes.length > 0;
    const sizeMap = { M: 'Medium', L: 'Large', H: 'Hot', S: 'Small' };
    const sizeLabel = allPrefixes.map(p => sizeMap[p] || p).join(' / ');
    const itemMatchesPrefix = (item) => allPrefixes.some(p => (item.item_name || '').toUpperCase().startsWith(p + '-'));

    // ── SI pre-check ──────────────────────────────────────────────────────────
    if (promotion.si_item_codes?.length) {
        const siCodes = promotion.si_item_codes.map(c => c.toUpperCase());
        const fullItems = useCache().items || [];
        const hasMatchingItem = order.sales_dtls.some(item => {
            if (parseFloat(item.sub_total || 0) <= 0) return false;
            const itemName = (item.item_name || item.item_desc || '').toUpperCase();
            const itemNo = (item.item_no || '').toUpperCase();
            const fullItem = fullItems.find(m => m.item_no === item.item_no);
            const skuNo = (fullItem?.sku_no || '').toUpperCase();
            return siCodes.some(code => {
                const c = code.toUpperCase();
                if (itemName.startsWith(c)) return true;
                if (itemName.includes(c)) return true;
                if (itemNo.includes(c)) return true;
                if (skuNo === c) return true;
                const sizeMatch = c.match(/^([MLH])-([A-Z0-9]+(?:-[A-Z0-9]+)*)$/);
                if (sizeMatch) { const transformed = `${sizeMatch[2]}${sizeMatch[1]}`; if (skuNo === transformed) return true; }
                return false;
            });
        });
        if (!hasMatchingItem) return { success: false, error: `This voucher only applies to specific items (${siCodes.join(', ')}). Please add a qualifying item first.` };
    }

    // ── PREFIX pre-check ──────────────────────────────────────────────────────
    if (isPrefixVoucher) {
        const pricedItems = order.sales_dtls.filter(i => parseFloat(i.sub_total || 0) > 0);
        if (!pricedItems.some(itemMatchesPrefix)) {
            console.warn(`⚠️ PREFIX(C) mismatch — voucher requires ${sizeLabel} drink`);
            return { success: false, error: `This voucher is for a free ${sizeLabel} drink. Please add a ${sizeLabel} drink to your order first.` };
        }
        console.log(`✅ PREFIX(C) pre-check passed`);
    }

    try {
        const result = await applyPromotionsWithMapping(order.sales_dtls, [promotion], voucherInfo.limit, { items: [], serviceType: order.service_type, setLastSNo: () => { } });

        console.log('📊 applyPromotions result:', { applied: result?.applied, amount: result?.amount });
        if (!result?.orderItems) return { success: false, error: 'Promotion calculation failed' };
        if (result.shouldRemove) { console.log('⚠️ applyItemVoucher: shouldRemove'); return { success: false, shouldRemove: true }; }

        const alreadyDiscounted = result.orderItems.some(i => parseFloat(i.pro_disc_amt || 0) > 0);

        // ── Manual fallback ───────────────────────────────────────────────────
        if ((result.applied === 0 || result.amount === 0) && !result.noEligibleItems && !alreadyDiscounted) {
            console.log('🔧 Fallback: applying discount manually');

            const categories = (promotion.item_menu_category_dtls || []).map(c => (c.category_code || '').toUpperCase());

            // ✅ isAllItems only when explicitly ALL_ITEMS with no category filter
            const isAllItems = promotion.by_item === PROMO_BY.ALL_ITEMS && categories.length === 0;
            const discType = promotion.criteria_disc_type;
            const discValue = parseFloat(promotion.criteria_disc_value || 0);
            const fullItems = useCache().items || [];
            let totalDiscount = 0;
            let remainingDiscount = discType === 'V' ? discValue : Infinity;

            // ✅ maxQty: follow pos.ts — limit = 1 for all IDDISCOUNT/IPDISCOUNT/FREEITEM
            // Only exception: SCC with explicit qty in Ref7 (e.g. "1.5|SCC:EXTRA OPTIONS|1")
            const maxQty = (() => {
                const ref7Raw = voucherInfo?.raw?.Ref7 || voucherInfo?.raw?.raw?.Ref7 || '';
                const parsedRef7 = parseRef7(ref7Raw);

                // SCC with explicit maxQty cap (e.g. MCFREETOPPINGS: "1.5|SCC:EXTRA OPTIONS|1")
                if (parsedRef7?.pattern === 'SCC' && parsedRef7?.maxQty != null) {
                    console.log('✅ maxQty from SCC explicit:', parsedRef7.maxQty);
                    return parsedRef7.maxQty;
                }

                // All item-level vouchers: 1 per voucher (matches pos.ts getVoucherInfo limit = 1)
                console.log('✅ maxQty = 1 (pos.ts default for item vouchers)');
                return 1;
            })();

            console.log('🔧 Fallback config:', {
                maxQty,
                discType,
                discValue,
                isPrefixVoucher,
                prefixes: allPrefixes.join(',') || 'none',
                isAllItems,
            });

            const eligibleItems = [];
            result.orderItems.forEach((item, idx) => {
                const subtotalVal = parseFloat(item.sub_total || 0);
                if (subtotalVal <= 0) return;

                if (isPrefixVoucher) {
                    if (!itemMatchesPrefix(item)) return;
                } else if (promotion.by_item === PROMO_BY.SELECTED_ITEMS || promotion.si_item_codes?.length) {
                    const siCodes = promotion.si_item_codes || [];
                    if (!siCodes.length) return;
                    const itemName = (item.item_name || item.item_desc || '').toUpperCase();
                    const itemNo = (item.item_no || '').toUpperCase();
                    const fullItem = fullItems.find(m => m.item_no === item.item_no);
                    const skuNo = (fullItem?.sku_no || '').toUpperCase();
                    const matches = siCodes.some(code => {
                        const c = code.toUpperCase();
                        if (itemName.startsWith(c)) return true;
                        if (itemName.includes(c)) return true;
                        if (itemNo.includes(c)) return true;
                        if (skuNo === c) return true;
                        const sizeMatch = c.match(/^([MLH])-([A-Z0-9]+(?:-[A-Z0-9]+)*)$/);
                        if (sizeMatch) { const transformed = `${sizeMatch[2]}${sizeMatch[1]}`; if (skuNo === transformed) return true; }
                        return false;
                    });
                    if (!matches) return;
                } else {
                    // Skip parent placeholder rows that have priced children
                    const hasChildRows = result.orderItems.some(c =>
                        String(c.parent_sno) === String(item.s_no) &&
                        String(c.s_no) !== String(item.s_no) &&
                        parseFloat(c.sub_total || 0) > 0
                    );
                    if (hasChildRows) return;

                    if (!isAllItems) {
                        const itemCat = (item.category_code || '').toUpperCase();
                        if (!categories.includes(itemCat)) return;
                    }
                }

                const unitPrice = parseFloat(item.unit_price || 0) || subtotalVal;
                eligibleItems.push({ idx, item, unitPrice, subtotalVal });
            });

            // Sort cheapest first (matches pos.ts lowest price logic)
            eligibleItems.sort((a, b) => a.unitPrice - b.unitPrice);
            const toDiscount = eligibleItems.slice(0, maxQty);

            console.log('🔧 Fallback eligible (sorted cheap→exp):',
                eligibleItems.map(e => ({ name: e.item.item_name, ds_no: e.item.ds_no, price: e.unitPrice }))
            );
            console.log('🔧 Fallback discounting:', toDiscount.length, 'of', eligibleItems.length, 'items');

            toDiscount.forEach(({ idx, item, subtotalVal }) => {
                if (remainingDiscount <= 0) return;

                let itemDiscount = 0;
                if (discType === 'P') {
                    if (discValue === 100) {
                        const unitPrice = parseFloat(item.unit_price || 0);
                        itemDiscount = unitPrice > 0 ? unitPrice : subtotalVal / (parseInt(item.qty) || 1);
                    } else {
                        const unitPrice = parseFloat(item.unit_price || 0) ||
                            subtotalVal / Math.max(parseInt(item.qty || 1), 1);
                        itemDiscount = unitPrice * discValue / 100;
                    }
                } else if (discType === 'V') {
                    const unitPrice = parseFloat(item.unit_price || 0) ||
                        subtotalVal / Math.max(parseInt(item.qty || 1), 1);
                    itemDiscount = Math.min(discValue, unitPrice);
                }
                if (itemDiscount <= 0) return;

                totalDiscount += itemDiscount;

                // ✅ Apply pro_disc_amt to this row ONLY — no bubbling to parent
                // calcOrderAmt sums ALL pro_disc_amt across every row.
                // Setting it on both parent + child = double count → wrong total_disc.
                // The server always applies discount on the child row (ds_no >= 2) directly.
                result.orderItems[idx] = {
                    ...item,
                    disc_type: discType,
                    disc_name: promotion.promo_name,
                    disc_value: discValue,
                    pro_disc_amt: itemDiscount.toFixed(2),
                    disc_amt: itemDiscount.toFixed(2),
                };

                console.log(`✅ Fallback: $${itemDiscount.toFixed(2)} on ds_no:${item.ds_no} s_no:${item.s_no} "${item.item_name}"`);
                // ❌ NO bubble to parent — pos.ts calcOrderAmt sums all rows, bubble = double count
            });

            result.applied = result.orderItems.filter(i => parseFloat(i.pro_disc_amt || 0) > 0).length;
            result.amount = totalDiscount;
            console.log('✅ Fallback result:', {
                type: discType, value: discValue,
                maxQty,
                total: totalDiscount.toFixed(2),
                items: result.applied,
            });

            if (result.applied === 0 || totalDiscount === 0) {
                const categoryNames = (promotion.item_menu_category_dtls || []).map(c => c.category_code).join(', ') || 'qualifying items';
                console.warn('⚠️ Fallback produced $0 discount — rejecting apply');
                return { success: false, error: `This voucher applies only to ${categoryNames}. Add qualifying items to use it.` };
            }

            // Cap to BalanceAmt if set
            const balanceAmt = parseFloat(voucherInfo.raw?.BalanceAmt || voucherInfo.raw?.raw?.BalanceAmt || 0);
            if (balanceAmt > 0 && result.amount > balanceAmt) {
                console.log(`💰 Discount capped: $${result.amount.toFixed(2)} → $${balanceAmt.toFixed(2)} (BalanceAmt)`);
                result.amount = balanceAmt;
                let remaining = balanceAmt;
                result.orderItems = result.orderItems.map(item => {
                    const pd = parseFloat(item.pro_disc_amt || 0);
                    if (pd <= 0 || remaining <= 0) return item;
                    const capped = Math.min(pd, remaining);
                    remaining -= capped;
                    return capped < pd ? { ...item, pro_disc_amt: capped.toFixed(2), disc_amt: capped.toFixed(2) } : item;
                });
            }
        }

        if (!result?.orderItems?.length) {
            console.error('❌ applyItemVoucher: no orderItems — aborting');
            return { success: false, error: 'Promotion calculation produced no items' };
        }

        const updatedOrder = calcOrderAmt({
            ...order,
            sales_dtls: result.orderItems,
            voucher_code: voucherInfo.code,
            voucher_name: voucherInfo.name,
            voucher_discount: '0.00',
            voucher_pending: result.applied === 0,
        });

        console.log('📊 After calcOrderAmt:', {
            sub: updatedOrder.sub_total,
            disc: updatedOrder.total_disc,
            svc: updatedOrder.total_svc,
            tax: updatedOrder.total_tax,
            net: updatedOrder.net_amt,
        });

        return {
            success: true,
            order: updatedOrder,
            discount: parseFloat(updatedOrder.total_disc || 0),
            pending: result.applied === 0,
        };

    } catch (error) {
        console.error('❌ Error in applyItemVoucher:', error);
        return { success: false, error: error.message };
    }
}

// ============================================
// APPLY VOUCHER (dispatcher)
// ============================================
// ✅ Tax patch helper — applied after voucher discount to zero/prorate tax on discounted lines
/**
 * After discounts, RESTORE line tax to its gross-price value.
 * Business rule (Han's): inclusive GST is shown on the original item price
 * and does not change when vouchers/bill discounts apply.
 * (calcOrderAmt may have zeroed/reduced tax_amt based on disc_amt — undo that.)
 */
function patchTaxAfterDiscount(order) {
    const shouldAbsorb = order.absorb_tax === 'Y';
    const defaultRate = parseFloat(sessionStorage.getItem('GST')) || 9;

    const patchedSalesDtls = (order.sales_dtls || []).map(i => {
        const subTotal = parseFloat(i.sub_total || 0);
        if (subTotal === 0) return i;                          // unpriced rows untouched

        const taxRate = parseFloat(i.tax_rate || i.tax_value || 0) || defaultRate;
        if (taxRate === 0) return { ...i, tax_amt: '0.000000' };  // genuinely exempt

        // ✅ GROSS-based tax — ignore disc_amt / pro_disc_amt entirely
        const taxAmt = shouldAbsorb
            ? subTotal * taxRate / (100 + taxRate)             // 5.80 × 9/109 = 0.4789
            : subTotal * taxRate / 100;

        return { ...i, tax_amt: taxAmt.toFixed(6) };
    });

    const totalTax = patchedSalesDtls.reduce((s, i) => s + parseFloat(i.tax_amt || 0), 0);

    // net_amt still reflects what the customer pays (discounts subtracted);
    // absorbed tax is informational inside that amount, not added on top
    const netAmt = Math.max(0,
        parseFloat(order.sub_total || 0)
        - parseFloat(order.total_disc || 0)
        + (shouldAbsorb ? 0 : totalTax)
        + parseFloat(order.total_svc || 0)
    );

    return {
        ...order, sales_dtls: patchedSalesDtls,
        total_tax: totalTax.toFixed(2), net_amt: netAmt.toFixed(2)
    };
}

async function applyVoucher(order, voucherInfo, voucher) {

    if (voucherInfo.type === 'FREE_ITEM') {
        const raw = voucherInfo.raw?.raw || voucherInfo.raw || {};
        const voucherTypeCode = (raw?.VoucherTypeCode || '').toUpperCase();
        const originalType = (raw?.Type || '').toUpperCase();
        const ref7Val = (raw?.Ref7 || '').split('|-|')[1]?.trim() || '';
        const isFreeUpsize = voucherTypeCode.includes('FREEUPSIZE');
        const prefixCMatch = ref7Val.toUpperCase().match(/PREFIXC:([A-Z])/);

        if (isFreeUpsize && prefixCMatch) {
            const targetPrefix = prefixCMatch[1];
            const fromPrefix = targetPrefix === 'L' ? 'M' : 'S';
            const { items } = useCache();
            const salesDtls = [...order.sales_dtls];
            const lChildIdx = salesDtls.findIndex(i => (i.item_name || '').toUpperCase().startsWith(targetPrefix + '-') && parseFloat(i.sub_total || 0) > 0);
            if (lChildIdx === -1) return { success: false, error: `No ${targetPrefix === 'L' ? 'Large' : targetPrefix} size drink found in cart.` };

            const lChild = salesDtls[lChildIdx];
            const lPrice = parseFloat(lChild.unit_price || lChild.sub_total || 0);
            const mEquivPrefix = lChild.item_name.toUpperCase().split(' ')[0].replace(new RegExp(`^${targetPrefix}-`), `${fromPrefix}-`);
            const mItem = items?.find(i => i.item_name.toUpperCase().startsWith(mEquivPrefix));
            let mPrice = 0;
            if (mItem) {
                mPrice = parseFloat(mItem.selling_uom_dtls?.[0]?.price_dtls?.[0]?.dine_in_price || mItem.selling_uom_dtls?.[0]?.price_dtls?.[0]?.quickservice_price || mItem.dine_in_price || 0);
                console.log(`🆙 FREEUPSIZE: ${targetPrefix} $${lPrice} | ${fromPrefix} equiv $${mPrice} | disc: $${(lPrice - mPrice).toFixed(2)}`);
            } else {
                console.warn(`⚠️ FREEUPSIZE: ${fromPrefix} equivalent not found`);
            }

            const upsizeDisc = Math.max(0, lPrice - mPrice);
            if (upsizeDisc > 0) {
                salesDtls[lChildIdx] = { ...lChild, disc_name: voucherInfo.name, disc_type: 'V', disc_amt: upsizeDisc.toFixed(2), disc_value: upsizeDisc, pro_disc_amt: upsizeDisc.toFixed(2) };
            }
            const updatedOrder = patchTaxAfterDiscount(calcOrderAmt({ ...order, sales_dtls: salesDtls, voucher_code: voucherInfo.code, voucher_name: voucherInfo.name, voucher_type: 'FREE_ITEM', voucher_discount: upsizeDisc.toFixed(2), voucher_meta: { is_points_redemption: voucherInfo.is_points_redemption ?? false, points_cost: voucherInfo.points_cost ?? 0, raw_type_code: raw?.VoucherTypeCode || '' } }));
            console.log(`✅ FREEUPSIZE applied: $${upsizeDisc.toFixed(2)}`);
            return { success: true, voucher: voucherInfo, discount: upsizeDisc, order: updatedOrder };
        }

        if (!isFreeUpsize && prefixCMatch && originalType === 'FREEITEM') {
            const targetPrefix = prefixCMatch[1];
            const salesDtls = [...order.sales_dtls];
            const freeChildIdx = salesDtls.findIndex(i => (i.item_name || '').toUpperCase().startsWith(targetPrefix + '-') && parseFloat(i.sub_total || 0) > 0);
            if (freeChildIdx !== -1) {
                const freeChild = salesDtls[freeChildIdx];
                const freeAmt = parseFloat(freeChild.sub_total || 0);
                console.log(`🎁 FREE ${targetPrefix} size: ${freeChild.item_name} = $${freeAmt} → FREE`);
                salesDtls[freeChildIdx] = { ...freeChild, disc_type: 'P', disc_name: voucherInfo.name, disc_value: 100, disc_amt: freeAmt.toFixed(2), pro_disc_amt: freeAmt.toFixed(2) };
            }
            const updatedOrder = patchTaxAfterDiscount(calcOrderAmt({ ...order, sales_dtls: salesDtls, voucher_code: voucherInfo.code, voucher_name: voucherInfo.name, voucher_type: 'FREE_ITEM', voucher_discount: '0.00', voucher_meta: { is_points_redemption: voucherInfo.is_points_redemption ?? false, points_cost: voucherInfo.points_cost ?? 0, raw_type_code: raw?.VoucherTypeCode || '' } }));
            return { success: true, voucher: voucherInfo, discount: 0, order: updatedOrder };
        }

        console.log('🎁 FREE_ITEM — recording on order, no discount');
        const updatedOrder = { ...order, voucher_code: voucherInfo.code, voucher_name: voucherInfo.name, voucher_type: 'FREE_ITEM', voucher_discount: '0.00', voucher_meta: { is_points_redemption: voucherInfo.is_points_redemption ?? false, points_cost: voucherInfo.points_cost ?? 0, raw_type_code: voucher?.raw?.VoucherTypeCode || voucher?.raw?.pos_redeem_method || '' } };
        return { success: true, voucher: voucherInfo, discount: 0, order: updatedOrder };
    }

    if (voucherInfo.type === 'BILL') {
        console.log('💳 BILL — delegating to applyBillVoucher');
        const result = await applyBillVoucher(order, voucherInfo);
        if (!result.success) return result;
        result.order = patchTaxAfterDiscount(result.order);
        return { success: true, voucher: voucherInfo, discount: result.discount, order: result.order };
    }

    if (voucherInfo.type === 'ITEM') {
        console.log('💳 ITEM — delegating to applyItemVoucher');
        const result = await applyItemVoucher(order, voucherInfo);
        if (!result.success && result.shouldRemove) return { success: false, shouldRemove: true };
        if (!result.success) return result;
        result.order = patchTaxAfterDiscount(result.order);
        return { success: true, voucher: voucherInfo, discount: result.discount, order: result.order };
    }

    return { success: false, error: 'Unsupported voucher type: ' + voucherInfo.type };
}

// ============================================
// APPLY VOUCHER AND RECALCULATE
// ============================================
export async function applyVoucherAndRecalculate(voucher) {
    window._voucherApplying = true;
    try {
        const code = voucher?.code || voucher?.VoucherNo || voucher?.redeem_code;
        const name = voucher?.name || voucher?.VoucherTypeName || voucher?.redeem_name || 'Voucher';
        console.log('💳 Applying voucher:', code);
        if (!code) return { success: false, error: 'Voucher missing code' };

        const { order, setOrder } = useOrder();
        if (!order?.sales_dtls?.length) { console.warn('⚠️ Cannot apply voucher to empty cart'); return { success: false, error: 'Cart is empty' }; }

        const vendor = getCRMVendor();
        const rawForInfo = vendor === 'Ascentis' ? (voucher?.raw || voucher?._ascentis_raw || voucher) : voucher;
        const voucherInfo = getVoucherInfo(vendor, rawForInfo);
        if (!voucherInfo) { showVoucherError('Invalid voucher configuration'); return { success: false, error: 'Invalid voucher configuration' }; }

        voucherInfo.code = voucherInfo.code || code;
        voucherInfo.name = voucherInfo.name || name;

        console.log('🔍 voucherInfo resolved:', { code: voucherInfo.code, type: voucherInfo.type, promotion: voucherInfo.promotion?.promo_name, criteria_type: voucherInfo.promotion?.criteria_type });

        if (!voucherInfo.promotion) {
            if (voucherInfo.type === 'FREE_ITEM') {
                const ref7Val = (rawForInfo?.Ref7 || '').split('|-|')[1]?.trim() || '';
                if (!ref7Val || ref7Val === ' ') { console.warn('⚠️ FREE_ITEM no Ref7 config — staff redemption only'); showToast('Please present this voucher to our staff for redemption.', 'warning', 'Staff Redemption Only', 5000); return { success: false, error: 'Staff redemption only' }; }
            } else if (voucherInfo.type === 'ITEM' || voucherInfo.type === 'BILL') {
                console.warn('⚠️ ITEM/BILL voucher has no promotion'); showToast('This voucher cannot be applied. Please contact staff for assistance.', 'warning', 'Voucher Not Applicable', 5000); return { success: false, error: 'No promotion configuration found' };
            }
        }

        const eligibility = validateVoucherCartEligibility(order, voucherInfo);
        if (!eligibility.eligible) { console.warn('🚫 Cart eligibility failed:', eligibility.error); showToast(eligibility.error || 'This voucher cannot be applied to your current order.', 'warning', 'Voucher Not Applicable', 5000); return { success: false, error: eligibility.error }; }

        const appliedCrmVouchers = JSON.parse(localStorage.getItem('appliedCrmVouchers') || '[]');
        if (!appliedCrmVouchers.some(v => (v.redeem_code || v.code) === code)) { appliedCrmVouchers.push({ redeem_code: code }); localStorage.setItem('appliedCrmVouchers', JSON.stringify(appliedCrmVouchers)); }

        if (vendor === 'Eber' && voucherInfo.type === 'REWARD') {
            console.log('🎁 [EBER] Reward voucher — redeeming with server');
            const redeemResult = await redeemEberVoucher({ info: { eberpayload: { redeem_code: code, verify_only: 0 } } });
            if (!redeemResult?.success) { showVoucherError('Failed to redeem voucher'); return { success: false, error: 'Voucher redemption failed' }; }
            const voucherAmount = parseFloat(voucher.pos_redeem_amount || voucher.posRedeemAmount || 0);
            if (!voucherAmount || voucherAmount <= 0) { setOrder({ ...order, voucher_code: voucherInfo.code, voucher_name: voucherInfo.name }); return { success: true, voucher: voucherInfo, discount: 0, order }; }
            voucherInfo.type = 'BILL';
            voucherInfo.promotion = voucherInfo.promotion || { promo_name: voucherInfo.name, criteria_type: 'TOTAL_DISCOUNT', criteria_disc_type: 'V', criteria_disc_value: voucherAmount, is_synthetic: true };
        }

        const result = await applyVoucher(order, voucherInfo, voucher);
        console.log('💳 result.order before setOrder:', { net_amt: result.order?.net_amt, total_disc: result.order?.total_disc, sub_total: result.order?.sub_total });

        if (!result.success) { if (!result.shouldRemove) showVoucherError(result.error || 'Unsupported voucher type'); return result; }

        setOrder(result.order);
        safeCall('renderCartFromOrder');
        safeCall('updateCartCount');
        updateVoucherApplyButton();
        return result;

    } finally {
        window._voucherApplying = false;
    }
}

// ============================================
// REMOVE VOUCHER AND RECALCULATE
// ============================================
export async function removeVoucherAndRecalculate(voucherCode) {
    console.log('🗑️ Removing voucher:', voucherCode);

    const { order, setOrder } = useOrder();

    if (!voucherCode) {
        voucherCode = order?.voucher_code;
        console.log('⚠️ No voucher code provided, using from order:', voucherCode);
    }
    if (!voucherCode) {
        showVoucherError('No voucher to remove');
        return { success: false, error: 'No voucher specified' };
    }

    const appliedVouchers = voucherState.getApplied();
    const voucherToRemove = appliedVouchers.find(v => v.code === voucherCode || v.raw?.redeem_code === voucherCode);
    voucherState.setLoading(voucherToRemove || { code: voucherCode });

    try {
        voucherState.remove(voucherCode);

        // ✅ Clear discount fields and recompute tax from sub_total using order-level absorb flag
        // Bypasses addTax/isAbsorbTax hooks which can misread item-level is_absorbtax
        const shouldAbsorb = order.absorb_tax === 'Y';

        const clearedItems = order.sales_dtls.map(item => {
            const subTotal = parseFloat(item.sub_total || 0);
            const taxRate = parseFloat(item.tax_rate || item.tax_value || 0);
            const taxAmt = (taxRate > 0 && subTotal > 0)
                ? shouldAbsorb
                    ? subTotal * taxRate / (100 + taxRate)
                    : subTotal * taxRate / 100
                : 0;

            return {
                ...item,
                pro_disc_amt: '0.00',
                disc_amt: '0.00',
                disc_type: 'N',
                disc_name: 'None',
                disc_value: 0,
                tax_amt: taxAmt.toFixed(6),
            };
        });

        const updatedOrder = calcOrderAmt({
            ...order,
            sales_dtls: clearedItems,
            voucher_code: undefined,
            voucher_name: undefined,
            voucher_discount: undefined,
            voucher_type: undefined,
            voucher_meta: undefined,
            total_disc: '0.00',
            absorb_tax_info: shouldAbsorb ? 'Absorb Tax' : 'Not Absorb Tax',
        });

        console.log('📊 After voucher removal:', {
            sub: updatedOrder.sub_total,
            disc: updatedOrder.total_disc,
            svc: updatedOrder.total_svc,
            tax: updatedOrder.total_tax,
            net: updatedOrder.net_amt,
        });

        setOrder(updatedOrder);

        window._voucherRemovedAt = Date.now();
        window._voucherRemovedCode = voucherCode;

        if (typeof updateOrderCacheOnServer === 'function') {
            try {
                await updateOrderCacheOnServer();
                console.log('✅ Clean order synced to server');
            } catch (e) {
                console.warn('⚠️ Server sync after voucher removal failed:', e);
            }
        }

        try {
            const applied = JSON.parse(localStorage.getItem('appliedCrmVouchers') || '[]');
            localStorage.setItem('appliedCrmVouchers', JSON.stringify(
                applied.filter(v => (v.redeem_code || v.code || v.VoucherNo) !== voucherCode)
            ));
        } catch (e) {
            console.warn('⚠️ Failed to clear appliedCrmVouchers:', e);
        }

        safeCall('renderCartFromOrder');
        safeCall('updateCartCount');
        showVoucherRemovedMessage();
        voucherState.clearLoading();
        voucherState.clearPreviousOrder();
        return { success: true };

    } catch (error) {
        console.error('❌ Error removing voucher:', error);
        voucherState.clearLoading();
        showVoucherError('Failed to remove voucher. Please try again.');
        return { success: false, error: error.message };
    }
}

// ============================================
// CART ELIGIBILITY VALIDATION
// ============================================
function validateVoucherCartEligibility(order, voucherInfo) {
    const promotion = voucherInfo.promotion;

    if (voucherInfo.type === 'FREE_ITEM') {
        const raw = voucherInfo.raw?.raw || voucherInfo.raw || {};
        const voucherTypeCode = (raw?.VoucherTypeCode || '').toUpperCase();
        const ref7Val = (raw?.Ref7 || '').split('|-|')[1]?.trim() || '';
        const isFreeUpsize = voucherTypeCode.includes('FREEUPSIZE');
        const prefixCMatch = ref7Val.toUpperCase().match(/PREFIXC:([A-Z,]+)/);

        if (prefixCMatch) {
            const allPrefixes = prefixCMatch[1].split(',').map(p => p.trim().toUpperCase()).filter(Boolean);
            const sizeMap = { M: 'Medium', L: 'Large', H: 'Hot', S: 'Small' };
            const sizeLabel = allPrefixes.map(p => sizeMap[p] || p).join(' / ');
            const pricedItems = order.sales_dtls.filter(i => parseFloat(i.sub_total || 0) > 0);
            const targetPrefix = isFreeUpsize ? allPrefixes[0] : null;

            if (isFreeUpsize) {
                const hasTargetSize = pricedItems.some(i => (i.item_name || '').toUpperCase().startsWith(targetPrefix + '-'));
                if (!hasTargetSize) return { eligible: false, error: `This free upsize voucher requires a ${sizeMap[targetPrefix] || targetPrefix} drink in your cart.` };
            } else {
                const hasSizeItem = pricedItems.some(item => allPrefixes.some(p => (item.item_name || '').toUpperCase().startsWith(p + '-')));
                if (!hasSizeItem) return { eligible: false, error: `This voucher is for a free ${sizeLabel} drink. Please add a ${sizeLabel} drink to your order first.` };
            }
        }
        return { eligible: true };
    }

    if (!promotion || !order.sales_dtls?.length) return { eligible: true };
    const pricedItems = order.sales_dtls.filter(i => parseFloat(i.sub_total || 0) > 0);
    if (!pricedItems.length) return { eligible: false, error: 'No items in cart to apply this voucher to.' };

    const categories = promotion.item_menu_category_dtls || [];
    if (categories.length > 0) {
        const hasMatchingItem = pricedItems.some(item => checkItemEligibility(item, promotion));
        if (!hasMatchingItem) { const catLabel = categories.map(c => c.category_code).filter(Boolean).join(', '); return { eligible: false, error: `This voucher is only valid for: ${catLabel}. Please add a qualifying item to your order.` }; }
    }

    const siCodes = promotion.si_item_codes || [];
    if (siCodes.length > 0) {
        const fullItems = useCache().items || [];
        const hasMatchingSI = pricedItems.some(item => {
            const itemName = (item.item_name || item.item_desc || '').toUpperCase();
            const itemNo = (item.item_no || '').toUpperCase();
            const fullItem = fullItems.find(m => m.item_no === item.item_no);
            const skuNo = (fullItem?.sku_no || '').toUpperCase();
            return siCodes.some(code => {
                const c = code.toUpperCase();
                if (itemName.startsWith(c)) return true;
                if (itemName.includes(c)) return true;
                if (itemNo.includes(c)) return true;
                if (skuNo === c) return true;
                const sizeMatch = c.match(/^([MLH])-([A-Z0-9]+(?:-[A-Z0-9]+)*)$/);
                if (sizeMatch) { const transformed = `${sizeMatch[2]}${sizeMatch[1]}`; if (skuNo === transformed) return true; }
                return false;
            });
        });
        if (!hasMatchingSI) return { eligible: false, error: `This voucher only applies to specific items (${siCodes.join(', ')}). Please add a qualifying item first.` };
    }

    const promotionPrefixes = (promotion.by_prefixes?.length > 0 ? promotion.by_prefixes : promotion.by_prefix ? [promotion.by_prefix] : []).map(p => p.toUpperCase());
    if ((promotion.by_item === PROMO_BY.PREFIX || promotion.by_item === PROMO_BY.PREFIX_CHILD || promotion.by_item === 'PREFIXC') && promotionPrefixes.length > 0) {
        const sizeMap = { M: 'Medium', L: 'Large', H: 'Hot', S: 'Small' };
        const sizeLabel = promotionPrefixes.map(p => sizeMap[p] || p).join(' / ');
        const hasMatchingPrefix = pricedItems.some(item => promotionPrefixes.some(p => (item.item_name || '').toUpperCase().startsWith(p + '-')));
        if (!hasMatchingPrefix) return { eligible: false, error: `This voucher is only valid for ${sizeLabel} size drinks. Please add a ${sizeLabel} drink first.` };
    }

    return { eligible: true };
}

function checkItemEligibility(item, promotion) {
    const requiredCategories = promotion.item_menu_category_dtls || [];
    if (!requiredCategories.length) return true;
    const itemCategory = normalizeCategory(item.category_code || item.menu_category_code || item.category || '');
    if (!itemCategory) return false;
    return requiredCategories.some(reqCat => {
        const requiredCode = normalizeCategory(reqCat.category_code);
        return itemCategory === requiredCode || itemCategory.includes(requiredCode) || requiredCode.includes(itemCategory);
    });
}

function normalizeCategory(code) {
    return (code || '').toString().trim().toUpperCase();
}

// ============================================
// APPLY PROMOTIONS WITH MAPPING
// ============================================
async function applyPromotionsWithMapping(items, promotions, limit = 0) {
    console.log('🎯 Applying promotions with dynamic category mapping');

    const applyPromotionsFunc = applyPromotions || window.applyPromotions;
    if (typeof applyPromotionsFunc !== 'function') {
        console.error('❌ applyPromotions function not available');
        return { orderItems: items, applied: 0, amount: 0 };
    }

    const itemsNormalized = items.map(item => ({
        ...item,
        category_code: normalizeCategory(item.category_code || item.menu_category_code || item.category),
    }));

    const enhancedPromotions = promotions.map(originalPromo => {
        const promo = JSON.parse(JSON.stringify(originalPromo));
        promo.limit = limit || promo.limit || promo.qty_limit || 0;
        promo.is_synthetic = true;
        const categories = promo.item_menu_category_dtls || [];
        if (categories.length) {
            const seen = new Set();
            promo.item_menu_category_dtls = categories.reduce((acc, cat) => {
                const code = normalizeCategory(cat.category_code);
                if (!seen.has(code)) { acc.push({ ...cat, category_code: code }); seen.add(code); }
                return acc;
            }, []);
        }
        if (!promo.creteria_item_dtls) promo.creteria_item_dtls = '';
        if (promo.criteria_type === PROMO_TYPE.LOWEST_PRICE_DISCOUNT) {
            promo.by_item = PROMO_BY.ALL_ITEMS;
            if (!promo.limit) promo.limit = 1;
            if (!promo.criteria_disc_type) {
                const cachedPromo = (useCache()?.promos || []).find(p => same(p?.promo_name, promo.promo_name));
                promo.criteria_disc_type = cachedPromo?.criteria_disc_type || '';
                promo.criteria_disc_value = parseFloat(cachedPromo?.criteria_disc_value) || parseFloat(originalPromo.typeValue) || 0;
            }
        }
        return promo;
    });

    const voucherPromoInfo = enhancedPromotions[0];
    const criteriaType = voucherPromoInfo?.criteria_type;
    const isLD = criteriaType === PROMO_TYPE.LOWEST_PRICE_DISCOUNT;

    console.log('🎯 Final voucherPromoInfo:', {
        promo_name: voucherPromoInfo?.promo_name,
        by_item: voucherPromoInfo?.by_item,
        criteria_type: criteriaType,
        disc_type: voucherPromoInfo?.criteria_disc_type,
        disc_value: voucherPromoInfo?.criteria_disc_value,
        categories: voucherPromoInfo?.item_menu_category_dtls?.length,
        limit: voucherPromoInfo?.limit,
    });

    // ── Build flat item list for LD path ──────────────────────────────────────
    const itemsForPromo = isLD ? (() => {
        const maxSNo = itemsNormalized.reduce((max, item) => Math.max(max, parseInt(item.s_no || 0)), 0);
        let syntheticCounter = maxSNo + 1;
        return itemsNormalized.reduce((acc, item) => {
            const isParent = String(item.s_no) === String(item.parent_sno);
            const isPricedSizeChild = !isParent &&
                parseFloat(item.sub_total || 0) > 0 &&
                !['SUGAR LEVEL', 'ICE', 'REMARK', 'EXTRA OPTIONS-GF'].includes(item.category_code) &&
                item.uom !== 'REMARK';
            if (!isParent && !isPricedSizeChild) return acc;
            let effectiveItem = item;
            if (parseFloat(item.sub_total || 0) === 0 && parseFloat(item.unit_price || 0) === 0) {
                const pricedChild = itemsNormalized.find(c =>
                    String(c.parent_sno) === String(item.s_no) &&
                    String(c.s_no) !== String(item.s_no) &&
                    parseFloat(c.sub_total || 0) > 0
                );
                if (pricedChild) {
                    effectiveItem = { ...item, unit_price: parseFloat(pricedChild.unit_price || 0), sub_total: parseFloat(pricedChild.sub_total || 0), category_code: normalizeCategory(pricedChild.category_code || item.category_code) };
                }
            }
            const qty = parseInt(item.qty || 1);
            const resolvedUnitPrice = parseFloat(effectiveItem.unit_price || 0);
            const unitSubTotal = resolvedUnitPrice > 0 ? resolvedUnitPrice : parseFloat(effectiveItem.sub_total || 0) / Math.max(qty, 1);
            for (let i = 0; i < qty; i++) {
                const synSno = syntheticCounter++;
                acc.push({ ...effectiveItem, s_no: synSno, parent_sno: synSno, qty: 1, sub_total: unitSubTotal, disc_name: 'None', disc_type: '', disc_value: 0, _original_s_no: item.s_no });
            }
            return acc;
        }, []);
    })() : itemsNormalized;

    console.log('🔍 Promo cats:', voucherPromoInfo?.item_menu_category_dtls?.map(c => c.category_code));
    console.log('🔍 Item cats:', itemsForPromo.map(i => i.category_code));

    // ── LD path ───────────────────────────────────────────────────────────────
    if (isLD) {
        const cats = (voucherPromoInfo?.item_menu_category_dtls || []).map(c => c.category_code);
        const isAllItems = voucherPromoInfo?.by_item === PROMO_BY.ALL_ITEMS || cats.length === 0;
        const discType = voucherPromoInfo?.criteria_disc_type || 'P';
        const discValue = parseFloat(voucherPromoInfo?.criteria_disc_value || 0) || 100;
        const promoLimit = voucherPromoInfo?.limit || 1;
        const setQty = parseInt(voucherPromoInfo?.criteria_payment_name || '2') || 2;
        const minRequired = setQty;
        const isSETSIC = (voucherPromoInfo?.item_dtls?.length > 0) && !voucherPromoInfo?.item_menu_category_dtls?.length;
        const eligibleSkus = isSETSIC
            ? new Set(voucherPromoInfo.item_dtls.map(d => (d.item_no || d.prefix || '').toUpperCase()))
            : null;

        console.log(`🔍 LD setQty: ${setQty}, minRequired: ${minRequired}`);

        const EXCLUDED_CATEGORIES = ['SUGAR LEVEL', 'ICE', 'EXTRA OPTIONS', 'EXTRA OPTIONS-GF', 'WASTAGE'];
        const EXCLUDED_UOMS = ['REMARK'];

        const resolveToParentSno = (originalSno) => {
            const orig = itemsNormalized.find(i => String(i.s_no) === String(originalSno));
            if (!orig) return String(originalSno);
            return String(orig.s_no) === String(orig.parent_sno) ? String(orig.s_no) : String(orig.parent_sno);
        };

        const parentBestPrice = new Map();
        itemsForPromo.forEach(item => {
            const trueParent = resolveToParentSno(item._original_s_no ?? item.s_no);
            const isDrinkRow = parseFloat(item.sub_total || 0) > 0 &&
                !EXCLUDED_CATEGORIES.includes(item.category_code) &&
                !EXCLUDED_UOMS.includes(item.uom) &&
                (!eligibleSkus || eligibleSkus.has((item.item_no || '').toUpperCase()));
            if (!isDrinkRow) return;
            if (!isAllItems && !cats.includes(item.category_code)) return;
            if (parseInt(item.ds_no || 0) >= 2) {
                parentBestPrice.set(item.s_no, {
                    sub_total: parseFloat(item.sub_total || 0),
                    _original_s_no: trueParent,
                    item_name: item.item_name,
                    category_code: item.category_code,
                    ds_no: parseInt(item.ds_no || 0),
                    _synthetic_s_no: item.s_no,
                });
            }
        });

        const eligibleItems = itemsForPromo.filter(item => parentBestPrice.has(item.s_no)).map(item => parentBestPrice.get(item.s_no));
        console.log('🎯 LD bypass: eligible items:', eligibleItems.length);

        if (eligibleItems.length < minRequired) {
            console.log(`⚠️ LD bypass: only ${eligibleItems.length} eligible, need ${minRequired} — shouldRemove`);
            return { orderItems: itemsNormalized, applied: 0, amount: 0, shouldRemove: true };
        }

        const sorted = [...eligibleItems].sort((a, b) => parseFloat(a.sub_total) - parseFloat(b.sub_total));
        const freeCount = Math.min(Math.floor(sorted.length / setQty), promoLimit);
        const freeItems = sorted.slice(0, freeCount);
        console.log(`🎯 LD bypass: setQty=${setQty}, total=${sorted.length}, freeCount=${freeCount}`);

        const parentDiscountMap = new Map();
        freeItems.forEach(item => {
            const key = String(item._original_s_no);
            const itemPrice = parseFloat(item.sub_total || 0);
            const discAmt = discType === 'P' ? itemPrice * discValue / 100 : Math.min(discValue, itemPrice);
            parentDiscountMap.set(key, { pro_disc_amt: discAmt, disc_amt: discAmt, disc_type: discType, disc_name: voucherPromoInfo.promo_name, disc_value: discValue });
        });

        // ✅ LD: discount goes on the priced child (ds_no >= 2)
        // pro_disc_amt on child only — calcOrderAmt sums all rows, no parent bubble needed
        const assignedParents = new Set();
        const remappedItems = itemsNormalized.map(item => {
            const isParent = String(item.s_no) === String(item.parent_sno);

            if (isParent && parentDiscountMap.has(String(item.s_no))) {
                // ✅ Parent: tag with disc_name for UI grouping but pro_disc_amt stays 0
                const d = parentDiscountMap.get(String(item.s_no));
                return { ...item, disc_type: d.disc_type, disc_name: d.disc_name, disc_value: d.disc_value, pro_disc_amt: '0.00', disc_amt: '0.00' };
            }

            if (!isParent) {
                const parentKey = String(item.parent_sno);
                const d = parentDiscountMap.get(parentKey);
                const isPricedDrinkChild = parseFloat(item.sub_total || 0) > 0 &&
                    !EXCLUDED_CATEGORIES.includes(item.category_code) &&
                    !EXCLUDED_UOMS.includes(item.uom) &&
                    parseInt(item.ds_no || 0) >= 2;
                if (d && isPricedDrinkChild && !assignedParents.has(parentKey)) {
                    assignedParents.add(parentKey);
                    console.log(`✅ LD bypass: $${d.pro_disc_amt.toFixed(2)} → ds_no:${item.ds_no} "${item.item_name}"`);
                    return {
                        ...item,
                        disc_type: d.disc_type,
                        disc_name: d.disc_name,
                        disc_value: d.disc_value,
                        // ✅ pro_disc_amt on child — calcOrderAmt sums this row directly
                        pro_disc_amt: d.pro_disc_amt.toFixed(2),
                        disc_amt: d.disc_amt.toFixed(2),
                    };
                }
            }
            return item;
        });

        const totalApplied = remappedItems.filter(i => parseFloat(i.pro_disc_amt || 0) > 0).length;
        const totalAmount = remappedItems.reduce((sum, i) => sum + parseFloat(i.pro_disc_amt || 0), 0);
        console.log('✅ LD bypass remap complete:', { applied: totalApplied, amount: totalAmount.toFixed(2) });

        if (totalApplied === 0) {
            console.log('⚠️ LD bypass: no discount — shouldRemove');
            return { orderItems: itemsNormalized, applied: 0, amount: 0, shouldRemove: true };
        }
        return { orderItems: remappedItems, applied: totalApplied, amount: totalAmount };
    }

    // ── Non-LD: call applyPromotions ──────────────────────────────────────────
    let result;
    try {
        const triggerItem = itemsForPromo.find(i =>
            String(i.s_no) === String(i.parent_sno) && parseFloat(i.sub_total || 0) >= 0
        ) || itemsForPromo[0];
        result = applyPromotionsFunc(itemsForPromo, triggerItem, voucherPromoInfo, { promotions: enhancedPromotions });
    } catch (e) {
        console.warn('⚠️ applyPromotions threw:', e.message);
        result = { orderItems: [...itemsNormalized], applied: 0, amount: 0 };
    }

    console.log('📊 applyPromotions result:', { applied: result?.applied, amount: result?.amount, items: result?.orderItems?.length });

    const alreadyDiscounted = result.orderItems.some(i => parseFloat(i.pro_disc_amt || 0) > 0);

    if (!alreadyDiscounted) {
        const promotion = voucherPromoInfo;
        const categories = (promotion.item_menu_category_dtls || []).map(c => normalizeCategory(c.category_code));

        // ✅ isAllItems only when explicitly ALL_ITEMS with no categories
        const isAllItems = promotion.by_item === PROMO_BY.ALL_ITEMS && categories.length === 0;
        const discType = promotion.criteria_disc_type;
        const discValue = parseFloat(promotion.criteria_disc_value || 0);

        const promotionAllPrefixes = (promotion.by_prefixes?.length > 0
            ? promotion.by_prefixes
            : promotion.by_prefix ? [promotion.by_prefix] : []
        ).map(p => p.toUpperCase());
        const PREFIXC_BY_ITEMS = [PROMO_BY.PREFIX, PROMO_BY.PREFIX_CHILD, 'PREFIXC'];
        const isPromoPrefixVoucher = PREFIXC_BY_ITEMS.includes(promotion.by_item) && promotionAllPrefixes.length > 0;
        const promoItemMatchesPrefix = (item) => promotionAllPrefixes.some(p => (item.item_name || '').toUpperCase().startsWith(p + '-'));

        const isPricedParent = (item, allItems) => {
            if (parseFloat(item.sub_total || 0) <= 0) return false;
            return !allItems.some(c =>
                String(c.parent_sno) === String(item.s_no) &&
                String(c.s_no) !== String(item.s_no) &&
                parseFloat(c.sub_total || 0) > 0
            );
        };

        let totalDiscount = 0;

        if (discType === 'P') {
            const isPrefixC = promotion.by_item === PROMO_BY.PREFIX_CHILD || promotion.by_item === 'PREFIXC';
            const byPrefix = (promotion.by_prefix || (isPrefixC ? (promotion.item_dtls?.[0]?.prefix || promotionAllPrefixes[0] || '') : '')).toUpperCase();
            const criteriaQtyLimit = parseInt(promotion.criteria_payment_name || '0') || 0;
            const effectiveLimit = (promotion.limit || promotion.qty_limit || 0) > 0
                ? (promotion.limit || promotion.qty_limit)
                : criteriaQtyLimit > 0 ? criteriaQtyLimit : 0;
            let remainingFreeUnits = effectiveLimit > 0 ? effectiveLimit : Infinity;
            const bubbedParents = new Set();

            result.orderItems = result.orderItems.map((item) => {
                if (remainingFreeUnits <= 0) return item;

                if (isPromoPrefixVoucher) {
                    if (parseFloat(item.sub_total || 0) <= 0) return item;
                    if (!promoItemMatchesPrefix(item)) return item;
                    const hasMatchingPrefixChild = result.orderItems.some(c =>
                        String(c.parent_sno) === String(item.s_no) &&
                        String(c.s_no) !== String(item.s_no) &&
                        promoItemMatchesPrefix(c) &&
                        parseFloat(c.sub_total || 0) > 0
                    );
                    if (hasMatchingPrefixChild) return item;
                } else if (!isPrefixC && String(item.s_no) !== String(item.parent_sno)) {
                    return item;
                } else if (!isPricedParent(item, result.orderItems)) {
                    return item;
                } else if (byPrefix && !(item.item_name || '').toUpperCase().startsWith(byPrefix + '-')) {
                    return item;
                } else if (!byPrefix && !isAllItems) {
                    if (!categories.includes(normalizeCategory(item.category_code))) return item;
                }

                const unitPrice = parseFloat(item.unit_price || 0) || parseFloat(item.sub_total || 0) / Math.max(parseInt(item.qty || 1), 1);
                const itemDiscount = unitPrice * discValue / 100;
                if (itemDiscount <= 0) return item;
                totalDiscount += itemDiscount;
                remainingFreeUnits--;

                const discountedItem = {
                    ...item,
                    disc_type: 'P',
                    disc_name: promotion.promo_name,
                    disc_value: discValue,
                    pro_disc_amt: itemDiscount.toFixed(2),
                    disc_amt: itemDiscount.toFixed(2),
                };

                // ✅ PREFIXC only: bubble to parent so calcOrderAmt picks it up
                // (PREFIXC matches child row directly — parent has no sub_total)
                const isChildRow = String(item.s_no) !== String(item.parent_sno);
                if (isPromoPrefixVoucher && isChildRow && !bubbedParents.has(String(item.parent_sno))) {
                    bubbedParents.add(String(item.parent_sno));
                    const parentIdx = result.orderItems.findIndex(p =>
                        String(p.s_no) === String(item.parent_sno) &&
                        String(p.s_no) === String(p.parent_sno)
                    );
                    if (parentIdx !== -1) {
                        const parent = result.orderItems[parentIdx];
                        result.orderItems[parentIdx] = {
                            ...parent,
                            disc_type: 'P',
                            disc_name: promotion.promo_name,
                            disc_value: discValue,
                            pro_disc_amt: itemDiscount.toFixed(2),
                            disc_amt: itemDiscount.toFixed(2),
                        };
                        console.log(`✅ PREFIXC bubble $${itemDiscount.toFixed(2)} to parent s_no:${parent.s_no}`);
                    }
                }

                console.log(`✅ P discount $${itemDiscount.toFixed(2)} → ds_no:${item.ds_no} "${item.item_name}"`);
                return discountedItem;
            });

            if (!isPromoPrefixVoucher && byPrefix && totalDiscount === 0) result.noEligibleItems = true;

        } else if (discType === 'V') {
            let remainingDiscount = discValue;
            result.orderItems = result.orderItems.map(item => {
                if (remainingDiscount <= 0) return item;
                if (String(item.s_no) !== String(item.parent_sno)) return item;
                if (!isPricedParent(item, result.orderItems)) return item;
                if (!isAllItems && !categories.includes(normalizeCategory(item.category_code))) return item;
                const itemDiscount = Math.min(remainingDiscount, parseFloat(item.sub_total));
                remainingDiscount -= itemDiscount;
                totalDiscount += itemDiscount;
                return { ...item, disc_type: 'V', disc_name: promotion.promo_name, disc_value: discValue, pro_disc_amt: itemDiscount.toFixed(2), disc_amt: itemDiscount.toFixed(2) };
            });

        } else if (promotion.si_item_codes?.length) {
            const siCodes = promotion.si_item_codes.map(c => c.toUpperCase());
            let remainingSiDiscount = discValue;
            result.orderItems = result.orderItems.map(item => {
                if (remainingSiDiscount <= 0) return item;
                if (parseFloat(item.sub_total || 0) <= 0) return item;
                const itemName = (item.item_name || item.item_desc || '').toUpperCase();
                const itemNo = (item.item_no || '').toUpperCase();
                if (!siCodes.some(code => itemName.startsWith(code) || itemName.includes(code) || itemNo.includes(code))) return item;
                const itemDiscount = Math.min(remainingSiDiscount, parseFloat(item.sub_total));
                remainingSiDiscount -= itemDiscount;
                totalDiscount += itemDiscount;
                return { ...item, disc_type: 'V', disc_name: promotion.promo_name, disc_value: discValue, pro_disc_amt: itemDiscount.toFixed(2), disc_amt: itemDiscount.toFixed(2) };
            });
        }

        result.applied = result.orderItems.filter(i => parseFloat(i.pro_disc_amt || 0) > 0).length;
        result.amount = totalDiscount;
        console.log('✅ Fallback discount applied:', { criteriaType, discType, discValue, total: totalDiscount.toFixed(2), items: result.applied });
    }

    if (result?.amount > 0) {
        const grossTotal = result.orderItems.reduce((sum, item) => sum + parseFloat(item.sub_total || 0), 0);
        result.total_disc = result.amount.toFixed(2);
        result.net_amt = Math.max(0, grossTotal - result.amount).toFixed(2);
    }

    return result;
}

// ============================================
// VOUCHER UI HELPERS
// ============================================
export function updateVoucherApplyButton() {
    const { order } = useOrder();
    const hasVoucher = !!(order?.voucher_code || JSON.parse(localStorage.getItem('appliedCrmVouchers') || '[]').length > 0);
    document.querySelectorAll('[data-action="apply-voucher"], #applyVoucherBtn, .apply-voucher-btn').forEach(btn => {
        btn.disabled = hasVoucher;
        btn.classList.toggle('btn-disabled', hasVoucher);
        btn.style.opacity = hasVoucher ? '0.4' : '';
        btn.style.pointerEvents = hasVoucher ? 'none' : '';
        btn.title = hasVoucher ? 'Remove current voucher before applying another' : '';
    });
}

function showVoucherAppliedMessage(voucherName, discount = 0) {
    const discountNum = parseFloat(discount) || 0;
    if (discountNum > 0) { showToast(`You saved $${discountNum.toFixed(2)}`, 'success', `${voucherName} applied!`, 4000); }
    else { showToast('Voucher has been applied to your order', 'success', `${voucherName} applied!`, 4000); }
}

function showVoucherError(message) {
    const messageEl = document.getElementById('voucherMessage');
    if (messageEl) { messageEl.className = 'voucher-message error'; messageEl.innerHTML = `<span class="message-icon">⚠️</span><span class="message-text">${message}</span>`; messageEl.style.display = 'flex'; setTimeout(() => { messageEl.style.display = 'none'; }, 3000); }
    const modalMessage = document.getElementById('voucherModalMessage');
    if (modalMessage) { modalMessage.className = 'voucher-modal-message error'; modalMessage.textContent = message; modalMessage.style.display = 'block'; setTimeout(() => { modalMessage.style.display = 'none'; }, 3000); }
}

function showVoucherRemovedMessage() {
    const messageEl = document.getElementById('voucherMessage');
    if (messageEl) { messageEl.className = 'voucher-message info'; messageEl.innerHTML = `<span class="message-icon">ℹ️</span><span class="message-text">Voucher removed</span>`; messageEl.style.display = 'flex'; setTimeout(() => { messageEl.style.display = 'none'; }, 2000); }
}

function safeCall(fnName, ...args) {
    if (typeof window[fnName] === 'function') { try { window[fnName](...args); } catch (err) { console.warn(`⚠️ safeCall(${fnName}) failed:`, err); } }
    else { console.warn(`⚠️ ${fnName} not available yet`); }
}

// ============================================
// AVAILABLE VOUCHERS
// ============================================
export function getAvailableVouchers() {
    const now = Date.now();
    if (_voucherCache && (now - _voucherCacheTime) < VOUCHER_CACHE_TTL_MS) return _voucherCache;

    const cache = useCache();
    const rawData = cache.memberRawData;
    const rawList = rawData?.data?.VoucherLists || rawData?.VoucherLists;
    const normalList = rawData?.redeemable_list;

    if ((!rawList?.length) && (!normalList?.length)) { console.warn('⚠️ No voucher data available'); _voucherCache = null; _voucherCacheTime = 0; return []; }

    const parseDateMs = (val) => {
        if (!val) return null;
        if (typeof val === 'string') { const m = val.match(/\/Date\((\d+)\)\//); if (m) return parseInt(m[1]); const t = new Date(val).getTime(); return isNaN(t) ? null : t; }
        if (typeof val === 'number') return val;
        return null;
    };

    const parseApiDate = (val) => {
        if (!val) return null;
        if (typeof val === 'string') { const m = val.match(/\/Date\((\d+)\)\//); if (m) return new Date(parseInt(m[1])).toISOString(); }
        return val;
    };

    let vouchers = [];

    if (rawList?.length) {
        console.log('📋 Using raw VoucherLists, count:', rawList.length);
        vouchers = rawList
            .filter(v => {
                const vf = parseDateMs(v.ValidFrom);
                const vt = parseDateMs(v.ValidTo);
                const vtAdjusted = vt ? vt + (32 * 60 * 60 * 1000) - 1000 : vt;
                const pass = (!vf || now >= vf) && (!vtAdjusted || now <= vtAdjusted);
                if (!pass) console.warn('❌ Voucher filtered out by date:', v.VoucherNo);
                return pass;
            })
            .map(v => {
                const typeValue = parseFloat(v.TypeValue || 0);
                const balanceAmt = parseFloat(v.BalanceAmt || 0);
                const redeemAmt = parseFloat(v.VoucherRedemptionValue || 0);
                const vType = (v.Type || '').toUpperCase();
                let posRedeemAmount = 0, posRedeemPercentage = 0;

                switch (vType) {
                    case 'IPDISCOUNT': posRedeemPercentage = typeValue || balanceAmt; break;
                    case 'IDDISCOUNT':
                        posRedeemAmount = balanceAmt > 0 ? balanceAmt : typeValue;
                        if (posRedeemAmount === 0) { const ref7Val = (v.Ref7 || '').includes('|-|') ? v.Ref7.split('|-|')[1]?.trim() : ''; const ref7Num = parseFloat(ref7Val); if (ref7Num > 0) posRedeemAmount = ref7Num; }
                        break;
                    case 'DDISCOUNT':
                        posRedeemAmount = balanceAmt > 0 ? balanceAmt : typeValue;
                        if (posRedeemAmount === 0) { const ref5Val = (v.Ref5 || '').includes('|-|') ? v.Ref5.split('|-|')[1]?.trim() : ''; const ref5Amt = parseFloat(ref5Val); if (ref5Amt > 0) posRedeemAmount = ref5Amt; }
                        if (posRedeemAmount === 0) { const ref7Val = (v.Ref7 || '').includes('|-|') ? v.Ref7.split('|-|')[1]?.trim() : ''; const ref7Amt = parseFloat(ref7Val); if (ref7Amt > 0) posRedeemAmount = ref7Amt; }
                        break;
                    default: posRedeemAmount = redeemAmt || balanceAmt || typeValue;
                }

                return {
                    code: v.VoucherNo,
                    voucherTypeCode: v.VoucherTypeCode,
                    name: (v.VoucherTypeDescription?.trim()) || v.VoucherTypeName || 'Voucher',
                    type: 'issued_reward',
                    imageUrl: v.VoucherUrl?.trim() || null,
                    validFrom: parseApiDate(v.ValidFrom),
                    expiryDate: parseApiDate(v.ValidTo),
                    posRedeemMethod: v.Type,
                    posRedeemAmount,
                    posRedeemPercentage,
                    posRedeemExtra: v.Ref7,
                    currency: v.Currency || 'SGD',
                    raw: v,
                };
            });

    } else if (normalList?.length) {
        console.log('📋 Using redeemable_list, count:', normalList.length);
        vouchers = normalList
            .filter(v => { if (v.EligibleFlag !== true) return false; const expMs = parseDateMs(v.expiry_date_tz); return !expMs || now <= expMs; })
            .map(v => {
                const raw = v._ascentis_raw || {};
                return { code: v.redeem_code, voucherTypeCode: raw.VoucherTypeCode || '', name: (raw.VoucherTypeDescription?.trim()) || raw.VoucherTypeName || v.redeem_name || 'Voucher', type: 'issued_reward', imageUrl: v.image_url || null, validFrom: null, expiryDate: parseApiDate(v.expiry_date_tz) || v.expiry_date_tz || null, posRedeemMethod: v.pos_redeem_method, posRedeemAmount: parseFloat(v.pos_redeem_amount || 0), posRedeemPercentage: 0, posRedeemExtra: raw.Ref7 || null, currency: raw.Currency || 'SGD', raw };
            });
    }

    vouchers = vouchers.filter(v => v.code);
    voucherState.availableVouchers = vouchers;
    console.log(`📋 Vouchers loaded: ${vouchers.length}`);
    _voucherCache = vouchers;
    _voucherCacheTime = now;
    return vouchers;
}

export function getVouchersByType() {
    const vouchers = getAvailableVouchers();
    return { issued: vouchers.filter(v => v.type === 'issued_reward'), catalog: vouchers.filter(v => v.type === 'catalog') };
}

export function getVoucherCount() { return getAvailableVouchers().length; }

export function updateVoucherUI() {
    if (_updateVoucherUITimer) clearTimeout(_updateVoucherUITimer);
    _updateVoucherUITimer = setTimeout(() => {
        _updateVoucherUITimer = null;
        const count = getVoucherCount();
        console.log('🎟️ Updating voucher UI, count:', count);
        const banner = document.getElementById('voucherBanner');
        const bannerCount = document.getElementById('availableVoucherCount');
        if (banner && bannerCount) { bannerCount.textContent = count; banner.style.display = count > 0 ? 'flex' : 'none'; }
        const fab = document.getElementById('voucherFab');
        const fabCount = document.getElementById('fabVoucherCount');
        if (fab && fabCount) { fabCount.textContent = count; fab.style.display = count > 0 ? 'flex' : 'none'; }
    }, 50);
}

export function parseDiscountRule(extraData) {
    if (!extraData) return null;
    try {
        const params = new URLSearchParams(extraData);
        const discountRule = params.get('discountrule');
        const qty = params.get('qty');
        return { rule: discountRule || 'No rule specified', quantity: qty ? parseInt(qty) : 0, raw: extraData };
    } catch (error) { console.warn('⚠️ Failed to parse discount rule:', error); return null; }
}

// ============================================
// VOUCHER MODAL
// ============================================
function renderVoucherSkeletons(count = 6) {
    return Array(count).fill(null).map(() => `
        <div class="voucher-card-skeleton">
            <div class="skeleton-header"><div class="skeleton-image"></div><div class="skeleton-info"><div class="skeleton-text" style="width:80px;height:24px;"></div><div class="skeleton-text title"></div><div class="skeleton-text code"></div></div></div>
            <div class="skeleton-details"><div class="skeleton-text discount"></div><div class="skeleton-text quantity"></div></div>
            <div class="skeleton-text expiry"></div>
            <div class="skeleton-text" style="width:100%;height:48px;border-radius:12px;"></div>
        </div>`).join('');
}

export function openVouchersModal() {
    const modal = document.getElementById('vouchersModalOverlay');
    const content = document.getElementById('vouchersModalContent');
    if (!modal || !content) return;
    sendVoucherWS({ action: 'voucher_modal_open' });
    modal.style.display = 'flex';
    modal.classList.add('active');
    updateVoucherFilterCounts();
    content.innerHTML = renderVoucherSkeletons(6);
    const DEFAULT_FILTER = 'all';
    document.querySelectorAll('.voucher-filter-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === DEFAULT_FILTER));
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            filterVouchers(DEFAULT_FILTER);
            const { order } = useOrder();
            const appliedVoucherCode = order?.voucher_code;
            if (appliedVoucherCode) { setTimeout(() => { content.querySelector(`[data-voucher-code="${appliedVoucherCode}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 200); }
        });
    });
}

export function closeVouchersModal() {
    console.log('🔒 Closing vouchers modal');
    const overlay = document.getElementById('vouchersModalOverlay');
    if (overlay) { overlay.classList.remove('active'); overlay.style.display = 'none'; }
    setTimeout(() => { console.log('🔄 Re-rendering cart after voucher modal close'); renderCartFromOrder(true); }, 50);
}

export function renderVouchersModal(filterType = 'all') {
    console.log('🎨 Rendering vouchers, filter:', filterType);
    const content = document.getElementById('vouchersModalContent');
    if (!content) { console.error('❌ vouchersModalContent not found'); return; }
    _renderVouchersContent(content, filterType);
}

function _renderVouchersContent(content, filterType) {
    const allVouchers = getAvailableVouchers();
    const vouchers = filterType === 'issued' ? allVouchers.filter(v => v.type === 'issued_reward') : filterType === 'catalog' ? allVouchers.filter(v => v.type === 'catalog') : allVouchers;
    const { order } = useOrder();
    const appliedVoucherCode = order?.voucher_code;
    const loadingVoucher = voucherState.loadingVoucher;
    const hasAppliedVoucher = !!appliedVoucherCode;

    if (vouchers.length === 0) { content.innerHTML = `<div class="no-vouchers"><div class="no-vouchers-icon">🎟️</div><p>No vouchers available</p></div>`; return; }

    content.innerHTML = vouchers.map(voucher => {
        const { code, name, imageUrl: imgUrl, expiryDate: expiry } = voucher;
        if (!code) return '';
        const isApplied = appliedVoucherCode === code;
        const isLoading = loadingVoucher?.code === code;
        const disabled = (!!loadingVoucher && loadingVoucher?.code !== code) || (hasAppliedVoucher && !isApplied);
        const redeemAmt = parseFloat(voucher.posRedeemAmount || 0);
        const redeemPct = parseFloat(voucher.posRedeemPercentage || 0);
        const posMethod = (voucher.posRedeemMethod || '').toUpperCase();

        let discountDisplay;
        switch (posMethod) {
            case 'FREEITEM': discountDisplay = 'Free Item'; break;
            case 'IPDISCOUNT': discountDisplay = redeemPct > 0 ? `${redeemPct}% OFF` : '% OFF'; break;
            case 'IDDISCOUNT': discountDisplay = redeemAmt > 0 ? `$${redeemAmt.toFixed(2)} OFF` : '$ OFF'; break;
            case 'DDISCOUNT': discountDisplay = redeemAmt > 0 ? `$${redeemAmt.toFixed(2)} OFF` : '$ OFF'; break;
            default:
                if (redeemPct > 0) discountDisplay = `${redeemPct}% OFF`;
                else if (redeemAmt > 0) discountDisplay = `$${redeemAmt.toFixed(2)} OFF`;
                else discountDisplay = 'Complimentary';
        }

        let expiryDisplay = '', expiryUrgent = false;
        if (expiry) {
            const date = new Date(expiry);
            const daysLeft = Math.ceil((date - Date.now()) / 86400000);
            if (daysLeft < 0) { expiryDisplay = 'Expired'; }
            else if (daysLeft === 0) { expiryDisplay = 'Expires today'; expiryUrgent = true; }
            else if (daysLeft <= 7) { expiryDisplay = `Expires in ${daysLeft} day${daysLeft > 1 ? 's' : ''}`; expiryUrgent = true; }
            else { expiryDisplay = `Valid until ${date.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' })}`; }
        }

        const hasImage = imgUrl && imgUrl.trim() !== '';
        return `
            <div class="voucher-card-full loaded ${isApplied ? 'selected applied' : ''} ${disabled ? 'disabled' : ''}" data-voucher-code="${code}">
                <div class="voucher-card-header">
                    <div class="voucher-icon-wrapper">
                        ${hasImage ? `<img src="${imgUrl}" alt="${name}" class="voucher-image-large" loading="lazy" onerror="this.style.display='none'">` : `<div class="voucher-placeholder-large"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M7 15h.01M11 15h2"/></svg></div>`}
                        ${isApplied ? '<div class="voucher-check-badge">✓</div>' : ''}
                    </div>
                    <div class="voucher-info-wrapper">
                        <h3 class="voucher-name">${name}</h3>
                        <span class="voucher-discount-badge">${discountDisplay}</span>
                        ${getVoucherEligibilityHtml(voucher)}
                    </div>
                </div>
                ${expiryDisplay ? `<div class="voucher-expiry ${expiryUrgent ? 'urgent' : ''}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span>${expiryDisplay}</span></div>` : ''}
                <div class="voucher-card-actions">
                    ${isApplied ? `
                        <button class="voucher-btn voucher-applied" disabled><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Applied</button>
                        <button class="voucher-btn voucher-remove" onclick="event.stopPropagation(); window.handleVoucherRemove('${code}');" ${disabled ? 'disabled' : ''}>${isLoading ? '⏳' : '✕'}</button>
                    ` : `
                        <button class="voucher-btn voucher-apply" onclick="event.stopPropagation(); window.handleVoucherApply('${code}');" ${disabled ? 'disabled' : ''} ${hasAppliedVoucher && !isApplied ? 'title="Remove current voucher before applying another"' : ''}>
                            ${isLoading ? '<span class="btn-spinner"></span> Applying...' : 'Apply Voucher'}
                        </button>
                    `}
                </div>
            </div>`;
    }).join('');

    console.log(`✅ Rendered ${vouchers.length} vouchers (filter: ${filterType})`);
}

export function filterVouchers(filterType) {
    if (!['all', 'issued', 'catalog'].includes(filterType)) { console.error('❌ Invalid filter type:', filterType); return; }
    const content = document.getElementById('vouchersModalContent');
    if (!content) return;
    sendVoucherWS({ action: 'voucher_filter_change', filterType });
    updateFilterButtons(filterType);
    setTimeout(() => renderVouchersModal(filterType), 150);
}

function updateFilterButtons(activeFilter) {
    document.querySelectorAll('.voucher-filter-btn').forEach(btn => { const filterType = btn.getAttribute('data-filter'); if (filterType) btn.classList.toggle('active', filterType === activeFilter); });
}

export function updateVoucherFilterCounts() {
    const count = getVoucherCount();
    const allCount = document.getElementById('filterAllCount');
    if (allCount) allCount.textContent = count;
}

function getCurrentFilter() {
    const activeBtn = document.querySelector('.voucher-filter-btn.active');
    return activeBtn?.dataset?.filter || 'all';
}

// ============================================
// VOUCHER ELIGIBILITY BADGES
// ============================================
function getVoucherEligibilityHtml(voucher) {
    const raw = voucher.raw || voucher;
    const type = (raw?.Type || '').toUpperCase();
    const typeValue = parseFloat(raw?.TypeValue || 0);
    const balanceAmt = parseFloat(raw?.BalanceAmt || 0);
    const ref7 = raw?.Ref7 || '';
    const isRedeemable = raw?.IsRedeemable ?? false;
    const redeemValue = parseFloat(raw?.VoucherRedemptionValue || 0);
    const parsed = parseRef7(ref7);
    const badges = [];

    if (isRedeemable && redeemValue > 0) badges.push(`<span class="voucher-info-badge voucher-info-points">🏆 ${redeemValue} pts</span>`);

    if (type === 'DDISCOUNT') { const amt = balanceAmt > 0 ? balanceAmt : typeValue; if (amt > 0) badges.push(`<span class="voucher-info-badge voucher-info-savings">💰 $${amt.toFixed(2)} Off Bill</span>`); }
    else if (type === 'IPDISCOUNT') { const pct = typeValue || balanceAmt; if (pct > 0) badges.push(`<span class="voucher-info-badge voucher-info-savings">💰 ${pct}% Off Items</span>`); }
    else if (type === 'IDDISCOUNT') { if (parsed?.pattern !== 'PREFIXC') { const amt = parsed?.value || balanceAmt || typeValue; if (amt > 0) badges.push(`<span class="voucher-info-badge voucher-info-savings">💰 $${amt.toFixed(2)} Off Items</span>`); } }

    if (parsed) {
        switch (parsed.pattern) {
            case 'SETSCC': { const setQty = parsed.setQty || 2; const buyQty = setQty - 1; const label = buyQty === 1 ? '1 For 1' : `Buy ${buyQty} Get 1 Free`; badges.push(`<span class="voucher-info-badge voucher-info-type">🎁 ${label}</span>`); (parsed.includeCats || []).forEach(cat => badges.push(`<span class="voucher-info-badge voucher-info-include">✅ ${cat}</span>`)); break; }
            case 'SETSIC': { const setQty = parsed.setQty || 2; const buyQty = setQty - 1; const label = buyQty === 1 ? '1 For 1' : `Buy ${buyQty} Get 1 Free`; badges.push(`<span class="voucher-info-badge voucher-info-type">🎁 ${label}</span>`); const baseSKUs = [...new Set((parsed.includeSKUs || []).map(s => s.replace(/[MLH]\d*$/i, '').trim()))].slice(0, 3); const moreSKU = (parsed.includeSKUs || []).length > baseSKUs.length ? ' +more' : ''; if (baseSKUs.length > 0) badges.push(`<span class="voucher-info-badge voucher-info-include">📋 ${baseSKUs.join(', ')}${moreSKU}</span>`); break; }
            case 'SETXC': { const setQty = parsed.setQty || 2; const buyQty = setQty - 1; const label = buyQty === 1 ? '1 For 1' : `Buy ${buyQty} Get 1 Free`; badges.push(`<span class="voucher-info-badge voucher-info-type">🎁 ${label}</span>`); if (parsed.excludeCat) badges.push(`<span class="voucher-info-badge voucher-info-exclude">❌ Excl. ${parsed.excludeCat}</span>`); break; }
            case 'SETXCC': { const setQty = parsed.setQty || 2; const buyQty = setQty - 1; const label = buyQty === 1 ? '1 For 1' : `Buy ${buyQty} Get 1 Free`; badges.push(`<span class="voucher-info-badge voucher-info-type">🎁 ${label}</span>`); (parsed.excludeCats || []).forEach(cat => badges.push(`<span class="voucher-info-badge voucher-info-exclude">❌ Excl. ${cat}</span>`)); break; }
            case 'PREFIXC': { const sizeMap = { M: 'Medium', L: 'Large', S: 'Small', H: 'Hot' }; const allPrefixes = parsed.prefixes || [parsed.excludePrefix].filter(Boolean); if (type === 'IDDISCOUNT') { const primaryPrefix = allPrefixes[0] || ''; const fromSize = primaryPrefix === 'L' ? 'Medium' : primaryPrefix === 'M' ? 'Small' : '?'; const toSize = sizeMap[primaryPrefix] || primaryPrefix; badges.push(`<span class="voucher-info-badge voucher-info-type">🆙 Free Upsize to ${toSize}</span>`); badges.push(`<span class="voucher-info-badge voucher-info-include">☕ ${fromSize} Size Only</span>`); } else { const sizeNames = allPrefixes.map(p => sizeMap[p] || p).join(' / '); badges.push(`<span class="voucher-info-badge voucher-info-type">🎁 Free ${sizeNames} Drink</span>`); badges.push(`<span class="voucher-info-badge voucher-info-include">☕ Any ${sizeNames} Drink</span>`); } break; }
            case 'XCC': { if (parsed.value > 0) badges.push(`<span class="voucher-info-badge voucher-info-savings">💰 $${parsed.value.toFixed(2)} Off</span>`); (parsed.excludeCats || []).forEach(cat => badges.push(`<span class="voucher-info-badge voucher-info-exclude">❌ Excl. ${cat}</span>`)); break; }
            case 'SIC': { if (parsed.value > 0) badges.push(`<span class="voucher-info-badge voucher-info-savings">💰 $${parsed.value.toFixed(2)} Off</span>`); const baseCodes = [...new Set((parsed.items || []).map(c => c.replace(/[MLH]-?\d*$/i, '').trim()))].slice(0, 2); const moreSIC = (parsed.items || []).length > baseCodes.length ? ' +more' : ''; if (baseCodes.length > 0) badges.push(`<span class="voucher-info-badge voucher-info-include">📋 ${baseCodes.join(', ')}${moreSIC}</span>`); break; }
            case 'SCC': { const cats = parsed.categories || (parsed.category ? [parsed.category] : []); const visibleCats = cats.slice(0, 3); const moreCats = cats.length > 3 ? ` +${cats.length - 3} more` : ''; visibleCats.forEach(cat => badges.push(`<span class="voucher-info-badge voucher-info-include">✅ ${cat}</span>`)); if (moreCats) badges.push(`<span class="voucher-info-badge voucher-info-include">✅ ${moreCats}</span>`); break; }
            case 'VALUE_BY': case 'VALUE': { const by = parsed.by || 'AI'; if (by === 'AI') badges.push(`<span class="voucher-info-badge voucher-info-include">✅ All Items</span>`); else if (by.startsWith('SC:')) badges.push(`<span class="voucher-info-badge voucher-info-include">✅ ${by.replace('SC:', '')}</span>`); break; }
        }
    }

    if (raw?.IsMinSpendingReq && parseFloat(raw?.MinSpendingValue || 0) > 0) badges.push(`<span class="voucher-info-badge voucher-info-min">Min $${parseFloat(raw.MinSpendingValue).toFixed(2)}</span>`);
    if (!badges.length) return '';
    return `<div class="voucher-eligibility-info">${badges.join('')}</div>`;
}

// ============================================
// MEMBER MANAGEMENT
// ============================================
export async function getMemberByPhone(phoneNumber) { console.log(`📱 getMemberByPhone via Ascentis`); return callAscentisMemberByPhone(phoneNumber); }

export async function getEberMemberByPhone(phoneNumber) {
    if (!phoneNumber) { await showAlert('Please enter your phone number to continue', 'Phone Number Required', 'warning'); return; }
    let cleanPhone = phoneNumber.replace(/\D/g, "");
    if (cleanPhone.startsWith("65") && cleanPhone.length === 10) cleanPhone = cleanPhone.substring(2);
    if (cleanPhone.length !== 8) { console.error("❌ Invalid Singapore number"); return { success: false, error: "Invalid Singapore phone number." }; }
    try {
        const response = await fetch(`/api/eber/user/show?phone=${cleanPhone}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queryString: "" }) });
        const text = await response.text();
        const json = text ? JSON.parse(text) : null;
        if (!response.ok) { console.error("❌ API Error:", text); return { success: false, error: text }; }
        return json;
    } catch (err) { console.error("❌ Network error:", err); return { success: false, error: err.message }; }
}

export async function callAscentisMemberByPhone(phoneNumber) {
    if (!phoneNumber) { await showAlert('Please enter your phone number to continue', 'Phone Number Required', 'warning'); return; }
    let cleanPhone = phoneNumber.replace(/\D/g, "");
    if (cleanPhone.startsWith("65") && cleanPhone.length === 10) cleanPhone = cleanPhone.substring(2);
    if (cleanPhone.length !== 8) { console.error("❌ Invalid Singapore number"); return { success: false, error: "Invalid Singapore phone number." }; }

    try {
        const sessionid = crypto.randomUUID ? crypto.randomUUID() : `dev-${Date.now().toString(36)}-${Math.random().toString(36).substring(2)}`;
        console.log(`🔄 Calling Ascentis API for phone: ${cleanPhone}`);
        const response = await fetch(`/api/crm/post_ascentis_memberenquiry/${cleanPhone}?sessionid=${sessionid}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ MobileNo: cleanPhone, FilterCardsByStatus: "ACTIVE", MobileNoExactSearch: true, RetrievePtsToNextTier: true, RetrieveNettToNextTier: true, CardLists_PageNumber: 1, CardLists_PageCount: 99 })
        });
        const text = await response.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { console.warn("⚠️ Response is not valid JSON"); }
        if (!response.ok) { console.error("❌ Ascentis API Error:", text); return { success: false, error: text || `HTTP ${response.status}` }; }

        const crmData = json?.data;
        if (!crmData?.MemberLists?.length) { console.warn("⚠️ Ascentis member not found"); return { success: false, member_found: false, error: "Member not found" }; }

        const memberInfo = crmData.MemberLists[0];
        const cardInfo = crmData.CardLists?.[0] ?? null;
        const firstName = (memberInfo.Name || "").split(" ")[0].substring(0, 3);
        console.log("✅ Ascentis member loaded successfully");

        return {
            success: true, member_found: true,
            member: { ...memberInfo, ...(cardInfo ?? {}), id: memberInfo.MemberID, name: memberInfo.Name, display_name: memberInfo.Name, phone: cleanPhone, phone_format: cleanPhone, email: memberInfo.Email, points: cardInfo?.PointsBAL ?? 0, total_points: cardInfo?.TotalPointsBAL ?? 0, tier: cardInfo?.TierCode ?? "", card_no: cardInfo?.CardNo ?? "", membership_type: cardInfo?.MembershipTypeCode ?? "", membership_status: cardInfo?.MembershipStatusCode ?? "", expiry_date: cardInfo?.ExpiryDate ?? null, nett_to_next_tier: cardInfo?.NettToNextTier ?? "", available_rewards: 0, customer_code: `${firstName}-${cleanPhone}` },
            raw_data: crmData
        };
    } catch (err) { console.error("❌ Network error in callAscentisMemberByPhone:", err); return { success: false, error: err.message || "Unknown error" }; }
}

export async function getPosCrmPointAvl(customerCode, netAmt) {
    try {
        const response = await fetch(`/api/crm/GetPosCrmpointavl/${customerCode}`, { method: "GET", headers: { "Content-Type": "application/json" } });
        const text = await response.text();
        const json = text ? JSON.parse(text) : null;
        if (!response.ok) { console.error("❌ GetPosCrmpointavl Error:", text); return { success: false, error: text }; }
        const pointData = json?.data?.[0];
        if (!pointData) return { success: false, error: "No point data returned" };
        const redeemPoints = Math.min(parseFloat(netAmt) / parseFloat(pointData.redeem_amount_cf), parseFloat(pointData.points_avl)).toFixed(2);
        const redeemAmount = (parseFloat(pointData.redeem_amount_cf) * parseFloat(redeemPoints)).toFixed(2);
        return { success: true, customer_code: pointData.customer_code, name: `${pointData.first_name} ${pointData.last_name}`, points_avl: pointData.points_avl, redeem_points: redeemPoints, redeem_amount: isNaN(parseFloat(redeemAmount)) ? "0.00" : redeemAmount, raw: pointData };
    } catch (err) { console.error("❌ Network error:", err); return { success: false, error: err.message }; }
}

async function fetchAndCacheAscentisVouchers(cardNo) {
    try {
        console.log("📋 Fetching Ascentis vouchers for card:", cardNo);
        const PAGE_SIZE = 99;
        const firstRes = await fetch(`/api/crm/GetPosCardEnquiry/${cardNo}?pageNumber=1&pageCount=${PAGE_SIZE}`, { method: "GET", headers: { "Content-Type": "application/json" } });
        if (!firstRes.ok) { console.warn("⚠️ Failed to fetch Ascentis vouchers:", firstRes.status); return; }

        const firstJson = await firstRes.json();
        const crmData = firstJson?.data;
        const firstBatch = crmData?.VoucherLists ?? [];
        const totalCount = crmData?.TotalActiveVoucherCount ?? firstBatch.length;
        const totalPages = Math.ceil(totalCount / PAGE_SIZE);
        console.log(`📋 Page 1/${totalPages}: ${firstBatch.length} vouchers, ${totalCount} total`);

        let allVouchers = [...firstBatch];
        if (totalPages > 1) {
            const pagePromises = [];
            for (let page = 2; page <= totalPages; page++) {
                pagePromises.push(
                    fetch(`/api/crm/GetPosCardEnquiry/${cardNo}?pageNumber=${page}&pageCount=${PAGE_SIZE}`, { method: "GET", headers: { "Content-Type": "application/json" } })
                        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
                        .then(j => { const batch = j?.data?.VoucherLists ?? []; console.log(`📋 Page ${page}/${totalPages}: ${batch.length} vouchers`); return batch; })
                        .catch(err => { console.warn(`⚠️ Page ${page} failed:`, err.message); return []; })
                );
            }
            const extraPages = await Promise.all(pagePromises);
            extraPages.forEach(batch => allVouchers = allVouchers.concat(batch));
        }

        console.log(`📋 Fetched ${allVouchers.length} / ${totalCount} total vouchers`);
        const eligibleVouchers = allVouchers.filter(v => v.EligibleFlag === true);
        const cache = useCache();
        cache.memberRawData = { ...(cache.memberRawData || {}), data: { ...crmData, VoucherLists: eligibleVouchers } };
        invalidateVoucherCache();
        console.log(`✅ Cached ${eligibleVouchers.length} Ascentis vouchers`);
    } catch (err) { console.error("❌ Failed to fetch Ascentis vouchers:", err); }
}

export async function verifyMemberLogin(phoneNumber) {
    const vendor = getCRMVendor();
    const res = await getMemberByPhone(phoneNumber);
    if (res?.success && res.member_found && res.member) {
        const member = res.member;
        const cache = useCache();
        cache.isMemberLoggedIn = true;
        cache.currentMember = member;
        cache.memberRawData = res.raw_data;
        invalidateVoucherCache();
        cache.memberInfo = { ...member, id: member.id, name: member.display_name || member.name, phone: member.phone, phone_format: member.phone_format, email: member.email, points: member.points, tier: member.tier, card_no: member.card_no ?? "", membership_status: member.membership_status ?? "", nett_to_next_tier: member.nett_to_next_tier ?? "", available_rewards: member.available_rewards ?? 0, customer_code: member.customer_code };
        localStorage.setItem("member_info", JSON.stringify({ ...member, id: member.id, name: member.display_name || member.name, phone: member.phone_format, points: member.points, tier: member.tier, card_no: member.card_no ?? "", customer_code: member.customer_code }));
        if (member.card_no) await fetchAndCacheAscentisVouchers(member.card_no);
        const count = getVoucherCount();
        if (count > 0) {
            const voucherCount = document.getElementById('availableVoucherCount');
            const voucherBanner = document.getElementById('voucherBanner');
            if (voucherCount) voucherCount.textContent = count;
            if (voucherBanner) voucherBanner.style.display = 'flex';
        }
        updateVoucherUI();
        console.log("✅ Member logged in:", member.display_name || member.name);
        return { success: true, member };
    } else {
        console.log("⚠️ Member not found");
        return { success: false, error: res?.error || "Member not found" };
    }
}

export async function getStoreRegisterSettings() {
    try {
        const storeName = localStorage.getItem("storename") ?? "";
        const registerName = localStorage.getItem("registername") ?? "POS01";
        const response = await fetch(`/api/crm/GetStoreRegisterSettings?storename=${encodeURIComponent(storeName)}&registername=${encodeURIComponent(registerName)}`, { method: "GET", headers: { "Content-Type": "application/json" } });
        const json = await response.json();
        if (!response.ok) { console.error("❌ GetStoreRegisterSettings Error:", json); return { success: false, error: json }; }
        console.log("✅ Store register settings loaded:", json.data);
        const cache = useCache();
        cache.storeRegisterSettings = json.data;
        return { success: true, data: json.data };
    } catch (err) { console.error("❌ Network error:", err); return { success: false, error: err.message }; }
}

export async function handleMemberLogin(event) {
    if (event) event.preventDefault();
    const phoneInput = document.getElementById('phoneNumber');
    if (!phoneInput) { console.error('❌ Phone input not found'); return false; }
    const phoneNumber = phoneInput.value.trim();
    if (!/^\d{8}$/.test(phoneNumber)) { showLoginError('Please enter a valid 8-digit phone number'); return false; }

    const loginBtn = event?.target.querySelector('button[type="submit"]');
    const originalBtnText = loginBtn?.textContent || 'Login';
    if (loginBtn) { loginBtn.disabled = true; loginBtn.textContent = 'Verifying...'; }

    try {
        console.log('🔐 Verifying member:', phoneNumber);
        const result = await verifyMemberLogin(phoneNumber);
        if (result.success && result.member) {
            const memberName = result.member.display_name || result.member.name || 'Member';
            showLoginSuccess(`Welcome back, ${memberName}!`);
            setTimeout(() => { closeLoginModal(); displayMemberBadge(result.member); updateOrderWithMemberInfo(result.member); showOrderTypeSelection(); }, 1500);
        } else {
            showLoginError('Member not found. Please check your phone number.');
            if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = originalBtnText; }
        }
    } catch (error) {
        console.error('❌ Login error:', error);
        showLoginError('Connection error. Please try again.');
        if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = originalBtnText; }
    }
    return false;
}

function showLoginSuccess(message) {
    const successMsg = document.getElementById('loginSuccessMessage');
    const errorMsg = document.getElementById('loginErrorMessage');
    if (successMsg) { successMsg.textContent = message; successMsg.style.display = 'block'; }
    if (errorMsg) errorMsg.style.display = 'none';
}

function showLoginError(message) {
    const successMsg = document.getElementById('loginSuccessMessage');
    const errorMsg = document.getElementById('loginErrorMessage');
    if (errorMsg) { errorMsg.textContent = message; errorMsg.style.display = 'block'; }
    if (successMsg) successMsg.style.display = 'none';
}

export function showLoginScreen() {
    const loginModal = document.getElementById('loginModal');
    const memberGuestSelection = document.getElementById('memberGuestSelection');
    if (loginModal) {
        if (memberGuestSelection) memberGuestSelection.style.display = 'none';
        loginModal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        setTimeout(() => { const phoneInput = document.getElementById('phoneNumber'); if (phoneInput) phoneInput.focus(); }, 300);
    }
}

export function closeLoginModal() {
    const loginModal = document.getElementById('loginModal');
    const memberGuestSelection = document.getElementById('memberGuestSelection');
    if (loginModal) { loginModal.style.display = 'none'; document.body.style.overflow = ''; if (memberGuestSelection) memberGuestSelection.style.display = 'flex'; }
}

export function proceedAsGuest() {
    console.log('👤 Proceeding as guest');
    const cache = useCache();
    cache.isMemberLoggedIn = false; cache.memberInfo = null; cache.currentMember = null;
    localStorage.removeItem('memberInfo');
    showOrderTypeSelection();
}

export function showOrderTypeSelection() {
    console.log('📋 Showing order type selection');
    const memberGuestSelection = document.getElementById('memberGuestSelection');
    const orderTypeSelection = document.getElementById('orderTypeSelection');
    if (memberGuestSelection) memberGuestSelection.style.display = 'none';
    if (orderTypeSelection) { orderTypeSelection.style.display = 'flex'; setTimeout(() => { attachOrderTypeHandlers(); console.log('✅ Order type handlers attached'); }, 100); }
}

export function attachOrderTypeHandlers() {
    if (window.__orderTypeHandlersAttached) return;
    window.__orderTypeHandlersAttached = true;
    const orderOptions = document.querySelectorAll('#orderTypeSelection .landing-option[data-type]');
    orderOptions.forEach((option) => {
        const newOption = option.cloneNode(true);
        option.parentNode.replaceChild(newOption, option);
        newOption.addEventListener('click', async function (e) {
            e.preventDefault();
            if (isSelectingOrderType) { console.warn('⏳ Order type selection in progress...'); return; }
            isSelectingOrderType = true;
            const currentOptions = document.querySelectorAll('#orderTypeSelection .landing-option[data-type]');
            currentOptions.forEach(opt => opt.style.pointerEvents = 'none');
            currentOptions.forEach(opt => opt.classList.remove('selected'));
            newOption.classList.add('selected');
            const selectedType = this.getAttribute('data-type');
            try {
                const written = setOrderType(selectedType);
                if (!written) { console.error('❌ Failed to persist orderType, aborting'); isSelectingOrderType = false; return; }
                await handleOrderTypeSelection(selectedType);
            } catch (err) { console.error('❌ Error selecting order type:', err); }
            finally { const finalOptions = document.querySelectorAll('#orderTypeSelection .landing-option[data-type]'); finalOptions.forEach(opt => opt.style.pointerEvents = ''); isSelectingOrderType = false; }
        });
    });
}

export async function handleOrderTypeSelection(type) {
    const _showShield = typeof showMenuLoadingShield === 'function' ? showMenuLoadingShield : window.showMenuLoadingShield;
    if (_showShield) _showShield();

    if (!localStorage.getItem('orderType')) {
        const domType = document.querySelector(`#orderTypeSelection .landing-option[data-type="${type}"]`)?.getAttribute('data-type') || document.querySelector('#orderTypeSelection .landing-option.selected')?.getAttribute('data-type') || type;
        localStorage.setItem('orderType', domType); localStorage.setItem('orderType_ts', Date.now().toString());
        console.warn('⚠️ orderType was missing — recovered from DOM:', domType);
    }

    setOrderType(type);
    const ws = window.sokWebSocket;
    console.log('📦 Processing order type:', type);
    localStorage.removeItem('active_cart');
    const isAbsorbTax = (type === 'T') ? "N" : "Y";
    const navSubtotal = document.getElementById('navSubtotal');
    const cartBadge = document.getElementById('cartBadge');
    const bottomNav = document.querySelector('.bottom-nav');
    if (navSubtotal) navSubtotal.textContent = '$0.00';
    if (cartBadge) { cartBadge.textContent = '0'; cartBadge.style.display = 'none'; }
    if (bottomNav) { bottomNav.classList.remove('show'); bottomNav.style.display = 'none'; }

    try { if (ws) await ws.clearOrderCache(true); } catch (err) { console.error("❌ Cache clear failed:", err); }
    setOrderType(type);
    console.log('🔒 orderType re-confirmed after cache clear:', localStorage.getItem('orderType'));

    const language = localStorage.getItem('selectedLang') || 'en';
    const { order, setOrder } = useOrder();
    if (order) setOrder({ ...order, order_type: type });

    if (typeof selectOrderType === 'function') {
        await selectOrderType(type, language, isAbsorbTax);
        if (typeof updateCartCount === 'function') updateCartCount();

        const hasFullItems = !!sessionStorage.getItem('FullItems');
        if (!hasFullItems) {
            console.warn('⚠️ FullItems missing after login — forcing menu reload');
            try { const { loadMenuItems } = await import('../js/GetHomeAPI.js'); if (typeof loadMenuItems === 'function') { await loadMenuItems(type, language); console.log('✅ FullItems reloaded'); } } catch (err) { console.warn('⚠️ Could not reload FullItems:', err); }
        }
        if (typeof updateCartCount === 'function') updateCartCount();
    }

    const finalType = localStorage.getItem('orderType');
    if (finalType !== type) { console.error(`❌ orderType mismatch! Expected "${type}", got "${finalType}" — forcing fix`); localStorage.setItem('orderType', type); localStorage.setItem('orderType_ts', Date.now().toString()); }
    else { console.log(`✅ orderType verified: "${finalType}"`); }
}

function setOrderType(type) {
    if (!type) { console.error('❌ setOrderType: no type provided'); return false; }
    const validTypes = ['T', 'D', 'Q'];
    if (!validTypes.includes(type)) console.warn(`⚠️ setOrderType: unexpected type "${type}"`);
    try {
        localStorage.setItem('orderType', type);
        const written = localStorage.getItem('orderType');
        if (written !== type) { console.error(`❌ setOrderType: write verification FAILED`); return false; }
        localStorage.setItem('orderType_ts', Date.now().toString());
        console.log(`✅ orderType confirmed: "${type}"`);
        return true;
    } catch (err) {
        console.error('❌ setOrderType: localStorage write failed:', err);
        try { sessionStorage.setItem('orderType', type); console.warn('⚠️ Fell back to sessionStorage for orderType'); } catch (e) { console.error('❌ sessionStorage fallback also failed:', e); }
        return false;
    }
}

export function updateOrderWithMemberInfo(memberData) {
    try {
        const { order, setOrder } = useOrder();
        if (order) { setOrder({ ...order, customer_code: memberData.id || memberData.customer_code, customer_name: memberData.display_name || memberData.name, customer_phone: memberData.phone || memberData.phone_format, customer_email: memberData.email || '', is_member: true, member_tier: memberData.tier || '', member_points: memberData.points || 0 }); console.log('✅ Order updated with member info'); }
    } catch (error) { console.error('❌ Error updating order with member info:', error); }
}

export function displayMemberBadge(memberData) {
    const headerInfo = document.querySelector('.header-info');
    if (!headerInfo) return;
    const existingBadge = headerInfo.querySelector('.member-badge');
    if (existingBadge) existingBadge.remove();
    const memberBadge = document.createElement('div');
    memberBadge.className = 'member-badge';
    const memberName = memberData.display_name || memberData.name || 'Member';
    const memberPoints = memberData.points || 0;
    const memberTier = memberData.tier || '';
    memberBadge.innerHTML = `
        <div class="member-info">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
            <div class="member-details"><span class="member-name">${memberName}</span>${memberTier ? `<span class="member-tier">${memberTier}</span>` : ''}</div>
        </div>
        ${memberPoints > 0 ? `<span class="member-points">${memberPoints} pts</span>` : ''}
        <button class="member-logout" onclick="window.handleMemberLogout()" title="Logout">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
        </button>`;
    headerInfo.insertBefore(memberBadge, headerInfo.firstChild);
    console.log('✅ Member badge displayed');
}

export function getMemberSession() {
    const cache = useCache();
    if (cache.isMemberLoggedIn && cache.memberInfo) return cache.memberInfo;
    const stored = localStorage.getItem("memberInfo");
    if (stored) { try { return JSON.parse(stored); } catch (e) { console.error("Failed to parse stored member info"); } }
    return null;
}

export function logoutMember(shouldRedirect = false) {
    console.log('👋 Logging out member...');
    const cache = useCache();
    cache.isMemberLoggedIn = false; cache.memberInfo = null; cache.currentMember = null; cache.memberRawData = null;
    ["memberInfo", "member_info", "memberSession", "memberVouchers", "memberName", "memberEmail", "memberPhone", "appliedCrmVouchers", "memberId", "memberPoints", "currentMember", "loggedInMember"].forEach(key => localStorage.removeItem(key));
    const voucherBanner = document.getElementById('voucherBanner');
    const voucherFab = document.getElementById('voucherFab');
    if (voucherBanner) voucherBanner.style.display = 'none';
    if (voucherFab) voucherFab.style.display = 'none';
    const memberBadge = document.querySelector('.member-badge');
    if (memberBadge) memberBadge.remove();
    console.log("✅ Member logged out completely");
    if (shouldRedirect) {
        const storeName = localStorage.getItem('storename');
        const deviceId = localStorage.getItem("sok_device_id");
        if (storeName && deviceId) { sessionStorage.setItem('intentional_reset', 'true'); window.location.replace(`/KIOSK/Home/${encodeURIComponent(storeName)}?device_id=${deviceId}`); }
        else { window.location.reload(); }
    }
}

export async function handleMemberLogout() {
    const confirmed = await showConfirm('Are you sure you want to logout? Your current session will be ended.', 'Logout Confirmation', { confirmText: 'Yes, Logout', cancelText: 'Cancel', danger: false });
    if (confirmed) { try { await logoutMember(true); showToast('Successfully logged out', 'success', 'Goodbye!'); } catch (error) { console.error('❌ Logout failed:', error); showToast('Failed to logout. Please try again.', 'error', 'Error'); } }
}

function showLandingScreen() {
    console.log('🏠 Showing landing screen');
    const landingOverlay = document.getElementById('landingOverlay');
    if (landingOverlay) { landingOverlay.style.display = 'flex'; landingOverlay.style.visibility = 'visible'; landingOverlay.style.opacity = '1'; }
    const memberGuestSelection = document.getElementById('memberGuestSelection');
    const orderTypeSelection = document.getElementById('orderTypeSelection');
    if (memberGuestSelection) memberGuestSelection.style.display = 'flex';
    if (orderTypeSelection) orderTypeSelection.style.display = 'none';
}

export function clearSessionOnPageLoad() {
    const perfData = performance.getEntriesByType('navigation')[0];
    const isRefresh = perfData && perfData.type === 'reload';
    if (isRefresh) { console.log('🔄 Page refreshed - clearing previous session'); logoutMember(); showLandingScreen(); }
    else { console.log('ℹ️ Page loaded - preserving session'); }
}

function checkExistingMemberSession() {
    console.log('🚀 Checking for existing member session...');
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('refresh')) {
        console.log('🔄 Fresh start detected - clearing member session');
        const cache = useCache();
        cache.isMemberLoggedIn = false; cache.memberInfo = null; cache.currentMember = null; cache.memberRawData = null;
        localStorage.removeItem('memberInfo'); localStorage.removeItem('memberSession'); localStorage.removeItem('memberVouchers');
        sessionStorage.clear(); voucherState.clear();
        const memberBadge = document.querySelector('.member-badge');
        if (memberBadge) memberBadge.remove();
        const voucherBanner = document.getElementById('voucherBanner');
        const voucherFab = document.getElementById('voucherFab');
        if (voucherBanner) voucherBanner.style.display = 'none';
        if (voucherFab) voucherFab.style.display = 'none';
        return;
    }
    const memberSession = getMemberSession();
    if (memberSession) { console.log('✅ Existing session found:', memberSession.name); displayMemberBadge(memberSession); updateOrderWithMemberInfo(memberSession); const landingOverlay = document.getElementById('landingOverlay'); if (landingOverlay) landingOverlay.style.display = 'none'; }
    else { console.log('👤 No existing member session'); }
}

document.addEventListener('DOMContentLoaded', function () { console.log('🚀 Checking for existing member session...'); checkExistingMemberSession(); });

// ============================================
// VOUCHER SELECT HANDLER
// ============================================
export function selectVoucher(voucher) {
    console.log('🎟️ Selecting voucher:', voucher.code);
    const order = window.orderData || useOrder?.getState?.()?.order || {};
    const voucherCard = document.querySelector(`[data-voucher-code="${voucher.code}"]`);

    if (order?.voucher_code === voucher.code) {
        showConfirm(`Are you sure you want to remove "${voucher.redeem_name || voucher.name}"?`, 'Remove Voucher', { confirmText: 'Yes, Remove', cancelText: 'Cancel', danger: true }).then(confirmed => { if (confirmed) removeVoucherAndRecalculate(); });
        return;
    }

    if (voucherCard) { const btn = voucherCard.querySelector('.voucher-select-btn'); if (btn) { btn.disabled = true; btn.textContent = 'Applying...'; } }
    voucherState.setLoading(voucher);

    applyVoucherAndRecalculate(voucher)
        .then(result => {
            if (result.success) {
                const voucherName = result.voucher?.name || voucher.name || voucher.redeem_name || 'Voucher';
                const { order } = useOrder();
                const discountAmount = parseFloat(order?.total_disc || result.discount || 0);
                const voucherType = result.voucher?.type || '';
                const isLegitZero = voucherType === 'FREE_ITEM';

                if (discountAmount === 0 && !isLegitZero) {
                    showToast('Add qualifying items before applying this voucher.', 'warning', 'No Discount Applied', 5000);
                    if (voucherCard) { const btn = voucherCard.querySelector('.voucher-select-btn'); if (btn) { btn.disabled = false; btn.textContent = 'Select Voucher'; } }
                    voucherState.clearLoading(); return;
                }

                voucherState.add(voucher);
                sendVoucherWS({ action: 'voucher_apply_result', success: true, voucherCode: voucher.code, voucherName, discount: discountAmount });
                closeVouchersModal();
                setTimeout(() => { showVoucherAppliedMessage(voucherName, discountAmount); }, 400);
            } else {
                if (voucherCard) { const btn = voucherCard.querySelector('.voucher-select-btn'); if (btn) { btn.disabled = false; btn.textContent = 'Select Voucher'; } }
                showVoucherError(result.error || 'Failed to apply voucher');
            }
            voucherState.clearLoading();
        })
        .catch(err => {
            console.error('❌ Error applying voucher:', err);
            if (voucherCard) { const btn = voucherCard.querySelector('.voucher-select-btn'); if (btn) { btn.disabled = false; btn.textContent = 'Select Voucher'; } }
            voucherState.clearLoading();
            showVoucherError('Failed to apply voucher. Please try again.');
        });
}

window.handleVoucherApply = async function (voucherCode) {
    const vouchers = getAvailableVouchers();
    const voucher = vouchers.find(v => v.code === voucherCode);
    if (!voucher) { showVoucherError('Voucher not found'); return; }

    const card = document.querySelector(`[data-voucher-code="${voucherCode}"]`);
    const btn = card?.querySelector('.voucher-apply');
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="btn-spinner"></span> Applying...`; }
    voucherState.setLoading(voucher);

    try {
        const result = await applyVoucherAndRecalculate(voucher);
        if (result.success) {
            const discount = result.discount || 0;
            const voucherType = result.voucher?.type || '';
            const isLegitZero = voucherType === 'FREE_ITEM';
            if (discount === 0 && !isLegitZero) { showToast('Add qualifying items before applying this voucher.', 'warning', 'No Discount Applied', 5000); if (btn) { btn.disabled = false; btn.textContent = 'Apply Voucher'; } return; }
            voucherState.add(voucher);
            const name = result.voucher?.name || voucher.name || voucher.redeem_name || 'Voucher';
            showVoucherAppliedMessage(name, discount);
            sendVoucherWS({ action: 'voucher_apply_result', success: true, voucherCode, discount });
            renderVouchersModal(getCurrentFilter());
            safeCall('renderCartFromOrder');
            safeCall('updateCartCount');
            setTimeout(() => closeVouchersModal(), 1500);
        } else {
            showVoucherError(result.error || 'Failed to apply voucher');
            if (btn) { btn.disabled = false; btn.textContent = 'Apply Voucher'; }
        }
    } catch (err) {
        console.error('❌ handleVoucherApply error:', err);
        showVoucherError('Failed to apply voucher. Please try again.');
        if (btn) { btn.disabled = false; btn.textContent = 'Apply Voucher'; }
    } finally { voucherState.clearLoading(); }
};

window.handleVoucherRemove = async function (voucherCode) {
    const vouchers = getAvailableVouchers();
    const voucher = vouchers.find(v => v.code === voucherCode);
    if (!voucher) { showToast('Voucher not found', 'error'); return; }
    const confirmed = await showVoucherRemovalConfirm(voucher.name);
    if (!confirmed) return;
    voucherState.setLoading(voucher);
    try {
        const result = await removeVoucherAndRecalculate(voucherCode);
        if (result.success) { voucherState.remove(voucherCode); safeCall('renderCartFromOrder'); safeCall('updateCartCount'); renderVouchersModal(getCurrentFilter()); showToast('Voucher removed successfully', 'success'); }
        else { showVoucherError(result.error || 'Failed to remove voucher'); }
    } catch (err) { console.error('❌ handleVoucherRemove error:', err); showVoucherError('Failed to remove voucher. Please try again.'); }
    finally { voucherState.clearLoading(); }
};

// ============================================
// ASCENTIS RUNTIME CONFIG
// ============================================
export const getAscentisRuntimeConfig = () => {
    const raw = localStorage.getItem("storeRegisterSettings");
    if (!raw) { console.warn("⚠️ storeRegisterSettings not found"); return null; }
    let settings;
    try { settings = JSON.parse(raw); } catch { console.warn("⚠️ storeRegisterSettings is invalid JSON"); return null; }
    if (!Array.isArray(settings)) { console.warn("⚠️ storeRegisterSettings is not an array"); return null; }
    const find = (mainGroup, groupName, code) => { const entry = settings.find(x => x?.main_group_name === mainGroup && x?.group_name === groupName && x?.setting_code === code); return entry?.setting_value ?? null; };
    const outletCode = find("CRM", "ASCENTIS", "Api_OutletCode");
    const posId = find("CRM", "ASCENTIS", "Api_PosID");
    const cashierId = find("CRM", "ASCENTIS", "Api_CashierID");
    const ignoreCCN = find("CRM", "ASCENTIS", "Api_IgnoreCCNchecking");
    const enquiryCode = find("CRM", "ASCENTIS", "Api_EnquiryCode");
    const instanceURL = find("CRM", "ASCENTIS", "InstanceURL");
    const tokenURL = find("CRM", "ASCENTIS", "Api_Token");
    if (!outletCode || !posId || !cashierId || !enquiryCode || !instanceURL || !tokenURL) { console.warn("⚠️ Ascentis config incomplete", { outletCode, posId, cashierId, enquiryCode, instanceURL, tokenURL }); return null; }
    return { outletCode, posId, cashierId, ignoreCCN, enquiryCode, instanceURL, tokenURL };
};

const buildAscentisTransactDetailLists = (sales_dtls) => {
    if (!Array.isArray(sales_dtls)) return [];
    const invalidRows = [];
    const items = sales_dtls
        .filter(i => String(i.s_no) === String(i.parent_sno))
        .map((i, index) => {
            const itemCode = i.item_no?.trim();
            const qty = Number(i.qty || 0);
            const children = sales_dtls.filter(c => String(c.parent_sno) === String(i.s_no) && String(c.s_no) !== String(i.s_no));
            const groupNett = children.reduce((sum, c) => sum + parseFloat(c.sub_total || 0), 0);
            const price = parseFloat(i.unit_price || 0) > 0 ? parseFloat(i.unit_price) * qty : groupNett;
            const discountPer = parseFloat(i.disc_amt || 0) + children.reduce((sum, c) => sum + parseFloat(c.pro_disc_amt || 0), 0);
            const nett = Math.max(0, price - discountPer);
            if (!itemCode) invalidRows.push({ reason: "Missing ItemCode", item: i });
            if (qty <= 0) invalidRows.push({ reason: "Invalid Qty", item: i });
            if (price < 0) invalidRows.push({ reason: "Invalid Price", item: i });
            return { Category_Code: i.category_code || "", ItemCode: itemCode, Description: i.item_name || i.item_desc || i.display_name || "", Qty: qty, Price: parseFloat(price.toFixed(2)), Points: null, DiscountPer: parseFloat(discountPer.toFixed(2)), Nett: parseFloat(nett.toFixed(2)), LineNo: index + 1, Ref1: i.modifier_name || "" };
        })
        .filter(x => x.ItemCode && x.Qty > 0);
    return { items, invalidRows };
};



export const postAscentisSales = async ({
    cache,
    orderSnapshot,
    ledgerSnapshot,
    sales_no,
}) => {
    try {
        const {
            outletCode,
            posId,
            cashierId,
            ignoreCCN,
            enquiryCode
        } = getAscentisRuntimeConfig(cache);

        const member =
            cache?.memberInfo ||
            cache?.member_info ||
            (() => {
                try {
                    const raw = localStorage.getItem('member_info') || localStorage.getItem('memberInfo');
                    return raw ? JSON.parse(raw) : null;
                } catch { return null; }
            })();
        console.log("memberInfo", member)
        const cardNo = member?.card_no || member?.CardNo;

        if (!cardNo) {
            console.log("ℹ️ No member card — skipping Ascentis sales post");
            return null;
        }

        // ─────────────────────────────
        // VOUCHERS
        // ─────────────────────────────
        const currentVoucherCode = orderSnapshot?.voucher_code;
        const redemptionVoucherLists = currentVoucherCode
            ? [{ VoucherNo: currentVoucherCode }]
            : (() => {
                const stored = JSON.parse(localStorage.getItem("appliedCrmVouchers") || "[]");
                return stored
                    .filter((v) => v.redeem_code || v.code)
                    .map((v) => ({ VoucherNo: v.redeem_code || v.code }));
            })();

        // ✅ REMOVED: Separate PostAscentisVoucherRedemption pre-call
        // Voucher redemption is handled atomically by the SALES command below.
        // Calling it separately before Sales caused double-redemption:
        // the voucher was consumed in the pre-call, then the Sales post
        // tried to redeem it again → CRM found it already used → PointsRebateValue: 0

        // ─────────────────────────────
        // DATE / AMOUNT
        // ─────────────────────────────
        const transactDate = new Date()
            .toISOString()
            .replace("T", " ")
            .substring(0, 19);

        const transactTime = transactDate.split(" ")[1] || "";

        const salesAmt = parseFloat(
            orderSnapshot?.net_amt ||
            orderSnapshot?.total_net ||
            0
        );

        console.log('💰 Ascentis sales amounts:', {
            sub_total: orderSnapshot?.sub_total,
            total_disc: orderSnapshot?.total_disc,
            net_amt: orderSnapshot?.net_amt,
            voucher: orderSnapshot?.voucher_code,
            cross_check: (
                parseFloat(orderSnapshot?.sub_total || 0) -
                parseFloat(orderSnapshot?.total_disc || 0)
            ).toFixed(2),
        });

        // ─────────────────────────────
        // TRANSACTION DETAILS
        // ─────────────────────────────
        const { items: transactDetailLists, invalidRows } =
            buildAscentisTransactDetailLists(orderSnapshot?.sales_dtls || []);

        if (invalidRows.length > 0) {
            console.error("❌ Ascentis validation failed:", invalidRows);
            return { success: false, error: "Invalid Ascentis payload", invalidRows };
        }

        // ─────────────────────────────
        // PAYMENT DETAILS
        // ─────────────────────────────
        const paymentList = ledgerSnapshot.map((p, index) => ({
            Type: p.payment_type,
            Mode: p.payment_name,
            Value: Math.min(
                parseFloat(p.tender_amt || p.PaymentAmt || 0),
                salesAmt
            ).toFixed(2),
            Currency: "SGD",
            Ref1: p.ref_info,
            Ref2: "",
            Ref3: "",
            Ref4: "",
            Ref5: "",
            Ref6: "",
            Ref7: "",
            LineNo: index + 1,
            CurRate: 0,
            ForeignCurrency: "",
            ForeignCurrencyValue: 0,
            CardName: "",
        }));

        // ─────────────────────────────
        // FINAL PAYLOAD
        // ─────────────────────────────
        const ascentisPayload = {
            EnquiryCode: enquiryCode,
            OutletCode: outletCode,
            PosID: posId,
            CashierID: cashierId,
            IgnoreCCNchecking: ignoreCCN,
            Command: "SALES",
            IsOffline: false,
            CardNo: cardNo,
            CVC: "",
            ReceiptNo: sales_no,
            TransactDate: transactDate,
            OriginalDate: transactDate,
            TransactTime: transactTime,
            SalesAmt: salesAmt,
            SalesAmtToCalculatePoints: salesAmt,
            SalesAmtToCalculateAR: 0,
            TierCodeToAwardPoints: "",
            PointsToBeAwarded: null,
            RedemptionVoucherLists: redemptionVoucherLists, // ✅ Sales command redeems this atomically
            TransactDetailLists: transactDetailLists,
            IsRebateSystem: false,
            RebateUsage: "",
            RebateToBeDeducted: 0,
            RebateToBeDeductedFromGrace: 0,
            CheckReceiptNoDuplication: true,
            CheckOutletCodeDuplication: true,
            CheckOriginalDateDuplication: true,
            PaymentList: paymentList,
            RunCampaign: true,
            CampaignType: "Sales Campaign",
            CampaignCode: "",
            CheckQualificationRules: true,
            RewardFor: "",
            RetrieveMembershipInfo: true,
            RetrieveActiveVouchersLists: false,
            SendPtsRbtsRedemptionNotification: false,
            FilterBy_VoucherNo: "",
            FilterBy_VoucherType: "",
            FilterBy_ValidFrom: "2021-05-11T14:09:53",
            FilterBy_ValidTo: "2021-05-11T14:09:53",
            FilterBy_TriggerSource: "",
            SortOrder: "ASC",
            SortBy_VoucherNo: false,
            SortBy_VoucherType: false,
            SortBy_ValidFrom: false,
            SortBy_ValidTo: true,
            PageNumber: 1,
            PageCount: 99,
            Remarks: "",
            SendPushNotificationOnSuccess: false,
            Sound: "",
            Badge: null,
            Ref1: localStorage.getItem("storename") || "",
            Ref2: localStorage.getItem("orderType") || "",
            Ref3: "",
            Ref4: "",
            Ref5: "",
            Ref6: "",
            Ref7: "",
            RetrieveReceiptMessage: true,
        };

        console.log("📤 FULL ASCENTIS PAYLOAD:", JSON.stringify(ascentisPayload, null, 2));

        // ─────────────────────────────
        // API CALL
        // ─────────────────────────────
        const response = await fetch("/api/crm/PostAscentisSales", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(ascentisPayload),
        });

        const ascentisResult = await response.json();
        console.log("📥 ASCENTIS RESPONSE:", JSON.stringify(ascentisResult, null, 2));

        // ─────────────────────────────
        // RESULT HANDLING
        // ─────────────────────────────
        if (
            ascentisResult?.success ||
            ascentisResult?.data?.ReturnStatus === 1 ||  // ✅
            ascentisResult?.ReturnStatus === 1            // ✅
        ) {
            console.log("✅ Ascentis sales posted successfully");
            localStorage.removeItem("appliedCrmVouchers");

            const refreshCardNo = member?.card_no || member?.CardNo;
            if (refreshCardNo && typeof fetchAndCacheAscentisVouchers === 'function') {
                fetchAndCacheAscentisVouchers(refreshCardNo)
                    .then(() => {
                        if (typeof updateVoucherUI === 'function') updateVoucherUI();
                        console.log('✅ Voucher list refreshed after sale');
                    })
                    .catch(e => console.warn('⚠️ Voucher refresh failed:', e));
            }

            return ascentisResult;
        }

        console.error(
            "❌ Ascentis post failed:",
            ascentisResult?.data?.ReturnMessage ||
            ascentisResult?.ReturnMessage
        );
        return ascentisResult;

    } catch (e) {
        console.error("❌ Ascentis sales post error:", e);
        return null;
    }
};

// ============================================
// CRM API FUNCTIONS
// ============================================
async function redeemEberVoucherInternal(params = {}) {
    const storeName = localStorage.getItem("storename");
    if (!storeName) return { success: false, error: 'Store not initialized' };
    let eberpayload = params?.info?.eberpayload || {};
    eberpayload = { ...eberpayload, custom_store_id: storeName };
    try {
        const response = await fetch(`/api/eber/integration/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eberpayload, ...params }) });
        if (!response.ok) { const e = await response.json(); throw new Error(e.message || 'Failed to redeem voucher'); }
        const result = await response.json();
        console.log('✅ Voucher redeemed successfully:', result);
        return { success: true, ...result };
    } catch (error) { console.error('❌ Redeem voucher error:', error); return { success: false, error: error.message }; }
}

async function redeemAscentisVoucher(params = {}) {
    try {
        const cache = useCache();
        const member = cache.memberInfo;
        const { order } = useOrder();
        if (!member?.card_no) return { success: false, error: 'No card number found' };
        const voucherCode = params?.info?.eberpayload?.redeem_code;
        const receiptNo = order?.receipt_no || `VCH-${Date.now()}`;
        const response = await fetch(`/api/crm/sales`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ CardNo: member.card_no, ReceiptNo: receiptNo, SalesAmt: 0, SalesAmtToCalculatePoints: 0, RedemptionVoucherLists: [{ VoucherNo: voucherCode }], TransactDetailLists: [], PaymentList: [], RunCampaign: true, CampaignType: "Sales Campaign", CheckReceiptNoDuplication: false }) });
        const json = await response.json();
        if (!response.ok || !json.success) return { success: false, error: json.error || 'Failed to redeem voucher' };
        console.log('✅ Ascentis voucher redeemed:', voucherCode);
        return { success: true, ...json.data };
    } catch (error) { console.error('❌ Ascentis redeem error:', error); return { success: false, error: error.message }; }
}

async function voidEberVoucherInternal(params = {}) {
    const sessionid = sessionStorage.getItem("sessionid");
    const eberpayload = params?.info?.eberpayload || {};
    try {
        const response = await fetch(`/api/eber/integration/used_issued_reward/void?sessionid=${sessionid}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eberpayload, ...params }) });
        if (!response.ok) { const e = await response.json(); throw new Error(e.message || 'Failed to void voucher'); }
        const result = await response.json();
        console.log('✅ Voucher voided successfully:', result);
        return { success: true, ...result };
    } catch (error) { console.error('❌ Void voucher error:', error); return { success: false, error: error.message }; }
}

async function voidAscentisVoucher(params = {}) {
    try {
        const cache = useCache();
        const member = cache.memberInfo;
        const { order } = useOrder();
        const response = await fetch(`/api/crm/voiding`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ CardNo: member?.card_no, OriginalReceiptNo: order?.receipt_no, VoidTransactionType: "SALES", RunCampaign: true, CampaignType: "Downgrade Campaign" }) });
        const json = await response.json();
        if (!response.ok || !json.success) return { success: false, error: json.error };
        console.log('✅ Ascentis voucher voided');
        return { success: true, ...json.data };
    } catch (error) { console.error('❌ Ascentis void error:', error); return { success: false, error: error.message }; }
}

async function issueEberPointsInternal(params = {}) {
    const sessionid = sessionStorage.getItem("sessionid");
    const eberpayload = params?.info?.eberpayload || {};
    try {
        const response = await fetch(`/api/eber/integration/issue_point?sessionid=${sessionid}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eberpayload, ...params }) });
        if (!response.ok) { const e = await response.json(); throw new Error(e.message || 'Failed to issue points'); }
        const result = await response.json();
        console.log('✅ Points issued successfully:', result);
        return { success: true, ...result };
    } catch (error) { console.error('❌ Issue points error:', error); return { success: false, error: error.message }; }
}

async function issueAscentisPoints(params = {}) {
    try {
        const cache = useCache();
        const member = cache.memberInfo;
        const { order } = useOrder();
        if (!member?.card_no) return { success: false, error: 'No card number found' };
        const receiptNo = order?.receipt_no || params?.receipt_no || `POS-${Date.now()}`;
        const salesAmt = params?.amount || order?.net_amt || 0;
        const response = await fetch(`/api/crm/sales`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ CardNo: member.card_no, ReceiptNo: receiptNo, SalesAmt: parseFloat(salesAmt), SalesAmtToCalculatePoints: parseFloat(salesAmt), PointsCalculationType: 1, TransactDetailLists: params?.items || [], PaymentList: params?.payments || [], RunCampaign: true, CampaignType: "Sales Campaign", CheckReceiptNoDuplication: true }) });
        const json = await response.json();
        if (!response.ok || !json.success) return { success: false, error: json.error || 'Failed to issue points' };
        console.log('✅ Ascentis points issued');
        return { success: true, ...json.data };
    } catch (error) { console.error('❌ Ascentis issue points error:', error); return { success: false, error: error.message }; }
}

export async function redeemEberVoucher(params = {}) { const vendor = getCRMVendor(); console.log(`🎟️ redeemEberVoucher via ${vendor}`); return vendor === "Ascentis" ? redeemAscentisVoucher(params) : redeemEberVoucherInternal(params); }
export async function voidEberVoucherTransaction(params = {}) { const vendor = getCRMVendor(); console.log(`🗑️ voidEberVoucherTransaction via ${vendor}`); return vendor === "Ascentis" ? voidAscentisVoucher(params) : voidEberVoucherInternal(params); }
export async function issueEberPoints(params = {}) { const vendor = getCRMVendor(); console.log(`⭐ issueEberPoints via ${vendor}`); return vendor === "Ascentis" ? issueAscentisPoints(params) : issueEberPointsInternal(params); }

// ============================================
// LEGACY EBER VOUCHER APPLY (backward compat)
// ============================================
async function applyVoucherToOrder(voucher) {
    console.log('💳 Applying voucher (legacy):', voucher.redeem_code || voucher.code);
    if (!voucher) return { success: false, error: 'Voucher missing' };
    const { order, setOrder } = useOrder();
    if (!order?.sales_dtls?.length) { console.warn('⚠️ Cannot apply voucher to empty cart'); return { success: false, error: 'Cart is empty' }; }

    const voucherAmount = parseFloat(voucher.pos_redeem_amount || 0);
    if (!voucherAmount) {
        console.log('🎁 Verify-only reward voucher, no price impact');
        setOrder({ ...order, reward_voucher: { code: voucher.redeem_code, name: voucher.reward?.name } });
        return { success: true, voucher, discountAmount: 0 };
    }

    const normalisedVoucher = { ...voucher, code: voucher.redeem_code || voucher.code, name: voucher.reward?.name || voucher.redeem_name || voucher.name || 'Voucher', pos_redeem_amount: voucherAmount, posRedeemAmount: voucherAmount };
    const result = await applyVoucherAndRecalculate(normalisedVoucher);
    if (!result.success) { console.warn('⚠️ applyVoucherToOrder: delegation failed:', result.error); return { success: false, error: result.error, discountAmount: 0 }; }

    const { order: updatedOrder } = useOrder();
    const discountAmount = parseFloat(updatedOrder?.total_disc || 0);
    const voucherRow = document.getElementById('voucher-discount-row');
    if (voucherRow) { voucherRow.style.display = 'flex'; const labelEl = document.getElementById('voucher-discount-label'); const amountEl = document.getElementById('voucher-discount-amount'); if (labelEl) labelEl.textContent = normalisedVoucher.name; if (amountEl) amountEl.textContent = `-$${discountAmount.toFixed(2)}`; }
    const svcEl = document.getElementById('service-charge');
    const gstEl = document.getElementById('gst');
    const totalEl = document.getElementById('total');
    if (svcEl) svcEl.textContent = `$${updatedOrder?.total_svc || '0.00'}`;
    if (gstEl) gstEl.textContent = `$${updatedOrder?.total_tax || '0.00'}`;
    if (totalEl) totalEl.textContent = `$${updatedOrder?.net_amt || '0.00'}`;
    return { success: true, voucher, discountAmount };
}

// ============================================
// CLEAR APPLIED VOUCHER
// ============================================
window.clearAppliedVoucher = function () {
    voucherState.clear();
    try { localStorage.removeItem('appliedCrmVouchers'); } catch (e) { console.warn('⚠️ Failed to clear appliedCrmVouchers:', e); }
    window._voucherApplying = false;
    window._voucherRemovedAt = null;
    window._voucherRemovedCode = null;
    try {
        const { order, setOrder } = useOrder();
        if (order?.voucher_code) {
            const clearedItems = (order.sales_dtls || []).map(item => ({ ...item, pro_disc_amt: '0.00', disc_amt: '0.00', disc_type: '', disc_name: 'None', disc_value: 0 }));
            setOrder({ ...order, sales_dtls: clearedItems, voucher_code: undefined, voucher_name: undefined, voucher_discount: undefined, voucher_type: undefined, voucher_meta: undefined, total_disc: '0.00' });
            console.log('🧹 clearAppliedVoucher: voucher cleared from order store');
        }
    } catch (e) { console.warn('⚠️ clearAppliedVoucher: failed to clear order store:', e); }
    console.log('🧹 clearAppliedVoucher: all voucher state cleared');
};

// ============================================
// EVENT LISTENERS
// ============================================
document.addEventListener('DOMContentLoaded', function () {
    const overlay = document.getElementById('vouchersModalOverlay');
    if (overlay) { overlay.addEventListener('click', function (e) { if (e.target === this) closeVouchersModal(); }); }
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeVouchersModal(); });
window.addEventListener('memberLoggedIn', () => { updateVoucherUI(); });

// ============================================
// GLOBAL EXPORTS
// ============================================
window.getCRMVendor = getCRMVendor;
window.setCRMVendor = setCRMVendor;
window.getMemberByPhone = getMemberByPhone;
window.callAscentisMemberByPhone = callAscentisMemberByPhone;
window.showOrderTypeSelection = showOrderTypeSelection;
window.attachOrderTypeHandlers = attachOrderTypeHandlers;
window.handleOrderTypeSelection = handleOrderTypeSelection;
window.handleMemberLogin = handleMemberLogin;
window.clearSessionOnPageLoad = clearSessionOnPageLoad;
window.proceedAsGuest = proceedAsGuest;
window.selectVoucher = selectVoucher;
window.openVouchersModal = openVouchersModal;
window.closeVouchersModal = closeVouchersModal;
window.renderVouchersModal = renderVouchersModal;
window.filterVouchers = filterVouchers;
window.updateVoucherFilterCounts = updateVoucherFilterCounts;
window.applyVoucherAndRecalculate = applyVoucherAndRecalculate;
window.removeVoucherAndRecalculate = removeVoucherAndRecalculate;
window.handleMemberLogout = handleMemberLogout;
window.applyVoucherToOrder = applyVoucherToOrder;
window.getVoucherInfo = getVoucherInfo;
window.showVoucherAppliedMessage = showVoucherAppliedMessage;
window.logoutMember = logoutMember;
window.invalidateVoucherCache = invalidateVoucherCache;
window.issueEberPoints = issueEberPoints;
window.redeemEberVoucher = redeemEberVoucher;
window.voidEberVoucherTransaction = voidEberVoucherTransaction;
window.getStoreRegisterSettings = getStoreRegisterSettings;

// ============================================
// DEFAULT EXPORT
// ============================================
export default {
    getCRMVendor, setCRMVendor, getMemberByPhone, getEberMemberByPhone, callAscentisMemberByPhone,
    fetchAndCacheAscentisVouchers, getAvailableVouchers, getVouchersByType, getVoucherCount,
    selectVoucher, openVouchersModal, closeVouchersModal, renderVouchersModal,
    voucherState, attachOrderTypeHandlers, proceedAsGuest, getVoucherInfo,
    applyVoucherAndRecalculate, removeVoucherAndRecalculate, applyVoucherToOrder,
    redeemEberVoucher, voidEberVoucherTransaction, issueEberPoints,
};

// ============================================
// INITIALIZATION
// ============================================
(function initializeEberModule() {
    console.log('🚀 Initializing ascentisCRM.js module...');
    const criticalFunctions = ['clearSessionOnPageLoad', 'attachOrderTypeHandlers', 'handleOrderTypeSelection', 'handleMemberLogin', 'proceedAsGuest', 'showOrderTypeSelection'];
    const missing = criticalFunctions.filter(fn => typeof window[fn] !== 'function');
    if (missing.length > 0) console.error('❌ Missing functions:', missing);
    else console.log('✅ All functions exported successfully');
    console.log(`🏪 CRM Vendor: ${getCRMVendor()}`);
    window.eberReady = true;
    window.dispatchEvent(new CustomEvent('eberModuleReady', { detail: { timestamp: Date.now() } }));
})();