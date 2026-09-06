import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:record/record.dart';

abstract class DictationRecorder {
  Future<bool> start();
  Future<Uint8List> stop();
  Future<void> cancel();
  Future<void> dispose();

  /// Live input level (0..1) while recording. Never emits outside recording.
  Stream<double> get levelStream;
}

/// Serializes recorder lifecycle calls and makes disposal the final operation.
///
/// Permission prompts can keep [start] pending while the app backgrounds or a
/// route is disposed. Queuing every delegate call prevents a late start from
/// racing stop/cancel or touching a recorder that has already been disposed.
class SerializedDictationRecorder implements DictationRecorder {
  SerializedDictationRecorder(this._delegate);

  final DictationRecorder _delegate;
  Future<void> _tail = Future<void>.value();
  Future<void>? _disposeOperation;
  bool _disposeRequested = false;
  bool _captureActive = false;

  @override
  Stream<double> get levelStream => _delegate.levelStream;

  Future<T> _enqueue<T>(Future<T> Function() operation) {
    final completer = Completer<T>();
    _tail = _tail.catchError((Object _) {}).then((_) async {
      try {
        completer.complete(await operation());
      } on Object catch (error, stackTrace) {
        completer.completeError(error, stackTrace);
      }
    });
    return completer.future;
  }

  @override
  Future<bool> start() {
    if (_disposeRequested) {
      return Future<bool>.error(
          StateError('The dictation recorder has been disposed'));
    }
    return _enqueue(() async {
      final started = await _delegate.start();
      _captureActive = started;
      return started;
    });
  }

  @override
  Future<Uint8List> stop() {
    if (_disposeRequested) {
      return Future<Uint8List>.error(
          StateError('The dictation recorder has been disposed'));
    }
    return _enqueue(() async {
      try {
        final audio = await _delegate.stop();
        _captureActive = false;
        return audio;
      } on Object catch (error, stackTrace) {
        try {
          await _delegate.cancel();
          _captureActive = false;
        } on Object {
          // Keep capture marked active so dispose retries native cleanup.
        }
        Error.throwWithStackTrace(error, stackTrace);
      }
    });
  }

  @override
  Future<void> cancel() {
    final disposing = _disposeOperation;
    if (_disposeRequested) return disposing ?? Future<void>.value();
    return _enqueue(() async {
      try {
        await _delegate.cancel();
      } finally {
        _captureActive = false;
      }
    });
  }

  @override
  Future<void> dispose() {
    final active = _disposeOperation;
    if (active != null) return active;
    _disposeRequested = true;
    late final Future<void> operation;
    operation = _enqueue(() async {
      if (_captureActive) {
        try {
          await _delegate.cancel();
        } on Object {
          // Disposal must still release the native recorder when cancellation
          // reports an already-stopped or partially-started capture.
        } finally {
          _captureActive = false;
        }
      }
      await _delegate.dispose();
    });
    _disposeOperation = operation;
    return operation;
  }
}

class MicrophoneDictationRecorder implements DictationRecorder {
  static const int _sampleRate = 16000;

  final AudioRecorder _recorder = AudioRecorder();
  final StreamController<double> _levels = StreamController<double>.broadcast();
  BytesBuilder? _audio;
  StreamSubscription<Uint8List>? _subscription;
  Completer<void>? _streamDone;
  DateTime? _lastEmit;

  @override
  Stream<double> get levelStream => _levels.stream;

  @override
  Future<bool> start() async {
    if (!await _recorder.hasPermission()) return false;
    if (!await _recorder.isEncoderSupported(AudioEncoder.pcm16bits)) {
      throw StateError('This device cannot record compatible dictation audio');
    }
    _audio = BytesBuilder(copy: false);
    _streamDone = Completer<void>();
    final stream = await _recorder.startStream(const RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: _sampleRate,
      numChannels: 1,
      autoGain: true,
      echoCancel: true,
      noiseSuppress: true,
    ));
    _subscription = stream.listen(
      (chunk) {
        _audio!.add(chunk);
        _emitLevel(chunk);
      },
      onError: (Object error, StackTrace stackTrace) {
        if (!(_streamDone?.isCompleted ?? true)) {
          _streamDone!.completeError(error, stackTrace);
        }
      },
      onDone: () {
        if (!(_streamDone?.isCompleted ?? true)) _streamDone!.complete();
      },
    );
    return true;
  }

  @override
  Future<Uint8List> stop() async {
    Object? stopError;
    StackTrace? stopStackTrace;
    try {
      await _recorder.stop();
    } on Object catch (error, stackTrace) {
      stopError = error;
      stopStackTrace = stackTrace;
      try {
        await _recorder.cancel();
      } on Object {
        // Preserve the original stop failure. The serialized wrapper retries
        // cancellation if this method ultimately cannot return usable audio.
      }
    }
    try {
      await _streamDone?.future.timeout(const Duration(seconds: 2));
    } on TimeoutException {
      // Some Android recorders finish delivering PCM without closing the
      // stream promptly. The buffered recording is still usable and must not
      // be discarded just because the completion signal was late.
    } on Object catch (error, stackTrace) {
      stopError ??= error;
      stopStackTrace ??= stackTrace;
    } finally {
      await _subscription?.cancel();
      _subscription = null;
    }
    final pcm = _audio?.takeBytes() ?? Uint8List(0);
    _audio = null;
    if (pcm.length < 8000) {
      if (stopError != null) {
        Error.throwWithStackTrace(
            stopError, stopStackTrace ?? StackTrace.current);
      }
      throw StateError('Dictation was too short');
    }
    return _waveFile(pcm, sampleRate: _sampleRate, channels: 1);
  }

  void _emitLevel(Uint8List chunk) {
    final now = DateTime.now();
    final last = _lastEmit;
    if (last != null &&
        now.difference(last) < const Duration(milliseconds: 60)) {
      return;
    }
    _lastEmit = now;
    final level = pcm16RmsLevel(chunk);
    if (!_levels.isClosed) _levels.add(level);
  }

  @override
  Future<void> cancel() async {
    await _recorder.cancel();
    await _subscription?.cancel();
    _subscription = null;
    _audio = null;
  }

  @override
  Future<void> dispose() async {
    await _subscription?.cancel();
    await _levels.close();
    await _recorder.dispose();
  }
}

double pcm16RmsLevel(Uint8List chunk) {
  var sum = 0.0;
  final count = chunk.length ~/ 2;
  if (count == 0) return 0;
  final view = ByteData.sublistView(chunk);
  for (var index = 0; index < count; index += 1) {
    final sample = view.getInt16(index * 2, Endian.little) / 32768.0;
    sum += sample * sample;
  }
  final rms = math.sqrt(sum / count);
  return (rms.isFinite ? rms : 0.0).clamp(0.0, 1.0);
}

Uint8List _waveFile(Uint8List pcm,
    {required int sampleRate, required int channels}) {
  final header = ByteData(44);
  void ascii(int offset, String value) {
    for (var index = 0; index < value.length; index += 1) {
      header.setUint8(offset + index, value.codeUnitAt(index));
    }
  }

  const bitsPerSample = 16;
  final blockAlign = channels * bitsPerSample ~/ 8;
  ascii(0, 'RIFF');
  header.setUint32(4, 36 + pcm.length, Endian.little);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  header.setUint32(16, 16, Endian.little);
  header.setUint16(20, 1, Endian.little);
  header.setUint16(22, channels, Endian.little);
  header.setUint32(24, sampleRate, Endian.little);
  header.setUint32(28, sampleRate * blockAlign, Endian.little);
  header.setUint16(32, blockAlign, Endian.little);
  header.setUint16(34, bitsPerSample, Endian.little);
  ascii(36, 'data');
  header.setUint32(40, pcm.length, Endian.little);
  final wave = Uint8List(44 + pcm.length);
  wave.setRange(0, 44, header.buffer.asUint8List());
  wave.setRange(44, wave.length, pcm);
  return wave;
}
