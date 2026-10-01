# Multi-AI Terminal

[English](README.md) · **繁體中文**

在本機執行多階段、多 agent 的 coding 工作流程：Claude Code、Codex、Grok、Antigravity 與 OpenRouter 都以 headless runtime 執行，每個階段由協調者 agent 把關。

**專案介紹頁：** https://teddashh.github.io/multi-ai-terminal/?lang=zh-TW

把 agent 拖進工作流程的各個階段，讓真正的 LLM 協調者替每個階段把關，所有 agent 的輸出會匯成一條分類清楚、可以回放的訊息流。OpenRouter 的模型借用 Codex 當 runtime 執行。

前一代是 [multi-ai-chat-desktop](https://teddashh.github.io/multi-ai-chat-desktop/?lang=zh-TW)：MAT 不再操作網頁聊天室，而是透過真正的 headless CLI、app-server 或 SDK runtime 驅動每個 agent，再把各家的串流整理成同一套可以長期保存的證據格式。

最新版本是 [**v0.2.10**](https://github.com/teddashh/multi-ai-terminal/releases/tag/v0.2.10)（2026 年 7 月 23 日），加入以 Codex 當 runtime 的 OpenRouter、Grok 與 Agy 共用的 headless manager，以及一套不分 provider 的事件契約。

## 運作方式

- **專案與啟動**：每個工作區指向一個目錄（會辨識 git）。左側的圖示加文字側欄可以在選專案與啟動設定之間切換，草稿不會遺失。常用的模式、就緒狀態與任務設定一直看得到，進階的階段編輯則放在「進階設定」（Customize）。
- **工作流程**：由依序排列的階段組成，每個階段放 agent 槽位。從進階面板把 agent 拖進來；同一家 provider 可以放好幾個，每個階段最多 12 個 agent。每個槽位可以設定模型、推理強度、權限層級、提示範本與數量。
- **協調者**：一個真正的 CLI agent（哪家 provider 都可以），讀取每個關卡階段候選結果的摘要，用嚴格的 JSON 回覆關卡決策：繼續、重試（可以指定節點並附加提示）或中止。預算上限是固定的；回覆無法解析時，階段會繼續往下，並標示為降級。
- **階段隔離**：每個節點可以選擇用 git worktree 隔離。每次嘗試的修改都會存成二進位 patch，可以在介面上檢視並套用。
- **執行工作區**：「對話」（Conversation）放在最前面，每個節點的回答、決策、驗證與失敗一眼就能看清楚。「時間軸」（Timeline）保留原始事件分類、虛擬捲動、節點／角色／搜尋篩選，以及從持久事件紀錄完整回放。
- **健康狀態與除錯**：整理伺服器、provider、工作區、執行、驗證與證據連續性的檢查結果，並提供安全的「設定」、重新偵測、查看、遮蔽後的日誌與除錯套件。偵測到 CLI，絕不等於已經登入。
- **語言與主題**：跟隨系統語言，或在英文與繁體中文之間切換；主題有午夜深色、日光淺色與 AI-Sister 紀念版三種，選擇會被記住。

## 驗證（證據層）

工作區可以設定驗證指令（例如 `npm test`）和逾時秒數（預設 600 秒）。使用 worktree 隔離、而且 patch 不是空的候選結果，會在擷取成品後執行這個指令；正規化後的通過、失敗、錯誤或略過結果，連同完整日誌，都會跟著這次執行保存下來。有關卡的階段可以開啟 `requireVerified`：如果沒有任何候選結果通過，就在既有的重試額度內重試沒過的部分。

介面和產生的 Markdown 報告會分開標示已產生、已審查、已放行與已驗證的工作。降級放行或未經驗證的結果，都會清楚標示，絕不藏起來。在執行面板按「報告」（Report），或呼叫 `GET /api/runs/:id/report`，就能拿到可以直接用在 PR 或回顧的紀錄：結果、交接、決策、provider CLI 版本、用量、patch 與驗證證據。內建的「流程：實作 → 測試 → 審查」（Pipeline: Implement → Test → Review）是最短的證據把關生產線。

## 追加指示（Steering）

執行進行中時，可以在執行面板輸入新的指示。預設的「立即插入」（interrupt）會結束目前候選結果的整個程序樹，保留已產生的日誌與 patch，讓新指示走一樣的證據流程，再用關卡式的審查決定要重做被中斷的階段、繼續還是中止。「排隊」（queue）會等到下一個階段交界才套用，不中斷目前的工作。追加指示先進先出，每次執行最多 8 則；停用協調者時，處理方式仍是固定的。這個功能不用 PTY，也不會寫進執行中子程序的 stdin。

## 除錯套件

在「報告」旁按「除錯」（Debug），或從唯讀的「健康狀態」（Health）面板，下載一個 `mat-debug-<runId>.zip`。內容包括完整的執行快照、事件、診斷紀錄、Markdown 報告、adapter 原始輸出、patch、驗證日誌、runtime 與 provider 版本，以及伺服器診斷日誌的最後一段。瀏覽器端的錯誤也會盡量回報到伺服器紀錄；系統不會刻意記錄環境變數的值。

## 快速開始

需求：Node.js 20 以上，建議 Git 2.32 以上（較舊的 Git 會退回單純的 `git apply --check`）。另外要裝好你會用到的 provider runtime：Claude 與 Codex 可以使用 MAT 代管、鎖定版本的 runtime；Grok 用 `grok`；Antigravity 用 `agy`。OpenRouter 沒有自己的 CLI，需要 Codex runtime，並在 MAT 的環境裡設定 `OPENROUTER_API_KEY`。在編輯器裡先選 OpenRouter 模型、再選版本；MAT 會保存並送出該版本精確的 OpenRouter request slug。

```sh
npm install
npm run build
npm start                      # 網頁介面與 API 開在 http://127.0.0.1:7788
# 參數：--port N --host H --data-dir DIR --token SECRET
# 或設定環境變數 MAT_PORT、MAT_HOST、MAT_DATA_DIR、MAT_TOKEN
```

打開介面，在「專案」（Projects）新增工作區（絕對路徑），回到「啟動」（Launch），挑一個內建工作流程（規劃模式、建置模式、審查模式或 Pipeline 流程），寫下任務後按「開始執行」（Start）。只有要改階段或 agent 設定時，才需要打開「進階設定」（Customize）。

頂端的「語言・主題」（Language · Theme）可以覆蓋系統語言，或選三種主題之一；兩個選擇在重新啟動後都會保留。

開發模式：`npm run dev`（Vite 與 API 熱重載）。測試：`npm test`。型別檢查：`npm run typecheck`。版本一致性檢查：`npm run verify:version`。建置後伺服器的證據測試：先 `npm run build`，再 `npm run evidence`。

## 桌面版

從 [GitHub Releases](https://github.com/teddashh/multi-ai-terminal/releases) 下載安裝檔。桌面版需要 `PATH` 上有 Node.js 20 以上；必要時可以用 `MAT_NODE` 指定某個相容的 Node.js 執行檔。安裝檔沒有程式碼簽章，也沒有經過 Apple 公證。

- **Windows**：下載 `Multi-AI.Terminal_<版本>_x64-setup.exe`（NSIS）或 `.msi` 並執行。因為安裝檔沒有簽章，SmartScreen 可能會先要求你確認。Windows 10 與 11 已內建 WebView2 執行環境，缺少時安裝程式會自動補裝。用 `winget install OpenJS.NodeJS.LTS` 安裝 Node.js 20 以上；worktree 隔離功能還需要 Git for Windows。必要時用 `MAT_NODE` 指定特定的 `node.exe`。
- **Debian 與 Ubuntu**：下載 `.deb`，執行 `sudo apt install ./Multi-AI.Terminal_<版本>_amd64.deb`。
- **其他 Linux 發行版**：下載 `.AppImage`，執行 `chmod +x ./Multi-AI.Terminal_*_amd64.AppImage` 後直接開啟。另外也有 `.rpm` 套件。
- **macOS**：依機型下載 `.dmg`（Apple silicon 選 `aarch64`，Intel 選 `x64`），打開後把 app 拖進「應用程式」。第一次開啟時，對 Multi-AI Terminal 按右鍵並選「打開」；macOS 15 以後的版本，請先試著開啟一次，再到「系統設定」的「隱私權與安全性」按「強制打開」（Open Anyway）。

桌面外殼跑的是同一個打包好的伺服器，只是改用隨機的 `127.0.0.1` 連接埠，資料一樣放在 `~/.multi-ai-terminal/`，和網頁版相同。要在本機建置桌面資源，先 `npm run build` 再 `npm run desktop:bundle`；`npm run desktop:build` 另外需要 Rust 與 Tauri 的原生建置環境。

新增工作區時，桌面版提供原生的「瀏覽…」（Browse…）資料夾選擇器；純瀏覽器模式則手動輸入絕對路徑，也不會載入桌面版的對話框整合。

## 讓 agent 啟動（agent-ready 原始碼發行）

這個 repo 可以交給 Claude Code、Codex 這類 coding agent 操作。[`agent-release.json`](agent-release.json) 是機器可讀的契約（依 [`agent-release.schema.json`](agent-release.schema.json) 驗證），宣告 source-web 通道的進入點、權限、副作用、runtime 狀態與結束碼；對應的 skill 放在 repo 裡的 `.claude/skills/launch-multi-ai-terminal/` 與 `.agents/skills/launch-multi-ai-terminal/`。這些 skill 只能明確呼叫：只有你開口要求時，agent 才能使用，不會自動觸發。

```sh
npm run agent:doctor -- --json           # 檢查前置需求（Node 20+、npm），不會代為安裝任何東西
npm run agent:launch -- --wait --json    # 需要時先 npm ci，建置後在空閒的 127.0.0.1 連接埠啟動
npm run agent:status -- --json           # 狀態與 URL；出現「[MAT_AGENT] READY url=...」才算就緒
npm run agent:stop -- --json             # 只停止身分驗證過的 launcher 程序樹
npm run agent:audit -- --json            # 比對宣告的權限／副作用與實際觀察到的產物
```

這個通道只走 source-web：不用 Rust toolchain、不產生安裝檔、不下載 release 資產。生命週期紀錄放在已列入 gitignore 的 `.agent-runtime/`。生命週期腳本不會讀取 provider 憑證，skill 也禁止代替你操作已啟動伺服器的 provider 安裝、更新或登入 API。已安裝的桌面版開著時，請不要同時跑這個通道：兩者共用同一個資料目錄（`MAT_DATA_DIR` 或 `~/.multi-ai-terminal/`），兩個伺服器同時寫入會互相搶寫。

## Provider 設定

桌面版第一次啟動時，會在背景補齊缺少且有支援的 Claude 與 Codex 代管 runtime，也包含 OpenRouter 共用的 Codex runtime。這些檔案都鎖定在 MAT catalog 指定的版本、先驗證完整性，而且只寫入 `<dataDir>/runtimes/`；不會在全域安裝 `@latest`，也不會修改主機的 `PATH`。無法使用的 provider 仍會顯示「設定」（Setup），作為修復入口；沒有代管檔案的 provider，則改用該 provider 專屬的固定安裝步驟。這些步驟不接受任何指令輸入；各 provider 的授權與登入仍各自獨立。

自動補齊與「設定」都會在安裝完成後重新偵測 runtime 與 provider；「設定」還會顯示已經過的時間，並保留完成與是否需要重新啟動的提示。「重新偵測」（Retry detection）只清除 MAT 本機的 PATH 與版本快取，不會重新安裝。Windows 的版本檢查給冷啟動的 CLI shim 15 秒；暫時性的失敗只快取 2 秒，成功的版本則快取 10 分鐘。

MAT 會把存在的常見 CLI 位置補在子程序 `PATH` 的後面：Windows 是 `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`、`%LOCALAPPDATA%\Antigravity`、`%APPDATA%\npm` 與 `%USERPROFILE%\.local\bin`；其他平台是 `~/.local/bin`、`/usr/local/bin` 與 `/opt/homebrew/bin`。目錄不存在就不加。這讓桌面版伺服器找得到常見的使用者層級安裝，又不會把環境變數的值帶進診斷紀錄。

## Provider 登入與平行 session

Codex 有些登入失敗，是多個 CLI session 同時輪替只能用一次的 OAuth refresh token 所造成。MAT 讓同一家真實 provider 的啟動至少間隔 1.5 秒（協調者也算在內）來降低競爭，但沒辦法讓上游的 token 輪替變成原子操作。相關的上游 issue：[openai/codex#9634](https://github.com/openai/codex/issues/9634)、[openai/codex#15502](https://github.com/openai/codex/issues/15502)。

長久的解法是改用 API key 驗證，或依序使用同一家 provider。Codex 支援 API key 登入，Claude Code 會讀取 `ANTHROPIC_API_KEY`。如果 OAuth refresh token 已經被撤銷，先用該 CLI 登出再登入；Codex 是 `codex logout && codex login`。

真實 provider 出現可以辨識的登入錯誤時，節點卡會顯示多行琥珀色的提示與確認過的指令，provider 標籤會多一個 `auth` 標記，「設定」也會提供可以複製的「登入」（Sign in）區塊。之後再用這家 provider 執行時，編輯區會先提醒但不阻擋；之後任何一個節點成功，就會清除這個提醒。

OpenRouter 只用環境變數驗證：啟動 MAT 前先設定 `OPENROUTER_API_KEY`，改了之後要重新啟動 MAT。MAT 只回報這個變數有沒有設定，絕不顯示或保存它的值。

## Provider 與 runtime 路徑

| Provider | Runtime／傳輸方式 | 串流 | 備註 |
|---|---|---|---|
| claude | Agent SDK 驅動解析出的 `claude` runtime | 完整（文字、思考、工具、用量） | 持續的 session runtime；仍保留可以明確選用的舊版 CLI 模式 |
| codex | 常駐的 `codex app-server` JSON-RPC／JSONL controller | 完整（思考、工具、用量） | 由一個共用的 controller 管理可以接續的 thread |
| grok | `grok --prompt-file F --output-format streaming-json`，前面有一個 FIFO manager | 只有思考與文字（工具在背景執行） | grok 0.2.93 以上：用 `--prompt-file` 時不要再加 `-p` |
| agy | `agy -p "PROMPT" --model "Gemini 3.1 Pro (High)" --print-timeout 45m`，前面有一個 FIFO manager | 純文字 | 模型用顯示名稱；沒有 JSON 模式，也無法接續 session |
| openrouter | 沒有 OpenRouter CLI；使用設定獨立的常駐 Codex app-server | 所選模型支援時為完整串流 | 需要 `OPENROUTER_API_KEY`；先選模型再選版本，送出精確的版本 slug |
| mock | 在程序內執行 | 照腳本 | 結果固定；測試用的 `MOCK_REPLY:` 回聲模式 |

每個槽位的權限層級：`safe`（唯讀）、`auto`（自動接受編輯）、`full`（略過沙箱），對應各 runtime 原生的權限政策（SPEC §4.6）。

## 信任模型

預設綁定 `127.0.0.1`。`--host 0.0.0.0` 會把 API 與介面開放到你的網路，這時請一併設定 `--token`（REST 用 bearer token，WebSocket 用 query token）。MAT 不會強制非 loopback 位址一定要設 token，這要由你決定。能連到這個連接埠的人，就能在你的工作區執行任意 CLI agent，請比照看待（建議只透過 Tailscale 開放）。

## 資料

`~/.multi-ai-terminal/`（可用 `--data-dir` 或 `MAT_DATA_DIR` 改位置）：`workspaces.json`、`workflows/*.json`、`runs/<runId>/run.json`、`events.jsonl`、`raw/*.jsonl`（每次嘗試的 CLI 輸出，已先移除環境變數的值）、`artifacts/*.patch` 與 `artifacts/*.verify.log`。保留規則：每個工作區保留最近 100 次執行，刪除時一併清掉對應的 worktree 與分支。

## 文件

- [SPEC.md](SPEC.md)：工程規格（v1.5，含 BAT runtime 對齊）
- [docs/project-audit-2026-07-20.md](docs/project-audit-2026-07-20.md)：強化工作紀錄，以及依序排列的後續待辦
- [docs/spec-review-panel.md](docs/spec-review-panel.md)：4 個模型的規格審查紀錄
- [docs/code-review-panel.md](docs/code-review-panel.md)：4 個模型的程式碼審查紀錄（25 項已修正、3 項駁回）

開發流程採 4 模型評審：規格與程式碼由 Claude Fable 5、Codex GPT-5.6-sol、Gemini 3.1 Pro 與 Grok 4.5 審查；實作由多個平行的 Codex worker 在各自隔離的 git worktree 完成。

## 致謝

- [Better Agent Terminal](https://github.com/tony1223/better-agent-terminal) 是 provider runtime 處理方式的架構參考：常駐的 `codex app-server` controller 與 Claude Agent SDK session。MAT 不是 fork，而是把這套做法移植到純 Node 的伺服器，也套用到 grok 與 agy。
- [TempoTerm](https://github.com/mukiwu/tempo-term) 是介面參考：以專案為主的導覽，以及一眼就看得懂的狀態。

## 授權

MIT © 2026 Ted Huang，見 [LICENSE](LICENSE)。`web/src/assets/themes/ai-sister/` 裡的五張 AI-Sister 角色圖不適用 MIT 授權，請見該目錄的 [NOTICE.md](web/src/assets/themes/ai-sister/NOTICE.md)。

## 已知限制

- Grok 的串流 JSON 沒有工具事件，所以 grok 節點只顯示思考與文字，摘要裡的工具數會顯示「n/a」。
- Antigravity（`agy`）沒有 headless JSON 模式：串流是純文字，也無法接續 session（協調者每次把關都要重新交代背景）。
- 桌面版沒有程式碼簽章，也沒有經過 Apple 公證，而且 `PATH` 上仍需要 Node.js 20 以上（或設定 `MAT_NODE`）。
- CI 與證據測試用的是 mock provider；實際登入 Codex、Claude 或 OpenRouter 帳號的執行不在 CI 範圍內。
- 機器重開後，崩潰復原會依保存的 PID 結束殘留的程序群組，並接受 PID 被重複使用的風險。
- 瀏覽器記憶體裡的事件環最多保留 20,000 筆；更早的紀錄會從伺服器分頁載入，並明確標示有截斷。
- Windows 上結束程序用的是 `taskkill /T /F`（強制結束整個程序樹）；如果 node 先自行結束，已脫離的孫程序會在下次伺服器啟動時，由殘留 PID 的清理流程回收。
