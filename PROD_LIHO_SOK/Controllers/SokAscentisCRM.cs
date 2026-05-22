using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using PROD_LIHO_SOK.Models;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace PROD_LIHO_SOK.Controllers
{
    [ApiController]
    [Route("api/crm")]
    public class AscentisController : ControllerBase
    {
        private readonly HttpClient _httpClient;
        private readonly ILogger<AscentisController> _logger;
        private readonly AscentisSettings _ascentisSettings;
        private readonly IMemoryCache _memoryCache;
        private readonly IConfiguration _configuration;
        private readonly string _posCrmUrl;

        private const string TOKEN_CACHE_KEY = "ASCENTIS_AUTH_TOKEN";
        private const string CRM_SETTINGS_CACHE_KEY = "ASCENTIS_CRM_SETTINGS";
        private const string SOAP_ACTION = "https://MatrixAPIs/JSONCommand2";
        private readonly string _posCRMLogBaseFolder;

        public AscentisController(
            IHttpClientFactory httpClientFactory,
            ILogger<AscentisController> logger,
            IOptions<AscentisSettings> ascentisSettings,
            IMemoryCache memoryCache,
            IConfiguration configuration,
            IWebHostEnvironment env)
        {
            _httpClient = httpClientFactory.CreateClient();
            _logger = logger;
            _ascentisSettings = ascentisSettings.Value;
            _memoryCache = memoryCache;
            _configuration = configuration;
            _posCrmUrl = configuration["Ascentis:PosCRMURL"] ?? "";
            _posCRMLogBaseFolder = Path.Combine(env.ContentRootPath, "PosCRMLogs");

            if (string.IsNullOrWhiteSpace(_ascentisSettings.TokenURL))
                throw new InvalidOperationException("Ascentis TokenURL must be configured in appsettings");

            if (string.IsNullOrWhiteSpace(_ascentisSettings.InstanceURL))
                throw new InvalidOperationException("Ascentis InstanceURL must be configured in appsettings");

            _logger.LogInformation("✅ Ascentis CRM controller initialized - PosCRMURL: {Url}", _posCrmUrl);
        }

        // ─────────────────────────────────────────────────────────────────────
        // PRIVATE: POS Session ID
        // ─────────────────────────────────────────────────────────────────────

        private async Task<string> POSSessionID()
        {
            try
            {
                if (_memoryCache.TryGetValue("POS_SESSION_ID", out string sessionId) &&
                    !string.IsNullOrEmpty(sessionId))
                {
                    _logger.LogInformation("Using cached session ID: {SessionId}", sessionId);
                    return sessionId;
                }

                var url = $"{_posCrmUrl}/GetSessionID/01?sessionid=";
                var response = await _httpClient.GetAsync(url).ConfigureAwait(false);

                if (!response.IsSuccessStatusCode)
                {
                    _logger.LogWarning("Error: {StatusCode} - {ReasonPhrase}", response.StatusCode, response.ReasonPhrase);
                    return $"Error: {response.StatusCode} - {response.ReasonPhrase}";
                }

                var jsonString = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                var jObj = Newtonsoft.Json.Linq.JObject.Parse(jsonString);
                var newSessionId = jObj["data"]?[0]?["output"]?[0]?["session_id"]?.ToString();

                if (string.IsNullOrEmpty(newSessionId))
                {
                    _logger.LogWarning("Session ID not found in POS response");
                    return "Error: Session ID not found";
                }

                _memoryCache.Set("POS_SESSION_ID", newSessionId, new MemoryCacheEntryOptions
                {
                    AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(25)
                });

                _logger.LogInformation("New session ID retrieved and cached: {SessionId}", newSessionId);
                return newSessionId;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "An exception occurred while fetching POS session ID.");
                return $"Exception: {ex.Message}";
            }
        }


        private async Task<Dictionary<string, string>> GetCrmSettingsAsync(string? storeName = null, string? registerName = null)
        {
            if (_memoryCache.TryGetValue(CRM_SETTINGS_CACHE_KEY, out Dictionary<string, string> cached))
                return cached;

            if (!_memoryCache.TryGetValue("POS_SESSION_ID", out string sessionId))
            {
                sessionId = await POSSessionID();
                if (sessionId.StartsWith("Error") || sessionId.StartsWith("Exception"))
                    throw new InvalidOperationException($"Failed to get POS session: {sessionId}");
            }

            // Fallback chain: parameter → cache → appsettings
            storeName ??= _memoryCache.TryGetValue("POS_STORE_NAME", out string cachedStore) ? cachedStore : _configuration["POS:StoreName"] ?? "";
            registerName ??= _memoryCache.TryGetValue("POS_REGISTER_NAME", out string cachedRegister) ? cachedRegister : _configuration["POS:RegisterName"] ?? "";

            var groupname = Uri.EscapeDataString("[{\"setting_group_name\":\"CRM SETTINGS\"}]");
            var posUrl = $"{_posCrmUrl}/GetStoreRegisterSettings/01?sessionid={sessionId}&storename={Uri.EscapeDataString(storeName)}&groupname={groupname}";


            _logger.LogInformation("⚙️ Fetching CRM settings - Store: {Store}, Register: {Register}", storeName, registerName);

            var response = await _httpClient.GetAsync(posUrl);
            var content = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("⚠️ Could not fetch CRM settings, falling back to appsettings");
                return new Dictionary<string, string>();
            }

            var settings = new Dictionary<string, string>();
            try
            {
                var json = JsonSerializer.Deserialize<JsonElement>(content);
                if (json.ValueKind == JsonValueKind.Array)
                {
                    foreach (var group in json.EnumerateArray())
                    {
                        var details = group.TryGetProperty("details", out var d) ? d : group;
                        if (details.ValueKind != JsonValueKind.Array) continue;
                        foreach (var setting in details.EnumerateArray())
                        {
                            var code = setting.TryGetProperty("setting_code", out var c) ? c.GetString() : null;
                            var value = setting.TryGetProperty("setting_value", out var v) ? v.GetString() : null;
                            if (!string.IsNullOrEmpty(code))
                                settings[code] = value ?? "";
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "⚠️ Failed to parse CRM settings, falling back to appsettings");
                return new Dictionary<string, string>();
            }

            _memoryCache.Set(CRM_SETTINGS_CACHE_KEY, settings, new MemoryCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(30)
            });

            _logger.LogInformation("✅ CRM settings cached: {Count} settings", settings.Count);
            return settings;
        }

        // ─────────────────────────────────────────────────────────────────────
        // PRIVATE: Build payload using dynamic POS settings (with appsettings fallback)
        // ─────────────────────────────────────────────────────────────────────

        private async Task<Dictionary<string, object>> BuildDynamicPayload(string command)
        {
            var settings = await GetCrmSettingsAsync();

            var enquiryCode = settings.GetValueOrDefault("Api_EnquiryCode", _ascentisSettings.EnquiryCode ?? "");
            var outletCode = settings.GetValueOrDefault("Api_OutletCode", _ascentisSettings.OutletCode ?? "");
            var posId = settings.GetValueOrDefault("Api_PosID", _ascentisSettings.PosID ?? "");
            var cashierId = settings.GetValueOrDefault("Api_CashierID", _ascentisSettings.CashierID ?? "");

            // ✅ Guard — fail fast with a clear message instead of a silent empty value
            if (string.IsNullOrWhiteSpace(outletCode))
                throw new InvalidOperationException(
                    "OutletCode is missing. CRM settings may not be loaded yet. " +
                    "Ensure /GetCrmSettings is called on startup, or check Api_OutletCode in POS settings.");

            _logger.LogInformation("🔧 Dynamic payload — Command: {Cmd}, Outlet: {Outlet}, PosID: {Pos}",
                command, outletCode, posId);

            return new Dictionary<string, object>
            {
                ["Command"] = command,
                ["EnquiryCode"] = enquiryCode,
                ["OutletCode"] = outletCode,
                ["PosID"] = posId,
                ["CashierID"] = cashierId,
                ["IgnoreCCNchecking"] = "true"
            };
        }

        // ─────────────────────────────────────────────────────────────────────
        // PRIVATE: Build base payload from appsettings (for direct Ascentis calls)
        // ─────────────────────────────────────────────────────────────────────

        private Dictionary<string, object> BuildBasePayload(string command)
        {
            return new Dictionary<string, object>
            {
                ["Command"] = command,
                ["EnquiryCode"] = _ascentisSettings.EnquiryCode,
                ["OutletCode"] = _ascentisSettings.OutletCode,
                ["PosID"] = _ascentisSettings.PosID,
                ["CashierID"] = _ascentisSettings.CashierID,
                ["IgnoreCCNchecking"] = _ascentisSettings.IgnoreCCNchecking.ToString().ToLower()
            };
        }

        // ─────────────────────────────────────────────────────────────────────
        // PRIVATE: Helper to get or refresh session ID
        // ─────────────────────────────────────────────────────────────────────

        private async Task<(bool ok, string sessionId, IActionResult? error)> ResolveSessionAsync()
        {
            if (!_memoryCache.TryGetValue("POS_SESSION_ID", out string sessionId))
            {
                sessionId = await POSSessionID();
                if (sessionId.StartsWith("Error") || sessionId.StartsWith("Exception"))
                    return (false, sessionId, StatusCode(500, new { success = false, error = sessionId }));
            }
            return (true, sessionId, null);
        }

        // ─────────────────────────────────────────────────────────────────────
        // PUBLIC: POS-PROXIED ENDPOINTS
        // ─────────────────────────────────────────────────────────────────────

        /// <summary>
        /// Proxy member enquiry to POS.
        /// POST: api/crm/post_ascentis_memberenquiry/{phoneNo}?sessionid={sessionid}
        /// </summary>
        [HttpPost("post_ascentis_memberenquiry/{phoneNo}")]
        public async Task<IActionResult> MemberEnquiryByPhone(
        [FromRoute] string phoneNo,
        [FromBody] AscentisMemberEnquiryRequest? request)
        {
            if (string.IsNullOrWhiteSpace(phoneNo))
                return BadRequest(new { success = false, error = "Phone number is required" });

            var cleanPhone = new string(phoneNo.Where(char.IsDigit).ToArray());
            if (cleanPhone.StartsWith("65") && cleanPhone.Length == 10)
                cleanPhone = cleanPhone.Substring(2);
            if (cleanPhone.Length != 8)
                return BadRequest(new { success = false, error = "Invalid Singapore phone number. Must be 8 digits." });

            var (ok, sessionId, sessionError) = await ResolveSessionAsync();
            if (!ok) return sessionError!;

            // ✅ Ensure CRM settings are loaded before BuildDynamicPayload runs
            // Pulls storeName from cache (set during GetStoreRegisterSettings) or appsettings
            var storeName = _memoryCache.TryGetValue("POS_STORE_NAME", out string cachedStore)
                ? cachedStore
                : _configuration["POS:StoreName"] ?? "";

            var crmSettings = await GetCrmSettingsAsync(storeName);

            // ✅ Early exit if critical settings are still missing
            if (!crmSettings.ContainsKey("Api_OutletCode") && string.IsNullOrWhiteSpace(_ascentisSettings.OutletCode))
            {
                _logger.LogError("❌ OutletCode missing from CRM settings and appsettings for store: {Store}", storeName);
                return StatusCode(503, new
                {
                    success = false,
                    error = "CRM settings not available. OutletCode is missing.",
                    store = storeName
                });
            }

            _logger.LogInformation("🔍 MemberEnquiryByPhone - Phone: {Phone}, SessionID: {Session}", cleanPhone, sessionId);

            try
            {
                var data = await BuildDynamicPayload("MEMBER ENQUIRY");
                data["MobileNo"] = cleanPhone;
                data["Email"] = request?.Email ?? "";
                data["MemberID"] = request?.MemberID ?? "";
                data["FilterCardsByStatus"] = request?.FilterCardsByStatus ?? "ACTIVE";
                data["MobileNoExactSearch"] = request?.MobileNoExactSearch ?? false;
                data["RetrieveBase64ImageString"] = false;
                data["RetrievePtsToNextTier"] = request?.RetrievePtsToNextTier ?? true;
                data["RetrieveNettToNextTier"] = request?.RetrieveNettToNextTier ?? true;
                data["RetrieveJournalList"] = false;
                data["JournalfilterBy_Type"] = "";
                data["RequestDynamicColumnLists"] = new[] { new { Name = "Gender" } };
                data["RequestDynamicFieldLists"] = new object[]
                {
            new { Name = "Industry" },       new { Name = "PreferredEvents" },
            new { Name = "MusicPreferences" }, new { Name = "PreferredOutlets" }
                };
                data["CardLists_PageNumber"] = 1;
                data["CardLists_PageCount"] = 99;
                data["TotalCardCounts"] = 99;

                return await CallPosAndReturn(
                    $"{_posCrmUrl}/post_ascentis_memberenquiry/01?sessionid={sessionId}",
                    data, sessionId, "MemberEnquiryByPhone",
                    extra: new { phone = cleanPhone }
                );
            }
            catch (InvalidOperationException ex) // thrown by BuildDynamicPayload guard
            {
                _logger.LogError(ex, "❌ Payload build failed — missing CRM config");
                return StatusCode(503, new { success = false, error = ex.Message });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "❌ Error in MemberEnquiryByPhone");
                return StatusCode(500, new { success = false, error = ex.Message });
            }
        }

        /// <summary>
        /// Get card enquiry (vouchers) via POS.
        /// GET: api/crm/GetPosCardEnquiry/{cardNo}
        /// </summary>
        [HttpGet("GetPosCardEnquiry/{cardNo}")]
        public async Task<IActionResult> GetPosCardEnquiry(
    [FromRoute] string cardNo,
    [FromQuery] int pageNumber = 1,
    [FromQuery] int pageCount = 99)
        {
            if (string.IsNullOrWhiteSpace(cardNo))
                return BadRequest(new { success = false, error = "Card number is required" });
            var (ok, sessionId, sessionError) = await ResolveSessionAsync();
            if (!ok) return sessionError!;
            _logger.LogInformation("🎟️ GetPosCardEnquiry - CardNo: {CardNo}, Page: {PageNumber}/{PageCount}", cardNo, pageNumber, pageCount);
            try
            {
                var data = await BuildDynamicPayload("CARD ENQUIRY");
                data["MemberID"] = "";
                data["CardNo"] = cardNo;
                data["CVC"] = "";
                data["SVCurrency"] = "";
                data["RetrieveMembershipInfo"] = true;
                data["RetrieveActiveVouchersList"] = true;
                data["RetrieveEligibleFlag"] = true;
                data["FilterBy_VoucherNo"] = "";
                data["FilterBy_VoucherType"] = "";
                data["FilterBy_VoucherTypeType"] = "";
                data["FilterBy_ValidFrom"] = "";
                data["FilterBy_ValidTo"] = "";
                data["FilterBy_TriggerSource"] = "";
                data["SortOrder"] = "ASC";
                data["SortBy_VoucherNo"] = false;
                data["SortBy_VoucherType"] = false;
                data["SortBy_ValidFrom"] = false;
                data["SortBy_ValidTo"] = true;
                data["PageNumber"] = pageNumber;  // ✅ use param
                data["PageCount"] = pageCount;   // ✅ use param
                data["RetrieveReceiptMessage"] = true;
                data["RetrievePtsToNextTier"] = true;
                data["RetrieveNettToNextTier"] = true;
                data["RetrieveJournalList"] = false;
                data["JournalfilterBy_Type"] = "";
                data["RetrieveCVCInfo"] = false;
                data["RequestDynamicColumnLists"] = new List<object>();
                data["RequestDynamicFieldLists"] = new List<object>();
                data["RetireveRedeemableVoucher"] = false;
                return await CallPosAndReturn(
                    $"{_posCrmUrl}/post_ascentis_cardenquiry/01?sessionid={sessionId}",
                    data, sessionId, "GetPosCardEnquiry",
                    extra: new { card_no = cardNo }
                );
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "❌ Error in GetPosCardEnquiry");
                return StatusCode(500, new { success = false, error = ex.Message });
            }
        }

        /// <summary>
        /// Get CRM point availability.
        /// GET: api/crm/GetPosCrmpointavl/{customerCode}
        /// </summary>
        [HttpGet("GetPosCrmpointavl/{customerCode}")]
        public async Task<IActionResult> GetPosCrmpointavl([FromRoute] string customerCode)
        {
            if (string.IsNullOrWhiteSpace(customerCode))
                return BadRequest(new { success = false, error = "Customer code is required" });

            var (ok, sessionId, sessionError) = await ResolveSessionAsync();
            if (!ok) return sessionError!;

            _logger.LogInformation("💰 GetPosCrmpointavl - CustomerCode: {Code}", customerCode);

            try
            {
                var posUrl = $"{_posCrmUrl}/GetPosCrmpointavl/01?sessionid={sessionId}&customercode={customerCode}";
                var posResponse = await _httpClient.GetAsync(posUrl);
                var content = await posResponse.Content.ReadAsStringAsync();

                if (!posResponse.IsSuccessStatusCode)
                {
                    _logger.LogError("❌ GetPosCrmpointavl failed: {Status}", posResponse.StatusCode);
                    return StatusCode((int)posResponse.StatusCode, new { success = false, error = content });
                }

                var result = JsonSerializer.Deserialize<JsonElement>(content);
                return Ok(new { success = true, sessionid = sessionId, data = result, timestamp = DateTime.UtcNow });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "❌ Error in GetPosCrmpointavl");
                return StatusCode(500, new { success = false, error = ex.Message });
            }
        }

      
        // ─────────────────────────────────────────────────────────────────────
        // PRIVATE: Shared POS POST helper
        // ─────────────────────────────────────────────────────────────────────

        private async Task<IActionResult> CallPosAndReturn(
            string posUrl,
            Dictionary<string, object> data,
            string sessionId,
            string callerName,
            object? extra = null)
        {
            var jsonPayload = JsonSerializer.Serialize(data, new JsonSerializerOptions { PropertyNamingPolicy = null });
            var formContent = new FormUrlEncodedContent(new[]
            {
                new KeyValuePair<string, string>("jsondata", jsonPayload)
            });

            var posRequest = new HttpRequestMessage(HttpMethod.Post, posUrl) { Content = formContent };

            _logger.LogInformation("📤 [{Caller}] Calling POS: {Url}", callerName, posUrl);

            var posResponse = await _httpClient.SendAsync(posRequest);
            var content = await posResponse.Content.ReadAsStringAsync();

            if (!posResponse.IsSuccessStatusCode)
            {
                _logger.LogError("❌ [{Caller}] POS call failed: {Status} - {Content}", callerName, posResponse.StatusCode, content);
                return StatusCode((int)posResponse.StatusCode, new { success = false, error = content });
            }

            // POS returns { Enquiry: "<json string>" }
            var posResult = JsonSerializer.Deserialize<JsonElement>(content);
            var enquiryRaw = posResult.TryGetProperty("Enquiry", out var enq) ? enq.GetString() : null;
            var crmData = enquiryRaw != null
                ? JsonSerializer.Deserialize<JsonElement>(enquiryRaw)
                : posResult;

            _logger.LogInformation("✅ [{Caller}] POS call success", callerName);

            // Merge extra fields into response
            var responseDict = new Dictionary<string, object?>
            {
                ["success"] = true,
                ["sessionid"] = sessionId,
                ["data"] = crmData,
                ["timestamp"] = DateTime.UtcNow
            };

            if (extra != null)
            {
                foreach (var prop in extra.GetType().GetProperties())
                    responseDict[prop.Name] = prop.GetValue(extra);
            }

            return Ok(responseDict);
        }

        // ─────────────────────────────────────────────────────────────────────
        // PRIVATE: Token Management (for direct Ascentis calls)
        // ─────────────────────────────────────────────────────────────────────

        private async Task<string> GetAuthTokenAsync()
        {
            if (_memoryCache.TryGetValue(TOKEN_CACHE_KEY, out string cachedToken) &&
                !string.IsNullOrEmpty(cachedToken))
            {
                _logger.LogDebug("🔑 Using cached Ascentis auth token");
                return cachedToken;
            }

            _logger.LogInformation("🔑 Fetching new Ascentis auth token from: {Url}", _ascentisSettings.TokenURL);

            var formData = new FormUrlEncodedContent(new[]
            {
                new KeyValuePair<string, string>("grant_type",    _ascentisSettings.GrantType),
                new KeyValuePair<string, string>("scope",         _ascentisSettings.Scope),
                new KeyValuePair<string, string>("client_id",     _ascentisSettings.ClientID),
                new KeyValuePair<string, string>("client_secret", _ascentisSettings.ClientSecret)
            });

            var request = new HttpRequestMessage(HttpMethod.Post, _ascentisSettings.TokenURL) { Content = formData };
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

            var response = await _httpClient.SendAsync(request);

            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadAsStringAsync();
                _logger.LogError("❌ Failed to obtain Ascentis token: {Status} - {Error}", response.StatusCode, error);
                throw new HttpRequestException($"Ascentis authentication failed: {response.StatusCode}");
            }

            var content = await response.Content.ReadAsStringAsync();
            var tokenResponse = JsonSerializer.Deserialize<AscentisTokenResponse>(content);

            if (string.IsNullOrEmpty(tokenResponse?.access_token))
                throw new InvalidOperationException("Ascentis returned an empty access token");

            _memoryCache.Set(TOKEN_CACHE_KEY, tokenResponse.access_token, new MemoryCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(55)
            });

            _logger.LogInformation("✅ Ascentis auth token obtained and cached (55 min)");
            return tokenResponse.access_token;
        }

        private async Task<HttpResponseMessage> SendCrmCommandAsync(object payload, bool retryOnUnauthorized = true)
        {
            var token = await GetAuthTokenAsync();
            var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions { PropertyNamingPolicy = null });

            var request = new HttpRequestMessage(HttpMethod.Post, _ascentisSettings.InstanceURL)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            };

            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            request.Headers.Add("SoapAction", SOAP_ACTION);

            var response = await _httpClient.SendAsync(request);

            if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized && retryOnUnauthorized)
            {
                _logger.LogWarning("⚠️ Ascentis returned 401 — clearing token cache and retrying");
                _memoryCache.Remove(TOKEN_CACHE_KEY);
                return await SendCrmCommandAsync(payload, retryOnUnauthorized: false);
            }

            return response;
        }

        /// <summary>
        /// Post Ascentis Sales transaction.
        /// POST: api/crm/PostAscentisSales
        /// </summary>
        [HttpPost("PostAscentisSales")]
        public async Task<IActionResult> PostAscentisSales([FromBody] AscentisPostSalesRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.CardNo))
                return BadRequest(new { success = false, error = "CardNo is required" });

            var (ok, sessionId, sessionError) = await ResolveSessionAsync();
            if (!ok) return sessionError!;

            _logger.LogInformation("🛒 PostAscentisSales started - CardNo: {CardNo}, ReceiptNo: {ReceiptNo}",
                request.CardNo, request.ReceiptNo);

            try
            {
                var data = await BuildDynamicPayload("SALES");

                // Merge all required fields
                data["EnquiryCode"] = !string.IsNullOrWhiteSpace(request.EnquiryCode)
                    ? request.EnquiryCode
                    : _configuration["Ascentis:EnquiryCode"];
                data["OutletCode"] = request.OutletCode ?? "ARC";
                data["PosID"] = request.PosID ?? "POS01";
                data["CashierID"] = request.CashierID ?? "WEBORDER";
                data["StoreCode"] = request.StoreCode ?? "ARC";
                data["IgnoreCCNchecking"] = "true";
                data["Command"] = "SALES";
                data["IsOffline"] = false;
                data["CardNo"] = request.CardNo;
                data["CVC"] = "";
                data["ReceiptNo"] = request.ReceiptNo ?? "";
                data["TransactDate"] = request.TransactDate ?? "";
                data["OriginalDate"] = null;
                data["TransactTime"] = string.IsNullOrEmpty(request.TransactDate) ? ""
                    : (request.TransactDate.Contains(' ') ? request.TransactDate.Split(' ')[1] : "");
                data["SalesAmt"] = request.SalesAmt;
                data["SalesAmtToCalculatePoints"] = Math.Round(request.SalesAmtToCalculatePoints, 2);
                data["SalesAmtToCalculateAR"] = 0;
                data["RedemptionVoucherLists"] = request.RedemptionVoucherLists ?? new List<object>();
                data["TransactDetailLists"] = request.TransactDetailLists ?? new List<object>();
                data["PaymentList"] = request.PaymentList ?? new List<object>();
                data["RunCampaign"] = true;
                data["CampaignType"] = "Sales Campaign";
                data["CheckQualificationRules"] = true;
                data["RetrieveMembershipInfo"] = true;
                data["RetrieveReceiptMessage"] = true;
                data["CheckReceiptNoDuplication"] = true;
                data["CheckOutletCodeDuplication"] = true;
                data["CheckOriginalDateDuplication"] = true;
                data["Ref1"] = request.Ref1 ?? "";
                data["Ref2"] = request.Ref2 ?? "";

                // === Log full payload ===
                _logger.LogInformation("📤 FULL PAYLOAD SENT TO ASCENTIS:\n{json}",
                    System.Text.Json.JsonSerializer.Serialize(data, new System.Text.Json.JsonSerializerOptions
                    { WriteIndented = true }));

                var apiResult = await CallPosAndReturn(
                    $"{_posCrmUrl}/post_ascentis_sales/01?sessionid={sessionId}",
                    data,
                    sessionId,
                    "PostAscentisSales",
                    extra: new { card_no = request.CardNo, receipt_no = request.ReceiptNo }
                );

                // Safe response logging
                object responseObj = null;
                if (apiResult is ObjectResult objResult && objResult.Value is { } resValue)
                {
                    responseObj = resValue;
                    var responseJson = System.Text.Json.JsonSerializer.Serialize(responseObj);
                    _logger.LogInformation("📥 ASCENTIS RESPONSE: {json}", responseJson);
                }

                // ✅ Write to log file
                LogPosCRM(
                    salesNo: request.ReceiptNo ?? "-",
                    module: "PostAscentisSales",
                    info: $"CardNo: {request.CardNo}",
                    req: data,
                    res: responseObj ?? new { note = "No response body" }
                );

                return apiResult;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "❌ PostAscentisSales error - ReceiptNo: {ReceiptNo}", request.ReceiptNo);

                // ✅ Also log the error to file
                LogPosCRM(
                    salesNo: request.ReceiptNo ?? "-",
                    module: "PostAscentisSales",
                    info: $"❌ Exception: {ex.Message}",
                    req: request,
                    res: new { error = ex.Message }
                );

                return StatusCode(500, new { success = false, error = ex.Message });
            }
        }


        private void LogPosCRM(string salesNo, string module, string info, object req, object res)
        {
            var now = DateTime.Now;
            _logger.LogInformation("🛒 {Module}: {Info} | SalesNo: {SalesNo}", module, info, salesNo ?? "-");

            try
            {
                var reqJson = Newtonsoft.Json.JsonConvert.SerializeObject(req);
                var resJson = Newtonsoft.Json.JsonConvert.SerializeObject(res);

                var logFilePath = GetPosOrderDailyLogFilePath();

                var entry = new StringBuilder();
                entry.AppendLine("==========================================================");
                entry.AppendLine($"Timestamp : {now:yyyy-MM-dd HH:mm:ss} (Local) | {DateTime.UtcNow:yyyy-MM-dd HH:mm:ss} UTC");
                entry.AppendLine($"Module    : {module}");
                entry.AppendLine($"SalesNo   : {salesNo ?? "-"}");
                entry.AppendLine($"Info      : {info}");
                entry.AppendLine($"Request   : {reqJson}");
                entry.AppendLine($"Response  : {resJson}");
                entry.AppendLine("==========================================================");
                entry.AppendLine();

                System.IO.File.AppendAllText(logFilePath, entry.ToString(), Encoding.UTF8);
                _logger.LogDebug("📄 PosCRM log written → {Path}", logFilePath);
            }
            catch (Exception fileEx)
            {
                _logger.LogWarning(fileEx, "⚠️ Could not write to PosCRM log file in: {Folder}", _posCRMLogBaseFolder);
            }
        }


        private string GetPosOrderDailyLogFilePath()
        {
            Directory.CreateDirectory(_posCRMLogBaseFolder);   // no-op if already exists
            var fileName = $"PostCRM_{DateTime.Now:yyyy-MM-dd}.txt";
            return Path.Combine(_posCRMLogBaseFolder, fileName);
        }


        // ─────────────────────────────────────────────────────────────────────
        // PUBLIC: DIRECT ASCENTIS ENDPOINTS
        // ─────────────────────────────────────────────────────────────────────

        [HttpPost("auth/token")]
        public async Task<IActionResult> RefreshToken()
        {
            try
            {
                _memoryCache.Remove(TOKEN_CACHE_KEY);
                var token = await GetAuthTokenAsync();
                return Ok(new
                {
                    success = true,
                    message = "Token refreshed successfully",
                    token_preview = token.Length > 20 ? $"{token.Substring(0, 20)}..." : token,
                    timestamp = DateTime.UtcNow
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "❌ Failed to refresh Ascentis token");
                return StatusCode(500, new { success = false, error = ex.Message });
            }
        }

        [HttpPost("card/enquiry")]
        public async Task<IActionResult> CardEnquiry([FromBody] AscentisCardEnquiryRequest request)
        {
            if (string.IsNullOrWhiteSpace(request?.CardNo) && string.IsNullOrWhiteSpace(request?.MemberID))
                return BadRequest(new { success = false, error = "CardNo or MemberID is required" });

            try
            {
                var payload = BuildBasePayload("CARD ENQUIRY");
                payload["MemberID"] = request.MemberID ?? "";
                payload["CardNo"] = request.CardNo ?? "";
                payload["CVC"] = request.CVC ?? "";
                payload["SVCurrency"] = request.SVCurrency ?? "";
                payload["RetrieveCVCInfo"] = request.RetrieveCVCInfo;
                payload["RetrieveMembershipInfo"] = request.RetrieveMembershipInfo;
                payload["RetrieveActiveVouchersList"] = request.RetrieveActiveVouchersList;
                payload["RetrieveJournalList"] = request.RetrieveJournalList;
                payload["RetrieveReceiptMessage"] = request.RetrieveReceiptMessage;
                payload["RetrievePtsToNextTier"] = request.RetrievePtsToNextTier;
                payload["RetrieveNettToNextTier"] = request.RetrieveNettToNextTier;
                payload["RetrieveEligibleFlag"] = request.RetrieveEligibleFlag;
                payload["RetrieveRedeemableVoucher"] = request.RetrieveRedeemableVoucher;
                payload["RetrieveVoucherSummary"] = request.RetrieveVoucherSummary;
                payload["RetrieveVoucherCap"] = request.RetrieveVoucherCap;
                payload["RequestDynamicColumnLists"] = request.RequestDynamicColumnLists;
                payload["RequestDynamicFieldLists"] = request.RequestDynamicFieldLists;
                payload["JournalfilterBy_Type"] = request.JournalfilterBy_Type;
                payload["FilterBy_VoucherNo"] = request.FilterBy_VoucherNo;
                payload["FilterBy_VoucherType"] = request.FilterBy_VoucherType;
                payload["FilterBy_VoucherTypeType"] = request.FilterBy_VoucherTypeType;
                payload["FilterBy_ValidFrom"] = request.FilterBy_ValidFrom;
                payload["FilterBy_ValidTo"] = request.FilterBy_ValidTo;
                payload["FilterBy_TriggerSource"] = request.FilterBy_TriggerSource;
                payload["SortOrder"] = request.SortOrder;
                payload["SortBy_VoucherNo"] = request.SortBy_VoucherNo;
                payload["SortBy_VoucherType"] = request.SortBy_VoucherType;
                payload["SortBy_ValidFrom"] = request.SortBy_ValidFrom;
                payload["SortBy_ValidTo"] = request.SortBy_ValidTo;
                payload["PageNumber"] = request.PageNumber;
                payload["PageCount"] = request.PageCount;

                var response = await SendCrmCommandAsync(payload);
                var content = await response.Content.ReadAsStringAsync();

                if (!response.IsSuccessStatusCode)
                    return StatusCode((int)response.StatusCode, new { success = false, error = content });

                var result = JsonSerializer.Deserialize<JsonElement>(content);
                return Ok(new { success = true, data = result, timestamp = DateTime.UtcNow });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "❌ Error in card enquiry");
                return StatusCode(500, new { success = false, error = ex.Message });
            }
        }

        [HttpPost("member/enquiry")]
        public async Task<IActionResult> MemberEnquiry([FromBody] AscentisMemberEnquiryRequest request)
        {
            if (string.IsNullOrWhiteSpace(request?.MobileNo) && string.IsNullOrWhiteSpace(request?.Email) &&
                string.IsNullOrWhiteSpace(request?.NRIC) && string.IsNullOrWhiteSpace(request?.MemberID))
                return BadRequest(new { success = false, error = "At least one of MobileNo, Email, NRIC or MemberID is required" });

            try
            {
                var payload = BuildBasePayload("MEMBER ENQUIRY");
                payload["MobileNo"] = request.MobileNo ?? "";
                payload["Email"] = request.Email ?? "";
                payload["NRIC"] = request.NRIC ?? "";
                payload["Passport"] = request.Passport ?? "";
                payload["Nationality"] = request.Nationality ?? "";
                payload["MemberID"] = request.MemberID ?? "";
                payload["FilterCardsByStatus"] = request.FilterCardsByStatus;
                payload["MobileNoExactSearch"] = request.MobileNoExactSearch;
                payload["RetrieveBase64ImageString"] = request.RetrieveBase64ImageString;
                payload["RetrievePtsToNextTier"] = request.RetrievePtsToNextTier;
                payload["RetrieveNettToNextTier"] = request.RetrieveNettToNextTier;
                payload["RetrieveJournalList"] = request.RetrieveJournalList;
                payload["JournalfilterBy_Type"] = request.JournalfilterBy_Type;
                payload["RequestDynamicColumnLists"] = request.RequestDynamicColumnLists;
                payload["RequestDynamicFieldLists"] = request.RequestDynamicFieldLists;
                payload["CardLists_PageNumber"] = request.CardLists_PageNumber;
                payload["CardLists_PageCount"] = request.CardLists_PageCount;

                var response = await SendCrmCommandAsync(payload);
                var content = await response.Content.ReadAsStringAsync();

                if (!response.IsSuccessStatusCode)
                    return StatusCode((int)response.StatusCode, new { success = false, error = content });

                var result = JsonSerializer.Deserialize<JsonElement>(content);
                return Ok(new { success = true, data = result, timestamp = DateTime.UtcNow });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "❌ Error in member enquiry");
                return StatusCode(500, new { success = false, error = ex.Message });
            }
        }

        [HttpPost("transaction/history")]
        public async Task<IActionResult> GetTransactionHistory([FromBody] AscentisTransactionHistoryRequest request)
        {
            if (string.IsNullOrWhiteSpace(request?.CardNo) && string.IsNullOrWhiteSpace(request?.FilterBy_ReceiptNo))
                return BadRequest(new { success = false, error = "CardNo or FilterBy_ReceiptNo is required" });

            try
            {
                var payload = BuildBasePayload("GET TRANSACTION HISTORY");
                payload["CardNo"] = request.CardNo ?? "";
                payload["MemberID"] = request.MemberID ?? "";
                payload["FilterBy_TransactDateFrom"] = request.FilterBy_TransactDateFrom ?? "";
                payload["FilterBy_TransactDateTo"] = request.FilterBy_TransactDateTo ?? "";
                payload["FilterBy_Mode"] = request.FilterBy_Mode;
                payload["FilterBy_TransactOutletCode"] = request.FilterBy_TransactOutletCode;
                payload["FilterBy_transactPOSID"] = request.FilterBy_transactPOSID;
                payload["FilterBy_ReceiptNo"] = request.FilterBy_ReceiptNo;
                payload["RetrieveTransactDetailInfo"] = request.RetrieveTransactDetailInfo;
                payload["RetrieveOnlinepaymentInfo"] = request.RetrieveOnlinepaymentInfo;
                payload["RetrievePaymentInfo"] = request.RetrievePaymentInfo;
                payload["RetrieveVoidedTransactions"] = request.RetrieveVoidedTransactions;
                payload["SortOrder"] = request.SortOrder;
                payload["SortByCycle"] = request.SortByCycle;
                payload["SortByProgramYear"] = request.SortByProgramYear;
                payload["SortByTransactDate"] = request.SortByTransactDate;
                payload["SortByTransactTime"] = request.SortByTransactTime;
                payload["SortByModeNameShort"] = request.SortByModeNameShort;
                payload["SortByMode"] = request.SortByMode;
                payload["SortByOutlet"] = request.SortByOutlet;
                payload["SortByReceiptNo"] = request.SortByReceiptNo;
                payload["SortByAmountSpent"] = request.SortByAmountSpent;
                payload["SortByTransactPoints"] = request.SortByTransactPoints;
                payload["SortByVoidBy"] = request.SortByVoidBy;
                payload["SortByVoidOn"] = request.SortByVoidOn;
                payload["SortByRemarks"] = request.SortByRemarks;
                payload["PageNumber"] = request.PageNumber;
                payload["PageCount"] = request.PageCount;

                var response = await SendCrmCommandAsync(payload);
                var content = await response.Content.ReadAsStringAsync();

                if (!response.IsSuccessStatusCode)
                    return StatusCode((int)response.StatusCode, new { success = false, error = content });

                var result = JsonSerializer.Deserialize<JsonElement>(content);
                return Ok(new { success = true, data = result, timestamp = DateTime.UtcNow });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "❌ Error in transaction history");
                return StatusCode(500, new { success = false, error = ex.Message });
            }
        }

        [HttpPost("sales")]
        public async Task<IActionResult> PostSales([FromBody] AscentisSalesRequest request)
        {
            if (string.IsNullOrWhiteSpace(request?.CardNo))
                return BadRequest(new { success = false, error = "CardNo is required" });
            if (string.IsNullOrWhiteSpace(request.ReceiptNo))
                return BadRequest(new { success = false, error = "ReceiptNo is required" });

            try
            {
                var payload = BuildBasePayload("SALES");
                payload["IsOffline"] = request.IsOffline;
                payload["CardNo"] = request.CardNo;
                payload["CVC"] = request.CVC;
                payload["ReceiptNo"] = request.ReceiptNo;
                payload["TransactDate"] = request.TransactDate ?? "";
                payload["OriginalDate"] = request.OriginalDate ?? "";
                payload["TransactTime"] = request.TransactTime ?? "";
                payload["PointsCalculationType"] = request.PointsCalculationType;
                payload["SalesAmt"] = request.SalesAmt;
                payload["SalesAmtToCalculatePoints"] = request.SalesAmtToCalculatePoints;
                payload["SalesAmtToCalculateAR"] = request.SalesAmtToCalculateAR;
                payload["RedemptionVoucherLists"] = request.RedemptionVoucherLists;
                payload["RedemptionPhysicalVoucherLists"] = request.RedemptionPhysicalVoucherLists;
                payload["RedemptionItemLists"] = request.RedemptionItemLists;
                payload["RedemptionItemPointsUsage"] = request.RedemptionItemPointsUsage;
                payload["TransactDetailLists"] = request.TransactDetailLists;
                payload["PaymentList"] = request.PaymentList;
                payload["CheckReceiptNoDuplication"] = request.CheckReceiptNoDuplication;
                payload["CheckOutletCodeDuplication"] = request.CheckOutletCodeDuplication;
                payload["CheckOriginalDateDuplication"] = request.CheckOriginalDateDuplication;
                payload["CheckPOSIDDuplication"] = request.CheckPOSIDDuplication;
                payload["RunCampaign"] = request.RunCampaign;
                payload["CampaignType"] = request.CampaignType;
                payload["CampaignCode"] = request.CampaignCode;
                payload["CheckQualificationRules"] = request.CheckQualificationRules;
                payload["RetrieveMembershipInfo"] = request.RetrieveMembershipInfo;
                payload["RetrieveActiveVouchersLists"] = request.RetrieveActiveVouchersLists;
                payload["SendPtsRbtsRedemptionNotification"] = request.SendPtsRbtsRedemptionNotification;
                payload["SortOrder"] = request.SortOrder;
                payload["PageNumber"] = request.PageNumber;
                payload["PageCount"] = request.PageCount;
                payload["Remarks"] = request.Remarks;
                payload["SendPushNotificationOnSuccess"] = request.SendPushNotificationOnSuccess;
                payload["Ref1"] = request.Ref1; payload["Ref2"] = request.Ref2;
                payload["Ref3"] = request.Ref3; payload["Ref4"] = request.Ref4;
                payload["Ref5"] = request.Ref5; payload["Ref6"] = request.Ref6;
                payload["Ref7"] = request.Ref7;
                payload["RetrieveReceiptMessage"] = request.RetrieveReceiptMessage;

                var response = await SendCrmCommandAsync(payload);
                var content = await response.Content.ReadAsStringAsync();

                if (!response.IsSuccessStatusCode)
                    return StatusCode((int)response.StatusCode, new { success = false, error = content });

                var result = JsonSerializer.Deserialize<JsonElement>(content);

                if (result.TryGetProperty("ReturnStatus", out var status) && status.GetInt32() != 1)
                {
                    var message = result.TryGetProperty("ReturnMessage", out var msg) ? msg.GetString() : "Unknown CRM error";
                    return UnprocessableEntity(new { success = false, error = message, data = result });
                }

                return Ok(new { success = true, data = result, timestamp = DateTime.UtcNow });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "❌ Error in sales transaction");
                return StatusCode(500, new { success = false, error = ex.Message });
            }
        }

        /// <summary>
        /// Post Ascentis Voucher Redemption transaction.
        /// POST: api/crm/PostAscentisVoucherRedemption
        /// </summary>
        [HttpPost("PostAscentisVoucherRedemption")]
        public async Task<IActionResult> PostAscentisVoucherRedemption([FromBody] AscentisVoucherRedemptionRequest request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.CardNo))
                return BadRequest(new { success = false, error = "CardNo is required" });

            if (request.RedemptionVoucherLists == null || request.RedemptionVoucherLists.Count == 0)
                return BadRequest(new { success = false, error = "RedemptionVoucherLists is required and cannot be empty" });

            var (ok, sessionId, sessionError) = await ResolveSessionAsync();
            if (!ok) return sessionError!;

            _logger.LogInformation("🎟️ PostAscentisVoucherRedemption - CardNo: {CardNo}, ReceiptNo: {ReceiptNo}, Vouchers: {Count}",
                request.CardNo, request.ReceiptNo, request.RedemptionVoucherLists.Count);

            try
            {
                var data = await BuildDynamicPayload("VOUCHER REDEMPTION");

                data["CardNo"] = request.CardNo;
                data["CVC"] = "";
                data["PIN"] = "";
                data["ReceiptNo"] = request.ReceiptNo ?? "";
                data["TransactDate"] = request.TransactDate ?? DateTime.Now.ToString("yyyy/MM/dd HH:mm:ss");
                data["OriginalDate"] = (object?)null;
                data["TransactTime"] = request.TransactTime
                                        ?? DateTime.Now.ToString("HH:mm:ss");
                data["Remarks"] = request.Remarks ?? "";

                data["CheckReceiptNoDuplication"] = false;
                data["CheckOutletCodeDuplication"] = false;
                data["CheckOriginalDateDuplication"] = false;
                data["CheckPOSIDDuplication"] = false;

                data["RedemptionVoucherLists"] = request.RedemptionVoucherLists;

                data["RetrieveMembershipInfo"] = true;
                data["RetrieveActiveVouchersList"] = false;
                data["FilterBy_VoucherNo"] = "";
                data["FilterBy_VoucherType"] = "";
                data["FilterBy_ValidFrom"] = "";
                data["FilterBy_ValidTo"] = "";
                data["FilterBy_TriggerSource"] = "";
                data["SortOrder"] = "ASC";
                data["SortBy_VoucherNo"] = false;
                data["SortBy_VoucherType"] = false;
                data["SortBy_ValidFrom"] = false;
                data["SortBy_ValidTo"] = true;
                data["PageNumber"] = 1;
                data["PageCount"] = 99;

                data["SendPushNotificationOnSuccess"] = false;
                data["Sound"] = "Sound1";
                data["Badge"] = (object?)null;
                data["Ref1"] = request.Ref1 ?? "";
                data["Ref2"] = request.Ref2 ?? "";
                data["Ref3"] = request.Ref3 ?? "";
                data["Ref4"] = request.Ref4 ?? "";
                data["Ref5"] = request.Ref5 ?? "";
                data["Ref6"] = request.Ref6 ?? "";
                data["Ref7"] = request.Ref7 ?? "";

                return await CallPosAndReturn(
                    $"{_posCrmUrl}/post_ascentis_voucherRedem/01?sessionid={sessionId}",
                    data, sessionId, "PostAscentisVoucherRedemption",
                    extra: new { card_no = request.CardNo, receipt_no = request.ReceiptNo }
                );
            }
            catch (InvalidOperationException ex)
            {
                _logger.LogError(ex, "❌ Payload build failed — missing CRM config");
                return StatusCode(503, new { success = false, error = ex.Message });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "❌ Error in PostAscentisVoucherRedemption");
                return StatusCode(500, new { success = false, error = ex.Message });
            }
        }

        [HttpPost("voiding")]
        public async Task<IActionResult> Voiding([FromBody] AscentisVoidingRequest request)
        {
            if (string.IsNullOrWhiteSpace(request?.CardNo))
                return BadRequest(new { success = false, error = "CardNo is required" });
            if (string.IsNullOrWhiteSpace(request.OriginalReceiptNo))
                return BadRequest(new { success = false, error = "OriginalReceiptNo is required" });

            try
            {
                var payload = BuildBasePayload("VOIDING");
                payload["CardNo"] = request.CardNo;
                payload["OriginalReceiptNo"] = request.OriginalReceiptNo;
                payload["OriginalOutletCode"] = request.OriginalOutletCode ?? "";
                payload["OriginalTransactDate"] = request.OriginalTransactDate ?? "";
                payload["OriginalPOSID"] = request.OriginalPOSID ?? "";
                payload["VoidTransactionType"] = request.VoidTransactionType;
                payload["TransactRefID"] = request.TransactRefID;
                payload["TransactAutoID"] = request.TransactAutoID;
                payload["VoidItemLists"] = request.VoidItemLists;
                payload["VoidVoucherLists"] = request.VoidVoucherLists;
                payload["TransactDate"] = request.TransactDate ?? "";
                payload["TransactTime"] = request.TransactTime ?? "";
                payload["Remarks"] = request.Remarks;
                payload["RunCampaign"] = request.RunCampaign;
                payload["CampaignType"] = request.CampaignType;
                payload["CampaignCode"] = request.CampaignCode;
                payload["CheckQualificationRules"] = request.CheckQualificationRules;
                payload["RetrieveMembershipInfo"] = request.RetrieveMembershipInfo;
                payload["RetrieveActiveVouchersList"] = request.RetrieveActiveVouchersList;
                payload["SortOrder"] = request.SortOrder;
                payload["PageNumber"] = request.PageNumber;
                payload["PageCount"] = request.PageCount;
                payload["Ref1"] = request.Ref1; payload["Ref2"] = request.Ref2;
                payload["Ref3"] = request.Ref3; payload["Ref4"] = request.Ref4;
                payload["Ref5"] = request.Ref5; payload["Ref6"] = request.Ref6;
                payload["Ref7"] = request.Ref7;
                payload["RetrieveReceiptMessage"] = request.RetrieveReceiptMessage;

                var response = await SendCrmCommandAsync(payload);
                var content = await response.Content.ReadAsStringAsync();

                if (!response.IsSuccessStatusCode)
                    return StatusCode((int)response.StatusCode, new { success = false, error = content });

                var result = JsonSerializer.Deserialize<JsonElement>(content);

                if (result.TryGetProperty("ReturnStatus", out var status) && status.GetInt32() != 1)
                {
                    var message = result.TryGetProperty("ReturnMessage", out var msg) ? msg.GetString() : "Unknown CRM error";
                    return UnprocessableEntity(new { success = false, error = message, data = result });
                }

                return Ok(new { success = true, data = result, timestamp = DateTime.UtcNow });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "❌ Error in voiding");
                return StatusCode(500, new { success = false, error = ex.Message });
            }
        }

        [HttpGet("health")]
        public IActionResult Health()
        {
            var hasToken = _memoryCache.TryGetValue(TOKEN_CACHE_KEY, out string _);
            var hasSession = _memoryCache.TryGetValue("POS_SESSION_ID", out string _);
            var hasCrmSettings = _memoryCache.TryGetValue(CRM_SETTINGS_CACHE_KEY, out Dictionary<string, string> _);
            var isConfigured =
                !string.IsNullOrWhiteSpace(_ascentisSettings.TokenURL) &&
                !string.IsNullOrWhiteSpace(_ascentisSettings.InstanceURL) &&
                !string.IsNullOrWhiteSpace(_posCrmUrl);

            return Ok(new
            {
                success = true,
                status = "healthy",
                crmVendor = "Ascentis",
                isConfigured,
                tokenCached = hasToken,
                sessionCached = hasSession,
                crmSettingsCached = hasCrmSettings,
                posCrmUrl = _posCrmUrl,
                instanceUrl = _ascentisSettings.InstanceURL,
                timestamp = DateTime.UtcNow
            });
        }
    }
}