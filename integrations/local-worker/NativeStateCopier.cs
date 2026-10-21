using System.Collections;
using System.Collections.Concurrent;
using MatchLogic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;
namespace Indigo.Live.Engine;

// Rebuild only the serialization contract. No mutable object is borrowed from the
// parent. The native JSON implementation remains the independent reference.
internal static class NativeStateCopier
{
    private sealed record SerializationMember(JsonProperty SourceProperty, JsonProperty DestinationProperty, object? DefaultValue, object? SerializedDefaultValue);
    private sealed record ObjectCopyPlan(JsonObjectContract Contract, SerializationMember[] Members);
    private static readonly ConcurrentDictionary<Type, ObjectCopyPlan> ObjectPlans = new();
    private static readonly ConcurrentDictionary<(Type, object), object> NormalizedEnums = new();
    internal const string ImplementationVersion = "native-state-copy/1.0.0";
    internal static long RootFallbackCount;
    internal static long SerializerFallbackCount;
    private static readonly ConcurrentDictionary<string, byte> SerializerFallbackTypes = new();
    internal static bool TryCopy(MatchOperation value, out MatchOperation copy)
    {
        try { copy = (MatchOperation)CopyValue(value, typeof(MatchOperation))!; return true; }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            Interlocked.Increment(ref RootFallbackCount);
            copy = null!;
            return false;
        }
    }
    private static object? GetDefaultValue(JsonProperty property) => property.DefaultValue ?? (property.PropertyType!.IsValueType ? Activator.CreateInstance(property.PropertyType) : null);
    private static ObjectCopyPlan CreateObjectCopyPlan(Type runtimeType)
    {
        var serializationContract = (JsonObjectContract)SerializeResolver.instance.ResolveContract(runtimeType);
        var deserializationContract = (JsonObjectContract)DeserializeResolver.instance.ResolveContract(runtimeType);
        var members = serializationContract.Properties.Where(property => !property.Ignored && property.Readable).Select(property =>
        { var destinationProperty=deserializationContract.Properties.GetClosestMatchProperty(property.PropertyName!)!; return new SerializationMember(property,destinationProperty,GetDefaultValue(destinationProperty),GetDefaultValue(property)); }).ToArray();
        return new ObjectCopyPlan(deserializationContract,members);
    }
    private static object? CopyThroughSerializer(object value, Type runtimeType, object? existing=null)
    {
        Interlocked.Increment(ref SerializerFallbackCount); SerializerFallbackTypes.TryAdd(runtimeType.FullName!, 0);
        var json=JsonConvert.SerializeObject(value, runtimeType, SerializeResolver.settings);
        if(existing!=null){JsonConvert.PopulateObject(json,existing,DeserializeResolver.settings);return existing;}
        return JsonConvert.DeserializeObject(json, runtimeType, DeserializeResolver.settings);
    }
    private static object? CopyValue(object? value, Type declaredType, object? existingValue=null)
    {
        if (value == null) return null;
        var runtimeType=value.GetType();
        if (value is string text) { if(declaredType==typeof(object) && (text.Length>10 && text[4]=='-' && text[10]=='T' || text.StartsWith("/Date(",StringComparison.Ordinal))) return CopyThroughSerializer(value,typeof(object));return value; }
        if(declaredType==typeof(object) && (value is float or decimal or char or Guid or TimeSpan or DateTimeOffset or ulong or JValue || value is double number && !double.IsFinite(number))) return CopyThroughSerializer(value,typeof(object));
        if(declaredType==typeof(object)&&runtimeType==typeof(object))return CopyThroughSerializer(value,typeof(object));
        if(declaredType==typeof(object)&&runtimeType.IsEnum)return Convert.ToInt64(value);
        if (runtimeType.IsEnum) return NormalizedEnums.GetOrAdd((runtimeType,value), key => JsonConvert.DeserializeObject(JsonConvert.SerializeObject(key.Item2, SerializeResolver.settings),key.Item1,DeserializeResolver.settings)!);
        if (runtimeType.IsPrimitive || value is decimal or DateTime or DateTimeOffset or Guid or TimeSpan)
        {
            if (declaredType == typeof(object) && value is int or short or byte or uint or ushort or sbyte) return Convert.ToInt64(value);
            if (declaredType == typeof(object) && value is float) return Convert.ToDouble(value);
            return value;
        }
        if(value is DateBasedVersion version) return new DateBasedVersion(version.Version);
        if(value is byte[] bytes) return bytes.ToArray();
        if (value is JToken) return CopyThroughSerializer(value,runtimeType);
        var contract=DeserializeResolver.instance.ResolveContract(runtimeType);
        if(declaredType==typeof(object) && contract is JsonPrimitiveContract)return CopyThroughSerializer(value,typeof(object));
        if (value is IDictionary dictionary && contract is JsonDictionaryContract dictionaryContract)
        {
            if (dictionaryContract.DefaultCreator == null || dictionaryContract.DictionaryKeyType==typeof(object)) return CopyThroughSerializer(value,runtimeType);
            var result=dictionaryContract.Converter==null&&existingValue is IDictionary priorDictionary?priorDictionary:(IDictionary)dictionaryContract.DefaultCreator();
            foreach(DictionaryEntry item in dictionary)
            {
                // The native enum-key converter drops unknown keys rather than inserting them.
                if (item.Key.GetType().IsEnum && !Enum.IsDefined(item.Key.GetType(),item.Key)) continue;
                result[CopyValue(item.Key,dictionaryContract.DictionaryKeyType!)!]=CopyValue(item.Value,dictionaryContract.DictionaryValueType!);
            }
            return result;
        }
        if (value is IEnumerable sequence && contract is JsonArrayContract arrayContract)
        {
            if (runtimeType.IsArray) { var source=(Array)value;var array=Array.CreateInstance(arrayContract.CollectionItemType!,source.Length);for(int i=0;i<source.Length;i++)array.SetValue(CopyValue(source.GetValue(i),arrayContract.CollectionItemType!),i);return array; }
            if(arrayContract.DefaultCreator == null) return CopyThroughSerializer(value,runtimeType);
            var result=existingValue is IList priorList&&!priorList.IsReadOnly&&!priorList.IsFixedSize?existingValue:arrayContract.DefaultCreator();
            if(result is IList list) { foreach(var item in sequence)list.Add(CopyValue(item,arrayContract.CollectionItemType!));return result; }
            return CopyThroughSerializer(value,runtimeType);
        }
        if(contract is not JsonObjectContract) return CopyThroughSerializer(value,runtimeType);
        var copyPlan=ObjectPlans.GetOrAdd(runtimeType,CreateObjectCopyPlan);var objectContract=copyPlan.Contract;
        if(objectContract.IsReference==true || objectContract.Converter!=null || objectContract.OnDeserializedCallbacks.Count!=0 || objectContract.OnDeserializingCallbacks.Count!=0 || objectContract.OnSerializingCallbacks.Count!=0 || objectContract.OnSerializedCallbacks.Count!=0) throw new NotSupportedException("Native callback contract requires serializer");
        if(objectContract.DefaultCreator == null || objectContract.CreatorParameters.Count != 0) return CopyThroughSerializer(value,runtimeType);
        var target=existingValue?.GetType()==runtimeType?existingValue:objectContract.OverrideCreator != null ? objectContract.OverrideCreator(Array.Empty<object>()) : objectContract.DefaultCreator();
        foreach(var member in copyPlan.Members)
        {
            var sourceProperty=member.SourceProperty;var destinationProperty=member.DestinationProperty;
            if(sourceProperty.IsReference==true || sourceProperty.Converter?.CanWrite==true)throw new NotSupportedException("Native property writer requires serializer");
            if(destinationProperty.Ignored || destinationProperty.ShouldDeserialize?.Invoke(target)==false)continue;
            var sourceValue=sourceProperty.ValueProvider!.GetValue(value);
            var omitted=sourceProperty.GetIsSpecified?.Invoke(value)==false || sourceProperty.ShouldSerialize?.Invoke(value)==false || sourceValue==null && (sourceProperty.NullValueHandling??NullValueHandling.Ignore)==NullValueHandling.Ignore
                || ((sourceProperty.DefaultValueHandling??DefaultValueHandling.Ignore)&DefaultValueHandling.Ignore)!=0 && Equals(sourceValue,member.SerializedDefaultValue);
            if(omitted)
            {
                if(destinationProperty.Writable && ((destinationProperty.DefaultValueHandling??DefaultValueHandling.IgnoreAndPopulate)&DefaultValueHandling.Populate)!=0)destinationProperty.ValueProvider!.SetValue(target,member.DefaultValue);
                continue;
            }
            object? copiedValue;
            if(destinationProperty.Converter != null && destinationProperty.Converter is not DictionaryWithEnumKeyConverter && destinationProperty.Converter is not EnumConverterWithGenericFallback)
            {
                Interlocked.Increment(ref SerializerFallbackCount);SerializerFallbackTypes.TryAdd(runtimeType.FullName+"."+destinationProperty.PropertyName+":"+destinationProperty.Converter.GetType().Name, 0);
                using var reader=JToken.FromObject(sourceValue!,JsonSerializer.Create(SerializeResolver.settings)).CreateReader();reader.Read();
                copiedValue=destinationProperty.Converter.ReadJson(reader,destinationProperty.PropertyType!,null,JsonSerializer.Create(DeserializeResolver.settings));
            }
            else { var existingMemberValue=destinationProperty.ValueProvider!.GetValue(target); var reuse=(destinationProperty.ObjectCreationHandling??ObjectCreationHandling.Auto)!=ObjectCreationHandling.Replace&&destinationProperty.Converter==null?existingMemberValue:null;copiedValue=CopyValue(sourceValue,destinationProperty.PropertyType!,reuse); }
            if(destinationProperty.Writable)destinationProperty.ValueProvider!.SetValue(target,copiedValue);
            else if(!ReferenceEquals(destinationProperty.ValueProvider!.GetValue(target),copiedValue) && destinationProperty.ValueProvider!.GetValue(target) is IList existing && !existing.IsReadOnly && !existing.IsFixedSize && copiedValue is IEnumerable values)foreach(var item in values)existing.Add(item);
            // Native JSON cannot assign a read-only value or populate a null getter.
        }
        return target;
    }
}
