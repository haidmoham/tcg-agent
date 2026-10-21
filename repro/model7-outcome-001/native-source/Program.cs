using System.Security.Cryptography;
using System.Reflection;
using System.Text;
using MatchLogic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;

namespace Indigo.Live.Engine;

internal static class Program
{
    private const string Protocol = "indigo-engine-worker/1";
    private const int MaximumLineBytes = 2 * 1024 * 1024;

    private static int Main(string[] args)
    {
        // Windows console code pages can turn a legal JSON string's arrow into
        // an unescaped control byte. The private wire is UTF-8 on both sides.
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        // A native path writes directly to Console.Out. Save the pipe writer first.
        var pipe = Console.Out;
        Console.SetOut(TextWriter.Null);
        try
        {
            if (args.Length != 2) throw new InvalidDataException("expected bundle directory and manifest SHA-256");
            var worker = new MatchWorker(args[0], args[1]);
            string? line;
            while ((line = Console.In.ReadLine()) != null)
            {
                if (Encoding.UTF8.GetByteCount(line) > MaximumLineBytes) break;
                JObject request;
                try { request = JObject.Parse(line); }
                catch { break; }
                var requestId = request.Value<string>("requestId");
                var epoch = request.Value<string>("epoch");
                var matchId = request.Value<string>("matchId");
                if (request.Value<string>("protocol") != Protocol || string.IsNullOrEmpty(requestId)
                    || string.IsNullOrEmpty(epoch) || string.IsNullOrEmpty(matchId)) break;
                var method = request.Value<string>("method");
                if (method == "offline-next")
                {
                    worker = worker.NextOfflineMatch(epoch, matchId);
                    method = "create";
                }
                var payload = worker.Dispatch(epoch, matchId, method, request["payload"]);
                var response = new JObject
                {
                    ["protocol"] = Protocol, ["requestId"] = requestId,
                    ["epoch"] = epoch, ["matchId"] = matchId, ["payload"] = payload,
                };
                pipe.WriteLine(response.ToString(Formatting.None));
                pipe.Flush();
                if (worker.IsStopped) break;
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"engine worker stopped: {error.GetType().Name}: {error.Message}");
            return 1;
        }
    }
}

internal static class StrictNativeCopies
{
    internal static void Install()
    {
        var original = DeserializeResolver.settings;
        var guarded = new JsonSerializerSettings
        {
            TypeNameHandling = original.TypeNameHandling,
            ContractResolver = original.ContractResolver,
            NullValueHandling = original.NullValueHandling,
            DefaultValueHandling = original.DefaultValueHandling,
            SerializationBinder = new NativeBinder(original.SerializationBinder),
            MissingMemberHandling = MissingMemberHandling.Error,
            Error = (_, error) => error.ErrorContext.Handled = false,
        };
        foreach (var converter in original.Converters) guarded.Converters.Add(converter);
        DeserializeResolver.settings = guarded;
    }

    private sealed class NativeBinder(ISerializationBinder original) : ISerializationBinder
    {
        public Type BindToType(string? assemblyName, string typeName)
        {
            var assembly = assemblyName?.Split(',')[0].Trim();
            if (assembly is not ("MatchLogic" or "System.Private.CoreLib"))
                throw new JsonSerializationException("unapproved native copy assembly");
            var resolved = original.BindToType(assemblyName, typeName)
                ?? throw new JsonSerializationException("unknown native type");
            static bool Allowed(Type type) => type.Assembly == typeof(MatchOperation).Assembly
                || type.IsGenericType && type.GetGenericTypeDefinition() == typeof(List<>)
                    && type.GetGenericArguments().All(Allowed)
                || type.IsPrimitive || type == typeof(string) || type == typeof(decimal) || type == typeof(DateTime);
            if (!Allowed(resolved)) throw new JsonSerializationException("unapproved native copy type");
            return resolved;
        }

        public void BindToName(Type serializedType, out string? assemblyName, out string? typeName) =>
            original.BindToName(serializedType, out assemblyName, out typeName);
    }
}

internal sealed class Bundle
{
    internal string Id { get; }
    internal string CardsHash { get; }
    internal string RulesHash { get; }
    internal string RuntimeHash { get; }
    internal ProgramInputs Programs { get; }
    internal IReadOnlyDictionary<string, string> PrintingBySource { get; }

    internal Bundle(string directory, string expectedManifestHash)
    {
        var manifestPath = Path.Combine(directory, "manifest.json");
        var manifestBytes = File.ReadAllBytes(manifestPath);
        var actualManifestHash = Convert.ToHexString(SHA256.HashData(manifestBytes));
        if (!actualManifestHash.Equals(expectedManifestHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("bundle manifest hash mismatch");
        var manifest = JObject.Parse(Encoding.UTF8.GetString(manifestBytes));
        Id = manifest.Value<string>("bundleId") ?? throw new InvalidDataException("bundle id missing");
        var files = (JArray?)manifest["files"] ?? throw new InvalidDataException("bundle file list missing");
        string Verify(string name)
        {
            var entry = files.Children<JObject>().SingleOrDefault(x => x.Value<string>("path") == name)
                ?? throw new InvalidDataException("bundle file missing: " + name);
            var expected = entry.Value<string>("sha256") ?? "";
            var path = Path.Combine(directory, name);
            var actual = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));
            if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("bundle file hash mismatch: " + name);
            return expected;
        }
        RuntimeHash = Verify("MatchLogic.dll");
        Verify("CardDatabase.DataAccess.dll"); Verify("Newtonsoft.Json.dll"); Verify("TimeProvider.dll");
        foreach (var name in new[] { "MatchLogic", "CardDatabase.DataAccess", "Newtonsoft.Json", "TimeProvider" })
        {
            var assembly = Assembly.Load(name);
            var expected = files.Children<JObject>().Single(x => x.Value<string>("path") == name + ".dll").Value<string>("sha256");
            var actual = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location)));
            if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("loaded runtime assembly differs from pinned bundle: " + name);
        }
        CardsHash = Verify("cardData.json"); RulesHash = Verify("gameData.json");
        Verify("decks.json"); Verify("printing-joins.json");
        Programs = ProgramInputs.Load(Path.Combine(directory, "cardData.json"), CardsHash,
            Path.Combine(directory, "gameData.json"), RulesHash);
        PrintingBySource = ((JArray?)JObject.Parse(File.ReadAllText(Path.Combine(directory, "printing-joins.json")))["joins"]
            ?? throw new InvalidDataException("printing joins missing"))
            .Children<JObject>().Where(x => x.Value<string>("scope") == "primary-deck")
            .ToDictionary(x => x.Value<string>("cardSourceID")!, x => x.Value<string>("printingId")!, StringComparer.Ordinal);
        StrictNativeCopies.Install();
        CardCache.Clear(); GameDataCache.Clear();
        CardCache.Add(Programs.Cards.ToList()); GameDataCache.AddCachedObjects(Programs.Rules);
    }
}
