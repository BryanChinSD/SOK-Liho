import {
    API_URL,
    DATE_FORMAT,
    DATE_TIME_FORMAT,
    KITCHEN_PRINT_TYPE,
    STATUS,
    NOTO_FONT,
    PRINT_SERVICE,
    PROMO_TYPE,
    STOCK_TYPE,
    TIME_FORMAT,
    RECEIPT_PRINT_TYPE,
    KITCHEN_STATUS,
    TQR_PRINT_TYPE,
    DISPLAY_DATE_FORMAT,
    KITCHEN_PRINTING,
} from "../utils/constants.js";
import {
    bool,
    clone,
    contains,
    getNowInAPIFormat,
    isImageExisted,
    jspdfGetNextLineY,
    newPDF,
    same,
    timestamp
} from "../utils/common.js";
import dayjs from "https://esm.sh/dayjs";
import {
    getNowWithLoginDate,
    getSetting,
    getSysSetting,
    isAddon2Item,
    isAddonItem,
    isOpenItem,
    isWeightableItem,
    notFreeItem,
    sortOrderItems,
} from "../utils/pos.js";
import html2canvas from "https://esm.sh/html2canvas";
import QRCode from "https://esm.sh/qrcode";
import { jsPDF } from "https://esm.sh/jspdf@2.5.1";
import { useCache } from '../stores/cache-store.js';
import { getRefItem, getRefItemPrefix } from "../hardcoded/liho.js";


// ── print utility ─────────────────────────────────────────────────────────────
//const FLASK_DOMAIN = 'http://192.168.0.59:5055';
const FLASK_DOMAIN = 'http://10.230.16.5:5017';
const PRINT_TIMEOUT = 30_000;
function stripControlChars(obj, options) {
    if (!obj || typeof obj !== 'object') return obj;
    var replacement = (options && options.replacement) !== undefined ? options.replacement : '';
    var result = {};
    for (var key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            result[key] = typeof obj[key] === 'string'
                ? obj[key].replace(/[\x00-\x1F\x7F]/g, replacement).trim()
                : obj[key];
        }
    }
    return result;
}
// ── Base64 encoder (chunked — avoids call stack overflow on large PDFs) ───────
const blobToBase64 = async (blob) => {
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
};

// ── Print ─────────────────────────────────────────────────────────────────────
const print = async (pdfBlob, printerName, fileName, rotate = false, useLocal = false) => {
    const resolvedFileName = fileName || 'receipt.pdf';

    console.group(`📤 [print] ${useLocal ? 'Local' : 'Remote'} Send`);
    console.log({ printerName, resolvedFileName, useLocal });
    console.groupEnd();

    if (!printerName?.trim()) {
        console.warn('⚠️ [print] BAIL: No printerName');
        return false;
    }

    // Encode BEFORE starting the timeout clock so encoding time
    // doesn't eat into the server response window.
    let base64data = null;
    if (!useLocal) {
        base64data = await blobToBase64(pdfBlob);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PRINT_TIMEOUT);

    try {
        let response;

        if (useLocal) {
            // ── Local ASP.NET (Multipart) ─────────────────────────────────────
            const formData = new FormData();
            formData.append('printerName', printerName);
            formData.append('fileName', resolvedFileName);
            formData.append('rotate', rotate);
            formData.append('file', pdfBlob, resolvedFileName);

            response = await fetch('/API/Printer/Print', {
                method: 'POST',
                body: formData,
                signal: controller.signal,
            });

        } else {
            // ── Remote Flask ──────────────────────────────────────────────────
            response = await fetch(`${FLASK_DOMAIN}/printer/liho`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    file: base64data,
                    printerName,
                    fileName: resolvedFileName,
                    rotate,
                }),
            });
        }

        // ── Shared response handling ──────────────────────────────────────────
        clearTimeout(timeoutId);

        if (response.ok) {
            console.log(`✅ [print] Success: ${printerName}`);
            return true;
        }

        const errorText = await response.text();
        console.error(`❌ [print] Server error (${response.status}):`, errorText);
        return false;

    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            console.error('❌ [print] Timeout: printer server unresponsive.');
        } else {
            console.error('❌ [print] Critical error:', err);
        }
        return false;
    }
};

/**
 * Sends order items to the local Kitchen Server.
 * @param {Array} items - The parsed sales_dtls array.
 * @param {string} salesNo - The SAL number for reference.
 */
/**
 * Sends a PDF Blob to the local Flask Print Server (Port 503).
 */
export async function handleKitchenPrinting(kprintItems, salesNo) {
    try {
        console.log("📤 [print] Kitchen generating PDF for:", salesNo);

        // 1. Create the PDF Blob
        // Use your existing PDF utility (newPDF / jsPDF)
        const doc = new jsPDF();

        // Add your kitchen template logic here (Header, Items, etc.)
        doc.text(`KITCHEN ORDER: ${salesNo}`, 10, 10);
        kprintItems.forEach((item, index) => {
            doc.text(`${item.qty}x ${item.name}`, 10, 20 + (index * 10));
        });

        // 2. Output as Blob
        const blob = doc.output('blob');

        // 3. Now perform the Base64 conversion
        const base64data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            // ✅ parameter 1 is now officially a Blob
            reader.readAsDataURL(blob);
        });

        // 4. Send to your printing API/Service
        const printerName = localStorage.getItem("kitchen_printer_name") || "Kitchen";
        await sendToPrinter(printerName, base64data, salesNo);

    } catch (error) {
        console.error("❌ Kitchen Printjob failed error:", error);
    }
}
// ── printReceiptAsPng ─────────────────────────────────────────────────────────
// Converts jsPDF doc → PNG via canvas, then sends PNG to the print service.
// Thermal printers have no PDF renderer — they need raster image input.
const printReceiptAsPng = async (doc, printerName, pdfName) => {
    try {
        // 1. Get PDF as a data URL and load into pdf.js
        const pdfDataUri = doc.output('datauristring');

        const pdfjsLib = window['pdfjsLib']
            ?? window['pdfjs-dist/build/pdf']
            ?? window['PDFJS'];

        if (!pdfjsLib) {
            console.error('❌ [printReceiptAsPng] pdf.js not found on window — falling back to raw PDF');
            const fallbackBlob = doc.output('blob');
            await print(fallbackBlob, printerName, pdfName, null);
            return;
        }

        const loadingTask = pdfjsLib.getDocument({ url: pdfDataUri });
        const pdfDoc = await loadingTask.promise;

        console.log(`🖼️ [printReceiptAsPng] Rendering ${pdfDoc.numPages} page(s) for printer: ${printerName}`);

        // 2. Render each page to canvas → PNG blob → send to printer
        for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
            const page = await pdfDoc.getPage(pageNum);

            // Scale 3x for crisp 203dpi thermal output
            const scale = 3;
            const viewport = page.getViewport({ scale });

            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            const ctx = canvas.getContext('2d');
            // White background (thermal default is transparent → prints black)
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            await page.render({ canvasContext: ctx, viewport }).promise;

            // 3. Export canvas as PNG blob
            const pngBlob = await new Promise((resolve, reject) => {
                canvas.toBlob(blob => {
                    if (blob) resolve(blob);
                    else reject(new Error('canvas.toBlob returned null'));
                }, 'image/png');
            });

            const pngName = pdfName.replace('.pdf', `_p${pageNum}.png`);
            console.log(`🖨️ [printReceiptAsPng] Sending page ${pageNum}: ${pngName} | size: ${pngBlob.size}`);

            const success = await print(pngBlob, printerName, pngName, null, true); // ← useLocal = true
            if (!success) {
                console.error(`❌ [printReceiptAsPng] Failed on page ${pageNum}`);
            }
        }

        console.log(`✅ [printReceiptAsPng] Done: ${pdfName}`);

    } catch (err) {
        console.error('❌ [printReceiptAsPng] Error:', err);
        // Fallback: send raw PDF (better than silent failure)
        const fallbackBlob = doc.output('blob');
        await print(fallbackBlob, printerName, pdfName, null, true); // ← useLocal = true
    }
};

// ── KITCHEN PRINT — non-async outer function ──────────────────────────────────
// The outer kitchenPrint() is now synchronous — it returns immediately.
// All PDF building + sending happens inside a detached async IIFE (fire-and-forget).
// This means the caller (completeOrderAfterPayment) is never blocked waiting for kitchen.
export function kitchenPrint(type, data, isGroup, printerNameOverride, tableFrom, allItems = null) {
    (async () => {
        try {
            const { printerSettings, printConfig, register } = useCache();
            let printData = Array.isArray(data) ? data[0] : data;

            tableFrom = tableFrom ?? printData?.table_from ?? "";

            if (!printConfig?.Kitchen) {
                console.warn('🖨️ [kitchen] BAIL: no printConfig.Kitchen');
                return;
            }

            let sales_dtls = printData?.sales_dtls;
            if (typeof sales_dtls === "string") sales_dtls = JSON.parse(sales_dtls);

            if (!Array.isArray(sales_dtls) || sales_dtls.length === 0) {
                console.warn("🖨️ [kitchen] No items to print.");
                return;
            }

            sales_dtls = sales_dtls.map(item => ({ ...item }));
            sales_dtls.forEach((s) => { s.ref_print = 0; });
            sales_dtls.forEach((v) => { v.print_flag = "Y"; });

            sales_dtls.sort((a, b) => {
                if (a.parent_sno !== b.parent_sno) return a.parent_sno - b.parent_sno;
                const aIsChild = a.s_no !== a.parent_sno ? 1 : 0;
                const bIsChild = b.s_no !== b.parent_sno ? 1 : 0;
                return aIsChild - bIsChild;
            });

            sales_dtls.forEach((orderitem) => {
                const categoryPrintBy = orderitem?.e?.[0]?.category_kitchen_print_by;
                if (categoryPrintBy === 1 && orderitem.take_away_item !== "N") {
                    orderitem.printer_name = "";
                } else if (categoryPrintBy === 2 && orderitem.take_away_item !== "Y") {
                    orderitem.printer_name = "";
                }
            });

            let tempData = clone(printData);
            fetch('/API/printer/posorderkitchen/update', {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(tempData),
            })
                .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
                .catch(err => console.error('❌ Kitchen PRE-UPDATE failed:', err));

            let printers = Array.from(new Set(
                sales_dtls.map(item => item.printer_name).filter(p => !!p)
            ));

            console.log(`🖨️ [kitchen] Printers to process: [${printers.join(', ')}]`);

            const printQueue = [];

            for (const printer_name of printers) {
                const kPrinterName = printerSettings?.find((v) => v.setting_code === printer_name);

                const resolvedPrinterValue =
                    kPrinterName?.setting_value?.trim() ||
                    kPrinterName?.setting_code;

                if (!resolvedPrinterValue) {
                    console.warn(`🖨️ [kitchen] SKIP: no printer value for: ${printer_name}`);
                    continue;
                }

                if (same(kPrinterName.setting_desc, "LABELPRINT")) {
                    console.warn(`🖨️ [kitchen] SKIP: LABELPRINT not handled: ${printer_name}`);
                    continue;
                }

                const orderItems = sales_dtls?.filter(
                    (orderitem) =>
                        same(orderitem?.printer_name, printer_name) &&
                        !bool(orderitem?.ref_print) &&
                        bool(orderitem?.print_flag)
                );

                if (!orderItems?.length) {
                    console.warn(`🖨️ [kitchen] SKIP: no matching orderItems for printer: ${printer_name}`);
                    continue;
                }

                console.log(`🖨️ [kitchen] Processing printer: [${printer_name}] → resolved: [${resolvedPrinterValue}] | items: ${orderItems.length}`);

                try {
                    var sales_no = printData?.sales_no;
                    var status = printData?.order_status_desc;
                    var no_of_pax = printData?.no_of_pax;
                    var register_name = register?.register_name;
                    var doc_date = dayjs(printData?.doc_date).format(DATE_TIME_FORMAT);
                    var m_userid = printData?.m_userid;
                    var table_no = printData?.table_no;

                    // ── SUMMARY / BOTH / SUMMARYFLANG / BOTHFLANG / DOTMATRIX_SUMMARY ──
                    if (
                        contains(
                            ["SUMMARY", "BOTH", "SUMMARYFLANG", "BOTHFLANG", "DOTMATRIX_SUMMARY", "DOTMATRIX_BOTHFLANG"],
                            kPrinterName.setting_desc
                        )
                    ) {
                        let doc = await newPDF({ compress: false });
                        if (!doc) {
                            console.error(`❌ [kitchen] newPDF returned null for printer: ${printer_name}`);
                            continue;
                        }

                        var x = printConfig?.Kitchen?.x;
                        var y = printConfig?.Kitchen?.y;
                        var maxWidth = printConfig?.Kitchen?.maxWidth;
                        var pageHeight = doc.internal.pageSize.height - 10;

                        if (contains(["DOTMATRIX"], kPrinterName.setting_desc, false)) {
                            x = 7;
                        }

                        const maxOrderSeq = Math.max.apply(Math, orderItems?.map((item) => item.order_seq));

                        //// ── TopmostTableNo: 2 empty lines before queue number ──
                        //if (table_no && printConfig?.Kitchen?.TopmostTableNo.visible) {
                        //    y = y + printConfig?.Kitchen?.EmptyLine;
                        //    y = y + printConfig?.Kitchen?.EmptyLine;
                        //    doc.setFont(printConfig?.Kitchen?.TopmostTableNo.fontFamily);
                        //    doc.setFontSize(printConfig?.Kitchen?.TopmostTableNo.fontSize);
                        //    doc.setTextColor(printConfig?.Kitchen?.TopmostTableNo.fontColor);
                        //    doc.text(printConfig?.Kitchen?.TopmostTableNo.label + table_no, x, y);
                        //    y = jspdfGetNextLineY(doc, y);
                        //}

                        if (
                            printConfig?.Kitchen?.AdditionalItems &&
                            maxOrderSeq > 1 &&
                            !same(type, KITCHEN_PRINT_TYPE.MANUAL) &&
                            !same(type, KITCHEN_PRINT_TYPE.CANCEL_ITEM)
                        ) {
                            doc.setFont(printConfig?.Kitchen?.AdditionalItems.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.AdditionalItems.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.AdditionalItems.fontColor);
                            doc.text(printConfig?.Kitchen?.AdditionalItems.label, x, y);
                            y = jspdfGetNextLineY(doc, y);
                        }

                        doc.setFont(printConfig?.Kitchen?.StarDivider.fontFamily);
                        doc.setFontSize(printConfig?.Kitchen?.StarDivider.fontSize);
                        doc.setTextColor(printConfig?.Kitchen?.StarDivider.fontColor);
                        doc.text(printConfig?.Kitchen?.StarDivider.label, x, y);

                        if (!table_no && contains(["SAL-TQR", "SAL-WOR"], sales_no, false)) {
                            doc.text("SELF COLLECT ORDER", x, y);
                            y = jspdfGetNextLineY(doc, y);
                            doc.setFont(printConfig?.Kitchen?.StarDivider.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.StarDivider.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.StarDivider.fontColor);
                            doc.text(printConfig?.Kitchen?.StarDivider.label, x, y);
                            y = jspdfGetNextLineY(doc, y);
                        }

                        if (tableFrom && printConfig?.Kitchen?.TransferTable.visible) {
                            y = y + printConfig?.Kitchen?.EmptyLine;
                            doc.setFont(printConfig?.Kitchen?.TransferTable.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.TransferTable.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.TransferTable.fontColor);
                            doc.text(`${printConfig?.Kitchen?.TransferTable.label} ${tableFrom} to ${table_no}`, x, y);
                            y = jspdfGetNextLineY(doc, y);
                            y = y + printConfig?.Kitchen?.EmptyLine;
                            doc.setFont(printConfig?.Kitchen?.StarDivider.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.StarDivider.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.StarDivider.fontColor);
                            doc.text(printConfig?.Kitchen?.StarDivider.label, x, y);
                            y = jspdfGetNextLineY(doc, y);
                        }

                        if (same(type, KITCHEN_PRINT_TYPE.CANCEL_ITEM) && printConfig?.Kitchen?.Cancel.visible) {
                            y = y + printConfig?.Kitchen?.EmptyLine;
                            doc.setFont(printConfig?.Kitchen?.Cancel.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.Cancel.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.Cancel.fontColor);
                            doc.text(printConfig?.Kitchen?.Cancel.label, x, y);
                            y = jspdfGetNextLineY(doc, y);
                            y = y + printConfig?.Kitchen?.EmptyLine;
                            doc.setFont(printConfig?.Kitchen?.StarDivider.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.StarDivider.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.StarDivider.fontColor);
                            doc.text(printConfig?.Kitchen?.StarDivider.label, x, y);
                            y = jspdfGetNextLineY(doc, y);
                        }

                        if (status === "Void" && printConfig?.Kitchen?.Void.visible) {
                            y = y + printConfig?.Kitchen?.EmptyLine;
                            doc.setFont(printConfig?.Kitchen?.Void.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.Void.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.Void.fontColor);
                            doc.text(printConfig?.Kitchen?.Void.label, x, y);
                            y = jspdfGetNextLineY(doc, y);
                            y = y + printConfig?.Kitchen?.EmptyLine;
                            doc.setFont(printConfig?.Kitchen?.StarDivider.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.StarDivider.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.StarDivider.fontColor);
                            doc.text(printConfig?.Kitchen?.StarDivider.label, x, y);
                            y = jspdfGetNextLineY(doc, y);
                        }

                        if (printConfig?.Kitchen?.Header.visible) {
                            doc.setFont(printConfig?.Kitchen?.Header.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.Header.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.Header.fontColor);
                            doc.text(printConfig?.Kitchen?.Header.label, x, y);
                            y = jspdfGetNextLineY(doc, y);
                        }

                        if (printConfig?.Kitchen?.PrinterName.visible) {
                            doc.setFont(printConfig?.Kitchen?.PrinterName.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.PrinterName.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.PrinterName.fontColor);
                            doc.text(kPrinterName?.setting_code, x, y);
                            y = jspdfGetNextLineY(doc, y);
                        }

                        y = y + printConfig?.Kitchen?.EmptyLine;

                        if (table_no && printConfig?.Kitchen?.TableNo.visible) {
                            doc.setFont(printConfig?.Kitchen?.TableNo.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.TableNo.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.TableNo.fontColor);
                            doc.text(`${printConfig?.Kitchen?.TableNo.label} ${table_no}`, x, y, { align: "left" });
                            y = jspdfGetNextLineY(doc, y);
                        }

                        if (printConfig?.Kitchen?.QueueNo.visible) {
                            doc.setFont(printConfig?.Kitchen?.QueueNo.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.QueueNo.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.QueueNo.fontColor);
                            doc.text(`${printConfig?.Kitchen?.QueueNo.label} ${sales_no.substring(17, 19).trim()}`, x, y);
                            y = jspdfGetNextLineY(doc, y);
                        }

                        if (printConfig?.Kitchen?.Register.visible) {
                            doc.setFont(printConfig?.Kitchen?.Register.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.Register.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.Register.fontColor);
                            doc.text(printConfig?.Kitchen?.Register.label + register_name, x, y);
                            y = jspdfGetNextLineY(doc, y);
                        }

                        if (printConfig?.Kitchen?.ShortSalesNo.visible) {
                            doc.setFont(printConfig?.Kitchen?.ShortSalesNo.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.ShortSalesNo.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.ShortSalesNo.fontColor);
                            doc.text(`${printConfig?.Kitchen?.ShortSalesNo.label} ${sales_no.substring(4, 7).trim()}-${sales_no.substring(15, 19).trim()}`, x, y);
                            y = jspdfGetNextLineY(doc, y);
                        }

                        if (printConfig?.Kitchen?.SalesNo.visible) {
                            doc.setFont(printConfig?.Kitchen?.SalesNo.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.SalesNo.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.SalesNo.fontColor);
                            doc.text(`${printConfig?.Kitchen?.SalesNo.label} ${sales_no}`, x, y);
                            y = jspdfGetNextLineY(doc, y);
                        }

                        if (printConfig?.Kitchen?.DateTime.visible) {
                            doc.setFont(printConfig?.Kitchen?.DateTime.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.DateTime.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.DateTime.fontColor);
                            doc.text(`${printConfig?.Kitchen?.DateTime.label} ${doc_date}`, x, y);
                            y = jspdfGetNextLineY(doc, y);
                        }

                        if (printConfig?.Kitchen?.User.visible) {
                            doc.setFont(printConfig?.Kitchen?.User.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.User.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.User.fontColor);
                            doc.text(`${printConfig?.Kitchen?.User.label} ${m_userid}`, x, y);
                            y = jspdfGetNextLineY(doc, y);
                        }

                        if (printConfig?.Kitchen?.Status.visible) {
                            doc.setFont(printConfig?.Kitchen?.Status.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.Status.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.Status.fontColor);
                            doc.text(`${printConfig?.Kitchen?.Status.label} ${status}`, x, y);
                        }

                        if (printConfig?.Kitchen?.NoOfPax.visible) {
                            doc.setFont(printConfig?.Kitchen?.NoOfPax.fontFamily);
                            doc.setFontSize(printConfig?.Kitchen?.NoOfPax.fontSize);
                            doc.setTextColor(printConfig?.Kitchen?.NoOfPax.fontColor);
                            doc.text(`${printConfig?.Kitchen?.NoOfPax.label} ${no_of_pax}`, maxWidth, y, { align: "right" });
                        }
                        y = jspdfGetNextLineY(doc, y);

                        doc.setFont(printConfig?.Kitchen?.DashDivider.fontFamily);
                        doc.setFontSize(printConfig?.Kitchen?.DashDivider.fontSize);
                        doc.setTextColor(printConfig?.Kitchen?.DashDivider.fontColor);
                        doc.text(printConfig?.Kitchen?.DashDivider.label, x, y);
                        y = jspdfGetNextLineY(doc, y);

                        var Qty_X = printConfig?.Kitchen?.QtyValue.x;
                        var Items_X = printConfig?.Kitchen?.ItemsValue.x;

                        var lstTakeEat = Array.from(new Set(orderItems?.map((o) => o.take_away_item)));

                        lstTakeEat?.forEach((te) => {
                            var lstTakeAway = orderItems?.filter((v) => v.take_away_item === te);

                            if (te === "N" && printConfig?.Kitchen?.DineIn.visible && !contains(["T", "D"], printData?.service_type)) {
                                doc.setFont(printConfig?.Kitchen?.DineIn.fontFamily);
                                doc.setFontSize(printConfig?.Kitchen?.DineIn.fontSize);
                                doc.setTextColor(printConfig?.Kitchen?.DineIn.fontColor);
                                doc.text(printConfig?.Kitchen?.DineIn.label, x, y);
                                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Kitchen?.y; }
                                y = jspdfGetNextLineY(doc, y);
                                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Kitchen?.y; }
                            } else if (printConfig?.Kitchen?.TakeAway.visible) {
                                doc.setFont(printConfig?.Kitchen?.TakeAway.fontFamily);
                                doc.setFontSize(printConfig?.Kitchen?.TakeAway.fontSize);
                                doc.setTextColor(printConfig?.Kitchen?.TakeAway.fontColor);
                                doc.text(printConfig?.Kitchen?.TakeAway.label, x, y);
                                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Kitchen?.y; }
                                y = jspdfGetNextLineY(doc, y);
                                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Kitchen?.y; }
                            }

                            lstTakeAway?.forEach((v, index) => {
                                doc.setFont(printConfig?.Kitchen?.QtyValue.fontFamily);
                                doc.setFontSize(printConfig?.Kitchen?.QtyValue.fontSize);
                                doc.setTextColor(printConfig?.Kitchen?.QtyValue.fontColor);
                                if (v.s_no == v.parent_sno) {
                                    if (isWeightableItem(v)) {
                                        doc.text(`   ${parseFloat(v.qty).toString()} ${v.uom.toString()}`, Qty_X, y);
                                    } else {
                                        doc.text(`   ${v.qty.toString()}`, Qty_X, y);
                                    }
                                }

                                doc.setFont(printConfig?.Kitchen?.ItemsValue.fontFamily);
                                doc.setFontSize(printConfig?.Kitchen?.ItemsValue.fontSize);
                                doc.setTextColor(printConfig?.Kitchen?.ItemsValue.fontColor);
                                var ls_itemdesc = "";
                                if (contains(["SUMMARYFLANG", "BOTHFLANG", "DOTMATRIX_SUMMARY", "DOTMATRIX_BOTHFLANG"], kPrinterName.setting_desc)) {
                                    ls_itemdesc = v.s_no == v.parent_sno ? v.flang_desc.toString() : `(${v.qty.toString()}) ${v.flang_desc.toString()}`;
                                } else {
                                    if (v.s_no == v.parent_sno) {
                                        ls_itemdesc = v.item_desc.toString();
                                    } else {
                                        ls_itemdesc = isWeightableItem(v)
                                            ? `(${parseFloat(v.qty).toString()}) ${v.uom.toString()} ${v.item_desc.toString()}`
                                            : `(${parseFloat(v.qty).toString()}) ${v.item_desc.toString()}`;
                                    }
                                }
                                var splitText = doc.splitTextToSize(ls_itemdesc, maxWidth - Items_X - 1);
                                for (var i = 0, length = splitText.length; i < length; i++) {
                                    doc.text(splitText[i], isWeightableItem(v) && v.s_no == v.parent_sno ? Items_X + 17 : Items_X, y);
                                    if (i < splitText.length - 1) {
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Kitchen?.y; }
                                        y = jspdfGetNextLineY(doc, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Kitchen?.y; }
                                    }
                                }

                                if (v.remarks && printConfig?.Kitchen.Remarks.visible) {
                                    // ✅ Explicitly set Remarks font before printing
                                    doc.setFont(printConfig?.Kitchen.Remarks.fontFamily);
                                    doc.setFontSize(printConfig?.Kitchen.Remarks.fontSize);
                                    doc.setTextColor(printConfig?.Kitchen.Remarks.fontColor);

                                    var ls_itemremarks = v.remarks.toString();
                                    var splitRemarks = [];
                                    var currentLine = "";
                                    var maxLineWidth = maxWidth - Items_X - 1;
                                    for (var charIndex = 0; charIndex < ls_itemremarks.length; charIndex++) {
                                        var testLine = currentLine + ls_itemremarks[charIndex];
                                        if (doc.getTextWidth(testLine) > maxLineWidth && currentLine.length > 0) {
                                            splitRemarks.push(currentLine);
                                            currentLine = ls_itemremarks[charIndex];
                                        } else {
                                            currentLine = testLine;
                                        }
                                    }
                                    if (currentLine.length > 0) splitRemarks.push(currentLine);

                                    for (var i = 0, remarksLength = splitRemarks.length; i < remarksLength; i++) {
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Kitchen.y; }
                                        y = jspdfGetNextLineY(doc, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Kitchen.y; }
                                        // ✅ Re-set font on each iteration in case page break reset it
                                        doc.setFont(printConfig?.Kitchen.Remarks.fontFamily);
                                        doc.setFontSize(printConfig?.Kitchen.Remarks.fontSize);
                                        if (v.s_no == v.parent_sno) {
                                            if (i == 0) { doc.text("**", Qty_X, y); doc.text(splitRemarks[i], Items_X, y); }
                                            else { doc.text(splitRemarks[i], Items_X, y); }
                                        } else {
                                            if (i == 0) { doc.text("**", Items_X, y); doc.text(splitRemarks[i], Items_X + 7, y); }
                                            else { doc.text(splitRemarks[i], Items_X + 7, y); }
                                        }
                                    }
                                }

                                if (index < lstTakeAway.length - 1 && lstTakeAway[index + 1].parent_sno !== v.parent_sno) {
                                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Kitchen?.y; }
                                    y = jspdfGetNextLineY(doc, y);
                                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Kitchen?.y; }
                                }

                                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Kitchen?.y; }
                                y = jspdfGetNextLineY(doc, y);
                                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Kitchen?.y; }
                            });

                            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Kitchen?.y; }
                            y = jspdfGetNextLineY(doc, y);
                            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Kitchen?.y; }
                        });

                        doc.setFont(printConfig?.Kitchen?.StarDivider.fontFamily);
                        doc.setFontSize(printConfig?.Kitchen?.StarDivider.fontSize);
                        doc.setTextColor(printConfig?.Kitchen?.StarDivider.fontColor);
                        doc.text(printConfig?.Kitchen?.StarDivider.label, x, y);

                        const pdf = doc.output("blob");
                        const pdfName = `EvolutPOS_${resolvedPrinterValue}_${timestamp()}_${same(type, KITCHEN_PRINT_TYPE.CANCEL_ITEM) ? "CANCEL_ITEM" : ""}_${kPrinterName.setting_desc}_${sales_no}_Kitchen_Receipt.pdf`;
                        printQueue.push({
                            pdfName,
                            type: KITCHEN_PRINTING.SUMMARY,
                            func: () => print(pdf, resolvedPrinterValue, pdfName),
                        });
                        console.log(`✅ [kitchen] SUMMARY PDF queued for [${printer_name}] → [${resolvedPrinterValue}]`);
                    }

                    // ── SINGLE / BOTH / SINGLEFLANG / BOTHFLANG ──
                    if (
                        contains(
                            ["SINGLE", "BOTH", "SINGLEFLANG", "BOTHFLANG", "DOTMATRIX_SINGLEFLANG", "DOTMATRIX_BOTHFLANG"],
                            kPrinterName.setting_desc
                        )
                    ) {
                        var single_print_index = 0;

                        // ✅ Fix: scope to current printer's parent items only, deduplicate by s_no
                        const seenSno = new Set();
                        var lstTakeEat = Array.from(new Set(
                            sales_dtls
                                .filter(item => same(item.printer_name, printer_name) && item.s_no === item.parent_sno)
                                .map(o => o.take_away_item)
                        ));

                        for (const te of lstTakeEat) {
                            var lstTakeAway = sales_dtls.filter(
                                v => v.take_away_item === te
                                    && same(v.printer_name, printer_name)
                                    && v.s_no === v.parent_sno
                            );

                            for (const v of lstTakeAway) {
                                // ✅ Fix: skip duplicate s_no rows (same item assigned to multiple printers)
                                if (seenSno.has(v.s_no)) continue;
                                seenSno.add(v.s_no);

                                single_print_index = single_print_index + 1;

                                let doc = await newPDF({ compress: false });
                                const fl = doc.getFontList();
                                console.log('🔤 NotoSansSC-Bold registered as:', fl['NotoSansSC-Bold']);
                                doc.setFont('NotoSansSC-Bold');
                                console.log('🔤 After setFont Bold:', doc.getFont());
                                const kConfig = printConfig.Kitchen;
                                var x = kConfig.x;
                                var y = kConfig.y;

                                var maxWidth = kConfig.maxWidth;
                                var pageHeight = doc.internal.pageSize.height - 10;
                                const maxOrderSeq = Math.max.apply(Math, sales_dtls?.map((item) => item.order_seq));

                                // ── TopmostTableNo: 2 empty lines before queue number ──
                                if (table_no && table_no.trim() !== '' && kConfig.TopmostTableNo.visible) {
                                    y = y + kConfig.EmptyLine;
                                    y = y + kConfig.EmptyLine;
                                    doc.setFont(kConfig.TopmostTableNo.fontFamily);
                                    doc.setFontSize(kConfig.TopmostTableNo.fontSize);
                                    doc.setTextColor(kConfig.TopmostTableNo.fontColor);
                                    doc.text(kConfig.TopmostTableNo.label + table_no, x, y);
                                    y = y + kConfig.EmptyLine;

                                    //y = jspdfGetNextLineY(doc, y);

                                }

                                if (kConfig.AdditionalItems && maxOrderSeq > 1 &&
                                    !same(type, KITCHEN_PRINT_TYPE.MANUAL) &&
                                    !same(type, KITCHEN_PRINT_TYPE.CANCEL_ITEM)) {
                                    doc.setFont(kConfig.AdditionalItems.fontFamily);
                                    doc.setFontSize(kConfig.AdditionalItems.fontSize);
                                    doc.setTextColor(kConfig.AdditionalItems.fontColor);
                                    doc.text(kConfig.AdditionalItems.label, x, y);
                                    // ✅ Use normal line advance instead of double EmptyLine
                                    y = jspdfGetNextLineY(doc, y);
                                    console.log('📏 y after AdditionalItems block:', y);

                                }

                                doc.setFont(kConfig.StarDivider.fontFamily);
                                doc.setFontSize(kConfig.StarDivider.fontSize);
                                doc.setTextColor(kConfig.StarDivider.fontColor);
                                doc.text(kConfig.StarDivider.label, x, y);
                                y = jspdfGetNextLineY(doc, y);
                                console.log('📏 y after StarDivider + jspdfGetNextLineY:', y);

                                if (!table_no && contains(["SAL-TQR", "SAL-WOR"], sales_no, false)) {
                                    doc.text("SELF COLLECT ORDER", x, y);
                                    y = jspdfGetNextLineY(doc, y);
                                    doc.setFont(kConfig.StarDivider.fontFamily);
                                    doc.setFontSize(kConfig.StarDivider.fontSize);
                                    doc.setTextColor(kConfig.StarDivider.fontColor);
                                    doc.text(kConfig.StarDivider.label, x, y);
                                    y = jspdfGetNextLineY(doc, y);
                                }

                                if (tableFrom && kConfig.TransferTable.visible) {
                                    y = y + kConfig.EmptyLine;
                                    doc.setFont(kConfig.TransferTable.fontFamily);
                                    doc.setFontSize(kConfig.TransferTable.fontSize);
                                    doc.setTextColor(kConfig.TransferTable.fontColor);
                                    doc.text(`${kConfig.TransferTable.label} ${tableFrom} to ${table_no}`, x, y);
                                    y = jspdfGetNextLineY(doc, y);
                                    y = y + kConfig.EmptyLine;
                                    doc.setFont(kConfig.StarDivider.fontFamily);
                                    doc.setFontSize(kConfig.StarDivider.fontSize);
                                    doc.setTextColor(kConfig.StarDivider.fontColor);
                                    doc.text(kConfig.StarDivider.label, x, y);
                                    y = jspdfGetNextLineY(doc, y);
                                }

                                if (same(type, KITCHEN_PRINT_TYPE.CANCEL_ITEM) && kConfig.Cancel.visible) {
                                    y = y + kConfig.EmptyLine;
                                    doc.setFont(kConfig.Cancel.fontFamily); doc.setFontSize(kConfig.Cancel.fontSize); doc.setTextColor(kConfig.Cancel.fontColor);
                                    doc.text(kConfig.Cancel.label, x, y); y = jspdfGetNextLineY(doc, y); y = y + kConfig.EmptyLine;
                                    doc.setFont(kConfig.StarDivider.fontFamily); doc.setFontSize(kConfig.StarDivider.fontSize); doc.setTextColor(kConfig.StarDivider.fontColor);
                                    doc.text(kConfig.StarDivider.label, x, y); y = jspdfGetNextLineY(doc, y);
                                }

                                if (status === "Void" && kConfig.Void.visible) {
                                    y = y + kConfig.EmptyLine;
                                    doc.setFont(kConfig.Void.fontFamily); doc.setFontSize(kConfig.Void.fontSize); doc.setTextColor(kConfig.Void.fontColor);
                                    doc.text(kConfig.Void.label, x, y); y = jspdfGetNextLineY(doc, y); y = y + kConfig.EmptyLine;
                                    doc.setFont(kConfig.StarDivider.fontFamily); doc.setFontSize(kConfig.StarDivider.fontSize); doc.setTextColor(kConfig.StarDivider.fontColor);
                                    doc.text(kConfig.StarDivider.label, x, y); y = jspdfGetNextLineY(doc, y);
                                }

                                if (kConfig.SingleHeader.visible) {
                                    doc.setFont(kConfig.SingleHeader.fontFamily); doc.setFontSize(kConfig.SingleHeader.fontSize); doc.setTextColor(kConfig.SingleHeader.fontColor);
                                    doc.text(kConfig.SingleHeader.label, x, y); y = jspdfGetNextLineY(doc, y);
                                }
                                if (kConfig.PrinterName.visible) {
                                    doc.setFont(kConfig.PrinterName.fontFamily); doc.setFontSize(kConfig.PrinterName.fontSize); doc.setTextColor(kConfig.PrinterName.fontColor);
                                    doc.text(kPrinterName?.setting_code, x, y); y = jspdfGetNextLineY(doc, y); y = y + kConfig.EmptyLine;
                                }
                                if (table_no && kConfig.TableNo.visible) {
                                    doc.setFont(kConfig.TableNo.fontFamily); doc.setFontSize(kConfig.TableNo.fontSize); doc.setTextColor(kConfig.TableNo.fontColor);
                                    doc.text(`${kConfig.TableNo.label} ${table_no}`, x, y, { align: "left" }); y = jspdfGetNextLineY(doc, y);
                                }
                                if (kConfig.QueueNo.visible) {
                                    doc.setFont(kConfig.QueueNo.fontFamily); doc.setFontSize(kConfig.QueueNo.fontSize); doc.setTextColor(kConfig.QueueNo.fontColor);
                                    doc.text(`${kConfig.QueueNo.label} ${sales_no.substring(17, 19).trim()}`, x, y); y = jspdfGetNextLineY(doc, y);
                                }
                                if (kConfig.Register.visible) {
                                    doc.setFont(kConfig.Register.fontFamily); doc.setFontSize(kConfig.Register.fontSize); doc.setTextColor(kConfig.Register.fontColor);
                                    doc.text(kConfig.Register.label + register_name, x, y); y = jspdfGetNextLineY(doc, y);
                                }
                                if (kConfig.ShortSalesNo.visible) {
                                    doc.setFont(kConfig.ShortSalesNo.fontFamily); doc.setFontSize(kConfig.ShortSalesNo.fontSize); doc.setTextColor(kConfig.ShortSalesNo.fontColor);
                                    doc.text(`${kConfig.ShortSalesNo.label} ${sales_no.substring(4, 7).trim()}-${sales_no.substring(15, 19).trim()}`, x, y); y = jspdfGetNextLineY(doc, y);
                                }
                                if (kConfig.SalesNo.visible) {
                                    doc.setFont(kConfig.SalesNo.fontFamily); doc.setFontSize(kConfig.SalesNo.fontSize); doc.setTextColor(kConfig.SalesNo.fontColor);
                                    doc.text(`${kConfig.SalesNo.label} ${sales_no}`, x, y); y = jspdfGetNextLineY(doc, y);
                                }
                                if (kConfig.DateTime.visible) {
                                    doc.setFont(kConfig.DateTime.fontFamily); doc.setFontSize(kConfig.DateTime.fontSize); doc.setTextColor(kConfig.DateTime.fontColor);
                                    doc.text(`${kConfig.DateTime.label} ${doc_date}`, x, y); y = jspdfGetNextLineY(doc, y);
                                }
                                if (kConfig.User.visible) {
                                    doc.setFont(kConfig.User.fontFamily); doc.setFontSize(kConfig.User.fontSize); doc.setTextColor(kConfig.User.fontColor);
                                    doc.text(`${kConfig.User.label} ${m_userid}`, x, y); y = jspdfGetNextLineY(doc, y);
                                }
                                if (kConfig.Status.visible) {
                                    doc.setFont(kConfig.Status.fontFamily); doc.setFontSize(kConfig.Status.fontSize); doc.setTextColor(kConfig.Status.fontColor);
                                    doc.text(`${kConfig.Status.label} ${status}`, x, y);
                                }
                                if (kConfig.NoOfPax.visible) {
                                    doc.setFont(kConfig.NoOfPax.fontFamily); doc.setFontSize(kConfig.NoOfPax.fontSize); doc.setTextColor(kConfig.NoOfPax.fontColor);
                                    doc.text(`${kConfig.NoOfPax.label} ${no_of_pax}`, maxWidth, y, { align: "right" });
                                }
                                y = jspdfGetNextLineY(doc, y);

                                doc.setFont(kConfig.DashDivider.fontFamily); doc.setFontSize(kConfig.DashDivider.fontSize); doc.setTextColor(kConfig.DashDivider.fontColor);
                                doc.text(kConfig.DashDivider.label, x, y); y = jspdfGetNextLineY(doc, y);
                                var Qty_X = kConfig.QtyValue.x;
                                var Items_X = kConfig.ItemsValue.x;
                                if (y >= pageHeight) { doc.addPage(); y = kConfig.y; }

                                if (te === "N" && kConfig.DineIn.visible && !contains(["T", "D"], printData?.service_type)) {
                                    doc.setFont(kConfig.DineIn.fontFamily); doc.setFontSize(kConfig.DineIn.fontSize); doc.setTextColor(kConfig.DineIn.fontColor);
                                    doc.text(kConfig.DineIn.label, x, y);
                                    if (y >= pageHeight) { doc.addPage(); y = kConfig.y; }
                                    y = jspdfGetNextLineY(doc, y);
                                    if (y >= pageHeight) { doc.addPage(); y = kConfig.y; }
                                }

                                // ✅ Fix: lstCombo follows parent_sno — picks up add-ons regardless of their printer_name
                                const itemPool = allItems ?? sales_dtls;

                                var lstCombo = [];
                                if (bool(getSetting("MORE", "KITCHEN", "KITCHEN_PRINT_SINGLE_PRINT_WITH_CHILD"))) {
                                    lstCombo = itemPool.filter((i) =>
                                        (i.parent_sno === v.s_no || i.s_no === v.s_no) &&
                                        i.ref_print === 0 && i.print_flag === "Y"
                                    );
                                    if (lstCombo.length === 0) continue;
                                    sales_dtls?.forEach((s) => {
                                        var selectedCombo = lstCombo.filter((i) =>
                                            (i.parent_sno === s.s_no || i.s_no === s.s_no) &&
                                            i.print_flag === "Y"
                                        );
                                        if (selectedCombo.length > 0) s.ref_print = 1;
                                    });
                                } else {
                                    lstCombo = itemPool.filter((i) =>
                                        (i.parent_sno === v.s_no || i.s_no === v.s_no) &&
                                        i.ref_print === 0 && i.print_flag === "Y"
                                    );
                                    if (lstCombo.length === 0) continue;
                                    sales_dtls?.forEach((s) => {
                                        var selectedCombo = lstCombo.filter((i) =>
                                            (i.parent_sno === s.s_no || i.s_no === s.s_no) &&
                                            i.print_flag === "Y"
                                        );
                                        if (selectedCombo.length > 0) s.ref_print = 1;
                                    });
                                }

                                lstCombo?.forEach((v) => {
                                    if (kConfig.TakeAway.visible && (v.take_away_item === "Y" || contains(["T", "D"], printData?.service_type))) {
                                        doc.setFont(kConfig.TakeAway.fontFamily); doc.setFontSize(kConfig.TakeAway.fontSize); doc.setTextColor(kConfig.TakeAway.fontColor);
                                        doc.text(kConfig.TakeAway.label, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = kConfig.y; }
                                        y = jspdfGetNextLineY(doc, y);
                                        if (y >= pageHeight) { doc.addPage(); y = kConfig.y; }
                                    }

                                    doc.setFont(kConfig.QtyValue.fontFamily); doc.setFontSize(kConfig.QtyValue.fontSize); doc.setTextColor(kConfig.QtyValue.fontColor);
                                    if (v.s_no == v.parent_sno) {
                                        doc.text(isWeightableItem(v)
                                            ? `   ${parseFloat(v.qty).toString()} ${v.uom.toString()}`
                                            : `   ${v.qty.toString()}`, Qty_X, y);
                                    }

                                    doc.setFont(kConfig.ItemsValue.fontFamily); doc.setFontSize(kConfig.ItemsValue.fontSize); doc.setTextColor(kConfig.ItemsValue.fontColor);
                                    console.log('🔤 Font before item text:', {
                                        requested: kConfig.ItemsValue.fontFamily,
                                        actual: doc.getFont(),
                                        fontList: Object.keys(doc.getFontList())
                                    });
                                    var ls_itemdesc = "";
                                    if (contains(["SINGLEFLANG", "BOTHFLANG", "DOTMATRIX_SINGLEFLANG", "DOTMATRIX_BOTHFLANG"], kPrinterName.setting_desc)) {
                                        ls_itemdesc = v.s_no == v.parent_sno ? v.flang_desc.toString() : `(${v.qty.toString()}) ${v.flang_desc.toString()}`;
                                    } else {
                                        if (v.s_no == v.parent_sno) { ls_itemdesc = v.item_desc.toString(); }
                                        else { ls_itemdesc = isWeightableItem(v) ? `(${parseFloat(v.qty).toString()}) ${v.uom.toString()} ${v.item_desc.toString()}` : `(${parseFloat(v.qty).toString()}) ${v.item_desc.toString()}`; }
                                    }
                                    var splitText = doc.splitTextToSize(ls_itemdesc, maxWidth - Items_X - 1);
                                    for (var i = 0, length = splitText.length; i < length; i++) {
                                        doc.text(splitText[i], isWeightableItem(v) && v.s_no == v.parent_sno ? Items_X + 17 : Items_X, y);
                                        if (i < splitText.length - 1) {
                                            if (y >= pageHeight) { doc.addPage(); y = kConfig.y; }
                                            y = jspdfGetNextLineY(doc, y);
                                            if (y >= pageHeight) { doc.addPage(); y = kConfig.y; }
                                        }
                                    }

                                    if (v.remarks && kConfig.Remarks.visible) {
                                        var splitText = doc.splitTextToSize(v.remarks.toString(), maxWidth);
                                        for (var i = 0, length = splitText.length; i < length; i++) {
                                            if (y >= pageHeight) { doc.addPage(); y = kConfig.y; }
                                            y = jspdfGetNextLineY(doc, y);
                                            if (y >= pageHeight) { doc.addPage(); y = kConfig.y; }
                                            if (v.s_no == v.parent_sno) {
                                                if (i == 0) { doc.text("**", Qty_X, y); doc.text(splitText[i], Items_X, y); }
                                                else { doc.text(splitText[i], Items_X, y); }
                                            } else {
                                                if (i == 0) { doc.text("**", Items_X, y); doc.text(splitText[i], Items_X + 7, y); }
                                                else { doc.text(splitText[i], Items_X + 7, y); }
                                            }
                                        }
                                    }

                                    if (y >= pageHeight) { doc.addPage(); y = kConfig.y; }
                                    y = jspdfGetNextLineY(doc, y);
                                    if (y >= pageHeight) { doc.addPage(); y = kConfig.y; }
                                });

                                doc.setFont(kConfig.StarDivider.fontFamily); doc.setFontSize(kConfig.StarDivider.fontSize); doc.setTextColor(kConfig.StarDivider.fontColor);
                                doc.text(kConfig.StarDivider.label, x, y);

                                const pdf = doc.output("blob");
                                const pdfName = `EvolutPOS_${resolvedPrinterValue}_${timestamp()}_${same(type, KITCHEN_PRINT_TYPE.CANCEL_ITEM) ? "CANCEL_ITEM" : ""}_${kPrinterName.setting_desc}_${sales_no}_Kitchen_Receipt.pdf`;
                                printQueue.push({
                                    pdfName,
                                    type: KITCHEN_PRINTING.SINGLE,
                                    func: () => print(pdf, resolvedPrinterValue, pdfName),
                                });
                                console.log(`✅ [kitchen] SINGLE PDF queued for [${printer_name}] → [${resolvedPrinterValue}]`);
                                //doc.save(pdfName);
                            }
                        }
                    }
                } catch (error) {
                    console.error(`❌ [kitchen] Error building PDF for printer: ${printer_name}`, error);
                }
            }

            console.log(`🖨️ [kitchen] Total print queue: ${printQueue.length}`);

            await Promise.allSettled(
                printQueue.map(async (current, i) => {
                    const printDelayBeforeKitchenPrint =
                        parseFloat(getSetting("MORE", "KITCHEN", "PRINT_DELAY_BEFORE_KITCHEN_PRINT")) || 0;
                    if (printDelayBeforeKitchenPrint > 0)
                        await new Promise((resolve) => setTimeout(resolve, printDelayBeforeKitchenPrint * 1000));

                    try {
                        await current.func();
                        console.log(`[ORDER - ${type} - KITCHEN PRINTING] [SUCCESS] | id: ${printData?.sales_no} | res: ${current.pdfName}`);
                        const next = printQueue[i + 1];
                        if (next && same(current?.type, KITCHEN_PRINTING.SUMMARY) && same(next?.type, KITCHEN_PRINTING.SINGLE)) {
                            await new Promise((resolve) => setTimeout(resolve, 500));
                        }
                    } catch (error) {
                        console.error(`[ORDER - ${type} - KITCHEN PRINTING] [FAIL] | id: ${printData?.sales_no} | res: ${current.pdfName}`, error);
                    }
                })
            );

        } catch (error) {
            console.error(`[ORDER - ${type} - KITCHEN PRINTING] [FAIL] | id: ${(Array.isArray(data) ? data[0] : data)?.sales_no}`, error);
        }
    })();
}





// ── Module-level caches — survive across calls ───────────────────────────────
let _cachedHeaderImg = null;
let _cachedFooterImg = null;
let _imagesPreloading = null; // shared promise so concurrent calls don't double-load

// Preload both images once at module level — call this early (e.g. on app boot)
export function preloadReceiptImages() {
    if (_imagesPreloading) return _imagesPreloading;
    _imagesPreloading = Promise.all([
        loadImage("/img/receipt.png").catch(() => null),
        loadImage("/img/receipt-footer.png").catch(() => null),
    ]).then(([h, f]) => {
        _cachedHeaderImg = h;
        _cachedFooterImg = f;
        console.log('✅ [receiptPrint] Receipt images pre-cached');
    });
    return _imagesPreloading;
}

// ── Font size decrease — run once per config, cache result ───────────────────
function decreaseFontSizes(config, decreaseBy = 1) {
    if (typeof config !== 'object' || config === null) return config;
    if (Array.isArray(config)) return config.map(item => decreaseFontSizes(item, decreaseBy));
    return Object.fromEntries(
        Object.entries(config).map(([key, value]) => {
            if (key === 'fontSize' && typeof value === 'number') {
                return [key, Math.max(1, value - decreaseBy)];
            }
            return [key, decreaseFontSizes(value, decreaseBy)];
        })
    );
}

// ── Image preloader ───────────────────────────────────────────────────────────
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
        img.src = src;
    });
}

export const receiptPrint = async (
    type,
    data,
    index = "0",
    printerNameOverride = null
) => {
    const { store, promos, printConfig, printerSettings } = useCache();

    // ── Apply font size decrease once, cache result ───────────────────────────
    if (printConfig?.Receipt && !printConfig.Receipt._fontDecreased) {
        printConfig.Receipt = decreaseFontSizes(printConfig.Receipt);
        printConfig.Receipt._fontDecreased = true;
    }

    const printerName = printerNameOverride?.trim()
        || getSetting("HARDWARE", "HARDWARE", "RECEIPT_PRINTER_NAME")?.trim();

    console.group('🖨️ [receiptPrint] Printer Resolution');
    console.log('printerNameOverride :', printerNameOverride);
    console.log('getSetting result   :', getSetting("HARDWARE", "HARDWARE", "RECEIPT_PRINTER_NAME"));
    console.log('resolved printerName:', printerName);
    console.log('type                :', type);
    console.log('printConfig.Receipt :', !!printConfig?.Receipt);
    console.groupEnd();

    if (
        (!printerName || !printConfig?.Receipt) &&
        !same(type, RECEIPT_PRINT_TYPE.VIEW)
    ) {
        console.warn('⚠️ [receiptPrint] BAIL — printer:', printerName, '| config:', !!printConfig?.Receipt);
        return;
    }

    try {
        var order = data[0];

        order = {
            ...order,
            sub_total: parseFloat(order?.sub_total),
            total_disc: parseFloat(order?.total_disc),
            total_svc: parseFloat(order?.total_svc),
            total_tax: parseFloat(order?.total_tax),
            total_tax_absorbed: parseFloat(order?.total_tax_absorbed),
            round_adj_amt: parseFloat(order?.round_adj_amt),
            change_amt: parseFloat(order?.change_amt),
            net_amt: parseFloat(order?.net_amt),
        };

        if (!order?.customer_code && same(type, RECEIPT_PRINT_TYPE.EMAIL)) return;

        // ── Merge duplicate a-la-carte parent rows ────────────────────────────
        let newSalesDtls = [];
        clone(order?.sales_dtls)?.forEach((orderitem) => {
            if (
                !orderitem?.menu_type &&
                same(orderitem?.ds_no, 1) &&
                same(orderitem?.disc_name, "None") &&
                !orderitem?.ref_1 &&
                !isOpenItem(orderitem) &&
                !isAddonItem(orderitem) &&
                !isAddon2Item(orderitem) &&
                notFreeItem(orderitem)
            ) {
                const existedItemIndex = newSalesDtls?.findIndex((v) =>
                    same(v?.item_no, orderitem?.item_no) &&
                    same(v?.take_away_item, orderitem?.take_away_item)
                );
                if (existedItemIndex >= 0) {
                    newSalesDtls[existedItemIndex].qty += orderitem.qty;
                    newSalesDtls[existedItemIndex].sub_total += orderitem.sub_total;
                } else {
                    newSalesDtls.push(orderitem);
                }
            } else {
                newSalesDtls.push(orderitem);
            }
        });
        order.sales_dtls = newSalesDtls;

        // ── Remove zero-price items if setting enabled ────────────────────────
        if (bool(getSetting("PRINT SETTINGS", "RECEIPT", "Remove_Zero_Price_Item_InReceipt"))) {
            order.sales_dtls = order?.sales_dtls?.filter((v) =>
                parseFloat(v.price.toFixed(0)) > 0 || v.menu_type
            );
        }

        order.sales_dtls = sortOrderItems(order.sales_dtls);

        // ── Detect online DELI/TAKE order ─────────────────────────────────────
        const isOnlineDeliveryOrTakeaway = (
            order?.customer &&
            order?.ref_1 &&
            (order?.ref_1.toUpperCase().includes("DELI") || order?.ref_1.toUpperCase().includes("TAKE")) &&
            (sales_no?.includes("SAL-TQR") || sales_no?.includes("SAL-SOK") || sales_no?.includes("SAL-WOR"))
        );

        // ── Init PDF + load images ────────────────────────────────────────────
        console.log('🛠️ [PDF Init] Starting — images + PDF');
        const needImages = !_cachedHeaderImg || !_cachedFooterImg;
        const [headerImg, footerImg, doc] = await Promise.all([
            needImages ? loadImage("/img/receipt.png").catch(() => null) : Promise.resolve(_cachedHeaderImg),
            needImages ? loadImage("/img/receipt-footer.png").catch(() => null) : Promise.resolve(_cachedFooterImg),
            //    newPDF({ compress: false }),
            newPDF({ compress: false, noCjkPatch: true, defaultFont: 'SourceSansPro-Regular' }),
        ]);
        if (headerImg) _cachedHeaderImg = headerImg;
        if (footerImg) _cachedFooterImg = footerImg;
        if (!headerImg) console.warn('⚠️ Receipt header image skipped');
        if (!footerImg) console.warn('⚠️ Receipt footer image skipped');
        console.log('✅ [PDF Init] PDF + images ready');

        var x = printConfig?.Receipt?.x;
        var y = printConfig?.Receipt?.y;
        var maxWidth = printConfig?.Receipt?.maxWidth;
        var pageHeight = doc.internal.pageSize.height;

        var store_group = store?.store_group;
        var store_name = store?.store_name;
        var store_addr = store?.store_addr;
        var gst_no = store?.gst_no;
        var sales_no = order?.sales_no;
        var status = order?.order_status_desc;
        var register_name = order?.register_name;
        const rawDate = (order?.doc_date ?? '').replace('T', ' ').split('.')[0];
        var doc_date = dayjs(rawDate).format(DATE_TIME_FORMAT);
        var date = getNowWithLoginDate().format(DATE_TIME_FORMAT);
        var m_userid = order?.m_userid;
        var table_no = order?.table_no;
        var no_of_pax = order?.no_of_pax;

        console.log('📅 doc_date raw:', order?.doc_date, '| parsed:', doc_date, '| format:', DATE_TIME_FORMAT);

        // ── Topmost Table No ──────────────────────────────────────────────────
        if (table_no && printConfig?.Receipt?.TopmostTableNo?.visible) {
            doc.setFont(printConfig?.Receipt?.StarDivider.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.StarDivider.fontSize);
            doc.setTextColor(printConfig?.Receipt?.StarDivider.fontColor);
            doc.text(printConfig?.Receipt?.StarDivider.label, x, y);
            doc.setFont(printConfig?.Receipt?.TopmostTableNo.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.TopmostTableNo.fontSize);
            doc.setTextColor(printConfig?.Receipt?.TopmostTableNo.fontColor);
            doc.text(printConfig?.Receipt?.TopmostTableNo.label + table_no, maxWidth / 2, y, { align: "center" });
        }

        // ── Topmost 2-digit Queue No ──────────────────────────────────────────
        if (sales_no && printConfig?.Receipt?.Topmost2DigitsQueueNo?.visible) {

            // Print star divider
            doc.setFont(printConfig?.Receipt?.StarDivider.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.StarDivider.fontSize);
            doc.setTextColor(printConfig?.Receipt?.StarDivider.fontColor);
            doc.text(printConfig?.Receipt?.StarDivider.label, x, y);

            //// ✅ Increment y after star divider before printing queue number
            y += printConfig?.Receipt?.StarDivider.fontSize / 2 + 2;

            // Print queue number
            doc.setFont(printConfig?.Receipt?.Topmost2DigitsQueueNo.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.Topmost2DigitsQueueNo.fontSize);
            doc.setTextColor(printConfig?.Receipt?.Topmost2DigitsQueueNo.fontColor);
            doc.text(
                printConfig?.Receipt?.Topmost2DigitsQueueNo.label + sales_no?.substring(17, 19).trim(),
                maxWidth / 2, y, { align: "center" }
            );

            // ✅ Increment y after queue number for whatever comes next
            y += printConfig?.Receipt?.Topmost2DigitsQueueNo.fontSize / 2 + 2;
        }

        // ── Header Image ──────────────────────────────────────────────────────
        if (headerImg) {

            doc.addImage(headerImg, "PNG", 0, y, maxWidth, 30);
            y += printConfig?.Receipt?.EmptyLine;

            y += 30;

            console.log('✅ Receipt header image added');
        }

        // ── Queue No ──────────────────────────────────────────────────────────
        if (
            sales_no &&
            (printConfig?.isdefault || printConfig?.Receipt?.QueueNo?.visible) &&
            bool(getSetting("PRINT SETTINGS", "RECEIPT", "show_queue_number_onreceipt"))
        ) {
            // ✅ No EmptyLine before first divider — avoid extra gap at top
            doc.setFont(printConfig?.Receipt?.StarDivider.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.StarDivider.fontSize);
            doc.setTextColor(printConfig?.Receipt?.StarDivider.fontColor);
            doc.text(printConfig?.Receipt?.StarDivider.label, x, y);
            y += 3; // ✅ hardcoded tight gap — divider to queue no
            doc.setFont(printConfig?.Receipt?.QueueNo.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.QueueNo.fontSize);
            doc.setTextColor(printConfig?.Receipt?.QueueNo.fontColor);
            doc.text(
                `${printConfig?.Receipt?.QueueNo.label}SK-${(order?.queue_no ?? sales_no.substring(16, 19))?.trim()}`,
                maxWidth / 2, y, { align: "center" }
            );
            y += 3;
            doc.setFont(printConfig?.Receipt?.StarDivider.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.StarDivider.fontSize);
            doc.setTextColor(printConfig?.Receipt?.StarDivider.fontColor);
            doc.text(printConfig?.Receipt?.StarDivider.label, x, y);
            y += 2; // ✅ tight gap after closing divider before next section
        }

        // ── Store Group ───────────────────────────────────────────────────────
        if (
            store_group &&
            bool(getSetting("PRINT SETTINGS", "RECEIPT", "show_company_name_onreceipt")) &&
            (printConfig?.isdefault || printConfig?.Receipt?.StoreGroup?.visible)
        ) {
            doc.setFont(printConfig?.Receipt?.StoreGroup.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.StoreGroup.fontSize);
            doc.setTextColor(printConfig?.Receipt?.StoreGroup.fontColor);
            doc.text(store_group, x, y);
            y = jspdfGetNextLineY(doc, y);
        }

        // ── Store Name ────────────────────────────────────────────────────────
        if (store_name && (printConfig?.isdefault || printConfig?.Receipt?.StoreName?.visible)) {
            doc.setFont(printConfig?.Receipt?.StoreName.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.StoreName.fontSize);
            doc.setTextColor(printConfig?.Receipt?.StoreName.fontColor);
            doc.text(store_name, x, y);
            y = jspdfGetNextLineY(doc, y);
        }

        // ── Store Address ─────────────────────────────────────────────────────
        if (store_addr && (printConfig?.isdefault || printConfig?.Receipt?.StoreAddress?.visible)) {
            doc.setFont(printConfig?.Receipt?.StoreAddress.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.StoreAddress.fontSize);
            doc.setTextColor(printConfig?.Receipt?.StoreAddress.fontColor);
            store_addr.split("\n").forEach((line) => {
                doc.text(line, x, y);
                y = jspdfGetNextLineY(doc, y);
            });
        }

        // ── GST No ────────────────────────────────────────────────────────────
        if (gst_no && printConfig?.Receipt?.GstNo) {
            doc.setFont(printConfig?.Receipt?.GstNo.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.GstNo.fontSize);
            doc.setTextColor(printConfig?.Receipt?.GstNo.fontColor);
            const gstLabel = printConfig?.Receipt?.GstNo.visible ? printConfig?.Receipt?.GstNo.label : '';
            doc.text(gstLabel + gst_no, x, y);
            y = jspdfGetNextLineY(doc, y);
        }

        // ── Delivery / Takeaway customer + ref ───────────────────────────────
        if (
            order?.ref_1 &&
            contains(["SAL-TQR", "SAL-SOK", "SAL-WOR", "SAL-GRF", "SAL-FOP"], sales_no, false) &&
            contains(["DELI", "TAKE"], order?.ref_1, false)
        ) {
            if (printConfig?.isdefault || printConfig?.Receipt?.Customer?.visible) {
                const customerName = order?.customer?.name || '';
                if (customerName) {
                    doc.setFont(printConfig?.Receipt?.Customer.fontFamily);
                    doc.setFontSize(printConfig?.Receipt?.Customer.fontSize);
                    doc.setTextColor(printConfig?.Receipt?.Customer.fontColor);
                    doc.text(printConfig?.Receipt?.Customer.label + customerName, x, y);
                    y = jspdfGetNextLineY(doc, y);
                }
            }
            if (order?.ref_5 && (printConfig?.isdefault || printConfig?.Receipt?.OrderRefNo?.visible)) {
                doc.setFont(printConfig?.Receipt?.OrderRefNo.fontFamily);
                doc.setFontSize(printConfig?.Receipt?.OrderRefNo.fontSize);
                doc.setTextColor(printConfig?.Receipt?.OrderRefNo.fontColor);
                const refLabel = printConfig?.Receipt?.OrderRefNo.label;
                if (contains(["SAL-GRF", "SAL-FOP"], sales_no, false)) {
                    doc.text(`${refLabel}${order?.ref_5}`, x, y);
                } else {
                    doc.text(`${refLabel}APP${order?.ref_5.slice(-4)}`, x, y);
                }
                y = jspdfGetNextLineY(doc, y);
            }
        }

        // ── Sales No ──────────────────────────────────────────────────────────
        if (sales_no && (printConfig?.isdefault || printConfig?.Receipt?.SalesNo?.visible)) {
            doc.setFont(printConfig?.Receipt?.SalesNo.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.SalesNo.fontSize);
            doc.setTextColor(printConfig?.Receipt?.SalesNo.fontColor);
            doc.text(`${printConfig?.Receipt?.SalesNo.label}${sales_no}`, x, y);
            y = jspdfGetNextLineY(doc, y);
        }

        // ── Status (+ Table No on right) ──────────────────────────────────────
        if (status && (printConfig?.isdefault || printConfig?.Receipt?.Status?.visible)) {
            doc.setFont(printConfig?.Receipt?.Status.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.Status.fontSize);
            doc.setTextColor(printConfig?.Receipt?.Status.fontColor);
            doc.text(`${printConfig?.Receipt?.Status.label}${status}`, x, y);
            if (table_no && (printConfig?.isdefault || printConfig?.Receipt?.TableNo?.visible)) {
                doc.setFont(printConfig?.Receipt?.TableNo.fontFamily);
                doc.setFontSize(printConfig?.Receipt?.TableNo.fontSize);
                doc.setTextColor(printConfig?.Receipt?.TableNo.fontColor);
                doc.text(printConfig?.Receipt?.TableNo.label + table_no, maxWidth, y, { align: "right" });
            }
            y = jspdfGetNextLineY(doc, y);
        }

        // ── Register ──────────────────────────────────────────────────────────
        if (register_name && (printConfig?.isdefault || printConfig?.Receipt?.Register?.visible)) {
            doc.setFont(printConfig?.Receipt?.Register.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.Register.fontSize);
            doc.setTextColor(printConfig?.Receipt?.Register.fontColor);
            doc.text(`${printConfig?.Receipt?.Register.label}${register_name}`, x, y);
            y = jspdfGetNextLineY(doc, y);
        }

        // ── Date ──────────────────────────────────────────────────────────────
        if (doc_date && (printConfig?.isdefault || printConfig?.Receipt?.Date?.visible)) {
            doc.setFont(printConfig?.Receipt?.Date.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.Date.fontSize);
            doc.setTextColor(printConfig?.Receipt?.Date.fontColor);
            doc.text(`${printConfig?.Receipt?.Date.label}${doc_date}`, x, y);
            y = jspdfGetNextLineY(doc, y);
        }

        // ── User ──────────────────────────────────────────────────────────────
        if (m_userid && (printConfig?.isdefault || printConfig?.Receipt?.User?.visible)) {
            doc.setFont(printConfig?.Receipt?.User.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.User.fontSize);
            doc.setTextColor(printConfig?.Receipt?.User.fontColor);
            doc.text(`${printConfig?.Receipt?.User.label}${m_userid}`, x, y);
            y = jspdfGetNextLineY(doc, y);
        }

        // ── No Of Pax ─────────────────────────────────────────────────────────
        if (no_of_pax && (printConfig?.isdefault || printConfig?.Receipt?.NoOfPax?.visible)) {
            doc.setFont(printConfig?.Receipt?.NoOfPax.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.NoOfPax.fontSize);
            doc.setTextColor(printConfig?.Receipt?.NoOfPax.fontColor);
            doc.text(`${printConfig?.Receipt?.NoOfPax.label}${no_of_pax}`, x, y);
            y = jspdfGetNextLineY(doc, y);
        }

        y += printConfig?.Receipt?.EmptyLine;

        // ── Duplicate Receipt ─────────────────────────────────────────────────
        var isDuplicatedReceipt = false;
        if (
            (same(type, RECEIPT_PRINT_TYPE.MANUAL) || same(type, RECEIPT_PRINT_TYPE.DUPLICATE)) &&
            order.sales_payment_dtls?.length > 0
        ) {
            isDuplicatedReceipt = true;
        }
        if (isDuplicatedReceipt) {
            doc.setFont(printConfig?.Receipt?.DuplicateReceipt.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.DuplicateReceipt.fontSize);
            doc.setTextColor(printConfig?.Receipt?.DuplicateReceipt.fontColor);
            doc.text(printConfig?.Receipt?.DuplicateReceipt.label, maxWidth / 2, y, { align: "center" });
            y = jspdfGetNextLineY(doc, y);
        }

        // ── Body Divider ──────────────────────────────────────────────────────
        doc.setFont(printConfig?.Receipt?.DashDivider.fontFamily);
        doc.setFontSize(printConfig?.Receipt?.DashDivider.fontSize);
        doc.setTextColor(printConfig?.Receipt?.DashDivider.fontColor);
        doc.text(printConfig?.Receipt?.DashDivider.label, x, y);
        y = jspdfGetNextLineY(doc, y);

        // ── Column layout constants ───────────────────────────────────────────
        var Qty_X = printConfig?.Receipt?.Qty.x;      // 0
        var Items_X = printConfig?.Receipt?.Items.x;    // 10
        var Amount_X = printConfig?.Receipt?.Amount.x;   // 70 (= maxWidth)
        // Item text must stop before amount column — reserve 2mm gap
        const itemTextMaxWidth = Amount_X - Items_X - 2; // 58mm

        // ── Column headers ────────────────────────────────────────────────────
        if (printConfig?.isdefault || printConfig?.Receipt?.Qty?.visible) {
            doc.setFont(printConfig?.Receipt?.Qty.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.Qty.fontSize);
            doc.setTextColor(printConfig?.Receipt?.Qty.fontColor);
            doc.text(printConfig?.Receipt?.Qty.label, Qty_X, y, { maxWidth: Items_X - Qty_X - 1 });
        }
        if (printConfig?.isdefault || printConfig?.Receipt?.Items?.visible) {
            doc.setFont(printConfig?.Receipt?.Items.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.Items.fontSize);
            doc.setTextColor(printConfig?.Receipt?.Items.fontColor);
            doc.text(printConfig?.Receipt?.Items.label, Items_X, y, { maxWidth: itemTextMaxWidth });
        }
        if (printConfig?.isdefault || printConfig?.Receipt?.Amount?.visible) {
            doc.setFont(printConfig?.Receipt?.Amount.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.Amount.fontSize);
            doc.setTextColor(printConfig?.Receipt?.Amount.fontColor);
            // ✅ Header right-aligned to Amount_X
            doc.text(printConfig?.Receipt?.Amount.label, Amount_X, y, { align: "right" });
        }
        y = jspdfGetNextLineY(doc, y);

        doc.setFont(printConfig?.Receipt?.DashDivider.fontFamily);
        doc.setFontSize(printConfig?.Receipt?.DashDivider.fontSize);
        doc.setTextColor(printConfig?.Receipt?.DashDivider.fontColor);
        doc.text(printConfig?.Receipt?.DashDivider.label, x, y);
        y += printConfig?.Receipt?.EmptyLine;

        // ── Order Items ───────────────────────────────────────────────────────
        const lstTakeEat = Array.from(new Set(order?.sales_dtls?.map((o) => o.take_away_item)))?.sort();

        lstTakeEat.forEach((te) => {
            const lstTakeAway = order?.sales_dtls?.filter((v) => v.take_away_item === te);

            // Dine In / Take Away divider
            if (te === "N" && (printConfig?.isdefault || printConfig?.Receipt?.DineInDivider?.visible) && lstTakeAway?.length > 0) {
                doc.setFont(printConfig?.Receipt?.DineInDivider.fontFamily);
                doc.setFontSize(printConfig?.Receipt?.DineInDivider.fontSize);
                doc.setTextColor(printConfig?.Receipt?.DineInDivider.fontColor);
                doc.text(printConfig?.Receipt?.DineInDivider.label, x, y);
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                y = jspdfGetNextLineY(doc, y);
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            } else if ((printConfig?.isdefault || printConfig?.Receipt?.TakeAwayDivider?.visible) && lstTakeAway?.length > 0) {
                doc.setFont(printConfig?.Receipt?.TakeAwayDivider.fontFamily);
                doc.setFontSize(printConfig?.Receipt?.TakeAwayDivider.fontSize);
                doc.setTextColor(printConfig?.Receipt?.TakeAwayDivider.fontColor);
                doc.text(printConfig?.Receipt?.TakeAwayDivider.label, x, y);
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                y = jspdfGetNextLineY(doc, y);
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            }

            lstTakeAway.forEach((v) => {
                var ls_itemdesc = "";
                if (v.s_no == v.parent_sno) {
                    doc.setFont(printConfig?.Receipt?.QtyValue.fontFamily);
                    doc.setFontSize(printConfig?.Receipt?.QtyValue.fontSize);
                    doc.setTextColor(printConfig?.Receipt?.QtyValue.fontColor);
                    doc.text(v.qty.toString(), Qty_X, y, { maxWidth: Items_X - Qty_X - 1 });
                    ls_itemdesc = v.item_desc.toString();
                } else {
                    ls_itemdesc = v.qty.toString() + "x " + v.item_desc.toString();
                }

                const hasAmount = !(v.ds_no === 1 && contains(["S", "C", "M"], v.menu_type));
                const amountStr = v.sub_total.toFixed(2);

                // ✅ First line restricted to 65% of column — prevents overlap with amount
                // Continuation lines use full column width
                const columnWidth = Amount_X - Items_X;          // 60mm
                const firstLineMaxWidth = hasAmount ? columnWidth * 0.65 : columnWidth - 2;
                const contLineMaxWidth = columnWidth - 2;             // 58mm

                doc.setFont(printConfig?.Receipt?.Items.fontFamily);
                doc.setFontSize(printConfig?.Receipt?.Items.fontSize);
                doc.setTextColor(printConfig?.Receipt?.Items.fontColor);

                // Split first line with restricted width, then re-split remainder at full width
                const firstLineSplit = doc.splitTextToSize(ls_itemdesc, firstLineMaxWidth);
                const firstLine = firstLineSplit[0] ?? '';
                const remaining = ls_itemdesc.slice(firstLine.length).trim();
                const contLines = remaining ? doc.splitTextToSize(remaining, contLineMaxWidth) : [];
                const allLines = [firstLine, ...contLines];

                for (var i = 0; i < allLines.length; i++) {
                    if (i === 0 && hasAmount) {
                        doc.setFont(printConfig?.Receipt?.AmountValue.fontFamily);
                        doc.setFontSize(printConfig?.Receipt?.AmountValue.fontSize);
                        doc.setTextColor(printConfig?.Receipt?.AmountValue.fontColor);
                        doc.text(amountStr, Amount_X, y, { align: "right" });
                        doc.setFont(printConfig?.Receipt?.Items.fontFamily);
                        doc.setFontSize(printConfig?.Receipt?.Items.fontSize);
                        doc.setTextColor(printConfig?.Receipt?.Items.fontColor);
                    }
                    doc.text(allLines[i], Items_X, y);
                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                    y = jspdfGetNextLineY(doc, y);
                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                }

                // ── Discount / Promo ──────────────────────────────────────────────────
                if (v.disc_name && !same(v.disc_name, "None") && (printConfig?.isdefault || printConfig?.Receipt?.DiscountValue?.visible)) {
                    doc.setFont(printConfig?.Receipt?.DiscountValue.fontFamily);
                    doc.setFontSize(printConfig?.Receipt?.DiscountValue.fontSize);
                    doc.setTextColor(printConfig?.Receipt?.DiscountValue.fontColor);

                    if (parseFloat(v.unit_price) > 0) {
                        doc.text(`@ ${v.unit_price.toFixed(2)}`, Items_X, y);
                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                        y = jspdfGetNextLineY(doc, y);
                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                    }

                    if (parseFloat(v.disc_amt) > 0) {
                        if (same(v.disc_name, "OPEN ITEM DISCOUNT")) {
                            const discText = same(v.disc_type, "P")
                                ? `${v.disc_value.toFixed(2)}% Open Item Discount : ${v.disc_amt.toFixed(2)}`
                                : `$${v.disc_value.toFixed(2)} Open Item Discount`;
                            doc.text(discText, Items_X, y);
                        } else {
                            doc.text(`${v.disc_name} : -${v.disc_amt.toFixed(2)}`, Items_X, y);
                        }
                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                        y = jspdfGetNextLineY(doc, y);
                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                    } else {
                        const promo = promos?.find((p) => same(p.promo_name, v.disc_name));
                        if (promo) {
                            if (
                                (same(promo.criteria_type, PROMO_TYPE.SPECIAL_PRICE) ||
                                    same(promo.criteria_type, PROMO_TYPE.SPECIAL_DISCOUNT_WITH_QUANTITY)) &&
                                same(promo.criteria_promo_item_no, v.item_no)
                            ) {
                                if (parseFloat(v.unit_price) > 0) {
                                    doc.text(`@ ${v.unit_price.toFixed(2)}`, Items_X, y);
                                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                    y = jspdfGetNextLineY(doc, y);
                                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                }
                                doc.text(v.disc_name, Items_X, y);
                            } else if (
                                promo.criteria_type === PROMO_TYPE.FREE_ITEM ||
                                promo.criteria_type === PROMO_TYPE.FREE_ITEM_WITH_LIMIT ||
                                promo.criteria_type === PROMO_TYPE.FREE_ITEM_BY_VALUE
                            ) {
                                const creteria_item_dtls = promo.creteria_item_dtls;
                                if (creteria_item_dtls !== "") {
                                    const chkProitem = creteria_item_dtls.filter((p1) => p1.item_no === v.item_no);
                                    if (chkProitem.length > 0) doc.text(v.disc_name, Items_X, y);
                                }
                            }
                        } else {
                            doc.text(v.disc_name, Items_X, y);
                        }
                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                        y = jspdfGetNextLineY(doc, y);
                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                    }
                }

                // ── Ref Value ─────────────────────────────────────────────────────────
                if (v.ref_4 && (printConfig?.isdefault || printConfig?.Receipt?.RefValue?.visible)) {
                    doc.setFont(printConfig?.Receipt?.RefValue.fontFamily);
                    doc.setFontSize(printConfig?.Receipt?.RefValue.fontSize);
                    doc.setTextColor(printConfig?.Receipt?.RefValue.fontColor);
                    doc.text(v.ref_4, Items_X, y);
                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                    y = jspdfGetNextLineY(doc, y);
                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                }
            });
        });

        // ── Dash Divider ──────────────────────────────────────────────────────
        if (printConfig?.isdefault || printConfig?.Receipt?.DashDivider?.visible) {
            doc.setFont(printConfig?.Receipt?.DashDivider.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.DashDivider.fontSize);
            doc.setTextColor(printConfig?.Receipt?.DashDivider.fontColor);
            doc.text(printConfig?.Receipt?.DashDivider.label, x, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y = jspdfGetNextLineY(doc, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
        }

        // ── Subtotal ──────────────────────────────────────────────────────────
        if (printConfig?.isdefault || printConfig?.Receipt?.Subtotal?.visible) {
            doc.setFont(printConfig?.Receipt?.Subtotal.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.Subtotal.fontSize);
            doc.setTextColor(printConfig?.Receipt?.Subtotal.fontColor);
            doc.text(printConfig?.Receipt?.Subtotal.label, x, y);
            // ✅ Right-aligned to Amount_X
            doc.text(order?.sub_total.toFixed(2), Amount_X, y, { align: "right" });
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y = jspdfGetNextLineY(doc, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
        }

        // ── Total Discount ────────────────────────────────────────────────────
        if (parseFloat(order?.total_disc) > 0 && (printConfig?.isdefault || printConfig?.Receipt?.TotalDiscount?.visible)) {
            doc.setFont(printConfig?.Receipt?.TotalDiscount.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.TotalDiscount.fontSize);
            doc.setTextColor(printConfig?.Receipt?.TotalDiscount.fontColor);
            doc.text(printConfig?.Receipt?.TotalDiscount.label, x, y);
            // ✅ Right-aligned to Amount_X
            doc.text(order?.total_disc.toFixed(2), Amount_X, y, { align: "right" });
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y = jspdfGetNextLineY(doc, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }

            if (order?.disc_name && !same(order?.disc_name, "None")) {
                let discLine = '';
                if (same(order?.disc_name, "OPEN TOTAL DISCOUNT")) {
                    discLine = same(order?.disc_type, "P")
                        ? `${order.disc_value.toFixed(2)}% ${order.disc_name} : ${order.total_disc.toFixed(2)}`
                        : `$${order?.disc_value.toFixed(2)} ${order?.disc_name}`;
                } else {
                    discLine = order?.disc_name;
                }
                doc.text(discLine, x + 2, y);
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                y = jspdfGetNextLineY(doc, y);
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            }
        }

        // ── Service Charges ───────────────────────────────────────────────────
        if (printConfig?.isdefault || printConfig?.Receipt?.ServiceCharge?.visible) {
            doc.setFont(printConfig?.Receipt?.ServiceCharge.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.ServiceCharge.fontSize);
            doc.setTextColor(printConfig?.Receipt?.ServiceCharge.fontColor);
            (order?.sales_service_dtls || []).forEach((sv) => {
                if (parseFloat(sv.service_amt) > 0) {
                    doc.text(sv.service_name, x, y);
                    // ✅ Right-aligned to Amount_X
                    doc.text(parseFloat(sv.service_amt).toFixed(2), Amount_X, y, { align: "right" });
                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                    y = jspdfGetNextLineY(doc, y);
                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                }
            });
        }

        // ── GST ───────────────────────────────────────────────────────────────
        const isAbsorbTax = bool(store?.is_absorbtax);
        if (printConfig?.isdefault || printConfig?.Receipt?.GST?.visible) {
            doc.setFont(printConfig?.Receipt?.GST.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.GST.fontSize);
            doc.setTextColor(printConfig?.Receipt?.GST.fontColor);
            doc.text(`${printConfig?.Receipt?.GST.label} ${order?.sales_dtls[0].tax_value}%`, x, y);
            // ✅ Right-aligned to Amount_X
            doc.text(order?.total_tax.toFixed(2), Amount_X, y, { align: "right" });
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y = jspdfGetNextLineY(doc, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
        }

        // ── Rounding Adjustment ───────────────────────────────────────────────
        if (parseFloat(order?.round_adj_amt) !== 0 && (printConfig?.isdefault || printConfig?.Receipt?.RoundingAdjustment?.visible)) {
            doc.setFont(printConfig?.Receipt?.RoundingAdjustment.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.RoundingAdjustment.fontSize);
            doc.setTextColor(printConfig?.Receipt?.RoundingAdjustment.fontColor);
            doc.text(printConfig?.Receipt?.RoundingAdjustment.label, x, y);
            // ✅ Right-aligned to Amount_X
            doc.text(order?.round_adj_amt.toFixed(2), Amount_X, y, { align: "right" });
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y = jspdfGetNextLineY(doc, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
        }

        // ── Total ─────────────────────────────────────────────────────────────
        if (printConfig?.isdefault || printConfig?.Receipt?.Total?.visible) {
            doc.setFont(printConfig?.Receipt?.Total.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.Total.fontSize);
            doc.setTextColor(printConfig?.Receipt?.Total.fontColor);
            doc.text(
                `${printConfig?.Receipt?.Total.label} ${isAbsorbTax ? "Incl." : "Excl."} ${printConfig?.Receipt?.GST.label}`,
                x, y
            );
            // ✅ Right-aligned to Amount_X
            doc.text(order?.net_amt.toFixed(2), Amount_X, y, { align: "right" });
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y = jspdfGetNextLineY(doc, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
        }

        // ── No of Items ───────────────────────────────────────────────────────
        if (printConfig?.isdefault || printConfig?.Receipt?.NoofItems?.visible) {
            doc.setFont(printConfig?.Receipt?.NoofItems.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.NoofItems.fontSize);
            doc.setTextColor(printConfig?.Receipt?.NoofItems.fontColor);
            const itemCount = order?.sales_dtls?.filter((item) => item?.ds_no === 1)?.length ?? 0;
            doc.text(`${printConfig?.Receipt?.NoofItems.label} ${itemCount}`, x, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y = jspdfGetNextLineY(doc, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
        }

        // ── Payment Info ──────────────────────────────────────────────────────
        // ── Payment Info ──────────────────────────────────────────────────────
        if (order?.sales_payment_dtls?.length > 0 && (printConfig?.isdefault || printConfig?.Receipt?.PaymentInfo?.visible)) {
            doc.setFont(printConfig?.Receipt?.PaymentInfo?.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.PaymentInfo?.fontSize);
            doc.setTextColor(printConfig?.Receipt?.PaymentInfo?.fontColor);
            doc.text(printConfig?.Receipt?.PaymentInfo?.label, x, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }

            order?.sales_payment_dtls?.forEach((v) => {
                doc.text(v.payment_name.toString().trim(), x, y);
                doc.text(parseFloat(v.tender_amt).toFixed(2), Amount_X, y, { align: "right" });
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }

                // Credit Card Payment Reference
                if (
                    v.ref_info?.toString().trim()?.length > 0 &&
                    !v.payment_name.toString().trim().includes("NETS") &&
                    (printConfig?.isdefault || printConfig?.Receipt?.PaymentReference?.visible)
                ) {
                    doc.setFont(printConfig?.Receipt?.PaymentReference?.fontFamily);
                    doc.setFontSize(printConfig?.Receipt?.PaymentReference?.fontSize);
                    doc.setTextColor(printConfig?.Receipt?.PaymentReference?.fontColor);
                    doc.text(v.ref_info.toString().trim(), x + 5, y);
                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                    y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });
                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                }

                if (printConfig?.Receipt?.PaymentTerminalInfo?.visible) {
                    doc.setFont(printConfig?.Receipt?.PaymentTerminalInfo?.fontFamily);
                    doc.setFontSize(printConfig?.Receipt?.PaymentTerminalInfo?.fontSize);
                    doc.setTextColor(printConfig?.Receipt?.PaymentTerminalInfo?.fontColor);

                    var sales_other_info = order?.sales_other_info;
                    if (sales_other_info) {
                        // FOMO QR
                        if (
                            bool(getSetting("MORE", "PAYMENT", "QR_FOMO")) &&
                            same(v.payment_name, getSetting("OTHERS", "FOMO_QR", "fomo_qr_payment_name"))
                        ) {
                            // todo - fomo qr
                        }
                        // Shopback QR
                        else if (
                            bool(getSetting("MORE", "PAYMENT", "QR_SHOPBACK")) &&
                            same(v.payment_name, getSetting("OTHERS", "SHOPBACK_QR", "shopback_qr_payment_name"))
                        ) {
                            // todo - shopback qr
                        }
                        // NETS QR
                        else if (
                            bool(getSetting("MORE", "PAYMENT", "QR_NETS")) &&
                            same(v.payment_name, getSetting("OTHERS", "NETS_QR", "nets_qr_payment_name"))
                        ) {
                            var info_value = sales_other_info.find((oi) => oi.info_name === v.payment_name.toString());
                            if (info_value) {
                                info_value = JSON.parse(info_value?.info_value)[0];

                                doc.setFont(printConfig?.Receipt?.DashDivider?.fontFamily);
                                doc.setFontSize(printConfig?.Receipt?.DashDivider?.fontSize);
                                doc.setTextColor(printConfig?.Receipt?.DashDivider?.fontColor);
                                doc.text(printConfig?.Receipt?.DashDivider?.label, x, y);
                                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                doc.setFont(printConfig?.Receipt?.PaymentInfo?.fontFamily);
                                doc.setFontSize(printConfig?.Receipt?.PaymentInfo?.fontSize);
                                doc.setTextColor(printConfig?.Receipt?.PaymentInfo?.fontColor);
                                doc.text(`${v.payment_name.toString().toUpperCase()} ${printConfig?.Receipt?.PaymentInfo?.label}`, x, y);
                                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                doc.text(`MID : ${info_value.host_mid}`, x, y);
                                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                doc.text(`TID : ${info_value.host_tid}`, x, y);
                                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                doc.text(`STAN : ${info_value.stan}`, x, y);
                                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                doc.text(`Date : ${info_value.transaction_date} ${info_value.transaction_time}`, x, y);
                                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                doc.setFont(printConfig?.Receipt?.DashDivider?.fontFamily);
                                doc.setFontSize(printConfig?.Receipt?.DashDivider?.fontSize);
                                doc.setTextColor(printConfig?.Receipt?.DashDivider?.fontColor);
                                doc.text(printConfig?.Receipt?.DashDivider?.label, x, y);
                                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });
                            }
                        }
                        // Card Payment (A930 / NETS / Credit Card)
                        else {
                            var info_value = sales_other_info.find((oi) => same(oi.info_name, v.payment_name.toString() + v.s_no));


                            console.log('💳 [PaymentInfo] lookup:', {
                                looking_for: v.payment_name.toString() + v.s_no,
                                sales_other_info_keys: sales_other_info.map(oi => oi.info_name),
                                found: !!info_value
                            });

                            if (!info_value) {
                                info_value = sales_other_info.find((oi) => same(oi.info_name, v.payment_name.toString() + (v.s_no - 1)));
                            }

                            // Fallback 2: info_name starts with payment_name (e.g. "Mastercard0" vs "MASTER")
                            if (!info_value) {
                                info_value = sales_other_info.find((oi) =>
                                    oi.info_name?.toString().toLowerCase().startsWith(v.payment_name.toString().toLowerCase()) ||
                                    v.payment_name.toString().toLowerCase().startsWith(oi.info_name?.toString().toLowerCase().replace(/\d+$/, ''))
                                );
                            }

                            if (info_value) {
                                info_value = JSON.parse(info_value?.info_value)[0];

                                var A930_info = "";
                                if (info_value.responce_info) {
                                    A930_info = info_value.responce_info.split("\r\n");
                                }

                                // A930
                                if (bool(getSetting("MORE", "PAYMENT", "ECR_A930")) && A930_info.length === 14) {
                                    doc.text("Card Payment Info :", x, y);
                                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                    y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                    for (var r = 0; r < A930_info.length; r++) {
                                        if (A930_info[r] != "" && r != 0 && r != 1 && r != 2) {
                                            doc.text(A930_info[r], x + 4, y);
                                            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                            y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });
                                        }
                                    }

                                    doc.setFont(printConfig?.Receipt?.DashDivider?.fontFamily);
                                    doc.setFontSize(printConfig?.Receipt?.DashDivider?.fontSize);
                                    doc.setTextColor(printConfig?.Receipt?.DashDivider?.fontColor);
                                    doc.text(printConfig?.Receipt?.DashDivider?.label, x, y);
                                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                    y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });
                                }
                                // NETS
                                else if (contains(v.payment_name, "NETS")) {
                                    info_value = stripControlChars(info_value, { replacement: " " });

                                    if (info_value?.approvalCode) {
                                        doc.setFont(printConfig?.Receipt?.DashDivider?.fontFamily);
                                        doc.setFontSize(printConfig?.Receipt?.DashDivider?.fontSize);
                                        doc.setTextColor(printConfig?.Receipt?.DashDivider?.fontColor);
                                        doc.text(printConfig?.Receipt?.DashDivider?.label, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(printConfig?.Receipt?.PaymentInfo?.label, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`Approval Code : ${info_value?.approvalCode?.trim()?.split(/\s+/)?.at(-1) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`Merchant ID : ${info_value?.merchantID?.trim()?.split(/\s+/)?.at(-2) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`Response : ${info_value?.responseDesc || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`Terminal ID : ${info_value?.terminalID?.trim()?.split(/\s+/)?.at(-1) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`Purchase Amt : ${(parseFloat(info_value?.transactionAmount?.trim()?.split(/\s+/)?.at(-1) || "") / 100).toFixed(2)}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`Date : ${info_value?.transactionDate?.trim()?.split(/\s+/)?.at(-1) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`STAN : ${info_value?.stan?.trim()?.split(/\s+/)?.at(-1) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`Time : ${info_value?.transactionTime?.trim()?.split(/\s+/)?.at(-1) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`Card Name : ${info_value?.cardName?.trim()?.split(/\s+/)?.at(-1) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.setFont(printConfig?.Receipt?.DashDivider?.fontFamily);
                                        doc.setFontSize(printConfig?.Receipt?.DashDivider?.fontSize);
                                        doc.setTextColor(printConfig?.Receipt?.DashDivider?.fontColor);
                                        doc.text(printConfig?.Receipt?.DashDivider?.label, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });
                                    }
                                }
                                // Credit Card
                                else {
                                    info_value = stripControlChars(info_value, { replacement: " " });
                                    console.log(info_value);

                                    if (info_value?.approvalCode_Raw) {
                                        doc.setFont(printConfig?.Receipt?.DashDivider?.fontFamily);
                                        doc.setFontSize(printConfig?.Receipt?.DashDivider?.fontSize);
                                        doc.setTextColor(printConfig?.Receipt?.DashDivider?.fontColor);
                                        doc.text(printConfig?.Receipt?.DashDivider?.label, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(printConfig?.Receipt?.PaymentInfo?.label, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`Approval Code : ${info_value?.approvalCode_Raw?.trim()?.split(/\s+/)?.at(-1) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`Batch Number : ${info_value?.batchNumber_Raw?.trim()?.split(/\s+/)?.at(-1) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`CAN Number : ${info_value?.cardNumber_Raw?.trim()?.split(/\s+/)?.at(-1)?.slice(-4) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`Invoice Number : ${info_value?.invoiceNumber_Raw?.trim()?.split(/\s+/)?.at(-1) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`Merchant ID : ${info_value?.merchantID_Raw?.trim()?.split(/\s+/)?.at(-1) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`RRN : ${info_value?.rrN_Raw?.trim()?.split(/\s+/)?.at(-1) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`Terminal ID : ${info_value?.terminalID_Raw?.trim()?.split(/\s+/)?.at(-1) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`Date : ${info_value?.transactionDate_Raw?.trim()?.split(/\s+/)?.at(-1) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        doc.text(`Time : ${info_value?.transactionTime_Raw?.trim()?.split(/\s+/)?.at(-1) || ""}`, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });

                                        // TVR — only print if exists
                                        if (info_value?.tvr && info_value.tvr.toString().trim().length > 0) {
                                            doc.text(`TVR(EMV) : ${info_value.tvr.toString().trim()}`, x, y);
                                            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                            y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });
                                        }

                                        // Entry Type — only print if exists
                                        var entryTypeVal = info_value?.entryType_Raw?.toString()?.trim() ||
                                            info_value?.entryType?.toString()?.trim() || '';
                                        if (entryTypeVal.length > 0) {
                                            doc.text(`Entry Type: ${entryTypeVal}`, x, y);
                                            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                            y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });
                                        }

                                        // Issuer Name — fallback chain
                                        var issuerVal = info_value?.issuerName_Raw?.toString()?.trim() ||
                                            info_value?.issuerName?.toString()?.trim() ||
                                            info_value?.card_name?.toString()?.trim() ||
                                            info_value?.cardName?.toString()?.trim() || '';
                                        if (issuerVal.length > 0) {
                                            doc.text(`Issuer Name: ${issuerVal}`, x, y);
                                            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                            y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });
                                        }

                                        doc.setFont(printConfig?.Receipt?.DashDivider?.fontFamily);
                                        doc.setFontSize(printConfig?.Receipt?.DashDivider?.fontSize);
                                        doc.setTextColor(printConfig?.Receipt?.DashDivider?.fontColor);
                                        doc.text(printConfig?.Receipt?.DashDivider?.label, x, y);
                                        if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                                        y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });
                                    }
                                }
                            }
                        }
                    }
                }
            });

            // Change
            if (printConfig?.isdefault === true || printConfig?.Receipt?.Change?.visible === true) {
                doc.setFont(printConfig?.Receipt?.Change?.fontFamily);
                doc.setFontSize(printConfig?.Receipt?.Change?.fontSize);
                doc.setTextColor(printConfig?.Receipt?.Change?.fontColor);
                doc.text(printConfig?.Receipt?.Change?.label, x, y);
                doc.text(order?.change_amt?.toFixed(2), Amount_X, y, { align: "right" });
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                y = jspdfGetNextLineY(doc, y, { pageHeight, resetY: printConfig?.Receipt?.y });
            }
        } else if (printConfig?.isdefault || printConfig?.Receipt?.PrintDraft?.visible) {
            doc.setFont(printConfig?.Receipt?.PrintDraft.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.PrintDraft.fontSize);
            doc.setTextColor(printConfig?.Receipt?.PrintDraft.fontColor);
            doc.text(
                `${printConfig?.Receipt?.PrintDraft.label}${same(type, RECEIPT_PRINT_TYPE.SPLIT_PAYMENT) ? ` (${index})` : ""}`,
                maxWidth / 2, y, { align: "center" }
            );
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y = jspdfGetNextLineY(doc, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
        }

        // ── Split Bill ────────────────────────────────────────────────────────
        if (same(type, RECEIPT_PRINT_TYPE.SPLIT_PAYMENT) && (printConfig?.isdefault || printConfig?.Receipt?.AmountDueforPax?.visible)) {
            doc.setFont(NOTO_FONT.BLACK);
            doc.setFontSize(printConfig?.Receipt?.AmountDueforPax.fontSize);
            doc.setTextColor(printConfig?.Receipt?.AmountDueforPax.fontColor);
            doc.text(printConfig?.Receipt?.AmountDueforPax.label + index, x, y);
            // ✅ Right-aligned to Amount_X
            doc.text(parseFloat(order?.net_amt).toFixed(2), Amount_X, y, { align: "right" });
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y = jspdfGetNextLineY(doc, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
        }

        // ── Auto Done Kitchen Status ──────────────────────────────────────────
        if (
            bool(getSetting("GENERAL SETTINGS", "ORDERING", "ENABLE_AUTO_DONE_WHEN_PRINT_DRAFT_PRINTED")) &&
            status !== "Void" &&
            !same(type, RECEIPT_PRINT_TYPE.QR)
        ) {
            try {
                const res = await fetch('/API/printer/posorderkitchenother/update', {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        ...order,
                        update_for: "KITCHEN_STATUS",
                        kitchen_status_id: "P",
                        kitchen_status_desc: "In Progress",
                    }),
                });
                if (res.ok) {
                    const json = await res.json();
                    console.log(`[ORDER - UPDATE KITCHEN STATUS] [${json?.message?.toUpperCase()}] ${json?.data?.[0]?.information} | id: ${order?.sales_no}`);
                }
            } catch (e) {
                console.error('❌ Kitchen STATUS UPDATE failed:', e);
            }
        }

        // ── Change Payment History ────────────────────────────────────────────
        if (
            order.sales_change_payment_dtls?.length > 0 &&
            (printConfig?.isdefault || printConfig?.Receipt?.ChangePaymentHistory?.visible)
        ) {
            doc.setFont(printConfig?.Receipt?.ChangePaymentHistory.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.ChangePaymentHistory.fontSize);
            doc.setTextColor(printConfig?.Receipt?.ChangePaymentHistory.fontColor);
            doc.text(printConfig?.Receipt?.ChangePaymentHistory.label, x, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y = jspdfGetNextLineY(doc, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }

            order.sales_change_payment_dtls.forEach((v) => {
                doc.text(v.payment_name.toString().trim(), x, y);
                // ✅ Right-aligned to Amount_X
                doc.text(`-${v.tender_amt.toFixed(2)}`, Amount_X, y, { align: "right" });
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                y = jspdfGetNextLineY(doc, y);
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            });
        }

        // ── Date & Time ───────────────────────────────────────────────────────
        if (printConfig?.Receipt?.DateTime?.visible) {
            doc.setFont(printConfig?.Receipt?.DateTime.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.DateTime.fontSize);
            doc.setTextColor(printConfig?.Receipt?.DateTime.fontColor);
            doc.text(printConfig?.Receipt?.DateTime.label + date, x, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y = jspdfGetNextLineY(doc, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
        }

        // ── Cashier ───────────────────────────────────────────────────────────
        if (printConfig?.Receipt?.Cashier?.visible) {
            doc.setFont(printConfig?.Receipt?.Cashier.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.Cashier.fontSize);
            doc.setTextColor(printConfig?.Receipt?.Cashier.fontColor);
            doc.text(`${printConfig?.Receipt?.Cashier.label} ${order?.c_userid}`, x, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y = jspdfGetNextLineY(doc, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
        }

        // ── Signature ─────────────────────────────────────────────────────────
        if (bool(getSetting("PRINT SETTINGS", "RECEIPT", "show_signature_onreceipt")) && printConfig?.Receipt?.Signature?.visible) {
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y += printConfig?.Receipt?.EmptyLine;
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            doc.setFont(printConfig?.Receipt?.Signature.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.Signature.fontSize);
            doc.setTextColor(printConfig?.Receipt?.Signature.fontColor);
            doc.text(`${printConfig?.Receipt?.Signature.label} ${order?.c_userid}`, x, y);
        }

        // ── Thank You ─────────────────────────────────────────────────────────
        if (bool(getSetting("PRINT SETTINGS", "RECEIPT", "show_footer_onreceipt"))) {
            if (printConfig?.isdefault || printConfig?.Receipt?.ThankYou?.visible) {
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                y += printConfig?.Receipt?.EmptyLine;
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                doc.setFont(printConfig?.Receipt?.ThankYou.fontFamily);
                doc.setFontSize(printConfig?.Receipt?.ThankYou.fontSize);
                doc.setTextColor(printConfig?.Receipt?.ThankYou.fontColor);
                doc.text(printConfig?.Receipt?.ThankYou.label, maxWidth / 2, y, { align: "center" });
                y = jspdfGetNextLineY(doc, y);
            }
        }
        y = jspdfGetNextLineY(doc, y);

        // ── Star Divider (footer) ─────────────────────────────────────────────
        doc.setFont(printConfig?.Receipt?.StarDivider.fontFamily);
        doc.setFontSize(printConfig?.Receipt?.StarDivider.fontSize);
        doc.setTextColor(printConfig?.Receipt?.StarDivider.fontColor);
        doc.text(printConfig?.Receipt?.StarDivider.label, x, y);

        // ── OtherInformation ─────────────────────────────────────────────────
        const memberInfo = useCache()?.memberInfo || null;
        if (memberInfo) {
            if (printConfig?.isdefault || printConfig?.Receipt?.OtherInformation?.visible) {
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                y += printConfig?.Receipt?.EmptyLine ?? 3;
                doc.setFont(printConfig?.Receipt?.OtherInformation.fontFamily);
                doc.setFontSize(printConfig?.Receipt?.OtherInformation.fontSize);
                doc.setTextColor(printConfig?.Receipt?.OtherInformation.fontColor);
                doc.text(printConfig?.Receipt?.OtherInformation.label, x, y);
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                y += printConfig?.Receipt?.EmptyLine ?? 3;
                const rawName = order?.customer?.name || memberInfo?.name || '';
                const customer = {
                    name: rawName.replace(/\s*-\s*-?\s*$/, '').trim(),
                    contact_no: order?.customer?.contact_no || memberInfo?.contact_no || memberInfo?.phone || '',
                    card_no: order?.customer?.card_no || memberInfo?.card_no || '',
                    email: order?.customer?.email || memberInfo?.email || '',
                    address: order?.customer?.address || '',
                };
                const printOtherInfoLine = (subConfig, text) => {
                    if (!text || !(printConfig?.isdefault || subConfig?.visible)) return;
                    doc.setFont(subConfig.fontFamily);
                    doc.setFontSize(subConfig.fontSize);
                    doc.setTextColor(subConfig.fontColor);
                    const fullText = subConfig.label + text;
                    const maxWidth = printConfig?.Receipt?.pageWidth
                        ? printConfig.Receipt.pageWidth - (x * 2)
                        : 80;
                    const lines = doc.splitTextToSize(fullText, maxWidth);
                    doc.text(lines, x, y);
                    const lineHeight = printConfig?.Receipt?.EmptyLine ?? 3;
                    y += lineHeight * lines.length; // ✅ y advanced directly, no yRef needed
                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                };
                const oi = printConfig?.Receipt?.OtherInformation;
                printOtherInfoLine(oi?.CustomerName, customer?.name);
                if (customer?.contact_no) {
                    const maskedPhone = "x".repeat(6) + customer.contact_no.slice(-4);
                    printOtherInfoLine(oi?.ContactNo, maskedPhone);
                }
                printOtherInfoLine(oi?.CardNo, customer?.card_no);
                printOtherInfoLine(oi?.Email, customer?.email);
                printOtherInfoLine(oi?.Address, customer?.address);
                if (printConfig?.isdefault || oi?.ModeOfOrder?.visible) {
                    doc.setFont(oi?.ModeOfOrder.fontFamily);
                    doc.setFontSize(oi?.ModeOfOrder.fontSize);
                    doc.setTextColor(oi?.ModeOfOrder.fontColor);
                    doc.text(oi?.ModeOfOrder.label, x, y);
                    y += printConfig?.Receipt?.EmptyLine ?? 3; // ✅ advance past ModeOfOrder line
                    if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                }
                printOtherInfoLine(oi?.Remarks, order?.ref_2);
                if (order?.ref_3 && order?.ref_1?.toUpperCase().includes("DELI")) {
                    printOtherInfoLine(oi?.DeliveryDateTime, order?.ref_3);
                }
                if (order?.ref_1?.toUpperCase().includes("TAKE")) {
                    const pickupTime = (order?.ref_4 && order?.ref_4 !== 'undefined' && order?.ref_4 !== 'null')
                        ? order?.ref_4 : null;
                    printOtherInfoLine(oi?.PickupDateTime, pickupTime);
                }
                printOtherInfoLine(oi?.OrderRefNo, order?.ref_5);
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; } // ✅ guard before divider
                doc.setFont(printConfig?.Receipt?.StarDivider.fontFamily);
                doc.setFontSize(printConfig?.Receipt?.StarDivider.fontSize);
                doc.setTextColor(printConfig?.Receipt?.StarDivider.fontColor);
                doc.text(printConfig?.Receipt?.StarDivider.label, x, y);
                y += printConfig?.Receipt?.EmptyLine ?? 3; // ✅ advance past star divider so next section doesn't overlap
            }
        }

        // ── Agreement ─────────────────────────────────────────────────────────
        const agreementText = (getSetting("PRINT SETTINGS", "AGREEMENT", "AGREEMENT_HEADER") ?? "").replaceAll("|n", "\n");
        const consumerProtectionText = (getSetting("PRINT SETTINGS", "AGREEMENT", "CONSUMER_PROTECTION_TEXT") ?? "").replaceAll("|n", "\n");

        if (
            agreementText?.length > 0 &&
            bool(getSetting("PRINT SETTINGS", "AGREEMENT", "PRINT_AGREEMENT_ON_RECEIPT_FOOTER")) &&
            (printConfig?.isdefault || printConfig?.Receipt?.Agreement?.visible)
        ) {
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y = jspdfGetNextLineY(doc, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }

            doc.setFont(printConfig?.Receipt?.Agreement.fontFamily);
            doc.setFontSize(printConfig?.Receipt?.Agreement.fontSize);
            doc.setTextColor(printConfig?.Receipt?.Agreement.fontColor);
            doc.text(agreementText, x, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y = jspdfGetNextLineY(doc, y);
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            y += printConfig?.Receipt?.EmptyLine;
            if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }

            if (printConfig?.isdefault || printConfig?.Receipt?.ConsumerProtection?.visible) {
                doc.setFont(printConfig?.Receipt?.ConsumerProtection.fontFamily);
                doc.setFontSize(printConfig?.Receipt?.ConsumerProtection.fontSize);
                doc.setTextColor(printConfig?.Receipt?.ConsumerProtection.fontColor);
                doc.text(consumerProtectionText, x, y);
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
                y = jspdfGetNextLineY(doc, y);
                if (y >= pageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            }
        }

        // ── Footer Image ──────────────────────────────────────────────────────
        if (printConfig?.Receipt?.FooterImage?.visible && footerImg) {
            const imageHeight = 30;
            if (pageHeight - y < imageHeight) { doc.addPage(); y = printConfig?.Receipt?.y; }
            doc.addImage(footerImg, "PNG", 0, y, maxWidth, imageHeight);
            y += imageHeight;
            console.log('✅ Receipt footer image added');
        }

        // ── Output ────────────────────────────────────────────────────────────
        if (same(type, RECEIPT_PRINT_TYPE.EMAIL)) {
            if (order?.customer_code) {
                const Attachfile = doc.output("blob");
                const customerEmail = order?.customer?.email;
                if (customerEmail) {
                    await sendEmail(
                        Attachfile, "Receipt.pdf", customerEmail,
                        `${store_name} - Receipt - ${date?.replace(/\//g, "-")}`,
                        `Dear ${order?.customer?.name}, Please find the attached documents for your reference. Thank you!`
                    );
                    console.log(`[ORDER - ${type} - RECEIPT PRINTING] [SUCCESS] Receipt emailed | id: ${order?.sales_no}`);
                }
            }
        } else if (same(type, RECEIPT_PRINT_TYPE.QR)) {
            const pdf = doc.output("blob");
            const img = document.getElementById("pdf_url");
            const url = window.URL || window.webkitURL;
            img.src = url.createObjectURL(pdf) + "#toolbar=0&navpanes=0&scrollbar=0&zoom=100";
        } else if (same(type, RECEIPT_PRINT_TYPE.VIEW)) {
            const pdf = doc.output("blob");
            return `${URL.createObjectURL(pdf)}#toolbar=0&navpanes=0&scrollbar=0&zoom=100`;
        } else {
            const pdf = doc.output("blob");
            const pdfName = `EvolutPOS_${printerName}_${timestamp()}_${index}${isDuplicatedReceipt ? "_Duplicate" : ""}${sales_no ? `_${sales_no}` : ""}_Receipt.pdf`;
            const printOption = getSetting("MORE", "GENERAL", "PRINT_OPTION");
            console.log('🖨️ [receiptPrint] PRINT_OPTION:', printOption, '| match:', same(printOption, PRINT_SERVICE.PRINT));
            const arr = new Uint8Array(await pdf.arrayBuffer());
            console.log('🔍 PDF header:', arr[0], arr[1], arr[2], arr[3]);
            print(pdf, printerName, pdfName, false, true)
                .then(() => console.log(`[ORDER - ${type} - RECEIPT PRINTING] [SUCCESS] Receipt printed | id: ${order?.sales_no}`))
                .catch((e) => console.error(`[ORDER - ${type} - RECEIPT PRINTING] [FAIL] Print send failed | id: ${order?.sales_no}`, e));
            //doc.save(pdfName);
        }

    } catch (error) {
        console.error(`[ORDER - ${type} - RECEIPT PRINTING] [FAIL] Receipt printing failed | id: ${order?.sales_no}`, error);
    }
};

// ─── Printer name cache ───────────────────────────────────────────────────────
let _cachedPrinterName = null;

const _resolvePrinterName = () => {
    if (_cachedPrinterName) return _cachedPrinterName;

    const { printConfig } = useCache();
    let printerName = printConfig?.Label_Printer_name;

    if (!printerName) {
        const storeSettings =
            useCache()?.storeRegisterSettings ||
            JSON.parse(localStorage.getItem('storeRegisterSettings') || '[]');

        if (Array.isArray(storeSettings)) {
            outer: for (const group of storeSettings) {
                if (!group.HARDWARE || !Array.isArray(group.HARDWARE)) continue;
                for (const hw of group.HARDWARE) {
                    if (hw.Label_Printer_name) {
                        printerName = hw.Label_Printer_name;
                        break outer;
                    }
                    if (Array.isArray(hw.HARDWARE)) {
                        const sub = hw.HARDWARE.find(s => s.Label_Printer_name);
                        if (sub) {
                            printerName = sub.Label_Printer_name;
                            break outer;
                        }
                    }
                }
            }
        }
    }

    if (!printerName) {
        printerName = getSetting('HARDWARE', 'HARDWARE', 'Label_Printer_name');
    }

    _cachedPrinterName = printerName || null;
    return _cachedPrinterName;
};


export const labelPrint = async (type, data) => {
    const order = clone(data[0]);

    try {
        const { items, printConfig } = useCache();

        const printerName = _resolvePrinterName();
        if (!printerName) return;

        const sales_dtls = (order?.sales_dtls ?? []).filter(
            (v) => parseFloat(v.sub_total) >= 0
        );

        const payload = [];

        const parentOrderItem = sales_dtls.filter((v) => v.ds_no === 1)[0];
        const isComboParent = same(parentOrderItem?.menu_type, "C");

        // ds_no:2 is the size variant row (ref item)
        const sizeVariantRow = isComboParent
            ? sales_dtls.find((v) => v.ds_no === 2 && v.parent_sno === parentOrderItem.s_no)
            : null;

        const parentQty = Math.max(
            1,
            Math.floor(Number(parentOrderItem.qty) || 1)
        );

        // Base shot_name and upc from size variant if combo, else from parent
        let base_shot_name = sizeVariantRow
            ? String(sizeVariantRow.shot_name ?? sizeVariantRow.item_desc ?? "").trim()
            : String(parentOrderItem.shot_name ?? parentOrderItem.item_desc ?? "").trim();

        let base_upc_no = sizeVariantRow?.barcode || parentOrderItem?.barcode || "";
        let base_size = sizeVariantRow
            ? getRefItemPrefix(sizeVariantRow.item_name)
            : "";

        // Children = ds_no > 1, excluding the size variant row (ds_no:2 for combo)
        const childrenRaw = [...sales_dtls]
            .filter(
                (v) =>
                    v.parent_sno === parentOrderItem.s_no &&
                    v.ds_no !== 1 &&
                    !(isComboParent && v.ds_no === 2)
            )
            .sort(
                (a, b) =>
                    (a.s_no ?? 0) - (b.s_no ?? 0) ||
                    (a.ds_no ?? 0) - (b.ds_no ?? 0)
            );

        const expandedChildren = [];
        for (const child of childrenRaw) {
            const childQty = Math.max(1, Math.floor(Number(child.qty) || 1));
            for (let i = 0; i < childQty; i++) {
                const c = clone(child);
                c.qty = 1;
                c.original_qty = child.qty;
                expandedChildren.push(c);
            }
        }

        for (let slotIndex = 0; slotIndex < parentQty; slotIndex++) {
            const slotChildren = expandedChildren.filter(
                (_, idx) => idx % parentQty === slotIndex
            );

            const child_items = slotChildren
                .map((c) => ({
                    item_no: c.item_no,
                    item_name: c.item_name,
                    shot_name: String(c.shot_name ?? c.item_desc ?? "").trim(),
                    upc_no: c.barcode || "",
                    category_code: c.category_code,
                    modifier_name: c.modifier_name,
                    ds_no: c.ds_no,
                }))
                .filter((c) => c.shot_name);

            payload.push({
                shot_name: base_shot_name,
                upc_no: base_upc_no,
                child_items,
                size: base_size,
            });
        }

        const order_no = order.sales_no?.substring(16, 19)?.trim() ?? "";
        const order_no_display = (order.sales_no?.startsWith("SAL-SOK") ? "SK-" : "LiHO ") + order_no;
        const store_name = order.store_name ?? "";

        let order_type = "SOK";
        let order_ref_no = "";
        if (order.ref_5 !== "" && order.sales_no?.startsWith("SAL-TQR")) {
            order_ref_no = "#" + order.ref_5;
            order_type = "APP";
        } else if (order.ref_5 !== "" && order.sales_no?.startsWith("SAL-GRF")) {
            order_ref_no = "#" + order.ref_5;
            order_type = "GRABFOOD";
        }

        const doc_date = dayjs(order.doc_date).format("DD/MM/YYYY HH:mm:ss");

        for (const [
            index,
            { shot_name: lbl_shot_name, upc_no: lbl_upc_no, child_items: lbl_child_items, size: lbl_size },
        ] of payload.entries()) {
            const shot_name = lbl_shot_name;
            const upc_no = lbl_upc_no;
            const child_items = lbl_child_items;
            const size = lbl_size;

            const doc = await newPDF({
                orientation: "portrait",
                unit: "mm",
                format: [50, 70],
                noCjkPatch: true,
                defaultFont: "SourceSansPro-Regular",
                compress: false,
            });

            let x = printConfig?.Label?.x;
            let y = printConfig?.Label?.y;
            let maxWidth = printConfig?.Label?.maxWidth;

            const printWrapText = (text, fontFamily, fontSize) => {
                if (fontFamily) doc.setFont(fontFamily);
                if (fontSize) doc.setFontSize(fontSize);
                const split = doc.splitTextToSize(text ?? "", maxWidth);
                split.forEach((line) => {
                    doc.text(line, x, y);
                    y += printConfig?.Label?.EmptyLine;
                });
            };

            // Order No
            if (printConfig?.Label?.OrderNo?.visible && order_no) {
                doc.setFont(printConfig?.Label?.OrderNo?.fontFamily);
                doc.setFontSize(printConfig?.Label?.OrderNo?.fontSize);
                doc.setTextColor(printConfig?.Label?.OrderNo?.fontColor);
                doc.text(order_no_display, x, y);
            }

            // Count Check
            if (printConfig?.Label?.CountCheck?.visible) {
                doc.setFont(printConfig?.Label?.CountCheck?.fontFamily);
                doc.setFontSize(printConfig?.Label?.CountCheck?.fontSize);
                doc.setTextColor(printConfig?.Label?.CountCheck?.fontColor);
                const globalIndex = (order._label_index ?? 0) + index;
                const globalTotal = order._label_total ?? payload.length;
                doc.text(globalIndex + 1 + "/" + globalTotal, maxWidth, y, {
                    align: "right",
                });
                y += printConfig?.Label?.EmptyLine;
            }

            // Divider
            if (printConfig?.Label?.Divider?.visible) {
                doc.setFont(printConfig?.Label?.Divider?.fontFamily);
                doc.setFontSize(printConfig?.Label?.Divider?.fontSize);
                doc.setTextColor(printConfig?.Label?.Divider?.fontColor);
                doc.text(printConfig?.Label?.Divider?.label, x, y);
                y += printConfig?.Label?.EmptyLine;
            }

            // UPC No
            if (printConfig?.Label?.UpcNo?.visible && upc_no) {
                doc.setTextColor(printConfig?.Label?.UpcNo?.fontColor);
                printWrapText(
                    `[${upc_no}]`,
                    printConfig?.Label?.UpcNo?.fontFamily,
                    printConfig?.Label?.UpcNo?.fontSize
                );
            }

            // Parent Item
            if (printConfig?.Label?.ParentItem?.visible && shot_name) {
                doc.setTextColor(printConfig?.Label?.ParentItem?.fontColor);
                printWrapText(
                    shot_name,
                    printConfig?.Label?.ParentItem?.fontFamily,
                    printConfig?.Label?.ParentItem?.fontSize
                );
            }

            // Child Items
            if (printConfig?.Label?.ChildItem?.visible && child_items?.length > 0) {
                y += printConfig?.Label?.EmptyLine;

                const groupedChildItems = (() => {
                    const m = new Map();
                    (child_items ?? []).forEach((c) => {
                        const desc = String(c?.shot_name ?? "").trim();
                        if (!desc) return;

                        const key = [
                            String(c?.item_no ?? ""),
                            String(c?.modifier_name ?? ""),
                            String(c?.category_code ?? ""),
                            desc,
                        ].join("|");

                        const existing = m.get(key);
                        if (existing) {
                            existing.qty += 1;
                            return;
                        }

                        m.set(key, {
                            qty: 1,
                            shot_name: desc,
                            item_no: c?.item_no,
                            upc_no: c?.upc_no,
                        });
                    });
                    return Array.from(m.values());
                })();

                groupedChildItems.forEach(({ shot_name, qty }) => {
                    const line = qty > 1 ? `${qty}* ${shot_name}` : shot_name;
                    if (line) {
                        doc.setTextColor(printConfig?.Label?.ChildItem?.fontColor);
                        printWrapText(
                            line,
                            printConfig?.Label?.ChildItem?.fontFamily,
                            printConfig?.Label?.ChildItem?.fontSize
                        );
                    }
                });
            }

            // Footer — start at FooterY minimum
            y = Math.max(y, printConfig?.Label?.FooterY);

            // Store Name
            if (printConfig?.Label?.StoreName?.visible && store_name) {
                y += printConfig?.Label?.EmptyLine;
                doc.setFont(printConfig?.Label?.StoreName?.fontFamily);
                doc.setFontSize(printConfig?.Label?.StoreName?.fontSize);
                doc.setTextColor(printConfig?.Label?.StoreName?.fontColor);
                doc.text(store_name, x, y);
                y += printConfig?.Label?.EmptyLine;
            }

            // Order Type
            if (printConfig?.Label?.OrderType?.visible && order_type) {
                doc.setFont(printConfig?.Label?.OrderType?.fontFamily);
                doc.setFontSize(printConfig?.Label?.OrderType?.fontSize);
                doc.setTextColor(printConfig?.Label?.OrderType?.fontColor);
                doc.text(order_type, x, y);
            }

            // Order Ref No
            if (printConfig?.Label?.OrderRefNo?.visible && order_ref_no) {
                doc.setFont(printConfig?.Label?.OrderRefNo?.fontFamily);
                doc.setFontSize(printConfig?.Label?.OrderRefNo?.fontSize);
                doc.setTextColor(printConfig?.Label?.OrderRefNo?.fontColor);
                doc.text(order_ref_no, printConfig?.Label?.QRCode?.x, y, {
                    align: "right",
                });
            }

            // Date Time
            if (printConfig?.Label?.DateTime?.visible && doc_date) {
                y += printConfig?.Label?.EmptyLine;
                doc.setFont(printConfig?.Label?.DateTime?.fontFamily);
                doc.setFontSize(printConfig?.Label?.DateTime?.fontSize);
                doc.setTextColor(printConfig?.Label?.DateTime?.fontColor);
                doc.text(doc_date, x, y);
                y += printConfig?.Label?.EmptyLine;
            }

            // QR Code
            const qrPayload =
                order_no_display +
                "|" +
                upc_no?.replaceAll("No.", "") +
                "|" +
                size +
                (child_items?.length > 0
                    ? "," + child_items?.map((c) => c?.upc_no?.replaceAll("No.", "")).join(",")
                    : "") +
                "|";

            if (printConfig?.Label?.QRCode?.visible) {
                const qrDataUrl = await QRCode.toDataURL(qrPayload, {
                    errorCorrectionLevel: "L",
                    type: "image/png",
                    margin: 0.3,
                });
                doc.addImage(
                    qrDataUrl,
                    "PNG",
                    printConfig?.Label?.QRCode?.x,
                    printConfig?.Label?.QRCode?.y,
                    printConfig?.Label?.QRCode?.w,
                    printConfig?.Label?.QRCode?.h
                );
            }

            const pdf = doc.output("blob");
            const pdfName = `EvolutPOS_${printerName}_${timestamp()}_Label.pdf`;

            await print(pdf, printerName, pdfName, false, false);
            //doc.save(pdfName);
        }
    } catch (error) {
        console.error(`Fail to print label for ${order?.sales_no}`, error);
    }
};