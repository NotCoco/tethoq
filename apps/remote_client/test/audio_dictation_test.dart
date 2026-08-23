import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/audio_message.dart';

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
  test('audio bytes decode from data URIs and reject non-base64 values',
      () {
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
}
