import { useCache as cache } from '../stores/cache-store.js';
import { bool, contains, same } from "../utils/common.js";
import { getSetting, isModifier2Item, isModifierItem } from "../utils/pos.js";


export const getRefItemPrefix = (text) => {
    return text?.substring(0, text?.indexOf("-"))?.trim();
};

export const getSelectionGroupItemPrefix = (selectionGroupItem) => {
    return selectionGroupItem?.substring(
        selectionGroupItem?.indexOf("(") + 1,
        selectionGroupItem?.indexOf(")")
    );
};

/**
 * Filter the selection group items based on the ref prefix
 * @param refItem - the item that is being referenced
 * @param selectionGroupItems - the group items that are being selected
 * @returns the items that are being selected that are referenced by the refItem
 *
 * Example:
 * refItem = { ref_1: "L-Milk Tea" }
 * selectionItems = [
 *   { ref_1: "(H) Small Rice Ball" },
 *   { ref_1: "(L) Pearl" },
 *   { ref_1: "(M) Grass Jelly" },
 * ]
 * returns [ { ref_1: "(L) Pearl" } ]
 */
export const filterSelectionGroupItemsBasedOnRefPrefix = (refItem, selectionGroupItems) => {
    if (!refItem || !Array.isArray(selectionGroupItems)) return selectionGroupItems;

    const refItemPrefix = getRefItemPrefix(refItem?.item_name || "");

    return selectionGroupItems?.filter((selectiongroupitem) => {
        if (!selectiongroupitem?.citem_name?.startsWith("(")) {
            return true;
        }

        const selectionGroupItemPrefix = getSelectionGroupItemPrefix(
            selectiongroupitem?.citem_name || ""
        );

        return same(selectionGroupItemPrefix, refItemPrefix);
    });
};

/**
 * Filter the selection groups based on the ref prefix
 * @param refItem - the item that is being referenced
 * @param selectionGroups - the groups that are being selected
 * @returns the groups that are being selected that are referenced by the refItem
 *
 * Example:
 * refItem = { ref_1: "H-Milk Tea" }
 * selectionGroups = [
 *   { modifier_name: "ICE" },
 *   { modifier_name: "HOT" },
 * ]
 * returns [ { modifier_name: "HOT" } ]
 */
export const filterSelectionGroupsBasedOnRefPrefix = (refItem, selectionGroups) => {
    if (!refItem || !Array.isArray(selectionGroups)) return selectionGroups;

    const refItemPrefix = getRefItemPrefix(refItem?.item_name || "");
    // Filter out ICE selection group if the ref item is a hot item
    if (same(refItemPrefix, "H")) {
        return selectionGroups?.filter((selectiongroup) => {
            if (same(selectiongroup?.modifier_name, "ICE")) {
                return false;
            }
            return true;
        });
    }

    return selectionGroups;
};

export const clearSelectionItems = (refItem, selectionItems, newModifierItem) => {
    if (!refItem) return selectionItems;

    if (contains(newModifierItem?.item_name, selectionItems[0]?.item_name, false)) {
        return selectionItems?.filter((selectionitem) => {
            return isModifier2Item(newModifierItem)
                ? isModifierItem(selectionitem)
                : selectionitem?.ds_no === 1;
        });
    }

    return selectionItems;
};

export const getRefItem = (selectionItems, item) => {
    if (item?.ds_no !== undefined && item?.ds_no !== 1) return null;

    const isFilterSelectionBasedOnRefPrefixEnabled = bool(
        getSetting("MORE", "ORDERING", "FILTER_MODIFIER_GROUPS_BASED_ON_REF_PREFIX")
    );

    if (isFilterSelectionBasedOnRefPrefixEnabled) {
        const { items } = useCache();

        const parentItem = items?.find((i) => same(i?.item_no, item?.item_no));
        const firstGroup = (parentItem?.itemmaster_menutype_grpdtls || [])?.sort(
            (a, b) => a?.item_menutype_grpdtls - b?.item_menutype_grpdtls
        )[0];

        return selectionItems?.find(
            (selectionitem) =>
                selectionitem?.ds_no > 1 &&
                same(selectionitem?.modifier_name, firstGroup?.modifier_name)
        );
    }

    return null;
};