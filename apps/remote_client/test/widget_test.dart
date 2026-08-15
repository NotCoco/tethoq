import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/screens.dart';
import 'package:universal_agent_remote/src/store.dart';

void main() {
  testWidgets('pairing screen explains the Tethoq code without dumping setup',
      (tester) async {
    final store = RemoteAppStore();
    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: PairingScreen()),
    ));
    expect(find.text('Connect to your computer'), findsOneWidget);
    expect(find.text('Scan QR code'), findsOneWidget);
    expect(find.text('Where do I find the code?'), findsOneWidget);
    expect(find.text('npm run phone:pair'), findsNothing);
    expect(find.byType(TextField), findsNothing);

    final viewport = tester.getRect(find.byType(Scaffold));
    final content = tester.getRect(find.text('Connect to your computer'));
    expect(content.center.dy, greaterThan(viewport.height * .3));
    expect(content.center.dy, lessThan(viewport.height * .55));

    final scanButton = tester.getRect(find.byType(FilledButton));
    expect(scanButton.width, lessThan(viewport.width * .8));
    expect(scanButton.height, greaterThanOrEqualTo(48));

    final explanation = tester.widget<Text>(find
        .text('Scan the connection code created by Tethoq on your computer.'));
    expect(explanation.style?.color?.a, lessThan(1));

    final helpButton = tester.widget<TextButton>(find.byType(TextButton));
    expect(
      helpButton.style?.foregroundColor?.resolve(<WidgetState>{})?.a,
      lessThan(explanation.style!.color!.a),
    );

    await tester.tap(find.text('Where do I find the code?'));
    await tester.pumpAndSettle();

    expect(
        find.text('Show a connection code on your computer'), findsOneWidget);
    expect(find.text('npm run phone:pair'), findsOneWidget);
    expect(
      find.textContaining('uses the coding tools already available'),
      findsOneWidget,
    );
  });
}
