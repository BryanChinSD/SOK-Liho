namespace PROD_LIHO_SOK.Models
{
    public class AscentisSettings
    {
        public string TokenURL { get; set; }
        public string InstanceURL { get; set; }
        public string GrantType { get; set; }
        public string Scope { get; set; }
        public string ClientID { get; set; }
        public string ClientSecret { get; set; }
        public string AuthToken { get; set; }
        public string EnquiryCode { get; set; }
        public string OutletCode { get; set; }
        public string PosID { get; set; }
        public string CashierID { get; set; }
        public bool IgnoreCCNchecking { get; set; }
    }

    // ─── Auth ────────────────────────────────────────────────────────────────

    public class AscentisTokenResponse
    {
        public string access_token { get; set; }
        public string token_type { get; set; }
        public int expires_in { get; set; }
        public string scope { get; set; }
    }

    // ─── Card Enquiry ────────────────────────────────────────────────────────

    public class AscentisCardEnquiryRequest
    {
        public string? CardNo { get; set; }
        public string? MemberID { get; set; }
        public string? CVC { get; set; }
        public string? SVCurrency { get; set; }
        public bool RetrieveCVCInfo { get; set; } = false;
        public bool RetrieveMembershipInfo { get; set; } = true;
        public bool RetrieveActiveVouchersList { get; set; } = true;
        public bool RetrieveJournalList { get; set; } = false;
        public bool RetrieveReceiptMessage { get; set; } = true;
        public bool RetrievePtsToNextTier { get; set; } = false;
        public bool RetrieveNettToNextTier { get; set; } = false;
        public bool RetrieveEligibleFlag { get; set; } = false;
        public bool RetrieveRedeemableVoucher { get; set; } = false;
        public bool RetrieveVoucherSummary { get; set; } = false;
        public bool RetrieveVoucherCap { get; set; } = false;
        public List<object> RequestDynamicColumnLists { get; set; } = new();
        public List<object> RequestDynamicFieldLists { get; set; } = new();
        public string JournalfilterBy_Type { get; set; } = "";
        public string FilterBy_VoucherNo { get; set; } = "";
        public string FilterBy_VoucherType { get; set; } = "";
        public string FilterBy_VoucherTypeType { get; set; } = "";
        public string FilterBy_ValidFrom { get; set; } = "";
        public string FilterBy_ValidTo { get; set; } = "";
        public string FilterBy_TriggerSource { get; set; } = "";
        public string SortOrder { get; set; } = "ASC";
        public bool SortBy_VoucherNo { get; set; } = false;
        public bool SortBy_VoucherType { get; set; } = false;
        public bool SortBy_ValidFrom { get; set; } = false;
        public bool SortBy_ValidTo { get; set; } = true;
        public int PageNumber { get; set; } = 1;
        public int PageCount { get; set; } = 99;
    }

    // ─── Member Enquiry ──────────────────────────────────────────────────────

    public class AscentisMemberEnquiryRequest
    {
        public string? MobileNo { get; set; }
        public string? Email { get; set; }
        public string? NRIC { get; set; }
        public string? Passport { get; set; }
        public string? Nationality { get; set; }
        public string? MemberID { get; set; }
        public string FilterCardsByStatus { get; set; } = "ACTIVE";
        public bool MobileNoExactSearch { get; set; } = false;
        public bool RetrieveBase64ImageString { get; set; } = false;
        public bool RetrievePtsToNextTier { get; set; } = false;
        public bool RetrieveNettToNextTier { get; set; } = false;
        public bool RetrieveJournalList { get; set; } = false;
        public string JournalfilterBy_Type { get; set; } = "";
        public List<object> RequestDynamicColumnLists { get; set; } = new();
        public List<object> RequestDynamicFieldLists { get; set; } = new();
        public int CardLists_PageNumber { get; set; } = 1;
        public int CardLists_PageCount { get; set; } = 99;

        public string? StoreName { get; set; }
        public string? RegisterName { get; set; }
    }

    // ─── Transaction History ─────────────────────────────────────────────────

    public class AscentisTransactionHistoryRequest
    {
        public string? CardNo { get; set; }
        public string? MemberID { get; set; }
        public string? FilterBy_TransactDateFrom { get; set; }
        public string? FilterBy_TransactDateTo { get; set; }
        public string FilterBy_Mode { get; set; } = "";
        public string FilterBy_TransactOutletCode { get; set; } = "";
        public string FilterBy_transactPOSID { get; set; } = "";
        public string FilterBy_ReceiptNo { get; set; } = "";
        public bool RetrieveTransactDetailInfo { get; set; } = false;
        public bool RetrieveOnlinepaymentInfo { get; set; } = false;
        public bool RetrievePaymentInfo { get; set; } = false;
        public bool RetrieveVoidedTransactions { get; set; } = false;
        public string SortOrder { get; set; } = "DESC";
        public bool SortByCycle { get; set; } = false;
        public bool SortByProgramYear { get; set; } = false;
        public bool SortByTransactDate { get; set; } = false;
        public bool SortByTransactTime { get; set; } = false;
        public bool SortByModeNameShort { get; set; } = false;
        public bool SortByMode { get; set; } = false;
        public bool SortByOutlet { get; set; } = false;
        public bool SortByReceiptNo { get; set; } = false;
        public bool SortByAmountSpent { get; set; } = false;
        public bool SortByTransactPoints { get; set; } = false;
        public bool SortByVoidBy { get; set; } = false;
        public bool SortByVoidOn { get; set; } = false;
        public bool SortByRemarks { get; set; } = false;
        public int PageNumber { get; set; } = 1;
        public int PageCount { get; set; } = 99;
    }

    // ─── Sales ───────────────────────────────────────────────────────────────

    public class AscentisTransactDetail
    {
        public string Department_Code { get; set; } = "";
        public string SubDepartment_Code { get; set; } = "";
        public string Category_Code { get; set; } = "";
        public string SubCategory_Code { get; set; } = "";
        public string Brand_Code { get; set; } = "";
        public string Level_Code { get; set; } = "";
        public string? ItemCode { get; set; }
        public string? Description { get; set; }
        public decimal Qty { get; set; }
        public decimal Price { get; set; }
        public decimal? Points { get; set; }
        public decimal DiscountPer { get; set; } = 0;
        public decimal Nett { get; set; }
        public int LineNo { get; set; } = 1;
        public string Ref1 { get; set; } = "";
        public string Ref2 { get; set; } = "";
        public string Ref3 { get; set; } = "";
        public string Ref4 { get; set; } = "";
        public string Ref5 { get; set; } = "";
        public string Ref6 { get; set; } = "";
        public string Ref7 { get; set; } = "";
    }

    public class AscentisPaymentInfo
    {
        public string? Type { get; set; }
        public string? Mode { get; set; }
        public decimal Value { get; set; }
        public string Currency { get; set; } = "SGD";
        public int LineNo { get; set; } = 1;
        public decimal CurRate { get; set; } = 0;
        public string ForeignCurrency { get; set; } = "";
        public decimal ForeignCurrencyValue { get; set; } = 0;
        public string CardName { get; set; } = "";
        public string Ref1 { get; set; } = "";
        public string Ref2 { get; set; } = "";
        public string Ref3 { get; set; } = "";
        public string Ref4 { get; set; } = "";
        public string Ref5 { get; set; } = "";
        public string Ref6 { get; set; } = "";
        public string Ref7 { get; set; } = "";
    }

    public class AscentisVoucherItem
    {
        public string? VoucherNo { get; set; }
    }

    public class AscentisSalesRequest
    {
        public string CardNo { get; set; } = "";
        public string? CVC { get; set; }
        public string ReceiptNo { get; set; } = "";
        public string? TransactDate { get; set; }
        public string? OriginalDate { get; set; }
        public string? TransactTime { get; set; }
        public int PointsCalculationType { get; set; } = 3;
        public bool IsOffline { get; set; } = false;
        public decimal SalesAmt { get; set; }
        public decimal SalesAmtToCalculatePoints { get; set; }
        public decimal SalesAmtToCalculateAR { get; set; } = 0;
        public List<AscentisVoucherItem> RedemptionVoucherLists { get; set; } = new();
        public List<object> RedemptionPhysicalVoucherLists { get; set; } = new();
        public List<object> RedemptionItemLists { get; set; } = new();
        public string RedemptionItemPointsUsage { get; set; } = "";
        public List<AscentisTransactDetail> TransactDetailLists { get; set; } = new();
        public List<AscentisPaymentInfo> PaymentList { get; set; } = new();
        public bool CheckReceiptNoDuplication { get; set; } = true;
        public bool CheckOutletCodeDuplication { get; set; } = true;
        public bool CheckOriginalDateDuplication { get; set; } = true;
        public bool CheckPOSIDDuplication { get; set; } = true;
        public bool RunCampaign { get; set; } = true;
        public string CampaignType { get; set; } = "Sales Campaign";
        public string CampaignCode { get; set; } = "";
        public bool CheckQualificationRules { get; set; } = true;
        public bool RetrieveMembershipInfo { get; set; } = false;
        public bool RetrieveActiveVouchersLists { get; set; } = false;
        public bool SendPtsRbtsRedemptionNotification { get; set; } = false;
        public string SortOrder { get; set; } = "ASC";
        public int PageNumber { get; set; } = 1;
        public int PageCount { get; set; } = 99;
        public string Remarks { get; set; } = "";
        public bool SendPushNotificationOnSuccess { get; set; } = false;
        public string Ref1 { get; set; } = "";
        public string Ref2 { get; set; } = "";
        public string Ref3 { get; set; } = "";
        public string Ref4 { get; set; } = "";
        public string Ref5 { get; set; } = "";
        public string Ref6 { get; set; } = "";
        public string Ref7 { get; set; } = "";
        public bool RetrieveReceiptMessage { get; set; } = false;
    }

    // ─── Voiding ─────────────────────────────────────────────────────────────

    public class AscentisVoidingRequest
    {
        public string CardNo { get; set; } = "";
        public string? OriginalReceiptNo { get; set; }
        public string? OriginalOutletCode { get; set; }
        public string? OriginalTransactDate { get; set; }
        public string? OriginalPOSID { get; set; }
        public string VoidTransactionType { get; set; } = "SALES";
        public string TransactRefID { get; set; } = "";
        public int? TransactAutoID { get; set; } = null;
        public List<object> VoidItemLists { get; set; } = new();
        public List<object> VoidVoucherLists { get; set; } = new();
        public string? TransactDate { get; set; }
        public string? TransactTime { get; set; }
        public string Remarks { get; set; } = "";
        public bool RunCampaign { get; set; } = true;
        public string CampaignType { get; set; } = "Downgrade Campaign";
        public string CampaignCode { get; set; } = "";
        public bool CheckQualificationRules { get; set; } = true;
        public bool RetrieveMembershipInfo { get; set; } = false;
        public bool RetrieveActiveVouchersList { get; set; } = false;
        public string SortOrder { get; set; } = "ASC";
        public int PageNumber { get; set; } = 1;
        public int PageCount { get; set; } = 99;
        public string Ref1 { get; set; } = "";
        public string Ref2 { get; set; } = "";
        public string Ref3 { get; set; } = "";
        public string Ref4 { get; set; } = "";
        public string Ref5 { get; set; } = "";
        public string Ref6 { get; set; } = "";
        public string Ref7 { get; set; } = "";
        public bool RetrieveReceiptMessage { get; set; } = false;
    }


    public class AscentisPostSalesRequest
    {
        public string? EnquiryCode { get; set; }
        public string CardNo { get; set; } = "";
        public string? ReceiptNo { get; set; }
        public string? TransactDate { get; set; }
        public double SalesAmt { get; set; }
        public double SalesAmtToCalculatePoints { get; set; }

        // New fields added
        public string? OutletCode { get; set; }
        public string? PosID { get; set; }
        public string? CashierID { get; set; }
        public string? StoreCode { get; set; }

        public List<object>? RedemptionVoucherLists { get; set; }
        public List<object>? TransactDetailLists { get; set; }
        public List<object>? PaymentList { get; set; }

        public string? Ref1 { get; set; }
        public string? Ref2 { get; set; }
        public string? Ref3 { get; set; }
        public string? Ref4 { get; set; }
        public string? Ref5 { get; set; }
        public string? Ref6 { get; set; }
        public string? Ref7 { get; set; }
    }

    public class AscentisVoucherRedemptionRequest
    {
        public string CardNo { get; set; } = "";
        public string? ReceiptNo { get; set; }
        public string? TransactDate { get; set; }
        public string? TransactTime { get; set; }
        public string? Remarks { get; set; }
        public List<AscentisVoucherRedemptionItem> RedemptionVoucherLists { get; set; } = new();
        public string? Ref1 { get; set; }
        public string? Ref2 { get; set; }
        public string? Ref3 { get; set; }
        public string? Ref4 { get; set; }
        public string? Ref5 { get; set; }
        public string? Ref6 { get; set; }
        public string? Ref7 { get; set; }
    }

    public class AscentisVoucherRedemptionItem
    {
        public string VoucherNo { get; set; } = "";
    }
}