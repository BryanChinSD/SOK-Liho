using System.Text.Json.Serialization;

namespace PROD_LIHO_SOK.Models
{
    // A930 Payment Response
    public class A930Response
    {
        [JsonPropertyName("responce_code")]
        public string ResponceCode { get; set; }

        [JsonPropertyName("responce_info")]
        public string ResponceInfo { get; set; }
    }

    // NETS Debit Payment Response
    public class NetsResponse
    {
        [JsonPropertyName("responseCode")]
        public string ResponseCode { get; set; }

        [JsonPropertyName("approvalCode")]
        public string ApprovalCode { get; set; }

        [JsonPropertyName("s_ECN")]
        public string S_ECN { get; set; }
    }

    // Alias for case variations
    public class NETSResponse : NetsResponse { }

    // NETS Credit Payment Response
    public class NetsCreditResponse
    {
        [JsonPropertyName("responseCode")]
        public string ResponseCode { get; set; }

        [JsonPropertyName("responseDesc")]
        public string ResponseDesc { get; set; }

        [JsonPropertyName("issuerName_Raw")]
        public string IssuerName_Raw { get; set; }

        [JsonPropertyName("cardNumber_Raw")]
        public string CardNumber_Raw { get; set; }

        [JsonPropertyName("approvalCode_Raw")]
        public string ApprovalCode_Raw { get; set; }

        [JsonPropertyName("rrN_Raw")]
        public string RrN_Raw { get; set; }

        [JsonPropertyName("invoiceNumber_Raw")]
        public string InvoiceNumber_Raw { get; set; }

        [JsonPropertyName("terminalID_Raw")]
        public string TerminalID_Raw { get; set; }

        [JsonPropertyName("merchantID_Raw")]
        public string MerchantID_Raw { get; set; }

        [JsonPropertyName("batchNumber_Raw")]
        public string BatchNumber_Raw { get; set; }

        [JsonPropertyName("transactionDate_Raw")]
        public string TransactionDate_Raw { get; set; }

        [JsonPropertyName("transactionTime_Raw")]
        public string TransactionTime_Raw { get; set; }

        [JsonPropertyName("cardType_Raw")]
        public string CardType_Raw { get; set; }

        [JsonPropertyName("entryType_Raw")]
        public string EntryType_Raw { get; set; }

        [JsonPropertyName("terminaL_TYPE")]
        public string TerminaL_TYPE { get; set; }

        [JsonPropertyName("s_ECN")]
        public string S_ECN { get; set; }

        [JsonPropertyName("r_ECN")]
        public string R_ECN { get; set; }

        [JsonPropertyName("ecn")]
        public string ECN { get; set; }
    }

    // UOB Payment Response
    public class UobResponse
    {
        [JsonPropertyName("responseCode")]
        public string ResponseCode { get; set; }

        [JsonPropertyName("responseDesc")] // Missing property added
        public string ResponseDesc { get; set; }

        [JsonPropertyName("responseAction")] // Missing property added
        public string ResponseAction { get; set; }

        [JsonPropertyName("issuerName_Raw")]
        public string IssuerName_Raw { get; set; }

        [JsonPropertyName("alipayOrderNo_Raw")]
        public string AlipayOrderNo_Raw { get; set; }

        [JsonPropertyName("cardNumber_Raw")]
        public string CardNumber_Raw { get; set; }

        [JsonPropertyName("s_ECN")]
        public string S_ECN { get; set; }
    }

    // Alias for case variations
    public class UOBResponse : UobResponse { }

    // OCBC Payment Response
    public class OcbcResponse
    {
        [JsonPropertyName("responseCode")]
        public string ResponseCode { get; set; }

        [JsonPropertyName("cardlabel")]
        public string CardLabel { get; set; }

        [JsonPropertyName("pan")]
        public string Pan { get; set; }

        [JsonPropertyName("alipayOrderNo_Raw")]
        public string AlipayOrderNo_Raw { get; set; }

        [JsonPropertyName("s_ECN")]
        public string S_ECN { get; set; }
    }

    // Alias for case variations
    public class OCBCResponse : OcbcResponse { }

    // Error Response for timeout handling
    public class NetsErrorResponse
    {
        [JsonPropertyName("s_ECN")]
        public string S_ECN { get; set; }

        [JsonPropertyName("S_ECN")]
        public string S_ECN_Upper { get; set; }
    }

    // Alias for case variations
    public class NETSErrorResponse : NetsErrorResponse { }
}

public class PaymentFailedRequest
{
    [JsonPropertyName("deviceId")]
    public string DeviceId { get; set; } = string.Empty;

    [JsonPropertyName("orderId")]
    public string OrderId { get; set; } = string.Empty;

    [JsonPropertyName("paymentMethod")]
    public string? PaymentMethod { get; set; }

    [JsonPropertyName("amount")]
    public decimal Amount { get; set; }

    [JsonPropertyName("errorCode")]
    public string? ErrorCode { get; set; }

    [JsonPropertyName("errorMessage")]
    public string ErrorMessage { get; set; } = "Payment failed";
}