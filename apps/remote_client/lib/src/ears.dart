import 'json.dart';
import 'models.dart';

class EarsSettings {
  const EarsSettings({
    this.enabled = false,
    this.providerId,
    this.modelId,
    this.mode = 'cleaned',
  });

  factory EarsSettings.fromJson(Object? value) {
    try {
      final json = jsonMap(value, name: 'ears');
      final providerId = optionalString(json, 'providerId');
      final modelId = optionalString(json, 'modelId');
      final mode = optionalString(json, 'mode');
      return EarsSettings(
        enabled: json['enabled'] == true,
        providerId: providerId != null && providerId.length <= 160
            ? providerId
            : null,
        modelId: modelId != null && modelId.length <= 320 ? modelId : null,
        mode: mode == 'verbatim' ? 'verbatim' : 'cleaned',
      );
    } on Object {
      return const EarsSettings();
    }
  }

  final bool enabled;
  final String? providerId;
  final String? modelId;
  final String mode;

  JsonMap toJson() => <String, Object?>{
        'enabled': enabled,
        'providerId': providerId,
        'modelId': modelId,
        'mode': mode,
      };

  EarsSettings copyWith({
    bool? enabled,
    String? providerId,
    String? modelId,
    String? mode,
    bool clearModel = false,
  }) =>
      EarsSettings(
        enabled: enabled ?? this.enabled,
        providerId: clearModel ? null : providerId ?? this.providerId,
        modelId: clearModel ? null : modelId ?? this.modelId,
        mode: mode ?? this.mode,
      );
}

const String earsCancelledMessage = 'EARS transcription was cancelled.';

bool isDictationAudioAttachment(RemoteAttachment attachment) =>
    attachment.origin == 'dictation' &&
    const <String>{
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/x-wav',
      'audio/wave',
    }.contains(attachment.mimeType.toLowerCase());

bool providerDeliversNativeAudio(String providerId) =>
    providerId == 'direct' ||
    providerId == 'codex' ||
    providerId == 'opencode';

bool routeAcceptsEarsAudio(RemoteModel model) =>
    providerDeliversNativeAudio(model.providerId) &&
    model.supportsAudioInput == true;

String composeEarsDestinationText(
    String typed, Iterable<String> transcripts) {
  final spoken = transcripts
      .map((text) => text.trim())
      .where((text) => text.isNotEmpty)
      .join('\n\n');
  final written = typed.trim();
  if (written.isEmpty) return spoken;
  if (spoken.isEmpty) return written;
  return '$written\n\n$spoken';
}

bool isEarsCancelledError(Object error) {
  final message = error.toString();
  return message.contains(earsCancelledMessage);
}
