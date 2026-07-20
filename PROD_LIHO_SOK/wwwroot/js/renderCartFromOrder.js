/// <reference path="printing.js" />
import { useCache } from '../stores/cache-store.js';
import { useOrder, useOrderStore } from '../stores/order-store.js';
import { uiTranslations } from './Translation.js';

//import {
//    handleMemberLogin,
//    clearSessionOnPageLoad,
//    attachOrderTypeHandlers,
//    handleOrderTypeSelection,
//    proceedAsGuest,
//    showOrderTypeSelection,
//    removeVoucherAndRecalculate
//} from '../utils/eber.js';

import {
    handleMemberLogin,
    clearSessionOnPageLoad,
    attachOrderTypeHandlers,
    handleOrderTypeSelection,
    proceedAsGuest,
    showOrderTypeSelection,
    removeVoucherAndRecalculate
} from '../utils/ascentisCRM.js';

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
    postOrder
} from './netApi.js';

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
    getItemImageUrl,
    addToCart,
    updateCartCount,
    showAddOnModalOriginal,
    groupItemsByTemperature,
    getItemTemperature,
    resolveImageUrl,
    getTranslatedName,
    preloadCartImages,
    emptyCart
} from './GetHomeAPI.js';

// ── Debounce ──────────────────────────────────────────────────────────────────
let renderDebounceTimer = null;
const RENDER_DEBOUNCE_MS = 50;

// ── Voucher registry ──────────────────────────────────────────────────────────
window._voucherLockedSnos = window._voucherLockedSnos || new Set();
window._voucherRegistrySealed = window._voucherRegistrySealed || false;

// =============================================================================
// renderCartFromOrder
// =============================================================================
export function renderCartFromOrder(forceImmediate = false) {
    // Don't overwrite voucher modal content while it's open
    if (document.getElementById('vouchersModalOverlay')?.classList.contains('active')) {
        console.log('⏭️ renderCartFromOrder skipped — voucher modal is open');
        return;
    }


    if (renderDebounceTimer && !forceImmediate) {
        clearTimeout(renderDebounceTimer);
    }
    if (forceImmediate) {
        _renderCartFromOrderInternal();
        requestAnimationFrame(() => {
            patchVoucherLockedCartItems();
            console.log('🔒 patchVoucherLockedCartItems called (forceImmediate)');
        });
    } else {
        renderDebounceTimer = setTimeout(() => {
            renderDebounceTimer = null;
            _renderCartFromOrderInternal();
            requestAnimationFrame(() => {
                patchVoucherLockedCartItems();
                console.log('🔒 patchVoucherLockedCartItems called (debounced)');
            });
        }, RENDER_DEBOUNCE_MS);
    }
}

window.updateBottomNavVisibility = updateBottomNavVisibility;

function updateCartSummary(order, gstRate, serviceRate) {
    const subtotal = parseFloat(order.sub_total || 0);
    const serviceCharge = parseFloat(order.total_svc || 0);
    const gst = parseFloat(order.total_tax || 0);
    const totalDiscount = parseFloat(order.total_disc || 0);

    const finalTotal = parseFloat(order.net_amt || 0);

    const isTaxAbsorbed =
        order.absorb_tax === 'Y' ||
        order.absorb_tax === 'true' ||
        order.absorb_tax === true ||
        order.is_absorbtax === 1 ||
        order.is_absorbtax === "1" ||
        (order.sales_dtls || []).some(i =>
            i.is_absorbtax === 1 || i.is_absorbtax === '1'
        );

    const taxAbsorbInfo = order.absorb_tax_info || '';
    const voucherCode = order.voucher_code || '';
    const voucherName = order.voucher_name || '';
    const voucherType = order.voucher_type || '';
    const isFreeItem = voucherType === 'FREE_ITEM';
    let voucherDiscount = 0;
    if (voucherCode) {
        if (totalDiscount > 0) {
            voucherDiscount = totalDiscount;
        } else if (isFreeItem) {
            voucherDiscount = (order.sales_dtls || []).reduce((sum, item) => {
                const da = parseFloat(item.disc_amt || 0);
                const dn = (item.disc_name || '').trim();
                return (da > 0 && dn && dn === voucherName) ? sum + da : sum;
            }, 0);
        }
    }

    // ── Bill-level / TD promo discount ────────────────────────────────────────
    let discountAmount = parseFloat(order.discount_amt || 0);
    if (discountAmount === 0 && order.sales_dtls?.length > 0) {
        discountAmount = order.sales_dtls.reduce((sum, item) => {
            if (parseFloat(item.disc_value || 0) === 100) return sum;
            return sum + parseFloat(item.disc_amt || 0);
        }, 0);
    }
    if (voucherCode) discountAmount = 0;

    // ── Original subtotal (before any discounts) ──────────────────────────────
    const originalSubtotal = subtotal + totalDiscount + discountAmount;

    console.log('📊 Final Summary:', {
        originalSubtotal,
        subtotal,
        discount: discountAmount,
        voucherDiscount,
        serviceCharge,
        gst,
        finalTotal,
        voucherCode,
        voucherName,
        voucherType,
        isTaxAbsorbed,
    });

    // ── Cart subtotal (shows original price before discounts) ─────────────────
    const cartTotal = document.getElementById('cartTotal');
    if (cartTotal) {
        const displaySubtotal = isTaxAbsorbed
            ? finalTotal + totalDiscount + discountAmount
            : originalSubtotal;
        cartTotal.textContent = `$${displaySubtotal.toFixed(2)}`;
    }

    // ── Bill discount row ─────────────────────────────────────────────────────
    const discountAmountRow = document.getElementById('discount-amount-row');
    if (discountAmountRow) {
        discountAmountRow.style.display = discountAmount > 0 ? 'flex' : 'none';
        const discountAmountEl = document.getElementById('discount-amount');
        if (discountAmountEl) discountAmountEl.textContent = `-$${discountAmount.toFixed(2)}`;
    }

    // ── Voucher discount row ──────────────────────────────────────────────────
    const voucherDiscountRow = document.getElementById('voucher-discount-row');
    if (voucherDiscountRow) {
        const hasVoucher = !!voucherCode && (voucherDiscount > 0 || isFreeItem);
        voucherDiscountRow.style.display = hasVoucher ? 'flex' : 'none';

        if (hasVoucher) {
            const nameEl = voucherDiscountRow.querySelector('.voucher-name');
            if (nameEl) nameEl.textContent = voucherName || 'Voucher';

            const voucherDiscountAmount = document.getElementById('voucher-discount-amount');
            if (voucherDiscountAmount) {
                if (voucherDiscount > 0) {
                    voucherDiscountAmount.textContent = `-$${voucherDiscount.toFixed(2)}`;
                    voucherDiscountAmount.style.color = '#16a34a';
                    voucherDiscountAmount.style.fontSize = '14px';
                    voucherDiscountAmount.style.fontWeight = '700';
                } else if (isFreeItem) {
                    voucherDiscountAmount.textContent = '🎁 Free item at counter';
                    voucherDiscountAmount.style.color = '#16a34a';
                    voucherDiscountAmount.style.fontSize = '11px';
                    voucherDiscountAmount.style.fontWeight = '600';
                } else {
                    voucherDiscountAmount.textContent = 'Applied';
                    voucherDiscountAmount.style.color = '#16a34a';
                    voucherDiscountAmount.style.fontSize = '';
                    voucherDiscountAmount.style.fontWeight = '';
                }
            }

            const removeBtn = document.getElementById('remove-voucher-btn');
            if (removeBtn) {
                removeBtn.style.display = 'flex';
                removeBtn.onclick = () => window.handleVoucherRemove(voucherCode);
            }
        } else {
            const removeBtn = document.getElementById('remove-voucher-btn');
            if (removeBtn) removeBtn.style.display = 'none';
        }
    }

    // ── Item discount row ─────────────────────────────────────────────────────
    const totalDiscountRow = document.getElementById('total-discount-row');
    if (totalDiscountRow) {
        const itemDiscounts = Math.max(0, totalDiscount - voucherDiscount - discountAmount);
        totalDiscountRow.style.display = itemDiscounts > 0 ? 'flex' : 'none';
        const totalDiscountAmount = document.getElementById('total-discount-amount');
        if (totalDiscountAmount) totalDiscountAmount.textContent = `-$${itemDiscounts.toFixed(2)}`;
    }

    // ── Service charge ────────────────────────────────────────────────────────
    const serviceChargeEl = document.getElementById('service-charge');
    if (serviceChargeEl) {
        serviceChargeEl.textContent = `$${serviceCharge.toFixed(2)}`;
        const serviceChargeRow = serviceChargeEl.closest('.cart-total-row');
        if (serviceChargeRow) {
            serviceChargeRow.style.display = serviceCharge > 0 ? 'flex' : 'none';
        }
    }

    // ── GST ───────────────────────────────────────────────────────────────────
    const gstElement = document.getElementById('gst');
    if (gstElement) gstElement.textContent = `$${gst.toFixed(2)}`;

    const gstRow = document.querySelector('#gst')?.closest('.cart-total-row');
    const gstLabelElement = gstRow?.querySelector('.cart-total-label');
    if (gstLabelElement) {
        const gstRateEl = document.getElementById('gst-rate');
        const currentRate = gstRateEl ? gstRateEl.textContent : gstRate;
        if (isTaxAbsorbed) {
            gstLabelElement.innerHTML = `GST (<span id="gst-rate">${currentRate}</span>%) <span class="tax-absorbed-badge" title="${taxAbsorbInfo}">Inclusive</span>:`;
        } else {
            gstLabelElement.innerHTML = `GST (<span id="gst-rate">${currentRate}</span>%):`;
        }
    }

    // ── Grand total ───────────────────────────────────────────────────────────
    const totalEl = document.getElementById('total');
    if (totalEl) totalEl.textContent = `$${finalTotal.toFixed(2)}`;

    const navSubtotalEl = document.getElementById('navSubtotal');
    if (navSubtotalEl) navSubtotalEl.textContent = `$${finalTotal.toFixed(2)}`;

    // ── Rate labels ───────────────────────────────────────────────────────────
    const gstRateEl = document.getElementById('gst-rate');
    const svcRateEl = document.getElementById('service-charge-rate');
    if (gstRateEl && !gstRateEl.textContent) gstRateEl.textContent = gstRate;
    if (svcRateEl && !svcRateEl.textContent) svcRateEl.textContent = serviceRate;

    // ── Checkout / empty cart buttons ─────────────────────────────────────────
    const hasItems = (order.sales_dtls || []).length > 0;

    const checkoutBtn = document.getElementById('checkout-btn');
    if (checkoutBtn) {
        checkoutBtn.disabled = !(subtotal > 0);
    }

    const emptyCartBtnEl = document.getElementById('empty-cart-btn');
    if (emptyCartBtnEl) {
        emptyCartBtnEl.disabled = !hasItems;
    }
}

// ============================================================
// _renderCartFromOrderInternal — full updated version
// ============================================================
function _renderCartFromOrderInternal() {
    if (window.isRenderingCart) {
        console.log('⏭️ Already rendering, will retry after completion');
        if (!window.renderCartPending) {
            window.renderCartPending = true;
            setTimeout(() => {
                window.renderCartPending = false;
                renderCartFromOrder(true);
            }, 150);
        }
        return;
    }

    window.isRenderingCart = true;
    let savedScroll = 0;

    try {
        const cartItemsContainer = document.getElementById('cartItems');
        savedScroll = cartItemsContainer?.scrollTop || 0;

        console.log('🔄 renderCartFromOrder called');

        const orderObj = useOrder();
        const gstRate = parseFloat(sessionStorage.getItem("GST")) || 9;
        const serviceRate = parseFloat(sessionStorage.getItem("ServiceCharge")) || 10;

        if (!orderObj || !orderObj.order) {
            console.warn('⚠️ No order found, rendering empty cart');
            renderEmptyCart();
            return;
        }

        const order = orderObj.order;
        const salesDtls = order.sales_dtls || [];

        if (!cartItemsContainer) {
            console.warn('⚠️ Cart items container not found');
            return;
        }

        const orderType = order.service_type || order.service_type_info || order.order_type || '';
        const lsOrderType = localStorage.getItem('orderType') || 'E';
        const isDineIn = orderType === 'E' || lsOrderType === 'E' || orderType.toLowerCase().includes('dine');

        const isChargeItem = (item) =>
            item.is_charge_item === 'Y' ||
            item.category_code === 'TAKEAWAY CHARGES' ||
            item.item_no === 'TAKEAWAY_CHARGE';

        // ── IMAGE MAP ─────────────────────────────────────────────────────────
        const imageMap = new Map();
        const restaurantLogo = RESTAURANT_CONFIG?.logo || '/img/LIHO-logo.jpg';

        const buildImageMapFromArray = (itemsArray, sourceName) => {
            if (!Array.isArray(itemsArray)) return 0;
            let count = 0;
            itemsArray.forEach(item => {
                const imageSource = item.tqr_image_url || item.item_image || item.image || '';
                if (!imageSource || imageSource.includes('Logo.png')) return;
                const finalUrl = imageSource.startsWith('public/upload/')
                    ? `/api/GetImageProxy?imageUrl=${encodeURIComponent(imageSource)}`
                    : imageSource;
                [item.item_no, item.product_code, item.product_no, item.item_id]
                    .forEach(id => { if (id) imageMap.set(String(id), finalUrl); });
                [item.item_desc, item.item_name, item.product_name]
                    .forEach(name => {
                        const key = String(name || '').trim().toLowerCase();
                        if (key) imageMap.set(key, finalUrl);
                    });
                count++;
            });
            console.log(`✅ [${sourceName}] indexed ${count} image references.`);
            return count;
        };

        // Replace the entire image map build block with this:
        try {
            // 1. Always index sessionStorage MenuItems (all categories, not just current)
            try {
                const ss = JSON.parse(sessionStorage.getItem('MenuItems') || '[]');
                buildImageMapFromArray(ss.flatMap(s => s.items || []), 'sessionStorage');
            } catch (e) { }

            // 2. Also index current menuGridItems (may have enriched data)
            if (Array.isArray(window.menuGridItems) && window.menuGridItems.length) {
                buildImageMapFromArray(window.menuGridItems, 'menuGridItems');
            }

            // 3. apiManager as additional source
            if (window.apiManager?.isLoaded('menuItems')) {
                const menuData = window.apiManager.loadedData.get('menuItems') || [];
                buildImageMapFromArray(menuData.flatMap(s => s.items || []), 'apiManager');
            }

            // 4. itemImageMap overlay
            if (window.itemImageMap?.size > 0) {
                window.itemImageMap.forEach((url, key) => {
                    if (!imageMap.has(String(key))) imageMap.set(String(key), url || restaurantLogo);
                });
            }
        } catch (err) {
            console.error("❌ Image map build failed:", err);
        }

        const getImageUrlForItem = (item) => {
            const rawUrl = item.tqr_image_url || item.item_image || item.image;
            if (rawUrl && rawUrl !== '' && !rawUrl.includes('Logo.png')) {
                return rawUrl.startsWith('public/upload/')
                    ? `/api/GetImageProxy?imageUrl=${encodeURIComponent(rawUrl)}`
                    : rawUrl;
            }
            const idKey = String(item.item_no || item.product_code || '');
            if (idKey && imageMap.has(idKey)) return imageMap.get(idKey);
            const nameKey = (item.item_desc || item.item_name || '').trim().toLowerCase();
            if (nameKey && imageMap.has(nameKey)) return imageMap.get(nameKey);
            return restaurantLogo;
        };

        window.globalImageMap = imageMap;
        if (typeof updateCartCount === 'function') updateCartCount();

        // ── LANGUAGE ──────────────────────────────────────────────────────────
        const selectedLang = window.selectedLang
            || sessionStorage.getItem('selectedLang')
            || localStorage.getItem('selectedLang')
            || 'en';

        // ── DEDUP + TRANSLATE ─────────────────────────────────────────────────
        const seen = new Set();
        const sales = salesDtls.filter(i => {
            const key = `${i.s_no ?? ''}-${i.item_no ?? ''}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        sales.forEach(item => {
            item.display_name = (typeof getTranslatedName === 'function')
                ? getTranslatedName(item.item_no, item.item_desc || item.item_name, selectedLang, "item")
                : (item.item_desc || item.item_name || 'Unknown Item');
        });

        const baseItems = sales.filter(i => String(i.s_no) === String(i.parent_sno || i.s_no));
        const addonRecords = sales.filter(i => String(i.s_no) !== String(i.parent_sno || i.s_no));

        if (!baseItems.length) { renderEmptyCart(); return; }

        const addonModal = document.getElementById('addonModal');
        if (!addonModal?.classList.contains('show') && !window.modalState?.isAnyOpen()) {
            showBottomNav();
        }
        enableCartButtons();

        // ── Voucher info from order ────────────────────────────────────────────
        const orderVoucherCode = order.voucher_code || '';
        const orderVoucherName = order.voucher_name || '';

        // ── BILL DISC HELPER ──────────────────────────────────────────────────
        const BILL_DISC_NAMES = ['bill discount', '% discount'];
        const isBillDisc = (name) => !!name
            && BILL_DISC_NAMES.some(n => (name || '').toLowerCase().includes(n));

        // ── RENDER ITEMS ──────────────────────────────────────────────────────
        cartItemsContainer.innerHTML = baseItems.map((item) => {
            const qty = Number(item.qty || 1);
            const childItems = addonRecords.filter(a => String(a.parent_sno) === String(item.s_no));
            const realChildItems = childItems.filter(c => !isChargeItem(c));
            const chargeItems = childItems.filter(c => isChargeItem(c));
            const imageUrl = getImageUrlForItem(item);

            const isModifierSet = Array.isArray(item.itemmaster_menutype_grpdtls)
                ? item.itemmaster_menutype_grpdtls.length > 0
                : Boolean(item.itemmaster_menutype_grpdtls);
            const isAddonSet = item.add_on_name?.trim().toUpperCase() === 'ADD ON';
            const isAlacarte = realChildItems.length === 0;

            const isMenuTypeC = item.menu_type === 'C'
                || realChildItems.some(c => c.modifier_name && c.modifier_name !== '');

            let displayPrice = 0;
            let mainItemPrice = 0;

            if (isMenuTypeC || isModifierSet) {
                displayPrice = realChildItems.reduce((sum, c) => sum + Number(c.sub_total ?? 0), 0);
            } else if (isAddonSet) {
                mainItemPrice = Number(
                    item.selling_uom_dtls?.[0]?.price_dtls?.[0]?.dine_in_price ||
                    item.selling_uom_dtls?.[0]?.price_dtls?.[0]?.takeaway_price ||
                    item.sub_total || 0
                );
                displayPrice = mainItemPrice + realChildItems.reduce((sum, c) => sum + Number(c.sub_total ?? 0), 0);
            } else {
                displayPrice = (Number(item.unit_price ?? 0) * qty)
                    + realChildItems.reduce((sum, c) => sum + Number(c.sub_total ?? 0), 0);
                mainItemPrice = displayPrice;
            }

            // ── Voucher discount amounts ──────────────────────────────────────
            const parentProDisc = parseFloat(item.pro_disc_amt || 0);
            const childProDiscTotal = realChildItems.reduce((s, c) => s + parseFloat(c.pro_disc_amt || 0), 0);

            const voucherProDiscAmt = parentProDisc + childProDiscTotal;

            const voucherDiscAmt =
                (parseFloat(item.disc_amt || 0) > 0 &&
                    parseFloat(item.pro_disc_amt || 0) === 0 &&
                    !isBillDisc(item.disc_name) &&
                    item.disc_name && item.disc_name !== 'None'
                    ? parseFloat(item.disc_amt || 0) : 0) +
                realChildItems.reduce((s, c) => {
                    const da = parseFloat(c.disc_amt || 0);
                    const pa = parseFloat(c.pro_disc_amt || 0);
                    const dn = c.disc_name || '';
                    if (pa > 0) return s;
                    return (da > 0 && dn && dn !== 'None' && !isBillDisc(dn)) ? s + da : s;
                }, 0);

            const totalVoucherDisc = voucherProDiscAmt + voucherDiscAmt;

            const isFullyFreeVoucher =
                (parseFloat(item.disc_value || 0) === 100 &&
                    item.disc_name !== 'None' &&
                    !isBillDisc(item.disc_name)) ||
                realChildItems.some(c =>
                    parseFloat(c.disc_value || 0) === 100 &&
                    c.disc_name && c.disc_name !== 'None' &&
                    !isBillDisc(c.disc_name)
                );

            const billDiscAmt = isFullyFreeVoucher ? 0
                : (isBillDisc(item.disc_name) ? parseFloat(item.disc_amt || 0) : 0)
                + realChildItems.reduce((s, c) =>
                    s + (isBillDisc(c.disc_name) ? parseFloat(c.disc_amt || 0) : 0), 0);

            const computeOriginalTotal = () => {
                if (isMenuTypeC || isModifierSet) {
                    return realChildItems.reduce((sum, c) =>
                        sum + Number(c.unit_price ?? 0) * Number(c.qty ?? 1), 0
                    );
                } else if (isAddonSet) {
                    const baseOrigPrice = mainItemPrice > 0
                        ? mainItemPrice
                        : (Number(item.unit_price ?? 0) * qty);
                    return baseOrigPrice + realChildItems.reduce((sum, c) =>
                        sum + Number(c.unit_price ?? 0) * Number(c.qty ?? 1), 0);
                } else {
                    return (Number(item.unit_price ?? 0) * qty) +
                        realChildItems.reduce((sum, c) =>
                            sum + Number(c.unit_price ?? 0) * Number(c.qty ?? 1), 0);
                }
            };

            const totalOriginal = (isMenuTypeC || isModifierSet)
                ? computeOriginalTotal()
                : isFullyFreeVoucher
                    ? computeOriginalTotal()
                    : displayPrice + voucherDiscAmt;

            const remainingCharged = (isMenuTypeC || isModifierSet)
                ? Math.max(0, totalOriginal - voucherProDiscAmt)
                : isFullyFreeVoucher
                    ? realChildItems
                        .filter(c => {
                            const cDV = parseFloat(c.disc_value || 0);
                            return cDV !== 100 || !c.disc_name || c.disc_name === 'None' || isBillDisc(c.disc_name);
                        })
                        .reduce((sum, c) => sum + Number(c.unit_price ?? 0) * Number(c.qty ?? 1), 0)
                    : displayPrice - voucherProDiscAmt;

            const priceHtml = (totalVoucherDisc > 0 || isFullyFreeVoucher)
                ? `<div class="cart-item-price">
                       <span class="cart-item-original-price">$${totalOriginal.toFixed(2)}</span>
                       <span class="cart-item-discounted-price">$${Math.max(0, remainingCharged).toFixed(2)}</span>
                   </div>`
                : `<div class="cart-item-price">
                       <span class="cart-item-price-value">$${displayPrice.toFixed(2)}</span>
                   </div>`;

            const voucherBadgeHtml = (totalVoucherDisc > 0 && orderVoucherCode)
                ? `<div class="cart-item-discount voucher-badge">
                       <span class="discount-icon">🎟️</span>
                       <span class="discount-label">${orderVoucherName || 'Voucher'}</span>
                       ${isFullyFreeVoucher
                    ? `<span class="discount-amount" style="color:#16a34a;">🎁 Free</span>`
                    : `<span class="discount-amount">-$${totalVoucherDisc.toFixed(2)}</span>`
                }
                   </div>`
                : '';

            const billDiscName = isBillDisc(item.disc_name)
                ? item.disc_name
                : realChildItems.find(c => isBillDisc(c.disc_name))?.disc_name || '';

            const itemDiscountHtml = (!isFullyFreeVoucher && billDiscAmt > 0 && billDiscName)
                ? `<div class="cart-item-discount">
                       <span class="discount-icon">🏷️</span>
                       <span class="discount-label">${billDiscName}</span>
                       <span class="discount-amount">-$${billDiscAmt.toFixed(2)}</span>
                   </div>`
                : '';

            const mainRemarks = item.remarks?.trim()
                ? item.remarks.split(',').map(r => r.trim()).filter(Boolean)
                : [];

            const modsHtml = (realChildItems.length > 0 || chargeItems.length > 0) ? `
                <div class="cart-modifications">
                    ${isAddonSet && realChildItems.length > 0
                    ? `<div class="cart-modification-row">
                               <span class="cart-modification-name" style="font-weight:500;">Base Item</span>
                               <span class="cart-modification-qty-spacer"></span>
                               <span class="cart-modification-price">$${(isFullyFreeVoucher && mainItemPrice === 0
                        ? Number(item.unit_price ?? 0) * qty
                        : mainItemPrice).toFixed(2)
                    }</span>
                           </div>`
                    : ''}
                    ${realChildItems.map(c => {
                        const cDiscAmt = parseFloat(c.disc_amt || 0);
                        const cDiscName = c.disc_name || '';
                        const cSubTotal = Number(c.sub_total || 0);
                        const cProDiscAmt = parseFloat(c.pro_disc_amt || 0);

                        // ✅ FIX: LD voucher sets disc_amt on child for display but pro_disc_amt=0
                        // (parent row carries pro_disc_amt for calcOrderAmt totals).
                        // Detect this case and exclude it from upsize-split logic.
                        const isLDVoucherChildDisc = cDiscAmt > 0 &&
                            cProDiscAmt === 0 &&
                            cDiscName && cDiscName !== 'None' &&
                            !isBillDisc(cDiscName) &&
                            orderVoucherCode !== '';

                        const cHasUpsizeDisc = cDiscAmt > 0 &&
                            cProDiscAmt === 0 &&
                            cDiscName && cDiscName !== 'None' &&
                            !isBillDisc(cDiscName) &&
                            !isLDVoucherChildDisc;  // ✅ exclude LD voucher child rows

                        const cOriginalPrice = cSubTotal + (cHasUpsizeDisc ? cDiscAmt : 0);
                        const cDisplayPrice = (isFullyFreeVoucher && cSubTotal === 0 && c.unit_price > 0)
                            ? Number(c.unit_price) * Number(c.qty || 1)
                            : cSubTotal;

                        let modPriceHtml;
                        if (cProDiscAmt >= cSubTotal && cSubTotal > 0) {
                            modPriceHtml = `<span style="color:#16a34a;font-weight:700;">FREE</span>`;
                        } else if (cProDiscAmt > 0 && cSubTotal > 0) {
                            modPriceHtml = `+$${cSubTotal.toFixed(2)} <span style="color:#16a34a;font-size:10px;font-weight:600;">(-$${cProDiscAmt.toFixed(2)})</span>`;
                        } else if (isLDVoucherChildDisc) {
                            // ✅ FIX: LD voucher child — show strikethrough original, paid price in single row
                            // disc_amt = discount amount, cSubTotal = price already reduced on server
                            // so original = cSubTotal + cDiscAmt, current = cSubTotal
                            const cAfterDisc = Math.max(0, cSubTotal - cDiscAmt);
                            modPriceHtml = `<s style="color:#9ca3af;font-size:10px;">+$${cSubTotal.toFixed(2)}</s> <span style="color:#16a34a;">+$${cAfterDisc.toFixed(2)}</span>`;
                        } else if (cHasUpsizeDisc && c.qty > 1) {
                            const upsizedPrice = (c.unit_price - cDiscAmt).toFixed(2);
                            const remainingQty = c.qty - 1;
                            const remainingPrice = (c.unit_price * remainingQty).toFixed(2);
                            modPriceHtml = `
                                <span style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;">
                                    <span>
                                        <s style="color:#9ca3af;font-size:10px;">+$${c.unit_price.toFixed(2)}</s>
                                        <span style="color:#16a34a;">+$${upsizedPrice}</span>
                                        <span style="color:#6b7280;font-size:10px;">×1 (upsized)</span>
                                    </span>
                                    <span>+$${remainingPrice}
                                        <span style="color:#6b7280;font-size:10px;">×${remainingQty} (original)</span>
                                    </span>
                                </span>`;
                        } else if (cHasUpsizeDisc) {
                            modPriceHtml = `<s style="color:#9ca3af;font-size:10px;">+$${cOriginalPrice.toFixed(2)}</s> <span style="color:#16a34a;">+$${cSubTotal.toFixed(2)}</span>`;
                        } else {
                            modPriceHtml = `+$${cDisplayPrice.toFixed(2)}`;
                        }

                        if (cHasUpsizeDisc && c.qty > 1) {
                            const upsizedPrice = (c.unit_price - cDiscAmt).toFixed(2);
                            const remainingPrice = (c.unit_price).toFixed(2);
                            const remainingQty = c.qty - 1;
                            return `
                            <div class="cart-modification-item">
                                <div class="cart-modification-row">
                                    <span class="cart-modification-prefix">+</span>
                                    <span class="cart-modification-name">${c.display_name}</span>
                                    <span class="cart-modification-qty">×1</span>
                                    <span class="cart-modification-price">
                                        <s style="color:#9ca3af;font-size:10px;">+$${c.unit_price.toFixed(2)}</s>
                                        <span style="color:#16a34a;">+$${upsizedPrice}</span>
                                    </span>
                                </div>
                                <div class="cart-modification-row">
                                    <span class="cart-modification-prefix">+</span>
                                    <span class="cart-modification-name">${c.display_name}</span>
                                    <span class="cart-modification-qty">×${remainingQty}</span>
                                    <span class="cart-modification-price">+$${remainingPrice}</span>
                                </div>
                            </div>`;
                        } else {
                            return `
                            <div class="cart-modification-item">
                                <div class="cart-modification-row">
                                    <span class="cart-modification-prefix">+</span>
                                    <span class="cart-modification-name">${c.display_name}</span>
                                    ${c.qty > 1
                                    ? `<span class="cart-modification-qty">×${c.qty}</span>`
                                    : `<span class="cart-modification-qty-spacer"></span>`}
                                    <span class="cart-modification-price">${modPriceHtml}</span>
                                </div>
                            </div>`;
                        }
                    }).join('')}
                    ${chargeItems.map(c => `
                        <div class="cart-modification-row">
                            <span class="cart-modification-prefix">+</span>
                            <span class="cart-modification-name">${c.item_desc || c.item_name}</span>
                            <span class="cart-modification-qty-spacer"></span>
                            <span class="cart-modification-price">+$${Number(c.sub_total || 0).toFixed(2)}</span>
                        </div>`).join('')}
                </div>` : '';

            return `
                <div class="cart-item-card">
                    <div class="cart-item-main">
                        <div class="cart-item-header">
                            <img src="${imageUrl}"
                                 alt="${item.display_name}"
                                 class="cart-item-image"
                                 loading="eager" fetchpriority="high"
                                 onerror="this.onerror=null;this.src='${restaurantLogo}';">
                            <div class="cart-item-details">
                                <div class="cart-item-title">
                                    <span class="cart-item-qty">${qty}x</span>
                                    <span class="cart-item-name">${item.display_name}</span>
                                </div>
                                ${priceHtml}
                            </div>
                        </div>
                        ${mainRemarks.length > 0
                    ? `<div class="cart-item-remarks">
                                   ${mainRemarks.map(r => `<span class="remark-tag">${r}</span>`).join('')}
                               </div>`
                    : ''}
                        ${modsHtml}
                        ${itemDiscountHtml}
                        ${voucherBadgeHtml}
                    </div>
                    <div class="cart-item-actions">
                        <div class="cart-qty-controls">
                            <button class="cart-qty-btn"
                                    onclick="GetHomeAPI.updateQuantityBySno('${item.s_no}', -1)">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" stroke-width="3">
                                    <line x1="5" y1="12" x2="19" y2="12"/>
                                </svg>
                            </button>
                            <span class="cart-qty-display">${qty}</span>
                            <button class="cart-qty-btn"
                                    onclick="GetHomeAPI.updateQuantityBySno('${item.s_no}', 1)">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" stroke-width="3">
                                    <line x1="12" y1="5" x2="12" y2="19"/>
                                    <line x1="5" y1="12" x2="19" y2="12"/>
                                </svg>
                            </button>
                        </div>
                        <div class="cart-action-buttons">
                    ${!isAlacarte
                    ? `<button class="cart-action-btn cart-edit-btn"
                               ${orderVoucherCode
                        ? `disabled style="opacity:0.4;cursor:not-allowed;" title="Remove voucher to edit"`
                        : `onclick="GetHomeAPI.editItem('${item.s_no}','${item.item_no}')"`}>
                           <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                                stroke="currentColor" stroke-width="2">
                               <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                               <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                           </svg>
                           Edit
                       </button>`
                    : ''}
                            <button class="cart-action-btn cart-remove-btn" data-sno="${item.s_no}">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" stroke-width="2">
                                    <polyline points="3 6 5 6 21 6"/>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                </svg>
                                Remove
                            </button>
                        </div>
                    </div>
                </div>`;
        }).join('');

        updateCartSummary(order, gstRate, serviceRate);

        requestAnimationFrame(() => {
            if (cartItemsContainer && savedScroll > 0) cartItemsContainer.scrollTop = savedScroll;
            patchVoucherLockedCartItems();
            console.log('🔒 patchVoucherLockedCartItems called');
        });

    } finally {
        window.isRenderingCart = false;
        console.log('🔓 Render lock released');
    }
}

// =============================================================================
// updateBottomNavVisibility
// =============================================================================
export function updateBottomNavVisibility() {
    const bottomNav = document.querySelector('.bottom-nav');
    if (!bottomNav) {
        console.warn('⚠️ Bottom nav element not found');
        return;
    }

    // ✅ Also check addonModal DOM directly — modalState may lag behind
    const addonModal = document.getElementById('addonModal');
    const addonModalOpen = addonModal?.classList.contains('show');

    const shouldHideForModal = window.modalState?.successOpen
        || window.modalState?.addonOpen
        || window.modalState?.cartOpen  // ✅ hide behind cart modal too
        || addonModalOpen;              // ✅ direct DOM truth

    console.log('🔍 Bottom nav check:', {
        cartOpen: window.modalState?.cartOpen,
        addonOpen: window.modalState?.addonOpen,
        successOpen: window.modalState?.successOpen,
        addonModalDirect: addonModalOpen,
        shouldHideForModal
    });

    if (shouldHideForModal) {
        bottomNav.classList.remove('show');
        bottomNav.style.removeProperty('display');
        console.log('🚫 Bottom nav hidden - blocking modal open');
        return;
    }

    let hasCartItems = false;
    try {
        const orderObj = useOrder();
        const items = orderObj?.order?.sales_dtls || [];
        hasCartItems = items.some(item => item && item.item_no && item.qty > 0);
        console.log('📦 useOrder check:', { totalItems: items.length, hasValidItems: hasCartItems });
    } catch (err) {
        console.warn('⚠️ Error calling useOrder:', err);
        const cartItemsEl = document.getElementById('cartItems');
        hasCartItems = cartItemsEl && !cartItemsEl.querySelector('.empty-cart');
        console.log('🔍 DOM fallback check:', { hasItems: hasCartItems });
    }

    if (hasCartItems) {
        bottomNav.classList.add('show');
        bottomNav.style.removeProperty('display');

        console.log('✅ Bottom nav shown - has items');
    } else {
        bottomNav.classList.remove('show');
        bottomNav.classList.add('hide');

        bottomNav.style.removeProperty('display');
    }
}

// =============================================================================
// renderEmptyCart
// =============================================================================
function renderEmptyCart() {
    const cartItemsContainer = document.getElementById('cartItems');
    if (!cartItemsContainer) return;

    cartItemsContainer.innerHTML = `
        <div class="empty-cart">
            <div class="empty-cart-text">Your cart is empty</div>
            <div class="empty-cart-subtext">Select items from the menu to get started!</div>
        </div>`;

    ['cartTotal', 'service-charge', 'gst', 'total'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '$0.00';
    });

    const serviceChargeRateElement = document.getElementById("service-charge-rate");
    if (serviceChargeRateElement) {
        try {
            const storedServices = JSON.parse(sessionStorage.getItem("ServiceCharges") || "[]");
            const orderType = localStorage.getItem("orderType") || '';
            const isDineIn = ['dine in', 'dinein', 'dine-in'].includes(orderType.toLowerCase());
            const targetServiceType = isDineIn ? 'E' : 'T';
            const matchingService = storedServices.find(s => s.service_type === targetServiceType);
            serviceChargeRateElement.textContent = matchingService
                ? parseFloat(matchingService.service_value) || 10
                : 10;
        } catch (err) {
            console.error('❌ Failed to reset service charge rate:', err);
            serviceChargeRateElement.textContent = 10;
        }
    }

    ['discount-amount', 'voucher-discount-amount', 'total-discount-amount'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '$0.00';
    });

    ['voucher-discount-row', 'total-discount-row', 'discount-amount-row'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });

    const checkoutBtn = document.getElementById('checkout-btn');
    if (checkoutBtn) checkoutBtn.disabled = true;

    const emptyCartBtn = document.getElementById('empty-cart-btn');
    if (emptyCartBtn) emptyCartBtn.disabled = true;

    const bottomNav = document.querySelector('.bottom-nav');
    if (bottomNav) {
        bottomNav.classList.remove('show');
        bottomNav.style.display = 'none';
        bottomNav.style.transform = 'translateY(100%)';
    }

    const menuSection = document.querySelector('.menu-section');
    if (menuSection && window.matchMedia('(max-width: 767px)').matches) {
        menuSection.style.paddingBottom = '0px';
    }
}

// =============================================================================
// showBottomNav / enableCartButtons
// =============================================================================
function showBottomNav() {
    // ✅ Hard block — never show while wizard/addon modal is open
    const addonModal = document.getElementById('addonModal');
    if (addonModal?.classList.contains('show') || window.modalState?.isAnyOpen()) {
        console.log('⏭️ showBottomNav skipped — modal is open');
        return;
    }

    const bottomNav = document.querySelector('.bottom-nav');
    if (bottomNav) {
        bottomNav.classList.remove('hide', 'hidden');
        // Remove all inline style overrides — let CSS class control display
        bottomNav.style.removeProperty('display');
        bottomNav.style.removeProperty('transform');
        bottomNav.style.removeProperty('visibility');
        bottomNav.style.removeProperty('opacity');
        bottomNav.style.removeProperty('animation');
        console.log('✅ Bottom nav shown');
    }

    const menuSection = document.querySelector('.menu-section');
    if (menuSection && window.matchMedia('(max-width: 767px)').matches) {
        menuSection.style.paddingBottom = '100px';
    }
}

function enableCartButtons() {
    const { order } = useOrder?.() || {};
    const subtotal = parseFloat(order?.sub_total || 0);
    const hasItems = (order?.sales_dtls || []).some(i =>
        String(i.s_no) === String(i.parent_sno || i.s_no)
    );

    const checkoutBtn = document.getElementById('checkout-btn');
    if (checkoutBtn) {
        // ✅ Only enable if subtotal > 0
        checkoutBtn.disabled = !(subtotal > 0 && hasItems);
    }

    const emptyCartBtn = document.getElementById('empty-cart-btn');
    if (emptyCartBtn) {
        emptyCartBtn.disabled = !hasItems;
    }
}



// =============================================================================
// Empty Cart Modal  (DOMContentLoaded)
// =============================================================================
document.addEventListener('DOMContentLoaded', function () {
    if (window.__emptyCartModalInit) return;
    window.__emptyCartModalInit = true;

    const emptyCartBtn = document.getElementById('empty-cart-btn');
    const emptyCartModal = document.getElementById('emptyCartModalOverlay');
    const cancelBtn = document.getElementById('cancelEmptyCart');
    const confirmBtn = document.getElementById('confirmEmptyCart');

    if (!emptyCartBtn || !emptyCartModal) {
        console.error('❌ Empty cart elements not found');
        return;
    }

    function resetConfirmButton() {
        if (!confirmBtn) return;
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Empty Cart';
    }

    function openEmptyCartModal() {
        if (emptyCartModal.classList.contains('active')) return;
        emptyCartModal.classList.add('active');
        document.body.style.overflow = 'hidden';
        resetConfirmButton();
        console.log('🗑️ Empty cart modal opened');
    }

    function closeEmptyCartModal() {
        if (!emptyCartModal.classList.contains('active')) return;
        emptyCartModal.classList.remove('active');
        document.body.style.overflow = 'auto';
        resetConfirmButton();
        console.log('❌ Empty cart modal closed');
    }

    function clearAllCartState() {
        localStorage.removeItem("order");
        // Clear voucher registry (Doc 1 addition)
        window._voucherLockedSnos?.clear();
        window._voucherRegistrySealed = false;
        console.log('🧹 Voucher registry cleared and unsealed');
        if (typeof window.clearAppliedVoucher === 'function') window.clearAppliedVoucher();
        if (typeof updateCartCount === 'function') updateCartCount();
        console.log('🧹 All cart state cleared');
    }

    function resetCartUI() {
        const cartItemsContainer =
            document.querySelector('.cart-items-container') ||
            document.querySelector('.cart-items') ||
            document.getElementById('cart-items') ||
            document.getElementById('cartItems');

        if (cartItemsContainer) {
            cartItemsContainer.innerHTML = `
                <div class="empty-cart">
                    <div class="empty-cart-text">Your cart is empty</div>
                    <div class="empty-cart-subtext">Select items from the menu to get started!</div>
                </div>`;
        }

        [{ id: 'cartTotal', value: '$0.00' }, { id: 'service-charge', value: '$0.00' },
        { id: 'gst', value: '$0.00' }, { id: 'total', value: '$0.00' }]
            .forEach(({ id, value }) => {
                const el = document.getElementById(id);
                if (el) el.textContent = value;
            });

        ['voucher-discount-row', 'total-discount-row'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });

        const checkoutBtn = document.getElementById('checkout-btn');
        if (checkoutBtn) checkoutBtn.disabled = true;

        const emptyCartBtnRef = document.getElementById('empty-cart-btn');
        if (emptyCartBtnRef) emptyCartBtnRef.disabled = true;

        const bottomNav = document.querySelector('.bottom-nav');
        if (bottomNav) {
            bottomNav.classList.remove('show');
            bottomNav.style.display = 'none';
            bottomNav.style.transform = 'translateY(100%)';
        }

        const menuSection = document.querySelector('.menu-section');
        if (menuSection && window.matchMedia('(max-width: 767px)').matches) {
            menuSection.style.paddingBottom = '0px';
        }

        console.log('🎨 Cart UI reset to empty state');
    }

    emptyCartBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        const orderObj = useOrder?.();
        if (!orderObj || !orderObj.order || !orderObj.order.sales_dtls?.length) {
            window.sokWebSocket?.showUpdateNotification?.("Cart Empty", "Your cart is already empty");
            return;
        }
        openEmptyCartModal();
    });

    cancelBtn?.addEventListener('click', function (e) {
        e.stopPropagation();
        closeEmptyCartModal();
    });

    confirmBtn?.addEventListener('click', async function (e) {
        e.stopPropagation();
        if (confirmBtn.disabled) return;

        try {
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Clearing...';

            const orderObj = useOrder?.();
            if (!orderObj || !orderObj.order) {
                console.warn('⚠️ No order found');
                closeEmptyCartModal();
                resetConfirmButton();
                return;
            }

            const salesDtls = orderObj.order.sales_dtls || [];
            if (!salesDtls.length) {
                console.warn('⚠️ No items in cart');
                closeEmptyCartModal();
                resetConfirmButton();
                return;
            }

            console.log(`🗑️ Emptying cart with ${salesDtls.length} items...`);
            const result = await emptyCart();
            if (!result.success) throw new Error('Failed to empty cart');

            clearAllCartState();
            await new Promise(resolve => setTimeout(resolve, 100));
            resetCartUI();

            window.sokWebSocket?.showUpdateNotification?.("Cart Cleared", "All items removed successfully");
            closeEmptyCartModal();

            setTimeout(() => {
                if (typeof closeCartModal === 'function') closeCartModal();
            }, 300);

            console.log('✅ Cart emptied successfully');

        } catch (error) {
            console.error("❌ Error emptying cart:", error);
            window.sokWebSocket?.showUpdateNotification?.("Clear Error", "Failed to empty cart. Please try again.");
            resetConfirmButton();
        }
    });

    emptyCartModal.addEventListener('click', function (e) {
        if (e.target === emptyCartModal) closeEmptyCartModal();
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && emptyCartModal.classList.contains('active')) closeEmptyCartModal();
    });

    console.log('✅ Empty cart modal initialized');
});

// =============================================================================
// Error Modal
// =============================================================================
export function showErrorModal(title, message, technicalDetails = null, onRetry = null) {
    const overlay = document.getElementById('errorModalOverlay');
    const titleEl = document.getElementById('errorModalTitle');
    const messageEl = document.getElementById('errorModalMessage');
    const detailsSection = document.getElementById('errorDetails');
    const detailsContent = document.getElementById('errorDetailsContent');
    const retryBtn = document.getElementById('retryBtn');
    const closeBtn = document.getElementById('errorCloseBtn');

    if (!overlay) {
        console.error('❌ Error modal not found in DOM');
        alert(`${title}\n\n${message}`);
        return;
    }

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;

    if (detailsSection && detailsContent) {
        if (technicalDetails) {
            detailsSection.style.display = 'block';
            detailsContent.textContent = technicalDetails;
        } else {
            detailsSection.style.display = 'none';
        }
    }

    if (retryBtn) {
        if (onRetry && typeof onRetry === 'function') {
            retryBtn.style.display = 'flex';
            retryBtn.onclick = () => { closeErrorModal(); onRetry(); };
        } else {
            retryBtn.style.display = 'none';
        }
    }

    if (closeBtn) closeBtn.onclick = closeErrorModal;

    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    console.log('🚨 Error modal shown:', { title, message });
}

export function closeErrorModal() {
    const overlay = document.getElementById('errorModalOverlay');
    if (!overlay) return;
    overlay.classList.remove('active');
    document.body.style.overflow = 'auto';
    const detailsSection = document.getElementById('errorDetails');
    if (detailsSection) detailsSection.classList.remove('expanded');
    console.log('✅ Error modal closed');
}

document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('errorModalOverlay');
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeErrorModal();
        });
    }
});



//export function showSuccessModal(orderDetails) {
//    console.log("showSuccessModal", orderDetails);

//    let sales_no, orderData, orderResult, paymentMethod, paymentAmount, transactionId;
//    if (typeof orderDetails === 'object' && orderDetails.sales_no) {
//        sales_no = orderDetails.sales_no;
//        orderData = orderDetails.orderData;
//        orderResult = orderDetails.orderResult;
//        paymentMethod = orderDetails.paymentMethod;
//        paymentAmount = orderDetails.paymentAmount;
//        transactionId = orderDetails.transactionId;
//    } else {
//        sales_no = orderDetails;
//    }

//    const primaryColor = RESTAURANT_CONFIG?.color || '#22c55e';
//    const restaurantLogo = RESTAURANT_CONFIG?.logo || '/img/default-logo.png';

//    // Update order number in header
//    const orderNumberEl = document.getElementById('orderNumber');
//    if (orderNumberEl) {
//        orderNumberEl.textContent = sales_no || `#${String(orderCounter).padStart(3, '0')}`;
//    }

//    // Get the scrollable body container
//    const orderDetailsContainer = document.getElementById('orderDetailsContainer');
//    if (!orderDetailsContainer) {
//        console.error('Order details container not found');
//        const modal = document.getElementById('successModal');
//        modal.style.display = 'flex';
//        modal.classList.add('show');
//        return;
//    }

//    // Handle empty order data
//    if (!orderData || !orderData.sales_dtls) {
//        orderDetailsContainer.innerHTML = `
//            <div class="order-empty-state">
//                <svg class="order-empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" stroke-width="2">
//                    <circle cx="12" cy="12" r="10"></circle>
//                    <line x1="12" y1="8" x2="12" y2="12"></line>
//                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
//                </svg>
//                <p>No order details available.</p>
//            </div>
//        `;
//    } else {
//        // Load cached menu items
//        let MenuItems = [];
//        try {
//            const cached = getMenuItems();
//            if (Array.isArray(cached)) {
//                MenuItems = cached.flatMap(cat => cat.items || []);
//            }
//        } catch (err) {
//            console.error("Failed to retrieve MenuItems:", err);
//        }

//        // Group items by parent_sno
//        const groupedItems = new Map();
//        orderData.sales_dtls.forEach(item => {
//            const parentSno = String(item.parent_sno || item.s_no);
//            const currentSno = String(item.s_no);

//            if (parentSno === currentSno) {
//                // This is a parent item
//                groupedItems.set(parentSno, { parent: item, addons: [] });
//            } else {
//                // This is an addon
//                if (!groupedItems.has(parentSno)) {
//                    groupedItems.set(parentSno, { parent: null, addons: [] });
//                }
//                groupedItems.get(parentSno).addons.push(item);
//            }
//        });

//        // Get rates from session storage
//        const gstRate = parseFloat(sessionStorage.getItem("GST")) || 9;
//        const serviceRate = parseFloat(sessionStorage.getItem("ServiceCharge")) || 10;

//        // Calculate totals
//        const subtotal = parseFloat(orderData.sub_total || 0);
//        const discount = parseFloat(orderData.total_disc || 0);
//        const serviceCharge = parseFloat(orderData.total_svc || 0);
//        const gst = parseFloat(orderData.total_tax || 0);
//        const total = parseFloat(orderData.net_amt || 0);

//        // Preload all images before showing modal
//        const imageUrls = Array.from(groupedItems.values())
//            .filter(({ parent }) => parent)
//            .map(({ parent }) => getOrderItemImageUrl(parent) || restaurantLogo);

//        // ✅ Get payment method display name
//        const getPaymentMethodDisplay = (method) => {
//            if (!method) return 'Cash';
//            const methodMap = {
//                'nets': 'NETS Debit',
//                'nets-credit': 'NETS Credit',
//                'uob': 'UOB Credit',
//                'ocbc': 'OCBC Credit',
//                'a930': 'A930',
//                'cash': 'Cash'
//            };
//            return methodMap[method] || method.toUpperCase();
//        };

//        // ✅ Get payment icon
//        const getPaymentIcon = (method) => {
//            if (!method) return '💵';
//            const iconMap = {
//                'nets': '💳',
//                'nets-credit': '💳',
//                'uob': '🏛️',
//                'ocbc': '🏢',
//                'a930': '💰',
//                'cash': '💵'
//            };
//            return iconMap[method] || '💳';
//        };

//        // Build the order details HTML
//        const detailsHTML = `
//            <!-- Order Info Header -->
//            <div class="order-info-header" style="background: ${primaryColor};">
//                <div class="order-info-row">
//                    <span class="order-info-label">Date:</span>
//                    <strong class="order-info-value">${orderData.doc_date ? new Date(orderData.doc_date).toLocaleString() : new Date().toLocaleString()}</strong>
//                </div>
//                <div class="order-info-row">
//                    <span class="order-info-label">Payment:</span>
//                    <strong class="order-info-value">
//                        ${getPaymentIcon(paymentMethod)} ${getPaymentMethodDisplay(paymentMethod)}
//                    </strong>
//                </div>
//                ${transactionId ? `
//                    <div class="order-info-row">
//                        <span class="order-info-label">Transaction ID:</span>
//                        <strong class="order-info-value">${transactionId}</strong>
//                    </div>
//                ` : ''}
//            </div>

//            <!-- Order Items Section -->
//            <div class="order-items-section">
//                <h3 class="order-items-title">Order Items</h3>
//                <div class="order-items-grid">
//                    ${Array.from(groupedItems.values()).map(({ parent, addons }) => {
//            if (!parent) return '';

//            // Get item details
//            const imageUrl = getOrderItemImageUrl(parent) || restaurantLogo;
//            const itemName = parent.item_desc || parent.item_name || parent.product_name || 'Unknown Item';
//            //const itemName = parent.item_name || parent.product_name || 'Unknown Item';
//            const qty = parent.qty || 1;
//            const remarks = parent.remarks ? parent.remarks.trim() : '';

//            // For modifier-type items, parent sub_total is a placeholder —
//            // real price lives in children with modifier_name set.
//            const isModifierItem = parent.menu_type === 'C'
//                || addons.some(a => a.modifier_name && a.modifier_name !== '');

//            const addonTotal = addons.reduce((sum, addon) =>
//                sum + parseFloat(addon.sub_total || addon.amt || 0), 0
//            );
//            const price = isModifierItem ? 0 : parseFloat(parent.sub_total || parent.amt || 0);
//            const totalPrice = price + addonTotal;

//            return `
//                            <div class="order-item-card">
//                                <!-- Item Image -->
//                                <div class="order-item-image">
//                                    <div class="order-item-image-loader"></div>
//                                    <img
//                                        src="${imageUrl}"
//                                        alt="${itemName}"
//                                        loading="eager"
//                                        onload="this.style.opacity='1'; this.previousElementSibling.style.display='none';"
//                                        onerror="this.onerror=null; this.src='${restaurantLogo}'; this.style.opacity='1'; this.previousElementSibling.style.display='none';"
//                                        style="opacity: 0; transition: opacity 0.3s ease-in-out;"
//                                    />
//                                </div>

//                                <!-- Item Details -->
//                                <div class="order-item-details">
//                                    <!-- Item Header -->
//                                    <div class="order-item-header">
//                                        <div class="order-item-title">
//                                            <div class="order-item-name">
//                                                <span class="order-item-qty-badge" style="background:${primaryColor};">
//                                                    ${qty}×
//                                                </span>
//                                                ${itemName}
//                                            </div>
//                                        </div>
//                                        <div class="order-item-price" style="color:${primaryColor};">
//                                            $${totalPrice.toFixed(2)}
//                                        </div>
//                                    </div>

//                                    <!-- Item Remarks -->
//                                    ${remarks ? `
//                                        <div class="order-item-remarks">
//                                            💬 ${remarks}
//                                        </div>
//                                    ` : ''}

//                                    <!-- Addons -->
//                                    ${addons.length > 0 ? `
//                                        <div class="order-item-addons" style="border-left-color: ${primaryColor};">
//                                            ${addons.map(addon => {
//                                                //const addonName = addon.item_name || addon.product_name || 'Unknown';
//                                            const addonName = addon.item_desc || addon.item_name || addon.product_name || 'Unknown';

//                                            const addonQty = addon.qty || 1;
//                                            const addonPrice = parseFloat(addon.sub_total || addon.amt || 0);
//                                            const addonRemarks = addon.remarks ? addon.remarks.trim() : '';

//                                            return `
//                                                    <div class="order-addon-item">
//                                                        <span class="order-addon-prefix" style="color:${primaryColor};">+</span>
//                                                        <span class="order-addon-name">
//                                                            <strong>${addonName}</strong>${addonQty > 1 ? ` ×${addonQty}` : ''}
//                                                        </span>
//                                                        ${addonPrice > 0 ? `
//                                                            <span class="order-addon-price">+$${addonPrice.toFixed(2)}</span>
//                                                        ` : ''}
//                                                    </div>
//                                                    ${addonRemarks ? `
//                                                        <div class="order-addon-remarks">💬 ${addonRemarks}</div>
//                                                    ` : ''}
//                                                `;
//            }).join('')}
//                                        </div>
//                                    ` : ''}
//                                </div>
//                            </div>
//                        `;
//        }).join('')}
//                </div>
//            </div>

//            <!-- Price Summary -->
//            <div class="order-price-summary">
//                <div class="summary-row">
//                    <span class="summary-label">Subtotal:</span>
//                    <span class="summary-value">$${subtotal.toFixed(2)}</span>
//                </div>

//                ${discount > 0 ? `
//                    <div class="summary-row summary-discount">
//                        <span class="summary-label">Discount:</span>
//                        <span class="summary-value">−$${discount.toFixed(2)}</span>
//                    </div>
//                ` : ''}

//                <div class="summary-row">
//                    <span class="summary-label">Service Charge (${serviceRate}%):</span>
//                    <span class="summary-value">$${serviceCharge.toFixed(2)}</span>
//                </div>

//                ${gst >= 0 ? `
//                    <div class="summary-row">
//                        <span class="summary-label">GST (${gstRate}%):</span>
//                        <span class="summary-value">$${gst.toFixed(2)}</span>
//                    </div>
//                ` : ''}

//                <div class="summary-row summary-total" style="border-top-color: ${primaryColor};">
//                    <span class="summary-label">Total:</span>
//                    <span class="summary-value" style="color: ${primaryColor};">
//                        $${total.toFixed(2)}
//                    </span>
//                </div>

//                ${paymentMethod && paymentMethod !== 'cash' ? `
//                    <div class="summary-row summary-paid" style="background: ${primaryColor}15; border-color: ${primaryColor};">
//                        <span class="summary-label" style="color: ${primaryColor};">
//                            ${getPaymentIcon(paymentMethod)} Paid via ${getPaymentMethodDisplay(paymentMethod)}:
//                        </span>
//                        <span class="summary-value" style="color: ${primaryColor}; font-weight: 700;">
//                            $${total.toFixed(2)}  <!-- ← use total instead of paymentAmount -->
//                        </span>
//                    </div>
//                ` : ''}
//            </div>
//        `;

//        orderDetailsContainer.innerHTML = detailsHTML;

//        // Preload images for faster display
//        preloadImages(imageUrls);
//    }

//    // Show modal with animation
//    const modal = document.getElementById('successModal');
//    modal.style.display = 'flex';
//    setTimeout(() => modal.classList.add('show'), 10);

//    // Prevent body scroll
//    document.body.style.overflow = 'hidden';

//    // Scroll modal body to top
//    setTimeout(() => {
//        orderDetailsContainer.scrollTop = 0;
//    }, 50);

//    // Increment order counter
//    if (typeof orderCounter !== 'undefined') {
//        orderCounter++;
//    }

//    // Prevent closing modal by clicking outside
//    modal.onclick = (e) => {
//        if (e.target === modal) e.stopImmediatePropagation();
//    };
//}

export function showSuccessModal(orderDetails) {
    console.log("showSuccessModal", orderDetails);

    let sales_no, orderData, orderResult, paymentMethod,
        paymentAmount, transactionId, printingDone;

    if (typeof orderDetails === 'object' && orderDetails.sales_no) {
        sales_no = orderDetails.sales_no;
        orderData = orderDetails.orderData;
        orderResult = orderDetails.orderResult;
        paymentMethod = orderDetails.paymentMethod;
        paymentAmount = orderDetails.paymentAmount;
        transactionId = orderDetails.transactionId;
        printingDone = orderDetails.printingDone;
    } else {
        sales_no = orderDetails;
    }

    const primaryColor = RESTAURANT_CONFIG?.color || '#22c55e';
    const restaurantLogo = RESTAURANT_CONFIG?.logo || '/img/default-logo.png';

    const orderNumberEl = document.getElementById('orderNumber');
    if (orderNumberEl)
        orderNumberEl.textContent = sales_no || `#${String(orderCounter).padStart(3, '0')}`;

    const orderDetailsContainer = document.getElementById('orderDetailsContainer');
    if (!orderDetailsContainer) {
        console.error('Order details container not found');
        const modal = document.getElementById('successModal');
        if (modal) { modal.style.display = 'flex'; modal.classList.add('show'); }
        return;
    }

    if (!orderData || !orderData.sales_dtls) {
        orderDetailsContainer.innerHTML = `
            <div class="order-empty-state">
                <svg class="order-empty-icon" width="48" height="48" viewBox="0 0 24 24"
                     fill="none" stroke="#d1d5db" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <p>No order details available.</p>
            </div>`;
    } else {
        let MenuItems = [];
        try {
            const cached = typeof getMenuItems === 'function' ? getMenuItems() : null;
            if (Array.isArray(cached)) MenuItems = cached.flatMap(cat => cat.items || []);
        } catch (err) { console.error("Failed to retrieve MenuItems:", err); }

        const groupedItems = new Map();
        orderData.sales_dtls.forEach(item => {
            const parentSno = String(item.parent_sno || item.s_no);
            const currentSno = String(item.s_no);
            if (parentSno === currentSno) {
                groupedItems.set(parentSno, { parent: item, addons: [] });
            } else {
                if (!groupedItems.has(parentSno))
                    groupedItems.set(parentSno, { parent: null, addons: [] });
                groupedItems.get(parentSno).addons.push(item);
            }
        });

        const gstRate = parseFloat(sessionStorage.getItem("GST")) || 9;
        const serviceRate = parseFloat(sessionStorage.getItem("ServiceCharge")) || 10;
        const subtotal = parseFloat(orderData.sub_total || 0);
        const discount = parseFloat(orderData.total_disc || 0);
        const serviceCharge = parseFloat(orderData.total_svc || 0);
        const gst = parseFloat(orderData.total_tax || 0);
        const total = parseFloat(orderData.net_amt || 0);

        const imageUrls = Array.from(groupedItems.values())
            .filter(({ parent }) => parent)
            .map(({ parent }) =>
                (typeof getOrderItemImageUrl === 'function'
                    ? getOrderItemImageUrl(parent) : null) || restaurantLogo);

        const getPaymentMethodDisplay = method => {
            if (!method) return 'Cash';
            return ({
                nets: 'NETS Debit', 'nets-credit': 'NETS Credit',
                uob: 'UOB Credit', ocbc: 'OCBC Credit',
                a930: 'A930', cash: 'Cash'
            })[method] || method.toUpperCase();
        };
        const getPaymentIcon = method => {
            if (!method) return '💵';
            return ({
                nets: '💳', 'nets-credit': '💳',
                uob: '🏛️', ocbc: '🏢',
                a930: '💰', cash: '💵'
            })[method] || '💳';
        };

        orderDetailsContainer.innerHTML = `
            <div class="order-info-header" style="background:${primaryColor};">
                <div class="order-info-row">
                    <span class="order-info-label">Date:</span>
                    <strong class="order-info-value">
                        ${orderData.doc_date
                ? new Date(orderData.doc_date).toLocaleString()
                : new Date().toLocaleString()}
                    </strong>
                </div>
                <div class="order-info-row">
                    <span class="order-info-label">Payment:</span>
                    <strong class="order-info-value">
                        ${getPaymentIcon(paymentMethod)} ${getPaymentMethodDisplay(paymentMethod)}
                    </strong>
                </div>
                ${transactionId ? `
                <div class="order-info-row">
                    <span class="order-info-label">Transaction ID:</span>
                    <strong class="order-info-value">${transactionId}</strong>
                </div>` : ''}
            </div>

            <div class="order-items-section">
                <h3 class="order-items-title">Order Items</h3>
                <div class="order-items-grid">
                    ${Array.from(groupedItems.values()).map(({ parent, addons }) => {
                    if (!parent) return '';
                    const imageUrl = (typeof getOrderItemImageUrl === 'function'
                        ? getOrderItemImageUrl(parent) : null) || restaurantLogo;
                    //const itemName = parent.item_name || parent.product_name || 'Unknown Item';
                    const itemName = parent.item_desc;
                    const qty = parent.qty || 1;
                    const price = parseFloat(parent.sub_total || parent.amt || 0);
                    const remarks = parent.remarks ? parent.remarks.trim() : '';
                    const addonTotal = addons.reduce((s, a) =>
                        s + parseFloat(a.sub_total || a.amt || 0), 0);
                    const totalPrice = price + addonTotal;
                    return `
                            <div class="order-item-card">
                                <div class="order-item-image">
                                    <div class="order-item-image-loader"></div>
                                    <img src="${imageUrl}" alt="${itemName}" loading="eager"
                                         onload="this.style.opacity='1';this.previousElementSibling.style.display='none';"
                                         onerror="this.onerror=null;this.src='${restaurantLogo}';this.style.opacity='1';this.previousElementSibling.style.display='none';"
                                         style="opacity:0;transition:opacity 0.3s ease-in-out;"/>
                                </div>
                                <div class="order-item-details">
                                    <div class="order-item-header">
                                        <div class="order-item-title">
                                            <div class="order-item-name">
                                                <span class="order-item-qty-badge"
                                                      style="background:${primaryColor};">${qty}×</span>
                                                ${itemName}
                                            </div>
                                        </div>
                                        <div class="order-item-price" style="color:${primaryColor};">
                                            $${totalPrice.toFixed(2)}
                                        </div>
                                    </div>
                                    ${remarks ? `<div class="order-item-remarks">💬 ${remarks}</div>` : ''}
                                    ${addons.length > 0 ? `
                                        <div class="order-item-addons"
                                             style="border-left-color:${primaryColor};">
                                            ${addons.map(a => {
                        const aName = a.item_desc || a.item_name || a.product_name || 'Unknown';
                        const aQty = a.qty || 1;
                        const aPrice = parseFloat(a.sub_total || a.amt || 0);
                        return `
                                                    <div class="order-addon-item">
                                                        <span class="order-addon-prefix"
                                                              style="color:${primaryColor};">+</span>
                                                        <span class="order-addon-name">
                                                            <strong>${aName}</strong>
                                                            ${aQty > 1 ? ` ×${aQty}` : ''}
                                                        </span>
                                                        ${aPrice > 0
                                ? `<span class="order-addon-price">+$${aPrice.toFixed(2)}</span>`
                                : ''}
                                                    </div>`;
                    }).join('')}
                                        </div>` : ''}
                                </div>
                            </div>`;
                }).join('')}
                </div>
            </div>

            <div class="order-price-summary">
                <div class="summary-row">
                    <span class="summary-label">Subtotal:</span>
                    <span class="summary-value">$${subtotal.toFixed(2)}</span>
                </div>
                ${discount > 0 ? `
                <div class="summary-row summary-discount">
                    <span class="summary-label">Discount:</span>
                    <span class="summary-value">−$${discount.toFixed(2)}</span>
                </div>` : ''}
                <div class="summary-row">
                    <span class="summary-label">Service Charge (${serviceRate}%):</span>
                    <span class="summary-value">$${serviceCharge.toFixed(2)}</span>
                </div>
                ${gst >= 0 ? `
                <div class="summary-row">
                    <span class="summary-label">GST (${gstRate}%):</span>
                    <span class="summary-value">$${gst.toFixed(2)}</span>
                </div>` : ''}
                <div class="summary-row summary-total"
                     style="border-top-color:${primaryColor};">
                    <span class="summary-label">Total:</span>
                    <span class="summary-value" style="color:${primaryColor};">
                        $${total.toFixed(2)}
                    </span>
                </div>
            </div>`;

        if (typeof preloadImages === 'function') preloadImages(imageUrls);

        if (typeof saveCacheBeforeRedirect === 'function') {
            console.log("💾 Proactively saving menu cache...");
            saveCacheBeforeRedirect();
        }
    }

    // ── Show modal ────────────────────────────────────────────────────────────
    const modal = document.getElementById('successModal');
    if (!modal) return;

    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('show'), 10);
    document.body.style.overflow = 'hidden';
    setTimeout(() => { orderDetailsContainer.scrollTop = 0; }, 50);
    modal.onclick = e => { if (e.target === modal) e.stopImmediatePropagation(); };

    setTimeout(() => {
        const newOrderBtn =
            document.getElementById('btnNewOrder') ||
            document.getElementById('closeSuccessModal') ||
            [...document.querySelectorAll('#successModal button')]
                .find(btn => btn.textContent.includes('New Order'));

        if (!newOrderBtn) return;

        // Phase 1: PRINTING — button fully locked, no clicks at all
        let isPrinting = true;
        let isCountingDown = false;

        newOrderBtn.disabled = true;
        newOrderBtn.classList.add('opacity-50', 'cursor-not-allowed');
        newOrderBtn.innerHTML = `
            <svg style="display:inline;animation:spin 1s linear infinite;
                        margin-right:6px;vertical-align:middle;"
                 width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            Printing…`;

        if (!document.getElementById('spin-style')) {
            const st = document.createElement('style');
            st.id = 'spin-style';
            st.textContent = `@keyframes spin{to{transform:rotate(360deg)}}`;
            document.head.appendChild(st);
        }

        // Progress bar
        let progressBar = document.getElementById('success-countdown-bar');
        if (!progressBar) {
            progressBar = document.createElement('div');
            progressBar.id = 'success-countdown-bar';
            progressBar.style.cssText = `
                width:100%;height:4px;background:#e5e7eb;
                border-radius:2px;margin-bottom:8px;overflow:hidden;`;
            const fill = document.createElement('div');
            fill.id = 'success-countdown-fill';
            fill.style.cssText = `
                height:100%;width:0%;
                background:${primaryColor};
                border-radius:2px;
                transition:width 0.5s ease;`;
            progressBar.appendChild(fill);
            newOrderBtn.parentNode?.insertBefore(progressBar, newOrderBtn);
        }

        const fill = document.getElementById('success-countdown-fill');
        let pct = 0;
        const barTick = setInterval(() => {
            pct = pct + (90 - pct) * 0.06;
            if (fill) fill.style.width = `${pct.toFixed(1)}%`;
        }, 300);

        // Block ALL clicks while printing or counting down
        newOrderBtn.onclick = e => {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (isPrinting || isCountingDown) return; // hard block
            triggerNewOrder();
        };

        const printPromise = printingDone instanceof Promise
            ? printingDone
            : Promise.resolve();

        const safetyTimeout = new Promise(r => setTimeout(r, 120_000, 'timeout'));

        Promise.race([printPromise, safetyTimeout]).then(reason => {
            clearInterval(barTick);
            isPrinting = false;

            if (reason === 'timeout') {
                console.warn('⚠️ [SuccessModal] Safety timeout — unlocking button');
            } else {
                console.log('✅ [SuccessModal] Printing done — starting countdown');
            }

            // Snap bar to 100%
            if (fill) {
                fill.style.transition = 'width 0.3s ease';
                fill.style.width = '100%';
            }

            // Phase 2: COUNTDOWN — button visible but clicks still blocked
            setTimeout(() => {
                newOrderBtn.disabled = false;
                newOrderBtn.classList.remove('opacity-50', 'cursor-not-allowed');

                let secsLeft = 3;
                isCountingDown = true;

                const label = () => { newOrderBtn.innerText = `Start New Order (${secsLeft}s)`; };
                label();

                const autoTick = setInterval(() => {
                    secsLeft--;
                    if (secsLeft > 0) {
                        label();
                    } else {
                        clearInterval(autoTick);
                        isCountingDown = false;
                        triggerNewOrder();
                    }
                }, 1000);

            }, 600);
        });

        function triggerNewOrder() {
            newOrderBtn.disabled = true;
            newOrderBtn.innerText = 'Starting New Order…';
            localStorage.setItem('kiosk_fresh_start', 'true');
            if (typeof saveCacheBeforeRedirect === 'function') saveCacheBeforeRedirect();
            setTimeout(() => {
                if (typeof startOverFromPOS === 'function') startOverFromPOS();
                else window.location.reload();
            }, 100);
        }

    }, 150);

    if (typeof orderCounter !== 'undefined') orderCounter++;
}

// =============================================================================
// Helpers
// =============================================================================
function preloadImages(urls) {
    return Promise.all(
        urls.map(url => new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(url);
            img.onerror = () => resolve(url);
            img.src = url;
        }))
    );
}

export function getOrderItemImageUrl(item) {
    const restaurantLogo = RESTAURANT_CONFIG?.logo || '/img/default-logo.png';

    const wrapProxy = (url) => {
        if (!url || url.trim() === '') return null;
        if (url.startsWith('/api/GetImageProxy')) return url;
        if (url.startsWith('http://') || url.startsWith('https://')) return url;
        return `/api/GetImageProxy?imageUrl=${encodeURIComponent(url)}`;
    };

    // 1. Direct fields
    const directUrl = item.tqr_image_url || item.item_image || item.image || item.category_image || '';
    if (directUrl && !directUrl.includes('Logo.png')) return wrapProxy(directUrl) || restaurantLogo;

    // 2. sessionStorage MenuItems
    try {
        const menuData = JSON.parse(sessionStorage.getItem('MenuItems') || '[]');
        const allItems = menuData.flatMap(cat => cat.items || []);
        const match = allItems.find(i =>
            i.item_no === item.item_no || i.item_no === item.product_code || i.product_code === item.item_no
        );
        if (match?.tqr_image_url) return wrapProxy(match.tqr_image_url) || restaurantLogo;
    } catch (e) { /* ignore */ }

    // 3. sessionStorage FullItems
    try {
        const fullItems = JSON.parse(sessionStorage.getItem('FullItems') || '[]');
        const match = fullItems.find(i =>
            i.item_no === item.item_no || i.product_code === item.item_no
        );
        if (match?.tqr_image_url) return wrapProxy(match.tqr_image_url) || restaurantLogo;
    } catch (e) { /* ignore */ }

    // 4. window.itemImageMap
    if (window.itemImageMap?.size > 0) {
        const key = String(item.item_no || item.product_code || '');
        if (key && window.itemImageMap.has(key)) return window.itemImageMap.get(key);
    }

    // 5. window.menuGridItems
    if (Array.isArray(window.menuGridItems)) {
        const match = window.menuGridItems.find(i =>
            i.item_no === item.item_no || i.product_code === item.item_no
        );
        if (match?.tqr_image_url || match?.item_image)
            return wrapProxy(match.tqr_image_url || match.item_image) || restaurantLogo;
    }

    return restaurantLogo;
}

export function closeModal() {
    const modal = document.getElementById('successModal');
    modal.classList.remove('show');
    setTimeout(() => {
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }, 300);
    if (typeof currentAddonParentItem !== 'undefined') currentAddonParentItem = null;
}

// =============================================================================
// Voucher Registry & Locking
// =============================================================================
export function _syncVoucherRegistry(orderItems) {
    if (!Array.isArray(orderItems)) return;
    if (window._voucherRegistrySealed) return;

    const hasAnyItems = orderItems.some(i => i?.item_no);
    if (!hasAnyItems) {
        window._voucherLockedSnos.clear();
        window._voucherRegistrySealed = false;
        return;
    }

    orderItems.forEach(item => {
        if (item?._is_free === true && String(item?.s_no) === String(item?.parent_sno)) {
            window._voucherLockedSnos.add(String(item.s_no));
            console.log(`📌 Voucher registry: locked s_no:${item.s_no} (${item.disc_name})`);
        }
    });

    if (window._voucherLockedSnos.size > 0) {
        window._voucherRegistrySealed = true;
        console.log('🔒 Voucher registry sealed:', [...window._voucherLockedSnos]);
    }
}

export function _isVoucherLockedItem(orderItem) {
    const sNo = String(orderItem?.s_no);
    const discName = orderItem?.disc_name;
    if (!discName || discName === 'None') return false;
    if (window._voucherLockedSnos.has(sNo)) return true;
    if (orderItem?._is_free === true) {
        if (String(orderItem?.s_no) === String(orderItem?.parent_sno)) {
            window._voucherLockedSnos.add(sNo);
        }
        return true;
    }

    // ✅ Ensure promos is always a usable array
    let promos = (typeof useCache === 'function' ? useCache()?.promos : null);
    if (!promos) promos = [];
    else if (typeof promos === 'string') {
        try { promos = JSON.parse(promos); } catch { promos = []; }
    }
    if (!Array.isArray(promos)) {
        promos = Object.values(promos);  // handle object keyed by index
    }

    const promo = promos.find(p =>
        p?.promo_name?.trim().toLowerCase() === discName?.trim().toLowerCase()
    );
    if (promo?.apply_terminal === 2) {
        window._voucherLockedSnos.add(sNo);
        return true;
    }

    // ✅ Also lock synthetic voucher promotions (Ascentis, apply_terminal: 2)
    // These won't be in cache.promos — lock by disc_name presence alone
    if (orderItem?.disc_type && orderItem?.disc_type !== 'N' && discName !== 'None') {
        const appliedVouchers = window._appliedCrmVouchers || [];
        if (appliedVouchers.some(v => v.name === discName || v.promo_name === discName)) {
            window._voucherLockedSnos.add(sNo);
            return true;
        }
    }

    return false;
}

export function _addVoucherItemCopy(orderItem) {
    const itemNo = orderItem?.item_no;
    if (!itemNo) { console.warn('⚠️ Cannot copy voucher item — no item_no'); return; }
    console.log(`➕ Adding fresh copy of voucher item: ${itemNo}`);
    _showVoucherLockToast(orderItem?.item_name || orderItem?.display_name || 'Item');
    if (typeof addToCart === 'function') {
        addToCart(itemNo, [], [], null, false, false);
    } else {
        console.error('❌ addToCart not available — cannot add voucher item copy');
    }
}

export function _showVoucherLockToast(itemName) {
    const existing = document.getElementById('_voucher-lock-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = '_voucher-lock-toast';
    toast.innerHTML = `
        <span style="font-size:1.1em;">🎟</span>
        <span><strong>Voucher applied</strong> — a new <em>${itemName}</em> has been added to your cart</span>`;
    Object.assign(toast.style, {
        position: 'fixed', bottom: '90px', left: '50%',
        transform: 'translateX(-50%)', background: '#1e293b', color: '#fff',
        padding: '10px 18px', borderRadius: '10px', fontSize: '13px',
        display: 'flex', gap: '8px', alignItems: 'center',
        zIndex: '9999', boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
        maxWidth: '90vw', animation: 'fadeInUp 0.2s ease',
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}
export function patchVoucherLockedCartItems() {
    const { order } = useOrder?.() || {};
    if (!order?.sales_dtls) return;

    const orderHasActiveVoucher = !!(order.voucher_code);
    if (!orderHasActiveVoucher) {
        // Clear any existing lock icons from previous state
        document.querySelectorAll('._voucher-lock-icon').forEach(el => el.remove());
        document.querySelectorAll('.cart-qty-btn:disabled').forEach(btn => {
            btn.disabled = false;
            btn.style.opacity = '';
            btn.style.cursor = '';
        });
        // ✅ Re-enable all edit buttons when no voucher active
        document.querySelectorAll('.cart-edit-btn').forEach(btn => {
            btn.disabled = false;
            btn.title = '';
            btn.style.opacity = '';
            btn.style.cursor = '';
        });
        return;
    }

    _syncVoucherRegistry(order.sales_dtls);

    // ── Build locked s_no set ─────────────────────────────────────────────────
    const lockedSnos = new Set();
    const lockReasons = new Map(); // s_no → reason string for tooltip

    order.sales_dtls.forEach(item => {
        const sNo = String(item.s_no);
        const parentSno = String(item.parent_sno);
        const proDiscAmt = parseFloat(item.pro_disc_amt || 0);
        const discName = (item.disc_name || '').trim();
        const hasDisc = discName && discName.toLowerCase() !== 'none';

        // 1. Existing voucher registry lock
        if (_isVoucherLockedItem(item)) {
            lockedSnos.add(sNo);
            lockReasons.set(sNo, 'Voucher applied — add new item to order more');
        }

        // 2. Voucher pro_disc_amt on this item
        if (proDiscAmt > 0) {
            lockedSnos.add(sNo);
            lockedSnos.add(parentSno); // always lock parent too
            lockReasons.set(sNo, 'Voucher discount applied — remove voucher to change qty');
            lockReasons.set(parentSno, 'Voucher discount applied — remove voucher to change qty');
        }

        // 3. Promotion disc_name (set deal, TD promo, SP etc.)
        if (hasDisc) {
            lockedSnos.add(sNo);
            lockedSnos.add(parentSno);
            const reason = `Promotion "${discName}" applied — remove promotion to change qty`;
            lockReasons.set(sNo, reason);
            lockReasons.set(parentSno, reason);
        }
    });

    if (lockedSnos.size === 0) return;

    const cartItems = document.getElementById('cartItems');
    if (!cartItems) return;

    cartItems.querySelectorAll('.cart-item-card').forEach(card => {
        const plusBtn = card.querySelector('.cart-qty-btn:last-of-type');
        if (!plusBtn) return;

        const onclickAttr = plusBtn.getAttribute('onclick') || '';
        const match = onclickAttr.match(/updateQuantityBySno\(['"](\d+)['"]/);
        if (!match) return;

        const sNo = match[1];

        if (!lockedSnos.has(sNo)) {
            // ✅ Unlock qty + button
            plusBtn.disabled = false;
            plusBtn.title = '';
            Object.assign(plusBtn.style, { opacity: '', cursor: '' });
            card.querySelector('._voucher-lock-icon')?.remove();

            // ✅ Re-enable edit button
            const editBtn = card.querySelector('.cart-edit-btn');
            if (editBtn) {
                editBtn.disabled = false;
                editBtn.title = '';
                Object.assign(editBtn.style, { opacity: '', cursor: '' });
            }
            return;
        }

        const reason = lockReasons.get(sNo) || 'Promotion applied — qty locked';

        // ✅ Lock + button only — minus stays enabled so item can be removed
        plusBtn.disabled = true;
        plusBtn.title = reason;
        Object.assign(plusBtn.style, { opacity: '0.35', cursor: 'not-allowed' });

        // ✅ Disable Edit button when voucher is active
        const editBtn = card.querySelector('.cart-edit-btn');
        if (editBtn) {
            editBtn.disabled = true;
            editBtn.title = 'Remove voucher to edit this item';
            Object.assign(editBtn.style, { opacity: '0.4', cursor: 'not-allowed' });
            // Override onclick to show toast instead of opening wizard
            editBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                showToast(
                    'Please remove the voucher before editing items.',
                    'warning',
                    'Voucher Active',
                    3000
                );
            };
        }

        // ✅ Lock icon next to qty — only insert once
        const qtyDisplay = card.querySelector('.cart-qty-display');
        if (qtyDisplay && !card.querySelector('._voucher-lock-icon')) {
            const lockIcon = document.createElement('span');
            lockIcon.className = '_voucher-lock-icon';
            lockIcon.title = reason;

            // Show voucher icon for voucher locks, promo tag for promotion locks
            const isPromoLock = order.sales_dtls.find(i =>
                String(i.s_no) === sNo &&
                (i.disc_name || '').trim() &&
                (i.disc_name || '').toLowerCase() !== 'none' &&
                parseFloat(i.pro_disc_amt || 0) === 0
            );
            lockIcon.textContent = isPromoLock ? '🏷️' : '🎟';

            Object.assign(lockIcon.style, {
                fontSize: '11px',
                marginLeft: '4px',
                verticalAlign: 'middle',
            });
            qtyDisplay.after(lockIcon);
        }

        console.log(`🔒 Lock applied to s_no:${sNo} — ${reason}`);
    });
}