using System.Security.Cryptography;
using MatchLogic;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;

namespace Indigo.Live.Engine;

// Original Indigo loading boundary. Reconstructed libraries/programs are pinned
// local inputs; this class neither implements card effects nor mutates a match.
public sealed record ProgramInputs(IReadOnlyList<CardSource> Cards, GameDataCacheMessage Rules)
{
    // Card/game payloads use MatchLogic nodes. Operation snapshots also contain
    // BCL containers and runtime collaborators; this is not their clone policy.
    private static JsonSerializerSettings CreateProgramSettings()
    {
        var original = DeserializeResolver.settings;
        var settings = new JsonSerializerSettings
        {
            TypeNameHandling = original.TypeNameHandling,
            ContractResolver = original.ContractResolver,
            NullValueHandling = original.NullValueHandling,
            DefaultValueHandling = original.DefaultValueHandling,
            SerializationBinder = new ProgramTypeBinder(original.SerializationBinder),
            MissingMemberHandling = MissingMemberHandling.Error,
            Error = (_, error) => error.ErrorContext.Handled = false,
        };
        foreach (var converter in original.Converters) settings.Converters.Add(converter);
        return settings;
    }

    public static ProgramInputs Load(
        string cardsPath, string expectedCardsHash,
        string rulesPath, string expectedRulesHash)
    {
        var cardsJson = ReadPinned(cardsPath, expectedCardsHash);
        var rulesJson = ReadPinned(rulesPath, expectedRulesHash);
        var settings = CreateProgramSettings();
        var cards = JsonConvert.DeserializeObject<List<CardSource>>(cardsJson, settings)
            ?? throw new InvalidDataException("the card program package is empty");
        var rules = JsonConvert.DeserializeObject<GameDataCacheMessage>(rulesJson, settings)
            ?? throw new InvalidDataException("the game program package is empty");
        if (cards.Count == 0 || rules.gameRules.Count == 0 || rules.gameActions.Count == 0)
            throw new InvalidDataException("the game program package is incomplete");
        var identities = new HashSet<string>(StringComparer.Ordinal);
        foreach (var card in cards)
        {
            if (string.IsNullOrWhiteSpace(card.cardSourceID) || !identities.Add(card.cardSourceID))
                throw new InvalidDataException("the card program package has invalid or duplicate identities");
        }
        return new ProgramInputs(cards.AsReadOnly(), rules);
    }

    private static string ReadPinned(string path, string expectedHash)
    {
        if (expectedHash.Length != 64 || !expectedHash.All(Uri.IsHexDigit))
            throw new InvalidDataException("an exact program SHA-256 is required");
        // Hash and decode the same bytes; a changed file cannot pass a hash read
        // and then supply a different payload through a second file read.
        var bytes = File.ReadAllBytes(path);
        var actual = Convert.ToHexString(SHA256.HashData(bytes));
        if (!string.Equals(actual, expectedHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("the program package does not match its pinned hash");
        return System.Text.Encoding.UTF8.GetString(bytes);
    }

    private sealed class ProgramTypeBinder(ISerializationBinder original) : ISerializationBinder
    {
        public Type BindToType(string? assemblyName, string typeName)
        {
            if (assemblyName?.Split(',')[0].Trim() != "MatchLogic")
                throw new JsonSerializationException("the program refers to an unapproved polymorphic assembly");
            return original.BindToType(assemblyName, typeName)
                ?? throw new JsonSerializationException("the program refers to an unresolved type");
        }

        public void BindToName(Type serializedType, out string? assemblyName, out string? typeName) =>
            original.BindToName(serializedType, out assemblyName, out typeName);
    }
}
