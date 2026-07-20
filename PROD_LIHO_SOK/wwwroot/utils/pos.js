"use client";

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
    MODIFIER_2_STARTING_DS_NO,
    PROMO_BY
} from "../utils/constants.js";


import { bool, clone, contains, getNowInAPIFormat, same } from "../utils/common.js";
import { useCache } from "../stores/cache-store.js";
import { useOrder } from "../stores/order-store.js";
import { issueEberPoints, voidEberVoucherTransaction } from "../utils/ascentisCRM.js";
//import { issueEberPoints, voidEberVoucherTransaction } from "../utils/eber.js";
import { checkStocks } from '../js/netApi.js';
dayjs.extend(dayjs_plugin_isBetween);

// ✅ use the plugin loaded via CDN
/**
 * Common POS related functions:
 *
 * sequenceOrderItems                               : sequence order items for modifier item.
 * desequenceOrderItems                             : desequence order items for modifier item.
 * getRounding                                      : get rounding adjustment amount in order.
 * calcRemainingTenderAmt                           : calculate remaining tender amount needed to be paid.
 * calcOrderAmt                                     : calculate and update order amounts.
 * getPriceByServiceType                            : get price based on service type.
 * calcOrderItemDiscount                            : calculate and return order item with discount.
 * goodToApplyDisc                                  : check if discount can be applied to the order item.
 * isAbsorbTax                                      : get is absorb tax based on service type.
 * addTax                                           : calculate and return order item with tax amount.
 * haveCashPayment                                  : check if there is a cash payment in payment list.
 * onlyCashPayments                                 : check if all payments are cash payments.
 * calcOrderItemSubtotal                            : calculate and return order item with subtotal.
 * isWeightableItem                                 : check if the item is weightable.
 * getSetting                                       : get store setting based on main group name, group name and setting code.
 * authorised                                       : check user rights for the action.
 * getItemDisplayName                               : get menu item display name.
 * openSecondScreen                                 : open second display.
 * sortModifierAddonItems                           : sort by seq_no.
 * availableNow                                     : check if the item is available now.
 * getRootAndSelectedCategories                     : get root and selected categories based on current selected menu item.
 * getPromo                                         : get promo linked to the item.
 * sortOrderItems                                   : sort order items ascendingly.
 * applyPromotions                                  : process and apply promotion logic to order items.
 * getFreeItems                                     : get free items based on criteria type.
 * insertDiscountName                               : insert discount name to order item.
 * isDeliveryPartnersIntegrated                     : check if delivery partners are integrated.
 * getSysSetting                                    : get system setting value by group name and param id.
 * getOrderItemsDiff                                : get order items diff.
 * getNewOrder                                      : get new order.
 * getLastSNo                                       : get last s_no.
 * formatOrderItemsToParentChild                    : convert order items to parent-children format.
 * autoRefreshOrders                                : auto refresh orders.
 * resetRounding                                    : reset rounding.
 * needMandatoryItemRemarks                         : check if item needs mandatory remarks.
 * processTotalDiscountPromo                        : process total discount promo.
 * getNowWithLoginDate                              : get now with login date.
 * getAvailableServiceTypes                         : get available service types.
 * getMenuItems                                     : get menu items.
 * getMenuCategoryColumns                           : get menu category columns.
 * getMenuCategoryRows                              : get menu category rows.
 * getMenuItemColumns                               : get menu item columns.
 * getMenuItemRows                                  : get menu item rows.
 * checkCashReconStatus                             : check cash recon status.
 * getDefaultOrderPage                              : get default order page.
 * notSecondScreen                                  : check if not second screen.
 * logout                                           : logout.
 * isOpenItem                                       : check if item is open item.
 * isAddonItem                                      : check if item is addon item.
 * calcSetMemuItemPrice                             : calculate set menu item price.
 * minimiseSNo                                      : minimise s_no.
 * canGenerateTableQR                               : check if can generate table QR.
 * getOrdersRefreshInterval                         : get orders refresh interval.
 * preprocessKitchenInfo                            : preprocess kitchen info.
 * needCaptureTableNo                               : determine if table number should be captured.
 * needRounding                                     : determine if rounding is needed.
 * getNewPreOrder                                   : get new pre order.
 * processAutoLogout                                : process auto logout.
 * haveActiveOrdersPage                             : check if active orders page is available.
 * getSalesServiceDtls                              : get sales service details.
 */

/**
 * Sequences order items for modifier items.
 * @param {any[]} orderItems - The array of order items to sequence.
 * @param {string} [s_no] - Optional sequence number.
 * @returns {any[]} The sequenced order items.
 */
export const sequenceOrderItems = (orderItems, s_no) => {
    let result = [];
    clone(orderItems)?.forEach((item) => {
        if (item?.qty > 0) {
            result.push({
                ...item,
                parent_sno: s_no ? s_no : orderItems[0]?.s_no,
            });
        }
    });
    return result;
};

/**
 * Desequences order items for modifier items.
 * @param {any[]} orderItems - The array of order items to desequence.
 * @returns {any[]} The desequenced order items.
 */
export const desequenceOrderItems = (orderItems) => {
    return orderItems?.map((item) => ({
        ...item,
        parent_sno: item?.ds_no,
    }));
};

/**
 * Calculates the rounding adjustment amount in an order.
 * @param {string} net_amt - The net amount to round.
 * @param {number} rounding_precision - The rounding precision.
 * @param {number} [rounding_type] - The rounding type (1: round up, 0: round down).
 * @returns {string} The rounding adjustment amount.
 */
export const getRounding = (net_amt, rounding_precision, rounding_type) => {
    const lastChar = net_amt.slice(-1);
    let new_net_amt = "0.00";

    if (lastChar === "0") {
        new_net_amt = net_amt;
    }
    else if (rounding_type === 1) {
        if (rounding_precision === 5 && parseFloat(lastChar) < 5) {
            new_net_amt = net_amt.slice(0, -1) + "5";
        }
        else if (rounding_precision === 5 && parseFloat(lastChar) === 5) {
            new_net_amt = net_amt;
        }
        else if (rounding_precision === 5 && parseFloat(lastChar) > 5) {
            const a = parseFloat(net_amt) + parseFloat(".05");
            const b = a.toFixed(2);
            new_net_amt = b.slice(0, -1) + "0";
        }
        else if (rounding_precision === 10) {
            const a = parseFloat(net_amt) + parseFloat(".10");
            const b = a.toFixed(2);
            new_net_amt = b.slice(0, -1) + "0";
        }
    }
    else if (rounding_type === 0) {
        if (rounding_precision === 5 && parseFloat(lastChar) < 5) {
            new_net_amt = net_amt.slice(0, -1) + "0";
        }
        else if (rounding_precision === 5 && parseFloat(lastChar) === 5) {
            new_net_amt = net_amt;
        }
        else if (rounding_precision === 5 && parseFloat(lastChar) > 5) {
            new_net_amt = net_amt.slice(0, -1) + "5";
        }
        else if (rounding_precision === 10) {
            new_net_amt = net_amt.slice(0, -1) + "0";
        }
    }
    else if (rounding_type === 2) {
        if (rounding_precision === 5) {
            const lastDigit = parseFloat(lastChar);
            if (lastDigit < 3) {
                new_net_amt = net_amt.slice(0, -1) + "0";
            } else if (lastDigit >= 3 && lastDigit < 8) {
                new_net_amt = net_amt.slice(0, -1) + "5";
            } else {
                const a = parseFloat(net_amt) + parseFloat(".10");
                const b = a.toFixed(2);
                new_net_amt = b.slice(0, -1) + "0";
            }
        }
        else if (rounding_precision === 10) {
            const lastDigit = parseFloat(lastChar);
            if (lastDigit < 5) {
                new_net_amt = net_amt.slice(0, -1) + "0";
            } else {
                const a = parseFloat(net_amt) + parseFloat(".10");
                const b = a.toFixed(2);
                new_net_amt = b.slice(0, -1) + "0";
            }
        }
    }
    const round_adj_amt = parseFloat(new_net_amt) - parseFloat(net_amt);
    return round_adj_amt.toFixed(2);
};

/**
 * Calculates the remaining tender amount needed to be paid.
 * @param {number} net_amt - The net amount of the order.
 * @param {any[]} payments - The array of payments made.
 * @returns {string} The remaining tender amount.
 */
export const calcRemainingTenderAmt = (net_amt, payments, payment) => {
    const { order: activeOrder } = useOrder();

    const thisOrder = activeOrder;

    const tender_amt = payments
        ?.map((item) => parseFloat(item?.tender_amt))
        ?.reduce((acc, val) => acc + val, 0);

    let remaining_tender_amt = net_amt - tender_amt;

    if (
        !same(payment?.payment_type, "C") &&
        thisOrder?.splitTo &&
        thisOrder?.netAmtPerPax &&
        payments?.length + 1 < thisOrder?.splitTo
    ) {
        remaining_tender_amt = parseFloat(thisOrder?.netAmtPerPax);
    }

    if (net_amt > 0 && tender_amt > net_amt) {
        remaining_tender_amt = 0;
    }

    return remaining_tender_amt.toFixed(2);
};

/**
 * Calculates and updates order amounts.
 * @param {any} order - The order object.
 * @param {any[]} [orderItems] - Optional array of order items.
 * @returns {any} The updated order object with calculated amounts.
 */
export const calcOrderAmt = (order, orderItems) => {
    const items = orderItems || order?.sales_dtls || [];

    // ── 1. Absorb tax flag ─────────────────────────────────────────────────
    const shouldAbsorb =
        order?.absorb_tax === "Y" ||
        order?.tax_type === "I" ||
        (items.length > 0 && (items[0].is_absorbtax === 1 || items[0].header_is_absorbtax === "Y"));

    // ── 2. Exclude modifier parent placeholders from totals ────────────────
    const modifierParentSnos = new Set(
        items
            .filter(i => i.modifier_name && i.modifier_name !== '')
            .map(i => String(i.parent_sno))
    );
    const isModifierParent = (item) =>
        modifierParentSnos.has(String(item.s_no)) &&
        String(item.s_no) === String(item.parent_sno);

    // ── 3. Promote size variant price to parent ────────────────────────────
    // For combo/size-variant items, the parent row carries base price and
    // the child row (with modifier_name set + unit_price > 0) carries the
    // actual selected size price. Promote child price to parent and zero
    // child to avoid double-counting — mirrors modifier parent pattern above.
    const pricedChildByParent = new Map();
    items.forEach(item => {
        if (String(item.s_no) === String(item.parent_sno)) return; // skip parents
        if (!item.modifier_name || item.modifier_name === '') return; // must have modifier_name
        if (parseFloat(item.unit_price || 0) === 0) return;          // must be priced
        // Only record first priced child per parent
        const parentKey = String(item.parent_sno);
        if (!pricedChildByParent.has(parentKey)) {
            pricedChildByParent.set(parentKey, item);
        }
    });

    const normalizedItems = items.map(item => {
        const key = String(item.s_no);
        const pricedChild = pricedChildByParent.get(key);

        // Parent with a priced child → promote child price to parent
        if (pricedChild && String(item.s_no) === String(item.parent_sno)) {
            const variantPrice = parseFloat(pricedChild.unit_price || 0);
            const qty = parseFloat(item.qty || 1);
            return {
                ...item,
                unit_price: variantPrice,
                sub_total: (variantPrice * qty).toFixed(2),
                tax_amt: pricedChild.tax_amt,
            };
        }

        // Priced size variant child → zero out to avoid double count
        if (
            String(item.s_no) !== String(item.parent_sno) &&
            item.modifier_name && item.modifier_name !== '' &&
            parseFloat(item.unit_price || 0) > 0 &&
            pricedChildByParent.get(String(item.parent_sno))?.s_no === item.s_no
        ) {
            return {
                ...item,
                unit_price: 0,
                sub_total: '0.00',
                tax_amt: '0.000000',
            };
        }

        return item;
    });

    // ── 4. Raw (unrounded) accumulators — use normalizedItems ─────────────
    const raw_sub_total = normalizedItems.reduce((acc, item) =>
        isModifierParent(item) ? acc : acc + parseFloat(item?.sub_total || 0), 0);
    const raw_total_disc = normalizedItems.reduce((acc, item) =>
        acc + parseFloat(item?.pro_disc_amt || 0), 0);
    const raw_total_svc = normalizedItems.reduce((acc, item) =>
        isModifierParent(item) ? acc : acc + parseFloat(item?.svc_amt || 0), 0);
    const raw_total_tax = normalizedItems.reduce((acc, item) =>
        isModifierParent(item) ? acc : acc + parseFloat(item?.tax_amt || 0), 0);
    const raw_absorbed = normalizedItems.reduce((acc, item) => {
        if (isModifierParent(item)) return acc;
        const itemAbsorb = item.is_absorbtax === 1 || item.header_is_absorbtax === "Y";
        return (shouldAbsorb || itemAbsorb)
            ? acc + parseFloat(item?.tax_amt || 0)
            : acc;
    }, 0);
    const raw_round_adj = parseFloat(order?.round_adj_amt || 0);

    // ── 5. Format ──────────────────────────────────────────────────────────
    const sub_total = raw_sub_total.toFixed(2);
    const total_disc = raw_total_disc.toFixed(2);
    const total_svc = raw_total_svc.toFixed(2);
    const total_tax = raw_total_tax.toFixed(2);
    const total_tax_absorbed = raw_absorbed.toFixed(2);
    const round_adj_amt = raw_round_adj.toFixed(2);

    // ── 6. Net amount ──────────────────────────────────────────────────────
    const net_amt = (
        raw_sub_total
        - raw_total_disc
        + raw_total_svc
        + raw_total_tax
        - raw_absorbed
        + raw_round_adj
    ).toFixed(2);

    console.log("📊 [Final Calc] Trace:", {
        sub: sub_total,
        net: net_amt,
        taxAbsorbed: total_tax_absorbed,
        absorbFlag: shouldAbsorb ? "Y" : "N",
        modifierParentsExcluded: [...modifierParentSnos],
        sizeVariantParentsPromoted: [...pricedChildByParent.keys()], // ← new
    });

    return {
        ...order,
        sales_dtls: items,          // ← always return ORIGINAL items unchanged
        absorb_tax: shouldAbsorb ? "Y" : (order?.absorb_tax || "N"),
        sub_total,
        total_disc,
        total_svc,
        total_tax,
        total_tax_absorbed,
        round_adj_amt,
        net_amt,
    };
};

/**
 * Gets the price based on service type.
 * @param {any} price - The price object.
 * @param {string} [service_type] - Optional service type.
 * @returns {number} The price for the given service type.
 */
export const getPriceByServiceType = (priceObj, service_type) => {
    const { order: activeOrder } = useOrder();
    //const serviceType = activeOrder?.service_type || "E"; // default to dine-in
    if (!priceObj) return 0;
    if (!service_type) {
        service_type = localStorage.getItem("orderType");
    }
    //console.log("priceObj", priceObj);
    switch (service_type) {
        case "Q":
        case "E":
            return priceObj.dine_in_price ?? priceObj.default_price ?? 0;
        case "T":
            return priceObj.takeaway_price ?? priceObj.default_price ?? 0;
        case "D":
            return priceObj.delivery_price ?? priceObj.default_price ?? 0;
    }
};


/**
 * Calculates and returns order item with discount.
 * @param {any} orderItem - The order item object.
 * @param {any} discount - The discount object.
 * @param {any[]} orderItems - The array of order items.
 * @returns {any} The updated order item with calculated discount.
 */
export const calcOrderItemDiscount = (orderItem, discount, orderItems, isChildItem = false) => {
    const { disc_type, disc_name, disc_value } = discount || {};

    const parentItem = useCache()?.items?.find(
        (item) =>
            item?.item_no ===
            orderItems?.find((item) => item?.s_no === orderItem.parent_sno)?.item_no
    );

    const parent_menu_type =
        Array.isArray(parentItem?.itemmaster_menutype) &&
        parentItem?.itemmaster_menutype[0]?.menu_type;

    const isNonAlacarteChildItem = !!(
        (orderItem.s_no !== orderItem.parent_sno && parent_menu_type) ||
        (orderItem.s_no !== orderItem.parent_sno &&
            bool(parentItem?.is_addon_enable) &&
            parentItem?.add_on_name)
    );

    const isAlacarteItem = !!(
        orderItem.s_no === orderItem.parent_sno && !parent_menu_type
    );

    let sub_total =
        isNonAlacarteChildItem || isAlacarteItem
            ? isModifierItem(orderItem) && same(parent_menu_type, "S") && orderItem?.ref_5
                ? 0
                : orderItem.qty * orderItem.unit_price
            : 0;

    const lineGross = (Number(orderItem?.qty) || 0) * (Number(orderItem?.unit_price) || 0);
    if (isChildItem && lineGross !== 0) {
        sub_total = lineGross;
    }

    if (disc_name && disc_name !== "None") {
        let disc_amt = 0;
        switch (disc_type) {
            case "V":
            case "$":
            case "A":
                if (isNonAlacarteChildItem && !isChildItem) {
                    const line_sub_total = sub_total;
                    const total = orderItems
                        ?.filter((item) => item?.parent_sno === orderItem.parent_sno)
                        ?.map((item) => item?.unit_price * item?.qty)
                        ?.reduce((acc, val) => acc + val, 0);
                    const parentQty =
                        Number(orderItems?.find((item) => item?.s_no === orderItem.parent_sno)?.qty) ||
                        Number(orderItem?.qty) || 0;
                    const totalDiscValue = disc_value * parentQty;
                    disc_amt = total !== 0 ? (totalDiscValue / total) * line_sub_total : line_sub_total;
                    disc_amt = line_sub_total >= 0 ? Math.abs(disc_amt) : -Math.abs(disc_amt);
                    disc_amt = line_sub_total >= 0 ? Math.min(disc_amt, line_sub_total) : Math.max(disc_amt, line_sub_total);
                    sub_total = sub_total - disc_amt;
                } else {
                    const totalDiscValue = disc_value * orderItem.qty;
                    disc_amt = sub_total >= 0 ? Math.min(totalDiscValue, sub_total) : Math.max(totalDiscValue, sub_total);
                    sub_total = sub_total - disc_amt;
                }
                break;
            case "P":
            case "%":
                disc_amt = (sub_total * disc_value) / 100;
                sub_total = sub_total - disc_amt;
                break;
        }
        return addTax({ ...orderItem, disc_type, disc_name, disc_value, disc_amt: disc_amt.toFixed(2), sub_total });
    } else {
        return addTax({ ...orderItem, disc_type: "N", disc_name: "None", disc_value: 0, disc_amt: "0.00", sub_total });
    }
};

/**
 * Checks if discount can be applied to the order item.
 * @param {any} orderItem - The order item object.
 * @param {any} discount - The discount object.
 * @param {any[]} orderItems - The array of order items.
 * @returns {boolean} True if discount can be applied, false otherwise.
 */
export const goodToApplyDisc = (orderItem, discount, orderItems) => {
    const items = Array.isArray(useCache()?.items) ? useCache()?.items : [];
    const item = items.find(
        (item) => item?.item_no === orderItem?.item_no
    );
    const menu_type = Array.isArray(item?.itemmaster_menutype)
        ? item?.itemmaster_menutype[0]?.menu_type
        : "";
    let sub_total = orderItem?.qty * orderItem?.unit_price;
    sub_total = orderItems
        ?.filter((item) => item?.parent_sno === orderItem.s_no)
        ?.map((item) => item?.qty * item?.unit_price)
        ?.reduce((acc, val) => acc + val, 0);
    return !(
        (discount?.disc_type === "V" || discount?.disc_type === "$") &&
        sub_total < discount?.disc_value
    );
};

/**
 * Gets is absorb tax based on service type.
 * @param {any} item - The item object.
 * @returns {boolean} True if tax is absorbed, false otherwise.
 */
export const isAbsorbTax = (item) => {
    // Use existing hooks/state managers
    const { store } = useCache?.() || {};
    const { order: activeOrder } = useOrder?.() || {};

    const serviceType = activeOrder?.service_type || localStorage.getItem("orderType");

    // Initialize with store-level default
    let is_absorbtax = store?.is_absorbtax;

    // Check if GST behavior is governed by mode of sales
    const ENABLE_GST_BY_MODE_OF_SALES = bool(
        getSetting("GENERAL SETTINGS", "ORDERING", "ENABLE_GST_BY_MODE_OF_SALES")
    );
    console.log("serviceType", serviceType);
    if (ENABLE_GST_BY_MODE_OF_SALES) {
        switch (serviceType) {
            case "Q": // Quick Service / QR
                is_absorbtax = ENABLE_GST_BY_MODE_OF_SALES
                    ? getSetting("GENERAL SETTINGS", "ORDERING", "QUICK_SERVICE_TAX_ABSORB")
                    : item?.quickservice_is_absorbtax;
                break;
            case "E": // Dine In
                is_absorbtax = ENABLE_GST_BY_MODE_OF_SALES
                    ? getSetting("GENERAL SETTINGS", "ORDERING", "DINE_IN_TAX_ABSORB")
                    : item?.dine_in_is_absorbtax;
                break;
            case "T": // Take Away
                is_absorbtax = ENABLE_GST_BY_MODE_OF_SALES
                    ? getSetting("GENERAL SETTINGS", "ORDERING", "TAKE_AWAY_TAX_ABSORB")
                    : item?.take_away_is_absorbtax;
                break;
            case "D": // Delivery
                is_absorbtax = ENABLE_GST_BY_MODE_OF_SALES
                    ? getSetting("GENERAL SETTINGS", "ORDERING", "DELIVERY_TAX_ABSORB")
                    : item?.delivery_is_absorbtax;
                break;
        }
    }

    // Final Conversion: Ensure we return a strict Boolean for calcOrderAmt filtering
    // Returns true if value is 1, "1", "Y", or true
    return (
        is_absorbtax === 1 ||
        is_absorbtax === "1" ||
        is_absorbtax === "Y" ||
        is_absorbtax === true
    );
};


/**
 * Calculates and returns order item with tax amount.
 * @param {any} orderItem - The order item object.
 * @returns {any} The updated order item with calculated tax amount.
 */
export const addTax = (orderItem) => {
    const { svcs } = useCache();
    const { order: activeOrder } = useOrder();
    const serviceType = activeOrder?.service_type;
    const service_type = orderItem?.take_away_item === "Y" ? "T" : serviceType;

    // ✅ Add safety check
    const svc = Array.isArray(svcs)
        ? svcs.find((item) => item?.service_type === service_type)
        : null;

    const service_by = svc?.service_by;
    const service_value = svc?.service_value || 0;

    // ✅ FIX: Use sub_total directly (it's already discounted)
    // Don't subtract pro_disc_amt because the discount was already applied to unit_price
    const total = parseFloat(orderItem?.sub_total || 0);

    let svc_amt = 0;
    switch (service_by) {
        case "V":
        case "$":
            svc_amt = service_value;
            break;
        case "P":
        case "%":
            svc_amt = (total * service_value) / 100;
            break;
        default:
            svc_amt = 0;
    }

    let tax_amt = 0;
    if (isAbsorbTax(orderItem)) {
        tax_amt =
            ((total + svc_amt) * parseFloat(orderItem?.tax_value || 0)) /
            (100 + parseFloat(orderItem?.tax_value || 0));
    } else {
        tax_amt = ((total + svc_amt) * parseFloat(orderItem?.tax_value || 0)) / 100;
    }

    return {
        ...orderItem,
        svc_amt: svc_amt.toFixed(6),
        tax_amt: tax_amt.toFixed(6),
    };
};

/**
* Checks if there is a cash payment in payment list.
* @param {any[]} payments - The array of payments.
* @returns {boolean} True if there is a cash payment, false otherwise.
*/
export const haveCashPayment = (payments) => {
    const cashPayments = payments?.filter((item) => item?.payment_type === "C");
    const cashPaymentModes = useCache()?.paymentModes?.find(
        (item) => item?.payment_type === "C"
    )?.pymt_type_details;
    const haveCashPayment = cashPaymentModes
        ?.filter((item) =>
            contains(
                cashPayments?.map((item) => item?.payment_name),
                item?.payment_name
            )
        )
        ?.some((item) => item?.rounding);
    return !!haveCashPayment;
};

/**
 * Checks if all payments are cash payments.
 * @param {any[]} payments - The array of payments.
 * @returns {boolean} True if all payments are cash payments, false otherwise.
 */
export const onlyCashPayments = (payments) => {
    const cashPayments = payments?.filter((item) => item?.payment_type === "C");
    return cashPayments?.length === payments?.length;
};

/**
 * Calculates and returns order item with subtotal.
 * @param {any} orderItem - The order item object.
 * @param {any[]} orderItems - The array of order items.
 * @returns {any} The updated order item with calculated subtotal.
 */
export const calcOrderItemSubtotal = (orderItem, orderItems) => {
    const { order: activeOrder } = useOrder();

    const serviceType = activeOrder?.service_type;

    const takeAwayChargeItemNo = getSysSetting(
        "System Settings",
        "ta_fixed_item_no"
    );
    if (same(orderItem?.item_no, takeAwayChargeItemNo)) {
        return addTax({
            ...orderItem,
            sub_total: orderItem?.qty * orderItem?.unit_price,
        });
    }

    const items = Array.isArray(useCache()?.items) ? useCache()?.items : [];
    const item = items.find(
        (item) => item?.item_no === orderItem?.item_no
    );

    const unit_price =
        isAddonItem(orderItem) ||
            isAddon2Item(orderItem) ||
            false
            ? orderItem?.unit_price
            : getPriceByServiceType(
                item?.selling_uom_dtls[0]?.price_dtls[0],
                orderItem?.take_away_item === "Y" ? "T" : serviceType
            );

    if (orderItem?.s_no === orderItem.parent_sno) {
        if (orderItem?.menu_type) {
            return addTax({ ...orderItem });
        } else {
            // ✅ FIX: If unit_price is already 0 (set by normalizer), trust it
            // Don't re-fetch from item master — the normalizer already zeroed it
            const effectivePrice = parseFloat(orderItem.unit_price) === 0
                ? 0
                : unit_price;

            return calcOrderItemDiscount(
                {
                    ...orderItem,
                    unit_price: effectivePrice,
                    sub_total: orderItem?.qty * effectivePrice,
                },
                {
                    disc_name: orderItem?.disc_name,
                    disc_type: orderItem?.disc_type,
                    disc_value: orderItem?.disc_value,
                },
                orderItems
            );
        }
    }
    else if (orderItem?.s_no !== orderItem.parent_sno) {
        const parentItem = orderItems?.find(
            (i) => same(i?.s_no, orderItem?.parent_sno) && same(i?.s_no, i?.parent_sno)
        );
        const parentHasDiscount = parentItem?.disc_name && !same(parentItem?.disc_name, 'None');
        const childAlreadyDiscountedBySamePromo = same(orderItem?.disc_name, parentItem?.disc_name);

        if (parentHasDiscount && childAlreadyDiscountedBySamePromo) {
            return calcOrderItemDiscount(
                {
                    ...orderItem,
                    sub_total: orderItem?.qty * orderItem?.unit_price,
                },
                {
                    disc_name: parentItem?.disc_name,
                    disc_type: parentItem?.disc_type,
                    disc_value: parentItem?.disc_value,
                },
                orderItems
            );
        }

        return addTax({
            ...orderItem,
            sub_total: orderItem?.qty * orderItem?.unit_price,
        });
    }
};

/**
 * Checks if the item is weightable.
 * @param {any} item - The item object.
 * @returns {boolean} True if the item is weightable, false otherwise.
 */
export const isWeightableItem = (item) => {
    const items = Array.isArray(useCache()?.items) ? useCache()?.items : [];
    let lstItem = items.filter(function (v) {
        return v.item_no === item?.item_no;
    });
    if (lstItem.length > 0) {
        let is_weightable = lstItem[0].is_weightable;
        if (is_weightable === 1 || is_weightable === true) {
            return true;
        } else {
            return false;
        }
    }
    return false;
};

/**
 * Gets store setting based on main group name, group name and setting code.
 * @param {string} main_group_name - The main group name.
 * @param {string} group_name - The group name.
 * @param {string} setting_code - The setting code.
 * @returns {string} The setting value.
 */
export const getSetting = (main_group_name, group_name, setting_code) => {
    // 1. Get the raw cache (the large nested array you shared)
    const settingsCache = useCache()?.settings || [];

    // 2. Locate the Main Group (e.g., "GENERAL SETTINGS")
    const mainGroupObj = settingsCache.find(obj => obj[main_group_name]);
    if (!mainGroupObj) return undefined;

    // 3. Locate the Sub Group (e.g., "ORDERING")
    const subGroupObj = mainGroupObj[main_group_name].find(obj => obj[group_name]);
    if (!subGroupObj) return undefined;

    // 4. Return the value from the first item in that group's array
    // Based on your JSON: subGroupObj["ORDERING"] is an array [ { ... } ]
    return subGroupObj[group_name][0][setting_code];
};

/**
 * Checks user rights for the action.
 * @param {string} module - The module to check rights for.
 * @param {any} [user] - Optional user object.
 * @returns {boolean} True if the user has rights, false otherwise.
 */
export const authorised = (module, user) => {
    try {
        if (same(module, "ORDER")) {
            return true;
        }

        user = user || useCache()?.user;

        // ✅ Add safety checks
        const roles = Array.isArray(useCache()?.roles) ? useCache()?.roles : [];
        const role = roles.find((item) => same(item?.gr_code, user?.gr_code));

        if (!role || !Array.isArray(role?.menu)) {
            return false;
        }

        const menuItem = role.menu[0]?.sub?.find((item) => same(item?.menu_name, module));

        return bool(menuItem?.access_flag);
    } catch (error) {
        return false;
    }
};

/**
 * Gets menu item display name.
 * @param {any} item - The item object.
 * @returns {string} The display name of the item.
 */
export const getItemDisplayName = (item) => {
    const displayAs = getSetting(
        "GENERAL SETTINGS",
        "ORDERING",
        "display_name_orderscreen"
    );
    return (item ? item[displayAs] : null) || item?.item_name;
};

/**
 * Opens second screen.
 */
let secondScreenWindow = null;
export const openSecondScreen = () => {
    if (bool(getSetting("HARDWARE", "HARDWARE", "2nd_display_Enable"))) {
        if (!secondScreenWindow || secondScreenWindow.closed) {
            secondScreenWindow = window.open(
                `${window.location.origin}/second-screen`,
                "SecondDisplay",
                "resizable=1,scrollbars=1,fullscreen=1,height=300,width=4685,top=4685,left=4685,toolbar=0,menubar=0,status=1"
            );
        }
    }
};

/**
 * Sorts list by sequence number.
 * @param {any[]} list - The list to sort.
 * @returns {any[]} The sorted list.
 */
export const sortModifierAddonItems = (list) => {
    return clone(list)?.sort((a, b) => {
        if (a.seq_no !== null && a.seq_no !== undefined) {
            if (a.seq_no === 0 && b.seq_no === 0) return 0;
            if (a.seq_no === 0) return 1;
            if (b.seq_no === 0) return -1;
            return a.seq_no - b.seq_no;
        }
        else if (
            a.item_menutype_grpdtls !== null &&
            a.item_menutype_grpdtls !== undefined
        ) {
            if (a.item_menutype_grpdtls === 0 && b.item_menutype_grpdtls === 0)
                return 0;
            if (a.item_menutype_grpdtls === 0) return 1;
            if (b.item_menutype_grpdtls === 0) return -1;
            return a.item_menutype_grpdtls - b.item_menutype_grpdtls;
        }
        if (a.item_menutypedtls !== null && b.item_menutypedtls !== undefined) {
            if (a.item_menutypedtls === 0 && b.item_menutypedtls === 0) return 0;
            if (a.item_menutypedtls === 0) return 1;
            if (b.item_menutypedtls === 0) return -1;
            return a.item_menutypedtls - b.item_menutypedtls;
        }
    });
};

/**
 * Filters items that are available now.
 * @param {any[]} items - The array of items to filter.
 * @returns {any[]} The filtered array of items available now.
 */
export const availableNow = (items) => {
    if (!Array.isArray(items)) return [];
    const now = dayjs();
    const nowLogin = getNowWithLoginDate();

    return items.filter((item) => {
        // Check if promotion has time-based restrictions (start_time/end_time)
        if (item?.start_time && item?.end_time) {
            return now.isBetween(
                dayjs(item.start_time, TIME_FORMAT),
                dayjs(item.end_time, TIME_FORMAT)
            );
        }

        // Check promotion date range
        const inDateRange = nowLogin.isBetween(
            dayjs(item?.promo_st_date),
            dayjs(item?.promo_ed_date)
        );

        // If no time period restriction, just check date range
        if (item?.by_time_period === "N" || !item?.time_slot_dtls || item?.time_slot_dtls === "") {
            return inDateRange;
        }

        // If has time slots, check both date range AND time slots
        if (Array.isArray(item?.time_slot_dtls) && item.time_slot_dtls.length > 0) {
            return inDateRange && item.time_slot_dtls.some(
                (time) =>
                    same(time?.day_info, nowLogin.format("ddd")) &&
                    now.isBetween(
                        dayjs(time?.st_time, TIME_FORMAT),
                        dayjs(time?.ed_time, TIME_FORMAT)
                    )
            );
        }

        return inDateRange;
    });
};

/**
 * Gets root and selected categories based on current selected menu item.
 * @param {any} menuItem - The selected menu item.
 * @returns {Object} An object containing rootCategory and selectedCategory arrays.
 */
export const getRootAndSelectedCategories = (menuItem) => {
    const categories = [];

    let currentCategory = null;
    const menuItems = Array.isArray(useCache()?.menuItems) ? useCache()?.menuItems : [];

    do {
        for (const item of useCache()?.menuItems) {
            if (currentCategory) {
                if (Array.isArray(item?.category)) {
                    const foundItem = item?.category?.find((item) =>
                        same(item?.category_code, currentCategory)
                    );
                    if (foundItem) {
                        const root_category_code = foundItem?.root_category_code;
                        categories.unshift(root_category_code);
                        currentCategory = root_category_code;
                        break;
                    }
                }
            } else {
                if (Array.isArray(item?.items)) {
                    const foundItem = item?.items?.find((item) =>
                        same(item?.item_no, menuItem?.item_no)
                    );
                    if (foundItem) {
                        const category_code = foundItem?.category_code;
                        categories.unshift(category_code);
                        currentCategory = category_code;
                        break;
                    }
                }
            }
        }
    } while (!currentCategory || !same(currentCategory, "MAIN"));

    let rootCategory = categories?.map((item) => item);
    rootCategory.pop();
    let selectedCategory = categories?.map((item) => item);
    selectedCategory.shift();

    return { rootCategory, selectedCategory };
};

/**
 * Gets promo linked to the item.
 * @param {any} item - The item object.
 * @param {string | string[]} criteria_type - The criteria type of the promo.
 * @returns {any} The promo object linked to the item, or null if no promo is found.
 */
export const getPromo = (item, criteria_type) => {
    const { order: activeOrder } = useOrder();
    const serviceType = activeOrder?.service_type;

    const cache = useCache();
    const allPromos = Array.isArray(cache?.promos) ? cache.promos : [];

    const promos = allPromos
        .filter((promo) =>
            contains(
                promo?.service_type?.map((item) => item?.service_type),
                serviceType
            )
        )
        .filter((promo) => isPromoApplicable(promo, item))
        .filter((promo) => {
            if (Array.isArray(criteria_type)) {
                return contains(criteria_type, promo?.criteria_type);
            } else {
                return same(promo?.criteria_type, criteria_type);
            }
        });

    return promos.length > 0 ? promos[0] : null;
};


/**
 * Sorts order items ascendingly.
 * @param {any[]} orderItems - The array of order items to sort.
 * @returns {any[]} The sorted array of order items.
 */
export const sortOrderItems = (orderItems) => {
    return (orderItems || [])?.sort((a, b) => {
        if (a.parent_sno !== b.parent_sno) return a.parent_sno - b.parent_sno;
        if (a.ds_no !== b.ds_no) return a.ds_no - b.ds_no;
        return a.s_no - b.s_no;
    });
};

/**
 * Get the sets of the promo.
 * @param {any} promo - The promo object.
 * @param {any[]} orderItems - The array of order items.
 * @param {any} orderItem - The order item object.
 * @returns {any[]} The array of promo set.
 */
export const getPromoSets = (promo, orderItems, orderItem, limit) => {
    const { setLastSNo } = useOrder();
    const { items } = useCache();

    const isTotalDiscountPromo = same(
        promo?.criteria_type,
        PROMO_TYPE.TOTAL_DISCOUNT
    );

    let remaining = orderItems?.filter((item) => {
        // ✅ NEW: do not allow parent item to apply discount if child item has discount
        if (
            item?.disc_name &&
            same(item?.disc_name, "None") &&
            orderItems?.some(
                (orderitem) =>
                    orderitem !== 1 &&
                    same(orderitem?.parent_sno, item.parent_sno) &&
                    notFreeItem(orderitem) &&
                    orderitem?.disc_name &&
                    !same(orderitem?.disc_name, "None")
            )
        ) {
            return false;
        }

        if (!isTotalDiscountPromo && item?.ds_no !== 1) {
            return false;
        }

        const _item = items?.find(({ item_no }) => same(item_no, item?.item_no));
        if (bool(_item?.is_exclude_promo)) {
            return false;
        }

        return same(
            findPromoByName(item?.disc_name)?.criteria_type,
            PROMO_TYPE.TOTAL_DISCOUNT
        ) || isTotalDiscountPromo
            ? true
            : same(item?.disc_name, "None");
    });

    let newOrderItems = clone(orderItems);

    const sets = [];
    let _insert = false;
    let cont = true;
    _insert = true;

    if (
        isTotalDiscountPromo ||
        isPromoApplicable(promo, orderItem, newOrderItems)
    ) {
        while (
            cont &&
            remaining?.length > 0 &&
            sets?.length < (limit ?? Infinity)
        ) {
            if (same(promo?.criteria_type, PROMO_TYPE.LOWEST_PRICE_DISCOUNT)) {
                remaining = remaining?.filter((orderitem) =>
                    orderitem?.ds_no === 1
                        ? !contains(
                            promo?.creteria_item_dtls || [],
                            orderitem?.category_code
                        )
                        : true
                );
                remaining = remaining?.sort((a, b) => (a?.s_no || 0) - (b?.s_no || 0));

                if (remaining?.length > 0) {
                    // ✅ NEW: isApplyToChild branch
                    if (promo?.isApplyToChild) {
                        // ✅ NEW: discount the lowest-priced CHILD item matching criteria categories
                        const criteriaCategoryCodes = (promo?.item_menu_category_dtls || [])?.map((i) => i?.category_code);
                        const childItemsInSet = set?.filter(
                            (item) => item?.ds_no !== 1 && contains(criteriaCategoryCodes, item?.category_code)
                        ) ?? [];
                        const lowestPriceChildItem = childItemsInSet?.sort((a, b) => (a?.unit_price || 0) - (b?.unit_price || 0))[0];

                        if (lowestPriceChildItem) {
                            let lowestChildSno = lowestPriceChildItem?.s_no;

                            if (lowestPriceChildItem?.qty > 1) {
                                let s_no = Math.max(...newOrderItems.map((item) => item?.s_no)) + 1;
                                const remainderQty = lowestPriceChildItem?.qty - 1;
                                const splitChildSno = s_no;
                                const splitedChildItem = calcOrderItemSubtotal(
                                    { ...lowestPriceChildItem, s_no, qty: remainderQty, sub_total: (lowestPriceChildItem?.unit_price || 0) * remainderQty },
                                    newOrderItems
                                );
                                newOrderItems = newOrderItems?.map((item) => {
                                    if (same(item?.s_no, lowestChildSno)) {
                                        return calcOrderItemSubtotal({ ...item, qty: 1, sub_total: (item?.unit_price || 0) * 1 }, newOrderItems);
                                    }
                                    return item;
                                });
                                newOrderItems.push(splitedChildItem);
                                set.push(splitedChildItem);
                                setLastSNo(s_no);
                                setSelectedOrderItemSNo(splitChildSno);
                            }

                            let appliedThisSet = 0;
                            let amountThisSet = 0;
                            newOrderItems = newOrderItems?.map((item) => {
                                if (same(item?.s_no, lowestChildSno)) {
                                    appliedThisSet += item?.qty;
                                    amountThisSet += (item?.unit_price || 0) * (item?.qty || 1);
                                    return calcOrderItemDiscount(
                                        { ...item, disc_name: promo?.promo_name, ref_1: set[0]?.s_no },
                                        { disc_type: promo?.criteria_disc_type, disc_name: promo?.promo_name, disc_value: promo?.criteria_disc_value },
                                        newOrderItems
                                    );
                                } else if (contains(set?.map((item) => item?.s_no), item?.s_no) && item?.ds_no === 1) {
                                    return { ...item, disc_name: promo?.promo_name, ref_1: set[0]?.s_no };
                                } else {
                                    return item;
                                }
                            });
                            applied += appliedThisSet;
                            amount += amountThisSet;
                            remaining -= appliedThisSet;
                        }
                    }
                    // original default branch
                    else {
                        const getGroupTotal = (parentSno) =>
                            (newOrderItems || []).reduce(
                                (sum, o) =>
                                    sum +
                                    (same(o?.s_no, parentSno) || same(o?.parent_sno, parentSno)
                                        ? o?.unit_price || 0
                                        : 0),
                                0
                            );

                        const lowestIdx = remaining.reduce((bestIdx, item, i) => {
                            if (!same(item?.ds_no, 1)) return bestIdx;
                            const parentSno = item?.s_no;
                            const groupTotal = getGroupTotal(parentSno);
                            if (bestIdx === -1) return i;
                            const bestGroupTotal = getGroupTotal(remaining[bestIdx]?.s_no);
                            return groupTotal < bestGroupTotal ? i : bestIdx;
                        }, -1);

                        if (lowestIdx >= 0) {
                            const lowestItem = remaining[lowestIdx];
                            const parentSno = lowestItem?.s_no;
                            remaining = [
                                lowestItem,
                                ...remaining.filter((item) => !same(item?.s_no, parentSno)),
                            ];
                            const group = newOrderItems?.filter(
                                (item) => same(item?.s_no, parentSno) || same(item?.parent_sno, parentSno)
                            );
                            const rest = newOrderItems?.filter(
                                (item) => !same(item?.s_no, parentSno) && !same(item?.parent_sno, parentSno)
                            );
                            newOrderItems = [...(group || []), ...(rest || [])];
                        }
                    }
                }
            }

            let found = false;
            const set = [];
            const criteriaQtyLimit = parseInt(promo?.criteria_spldisc_qty_limit) || 0;

            // all items criteria
            if (same(promo?.by_item, PROMO_BY.ALL_ITEMS)) {
                for (let j = 0; j < remaining?.length; j++) {
                    const orderitem = remaining[j];
                    set.push(orderitem);
                    if (
                        orderitem?.ds_no === 1 &&
                        (orderitem?.menu_type ||
                            (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name))
                    ) {
                        newOrderItems?.forEach((i) => {
                            if (
                                !same(i?.s_no, orderitem?.s_no) &&
                                same(i?.parent_sno, orderitem?.parent_sno) &&
                                (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i))
                            ) {
                                set.push(i);
                            }
                        });
                    }
                    if (criteriaQtyLimit ? set?.reduce((acc, curr) => acc + curr?.qty, 0) >= criteriaQtyLimit : true) {
                        found = true;
                        break;
                    }
                }
            }

            // item criteria
            else if (
                same(promo?.by_item, PROMO_BY.SELECTED_ITEMS) &&
                Array.isArray(promo?.item_dtls)
            ) {
                for (let i = 0; i < promo?.item_dtls?.length; i++) {
                    const promoitem = promo?.item_dtls[i];
                    for (let j = 0; j < remaining?.length; j++) {
                        const orderitem = remaining[j];
                        if (same(promoitem?.item_no, orderitem?.item_no)) {
                            const children = [];
                            if (
                                orderitem?.ds_no === 1 &&
                                (orderitem?.menu_type ||
                                    (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name))
                            ) {
                                newOrderItems?.forEach((i) => {
                                    if (
                                        !same(i?.s_no, orderitem?.s_no) &&
                                        same(i?.parent_sno, orderitem?.parent_sno) &&
                                        (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i))
                                    ) {
                                        children.push(i);
                                    }
                                });
                            }

                            const effectiveLimit = criteriaQtyLimit || 1;
                            const currentSetQty = set?.reduce((acc, curr) => acc + curr?.qty, 0);
                            const qtyNeeded = effectiveLimit - currentSetQty;

                            if (orderitem?.qty > qtyNeeded) {
                                const qty = qtyNeeded;
                                set.push({ ...orderitem, qty });
                                children.forEach((i) => set.push({ ...i, qty: (i?.qty * qty) / orderitem?.qty }));
                                let s_no = Math.max(...newOrderItems.map((item) => item?.s_no)) + 1;
                                const remainingQty = orderitem?.qty - qty;
                                const splitedOrderItem = { ...orderitem, s_no, parent_sno: s_no, qty: remainingQty };
                                const splitChildren = [];
                                if (orderitem?.ds_no === 1 && (orderitem?.menu_type || (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name))) {
                                    for (let index = 0; index < newOrderItems?.length; index++) {
                                        const i = newOrderItems[index];
                                        if (!same(i?.s_no, orderitem?.s_no) && same(i?.parent_sno, orderitem?.parent_sno) && (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i))) {
                                            s_no++;
                                            splitChildren.push({ ...i, s_no, parent_sno: splitedOrderItem.s_no, qty: (i?.qty * remainingQty) / orderitem?.qty });
                                        }
                                    }
                                }
                                newOrderItems = newOrderItems?.map((item) => same(item?.parent_sno, orderitem?.parent_sno) ? { ...item, qty } : item);
                                newOrderItems.push(splitedOrderItem, ...splitChildren);
                                remaining.push(splitedOrderItem);
                                setLastSNo(s_no);
                                found = true;
                                break;
                            }

                            set.push(orderitem);
                            children.forEach((i) => set.push(i));
                            if (criteriaQtyLimit ? set?.reduce((acc, curr) => acc + curr?.qty, 0) >= criteriaQtyLimit : true) {
                                found = true;
                                break;
                            }
                        }
                    }
                    if (found) break;
                }
            }

            // category criteria
            else if (
                same(promo?.by_item, PROMO_BY.SELECTED_CATEGORIES) &&
                Array.isArray(promo?.item_menu_category_dtls)
            ) {
                const excludedItems = (promo?.item_dtls || [])?.map((item) => item?.item_no);
                const itemSubTotalThreshold = same(promo?.criteria_type, PROMO_TYPE.FREE_ITEM_BY_VALUE)
                    ? parseFloat(promo?.receipt_terms_amount) || 0 : 0;
                const total_qty = promo?.criteria_payment_name ? parseInt(promo?.criteria_payment_name) || 0 : 0;

                for (let i = 0; i < promo?.item_menu_category_dtls?.length; i++) {
                    const promoitem = promo?.item_menu_category_dtls[i];
                    for (let j = 0; j < remaining?.length; j++) {
                        const orderitem = remaining[j];
                        if (same(promoitem?.category_code, orderitem?.category_code) && !contains(excludedItems, orderitem?.item_no)) {
                            const children = [];
                            if (orderitem?.ds_no === 1 && (orderitem?.menu_type || (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name))) {
                                newOrderItems?.forEach((i) => {
                                    if (!same(i?.s_no, orderitem?.s_no) && same(i?.parent_sno, orderitem?.parent_sno) && (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i))) {
                                        children.push(i);
                                    }
                                });
                            }
                            if (children?.length > 0) {
                                const effectiveLimit = criteriaQtyLimit || 1;
                                const currentSetQty = set?.reduce((acc, curr) => acc + curr?.qty, 0);
                                const qtyNeeded = effectiveLimit - currentSetQty;
                                if (orderitem?.qty > qtyNeeded) {
                                    const qty = qtyNeeded;
                                    set.push({ ...orderitem, qty });
                                    children.forEach((i) => set.push({ ...i, qty: (i?.qty * qty) / orderitem?.qty }));
                                    let s_no = Math.max(...newOrderItems.map((item) => item?.s_no)) + 1;
                                    const remainingQty = orderitem?.qty - qty;
                                    const splitedOrderItem = { ...orderitem, s_no, parent_sno: s_no, qty: remainingQty };
                                    const splitChildren = [];
                                    if (orderitem?.ds_no === 1 && (orderitem?.menu_type || (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name))) {
                                        for (let index = 0; index < newOrderItems?.length; index++) {
                                            const i = newOrderItems[index];
                                            if (!same(i?.s_no, orderitem?.s_no) && same(i?.parent_sno, orderitem?.parent_sno) && (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i))) {
                                                s_no++;
                                                splitChildren.push({ ...i, s_no, parent_sno: splitedOrderItem.s_no, qty: (i?.qty * remainingQty) / orderitem?.qty });
                                            }
                                        }
                                    }
                                    newOrderItems = newOrderItems?.map((item) => same(item?.parent_sno, orderitem?.parent_sno) ? { ...item, qty } : item);
                                    newOrderItems.push(splitedOrderItem, ...splitChildren);
                                    remaining.push(splitedOrderItem);
                                    setLastSNo(s_no);
                                    found = true;
                                    break;
                                }
                                set.push(orderitem);
                                children.forEach((i) => set.push(i));
                                if (
                                    set?.map((item) => parseFloat(item?.sub_total))?.reduce((acc, val) => acc + val, 0) >= itemSubTotalThreshold &&
                                    set?.reduce((acc, curr) => acc + curr?.qty, 0) >= total_qty &&
                                    (criteriaQtyLimit ? set?.reduce((acc, curr) => acc + curr?.qty, 0) >= criteriaQtyLimit : true)
                                ) {
                                    found = true;
                                    break;
                                }
                            }
                        }
                    }
                    if (found) break;
                }
            }

            // set deals criteria
            else if (
                same(promo?.by_item, PROMO_BY.SET_DEALS) &&
                Array.isArray(promo?.item_menu_category_dtls)
            ) {
                const total_qty = promo?.criteria_payment_name ? parseInt(promo?.criteria_payment_name) || 0 : 0;
                for (let i = 0; i < promo?.item_menu_category_dtls?.length; i++) {
                    const promoitem = promo?.item_menu_category_dtls[i];
                    let qty = total_qty ? total_qty - set?.reduce((acc, curr) => acc + curr?.qty, 0) : promoitem?.qty;
                    if (qty > 0) {
                        for (let j = 0; j < remaining?.length; j++) {
                            const orderitem = remaining[j];
                            if (same(promoitem?.category_code, orderitem?.category_code)) {
                                if (qty >= orderitem?.qty) {
                                    set.push(orderitem);
                                    if (orderitem?.ds_no === 1 && (orderitem?.menu_type || (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name))) {
                                        newOrderItems?.forEach((i) => {
                                            if (!same(i?.s_no, orderitem?.s_no) && same(i?.parent_sno, orderitem?.parent_sno) && (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i))) {
                                                set.push(i);
                                            }
                                        });
                                    }
                                    qty = qty - orderitem?.qty;
                                    if (qty <= 0) break;
                                } else {
                                    const newOrderItem = { ...orderitem, qty };
                                    set.push(newOrderItem);
                                    if (newOrderItem?.ds_no === 1 && (newOrderItem?.menu_type || (bool(newOrderItem?.is_addon_enable) && newOrderItem?.add_on_name))) {
                                        newOrderItems?.forEach((i) => {
                                            if (!same(i?.s_no, newOrderItem?.s_no) && same(i?.parent_sno, newOrderItem?.parent_sno) && (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i))) {
                                                set.push({ ...i, qty: (i?.qty * qty) / orderitem?.qty });
                                            }
                                        });
                                    }
                                    let s_no = Math.max(...newOrderItems.map((item) => item?.s_no)) + 1;
                                    const remainingQty = orderitem?.qty - qty;
                                    const splitedOrderItem = { ...orderitem, s_no, parent_sno: s_no, qty: remainingQty };
                                    const splitChildren = [];
                                    if (newOrderItem?.ds_no === 1 && (newOrderItem?.menu_type || (bool(newOrderItem?.is_addon_enable) && newOrderItem?.add_on_name))) {
                                        for (let index = 0; index < newOrderItems?.length; index++) {
                                            const i = newOrderItems[index];
                                            if (!same(i?.s_no, newOrderItem?.s_no) && same(i?.parent_sno, newOrderItem?.parent_sno) && (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i))) {
                                                s_no++;
                                                splitChildren.push({ ...i, s_no, parent_sno: splitedOrderItem.s_no, qty: (i?.qty * remainingQty) / orderitem?.qty });
                                            }
                                        }
                                    }
                                    newOrderItems = newOrderItems?.map((item) => same(item?.parent_sno, orderitem?.parent_sno) ? { ...item, qty } : item);
                                    newOrderItems.push(splitedOrderItem, ...splitChildren);
                                    remaining.push(splitedOrderItem);
                                    setLastSNo(s_no);
                                    break;
                                }
                            }
                        }
                    }
                }
                if (set?.length > 0) {
                    const merged = set?.filter((orderitem) => orderitem?.ds_no === 1).reduce((acc, curr) => {
                        const existingItem = acc.find((item) => same(item.category_code, curr.category_code));
                        if (existingItem) { existingItem.qty += curr.qty; } else { acc.push({ category_code: curr.category_code, qty: curr.qty }); }
                        return acc;
                    }, []);
                    if (total_qty) {
                        found = merged?.reduce((acc, curr) => acc + curr?.qty, 0) >= total_qty;
                    } else {
                        found = promo?.item_menu_category_dtls?.every((criteria) =>
                            merged?.find((item) => same(item?.category_code, criteria?.category_code))?.qty >= criteria?.qty
                        );
                    }
                    if (criteriaQtyLimit && merged?.reduce((acc, curr) => acc + curr?.qty, 0) < criteriaQtyLimit) {
                        found = false;
                    }
                }
            }

            // prefix criteria
            else if (same(promo?.by_item, PROMO_BY.PREFIX)) {
                for (let j = 0; j < remaining?.length; j++) {
                    const orderitem = remaining[j];
                    const matchedChildren = [];
                    if (orderitem?.ds_no === 1 && (orderitem?.menu_type || (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name))) {
                        newOrderItems?.forEach((i) => {
                            if (!same(i?.s_no, orderitem?.s_no) && same(i?.parent_sno, orderitem?.parent_sno) && (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i)) && contains(promo?.item_dtls?.map(({ prefix }) => prefix), getRefItemPrefix(i?.item_name))) {
                                matchedChildren.push(i);
                            }
                        });
                    }
                    if (matchedChildren?.length > 0) {
                        const effectiveLimit = criteriaQtyLimit || 1;
                        const currentSetQty = set?.reduce((acc, curr) => acc + curr?.qty, 0);
                        const qtyNeeded = effectiveLimit - currentSetQty;
                        if (orderitem?.qty > qtyNeeded) {
                            const qty = qtyNeeded;
                            set.push({ ...orderitem, qty });
                            matchedChildren.forEach((i) => set.push({ ...i, qty: (i?.qty * qty) / orderitem?.qty }));
                            let s_no = Math.max(...newOrderItems.map((item) => item?.s_no)) + 1;
                            const remainingQty = orderitem?.qty - qty;
                            const splitedOrderItem = { ...orderitem, s_no, parent_sno: s_no, qty: remainingQty };
                            const splitChildren = [];
                            if (orderitem?.ds_no === 1 && (orderitem?.menu_type || (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name))) {
                                for (let index = 0; index < newOrderItems?.length; index++) {
                                    const i = newOrderItems[index];
                                    if (!same(i?.s_no, orderitem?.s_no) && same(i?.parent_sno, orderitem?.parent_sno) && (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i))) {
                                        s_no++;
                                        splitChildren.push({ ...i, s_no, parent_sno: splitedOrderItem.s_no, qty: (i?.qty * remainingQty) / orderitem?.qty });
                                    }
                                }
                            }
                            newOrderItems = newOrderItems?.map((item) => same(item?.parent_sno, orderitem?.parent_sno) ? { ...item, qty } : item);
                            newOrderItems.push(splitedOrderItem, ...splitChildren);
                            remaining.push(splitedOrderItem);
                            setLastSNo(s_no);
                            found = true;
                            break;
                        }
                        set.push(orderitem);
                        matchedChildren.forEach((i) => set.push(i));
                        if (criteriaQtyLimit ? set?.reduce((acc, curr) => acc + curr?.qty, 0) >= criteriaQtyLimit : true) {
                            found = true;
                            break;
                        }
                    }
                }
            }

            // selected categories child criteria
            else if (same(promo?.by_item, PROMO_BY.SELECTED_CATEGORIES_CHILD)) {
                const itemSubTotalThreshold = same(promo?.criteria_type, PROMO_TYPE.FREE_ITEM_BY_VALUE)
                    ? parseFloat(promo?.receipt_terms_amount) || 0 : 0;
                const total_qty = promo?.criteria_payment_name ? parseInt(promo?.criteria_payment_name) || 0 : 0;
                for (let i = 0; i < promo?.item_menu_category_dtls?.length; i++) {
                    const promoitem = promo?.item_menu_category_dtls[i];
                    for (let j = 0; j < remaining?.length; j++) {
                        const orderitem = remaining[j];
                        const children = [];
                        if (orderitem?.ds_no === 1 && (orderitem?.menu_type || (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name))) {
                            newOrderItems?.forEach((i) => {
                                if (!same(i?.s_no, orderitem?.s_no) && same(i?.parent_sno, orderitem?.parent_sno) && (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i)) && same(i?.category_code, promoitem?.category_code)) {
                                    children.push(i);
                                }
                            });
                        }
                        if (children?.length > 0) {
                            const effectiveLimit = criteriaQtyLimit || 1;
                            const currentSetQty = set?.reduce((acc, curr) => acc + curr?.qty, 0);
                            const qtyNeeded = effectiveLimit - currentSetQty;
                            if (orderitem?.qty > qtyNeeded) {
                                const qty = qtyNeeded;
                                set.push({ ...orderitem, qty });
                                children.forEach((i) => set.push({ ...i, qty: (i?.qty * qty) / orderitem?.qty }));
                                let s_no = Math.max(...newOrderItems.map((item) => item?.s_no)) + 1;
                                const remainingQty = orderitem?.qty - qty;
                                const splitedOrderItem = { ...orderitem, s_no, parent_sno: s_no, qty: remainingQty };
                                const splitChildren = [];
                                if (orderitem?.ds_no === 1 && (orderitem?.menu_type || (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name))) {
                                    for (let index = 0; index < newOrderItems?.length; index++) {
                                        const i = newOrderItems[index];
                                        if (!same(i?.s_no, orderitem?.s_no) && same(i?.parent_sno, orderitem?.parent_sno) && (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i))) {
                                            s_no++;
                                            splitChildren.push({ ...i, s_no, parent_sno: splitedOrderItem.s_no, qty: (i?.qty * remainingQty) / orderitem?.qty });
                                        }
                                    }
                                }
                                newOrderItems = newOrderItems?.map((item) => same(item?.parent_sno, orderitem?.parent_sno) ? { ...item, qty } : item);
                                newOrderItems.push(splitedOrderItem, ...splitChildren);
                                remaining.push(splitedOrderItem);
                                setLastSNo(s_no);
                                found = true;
                                break;
                            }
                            set.push(orderitem);
                            children.forEach((i) => set.push(i));
                            if (
                                set?.map((item) => parseFloat(item?.sub_total))?.reduce((acc, val) => acc + val, 0) >= itemSubTotalThreshold &&
                                set?.reduce((acc, curr) => acc + curr?.qty, 0) >= total_qty &&
                                (criteriaQtyLimit ? set?.reduce((acc, curr) => acc + curr?.qty, 0) >= criteriaQtyLimit : true)
                            ) {
                                found = true;
                                break;
                            }
                        }
                    }
                    if (found) break;
                }
            }

            // ✅ NEW: selected items child criteria
            else if (same(promo?.by_item, PROMO_BY.SELECTED_ITEMS_CHILD)) {
                const itemSubTotalThreshold = same(promo?.criteria_type, PROMO_TYPE.FREE_ITEM_BY_VALUE)
                    ? parseFloat(promo?.receipt_terms_amount) || 0 : 0;
                const total_qty = promo?.criteria_payment_name ? parseInt(promo?.criteria_payment_name) || 0 : 0;
                for (let i = 0; i < promo?.item_dtls?.length; i++) {
                    const promoitem = promo?.item_dtls[i];
                    for (let j = 0; j < remaining?.length; j++) {
                        const orderitem = remaining[j];
                        const children = [];
                        if (orderitem?.ds_no === 1 && (orderitem?.menu_type || (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name))) {
                            newOrderItems?.forEach((i) => {
                                if (!same(i?.s_no, orderitem?.s_no) && same(i?.parent_sno, orderitem?.parent_sno) && (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i)) && same(i?.item_no, promoitem?.item_no)) {
                                    children.push(i);
                                }
                            });
                        }
                        if (children?.length > 0) {
                            const effectiveLimit = criteriaQtyLimit || 1;
                            const currentSetQty = set?.reduce((acc, curr) => acc + curr?.qty, 0);
                            const qtyNeeded = effectiveLimit - currentSetQty;
                            if (orderitem?.qty > qtyNeeded) {
                                const qty = qtyNeeded;
                                set.push({ ...orderitem, qty });
                                children.forEach((i) => set.push({ ...i, qty: (i?.qty * qty) / orderitem?.qty }));
                                let s_no = Math.max(...newOrderItems.map((item) => item?.s_no)) + 1;
                                const remainingQty = orderitem?.qty - qty;
                                const splitedOrderItem = { ...orderitem, s_no, parent_sno: s_no, qty: remainingQty };
                                const splitChildren = [];
                                if (orderitem?.ds_no === 1 && (orderitem?.menu_type || (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name))) {
                                    for (let index = 0; index < newOrderItems?.length; index++) {
                                        const i = newOrderItems[index];
                                        if (!same(i?.s_no, orderitem?.s_no) && same(i?.parent_sno, orderitem?.parent_sno) && (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i))) {
                                            s_no++;
                                            splitChildren.push({ ...i, s_no, parent_sno: splitedOrderItem.s_no, qty: (i?.qty * remainingQty) / orderitem?.qty });
                                        }
                                    }
                                }
                                newOrderItems = newOrderItems?.map((item) => same(item?.parent_sno, orderitem?.parent_sno) ? { ...item, qty } : item);
                                newOrderItems.push(splitedOrderItem, ...splitChildren);
                                remaining.push(splitedOrderItem);
                                setLastSNo(s_no);
                                found = true;
                                break;
                            }
                            set.push(orderitem);
                            children.forEach((i) => set.push(i));
                            if (
                                set?.map((item) => parseFloat(item?.sub_total))?.reduce((acc, val) => acc + val, 0) >= itemSubTotalThreshold &&
                                set?.reduce((acc, curr) => acc + curr?.qty, 0) >= total_qty &&
                                (criteriaQtyLimit ? set?.reduce((acc, curr) => acc + curr?.qty, 0) >= criteriaQtyLimit : true)
                            ) {
                                found = true;
                                break;
                            }
                        }
                    }
                    if (found) break;
                }
            }

            // ✅ NEW: prefix child criteria
            else if (same(promo?.by_item, PROMO_BY.PREFIX_CHILD)) {
                const itemSubTotalThreshold = same(promo?.criteria_type, PROMO_TYPE.FREE_ITEM_BY_VALUE)
                    ? parseFloat(promo?.receipt_terms_amount) || 0 : 0;
                const total_qty = promo?.criteria_payment_name ? parseInt(promo?.criteria_payment_name) || 0 : 0;
                for (let i = 0; i < promo?.item_dtls?.length; i++) {
                    const prefix = promo?.item_dtls[i];
                    for (let j = 0; j < remaining?.length; j++) {
                        const orderitem = remaining[j];
                        const children = [];
                        if (orderitem?.ds_no === 1 && (orderitem?.menu_type || (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name))) {
                            newOrderItems?.forEach((i) => {
                                if (!same(i?.s_no, orderitem?.s_no) && same(i?.parent_sno, orderitem?.parent_sno) && (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i)) && same(getRefItemPrefix(i?.item_name), prefix?.prefix)) {
                                    children.push(i);
                                }
                            });
                        }
                        if (children?.length > 0) {
                            const effectiveLimit = criteriaQtyLimit || 1;
                            const currentSetQty = set?.reduce((acc, curr) => acc + curr?.qty, 0);
                            const qtyNeeded = effectiveLimit - currentSetQty;
                            if (orderitem?.qty > qtyNeeded) {
                                const qty = qtyNeeded;
                                set.push({ ...orderitem, qty });
                                children.forEach((i) => set.push({ ...i, qty: (i?.qty * qty) / orderitem?.qty }));
                                let s_no = Math.max(...newOrderItems.map((item) => item?.s_no)) + 1;
                                const remainingQty = orderitem?.qty - qty;
                                const splitedOrderItem = { ...orderitem, s_no, parent_sno: s_no, qty: remainingQty };
                                const splitChildren = [];
                                if (orderitem?.ds_no === 1 && (orderitem?.menu_type || (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name))) {
                                    for (let index = 0; index < newOrderItems?.length; index++) {
                                        const i = newOrderItems[index];
                                        if (!same(i?.s_no, orderitem?.s_no) && same(i?.parent_sno, orderitem?.parent_sno) && (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i))) {
                                            s_no++;
                                            splitChildren.push({ ...i, s_no, parent_sno: splitedOrderItem.s_no, qty: (i?.qty * remainingQty) / orderitem?.qty });
                                        }
                                    }
                                }
                                newOrderItems = newOrderItems?.map((item) => same(item?.parent_sno, orderitem?.parent_sno) ? { ...item, qty } : item);
                                newOrderItems.push(splitedOrderItem, ...splitChildren);
                                remaining.push(splitedOrderItem);
                                setLastSNo(s_no);
                                found = true;
                                break;
                            }
                            set.push(orderitem);
                            children.forEach((i) => set.push(i));
                            if (
                                set?.map((item) => parseFloat(item?.sub_total))?.reduce((acc, val) => acc + val, 0) >= itemSubTotalThreshold &&
                                set?.reduce((acc, curr) => acc + curr?.qty, 0) >= total_qty &&
                                (criteriaQtyLimit ? set?.reduce((acc, curr) => acc + curr?.qty, 0) >= criteriaQtyLimit : true)
                            ) {
                                found = true;
                                break;
                            }
                        }
                    }
                    if (found) break;
                }
            }

            // ✅ NEW: set exclude categories child criteria
            else if (same(promo?.by_item, PROMO_BY.SET_EXCLUDE_CATEGORIES_CHILD)) {
                const total_qty = promo?.criteria_payment_name ? parseInt(promo?.criteria_payment_name) || 0 : 0;
                const criteriaCategoryCodes = (promo?.item_menu_category_dtls || [])?.map((i) => i?.category_code);
                for (let i = 0; i < promo?.item_menu_category_dtls?.length; i++) {
                    const promoitem = promo?.item_menu_category_dtls[i];
                    let qty = total_qty ? total_qty - set?.reduce((acc, curr) => acc + curr?.qty, 0) : promoitem?.qty;
                    if (qty > 0) {
                        for (let j = 0; j < remaining?.length; j++) {
                            const orderitem = remaining[j];
                            const hasMatchingChild =
                                orderitem?.ds_no === 1 &&
                                (orderitem?.menu_type || (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name)) &&
                                newOrderItems?.some(
                                    (child) =>
                                        !same(child?.s_no, orderitem?.s_no) &&
                                        same(child?.parent_sno, orderitem?.parent_sno) &&
                                        (isModifierItem(child) || isModifier2Item(child) || isAddonItem(child) || isAddon2Item(child)) &&
                                        same(child?.category_code, promoitem?.category_code)
                                );
                            if (!hasMatchingChild) continue;
                            if (qty >= orderitem?.qty) {
                                set.push(orderitem);
                                if (orderitem?.ds_no === 1 && (orderitem?.menu_type || (bool(orderitem?.is_addon_enable) && orderitem?.add_on_name))) {
                                    newOrderItems?.forEach((child) => {
                                        if (!same(child?.s_no, orderitem?.s_no) && same(child?.parent_sno, orderitem?.parent_sno) && (isModifierItem(child) || isModifier2Item(child) || isAddonItem(child) || isAddon2Item(child))) {
                                            set.push(child);
                                        }
                                    });
                                }
                                qty = qty - orderitem?.qty;
                                if (qty <= 0) break;
                            } else {
                                const newOrderItem = { ...orderitem, qty };
                                set.push(newOrderItem);
                                if (newOrderItem?.ds_no === 1 && (newOrderItem?.menu_type || (bool(newOrderItem?.is_addon_enable) && newOrderItem?.add_on_name))) {
                                    newOrderItems?.forEach((child) => {
                                        if (!same(child?.s_no, newOrderItem?.s_no) && same(child?.parent_sno, newOrderItem?.parent_sno) && (isModifierItem(child) || isModifier2Item(child) || isAddonItem(child) || isAddon2Item(child))) {
                                            set.push({ ...child, qty: (child?.qty * qty) / orderitem?.qty });
                                        }
                                    });
                                }
                                let s_no = Math.max(...newOrderItems.map((item) => item?.s_no)) + 1;
                                const remainingQty = orderitem?.qty - qty;
                                const splitedOrderItem = { ...orderitem, s_no, parent_sno: s_no, qty: remainingQty };
                                const splitChildren = [];
                                if (newOrderItem?.ds_no === 1 && (newOrderItem?.menu_type || (bool(newOrderItem?.is_addon_enable) && newOrderItem?.add_on_name))) {
                                    for (let index = 0; index < newOrderItems?.length; index++) {
                                        const child = newOrderItems[index];
                                        if (!same(child?.s_no, newOrderItem?.s_no) && same(child?.parent_sno, newOrderItem?.parent_sno) && (isModifierItem(child) || isModifier2Item(child) || isAddonItem(child) || isAddon2Item(child))) {
                                            s_no++;
                                            splitChildren.push({ ...child, s_no, parent_sno: splitedOrderItem.s_no, qty: (child?.qty * remainingQty) / orderitem?.qty });
                                        }
                                    }
                                }
                                newOrderItems = newOrderItems?.map((item) => same(item?.parent_sno, orderitem?.parent_sno) ? { ...item, qty } : item);
                                newOrderItems.push(splitedOrderItem, ...splitChildren);
                                remaining.push(splitedOrderItem);
                                setLastSNo(s_no);
                                break;
                            }
                        }
                    }
                }
                if (set?.length > 0) {
                    const merged = set
                        ?.filter((orderitem) => orderitem?.ds_no !== 1 && contains(criteriaCategoryCodes, orderitem?.category_code))
                        .reduce((acc, curr) => {
                            const existingItem = acc.find((item) => same(item.category_code, curr.category_code));
                            if (existingItem) { existingItem.qty += curr.qty; } else { acc.push({ category_code: curr.category_code, qty: curr.qty }); }
                            return acc;
                        }, []);
                    if (total_qty) {
                        found = merged?.reduce((acc, curr) => acc + curr?.qty, 0) >= total_qty;
                    } else {
                        found = promo?.item_menu_category_dtls?.every((criteria) =>
                            merged?.find((item) => same(item?.category_code, criteria?.category_code))?.qty >= criteria?.qty
                        );
                    }
                    if (criteriaQtyLimit && merged?.reduce((acc, curr) => acc + curr?.qty, 0) < criteriaQtyLimit) {
                        found = false;
                    }
                }
            }

            if (found) {
                sets.push(set);
                remaining = remaining?.filter(
                    (item) => !contains(set?.map((item) => item?.s_no), item?.s_no)
                );
                newOrderItems = newOrderItems?.map((orderitem) =>
                    calcOrderItemSubtotal(orderitem, newOrderItems)
                );
            } else {
                cont = false;
            }
        }
    }

    return { sets, _insert, _orderItems: newOrderItems };
};
/**
 * Checks if the order item is not free item based on the criteria type.
 * @param {any} orderItem - The order item object.
 * @param {string} criteriaType - The criteria type.
 * @returns {boolean} True if the order item is not free item, false otherwise.
 */
export const notFreeItem = (orderItem, criteriaType) => {
    switch (criteriaType) {
        case PROMO_TYPE.FREE_ITEM:
        case PROMO_TYPE.FREE_ITEM_WITH_LIMIT:
            return !(
                orderItem?.ds_no >= FREE_ITEM_STARTING_DS_NO &&
                orderItem?.ds_no < FREE_ITEM_BY_VALUE_STARTING_DS_NO
            );
        case PROMO_TYPE.FREE_ITEM_BY_VALUE:
            return !(
                orderItem?.ds_no >= FREE_ITEM_BY_VALUE_STARTING_DS_NO &&
                orderItem?.ds_no < SPECIAL_PRICE_ITEM_STARTING_DS_NO
            );
        case PROMO_TYPE.SPECIAL_PRICE:
            return !(
                orderItem?.ds_no >= SPECIAL_PRICE_ITEM_STARTING_DS_NO &&
                orderItem?.ds_no < SPECIAL_DISCOUNT_WITH_QUANTITY_ITEM_STARTING_DS_NO
            );
        case PROMO_TYPE.SPECIAL_DISCOUNT_WITH_QUANTITY:
            return !(
                orderItem?.ds_no >=
                SPECIAL_DISCOUNT_WITH_QUANTITY_ITEM_STARTING_DS_NO &&
                orderItem?.ds_no < ADDON_STARTING_DS_NO
            );
        default:
            return !(
                orderItem?.ds_no >= FREE_ITEM_STARTING_DS_NO &&
                orderItem?.ds_no < ADDON_STARTING_DS_NO
            );
    }
    console.log('🔍 notFreeItem:', {
        item_no: orderItem?.item_no,
        item_name: orderItem?.item_name,
        ds_no: orderItem?.ds_no,
        criteriaType,
        expectedRange: range,
        isFreeItem: !result,   // true = IS a free item
        notFreeItem: result,   // true = is NOT a free item
    });
};

/**
 * Checks if the order item is promo applicable.
 * @param {any} promo - The promo object.
 * @param {any} orderItem - The order item object.
 * @returns {boolean} True if the promo is applicable, false otherwise.
 */
const isPromoApplicable = (promo, orderItem, orderItems, context = {}) => {
    if (orderItem?.disc_name && !same(orderItem?.disc_name, "None")) {
        return false;
    }

    let masterItems = context.items;
    if (!masterItems) {
        try { masterItems = cache()?.items; } catch (e) { masterItems = []; }
    }
    const masterItem = masterItems?.find((item) => same(item?.item_no, orderItem?.item_no));
    if (bool(masterItem?.is_exclude_promo)) {
        return false;
    }

    let serviceType = context.serviceType;
    if (!serviceType) {
        try {
            const { order: activeOrder, preorder } = order();
            serviceType = isPreOrderPage()
                ? getPreorderServiceType(preorder?.order_type)
                : activeOrder?.service_type;
        } catch (e) {
            serviceType = null;
        }
    }
    const allowedServiceTypes = (promo?.service_type || []).map(({ service_type }) => service_type);
    if (serviceType) {
        const currentItemType = bool(orderItem?.take_away_item) ? "T" : serviceType;
        if (allowedServiceTypes.length > 0 && !contains(allowedServiceTypes, currentItemType)) {
            return false;
        }
    }

    const promoCategoryCodes = (promo?.item_menu_category_dtls || []).map(i => i?.category_code);
    const promoItemNos = (promo?.item_dtls || []).map(i => i?.item_no);

    if (same(promo?.by_item, PROMO_BY.ALL_ITEMS)) {
        return true;

    } else if (same(promo?.by_item, PROMO_BY.SELECTED_CATEGORIES)) {
        return (
            contains(promoCategoryCodes, orderItem?.category_code) &&
            !contains(promoItemNos, orderItem?.item_no)
        );

    } else if (same(promo?.by_item, PROMO_BY.SELECTED_ITEMS)) {
        return contains(promoItemNos, orderItem?.item_no);

    } else if (same(promo?.by_item, PROMO_BY.SET_DEALS)) {
        return (
            contains(promoCategoryCodes, orderItem?.category_code) ||
            contains(promoItemNos, orderItem?.item_no)
        );

    } else if (same(promo?.by_item, PROMO_BY.PREFIX)) {
        // ✅ Restored: actually checks the prefix instead of always returning true
        if (!orderItems) return true;
        const promoPrefixes = (promo?.item_dtls || []).map(item => item?.prefix);
        return contains(promoPrefixes, getRefItemPrefix(orderItem?.item_name));

    } else if (same(promo?.by_item, PROMO_BY.SELECTED_CATEGORIES_CHILD)) {
        if (!orderItems) return true;
        return orderItems.some((i) =>
            !same(i?.s_no, orderItem?.s_no) &&
            same(i?.parent_sno, orderItem?.parent_sno) &&
            (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i)) &&
            contains(promoCategoryCodes, i?.category_code)
        );

        // ✅ NEW: selected items child
    } else if (same(promo?.by_item, PROMO_BY.SELECTED_ITEMS_CHILD)) {
        if (!orderItems) return true;
        return orderItems.some((i) =>
            !same(i?.s_no, orderItem?.s_no) &&
            same(i?.parent_sno, orderItem?.parent_sno) &&
            (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i)) &&
            contains(promoItemNos, i?.item_no)
        );

        // ✅ NEW: prefix child
    } else if (same(promo?.by_item, PROMO_BY.PREFIX_CHILD)) {
        if (!orderItems) return true;
        const promoPrefixes = (promo?.item_dtls || []).map(item => item?.prefix);
        return orderItems.some((i) =>
            !same(i?.s_no, orderItem?.s_no) &&
            same(i?.parent_sno, orderItem?.parent_sno) &&
            (isModifierItem(i) || isModifier2Item(i) || isAddonItem(i) || isAddon2Item(i)) &&
            contains(promoPrefixes, getRefItemPrefix(i?.item_name))
        );

    } else {
        // ✅ Restored: explicit false fallthrough instead of implicit undefined
        return false;
    }
};
/**
 * Get the inserted free items based on the promo criteria type.
 * @param {any} promo - The promo object.
 * @param {any[]} orderItems - The array of order items.
 * @returns {any[]} The array of free items.
 */
const getInsertedFreeItems = (promo, orderItems) => {
    let from = 0;
    switch (promo?.criteria_type) {
        case PROMO_TYPE.FREE_ITEM_WITH_LIMIT:
            from = FREE_ITEM_STARTING_DS_NO;
            break;
        case PROMO_TYPE.FREE_ITEM_BY_VALUE:
            from = FREE_ITEM_BY_VALUE_STARTING_DS_NO;
            break;
        case PROMO_TYPE.SPECIAL_PRICE:
            from = SPECIAL_PRICE_ITEM_STARTING_DS_NO;
            break;
        case PROMO_TYPE.SPECIAL_DISCOUNT_WITH_QUANTITY:
            from = SPECIAL_DISCOUNT_WITH_QUANTITY_ITEM_STARTING_DS_NO;
            break;
    }

    return orderItems?.filter((item) => item?.ds_no > from);
};

/**
 * Check if pre order page.
 * @returns {boolean} True if pre order page, false otherwise.
 */
export const isPreOrderPage = () => {
    if (typeof window === "undefined") return false;
    return same(window.location.pathname, "/pre-orders");
};


/**
 * Process and apply promotion logic to the order items.
 * @param {any[]} orderItems - The array of order items.
 * @param {any} orderItem - The order item object.
 * @returns {any} The result object.
 */
export const applyPromotions = (
    orderItems,
    orderItem,
    voucherPromoInfo = null,
    {
        skipVoucherPromoNames = new Set(),
        promotions = [],               // ✅ SYNC WITH TS: accept promotions directly
    } = {}
) => {
    console.log('🔢 DS_NO Constants:', {
        FREE_ITEM_STARTING_DS_NO,
        FREE_ITEM_BY_VALUE_STARTING_DS_NO,
        SPECIAL_PRICE_ITEM_STARTING_DS_NO,
        SPECIAL_DISCOUNT_WITH_QUANTITY_ITEM_STARTING_DS_NO,
        ADDON_STARTING_DS_NO,
    });
    console.log('🛒 Incoming orderItem ds_no:', orderItem?.ds_no, '| item_no:', orderItem?.item_no, '| item_name:', orderItem?.item_name);
    console.log('📋 All orderItems ds_no map:', orderItems.map(i => ({
        s_no: i.s_no,
        item_no: i.item_no,
        item_name: i.item_name,
        ds_no: i.ds_no,
        disc_name: i.disc_name,
    })));

    let newOrderItems = [...orderItems];

    // ✅ SYNC WITH TS: use passed promotions if provided, fall back to cache
    let promos = Array.isArray(promotions) && promotions.length > 0
        ? promotions
        : (Array.isArray(useCache()?.promos) ? useCache()?.promos : []);

    const { order: activeOrder, preorder } = useOrder();
    const orderData = isPreOrderPage() ? preorder : activeOrder;

    // Filter by customer group exclusions
    promos = promos?.filter((promo) => {
        if (same(promo?.by_target_customer, "R")) {
            if (orderData?.customer_code && orderData?.customer) {
                return !(promo?.exclude_customer_group || [])?.some((customergroup) =>
                    same(
                        customergroup?.cust_group_name,
                        orderData?.customer?.cust_group_name
                    )
                );
            } else {
                // ✅ JS keeps true here (kiosk: promos apply when no member logged in)
                // TS uses false (stricter) — kiosk behavior is correct to keep as true
                return true;
            }
        } else {
            return true;
        }
    });

    // ✅ JS-specific: filter out promos with apply_web disabled
    promos = promos?.filter((promo) => {
        if (promo?.apply_web === 0 || promo?.apply_web === false) return false;
        return true;
    });
    console.log('📋 Promos after web filter:', promos.map(p => p.promo_name));

    if (!voucherPromoInfo) {
        const setPromos = promos?.filter(
            (promo) =>
                same(promo?.by_item, "SD") &&
                !same(promo?.criteria_type, PROMO_TYPE.TOTAL_DISCOUNT)
        );

        setPromos?.forEach((promo) => {
            newOrderItems = newOrderItems
                ?.map((orderitem) => {
                    if (
                        same(promo?.promo_name, orderitem?.disc_name) &&
                        orderitem?.ref_1 &&
                        same(orderitem?.ref_1, orderItem?.s_no)
                    ) {
                        if (notFreeItem(orderitem, promo)) {
                            return calcOrderItemDiscount(
                                {
                                    ...orderitem,
                                    disc_name: "None",
                                    ref_1: "",
                                },
                                null,
                                newOrderItems
                            );
                        }
                    } else {
                        return orderitem;
                    }
                })
                ?.filter((orderitem) => !!orderitem);
        });
    }

    // ✅ SYNC WITH TS: filter expired promotions
    promos = availableNow(promos);
    console.log('📋 Promos after availableNow:', promos.map(p => p.promo_name));

    // ✅ SYNC WITH TS: terminal filter
    // When promotions are passed directly (e.g. Ascentis synthetic vouchers),
    // skip terminal filter — they come pre-validated from the caller
    if (!(Array.isArray(promotions) && promotions.length > 0)) {
        promos = Array.isArray(promos)
            ? promos.filter((promo) => {
                if (voucherPromoInfo) {
                    // Allow voucherPromoInfo itself through even if apply_terminal not set
                    if (same(promo?.promo_name, voucherPromoInfo?.promo_name)) return true;
                    return promo?.apply_terminal === 2;
                } else {
                    return promo?.apply_terminal === 0;
                }
            })
            : [];
    }

    console.log('📋 Promos after terminal filter:', promos.map(p => ({
        promo_name: p.promo_name,
        criteria_type: p.criteria_type,
        apply_terminal: p.apply_terminal,
        apply_web: p.apply_web,
        apply_mobile: p.apply_mobile,
    })));

    // ✅ Inject voucherPromoInfo if not already present
    // Handles case where promotions not passed directly and cache.promos is empty
    if (voucherPromoInfo && !promos.some(p => same(p?.promo_name, voucherPromoInfo?.promo_name))) {
        console.log('💉 Injecting voucherPromoInfo into promo loop:', voucherPromoInfo.promo_name);
        promos = [...promos, voucherPromoInfo];
    }

    const result = {
        orderItems: newOrderItems,
        process: null,
        applied: 0,
        amount: 0,
    };

    for (const promo of promos || []) {
        if (skipVoucherPromoNames.has((promo?.promo_name || '').toLowerCase())) {
            console.log(`🚫 Skipping already-redeemed voucher promo: ${promo.promo_name}`);
            continue;
        }
        if (
            voucherPromoInfo
                ? same(voucherPromoInfo?.promo_name, promo?.promo_name)
                : true
        ) {
            // ── Item Discount ─────────────────────────────────────────────────
            if (same(promo?.criteria_type, PROMO_TYPE.ITEM_DISCOUNT)) {
                const { orderItems, applied, amount } = processItemDiscountPromo(
                    promo,
                    newOrderItems,
                    orderItem,
                    voucherPromoInfo?.limit
                );
                newOrderItems = orderItems;
                result.applied = applied;
                result.amount = amount;
            }

            // ── Free Item / Special Price ─────────────────────────────────────
            else if (
                contains(
                    [PROMO_TYPE.FREE_ITEM, PROMO_TYPE.SPECIAL_PRICE],
                    promo?.criteria_type
                )
            ) {
                const { orderItems, applied, amount } =
                    processDirectInsertFreeItemPromo(
                        promo,
                        newOrderItems,
                        orderItem,
                        voucherPromoInfo?.limit
                    );
                newOrderItems = orderItems;
                result.applied = applied;
                result.amount = amount;
            }

            // ── Special Discount With Quantity ────────────────────────────────
            else if (
                same(promo?.criteria_type, PROMO_TYPE.SPECIAL_DISCOUNT_WITH_QUANTITY)
            ) {
                const { orderItems, applied } = processFreeItemByQuantityPromo(
                    promo,
                    newOrderItems,
                    orderItem
                );
                newOrderItems = orderItems;
                result.applied = applied;
            }

            // ── Lowest Price Discount ─────────────────────────────────────────
            // ── Lowest Price Discount ─────────────────────────────────────────────────
            else if (same(promo?.criteria_type, PROMO_TYPE.LOWEST_PRICE_DISCOUNT)) {
                console.log('🔍 LD promo config:', {
                    by_item: promo?.by_item,
                    categories: promo?.item_menu_category_dtls?.map(c => c.category_code),
                    limit: voucherPromoInfo?.limit,
                });
                console.log('🔍 LD eligible items check:', newOrderItems.map(i => ({
                    item_name: i.item_name,
                    category_code: i.category_code,
                    sub_total: i.sub_total,
                    s_no: i.s_no,
                    parent_sno: i.parent_sno,
                })));
                // ✅ SYNC WITH TS: clear stale LD tags before reprocessing
                const promoAppliedOnThisOrderItem = promos?.find((p) =>
                    same(p?.promo_name, orderItem?.disc_name)
                );

                if (
                    !voucherPromoInfo &&
                    same(orderItem?.disc_name, promo?.promo_name) &&
                    (!promoAppliedOnThisOrderItem ||
                        same(
                            promoAppliedOnThisOrderItem?.criteria_type,
                            PROMO_TYPE.LOWEST_PRICE_DISCOUNT
                        ))
                ) {
                    const groupedPromos = promos?.filter((p) =>
                        same(p?.criteria_type, PROMO_TYPE.LOWEST_PRICE_DISCOUNT)
                    );

                    groupedPromos?.forEach((p) => {
                        newOrderItems = newOrderItems
                            ?.map((orderitem) => {
                                if (same(p?.promo_name, orderitem?.disc_name) && orderitem?.ref_1) {
                                    if (notFreeItem(orderitem, p)) {
                                        return calcOrderItemDiscount(
                                            { ...orderitem, disc_name: "None", ref_1: "" },
                                            null,
                                            newOrderItems
                                        );
                                    }
                                } else {
                                    return orderitem;
                                }
                            })
                            ?.filter((orderitem) => !!orderitem);
                    });
                }

                const { orderItems, applied, amount } = processLowestPriceDiscountPromo(
                    promo,
                    newOrderItems,
                    orderItem,
                    voucherPromoInfo?.limit
                );
                newOrderItems = orderItems;
                result.applied = applied;
                result.amount = amount;
            }

            // ── Free Item With Limit ──────────────────────────────────────────
            else if (same(promo?.criteria_type, PROMO_TYPE.FREE_ITEM_WITH_LIMIT)) {
                const { processOrderItem, orderItems, applied } =
                    processFreeItemByLimitPromo(promo, newOrderItems, orderItem);
                newOrderItems = orderItems;
                result.applied = applied;
                if (processOrderItem) {
                    result.process = { promo, item: processOrderItem };
                    break;
                }
            }

            // ── Free Item By Value ────────────────────────────────────────────
            else if (same(promo?.criteria_type, PROMO_TYPE.FREE_ITEM_BY_VALUE)) {
                const { processOrderItem, orderItems, applied } =
                    processFreeItemByValuePromo(promo, newOrderItems, orderItem);
                newOrderItems = orderItems;
                result.applied = applied;
                if (processOrderItem) {
                    result.process = { promo, item: processOrderItem };
                    break;
                }
            }

            // ── Total Discount ────────────────────────────────────────────────
            // ✅ JS-specific: TS does not have TD handling
            else if (same(promo?.criteria_type, PROMO_TYPE.TOTAL_DISCOUNT)) {
                console.log(`💰 TD Promo "${promo?.promo_name}": checking threshold`);

                const isAlreadyFullyFree = (item) =>
                    parseFloat(item?.disc_value || 0) === 100 &&
                    !same(item?.disc_name, 'None') &&
                    !same(item?.disc_name, promo?.promo_name);

                const spParentSnosForTD = new Set(
                    newOrderItems
                        .filter(i =>
                            !same(i?.s_no, i?.parent_sno) &&
                            (i?.ds_no ?? 0) >= SPECIAL_PRICE_ITEM_STARTING_DS_NO
                        )
                        .map(i => String(i?.parent_sno))
                );

                const parentQtyMapForTD = {};
                newOrderItems
                    .filter(i => same(i?.s_no, i?.parent_sno))
                    .forEach(i => {
                        parentQtyMapForTD[String(i?.s_no)] = parseFloat(i?.qty || 1);
                    });

                const subTotal = newOrderItems
                    .filter(i => same(i?.s_no, i?.parent_sno))
                    .filter(i => notFreeItem(i, promo))
                    .filter(i => !isAlreadyFullyFree(i) || spParentSnosForTD.has(String(i?.s_no)))
                    .reduce((sum, parent) => {
                        const parentSnoStr = String(parent?.s_no);
                        const parentQty = parentQtyMapForTD[parentSnoStr] ?? 1;

                        if (spParentSnosForTD.has(parentSnoStr)) {
                            const spRow = newOrderItems.find(i =>
                                String(i?.parent_sno) === parentSnoStr &&
                                !same(i?.s_no, i?.parent_sno) &&
                                (i?.ds_no ?? 0) >= SPECIAL_PRICE_ITEM_STARTING_DS_NO
                            );
                            return sum + parseFloat(spRow?.sub_total || 0);
                        }

                        const familyTotal = newOrderItems
                            .filter(i =>
                                same(i?.parent_sno, parent?.s_no) &&
                                !same(i?.s_no, i?.parent_sno) &&
                                (i?.ds_no ?? 0) < SPECIAL_PRICE_ITEM_STARTING_DS_NO &&
                                notFreeItem(i, promo) &&
                                !isAlreadyFullyFree(i)
                            )
                            .reduce((childSum, child) => {
                                const unitPrice = parseFloat(child?.unit_price || 0);
                                const childSubTotal = parseFloat(child?.sub_total || 0);
                                return childSum + (unitPrice > 0
                                    ? unitPrice * parentQty
                                    : childSubTotal * parentQty);
                            }, 0);

                        const parentSubTotal = parseFloat(parent?.sub_total || 0);
                        const effectiveParent = (parentSubTotal === 0 && familyTotal > 0)
                            ? 0
                            : parentSubTotal;

                        return sum + effectiveParent + familyTotal;
                    }, 0);

                const threshold = parseFloat(promo?.receipt_terms_amount || 0);
                console.log(`💰 TD Promo subTotal=${subTotal}, threshold=${threshold}`);

                if (subTotal >= threshold) {
                    console.log(`✅ TD threshold met — applying discount`);

                    let tdApplied = 0;
                    let tdAmount = 0;

                    newOrderItems = newOrderItems.map((item) => {
                        if (!notFreeItem(item, promo)) return item;
                        if (isAlreadyFullyFree(item)) return item;

                        const referenceItem = same(item?.s_no, item?.parent_sno)
                            ? item
                            : newOrderItems.find(p =>
                                same(p?.s_no, item?.parent_sno) &&
                                same(p?.s_no, p?.parent_sno)
                            );
                        if (!referenceItem) return item;
                        if (isAlreadyFullyFree(referenceItem)) return item;

                        const eligible =
                            same(promo?.by_item, "AI") ||
                            isPromoApplicable(promo, referenceItem);
                        if (!eligible) return item;

                        const discounted = calcOrderItemDiscount(
                            { ...item },
                            {
                                disc_type: promo?.criteria_disc_type,
                                disc_name: promo?.promo_name,
                                disc_value: promo?.criteria_disc_value,
                            },
                            newOrderItems
                        );

                        tdApplied++;
                        tdAmount += parseFloat(discounted?.disc_amt || 0);
                        return discounted;
                    });

                    result.applied = tdApplied;
                    result.amount = tdAmount;
                    console.log(`📊 TD Promo applied=${tdApplied}, amount=${tdAmount}`);

                } else {
                    console.log(`⚠️ TD threshold not met — removing if previously applied`);

                    newOrderItems = newOrderItems.map((item) => {
                        if (!same(item?.disc_name, promo?.promo_name)) return item;
                        return calcOrderItemDiscount(
                            { ...item },
                            { disc_type: "N", disc_name: "None", disc_value: 0 },
                            newOrderItems
                        );
                    });
                }
            }
        }
    }

    // ✅ SYNC WITH TS: sort order items on result
    result.orderItems = typeof sortOrderItems === 'function'
        ? sortOrderItems(newOrderItems)
        : newOrderItems;

    return result;
};

export const processTotalDiscountVoucherPromo = (promo, orderItems, limit = 1) => {
    // Get eligible categories (uppercase trimmed)
    const categories =
        promo?.item_menu_category_dtls?.map(c =>
            c.category_code?.trim().toUpperCase()
        ) || [];

    let applied = 0;
    let amount = 0;

    // Filter items eligible for total discount
    const eligibleItems = orderItems.filter(item => {
        const itemCategory = item?.category_code?.trim().toUpperCase();
        return categories.length === 0 || categories.includes(itemCategory);
    });

    if (eligibleItems.length === 0) {
        return { orderItems, applied, amount }; // no eligible items
    }

    // Calculate total discount on subtotal
    let subtotal = eligibleItems.reduce((sum, i) => sum + i.price * i.qty, 0);
    let discount = 0;

    if (promo.criteria_disc_type === "P") {
        discount = subtotal * (promo.criteria_disc_value / 100);
    } else if (promo.criteria_disc_type === "F") {
        discount = promo.criteria_disc_value;
    }

    if (discount > 0) {
        applied = 1; // One application of this promo
        amount = discount;

        // Optionally, prorate discount across items
        const totalQty = eligibleItems.reduce((sum, i) => sum + i.qty, 0);
        const newItems = orderItems.map(item => {
            const itemCategory = item?.category_code?.trim().toUpperCase();
            if (categories.length === 0 || categories.includes(itemCategory)) {
                const itemTotal = item.price * item.qty;
                const itemDiscount = (itemTotal / subtotal) * discount;

                return {
                    ...item,
                    disc_name: promo.promo_name,
                    disc_amt: parseFloat(itemDiscount.toFixed(2)), // keep 2 decimals
                };
            }
            return item;
        });

        return { orderItems: newItems, applied, amount };
    }

    return { orderItems, applied, amount };
};

/**
 * Processes free item promo (free item, special price, special discount with quantity) and returns new order items.
 * @param {any} promo - The promo object.
 * @param {any[]} orderItems - The array of order items.
 * @param {any} orderItem - The order item object.
 * @returns {any[]} The array of new order items.
 */
const processDirectInsertFreeItemPromo = (
    promo,
    orderItems,
    orderItem,
    limit
) => {
    let newOrderItems = [...orderItems];

    let applied = 0;
    let amount = 0;

    let remaining = limit ?? Infinity;

    const isSpecialPricePromo = same(
        promo?.criteria_type,
        PROMO_TYPE.SPECIAL_PRICE
    );

    if (isPromoApplicable(promo, orderItem)) {
        // set deal criteria
        if (same(promo?.by_item, "SD")) {
            const { sets, _insert, _delete, _orderItems } = getPromoSets(
                promo,
                newOrderItems,
                orderItem,
                limit
            );
            if (_insert) {
                newOrderItems = clone(_orderItems);
                sets?.forEach((set) => {
                    if (remaining > 0) {
                        let tempFreeItems = getFreeItems(
                            promo,
                            set[set.length - 1],
                            newOrderItems
                        );

                        if (tempFreeItems?.length > 0) {
                            const setSnos = new Set(set?.map((item) => String(item?.s_no)));
                            const preZeroSnapshot = [...newOrderItems]; // ✅ snapshot before map

                            newOrderItems = newOrderItems?.map((item) => {
                                const isSetMember = setSnos.has(String(item?.s_no));
                                const isSetChild =
                                    !same(item?.s_no, item?.parent_sno) &&
                                    setSnos.has(String(item?.parent_sno));

                                if (isSetMember || isSetChild) {
                                    const tagged = {  // ✅ defined inside the guard
                                        ...item,
                                        disc_name: promo?.promo_name,
                                        ref_1: orderItem?.s_no,
                                    };

                                    if (isSpecialPricePromo) {
                                        // ✅ Force zero directly — bypass calcOrderItemDiscount
                                        // and addTax which recompute sub_total from unit_price
                                        return {
                                            ...tagged,
                                            disc_type: 'P',
                                            disc_value: 100,
                                            disc_amt: parseFloat(
                                                (parseFloat(tagged.unit_price) || 0) *
                                                (parseFloat(tagged.qty) || 0)
                                            ).toFixed(6),
                                            sub_total: 0,
                                            tax_amt: '0.000000',
                                            svc_amt: '0.000000',
                                        };
                                    }

                                    return tagged;
                                }

                                return item; // ✅ non-set items unchanged
                            });

                            applied++;
                            remaining--; // ✅ FIX: was `remaining -= applied`

                            if (isSpecialPricePromo) {
                                amount += Math.abs(
                                    tempFreeItems?.reduce((acc, item) => acc + item?.sub_total, 0)
                                );
                            }
                        }
                        newOrderItems = [...newOrderItems, ...tempFreeItems];
                    }
                });
                if (sets?.length === 0) {
                    newOrderItems = resetSetPromo(promo, newOrderItems, orderItem);
                }
            } else if (_delete) {
                newOrderItems = resetSetPromo(promo, newOrderItems, orderItem);
            }
        }

        // selected categories / items criteria
        else {
            if (remaining > 0) {
                const splitedOrderItems = [];
                const changedOrderItems = [];
                let latestOrderItem = clone(orderItem);

                newOrderItems?.forEach((orderitem, index) => {
                    const changesNeedOrderItem = changedOrderItems?.find((item) =>
                        same(item?.s_no, orderitem?.s_no)
                    );
                    if (changesNeedOrderItem) {
                        newOrderItems[index] = changesNeedOrderItem;
                        orderitem = changesNeedOrderItem;
                    }

                    if (same(orderitem?.s_no, orderItem?.s_no)) {
                        if (orderitem?.qty <= remaining) {
                            applied += orderitem?.qty;
                        } else {
                            const qty = remaining;
                            remaining = 0;

                            const splitSNo =
                                Math.max(...newOrderItems.map((item) => item?.s_no)) + 1;
                            const splitQty = orderitem?.qty - qty;
                            let childOffset = 0;
                            newOrderItems?.forEach((_orderitem) => {
                                if (same(_orderitem?.parent_sno, orderitem?.parent_sno)) {
                                    let qty = _orderitem?.qty;
                                    const isMainItem =
                                        _orderitem?.ds_no === 1 ||
                                        _orderitem?.s_no === _orderitem?.parent_sno;

                                    if (isMainItem) {
                                        qty = splitQty;
                                    } else {
                                        changedOrderItems.push(
                                            calcOrderItemSubtotal(
                                                { ..._orderitem, qty: _orderitem?.qty - splitQty },
                                                newOrderItems
                                            )
                                        );
                                        qty = (qty / orderitem?.qty) * splitQty;
                                    }

                                    const newSNo = isMainItem
                                        ? splitSNo
                                        : splitSNo + ++childOffset;
                                    const newParentSNo = splitSNo;

                                    splitedOrderItems.push(
                                        calcOrderItemSubtotal(
                                            {
                                                ..._orderitem,
                                                s_no: newSNo,
                                                parent_sno: newParentSNo,
                                                qty,
                                                disc_name: "",
                                                ref_1: "",
                                            },
                                            newOrderItems
                                        )
                                    );
                                }
                            });

                            const newOrderItem = {
                                ...orderitem,
                                qty,
                                sub_total: orderitem?.unit_price * qty,
                            };
                            newOrderItems[index] = newOrderItem;
                            applied += qty;
                            remaining -= applied;
                            latestOrderItem = newOrderItem;

                            newOrderItems = [...newOrderItems, ...splitedOrderItems];
                        }
                    }
                });

                let reachQty = false;
                if (promo?.criteria_payment_name) {
                    if (applied >= parseInt(promo?.criteria_payment_name)) {
                        reachQty = true;
                    }
                }

                if (reachQty) {
                    let freeItems = getFreeItems(promo, latestOrderItem, newOrderItems);
                    if (freeItems?.length > 0) {
                        newOrderItems = newOrderItems?.map((item) => {
                            if (
                                same(item?.parent_sno, item?.s_no) &&
                                same(item?.s_no, latestOrderItem?.s_no)
                            ) {
                                return {
                                    ...item,
                                    disc_name: promo?.promo_name,
                                };
                            } else {
                                return item;
                            }
                        });

                        if (isSpecialPricePromo) {
                            amount += Math.abs(
                                freeItems?.reduce((acc, item) => acc + item?.sub_total, 0)
                            );
                        }

                        newOrderItems = [...newOrderItems, ...freeItems];
                    }
                }
            }
        }
    }

    return { orderItems: newOrderItems, applied, amount };
};

/**
 * Processes free item by quantity promo and returns new order items.
 * @param {any} promo - The promo object.
 * @param {any[]} orderItems - The array of order items.
 * @param {any} orderItem - The order item object. 
 * @returns {any[]} The array of new order items.
 */
const processFreeItemByQuantityPromo = (promo, orderItems, orderItem) => {
    let newOrderItems = [...orderItems];

    let applied = 0;

    let freeItems = [];
    if (isPromoApplicable(promo, orderItem)) {
        // meet quantity limit
        if (orderItem?.qty >= promo?.criteria_spldisc_qty_limit) {
            let tempFreeItems = getFreeItems(promo, orderItem, newOrderItems);
            if (tempFreeItems?.length > 0) {
                newOrderItems = newOrderItems?.filter((orderitem) =>
                    same(orderitem?.parent_sno, orderItem?.s_no)
                        ? notFreeItem(orderitem, promo?.criteria_type)
                        : true
                );
                tempFreeItems = tempFreeItems?.map((freeitem) => ({
                    ...freeitem,
                    qty: Math.floor(orderItem?.qty / promo?.criteria_spldisc_qty_limit),
                }));
                freeItems = [...freeItems, ...tempFreeItems];
                newOrderItems = newOrderItems?.map((item) => {
                    if (
                        same(item?.parent_sno, item?.s_no) &&
                        same(item?.s_no, orderItem?.s_no)
                    ) {
                        return {
                            ...item,
                            disc_name: promo?.promo_name,
                            ref_1: orderItem?.s_no,
                        };
                    } else {
                        return item;
                    }
                });
            }
        } else {
            newOrderItems = resetSetPromo(promo, newOrderItems, orderItem);
        }
    }
    newOrderItems = [...newOrderItems, ...freeItems];

    applied = applied + freeItems?.reduce((acc, item) => acc + item?.qty, 0);

    return { orderItems: newOrderItems, applied };
};

/**
 * Get free items based on promo configuration.
 * @param {any} promo - The promo object.
 * @param {any} orderItem - The order item object.
 * @param {any[]} orderItems - The array of order items.
 * @param {string} [item_no] - Optional item number.
 * @returns {any[]} Array of free items to add.
 */
export const getFreeItems = (promo, orderItem, orderItems, item_no) => {
    const { orderSeq } = useOrder();

    const result = [];

    if (isPromoApplicable(promo, orderItem)) {
        // auto promo items inserted
        const isFreeItemPromo = same(promo?.criteria_type, PROMO_TYPE.FREE_ITEM);
        const isSpecialPriceItemPromo = same(
            promo?.criteria_type,
            PROMO_TYPE.SPECIAL_PRICE
        );
        const isSpecialDiscountWithQuantityPromo = same(
            promo?.criteria_type,
            PROMO_TYPE.SPECIAL_DISCOUNT_WITH_QUANTITY
        );

        // manual promo items inserted
        const isFreeItemWithLimitPromo = same(
            promo?.criteria_type,
            PROMO_TYPE.FREE_ITEM_WITH_LIMIT
        );
        const isFreeItemByValuePromo = same(
            promo?.criteria_type,
            PROMO_TYPE.FREE_ITEM_BY_VALUE
        );

        let i = 0;

        let freeItems = [];

        if (isSpecialPriceItemPromo || isSpecialDiscountWithQuantityPromo) {
            freeItems = [promo?.criteria_promo_item_no]?.map((item) => ({
                item_no: item,
            }));
        } else {
            freeItems = (promo?.creteria_item_dtls || [])?.filter((item) =>
                isFreeItemPromo ? true : same(item?.item_no, item_no)
            );
        }

        freeItems?.forEach((freeItem, index) => {
            const item =
                useCache()?.items.find((item) => same(item?.item_no, freeItem?.item_no)) ||
                null;

            if (item && item?.selling_uom_dtls) {
                const qty = isFreeItemByValuePromo
                    ? 1
                    : orderItem?.qty * (isFreeItemPromo ? freeItem?.qty : 1);
                const unit_price = isSpecialPriceItemPromo
                    ? promo?.by_item === "SD"
                        // ✅ Set deal: children are zeroed separately by the zeroing map,
                        // so the SP row just carries the flat special price.
                        // Original formula incorrectly deducted children sub_totals
                        // (which are 0 post-zeroing anyway) and had wrong operator precedence.
                        ? promo?.criteria_spl_price / qty
                        // Non-SD promos: keep original behaviour — deduct modifier costs
                        // from the SP price to avoid double-counting
                        : (promo?.criteria_spl_price -
                            orderItems
                                ?.filter((orderitem) => orderitem?.parent_sno === orderItem?.s_no)
                                ?.map((orderitem) => parseFloat(orderitem?.sub_total))
                                .reduce((acc, val) => acc + val, 0)
                        ) / qty
                    : isSpecialDiscountWithQuantityPromo
                        ? getPriceByServiceType(getMenuItemByItemNo(item?.item_no))
                        : 0;
                const sub_total = unit_price * qty;
                // only add free item if item is not 0, and is alacarte
                if (qty && !item?.itemmaster_menutype) {
                    i++;
                    const s_no =
                        orderItems
                            ?.map((item) => item?.s_no)
                            .reduce((max, val) => Math.max(max, val), 0) + i;
                    const parent_sno =
                        isFreeItemPromo ||
                            isSpecialPriceItemPromo ||
                            isSpecialDiscountWithQuantityPromo ||
                            isFreeItemWithLimitPromo ||
                            isFreeItemByValuePromo
                            ? orderItem?.s_no
                            : orderItems
                                ?.map((item) => item?.parent_sno)
                                .reduce(
                                    (max, val) => Math.max(max, val),
                                    FREE_ITEM_STARTING_DS_NO
                                ) + i;

                    let from = 0;
                    switch (promo?.criteria_type) {
                        case PROMO_TYPE.FREE_ITEM:
                        case PROMO_TYPE.FREE_ITEM_WITH_LIMIT:
                            from = FREE_ITEM_STARTING_DS_NO;
                            break;
                        case PROMO_TYPE.FREE_ITEM_BY_VALUE:
                            from = FREE_ITEM_BY_VALUE_STARTING_DS_NO;
                            break;
                        case PROMO_TYPE.SPECIAL_PRICE:
                            from = SPECIAL_PRICE_ITEM_STARTING_DS_NO;
                            break;
                        case PROMO_TYPE.SPECIAL_DISCOUNT_WITH_QUANTITY:
                            from = SPECIAL_DISCOUNT_WITH_QUANTITY_ITEM_STARTING_DS_NO;
                            break;
                    }
                    let ds_no;
                    const dsNos = (orderItems || [])
                        .filter(
                            (item) =>
                                same(item?.parent_sno, orderItem?.s_no) && item?.ds_no >= from
                        )
                        .map((item) => item.ds_no);
                    if (dsNos.length === 0) {
                        ds_no = from;
                    } else {
                        ds_no = Math.max(...dsNos) + 1;
                    }

                    const selling_uom_dtls = item?.selling_uom_dtls[0];

                    let freeItemObj = {
                        s_no,
                        parent_sno,
                        ds_no,
                        seat_no: 1,
                        category_code: item?.category_code,
                        item_no: item?.item_no,
                        item_name: item?.item_name,
                        item_desc: item?.item_desc,
                        remarks: "",
                        qty,
                        uom: selling_uom_dtls.uom,
                        uom_cf: selling_uom_dtls.uom_cf,
                        unit_price,
                        disc_type: "N",
                        disc_name: promo?.promo_name,
                        disc_value: 0,
                        disc_amt: 0,
                        sub_total,
                        pro_disc_amt: 0,
                        svc_amt: "0.000000",
                        is_apply_svc: item?.is_apply_svc,
                        tax_amt: "0.000000",
                        tax_rate: item?.tax_value,
                        tax_value: item?.tax_value,
                        is_absorbtax: isAbsorbTax(item),
                        take_away_item: "N",
                        order_seq: orderSeq,
                        order_seq_type: "New",
                        order_datetime: getNowInAPIFormat(useCache()?.date),
                        print_flag: "N",
                        item_kds_ready_status: "N",
                        item_kds_ready_datetime: getNowInAPIFormat(useCache()?.date),
                        item_kds_serve_status: "N",
                        item_kds_serve_datetime: getNowInAPIFormat(useCache()?.date),
                        override_f: 0,
                        is_addon_enable: item?.is_addon_enable,
                        add_on_name: item?.add_on_name,
                        menu_type: "",
                        modifier_name: "",
                        ref_1: orderItem?.s_no,
                        ref_2: "",
                        ref_3: "",
                        ref_4: "",
                    };

                    result.push(addTax(freeItemObj));
                }
            }
        });
    }

    return result;
};


/**
 * Processes item discount promo and returns new order items.
 * @param {any} promo - The promo object.
 * @param {any[]} orderItems - The array of order items.
 * @param {any} orderItem - The order item object.
 * @param {number} limit - The limit of the promo.
 * @returns {object} Object with orderItems, applied, and amount.
 */
const processItemDiscountPromo = (promo, orderItems, orderItem, limit) => {
    let newOrderItems = clone(orderItems);
    let applied = 0;
    let amount = 0;

    const { sets, _insert, _orderItems } = getPromoSets(promo, newOrderItems, orderItem, limit);

    if (_insert && sets?.length > 0) {
        newOrderItems = clone(_orderItems);
        const setSNoList = sets?.flat()?.map((item) => item?.s_no);

        newOrderItems?.forEach((orderitem, index) => {
            let disc_type = promo?.criteria_disc_type;
            let disc_value = promo?.criteria_disc_value;
            let apply = false;

            if (same(disc_type, "E")) {
                const found = promo?.creteria_item_dtls?.find(
                    (c) => same(c?.category_code, orderitem?.category_code) && same(c?.item_no, orderitem?.item_no)
                );
                if (found && found?.qty > 0) { apply = true; disc_type = "A"; disc_value = found?.qty; }
            } else if (same(disc_type, "F")) {
                const found = promo?.creteria_item_dtls?.find(
                    (c) => same(c?.category_code, orderitem?.category_code) && same(c?.item_no, orderitem?.item_no)
                );
                if (found && found?.qty > 0) { apply = true; disc_type = "P"; disc_value = found?.qty; }
            } else {
                if (
                    contains(setSNoList, orderitem?.s_no) &&
                    isPromoApplicable(promo, orderitem, newOrderItems) &&
                    parseFloat(disc_value) > 0  // ✅ TS adds this guard
                ) {
                    apply = true;
                }
            }

            if (apply) {
                // ✅ SELECTED_CATEGORIES_CHILD — TS: only process when ds_no === 1, skip children (handled via parent)
                if (same(promo?.by_item, PROMO_BY.SELECTED_CATEGORIES_CHILD)) {
                    if (orderitem?.ds_no !== 1) {
                        // child items handled when parent is processed — skip
                    } else {
                        const promoCategoryCodes = (promo?.item_menu_category_dtls || []).map((item) => item?.category_code);
                        newOrderItems?.forEach((item, i) => {
                            if (
                                same(item?.parent_sno, orderitem?.parent_sno) &&
                                item?.ds_no !== 1 &&
                                (isModifierItem(item) || isModifier2Item(item) || isAddonItem(item) || isAddon2Item(item))
                            ) {
                                if (contains(promoCategoryCodes, item?.category_code)) {
                                    // ✅ isChildItem: true — uses line gross instead of sub_total
                                    const discountedItem = calcOrderItemDiscount(
                                        item,
                                        { disc_type, disc_name: promo?.promo_name, disc_value },
                                        newOrderItems,
                                        true
                                    );
                                    newOrderItems[i] = discountedItem;
                                    applied += discountedItem?.qty;
                                    amount += parseFloat(discountedItem?.disc_amt || 0);
                                }
                                // non-matching child: no action (TS removes the disc_name-only tag)
                            }
                        });
                    }
                }

                // ✅ NEW: SELECTED_ITEMS_CHILD
                else if (same(promo?.by_item, PROMO_BY.SELECTED_ITEMS_CHILD)) {
                    if (orderitem?.ds_no !== 1) {
                        // skip — handled via parent
                    } else {
                        const promoItems = (promo?.item_dtls || []).map((item) => item?.item_no);
                        newOrderItems?.forEach((item, i) => {
                            if (
                                same(item?.parent_sno, orderitem?.parent_sno) &&
                                item?.ds_no !== 1 &&
                                (isModifierItem(item) || isModifier2Item(item) || isAddonItem(item) || isAddon2Item(item))
                            ) {
                                if (contains(promoItems, item?.item_no)) {
                                    const discountedItem = calcOrderItemDiscount(
                                        item,
                                        { disc_type, disc_name: promo?.promo_name, disc_value },
                                        newOrderItems,
                                        true
                                    );
                                    newOrderItems[i] = discountedItem;
                                    applied += discountedItem?.qty;
                                    amount += parseFloat(discountedItem?.disc_amt || 0);
                                }
                            }
                        });
                    }
                }

                // ✅ NEW: PREFIX_CHILD
                else if (same(promo?.by_item, PROMO_BY.PREFIX_CHILD)) {
                    if (orderitem?.ds_no !== 1) {
                        // skip — handled via parent
                    } else {
                        const prefixes = (promo?.item_dtls || []).map((item) => item?.prefix);
                        newOrderItems?.forEach((item, i) => {
                            if (
                                same(item?.parent_sno, orderitem?.parent_sno) &&
                                item?.ds_no !== 1 &&
                                (isModifierItem(item) || isModifier2Item(item) || isAddonItem(item) || isAddon2Item(item))
                            ) {
                                if (contains(prefixes, getRefItemPrefix(item?.item_name))) {
                                    const discountedItem = calcOrderItemDiscount(
                                        item,
                                        { disc_type, disc_name: promo?.promo_name, disc_value },
                                        newOrderItems,
                                        true
                                    );
                                    newOrderItems[i] = discountedItem;
                                    applied += discountedItem?.qty;
                                    amount += parseFloat(discountedItem?.disc_amt || 0);
                                }
                            }
                        });
                    }
                }

                // ✅ Default — TS only processes ds_no === 1 (parent items)
                else {
                    if (orderitem?.ds_no === 1) {
                        const discountedItem = calcOrderItemDiscount(
                            orderitem,
                            { disc_type, disc_name: promo?.promo_name, disc_value },
                            newOrderItems
                        );
                        newOrderItems[index] = discountedItem;
                        applied += discountedItem?.qty;
                        amount += parseFloat(discountedItem?.disc_amt || 0);

                        // ✅ TS: only propagate to modifiers (not addons) for menu_type items
                        if (orderitem?.menu_type) {
                            newOrderItems?.forEach((item, i) => {
                                if (
                                    same(item?.parent_sno, orderitem?.parent_sno) &&
                                    item?.ds_no !== 1 &&
                                    (isModifierItem(item) || isModifier2Item(item))
                                ) {
                                    const discountedChild = calcOrderItemDiscount(
                                        item,
                                        { disc_type, disc_name: promo?.promo_name, disc_value },
                                        newOrderItems
                                    );
                                    newOrderItems[i] = discountedChild;
                                    applied += discountedChild?.qty;
                                    amount += parseFloat(discountedChild?.disc_amt || 0);
                                }
                            });
                        }
                    }
                }
            }
        });
    }

    return { orderItems: newOrderItems, applied, amount };
};

/**
 * Processes lowest price discount promo and returns new order items.
 * @param {any} promo - The promo object.
 * @param {any[]} orderItems - The array of order items.
 * @param {any} orderItem - The order item object.
 * @returns {any[]} The array of new order items.
 */
const processLowestPriceDiscountPromo = (
    promo,
    orderItems,
    orderItem,
    limit
) => {
    const { setLastSNo, setSelectedOrderItemSNo } = order();

    let newOrderItems = clone(orderItems);

    let applied = 0;
    let amount = 0;

    let remaining = limit ?? Infinity;

    // set deal criteria
    if (same(promo?.by_item, PROMO_BY.SET_DEALS)) {
        const { sets, _insert, _orderItems } = getPromoSets(
            promo,
            newOrderItems,
            orderItem,
            limit
        );
        if (_insert && sets?.length > 0) {
            newOrderItems = clone(_orderItems);
            sets?.forEach((set) => {
                if (remaining > 0) {
                    // Only consider parent items (ds_no === 1) when choosing which group gets the discount
                    const parentItemsInSet =
                        set?.filter((item) => same(item?.ds_no, 1)) ?? [];
                    const lowestPriceOrderItem = parentItemsInSet?.sort((a, b) => {
                        // Group total = item's own unit_price + sum of all children (same parent_sno)
                        const getGroupTotal = (item) => {
                            const childSum =
                                newOrderItems
                                    ?.filter((i) => same(i?.parent_sno, item?.s_no))
                                    ?.reduce((acc, i) => acc + (i?.unit_price || 0), 0) ?? 0;
                            return (item?.unit_price || 0) + childSum;
                        };
                        return getGroupTotal(a) - getGroupTotal(b);
                    })[0];

                    if (lowestPriceOrderItem) {
                        // split order item out if the lowest price item has more than 1 quantity
                        if (lowestPriceOrderItem?.qty > 1) {
                            let s_no =
                                Math.max(...newOrderItems.map((item) => item?.s_no)) + 1;

                            const remainderQty = lowestPriceOrderItem?.qty - 1;
                            const originalQty = lowestPriceOrderItem?.qty;

                            // create split parent for the remainder
                            const splitParentSno = s_no;
                            const splitedOrderItem = calcOrderItemSubtotal(
                                {
                                    ...lowestPriceOrderItem,
                                    s_no,
                                    parent_sno: s_no,
                                    qty: remainderQty,
                                },
                                newOrderItems
                            );

                            // create split children for the remainder
                            const splitChildren = newOrderItems
                                ?.filter(
                                    (i) =>
                                        same(i?.parent_sno, lowestPriceOrderItem?.parent_sno) &&
                                        i?.ds_no !== 1 &&
                                        (isModifierItem(i) ||
                                            isModifier2Item(i) ||
                                            isAddonItem(i) ||
                                            isAddon2Item(i))
                                )
                                ?.map((i) => {
                                    const qty = (i?.qty * remainderQty) / originalQty;
                                    return {
                                        ...i,
                                        s_no: ++s_no,
                                        parent_sno: splitParentSno,
                                        qty,
                                        sub_total: i?.unit_price * qty,
                                    };
                                });

                            // reduce original parent + children to qty 1
                            newOrderItems = newOrderItems?.map((item) => {
                                if (same(item?.s_no, lowestPriceOrderItem?.s_no)) {
                                    return calcOrderItemSubtotal(
                                        { ...item, qty: 1 },
                                        newOrderItems
                                    );
                                } else if (
                                    same(item?.parent_sno, lowestPriceOrderItem?.s_no) &&
                                    !same(item?.s_no, lowestPriceOrderItem?.s_no)
                                ) {
                                    return calcOrderItemSubtotal(
                                        {
                                            ...item,
                                            qty: (item?.qty * 1) / originalQty,
                                        },
                                        newOrderItems
                                    );
                                } else {
                                    return item;
                                }
                            });

                            newOrderItems.push(splitedOrderItem, ...splitChildren);
                            set.push(splitedOrderItem);
                            setLastSNo(s_no);
                            setSelectedOrderItemSNo(splitParentSno);
                        }

                        newOrderItems = newOrderItems?.map((item) => {
                            // Apply discount only to the lowest item's group (item itself + its children)
                            const isInLowestGroup =
                                same(item?.s_no, lowestPriceOrderItem?.s_no) ||
                                same(item?.parent_sno, lowestPriceOrderItem?.s_no);
                            if (isInLowestGroup) {
                                applied += item?.qty;
                                amount += (item?.unit_price || 0) * (item?.qty || 1);
                                return calcOrderItemDiscount(
                                    {
                                        ...item,
                                        disc_name: promo?.promo_name,
                                        ref_1: set[0]?.s_no,
                                    },
                                    {
                                        disc_type: promo?.criteria_disc_type,
                                        disc_name: promo?.promo_name,
                                        disc_value: promo?.criteria_disc_value,
                                    },
                                    newOrderItems
                                );
                            } else if (
                                contains(
                                    set?.map((item) => item?.s_no),
                                    item?.s_no
                                )
                            ) {
                                return {
                                    ...item,
                                    disc_name: promo?.promo_name,
                                    ref_1: set[0]?.s_no,
                                };
                            } else {
                                return item;
                            }
                        });

                        remaining -= applied;
                    }
                }
            });
        }
    }

    // there is no selected categories / items criteria currently

    return { orderItems: newOrderItems, applied, amount };
};

/**
 * Processes free item by limit promo and returns new order items.
 * @param {any} promo - The promo object.
 * @param {any[]} orderItems - The array of order items.
 * @param {any} orderItem - The order item object.
 * @returns {any[]} The array of new order items.
 */
const processFreeItemByLimitPromo = (
    promo,
    orderItems,
    orderItem
) => {
    let newOrderItems = clone(orderItems);
    let processOrderItem = null;

    if (isPromoApplicable(promo, orderItem, newOrderItems)) {
        const { sets, _insert, _orderItems } = getPromoSets(
            promo,
            newOrderItems,
            orderItem
        );

        const set = sets?.find((set) =>
            contains(
                set?.map((item) => item?.s_no),
                orderItem?.s_no
            )
        );

        if (_insert && set) {
            const orderItem = set[set.length - 1];
            newOrderItems = updateValuesForGroupItems(
                promo,
                set,
                _orderItems,
                orderItem
            );
            processOrderItem = orderItem;
        }
    }

    return {
        processOrderItem,
        orderItems: newOrderItems,
        applied: parseFloat(processOrderItem?.qty) || 0,
    };
};
/**
 * Get order items that form the "group" for free item by value: all applicable non-accumulated lines (SC/SI/AI) so their subtotals are summed.
 * Free item by value is not applicable for set deal (SD); returns null when by_item is SD.
 * @param {any} promo - The promo object.
 * @param {any[]} orderItems - The array of order items.
 * @param {any} orderItem - The order item object.
 * @returns {object|null} { groupItems, groupParentSNos, leadOrderItem } or null if orderItem not in any group.
 */
const getFreeItemByValueGroup = (promo, orderItems, orderItem) => {
    if (same(promo?.by_item, "SD")) return null;

    const orderItemParentSNo = same(orderItem?.parent_sno, orderItem?.s_no)
        ? orderItem?.s_no
        : orderItem?.parent_sno;

    // Group all applicable parent lines (non-accumulated) so sum of subtotals is used
    const applicableParents = orderItems?.filter(
        (item) =>
            same(item?.parent_sno, item?.s_no) &&
            isPromoApplicable(promo, item) &&
            (same(item?.disc_name, "None") ||
                same(
                    findPromoByName(item?.disc_name)?.criteria_type,
                    PROMO_TYPE.TOTAL_DISCOUNT
                ))
    );

    const groupParentSNos = applicableParents?.map((item) => item?.s_no) ?? [];
    if (
        !contains(groupParentSNos, orderItem?.s_no) &&
        !contains(groupParentSNos, orderItemParentSNo)
    )
        return null;
    const groupItems = orderItems?.filter(
        (item) =>
            contains(groupParentSNos, item?.s_no) ||
            contains(groupParentSNos, item?.parent_sno)
    );
    return {
        groupItems,
        groupParentSNos,
        leadOrderItem: applicableParents?.[applicableParents.length - 1],
    };
};

/**
 * Processes free item by value promo and returns new order items.
 * @param {any} promo - The promo object.
 * @param {any[]} orderItems - The array of order items.
 * @param {any} orderItem - The order item object.
 * @returns {any} The result object.
 */
const processFreeItemByValuePromo = (promo, orderItems, orderItem) => {
    let newOrderItems = clone(orderItems);
    let processOrderItem = null;

    if (isPromoApplicable(promo, orderItem, newOrderItems)) {
        const { sets, _insert, _orderItems } = getPromoSets(
            promo,
            newOrderItems,
            orderItem
        );

        const set = sets?.find((set) =>
            contains(
                set?.map((item) => item?.s_no),
                orderItem?.s_no
            )
        );

        if (_insert && set) {
            newOrderItems = updateValuesForGroupItems(
                promo,
                set,
                _orderItems,
                orderItem
            );
            const sub_total =
                set
                    ?.map((item) => item?.sub_total)
                    ?.reduce((acc, val) => acc + val, 0) ?? 0;
            const insertedFreeItemsQty =
                getInsertedFreeItems(promo, set)
                    ?.map((item) => item?.qty)
                    ?.reduce((acc, val) => acc + val, 0) ?? 0;
            const maxFreeItemQty =
                Math.floor(sub_total / promo?.receipt_terms_amount) *
                promo?.criteria_free_item_qty_limit;

            // free item by value one time for the achieved item subtotal
            if (same(promo?.receipt_amt_check_by, "O") && insertedFreeItemsQty <= 0) {
                processOrderItem = orderItem;
            }
            // free item by value n times for the achieved item subtotal
            else if (same(promo?.receipt_amt_check_by, "E")) {
                if (insertedFreeItemsQty < maxFreeItemQty) {
                    processOrderItem = orderItem;
                }
            }
        }
    }

    return {
        processOrderItem,
        orderItems: newOrderItems,
        applied: parseFloat(processOrderItem?.qty) || 0,
    };
};

/**
 * Insert discount name for all parent items in the set for manual free item promo and return new order items.
 * @param {any} promo - The promo object.
 * @param {any[]} orderItems - The array of order items.
 * @param {any} orderItem - The order item object.
 * @returns {any[]} The array of new order items.
 */
export const insertDiscountName = (promo, orderItems, orderItem) => {
    let newOrderItems = [...orderItems];

    if (
        getInsertedFreeItems(
            promo,
            newOrderItems?.filter((item) => same(item?.parent_sno, orderItem?.s_no))
        )?.length > 0
    ) {
        if (same(promo?.by_item, "SD")) {
            const { sets, _orderItems } = getPromoSets(
                promo,
                newOrderItems,
                orderItem
            );
            if (sets?.length > 0) {
                newOrderItems = _orderItems?.map((orderitem) => ({ ...orderitem }));
            }
            let selectedSet = null;
            for (const set of sets) {
                if (
                    contains(
                        set?.map((set) => set?.s_no),
                        orderItem?.s_no
                    )
                ) {
                    selectedSet = set;
                    break;
                }
            }
            if (selectedSet) {
                newOrderItems = newOrderItems?.map((orderitem) => {
                    if (
                        contains(
                            selectedSet?.flat()?.map((set) => set?.s_no),
                            orderitem?.s_no
                        )
                    ) {
                        return {
                            ...orderitem,
                            disc_name: promo?.promo_name,
                            ref_1: orderItem?.s_no,
                        };
                    } else {
                        return orderitem;
                    }
                });
            }
        }
        else {
            newOrderItems = newOrderItems?.map((orderitem) => {
                if (same(orderitem?.s_no, orderItem?.s_no)) {
                    return {
                        ...orderitem,
                        disc_name: promo?.promo_name,
                        ref_1: orderItem?.s_no,
                    };
                } else {
                    return orderitem;
                }
            });
        }
    }

    return newOrderItems;
};

/**
 * Reset set deal promo in the set and returns new order items.
 * @param {any} promo - The promo object.
 * @param {any[]} orderItems - The array of order items.
 * @param {any} orderItem - The order item object.
 * @returns {any[]} The array of new order items.
 */
const resetSetPromo = (promo, orderItems, orderItem) => {
    let newOrderItems = [...orderItems];
    newOrderItems = newOrderItems
        ?.filter((orderitem) => {
            if (orderitem?.ref_1 && same(orderItem?.ref_1, orderitem?.ref_1)) {
                // ✅ Only remove free/SP rows that belong to THIS promo
                // Don't remove rows tagged with a different promo's name
                const belongsToThisPromo = !orderitem?.disc_name
                    || same(orderitem?.disc_name, 'None')
                    || same(orderitem?.disc_name, promo?.promo_name);
                return belongsToThisPromo ? notFreeItem(orderitem, promo) : true;
            }
            return true;
        })
        ?.map((orderitem) => {
            if (
                orderitem?.ref_1 &&
                same(orderItem?.ref_1, orderitem?.ref_1) &&
                (same(orderitem?.disc_name, promo?.promo_name) || !orderitem?.disc_name)
            ) {
                return calcOrderItemDiscount(
                    {
                        ...orderitem,
                        disc_name: "None",
                        ref_1: "",
                        ref_2: "",
                    },
                    null,
                    newOrderItems
                );
            } else {
                return orderitem;
            }
        });
    return newOrderItems;
};

/**
 * Find promo by promo name.
 * @param {string} name - The name of the promo.
 * @returns {any} The promo object.
 */
const findPromoByName = (name) => {
    // ✅ Add safety check
    const promos = Array.isArray(useCache()?.promos) ? useCache()?.promos : [];
    return promos.find((promo) => same(promo?.promo_name, name));
};
/**
 * Check if delivery partners are integrated.
 * @returns {boolean} True if delivery partners are integrated, false otherwise.
 */
export const isDeliveryPartnersIntegrated = () =>
    (bool(getSetting("MORE", "DELIVERY", "GRABFOOD_INTEGRATION")) &&
        bool(getSetting("MORE", "DELIVERY", "GRABFOOD"))) ||
    (bool(getSetting("MORE", "DELIVERY", "FOODPANDA_INTEGRATION")) &&
        bool(getSetting("MORE", "DELIVERY", "FOODPANDA"))) ||
    (bool(getSetting("MORE", "DELIVERY", "DELIVEROO_INTEGRATION")) &&
        bool(getSetting("MORE", "DELIVERY", "DELIVEROO"))) ||
    (bool(getSetting("MORE", "DELIVERY", "ALIPAY_INTEGRATION")) &&
        bool(getSetting("MORE", "DELIVERY", "ALIPAY")));

/**
 * Get system setting value by group name and param id.
 * @param {string} group_name - The group name.
 * @param {string} param_id - The param id.
 * @returns {string} The system setting value.
 */
export const getSysSetting = (group_name, param_id) => {
    return (
        useCache()?.systemSettings?.find((item) =>
            same(item?.group_name, group_name)
        )?.setting_group_dtls || []
    )?.find((item) => same(item?.sys_param_id, param_id))?.sys_param_value;
};

/**
 * Get order items diff.
 * @returns {any[]} The array of order items diff.
 */
export const getOrderItemsDiff = () => {
    const { oriOrder, order: newOrder } = useOrder();

    const orderItems = [];

    (oriOrder?.sales_dtls || [])?.forEach((oriorderitem) => {
        const existedItem = newOrder?.sales_dtls?.find(
            (orderitem) =>
                same(orderitem?.s_no, oriorderitem?.s_no) &&
                same(orderitem?.item_no, oriorderitem?.item_no)
        );
        if (!existedItem) {
            orderItems.push({ ...oriorderitem, qty: -oriorderitem?.qty });
        }
    });

    if (oriOrder) {
        (newOrder?.sales_dtls || [])?.forEach((orderitem) => {
            const existedItem = oriOrder?.sales_dtls?.find(
                (oriorderitem) =>
                    same(oriorderitem?.s_no, orderitem?.s_no) &&
                    same(oriorderitem?.item_no, orderitem?.item_no)
            );
            if (existedItem) {
                if (orderitem?.qty !== existedItem?.qty) {
                    const qty = orderitem?.qty - existedItem?.qty;
                    orderItems.push({ ...existedItem, qty });
                }
            } else {
                orderItems.push({ ...orderitem, qty: orderitem?.qty });
            }
        });
    }

    const cancelledOrderItems = orderItems?.filter((item) => item?.qty <= 0);
    const additionalOrderItems = orderItems?.filter((item) => item?.qty > 0);

    return { cancelledOrderItems, additionalOrderItems };
};

/**
 * Get new order.
 * @param {any} data - The data.
 * @returns {any} The new order.
 */
export const getNewOrder = (data) => {
    const { date, store } = useCache();

    const service_type = data?.service_type || "E";

    const service_type_info = SERVICE_TYPES?.find((item) =>
        same(item?.service_type, service_type)
    )?.service_type_info;

    const table_no = data?.table_no || "";

    delete data?.service_type;
    delete data?.service_type_info;
    delete data?.table_no;

    const newOrder = calcOrderAmt({
        sales_no: "",
        doc_date: getNowInAPIFormat(date),
        customer_code: "",
        cust_addr_s_no: "",
        service_type,
        service_type_info,
        order_status_id: "N",
        order_status_desc: "New",
        kitchen_status_id: "P",
        kitchen_status_desc: "In Progress",
        sub_total: "0.00",
        disc_type: "N",
        disc_name: "None",
        disc_value: 0,
        total_disc: "0.00",
        total_svc: "0.00",
        total_tax: "0.00",
        round_adj_amt: "0.00",
        absorb_tax: store?.is_absorbtax ? "Y" : "N",
        absorb_tax_info: store?.is_absorbtax ? "Absorb Tax" : "Not Absorb Tax",
        net_amt: "0.00",
        tips_amt: "0.00",
        total_tender_amt: "0.00",
        change_amt: "0.00",
        no_of_pax: 1,
        table_no,
        remarks: "",
        del_driver: "",
        ref_1: "",
        ref_2: "",
        ref_3: "",
        ref_4: "",
        ref_5: "",
        sales_dtls: [],
        sales_service_dtls: [],
        sales_payment_dtls: [],
        sales_other_info: "",
        table_transfer: "N",
        table_transfer_sno: "",
        ...data,
    });

    return newOrder;
};

/**
 * Get new order.
 * @param {any} data - The data.
 * @returns {any} The new order.
 */

export const getNewOrderSOK = (data) => {
    delete data?.service_type;
    delete data?.service_type_info;
    delete data?.table_no;

    const { date, store, svcs: cacheSvcs } = useCache();
    const svcs = cacheSvcs || window.apiManager?.loadedData?.get('svcs');
    const service_type = data?.service_type || localStorage.getItem("orderType");

    const service_type_info = SERVICE_TYPES
        ?.find(item => item?.service_type === service_type)
        ?.service_type_info;

    const isTakeaway = service_type === "T";
    const currentDateTime = getNowInAPIFormat(date);
    const customer_code = data?.customer_code || "";
    const svcConfig = Array.isArray(svcs)
        ? svcs.find(s => s.service_type === service_type)
        : null;
    const svcRate = Number(svcConfig?.service_value ?? 0);
    const svcBy = svcConfig?.service_by ?? 'P';
    const isApplySvc = svcRate > 0 ? 1 : 0;

    const absorbTax = isAbsorbTax() ? "Y" : "N";


    const table_no = data?.table_no || "";



    const newOrder = calcOrderAmt({
        sales_no: "",
        doc_date: currentDateTime,
        customer_code,
        cust_addr_s_no: "",
        service_type,
        service_type_info,
        order_status_id: "N",
        order_status_desc: "New",
        kitchen_status_id: "P",
        kitchen_status_desc: "In Progress",
        sub_total: 0,
        disc_type: "N",
        disc_name: "None",
        disc_value: 0,
        total_disc: 0,
        total_svc: 0,
        total_tax: 0,
        round_adj_amt: 0,
        absorb_tax: absorbTax,
        absorb_tax_info: absorbTax === "Y" ? "Absorb Tax" : "Not Absorb Tax",
        net_amt: 0,
        tips_amt: 0,
        total_tender_amt: 0,
        change_amt: 0,
        no_of_pax: 1,
        table_no,
        remarks: "",
        del_driver: "",
        ref_1: "",
        ref_2: "",
        ref_3: "",
        ref_4: "",
        ref_5: "",
        sales_dtls: [],
        sales_service_dtls: [],
        sales_payment_dtls: [],
        sales_other_info: "",
        table_transfer: "N",
        table_transfer_sno: "",
        order_from: "SOK",
        mode_of_order: service_type_info,
        order_mode: "PayFirst",
        qr_type: "Static",
        store_name: store?.store_name || "",
        comp_code: store?.comp_code || "01",
        register_name: store?.register_name || "POS01",
        shift_code: store?.shift_code || "SHIFT1",
        c_date: currentDateTime,
        m_date: currentDateTime,
        c_userid: "WEBORDER",
        m_userid: "WEBORDER",
        svc_rate: svcRate,
        svc_by: svcBy,
        is_apply_svc: isApplySvc,
        ...data,
    });

    console.log('🔧 getNewOrderSOK result:', {
        service_type: newOrder.service_type,
        service_type_info: newOrder.service_type_info,
        mode_of_order: newOrder.mode_of_order,
        localStorage_orderType: localStorage.getItem('orderType')
    });
    return newOrder;
};



//export const getNewOrderSOK = (data) => {
//    const { date, store } = useCache();
//    const service_type = data?.service_type || localStorage.getItem("orderType");
//    const service_type_info = SERVICE_TYPES?.find((item) =>
//        same(item?.service_type, service_type)
//    )?.service_type_info;
//    // ✅ SOK-specific fields
//    const table_no = ""; // Always empty for SOK
//    const order_from = data?.order_from || "SOK";
//    const mode_of_order = data?.mode_of_order || service_type_info || (service_type === "E" ? "Dine In" : "Takeaway");
//    const order_mode = data?.order_mode || "PayFirst";
//    const qr_type = data?.qr_type || "Static";
//    const store_name = data?.store_name || store?.store_name || "";
//    const customer_code = data?.customer_code || "";

//    // ✅ Company/Register info from store
//    const comp_code = data?.comp_code || store?.comp_code || "01";
//    const register_name = data?.register_name || store?.register_name || "POS01";
//    const shift_code = data?.shift_code || store?.shift_code || "SHIFT1";

//    // ✅ User tracking
//    const c_userid = data?.c_userid || "WEBORDER";
//    const m_userid = data?.m_userid || "WEBORDER";
//    const currentDateTime = getNowInAPIFormat(date);

//    // Clean up data object to avoid duplication
//    delete data?.service_type;
//    delete data?.service_type_info;
//    delete data?.table_no;
//    delete data?.order_from;
//    delete data?.mode_of_order;
//    delete data?.order_mode;
//    delete data?.qr_type;
//    delete data?.store_name;
//    delete data?.customer_code;
//    delete data?.comp_code;
//    delete data?.register_name;
//    delete data?.shift_code;
//    delete data?.c_userid;
//    delete data?.m_userid;

//    const newOrder = calcOrderAmt({
//        // ✅ SOK Required Fields (from payload analysis)
//        comp_code,
//        register_name,
//        shift_code,
//        sales_no: "",

//        service_type,
//        service_type_info,
//        order_from,              // "SOK"
//        mode_of_order,           // "Dine In" or "Takeaway"
//        order_mode,              // "PayFirst"
//        qr_code: "",
//        qr_type,                 // "Static"
//        store_name,

//        order_status_id: "N",
//        order_status_desc: "New",
//        kitchen_status_id: "P",
//        kitchen_status_desc: "In Progress",
//        kds_status: "P",         // ✅ Kitchen Display System status

//        doc_date: currentDateTime,
//        c_date: currentDateTime,
//        m_date: currentDateTime,
//        c_userid,                // "WEBORDER"
//        m_userid,                // "WEBORDER"

//        customer_code,           // "exempt"
//        customer_name: "",
//        contact_no: "",
//        email: "",
//        address: "",
//        postal_code: "",
//        dob: "",
//        cust_addr_s_no: "",

//        sub_total: "0.00",
//        disc_type: "N",
//        disc_name: "None",
//        disc_value: 0,
//        disc_amt: 0,
//        total_disc: "0.00",
//        total_svc: "0.00",
//        total_tax: "0.00",
//        round_adj_amt: "0.00",
//        absorb_tax: store?.is_absorbtax ? "Y" : "N",
//        absorb_tax_info: store?.is_absorbtax ? "Absorb Tax" : "Not Absorb Tax",
//        net_amt: "0.00",
//        tips_amt: "0.00",
//        total_tender_amt: "0.00",
//        change_amt: 0,

//        no_of_pax: 1,
//        table_no,                // "" (empty for SOK)
//        new_table_no: "",
//        table_transfer: "N",
//        table_transfer_sno: "",

//        remarks: "",
//        kitchen_remarks: "",
//        del_driver: "",

//        ref_1: "",
//        ref_2: "",
//        ref_3: "",
//        ref_4: "",
//        ref_5: "",

//        sales_dtls: [],
//        sales_service_dtls: [],
//        sales_payment_dtls: [],
//        sales_other_info: "",

//        // ✅ Delivery/Pickup timestamps
//        delivery_datetime: "",
//        pickup_datetime: data?.pickup_datetime || "",

//        // ✅ Payment info (for tracking)
//        payment_register_name: register_name,
//        payment_shift_code: shift_code,
//        card_no: "",

//        ...data, // Allow override of any field
//    });

//    return newOrder;
//};
/**
 * Get last s_no.
 * @param {any[]} orderItems - The array of order items.
 * @returns {number} The last s_no.
 */
export const getLastSNo = (orderItems) => {
    return Math.max(...(orderItems || []).map((item) => parseInt(item?.s_no)), 0);
};

/**
 * Convert order items to parent-children format.
 * @param {any[]} orderItems - The array of order items.
 * @returns {any[]} The array of parent-children order items.
 */
export const formatOrderItemsToParentChild = (orderItems) => {
    let newOrderItems = [];
    (orderItems || [])?.forEach((item) => {
        const parentIndex = newOrderItems.findIndex(
            (_item) => _item.s_no === item.parent_sno
        );
        if (parentIndex >= 0) {
            newOrderItems[parentIndex]["childItems"].push(item);
        } else {
            newOrderItems.push({ ...item, childItems: [] });
        }
    });
    return newOrderItems;
};

/**
 * Reset rounding.
 * @param {any} order - The order.
 * @returns {any} The new order.
 */
export const resetRounding = (order) => {
    return {
        ...order,
        round_adj_amt: "0.00",
        net_amt: (
            parseFloat(order?.net_amt) - parseFloat(order?.round_adj_amt)
        ).toFixed(2),
    };
};

/**
 * Check if item needs mandatory remarks.
 * @param {any} item - The item.
 * @returns {boolean} True if item needs mandatory remarks, false otherwise.
 */
export const needMandatoryItemRemarks = (item) => {
    const { itemRemarks } = useCache();
    const remarksItemDetails = itemRemarks?.find((itemremark) =>
        same(itemremark?.item_no, item?.item_no)
    )?.remarks_item_details;
    if (remarksItemDetails && remarksItemDetails?.length > 0) {
        const found = remarksItemDetails?.find((remarkitemdetail) =>
            same(remarkitemdetail?.remarks_group_type, "S")
        );
        if (found) return true;
    }
    return false;
};

/**
 * Process take away charge.
 * @param {any[]} orderItems - The array of order items.
 * @returns {any[]} The array of take away order items.
 */
export const processTakeAwayCharge = (orderItems) => {
    let newOrderItems = [];
    (orderItems || [])?.forEach((item) => {
        if (
            bool(getSysSetting("System Settings", "enable_fixed_ta_charge")) &&
            item?.take_away_item
        ) {
            newOrderItems.push(item);
        }
    });
    return newOrderItems;
};

/**
 * Process total discount promo.
 * @param {any[]} orderItems - The array of order items.
 * @returns {any} The total discount promo.
 */
export const processTotalDiscountPromo = (
    orderItems,
    voucherPromoInfo,
    promotions
) => {
    const { promos } = cache();
    const { order: activeOrder, preorder } = order();
    const orderData = isPreOrderPage() ? preorder : activeOrder;

    let newOrderItems = clone(orderItems);

    // filter out expired promotions
    const totalDiscountPromos = availableNow(
        Array.isArray(promotions) && promotions?.length > 0 ? promotions : promos
    )
        // filter promos depending whether it is voucher type or promotion type
        ?.filter((promo) => {
            if (voucherPromoInfo) {
                return promo?.apply_terminal === 2;
            } else {
                return promo?.apply_terminal === 0;
            }
        })
        // filter total discount promos
        ?.filter((promo) => same(promo?.criteria_type, PROMO_TYPE.TOTAL_DISCOUNT))
        // check current customer; filter out promos where customer group is excluded
        ?.filter((promo) => {
            if (same(promo?.by_target_customer, "R")) {
                if (orderData?.customer_code && orderData?.customer) {
                    return !(promo?.exclude_customer_group || [])?.some((customergroup) =>
                        same(
                            customergroup?.cust_group_name,
                            orderData?.customer?.cust_group_name
                        )
                    );
                } else {
                    return false;
                }
            } else {
                return true;
            }
        });

    let totalDiscountPromo = null;
    for (const promo of totalDiscountPromos || []) {
        const { sets, _insert, _orderItems } = getPromoSets(promo, newOrderItems);

        if (_insert && sets?.length > 0) {
            totalDiscountPromo = promo;
            newOrderItems = clone(_orderItems);

            const setSNoList = sets?.flat()?.map((set) => set?.s_no);

            newOrderItems?.forEach((orderitem) => {
                if (contains(setSNoList, orderitem?.s_no)) {
                    orderitem.is_total_disc_promo_applicable = true;
                }
            });
            break;
        }
    }

    return { totalDiscountPromo, orderItems: newOrderItems };
};
/**
 * Get now with login date.
 * @returns {dayjs.Dayjs} The now with login date.
 */
export const getNowWithLoginDate = () => {
    const { date } = useCache();
    return dayjs(getNowInAPIFormat(date), "YYYY/MM/DD HH:mm:ss");
};

/**
 * Get available service types.
 * @returns {any[]} The array of available service types.
 */
export const getAvailableServiceTypes = () => {
    return (SERVICE_TYPES || [])?.filter((item) => {
        switch (item?.service_type) {
            case "E":
                return bool(
                    getSetting("GENERAL SETTINGS", "ALLOWED SERVICES", "DINE_IN")
                );
            case "T":
                return bool(
                    getSetting("GENERAL SETTINGS", "ALLOWED SERVICES", "TAKE_AWAY")
                );
            case "D":
                return bool(
                    getSetting("GENERAL SETTINGS", "ALLOWED SERVICES", "DELIVERY")
                );
            case "Q":
                return bool(
                    getSetting("GENERAL SETTINGS", "ALLOWED SERVICES", "QUICK_SERVICES")
                );
        }
    });
};

/**
 * Get menu items.
 * @param {string} variant - The variant.
 * @param {any[]} menuItems - The menu items.
 * @param {boolean} all - True if all, false otherwise.
 * @param {any[]} rootCategory - The root category.
 * @param {any[]} selectedCategory - The selected category.
 */
export const getMenuItems = (variant, menuItems, all, rootCategory, selectedCategory) => {
    switch (variant) {
        case "category":
            if (all) {
                return availableNow(
                    (menuItems || [])
                        ?.flatMap((item) => item.category)
                        ?.filter((category) => !!category)
                );
            } else {
                return (
                    availableNow(
                        (menuItems || [])?.find(
                            (item) =>
                                item.root_category_code ===
                                rootCategory[rootCategory.length - 1]
                        )?.category
                    ) || []
                );
            }
        case "item":
            if (selectedCategory) {
                const menuItem = menuItems?.find(
                    (item) =>
                        item.root_category_code ===
                        selectedCategory[selectedCategory?.length - 1]
                );
                const subcategories = [];
                if (!all && Array.isArray(menuItem?.category)) {
                    (availableNow(menuItem.category) || [])?.forEach((item) => {
                        subcategories.push({ ...item, variant: "category" });
                    });
                }
                let result = clone(subcategories);
                if (all) {
                    result = result?.concat(
                        availableNow(
                            (menuItems || [])
                                ?.flatMap((item) => item?.items)
                                ?.filter((item) => !!item)
                        )?.map((item) => ({ ...item, variant: "item" }))
                    );
                } else {
                    result = result?.concat(
                        availableNow(menuItem?.items || [])?.map((item) => ({
                            ...item,
                            variant: "item",
                        }))
                    );
                }
                return result;
            }
            return [];
    }
};


/**
 * Get menu category rows.
 * @returns {number} The menu category rows.
 */
export const getMenuCategoryRows = () => {
    return 2;
};


/**
 * Get menu item rows.
 * @returns {number} The menu item rows.
 */
export const getMenuItemRows = () => {
    return 4;
};


/**
 * Check if not second screen.
 * @returns {boolean} True if not second screen, false otherwise.
 */
export const notSecondScreen = () => {
    return !same(location.pathname, "/second-screen");
};

/**
 * Logout.
 * @returns {void}
 */
export const logout = () => {
    const { setUser, setShift, setDate } = useCache();
    const { setOrder, setOriOrder, setUnableToOrder, setPreorder } = useOrder();
    setUser(null);
    setShift(null);
    setDate(null);
    setOrder(null);
    setOriOrder(null);
    setUnableToOrder(true);
    setPreorder(null);
};

/**
 * Check if item is open item.
 * @param {object} item - The item.
 * @returns {boolean} True if item is open item, false otherwise.
 */
export const isOpenItem = (item) => {
    return item?.item_name?.toUpperCase()?.startsWith(OPEN_ITEM_PREFIX);
};


/**
 * Check if item is addon item.
 * @param {object} orderItem - The order item.
 * @returns {boolean} True if item is addon item, false otherwise.
 */
export const isAddonItem = (orderItem) => {
    return (
        orderItem?.ds_no >= ADDON_STARTING_DS_NO &&
        orderItem?.ds_no < ADDON_2_STARTING_DS_NO
    );
};

/**
 * Calculate set menu item price.
 * @param {any[]} orderItems - The order items.
 * @param {any} orderItem - The order item.
 * @returns {any[]} The new order items.
 */
export const calcSetMemuItemPrice = (orderItems, orderItem) => {
    const items = Array.isArray(useCache()?.items) ? useCache()?.items : [];

    let newOrderItems = clone(orderItems);

    const parentOrderItem = newOrderItems[0];
    if (parentOrderItem) {
        const parentItem = items?.find((item) =>
            same(item?.item_no, parentOrderItem?.item_no)
        );
        if (parentItem) {
            const price = getPriceByServiceType(
                (parentItem?.selling_uom_dtls ? parentItem?.selling_uom_dtls[0] : null)
                    ?.price_dtls[0]
            );
            const grp = (parentItem?.itemmaster_menutype_grpdtls || [])?.find((grp) =>
                same(grp?.modifier_name, orderItem?.category_code)
            );
            const modifierItem = (parentItem?.itemmaster_menutypedtls || [])
                ?.filter((modifieritem) =>
                    same(modifieritem?.modifier_name, grp?.modifier_name)
                )
                ?.find((modifieritem) =>
                    same(modifieritem?.citem_no, orderItem?.item_no)
                );

            const menu_type = Array.isArray(parentItem?.itemmaster_menutype)
                ? parentItem?.itemmaster_menutype[0]?.menu_type
                : "";
            if (same(menu_type, "S")) {
                newOrderItems?.forEach((orderitem) => {
                    if (
                        same(orderitem?.category_code, modifierItem?.modifier_name) &&
                        !isAddonItem(orderitem) &&
                        !isAddon2Item(orderitem) &&
                        notFreeItem(orderitem)
                    ) {
                        const sameGrpQty = newOrderItems
                            ?.filter((orderitem) =>
                                same(orderitem?.category_code, modifierItem?.modifier_name)
                            )
                            ?.map((orderitem) => orderitem?.qty)
                            ?.reduce((acc, val) => acc + val, 0);
                        orderitem.unit_price = (price * grp?.price_per) / 100 / sameGrpQty;

                        orderitem.sub_total = orderitem.unit_price * orderitem.qty;
                    }
                });
            }
        }
    }

    return newOrderItems;
};

/**
 * Minimise SNO.
 * @param {any[]} orderItems - The order items.
 * @returns {any[]} The new order items.
 */
export const minimiseSNo = (orderItems) => {
    const smallestSNo = orderItems
        ?.map((orderitem) => orderitem?.s_no)
        ?.reduce((acc, val) => {
            return Math.min(acc, val);
        }, 1);

    if (smallestSNo > 1) {
        return orderItems?.map((orderitem) => ({
            ...orderitem,
            s_no: orderitem?.s_no - smallestSNo,
        }));
    } else {
        return orderItems;
    }
};


/**
 * Get orders refresh interval.
 * @returns {number} The orders refresh interval.
 */
export const getOrdersRefreshInterval = () => {
    let interval = parseInt(
        getSetting("MORE", "ORDERING", "ORDERS_REFRESH_INTERVAL")
    );
    if (!interval || isNaN(interval)) {
        interval = 30;
    }
    return interval * 1000;
};

/**
 * Preprocess kitchen info.
 * @param {any} kitchenInfo - The kitchen info.
 * @param {any[]} orderItems - The order items.
 * @returns {any} The new kitchen info.
 */
export const preprocessKitchenInfo = (kitchenInfo, orderItems) => {
    const sales_dtls = kitchenInfo?.sales_dtls
        ?.map((info) => {
            const orderItem = orderItems?.find((orderitem) =>
                same(orderitem?.s_no, info?.s_no)
            );

            if (orderItem) {
                return { ...info, qty: orderItem?.qty };
            } else {
                return null;
            }
        })
        ?.filter((info) => !!info);

    return { ...kitchenInfo, sales_dtls };
};

/**
 * Determine if table number should be captured.
 * @returns {boolean} True if table number should be captured, false otherwise.
 */
export const needCaptureTableNo = () => {
    const { order: activeOrder } = useOrder();

    const serviceType = activeOrder?.service_type;

    switch (serviceType) {
        case "Q":
            return (
                bool(
                    getSetting(
                        "GENERAL SETTINGS",
                        "ORDERING",
                        "QUICK_SERVICE_ORDER_ENABLE_TABLE_NUMBER_SELECTION"
                    )
                ) &&
                !bool(
                    getSetting(
                        "GENERAL SETTINGS",
                        "ORDERING",
                        "QUICK_SERVICE_ORDER_ENABLE_CAPTURE_PAGER_TOKEN_NUMBER"
                    )
                )
            );
        case "E":
            return bool(
                getSetting("GENERAL SETTINGS", "ORDERING", "CAPTURE_TABLE_WHEN_DINEIN")
            );
        case "T":
        case "D":
            return false;
    }
};

/**
 * Determine if rounding is needed.
 * @param {any[]} payments - The payments.
 * @returns {boolean} True if rounding is needed, false otherwise.
 */
export const needRounding = (payments) => {
    const { paymentModes } = useCache();
    const paymentDetails = Array.isArray(paymentModes)
        ? paymentModes.flatMap((paymentmode) => paymentmode?.pymt_type_details || [])
        : [];

    return payments?.some((payment) => {
        return bool(
            paymentDetails?.find((paymentdetail) =>
                same(paymentdetail?.payment_name, payment?.payment_name)
            )?.rounding
        );
    });
};

/**
 * Get preorder service type.
 * @param {string} order_type - The order type.
 * @returns {string} The preorder service type.
 */
export const getPreorderServiceType = (order_type) => {
    switch (order_type) {
        case "D":
            return "D";
        case "S":
            return "T";
    }
};

/**
 * Get new pre order.
 * @param {any} data - The data.
 * @returns {any} The new pre order.
 */
export const getNewPreOrder = (data) => {
    const { store, date } = useCache();

    const orderType = data?.order_type || "D";

    return {
        order_no: "",
        order_type: orderType,
        order_date: getNowInAPIFormat(date),
        collection_store_name: store?.store_name,
        coll_del_date: getNowInAPIFormat(date),
        coll_del_time: "",
        customer_code: "",
        contact_person: "",
        contact_no: "",
        contact_email: "",
        payment_name: "",
        payment_status: "N",
        order_status: "N",
        is_gift_personal: "0",
        recipient_name: "",
        alternative_recipient:
            "Email Address / Fax Number(for sending copy of invoice)",
        recipient_contact_no: "",
        del_addr: "",
        postal_code: "",
        del_driver: "",
        sub_total: 0,
        disc_type: "N",
        disc_value: 0,
        disc_name: "None",
        total_disc: "0.00",
        total_svc: "0.00",
        total_tax: "0.00",
        round_adj_amt: "0.00",
        absorb_tax: store?.is_absorbtax ? "Y" : "N",
        net_amt: "0.00",
        total_paid_amt: 0,
        no_of_pax: 1,
        inv_doc_no: "",
        remarks: "",
        ref_1: "",
        ref_2: "",
        ref_3: "",
        ref_4: "",
        ref_5: "",
        sales_dtls: [],
        sales_service_dtls: [],
    };
};












/**
 * Get sales service details.
 * @param {any} order - The order.
 * @returns {any[]} The sales service details.
 */
export const getSalesServiceDtls = (order) => {
    const svcs = Array.isArray(useCache()?.svcs) ? useCache()?.svcs : [];

    const serviceType = order?.service_type;

    const sales_dtls = order?.sales_dtls;
    const sales_service_dtls = [];
    let sales_service_dtl = svcs?.find(
        (item) => item?.service_type === serviceType
    );
    if (sales_service_dtl) {
        sales_service_dtl = clone(sales_service_dtl);
        delete sales_service_dtl?.comp_code;
        sales_service_dtl.sales_amt = order?.sub_total;
        sales_service_dtl.service_amt = (sales_dtls || [])
            ?.filter((item) => item?.take_away_item !== "Y")
            ?.map((item) => parseFloat(item?.svc_amt))
            ?.reduce((acc, val) => acc + val, 0);
        sales_service_dtls?.push(sales_service_dtl);
        const takeAwayOrderItems = (sales_dtls || [])?.filter(
            (item) => item?.take_away_item === "Y"
        );
        if (takeAwayOrderItems?.length > 0) {
            let take_away_sales_service_dtl = svcs?.find(
                (svc) => svc?.service_type === "T"
            );
            if (take_away_sales_service_dtl) {
                take_away_sales_service_dtl = JSON.parse(
                    JSON.stringify(take_away_sales_service_dtl)
                );
                delete take_away_sales_service_dtl.comp_code;
                take_away_sales_service_dtl.sales_amt = order?.sub_total;
                take_away_sales_service_dtl.service_amt = (takeAwayOrderItems || [])
                    ?.map((item) => parseFloat(item?.svc_amt))
                    ?.reduce((acc, val) => acc + val, 0);
                sales_service_dtls?.push(take_away_sales_service_dtl);
            }
        }
        return sales_service_dtls;
    }
    return [];
};

/**
 * Get service type info.
 * @param {string} serviceType - The service type.
 * @returns {string} The service type info.
 */
export const getServiceTypeInfo = (serviceType) => {
    return SERVICE_TYPES?.find(({ service_type }) =>
        same(service_type, serviceType)
    )?.service_type_info;
};

/**
 * Validate item mandatory remarks.
 * @param {string} remarks - The remarks.
 * @param {any[]} remarksItems - The remarks items.
 * @returns {boolean} True if the remarks are valid, false otherwise.
 */
export const validateItemMandatoryRemarks = (remarks, remarksItems) => {
    return contains(
        remarksItems
            ?.filter((remarksitemdetails) =>
                same(remarksitemdetails?.remarks_group_type, "S")
            )
            ?.flatMap((remarksitemdetails) => remarksitemdetails?.remarks_details)
            ?.map((remarks) => remarks?.remarks),
        remarks?.split(",")?.map((remark) => remark?.trim())
    );
};

/**
 * Check if the item is a takeaway item.
 * @param {any} orderItem - The order item.
 * @returns {boolean} True if the item is a takeaway item, false otherwise.
 */
export const isTakeawayItem = (orderItem) => {
    return orderItem?.ds_no >= TAKEAWAY_CHARGE_ITEM_STARTING_DS_NO;
};

/**
 * Check if the item is a addon2 item.
 * @param {any} orderItem - The order item.
 * @returns {boolean} True if the item is a addon2 item, false otherwise.
 */
export const isAddon2Item = (orderItem) => {
    return (
        orderItem?.ds_no >= ADDON_2_STARTING_DS_NO &&
        orderItem?.ds_no < TAKEAWAY_CHARGE_ITEM_STARTING_DS_NO
    );
};

/**
 * Check if the addon item has addon2 item.
 * @param {any} addon - The addon.
 * @param {any} addonItem - The addon item.
 * @returns {boolean} True if the addon item has addon2 item, false otherwise.
 */
export const haveAddon2Item = (addon, addonItem) => {
    return (
        Array.isArray(addon?.child_cat_dtls) &&
        addon?.child_cat_dtls?.filter((childcatdtls) =>
            same(childcatdtls?.parent_item_no, addonItem?.item_no)
        )?.length > 0 &&
        Array.isArray(addon?.child_item_dtls) &&
        addon?.child_item_dtls?.filter((childitemdtls) =>
            same(childitemdtls?.parent_item_no, addonItem?.item_no)
        )?.length > 0
    );
};


/**
* Get menu item by item no.
* @param {string} item_no - The item no.
* @returns {any} The menu item.
*/
export const getMenuItemByItemNo = (item_no) => {
    const { menuItems } = useCache();

    const menuItem = menuItems
        ?.flatMap((menuitem) => menuitem?.items)
        ?.find((item) => !!item && same(item?.item_no, item_no));

    return menuItem;
};

/**
 * Check if the order item is a modifier child item.
 * @param {any} orderItem - The order item.
 * @returns {boolean} True if the order item is a modifier child item, false otherwise.
 */
export const isModifierChildItem = (orderItem) => {
    return orderItem?.ds_no > 1 && orderItem?.ds_no < ADDON_STARTING_DS_NO;
};

/**
 * Check if the order items have stocks.
 * @param {any[]} orderItems - The order items.
 * @returns {boolean} True if the order items have stocks, false otherwise.
 */
export const haveStocks = async (orderItems) => {
    return await checkStocks({ info: { sales_dtls: orderItems } });
};

/**
 * Get voucher info.
 * @param crmVendor - The CRM vendor.
 * @param voucher - The voucher.
 * @returns {any} The voucher info.
 */
export const getVoucherInfo = (crmVendor, voucher) => {
    const { promos } = useCache();

    if (voucher) {
        const voucherInfo = {
            raw: voucher,
            promo_name: "",
            limit: 0,
            type: null,
            promotion: null,
        };

        switch (crmVendor) {
            case CRM_VENDOR.EBER:
                const config = voucher?.pos_redeem_extra?.split(",");
                const discountrule = config?.[0];
                const qty = config?.[1];

                voucherInfo.promo_name = discountrule?.split("=")[1] || "";
                voucherInfo.limit = qty?.split("=")[1] || "";

                break;
        }

        const promotion = promos?.find(
            (promo) =>
                same(promo?.promo_name, voucherInfo?.promo_name) &&
                promo?.apply_terminal === 2
        );
        if (promotion) {
            voucherInfo.promotion = promotion;
            if (same(promotion?.criteria_type, PROMO_TYPE.TOTAL_DISCOUNT)) {
                voucherInfo.type = CRM_VOUCHER_TYPE.BILL;
            } else {
                voucherInfo.type = CRM_VOUCHER_TYPE.ITEM;
            }
        }

        return voucherInfo;
    }
    return null;
};

/**
 * Check if need verify 18.
 * @param {any} order - The order.
 * @returns {boolean} True if need verify 18, false otherwise.
 */
export const needVerify18 = (order) => {
    const { items } = useCache();

    const have18Item = order?.sales_dtls?.some((orderItem) => {
        const item = items?.find((item) => item?.item_no === orderItem?.item_no);
        return bool(item?.is_tobacco_item);
    });
    return (
        bool(getSetting("GENERAL SETTINGS", "ORDERING", "ASK_PASSPORT")) &&
        have18Item
    );
};

/**
 * Check if the discount is applicable.
 * @param discount - The discount.
 * @param orderItem - The order item.
 * @returns {boolean} True if the discount is applicable, false otherwise.
 */
export const checkDiscApplicable = (discount, orderItem) => {
    switch (discount?.apply_to) {
        case "A":
            return true;
        case "I":
            const constant_disctype_itemdtls = discount?.constant_disctype_itemdtls;
            if (Array.isArray(constant_disctype_itemdtls)) {
                return !contains(
                    (constant_disctype_itemdtls || [])?.map((item) => item?.itemdtls),
                    orderItem?.item_name
                );
            } else {
                return true;
            }
        case "C":
            const constant_disctype_catdtls = discount?.constant_disctype_catdtls;
            if (Array.isArray(constant_disctype_catdtls)) {
                return !contains(
                    (constant_disctype_catdtls || [])?.map((item) => item?.categorydtls),
                    orderItem?.category_code
                );
            } else {
                return true;
            }

        default:
            return false;
    }
};

/**
 * Issue CRM points.
 * @param {any} order - The order.
 * @param {any[]} redeemedVouchers - The redeemed vouchers.
 * @param {any} crmPointsRedemptionInfo - The CRM points redemption info.
 * @returns {Promise<any>} The CRM points.
 */
export const issueCRMPoints = async (
    order,
    redeemedVouchers,
    crmPointsRedemptionInfo
) => {
    const { store } = useCache();

    const crmVendor = getSetting(
        "GENERAL SETTINGS",
        "ALLOWED SERVICES",
        "CRM_VENDOR_NAME"
    );

    const customer = order?.customer;
    const vendor_info = customer?.vendor_info;

    let res = null;

    switch (crmVendor) {
        case CRM_VENDOR.EBER:
            const nowInUtc = dayjs().utc().format("YYYY-MM-DD HH:mm:ss"); // Y-m-d H:i:s UTC format
            res = await issueEberPoints({
                info: {
                    eberpayload: {
                        email: vendor_info?.email,
                        phone: vendor_info?.phone,
                        phone_code: vendor_info?.phone_code,
                        user_id: vendor_info?.id,
                        skip_phone_if_invalid: 1,
                        qr_code: vendor_info?.user_qr_codes[0]?.code,
                        external_member_id: vendor_info?.external_member_id,
                        display_name: vendor_info?.display_name,
                        amount: order?.net_amt,
                        note: "",
                        transaction_no: order?.sales_no,
                        notify: true,
                        custom_store_id: store?.store_name,
                        custom_staff_id: "WEBORDER",
                        item_data_json: JSON.stringify(
                            order?.sales_dtls?.map((orderitem) => ({
                                name: orderitem?.item_name,
                                total_amount: orderitem?.sub_total,
                                quantity: orderitem?.qty,
                                unit_amount: orderitem?.unit_price,
                            }))
                        ),
                        utc_transaction_created_at: nowInUtc,
                        utc_created_at: nowInUtc,
                        tax: order?.total_tax,
                        shipping_cost: 0,
                        service_charge: order?.total_svc,
                        discount: order?.total_disc,
                        payment_data_json: JSON.stringify(
                            order?.sales_payment_dtls?.map((payment) => ({
                                name: payment?.payment_name,
                                amount: payment?.tender_amt,
                                description: payment?.ref_info,
                            }))
                        ),
                        issued_reward_ids: redeemedVouchers?.map(
                            (voucher) => voucher?.issued_reward?.id
                        ),
                        card_transaction_ids: [],
                        unique_type: "evolut",
                        create: 1,
                        sub_type: "",
                        transaction_tags: [],
                        refund_amount: 0,
                        point_conversion_points: crmPointsRedemptionInfo?.points || 0,
                        public_params: [],
                    },
                },
            });
            break;
    }
    return res;
};

/**
 * Rollback all redeemed vouchers.
 * @param {any[]} vouchers - The vouchers.
 * @param {string} transaction_no - The transaction no.
 * @returns {Promise<void>} The voided vouchers.
 */
export const rollbackAllRedeemedVouchers = async (
    vouchers,
    transaction_no
) => {
    const { crmInfo } = useCrm();

    const crmVendor = crmInfo?.vendorName;

    switch (crmVendor) {
        case CRM_VENDOR.EBER:
            await Promise.all(
                vouchers
                    ?.filter((voucher) => !!voucher)
                    ?.map(async (voucher) => {
                        await voidEberVoucherTransaction({
                            info: {
                                eberpayload: {
                                    issued_reward_id: voucher?.issued_reward?.id,
                                    transaction_no,
                                },
                            },
                        });
                    })
            );
            break;
    }
};



/**
* Gets device ID from SOK device mapping based on register name.
* @param {string} register_name - The register name to look up.
* @returns {string | null} The device ID if found, null otherwise.
*/
export const getSokDeviceId = (register_name) => {
    if (!register_name) {
        return null;
    }

    const mappingRaw = getSetting("MORE", "SOK", "SOK_DEVICE_MAPPING") || "{}";

    let mapping = {};
    try {
        mapping = JSON.parse(mappingRaw);
    } catch {
        mapping = {};
    }

    return mapping[register_name] || null;
};


/**
 * Check if the order item is a modifier item.
 * @param {any} orderItem - The order item.
 * @returns {boolean} True if the order item is a modifier item, false otherwise.
 */
export const isModifierItem = (orderItem) => {
    return (
        orderItem?.ds_no >= MODIFIER_STARTING_DS_NO &&
        orderItem?.ds_no < MODIFIER_2_STARTING_DS_NO
    );
};

/**
 * Check if the order item is a modifier2 item.
 * @param {any} orderItem - The order item.
 * @returns {boolean} True if the order item is a modifier2 item, false otherwise.
 */
export const isModifier2Item = (orderItem) => {
    return (
        orderItem?.ds_no >= MODIFIER_2_STARTING_DS_NO &&
        orderItem?.ds_no < ADDON_STARTING_DS_NO
    );
};

/**
 * Check if the modifier item has modifier2 item.
 * @param {any} item - The item configuration.
 * @param {any} modifierItem - The selected 1st level modifier item.
 * @returns {boolean} True if the modifier item has modifier2 item, false otherwise.
 */
export const haveModifier2Item = (item, modifierItem) => {
    const additionalGrpdtls =
        typeof item?.itemmaster_menutype_additional_grpdtls === "string" &&
            item?.itemmaster_menutype_additional_grpdtls !== ""
            ? JSON.parse(item.itemmaster_menutype_additional_grpdtls)
            : item?.itemmaster_menutype_additional_grpdtls || [];
    const additionalDtls =
        typeof item?.itemmaster_menutype_additional_dtls === "string" &&
            item?.itemmaster_menutype_additional_dtls !== ""
            ? JSON.parse(item.itemmaster_menutype_additional_dtls)
            : item?.itemmaster_menutype_additional_dtls || [];

    return (
        additionalGrpdtls?.filter(
            (grp) =>
                additionalDtls?.filter(
                    (_item) =>
                        same(_item?.parent_item_no, modifierItem?.citem_no) &&
                        same(_item?.category_code, grp?.category_code)
                )?.length > 0
        )?.length > 0
    );
};

/**
 * Check if the order data has new order items.
 * @param {any} orderData - The order data.
 * @returns {boolean} True if the order data has new order items, false otherwise.
 */
export const hasNewOrderItems = (orderData) => {
    const { orderSeq } = useOrder();
    return (orderData?.sales_dtls || []).some((item) =>
        same(item?.order_seq, orderSeq)
    );
};

/**
 * Check if the checkout remarks modal should be shown.
 * @param {any} orderData - The order data to check.
 * @returns {boolean} True if the checkout remarks modal should be shown, false otherwise.
 */
export const shouldShowConfirmOrderOrCheckoutRemarks = (orderData) => {
    const { allRemarks } = useCache();

    const haveCheckoutRemarks =
        allRemarks?.find((remarkgroup) =>
            same(remarkgroup?.remarks_group_type, "O")
        )?.remarks_type_details?.length > 0;

    return haveCheckoutRemarks && hasNewOrderItems(orderData);
}; 


/**
* Update values for group items.
* @param {any} promo - The promo.
* @param {any[]} set - The set.
* @param {any[]} orderItems - The order items.
* @param {any} orderItem - The order item.
* @param {object} fieldToPopulate - The field to populate.
* @returns {any[]} The updated order items.
*/
export const updateValuesForGroupItems = (
    promo,
    set,
    orderItems,
    orderItem,
    fieldToPopulate = { ref_1: true, disc_name: false }
) => {
    return orderItems?.map((orderitem) => {
        if (contains(set?.map((item) => item?.s_no), orderitem?.s_no)) {
            const fieldsToPopulate = {};

            if (fieldToPopulate?.ref_1) {
                fieldsToPopulate.ref_1 = orderItem?.s_no;
            }
            if (fieldToPopulate?.disc_name) {
                fieldsToPopulate.disc_name = promo?.promo_name;
            }

            return {
                ...orderitem,
                ...fieldsToPopulate,
            };
        } else {
            return orderitem;
        }
    });
};

export const haveBCRS = (orderData) => {
    let result = false;

    const serviceType = orderData?.service_type;

    switch (serviceType) {
        case "E":
            result = bool(getSysSetting("POS System Settings", "poss_BCRS_enable_dine_flag"));
            break;
        case "T":
            result = bool(getSysSetting("POS System Settings", "poss_BCRS_enable_takeaway_flag"));
            break;
        case "D":
            result = bool(getSysSetting("POS System Settings", "poss_BCRS_enable_delivery_flag"));
            break;
        case "Q":
            result = bool(getSysSetting("POS System Settings", "poss_BCRS_enable_quick_flag"));
            break;
    }

    const { items } = cache();
    const bcrsItemSkuNo = getSysSetting("POS System Settings", "poss_BCRS_sku_no");
    const bcrsItem = items?.find((item) => same(item?.sku_no, bcrsItemSkuNo));

    if (!bcrsItem) {
        result = false;
    }

    return result;
};

export const processBCRS = (orderData) => {
    let proceed = haveBCRS(orderData);

    if (proceed) {
        const { orderSeq } = order();

        const serviceType = orderData?.service_type;

        const { items, date } = cache();
        const bcrsItemSkuNo = getSysSetting("POS System Settings", "poss_BCRS_sku_no");
        const bcrsItem = items?.find((item) => same(item?.sku_no, bcrsItemSkuNo));

        const bcrsItems = [];
        let sales_dtls = clone(orderData?.sales_dtls || []);

        for (const orderitem of sales_dtls) {
            const item = items?.find((item) => same(item?.item_no, orderitem?.item_no));

            const bcrsCharges =
                item?.reorder_qty_level &&
                    !isNaN(parseFloat(item?.reorder_qty_level)) &&
                    parseFloat(item?.reorder_qty_level) > 0
                    ? parseFloat(item?.reorder_qty_level)
                    : 0;

            if (bcrsCharges > 0) {
                const selling_uom_dtls = item?.selling_uom_dtls?.[0];

                bcrsItems.push({
                    s_no: getLastSNo([...sales_dtls, ...bcrsItems]) + 1,
                    parent_sno: orderitem?.s_no,
                    ds_no: BCRS_STARTING_DS_NO,
                    seat_no: 1,
                    sku_no: bcrsItem?.sku_no,
                    category_code: bcrsItem?.category_code,
                    item_no: bcrsItem?.item_no,
                    item_name: bcrsItem?.item_name,
                    item_desc: bcrsItem?.item_desc,
                    remarks: "",
                    qty: orderitem?.qty,
                    uom: selling_uom_dtls?.uom,
                    uom_cf: selling_uom_dtls?.uom_cf,
                    unit_price: bcrsCharges,
                    price: bcrsCharges,
                    disc_type: "N",
                    disc_name: "None",
                    disc_value: 0,
                    disc_amt: 0,
                    sub_total: bcrsCharges * orderitem?.qty,
                    pro_disc_amt: 0,
                    svc_amt: 0,
                    is_apply_svc: bcrsItem?.is_apply_svc,
                    tax_amt: "0.000000",
                    tax_rate: bcrsItem?.tax_value,
                    tax_value: bcrsItem?.tax_value,
                    is_absorbtax: isAbsorbTax(bcrsItem),
                    take_away_item: contains(["T", "D"], serviceType) ? "Y" : "N",
                    order_seq: orderSeq,
                    order_seq_type: "New",
                    order_datetime: getNowInAPIFormat(date),
                    print_flag: "N",
                    item_kds_ready_status: "N",
                    item_kds_ready_datetime: getNowInAPIFormat(date),
                    item_kds_serve_status: "N",
                    item_kds_serve_datetime: getNowInAPIFormat(date),
                    override_f: 0,
                    is_addon_enable: bcrsItem?.is_addon_enable,
                    add_on_name: bcrsItem?.add_on_name,
                    ref_1: "",
                    ref_2: "",
                    ref_4: "",
                    ref_5: "",
                });
            }
        }

        sales_dtls = sortOrderItems([...sales_dtls, ...bcrsItems]);

        return calcOrderAmt({
            ...orderData,
            sales_dtls,
        });
    }

    return orderData;
};

export const dontIssueCRMPoint = (payments) => {
    const { paymentModes } = cache();

    return !!payments?.some((payment) =>
        bool(
            paymentModes
                ?.flatMap((paymentmode) => paymentmode?.pymt_type_details)
                ?.find((pymttypedetails) => same(pymttypedetails?.payment_name, payment?.payment_name))
                ?.ref_4
        )
    );
};

export const getAppliedVoucherKey = (voucher) => {
    return (
        voucher?.voucher?.voucher_no ||
        voucher?.voucher_no ||
        voucher?.raw?.VoucherNo ||
        voucher?.raw?.voucher_no ||
        voucher?.raw?.redeem_code ||
        ""
    );
};