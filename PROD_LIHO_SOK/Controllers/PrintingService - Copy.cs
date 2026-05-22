//// ── ALL USINGS AT TOP ──────────────────────────────────────────────────────
//using PROD_LIHO_SOK.Models;
//using PROD_LIHO_SOK.Services;
//using Microsoft.AspNetCore.Http;
//using Microsoft.AspNetCore.Mvc;
//using Microsoft.Extensions.Caching.Memory;
//using Microsoft.Extensions.Configuration;
//using Microsoft.Extensions.Logging;
//using PdfiumViewer;                     // replaces PDFtoImage + SkiaSharp
//using RawPrint;
//using RawPrint.NetStd;
//using System;
//using System.Collections.Generic;
//using System.Drawing;
//using System.Drawing.Printing;
//using System.IO;
//using System.Linq;
//using System.Net.Http;
//using System.Text;
//using System.Text.Json;
//using System.Threading.Tasks;
//using SixLabors.ImageSharp.Processing;

//// REMOVED: using SkiaSharp;
//// REMOVED: using PDFtoImage;
//// REMOVED: using ESCPOS.NET;
//// REMOVED: using ESCPOS.NET.Emitters;

//// ═══════════════════════════════════════════════════════════════════════════════
//// NuGet packages required:
////   PdfiumViewer          (wraps pdfium.dll — handles CJK fonts natively)
////   PdfiumViewer.Native.x86_x64.v8-xfa  (or the plain pdfium native)
////   RawPrint / RawPrint.NetStd
////
//// REMOVED packages (can be uninstalled):
////   PDFtoImage
////   SkiaSharp
////   SkiaSharp.NativeAssets.Linux / Win
////   ESCPOS.NET  (only if you added it previously)
//// ═══════════════════════════════════════════════════════════════════════════════

//namespace PROD_LIHO_SOK.Services
//{
//    public enum KitchenStatus { Done, Close }

//    public interface IPrinterService
//    {
//        Task<bool> PrintAsync(string printerName, byte[] fileData, string fileName, bool rotate);
//        Task<bool> OpenCashDrawerAsync(string printerName);
//        Task<List<string>> GetPrinterListAsync();
//        Task<object?> PostOrderKitchenInfoAsync(JsonElement order);
//        Task<object?> UpdateKitchenStatusAsync(JsonElement order, KitchenStatus status);
//        Task<object?> UpdateKitchenInfoAsync(JsonElement order, string updateFor, KitchenStatus? status = null);
//        Task<PrintConfig?> GetPrintConfigAsync();
//    }

//    public class PrinterService : IPrinterService
//    {
//        private readonly IHttpClientFactory _httpClientFactory;
//        private readonly ILogger<PrinterService> _logger;
//        private readonly IConfiguration _configuration;
//        private readonly IMemoryCache _memoryCache;
//        private readonly string _getPOSURL;
//        private readonly string _compCode;

//        // ── No more CJK font path cache needed — pdfium handles fonts itself ──

//        public PrinterService(
//            IHttpClientFactory httpClientFactory,
//            ILogger<PrinterService> logger,
//            IConfiguration configuration,
//            IMemoryCache memoryCache)
//        {
//            _httpClientFactory = httpClientFactory;
//            _logger = logger;
//            _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
//            _memoryCache = memoryCache ?? throw new ArgumentNullException(nameof(memoryCache));
//            _getPOSURL = configuration["Outlet:NEXT_ONLINE_API_URL"] ?? string.Empty;
//            _compCode = configuration["Outlet:COMP_CODE"] ?? "01";
//        }

//        // ── Session helpers ────────────────────────────────────────────────────

//        private string GetSessionId()
//        {
//            _memoryCache.TryGetValue("POS_SESSION_ID", out string? sessionId);
//            return sessionId ?? string.Empty;
//        }

//        private string GetStoreName()
//        {
//            _memoryCache.TryGetValue("STORE_NAME", out string? storeName);
//            return storeName ?? string.Empty;
//        }

//        // ── Print ──────────────────────────────────────────────────────────────

//        public async Task<bool> PrintAsync(
//    string printerName, byte[] fileData, string fileName, bool rotate)
//        {
//            try
//            {
//                // ✅ Always save receipt first before printing
//                await SavePrintJobAsync(fileData, fileName);

//                bool isPdf = fileData.Length > 4
//                    && fileData[0] == 0x25   // %
//                    && fileData[1] == 0x50   // P
//                    && fileData[2] == 0x44   // D
//                    && fileData[3] == 0x46;  // F

//                if (isPdf)
//                {
//                    _logger.LogInformation(
//                        "PrintAsync — PDF detected, printing via PdfiumViewer → {PrinterName}",
//                        printerName);
//                    return await PrintPdfAsync(printerName, fileData, fileName, rotate);
//                }
//                else
//                {
//                    _logger.LogInformation(
//                        "PrintAsync — Raw stream → {PrinterName}", printerName);
//                    using var stream = new MemoryStream(fileData);
//                    var printer = new Printer();
//                    printer.PrintRawStream(printerName, stream, fileName, rotate);
//                    return true;
//                }
//            }
//            catch (Exception ex)
//            {
//                _logger.LogError(ex, "PrintAsync failed for printer {PrinterName}", printerName);
//                return false;
//            }
//        }

//        private Task<bool> PrintPdfAsync(
//    string printerName, byte[] pdfData, string fileName, bool rotate)
//        {
//            try
//            {
//                _logger.LogInformation(
//                    "PrintPdfAsync → {PrinterName} | {FileName}", printerName, fileName);

//                const float renderDpi = 300f;

//                var bitmaps = new List<Image>();

//                using (var ms = new MemoryStream(pdfData))
//                using (var pdfDoc = PdfDocument.Load(ms))
//                {
//                    _logger.LogInformation("PDF loaded: {Pages} page(s)", pdfDoc.PageCount);

//                    for (int i = 0; i < pdfDoc.PageCount; i++)
//                    {
//                        var pageSize = pdfDoc.PageSizes[i];

//                        int widthPx = (int)(pageSize.Width / 72f * renderDpi);
//                        int heightPx = (int)(pageSize.Height / 72f * renderDpi);

//                        var rotation = rotate ? PdfRotation.Rotate180 : PdfRotation.Rotate0;

//                        // ✅ Render via PdfiumViewer
//                        var rendered = pdfDoc.Render(
//                            i, widthPx, heightPx,
//                            renderDpi, renderDpi,
//                            rotation,
//                            PdfRenderFlags.ForPrinting);

//                        // ✅ Sharpen via ImageSharp then convert back to System.Drawing.Image
//                        var sharpened = SharpenBitmap(rendered, renderDpi);
//                        bitmaps.Add(sharpened);
//                        rendered.Dispose();
//                    }
//                }

//                int currentPage = 0;

//                using var pd = new PrintDocument();
//                pd.PrinterSettings.PrinterName = printerName;
//                pd.PrinterSettings.PrintToFile = false;
//                pd.DefaultPageSettings.Margins = new Margins(0, 0, 0, 0);

//                if (!pd.PrinterSettings.IsValid)
//                {
//                    _logger.LogError("❌ Invalid printer: {PrinterName}", printerName);
//                    return Task.FromResult(false);
//                }

//                pd.PrintPage += (sender, e) =>
//                {
//                    try
//                    {
//                        var img = bitmaps[currentPage];

//                        if (img is Bitmap bmp)
//                            bmp.SetResolution(renderDpi, renderDpi);

//                        float printWidth = img.Width / renderDpi * 100f;
//                        float printHeight = img.Height / renderDpi * 100f;

//                        _logger.LogInformation(
//                            "Printing page {Page} → {W}px × {H}px @ {Dpi}dpi",
//                            currentPage, img.Width, img.Height, renderDpi);

//                        e.Graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
//                        e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
//                        e.Graphics.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
//                        e.Graphics.CompositingQuality = System.Drawing.Drawing2D.CompositingQuality.HighQuality;

//                        e.Graphics.DrawImage(img, 0f, 0f, printWidth, printHeight);

//                        currentPage++;
//                        e.HasMorePages = currentPage < bitmaps.Count;
//                    }
//                    catch (Exception ex)
//                    {
//                        _logger.LogError(ex, "❌ PrintPage error");
//                        e.HasMorePages = false;
//                    }
//                };

//                pd.EndPrint += (sender, e) =>
//                {
//                    foreach (var img in bitmaps)
//                        img.Dispose();

//                    _logger.LogInformation("🧹 Bitmaps disposed");
//                };

//                pd.Print();

//                _logger.LogInformation("✅ Print success → {FileName}", fileName);
//                return Task.FromResult(true);
//            }
//            catch (Exception ex)
//            {
//                _logger.LogError(ex,
//                    "❌ PrintPdfAsync failed → {PrinterName} | {FileName}",
//                    printerName, fileName);
//                return Task.FromResult(false);
//            }
//        }

//        // ✅ Uses SixLabors.ImageSharp to sharpen the rendered bitmap
//        private System.Drawing.Image SharpenBitmap(System.Drawing.Image source, float dpi)
//        {
//            try
//            {
//                // Convert System.Drawing.Image → byte[] PNG → ImageSharp
//                byte[] pngBytes;
//                using (var ms = new MemoryStream())
//                {
//                    source.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
//                    pngBytes = ms.ToArray();
//                }

//                byte[] sharpenedBytes;
//                using (var ms = new MemoryStream(pngBytes))
//                using (var imgSharp = SixLabors.ImageSharp.Image.Load<SixLabors.ImageSharp.PixelFormats.Rgba32>(ms))
//                {
//                    // ✅ Sharpen — adjust sigma for more/less sharpening (0.5–2.0)
//                    imgSharp.Mutate(ctx => ctx
//                        .GaussianSharpen(1.0f)   // sharpens edges/text
//                    );

//                    using var outMs = new MemoryStream();
//                    imgSharp.Save(outMs, new SixLabors.ImageSharp.Formats.Png.PngEncoder());
//                    sharpenedBytes = outMs.ToArray();
//                }

//                // Convert back to System.Drawing.Image
//                var result = System.Drawing.Image.FromStream(new MemoryStream(sharpenedBytes));

//                // ✅ Restore DPI metadata
//                if (result is Bitmap bmp)
//                    bmp.SetResolution(dpi, dpi);

//                return result;
//            }
//            catch (Exception ex)
//            {
//                _logger.LogWarning(ex, "⚠️ SharpenBitmap failed — using original");
//                return source; // fallback to unsharpened
//            }
//        }

//        // ── PrintPdfAsync — PDF → PdfiumViewer.Render → Bitmap → PrintDocument ──
//        //
//        // We deliberately avoid PdfDocument.CreatePrintDocument() because it
//        // internally references System.Windows.Forms v2.0.0.0 (old .NET Framework)
//        // which does not exist in .NET 6/7/8 projects and throws FileNotFoundException.
//        //
//        // Instead we:
//        //   1. Render each page to a System.Drawing.Image via PdfiumViewer (CJK fonts work)
//        //   2. Print the images ourselves via PrintDocument (no WinForms version conflict)
//        //
//        //private Task<bool> PrintPdfAsync(
//        //    string printerName, byte[] pdfData, string fileName, bool rotate)
//        //{
//        //    try
//        //    {
//        //        _logger.LogInformation(
//        //            "PrintPdfAsync → {PrinterName} | {FileName}",
//        //            printerName, fileName);

//        //        const float renderDpi = 203f; // ✅ Match thermal printer DPI

//        //        var bitmaps = new List<Image>();

//        //        using (var ms = new MemoryStream(pdfData))
//        //        using (var pdfDoc = PdfDocument.Load(ms))
//        //        {
//        //            _logger.LogInformation(
//        //                "PDF loaded: {Pages} page(s)",
//        //                pdfDoc.PageCount);

//        //            for (int i = 0; i < pdfDoc.PageCount; i++)
//        //            {
//        //                var pageSize = pdfDoc.PageSizes[i];

//        //                int widthPx = (int)(pageSize.Width / 72f * renderDpi);
//        //                int heightPx = (int)(pageSize.Height / 72f * renderDpi);

//        //                var rotation = rotate ? PdfRotation.Rotate180 : PdfRotation.Rotate0;

//        //                var img = pdfDoc.Render(
//        //                    i,
//        //                    widthPx,
//        //                    heightPx,
//        //                    renderDpi,
//        //                    renderDpi,
//        //                    rotation,
//        //                    PdfRenderFlags.ForPrinting);

//        //                bitmaps.Add(img);
//        //            }
//        //        }

//        //        int currentPage = 0;

//        //        using var pd = new PrintDocument();
//        //        pd.PrinterSettings.PrinterName = printerName;
//        //        pd.PrinterSettings.PrintToFile = false;

//        //        // ❗ MUST set margins properly
//        //        pd.DefaultPageSettings.Margins = new Margins(0, 0, 0, 0);

//        //        // ❗ Validate printer
//        //        if (!pd.PrinterSettings.IsValid)
//        //        {
//        //            _logger.LogError("❌ Invalid printer: " + printerName);
//        //            return Task.FromResult(false);
//        //        }

//        //        pd.PrintPage += (sender, e) =>
//        //        {
//        //            try
//        //            {
//        //                var img = bitmaps[currentPage];

//        //                // ✅ Set bitmap resolution metadata so DrawImage knows the source DPI
//        //                if (img is Bitmap bmp)
//        //                    bmp.SetResolution(renderDpi, renderDpi);

//        //                // ✅ Convert pixels → 1/100 inch (PrintDocument's unit)
//        //                // img was rendered at renderDpi pixels/inch
//        //                // PrintDocument uses 1/100 inch units = multiply by 100/renderDpi
//        //                float printWidth = img.Width * 100f / renderDpi;
//        //                float printHeight = img.Height * 100f / renderDpi;

//        //                float x = e.MarginBounds.Left;
//        //                float y = e.MarginBounds.Top;

//        //                _logger.LogInformation(
//        //                    "Printing page {Page} → {W}px × {H}px @ {Dpi}dpi → {PW}×{PH} (1/100in)",
//        //                    currentPage, img.Width, img.Height, renderDpi, printWidth, printHeight);

//        //                e.Graphics.DrawImage(img, x, y, printWidth, printHeight);
//        //                currentPage++;
//        //                e.HasMorePages = currentPage < bitmaps.Count;
//        //            }
//        //            catch (Exception ex)
//        //            {
//        //                _logger.LogError(ex, "❌ PrintPage error");
//        //                e.HasMorePages = false;
//        //            }
//        //        };

//        //        pd.EndPrint += (sender, e) =>
//        //        {
//        //            foreach (var img in bitmaps)
//        //                img.Dispose();

//        //            _logger.LogInformation("🧹 Bitmaps disposed");
//        //        };

//        //        pd.Print();

//        //        _logger.LogInformation(
//        //            "✅ Print success → {FileName}",
//        //            fileName);

//        //        return Task.FromResult(true);
//        //    }
//        //    catch (Exception ex)
//        //    {
//        //        _logger.LogError(ex,
//        //            "❌ PrintPdfAsync failed → {PrinterName} | {FileName}",
//        //            printerName, fileName);

//        //        return Task.FromResult(false);
//        //    }
//        //}


//        private async Task SavePrintJobAsync(byte[] fileData, string fileName)
//        {
//            try
//            {
//                const string saveDir = @"C:\PROD_LIHO_SOK\NETs\PrintJobs";
//                //const string saveDir = @"C:\inetpub\wwwroot\CafeJubilan_SOK\NETs\PrintJobs";

//                Directory.CreateDirectory(saveDir);

//                var timestamp = DateTime.Now.ToString("yyyyMMdd_HHmmss");
//                var safeFileName = string.IsNullOrWhiteSpace(fileName) ? "receipt.pdf" : fileName;
//                var fullPath = Path.Combine(saveDir, $"{timestamp}_{safeFileName}");

//                await File.WriteAllBytesAsync(fullPath, fileData);

//                _logger.LogInformation("💾 PrintJob saved → {Path}", fullPath);
//            }
//            catch (Exception ex)
//            {
//                _logger.LogWarning(ex, "⚠️ Failed to save print job — print will continue");
//            }
//        }

//        // ── Cash Drawer ────────────────────────────────────────────────────────

//        public Task<bool> OpenCashDrawerAsync(string printerName)
//        {
//            return Task.FromResult(true);
//        }

//        // ── Printer List ───────────────────────────────────────────────────────

//        public Task<List<string>> GetPrinterListAsync()
//        {
//            var printers = new List<string>();
//            try
//            {
//                foreach (string printer in PrinterSettings.InstalledPrinters)
//                    printers.Add(printer);
//            }
//            catch (Exception ex)
//            {
//                _logger.LogError(ex, "GetPrinterListAsync failed");
//            }
//            return Task.FromResult(printers);
//        }

//        // ── posorderkitchen/update ─────────────────────────────────────────────

//        public async Task<object?> PostOrderKitchenInfoAsync(JsonElement order)
//        {
//            try
//            {
//                var sessionId = GetSessionId();
//                if (string.IsNullOrEmpty(_getPOSURL) || string.IsNullOrEmpty(sessionId))
//                {
//                    _logger.LogError("PostOrderKitchenInfoAsync — _getPOSURL or POS_SESSION_ID is empty");
//                    return null;
//                }

//                var url = $"{_getPOSURL}/posorderkitchen/update/{_compCode}?sessionid={sessionId}";
//                _logger.LogInformation("PostOrderKitchenInfoAsync → {URL}", url);

//                var rawDocDate = GetString(order, "doc_date");
//                var cleanDocDate = rawDocDate.Split(' ').Length >= 2
//                    ? string.Join(" ", rawDocDate.Split(' ')[0], rawDocDate.Split(' ')[1])
//                    : rawDocDate;

//                object? salesDtls = null;
//                object? salesServiceDtls = null;
//                object? salesPaymentDtls = null;

//                if (order.TryGetProperty("sales_dtls", out var sd))
//                    salesDtls = JsonSerializer.Deserialize<JsonElement>(sd.GetRawText());
//                if (order.TryGetProperty("sales_service_dtls", out var ssd))
//                    salesServiceDtls = JsonSerializer.Deserialize<JsonElement>(ssd.GetRawText());
//                if (order.TryGetProperty("sales_payment_dtls", out var spd))
//                    salesPaymentDtls = JsonSerializer.Deserialize<JsonElement>(spd.GetRawText());

//                var payload = new[]
//                {
//                    new Dictionary<string, object?>
//                    {
//                        ["comp_code"]           = _compCode,
//                        ["store_name"]          = GetStoreName(),
//                        ["register_name"]       = GetString(order, "register_name"),
//                        ["shift_code"]          = GetString(order, "shift_code", "SHIFT1"),
//                        ["sales_no"]            = GetString(order, "sales_no"),
//                        ["doc_date"]            = cleanDocDate,
//                        ["customer_code"]       = GetString(order, "customer_code"),
//                        ["cust_addr_s_no"]      = GetString(order, "cust_addr_s_no"),
//                        ["service_type"]        = GetString(order, "service_type"),
//                        ["service_type_info"]   = GetString(order, "service_type_info"),
//                        ["order_status_id"]     = GetString(order, "order_status_id"),
//                        ["order_status_desc"]   = GetString(order, "order_status_desc"),
//                        ["kitchen_status_id"]   = GetString(order, "kitchen_status_id"),
//                        ["kitchen_status_desc"] = GetString(order, "kitchen_status_desc"),
//                        ["sub_total"]           = GetString(order, "sub_total"),
//                        ["disc_type"]           = GetString(order, "disc_type"),
//                        ["disc_name"]           = GetString(order, "disc_name"),
//                        ["disc_value"]          = GetInt(order, "disc_value"),
//                        ["total_disc"]          = GetString(order, "total_disc"),
//                        ["total_svc"]           = GetString(order, "total_svc"),
//                        ["total_tax"]           = GetString(order, "total_tax"),
//                        ["round_adj_amt"]       = GetString(order, "round_adj_amt"),
//                        ["absorb_tax"]          = GetString(order, "absorb_tax"),
//                        ["absorb_tax_info"]     = GetString(order, "absorb_tax_info"),
//                        ["net_amt"]             = GetString(order, "net_amt"),
//                        ["tips_amt"]            = GetString(order, "tips_amt"),
//                        ["total_tender_amt"]    = GetString(order, "total_tender_amt"),
//                        ["change_amt"]          = GetString(order, "change_amt"),
//                        ["no_of_pax"]           = GetInt(order, "no_of_pax"),
//                        ["table_no"]            = GetString(order, "table_no"),
//                        ["remarks"]             = GetString(order, "remarks"),
//                        ["del_driver"]          = GetString(order, "del_driver"),
//                        ["ref_1"]               = GetString(order, "ref_1"),
//                        ["ref_2"]               = GetString(order, "ref_2"),
//                        ["ref_3"]               = GetString(order, "ref_3"),
//                        ["ref_4"]               = GetString(order, "ref_4"),
//                        ["ref_5"]               = GetString(order, "ref_5"),
//                        ["sales_dtls"]          = salesDtls,
//                        ["sales_service_dtls"]  = salesServiceDtls,
//                        ["sales_payment_dtls"]  = salesPaymentDtls,
//                        ["sales_other_info"]    = GetString(order, "sales_other_info"),
//                        ["table_transfer"]      = GetString(order, "table_transfer"),
//                        ["table_transfer_sno"]  = GetString(order, "table_transfer_sno"),
//                        ["server_order_id"]     = GetString(order, "server_order_id"),
//                        ["lastSNo"]             = GetInt(order, "lastSNo"),
//                        ["action"]              = "update",
//                        ["order_mode"]          = GetString(order, "order_mode"),
//                        ["order_from"]          = GetString(order, "order_from"),
//                        ["c_userid"]            = GetString(order, "c_userid", "WEBORDER"),
//                        ["c_date"]              = GetString(order, "c_date"),
//                        ["m_userid"]            = GetString(order, "m_userid", "WEBORDER"),
//                        ["m_date"]              = DateTime.Now.ToString("yyyy/MM/dd H:mm:ss"),
//                        ["update_for"]          = "PRINT_DRAFT",
//                    }
//                };

//                return await PostToEvolut(url, payload);
//            }
//            catch (Exception ex)
//            {
//                _logger.LogError(ex, "PostOrderKitchenInfoAsync exception");
//                return null;
//            }
//        }

//        // ── posorderkitchenother/update (status shortcut) ──────────────────────

//        public async Task<object?> UpdateKitchenStatusAsync(JsonElement order, KitchenStatus status)
//        {
//            return await UpdateKitchenInfoAsync(order, "KITCHEN_STATUS", status);
//        }

//        // ── posorderkitchenother/update (generic) ──────────────────────────────

//        public async Task<object?> UpdateKitchenInfoAsync(
//            JsonElement order, string updateFor, KitchenStatus? status = null)
//        {
//            try
//            {
//                var sessionId = GetSessionId();
//                if (string.IsNullOrEmpty(_getPOSURL) || string.IsNullOrEmpty(sessionId))
//                {
//                    _logger.LogError("UpdateKitchenInfoAsync — _getPOSURL or POS_SESSION_ID is empty");
//                    return null;
//                }

//                var url = $"{_getPOSURL}/posorderkitchenother/update/{_compCode}?sessionid={sessionId}";
//                _logger.LogInformation("UpdateKitchenInfoAsync ({UpdateFor}) → {URL}", updateFor, url);

//                var payload = new[]
//                {
//                    new Dictionary<string, object?>
//                    {
//                        ["comp_code"]           = _compCode,
//                        ["store_name"]          = GetStoreName(),
//                        ["register_name"]       = GetString(order, "register_name"),
//                        ["shift_code"]          = GetString(order, "shift_code", "SHIFT1"),
//                        ["sales_no"]            = GetString(order, "sales_no"),
//                        ["doc_date"]            = GetString(order, "doc_date").Split(' ').Take(2).Aggregate((a, b) => $"{a} {b}"),
//                        ["customer_code"]       = GetString(order, "customer_code"),
//                        ["cust_addr_s_no"]      = GetString(order, "cust_addr_s_no"),
//                        ["service_type"]        = GetString(order, "service_type"),
//                        ["service_type_info"]   = GetString(order, "service_type_info"),
//                        ["kitchen_status_id"]   = GetString(order, "kitchen_status_id"),
//                        ["kitchen_status_desc"] = GetString(order, "kitchen_status_desc"),
//                        ["no_of_pax"]           = GetInt(order, "no_of_pax"),
//                        ["table_no"]            = GetString(order, "table_no"),
//                        ["remarks"]             = GetString(order, "remarks"),
//                        ["ref_5"]               = GetString(order, "ref_5"),
//                        ["del_driver"]          = GetString(order, "del_driver"),
//                        ["update_for"]          = updateFor,
//                        ["m_userid"]            = GetString(order, "m_userid", "WEBORDER"),
//                        ["m_date"]              = DateTime.Now.ToString("yyyy/MM/dd H:mm:ss"),
//                    }
//                };
//                _logger.LogInformation("UpdateKitchenInfoAsync", payload);

//                return await PostToEvolut(url, payload);
//            }
//            catch (Exception ex)
//            {
//                _logger.LogError(ex, "UpdateKitchenInfoAsync exception");
//                return null;
//            }
//        }

//        // ── PrintConfig ────────────────────────────────────────────────────────

//        public Task<PrintConfig?> GetPrintConfigAsync()
//        {
//            try
//            {
//                var section = _configuration.GetSection("PrintConfig");
//                if (!section.Exists())
//                {
//                    _logger.LogWarning("GetPrintConfigAsync — PrintConfig section missing from appsettings.json");
//                    return Task.FromResult<PrintConfig?>(null);
//                }

//                var dict = section.Get<Dictionary<string, object>>();
//                var json = JsonSerializer.Serialize(dict);

//                var printConfig = JsonSerializer.Deserialize<PrintConfig>(json,
//                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

//                _logger.LogInformation(
//                    "GetPrintConfigAsync succeeded — Kitchen={HasKitchen}, Receipt={HasReceipt}",
//                    printConfig?.Kitchen is not null,
//                    printConfig?.Receipt is not null);

//                return Task.FromResult(printConfig);
//            }
//            catch (Exception ex)
//            {
//                _logger.LogError(ex, "GetPrintConfigAsync failed");
//                return Task.FromResult<PrintConfig?>(null);
//            }
//        }

//        // ── Shared HTTP helper ─────────────────────────────────────────────────

//        private async Task<object?> PostToEvolut(string url, object payload)
//        {
//            var client = _httpClientFactory.CreateClient();

//            var innerJson = JsonSerializer.Serialize(payload);
//            var wrapped = new { jsondata = innerJson };
//            var json = JsonSerializer.Serialize(wrapped);

//            _logger.LogInformation("PostToEvolut → Payload: {Payload}", json);

//            using var content = new StringContent(json, Encoding.UTF8, "application/json");
//            var response = await client.PostAsync(url, content).ConfigureAwait(false);
//            var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);

//            _logger.LogInformation("PostToEvolut → Status: {StatusCode} | Body: {Body}",
//                (int)response.StatusCode, body);

//            if (!response.IsSuccessStatusCode)
//            {
//                _logger.LogWarning("PostToEvolut failed → {StatusCode} | {Body}",
//                    (int)response.StatusCode, body);
//                return null;
//            }

//            try { return JsonSerializer.Deserialize<JsonElement>(body); }
//            catch { return new { success = true, message = body }; }
//        }

//        // ── Helpers ────────────────────────────────────────────────────────────

//        private static string GetString(JsonElement el, string key, string fallback = "")
//            => el.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.String
//                ? p.GetString() ?? fallback : fallback;

//        private static int GetInt(JsonElement el, string key, int fallback = 0)
//            => el.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.Number
//                ? p.GetInt32() : fallback;
//    }
//}

//// ═══════════════════════════════════════════════════════════════════════════════
//// CONTROLLER  (unchanged)
//// ═══════════════════════════════════════════════════════════════════════════════

//namespace PROD_LIHO_SOK.Controllers
//{
//    [ApiController]
//    [Route("API/[controller]")]
//    public class PrinterController : ControllerBase
//    {
//        private readonly IPrinterService _printerService;
//        private readonly ILogger<PrinterController> _logger;

//        public PrinterController(
//            IPrinterService printerService,
//            ILogger<PrinterController> logger)
//        {
//            _printerService = printerService;
//            _logger = logger;
//        }

//        // ── Print ──────────────────────────────────────────────────────────────
//        [HttpPost("print")]
//        public async Task<IActionResult> Print(
//            [FromForm] string printerName,
//            [FromForm] string fileName,
//            [FromForm] bool rotate = false,
//            [FromForm] IFormFile? file = null) // Add [FromForm] here   
//        {
//            try
//            {
//                // 1. Validation
//                if (string.IsNullOrWhiteSpace(printerName))
//                    return BadRequest(new { success = false, message = "printerName is required" });

//                if (file == null || file.Length == 0)
//                {
//                    _logger.LogError("Print — No IFormFile named 'file' found in the request.");
//                    return BadRequest(new { success = false, message = "No file data received. Ensure FormData key is 'file'" });
//                }

//                // 2. Extract Bytes from the FormFile
//                byte[] fileData;
//                using (var ms = new MemoryStream())
//                {
//                    await file.CopyToAsync(ms);
//                    fileData = ms.ToArray();
//                }

//                // 3. PDF Header Validation (%PDF-)
//                if (fileData.Length > 4 &&
//                    fileData[0] == 0x25 && fileData[1] == 0x50 &&
//                    fileData[2] == 0x44 && fileData[3] == 0x46)
//                {
//                    _logger.LogInformation("✅ Valid PDF header detected for {FileName} ({Size} bytes)", fileName, fileData.Length);
//                }
//                else
//                {
//                    _logger.LogWarning("⚠️ File received for {FileName} is not a valid PDF or is corrupted.", fileName);
//                    // We still try to print, but this log helps debug corruption
//                }

//                // 4. Send to Service
//                var success = await _printerService.PrintAsync(printerName, fileData, fileName, rotate);

//                if (!success)
//                {
//                    _logger.LogWarning("PrintAsync returned false for printer {PrinterName}", printerName);
//                    return StatusCode(500, new { success = false, message = $"Print failed on: {printerName}. Check printer status." });
//                }

//                return Ok(new { success = true, message = $"Sent to printer: {printerName}" });
//            }
//            catch (Exception ex)
//            {
//                _logger.LogError(ex, "Print Exception for {PrinterName}", printerName);
//                return StatusCode(500, new { success = false, message = ex.Message });
//            }
//        }


//        public class PrintLabelRequest
//        {
//            public string File { get; set; }  // base64
//            public string PrinterName { get; set; }
//            public string FileName { get; set; }
//            public bool Rotate { get; set; }
//            public int Dpi { get; set; }
//            public bool FitToPage { get; set; }
//        }

//        [HttpPost("print-label")]
//        public async Task<IActionResult> PrintLabel([FromBody] PrintLabelRequest req)
//        {
//            if (string.IsNullOrWhiteSpace(req.PrinterName))
//                return BadRequest(new { success = false, message = "printerName is required" });

//            if (string.IsNullOrWhiteSpace(req.File))
//                return BadRequest(new { success = false, message = "No file data received." });

//            byte[] fileData = Convert.FromBase64String(req.File);

//            if (fileData.Length > 4 &&
//                fileData[0] == 0x25 && fileData[1] == 0x50 &&
//                fileData[2] == 0x44 && fileData[3] == 0x46)
//            {
//                _logger.LogInformation("✅ Valid PDF header for {FileName} ({Size} bytes)", req.FileName, fileData.Length);
//            }
//            else
//            {
//                _logger.LogWarning("⚠️ Not a valid PDF: {FileName}", req.FileName);
//            }

//            var success = await _printerService.PrintAsync(req.PrinterName, fileData, req.FileName, req.Rotate);
//            if (!success)
//                return StatusCode(500, new { success = false, message = $"Print failed on: {req.PrinterName}" });

//            return Ok(new { success = true, message = $"Sent to printer: {req.PrinterName}" });
//        }

//        [HttpPost("kitchen")]
//        public async Task<IActionResult> Kitchen(
//            [FromForm] string printerName,
//            [FromForm] string fileName,
//            [FromForm] bool rotate = false,
//            [FromForm] IFormFile? file = null)
//        {
//            return await ExecutePrintJob(printerName, fileName, rotate, file, "Kitchen");
//        }

//        private async Task<IActionResult> ExecutePrintJob(string printerName, string fileName, bool rotate, IFormFile? file, string logContext)
//        {
//            try
//            {
//                if (string.IsNullOrWhiteSpace(printerName))
//                    return BadRequest(new { success = false, message = "printerName is required" });

//                if (file == null || file.Length == 0)
//                {
//                    _logger.LogError("{Context} — No file found in the request.", logContext);
//                    return BadRequest(new { success = false, message = "No file data received." });
//                }

//                byte[] fileData;
//                using (var ms = new MemoryStream())
//                {
//                    await file.CopyToAsync(ms);
//                    fileData = ms.ToArray();
//                }

//                // Simple PDF validation
//                if (fileData.Length > 4 && fileData[0] == 0x25 && fileData[1] == 0x50)
//                {
//                    _logger.LogInformation("✅ {Context}: Valid PDF detected for {FileName}", logContext, fileName);
//                }

//                var success = await _printerService.PrintAsync(printerName, fileData, fileName, rotate);

//                if (!success)
//                {
//                    _logger.LogWarning("{Context}: PrintAsync failed for {PrinterName}", logContext, printerName);
//                    return StatusCode(500, new { success = false, message = $"Print failed on: {printerName}" });
//                }

//                return Ok(new { success = true, message = $"Sent {logContext} to {printerName}" });
//            }
//            catch (Exception ex)
//            {
//                _logger.LogError(ex, "{Context} Exception for {PrinterName}", logContext, printerName);
//                return StatusCode(500, new { success = false, message = ex.Message });
//            }
//        }

//        // ── Cash Drawer ────────────────────────────────────────────────────────

//        [HttpPost("open-cash-drawer")]
//        public async Task<IActionResult> OpenCashDrawer([FromBody] OpenCashDrawerRequest req)
//        {
//            try
//            {
//                var success = await _printerService.OpenCashDrawerAsync(req.PrinterName);

//                _logger.LogInformation("OpenCashDrawer [{Success}] printer: {PrinterName}",
//                    success, req.PrinterName);

//                return success
//                    ? Ok(new { success = true })
//                    : StatusCode(500, new { success = false, message = "Failed to open cash drawer" });
//            }
//            catch (Exception ex)
//            {
//                _logger.LogError(ex, "OpenCashDrawerAsync failed for printer {PrinterName}", req.PrinterName);
//                return StatusCode(500, new { success = false, message = ex.Message });
//            }
//        }

//        // ── Printer List ───────────────────────────────────────────────────────

//        [HttpGet("list")]
//        public async Task<IActionResult> GetPrinterList()
//        {
//            try
//            {
//                var printers = await _printerService.GetPrinterListAsync();
//                _logger.LogInformation("GetPrinterList returned {Count} printers", printers.Count);
//                return Ok(new { success = true, printers });
//            }
//            catch (Exception ex)
//            {
//                _logger.LogError(ex, "GetPrinterListAsync failed");
//                return StatusCode(500, new { success = false, message = ex.Message });
//            }
//        }

//        // ── PrintConfig ────────────────────────────────────────────────────────

//        [HttpGet("config")]
//        public async Task<IActionResult> GetPrintConfig()
//        {
//            try
//            {
//                var printConfig = await _printerService.GetPrintConfigAsync();

//                if (printConfig is null)
//                {
//                    _logger.LogWarning("GetPrintConfigAsync returned null");
//                    return NotFound(new { success = false, message = "PrintConfig not found" });
//                }

//                _logger.LogInformation("GetPrintConfigAsync succeeded. IsDefault={IsDefault}",
//                    printConfig.IsDefault);

//                return Ok(new { success = true, data = printConfig });
//            }
//            catch (Exception ex)
//            {
//                _logger.LogError(ex, "GetPrintConfigAsync failed");
//                return StatusCode(500, new { success = false, message = ex.Message });
//            }
//        }

//        // ── Kitchen Proxy ──────────────────────────────────────────────────────

//        [HttpPost("posorderkitchen/update")]
//        public async Task<IActionResult> PostOrderKitchenInfo([FromBody] JsonElement order)
//        {
//            try
//            {
//                var result = await _printerService.PostOrderKitchenInfoAsync(order);
//                return result is null
//                    ? StatusCode(500, new { success = false, message = "Kitchen update failed" })
//                    : Ok(result);
//            }
//            catch (Exception ex)
//            {
//                _logger.LogError(ex, "PostOrderKitchenInfo failed");
//                return StatusCode(500, new { success = false, message = ex.Message });
//            }
//        }

//        [HttpPost("posorderkitchenother/update")]
//        public async Task<IActionResult> UpdateKitchenStatus([FromBody] JsonElement order)
//        {
//            try
//            {
//                var result = await _printerService.UpdateKitchenInfoAsync(
//                    order, updateFor: "KITCHEN_STATUS", status: KitchenStatus.Done);
//                return result is null
//                    ? StatusCode(500, new { success = false, message = "Kitchen status update failed" })
//                    : Ok(result);
//            }
//            catch (Exception ex)
//            {
//                _logger.LogError(ex, "UpdateKitchenStatus failed");
//                return StatusCode(500, new { success = false, message = ex.Message });
//            }
//        }
//    }

//    public record OpenCashDrawerRequest(string PrinterName);
//}