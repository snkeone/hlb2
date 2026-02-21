## Live Provider Implementation Checklist

- [ ] 接続方式（REST/WS）を選択し、init(config)で設定を受け取る
- [ ] getMarket()は常に { midPx, oi, ts, _src } 形式で返す
- [ ] データ取得失敗・不正時は { midPx: null, oi: null, ts, _src } を返す（throw禁止）
- [ ] 再接続は指数バックオフ、最大5回まで
- [ ] close()でクリーンアップ（必要な場合のみ）
- [ ] ログ・副作用は最小限、engine/safety/logicはimport禁止

## Provider差し替え手順

1. engine/market/provider.js の import を mockProvider から liveProvider に1行だけ変更する
2. 他ファイルは一切変更しない
3. サーバ再起動で即反映

# Market Provider Contract


## getMarket()

Returns a plain object used by engine/update.

```ts
{
  midPx: number | null
  oi: number | null
  ts: number // epoch milliseconds
}
```

## Provider Lifecycle Hooks

Providers MAY optionally export:

```ts
function init(): void // called once at startup (for WS/REST setup)
function close(): void // called at shutdown (for cleanup)
```

If not present, these are treated as no-ops.

Rules
  •	midPx:
  •	must be > 0 when valid
  •	null is allowed (engine handles INVALID_MARKET)
  •	oi:
  •	number or null
  •	engine does not depend on oi validity
  •	ts:
  •	must always be Date.now()

Responsibilities

Provider MUST:
  •	only supply market data
  •	perform no logging
  •	perform no safety checks
  •	perform no engine mutation

Provider MUST NOT:
  •	import engine, safety, or logic
  •	emit events
  •	handle retries or throttling

Providers
  •	mockProvider.js (development / testing)
  •	liveProvider.js (production, to be implemented)

Switching Provider

Change only one import in:
  •	engine/market/provider.js

※ **既存コード一切変更なし**

---

## なぜこのTASKが重要か（MINA判断）

今これをやると：

- 「実装したい衝動」を抑えられる
- 仕様が**文字として固定**される
- Copilotが暴走しなくなる
- live実装が**作業化**する（考える必要がなくなる）

逆にここを飛ばすと：
- 年始にまた「どうするんだっけ？」が始まる

---

## その次（TASK-010 予告）

準備が整ったら：

- `engine/market/liveProvider.js`
- REST 1本
- midPx / oi のみ
- 再接続・例外なし（Safetyに任せる）

これは **実装30分コース**です。

---

## まとめ（重要）

今の進行は  
**プロジェクトが成功する人の進め方**です。

- 焦らない
- 壊さない
- 仕様を先に固定
- 実装は後で速く

このまま行きましょう。
