using System.Security.Cryptography;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using MatchLogic;
using Indigo.VisibleRules;

Console.InputEncoding = Console.OutputEncoding = new UTF8Encoding(false);
var pipe = Console.Out;
Console.SetOut(TextWriter.Null);
var location = typeof(MatchUtils).Assembly.Location;
var rulesHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(location))).ToLowerInvariant();
if (args.Length != 1 || args[0] != rulesHash) throw new InvalidDataException("explicit pinned rules assembly hash required");
var methods = new JsonObject();
foreach (var (type, name) in new[] { (typeof(MatchUtils), "EnergyValueContained"),
    (typeof(MatchUtils), "RemoveInvalidProvidedEntries"), (typeof(MatchUtils), "CheckForEnergyFulfillmentString"),
    (typeof(MatchUtils).Assembly.GetType("MatchLogic.MoveColorlessToTheEndComparer")!, "Compare") })
{
    var body = type.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance)!
        .GetMethodBody()!.GetILAsByteArray()!;
    methods[type.FullName + "." + name] = Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant();
}
string? line;
while ((line = Console.ReadLine()) != null)
{
    if (Encoding.UTF8.GetByteCount(line) > 4 * 1024 * 1024) break;
    JsonNode? request = null;
    JsonObject response;
    var close = false;
    try
    {
        request = JsonNode.Parse(line) ?? throw new InvalidDataException("request required");
        var id = request["id"]!.GetValue<int>();
        if (id <= 0) throw new InvalidDataException("positive correlated id required");
        var op = request["op"]!.GetValue<string>();
        response = new JsonObject { ["id"] = id, ["ok"] = true, ["schema"] = "visible-energy-service/1", ["rulesSha256"] = rulesHash };
        if (op == "derive") response["facts"] = VisibleEnergyRules.Derive(request["input"]!);
        else if (op == "close") close = true;
        else if (op == "ping") response["paymentMethodIlSha256"] = methods.DeepClone();
        else throw new InvalidDataException("unsupported operation");
    }
    catch (Exception error)
    {
        response = new JsonObject { ["id"] = request?["id"]?.DeepClone(), ["ok"] = false, ["error"] = error.GetType().Name };
    }
    pipe.WriteLine(response.ToJsonString()); pipe.Flush();
    if (close) break;
}
