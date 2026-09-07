import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:image/image.dart' as image_lib;
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:url_launcher/url_launcher.dart';

import 'app_theme.dart';
import 'audio_message.dart';
import 'desktop_wake_dialog.dart';
import 'dictation.dart';
import 'ears.dart';
import 'external_system_activity.dart';
import 'json.dart';
import 'models.dart';
import 'security.dart';
import 'store.dart';
import 'transport.dart';

class StoreScope extends InheritedNotifier<RemoteAppStore> {
  const StoreScope(
      {required RemoteAppStore store, required super.child, super.key})
      : super(notifier: store);

  static RemoteAppStore of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<StoreScope>();
    if (scope?.notifier == null) throw StateError('StoreScope is missing');
    return scope!.notifier!;
  }

  static RemoteAppStore read(BuildContext context) {
    final scope = context.getInheritedWidgetOfExactType<StoreScope>();
    if (scope?.notifier == null) throw StateError('StoreScope is missing');
    return scope!.notifier!;
  }
}

ProviderConnection? _preferredNewTaskProvider(RemoteAppStore store) {
  final available = store.providers
      .where((provider) =>
          provider.detected && provider.capabilities.createSession)
      .toList(growable: false);
  if (available.isEmpty) return null;
  return available
          .where((provider) =>
              provider.providerId == store.selectedProviderId &&
              provider.authenticated != false)
          .firstOrNull ??
      available
          .where((provider) => provider.authenticated == true)
          .firstOrNull ??
      available.first;
}

@visibleForTesting
bool isSelectableProjectDirectory(String? value) {
  final directory = value?.trim() ?? '';
  if (directory.isEmpty) return false;
  final normalized = directory.replaceAll(RegExp(r'[\\/]+'), '/');
  return !RegExp(
    r'^[a-z]:/windows(?:/|$)',
    caseSensitive: false,
  ).hasMatch(normalized);
}

enum _PreparedProjectChoice { anotherFolder }

const double _jumpToLatestDistance = 160;
const double _historyPrefetchDistance = 240;
const double _physicalBottomTolerance = .5;
const Duration _prependCorrectionTimeout = Duration(milliseconds: 700);
const Duration _workingSpinnerPeriod = Duration(milliseconds: 780);
const Duration _maximumDictationDuration = Duration(minutes: 10);
const int _maximumDictationAudioBytes = 25 * 1024 * 1024;
const int _maximumPhoneImageSourceBytes = 100 * 1024 * 1024;
const int _dictationWavHeaderBytes = 44;
const int _dictationPcmBytesPerSecond = 16000 * 2;
const double _sideChatActionRowHeight = 52;
const double _composerActionRowHeight = 52;
const double _sessionHistoryProgressHeight = 1;
const double _attachmentLaneHeight = 52;
// InputDecorator needs a hair more than Flutter's nominal 48px tap target at
// some text scales. Reserving 52px avoids the intermittent two-pixel flex
// overflow seen while the keyboard and composer are resizing.
const double _minimumComposerTextHeight = 52;
const double _composerBorderInset = 2;
const String _attachmentLimitMessage =
    'You can send up to $maxMessageAttachments attachments at once. Remove one before adding another.';
const String _attachmentTotalLimitMessage =
    'Attachments can total up to 50 MiB per message. Remove one or choose a smaller file.';

Future<T> _duringExternalSystemActivity<T>(
    Future<T> Function() operation) async {
  final lease = externalSystemActivity.acquire();
  try {
    return await operation();
  } finally {
    lease.release();
  }
}

String _mergeFailedDraftText(String submitted, String current) {
  if (current.isEmpty) return submitted;
  if (submitted.isEmpty) return current;
  return '$submitted\n$current';
}

List<RemoteAttachment> _mergeFailedAttachments(
  Iterable<RemoteAttachment> submitted,
  Iterable<RemoteAttachment> current,
) =>
    <RemoteAttachment>[...submitted, ...current];

bool _sameDraftAttachments(
  List<RemoteAttachment> left,
  List<RemoteAttachment> right,
) {
  if (identical(left, right)) return true;
  if (left.length != right.length) return false;
  for (var index = 0; index < left.length; index += 1) {
    final a = left[index];
    final b = right[index];
    if (identical(a, b)) continue;
    if (a.name != b.name ||
        a.mimeType != b.mimeType ||
        a.dataBase64 != b.dataBase64 ||
        a.byteLength != b.byteLength ||
        a.origin != b.origin) {
      return false;
    }
  }
  return true;
}

bool _sameDelegationSelections(
  List<DelegationSelection> left,
  List<DelegationSelection> right,
) {
  if (identical(left, right)) return true;
  if (left.length != right.length) return false;
  for (var index = 0; index < left.length; index += 1) {
    final a = left[index];
    final b = right[index];
    if (a.providerId != b.providerId ||
        a.modelId != b.modelId ||
        a.reasoningEffort != b.reasoningEffort) {
      return false;
    }
  }
  return true;
}

bool _hasActiveTextComposition(TextEditingValue value) =>
    value.composing.isValid && !value.composing.isCollapsed;

TextEditingValue? _withoutSingleInsertedNewline(
  String previousText,
  TextEditingValue currentValue,
) {
  final currentText = currentValue.text;
  if (currentText.length != previousText.length + 1) return null;
  var insertionOffset = 0;
  while (insertionOffset < previousText.length &&
      previousText[insertionOffset] == currentText[insertionOffset]) {
    insertionOffset += 1;
  }
  if (currentText[insertionOffset] != '\n' ||
      currentText.substring(insertionOffset + 1) !=
          previousText.substring(insertionOffset)) {
    return null;
  }
  return _replaceComposerRange(
    currentValue,
    insertionOffset,
    insertionOffset + 1,
    '',
  );
}

class _DictationCommitResult {
  const _DictationCommitResult({
    required this.applied,
    this.transcript,
    this.attachment,
  }) : assert((transcript == null) != (attachment == null));

  final bool applied;
  final String? transcript;
  final RemoteAttachment? attachment;
}

enum _ComposerSubmissionOutcome {
  rejected,
  accepted,
  restored,
  originLost,
}

const String _meshDraftPlaceholder = '\uFFFC';

class _MeshCommandToken {
  const _MeshCommandToken(this.start, this.end);

  final int start;
  final int end;
}

_MeshCommandToken? _meshCommandTokenForValue(
  TextEditingValue value, {
  bool requireTrailingWhitespace = false,
}) {
  final matches = RegExp(r'(^|\s)/mesh(?=\s|$)', caseSensitive: false)
      .allMatches(value.text);
  final caret = value.selection.isValid
      ? value.selection.extentOffset.clamp(0, value.text.length)
      : value.text.length;
  _MeshCommandToken? closest;
  var closestDistance = value.text.length + 1;
  for (final match in matches) {
    final start = match.start + (match.group(1) ?? '').length;
    final end = start + '/mesh'.length;
    if (requireTrailingWhitespace &&
        (end >= value.text.length ||
            !RegExp(r'\s').hasMatch(value.text[end]))) {
      continue;
    }
    final distance = caret < start
        ? start - caret
        : caret > end
            ? caret - end
            : 0;
    if (distance < closestDistance) {
      var replacementStart = start;
      var replacementEnd = end;
      if (start == 0 &&
          end < value.text.length &&
          RegExp(r'[ \t]').hasMatch(value.text[end])) {
        replacementEnd += 1;
      } else if (end == value.text.length &&
          start > 0 &&
          RegExp(r'[ \t]').hasMatch(value.text[start - 1])) {
        replacementStart -= 1;
      } else if (start > 0 &&
          end < value.text.length &&
          RegExp(r'[ \t]').hasMatch(value.text[start - 1]) &&
          RegExp(r'[ \t]').hasMatch(value.text[end])) {
        replacementEnd += 1;
      }
      closest = _MeshCommandToken(replacementStart, replacementEnd);
      closestDistance = distance;
    }
  }
  return closest;
}

int _meshPlaceholderCount(String text, [int start = 0, int? end]) {
  var count = 0;
  final limit = (end ?? text.length).clamp(start, text.length);
  for (var index = start.clamp(0, text.length); index < limit; index += 1) {
    if (text[index] == _meshDraftPlaceholder) count += 1;
  }
  return count;
}

int? _meshPlaceholderOffset(String text, int ordinal) {
  var current = 0;
  for (var index = 0; index < text.length; index += 1) {
    if (text[index] != _meshDraftPlaceholder) continue;
    if (current == ordinal) return index;
    current += 1;
  }
  return null;
}

String _withoutMeshDraftPlaceholders(String text) =>
    text.replaceAll(_meshDraftPlaceholder, '');

TextEditingValue _replaceComposerRange(
  TextEditingValue value,
  int start,
  int end,
  String replacement,
) {
  final removedLength = end - start;
  final delta = replacement.length - removedLength;
  int adjustedOffset(int offset) {
    if (offset <= start) return offset;
    if (offset <= end) return start + replacement.length;
    return offset + delta;
  }

  TextRange adjustedRange(TextRange range) {
    if (!range.isValid) return TextRange.empty;
    return TextRange(
      start: adjustedOffset(range.start),
      end: adjustedOffset(range.end),
    );
  }

  final text = value.text.replaceRange(start, end, replacement);
  final selection = value.selection.isValid
      ? TextSelection(
          baseOffset: adjustedOffset(value.selection.baseOffset),
          extentOffset: adjustedOffset(value.selection.extentOffset),
          affinity: value.selection.affinity,
          isDirectional: value.selection.isDirectional,
        )
      : TextSelection.collapsed(offset: text.length);
  return TextEditingValue(
    text: text,
    selection: selection,
    composing: adjustedRange(value.composing),
  );
}

typedef _InlineMeshSpanBuilder = Widget Function(
  BuildContext context,
  int index,
);

class _MeshTextEditingController extends TextEditingController {
  _MeshTextEditingController({
    required this.targetCount,
    required this.buildTarget,
  });

  final int Function() targetCount;
  final _InlineMeshSpanBuilder buildTarget;

  void refreshInlineSpans() => notifyListeners();

  @override
  TextSpan buildTextSpan({
    required BuildContext context,
    TextStyle? style,
    required bool withComposing,
  }) {
    final current = value;
    if (!current.text.contains(_meshDraftPlaceholder)) {
      return super.buildTextSpan(
        context: context,
        style: style,
        withComposing: withComposing,
      );
    }
    final children = <InlineSpan>[];
    final composing = withComposing && current.composing.isValid
        ? current.composing
        : TextRange.empty;

    void addText(int start, int end) {
      if (start >= end) return;
      final composingStart = math.max(start, composing.start);
      final composingEnd = math.min(end, composing.end);
      if (!composing.isValid || composingStart >= composingEnd) {
        children.add(TextSpan(text: current.text.substring(start, end)));
        return;
      }
      if (start < composingStart) {
        children
            .add(TextSpan(text: current.text.substring(start, composingStart)));
      }
      children.add(TextSpan(
        text: current.text.substring(composingStart, composingEnd),
        style: const TextStyle(decoration: TextDecoration.underline),
      ));
      if (composingEnd < end) {
        children.add(TextSpan(text: current.text.substring(composingEnd, end)));
      }
    }

    var textStart = 0;
    var targetIndex = 0;
    for (var index = 0; index < current.text.length; index += 1) {
      if (current.text[index] != _meshDraftPlaceholder) continue;
      addText(textStart, index);
      children.add(WidgetSpan(
        alignment: PlaceholderAlignment.middle,
        child: targetIndex < targetCount()
            ? buildTarget(context, targetIndex)
            : const SizedBox.shrink(),
      ));
      targetIndex += 1;
      textStart = index + 1;
    }
    addText(textStart, current.text.length);
    return TextSpan(style: style, children: children);
  }
}

class _InlineMeshTargetChip extends StatelessWidget {
  const _InlineMeshTargetChip({
    required this.target,
    required this.store,
    this.targetKey,
    this.removeKey,
    this.onTap,
    this.onRemove,
    super.key,
  });

  final DelegationSelection target;
  final RemoteAppStore store;
  final Key? targetKey;
  final Key? removeKey;
  final VoidCallback? onTap;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final provider = providerVisualThemeFor(target.providerId);
    final modelLabel =
        (store.modelsByProvider[target.providerId] ?? const <RemoteModel>[])
                .where((model) => model.id == target.modelId)
                .firstOrNull
                ?.displayName ??
            target.modelId ??
            provider.displayName;
    final targetEffort = _concreteReasoningEffort(target.reasoningEffort);
    final label = <String>[
      modelLabel,
      if (targetEffort != null)
        _effortDisplayLabel(
          targetEffort,
          target.modelId,
          target.providerId,
        ),
    ].join(' · ');
    final maximumWidth = math.max(
      112.0,
      math.min(260.0, MediaQuery.sizeOf(context).width - 72),
    );
    final targetBody = Padding(
      padding: const EdgeInsets.fromLTRB(7, 4, 5, 4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          ProviderLogo(providerId: target.providerId, size: 18),
          const SizedBox(width: 5),
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                    color: provider.accent,
                  ),
            ),
          ),
        ],
      ),
    );
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maximumWidth),
        child: Material(
          color: provider.accent.withValues(alpha: 0.08),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(15),
            side: BorderSide(color: provider.accent.withValues(alpha: 0.72)),
          ),
          clipBehavior: Clip.antiAlias,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Flexible(
                child: onTap == null
                    ? Semantics(
                        key: targetKey,
                        label: 'Mesh reference: $label',
                        child: targetBody,
                      )
                    : Tooltip(
                        message: 'Edit $label',
                        child: InkWell(
                          key: targetKey,
                          onTap: onTap,
                          child: targetBody,
                        ),
                      ),
              ),
              if (onRemove != null)
                Semantics(
                  button: true,
                  label: 'Remove $label from Mesh',
                  child: InkWell(
                    key: removeKey,
                    onTap: onRemove,
                    child: SizedBox(
                      width: 30,
                      height: 30,
                      child: Icon(
                        Icons.close_rounded,
                        size: 16,
                        color: provider.accent,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MeshCompositionState {
  const _MeshCompositionState({
    required this.value,
    required this.targets,
  });

  final TextEditingValue value;
  final List<DelegationSelection> targets;
}

@visibleForTesting
bool messageAttachmentBytesAvailable(
  Iterable<RemoteAttachment> current,
  int additionalBytes,
) {
  if (additionalBytes <= 0) return false;
  var total = additionalBytes;
  for (final attachment in current) {
    total += attachment.byteLength;
    if (total > maxMessageAttachmentBytes) return false;
  }
  return total <= maxMessageAttachmentBytes;
}

Route<void> sessionScreenRoute(String sessionId) => PageRouteBuilder<void>(
      transitionDuration: const Duration(milliseconds: 85),
      reverseTransitionDuration: const Duration(milliseconds: 75),
      pageBuilder: (_, __, ___) => SessionScreen(sessionId: sessionId),
      transitionsBuilder: (context, animation, __, child) {
        if (MediaQuery.disableAnimationsOf(context)) return child;
        final curved =
            CurvedAnimation(parent: animation, curve: Curves.easeOut);
        return FadeTransition(
          opacity: curved,
          child: ScaleTransition(
            scale: Tween<double>(begin: .992, end: 1).animate(curved),
            child: child,
          ),
        );
      },
    );

@visibleForTesting
bool jumpToLatestVisible({
  required double pixels,
  required double maxScrollExtent,
}) =>
    maxScrollExtent > 0 && maxScrollExtent - pixels > _jumpToLatestDistance;

bool _isAtPhysicalBottom(ScrollMetrics metrics) =>
    metrics.pixels >= metrics.maxScrollExtent - _physicalBottomTolerance;

int _presentationFingerprint(Object? value, {String? key}) {
  if (value == null || value is num || value is bool) return value.hashCode;
  if (value is Uint8List) return Object.hash('bytes', value.length);
  if (value is String) {
    final payload = key == 'dataBase64' ||
        key == 'base64' ||
        key == 'bytes' ||
        ((key == 'uri' ||
                key == 'dataUri' ||
                key == 'url' ||
                key == 'imageUrl' ||
                key == 'image_url') &&
            value.startsWith('data:'));
    return payload
        ? Object.hash('payload', value.length)
        : Object.hash(value.length, value.hashCode);
  }
  if (value is Map<Object?, Object?>) {
    final entries = value.entries.toList(growable: false)
      ..sort(
          (left, right) => left.key.toString().compareTo(right.key.toString()));
    return Object.hashAll(entries.map((entry) => Object.hash(
          entry.key,
          _presentationFingerprint(entry.value, key: entry.key.toString()),
        )));
  }
  if (value is Iterable<Object?>) {
    return Object.hashAll(value.map(_presentationFingerprint));
  }
  return value.hashCode;
}

int _messagePresentationRevision(Iterable<RemoteMessage> messages) =>
    Object.hashAll(messages.map((message) => Object.hash(
          message.presentationId,
          message.status,
          message.role,
          Object.hashAll(message.parts.map((part) => Object.hash(
                part.type,
                _presentationFingerprint(part.data),
              ))),
        )));

Uint8List _decodeBase64DataUriPayload(String dataUri) {
  final comma = dataUri.indexOf(',');
  if (comma < 0) throw const FormatException('Missing data URI payload');
  return base64Decode(dataUri.substring(comma + 1));
}

class _ConversationScrollController extends ScrollController {
  _ConversationScrollController({required this.shouldFollowLatest});

  final bool Function() shouldFollowLatest;

  @override
  ScrollPosition createScrollPosition(
    ScrollPhysics physics,
    ScrollContext context,
    ScrollPosition? oldPosition,
  ) {
    final next = _ConversationScrollPosition(
      physics: physics,
      context: context,
      initialPixels: initialScrollOffset,
      keepScrollOffset: keepScrollOffset,
      oldPosition: oldPosition,
      debugLabel: debugLabel,
      shouldFollowLatest: shouldFollowLatest,
    );
    if (oldPosition is _ConversationScrollPosition) {
      next._adoptPendingPrependFrom(oldPosition);
    }
    return next;
  }

  Future<void> preserveVisualAnchorOnNextGrowth({
    double? Function()? anchorDelta,
    bool fallbackToExtent = false,
  }) {
    if (!hasClients || position is! _ConversationScrollPosition) {
      return Future<void>.value();
    }
    return (position as _ConversationScrollPosition)
        .preserveVisualAnchorOnNextGrowth(
      anchorDelta: anchorDelta,
      fallbackToExtent: fallbackToExtent,
    );
  }
}

class _ConversationScrollPosition extends ScrollPositionWithSingleContext {
  _ConversationScrollPosition({
    required super.physics,
    required super.context,
    required super.initialPixels,
    required super.keepScrollOffset,
    required super.oldPosition,
    required super.debugLabel,
    required this.shouldFollowLatest,
  });

  final bool Function() shouldFollowLatest;
  double? _prependAppliedExtent;
  double? Function()? _prependAnchorDelta;
  bool _prependFallbackToExtent = false;
  Completer<void>? _prependCompleter;
  Timer? _prependTimeout;
  bool _prependCompletionScheduled = false;

  void _adoptPendingPrependFrom(_ConversationScrollPosition previous) {
    if (previous._prependCompleter == null) return;
    _prependAppliedExtent = previous._prependAppliedExtent;
    _prependAnchorDelta = previous._prependAnchorDelta;
    _prependFallbackToExtent = previous._prependFallbackToExtent;
    _prependCompleter = previous._prependCompleter;
    previous._prependTimeout?.cancel();
    previous._prependAppliedExtent = null;
    previous._prependAnchorDelta = null;
    previous._prependFallbackToExtent = false;
    previous._prependCompleter = null;
    previous._prependTimeout = null;
    previous._prependCompletionScheduled = false;
    _prependTimeout = Timer(_prependCorrectionTimeout, _completePendingPrepend);
  }

  Future<void> preserveVisualAnchorOnNextGrowth({
    double? Function()? anchorDelta,
    bool fallbackToExtent = false,
  }) {
    _completePendingPrepend();
    _prependAppliedExtent = hasContentDimensions ? maxScrollExtent : 0;
    _prependAnchorDelta = anchorDelta;
    _prependFallbackToExtent = fallbackToExtent;
    final completer = Completer<void>();
    _prependCompleter = completer;
    _prependTimeout = Timer(_prependCorrectionTimeout, _completePendingPrepend);
    return completer.future;
  }

  @override
  bool applyContentDimensions(double minScrollExtent, double maxScrollExtent) {
    // There are no old metrics on the first layout, so Flutter does not call
    // correctForNewDimensions. Land a newly opened conversation at its real
    // tail before that first frame is accepted. MediaQuery and Scrollable
    // rebuilds can also replace this position; the replacement adopts our
    // anchor state but has no prior metrics, so apply that correction here too.
    final needsInitialTailCorrection = !hasContentDimensions &&
        shouldFollowLatest() &&
        (pixels - maxScrollExtent).abs() > _physicalBottomTolerance;
    final hadPendingAnchor = _prependAppliedExtent != null;
    final pendingTarget = _pendingAnchorTarget(
      minScrollExtent: minScrollExtent,
      maxScrollExtent: maxScrollExtent,
    );
    final targetPixels = needsInitialTailCorrection
        ? maxScrollExtent
        : pendingTarget ??
            (!hadPendingAnchor &&
                    shouldFollowLatest() &&
                    (pixels - maxScrollExtent).abs() > _physicalBottomTolerance
                ? maxScrollExtent
                : null);
    var correctedPixels = false;
    if (targetPixels != null &&
        (targetPixels - pixels).abs() > _physicalBottomTolerance) {
      correctPixels(targetPixels);
      correctedPixels = true;
    }
    final accepted =
        super.applyContentDimensions(minScrollExtent, maxScrollExtent);
    return correctedPixels ? false : accepted;
  }

  @override
  bool correctForNewDimensions(
    ScrollMetrics oldPosition,
    ScrollMetrics newPosition,
  ) {
    final hadPendingAnchor = _prependAppliedExtent != null;
    final pendingTarget = _pendingAnchorTarget(
      minScrollExtent: newPosition.minScrollExtent,
      maxScrollExtent: newPosition.maxScrollExtent,
    );
    final targetPixels = pendingTarget ??
        (!hadPendingAnchor &&
                shouldFollowLatest() &&
                (pixels - newPosition.maxScrollExtent).abs() >
                    _physicalBottomTolerance
            ? newPosition.maxScrollExtent
            : null);
    if (targetPixels == null) {
      return hadPendingAnchor
          ? true
          : super.correctForNewDimensions(oldPosition, newPosition);
    }
    if ((targetPixels - pixels).abs() <= _physicalBottomTolerance) return true;
    correctPixels(targetPixels);
    return false;
  }

  double? _pendingAnchorTarget({
    required double minScrollExtent,
    required double maxScrollExtent,
  }) {
    final priorExtent = _prependAppliedExtent;
    if (priorExtent == null) return null;
    final extentDelta = maxScrollExtent - priorExtent;
    _prependAppliedExtent = maxScrollExtent;
    final visualDelta = _safeAnchorDelta();
    double? targetPixels;
    if (visualDelta != null && visualDelta.abs() > _physicalBottomTolerance) {
      targetPixels = pixels + visualDelta;
    } else if ((visualDelta == null || _prependFallbackToExtent) &&
        extentDelta.abs() > _physicalBottomTolerance) {
      // A retained visible row is preferred because unrelated streaming
      // below it must not move the reader. Distance from end remains a safe
      // fallback when the retained row was recycled or regrouped.
      targetPixels = pixels + extentDelta;
    }
    if (extentDelta.abs() > _physicalBottomTolerance ||
        (visualDelta?.abs() ?? 0) > _physicalBottomTolerance) {
      _schedulePrependCompletion();
    }
    return targetPixels?.clamp(minScrollExtent, maxScrollExtent);
  }

  double? _safeAnchorDelta() {
    try {
      final delta = _prependAnchorDelta?.call();
      return delta != null && delta.isFinite ? delta : null;
    } on Object {
      return null;
    }
  }

  void _schedulePrependCompletion() {
    if (_prependCompletionScheduled) return;
    _prependCompletionScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _prependCompletionScheduled = false;
      final visualDelta = _safeAnchorDelta();
      if (visualDelta != null &&
          visualDelta.abs() > _physicalBottomTolerance &&
          hasContentDimensions) {
        jumpTo((pixels + visualDelta).clamp(minScrollExtent, maxScrollExtent));
      }
      _completePendingPrepend();
    });
  }

  void _completePendingPrepend() {
    _prependTimeout?.cancel();
    _prependTimeout = null;
    _prependAppliedExtent = null;
    _prependAnchorDelta = null;
    _prependFallbackToExtent = false;
    final completer = _prependCompleter;
    _prependCompleter = null;
    if (completer != null && !completer.isCompleted) completer.complete();
  }

  @override
  void dispose() {
    _completePendingPrepend();
    super.dispose();
  }
}

@visibleForTesting
Duration dictationMaximumDurationForAudioBytes(int maxAudioBytes) {
  final completeSeconds =
      (maxAudioBytes - _dictationWavHeaderBytes) ~/ _dictationPcmBytesPerSecond;
  // Leave one timer tick of headroom so the last buffered PCM chunk cannot
  // push the completed WAV over the source's advertised byte limit.
  final safeSeconds = (completeSeconds - 1)
      .clamp(1, _maximumDictationDuration.inSeconds)
      .toInt();
  return Duration(seconds: safeSeconds);
}

@visibleForTesting
bool dictationShouldAutoFinish(
  Duration elapsed, {
  Duration maximumDuration = _maximumDictationDuration,
}) =>
    elapsed >= maximumDuration;

@visibleForTesting
String dictationElapsedLabel(Duration elapsed) {
  final minutes = elapsed.inMinutes;
  final seconds = elapsed.inSeconds.remainder(60);
  return '$minutes:${seconds.toString().padLeft(2, '0')}';
}

@visibleForTesting
bool messageAttachmentSlotAvailable(int currentCount) =>
    currentCount < maxMessageAttachments;

@visibleForTesting
String compactErrorDetail(Object error) {
  final detail = error
      .toString()
      .trim()
      .replaceFirst(RegExp(r'^(Exception|StateError):\s*'), '');
  final normalized = detail.toLowerCase();
  if (RegExp(r'normalized transcript is \d+ bytes|generic bootstrap limit',
          caseSensitive: false)
      .hasMatch(detail)) {
    return 'This task is too large to copy in one piece. Try again from a shorter recent span.';
  }
  final attachmentCountMatch = RegExp(
          r'(?:at most|maximum(?:\s+of)?|no more than)\s+(\d+)',
          caseSensitive: false)
      .firstMatch(detail);
  if ((normalized.contains('attachmentids') ||
          normalized.contains('attachments')) &&
      attachmentCountMatch != null) {
    final limit = attachmentCountMatch.group(1)!;
    return 'You can send up to $limit attachments at once. Remove some and try again.';
  }
  if (RegExp(
          r'attachment.{0,40}(?:too large|exceeds|maximum size|max(?:imum)? bytes)|payload.{0,24}too large',
          caseSensitive: false)
      .hasMatch(detail)) {
    return 'One of those attachments is too large. Remove it or choose a smaller file.';
  }
  if (RegExp(
          r'socketexception|secure dns|failed host lookup|connection (?:refused|reset|closed)|network is unreachable|handshakeexception|websocket.{0,24}(?:closed|failed)|not connected|bridge.{0,20}(?:offline|unavailable)',
          caseSensitive: false)
      .hasMatch(detail)) {
    return 'Not connected. Reconnect to your computer and try again.';
  }
  if (RegExp(r'(?:top|bottom|left|right)?\s*overflowed by \d+(?:\.\d+)? pixels',
          caseSensitive: false)
      .hasMatch(detail)) {
    return 'That action could not be completed. Try again.';
  }
  if (RegExp(
          r'bridge_[a-z0-9_]+|(?:^|\s)[a-z][a-z0-9_]*(?:ids?|url|uri)\s+(?:must|should|required|expected)|schema|validationerror|zoderror|https?://|[a-z0-9-]+\.trycloudflare\.com',
          caseSensitive: false)
      .hasMatch(detail)) {
    return 'That action could not be completed. Check your message and try again.';
  }
  if (detail.isEmpty) return 'That action could not be completed. Try again.';
  return detail;
}

WidgetStateProperty<Color?> _sessionPressOverlay(Color accent) =>
    WidgetStateProperty.resolveWith((states) {
      if (states.contains(WidgetState.pressed)) {
        return accent.withValues(alpha: 0.22);
      }
      if (states.contains(WidgetState.hovered) ||
          states.contains(WidgetState.focused)) {
        return accent.withValues(alpha: 0.08);
      }
      return null;
    });

final Set<String> _openingSessionRoutes = <String>{};

void _openSessionAfterPress({
  required BuildContext context,
  required RemoteAppStore store,
  required RemoteSession session,
}) {
  if (!_openingSessionRoutes.add(session.id)) return;
  unawaited(() async {
    try {
      unawaited(HapticFeedback.selectionClick());
      store.openSessionForView(session);
      await Navigator.of(context).push(sessionScreenRoute(session.id));
    } finally {
      _openingSessionRoutes.remove(session.id);
    }
  }());
}

class PairingScreen extends StatefulWidget {
  const PairingScreen({super.key});

  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  bool _submitting = false;
  String? _scanError;

  Future<void> _showPairingHelp() => showModalBottomSheet<void>(
        context: context,
        useSafeArea: true,
        showDragHandle: true,
        builder: (sheetContext) => Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(24, 4, 24, 28),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text('Show a connection code on your computer',
                      style: Theme.of(sheetContext).textTheme.titleLarge),
                  const SizedBox(height: 10),
                  const Text(
                    'Tethoq connects once and uses the coding tools already '
                    'available on that computer.',
                  ),
                  const SizedBox(height: 20),
                  Text('Windows installer',
                      style: Theme.of(sheetContext).textTheme.labelLarge),
                  const SizedBox(height: 8),
                  const Text(
                    'Open Tethoq Bridge from the Start menu and choose Pair '
                    'phone. The Desktop installer includes Bridge. Keep it '
                    'running in the tray while using your phone.',
                  ),
                  const SizedBox(height: 20),
                  Text('Development setup',
                      style: Theme.of(sheetContext).textTheme.labelLarge),
                  const SizedBox(height: 8),
                  const Text(
                    'In the Tethoq project folder, run this command and leave '
                    'it open:',
                  ),
                  const SizedBox(height: 12),
                  const Divider(height: 1),
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 14),
                    child: SelectableText(
                      'npm run phone:pair',
                      style: TextStyle(
                        fontFamily: 'monospace',
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  const Divider(height: 1),
                  const SizedBox(height: 14),
                  const Text(
                    'Scan the code opened in your browser. If the browser does '
                    'not open, use the fallback code shown in the terminal.',
                  ),
                ],
              ),
            ),
          ),
        ),
      );

  Future<void> _scanAndPair(RemoteAppStore store) async {
    final result = await Navigator.of(context).push<ScannedPairingData>(
        MaterialPageRoute(builder: (_) => const PairingQrScannerScreen()));
    if (result == null || !mounted) return;
    PairingPayload payload;
    try {
      payload = PairingPayload.fromJson(jsonDecode(result.payloadText));
    } on Object {
      setState(() => _scanError =
          'That code is out of date. Create a new Tethoq connection code and scan it again.');
      return;
    }
    if (payload.shortCode == null || payload.shortCode!.isEmpty) {
      setState(() => _scanError =
          'That code is out of date. Create a new Tethoq connection code and scan it again.');
      return;
    }
    setState(() {
      _scanError = null;
      _submitting = true;
    });
    try {
      await store.pair(
        payloadText: result.payloadText,
        confirmedShortCode: payload.shortCode!,
        directUrl: result.directUrl,
      );
    } on Object {
      // The store exposes the actionable error below the scan button.
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final nested = Navigator.canPop(context);
    return Scaffold(
      appBar: nested ? AppBar(title: const Text('Connect computer')) : null,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) => SingleChildScrollView(
            padding: EdgeInsets.symmetric(
                horizontal: MediaQuery.sizeOf(context).width < 600 ? 20 : 32,
                vertical: 24),
            child: ConstrainedBox(
              constraints: BoxConstraints(
                  minHeight:
                      (constraints.maxHeight - 48).clamp(0, double.infinity)),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 620),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      if (!nested)
                        Text('Connect to your computer',
                            style: Theme.of(context).textTheme.headlineSmall),
                      const SizedBox(height: 6),
                      Text(
                          'Scan the connection code created by Tethoq on your computer.',
                          style:
                              Theme.of(context).textTheme.bodyMedium?.copyWith(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .onSurface
                                        .withValues(alpha: .68),
                                  )),
                      const SizedBox(height: 16),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(minWidth: 190),
                          child: FilledButton.icon(
                            style: FilledButton.styleFrom(
                              minimumSize: const Size(0, 52),
                              padding:
                                  const EdgeInsets.symmetric(horizontal: 22),
                            ),
                            onPressed:
                                _submitting ? null : () => _scanAndPair(store),
                            icon: _submitting
                                ? const SizedBox.square(
                                    dimension: 18,
                                    child: CircularProgressIndicator(
                                        strokeWidth: 2))
                                : const Icon(Icons.qr_code_scanner),
                            label: Text(
                                _submitting ? 'Connecting…' : 'Scan QR code'),
                          ),
                        ),
                      ),
                      const SizedBox(height: 4),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton.icon(
                          style: TextButton.styleFrom(
                            foregroundColor: Theme.of(context)
                                .colorScheme
                                .onSurface
                                .withValues(alpha: .58),
                          ),
                          onPressed: _showPairingHelp,
                          icon: const Icon(Icons.help_outline, size: 18),
                          label: const Text('Where do I find the code?'),
                        ),
                      ),
                      if (_scanError != null ||
                          store.error != null) ...<Widget>[
                        const SizedBox(height: 16),
                        Text(_scanError ?? store.error!,
                            style: TextStyle(
                                color: Theme.of(context).colorScheme.error)),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class PairingQrScannerScreen extends StatefulWidget {
  const PairingQrScannerScreen({super.key});

  @override
  State<PairingQrScannerScreen> createState() => _PairingQrScannerScreenState();
}

@visibleForTesting
enum PairingScannerLifecycleCommand { none, start, stop }

@visibleForTesting
PairingScannerLifecycleCommand pairingScannerLifecycleCommand(
  AppLifecycleState state, {
  required bool hasCameraPermission,
  required bool returning,
}) {
  // Android's permission prompt changes the app lifecycle before the camera
  // start has finished. Stopping in that window leaves a fresh install with a
  // visible preview that never scans.
  if (!hasCameraPermission || returning) {
    return PairingScannerLifecycleCommand.none;
  }
  switch (state) {
    case AppLifecycleState.detached:
      return PairingScannerLifecycleCommand.none;
    case AppLifecycleState.resumed:
      return PairingScannerLifecycleCommand.start;
    case AppLifecycleState.inactive:
    case AppLifecycleState.hidden:
    case AppLifecycleState.paused:
      return PairingScannerLifecycleCommand.stop;
  }
}

@visibleForTesting
class PairingScannerTransitionCoordinator {
  PairingScannerTransitionCoordinator({
    required this.isRunning,
    required this.isStarting,
    required this.start,
    required this.stop,
    this.onError,
  });

  final bool Function() isRunning;
  final bool Function() isStarting;
  final Future<void> Function() start;
  final Future<void> Function() stop;
  final void Function(Object error)? onError;

  bool _shouldRun = false;
  bool _draining = false;
  Future<void> _settled = Future<void>.value();

  Future<void> get settled => _settled;

  void requestRunning(bool shouldRun) {
    _shouldRun = shouldRun;
    if (_draining) return;
    _draining = true;
    _settled = _drain();
  }

  Future<void> _drain() async {
    try {
      while (true) {
        final target = _shouldRun;
        if (target) {
          if (!isRunning() && !isStarting()) await start();
        } else if (isRunning() || isStarting()) {
          await stop();
        }
        if (target == _shouldRun) return;
      }
    } on Object catch (caught) {
      _shouldRun = false;
      onError?.call(caught);
    } finally {
      // Clear this synchronously inside the drain. Clearing it in a future
      // continuation leaves a gap where a new lifecycle request can observe
      // `_draining == true` after the loop has already stopped and be lost.
      _draining = false;
    }
  }
}

class _PairingQrScannerScreenState extends State<PairingQrScannerScreen>
    with WidgetsBindingObserver {
  final MobileScannerController _controller = MobileScannerController(
    autoStart: false,
    formats: const <BarcodeFormat>[BarcodeFormat.qrCode],
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  late final PairingScannerTransitionCoordinator _scannerTransitions;
  bool _returning = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scannerTransitions = PairingScannerTransitionCoordinator(
      isRunning: () => _controller.value.isRunning,
      isStarting: () => _controller.value.isStarting,
      start: _controller.start,
      stop: _controller.stop,
      onError: (_) {
        if (mounted) {
          setState(() => _error =
              'The camera could not restart. Leave this screen and try again.');
        }
      },
    );
    unawaited(_restartScanner());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _scannerTransitions.requestRunning(false);
    unawaited(
        _scannerTransitions.settled.whenComplete(() => _controller.dispose()));
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (pairingScannerLifecycleCommand(
      state,
      hasCameraPermission: _controller.value.hasCameraPermission,
      returning: _returning,
    )) {
      case PairingScannerLifecycleCommand.none:
        return;
      case PairingScannerLifecycleCommand.start:
        unawaited(_restartScanner());
      case PairingScannerLifecycleCommand.stop:
        _scannerTransitions.requestRunning(false);
    }
  }

  Future<void> _restartScanner() async {
    if (_returning) return;
    _scannerTransitions.requestRunning(true);
    await _scannerTransitions.settled;
  }

  Future<void> _handleCodexRemoteLink(String value) async {
    _returning = true;
    _scannerTransitions.requestRunning(false);
    if (!mounted) return;

    final openInChatGpt = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => AlertDialog(
        title: const Text('This connects the ChatGPT app, not Tethoq'),
        content: const Text(
          'Open it with ChatGPT for Codex Remote, or continue scanning for a '
          'Tethoq connection code.',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Continue scanning'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Open in ChatGPT'),
          ),
        ],
      ),
    );

    if (!mounted) return;
    setState(() {
      _returning = false;
      _error = null;
    });
    // Do not gate the recovery surface or a second scan on camera teardown.
    // The coordinator serializes an in-flight stop with this newer start.
    _scannerTransitions.requestRunning(true);

    if (openInChatGpt == true) {
      try {
        final opened = await launchUrl(
          Uri.parse(value),
          mode: LaunchMode.externalApplication,
        );
        if (!opened && mounted) {
          setState(() =>
              _error = 'ChatGPT could not open. You can continue scanning.');
        }
      } on Object {
        if (mounted) {
          setState(() =>
              _error = 'ChatGPT could not open. You can continue scanning.');
        }
      }
    }
  }

  Future<void> _handleCapture(BarcodeCapture capture) async {
    if (_returning) return;
    final value = capture.barcodes
        .map((barcode) => barcode.rawValue)
        .whereType<String>()
        .firstOrNull;
    if (value == null) return;
    if (isOfficialCodexRemotePairingLink(value)) {
      await _handleCodexRemoteLink(value);
      return;
    }
    try {
      final result = ScannedPairingData.parse(value);
      _returning = true;
      _scannerTransitions.requestRunning(false);
      await _scannerTransitions.settled;
      if (mounted) Navigator.of(context).pop(result);
    } on FormatException catch (error) {
      if (mounted) {
        setState(() => _error = error.message);
      }
    } on Object {
      if (mounted) {
        setState(() => _error = 'That is not a Tethoq connection code.');
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
          title: const Text('Scan QR code'),
          actions: <Widget>[
            IconButton(
              tooltip: 'Toggle flashlight',
              onPressed: _controller.toggleTorch,
              icon: const Icon(Icons.flashlight_on_outlined),
            ),
          ],
        ),
        body: Stack(
          fit: StackFit.expand,
          children: <Widget>[
            MobileScanner(
              controller: _controller,
              onDetect: _handleCapture,
              errorBuilder: (_, __) => const Center(
                child: Padding(
                  padding: EdgeInsets.all(28),
                  child: Text(
                    'Allow camera access, then scan the Tethoq QR code.',
                    textAlign: TextAlign.center,
                  ),
                ),
              ),
            ),
            IgnorePointer(
              child: Center(
                child: Container(
                  width: 270,
                  height: 270,
                  decoration: BoxDecoration(
                    border: Border.all(
                        color: Theme.of(context).colorScheme.primary, width: 3),
                    borderRadius: BorderRadius.circular(18),
                  ),
                ),
              ),
            ),
            Positioned(
              left: 20,
              right: 20,
              bottom: MediaQuery.viewPaddingOf(context).bottom + 24,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surface.withAlpha(235),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Text(
                    _error ??
                        'Hold the phone steady with the QR inside the frame.',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: _error == null
                          ? null
                          : Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      );
}

class SessionsScreen extends StatefulWidget {
  const SessionsScreen({super.key});

  @override
  State<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends State<SessionsScreen> {
  final _search = TextEditingController();
  bool _searchOpen = false;
  final Set<String> _collapsedProjects = <String>{};
  final Set<String> _expandedProjects = <String>{};
  final Set<String> _startingProjectDrafts = <String>{};

  Future<void> _startProjectDraft(
    RemoteAppStore store,
    SessionProjectGroup group,
  ) async {
    final directory = group.directory;
    if (!isSelectableProjectDirectory(directory) ||
        !_startingProjectDrafts.add(group.key)) {
      return;
    }
    if (mounted) setState(() {});
    try {
      final provider = _preferredNewTaskProvider(store);
      if (provider == null) {
        throw StateError('No agent is ready to start a task.');
      }
      final session = await store.startPreparedSession(
        provider.providerId,
        workingDirectory: directory,
      );
      if (!mounted) {
        store.discardPreparedSession(session.id);
        return;
      }
      await Navigator.of(context).push(sessionScreenRoute(session.id));
    } on Object catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(compactErrorDetail(error))),
      );
    } finally {
      _startingProjectDrafts.remove(group.key);
      if (mounted) setState(() {});
    }
  }

  Future<void> _showFilters(RemoteAppStore store) async {
    final statuses = <(String?, String)>[
      (null, 'Any status'),
      ('working', 'Working'),
      ('needs_input', 'Needs input'),
      ('needs_approval', 'Needs approval'),
      ('idle', 'Idle'),
      ('completed', 'Completed'),
      ('failed', 'Failed'),
      ('disconnected', 'Disconnected'),
    ];
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (sheetContext) => FractionallySizedBox(
        heightFactor: .86,
        child: StatefulBuilder(
          builder: (sheetContext, setSheetState) {
            final usableProviders =
                store.providers.where(store.isProviderUsableForTasks).toList();
            void toggleProvider(String providerId) {
              store.toggleTaskProviderFilter(providerId);
              setSheetState(() {});
            }

            return ListView(
              key: const Key('task-filter-sheet'),
              padding: const EdgeInsets.only(bottom: 18),
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 2, 20, 8),
                  child: Text('Filter tasks',
                      style: Theme.of(sheetContext).textTheme.titleLarge),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 4, 12, 2),
                  child: Row(
                    children: <Widget>[
                      Expanded(
                        child: Text('Agent',
                            style:
                                Theme.of(sheetContext).textTheme.labelMedium),
                      ),
                      if (store.hasProviderFilters)
                        TextButton(
                          key: const Key('clear-task-agent-filters'),
                          onPressed: () {
                            store.clearTaskProviderFilters();
                            setSheetState(() {});
                          },
                          child: const Text('Clear'),
                        ),
                    ],
                  ),
                ),
                ListTile(
                  key: const Key('task-filter-all-agents'),
                  leading: const Icon(Icons.all_inclusive_rounded, size: 22),
                  title: const Text('All agents'),
                  selected: !store.hasProviderFilters,
                  trailing: !store.hasProviderFilters
                      ? const Icon(Icons.check_rounded)
                      : null,
                  onTap: () {
                    store.clearTaskProviderFilters();
                    Navigator.pop(sheetContext);
                  },
                ),
                _TaskProviderFilterTile(
                  key: const Key('task-filter-available-agents'),
                  filterId: availableAgentsTaskFilter,
                  title: 'Available agents',
                  leading: const Icon(Icons.done_all_rounded, size: 22),
                  selected: store
                      .taskProviderFilterSelected(availableAgentsTaskFilter),
                  enabled: usableProviders.isNotEmpty,
                  onSelect: () {
                    store.setTaskProviderFilter(availableAgentsTaskFilter);
                    Navigator.pop(sheetContext);
                  },
                  onToggle: () => toggleProvider(availableAgentsTaskFilter),
                ),
                ...store.providers.map((provider) {
                  final enabled = store.isProviderUsableForTasks(provider);
                  return _TaskProviderFilterTile(
                    key: ValueKey<String>(
                        'task-filter-agent-${provider.providerId}'),
                    filterId: provider.providerId,
                    title: provider.displayName,
                    leading:
                        ProviderLogo(providerId: provider.providerId, size: 22),
                    selected:
                        store.taskProviderFilterSelected(provider.providerId),
                    enabled: enabled,
                    onSelect: () {
                      store.setTaskProviderFilter(provider.providerId);
                      Navigator.pop(sheetContext);
                    },
                    onToggle: () => toggleProvider(provider.providerId),
                  );
                }),
                SwitchListTile(
                  key: const Key('task-filter-show-side-chats'),
                  secondary:
                      const Icon(Icons.chat_bubble_outline_rounded, size: 22),
                  title: const Text('Show side chats'),
                  value: store.showSideChats,
                  onChanged: (value) {
                    store.setShowSideChats(value);
                    setSheetState(() {});
                  },
                ),
                const Divider(height: 18),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 4),
                  child: Text('Status',
                      style: Theme.of(sheetContext).textTheme.labelMedium),
                ),
                ...statuses.map((entry) => ListTile(
                      title: Text(entry.$2),
                      trailing: store.stateFilter == entry.$1
                          ? const Icon(Icons.check_rounded)
                          : null,
                      onTap: () {
                        store.setTaskStateFilter(entry.$1);
                        Navigator.pop(sheetContext);
                      },
                    )),
              ],
            );
          },
        ),
      ),
    );
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final sessions = store.taskListMode == 'project'
        ? store.projectModeSessions
        : store.visibleSessions;
    final projectGroups = groupSessionsByProject(sessions);
    final projectNameCounts = <String, int>{};
    for (final group in projectGroups) {
      final key = group.name.toLowerCase();
      projectNameCounts[key] = (projectNameCounts[key] ?? 0) + 1;
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text('Tasks'),
        actions: <Widget>[
          IconButton(
            key: const Key('task-list-mode-toggle'),
            tooltip: store.taskListMode == 'project'
                ? 'Arrange by recency'
                : 'Arrange by project',
            onPressed: () => unawaited(store.setTaskListMode(
                store.taskListMode == 'project' ? 'recent' : 'project')),
            icon: Icon(store.taskListMode == 'project'
                ? Icons.schedule_rounded
                : Icons.folder_copy_outlined),
          ),
          IconButton(
            key: const Key('task-search-toggle'),
            tooltip: _searchOpen ? 'Close task search' : 'Search tasks',
            onPressed: () {
              if (_searchOpen) {
                _search.clear();
                store.setTaskSearch('');
              }
              setState(() => _searchOpen = !_searchOpen);
            },
            icon:
                Icon(_searchOpen ? Icons.close_rounded : Icons.search_rounded),
          ),
          IconButton(
            key: const Key('task-filter-toggle'),
            tooltip: store.hasProviderFilters || store.stateFilter != null
                ? 'Task filters active'
                : 'Filter tasks',
            onPressed: () => unawaited(_showFilters(store)),
            icon: Badge(
              isLabelVisible:
                  store.hasProviderFilters || store.stateFilter != null,
              smallSize: 7,
              child: const Icon(Icons.tune_rounded),
            ),
          ),
          IconButton(
            key: const Key('new-task'),
            tooltip: 'New task',
            onPressed: store.providers.any((provider) =>
                    provider.detected && provider.capabilities.createSession)
                ? () => Navigator.of(context).push(MaterialPageRoute<void>(
                    builder: (_) => const NewSessionScreen()))
                : null,
            icon: const Icon(Icons.add_rounded, size: 27),
          ),
        ],
      ),
      body: _AdaptivePage(
          maxWidth: 860,
          child: Column(
            children: <Widget>[
              _ConnectionBanner(
                  state: store.connectionState, error: store.error),
              if (_searchOpen)
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
                  child: TextField(
                    key: const Key('session-search'),
                    controller: _search,
                    autofocus: true,
                    onChanged: store.setTaskSearch,
                    decoration: const InputDecoration(
                      hintText: 'Search tasks',
                      prefixIcon: Icon(Icons.search_rounded),
                      isDense: true,
                    ),
                  ),
                ),
              Expanded(
                child: sessions.isEmpty
                    ? const Center(child: Text('No tasks found'))
                    : RefreshIndicator(
                        onRefresh: store.refresh,
                        child: store.taskListMode == 'project'
                            ? ListView(
                                key: const Key('project-task-list'),
                                padding: const EdgeInsets.only(bottom: 24),
                                children: projectGroups
                                    .map((group) => _ProjectSessionGroup(
                                          group: group,
                                          collapsed: _collapsedProjects
                                              .contains(group.key),
                                          expanded: _expandedProjects
                                              .contains(group.key),
                                          selectedSessionId:
                                              store.selectedSession?.id,
                                          duplicateName: projectNameCounts[
                                                  group.name.toLowerCase()]! >
                                              1,
                                          onToggle: () => setState(() {
                                            if (!_collapsedProjects
                                                .remove(group.key)) {
                                              _collapsedProjects.add(group.key);
                                            }
                                          }),
                                          onShowMore: () => setState(() {
                                            _expandedProjects.add(group.key);
                                          }),
                                          creatingDraft: _startingProjectDrafts
                                              .contains(group.key),
                                          onCreateDraft:
                                              !isSelectableProjectDirectory(
                                                      group.directory)
                                                  ? null
                                                  : () => unawaited(
                                                        _startProjectDraft(
                                                            store, group),
                                                      ),
                                        ))
                                    .toList(growable: false),
                              )
                            : ListView.separated(
                                key: const Key('recent-task-list'),
                                padding: const EdgeInsets.only(bottom: 24),
                                itemCount: sessions.length,
                                separatorBuilder: (_, __) => const Divider(
                                    height: 1, indent: 54, endIndent: 12),
                                itemBuilder: (context, index) => _SessionTile(
                                  key: ValueKey<String>(
                                      'session-tile-${sessions[index].id}'),
                                  session: sessions[index],
                                ),
                              ),
                      ),
              ),
            ],
          )),
    );
  }
}

class _ProjectSessionGroup extends StatelessWidget {
  const _ProjectSessionGroup({
    required this.group,
    required this.collapsed,
    required this.expanded,
    required this.selectedSessionId,
    required this.duplicateName,
    required this.onToggle,
    required this.onShowMore,
    required this.creatingDraft,
    required this.onCreateDraft,
  });

  final SessionProjectGroup group;
  final bool collapsed;
  final bool expanded;
  final String? selectedSessionId;
  final bool duplicateName;
  final VoidCallback onToggle;
  final VoidCallback onShowMore;
  final bool creatingDraft;
  final VoidCallback? onCreateDraft;

  List<RemoteSession> _sessionsToShow() {
    final ordered = List<RemoteSession>.of(group.sessions)
      ..sort(
          (left, right) => right.lastActivityAt.compareTo(left.lastActivityAt));
    if (expanded || ordered.length <= 5) return ordered;

    final visible = ordered.take(5).toList(growable: true);
    final selectedIndex = selectedSessionId == null
        ? -1
        : ordered.indexWhere((session) => session.id == selectedSessionId);
    if (selectedIndex >= 5) {
      // Keep the active task reachable when a user opens a project containing
      // a large amount of older work. The other four rows remain newest-first.
      visible[4] = ordered[selectedIndex];
    }
    return visible;
  }

  @override
  Widget build(BuildContext context) {
    final sessions = _sessionsToShow();
    final hasMore = !expanded && sessions.length < group.sessions.length;
    return Column(
      key: ValueKey<String>('project-group-${group.key}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        ListTile(
          dense: true,
          contentPadding: const EdgeInsets.fromLTRB(16, 5, 12, 2),
          leading: const Icon(Icons.folder_rounded, size: 22),
          title: Text(group.name, maxLines: 1, overflow: TextOverflow.ellipsis),
          subtitle: duplicateName && group.directory.isNotEmpty
              ? Text(group.directory,
                  maxLines: 1, overflow: TextOverflow.ellipsis)
              : null,
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (onCreateDraft != null)
                SizedBox.square(
                  dimension: 44,
                  child: IconButton(
                    key: ValueKey<String>('project-new-task-${group.key}'),
                    tooltip: 'New task in ${group.name}',
                    onPressed: creatingDraft ? null : onCreateDraft,
                    icon: creatingDraft
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.add_rounded, size: 24),
                  ),
                ),
              SizedBox.square(
                dimension: 44,
                child: Icon(collapsed
                    ? Icons.expand_more_rounded
                    : Icons.expand_less_rounded),
              ),
            ],
          ),
          onTap: onToggle,
        ),
        if (!collapsed) ...<Widget>[
          Padding(
            padding: const EdgeInsets.only(left: 8),
            child: Column(
              children: List<Widget>.generate(
                  sessions.length,
                  (index) => Column(children: <Widget>[
                        _SessionTile(
                          key: ValueKey<String>(
                              'session-tile-${sessions[index].id}'),
                          session: sessions[index],
                          compact: true,
                        ),
                        if (index + 1 < sessions.length)
                          const Divider(height: 1, indent: 16, endIndent: 12),
                      ])),
            ),
          ),
          if (hasMore)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                key: ValueKey<String>('project-show-more-${group.key}'),
                onPressed: onShowMore,
                style: ButtonStyle(
                  foregroundColor: WidgetStateProperty.resolveWith((states) {
                    final emphasized = states.contains(WidgetState.hovered) ||
                        states.contains(WidgetState.focused) ||
                        states.contains(WidgetState.pressed);
                    return Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: emphasized ? .92 : .58);
                  }),
                  backgroundColor:
                      const WidgetStatePropertyAll<Color>(Colors.transparent),
                  overlayColor:
                      const WidgetStatePropertyAll<Color>(Colors.transparent),
                  minimumSize: const WidgetStatePropertyAll<Size>(Size(44, 44)),
                  padding: const WidgetStatePropertyAll<EdgeInsetsGeometry>(
                    EdgeInsets.symmetric(horizontal: 20),
                  ),
                ),
                child: const Text('Show more'),
              ),
            ),
        ],
      ],
    );
  }
}

class _TaskProviderFilterTile extends StatelessWidget {
  const _TaskProviderFilterTile({
    required this.filterId,
    required this.title,
    required this.leading,
    required this.selected,
    required this.enabled,
    required this.onSelect,
    required this.onToggle,
    super.key,
  });

  final String filterId;
  final String title;
  final Widget leading;
  final bool selected;
  final bool enabled;
  final VoidCallback onSelect;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final onSurface = Theme.of(context).colorScheme.onSurface;
    return Opacity(
      opacity: enabled ? 1 : .34,
      child: ListTile(
        enabled: enabled,
        selected: selected,
        leading: leading,
        title: Text(
          title,
          style: TextStyle(
            color: onSurface.withValues(alpha: enabled ? .96 : .58),
            fontWeight: enabled ? FontWeight.w600 : FontWeight.w400,
          ),
        ),
        trailing: Semantics(
          container: true,
          button: true,
          checked: selected,
          enabled: enabled,
          label: '${selected ? 'Remove' : 'Add'} $title '
              '${selected ? 'from' : 'to'} custom filter',
          onTap: enabled ? onToggle : null,
          child: ExcludeSemantics(
            child: SizedBox.square(
              key: ValueKey<String>('task-filter-checkbox-$filterId'),
              dimension: 44,
              child: Center(
                child: Checkbox(
                  value: selected,
                  onChanged: enabled ? (_) => onToggle() : null,
                ),
              ),
            ),
          ),
        ),
        onTap: enabled ? onSelect : null,
      ),
    );
  }
}

class _SessionTile extends StatefulWidget {
  const _SessionTile({
    required this.session,
    this.compact = false,
    super.key,
  });

  final RemoteSession session;
  final bool compact;

  @override
  State<_SessionTile> createState() => _SessionTileState();
}

class _SessionTileState extends State<_SessionTile> {
  bool _pressed = false;
  bool _branching = false;

  Future<void> _showTaskActions(
      RemoteAppStore store, RemoteSession session) async {
    if (_branching) return;
    setState(() => _pressed = false);
    final branch = await showModalBottomSheet<bool>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      constraints: const BoxConstraints(maxWidth: 640),
      builder: (sheetContext) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: SizedBox(
            height: 56,
            child: ListTile(
              key: ValueKey<String>('task-row-branch-${session.id}'),
              minLeadingWidth: 32,
              leading: const Icon(Icons.call_split_rounded),
              title: const Text('Branch in new task'),
              enabled: store.connectionState == BridgeConnectionState.online,
              onTap: store.connectionState == BridgeConnectionState.online
                  ? () => Navigator.pop(sheetContext, true)
                  : null,
            ),
          ),
        ),
      ),
    );
    if (!mounted || branch != true) return;
    setState(() => _branching = true);
    try {
      final created = (await store.branchSession(session.id)).session;
      if (!mounted) return;
      setState(() => _branching = false);
      _openSessionAfterPress(
        context: context,
        store: store,
        session: created,
      );
    } on Object catch (caught) {
      if (!mounted) return;
      final message = compactErrorDetail(caught);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Could not create the new task: $message'),
      ));
    } finally {
      if (mounted && _branching) setState(() => _branching = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final session = widget.session;
    final displayTitle = _sessionDisplayTitle(session);
    final visual = providerVisualThemeFor(session.providerId);
    final selected = widget.compact && store.selectedSession?.id == session.id;
    final preview = session.preview == null ||
            session.preview == session.title ||
            session.preview == displayTitle
        ? session.project
        : session.preview;
    final taskRow = Material(
      color: _pressed
          ? visual.accent.withValues(alpha: 0.20)
          : selected
              ? visual.accent.withValues(alpha: 0.08)
              : Colors.transparent,
      child: InkWell(
        key: ValueKey<String>('session-row-${session.id}'),
        splashFactory: NoSplash.splashFactory,
        highlightColor: visual.accent.withValues(alpha: 0.20),
        overlayColor: _sessionPressOverlay(visual.accent),
        onHighlightChanged: (value) {
          if (_pressed != value && mounted) {
            setState(() => _pressed = value);
          }
        },
        onTap: () => _openSessionAfterPress(
          context: context,
          store: store,
          session: session,
        ),
        onLongPress: _branching
            ? null
            : () {
                unawaited(HapticFeedback.selectionClick());
                unawaited(_showTaskActions(store, session));
              },
        child: widget.compact
            ? Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
                child: Semantics(
                  button: true,
                  selected: selected,
                  label: selected ? '$displayTitle, selected' : displayTitle,
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: <Widget>[
                      Expanded(
                        child: Text(displayTitle,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context)
                                .textTheme
                                .bodyMedium
                                ?.copyWith(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w600,
                                )),
                      ),
                      if (session.state == 'working')
                        SizedBox.square(
                          dimension: 24,
                          child: _InlineStateIndicator(
                            key:
                                ValueKey<String>('session-state-${session.id}'),
                            state: session.state,
                            visual: visual,
                          ),
                        ),
                    ],
                  ),
                ),
              )
            : Padding(
                padding: const EdgeInsets.fromLTRB(14, 7, 13, 7),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Padding(
                      padding: const EdgeInsets.only(top: 1),
                      child: _ProviderBadge(
                        key: ValueKey<String>('session-provider-${session.id}'),
                        providerId: session.providerId,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          SizedBox(
                            height: 26,
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.center,
                              children: <Widget>[
                                Expanded(
                                  child: Text(displayTitle,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodyMedium
                                          ?.copyWith(
                                            fontSize: 15,
                                            fontWeight: FontWeight.w600,
                                          )),
                                ),
                                Transform.translate(
                                  offset: const Offset(0, 2),
                                  child: SizedBox(
                                    key: ValueKey<String>(
                                        'session-time-${session.id}'),
                                    width: 42,
                                    child: Text(
                                      _relativeTime(
                                          session.lastActivityAt.toLocal()),
                                      textAlign: TextAlign.right,
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodySmall
                                          ?.copyWith(
                                            fontSize: 11,
                                            fontFeatures: const <FontFeature>[
                                              FontFeature.tabularFigures(),
                                            ],
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onSurface
                                                .withValues(alpha: .62),
                                          ),
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 3),
                                SizedBox.square(
                                  dimension: 24,
                                  child: session.state == 'offline' ||
                                          session.state == 'disconnected'
                                      ? null
                                      : _InlineStateIndicator(
                                          key: ValueKey<String>(
                                              'session-state-${session.id}'),
                                          state: session.state,
                                          visual: visual,
                                        ),
                                ),
                              ],
                            ),
                          ),
                          if (preview != null &&
                              preview.trim().isNotEmpty) ...<Widget>[
                            const SizedBox(height: 2),
                            Text(preview,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: Theme.of(context)
                                    .textTheme
                                    .bodySmall
                                    ?.copyWith(
                                      fontSize: 13,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurface
                                          .withValues(alpha: .78),
                                    )),
                          ],
                        ],
                      ),
                    ),
                  ],
                ),
              ),
      ),
    );
    final sideChats = store.showSideChats
        ? store.sideChatsFor(session.id)
        : const <RemoteSession>[];
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        taskRow,
        if (!widget.compact && sideChats.isNotEmpty)
          _MobileSideChatPreview(
            parent: session,
            sideChats: sideChats,
            onOpen: (sideChat) =>
                unawaited(_showSideChatSheet(context, sideChat)),
            onCreate: () async {
              try {
                final created = await store.createSideChat(session.id);
                if (context.mounted) {
                  await _showSideChatSheet(context, created);
                }
              } on Object catch (caught) {
                if (!context.mounted) return;
                _showCompactError(context, 'Could not open side chat', caught);
              }
            },
          ),
      ],
    );
  }
}

class _MobileSideChatPreview extends StatelessWidget {
  const _MobileSideChatPreview({
    required this.parent,
    required this.sideChats,
    required this.onOpen,
    required this.onCreate,
  });

  final RemoteSession parent;
  final List<RemoteSession> sideChats;
  final ValueChanged<RemoteSession> onOpen;
  final VoidCallback onCreate;

  Future<void> _showAll(BuildContext context) async {
    final selected = await showModalBottomSheet<RemoteSession>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      constraints: const BoxConstraints(maxWidth: 640),
      builder: (sheetContext) => SafeArea(
        top: false,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(sheetContext).height * .62,
          ),
          child: ListView.builder(
            shrinkWrap: true,
            padding: const EdgeInsets.only(bottom: 8),
            itemCount: sideChats.length,
            itemBuilder: (context, index) {
              final sideChat = sideChats[index];
              return SizedBox(
                height: 52,
                child: ListTile(
                  key: ValueKey<String>('side-chat-list-${sideChat.id}'),
                  leading:
                      const Icon(Icons.chat_bubble_outline_rounded, size: 20),
                  title: Text(
                    _sideChatPreviewText(sideChat),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  onTap: () => Navigator.pop(sheetContext, sideChat),
                ),
              );
            },
          ),
        ),
      ),
    );
    if (selected != null) onOpen(selected);
  }

  @override
  Widget build(BuildContext context) {
    final recent = sideChats.first;
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(54, 0, 12, 5),
      child: Material(
        color: colors.surfaceContainerHighest.withValues(alpha: .42),
        borderRadius: const BorderRadius.only(
          bottomLeft: Radius.circular(8),
          bottomRight: Radius.circular(8),
        ),
        clipBehavior: Clip.antiAlias,
        child: SizedBox(
          height: 48,
          child: Row(
            children: <Widget>[
              const SizedBox(width: 8),
              const Icon(Icons.subdirectory_arrow_right_rounded, size: 18),
              const SizedBox(width: 5),
              Expanded(
                child: InkWell(
                  key: ValueKey<String>('side-chat-preview-${recent.id}'),
                  onTap: () => onOpen(recent),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      _sideChatPreviewText(recent),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context)
                          .textTheme
                          .bodySmall
                          ?.copyWith(fontSize: 13),
                    ),
                  ),
                ),
              ),
              if (sideChats.length > 1)
                TextButton(
                  key: ValueKey<String>('view-side-chats-${parent.id}'),
                  onPressed: () => unawaited(_showAll(context)),
                  style: TextButton.styleFrom(
                    minimumSize: const Size(58, 44),
                    padding: const EdgeInsets.symmetric(horizontal: 7),
                  ),
                  child: const Text('View all'),
                ),
              SizedBox.square(
                dimension: 44,
                child: IconButton(
                  key: ValueKey<String>('new-side-chat-${parent.id}'),
                  tooltip: 'New side chat',
                  onPressed: onCreate,
                  icon: const Icon(Icons.add_rounded, size: 21),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

String _sideChatPreviewText(RemoteSession session) {
  final preview = session.preview?.trim();
  if (preview?.isNotEmpty == true) return preview!;
  final title = session.title.trim();
  return title.isEmpty || title.toLowerCase() == 'side chat'
      ? 'New side chat'
      : title;
}

// Side chats are seeded by copying the parent transcript so the provider has
// the task's context; the bridge marks those copies with a `:copied:` id. The
// sheet keeps that context out of sight so the chat reads as fresh.
bool _isVisibleSideChatMessage(RemoteMessage message) =>
    !message.id.contains(':copied:') &&
    (message.providerMessageId?.startsWith('copied:') != true);

void _showCompactError(BuildContext context, String label, Object error) {
  ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('$label: ${compactErrorDetail(error)}')));
}

Future<void> _showSideChatSheet(
  BuildContext context,
  RemoteSession sideChat, {
  DictationRecorder Function()? dictationRecorderFactory,
}) async {
  final store = StoreScope.read(context);
  final openingHostId = store.activeHost?.hostId;
  final accessibleText = MediaQuery.textScalerOf(context).scale(1) >= 1.3;
  final promoted = await showModalBottomSheet<RemoteSession>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    enableDrag: false,
    backgroundColor: Colors.transparent,
    builder: (sheetContext) => _SideChatSheetHost(
      sideChat: sideChat,
      expandedInitially: accessibleText,
      dictationRecorderFactory: dictationRecorderFactory,
    ),
  );
  if (promoted == null ||
      !context.mounted ||
      store.activeHost?.hostId != openingHostId ||
      (openingHostId != null && promoted.hostId != openingHostId)) {
    return;
  }
  store.openSessionForView(promoted);
  await Navigator.of(context).push(sessionScreenRoute(promoted.id));
}

class _SideChatSheetHost extends StatefulWidget {
  const _SideChatSheetHost({
    required this.sideChat,
    required this.expandedInitially,
    this.dictationRecorderFactory,
  });

  final RemoteSession sideChat;
  final bool expandedInitially;
  final DictationRecorder Function()? dictationRecorderFactory;

  @override
  State<_SideChatSheetHost> createState() => _SideChatSheetHostState();
}

class _SideChatSheetHostState extends State<_SideChatSheetHost> {
  static const double _expandedSize = .94;
  static const double _keyboardExpandedSize = 1;

  final DraggableScrollableController _sheetController =
      DraggableScrollableController();
  bool _keyboardWasOpen = false;
  bool _keyboardHasOpened = false;
  bool _keyboardExpansionScheduled = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final keyboardOpen = MediaQuery.viewInsetsOf(context).bottom > 0;
    if (keyboardOpen) _keyboardHasOpened = true;
    if (keyboardOpen && !_keyboardWasOpen) {
      _keyboardWasOpen = true;
      _expandForKeyboard();
      return;
    }
    _keyboardWasOpen = keyboardOpen;
  }

  void _expandForKeyboard({bool retryIfUnattached = true}) {
    if (!mounted || !_keyboardWasOpen) {
      _keyboardExpansionScheduled = false;
      return;
    }
    if (_sheetController.isAttached) {
      _keyboardExpansionScheduled = false;
      if (_sheetController.size < _keyboardExpandedSize) {
        _sheetController.jumpTo(_keyboardExpandedSize);
      }
      return;
    }
    if (!retryIfUnattached || _keyboardExpansionScheduled) return;
    _keyboardExpansionScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _keyboardExpansionScheduled = false;
      if (!mounted || MediaQuery.viewInsetsOf(context).bottom <= 0) return;
      _expandForKeyboard(retryIfUnattached: false);
    });
  }

  @override
  void dispose() {
    _sheetController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final keyboardOpen = MediaQuery.viewInsetsOf(context).bottom > 0;
    final maximumSize = keyboardOpen ? _keyboardExpandedSize : _expandedSize;
    return DraggableScrollableSheet(
      controller: _sheetController,
      expand: false,
      minChildSize: keyboardOpen ? maximumSize : .42,
      initialChildSize: keyboardOpen
          ? maximumSize
          : widget.expandedInitially || _keyboardHasOpened
              ? _expandedSize
              : .64,
      maxChildSize: maximumSize,
      builder: (context, scrollController) => _SideChatSheet(
        sideChat: widget.sideChat,
        scrollController: scrollController,
        dictationRecorderFactory: widget.dictationRecorderFactory,
      ),
    );
  }
}

class _SideChatSheet extends StatefulWidget {
  const _SideChatSheet({
    required this.sideChat,
    required this.scrollController,
    this.dictationRecorderFactory,
  });

  final RemoteSession sideChat;
  final ScrollController scrollController;
  final DictationRecorder Function()? dictationRecorderFactory;

  @override
  State<_SideChatSheet> createState() => _SideChatSheetState();
}

class _SideChatSheetState extends State<_SideChatSheet>
    with WidgetsBindingObserver {
  final TextEditingController _composer = TextEditingController();
  final FocusNode _composerFocus = FocusNode();
  final List<RemoteAttachment> _attachments = <RemoteAttachment>[];
  final GlobalKey _messageViewportKey = GlobalKey();
  final Map<String, GlobalKey> _messageKeys = <String, GlobalKey>{};
  late final DictationRecorder _recorder = SerializedDictationRecorder(
      widget.dictationRecorderFactory?.call() ?? MicrophoneDictationRecorder());
  RemoteAppStore? _store;
  String? _routeHostId;
  bool _routeOriginCaptured = false;
  bool _staleRouteDismissScheduled = false;
  Timer? _staleRouteDismissTimer;
  bool _loaded = false;
  bool _initialHistoryLoading = false;
  String? _initialHistoryError;
  bool _draftCompositionHydrated = false;
  bool _draftHydrationScheduled = false;
  Future<void>? _draftHydrationOperation;
  bool _preparingSubmission = false;
  bool _sending = false;
  bool _recording = false;
  bool _transcribing = false;
  bool _dictationOperationInFlight = false;
  Future<void>? _dictationCommitOperation;
  int _dictationCommitGeneration = 0;
  Uint8List? _processingDictationBytes;
  String? _processingDictationSourceId;
  bool _cancellingDictation = false;
  bool _forceSheetPop = false;
  bool _allowSheetPop = false;
  bool _attachmentPickerBusy = false;
  bool _promoting = false;
  Timer? _dictationTimer;
  DateTime? _dictationStartedAt;
  Duration _dictationMaximumDuration = _maximumDictationDuration;
  String? _activeDictationSourceId;
  Uint8List? _retryDictationBytes;
  String? _retryDictationSourceId;
  bool _dictationSubmitRequested = false;
  SimplifySettings? _simplifySettings;
  bool _stickToBottom = true;
  bool _scrollScheduled = false;
  bool _readerScrollActive = false;
  bool _transcriptPointerDown = false;
  int _readerInteractionGeneration = 0;
  bool _showJumpToLatest = false;
  int? _lastDisplayRevision;
  bool _loadingOlderHistory = false;
  String? _olderHistoryError;
  bool _directAudioDictation = false;
  bool _processingDictationDirectAudio = false;
  bool _retryDictationDirectAudio = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.scrollController.addListener(_updateSideChatStickToBottom);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final store = StoreScope.of(context);
    if (!_routeOriginCaptured) {
      _routeHostId = store.activeHost?.hostId;
      _routeOriginCaptured = true;
    }
    if (!_sideChatOriginIsCurrent(store)) {
      _scheduleStaleSideChatDismiss();
      return;
    }
    if (_loaded) {
      _reconcileSideChatDraft(store);
      return;
    }
    _loaded = true;
    _store = store;
    store.setVisibleSession(widget.sideChat.id);
    _composer.text = store.drafts[widget.sideChat.id] ?? '';
    _attachments
      ..clear()
      ..addAll(store.draftAttachmentsFor(widget.sideChat.id));
    if (_containsSimplifyCommand(_composer.text)) {
      _simplifySettings =
          store.simplifySettingsFor(widget.sideChat.id) ?? SimplifySettings();
      store.setDraftSimplifySettings(widget.sideChat.id, _simplifySettings);
    }
    _initialHistoryLoading = true;
    unawaited(_loadInitialSideChatHistory(store));
    _scheduleSideChatDraftHydration();
  }

  Future<void> _loadInitialSideChatHistory(RemoteAppStore store) async {
    try {
      await store.loadSessionHistoryFor(widget.sideChat);
      if (!mounted || !_sideChatOriginIsCurrent(store)) return;
      setState(() {
        _initialHistoryLoading = false;
        _initialHistoryError = null;
      });
    } on Object catch (caught) {
      if (!mounted || !_sideChatOriginIsCurrent(store)) return;
      setState(() {
        _initialHistoryLoading = false;
        _initialHistoryError = compactErrorDetail(caught);
      });
    }
  }

  bool _sideChatOriginIsCurrent(RemoteAppStore store) =>
      _routeOriginCaptured &&
      store.activeHost?.hostId == _routeHostId &&
      (_routeHostId == null || widget.sideChat.hostId == _routeHostId) &&
      store.sessions.any((session) =>
          session.id == widget.sideChat.id &&
          (_routeHostId == null || session.hostId == _routeHostId));

  void _scheduleStaleSideChatDismiss() {
    if (_staleRouteDismissScheduled) return;
    _staleRouteDismissScheduled = true;
    _dictationCommitGeneration += 1;
    if (_recording) unawaited(_recorder.cancel());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _dismissStaleSideChatLayer();
    });
  }

  void _dismissStaleSideChatLayer() {
    if (!mounted) return;
    final navigator = Navigator.of(context);
    final route = ModalRoute.of(context);
    if (route?.isCurrent == true) {
      _allowSheetPop = true;
      if (navigator.canPop()) navigator.pop();
      return;
    }
    if (navigator.canPop()) navigator.pop();
    _staleRouteDismissTimer?.cancel();
    _staleRouteDismissTimer =
        Timer(const Duration(milliseconds: 350), _dismissStaleSideChatLayer);
  }

  void _scheduleSideChatDraftHydration() {
    if (_draftHydrationScheduled) return;
    _draftHydrationScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(_ensureSideChatDraftHydrated(showError: false));
    });
  }

  Future<bool> _ensureSideChatDraftHydrated({required bool showError}) async {
    if (_draftCompositionHydrated) return true;
    final store = _store;
    if (store == null) return false;
    var operation = _draftHydrationOperation;
    if (operation == null) {
      final hostId = store.activeHost?.hostId;
      late final Future<void> started;
      started = store
          .hydrateDraftComposition(widget.sideChat.id)
          .then((_) => _applyHydratedSideChatDraft(store, hostId))
          .whenComplete(() {
        if (identical(_draftHydrationOperation, started)) {
          _draftHydrationOperation = null;
        }
      });
      _draftHydrationOperation = started;
      operation = started;
    }
    try {
      await operation;
      return mounted && _draftCompositionHydrated;
    } on Object catch (caught) {
      if (showError && mounted) {
        _showCompactError(context, 'Could not restore saved draft', caught);
      }
      return false;
    }
  }

  void _applyHydratedSideChatDraft(RemoteAppStore store, String? hostId) {
    if (!mounted ||
        !identical(_store, store) ||
        store.activeHost?.hostId != hostId) {
      return;
    }
    final retained = store.retainedDictationFor(widget.sideChat.id);
    setState(() {
      _draftCompositionHydrated = true;
      _reconcileSideChatDraft(store);
      if (retained != null &&
          _retryDictationBytes == null &&
          !_recording &&
          !_transcribing) {
        _retryDictationBytes = retained.bytes;
        _retryDictationSourceId = retained.sourceId;
        _retryDictationDirectAudio = retained.directAudio;
      }
    });
  }

  void _reconcileSideChatDraft(RemoteAppStore store) {
    if (_sending) return;
    final storedText = store.drafts[widget.sideChat.id] ?? '';
    final storedAttachments = store.draftAttachmentsFor(widget.sideChat.id);
    if (_composer.text != storedText) {
      _composer.value = TextEditingValue(
        text: storedText,
        selection: TextSelection.collapsed(offset: storedText.length),
      );
    }
    if (!_sameDraftAttachments(_attachments, storedAttachments)) {
      _attachments
        ..clear()
        ..addAll(storedAttachments);
    }
    _simplifySettings = _containsSimplifyCommand(storedText)
        ? store.simplifySettingsFor(widget.sideChat.id)
        : null;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.scrollController.removeListener(_updateSideChatStickToBottom);
    _dictationCommitGeneration += 1;
    _dictationTimer?.cancel();
    _staleRouteDismissTimer?.cancel();
    unawaited(_recorder.dispose().catchError((Object _) {}));
    final store = _store;
    if (store != null && _sideChatOriginIsCurrent(store)) {
      store.clearVisibleSessionIf(widget.sideChat.id);
      if (!_sending) {
        store.setDraft(widget.sideChat.id, _composer.text);
        if (_draftCompositionHydrated) {
          store.setDraftAttachments(widget.sideChat.id, _attachments);
        }
        store.setDraftSimplifySettings(
          widget.sideChat.id,
          _containsSimplifyCommand(_composer.text) ? _simplifySettings : null,
        );
      }
    }
    _composerFocus.dispose();
    _composer.dispose();
    super.dispose();
  }

  void _updateSideChatStickToBottom() {
    if (!widget.scrollController.hasClients) return;
    final position = widget.scrollController.position;
    // ScrollController listeners also cover accessibility and programmatic
    // scroll actions that do not carry dragDetails/UserScroll notifications.
    // Treat any such move away from the physical tail as reader intent.
    if (!_scrollScheduled && _stickToBottom && !_isAtPhysicalBottom(position)) {
      _stickToBottom = false;
    }
    if (!_scrollScheduled &&
        !_stickToBottom &&
        position.pixels < _historyPrefetchDistance &&
        !_loadingOlderHistory) {
      unawaited(_loadOlderSideChatHistory());
    }
    final showJump = jumpToLatestVisible(
      pixels: position.pixels,
      maxScrollExtent: position.maxScrollExtent,
    );
    if (showJump != _showJumpToLatest && mounted) {
      setState(() => _showJumpToLatest = showJump);
    }
  }

  bool _handleSideChatScrollNotification(ScrollNotification notification) {
    if (notification.depth != 0) return false;
    if (notification is ScrollStartNotification &&
        notification.dragDetails != null) {
      if (!_readerScrollActive) _readerInteractionGeneration += 1;
      _readerScrollActive = true;
    } else if (notification is UserScrollNotification &&
        notification.direction != ScrollDirection.idle) {
      if (!_readerScrollActive) _readerInteractionGeneration += 1;
      _readerScrollActive = true;
    }
    if (_readerScrollActive &&
        (notification is ScrollUpdateNotification ||
            notification is OverscrollNotification ||
            notification is ScrollEndNotification ||
            notification is UserScrollNotification)) {
      _stickToBottom = _isAtPhysicalBottom(notification.metrics);
      if (notification.metrics.pixels < _historyPrefetchDistance &&
          !_loadingOlderHistory) {
        unawaited(_loadOlderSideChatHistory());
      }
    }
    if (notification is ScrollEndNotification ||
        (notification is UserScrollNotification &&
            notification.direction == ScrollDirection.idle)) {
      _readerScrollActive = false;
    }
    return false;
  }

  void _handleSideChatPointerDown(PointerDownEvent _) {
    if (!_transcriptPointerDown) _readerInteractionGeneration += 1;
    _transcriptPointerDown = true;
  }

  void _handleSideChatPointerEnd(PointerEvent _) {
    _transcriptPointerDown = false;
    if (_stickToBottom && !_readerScrollActive) {
      _scheduleSideChatScrollToBottom();
    }
  }

  @override
  void didChangeMetrics() {
    if (_stickToBottom) _scheduleSideChatScrollToBottom();
  }

  void _scheduleSideChatScrollToBottom() {
    if (!_stickToBottom || _transcriptPointerDown || _scrollScheduled) return;
    _scrollScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scrollScheduled = false;
      if (!mounted || !_stickToBottom || !widget.scrollController.hasClients) {
        return;
      }
      final position = widget.scrollController.position;
      if ((position.maxScrollExtent - position.pixels).abs() >
          _physicalBottomTolerance) {
        widget.scrollController.jumpTo(position.maxScrollExtent);
      }
      _updateSideChatStickToBottom();
    });
  }

  void _jumpSideChatToLatest() {
    if (!widget.scrollController.hasClients) return;
    _stickToBottom = true;
    if (_showJumpToLatest) setState(() => _showJumpToLatest = false);
    widget.scrollController
        .jumpTo(widget.scrollController.position.maxScrollExtent);
  }

  GlobalKey? _firstVisibleSideChatMessageKey() {
    final viewport = _messageViewportKey.currentContext?.findRenderObject();
    if (viewport is! RenderBox || !viewport.attached) return null;
    final viewportTop = viewport.localToGlobal(Offset.zero).dy;
    final viewportBottom = viewportTop + viewport.size.height;
    GlobalKey? bestKey;
    var bestTop = double.infinity;
    for (final key in _messageKeys.values) {
      final object = key.currentContext?.findRenderObject();
      if (object is! RenderBox || !object.attached || !object.hasSize) continue;
      final top = object.localToGlobal(Offset.zero).dy;
      final bottom = top + object.size.height;
      if (bottom <= viewportTop || top >= viewportBottom) continue;
      if (top < bestTop) {
        bestTop = top;
        bestKey = key;
      }
    }
    return bestKey;
  }

  double? _sideChatMessageTop(GlobalKey? key) {
    final object = key?.currentContext?.findRenderObject();
    if (object is! RenderBox || !object.attached || !object.hasSize)
      return null;
    return object.localToGlobal(Offset.zero).dy;
  }

  Future<void> _loadOlderSideChatHistory() async {
    final store = _store;
    if (_loadingOlderHistory ||
        _initialHistoryLoading ||
        _initialHistoryError != null ||
        store == null ||
        !_sideChatOriginIsCurrent(store) ||
        !store.hasOlderHistory(widget.sideChat.id)) {
      return;
    }
    _stickToBottom = false;
    setState(() {
      _loadingOlderHistory = true;
      _olderHistoryError = null;
    });
    try {
      final added = await store.loadOlderSessionHistory(widget.sideChat.id);
      if (!mounted || !_sideChatOriginIsCurrent(store) || !added) return;
      final anchorKey = _firstVisibleSideChatMessageKey();
      final anchorTop = _sideChatMessageTop(anchorKey);
      final correctionGeneration = _readerInteractionGeneration;
      final corrected = Completer<void>();
      final timeout = Timer(_prependCorrectionTimeout, () {
        if (!corrected.isCompleted) corrected.complete();
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted &&
            widget.scrollController.hasClients &&
            correctionGeneration == _readerInteractionGeneration &&
            !_transcriptPointerDown &&
            !_readerScrollActive &&
            anchorTop != null) {
          final movedTop = _sideChatMessageTop(anchorKey);
          if (movedTop != null) {
            final position = widget.scrollController.position;
            final target = (position.pixels + movedTop - anchorTop)
                .clamp(0.0, position.maxScrollExtent);
            if ((target - position.pixels).abs() > _physicalBottomTolerance) {
              widget.scrollController.jumpTo(target);
            }
          }
        }
        if (!corrected.isCompleted) corrected.complete();
      });
      await corrected.future;
      timeout.cancel();
    } on Object catch (caught) {
      if (mounted) {
        setState(() => _olderHistoryError = compactErrorDetail(caught));
      }
    } finally {
      if (mounted) {
        setState(() => _loadingOlderHistory = false);
      } else {
        _loadingOlderHistory = false;
      }
    }
  }

  Future<void> _pickAttachment() async {
    if (_preparingSubmission ||
        _attachmentPickerBusy ||
        _sending ||
        _recording ||
        _transcribing ||
        _dictationOperationInFlight) {
      return;
    }
    final store = _store ?? StoreScope.read(context);
    final openingHostId = _routeHostId;
    final openingSessionId = widget.sideChat.id;
    bool originIsCurrent() =>
        mounted &&
        openingHostId == _routeHostId &&
        openingSessionId == widget.sideChat.id &&
        _sideChatOriginIsCurrent(store);
    if (!originIsCurrent()) return;
    setState(() => _attachmentPickerBusy = true);
    try {
      if (!await _ensureSideChatDraftHydrated(showError: true) ||
          !originIsCurrent()) {
        return;
      }
      if (!mounted) return;
      if (!messageAttachmentSlotAvailable(_attachments.length)) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text(_attachmentLimitMessage)));
        return;
      }
      final supportsFiles =
          _supportsGenericFileAttachments(widget.sideChat.providerId);
      final file = await _duringExternalSystemActivity(() => openFile(
            acceptedTypeGroups: supportsFiles
                ? const <XTypeGroup>[]
                : const <XTypeGroup>[
                    XTypeGroup(
                      label: 'Images',
                      extensions: <String>['jpg', 'jpeg', 'png', 'gif', 'webp'],
                      mimeTypes: <String>['image/*'],
                      uniformTypeIdentifiers: <String>['public.image'],
                    ),
                  ],
          ));
      if (!originIsCurrent() || file == null) return;
      final byteLength = await file.length();
      if (!originIsCurrent()) return;
      if (!_isValidPhoneAttachmentLength(byteLength)) {
        throw StateError('Files must be between 1 byte and 25 MiB');
      }
      if (!messageAttachmentBytesAvailable(_attachments, byteLength)) {
        throw StateError(_attachmentTotalLimitMessage);
      }
      final bytes = await file.readAsBytes();
      if (!originIsCurrent()) return;
      if (!_isValidPhoneAttachmentLength(bytes.length)) {
        throw StateError('Files must be between 1 byte and 25 MiB');
      }
      if (!messageAttachmentBytesAvailable(_attachments, bytes.length)) {
        throw StateError(_attachmentTotalLimitMessage);
      }
      final encoded = await compute(_encodeBase64, bytes);
      if (!originIsCurrent()) return;
      setState(() {
        _attachments.add(RemoteAttachment(
          name: file.name,
          mimeType: _genericMimeType(file.name),
          origin: 'file-picker',
          dataBase64: encoded,
          byteLength: bytes.length,
        ));
        store.setDraftAttachments(openingSessionId, _attachments);
      });
    } on Object catch (caught) {
      if (mounted && originIsCurrent()) {
        _showCompactError(context, 'Could not attach file', caught);
      }
    } finally {
      if (mounted) setState(() => _attachmentPickerBusy = false);
    }
  }

  bool _sideChatDirectAudioAvailable(RemoteAppStore store) {
    final providerId = widget.sideChat.providerId;
    if (providerId == 'direct' || providerId == 'codex') {
      final model =
          (store.modelsByProvider[providerId] ?? const <RemoteModel>[])
              .where((item) => item.id == widget.sideChat.modelId)
              .firstOrNull;
      if (model?.supportsAudioInput == true) return true;
    }
    final ears = store.ears;
    if (!ears.enabled || ears.providerId == null || ears.modelId == null) {
      return false;
    }
    final earsModel =
        (store.modelsByProvider[ears.providerId] ?? const <RemoteModel>[])
            .where((item) => item.id == ears.modelId)
            .firstOrNull;
    return earsModel != null && routeAcceptsEarsAudio(earsModel);
  }

  Future<void> _toggleDictation() async {
    if (_preparingSubmission ||
        _sending ||
        _attachmentPickerBusy ||
        _transcribing ||
        _dictationOperationInFlight) {
      return;
    }
    if (!await _ensureSideChatDraftHydrated(showError: true) || !mounted) {
      return;
    }
    if (_preparingSubmission ||
        _sending ||
        _attachmentPickerBusy ||
        _transcribing ||
        _dictationOperationInFlight) {
      return;
    }
    final store = _store ?? StoreScope.read(context);
    final dictationHostId = _routeHostId;
    if (!_sideChatOriginIsCurrent(store) ||
        store.activeHost?.hostId != dictationHostId) {
      return;
    }
    if (_recording) {
      await _finishSideChatDictation();
      return;
    }
    if (_retryDictationBytes != null) {
      await _retrySideChatDictation();
      return;
    }
    final preferredSourceId =
        store.preferredDictationSourceIdForHarness(widget.sideChat.providerId);
    final directAudio = preferredSourceId == directAudioDictationSourceId;
    final source = directAudio
        ? null
        : store.dictationSourceForHarness(widget.sideChat.providerId) ??
            store.readyDictationSources.firstOrNull;
    if (directAudio && !_sideChatDirectAudioAvailable(store)) {
      if (mounted) {
        _showCompactError(
          context,
          'Direct audio is not ready',
          StateError(
              'Choose a model that accepts audio, or configure EARS for audio.'),
        );
      }
      return;
    }
    if (!directAudio && source == null) {
      if (mounted) {
        _showCompactError(
          context,
          'Dictation is not ready',
          StateError('Choose a ready dictation service in Settings.'),
        );
      }
      return;
    }
    setState(() => _dictationOperationInFlight = true);
    try {
      final permitted = await _duringExternalSystemActivity(_recorder.start);
      if (!mounted || !_sideChatOriginIsCurrent(store)) {
        if (permitted) await _recorder.cancel();
        return;
      }
      if (!permitted) {
        _activeDictationSourceId = null;
        _directAudioDictation = false;
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Microphone permission is needed for dictation.'),
        ));
        return;
      }
      final lifecycleState = WidgetsBinding.instance.lifecycleState;
      if (lifecycleState == AppLifecycleState.hidden ||
          lifecycleState == AppLifecycleState.paused ||
          lifecycleState == AppLifecycleState.detached) {
        await _recorder.cancel();
        _activeDictationSourceId = null;
        _directAudioDictation = false;
        return;
      }
      _activeDictationSourceId =
          directAudio ? directAudioDictationSourceId : source!.id;
      _directAudioDictation = directAudio;
      _dictationMaximumDuration = dictationMaximumDurationForAudioBytes(
        directAudio ? _maximumDictationAudioBytes : source!.maxAudioBytes,
      );
      _dictationStartedAt = DateTime.now();
      setState(() => _recording = true);
      _startSideChatDictationTimer();
    } on Object catch (caught) {
      _activeDictationSourceId = null;
      _directAudioDictation = false;
      if (mounted && _sideChatOriginIsCurrent(store)) {
        _showCompactError(context, 'Could not start dictation', caught);
      }
    } finally {
      if (mounted) {
        setState(() => _dictationOperationInFlight = false);
      } else {
        _dictationOperationInFlight = false;
      }
    }
  }

  void _startSideChatDictationTimer() {
    _dictationTimer?.cancel();
    _dictationTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      final startedAt = _dictationStartedAt;
      if (!mounted || !_recording || startedAt == null) return;
      if (DateTime.now().difference(startedAt) >= _dictationMaximumDuration) {
        unawaited(_finishSideChatDictation(submitAfterFinish: true));
      }
    });
  }

  Future<void> _finishSideChatDictation({bool submitAfterFinish = false}) {
    final active = _dictationCommitOperation;
    if (active != null) {
      if (submitAfterFinish) _dictationSubmitRequested = true;
      return active;
    }
    if (!_recording || _dictationOperationInFlight) {
      return Future<void>.value();
    }
    _dictationSubmitRequested = submitAfterFinish;
    late final Future<void> operation;
    operation = _finishSideChatDictationOnce(
      submitAfterFinish: submitAfterFinish,
    ).whenComplete(() {
      if (identical(_dictationCommitOperation, operation)) {
        _dictationCommitOperation = null;
        _dictationOperationInFlight = false;
        if (mounted) setState(() {});
      }
    });
    _dictationCommitOperation = operation;
    return operation;
  }

  Future<void> _finishSideChatDictationOnce({
    required bool submitAfterFinish,
  }) async {
    final generation = ++_dictationCommitGeneration;
    setState(() => _dictationOperationInFlight = true);
    _cancellingDictation = false;
    _clearSideChatProcessingDictation();
    _dictationTimer?.cancel();
    _dictationTimer = null;
    final sourceId = _activeDictationSourceId;
    final directAudio = _directAudioDictation;
    setState(() {
      _recording = false;
      _transcribing = true;
    });
    Uint8List? wave;
    _DictationCommitResult? committed;
    final store = _store ?? StoreScope.read(context);
    try {
      wave = await _recorder.stop();
      await store.retainDictation(
        widget.sideChat.id,
        wave,
        sourceId: sourceId,
        directAudio: directAudio,
      );
      if (!mounted) return;
      setState(() {
        _processingDictationBytes = wave;
        _processingDictationSourceId = sourceId;
        _processingDictationDirectAudio = directAudio;
      });
      if (generation != _dictationCommitGeneration) {
        setState(() {
          _retryDictationBytes = wave;
          _retryDictationSourceId = sourceId;
          _retryDictationDirectAudio = directAudio;
          _transcribing = false;
          _cancellingDictation = false;
        });
        _clearSideChatProcessingDictation();
        _activeDictationSourceId = null;
        _directAudioDictation = false;
        _dictationOperationInFlight = false;
        return;
      }
      committed = await _commitSideChatDictation(
        wave,
        sourceId,
        directAudio: directAudio,
        generation: generation,
        stageForSubmission: _dictationSubmitRequested,
      );
      if (committed == null) return;
      _retryDictationBytes = null;
      _retryDictationSourceId = null;
      _retryDictationDirectAudio = false;
    } on Object catch (caught) {
      if (!mounted) return;
      final cancelledWhileFinalizing =
          _cancellingDictation && generation != _dictationCommitGeneration;
      if (generation != _dictationCommitGeneration &&
          !cancelledWhileFinalizing) {
        return;
      }
      if (cancelledWhileFinalizing) {
        _activeDictationSourceId = null;
        _directAudioDictation = false;
        _dictationOperationInFlight = false;
        _clearSideChatProcessingDictation();
        setState(() {
          if (wave != null) {
            _retryDictationBytes = wave;
            _retryDictationSourceId = sourceId;
            _retryDictationDirectAudio = directAudio;
          }
          _transcribing = false;
          _cancellingDictation = false;
        });
      } else if (wave != null) {
        _retryDictationBytes = wave;
        _retryDictationSourceId = sourceId;
        _retryDictationDirectAudio = directAudio;
      }
      _showCompactError(
        context,
        wave == null ? 'Could not save recording' : 'Dictation stopped',
        caught,
      );
    } finally {
      if (generation == _dictationCommitGeneration) {
        _activeDictationSourceId = null;
        _directAudioDictation = false;
        _dictationOperationInFlight = false;
        _clearSideChatProcessingDictation();
      }
      if (mounted && generation == _dictationCommitGeneration) {
        setState(() {
          _transcribing = false;
          _cancellingDictation = false;
        });
      }
    }
    final shouldSubmit = _dictationSubmitRequested;
    _dictationSubmitRequested = false;
    if (committed == null || !mounted) return;
    if (shouldSubmit) {
      final outcome = await _send(
        dictation: committed.applied ? null : committed,
      );
      if (outcome == _ComposerSubmissionOutcome.rejected &&
          mounted &&
          !committed.applied) {
        await _restoreRejectedSideChatDictation(committed);
      }
    }
  }

  Future<void> _retrySideChatDictation({bool? submitAfterFinish}) {
    final active = _dictationCommitOperation;
    if (active != null) return active;
    if (_retryDictationBytes == null || _transcribing) {
      return Future<void>.value();
    }
    late final Future<void> operation;
    operation = _retrySideChatDictationOnce(
      submitAfterFinish: submitAfterFinish,
    ).whenComplete(() {
      if (identical(_dictationCommitOperation, operation)) {
        _dictationCommitOperation = null;
        _dictationOperationInFlight = false;
        if (mounted) setState(() {});
      }
    });
    _dictationCommitOperation = operation;
    return operation;
  }

  Future<void> _retrySideChatDictationOnce({bool? submitAfterFinish}) async {
    final wave = _retryDictationBytes;
    if (wave == null) return;
    final generation = ++_dictationCommitGeneration;
    final sourceId = _retryDictationSourceId;
    final directAudio = _retryDictationDirectAudio;
    // A retry from the microphone/Retry control only restores the composition.
    // Submission remains tied to an explicit tap on Send.
    final shouldSubmit = submitAfterFinish ?? false;
    _processingDictationBytes = wave;
    _processingDictationSourceId = sourceId;
    _processingDictationDirectAudio = directAudio;
    setState(() => _dictationOperationInFlight = true);
    _cancellingDictation = false;
    setState(() => _transcribing = true);
    _DictationCommitResult? committed;
    try {
      committed = await _commitSideChatDictation(
        wave,
        sourceId,
        directAudio: directAudio,
        generation: generation,
        stageForSubmission: shouldSubmit,
      );
      if (committed == null) return;
      _retryDictationBytes = null;
      _retryDictationSourceId = null;
      _retryDictationDirectAudio = false;
    } on Object catch (caught) {
      if (mounted && generation == _dictationCommitGeneration) {
        _showCompactError(context, 'Dictation retry failed', caught);
      }
    } finally {
      if (generation == _dictationCommitGeneration) {
        _dictationOperationInFlight = false;
        _clearSideChatProcessingDictation();
      }
      if (mounted && generation == _dictationCommitGeneration) {
        setState(() {
          _transcribing = false;
          _cancellingDictation = false;
        });
      }
    }
    if (committed == null || !mounted) return;
    if (shouldSubmit) {
      final outcome = await _send(
        dictation: committed.applied ? null : committed,
      );
      if (outcome == _ComposerSubmissionOutcome.rejected &&
          mounted &&
          !committed.applied) {
        await _restoreRejectedSideChatDictation(committed);
      }
    }
  }

  Future<_DictationCommitResult?> _commitSideChatDictation(
    Uint8List wave,
    String? sourceId, {
    required bool directAudio,
    required int generation,
    required bool stageForSubmission,
  }) async {
    final store = StoreScope.read(context);
    String? transcript;
    RemoteAttachment? audioAttachment;
    if (directAudio) {
      if (!_isValidPhoneAttachmentLength(wave.length)) {
        throw StateError('Audio recordings must be between 1 byte and 25 MiB.');
      }
      final stamp = DateTime.now()
          .toIso8601String()
          .replaceAll(':', '-')
          .replaceAll(RegExp(r'\.\d+'), '');
      final dataBase64 = await compute(_encodeBase64, wave);
      audioAttachment = RemoteAttachment(
        name: 'dictation-$stamp.wav',
        mimeType: 'audio/wav',
        origin: 'dictation',
        dataBase64: dataBase64,
        byteLength: wave.length,
      );
    } else {
      transcript = await store.transcribeDictation(
        wave,
        sessionId: widget.sideChat.id,
        sourceId: sourceId,
      );
    }
    if (!mounted ||
        generation != _dictationCommitGeneration ||
        !_sideChatOriginIsCurrent(store)) {
      return null;
    }
    late final _DictationCommitResult committed;
    if (audioAttachment != null) {
      if (!messageAttachmentSlotAvailable(_attachments.length)) {
        throw StateError(_attachmentLimitMessage);
      }
      if (!messageAttachmentBytesAvailable(_attachments, wave.length)) {
        throw StateError(_attachmentTotalLimitMessage);
      }
      committed = _DictationCommitResult(
        applied: !stageForSubmission,
        attachment: audioAttachment,
      );
    } else {
      final resolvedTranscript = transcript!;
      if (resolvedTranscript.trim().isEmpty) {
        throw StateError('No speech was heard in that recording.');
      }
      committed = _DictationCommitResult(
        applied: !stageForSubmission,
        transcript: resolvedTranscript,
      );
    }
    _retryDictationBytes = null;
    _retryDictationSourceId = null;
    _retryDictationDirectAudio = false;
    if (!stageForSubmission) {
      _applySideChatDictation(committed);
      try {
        await store.clearRetainedDictation(widget.sideChat.id);
      } on Object {
        if (mounted &&
            generation == _dictationCommitGeneration &&
            _sideChatOriginIsCurrent(store)) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text(
                'Recording added. Saved recovery cleanup will retry safely.'),
          ));
        }
      }
    }
    return committed;
  }

  Future<void> _restoreRejectedSideChatDictation(
      _DictationCommitResult committed) async {
    final store = _store ?? StoreScope.read(context);
    if (!mounted || !_sideChatOriginIsCurrent(store)) return;
    _applySideChatDictation(committed);
    try {
      await store.flushDraftJournal();
      if (mounted && _sideChatOriginIsCurrent(store)) {
        await store.clearRetainedDictation(widget.sideChat.id);
      }
    } on Object {
      if (mounted && _sideChatOriginIsCurrent(store)) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text(
              'Recording restored. Saved recovery cleanup will retry safely.'),
        ));
      }
    }
  }

  String _sideChatTextWithTranscript(String transcript) {
    final before = _composer.text.trimRight();
    return before.isEmpty ? transcript : '$before $transcript';
  }

  void _applySideChatDictation(_DictationCommitResult committed) {
    final store = _store ?? StoreScope.read(context);
    final attachment = committed.attachment;
    if (attachment != null) {
      setState(() => _attachments.add(attachment));
      store.setDraftAttachments(widget.sideChat.id, _attachments);
      return;
    }
    final committedText = _sideChatTextWithTranscript(committed.transcript!);
    _composer.value = TextEditingValue(
      text: committedText,
      selection: TextSelection.collapsed(offset: committedText.length),
    );
    store.setDraft(widget.sideChat.id, committedText);
  }

  void _clearSideChatProcessingDictation() {
    _processingDictationBytes = null;
    _processingDictationSourceId = null;
    _processingDictationDirectAudio = false;
  }

  void _cancelSideChatDictationProcessing() {
    if (!_transcribing || _cancellingDictation) return;
    _dictationCommitGeneration += 1;
    final wave = _processingDictationBytes;
    if (wave == null) {
      setState(() => _cancellingDictation = true);
      return;
    }
    setState(() {
      _retryDictationBytes = wave;
      _retryDictationSourceId = _processingDictationSourceId;
      _retryDictationDirectAudio = _processingDictationDirectAudio;
      _transcribing = false;
      _cancellingDictation = false;
    });
    _activeDictationSourceId = null;
    _directAudioDictation = false;
    _clearSideChatProcessingDictation();
  }

  void _discardSideChatDictation() {
    if (_retryDictationBytes == null || _transcribing) return;
    setState(() {
      _retryDictationBytes = null;
      _retryDictationSourceId = null;
      _retryDictationDirectAudio = false;
    });
    unawaited(StoreScope.read(context)
        .clearRetainedDictation(widget.sideChat.id)
        .catchError((_) {}));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      if (_recording) unawaited(_finishSideChatDictation());
    }
  }

  Future<_ComposerSubmissionOutcome> _send({
    _DictationCommitResult? dictation,
  }) async {
    if (_preparingSubmission ||
        _sending ||
        _recording ||
        _transcribing ||
        _dictationOperationInFlight ||
        _attachmentPickerBusy ||
        _hasActiveTextComposition(_composer.value) ||
        !mounted) {
      return _ComposerSubmissionOutcome.rejected;
    }
    setState(() => _preparingSubmission = true);
    if (!await _ensureSideChatDraftHydrated(showError: true) || !mounted) {
      if (mounted) setState(() => _preparingSubmission = false);
      return _ComposerSubmissionOutcome.rejected;
    }
    final dictationTranscript = dictation?.transcript;
    final submittedText = dictationTranscript == null
        ? _composer.text
        : _sideChatTextWithTranscript(dictationTranscript);
    final submittedAttachments = <RemoteAttachment>[
      ..._attachments,
      if (dictation?.attachment != null) dictation!.attachment!,
    ];
    if (_sending ||
        _recording ||
        _transcribing ||
        _dictationOperationInFlight ||
        _attachmentPickerBusy ||
        _hasActiveTextComposition(_composer.value) ||
        (submittedText.trim().isEmpty && submittedAttachments.isEmpty)) {
      setState(() => _preparingSubmission = false);
      return _ComposerSubmissionOutcome.rejected;
    }
    final store = _store ?? StoreScope.read(context);
    final submittedHostId = _routeHostId;
    if (!_sideChatOriginIsCurrent(store) ||
        store.activeHost?.hostId != submittedHostId) {
      setState(() => _preparingSubmission = false);
      return _ComposerSubmissionOutcome.rejected;
    }
    final immutableSubmittedAttachments =
        List<RemoteAttachment>.unmodifiable(submittedAttachments);
    final submittedSimplify =
        _containsSimplifyCommand(submittedText) ? _simplifySettings : null;
    if (widget.scrollController.hasClients) {
      _stickToBottom = _isAtPhysicalBottom(widget.scrollController.position);
    }
    _composer.clear();
    setState(() {
      _preparingSubmission = false;
      _sending = true;
      _attachments.clear();
      _simplifySettings = null;
    });
    // Keep the submitted composition in the store until its acknowledgement.
    // The visible controller can clear immediately while durable ownership
    // remains available for failure recovery or process death.
    var outcome = _ComposerSubmissionOutcome.accepted;
    try {
      await store.sendMessage(widget.sideChat.id, submittedText,
          attachments: immutableSubmittedAttachments,
          simplify: submittedSimplify);
      if (dictation != null &&
          mounted &&
          submittedHostId == _routeHostId &&
          store.activeHost?.hostId == submittedHostId &&
          _sideChatOriginIsCurrent(store)) {
        try {
          await store.clearRetainedDictation(widget.sideChat.id);
        } on Object {
          if (mounted &&
              submittedHostId == _routeHostId &&
              store.activeHost?.hostId == submittedHostId &&
              _sideChatOriginIsCurrent(store)) {
            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text(
                  'Message sent. Saved recording cleanup will finish safely.'),
            ));
          }
        }
      }
    } on Object catch (caught) {
      if (mounted &&
          submittedHostId == _routeHostId &&
          store.activeHost?.hostId == submittedHostId &&
          _sideChatOriginIsCurrent(store)) {
        final restoredText =
            _mergeFailedDraftText(submittedText, _composer.text);
        final restoredAttachments = _mergeFailedAttachments(
            immutableSubmittedAttachments, _attachments);
        _composer.value = TextEditingValue(
          text: restoredText,
          selection: TextSelection.collapsed(offset: restoredText.length),
        );
        setState(() {
          _attachments
            ..clear()
            ..addAll(restoredAttachments);
          if (_containsSimplifyCommand(restoredText)) {
            _simplifySettings ??= submittedSimplify;
          }
        });
        store.setDraft(widget.sideChat.id, restoredText);
        store.setDraftAttachments(widget.sideChat.id, restoredAttachments);
        store.setDraftSimplifySettings(widget.sideChat.id, _simplifySettings);
        try {
          await store.flushDraftJournal();
          if (dictation != null &&
              mounted &&
              submittedHostId == _routeHostId &&
              store.activeHost?.hostId == submittedHostId &&
              _sideChatOriginIsCurrent(store)) {
            await store.clearRetainedDictation(widget.sideChat.id);
          }
        } on Object {
          if (mounted &&
              submittedHostId == _routeHostId &&
              store.activeHost?.hostId == submittedHostId &&
              _sideChatOriginIsCurrent(store)) {
            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text(
                  'Message restored. Its saved recovery will retry safely.'),
            ));
          }
        }
        if (mounted &&
            submittedHostId == _routeHostId &&
            store.activeHost?.hostId == submittedHostId &&
            _sideChatOriginIsCurrent(store)) {
          _showCompactError(context, 'Could not send message', caught);
        }
        outcome = _ComposerSubmissionOutcome.restored;
      } else {
        outcome = _ComposerSubmissionOutcome.originLost;
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
    return outcome;
  }

  void _composerChanged(String value) {
    final store = StoreScope.read(context);
    store.setDraft(widget.sideChat.id, value);
    final settings = _containsSimplifyCommand(value)
        ? _simplifySettings ??
            store.simplifySettingsFor(widget.sideChat.id) ??
            SimplifySettings()
        : null;
    store.setDraftSimplifySettings(widget.sideChat.id, settings);
    if (!identical(settings, _simplifySettings)) {
      setState(() => _simplifySettings = settings);
    }
  }

  Future<void> _editSimplifySettings() async {
    final selected = await showModalBottomSheet<SimplifySettings>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      constraints: const BoxConstraints(maxWidth: 640),
      builder: (sheetContext) => _SimplifySettingsSheet(
          initial: _simplifySettings ?? SimplifySettings()),
    );
    if (!mounted || selected == null) return;
    setState(() => _simplifySettings = selected);
    StoreScope.read(context)
        .setDraftSimplifySettings(widget.sideChat.id, selected);
  }

  void _removeSimplify() {
    final text = _withoutSimplifyCommand(_composer.text);
    _composer.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    _composerChanged(text);
  }

  Future<void> _promote() async {
    if (_preparingSubmission ||
        _promoting ||
        _sending ||
        _attachmentPickerBusy ||
        _recording ||
        _transcribing ||
        _dictationOperationInFlight ||
        _retryDictationBytes != null) {
      return;
    }
    setState(() => _promoting = true);
    try {
      final promoted =
          await StoreScope.read(context).promoteSideChat(widget.sideChat.id);
      if (!mounted) return;
      setState(() {
        _promoting = false;
        _allowSheetPop = true;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) Navigator.pop(context, promoted);
      });
    } on Object catch (caught) {
      if (mounted)
        _showCompactError(context, 'Could not promote side chat', caught);
      if (mounted) setState(() => _promoting = false);
    }
  }

  bool get _dictationBlocksPop =>
      _recording ||
      _transcribing ||
      _dictationCommitOperation != null ||
      _retryDictationBytes != null;

  Future<void> _resolveBlockedSheetPop() async {
    if (_promoting || _forceSheetPop) return;
    _forceSheetPop = true;
    try {
      if (_recording) {
        await _finishSideChatDictation();
      } else if (_transcribing) {
        _cancelSideChatDictationProcessing();
        if (_retryDictationBytes == null) await _dictationCommitOperation;
      } else {
        await _dictationCommitOperation;
      }
      if (!mounted) return;
      if (_retryDictationBytes != null) {
        final discard = await showDialog<bool>(
              context: context,
              builder: (dialogContext) => AlertDialog(
                title: const Text('Discard saved recording?'),
                content: const Text(
                    'This recording has not been added to the message yet.'),
                actions: <Widget>[
                  TextButton(
                    onPressed: () => Navigator.pop(dialogContext, false),
                    child: const Text('Keep editing'),
                  ),
                  FilledButton(
                    onPressed: () => Navigator.pop(dialogContext, true),
                    child: const Text('Discard'),
                  ),
                ],
              ),
            ) ??
            false;
        if (!mounted || !discard) return;
        setState(() {
          _retryDictationBytes = null;
          _retryDictationSourceId = null;
        });
        await StoreScope.read(context)
            .clearRetainedDictation(widget.sideChat.id);
      }
      if (!mounted) return;
      setState(() => _allowSheetPop = true);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) Navigator.of(context).pop();
      });
    } finally {
      if (mounted) _forceSheetPop = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    if (!_routeOriginCaptured) {
      _routeHostId = store.activeHost?.hostId;
      _routeOriginCaptured = true;
    }
    if (!_sideChatOriginIsCurrent(store)) {
      _scheduleStaleSideChatDismiss();
      return const SizedBox.shrink();
    }
    final visual = providerVisualThemeFor(widget.sideChat.providerId);
    final history =
        store.messages[widget.sideChat.id] ?? const <RemoteMessage>[];
    final live = store.liveAssistantMessageFor(widget.sideChat.id);
    final displayMessages = <RemoteMessage>[
      ...history,
      if (live != null) live,
    ].where(_isVisibleSideChatMessage).toList(growable: false);
    final hasHistoryLoader = store.hasOlderHistory(widget.sideChat.id) ||
        store.isOlderHistoryLoading(widget.sideChat.id) ||
        _olderHistoryError != null;
    final displayRevision = _messagePresentationRevision(displayMessages);
    if (_lastDisplayRevision != displayRevision) {
      _lastDisplayRevision = displayRevision;
      _scheduleSideChatScrollToBottom();
    }
    final mediaQuery = MediaQuery.of(context);
    final mediaSize = mediaQuery.size;
    final accessibleText = MediaQuery.textScalerOf(context).scale(1) >= 1.3;
    final keyboardInset = mediaQuery.viewInsets.bottom;
    final keyboardOpen = keyboardInset > 0;
    final compactImeLandscape =
        keyboardOpen && mediaSize.width > mediaSize.height;
    final foldComposerAccessories = compactImeLandscape ||
        (keyboardOpen &&
            mediaSize.height - keyboardInset - mediaQuery.padding.top < 320);
    final condensedSideChatHeader =
        compactImeLandscape || accessibleText || mediaSize.width < 520;
    final simplifyVisible =
        _simplifySettings != null && _containsSimplifyCommand(_composer.text);
    final sideDictationStatusText = _transcribing
        ? _processingDictationBytes == null
            ? 'Stopping…'
            : _processingDictationDirectAudio
                ? 'Recording safe - attaching...'
                : 'Recording safe - transcribing...'
        : _retryDictationBytes != null
            ? _dictationOperationInFlight
                ? 'Recording kept - finishing...'
                : 'Recording kept - Retry'
            : '';
    final composerField = TextField(
      key: const Key('side-chat-composer'),
      controller: _composer,
      focusNode: _composerFocus,
      autofocus: true,
      readOnly: _preparingSubmission,
      minLines: 1,
      maxLines: compactImeLandscape ? 1 : 5,
      onChanged: _composerChanged,
      decoration: const InputDecoration(
        hintText: 'Ask about this task…',
        border: InputBorder.none,
      ),
    );
    return PopScope<void>(
      canPop: _allowSheetPop || (!_dictationBlocksPop && !_promoting),
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && !_promoting) unawaited(_resolveBlockedSheetPop());
      },
      child: Material(
        color: visual.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
        clipBehavior: Clip.antiAlias,
        child: SafeArea(
          top: false,
          child: Padding(
            padding: EdgeInsets.only(
                bottom: MediaQuery.viewInsetsOf(context).bottom),
            child: Column(
              children: <Widget>[
                SizedBox(
                  height: compactImeLandscape ? 44 : 52,
                  child: Row(
                    children: <Widget>[
                      SizedBox(width: compactImeLandscape ? 12 : 16),
                      if (compactImeLandscape)
                        ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 96),
                          child: Text(
                            'Side chat',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                        )
                      else
                        Expanded(
                          child: Text(
                            'Side chat',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                        ),
                      if (compactImeLandscape) ...<Widget>[
                        const SizedBox(width: 8),
                        Expanded(child: composerField),
                      ],
                      ConstrainedBox(
                        constraints: BoxConstraints(
                          maxWidth: condensedSideChatHeader ? 112 : 240,
                        ),
                        child: TextButton(
                          key: const Key('promote-side-chat'),
                          onPressed: _preparingSubmission ||
                                  _promoting ||
                                  _sending ||
                                  _attachmentPickerBusy ||
                                  _recording ||
                                  _transcribing ||
                                  _dictationOperationInFlight ||
                                  _retryDictationBytes != null
                              ? null
                              : _promote,
                          style: TextButton.styleFrom(
                            minimumSize: const Size(44, 44),
                            padding: condensedSideChatHeader
                                ? const EdgeInsets.symmetric(horizontal: 8)
                                : null,
                          ),
                          child: Text(
                            _promoting
                                ? 'Promoting…'
                                : condensedSideChatHeader
                                    ? 'Promote'
                                    : 'Promote to task',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ),
                      SizedBox.square(
                        dimension: 44,
                        child: IconButton(
                          key: const Key('close-side-chat'),
                          tooltip: 'Close side chat',
                          onPressed:
                              _promoting ? null : () => Navigator.pop(context),
                          icon: const Icon(Icons.close_rounded),
                        ),
                      ),
                    ],
                  ),
                ),
                Divider(height: 1, color: visual.border.withValues(alpha: .52)),
                Expanded(
                  child: displayMessages.isEmpty &&
                          (_initialHistoryLoading ||
                              _initialHistoryError != null ||
                              !hasHistoryLoader)
                      ? Center(
                          child: _initialHistoryLoading
                              ? const Text('Loading messages…')
                              : _initialHistoryError != null
                                  ? SingleChildScrollView(
                                      padding: const EdgeInsets.symmetric(
                                          horizontal: 16, vertical: 4),
                                      child: Column(
                                        mainAxisSize: MainAxisSize.min,
                                        children: <Widget>[
                                          Text(
                                            _initialHistoryError!,
                                            textAlign: TextAlign.center,
                                          ),
                                          const SizedBox(height: 8),
                                          TextButton(
                                            onPressed: () {
                                              setState(() {
                                                _initialHistoryLoading = true;
                                                _initialHistoryError = null;
                                              });
                                              unawaited(
                                                  _loadInitialSideChatHistory(
                                                      store));
                                            },
                                            child: const Text('Retry'),
                                          ),
                                        ],
                                      ),
                                    )
                                  : Text(
                                      history.isEmpty
                                          ? 'Ask about this task'
                                          : 'This side chat already carries the parent task\'s context.',
                                      style: TextStyle(
                                        color: Theme.of(context)
                                            .colorScheme
                                            .onSurface
                                            .withValues(alpha: .54),
                                      )),
                        )
                      : Stack(
                          key: _messageViewportKey,
                          children: <Widget>[
                            Positioned.fill(
                              child: Listener(
                                onPointerDown: _handleSideChatPointerDown,
                                onPointerUp: _handleSideChatPointerEnd,
                                onPointerCancel: _handleSideChatPointerEnd,
                                child: NotificationListener<ScrollNotification>(
                                  onNotification:
                                      _handleSideChatScrollNotification,
                                  child: ListView.builder(
                                    key: const Key('side-chat-message-list'),
                                    controller: widget.scrollController,
                                    keyboardDismissBehavior:
                                        ScrollViewKeyboardDismissBehavior
                                            .onDrag,
                                    padding:
                                        const EdgeInsets.fromLTRB(12, 8, 12, 8),
                                    itemCount: displayMessages.length +
                                        (hasHistoryLoader ? 1 : 0),
                                    itemBuilder: (context, index) {
                                      if (hasHistoryLoader && index == 0) {
                                        return Padding(
                                          padding:
                                              const EdgeInsets.only(bottom: 8),
                                          child: SizedBox(
                                            height: 48,
                                            child: Center(
                                              child: store
                                                      .isOlderHistoryLoading(
                                                          widget.sideChat.id)
                                                  ? Semantics(
                                                      liveRegion: true,
                                                      label:
                                                          'Loading earlier messages',
                                                      child: SizedBox.square(
                                                        dimension: 18,
                                                        child:
                                                            CircularProgressIndicator(
                                                                strokeWidth: 2),
                                                      ),
                                                    )
                                                  : TextButton(
                                                      onPressed: () => unawaited(
                                                          _loadOlderSideChatHistory()),
                                                      child: Text(_olderHistoryError ==
                                                              null
                                                          ? 'Load earlier messages'
                                                          : 'Retry earlier messages'),
                                                    ),
                                            ),
                                          ),
                                        );
                                      }
                                      if (hasHistoryLoader) index -= 1;
                                      final message = displayMessages[index];
                                      return _MessageCard(
                                        key: _messageKeys.putIfAbsent(
                                            message.presentationId,
                                            GlobalKey.new),
                                        message: message,
                                        visual: visual,
                                        providerId: widget.sideChat.providerId,
                                        showIdentity:
                                            message.role.toLowerCase() ==
                                                'assistant',
                                        streaming:
                                            message.status == 'streaming',
                                      );
                                    },
                                  ),
                                ),
                              ),
                            ),
                            if (_showJumpToLatest)
                              Positioned(
                                right: 12,
                                bottom: 10,
                                child: Material(
                                  color: visual.surface,
                                  elevation: 3,
                                  shape: const CircleBorder(),
                                  child: IconButton(
                                    key: const Key('side-chat-jump-to-latest'),
                                    tooltip: 'Jump to latest',
                                    onPressed: _jumpSideChatToLatest,
                                    icon: Icon(
                                      Icons.keyboard_arrow_down_rounded,
                                      color: visual.accent,
                                    ),
                                  ),
                                ),
                              ),
                          ],
                        ),
                ),
                if (!foldComposerAccessories && _attachments.isNotEmpty)
                  SizedBox(
                    key: const Key('side-chat-attachment-lane'),
                    height: _attachmentLaneHeight,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      padding: const EdgeInsets.fromLTRB(10, 2, 10, 2),
                      itemCount: _attachments.length,
                      separatorBuilder: (_, __) => const SizedBox(width: 6),
                      itemBuilder: (context, index) => Semantics(
                        key: ValueKey<String>(
                            'side-chat-attachment-chip-${_attachments[index].name}-$index'),
                        label: 'Attachment: ${_attachments[index].name}',
                        child: InputChip(
                          label: Text(_attachments[index].name,
                              overflow: TextOverflow.ellipsis),
                          onDeleted: () => setState(() {
                            _attachments.removeAt(index);
                            store.setDraftAttachments(
                                widget.sideChat.id, _attachments);
                          }),
                        ),
                      ),
                    ),
                  ),
                if (!foldComposerAccessories && simplifyVisible)
                  _SimplifyComposerChip(
                    settings: _simplifySettings!,
                    visual: visual,
                    onPressed: () => unawaited(_editSimplifySettings()),
                    onDeleted: _removeSimplify,
                  ),
                Padding(
                  padding: compactImeLandscape
                      ? const EdgeInsets.fromLTRB(8, 2, 8, 2)
                      : const EdgeInsets.fromLTRB(8, 6, 8, 8),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      if (!compactImeLandscape) composerField,
                      SizedBox(
                        height:
                            compactImeLandscape ? 44 : _sideChatActionRowHeight,
                        child: Row(
                          key: const Key('side-chat-actions'),
                          children: <Widget>[
                            SizedBox.square(
                              dimension: 44,
                              child: IconButton(
                                key: const Key('side-chat-attachment'),
                                tooltip: 'Attach file',
                                onPressed: _preparingSubmission ||
                                        _sending ||
                                        _attachmentPickerBusy ||
                                        _recording ||
                                        _transcribing ||
                                        _dictationOperationInFlight ||
                                        _retryDictationBytes != null
                                    ? null
                                    : _pickAttachment,
                                icon: const Icon(Icons.add_rounded),
                              ),
                            ),
                            Expanded(
                              child: foldComposerAccessories &&
                                      !_transcribing &&
                                      _retryDictationBytes == null &&
                                      (_attachments.isNotEmpty ||
                                          simplifyVisible)
                                  ? ListView.separated(
                                      key: _attachments.isNotEmpty
                                          ? const Key(
                                              'side-chat-attachment-lane')
                                          : const Key(
                                              'side-chat-compact-accessory-lane'),
                                      scrollDirection: Axis.horizontal,
                                      padding: const EdgeInsets.symmetric(
                                          horizontal: 4),
                                      itemCount: _attachments.length +
                                          (simplifyVisible ? 1 : 0),
                                      separatorBuilder: (_, __) =>
                                          const SizedBox(width: 6),
                                      itemBuilder: (context, index) {
                                        if (index < _attachments.length) {
                                          final attachment =
                                              _attachments[index];
                                          return SizedBox(
                                            height: 44,
                                            child: Semantics(
                                              key: ValueKey<String>(
                                                  'side-chat-attachment-chip-${attachment.name}-$index'),
                                              label:
                                                  'Attachment: ${attachment.name}',
                                              child: InputChip(
                                                label: Text(
                                                  attachment.name,
                                                  overflow:
                                                      TextOverflow.ellipsis,
                                                ),
                                                onDeleted: () => setState(() {
                                                  _attachments.removeAt(index);
                                                  store.setDraftAttachments(
                                                      widget.sideChat.id,
                                                      _attachments);
                                                }),
                                                visualDensity:
                                                    VisualDensity.compact,
                                                materialTapTargetSize:
                                                    MaterialTapTargetSize
                                                        .padded,
                                              ),
                                            ),
                                          );
                                        }
                                        return SizedBox(
                                          key: const Key(
                                              'simplify-composer-chip'),
                                          height: 44,
                                          child: Semantics(
                                            label: 'Simplify settings',
                                            button: true,
                                            child: InputChip(
                                              avatar: Icon(
                                                Icons.short_text_rounded,
                                                size: 17,
                                                color: visual.accent,
                                              ),
                                              label: Text(
                                                  'Simplify · ${_simplifySettings!.maxWords} words'),
                                              tooltip: 'Simplify settings',
                                              onPressed: () => unawaited(
                                                  _editSimplifySettings()),
                                              onDeleted: _removeSimplify,
                                              deleteIcon: const Icon(
                                                  Icons.close_rounded,
                                                  size: 17),
                                              visualDensity:
                                                  VisualDensity.compact,
                                              materialTapTargetSize:
                                                  MaterialTapTargetSize.padded,
                                            ),
                                          ),
                                        );
                                      },
                                    )
                                  : Padding(
                                      padding: const EdgeInsets.symmetric(
                                          horizontal: 4),
                                      child: Semantics(
                                        liveRegion: true,
                                        label: sideDictationStatusText,
                                        child: ExcludeSemantics(
                                          child: Text(
                                            sideDictationStatusText,
                                            key: _transcribing
                                                ? const Key(
                                                    'side-chat-dictation-processing')
                                                : _retryDictationBytes != null
                                                    ? const Key(
                                                        'side-chat-dictation-retry-status')
                                                    : null,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: Theme.of(context)
                                                .textTheme
                                                .labelSmall
                                                ?.copyWith(
                                                  color: Theme.of(context)
                                                      .colorScheme
                                                      .onSurfaceVariant,
                                                ),
                                          ),
                                        ),
                                      ),
                                    ),
                            ),
                            if (_transcribing)
                              TextButton(
                                key: const Key(
                                    'cancel-side-chat-dictation-processing'),
                                onPressed: _cancellingDictation
                                    ? null
                                    : _cancelSideChatDictationProcessing,
                                style: TextButton.styleFrom(
                                  minimumSize: const Size(44, 44),
                                  padding:
                                      const EdgeInsets.symmetric(horizontal: 6),
                                  tapTargetSize:
                                      MaterialTapTargetSize.shrinkWrap,
                                ),
                                child: Text(_cancellingDictation
                                    ? 'Saving…'
                                    : 'Cancel'),
                              )
                            else if (_retryDictationBytes != null)
                              TextButton(
                                key: const Key('discard-side-chat-dictation'),
                                onPressed: _dictationOperationInFlight
                                    ? null
                                    : _discardSideChatDictation,
                                style: TextButton.styleFrom(
                                  minimumSize: const Size(44, 44),
                                  padding:
                                      const EdgeInsets.symmetric(horizontal: 6),
                                  tapTargetSize:
                                      MaterialTapTargetSize.shrinkWrap,
                                ),
                                child: const Text('Discard'),
                              ),
                            SizedBox.square(
                              dimension: 44,
                              child: IconButton(
                                key: const Key('side-chat-dictation'),
                                tooltip: _recording
                                    ? 'Stop dictation'
                                    : _transcribing ||
                                            _dictationOperationInFlight
                                        ? _retryDictationBytes != null
                                            ? 'Retry available when processing finishes'
                                            : 'Processing dictation'
                                        : _retryDictationBytes != null
                                            ? 'Retry saved dictation'
                                            : 'Dictate',
                                onPressed: _preparingSubmission ||
                                        _sending ||
                                        _attachmentPickerBusy ||
                                        _transcribing ||
                                        _dictationOperationInFlight
                                    ? null
                                    : _toggleDictation,
                                icon: _transcribing ||
                                        (_dictationOperationInFlight &&
                                            !_recording)
                                    ? const SizedBox.square(
                                        dimension: 18,
                                        child: CircularProgressIndicator(
                                            strokeWidth: 2),
                                      )
                                    : Icon(_retryDictationBytes != null
                                        ? Icons.replay_rounded
                                        : _recording
                                            ? Icons.stop_circle_outlined
                                            : Icons.mic_none_rounded),
                              ),
                            ),
                            ValueListenableBuilder<TextEditingValue>(
                              valueListenable: _composer,
                              builder: (context, composerValue, _) {
                                final composerEmpty =
                                    composerValue.text.trim().isEmpty &&
                                        _attachments.isEmpty;
                                final sendEnabled = !_preparingSubmission &&
                                    !_sending &&
                                    !_transcribing &&
                                    !_dictationOperationInFlight &&
                                    !_attachmentPickerBusy &&
                                    !_hasActiveTextComposition(composerValue) &&
                                    (!composerEmpty ||
                                        _recording ||
                                        _retryDictationBytes != null);
                                final submissionStatus = _preparingSubmission
                                    ? 'Preparing message'
                                    : _sending
                                        ? 'Sending message'
                                        : null;
                                final button = SizedBox.square(
                                  dimension: 44,
                                  child: IconButton(
                                    key: const Key('side-chat-send'),
                                    tooltip: submissionStatus != null
                                        ? null
                                        : _recording
                                            ? 'Stop dictation and send'
                                            : _retryDictationBytes != null
                                                ? 'Retry dictation and send'
                                                : 'Send',
                                    onPressed: sendEnabled
                                        ? _recording
                                            ? () => unawaited(
                                                _finishSideChatDictation(
                                                    submitAfterFinish: true))
                                            : _retryDictationBytes != null
                                                ? () => unawaited(
                                                    _retrySideChatDictation(
                                                        submitAfterFinish:
                                                            true))
                                                : _send
                                        : null,
                                    icon: _preparingSubmission || _sending
                                        ? const SizedBox.square(
                                            dimension: 18,
                                            child: CircularProgressIndicator(
                                                strokeWidth: 2),
                                          )
                                        : const Icon(Icons.send_rounded),
                                  ),
                                );
                                return submissionStatus == null
                                    ? button
                                    : Semantics(
                                        liveRegion: true,
                                        label: submissionStatus,
                                        child: ExcludeSemantics(child: button),
                                      );
                              },
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _AttachmentMenuSurface extends StatelessWidget {
  const _AttachmentMenuSurface({
    required this.filesEnabled,
    required this.minimumRowHeight,
    required this.onSelected,
  });

  final bool filesEnabled;
  final double minimumRowHeight;
  final ValueChanged<String> onSelected;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      key: const Key('attachment-source-menu'),
      elevation: 12,
      shadowColor: Colors.black.withValues(alpha: .36),
      color: colors.surfaceContainerHigh,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: colors.outlineVariant.withValues(alpha: .7)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            _AttachmentMenuItem(
              key: const Key('attachment-source-photos'),
              label: 'Photos',
              icon: Icons.photo_outlined,
              minimumHeight: minimumRowHeight,
              enabled: true,
              onPressed: () => onSelected('image'),
            ),
            _AttachmentMenuItem(
              key: const Key('attachment-source-files'),
              label: 'Files',
              icon: Icons.attach_file_rounded,
              minimumHeight: minimumRowHeight,
              enabled: filesEnabled,
              onPressed: () => onSelected('file'),
            ),
          ],
        ),
      ),
    );
  }
}

class _AttachmentMenuItem extends StatelessWidget {
  const _AttachmentMenuItem({
    required this.label,
    required this.icon,
    required this.minimumHeight,
    required this.enabled,
    required this.onPressed,
    super.key,
  });

  final String label;
  final IconData icon;
  final double minimumHeight;
  final bool enabled;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        enabled: enabled,
        label: label,
        child: Opacity(
          opacity: enabled ? 1 : .38,
          child: InkWell(
            onTap: enabled ? onPressed : null,
            child: ConstrainedBox(
              constraints: BoxConstraints(
                minWidth: double.infinity,
                minHeight: minimumHeight,
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: Row(
                  children: <Widget>[
                    Icon(icon, size: 21),
                    const SizedBox(width: 11),
                    Expanded(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
}

class SessionScreen extends StatefulWidget {
  const SessionScreen({
    required this.sessionId,
    this.imageAttachmentPicker,
    this.dictationRecorder,
    this.sideChatDictationRecorderFactory,
    super.key,
  });

  final String sessionId;
  final Future<RemoteAttachment?> Function()? imageAttachmentPicker;
  final DictationRecorder? dictationRecorder;
  final DictationRecorder Function()? sideChatDictationRecorderFactory;

  @override
  State<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends State<SessionScreen>
    with WidgetsBindingObserver {
  late final _MeshTextEditingController _composer;
  final FocusNode _composerFocus = FocusNode();
  final TextEditingController _preparedDirectory = TextEditingController();
  late final _ConversationScrollController _scrollController;
  final GlobalKey _conversationViewportKey = GlobalKey();
  final Map<String, GlobalKey> _timelineKeys = <String, GlobalKey>{};
  RemoteAppStore? _store;
  String? _routeHostId;
  bool _routeOriginCaptured = false;
  bool _staleRouteDismissScheduled = false;
  Timer? _staleRouteDismissTimer;
  bool _draftLoaded = false;
  bool _draftCompositionHydrated = false;
  bool _draftHydrationScheduled = false;
  Future<void>? _draftHydrationOperation;
  bool _preparingSubmission = false;
  bool _sending = false;
  bool _interruptingCurrentWork = false;
  RemoteSession? _preparedSubmissionOrigin;
  bool _stickToBottom = true;
  bool _readerScrollActive = false;
  bool _transcriptPointerDown = false;
  bool _programmaticTailJump = false;
  int _readerInteractionGeneration = 0;
  bool _showJumpToLatest = false;
  int? _lastConversationLayoutRevision;
  int? _lastConversationPresentationRevision;
  bool _loadingOlderHistory = false;
  String? _historyLoadError;
  int _slashCommandSelection = 0;
  bool _slashCommandPaletteDismissed = false;
  String? _slashCommandPresentationSignature;
  SimplifySettings? _simplifySettings;
  String? _modelProviderId;
  String? _selectedModelId;
  String? _selectedReasoningEffort;
  VisionProxySelection? _visionProxySelection;
  String? _visionStatusLoadingFor;
  String? _visionStatusLoadingHostId;
  int _visionStatusGeneration = 0;
  Timer? _visionStatusRetryTimer;
  bool _visionPickerOpening = false;
  String? _deliveryMode;
  String? _imageModelNoticeId;
  String? _childSessionsLoadedFor;
  String? _contextLoadedFor;
  String? _walletLoadedFor;
  bool _sourceActionRunning = false;
  bool _queuedInstructionActionsOpen = false;
  bool _sideChatOpening = false;
  bool _modelPickerOpening = false;
  bool _reasoningPickerOpening = false;
  bool _deliveryPickerOpening = false;
  Timer? _childSessionPollTimer;
  Timer? _liveSessionPollTimer;
  bool _liveSessionPollInFlight = false;
  Timer? _dictationTimer;
  late final DictationRecorder _dictationRecorder;
  DateTime? _dictationStartedAt;
  Duration _activeDictationMaximumDuration = _maximumDictationDuration;
  bool _recordingDictation = false;
  bool _transcribingDictation = false;
  bool _dictationOperationInFlight = false;
  Future<void>? _dictationCommitOperation;
  int _dictationCommitGeneration = 0;
  Uint8List? _processingDictationBytes;
  String? _processingDictationSourceId;
  String? _processingDictationSessionId;
  bool _processingDictationDirectAudio = false;
  bool _cancellingDictation = false;
  bool _forceSessionPop = false;
  bool _allowSessionPop = false;
  bool _attachmentPickerBusy = false;
  bool _attachmentMenuOpen = false;
  bool _preparedProjectPickerOpen = false;
  bool _dictationSourcePickerOpen = false;
  bool _directAudioDictation = false;
  final ValueNotifier<double> _dictationLevel = ValueNotifier<double>(0);
  final ValueNotifier<Duration> _dictationElapsed =
      ValueNotifier<Duration>(Duration.zero);
  StreamSubscription<double>? _dictationLevelSubscription;
  String? _activeDictationSourceId;
  String? _dictationSessionId;
  Uint8List? _retryDictationBytes;
  String? _retryDictationSourceId;
  String? _retryDictationSessionId;
  bool _retryDictationDirectAudio = false;
  bool _retryDictationSubmitAfterFinish = false;
  bool _dictationSubmitRequested = false;
  final List<RemoteAttachment> _attachments = <RemoteAttachment>[];
  final List<DelegationSelection> _meshTargets = <DelegationSelection>[];
  final Set<String> _meshModelCatalogRequests = <String>{};
  final GlobalKey _attachmentAnchorKey =
      GlobalKey(debugLabel: 'attachment-button-anchor');
  bool _meshDraftReconciled = false;
  bool _meshPickerOpening = false;
  bool _suppressNextSlashCommandEnterNewline = false;
  String _lastComposerText = '';

  @override
  void initState() {
    super.initState();
    _composer = _MeshTextEditingController(
      targetCount: () => _meshTargets.length,
      buildTarget: _buildInlineMeshTarget,
    );
    WidgetsBinding.instance.addObserver(this);
    _scrollController = _ConversationScrollController(
      shouldFollowLatest: () =>
          _stickToBottom && !_transcriptPointerDown && !_readerScrollActive,
    );
    _dictationRecorder = SerializedDictationRecorder(
        widget.dictationRecorder ?? MicrophoneDictationRecorder());
    _scrollController.addListener(_updateStickToBottom);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final store = StoreScope.of(context);
    if (!_routeOriginCaptured) {
      _routeHostId = store.activeHost?.hostId;
      _routeOriginCaptured = true;
    }
    if (!_routeOriginIsCurrent(store)) {
      _scheduleStaleRouteDismiss();
      return;
    }
    if (!identical(_store, store)) {
      _store = store;
      store.setVisibleSession(widget.sessionId);
    }
    if (!_draftLoaded) {
      final initialDraft = store.drafts[widget.sessionId] ?? '';
      _setComposerValue(TextEditingValue(
        text: initialDraft,
        selection: TextSelection.collapsed(offset: initialDraft.length),
      ));
      _attachments
        ..clear()
        ..addAll(store.draftAttachmentsFor(widget.sessionId));
      if (_containsSimplifyCommand(_composer.text) &&
          _filteredSlashCommands(_composer.text) == null) {
        _simplifySettings =
            store.simplifySettingsFor(widget.sessionId) ?? SimplifySettings();
        store.setDraftSimplifySettings(widget.sessionId, _simplifySettings);
      }
      _deliveryMode = store.defaultDeliveryMode;
      _slashCommandPresentationSignature =
          _slashCommandSignature(_composer.text);
      _draftLoaded = true;
      _reconcileMeshTargets(store);
      _scheduleSessionDraftHydration();
    } else {
      _reconcileSessionDraft(store);
    }
    final session =
        store.sessions.where((item) => item.id == widget.sessionId).firstOrNull;
    final visionHostId = store.activeHost?.hostId;
    if (session == null || visionHostId == null) {
      _stopVisionStatusSync();
      _visionProxySelection = null;
    } else {
      final cachedVision = store.visionBySession[session.id];
      if (cachedVision != null) {
        _stopVisionStatusSync();
        _visionProxySelection = cachedVision.configured;
      } else if (!store.canSyncVisionStatus) {
        _stopVisionStatusSync();
        _visionProxySelection = null;
      } else if (_visionStatusLoadingFor != session.id ||
          _visionStatusLoadingHostId != visionHostId) {
        _cancelVisionStatusRetry();
        _visionProxySelection = null;
        _visionStatusLoadingFor = session.id;
        _visionStatusLoadingHostId = visionHostId;
        final generation = ++_visionStatusGeneration;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || widget.sessionId != session.id) return;
          unawaited(_refreshVisionStatus(
              store, session.id, visionHostId, generation));
        });
      }
    }
    if (session != null && _modelProviderId != session.providerId) {
      _modelProviderId = session.providerId;
      _selectedModelId = session.modelId;
      _selectedReasoningEffort = session.reasoningEffort;
      if (store.isPreparedSession(session.id)) {
        _preparedDirectory.text = session.workingDirectory ?? '';
      }
      if (_supportsTurnModelSelection(session.providerId)) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || _modelProviderId != session.providerId) return;
          unawaited(store.loadModels(session.providerId).then((models) {
            if (!mounted || _modelProviderId != session.providerId) return;
            final configured = models
                .where((model) => model.id == _selectedModelId)
                .firstOrNull;
            final prepared = store.isPreparedSession(session.id);
            final defaults = prepared
                ? store.agentDefaultSelectionFor(session.providerId, models)
                : null;
            final initialModel = configured ??
                models
                    .where((model) => model.id == defaults?.modelId)
                    .firstOrNull ??
                models.where((model) => model.isDefault).firstOrNull ??
                models.firstOrNull;
            if (prepared &&
                initialModel != null &&
                _selectedModelId == session.modelId) {
              final reasoningEffort = defaults?.modelId == initialModel.id
                  ? defaults?.reasoningEffort
                  : _defaultConcreteReasoningEffort(initialModel);
              setState(() {
                _selectedModelId = initialModel.id;
                _selectedReasoningEffort = reasoningEffort;
              });
              store.updatePreparedModelSelection(
                session.id,
                modelId: initialModel.id,
                reasoningEffort: reasoningEffort,
              );
            }
            if (_attachments.isNotEmpty) {
              _maybeShowImageModelNotice(initialModel);
            } else if (!prepared || _selectedModelId != session.modelId) {
              setState(() {});
            }
          }));
        });
      }
    } else if (session?.state == 'working') {
      _selectedModelId = session?.modelId;
      _selectedReasoningEffort = session?.reasoningEffort;
    }
    if (session != null &&
        !store.isPreparedSession(session.id) &&
        _contextLoadedFor != session.id) {
      _contextLoadedFor = session.id;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || _contextLoadedFor != session.id) return;
        unawaited(() async {
          try {
            await store.loadSessionContext(session.id);
          } on Object {
            // Some harnesses do not expose usage. The touch control remains
            // available and explains that state without interrupting chat.
          }
        }());
      });
    }
    if (session != null) {
      _configureChildSessionMonitoring(store, session);
      _configureLiveSessionMonitoring(store, session);
    }
  }

  bool _routeOriginIsCurrent(RemoteAppStore store) =>
      _routeOriginCaptured &&
      store.activeHost?.hostId == _routeHostId &&
      _routeSession(store) != null;

  bool _routeOperationOriginIsCurrent(
    RemoteAppStore store, {
    required String? hostId,
    required String sessionId,
  }) =>
      mounted &&
      identical(_store, store) &&
      _routeHostId == hostId &&
      store.activeHost?.hostId == hostId &&
      widget.sessionId == sessionId &&
      store.sessions.any((session) =>
          session.id == sessionId &&
          (hostId == null || session.hostId == hostId));

  RemoteSession? _routeSession(RemoteAppStore store) {
    bool belongs(RemoteSession session) =>
        session.id == widget.sessionId &&
        (_routeHostId == null || session.hostId == _routeHostId);
    return store.sessions.where(belongs).firstOrNull ??
        (store.selectedSession != null && belongs(store.selectedSession!)
            ? store.selectedSession
            : null) ??
        (_preparedSubmissionOrigin != null &&
                belongs(_preparedSubmissionOrigin!)
            ? _preparedSubmissionOrigin
            : null);
  }

  void _scheduleStaleRouteDismiss() {
    if (_staleRouteDismissScheduled) return;
    _staleRouteDismissScheduled = true;
    _dictationCommitGeneration += 1;
    if (_recordingDictation) unawaited(_dictationRecorder.cancel());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _dismissStaleSessionLayer();
    });
  }

  void _dismissStaleSessionLayer() {
    if (!mounted) return;
    final navigator = Navigator.of(context);
    final route = ModalRoute.of(context);
    if (route?.isCurrent == true) {
      _allowSessionPop = true;
      if (navigator.canPop()) navigator.pop();
      return;
    }
    if (navigator.canPop()) navigator.pop();
    _staleRouteDismissTimer?.cancel();
    _staleRouteDismissTimer =
        Timer(const Duration(milliseconds: 350), _dismissStaleSessionLayer);
  }

  void _scheduleSessionDraftHydration() {
    if (_draftHydrationScheduled) return;
    _draftHydrationScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(_ensureSessionDraftHydrated(showError: false));
    });
  }

  Future<bool> _ensureSessionDraftHydrated({required bool showError}) async {
    if (_draftCompositionHydrated) return true;
    final store = _store;
    if (store == null) return false;
    var operation = _draftHydrationOperation;
    if (operation == null) {
      final hostId = store.activeHost?.hostId;
      late final Future<void> started;
      started = store
          .hydrateDraftComposition(widget.sessionId)
          .then((_) => _applyHydratedSessionDraft(store, hostId))
          .whenComplete(() {
        if (identical(_draftHydrationOperation, started)) {
          _draftHydrationOperation = null;
        }
      });
      _draftHydrationOperation = started;
      operation = started;
    }
    try {
      await operation;
      return mounted && _draftCompositionHydrated;
    } on Object catch (caught) {
      if (showError && mounted) {
        _showCompactError(context, 'Could not restore saved draft', caught);
      }
      return false;
    }
  }

  void _applyHydratedSessionDraft(RemoteAppStore store, String? hostId) {
    if (!mounted ||
        !identical(_store, store) ||
        store.activeHost?.hostId != hostId) {
      return;
    }
    final retained = store.retainedDictationFor(widget.sessionId);
    setState(() {
      _draftCompositionHydrated = true;
      _reconcileSessionDraft(store);
      if (retained != null &&
          _retryDictationBytes == null &&
          !_recordingDictation &&
          !_transcribingDictation) {
        _retryDictationBytes = retained.bytes;
        _retryDictationSourceId = retained.sourceId;
        _retryDictationSessionId = widget.sessionId;
        _retryDictationDirectAudio = retained.directAudio;
        _retryDictationSubmitAfterFinish = false;
      }
    });
  }

  bool _meshDraftHasTargets(RemoteAppStore store) => _meshDraftReconciled
      ? _meshTargets.isNotEmpty
      : store.draftDelegationSelectionsFor(widget.sessionId).isNotEmpty;

  List<DelegationSelection> _normalizedMeshTargets(
    RemoteAppStore store,
    Iterable<DelegationSelection> selections,
  ) {
    final parent = _routeSession(store);
    if (parent == null) return const <DelegationSelection>[];
    final usableProviders = <String, ProviderConnection>{
      for (final provider
          in store.providers.where(store.isProviderUsableForTasks))
        provider.providerId: provider,
    };
    final seenProviders = <String>{};
    final normalized = <DelegationSelection>[];
    for (final selection in selections) {
      final provider = usableProviders[selection.providerId.trim()];
      if (provider == null || !seenProviders.add(provider.providerId)) {
        continue;
      }

      var modelId = selection.modelId?.trim();
      if (modelId?.isEmpty == true) modelId = null;
      var reasoningEffort = _concreteReasoningEffort(
        selection.reasoningEffort,
      );
      if (!_supportsTurnModelSelection(provider.providerId)) {
        modelId = null;
        reasoningEffort = null;
      } else if (store.modelsByProvider.containsKey(provider.providerId)) {
        final models = store.modelsByProvider[provider.providerId] ??
            const <RemoteModel>[];
        final model = modelId == null
            ? null
            : models.where((candidate) => candidate.id == modelId).firstOrNull;
        if (model == null) {
          modelId = null;
          reasoningEffort = null;
        } else if (reasoningEffort != null) {
          final efforts = model.reasoningEfforts;
          final selectedEffort = efforts
              .where((option) =>
                  option.id.toLowerCase() == reasoningEffort!.toLowerCase())
              .firstOrNull;
          if (selectedEffort != null) {
            reasoningEffort = selectedEffort.id;
          } else {
            final fallback = _defaultConcreteReasoningEffort(model);
            reasoningEffort = fallback != null &&
                    efforts.any((option) => option.id == fallback)
                ? fallback
                : null;
          }
        }
      } else if (modelId == null) {
        reasoningEffort = null;
      }
      normalized.add(DelegationSelection(
        providerId: provider.providerId,
        modelId: modelId,
        reasoningEffort: reasoningEffort,
      ));
      if (normalized.length == 4) break;
    }
    return normalized;
  }

  void _setComposerValue(TextEditingValue value) {
    _composer.value = value;
    _lastComposerText = value.text;
  }

  String _reconcileMeshTextEdit(RemoteAppStore store) {
    final previousText = _lastComposerText;
    var currentValue = _composer.value;
    final previousCount = _meshPlaceholderCount(previousText);
    var currentCount = _meshPlaceholderCount(currentValue.text);

    if (currentCount > previousCount) {
      var prefix = 0;
      final prefixLimit =
          math.min(previousText.length, currentValue.text.length);
      while (prefix < prefixLimit &&
          previousText[prefix] == currentValue.text[prefix]) {
        prefix += 1;
      }
      var previousTail = previousText.length;
      var currentTail = currentValue.text.length;
      while (previousTail > prefix &&
          currentTail > prefix &&
          previousText[previousTail - 1] ==
              currentValue.text[currentTail - 1]) {
        previousTail -= 1;
        currentTail -= 1;
      }
      var extras = currentCount - previousCount;
      final removals = <int>[];
      for (var offset = currentTail - 1;
          offset >= prefix && extras > 0;
          offset -= 1) {
        if (currentValue.text[offset] != _meshDraftPlaceholder) continue;
        removals.add(offset);
        extras -= 1;
      }
      if (extras > 0) {
        final offsets = <int>[];
        for (var offset = 0; offset < currentValue.text.length; offset += 1) {
          if (currentValue.text[offset] == _meshDraftPlaceholder &&
              !removals.contains(offset)) {
            offsets.add(offset);
          }
        }
        while (extras > 0 && offsets.isNotEmpty) {
          removals.add(offsets.removeLast());
          extras -= 1;
        }
      }
      removals.sort((left, right) => right.compareTo(left));
      for (final offset in removals) {
        currentValue =
            _replaceComposerRange(currentValue, offset, offset + 1, '');
      }
      currentCount = _meshPlaceholderCount(currentValue.text);
      _setComposerValue(currentValue);
    }

    var targetsChanged = false;
    if (currentCount < previousCount && _meshTargets.isNotEmpty) {
      var prefix = 0;
      final prefixLimit =
          math.min(previousText.length, currentValue.text.length);
      while (prefix < prefixLimit &&
          previousText[prefix] == currentValue.text[prefix]) {
        prefix += 1;
      }
      final firstRemovedTarget = _meshPlaceholderCount(previousText, 0, prefix)
          .clamp(0, _meshTargets.length);
      var removeCount = math.min(
        previousCount - currentCount,
        _meshTargets.length - firstRemovedTarget,
      );
      setState(() {
        while (removeCount > 0 && firstRemovedTarget < _meshTargets.length) {
          _meshTargets.removeAt(firstRemovedTarget);
          removeCount -= 1;
          targetsChanged = true;
        }
        while (_meshTargets.length > currentCount) {
          _meshTargets.removeLast();
          targetsChanged = true;
        }
      });
    }

    _lastComposerText = currentValue.text;
    if (targetsChanged) {
      _composer.refreshInlineSpans();
      _persistMeshTargets(store);
    }
    return currentValue.text;
  }

  _MeshCompositionState _repairMeshComposition(
    TextEditingValue value,
    List<DelegationSelection> stored,
    List<DelegationSelection> normalized,
  ) {
    final normalizedByProvider = <String, DelegationSelection>{
      for (final target in normalized) target.providerId.toLowerCase(): target,
    };
    final retainedProviders = <String>{};
    final retainedTargets = <DelegationSelection>[];
    final markerRemovals = <int>[];
    var storedIndex = 0;
    for (var offset = 0; offset < value.text.length; offset += 1) {
      if (value.text[offset] != _meshDraftPlaceholder) continue;
      final storedTarget =
          storedIndex < stored.length ? stored[storedIndex] : null;
      storedIndex += 1;
      final key = storedTarget?.providerId.toLowerCase();
      final replacement = key == null ? null : normalizedByProvider[key];
      if (replacement == null || !retainedProviders.add(key!)) {
        markerRemovals.add(offset);
      } else {
        retainedTargets.add(replacement);
      }
    }

    var repairedValue = value;
    for (final offset in markerRemovals.reversed) {
      repairedValue =
          _replaceComposerRange(repairedValue, offset, offset + 1, '');
    }
    final missingTargets = normalized
        .where((target) =>
            !retainedProviders.contains(target.providerId.toLowerCase()))
        .toList(growable: false);
    if (missingTargets.isNotEmpty) {
      final lastRetainedOffset = retainedTargets.isEmpty
          ? null
          : _meshPlaceholderOffset(
              repairedValue.text,
              retainedTargets.length - 1,
            );
      final insertionOffset =
          lastRetainedOffset == null ? 0 : lastRetainedOffset + 1;
      repairedValue = _replaceComposerRange(
        repairedValue,
        insertionOffset,
        insertionOffset,
        _meshDraftPlaceholder * missingTargets.length,
      );
    }
    return _MeshCompositionState(
      value: repairedValue,
      targets: <DelegationSelection>[...retainedTargets, ...missingTargets],
    );
  }

  void _reconcileMeshTargets(RemoteAppStore store) {
    if (store.providers.isEmpty || _routeSession(store) == null) return;
    final stored = store.draftDelegationSelectionsFor(widget.sessionId);
    final normalized = _normalizedMeshTargets(store, stored);
    final storedText = store.drafts[widget.sessionId] ?? '';
    final startingValue = _composer.text == storedText
        ? _composer.value
        : TextEditingValue(
            text: storedText,
            selection: TextSelection.collapsed(offset: storedText.length),
          );
    final repaired = _repairMeshComposition(startingValue, stored, normalized);
    _meshDraftReconciled = true;
    final targetsChanged =
        !_sameDelegationSelections(_meshTargets, repaired.targets);
    if (targetsChanged) {
      _meshTargets
        ..clear()
        ..addAll(repaired.targets);
    }
    if (_composer.value != repaired.value) {
      _setComposerValue(repaired.value);
    } else {
      _lastComposerText = repaired.value.text;
      if (targetsChanged) _composer.refreshInlineSpans();
    }
    if (storedText != repaired.value.text ||
        !_sameDelegationSelections(stored, repaired.targets)) {
      final expected = List<DelegationSelection>.unmodifiable(stored);
      final replacement =
          List<DelegationSelection>.unmodifiable(repaired.targets);
      final expectedText = storedText;
      final replacementText = repaired.value.text;
      final hostId = _routeHostId;
      final sessionId = widget.sessionId;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_routeOperationOriginIsCurrent(
              store,
              hostId: hostId,
              sessionId: sessionId,
            ) ||
            !_sameDelegationSelections(
              store.draftDelegationSelectionsFor(sessionId),
              expected,
            ) ||
            (store.drafts[sessionId] ?? '') != expectedText) {
          return;
        }
        store.setDraft(sessionId, replacementText);
        store.setDraftDelegationSelections(sessionId, replacement);
      });
    }
    _scheduleMeshModelCatalogReconciliation(store);
  }

  void _scheduleMeshModelCatalogReconciliation(RemoteAppStore store) {
    final providerIds = _meshTargets
        .map((target) => target.providerId)
        .where((providerId) =>
            _supportsTurnModelSelection(providerId) &&
            !store.modelsByProvider.containsKey(providerId) &&
            _meshModelCatalogRequests.add(providerId))
        .toList(growable: false);
    if (providerIds.isEmpty) return;
    final hostId = _routeHostId;
    final sessionId = widget.sessionId;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      for (final providerId in providerIds) {
        unawaited(() async {
          try {
            await store.loadModels(providerId, surfaceErrors: false);
          } on Object {
            return;
          }
          if (!_routeOperationOriginIsCurrent(
            store,
            hostId: hostId,
            sessionId: sessionId,
          )) {
            return;
          }
          setState(() => _reconcileMeshTargets(store));
        }());
      }
    });
  }

  void _reconcileSessionDraft(RemoteAppStore store) {
    if (_sending) return;
    final storedText = store.drafts[widget.sessionId] ?? '';
    final storedAttachments = store.draftAttachmentsFor(widget.sessionId);
    if (_composer.text != storedText) {
      _setComposerValue(TextEditingValue(
        text: storedText,
        selection: TextSelection.collapsed(offset: storedText.length),
      ));
    }
    if (!_sameDraftAttachments(_attachments, storedAttachments)) {
      _attachments
        ..clear()
        ..addAll(storedAttachments);
    }
    _reconcileMeshTargets(store);
    final reconciledText = _composer.text;
    _simplifySettings = _containsSimplifyCommand(reconciledText) &&
            _filteredSlashCommands(reconciledText) == null
        ? store.simplifySettingsFor(widget.sessionId)
        : null;
    _slashCommandPresentationSignature = _slashCommandSignature(reconciledText);
  }

  Future<void> _refreshVisionStatus(RemoteAppStore store, String sessionId,
      String? hostId, int generation) async {
    bool isCurrent() =>
        mounted &&
        widget.sessionId == sessionId &&
        store.activeHost?.hostId == hostId &&
        _visionStatusGeneration == generation;

    if (!isCurrent()) return;
    if (!store.canSyncVisionStatus) {
      _stopVisionStatusSync();
      return;
    }
    try {
      final status = await store.loadVisionProxy(sessionId);
      if (!isCurrent()) return;
      if (!store.canSyncVisionStatus) {
        _stopVisionStatusSync();
        return;
      }
      _cancelVisionStatusRetry();
      setState(() {
        _visionProxySelection = status.configured;
        _visionStatusLoadingFor = null;
        _visionStatusLoadingHostId = null;
      });
    } on Object {
      if (!isCurrent()) return;
      if (!store.canSyncVisionStatus) {
        _stopVisionStatusSync();
        return;
      }
      _scheduleVisionStatusRetry(
        store,
        sessionId,
        hostId,
        generation,
        store.visionStatusRetryDelay(sessionId),
      );
    }
  }

  void _scheduleVisionStatusRetry(
    RemoteAppStore store,
    String sessionId,
    String? hostId,
    int generation,
    Duration delay,
  ) {
    if (!store.canSyncVisionStatus) {
      _stopVisionStatusSync();
      return;
    }
    _cancelVisionStatusRetry();
    _visionStatusRetryTimer = Timer(delay, () {
      _visionStatusRetryTimer = null;
      if (!mounted ||
          widget.sessionId != sessionId ||
          store.activeHost?.hostId != hostId ||
          _visionStatusGeneration != generation ||
          _visionStatusLoadingFor != sessionId ||
          _visionStatusLoadingHostId != hostId) {
        return;
      }
      if (!store.canSyncVisionStatus) {
        _stopVisionStatusSync();
        return;
      }
      unawaited(_refreshVisionStatus(store, sessionId, hostId, generation));
    });
  }

  void _stopVisionStatusSync() {
    final owned =
        _visionStatusLoadingFor != null || _visionStatusRetryTimer != null;
    _cancelVisionStatusRetry();
    if (!owned) return;
    _visionStatusGeneration += 1;
    _visionStatusLoadingFor = null;
    _visionStatusLoadingHostId = null;
  }

  void _cancelVisionStatusRetry() {
    _visionStatusRetryTimer?.cancel();
    _visionStatusRetryTimer = null;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _childSessionPollTimer?.cancel();
    _dictationCommitGeneration += 1;
    _liveSessionPollTimer?.cancel();
    _cancelVisionStatusRetry();
    _dictationTimer?.cancel();
    _staleRouteDismissTimer?.cancel();
    unawaited(_dictationLevelSubscription?.cancel());
    unawaited(_dictationRecorder.dispose().catchError((Object _) {}));
    final store = _store;
    if (store != null && _routeOriginIsCurrent(store)) {
      store.clearVisibleSessionIf(widget.sessionId);
      if (!_sending) {
        store.setDraft(widget.sessionId, _composer.text);
        if (_draftCompositionHydrated) {
          store.setDraftAttachments(widget.sessionId, _attachments);
        }
        if (_meshDraftReconciled) {
          store.setDraftDelegationSelections(widget.sessionId, _meshTargets);
        }
        store.setDraftSimplifySettings(
          widget.sessionId,
          _containsSimplifyCommand(_composer.text) ? _simplifySettings : null,
        );
        if (_draftCompositionHydrated &&
            _composer.text.trim().isEmpty &&
            _attachments.isEmpty &&
            !_meshDraftHasTargets(store)) {
          final sessionId = widget.sessionId;
          scheduleMicrotask(() {
            if (store.isPreparedSession(sessionId)) {
              store.discardPreparedSession(sessionId);
            }
          });
        }
      }
    }
    _scrollController
      ..removeListener(_updateStickToBottom)
      ..dispose();
    _composer.dispose();
    _composerFocus.dispose();
    _preparedDirectory.dispose();
    _dictationLevel.dispose();
    _dictationElapsed.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.inactive) return;
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      _childSessionPollTimer?.cancel();
      _childSessionPollTimer = null;
      _liveSessionPollTimer?.cancel();
      _liveSessionPollTimer = null;
      if (_recordingDictation) {
        unawaited(_finishDictation());
      }
      return;
    }
    if (state != AppLifecycleState.resumed) return;
    final store = _store;
    if (!mounted || store == null || !_routeOriginIsCurrent(store)) return;
    final session = _routeSession(store);
    if (session != null) {
      _configureChildSessionMonitoring(store, session);
      _configureLiveSessionMonitoring(store, session);
    }
  }

  void _configureLiveSessionMonitoring(
      RemoteAppStore store, RemoteSession session) {
    final hostId = _routeHostId;
    final sessionId = session.id;
    final lifecycleState = WidgetsBinding.instance.lifecycleState;
    final visible = (lifecycleState == null ||
            lifecycleState == AppLifecycleState.resumed) &&
        ModalRoute.of(context)?.isCurrent != false;
    if (!visible ||
        session.state != 'working' ||
        !_routeOperationOriginIsCurrent(
          store,
          hostId: hostId,
          sessionId: sessionId,
        )) {
      _liveSessionPollTimer?.cancel();
      _liveSessionPollTimer = null;
      return;
    }
    _liveSessionPollTimer ??=
        Timer.periodic(const Duration(milliseconds: 900), (_) async {
      if (!mounted ||
          _liveSessionPollInFlight ||
          WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed ||
          ModalRoute.of(context)?.isCurrent == false ||
          !_routeOperationOriginIsCurrent(
            store,
            hostId: hostId,
            sessionId: sessionId,
          )) {
        if (mounted &&
            !_routeOperationOriginIsCurrent(
              store,
              hostId: hostId,
              sessionId: sessionId,
            )) {
          _liveSessionPollTimer?.cancel();
          _liveSessionPollTimer = null;
        }
        return;
      }
      final current = store.sessions
          .where((item) =>
              item.id == sessionId && (hostId == null || item.hostId == hostId))
          .firstOrNull;
      if (current?.state != 'working') {
        _liveSessionPollTimer?.cancel();
        _liveSessionPollTimer = null;
        return;
      }
      _liveSessionPollInFlight = true;
      try {
        if (!_routeOperationOriginIsCurrent(
          store,
          hostId: hostId,
          sessionId: sessionId,
        )) {
          return;
        }
        await store.refreshVisibleSessionHistory(sessionId);
      } finally {
        _liveSessionPollInFlight = false;
      }
    });
  }

  Future<void> _toggleDictation() async {
    if (_sending ||
        _attachmentPickerBusy ||
        _transcribingDictation ||
        _dictationOperationInFlight) {
      return;
    }
    if (!await _ensureSessionDraftHydrated(showError: true) || !mounted) {
      return;
    }
    if (_sending ||
        _attachmentPickerBusy ||
        _transcribingDictation ||
        _dictationOperationInFlight) {
      return;
    }
    if (_recordingDictation) {
      await _finishDictation();
      return;
    }
    if (_retryDictationBytes != null) {
      await _retryPendingDictation();
      return;
    }
    setState(() => _dictationOperationInFlight = true);
    try {
      final store = StoreScope.of(context);
      final harnessId = _dictationHarnessId(store);
      var sourceId = store.preferredDictationSourceIdForHarness(harnessId);
      if (sourceId != null &&
          sourceId != directAudioDictationSourceId &&
          !store.readyDictationSources.any((source) => source.id == sourceId)) {
        sourceId = null;
      }
      if (sourceId == null && _directAudioAvailable(store, harnessId)) {
        sourceId = directAudioDictationSourceId;
      }
      sourceId ??= store.dictationSourceForHarness(harnessId)?.id;
      if (sourceId == null ||
          (sourceId == directAudioDictationSourceId &&
              !_directAudioAvailable(store, harnessId))) {
        sourceId = await _showDictationSourcePicker(store, harnessId);
        if (sourceId == null) return;
      } else if (store.preferredDictationSourceIdForHarness(harnessId) ==
          null) {
        try {
          await store.setDictationSourceForHarness(harnessId, sourceId);
        } on Object catch (caught) {
          if (mounted) _showDictationError(caught);
          return;
        }
      }
      if (sourceId == directAudioDictationSourceId) {
        await _startDirectAudio();
        return;
      }
      final source = store.readyDictationSources
          .where((item) => item.id == sourceId)
          .firstOrNull;
      if (source == null) {
        if (mounted) {
          _showDictationError(StateError(
              'Choose a ready dictation service from the microphone menu.'));
        }
        return;
      }
      _activeDictationSourceId = source.id;
      _activeDictationMaximumDuration =
          dictationMaximumDurationForAudioBytes(source.maxAudioBytes);
      _directAudioDictation = false;
      try {
        final permitted =
            await _duringExternalSystemActivity(_dictationRecorder.start);
        if (!mounted) {
          if (permitted) await _dictationRecorder.cancel();
          return;
        }
        if (!permitted) {
          _activeDictationSourceId = null;
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Microphone permission is needed for dictation.'),
          ));
          return;
        }
        final lifecycleState = WidgetsBinding.instance.lifecycleState;
        if (lifecycleState == AppLifecycleState.hidden ||
            lifecycleState == AppLifecycleState.paused ||
            lifecycleState == AppLifecycleState.detached) {
          await _dictationRecorder.cancel();
          _activeDictationSourceId = null;
          return;
        }
        _dictationSessionId = widget.sessionId;
        _dictationStartedAt = DateTime.now();
        _dictationElapsed.value = Duration.zero;
        setState(() => _recordingDictation = true);
        _startDictationTimer();
      } on Object catch (caught) {
        _activeDictationSourceId = null;
        if (mounted) _showDictationError(caught);
      }
    } finally {
      if (mounted) {
        setState(() => _dictationOperationInFlight = false);
      } else {
        _dictationOperationInFlight = false;
      }
    }
  }

  bool _destinationAcceptsDirectAudio(RemoteAppStore store, String harnessId) {
    final session =
        store.sessions.where((item) => item.id == widget.sessionId).firstOrNull;
    final providerId = session?.providerId ?? harnessId;
    if (providerId != 'direct' && providerId != 'codex') return false;
    final model = session == null
        ? null
        : (store.modelsByProvider[providerId] ?? const <RemoteModel>[])
                .where((item) => item.id == _selectedModelId)
                .firstOrNull ??
            (store.modelsByProvider[providerId] ?? const <RemoteModel>[])
                .where((item) => item.id == session.modelId)
                .firstOrNull;
    return model?.supportsAudioInput == true;
  }

  bool _earsCanCarryAudio(RemoteAppStore store) {
    final settings = store.ears;
    if (!settings.enabled ||
        settings.providerId == null ||
        settings.modelId == null) {
      return false;
    }
    final models =
        store.modelsByProvider[settings.providerId] ?? const <RemoteModel>[];
    final model =
        models.where((item) => item.id == settings.modelId).firstOrNull;
    return model != null && routeAcceptsEarsAudio(model);
  }

  bool _directAudioAvailable(RemoteAppStore store, String harnessId) =>
      _destinationAcceptsDirectAudio(store, harnessId) ||
      _earsCanCarryAudio(store);

  Future<void> _startDirectAudio() async {
    _activeDictationSourceId = directAudioDictationSourceId;
    _activeDictationMaximumDuration =
        dictationMaximumDurationForAudioBytes(_maximumDictationAudioBytes);
    try {
      final permitted =
          await _duringExternalSystemActivity(_dictationRecorder.start);
      if (!mounted) {
        if (permitted) await _dictationRecorder.cancel();
        return;
      }
      if (!permitted) {
        _activeDictationSourceId = null;
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Microphone permission is needed for dictation.'),
        ));
        return;
      }
      final lifecycleState = WidgetsBinding.instance.lifecycleState;
      if (lifecycleState == AppLifecycleState.hidden ||
          lifecycleState == AppLifecycleState.paused ||
          lifecycleState == AppLifecycleState.detached) {
        await _dictationRecorder.cancel();
        _activeDictationSourceId = null;
        return;
      }
      _dictationSessionId = widget.sessionId;
      _directAudioDictation = true;
      _dictationLevelSubscription = _dictationRecorder.levelStream.listen(
        (level) {
          if (mounted) _dictationLevel.value = level;
        },
      );
      _dictationStartedAt = DateTime.now();
      _dictationElapsed.value = Duration.zero;
      setState(() => _recordingDictation = true);
      _startDictationTimer();
    } on Object catch (caught) {
      _activeDictationSourceId = null;
      if (mounted) _showDictationError(caught);
    }
  }

  void _startDictationTimer() {
    _dictationTimer?.cancel();
    _dictationTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted || !_recordingDictation || _dictationStartedAt == null) {
        return;
      }
      final elapsed = DateTime.now().difference(_dictationStartedAt!);
      if (dictationShouldAutoFinish(
        elapsed,
        maximumDuration: _activeDictationMaximumDuration,
      )) {
        unawaited(_finishDictation(submitAfterFinish: true));
      } else {
        _dictationElapsed.value = elapsed;
      }
    });
  }

  String _dictationHarnessId(RemoteAppStore store) =>
      store.sessions
          .where((item) => item.id == widget.sessionId)
          .firstOrNull
          ?.providerId ??
      store.selectedProviderId;

  String _dictationLogoProviderId(TranscriptionSource source) {
    final identity = '${source.id} ${source.label}'.toLowerCase();
    if (identity.contains('xai') || identity.contains('grok')) return 'grok';
    if (identity.contains('openai') || identity.contains('codex')) {
      return 'codex';
    }
    return 'all';
  }

  Future<String?> _showDictationSourcePicker(
      RemoteAppStore store, String harnessId) async {
    final directAudioAvailable = _directAudioAvailable(store, harnessId);
    final directToModel = _destinationAcceptsDirectAudio(store, harnessId);
    final preferredId = store.preferredDictationSourceIdForHarness(harnessId) ??
        (directAudioAvailable
            ? directAudioDictationSourceId
            : store.dictationSourceForHarness(harnessId)?.id);
    final harnessName = providerVisualThemeFor(harnessId).displayName;
    final hasReadySource = directAudioAvailable ||
        store.dictationSources.any(store.isDictationSourceReady);
    final sourceId = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(sheetContext).height * .78,
          ),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  'Dictation source',
                  style: Theme.of(sheetContext).textTheme.titleMedium,
                ),
                const SizedBox(height: 3),
                Text(
                  'Choose the service $harnessName uses for voice input.',
                  style: Theme.of(sheetContext).textTheme.bodySmall,
                ),
                const SizedBox(height: 12),
                if (!hasReadySource)
                  Container(
                    key: const Key('dictation-source-empty'),
                    width: double.infinity,
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: Theme.of(sheetContext)
                          .colorScheme
                          .surfaceContainerHighest
                          .withValues(alpha: 0.45),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(
                      store.dictationSources.isEmpty
                          ? 'No dictation source is enabled. No compatible source is available on this computer.'
                          : 'No dictation source is enabled. Set one up in Settings to start speaking here.',
                    ),
                  ),
                if (directAudioAvailable) ...<Widget>[
                  const SizedBox(height: 8),
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Material(
                      color: preferredId == directAudioDictationSourceId
                          ? Theme.of(sheetContext)
                              .colorScheme
                              .primary
                              .withValues(alpha: 0.1)
                          : Theme.of(sheetContext)
                              .colorScheme
                              .surfaceContainerHighest
                              .withValues(alpha: 0.35),
                      borderRadius: BorderRadius.circular(12),
                      child: InkWell(
                        key: const Key('dictation-source-option-direct-audio'),
                        borderRadius: BorderRadius.circular(12),
                        onTap: () => Navigator.pop(
                            sheetContext, directAudioDictationSourceId),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 12, vertical: 10),
                          child: Row(
                            children: <Widget>[
                              ClipOval(
                                child: Container(
                                  width: 38,
                                  height: 38,
                                  alignment: Alignment.center,
                                  color: Theme.of(sheetContext)
                                      .colorScheme
                                      .surface,
                                  child: Icon(
                                    Icons.graphic_eq_rounded,
                                    size: 22,
                                    color: Theme.of(sheetContext)
                                        .colorScheme
                                        .primary,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 11),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: <Widget>[
                                    Text(
                                      'WAV audio',
                                      style: Theme.of(sheetContext)
                                          .textTheme
                                          .bodyLarge
                                          ?.copyWith(
                                            fontWeight: FontWeight.w600,
                                          ),
                                    ),
                                    const SizedBox(height: 2),
                                    Text(
                                      directToModel
                                          ? 'The model hears your recording'
                                          : 'EARS turns your recording into text',
                                      style: Theme.of(sheetContext)
                                          .textTheme
                                          .bodySmall
                                          ?.copyWith(
                                            color: Theme.of(sheetContext)
                                                .colorScheme
                                                .onSurfaceVariant,
                                          ),
                                    ),
                                  ],
                                ),
                              ),
                              const SizedBox(width: 8),
                              Icon(
                                preferredId == directAudioDictationSourceId
                                    ? Icons.check_circle_rounded
                                    : Icons.circle_outlined,
                                size: 21,
                                color: preferredId ==
                                        directAudioDictationSourceId
                                    ? Theme.of(sheetContext).colorScheme.primary
                                    : Theme.of(sheetContext)
                                        .colorScheme
                                        .onSurfaceVariant,
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
                if (store.dictationSources.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 8),
                  ...store.dictationSources.map((source) {
                    final ready = store.isDictationSourceReady(source);
                    final selected = preferredId == source.id;
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Material(
                        color: selected
                            ? Theme.of(sheetContext)
                                .colorScheme
                                .primary
                                .withValues(alpha: 0.1)
                            : Theme.of(sheetContext)
                                .colorScheme
                                .surfaceContainerHighest
                                .withValues(alpha: 0.35),
                        borderRadius: BorderRadius.circular(12),
                        child: InkWell(
                          key: Key('dictation-source-option-${source.id}'),
                          borderRadius: BorderRadius.circular(12),
                          onTap: ready
                              ? () => Navigator.pop(sheetContext, source.id)
                              : null,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 12, vertical: 10),
                            child: Row(
                              children: <Widget>[
                                ClipOval(
                                  child: Container(
                                    width: 38,
                                    height: 38,
                                    alignment: Alignment.center,
                                    color: Theme.of(sheetContext)
                                        .colorScheme
                                        .surface,
                                    child: ProviderLogo(
                                      providerId:
                                          _dictationLogoProviderId(source),
                                      size: 24,
                                      semanticLabel: '${source.label} logo',
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 11),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: <Widget>[
                                      Text(
                                        source.label,
                                        style: Theme.of(sheetContext)
                                            .textTheme
                                            .bodyLarge
                                            ?.copyWith(
                                              fontWeight: FontWeight.w600,
                                              color: ready
                                                  ? null
                                                  : Theme.of(sheetContext)
                                                      .disabledColor,
                                            ),
                                      ),
                                      const SizedBox(height: 2),
                                      Text(
                                        ready
                                            ? 'Ready on Tethoq Bridge'
                                            : '${source.credentialLabel ?? 'API key'} required · set up in Settings',
                                        style: Theme.of(sheetContext)
                                            .textTheme
                                            .bodySmall
                                            ?.copyWith(
                                              color: ready
                                                  ? Theme.of(sheetContext)
                                                      .colorScheme
                                                      .onSurfaceVariant
                                                  : Theme.of(sheetContext)
                                                      .disabledColor,
                                            ),
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Icon(
                                  selected
                                      ? Icons.check_circle_rounded
                                      : ready
                                          ? Icons.circle_outlined
                                          : Icons.lock_outline_rounded,
                                  size: 21,
                                  color: selected
                                      ? Theme.of(sheetContext)
                                          .colorScheme
                                          .primary
                                      : ready
                                          ? Theme.of(sheetContext)
                                              .colorScheme
                                              .onSurfaceVariant
                                          : Theme.of(sheetContext)
                                              .disabledColor,
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    );
                  }),
                ],
              ],
            ),
          ),
        ),
      ),
    );
    if (!mounted || sourceId == null) return null;
    try {
      await store.setDictationSourceForHarness(harnessId, sourceId);
    } on Object catch (caught) {
      if (mounted) _showDictationError(caught);
      return null;
    }
    return sourceId;
  }

  Future<void> _openDictationSourcePicker() async {
    if (_sending ||
        _attachmentPickerBusy ||
        _dictationOperationInFlight ||
        _dictationSourcePickerOpen ||
        _recordingDictation ||
        _transcribingDictation ||
        _retryDictationBytes != null) {
      return;
    }
    _dictationSourcePickerOpen = true;
    try {
      final store = StoreScope.of(context);
      await _showDictationSourcePicker(store, _dictationHarnessId(store));
    } finally {
      _dictationSourcePickerOpen = false;
    }
  }

  Future<void> _finishDictation({bool submitAfterFinish = false}) {
    final active = _dictationCommitOperation;
    if (active != null) {
      if (submitAfterFinish) {
        _dictationSubmitRequested = true;
        _retryDictationSubmitAfterFinish = true;
      }
      return active;
    }
    if (!_recordingDictation ||
        _transcribingDictation ||
        _dictationOperationInFlight) {
      return Future<void>.value();
    }
    _dictationSubmitRequested = submitAfterFinish;
    late final Future<void> operation;
    operation = _finishDictationOnce(submitAfterFinish: submitAfterFinish)
        .whenComplete(() {
      if (identical(_dictationCommitOperation, operation)) {
        _dictationCommitOperation = null;
        _dictationOperationInFlight = false;
        if (mounted) setState(() {});
      }
    });
    _dictationCommitOperation = operation;
    return operation;
  }

  Future<void> _finishDictationOnce({required bool submitAfterFinish}) async {
    final generation = ++_dictationCommitGeneration;
    _retryDictationSubmitAfterFinish =
        _retryDictationSubmitAfterFinish || submitAfterFinish;
    _dictationOperationInFlight = true;
    _cancellingDictation = false;
    _clearProcessingDictation();
    _dictationTimer?.cancel();
    _dictationTimer = null;
    final directAudio = _directAudioDictation;
    final sourceId = _activeDictationSourceId;
    final sessionId = _dictationSessionId ?? widget.sessionId;
    final store = _store ?? StoreScope.read(context);
    _dictationLevel.value = 0;
    setState(() {
      _recordingDictation = false;
      _transcribingDictation = true;
    });
    await _dictationLevelSubscription?.cancel();
    _dictationLevelSubscription = null;
    Uint8List? waveBytes;
    _DictationCommitResult? committed;
    try {
      waveBytes = await _dictationRecorder.stop();
      await store.retainDictation(
        sessionId,
        waveBytes,
        sourceId: sourceId,
        directAudio: directAudio,
      );
      if (!mounted) return;
      setState(() {
        _processingDictationBytes = waveBytes;
        _processingDictationSourceId = sourceId;
        _processingDictationSessionId = sessionId;
        _processingDictationDirectAudio = directAudio;
      });
      if (generation != _dictationCommitGeneration) {
        _retainDictationForRetry(
          waveBytes,
          sessionId: sessionId,
          sourceId: sourceId,
          directAudio: directAudio,
          submitAfterFinish: _dictationSubmitRequested,
        );
        _activeDictationSourceId = null;
        _dictationSessionId = null;
        _directAudioDictation = false;
        _clearProcessingDictation();
        _dictationOperationInFlight = false;
        setState(() {
          _transcribingDictation = false;
          _directAudioDictation = false;
          _cancellingDictation = false;
        });
        return;
      }
      committed = await _commitDictationBytes(
        waveBytes,
        sessionId: sessionId,
        sourceId: sourceId,
        directAudio: directAudio,
        generation: generation,
        stageForSubmission: _dictationSubmitRequested,
      );
    } on Object catch (caught) {
      if (!mounted) return;
      final cancelledWhileFinalizing =
          _cancellingDictation && generation != _dictationCommitGeneration;
      if (generation != _dictationCommitGeneration &&
          !cancelledWhileFinalizing) {
        return;
      }
      if (waveBytes != null) {
        _retainDictationForRetry(
          waveBytes,
          sessionId: sessionId,
          sourceId: sourceId,
          directAudio: directAudio,
          submitAfterFinish: false,
        );
        _showRetainedDictationError(caught);
      } else {
        _showDictationError(cancelledWhileFinalizing
            ? StateError('Recording could not be saved. Try dictation again.')
            : caught);
      }
      if (cancelledWhileFinalizing) {
        _activeDictationSourceId = null;
        _dictationSessionId = null;
        _directAudioDictation = false;
        _dictationOperationInFlight = false;
        _dictationSubmitRequested = false;
        _retryDictationSubmitAfterFinish = false;
        _clearProcessingDictation();
        setState(() {
          _transcribingDictation = false;
          _cancellingDictation = false;
        });
      }
    } finally {
      if (generation == _dictationCommitGeneration) {
        _activeDictationSourceId = null;
        _dictationSessionId = null;
        _directAudioDictation = false;
        _dictationOperationInFlight = false;
        _clearProcessingDictation();
      }
      if (mounted && generation == _dictationCommitGeneration) {
        setState(() {
          _transcribingDictation = false;
          _directAudioDictation = false;
          _cancellingDictation = false;
        });
      }
    }
    final shouldSubmit = _dictationSubmitRequested;
    _dictationSubmitRequested = false;
    if (committed == null || !mounted || sessionId != widget.sessionId) return;
    if (shouldSubmit) {
      final outcome = await _submitComposer(
        dictation: committed.applied ? null : committed,
      );
      if (outcome == _ComposerSubmissionOutcome.rejected &&
          mounted &&
          !committed.applied) {
        await _restoreRejectedCommittedDictation(committed);
      }
    }
  }

  Future<_DictationCommitResult?> _commitDictationBytes(
    Uint8List waveBytes, {
    required String sessionId,
    required String? sourceId,
    required bool directAudio,
    required int generation,
    required bool stageForSubmission,
  }) async {
    if (sessionId != widget.sessionId) {
      throw StateError('That recording belongs to a different task.');
    }
    final store = _store ?? StoreScope.read(context);
    final hostId = _routeHostId;
    bool commitIsCurrent() =>
        generation == _dictationCommitGeneration &&
        _routeOperationOriginIsCurrent(
          store,
          hostId: hostId,
          sessionId: sessionId,
        );
    if (!commitIsCurrent()) return null;
    RemoteAttachment? pendingAttachment;
    String? pendingTranscript;
    if (directAudio) {
      if (!_isValidPhoneAttachmentLength(waveBytes.length)) {
        throw StateError('Audio recordings must be between 1 byte and 25 MiB.');
      }
      final stamp = DateTime.now()
          .toIso8601String()
          .replaceAll(':', '-')
          .replaceAll(RegExp(r'\.\d+'), '');
      final dataBase64 = await compute(_encodeBase64, waveBytes);
      if (!commitIsCurrent()) return null;
      if (!messageAttachmentSlotAvailable(_attachments.length)) {
        throw StateError(_attachmentLimitMessage);
      }
      if (!messageAttachmentBytesAvailable(_attachments, waveBytes.length)) {
        throw StateError(_attachmentTotalLimitMessage);
      }
      pendingAttachment = RemoteAttachment(
        name: 'dictation-$stamp.wav',
        mimeType: 'audio/wav',
        origin: 'dictation',
        dataBase64: dataBase64,
        byteLength: waveBytes.length,
      );
    } else {
      final transcript = await store.transcribeDictation(
        waveBytes,
        sessionId: sessionId,
        sourceId: sourceId,
      );
      if (!commitIsCurrent()) return null;
      if (transcript.trim().isEmpty) {
        throw StateError('No speech was heard in that recording.');
      }
      pendingTranscript = transcript;
    }
    final committed = _DictationCommitResult(
      applied: !stageForSubmission,
      transcript: pendingTranscript,
      attachment: pendingAttachment,
    );
    _clearRetainedDictation();
    if (!stageForSubmission) {
      _applyCommittedDictation(committed);
      try {
        await store.clearRetainedDictation(sessionId);
      } on Object {
        if (mounted && commitIsCurrent()) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text(
                'Recording added. Saved recovery cleanup will retry safely.'),
          ));
        }
      }
    }
    return committed;
  }

  Future<void> _restoreRejectedCommittedDictation(
      _DictationCommitResult committed) async {
    final store = _store ?? StoreScope.read(context);
    if (!mounted || !_routeOriginIsCurrent(store)) return;
    _applyCommittedDictation(committed);
    try {
      await store.flushDraftJournal();
      if (mounted && _routeOriginIsCurrent(store)) {
        await store.clearRetainedDictation(widget.sessionId);
      }
    } on Object {
      if (mounted && _routeOriginIsCurrent(store)) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text(
              'Recording restored. Saved recovery cleanup will retry safely.'),
        ));
      }
    }
  }

  void _applyCommittedDictation(_DictationCommitResult committed) {
    final attachment = committed.attachment;
    if (attachment != null) {
      final attached = _setPendingAttachment(attachment);
      if (!attached) throw StateError(_attachmentLimitMessage);
      return;
    }
    _insertTranscript(committed.transcript!);
  }

  void _retainDictationForRetry(
    Uint8List waveBytes, {
    required String sessionId,
    required String? sourceId,
    required bool directAudio,
    required bool submitAfterFinish,
  }) {
    setState(() {
      _retryDictationBytes = waveBytes;
      _retryDictationSourceId = sourceId;
      _retryDictationSessionId = sessionId;
      _retryDictationDirectAudio = directAudio;
      _retryDictationSubmitAfterFinish = submitAfterFinish;
    });
  }

  void _clearRetainedDictation() {
    _retryDictationBytes = null;
    _retryDictationSourceId = null;
    _retryDictationSessionId = null;
    _retryDictationDirectAudio = false;
    _retryDictationSubmitAfterFinish = false;
  }

  void _discardRetainedDictation() {
    if (_retryDictationBytes == null || _transcribingDictation) return;
    ScaffoldMessenger.of(context).hideCurrentSnackBar();
    setState(_clearRetainedDictation);
    unawaited(StoreScope.read(context)
        .clearRetainedDictation(widget.sessionId)
        .catchError((_) {}));
  }

  void _clearProcessingDictation() {
    _processingDictationBytes = null;
    _processingDictationSourceId = null;
    _processingDictationSessionId = null;
    _processingDictationDirectAudio = false;
  }

  void _cancelDictationProcessing() {
    if (!_transcribingDictation || _cancellingDictation) return;
    _dictationCommitGeneration += 1;
    final waveBytes = _processingDictationBytes;
    if (waveBytes == null) {
      setState(() => _cancellingDictation = true);
      return;
    }
    _retainDictationForRetry(
      waveBytes,
      sessionId: _processingDictationSessionId ?? widget.sessionId,
      sourceId: _processingDictationSourceId,
      directAudio: _processingDictationDirectAudio,
      submitAfterFinish: _retryDictationSubmitAfterFinish,
    );
    _activeDictationSourceId = null;
    _dictationSessionId = null;
    _directAudioDictation = false;
    _clearProcessingDictation();
    setState(() {
      _transcribingDictation = false;
      _cancellingDictation = false;
    });
  }

  Future<void> _retryPendingDictation({bool? submitAfterFinish}) {
    final active = _dictationCommitOperation;
    if (active != null) return active;
    if (_retryDictationBytes == null || _transcribingDictation) {
      return Future<void>.value();
    }
    late final Future<void> operation;
    operation = _retryPendingDictationOnce(
      submitAfterFinish: submitAfterFinish,
    ).whenComplete(() {
      if (identical(_dictationCommitOperation, operation)) {
        _dictationCommitOperation = null;
      }
    });
    _dictationCommitOperation = operation;
    return operation;
  }

  Future<void> _retryPendingDictationOnce({bool? submitAfterFinish}) async {
    final waveBytes = _retryDictationBytes;
    if (waveBytes == null) return;
    final generation = ++_dictationCommitGeneration;
    final sourceId = _retryDictationSourceId;
    final sessionId = _retryDictationSessionId ?? widget.sessionId;
    final directAudio = _retryDictationDirectAudio;
    // A retry from the microphone/Retry control only restores the composition.
    // Submission remains tied to an explicit tap on Send.
    final shouldSubmit = submitAfterFinish ?? false;
    _retryDictationSubmitAfterFinish = shouldSubmit;
    _processingDictationBytes = waveBytes;
    _processingDictationSourceId = sourceId;
    _processingDictationSessionId = sessionId;
    _processingDictationDirectAudio = directAudio;
    _dictationOperationInFlight = true;
    _cancellingDictation = false;
    setState(() => _transcribingDictation = true);
    _DictationCommitResult? committed;
    try {
      committed = await _commitDictationBytes(
        waveBytes,
        sessionId: sessionId,
        sourceId: sourceId,
        directAudio: directAudio,
        generation: generation,
        stageForSubmission: shouldSubmit,
      );
    } on Object catch (caught) {
      if (mounted && generation == _dictationCommitGeneration) {
        _showRetainedDictationError(caught);
      }
    } finally {
      if (generation == _dictationCommitGeneration) {
        _dictationOperationInFlight = false;
        _clearProcessingDictation();
      }
      if (mounted && generation == _dictationCommitGeneration) {
        setState(() {
          _transcribingDictation = false;
          _cancellingDictation = false;
        });
      }
    }
    if (committed == null || !mounted || sessionId != widget.sessionId) return;
    if (shouldSubmit) {
      final outcome = await _submitComposer(
        dictation: committed.applied ? null : committed,
      );
      if (outcome == _ComposerSubmissionOutcome.rejected &&
          mounted &&
          !committed.applied) {
        await _restoreRejectedCommittedDictation(committed);
      }
    }
  }

  void _insertTranscript(String transcript) {
    final inserted = _composerValueWithTranscript(transcript);
    _composer.value = inserted;
    _onComposerChanged(StoreScope.of(context), inserted.text);
  }

  TextEditingValue _composerValueWithTranscript(String transcript) {
    final current = _composer.value;
    final selection = current.selection.isValid
        ? current.selection
        : TextSelection.collapsed(offset: current.text.length);
    final start = selection.start.clamp(0, current.text.length);
    final end = selection.end.clamp(0, current.text.length);
    final before = current.text.substring(0, start);
    final after = current.text.substring(end);
    final leadingSpace = before.isNotEmpty &&
            !RegExp(r'\s$').hasMatch(before) &&
            !RegExp(r'^\s').hasMatch(transcript)
        ? ' '
        : '';
    final trailingSpace = after.isNotEmpty &&
            !RegExp(r'^\s').hasMatch(after) &&
            !RegExp(r'\s$').hasMatch(transcript)
        ? ' '
        : '';
    final insertedText = '$leadingSpace$transcript$trailingSpace';
    final text = '$before$insertedText$after';
    return TextEditingValue(
      text: text,
      selection:
          TextSelection.collapsed(offset: before.length + insertedText.length),
    );
  }

  void _showDictationError(Object caught) {
    final message = compactErrorDetail(caught);
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  void _showRetainedDictationError(Object caught) {
    final detail = compactErrorDetail(caught);
    final prefix = detail.startsWith('Not connected')
        ? 'Not connected. '
        : detail == _attachmentLimitMessage
            ? 'Remove an attachment first. '
            : 'Transcription didn\'t finish. ';
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text('${prefix}Your recording is kept.'),
      action: SnackBarAction(
        label: 'Retry',
        onPressed: () => unawaited(_retryPendingDictation()),
      ),
    ));
  }

  String _composerHint(RemoteAppStore store, Duration currentDictationElapsed) {
    if (_cancellingDictation ||
        (_transcribingDictation && _processingDictationBytes == null)) {
      return 'Stopping…';
    }
    if (_transcribingDictation) {
      return _directAudioDictation ? 'Preparing recording…' : 'Transcribing…';
    }
    if (_retryDictationBytes != null) return 'Recording kept—tap Retry';
    if (!_recordingDictation) {
      return store.isPreparedSession(widget.sessionId)
          ? 'Describe a task…'
          : 'Continue this task…';
    }
    final elapsed = dictationElapsedLabel(currentDictationElapsed);
    final approachingLimit = _activeDictationMaximumDuration -
                currentDictationElapsed <=
            const Duration(minutes: 1)
        ? ' · stops at ${dictationElapsedLabel(_activeDictationMaximumDuration)}'
        : '';
    return _directAudioDictation
        ? 'Recording… $elapsed$approachingLimit'
        : 'Listening… $elapsed$approachingLimit';
  }

  String? _dictationStatusText() {
    if (_recordingDictation && !_directAudioDictation) {
      return 'Listening…';
    }
    if (_cancellingDictation ||
        (_transcribingDictation && _processingDictationBytes == null)) {
      return 'Stopping…';
    }
    if (_transcribingDictation) {
      return _directAudioDictation
          ? 'Preparing recording… Your recording is safe.'
          : 'Transcribing… Your recording is safe.';
    }
    if (_retryDictationBytes != null) {
      return 'Recording kept. Tap Retry—no need to speak again.';
    }
    return null;
  }

  String _submissionDeliveryMode(RemoteAppStore store) {
    final session =
        store.sessions.where((item) => item.id == widget.sessionId).firstOrNull;
    final steeringAvailable = session?.state == 'working' &&
        store.providerSupportsSteering(session!.providerId);
    if (!store.isQueueingEnabledFor(widget.sessionId)) {
      return steeringAvailable ? 'steer' : 'send';
    }
    return _deliveryMode == 'steer' && steeringAvailable ? 'steer' : 'queue';
  }

  Future<_ComposerSubmissionOutcome> _submitComposer({
    String? deliveryMode,
    _DictationCommitResult? dictation,
  }) async {
    if (_preparingSubmission ||
        _sending ||
        _attachmentPickerBusy ||
        _attachmentMenuOpen ||
        _dictationOperationInFlight ||
        _dictationSourcePickerOpen ||
        _hasActiveTextComposition(_composer.value) ||
        !mounted) {
      return _ComposerSubmissionOutcome.rejected;
    }
    setState(() => _preparingSubmission = true);
    if (!await _ensureSessionDraftHydrated(showError: true) || !mounted) {
      if (mounted) setState(() => _preparingSubmission = false);
      return _ComposerSubmissionOutcome.rejected;
    }
    if (_sending ||
        _attachmentPickerBusy ||
        _attachmentMenuOpen ||
        _dictationOperationInFlight ||
        _dictationSourcePickerOpen ||
        _hasActiveTextComposition(_composer.value)) {
      setState(() => _preparingSubmission = false);
      return _ComposerSubmissionOutcome.rejected;
    }
    final store = _store ?? StoreScope.read(context);
    final submittedHostId = _routeHostId;
    bool submissionOriginIsCurrent() =>
        mounted &&
        submittedHostId == _routeHostId &&
        store.activeHost?.hostId == submittedHostId &&
        _routeOriginIsCurrent(store);
    if (!submissionOriginIsCurrent()) {
      setState(() => _preparingSubmission = false);
      return _ComposerSubmissionOutcome.rejected;
    }
    final dictatedTranscript = dictation?.transcript;
    final submittedText = dictatedTranscript == null
        ? _composer.text
        : _composerValueWithTranscript(dictatedTranscript).text;
    final submittedVisibleText = _withoutMeshDraftPlaceholders(submittedText);
    final submittedAttachmentList = <RemoteAttachment>[
      ..._attachments,
      if (dictation?.attachment != null) dictation!.attachment!,
    ];
    if (submittedVisibleText.trim().isEmpty &&
        submittedAttachmentList.isEmpty) {
      setState(() => _preparingSubmission = false);
      return _ComposerSubmissionOutcome.rejected;
    }
    final resolvedDeliveryMode = deliveryMode ?? _submissionDeliveryMode(store);
    final submittedAttachments =
        List<RemoteAttachment>.unmodifiable(submittedAttachmentList);
    final submittedMeshTargets =
        List<DelegationSelection>.unmodifiable(_meshTargets);
    final submittedSimplify = _containsSimplifyCommand(submittedVisibleText)
        ? _simplifySettings
        : null;
    final submittedModelId = _selectedModelId;
    final submittedReasoningEffort = _selectedReasoningEffort;
    if (submittedMeshTargets.isNotEmpty && submittedAttachments.isNotEmpty) {
      _showDictationError(StateError(
          '/mesh attachments are not available yet. Send the attachment in a child session after it opens.'));
      setState(() => _preparingSubmission = false);
      return _ComposerSubmissionOutcome.rejected;
    }
    if (_scrollController.hasClients) {
      _stickToBottom = _isAtPhysicalBottom(_scrollController.position);
    }
    // Creation retires the local draft before the first delivery finishes.
    // Retain this route's origin through that handoff, including the outgoing
    // route animation. Host changes still invalidate it normally.
    _preparedSubmissionOrigin = store.isPreparedSession(widget.sessionId)
        ? _routeSession(store)
        : null;
    _setComposerValue(TextEditingValue.empty);
    setState(() {
      _preparingSubmission = false;
      _sending = true;
      _attachments.clear();
      _meshTargets.clear();
      _imageModelNoticeId = null;
      _simplifySettings = null;
      _slashCommandPaletteDismissed = false;
      _slashCommandSelection = 0;
    });
    // The store clears this snapshot only after the bridge accepts it. Any
    // text entered while the request is pending receives a newer revision.
    var outcome = _ComposerSubmissionOutcome.accepted;
    String? createdSessionIdForNavigation;
    var replacingPreparedRoute = false;
    try {
      if (submittedMeshTargets.isNotEmpty) {
        await store.startDelegation(
          widget.sessionId,
          submittedText,
          submittedMeshTargets,
          modelId: submittedModelId,
          reasoningEffort: submittedReasoningEffort,
        );
      } else {
        createdSessionIdForNavigation = await store.submitMessage(
          widget.sessionId,
          submittedVisibleText,
          deliveryMode: resolvedDeliveryMode,
          modelId: submittedModelId,
          reasoningEffort: submittedReasoningEffort,
          attachments: submittedAttachments,
          simplify: submittedSimplify,
        );
      }
      if (dictation != null && submissionOriginIsCurrent()) {
        try {
          await store.clearRetainedDictation(widget.sessionId);
        } on Object {
          if (mounted && submissionOriginIsCurrent()) {
            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text(
                  'Message sent. Saved recording cleanup will finish safely.'),
            ));
          }
        }
      }
      if (mounted &&
          createdSessionIdForNavigation != null &&
          store.sessions.any((session) =>
              session.id == createdSessionIdForNavigation &&
              (submittedHostId == null || session.hostId == submittedHostId)) &&
          submissionOriginIsCurrent()) {
        replacingPreparedRoute = true;
        unawaited(Navigator.of(context).pushReplacement(
            sessionScreenRoute(createdSessionIdForNavigation)));
      }
    } on Object catch (caught) {
      if (submissionOriginIsCurrent()) {
        _restoreFailedComposerSubmission(
          store,
          submittedText: submittedText,
          submittedAttachments: submittedAttachments,
          submittedMeshTargets: submittedMeshTargets,
          submittedSimplify: submittedSimplify,
        );
        try {
          await store.flushDraftJournal();
          if (dictation != null && submissionOriginIsCurrent()) {
            await store.clearRetainedDictation(widget.sessionId);
          }
        } on Object {
          if (mounted && submissionOriginIsCurrent()) {
            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text(
                  'Message restored. Its saved recovery will retry safely.'),
            ));
          }
        }
        _showDictationError(caught);
        outcome = _ComposerSubmissionOutcome.restored;
      } else {
        outcome = _ComposerSubmissionOutcome.originLost;
      }
    } finally {
      if (!replacingPreparedRoute) _preparedSubmissionOrigin = null;
      if (mounted) setState(() => _sending = false);
    }
    return outcome;
  }

  void _restoreFailedComposerSubmission(
    RemoteAppStore store, {
    required String submittedText,
    required List<RemoteAttachment> submittedAttachments,
    required List<DelegationSelection> submittedMeshTargets,
    required SimplifySettings? submittedSimplify,
  }) {
    final restoredText = _mergeFailedDraftText(submittedText, _composer.text);
    final restoredAttachments =
        _mergeFailedAttachments(submittedAttachments, _attachments);
    final restoredTargets = _normalizedMeshTargets(
      store,
      <DelegationSelection>[
        ...store.draftDelegationSelectionsFor(widget.sessionId),
        ..._meshTargets,
        ...submittedMeshTargets,
      ],
    );
    _setComposerValue(TextEditingValue(
      text: restoredText,
      selection: TextSelection.collapsed(offset: restoredText.length),
    ));
    setState(() {
      _attachments
        ..clear()
        ..addAll(restoredAttachments);
      _meshTargets
        ..clear()
        ..addAll(restoredTargets);
      if (_containsSimplifyCommand(restoredText)) {
        _simplifySettings ??= submittedSimplify;
      }
    });
    _composer.refreshInlineSpans();
    store.setDraft(widget.sessionId, restoredText);
    store.setDraftAttachments(widget.sessionId, restoredAttachments);
    _meshDraftReconciled = true;
    store.setDraftDelegationSelections(widget.sessionId, restoredTargets);
    store.setDraftSimplifySettings(widget.sessionId, _simplifySettings);
  }

  void _onComposerChanged(RemoteAppStore store, String value) {
    if (_suppressNextSlashCommandEnterNewline) {
      _suppressNextSlashCommandEnterNewline = false;
      final repaired = _withoutSingleInsertedNewline(
        _lastComposerText,
        _composer.value,
      );
      if (repaired != null) {
        _setComposerValue(repaired);
        value = repaired.text;
      }
    }
    final reconciledValue = _reconcileMeshTextEdit(store);
    final derivedValue = value == _composer.text ? reconciledValue : value;
    store.setDraft(widget.sessionId, reconciledValue);
    final simplifyActive = _containsSimplifyCommand(derivedValue) &&
        _filteredSlashCommands(derivedValue) == null;
    final nextSimplifySettings = simplifyActive
        ? _simplifySettings ??
            store.simplifySettingsFor(widget.sessionId) ??
            SimplifySettings()
        : null;
    store.setDraftSimplifySettings(widget.sessionId, nextSimplifySettings);
    final nextSlashSignature = _slashCommandSignature(derivedValue);
    final overlayChanged =
        nextSlashSignature != _slashCommandPresentationSignature ||
            (nextSlashSignature != null &&
                (_slashCommandPaletteDismissed || _slashCommandSelection != 0));
    final simplifyPresentationChanged =
        (_simplifySettings == null) != (nextSimplifySettings == null);
    void updateDerivedState() {
      _slashCommandPaletteDismissed = false;
      _slashCommandSelection = 0;
      _slashCommandPresentationSignature = nextSlashSignature;
      _simplifySettings = nextSimplifySettings;
    }

    if (overlayChanged || simplifyPresentationChanged) {
      setState(updateDerivedState);
    } else {
      updateDerivedState();
    }
    final composing = _composer.value.composing;
    if (_sending || (composing.isValid && !composing.isCollapsed)) return;
    if (_meshCommandTokenForValue(
          _composer.value,
          requireTrailingWhitespace: true,
        ) !=
        null) {
      unawaited(_activateMesh());
    }
    if (RegExp(r'^/ears\s*$', caseSensitive: false).hasMatch(derivedValue)) {
      _setComposerValue(TextEditingValue.empty);
      store.setDraft(widget.sessionId, '');
      unawaited(_openEarsSettings());
    } else if (RegExp(r'^/goal\s*$', caseSensitive: false)
        .hasMatch(derivedValue)) {
      _setComposerValue(TextEditingValue.empty);
      store.setDraft(widget.sessionId, '');
      final session = store.sessions
          .where((item) => item.id == widget.sessionId)
          .firstOrNull;
      if (session != null && !store.isPreparedSession(session.id)) {
        unawaited(_showGoalControls(
            store, session, providerVisualThemeFor(session.providerId)));
      }
    } else if (RegExp(r'^/eyes\s*$', caseSensitive: false)
        .hasMatch(derivedValue)) {
      _setComposerValue(TextEditingValue.empty);
      store.setDraft(widget.sessionId, '');
      unawaited(_chooseVisionProxy());
    }
  }

  List<_SlashCommandDefinition>? get _slashCommandSuggestions =>
      _filteredSlashCommands(_composer.text);

  bool get _slashCommandPaletteVisible =>
      !_sending &&
      !(_composer.value.composing.isValid &&
          !_composer.value.composing.isCollapsed) &&
      !_slashCommandPaletteDismissed &&
      _slashCommandSuggestions != null;

  String? _slashCommandSignature(String value) {
    final suggestions = _filteredSlashCommands(value);
    return suggestions?.map((item) => item.id).join('|');
  }

  void _activateSlashCommand(_SlashCommandDefinition command) {
    if (command.id == 'mesh') {
      unawaited(_activateMesh());
      return;
    }
    if (command.id == 'ears') {
      _setComposerValue(TextEditingValue.empty);
      _onComposerChanged(StoreScope.of(context), '');
      unawaited(_openEarsSettings());
      return;
    }
    if (command.id == 'goal') {
      _setComposerValue(TextEditingValue.empty);
      _onComposerChanged(StoreScope.of(context), '/goal');
      return;
    }
    if (command.id == 'eyes') {
      _setComposerValue(TextEditingValue.empty);
      _onComposerChanged(StoreScope.of(context), '/eyes');
      return;
    }
    _activateSimplify();
  }

  KeyEventResult _handleComposerKey(FocusNode _, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final enterPressed = event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter;
    final shiftPressed = HardwareKeyboard.instance.isShiftPressed;
    if (_slashCommandPaletteVisible) {
      final suggestions = _slashCommandSuggestions ?? const [];
      if (event.logicalKey == LogicalKeyboardKey.escape) {
        setState(() => _slashCommandPaletteDismissed = true);
        return KeyEventResult.handled;
      }
      if (event.logicalKey == LogicalKeyboardKey.arrowDown ||
          event.logicalKey == LogicalKeyboardKey.arrowUp) {
        if (suggestions.isNotEmpty) {
          final direction =
              event.logicalKey == LogicalKeyboardKey.arrowDown ? 1 : -1;
          setState(() => _slashCommandSelection =
              (_slashCommandSelection + direction + suggestions.length) %
                  suggestions.length);
        }
        return KeyEventResult.handled;
      }
      final acceptsCompletion = (enterPressed && !shiftPressed) ||
          (event.logicalKey == LogicalKeyboardKey.tab && !shiftPressed);
      if (acceptsCompletion) {
        if (suggestions.isNotEmpty) {
          _suppressNextSlashCommandEnterNewline =
              enterPressed && defaultTargetPlatform == TargetPlatform.android;
          _activateSlashCommand(suggestions[
              _slashCommandSelection.clamp(0, suggestions.length - 1)]);
        }
        return KeyEventResult.handled;
      }
    }
    if (!enterPressed ||
        shiftPressed ||
        _hasActiveTextComposition(_composer.value)) {
      return KeyEventResult.ignored;
    }
    if (_meshPickerOpening) return KeyEventResult.handled;
    if (_recordingDictation) {
      unawaited(_finishDictation(submitAfterFinish: true));
    } else if (_retryDictationBytes != null) {
      unawaited(_retryPendingDictation(submitAfterFinish: true));
    } else {
      unawaited(_submitComposer());
    }
    return KeyEventResult.handled;
  }

  void _activateSimplify() {
    const command = '/simplify ';
    _setComposerValue(const TextEditingValue(
      text: command,
      selection: TextSelection.collapsed(offset: command.length),
    ));
    _onComposerChanged(StoreScope.of(context), command);
    _composerFocus.requestFocus();
  }

  void _removeSimplify() {
    final text = _withoutSimplifyCommand(_composer.text);
    _setComposerValue(TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    ));
    _onComposerChanged(StoreScope.of(context), text);
  }

  Future<void> _openEarsSettings() async {
    final store = StoreScope.of(context);
    for (final provider in store.providers.where((item) =>
        providerDeliversNativeAudio(item.providerId) &&
        item.state.toLowerCase() == 'online')) {
      unawaited(store.loadModels(provider.providerId));
    }
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      constraints: const BoxConstraints(maxWidth: 640),
      builder: (sheetContext) => _EarsSettingsSheet(store: store),
    );
  }

  Future<void> _openSimplifySettings() async {
    final current = _simplifySettings ?? SimplifySettings();
    final selected = await showModalBottomSheet<SimplifySettings>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      constraints: const BoxConstraints(maxWidth: 640),
      builder: (sheetContext) => _SimplifySettingsSheet(initial: current),
    );
    if (!mounted || selected == null) return;
    setState(() => _simplifySettings = selected);
    StoreScope.of(context).setDraftSimplifySettings(widget.sessionId, selected);
  }

  void _configureChildSessionMonitoring(
      RemoteAppStore store, RemoteSession session) {
    final hostId = _routeHostId;
    final sessionId = session.id;
    final lifecycleState = WidgetsBinding.instance.lifecycleState;
    if ((lifecycleState != null &&
            lifecycleState != AppLifecycleState.resumed) ||
        ModalRoute.of(context)?.isCurrent == false ||
        !_routeOperationOriginIsCurrent(
          store,
          hostId: hostId,
          sessionId: sessionId,
        )) {
      _childSessionPollTimer?.cancel();
      _childSessionPollTimer = null;
      return;
    }
    final hasMaterializedMeshChildren = store.delegationsFor(session.id).any(
        (task) => task.children
            .any((child) => child.sessionId?.trim().isNotEmpty == true));
    if (!store.providerSupportsSessionRelationships(session.providerId) &&
        !hasMaterializedMeshChildren) {
      _childSessionPollTimer?.cancel();
      _childSessionPollTimer = null;
      return;
    }
    if (_childSessionsLoadedFor != sessionId) {
      _childSessionsLoadedFor = sessionId;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_childSessionsLoadedFor != sessionId ||
            !_routeOperationOriginIsCurrent(
              store,
              hostId: hostId,
              sessionId: sessionId,
            )) {
          return;
        }
        unawaited(store
            .loadChildSessions(sessionId)
            .catchError((Object _) => const <RemoteSession>[]));
      });
    }
    final meshActive = store.delegationsFor(session.id).any((task) =>
        task.children
            .any((child) => child.sessionId?.trim().isNotEmpty == true) &&
        task.state != 'completed' &&
        task.state != 'failed');
    if (session.state == 'working' || meshActive) {
      _childSessionPollTimer ??=
          Timer.periodic(const Duration(seconds: 4), (_) {
        if (!mounted ||
            WidgetsBinding.instance.lifecycleState !=
                AppLifecycleState.resumed ||
            ModalRoute.of(context)?.isCurrent == false ||
            !_routeOperationOriginIsCurrent(
              store,
              hostId: hostId,
              sessionId: sessionId,
            )) {
          if (mounted &&
              !_routeOperationOriginIsCurrent(
                store,
                hostId: hostId,
                sessionId: sessionId,
              )) {
            _childSessionPollTimer?.cancel();
            _childSessionPollTimer = null;
          }
          return;
        }
        final current = store.sessions
            .where((item) =>
                item.id == sessionId &&
                (hostId == null || item.hostId == hostId))
            .firstOrNull;
        final currentMeshActive = store.delegationsFor(sessionId).any((task) =>
            task.children
                .any((child) => child.sessionId?.trim().isNotEmpty == true) &&
            task.state != 'completed' &&
            task.state != 'failed');
        if (current?.state != 'working' && !currentMeshActive) {
          _childSessionPollTimer?.cancel();
          _childSessionPollTimer = null;
          return;
        }
        if (!_routeOperationOriginIsCurrent(
          store,
          hostId: hostId,
          sessionId: sessionId,
        )) {
          return;
        }
        unawaited(store
            .loadChildSessions(sessionId)
            .catchError((Object _) => const <RemoteSession>[]));
      });
    } else {
      _childSessionPollTimer?.cancel();
      _childSessionPollTimer = null;
    }
  }

  Widget _buildInlineMeshTarget(BuildContext spanContext, int index) {
    if (index < 0 || index >= _meshTargets.length) {
      return const SizedBox.shrink();
    }
    final target = _meshTargets[index];
    final store = _store ?? StoreScope.of(spanContext);
    return _InlineMeshTargetChip(
      target: target,
      store: store,
      targetKey: ValueKey<String>('mesh-target-${target.providerId}'),
      removeKey: ValueKey<String>('mesh-remove-${target.providerId}'),
      onTap: () => unawaited(_editMeshTarget(index)),
      onRemove: () => _removeMeshTarget(index),
    );
  }

  void _persistMeshTargets(RemoteAppStore store) {
    if (!_routeOriginIsCurrent(store)) return;
    _meshDraftReconciled = true;
    store.setDraftDelegationSelections(widget.sessionId, _meshTargets);
  }

  void _removeMeshTarget(int index) {
    if (index < 0 || index >= _meshTargets.length) return;
    final store = _store ?? StoreScope.of(context);
    if (!_routeOriginIsCurrent(store)) return;
    final placeholderOffset = _meshPlaceholderOffset(_composer.text, index);
    var nextValue = _composer.value;
    if (placeholderOffset != null) {
      nextValue = _replaceComposerRange(
        nextValue,
        placeholderOffset,
        placeholderOffset + 1,
        '',
      );
    }
    setState(() => _meshTargets.removeAt(index));
    _setComposerValue(nextValue);
    store.setDraft(widget.sessionId, nextValue.text);
    _persistMeshTargets(store);
    _composerFocus.requestFocus();
  }

  Future<void> _activateMesh() async {
    if (_meshPickerOpening || _sending) return;
    var sourceValue = _composer.value;
    var token = _meshCommandTokenForValue(sourceValue);
    if (defaultTargetPlatform == TargetPlatform.android &&
        token != null &&
        token.start == 0 &&
        (sourceValue.text.substring(token.end) == '\n' ||
            sourceValue.text.substring(token.end) == '\r\n')) {
      sourceValue = _replaceComposerRange(
        sourceValue,
        token.end,
        sourceValue.text.length,
        '',
      );
      token = _meshCommandTokenForValue(sourceValue);
    }
    if (token == null &&
        (_filteredSlashCommands(sourceValue.text) ?? const [])
            .any((command) => command.id == 'mesh')) {
      const command = '/mesh ';
      sourceValue = const TextEditingValue(
        text: command,
        selection: TextSelection.collapsed(offset: command.length),
      );
      token = _meshCommandTokenForValue(sourceValue);
    }
    if (token == null) return;
    final anchoredValue = _replaceComposerRange(
      sourceValue,
      token.start,
      token.end,
      _meshDraftPlaceholder,
    );
    setState(() {
      _meshPickerOpening = true;
      _slashCommandPaletteDismissed = true;
    });
    try {
      await _addMeshTarget(committedValue: anchoredValue);
    } finally {
      _suppressNextSlashCommandEnterNewline = false;
      if (mounted) setState(() => _meshPickerOpening = false);
    }
  }

  Future<void> _addMeshTarget(
      {required TextEditingValue committedValue}) async {
    final store = _store ?? StoreScope.of(context);
    final hostId = _routeHostId;
    final sessionId = widget.sessionId;
    bool originIsCurrent() => _routeOperationOriginIsCurrent(
          store,
          hostId: hostId,
          sessionId: sessionId,
        );
    if (!originIsCurrent()) return;
    final session = _routeSession(store);
    if (session == null) return;
    final selectedProviders =
        _meshTargets.map((item) => item.providerId).toSet();
    final available = store.providers
        .where((provider) =>
            !selectedProviders.contains(provider.providerId) &&
            store.isProviderUsableForTasks(provider))
        .toList(growable: false);
    if (available.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('No connected harness is available for /mesh.'),
        ));
      }
      return;
    }
    final provider = await showModalBottomSheet<ProviderConnection>(
      context: context,
      constraints: const BoxConstraints(maxWidth: 640),
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 0, 18, 8),
                child: Text('Delegate with /mesh',
                    style: Theme.of(sheetContext).textTheme.titleMedium),
              ),
              ...available.map((item) => ListTile(
                    key: ValueKey<String>('mesh-provider-${item.providerId}'),
                    leading: ProviderLogo(providerId: item.providerId, size: 30),
                    title: Text(item.displayName),
                    subtitle: const Text('Create a real child session'),
                    onTap: () => Navigator.pop(sheetContext, item),
                  )),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
    );
    if (provider == null || !originIsCurrent()) return;
    final providerId = provider.providerId;
    final currentSession = _routeSession(store);
    if (currentSession == null) return;
    final providerStillAvailable = store.providers.any((candidate) =>
        candidate.providerId == providerId &&
        store.isProviderUsableForTasks(candidate));
    if (!providerStillAvailable) return;
    final models = _supportsTurnModelSelection(providerId)
        ? await store.loadModels(providerId)
        : const <RemoteModel>[];
    if (!originIsCurrent()) return;
    final remembered = store.delegationPreferences[providerId];
    final model =
        models.where((item) => item.id == remembered?.modelId).firstOrNull ??
            models.where((item) => item.isDefault).firstOrNull ??
            models.firstOrNull;
    final efforts = model?.reasoningEfforts ?? const <ReasoningEffortOption>[];
    final rememberedEffort = efforts
            .where((item) =>
                item.id ==
                _concreteReasoningEffort(remembered?.reasoningEffort))
            .firstOrNull
            ?.id ??
        _defaultConcreteReasoningEffort(model) ??
        efforts.firstOrNull?.id;
    if (_sending ||
        _meshTargets.length >= 4 ||
        _meshTargets.any((target) => target.providerId == providerId) ||
        !store.providers.any((candidate) =>
            candidate.providerId == providerId &&
            store.isProviderUsableForTasks(candidate))) {
      return;
    }
    setState(() {
      _meshTargets.add(DelegationSelection(
        providerId: providerId,
        modelId: model?.id,
        reasoningEffort: rememberedEffort,
      ));
      _slashCommandPresentationSignature =
          _slashCommandSignature(committedValue.text);
      _slashCommandSelection = 0;
    });
    _setComposerValue(committedValue);
    store.setDraft(widget.sessionId, committedValue.text);
    _persistMeshTargets(store);
    _composerFocus.requestFocus();
  }

  Future<void> _editMeshTarget(int index) async {
    final store = _store ?? StoreScope.of(context);
    final hostId = _routeHostId;
    final sessionId = widget.sessionId;
    bool originIsCurrent() => _routeOperationOriginIsCurrent(
          store,
          hostId: hostId,
          sessionId: sessionId,
        );
    if (!originIsCurrent() || index < 0 || index >= _meshTargets.length) {
      return;
    }
    final target = _meshTargets[index];
    final models = _supportsTurnModelSelection(target.providerId)
        ? await store.loadModels(target.providerId)
        : const <RemoteModel>[];
    if (!mounted ||
        !originIsCurrent() ||
        index >= _meshTargets.length ||
        !identical(_meshTargets[index], target)) {
      return;
    }
    final selectedModelId = await showModalBottomSheet<String>(
      context: context,
      constraints: const BoxConstraints(maxWidth: 640),
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(sheetContext).height * 0.72),
          child: ListView(
            shrinkWrap: true,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 0, 18, 8),
                child: Text('Model',
                    style: Theme.of(sheetContext).textTheme.titleMedium),
              ),
              if (models.isEmpty)
                ListTile(
                  title: const Text('Harness default'),
                  trailing: const Icon(Icons.check_rounded),
                  onTap: () => Navigator.pop(sheetContext, ''),
                )
              else
                ...models.map((model) => ListTile(
                      key: ValueKey<String>('mesh-model-${model.id}'),
                      selected: model.id == target.modelId,
                      title: Text(model.displayName),
                      subtitle: model.description == null
                          ? null
                          : Text(model.description!, maxLines: 2),
                      trailing: model.id == target.modelId
                          ? const Icon(Icons.check_rounded)
                          : null,
                      onTap: () => Navigator.pop(sheetContext, model.id),
                    )),
            ],
          ),
        ),
      ),
    );
    if (!mounted ||
        selectedModelId == null ||
        !originIsCurrent() ||
        index >= _meshTargets.length ||
        !identical(_meshTargets[index], target)) {
      return;
    }
    final model =
        models.where((item) => item.id == selectedModelId).firstOrNull;
    final efforts = model?.reasoningEfforts ?? const <ReasoningEffortOption>[];
    String? effort = _defaultConcreteReasoningEffort(model);
    if (efforts.isNotEmpty) {
      effort = await showModalBottomSheet<String>(
        context: context,
        constraints: const BoxConstraints(maxWidth: 640),
        showDragHandle: true,
        builder: (sheetContext) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              ListTile(
                title: const Text('Reasoning effort'),
                subtitle: Text(model?.displayName ?? 'Harness default'),
              ),
              ...efforts.map((option) => ListTile(
                    key: ValueKey<String>('mesh-effort-${option.id}'),
                    selected: option.id == target.reasoningEffort,
                    title: Text(_effortDisplayLabel(
                        option.id, model?.id, target.providerId)),
                    onTap: () => Navigator.pop(sheetContext, option.id),
                  )),
            ],
          ),
        ),
      );
      if (effort == null ||
          !originIsCurrent() ||
          index >= _meshTargets.length ||
          !identical(_meshTargets[index], target)) {
        return;
      }
    }
    if (_sending ||
        !originIsCurrent() ||
        index >= _meshTargets.length ||
        !identical(_meshTargets[index], target) ||
        !store.providers.any((provider) =>
            provider.providerId == target.providerId &&
            store.isProviderUsableForTasks(provider))) {
      return;
    }
    setState(() => _meshTargets[index] = DelegationSelection(
          providerId: target.providerId,
          modelId: model?.id,
          reasoningEffort: effort,
        ));
    _composer.refreshInlineSpans();
    _persistMeshTargets(store);
  }

  GlobalKey? _firstVisibleTimelineKey() {
    final viewportObject =
        _conversationViewportKey.currentContext?.findRenderObject();
    if (viewportObject is! RenderBox || !viewportObject.attached) return null;
    final viewportTop = viewportObject.localToGlobal(Offset.zero).dy;
    final viewportBottom = viewportTop + viewportObject.size.height;
    GlobalKey? bestKey;
    var bestTop = double.infinity;
    for (final key in _timelineKeys.values) {
      final object = key.currentContext?.findRenderObject();
      if (object is! RenderBox || !object.attached || !object.hasSize) continue;
      final top = object.localToGlobal(Offset.zero).dy;
      final bottom = top + object.size.height;
      if (bottom <= viewportTop || top >= viewportBottom) continue;
      if (top < bestTop) {
        bestTop = top;
        bestKey = key;
      }
    }
    return bestKey;
  }

  double? _timelineKeyTop(GlobalKey? key) {
    final object = key?.currentContext?.findRenderObject();
    if (object is! RenderBox || !object.attached || !object.hasSize)
      return null;
    return object.localToGlobal(Offset.zero).dy;
  }

  void _updateStickToBottom() {
    if (!_scrollController.hasClients) return;
    final position = _scrollController.position;
    // Controller listeners also receive accessibility showOnScreen requests,
    // keyboard scrolling, and other programmatic reader movement. Any move
    // away from the exact tail revokes follow just like a touch drag does.
    if (!_programmaticTailJump &&
        _stickToBottom &&
        !_isAtPhysicalBottom(position)) {
      _stickToBottom = false;
    }
    if (!_programmaticTailJump &&
        !_stickToBottom &&
        position.pixels < _historyPrefetchDistance &&
        !_loadingOlderHistory) {
      unawaited(_loadOlderHistory());
    }
    final showJump = jumpToLatestVisible(
      pixels: position.pixels,
      maxScrollExtent: position.maxScrollExtent,
    );
    if (showJump != _showJumpToLatest && mounted) {
      setState(() => _showJumpToLatest = showJump);
    }
  }

  void _preserveReaderAnchorAcrossNextLayout() {
    if (_stickToBottom ||
        _loadingOlderHistory ||
        _transcriptPointerDown ||
        _readerScrollActive ||
        !_scrollController.hasClients) {
      return;
    }
    final retainedAnchorKey = _firstVisibleTimelineKey();
    final retainedAnchorTop = _timelineKeyTop(retainedAnchorKey);
    if (retainedAnchorKey == null || retainedAnchorTop == null) return;
    final correctionGeneration = _readerInteractionGeneration;
    unawaited(_scrollController.preserveVisualAnchorOnNextGrowth(
      anchorDelta: () {
        if (!mounted ||
            _readerInteractionGeneration != correctionGeneration ||
            _transcriptPointerDown ||
            _readerScrollActive) {
          return 0;
        }
        final movedTop = _timelineKeyTop(retainedAnchorKey);
        return movedTop == null ? 0 : movedTop - retainedAnchorTop;
      },
    ));
  }

  bool _handleConversationScrollNotification(ScrollNotification notification) {
    if (notification.depth != 0) return false;
    if (notification is ScrollStartNotification &&
        notification.dragDetails != null) {
      if (!_readerScrollActive) _readerInteractionGeneration += 1;
      _readerScrollActive = true;
    } else if (notification is UserScrollNotification &&
        notification.direction != ScrollDirection.idle) {
      if (!_readerScrollActive) _readerInteractionGeneration += 1;
      _readerScrollActive = true;
    }
    if (_readerScrollActive &&
        (notification is ScrollUpdateNotification ||
            notification is OverscrollNotification ||
            notification is ScrollEndNotification ||
            notification is UserScrollNotification)) {
      _stickToBottom = _isAtPhysicalBottom(notification.metrics);
      if (notification.metrics.pixels < _historyPrefetchDistance &&
          !_loadingOlderHistory) {
        unawaited(_loadOlderHistory());
      }
    }
    if (notification is ScrollEndNotification ||
        (notification is UserScrollNotification &&
            notification.direction == ScrollDirection.idle)) {
      _readerScrollActive = false;
    }
    return false;
  }

  void _handleConversationPointerDown(PointerDownEvent _) {
    if (!_transcriptPointerDown) _readerInteractionGeneration += 1;
    _transcriptPointerDown = true;
  }

  void _handleConversationPointerEnd(PointerEvent _) {
    _transcriptPointerDown = false;
    if (!_stickToBottom || _readerScrollActive) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted &&
          _stickToBottom &&
          !_transcriptPointerDown &&
          !_readerScrollActive) {
        _jumpToLatest();
      }
    });
  }

  void _jumpToLatest() {
    if (!_scrollController.hasClients) return;
    _stickToBottom = true;
    if (_showJumpToLatest) {
      setState(() => _showJumpToLatest = false);
    }
    final position = _scrollController.position;
    if ((position.maxScrollExtent - position.pixels).abs() >
        _physicalBottomTolerance) {
      _programmaticTailJump = true;
      try {
        _scrollController.jumpTo(position.maxScrollExtent);
      } finally {
        _programmaticTailJump = false;
      }
    }
    _updateStickToBottom();
  }

  Future<void> _loadOlderHistory() async {
    final store = _store;
    final operationHostId = _routeHostId;
    final operationSessionId = widget.sessionId;
    if (_loadingOlderHistory ||
        store == null ||
        !_routeOperationOriginIsCurrent(
          store,
          hostId: operationHostId,
          sessionId: operationSessionId,
        ) ||
        !store.hasOlderHistory(operationSessionId)) {
      return;
    }
    _loadingOlderHistory = true;
    _stickToBottom = false;
    if (_historyLoadError != null && mounted) {
      setState(() => _historyLoadError = null);
    }
    try {
      final added = await store.loadOlderSessionHistory(operationSessionId);
      if (!added ||
          !_routeOperationOriginIsCurrent(
            store,
            hostId: operationHostId,
            sessionId: operationSessionId,
          )) {
        return;
      }
      final retainedAnchorKey = _firstVisibleTimelineKey();
      final retainedAnchorTop = _timelineKeyTop(retainedAnchorKey);
      final correctionGeneration = _readerInteractionGeneration;
      // The store has marked the list dirty but Flutter has not laid it out
      // yet. Arm a layout-time retained-row correction so the reading position
      // never paints at the wrong offset. Unrelated streaming below the anchor
      // is ignored, while any reader motion during the request is already
      // reflected by the row's current on-screen position.
      await _scrollController.preserveVisualAnchorOnNextGrowth(
        fallbackToExtent: true,
        anchorDelta: () {
          if (!_routeOperationOriginIsCurrent(
                store,
                hostId: operationHostId,
                sessionId: operationSessionId,
              ) ||
              _readerInteractionGeneration != correctionGeneration ||
              _transcriptPointerDown ||
              _readerScrollActive) {
            return 0;
          }
          final targetTop = retainedAnchorTop;
          if (targetTop == null) return null;
          final movedTop = _timelineKeyTop(retainedAnchorKey);
          return movedTop == null ? null : movedTop - targetTop;
        },
      );
    } on Object catch (caught) {
      if (_routeOperationOriginIsCurrent(
        store,
        hostId: operationHostId,
        sessionId: operationSessionId,
      )) {
        setState(() => _historyLoadError = compactErrorDetail(caught));
      }
    } finally {
      if (_routeOperationOriginIsCurrent(
        store,
        hostId: operationHostId,
        sessionId: operationSessionId,
      )) {
        setState(() => _loadingOlderHistory = false);
      } else {
        _loadingOlderHistory = false;
      }
    }
  }

  Future<void> _pickImageAttachment() async {
    if (_attachmentPickerBusy ||
        _sending ||
        _recordingDictation ||
        _transcribingDictation ||
        _dictationOperationInFlight ||
        !mounted) {
      return;
    }
    final store = _store ?? StoreScope.read(context);
    if (!_routeOriginIsCurrent(store)) return;
    setState(() => _attachmentPickerBusy = true);
    try {
      if (!await _ensureSessionDraftHydrated(showError: true) ||
          !mounted ||
          !_routeOriginIsCurrent(store)) {
        return;
      }
      if (!messageAttachmentSlotAvailable(_attachments.length)) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text(_attachmentLimitMessage)));
        return;
      }
      if (widget.imageAttachmentPicker != null) {
        final attachment =
            await _duringExternalSystemActivity(widget.imageAttachmentPicker!);
        if (!mounted || !_routeOriginIsCurrent(store) || attachment == null) {
          return;
        }
        if (!_isValidPhoneAttachmentLength(attachment.byteLength) ||
            attachment.dataBase64.isEmpty) {
          throw StateError('Images must be between 1 byte and 25 MiB.');
        }
        _setPendingAttachment(attachment);
        return;
      }
      final file = await _duringExternalSystemActivity(() => openFile(
            acceptedTypeGroups: const <XTypeGroup>[
              XTypeGroup(
                label: 'Images',
                extensions: <String>['jpg', 'jpeg', 'png', 'gif', 'webp'],
                mimeTypes: <String>['image/*'],
                uniformTypeIdentifiers: <String>['public.image'],
              ),
            ],
          ));
      if (!mounted || !_routeOriginIsCurrent(store) || file == null) return;
      final sourceLength = await file.length();
      if (!mounted || !_routeOriginIsCurrent(store)) return;
      if (sourceLength <= 0) {
        throw StateError('Images must contain at least 1 byte.');
      }
      if (sourceLength > _maximumPhoneImageSourceBytes) {
        throw StateError(
            'That image is too large to prepare safely. Choose one under 100 MiB.');
      }
      final source = await file.readAsBytes();
      if (!mounted || !_routeOriginIsCurrent(store)) return;
      if (source.isEmpty) {
        throw StateError('Images must contain at least 1 byte.');
      }
      final prepared = source.length <= _maxPhoneAttachmentBytes
          ? source
          : await compute(_prepareRemoteImage, source);
      if (!mounted || !_routeOriginIsCurrent(store)) return;
      if (prepared == null) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text(
              'That image could not be prepared under the 25 MiB transfer limit.'),
        ));
        return;
      }
      final stem = file.name.replaceFirst(RegExp(r'\.[^.]+$'), '');
      final converted = !identical(prepared, source);
      final dataBase64 = await compute(_encodeBase64, prepared);
      if (!mounted || !_routeOriginIsCurrent(store)) return;
      _setPendingAttachment(RemoteAttachment(
        name:
            converted ? '${stem.isEmpty ? 'attachment' : stem}.jpg' : file.name,
        mimeType: converted ? 'image/jpeg' : _imageMimeType(file.name),
        origin: 'file-picker',
        dataBase64: dataBase64,
        byteLength: prepared.length,
      ));
    } on Object catch (caught) {
      if (!mounted || !_routeOriginIsCurrent(store)) return;
      _showCompactError(context, 'That image could not be opened', caught);
    } finally {
      if (mounted) setState(() => _attachmentPickerBusy = false);
    }
  }

  Future<void> _pickFileAttachment() async {
    if (_attachmentPickerBusy ||
        _sending ||
        _recordingDictation ||
        _transcribingDictation ||
        _dictationOperationInFlight ||
        !mounted) {
      return;
    }
    final store = _store ?? StoreScope.read(context);
    if (!_routeOriginIsCurrent(store)) return;
    setState(() => _attachmentPickerBusy = true);
    try {
      if (!await _ensureSessionDraftHydrated(showError: true) ||
          !mounted ||
          !_routeOriginIsCurrent(store)) {
        return;
      }
      if (!messageAttachmentSlotAvailable(_attachments.length)) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text(_attachmentLimitMessage)));
        return;
      }
      final file = await _duringExternalSystemActivity(openFile);
      if (!mounted || !_routeOriginIsCurrent(store) || file == null) return;
      final byteLength = await file.length();
      if (!mounted || !_routeOriginIsCurrent(store)) return;
      if (!_isValidPhoneAttachmentLength(byteLength)) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Files must be between 1 byte and 25 MiB.'),
        ));
        return;
      }
      if (!messageAttachmentBytesAvailable(_attachments, byteLength)) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text(_attachmentTotalLimitMessage)));
        return;
      }
      final bytes = await file.readAsBytes();
      if (!mounted || !_routeOriginIsCurrent(store)) return;
      if (!_isValidPhoneAttachmentLength(bytes.length)) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Files must be between 1 byte and 25 MiB.'),
        ));
        return;
      }
      if (!messageAttachmentBytesAvailable(_attachments, bytes.length)) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text(_attachmentTotalLimitMessage)));
        return;
      }
      final dataBase64 = await compute(_encodeBase64, bytes);
      if (!mounted || !_routeOriginIsCurrent(store)) return;
      _setPendingAttachment(RemoteAttachment(
        name: file.name,
        mimeType: _genericMimeType(file.name),
        origin: 'file-picker',
        dataBase64: dataBase64,
        byteLength: bytes.length,
      ));
    } on Object catch (caught) {
      if (!mounted || !_routeOriginIsCurrent(store)) return;
      _showCompactError(context, 'That file could not be opened', caught);
    } finally {
      if (mounted) setState(() => _attachmentPickerBusy = false);
    }
  }

  bool _setPendingAttachment(RemoteAttachment attachment) {
    final store = _store ?? StoreScope.read(context);
    if (!_routeOriginIsCurrent(store)) return false;
    if (!messageAttachmentSlotAvailable(_attachments.length)) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text(_attachmentLimitMessage)));
      return false;
    }
    if (!_isValidPhoneAttachmentLength(attachment.byteLength) ||
        attachment.dataBase64.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('Attachments must be between 1 byte and 25 MiB.'),
      ));
      return false;
    }
    if (!messageAttachmentBytesAvailable(_attachments, attachment.byteLength)) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text(_attachmentTotalLimitMessage)));
      return false;
    }
    setState(() {
      _attachments.add(attachment);
    });
    store.setDraftAttachments(widget.sessionId, _attachments);
    final session = _routeSession(store);
    final model = session == null
        ? null
        : (store.modelsByProvider[session.providerId] ?? const <RemoteModel>[])
            .where((item) => item.id == _selectedModelId)
            .firstOrNull;
    _maybeShowImageModelNotice(model);
    return true;
  }

  void _maybeShowImageModelNotice(RemoteModel? model) {
    if (!mounted ||
        _attachments.isEmpty ||
        model?.supportsImageInput != false) {
      return;
    }
    final store = StoreScope.of(context);
    if (store.isImageModelNoticeDismissed(model!.providerId, model.id)) return;
    setState(() => _imageModelNoticeId = model.id);
  }

  Future<void> _showAttachmentMenu() async {
    if (_attachmentMenuOpen ||
        _attachmentPickerBusy ||
        _sending ||
        _recordingDictation ||
        _transcribingDictation ||
        _dictationOperationInFlight ||
        !mounted) {
      return;
    }
    setState(() => _attachmentMenuOpen = true);
    try {
      if (!await _ensureSessionDraftHydrated(showError: true) || !mounted) {
        return;
      }
      if (!messageAttachmentSlotAvailable(_attachments.length)) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text(_attachmentLimitMessage)));
        return;
      }
      final store = StoreScope.of(context);
      final session = store.sessions
          .where((item) => item.id == widget.sessionId)
          .firstOrNull;
      final supportsFiles = session != null &&
          _supportsGenericFileAttachments(session.providerId);
      final button = _attachmentAnchorKey.currentContext?.findRenderObject();
      final navigator = Navigator.of(context);
      final overlay = navigator.overlay?.context.findRenderObject();
      if (button is! RenderBox || overlay is! RenderBox) return;
      final anchor = Rect.fromPoints(
        button.localToGlobal(Offset.zero, ancestor: overlay),
        button.localToGlobal(button.size.bottomRight(Offset.zero),
            ancestor: overlay),
      );
      final openingKeyboardInset = MediaQuery.viewInsetsOf(context).bottom;
      var insetDismissalScheduled = false;
      final menuRowHeight = math.max(
        48.0,
        MediaQuery.textScalerOf(context).scale(16) + 20,
      );
      const menuWidth = 172.0;
      final menuHeight = (menuRowHeight * 2) + 8;
      final textDirection = Directionality.of(context);
      final route = RawDialogRoute<String>(
        barrierDismissible: true,
        barrierColor: Colors.transparent,
        barrierLabel: MaterialLocalizations.of(context).menuDismissLabel,
        requestFocus: false,
        transitionDuration: const Duration(milliseconds: 120),
        pageBuilder: (routeContext, _, __) {
          final currentKeyboardInset =
              MediaQuery.viewInsetsOf(routeContext).bottom;
          final insetCollapsed = openingKeyboardInset > 0 &&
              currentKeyboardInset + 1 < openingKeyboardInset;
          if (insetCollapsed) {
            if (!insetDismissalScheduled) {
              insetDismissalScheduled = true;
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (!routeContext.mounted) return;
                final activeRoute = ModalRoute.of(routeContext);
                if (activeRoute?.isCurrent != true) return;
                Navigator.of(routeContext).pop();
              });
            }
            return const SizedBox.shrink();
          }
          final size = MediaQuery.sizeOf(routeContext);
          final padding = MediaQuery.paddingOf(routeContext);
          final currentButton =
              _attachmentAnchorKey.currentContext?.findRenderObject();
          final currentOverlay = navigator.overlay?.context.findRenderObject();
          final positionedAnchor =
              currentButton is RenderBox && currentOverlay is RenderBox
                  ? Rect.fromPoints(
                      currentButton.localToGlobal(
                        Offset.zero,
                        ancestor: currentOverlay,
                      ),
                      currentButton.localToGlobal(
                        currentButton.size.bottomRight(Offset.zero),
                        ancestor: currentOverlay,
                      ),
                    )
                  : anchor;
          final desiredLeft = textDirection == TextDirection.rtl
              ? positionedAnchor.right - menuWidth
              : positionedAnchor.left;
          final maxLeft = math.max(8.0, size.width - menuWidth - 8);
          final left = desiredLeft.clamp(8.0, maxLeft).toDouble();
          final desiredBottom = size.height - positionedAnchor.top + 6;
          final minimumBottom = padding.bottom + 8;
          final maximumBottom = math.max(
            minimumBottom,
            size.height - padding.top - menuHeight - 8,
          );
          final bottom =
              desiredBottom.clamp(minimumBottom, maximumBottom).toDouble();
          return Stack(
            children: <Widget>[
              Positioned(
                left: left,
                bottom: bottom,
                width: menuWidth,
                child: _AttachmentMenuSurface(
                  filesEnabled: supportsFiles,
                  minimumRowHeight: menuRowHeight,
                  onSelected: (choice) => Navigator.pop(routeContext, choice),
                ),
              ),
            ],
          );
        },
        transitionBuilder: (routeContext, animation, _, child) {
          if (MediaQuery.disableAnimationsOf(routeContext)) return child;
          final curved = CurvedAnimation(
            parent: animation,
            curve: Curves.easeOutCubic,
            reverseCurve: Curves.easeInCubic,
          );
          return FadeTransition(
            opacity: curved,
            child: ScaleTransition(
              alignment: textDirection == TextDirection.rtl
                  ? Alignment.bottomRight
                  : Alignment.bottomLeft,
              scale: Tween<double>(begin: .97, end: 1).animate(curved),
              child: child,
            ),
          );
        },
      );
      final choice = await navigator.push(route);
      await route.completed;
      if (!mounted) return;
      if (choice == 'image') {
        await _pickImageAttachment();
      } else if (choice == 'file') {
        await _pickFileAttachment();
      }
    } finally {
      if (mounted) {
        setState(() => _attachmentMenuOpen = false);
      } else {
        _attachmentMenuOpen = false;
      }
    }
  }

  Future<void> _openDelegationChild(
      RemoteAppStore store, String childSessionId) async {
    final exactChildSessionId = childSessionId.trim();
    if (exactChildSessionId.isEmpty || !_routeOriginIsCurrent(store)) return;
    final parentSessionId = widget.sessionId;
    final hostId = _routeHostId;
    RemoteSession? exactChild(Iterable<RemoteSession> candidates) => candidates
        .where((candidate) =>
            candidate.id == exactChildSessionId &&
            (hostId == null || candidate.hostId == hostId))
        .firstOrNull;

    var child = exactChild(store.sessions);
    if (child == null) {
      try {
        final loaded = await store.loadChildSessions(parentSessionId);
        if (!mounted ||
            !_routeOperationOriginIsCurrent(
              store,
              hostId: hostId,
              sessionId: parentSessionId,
            )) {
          return;
        }
        child = exactChild(loaded) ?? exactChild(store.sessions);
      } on Object catch (caught) {
        if (mounted &&
            _routeOperationOriginIsCurrent(
              store,
              hostId: hostId,
              sessionId: parentSessionId,
            )) {
          _showCompactError(context, 'Could not open sub-agent', caught);
        }
        return;
      }
    }
    if (!mounted) return;
    if (child == null) {
      if (_routeOperationOriginIsCurrent(
        store,
        hostId: hostId,
        sessionId: parentSessionId,
      )) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('That sub-agent is still opening. Try again shortly.'),
        ));
      }
      return;
    }
    if (!mounted) return;
    _openSessionAfterPress(
      context: context,
      store: store,
      session: child,
    );
  }

  Future<void> _showChildSessions() async {
    await showModalBottomSheet<void>(
      context: context,
      constraints: const BoxConstraints(maxWidth: 640),
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) {
        final store = StoreScope.of(sheetContext);
        final children = store.childSessionsFor(widget.sessionId);
        return SafeArea(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(sheetContext).height * 0.72,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(18, 0, 18, 10),
                  child: Text(
                    'Agents',
                    style: Theme.of(sheetContext).textTheme.titleMedium,
                  ),
                ),
                if (children.isEmpty)
                  const Padding(
                    padding: EdgeInsets.fromLTRB(18, 8, 18, 22),
                    child: Text('No child agents are loaded yet.'),
                  )
                else
                  Flexible(
                    child: ListView.separated(
                      shrinkWrap: true,
                      itemCount: children.length,
                      separatorBuilder: (_, __) => const Divider(height: 1),
                      itemBuilder: (context, index) {
                        final child = children[index];
                        final name = child.agentNickname ?? child.title;
                        final details = <String>[
                          if (child.agentRole?.trim().isNotEmpty == true)
                            child.agentRole!,
                          _titleCase(child.state),
                        ];
                        return ListTile(
                          key: ValueKey<String>('child-agent-${child.id}'),
                          dense: true,
                          leading: _AgentStateIcon(state: child.state),
                          title: Text(name,
                              maxLines: 1, overflow: TextOverflow.ellipsis),
                          subtitle: Text(details.join(' · '),
                              maxLines: 1, overflow: TextOverflow.ellipsis),
                          trailing: TextButton(
                            key: ValueKey<String>(
                                'view-child-agent-${child.id}'),
                            onPressed: () async {
                              if (!sheetContext.mounted || !mounted) return;
                              Navigator.pop(sheetContext);
                              await Future<void>.delayed(Duration.zero);
                              if (!mounted) return;
                              _openSessionAfterPress(
                                context: this.context,
                                store: store,
                                session: child,
                              );
                            },
                            child: const Text('View'),
                          ),
                        );
                      },
                    ),
                  ),
                const SizedBox(height: 8),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _chooseModel(
      List<RemoteModel> models, ProviderVisualTheme visual) async {
    if (models.isEmpty || _sending || _modelPickerOpening) return;
    _modelPickerOpening = true;
    try {
      final store = StoreScope.of(context);
      final catalog = await store.loadModelCatalog();
      if (!mounted) return;
      final prepared = store.isPreparedSession(widget.sessionId);
      final currentProviderId = _modelProviderId ?? models.first.providerId;
      final fullCatalog = catalog.isEmpty ? models : catalog;
      final available = prepared
          ? fullCatalog
          : fullCatalog
              .where((model) => model.providerId == currentProviderId)
              .toList(growable: false);
      if (available.isEmpty) return;
      final selected = await showModalBottomSheet<_ModelChoice>(
        context: context,
        constraints: const BoxConstraints(maxWidth: 760),
        showDragHandle: true,
        isScrollControlled: true,
        useSafeArea: true,
        builder: (context) => FractionallySizedBox(
          heightFactor: .94,
          child: _ModelPickerSheet(
            models: available,
            recentModels: store.recentModels(available),
            currentProviderId: currentProviderId,
            selectedModelId: _selectedModelId,
            visual: visual,
          ),
        ),
      );
      if (!mounted || selected == null) return;
      final model = available.firstWhere((item) =>
          item.providerId == selected.providerId &&
          item.id == selected.modelId);
      if (prepared && model.providerId != currentProviderId) {
        store.updatePreparedProvider(widget.sessionId, model.providerId);
      }
      final reasoningEffort = _defaultConcreteReasoningEffort(model);
      setState(() {
        _modelProviderId = model.providerId;
        _selectedModelId = model.id;
        _selectedReasoningEffort = reasoningEffort;
        _imageModelNoticeId = null;
      });
      if (prepared) {
        store.updatePreparedModelSelection(
          widget.sessionId,
          modelId: model.id,
          reasoningEffort: reasoningEffort,
        );
      }
      _walletLoadedFor = '${model.providerId}\u0000${model.id}';
      unawaited(store.loadWallet(model.providerId, modelId: model.id));
      _maybeShowImageModelNotice(model);
    } finally {
      _modelPickerOpening = false;
    }
  }

  Future<void> _showTaskDetails(
      RemoteSession session, ProviderVisualTheme visual) async {
    final directory =
        session.workingDirectory ?? session.project ?? session.hostId;
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      useSafeArea: true,
      constraints: const BoxConstraints(maxWidth: 680),
      builder: (sheetContext) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text('Task details',
                style: Theme.of(sheetContext).textTheme.titleLarge),
            const SizedBox(height: 16),
            Row(
              children: <Widget>[
                ProviderLogo(providerId: session.providerId, size: 22),
                const SizedBox(width: 10),
                Text(providerVisualThemeFor(session.providerId).displayName,
                    style: Theme.of(sheetContext).textTheme.bodyLarge),
              ],
            ),
            if (session.modelId != null) ...<Widget>[
              const SizedBox(height: 14),
              Text(session.modelId!,
                  style: Theme.of(sheetContext).textTheme.bodyMedium),
            ],
            const SizedBox(height: 14),
            Text('Working directory',
                style: Theme.of(sheetContext).textTheme.labelMedium?.copyWith(
                      color: Theme.of(sheetContext)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: .62),
                    )),
            const SizedBox(height: 5),
            SingleChildScrollView(
              key: const Key('working-directory-scroll'),
              scrollDirection: Axis.horizontal,
              child: SelectableText(directory,
                  style: Theme.of(sheetContext)
                      .textTheme
                      .bodyMedium
                      ?.copyWith(fontFamily: 'monospace')),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _showGoalControls(RemoteAppStore store, RemoteSession session,
      ProviderVisualTheme visual) async {
    SessionGoal? current = store.goalsBySession[session.id];
    try {
      current = await store.loadSessionGoal(session.id);
    } on Object catch (_) {
      // The sheet remains useful with the last durable state while reconnecting.
    }
    if (!mounted) return;
    final objective = TextEditingController(text: current?.objective ?? '');
    final budget =
        TextEditingController(text: current?.tokenBudget?.toString() ?? '');
    TransitionRoute<void>? sheetRoute;
    var saving = false;
    try {
      await showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        useSafeArea: true,
        showDragHandle: true,
        constraints: const BoxConstraints(maxWidth: 680),
        builder: (sheetContext) {
          sheetRoute ??= ModalRoute.of<void>(sheetContext);
          return StatefulBuilder(
            builder: (sheetContext, setSheetState) {
              Future<void> mutate(
                  {String? status, bool saveFields = false}) async {
                if (saving) return;
                final trimmed = objective.text.trim();
                if (saveFields && trimmed.isEmpty) {
                  _showCompactError(sheetContext, 'Could not save goal',
                      'Enter an objective');
                  return;
                }
                final parsedBudget = budget.text.trim().isEmpty
                    ? null
                    : int.tryParse(budget.text.trim());
                if (saveFields &&
                    budget.text.trim().isNotEmpty &&
                    (parsedBudget == null || parsedBudget <= 0)) {
                  _showCompactError(sheetContext, 'Could not save goal',
                      'Token budget must be a positive whole number');
                  return;
                }
                setSheetState(() => saving = true);
                try {
                  current = await store.setSessionGoal(
                    session.id,
                    objective: saveFields ? trimmed : null,
                    status: status ?? (current == null ? 'active' : null),
                    tokenBudget: saveFields ? parsedBudget : null,
                    clearTokenBudget: saveFields && parsedBudget == null,
                  );
                  if (!sheetContext.mounted) return;
                  objective.text = current!.objective;
                  budget.text = current!.tokenBudget?.toString() ?? '';
                } on Object catch (error) {
                  if (sheetContext.mounted)
                    _showCompactError(
                        sheetContext, 'Could not update goal', error);
                } finally {
                  if (sheetContext.mounted) setSheetState(() => saving = false);
                }
              }

              Future<void> clear() async {
                if (saving) return;
                setSheetState(() => saving = true);
                try {
                  await store.clearSessionGoal(session.id);
                  if (!sheetContext.mounted) return;
                  current = null;
                  objective.clear();
                  budget.clear();
                  if (sheetContext.mounted) Navigator.pop(sheetContext);
                } on Object catch (error) {
                  if (sheetContext.mounted)
                    _showCompactError(
                        sheetContext, 'Could not clear goal', error);
                } finally {
                  if (sheetContext.mounted) setSheetState(() => saving = false);
                }
              }

              final statusLabel = switch (current?.status) {
                'active' => 'Active',
                'paused' => 'Paused',
                'blocked' => 'Stalled',
                'usageLimited' => 'Usage limited',
                'budgetLimited' => 'Budget limited',
                'complete' => 'Complete',
                _ => null,
              };
              final advisoryBudget = current?.source == 'tethoq' ||
                  (current == null && session.providerId != 'codex');
              return SingleChildScrollView(
                padding: EdgeInsets.fromLTRB(20, 0, 20,
                    MediaQuery.viewInsetsOf(sheetContext).bottom + 22),
                child: Column(
                  key: const Key('session-goal-sheet'),
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    Row(children: <Widget>[
                      Expanded(
                          child: Text(
                              current == null ? 'Set a goal' : 'Task goal',
                              style:
                                  Theme.of(sheetContext).textTheme.titleLarge)),
                      if (statusLabel != null)
                        Chip(
                            label: Text(statusLabel),
                            visualDensity: VisualDensity.compact),
                    ]),
                    const SizedBox(height: 14),
                    TextField(
                      key: const Key('session-goal-objective'),
                      controller: objective,
                      autofocus: true,
                      minLines: 2,
                      maxLines: 5,
                      maxLength: 4000,
                      decoration: const InputDecoration(
                          labelText: 'Objective',
                          hintText:
                              'What should this task keep working toward?'),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      key: const Key('session-goal-budget'),
                      controller: budget,
                      keyboardType: TextInputType.number,
                      decoration: InputDecoration(
                          labelText: advisoryBudget
                              ? 'Token target (advisory)'
                              : 'Token budget (optional)',
                          hintText: 'No limit'),
                    ),
                    const SizedBox(height: 16),
                    FilledButton(
                      key: const Key('session-goal-save'),
                      onPressed: saving
                          ? null
                          : () => unawaited(mutate(saveFields: true)),
                      child: Text(current == null ? 'Start goal' : 'Save'),
                    ),
                    if (current != null) ...<Widget>[
                      const SizedBox(height: 12),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: <Widget>[
                          if (current!.status == 'active')
                            OutlinedButton(
                                key: const Key('session-goal-pause'),
                                onPressed: saving
                                    ? null
                                    : () => unawaited(mutate(status: 'paused')),
                                child: const Text('Pause'))
                          else
                            OutlinedButton(
                                key: const Key('session-goal-resume'),
                                onPressed: saving
                                    ? null
                                    : () => unawaited(mutate(status: 'active')),
                                child: Text(current!.status == 'complete'
                                    ? 'Reopen'
                                    : 'Resume')),
                          if (current!.status != 'blocked')
                            OutlinedButton(
                                key: const Key('session-goal-block'),
                                onPressed: saving
                                    ? null
                                    : () =>
                                        unawaited(mutate(status: 'blocked')),
                                child: const Text('Mark stalled')),
                          if (current!.status != 'complete')
                            OutlinedButton(
                                key: const Key('session-goal-complete'),
                                onPressed: saving
                                    ? null
                                    : () =>
                                        unawaited(mutate(status: 'complete')),
                                child: const Text('Complete')),
                          TextButton(
                              key: const Key('session-goal-clear'),
                              onPressed:
                                  saving ? null : () => unawaited(clear()),
                              child: const Text('Clear')),
                        ],
                      ),
                    ],
                  ],
                ),
              );
            },
          );
        },
      );
      await sheetRoute?.completed;
    } finally {
      objective.dispose();
      budget.dispose();
    }
  }

  Future<void> _chooseReasoningEffort(
      List<ReasoningEffortOption> efforts, String? modelId,
      [String? providerId]) async {
    if (efforts.isEmpty || _sending || _reasoningPickerOpening) return;
    _reasoningPickerOpening = true;
    final store = StoreScope.of(context);
    try {
      final selected = await showModalBottomSheet<String>(
        context: context,
        constraints: const BoxConstraints(maxWidth: 640),
        showDragHandle: true,
        builder: (context) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 2, 20, 10),
                child: Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: Text('Reasoning effort',
                      style: Theme.of(context).textTheme.titleMedium),
                ),
              ),
              ...efforts.map((effort) => ListTile(
                    selected: effort.id == _selectedReasoningEffort,
                    title: Text(
                        _effortDisplayLabel(effort.id, modelId, providerId)),
                    subtitle: effort.description == null
                        ? null
                        : Text(effort.description!),
                    trailing: effort.id == _selectedReasoningEffort
                        ? const Icon(Icons.check_rounded)
                        : null,
                    onTap: () => Navigator.pop(context, effort.id),
                  )),
            ],
          ),
        ),
      );
      if (!mounted || selected == null) return;
      setState(() => _selectedReasoningEffort = selected);
      if (store.isPreparedSession(widget.sessionId)) {
        store.updatePreparedModelSelection(
          widget.sessionId,
          modelId: _selectedModelId,
          reasoningEffort: selected,
        );
      }
    } finally {
      _reasoningPickerOpening = false;
    }
  }

  Future<void> _chooseVisionProxy() async {
    if (_visionPickerOpening) return;
    _visionPickerOpening = true;
    final store = StoreScope.of(context);
    final sessionId = widget.sessionId;
    var targets = store.cachedVisionProxyTargets;
    var catalogueIncomplete = store.visionProxyTargetsIncomplete;
    var targetCacheRevision = store.visionProxyTargetsRevision;
    final wallets = <ProviderWalletStatus?>[
      store.walletByModel.values
          .where((wallet) =>
              wallet.providerId == 'direct' && wallet.endpointId == 'google')
          .firstOrNull,
      store.walletByModel.values
          .where((wallet) =>
              wallet.providerId == 'direct' && wallet.endpointId == 'xai')
          .firstOrNull,
    ];
    String? catalogueError = catalogueIncomplete
        ? targets.isEmpty
            ? 'Visual models could not be checked right now.'
            : 'Some visual models could not be refreshed. Available choices are still shown.'
        : null;
    String? actionError;
    var statusError = false;
    var loading = true;
    var statusSyncing = true;
    final walletLoading = <bool>[true, true];
    final walletErrors = <bool>[false, false];
    var hydrationStarted = false;
    var configuring = false;
    var targetRequestGeneration = 0;
    VisionProxySelection? pendingSelection;
    var hasPendingSelection = false;
    var pendingKeepOpen = false;
    var apiDraftTouched = false;
    String? apiDraftEndpoint;

    Future<void> refreshTargets(
        BuildContext sheetContext, StateSetter setSheetState) async {
      final requestGeneration = ++targetRequestGeneration;
      if (sheetContext.mounted) {
        setSheetState(() {
          loading = true;
          catalogueError = null;
        });
      }
      try {
        final loaded = await store.loadVisionProxyTargets(force: true);
        if (!sheetContext.mounted ||
            requestGeneration != targetRequestGeneration) {
          return;
        }
        setSheetState(() {
          targetCacheRevision = store.visionProxyTargetsRevision;
          targets = loaded;
          catalogueIncomplete = store.visionProxyTargetsIncomplete;
          loading = false;
          catalogueError = catalogueIncomplete
              ? targets.isEmpty
                  ? 'Visual models could not be checked right now.'
                  : 'Some visual models could not be refreshed. Available choices are still shown.'
              : null;
        });
      } on Object {
        if (!sheetContext.mounted ||
            requestGeneration != targetRequestGeneration) {
          return;
        }
        setSheetState(() {
          targetCacheRevision = store.visionProxyTargetsRevision;
          loading = false;
          catalogueError = 'Tethoq could not refresh visual models.';
        });
      }
    }

    Future<void> refreshWallet(BuildContext sheetContext,
        StateSetter setSheetState, int index, String endpointId) async {
      final loaded =
          await store.loadWallet('direct', endpointId: endpointId, force: true);
      if (!sheetContext.mounted) return;
      setSheetState(() {
        walletLoading[index] = false;
        walletErrors[index] = loaded == null;
        if (loaded != null) wallets[index] = loaded;
      });
    }

    Future<void> refreshStatus(
        BuildContext sheetContext, StateSetter setSheetState) async {
      if (sheetContext.mounted) {
        setSheetState(() {
          statusSyncing = true;
          statusError = false;
        });
      }
      try {
        final status = await store.loadVisionProxy(sessionId);
        if (!mounted ||
            !sheetContext.mounted ||
            widget.sessionId != sessionId) {
          return;
        }
        setState(() => _visionProxySelection = status.configured);
        setSheetState(() {
          statusSyncing = false;
          statusError = false;
        });
      } on Object {
        if (!sheetContext.mounted) return;
        setSheetState(() {
          statusSyncing = false;
          statusError = true;
        });
      }
    }

    Future<void> applySelection(
      BuildContext sheetContext,
      StateSetter setSheetState,
      VisionProxySelection? selection, {
      bool keepOpen = false,
    }) async {
      if (configuring) return;
      pendingSelection = selection;
      hasPendingSelection = true;
      pendingKeepOpen = keepOpen;
      setSheetState(() {
        configuring = true;
        actionError = null;
      });
      try {
        final status = await store.configureVisionProxy(sessionId, selection);
        if (!mounted ||
            !sheetContext.mounted ||
            widget.sessionId != sessionId) {
          return;
        }
        setState(() => _visionProxySelection = status.configured);
        if (keepOpen) {
          setSheetState(() => configuring = false);
        } else {
          Navigator.of(sheetContext).pop();
        }
      } on Object {
        if (!sheetContext.mounted) return;
        await refreshStatus(sheetContext, setSheetState);
        if (!sheetContext.mounted) return;
        setSheetState(() {
          configuring = false;
          actionError = 'EYES could not confirm the update. Check the selection or try again.';
        });
      }
    }

    String? apiEndpoint;
    try {
      apiEndpoint = await showModalBottomSheet<String>(
        context: context,
        constraints: const BoxConstraints(maxWidth: 640),
        showDragHandle: true,
        builder: (sheetContext) => StatefulBuilder(
          builder: (sheetContext, setSheetState) {
            final liveStore = StoreScope.of(sheetContext);
            if (targetCacheRevision != liveStore.visionProxyTargetsRevision) {
              targetCacheRevision = liveStore.visionProxyTargetsRevision;
              targets = liveStore.cachedVisionProxyTargets;
              catalogueIncomplete = liveStore.visionProxyTargetsIncomplete;
              catalogueError = catalogueIncomplete
                  ? targets.isEmpty
                      ? 'Visual models could not be checked right now.'
                      : 'Some visual models could not be refreshed. Available choices are still shown.'
                  : null;
              if (targets.isEmpty && !catalogueIncomplete) {
                scheduleMicrotask(() {
                  if (sheetContext.mounted) {
                    unawaited(refreshTargets(sheetContext, setSheetState));
                  }
                });
              }
            }
            if (!hydrationStarted) {
              hydrationStarted = true;
              scheduleMicrotask(() {
                if (!sheetContext.mounted) return;
                unawaited(refreshTargets(sheetContext, setSheetState));
                unawaited(refreshStatus(sheetContext, setSheetState));
                unawaited(
                    refreshWallet(sheetContext, setSheetState, 0, 'google'));
                unawaited(refreshWallet(sheetContext, setSheetState, 1, 'xai'));
              });
            }
            final choices = targets
                .expand((target) => target.models
                    .where((model) =>
                        model.nativeMetadata['walletKind'] != 'user_api' ||
                        model.nativeMetadata['apiKeyConfigured'] == true)
                    .map((model) => (target: target, model: model)))
                .toList(growable: false);
            final savedSelection =
                liveStore.visionBySession.containsKey(sessionId)
                    ? liveStore.visionBySession[sessionId]!.configured
                    : _visionProxySelection;
            final endpointModels = choices.where((choice) =>
                choice.target.providerId == 'direct' &&
                choice.model.id.startsWith('$apiDraftEndpoint::'));
            final endpointModel = endpointModels
                    .where((choice) => choice.model.isDefault).firstOrNull ??
                endpointModels.firstOrNull;
            final currentSelection = !apiDraftTouched ? savedSelection
                : endpointModel == null ? null
                : VisionProxySelection(providerId: 'direct', modelId: endpointModel.model.id,
                    reasoningEffort: _defaultConcreteReasoningEffort(endpointModel.model));
            final apiDraftChanged = apiDraftTouched &&
                (currentSelection?.modelId != savedSelection?.modelId ||
                 currentSelection?.providerId != savedSelection?.providerId ||
                 (apiDraftEndpoint != null && endpointModel == null));
            final hydrating =
                loading || statusSyncing || walletLoading.any((item) => item);
            return SafeArea(
              child: ListView(
                shrinkWrap: true,
                children: <Widget>[
                  const ListTile(
                    title: Text('Visual support'),
                    subtitle: Text(
                        'Choose the model that will inspect images for this session.'),
                  ),
                  SizedBox(
                    key: const Key('vision-picker-hydration-slot'),
                    height: 4,
                    child: hydrating
                        ? const LinearProgressIndicator(
                            key: Key('vision-picker-hydrating'))
                        : null,
                  ),
                  if (statusError)
                    ListTile(
                      key: const Key('vision-status-sync-error'),
                      leading: const Icon(Icons.sync_problem_rounded),
                      title:
                          const Text('Current choice could not be refreshed.'),
                      trailing: TextButton(
                        onPressed: statusSyncing
                            ? null
                            : () => unawaited(
                                refreshStatus(sheetContext, setSheetState)),
                        child: const Text('Retry'),
                      ),
                    ),
                  if (catalogueError != null)
                    ListTile(
                      key: const Key('vision-catalogue-error'),
                      leading: const Icon(Icons.sync_problem_rounded),
                      title: Text(catalogueError!),
                      trailing: TextButton(
                        onPressed: loading
                            ? null
                            : () => unawaited(
                                refreshTargets(sheetContext, setSheetState)),
                        child: const Text('Retry'),
                      ),
                    ),
                  if (actionError != null)
                    ListTile(
                      key: const Key('vision-selection-error'),
                      leading: const Icon(Icons.error_outline_rounded),
                      title: Text(actionError!),
                      trailing: hasPendingSelection
                          ? TextButton(
                              onPressed: configuring
                                  ? null
                                  : () => unawaited(applySelection(sheetContext,
                                      setSheetState, pendingSelection,
                                      keepOpen: pendingKeepOpen)),
                              child: const Text('Retry'),
                            )
                          : null,
                    ),
                  if (configuring)
                    const LinearProgressIndicator(
                        key: Key('vision-selection-saving')),
                  if (currentSelection != null)
                    ListTile(
                      leading: const Icon(Icons.visibility_off_outlined),
                      title: const Text('Disable visual support'),
                      onTap: configuring
                          ? null
                          : () => unawaited(applySelection(
                              sheetContext, setSheetState, null)),
                    ),
                  ...choices.where((choice) => choice.target.providerId != 'direct' ||
                      (!choice.model.id.startsWith('google::') &&
                       !choice.model.id.startsWith('xai::'))).map((choice) => ListTile(
                        key: ValueKey<String>(
                            'vision-model-${choice.target.providerId}-${choice.model.id}'),
                        leading: ProviderLogo(
                            providerId: choice.target.providerId, size: 30),
                        title: Text(choice.model.displayName),
                        subtitle: Text(choice.target.displayName),
                        selected: currentSelection?.providerId ==
                                choice.target.providerId &&
                            currentSelection?.modelId == choice.model.id,
                        onTap: configuring
                            ? null
                            : () => unawaited(() async {
                                  var selection = VisionProxySelection(
                                    providerId: choice.target.providerId,
                                    modelId: choice.model.id,
                                    reasoningEffort:
                                        _defaultConcreteReasoningEffort(
                                            choice.model),
                                  );
                                  final efforts = choice.model.reasoningEfforts;
                                  if (efforts.isNotEmpty) {
                                    final currentEffort =
                                        currentSelection?.providerId ==
                                                    selection.providerId &&
                                                currentSelection?.modelId ==
                                                    selection.modelId
                                            ? currentSelection?.reasoningEffort
                                            : selection.reasoningEffort;
                                    final effort =
                                        await showModalBottomSheet<String>(
                                      context: sheetContext,
                                      constraints:
                                          const BoxConstraints(maxWidth: 640),
                                      showDragHandle: true,
                                      builder: (effortContext) => SafeArea(
                                        child: Column(
                                          mainAxisSize: MainAxisSize.min,
                                          children: <Widget>[
                                            ListTile(
                                              title: const Text(
                                                  'Reasoning effort'),
                                              subtitle: Text(
                                                  choice.model.displayName),
                                            ),
                                            ...efforts.map((option) => ListTile(
                                                  key: ValueKey<String>(
                                                      'vision-effort-${option.id}'),
                                                  selected: option.id ==
                                                      currentEffort,
                                                  title: Text(
                                                      _effortDisplayLabel(
                                                          option.id,
                                                          choice.model.id,
                                                          choice.target
                                                              .providerId)),
                                                  onTap: () => Navigator.pop(
                                                      effortContext, option.id),
                                                )),
                                          ],
                                        ),
                                      ),
                                    );
                                    if (effort == null) return;
                                    selection = VisionProxySelection(
                                      providerId: selection.providerId,
                                      modelId: selection.modelId,
                                      reasoningEffort: effort,
                                    );
                                  }
                                  if (!sheetContext.mounted) return;
                                  await applySelection(
                                      sheetContext, setSheetState, selection);
                                }()),
                      )),
                  const Padding(
                    padding: EdgeInsets.fromLTRB(20, 12, 20, 4),
                    child: Text('Use your own API key'),
                  ),
                  for (final route in <({
                    String id,
                    String label,
                    String providerId,
                    int walletIndex
                  })>[
                    (
                      id: 'google',
                      label: 'Gemini API',
                      providerId: 'gemini',
                      walletIndex: 0
                    ),
                    (
                      id: 'xai',
                      label: 'Grok API',
                      providerId: 'grok',
                      walletIndex: 1
                    ),
                  ])
                    Builder(builder: (context) {
                      final stored =
                          wallets[route.walletIndex]?.apiKeyConfigured == true;
                      final active = apiDraftTouched ? apiDraftEndpoint == route.id
                          : currentSelection?.providerId == 'direct' &&
                              currentSelection!.modelId.startsWith('${route.id}::');
                      void toggle() {
                        if (!stored) { Navigator.pop(sheetContext, route.id); return; }
                        setSheetState(() {
                          apiDraftTouched = true;
                          apiDraftEndpoint = active ? null : route.id;
                          actionError = null;
                        });
                      }
                      return ListTile(
                        key: ValueKey<String>('vision-api-${route.id}'),
                        selected: active,
                        leading: ProviderLogo(
                            providerId: route.providerId, size: 30),
                        title: Text(route.label),
                        subtitle: Text(stored
                              ? active
                                  ? apiDraftChanged ? 'Selected' : 'Enabled'
                                  : 'Off'
                              : walletLoading[route.walletIndex]
                                  ? 'Checking…'
                                  : walletErrors[route.walletIndex]
                                      ? 'Could not check yet'
                                      : 'Add an encrypted API key'),
                        trailing: stored
                              ? Row(mainAxisSize: MainAxisSize.min, children: [
                                Switch(value: active,
                                    onChanged: configuring ? null : (_) => toggle()),
                                IconButton(
                                  tooltip: 'Replace ${route.label} key',
                                  icon: const Icon(Icons.key_rounded),
                                  onPressed: configuring
                                      ? null
                                      : () => Navigator.pop(sheetContext, route.id),
                                ),
                              ])
                              : const Icon(Icons.chevron_right_rounded),
                        onTap: configuring || statusSyncing ||
                            walletLoading[route.walletIndex]
                          ? null
                          : toggle,
                      );
                    }),
                  if (wallets.any((wallet) => wallet?.apiKeyConfigured == true))
                    Padding(padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
                      child: FilledButton(
                        onPressed: !apiDraftChanged || configuring || statusSyncing || statusError
                            ? null : () {
                                if (apiDraftEndpoint != null && endpointModel == null) {
                                  setSheetState(() => actionError = 'Visual models are unavailable. Retry discovery, then apply your selection.');
                                  return;
                                }
                                unawaited(applySelection(sheetContext, setSheetState, currentSelection));
                              },
                        child: const Text('Use as eyes'),
                      )),
                  if (choices.isEmpty && !loading && !catalogueIncomplete)
                    const Padding(
                      padding: EdgeInsets.fromLTRB(20, 8, 20, 18),
                      child: Text(
                        'Add a key above or connect an image-capable model in a harness.',
                        textAlign: TextAlign.center,
                      ),
                    ),
                ],
              ),
            );
          },
        ),
      );
    } finally {
      _visionPickerOpening = false;
    }
    if (!mounted || apiEndpoint == null) return;
    if (await _configureEyesApiKey(apiEndpoint) && mounted) {
      scheduleMicrotask(_chooseVisionProxy);
    }
  }

  Future<bool> _configureEyesApiKey(String endpointId) async {
    if (endpointId != 'google' && endpointId != 'xai') return false;
    final store = StoreScope.of(context);
    final sessionId = widget.sessionId;
    final controller = TextEditingController();
    final label = endpointId == 'xai' ? 'Grok API' : 'Gemini API';
    final keyLabel = endpointId == 'xai'
        ? 'XAI_API_KEY / GROK_API_KEY'
        : 'GOOGLE_API_KEY / GEMINI_API_KEY';
    TransitionRoute<bool>? sheetRoute;
    var busy = false;
    String? error;
    try {
      final saved = await showModalBottomSheet<bool>(
        context: context,
        constraints: const BoxConstraints(maxWidth: 640),
        isScrollControlled: true,
        showDragHandle: true,
        builder: (sheetContext) {
          sheetRoute ??= ModalRoute.of<bool>(sheetContext);
          return StatefulBuilder(
            builder: (context, setSheetState) {
              Future<void> save() async {
                if (busy || controller.text.trim().length < 8) return;
                var keySaved = false;
                setSheetState(() {
                  busy = true;
                  error = null;
                });
                try {
                  final wallet = await store.configureWallet(
                    providerId: 'direct',
                    endpointId: endpointId,
                    apiKey: controller.text.trim(),
                    validateApiKey: true,
                  );
                  if (!wallet.apiKeyConfigured) {
                    if (sheetContext.mounted) {
                      setSheetState(() {
                        busy = false;
                        error =
                            'That API key was not accepted. Check it and try again.';
                      });
                    }
                    return;
                  }
                  if (!sheetContext.mounted) return;
                  keySaved = true;
                  final targets = await store.loadVisionProxyTargets(force: true);
                  final models = targets
                      .where((target) => target.providerId == 'direct')
                      .expand((target) => target.models)
                      .where((model) => model.id.startsWith('$endpointId::') &&
                          model.nativeMetadata['apiKeyConfigured'] == true &&
                          model.nativeMetadata['apiKeyVerified'] == true);
                  final model = models.where((model) => model.isDefault).firstOrNull ??
                      models.firstOrNull;
                  if (model == null) throw StateError('No verified visual model');
                  if (!sheetContext.mounted || widget.sessionId != sessionId) return;
                  final status = await store.configureVisionProxy(sessionId,
                      VisionProxySelection(providerId: 'direct', modelId: model.id,
                        reasoningEffort: _defaultConcreteReasoningEffort(model)));
                  if (!mounted || !sheetContext.mounted || widget.sessionId != sessionId) return;
                  setState(() => _visionProxySelection = status.configured);
                  controller.clear();
                  Navigator.pop(sheetContext, true);
                } on Object catch (cause) {
                  if (sheetContext.mounted) {
                    setSheetState(() {
                      busy = false;
                      error = keySaved
                          ? 'The key was saved, but EYES could not be enabled. Try again or choose another model.'
                          : cause is BridgeRequestException &&
                              cause.code == 'AUTH_INVALID'
                          ? 'That API key was not accepted. Check it and try again.'
                          : 'Tethoq could not verify that key yet. Nothing was saved.';
                    });
                  }
                }
              }

              return SafeArea(
                child: Padding(
                  padding: EdgeInsets.fromLTRB(
                      20, 2, 20, 16 + MediaQuery.viewInsetsOf(context).bottom),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      Text(label,
                          style: Theme.of(context).textTheme.titleMedium),
                      const SizedBox(height: 4),
                      const Text(
                          'The paired Bridge encrypts this key locally and never returns it to the app.'),
                      const SizedBox(height: 14),
                      TextField(
                        key: ValueKey<String>('vision-api-key-$endpointId'),
                        controller: controller,
                        autofocus: true,
                        obscureText: true,
                        autocorrect: false,
                        enableSuggestions: false,
                        decoration: InputDecoration(
                            labelText: keyLabel, hintText: 'Paste API key'),
                        onSubmitted: (_) => save(),
                      ),
                      if (error != null) ...<Widget>[
                        const SizedBox(height: 8),
                        Text(error!,
                            style: TextStyle(
                                color: Theme.of(context).colorScheme.error)),
                      ],
                      const SizedBox(height: 12),
                      Wrap(
                        alignment: WrapAlignment.end,
                        spacing: 8,
                        runSpacing: 8,
                        children: <Widget>[
                          TextButton(
                            onPressed: busy
                                ? null
                                : () => Navigator.pop(sheetContext, false),
                            child: const Text('Cancel'),
                          ),
                          FilledButton(
                            onPressed: busy ? null : save,
                            child:
                                Text(busy ? 'Checking…' : 'Save and use now'),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              );
            },
          );
        },
      );
      await sheetRoute?.completed;
      return saved == true;
    } finally {
      controller.clear();
      controller.dispose();
    }
  }

  Future<void> _chooseDeliveryMode(
      {required bool steeringSupported,
      required bool steeringAvailable}) async {
    if (_sending || _deliveryPickerOpening) return;
    _deliveryPickerOpening = true;
    try {
      final selected = await showModalBottomSheet<String>(
        context: context,
        constraints: const BoxConstraints(maxWidth: 640),
        showDragHandle: true,
        builder: (context) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const ListTile(
                title: Text('Send behavior'),
                subtitle: Text('Choose how this instruction joins the task.'),
              ),
              ListTile(
                key: const Key('delivery-option-queue'),
                leading: const Icon(Icons.schedule_send_outlined),
                title: const Text('Queue'),
                subtitle: const Text('Run it next after the current work.'),
                trailing: _deliveryMode != 'steer'
                    ? const Icon(Icons.check_rounded)
                    : null,
                onTap: () => Navigator.pop(context, 'queue'),
              ),
              ListTile(
                key: const Key('delivery-option-steer'),
                leading: const Icon(Icons.alt_route_rounded),
                title: const Text('Steer'),
                subtitle: Text(!steeringSupported
                    ? 'This harness does not support live steering.'
                    : steeringAvailable
                        ? 'Add direction to the work that is running now.'
                        : 'Available while this session is actively working.'),
                enabled: steeringAvailable,
                trailing: steeringAvailable && _deliveryMode == 'steer'
                    ? const Icon(Icons.check_rounded)
                    : null,
                onTap: steeringAvailable
                    ? () => Navigator.pop(context, 'steer')
                    : null,
              ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      );
      if (!mounted || selected == null) return;
      final store = StoreScope.read(context);
      store.turnOnQueueingFor(widget.sessionId);
      setState(() => _deliveryMode = selected);
    } finally {
      _deliveryPickerOpening = false;
    }
  }

  Future<void> _editSentMessage(
      RemoteMessage message, ProviderVisualTheme visual) async {
    final original = message.parts
        .where((part) => part.type == 'text')
        .map((part) => part.summary)
        .where((text) => text.trim().isNotEmpty)
        .join('\n');
    if (original.isEmpty) return;
    var editedText = original;
    final replacement = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Edit and restart from here?'),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              TextFormField(
                key: const Key('edit-message-field'),
                initialValue: original,
                onChanged: (value) => editedText = value,
                autofocus: true,
                minLines: 2,
                maxLines: 8,
              ),
              const SizedBox(height: 12),
              Text(
                'Codex will remove this turn and every later turn, then restart with the edited message. Files already changed on the computer are not reverted.',
                style: Theme.of(dialogContext).textTheme.bodySmall?.copyWith(
                      color: Theme.of(dialogContext)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.68),
                    ),
              ),
            ],
          ),
        ),
        actions: <Widget>[
          TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('Cancel')),
          FilledButton(
            key: const Key('confirm-edit-message'),
            onPressed: () {
              final value = editedText.trim();
              if (value.isNotEmpty) Navigator.pop(dialogContext, value);
            },
            child: const Text('Edit & restart'),
          ),
        ],
      ),
    );
    if (!mounted || replacement == null || replacement == original.trim()) {
      return;
    }
    final store = StoreScope.of(context);
    setState(() => _sending = true);
    try {
      await store.editMessage(
        widget.sessionId,
        message,
        replacement,
        modelId: _selectedModelId,
        reasoningEffort: _selectedReasoningEffort,
      );
    } on Object catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Could not edit that message: $error')));
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _openMessageActions(
    RemoteMessage message,
    ProviderVisualTheme visual, {
    required bool editEnabled,
  }) async {
    final copyText = _copyableMessageText(message);
    if (copyText.isEmpty && !editEnabled) return;
    Future<void>? actionSheetCompleted;
    final action = await showModalBottomSheet<_MessageAction>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      constraints: const BoxConstraints(maxWidth: 640),
      backgroundColor: visual.surfaceRaised,
      builder: (sheetContext) {
        final completion = ModalRoute.of(sheetContext)?.completed;
        if (completion != null) {
          actionSheetCompleted ??= completion.then<void>((_) {});
        }
        return SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                if (copyText.isNotEmpty)
                  SizedBox(
                    height: 56,
                    child: ListTile(
                      key: ValueKey<String>('copy-message-${message.id}'),
                      minLeadingWidth: 32,
                      leading: const Icon(Icons.copy_rounded),
                      title: const Text('Copy message'),
                      onTap: () =>
                          Navigator.pop(sheetContext, _MessageAction.copy),
                    ),
                  ),
                if (editEnabled)
                  SizedBox(
                    height: 56,
                    child: ListTile(
                      key: ValueKey<String>('edit-message-${message.id}'),
                      minLeadingWidth: 32,
                      leading: const Icon(Icons.edit_outlined),
                      title: const Text('Edit & restart'),
                      onTap: () =>
                          Navigator.pop(sheetContext, _MessageAction.edit),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
    if (!mounted || action == null) return;
    final completed = actionSheetCompleted;
    if (completed != null) await completed;
    if (!mounted) return;
    if (action == _MessageAction.edit) {
      await _editSentMessage(message, visual);
      return;
    }
    try {
      await Clipboard.setData(ClipboardData(text: copyText));
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Message copied')),
      );
    } on Object {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not copy message')),
      );
    }
  }

  Future<void> _editQueuedInstruction(
      RemoteAppStore store, RemoteQueuedMessage message) async {
    var editedContent = message.content;
    var saving = false;
    String? saveError;
    ModalRoute<Object?>? editorRoute;
    try {
      await showModalBottomSheet<void>(
        context: context,
        useSafeArea: true,
        isScrollControlled: true,
        showDragHandle: true,
        constraints: const BoxConstraints(maxWidth: 640),
        builder: (sheetContext) {
          editorRoute ??= ModalRoute.of(sheetContext);
          return StatefulBuilder(
            builder: (sheetContext, setSheetState) {
              final mediaQuery = MediaQuery.of(sheetContext);
              final keyboardInset = mediaQuery.viewInsets.bottom;
              final availableHeight = math.max(
                0.0,
                mediaQuery.size.height -
                    keyboardInset -
                    mediaQuery.padding.top -
                    mediaQuery.padding.bottom,
              );
              return Padding(
                padding: EdgeInsets.only(bottom: keyboardInset),
                child: ConstrainedBox(
                  constraints: BoxConstraints(maxHeight: availableHeight),
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        Text('Edit queued message',
                            style:
                                Theme.of(sheetContext).textTheme.titleMedium),
                        const SizedBox(height: 10),
                        TextFormField(
                          key: const Key('edit-queued-message-field'),
                          initialValue: message.content,
                          enabled: !saving,
                          onChanged: (value) {
                            editedContent = value;
                            if (saveError != null) {
                              setSheetState(() => saveError = null);
                            }
                          },
                          autofocus: true,
                          minLines: 2,
                          maxLines: 7,
                          decoration: InputDecoration(errorText: saveError),
                        ),
                        const SizedBox(height: 10),
                        FilledButton(
                          key: const Key('save-queued-message'),
                          onPressed: saving
                              ? null
                              : () async {
                                  final value = editedContent.trim();
                                  if (value.isEmpty) {
                                    setSheetState(
                                        () => saveError = 'Enter a message');
                                    return;
                                  }
                                  if (value == message.content.trim()) {
                                    Navigator.pop(sheetContext);
                                    return;
                                  }
                                  setSheetState(() {
                                    saving = true;
                                    saveError = null;
                                  });
                                  try {
                                    await store.editQueuedMessage(
                                        message, value);
                                    if (sheetContext.mounted &&
                                        editorRoute?.isCurrent == true) {
                                      Navigator.pop(sheetContext);
                                    }
                                  } on Object catch (caught) {
                                    if (!sheetContext.mounted) return;
                                    setSheetState(() {
                                      saving = false;
                                      saveError = compactErrorDetail(caught);
                                    });
                                  }
                                },
                          child: saving
                              ? const SizedBox.square(
                                  dimension: 18,
                                  child:
                                      CircularProgressIndicator(strokeWidth: 2),
                                )
                              : Text(saveError == null ? 'Save' : 'Retry'),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          );
        },
      );
    } on Object catch (caught) {
      if (mounted) {
        _showCompactError(context, 'Could not open message editor', caught);
      }
    }
  }

  Future<void> _openQueuedInstructionActions(
    RemoteAppStore store,
    RemoteSession session,
    RemoteQueuedMessage message,
  ) async {
    if (_queuedInstructionActionsOpen) return;
    _queuedInstructionActionsOpen = true;
    try {
      FocusManager.instance.primaryFocus?.unfocus();
      final canSteer = session.state == 'working' &&
          store.providerSupportsSteering(session.providerId);
      final deliveryUnresolved = !message.retryable;
      Future<void>? actionSheetCompleted;
      final action = await showModalBottomSheet<_QueuedMessageAction>(
        context: context,
        useSafeArea: true,
        isScrollControlled: true,
        showDragHandle: true,
        constraints: const BoxConstraints(maxWidth: 640),
        builder: (sheetContext) {
          final completion = ModalRoute.of(sheetContext)?.completed;
          if (completion != null) {
            actionSheetCompleted ??= completion.then<void>((_) {});
          }
          return SafeArea(
            top: false,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  _QueueActionTile(
                    key: const Key('queued-action-edit'),
                    icon: Icons.edit_outlined,
                    label: 'Edit message',
                    onTap: deliveryUnresolved
                        ? null
                        : () => Navigator.pop(
                            sheetContext, _QueuedMessageAction.edit),
                  ),
                  _QueueActionTile(
                    key: const Key('queued-action-deliver'),
                    icon: canSteer
                        ? Icons.alt_route_rounded
                        : Icons.send_outlined,
                    label: canSteer ? 'Steer now' : 'Send now',
                    onTap: deliveryUnresolved
                        ? null
                        : () => Navigator.pop(
                            sheetContext, _QueuedMessageAction.deliver),
                  ),
                  _QueueActionTile(
                    key: const Key('queued-action-side-chat'),
                    icon: Icons.add_comment_outlined,
                    label: 'Open in side chat',
                    onTap: deliveryUnresolved
                        ? null
                        : () => Navigator.pop(
                            sheetContext, _QueuedMessageAction.sideChat),
                  ),
                  _QueueActionTile(
                    key: const Key('queued-action-new-task'),
                    icon: Icons.call_split_rounded,
                    label: 'Send to new task',
                    onTap: deliveryUnresolved
                        ? null
                        : () => Navigator.pop(
                            sheetContext, _QueuedMessageAction.newTask),
                  ),
                  _QueueActionTile(
                    key: const Key('queued-action-disable-queue'),
                    icon: Icons.next_plan_outlined,
                    label: 'Turn off queuing',
                    onTap: () => Navigator.pop(
                        sheetContext, _QueuedMessageAction.disableQueue),
                  ),
                  const SizedBox(height: 8),
                ],
              ),
            ),
          );
        },
      );
      if (!mounted || action == null) return;
      final completed = actionSheetCompleted;
      if (completed == null) return;
      await completed;
      if (!mounted) return;
      try {
        switch (action) {
          case _QueuedMessageAction.edit:
            await WidgetsBinding.instance.endOfFrame;
            if (!mounted) return;
            await _editQueuedInstruction(store, message);
            return;
          case _QueuedMessageAction.deliver:
            await store.deliverQueuedMessage(message,
                mode: canSteer ? 'steer' : 'send');
            return;
          case _QueuedMessageAction.sideChat:
            if (_dictationBlocksPop) {
              _showCompactError(
                context,
                'Finish voice input first',
                StateError('The current recording is still active or saved.'),
              );
              return;
            }
            final created = await store.createSideChat(
              session.id,
              queuedMessageId: message.id,
            );
            if (mounted) {
              await _showSideChatSheet(
                context,
                created,
                dictationRecorderFactory:
                    widget.sideChatDictationRecorderFactory,
              );
            }
            return;
          case _QueuedMessageAction.newTask:
            final catalog = await store.loadModelCatalog();
            if (!mounted) return;
            final usableProviderIds = store.providers
                .where((provider) =>
                    provider.detected &&
                    provider.state == 'online' &&
                    provider.authenticated != false &&
                    provider.capabilities.createSession &&
                    provider.capabilities.modelEnumeration)
                .map((provider) => provider.providerId)
                .toSet();
            final models = catalog
                .where((model) => usableProviderIds.contains(model.providerId))
                .toList(growable: false);
            if (models.isEmpty) {
              throw StateError('No connected Agent is ready to start a task');
            }
            final choice = await showModalBottomSheet<_QueuedTaskChoice>(
              context: context,
              useSafeArea: true,
              showDragHandle: true,
              isScrollControlled: true,
              constraints: const BoxConstraints(maxWidth: 720),
              builder: (sheetContext) => FractionallySizedBox(
                heightFactor: .86,
                child: _QueuedNewTaskSheet(
                  models: models,
                  sessions: store.sessions,
                  recentModels: store.recentModels(models),
                  sourceSession: session,
                  message: message,
                ),
              ),
            );
            if (!mounted || choice == null) return;
            final created = await store.moveQueuedMessageToNewTask(
              message,
              providerId: choice.providerId,
              modelId: choice.modelId,
              reasoningEffort: choice.reasoningEffort,
            );
            if (!mounted) return;
            await Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (_) => SessionScreen(sessionId: created.id),
            ));
            return;
          case _QueuedMessageAction.disableQueue:
            store.turnOffQueueingFor(session.id);
            setState(() => _deliveryMode = canSteer ? 'steer' : 'send');
            return;
        }
      } on Object catch (caught) {
        if (mounted)
          _showCompactError(context, 'Could not update message', caught);
      }
    } finally {
      _queuedInstructionActionsOpen = false;
    }
  }

  Future<void> _createSideChat(RemoteAppStore store) async {
    if (_sideChatOpening) return;
    if (_dictationBlocksPop) {
      _showCompactError(
        context,
        'Finish voice input first',
        StateError('The current recording is still active or saved.'),
      );
      return;
    }
    setState(() => _sideChatOpening = true);
    try {
      final created = await store.createSideChat(widget.sessionId);
      if (mounted) {
        await _showSideChatSheet(
          context,
          created,
          dictationRecorderFactory: widget.sideChatDictationRecorderFactory,
        );
      }
    } on Object catch (caught) {
      if (mounted)
        _showCompactError(context, 'Could not open side chat', caught);
    } finally {
      if (mounted) {
        setState(() => _sideChatOpening = false);
      } else {
        _sideChatOpening = false;
      }
    }
  }

  Future<void> _openContextControls(RemoteAppStore store, RemoteSession session,
      ProviderVisualTheme visual) async {
    var usage = store.contextBySession[session.id];
    if (usage == null) {
      try {
        usage = await store.loadSessionContext(session.id);
      } on Object catch (error) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('Context usage is unavailable: $error')));
        }
        return;
      }
    }
    if (!mounted) return;
    final initial = usage;
    final reportedWindowTokens = initial.contextWindowTokens;
    final windowTokens =
        reportedWindowTokens != null && reportedWindowTokens > 0
            ? reportedWindowTokens
            : null;
    var minimum = initial.minimumThresholdTokens ?? 1000;
    if (minimum < 1) minimum = 1;
    if (windowTokens != null && minimum > windowTokens) {
      minimum = windowTokens;
    }
    final maximum = windowTokens ?? minimum;
    var threshold = (initial.compactionThresholdTokens ?? maximum)
        .clamp(minimum, maximum)
        .toInt();
    final selected = await showModalBottomSheet<int>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      backgroundColor: visual.surfaceRaised,
      builder: (sheetContext) => StatefulBuilder(
        builder: (sheetContext, setSheetState) => SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 10, 20, 22),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  decoration: BoxDecoration(
                    color: visual.border,
                    borderRadius: BorderRadius.circular(999),
                  ),
                ),
              ),
              const SizedBox(height: 18),
              const Text('Set automatic compaction',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
              const SizedBox(height: 18),
              Row(
                children: <Widget>[
                  Expanded(
                    child: Text('Current use',
                        style: Theme.of(sheetContext).textTheme.bodyMedium),
                  ),
                  if (_contextFraction(initial) != null)
                    Text(_contextPercentLabel(initial),
                        style: TextStyle(
                            color: visual.accent,
                            fontSize: 17,
                            fontWeight: FontWeight.w700)),
                ],
              ),
              const SizedBox(height: 8),
              SizedBox(
                key: const Key('session-context-threshold-bar'),
                height: 44,
                child: Stack(
                  alignment: Alignment.center,
                  children: <Widget>[
                    Positioned(
                      left: 12,
                      right: 12,
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(999),
                        child: LinearProgressIndicator(
                          minHeight: 8,
                          value: _contextFraction(initial) ?? 0,
                          color: visual.accent,
                          backgroundColor: visual.border.withValues(alpha: .55),
                        ),
                      ),
                    ),
                    if (initial.supportsThreshold && windowTokens != null)
                      Semantics(
                        label: 'Automatic compaction threshold',
                        value: _compactTokenCount(threshold),
                        child: SliderTheme(
                          data: SliderTheme.of(sheetContext).copyWith(
                            trackHeight: 0,
                            activeTrackColor: Colors.transparent,
                            inactiveTrackColor: Colors.transparent,
                            disabledActiveTrackColor: Colors.transparent,
                            disabledInactiveTrackColor: Colors.transparent,
                            thumbColor: visual.accent,
                            overlayColor: visual.accent.withValues(alpha: .12),
                            thumbShape: const RoundSliderThumbShape(
                                enabledThumbRadius: 9),
                            overlayShape: const RoundSliderOverlayShape(
                                overlayRadius: 19),
                            showValueIndicator:
                                ShowValueIndicator.onlyForDiscrete,
                          ),
                          child: Slider(
                            key: const Key('session-context-threshold-slider'),
                            min: 0,
                            max: maximum.toDouble(),
                            divisions: (maximum ~/ 1000).clamp(1, 100).toInt(),
                            value: threshold.toDouble(),
                            label: _compactTokenCount(threshold),
                            semanticFormatterCallback: (_) =>
                                '${_compactTokenCount(threshold)} tokens',
                            onChanged: initial.isCompacting
                                ? null
                                : (value) {
                                    final next = value
                                        .round()
                                        .clamp(minimum, maximum)
                                        .toInt();
                                    setSheetState(() => threshold = next);
                                  },
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              if (initial.supportsThreshold &&
                  windowTokens != null) ...<Widget>[
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: <Widget>[
                    Text(_compactTokenCount(minimum),
                        style: Theme.of(sheetContext).textTheme.labelSmall),
                    Text(_compactTokenCount(threshold),
                        style: TextStyle(
                            color: visual.accent, fontWeight: FontWeight.w700)),
                    Text(_compactTokenCount(maximum),
                        style: Theme.of(sheetContext).textTheme.labelSmall),
                  ],
                ),
                const SizedBox(height: 9),
                Text(
                  'Compacts this task automatically when its context reaches this point.',
                  style: TextStyle(
                      color: Theme.of(sheetContext)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: .57),
                      fontSize: 13),
                ),
              ] else ...<Widget>[
                const SizedBox(height: 9),
                Text(
                  'Automatic compaction is not available for this agent.',
                  style: TextStyle(
                      color: Theme.of(sheetContext)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: .62),
                      height: 1.4),
                ),
              ],
              const SizedBox(height: 16),
              Text(
                'Usage details',
                key: const Key('session-context-usage-details'),
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                  decoration: TextDecoration.underline,
                  decorationThickness: 1,
                ),
              ),
              const SizedBox(height: 4),
              _ContextStatRow(
                  label: 'Context used',
                  value: initial.usedTokens == null
                      ? 'Not reported'
                      : _compactTokenCount(initial.usedTokens)),
              if (initial.compactionThresholdTokens != null)
                _ContextStatRow(
                    label: 'Automatic compaction',
                    value:
                        _compactTokenCount(initial.compactionThresholdTokens)),
              _ContextStatRow(
                  label: 'Model capacity',
                  value: initial.contextWindowTokens == null
                      ? 'Not reported'
                      : _compactTokenCount(initial.contextWindowTokens)),
              _ContextStatRow(
                  label: 'Input / output',
                  value:
                      '${initial.usage.inputTokens == null ? 'Not reported' : _compactTokenCount(initial.usage.inputTokens)} / ${initial.usage.outputTokens == null ? 'Not reported' : _compactTokenCount(initial.usage.outputTokens)}'),
              if (initial.usage.cacheReadTokens != null ||
                  initial.usage.cacheWriteTokens != null)
                _ContextStatRow(
                    label: 'Cached read / write',
                    value:
                        '${initial.usage.cacheReadTokens == null ? 'Not reported' : _compactTokenCount(initial.usage.cacheReadTokens)} / ${initial.usage.cacheWriteTokens == null ? 'Not reported' : _compactTokenCount(initial.usage.cacheWriteTokens)}'),
              if (_contextCost(initial) != null)
                _ContextStatRow(
                    label: 'Session cost', value: _contextCost(initial)!),
              const SizedBox(height: 8),
              if (initial.supportsThreshold &&
                  windowTokens != null) ...<Widget>[
                if ((session.state == 'working' ||
                        session.state == 'needs_approval' ||
                        session.state == 'needs_input') &&
                    initial.usedTokens != null &&
                    threshold <= initial.usedTokens!)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Text(
                      'Applying now will compact this task during the current turn.',
                      key: const Key('current-turn-compaction-note'),
                      style: TextStyle(
                          color: Theme.of(sheetContext)
                              .colorScheme
                              .onSurface
                              .withValues(alpha: .68),
                          fontSize: 12.5,
                          height: 1.35),
                    ),
                  ),
                FilledButton(
                  key: const Key('save-session-context-threshold'),
                  onPressed: initial.isCompacting ||
                          threshold == initial.compactionThresholdTokens
                      ? null
                      : () => Navigator.pop(sheetContext, threshold),
                  child: Text(initial.isCompacting ? 'Compacting…' : 'Apply'),
                ),
              ],
            ],
          ),
        ),
      ),
    );
    if (selected == null || !mounted) return;
    try {
      await store.setSessionCompactionThreshold(session.id, selected,
          compactNow: true);
    } on Object catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Could not update the threshold: $error')));
      }
    }
  }

  Future<void> _runSourceSessionAction(
    RemoteAppStore store,
    RemoteSession session,
    _SourceSessionAction action,
  ) async {
    if (_sourceActionRunning) return;
    final openingHostId = session.hostId;
    if (!_routeOriginIsCurrent(store) ||
        (store.activeHost != null &&
            store.activeHost!.hostId != openingHostId)) {
      return;
    }
    if (!await _ensureSessionDraftHydrated(showError: true) || !mounted) {
      return;
    }
    if (!_routeOriginIsCurrent(store) ||
        (store.activeHost != null &&
            store.activeHost!.hostId != openingHostId)) {
      return;
    }
    if (_dictationBlocksPop) {
      _showCompactError(
        context,
        'Finish voice input first',
        StateError('The current recording is still active or saved.'),
      );
      return;
    }
    final result = await showModalBottomSheet<_SourceSessionActionResult>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      constraints: const BoxConstraints(maxWidth: 680),
      builder: (sheetContext) => Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.viewInsetsOf(sheetContext).bottom,
        ),
        child: _SourceSessionActionSheet(
          action: action,
          store: store,
          openingHostId: openingHostId,
          sessionId: session.id,
          harnessId: session.providerId,
          recorder: _dictationRecorder,
        ),
      ),
    );
    final currentSession = _routeSession(store);
    if (!mounted ||
        result == null ||
        !_routeOriginIsCurrent(store) ||
        (store.activeHost != null &&
            store.activeHost!.hostId != openingHostId) ||
        currentSession == null ||
        currentSession.providerId != session.providerId) {
      return;
    }
    setState(() => _sourceActionRunning = true);
    late final RemoteSession created;
    try {
      if (action == _SourceSessionAction.handoff) {
        created = (await store.contextHandoff(session.id)).session;
      } else {
        created = (await store.branchSession(session.id, prompt: result.prompt))
            .session;
      }
    } on Object catch (caught) {
      if (mounted &&
          _routeOriginIsCurrent(store) &&
          (store.activeHost == null ||
              store.activeHost!.hostId == openingHostId)) {
        if (result.ownsRetainedDictation) {
          _restoreSourceActionDictationForRetry(store);
        }
        final message = compactErrorDetail(caught);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Could not create the new task: $message'),
        ));
      }
      if (mounted) setState(() => _sourceActionRunning = false);
      return;
    }

    var destinationDraftDurable = true;
    if (action == _SourceSessionAction.handoff) {
      store.setDraft(created.id, result.prompt);
      try {
        await store.flushDraftJournal();
      } on Object {
        destinationDraftDurable = false;
        if (mounted && _routeOriginIsCurrent(store)) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content:
                Text('New task created. Its draft will finish saving safely.'),
          ));
        }
      }
    }
    if (result.ownsRetainedDictation &&
        (action == _SourceSessionAction.branch || destinationDraftDurable) &&
        mounted &&
        _routeOriginIsCurrent(store) &&
        (store.activeHost == null ||
            store.activeHost!.hostId == openingHostId)) {
      try {
        await store.clearRetainedDictation(session.id);
      } on Object {
        if (mounted && _routeOriginIsCurrent(store)) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text(
                'New task created. Saved recording cleanup will finish safely.'),
          ));
        }
      }
    }
    if (!mounted ||
        !_routeOriginIsCurrent(store) ||
        (store.activeHost != null &&
            store.activeHost!.hostId != openingHostId) ||
        created.hostId != openingHostId) {
      if (mounted) setState(() => _sourceActionRunning = false);
      return;
    }
    store.openSessionForView(created);
    try {
      await Navigator.of(context).push(sessionScreenRoute(created.id));
    } on Object catch (caught) {
      if (mounted) {
        _showCompactError(
            context, 'New task created but could not open', caught);
      }
    } finally {
      if (mounted) setState(() => _sourceActionRunning = false);
    }
  }

  void _restoreSourceActionDictationForRetry(RemoteAppStore store) {
    final retained = store.retainedDictationFor(widget.sessionId);
    if (!mounted || retained == null || !_routeOriginIsCurrent(store)) return;
    setState(() {
      _retryDictationBytes = retained.bytes;
      _retryDictationSourceId = retained.sourceId;
      _retryDictationSessionId = widget.sessionId;
      _retryDictationDirectAudio = retained.directAudio;
      _retryDictationSubmitAfterFinish = false;
    });
  }

  Future<void> _interruptCurrentWork(
      RemoteAppStore store, String sessionId) async {
    if (_interruptingCurrentWork) return;
    setState(() => _interruptingCurrentWork = true);
    try {
      await store.interrupt(sessionId);
    } on Object catch (caught) {
      if (mounted) _showCompactError(context, 'Could not interrupt', caught);
    } finally {
      if (mounted) setState(() => _interruptingCurrentWork = false);
    }
  }

  Future<void> _openWallet(
    RemoteAppStore store,
    RemoteSession session,
    String? modelId,
    List<RemoteModel> models,
  ) async {
    final openingHostId = store.activeHost?.hostId;
    if (!_routeOriginIsCurrent(store) || session.hostId != openingHostId)
      return;
    final loaded = await store.loadWallet(
      session.providerId,
      modelId: modelId,
      force: true,
    );
    if (!mounted ||
        !_routeOriginIsCurrent(store) ||
        store.activeHost?.hostId != openingHostId) {
      return;
    }
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      constraints: const BoxConstraints(maxWidth: 680),
      builder: (sheetContext) => Padding(
        padding: EdgeInsets.only(
            bottom: MediaQuery.viewInsetsOf(sheetContext).bottom),
        child: _WalletSheet(
          store: store,
          openingHostId: openingHostId,
          sessionId: session.id,
          providerId: session.providerId,
          modelId: modelId,
          models: models,
          initial:
              loaded ?? store.walletDisplayFor(session.providerId, modelId),
        ),
      ),
    );
  }

  List<SessionProjectGroup> _existingPreparedProjectOptions(
      RemoteAppStore store) {
    final activeHostId = store.activeHost?.hostId;
    if (activeHostId == null && store.hosts.isNotEmpty) {
      return const <SessionProjectGroup>[];
    }
    return groupSessionsByProject(store.sessions.where((candidate) {
      if (store.isPreparedSession(candidate.id)) return false;
      if (activeHostId != null && candidate.hostId != activeHostId)
        return false;
      if (candidate.sessionKind == 'side_chat' ||
          candidate.sessionKind == 'internal' ||
          candidate.relationship?.kind == 'side_chat') {
        return false;
      }
      return isSelectableProjectDirectory(candidate.workingDirectory);
    }));
  }

  void _applyPreparedDirectory(
    RemoteAppStore store,
    RemoteSession session,
    String directory,
  ) {
    final selected = directory.trim();
    if (!isSelectableProjectDirectory(selected)) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text(
          'Choose a project folder in Documents or another user-owned location.',
        ),
      ));
      return;
    }
    store.updatePreparedDirectory(session.id, selected);
    setState(() => _preparedDirectory.text = selected);
  }

  Future<String?> _promptForAnotherPreparedFolder() async {
    final controller = TextEditingController();
    TransitionRoute<String>? dialogRoute;
    try {
      final result = await showDialog<String>(
        context: context,
        builder: (dialogContext) {
          dialogRoute ??= ModalRoute.of<String>(dialogContext);
          return AlertDialog(
            title: const Text('Another folder'),
            content: TextField(
              key: const Key('prepared-project-path-field'),
              controller: controller,
              autofocus: true,
              autocorrect: false,
              enableSuggestions: false,
              textInputAction: TextInputAction.done,
              onSubmitted: (value) {
                final directory = value.trim();
                if (directory.isNotEmpty) {
                  Navigator.pop(dialogContext, directory);
                }
              },
              decoration: const InputDecoration(
                labelText: 'Folder path',
                hintText: 'Choose a folder on your computer',
              ),
            ),
            actions: <Widget>[
              TextButton(
                style: TextButton.styleFrom(minimumSize: const Size(64, 44)),
                onPressed: () => Navigator.pop(dialogContext),
                child: const Text('Cancel'),
              ),
              FilledButton(
                key: const Key('prepared-project-use-folder'),
                style: FilledButton.styleFrom(minimumSize: const Size(64, 44)),
                onPressed: () {
                  final directory = controller.text.trim();
                  if (directory.isNotEmpty) {
                    Navigator.pop(dialogContext, directory);
                  }
                },
                child: const Text('Use folder'),
              ),
            ],
          );
        },
      );
      await dialogRoute?.completed;
      return result;
    } finally {
      controller.dispose();
    }
  }

  Future<void> _showPreparedProjectPicker(
    RemoteAppStore store,
    RemoteSession session,
  ) async {
    if (_preparedProjectPickerOpen || !mounted) return;
    setState(() => _preparedProjectPickerOpen = true);
    final restoreComposerFocus = _composerFocus.hasFocus;
    try {
      final groups = _existingPreparedProjectOptions(store);
      final selectedKey = normalizeProjectDirectory(_preparedDirectory.text);
      final basenameCounts = <String, int>{};
      for (final group in groups) {
        final name = group.name.toLowerCase();
        basenameCounts[name] = (basenameCounts[name] ?? 0) + 1;
      }
      TransitionRoute<Object?>? sheetRoute;
      final choice = await showModalBottomSheet<Object?>(
        context: context,
        useSafeArea: true,
        showDragHandle: true,
        isScrollControlled: true,
        constraints: const BoxConstraints(maxWidth: 640),
        builder: (sheetContext) {
          sheetRoute ??= ModalRoute.of<Object?>(sheetContext);
          return ConstrainedBox(
            key: const Key('prepared-project-picker'),
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(sheetContext).height * .72,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 0, 8, 4),
                  child: Row(
                    children: <Widget>[
                      Expanded(
                        child: Text(
                          'Choose project',
                          style: Theme.of(sheetContext).textTheme.titleMedium,
                        ),
                      ),
                      SizedBox.square(
                        dimension: 44,
                        child: IconButton(
                          key: const Key('prepared-project-picker-cancel'),
                          tooltip: 'Close project picker',
                          onPressed: () => Navigator.pop(sheetContext),
                          icon: const Icon(Icons.close_rounded, size: 22),
                        ),
                      ),
                    ],
                  ),
                ),
                if (groups.isNotEmpty)
                  Flexible(
                    child: ListView.separated(
                      shrinkWrap: true,
                      itemCount: groups.length,
                      separatorBuilder: (_, __) => const Divider(height: 1),
                      itemBuilder: (context, index) {
                        final group = groups[index];
                        final normalized =
                            normalizeProjectDirectory(group.directory);
                        final duplicate =
                            basenameCounts[group.name.toLowerCase()]! > 1;
                        return ListTile(
                          key: ValueKey<String>(
                              'prepared-project-option-${group.key}'),
                          minVerticalPadding: 8,
                          leading: const Icon(Icons.folder_rounded, size: 22),
                          title: Text(
                            group.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          subtitle: duplicate
                              ? Text(
                                  group.directory,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                )
                              : null,
                          trailing: normalized == selectedKey
                              ? const Icon(Icons.check_rounded, size: 21)
                              : null,
                          onTap: () =>
                              Navigator.pop(sheetContext, group.directory),
                        );
                      },
                    ),
                  ),
                const Divider(height: 1),
                ListTile(
                  key: const Key('prepared-project-another-folder'),
                  minVerticalPadding: 8,
                  leading:
                      const Icon(Icons.create_new_folder_outlined, size: 22),
                  title: const Text('Another folder…'),
                  onTap: () => Navigator.pop(
                    sheetContext,
                    _PreparedProjectChoice.anotherFolder,
                  ),
                ),
              ],
            ),
          );
        },
      );
      await sheetRoute?.completed;
      if (!mounted || !_routeOriginIsCurrent(store)) return;
      if (choice is String) {
        _applyPreparedDirectory(store, session, choice);
      } else if (choice == _PreparedProjectChoice.anotherFolder) {
        final directory = await _promptForAnotherPreparedFolder();
        if (!mounted || !_routeOriginIsCurrent(store) || directory == null) {
          return;
        }
        _applyPreparedDirectory(store, session, directory);
      }
    } finally {
      if (mounted) {
        setState(() => _preparedProjectPickerOpen = false);
      } else {
        _preparedProjectPickerOpen = false;
      }
      if (restoreComposerFocus && mounted) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _composerFocus.requestFocus();
        });
      }
    }
  }

  bool get _dictationBlocksPop =>
      _recordingDictation ||
      _transcribingDictation ||
      _dictationCommitOperation != null ||
      _retryDictationBytes != null;

  Future<void> _resolveBlockedSessionPop() async {
    if (_forceSessionPop) return;
    _forceSessionPop = true;
    try {
      if (_recordingDictation) {
        await _finishDictation();
      } else if (_transcribingDictation) {
        _cancelDictationProcessing();
        if (_retryDictationBytes == null) await _dictationCommitOperation;
      } else {
        await _dictationCommitOperation;
      }
      if (!mounted) return;
      if (_retryDictationBytes != null) {
        final discard = await showDialog<bool>(
              context: context,
              builder: (dialogContext) => AlertDialog(
                title: const Text('Discard saved recording?'),
                content: const Text(
                    'This recording has not been added to the message yet.'),
                actions: <Widget>[
                  TextButton(
                    onPressed: () => Navigator.pop(dialogContext, false),
                    child: const Text('Keep editing'),
                  ),
                  FilledButton(
                    onPressed: () => Navigator.pop(dialogContext, true),
                    child: const Text('Discard'),
                  ),
                ],
              ),
            ) ??
            false;
        if (!mounted || !discard) return;
        setState(_clearRetainedDictation);
        await StoreScope.read(context).clearRetainedDictation(widget.sessionId);
      }
      if (!mounted) return;
      setState(() => _allowSessionPop = true);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) Navigator.of(context).pop();
      });
    } finally {
      if (mounted) _forceSessionPop = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    if (!_routeOriginCaptured) {
      _routeHostId = store.activeHost?.hostId;
      _routeOriginCaptured = true;
    }
    if (!_routeOriginIsCurrent(store)) {
      _scheduleStaleRouteDismiss();
      return const SizedBox.shrink();
    }
    final session = _routeSession(store);
    final preparedSession =
        session != null && store.isPreparedSession(session.id);
    if (preparedSession && _preparedDirectory.text.isEmpty) {
      _preparedDirectory.text = session.workingDirectory ?? '';
    }
    final visual =
        providerVisualThemeFor(session?.providerId ?? store.selectedProviderId);
    final sessionContext =
        session == null ? null : store.contextBySession[session.id];
    final sessionGoal =
        session == null ? null : store.goalsBySession[session.id];
    final dictationSource = session == null
        ? null
        : store.dictationSourceForHarness(session.providerId);
    final dictationTooltip = _recordingDictation
        ? (_directAudioDictation ? 'Stop recording' : 'Stop and transcribe')
        : _transcribingDictation
            ? (_directAudioDictation
                ? 'Preparing saved recording'
                : 'Transcribing saved recording')
            : _retryDictationBytes != null
                ? 'Retry the saved recording without speaking again'
                : store.preferredDictationSourceIdForHarness(
                            session?.providerId ?? store.selectedProviderId) ==
                        directAudioDictationSourceId
                    ? 'Start audio recording'
                    : dictationSource == null
                        ? 'Choose a dictation service'
                        : 'Start dictation with ${dictationSource.label}';
    final dictationStatusText = _dictationStatusText();
    final modelOptions = session == null
        ? const <RemoteModel>[]
        : store.modelsByProvider[session.providerId] ?? const <RemoteModel>[];
    final sessionWorking = session?.state == 'working' ||
        store.liveAssistantMessageFor(widget.sessionId) != null;
    final mediaSize = MediaQuery.sizeOf(context);
    final mediaQuery = MediaQuery.of(context);
    final conversationLayoutRevision = Object.hash(
      mediaSize.width,
      mediaSize.height,
      mediaQuery.viewInsets.bottom,
      mediaQuery.padding.top,
      mediaQuery.padding.bottom,
      mediaQuery.textScaler.scale(16),
    );
    final compactImeLandscape = MediaQuery.viewInsetsOf(context).bottom > 0 &&
        mediaSize.width > mediaSize.height;
    final compactConversationHeader = mediaSize.height < 520;
    final configuredModel =
        modelOptions.where((model) => model.id == _selectedModelId).firstOrNull;
    final runtimeModel =
        modelOptions.where((model) => model.id == session?.modelId).firstOrNull;
    final metadataModel = (sessionWorking ? runtimeModel : configuredModel) ??
        modelOptions.where((model) => model.isDefault).firstOrNull ??
        modelOptions.firstOrNull;
    final reasoningEfforts =
        metadataModel?.reasoningEfforts ?? const <ReasoningEffortOption>[];
    final modelSelectionSupported =
        session != null && _supportsTurnModelSelection(session.providerId);
    final displayedModelId = sessionWorking
        ? session?.modelId
        : _selectedModelId ?? session?.modelId ?? metadataModel?.id;
    final displayedModelLabel = sessionWorking
        ? runtimeModel?.displayName ?? session?.modelId ?? 'Model'
        : configuredModel?.displayName ??
            metadataModel?.displayName ??
            session?.modelId ??
            'Model';
    final displayedReasoningEffort = _resolveReasoningEffort(
      session: session,
      selectedEffort: _selectedReasoningEffort,
      displayedModelId: displayedModelId,
      model: metadataModel,
      sessionWorking: sessionWorking,
    );
    final displayedReasoningLabel = displayedReasoningEffort == null
        ? ''
        : _effortDisplayLabel(
            displayedReasoningEffort, displayedModelId, session?.providerId);
    final contextCompacting = sessionContext?.isCompacting == true;
    final wallet = session == null
        ? null
        : store.walletDisplayFor(session.providerId, displayedModelId);
    if (session != null && !preparedSession) {
      final walletLoadKey =
          '${session.providerId}\u0000${displayedModelId ?? ''}';
      if (_walletLoadedFor != walletLoadKey) {
        _walletLoadedFor = walletLoadKey;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || _walletLoadedFor != walletLoadKey) return;
          unawaited(
              store.loadWallet(session.providerId, modelId: displayedModelId));
        });
      }
    }
    final imageAttachmentSupported =
        session != null && _supportsImageAttachments(session.providerId);
    final scaledComposerTextExtra =
        (MediaQuery.textScalerOf(context).scale(16) - 16).clamp(0.0, 24.0);
    final minimumComposerTextHeight =
        (compactImeLandscape ? 44.0 : _minimumComposerTextHeight) +
            scaledComposerTextExtra;
    final minimumComposerHeight = _composerActionRowHeight +
        minimumComposerTextHeight +
        _composerBorderInset;
    final composerMaxHeight = compactImeLandscape
        ? minimumComposerHeight
        : ((mediaSize.height * .4) -
                (_attachments.isNotEmpty ? _attachmentLaneHeight : 0))
            .clamp(minimumComposerHeight, 360.0)
            .toDouble();
    final steeringSupported =
        session != null && store.providerSupportsSteering(session.providerId);
    final steeringAvailable = sessionWorking && steeringSupported;
    final deliveryMode = !store.isQueueingEnabledFor(widget.sessionId)
        ? steeringAvailable
            ? 'steer'
            : 'send'
        : _deliveryMode == 'steer' && steeringAvailable
            ? 'steer'
            : 'queue';
    final queuedMessages = store.queuedMessagesFor(widget.sessionId);
    final delegationTasks = store.delegationsFor(widget.sessionId);
    final messageEditingAvailable = session != null &&
        (session.state == 'idle' ||
            session.state == 'completed' ||
            session.state == 'failed') &&
        store.providerSupportsMessageEditing(session.providerId);
    final childSessions = store.childSessionsFor(widget.sessionId);
    final branchRelations = session == null
        ? const <_BranchRelation>[]
        : <_BranchRelation>[
            if (session.relationship?.kind == 'branch')
              for (final source in store.sessions.where((candidate) =>
                  candidate.id == session.relationship?.sourceSessionId))
                _BranchRelation(source, 'Branched from ${source.title}'),
            for (final target in store.sessions.where((candidate) =>
                candidate.relationship?.kind == 'branch' &&
                candidate.relationship?.sourceSessionId == session.id))
              _BranchRelation(target, 'Branched to ${target.title}'),
          ];
    final history = store.messages[widget.sessionId] ?? const <RemoteMessage>[];
    final liveAssistant = store.liveAssistantMessageFor(widget.sessionId);
    final presentedHistory =
        _messagesWithMeshPresentations(history, delegationTasks);
    final identityMessages = <RemoteMessage>[
      ...presentedHistory,
      if (liveAssistant != null) liveAssistant,
    ];
    final shimmeringReasoningMessage = sessionWorking
        ? <RemoteMessage>[
            ...presentedHistory,
            if (liveAssistant != null) liveAssistant,
          ]
            .reversed
            .where((message) =>
                message.status == 'streaming' &&
                message.role.toLowerCase() == 'assistant' &&
                message.parts.any((part) =>
                    _assistantTextTone(part, false) ==
                    _AssistantTextTone.privateReasoning))
            .firstOrNull
        : null;
    final liveEvents = (store.events[widget.sessionId] ?? const <AgentEvent>[])
        .where((event) =>
            _showsConversationEvent(event.type) &&
            !_eventHasStructuredSubagent(event))
        .toList(growable: false);
    final activityGroups = _groupConversationActivity(liveEvents);
    final conversationItems = _conversationTimelineItems(
      identityMessages,
      activityGroups,
      delegationTasks,
      sessionWorking,
    );
    final sessionApprovals = store.approvals.values
        .where((approval) =>
            approval.sessionId == widget.sessionId && !approval.isExpired())
        .toList();
    final inputRequests = store.userInputs.values
        .where((request) => request.sessionId == widget.sessionId)
        .toList();
    final itemCount = conversationItems.length +
        sessionApprovals.length +
        inputRequests.length +
        (contextCompacting ? 1 : 0);
    final conversationPresentationRevision = Object.hash(
      _messagePresentationRevision(identityMessages),
      Object.hashAll(liveEvents.map((event) => Object.hash(
            event.eventId,
            event.sequence,
            event.type,
            _presentationFingerprint(event.payload),
          ))),
      Object.hashAll(sessionApprovals.map((approval) => approval.requestId)),
      Object.hashAll(inputRequests.map((request) => request.requestId)),
      Object.hashAll(delegationTasks.map((task) => Object.hash(
            task.id,
            task.state,
            task.createdAt,
            task.error,
            task.orchestration,
            task.parentTurnId,
            Object.hashAll(task.targets.map((target) => Object.hash(
                  target.providerId,
                  target.modelId,
                  target.reasoningEffort,
                ))),
            Object.hashAll(task.presentationSegments.map((segment) =>
                Object.hash(segment.type, segment.text, segment.targetIndex))),
            Object.hashAll(task.children.map((child) => Object.hash(
                  child.id,
                  child.sessionId,
                  child.providerId,
                  child.modelId,
                  child.reasoningEffort,
                  child.state,
                  child.error,
                ))),
          ))),
      contextCompacting,
      sessionContext?.compactionKind,
    );
    final layoutChanged = _lastConversationLayoutRevision != null &&
        _lastConversationLayoutRevision != conversationLayoutRevision;
    final presentationChanged = _lastConversationPresentationRevision != null &&
        _lastConversationPresentationRevision !=
            conversationPresentationRevision;
    _lastConversationLayoutRevision = conversationLayoutRevision;
    _lastConversationPresentationRevision = conversationPresentationRevision;
    if (layoutChanged || presentationChanged) {
      _preserveReaderAnchorAcrossNextLayout();
    }
    final sessionHistoryLoading =
        store.isSessionHistoryLoading(widget.sessionId);
    final hasHistoryLoader = store.hasOlderHistory(widget.sessionId) ||
        store.isOlderHistoryLoading(widget.sessionId) ||
        _historyLoadError != null;
    final showHistoryList =
        itemCount > 0 || (!sessionHistoryLoading && hasHistoryLoader);
    final emptyHistoryError = !showHistoryList && !sessionHistoryLoading
        ? _historyLoadError ?? store.error
        : null;
    return Theme(
      data: buildRemoteTheme(visual),
      child: Builder(
        builder: (context) => PopScope<void>(
          canPop: _allowSessionPop || !_dictationBlocksPop,
          onPopInvokedWithResult: (didPop, _) {
            if (!didPop) unawaited(_resolveBlockedSessionPop());
          },
          child: Scaffold(
            resizeToAvoidBottomInset: false,
            appBar: AppBar(
              toolbarHeight: compactImeLandscape
                  ? 0
                  : (compactConversationHeader ? 48 : 58),
              automaticallyImplyLeading: !compactImeLandscape,
              leadingWidth: compactImeLandscape ? 0 : 44,
              leading: compactImeLandscape
                  ? null
                  : IconButton(
                      tooltip: 'Back',
                      onPressed: () => Navigator.maybePop(context),
                      icon: const Icon(Icons.chevron_left_rounded, size: 30),
                    ),
              titleSpacing: 2,
              title: compactImeLandscape
                  ? null
                  : Text(
                      session == null
                          ? 'Session'
                          : _sessionDisplayTitle(session),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleLarge?.copyWith(
                            fontSize: 19,
                            fontWeight: FontWeight.w600,
                          ),
                    ),
              actions: compactImeLandscape
                  ? const <Widget>[]
                  : <Widget>[
                      if (session != null && !preparedSession)
                        _SessionContextButton(
                          context: sessionContext,
                          visual: visual,
                          onTap: () => unawaited(
                              _openContextControls(store, session, visual)),
                        ),
                      if (childSessions.isNotEmpty)
                        _ChildAgentsAppBarButton(
                          count: childSessions.length,
                          visual: visual,
                          onPressed: _showChildSessions,
                        ),
                      if (session != null &&
                          _showsConversationState(session.state))
                        Padding(
                          padding: const EdgeInsets.only(left: 6, right: 2),
                          child: _ConversationStateIndicator(
                              state: session.state, visual: visual),
                        ),
                      if (session != null)
                        PopupMenuButton<String>(
                          key: const Key('session-actions-menu'),
                          tooltip: 'Session actions',
                          position: PopupMenuPosition.under,
                          onSelected: (value) {
                            switch (value) {
                              case 'task-details':
                                unawaited(_showTaskDetails(session, visual));
                                break;
                              case 'context-handoff':
                                unawaited(_runSourceSessionAction(store,
                                    session, _SourceSessionAction.handoff));
                                break;
                              case 'branch':
                                unawaited(_runSourceSessionAction(store,
                                    session, _SourceSessionAction.branch));
                                break;
                              case 'open-desktop':
                                unawaited(
                                    showDesktopWakeDialog(context, store));
                                break;
                              case 'ears-settings':
                                unawaited(_openEarsSettings());
                                break;
                              case 'goal-settings':
                                unawaited(
                                    _showGoalControls(store, session, visual));
                                break;
                              case 'eyes-settings':
                                unawaited(_chooseVisionProxy());
                                break;
                            }
                          },
                          itemBuilder: (_) => <PopupMenuEntry<String>>[
                            const PopupMenuItem<String>(
                              key: Key('session-task-details'),
                              value: 'task-details',
                              child: Row(
                                children: <Widget>[
                                  Icon(Icons.info_outline_rounded, size: 19),
                                  SizedBox(width: 10),
                                  Expanded(child: Text('Task details')),
                                ],
                              ),
                            ),
                            const PopupMenuDivider(),
                            PopupMenuItem<String>(
                              key: const Key('session-context-handoff'),
                              value: 'context-handoff',
                              enabled: !_sourceActionRunning &&
                                  store.connectionState ==
                                      BridgeConnectionState.online,
                              child: const Row(
                                children: <Widget>[
                                  Icon(Icons.move_up_rounded, size: 19),
                                  SizedBox(width: 10),
                                  Expanded(child: Text('Context Handoff')),
                                ],
                              ),
                            ),
                            PopupMenuItem<String>(
                              key: const Key('session-branch-new-task'),
                              value: 'branch',
                              enabled: !_sourceActionRunning &&
                                  store.connectionState ==
                                      BridgeConnectionState.online,
                              child: const Row(
                                children: <Widget>[
                                  Icon(Icons.call_split_rounded, size: 19),
                                  SizedBox(width: 10),
                                  Expanded(child: Text('Branch in New Task')),
                                ],
                              ),
                            ),
                            const PopupMenuDivider(),
                            PopupMenuItem<String>(
                              key: const Key('session-goal-settings'),
                              value: 'goal-settings',
                              enabled: !preparedSession,
                              child: Row(
                                children: <Widget>[
                                  const Icon(Icons.track_changes_outlined,
                                      size: 19),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: Text(sessionGoal == null
                                        ? 'Goal'
                                        : 'Goal: ${sessionGoal.status}'),
                                  ),
                                ],
                              ),
                            ),
                            const PopupMenuItem<String>(
                              key: Key('session-ears-settings'),
                              value: 'ears-settings',
                              child: Row(
                                children: <Widget>[
                                  Icon(Icons.graphic_eq_rounded, size: 19),
                                  SizedBox(width: 10),
                                  Expanded(child: Text('EARS settings')),
                                ],
                              ),
                            ),
                            PopupMenuItem<String>(
                              key: const Key('session-eyes-settings'),
                              value: 'eyes-settings',
                              enabled: !preparedSession && !sessionWorking,
                              child: const Row(
                                children: <Widget>[
                                  Icon(Icons.visibility_outlined, size: 19),
                                  SizedBox(width: 10),
                                  Expanded(child: Text('EYES settings')),
                                ],
                              ),
                            ),
                            PopupMenuItem<String>(
                              key: const Key('session-open-desktop'),
                              value: 'open-desktop',
                              enabled: store.connectionState ==
                                  BridgeConnectionState.online,
                              child: const Row(
                                children: <Widget>[
                                  Icon(Icons.desktop_windows_outlined,
                                      size: 19),
                                  SizedBox(width: 10),
                                  Expanded(child: Text('Open on PC')),
                                ],
                              ),
                            ),
                          ],
                          icon: const Icon(Icons.more_horiz_rounded),
                        ),
                    ],
            ),
            body: _AdaptivePage(
                insetKey: const Key('session-ime-inset-owner'),
                bottomInset: mediaQuery.viewInsets.bottom,
                maxWidth: 900,
                child: LayoutBuilder(
                  builder: (context, viewportConstraints) => Column(
                    children: <Widget>[
                      SizedBox(
                        height: _sessionHistoryProgressHeight,
                        child: sessionHistoryLoading
                            ? LinearProgressIndicator(
                                key: const Key('session-history-loading'),
                                minHeight: 1,
                                color: visual.accent,
                                backgroundColor:
                                    visual.border.withValues(alpha: 0.3),
                              )
                            : const SizedBox.expand(),
                      ),
                      if (session != null && preparedSession)
                        Material(
                          color: visual.background,
                          child: InkWell(
                            key: const Key('prepared-project-selector'),
                            onTap: _preparedProjectPickerOpen
                                ? null
                                : () => unawaited(
                                      _showPreparedProjectPicker(
                                          store, session),
                                    ),
                            child: Semantics(
                              button: true,
                              label: 'Project',
                              value: _preparedDirectory.text.trim().isEmpty
                                  ? 'Choose project'
                                  : _preparedDirectory.text.trim(),
                              child: Container(
                                key: const Key('prepared-project-current'),
                                constraints:
                                    const BoxConstraints(minHeight: 52),
                                padding: EdgeInsets.fromLTRB(
                                  16,
                                  compactConversationHeader ? 6 : 7,
                                  12,
                                  compactConversationHeader ? 6 : 7,
                                ),
                                decoration: BoxDecoration(
                                  border: Border(
                                    bottom: BorderSide(
                                      color:
                                          visual.border.withValues(alpha: 0.72),
                                    ),
                                  ),
                                ),
                                child: Row(
                                  children: <Widget>[
                                    const Icon(Icons.folder_rounded, size: 22),
                                    const SizedBox(width: 11),
                                    Expanded(
                                      child: Column(
                                        mainAxisSize: MainAxisSize.min,
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: <Widget>[
                                          Text(
                                            _preparedDirectory.text
                                                    .trim()
                                                    .isEmpty
                                                ? 'Choose project'
                                                : projectDirectoryName(
                                                    _preparedDirectory.text),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: Theme.of(context)
                                                .textTheme
                                                .bodyMedium
                                                ?.copyWith(
                                                  fontWeight: FontWeight.w600,
                                                ),
                                          ),
                                          if (!compactConversationHeader &&
                                              _preparedDirectory.text
                                                  .trim()
                                                  .isNotEmpty)
                                            Text(
                                              _preparedDirectory.text.trim(),
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                              style: Theme.of(context)
                                                  .textTheme
                                                  .bodySmall
                                                  ?.copyWith(
                                                    color: Theme.of(context)
                                                        .colorScheme
                                                        .onSurfaceVariant,
                                                  ),
                                            ),
                                        ],
                                      ),
                                    ),
                                    const SizedBox(width: 8),
                                    const Icon(Icons.expand_more_rounded,
                                        size: 22),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        ),
                      if (branchRelations.isNotEmpty)
                        _BranchRelationshipBanner(
                          relations: branchRelations,
                          onOpen: (relation) => _openSessionAfterPress(
                            context: context,
                            store: store,
                            session: relation.session,
                          ),
                        ),
                      if (session != null &&
                          store.handoffSummaries[session.id]?.isNotEmpty ==
                              true)
                        _HandoffSummaryBanner(
                          summary: store.handoffSummaries[session.id]!,
                          sourceTitle: store.sessions
                              .where((candidate) =>
                                  candidate.id ==
                                  session.relationship?.sourceSessionId)
                              .firstOrNull
                              ?.title,
                        ),
                      Expanded(
                        child: Stack(
                          children: <Widget>[
                            !showHistoryList
                                ? sessionHistoryLoading
                                    ? const Center(
                                        child: Text('Loading messages…'))
                                    : emptyHistoryError != null
                                        ? _SessionHistoryError(
                                            message: emptyHistoryError,
                                            onRetry: session == null
                                                ? null
                                                : () {
                                                    setState(() =>
                                                        _historyLoadError =
                                                            null);
                                                    store.openSessionForView(
                                                        session);
                                                  },
                                          )
                                        : const Center(
                                            child: Text('No messages yet.'))
                                : SizedBox.expand(
                                    key: _conversationViewportKey,
                                    child: Listener(
                                      onPointerDown:
                                          _handleConversationPointerDown,
                                      onPointerUp:
                                          _handleConversationPointerEnd,
                                      onPointerCancel:
                                          _handleConversationPointerEnd,
                                      child: NotificationListener<
                                          ScrollNotification>(
                                        onNotification:
                                            _handleConversationScrollNotification,
                                        child: ListView.builder(
                                          controller: _scrollController,
                                          keyboardDismissBehavior:
                                              ScrollViewKeyboardDismissBehavior
                                                  .onDrag,
                                          padding: const EdgeInsets.fromLTRB(
                                              12, 10, 12, 14),
                                          itemCount: itemCount +
                                              (hasHistoryLoader ? 1 : 0),
                                          itemBuilder: (context, index) {
                                            if (hasHistoryLoader &&
                                                index == 0) {
                                              return Padding(
                                                key: _timelineKeys.putIfAbsent(
                                                    'history-loader',
                                                    GlobalKey.new),
                                                padding: const EdgeInsets.only(
                                                    bottom: 8),
                                                child: SizedBox(
                                                  height: 48,
                                                  child: Center(
                                                    child: store
                                                            .isOlderHistoryLoading(
                                                                widget
                                                                    .sessionId)
                                                        ? Semantics(
                                                            liveRegion: true,
                                                            label:
                                                                'Loading earlier messages',
                                                            child:
                                                                SizedBox.square(
                                                              dimension: 18,
                                                              child:
                                                                  CircularProgressIndicator(
                                                                      strokeWidth:
                                                                          2),
                                                            ),
                                                          )
                                                        : Tooltip(
                                                            message:
                                                                _historyLoadError ??
                                                                    'Load earlier messages',
                                                            child: TextButton(
                                                              onPressed: () =>
                                                                  unawaited(
                                                                      _loadOlderHistory()),
                                                              child: Text(_historyLoadError ==
                                                                      null
                                                                  ? 'Load earlier messages'
                                                                  : 'Retry earlier messages'),
                                                            ),
                                                          ),
                                                  ),
                                                ),
                                              );
                                            }
                                            if (hasHistoryLoader) index -= 1;
                                            if (index <
                                                conversationItems.length) {
                                              final item =
                                                  conversationItems[index];
                                              final spawnedSubagent =
                                                  item.spawnedSubagent;
                                              if (spawnedSubagent != null) {
                                                return _withTurnBoundarySpacing(
                                                  items: conversationItems,
                                                  index: index,
                                                  child: _SpawnedSubagentRow(
                                                    key: _timelineKeys.putIfAbsent(
                                                        'spawned-subagent:${spawnedSubagent.id}',
                                                        GlobalKey.new),
                                                    entry: spawnedSubagent,
                                                    visual: visual,
                                                    onTap: () => unawaited(
                                                      _openDelegationChild(
                                                        store,
                                                        spawnedSubagent
                                                            .childSessionId,
                                                      ),
                                                    ),
                                                  ),
                                                );
                                              }
                                              if (item.reasoningSegments
                                                  .isNotEmpty) {
                                                final firstMessageIndex =
                                                    item.firstMessageIndex;
                                                return _withTurnBoundarySpacing(
                                                  items: conversationItems,
                                                  index: index,
                                                  child: _MessageReasoningSpan(
                                                    key: _timelineKeys.putIfAbsent(
                                                        'reasoning:${_reasoningAnchorIdentity(item)}',
                                                        GlobalKey.new),
                                                    id: item.id,
                                                    segments:
                                                        item.reasoningSegments,
                                                    visual: visual,
                                                    providerId:
                                                        session?.providerId ??
                                                            visual.providerId,
                                                    showIdentity: firstMessageIndex !=
                                                            null &&
                                                        _shouldShowAssistantIdentity(
                                                            identityMessages,
                                                            firstMessageIndex),
                                                    working: item.working,
                                                    displayMode: store
                                                                .reasoningDisplayMode ==
                                                            'expanded'
                                                        ? _ReasoningDisplayMode
                                                            .expanded
                                                        : _ReasoningDisplayMode
                                                            .compact,
                                                  ),
                                                );
                                              }
                                              final message = item.message!;
                                              final messageIndex =
                                                  item.firstMessageIndex;
                                              final sourceMessage =
                                                  messageIndex == null
                                                      ? null
                                                      : identityMessages[
                                                          messageIndex];
                                              final isLiveMessage =
                                                  item.working;
                                              final canEdit = !isLiveMessage &&
                                                  messageEditingAvailable &&
                                                  sourceMessage?.editable ==
                                                      true;
                                              final hasMessageActions =
                                                  sourceMessage != null &&
                                                      (canEdit ||
                                                          _copyableMessageText(
                                                                  sourceMessage)
                                                              .isNotEmpty);
                                              return _withTurnBoundarySpacing(
                                                items: conversationItems,
                                                index: index,
                                                child: _MessageCard(
                                                  key:
                                                      _timelineKeys.putIfAbsent(
                                                          'message:${item.id}',
                                                          GlobalKey.new),
                                                  message: message,
                                                  visual: visual,
                                                  providerId:
                                                      session?.providerId ??
                                                          visual.providerId,
                                                  showIdentity: messageIndex !=
                                                          null &&
                                                      _shouldShowAssistantIdentity(
                                                          identityMessages,
                                                          messageIndex),
                                                  streaming: isLiveMessage ||
                                                      message.status ==
                                                          'streaming',
                                                  shimmerPrivateReasoning: message
                                                          .id ==
                                                      shimmeringReasoningMessage
                                                          ?.id,
                                                  showFinalBoundary: item
                                                          .showFinalBoundary ||
                                                      (messageIndex != null &&
                                                          _finalFollowsAssistantArtifacts(
                                                              identityMessages,
                                                              messageIndex)),
                                                  editEnabled: canEdit,
                                                  onLongPress: hasMessageActions
                                                      ? () => unawaited(
                                                          _openMessageActions(
                                                              sourceMessage,
                                                              visual,
                                                              editEnabled:
                                                                  canEdit))
                                                      : null,
                                                ),
                                              );
                                            }
                                            var cursor = index -
                                                conversationItems.length;
                                            if (cursor <
                                                sessionApprovals.length)
                                              return KeyedSubtree(
                                                key: _timelineKeys.putIfAbsent(
                                                    'approval:${sessionApprovals[cursor].requestId}',
                                                    GlobalKey.new),
                                                child: _ApprovalCard(
                                                    approval: sessionApprovals[
                                                        cursor]),
                                              );
                                            cursor -= sessionApprovals.length;
                                            if (cursor < inputRequests.length) {
                                              return KeyedSubtree(
                                                key: _timelineKeys.putIfAbsent(
                                                    'input:${inputRequests[cursor].requestId}',
                                                    GlobalKey.new),
                                                child: _UserInputCard(
                                                    request:
                                                        inputRequests[cursor]),
                                              );
                                            }
                                            cursor -= inputRequests.length;
                                            return KeyedSubtree(
                                              key: _timelineKeys.putIfAbsent(
                                                  'compaction-progress',
                                                  GlobalKey.new),
                                              child: _CompactionProgressRow(
                                                compactionKind: sessionContext
                                                    ?.compactionKind,
                                              ),
                                            );
                                          },
                                        ),
                                      ),
                                    ),
                                  ),
                            if (_showJumpToLatest)
                              Positioned(
                                right: 10,
                                bottom: 10,
                                child: Material(
                                  color: visual.surface.withValues(alpha: 0.94),
                                  shape: const CircleBorder(),
                                  child: IconButton(
                                    key: const Key('jump-to-latest'),
                                    tooltip: 'Jump to latest',
                                    onPressed: _jumpToLatest,
                                    icon: Icon(
                                      Icons.keyboard_arrow_down_rounded,
                                      color: visual.accent,
                                    ),
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                      ConstrainedBox(
                        constraints: BoxConstraints(
                          maxHeight: math.max(
                            0,
                            viewportConstraints.maxHeight -
                                _sessionHistoryProgressHeight,
                          ),
                        ),
                        child: SafeArea(
                          top: false,
                          child: SingleChildScrollView(
                            key: const Key('session-composer-dock-scroll'),
                            reverse: true,
                            child: DecoratedBox(
                              decoration: BoxDecoration(
                                color: visual.background,
                                border: Border(
                                    top: BorderSide(
                                        color: visual.border
                                            .withValues(alpha: 0.72))),
                              ),
                              child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: <Widget>[
                                  if (_slashCommandPaletteVisible)
                                    _SlashCommandPalette(
                                      commands:
                                          _slashCommandSuggestions ?? const [],
                                      selectedIndex: _slashCommandSelection,
                                      visual: visual,
                                      onSelected: _activateSlashCommand,
                                    ),
                                  if (_attachments.isNotEmpty)
                                    SizedBox(
                                      key: const Key(
                                          'session-composer-attachment-lane'),
                                      height: _attachmentLaneHeight,
                                      child: ListView.separated(
                                        padding: const EdgeInsets.fromLTRB(
                                            10, 2, 10, 2),
                                        scrollDirection: Axis.horizontal,
                                        itemCount: _attachments.length,
                                        separatorBuilder: (_, __) =>
                                            const SizedBox(width: 6),
                                        itemBuilder: (context, index) {
                                          final file = _attachments[index];
                                          return Semantics(
                                            key: ValueKey<String>(
                                                'session-attachment-chip-${file.name}-$index'),
                                            label: 'Attachment: ${file.name}',
                                            child: InputChip(
                                              avatar: file.mimeType
                                                      .startsWith('audio/')
                                                  ? AudioChipPlayToggle(
                                                      key: ValueKey<String>(
                                                          'pending-audio-${file.name}'),
                                                      uri: file.dataUri,
                                                      mimeType: file.mimeType,
                                                      accent: visual.accent,
                                                    )
                                                  : file.mimeType
                                                          .startsWith('image/')
                                                      ? ClipRRect(
                                                          key: ValueKey<String>(
                                                              'pending-image-${file.name}'),
                                                          borderRadius:
                                                              BorderRadius
                                                                  .circular(3),
                                                          child:
                                                              _ExpandableMessageImage(
                                                            imageUri:
                                                                file.dataUri,
                                                            name: file.name,
                                                            width: 24,
                                                            height: 24,
                                                            fit: BoxFit.cover,
                                                            cacheWidth: 48,
                                                            fallback: const Icon(
                                                                Icons
                                                                    .broken_image_outlined,
                                                                size: 18),
                                                          ),
                                                        )
                                                      : const Icon(
                                                          Icons
                                                              .insert_drive_file_outlined,
                                                          size: 18),
                                              label: Text(file.name,
                                                  overflow:
                                                      TextOverflow.ellipsis),
                                              onDeleted: () => setState(() {
                                                _attachments.removeAt(index);
                                                store.setDraftAttachments(
                                                    widget.sessionId,
                                                    _attachments);
                                                if (_attachments.isEmpty) {
                                                  _imageModelNoticeId = null;
                                                }
                                              }),
                                            ),
                                          );
                                        },
                                      ),
                                    ),
                                  if (_imageModelNoticeId != null)
                                    _ImageModelNotice(
                                      modelName: modelOptions
                                              .where((model) =>
                                                  model.id ==
                                                  _imageModelNoticeId)
                                              .firstOrNull
                                              ?.displayName ??
                                          'This model',
                                      visual: visual,
                                      onDismiss: () {
                                        final modelId = _imageModelNoticeId;
                                        if (session != null &&
                                            modelId != null) {
                                          store.dismissImageModelNotice(
                                              session.providerId, modelId);
                                        }
                                        setState(
                                            () => _imageModelNoticeId = null);
                                      },
                                    ),
                                  if (queuedMessages.isNotEmpty &&
                                      session != null)
                                    _QueuedInstructionStrip(
                                      messages: queuedMessages,
                                      visual: visual,
                                      onCancel: (message) => unawaited(store
                                          .cancelQueuedMessage(message.id)),
                                      onActions: (message) => unawaited(
                                          _openQueuedInstructionActions(
                                              store, session, message)),
                                    ),
                                  if (_simplifySettings != null &&
                                      _containsSimplifyCommand(_composer.text))
                                    _SimplifyComposerChip(
                                      settings: _simplifySettings!,
                                      visual: visual,
                                      onPressed: () =>
                                          unawaited(_openSimplifySettings()),
                                      onDeleted: _removeSimplify,
                                    ),
                                  if (store.earsBusyFor(widget.sessionId))
                                    Padding(
                                      padding: const EdgeInsets.fromLTRB(
                                          12, 4, 8, 2),
                                      child: Row(
                                        children: <Widget>[
                                          Expanded(
                                            child: Semantics(
                                              liveRegion: true,
                                              label: 'Transcribing dictation',
                                              child: ExcludeSemantics(
                                                child: Text(
                                                  'Transcribing dictation…',
                                                  key: const Key(
                                                      'ears-progress'),
                                                  style: Theme.of(context)
                                                      .textTheme
                                                      .bodySmall
                                                      ?.copyWith(
                                                        color: visual.accent,
                                                      ),
                                                ),
                                              ),
                                            ),
                                          ),
                                          TextButton(
                                            key: const Key(
                                                'cancel-ears-transcription'),
                                            onPressed: () => unawaited(store
                                                .cancelEars(widget.sessionId)),
                                            child: const Text(
                                                'Cancel transcription'),
                                          ),
                                        ],
                                      ),
                                    ),
                                  if (dictationStatusText != null)
                                    Padding(
                                      padding: const EdgeInsets.fromLTRB(
                                          12, 5, 10, 1),
                                      child: SizedBox(
                                        height: 40,
                                        child: Row(
                                          key: Key(_recordingDictation
                                              ? 'dictation-recording-status'
                                              : _transcribingDictation
                                                  ? 'dictation-processing-status'
                                                  : 'dictation-retry-status'),
                                          children: <Widget>[
                                            if (_transcribingDictation)
                                              SizedBox.square(
                                                dimension: 14,
                                                child:
                                                    CircularProgressIndicator(
                                                  strokeWidth: 1.8,
                                                  color: visual.accent,
                                                ),
                                              )
                                            else
                                              Icon(
                                                  _recordingDictation
                                                      ? Icons.mic_none_rounded
                                                      : Icons.replay_rounded,
                                                  size: 16,
                                                  color: visual.accent),
                                            const SizedBox(width: 7),
                                            Expanded(
                                              child: Semantics(
                                                liveRegion: true,
                                                label: dictationStatusText,
                                                child: ExcludeSemantics(
                                                  child: Text(
                                                    dictationStatusText,
                                                    maxLines: 2,
                                                    overflow:
                                                        TextOverflow.ellipsis,
                                                    style: Theme.of(context)
                                                        .textTheme
                                                        .bodySmall
                                                        ?.copyWith(
                                                          color: visual.accent,
                                                        ),
                                                  ),
                                                ),
                                              ),
                                            ),
                                            if (_recordingDictation)
                                              const SizedBox(
                                                  width: 44, height: 40)
                                            else if (_transcribingDictation)
                                              TextButton(
                                                key: const Key(
                                                    'cancel-dictation-processing'),
                                                onPressed: _cancellingDictation
                                                    ? null
                                                    : _cancelDictationProcessing,
                                                style: TextButton.styleFrom(
                                                  minimumSize:
                                                      const Size(44, 40),
                                                  tapTargetSize:
                                                      MaterialTapTargetSize
                                                          .shrinkWrap,
                                                ),
                                                child: Text(_cancellingDictation
                                                    ? 'Saving…'
                                                    : 'Cancel'),
                                              )
                                            else
                                              TextButton(
                                                key: const Key(
                                                    'discard-retained-dictation'),
                                                onPressed:
                                                    _discardRetainedDictation,
                                                style: TextButton.styleFrom(
                                                  minimumSize:
                                                      const Size(44, 40),
                                                  tapTargetSize:
                                                      MaterialTapTargetSize
                                                          .shrinkWrap,
                                                ),
                                                child: const Text('Discard'),
                                              ),
                                          ],
                                        ),
                                      ),
                                    ),
                                  if (_recordingDictation &&
                                      _directAudioDictation)
                                    ValueListenableBuilder<Duration>(
                                      valueListenable: _dictationElapsed,
                                      builder: (context, elapsed, _) =>
                                          ValueListenableBuilder<double>(
                                        valueListenable: _dictationLevel,
                                        builder: (context, level, _) =>
                                            RepaintBoundary(
                                          child: _DictationLiveTrace(
                                            level: level,
                                            elapsed: elapsed,
                                            visual: visual,
                                          ),
                                        ),
                                      ),
                                    ),
                                  Padding(
                                    padding: compactImeLandscape
                                        ? const EdgeInsets.fromLTRB(8, 2, 8, 2)
                                        : const EdgeInsets.fromLTRB(8, 7, 8, 9),
                                    child: Container(
                                      key: const Key('session-composer-shell'),
                                      constraints: BoxConstraints(
                                        maxHeight: composerMaxHeight,
                                      ),
                                      decoration: BoxDecoration(
                                        color: visual.surface,
                                        borderRadius: BorderRadius.circular(16),
                                      ),
                                      foregroundDecoration: BoxDecoration(
                                        borderRadius: BorderRadius.circular(16),
                                        border:
                                            Border.all(color: visual.border),
                                      ),
                                      clipBehavior: Clip.antiAlias,
                                      child: Column(
                                        mainAxisSize: MainAxisSize.min,
                                        children: <Widget>[
                                          ConstrainedBox(
                                            constraints: BoxConstraints(
                                              minHeight:
                                                  minimumComposerTextHeight,
                                              maxHeight: (composerMaxHeight -
                                                      _composerActionRowHeight -
                                                      _composerBorderInset)
                                                  .clamp(
                                                      minimumComposerTextHeight,
                                                      312.0)
                                                  .toDouble(),
                                            ),
                                            child: Focus(
                                              key: const Key(
                                                  'session-composer-key-handler'),
                                              canRequestFocus: false,
                                              skipTraversal: true,
                                              includeSemantics: false,
                                              onKeyEvent: _handleComposerKey,
                                              child: Semantics(
                                                key: const Key(
                                                    'session-composer-semantics'),
                                                label: 'Message composer',
                                                child: ValueListenableBuilder<
                                                    Duration>(
                                                  valueListenable:
                                                      _dictationElapsed,
                                                  builder: (context,
                                                          dictationElapsed,
                                                          _) =>
                                                      TextField(
                                                    key: const Key(
                                                        'session-composer'),
                                                    controller: _composer,
                                                    focusNode: _composerFocus,
                                                    spellCheckConfiguration:
                                                        const SpellCheckConfiguration
                                                            .disabled(),
                                                    readOnly:
                                                        _preparingSubmission,
                                                    minLines: 1,
                                                    maxLines: null,
                                                    scrollPhysics:
                                                        const ClampingScrollPhysics(),
                                                    onChanged: (value) =>
                                                        _onComposerChanged(
                                                            store, value),
                                                    decoration: InputDecoration(
                                                      hintText: _composerHint(
                                                          store,
                                                          dictationElapsed),
                                                      hintMaxLines: 1,
                                                      hintStyle: TextStyle(
                                                        color: Theme.of(context)
                                                            .colorScheme
                                                            .onSurface
                                                            .withValues(
                                                                alpha: 0.48),
                                                        overflow: TextOverflow
                                                            .ellipsis,
                                                      ),
                                                      border: InputBorder.none,
                                                      enabledBorder:
                                                          InputBorder.none,
                                                      focusedBorder:
                                                          InputBorder.none,
                                                      contentPadding:
                                                          compactImeLandscape
                                                              ? const EdgeInsets
                                                                  .fromLTRB(
                                                                  14, 6, 14, 4)
                                                              : const EdgeInsets
                                                                  .fromLTRB(14,
                                                                  12, 14, 8),
                                                    ),
                                                  ),
                                                ),
                                              ),
                                            ),
                                          ),
                                          SizedBox(
                                            height: _composerActionRowHeight,
                                            child: Row(
                                              key: const Key(
                                                  'session-composer-actions'),
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.center,
                                              children: <Widget>[
                                                SizedBox.square(
                                                  key: _attachmentAnchorKey,
                                                  dimension: 44,
                                                  child: IconButton(
                                                    key: const Key(
                                                        'add-attachment'),
                                                    tooltip:
                                                        'Attach from this phone or device',
                                                    style: IconButton.styleFrom(
                                                      padding: EdgeInsets.zero,
                                                      shape:
                                                          const CircleBorder(),
                                                    ),
                                                    onPressed: imageAttachmentSupported &&
                                                            !_preparingSubmission &&
                                                            !_sending &&
                                                            !_attachmentPickerBusy &&
                                                            !_attachmentMenuOpen &&
                                                            !_recordingDictation &&
                                                            !_transcribingDictation &&
                                                            !_dictationOperationInFlight &&
                                                            _retryDictationBytes ==
                                                                null
                                                        ? _showAttachmentMenu
                                                        : null,
                                                    icon: const Icon(
                                                        Icons.add_rounded,
                                                        size: 25),
                                                  ),
                                                ),
                                                Expanded(
                                                  child:
                                                      _SessionComposerModelControl(
                                                    visual: visual,
                                                    modelLabel: sessionWorking
                                                        ? displayedModelLabel
                                                        : modelSelectionSupported
                                                            ? displayedModelLabel
                                                            : 'Harness model',
                                                    modelEnabled: !_preparingSubmission &&
                                                        !_sending &&
                                                        !sessionWorking &&
                                                        !_recordingDictation &&
                                                        !_transcribingDictation &&
                                                        !_dictationOperationInFlight &&
                                                        _retryDictationBytes ==
                                                            null &&
                                                        modelSelectionSupported &&
                                                        modelOptions.isNotEmpty,
                                                    reasoningLabel:
                                                        displayedReasoningLabel,
                                                    reasoningVisible:
                                                        displayedReasoningEffort !=
                                                            null,
                                                    effortIsUltra:
                                                        displayedReasoningEffort ==
                                                            'ultra',
                                                    onTap: () => _chooseModel(
                                                        modelOptions, visual),
                                                  ),
                                                ),
                                                const SizedBox(width: 2),
                                                _DictationComposerControl(
                                                  visual: visual,
                                                  tooltip: dictationTooltip,
                                                  enabled: !_preparingSubmission &&
                                                      !_sending &&
                                                      !_attachmentPickerBusy &&
                                                      !_dictationOperationInFlight,
                                                  recording:
                                                      _recordingDictation,
                                                  transcribing:
                                                      _transcribingDictation,
                                                  retryAvailable:
                                                      _retryDictationBytes !=
                                                          null,
                                                  onToggle: _toggleDictation,
                                                  onChooseSource:
                                                      _openDictationSourcePicker,
                                                ),
                                                SizedBox.square(
                                                  dimension: 44,
                                                  child:
                                                      _SessionSecondaryControlsMenu(
                                                    enabled: !_preparingSubmission &&
                                                        !_sending &&
                                                        !_recordingDictation &&
                                                        !_transcribingDictation &&
                                                        !_dictationOperationInFlight &&
                                                        _retryDictationBytes ==
                                                            null,
                                                    wallet: wallet,
                                                    onWalletTap: session == null
                                                        ? null
                                                        : () => _openWallet(
                                                            store,
                                                            session,
                                                            displayedModelId,
                                                            modelOptions),
                                                    reasoningLabel:
                                                        displayedReasoningLabel,
                                                    reasoningVisible:
                                                        displayedReasoningEffort !=
                                                            null,
                                                    reasoningEnabled:
                                                        !_preparingSubmission &&
                                                            !_sending &&
                                                            !sessionWorking &&
                                                            modelSelectionSupported &&
                                                            reasoningEfforts
                                                                .isNotEmpty,
                                                    effortIsUltra:
                                                        displayedReasoningEffort ==
                                                            'ultra',
                                                    onReasoningTap: () =>
                                                        _chooseReasoningEffort(
                                                      reasoningEfforts,
                                                      displayedModelId,
                                                      session?.providerId,
                                                    ),
                                                    visionLabel:
                                                        _visionProxySelection ==
                                                                null
                                                            ? 'Add eyes'
                                                            : 'Eyes: ${_visionSelectionDisplayName(store, _visionProxySelection!)}',
                                                    visionEnabled:
                                                        !_preparingSubmission &&
                                                            !sessionWorking,
                                                    onVisionTap:
                                                        _chooseVisionProxy,
                                                    deliveryLabel: switch (
                                                        deliveryMode) {
                                                      'steer' => 'Steer',
                                                      'send' => 'Send',
                                                      _ => 'Queue',
                                                    },
                                                    deliveryEnabled:
                                                        !_preparingSubmission &&
                                                            !_sending,
                                                    onDeliveryTap: () =>
                                                        _chooseDeliveryMode(
                                                      steeringSupported:
                                                          steeringSupported,
                                                      steeringAvailable:
                                                          steeringAvailable,
                                                    ),
                                                    sideChatEnabled: session !=
                                                            null &&
                                                        !_preparingSubmission &&
                                                        !preparedSession &&
                                                        !_sideChatOpening &&
                                                        store.connectionState ==
                                                            BridgeConnectionState
                                                                .online,
                                                    onSideChatTap: () =>
                                                        unawaited(
                                                            _createSideChat(
                                                                store)),
                                                    dictationSourceEnabled: !_preparingSubmission &&
                                                        !_sending &&
                                                        !_attachmentPickerBusy &&
                                                        !_dictationOperationInFlight &&
                                                        !_dictationSourcePickerOpen &&
                                                        !_recordingDictation &&
                                                        !_transcribingDictation &&
                                                        _retryDictationBytes ==
                                                            null,
                                                    onDictationSourceTap:
                                                        _openDictationSourcePicker,
                                                  ),
                                                ),
                                                ValueListenableBuilder<
                                                    TextEditingValue>(
                                                  valueListenable: _composer,
                                                  builder: (context,
                                                      composerValue, _) {
                                                    final composerEmpty =
                                                        composerValue.text
                                                                .trim()
                                                                .isEmpty &&
                                                            _attachments
                                                                .isEmpty;
                                                    final stopTaskAvailable =
                                                        sessionWorking &&
                                                            composerEmpty &&
                                                            !_recordingDictation &&
                                                            _retryDictationBytes ==
                                                                null;
                                                    final sendEnabled = !_preparingSubmission &&
                                                        !_sending &&
                                                        !_interruptingCurrentWork &&
                                                        !_attachmentPickerBusy &&
                                                        !_attachmentMenuOpen &&
                                                        !_dictationOperationInFlight &&
                                                        !_dictationSourcePickerOpen &&
                                                        !_transcribingDictation &&
                                                        !_hasActiveTextComposition(
                                                            composerValue) &&
                                                        (stopTaskAvailable ||
                                                            !composerEmpty ||
                                                            _recordingDictation ||
                                                            _retryDictationBytes !=
                                                                null);
                                                    final submissionStatus =
                                                        _preparingSubmission
                                                            ? 'Preparing message'
                                                            : _sending
                                                                ? 'Sending message'
                                                                : _interruptingCurrentWork
                                                                    ? 'Stopping current work'
                                                                    : null;
                                                    final button =
                                                        SizedBox.square(
                                                      dimension: 44,
                                                      child: IconButton(
                                                        key: Key(stopTaskAvailable
                                                            ? 'interrupt-current-work'
                                                            : 'send-instruction'),
                                                        tooltip: submissionStatus !=
                                                                null
                                                            ? null
                                                            : _recordingDictation
                                                                ? 'Stop dictation and send'
                                                                : _retryDictationBytes !=
                                                                        null
                                                                    ? 'Retry dictation and send'
                                                                    : stopTaskAvailable
                                                                        ? 'Stop current work'
                                                                        : 'Send message',
                                                        style: IconButton
                                                            .styleFrom(
                                                          padding:
                                                              EdgeInsets.zero,
                                                          backgroundColor:
                                                              Colors
                                                                  .transparent,
                                                          disabledBackgroundColor:
                                                              Colors
                                                                  .transparent,
                                                          shape:
                                                              const CircleBorder(),
                                                        ),
                                                        onPressed: sendEnabled
                                                            ? _recordingDictation
                                                                ? () => unawaited(
                                                                    _finishDictation(
                                                                        submitAfterFinish:
                                                                            true))
                                                                : _retryDictationBytes !=
                                                                        null
                                                                    ? () => unawaited(_retryPendingDictation(
                                                                        submitAfterFinish:
                                                                            true))
                                                                    : stopTaskAvailable
                                                                        ? () => unawaited(_interruptCurrentWork(
                                                                            store,
                                                                            widget
                                                                                .sessionId))
                                                                        : () => unawaited(_submitComposer(
                                                                            deliveryMode:
                                                                                deliveryMode))
                                                            : null,
                                                        icon: Container(
                                                          key: const Key(
                                                              'send-instruction-visual'),
                                                          width: 36,
                                                          height: 36,
                                                          alignment:
                                                              Alignment.center,
                                                          child: _preparingSubmission ||
                                                                  _sending ||
                                                                  _interruptingCurrentWork
                                                              ? SizedBox.square(
                                                                  dimension: 17,
                                                                  child:
                                                                      _WorkingSpinner(
                                                                    size: 17,
                                                                    color: visual
                                                                        .accent,
                                                                  ),
                                                                )
                                                              : Icon(
                                                                  stopTaskAvailable
                                                                      ? Icons
                                                                          .stop_rounded
                                                                      : Icons
                                                                          .send_rounded,
                                                                  size: 21,
                                                                  color: sendEnabled
                                                                      ? visual
                                                                          .accent
                                                                      : Theme.of(
                                                                              context)
                                                                          .disabledColor,
                                                                ),
                                                        ),
                                                      ),
                                                    );
                                                    return submissionStatus ==
                                                            null
                                                        ? button
                                                        : Semantics(
                                                            liveRegion: true,
                                                            label:
                                                                submissionStatus,
                                                            child:
                                                                ExcludeSemantics(
                                                              child: button,
                                                            ),
                                                          );
                                                  },
                                                ),
                                              ],
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                )),
          ),
        ),
      ),
    );
  }
}

class _DictationComposerControl extends StatelessWidget {
  const _DictationComposerControl({
    required this.visual,
    required this.tooltip,
    required this.enabled,
    required this.recording,
    required this.transcribing,
    required this.retryAvailable,
    required this.onToggle,
    required this.onChooseSource,
  });

  final ProviderVisualTheme visual;
  final String tooltip;
  final bool enabled;
  final bool recording;
  final bool transcribing;
  final bool retryAvailable;
  final VoidCallback onToggle;
  final VoidCallback onChooseSource;

  @override
  Widget build(BuildContext context) {
    final sourcePickerEnabled =
        enabled && !recording && !transcribing && !retryAvailable;
    final actionEnabled = enabled && !transcribing;
    final disabledColor = Theme.of(context).disabledColor;
    return SizedBox(
      width: 44,
      height: _composerActionRowHeight,
      child: Stack(
        alignment: Alignment.topCenter,
        children: <Widget>[
          Positioned(
            top: 4,
            left: 0,
            right: 0,
            height: 38,
            child: Tooltip(
              message: tooltip,
              excludeFromSemantics: true,
              child: Semantics(
                key: const Key('dictation-button-semantics'),
                button: true,
                enabled: actionEnabled,
                label: tooltip,
                onTap: actionEnabled ? onToggle : null,
                child: ExcludeSemantics(
                  child: IconButton(
                    key: const Key('dictation-button'),
                    onPressed: actionEnabled ? onToggle : null,
                    style: IconButton.styleFrom(
                      padding: const EdgeInsets.only(top: 5),
                      minimumSize: const Size(44, 38),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      backgroundColor: recording || retryAvailable
                          ? visual.accent.withValues(alpha: .12)
                          : Colors.transparent,
                      foregroundColor:
                          recording || retryAvailable ? visual.accent : null,
                      disabledBackgroundColor: Colors.transparent,
                      disabledForegroundColor: disabledColor,
                      shape: const CircleBorder(),
                    ),
                    icon: transcribing
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : Icon(
                            retryAvailable
                                ? Icons.replay_rounded
                                : recording
                                    ? Icons.stop_circle_outlined
                                    : Icons.mic_none_rounded,
                            size: 25,
                          ),
                  ),
                ),
              ),
            ),
          ),
          Positioned(
            left: 7,
            right: 7,
            bottom: 2,
            height: 13,
            child: Tooltip(
              message: 'Choose dictation source',
              excludeFromSemantics: true,
              child: Semantics(
                key: const Key('dictation-source-selector-semantics'),
                button: true,
                enabled: sourcePickerEnabled,
                label: 'Choose dictation source',
                onTap: sourcePickerEnabled ? onChooseSource : null,
                child: ExcludeSemantics(
                  child: Material(
                    color: sourcePickerEnabled
                        ? visual.surfaceRaised.withValues(alpha: .5)
                        : Colors.transparent,
                    shape: StadiumBorder(
                      side: BorderSide(
                        color: sourcePickerEnabled
                            ? visual.border.withValues(alpha: .65)
                            : disabledColor.withValues(alpha: .35),
                      ),
                    ),
                    clipBehavior: Clip.antiAlias,
                    child: InkWell(
                      key: const Key('dictation-source-selector'),
                      onTap: sourcePickerEnabled ? onChooseSource : null,
                      child: Icon(
                        Icons.keyboard_arrow_down_rounded,
                        size: 13,
                        color: sourcePickerEnabled
                            ? Theme.of(context)
                                .colorScheme
                                .onSurface
                                .withValues(alpha: .6)
                            : disabledColor,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _DictationLiveTrace extends StatefulWidget {
  const _DictationLiveTrace({
    required this.level,
    required this.elapsed,
    required this.visual,
  });

  final double level;
  final Duration elapsed;
  final ProviderVisualTheme visual;

  @override
  State<_DictationLiveTrace> createState() => _DictationLiveTraceState();
}

class _DictationLiveTraceState extends State<_DictationLiveTrace> {
  final List<double> _levels = <double>[];
  static const int _maximumSamples = 240;

  @override
  void didUpdateWidget(covariant _DictationLiveTrace oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.level != oldWidget.level ||
        widget.elapsed != oldWidget.elapsed) {
      _levels.add(widget.level.clamp(0.0, 1.0));
      if (_levels.length > _maximumSamples) _levels.removeAt(0);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      key: const Key('dictation-live-trace'),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 0, 8, 7),
        child: Container(
          height: 36,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color: widget.visual.accent.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(10),
            border:
                Border.all(color: widget.visual.accent.withValues(alpha: 0.35)),
          ),
          child: Row(
            children: <Widget>[
              Expanded(
                child: CustomPaint(
                  size: const Size(double.infinity, 26),
                  painter: _LiveTracePainter(
                    levels: List<double>.of(_levels),
                    accent: widget.visual.accent,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                dictationElapsedLabel(widget.elapsed),
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: widget.visual.accent,
                  fontFeatures: const <FontFeature>[
                    FontFeature.tabularFigures(),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _LiveTracePainter extends CustomPainter {
  const _LiveTracePainter({required this.levels, required this.accent});

  final List<double> levels;
  final Color accent;

  @override
  void paint(Canvas canvas, Size size) {
    final mid = size.height / 2;
    final line = Paint()
      ..color = accent
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.6
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    if (levels.isEmpty) {
      canvas.drawLine(Offset(2, mid), Offset(size.width - 2, mid), line);
      return;
    }
    final step = size.width / _DictationLiveTraceState._maximumSamples;
    final path = Path();
    for (var index = 0; index < levels.length; index += 1) {
      final x = size.width - (levels.length - index) * step;
      final y = mid - levels[index].clamp(0.0, 1.0) * (mid - 2);
      if (index == 0) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
    }
    canvas.drawPath(path, line);
  }

  @override
  bool shouldRepaint(covariant _LiveTracePainter oldDelegate) =>
      oldDelegate.levels != levels;
}

enum _SourceSessionAction { handoff, branch }

class _SourceSessionActionResult {
  const _SourceSessionActionResult({
    required this.prompt,
    required this.ownsRetainedDictation,
  });

  final String prompt;
  final bool ownsRetainedDictation;
}

class _SourceSessionActionSheet extends StatefulWidget {
  const _SourceSessionActionSheet({
    required this.action,
    required this.store,
    required this.openingHostId,
    required this.sessionId,
    required this.harnessId,
    required this.recorder,
  });

  final _SourceSessionAction action;
  final RemoteAppStore store;
  final String openingHostId;
  final String sessionId;
  final String harnessId;
  final DictationRecorder recorder;

  @override
  State<_SourceSessionActionSheet> createState() =>
      _SourceSessionActionSheetState();
}

class _SourceSessionActionSheetState extends State<_SourceSessionActionSheet>
    with WidgetsBindingObserver {
  final TextEditingController _prompt = TextEditingController();
  Timer? _timer;
  bool _recording = false;
  bool _transcribing = false;
  bool _dictationOperationInFlight = false;
  Future<void>? _dictationCommitOperation;
  int _dictationGeneration = 0;
  bool _cancellingDictation = false;
  bool _popResolutionInFlight = false;
  bool _allowPop = false;
  bool _staleOriginDismissScheduled = false;
  int _elapsedSeconds = 0;
  DateTime? _startedAt;
  String? _sourceId;
  Duration _maximumDuration = _maximumDictationDuration;
  Uint8List? _retryBytes;
  String? _retrySourceId;
  bool _hasRetainedDictation = false;

  bool get _originIsCurrent {
    final activeHost = widget.store.activeHost;
    if (activeHost != null && activeHost.hostId != widget.openingHostId) {
      return false;
    }
    return widget.store.sessions.any((session) =>
        session.id == widget.sessionId &&
        session.hostId == widget.openingHostId &&
        session.providerId == widget.harnessId);
  }

  void _scheduleStaleOriginDismiss() {
    if (_staleOriginDismissScheduled) return;
    _staleOriginDismissScheduled = true;
    _dictationGeneration += 1;
    if (_recording) unawaited(widget.recorder.cancel());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _allowPop = true;
      Navigator.of(context).pop();
    });
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _dictationGeneration += 1;
    _timer?.cancel();
    if (_recording) unawaited(widget.recorder.cancel());
    _prompt.dispose();
    super.dispose();
  }

  Future<void> _toggleDictation() async {
    if (!_originIsCurrent ||
        _transcribing ||
        _dictationOperationInFlight ||
        _dictationCommitOperation != null) {
      return;
    }
    if (_recording) {
      await _finishDictation();
      return;
    }
    if (_retryBytes != null) {
      await _retryDictation();
      return;
    }
    final source = widget.store.dictationSourceForHarness(widget.harnessId) ??
        widget.store.readyDictationSources.firstOrNull;
    if (source == null) {
      _showError(StateError(
          'Add a ready dictation service in Settings before using voice input.'));
      return;
    }
    setState(() => _dictationOperationInFlight = true);
    try {
      final permitted =
          await _duringExternalSystemActivity(widget.recorder.start);
      if (!mounted || !_originIsCurrent) {
        if (permitted) await widget.recorder.cancel();
        return;
      }
      if (!permitted) {
        _showError(
            StateError('Microphone permission is needed for dictation.'));
        return;
      }
      final lifecycleState = WidgetsBinding.instance.lifecycleState;
      if (lifecycleState == AppLifecycleState.hidden ||
          lifecycleState == AppLifecycleState.paused ||
          lifecycleState == AppLifecycleState.detached) {
        await widget.recorder.cancel();
        return;
      }
      if (!_originIsCurrent) {
        await widget.recorder.cancel();
        return;
      }
      _sourceId = source.id;
      _maximumDuration =
          dictationMaximumDurationForAudioBytes(source.maxAudioBytes);
      _startedAt = DateTime.now();
      setState(() {
        _recording = true;
        _elapsedSeconds = 0;
      });
      _timer = Timer.periodic(const Duration(seconds: 1), (_) {
        final startedAt = _startedAt;
        if (!mounted || !_recording || startedAt == null) return;
        final elapsed = DateTime.now().difference(startedAt);
        if (dictationShouldAutoFinish(
          elapsed,
          maximumDuration: _maximumDuration,
        )) {
          unawaited(_finishDictation());
        } else {
          setState(() => _elapsedSeconds = elapsed.inSeconds);
        }
      });
    } on Object catch (caught) {
      if (mounted) _showError(caught);
    } finally {
      if (mounted) setState(() => _dictationOperationInFlight = false);
    }
  }

  Future<void> _finishDictation() {
    final active = _dictationCommitOperation;
    if (active != null) return active;
    if (!_recording || _transcribing) {
      return Future<void>.value();
    }
    late final Future<void> operation;
    operation = _finishDictationOnce().whenComplete(() {
      if (identical(_dictationCommitOperation, operation)) {
        _dictationCommitOperation = null;
        if (mounted) setState(() {});
      }
    });
    _dictationCommitOperation = operation;
    return operation;
  }

  Future<void> _finishDictationOnce() async {
    final generation = ++_dictationGeneration;
    _timer?.cancel();
    _timer = null;
    _startedAt = null;
    setState(() {
      _recording = false;
      _transcribing = true;
    });
    Uint8List? bytes;
    try {
      bytes = await widget.recorder.stop();
      await widget.store.retainDictation(
        widget.sessionId,
        bytes,
        sourceId: _sourceId,
      );
      _hasRetainedDictation = true;
      if (!mounted || !_originIsCurrent) return;
      setState(() {
        _retryBytes = bytes;
        _retrySourceId = _sourceId;
      });
      _sourceId = null;
      if (generation != _dictationGeneration) {
        setState(() {
          _transcribing = false;
          _cancellingDictation = false;
        });
        return;
      }
      await _transcribeRetained(
        generation: generation,
        alreadyTranscribing: true,
      );
    } on Object catch (caught) {
      if (mounted && _originIsCurrent && generation == _dictationGeneration) {
        if (bytes != null) {
          setState(() {
            _retryBytes = bytes;
            _retrySourceId = _sourceId;
          });
        }
        _showError(caught);
      }
    } finally {
      if (generation == _dictationGeneration) _sourceId = null;
      if (mounted &&
          (generation == _dictationGeneration || _cancellingDictation)) {
        setState(() {
          _transcribing = false;
          _cancellingDictation = false;
        });
      }
    }
  }

  Future<void> _retryDictation() {
    final active = _dictationCommitOperation;
    if (active != null) return active;
    if (!_originIsCurrent || _retryBytes == null || _transcribing) {
      return Future<void>.value();
    }
    final generation = ++_dictationGeneration;
    late final Future<void> operation;
    operation = _transcribeRetained(generation: generation).whenComplete(() {
      if (identical(_dictationCommitOperation, operation)) {
        _dictationCommitOperation = null;
        if (mounted) setState(() {});
      }
    });
    _dictationCommitOperation = operation;
    return operation;
  }

  Future<void> _transcribeRetained({
    required int generation,
    bool alreadyTranscribing = false,
  }) async {
    final bytes = _retryBytes;
    if (!_originIsCurrent ||
        bytes == null ||
        (!alreadyTranscribing && _transcribing)) {
      return;
    }
    if (!alreadyTranscribing) setState(() => _transcribing = true);
    try {
      if (!_hasRetainedDictation) {
        await widget.store.retainDictation(
          widget.sessionId,
          bytes,
          sourceId: _retrySourceId,
        );
        _hasRetainedDictation = true;
        if (!mounted ||
            !_originIsCurrent ||
            generation != _dictationGeneration ||
            !identical(bytes, _retryBytes)) {
          return;
        }
      }
      final text = await widget.store.transcribeDictation(
        bytes,
        sessionId: widget.sessionId,
        sourceId: _retrySourceId,
      );
      if (!mounted ||
          !_originIsCurrent ||
          generation != _dictationGeneration ||
          !identical(bytes, _retryBytes)) {
        return;
      }
      if (text.trim().isEmpty) {
        throw StateError('No speech was detected. Your recording is kept.');
      }
      final existing = _prompt.text.trimRight();
      _prompt.text = existing.isEmpty ? text : '$existing $text';
      _prompt.selection = TextSelection.collapsed(offset: _prompt.text.length);
      setState(() {
        _retryBytes = null;
        _retrySourceId = null;
      });
    } on Object catch (caught) {
      if (mounted && _originIsCurrent && generation == _dictationGeneration) {
        _showError(caught);
      }
    } finally {
      if (!alreadyTranscribing &&
          mounted &&
          generation == _dictationGeneration) {
        setState(() => _transcribing = false);
      }
    }
  }

  void _cancelDictationProcessing() {
    if (!_transcribing || _cancellingDictation) return;
    _dictationGeneration += 1;
    final recordingRetained = _retryBytes != null;
    setState(() {
      _cancellingDictation = !recordingRetained;
      if (recordingRetained) _transcribing = false;
    });
  }

  void _showError(Object caught) {
    final message = compactErrorDetail(caught);
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  bool get _dictationBlocksPop =>
      _recording ||
      _transcribing ||
      _dictationOperationInFlight ||
      _dictationCommitOperation != null ||
      _retryBytes != null ||
      _hasRetainedDictation;

  Future<void> _closeSheet({bool submit = false}) async {
    if (_popResolutionInFlight) return;
    _popResolutionInFlight = true;
    try {
      if (_recording) {
        final retention = _finishDictation();
        _cancelDictationProcessing();
        if (_retryBytes == null) await retention;
      } else if (_transcribing) {
        _cancelDictationProcessing();
        if (_retryBytes == null) await _dictationCommitOperation;
      } else if (_retryBytes == null) {
        await _dictationCommitOperation;
      }
      if (!mounted) return;
      if (!_originIsCurrent) {
        _scheduleStaleOriginDismiss();
        return;
      }
      if (submit) {
        if (_retryBytes != null) return;
        final result = _SourceSessionActionResult(
          prompt: _prompt.text.trim(),
          ownsRetainedDictation: _hasRetainedDictation,
        );
        setState(() => _allowPop = true);
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) Navigator.of(context).pop(result);
        });
        return;
      }
      if (_retryBytes != null || _hasRetainedDictation) {
        final discard = await showDialog<bool>(
              context: context,
              builder: (dialogContext) => AlertDialog(
                title: const Text('Discard saved recording?'),
                content: Text(_retryBytes != null
                    ? 'This recording has not been added to the instruction yet.'
                    : 'The spoken words are in the instruction. Discard its saved recovery audio?'),
                actions: <Widget>[
                  TextButton(
                    onPressed: () => Navigator.pop(dialogContext, false),
                    child: const Text('Keep editing'),
                  ),
                  FilledButton(
                    onPressed: () => Navigator.pop(dialogContext, true),
                    child: const Text('Discard'),
                  ),
                ],
              ),
            ) ??
            false;
        if (!mounted || !discard) return;
        try {
          await widget.store.clearRetainedDictation(widget.sessionId);
        } on Object catch (caught) {
          if (mounted && _originIsCurrent) _showError(caught);
          return;
        }
        if (!mounted) return;
        setState(() {
          _retryBytes = null;
          _retrySourceId = null;
          _hasRetainedDictation = false;
        });
      }
      if (!mounted) return;
      setState(() => _allowPop = true);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) Navigator.of(context).pop();
      });
    } finally {
      _popResolutionInFlight = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      if (_recording) unawaited(_finishDictation());
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_originIsCurrent) {
      _scheduleStaleOriginDismiss();
      return const SizedBox.shrink();
    }
    final handoff = widget.action == _SourceSessionAction.handoff;
    return PopScope<void>(
      canPop: _allowPop || !_dictationBlocksPop,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_closeSheet());
      },
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          key: const Key('source-session-action-sheet'),
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                handoff ? 'Context Handoff' : 'Branch in New Task',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 6),
              Text(
                handoff
                    ? 'Create a clean task with a compact summary of this chat.'
                    : 'Create a new task from this point without changing the source chat.',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: 15),
              TextField(
                key: const Key('source-action-prompt'),
                controller: _prompt,
                minLines: 3,
                maxLines: 7,
                autofocus: true,
                decoration: InputDecoration(
                  labelText: 'Extra instruction (optional)',
                  hintText: handoff
                      ? 'What should the new task focus on?'
                      : 'What should happen next in the new task?',
                  border: const OutlineInputBorder(),
                  suffixIcon: IconButton(
                    key: const Key('source-action-dictation'),
                    tooltip: _recording
                        ? 'Stop and transcribe'
                        : _retryBytes != null
                            ? 'Retry saved dictation'
                            : 'Dictate extra instruction',
                    onPressed: _transcribing ||
                            _dictationOperationInFlight ||
                            _dictationCommitOperation != null
                        ? null
                        : _toggleDictation,
                    icon: _transcribing || _dictationOperationInFlight
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : Icon(_retryBytes != null
                            ? Icons.replay_rounded
                            : _recording
                                ? Icons.stop_circle_outlined
                                : Icons.mic_none_rounded),
                  ),
                ),
              ),
              if (_recording) ...<Widget>[
                const SizedBox(height: 7),
                Text(
                  'Listening… ${dictationElapsedLabel(Duration(seconds: _elapsedSeconds))}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
              if (_transcribing) ...<Widget>[
                const SizedBox(height: 7),
                Row(
                  children: <Widget>[
                    Expanded(
                      child: Text(
                        _cancellingDictation
                            ? 'Saving recording...'
                            : 'Recording saved. Processing...',
                        key: const Key('source-action-dictation-processing'),
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                    TextButton(
                      key: const Key(
                          'cancel-source-action-dictation-processing'),
                      onPressed: _cancellingDictation
                          ? null
                          : _cancelDictationProcessing,
                      child: const Text('Cancel processing'),
                    ),
                  ],
                ),
              ] else if (_retryBytes != null) ...<Widget>[
                const SizedBox(height: 7),
                Text(
                  'Recording kept - tap Retry. You do not need to speak again.',
                  key: const Key('source-action-dictation-retry-status'),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
              const SizedBox(height: 9),
              Text(
                handoff
                    ? 'Your instruction opens as a draft in the new chat. It is not sent until you tap Send.'
                    : 'Your instruction is carried into the new chat.',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: .58),
                      fontStyle: FontStyle.italic,
                    ),
              ),
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: <Widget>[
                  TextButton(
                    onPressed: () => unawaited(_closeSheet()),
                    child: const Text('Cancel'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton.icon(
                    key: const Key('source-action-submit'),
                    onPressed: _recording ||
                            _transcribing ||
                            _dictationOperationInFlight ||
                            _dictationCommitOperation != null ||
                            _retryBytes != null
                        ? null
                        : () => unawaited(
                              _closeSheet(submit: true),
                            ),
                    icon: Icon(handoff
                        ? Icons.move_up_rounded
                        : Icons.call_split_rounded),
                    label: Text(handoff ? 'Create handoff' : 'Create branch'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _HandoffSummaryBanner extends StatelessWidget {
  const _HandoffSummaryBanner({required this.summary, this.sourceTitle});

  final String summary;
  final String? sourceTitle;

  @override
  Widget build(BuildContext context) {
    final grey = Theme.of(context).colorScheme.onSurface.withValues(alpha: .58);
    final label = sourceTitle == null
        ? 'Context carried into this task'
        : 'Context carried from $sourceTitle';
    return Material(
      key: const Key('context-handoff-summary'),
      color: Theme.of(context)
          .colorScheme
          .surfaceContainerHighest
          .withValues(alpha: .22),
      child: InkWell(
        onTap: () => showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          useSafeArea: true,
          showDragHandle: true,
          builder: (sheetContext) => FractionallySizedBox(
            heightFactor: .7,
            child: ListView(
              key: const Key('context-handoff-summary-full'),
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
              children: <Widget>[
                Text(label,
                    style: Theme.of(sheetContext).textTheme.titleMedium),
                const SizedBox(height: 12),
                SelectableText(
                  summary,
                  style: Theme.of(sheetContext).textTheme.bodyMedium?.copyWith(
                        fontStyle: FontStyle.italic,
                        height: 1.45,
                      ),
                ),
              ],
            ),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(15, 9, 11, 9),
          child: Row(
            children: <Widget>[
              const Icon(Icons.move_up_rounded, size: 18),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style:
                            Theme.of(context).textTheme.labelMedium?.copyWith(
                                  color: grey,
                                  fontWeight: FontWeight.w600,
                                )),
                    const SizedBox(height: 2),
                    Text(summary,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: grey,
                              fontStyle: FontStyle.italic,
                              height: 1.3,
                            )),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right_rounded, size: 20),
            ],
          ),
        ),
      ),
    );
  }
}

class _BranchRelation {
  const _BranchRelation(this.session, this.label);

  final RemoteSession session;
  final String label;
}

class _BranchRelationshipBanner extends StatelessWidget {
  const _BranchRelationshipBanner({
    required this.relations,
    required this.onOpen,
  });

  final List<_BranchRelation> relations;
  final ValueChanged<_BranchRelation> onOpen;

  @override
  Widget build(BuildContext context) => Material(
        key: const Key('branch-relationship-banner'),
        color: Theme.of(context)
            .colorScheme
            .surfaceContainerHighest
            .withValues(alpha: .16),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          child: Row(
            children: relations
                .map((relation) => Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: TextButton.icon(
                        key: ValueKey<String>(
                            'branch-relationship-${relation.session.id}'),
                        onPressed: () => onOpen(relation),
                        style: TextButton.styleFrom(
                          minimumSize: const Size(44, 36),
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          foregroundColor: Theme.of(context)
                              .colorScheme
                              .onSurface
                              .withValues(alpha: .68),
                        ),
                        icon: const Icon(Icons.call_split_rounded, size: 16),
                        label: Text(
                          relation.label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ))
                .toList(growable: false),
          ),
        ),
      );
}

class _ModelChoice {
  const _ModelChoice(this.providerId, this.modelId);

  final String providerId;
  final String modelId;
}

class _QueuedTaskChoice {
  const _QueuedTaskChoice(
    this.providerId,
    this.modelId,
    this.reasoningEffort,
  );

  final String providerId;
  final String modelId;
  final String? reasoningEffort;
}

class _QueuedNewTaskSheet extends StatefulWidget {
  const _QueuedNewTaskSheet({
    required this.models,
    required this.sessions,
    required this.recentModels,
    required this.sourceSession,
    required this.message,
  });

  final List<RemoteModel> models;
  final List<RemoteSession> sessions;
  final List<RemoteModel> recentModels;
  final RemoteSession sourceSession;
  final RemoteQueuedMessage message;

  @override
  State<_QueuedNewTaskSheet> createState() => _QueuedNewTaskSheetState();
}

class _QueuedNewTaskSheetState extends State<_QueuedNewTaskSheet> {
  String _query = '';
  late RemoteModel _selectedModel;
  String? _reasoningEffort;

  @override
  void initState() {
    super.initState();
    _selectedModel = widget.models
            .where((model) =>
                model.providerId == widget.sourceSession.providerId &&
                model.id == widget.sourceSession.modelId)
            .firstOrNull ??
        widget.recentModels.firstOrNull ??
        widget.models.where((model) => model.isDefault).firstOrNull ??
        widget.models.first;
    _reasoningEffort = _queuedTaskReasoningEffort(
      widget.sessions,
      _selectedModel,
    );
  }

  bool _matches(RemoteModel model) {
    final query = _query.trim().toLowerCase();
    if (query.isEmpty) return true;
    return <String>[
      model.displayName,
      model.id,
      model.providerId,
      model.sourceProviderId ?? '',
      model.sourceProviderName ?? '',
      model.description ?? '',
      providerVisualThemeFor(model.providerId).displayName,
    ].join(' ').toLowerCase().contains(query);
  }

  void _choose(RemoteModel model) {
    setState(() {
      _selectedModel = model;
      _reasoningEffort = _queuedTaskReasoningEffort(widget.sessions, model);
    });
  }

  @override
  Widget build(BuildContext context) {
    final matches = widget.models.where(_matches).toList(growable: false);
    final groups = <String, List<RemoteModel>>{};
    for (final model in matches) {
      groups.putIfAbsent(model.providerId, () => <RemoteModel>[]).add(model);
    }
    final providerIds = groups.keys.toList()
      ..sort((left, right) => providerVisualThemeFor(left)
          .displayName
          .compareTo(providerVisualThemeFor(right).displayName));
    final efforts = _selectedModel.reasoningEfforts;
    return Column(
      key: const Key('queued-new-task-picker'),
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 12, 10),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text('Send to new task',
                        style: Theme.of(context).textTheme.titleLarge),
                    const SizedBox(height: 3),
                    Text(
                      widget.message.content.trim().split('\n').first,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: Theme.of(context)
                                .colorScheme
                                .onSurface
                                .withValues(alpha: .58),
                          ),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'Close',
                onPressed: () => Navigator.pop(context),
                icon: const Icon(Icons.close_rounded),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: TextField(
            key: const Key('queued-new-task-model-search'),
            autofocus: true,
            onChanged: (value) => setState(() => _query = value),
            decoration: const InputDecoration(
              hintText: 'Search models or providers',
              prefixIcon: Icon(Icons.search_rounded),
              border: OutlineInputBorder(),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Expanded(
          child: matches.isEmpty
              ? const Center(child: Text('No models match that search.'))
              : ListView(
                  keyboardDismissBehavior:
                      ScrollViewKeyboardDismissBehavior.onDrag,
                  children: providerIds
                      .expand((providerId) => <Widget>[
                            _ModelGroupHeader(
                              title: providerVisualThemeFor(providerId)
                                  .displayName,
                              providerId: providerId,
                            ),
                            ...groups[providerId]!.map((model) => ListTile(
                                  key: ValueKey<String>(
                                      'queued-model-${model.providerId}-${model.id}'),
                                  selected: model.providerId ==
                                          _selectedModel.providerId &&
                                      model.id == _selectedModel.id,
                                  leading: ProviderLogo(
                                      providerId: model.providerId, size: 25),
                                  title: Text(model.displayName,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis),
                                  subtitle: model.description == null
                                      ? null
                                      : Text(model.description!,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis),
                                  trailing: model.providerId ==
                                              _selectedModel.providerId &&
                                          model.id == _selectedModel.id
                                      ? const Icon(Icons.check_rounded)
                                      : null,
                                  onTap: () => _choose(model),
                                )),
                          ])
                      .toList(growable: false),
                ),
        ),
        Container(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surfaceContainerLow,
            border: Border(
              top: BorderSide(
                  color: Theme.of(context).dividerColor.withValues(alpha: .6)),
            ),
          ),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text('Model',
                        style: Theme.of(context).textTheme.labelSmall),
                    const SizedBox(height: 3),
                    Text(_selectedModel.displayName,
                        maxLines: 1, overflow: TextOverflow.ellipsis),
                  ],
                ),
              ),
              if (efforts.isNotEmpty) ...<Widget>[
                const SizedBox(width: 12),
                DropdownButton<String>(
                  key: const Key('queued-new-task-reasoning'),
                  value: _reasoningEffort,
                  underline: const SizedBox.shrink(),
                  items: efforts
                      .map((option) => DropdownMenuItem<String>(
                            value: option.id,
                            child: Text(_effortDisplayLabel(option.id,
                                _selectedModel.id, _selectedModel.providerId)),
                          ))
                      .toList(growable: false),
                  onChanged: (value) =>
                      setState(() => _reasoningEffort = value),
                ),
              ],
              const SizedBox(width: 12),
              FilledButton.icon(
                key: const Key('queued-new-task-start'),
                onPressed: () => Navigator.pop(
                  context,
                  _QueuedTaskChoice(
                    _selectedModel.providerId,
                    _selectedModel.id,
                    _reasoningEffort,
                  ),
                ),
                icon: const Icon(Icons.call_split_rounded, size: 17),
                label: const Text('Start task'),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _ModelPickerSheet extends StatefulWidget {
  const _ModelPickerSheet({
    required this.models,
    required this.recentModels,
    required this.currentProviderId,
    required this.selectedModelId,
    required this.visual,
  });

  final List<RemoteModel> models;
  final List<RemoteModel> recentModels;
  final String currentProviderId;
  final String? selectedModelId;
  final ProviderVisualTheme visual;

  @override
  State<_ModelPickerSheet> createState() => _ModelPickerSheetState();
}

class _ModelPickerSheetState extends State<_ModelPickerSheet> {
  String _query = '';

  bool _matches(RemoteModel model) {
    final query = _query.trim().toLowerCase();
    if (query.isEmpty) return true;
    return <String>[
      model.displayName,
      model.id,
      model.providerId,
      model.sourceProviderId ?? '',
      model.sourceProviderName ?? '',
      model.description ?? '',
    ].join(' ').toLowerCase().contains(query);
  }

  Widget _modelTile(RemoteModel model, {required String keyPrefix}) {
    final selected = model.providerId == widget.currentProviderId &&
        model.id == widget.selectedModelId;
    final sourceColor = model.providerId == 'direct'
        ? const Color(0xff5aa9ff)
        : const Color(0xffffa552);
    return ListTile(
      key: Key('$keyPrefix-${model.providerId}-${model.id}'),
      selected: selected,
      selectedColor: widget.visual.accent,
      leading: keyPrefix == 'recent'
          ? ProviderLogo(providerId: model.providerId, size: 26)
          : null,
      title: Text(model.displayName,
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
      subtitle: keyPrefix == 'recent' && model.providerId == 'opencode'
          ? Text(model.routeProviderLabel,
              maxLines: 1, overflow: TextOverflow.ellipsis)
          : null,
      trailing: selected
          ? const Icon(Icons.check_rounded)
          : Icon(Icons.account_balance_wallet_outlined,
              size: 18, color: sourceColor),
      onTap: () =>
          Navigator.pop(context, _ModelChoice(model.providerId, model.id)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final matches = widget.models.where(_matches).toList(growable: false);
    final recent = widget.recentModels.where(_matches).take(5).toList();
    final recentKeys =
        recent.map((model) => '${model.providerId}\u0000${model.id}').toSet();
    final groups = <String, List<RemoteModel>>{};
    for (final model in matches.where((model) =>
        !recentKeys.contains('${model.providerId}\u0000${model.id}'))) {
      final routeKey = model.providerId == 'opencode'
          ? '${model.providerId}\u0000${model.sourceProviderId ?? model.sourceProviderName ?? 'opencode'}'
          : model.providerId;
      groups.putIfAbsent(routeKey, () => <RemoteModel>[]).add(model);
    }
    final providerIds = groups.keys.toList()
      ..sort((left, right) {
        final leftProviderId = left.split('\u0000').first;
        final rightProviderId = right.split('\u0000').first;
        if (leftProviderId != rightProviderId) {
          if (leftProviderId == widget.currentProviderId) return -1;
          if (rightProviderId == widget.currentProviderId) return 1;
          return providerVisualThemeFor(leftProviderId)
              .displayName
              .compareTo(providerVisualThemeFor(rightProviderId).displayName);
        }
        return groups[left]!
            .first
            .routeProviderName
            .compareTo(groups[right]!.first.routeProviderName);
      });
    return Column(
      key: const Key('searchable-model-picker'),
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
          child: Align(
            alignment: AlignmentDirectional.centerStart,
            child: Text('Choose model',
                style: Theme.of(context).textTheme.titleLarge),
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: TextField(
            key: const Key('model-search-field'),
            onChanged: (value) => setState(() => _query = value),
            decoration: const InputDecoration(
              hintText: 'Search models or providers',
              prefixIcon: Icon(Icons.search_rounded),
              border: OutlineInputBorder(),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Expanded(
          child: matches.isEmpty
              ? const Center(
                  key: Key('model-search-empty'),
                  child: Text('No models match that search.'),
                )
              : ListView(
                  keyboardDismissBehavior:
                      ScrollViewKeyboardDismissBehavior.onDrag,
                  children: <Widget>[
                    if (recent.isNotEmpty) ...<Widget>[
                      const _ModelGroupHeader(
                        key: Key('recent-models-header'),
                        title: 'Recent',
                        icon: Icons.history_rounded,
                      ),
                      ...recent.map(
                          (model) => _modelTile(model, keyPrefix: 'recent')),
                      const Divider(height: 18),
                    ],
                    ...providerIds.expand((groupKey) {
                      final groupModels = groups[groupKey]!;
                      final providerId = groupModels.first.providerId;
                      final openCodeRoute = providerId == 'opencode';
                      return <Widget>[
                        _ModelGroupHeader(
                          title: openCodeRoute
                              ? groupModels.first.routeProviderName
                              : providerVisualThemeFor(providerId).displayName,
                          providerId: providerId,
                          subtitle: openCodeRoute
                              ? groupModels.first.routeCarrierName == null
                                  ? null
                                  : 'via ${groupModels.first.routeCarrierName}'
                              : null,
                        ),
                        ...groupModels.map(
                            (model) => _modelTile(model, keyPrefix: 'catalog')),
                      ];
                    }),
                    const SizedBox(height: 16),
                  ],
                ),
        ),
      ],
    );
  }
}

class _ModelGroupHeader extends StatelessWidget {
  const _ModelGroupHeader({
    required this.title,
    this.providerId,
    this.icon,
    this.subtitle,
    super.key,
  });

  final String title;
  final String? providerId;
  final IconData? icon;
  final String? subtitle;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(18, 13, 18, 4),
        child: Row(
          children: <Widget>[
            if (providerId != null)
              ProviderLogo(providerId: providerId!, size: 19)
            else
              Icon(icon, size: 18),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(title,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          )),
                  if (subtitle != null)
                    Text(subtitle!,
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurface
                                  .withValues(alpha: .55),
                            )),
                ],
              ),
            ),
          ],
        ),
      );
}

class _WalletSheet extends StatefulWidget {
  const _WalletSheet({
    required this.store,
    required this.openingHostId,
    required this.sessionId,
    required this.providerId,
    required this.modelId,
    required this.models,
    required this.initial,
  });

  final RemoteAppStore store;
  final String? openingHostId;
  final String sessionId;
  final String providerId;
  final String? modelId;
  final List<RemoteModel> models;
  final ProviderWalletStatus initial;

  @override
  State<_WalletSheet> createState() => _WalletSheetState();
}

class _WalletSheetState extends State<_WalletSheet> {
  final TextEditingController _apiKey = TextEditingController();
  final TextEditingController _budget = TextEditingController();
  final TextEditingController _customName = TextEditingController();
  final TextEditingController _customBaseUrl = TextEditingController();
  final TextEditingController _customModels = TextEditingController();
  late ProviderWalletStatus _wallet;
  late final Map<String, String> _endpoints;
  late String _customEndpointId;
  String? _endpointId;
  String _customProtocol = 'responses';
  String _budgetMode = 'set';
  String? _error;
  bool _saving = false;
  bool _refreshingEndpoint = false;

  bool get _originIsCurrent =>
      widget.store.activeHost?.hostId == widget.openingHostId &&
      widget.store.sessions.any((session) =>
          session.id == widget.sessionId &&
          (widget.openingHostId == null ||
              session.hostId == widget.openingHostId));

  @override
  void initState() {
    super.initState();
    _wallet = widget.initial;
    _customEndpointId = randomId('phone-endpoint');
    _endpoints = <String, String>{};
    for (final endpoint in _wallet.availableEndpoints) {
      _endpoints[endpoint.id] = endpoint.name;
    }
    for (final model in widget.models) {
      final endpointId = model.endpointId;
      if (endpointId != null) {
        _endpoints[endpointId] = model.endpointName ?? endpointId;
      }
    }
    if (_wallet.endpointId != null) {
      _endpoints[_wallet.endpointId!] =
          _wallet.endpointName ?? _wallet.endpointId!;
    }
    _endpointId = _wallet.endpointId ?? _endpoints.keys.firstOrNull;
  }

  @override
  void dispose() {
    _apiKey.dispose();
    _budget.dispose();
    _customName.dispose();
    _customBaseUrl.dispose();
    _customModels.dispose();
    super.dispose();
  }

  Future<void> _selectEndpoint(String? endpointId) async {
    if (!_originIsCurrent || endpointId == null || endpointId == _endpointId) {
      return;
    }
    setState(() {
      _endpointId = endpointId;
      _refreshingEndpoint = true;
      _error = null;
    });
    final wallet = await widget.store.loadWallet(
      widget.providerId,
      endpointId: endpointId,
      force: true,
    );
    if (!mounted || !_originIsCurrent || _endpointId != endpointId) return;
    setState(() {
      _refreshingEndpoint = false;
      if (wallet == null || wallet.endpointId != endpointId) {
        _error = 'Could not refresh that endpoint wallet.';
        return;
      }
      _apiKey.clear();
      _wallet = wallet;
      for (final endpoint in wallet.availableEndpoints) {
        _endpoints[endpoint.id] = endpoint.name;
      }
    });
  }

  Future<void> _configure({bool clearApiKey = false}) async {
    if (!_originIsCurrent || _saving || _refreshingEndpoint) return;
    JsonMap? customEndpoint;
    final customName = _customName.text.trim();
    final customBaseUrl = _customBaseUrl.text.trim();
    final hasCustomEndpoint = customName.isNotEmpty || customBaseUrl.isNotEmpty;
    if (!clearApiKey && hasCustomEndpoint) {
      if (customName.isEmpty || customBaseUrl.isEmpty) {
        setState(() =>
            _error = 'Enter both a name and base URL for the custom endpoint.');
        return;
      }
      final modelIds = _customModels.text
          .split(',')
          .map((value) => value.trim())
          .where((value) => value.isNotEmpty)
          .toSet()
          .toList(growable: false);
      customEndpoint = <String, Object?>{
        'id': _customEndpointId,
        'name': customName,
        'baseUrl': customBaseUrl,
        'protocol': _customProtocol,
        if (modelIds.isNotEmpty) 'modelIds': modelIds,
      };
    }
    final endpointId = customEndpoint == null ? _endpointId : _customEndpointId;
    if (endpointId == null) {
      setState(() => _error = 'Choose a direct API endpoint first.');
      return;
    }
    final budgetText = clearApiKey ? '' : _budget.text.trim();
    final balance = budgetText.isEmpty ? null : double.tryParse(budgetText);
    if (budgetText.isNotEmpty && (balance == null || balance < 0)) {
      setState(() => _error = 'Enter a valid local spend budget.');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final wallet = await widget.store.configureWallet(
        providerId: widget.providerId,
        endpointId: endpointId,
        modelId: widget.modelId,
        apiKey: clearApiKey ? null : _apiKey.text,
        clearApiKey: clearApiKey,
        setBalance: _budgetMode == 'set' ? balance : null,
        addBalance: _budgetMode == 'add' ? balance : null,
        customEndpoint: customEndpoint,
      );
      if (!mounted || !_originIsCurrent) return;
      setState(() {
        _apiKey.clear();
        _wallet = wallet;
        for (final endpoint in wallet.availableEndpoints) {
          _endpoints[endpoint.id] = endpoint.name;
        }
        _endpointId = wallet.endpointId ?? _endpointId;
        if (customEndpoint != null) {
          _endpoints[_customEndpointId] = customName;
          _endpointId = _customEndpointId;
          _customName.clear();
          _customBaseUrl.clear();
          _customModels.clear();
          _customEndpointId = randomId('phone-endpoint');
        }
        _budget.clear();
      });
    } on Object catch (caught) {
      if (!mounted || !_originIsCurrent) return;
      setState(() => _error = caught
          .toString()
          .replaceFirst(RegExp(r'^(Exception|StateError):\s*'), ''));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final color =
        _wallet.isDirectApi ? const Color(0xff5aa9ff) : const Color(0xffffa552);
    final caution = _wallet.caution ??
        (_wallet.requiresApiKey
            ? 'An API key is required before this model can run.'
            : null);
    final selectedEndpoint = _wallet.availableEndpoints
        .where((endpoint) => endpoint.id == _endpointId)
        .firstOrNull;
    return SafeArea(
      top: false,
      child: SingleChildScrollView(
        key: const Key('wallet-source-sheet'),
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Icon(Icons.account_balance_wallet_outlined, color: color),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(_walletSourceLabel(_wallet),
                      style: Theme.of(context).textTheme.titleLarge),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(_wallet.detail),
            if (caution != null) ...<Widget>[
              const SizedBox(height: 12),
              Container(
                key: const Key('wallet-key-caution'),
                width: double.infinity,
                padding: const EdgeInsets.all(11),
                decoration: BoxDecoration(
                  color: const Color(0xffffa552).withValues(alpha: .12),
                  border: Border.all(
                      color: const Color(0xffffa552).withValues(alpha: .48)),
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    const Icon(Icons.warning_amber_rounded,
                        size: 19, color: Color(0xffffa552)),
                    const SizedBox(width: 8),
                    Expanded(child: Text(caution)),
                  ],
                ),
              ),
            ],
            if (_wallet.balance != null || _wallet.spent != null) ...<Widget>[
              const SizedBox(height: 12),
              Text(
                <String>[
                  if (_wallet.balance != null)
                    'Budget ${_walletAmount(_wallet.balance!, _wallet.currency)}',
                  if (_wallet.spent != null)
                    'Spent ${_walletAmount(_wallet.spent!, _wallet.currency)}',
                ].join(' · '),
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ],
            if (_wallet.isDirectApi) ...<Widget>[
              const SizedBox(height: 18),
              DropdownButtonFormField<String>(
                key: const Key('wallet-endpoint-selector'),
                initialValue: _endpointId,
                decoration: const InputDecoration(
                  labelText: 'Direct API endpoint',
                  border: OutlineInputBorder(),
                ),
                items: _endpoints.entries
                    .map((entry) => DropdownMenuItem<String>(
                          value: entry.key,
                          child: Text(entry.value),
                        ))
                    .toList(growable: false),
                onChanged: _saving
                    ? null
                    : _refreshingEndpoint
                        ? null
                        : (value) => unawaited(_selectEndpoint(value)),
              ),
              if (_refreshingEndpoint) ...<Widget>[
                const SizedBox(height: 8),
                const LinearProgressIndicator(
                  key: Key('wallet-endpoint-refreshing'),
                ),
              ],
              const SizedBox(height: 12),
              TextField(
                key: const Key('wallet-api-key-field'),
                controller: _apiKey,
                obscureText: true,
                enableSuggestions: false,
                autocorrect: false,
                decoration: InputDecoration(
                  labelText: selectedEndpoint?.apiKeyLabel ??
                      _wallet.apiKeyLabel ??
                      'API key',
                  helperText: _wallet.apiKeyConfigured
                      ? 'A key is configured. Enter a new one only to replace it.'
                      : 'The key is sent to your paired computer and is never shown here again.',
                  border: const OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              Wrap(
                key: const Key('wallet-budget-mode'),
                spacing: 8,
                children: <Widget>[
                  ChoiceChip(
                    label: const Text('Set total'),
                    selected: _budgetMode == 'set',
                    onSelected: _saving
                        ? null
                        : (_) => setState(() => _budgetMode = 'set'),
                  ),
                  ChoiceChip(
                    label: const Text('Add amount'),
                    selected: _budgetMode == 'add',
                    onSelected: _saving
                        ? null
                        : (_) => setState(() => _budgetMode = 'add'),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              TextField(
                key: const Key('wallet-local-budget-field'),
                controller: _budget,
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
                decoration: InputDecoration(
                  labelText: _budgetMode == 'set'
                      ? 'Set local spend budget (${_wallet.currency})'
                      : 'Add to local spend budget (${_wallet.currency})',
                  helperText: 'A local spend limit, not stored money.',
                  border: const OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 8),
              ExpansionTile(
                key: const Key('wallet-advanced-settings'),
                tilePadding: EdgeInsets.zero,
                childrenPadding: const EdgeInsets.only(bottom: 6),
                title: const Text('Advanced settings'),
                subtitle: const Text('Add a custom direct API endpoint'),
                children: <Widget>[
                  TextField(
                    key: const Key('wallet-custom-endpoint-name'),
                    controller: _customName,
                    decoration: const InputDecoration(
                      labelText: 'Endpoint name',
                      hintText: 'My gateway',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    key: const Key('wallet-custom-endpoint-url'),
                    controller: _customBaseUrl,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'Base URL',
                      hintText: 'https://api.example.com/v1',
                      helperText:
                          'HTTPS is required except for localhost endpoints.',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  DropdownButtonFormField<String>(
                    key: const Key('wallet-custom-endpoint-protocol'),
                    initialValue: _customProtocol,
                    decoration: const InputDecoration(
                      labelText: 'Protocol',
                      border: OutlineInputBorder(),
                    ),
                    items: const <DropdownMenuItem<String>>[
                      DropdownMenuItem(
                        value: 'responses',
                        child: Text('Responses API'),
                      ),
                      DropdownMenuItem(
                        value: 'chat_completions',
                        child: Text('OpenAI-compatible Chat Completions'),
                      ),
                    ],
                    onChanged: _saving
                        ? null
                        : (value) {
                            if (value != null) {
                              setState(() => _customProtocol = value);
                            }
                          },
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    key: const Key('wallet-custom-endpoint-models'),
                    controller: _customModels,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'Model IDs (optional)',
                      hintText: 'model-a, model-b',
                      helperText: 'Separate model IDs with commas.',
                      border: OutlineInputBorder(),
                    ),
                  ),
                ],
              ),
              if (_error != null) ...<Widget>[
                const SizedBox(height: 8),
                Text(_error!,
                    key: const Key('wallet-config-error'),
                    style:
                        TextStyle(color: Theme.of(context).colorScheme.error)),
              ],
              const SizedBox(height: 14),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: <Widget>[
                  TextButton(
                    key: const Key('wallet-clear-key'),
                    onPressed: _saving || _refreshingEndpoint
                        ? null
                        : () => _configure(clearApiKey: true),
                    child: const Text('Clear key'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    key: const Key('wallet-save'),
                    onPressed:
                        _saving || _refreshingEndpoint ? null : _configure,
                    child: _saving
                        ? const SizedBox.square(
                            dimension: 17,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Save'),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

String _walletAmount(double amount, String currency) =>
    '$currency ${amount.toStringAsFixed(2)}';

String _walletSourceLabel(ProviderWalletStatus wallet) => wallet.isDirectApi
    ? 'Direct API'
    : wallet.kind == 'subscription'
        ? 'Subscription'
        : wallet.label;

final RegExp _simplifyCommandPattern = RegExp(
  r'(^|[\s(])/simplify\b[,:;]?',
  caseSensitive: false,
);

bool _containsSimplifyCommand(String value) =>
    _simplifyCommandPattern.hasMatch(value.trim());

String _withoutSimplifyCommand(String value) => value
    .replaceAllMapped(
      _simplifyCommandPattern,
      (match) => match.group(1) ?? '',
    )
    .replaceAllMapped(
      RegExp(r'[ \t]+([,.;!?])'),
      (match) => match.group(1)!,
    )
    .replaceAll(RegExp(r'[ \t]{2,}'), ' ')
    .replaceFirst(RegExp(r'^\s*[,;:]\s*'), '')
    .trim();

class _SlashCommandDefinition {
  const _SlashCommandDefinition({
    required this.id,
    required this.command,
    required this.description,
    required this.icon,
  });

  final String id;
  final String command;
  final String description;
  final IconData icon;
}

const List<_SlashCommandDefinition> _slashCommands = <_SlashCommandDefinition>[
  _SlashCommandDefinition(
    id: 'simplify',
    command: '/simplify',
    description: 'Shorten the previous or upcoming answer',
    icon: Icons.short_text_rounded,
  ),
  _SlashCommandDefinition(
    id: 'mesh',
    command: '/mesh',
    description: 'Delegate to another connected harness',
    icon: Icons.hub_outlined,
  ),
  _SlashCommandDefinition(
    id: 'goal',
    command: '/goal',
    description: 'Set or manage this task\'s goal',
    icon: Icons.track_changes_outlined,
  ),
  _SlashCommandDefinition(
    id: 'ears',
    command: '/ears',
    description: 'Configure dictation preprocessing',
    icon: Icons.graphic_eq_rounded,
  ),
  _SlashCommandDefinition(
    id: 'eyes',
    command: '/eyes',
    description: 'Choose the model that reads images',
    icon: Icons.visibility_outlined,
  ),
];

List<_SlashCommandDefinition>? _filteredSlashCommands(String value) {
  final match =
      RegExp(r'^/([a-z0-9_-]*)$', caseSensitive: false).firstMatch(value);
  if (match == null) return null;
  final query = (match.group(1) ?? '').toLowerCase();
  return _slashCommands
      .where((item) => item.command.substring(1).startsWith(query))
      .toList(growable: false);
}

class _SlashCommandPalette extends StatelessWidget {
  const _SlashCommandPalette({
    required this.commands,
    required this.selectedIndex,
    required this.visual,
    required this.onSelected,
  });

  final List<_SlashCommandDefinition> commands;
  final int selectedIndex;
  final ProviderVisualTheme visual;
  final ValueChanged<_SlashCommandDefinition> onSelected;

  @override
  Widget build(BuildContext context) => Container(
        key: const Key('slash-command-palette'),
        constraints: const BoxConstraints(maxHeight: 252),
        margin: const EdgeInsets.fromLTRB(8, 3, 8, 2),
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(
          color: visual.surface.withValues(alpha: 0.96),
          borderRadius: BorderRadius.circular(10),
        ),
        child: commands.isEmpty
            ? const Padding(
                padding: EdgeInsets.symmetric(horizontal: 10, vertical: 11),
                child: Text('No commands match'),
              )
            : ListView.builder(
                shrinkWrap: true,
                itemCount: commands.length,
                itemBuilder: (context, index) {
                  final command = commands[index];
                  final selected = index == selectedIndex;
                  return InkWell(
                    key: Key('${command.id}-command-suggestion'),
                    borderRadius: BorderRadius.circular(7),
                    onTap: () => onSelected(command),
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 70),
                      constraints: const BoxConstraints(minHeight: 48),
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 6),
                      decoration: BoxDecoration(
                        color: selected
                            ? visual.surfaceRaised.withValues(alpha: 0.9)
                            : Colors.transparent,
                        borderRadius: BorderRadius.circular(7),
                      ),
                      child: Row(
                        children: <Widget>[
                          Icon(command.icon, color: visual.accent, size: 19),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: <Widget>[
                                Text(command.command,
                                    style: Theme.of(context)
                                        .textTheme
                                        .bodyMedium
                                        ?.copyWith(
                                            fontWeight: FontWeight.w600)),
                                Text(command.description,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: Theme.of(context)
                                        .textTheme
                                        .labelSmall
                                        ?.copyWith(
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onSurface
                                                .withValues(alpha: 0.58))),
                              ],
                            ),
                          ),
                          const Icon(Icons.keyboard_return_rounded, size: 17),
                        ],
                      ),
                    ),
                  );
                },
              ),
      );
}

class _EarsSettingsSheet extends StatelessWidget {
  const _EarsSettingsSheet({required this.store});

  final RemoteAppStore store;

  List<RemoteModel> get _routes {
    final routes = <RemoteModel>[];
    for (final models in store.modelsByProvider.values) {
      for (final model in models) {
        if (routeAcceptsEarsAudio(model)) routes.add(model);
      }
    }
    return routes;
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: store,
      builder: (context, _) {
        final settings = store.ears;
        final routes = _routes;
        final selected = routes
            .where((model) =>
                model.providerId == settings.providerId &&
                model.id == settings.modelId)
            .firstOrNull;
        return SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 0, 18, 18),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('EARS', style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 4),
                Text(
                  'Dictation audio is sent to this model first. The destination agent receives only the resulting text.',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                SwitchListTile(
                  key: const Key('ears-enabled-toggle'),
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Preprocess dictation before send'),
                  value: settings.enabled,
                  onChanged: (value) => unawaited(
                      store.setEars(settings.copyWith(enabled: value))),
                ),
                DropdownButtonFormField<String>(
                  key: const Key('ears-model-picker'),
                  initialValue: selected == null
                      ? null
                      : '${selected.providerId}:${selected.id}',
                  decoration: const InputDecoration(labelText: 'Model'),
                  items: <DropdownMenuItem<String>>[
                    ...routes.map((model) => DropdownMenuItem<String>(
                          value: '${model.providerId}:${model.id}',
                          child: Text(model.displayName),
                        )),
                  ],
                  onChanged: (value) {
                    if (value == null) return;
                    final separator = value.indexOf(':');
                    unawaited(store.setEars(settings.copyWith(
                      enabled: true,
                      providerId: value.substring(0, separator),
                      modelId: value.substring(separator + 1),
                    )));
                  },
                ),
                ListTile(
                  key: const Key('ears-mode-cleaned'),
                  contentPadding: EdgeInsets.zero,
                  selected: settings.mode == 'cleaned',
                  title: const Text('Cleaned'),
                  subtitle: const Text(
                      'Turn the recording into a clear written prompt.'),
                  onTap: () => unawaited(
                      store.setEars(settings.copyWith(mode: 'cleaned'))),
                ),
                ListTile(
                  key: const Key('ears-mode-verbatim'),
                  contentPadding: EdgeInsets.zero,
                  selected: settings.mode == 'verbatim',
                  title: const Text('Verbatim'),
                  subtitle: const Text(
                      'Transcribe the recording as faithfully as possible.'),
                  onTap: () => unawaited(
                      store.setEars(settings.copyWith(mode: 'verbatim'))),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _SimplifyComposerChip extends StatelessWidget {
  const _SimplifyComposerChip({
    required this.settings,
    required this.visual,
    required this.onPressed,
    required this.onDeleted,
  });

  final SimplifySettings settings;
  final ProviderVisualTheme visual;
  final VoidCallback onPressed;
  final VoidCallback onDeleted;

  @override
  Widget build(BuildContext context) => SizedBox(
        height: 44,
        child: ListView(
          padding: const EdgeInsets.symmetric(horizontal: 8),
          scrollDirection: Axis.horizontal,
          children: <Widget>[
            InputChip(
              key: const Key('simplify-composer-chip'),
              avatar: Icon(Icons.short_text_rounded,
                  size: 17, color: visual.accent),
              label: Text('Simplify · ${settings.maxWords} words'),
              tooltip: 'Simplify settings',
              onPressed: onPressed,
              onDeleted: onDeleted,
              deleteIcon: const Icon(Icons.close_rounded, size: 17),
              visualDensity: VisualDensity.compact,
            ),
          ],
        ),
      );
}

class _SimplifySettingsSheet extends StatefulWidget {
  const _SimplifySettingsSheet({required this.initial});

  final SimplifySettings initial;

  @override
  State<_SimplifySettingsSheet> createState() => _SimplifySettingsSheetState();
}

class _SimplifySettingsSheetState extends State<_SimplifySettingsSheet> {
  static const List<int> _presets = <int>[100, 200, 300];

  late final TextEditingController _customWords;
  late final TextEditingController _guidance;
  int? _preset;

  @override
  void initState() {
    super.initState();
    _preset = _presets.contains(widget.initial.maxWords)
        ? widget.initial.maxWords
        : null;
    _customWords =
        TextEditingController(text: widget.initial.maxWords.toString());
    _guidance = TextEditingController(text: widget.initial.guidance ?? '');
  }

  @override
  void dispose() {
    _customWords.dispose();
    _guidance.dispose();
    super.dispose();
  }

  int? get _selectedWordCount {
    if (_preset != null) return _preset;
    final value = int.tryParse(_customWords.text.trim());
    if (value == null ||
        value < 1 ||
        value > SimplifySettings.maximumMaxWords) {
      return null;
    }
    return value;
  }

  void _apply() {
    final maxWords = _selectedWordCount;
    if (maxWords == null) return;
    Navigator.pop(
      context,
      SimplifySettings(maxWords: maxWords, guidance: _guidance.text),
    );
  }

  @override
  Widget build(BuildContext context) {
    final customValid = _preset != null || _selectedWordCount != null;
    return SafeArea(
      top: false,
      child: AnimatedPadding(
        duration: const Duration(milliseconds: 100),
        padding: EdgeInsets.only(
          left: 18,
          right: 18,
          bottom: MediaQuery.viewInsetsOf(context).bottom + 14,
        ),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text('Simplify response',
                  style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 4),
              Text(
                'On its own, /simplify shortens the previous answer. With a request, it shapes the next answer.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 14),
              Text('Maximum words',
                  style: Theme.of(context).textTheme.labelLarge),
              const SizedBox(height: 7),
              Wrap(
                spacing: 8,
                runSpacing: 7,
                children: <Widget>[
                  ..._presets.map((words) => ChoiceChip(
                        key: Key('simplify-preset-$words'),
                        label: Text(words == SimplifySettings.defaultMaxWords
                            ? '$words (default)'
                            : '$words'),
                        selected: _preset == words,
                        onSelected: (_) => setState(() => _preset = words),
                      )),
                  ChoiceChip(
                    key: const Key('simplify-preset-custom'),
                    label: const Text('Custom'),
                    selected: _preset == null,
                    onSelected: (_) => setState(() => _preset = null),
                  ),
                ],
              ),
              if (_preset == null) ...<Widget>[
                const SizedBox(height: 10),
                TextField(
                  key: const Key('simplify-custom-words'),
                  controller: _customWords,
                  keyboardType: TextInputType.number,
                  inputFormatters: <TextInputFormatter>[
                    FilteringTextInputFormatter.digitsOnly,
                  ],
                  onChanged: (_) => setState(() {}),
                  decoration: InputDecoration(
                    labelText: 'Word limit',
                    helperText: '1–${SimplifySettings.maximumMaxWords}',
                    errorText: customValid ? null : 'Enter a valid word limit',
                  ),
                ),
              ],
              const SizedBox(height: 12),
              TextField(
                key: const Key('simplify-guidance'),
                controller: _guidance,
                minLines: 1,
                maxLines: 3,
                maxLength: SimplifySettings.maximumGuidanceLength,
                decoration: const InputDecoration(
                  labelText: 'Extra guidance (optional)',
                  hintText: 'For example: keep the concrete example',
                ),
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                height: 46,
                child: FilledButton(
                  key: const Key('apply-simplify-settings'),
                  onPressed: customValid ? _apply : null,
                  child: const Text('Apply'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SpawnedSubagentRow extends StatelessWidget {
  const _SpawnedSubagentRow({
    required this.entry,
    required this.visual,
    required this.onTap,
    super.key,
  });

  final _SpawnedSubagentTimelineEntry entry;
  final ProviderVisualTheme visual;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final child = entry.child;
    final provider = providerVisualThemeFor(child.providerId);
    final modelLabel =
        (store.modelsByProvider[child.providerId] ?? const <RemoteModel>[])
                .where((model) => model.id == child.modelId)
                .firstOrNull
                ?.displayName ??
            child.modelId;
    final childEffort = _concreteReasoningEffort(child.reasoningEffort);
    final metadata = <String>[
      provider.displayName,
      if (modelLabel?.trim().isNotEmpty == true) modelLabel!.trim(),
      if (childEffort != null)
        _effortDisplayLabel(
          childEffort,
          child.modelId,
          child.providerId,
        ),
    ].join(' · ');
    final stateLabel = switch (entry.state) {
      'completed' => 'Finished',
      'failed' => 'Failed',
      _ => 'Running',
    };
    final failed = entry.state == 'failed';
    final stateColor = failed
        ? Theme.of(context).colorScheme.error
        : entry.state == 'completed'
            ? Theme.of(context).colorScheme.onSurface.withValues(alpha: .62)
            : visual.accent;
    return Semantics(
      button: true,
      label: 'Open spawned sub-agent, $metadata, $stateLabel',
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          key: ValueKey<String>('spawned-subagent-${entry.id}'),
          borderRadius: BorderRadius.circular(8),
          overlayColor: _sessionPressOverlay(visual.accent),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 48),
            padding: const EdgeInsets.fromLTRB(8, 5, 5, 5),
            decoration: BoxDecoration(
              border: Border(
                bottom: BorderSide(
                  color: visual.border.withValues(alpha: .42),
                ),
              ),
            ),
            child: Row(
              children: <Widget>[
                Icon(
                  Icons.group_add_outlined,
                  size: 20,
                  color: visual.accent,
                ),
                const SizedBox(width: 9),
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        'Spawned sub-agent',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                      ),
                      Text(
                        metadata,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurface
                                  .withValues(alpha: .58),
                            ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                if (entry.state == 'running')
                  KeyedSubtree(
                    key: ValueKey<String>(
                        'spawned-subagent-spinner-${entry.childSessionId}'),
                    child: _WorkingSpinner(size: 16, color: stateColor),
                  )
                else
                  Icon(
                    entry.state == 'failed'
                        ? Icons.error_outline_rounded
                        : Icons.check_circle_outline_rounded,
                    key: ValueKey<String>(
                        'spawned-subagent-terminal-${entry.childSessionId}'),
                    size: 18,
                    color: stateColor,
                  ),
                const SizedBox(width: 5),
                Text(
                  stateLabel,
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                        color: stateColor,
                        fontWeight: FontWeight.w600,
                      ),
                ),
                Icon(
                  Icons.chevron_right_rounded,
                  size: 18,
                  color: Theme.of(context)
                      .colorScheme
                      .onSurface
                      .withValues(alpha: .54),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SessionComposerModelControl extends StatelessWidget {
  const _SessionComposerModelControl({
    required this.visual,
    required this.modelLabel,
    required this.modelEnabled,
    required this.reasoningLabel,
    required this.reasoningVisible,
    required this.effortIsUltra,
    required this.onTap,
  });

  final ProviderVisualTheme visual;
  final String modelLabel;
  final bool modelEnabled;
  final String reasoningLabel;
  final bool reasoningVisible;
  final bool effortIsUltra;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final subdued =
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.72);
    const ultra = Color(0xffa78bfa);
    final fullLabel =
        reasoningVisible ? '$modelLabel · $reasoningLabel' : modelLabel;
    final semanticLabel = reasoningVisible
        ? 'Model: $modelLabel. Reasoning: $reasoningLabel.'
        : 'Model: $modelLabel.';
    return SizedBox(
      height: 44,
      child: Tooltip(
        message: fullLabel,
        excludeFromSemantics: true,
        child: Semantics(
          key: const Key('model-control-semantics'),
          label: semanticLabel,
          button: true,
          enabled: modelEnabled,
          onTap: modelEnabled ? onTap : null,
          child: ExcludeSemantics(
            child: Center(
              child: TextButton(
                key: const Key('model-control'),
                onPressed: modelEnabled ? onTap : null,
                style: TextButton.styleFrom(
                  foregroundColor: subdued,
                  disabledForegroundColor: subdued,
                  backgroundColor: visual.surfaceRaised.withValues(alpha: .7),
                  padding: const EdgeInsets.fromLTRB(9, 4, 6, 4),
                  minimumSize: const Size(0, 32),
                  tapTargetSize: MaterialTapTargetSize.padded,
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10)),
                ),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Text.rich(
                        TextSpan(
                          children: <InlineSpan>[
                            TextSpan(
                              text: modelLabel,
                              style:
                                  const TextStyle(fontWeight: FontWeight.w600),
                            ),
                            if (reasoningVisible)
                              TextSpan(
                                text: '  ·  $reasoningLabel',
                                style: TextStyle(
                                  color: effortIsUltra ? ultra : subdued,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                          ],
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12.5),
                      ),
                    ),
                    if (modelEnabled) ...<Widget>[
                      const SizedBox(width: 3),
                      const Icon(Icons.expand_more_rounded, size: 17),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SessionSecondaryControlsMenu extends StatelessWidget {
  const _SessionSecondaryControlsMenu({
    required this.enabled,
    required this.wallet,
    required this.onWalletTap,
    required this.reasoningLabel,
    required this.reasoningVisible,
    required this.reasoningEnabled,
    required this.effortIsUltra,
    required this.onReasoningTap,
    required this.visionLabel,
    required this.visionEnabled,
    required this.onVisionTap,
    required this.deliveryLabel,
    required this.deliveryEnabled,
    required this.onDeliveryTap,
    required this.sideChatEnabled,
    required this.onSideChatTap,
    required this.dictationSourceEnabled,
    required this.onDictationSourceTap,
  });

  final bool enabled;
  final ProviderWalletStatus? wallet;
  final VoidCallback? onWalletTap;
  final String reasoningLabel;
  final bool reasoningVisible;
  final bool reasoningEnabled;
  final bool effortIsUltra;
  final VoidCallback onReasoningTap;
  final String visionLabel;
  final bool visionEnabled;
  final VoidCallback onVisionTap;
  final String deliveryLabel;
  final bool deliveryEnabled;
  final VoidCallback onDeliveryTap;
  final bool sideChatEnabled;
  final VoidCallback onSideChatTap;
  final bool dictationSourceEnabled;
  final VoidCallback onDictationSourceTap;

  @override
  Widget build(BuildContext context) {
    final subdued =
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.72);
    const ultra = Color(0xffa78bfa);
    return IconButton(
      key: const Key('session-secondary-controls'),
      tooltip: 'More task controls',
      onPressed: enabled
          ? () async {
              final value = await showModalBottomSheet<String>(
                context: context,
                useSafeArea: true,
                isScrollControlled: true,
                showDragHandle: true,
                sheetAnimationStyle: AnimationStyle.noAnimation,
                constraints: const BoxConstraints(maxWidth: 640),
                builder: (sheetContext) => SafeArea(
                  top: false,
                  child: ConstrainedBox(
                    constraints: BoxConstraints(
                      maxHeight: MediaQuery.sizeOf(sheetContext).height * .72,
                    ),
                    child: ListView(
                      shrinkWrap: true,
                      padding: const EdgeInsets.only(bottom: 8),
                      children: <Widget>[
                        ListTile(
                          key: const Key('dictation-source-control'),
                          enabled: dictationSourceEnabled,
                          leading: const Icon(Icons.mic_none_rounded, size: 19),
                          title: const Text('Dictation source'),
                          onTap: dictationSourceEnabled
                              ? () => Navigator.pop(
                                  sheetContext, 'dictation-source')
                              : null,
                        ),
                        if (wallet != null)
                          ListTile(
                            key: const Key('wallet-source-control'),
                            enabled: onWalletTap != null,
                            leading: Icon(
                              wallet!.requiresApiKey
                                  ? Icons.warning_amber_rounded
                                  : Icons.account_balance_wallet_outlined,
                              size: 19,
                              color: wallet!.isDirectApi
                                  ? const Color(0xff5aa9ff)
                                  : const Color(0xffffa552),
                            ),
                            title: Text(_walletSourceLabel(wallet!)),
                            onTap: onWalletTap == null
                                ? null
                                : () => Navigator.pop(sheetContext, 'wallet'),
                          ),
                        if (reasoningVisible)
                          ListTile(
                            key: const Key('reasoning-control'),
                            enabled: reasoningEnabled,
                            leading: Icon(Icons.psychology_outlined,
                                size: 19, color: effortIsUltra ? ultra : null),
                            title: Text(
                              reasoningLabel,
                              style: TextStyle(
                                  color: effortIsUltra ? ultra : null),
                            ),
                            onTap: reasoningEnabled
                                ? () => Navigator.pop(sheetContext, 'reasoning')
                                : null,
                          ),
                        ListTile(
                          key: const Key('delivery-control'),
                          enabled: deliveryEnabled,
                          leading: Icon(
                            deliveryLabel == 'Steer'
                                ? Icons.alt_route_rounded
                                : Icons.schedule_send_outlined,
                            size: 19,
                          ),
                          title: Text(deliveryLabel),
                          onTap: deliveryEnabled
                              ? () => Navigator.pop(sheetContext, 'delivery')
                              : null,
                        ),
                        ListTile(
                          key: const Key('vision-control'),
                          enabled: visionEnabled,
                          leading:
                              const Icon(Icons.visibility_outlined, size: 19),
                          title: Text(visionLabel,
                              maxLines: 1, overflow: TextOverflow.ellipsis),
                          onTap: visionEnabled
                              ? () => Navigator.pop(sheetContext, 'vision')
                              : null,
                        ),
                        ListTile(
                          key: const Key('open-side-chat'),
                          enabled: sideChatEnabled,
                          leading: const Icon(Icons.chat_bubble_outline_rounded,
                              size: 19),
                          title: const Text('Side chat'),
                          onTap: sideChatEnabled
                              ? () => Navigator.pop(sheetContext, 'side-chat')
                              : null,
                        ),
                      ],
                    ),
                  ),
                ),
              );
              if (!context.mounted || value == null) return;
              switch (value) {
                case 'wallet':
                  onWalletTap?.call();
                  break;
                case 'reasoning':
                  onReasoningTap();
                  break;
                case 'delivery':
                  onDeliveryTap();
                  break;
                case 'vision':
                  onVisionTap();
                  break;
                case 'side-chat':
                  onSideChatTap();
                  break;
                case 'dictation-source':
                  onDictationSourceTap();
                  break;
              }
            }
          : null,
      icon: const Icon(Icons.more_horiz_rounded, size: 23),
      style: IconButton.styleFrom(
        foregroundColor: subdued,
        padding: EdgeInsets.zero,
        minimumSize: const Size.square(44),
      ),
    );
  }
}

class _ImageModelNotice extends StatelessWidget {
  const _ImageModelNotice({
    required this.modelName,
    required this.visual,
    required this.onDismiss,
  });

  final String modelName;
  final ProviderVisualTheme visual;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const Key('text-only-image-notice'),
      margin: const EdgeInsets.fromLTRB(10, 1, 10, 3),
      padding: const EdgeInsets.only(left: 9),
      decoration: BoxDecoration(
        color: visual.surfaceRaised.withValues(alpha: 0.72),
        border: Border.all(color: visual.border.withValues(alpha: 0.7)),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        children: <Widget>[
          Icon(Icons.info_outline_rounded,
              size: 15,
              color: Theme.of(context)
                  .colorScheme
                  .onSurface
                  .withValues(alpha: 0.58)),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              '$modelName is listed as text-only, so it may reject this image.',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    fontSize: 11,
                    fontWeight: FontWeight.w400,
                    height: 1.25,
                    color: Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: 0.68),
                  ),
            ),
          ),
          IconButton(
            key: const Key('dismiss-text-only-image-notice'),
            tooltip: 'Dismiss',
            onPressed: onDismiss,
            visualDensity: VisualDensity.compact,
            iconSize: 17,
            icon: const Icon(Icons.close_rounded),
          ),
        ],
      ),
    );
  }
}

class _SessionHistoryError extends StatelessWidget {
  const _SessionHistoryError({
    required this.message,
    this.onRetry,
  });

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final displayMessage = compactErrorDetail(message);
    return Center(
      child: Padding(
        padding: EdgeInsets.symmetric(
          horizontal: 18,
          vertical: 18,
        ),
        child: Row(
          key: const Key('session-history-error'),
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.sync_problem_rounded,
                size: 18, color: Theme.of(context).colorScheme.error),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                displayMessage,
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
            if (onRetry != null) ...<Widget>[
              const SizedBox(width: 6),
              TextButton(onPressed: onRetry, child: const Text('Retry')),
            ],
          ],
        ),
      ),
    );
  }
}

bool _messageHasFinalContent(RemoteMessage message) => message.parts.any(
      (part) =>
          !part.isAttachment &&
          part.type != 'subagent' &&
          !_isToolTracePart(part) &&
          !_isArtifactPart(part) &&
          _messagePartText(part).trim().isNotEmpty &&
          !_isRawMarkupOnly(_messagePartText(part)),
    );

bool _shouldShowAssistantIdentity(List<RemoteMessage> messages, int index) {
  if (index < 0 || index >= messages.length) return false;
  final message = messages[index];
  if (message.role.toLowerCase() != 'assistant') return false;
  var firstInTurn = true;
  for (var cursor = index - 1; cursor >= 0; cursor -= 1) {
    final role = messages[cursor].role.toLowerCase();
    if (role == 'user') break;
    if (role == 'assistant') {
      firstInTurn = false;
      break;
    }
  }
  if (firstInTurn) return true;
  if (!_messageHasFinalContent(message)) return false;
  for (var cursor = index + 1; cursor < messages.length; cursor += 1) {
    final candidate = messages[cursor];
    if (candidate.role.toLowerCase() == 'user') break;
    if (candidate.role.toLowerCase() == 'assistant' &&
        _messageHasFinalContent(candidate)) {
      return false;
    }
  }
  return true;
}

bool _finalFollowsAssistantArtifacts(List<RemoteMessage> messages, int index) {
  if (index < 0 || index >= messages.length) return false;
  final message = messages[index];
  if (message.role.toLowerCase() != 'assistant' ||
      !_messageHasFinalContent(message)) {
    return false;
  }
  for (var cursor = index - 1; cursor >= 0; cursor -= 1) {
    final candidate = messages[cursor];
    final role = candidate.role.toLowerCase();
    if (role == 'user' || role == 'system') break;
    if (role != 'assistant') continue;
    if (_messageHasFinalContent(candidate)) return false;
    if (candidate.parts.any(_isArtifactPart)) return true;
  }
  return false;
}

bool _isConversationBoundary(RemoteMessage message) {
  if (message.role.toLowerCase() == 'system') return true;
  final text = message.parts.map(_messagePartText).join(' ').trim();
  if (text.toLowerCase().startsWith(
          'another language model started to solve this problem and produced a summary of its thinking process.') ||
      RegExp(r'^(?:(?:context|conversation|session)\s+(?:was\s+|has\s+been\s+|automatically\s+)?compacted(?:\s+successfully)?|(?:automatic\s+|context\s+|session\s+)?compaction\s+(?:complete|completed))[.!]?$',
              caseSensitive: false)
          .hasMatch(text)) {
    return true;
  }
  return message.parts.any((part) {
    final metadata = <Object?>[
      part.type,
      part.data['kind'],
      part.data['event'],
      part.data['eventType'],
      part.data['phase'],
    ].whereType<String>().join(' ').toLowerCase();
    return metadata.contains('compact');
  });
}

String _conversationBoundaryLabel(RemoteMessage message) {
  final text = message.parts.map(_messagePartText).join(' ').toLowerCase();
  final metadata = message.parts
      .expand((part) => <Object?>[
            part.type,
            part.data['kind'],
            part.data['event'],
            part.data['eventType'],
            part.data['phase'],
          ])
      .whereType<String>()
      .join(' ')
      .toLowerCase();
  final isCompaction = text.contains('earlier conversation summary') ||
      text.startsWith(
          'another language model started to solve this problem and produced a summary of its thinking process.') ||
      text.contains('compact') ||
      metadata.contains('compact');
  if (!isCompaction) return 'System context';
  return 'Session compacted';
}

String _conversationBoundaryDetail(RemoteMessage message) {
  final detail = message.parts.map(_messagePartText).join('\n\n').trim();
  if (RegExp(
          r'^(?:(?:context|conversation|session)\s+(?:was\s+|has\s+been\s+|automatically\s+)?compacted(?:\s+successfully)?|(?:automatic\s+|context\s+|session\s+)?compaction\s+(?:complete|completed))[.!]?$',
          caseSensitive: false)
      .hasMatch(detail)) {
    return 'Earlier conversation context was summarized so this task could continue within the model context window.';
  }
  return detail;
}

enum _AssistantTextTone { finalAnswer, commentary, privateReasoning }

enum _MessageAction { copy, edit }

enum _QueuedMessageAction { edit, deliver, disableQueue, sideChat, newTask }

enum _ReasoningDetailKind { thinking, toolCall }

enum _ReasoningDisplayMode { compact, expanded }

class _ReasoningDetail {
  const _ReasoningDetail({
    required this.id,
    required this.kind,
    required this.summary,
    required this.detail,
    this.activity,
  });

  final String id;
  final _ReasoningDetailKind kind;
  final String summary;
  final String detail;
  final _ActivityEventGroup? activity;
}

class _ReasoningSegment {
  const _ReasoningSegment({required this.kind, required this.details});

  final _ReasoningDetailKind kind;
  final List<_ReasoningDetail> details;
}

class _SpawnedSubagentTimelineEntry {
  const _SpawnedSubagentTimelineEntry({
    required this.id,
    required this.childSessionId,
    required this.child,
    required this.state,
  });

  final String id;
  final String childSessionId;
  final RemoteDelegationChild child;
  final String state;
}

String _delegationTimelineState(String taskState, String childState) {
  if (childState == 'failed') return 'failed';
  if (childState == 'completed' ||
      childState == 'idle' ||
      taskState == 'completed') {
    return 'completed';
  }
  if (taskState == 'failed') return 'failed';
  return 'running';
}

class _ConversationTimelineItem {
  _ConversationTimelineItem.message({
    required RemoteMessage message,
    required this.firstMessageIndex,
    required this.working,
    this.showFinalBoundary = false,
  })  : message = message,
        id = message.presentationId,
        spawnedSubagent = null,
        reasoningSegments = const <_ReasoningSegment>[];

  const _ConversationTimelineItem.reasoning({
    required this.id,
    required this.reasoningSegments,
    required this.working,
    this.firstMessageIndex,
  })  : message = null,
        spawnedSubagent = null,
        showFinalBoundary = false;

  const _ConversationTimelineItem.spawnedSubagent({
    required this.id,
    required this.spawnedSubagent,
    required this.working,
  })  : message = null,
        firstMessageIndex = null,
        reasoningSegments = const <_ReasoningSegment>[],
        showFinalBoundary = false;

  final String id;
  final RemoteMessage? message;
  final _SpawnedSubagentTimelineEntry? spawnedSubagent;
  final int? firstMessageIndex;
  final List<_ReasoningSegment> reasoningSegments;
  final bool working;
  final bool showFinalBoundary;
}

String _reasoningAnchorIdentity(_ConversationTimelineItem item) => item.id;

enum _TimelineSpeaker { user, assistant, neutral }

const double _turnBoundaryGap = 21;

_TimelineSpeaker _timelineSpeaker(_ConversationTimelineItem item) {
  if (item.reasoningSegments.isNotEmpty) return _TimelineSpeaker.assistant;
  return switch (item.message?.role.toLowerCase()) {
    'user' => _TimelineSpeaker.user,
    'assistant' => _TimelineSpeaker.assistant,
    _ => _TimelineSpeaker.neutral,
  };
}

Widget _withTurnBoundarySpacing({
  required List<_ConversationTimelineItem> items,
  required int index,
  required Widget child,
}) {
  if (index <= 0) return child;
  final previous = _timelineSpeaker(items[index - 1]);
  final current = _timelineSpeaker(items[index]);
  final crossesTurn = previous != current &&
      previous != _TimelineSpeaker.neutral &&
      current != _TimelineSpeaker.neutral;
  if (!crossesTurn) return child;
  return Padding(
    key: ValueKey<String>('turn-boundary-${items[index].id}'),
    padding: const EdgeInsets.only(top: _turnBoundaryGap),
    child: child,
  );
}

class _ConversationAtom {
  const _ConversationAtom.message({
    required this.message,
    required this.messageIndex,
    required this.occurredAt,
    required this.order,
    required this.working,
    this.showFinalBoundary = false,
  })  : reasoningSegments = const <_ReasoningSegment>[],
        spawnedSubagent = null,
        isMessage = true;

  const _ConversationAtom.reasoning({
    required this.reasoningSegments,
    required this.occurredAt,
    required this.order,
    required this.working,
    this.messageIndex,
  })  : message = null,
        spawnedSubagent = null,
        isMessage = false,
        showFinalBoundary = false;

  const _ConversationAtom.spawnedSubagent({
    required this.spawnedSubagent,
    required this.occurredAt,
    required this.order,
    required this.working,
  })  : message = null,
        messageIndex = null,
        reasoningSegments = const <_ReasoningSegment>[],
        isMessage = false,
        showFinalBoundary = false;

  final RemoteMessage? message;
  final _SpawnedSubagentTimelineEntry? spawnedSubagent;
  final int? messageIndex;
  final List<_ReasoningSegment> reasoningSegments;
  final DateTime occurredAt;
  final int order;
  final bool working;
  final bool isMessage;
  final bool showFinalBoundary;
}

class _EyesFailureFingerprint {
  _EyesFailureFingerprint(
      {required Set<String> identifiers, required this.notice})
      : identifiers = Set<String>.unmodifiable(identifiers);

  final Set<String> identifiers;
  final String notice;
}

bool _sameEyesFailure(
  _EyesFailureFingerprint left,
  _EyesFailureFingerprint right,
) {
  if (left.identifiers.isNotEmpty && right.identifiers.isNotEmpty) {
    return left.identifiers.any(right.identifiers.contains);
  }
  return false;
}

RemoteMessage _eyesFailureMessage({
  required String id,
  String? presentationId,
  required String sessionId,
  required DateTime occurredAt,
  required String notice,
}) =>
    RemoteMessage(
      id: id,
      presentationId: presentationId,
      sessionId: sessionId,
      role: 'assistant',
      createdAt: occurredAt,
      parts: <ContentPart>[
        ContentPart(
          type: 'reasoning',
          data: <String, Object?>{
            'phase': 'commentary',
            'text': notice,
            'notice': 'eyes_failure',
          },
        ),
      ],
      status: 'completed',
    );

List<RemoteMessage> _messagesWithMeshPresentations(
  List<RemoteMessage> history,
  List<RemoteDelegationTask> delegations,
) {
  final next = List<RemoteMessage>.of(history);
  final claimedMessageIndexes = <int>{};
  final legacyPromptCounts = <String, int>{};
  for (final task in delegations.where((task) =>
      task.orchestration == 'parent' &&
      task.presentationSegments.isNotEmpty &&
      task.parentTurnId == null)) {
    final prompt = task.prompt.trim();
    legacyPromptCounts[prompt] = (legacyPromptCounts[prompt] ?? 0) + 1;
  }
  for (final task in delegations) {
    if (task.orchestration != 'parent' || task.presentationSegments.isEmpty) {
      continue;
    }
    final meshPart = ContentPart(
      type: 'mesh',
      data: <String, Object?>{
        'type': 'mesh',
        'text': task.prompt,
        'segments': task.presentationSegments
            .map((segment) => segment.toJson())
            .toList(growable: false),
        'targets': (task.targets.isNotEmpty
                ? task.targets
                : task.children.map((child) => DelegationSelection(
                      providerId: child.providerId,
                      modelId: child.modelId,
                      reasoningEffort: child.reasoningEffort,
                    )))
            .map((target) => target.toJson())
            .toList(growable: false),
      },
    );
    final taskIdentifiers = <String>{
      task.id,
      if (task.parentTurnId?.trim().isNotEmpty == true)
        task.parentTurnId!.trim(),
    };
    int? matchIndex;
    for (var index = 0; index < next.length; index += 1) {
      if (claimedMessageIndexes.contains(index)) continue;
      final candidate = next[index];
      if (candidate.role.toLowerCase() != 'user') continue;
      final candidateIdentifiers = <String>{
        candidate.id,
        candidate.presentationId,
        if (candidate.providerMessageId?.trim().isNotEmpty == true)
          candidate.providerMessageId!.trim(),
      };
      if (candidateIdentifiers.any(taskIdentifiers.contains)) {
        matchIndex = index;
        break;
      }
    }
    // Older bridges may not expose the accepted parent turn ID. Retain a
    // narrow compatibility fallback only when both the Mesh request and the
    // nearby user message are unique; identical prompts are deliberately not
    // guessed so one target can never be painted onto another turn.
    if (matchIndex == null &&
        task.parentTurnId == null &&
        legacyPromptCounts[task.prompt.trim()] == 1) {
      final candidates = <(int, int)>[];
      for (var index = 0; index < next.length; index += 1) {
        if (claimedMessageIndexes.contains(index)) continue;
        final candidate = next[index];
        if (candidate.role.toLowerCase() != 'user') continue;
        final candidateText = candidate.parts
            .where((part) => part.type == 'text' || part.type == 'mesh')
            .map((part) => part.summary)
            .join('\n')
            .trim();
        if (candidateText != task.prompt.trim()) continue;
        final distance =
            candidate.createdAt.difference(task.createdAt).abs().inMilliseconds;
        if (distance <= const Duration(minutes: 2).inMilliseconds) {
          candidates.add((index, distance));
        }
      }
      if (candidates.length == 1) matchIndex = candidates.single.$1;
    }
    final presentationId = 'mesh-presentation-${task.id}';
    if (matchIndex != null) {
      final candidate = next[matchIndex];
      next[matchIndex] = RemoteMessage(
        id: candidate.id,
        presentationId: presentationId,
        sessionId: candidate.sessionId,
        role: candidate.role,
        createdAt: candidate.createdAt,
        parts: <ContentPart>[
          meshPart,
          ...candidate.parts
              .where((part) => part.type != 'text' && part.type != 'mesh'),
        ],
        status: candidate.status,
        editable: false,
        providerMessageId: candidate.providerMessageId,
      );
      claimedMessageIndexes.add(matchIndex);
      continue;
    }
    next.add(RemoteMessage(
      id: 'mesh-presentation-${task.id}',
      presentationId: presentationId,
      sessionId: task.parentSessionId,
      role: 'user',
      createdAt: task.createdAt,
      parts: <ContentPart>[meshPart],
      status: 'completed',
    ));
  }
  next.sort((left, right) => left.createdAt.compareTo(right.createdAt));
  return next;
}

List<_ConversationTimelineItem> _conversationTimelineItems(
  List<RemoteMessage> messages,
  List<_ActivityEventGroup> activities,
  List<RemoteDelegationTask> delegations,
  bool sessionWorking,
) {
  final atoms = <_ConversationAtom>[];
  final seenEyesFailures = <_EyesFailureFingerprint>[];
  for (final entry in messages.indexed) {
    final message = entry.$2;
    if (message.role.toLowerCase() != 'assistant' ||
        _isConversationBoundary(message)) {
      atoms.add(_ConversationAtom.message(
        message: message,
        messageIndex: entry.$1,
        occurredAt: message.createdAt,
        order: entry.$1 * 1000,
        working: message.status == 'streaming',
      ));
      continue;
    }
    _appendAssistantMessageAtoms(
      atoms,
      message: message,
      messageIndex: entry.$1,
      orderBase: entry.$1 * 1000,
      seenEyesFailures: seenEyesFailures,
    );
  }
  for (final entry in activities.indexed) {
    final group = entry.$2;
    final eyesFailure = _eyesFailureFromActivity(group);
    if (eyesFailure != null) {
      if (seenEyesFailures.any((seen) => _sameEyesFailure(seen, eyesFailure))) {
        continue;
      }
      seenEyesFailures.add(eyesFailure);
      atoms.add(_ConversationAtom.message(
        message: _eyesFailureMessage(
          id: 'eyes-failure-${group.events.first.eventId}',
          sessionId: group.events.first.sessionId ?? '',
          occurredAt: group.events.last.occurredAt,
          notice: eyesFailure.notice,
        ),
        messageIndex: null,
        occurredAt: group.events.last.occurredAt,
        order: messages.length * 1000 + entry.$1,
        working: false,
      ));
      continue;
    }
    final presentation = _activityPresentation(group);
    final providerSummary = _firstUsefulString(
      group.events.expand((event) => <Object?>[
            event.payload['summary'],
            event.payload['title'],
            event.payload['description'],
          ]),
    );
    final fallbackSummary = <String>[
      presentation.label,
      if (presentation.target?.isNotEmpty == true) presentation.target!,
    ].join(' ');
    final detail = _ReasoningDetail(
      id: 'activity-${group.events.first.eventId}',
      kind: _ReasoningDetailKind.toolCall,
      summary: _conciseReasoningLabel(providerSummary ?? fallbackSummary),
      detail: presentation.snippet,
      activity: group,
    );
    atoms.add(_ConversationAtom.reasoning(
      reasoningSegments: <_ReasoningSegment>[
        _ReasoningSegment(
          kind: _ReasoningDetailKind.toolCall,
          details: <_ReasoningDetail>[detail],
        ),
      ],
      occurredAt: group.events.first.occurredAt,
      order: messages.length * 1000 + entry.$1,
      working: sessionWorking && !_activityGroupFinished(group.events),
    ));
  }
  final seenMaterializedChildren = <String>{};
  for (final taskEntry in delegations.indexed) {
    final task = taskEntry.$2;
    for (final childEntry in task.children.indexed) {
      final child = childEntry.$2;
      final childSessionId = child.sessionId?.trim() ?? '';
      if (childSessionId.isEmpty) continue;
      final childId =
          child.id.trim().isEmpty ? childSessionId : child.id.trim();
      final identity = '${task.id}\u0000$childId\u0000$childSessionId';
      if (!seenMaterializedChildren.add(identity)) continue;
      final state = _delegationTimelineState(task.state, child.state);
      atoms.add(_ConversationAtom.spawnedSubagent(
        spawnedSubagent: _SpawnedSubagentTimelineEntry(
          id: '${task.id}:child:$childId',
          childSessionId: childSessionId,
          child: child,
          state: state,
        ),
        occurredAt: task.createdAt,
        order: messages.length * 1000 +
            activities.length +
            taskEntry.$1 * 100 +
            childEntry.$1,
        working: state == 'running',
      ));
    }
  }
  atoms.sort((left, right) {
    final date = left.occurredAt.compareTo(right.occurredAt);
    return date == 0 ? left.order.compareTo(right.order) : date;
  });

  // A parent model can retry EYES several times while answering one image
  // turn. Retain the provider records, but paint only the first calm failure
  // notice until the next real user message begins another turn.
  final visibleAtoms = <_ConversationAtom>[];
  var eyesFailureSeenInTurn = false;
  for (final atom in atoms) {
    final message = atom.message;
    if (message?.role.toLowerCase() == 'user') {
      eyesFailureSeenInTurn = false;
    }
    final eyesFailure = message != null && _isEyesFailureNoticeMessage(message);
    if (eyesFailure && eyesFailureSeenInTurn) continue;
    if (eyesFailure) eyesFailureSeenInTurn = true;
    visibleAtoms.add(atom);
  }

  final result = <_ConversationTimelineItem>[];
  for (final atom in visibleAtoms) {
    final spawnedSubagent = atom.spawnedSubagent;
    if (spawnedSubagent != null) {
      result.add(_ConversationTimelineItem.spawnedSubagent(
        id: spawnedSubagent.id,
        spawnedSubagent: spawnedSubagent,
        working: atom.working,
      ));
      continue;
    }
    if (atom.message != null) {
      result.add(_ConversationTimelineItem.message(
        message: atom.message!,
        firstMessageIndex: atom.messageIndex,
        working: atom.working,
        showFinalBoundary: atom.showFinalBoundary,
      ));
      continue;
    }
    if (result.isNotEmpty && result.last.reasoningSegments.isNotEmpty) {
      final previous = result.removeLast();
      final combined = <_ReasoningSegment>[...previous.reasoningSegments];
      _appendReasoningSegments(combined, atom.reasoningSegments);
      result.add(_ConversationTimelineItem.reasoning(
        id: previous.id,
        reasoningSegments: List<_ReasoningSegment>.unmodifiable(combined),
        firstMessageIndex: previous.firstMessageIndex,
        working: previous.working || atom.working,
      ));
      continue;
    }
    result.add(_ConversationTimelineItem.reasoning(
      id: atom.reasoningSegments.first.details.first.id,
      reasoningSegments:
          List<_ReasoningSegment>.unmodifiable(atom.reasoningSegments),
      firstMessageIndex: atom.messageIndex,
      working: atom.working,
    ));
  }
  // The newest reasoning is not always the last item: visible commentary can
  // follow it inside the same turn. Looking only at the final entry made a
  // present reasoning group look absent, which both dropped its shimmer and
  // added a second, redundant "Working…" disclosure beneath it.
  final latestReasoningIndex = sessionWorking
      ? result.lastIndexWhere((item) => item.reasoningSegments.isNotEmpty)
      : -1;
  final normalized = <_ConversationTimelineItem>[
    for (final entry in result.indexed)
      if (entry.$2.reasoningSegments.isNotEmpty)
        _ConversationTimelineItem.reasoning(
          id: entry.$2.id,
          reasoningSegments: entry.$2.reasoningSegments,
          firstMessageIndex: entry.$2.firstMessageIndex,
          working: entry.$1 == latestReasoningIndex,
        )
      else
        entry.$2,
  ];
  if (sessionWorking && latestReasoningIndex < 0) {
    normalized.add(const _ConversationTimelineItem.reasoning(
      id: 'tethoq-live-reasoning',
      reasoningSegments: <_ReasoningSegment>[
        _ReasoningSegment(
          kind: _ReasoningDetailKind.thinking,
          details: <_ReasoningDetail>[
            _ReasoningDetail(
              id: 'tethoq-live-reasoning-working',
              kind: _ReasoningDetailKind.thinking,
              summary: 'Working…',
              detail: 'Working…',
            ),
          ],
        ),
      ],
      working: true,
    ));
  }
  return normalized;
}

bool _isEyesFailureNoticeMessage(RemoteMessage message) =>
    message.parts.any((part) => part.data['notice'] == 'eyes_failure');

void _appendAssistantMessageAtoms(
  List<_ConversationAtom> atoms, {
  required RemoteMessage message,
  required int messageIndex,
  required int orderBase,
  required List<_EyesFailureFingerprint> seenEyesFailures,
}) {
  if (!message.parts.any(_isReasoningTracePart)) {
    atoms.add(_ConversationAtom.message(
      message: message,
      messageIndex: messageIndex,
      occurredAt: message.createdAt,
      order: orderBase,
      working: message.status == 'streaming',
    ));
    return;
  }
  final attachments =
      message.parts.where((part) => part.isAttachment).toList(growable: false);
  final visibleParts = <ContentPart>[];
  var attachmentsPlaced = false;
  var chunkIndex = 0;
  var partOrder = 0;
  var reasoningSinceVisible = false;

  void flushVisible() {
    if (visibleParts.isEmpty) return;
    final parts = <ContentPart>[
      if (!attachmentsPlaced) ...attachments,
      ...visibleParts,
    ];
    attachmentsPlaced = true;
    final synthetic = RemoteMessage(
      id: '${message.id}-visible-$chunkIndex',
      presentationId: '${message.presentationId}-visible-$chunkIndex',
      sessionId: message.sessionId,
      role: message.role,
      createdAt: message.createdAt,
      parts: List<ContentPart>.unmodifiable(parts),
      status: message.status,
      editable: message.editable,
      providerMessageId: message.providerMessageId,
      origin: message.origin,
    );
    atoms.add(_ConversationAtom.message(
      message: synthetic,
      messageIndex: messageIndex,
      occurredAt: message.createdAt,
      order: orderBase + partOrder,
      working: message.status == 'streaming',
      showFinalBoundary: reasoningSinceVisible,
    ));
    visibleParts.clear();
    chunkIndex += 1;
    partOrder += 1;
    reasoningSinceVisible = false;
  }

  for (final entry in message.parts.indexed) {
    final part = entry.$2;
    if (part.isAttachment) continue;
    final eyesFailure = _eyesFailureFromPart(part);
    if (eyesFailure != null) {
      flushVisible();
      if (!seenEyesFailures
          .any((seen) => _sameEyesFailure(seen, eyesFailure))) {
        seenEyesFailures.add(eyesFailure);
        atoms.add(_ConversationAtom.message(
          message: _eyesFailureMessage(
            id: '${message.id}-eyes-failure-${entry.$1}',
            presentationId:
                '${message.presentationId}-eyes-failure-${entry.$1}',
            sessionId: message.sessionId,
            occurredAt: message.createdAt,
            notice: eyesFailure.notice,
          ),
          messageIndex: null,
          occurredAt: message.createdAt,
          order: orderBase + partOrder,
          working: false,
        ));
      }
      partOrder += 1;
      reasoningSinceVisible = false;
      continue;
    }
    if (_isReasoningTracePart(part)) {
      flushVisible();
      atoms.add(_ConversationAtom.reasoning(
        reasoningSegments: _reasoningSegmentsFromParts(
            '${message.presentationId}-part-${entry.$1}', <ContentPart>[part]),
        messageIndex: messageIndex,
        occurredAt: message.createdAt,
        order: orderBase + partOrder,
        working: message.status == 'streaming',
      ));
      partOrder += 1;
      reasoningSinceVisible = true;
    } else {
      visibleParts.add(part);
    }
  }
  flushVisible();
  if (!attachmentsPlaced && attachments.isNotEmpty) {
    final synthetic = RemoteMessage(
      id: '${message.id}-attachments',
      presentationId: '${message.presentationId}-attachments',
      sessionId: message.sessionId,
      role: message.role,
      createdAt: message.createdAt,
      parts: attachments,
      status: message.status,
      editable: message.editable,
      providerMessageId: message.providerMessageId,
      origin: message.origin,
    );
    atoms.add(_ConversationAtom.message(
      message: synthetic,
      messageIndex: messageIndex,
      occurredAt: message.createdAt,
      order: orderBase + partOrder,
      working: message.status == 'streaming',
    ));
  }
}

void _appendReasoningSegments(
  List<_ReasoningSegment> target,
  List<_ReasoningSegment> incoming,
) {
  for (final segment in incoming) {
    if (target.isNotEmpty &&
        target.last.kind == _ReasoningDetailKind.toolCall &&
        segment.kind == _ReasoningDetailKind.toolCall) {
      final previous = target.removeLast();
      target.add(_ReasoningSegment(
        kind: _ReasoningDetailKind.toolCall,
        details: <_ReasoningDetail>[...previous.details, ...segment.details],
      ));
    } else {
      target.add(segment);
    }
  }
}

List<_ReasoningSegment> _reasoningSegmentsFromParts(
  String messageId,
  List<ContentPart> parts,
) {
  final result = <_ReasoningSegment>[];
  for (final entry in parts.indexed) {
    final part = entry.$2;
    final kind = _isToolTracePart(part)
        ? _ReasoningDetailKind.toolCall
        : _ReasoningDetailKind.thinking;
    final detail = _ReasoningDetail(
      id: '$messageId-${kind.name}-${entry.$1}',
      kind: kind,
      summary: _reasoningPartSummary(part),
      detail: _reasoningPartDetail(part),
    );
    if (kind == _ReasoningDetailKind.toolCall &&
        result.isNotEmpty &&
        result.last.kind == kind) {
      final previous = result.removeLast();
      result.add(_ReasoningSegment(
        kind: kind,
        details: <_ReasoningDetail>[...previous.details, detail],
      ));
    } else {
      result.add(_ReasoningSegment(
        kind: kind,
        details: <_ReasoningDetail>[detail],
      ));
    }
  }
  return result;
}

bool _isReasoningTracePart(ContentPart part) =>
    _assistantTextTone(part, false) == _AssistantTextTone.privateReasoning ||
    _isToolTracePart(part);

bool _isToolTracePart(ContentPart part) {
  final type = part.type.toLowerCase();
  if (const <String>{'command', 'tool', 'file_change', 'error'}
      .contains(type)) {
    return true;
  }
  final phase = '${part.data['phase'] ?? ''}'.toLowerCase();
  final kind = '${part.data['kind'] ?? ''}'.toLowerCase();
  return phase.contains('tool') || kind.contains('tool');
}

bool _isEyesToolName(String value) {
  final normalized = value
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9]+'), '_')
      .replaceAll(RegExp(r'^_+|_+$'), '');
  return normalized == 'ask_eyes' ||
      normalized.endsWith('_ask_eyes') ||
      normalized == 'tethoq_turn_support' ||
      normalized.endsWith('_tethoq_turn_support') ||
      normalized == 'ask_visual_support';
}

_EyesFailureFingerprint? _eyesFailureFromPart(ContentPart part) {
  final toolName = _firstUsefulString(<Object?>[
    part.data['tool'],
    part.data['name'],
    part.data['toolName'],
    part.data['tool_name'],
    part.data['title'],
    part.data['label'],
  ]);
  if (toolName == null || !_isEyesToolName(toolName)) return null;
  final statuses = _activityStrings(
    part.data,
    const <String>{'status'},
  ).map((value) => value.toLowerCase());
  final failed = part.type.toLowerCase() == 'error' ||
      statuses.any((status) => status == 'failed' || status == 'error');
  if (!failed) return null;
  final raw = _activityStrings(
    part.data,
    const <String>{
      'output',
      'error',
      'message',
      'text',
      'result',
      'content',
      'detail',
    },
  ).join(' ');
  return _EyesFailureFingerprint(
    identifiers: _eyesFailureIdentifiers(part.data),
    notice: _safeEyesFailureNotice(raw),
  );
}

Set<String> _eyesFailureIdentifiers(Map<Object?, Object?> source) =>
    _activityStrings(
      source,
      const <String>{
        'callId',
        'callID',
        'call_id',
        'toolCallId',
        'toolCallID',
        'tool_call_id',
        'partId',
        'partID',
        'part_id',
        'providerPartId',
        'provider_part_id',
      },
    ).map((value) => value.trim()).where((value) => value.isNotEmpty).toSet();

String _safeEyesFailureNotice(String raw) {
  final normalized = raw.toLowerCase();
  if (RegExp(
          r'\b(?:429|quota|rate[_ -]?limit|usage[_ -]?limit|resource[_ -]?exhausted|insufficient (?:balance|credit)|billing)\b')
      .hasMatch(normalized)) {
    return 'EYES could not use the selected model because its usage limit was reached or it is temporarily rate-limited. Check the provider account or choose another EYES model.';
  }
  if (RegExp(
          r'\b(?:401|403|unauthori[sz]ed|forbidden|api[_ -]?key|credential|auth(?:entication|ori[sz]ation)?)\b')
      .hasMatch(normalized)) {
    return 'EYES could not use the selected model because its API key is missing, invalid, or no longer accepted. Update the key in EYES settings and try again.';
  }
  if (RegExp(r'\b(?:timed? out|timeout|deadline)\b').hasMatch(normalized)) {
    return 'EYES did not finish inspecting the image. Try again or choose another EYES model.';
  }
  if (RegExp(r'\b(?:abort(?:ed)?|cancel(?:led|ed)?|interrupt(?:ed)?)\b')
      .hasMatch(normalized)) {
    return 'EYES was interrupted before it finished inspecting the image. Try again when you are ready.';
  }
  return 'EYES could not inspect the image. Try again or choose another EYES model.';
}

String _reasoningPartSummary(ContentPart part) {
  if (_eyesFailureFromPart(part) != null) return 'EYES';
  final providerSummary = _firstUsefulString(<Object?>[
    part.data['summary'],
    part.data['shortSummary'],
    part.data['short_summary'],
    part.data['title'],
    part.data['label'],
  ]);
  if (providerSummary != null) {
    return _conciseReasoningLabel(providerSummary);
  }
  if (_isToolTracePart(part)) {
    final name = _firstUsefulString(<Object?>[
          part.data['name'],
          part.data['tool'],
          part.data['toolName'],
          part.data['command'],
          part.data['path'],
        ]) ??
        part.summary;
    return _conciseReasoningLabel(name.isEmpty ? 'Tool call' : name);
  }
  return _conciseReasoningLabel(_messagePartText(part));
}

String _reasoningPartDetail(ContentPart part) {
  final eyesFailure = _eyesFailureFromPart(part);
  if (eyesFailure != null) return eyesFailure.notice;
  final direct = _firstUsefulString(<Object?>[
    part.data['text'],
    part.data['output'],
    part.data['result'],
    part.data['content'],
    part.data['command'],
    part.data['diff'],
    part.data['message'],
    part.data['path'],
  ]);
  return direct ?? _messagePartText(part);
}

String? _firstUsefulString(Iterable<Object?> values) {
  for (final value in values) {
    if (value is String && value.trim().isNotEmpty) return value.trim();
  }
  return null;
}

String _conciseReasoningLabel(String value, {int maxLength = 92}) {
  final normalized = value
      .replaceAll('_', ' ')
      .replaceAll(RegExp(r'[`*_#]+'), '')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  if (normalized.isEmpty) return 'Details';
  final sentence = RegExp(r'^.*?(?:[.!?](?:\s|$)|$)')
          .firstMatch(normalized)
          ?.group(0)
          ?.trim() ??
      normalized;
  if (sentence.length <= maxLength) return sentence;
  final clipped = sentence.substring(0, maxLength - 1).trimRight();
  final lastSpace = clipped.lastIndexOf(' ');
  final clean = lastSpace > maxLength * .62
      ? clipped.substring(0, lastSpace).trimRight()
      : clipped;
  return '$clean…';
}

String _copyableMessageText(RemoteMessage message) {
  final role = message.role.toLowerCase();
  if (role != 'user' && role != 'assistant') return '';
  final visible = message.parts
      .where((part) =>
          part.type == 'text' ||
          (role == 'assistant' &&
              part.type == 'reasoning' &&
              part.data['phase'] == 'commentary'))
      .map((part) => _withoutMemoryCitation(_messagePartText(
            part,
            stripAttachmentEnvelope: role == 'user',
          )))
      .where((text) => text.isNotEmpty && !_isRawMarkupOnly(text))
      .join('\n\n')
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
      .split('\n')
      .map((line) => line.replaceFirst(RegExp(r'[ \t]+$'), ''))
      .join('\n')
      .replaceAll(RegExp(r'\n{3,}'), '\n\n')
      .trim();
  return visible;
}

_AssistantTextTone _assistantTextTone(ContentPart part, bool isUser) {
  if (isUser || !_isArtifactPart(part)) {
    return !isUser && _isToolTracePart(part)
        ? _AssistantTextTone.privateReasoning
        : _AssistantTextTone.finalAnswer;
  }
  if (part.type == 'reasoning' && part.data['phase'] != 'commentary') {
    return _AssistantTextTone.privateReasoning;
  }
  return _AssistantTextTone.commentary;
}

class _WorkflowMessageAttachment extends StatelessWidget {
  const _WorkflowMessageAttachment({
    required this.part,
    required this.visual,
    super.key,
  });

  final ContentPart part;
  final ProviderVisualTheme visual;

  JsonMap get _workflow {
    final value = part.data['workflow'];
    return value is Map<Object?, Object?>
        ? value.map((key, value) => MapEntry(key.toString(), value))
        : const <String, Object?>{};
  }

  String get _name => optionalString(_workflow, 'name') ?? 'Recorded workflow';
  int get _events =>
      _workflow['eventCount'] is int ? _workflow['eventCount']! as int : 0;
  int get _screenshots => _workflow['screenshotCount'] is int
      ? _workflow['screenshotCount']! as int
      : 0;
  List<String> get _applications => (_workflow['applications'] is List<Object?>
          ? _workflow['applications']! as List<Object?>
          : const <Object?>[])
      .whereType<String>()
      .take(8)
      .toList(growable: false);

  void _open(BuildContext context) {
    unawaited(showDialog<void>(
      context: context,
      builder: (dialogContext) => Dialog(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(children: <Widget>[
                  Icon(Icons.account_tree_outlined,
                      size: 20, color: visual.accent),
                  const SizedBox(width: 9),
                  Expanded(
                      child: Text(_name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.w600))),
                  IconButton(
                    tooltip: 'Close',
                    onPressed: () => Navigator.of(dialogContext).pop(),
                    icon: const Icon(Icons.close, size: 19),
                  ),
                ]),
                Text('Recorded workflow attached to this message.',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: .62))),
                const SizedBox(height: 14),
                Row(children: <Widget>[
                  Expanded(
                      child:
                          _WorkflowMetric(label: 'Events', value: '$_events')),
                  const SizedBox(width: 8),
                  Expanded(
                      child: _WorkflowMetric(
                          label: 'Screenshots', value: '$_screenshots')),
                ]),
                if (_applications.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 12),
                  Text('Captured in ${_applications.join(', ')}',
                      style: Theme.of(context).textTheme.bodySmall),
                ],
              ],
            ),
          ),
        ),
      ),
    ));
  }

  @override
  Widget build(BuildContext context) => Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: () => _open(context),
          borderRadius: BorderRadius.circular(7),
          child: Ink(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(
              color: visual.surfaceRaised.withValues(alpha: .9),
              borderRadius: BorderRadius.circular(7),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: <Widget>[
              Icon(Icons.account_tree_outlined,
                  size: 18, color: visual.accent.withValues(alpha: .82)),
              const SizedBox(width: 8),
              Flexible(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(_name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            fontSize: 12, fontWeight: FontWeight.w600)),
                    Text('$_events events · $_screenshots screenshots',
                        style: TextStyle(
                            fontSize: 11,
                            color: Theme.of(context)
                                .colorScheme
                                .onSurface
                                .withValues(alpha: .54))),
                  ],
                ),
              ),
            ]),
          ),
        ),
      );
}

class _WorkflowMetric extends StatelessWidget {
  const _WorkflowMetric({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => DecoratedBox(
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(7),
        ),
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(label.toUpperCase(),
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      fontSize: 11,
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: .5))),
              const SizedBox(height: 3),
              Text(value),
            ],
          ),
        ),
      );
}

class _MeshMessageText extends StatelessWidget {
  const _MeshMessageText({
    required this.part,
    required this.messageId,
    super.key,
  });

  final ContentPart part;
  final String messageId;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    try {
      final targets = jsonList(part.data['targets'])
          .map(DelegationSelection.fromJson)
          .toList(growable: false);
      final segments = jsonList(part.data['segments'])
          .map(RemoteMeshPresentationSegment.fromJson)
          .toList(growable: false);
      final spans = <InlineSpan>[];
      for (final segment in segments) {
        if (segment.type == 'text') {
          spans.add(TextSpan(text: segment.text ?? ''));
          continue;
        }
        final index = segment.targetIndex;
        if (index == null || index < 0 || index >= targets.length) continue;
        spans.add(WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: _InlineMeshTargetChip(
            key: ValueKey<String>('sent-mesh-target-$messageId-$index'),
            target: targets[index],
            store: store,
          ),
        ));
      }
      if (spans.isEmpty) throw const FormatException('Empty Mesh presentation');
      return SelectionArea(
        child: Text.rich(
          TextSpan(
            style:
                Theme.of(context).textTheme.bodyMedium?.copyWith(height: 1.42),
            children: spans,
          ),
        ),
      );
    } on Object {
      return Text(
        part.summary,
        style: Theme.of(context).textTheme.bodyMedium?.copyWith(height: 1.42),
      );
    }
  }
}

class _MessageCard extends StatelessWidget {
  const _MessageCard({
    required this.message,
    required this.visual,
    required this.providerId,
    required this.showIdentity,
    this.streaming = false,
    this.shimmerPrivateReasoning = false,
    this.showFinalBoundary = false,
    this.editEnabled = false,
    this.onLongPress,
    super.key,
  });

  final RemoteMessage message;
  final ProviderVisualTheme visual;
  final String providerId;
  final bool showIdentity;
  final bool streaming;
  final bool shimmerPrivateReasoning;
  final bool showFinalBoundary;
  final bool editEnabled;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final isUser = message.role.toLowerCase() == 'user';
    final presentationId = message.presentationId;
    if (_isConversationBoundary(message)) {
      return _ConversationBoundary(
        messageId: presentationId,
        label: _conversationBoundaryLabel(message),
        detail: _conversationBoundaryDetail(message),
      );
    }
    final meshEnvelope = isUser
        ? message.parts
            .where((part) => part.type == 'text')
            .map((part) => part.summary)
            .where((text) => text.startsWith('[[UAR_MESH_RESULT:'))
            .firstOrNull
        : null;
    if (meshEnvelope != null) {
      return _MeshResultContextCard(messageId: presentationId, visual: visual);
    }
    final legacyAttachments = isUser
        ? message.parts
            .expand((part) => _legacyAttachmentNames(part.summary))
            .toList(growable: false)
        : const <String>[];
    final hasMemoryContext = !isUser &&
        message.parts.any((part) => _hasMemoryCitation(part.summary));
    final meshParts = isUser
        ? message.parts
            .where((part) => part.type == 'mesh')
            .toList(growable: false)
        : const <ContentPart>[];
    final renderedParts = message.parts
        .where((part) =>
            !part.isAttachment &&
            part.type != 'mesh' &&
            part.type != 'subagent' &&
            part.type != 'workflow')
        .map((part) => (
              text: _withoutMemoryCitation(
                  _messagePartText(part, stripAttachmentEnvelope: isUser)),
              tone: _assistantTextTone(part, isUser),
            ))
        .where((part) => part.text.isNotEmpty && !_isRawMarkupOnly(part.text))
        .toList(growable: false);
    final attachmentParts = message.parts
        .where((part) => part.isAttachment)
        .toList(growable: false);
    final subagentParts = message.parts
        .where((part) => part.type == 'subagent')
        .toList(growable: false);
    final workflowParts = message.parts
        .where((part) => part.type == 'workflow')
        .toList(growable: false);
    final attachments = attachmentParts.indexed
        .map((entry) => _MessageAttachmentView.fromPart(
              entry.$2,
              fallbackName: entry.$1 < legacyAttachments.length
                  ? legacyAttachments[entry.$1]
                  : null,
            ))
        .toList(growable: false);
    final representedNames =
        attachments.map((attachment) => attachment.name.toLowerCase()).toSet();
    final fallbackAttachments = legacyAttachments
        .where((name) => !representedNames.contains(name.toLowerCase()))
        .map(_MessageAttachmentView.filenameOnly)
        .toList(growable: false);
    final displayedAttachments = <_MessageAttachmentView>[
      ...attachments,
      ...fallbackAttachments,
    ];
    final displayedImageCount = displayedAttachments
        .where((attachment) => attachment.imageUri != null)
        .length;
    if (renderedParts.isEmpty &&
        displayedAttachments.isEmpty &&
        meshParts.isEmpty &&
        subagentParts.isEmpty &&
        workflowParts.isEmpty &&
        !hasMemoryContext) {
      return const SizedBox.shrink();
    }
    final newestPrivateReasoningIndex = renderedParts.lastIndexWhere(
      (part) => part.tone == _AssistantTextTone.privateReasoning,
    );
    final firstFinalIndex = renderedParts
        .indexWhere((part) => part.tone == _AssistantTextTone.finalAnswer);
    final hasEarlierArtifactInMessage = firstFinalIndex > 0 &&
        renderedParts
            .take(firstFinalIndex)
            .any((part) => part.tone != _AssistantTextTone.finalAnswer);
    final background = isUser
        ? Color.alphaBlend(
            visual.accent.withValues(alpha: 0.16), visual.surfaceRaised)
        : Colors.transparent;
    final borderColor = isUser
        ? visual.accent.withValues(alpha: 0.34)
        : visual.border.withValues(alpha: 0.76);
    final imageOnlyUserMessage = isUser &&
        renderedParts.isEmpty &&
        displayedAttachments.isNotEmpty &&
        displayedAttachments.every((attachment) => attachment.isImage) &&
        meshParts.isEmpty &&
        subagentParts.isEmpty &&
        workflowParts.isEmpty;
    return Align(
      key: ValueKey<String>('message-align-$presentationId'),
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (!isUser)
            SizedBox(
              width: 34,
              child: showIdentity
                  ? Padding(
                      padding: const EdgeInsets.only(top: 9),
                      child: ProviderLogo(
                        key: ValueKey<String>(
                            'assistant-identity-$presentationId'),
                        providerId: providerId,
                        size: 28,
                      ),
                    )
                  : null,
            ),
          Flexible(
            child: Column(
              crossAxisAlignment:
                  isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                if (message.origin?.kind == 'cross_session')
                  Padding(
                    padding: const EdgeInsets.fromLTRB(4, 2, 4, 0),
                    child: Text(
                      message.origin?.sourceTitle?.trim().isNotEmpty == true
                          ? 'From another Tethoq task · ${message.origin!.sourceTitle!.trim()}'
                          : 'From another Tethoq task',
                      key: ValueKey<String>('message-origin-$presentationId'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                            fontSize: 12,
                            color: Theme.of(context)
                                .colorScheme
                                .onSurface
                                .withValues(alpha: .56),
                          ),
                    ),
                  ),
                GestureDetector(
                  behavior: HitTestBehavior.translucent,
                  onLongPress: onLongPress,
                  child: AbsorbPointer(
                    absorbing: editEnabled &&
                        !displayedAttachments
                            .any((attachment) => attachment.imageUri != null),
                    child: Container(
                      key: ValueKey<String>('message-bubble-$presentationId'),
                      constraints: BoxConstraints(
                          maxWidth: MediaQuery.sizeOf(context).width *
                              (isUser ? 0.78 : 0.82)),
                      margin: const EdgeInsets.symmetric(vertical: 5),
                      padding: isUser
                          ? imageOnlyUserMessage
                              ? const EdgeInsets.all(6)
                              : const EdgeInsets.fromLTRB(13, 10, 13, 8)
                          : const EdgeInsets.fromLTRB(4, 7, 5, 5),
                      decoration: BoxDecoration(
                        color: background,
                        border: isUser ? Border.all(color: borderColor) : null,
                        borderRadius: isUser
                            ? const BorderRadius.only(
                                topLeft: Radius.circular(8),
                                topRight: Radius.circular(2),
                                bottomLeft: Radius.circular(8),
                                bottomRight: Radius.circular(8),
                              )
                            : null,
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          ...workflowParts.indexed.map((entry) => Padding(
                                padding: EdgeInsets.only(
                                    bottom: renderedParts.isNotEmpty ||
                                            displayedAttachments.isNotEmpty ||
                                            subagentParts.isNotEmpty ||
                                            entry.$1 < workflowParts.length - 1
                                        ? 8
                                        : 0),
                                child: _WorkflowMessageAttachment(
                                  key: ValueKey<String>(
                                      'message-workflow-$presentationId-${entry.$1}'),
                                  part: entry.$2,
                                  visual: visual,
                                ),
                              )),
                          if (imageOnlyUserMessage)
                            _MessageImageGallery(
                              messageId: presentationId,
                              attachments: displayedAttachments,
                              visual: visual,
                            )
                          else
                            ...displayedAttachments.indexed.map((entry) =>
                                Padding(
                                  padding: EdgeInsets.only(
                                      bottom: renderedParts.isNotEmpty ||
                                              subagentParts.isNotEmpty ||
                                              entry.$1 <
                                                  displayedAttachments.length -
                                                      1
                                          ? 8
                                          : 0),
                                  child: entry.$2.audioUri != null
                                      ? ConstrainedBox(
                                          key: ValueKey<String>(
                                              'message-audio-$presentationId-${entry.$1}'),
                                          constraints: const BoxConstraints(
                                              maxWidth: 250),
                                          child: AudioMessageWidget(
                                            uri: entry.$2.audioUri!,
                                            name: entry.$2.name,
                                            mimeType: entry.$2.audioMimeType ??
                                                'audio/mpeg',
                                            accent: visual.accent,
                                          ),
                                        )
                                      : entry.$2.imageUri == null
                                          ? _AttachmentFileLabel(
                                              key: ValueKey<String>(
                                                  'message-file-$presentationId-${entry.$1}'),
                                              attachment: entry.$2,
                                              visual: visual,
                                            )
                                          : ClipRRect(
                                              key: ValueKey<String>(
                                                  'message-image-$presentationId-${entry.$1}'),
                                              borderRadius:
                                                  BorderRadius.circular(5),
                                              child: _ExpandableMessageImage(
                                                buttonKey: ValueKey<String>(
                                                    'expand-message-image-$presentationId-${entry.$1}'),
                                                semanticLabel:
                                                    'Expand image ${displayedAttachments.take(entry.$1 + 1).where((attachment) => attachment.imageUri != null).length} of $displayedImageCount: ${entry.$2.name}',
                                                imageUri: entry.$2.imageUri!,
                                                name: entry.$2.name,
                                                fit: BoxFit.cover,
                                                width: 260,
                                                height: 170,
                                                cacheWidth: 520,
                                                fallback: _AttachmentFileLabel(
                                                  attachment: entry.$2,
                                                  visual: visual,
                                                ),
                                              ),
                                            ),
                                )),
                          if (subagentParts.isNotEmpty)
                            Padding(
                              padding: EdgeInsets.only(
                                  bottom: renderedParts.isNotEmpty ||
                                          meshParts.isNotEmpty
                                      ? 8
                                      : 0),
                              child: _SubagentActivityGroup(
                                key: ValueKey<String>(
                                    'subagent-activity-group-$presentationId'),
                                parts: subagentParts,
                                visual: visual,
                              ),
                            ),
                          ...meshParts.indexed.map((entry) => Padding(
                                padding: EdgeInsets.only(
                                    bottom: renderedParts.isNotEmpty ||
                                            entry.$1 < meshParts.length - 1
                                        ? 7
                                        : 0),
                                child: _MeshMessageText(
                                  key: ValueKey<String>(
                                      'mesh-message-$presentationId-${entry.$1}'),
                                  part: entry.$2,
                                  messageId: presentationId,
                                ),
                              )),
                          ...renderedParts.indexed.map((entry) {
                            final privateReasoning = entry.$2.tone ==
                                _AssistantTextTone.privateReasoning;
                            final commentary =
                                entry.$2.tone == _AssistantTextTone.commentary;
                            final style = Theme.of(context)
                                .textTheme
                                .bodyMedium
                                ?.copyWith(
                                  height: 1.42,
                                  color: privateReasoning
                                      ? Theme.of(context)
                                          .colorScheme
                                          .onSurface
                                          .withValues(alpha: 0.56)
                                      : commentary
                                          ? Theme.of(context)
                                              .colorScheme
                                              .onSurface
                                              .withValues(alpha: 0.82)
                                          : null,
                                  fontStyle: privateReasoning
                                      ? FontStyle.italic
                                      : FontStyle.normal,
                                  fontWeight: FontWeight.w400,
                                );
                            final artifact =
                                entry.$2.tone != _AssistantTextTone.finalAnswer;
                            final activePrivateReasoning = streaming &&
                                shimmerPrivateReasoning &&
                                privateReasoning &&
                                entry.$1 == newestPrivateReasoningIndex;
                            final text = artifact
                                ? _ArtifactMessageText(
                                    key: activePrivateReasoning
                                        ? ValueKey<String>(
                                            'artifact-shimmer-$presentationId')
                                        : null,
                                    text: entry.$2.text,
                                    style: style,
                                    visual: visual,
                                    active: activePrivateReasoning,
                                  )
                                : _SafeMessageMarkdown(
                                    text: entry.$2.text,
                                    style: style,
                                    visual: visual,
                                  );
                            return Padding(
                              padding: EdgeInsets.only(
                                  bottom: entry.$1 == renderedParts.length - 1
                                      ? 0
                                      : 7),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisSize: MainAxisSize.min,
                                children: <Widget>[
                                  if (entry.$1 == firstFinalIndex &&
                                      (showFinalBoundary ||
                                          hasEarlierArtifactInMessage))
                                    _FinalAnswerDivider(
                                      messageId: presentationId,
                                    ),
                                  text,
                                ],
                              ),
                            );
                          }),
                          if (hasMemoryContext) ...<Widget>[
                            if (renderedParts.isNotEmpty ||
                                displayedAttachments.isNotEmpty ||
                                subagentParts.isNotEmpty)
                              const SizedBox(height: 8),
                            _MemoryContextIndicator(visual: visual),
                          ],
                          if (streaming) ...<Widget>[
                            const SizedBox(height: 6),
                            SizedBox.square(
                              dimension: 10,
                              child: CircularProgressIndicator(
                                  strokeWidth: 1.5, color: visual.accent),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ConversationBoundary extends StatefulWidget {
  const _ConversationBoundary({
    required this.messageId,
    required this.label,
    required this.detail,
  });

  final String messageId;
  final String label;
  final String detail;

  @override
  State<_ConversationBoundary> createState() => _ConversationBoundaryState();
}

class _ConversationBoundaryState extends State<_ConversationBoundary> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final color =
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.42);
    final isCompaction = widget.label == 'Session compacted';
    return Semantics(
      key: ValueKey<String>('conversation-boundary-${widget.messageId}'),
      container: true,
      label: widget.label,
      button: isCompaction,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 34, vertical: 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            InkWell(
              onTap: isCompaction
                  ? () => setState(() => _expanded = !_expanded)
                  : null,
              borderRadius: BorderRadius.circular(6),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: <Widget>[
                    if (!isCompaction) ...<Widget>[
                      Expanded(
                          child: Divider(
                              height: 1, color: color.withValues(alpha: .5))),
                      const SizedBox(width: 8),
                    ],
                    Icon(Icons.compress_rounded, size: 14, color: color),
                    const SizedBox(width: 5),
                    ExcludeSemantics(
                      child: Text(
                        widget.label,
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                              color: color,
                              fontSize: 11.5,
                              fontWeight: FontWeight.w500,
                            ),
                      ),
                    ),
                    if (isCompaction) ...<Widget>[
                      const SizedBox(width: 3),
                      Icon(
                        _expanded
                            ? Icons.keyboard_arrow_up_rounded
                            : Icons.keyboard_arrow_down_rounded,
                        size: 14,
                        color: color,
                      ),
                    ],
                    if (!isCompaction) ...<Widget>[
                      const SizedBox(width: 8),
                      Expanded(
                          child: Divider(
                              height: 1, color: color.withValues(alpha: .5))),
                    ],
                  ],
                ),
              ),
            ),
            if (isCompaction && _expanded && widget.detail.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(left: 19, top: 5, right: 8),
                child: Text(
                  widget.detail,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: .62),
                        height: 1.45,
                      ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _CompactionProgressRow extends StatefulWidget {
  const _CompactionProgressRow({this.compactionKind});

  final String? compactionKind;

  @override
  State<_CompactionProgressRow> createState() => _CompactionProgressRowState();
}

class _CompactionProgressRowState extends State<_CompactionProgressRow>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1900),
  );
  bool _animationsDisabled = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _animationsDisabled = MediaQuery.disableAnimationsOf(context);
    if (_animationsDisabled) {
      _controller
        ..stop()
        ..value = 0;
    } else if (!_controller.isAnimating) {
      unawaited(_controller.repeat());
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.onSurface.withValues(alpha: .5);
    final label = widget.compactionKind == 'automatic'
        ? 'Automatically compacting context…'
        : 'Compacting context…';
    final content = Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        const Icon(Icons.compress_rounded, size: 15, color: Colors.white),
        const SizedBox(width: 7),
        Text(
          label,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Colors.white,
                fontWeight: FontWeight.w500,
              ),
        ),
      ],
    );
    return Semantics(
      key: const Key('compaction-progress-row'),
      container: true,
      liveRegion: true,
      label: label,
      child: ExcludeSemantics(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(34, 8, 8, 10),
          child: _animationsDisabled
              ? ColorFiltered(
                  colorFilter: ColorFilter.mode(color, BlendMode.srcIn),
                  child: content,
                )
              : AnimatedBuilder(
                  animation: _controller,
                  builder: (context, child) => ShaderMask(
                    blendMode: BlendMode.srcIn,
                    shaderCallback: (bounds) => LinearGradient(
                      begin: Alignment(-2.4 + _controller.value * 4.8, 0),
                      end: Alignment(-1.1 + _controller.value * 4.8, 0),
                      colors: <Color>[
                        color,
                        Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: .82),
                        color,
                      ],
                      stops: const <double>[0, .5, 1],
                    ).createShader(bounds),
                    child: child,
                  ),
                  child: content,
                ),
        ),
      ),
    );
  }
}

class _FinalAnswerDivider extends StatelessWidget {
  const _FinalAnswerDivider({required this.messageId});

  final String messageId;

  @override
  Widget build(BuildContext context) => Semantics(
        key: ValueKey<String>('final-answer-boundary-$messageId'),
        container: true,
        label: 'Final answer',
        child: ExcludeSemantics(
          child: Padding(
            padding: const EdgeInsets.only(top: 2, bottom: 9, right: 28),
            child: Divider(
              height: 1,
              thickness: .7,
              color: Theme.of(context)
                  .colorScheme
                  .onSurface
                  .withValues(alpha: .18),
            ),
          ),
        ),
      );
}

bool _isSafeMarkdownUri(Uri? uri) =>
    uri != null &&
    (uri.scheme == 'https' || uri.scheme == 'http') &&
    uri.host.isNotEmpty;

bool _isDesktopLocalPath(String? href, Uri? uri) {
  if (href == null || href.trim().isEmpty) return false;
  final value = href.trim();
  return uri?.scheme.toLowerCase() == 'file' ||
      RegExp(r'^[a-zA-Z]:[\\/]').hasMatch(value) ||
      value.startsWith(r'\\') ||
      value.startsWith('/');
}

Future<void> _offerDesktopPathCopy(BuildContext context, String path) async {
  final copy = await showModalBottomSheet<bool>(
    context: context,
    showDragHandle: true,
    builder: (sheetContext) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text('Desktop path',
                style: Theme.of(sheetContext).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
              'This path belongs to the paired computer, so it cannot open on this phone.',
              style: Theme.of(sheetContext).textTheme.bodySmall,
            ),
            const SizedBox(height: 8),
            ListTile(
              key: const Key('copy-desktop-path'),
              contentPadding: EdgeInsets.zero,
              minTileHeight: 44,
              leading: const Icon(Icons.copy_rounded),
              title: const Text('Copy path'),
              onTap: () => Navigator.pop(sheetContext, true),
            ),
          ],
        ),
      ),
    ),
  );
  if (copy != true) return;
  await Clipboard.setData(ClipboardData(text: path));
  if (context.mounted) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(content: Text('Path copied')),
    );
  }
}

Future<void> _openMarkdownLink(BuildContext context, String? href) async {
  final uri = href == null ? null : Uri.tryParse(href);
  if (_isDesktopLocalPath(href, uri)) {
    await _offerDesktopPathCopy(context, href!.trim());
    return;
  }
  if (!_isSafeMarkdownUri(uri)) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(content: Text('This link type is blocked.')),
    );
    return;
  }
  try {
    final opened = await launchUrl(uri!, mode: LaunchMode.externalApplication);
    if (!opened && context.mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text('That link could not be opened.')),
      );
    }
  } on Object {
    if (context.mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text('That link could not be opened.')),
      );
    }
  }
}

class _SafeMessageMarkdown extends StatelessWidget {
  const _SafeMessageMarkdown({
    required this.text,
    required this.style,
    required this.visual,
  });

  final String text;
  final TextStyle? style;
  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final body =
        style ?? theme.textTheme.bodyMedium ?? const TextStyle(fontSize: 15);
    final subdued = theme.colorScheme.onSurface.withValues(alpha: .66);
    final code = body.copyWith(
      color: theme.colorScheme.onSurface.withValues(alpha: .92),
      fontFamily: 'monospace',
      fontSize: 13.5,
      height: 1.38,
    );
    final sheet = MarkdownStyleSheet(
      a: body.copyWith(
        color: visual.accent,
        decoration: TextDecoration.underline,
        decorationColor: visual.accent.withValues(alpha: .58),
      ),
      p: body,
      pPadding: EdgeInsets.zero,
      code: code.copyWith(
        backgroundColor: visual.surfaceRaised.withValues(alpha: .68),
      ),
      h1: body.copyWith(
          fontSize: 22, height: 1.22, fontWeight: FontWeight.w700),
      h1Padding: const EdgeInsets.only(top: 3, bottom: 6),
      h2: body.copyWith(
          fontSize: 19, height: 1.25, fontWeight: FontWeight.w700),
      h2Padding: const EdgeInsets.only(top: 3, bottom: 5),
      h3: body.copyWith(
          fontSize: 17, height: 1.28, fontWeight: FontWeight.w600),
      h3Padding: const EdgeInsets.only(top: 2, bottom: 4),
      h4: body.copyWith(
          fontSize: 15.5, height: 1.32, fontWeight: FontWeight.w600),
      h4Padding: const EdgeInsets.only(top: 2, bottom: 3),
      h5: body.copyWith(
          fontSize: 15, height: 1.34, fontWeight: FontWeight.w600),
      h5Padding: const EdgeInsets.only(top: 2, bottom: 3),
      h6: body.copyWith(
          fontSize: 15, height: 1.34, fontWeight: FontWeight.w500),
      h6Padding: const EdgeInsets.only(top: 2, bottom: 3),
      em: body.copyWith(fontStyle: FontStyle.italic),
      strong: body.copyWith(fontWeight: FontWeight.w700),
      del: body.copyWith(decoration: TextDecoration.lineThrough),
      blockSpacing: 8,
      listIndent: 22,
      listBullet: body.copyWith(color: subdued),
      listBulletPadding: const EdgeInsets.only(right: 5),
      blockquote: body.copyWith(color: subdued),
      blockquotePadding: const EdgeInsets.fromLTRB(11, 3, 4, 3),
      blockquoteDecoration: BoxDecoration(
        border: Border(
          left: BorderSide(
            color: visual.accent.withValues(alpha: .46),
            width: 1.5,
          ),
        ),
      ),
      codeblockPadding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
      codeblockDecoration: BoxDecoration(
        color: visual.surfaceRaised.withValues(alpha: .72),
        border: Border.all(color: visual.border.withValues(alpha: .74)),
        borderRadius: BorderRadius.circular(6),
      ),
      tableHead: body.copyWith(fontSize: 14, fontWeight: FontWeight.w700),
      tableBody: body.copyWith(fontSize: 14, height: 1.32),
      tableHeadAlign: TextAlign.left,
      tablePadding: const EdgeInsets.only(bottom: 5),
      tableBorder: TableBorder.all(
        color: visual.border.withValues(alpha: .78),
        width: .7,
      ),
      tableColumnWidth: const IntrinsicColumnWidth(),
      tableScrollbarThumbVisibility: true,
      tableCellsPadding:
          const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      tableCellsDecoration: const BoxDecoration(),
      horizontalRuleDecoration: BoxDecoration(
        border: Border(
          top: BorderSide(
            color: theme.colorScheme.onSurface.withValues(alpha: .18),
            width: .7,
          ),
        ),
      ),
    );
    // This renderer has no WebView/HTML execution path. Markdown images are
    // also replaced with inert references so remote content never loads itself.
    return MarkdownBody(
      data: text,
      selectable: true,
      styleSheet: sheet,
      fitContent: true,
      onTapLink: (label, href, title) =>
          unawaited(_openMarkdownLink(context, href)),
      imageBuilder: (uri, title, alt) => _MarkdownImageReference(
        uri: uri,
        label: alt?.trim().isNotEmpty == true ? alt!.trim() : 'Image link',
        visual: visual,
      ),
    );
  }
}

class _MarkdownImageReference extends StatelessWidget {
  const _MarkdownImageReference({
    required this.uri,
    required this.label,
    required this.visual,
  });

  final Uri uri;
  final String label;
  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) {
    final safe = _isSafeMarkdownUri(uri);
    final color = safe
        ? visual.accent.withValues(alpha: .8)
        : Theme.of(context).colorScheme.onSurface.withValues(alpha: .5);
    return Semantics(
      button: safe,
      label: safe ? 'Open image link: $label' : 'Blocked image link: $label',
      child: InkWell(
        key: ValueKey<String>('markdown-image-reference-$uri'),
        onTap: safe
            ? () => unawaited(_openMarkdownLink(context, uri.toString()))
            : null,
        borderRadius: BorderRadius.circular(4),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 1),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(safe ? Icons.image_outlined : Icons.block_rounded,
                  size: 15, color: color),
              const SizedBox(width: 4),
              Flexible(
                child: Text(
                  safe ? label : '$label (blocked)',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: color,
                        decoration: safe ? TextDecoration.underline : null,
                      ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MemoryContextIndicator extends StatelessWidget {
  const _MemoryContextIndicator({required this.visual});

  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) {
    final color =
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.56);
    return Container(
      key: const Key('memory-context-indicator'),
      padding: const EdgeInsets.only(left: 8),
      decoration: BoxDecoration(
        border: Border(
          left: BorderSide(
              color: visual.accent.withValues(alpha: 0.52), width: 1.5),
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.history_rounded, size: 14, color: color),
          const SizedBox(width: 5),
          Text(
            'Used saved context',
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: color,
                  fontSize: 11,
                  fontWeight: FontWeight.w500,
                  letterSpacing: 0.1,
                ),
          ),
        ],
      ),
    );
  }
}

class _MeshResultContextCard extends StatelessWidget {
  const _MeshResultContextCard({
    required this.messageId,
    required this.visual,
  });

  final String messageId;
  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) => Container(
        key: ValueKey<String>('mesh-result-context-$messageId'),
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
        decoration: BoxDecoration(
          color: visual.surface.withValues(alpha: 0.45),
          border: Border(
            left: BorderSide(color: visual.accent, width: 2),
            bottom: BorderSide(color: visual.border.withValues(alpha: 0.48)),
          ),
        ),
        child: Row(
          children: <Widget>[
            Icon(Icons.hub_outlined, size: 17, color: visual.accent),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                'Delegated results returned to the parent',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      fontWeight: FontWeight.w500,
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.7),
                    ),
              ),
            ),
          ],
        ),
      );
}

class _ArtifactMessageText extends StatefulWidget {
  const _ArtifactMessageText({
    required this.text,
    required this.style,
    required this.visual,
    required this.active,
    super.key,
  });

  final String text;
  final TextStyle? style;
  final ProviderVisualTheme visual;
  final bool active;

  @override
  State<_ArtifactMessageText> createState() => _ArtifactMessageTextState();
}

class _ArtifactMessageTextState extends State<_ArtifactMessageText>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  bool _animationsDisabled = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1900),
    );
  }

  void _syncAnimation() {
    if (widget.active && !_animationsDisabled) {
      if (!_controller.isAnimating) unawaited(_controller.repeat());
    } else {
      _controller
        ..stop()
        ..value = 0;
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _animationsDisabled = MediaQuery.disableAnimationsOf(context);
    _syncAnimation();
  }

  @override
  void didUpdateWidget(covariant _ArtifactMessageText oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active != oldWidget.active) _syncAnimation();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.active || _animationsDisabled) {
      return _SafeMessageMarkdown(
        text: widget.text,
        style: widget.style,
        visual: widget.visual,
      );
    }
    final base = widget.style?.color ??
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.64);
    final edgeHighlight = Color.lerp(base, widget.visual.accent, 0.3)!;
    final centerHighlight =
        Color.lerp(Colors.white, widget.visual.accent, 0.2)!;
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) => ShaderMask(
        blendMode: BlendMode.srcIn,
        shaderCallback: (bounds) {
          final offset = -2 + (_controller.value * 4);
          return LinearGradient(
            begin: Alignment(offset - 1, 0),
            end: Alignment(offset + 1, 0),
            colors: <Color>[
              base,
              base,
              edgeHighlight,
              centerHighlight,
              edgeHighlight,
              base,
              base,
            ],
            stops: const <double>[0, 0.2, 0.38, 0.5, 0.62, 0.8, 1],
          ).createShader(bounds);
        },
        child: child,
      ),
      child: _SafeMessageMarkdown(
        text: widget.text,
        style: widget.style?.copyWith(color: Colors.white),
        visual: widget.visual,
      ),
    );
  }
}

class _AttachmentFileLabel extends StatelessWidget {
  const _AttachmentFileLabel(
      {required this.attachment, required this.visual, super.key});

  final _MessageAttachmentView attachment;
  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 260),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: visual.surfaceRaised.withValues(alpha: 0.72),
        border: Border.all(color: visual.border.withValues(alpha: 0.76)),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(
            attachment.isImage
                ? Icons.image_outlined
                : Icons.insert_drive_file_outlined,
            size: 17,
            color: visual.accent.withValues(alpha: 0.82),
          ),
          const SizedBox(width: 7),
          Flexible(
            child: Text(
              attachment.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    fontWeight: FontWeight.w500,
                  ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SubagentActivityGroup extends StatefulWidget {
  const _SubagentActivityGroup({
    required this.parts,
    required this.visual,
    super.key,
  });

  final List<ContentPart> parts;
  final ProviderVisualTheme visual;

  @override
  State<_SubagentActivityGroup> createState() => _SubagentActivityGroupState();
}

class _SubagentActivityGroupState extends State<_SubagentActivityGroup> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final activeParts = widget.parts.where(_isActiveSubagentPart).toList();
    final activeReceiverIds = activeParts
        .expand((part) => jsonList(part.data['receiverSessionIds']))
        .whereType<String>()
        .toSet();
    final activeCount = activeReceiverIds.isNotEmpty
        ? activeReceiverIds.length
        : activeParts.length;
    final label = activeCount > 0
        ? '$activeCount ${activeCount == 1 ? 'agent' : 'agents'} active'
        : 'Agent activity';
    final overallState = activeCount > 0 ? 'working' : 'completed';
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 300),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Semantics(
            button: true,
            label: label,
            hint: _expanded ? 'Hide agent details' : 'Show agent details',
            child: InkWell(
              key: const Key('agent-activity-toggle'),
              borderRadius: BorderRadius.circular(5),
              overlayColor: WidgetStatePropertyAll(
                  widget.visual.accent.withValues(alpha: 0.08)),
              onTap: () => setState(() => _expanded = !_expanded),
              child: SizedBox(
                height: 44,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    _AgentStateIcon(state: overallState),
                    const SizedBox(width: 8),
                    Flexible(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                      ),
                    ),
                    const SizedBox(width: 4),
                    Icon(
                      _expanded
                          ? Icons.keyboard_arrow_up_rounded
                          : Icons.keyboard_arrow_down_rounded,
                      size: 20,
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.62),
                    ),
                  ],
                ),
              ),
            ),
          ),
          if (_expanded)
            ...widget.parts.indexed.map((entry) => _SubagentActivityDetail(
                  key: ValueKey<String>('subagent-activity-detail-${entry.$1}'),
                  part: entry.$2,
                )),
        ],
      ),
    );
  }
}

bool _isActiveSubagentPart(ContentPart part) {
  final status = optionalString(part.data, 'status');
  return status == 'running' || status == 'working' || status == 'pending';
}

class _SubagentActivityDetail extends StatelessWidget {
  const _SubagentActivityDetail({required this.part, super.key});

  final ContentPart part;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final receiverIds =
        jsonList(part.data['receiverSessionIds']).whereType<String>().toSet();
    final receiver = store.sessions
        .where((session) => receiverIds.contains(session.id))
        .firstOrNull;
    final action = optionalString(part.data, 'action') ?? 'unknown';
    final status = optionalString(part.data, 'status') ?? 'unknown';
    final summary = optionalString(part.data, 'summary');
    final tool = optionalString(part.data, 'tool');
    final title = summary ?? _subagentActionLabel(action, tool);
    final receiverLabel = receiver?.agentNickname ??
        receiver?.agentRole ??
        (receiverIds.length > 1 ? '${receiverIds.length} agents' : null);
    return Semantics(
      label: '$title, ${_titleCase(status)}',
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 44),
        child: Row(
          children: <Widget>[
            const SizedBox(width: 2),
            _AgentStateIcon(state: status == 'running' ? 'working' : status),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Text(
                    title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          fontWeight: FontWeight.w500,
                        ),
                  ),
                  if (receiverLabel != null)
                    Text(
                      receiverLabel,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                            color: Theme.of(context)
                                .colorScheme
                                .onSurface
                                .withValues(alpha: 0.54),
                          ),
                    ),
                ],
              ),
            ),
            if (receiver != null)
              TextButton(
                key: ValueKey<String>('view-subagent-${receiver.id}'),
                style: TextButton.styleFrom(
                  visualDensity: VisualDensity.compact,
                  padding: const EdgeInsets.symmetric(horizontal: 7),
                  minimumSize: const Size(44, 44),
                ),
                onPressed: () => _openSessionAfterPress(
                  context: context,
                  store: store,
                  session: receiver,
                ),
                child: const Text('View'),
              ),
          ],
        ),
      ),
    );
  }
}

String _subagentActionLabel(String action, String? tool) => switch (action) {
      'spawn' => 'Started an agent',
      'message' => 'Sent an agent message',
      'wait' => 'Waiting for an agent',
      'interrupt' => 'Interrupted an agent',
      'list' => 'Checked agent activity',
      _ => tool?.trim().isNotEmpty == true ? tool! : 'Agent activity',
    };

class _QueuedInstructionStrip extends StatelessWidget {
  const _QueuedInstructionStrip({
    required this.messages,
    required this.visual,
    required this.onCancel,
    required this.onActions,
  });

  final List<RemoteQueuedMessage> messages;
  final ProviderVisualTheme visual;
  final ValueChanged<RemoteQueuedMessage> onCancel;
  final ValueChanged<RemoteQueuedMessage> onActions;

  @override
  Widget build(BuildContext context) => ConstrainedBox(
        key: const Key('queued-instruction-strip'),
        constraints: const BoxConstraints(maxHeight: 104),
        child: ColoredBox(
          color: visual.surface.withValues(alpha: .32),
          child: ListView.separated(
            shrinkWrap: true,
            padding: const EdgeInsets.symmetric(vertical: 3),
            itemCount: messages.length,
            separatorBuilder: (_, __) => Divider(
              height: 1,
              indent: 42,
              color: visual.border.withValues(alpha: .34),
            ),
            itemBuilder: (context, index) {
              final message = messages[index];
              final sending = message.state == 'sending';
              String? thumbnailUri;
              for (final attachment in message.attachments) {
                thumbnailUri = attachment.localImageDataUri;
                if (thumbnailUri != null) break;
              }
              return SizedBox(
                key: ValueKey<String>('queued-instruction-${message.id}'),
                height: 48,
                child: Row(
                  children: <Widget>[
                    SizedBox.square(
                      dimension: 44,
                      child: Center(
                        child: sending
                            ? SizedBox.square(
                                dimension: 16,
                                child: CircularProgressIndicator(
                                  strokeWidth: 1.7,
                                  color: visual.accent,
                                ),
                              )
                            : Icon(Icons.schedule_send_outlined,
                                size: 18, color: visual.accent),
                      ),
                    ),
                    Expanded(
                      child: InkWell(
                        onTap: () => onActions(message),
                        child: Row(
                          children: <Widget>[
                            Expanded(
                              child: Text(
                                message.content
                                    .replaceAll(RegExp(r'[\r\n]+'), ' '),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: Theme.of(context)
                                    .textTheme
                                    .bodyMedium
                                    ?.copyWith(fontSize: 13.5),
                              ),
                            ),
                            if (message.attachments.isNotEmpty) ...<Widget>[
                              const SizedBox(width: 6),
                              if (thumbnailUri != null)
                                ClipRRect(
                                  key: ValueKey<String>(
                                      'queued-image-preview-${message.id}'),
                                  borderRadius: BorderRadius.circular(4),
                                  child: _MemoizedDataUriImage(
                                    dataUri: thumbnailUri,
                                    width: 28,
                                    height: 28,
                                    fit: BoxFit.cover,
                                    cacheWidth: 56,
                                    fallback: Icon(
                                      Icons.image_outlined,
                                      size: 16,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurface
                                          .withValues(alpha: .58),
                                    ),
                                  ),
                                )
                              else
                                Icon(
                                  message.attachments.any((attachment) =>
                                          attachment.mimeType
                                              .startsWith('image/'))
                                      ? Icons.image_outlined
                                      : Icons.attach_file_rounded,
                                  size: 16,
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurface
                                      .withValues(alpha: .58),
                                ),
                              const SizedBox(width: 2),
                              Text('${message.attachments.length}',
                                  style:
                                      Theme.of(context).textTheme.labelSmall),
                            ],
                          ],
                        ),
                      ),
                    ),
                    SizedBox.square(
                      dimension: 44,
                      child: IconButton(
                        key: ValueKey<String>('queued-actions-${message.id}'),
                        tooltip: 'Queued message actions',
                        onPressed: () => onActions(message),
                        icon: const Icon(Icons.more_horiz_rounded, size: 20),
                      ),
                    ),
                    SizedBox.square(
                      dimension: 44,
                      child: IconButton(
                        key: ValueKey<String>('cancel-queued-${message.id}'),
                        tooltip: 'Remove queued message',
                        onPressed: sending ? null : () => onCancel(message),
                        icon: const Icon(Icons.close_rounded, size: 20),
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      );
}

class _QueueActionTile extends StatelessWidget {
  const _QueueActionTile({
    required this.icon,
    required this.label,
    required this.onTap,
    super.key,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => SizedBox(
        height: 52,
        child: ListTile(
          minLeadingWidth: 32,
          leading: Icon(icon, size: 21),
          title: Text(label),
          onTap: onTap,
        ),
      );
}

class _ActivityEventGroup {
  const _ActivityEventGroup(this.events);

  final List<AgentEvent> events;
}

enum _ActivityKind {
  read,
  write,
  edit,
  run,
  search,
  browse,
  agent,
  error,
  tool
}

class _ActivityPresentation {
  const _ActivityPresentation({
    required this.kind,
    required this.label,
    required this.snippet,
    this.target,
  });

  final _ActivityKind kind;
  final String label;
  final String? target;
  final String snippet;
}

class _MessageReasoningSpan extends StatelessWidget {
  const _MessageReasoningSpan({
    required this.id,
    required this.segments,
    required this.visual,
    required this.providerId,
    required this.showIdentity,
    required this.working,
    this.displayMode = _ReasoningDisplayMode.compact,
    super.key,
  });

  final String id;
  final List<_ReasoningSegment> segments;
  final ProviderVisualTheme visual;
  final String providerId;
  final bool showIdentity;
  final bool working;
  final _ReasoningDisplayMode displayMode;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 34,
            child: showIdentity
                ? Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: ProviderLogo(
                      key: ValueKey<String>('assistant-identity-reasoning-$id'),
                      providerId: providerId,
                      size: 28,
                    ),
                  )
                : null,
          ),
          Expanded(
            child: _ReasoningDisclosure(
              id: id,
              segments: segments,
              visual: visual,
              working: working,
              displayMode: displayMode,
            ),
          ),
        ],
      ),
    );
  }
}

class _ReasoningDisclosure extends StatefulWidget {
  const _ReasoningDisclosure({
    required this.id,
    required this.segments,
    required this.visual,
    required this.working,
    this.displayMode = _ReasoningDisplayMode.compact,
  });

  final String id;
  final List<_ReasoningSegment> segments;
  final ProviderVisualTheme visual;
  final bool working;
  final _ReasoningDisplayMode displayMode;

  @override
  State<_ReasoningDisclosure> createState() => _ReasoningDisclosureState();
}

class _ReasoningDisclosureState extends State<_ReasoningDisclosure> {
  bool _expanded = false;
  final Set<String> _expandedSegments = <String>{};
  final Set<String> _expandedToolDetails = <String>{};

  @override
  void initState() {
    super.initState();
    _applyExpandedThinkingDefault();
  }

  @override
  void didUpdateWidget(covariant _ReasoningDisclosure oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.displayMode != oldWidget.displayMode ||
        widget.segments.length != oldWidget.segments.length) {
      _applyExpandedThinkingDefault();
    }
  }

  void _applyExpandedThinkingDefault() {
    if (widget.displayMode != _ReasoningDisplayMode.expanded) return;
    _expandedSegments.addAll(widget.segments
        .where((segment) => segment.kind == _ReasoningDetailKind.thinking)
        .map((segment) => segment.details.first.id));
  }

  String _segmentId(_ReasoningSegment segment) => segment.details.first.id;

  Iterable<_ReasoningSegment> get _thinkingSegments => widget.segments
      .where((segment) => segment.kind == _ReasoningDetailKind.thinking);

  Iterable<_ReasoningSegment> get _toolSegments => widget.segments
      .where((segment) => segment.kind == _ReasoningDetailKind.toolCall);

  void _toggleAllThinking() {
    final ids = _thinkingSegments.map(_segmentId).toSet();
    final collapse = ids.isNotEmpty && ids.every(_expandedSegments.contains);
    setState(() {
      if (collapse) {
        _expandedSegments.removeAll(ids);
      } else {
        _expandedSegments.addAll(ids);
      }
    });
  }

  void _toggleAllTools() {
    final segments = _toolSegments.toList(growable: false);
    final segmentIds = segments.map(_segmentId).toSet();
    final detailIds = segments
        .expand((segment) => segment.details)
        .map((detail) => detail.id)
        .toSet();
    final collapse = segmentIds.isNotEmpty &&
        segmentIds.every(_expandedSegments.contains) &&
        detailIds.every(_expandedToolDetails.contains);
    setState(() {
      if (collapse) {
        _expandedSegments.removeAll(segmentIds);
        _expandedToolDetails.removeAll(detailIds);
      } else {
        _expandedSegments.addAll(segmentIds);
        _expandedToolDetails.addAll(detailIds);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final motionDisabled = MediaQuery.disableAnimationsOf(context);
    final muted =
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.62);
    final labelStyle = Theme.of(context).textTheme.bodyMedium?.copyWith(
          color: muted,
          fontWeight: FontWeight.w500,
        );
    final thinking = _thinkingSegments.toList(growable: false);
    final tools = _toolSegments.toList(growable: false);
    final allThinkingExpanded = thinking.isNotEmpty &&
        thinking.map(_segmentId).every(_expandedSegments.contains);
    final allToolsExpanded = tools.isNotEmpty &&
        tools.map(_segmentId).every(_expandedSegments.contains) &&
        tools
            .expand((segment) => segment.details)
            .map((detail) => detail.id)
            .every(_expandedToolDetails.contains);
    return Padding(
      padding: const EdgeInsets.only(right: 4, top: 1, bottom: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Semantics(
            button: true,
            expanded: _expanded,
            label: _expanded ? 'Hide reasoning' : 'Show reasoning',
            child: InkWell(
              key: ValueKey<String>('reasoning-toggle-${widget.id}'),
              borderRadius: BorderRadius.circular(6),
              onTap: () => setState(() => _expanded = !_expanded),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 44),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: _ArtifactMessageText(
                        text: 'Reasoning',
                        style: labelStyle,
                        visual: widget.visual,
                        active: widget.working,
                      ),
                    ),
                    Icon(
                      _expanded
                          ? Icons.keyboard_arrow_up_rounded
                          : Icons.keyboard_arrow_down_rounded,
                      size: 21,
                      color: muted,
                    ),
                  ],
                ),
              ),
            ),
          ),
          AnimatedSize(
            duration: motionDisabled
                ? Duration.zero
                : const Duration(milliseconds: 140),
            curve: Curves.easeOutCubic,
            alignment: Alignment.topCenter,
            child: !_expanded
                ? const SizedBox.shrink()
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      _ReasoningBulkControls(
                        thinkingAvailable: thinking.isNotEmpty,
                        toolsAvailable: tools.isNotEmpty,
                        thinkingExpanded: allThinkingExpanded,
                        toolsExpanded: allToolsExpanded,
                        onThinkingTap: _toggleAllThinking,
                        onToolsTap: _toggleAllTools,
                      ),
                      ...widget.segments.map((segment) {
                        final id = _segmentId(segment);
                        return _ReasoningSegmentPanel(
                          key: ValueKey<String>('reasoning-segment-$id'),
                          segment: segment,
                          visual: widget.visual,
                          expanded: _expandedSegments.contains(id),
                          expandedToolDetails: _expandedToolDetails,
                          onExpandedChanged: (expanded) => setState(() {
                            if (expanded) {
                              _expandedSegments.add(id);
                            } else {
                              _expandedSegments.remove(id);
                            }
                          }),
                          onToolDetailChanged: (detailId, expanded) =>
                              setState(() {
                            if (expanded) {
                              _expandedToolDetails.add(detailId);
                            } else {
                              _expandedToolDetails.remove(detailId);
                            }
                          }),
                        );
                      }),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}

class _ReasoningBulkControls extends StatelessWidget {
  const _ReasoningBulkControls({
    required this.thinkingAvailable,
    required this.toolsAvailable,
    required this.thinkingExpanded,
    required this.toolsExpanded,
    required this.onThinkingTap,
    required this.onToolsTap,
  });

  final bool thinkingAvailable;
  final bool toolsAvailable;
  final bool thinkingExpanded;
  final bool toolsExpanded;
  final VoidCallback onThinkingTap;
  final VoidCallback onToolsTap;

  @override
  Widget build(BuildContext context) {
    final divider =
        Theme.of(context).colorScheme.onSurface.withValues(alpha: .16);
    return Semantics(
      container: true,
      label: 'Reasoning expansion controls',
      child: Row(
        children: <Widget>[
          Expanded(
            child: TextButton(
              key: const Key('expand-reasoning-thinking'),
              onPressed: thinkingAvailable ? onThinkingTap : null,
              style: TextButton.styleFrom(
                minimumSize: const Size(44, 44),
                padding: const EdgeInsets.symmetric(horizontal: 6),
              ),
              child: Text(
                thinkingExpanded ? 'Collapse thinking' : 'Expand thinking',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
          SizedBox(
              height: 22, child: VerticalDivider(width: 1, color: divider)),
          Expanded(
            child: TextButton(
              key: const Key('expand-reasoning-tools'),
              onPressed: toolsAvailable ? onToolsTap : null,
              style: TextButton.styleFrom(
                minimumSize: const Size(44, 44),
                padding: const EdgeInsets.symmetric(horizontal: 6),
              ),
              child: Text(
                toolsExpanded ? 'Collapse tool calls' : 'Expand tool calls',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ReasoningSegmentPanel extends StatelessWidget {
  const _ReasoningSegmentPanel({
    required this.segment,
    required this.visual,
    required this.expanded,
    required this.expandedToolDetails,
    required this.onExpandedChanged,
    required this.onToolDetailChanged,
    super.key,
  });

  final _ReasoningSegment segment;
  final ProviderVisualTheme visual;
  final bool expanded;
  final Set<String> expandedToolDetails;
  final ValueChanged<bool> onExpandedChanged;
  final void Function(String id, bool expanded) onToolDetailChanged;

  @override
  Widget build(BuildContext context) {
    final first = segment.details.first;
    final summary = segment.kind == _ReasoningDetailKind.toolCall &&
            segment.details.length > 1
        ? '${first.summary} + ${segment.details.length - 1} more'
        : first.summary;
    final muted =
        Theme.of(context).colorScheme.onSurface.withValues(alpha: .68);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Semantics(
          button: true,
          expanded: expanded,
          label: '$summary, ${expanded ? 'Collapse' : 'Expand'} details',
          child: InkWell(
            key: ValueKey<String>('reasoning-segment-toggle-${first.id}'),
            onTap: () => onExpandedChanged(!expanded),
            borderRadius: BorderRadius.circular(6),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 44),
              child: Row(
                children: <Widget>[
                  Icon(
                    segment.kind == _ReasoningDetailKind.thinking
                        ? Icons.psychology_alt_outlined
                        : Icons.terminal_rounded,
                    size: 18,
                    color: visual.accent.withValues(alpha: .78),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      summary,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                            color: muted,
                            fontStyle:
                                segment.kind == _ReasoningDetailKind.thinking
                                    ? FontStyle.italic
                                    : FontStyle.normal,
                          ),
                    ),
                  ),
                  Icon(
                    expanded
                        ? Icons.keyboard_arrow_up_rounded
                        : Icons.keyboard_arrow_down_rounded,
                    size: 20,
                    color: muted,
                  ),
                ],
              ),
            ),
          ),
        ),
        if (expanded)
          if (segment.kind == _ReasoningDetailKind.thinking)
            Padding(
              padding: const EdgeInsets.fromLTRB(26, 0, 8, 8),
              child: _ReasoningThinkingDetail(
                id: first.id,
                text: first.detail,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      height: 1.4,
                      color: muted,
                      fontStyle: FontStyle.italic,
                    ),
                visual: visual,
              ),
            )
          else
            Padding(
              padding: const EdgeInsets.only(left: 18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: segment.details.map((detail) {
                  if (detail.activity != null) {
                    return _EventCard(
                      key: ValueKey<String>(detail.id),
                      group: detail.activity!,
                      visual: visual,
                      expanded: expandedToolDetails.contains(detail.id),
                      onExpandedChanged: (value) =>
                          onToolDetailChanged(detail.id, value),
                    );
                  }
                  return _ReasoningToolDetail(
                    key: ValueKey<String>('tool-detail-${detail.id}'),
                    detail: detail,
                    visual: visual,
                    expanded: expandedToolDetails.contains(detail.id),
                    onExpandedChanged: (value) =>
                        onToolDetailChanged(detail.id, value),
                  );
                }).toList(growable: false),
              ),
            ),
      ],
    );
  }
}

class _ReasoningThinkingDetail extends StatelessWidget {
  const _ReasoningThinkingDetail({
    required this.id,
    required this.text,
    required this.style,
    required this.visual,
  });

  final String id;
  final String text;
  final TextStyle? style;
  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) {
    final body = _SafeMessageMarkdown(
      text: text,
      style: style,
      visual: visual,
    );
    final lineCount = RegExp(r'\r?\n').allMatches(text).length + 1;
    if (text.length <= 720 && lineCount <= 14) return body;
    final maxHeight =
        (MediaQuery.sizeOf(context).height * .42).clamp(180, 360).toDouble();
    return ConstrainedBox(
      key: ValueKey<String>('reasoning-thinking-scroll-$id'),
      constraints: BoxConstraints(maxHeight: maxHeight),
      child: Scrollbar(
        child: SingleChildScrollView(
          primary: false,
          padding: const EdgeInsets.only(right: 6),
          child: body,
        ),
      ),
    );
  }
}

class _ReasoningToolDetail extends StatelessWidget {
  const _ReasoningToolDetail({
    required this.detail,
    required this.visual,
    required this.expanded,
    required this.onExpandedChanged,
    super.key,
  });

  final _ReasoningDetail detail;
  final ProviderVisualTheme visual;
  final bool expanded;
  final ValueChanged<bool> onExpandedChanged;

  @override
  Widget build(BuildContext context) {
    final muted =
        Theme.of(context).colorScheme.onSurface.withValues(alpha: .66);
    final hasDetail = detail.detail.trim().isNotEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        InkWell(
          key: ValueKey<String>('tool-detail-toggle-${detail.id}'),
          onTap: hasDetail ? () => onExpandedChanged(!expanded) : null,
          borderRadius: BorderRadius.circular(6),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 44),
            child: Row(
              children: <Widget>[
                const Icon(Icons.terminal_rounded, size: 17),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(
                    detail.summary,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context)
                        .textTheme
                        .bodyMedium
                        ?.copyWith(color: muted),
                  ),
                ),
                if (hasDetail)
                  Icon(
                    expanded
                        ? Icons.keyboard_arrow_up_rounded
                        : Icons.keyboard_arrow_down_rounded,
                    size: 20,
                    color: muted,
                  ),
              ],
            ),
          ),
        ),
        if (expanded && hasDetail)
          Padding(
            padding: const EdgeInsets.fromLTRB(24, 0, 6, 8),
            child: _SafeMessageMarkdown(
              text: detail.detail,
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: muted, height: 1.38),
              visual: visual,
            ),
          ),
      ],
    );
  }
}

class _EventCard extends StatefulWidget {
  const _EventCard({
    required this.group,
    required this.visual,
    this.expanded,
    this.onExpandedChanged,
    super.key,
  });

  final _ActivityEventGroup group;
  final ProviderVisualTheme visual;
  final bool? expanded;
  final ValueChanged<bool>? onExpandedChanged;

  @override
  State<_EventCard> createState() => _EventCardState();
}

class _EventCardState extends State<_EventCard> {
  bool _expanded = false;
  bool _enlarged = false;

  bool get _isExpanded => widget.expanded ?? _expanded;

  void _setExpanded(bool value) {
    if (widget.onExpandedChanged != null) {
      widget.onExpandedChanged!(value);
      if (!value && mounted) setState(() => _enlarged = false);
      return;
    }
    setState(() {
      _expanded = value;
      if (!value) _enlarged = false;
    });
  }

  void _collapse() => _setExpanded(false);

  @override
  Widget build(BuildContext context) {
    final presentation = _activityPresentation(widget.group);
    final hasSnippet = presentation.snippet.isNotEmpty;
    final longSnippet = _isLongActivitySnippet(presentation.snippet);
    final expanded = _isExpanded;
    final motionDisabled = MediaQuery.disableAnimationsOf(context);
    final targetColor =
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.58);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Semantics(
          button: hasSnippet,
          expanded: hasSnippet ? expanded : null,
          label: <String>[
            presentation.label,
            if (presentation.target != null) presentation.target!,
            if (hasSnippet) expanded ? 'Collapse details' : 'Expand details',
          ].join(', '),
          child: InkWell(
            key: ValueKey<String>(
                'activity-disclosure-${widget.group.events.first.eventId}'),
            borderRadius: BorderRadius.circular(6),
            onTap: hasSnippet ? () => _setExpanded(!expanded) : null,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 44),
              child: Row(
                children: <Widget>[
                  SizedBox.square(
                    dimension: 28,
                    child: Center(
                      child: Icon(
                        _activityIcon(presentation.kind),
                        size: 18,
                        color: widget.visual.accent.withValues(alpha: 0.86),
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    presentation.label,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                  ),
                  if (presentation.target != null) ...<Widget>[
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        presentation.target!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: targetColor,
                              fontSize: 12.5,
                            ),
                      ),
                    ),
                  ] else
                    const Spacer(),
                  if (hasSnippet)
                    Icon(
                      expanded
                          ? Icons.keyboard_arrow_up_rounded
                          : Icons.keyboard_arrow_down_rounded,
                      size: 20,
                      color: targetColor,
                    ),
                ],
              ),
            ),
          ),
        ),
        AnimatedSize(
          duration: motionDisabled
              ? Duration.zero
              : const Duration(milliseconds: 160),
          curve: Curves.easeOutCubic,
          alignment: Alignment.topCenter,
          child: expanded && hasSnippet
              ? _ActivitySnippet(
                  key: ValueKey<String>(
                      'activity-snippet-${widget.group.events.first.eventId}'),
                  text: presentation.snippet,
                  enlarged: _enlarged,
                  canResize: longSnippet,
                  visual: widget.visual,
                  onCollapse: _collapse,
                  onResize: () => setState(() => _enlarged = !_enlarged),
                )
              : const SizedBox.shrink(),
        ),
      ],
    );
  }
}

class _ActivitySnippet extends StatelessWidget {
  const _ActivitySnippet({
    required this.text,
    required this.enlarged,
    required this.canResize,
    required this.visual,
    required this.onCollapse,
    required this.onResize,
    super.key,
  });

  final String text;
  final bool enlarged;
  final bool canResize;
  final ProviderVisualTheme visual;
  final VoidCallback onCollapse;
  final VoidCallback onResize;

  @override
  Widget build(BuildContext context) {
    final lineCount = '\n'.allMatches(text).length + 1;
    final compactHeight = (lineCount * 19 + 104).clamp(168, 320).toDouble();
    final largeHeight = (MediaQuery.sizeOf(context).height * 0.68)
        .clamp(compactHeight, 560)
        .toDouble();
    final height = enlarged ? largeHeight : compactHeight;
    final muted =
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.68);
    return Padding(
      padding: const EdgeInsets.only(left: 2, right: 2, bottom: 8),
      child: Container(
        height: height,
        decoration: BoxDecoration(
          color: visual.surface.withValues(alpha: 0.72),
          border: Border.all(color: visual.border.withValues(alpha: 0.72)),
          borderRadius: BorderRadius.circular(8),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            SizedBox(
              height: 44,
              child: Row(
                children: <Widget>[
                  TextButton.icon(
                    key: const Key('activity-collapse-top'),
                    onPressed: onCollapse,
                    icon: const Icon(Icons.keyboard_arrow_up_rounded, size: 19),
                    label: const Text('Collapse'),
                  ),
                  const Spacer(),
                  if (canResize)
                    IconButton(
                      key: const Key('activity-resize-snippet'),
                      tooltip: enlarged ? 'Reduce snippet' : 'Enlarge snippet',
                      onPressed: onResize,
                      icon: Icon(
                        enlarged
                            ? Icons.close_fullscreen_rounded
                            : Icons.open_in_full_rounded,
                        size: 18,
                      ),
                    ),
                ],
              ),
            ),
            Divider(height: 1, color: visual.border.withValues(alpha: 0.6)),
            Expanded(
              child: Scrollbar(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(13, 12, 13, 12),
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: SelectableText(
                      text,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.onSurface,
                        fontFamily: 'monospace',
                        fontSize: 13,
                        height: 1.45,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            Divider(height: 1, color: visual.border.withValues(alpha: 0.6)),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                key: const Key('activity-collapse-bottom'),
                onPressed: onCollapse,
                style: TextButton.styleFrom(foregroundColor: muted),
                icon: const Icon(Icons.keyboard_arrow_up_rounded, size: 19),
                label: const Text('Collapse'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

List<_ActivityEventGroup> _groupConversationActivity(List<AgentEvent> events) {
  final grouped = <List<AgentEvent>>[];
  for (final event in events) {
    final phase = event.type.split('.').last;
    final family = _activityEventFamily(event);
    final operationId = _activityOperationId(event);
    var match = -1;
    if (phase != 'started' || operationId != null) {
      for (var index = grouped.length - 1; index >= 0; index -= 1) {
        final candidate = grouped[index];
        if (_activityGroupFinished(candidate) ||
            _activityEventFamily(candidate.first) != family) {
          continue;
        }
        final candidateId = _activityOperationId(candidate.first);
        final sameOperation = phase == 'started'
            ? candidateId != null && operationId == candidateId
            : operationId == null ||
                candidateId == null ||
                operationId == candidateId;
        if (sameOperation) {
          match = index;
          break;
        }
      }
    }
    if (match < 0) {
      grouped.add(<AgentEvent>[event]);
    } else {
      grouped[match].add(event);
    }
  }
  return grouped
      .map((events) =>
          _ActivityEventGroup(List<AgentEvent>.unmodifiable(events)))
      .toList(growable: false);
}

@visibleForTesting
List<List<String>> groupConversationActivityEventIdsForTesting(
        List<AgentEvent> events) =>
    _groupConversationActivity(events)
        .map((group) =>
            group.events.map((event) => event.eventId).toList(growable: false))
        .toList(growable: false);

@visibleForTesting
List<String> conversationActivityLabelsForTesting(List<AgentEvent> events) =>
    _groupConversationActivity(events)
        .map((group) => _activityPresentation(group).label)
        .toList(growable: false);

bool _activityGroupFinished(List<AgentEvent> events) {
  final type = events.last.type;
  return type.endsWith('.completed') || type.contains('error');
}

String _activityEventFamily(AgentEvent event) => event.type.split('.').first;

String? _activityOperationId(AgentEvent event) =>
    _activityString(event.payload, const <String>{
      'callId',
      'call_id',
      'toolCallId',
      'tool_call_id',
    }) ??
    _activityString(event.payload, const <String>{
      'partId',
      'partID',
      'part_id',
      'providerPartId',
      'provider_part_id',
    }) ??
    _activityString(
      event.payload,
      const <String>{'itemId'},
      allowGenericId: true,
    );

_ActivityPresentation _activityPresentation(_ActivityEventGroup group) {
  final eyesFailure = _eyesFailureFromActivity(group);
  if (eyesFailure != null) {
    return _ActivityPresentation(
      kind: _ActivityKind.error,
      label: 'EYES',
      target: null,
      snippet: eyesFailure.notice,
    );
  }
  final kind = _activityKind(group);
  final snippet = _activitySnippetText(group);
  return _ActivityPresentation(
    kind: kind,
    label: switch (kind) {
      _ActivityKind.read => 'Read',
      _ActivityKind.write => 'Write',
      _ActivityKind.edit => 'Edit',
      _ActivityKind.run => 'Run',
      _ActivityKind.search => 'Search',
      _ActivityKind.browse => 'Browse',
      _ActivityKind.agent => 'Delegate',
      _ActivityKind.error => 'Issue',
      _ActivityKind.tool => 'Tool',
    },
    target: _activityTarget(group, snippet),
    snippet: snippet,
  );
}

bool _isEyesActivity(_ActivityEventGroup group) {
  final normalized = _activityToolName(group)
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9]+'), '_');
  return normalized == 'ask_eyes' ||
      normalized.endsWith('_ask_eyes') ||
      normalized == 'tethoq_turn_support' ||
      normalized.endsWith('_tethoq_turn_support') ||
      normalized == 'ask_visual_support';
}

_EyesFailureFingerprint? _eyesFailureFromActivity(
  _ActivityEventGroup group,
) {
  if (!_isEyesActivity(group) || !group.events.any(_activityEventFailed)) {
    return null;
  }
  final identifiers = <String>{};
  for (final event in group.events) {
    identifiers.addAll(_eyesFailureIdentifiers(event.payload));
  }
  final rawFailure = group.events
      .expand((event) => _activityStrings(
            event.payload,
            const <String>{
              'output',
              'error',
              'message',
              'text',
              'result',
              'content',
              'detail',
            },
          ))
      .join(' ');
  return _EyesFailureFingerprint(
    identifiers: identifiers,
    notice: _safeEyesFailureNotice(rawFailure),
  );
}

_ActivityKind _activityKind(_ActivityEventGroup group) {
  final type = group.events.first.type.toLowerCase();
  if (group.events.any(_activityEventFailed)) return _ActivityKind.error;
  if (type.startsWith('command.')) return _ActivityKind.run;
  if (type.startsWith('file.')) return _ActivityKind.edit;
  final name = _activityToolName(group).toLowerCase().replaceAll(
        RegExp(r'[^a-z0-9]+'),
        '_',
      );
  final description = '$name ${_activitySnippetText(group)}'.toLowerCase();
  if (RegExp(r'(^|_)(read|read_file|view|open_file|inspect)($|_)')
          .hasMatch(name) ||
      RegExp(r'\b(read|inspect(?:ing|ed)?|view(?:ing|ed)?|opened?)\b')
          .hasMatch(description)) {
    return _ActivityKind.read;
  }
  if (RegExp(r'(^|_)(write|write_file|create_file|save)($|_)').hasMatch(name)) {
    return _ActivityKind.write;
  }
  if (RegExp(r'(^|_)(edit|patch|apply_patch|replace|update_file)($|_)')
      .hasMatch(name)) {
    return _ActivityKind.edit;
  }
  if (RegExp(r'(^|_)(bash|shell|exec|execute|command|terminal)($|_)')
      .hasMatch(name)) {
    return _ActivityKind.run;
  }
  if (RegExp(r'(^|_)(search|grep|find|glob|query)($|_)').hasMatch(name)) {
    return _ActivityKind.search;
  }
  if (RegExp(r'(^|_)(browser|web|navigate|screenshot|page)($|_)')
      .hasMatch(name)) {
    return _ActivityKind.browse;
  }
  if (RegExp(
          r'(^|_)(spawn_agent|send_message|wait_agent|delegate|subagent)($|_)')
      .hasMatch(name)) {
    return _ActivityKind.agent;
  }
  if (type.startsWith('agent.')) return _ActivityKind.agent;
  return _ActivityKind.tool;
}

bool _activityEventFailed(AgentEvent event) {
  if (event.type.toLowerCase().contains('error')) return true;
  final status =
      _activityString(event.payload, const <String>{'status'})?.toLowerCase();
  return status == 'failed' || status == 'error';
}

String _activityToolName(_ActivityEventGroup group) {
  for (final event in group.events) {
    final name = _activityString(
      event.payload,
      const <String>{'tool', 'name', 'toolName', 'tool_name'},
    );
    if (name != null) return name;
  }
  return group.events.first.type.split('.').first;
}

String? _activityTarget(_ActivityEventGroup group, String snippet) {
  String? path;
  for (final event in group.events) {
    path ??= _activityString(
      event.payload,
      const <String>{'path', 'filePath', 'file_path', 'filename'},
    );
  }
  path ??= RegExp(r'<path>([^<]+)</path>', caseSensitive: false)
      .firstMatch(snippet)
      ?.group(1)
      ?.trim();
  final lines = _activityLineRange(group, snippet);
  if (path != null && path.isNotEmpty) {
    final compactPath = _compactActivityPath(path);
    return lines == null ? compactPath : '$compactPath · $lines';
  }
  final kind = _activityKind(group);
  if (kind == _ActivityKind.run) {
    for (final event in group.events) {
      final command = _activityString(
        event.payload,
        const <String>{'command'},
      );
      if (command != null) return _compactActivityTarget(command);
    }
  }
  if (kind == _ActivityKind.search) {
    for (final event in group.events) {
      final query = _activityString(
        event.payload,
        const <String>{'pattern', 'query', 'search'},
      );
      if (query != null) return _compactActivityTarget(query);
    }
  }
  return lines;
}

String? _activityLineRange(_ActivityEventGroup group, String snippet) {
  for (final event in group.events) {
    final start = _activityNumber(event.payload, const <String>{
      'line',
      'startLine',
      'lineStart',
      'line_start',
      'offset'
    });
    final end = _activityNumber(
        event.payload, const <String>{'endLine', 'lineEnd', 'line_end'});
    final limit = _activityNumber(event.payload, const <String>{'limit'});
    if (start != null) {
      final calculatedEnd = end ?? (limit == null ? null : start + limit - 1);
      return calculatedEnd == null || calculatedEnd == start
          ? 'line $start'
          : 'lines $start–$calculatedEnd';
    }
  }
  final described = RegExp(
          r'(?:showing\s+)?lines?\s+(\d+)(?:\s*[-–—]\s*(\d+))?',
          caseSensitive: false)
      .firstMatch(snippet);
  if (described != null) {
    final start = described.group(1)!;
    final end = described.group(2);
    return end == null ? 'line $start' : 'lines $start–$end';
  }
  final numbered = RegExp(r'^\s*(\d+):', multiLine: true)
      .allMatches(snippet)
      .map((match) => int.tryParse(match.group(1)!))
      .whereType<int>()
      .toList(growable: false);
  if (numbered.isNotEmpty) {
    return numbered.first == numbered.last
        ? 'line ${numbered.first}'
        : 'lines ${numbered.first}–${numbered.last}';
  }
  return null;
}

String _activitySnippetText(_ActivityEventGroup group) {
  var combined = '';
  for (final event in group.events) {
    final values = _activityStrings(
      event.payload,
      const <String>{
        'output',
        'content',
        'text',
        'delta',
        'code',
        'patch',
        'diff',
        'message',
        'command',
      },
    );
    for (final value in values) {
      final cleaned = _cleanActivitySnippet(value);
      if (cleaned.isEmpty || cleaned == combined) continue;
      if (combined.isEmpty || cleaned.startsWith(combined)) {
        combined = cleaned;
      } else if (!combined.contains(cleaned)) {
        combined = '$combined\n$cleaned';
      }
    }
  }
  return combined.trim();
}

String _cleanActivitySnippet(String value) {
  final trimmed = value.trim();
  final content =
      RegExp(r'<content>\s*([\s\S]*?)\s*</content>', caseSensitive: false)
          .firstMatch(trimmed)
          ?.group(1);
  if (content != null) return content.trim();
  return trimmed
      .replaceAll(
          RegExp(r'</?(?:path|type|content)>', caseSensitive: false), '')
      .trim();
}

String? _activityString(Map<Object?, Object?> source, Set<String> keys,
    {bool allowGenericId = false, int depth = 0}) {
  final values = _activityStrings(source, keys,
      allowGenericId: allowGenericId, depth: depth);
  return values.isEmpty ? null : values.first;
}

List<String> _activityStrings(Map<Object?, Object?> source, Set<String> keys,
    {bool allowGenericId = false, int depth = 0}) {
  if (depth > 4) return const <String>[];
  final result = <String>[];
  for (final key in keys) {
    final value = source[key];
    if (value is String && value.trim().isNotEmpty) result.add(value);
  }
  if (allowGenericId) {
    final id = source['id'];
    if (id is String && id.trim().isNotEmpty) result.add(id);
  }
  for (final entry in source.entries) {
    final key = entry.key.toString().toLowerCase();
    if (_isSensitiveActivityKey(key)) continue;
    final value = entry.value;
    if (value is Map<Object?, Object?>) {
      result.addAll(_activityStrings(value, keys,
          allowGenericId: allowGenericId, depth: depth + 1));
    } else if (value is List<Object?>) {
      for (final item in value) {
        if (item is Map<Object?, Object?>) {
          result.addAll(_activityStrings(item, keys,
              allowGenericId: allowGenericId, depth: depth + 1));
        }
      }
    }
  }
  return result.toSet().toList(growable: false);
}

int? _activityNumber(Map<Object?, Object?> source, Set<String> keys,
    {int depth = 0}) {
  if (depth > 4) return null;
  for (final key in keys) {
    final value = source[key];
    if (value is num) return value.toInt();
    if (value is String) {
      final parsed = int.tryParse(value);
      if (parsed != null) return parsed;
    }
  }
  for (final entry in source.entries) {
    if (_isSensitiveActivityKey(entry.key.toString().toLowerCase())) continue;
    final value = entry.value;
    if (value is Map<Object?, Object?>) {
      final nested = _activityNumber(value, keys, depth: depth + 1);
      if (nested != null) return nested;
    }
  }
  return null;
}

bool _isSensitiveActivityKey(String key) =>
    key.contains('token') ||
    key.contains('secret') ||
    key.contains('password') ||
    key.contains('credential') ||
    key.contains('authorization') ||
    key.contains('base64');

String _compactActivityPath(String path) {
  final segments = path
      .replaceAll('\\', '/')
      .split('/')
      .where((segment) => segment.isNotEmpty)
      .toList(growable: false);
  if (segments.length <= 2) return segments.join('/');
  return segments.sublist(segments.length - 2).join('/');
}

String _compactActivityTarget(String value) {
  final oneLine = value.trim().split(RegExp(r'\r?\n')).first;
  return oneLine.length <= 96 ? oneLine : '${oneLine.substring(0, 93)}…';
}

bool _isLongActivitySnippet(String text) =>
    text.length > 900 || '\n'.allMatches(text).length >= 14;

IconData _activityIcon(_ActivityKind kind) => switch (kind) {
      _ActivityKind.read => Icons.auto_stories_outlined,
      _ActivityKind.write => Icons.note_add_outlined,
      _ActivityKind.edit => Icons.edit_note_outlined,
      _ActivityKind.run => Icons.terminal_rounded,
      _ActivityKind.search => Icons.travel_explore_outlined,
      _ActivityKind.browse => Icons.language_rounded,
      _ActivityKind.agent => Icons.alt_route_rounded,
      _ActivityKind.error => Icons.error_outline_rounded,
      _ActivityKind.tool => Icons.bolt_outlined,
    };

class _ApprovalCard extends StatelessWidget {
  const _ApprovalCard({required this.approval});

  final ApprovalRequest approval;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final expired = approval.isExpired();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(children: <Widget>[
              const Icon(Icons.security),
              const SizedBox(width: 8),
              Expanded(
                  child: Text(approval.title,
                      style: Theme.of(context).textTheme.titleMedium))
            ]),
            if (approval.reason != null)
              Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(approval.reason!)),
            if (approval.command != null)
              Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: SelectableText(approval.command!)),
            if (approval.workingDirectory != null)
              Text('Directory: ${approval.workingDirectory}'),
            if (approval.affectedFiles.isNotEmpty)
              Text('Files: ${approval.affectedFiles.join(', ')}'),
            if (approval.networkDestinations.isNotEmpty)
              Text('Network: ${approval.networkDestinations.join(', ')}'),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              children: approval.choices
                  .map((choice) => choice.kind == 'reject'
                      ? OutlinedButton(
                          onPressed: expired
                              ? null
                              : () => unawaited(
                                  store.respondToApproval(approval, choice.id)),
                          child: Text(choice.label))
                      : FilledButton(
                          onPressed: expired
                              ? null
                              : () => unawaited(
                                  store.respondToApproval(approval, choice.id)),
                          child: Text(choice.label)))
                  .toList(growable: false),
            ),
          ],
        ),
      ),
    );
  }
}

class _UserInputCard extends StatefulWidget {
  const _UserInputCard({required this.request});

  final UserInputRequest request;

  @override
  State<_UserInputCard> createState() => _UserInputCardState();
}

class _UserInputCardState extends State<_UserInputCard> {
  final _answer = TextEditingController();
  String? _error;
  bool _sending = false;

  @override
  void dispose() {
    _answer.dispose();
    super.dispose();
  }

  JsonMap get _question {
    final questions = widget.request.request['questions'];
    if (questions is List<Object?> && questions.isNotEmpty) {
      final first = questions.first;
      if (first is Map<Object?, Object?>) {
        return first.map<String, Object?>(
            (key, value) => MapEntry<String, Object?>(key.toString(), value));
      }
    }
    return widget.request.request;
  }

  String get _answerKey {
    final value = _question['id'] ?? widget.request.request['questionId'];
    return value is String && value.trim().isNotEmpty ? value : 'answer';
  }

  List<String> get _options {
    final source = _question['options'] ?? widget.request.request['options'];
    if (source is! List<Object?>) return const <String>[];
    return source
        .map((option) {
          if (option is String) return option;
          if (option is Map<Object?, Object?>) {
            final label = option['label'] ?? option['value'];
            if (label is String) return label;
          }
          return '';
        })
        .where((value) => value.trim().isNotEmpty)
        .toList(growable: false);
  }

  String get _prompt {
    final value = _question['question'];
    return value is String && value.trim().isNotEmpty
        ? value
        : widget.request.prompt ?? 'The agent needs more information.';
  }

  Future<void> _submit(String value) async {
    final answer = value.trim();
    if (answer.isEmpty || _sending) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      await StoreScope.of(context)
          .respondToUserInput(widget.request, <String, Object?>{
        _answerKey: answer,
      });
    } on Object catch (caught) {
      if (mounted) {
        setState(() => _error = caught
            .toString()
            .replaceFirst(RegExp(r'^(Exception|StateError):\s*'), ''));
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final options = _options;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(children: <Widget>[
              const Icon(Icons.question_answer),
              const SizedBox(width: 8),
              Expanded(
                  child: Text(widget.request.title,
                      style: Theme.of(context).textTheme.titleMedium))
            ]),
            Padding(
                padding: const EdgeInsets.only(top: 8), child: Text(_prompt)),
            const SizedBox(height: 12),
            if (options.isNotEmpty)
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: options
                    .map((option) => FilledButton.tonal(
                          onPressed: _sending
                              ? null
                              : () => unawaited(_submit(option)),
                          child: Text(option),
                        ))
                    .toList(growable: false),
              )
            else ...<Widget>[
              TextField(
                  key: const Key('user-input-answer'),
                  controller: _answer,
                  minLines: 1,
                  maxLines: 5,
                  decoration: const InputDecoration(
                      labelText: 'Your answer', border: OutlineInputBorder())),
              const SizedBox(height: 10),
              FilledButton(
                onPressed:
                    _sending ? null : () => unawaited(_submit(_answer.text)),
                child: _sending
                    ? const SizedBox.square(
                        dimension: 17,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Send answer'),
              ),
            ],
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error!,
                    style:
                        TextStyle(color: Theme.of(context).colorScheme.error)),
              ),
          ],
        ),
      ),
    );
  }
}

class NewSessionScreen extends StatefulWidget {
  const NewSessionScreen({super.key});

  @override
  State<NewSessionScreen> createState() => _NewSessionScreenState();
}

class _NewSessionScreenState extends State<NewSessionScreen> {
  bool _starting = false;
  String? _error;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_starting && _error == null) unawaited(_startDraft());
  }

  Future<void> _startDraft() async {
    if (_starting) return;
    final store = StoreScope.of(context);
    final selected = _preferredNewTaskProvider(store);
    if (selected == null) {
      setState(() => _error = 'No agent is ready to start a task.');
      return;
    }
    setState(() {
      _starting = true;
      _error = null;
    });
    try {
      final session = await store.startPreparedSession(selected.providerId);
      if (!mounted) return;
      await Navigator.of(context)
          .pushReplacement(sessionScreenRoute(session.id));
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _starting = false;
        _error = error
            .toString()
            .replaceFirst(RegExp(r'^(Exception|StateError):\s*'), '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: _error == null
              ? const SizedBox.square(
                  key: Key('new-task-starting'),
                  dimension: 24,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Text(_error!, textAlign: TextAlign.center),
                      const SizedBox(height: 14),
                      FilledButton(
                        onPressed: () {
                          setState(() => _error = null);
                          unawaited(_startDraft());
                        },
                        child: const Text('Try again'),
                      ),
                    ],
                  ),
                ),
        ),
      ),
    );
  }
}

class HostsScreen extends StatelessWidget {
  const HostsScreen({super.key});

  Future<void> _editDictationDictionary(
      BuildContext context, RemoteAppStore store) async {
    final controller =
        TextEditingController(text: store.dictationDictionary.join('\n'));
    TransitionRoute<bool>? dialogRoute;
    try {
      final save = await showDialog<bool>(
        context: context,
        builder: (dialogContext) {
          dialogRoute ??= ModalRoute.of<bool>(dialogContext);
          return AlertDialog(
            title: const Text('Dictation dictionary'),
            content: SizedBox(
              width: 440,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  const Text(
                      'Add names, technical terms, or preferred spellings. Use one entry per line.'),
                  const SizedBox(height: 12),
                  TextField(
                    key: const Key('dictation-dictionary-field'),
                    controller: controller,
                    minLines: 5,
                    maxLines: 10,
                    decoration: const InputDecoration(
                      hintText: 'OpenCode\nTypeScript\nPostgreSQL',
                      border: OutlineInputBorder(),
                    ),
                  ),
                ],
              ),
            ),
            actions: <Widget>[
              TextButton(
                  style: TextButton.styleFrom(minimumSize: const Size(64, 44)),
                  onPressed: () => Navigator.pop(dialogContext, false),
                  child: const Text('Cancel')),
              FilledButton(
                  style:
                      FilledButton.styleFrom(minimumSize: const Size(64, 44)),
                  onPressed: () => Navigator.pop(dialogContext, true),
                  child: const Text('Save')),
            ],
          );
        },
      );
      final entries = save == true ? controller.text.split('\n') : null;
      await dialogRoute?.completed;
      if (entries != null) {
        await store.setDictationDictionary(entries);
      }
    } finally {
      controller.dispose();
    }
  }

  Future<void> _showDictationSourceDetails(BuildContext context,
      RemoteAppStore store, TranscriptionSource source) async {
    final ready = store.isDictationSourceReady(source);
    final controller = TextEditingController();
    TransitionRoute<void>? sheetRoute;
    var busy = false;
    String? error;
    try {
      await showModalBottomSheet<void>(
        context: context,
        useSafeArea: true,
        showDragHandle: true,
        isScrollControlled: true,
        builder: (sheetContext) {
          sheetRoute ??= ModalRoute.of<void>(sheetContext);
          return StatefulBuilder(
            builder: (sheetContext, setSheetState) => Padding(
              padding: EdgeInsets.fromLTRB(
                  20, 0, 20, 20 + MediaQuery.viewInsetsOf(sheetContext).bottom),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    Text(source.label,
                        style: Theme.of(sheetContext).textTheme.titleMedium),
                    const SizedBox(height: 6),
                    if (!ready) ...<Widget>[
                      Text(
                        'Setup needed',
                        style: Theme.of(sheetContext)
                            .textTheme
                            .bodySmall
                            ?.copyWith(
                              color: Theme.of(sheetContext)
                                  .colorScheme
                                  .onSurfaceVariant,
                              fontWeight: FontWeight.w600,
                            ),
                      ),
                      const SizedBox(height: 4),
                    ],
                    Text(
                      'Uses ${source.credentialLabel ?? 'an API key'}, separate from a consumer subscription. The key is checked with the provider and encrypted on your paired computer.',
                      style: Theme.of(sheetContext).textTheme.bodySmall,
                    ),
                    const SizedBox(height: 14),
                    TextField(
                      key: Key('dictation-api-key-${source.id}'),
                      controller: controller,
                      autofocus: !ready,
                      obscureText: true,
                      autocorrect: false,
                      enableSuggestions: false,
                      maxLength: 512,
                      decoration: InputDecoration(
                        labelText: source.credentialLabel ?? 'API key',
                        hintText: 'Paste API key',
                        errorText: error,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      alignment: WrapAlignment.end,
                      spacing: 6,
                      runSpacing: 6,
                      children: <Widget>[
                        if (source.credentialSetupUrl != null)
                          TextButton.icon(
                            onPressed: busy
                                ? null
                                : () => unawaited(launchUrl(
                                    Uri.parse(source.credentialSetupUrl!),
                                    mode: LaunchMode.externalApplication)),
                            icon:
                                const Icon(Icons.open_in_new_rounded, size: 18),
                            label: const Text('Get API key'),
                          ),
                        if (ready)
                          TextButton(
                            onPressed: busy
                                ? null
                                : () async {
                                    setSheetState(() => busy = true);
                                    try {
                                      await store.configureDictationSource(
                                          source.id,
                                          clear: true);
                                      if (sheetContext.mounted) {
                                        Navigator.pop(sheetContext);
                                      }
                                    } on Object catch (caught) {
                                      if (!sheetContext.mounted) return;
                                      setSheetState(() {
                                        busy = false;
                                        error = caught.toString();
                                      });
                                    }
                                  },
                            child: const Text('Remove saved key'),
                          ),
                        TextButton(
                          onPressed:
                              busy ? null : () => Navigator.pop(sheetContext),
                          child: const Text('Cancel'),
                        ),
                        FilledButton(
                          onPressed: busy
                              ? null
                              : () async {
                                  final key = controller.text.trim();
                                  if (key.length < 8) {
                                    setSheetState(
                                        () => error = 'Paste a valid API key.');
                                    return;
                                  }
                                  setSheetState(() {
                                    busy = true;
                                    error = null;
                                  });
                                  try {
                                    await store.configureDictationSource(
                                        source.id,
                                        apiKey: key);
                                    if (sheetContext.mounted) {
                                      Navigator.pop(sheetContext);
                                    }
                                  } on Object catch (caught) {
                                    if (!sheetContext.mounted) return;
                                    setSheetState(() {
                                      busy = false;
                                      error = caught.toString();
                                    });
                                  }
                                },
                          child: Text(busy ? 'Checking…' : 'Save and use'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      );
      await sheetRoute?.completed;
    } finally {
      controller.dispose();
    }
  }

  Future<void> _removeHost(
      BuildContext context, RemoteAppStore store, PairedHost host) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Remove this computer?'),
        content: const Text(
            'Tethoq will revoke its access when it is reachable. You will need to pair it again to reconnect.'),
        actions: <Widget>[
          TextButton(
              style: TextButton.styleFrom(minimumSize: const Size(64, 44)),
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancel')),
          FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size(64, 44)),
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Remove')),
        ],
      ),
    );
    if (confirmed == true) await store.removeHost(host.hostId);
  }

  Future<void> _showHostDetails(
      BuildContext context, RemoteAppStore store, PairedHost host) async {
    final current = store.activeHost?.hostId == host.hostId;
    final remove = await showModalBottomSheet<bool>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      builder: (sheetContext) => _SettingsDetailsSheet(
        title: host.displayName ?? host.hostId,
        details: <(String, String)>[
          (
            'Connection',
            current ? _bridgeStateLabel(store.connectionState) : 'Saved'
          ),
          ('Endpoint', host.endpoint),
        ],
        action: TextButton.icon(
          style: TextButton.styleFrom(minimumSize: const Size(0, 44)),
          onPressed: () => Navigator.pop(sheetContext, true),
          icon: const Icon(Icons.delete_outline_rounded),
          label: const Text('Remove computer'),
        ),
      ),
    );
    if (remove == true && context.mounted) {
      await _removeHost(context, store, host);
    }
  }

  Future<void> _revokeDevice(
      BuildContext context, RemoteAppStore store, PairedDevice device) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Revoke this phone?'),
        content: const Text(
            'This phone will need to pair again before it can use this computer.'),
        actions: <Widget>[
          TextButton(
              style: TextButton.styleFrom(minimumSize: const Size(64, 44)),
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancel')),
          FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size(64, 44)),
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Revoke')),
        ],
      ),
    );
    if (confirmed == true) {
      await store.revokePairedDevice(device.credentialId);
    }
  }

  Future<void> _showProviderDetails(BuildContext context, RemoteAppStore store,
      ProviderConnection provider) async {
    final canReconnect = !provider.detected ||
        provider.authenticated == false ||
        provider.state == 'failed' ||
        provider.state == 'disconnected' ||
        provider.state == 'unknown';
    final reconnect = await showModalBottomSheet<bool>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      builder: (sheetContext) => _SettingsDetailsSheet(
        title: provider.displayName,
        details: <(String, String)>[
          ('Status', _providerStateLabel(provider.state)),
          ('Available', provider.detected ? 'Yes' : 'No'),
          (
            'Authentication',
            provider.authenticated == null
                ? 'Unknown'
                : provider.authenticated!
                    ? 'Ready'
                    : 'Needed'
          ),
        ],
        action: canReconnect
            ? FilledButton.icon(
                style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
                onPressed: () => Navigator.pop(sheetContext, true),
                icon: const Icon(Icons.refresh_rounded),
                label: const Text('Reconnect'),
              )
            : null,
      ),
    );
    if (reconnect == true) {
      await store.reconnectProvider(provider.providerId);
    }
  }

  Future<void> _editAgentDefault(BuildContext context, RemoteAppStore store,
      ProviderConnection provider) async {
    final models = await store.loadModels(provider.providerId);
    if (!context.mounted) return;
    if (models.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
            content:
                Text('No models are available for ${provider.displayName}.')),
      );
      return;
    }
    final current = store.agentDefaultSelectionFor(provider.providerId, models);
    final selected = await showModalBottomSheet<_ModelChoice>(
      context: context,
      constraints: const BoxConstraints(maxWidth: 760),
      showDragHandle: true,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (sheetContext) => FractionallySizedBox(
        heightFactor: .9,
        child: _ModelPickerSheet(
          models: models,
          recentModels: store.recentModels(models),
          currentProviderId: provider.providerId,
          selectedModelId: current?.modelId,
          visual: providerVisualThemeFor(provider.providerId),
        ),
      ),
    );
    if (!context.mounted || selected == null) return;
    final model = models
        .where((candidate) => candidate.id == selected.modelId)
        .firstOrNull;
    if (model == null) return;
    final efforts = model.reasoningEfforts;
    String? reasoningEffort;
    if (efforts.isNotEmpty) {
      final initialEffort = current?.modelId == model.id &&
              efforts.any((effort) => effort.id == current?.reasoningEffort)
          ? current?.reasoningEffort
          : _defaultConcreteReasoningEffort(model) ?? efforts.first.id;
      reasoningEffort = await showModalBottomSheet<String>(
        context: context,
        constraints: const BoxConstraints(maxWidth: 640),
        showDragHandle: true,
        useSafeArea: true,
        builder: (sheetContext) => Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            ListTile(
              title: const Text('Reasoning for new tasks'),
              subtitle: Text(model.displayName),
            ),
            ...efforts.map((effort) => ListTile(
                  key: Key('agent-default-reasoning-${effort.id}'),
                  selected: effort.id == initialEffort,
                  title: Text(_effortDisplayLabel(
                      effort.id, model.id, provider.providerId)),
                  trailing: effort.id == initialEffort
                      ? const Icon(Icons.check_rounded)
                      : null,
                  onTap: () => Navigator.pop(sheetContext, effort.id),
                )),
            const SizedBox(height: 8),
          ],
        ),
      );
      if (!context.mounted || reasoningEffort == null) return;
    }
    try {
      await store.setAgentDefault(DelegationSelection(
        providerId: provider.providerId,
        modelId: model.id,
        reasoningEffort: reasoningEffort,
      ));
    } on Object catch (caught) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(caught
            .toString()
            .replaceFirst(RegExp(r'^(Exception|StateError):\s*'), '')),
      ));
    }
  }

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final agents = store.providers
        .where((provider) =>
            provider.detected &&
            provider.capabilities.createSession &&
            provider.capabilities.modelEnumeration &&
            _supportsTurnModelSelection(provider.providerId))
        .toList(growable: false)
      ..sort((left, right) => left.displayName.compareTo(right.displayName));
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: _AdaptivePage(
          maxWidth: 680,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 28),
            children: <Widget>[
              _SettingsSectionLabel(label: 'Composer'),
              ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 2),
                title: const Text('Default send behavior'),
                subtitle: Text(store.defaultDeliveryMode == 'steer'
                    ? 'Guide active work when supported'
                    : 'Send after current work'),
                trailing: DropdownButton<String>(
                  key: const Key('default-delivery-mode'),
                  value: store.defaultDeliveryMode,
                  underline: const SizedBox.shrink(),
                  items: const <DropdownMenuItem<String>>[
                    DropdownMenuItem(value: 'queue', child: Text('Queue')),
                    DropdownMenuItem(value: 'steer', child: Text('Steer')),
                  ],
                  onChanged: (value) {
                    if (value != null) {
                      unawaited(store.setDefaultDeliveryMode(value));
                    }
                  },
                ),
              ),
              ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 2),
                title: const Text('Reasoning display'),
                subtitle: const Text(
                    'Only changes what opens here, not model effort.'),
                trailing: DropdownButton<String>(
                  key: const Key('reasoning-display-mode'),
                  value: store.reasoningDisplayMode,
                  underline: const SizedBox.shrink(),
                  items: const <DropdownMenuItem<String>>[
                    DropdownMenuItem(value: 'compact', child: Text('Compact')),
                    DropdownMenuItem(
                        value: 'expanded', child: Text('Expanded')),
                  ],
                  onChanged: (value) {
                    if (value != null) {
                      unawaited(store.setReasoningDisplayMode(value));
                    }
                  },
                ),
              ),
              if (agents.isNotEmpty) ...<Widget>[
                const Divider(height: 1),
                _SettingsExpansion(
                  key: const Key('settings-section-agent-defaults'),
                  title: 'Agent defaults',
                  subtitle: 'Model and reasoning for new tasks',
                  onExpansionChanged: (expanded) {
                    if (!expanded) return;
                    for (final agent in agents) {
                      unawaited(store
                          .loadModels(agent.providerId)
                          .catchError((Object _) => const <RemoteModel>[]));
                    }
                  },
                  children: <Widget>[
                    ...agents.map((agent) {
                      final models = store.modelsByProvider[agent.providerId];
                      final defaults = models == null
                          ? null
                          : store.agentDefaultSelectionFor(
                              agent.providerId, models);
                      final model = models
                          ?.where(
                              (candidate) => candidate.id == defaults?.modelId)
                          .firstOrNull;
                      final summary = models == null
                          ? 'Loading model choices…'
                          : model == null
                              ? 'No model choices available'
                              : <String>[
                                  model.displayName,
                                  if (defaults?.reasoningEffort != null)
                                    _effortDisplayLabel(
                                        defaults!.reasoningEffort!,
                                        model.id,
                                        agent.providerId),
                                ].join(' · ');
                      return Column(
                        children: <Widget>[
                          ListTile(
                            key: Key('agent-default-${agent.providerId}'),
                            contentPadding:
                                const EdgeInsets.symmetric(horizontal: 2),
                            leading: ProviderLogo(
                                providerId: agent.providerId, size: 28),
                            title: Text(agent.displayName),
                            subtitle: Text(summary,
                                maxLines: 1, overflow: TextOverflow.ellipsis),
                            trailing: const Icon(Icons.chevron_right_rounded,
                                size: 20),
                            onTap: () => unawaited(
                                _editAgentDefault(context, store, agent)),
                          ),
                          const Divider(height: 1),
                        ],
                      );
                    }),
                  ],
                ),
              ],
              const Divider(height: 24),
              _SettingsExpansion(
                key: const Key('settings-section-dictation'),
                title: 'Dictation',
                subtitle: store.selectedDictationSource?.label ??
                    'Choose speech-to-text',
                children: <Widget>[
                  ...store.dictationSources.map((source) => Column(
                        children: <Widget>[
                          ListTile(
                            key: Key('dictation-source-setting-${source.id}'),
                            contentPadding:
                                const EdgeInsets.symmetric(horizontal: 2),
                            leading: _SettingsStateMark(
                              label: source.isReady ? 'Ready' : 'Setup needed',
                              tone: source.isReady
                                  ? _SettingsStateTone.ready
                                  : _SettingsStateTone.attention,
                            ),
                            title: Text(source.label),
                            trailing: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: <Widget>[
                                if (store.selectedDictationSource?.id ==
                                    source.id)
                                  const Icon(Icons.check_rounded, size: 20),
                                IconButton(
                                  key: Key(
                                      'dictation-source-details-${source.id}'),
                                  tooltip: 'Source details',
                                  onPressed: () => unawaited(
                                      _showDictationSourceDetails(
                                          context, store, source)),
                                  icon: const Icon(Icons.info_outline_rounded,
                                      size: 20),
                                ),
                              ],
                            ),
                            onTap: source.isReady
                                ? () => unawaited(
                                    store.setDictationSource(source.id))
                                : () => unawaited(_showDictationSourceDetails(
                                    context, store, source)),
                          ),
                          const Divider(height: 1),
                        ],
                      )),
                  ListTile(
                    key: const Key('dictation-dictionary-setting'),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 2),
                    leading: const Icon(Icons.spellcheck_rounded),
                    title: const Text('Custom words'),
                    subtitle: const Text('Names and preferred spellings'),
                    trailing: const Icon(Icons.chevron_right_rounded, size: 20),
                    onTap: () =>
                        unawaited(_editDictationDictionary(context, store)),
                  ),
                ],
              ),
              const Divider(height: 1),
              _SettingsExpansion(
                key: const Key('settings-section-computers'),
                title: 'Paired computers',
                subtitle: store.activeHost?.displayName ??
                    (store.hosts.isEmpty ? 'No computer paired' : null),
                children: <Widget>[
                  if (store.connectionState == BridgeConnectionState.online)
                    ListTile(
                      key: const Key('settings-open-desktop'),
                      contentPadding: const EdgeInsets.symmetric(horizontal: 2),
                      leading: const Icon(Icons.desktop_windows_outlined),
                      title: const Text('Open Tethoq Desktop'),
                      trailing: const Icon(Icons.open_in_new_rounded, size: 19),
                      onTap: () =>
                          unawaited(showDesktopWakeDialog(context, store)),
                    ),
                  ListTile(
                    key: const Key('pair-another-computer'),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 2),
                    leading: const Icon(Icons.qr_code_scanner_rounded),
                    title: const Text('Pair computer'),
                    trailing: const Icon(Icons.chevron_right_rounded, size: 20),
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                          builder: (_) => const PairingScreen()),
                    ),
                  ),
                  const Divider(height: 1),
                  ...store.hosts.map((host) {
                    final current = store.activeHost?.hostId == host.hostId;
                    final connecting = current &&
                        (store.connectionState ==
                                BridgeConnectionState.connecting ||
                            store.connectionState ==
                                BridgeConnectionState.reconnecting);
                    final online = current &&
                        store.connectionState == BridgeConnectionState.online;
                    return Column(
                      children: <Widget>[
                        ListTile(
                          key: Key('paired-computer-${host.hostId}'),
                          contentPadding:
                              const EdgeInsets.symmetric(horizontal: 2),
                          leading: _SettingsStateMark(
                            label: current
                                ? _bridgeStateLabel(store.connectionState)
                                : 'Saved',
                            tone: online
                                ? _SettingsStateTone.ready
                                : connecting
                                    ? _SettingsStateTone.busy
                                    : _SettingsStateTone.muted,
                          ),
                          title: Text(host.displayName ?? 'Paired computer'),
                          subtitle: current ? const Text('Current') : null,
                          trailing: IconButton(
                            key: Key('paired-computer-details-${host.hostId}'),
                            tooltip: 'Computer details',
                            onPressed: () => unawaited(
                                _showHostDetails(context, store, host)),
                            icon: const Icon(Icons.info_outline_rounded,
                                size: 20),
                          ),
                          onTap: online
                              ? null
                              : () => unawaited(store.connectHost(host)),
                        ),
                        const Divider(height: 1),
                      ],
                    );
                  }),
                  if (store.pairedDevices.isNotEmpty) ...<Widget>[
                    const Padding(
                      padding: EdgeInsets.fromLTRB(2, 18, 2, 4),
                      child: _SettingsSectionLabel(label: 'Phone access'),
                    ),
                    ...store.pairedDevices.map((device) {
                      final current =
                          device.deviceId == store.activeHost?.deviceId;
                      return Column(
                        children: <Widget>[
                          ListTile(
                            contentPadding:
                                const EdgeInsets.symmetric(horizontal: 2),
                            leading: const Icon(Icons.phone_android_outlined),
                            title:
                                Text(current ? 'This phone' : 'Paired phone'),
                            subtitle:
                                Text('Paired ${_shortDate(device.issuedAt)}'),
                            trailing: current
                                ? const _SettingsStateMark(
                                    label: 'Current',
                                    tone: _SettingsStateTone.ready,
                                  )
                                : IconButton(
                                    tooltip: 'Revoke phone access',
                                    icon: const Icon(Icons.link_off_rounded,
                                        size: 20),
                                    onPressed: () => unawaited(
                                        _revokeDevice(context, store, device)),
                                  ),
                          ),
                          const Divider(height: 1),
                        ],
                      );
                    }),
                  ],
                ],
              ),
              const Divider(height: 1),
              _SettingsExpansion(
                key: const Key('settings-section-agents'),
                title: 'Agent connections',
                children: store.providers
                    .map((provider) => Column(
                          children: <Widget>[
                            ListTile(
                              key: Key(
                                  'agent-connection-${provider.providerId}'),
                              contentPadding:
                                  const EdgeInsets.symmetric(horizontal: 2),
                              leading: _ProviderBadge(
                                  providerId: provider.providerId),
                              title: Text(provider.displayName),
                              trailing: _SettingsStateMark(
                                label: _providerStateLabel(provider.state),
                                tone: _providerStateTone(provider.state),
                              ),
                              onTap: () => unawaited(_showProviderDetails(
                                  context, store, provider)),
                            ),
                            const Divider(height: 1),
                          ],
                        ))
                    .toList(growable: false),
              ),
            ],
          )),
    );
  }
}

class _SettingsSectionLabel extends StatelessWidget {
  const _SettingsSectionLabel({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => Text(
        label,
        style: Theme.of(context)
            .textTheme
            .titleMedium
            ?.copyWith(fontWeight: FontWeight.w600),
      );
}

class _SettingsExpansion extends StatelessWidget {
  const _SettingsExpansion({
    required this.title,
    required this.children,
    this.subtitle,
    this.onExpansionChanged,
    super.key,
  });

  final String title;
  final String? subtitle;
  final List<Widget> children;
  final ValueChanged<bool>? onExpansionChanged;

  @override
  Widget build(BuildContext context) => ExpansionTile(
        tilePadding: const EdgeInsets.symmetric(horizontal: 2),
        childrenPadding: EdgeInsets.zero,
        shape: const Border(),
        collapsedShape: const Border(),
        onExpansionChanged: onExpansionChanged,
        title: Text(
          title,
          style: Theme.of(context)
              .textTheme
              .titleMedium
              ?.copyWith(fontWeight: FontWeight.w600),
        ),
        subtitle: subtitle == null
            ? null
            : Text(
                subtitle!,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
        children: children,
      );
}

enum _SettingsStateTone { ready, attention, busy, muted }

class _SettingsStateMark extends StatelessWidget {
  const _SettingsStateMark({required this.label, required this.tone});

  final String label;
  final _SettingsStateTone tone;

  @override
  Widget build(BuildContext context) {
    final color = switch (tone) {
      _SettingsStateTone.ready => const Color(0xff6edc91),
      _SettingsStateTone.attention => const Color(0xffffb061),
      _SettingsStateTone.busy => Theme.of(context).colorScheme.primary,
      _SettingsStateTone.muted =>
        Theme.of(context).colorScheme.onSurface.withValues(alpha: .42),
    };
    return Tooltip(
      message: label,
      child: Semantics(
        label: label,
        child: tone == _SettingsStateTone.busy
            ? SizedBox.square(
                dimension: 16,
                child:
                    CircularProgressIndicator(strokeWidth: 1.8, color: color),
              )
            : Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              ),
      ),
    );
  }
}

class _SettingsDetailsSheet extends StatelessWidget {
  const _SettingsDetailsSheet({
    required this.title,
    required this.details,
    this.action,
  });

  final String title;
  final List<(String, String)> details;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 2, 20, 28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Text(title, style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 16),
                ...details.map((detail) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 7),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          SizedBox(
                            width: 112,
                            child: Text(
                              detail.$1,
                              style: Theme.of(context)
                                  .textTheme
                                  .bodyMedium
                                  ?.copyWith(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurface
                                          .withValues(alpha: .62)),
                            ),
                          ),
                          Expanded(
                            child: SelectableText(
                              detail.$2,
                              style: Theme.of(context).textTheme.bodyMedium,
                            ),
                          ),
                        ],
                      ),
                    )),
                if (action != null) ...<Widget>[
                  const SizedBox(height: 18),
                  Align(alignment: Alignment.centerLeft, child: action!),
                ],
              ],
            ),
          ),
        ),
      );
}

String _bridgeStateLabel(BridgeConnectionState state) => switch (state) {
      BridgeConnectionState.online => 'Connected',
      BridgeConnectionState.connecting => 'Connecting',
      BridgeConnectionState.reconnecting => 'Reconnecting',
      BridgeConnectionState.disconnected => 'Not connected',
      BridgeConnectionState.closed => 'Closed',
    };

String _providerStateLabel(String state) => switch (state) {
      'online' => 'Connected',
      'working' => 'Working',
      'failed' => 'Needs attention',
      'needs_approval' => 'Approval needed',
      'needs_input' => 'Input needed',
      'disconnected' => 'Not connected',
      'idle' => 'Ready',
      _ => _titleCase(state),
    };

_SettingsStateTone _providerStateTone(String state) => switch (state) {
      'online' || 'idle' || 'completed' => _SettingsStateTone.ready,
      'working' => _SettingsStateTone.busy,
      'failed' ||
      'needs_approval' ||
      'needs_input' =>
        _SettingsStateTone.attention,
      _ => _SettingsStateTone.muted,
    };

class _ConnectionBanner extends StatelessWidget {
  const _ConnectionBanner({required this.state, required this.error});

  final BridgeConnectionState state;
  final String? error;

  @override
  Widget build(BuildContext context) {
    if (state == BridgeConnectionState.online && error == null)
      return const SizedBox.shrink();
    final displayMessage =
        error == null ? _bridgeStateLabel(state) : compactErrorDetail(error!);
    final disconnected = state == BridgeConnectionState.disconnected ||
        state == BridgeConnectionState.closed ||
        displayMessage.startsWith('Not connected');
    if (disconnected) {
      return Align(
        alignment: Alignment.centerLeft,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 5, 12, 3),
          child: DecoratedBox(
            key: const Key('connection-offline-status'),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.surfaceContainerHighest,
              border: Border.all(
                color: Theme.of(context)
                    .colorScheme
                    .outlineVariant
                    .withValues(alpha: .72),
              ),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Stack(
                    clipBehavior: Clip.none,
                    children: <Widget>[
                      const Icon(
                        Icons.computer_outlined,
                        key: Key('connection-offline-computer'),
                        size: 20,
                      ),
                      Positioned(
                        right: -2,
                        bottom: -1,
                        child: Container(
                          key: const Key('connection-offline-dot'),
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: Theme.of(context).colorScheme.error,
                            shape: BoxShape.circle,
                            border: Border.all(
                              color: Theme.of(context)
                                  .colorScheme
                                  .surfaceContainerHighest,
                              width: 1.5,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(width: 9),
                  const Text(
                    'Not connected',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    }
    return Material(
      color: error != null
          ? Theme.of(context).colorScheme.errorContainer
          : Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          children: <Widget>[
            if (state == BridgeConnectionState.connecting ||
                state == BridgeConnectionState.reconnecting)
              const Padding(
                  padding: EdgeInsets.only(right: 10),
                  child: SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2))),
            Expanded(child: Text(displayMessage)),
          ],
        ),
      ),
    );
  }
}

String _shortDate(DateTime value) {
  final local = value.toLocal();
  final month = local.month.toString().padLeft(2, '0');
  final day = local.day.toString().padLeft(2, '0');
  return '${local.year}-$month-$day';
}

String _sessionDisplayTitle(RemoteSession session) {
  if (session.providerId == 'grok' &&
      session.title.trim().toLowerCase() ==
          (session.project ?? '').trim().toLowerCase()) {
    return 'Untitled Grok session';
  }
  return session.title;
}

class _AdaptivePage extends StatelessWidget {
  const _AdaptivePage({
    required this.child,
    this.maxWidth = 840,
    this.bottomInset = 0,
    this.insetKey,
  });

  final Widget child;
  final double maxWidth;
  final double bottomInset;
  final Key? insetKey;

  @override
  Widget build(BuildContext context) {
    final page = Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: SizedBox(width: double.infinity, child: child),
      ),
    );
    if (insetKey == null && bottomInset == 0) return page;
    return Padding(
      key: insetKey,
      padding: EdgeInsets.only(bottom: bottomInset),
      child: page,
    );
  }
}

class _ProviderBadge extends StatelessWidget {
  const _ProviderBadge({required this.providerId, super.key});

  final String providerId;

  @override
  Widget build(BuildContext context) {
    return SizedBox.square(
      dimension: 30,
      child: Center(child: ProviderLogo(providerId: providerId, size: 22)),
    );
  }
}

bool _showsConversationState(String state) =>
    state == 'working' ||
    state == 'needs_approval' ||
    state == 'needs_input' ||
    state == 'failed' ||
    state == 'disconnected';

bool _showsConversationEvent(String type) =>
    type != 'session.status_changed' &&
    type != 'session.updated' &&
    type != 'message.started' &&
    type != 'message.delta' &&
    type != 'message.completed' &&
    type != 'message.queued' &&
    type != 'message.queue_updated' &&
    type != 'message.queue_removed' &&
    type != 'context.compaction_started' &&
    type != 'context.compaction_completed' &&
    type != 'context.compaction_failed' &&
    type != 'agent.completed' &&
    type != 'agent.interrupted' &&
    type != 'approval.requested' &&
    type != 'approval.resolved' &&
    type != 'user_input.requested';

bool _eventHasStructuredSubagent(AgentEvent event) =>
    jsonList(event.payload['parts']).any(
        (part) => part is Map<Object?, Object?> && part['type'] == 'subagent');

const Set<String> _builtInModelProviders = <String>{
  'codex',
  'opencode',
  'grok',
  'pi',
  'omp',
  'qwen',
  'goose',
  'kimi',
  'hermes',
  'cline',
  'copilot',
  'direct',
};

bool _supportsTurnModelSelection(String providerId) =>
    _builtInModelProviders.contains(providerId);

bool _supportsImageAttachments(String providerId) =>
    _builtInModelProviders.contains(providerId);

bool _supportsGenericFileAttachments(String providerId) =>
    providerId == 'opencode';

const int _maxPhoneAttachmentBytes = 25 * 1024 * 1024;

bool _isValidPhoneAttachmentLength(int byteLength) =>
    byteLength > 0 && byteLength <= _maxPhoneAttachmentBytes;

String _encodeBase64(Uint8List bytes) => base64Encode(bytes);

Uint8List? _prepareRemoteImage(Uint8List bytes) {
  final decoded = image_lib.decodeImage(bytes);
  if (decoded == null) return null;
  final source = image_lib.bakeOrientation(decoded);
  for (final longestEdge in const <int>[4096, 3072, 2048, 1600, 1280]) {
    final resized = source.width <= longestEdge && source.height <= longestEdge
        ? source
        : source.width >= source.height
            ? image_lib.copyResize(source, width: longestEdge)
            : image_lib.copyResize(source, height: longestEdge);
    for (final quality in const <int>[90, 82, 70, 58]) {
      final encoded = image_lib.encodeJpg(resized, quality: quality);
      if (encoded.length <= _maxPhoneAttachmentBytes) return encoded;
    }
  }
  return null;
}

String _imageMimeType(String name) {
  final extension = name.split('.').last.toLowerCase();
  return switch (extension) {
    'png' => 'image/png',
    'gif' => 'image/gif',
    'webp' => 'image/webp',
    _ => 'image/jpeg',
  };
}

String _genericMimeType(String name) {
  final extension =
      name.contains('.') ? name.split('.').last.toLowerCase() : '';
  return switch (extension) {
    'json' => 'application/json',
    'pdf' => 'application/pdf',
    'csv' => 'text/csv',
    'txt' || 'md' || 'log' => 'text/plain',
    'jpg' || 'jpeg' => 'image/jpeg',
    'png' => 'image/png',
    'gif' => 'image/gif',
    'webp' => 'image/webp',
    _ => 'application/octet-stream',
  };
}

bool _isArtifactPart(ContentPart part) {
  if (part.type == 'reasoning' || part.data['phase'] == 'commentary') {
    return true;
  }
  final lines = part.summary
      .trim()
      .split(RegExp(r'\r?\n'))
      .where((line) => line.trim().isNotEmpty)
      .toList(growable: false);
  return lines.isNotEmpty &&
      lines.every((line) {
        final value = line.trim();
        return value.length > 4 &&
            value.startsWith('**') &&
            value.endsWith('**');
      });
}

String _messagePartText(ContentPart part,
    {bool stripAttachmentEnvelope = false}) {
  var text = part.summary.trim();
  if (stripAttachmentEnvelope) {
    text = _withoutLegacyAttachmentEnvelope(text);
  }
  if (!_isArtifactPart(part)) return text;
  return text.split(RegExp(r'\r?\n')).map((line) {
    final value = line.trim();
    return value.length > 4 && value.startsWith('**') && value.endsWith('**')
        ? value.substring(2, value.length - 2).trim()
        : value;
  }).join('\n');
}

bool _isRawMarkupOnly(String text) {
  final value = text.trim();
  if (value.isEmpty || !value.startsWith('<') || !value.endsWith('>')) {
    return false;
  }
  if (RegExp(r'^(?:<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>)$')
      .hasMatch(value)) {
    return true;
  }
  if (RegExp(r'^<[A-Za-z][\w.:-]*(?:\s[^>]*)?/\s*>$').hasMatch(value)) {
    return true;
  }
  final opening =
      RegExp(r'^<([A-Za-z][\w.:-]*)(?:\s[^>]*)?>').firstMatch(value);
  if (opening == null) return false;
  final tag = RegExp.escape(opening.group(1)!);
  return RegExp('</$tag\\s*>\$', caseSensitive: false).hasMatch(value);
}

bool _hasMemoryCitation(String text) =>
    text.toLowerCase().contains('<oai-mem-citation>');

String _withoutMemoryCitation(String text) {
  final lower = text.toLowerCase();
  const opening = '<oai-mem-citation>';
  const closing = '</oai-mem-citation>';
  var output = text;
  var search = lower;
  while (true) {
    final start = search.indexOf(opening);
    if (start < 0) break;
    final end = search.indexOf(closing, start + opening.length);
    if (end < 0) {
      output = output.substring(0, start);
      break;
    }
    final after = end + closing.length;
    output = '${output.substring(0, start)}${output.substring(after)}';
    search = output.toLowerCase();
  }
  return output.trim();
}

List<String> _legacyAttachmentNames(String text) {
  const header = '# Files mentioned by the user:';
  const request = '## My request:';
  final headerIndex = text.indexOf(header);
  if (headerIndex < 0 || text.substring(0, headerIndex).trim().isNotEmpty) {
    return const <String>[];
  }
  final requestIndex = text.indexOf(request, headerIndex + header.length);
  if (requestIndex < 0) return const <String>[];
  final metadata = text.substring(headerIndex + header.length, requestIndex);
  return RegExp(r'^\s*##\s+([^:\r\n]+):\s+.+$', multiLine: true)
      .allMatches(metadata)
      .map((match) => _safeAttachmentName(match.group(1)!))
      .where((name) => name.isNotEmpty)
      .toList(growable: false);
}

String _withoutLegacyAttachmentEnvelope(String text) {
  const header = '# Files mentioned by the user:';
  const request = '## My request:';
  var display = text;
  final headerIndex = display.indexOf(header);
  if (headerIndex >= 0 && display.substring(0, headerIndex).trim().isEmpty) {
    final requestIndex = display.indexOf(request, headerIndex + header.length);
    if (requestIndex >= 0) {
      display = display.substring(requestIndex + request.length);
    }
  }
  return display
      .replaceAll(
          RegExp(r'^\s*</?image\b[^>]*>\s*$',
              caseSensitive: false, multiLine: true),
          '')
      .trim();
}

String _safeAttachmentName(String value) {
  final segments = value.trim().replaceAll('\\', '/').split('/');
  return segments.isEmpty ? '' : segments.last.trim();
}

bool _isImageFilename(String name) => RegExp(
      r'\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)$',
      caseSensitive: false,
    ).hasMatch(name);

class _MessageAttachmentView {
  const _MessageAttachmentView({
    required this.name,
    required this.isImage,
    this.imageUri,
    this.audioUri,
    this.audioMimeType,
  });

  factory _MessageAttachmentView.fromPart(ContentPart part,
      {String? fallbackName}) {
    final isImage = part.isImageAttachment;
    final isAudio = part.isAudioAttachment;
    return _MessageAttachmentView(
      name: _safeAttachmentName(part.attachmentName ??
          fallbackName ??
          (isImage ? 'Image' : 'Attachment')),
      isImage: isImage,
      imageUri: isImage ? _messageImageUri(part) : null,
      audioUri: isAudio ? _messageAudioUri(part) : null,
      audioMimeType: isAudio ? (part.attachmentMimeType ?? 'audio/mpeg') : null,
    );
  }

  factory _MessageAttachmentView.filenameOnly(String name) =>
      _MessageAttachmentView(
        name: _safeAttachmentName(name),
        isImage: _isImageFilename(name),
      );

  final String name;
  final bool isImage;
  final String? imageUri;
  final String? audioUri;
  final String? audioMimeType;
}

String? _messageImageUri(ContentPart part) {
  final uri = part.attachmentUri;
  if (uri == null) return null;
  if (uri.startsWith('data:image/')) {
    final comma = uri.indexOf(',');
    if (comma < 0 || !uri.substring(0, comma).endsWith(';base64')) return null;
    return uri;
  }
  final parsed = Uri.tryParse(uri);
  if (parsed?.scheme == 'https' || parsed?.scheme == 'http') return uri;
  return null;
}

String? _messageAudioUri(ContentPart part) {
  final uri = part.attachmentUri;
  if (uri == null || !uri.startsWith('data:audio/')) return null;
  final comma = uri.indexOf(',');
  if (comma < 0 || !uri.substring(0, comma).endsWith(';base64')) return null;
  return uri;
}

class _MessageImageGallery extends StatelessWidget {
  const _MessageImageGallery({
    required this.messageId,
    required this.attachments,
    required this.visual,
  });

  final String messageId;
  final List<_MessageAttachmentView> attachments;
  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) {
    final count = attachments.length;
    final (columns, tileWidth, tileHeight) = count == 1
        ? (1, 112.0, 84.0)
        : count == 2
            ? (2, 80.0, 60.0)
            : count == 3
                ? (3, 64.0, 48.0)
                : (4, 52.0, 48.0);
    const gap = 5.0;
    final galleryWidth = columns * tileWidth + (columns - 1) * gap;
    return SizedBox(
      key: ValueKey<String>('message-image-gallery-$messageId'),
      width: galleryWidth,
      child: Wrap(
        alignment: WrapAlignment.end,
        spacing: gap,
        runSpacing: gap,
        children: attachments.indexed.map((entry) {
          final attachment = entry.$2;
          final placeholder = SizedBox(
            width: tileWidth,
            height: tileHeight,
            child: ColoredBox(
              color: visual.surfaceRaised,
              child: Center(
                child: Icon(
                  Icons.broken_image_outlined,
                  size: 18,
                  color: Theme.of(context)
                      .colorScheme
                      .onSurface
                      .withValues(alpha: .56),
                ),
              ),
            ),
          );
          return ClipRRect(
            key: ValueKey<String>('message-image-$messageId-${entry.$1}'),
            borderRadius: BorderRadius.circular(5),
            child: attachment.imageUri == null
                ? Semantics(
                    label:
                        'Image ${entry.$1 + 1} of $count: ${attachment.name}. Image preview unavailable',
                    image: true,
                    child: placeholder,
                  )
                : _ExpandableMessageImage(
                    buttonKey: ValueKey<String>(
                        'expand-message-image-$messageId-${entry.$1}'),
                    imageUri: attachment.imageUri!,
                    name: attachment.name,
                    semanticLabel:
                        'Expand image ${entry.$1 + 1} of $count: ${attachment.name}',
                    fit: BoxFit.contain,
                    width: tileWidth,
                    height: tileHeight,
                    cacheWidth: (tileWidth * 2).round(),
                    fallback: placeholder,
                  ),
          );
        }).toList(growable: false),
      ),
    );
  }
}

class _ExpandableMessageImage extends StatelessWidget {
  const _ExpandableMessageImage({
    this.buttonKey = const Key('expand-message-image'),
    this.semanticLabel,
    required this.imageUri,
    required this.name,
    required this.width,
    required this.height,
    required this.fit,
    required this.cacheWidth,
    required this.fallback,
  });

  final Key buttonKey;
  final String? semanticLabel;
  final String imageUri;
  final String name;
  final double width;
  final double height;
  final BoxFit fit;
  final int cacheWidth;
  final Widget fallback;

  Widget _image({required BoxFit fit, double? width, double? height}) {
    final thumbnail = width == null && height == null;
    if (imageUri.startsWith('data:image/')) {
      return _MemoizedDataUriImage(
        dataUri: imageUri,
        width: width ?? this.width,
        height: height ?? this.height,
        fit: fit,
        cacheWidth: thumbnail ? cacheWidth : 1800,
        fallback: fallback,
      );
    }
    return Image.network(
      imageUri,
      width: width ?? this.width,
      height: height ?? this.height,
      fit: fit,
      cacheWidth: thumbnail ? cacheWidth : null,
      errorBuilder: (_, __, ___) => fallback,
    );
  }

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: semanticLabel ?? 'Expand image $name',
        child: InkWell(
          key: buttonKey,
          onTap: () => showDialog<void>(
            context: context,
            barrierColor: Colors.black.withValues(alpha: .92),
            builder: (dialogContext) => Dialog(
              key: const Key('expanded-message-image'),
              insetPadding: const EdgeInsets.all(10),
              backgroundColor: Colors.black,
              child: Stack(
                children: <Widget>[
                  Positioned.fill(
                    child: InteractiveViewer(
                      minScale: .8,
                      maxScale: 5,
                      child: Center(
                        child: _image(
                          fit: BoxFit.contain,
                          width: MediaQuery.sizeOf(dialogContext).width,
                          height: MediaQuery.sizeOf(dialogContext).height,
                        ),
                      ),
                    ),
                  ),
                  Positioned(
                    top: 8,
                    right: 8,
                    child: IconButton.filledTonal(
                      key: const Key('close-expanded-message-image'),
                      tooltip: 'Close image',
                      onPressed: () => Navigator.pop(dialogContext),
                      icon: const Icon(Icons.close_rounded),
                    ),
                  ),
                ],
              ),
            ),
          ),
          child: _image(fit: fit),
        ),
      );
}

class _MemoizedDataUriImage extends StatefulWidget {
  const _MemoizedDataUriImage({
    required this.dataUri,
    required this.width,
    required this.height,
    required this.fit,
    required this.cacheWidth,
    required this.fallback,
  });

  final String dataUri;
  final double width;
  final double height;
  final BoxFit fit;
  final int cacheWidth;
  final Widget fallback;

  @override
  State<_MemoizedDataUriImage> createState() => _MemoizedDataUriImageState();
}

class _MemoizedDataUriImageState extends State<_MemoizedDataUriImage> {
  Uint8List? _bytes;
  bool _decoding = true;
  bool _decodeFailed = false;
  int _decodeGeneration = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_decode());
  }

  @override
  void didUpdateWidget(covariant _MemoizedDataUriImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.dataUri != widget.dataUri) unawaited(_decode());
  }

  Future<void> _decode() async {
    final generation = ++_decodeGeneration;
    final dataUri = widget.dataUri;
    final comma = widget.dataUri.indexOf(',');
    if (comma < 0 || !widget.dataUri.substring(0, comma).endsWith(';base64')) {
      if (mounted) {
        setState(() {
          _bytes = null;
          _decoding = false;
          _decodeFailed = true;
        });
      }
      return;
    }
    if (_bytes != null || !_decoding || _decodeFailed) {
      setState(() {
        _bytes = null;
        _decoding = true;
        _decodeFailed = false;
      });
    }
    Uint8List? decoded;
    try {
      decoded = await compute(
        _decodeBase64DataUriPayload,
        dataUri,
      );
    } on Object {
      decoded = null;
    }
    if (!mounted ||
        generation != _decodeGeneration ||
        widget.dataUri != dataUri) {
      return;
    }
    setState(() {
      _bytes = decoded;
      _decoding = false;
      _decodeFailed = decoded == null || decoded.isEmpty;
    });
  }

  @override
  void dispose() {
    _decodeGeneration += 1;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bytes = _bytes;
    return SizedBox(
      width: widget.width,
      height: widget.height,
      child: _decoding
          ? Semantics(
              label: 'Loading image',
              child: Center(
                child: Icon(
                  Icons.image_outlined,
                  key: const Key('data-uri-image-loading'),
                  size: math.min(widget.width, widget.height).clamp(16, 24),
                  color: Theme.of(context)
                      .colorScheme
                      .onSurface
                      .withValues(alpha: .28),
                ),
              ),
            )
          : bytes == null || _decodeFailed
              ? Center(child: widget.fallback)
              : Image.memory(
                  bytes,
                  width: widget.width,
                  height: widget.height,
                  fit: widget.fit,
                  cacheWidth: widget.cacheWidth,
                  errorBuilder: (_, __, ___) => Center(child: widget.fallback),
                ),
    );
  }
}

String _titleCase(String value) {
  final normalized = value.replaceAll('_', ' ').trim();
  if (normalized.isEmpty) return value;
  return '${normalized[0].toUpperCase()}${normalized.substring(1)}';
}

String _visionSelectionDisplayName(
    RemoteAppStore store, VisionProxySelection selection) {
  final target = store.cachedVisionProxyTargets
      .where((candidate) => candidate.providerId == selection.providerId)
      .firstOrNull;
  final targetModel = target?.models
      .where((candidate) => candidate.id == selection.modelId)
      .firstOrNull;
  if (targetModel != null) return targetModel.displayName;
  final providerModel = store.modelsByProvider[selection.providerId]
      ?.where((candidate) => candidate.id == selection.modelId)
      .firstOrNull;
  if (providerModel != null) return providerModel.displayName;
  return target?.displayName ??
      providerVisualThemeFor(selection.providerId).displayName;
}

String _effortDisplayLabel(String effort, String? modelId,
    [String? providerId]) {
  return reasoningDisplayLabel(
    effort,
    providerId: providerId,
    modelId: modelId,
  );
}

String? _concreteReasoningEffort(String? value) {
  final trimmed = value?.trim();
  if (trimmed == null || trimmed.isEmpty) return null;
  final normalized = trimmed.toLowerCase().replaceAll('_', '-');
  if (const <String>{
    'auto',
    'automatic',
    'default',
    'model-default',
    'unknown',
    'unspecified',
    'inherit',
    'inherited',
  }.contains(normalized)) {
    return null;
  }
  return trimmed;
}

String? _defaultConcreteReasoningEffort(RemoteModel? model) {
  final advertised = _concreteReasoningEffort(model?.defaultReasoningEffort);
  if (advertised != null) return advertised;
  final supported = model?.reasoningEfforts ?? const <ReasoningEffortOption>[];
  return supported.length == 1 ? supported.single.id : null;
}

String? _queuedTaskReasoningEffort(
    Iterable<RemoteSession> sessions, RemoteModel model) {
  final supported = model.reasoningEfforts.map((option) => option.id).toSet();
  if (supported.isEmpty) return null;
  final matching = sessions
      .where((session) =>
          session.providerId == model.providerId &&
          session.modelId == model.id &&
          supported.contains(_concreteReasoningEffort(
              session.reasoningEffort ?? session.variantId)))
      .toList(growable: false)
    ..sort(
        (left, right) => right.lastActivityAt.compareTo(left.lastActivityAt));
  final recent = matching.firstOrNull;
  final recentEffort =
      _concreteReasoningEffort(recent?.reasoningEffort ?? recent?.variantId);
  return recentEffort ??
      _defaultConcreteReasoningEffort(model) ??
      model.reasoningEfforts.first.id;
}

String? _resolveReasoningEffort({
  required RemoteSession? session,
  required String? selectedEffort,
  required String? displayedModelId,
  required RemoteModel? model,
  required bool sessionWorking,
}) {
  final selected = _concreteReasoningEffort(selectedEffort);
  if (!sessionWorking && selected != null) return selected;

  final sessionMatchesDisplayedModel = displayedModelId == null ||
      session?.modelId == null ||
      session?.modelId == displayedModelId;
  if (sessionMatchesDisplayedModel) {
    final sessionEffort = _concreteReasoningEffort(session?.reasoningEffort) ??
        _concreteReasoningEffort(session?.variantId);
    if (sessionEffort != null) return sessionEffort;
  }

  final modelMatchesDisplayed = model != null &&
      (displayedModelId == null || model.id == displayedModelId);
  return modelMatchesDisplayed ? _defaultConcreteReasoningEffort(model) : null;
}

class _AgentStateIcon extends StatelessWidget {
  const _AgentStateIcon({required this.state});

  final String state;

  @override
  Widget build(BuildContext context) {
    if (state == 'working') {
      return const SizedBox.square(
        dimension: 18,
        child: CircularProgressIndicator(strokeWidth: 1.8),
      );
    }
    return Icon(
      switch (state) {
        'completed' => Icons.check_circle_outline_rounded,
        'failed' => Icons.error_outline_rounded,
        'needs_input' || 'needs_approval' => Icons.priority_high_rounded,
        _ => Icons.person_outline_rounded,
      },
      size: 19,
    );
  }
}

double? _contextFraction(SessionContextState context) {
  final reported = context.usedPercent;
  if (reported != null) return (reported / 100).clamp(0.0, 1.0).toDouble();
  final used = context.usedTokens;
  final window = context.contextWindowTokens;
  if (used == null || window == null || window <= 0) return null;
  return (used / window).clamp(0.0, 1.0).toDouble();
}

String _contextPercentLabel(SessionContextState context) {
  final fraction = _contextFraction(context);
  return fraction == null ? '—' : '${(fraction * 100).round()}%';
}

String _compactTokenCount(int? value) {
  if (value == null) return '—';
  if (value >= 1000000) {
    final digits = value % 1000000 == 0 || value >= 10000000 ? 0 : 1;
    return '${(value / 1000000).toStringAsFixed(digits)}m';
  }
  if (value >= 1000) {
    final digits = value % 1000 == 0 || value >= 100000 ? 0 : 1;
    return '${(value / 1000).toStringAsFixed(digits)}k';
  }
  return '$value';
}

String? _contextCost(SessionContextState context) {
  final cost = context.usage.cost;
  if (cost == null) return null;
  final currency = (context.usage.currency ?? 'USD').toUpperCase();
  final prefix = switch (currency) {
    'USD' => r'$',
    'GBP' => '£',
    'EUR' => '€',
    _ => '',
  };
  final value = cost.toStringAsFixed(cost < 1 ? 4 : 2);
  return prefix.isEmpty ? '$value $currency' : '$prefix$value';
}

int? _configuredContextLimit(SessionContextState context) {
  final threshold = context.compactionThresholdTokens;
  if (threshold != null && threshold > 0) return threshold;
  final capacity = context.contextWindowTokens;
  return capacity != null && capacity > 0 ? capacity : null;
}

String? _compactContextUsage(SessionContextState context) {
  final used = context.usedTokens;
  final limit = _configuredContextLimit(context);
  if (used == null || limit == null) return null;
  return '${_compactTokenCount(used)} / ${_compactTokenCount(limit)}';
}

class _ChildAgentsAppBarButton extends StatelessWidget {
  const _ChildAgentsAppBarButton({
    required this.count,
    required this.visual,
    required this.onPressed,
  });

  final int count;
  final ProviderVisualTheme visual;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final label = count == 1 ? '1 sub-agent' : '$count sub-agents';
    return Tooltip(
      message: 'View $label',
      child: TextButton(
        key: const Key('child-agents-button'),
        onPressed: onPressed,
        style: TextButton.styleFrom(
          foregroundColor: visual.accent,
          backgroundColor: visual.accent.withValues(alpha: .08),
          minimumSize: const Size(58, 44),
          maximumSize: const Size(66, 44),
          padding: const EdgeInsets.symmetric(horizontal: 6),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(
              Icons.groups_2_outlined,
              key: Key('child-agents-icon'),
              size: 19,
            ),
            const SizedBox(width: 4),
            Flexible(
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(
                  '$count',
                  key: const Key('child-agents-count'),
                  maxLines: 1,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SessionContextButton extends StatelessWidget {
  const _SessionContextButton(
      {required this.context, required this.visual, required this.onTap});

  final SessionContextState? context;
  final ProviderVisualTheme visual;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final usage = this.context;
    final fraction = usage == null ? null : _contextFraction(usage);
    final compactUsage = usage == null ? null : _compactContextUsage(usage);
    final label = compactUsage == null
        ? 'Context usage unavailable. Tap for details.'
        : 'Context window: $compactUsage. Tap for details.';
    return Semantics(
      button: true,
      label: label,
      child: Tooltip(
        message: label,
        child: InkWell(
          key: const Key('session-context-button'),
          onTap: onTap,
          borderRadius: BorderRadius.circular(8),
          child: SizedBox(
            width: 94,
            height: 44,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  if (compactUsage != null) ...<Widget>[
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(compactUsage,
                          maxLines: 1,
                          softWrap: false,
                          style: TextStyle(
                              color: visual.accent,
                              fontSize: 11.5,
                              fontWeight: FontWeight.w700)),
                    ),
                    const SizedBox(height: 5),
                  ],
                  ClipRRect(
                    borderRadius: BorderRadius.circular(99),
                    child: LinearProgressIndicator(
                      minHeight: 4,
                      value: fraction ?? 0,
                      color: visual.accent,
                      backgroundColor: visual.border.withValues(alpha: .55),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ContextStatRow extends StatelessWidget {
  const _ContextStatRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Text(label,
                  style: TextStyle(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: .58),
                      fontSize: 12)),
            ),
            Text(value,
                style:
                    const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
          ],
        ),
      );
}

class _WorkingSpinner extends StatefulWidget {
  const _WorkingSpinner({required this.size, required this.color});

  final double size;
  final Color color;

  @override
  State<_WorkingSpinner> createState() => _WorkingSpinnerState();
}

class _WorkingSpinnerState extends State<_WorkingSpinner>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  bool _animationsDisabled = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: _workingSpinnerPeriod,
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _animationsDisabled = MediaQuery.disableAnimationsOf(context);
    if (_animationsDisabled) {
      _controller
        ..stop()
        ..value = 0;
    } else if (!_controller.isAnimating) {
      unawaited(_controller.repeat());
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: ExcludeSemantics(
        child: SizedBox.square(
          dimension: widget.size,
          child: _animationsDisabled
              ? CustomPaint(
                  painter: _WorkingSpinnerPainter(
                      progress: 0.18, color: widget.color),
                )
              : AnimatedBuilder(
                  animation: _controller,
                  builder: (context, child) => CustomPaint(
                    painter: _WorkingSpinnerPainter(
                      progress: _controller.value,
                      color: widget.color,
                    ),
                  ),
                ),
        ),
      ),
    );
  }
}

class _WorkingSpinnerPainter extends CustomPainter {
  const _WorkingSpinnerPainter({required this.progress, required this.color});

  final double progress;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final strokeWidth = math.max(1.4, size.shortestSide * 0.12);
    final center = Offset(size.width / 2, size.height / 2);
    final radius = (size.shortestSide - strokeWidth) / 2;
    final rect = Rect.fromCircle(center: center, radius: radius);
    final start = progress * math.pi * 2 - math.pi / 2;
    const sweep = math.pi * 0.92;
    canvas.drawCircle(
      center,
      radius,
      Paint()
        ..color = color.withValues(alpha: 0.16)
        ..style = PaintingStyle.stroke
        ..strokeWidth = strokeWidth,
    );
    canvas.drawArc(
      rect,
      start,
      sweep,
      false,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeWidth = strokeWidth,
    );
  }

  @override
  bool shouldRepaint(covariant _WorkingSpinnerPainter oldDelegate) =>
      oldDelegate.progress != progress || oldDelegate.color != color;
}

class _ConversationStateIndicator extends StatelessWidget {
  const _ConversationStateIndicator(
      {required this.state, required this.visual});

  final String state;
  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) {
    final color = switch (state) {
      'needs_approval' || 'needs_input' => const Color(0xffffb061),
      'failed' => Theme.of(context).colorScheme.error,
      'disconnected' =>
        Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.58),
      _ => visual.accent,
    };
    final label = switch (state) {
      'needs_approval' => 'Approval needed',
      'needs_input' => 'Input needed',
      'failed' => 'Failed',
      'disconnected' => 'Offline',
      _ => 'Working',
    };
    final indicator = state == 'working'
        ? _WorkingSpinner(size: 15, color: color)
        : Icon(
            state == 'failed'
                ? Icons.error_outline_rounded
                : state == 'disconnected'
                    ? Icons.cloud_off_outlined
                    : Icons.priority_high_rounded,
            size: 17,
            color: color,
          );
    return Semantics(
      key: const Key('conversation-state-indicator'),
      label: label,
      child: Tooltip(
        message: label,
        child: SizedBox.square(
          dimension: 44,
          child: Center(child: indicator),
        ),
      ),
    );
  }
}

class _InlineStateIndicator extends StatelessWidget {
  const _InlineStateIndicator(
      {required this.state, required this.visual, super.key});

  final String state;
  final ProviderVisualTheme visual;

  @override
  Widget build(BuildContext context) {
    final needsAttention = state == 'needs_approval' ||
        state == 'needs_input' ||
        state == 'failed';
    final color = state == 'online'
        ? const Color(0xff6edc91)
        : needsAttention
            ? state == 'failed'
                ? Theme.of(context).colorScheme.error
                : const Color(0xffffb061)
            : state == 'completed'
                ? const Color(0xff6edc91)
                : state == 'working'
                    ? visual.accent
                    : Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: .5);
    final label = switch (state) {
      'needs_approval' => 'Approval',
      'needs_input' => 'Input',
      'disconnected' => 'Offline',
      'online' => 'Online',
      _ => _titleCase(state),
    };
    final indicator = state == 'working'
        ? _WorkingSpinner(size: 13, color: color)
        : state == 'idle' || state == 'unknown' || state == 'online'
            ? Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              )
            : Icon(
                needsAttention
                    ? Icons.priority_high_rounded
                    : state == 'completed'
                        ? Icons.check_rounded
                        : Icons.cloud_off_outlined,
                size: 15,
                color: color,
              );
    return Semantics(
      label: label,
      child: Tooltip(
        message: label,
        child: SizedBox.square(
          dimension: 24,
          child: Center(child: indicator),
        ),
      ),
    );
  }
}

String _relativeTime(DateTime value) {
  final difference = DateTime.now().difference(value);
  if (difference.inSeconds < 60) return 'just now';
  if (difference.inMinutes < 60) return '${difference.inMinutes}m ago';
  if (difference.inHours < 24) return '${difference.inHours}h ago';
  return '${difference.inDays}d ago';
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
