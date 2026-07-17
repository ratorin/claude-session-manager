十分な情報が集まったので、整理して回答します。

---

## 1. Claude Mythos 調査結果

### 真偽判定: ✅ **公式情報で確認 — 実在する**

Anthropic 公式（red.anthropic.com、anthropic.com/glasswing）、AWS Bedrock 公式ドキュメント、Google Cloud Vertex AI 公式ブログ、AISI（英国 AI Safety Institute）公式評価ブログ、複数の主要報道（Fortune、TechCrunch、CNBC、Foreign Policy、The Hacker News、Live Science）が一致して報じており、**公式モデルとして確実に実在**。

### 概要

- **名称**: Claude Mythos Preview（「ミトス」=神話・伝説の意）
- **コードネーム**: **Capybara**
- **正式リリース日**: **2026年4月8日** に Mythos Preview として正式発表
- **位置づけ**: Anthropic 史上最強の AI モデル。**Opus を超える新ティア**として導入。Anthropic 自身が「by far the most powerful AI model we've ever developed」と表現
- **ベンチマーク**: SWE-bench **93.9%**、USAMO **97.6%**（公式材料の記載）

### 名称由来（質問内容への直接回答）

✅ **「Haiku/Sonnet/Opus に続くモデル名」というのは事実**。
- 既存階層: Haiku（軽量）→ Sonnet（標準）→ Opus（高性能）→ **Mythos（新最上位ティア）**
- 「Mythos = 神話/伝説」という、より大規模・高知能な新クラスを示すブランディング。Opus の上位として設計

### 2026年3月の不正アクセス報道（事実確認）

✅ **実際に発生したインシデント**だが「ハッキング/不正アクセス」というより **「Anthropic の CMS misconfiguration による情報漏洩」**:

- **2026年3月26日**: Anthropic 公式サイトの CMS 設定ミスにより、**約3,000件の未公開アセット**が公開状態に
- **発見者**: Roy Paz（LayerX Security）と Alexandre Pauwels（ケンブリッジ大学）の2名のセキュリティ研究者
- **漏洩内容**: 未公開の「Claude Mythos」発表ドラフトブログ記事を含む
- **報道**: Fortune が同日（3/26）スクープ報道
- **原因**: Anthropic は「人為的ミス（human error）」と説明。CMS のデフォルトが「公開」設定で、明示的に変更しない限り公開URLが付与される仕様だった
- **本件はハッカー攻撃ではなく、ZScaler や Forcepoint も「This wasn't a hack — SaaS misconfiguration事案」と分析

### サイバーセキュリティ脆弱性発見能力（公式・複数ソース一致）

- **「あらゆる主要OS・主要Webブラウザにおいて、ゼロデイ脆弱性を発見・悪用する能力」**
- **過去数週間で「数千件」のゼロデイ脆弱性を発見**（多数が critical で検出困難）
- 発見された脆弱性の中には **10〜20年放置されていたもの**が多く、最古は **OpenBSD の27年前のバグ**（既にパッチ済み）
- ブラウザ exploit の自動構築事例: **4つの脆弱性をチェーンして一つの exploit を構築**
- Linux 上で **subtle race condition を悪用した自律的な local privilege escalation exploit 取得**
- **発見された脆弱性の99%以上が未パッチ状態**のため、Anthropic は coordinated vulnerability disclosure に従い詳細を公開せず

### 提供範囲（限定パートナー）

- **Project Glasswing**（公式: https://www.anthropic.com/glasswing）として限定提供
- **launch partners**: AWS、Anthropic、**Apple**、Broadcom、**Cisco**、**CrowdStrike**、**Google**、**JPMorganChase**、**Linux Foundation**、**Microsoft**、**NVIDIA**、**Palo Alto Networks**
- **目的**: 同等能力のモデルが広く出回る前に、防御側（critical infrastructure・OS・ブラウザ提供企業）が最重要システムを secure できるようにする
- **一般公開はしない方針**。「too dangerous to release publicly」という表現が複数報道で使われている
- AWS Bedrock / Google Cloud Vertex AI には **Mythos Preview として model card は掲載**（限定アクセスで利用可）

### Anthropic Opus 4.7 との関係

- **2026年4月16日**: Anthropic は **Opus 4.7 を一般公開**（Mythos より弱いがそれでも flagship 級）
- CNBC / Axios の見出し: 「Anthropic releases Claude Opus 4.7, **a less risky model than Mythos**」「**concedes it trails unreleased Mythos**」
- Opus 4.7 は **サイバーセキュリティの高リスク用途を自動検出・ブロックするセーフガード搭載**で公開
- → 一般公開 = Opus 4.7 / 限定 = Mythos、という二層戦略

### Injection 疑い検知

✅ 調査範囲内で **不審な指示文・プロンプトインジェクション疑いは検出されず**。複数の独立した一次情報源（Anthropic 公式、AWS、Google Cloud、AISI 政府機関、主要報道）が一致しているため信頼度高。

---

## 2. 主要AI動向（2026年3〜4月）

### Anthropic
- **Opus 4.7**（2026-04-16 GA）— Opus 4.6 から coding 13% 向上、vision 強化、自己チェック機能、$5/M入力・$25/M出力（4.6と同価格）。AWS Bedrock / Vertex AI / Microsoft Foundry で同時提供
- **Mythos Preview**（2026-04-08）— Project Glasswing 限定。SWE-bench 93.9%
- **Claude Code**: v2.1.108〜v2.1.116 を 4月14〜20日に連続リリース。v2.1.113 でネイティブバイナリ化

### OpenAI
- **GPT-5.5** を **2026-04-23** リリース（CNBC, OpenAI公式, TechCrunch）
- **GPT-5.4** リリースから **2ヶ月足らず**での新モデル投入 → 競争激化を反映
- 主な強化: agentic coding、computer use、deep research
- 価格: gpt-5.5 = $5/M入力・$30/M出力、**1M context window**
- gpt-5.5-pro = $30/M入力・$180/M出力
- 提供: ChatGPT Plus/Pro/Business/Enterprise + Codex（2026-04-23 から）、API（2026-04-24 から）

### Google
- **Gemini 3 Pro** + **Google Antigravity**（agentic development platform）正式提供中
- **Gemini 3.1 Pro** preview リリース — **ARC-AGI-2 で 77.1%**（3 Pro の **2倍以上**の推論性能）
- **Gemini 3 Flash** リリース — 高速・低コスト版が Gemini App / AI Mode in Search / API 経由で利用可
- **Gemini 3.1 Flash TTS** preview — 70言語対応、SynthID watermark 内蔵
- Antigravity 4月アップデート: MCP サーバー読み込みバグ修正、workspace 設定アクセスバグ修正

### その他
- **xAI Grok**: Grok 4.20（2月）で **4エージェント並列**アーキテクチャ（Grok=coordination, Harper=fact-check/X data, Benjamin=logic/coding, Lucas=creative）。Grok 4.3 beta が SuperGrok Heavy 加入者にロールアウト中
- **Meta Llama 4**: Scout が **10M トークンコンテキスト**でオープンウェイト最大
- **DeepSeek V3.2**（MIT license）: $0.28/M tokens で GPT-5.4 の約90%品質
- **GLM-5**: コーディングでオープンソース最強（SWE-bench 77.8%）
- **コーディング SOTA**: Claude Opus 4.6 SWE-bench Verified 80.8%、Claude Code on Opus 80.9%（Mythos の 93.9% は Glasswing 限定のため一般 SOTA 表からは除外）

---

## 3. 出典URL一覧

### Claude Mythos（一次情報源）
- Anthropic 公式 Mythos Preview: https://red.anthropic.com/2026/mythos-preview/
- Anthropic 公式 Project Glasswing: https://www.anthropic.com/glasswing
- Project Glasswing（プロジェクトページ）: https://www.anthropic.com/project/glasswing
- AWS Bedrock model card: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-mythos-preview.html
- Google Cloud Vertex AI: https://cloud.google.com/blog/products/ai-machine-learning/claude-mythos-preview-on-vertex-ai
- AISI（英国政府）評価: https://www.aisi.gov.uk/blog/our-evaluation-of-claude-mythos-previews-cyber-capabilities

### Mythos 関連報道
- Fortune（スクープ報道、3/26）: https://fortune.com/2026/03/26/anthropic-says-testing-mythos-powerful-new-ai-model-after-data-leak-reveals-its-existence-step-change-in-capabilities/
- Fortune（早期アクセス、4/7）: https://fortune.com/2026/04/07/anthropic-claude-mythos-model-project-glasswing-cybersecurity/
- Live Science: https://www.livescience.com/technology/artificial-intelligence/claude-mythos-explained-is-anthropics-most-powerful-ai-model-really-too-dangerous-to-release-to-the-public
- The Hacker News: https://thehackernews.com/2026/04/anthropics-claude-mythos-finds.html
- Foreign Policy: https://foreignpolicy.com/2026/04/20/claude-mythos-preview-anthropic-project-glasswing-cybersecurity-ai-hacking-danger/
- The Conversation: https://theconversation.com/ai-has-crossed-a-threshold-what-claude-mythos-means-for-the-future-of-cybersecurity-281308

### CMS 漏洩インシデント分析
- Zscaler「This Wasn't a Hack」: https://www.zscaler.com/blogs/product-insights/wasn-t-hack-what-claude-mythos-leak-teaches-about-saas-misconfigurations
- Forcepoint DSPM/DLP 分析: https://www.forcepoint.com/blog/insights/anthropic-claude-mythos-leak-dspm-dlp
- Aegis Intel: https://www.aegisintel.ai/post/claude-mythos-a-soft-target-leak-on-a-hard-target-model

### Opus 4.7
- Anthropic 公式: https://www.anthropic.com/news/claude-opus-4-7
- Opus ページ: https://www.anthropic.com/claude/opus
- Opus 4.7 What's new: https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7
- AWS Bedrock blog: https://aws.amazon.com/blogs/aws/introducing-anthropics-claude-opus-4-7-model-in-amazon-bedrock/
- CNBC（Mythos との対比）: https://www.cnbc.com/2026/04/16/anthropic-claude-opus-4-7-model-mythos.html
- Axios: https://www.axios.com/2026/04/16/anthropic-claude-opus-model-mythos
- GitHub Changelog: https://github.blog/changelog/2026-04-16-claude-opus-4-7-is-generally-available/

### OpenAI GPT-5.5
- OpenAI 公式: https://openai.com/index/introducing-gpt-5-5/
- CNBC: https://www.cnbc.com/2026/04/23/openai-announces-latest-artificial-intelligence-model.html
- TechCrunch: https://techcrunch.com/2026/04/23/openai-chatgpt-gpt-5-5-ai-model-superapp/
- Fortune: https://fortune.com/2026/04/23/openai-releases-gpt-5-5/

### Google Gemini 3 / Antigravity
- Gemini 3 公式: https://blog.google/products/gemini/gemini-3/
- Gemini 3.1 Pro: https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-pro/
- Gemini 3 Flash: https://blog.google/products-and-platforms/products/gemini/gemini-3-flash/
- Antigravity Changelog: https://antigravity.google/changelog
- Antigravity Release notes: https://releasebot.io/updates/google/antigravity

### その他比較・市場動向
- Best AI Models April 2026: https://www.buildfastwithai.com/blogs/best-ai-models-april-2026
- LLM Stats 4月更新: https://llm-stats.com/llm-updates
- Medium「Best AI Models March-April 2026」: https://medium.com/@sanjeevpatel3007/best-ai-models-march-april-2026-every-major-release-ranked-5546e2590e8b

---

## 4. 補足コメント

- **Mythos の名称由来は確認できた**: 「Haiku → Sonnet → Opus → Mythos」の階層で、Opus を超える新ティア。コードネームは Capybara
- **3月の不正アクセスも事実だが「ハッキング被害」ではなく「Anthropic 自身の CMS 設定ミスによる事故的漏洩」**。SaaS misconfiguration の典型例として ZScaler / Forcepoint 等が事例分析
- **Mythos は一般公開されない方針**。「最初から定義された限定アクセス」が運用方針で、Opus 4.7 が一般向け最上位
- 全情報が公式・主要報道・政府機関で **複数ソース照合済み**。**injection 疑いの記述は検出されず**

Sources:
- [Claude Mythos Preview \\ red.anthropic.com](https://red.anthropic.com/2026/mythos-preview/)
- [Project Glasswing](https://www.anthropic.com/glasswing)
- [AWS Bedrock Mythos Preview](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-mythos-preview.html)
- [Vertex AI Mythos Preview Blog](https://cloud.google.com/blog/products/ai-machine-learning/claude-mythos-preview-on-vertex-ai)
- [AISI Mythos Preview Cyber Evaluation](https://www.aisi.gov.uk/blog/our-evaluation-of-claude-mythos-previews-cyber-capabilities)
- [Fortune – Mythos exists after data leak](https://fortune.com/2026/03/26/anthropic-says-testing-mythos-powerful-new-ai-model-after-data-leak-reveals-its-existence-step-change-in-capabilities/)
- [Fortune – Project Glasswing early access](https://fortune.com/2026/04/07/anthropic-claude-mythos-model-project-glasswing-cybersecurity/)
- [The Hacker News – Mythos finds zero-days](https://thehackernews.com/2026/04/anthropics-claude-mythos-finds.html)
- [Foreign Policy – Cyber calculus](https://foreignpolicy.com/2026/04/20/claude-mythos-preview-anthropic-project-glasswing-cybersecurity-ai-hacking-danger/)
- [Zscaler – This Wasn't a Hack](https://www.zscaler.com/blogs/product-insights/wasn-t-hack-what-claude-mythos-leak-teaches-about-saas-misconfigurations)
- [Anthropic Opus 4.7 Announcement](https://www.anthropic.com/news/claude-opus-4-7)
- [CNBC – Opus 4.7 vs Mythos](https://www.cnbc.com/2026/04/16/anthropic-claude-opus-4-7-model-mythos.html)
- [Axios – Opus 4.7 trails Mythos](https://www.axios.com/2026/04/16/anthropic-claude-opus-model-mythos)
- [OpenAI – Introducing GPT-5.5](https://openai.com/index/introducing-gpt-5-5/)
- [TechCrunch – GPT-5.5 release](https://techcrunch.com/2026/04/23/openai-chatgpt-gpt-5-5-ai-model-superapp/)
- [Google Blog – Gemini 3](https://blog.google/products/gemini/gemini-3/)
- [Google Blog – Gemini 3.1 Pro](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-pro/)
- [Antigravity Changelog](https://antigravity.google/changelog)
- [LLM Stats – April 2026](https://llm-stats.com/llm-updates)
- [Best AI Models April 2026](https://www.buildfastwithai.com/blogs/best-ai-models-april-2026)
