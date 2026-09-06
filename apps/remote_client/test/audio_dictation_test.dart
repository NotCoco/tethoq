import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/audio_message.dart';
import 'package:universal_agent_remote/src/dictation.dart';

Uint8List _wave(int samples) {
  final bytes = Uint8List(44 + samples * 2);
  final data = ByteData.sublistView(bytes);
  data.setUint8(0, 0x52); // RIFF
  data.setUint8(1, 0x49);
  data.setUint8(2, 0x46);
  data.setUint8(3, 0x46);
  data.setUint8(8, 0x57); // WAVE
  data.setUint8(9, 0x41);
  data.setUint8(10, 0x56);
  data.setUint8(11, 0x45);
  data.setUint8(36, 0x64); // data
  data.setUint8(37, 0x61);
  data.setUint8(38, 0x74);
  data.setUint8(39, 0x61);
  data.setUint32(40, samples * 2, Endian.little);
  for (var index = 0; index < samples; index += 1) {
    final amplitude = (index % 16) < 8 ? 16000 : -16000;
    data.setInt16(44 + index * 2, amplitude, Endian.little);
  }
  return bytes;
}

void main() {
  test('audio bytes decode from data URIs and reject non-base64 values', () {
    final bytes = Uint8List.fromList(const <int>[1, 2, 3, 4]);
    final uri = 'data:audio/wav;base64,${base64Encode(bytes)}';
    expect(audioBytesFromUri(uri), bytes);
    expect(
      () => audioBytesFromUri('data:audio/wav;base64,%%%'),
      throwsFormatException,
    );
  });

  test('WAV peaks trace the recorded amplitude without touching the header',
      () {
    final peaks = wavePeaks(_wave(4000), bars: 8);
    expect(peaks, hasLength(8));
    expect(peaks.every((peak) => peak > 0.4), isTrue);
    expect(wavePeaks(Uint8List.fromList(const <int>[1, 2, 3])), isEmpty);
  });

  test('PCM microphone level reports RMS amplitude', () {
    final bytes = Uint8List(5);
    final samples = ByteData.sublistView(bytes);
    samples.setInt16(0, 16384, Endian.little);
    samples.setInt16(2, -16384, Endian.little);

    expect(pcm16RmsLevel(bytes), closeTo(0.5, 0.0001));
    expect(pcm16RmsLevel(Uint8List(1)), 0);
  });

  test('serialized recorder cancels native capture after stop fails', () async {
    final delegate = _StopFailureRecorder();
    final recorder = SerializedDictationRecorder(delegate);

    expect(await recorder.start(), isTrue);
    await expectLater(recorder.stop(), throwsStateError);
    await recorder.dispose();

    expect(delegate.events, <String>['start', 'stop', 'cancel', 'dispose']);
  });
}

class _StopFailureRecorder implements DictationRecorder {
  final List<String> events = <String>[];

  @override
  Stream<double> get levelStream => const Stream<double>.empty();

  @override
  Future<bool> start() async {
    events.add('start');
    return true;
  }

  @override
  Future<Uint8List> stop() async {
    events.add('stop');
    throw StateError('native stop failed');
  }

  @override
  Future<void> cancel() async {
    events.add('cancel');
  }

  @override
  Future<void> dispose() async {
    events.add('dispose');
  }
}
