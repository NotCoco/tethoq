import 'dart:async';
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

class MicrophoneDictationRecorder implements DictationRecorder {
  static const int _sampleRate = 16000;

  final AudioRecorder _recorder = AudioRecorder();
  final StreamController<double> _levels =
      StreamController<double>.broadcast();
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
    await _recorder.stop();
    await _streamDone?.future.timeout(const Duration(seconds: 2));
    await _subscription?.cancel();
    _subscription = null;
    final pcm = _audio?.takeBytes() ?? Uint8List(0);
    _audio = null;
    if (pcm.length < 8000) throw StateError('Dictation was too short');
    return _waveFile(pcm, sampleRate: _sampleRate, channels: 1);
  }

  void _emitLevel(Uint8List chunk) {
    final now = DateTime.now();
    final last = _lastEmit;
    if (last != null && now.difference(last) < const Duration(milliseconds: 60)) {
      return;
    }
    _lastEmit = now;
    var sum = 0.0;
    final count = chunk.length ~/ 2;
    if (count == 0) return;
    final view = ByteData.sublistView(chunk);
    for (var index = 0; index < count; index += 1) {
      final sample = view.getInt16(index * 2, Endian.little) / 32768.0;
      sum += sample * sample;
    }
    final rms = (sum / count).clamp(0.0, 1.0);
    final level = (rms.isFinite ? rms : 0.0).clamp(0.0, 1.0);
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
  return Uint8List.fromList(<int>[...header.buffer.asUint8List(), ...pcm]);
}
