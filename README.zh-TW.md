# Multi-AI Terminal

[English](./README.md) | **繁體中文**

在本機組合、執行**跨多個 headless CLI coding agent 的多代理工作流**的工作台 — 支援 Claude Code、Codex CLI、Grok CLI、Antigravity(Gemini)。把 agent 拖進工作流階段,讓真正的 LLM 調度者(Orchestrator)在每個階段把關,所有 agent 的輸出彙整成單一、分類、可回放的訊息流。

[multi-ai-chat-desktop](https://github.com/teddashh/multi-ai-chat-desktop) 的後繼者:不再爬網頁聊天室,每個 agent 都是真實的 headless CLI 子進程,其 JSONL 串流被正規化成統一的事件格式。

## 運作方式

- **工作區(Workspaces)** — 每個指向一個目錄(可感知 git)。左側欄顯示每個工作區最近執行的工作流與即時狀態。
- **工作流(Workflows)** — 由有序階段組成;每個階段放置 agent 槽位(從調色盤拖入;同供應商可放多個實例,每階段 Σ ≤ 12)。每個槽位可設定:模型、推理力度、權限層級、提示模板、數量。
- **調度者(Orchestrator)** — 一個真實的 CLI agent(任一供應商),接收每個把關階段候選結果的摘要,回覆嚴格 JSON 的閘門決策:前進 / 重試(可指定節點並附加提示)/ 中止。確定性的預算上限;解析失敗時安全降級為前進。
- **階段隔離** — 每個節點可選 git worktree 隔離;每次嘗試的改動會擷取成二進位 patch,可在 UI 中檢視並套用。
- **訊息流面板** — 所有 agent 的所有事件,分為**你的訊息 / agent 回覆 / 工具操作 / 思考過程**四類,虛擬化捲動、可按節點/角色/搜尋過濾,並可從持久事件日誌完整回放過去的執行。

## 驗證（證據層）

工作區可設定驗證指令（例如 `npm test`）與選用的逾時秒數（預設 600 秒）。使用 worktree 隔離且產生非空 patch 的候選項，會在擷取成品後執行該指令；正規化的通過、失敗、錯誤或略過結果，以及完整日誌，都會隨執行紀錄持久保存。把關階段可啟用 `requireVerified`；當沒有候選項通過、但有檢查失敗時，會在既有重試預算內重試失敗節點。

UI 與產生的 Markdown 報告會區分「已產生、已審查、已前進、已驗證」。降級或未驗證的前進會明確標示，絕不隱藏。可在執行面板開啟 **Report**，或呼叫 `GET /api/runs/:id/report`，取得適合 PR 與回顧使用的結果、交接、決策、供應商 CLI 版本、用量、patch 與驗證證據。內建的 **Pipeline: Implement → Test → Review** 預設是最短的證據把關生產線。

## 快速開始

需求:Node.js ≥ 20、建議 Git ≥ 2.32(較舊的 Git 會退回純 `git apply --check`),以及你想用的 agent CLI:`claude`、`codex`、`grok`、`agy`。

```sh
npm install
npm run build
npm start                      # 在 http://127.0.0.1:7788 提供網頁 UI + API
# 選項:--port N --host H --data-dir DIR --token SECRET
```

打開 UI,新增工作區(絕對路徑),挑一個內建工作流(Planning / Build / Review / Pipeline),把 agent 拖到階段上,寫下任務,按 Start。

開發模式:`npm run dev`(vite + API 熱重載)。測試:`npm test`。型別檢查:`npm run typecheck`。

## 桌面版

從本倉庫的 GitHub Releases 頁面下載安裝。桌面版需要 `PATH` 上有 Node.js ≥ 20;必要時可設 `MAT_NODE` 指向特定的 Node.js 執行檔。

- **Windows**:下載 `-setup.exe`(NSIS)或 `.msi` 執行安裝。WebView2 執行環境在 Windows 10/11 已內建,缺少時安裝程式會自動補裝。用 `winget install OpenJS.NodeJS.LTS` 安裝 Node.js ≥ 20;worktree 隔離功能需要 Git for Windows。必要時設 `MAT_NODE` 指向特定的 `node.exe`。
- **Debian/Ubuntu**:下載 `.deb`,執行 `sudo apt install ./檔名.deb`。
- **其他 Linux 發行版**:下載 `.AppImage`,`chmod +x ./Multi-AI-Terminal*.AppImage` 後直接執行。也提供 RPM 套件。
- **macOS**:打開下載的 `.dmg`,把 app 拖進「應用程式」。v1 版未簽章、未公證,首次啟動請對 Multi-AI Terminal 按右鍵選**打開**以通過 Gatekeeper。

桌面外殼跑的是與網頁版完全相同的打包 server,監聽隨機的 `127.0.0.1` 埠,資料同樣存在 `~/.multi-ai-terminal/`。本機建置桌面資源:先 `npm run build` 再 `npm run desktop:bundle`;`npm run desktop:build` 另需 Rust 與 Tauri 原生建置環境。

## 供應商(已驗證的呼叫方式)

| 供應商 | CLI | 串流 | 備註 |
|---|---|---|---|
| claude | `claude -p --output-format stream-json --verbose` | 完整(文字/思考/工具/費用) | 以 `--resume` 續談 |
| codex | `codex exec --json -m gpt-5.6-sol` | 完整(含指令執行事件) | 力度用 `-c model_reasoning_effort` |
| grok | `grok --prompt-file F --output-format streaming-json` | 僅思考/文字(工具靜默執行) | grok ≥ 0.2.93:`--prompt-file` 不可再加 `-p` |
| agy | `agy -p "PROMPT" --model "Gemini 3.1 Pro (High)"` | 純文字 | 模型用顯示名稱;無 JSON 模式 |
| mock | 行程內 | 腳本化 | 確定性;測試用 `MOCK_REPLY:` 回聲模式 |

每個槽位的權限層級:`safe`(唯讀)、`auto`(自動接受編輯)、`full`(繞過沙箱)— 對應各 CLI 的原生旗標(SPEC §4.5)。

## 信任模型

預設綁定 `127.0.0.1`。`--host 0.0.0.0` 會把 API/UI 暴露到你的網路 — 請設定 `--token`(REST bearer + WS query token)。能連上這個埠的人就能在你的工作區執行任意 CLI agent;請據此看待這個埠(建議只透過 Tailscale 暴露)。

## 資料

`~/.multi-ai-terminal/`(可用 `--data-dir` / `MAT_DATA_DIR` 覆蓋):`workspaces.json`、`workflows/*.json`、`runs/<runId>/run.json` + `events.jsonl` + `raw/*.jsonl`(每次嘗試未經處理的 CLI 輸出)+ `artifacts/*.patch` + `artifacts/*.verify.log`。保留策略:每個工作區最近 100 次執行,刪除時一併清理 worktree 與分支。

## 文件

- [SPEC.md](./SPEC.md) — 工程契約(v1.1)
- [docs/spec-review-panel.md](./docs/spec-review-panel.md) — 4 模型規格審查記錄
- [docs/code-review-panel.md](./docs/code-review-panel.md) — 4 模型程式碼審查記錄(25 項發現已修復、3 項駁回)

由 4 模型評審流程打造:規格與程式碼審查由 Claude Fable 5、Codex GPT-5.6-sol、Gemini 3.1 Pro、Grok 4.5 共同執行;實作由平行的 Codex worker 在隔離的 git worktree 中完成。

## 已知限制(v1)

- Grok 的串流 JSON 不含工具事件 — grok 節點只顯示思考/文字;摘要中工具數顯示「n/a」。
- Antigravity(`agy`)無 headless JSON 模式 — 純文字串流、無法續談(調度者每次把關都重新簡報)。
- 機器重開後,崩潰復原依持久化的 PID 終止殘留 process group;接受 PID 重用的風險。
- 事件環在瀏覽器記憶體保留 2 萬筆;更舊的歷史從伺服器分頁載入,並明確標示截斷。
- Windows 上的進程終止使用 `taskkill /T /F`(強制樹狀終止);若 node 先行退出,已脫離的孫進程由下次啟動時的清掃回收。
