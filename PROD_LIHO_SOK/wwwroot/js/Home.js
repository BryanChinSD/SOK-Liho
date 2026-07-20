import { useCache } from '../stores/cache-store.js';
import { useOrder, useOrderStore } from '../stores/order-store.js';
import { uiTranslations } from './Translation.js';
import React from "https://esm.sh/react";
import { ChevronLeft } from "https://esm.sh/lucide-react";

import {
    handleMemberLogin,
    clearSessionOnPageLoad,
    attachOrderTypeHandlers,
    handleOrderTypeSelection,
    proceedAsGuest,
    showOrderTypeSelection
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
    clearCart
} from '../utils/tqr.js';

import { getPriceByServiceType, applyPromotions, isAbsorbTax, getLastSNo, getNewOrder } from '../utils/pos.js';

import {
    getItemImageUrl,
    addToCart,
    updateCartCount,
    showAddOnModalOriginal,
    groupItemsByTemperature,
    getItemTemperature,
    resolveImageUrl
} from './GetHomeAPI.js';

import { renderCartFromOrder, showErrorModal, closeErrorModal, showSuccessModal, closeModal } from '../js/renderCartFromOrder.js';


renderCartFromOrder();
//updateCartCount();


// ============================================
// CONFIGURATION - Choose your modal style
// ============================================

export const ADDON_MODAL_CONFIG = {
    style: 'wizard',
    wizard: {
        showProgressBar: true,
        showStepNumbers: true,
        enableBackButton: true,
        autoAdvanceOnSelection: true,
    },
    traditional: {
        collapsibleSections: true,
        stickyAddButton: true,
    }
};


// ============================================
// MENU RENDERING CONFIGURATION
// ============================================
export const MENU_CONFIG = {
    RENDERING_MODE: 'wizard',
    OPTIONS: {
        showSubcategorySections: true,
        collapsibleSubcategories: true,
        startCollapsedOnMobile: false,
        sortStickyItemsFirst: true
    },
    DEBUG: {
        enabled: false,
        logRenderMode: true
    }
};
let globalImageCache = null;

function getSelectedItemSize() {
    const checkedRadio = document.querySelector('.option-input[type="radio"]:checked');
    if (!checkedRadio) return null;
    const label = checkedRadio.closest('.option-card');
    const itemName = label?.querySelector('.option-name')?.textContent?.trim() || '';
    if (/^L-/i.test(itemName)) return 'large';
    if (/^M-/i.test(itemName)) return 'medium';
    if (/^S-/i.test(itemName)) return 'small';
    return null;
}

function getAvailableSizesFromItems(items) {
    const sizes = new Set();
    items.forEach(item => {
        const name = (item.citem_name || item.item_name || '').toLowerCase();
        if (name.includes('small') || name.startsWith('s-')) sizes.add('small');
        if (name.includes('medium') || name.startsWith('m-')) sizes.add('medium');
        if (name.includes('large') || name.startsWith('l-')) sizes.add('large');
        if (item.item_size) sizes.add(item.item_size.toLowerCase());
        if (item.size) sizes.add(item.size.toLowerCase());
    });
    return Array.from(sizes).sort();
}

function getToppingSizes(item) {
    const name = (item.citem_name || item.item_name || '').trim();
    if (item.allowed_sizes) {
        if (Array.isArray(item.allowed_sizes)) return item.allowed_sizes;
        if (typeof item.allowed_sizes === 'string') return item.allowed_sizes.split(',').map(s => s.trim());
    }
    if (/^\(L\)/i.test(name)) return 'large';
    if (/^\(M\)/i.test(name)) return 'medium';
    if (/^\(S\)/i.test(name)) return 'small';
    return null;
}


export function setMenuRenderingMode(mode) {
    if (mode !== 'wizard' && mode !== 'traditional') {
        console.error('❌ Invalid mode. Use "wizard" or "traditional"');
        return;
    }
    MENU_CONFIG.RENDERING_MODE = mode;
    console.log(`✅ Menu rendering mode set to: ${mode}`);
}

if (typeof window !== 'undefined') {
    window.MENU_CONFIG = MENU_CONFIG;
    window.setMenuRenderingMode = setMenuRenderingMode;
}

document.addEventListener('DOMContentLoaded', function () {
    const voucherBanner = document.getElementById('voucherBanner');
    const cartItems = document.getElementById('cartItems');
    if (voucherBanner && cartItems && voucherBanner.parentElement !== cartItems.parentElement) {
        cartItems.parentElement.insertBefore(voucherBanner, cartItems);
    }
});

let resizeTimeout;

function autoScrollToTab(categoryCode, delay = 100) {
    if (!categoryCode) return;
    setTimeout(() => {
        const activeTab = document.querySelector(
            `.category-tab[data-category="${categoryCode}"], ` +
            `.subcategory-tab[data-category="${categoryCode}"]`
        );
        if (!activeTab) {
            console.warn(`Tab with category code "${categoryCode}" not found`);
            return;
        }
        const originalScrollX = window.scrollX;
        const originalScrollY = window.scrollY;
        scrollNavigationOnly(activeTab);
        setTimeout(() => {
            if (window.scrollX !== originalScrollX || window.scrollY !== originalScrollY) {
                window.scrollTo(originalScrollX, originalScrollY);
            }
        }, 10);
        addTabHighlight(activeTab);
    }, delay);
}

function scrollNavigationOnly(element) {
    const navSidebar = document.querySelector('.navigation-sidebar');
    const categoryTabs = document.querySelector('.category-tabs');
    if (!navSidebar || !categoryTabs) return;
    const isVerticalScroll = categoryTabs.scrollHeight > categoryTabs.clientHeight;
    const isHorizontalScroll = navSidebar.scrollWidth > navSidebar.clientWidth;
    let container;
    let scrollAxis;
    if (isHorizontalScroll) {
        container = navSidebar;
        scrollAxis = 'horizontal';
    } else if (isVerticalScroll) {
        container = categoryTabs;
        scrollAxis = 'vertical';
    } else {
        return;
    }
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    let isVisible;
    if (scrollAxis === 'horizontal') {
        isVisible = elementRect.left >= containerRect.left && elementRect.right <= containerRect.right;
    } else {
        isVisible = elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom;
    }
    if (isVisible) return;
    let targetScroll;
    if (scrollAxis === 'horizontal') {
        const elementLeft = elementRect.left - containerRect.left + container.scrollLeft;
        const elementWidth = elementRect.width;
        const containerWidth = container.clientWidth;
        targetScroll = elementLeft - (containerWidth / 2) + (elementWidth / 2);
        const maxScroll = container.scrollWidth - containerWidth;
        targetScroll = Math.max(0, Math.min(targetScroll, maxScroll));
        smoothScrollTo(container, targetScroll, 'scrollLeft');
    } else {
        const elementTop = elementRect.top - containerRect.top + container.scrollTop;
        const elementHeight = elementRect.height;
        const containerHeight = container.clientHeight;
        targetScroll = elementTop - (containerHeight / 2) + (elementHeight / 2);
        const maxScroll = container.scrollHeight - containerHeight;
        targetScroll = Math.max(0, Math.min(targetScroll, maxScroll));
        smoothScrollTo(container, targetScroll, 'scrollTop');
    }
}

function smoothScrollTo(container, targetScroll, scrollProperty) {
    const startScroll = container[scrollProperty];
    const distance = targetScroll - startScroll;
    const duration = 300;
    let startTime;
    function easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }
    function animate(timestamp) {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easedProgress = easeInOutCubic(progress);
        container[scrollProperty] = startScroll + (distance * easedProgress);
        if (progress < 1) requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
}

function addTabHighlight(element) {
    document.querySelectorAll('.tab-highlight').forEach(el => el.classList.remove('tab-highlight'));
    element.classList.add('tab-highlight');
    setTimeout(() => element.classList.remove('tab-highlight'), 1000);
}

function initAutoScroll() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupAutoScroll);
    } else {
        setupAutoScroll();
    }
}

function setupAutoScroll() {
    setTimeout(() => {
        const activeTab = document.querySelector('.category-tab.active, .subcategory-tab.active');
        if (activeTab) autoScrollToTab(activeTab.dataset.category);
    }, 500);
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const activeTab = document.querySelector('.category-tab.active, .subcategory-tab.active');
            if (activeTab) autoScrollToTab(activeTab.dataset.category);
        }, 250);
    });
    document.addEventListener('tabChanged', (e) => {
        if (e.detail?.categoryCode) autoScrollToTab(e.detail.categoryCode);
    });
    document.addEventListener('categoryTabsPopulated', () => {
        setTimeout(() => {
            const activeTab = document.querySelector('.category-tab.active, .subcategory-tab.active');
            if (activeTab) autoScrollToTab(activeTab.dataset.category);
        }, 200);
    });
}

function scrollToTab(categoryCode) { autoScrollToTab(categoryCode, 50); }

function ensureSubcategoryVisibility(categoryCode) {
    if (!categoryCode) return;
    const subcategoryTab = document.querySelector(`.subcategory-tab[data-category="${categoryCode}"]`);
    if (subcategoryTab) {
        const parentContainer = subcategoryTab.closest('.subcategory-container');
        if (parentContainer && !parentContainer.classList.contains('show')) parentContainer.classList.add('show');
        document.querySelectorAll('.subcategory-tab').forEach(tab => tab.classList.remove('active'));
        subcategoryTab.classList.add('active');
        setTimeout(() => autoScrollToTab(categoryCode, 100), 150);
    }
}

function updateActiveTabStates(categoryCode) {
    if (!categoryCode) return;
    document.querySelectorAll('.category-tab, .subcategory-tab').forEach(tab => tab.classList.remove('active'));
    const matchingTab = document.querySelector(
        `.category-tab[data-category="${categoryCode}"], .subcategory-tab[data-category="${categoryCode}"]`
    );
    if (matchingTab) {
        matchingTab.classList.add('active');
        if (matchingTab.classList.contains('subcategory-tab')) {
            const parentContainer = matchingTab.closest('.subcategory-container');
            const parentTab = parentContainer?.previousElementSibling;
            if (parentTab?.classList.contains('category-tab')) parentTab.classList.add('active');
            if (parentContainer) parentContainer.classList.add('show');
        }
    }
}

function navigateToCategory(categoryCode) {
    if (!categoryCode) return;
    updateActiveTabStates(categoryCode);
    setTimeout(() => autoScrollToTab(categoryCode, 100), 50);
}

initAutoScroll();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { autoScrollToTab, scrollToTab, ensureSubcategoryVisibility, updateActiveTabStates, navigateToCategory };
}


// ============================================
// MAIN FUNCTION
// ============================================

export function showAddOnModal(baseItem, onConfirm, addonData, remarksData = [], prefilledAddons = [], prefilledRemarks = [], editingOrderItemSNo = null) {
    if (ADDON_MODAL_CONFIG.style === 'wizard') {
        showWizardModal(baseItem, onConfirm, addonData, remarksData, prefilledAddons, prefilledRemarks, editingOrderItemSNo);
    } else {
        showTraditionalModal(baseItem, onConfirm, addonData, remarksData, prefilledAddons, prefilledRemarks, editingOrderItemSNo);
        scrollModalToTop();
    }
}

// ============================================
// WIZARD MODAL
// ============================================

export function showWizardModal(
    baseItem, onConfirm, addonData, remarksData, prefilledAddons, prefilledRemarks, editingOrderItemSNo
) {
    const modal = document.getElementById('addonModal');
    const modalContent = document.getElementById('addonModalContent');

    modal.classList.remove('close');
    modal.classList.add('show');
    modal.style.display = '';
    const bottomNav = document.querySelector('.bottom-nav');
    if (bottomNav) {
        bottomNav.classList.add('hide');
        bottomNav.classList.remove('show');
    }

    window.currentBaseItemId = baseItem.item_no;
    window.editingOrderItemSNo = editingOrderItemSNo;

    // 🛠️ FIX: Safe checks for combo setups if standard parameters are missing from API payload
    const itemmasterGroups = Array.isArray(baseItem.itemmaster_menutype_grpdtls) && baseItem.itemmaster_menutype_grpdtls.length > 0
        ? baseItem.itemmaster_menutype_grpdtls
        : (Array.isArray(baseItem.combo_groups) ? baseItem.combo_groups : (Array.isArray(baseItem.combo_details) ? baseItem.combo_details : []));

    const itemmasterItems = Array.isArray(baseItem.itemmaster_menutypedtls) && baseItem.itemmaster_menutypedtls.length > 0
        ? baseItem.itemmaster_menutypedtls
        : (Array.isArray(baseItem.combo_items) ? baseItem.combo_items : (Array.isArray(baseItem.child_items) ? baseItem.child_items : []));

    window.itemmasterGroups = itemmasterGroups;
    window.itemmasterItems = itemmasterItems;

    initializeMenuCacheAfterLoad();
    if (!globalImageCache) globalImageCache = new Map();

    console.log('🎯 Wizard Modal Starting:', {
        item: baseItem.item_name,
        groups: itemmasterGroups.length,
        items: itemmasterItems.length,
        isEditing: !!editingOrderItemSNo,
    });

    window.wizardSelections = {};
    window.selectedAddons = [];
    window.currentWizardStep = 0;

    const resolvedAddonData = Array.isArray(addonData) ? addonData[0] : addonData;

    const wizardSteps = buildWizardSteps(
        baseItem, itemmasterGroups, itemmasterItems, resolvedAddonData, globalImageCache
    ) || [];

    // Patch addon steps with noofitem + max_qty from sessionStorage
    try {
        const rawAddon = JSON.parse(sessionStorage.getItem('AddOnItems') || '[]');
        const storedAddon = Array.isArray(rawAddon) ? rawAddon[0] : rawAddon;
        const groupMax = parseInt(storedAddon?.noofitem ?? storedAddon?.qty) || null;
        wizardSteps.forEach(step => {
            if (step.type === 'quantity' && groupMax && !step.maxSelection) {
                step.maxSelection = groupMax;
                step.options.forEach(opt => {
                    if (!opt.itemMaxQty) {
                        const found = storedAddon?.item_dtls?.find(i => i.item_no === opt.id);
                        opt.itemMaxQty = parseInt(found?.max_qty) || groupMax;
                    }
                });
                console.log('✅ Addon step patched:', step.id, 'maxSelection:', step.maxSelection);
            }
        });
    } catch (e) {
        console.warn('⚠️ Addon step patch failed:', e);
    }

    if (wizardSteps.length === 0) {
        console.error('❌ No wizard steps created! Falling back to traditional modal.');
        showTraditionalModal(baseItem, onConfirm, addonData, remarksData, prefilledAddons, prefilledRemarks, editingOrderItemSNo);
        return;
    }

    window.wizardSteps = wizardSteps;
    window.currentBaseItem = baseItem;
    window.wizardOnConfirm = onConfirm;

    if (editingOrderItemSNo && prefilledAddons?.length > 0) {
        const prefilled = prefillWizardSelections(wizardSteps, prefilledAddons, itemmasterItems, editingOrderItemSNo);
        window.wizardSelections = { ...window.wizardSelections, ...prefilled };
        window.selectedAddons = [...prefilledAddons];

        if (prefilledRemarks?.length > 0) {
            prefillRemarksIntoSelections(wizardSteps, prefilledRemarks, window.wizardSelections);
        }

        Object.entries(window.wizardSelections).forEach(([stepId, value]) => {
            if (typeof value !== 'string' || stepId === 'temperature' || stepId === 'size') return;
            const item = itemmasterItems.find(i => i.item_no === value);
            const itemName = item?.item_name || '';
            if (/^L-/i.test(itemName)) window.wizardSelections.size = 'large';
            else if (/^M-/i.test(itemName)) window.wizardSelections.size = 'medium';
            else if (/^S-/i.test(itemName)) window.wizardSelections.size = 'small';
            else if (/^H-/i.test(itemName)) window.wizardSelections.size = 'hot';
        });

        if (!window.wizardSelections.size) {
            prefilledAddons.forEach(addon => {
                const name = addon.item_name || addon.name || '';
                if (/^L-/i.test(name)) window.wizardSelections.size = 'large';
                else if (/^M-/i.test(name)) window.wizardSelections.size = 'medium';
                else if (/^S-/i.test(name)) window.wizardSelections.size = 'small';
                else if (/^H-/i.test(name)) window.wizardSelections.size = 'hot';
            });
        }

        console.log('📏 Size extracted from prefill:', window.wizardSelections.size);
        window.currentWizardStep = wizardSteps.length - 1;
    }

    console.log('🌡️ Final wizardSelections before render:', window.wizardSelections);
    renderWizardUI(modalContent, baseItem, wizardSteps, onConfirm, editingOrderItemSNo);

    window._injectWizardCloseBtn = () => {
        const wizardHeader = modalContent.querySelector('.wizard-header');
        if (!wizardHeader) return;
        if (wizardHeader.querySelector('.wizard-close-btn')) return;
        const closeBtn = document.createElement('button');
        closeBtn.className = 'wizard-close-btn';
        closeBtn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>`;
        closeBtn.style.cssText = `position:absolute;top:12px;right:12px;z-index:60;background:#f3f4f6;border:none;border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#374151;flex-shrink:0;`;
        closeBtn.onclick = (e) => {
            e.stopImmediatePropagation();
            if (window._wizardBlockOutsideClick) {
                modal.removeEventListener('click', window._wizardBlockOutsideClick, { capture: true });
                window._wizardBlockOutsideClick = null;
            }
            if (window.modalState) window.modalState.addonOpen = false;
            modal.classList.remove('show');
            window._blockWSSync = false;
            modal.classList.add('close');
            updateBottomNavVisibility();
        };
        wizardHeader.style.position = 'relative';
        wizardHeader.appendChild(closeBtn);
    };

    window._injectWizardCloseBtn();

    const _origRenderStep = window.renderWizardStep;
    if (typeof _origRenderStep === 'function') {
        window.renderWizardStep = function (...args) {
            const result = _origRenderStep.apply(this, args);
            window._injectWizardCloseBtn();
            return result;
        };
    }

    ['goToWizardStep', 'wizardNextStep', 'wizardPrevStep'].forEach(fnName => {
        const _orig = window[fnName];
        if (typeof _orig === 'function') {
            window[fnName] = function (...args) {
                const result = _orig.apply(this, args);
                setTimeout(() => window._injectWizardCloseBtn(), 0);
                return result;
            };
        }
    });

    setTimeout(() => { modal.scrollTop = 0; modalContent.scrollTop = 0; }, 0);

    if (window._wizardBlockOutsideClick) {
        modal.removeEventListener('click', window._wizardBlockOutsideClick, { capture: true });
    }
    const blockOutsideClick = (e) => { if (e.target === modal) e.stopImmediatePropagation(); };
    modal.addEventListener('click', blockOutsideClick, { capture: true });
    window._wizardBlockOutsideClick = blockOutsideClick;
}


function extractSizeFromPrefill() {
    if (!window.wizardSelections) return;
    const cacheStore = useCache ? useCache() : null;
    const items = cacheStore?.items || [];
    Object.entries(window.wizardSelections).forEach(([stepId, value]) => {
        if (typeof value !== 'string') return;
        if (stepId === 'temperature' || stepId === 'size') return;
        const item = items.find(i => i.item_no === value);
        const itemName = item?.item_name || value || '';
        if (/^L-/i.test(itemName)) { window.wizardSelections.size = 'large'; console.log('📏 Size extracted from prefill:', 'large', itemName); }
        else if (/^M-/i.test(itemName)) { window.wizardSelections.size = 'medium'; console.log('📏 Size extracted from prefill:', 'medium', itemName); }
        else if (/^S-/i.test(itemName)) { window.wizardSelections.size = 'small'; console.log('📏 Size extracted from prefill:', 'small', itemName); }
        else if (/^H-/i.test(itemName)) { window.wizardSelections.size = 'hot'; console.log('📏 Size extracted from prefill:', 'hot', itemName); }
    });
}

function prefillRemarksIntoSelections(wizardSteps, prefilledRemarks, wizardSelections) {
    console.log('📝 Prefilling remarks into wizard selections:', prefilledRemarks);
    prefilledRemarks.forEach(remark => {
        const remarkText = remark.remarks || remark.remarks_item_name || remark.item_name;
        const remarkGroup = remark.remarks_group || remark.modifier_name;
        const matchingStep = wizardSteps.find(step => step.id === remarkGroup || step.title === remarkGroup);
        if (matchingStep) {
            const matchingOption = matchingStep.options.find(opt =>
                opt.name === remarkText || opt.id === remark.citem_no || opt.id === remark.item_no
            );
            if (matchingOption) {
                if (matchingStep.type === 'single') {
                    wizardSelections[matchingStep.id] = matchingOption.id;
                } else if (matchingStep.type === 'multiple') {
                    if (!wizardSelections[matchingStep.id]) wizardSelections[matchingStep.id] = {};
                    wizardSelections[matchingStep.id][matchingOption.id] = 1;
                }
            }
        }
    });
}

function detectSizeFromCartItem(prefilledAddons, itemmasterItems) {
    for (const addon of prefilledAddons) {
        const name = (addon.item_name || addon.citem_name || '').toLowerCase();
        if (name.includes('small')) return 'small';
        if (name.includes('medium')) return 'medium';
        if (name.includes('large')) return 'large';
        if (addon.item_size) return addon.item_size.toLowerCase();
        if (addon.size) return addon.size.toLowerCase();
    }
    return null;
}

// ============================================
// ✅ FIX: prefillWizardSelections — divide scaled topping qty back to per-serving qty
// ============================================
function prefillWizardSelections(wizardSteps, prefilledAddons, itemmasterItems, editingOrderItemSNo = null) {
    const selections = {};

    const detectedSize = detectSizeFromCartItem(prefilledAddons, itemmasterItems);
    if (detectedSize) {
        selections.size = detectedSize;
        console.log('📏 ✅ SET SIZE SELECTION:', detectedSize);
    }

    const detectedTemp = detectTemperatureFromCartItem(prefilledAddons, itemmasterItems);
    if (detectedTemp) {
        selections.temperature = detectedTemp;
        console.log('🌡️ ✅ SET TEMPERATURE SELECTION:', detectedTemp);
    }

    // ✅ Get the parent item's qty directly from the order store using editingOrderItemSNo.
    // prefilledAddons only contains child/addon rows — the parent row is NOT in this array,
    // so we must look it up from sales_dtls by matching s_no === editingOrderItemSNo.
    let parentQty = 1;
    if (editingOrderItemSNo) {
        try {
            const { order } = useOrder();
            const parentRow = order?.sales_dtls?.find(
                row => String(row.s_no) === String(editingOrderItemSNo)
            );
            if (parentRow) {
                parentQty = parseInt(parentRow.qty) || 1;
                console.log(`🔢 Parent qty from order store (s_no ${editingOrderItemSNo}): ${parentQty}`);
            } else {
                console.warn(`⚠️ Parent row not found for s_no: ${editingOrderItemSNo}, defaulting parentQty=1`);
            }
        } catch (e) {
            console.warn('⚠️ Could not read parent qty from order store:', e);
        }
    }
    console.log('🔢 Final parentQty for prefill division:', parentQty);

    wizardSteps.forEach((step, stepIndex) => {
        console.log(`\n📋 Processing step ${stepIndex + 1}: ${step.title} (type: ${step.type})`);

        if (step.id === 'temperature') {
            console.log(`  ✅ Temperature already set: ${selections.temperature || 'none'}`);
            return;
        }

        const matchedAddons = prefilledAddons.filter(addon => {
            const matchesStepId =
                addon.category_code === step.id ||
                addon.modifier_name === step.id ||
                addon.remarks_group === step.id;
            const matchesOption = step.options.some(opt =>
                opt.id === addon.item_no || opt.id === addon.citem_no ||
                opt.name === addon.item_name || opt.name === addon.citem_name
            );
            return matchesStepId || matchesOption;
        });

        if (matchedAddons.length > 0) {
            console.log(`  Found ${matchedAddons.length} matching addons`);

            if (step.type === 'single') {
                const firstMatch = matchedAddons[0];
                const matchingOption = step.options.find(opt =>
                    opt.id === firstMatch.item_no || opt.id === firstMatch.citem_no ||
                    opt.name === firstMatch.item_name || opt.name === firstMatch.citem_name
                );
                if (matchingOption) {
                    selections[step.id] = matchingOption.id;
                    console.log(`  ✅ Single selection: ${matchingOption.name} (ID: ${matchingOption.id})`);
                }
            } else if (step.type === 'quantity') {
                // ✅ FIX: For topping steps, the stored qty in sales_dtls is already
                // scaled (parentQty × qtyPerServing). We must divide back to get
                // the per-serving qty the user originally selected, so the wizard
                // shows the correct value and addToCart re-multiplies correctly.
                const quantities = {};

                matchedAddons.forEach(addon => {
                    const matchingOption = step.options.find(opt =>
                        opt.id === addon.item_no || opt.id === addon.citem_no ||
                        opt.name === addon.item_name || opt.name === addon.citem_name
                    );

                    if (matchingOption) {
                        const scaledQty = parseInt(addon.qty) || 1;

                        // Determine if this is a topping (scaled) addon
                        const addonIsTopping =
                            (addon.uom || '').toUpperCase() === 'TOPPING' ||
                            (addon.category_code || '').toUpperCase() === 'EXTRA OPTIONS' ||
                            step.id?.toUpperCase() === 'EXTRA OPTIONS';

                        // ✅ Divide scaled qty back to per-serving qty
                        // Use _qty_per_serving if stored, otherwise divide by parentQty
                        let perServingQty;
                        if (addon._qty_per_serving !== undefined) {
                            perServingQty = addon._qty_per_serving;
                            console.log(`  ✅ Using stored _qty_per_serving: ${perServingQty} for ${matchingOption.name}`);
                        } else if (addonIsTopping && parentQty > 1) {
                            perServingQty = Math.round(scaledQty / parentQty);
                            console.log(`  ✅ Topping qty divided: ${scaledQty} ÷ ${parentQty} = ${perServingQty} for ${matchingOption.name}`);
                        } else {
                            perServingQty = scaledQty;
                        }

                        quantities[matchingOption.id] = Math.max(1, perServingQty);
                        console.log(`  ✅ Quantity: ${matchingOption.name} × ${quantities[matchingOption.id]} (per serving)`);
                    }
                });

                if (Object.keys(quantities).length > 0) {
                    selections[step.id] = quantities;
                }
            }
        }
    });

    console.log('\n✅ Final wizard selections (per-serving):', selections);
    return selections;
}

function getCategoryImageFromCache(categoryCode) {
    if (!categoryCode) return '';
    try {
        const cached = sessionStorage.getItem('MenuItems');
        if (cached) {
            const menuSections = JSON.parse(cached);
            if (Array.isArray(menuSections)) {
                const category = menuSections.find(s => s.category_code === categoryCode || s.category_name === categoryCode);
                if (category) {
                    if (category.tqr_image_url || category.category_image) return category.tqr_image_url || category.category_image;
                    if (category.items?.length > 0) {
                        const firstItemWithImage = category.items.find(item => item.tqr_image_url || item.item_image);
                        if (firstItemWithImage) return firstItemWithImage.tqr_image_url || firstItemWithImage.item_image;
                    }
                }
            }
        }
        if (typeof useCache !== 'undefined') {
            const cacheState = useCache.getState();
            if (cacheState?.menuItems) {
                const category = cacheState.menuItems.find(s => s.category_code === categoryCode || s.category_name === categoryCode);
                if (category?.items?.length > 0) {
                    const firstItemWithImage = category.items.find(item => item.tqr_image_url || item.item_image);
                    if (firstItemWithImage) return firstItemWithImage.tqr_image_url || firstItemWithImage.item_image;
                }
            }
        }
    } catch (error) {
        console.warn('⚠️ Error getting category image:', error);
    }
    return '';
}

function getImageFromMenuCache(itemNo, itemName, categoryCode) {
    let MenuItems = [];
    let FullItems = [];
    try {
        const cachedMenu = sessionStorage.getItem('MenuItems');
        if (cachedMenu) {
            const parsed = JSON.parse(cachedMenu);
            if (Array.isArray(parsed)) MenuItems = parsed[0]?.items ? parsed.flatMap(s => s.items || []) : parsed;
        }
        const cachedFull = sessionStorage.getItem('FullItems');
        if (cachedFull) {
            const parsed = JSON.parse(cachedFull);
            if (Array.isArray(parsed)) FullItems = parsed;
        }
        if (MenuItems.length === 0 && typeof useCache !== 'undefined') {
            const cacheState = useCache.getState();
            if (cacheState?.menuItems) MenuItems = cacheState.menuItems[0]?.items ? cacheState.menuItems.flatMap(s => s.items || []) : cacheState.menuItems;
            if (cacheState?.items) FullItems = cacheState.items;
        }
        if (MenuItems.length === 0 && window.menuItems) {
            MenuItems = Array.isArray(window.menuItems)
                ? (window.menuItems[0]?.items ? window.menuItems.flatMap(s => s.items || []) : window.menuItems)
                : [];
        }
    } catch (err) {
        console.warn('⚠️ Error accessing menu cache:', err);
    }
    const allItems = [...MenuItems, ...FullItems];
    if (!allItems.length) return { tqr_image_url: '', item_image: '' };
    let foundItem = allItems.find(mi => mi.item_no === itemNo || mi.citem_no === itemNo);
    if (!foundItem && itemName) {
        const searchName = itemName.toLowerCase().trim();
        foundItem = allItems.find(mi => {
            const a = (mi.item_name || '').toLowerCase().trim();
            const b = (mi.citem_name || '').toLowerCase().trim();
            return a === searchName || b === searchName || a.includes(searchName) || searchName.includes(a) || b.includes(searchName) || searchName.includes(b);
        });
    }
    return foundItem ? { tqr_image_url: foundItem.tqr_image_url || '', item_image: foundItem.item_image || '' } : { tqr_image_url: '', item_image: '' };
}

function getMenuItemsFromCache() {
    try {
        const cached = sessionStorage.getItem('MenuItems');
        if (!cached) return [];
        const parsed = JSON.parse(cached);
        if (!Array.isArray(parsed)) return [];
        return parsed.flatMap(section => (section.items || []).map(item => ({
            ...item,
            __category_code: section.category_code || section.root_category_code,
            __category_name: section.category_name || section.root_category_code
        })));
    } catch (e) {
        console.warn('⚠️ Failed to read MenuItems cache:', e);
        return [];
    }
}

function resolveBaseDrinkImage(baseItem) {
    if (!baseItem) return '';
    const menuItems = getMenuItemsFromCache();
    if (!menuItems.length) return '';
    let found = menuItems.find(i => i.item_no === baseItem.item_no && i.tqr_image_url && i.item_type === 'C');
    if (found) return found.tqr_image_url;
    const skuMatch = baseItem.item_name?.match(/(LHO\d+)/);
    if (skuMatch) {
        found = menuItems.find(i => i.sku_no === skuMatch[1] && i.tqr_image_url && i.item_type === 'C');
        if (found) return found.tqr_image_url;
    }
    return getCategoryImageFromCache(baseItem.category_code);
}

function buildWizardSteps(baseItem, itemmasterGroups, itemmasterItems, addonData, imageCache) {
    if (!baseItem) { console.warn('⚠️ buildWizardSteps called without baseItem'); return []; }

    const steps = [];
    itemmasterGroups = Array.isArray(itemmasterGroups) ? itemmasterGroups : [];
    itemmasterItems = Array.isArray(itemmasterItems) ? itemmasterItems : [];

    const temperatureGroups = groupItemsByTemperature(itemmasterItems) || { hot: [], iced: [] };
    const needsTemperature = temperatureGroups.hot.length > 0 && temperatureGroups.iced.length > 0;

    if (needsTemperature) {
        const tempOptions = [];
        if (temperatureGroups.hot.length > 0) tempOptions.push({ id: 'hot', name: 'HOT', icon: '🔥', temp: 'hot', price: 0, image: null });
        if (temperatureGroups.iced.length > 0) tempOptions.push({ id: 'iced', name: 'ICED', icon: '🧊', temp: 'iced', price: 0, image: null });
        if (tempOptions.length > 1) {
            steps.push({ id: 'temperature', title: 'Select Temperature', required: true, type: 'single', temperatureDependent: false, options: tempOptions });
        } else if (tempOptions.length === 1) {
            window.wizardSelections = window.wizardSelections || {};
            window.wizardSelections.temperature = tempOptions[0].id;
            console.log('🌡️ Auto-set single temperature:', tempOptions[0].id);
        }
    }

    const sortedGroups = itemmasterGroups.slice().sort((a, b) => (a.item_menutype_grpdtls || 9999) - (b.item_menutype_grpdtls || 9999));
    sortedGroups.forEach(group => {
        let groupItems = (typeof getAvailableModifierItems === 'function')
            ? getAvailableModifierItems(baseItem, group) || []
            : itemmasterItems.filter(item => parseInt(item.level_no || 0) === parseInt(group.item_menutype_grpdtls || 0));
        if (!groupItems.length) return;
        const maxQty = parseInt(group.max_qty) || 1;
        const stepType = maxQty === 1 ? 'single' : 'quantity';
        steps.push({
            id: group.modifier_name,
            title: group.modifier_name,
            required: group.is_optional !== 'Y',
            type: stepType,
            maxQty,
            maxSelection: maxQty > 1 ? maxQty : null,
            temperatureDependent: needsTemperature,
            sizeDependent: false,
            options: groupItems.map(item => {
                const itemNo = item.citem_no || item.item_no;
                const itemName = item.citem_name || item.item_name;
                const images = resolveOptionImageUrl(item, itemNo, itemName, imageCache, baseItem);
                return {
                    id: itemNo,
                    name: itemName,
                    price: getPriceByServiceType(item.price_dtls?.[0]) ?? 0,
                    temp: getItemTemperature(item),
                    size: null,
                    itemMaxQty: parseInt(item.max_qty) || null,
                    tqr_image_url: images.tqr_image_url,
                    item_image: images.item_image,
                    image: images.resolved_image,
                    soldOut: item.isSoldOut || false
                };
            })
        });
    });

    if (addonData?.cat_dtls && addonData?.item_dtls) {
        let groupMax = parseInt(addonData.noofitem ?? addonData.qty) || null;
        if (!groupMax) {
            try {
                const rawAddon = JSON.parse(sessionStorage.getItem('AddOnItems') || '[]');
                const storedAddon = Array.isArray(rawAddon) ? rawAddon[0] : rawAddon;
                groupMax = parseInt(storedAddon?.noofitem ?? storedAddon?.qty) || null;
                console.log('📦 groupMax from sessionStorage:', groupMax);
            } catch (e) { console.warn('⚠️ Could not read AddOnItems from sessionStorage:', e); }
        }

        let itemMaxQtyMap = {};
        try {
            const rawAddon = JSON.parse(sessionStorage.getItem('AddOnItems') || '[]');
            const storedAddon = Array.isArray(rawAddon) ? rawAddon[0] : rawAddon;
            (storedAddon?.item_dtls || []).forEach(i => {
                if (i.item_no && i.max_qty != null) itemMaxQtyMap[i.item_no] = parseInt(i.max_qty) || 99;
            });
        } catch (e) { console.warn('⚠️ Could not build itemMaxQtyMap:', e); }

        addonData.cat_dtls.sort((a, b) => (a.seq_no || 0) - (b.seq_no || 0)).forEach(cat => {
            const items = addonData.item_dtls.filter(i => i.category_code === cat.category_code);
            if (!items.length) return;
            steps.push({
                id: cat.category_code,
                title: cat.category_name || cat.category_code,
                required: false,
                type: 'quantity',
                maxSelection: groupMax,
                temperatureDependent: needsTemperature,
                sizeDependent: true,
                // ✅ Mark addon/topping steps so gatherWizardSelections can tag items correctly
                isAddonTopping: true,
                options: items.map(item => {
                    const itemNo = item.item_no;
                    const itemName = item.item_desc || item.item_name || '';
                    const images = resolveOptionImageUrl(item, itemNo, itemName, imageCache, baseItem);
                    const compatibleSizes = getToppingSizes(item);
                    return {
                        id: itemNo,
                        name: itemName,
                        price: item.price ?? 0,
                        temp: getItemTemperature(item),
                        size: compatibleSizes,
                        itemMaxQty: parseInt(item.max_qty) || itemMaxQtyMap[itemNo] || null,
                        tqr_image_url: images.tqr_image_url,
                        item_image: images.item_image,
                        image: images.resolved_image,
                        soldOut: item.isSoldOut || false
                    };
                })
            });
        });
    }

    console.log(`✅ Built ${steps.length} wizard steps`);
    return steps;
}

function bindWizardEvents(container, steps, baseItem, onConfirm, editingOrderItemSNo) {
    const visibleSteps = getVisibleSteps();
    const currentStep = visibleSteps[window.currentWizardStep];

    const originalStep = window.wizardSteps?.find(s => s.id === currentStep.id);
    const groupMax = (currentStep.type === 'quantity')
        ? (originalStep?.maxSelection ?? currentStep.maxSelection ?? null)
        : null;

    function getTotalQtySelected() {
        return [...container.querySelectorAll('.qty-display')]
            .reduce((sum, el) => sum + (parseInt(el.textContent) || 0), 0);
    }

    function refreshPlusButtons() {
        if (currentStep.type !== 'quantity') return;
        const total = getTotalQtySelected();
        container.querySelectorAll('.option-row').forEach(row => {
            const optionId = row.dataset.optionId;
            const option = originalStep?.options.find(o => o.id === optionId) ?? currentStep.options.find(o => o.id === optionId);
            const itemMax = option?.itemMaxQty ?? groupMax ?? 99;
            const currentQty = parseInt(row.querySelector('.qty-display')?.textContent) || 0;
            const plusBtn = row.querySelector('.qty-btn.qty-plus');
            if (!plusBtn) return;
            const shouldDisable = (groupMax != null && total >= groupMax) || currentQty >= itemMax;
            plusBtn.disabled = shouldDisable;
            plusBtn.classList.toggle('qty-plus-disabled', shouldDisable);
        });
    }

    const backBtn = container.querySelector('.wizard-back');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            if (window.currentWizardStep <= 0) return;
            window._isGoingBack = true;
            window.currentWizardStep--;
            renderWizardUI(container, baseItem, steps, onConfirm, editingOrderItemSNo);
            scrollModalToTop();
            setTimeout(() => { window._isGoingBack = false; }, 200);
        });
    }

    const nextBtn = container.querySelector('.wizard-next');
    nextBtn.addEventListener('click', () => {
        const isLastStep = window.currentWizardStep === visibleSteps.length - 1;
        saveCurrentStepSelection(currentStep, container);
        if (isLastStep) {
            console.log('🛒 Adding to cart...');
            const selectedAddons = gatherWizardSelections(steps, container);
            console.log('📦 Final selections:', selectedAddons);
            if (onConfirm) {
                onConfirm(selectedAddons, []);
            } else if (typeof addToCart === 'function') {
                addToCart(baseItem.item_no, selectedAddons, [], editingOrderItemSNo, true);
            }
            closeAddonModal();
        } else {
            window._isGoingBack = false;
            window.currentWizardStep++;
            renderWizardUI(container, baseItem, steps, onConfirm, editingOrderItemSNo);
            scrollModalToTop();
        }
    });

    container.querySelectorAll('.option-input').forEach(input => {
        input.addEventListener('change', () => {
            if (window.isRestoringWizardState) return;
            if (input.type === 'radio') {
                updateCardStyling(currentStep.id, input.value, 'single');
                if (ADDON_MODAL_CONFIG.wizard.autoAdvanceOnSelection) handleAutoAdvance(currentStep, container, input);
            } else if (input.type === 'checkbox') {
                const card = input.closest('.option-card');
                if (card) {
                    if (input.checked) {
                        card.classList.add('selected');
                        card.style.borderColor = '#10b981';
                        card.style.backgroundColor = '#f0fdf4';
                        if (ADDON_MODAL_CONFIG.wizard.autoAdvanceOnSelection) handleAutoAdvance(currentStep, container, input);
                    } else {
                        card.classList.remove('selected');
                        card.style.borderColor = '';
                        card.style.backgroundColor = '';
                    }
                }
            }
            updateNextButtonState(container, currentStep);
        });
    });

    container.querySelectorAll('.qty-minus, .qty-plus').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            if (window.isRestoringWizardState) return;
            const optionId = btn.dataset.optionId;
            const row = container.querySelector(`.option-row[data-option-id="${optionId}"]`);
            const qtyDisplay = row.querySelector('.qty-display');
            let qty = parseInt(qtyDisplay.textContent) || 0;
            if (btn.classList.contains('qty-plus')) {
                const option = originalStep?.options.find(o => o.id === optionId) ?? currentStep.options.find(o => o.id === optionId);
                const itemMax = option?.itemMaxQty ?? groupMax ?? 99;
                const total = getTotalQtySelected();
                if (groupMax != null && total >= groupMax) { console.log(`🚫 Group cap reached (${total}/${groupMax})`); return; }
                if (qty >= itemMax) { console.log(`🚫 Item cap reached for ${optionId} (${qty}/${itemMax})`); return; }
                qty++;
            } else if (btn.classList.contains('qty-minus') && qty > 0) {
                qty--;
            }
            qtyDisplay.textContent = qty;
            row.style.borderColor = qty > 0 ? '#10b981' : '';
            row.style.backgroundColor = qty > 0 ? '#f0fdf4' : '';
            console.log('🔢 Quantity changed:', { optionId, newQty: qty, total: getTotalQtySelected(), groupMax });
            refreshPlusButtons();
            updateNextButtonState(container, currentStep);
        });
    });

    refreshPlusButtons();
}

function initializeMenuCache() {
    try {
        const cachedMenu = sessionStorage.getItem('MenuItems');
        const cachedFull = sessionStorage.getItem('FullItems');
        let menuItems = [];
        let fullItems = [];
        if (cachedMenu) {
            const parsed = JSON.parse(cachedMenu);
            if (Array.isArray(parsed)) menuItems = parsed[0]?.items ? parsed.flatMap(s => s.items || []) : parsed;
        }
        if (cachedFull) {
            const parsed = JSON.parse(cachedFull);
            if (Array.isArray(parsed)) fullItems = parsed;
        }
        globalImageCache = buildImageCache(menuItems, fullItems);
    } catch (err) { console.warn('⚠️ Error building image cache:', err); }
}

export function initializeMenuCacheAfterLoad() {
    if (globalImageCache && globalImageCache.size > 0) { console.log('⚡ Image cache already built:', globalImageCache.size); return; }
    console.log('🔧 initializeMenuCacheAfterLoad CALLED');
    try {
        let menuItems = [];
        let fullItems = [];
        const mgr = window.apiManager;
        if (mgr?.loadedData) {
            const mgrMenu = mgr.loadedData.get('MenuItems') || mgr.loadedData.get('menuItems');
            const mgrFull = mgr.loadedData.get('FullItems') || mgr.loadedData.get('items');
            if (Array.isArray(mgrMenu) && mgrMenu.length) {
                if (mgrMenu[0]?.items) menuItems = mgrMenu.flatMap(s => s.items || []);
                else if (mgrMenu[0]?.category) menuItems = mgrMenu.flatMap(s => (s.category || []).flatMap(cat => cat.items || []));
                else menuItems = mgrMenu;
            }
            if (Array.isArray(mgrFull) && mgrFull.length) fullItems = mgrFull;
        }
        if (!fullItems.length) {
            const cacheStoreItems = useCache()?.items || [];
            if (cacheStoreItems.length) fullItems = cacheStoreItems;
        }
        if (!menuItems.length) {
            const cachedMenu = sessionStorage.getItem('MenuItems');
            if (cachedMenu) {
                try {
                    const parsed = JSON.parse(cachedMenu);
                    if (Array.isArray(parsed)) {
                        if (parsed[0]?.items) menuItems = parsed.flatMap(s => s.items || []);
                        else if (parsed[0]?.category) menuItems = parsed.flatMap(s => (s.category || []).flatMap(cat => cat.items || []));
                        else menuItems = parsed;
                    }
                } catch (e) { console.warn('⚠️ MenuItems parse failed:', e.message); }
            }
        }
        if (!fullItems.length) {
            const plainRaw = sessionStorage.getItem('FullItems_plain');
            if (plainRaw) {
                try { fullItems = JSON.parse(plainRaw); } catch (e) { console.warn('⚠️ FullItems_plain parse failed:', e.message); }
            }
        }
        globalImageCache = buildImageCache(menuItems, fullItems);
        console.log('✅ Image cache ready:', { size: globalImageCache?.size });
    } catch (err) { console.error('❌ initializeMenuCacheAfterLoad FAILED:', err.message); }
}

function buildImageCache(menuItems, fullItems) {
    const cache = new Map();
    const allItems = [...(menuItems || []), ...(fullItems || [])];
    let itemsWithImages = 0;
    allItems.forEach(item => {
        const entry = { tqr_image_url: item.tqr_image_url || '', item_image: item.item_image || '' };
        if (entry.tqr_image_url || entry.item_image) itemsWithImages++;
        if (item.item_no) cache.set(item.item_no, entry);
        if (item.citem_no && item.citem_no !== item.item_no) cache.set(item.citem_no, entry);
        const name = (item.item_name || item.citem_name || '').toLowerCase().trim();
        if (name) cache.set(`name:${name}`, entry);
    });
    console.log('✅ Cache built:', { totalEntries: cache.size, itemsWithImages });
    return cache;
}

function resolveOptionImageUrl(item, itemNo, itemName, imageCache, baseItem) {
    let tqrUrl = '';
    let imgUrl = '';
    if (imageCache) {
        const cached = imageCache.get(itemNo) || imageCache.get(`name:${(itemName || '').toLowerCase().trim()}`);
        if (cached) { tqrUrl = cached.tqr_image_url || ''; imgUrl = cached.item_image || ''; }
    }
    if (!tqrUrl && !imgUrl) { tqrUrl = item.tqr_image_url || ''; imgUrl = item.item_image || ''; }
    if (!tqrUrl && !imgUrl) {
        const found = findItemInSessionStorage(itemNo, itemName);
        if (found) { tqrUrl = found.tqr_image_url || ''; imgUrl = found.item_image || ''; }
    }
    if (!tqrUrl && /^[LMS]-/.test(itemName || '')) tqrUrl = resolveBaseDrinkImage(baseItem);
    const source = tqrUrl || imgUrl;
    let resolvedImage = null;
    if (source) {
        if (source.startsWith('public/upload/')) resolvedImage = `/api/GetImageProxy?imageUrl=${encodeURIComponent(source)}`;
        else if (source.startsWith('http') || source.startsWith('/')) resolvedImage = source;
        else resolvedImage = `/api/GetImageProxy?imageUrl=${encodeURIComponent(source)}`;
    }
    return { tqr_image_url: tqrUrl, item_image: imgUrl, resolved_image: resolvedImage };
}

function findItemInSessionStorage(itemNo, itemName) {
    try {
        let allItems = [];
        for (const key of ['MenuItems', 'FullItems']) {
            const raw = sessionStorage.getItem(key);
            if (!raw) continue;
            try {
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) continue;
                parsed.forEach(section => {
                    if (Array.isArray(section.items)) allItems = allItems.concat(section.items);
                    // ✅ nested categories
                    if (Array.isArray(section.category)) {
                        section.category.forEach(cat => {
                            if (Array.isArray(cat.items)) allItems = allItems.concat(cat.items);
                        });
                    }
                });
            } catch (e) { /* ignore */ }
        }
        if (!allItems.length) return null;
        if (itemNo) {
            const byNo = allItems.find(i => (i.item_no === itemNo || i.citem_no === itemNo) && (i.tqr_image_url || i.item_image));
            if (byNo) return byNo;
        }
        if (itemName) {
            const nameLower = itemName.toLowerCase().trim();
            return allItems.find(i => {
                const a = (i.item_name || '').toLowerCase().trim();
                const b = (i.citem_name || '').toLowerCase().trim();
                return (a === nameLower || b === nameLower) && (i.tqr_image_url || i.item_image);
            }) || null;
        }
        return null;
    } catch (e) { console.warn('⚠️ findItemInSessionStorage error:', e); return null; }
}

window.getImageFromMenuCache = getImageFromMenuCache;

function getFilteredStepOptions(step, selectedTemperature) {
    if (!step.temperatureDependent || !selectedTemperature) return step.options;
    return step.options.filter(option => !option.temp || option.temp === selectedTemperature);
}

function shouldShowStep(step, selectedTemperature) {
    if (step.id === 'temperature') return true;
    if (step.id === 'ICE' && selectedTemperature === 'hot') { console.log('  ❌ Hiding ICE step because HOT is selected'); return false; }
    if (!step.temperatureDependent || !selectedTemperature) return true;
    const filteredOptions = getFilteredStepOptions(step, selectedTemperature);
    const shouldShow = filteredOptions.length > 0;
    if (!shouldShow) console.log(`  ❌ Hiding step "${step.title}" - no options for ${selectedTemperature}`);
    return shouldShow;
}

function getVisibleSteps() {
    if (!window.wizardSteps) return [];
    const selectedTemp = window.wizardSelections?.temperature;
    const selectedSize = window.wizardSelections?.size;
    const visible = window.wizardSteps.filter(step => {
        if (step.temperatureDependent && selectedTemp && !shouldShowStep(step, selectedTemp)) return false;
        if (step.sizeDependent && selectedSize && !shouldShowStepBySize(step, selectedSize)) return false;
        return true;
    });
    return visible.length ? visible : window.wizardSteps;
}

function shouldShowStepBySize(step, selectedSize) {
    if (step.id === 'size') return true;
    if (!step.sizeDependent) return true;
    return getFilteredOptionsBySize(step.options, selectedSize).length > 0;
}

function getFilteredOptionsBySize(options, selectedSize) {
    if (!selectedSize) return options;
    return options.filter(opt => {
        if (!opt.size) return true;
        if (Array.isArray(opt.size)) return opt.size.includes(selectedSize);
        return opt.size === selectedSize;
    });
}

window.isRestoringWizardState = false;

function renderWizardUI(container, baseItem, steps, onConfirm, editingOrderItemSNo) {
    const visibleSteps = getVisibleSteps();
    if (window.currentWizardStep >= visibleSteps.length) window.currentWizardStep = visibleSteps.length - 1;
    const currentStep = visibleSteps[window.currentWizardStep];
    const isLastStep = window.currentWizardStep === visibleSteps.length - 1;
    const isEditMode = !!editingOrderItemSNo;
    const canProceed = canProceedToNext(currentStep);

    container.innerHTML = `
        <div class="wizard-container">
           <div class="wizard-header" style="position: relative;">
                <h2 class="wizard-title">${isEditMode ? '✏️ Edit Your Order' : 'Customize Your Order'}</h2>
                <p class="wizard-subtitle">${baseItem.item_desc}</p>
                <button class="wizard-close-btn" onclick="
                    event.stopImmediatePropagation();
                    const modal = document.getElementById('addonModal');
                    if (window._wizardBlockOutsideClick) {
                        modal.removeEventListener('click', window._wizardBlockOutsideClick, { capture: true });
                        window._wizardBlockOutsideClick = null;
                    }
                    if (window.modalState) window.modalState.addonOpen = false;
                    window._blockWSSync = false;
                    modal.classList.remove('show');
                    modal.classList.add('close');
                    const bottomNav = document.querySelector('.bottom-nav');
                    if (bottomNav) bottomNav.classList.remove('hide');
                    updateBottomNavVisibility();
                    setTimeout(() => window.sokWebSocket?.drainPendingCacheUpdate(), 50);
                    " style="position:absolute;top:12px;right:12px;z-index:60;background:#f3f4f6;border:none;border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#374151;flex-shrink:0;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>

            ${ADDON_MODAL_CONFIG.wizard.showProgressBar ? `
            <div class="wizard-progress">
                <div class="progress-steps">
                    ${visibleSteps.map((step, index) => `
                        <div class="progress-step ${index < window.currentWizardStep ? 'completed' : ''} ${index === window.currentWizardStep ? 'active' : ''}">
                            ${index < window.currentWizardStep ? '✓' : index + 1}
                        </div>
                        ${index < visibleSteps.length - 1 ? '<div class="progress-line"></div>' : ''}
                    `).join('')}
                </div>
                <div class="progress-text">Step ${window.currentWizardStep + 1} of ${visibleSteps.length}</div>
            </div>` : ''}

            <div class="wizard-content">
                <h3 class="step-title">
                    ${currentStep.title}${currentStep.required ? ' *' : ''}
                    ${currentStep.maxSelection != null ? `<span class="step-max-badge">(Max ${currentStep.maxSelection})</span>` : ''}
                </h3>
                <div class="step-options">
                    ${renderStepOptions(currentStep)}
                </div>
            </div>

            <div class="wizard-navigation">
                ${window.currentWizardStep > 0 ? `
                    <button class="wizard-btn wizard-back">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="15 18 9 12 15 6"></polyline>
                        </svg>
                        Back
                    </button>
                ` : '<div></div>'}
                <button class="wizard-btn wizard-next ${canProceed ? '' : 'disabled'}" ${canProceed ? '' : 'disabled'} data-loading="0">
                    ${isLastStep ? (isEditMode ? 'Update Cart' : 'Add to Cart') : 'Next'}
                    ${!isLastStep ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>` : ''}
                </button>
            </div>
        </div>
    `;

    setNextButtonLoading(container, true);
    waitForImages(container).then(() => {
        console.log('🖼️ Images ready for step:', currentStep.id);
        setNextButtonLoading(container, false);
    });

    restoreStepSelections(currentStep);
    autoSelectSingleOptionStep(currentStep, container);
    extractSizeFromPrefill();
    bindWizardEvents(container, steps, baseItem, onConfirm, editingOrderItemSNo);

    setTimeout(() => {
        const modal = document.getElementById('addonModal');
        if (modal) modal.scrollTop = 0;
        if (container) container.scrollTop = 0;
    }, 0);
}

function autoSelectSingleOptionStep(step, container) {
    if (!step.required) return;
    const selectedTemp = window.wizardSelections?.temperature;
    const selectedSize = window.wizardSelections?.size;
    let options = step.options;
    if (step.temperatureDependent && selectedTemp) options = options.filter(opt => !opt.temp || opt.temp === selectedTemp);
    if (step.sizeDependent && selectedSize) options = options.filter(opt => { if (!opt.size) return true; if (Array.isArray(opt.size)) return opt.size.includes(selectedSize); return opt.size === selectedSize; });
    if (options.length !== 1) return;
    const onlyOption = options[0];
    window.wizardSelections[step.id] = onlyOption.id;
    console.log(`⚡ Auto-selected single option: ${onlyOption.name} for step: ${step.title}`);
    const radio = container.querySelector(`input[name="step_${step.id}"][value="${onlyOption.id}"]`);
    if (radio) { radio.checked = true; updateCardStyling(step.id, onlyOption.id, 'single'); }
    const visibleSteps = getVisibleSteps();
    const isLastStep = window.currentWizardStep === visibleSteps.length - 1;
    if (!isLastStep && !window._isGoingBack) {
        setTimeout(() => {
            window.currentWizardStep++;
            renderWizardUI(container, window.currentBaseItem, window.wizardSteps, window.wizardOnConfirm, window.editingOrderItemSNo);
            scrollModalToTop();
        }, 300);
    }
}

function updateCardStyling(stepId, selectedValue, type) {
    if (type === 'single') {
        document.querySelectorAll('.option-card').forEach(card => {
            card.classList.remove('selected');
            card.style.borderColor = '';
            card.style.backgroundColor = '';
        });
        const selectedCard = document.querySelector(`input[name="step_${stepId}"][value="${selectedValue}"]`)?.closest('.option-card');
        if (selectedCard) {
            selectedCard.classList.add('selected');
            selectedCard.style.borderColor = '#10b981';
            selectedCard.style.backgroundColor = '#f0fdf4';
        }
    }
}

function restoreStepSelections(step) {
    let saved = window.wizardSelections?.[step.id];
    if (!saved) return;
    console.log(`🔄 Restoring selections for step: ${step.title}`, saved);
    window.isRestoringWizardState = true;
    try {
        if (step.type === 'single') {
            const value = Array.isArray(saved) ? saved[0] : saved;
            const radio = document.querySelector(`input[name="step_${step.id}"][value="${value}"]`);
            if (radio) { radio.checked = true; updateCardStyling(step.id, value, 'single'); }
        }
        if (step.type === 'multiple') {
            const values = Array.isArray(saved) ? saved : [saved];
            values.forEach(val => {
                const checkbox = document.querySelector(`input[name="step_${step.id}"][value="${val}"]`);
                if (checkbox) { checkbox.checked = true; checkbox.closest('.option-card')?.classList.add('selected'); }
            });
        }
        if (step.type === 'quantity') {
            let entries = [];
            if (Array.isArray(saved)) {
                entries = saved.filter(item => item?.id && (item.qty ?? 0) > 0);
            } else if (typeof saved === 'object' && saved !== null) {
                entries = Object.entries(saved).filter(([, qty]) => (parseInt(qty) || 0) > 0).map(([id, qty]) => ({ id, qty: parseInt(qty) }));
            }
            entries.forEach(({ id, qty }) => {
                const row = document.querySelector(`.option-row[data-option-id="${id}"]`);
                if (!row) return;
                const qtyDisplay = row.querySelector('.qty-display');
                if (qtyDisplay) qtyDisplay.textContent = qty;
                if (qty > 0) { row.style.borderColor = '#10b981'; row.style.backgroundColor = '#f0fdf4'; }
            });
        }
    } finally {
        setTimeout(() => {
            window.isRestoringWizardState = false;
            const container = document.getElementById('addonModalContent');
            const visibleSteps = getVisibleSteps();
            const currentStep = visibleSteps[window.currentWizardStep];
            if (container && currentStep) updateNextButtonState(container, currentStep);
        }, 0);
    }
}

// ============================================
// ✅ FIX: gatherWizardSelections — tag topping items with uom/category so addToCart
// can detect them as toppings and apply the parent-qty multiplication correctly.
// ============================================
function gatherWizardSelections(steps, container) {
    const selections = [];
    console.log('📦 Gathering final selections...');
    console.log('Saved selections:', window.wizardSelections);

    steps.forEach((step, index) => {
        const saved = window.wizardSelections?.[step.id];
        console.log(`Step ${index + 1} (${step.id}):`, saved);
        if (!saved) return;
        if (step.id === 'temperature') return;

        if (step.type === 'single') {
            const option = step.options.find(opt => opt.id === saved);
            if (option) {
                selections.push({
                    item_no: saved,
                    item_name: option.name,
                    qty: 1,
                    price: option.price || 0,
                    tqr_image_url: option.tqr_image_url || '',
                    modifier_name: String(step.id),
                    category_code: String(step.id)
                });
            }
        } else if (step.type === 'quantity') {
            if (typeof saved === 'object') {
                Object.entries(saved).forEach(([itemId, qty]) => {
                    if (qty > 0) {
                        const option = step.options.find(opt => opt.id === itemId);
                        if (option) {
                            selections.push({
                                item_no: itemId,
                                item_name: option.name,
                                // ✅ qty here is per-serving qty (what the user selected in the wizard UI).
                                // addToCart will multiply this by parentQty for toppings.
                                qty: qty,
                                price: option.price || 0,
                                tqr_image_url: option.tqr_image_url || '',
                                modifier_name: step.id,
                                category_code: step.id,
                                // ✅ Tag topping steps so addToCart's isTopping() check works
                                uom: step.isAddonTopping ? 'TOPPING' : (option.uom || ''),
                            });
                        }
                    }
                });
            }
        } else if (step.type === 'multiple') {
            if (Array.isArray(saved)) {
                saved.forEach(itemId => {
                    const option = step.options.find(opt => opt.id === itemId);
                    if (option) {
                        selections.push({
                            item_no: itemId,
                            item_name: option.name,
                            qty: 1,
                            price: option.price || 0,
                            tqr_image_url: option.tqr_image_url || '',
                            modifier_name: step.id,
                            category_code: step.id
                        });
                    }
                });
            }
        }
    });

    console.log('✅ Final gathered selections:', selections);
    return selections;
}

function renderStepOptions(step) {
    const selectedTemp = window.wizardSelections?.temperature;
    const selectedSize = window.wizardSelections?.size || null;
    let filteredOptions = step.options;

    if (step.temperatureDependent && selectedTemp) {
        const before = filteredOptions.length;
        filteredOptions = filteredOptions.filter(opt => !opt.temp || opt.temp === selectedTemp);
        console.log(`  🌡️ Temperature filter: ${before} → ${filteredOptions.length}`);
    }

    if (selectedSize) {
        const hasAnyPrefix = filteredOptions.some(opt => /^\([LMS]\)/i.test(opt.name || ''));
        if (hasAnyPrefix) {
            const sizeInitial = { large: 'L', medium: 'M', small: 'S' }[selectedSize];
            const before = filteredOptions.length;
            filteredOptions = filteredOptions.filter(opt => {
                const name = opt.name || '';
                const hasSizePrefix = /^\([LMS]\)/i.test(name);
                if (!hasSizePrefix) return true;
                return new RegExp(`^\\(${sizeInitial}\\)`, 'i').test(name);
            });
            console.log(`  📏 Size filter (${selectedSize} → ${sizeInitial}): ${before} → ${filteredOptions.length}`);
        }
    }

    const optionsWithImages = filteredOptions.map(option => {
        let resolvedImage = option.image;
        if (!resolvedImage && (option.tqr_image_url || option.item_image)) {
            if (typeof resolveImageUrl === 'function') {
                resolvedImage = resolveImageUrl({ item_name: option.name, tqr_image_url: option.tqr_image_url || '', item_image: option.item_image || '' }, null);
            } else {
                const source = option.tqr_image_url || option.item_image || '';
                if (source?.startsWith('public/upload/')) resolvedImage = `/api/GetImageProxy?imageUrl=${encodeURIComponent(source)}`;
            }
        }
        return { ...option, image: resolvedImage };
    });

    if (step.type === 'single') {
        return `<div class="options-grid options-single">
            ${optionsWithImages.map(option => {
            const hasImage = option.image?.trim();
            return `<label class="option-card ${option.soldOut ? 'opacity-50' : ''}" data-option-id="${option.id}">
                    <input type="radio" name="step_${step.id}" value="${option.id}" class="option-input" ${option.soldOut ? 'disabled' : ''}>
                    ${option.icon ? `<div class="option-icon">${option.icon}</div>` : ''}
                    ${hasImage ? `<img src="${option.image}" class="option-image" alt="${option.name}" loading="lazy">` : ''}
                    <div class="option-name">${option.name}</div>
                    ${option.price > 0 ? `<div class="option-price">$${option.price.toFixed(2)}</div>` : ''}
                    ${option.soldOut ? `<div class="text-xs text-red-500 mt-1">Sold Out</div>` : ''}
                </label>`;
        }).join('')}
        </div>`;
    } else if (step.type === 'quantity') {
        return `<div class="options-list">
            ${optionsWithImages.map(option => {
            const hasImage = option.image?.trim();
            return `<div class="option-row ${option.soldOut ? 'opacity-50' : ''}" data-option-id="${option.id}">
                    ${hasImage ? `<img src="${option.image}" class="option-image-small" alt="${option.name}" loading="lazy">` : ''}
                    <div class="option-info">
                        <div class="option-name">${option.name}</div>
                        ${option.price > 0 ? `<div class="option-price">+$${option.price.toFixed(2)}</div>` : ''}
                        ${option.soldOut ? `<div class="text-xs text-red-500">Sold Out</div>` : ''}
                    </div>
                    <div class="qty-controls">
                        <button class="qty-btn qty-minus" data-option-id="${option.id}" ${option.soldOut ? 'disabled' : ''}>−</button>
                        <span class="qty-display">0</span>
                        <button class="qty-btn qty-plus" data-option-id="${option.id}" ${option.soldOut ? 'disabled' : ''}>+</button>
                    </div>
                </div>`;
        }).join('')}
        </div>`;
    } else if (step.type === 'multiple') {
        return `<div class="options-grid options-multiple">
            ${optionsWithImages.map(option => {
            const hasImage = option.image?.trim();
            return `<label class="option-card ${option.soldOut ? 'opacity-50' : ''}" data-option-id="${option.id}">
                    <input type="checkbox" name="step_${step.id}" value="${option.id}" class="option-input" ${option.soldOut ? 'disabled' : ''}>
                    ${hasImage ? `<img src="${option.image}" class="option-image" alt="${option.name}" loading="lazy">` : ''}
                    <div class="option-name">${option.name}</div>
                    ${option.price > 0 ? `<div class="option-price">+$${option.price.toFixed(2)}</div>` : ''}
                    ${option.soldOut ? `<div class="text-xs text-red-500 mt-1">Sold Out</div>` : ''}
                </label>`;
        }).join('')}
        </div>`;
    }
}

function handleAutoAdvance(currentStep, container, input) {
    const visibleSteps = getVisibleSteps();
    const isLastStep = window.currentWizardStep === visibleSteps.length - 1;
    if (isLastStep) return;
    if (input.type === 'checkbox' && !canProceedToNext(currentStep, container)) return;
    console.log('⚡ Auto-advancing to next step...');
    saveCurrentStepSelection(currentStep, container);
    const delay = input.type === 'checkbox' ? 600 : 400;
    setTimeout(() => {
        const expectedStepId = visibleSteps[window.currentWizardStep]?.id;
        if (expectedStepId === currentStep.id) {
            window.currentWizardStep++;
            renderWizardUI(container, window.currentBaseItem || {}, window.wizardSteps || [], window.wizardOnConfirm, window.editingOrderItemSNo);
            scrollModalToTop();
        }
    }, delay);
}

function saveCurrentStepSelection(step, container) {
    if (!window.wizardSelections) window.wizardSelections = {};
    if (step.type === 'single') {
        const selected = container.querySelector(`input[name="step_${step.id}"]:checked`);
        if (selected) {
            window.wizardSelections[step.id] = selected.value;
            const label = selected.closest('.option-card');
            const itemName = label?.querySelector('.option-name')?.textContent?.trim() || '';
            if (/^L-/i.test(itemName)) window.wizardSelections.size = 'large';
            else if (/^M-/i.test(itemName)) window.wizardSelections.size = 'medium';
            else if (/^S-/i.test(itemName)) window.wizardSelections.size = 'small';
            console.log('💾 Saved selection:', step.id, selected.value, '| size:', window.wizardSelections.size);
        }
    } else if (step.type === 'quantity') {
        const quantities = {};
        container.querySelectorAll('.option-row').forEach(row => {
            const qty = parseInt(row.querySelector('.qty-display').textContent);
            if (qty > 0) quantities[row.dataset.optionId] = qty;
        });
        window.wizardSelections[step.id] = quantities;
        console.log('💾 Saved quantity selections:', step.id, quantities);
    } else if (step.type === 'multiple') {
        const selected = Array.from(container.querySelectorAll(`input[name="step_${step.id}"]:checked`)).map(input => input.value);
        window.wizardSelections[step.id] = selected;
        console.log('💾 Saved multiple selections:', step.id, selected);
    }
}

function updateNextButtonState(container, step) {
    const nextBtn = container.querySelector('.wizard-next');
    if (!nextBtn) return;
    const can = canProceedToNext(step, container);
    nextBtn.classList.toggle('disabled', !can);
    nextBtn.disabled = !can;
}

function canProceedToNext(step, container = null) {
    if (!step.required) return true;
    if (container) {
        if (step.type === 'single') return !!container.querySelector(`input[name="step_${step.id}"]:checked`);
        if (step.type === 'quantity') return Array.from(container.querySelectorAll('.option-row .qty-display')).some(el => (parseInt(el.textContent) || 0) > 0);
        return true;
    }
    const saved = window.wizardSelections?.[step.id];
    if (step.type === 'single') return !!saved && saved !== '';
    if (step.type === 'quantity') {
        if (!saved || typeof saved !== 'object') return false;
        return Object.values(saved).some(qty => (parseInt(qty) || 0) > 0);
    }
    return true;
}

function waitForImages(container) {
    const images = Array.from(container.querySelectorAll('img'));
    if (!images.length) return Promise.resolve();
    return Promise.all(images.map(img => {
        if (img.complete && img.naturalHeight !== 0) return Promise.resolve();
        return new Promise(resolve => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
        });
    }));
}

function setNextButtonLoading(container, isLoading) {
    const nextBtn = container.querySelector('.wizard-next');
    if (!nextBtn) return;
    nextBtn.dataset.loading = isLoading ? '1' : '0';
    if (isLoading) {
        nextBtn.disabled = true;
        nextBtn.classList.add('loading');
    } else {
        const visibleSteps = getVisibleSteps();
        const currentStep = visibleSteps[window.currentWizardStep];
        const canProceed = canProceedToNext(currentStep);
        nextBtn.disabled = !canProceed;
        nextBtn.classList.remove('loading');
        nextBtn.classList.toggle('disabled', !canProceed);
    }
}

function detectTemperatureFromCartItem(prefilledAddons, itemmasterItems) {
    console.log('🌡️ Detecting temperature from cart item...');
    for (const addon of prefilledAddons) {
        const itemNo = addon.item_no || addon.citem_no;
        const temp = getItemTemperature(addon);
        if (temp) { console.log(`  ✅ Detected ${temp.toUpperCase()} from addon`); return temp; }
        if (itemmasterItems) {
            const masterItem = itemmasterItems.find(item => item.citem_no === itemNo || item.item_no === itemNo);
            if (masterItem) {
                const masterTemp = getItemTemperature(masterItem);
                if (masterTemp) { console.log(`  ✅ Detected ${masterTemp.toUpperCase()} from master item`); return masterTemp; }
            }
        }
    }
    console.log('  ℹ️ No temperature detected');
    return null;
}

// ============================================
// TRADITIONAL MODAL
// ============================================
function showTraditionalModal(baseItem, onConfirm, addonData, remarksData, prefilledAddons, prefilledRemarks, editingOrderItemSNo) {
    showAddOnModalOriginal(baseItem, onConfirm, addonData, remarksData, prefilledAddons, prefilledRemarks, editingOrderItemSNo);
}

// ============================================
// SCROLL HELPER
// ============================================
export function scrollModalToTop() {
    const modal = document.getElementById('addonModal');
    const modalContent = document.getElementById('addonModalContent');
    if (modal) modal.scrollTo({ top: 0, behavior: 'smooth' });
    if (modalContent) modalContent.scrollTo({ top: 0, behavior: 'smooth' });
}


// ============================================
// GLOBALS
// ============================================
window.showAddOnModal = showAddOnModal;
window.ADDON_MODAL_CONFIG = ADDON_MODAL_CONFIG;
window.autoScrollToTab = autoScrollToTab;
window.scrollToTab = scrollToTab;
window.ensureSubcategoryVisibility = ensureSubcategoryVisibility;
window.updateActiveTabStates = updateActiveTabStates;
window.navigateToCategory = navigateToCategory;
window.restoreStepSelections = restoreStepSelections;
window.renderStepOptions = renderStepOptions;
window.detectTemperatureFromCartItem = detectTemperatureFromCartItem;
window.prefillWizardSelections = prefillWizardSelections; // (wizardSteps, prefilledAddons, itemmasterItems, editingOrderItemSNo)
window.saveCurrentStepSelection = saveCurrentStepSelection;
window.getVisibleSteps = getVisibleSteps;
window.handleAutoAdvance = handleAutoAdvance;

window.debugWizardState = function () {
    console.group('🔍 Wizard State Debug');
    console.log('Current Step:', window.currentWizardStep);
    console.log('Total Steps:', window.wizardSteps?.length);
    console.log('Wizard Selections:', window.wizardSelections);
    console.log('Selected Addons:', window.selectedAddons);
    console.log('Editing S_NO:', window.editingOrderItemSNo);
    if (window.wizardSteps) {
        window.wizardSteps.forEach((step, i) => {
            console.log(`  ${i + 1}. ${step.title} (${step.type})`, { id: step.id, options: step.options.length, required: step.required, selection: window.wizardSelections?.[step.id] });
        });
    }
    console.groupEnd();
};