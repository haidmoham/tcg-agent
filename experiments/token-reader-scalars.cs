using System.Globalization;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

const string payload = """
{"declaredString":"2026-10-19T12:34:56.1234567Z","objectDate":"2026-10-19T12:34:56.1234567Z","declaredDate":"2026-10-19T12:34:56.1234567Z","declaredDecimal":0.1234567890123456789012345678,"objectNumber":0.1234567890123456789012345678}
""";
var direct = JsonConvert.DeserializeObject<ScalarFields>(payload)!;
var variants = new Dictionary<string, ScalarFields>
{
    ["json-text"] = direct,
    ["token-default"] = JsonSerializer.CreateDefault().Deserialize<ScalarFields>(new JTokenReader(JToken.Parse(payload)))!,
};
using (var text = new JsonTextReader(new StringReader(payload)) { DateParseHandling = DateParseHandling.None })
{
    variants["token-date-none"] = JsonSerializer.CreateDefault().Deserialize<ScalarFields>(new JTokenReader(JToken.Load(text)))!;
}
var fields = typeof(ScalarFields).GetProperties();
var rows = variants.Select(variant => new
{
    variant = variant.Key,
    fields = fields.ToDictionary(field => field.Name, field => Scalar(field.GetValue(variant.Value))),
    mismatches = fields.Where(field => Scalar(field.GetValue(variant.Value)) != Scalar(field.GetValue(direct))).Select(field => field.Name).ToArray(),
}).ToArray();
const string trailing = "{} {}";
var additionalContent = new Dictionary<string, object>
{
    ["JsonConvert-default"] = Outcome(() => JsonConvert.DeserializeObject<ScalarFields>(trailing)),
    ["JsonSerializer-default"] = Outcome(() => JsonSerializer.CreateDefault().Deserialize<ScalarFields>(new JsonTextReader(new StringReader(trailing)))),
    ["JsonSerializer-check-true"] = Outcome(() =>
    {
        var serializer = JsonSerializer.CreateDefault();
        serializer.CheckAdditionalContent = true;
        return serializer.Deserialize<ScalarFields>(new JsonTextReader(new StringReader(trailing)));
    }),
    ["JToken.Parse-default"] = Outcome(() => JToken.Parse(trailing)),
};
Console.WriteLine(JsonConvert.SerializeObject(new
{
    schema = "token-reader-scalar-gate/1",
    purpose = "Correctness-only original scalar experiment. No native game or performance measurement.",
    assembly = typeof(JsonConvert).Assembly.FullName,
    payload,
    rows,
    additionalContent,
    verdict = "reject-generic-equivalence",
}, Formatting.Indented));

static ScalarValue Scalar(object? value) => new(value?.GetType().FullName ?? "null", value switch
{
    null => "null",
    DateTime date => date.ToString("O", CultureInfo.InvariantCulture) + ";Kind=" + date.Kind,
    decimal number => number.ToString("G29", CultureInfo.InvariantCulture),
    double number => number.ToString("R", CultureInfo.InvariantCulture),
    IFormattable formatted => formatted.ToString(null, CultureInfo.InvariantCulture),
    _ => value.ToString()!,
});

static object Outcome(Func<object?> operation)
{
    try { operation(); return new { accepted = true, exception = (string?)null }; }
    catch (Exception exception) { return new { accepted = false, exception = exception.GetType().FullName }; }
}

record ScalarValue(string Type, string Value);

sealed class ScalarFields
{
    public string? DeclaredString { get; set; }
    public object? ObjectDate { get; set; }
    public DateTime DeclaredDate { get; set; }
    public decimal DeclaredDecimal { get; set; }
    public object? ObjectNumber { get; set; }
}
