// index.js
// BOT Entry Point
// DebugUI は DEBUG_UI=1 のときのみ起動し、既存 Terminal UI は無効化


import WebSocket from 'ws';

console.log('[BOOT] hlws-bot starting');

const hlEnabled = (process.env.HL_ENABLE ?? '1').toLowerCase() !== '0' && (process.env.HL_ENABLE ?? '1').toLowerCase() !== 'false';

let client = null;
if (hlEnabled) {
	const { HLWSClient } = await import('./ws/index.js');
	const c = await HLWSClient({
		WebSocket,
	});
	c.start();
	client = c;
} else {
	console.log('[HL] disabled (offline mode) - set HL_ENABLE=1 to connect');
}

if (process.env.DEBUG_UI === '1') {
	import('./debug/uiConsole.js').catch(() => {
		// DebugUI 起動失敗時でも本流への影響を防ぐ
	});
}
